"""Delete what we said we would delete, when we said we would.

The upload is removed as soon as its result exists -- the promise is that the
original scan does not sit on this box any longer than it takes to segment it.
Results follow a separate, longer window; the row and its report survive, so a job
whose files have expired still renders, with its downloads gone and said so.
"""
from __future__ import annotations

import logging
import shutil
import time
from pathlib import Path

log = logging.getLogger(__name__)

RESULT_TTL_HOURS = 72


def purge_upload(path: Path) -> int:
    """Remove one job's upload. Returns bytes freed."""
    path = Path(path)
    if not path.exists():
        return 0
    total = sum(p.stat().st_size for p in path.rglob("*") if p.is_file())
    shutil.rmtree(path, ignore_errors=True)
    return total


def purge_expired_results(root: Path, ttl_hours: float = RESULT_TTL_HOURS) -> dict:
    root = Path(root)
    if not root.exists():
        return {"removed": 0, "bytes": 0}
    cutoff = time.time() - ttl_hours * 3600
    removed = freed = 0
    for job in root.iterdir():
        if not job.is_dir() or job.stat().st_mtime >= cutoff:
            continue
        freed += sum(p.stat().st_size for p in job.rglob("*") if p.is_file())
        shutil.rmtree(job, ignore_errors=True)
        removed += 1
    return {"removed": removed, "bytes": freed}
