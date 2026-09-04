"""Panoramic reconstruction and buccolingual cross-sections, along the fitted arch.

These are the two views implant planning is actually read on, and this app has had
neither: "MPR" here means three fixed orthogonal planes, and `worker/orient.py`
refuses a genuine oblique. A cross-section perpendicular to the arch is the view
that shows ridge width, the canal in profile and the buccal plate at once.

**Rendered on the server, from the full-resolution grid, deliberately.** The volume
the browser already has (`worker/volume_pack.py`) is 8-bit, pre-windowed and
downsampled to about 0.66 mm; it is a display object and the app says so in three
places. A cross-section resampled from it would look convincing and would not be
measurable, and a ruler on it would disagree with every number the server computes
for the same gap. So the pictures come from here, at the scan's own resolution,
each with an exact `pixel_mm` published beside it -- which is what makes a ruler
drawn on them honest.

The output deliberately mirrors `worker/preview.py`: same windowing, same
`{count, source_indices, pixel_mm}` manifest shape, same JPEG tiles. The browser
gets what amounts to two more "planes" and can draw them with the code it has.
"""
from __future__ import annotations

import json
import logging
from pathlib import Path

import numpy as np

from worker import contours

log = logging.getLogger(__name__)

JPEG_QUALITY = 82

TROUGH_MM = 12.0          # buccolingual thickness of the panoramic focal trough
TROUGH_STEP_MM = 0.3      # sampling step across the trough
XS_EVERY_MM = 0.7         # arc spacing between cross-sections
XS_SLAB_MM = 1.0          # arc thickness averaged into each cross-section
XS_HALF_WIDTH_MM = 18.0   # buccolingual half-width of a cross-section
XS_PIXEL_MM = 0.15        # in-plane sampling of a cross-section
MAX_XS = 260              # per jaw, matching preview.py's per-plane tile budget
CANAL_SEARCH_MM = 22.0    # a canal voxel further than this from the arch in plan
                          # view is not this arch's canal and does not mark it


def _pitch(span_mm: float, n: int) -> float:
    """Distance between adjacent samples of `np.linspace(a, b, n)`.

    `linspace` includes BOTH endpoints, so n samples span the range in n-1 steps.
    Publishing `span/n` instead -- which this module did until 2026-09-01 -- makes
    every ruler read 0.4% short: a true 10.042 mm gap prints as 10.00. Small, and
    the whole premise of these pictures is that the pitch beside them is exact.
    """
    return float(span_mm) / max(int(n) - 1, 1)


def _sample(volume: np.ndarray, pts_idx: np.ndarray, order: int = 1,
            cval: float | None = None) -> np.ndarray:
    """Sample at fractional (z, y, x) indices; outside reads as `cval`.

    `order` is a parameter because LABELS must be sampled NEAREST. Interpolating a
    label array linearly averages structure INDICES: a boundary between 2 (maxilla) and
    6 (tooth_18) yields 3, 4 and 5, which are the canal and the two incisive canals --
    so the overlay would draw a nerve where the scan has none. `cval` likewise: the
    greyscale default of `volume.min()` is air, which is right for a picture and only
    accidentally right for a labelmap.
    """
    from scipy.ndimage import map_coordinates

    return map_coordinates(volume, pts_idx.T, order=order, mode="constant",
                           cval=float(volume.min()) if cval is None else float(cval))


def _lps_to_index(lps: np.ndarray, origin, inv_m) -> np.ndarray:
    """(N,3) LPS mm -> (N,3) fractional numpy (z, y, x) indices."""
    ijk = (lps - origin[None, :]) @ inv_m.T          # (x, y, z)
    return ijk[:, ::-1]


