"""Pre-compress the artifacts nginx will serve, once, at job time.

Measured on a real case: `image.raw` is 6.9 MB and gzips to 3.4 MB (49.7%), and
`labels.raw` is 6.9 MB and gzips to **137 KB (2.0%)** -- a label map is mostly long
runs of the same byte. Doing it here rather than per request turns a repeated CPU
cost into a one-off, and lets nginx serve the `.gz` directly.

JPEG tiles are NOT compressed: they are already entropy-coded and gzip makes them
very slightly larger for real CPU.
"""
from __future__ import annotations

import gzip
import hashlib
import logging
from pathlib import Path

log = logging.getLogger(__name__)

COMPRESSIBLE = (".raw", ".json", ".msh")
# Buffered writes to the root filesystem on this box run at ~7 MB/s, so gzipping a
# file nothing fetches is minutes of job time for nothing.
#
# The predicate below skips ONLY `planning/**/*.raw` -- the measurement pack, which the
# API reads through a memory map and never serves (api/routes/files.py refuses it).
# `planning/arch.json` and the cross-section contours ARE served and ARE gzipped, which
# is why the suffix test is part of the condition rather than the prefix alone.
SKIP_PREFIXES = ("planning/",)
MIN_BYTES = 1024


def bake(root: Path) -> dict:
    root = Path(root)
    files: dict[str, dict] = {}
    n = 0
    raw_bytes = gz_bytes = 0
    for p in sorted(root.rglob("*")):
        if not p.is_file() or p.suffix == ".gz":
            continue
        rel = p.relative_to(root).as_posix()
        digest = hashlib.sha256(p.read_bytes()).hexdigest()
        size = p.stat().st_size
        entry = {"sha": digest[:16], "bytes": size}
        if (p.suffix in COMPRESSIBLE and size >= MIN_BYTES
                and not any(rel.startswith(s) and p.suffix == ".raw"
                            for s in SKIP_PREFIXES)):
            blob = gzip.compress(p.read_bytes(), 9)
            (p.parent / (p.name + ".gz")).write_bytes(blob)
            entry["gz"] = len(blob)
            n += 1
            raw_bytes += size
            gz_bytes += len(blob)
        files[rel] = entry
    return {"files": files, "precompressed": n,
            "precompressed_bytes": raw_bytes, "precompressed_gzip_bytes": gz_bytes}
