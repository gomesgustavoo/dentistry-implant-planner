"""Jobs: submit one, list your own, inspect, cancel, delete.

Every route here is tenant-scoped. The list query gained a `WHERE tenant_id`; the
single-job routes go through `deps.load_owned`, which 404s another tenant's id.
"""

from __future__ import annotations

import logging
import shutil
import uuid
from pathlib import Path

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from fastapi.responses import JSONResponse
from sqlalchemy.orm import Session

from api.deps import Caller, current_caller, get_session, load_owned
from dentistry import db, quota, storage
from dentistry.config import settings

log = logging.getLogger("dentistry.api.jobs")

router = APIRouter(prefix="/v1/jobs", tags=["jobs"])

# Must stay in step with worker/ingest.VOLUME_SUFFIXES. Duplicated rather than
# imported because the API image deliberately cannot import anything from worker/
# (that package pulls torch).
ALLOWED_SUFFIXES = (".nii", ".nii.gz", ".nrrd", ".nhdr", ".mha", ".mhd",
                    ".gipl", ".gipl.gz", ".hdr", ".img", ".img.gz", ".zip")
CHUNK = 4 * 1024 * 1024


def job_dict(j: db.Job) -> dict:
    return {
        "id": j.id,
        "state": j.state,
        "stage": j.stage,
        "progress": round(j.progress, 3),
        "filename": j.filename,
        "input_kind": j.input_kind,
        "is_example": bool(j.is_example),
        "results_expired": bool(j.results_expired),
        "title": j.title,
        "attribution": j.attribution,
        "bytes_in": j.bytes_in,
        "created_at": j.created_at,
        "started_at": j.started_at,
        "finished_at": j.finished_at,
        "gpu_seconds": j.gpu_seconds,
        "wait_seconds": j.wait_seconds,
        "attempts": j.attempts,
        "error": j.error,
        "submitted_by": j.submitted_by_user_id,
    }


@router.post("", status_code=201)
async def create_job(
    file: UploadFile = File(...),
    s: Session = Depends(get_session),
    caller: Caller = Depends(current_caller),
) -> dict:
    name = Path(file.filename or "upload").name
    low = name.lower()
    if not low.endswith(ALLOWED_SUFFIXES):
        raise HTTPException(
            400,
            "Upload a volume (" + ", ".join(ALLOWED_SUFFIXES[:-1])
            + ") or a DICOM series as .zip — got " + repr(name),
        )

    # Check the quota BEFORE writing 300 MB to disk. The lock is taken here and held
    # through the ledger insert below, so two simultaneous uploads cannot both pass
    # a check that only one should.
    state = quota.load_state(s, caller.tenant_id, lock=True)
    quota.check(state)

    job_id = str(uuid.uuid4())
    dest_dir = storage.job_dir(caller.tenant_id, "uploads", job_id)
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = dest_dir / name

    written = 0
    limit = settings.UPLOAD_MAX_MB * 1024 * 1024
    try:
        with open(dest, "wb") as out:
            while chunk := await file.read(CHUNK):
                written += len(chunk)
                if written > limit:
                    raise HTTPException(413, f"Upload exceeds {settings.UPLOAD_MAX_MB} MB")
                out.write(chunk)
    except HTTPException:
        shutil.rmtree(dest_dir, ignore_errors=True)
        s.rollback()
        raise
    if written == 0:
        shutil.rmtree(dest_dir, ignore_errors=True)
        s.rollback()
        raise HTTPException(400, "Empty upload")

    job = db.Job(
        id=job_id,
        tenant_id=caller.tenant_id,
        # WHO, as distinct from which workspace. `tenant_id` is still the whole of
        # the authorisation boundary -- this is for the "uploaded by" line on a
        # shared workspace's case list, nothing more. Empty for the `legacy`
        # attribution, which has no user row.
        submitted_by_user_id=caller.user_id or None,
        filename=name,
        input_kind="zip" if low.endswith(".zip") else "volume",
        bytes_in=written,
        state=db.QUEUED,
        stage="queued",
    )
    s.add(job)
    quota.record(s, caller.tenant_id, job_id)
    # Commit BEFORE returning. FastAPI's dependency teardown runs after the
    # response is sent, so a commit there would let a client poll for a job the
    # worker cannot see yet — a race VoxTell hit for real and reproduced 3/3.
    s.commit()
    log.info("job %s queued for tenant %s (%s, %.1f MB)",
             job_id[:8], caller.tenant_id[:8], name, written / 1e6)
    return job_dict(job)


@router.get("")
def list_jobs(
    limit: int = 50,
    s: Session = Depends(get_session),
    caller: Caller = Depends(current_caller),
) -> dict:
    limit = max(1, min(limit, 200))
    scoped = s.query(db.Job).filter(db.Job.tenant_id == caller.tenant_id)
    rows = scoped.order_by(db.Job.created_at.desc()).limit(limit).all()
    return {"total": scoped.count(), "jobs": [job_dict(j) for j in rows]}


@router.get("/{job_id}")
def get_job(
    job_id: str,
    s: Session = Depends(get_session),
    caller: Caller = Depends(current_caller),
) -> dict:
    j = load_owned(job_id, s, caller)
    out = job_dict(j)
    out["reports"] = j.reports
    return out


@router.post("/{job_id}/cancel")
def cancel_job(
    job_id: str,
    s: Session = Depends(get_session),
    caller: Caller = Depends(current_caller),
) -> dict:
    # Row-lock so the flag cannot be set in the gap between the worker reading
    # state and writing 'running' -- the claim/cancel race VoxTell hit, where a
    # cancelled job still ran and then failed on a missing input.
    j = load_owned(job_id, s, caller, lock=True)
    if j.state in db.TERMINAL:
        s.commit()
        return {"id": j.id, "state": j.state, "cancelled": False, "reason": "already finished"}
    j.cancel_requested = 1
    if j.state == db.QUEUED:
        j.state, j.stage = db.CANCELLED, "cancelled"
        # Never reached the GPU, so it costs nothing. A cancelled-while-queued job
        # that still burned a monthly segmentation would be indefensible.
        quota.refund(s, j.tenant_id, j.id)
    s.commit()
    return {"id": j.id, "state": j.state, "cancelled": True}


@router.delete("/{job_id}", status_code=204)
def delete_job(
    job_id: str,
    s: Session = Depends(get_session),
    caller: Caller = Depends(current_caller),
):
    j = load_owned(job_id, s, caller, lock=True)
    if j.is_example:
        raise HTTPException(403, "Example cases are not deletable")
    if j.state == db.RUNNING:
        raise HTTPException(409, "Cancel the job before deleting it")
    for kind in storage.KINDS:
        shutil.rmtree(storage.resolve(j.tenant_id, kind, job_id), ignore_errors=True)
    s.delete(j)
    # The usage_events row deliberately SURVIVES. Otherwise submit / download /
    # delete / repeat is unlimited free segmentation, which is why that table has
    # no foreign key to cascade from.
    s.commit()
    return JSONResponse(status_code=204, content=None)
