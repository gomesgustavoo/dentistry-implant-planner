"""Job table + engine. Sync SQLAlchemy on psycopg, for both the API and worker.

Sync rather than async on purpose. The load here is one clinician at a time, and
the async path on this platform has a documented history of event-loop and
`from X import name` patching traps that buy nothing at this scale. FastAPI runs
sync endpoints in a threadpool.

Engines and sessionmakers are reached through the module (`db.SessionLocal`,
`db.get_engine()`), never imported by name — `from db import SessionLocal`
captures the object at import time and defeats every later patch or reconfigure,
which is precisely how the VoxTell sweeper ended up talking to the production DSN
under test.
"""

from __future__ import annotations

import datetime as dt
import logging
import uuid
from functools import lru_cache

from sqlalchemy import (
    Boolean,
    Date,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    Numeric,
    String,
    Text,
    UniqueConstraint,
    create_engine,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, sessionmaker

from .config import settings

log = logging.getLogger("dentistry.db")

# Distinct from GPU_LOCK_KEY and from every advisory key VoxTell uses
# (0x565853434D init, 0x565853574 sweep, 0x565852434C reclaim).
_INIT_LOCK_KEY = 0x44454E5401
# The one-time move of job directories under their tenant. A separate key from the
# schema lock so a slow filesystem walk cannot block a replica's schema check.
MIGRATE_STORAGE_LOCK_KEY = 0x44454E5402


def utcnow() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


class Base(DeclarativeBase):
    pass


# Job states. `queued` -> `running` -> `done` | `failed` | `cancelled`.
QUEUED, RUNNING, DONE, FAILED, CANCELLED = "queued", "running", "done", "failed", "cancelled"
TERMINAL = (DONE, FAILED, CANCELLED)


class Job(Base):
    __tablename__ = "jobs"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    # server_default, not just a Python default: raw-SQL inserts bypass the
    # Python side entirely, which is how VoxTell's embedding cache silently
    # stored zero rows for a week.
    created_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, server_default=text("now()"), nullable=False
    )
    updated_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, server_default=text("now()"), nullable=False
    )

    state: Mapped[str] = mapped_column(String(16), default=QUEUED, nullable=False, index=True)
    stage: Mapped[str] = mapped_column(String(64), default="queued", nullable=False)
    progress: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)

    filename: Mapped[str] = mapped_column(String(255), nullable=False)
    input_kind: Mapped[str] = mapped_column(String(16), nullable=False)  # dicom | nifti
    bytes_in: Mapped[int] = mapped_column(Integer, default=0, nullable=False)

    attempts: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    heartbeat_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    started_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    finished_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    # Wall-clock split, so a slow case can be attributed rather than guessed at.
    gpu_seconds: Mapped[float | None] = mapped_column(Float, nullable=True)
    wait_seconds: Mapped[float | None] = mapped_column(Float, nullable=True)

    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Everything measurable about the case: geometry, per-structure volumes,
    # component counts, laterality, cross-model agreement.
    reports: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    cancel_requested: Mapped[bool] = mapped_column(
        Integer, default=0, nullable=False, server_default=text("0")
    )
    # Curated demo cases, seeded by scripts/seed_examples.py. Flagged rather than
    # kept in a separate table so they go through the identical pipeline as a real
    # upload -- an example that took a special path would prove nothing.
    is_example: Mapped[bool] = mapped_column(
        Integer, default=0, nullable=False, server_default=text("0"), index=True
    )
    title: Mapped[str | None] = mapped_column(String(200), nullable=True)
    attribution: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Who owns this case. Nullable only so the column can be added to a table that
    # already has rows; every new job gets one. This is the security boundary --
    # every read, cancel, delete and file fetch filters on it, and before it existed
    # `GET /v1/jobs` returned every job in the database to any caller.
    tenant_id: Mapped[str | None] = mapped_column(
        UUID(as_uuid=False), ForeignKey("tenants.id", ondelete="CASCADE"),
        nullable=True, index=True
    )
    # WHO uploaded it, as opposed to which tenant owns it. Nullable because every
    # job that existed before teams did has no answer, and inventing one would be
    # worse than admitting it. `SET NULL` rather than `CASCADE`: removing a person
    # from a team must not delete the team's cases.
    submitted_by_user_id: Mapped[str | None] = mapped_column(
        UUID(as_uuid=False), ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True, index=True
    )
    # Results purged by the retention sweep. The row is kept so the UI can say
    # "expired" rather than offering a download that 404s.
    results_expired: Mapped[bool] = mapped_column(
        Integer, default=0, nullable=False, server_default=text("0"), index=True
    )




