"""Where a job's bytes live, for both the API pod and the host worker.

One module, imported by both, for the same reason `config.py` is one class: the
API writes the upload and the worker reads it, and if the two ever disagree about
the path the failure is a job that cannot find its own input.

Layout is per tenant:

    <DATA_DIR>/tenants/<tenant_id>/{uploads,work,results}/<job_id>/

rather than the flat `<DATA_DIR>/{uploads,results,work}/<job_id>/` that predates
accounts. The point is erasure: deleting a tenant is one `rmtree` of one
directory, which is the same property the sibling services get from an S3 key
prefix (`users/{id}/...`, `u/{id}/jobs/{id}/`). It is defence in depth, not the
security boundary -- ownership is enforced in SQL, on the `jobs.tenant_id` column.

`LEGACY` is the tenant that owns everything from before accounts existed.
"""

from __future__ import annotations

import logging
import os
import shutil
from pathlib import Path

from .config import settings

log = logging.getLogger("dentistry.storage")

KINDS = ("uploads", "work", "results")
LEGACY = "legacy"


def data_root() -> Path:
    return Path(settings.DATA_DIR)


def tenant_root(tenant_id: str | None) -> Path:
    return data_root() / "tenants" / (str(tenant_id) if tenant_id else LEGACY)


def job_dir(tenant_id: str | None, kind: str, job_id: str) -> Path:
    if kind not in KINDS:
        raise ValueError(f"unknown storage kind {kind!r}")
    return tenant_root(tenant_id) / kind / job_id


def ensure_tenant(tenant_id: str | None) -> Path:
    root = tenant_root(tenant_id)
    for kind in KINDS:
        (root / kind).mkdir(parents=True, exist_ok=True)
    return root


def resolve(tenant_id: str | None, kind: str, job_id: str) -> Path:
    """The job's directory, falling back to the pre-tenant flat layout.

    The fallback is not permanent kindness -- it is what lets the API serve a job
    whose files have not been moved yet, so the migration below can be a
    best-effort background step instead of a blocking one.
    """
    new = job_dir(tenant_id, kind, job_id)
    if new.exists():
        return new
    old = data_root() / kind / job_id
    return old if old.exists() else new


def purge_tenant(tenant_id: str) -> int:
    """Erase everything a tenant owns. Returns bytes removed."""
    root = tenant_root(tenant_id)
    if not root.exists():
        return 0
    total = sum(f.stat().st_size for f in root.rglob("*") if f.is_file())
    shutil.rmtree(root, ignore_errors=True)
    log.info("purged tenant %s (%.1f MB)", tenant_id, total / 1e6)
    return total


def migrate_flat_layout(owner_of) -> dict:
    """Move `<DATA_DIR>/<kind>/<job_id>` under its tenant. Idempotent.

    `owner_of(job_id) -> tenant_id | None` comes from the caller so this module
    stays free of any DB import.

    A rename, never a copy: `data/` is one filesystem and buffered writes on this
    box run at roughly 7 MB/s, so copying 500 MB of results would take minutes and
    could not be done at startup. `os.replace` across the same device is metadata
    only.
    """
    moved = skipped = failed = 0
    for kind in KINDS:
        flat = data_root() / kind
        if not flat.is_dir():
            continue
        for entry in sorted(flat.iterdir()):
            # A tenant directory is not a job directory. The flat layout only ever
            # held 36-character uuid4 names.
            if not entry.is_dir() or len(entry.name) != 36:
                continue
            tenant = owner_of(entry.name) or LEGACY
            dest = job_dir(tenant, kind, entry.name)
            if dest.exists():
                skipped += 1
                continue
            dest.parent.mkdir(parents=True, exist_ok=True)
            try:
                os.replace(entry, dest)
                moved += 1
            except FileNotFoundError:
                # The source vanished between the listing and the move, which means
                # somebody else moved it -- `uvicorn --workers 2` runs the lifespan
                # once per worker. The caller holds an advisory lock to prevent that,
                # but a second REPLICA would race the same way, so this is checked
                # rather than assumed. It is only "done" if the destination is really
                # there; otherwise the directory genuinely disappeared and that is
                # worth a warning.
                if dest.exists():
                    skipped += 1
                else:
                    log.warning("%s/%s vanished and did not arrive at %s",
                                kind, entry.name, dest)
                    failed += 1
            except OSError as exc:
                # Most likely a cross-device link, which would mean DATA_DIR is not
                # what this module thinks it is. Report it; do not fall back to a
                # copy, because a half-copied result is worse than an unmoved one
                # and `resolve()` already reads the old location.
                log.warning("could not move %s/%s: %s", kind, entry.name, exc)
                failed += 1
    if moved or failed:
        log.info("storage migration: %d moved, %d already done, %d failed",
                 moved, skipped, failed)
    return {"moved": moved, "skipped": skipped, "failed": failed}
