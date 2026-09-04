"""The measurement field an implant plan is measured against.

**Why a precomputed field at all.** The API image has neither numpy nor scipy -- see
`requirements-api.txt` -- so `POST /measure` cannot compute a distance transform, or
anything else. It can only *look things up*. So the worker computes the expensive
geometry once, into a file the API reads through `mmap` with `struct.unpack_from`, and
the endpoint becomes a few hundred point samples. That constraint turns out to produce
the better design: the measurement is deterministic, auditable, and identical every time
it is asked for.

**The band is a stack of planes, not a coordinate chart.** The pack is stored in the arch
frame `(s, t, z)`: `s` along the fitted mid-line, `t` buccolingual, `z` vertical -- the
same frame the cross-section pictures use, so the ruler and the measurement share one
map. It is emphatically NOT invertible. For a tight anterior arch (curvature ~1/12 per
mm) the lingual normals cross at about `t = -12`, so a point in space can have two
`(s, t)` addresses. That does not matter, because **nothing ever inverts it**: every
query is made at a KNOWN `s` -- an implant with zero yaw lies entirely within one plane,
and its density cylinder strays only its own radius from it. A forward evaluation on a
named plane is always well defined.

**The distance field is computed at native resolution and then interpolated in.** Not
computed on the band. A mandibular canal is about five voxels across at 0.3 mm; a mask
resampled onto the band first would throw away the geometry the distance is supposed to
measure. The crop is `(band bbox union canal bbox)` padded two voxels, which is exactly
the argument `dentistry/metrics._union_box` already makes: every canal voxel is inside
the crop, so every distance from a band point to its nearest canal voxel is exact.

Trilinear interpolation of a 1-Lipschitz distance field errs by at most about
`h^2 / (8R)` -- 0.019 mm at `h = 0.3`, `R = 1.5` -- two orders below the model's own
0.46 mm inward p95. At the field's medial ridge the interpolation UNDER-estimates the
distance, which is the conservative direction for a clearance.

**Grey values are stored RAW and uncalibrated, and nothing may ever rescale them.**
`worker/main.py` hands `panoramic.render` the array straight off the scan, and
`tf3.calibrate` measures its air level on that same array -- calibration is applied only
to the model's own input copy. So `(site - air) / (reference - air)` computed here is
affine-invariant AND both operands are already in one unit system. Applying the gain
would break exactly that.
"""

from __future__ import annotations

import json
import logging
import struct
from pathlib import Path

import numpy as np

log = logging.getLogger(__name__)

# 2 since 2026-09-02. v1 packs exist on disk whose `references.cancellous` was taken
# before `references()` restricted the population to `grey > soft_tissue`, and on the
# maxilla that reference is sinus air rather than bone -- measured 4.26 and 221.32 on
# two stored cases against a corrected 382.36 and 420.26. The version was NOT bumped
# when the restriction landed, so nothing could tell the two apart; that is the whole
# reason this constant now has a comment. `api/routes/plans.py` treats a reference
# block with no `soft_tissue` landmark as absent rather than trusting it.
PACK_VERSION = 3
PACK_MM = 0.30            # the model's own plan spacing
T_HALF_MM = 12.0          # buccolingual half-width of the band

# The band's vertical extent, relative to the occlusal plane, PER JAW. One pair of
# constants cannot serve both: apical is -z in the mandible and +z in the maxilla, so
# the asymmetry has to flip with the jaw. Measured on a real case before this existed,
# the maxillary band ran z = 26.95 down to -18.05 with the occlusal plane at 16.95 --
# 10 mm of headroom above the crest, while a 13 mm implant reaches occlusal+13 and
# `plan_metrics.bone_beyond_apex` then walks a further 20 mm. The whole apical profile
# was outside the field and silently edge-clamped.
#
# maxilla `above` = 40: the picture (`panoramic.render`) only reaches occlusal+26, so
# nothing above that can be dragged to; 40 exceeds the picture by 14 mm, enough that an
# implant placed at the very top of the visible region still has its full 20 mm apical
# profile measured. `below` = 15 keeps the crest and a supra-erupted or tilted case
# without paying for basal bone that has no maxillary meaning.
BAND_Z = {
    "mandible": {"above": 10.0, "below": 35.0},   # unchanged: byte-identical mandible
    "maxilla": {"above": 40.0, "below": 15.0},
}

SAT_MM = 65.535           # uint16 micrometres saturate here; nothing needs more
CANAL_PAD_VOX = 2

