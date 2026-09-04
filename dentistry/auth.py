"""Bearer JWT authentication against Keycloak (RS256, JWKS), and provisioning.

The sibling implementation (`dicomsegvr/backend/app/auth.py`) is async on httpx.
This service is deliberately sync SQLAlchemy on psycopg -- FastAPI runs sync
endpoints in a threadpool -- so the same design is rebuilt on `threading.Lock` and
`urllib`, which also means no new HTTP dependency for one JWKS GET.

Two details that are not incidental:

* **The issuer and the JWKS URL are different hosts.** `iss` carries the public
  Keycloak hostname (it is pinned with `KC_HOSTNAME_STRICT`), but the public host
  is not necessarily routable from inside the cluster, so the keys are fetched
  over cluster DNS.
* **An unknown `kid` triggers exactly one refetch, under a lock, re-checking
  inside it.** Two replicas restarting into a key rotation would otherwise
  stampede Keycloak.

On a first-seen `sub` a Tenant, a User and a trialing Subscription are created in
one transaction. Two replicas can race on the same first request, so the unique
violation on `keycloak_sub` is caught and the row re-read.
"""

from __future__ import annotations

import datetime as dt
import json
import logging
import threading
import urllib.request
from dataclasses import dataclass

import jwt
from fastapi import Depends, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jwt.algorithms import RSAAlgorithm
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

from . import db
from .config import settings

log = logging.getLogger("dentistry.auth")

# auto_error=False so this module owns the 401 shape, including
# WWW-Authenticate -- a client cannot tell "no token" from "bad token" otherwise.
_bearer = HTTPBearer(auto_error=False)


def unauthorized(detail: str) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail=detail,
        headers={"WWW-Authenticate": "Bearer"},
    )


