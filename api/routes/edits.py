"""Hand corrections to a case's segmentation mask, and the re-derive they trigger.

**The endpoint accepts a DIFF, not a mask.** The browser edits the display volume -- an
8-bit copy downsampled so its longest axis is at most 256 -- and sends back the runs of
voxels that changed, on that grid, with the grid attached. Two reasons it is a diff:
a whole labelmap is 5.7 MB per submission and would have to be trusted wholesale, while
a diff is a few hundred kilobytes and can be checked run by run against the dimensions
this case actually shipped.

**Nothing is applied here.** The API pod has no numpy, no scipy and no SimpleITK, so it
could not upsample the diff, rebuild a distance field or re-mesh a structure if it
wanted to. It validates, stores the diff beside the results it describes, and queues it;
`worker/rederive.py` does the work and `worker/jobs.py` owns the queue.

**Examples are refused.** `deps.load_owned` hands any published example to any
signed-in caller -- correctly, they are the demo -- so an edit endpoint that used it
alone would let one account rewrite the segmentation everyone else is shown. This
requires the caller's own tenant to own the case, and says so.
"""

from __future__ import annotations

import json
import logging
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from api.deps import Caller, current_caller, get_session, load_owned
from dentistry import db, storage

log = logging.getLogger("dentistry.api.edits")

router = APIRouter(prefix="/v1/jobs", tags=["edits"])

#: How much of the display volume one submission may rewrite. 2 million voxels is about
#: a third of a 205 x 205 x 135 volume; a correction is a contour, and anything that
#: rewrites a third of the head is not a correction but a different segmentation.
MAX_EDIT_VOXELS = 2_000_000
#: Belt and braces on the payload itself, ahead of the per-run checks.
MAX_RUNS = 4_000_000


class EditGrid(BaseModel):
    dimensions: list[int] = Field(min_length=3, max_length=3)
    spacing: list[float] = Field(min_length=3, max_length=3)
    downsample_factor: int = Field(ge=1, le=8)
    origin: list[float] = Field(default_factory=list)
    direction: list[float] = Field(default_factory=list)


class EditSlice(BaseModel):
    k: int = Field(ge=0)
    #: `[offset, length, value]` per run. A tuple rather than an object: a 2 mm brush on
    #: a 0.6 mm grid is seven voxels across, so the runs outnumber everything else in
    #: the payload and three numbers beat three keys by a factor of five on the wire.
    runs: list[list[int]]


class EditIn(BaseModel):
    grid: EditGrid
    slices: list[EditSlice] = Field(default_factory=list)
    voxels: int = Field(ge=0, default=0)
    structures: dict[str, dict] = Field(default_factory=dict)
    note: str | None = Field(default=None, max_length=500)


def _edit_out(e: db.CaseEdit) -> dict:
    return {
        "id": e.id,
        "job_id": e.job_id,
        "state": e.state,
        "note": e.note,
        "voxels": e.voxels,
        "structures": e.structures or {},
        "grid": e.grid or {},
        "result": e.result or None,
        "created_at": e.created_at,
        "applied_at": e.applied_at,
        "error": e.error,
        "created_by": e.created_by_user_id,
    }


def _owned_for_edit(job_id: str, s: Session, caller: Caller) -> db.Job:
    """A case the caller may CHANGE, which is a stricter test than one they may read."""
    job = load_owned(job_id, s, caller)
    if job.is_example:
        raise HTTPException(
            403, "Example cases are published and shared, so their segmentation cannot "
                 "be edited. Upload your own scan to correct its contours.")
    if str(job.tenant_id) != str(caller.tenant_id):
        raise HTTPException(404, "No such job")
    if job.state != db.DONE:
        raise HTTPException(409, f"Job is {job.state}, not done")
    if job.results_expired:
        raise HTTPException(
            410, "This case's results expired and were deleted, so there is no "
                 "segmentation left to correct. Re-upload the scan to segment it again.")
    return job


@router.get("/{job_id}/edits")
def list_edits(job_id: str, s: Session = Depends(get_session),
               caller: Caller = Depends(current_caller)):
    job = load_owned(job_id, s, caller)
    rows = (s.query(db.CaseEdit)
            .filter(db.CaseEdit.job_id == job.id,
                    db.CaseEdit.tenant_id == caller.tenant_id)
            .order_by(db.CaseEdit.created_at.desc()).all())
    return {"edits": [_edit_out(e) for e in rows]}