# The tooth and accessory-canal fields are uint8 at 0.05 mm, saturating at 12.70 mm
# (254; 255 is reserved to mean "saturated" so it cannot be confused with a real
# 12.75 mm reading). Justified, not a compromise: the quantum contributes
# 0.05/2 = 0.025 mm and the trilinear interpolation h^2/(8R) = 0.019 mm, for
# 0.044 mm total -- against the teeth's own measured mean inward p95 of 0.339 mm and
# the accessory canals' 0.987-1.109 mm, i.e. 7-25x finer than the model's own error.
# The canal field's uint16 micrometres is 460x finer than ITS 0.46 mm error, which is
# over-precise; do not copy it. And the bytes matter: uint16 for both new fields would
# take the pack from 29 MB to 68 MB per case, uint8 takes it to 48 MB.
FINE_QUANT_MM = 0.05
FINE_SAT_MM = 254 * FINE_QUANT_MM     # 12.70 mm
FINE_SATURATED = 255

# A neighbour further than this is not a neighbour: the conventional minima are 1.5 mm
# to an adjacent tooth and 2.0 mm to the canal.

MIN_REFERENCE_VOXELS = 2000
CORTICAL_ERODE_MM = 2.0


def _index_affine(image):
    """(origin, inv(direction*spacing)) for LPS mm -> fractional (z, y, x) indices."""
    origin = np.asarray(image.GetOrigin(), dtype=np.float64)
    d = np.asarray(image.GetDirection(), dtype=np.float64).reshape(3, 3)
    m = d * np.asarray(image.GetSpacing(), dtype=np.float64)[np.newaxis, :]
    return origin, np.linalg.inv(m)


def lattice(fit, jaw: str = "mandible") -> dict:
    """The band's own grid: how many samples along each axis, and where they sit.

    `jaw` selects the vertical extent -- see `BAND_Z`. It is not optional in spirit:
    the mandibular numbers were hard-coded here and a maxillary implant left the band
    almost immediately, getting edge-clamped values with no caveat.
    """
    z = BAND_Z.get(jaw) or BAND_Z["mandible"]
    n_s = max(2, int(round(fit.arc_length_mm / PACK_MM)) + 1)
    n_t = max(2, int(round(2 * T_HALF_MM / PACK_MM)) + 1)
    n_z = max(2, int(round((z["above"] + z["below"]) / PACK_MM)) + 1)
    z_top = float(fit.occlusal_z_mm) + z["above"]
    return {"n_s": n_s, "n_t": n_t, "n_z": n_z,
            "step_mm": PACK_MM,
            "s0_mm": float(fit.s[0]),
            "t_min_mm": -T_HALF_MM,
            "z_top_mm": z_top,
            "jaw": jaw,
            "z_above_mm": z["above"], "z_below_mm": z["below"]}


def _band_points(fit, lat) -> np.ndarray:
    """(n_s, n_t, n_z, 3) LPS millimetres. ~5 M points at 0.3 mm; built once, in float32."""
    s_want = lat["s0_mm"] + np.arange(lat["n_s"]) * lat["step_mm"]
    idx = np.clip((s_want - fit.s[0]) / fit.step_mm, 0, len(fit.points) - 1)
    lo = np.floor(idx).astype(int)
    hi = np.minimum(lo + 1, len(fit.points) - 1)
    w = (idx - lo)[:, None]
    pts = fit.points[lo] * (1 - w) + fit.points[hi] * w      # (n_s, 3)
    nrm = fit.normals()
    n = nrm[lo] * (1 - w) + nrm[hi] * w
    n /= np.maximum(np.linalg.norm(n[:, :2], axis=1, keepdims=True), 1e-9)

    t = lat["t_min_mm"] + np.arange(lat["n_t"]) * lat["step_mm"]
    z = lat["z_top_mm"] - np.arange(lat["n_z"]) * lat["step_mm"]

    out = np.empty((lat["n_s"], lat["n_t"], lat["n_z"], 3), dtype=np.float32)
    xy = pts[:, None, :2] + n[:, None, :2] * t[None, :, None]     # (n_s, n_t, 2)
    out[..., 0] = xy[:, :, None, 0]
    out[..., 1] = xy[:, :, None, 1]
    out[..., 2] = z[None, None, :]
    return out


def _sample(volume: np.ndarray, lps: np.ndarray, image, order: int, cval: float):
    from scipy.ndimage import map_coordinates

    origin, inv_m = _index_affine(image)
    flat = lps.reshape(-1, 3).astype(np.float64)
    ijk = (flat - origin[None, :]) @ inv_m.T
    out = map_coordinates(volume, ijk[:, ::-1].T, order=order,
                          mode="constant", cval=cval)
    return out.reshape(lps.shape[:-1])


def _band_index_box(lps: np.ndarray, image, shape) -> tuple:
    """The index bounding box of the band's own sample points, clipped to the volume."""
    origin, inv_m = _index_affine(image)
    flat = lps.reshape(-1, 3).astype(np.float64)
    ijk = (flat - origin[None, :]) @ inv_m.T
    zyx = ijk[:, ::-1]
    lo = np.maximum(np.floor(zyx.min(0)).astype(int), 0)
    hi = np.minimum(np.ceil(zyx.max(0)).astype(int) + 1, np.asarray(shape))
    return tuple(slice(int(a), int(b)) for a, b in zip(lo, hi))


