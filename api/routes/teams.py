"""Workspaces: who belongs to one, who may invite, and how you switch between them.

A "tenant" was a synonym for a user until this module existed -- `auth._provision()`
mints one per Keycloak `sub` and nothing could add a second person to it. That is
still how an account STARTS: everybody owns a personal workspace. What is new is
that a workspace can have more than one member, and that a user can belong to more
than one workspace.

Three rules the rest of the service depends on:

  * **`Caller.tenant_id` is the ACTIVE workspace**, resolved in `auth._lookup` from
    a membership row. Nothing here writes it directly; switching updates
    `users.active_tenant_id` and the next request resolves it again. That keeps the
    authorisation boundary in one place.
  * **Quota and billing are per workspace, not per person.** Members spend the
    workspace's allowance, which is the point of sharing one -- and it means an
    owner inviting people should expect their own quota to go down faster.
  * **An invite token is a credential.** It is stored hashed, shown once, and is
    the only thing needed to join a workspace holding patient scans.
"""

from __future__ import annotations

import datetime as dt
import hashlib
import logging
import secrets

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import text
from sqlalchemy.orm import Session

from api.deps import Caller, current_caller, get_session
from dentistry import db
from dentistry.config import settings

log = logging.getLogger("dentistry.api.teams")

router = APIRouter(prefix="/v1", tags=["teams"])

INVITE_TTL_DAYS = 14


def _hash(token: str) -> str:
    """SHA-256, hex. No salt and no KDF, deliberately: this is a 256-bit random
    token, not a password, so there is no dictionary to defend against and the
    lookup has to be an indexed equality test."""
    return hashlib.sha256(token.encode()).hexdigest()


def _member_rows(s: Session, tenant_id: str) -> list[dict]:
    rows = s.execute(text(
        "SELECT u.id::text, u.display_name, u.username, u.email, m.role, m.created_at "
        "FROM tenant_members m JOIN users u ON u.id = m.user_id "
        "WHERE m.tenant_id = CAST(:t AS uuid) "
        # Owners first, then longest-standing. A list whose order changes between
        # reloads is a list nobody can scan.
        "ORDER BY (m.role = 'owner') DESC, m.created_at"
    ), {"t": tenant_id}).all()
    return [{"userId": r[0], "name": r[1] or r[2] or r[3] or "Member",
             "email": r[3], "role": r[4], "joinedAt": r[5]} for r in rows]


def _owner_count(s: Session, tenant_id: str) -> int:
    return s.execute(text(
        "SELECT count(*) FROM tenant_members "
        "WHERE tenant_id = CAST(:t AS uuid) AND role = 'owner'"
    ), {"t": tenant_id}).scalar_one()


# --------------------------------------------------------------------------- #
# workspaces
# --------------------------------------------------------------------------- #
@router.get("/tenants")
def my_workspaces(
    s: Session = Depends(get_session),
    caller: Caller = Depends(current_caller),
) -> dict:
    """Every workspace this user belongs to, with which one is active."""
    rows = s.execute(text(
        "SELECT t.id::text, t.name, m.role, "
        "       (SELECT count(*) FROM tenant_members m2 WHERE m2.tenant_id = t.id) "
        "FROM tenant_members m JOIN tenants t ON t.id = m.tenant_id "
        "WHERE m.user_id = CAST(:u AS uuid) "
        "ORDER BY (t.id = CAST(:p AS uuid)) DESC, t.name"
    ), {"u": caller.user_id, "p": caller.personal_tenant_id or caller.tenant_id}).all()
    return {
        "activeTenantId": caller.tenant_id,
        "personalTenantId": caller.personal_tenant_id,
        "tenants": [{"id": r[0], "name": r[1], "role": r[2], "members": int(r[3]),
                     "isPersonal": r[0] == caller.personal_tenant_id} for r in rows],
    }


class SwitchRequest(BaseModel):
    tenantId: str


