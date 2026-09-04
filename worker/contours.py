"""Slice contours as polygons, and the ONE row-orientation table.

The display overlay is vector rather than raster so it can be drawn crisply at any
zoom, and so the curve on screen is provably the same geometry as the STL and the
RTSTRUCT -- all three come from `worker/smooth.indicator` at the same iso level.

`PLANE_FLIP_ROWS` lives here and is imported by `worker/preview.py`, which is the
whole point of putting it in one place. It used to be duplicated: the tile renderer
flipped coronal and sagittal rows "so superior is up", and this module flipped its
polygons to match. Both were wrong in the same direction, so every consistency
check between them passed while the mandible was drawn ABOVE the maxilla in every
coronal and sagittal tile the service had ever served. Measured at the time:
mandible at rows 42-102, maxilla at 127-322.

Every entry is False, and that is the correction. The canonical frame is RPI, so
the z index already increases INFERIORLY and row 0 of a coronal or sagittal cut is
already the superior end. A comment saying "these must agree" did not prevent the
bug; sharing the table does.
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np

from worker import smooth

PLANE_FLIP_ROWS = {"axial": False, "coronal": False, "sagittal": False}

TOLERANCE_VOX = 0.35       # Douglas-Peucker simplification, in voxels
MIN_AREA_MM2 = 0.12        # a polygon smaller than this is a speck, not a structure


def plane_polygons(plane: np.ndarray, tol_vox: float, row_mm: float, col_mm: float,
                   sigma_mm: float | None = None):
    """Closed polygons for one 2D label slice, as `{index: [[[r, c], ...], ...]}`."""
    from skimage import measure

    out: dict[int, list] = {}
    for v in (int(x) for x in np.unique(plane) if x):
        mask = plane == v
        # Filtered IN THE PLANE. The old call added a length-1 z axis and a dummy 1.0
        # spacing, which made `mode="constant"` bleed the slice into zero padding: every
        # contour this module has ever drawn sat 0.061 mm inside the truth, measured on
        # an analytic 3.00 mm disc at the cross-section pitch.
        field = smooth.indicator(mask, (row_mm, col_mm), sigma_mm)
        if field.max() < smooth.ISO:
            field = mask.astype(np.float32)
        polys = []
        for c in measure.find_contours(field, smooth.ISO):
            c = measure.approximate_polygon(c, tolerance=tol_vox)
            if len(c) < 3:
                continue
            # Shoelace area, in mm2, to drop specks that would render as dots.
            area = 0.5 * abs(np.dot(c[:, 0], np.roll(c[:, 1], 1))
                             - np.dot(c[:, 1], np.roll(c[:, 0], 1)))
            if area * row_mm * col_mm < MIN_AREA_MM2:
                continue
            polys.append([[round(float(r), 2), round(float(cc), 2)] for r, cc in c])
        if polys:
            out[v] = polys
    return out


def export(merged: np.ndarray, spacing_zyx, preview_manifest: dict, out_dir: Path) -> dict:
    """Write `contours.<plane>.json` for exactly the slices the tiles sampled.

    The slice indices come FROM the preview manifest rather than being recomputed,
    so the overlay and the picture underneath cannot drift apart.
    """
    from dentistry import labels as L

    out_dir.mkdir(parents=True, exist_ok=True)
    files: dict[str, str] = {}
    n_poly = n_pts = n_bytes = 0
    without: dict[str, int] = {}

    thin = {s.index for s in L.STRUCTURES if s.index in L.NO_COMPONENT_FILTER}
    for plane, info in (preview_manifest.get("planes") or {}).items():
        idx = info["source_indices"]
        row_mm, col_mm = info["pixel_mm"]
        per_slice: dict[str, dict] = {}
        missing = 0
        for out_i, src_i in enumerate(idx):
            if plane == "axial":
                sl = merged[src_i]
            elif plane == "coronal":
                sl = merged[:, src_i]
            else:
                sl = merged[:, :, src_i]
            if PLANE_FLIP_ROWS[plane]:
                sl = sl[::-1]
            got: dict[int, list] = {}
            for v in (int(x) for x in np.unique(sl) if x):
                sigma = smooth.THIN_SIGMA_MM if v in thin else None
                got.update(plane_polygons((sl == v) * v, TOLERANCE_VOX, row_mm,
                                          col_mm, sigma))
            if got:
                per_slice[str(out_i)] = {str(k): v for k, v in got.items()}
                n_poly += sum(len(p) for p in got.values())
                n_pts += sum(len(q) for p in got.values() for q in p)
            elif sl.any():
                missing += 1
        # The per-slice map IS the document. `web/app.js` stores whatever this file
        # parses to and then indexes it directly -- `planeContours[String(v.index)]` --
        # so wrapping it in {"plane":..., "slices":...} (as the 2026-09-01
        # reconstruction did) makes every lookup undefined. Two silent consequences,
        # not one: no vector overlay is ever drawn, AND `jumpTiles`'s has() test is
        # always false, so clicking a tooth in the dental chart never scrubs the tile
        # view -- re-breaking by the back door the exact defect that was measured and
        # fixed once already ("slice moved 0/29 times").
        #
        # The plane is not carried in the body because it is already in the filename,
        # which is how the client asks for it. Keys are slice indices INTO
        # `source_indices`, not source slice numbers.
        blob = json.dumps(per_slice, separators=(",", ":"))
        path = out_dir / f"contours.{plane}.json"
        path.write_text(blob)
        n_bytes += len(blob)
        files[plane] = f"preview/contours.{plane}.json"
        without[plane] = missing

    return {"files": files, "tolerance_vox": TOLERANCE_VOX, "sigma_mm": smooth.DEFAULT_SIGMA_MM,
            "thin_sigma_mm": smooth.THIN_SIGMA_MM, "polygons": n_poly, "points": n_pts,
            "bytes": n_bytes, "slices_without_contour": without,
            "slices_without_contour_count": int(sum(without.values()))}