def _label_edt(merged: np.ndarray, spacing_zyx, indices, band_box=None):
    """Distance to the nearest voxel of ANY of `indices`, in mm, on a containing crop.

    **The crop is the UNION of the label's bounding box and the BAND's**, padded
    `CANAL_PAD_VOX`. That is what makes every distance from a band point exact, and it
    is what `metrics._union_box` argues for -- but the canal-only predecessor cropped to
    the LABEL's box alone while its docstring claimed the union, and the consequence was
    not subtle. `map_coordinates` fills outside the crop with `cval`, which is the
    saturation value, so every band point outside the label's own bounding box read as
    "further away than this field measures".

    Measured on a real pack, that made 58% of the canal field saturated -- tolerable
    there only because a real inferior alveolar canal's bounding box spans most of the
    mandible, so the field stayed accurate out to about 36 mm. For a THIN structure it is
    fatal: an accessory canal's bounding box is a few millimetres across, so the field
    would saturate almost everywhere and the anterior clearance this pack exists to
    provide would never be measurable. Same for a single tooth.

    Computing the transform on the band instead of at native resolution is the other
    trap and is still avoided: a mandibular canal is about five voxels across at 0.3 mm,
    and a mask resampled onto the band first would throw away the geometry the distance
    is supposed to measure.
    """
    from scipy import ndimage

    want = np.isin(merged, list(indices))
    w = np.argwhere(want)
    if not len(w):
        return None, None
    lo = np.minimum(w.min(0) - CANAL_PAD_VOX, w.min(0))
    hi = np.maximum(w.max(0) + CANAL_PAD_VOX + 1, w.max(0) + 1)
    if band_box is not None:
        lo = np.minimum(lo, [sl.start for sl in band_box])
        hi = np.maximum(hi, [sl.stop for sl in band_box])
    lo = np.maximum(lo - CANAL_PAD_VOX, 0)
    hi = np.minimum(hi + CANAL_PAD_VOX, merged.shape)
    box = tuple(slice(int(a), int(b)) for a, b in zip(lo, hi))
    sub = want[box]
    return ndimage.distance_transform_edt(~sub, sampling=spacing_zyx), box


def _canal_edt(merged: np.ndarray, spacing_zyx, canal_index: int, band_box=None):
    """Distance to the nearest canal voxel, in mm, on a crop that contains them all.

    A thin wrapper over `_label_edt` so the canal and every other structure share one
    crop rule. It used to have its own, tighter one; see `_label_edt` for what that cost.
    """
    return _label_edt(merged, spacing_zyx, [int(canal_index)], band_box=band_box)


def _canal_edt_legacy(merged: np.ndarray, spacing_zyx, canal_index: int):
    from scipy import ndimage

    w = np.argwhere(merged == canal_index)
    if not len(w):
        return None, None
    lo = np.maximum(w.min(0) - CANAL_PAD_VOX, 0)
    hi = np.minimum(w.max(0) + CANAL_PAD_VOX + 1, merged.shape)
    box = tuple(slice(int(a), int(b)) for a, b in zip(lo, hi))
    sub = merged[box] == canal_index
    # Native resolution, on a crop that provably contains every canal voxel -- the same
    # argument metrics._union_box makes. Computing this on the band instead would
    # discard the geometry of a five-voxel-wide tube.
    return ndimage.distance_transform_edt(~sub, sampling=spacing_zyx), box


def _edt_into_band(edt, box, lps, image):
    """Interpolate the cropped distance field at the band points, in mm."""
    origin, inv_m = _index_affine(image)
    flat = lps.reshape(-1, 3).astype(np.float64)
    ijk = (flat - origin[None, :]) @ inv_m.T
    zyx = ijk[:, ::-1]
    # into crop-local indices
    zyx = zyx - np.array([box[0].start, box[1].start, box[2].start], dtype=np.float64)
    from scipy.ndimage import map_coordinates
    out = map_coordinates(edt, zyx.T, order=1, mode="constant", cval=SAT_MM)
    return out.reshape(lps.shape[:-1])


def _jaw_tooth_indices(jaw: str) -> set:
    """Merged indices of the teeth belonging to one jaw, by FDI quadrant.

    Derived from `labels.STRUCTURES`, never restated: FDI quadrants 1 and 2 are upper,
    3 and 4 lower, and getting that backwards would measure an implant against the
    opposing arch -- the same class of error `dentistry/arch.py` refuses to risk.
    """
    from dentistry import labels as L

    upper = jaw == "maxilla"
    out = set()
    for st in L.STRUCTURES:
        if st.fdi is None:
            continue
        q = int(st.fdi) // 10
        if (q in (1, 2)) == upper:
            out.add(int(st.index))
    return out