# --------------------------------------------------------------------------- #
# Accounts.
#
# A tenant is the unit that owns cases and holds a subscription; a user is a
# Keycloak identity that acts for one. They are one-to-one today, but they are two
# tables rather than one because "add a second dentist to this practice" must not
# require moving every case to a different owner.
# --------------------------------------------------------------------------- #
TENANT_PERSONAL, TENANT_EXAMPLES, TENANT_LEGACY = "personal", "examples", "legacy"


class Tenant(Base):
    __tablename__ = "tenants"

    id: Mapped[str] = mapped_column(
        UUID(as_uuid=False), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    kind: Mapped[str] = mapped_column(String(16), default=TENANT_PERSONAL, nullable=False)
    created_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, server_default=text("now()"), nullable=False
    )


class User(Base):
    __tablename__ = "users"

    id: Mapped[str] = mapped_column(
        UUID(as_uuid=False), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    # The Keycloak `sub` is the only real identity. Email and username are
    # descriptive: both are mutable in Keycloak, so neither can be a key.
    keycloak_sub: Mapped[str] = mapped_column(String(255), nullable=False, unique=True, index=True)
    email: Mapped[str | None] = mapped_column(String(320), nullable=True)
    username: Mapped[str | None] = mapped_column(String(255), nullable=True)
    # The profile the APPLICATION owns, as opposed to the identity Keycloak owns.
    # Email and username above are copies of token claims and are overwritten by
    # whatever Keycloak says; these two are only ever written by the account holder
    # through `PATCH /v1/me`, so they survive an email change and are the right
    # place for anything Keycloak has no field for.
    display_name: Mapped[str | None] = mapped_column(String(120), nullable=True)
    organisation: Mapped[str | None] = mapped_column(String(160), nullable=True)
    # The tenant this session is acting in. NULL means "the personal one above".
    #
    # `tenant_id` is now the tenant provisioning created FOR this user and never
    # changes; `active_tenant_id` is which of their memberships they are currently
    # looking at. Keeping them separate means switching to a team and back cannot
    # strand the personal tenant's jobs, which is what a single mutable column
    # would have done.
    active_tenant_id: Mapped[str | None] = mapped_column(
        UUID(as_uuid=False), ForeignKey("tenants.id", ondelete="SET NULL"), nullable=True
    )
    tenant_id: Mapped[str] = mapped_column(
        UUID(as_uuid=False), ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False, index=True
    )
    created_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, server_default=text("now()"), nullable=False
    )
    disabled_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


# Membership roles. `owner` may invite, remove members and manage billing;
# `member` may submit and view the tenant's cases and nothing else. Two levels,
# because a third with no distinct capability is a setting nobody can explain.
ROLE_OWNER, ROLE_MEMBER = "owner", "member"
ROLES = (ROLE_OWNER, ROLE_MEMBER)


class TenantMember(Base):
    """Who belongs to which tenant, and as what.

    This is the table that makes a tenant a TEAM rather than a synonym for a user.
    Before it, `auth._provision()` minted one tenant per Keycloak sub and nothing
    could ever add a second person, so "tenant" and "user" were the same thing with
    two names.

    A user keeps their personal tenant membership for life; joining a team ADDS a
    row rather than moving them, so their own cases stay reachable.
    """

    __tablename__ = "tenant_members"
    __table_args__ = (
        UniqueConstraint("tenant_id", "user_id", name="uq_tenant_members_tenant_user"),
    )

    id: Mapped[str] = mapped_column(
        UUID(as_uuid=False), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    tenant_id: Mapped[str] = mapped_column(
        UUID(as_uuid=False), ForeignKey("tenants.id", ondelete="CASCADE"),
        nullable=False, index=True
    )
    user_id: Mapped[str] = mapped_column(
        UUID(as_uuid=False), ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False, index=True
    )
    role: Mapped[str] = mapped_column(String(16), nullable=False, server_default=text("'member'"))
    created_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, server_default=text("now()"), nullable=False
    )


