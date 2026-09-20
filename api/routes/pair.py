"""Pairing a headset with a workspace: the dashboard shows a code, the headset reads it.

PROPOSED. This file is not deployed. It is written against `~/dentistry` as it stands
at `36a6fa0` / `dentistry/api:0.18.0` and belongs at `api/routes/pair.py`. The two
patches it depends on -- a `DevicePairing` model in `dentistry/db.py` and a branch in
`dentistry/auth.py` -- are in `backend/PAIRING.md` along with why this shape and not
another, and what it costs.

WHAT THIS ISSUES, AND WHY IT IS NOT A JWT
-----------------------------------------
`dentistry/auth.py::decode_token` pins `algorithms=["RS256"]`, pins the issuer to the
Keycloak realm and resolves the verifying key by `kid` from that realm's JWKS. To mint
something it would accept, this service would need a private key Keycloak publishes the
public half of. It has none, and it has no Keycloak client secret either -- verified on
the live cluster: `dentistry-secrets` holds exactly one key, `DB_PASSWORD`.

So `/pair/claim` hands back an opaque device token of this service's own, checked
against a row on every request. That is a real cost, stated rather than buried: this
API becomes an issuer of credentials to patient scans, outside Keycloak's revocation
and MFA. Four things are here to pay it down, and none of them is optional:

  * the token is stored as a SHA-256 hash, exactly as `tenant_invites.token_hash` is;
  * it is checked against the database on **every** request, so revoking a headset from
    the dashboard takes effect on the next one rather than at the next token expiry;
  * authorisation is re-derived from `auth._lookup`, never from this table, so a device
    can never outlive the membership that justified it;
  * it has a hard expiry and an idle expiry, so a headset in a drawer dies on its own.

THE CODE IS A CREDENTIAL
------------------------
Same three rules `tenant_invites` established. Hashed at rest. Returned exactly once.
Revoked with a timestamp and never DELETEd, because "which headset was let into a
workspace holding patient data, and who let it in" is a question an audit asks.
"""

from __future__ import annotations

import datetime as dt
import hashlib
import logging
import secrets
import threading
import time
from urllib.parse import urlsplit

from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, Field
from sqlalchemy import text
from sqlalchemy.orm import Session

from api.deps import Caller, current_caller, get_session
from dentistry import db
from dentistry.config import settings

log = logging.getLogger("dentistry.api.pair")

# Literal paths, nothing greedy. Registered before `files.router` all the same, per the
# convention `api/main.py` states at every include line.
router = APIRouter(prefix="/v1", tags=["pairing"])

# Minutes, not the invites' 14 days. A pairing code is on a screen in a room with people
# in it, and the whole ceremony is "show it, look at it" -- anything longer is a window
# with no purpose.
CODE_TTL_MINUTES = 5

# The device token's hard ceiling, and how long a headset may go unseen before it is
# treated as lost. A clinic headset used weekly renews itself forever; one that stopped
# coming back is not a credential anybody is still watching.
DEVICE_TTL_DAYS = 90
DEVICE_IDLE_DAYS = 30

# `last_seen_at` is a dashboard nicety, not a control. Writing it on every request would
# add a write to every authenticated read.
SEEN_WRITE_INTERVAL_MINUTES = 60

# Marks the credential as this service's own rather than a Keycloak JWT. Both arrive in
# the same Authorization header, and a prefix is how `auth.py` decides which check to run
# without parsing a token to find out what kind it is.
TOKEN_PREFIX = "ipv1_"

# Crockford base32: no I, L, O or U, so the two characters a person most often mistypes
# are unambiguous and the third cannot spell anything. 10 characters is 2**50.
_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
_CODE_LENGTH = 10
_TRANSCRIPTION = str.maketrans({"I": "1", "L": "1", "O": "0", "U": "V"})

_bearer = HTTPBearer(auto_error=False)


def _hash(value: str) -> str:
    """SHA-256, hex. No salt and no KDF, for the reason `teams.py::_hash` gives: this is
    random high-entropy material, not a password, so there is no dictionary to defend
    against and the lookup has to be an indexed equality test."""
    return hashlib.sha256(value.encode()).hexdigest()


def _mint_code() -> str:
    return "".join(secrets.choice(_ALPHABET) for _ in range(_CODE_LENGTH))


def _normalise(code: str) -> str:
    """What the user meant, from what they scanned or typed.

    Grouping dashes are cosmetic and a dictated code arrives with whatever spacing the
    listener used, so both are dropped; the transcription table folds the characters the
    alphabet deliberately has no room for onto the ones they are mistaken for.
    """
    cleaned = "".join(ch for ch in code.upper() if ch.isalnum())
    return cleaned.translate(_TRANSCRIPTION)


