"""Derive one `vr` tier mesh. Run by api.mesh_lod as a subprocess -- the only module on the
API's side that imports numpy -- so the simplifier's GIL hold and C++ global state never
touch the server process. See api/mesh_lod.py for why the tier exists.

Writes, in order, a DSVM v1 copy (the unchanged browser format, so no client reader
changes), its gzip twin for the files route's gzip_static path, and a sidecar recording
what it was derived from. The sidecar goes LAST and every file is written to a temporary
name and renamed, so a reader can never see a half-written tier or a sidecar vouching for
a mesh that is not there yet.

Exit 0: derived and published. Exit 3: derived and REFUSED by the guard (a failure
sidecar is written, and the API keeps serving the full mesh). Anything else: an error.
"""
from __future__ import annotations

import argparse
import gzip
import json
import os
import struct
import sys
import time
from pathlib import Path

import numpy as np


def read_dsvm(path: Path):
    b = path.read_bytes()
    if b[:4] != b"DSVM":
        raise ValueError(f"{path}: not a DSVM mesh")
    _ver, n_pts, n_tri = struct.unpack_from("<III", b, 4)
    pts = np.frombuffer(b, dtype="<f4", count=n_pts * 3, offset=16).reshape(n_pts, 3)
    tri = np.frombuffer(b, dtype="<u4", count=n_tri * 3, offset=16 + n_pts * 12).reshape(n_tri, 3)
    return pts, tri


def dsvm_bytes(pts: np.ndarray, tri: np.ndarray) -> bytes:
    head = b"DSVM" + struct.pack("<III", 1, len(pts), len(tri))
    return head + pts.astype("<f4").tobytes() + tri.astype("<u4").tobytes()


def volume_mm3(pts: np.ndarray, tri: np.ndarray) -> float:
    """Signed volume by the divergence theorem, the same measure the worker reports."""
    p = pts.astype(np.float64)
    a, b, c = p[tri[:, 0]], p[tri[:, 1]], p[tri[:, 2]]
    return float(np.einsum("ij,ij->i", a, np.cross(b, c)).sum() / 6.0)


def area_mm2(pts: np.ndarray, tri: np.ndarray) -> float:
    p = pts.astype(np.float64)
    return float(np.linalg.norm(np.cross(p[tri[:, 1]] - p[tri[:, 0]], p[tri[:, 2]] - p[tri[:, 0]]),
                                axis=1).sum() / 2.0)


def write_atomic(path: Path, data: bytes) -> None:
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_bytes(data)
    os.replace(tmp, path)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--sid", required=True)
    ap.add_argument("--source", required=True, type=Path)
    ap.add_argument("--out", required=True, type=Path)
    ap.add_argument("--sidecar", required=True, type=Path)
    ap.add_argument("--budget", required=True, type=int)
    ap.add_argument("--lod-version", required=True, type=int)
    ap.add_argument("--agg", type=int, default=7)
    ap.add_argument("--max-area-drift", type=float, default=0.01)
    ap.add_argument("--max-bbox-shift", type=float, default=0.2)
    a = ap.parse_args()

    import fast_simplification

    t0 = time.time()
    st = a.source.stat()
    meta = {
        "lod_version": a.lod_version,
        "budget": a.budget,
        "agg": a.agg,
        "source": {"size": st.st_size, "mtime_ns": st.st_mtime_ns},
    }

    pts, tri = read_dsvm(a.source)
    meta["source_triangles"] = int(len(tri))
    reduction = max(0.0, 1.0 - a.budget / max(len(tri), 1))
    dv, df = fast_simplification.simplify(np.ascontiguousarray(pts, dtype=np.float32),
                                          np.ascontiguousarray(tri, dtype=np.int32),
                                          reduction, agg=a.agg)
    dv = np.asarray(dv, dtype=np.float32)
    df = np.asarray(df, dtype=np.int64)

    # SURFACE AREA, not volume, is the guard. These surfaces are OPEN - the scan's field of
    # view cuts the jaws and the pharynx, leaving hundreds of boundary edges - and the
    # divergence-theorem volume of an open surface depends on where the origin is: the
    # cranium on one case came out at 4,227 mm3 and on another NEGATIVE, and a 0.01 mm p95
    # decimation "drifted" it by 1.2%. Area is well defined open or closed. The volume is
    # still recorded, about the mesh's own centroid, for information only.
    a0, a1 = area_mm2(pts, tri), area_mm2(dv, df)
    drift = abs(a1 - a0) / max(a0, 1e-9)
    c = pts.astype(np.float64).mean(0)
    v0, v1 = volume_mm3(pts - c, tri), volume_mm3(dv - c, df)
    shift = float(np.max(np.abs(np.concatenate([pts.min(0) - dv.min(0), pts.max(0) - dv.max(0)]))))
    meta.update({
        "triangles": int(len(df)),
        "area_ratio": round(a1 / a0, 6) if a0 else None,
        "centred_volume_ratio": round(v1 / v0, 6) if v0 else None,
        "bbox_delta_mm": round(shift, 4),
        "elapsed_s": round(time.time() - t0, 2),
    })

    a.out.parent.mkdir(parents=True, exist_ok=True)
    refused = None
    if len(df) == 0:
        refused = "simplifier returned an empty mesh"
    elif drift > a.max_area_drift:
        refused = f"surface area drifted {drift:.4%} (limit {a.max_area_drift:.2%})"
    elif shift > a.max_bbox_shift:
        refused = f"extent moved {shift:.3f} mm (limit {a.max_bbox_shift} mm)"

    if refused:
        meta["failed"] = refused
        write_atomic(a.sidecar, json.dumps(meta).encode())
        print(f"{a.sid}: REFUSED - {refused}")
        return 3

    blob = dsvm_bytes(dv, df)
    write_atomic(a.out, blob)
    gz = a.out.with_name(a.out.name + ".gz")
    write_atomic(gz, gzip.compress(blob, compresslevel=6, mtime=0))
    write_atomic(a.sidecar, json.dumps(meta).encode())
    print(f"{a.sid}: {len(tri)} -> {len(df)} triangles, area x{meta['area_ratio']}, "
          f"extent {shift:.3f} mm, {meta['elapsed_s']} s")
    return 0


if __name__ == "__main__":
    sys.exit(main())
