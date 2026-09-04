"""Smooth, decimated surfaces: the STL downloads and the viewer's 3D geometry.

Two outputs from one surface, deliberately. The STL is what a user opens in a
planning package; the `.msh` is a stripped binary the browser parses directly. They
come from the same marching-cubes run on the same smoothed indicator at the same
iso level as `worker/contours.py`, so the curve on a slice, the surface in 3D and
the contour in the RTSTRUCT are the same object described three ways.

Vertices are emitted in **patient LPS millimetres**, which is the frame the
RTSTRUCT, the arch curve and the viewer all already speak. Index space is never
exported: it means nothing outside this process.

The browser format (`DSVM`) is deliberately trivial -- a header and two arrays --
because it is parsed by hand in `viewer/src/index.js` and a format that needs a
library on the far side is a format that will drift:

    magic  'DSVM'          4 bytes
    u32    version         1
    u32    n_points
    u32    n_triangles
    f32    xyz * n_points  LPS mm
    u32    idx * 3 * n_tri
    little-endian throughout
"""
from __future__ import annotations

import logging
import struct
from pathlib import Path

import numpy as np

from worker import smooth

log = logging.getLogger(__name__)

TAUBIN_ITERATIONS = 12
TAUBIN_LAMBDA = 0.5
TAUBIN_MU = -0.53          # |mu| > lambda is what makes Taubin volume-preserving
STL_TRIANGLE_BUDGET = 200_000
WEB_TRIANGLE_BUDGET = 60_000
WEB_TRIANGLE_BUDGET_JAW = 90_000
MESH_MAGIC = b"DSVM"
MESH_VERSION = 1


def _index_to_lps(image):
    origin = np.asarray(image.GetOrigin(), dtype=np.float64)
    d = np.asarray(image.GetDirection(), dtype=np.float64).reshape(3, 3)
    spacing = np.asarray(image.GetSpacing(), dtype=np.float64)
    return origin, d * spacing[np.newaxis, :]


def _adjacency(faces: np.ndarray, n_verts: int):
    """Row-normalised vertex adjacency, as a sparse operator."""
    from scipy import sparse

    e = np.vstack([faces[:, [0, 1]], faces[:, [1, 2]], faces[:, [2, 0]]])
    e = np.vstack([e, e[:, ::-1]])
    data = np.ones(len(e), dtype=np.float32)
    a = sparse.coo_matrix((data, (e[:, 0], e[:, 1])), shape=(n_verts, n_verts)).tocsr()
    a.data[:] = 1.0
    deg = np.asarray(a.sum(axis=1)).ravel()
    deg[deg == 0] = 1.0
    return sparse.diags(1.0 / deg) @ a


def taubin_smooth(verts: np.ndarray, faces: np.ndarray,
                  iterations: int = TAUBIN_ITERATIONS,
                  lam: float = TAUBIN_LAMBDA, mu: float = TAUBIN_MU) -> np.ndarray:
    """Volume-preserving mesh smoothing.

    Point count and order are unchanged, so the face array stays valid -- which is
    what lets the same faces be reused for the STL and the decimated web copy.
    Laplacian smoothing alone shrinks a closed surface; alternating a positive and
    a slightly larger negative step does not, which matters when the number the
    user reads off the result is a volume.
    """
    if len(faces) == 0:
        return verts
    a = _adjacency(faces, len(verts))
    v = verts.astype(np.float32, copy=True)
    for i in range(iterations):
        step = lam if i % 2 == 0 else mu
        v += step * (a @ v - v)
    return v


def mesh_volume_mm3(verts: np.ndarray, faces: np.ndarray) -> float:
    """Signed volume by the divergence theorem.

    A cheap check that decimation did not tear the surface open: a holed mesh
    reports a nonsense volume, and comparing it against the voxel count is how a
    torn surface is caught before it reaches a download.
    """
    if len(faces) == 0:
        return 0.0
    a, b, c = verts[faces[:, 0]], verts[faces[:, 1]], verts[faces[:, 2]]
    return float(np.abs(np.einsum("ij,ij->i", a, np.cross(b, c)).sum()) / 6.0)


def decimate(verts: np.ndarray, faces: np.ndarray, max_triangles: int):
    """Quadric edge collapse down to `max_triangles`.

    Returns the input unchanged if it is already small enough, or if no simplifier
    is available -- a missing optional dependency must cost detail, never the mesh.
    """
    if len(faces) <= max_triangles:
        return verts, faces
    try:
        import fast_simplification
    except ImportError:
        log.info("fast_simplification not installed -- shipping %d triangles undecimated",
                 len(faces))
        return verts, faces
    keep = max_triangles / len(faces)
    v, f = fast_simplification.simplify(verts.astype(np.float32),
                                        faces.astype(np.int32), 1.0 - keep)
    return np.asarray(v, dtype=np.float32), np.asarray(f, dtype=np.int64)