@router.post("/tenants/switch")
def switch_workspace(
    body: SwitchRequest,
    s: Session = Depends(get_session),
    caller: Caller = Depends(current_caller),
) -> dict:
    """Change which workspace this user acts in.

    Membership is re-checked HERE rather than trusted from the client, and again on
    every subsequent request in `auth._lookup`. Writing `active_tenant_id` without
    that check would be a tenant-id-in-the-request-body privilege escalation.
    """
    if not caller.user_id:
        raise HTTPException(403, "This request is not attributed to a user account")
    role = s.execute(text(
        "SELECT role FROM tenant_members "
        "WHERE user_id = CAST(:u AS uuid) AND tenant_id = CAST(:t AS uuid)"
    ), {"u": caller.user_id, "t": body.tenantId}).scalar_one_or_none()
    if role is None:
        # 404, not 403: a stranger must not be able to probe which workspace ids
        # exist, the same reasoning as `deps.load_owned`.
        raise HTTPException(404, "No such workspace")
    s.execute(text("UPDATE users SET active_tenant_id = CAST(:t AS uuid) WHERE id = CAST(:u AS uuid)"),
              {"t": body.tenantId, "u": caller.user_id})
    s.commit()
    return {"activeTenantId": body.tenantId, "role": role}


class RenameRequest(BaseModel):
    name: str = Field(min_length=1, max_length=200)


@router.patch("/tenants/current")
def rename_workspace(
    body: RenameRequest,
    s: Session = Depends(get_session),
    caller: Caller = Depends(current_caller),
) -> dict:
    caller.require_owner()
    s.execute(text("UPDATE tenants SET name = :n WHERE id = CAST(:t AS uuid)"),
              {"n": body.name.strip(), "t": caller.tenant_id})
    s.commit()
    return {"id": caller.tenant_id, "name": body.name.strip()}


# --------------------------------------------------------------------------- #
# members
# --------------------------------------------------------------------------- #
@router.get("/tenants/current/members")
def list_members(
    s: Session = Depends(get_session),
    caller: Caller = Depends(current_caller),
) -> dict:
    """Readable by any member: you are entitled to know who else can see your cases."""
    pending = []
    if caller.is_owner:
        # Only owners see the invite list -- it carries email addresses of people
        # who have not joined and may never.
        rows = s.execute(text(
            "SELECT id::text, email, role, created_at, expires_at FROM tenant_invites "
            "WHERE tenant_id = CAST(:t AS uuid) AND accepted_at IS NULL "
            "  AND revoked_at IS NULL AND expires_at > now() ORDER BY created_at DESC"
        ), {"t": caller.tenant_id}).all()
        pending = [{"id": r[0], "email": r[1], "role": r[2],
                    "createdAt": r[3], "expiresAt": r[4]} for r in rows]
    return {"members": _member_rows(s, caller.tenant_id), "pending": pending,
            "yourRole": caller.role, "yourUserId": caller.user_id}


class RoleRequest(BaseModel):
    role: str


@router.patch("/tenants/current/members/{user_id}")
def set_role(
    user_id: str,
    body: RoleRequest,
    s: Session = Depends(get_session),
    caller: Caller = Depends(current_caller),
) -> dict:
    caller.require_owner()
    if body.role not in db.ROLES:
        raise HTTPException(400, f"role must be one of {', '.join(db.ROLES)}")
    # Demoting the last owner leaves a workspace nobody can administer -- no
    # invites, no role changes, no way back. Checked before the write.
    if body.role != db.ROLE_OWNER and _owner_count(s, caller.tenant_id) <= 1:
        raise HTTPException(409, "A workspace must keep at least one owner")
    updated = s.execute(text(
        "UPDATE tenant_members SET role = :r "
        "WHERE tenant_id = CAST(:t AS uuid) AND user_id = CAST(:u AS uuid)"
    ), {"r": body.role, "t": caller.tenant_id, "u": user_id}).rowcount
    if not updated:
        raise HTTPException(404, "Not a member of this workspace")
    s.commit()
    return {"userId": user_id, "role": body.role}


