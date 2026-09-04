"""The browser's volumetric copy: 8-bit grey + 8-bit labels + a meta.json.

Two raw arrays and an affine, under a strict transfer budget, for the Cornerstone3D
panes. **It is a DISPLAY object.** It is windowed at job time and downsampled so the
longest axis is at most `DEFAULT_MAX_DIM`, which on a dental CBCT means roughly
0.66 mm voxels -- and that is why nothing in the implant-planning surface measures
on it. `worker/panoramic.py` renders its pictures server-side from the
full-resolution grid for exactly this reason.

The label array is downsampled by nearest neighbour and the classes that vanish are
NAMED in the manifest (`labels.lost_to_downsampling`) rather than silently dropped:
a 7 mm3 lingual canal can disappear entirely at 0.66 mm, and a viewer that shows no
lingual canal must be able to say why.
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np

DEFAULT_MAX_DIM = 256


def _factor(shape, max_dim: int) -> int:
    longest = max(shape)
    f = 1
    while longest // (f + 1) >= max_dim // 2 and longest // f > max_dim:
        f += 1
    return max(1, f)


def export(grey: np.ndarray, merged: np.ndarray, spacing_zyx, origin, direction,
           out_dir: Path, window: tuple[float, float], conflicts=None,
           max_dim: int = DEFAULT_MAX_DIM) -> dict:
    out_dir.mkdir(parents=True, exist_ok=True)
    f = _factor(grey.shape, max_dim)
    g = grey[::f, ::f, ::f]
    lab = merged[::f, ::f, ::f]

    width, level = window
    lo = level - width / 2
    g8 = np.clip((g.astype(np.float32) - lo) / max(width, 1e-6), 0, 1)
    g8 = (g8 * 255).astype(np.uint8)

    before = {int(v) for v in np.unique(merged) if v}
    after = {int(v) for v in np.unique(lab) if v}
    (out_dir / "image.raw").write_bytes(np.ascontiguousarray(g8).tobytes())
    (out_dir / "labels.raw").write_bytes(
        np.ascontiguousarray(lab.astype(np.uint8)).tobytes())

    from dentistry import labels as L

    meta = {
        "dimensions": [int(x) for x in reversed(g8.shape)],       # (x, y, z)
        "spacing": [float(spacing_zyx[2] * f), float(spacing_zyx[1] * f),
                    float(spacing_zyx[0] * f)],
        "origin": [float(x) for x in origin],
        "direction": [float(x) for x in direction],
        "downsample_factor": int(f),
        "image": {"file": "image.raw", "dtype": "uint8",
                  "window": {"width": float(width), "level": float(level)}},
        "labels": {"file": "labels.raw", "dtype": "uint8",
                   "present": sorted(after),
                   "lost_to_downsampling": sorted(before - after)},
        # `{index: {name, color}}` with the colour as a HEX STRING, which is what the
        # committed viewer bundle reads: it does `M.color.slice(1).match(/../g)` to build
        # the segmentation colour LUT, and `M.name` to label each segment.
        #
        # The version rebuilt on 2026-09-01 wrote a plain `[r, g, b]` array instead, so
        # `M.color` was undefined and every case died on "Cannot read properties of
        # undefined (reading 'slice')" the moment the 3D view mounted. The segmentation,
        # the report and the rail were all fine -- only the volume failed, and only in
        # the browser.
        #
        # Only the structures actually PRESENT are listed. The viewer sizes its colour
        # LUT from `max(keys)` and adds one segment entry per key, so shipping all 47 on
        # a scan carrying 12 makes it allocate and register 35 segments that can never
        # be drawn.
        # `id` is load-bearing and was omitted by the 2026-09-01 reconstruction. The
        # viewer reads it twice: for the per-structure surface opacity table
        # (`maxilla` .22, `mandible` .34, the two `*_unnumbered` .75) and for
        # `archCentre`, which it derives from the actors matching /^tooth_/. Without it
        # the jaws render at opacity 1 and HIDE EVERY TOOTH inside a sealed jaw, and
        # `archCentre` is null so `focusStructure`/`surfacesReady` frame from a default
        # direction instead of the buccal side. No warning, no error -- exactly the same
        # class of silent break as the `[r,g,b]`-instead-of-hex bug described above,
        # one field over.
        "colors": {str(s.index): {"id": s.id, "name": s.name, "color": s.color}
                   for s in L.STRUCTURES if s.index in after},
        "conflicts": conflicts,
    }
    (out_dir / "meta.json").write_text(json.dumps(meta))
    return meta