def _canal_presence(merged, fit, image, spacing_zyx) -> dict | None:
    """Which arc positions the inferior alveolar canal actually spans, and on which side.

    A clearance measured ACROSS a gap in a fragmented canal is not a clearance, so the
    planning surface needs to know where the drawn canal stops. Rather than search a
    radius around each arc point -- which needs a threshold that is wrong for somebody --
    every canal voxel is assigned to its nearest polyline point in PLAN VIEW (x, y).
    The canal runs parallel to the arch and well below it, so the xy projection is the
    stable association; a 3-D radius would have to be large enough to reach 20 mm down
    and would then also catch the other jaw.

    `side` is the sign of the voxel's LPS x **relative to the arch's own midline**,
    not the sign of x itself. LPS +x is patient-left as a DIRECTION, but x = 0 is
    wherever the scanner put its origin -- on ToothFairy3F_008 the whole head sits at
    positive x, so the naive sign reports every voxel as left and a bilateral canal
    comes back one-sided. The midline is `points[s0_index]`, which `arch` defines as
    the mid-sagittal crossing. (`quality.left_axis_sign_from_direction` is for array
    space and is not what is needed here.)
    """
    from dentistry.labels import MERGED_CANAL

    w = np.argwhere(merged == MERGED_CANAL)
    if not len(w):
        return {"present": [], "side": [], "s_mm": [], "components": 0}
    # voxel (z, y, x) -> LPS, via the image's own affine
    d = np.asarray(image.GetDirection(), dtype=np.float64).reshape(3, 3)
    m = d * np.asarray(image.GetSpacing(), dtype=np.float64)[np.newaxis, :]
    lps = np.asarray(image.GetOrigin(), dtype=np.float64)[None, :] + w[:, ::-1] @ m.T

    pts = fit.points
    from scipy.spatial import cKDTree
    dist, idx = cKDTree(pts[:, :2]).query(lps[:, :2], k=1)
    keep = dist <= CANAL_SEARCH_MM
    if not keep.any():
        return {"present": [], "side": [], "s_mm": [], "components": 0}

    n = len(pts)
    present = np.zeros(n, dtype=bool)
    side = np.zeros(n, dtype=np.int8)
    present[idx[keep]] = True
    # side from the nearest-to-the-arch voxel at each index, not from a mean: a mean
    # over a bilateral structure that briefly meets at the midline reads as zero.
    x_mid = float(pts[int(fit.s0_index)][0])
    order = np.argsort(-dist[keep])           # nearest written last, so it wins
    side[idx[keep][order]] = np.sign(lps[keep][order][:, 0] - x_mid).astype(np.int8)
    return {"s_mm": [round(float(v), 2) for v in fit.s],
            "present": present.astype(np.uint8).tolist(),
            "side": side.tolist()}


