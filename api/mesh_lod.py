"""The headset's `vr` mesh tier: a lighter copy of the three structures that dominate a
case's triangle count, computed on first request and cached beside the source.

WHY IT EXISTS. The worker's `decimate()` returns its input unchanged when
`fast_simplification` is not installed ("a missing optional dependency must cost detail,
never the mesh"), and three cases were baked exactly that way: e9d0c06b ships a
616k-triangle mandible, a 394k "maxilla" (DentalSegmentator class 1, which on that scan is
the whole cranium) and a 261k pharynx -- 1.95M triangles in all, while its own export
manifest advertises a 90k/60k budget. A browser copes; a Quest 3 rendering it twice, once
per eye, at 72 Hz does not. There is no worker deployment to re-bake them, so the API
derives the tier itself, once per structure, and every later request is a file read.

WHAT IT IS NOT. Nothing is measured on these meshes: every graded number comes from
POST /measure on the full-resolution field, and teeth and canals -- the structures a
clearance is measured against -- are never decimated here. scripts/measure_vr_lod.py
measures how far the surface moves (bounds in P95_BOUND_MM, against a segmentation error
floor of 0.34 mm p95 for teeth; measured 2026-09-22: jaws p95 0.011 mm, max 0.33 mm), and
the child re-checks surface area and extent on every derivation and refuses to publish a
copy that drifted.

NUMPY-FREE. The API image carries no numpy (see Dockerfile.api); the arithmetic lives in
`api.lod_child`, run as a SUBPROCESS -- fast_simplification's bindings hold the GIL and keep
the mesh in C++ globals, so in-process it would stall the event loop and race between
threads. This module only reads a 16-byte header, checks a sidecar, takes a lock and waits.
"""
from __future__ import annotations

import fcntl
import json
import logging
import re
import struct
import subprocess
import sys
from pathlib import Path

log = logging.getLogger(__name__)

#: Bump to invalidate every cached copy (a budget or an algorithm change).
#: 2: the guard checks surface area, not volume (volume is undefined on an open surface).
LOD_VERSION = 2

#: Triangle budget per structure. Everything absent from this table is served untouched.
BUDGETS = {"mandible": 90_000, "maxilla": 90_000, "pharynx": 30_000}

#: A source within this factor of its budget is served as is.
SLACK = 1.1

#: fast_simplification's aggressiveness; 7 is its default.
AGGRESSION = 7

#: The surface-deviation bound scripts/measure_vr_lod.py holds each structure to (mm, p95).
P95_BOUND_MM = {"mandible": 0.05, "maxilla": 0.05, "pharynx": 0.25}

#: The runtime guard in the child: largest relative SURFACE AREA change and extent shift
#: allowed. Area, because these surfaces are open where the field of view cuts them, and an
#: open surface has no volume to preserve. Measured drift on the three undecimated cases is
#: under 0.05%.
MAX_AREA_DRIFT = {"mandible": 0.01, "maxilla": 0.01, "pharynx": 0.02}
MAX_BBOX_SHIFT_MM = 0.2

CHILD_TIMEOUT_S = 120

_SID = re.compile(r"^mesh/([a-z0-9_]+)\.msh$")


def triangles(path: Path) -> int | None:
    """Triangle count from a DSVM header, or None if it is not one."""
    try:
        with path.open("rb") as fh:
            head = fh.read(16)
    except OSError:
        return None
    if len(head) < 16 or head[:4] != b"DSVM":
        return None
    return struct.unpack_from("<III", head, 4)[2]


def _source_stamp(target: Path) -> dict:
    st = target.stat()
    return {"size": st.st_size, "mtime_ns": st.st_mtime_ns}


def _read_sidecar(sidecar: Path) -> dict | None:
    try:
        return json.loads(sidecar.read_text())
    except (OSError, ValueError):
        return None


def _fresh(meta: dict | None, target: Path, budget: int, out: Path) -> str | None:
    """'ok' / 'failed' when the cache is current for this source and budget, else None."""
    if not meta:
        return None
    if meta.get("lod_version") != LOD_VERSION or meta.get("budget") != budget:
        return None
    if meta.get("source") != _source_stamp(target):
        return None
    if meta.get("failed"):
        return "failed"
    return "ok" if out.is_file() else None


def resolve_vr(root: Path, path: str, target: Path) -> tuple[Path, str, int | None]:
    """The file to serve for `?lod=vr`: (path, 'vr' | 'full', triangle count).

    Always returns SOMETHING servable: a structure outside the table, one already under
    budget, or a derivation that failed or was refused all answer with the full file, and
    say so in the tier. A failure is logged at ERROR -- a silent fallback to 616k triangles
    is the very thing this module exists to prevent.
    """
    m = _SID.match(path)
    if not m or m.group(1) not in BUDGETS:
        return target, "full", None
    sid = m.group(1)
    budget = BUDGETS[sid]

    n_src = triangles(target)
    if n_src is None or n_src <= budget * SLACK:
        return target, "full", n_src

    out_dir = root / "mesh-vr"
    out = out_dir / f"{sid}.msh"
    sidecar = out_dir / f"{sid}.json"

    state = _fresh(_read_sidecar(sidecar), target, budget, out)
    if state == "ok":
        return out, "vr", triangles(out)
    if state == "failed":
        return target, "full", n_src

    try:
        out_dir.mkdir(exist_ok=True)
        # One lock per output (another request, or the other uvicorn worker, may be deriving
        # the same file), then one per pod so only one simplifier runs at a time.
        with (out_dir / f"{sid}.lock").open("a+") as own:
            fcntl.flock(own, fcntl.LOCK_EX)
            state = _fresh(_read_sidecar(sidecar), target, budget, out)
            if state is None:
                with open("/tmp/dentistry-lod.lock", "a+") as pod:
                    fcntl.flock(pod, fcntl.LOCK_EX)
                    _derive(sid, target, out, sidecar, budget)
                state = _fresh(_read_sidecar(sidecar), target, budget, out)
    except (OSError, subprocess.SubprocessError) as exc:
        log.error("vr tier for %s could not be derived (%s); serving %d triangles",
                  target, exc, n_src)
        return target, "full", n_src

    if state == "ok":
        return out, "vr", triangles(out)
    meta = _read_sidecar(sidecar) or {}
    log.error("vr tier for %s refused: %s; serving %d triangles",
              target, meta.get("failed", "no sidecar"), n_src)
    return target, "full", n_src


def _derive(sid: str, target: Path, out: Path, sidecar: Path, budget: int) -> None:
    cmd = [sys.executable, "-m", "api.lod_child",
           "--sid", sid, "--source", str(target), "--out", str(out), "--sidecar", str(sidecar),
           "--budget", str(budget), "--lod-version", str(LOD_VERSION),
           "--agg", str(AGGRESSION),
           "--max-area-drift", str(MAX_AREA_DRIFT.get(sid, 0.01)),
           "--max-bbox-shift", str(MAX_BBOX_SHIFT_MM)]
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=CHILD_TIMEOUT_S,
                       cwd=str(Path(__file__).resolve().parent.parent))
    tail = (r.stdout + r.stderr).strip()[-400:]
    if r.returncode == 0:
        log.info("vr tier derived: %s", tail)
    else:
        log.error("vr tier child exited %d: %s", r.returncode, tail)
