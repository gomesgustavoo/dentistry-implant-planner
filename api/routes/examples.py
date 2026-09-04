"""Curated demo cases.

Same pipeline, same table -- only a flag differs, so an example cannot accidentally
demonstrate a code path a real upload never takes. They belong to the `examples`
system tenant and are readable by any signed-in caller, which is what makes them
the demo rather than somebody's data.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from api.deps import Caller, current_caller, get_session
from api.routes.jobs import job_dict
from dentistry import db

router = APIRouter(prefix="/v1", tags=["examples"])


@router.get("/examples")
def list_examples(
    s: Session = Depends(get_session),
    caller: Caller = Depends(current_caller),
) -> dict:
    rows = (
        s.query(db.Job)
        .filter(db.Job.is_example == 1, db.Job.state == db.DONE)
        .order_by(db.Job.created_at)
        .all()
    )
    return {"examples": [{**job_dict(j), "reports": j.reports} for j in rows]}