def render(volume: np.ndarray, spacing_zyx, image, fits: dict, out_dir: Path,
           merged: np.ndarray | None = None) -> dict:
    """Write `planning/pan/*.jpg`, `planning/xs/<jaw>/*.jpg` and `planning/arch.json`.

    `fits` maps a jaw name to an `arch.ArchFit`; a jaw whose fit refused is recorded
    with its reason and produces no pictures, which is how a case that cannot
    support planning ends up with no plan tab rather than a wrong one.
    """
    from PIL import Image

    from worker.preview import _to_u8, _window

    out_dir = Path(out_dir)
    width, level = _window(volume)
    origin = np.asarray(image.GetOrigin(), dtype=np.float64)
    d = np.asarray(image.GetDirection(), dtype=np.float64).reshape(3, 3)
    sp_xyz = np.asarray(image.GetSpacing(), dtype=np.float64)
    m = d * sp_xyz[np.newaxis, :]
    inv_m = np.linalg.inv(m)

    manifest: dict = {"version": 2,
                      "window": {"width": round(width, 1), "level": round(level, 1)},
                      "jaws": {}}

    for jaw, fit in fits.items():
        if fit is None or not fit.ok:
            manifest["jaws"][jaw] = {"ok": False,
                                     "reason": (fit.reason if fit else "not fitted")}
            continue
        pts, tang = fit.points, fit.tangents
        nrm = fit.normals()
        up = np.array([0.0, 0.0, 1.0])               # LPS +z is superior

        # --- the panoramic ---------------------------------------------------
        # A MEAN ray-sum, not a MIP: a maximum-intensity projection through a CBCT
        # is a metal-artefact soup, and the trough is meant to show the arch rather
        # than the single densest thing in front of it.
        z_lo, z_hi = fit.occlusal_z_mm - 42.0, fit.occlusal_z_mm + 26.0
        rows = int((z_hi - z_lo) / XS_PIXEL_MM)
        heights = np.linspace(z_hi, z_lo, rows)      # row 0 = superior
        # The TRUE pitch, not the nominal XS_PIXEL_MM the row count was derived from.
        row_pitch = _pitch(z_hi - z_lo, rows)
        # |dT/ds| by central differences on the unit tangents. Used to correct a band
        # gradient back to LPS, so it is published rather than recomputed downstream.
        curv = np.linalg.norm(np.gradient(tang, fit.step_mm, axis=0), axis=1)
        offs = np.arange(-TROUGH_MM / 2, TROUGH_MM / 2 + 1e-6, TROUGH_STEP_MM)
        acc = np.zeros((rows, len(pts)), dtype=np.float32)
        for t in offs:
            base = pts + nrm * t
            grid = (base[None, :, :] + up[None, None, :] * (heights[:, None, None]
                                                            - base[None, :, 2:3]))
            idx = _lps_to_index(grid.reshape(-1, 3), origin, inv_m)
            acc += _sample(volume, idx).reshape(rows, len(pts)).astype(np.float32)
        pan = acc / len(offs)
        pan_dir = out_dir / "pan"
        pan_dir.mkdir(parents=True, exist_ok=True)
        Image.fromarray(_to_u8(pan, width, level)).save(
            pan_dir / f"{jaw}.jpg", quality=JPEG_QUALITY, optimize=True)
        del acc, pan

        # --- the cross-sections ----------------------------------------------
        every = max(1, int(round(XS_EVERY_MM / fit.step_mm)))
        picks = list(range(0, len(pts), every))
        if len(picks) > MAX_XS:
            picks = list(np.linspace(0, len(pts) - 1, MAX_XS).round().astype(int))
        slab = max(1, int(round(XS_SLAB_MM / fit.step_mm)))
        cols = int(2 * XS_HALF_WIDTH_MM / XS_PIXEL_MM)
        ts = np.linspace(-XS_HALF_WIDTH_MM, XS_HALF_WIDTH_MM, cols)
        col_pitch = _pitch(2 * XS_HALF_WIDTH_MM, cols)

        xs_dir = out_dir / "xs" / jaw
        xs_dir.mkdir(parents=True, exist_ok=True)
        # The structure outlines, per section. Built from the SAME grid the picture is
        # built from -- captured on the mid plane of the slab rather than derived from a
        # second expression -- so the overlay and the bitmap cannot drift. Absent when
        # the worker was given no labelmap, in which case the manifest says so and the
        # client shows a stated absence rather than an empty overlay.
        xs_contours: dict[str, dict] = {}
        for out_i, k in enumerate(picks):
            ks = [j for j in range(k - slab // 2, k + slab // 2 + 1)
                  if 0 <= j < len(pts)] or [k]
            img_acc = np.zeros((rows, cols), dtype=np.float32)
            for j in ks:
                base = pts[j][None, :] + nrm[j][None, :] * ts[:, None]      # (cols, 3)
                grid = (base[None, :, :] + up[None, None, :]
                        * (heights[:, None, None] - base[None, :, 2:3]))
                idx = _lps_to_index(grid.reshape(-1, 3), origin, inv_m)
                img_acc += _sample(volume, idx).reshape(rows, cols).astype(np.float32)
                # The MID plane of the slab, not a majority over it. The picture is a
                # 1.0 mm slab MEAN and a label contour is a single-plane cut, so the two
                # are different objects however this is done; the mid plane is the one
                # `plan_metrics` samples its distance fields at, so the outline agrees
                # with the millimetres printed beside it. A per-pixel majority would
                # additionally INVENT a contour on a plane the structure is not in --
                # this module's rule is that it may under-report, never over-report.
                if merged is not None and j == k:
                    lab = _sample(merged, idx, order=0, cval=0).reshape(rows, cols)
                    polys = contours.plane_polygons(
                        lab.astype(np.int32), contours.TOLERANCE_VOX,
                        row_pitch, col_pitch)
                    if polys:
                        xs_contours[str(out_i)] = {str(v): rings
                                                   for v, rings in polys.items()}
            Image.fromarray(_to_u8(img_acc / len(ks), width, level)).save(
                xs_dir / f"{out_i:04d}.jpg", quality=JPEG_QUALITY, optimize=True)
            del img_acc
        if merged is not None:
            (xs_dir / "contours.json").write_text(
                json.dumps(xs_contours, separators=(",", ":")))

        manifest["jaws"][jaw] = {
            "ok": True,
            "arc_length_mm": round(float(fit.arc_length_mm), 2),
            "step_mm": fit.step_mm,
            "s0_index": int(fit.s0_index),
            "occlusal_z_mm": round(float(fit.occlusal_z_mm), 2),
            "panoramic": {"file": f"pan/{jaw}.jpg",
                          "size": [rows, int(len(pts))],
                          # rows are millimetres; columns are ARC LENGTH, which is
                          # why `metric_axes` says so. See the note below.
                          "pixel_mm": [round(row_pitch, 6),
                                       round(float(fit.step_mm), 4)],
                          "trough_mm": TROUGH_MM,
                          "projection": "mean",
                          "metric_axes": "vertical_only",
                          "note": ("columns are arc length swept through a curved "
                                   "trough, not straight-line distance: a horizontal "
                                   "span reads long by about (1 + t/R). Only the "
                                   "vertical axis is metric."),
                          "z_top_mm": round(float(z_hi), 4)},
            "cross_sections": {"dir": f"xs/{jaw}", "count": len(picks),
                               "source_indices": [int(i) for i in picks],
                               "s_mm": [round(float(fit.s[i]), 2) for i in picks],
                               "size": [rows, cols],
                               "pixel_mm": [round(row_pitch, 6), round(col_pitch, 6)],
                               # {n, up} is orthonormal -- n has no z-component and
                               # up is +z -- so the section is a genuine isometric
                               # plane and pixel distance x pitch is true millimetres
                               # in ANY direction, not just along an axis.
                               "metric_axes": "both",
                               "t_axis": "buccal_positive",
                               "t_range_mm": [-XS_HALF_WIDTH_MM, XS_HALF_WIDTH_MM],
                               "half_width_mm": XS_HALF_WIDTH_MM,
                               "slab_mm": XS_SLAB_MM,
                               # The overlay's own manifest entry. The client reads THIS
                               # rather than probing for the file: with auth on, a 401
                               # and a 404 are indistinguishable to an image load, and
                               # "this case predates outlines" must not be the message a
                               # signed-out session gets.
                               "contours": (f"xs/{jaw}/contours.json"
                                            if merged is not None else None),
                               "contours_plane": "mid plane of the slab",
                               "z_top_mm": round(float(z_hi), 4)},
            # The polyline lives here rather than in `jobs.reports`: it is ~20 KB per
            # jaw and only the plan tab needs it, while the site table in
            # `report.arch` is what the rail and the FDI chart read.
            "points": np.round(pts, 3).tolist(),
            "tangents": np.round(tang, 4).tolist(),
            # PUBLISHED, never recomputed in the browser. `ArchFit.normals()` picks
            # which of the two in-plane rotations is buccal by the sign that moves
            # away from the arch centroid; a JS reimplementation of that rule is
            # exactly the kind of thing that mirrors silently on one patient.
            "normals": np.round(nrm, 4).tolist(),
            # |dT/ds|, needed to turn a gradient in the (s, t, z) band back into a
            # true LPS direction: the s axis is curvilinear, so the mesio-distal
            # component is scaled by 1/(1 + t*kappa).
            "curvature_1_per_mm": np.round(curv, 6).tolist(),
            "sites": fit.sites,
        }
        # Mandible only: there is no maxillary inferior alveolar canal, and the
        # planning surface must never imply one.
        if merged is not None and jaw == "mandible":
            try:
                manifest["jaws"][jaw]["canal"] = _canal_presence(
                    merged, fit, image, spacing_zyx)
            except Exception as exc:  # noqa: BLE001
                log.warning("canal presence failed for %s: %s", jaw, exc)

        log.info("panoramic %s: %d cross-sections over %.0f mm of arc "
                 "(row %.4f mm, col %.4f mm)",
                 jaw, len(picks), fit.arc_length_mm, row_pitch, col_pitch)

    (out_dir / "arch.json").write_text(json.dumps(manifest) + "\n")
    # `reports["planning"]` goes into the job's JSONB blob, so the per-point arrays
    # are stripped: they are tens of kilobytes per jaw and only the plan tab needs
    # them, which fetches arch.json directly. `sites` is dropped too because
    # `reports["arch"]` already carries it, and one fact in two places drifts.
    heavy = ("points", "tangents", "normals", "curvature_1_per_mm", "sites", "canal")
    out = {"file": "planning/arch.json", "version": manifest["version"], "jaws": {}}
    for j, info in manifest["jaws"].items():
        summary = {k: v for k, v in info.items() if k not in heavy}
        canal = info.get("canal")
        if canal:
            n = sum(canal["present"])
            summary["canal"] = {"spans_mm": round(n * float(info["step_mm"]), 1),
                                "sides": sorted({s for s in canal["side"] if s})}
        out["jaws"][j] = summary
    return out
