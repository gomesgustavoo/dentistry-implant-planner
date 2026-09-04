"""Server-rendered slice tiles: the Slices tab.

JPEG rather than the raw volume because this is the DISPLAY view -- it is paired
with the vector overlay from `worker/contours.py`, and between them they give a
crisp picture at any zoom for a few hundred kilobytes.

The row-orientation table is imported from `contours.py` and never restated. See
that module for what happened when it was duplicated.
"""
from __future__ import annotations

from pathlib import Path

import numpy as np

from worker.contours import PLANE_FLIP_ROWS

# How many slices each plane's tile strip samples. The pre-deletion service shipped
# 160 and the 2026-09-01 reconstruction came back with 260; both are defensible and
# the difference is 62% more tiles, so it is recorded here as a decision rather than
# left as a drift. 260 stays: on a 0.3 mm scan of ~360 slices it samples every
# ~0.42 mm instead of every ~0.68 mm, which is what the tile view is for, and it
# costs ~8 MB of an ~89 MB case. Nothing measurable happens on these tiles -- every
# millimetre a clinician acts on is measured in the plan tab against the published
# `pixel_mm` -- so this is a browsing setting, not a precision one.
#
# `count` and `total_slices` are both published, so no client should ever hard-code
# either number.
MAX_SLICES_PER_PLANE = 260
JPEG_QUALITY = 82

# Bone/dental window: wide enough to keep enamel, cortical bone and the canal
# distinguishable in one image.
DEFAULT_WINDOW = (3000.0, 1000.0)   # width, level

PLANES = ("axial", "coronal", "sagittal")


def _window(vol: np.ndarray) -> tuple[float, float]:
    """The fixed dental window, unless the data plainly is not in Hounsfield units."""
    lo, hi = np.percentile(vol, (1.0, 99.5))
    if hi - lo < 200:                     # degenerate histogram; use the fixed window
        return DEFAULT_WINDOW
    w, l = DEFAULT_WINDOW
    fixed_lo, fixed_hi = l - w / 2, l + w / 2
    inside = float(((vol > fixed_lo) & (vol < fixed_hi)).mean())
    if inside < 0.5:
        # Most of the data sits outside the fixed window, so the scan is not in HU
        # and forcing it would render a black picture. Fit the window instead.
        return float(hi - lo), float((hi + lo) / 2)
    return DEFAULT_WINDOW


def _to_u8(sl: np.ndarray, width: float, level: float) -> np.ndarray:
    lo = level - width / 2
    out = (sl.astype(np.float32) - lo) / max(width, 1e-6)
    return (np.clip(out, 0.0, 1.0) * 255).astype(np.uint8)


def _indices(n: int) -> list[int]:
    if n <= MAX_SLICES_PER_PLANE:
        return list(range(n))
    return list(np.linspace(0, n - 1, MAX_SLICES_PER_PLANE).round().astype(int))


def render(volume: np.ndarray, merged: np.ndarray, spacing_zyx, out_dir: Path) -> dict:
    """`volume` and `merged` are (z, y, x). Returns a manifest for the UI."""
    from PIL import Image

    width, level = _window(volume)
    manifest: dict = {"window": {"width": round(width, 1), "level": round(level, 1)},
                      "planes": {}}

    for plane in PLANES:
        pdir = out_dir / plane
        pdir.mkdir(parents=True, exist_ok=True)
        if plane == "axial":
            n, take, px = volume.shape[0], (lambda i: volume[i]), (spacing_zyx[1], spacing_zyx[2])
            dims = (volume.shape[1], volume.shape[2])
        elif plane == "coronal":
            n, take, px = volume.shape[1], (lambda i: volume[:, i]), (spacing_zyx[0], spacing_zyx[2])
            dims = (volume.shape[0], volume.shape[2])
        else:
            n, take, px = volume.shape[2], (lambda i: volume[:, :, i]), (spacing_zyx[0], spacing_zyx[1])
            dims = (volume.shape[0], volume.shape[1])

        idx = _indices(n)
        for out_i, src_i in enumerate(idx):
            grey = take(src_i)
            if PLANE_FLIP_ROWS[plane]:
                grey = grey[::-1]
            Image.fromarray(_to_u8(grey, width, level)).save(
                pdir / f"{out_i:04d}.jpg", quality=JPEG_QUALITY, optimize=True)

        # `total_slices` and `size` were both dropped by the 2026-09-01 reconstruction.
        # `web/app.js` reads `info.total_slices` for the slice counter, so without it the
        # label renders "axial 137 / undefined". `size` is [rows, cols] of the 2-D slice
        # -- the SAME axis order as `pixel_mm`, which is (row_mm, col_mm) and is unpacked
        # that way by `contours.export`. `count` is how many were sampled;
        # `total_slices` is how many exist.
        manifest["planes"][plane] = {
            "size": [int(dims[0]), int(dims[1])],
            "count": len(idx),
            "total_slices": int(n),
            "source_indices": [int(i) for i in idx],
            "pixel_mm": [round(float(px[0]), 5), round(float(px[1]), 5)],
        }
    return manifest