@router.post("/{job_id}/edits", status_code=202)
def create_edit(job_id: str, body: EditIn, s: Session = Depends(get_session),
                caller: Caller = Depends(current_caller)):
    """Accept a correction and queue the re-derive. 202: the numbers are not new yet.

    Every check here runs BEFORE the diff is written, and every one of them is a
    sentence the person who made the edit can act on. The grid test is the important
    one: a diff made against a different display volume would be applied at the wrong
    scale and every voxel would land somewhere plausible and wrong.
    """
    job = _owned_for_edit(job_id, s, caller)
    root = storage.resolve(job.tenant_id, "results", job.id).resolve()

    meta_path = root / "volume" / "meta.json"
    if not meta_path.is_file():
        raise HTTPException(
            409, "This case has no display volume, so a correction made in the browser "
                 "cannot be placed on its grid. Every job processed before the volume "
                 "pack existed has none.")
    meta = json.loads(meta_path.read_text())
    want = [int(x) for x in meta["dimensions"]]
    got = [int(x) for x in body.grid.dimensions]
    if got != want:
        raise HTTPException(
            409, f"This correction was made on a {got} display volume and the case "
                 f"ships {want}. Reload the case and make it again.")
    if int(body.grid.downsample_factor) != int(meta.get("downsample_factor") or 1):
        raise HTTPException(
            409, f"This correction declares a downsample factor of "
                 f"{body.grid.downsample_factor} and this case's display volume was "
                 f"built at {meta.get('downsample_factor')}.")

    # The runs, checked against the grid rather than trusted. A run that overhangs its
    # plane would be applied modulo the plane size by any indexing scheme and would
    # paint a stripe across the far side of the head.
    plane = want[0] * want[1]
    total = 0
    runs = 0
    for sl in body.slices:
        if sl.k >= want[2]:
            raise HTTPException(400, f"slice {sl.k} is outside the volume's {want[2]}")
        for r in sl.runs:
            if len(r) != 3:
                raise HTTPException(400, "every run must be [offset, length, value]")
            o, n, v = int(r[0]), int(r[1]), int(r[2])
            if o < 0 or n <= 0 or o + n > plane:
                raise HTTPException(
                    400, f"a run at offset {o} of length {n} does not fit a "
                         f"{want[0]}x{want[1]} plane")
            if v < 0 or v > 255:
                raise HTTPException(400, f"label {v} is not an 8-bit label value")
            total += n
            runs += 1
            if runs > MAX_RUNS:
                raise HTTPException(413, "too many runs in one correction")
    if not total:
        raise HTTPException(400, "This correction changes no voxel.")
    if total > MAX_EDIT_VOXELS:
        raise HTTPException(
            413, f"This correction rewrites {total} voxels and the limit is "
                 f"{MAX_EDIT_VOXELS}. A correction is a contour; something this large "
                 f"is a different segmentation, and re-uploading the scan with a "
                 f"different model choice is the better tool for it.")
    if total != int(body.voxels or total):
        # Not fatal, but recorded: a client whose own count disagrees with its own runs
        # has a bug, and the count is what the panel showed the person who clicked.
        log.warning("edit on %s: client counted %d voxels, the runs carry %d",
                    job.id[:8], body.voxels, total)

    # One queued edit at a time per case. Two corrections applied in either order give
    # different masks -- the second is a diff against a baseline the first has already
    # moved -- so they are serialised at the door rather than raced in the worker.
    pending = (s.query(db.CaseEdit)
               .filter(db.CaseEdit.job_id == job.id,
                       db.CaseEdit.state.in_([db.EDIT_QUEUED, db.EDIT_APPLYING]))
               .count())
    if pending:
        raise HTTPException(
            409, "A correction to this case is already being applied. Wait for it to "
                 "finish before sending another — a second correction is a difference "
                 "against a mask the first one has already changed.")

    row = db.CaseEdit(
        job_id=job.id,
        tenant_id=caller.tenant_id,
        created_by_user_id=caller.user_id or None,
        state=db.EDIT_QUEUED,
        note=body.note,
        voxels=total,
        structures={k: v for k, v in (body.structures or {}).items()},
        grid=body.grid.model_dump(),
    )
    s.add(row)
    s.flush()                      # for the id, before the file is named after it

    # The diff goes BESIDE the results it describes, not in a column. A generous
    # correction over forty slices is megabytes of runs, and putting it here means it is
    # deleted with the results -- correct, because a correction to a segmentation that
    # no longer exists is not something anyone can act on.
    edits_dir = root / "edits"
    edits_dir.mkdir(parents=True, exist_ok=True)
    payload = {"grid": body.grid.model_dump(),
               "slices": [{"k": sl.k, "runs": sl.runs} for sl in body.slices],
               "voxels": total,
               "structures": body.structures or {},
               "note": body.note,
               "created_at": datetime.now(timezone.utc).isoformat()}
    (edits_dir / f"{row.id}.json").write_text(json.dumps(payload, separators=(",", ":")))
    # Commit AFTER the file is on disk. The other order gives the worker a queued row
    # pointing at a file that is not there yet -- the same race the job queue commits
    # before returning to avoid.
    s.commit()
    log.info("edit %s queued on %s: %d voxels over %d slice(s)",
             row.id[:8], job.id[:8], total, len(body.slices))
    return _edit_out(row)


@router.delete("/{job_id}/edits/{edit_id}", status_code=204)
def delete_edit(job_id: str, edit_id: str, s: Session = Depends(get_session),
                caller: Caller = Depends(current_caller)):
    """Withdraw a correction that has not been applied yet.

    An APPLIED edit is not deletable, and that is deliberate: the mask has changed and
    the numbers have been recomputed from it, so removing the record would leave a case
    whose contours nobody can account for. The record is the only thing that says a
    person moved them.
    """
    from fastapi.responses import JSONResponse

    job = load_owned(job_id, s, caller)
    row = s.get(db.CaseEdit, edit_id)
    if row is None or row.job_id != job.id \
            or str(row.tenant_id) != str(caller.tenant_id):
        raise HTTPException(404, "No such edit")
    if row.state == db.EDIT_APPLIED:
        raise HTTPException(
            409, "This correction has already been applied and the measurements were "
                 "recomputed from it, so its record cannot be removed.")
    if row.state == db.EDIT_APPLYING:
        raise HTTPException(409, "This correction is being applied right now.")
    root = storage.resolve(job.tenant_id, "results", job.id).resolve()
    (root / "edits" / f"{row.id}.json").unlink(missing_ok=True)
    s.delete(row)
    s.commit()
    return JSONResponse(status_code=204, content=None)
