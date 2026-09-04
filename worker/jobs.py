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
            "SELECT id, tenant_id, filename, input_kind, attempts, options FROM jobs "
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


def claim_next_edit():
    """Claim one queued segmentation edit, or None. Returns a detached dict.

    A SECOND queue, in its own table, and the reason is not tidiness. A re-derive
    touches no GPU, so it must not contend for the lease that serialises this box's
    three services -- and putting it in `jobs` would have made it consume a segmentation
    from the tenant's monthly quota, which is charging somebody for correcting our
    contour. Same `FOR UPDATE SKIP LOCKED`, same reasoning as `claim_next`.
    """
    with SessionLocal() as s:
        row = s.execute(text(
            "SELECT e.id, e.job_id, e.note, e.created_by_user_id, e.grid, "
            "       j.tenant_id, j.state AS job_state, j.results_expired "
            "  FROM case_edits e JOIN jobs j ON j.id = e.job_id "
            " WHERE e.state = :q ORDER BY e.created_at LIMIT 1 FOR UPDATE OF e SKIP LOCKED"
        ), {"q": "queued"}).mappings().first()
        if row is None:
            return None
        s.execute(text(
            "UPDATE case_edits SET state = 'applying', heartbeat_at = :t, "
            "updated_at = :t, error = NULL WHERE id = :i"
        ), {"t": _now(), "i": row["id"]})
        s.commit()
        # STRINGS, not UUID objects. `case_edits.id` and `jobs.tenant_id` are native
        # Postgres uuid columns, so a raw-SQL row hands back `uuid.UUID` -- and the
        # caller slices the id for a log line and joins it into a file path. Measured
        # live: `edit["id"][:8]` raised `TypeError: 'UUID' object is not subscriptable`
        # inside the claim log, which took the whole worker loop down with it. Coerced
        # here, once, rather than at each of the four places that consume the row.
        out = dict(row)
        for k in ("id", "tenant_id", "created_by_user_id"):
            if out.get(k) is not None:
                out[k] = str(out[k])
        return out


def edit_heartbeat(edit_id: str) -> None:
    with SessionLocal() as s:
        s.execute(text("UPDATE case_edits SET heartbeat_at = :t, updated_at = :t "
                       "WHERE id = :i"), {"t": _now(), "i": edit_id})
        s.commit()


def finish_edit(edit_id: str, job_id: str, reports: dict, result: dict) -> None:
    """Mark the edit applied AND write the job's new reports, in ONE transaction.

    They have to move together. A committed edit beside a stale `jobs.reports` is a case
    whose rail says the model drew a contour that a person has since moved, and a
    committed report beside a queued edit is an edit that would be applied twice.
    """
    import json

    with SessionLocal() as s:
        s.execute(text(
            "UPDATE jobs SET reports = CAST(:r AS jsonb), updated_at = :t WHERE id = :j"
        ), {"r": json.dumps(reports, default=str), "t": _now(), "j": job_id})
        s.execute(text(
            "UPDATE case_edits SET state = 'applied', applied_at = :t, updated_at = :t, "
            "voxels = :v, structures = CAST(:st AS jsonb), result = CAST(:res AS jsonb), "
            "error = NULL WHERE id = :i"
        ), {"t": _now(), "i": edit_id, "v": int(result.get("voxels") or 0),
            "st": json.dumps(result.get("structures") or {}),
            "res": json.dumps(result, default=str)})
        s.commit()


def fail_edit(edit_id: str, error: str) -> None:
    with SessionLocal() as s:
        s.execute(text(
            "UPDATE case_edits SET state = 'failed', updated_at = :t, error = :e "
            "WHERE id = :i"
        ), {"t": _now(), "i": edit_id, "e": error[:4000]})
        s.commit()


def requeue_stale_edits(older_than_seconds: int = 900) -> int:
    """Put back any edit a crashed worker left `applying`. Returns how many.

    The same property `heartbeat_at` gives jobs: a worker that dies mid-re-derive must
    not leave a correction stuck forever with no way to retry it. Nothing here is
    destructive -- the re-derive reads the stored segmentation and writes derived
    artifacts, so re-running it from the start is safe.
    """
    with SessionLocal() as s:
        n = s.execute(text(
            "UPDATE case_edits SET state = 'queued', updated_at = :t "
            " WHERE state = 'applying' "
            "   AND (heartbeat_at IS NULL OR heartbeat_at < :cut)"
        ), {"t": _now(), "cut": _now() - dt.timedelta(seconds=older_than_seconds)}).rowcount
        s.commit()
        return int(n or 0)


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