@router.delete("/tenants/current/members/{user_id}", status_code=204)
def remove_member(
    user_id: str,
    s: Session = Depends(get_session),
    caller: Caller = Depends(current_caller),
) -> None:
    """Remove somebody from this workspace, or leave it yourself.

    A member may remove only themselves; an owner may remove anybody. Their JOBS
    stay: `jobs.tenant_id` is the workspace, and `submitted_by_user_id` is
    `ON DELETE SET NULL`, so a departure never deletes a colleague's cases.
    """
    leaving = user_id == caller.user_id
    if not leaving:
        caller.require_owner()
    # Scoped to LEAVING, not to the workspace. A personal workspace that has been
    # shared is just a workspace: its owner must still be able to remove the people
    # they invited into it. Written unscoped first, which blocked exactly that.
    if leaving and caller.tenant_id == caller.personal_tenant_id:
        raise HTTPException(409, "You cannot leave your own personal workspace")
    if _owner_count(s, caller.tenant_id) <= 1:
        role = s.execute(text(
            "SELECT role FROM tenant_members "
            "WHERE tenant_id = CAST(:t AS uuid) AND user_id = CAST(:u AS uuid)"
        ), {"t": caller.tenant_id, "u": user_id}).scalar_one_or_none()
        if role == db.ROLE_OWNER:
            raise HTTPException(409, "A workspace must keep at least one owner")
    deleted = s.execute(text(
        "DELETE FROM tenant_members "
        "WHERE tenant_id = CAST(:t AS uuid) AND user_id = CAST(:u AS uuid)"
    ), {"t": caller.tenant_id, "u": user_id}).rowcount
    if not deleted:
        raise HTTPException(404, "Not a member of this workspace")
    # Anybody parked in this workspace is sent back to their own on the next
    # request. `_lookup` also handles this defensively; doing it here means the
    # very next call is already right rather than logging a fallback.
    s.execute(text(
        "UPDATE users SET active_tenant_id = NULL "
        "WHERE id = CAST(:u AS uuid) AND active_tenant_id = CAST(:t AS uuid)"
    ), {"u": user_id, "t": caller.tenant_id})
    s.commit()
    log.info("removed user %s from tenant %s", user_id[:8], caller.tenant_id[:8])


# --------------------------------------------------------------------------- #
# invites
# --------------------------------------------------------------------------- #
class InviteRequest(BaseModel):
    # A plain string, NOT pydantic's EmailStr. That would pull `email-validator`
    # into the API image for a field this module already documents as a hint for
    # the inviter rather than a credential -- nothing is sent to it and nothing is
    # checked against it. A shape check is all the value it can carry.
    email: str | None = Field(default=None, max_length=320)
    role: str = db.ROLE_MEMBER

    @field_validator("email")
    @classmethod
    def _looks_like_an_address(cls, v: str | None) -> str | None:
        if v is None:
            return None
        v = v.strip()
        if not v:
            return None
        if v.count("@") != 1 or v.startswith("@") or v.endswith("@") or " " in v:
            raise ValueError("that does not look like an email address")
        return v


@router.post("/tenants/current/invites", status_code=201)
def create_invite(
    body: InviteRequest,
    s: Session = Depends(get_session),
    caller: Caller = Depends(current_caller),
) -> dict:
    """Mint an invite and return its link ONCE.

    There is no mail sender in this service, so the link is handed back to the
    inviter to pass on however they like. That is a deliberate limitation and the
    UI says so -- a link the app claims to have emailed and did not is worse than
    one the user copies themselves.
    """
    caller.require_owner()
    if body.role not in db.ROLES:
        raise HTTPException(400, f"role must be one of {', '.join(db.ROLES)}")
    token = secrets.token_urlsafe(32)
    expires = db.utcnow() + dt.timedelta(days=INVITE_TTL_DAYS)
    invite_id = s.execute(text(
        "INSERT INTO tenant_invites (id, tenant_id, email, role, token_hash, created_by, expires_at) "
        "VALUES (gen_random_uuid(), CAST(:t AS uuid), :e, :r, :h, CAST(:c AS uuid), :x) "
        "RETURNING id::text"
    ), {"t": caller.tenant_id, "e": body.email,
        "r": body.role, "h": _hash(token), "c": caller.user_id or None,
        "x": expires}).scalar_one()
    s.commit()
    base = settings.PUBLIC_BASE_URL.rstrip("/")
    log.info("invite %s created for tenant %s", invite_id[:8], caller.tenant_id[:8])
    return {
        "id": invite_id, "role": body.role,
        "email": body.email,
        "expiresAt": expires,
        # Shown once. The database holds only the hash, so this cannot be re-read.
        "url": f"{base}/app#/invite/{token}",
    }


