"""Usage limits: what a tenant is allowed to submit, and the ledger that says so.

Copied in shape from `dicomsegvr/backend/app/quota.py`, with the same two
properties that make it correct under concurrency:

* `FOR UPDATE` on the **subscription row only**, never on the shared `plans`
  catalogue -- locking the catalogue would serialise every tenant against every
  other one.
* The ledger row is written **inside the same transaction, under that same lock**.
  Check-then-insert across two transactions is how two simultaneous uploads both
  see 29 of 30 used.

One thing here is genuinely different from both siblings, and it is a real bug
they do not have to care about: **a 14-day trial can straddle a month boundary.**
Counting per calendar month, a trial started on the 25th would reset on the 1st
and quietly hand out 60 jobs instead of 30. So a trial plan counts ALL-TIME usage
and a paid plan counts the current UTC month. `basis` in the response says which,
so the UI can be honest about what the number means.
"""

from __future__ import annotations

import datetime as dt
import logging
from dataclasses import dataclass

from sqlalchemy import text

from . import db

log = logging.getLogger("dentistry.quota")

class QuotaDenied(Exception):
    """This tenant may not submit another job, and why.

    A plain exception rather than a `fastapi.HTTPException` on purpose. `dentistry/`
    is the library BOTH halves import -- the API pod and the host worker, which
    refunds a slot when a job fails terminally -- and `requirements-worker.txt`
    deliberately contains no web framework. Importing fastapi here would mean
    either pulling starlette into a 5 GB CUDA image for one exception class, or a
    worker that cannot start at all. `api/main.py` translates this to a 402.
    """

    def __init__(self, error: str, state: "QuotaState | None" = None) -> None:
        super().__init__(error)
        self.error = error
        self.state = state

    def body(self) -> dict:
        out: dict = {"error": self.error}
        if self.state is not None:
            out["used"] = self.state.used
            out["limit"] = self.state.limit
            out["basis"] = self.state.basis
        return out


QUOTA_EXCEEDED = "quota_exceeded"
TRIAL_EXPIRED = "trial_expired"
SUBSCRIPTION_INACTIVE = "subscription_inactive"
NO_SUBSCRIPTION = "no_subscription"


def first_of_current_month() -> dt.date:
    now = dt.datetime.now(dt.timezone.utc)
    return dt.date(now.year, now.month, 1)


@dataclass
class QuotaState:
    tenant_id: str
    plan_id: str
    plan_name: str
    status: str
    is_trial: bool
    trial_ends_at: dt.datetime | None
    current_period_end: dt.datetime | None
    cancel_at_period_end: bool
    limit: int | None          # None == unlimited
    used: int
    basis: str                 # "trial" (all-time) | "month"

    @property
    def remaining(self) -> int | None:
        return None if self.limit is None else max(0, self.limit - self.used)


def payment_required(error: str, state: QuotaState | None = None) -> QuotaDenied:
    """The machine-readable reason. The SPA renders a different prompt for each: an
    expired trial needs an upgrade button, an exhausted quota needs a date, and an
    inactive subscription needs the billing portal."""
    return QuotaDenied(error, state)


def load_state(session, tenant_id: str, lock: bool = False) -> QuotaState:
    """Read plan + subscription + usage. With `lock`, holds the subscription row.

    `FOR UPDATE OF subscriptions` is not decoration: without it two concurrent
    uploads read the same count and both pass a check that only one should.
    """
    sql = (
        "SELECT s.plan_id, p.name, s.status, p.is_trial, s.trial_ends_at, "
        "       s.current_period_end, s.cancel_at_period_end, p.job_quota "
        "  FROM subscriptions s JOIN plans p ON p.id = s.plan_id "
        " WHERE s.tenant_id = :t"
    )
    if lock:
        sql += " FOR UPDATE OF s"
    row = session.execute(text(sql), {"t": tenant_id}).first()
    if row is None:
        raise payment_required(NO_SUBSCRIPTION)

    plan_id, plan_name, status_, is_trial, trial_ends, period_end, cancel_at_end, quota = row

    if is_trial:
        basis = "trial"
        used = session.execute(text(
            "SELECT count(*) FROM usage_events WHERE tenant_id = :t"
        ), {"t": tenant_id}).scalar_one()
    else:
        basis = "month"
        used = session.execute(text(
            "SELECT count(*) FROM usage_events "
            " WHERE tenant_id = :t AND counts_for_month = :m"
        ), {"t": tenant_id, "m": first_of_current_month()}).scalar_one()

    return QuotaState(
        tenant_id=tenant_id, plan_id=plan_id, plan_name=plan_name, status=status_,
        is_trial=bool(is_trial), trial_ends_at=trial_ends, current_period_end=period_end,
        cancel_at_period_end=bool(cancel_at_end),
        limit=quota, used=int(used), basis=basis,
    )


def check(state: QuotaState) -> None:
    """Raise 402 unless this tenant may submit one more job.

    The status test is an ALLOWLIST. A blocklist means any status nobody thought
    of -- a new Stripe state, a typo in a manual fix -- silently grants access.
    """
    if state.status == db.ACTIVE:
        pass
    elif state.status == db.TRIALING:
        if state.trial_ends_at is None or db.utcnow() > state.trial_ends_at:
            raise payment_required(TRIAL_EXPIRED, state)
    else:
        raise payment_required(SUBSCRIPTION_INACTIVE, state)

    if state.limit is not None and state.used >= state.limit:
        raise payment_required(QUOTA_EXCEEDED, state)


def record(session, tenant_id: str, job_id: str) -> None:
    """Append the ledger row. Must run in the transaction that holds the lock."""
    session.execute(text(
        "INSERT INTO usage_events (id, tenant_id, job_id, counts_for_month) "
        "VALUES (gen_random_uuid(), :t, :j, :m)"
    ), {"t": tenant_id, "j": job_id, "m": first_of_current_month()})


def attribute_gpu_seconds(session, job_id: str, gpu_seconds: float | None) -> None:
    """Fill in the cost after the fact. Never gates anything -- the ledger row that
    matters was written at admission, because a job the GPU never reached still
    consumed a slot in the queue."""
    if gpu_seconds is None:
        return
    session.execute(text(
        "UPDATE usage_events SET gpu_seconds = :g WHERE job_id = :j"
    ), {"g": gpu_seconds, "j": job_id})


def refund(session, tenant_id: str, job_id: str) -> None:
    """Give a slot back. Called only when a job never ran -- it failed before the
    GPU, or was cancelled while still queued. Deleting the ledger row is safe here
    precisely because the job never produced anything to download."""
    res = session.execute(text(
        "DELETE FROM usage_events WHERE tenant_id = :t AND job_id = :j"
    ), {"t": tenant_id, "j": job_id})
    if res.rowcount:
        log.info("refunded %d usage event(s) for job %s", res.rowcount, job_id)