def _write_fine_field(merged, spacing_zyx, indices, lps, image, out_dir: Path,
                      jaw: str, name: str, fields: dict, what: str,
                      band_box=None) -> int:
    """Quantise a label distance transform into a uint8 field. Returns bytes written.

    `FINE_SATURATED` (255) is reserved: it means "further than `FINE_SAT_MM`", which a
    consumer must treat as "no such structure near this implant" rather than as a
    measured 12.75 mm. Conflating the two would turn an absent structure into a
    comfortable clearance.
    """
    edt, box = _label_edt(merged, spacing_zyx, indices, band_box=band_box)
    if edt is None:
        return 0
    d = _edt_into_band(edt, box, lps, image)
    q = np.rint(np.clip(d, 0.0, FINE_SAT_MM) / FINE_QUANT_MM)
    q[d > FINE_SAT_MM] = FINE_SATURATED
    path = out_dir / f"{jaw}.{name}.raw"
    np.ascontiguousarray(q, dtype=np.uint8).tofile(path)
    n = path.stat().st_size
    fields[name] = {"file": f"pack/{jaw}.{name}.raw", "dtype": "uint8",
                    "scale": FINE_QUANT_MM, "offset": 0.0, "unit": "mm",
                    "saturates_mm": FINE_SAT_MM, "saturated_value": FINE_SATURATED,
                    "indices": [int(i) for i in indices], "measures": what,
                    "bytes": n}
    del edt, d, q
    return n


def references(grey: np.ndarray, merged: np.ndarray, fit, jaw: str, image,
               intensity: dict) -> dict:
    """The two numbers every density statement is a ratio of.

    `air` comes from `tf3.air_level` -- the SAME function that produced
    `report.intensity.air`, not a re-derivation, so the report and the measurement cannot
    disagree about what air is on this scan.

    The maxillary reference is derived GEOMETRICALLY from the arch fit, never from
    `MERGED_MAXILLA`: that label is FOV_LIMITED, its boundary is the edge of the scan
    rather than anatomy, and `labels.py` forbids measuring from it.

    **Both references are then restricted to voxels above this scan's own soft-tissue
    landmark.** Without that the maxillary slab is mostly not bone: 8 mm either side of
    the arch and 15 mm up runs straight into the maxillary sinus, and on the first real
    case the median came out at **4.3** -- soft tissue -- against the mandible's 469.
    A density ratio against that reference would have been meaningless and would have
    looked perfectly reasonable.

    The threshold is a landmark rather than a constant, so it scales with the scan: it
    comes from `report.intensity.soft_tissue`, which `tf3.calibrate` measured on this
    same array. That keeps the whole quantity affine-invariant.
    """
    from scipy import ndimage

    from dentistry import labels as L
    from worker import tf3

    air = intensity.get("air")
    if air is None:
        air = float(tf3.air_level(grey)[0])
    soft = intensity.get("soft_tissue")
    if soft is None:
        soft = air + 0.5 * (float(np.percentile(grey, 99.5)) - air)
    # Bone only. See the docstring: without this the maxillary slab's median is sinus air.
    bone = grey > soft

    ref = None
    if jaw == "mandible":
        mask = merged == L.MERGED_MANDIBLE
        if mask.any():
            sp = tuple(reversed(image.GetSpacing()))
            it = max(1, int(round(CORTICAL_ERODE_MM / min(sp))))
            inner = ndimage.binary_erosion(mask, iterations=it)   # drop the cortical shell
            inner &= ~np.isin(merged, list(_dense_ids()))
            inner &= bone
            if inner.sum() >= MIN_REFERENCE_VOXELS:
                ref = float(np.median(grey[inner]))
                n = int(inner.sum())
    else:
        # A slab around the maxillary arch, 8 mm either side of the mid-line and 15 mm
        # up from the occlusal plane. Built with a KD-tree over the polyline in PLAN
        # view -- the same association `panoramic._canal_presence` uses -- rather than by
        # marching sample points, which an earlier version did and which found almost
        # nothing because it only touched one voxel per step.
        #
        # Geometry, never `MERGED_MAXILLA`: that label is FOV_LIMITED, its boundary is
        # the edge of the scan rather than anatomy, and labels.py forbids measuring from
        # it. This is what lets the maxilla carry a density ratio at all.
        from scipy.spatial import cKDTree

        origin, inv_m = _index_affine(image)
        m = np.linalg.inv(inv_m)
        zt = float(fit.occlusal_z_mm)
        zz, yy, xx = np.mgrid[0:grey.shape[0], 0:grey.shape[1], 0:grey.shape[2]]
        # Only the slab: converting every voxel to LPS would be 10^8 points.
        corner = origin
        lps_z = corner[2] + zz * m[2, 2] + yy * m[2, 1] + xx * m[2, 0]
        slab = (lps_z >= zt) & (lps_z <= zt + 15.0)
        n = 0
        if slab.any():
            idx = np.argwhere(slab)
            pts_lps = origin[None, :] + idx[:, ::-1] @ m.T
            d, _ = cKDTree(fit.points[:, :2]).query(pts_lps[:, :2], k=1)
            near = idx[d <= 8.0]
            keep = np.zeros(grey.shape, dtype=bool)
            keep[near[:, 0], near[:, 1], near[:, 2]] = True
            keep &= ~np.isin(merged, list(_dense_ids()))
            keep &= bone
            n = int(keep.sum())
            if n >= MIN_REFERENCE_VOXELS:
                ref = float(np.median(grey[keep]))

    out = {"air": float(air), "soft_tissue": float(soft), "cancellous": ref,
           "cancellous_voxels": int(n) if ref is not None else 0,
           "min_voxels": MIN_REFERENCE_VOXELS}
    if ref is None:
        # Affine-invariant or absent. A ratio against a reference this scan does not
        # contain is not a conservative estimate, it is a made-up number.
        out["reason"] = ("this scan has no usable cancellous reference population for "
                         f"the {jaw}")
    return out