class JwksCache:
    """Signing keys by `kid`, with a single-flight refetch on a miss."""

    def __init__(self, url: str) -> None:
        self._url = url
        self._keys: dict[str, object] = {}
        self._lock = threading.Lock()

    def _fetch(self) -> None:
        req = urllib.request.Request(self._url, headers={"Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=10.0) as resp:
            data = json.loads(resp.read())
        keys: dict[str, object] = {}
        for jwk in data.get("keys", []):
            kid = jwk.get("kid")
            if not kid:
                continue
            try:
                keys[kid] = RSAAlgorithm.from_jwk(jwk)
            except Exception:  # noqa: BLE001
                # Skip a non-RSA or malformed entry rather than failing the whole
                # refresh -- a realm can legitimately publish EC keys we do not use.
                continue
        if not keys:
            raise RuntimeError(f"no usable RSA keys at {self._url}")
        self._keys = keys
        log.info("JWKS: %d signing key(s) cached", len(keys))

    def refresh(self) -> None:
        with self._lock:
            self._fetch()

    def get_key(self, kid: str):
        key = self._keys.get(kid)
        if key is not None:
            return key
        with self._lock:
            # Re-check inside the lock: another thread may have refreshed while we
            # waited, and a second fetch would be pure load on Keycloak.
            key = self._keys.get(kid)
            if key is None:
                self._fetch()
                key = self._keys.get(kid)
        if key is None:
            raise unauthorized("Unknown signing key")
        return key


jwks = JwksCache(settings.OIDC_JWKS_URL)


def init_jwks() -> None:
    """Warm the cache at startup. Failure is tolerated: the lazy refetch on the
    first request recovers, and refusing to start because Keycloak is briefly
    unreachable would take the whole API down with it."""
    try:
        jwks.refresh()
    except Exception as exc:  # noqa: BLE001
        log.warning("JWKS warm-up failed (will retry on first request): %s", exc)


def decode_token(token: str) -> dict:
    try:
        header = jwt.get_unverified_header(token)
    except jwt.InvalidTokenError as exc:
        raise unauthorized("Malformed token") from exc

    kid = header.get("kid")
    if not kid:
        raise unauthorized("Token has no kid")

    key = jwks.get_key(kid)
    try:
        return jwt.decode(
            token,
            key=key,
            algorithms=["RS256"],
            audience=settings.OIDC_AUDIENCE,
            issuer=settings.OIDC_ISSUER,
            leeway=settings.JWT_LEEWAY_SECONDS,
            options={"require": ["exp", "iat", "sub"]},
        )
    except jwt.ExpiredSignatureError as exc:
        raise unauthorized("Token expired") from exc
    except jwt.InvalidAudienceError as exc:
        # Overwhelmingly the most likely cause is a Keycloak client with no
        # audience mapper, so say so instead of "invalid token".
        raise unauthorized(
            f"Token audience is not {settings.OIDC_AUDIENCE} -- the client needs an "
            f"audience mapper"
        ) from exc
    except jwt.InvalidIssuerError as exc:
        raise unauthorized("Token issuer is not this realm") from exc
    except jwt.InvalidTokenError as exc:
        raise unauthorized("Invalid token") from exc


@dataclass(frozen=True)
class Caller:
    """Who is asking. `tenant_id` is what every ownership check filters on.

    The ids are **strings**, and that is load-bearing rather than cosmetic. The ORM
    maps these columns with `UUID(as_uuid=False)` and hands back `str`, but a raw
    `text()` query has no type information and psycopg returns `uuid.UUID` objects.
    Mixing the two makes `job.tenant_id != caller.tenant_id` true for every job
    including your own -- so every case becomes invisible to its owner while the
    "a stranger gets a 404" test still passes, for the wrong reason. Every query
    below therefore casts explicitly with `::text`.
    """

    user_id: str
    tenant_id: str
    sub: str
    email: str | None
    username: str | None
    # --- teams ------------------------------------------------------------
    # `tenant_id` above is the tenant this request ACTS IN, which since teams may
    # be a shared one rather than the caller's own. These two say which.
    #
    # `role` is the caller's role in `tenant_id`, not a global attribute: the same
    # person is owner of their personal tenant and may be a plain member of a
    # colleague's. Anything that gates on it must read it per request.
    personal_tenant_id: str = ""
    role: str = db.ROLE_OWNER

    @property
    def is_owner(self) -> bool:
        return self.role == db.ROLE_OWNER

    def require_owner(self) -> None:
        """Guard for the operations that reshape a team.

        403 rather than 404 here, unlike `load_owned`: the caller is a member and
        already knows the tenant exists, so there is nothing to leak and 'you are
        not an owner' is the actionable answer.
        """
        if not self.is_owner:
            raise HTTPException(
                status.HTTP_403_FORBIDDEN,
                "Only an owner of this workspace can do that",
            )


def _provision(session, sub: str, email: str | None, username: str | None) -> Caller:
    """Create tenant + user + trialing subscription for a first-seen identity."""
    label = username or email or sub[:8]
    trial_ends = db.utcnow() + dt.timedelta(days=settings.TRIAL_DAYS)
    try:
        tenant_id = session.execute(text(
            "INSERT INTO tenants (id, name, kind) "
            "VALUES (gen_random_uuid(), :n, :k) RETURNING id::text"
        ), {"n": label, "k": db.TENANT_PERSONAL}).scalar_one()
        user_id = session.execute(text(
            "INSERT INTO users (id, keycloak_sub, email, username, tenant_id) "
            "VALUES (gen_random_uuid(), :s, :e, :u, :t) RETURNING id::text"
        ), {"s": sub, "e": email, "u": username, "t": tenant_id}).scalar_one()
        # Owner of their own tenant. Without this row the very next request would
        # find no membership and fall through to the self-heal below.
        session.execute(text(
            "INSERT INTO tenant_members (id, tenant_id, user_id, role) "
            "VALUES (gen_random_uuid(), :t, :u, :r)"
        ), {"t": tenant_id, "u": user_id, "r": db.ROLE_OWNER})
        session.execute(text(
            "INSERT INTO subscriptions (id, tenant_id, plan_id, status, trial_ends_at) "
            "VALUES (gen_random_uuid(), :t, 'trial', :st, :te)"
        ), {"t": tenant_id, "st": db.TRIALING, "te": trial_ends})
        session.commit()
        log.info("provisioned tenant %s for sub %s (trial to %s)", tenant_id, sub, trial_ends)
        return Caller(user_id, tenant_id, sub, email, username,
                      personal_tenant_id=tenant_id, role=db.ROLE_OWNER)
    except IntegrityError:
        # Lost the race with the other replica on the unique keycloak_sub. The
        # other transaction created the whole set, so re-read rather than repair.
        session.rollback()
        found = _lookup(session, sub)
        if found is None:
            raise
        return found


def _lookup(session, sub: str) -> Caller | None:
    row = session.execute(text(
        "SELECT id::text, tenant_id::text, email, username, disabled_at, "
        "       active_tenant_id::text "
        "FROM users WHERE keycloak_sub = :s"
    ), {"s": sub}).first()
    if row is None:
        return None
    user_id, personal, email, username, disabled_at, active = row
    if disabled_at is not None:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "This account is disabled")

    tenant = active or personal
    role = _role_in(session, user_id, tenant)

    # Removed from the team they were last looking at. Not an error -- it is what
    # `DELETE /members/{id}` is FOR -- so drop them back to their own tenant rather
    # than 403-ing them out of an application they still have an account for.
    if role is None and tenant != personal:
        log.info("user %s is no longer a member of %s; falling back to their own tenant",
                 user_id[:8], tenant[:8])
        session.execute(text(
            "UPDATE users SET active_tenant_id = NULL WHERE id = CAST(:u AS uuid)"
        ), {"u": user_id})
        session.commit()
        tenant = personal
        role = _role_in(session, user_id, tenant)

    # Self-heal. An account provisioned before teams existed is backfilled by
    # migration 0017, but a row created in the window between deploying the code and
    # running that migration would have none -- and a caller with no membership can
    # see none of their own cases, which is far worse than an extra INSERT here.
    if role is None:
        log.warning("user %s had no membership of their own tenant %s; creating it",
                    user_id[:8], tenant[:8])
        session.execute(text(
            "INSERT INTO tenant_members (id, tenant_id, user_id, role) "
            "VALUES (gen_random_uuid(), :t, :u, :r) "
            "ON CONFLICT ON CONSTRAINT uq_tenant_members_tenant_user DO NOTHING"
        ), {"t": tenant, "u": user_id, "r": db.ROLE_OWNER})
        session.commit()
        role = db.ROLE_OWNER

    return Caller(user_id, tenant, sub, email, username,
                  personal_tenant_id=personal, role=role)


def _role_in(session, user_id: str, tenant_id: str) -> str | None:
    """The caller's role in one tenant, or None if they are not a member.

    This IS the authorisation boundary for teams: `tenant_id` on the Caller is what
    every ownership check filters on, so a tenant the caller has no row for must
    never end up there.
    """
    return session.execute(text(
        "SELECT role FROM tenant_members "
        "WHERE user_id = CAST(:u AS uuid) AND tenant_id = CAST(:t AS uuid)"
    ), {"u": user_id, "t": tenant_id}).scalar_one_or_none()


def caller_from_token(session, token: str) -> Caller:
    claims = decode_token(token)
    sub = claims.get("sub")
    if not sub:
        raise unauthorized("Token has no subject")
    email = claims.get("email")
    username = claims.get("preferred_username") or email or sub
    found = _lookup(session, sub)
    return found if found else _provision(session, sub, email, username)


def current_caller(
    request: Request,
    creds: HTTPAuthorizationCredentials | None = Depends(_bearer),
) -> Caller:
    """FastAPI dependency: the authenticated caller.

    While `DENT_REQUIRE_AUTH` is false a request with no token is attributed to the
    `legacy` tenant instead of being rejected. That is what lets the API be
    deployed and exercised while the Traefik BasicAuth middleware -- currently the
    only thing standing in front of uploaded CBCTs -- is still the real gate. It is
    flipped to true as the last step of the rollout, and it is the difference
    between an open API and a closed one, so it is logged loudly at startup.
    """
    with db.SessionLocal() as session:
        if creds and creds.credentials:
            caller = caller_from_token(session, creds.credentials)
            request.state.caller = caller
            return caller
        if settings.REQUIRE_AUTH:
            raise unauthorized("Not authenticated")
        legacy = db.system_tenant(session, db.TENANT_LEGACY)
        if not legacy:
            raise HTTPException(503, "Accounts are not initialised yet")
        caller = Caller("", legacy, "anonymous", None, None,
                        personal_tenant_id=legacy, role=db.ROLE_OWNER)
        request.state.caller = caller
        return caller
