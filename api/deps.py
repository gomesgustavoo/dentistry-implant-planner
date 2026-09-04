"""Shared dependencies: the session, the caller, and the ownership check.

The ownership check is the security half of this service. Before it existed
`GET /v1/jobs` returned every job in the database to any caller, and get / cancel
/ delete / file-download did no check at all -- a uuid was the only thing between
two patients' scans.

It answers **404, not 403**, for another tenant's job. A 403 confirms the id
exists, which turns the endpoint into an existence oracle over a space of real
case ids; 404 leaks nothing and is also just true from the caller's point of view.
"""

from __future__ import annotations

from fastapi import Depends, HTTPException
from sqlalchemy.orm import Session

from dentistry import db
from dentistry.auth import Caller, current_caller  # noqa: F401  (re-exported)


def get_session() -> Session:
    s = db.SessionLocal()
    try:
        yield s
    finally:
        s.close()


def load_owned(job_id: str, session: Session, caller: Caller, *,
               lock: bool = False) -> db.Job:
    """Fetch a job the caller is allowed to see, or 404.

    Examples are readable by anybody who is signed in: they are public sample data
    and they are the demo. Everything else is tenant-scoped.
    """
    q = session.query(db.Job).filter(db.Job.id == job_id)
    if lock:
        # Lock before the ownership test, not after: the window between reading a
        # row and acting on it is exactly where the claim/cancel race lives.
        q = q.with_for_update()
    job = q.first()
    if job is None:
        raise HTTPException(404, "No such job")
    if job.is_example:
        return job
    if job.tenant_id != caller.tenant_id:
        raise HTTPException(404, "No such job")
    return job