def _dense_ids():
    """Teeth, pulp and dental work: not cancellous bone, and they would drag the median."""
    from dentistry import labels as L
    ids = {s.index for s in L.STRUCTURES
           if s.group in ("Upper teeth", "Lower teeth", "Tooth pulp", "Dental work")}
    return ids


def build(grey: np.ndarray, merged: np.ndarray, image, fits: dict, out_dir: Path,
          intensity: dict) -> dict:
    """Write `planning/pack/<jaw>.{grey,canal,accessory_canal,tooth}.raw` + a header."""
    from dentistry import labels as L

    out_dir = Path(out_dir) / "pack"
    out_dir.mkdir(parents=True, exist_ok=True)
    spacing_zyx = tuple(reversed(image.GetSpacing()))
    air_floor = float(grey.min())

    header = {"version": PACK_VERSION, "step_mm": PACK_MM,
              "note": ("Grey values are RAW and uncalibrated, exactly as the scan "
                       "arrived. Never apply report.intensity.gain/offset_hu to them: "
                       "the density metric is (site - air)/(reference - air) with air "
                       "measured on this same array, which is affine-invariant only "
                       "because both operands share one unit system."),
              "jaws": {}}
    total = 0

    for jaw, fit in fits.items():
        if fit is None or not fit.ok:
            header["jaws"][jaw] = {"ok": False, "reason": fit.reason if fit else "not fitted"}
            continue
        lat = lattice(fit, jaw)
        lps = _band_points(fit, lat)

        g = _sample(grey, lps, image, order=1, cval=air_floor)
        gp = out_dir / f"{jaw}.grey.raw"
        np.ascontiguousarray(g, dtype=np.int16).tofile(gp)
        fields = {"grey": {"file": f"pack/{jaw}.grey.raw", "dtype": "int16",
                           "scale": 1.0, "offset": 0.0, "bytes": gp.stat().st_size}}
        total += gp.stat().st_size
        del g

        band_box = _band_index_box(lps, image, merged.shape)
        if jaw == "mandible":
            edt, box = _canal_edt(merged, spacing_zyx, L.MERGED_CANAL, band_box=band_box)
            if edt is not None:
                d = _edt_into_band(edt, box, lps, image)
                q = np.clip(d, 0, SAT_MM) * 1000.0        # micrometres
                cp = out_dir / f"{jaw}.canal.raw"
                np.ascontiguousarray(q, dtype=np.uint16).tofile(cp)
                fields["canal"] = {"file": f"pack/{jaw}.canal.raw", "dtype": "uint16",
                                   "scale": 0.001, "offset": 0.0, "unit": "mm",
                                   "saturates_mm": SAT_MM, "bytes": cp.stat().st_size}
                total += cp.stat().st_size
                del edt, d, q

            # The ANTERIOR neurovascular structures, which had no field at all. The
            # inferior alveolar canal ends at the mental foramen -- measured, a 58 mm
            # absence across the anterior mandible -- so an anterior implant has no IAC
            # to clear, and the code used to report the resulting 24.5 mm "gap" as a
            # drawing failure and refuse a verdict at every anterior site. The
            # structures that ARE there are the two incisive canals and the lingual
            # canal, drawn on every real case by the canal specialist, and until now
            # invisible to the measurement.
            #
            # ONE combined field, not three: identity comes from a per-structure lookup
            # in `arch.json` for kilobytes, where three fields would cost ~30 MB.
            acc = sorted(L.ACCESSORY_CANALS)
            total += _write_fine_field(
                merged, spacing_zyx, acc, lps, image, out_dir, jaw, "accessory_canal",
                fields, "the nearest drawn accessory canal (incisive or lingual)",
                band_box=band_box)

        # Teeth of THIS jaw. The highest-confidence clearance available: per-FDI teeth
        # score a mean inward p95 of 0.339 mm against the left IAC's 0.464 and the
        # accessory canals' ~1.0. One combined field for the same reason as above.
        tooth_ids = sorted(_jaw_tooth_indices(jaw))
        if tooth_ids:
            total += _write_fine_field(
                merged, spacing_zyx, tooth_ids, lps, image, out_dir, jaw, "tooth",
                fields, "the nearest drawn tooth of this jaw", band_box=band_box)
        del lps

        header["jaws"][jaw] = {"ok": True, "lattice": lat, "fields": fields,
                               "references": references(grey, merged, fit, jaw, image,
                                                        intensity)}

    (out_dir / "header.json").write_text(json.dumps(header, indent=1) + "\n")
    log.info("planning pack: %.1f MB over %d jaw(s)", total / 1e6,
             sum(1 for j in header["jaws"].values() if j.get("ok")))
    return {"file": "planning/pack/header.json", "version": PACK_VERSION,
            "bytes": total,
            "jaws": {j: {"ok": bool(v.get("ok")),
                         **({"lattice": v["lattice"],
                             "references": v["references"]} if v.get("ok")
                            else {"reason": v.get("reason")})}
                     for j, v in header["jaws"].items()}}


