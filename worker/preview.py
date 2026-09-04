"""The display window, and the per-plane geometry manifest.

THE TILES ARE GONE. This module used to render 260 JPEG slices per plane -- ~8 MB of
every case -- for the Slices tab. That tab is retired: the MPR panes show the same three
planes from the same volume, scrub with the same wheel, carry the same outlines, and
cross-reference each other, so it was a second and worse way to do what the tab beside
it already did. Nothing reads the tiles or `preview/contours.<plane>.json` any more.

What survives is what other things depend on and would have to be rebuilt somewhere
else: the dental WINDOW (`volume_pack` and `rtstruct` both take it from here) and the
per-plane size / spacing manifest. Both are cheap and neither writes a file.

The row-orientation table is imported from `contours.py` and never restated. See that
module for what happened when it was duplicated.
"""
from __future__ import annotations

from pathlib import Path

import numpy as np

# Retained so `count` and `source_indices` keep meaning the same thing they did when
# tiles existed: any consumer that sampled a plane sampled it at this stride. Nothing
# writes an image any more, so it costs nothing.
MAX_SLICES_PER_PLANE = 260

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


def _indices(n: int) -> list[int]:
    if n <= MAX_SLICES_PER_PLANE:
        return list(range(n))
    return list(np.linspace(0, n - 1, MAX_SLICES_PER_PLANE).round().astype(int))


def render(volume: np.ndarray, merged: np.ndarray, spacing_zyx, out_dir: Path) -> dict:
    """`volume` and `merged` are (z, y, x). Returns the window and plane geometry.

    `out_dir` and `merged` are kept in the signature although neither is written or read
    any more: three callers pass them, `rederive.py` among them, and a signature change
    here would be a second edit in a second file for no behavioural gain. They are
    unused ON PURPOSE rather than by accident, which is why this says so.
    """
    width, level = _window(volume)
    manifest: dict = {"window": {"width": round(width, 1), "level": round(level, 1)},
                      "planes": {}}

    for plane in PLANES:
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
        # `size` is [rows, cols] of the 2-D slice -- the SAME axis order as `pixel_mm`,
        # which is (row_mm, col_mm). `count` is how many a sampler would take;
        # `total_slices` is how many exist.
        manifest["planes"][plane] = {
            "size": [int(dims[0]), int(dims[1])],
            "count": len(idx),
            "total_slices": int(n),
            "source_indices": [int(i) for i in idx],
            "pixel_mm": [round(float(px[0]), 5), round(float(px[1]), 5)],
        }
    return manifest