class TenantInvite(Base):
    """A pending invitation to join a tenant.

    The token is stored as a **SHA-256 hash**, never in plaintext, for the same
    reason a password reset token is: this row is readable by anything with
    database access, and the token alone grants membership of a tenant holding
    patient scans. The plaintext is returned exactly once, to the inviter, and is
    not recoverable afterwards.

    Deliberately keyed on email as a *hint*, not a credential -- the accepting user
    is whoever holds the token and is signed in. Checking that the signed-in email
    matches would break the common case of being invited at a work address and
    signing in with a Google identity that reports a different one.
    """

    __tablename__ = "tenant_invites"

    id: Mapped[str] = mapped_column(
        UUID(as_uuid=False), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    tenant_id: Mapped[str] = mapped_column(
        UUID(as_uuid=False), ForeignKey("tenants.id", ondelete="CASCADE"),
        nullable=False, index=True
    )
    email: Mapped[str | None] = mapped_column(String(320), nullable=True)
    role: Mapped[str] = mapped_column(String(16), nullable=False, server_default=text("'member'"))
    token_hash: Mapped[str] = mapped_column(String(64), nullable=False, unique=True, index=True)
    created_by: Mapped[str | None] = mapped_column(
        UUID(as_uuid=False), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    created_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, server_default=text("now()"), nullable=False
    )
    expires_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    accepted_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    accepted_by: Mapped[str | None] = mapped_column(
        UUID(as_uuid=False), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    revoked_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class Plan(Base):
    __tablename__ = "plans"

    # A stable string id, never renamed: `subscriptions.plan_id` references it and
    # the trial provisioning names it literally. The DISPLAY name may change --
    # `clinician` has shown as "Pro" on the sibling product for months.
    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    name: Mapped[str] = mapped_column(String(64), nullable=False)
    price_monthly: Mapped[float] = mapped_column(Numeric(10, 2), nullable=False)
    # NULL means unlimited. No plan uses that today; the column allows it so a
    # bespoke arrangement does not need a migration.
    job_quota: Mapped[int | None] = mapped_column(Integer, nullable=True)
    is_trial: Mapped[bool] = mapped_column(
        Boolean, default=False, nullable=False, server_default=text("false")
    )


# Subscription states. The quota check allows `active` and `trialing` and denies
# everything else, including anything it does not recognise.
TRIALING, ACTIVE, PAST_DUE, CANCELED = "trialing", "active", "past_due", "canceled"


class Subscription(Base):
    __tablename__ = "subscriptions"

    id: Mapped[str] = mapped_column(
        UUID(as_uuid=False), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    # Exactly one per tenant, enforced by the unique index rather than by
    # convention: two subscriptions for one tenant is a double-charge.
    tenant_id: Mapped[str] = mapped_column(
        UUID(as_uuid=False), ForeignKey("tenants.id", ondelete="CASCADE"),
        nullable=False, unique=True, index=True
    )
    plan_id: Mapped[str] = mapped_column(String(32), ForeignKey("plans.id"), nullable=False)
    status: Mapped[str] = mapped_column(String(32), default=TRIALING, nullable=False)
    trial_ends_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # Indexed because a Stripe webhook for a subscription change carries only the
    # customer id -- there is nothing else to look the tenant up by.
    stripe_customer_id: Mapped[str | None] = mapped_column(String(255), nullable=True, index=True)
    stripe_subscription_id: Mapped[str | None] = mapped_column(String(255), nullable=True, index=True)
    current_period_end: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    cancel_at_period_end: Mapped[bool] = mapped_column(
        Boolean, default=False, nullable=False, server_default=text("false")
    )
    created_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, server_default=text("now()"), nullable=False
    )


class UsageEvent(Base):
    """One row per accepted segmentation. Append-only, and it OUTLIVES the job.

    `DELETE /v1/jobs/{id}` exists, so a ledger derived from the jobs table would be
    a refund exploit: submit, download, delete, repeat. `job_id` is deliberately a
    plain string with no foreign key, so deleting a job cannot cascade the usage
    away.
    """

    __tablename__ = "usage_events"

    id: Mapped[str] = mapped_column(
        UUID(as_uuid=False), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    tenant_id: Mapped[str] = mapped_column(
        UUID(as_uuid=False), ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False, index=True
    )
    job_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    # The UTC month this counts against, stamped at admission so a job cannot drift
    # into the next month while it queues.
    counts_for_month: Mapped[dt.date] = mapped_column(Date, nullable=False, index=True)
    gpu_seconds: Mapped[float | None] = mapped_column(Float, nullable=True)
    created_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, server_default=text("now()"), nullable=False
    )


# The plan catalogue is CANONICAL here and upserted at every startup, so editing
# this list is how prices and quotas change -- never raw SQL against `plans`.
# Quotas are segmentations per calendar month, except the trial, which is a
# lifetime allowance (see quota.py: a 14-day trial straddling a month boundary
# would otherwise hand out 60 jobs instead of 30).
PLAN_SEED: list[dict] = [
    {"id": "trial",      "name": "Trial",      "price_monthly": "0.00",   "job_quota": 30,  "is_trial": True},
    {"id": "explorer",   "name": "Explorer",   "price_monthly": "12.99",  "job_quota": 30,  "is_trial": False},
    {"id": "clinician",  "name": "Pro",        "price_monthly": "49.99",  "job_quota": 60,  "is_trial": False},
    {"id": "enterprise", "name": "Enterprise", "price_monthly": "199.99", "job_quota": 120, "is_trial": False},
]


def seed_plans(conn) -> None:
    """Reconcile the catalogue. ON CONFLICT DO UPDATE, so a hand-edited row is
    corrected on the next restart rather than silently surviving."""
    stmt = pg_insert(Plan.__table__).values(PLAN_SEED)
    conn.execute(stmt.on_conflict_do_update(
        index_elements=[Plan.id],
        set_={
            "name": stmt.excluded.name,
            "price_monthly": stmt.excluded.price_monthly,
            "job_quota": stmt.excluded.job_quota,
            "is_trial": stmt.excluded.is_trial,
        },
    ))


@lru_cache(maxsize=1)
def get_engine():
    return create_engine(settings.db_url, pool_pre_ping=True, pool_size=5, max_overflow=5, future=True)


class _LazySessionLocal:
    """`db.SessionLocal()` without binding the engine at import time."""

    def __call__(self, **kw):
        return sessionmaker(bind=get_engine(), expire_on_commit=False, future=True)(**kw)


SessionLocal = _LazySessionLocal()


# Statements `create_all` cannot express, applied once each and recorded. One
# transaction per statement: Postgres aborts a whole transaction on the first
# error, so bundling them means a late failure silently rolls back the earlier
# ones -- the trap that once left a sibling service with no tables at all.
class CasePlan(Base):
    """A saved implant plan for one case.

    **Named CasePlan because `Plan` above is the BILLING tier.** The collision is easy to
    make -- `GET /v1/plans` is billing, `GET /v1/jobs/{id}/plans` is this -- and it would
    be caught late and confusingly.

    `implants` is the ONLY source of truth, and it stores arch-frame coordinates
    `(s, t, z)` rather than LPS. With zero yaw an implant then lies entirely inside one
    cross-section, so the browser's drag and the server's measurement derive the same
    pose from the same published polyline and cannot disagree.

    `measured` is a CACHE and explicitly not authoritative. `RESULT_TTL_HOURS` is 72, so
    the measurement pack disappears long before the plan does; a plan whose pack has
    expired renders its last numbers with the date and a note, which is the same shape as
    the existing `results_expired` handling. Never silently stale, never blank.

    Plans live in Postgres only and never write under `results/` -- `retention.
    purge_expired_results` keys on the job directory's mtime, and saving a plan must not
    quietly extend a case's retention window.

    No `_MIGRATIONS` row: `init_db` runs `create_all` under the advisory lock, and only
    changes to EXISTING tables need one (see the comment on the list below).
    """

    __tablename__ = "case_plans"

    id: Mapped[str] = mapped_column(
        UUID(as_uuid=False), primary_key=True, default=lambda: str(uuid.uuid4()))
    # String(36) to match Job.id, which is a varchar rather than a native uuid column.
    job_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("jobs.id", ondelete="CASCADE"), index=True)
    # Denormalised: every listing filters on it, and DELETE ON CASCADE from jobs means
    # `delete_job` needs no change to stay correct.
    # UUID, not String(36): `tenants.id` and `users.id` are native uuid columns while
    # `jobs.id` is a varchar. Matching Job's own declarations is the only thing that
    # makes these foreign keys creatable at all.
    tenant_id: Mapped[str | None] = mapped_column(
        UUID(as_uuid=False), ForeignKey("tenants.id", ondelete="CASCADE"),
        index=True, nullable=True)
    created_by_user_id: Mapped[str | None] = mapped_column(
        UUID(as_uuid=False), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    # server_default as well as a Python default, matching Job: raw-SQL inserts (the
    # showcase seeder is one) bypass the ORM and would otherwise leave these null.
    created_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, server_default=text("now()"),
        nullable=False)
    updated_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, server_default=text("now()"),
        onupdate=utcnow, nullable=False)

    name: Mapped[str] = mapped_column(String(120), default="Plan")
    jaw: Mapped[str] = mapped_column(String(16), default="mandible")
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    implants: Mapped[list] = mapped_column(JSONB, default=list)
    measured: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    measured_at: Mapped[dt.datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True)
    arch_version: Mapped[int] = mapped_column(default=1)
    schema_version: Mapped[int] = mapped_column(default=1)