def rebuild_label_fields(merged: np.ndarray, image, fits: dict, out_dir: Path,
                         edit: dict | None = None) -> dict:
    """Recompute only the LABEL-derived fields of an existing pack, in place.

    Called after a hand correction to the segmentation. Three things make this a partial
    rebuild rather than a `build()`:

    * **The band is frozen.** The lattice is read from the existing header, not
      recomputed, so `(s, t, z)` means exactly what it meant before the edit and every
      saved plan's coordinates still refer to the same place. `dentistry/arch.py`'s
      `revive_from_manifest` states the same argument for the polyline.
    * **The grey field does not change.** It is the SCAN. A label edit cannot move it,
      and re-sampling it would need the full-resolution greyscale volume, which is not
      retained past the job -- so re-deriving from `build()` was never an option.
    * **The density references are KEPT, and said to be kept.** They are measured from
      the greyscale inside the jaw mask, so a large edit could move them slightly and
      this cannot recompute them for the reason above. The header records that they
      predate the edit rather than presenting them as freshly measured.

    What IS recomputed is every distance field: the inferior alveolar canal, the
    accessory canals and the teeth. Those are the fields every clearance, every
    available-bone height and every verdict is read from, which is the whole point of
    letting a specialist move a contour at all.
    """
    from dentistry import labels as L

    out_dir = Path(out_dir) / "pack"
    hdr_path = out_dir / "header.json"
    if not hdr_path.is_file():
        raise FileNotFoundError(f"no pack to rebuild at {hdr_path}")
    header = json.loads(hdr_path.read_text())
    spacing_zyx = tuple(reversed(image.GetSpacing()))
    rebuilt: dict = {}
    # WHICH FIELDS the edit reaches. `plan_safety` widens the error budget of a
    # clearance only when the field it was measured to was actually touched, so it needs
    # this named rather than inferred -- and the index sets live here, not there.
    edited_indices = {int(k) for k in ((edit or {}).get("structures") or {})}
    fields_touched: set = set()

    for jaw, block in header.get("jaws", {}).items():
        if not block.get("ok"):
            continue
        fit = fits.get(jaw)
        if fit is None or not fit.ok:
            # The pack says this jaw is measurable and the manifest no longer does.
            # Refuse: silently leaving a stale distance field beside a live grey one is
            # how a clearance to a structure nobody re-measured gets published.
            raise ValueError(f"the pack has a {jaw} band but arch.json does not publish "
                             f"that jaw, so its fields cannot be rebuilt")
        lat = block["lattice"]
        lps = _band_points(fit, lat)
        band_box = _band_index_box(lps, image, merged.shape)
        fields = dict(block.get("fields") or {})
        # Every field except the greyscale is label-derived and is replaced. Dropped
        # first, so a structure that has been erased ENTIRELY loses its field rather
        # than keeping the pre-edit one -- an absent structure must read as absent.
        for name in ("canal", "accessory_canal", "tooth"):
            fields.pop(name, None)
        total = 0
        if jaw == "mandible":
            edt, box = _canal_edt(merged, spacing_zyx, L.MERGED_CANAL, band_box=band_box)
            if edt is not None:
                d = _edt_into_band(edt, box, lps, image)
                q = np.clip(d, 0, SAT_MM) * 1000.0
                cp = out_dir / f"{jaw}.canal.raw"
                np.ascontiguousarray(q, dtype=np.uint16).tofile(cp)
                fields["canal"] = {"file": f"pack/{jaw}.canal.raw", "dtype": "uint16",
                                   "scale": 0.001, "offset": 0.0, "unit": "mm",
                                   "saturates_mm": SAT_MM, "bytes": cp.stat().st_size}
                total += cp.stat().st_size
                del edt, d, q
            else:
                (out_dir / f"{jaw}.canal.raw").unlink(missing_ok=True)
            acc = sorted(L.ACCESSORY_CANALS)
            n = _write_fine_field(
                merged, spacing_zyx, acc, lps, image, out_dir, jaw, "accessory_canal",
                fields, "the nearest drawn accessory canal (incisive or lingual)",
                band_box=band_box)
            if not n:
                (out_dir / f"{jaw}.accessory_canal.raw").unlink(missing_ok=True)
            total += n
        tooth_ids = sorted(_jaw_tooth_indices(jaw))
        if tooth_ids:
            n = _write_fine_field(
                merged, spacing_zyx, tooth_ids, lps, image, out_dir, jaw, "tooth",
                fields, "the nearest drawn tooth of this jaw", band_box=band_box)
            if not n:
                (out_dir / f"{jaw}.tooth.raw").unlink(missing_ok=True)
            total += n
        del lps
        block["fields"] = fields
        if edited_indices:
            if "canal" in fields and int(L.MERGED_CANAL) in edited_indices:
                fields_touched.add("canal")
            for name in ("accessory_canal", "tooth"):
                idx = {int(i) for i in ((fields.get(name) or {}).get("indices") or [])}
                if idx & edited_indices:
                    fields_touched.add(name)
        refs = dict(block.get("references") or {})
        if edit:
            # STATED, not silently carried. These are greyscale statistics inside the
            # jaw mask, and the mask has just moved.
            refs["measured_before_edits"] = True
        block["references"] = refs
        rebuilt[jaw] = {"fields": sorted(fields), "bytes": total}

    if edit:
        # The pack's own record of what it is now. `plan_safety` reads this to widen the
        # error budget of every structure an edit touched, and `/measure` publishes it,
        # so a clearance to an edited contour can never be reported as if the model had
        # drawn it.
        edits = list(header.get("edits") or [])
        edits.append({**edit, "fields": sorted(fields_touched)})
        header["edits"] = edits
    hdr_path.write_text(json.dumps(header, indent=1) + "\n")
    # The pre-compressed copy is served in preference to its source while it is at least
    # as new; leaving a stale one here would serve the pre-edit header to every browser.
    gz = out_dir / "header.json.gz"
    if gz.exists():
        import gzip

        gz.write_bytes(gzip.compress(hdr_path.read_bytes(), 9))
    log.info("planning pack: rebuilt label fields on %d jaw(s)", len(rebuilt))
    return rebuilt