def _pretty(code: str) -> str:
    return code[:5] + "-" + code[5:]


# --------------------------------------------------------------------------- #
# rate limiting
# --------------------------------------------------------------------------- #
#
# There is no rate limiting anywhere in this repository and none in front of it: the
# `/v1` ingress carries only `dentistry-headers`, which sets security headers. `/pair/claim`
# is the first unauthenticated route that mints access to a tenant's data, so it cannot
# be the first one without a limiter either.
#
# This one is in-process and therefore approximate. `Dockerfile.api` runs uvicorn with
# `--workers 2`, so the real ceiling is twice what is configured here, and a second
# replica would double it again. The per-IP bucket is a courtesy -- the address comes
# from a header a client can set -- and the GLOBAL bucket is the control that actually
# bounds a guessing run. Both numbers are set on that understanding.
_CLAIMS_PER_MINUTE_PER_IP = 5
_CLAIMS_PER_MINUTE_GLOBAL = 30

_rate_lock = threading.Lock()
_rate_buckets: dict[str, list[float]] = {}


def _client_key(request: Request) -> str:
    """Who to attribute an attempt to.

    Cloudflare Tunnel terminates in front of Traefik, so `request.client.host` is a pod
    address and identical for every caller. `CF-Connecting-IP` is set by Cloudflare and
    is the only one of these worth anything -- and it is worth nothing against an
    attacker who reaches the service another way.
    """
    for header in ("cf-connecting-ip", "x-forwarded-for"):
        value = request.headers.get(header)
        if value:
            return value.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


def _rate_limit(key: str) -> None:
    now = time.monotonic()
    cutoff = now - 60.0
    with _rate_lock:
        # Prune before counting, and prune everybody: without this the dict is an
        # unbounded map keyed on a value the caller controls.
        for bucket_key in list(_rate_buckets):
            kept = [t for t in _rate_buckets[bucket_key] if t > cutoff]
            if kept:
                _rate_buckets[bucket_key] = kept
            else:
                del _rate_buckets[bucket_key]

        mine = _rate_buckets.setdefault(key, [])
        total = sum(len(v) for v in _rate_buckets.values())
        if len(mine) >= _CLAIMS_PER_MINUTE_PER_IP or total >= _CLAIMS_PER_MINUTE_GLOBAL:
            raise HTTPException(
                status.HTTP_429_TOO_MANY_REQUESTS,
                "Too many pairing attempts. Wait a minute and try again.",
            )
        mine.append(now)


# --------------------------------------------------------------------------- #
# mint  (dashboard, authenticated)
# --------------------------------------------------------------------------- #
class StartRequest(BaseModel):
    label: str | None = Field(default=None, max_length=120)


@router.post("/pair/start", status_code=201)
def start_pairing(
    body: StartRequest,
    s: Session = Depends(get_session),
    caller: Caller = Depends(current_caller),
) -> dict:
    """Mint a pairing code and return it ONCE, with the payload to render as a QR.

    Not owner-only, unlike `create_invite`. A pairing grants the headset exactly the
    access its own holder already has -- it is keyed on `caller.user_id`, and every
    request it later makes is resolved through `auth._lookup` against that user's live
    memberships. A member pairing a headset therefore adds no privilege anywhere, and
    requiring an owner would only mean a clinic's owner has to be present before anyone
    can open a case in VR.

    There is no QR library in this image and adding one means a new pin and a rebuild,
    so this returns the payload string and the SPA draws the code -- which is also where
    it belongs, since the screen showing it is the SPA's.
    """
    if not caller.user_id:
        raise HTTPException(403, "This request is not attributed to a user account")

    code = _mint_code()
    expires = db.utcnow() + dt.timedelta(minutes=CODE_TTL_MINUTES)
    pairing_id = s.execute(text(
        "INSERT INTO device_pairings "
        "  (id, tenant_id, user_id, label, code_hash, created_by, code_expires_at) "
        "VALUES (gen_random_uuid(), CAST(:t AS uuid), CAST(:u AS uuid), :l, :h, "
        "        CAST(:u AS uuid), :x) "
        "RETURNING id::text"
    ), {"t": caller.tenant_id, "u": caller.user_id,
        "l": (body.label or None), "h": _hash(code), "x": expires}).scalar_one()
    s.commit()

    host = urlsplit(settings.PUBLIC_BASE_URL).netloc

    log.info("pairing code %s minted for user %s in tenant %s",
             pairing_id[:8], caller.user_id[:8], caller.tenant_id[:8])
    return {
        "id": pairing_id,
        "expiresAt": expires,
        # Shown once. The row holds only the hash, so neither of these can be re-read.
        "code": _pretty(code),
        # `IPVR1|host|code`. The host is there so a staging dashboard pairs a staging
        # headset without a rebuild; the headset checks it against its own configured
        # origin and refuses a mismatch rather than following it, because a QR code is
        # something found in a room. Kept short deliberately: the headset's tracker wants
        # a low QR version and a physically large code.
        "payload": f"IPVR1|{host}|{code}",
    }


