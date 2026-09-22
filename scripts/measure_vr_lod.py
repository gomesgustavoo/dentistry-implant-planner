"""How far does the headset's `vr` mesh tier move the anatomy?

The Quest client asks for `mesh/<id>.msh?lod=vr`, which decimates the three structures
that dominate a case's triangle count (mandible, maxilla -- DentalSegmentator's class 1,
which on some scans is the whole cranium -- and the pharynx) to fixed budgets. Nothing is
ever MEASURED on these meshes -- every graded number comes from POST /measure on the
full-resolution field -- but a display surface that visibly moves a crest or a canal wall
would still mislead, so the bound has to be measured, not assumed.

Reports, per structure, the distance from every ORIGINAL vertex to the decimated surface
and from every decimated vertex to the original surface (so a spike in either direction
shows), as mean / p95 / max in millimetres, against the segmentation's own error floor
(teeth p95 0.34 mm, left IAC 0.46 mm).

    ./venv/bin/python scripts/measure_vr_lod.py <results-dir> [<results-dir> ...]
"""
from __future__ import annotations

import struct
import sys
import time
from pathlib import Path

import numpy as np
from scipy.spatial import cKDTree

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from api import mesh_lod  # noqa: E402  - the budgets the API actually applies

K_CANDIDATES = 24


def read_dsvm(path: Path):
    b = path.read_bytes()
    if b[:4] != b"DSVM":
        raise ValueError(f"{path}: not DSVM")
    _ver, n_pts, n_tri = struct.unpack_from("<III", b, 4)
    pts = np.frombuffer(b, dtype="<f4", count=n_pts * 3, offset=16).reshape(n_pts, 3)
    tri = np.frombuffer(b, dtype="<u4", count=n_tri * 3, offset=16 + n_pts * 12).reshape(n_tri, 3)
    return pts.astype(np.float64), tri.astype(np.int64)


def point_triangle_distance(p, a, b, c):
    """Exact distance from points p (n,3) to triangles (a,b,c) (n,3 each). Ericson 5.1.5."""
    ab, ac, ap = b - a, c - a, p - a
    d1 = np.einsum("ij,ij->i", ab, ap)
    d2 = np.einsum("ij,ij->i", ac, ap)
    bp = p - b
    d3 = np.einsum("ij,ij->i", ab, bp)
    d4 = np.einsum("ij,ij->i", ac, bp)
    cp = p - c
    d5 = np.einsum("ij,ij->i", ab, cp)
    d6 = np.einsum("ij,ij->i", ac, cp)
    vc = d1 * d4 - d3 * d2
    vb = d5 * d2 - d1 * d6
    va = d3 * d6 - d5 * d4

    closest = np.empty_like(p)
    # Face region by default.
    denom = va + vb + vc
    denom = np.where(np.abs(denom) < 1e-30, 1e-30, denom)
    v = vb / denom
    w = vc / denom
    closest[:] = a + ab * v[:, None] + ac * w[:, None]

    def put(mask, value):
        closest[mask] = value[mask] if value.ndim == 2 else value

    m = (va <= 0) & ((d4 - d3) >= 0) & ((d5 - d6) >= 0)
    t = np.where(m, (d4 - d3) / np.maximum((d4 - d3) + (d5 - d6), 1e-30), 0)
    put(m, b + (c - b) * t[:, None])
    m = (vb <= 0) & (d2 >= 0) & (d6 <= 0)
    t = np.where(m, d2 / np.maximum(d2 - d6, 1e-30), 0)
    put(m, a + ac * t[:, None])
    m = (vc <= 0) & (d1 >= 0) & (d3 <= 0)
    t = np.where(m, d1 / np.maximum(d1 - d3, 1e-30), 0)
    put(m, a + ab * t[:, None])
    put((d6 >= 0) & (d5 <= d6), c)
    put((d3 >= 0) & (d4 <= d3), b)
    put((d1 <= 0) & (d2 <= 0), a)
    return np.linalg.norm(p - closest, axis=1)


def distances(points, verts, tris):
    """Distance from each point to the surface (verts, tris), via centroid candidates."""
    cent = verts[tris].mean(axis=1)
    tree = cKDTree(cent)
    _, idx = tree.query(points, k=K_CANDIDATES)
    best = np.full(len(points), np.inf)
    for k in range(K_CANDIDATES):
        t = tris[idx[:, k]]
        d = point_triangle_distance(points, verts[t[:, 0]], verts[t[:, 1]], verts[t[:, 2]])
        best = np.minimum(best, d)
    return best


def summary(d):
    return f"mean {d.mean():.4f}  p95 {np.percentile(d, 95):.4f}  max {d.max():.4f} mm"


def main(dirs):
    import fast_simplification

    ok = True
    for rd in map(Path, dirs):
        print(f"== {rd.name}")
        for sid, budget in mesh_lod.BUDGETS.items():
            src = rd / "mesh" / f"{sid}.msh"
            if not src.is_file():
                continue
            v, f = read_dsvm(src)
            if len(f) <= budget * mesh_lod.SLACK:
                print(f"  {sid:10s} {len(f):>8,} tris  <= budget, served as is")
                continue
            t0 = time.time()
            dv, df = fast_simplification.simplify(v.astype(np.float32), f.astype(np.int32),
                                                  1.0 - budget / len(f), agg=mesh_lod.AGGRESSION)
            dv = np.asarray(dv, dtype=np.float64)
            df = np.asarray(df, dtype=np.int64)
            dt = time.time() - t0
            fwd = distances(v, dv, df)
            back = distances(dv, v, f)
            bound = mesh_lod.P95_BOUND_MM.get(sid, 0.05)
            passed = np.percentile(fwd, 95) <= bound and np.percentile(back, 95) <= bound
            ok &= passed
            print(f"  {sid:10s} {len(f):>8,} -> {len(df):>7,} tris in {dt:.1f}s  "
                  f"{'OK  ' if passed else 'OVER'} (p95 bound {bound} mm)")
            print(f"      original->vr  {summary(fwd)}")
            print(f"      vr->original  {summary(back)}")
    print("ALL WITHIN BOUND" if ok else "SOME STRUCTURES EXCEED THEIR BOUND")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