_MIGRATIONS: list[tuple[str, str]] = [
    ("0001_jobs_is_example", "ALTER TABLE jobs ADD COLUMN IF NOT EXISTS is_example INTEGER NOT NULL DEFAULT 0"),
    ("0002_jobs_title", "ALTER TABLE jobs ADD COLUMN IF NOT EXISTS title VARCHAR(200)"),
    ("0003_jobs_attribution", "ALTER TABLE jobs ADD COLUMN IF NOT EXISTS attribution TEXT"),
    ("0004_ix_jobs_is_example", "CREATE INDEX IF NOT EXISTS ix_jobs_is_example ON jobs (is_example)"),
    ("0005_jobs_results_expired",
     "ALTER TABLE jobs ADD COLUMN IF NOT EXISTS results_expired INTEGER NOT NULL DEFAULT 0"),
    ("0006_ix_jobs_retention",
     "CREATE INDEX IF NOT EXISTS ix_jobs_retention ON jobs (results_expired, is_example, state)"),
    # Accounts. The new TABLES are created by `create_all`; only the change to the
    # existing `jobs` table needs spelling out.
    ("0007_jobs_tenant_id", "ALTER TABLE jobs ADD COLUMN IF NOT EXISTS tenant_id UUID"),
    ("0008_ix_jobs_tenant_id", "CREATE INDEX IF NOT EXISTS ix_jobs_tenant_id ON jobs (tenant_id)"),
    # ADD CONSTRAINT has no IF NOT EXISTS, so guard on pg_constraint. NOT VALID
    # first: the column is being backfilled in the same startup and validating a
    # constraint takes a lock on the whole table.
    ("0009_fk_jobs_tenant", """
     DO $$ BEGIN
       IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_jobs_tenant') THEN
         ALTER TABLE jobs ADD CONSTRAINT fk_jobs_tenant
           FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE CASCADE NOT VALID;
       END IF;
     END $$"""),
    # The quota count is `WHERE tenant_id = ? AND counts_for_month = ?` on every
    # upload, and it runs while holding a row lock -- it does not get to be a scan.
    ("0010_ix_usage_tenant_month",
     "CREATE INDEX IF NOT EXISTS ix_usage_tenant_month ON usage_events (tenant_id, counts_for_month)"),
    # Trials count all-time rather than per-month, so that query has no month
    # predicate to help it.
    ("0011_ix_usage_tenant", "CREATE INDEX IF NOT EXISTS ix_usage_tenant ON usage_events (tenant_id)"),
    # The application-owned half of the profile. Nullable with no default: an
    # account that has never opened Settings has no display name, and "" would be
    # indistinguishable from a name the user deliberately cleared.
    ("0012_users_display_name",
     "ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name VARCHAR(120)"),
    ("0013_users_organisation",
     "ALTER TABLE users ADD COLUMN IF NOT EXISTS organisation VARCHAR(160)"),
    # Teams. `tenant_members` and `tenant_invites` are new TABLES and `create_all`
    # makes them; only the changes to existing tables need spelling out here.
    ("0014_users_active_tenant",
     "ALTER TABLE users ADD COLUMN IF NOT EXISTS active_tenant_id UUID"),
    ("0015_jobs_submitted_by",
     "ALTER TABLE jobs ADD COLUMN IF NOT EXISTS submitted_by_user_id UUID"),
    ("0016_ix_jobs_submitted_by",
     "CREATE INDEX IF NOT EXISTS ix_jobs_submitted_by ON jobs (submitted_by_user_id)"),
    # Backfill: every user who existed before teams is the OWNER of the tenant
    # provisioning made for them. Without this every existing account would have
    # zero memberships and `current_caller` would refuse them their own data.
    # `ON CONFLICT DO NOTHING` keyed on the unique index makes the re-run a no-op.
    ("0017_backfill_tenant_members", """
     INSERT INTO tenant_members (id, tenant_id, user_id, role)
     SELECT gen_random_uuid(), u.tenant_id, u.id, 'owner' FROM users u
     ON CONFLICT ON CONSTRAINT uq_tenant_members_tenant_user DO NOTHING"""),
]