def mesh_structure(merged: np.ndarray, index: int, image, spacing_zyx,
                   sigma_mm: float | None = None):
    """`(verts_lps, faces, info)` for one structure, or `(None, None, info)`.

    Meshed inside the structure's own bounding box with a one-voxel pad, never over
    the whole volume: a tooth is a few thousand voxels inside a 45-million-voxel
    scan, and marching cubes over the whole array 47 times is minutes of CPU for
    the same answer.
    """
    from skimage import measure

    mask = merged == index
    info: dict = {"voxels": int(mask.sum())}
    if not info["voxels"]:
        return None, None, info
    w = np.argwhere(mask)
    lo = np.maximum(w.min(0) - 1, 0)
    hi = np.minimum(w.max(0) + 2, np.array(mask.shape))
    sub = mask[lo[0]:hi[0], lo[1]:hi[1], lo[2]:hi[2]]
    field = smooth.indicator(sub, spacing_zyx, sigma_mm)
    if field.max() < smooth.ISO:
        # Too thin to survive its own blur. Fall back to the unsmoothed indicator
        # rather than dropping the structure -- a rough canal beats no canal.
        field = sub.astype(np.float32)
        info["unsmoothed"] = True
    try:
        v, f, _, _ = measure.marching_cubes(field, level=smooth.ISO)
    except (ValueError, RuntimeError) as exc:
        info["error"] = f"{type(exc).__name__}: {exc}"
        return None, None, info
    v = v + lo[None, :]                                   # back to full-volume (z, y, x)
    origin, m = _index_to_lps(image)
    lps = origin[None, :] + v[:, ::-1] @ m.T              # (z,y,x) -> (x,y,z) -> LPS
    lps = taubin_smooth(lps.astype(np.float32), f)
    info["triangles"] = int(len(f))
    info["volume_mm3"] = round(mesh_volume_mm3(lps, f), 2)
    return lps, f.astype(np.int64), info


def write_stl(verts: np.ndarray, faces: np.ndarray, path: Path) -> int:
    """Binary STL. Returns bytes written."""
    n = len(faces)
    tri = verts[faces]                                    # (n, 3, 3)
    normals = np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0])
    norm = np.linalg.norm(normals, axis=1, keepdims=True)
    normals = normals / np.maximum(norm, 1e-12)
    rec = np.zeros((n, 12), dtype=np.float32)
    rec[:, 0:3] = normals
    rec[:, 3:12] = tri.reshape(n, 9)
    blob = bytearray(b"\0" * 80 + struct.pack("<I", n))
    body = np.zeros((n, 50), dtype=np.uint8)
    body[:, :48] = rec.astype("<f4").view(np.uint8).reshape(n, 48)
    blob += body.tobytes()
    path.write_bytes(bytes(blob))
    return len(blob)


def write_web_mesh(verts: np.ndarray, faces: np.ndarray, path: Path) -> int:
    """The browser's binary mesh. Returns bytes written."""
    head = MESH_MAGIC + struct.pack("<III", MESH_VERSION, len(verts), len(faces))
    blob = (head + verts.astype("<f4").tobytes()
            + faces.astype("<u4").tobytes())
    path.write_bytes(blob)
    return len(blob)


def web_budget(structure) -> int:
    """Triangle cap for the browser copy of this structure."""
    from dentistry import labels as L

    return (WEB_TRIANGLE_BUDGET_JAW
            if structure.index in (L.MERGED_MANDIBLE, L.MERGED_MAXILLA)
            else WEB_TRIANGLE_BUDGET)


def export(merged: np.ndarray, image, spacing_zyx, stl_dir: Path, web_dir: Path) -> dict:
    """Write every present structure's STL and browser mesh. Returns a manifest."""
    from dentistry import labels as L

    stl_dir.mkdir(parents=True, exist_ok=True)
    web_dir.mkdir(parents=True, exist_ok=True)
    origin, m = _index_to_lps(image)
    detail: dict = {}
    stls: dict = {}
    webs: dict = {}
    totals = {"structures": 0, "triangles": 0, "stl_bytes": 0,
              "web_structures": 0, "web_triangles": 0, "web_bytes": 0}

    for s in L.STRUCTURES:
        sigma = smooth.THIN_SIGMA_MM if s.index in L.NO_COMPONENT_FILTER else None
        v, f, info = mesh_structure(merged, s.index, image, spacing_zyx, sigma)
        if v is None:
            if info.get("voxels"):
                detail[s.id] = info
            continue
        sv, sf = decimate(v, f, STL_TRIANGLE_BUDGET)
        info["stl_file"] = f"stl/{s.id}.stl"
        info["stl_bytes"] = write_stl(sv, sf, stl_dir / f"{s.id}.stl")
        wv, wf = decimate(v, f, web_budget(s))
        info["web_file"] = f"mesh/{s.id}.msh"
        info["web_triangles"] = int(len(wf))
        info["web_bytes"] = write_web_mesh(wv, wf, web_dir / f"{s.id}.msh")
        detail[s.id] = info
        stls[s.id] = info["stl_file"]
        webs[s.id] = info["web_file"]
        totals["structures"] += 1
        totals["triangles"] += int(len(sf))
        totals["stl_bytes"] += info["stl_bytes"]
        totals["web_structures"] += 1
        totals["web_triangles"] += info["web_triangles"]
        totals["web_bytes"] += info["web_bytes"]

    return {
        "frame": {"space": "LPS", "origin": [round(float(x), 4) for x in origin],
                  "direction": [round(float(x), 6) for x in m.flatten()],
                  "spacing_zyx": [round(float(x), 5) for x in spacing_zyx],
                  "units": "mm"},
        "taubin": {"iterations": TAUBIN_ITERATIONS, "lambda": TAUBIN_LAMBDA,
                   "mu": TAUBIN_MU},
        "stl_triangle_budget": STL_TRIANGLE_BUDGET,
        "web_triangle_budget": {"default": WEB_TRIANGLE_BUDGET,
                                "jaws": WEB_TRIANGLE_BUDGET_JAW},
        "web_mesh_format": {"magic": "DSVM", "version": MESH_VERSION,
                            "layout": "u32 version, u32 n_points, u32 n_tris, "
                                      "f32[3n] xyz LPS mm, u32[3m] indices",
                            "endian": "little"},
        "detail": detail, "totals": totals,
    }, stls, webs