@router.delete("/tenants/current/invites/{invite_id}", status_code=204)
def revoke_invite(
    invite_id: str,
    s: Session = Depends(get_session),
    caller: Caller = Depends(current_caller),
) -> None:
    caller.require_owner()
    # Revoked, not deleted: the row is the only record that the invite was ever
    # issued, and "who invited a stranger into a workspace holding patient data"
    # is exactly the question an audit asks.
    updated = s.execute(text(
        "UPDATE tenant_invites SET revoked_at = now() "
        "WHERE id = CAST(:i AS uuid) AND tenant_id = CAST(:t AS uuid) AND accepted_at IS NULL"
    ), {"i": invite_id, "t": caller.tenant_id}).rowcount
    if not updated:
        raise HTTPException(404, "No such pending invite")
    s.commit()


def _live_invite(s: Session, token: str):
    row = s.execute(text(
        "SELECT i.id::text, i.tenant_id::text, t.name, i.role, i.expires_at "
        "FROM tenant_invites i JOIN tenants t ON t.id = i.tenant_id "
        "WHERE i.token_hash = :h AND i.accepted_at IS NULL AND i.revoked_at IS NULL "
        "  AND i.expires_at > now()"
    ), {"h": _hash(token)}).first()
    if row is None:
        # One message for expired, revoked, already-used and never-existed. Telling
        # them apart tells a stranger holding a guessed token which guesses are warm.
        raise HTTPException(404, "This invitation is not valid any more")
    return row


@router.get("/invites/{token}")
def preview_invite(
    token: str,
    s: Session = Depends(get_session),
    caller: Caller = Depends(current_caller),
) -> dict:
    """What you would be joining. Requires sign-in, so the accept button is one click."""
    _id, tenant_id, name, role, expires = _live_invite(s, token)
    already = s.execute(text(
        "SELECT 1 FROM tenant_members WHERE user_id = CAST(:u AS uuid) "
        "AND tenant_id = CAST(:t AS uuid)"
    ), {"u": caller.user_id, "t": tenant_id}).first() is not None
    return {"workspace": name, "role": role, "expiresAt": expires, "alreadyMember": already}


@router.post("/invites/{token}/accept")
def accept_invite(
    token: str,
    s: Session = Depends(get_session),
    caller: Caller = Depends(current_caller),
) -> dict:
    """Join the workspace and switch to it.

    Whoever holds the token and is signed in becomes the member. The invite's email
    is a hint for the inviter, not a check: being invited at a work address and
    signing in with an identity that reports a different one is the common case, not
    an attack.
    """
    if not caller.user_id:
        raise HTTPException(403, "Sign in before accepting an invitation")
    invite_id, tenant_id, name, role, _expires = _live_invite(s, token)

    s.execute(text(
        "INSERT INTO tenant_members (id, tenant_id, user_id, role) "
        "VALUES (gen_random_uuid(), CAST(:t AS uuid), CAST(:u AS uuid), :r) "
        # Accepting twice, or accepting a second invite to a workspace you are
        # already in, must not fail and must not silently demote you.
        "ON CONFLICT ON CONSTRAINT uq_tenant_members_tenant_user DO NOTHING"
    ), {"t": tenant_id, "u": caller.user_id, "r": role})
    s.execute(text(
        "UPDATE tenant_invites SET accepted_at = now(), accepted_by = CAST(:u AS uuid) "
        "WHERE id = CAST(:i AS uuid)"
    ), {"u": caller.user_id, "i": invite_id})
    s.execute(text("UPDATE users SET active_tenant_id = CAST(:t AS uuid) WHERE id = CAST(:u AS uuid)"),
              {"t": tenant_id, "u": caller.user_id})
    s.commit()
    log.info("user %s joined tenant %s as %s", caller.user_id[:8], tenant_id[:8], role)
    return {"tenantId": tenant_id, "workspace": name, "role": role}
