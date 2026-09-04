"""The result artifact server.

The path is validated by resolution rather than string inspection: `..` in a
filename is only dangerous if it escapes the job directory, and resolving both
sides is the check that actually proves it did not.

Result artifacts are immutable once a job is done -- the only thing that ever
changes them is retention deleting them, which is answered with 410 rather than
stale bytes. That is what makes a long `immutable` cache honest here instead of a
guess, and it is why max-age is capped by the remaining TTL: the header must never
outlive the file it describes.
"""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import FileResponse, Response
from sqlalchemy.orm import Session

from api.deps import Caller, current_caller, get_session, load_owned
from dentistry import db, storage
from dentistry.config import settings

router = APIRouter(prefix="/v1/jobs", tags=["files"])

MEDIA_TYPES = {
    ".json": "application/json",
    ".jpg": "image/jpeg",
    ".png": "image/png",
    ".stl": "model/stl",
    ".gz": "application/gzip",
    ".zip": "application/zip",
    ".raw": "application/octet-stream",
    ".msh": "application/octet-stream",
    ".dcm": "application/dicom",
}
EXAMPLE_MAX_AGE = 30 * 24 * 3600  # examples are retention-exempt


def _cache_headers(job: db.Job, target: Path) -> dict:
    st = target.stat()
    # Weak validator from size + mtime, the same shape nginx uses. No digest lookup
    # per request, and correct because the file never changes in place.
    etag = f'W/"{st.st_size:x}-{st.st_mtime_ns:x}"'
    if job.is_example:
        max_age = EXAMPLE_MAX_AGE
    else:
        finished = job.finished_at or job.updated_at
        elapsed = 0.0
        if finished:
            if finished.tzinfo is None:
                finished = finished.replace(tzinfo=timezone.utc)
            elapsed = (datetime.now(timezone.utc) - finished).total_seconds()
        max_age = int(max(0, settings.RESULT_TTL_HOURS * 3600 - elapsed))
    return {"ETag": etag, "Cache-Control": f"public, max-age={max_age}, immutable"}


@router.get("/{job_id}/files/{path:path}")
def get_file(
    job_id: str,
    path: str,
    request: Request,
    s: Session = Depends(get_session),
    caller: Caller = Depends(current_caller),
):
    j = load_owned(job_id, s, caller)
    if j.state != db.DONE:
        raise HTTPException(409, f"Job is {j.state}, not done")
    if j.results_expired:
        raise HTTPException(
            410,
            f"Results expired after {settings.RESULT_TTL_HOURS}h and were deleted. "
            f"Re-upload the scan to segment it again.",
        )
    # The measurement pack is ~30 MB of raw field per case and is READ through a memory
    # map by POST /measure, never served. Handing it out whole would be an amplifier for
    # nothing, and the numbers it supports are meant to come with their basis attached.
    if path.startswith("planning/pack/"):
        raise HTTPException(
            404, "The measurement pack is internal; use POST /v1/jobs/{id}/measure")
    root = storage.resolve(j.tenant_id, "results", job_id).resolve()
    target = (root / path).resolve()
    if not target.is_relative_to(root) or not target.is_file():
        raise HTTPException(404, "No such file")
    media = MEDIA_TYPES.get(target.suffix, "application/octet-stream")

    # gzip_static semantics: the worker pre-compressed this at export time, so serve
    # those bytes instead of re-gzipping the same file on every request. Verified
    # against starlette 0.49.3 -- GZipMiddleware passes through any response that
    # already carries Content-Encoding, so this is not double-encoded.
    #
    # The pre-compressed copy is used ONLY while it is at least as new as its source.
    # `bake()` is the last step of the pipeline, so normally it always is -- but any
    # in-place rewrite afterwards silently forks the two, and this endpoint would then
    # hand every browser (all of which send `accept-encoding: gzip`) the older bytes
    # while `POST /measure`, which reads the file directly, used the newer ones. That
    # happened: on a real case `planning/arch.json` carried a measured bone height for
    # all 16 maxillary sites and the `.gz` beside it carried 16 refusals -- the two were
    # two minutes and one bug fix apart, and nothing could tell them apart over HTTP.
    # Falling back to the identity encoding costs one gzip pass and cannot be wrong.
    send, encoding = target, None
    if "gzip" in request.headers.get("accept-encoding", ""):
        baked = target.with_name(target.name + ".gz")
        if baked.is_file() and baked.stat().st_mtime_ns >= target.stat().st_mtime_ns:
            send, encoding = baked, "gzip"

    # Built from the representation actually SENT. It used to always describe the
    # uncompressed file while the gz body went out under `immutable`, so two different
    # payloads shared one validator.
    headers = _cache_headers(j, send)
    if encoding:
        headers = {**headers, "Content-Encoding": encoding, "Vary": "Accept-Encoding"}

    # Nothing here ever changes, so a matching validator is always a 304.
    if request.headers.get("if-none-match") == headers["ETag"]:
        return Response(status_code=304, headers=headers)

    return FileResponse(send, media_type=media, headers=headers)