def attach_site_measurements(out_dir: Path, fits: dict, reports: dict, ridge) -> None:
    """Measure available bone per site and write it into BOTH published places.

    Runs after `build`, because it samples through the pack's own `ArraySampler` -- the
    same field `POST /measure` reads. Sampling the raw volume separately here would give
    a site's height and an implant's clearance two different provenances for the same
    scan, which is exactly the class of divergence this codebase keeps closing.

    `planning/arch.json` is rewritten in place rather than regenerated: `panoramic.render`
    owns its shape and this only adds keys under `sites`.

    Failures are contained per jaw. A site measurement that raises must cost the chart a
    number, never the plan tab and never the segmentation -- which is why the caller
    already wraps the whole planning block, and why this adds its own inner guard.
    """
    header_path = Path(out_dir) / "pack" / "header.json"
    arch_path = Path(out_dir) / "arch.json"
    if not header_path.is_file() or not arch_path.is_file():
        return
    header = json.loads(header_path.read_text())
    manifest = json.loads(arch_path.read_text())

    for jaw, info in (header.get("jaws") or {}).items():
        if not info.get("ok"):
            continue
        jaw_manifest = (manifest.get("jaws") or {}).get(jaw) or {}
        if not jaw_manifest.get("ok"):
            continue
        try:
            arrays = {}
            for name, spec in (info.get("fields") or {}).items():
                path = Path(out_dir) / spec["file"]
                if not path.is_file():
                    continue
                lat = info["lattice"]
                arrays[name] = np.fromfile(path, dtype=spec["dtype"]).reshape(
                    lat["n_s"], lat["n_t"], lat["n_z"])
            sampler = ArraySampler(header, jaw, arrays)
            measured = ridge.measure_sites(
                sampler, jaw_manifest, jaw, info.get("references") or {},
                jaw_manifest.get("canal"))
        except Exception as exc:  # noqa: BLE001
            log.exception("site measurement failed for the %s", jaw)
            measured = {}
            jaw_manifest["site_measurement_error"] = f"{type(exc).__name__}: {exc}"

        # Merge into the manifest's own `sites`, and mirror into `report.arch` so the
        # chart can colour without a second fetch.
        for fdi, entry in measured.items():
            (jaw_manifest.setdefault("sites", {}).setdefault(str(fdi), {})).update(entry)
        rep_jaw = ((reports.get("arch") or {}).get("jaws") or {}).get(jaw)
        if rep_jaw is not None:
            for fdi, entry in measured.items():
                (rep_jaw.setdefault("sites", {}).setdefault(str(fdi), {})).update(entry)
        n = sum(1 for e in measured.values() if e.get("height_mm") is not None)
        log.info("site measurement: %s -- %d of %d sites carry a height",
                 jaw, n, len(measured))

    arch_path.write_text(json.dumps(manifest) + "\n")


