"""The job queue, over Postgres. One row is one upload.

`FOR UPDATE SKIP LOCKED` rather than an advisory lock or a broker: the queue is
short, the workers are few, and this keeps the whole thing in the database that
already holds the results -- so a job cannot be claimed by a worker that then
cannot write its output.
"""
from __future__ import annotations

import datetime as dt
import logging

from sqlalchemy import text

from dentistry.db import SessionLocal

log = logging.getLogger(__name__)

QUEUED, RUNNING, DONE, FAILED, CANCELLED = "queued", "running", "done", "failed", "cancelled"


def _now():
    return dt.datetime.now(dt.timezone.utc)


def claim_next():
    """Claim one queued job, or None. Returns a detached dict."""
    with SessionLocal() as s:
        row = s.execute(text(
            "SELECT id, tenant_id, filename, input_kind, attempts FROM jobs "
            "WHERE state = :q ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED"
        ), {"q": QUEUED}).mappings().first()
        if row is None:
            return None
        s.execute(text(
            "UPDATE jobs SET state = :r, stage = 'starting', progress = 0, "
            "started_at = :t, heartbeat_at = :t, attempts = attempts + 1, "
            "updated_at = :t WHERE id = :i"
        ), {"r": RUNNING, "t": _now(), "i": row["id"]})
        s.commit()
        return dict(row)


def heartbeat(job_id: str, stage: str | None = None, progress: float | None = None) -> None:
    sets = ["heartbeat_at = :t", "updated_at = :t"]
    params = {"t": _now(), "i": job_id}
    if stage is not None:
        sets.append("stage = :s")
        params["s"] = stage[:64]
    if progress is not None:
        sets.append("progress = :p")
        params["p"] = float(progress)
    with SessionLocal() as s:
        s.execute(text(f"UPDATE jobs SET {', '.join(sets)} WHERE id = :i"), params)
        s.commit()


def cancel_requested(job_id: str) -> bool:
    with SessionLocal() as s:
        got = s.execute(text("SELECT cancel_requested FROM jobs WHERE id = :i"),
                        {"i": job_id}).scalar()
    return bool(got)


def finish_success(job_id: str, reports: dict, gpu_seconds=None, wait_seconds=None) -> None:
    import json

    with SessionLocal() as s:
        s.execute(text(
            "UPDATE jobs SET state = :d, stage = 'done', progress = 1.0, "
            "finished_at = :t, updated_at = :t, reports = CAST(:r AS jsonb), "
            "gpu_seconds = :g, wait_seconds = :w, error = NULL WHERE id = :i"
        ), {"d": DONE, "t": _now(), "r": json.dumps(reports, default=str),
            "g": gpu_seconds, "w": wait_seconds, "i": job_id})
        s.commit()


def finish_failure(job_id: str, error: str) -> None:
    with SessionLocal() as s:
        s.execute(text(
            "UPDATE jobs SET state = :f, stage = 'failed', finished_at = :t, "
            "updated_at = :t, error = :e WHERE id = :i"
        ), {"f": FAILED, "t": _now(), "e": error[:4000], "i": job_id})
        s.commit()


def mark_cancelled(job_id: str) -> None:
    with SessionLocal() as s:
        s.execute(text(
            "UPDATE jobs SET state = :c, stage = 'cancelled', finished_at = :t, "
            "updated_at = :t WHERE id = :i"
        ), {"c": CANCELLED, "t": _now(), "i": job_id})
        s.commit()