# --------------------------------------------------------------------------- #
# claim  (headset, unauthenticated)
# --------------------------------------------------------------------------- #
class ClaimRequest(BaseModel):
    code: str = Field(max_length=64)
    label: str | None = Field(default=None, max_length=120)


@router.post("/pair/claim")
def claim_pairing(
    body: ClaimRequest,
    request: Request,
    s: Session = Depends(get_session),
) -> dict:
    """Exchange a pairing code for a device token, once.

    The single-use test is the UPDATE's own WHERE clause rather than a SELECT followed by
    an UPDATE: two headsets pointed at the same screen is a thing that happens, and the
    window between reading a row and acting on it is exactly where that race lives.
    """
    _rate_limit(_client_key(request))

    code = _normalise(body.code)
    if len(code) != _CODE_LENGTH:
        # Same message as a wrong code. A length check that answers differently tells a
        # stranger the shape of what they are guessing.
        raise _no_such_code()

    device_token = TOKEN_PREFIX + secrets.token_urlsafe(32)
    expires = db.utcnow() + dt.timedelta(days=DEVICE_TTL_DAYS)

    row = s.execute(text(
        "UPDATE device_pairings SET "
        "  claimed_at = now(), token_hash = :th, expires_at = :x, "
        "  last_seen_at = now(), label = COALESCE(:l, label) "
        "WHERE code_hash = :ch AND claimed_at IS NULL AND revoked_at IS NULL "
        "  AND code_expires_at > now() "
        "RETURNING id::text, tenant_id::text, user_id::text"
    ), {"th": _hash(device_token), "x": expires, "l": (body.label or None),
        "ch": _hash(code)}).first()

    if row is None:
        # One message for expired, already claimed, revoked and never-existed, the rule
        # `teams.py::_live_invite` sets: telling them apart tells a stranger holding a
        # guessed code which guesses are warm.
        s.rollback()
        raise _no_such_code()

    pairing_id, tenant_id, user_id = row
    s.commit()

    log.info("pairing %s claimed for user %s in tenant %s",
             pairing_id[:8], user_id[:8], tenant_id[:8])
    return _session_body(s, device_token, expires, tenant_id, user_id)


# --------------------------------------------------------------------------- #
# rotate  (headset, device token)
# --------------------------------------------------------------------------- #
@router.post("/pair/refresh")
def refresh_pairing(
    s: Session = Depends(get_session),
    creds: HTTPAuthorizationCredentials | None = Depends(_bearer),
) -> dict:
    """Roll the device token and push the expiry out.

    Rotation on every reconnection is what keeps the secret on a shared headset from
    being as old as the headset. The expiry moves with it, which is what makes
    DEVICE_TTL_DAYS an idle timeout in practice for a headset in weekly use and a hard
    stop for one that went in a drawer.

    Deliberately not `Depends(current_caller)`: this needs the pairing row, and reaching
    it through the Caller would mean carrying a row id on request state for one endpoint.
    """
    presented = creds.credentials if creds else None
    if not presented or not presented.startswith(TOKEN_PREFIX):
        raise _not_paired()

    rotated = TOKEN_PREFIX + secrets.token_urlsafe(32)
    expires = db.utcnow() + dt.timedelta(days=DEVICE_TTL_DAYS)

    row = s.execute(text(
        "UPDATE device_pairings SET token_hash = :new, expires_at = :x, last_seen_at = now() "
        "WHERE token_hash = :old AND revoked_at IS NULL AND expires_at > now() "
        "  AND last_seen_at > now() - CAST(:idle AS interval) "
        "RETURNING id::text, tenant_id::text, user_id::text"
    ), {"new": _hash(rotated), "old": _hash(presented), "x": expires,
        "idle": f"{DEVICE_IDLE_DAYS} days"}).first()

    if row is None:
        s.rollback()
        raise _not_paired()

    pairing_id, tenant_id, user_id = row
    s.commit()
    log.info("pairing %s rotated", pairing_id[:8])
    return _session_body(s, rotated, expires, tenant_id, user_id)


