"""The account: who you are, what plan you are on, how much you have left."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import text
from sqlalchemy.orm import Session

from api.deps import Caller, current_caller, get_session
from dentistry import quota
from dentistry.config import settings

router = APIRouter(prefix="/v1", tags=["account"])


@router.get("/plans")
def plans(s: Session = Depends(get_session)) -> dict:
    """The catalogue. Open, no auth: the pricing page is public and this is where
    it should get its numbers from rather than hard-coding them a second time."""
    rows = s.execute(text(
        "SELECT id, name, price_monthly, job_quota, is_trial FROM plans ORDER BY price_monthly"
    )).all()
    return {"plans": [
        {"id": r[0], "name": r[1], "priceMonthly": float(r[2]),
         "jobQuota": r[3], "isTrial": bool(r[4])}
        for r in rows
    ]}


def _profile(s: Session, caller: Caller) -> dict:
    """The application-owned profile, plus the identity fields Keycloak owns.

    `displayName` and `organisation` are ours to write. `email` and `username`
    are copies of token claims -- shown so Settings can display them, but not
    editable here, because this service holds no Keycloak admin credentials and a
    field that silently fails to save is worse than one that is honestly read-only.
    """
    row = s.execute(text(
        "SELECT display_name, organisation FROM users WHERE id = CAST(:u AS uuid)"
    ), {"u": caller.user_id}).first() if caller.user_id else None
    return {
        "displayName": row[0] if row else None,
        "organisation": row[1] if row else None,
        "email": caller.email,
        "username": caller.username,
        # Email, password and MFA live in Keycloak. Link out rather than pretend.
        "accountUrl": settings.oidc_account_url,
    }


class ProfilePatch(BaseModel):
    """Only the two fields this application actually owns.

    Absent means "leave alone"; an explicit null or "" means "clear it". Those are
    different requests and the UI relies on the difference -- clearing a display
    name has to be possible, and PATCH semantics are the honest way to say it.
    """

    displayName: str | None = Field(default=None, max_length=120)
    organisation: str | None = Field(default=None, max_length=160)


@router.patch("/me")
def update_me(
    patch: ProfilePatch,
    s: Session = Depends(get_session),
    caller: Caller = Depends(current_caller),
) -> dict:
    if not caller.user_id:
        # The `legacy` attribution has no user row to write to. Only reachable
        # while DENT_REQUIRE_AUTH is false.
        raise HTTPException(403, "This request is not attributed to a user account")
    fields = patch.model_dump(exclude_unset=True)
    if not fields:
        return _profile(s, caller)
    sets, params = [], {"u": caller.user_id}
    for key, column in (("displayName", "display_name"), ("organisation", "organisation")):
        if key in fields:
            val = fields[key]
            val = val.strip() if isinstance(val, str) else val
            sets.append(f"{column} = :{column}")
            params[column] = val or None  # "" clears, rather than storing blank
    s.execute(text(f"UPDATE users SET {', '.join(sets)} WHERE id = CAST(:u AS uuid)"), params)
    s.commit()
    return _profile(s, caller)


@router.get("/me/usage")
def usage_history(
    months: int = 12,
    s: Session = Depends(get_session),
    caller: Caller = Depends(current_caller),
) -> dict:
    """Per-month job counts and GPU seconds for this tenant.

    Read straight off `usage_events`, which is the same ledger the quota check
    counts -- so what Settings shows and what admission enforces can never drift.
    Note the ledger deliberately outlives the jobs it records (see the missing FK
    on `usage_events.job_id`), so a month's count can exceed the number of jobs
    still listed.
    """
    months = max(1, min(36, months))
    rows = s.execute(text(
        "SELECT counts_for_month, COUNT(*), COALESCE(SUM(gpu_seconds), 0) "
        "FROM usage_events WHERE tenant_id = CAST(:t AS uuid) "
        "GROUP BY counts_for_month ORDER BY counts_for_month DESC LIMIT :n"
    ), {"t": caller.tenant_id, "n": months}).all()
    return {"months": [
        {"month": r[0].isoformat(), "jobs": int(r[1]), "gpuSeconds": round(float(r[2]), 1)}
        for r in rows
    ]}


@router.get("/me")
def me(
    s: Session = Depends(get_session),
    caller: Caller = Depends(current_caller),
) -> dict:
    st = quota.load_state(s, caller.tenant_id)
    row = s.execute(text(
        "SELECT t.name, (SELECT count(*) FROM tenant_members m WHERE m.tenant_id = t.id) "
        "FROM tenants t WHERE t.id = CAST(:t AS uuid)"
    ), {"t": caller.tenant_id}).first()
    return {
        "user": {"id": caller.user_id, "email": caller.email, "username": caller.username},
        "profile": _profile(s, caller),
        "tenantId": caller.tenant_id,
        # Which workspace this session is acting in, and what the caller may do in
        # it. `role` is per workspace, never a property of the person: the same user
        # owns their personal one and may be a plain member of a colleague's, so the
        # UI has to re-read this after every switch.
        "workspace": {
            "id": caller.tenant_id,
            "name": (row[0] if row else None),
            "members": int(row[1]) if row else 1,
            "role": caller.role,
            "isPersonal": caller.tenant_id == caller.personal_tenant_id,
            "personalTenantId": caller.personal_tenant_id,
        },
        "plan": {"id": st.plan_id, "name": st.plan_name, "isTrial": st.is_trial,
                 "jobQuota": st.limit},
        "subscription": {
            "status": st.status,
            "trialEndsAt": st.trial_ends_at,
            "currentPeriodEnd": st.current_period_end,
            "cancelAtPeriodEnd": st.cancel_at_period_end,
        },
        # `basis` is not decoration. A trial's allowance is all-time and a paid
        # plan's resets monthly, so a bare "3 of 30" would mean two different
        # things and the UI could not say which.
        "usage": {"basis": st.basis, "used": st.used, "limit": st.limit,
                  "remaining": st.remaining},
        "billingEnabled": settings.stripe_enabled,
    }