_ALREADY_EXISTS = {"42P07", "42710", "42701"}


def _sqlstate(exc) -> str | None:
    """Driver-agnostic SQLSTATE: psycopg3 exposes `sqlstate`, psycopg2 `pgcode`."""
    orig = getattr(exc, "orig", None)
    return getattr(orig, "sqlstate", None) or getattr(orig, "pgcode", None)


def init_db() -> None:
    """Create tables under an advisory lock so concurrent replicas cannot race.

    `create_all` runs in its own transaction. Postgres aborts a whole transaction
    on the first error, so bundling schema creation with anything else means a
    late failure silently rolls back the tables and leaves an API that still
    passes readiness with no schema at all.
    """
    engine = get_engine()
    with engine.connect() as conn:
        conn.execute(text("SET lock_timeout = '120s'"))
        conn.execute(text("SELECT pg_advisory_lock(:k)"), {"k": _INIT_LOCK_KEY})
        # Close the transaction SQLAlchemy 2.0 autobegan on that first execute, so
        # create_all can open its own. Committing here does NOT drop the lock:
        # pg_advisory_lock is SESSION-level, held by the connection rather than the
        # transaction, which is the same property that makes a crashed pod release
        # the GPU mutex for free.
        conn.commit()
        try:
            Base.metadata.create_all(bind=conn)
            conn.commit()
            conn.execute(text(
                "CREATE TABLE IF NOT EXISTS schema_migrations ("
                " id VARCHAR(64) PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())"
            ))
            conn.commit()
            done = {r[0] for r in conn.execute(text("SELECT id FROM schema_migrations")).all()}
            for mid, stmt in _MIGRATIONS:
                if mid in done:
                    continue
                try:
                    conn.execute(text(stmt))
                    conn.execute(text("INSERT INTO schema_migrations (id) VALUES (:i)"), {"i": mid})
                    conn.commit()
                    log.info("applied migration %s", mid)
                except Exception as exc:  # noqa: BLE001
                    conn.rollback()
                    if _sqlstate(exc) in _ALREADY_EXISTS:
                        conn.execute(text("INSERT INTO schema_migrations (id) VALUES (:i)"), {"i": mid})
                        conn.commit()
                        log.info("migration %s already present", mid)
                    else:
                        raise
            seed_plans(conn)
            conn.commit()
            _bootstrap_tenants(conn)
            conn.commit()
            log.info("schema ready (%d migration(s) recorded)", len(_MIGRATIONS))
        finally:
            # Roll back before unlocking. If anything above failed, the transaction
            # is aborted and Postgres rejects every further statement -- including
            # this unlock -- so the release would raise InFailedSqlTransaction and
            # REPLACE the real exception with a meaningless one. The advisory lock
            # is session-level, so a rollback does not drop it.
            conn.rollback()
            conn.execute(text("SELECT pg_advisory_unlock(:k)"), {"k": _INIT_LOCK_KEY})
            conn.commit()