# --------------------------------------------------------------------------- #
# manage  (dashboard, authenticated)
# --------------------------------------------------------------------------- #
@router.get("/pair/devices")
def list_devices(
    s: Session = Depends(get_session),
    caller: Caller = Depends(current_caller),
) -> dict:
    """Every headset paired into this workspace.

    An owner sees all of them, a member sees their own. This list is not decoration: it
    is the only place a device credential can be seen or taken away, and a credential
    nobody can enumerate is one nobody revokes.
    """
    if caller.is_owner:
        where, params = "d.tenant_id = CAST(:t AS uuid)", {"t": caller.tenant_id}
    else:
        where = "d.tenant_id = CAST(:t AS uuid) AND d.user_id = CAST(:u AS uuid)"
        params = {"t": caller.tenant_id, "u": caller.user_id}

    rows = s.execute(text(
        "SELECT d.id::text, d.label, u.display_name, u.username, u.email, "
        "       d.claimed_at, d.expires_at, d.last_seen_at, d.revoked_at "
        "FROM device_pairings d JOIN users u ON u.id = d.user_id "
        f"WHERE {where} AND d.claimed_at IS NOT NULL "
        "ORDER BY d.revoked_at IS NOT NULL, d.last_seen_at DESC NULLS LAST"
    ), params).all()

    return {"devices": [
        {"id": r[0], "label": r[1] or "Headset",
         "pairedBy": r[2] or r[3] or r[4], "pairedAt": r[5],
         "expiresAt": r[6], "lastSeenAt": r[7], "revokedAt": r[8]}
        for r in rows
    ]}


@router.delete("/pair/devices/{pairing_id}", status_code=204)
def revoke_device(
    pairing_id: str,
    s: Session = Depends(get_session),
    caller: Caller = Depends(current_caller),
) -> None:
    """Take a headset's access away. Effective on its next request, not its next expiry.

    Revoked, not deleted, for the reason `revoke_invite` gives. The token hash is cleared
    at the same time: the row's job from here is to record that this happened, and it
    does not need to keep holding the material to do that.
    """
    if caller.is_owner:
        where, params = "tenant_id = CAST(:t AS uuid)", {"t": caller.tenant_id}
    else:
        where = "tenant_id = CAST(:t AS uuid) AND user_id = CAST(:u AS uuid)"
        params = {"t": caller.tenant_id, "u": caller.user_id}
    params["i"] = pairing_id

    updated = s.execute(text(
        "UPDATE device_pairings SET revoked_at = now(), token_hash = NULL "
        f"WHERE id = CAST(:i AS uuid) AND {where} AND revoked_at IS NULL"
    ), params).rowcount
    if not updated:
        # 404 rather than 403 for another workspace's device, the rule `deps.load_owned`
        # sets for jobs.
        raise HTTPException(404, "No such paired headset")
    s.commit()
    log.info("pairing %s revoked by user %s", pairing_id[:8], (caller.user_id or "?")[:8])


# --------------------------------------------------------------------------- #
# shared
# --------------------------------------------------------------------------- #
def _session_body(s: Session, token: str, expires: dt.datetime,
                  tenant_id: str, user_id: str) -> dict:
    """What the headset needs to show who it is acting as.

    `role` here is descriptive only. The authorisation a request actually gets is
    re-derived by `auth._lookup` from live membership rows every time, so a role printed
    on a pairing screen can never be the one that is enforced.
    """
    row = s.execute(text(
        "SELECT t.name, m.role, COALESCE(u.display_name, u.username, u.email) "
        "FROM tenants t "
        "JOIN users u ON u.id = CAST(:u AS uuid) "
        "LEFT JOIN tenant_members m "
        "       ON m.tenant_id = t.id AND m.user_id = CAST(:u AS uuid) "
        "WHERE t.id = CAST(:t AS uuid)"
    ), {"t": tenant_id, "u": user_id}).first()

    remaining = int((expires - db.utcnow()).total_seconds())
    return {
        "deviceToken": token,
        "expiresIn": max(0, remaining),
        "workspace": row[0] if row else None,
        "role": (row[1] if row else None) or db.ROLE_MEMBER,
        "user": row[2] if row else None,
    }


def _no_such_code() -> HTTPException:
    return HTTPException(404, "That pairing code is not valid any more")


def _not_paired() -> HTTPException:
    return HTTPException(
        status.HTTP_401_UNAUTHORIZED,
        "This headset is not paired any more",
        headers={"WWW-Authenticate": "Bearer"},
    )