class ArraySampler:
    """The numpy-backed sampler, for the worker and the phantom suite.

    `dentistry/plan_metrics.py` is written against a Sampler protocol so the SAME
    formulas run here over numpy and in the API over an mmap. That is the only
    construction in which the server and the tests compute the same millimetre.
    """

    def __init__(self, header: dict, jaw: str, arrays: dict):
        self.h = header["jaws"][jaw]
        self.jaw = jaw
        self.arrays = arrays

    def header(self) -> dict:
        return self.h

    def _grid(self, stz):
        lat = self.h["lattice"]
        out = []
        for (s, t, z) in stz:
            out.append(((s - lat["s0_mm"]) / lat["step_mm"],
                        (t - lat["t_min_mm"]) / lat["step_mm"],
                        (lat["z_top_mm"] - z) / lat["step_mm"]))
        return np.asarray(out, dtype=np.float64).T

    def sample(self, field: str, stz) -> list:
        from scipy.ndimage import map_coordinates
        a = self.arrays[field]
        sc = self.h["fields"][field].get("scale", 1.0)
        v = map_coordinates(a.astype(np.float32), self._grid(stz), order=1,
                            mode="nearest")
        return [float(x) * sc for x in v]

    def bounds(self) -> dict:
        """The band's closed extent in (s, t, z) millimetres. Pure lattice arithmetic.

        Exists because the PICTURES are larger than the FIELD and both samplers used to
        clamp silently: cross-sections span t = +-18 mm over 68 mm of z while the band
        covers +-12 mm over 45 mm, so an implant dragged into the visible-but-unmeasured
        region came back with an edge-clamped value and no caveat at all.

        No I/O, so the mmap discipline in `api/planning_cache` is untouched.
        """
        lat = self.header()["lattice"]
        st = float(lat["step_mm"])
        s0 = float(lat["s0_mm"])
        t0 = float(lat["t_min_mm"])
        zt = float(lat["z_top_mm"])
        return {"s": (s0, s0 + (int(lat["n_s"]) - 1) * st),
                "t": (t0, t0 + (int(lat["n_t"]) - 1) * st),
                "z": (zt - (int(lat["n_z"]) - 1) * st, zt)}

    def contains(self, stz) -> list:
        """Per point: is this a SAMPLE, or would it be clamped to the band edge?"""
        b = self.bounds()
        out = []
        for (s, t, z) in stz:
            out.append(b["s"][0] <= s <= b["s"][1] and b["t"][0] <= t <= b["t"][1]
                       and b["z"][0] <= z <= b["z"][1])
        return out

    def overshoot(self, stz) -> dict:
        """How far outside the band the worst of these points lies, and on which axis.

        Reported rather than silently clamped, and per-axis rather than as a boolean,
        because "4.2 mm above the field" is actionable and "outside" is not.
        """
        b = self.bounds()
        worst, axis = 0.0, None
        n_out = 0
        for (s, t, z) in stz:
            over = 0.0
            ax = None
            for name, v in (("s", s), ("t", t), ("z", z)):
                lo, hi = b[name]
                d = max(lo - v, v - hi, 0.0)
                if d > over:
                    over, ax = d, name
            if over > 0.0:
                n_out += 1
                if over > worst:
                    worst, axis = over, ax
        total = max(1, len(list(stz)) if not hasattr(stz, "__len__") else len(stz))
        return {"outside_fraction": n_out / total, "worst_overshoot_mm": worst,
                "axis": axis}

    def gradient(self, field: str, stz, h: float) -> tuple:
        s, t, z = stz
        out = []
        for axis in range(3):
            d = [0.0, 0.0, 0.0]
            d[axis] = h
            a = self.sample(field, [(s + d[0], t + d[1], z + d[2])])[0]
            b = self.sample(field, [(s - d[0], t - d[1], z - d[2])])[0]
            out.append((a - b) / (2 * h))
        return tuple(out)