def _bootstrap_tenants(conn) -> None:
    """Give the pre-accounts world an owner, and the demo cases theirs.

    Two system tenants, both idempotent:

    * `legacy` owns every job that existed before `jobs.tenant_id` did. Without it
      those rows are invisible to a filtered query, which would look exactly like
      data loss.
    * `examples` owns the seeded demo cases. They are readable by any signed-in
      user via `is_example`, so their owner only has to be *somebody*; making it a
      real tenant means the file paths and the retention sweep need no special case.
    """
    for kind, name in ((TENANT_LEGACY, "Legacy (pre-accounts)"),
                       (TENANT_EXAMPLES, "Example cases")):
        # `:kind_in` and `:kind_cmp` are the SAME value bound twice on purpose.
        # Binding one parameter both as an inserted VARCHAR(16) and in a comparison
        # raises `AmbiguousParameter: text versus character varying` -- Postgres
        # will not infer one type for it. This is the identical trap
        # `worker/jobs.py::finish_failure` documents, and it raised here inside
        # init_db, which is a startup crash rather than a job failure.
        conn.execute(text(
            "INSERT INTO tenants (id, name, kind) "
            "SELECT gen_random_uuid(), :n, :kind_in "
            "WHERE NOT EXISTS (SELECT 1 FROM tenants WHERE kind = :kind_cmp)"
        ), {"n": name, "kind_in": kind, "kind_cmp": kind})

    ids = {
        row[0]: row[1] for row in conn.execute(text(
            "SELECT kind, id FROM tenants WHERE kind IN (:l, :e)"
        ), {"l": TENANT_LEGACY, "e": TENANT_EXAMPLES}).all()
    }
    legacy, examples = ids.get(TENANT_LEGACY), ids.get(TENANT_EXAMPLES)
    if not legacy or not examples:
        raise RuntimeError("system tenants missing after bootstrap")

    res = conn.execute(text(
        "UPDATE jobs SET tenant_id = :e WHERE tenant_id IS NULL AND is_example = 1"
    ), {"e": examples})
    adopted_examples = res.rowcount or 0
    res = conn.execute(text(
        "UPDATE jobs SET tenant_id = :l WHERE tenant_id IS NULL"
    ), {"l": legacy})
    adopted_legacy = res.rowcount or 0
    if adopted_examples or adopted_legacy:
        log.info("adopted %d example and %d pre-accounts job(s)",
                 adopted_examples, adopted_legacy)


def system_tenant(session, kind: str) -> str | None:
    """`::text` deliberately -- see dentistry.auth.Caller. A raw query returns a
    `uuid.UUID` where the ORM returns a `str`, and comparing the two is silently
    always unequal."""
    row = session.execute(
        text("SELECT id::text FROM tenants WHERE kind = :k LIMIT 1"), {"k": kind}
    ).first()
    return row[0] if row else None
