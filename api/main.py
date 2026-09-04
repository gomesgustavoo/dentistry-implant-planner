"""dentistry-api — upload a CBCT, watch it segment, download the result.

Deliberately small. There is one worker and one GPU, so this has no leases, no
fair-rank queue and no multipart upload protocol: a CBCT is 50-500 MB and Traefik's
`readTimeout` on this cluster is 900 s, which a single streamed PUT fits inside
with room to spare. Those mechanisms exist in VoxTell because it serves many
workstations; copying them here would be cargo.

**Authentication moved into the application.** It used to be enforced only by a
Traefik BasicAuth middleware -- one shared credential for everybody, and this app
trusted whatever reached it, which meant `GET /v1/jobs` handed every job in the
database to any caller. Requests now carry a Keycloak bearer token, every job has
an owning tenant, and every read, cancel, delete and file fetch filters on it.

`DENT_REQUIRE_AUTH` is the switch, and it starts FALSE on purpose. This image can
therefore be deployed while BasicAuth is still the real gate, exercised, and only
then closed -- rather than a single deploy that either works or locks everyone out
of a service holding patient data. Whichever way it is set, it is logged at
startup, because "is the API open?" must never be a question you have to read code
to answer.

Routes live in `api/routes/`. `api/routes/` had existed as an empty directory since
the first release while all eleven routes sat in this file.
"""

from __future__ import annotations

import logging
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request, status
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy import text

from dentistry import auth, db, quota, storage
from dentistry.config import settings

log = logging.getLogger("dentistry.api")
logging.basicConfig(level=os.environ.get("DENT_LOG_LEVEL", "INFO"),
                    format="%(asctime)s %(levelname)s %(name)s: %(message)s")


def _migrate_storage() -> None:
    """Move pre-accounts job directories under their tenant. Best effort.

    Best effort on purpose: `storage.resolve()` falls back to the flat layout, so a
    job whose files have not moved is still served correctly. That is what lets this
    run at startup without being able to break a deploy.

    Under the SAME advisory lock `init_db` uses, because this runs once per uvicorn
    WORKER, not once per pod. On the first real deploy both workers raced and the
    loser logged "could not move ... No such file or directory" for a directory the
    winner had already moved -- nothing was lost, but a startup log that says
    `failed` about intact data is its own kind of bug.
    """
    engine = db.get_engine()
    with engine.connect() as conn:
        conn.execute(text("SET lock_timeout = '60s'"))
        conn.execute(text("SELECT pg_advisory_lock(:k)"), {"k": db.MIGRATE_STORAGE_LOCK_KEY})
        conn.commit()
        try:
            with db.SessionLocal() as s:
                rows = s.execute(text("SELECT id, tenant_id::text FROM jobs")).all()
            storage.migrate_flat_layout({r[0]: r[1] for r in rows}.get)
        finally:
            conn.rollback()
            conn.execute(text("SELECT pg_advisory_unlock(:k)"),
                         {"k": db.MIGRATE_STORAGE_LOCK_KEY})
            conn.commit()


@asynccontextmanager
async def lifespan(app: FastAPI):
    db.init_db()
    auth.init_jwks()
    _migrate_storage()
    if settings.REQUIRE_AUTH:
        log.info("auth: REQUIRED (bearer token, aud=%s)", settings.OIDC_AUDIENCE)
    else:
        log.warning(
            "auth: OPTIONAL — an unauthenticated request is attributed to the "
            "'legacy' tenant. Set DENT_REQUIRE_AUTH=true once SSO is verified, and "
            "do not remove the BasicAuth middleware until you have."
        )
    log.info("billing: %s", "configured" if settings.stripe_enabled else "NOT configured")
    log.info("api ready; data dir %s", settings.DATA_DIR)
    yield


# Baked from the image tag at build time (build-images.sh -> Dockerfile.api ARG), so
# /v1/health cannot drift from what is actually deployed the way a literal did.
app = FastAPI(
    title="DicomSegVR Dentistry",
    version=os.getenv("DENT_VERSION", "dev"),
    docs_url="/v1/docs",
    openapi_url="/v1/openapi.json",
    lifespan=lifespan,
)

# The Cornerstone volume pack is two raw uint8 arrays per case, ~5 MB each, and a
# labelmap is mostly zeros so it compresses enormously. Neither nginx nor
# Cloudflare helps here: these responses come from FastAPI, and Cloudflare does not
# compress application/octet-stream by default. Without this the browser downloads
# the full uncompressed volume every time the Cornerstone tab is opened.
app.add_middleware(GZipMiddleware, minimum_size=4096)


@app.exception_handler(quota.QuotaDenied)
def _quota_denied(request: Request, exc: quota.QuotaDenied) -> JSONResponse:
    """Translate the library's exception into the HTTP shape.

    `dentistry/quota.py` raises a plain exception because the host worker imports it
    too and its requirements deliberately contain no web framework. The 402 body is
    `{"error", "used", "limit", "basis"}` -- the SPA switches on `error` to decide
    whether to offer an upgrade, a reset date, or the billing portal.
    """
    return JSONResponse(status_code=status.HTTP_402_PAYMENT_REQUIRED,
                        content={"detail": exc.body()})

from api.routes import (  # noqa: E402
    billing, edits, examples, files, jobs, me, plans, system, teams,
)

app.include_router(system.router)
app.include_router(me.router)
# BEFORE jobs/files, for the same reason those two are ordered: `/v1/tenants/...`
# and `/v1/invites/...` must not be shadowed by anything with a greedy path param.
app.include_router(teams.router)
app.include_router(examples.router)
# jobs before files: both are mounted under /v1/jobs, and the literal
# /v1/jobs/{job_id} must be matched before the /{job_id}/files/{path:path} greedy
# catch-all gets a chance at it.
app.include_router(jobs.router)
# plans before files, for the same reason: /v1/jobs/{id}/plans and /v1/jobs/{id}/measure
# are literal paths under the same prefix as the artifact catch-all.
app.include_router(plans.router)
# edits before files, for the same reason plans is: /v1/jobs/{id}/edits is a literal
# path under the same prefix as the artifact catch-all.
app.include_router(edits.router)
app.include_router(files.router)
app.include_router(billing.router)
