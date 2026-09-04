"""Implant measurements. NUMPY-FREE ON PURPOSE.

The API image has neither numpy nor scipy -- `requirements-api.txt` is a recovery of
exactly what the deployed container has installed -- so everything `POST /measure`
executes must be standard library. The same functions run under a numpy-backed sampler
in the worker and the phantom suite, which is what stops the server and the checks
drifting into computing different millimetres. A subprocess test asserts the import
leaves `numpy` out of `sys.modules`; that test is what keeps the API deployable.

Every measurement carries a `basis` string saying exactly how it was obtained and a
`caveats` list. A non-empty `caveats` suppresses the verdict downstream -- see
`dentistry/plan_safety.py`. A number without its basis is the thing this module exists
to avoid.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field, asdict

# Sampling budgets. The axis is walked finely because the minimum is a point; the ring
# is coarse because it only refines an already-conservative bound.
AXIS_PITCH_MM = 0.10
N_AZIMUTH = 16
DENSITY_EPS = 1e-6
CORTICAL_RATIO = 1.35      # of (value - air) / (cancellous - air); a ratio, never HU
DISAGREE_MM = 1.0
DIRECTION_TIE = 0.15

# The band edge IS the edge of the field, so there is no grace: a "tolerance" here would
# be a made-up number. Reported as a fraction plus a worst overshoot rather than a
# boolean, because `bone_beyond_apex` walks 20 mm past the apex at 0.1 mm and partial
# containment is the norm there.
OUT_OF_BAND_TOL_MM = 0.0

# Conventional minima. Thresholds, never verdicts -- `plan_safety` decides.
ADJACENT_MIN_MM = 1.50          # implant surface to an adjacent tooth
INTER_IMPLANT_MIN_MM = 3.00     # implant surface to implant surface


@dataclass
class Measurement:
    value: float | None
    unit: str
    basis: str
    caveats: list = field(default_factory=list)
    detail: dict = field(default_factory=dict)

    def as_dict(self) -> dict:
        return asdict(self)


@dataclass
class Implant:
    """Stored in the ARCH frame, never LPS.

    `(s, t, z)` is the platform centre. Apical is -z for the mandible and +z for the
    maxilla -- LPS +z is superior by definition, so this needs no orientation lookup.
    `tilt` rotates the axis toward buccal (+t) WITHIN the section plane; `yaw` rotates it
    toward +s, out of the plane.

    Arch-frame is the stored form because with `yaw == 0` the implant lies entirely
    inside one cross-section, so the drag is genuinely 2-D in the picture rather than a
    projection of something else, the band sampling is analytic with no inverse map, and
    the browser and the server derive the pose from the same published numbers and
    therefore cannot disagree.
    """

    jaw: str
    s_mm: float
    t_mm: float
    z_mm: float
    length_mm: float
    diameter_mm: float
    tilt_deg: float = 0.0
    yaw_deg: float = 0.0
    id: str = "i1"
    site_fdi: int | None = None

    @property
    def radius_mm(self) -> float:
        return self.diameter_mm / 2.0

    def axis(self) -> tuple:
        """Unit apical direction in the (s, t, z) frame."""
        down = -1.0 if self.jaw == "mandible" else 1.0
        tl, yw = math.radians(self.tilt_deg), math.radians(self.yaw_deg)
        return (math.sin(yw),
                math.sin(tl) * math.cos(yw),
                down * math.cos(tl) * math.cos(yw))


def axis_span_mm(imp: Implant) -> float:
    """Length of the CAPSULE's axis segment: `length_mm - radius_mm`, floored at 0.

    The solid is the Minkowski sum of this segment with a ball of `radius_mm` -- a
    barrel from the platform to `length - r`, closed by an apical hemisphere. That is
    what `plan_geometry.implant_mesh` builds, what the STL exports and what
    `web/app.js::implantOutline` draws.

    This module used to walk a FULL-LENGTH cylinder to `u = length_mm` instead, so the
    solid that was measured was not the solid that was drawn or exported -- the same
    class of defect as the sheared export frame. Two consequences, both measured:

    * The clearance was over-conservative by up to `r`. On the committed phantom the
      true capsule clearance is 1.606 mm and the cylinder reported 1.000 -- 0.6 mm, 30%
      of the 2.00 mm margin, deducted a second time on top of the error budget
      `plan_safety.budget()` already applies explicitly.
    * For a canal directly below the apex -- a vertical posterior implant, the ordinary
      case -- the axis bound and the surface ring differed by EXACTLY `r` at every
      depth, so `DIRECTION_TIE` fired and the verdict was suppressed even at 12 mm of
      clearance. Never graded, at any depth.

    Adopting the capsule also makes the formula EXACT rather than a bound; see
    `canal_clearance`.
    """
    return max(0.0, imp.length_mm - imp.radius_mm)


def axis_points(imp: Implant, *, pitch: float = AXIS_PITCH_MM) -> list:
    """Points along the capsule's AXIS SEGMENT, `[0, axis_span_mm]`."""
    a = imp.axis()
    span = axis_span_mm(imp)
    n = max(2, int(round(span / pitch)) + 1)
    step = span / (n - 1) if n > 1 else 0.0
    return [(imp.s_mm + a[0] * u, imp.t_mm + a[1] * u, imp.z_mm + a[2] * u)
            for u in (i * step for i in range(n))]


def capsule_radius_at(imp: Implant, u_mm: float) -> float:
    """The solid's radius at depth `u_mm`: `r` on the barrel, shrinking over the dome."""
    span, r = axis_span_mm(imp), imp.radius_mm
    if u_mm <= span:
        return r
    over = min(u_mm - span, r)
    return math.sqrt(max(0.0, r * r - over * over))


def surface_ring(imp: Implant, u_mm: float, n_az: int = N_AZIMUTH) -> list:
    """`n_az` points on the CAPSULE surface at depth `u_mm` along the axis.

    Past `axis_span_mm` the ring lies on the apical hemisphere: its centre stays on the
    axis but its radius shrinks to `sqrt(r^2 - (u - span)^2)`, reaching a single point
    at `u = length_mm`. Sampling a full-radius ring out there would place points
    OUTSIDE the solid, which is what made the old bound and this ring disagree by `r`.
    """
    a = imp.axis()
    c = (imp.s_mm + a[0] * u_mm, imp.t_mm + a[1] * u_mm, imp.z_mm + a[2] * u_mm)
    # Any two unit vectors orthogonal to the axis will do; pick a stable pair.
    ref = (0.0, 0.0, 1.0) if abs(a[2]) < 0.9 else (1.0, 0.0, 0.0)
    e1 = _cross(a, ref)
    e1 = _unit(e1)
    e2 = _unit(_cross(a, e1))
    r = capsule_radius_at(imp, u_mm)
    out = []
    for i in range(n_az):
        th = 2 * math.pi * i / n_az
        out.append(tuple(c[k] + r * (math.cos(th) * e1[k] + math.sin(th) * e2[k])
                         for k in range(3)))
    return out


def _cross(u, v):
    return (u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0])


def _unit(v):
    n = math.sqrt(sum(c * c for c in v)) or 1.0
    return tuple(c / n for c in v)


def _band_caveat(sampler, pts, what: str) -> tuple[list, dict]:
    """A caveat naming the axis and the overshoot, or `([], {})` when fully contained.

    Both samplers clamp out-of-range coordinates -- `Field.at` by index and
    `ArraySampler.sample` by `mode="nearest"` -- so a point outside the band returns the
    value at the nearest edge with nothing to distinguish it from a measurement. Since a
    non-empty `caveats` suppresses the verdict downstream, routing this through the
    existing mechanism turns a confident wrong number into an explicit refusal that
    still shows the raw millimetres.
    """
    if not hasattr(sampler, "overshoot"):
        return [], {}                     # an older sampler; say nothing rather than guess
    o = sampler.overshoot(pts)
    if o["worst_overshoot_mm"] <= OUT_OF_BAND_TOL_MM:
        return [], {}
    axis = {"s": "along the arch", "t": "buccolingually",
            "z": "vertically"}.get(o["axis"], o["axis"])
    return ([f"{o['outside_fraction'] * 100:.0f}% of {what} lies outside the measured "
             f"band, by up to {o['worst_overshoot_mm']:.2f} mm {axis}; those samples are "
             f"read off the band edge rather than measured"],
            {"out_of_band": o})


def structure_clearance(sampler, imp: Implant, field: str, what: str) -> Measurement:
    """Clearance from the implant SURFACE to the nearest voxel of one field's structures.

    The same exact capsule identity `canal_clearance` documents -- `min(d_axis) - r` --
    against any of the pack's distance fields. Written once so the canal, the accessory
    canals and the teeth cannot end up measured three different ways.

    A saturated field value means the structure is simply not near this implant, which
    is reported as "no such structure within N mm" and NOT as a comfortable clearance.
    """
    spec = (sampler.header().get("fields") or {}).get(field)
    if spec is None:
        return Measurement(None, "mm",
                           f"this case's measurement pack has no {what} field",
                           [f"no {field!r} field in the measurement pack "
                            f"(packs built before it existed have none)"], {})
    pts = axis_points(imp)
    ds = sampler.sample(field, pts)
    k = min(range(len(ds)), key=lambda i: ds[i])
    span = axis_span_mm(imp)
    sat = spec.get("saturates_mm")
    caveats, detail = _band_caveat(sampler, pts, "the implant axis")
    detail.update({"axis_min_mm": ds[k], "radius_mm": imp.radius_mm,
                   "at_depth_mm": k * span / (len(pts) - 1) if len(pts) > 1 else 0.0})
    if sat is not None and ds[k] >= sat - 1e-6:
        # Same reasoning as `canal_clearance`: a bound, graded rather than refused.
        # These fields saturate at 12.70 mm, which is eight times the 1.50 mm adjacent
        # margin -- so "further than 10.65 mm" settles the question by itself.
        detail["saturated"] = True
        detail["at_least_mm"] = round(sat - imp.radius_mm, 3)
        return Measurement(None, "mm",
                           f"the nearest {what} is further than "
                           f"{sat - imp.radius_mm:.1f} mm from this implant, which is as "
                           f"far as this field reaches; a bound, not a measurement",
                           caveats, detail)
    return Measurement(round(ds[k] - imp.radius_mm, 3), "mm",
                       f"implant surface to the nearest drawn {what}; exact for the "
                       f"capsule solid this app draws and exports, to within 0.07 mm "
                       f"of axis discretisation",
                       caveats, detail)


def canal_clearance(sampler, imp: Implant, canal_block: dict | None) -> Measurement:
    """Millimetres from the implant SURFACE to the nearest drawn canal voxel. EXACT.

    The implant is a capsule -- the Minkowski sum of its axis SEGMENT with a ball of
    radius `r` (see `axis_span_mm`). For any set `S`, the distance from a Minkowski sum
    to `S` is the distance from the generator to `S` minus the ball's radius:

        d(capsule, S) = d(segment, S) - r      whenever d(segment, S) >= r

    and `d(segment, S) = min_u d(axis(u), S)`, which is exactly `min(ds)` below. So this
    is not a bound in any direction -- it is the answer, for the same solid the STL
    exports and the cross-section draws, to within

        pitch/2 + h^2/(8R)  =  0.05 + 0.019  =  0.069 mm

    of discretisation (`AXIS_PITCH_MM` and the trilinear-interpolation bound
    `worker/planning_pack` argues). Against the model's own 0.46 mm inward p95 that is
    two orders down, and the model error is deducted SEPARATELY and visibly in
    `plan_safety.budget()` -- which is the point. A second, unquantified conservatism
    folded into the measurement would make the published budget a fiction.

    This replaced a full-length-cylinder bound whose surface ring disagreed with it by
    exactly `r` on any apical approach, suppressing the verdict on every vertical
    implant over a canal. The ring is still sampled, but its job is now the opposite: a
    ring point can never be CLOSER than the capsule distance, so if it is, the field is
    not a true distance transform (a broken pack, or a sampler clamping at the band
    edge). That is a defect report, not an interval.
    """
    if "canal" not in sampler.header().get("fields", {}):
        return Measurement(None, "mm",
                           "this scan has no drawn inferior alveolar canal in this jaw",
                           ["no canal field in the measurement pack"], {})
    pts = axis_points(imp)
    ds = sampler.sample("canal", pts)
    k = min(range(len(ds)), key=lambda i: ds[i])
    span = axis_span_mm(imp)
    value = ds[k] - imp.radius_mm
    u = k * span / (len(pts) - 1) if len(pts) > 1 else 0.0
    ring = sampler.sample("canal", surface_ring(imp, u))
    ring_min = min(ring)

    caveats, detail = _band_caveat(sampler, pts, "the implant axis")
    detail.update({"axis_min_mm": ds[k], "at_depth_mm": u, "axis_span_mm": span,
                   "surface_min_mm": ring_min, "radius_mm": imp.radius_mm})

    # A SATURATED field is not a measurement and not a failure: it means the nearest
    # canal is further away than the field reaches. That has to be said as a BOUND
    # rather than as a number -- reporting the saturation value itself gave "63.48 mm
    # of clearance", the most reassuring figure this product can produce, from a field
    # that had simply run out of range.
    #
    # Measured on a real pack, the canal field is accurate to about 36 mm and saturates
    # beyond that (the transform is computed on the canal's own bounding box padded two
    # voxels, so points far outside it read as saturated). Against a 2.00 mm margin, a
    # clearance known to exceed 36 mm is unambiguously clear, so this is graded rather
    # than refused -- refusing it would withhold a verdict from the safest implants on
    # the case.
    sat = ((sampler.header().get("fields") or {}).get("canal") or {}).get("saturates_mm")
    if sat is not None and ds[k] >= sat - 1e-6:
        detail["saturated"] = True
        detail["at_least_mm"] = round(sat - imp.radius_mm, 3)
        return Measurement(None, "mm",
                           f"the nearest drawn inferior alveolar canal is further than "
                           f"{sat - imp.radius_mm:.1f} mm from this implant, which is as "
                           f"far as this field reaches; a bound, not a measurement",
                           caveats, detail)
    # The identity is one-sided: every ring point lies ON the capsule, so its distance
    # is >= the capsule's. A violation beyond discretisation means the field lied.
    if ring_min < value - DIRECTION_TIE:
        caveats.append(
            f"a point on the implant surface measures {ring_min:.2f} mm to the canal "
            f"while the solid as a whole measures {value:.2f} mm, which is impossible "
            f"for a true distance field -- the measurement pack may be damaged or the "
            f"implant may lie outside the measured band")
        detail["inconsistent_mm"] = [round(value, 3), round(ring_min, 3)]

    gap = gap_near_site_mm(canal_block, imp.s_mm) if canal_block else None
    if gap is not None:
        detail["gap_near_site_mm"] = gap

    return Measurement(round(value, 3), "mm",
                       "implant surface to the nearest drawn canal voxel; exact for the "
                       "capsule solid this app draws and exports, to within 0.07 mm of "
                       "axis discretisation",
                       caveats, detail)


def canal_presence_near(canal_block: dict, s_mm: float,
                        window_mm: float = 12.0) -> dict:
    """What the drawn canal is doing near this arc position, told apart properly.

    **The distinction this function exists to make.** A distance measured across a
    fragmented canal is not a clearance -- the drawing stops and the nearest voxel is
    then some way along the arch rather than across the bone. But an absence that runs
    past the END of a canal is not a fragment at all: it is the mental foramen. The
    inferior alveolar canal simply stops there, and measured on real cases the result is
    a **58 mm absence across the anterior mandible** (right canal drawn over
    s = -61.5..-27.0, left over s = +32.0..+62.0, on a 124 mm arch).

    The old version could not tell those apart. It returned the whole window -- 24.5 mm
    at a 0.5 mm step -- for every anterior site, `GAP_DISQUALIFIES_MM = 3.0` fired, and
    **every anterior site on every case was refused a verdict** with the message "the
    canal label is missing for 24.5 mm near this site, so the nearest drawn voxel may
    not be the nearest nerve". There is no nerve there to be near. A refusal that fires
    everywhere is not caution -- it teaches the reader to ignore refusals, which is
    worse than a false positive.

    **It has to be done PER SIDE**, and that is the subtlety. `side` is -1 for the
    patient's right canal and +1 for the left, and the two present runs are two
    DIFFERENT canals, not one canal with a hole in the middle. A first attempt at this
    tested only whether drawn canal existed somewhere before and somewhere after the
    absence, which is true across the midline for every case -- so it called the mental
    foramen an interior gap exactly as before. The right question is whether ONE side's
    canal has a break inside its own drawn extent.

    Returns `{"interior_gap_mm", "terminal", "any_present", "nearest_present_mm",
    "sides"}`, where `sides` gives each side's drawn extent in arc millimetres.
    """
    s_arr = canal_block.get("s_mm") or []
    present = canal_block.get("present") or []
    side = canal_block.get("side") or []
    if not s_arr or len(s_arr) != len(present):
        return {"interior_gap_mm": 0.0, "terminal": False, "any_present": False,
                "nearest_present_mm": None, "sides": {}}
    if len(side) != len(s_arr):
        side = [1 if p else 0 for p in present]      # no side attribution; one canal
    step = abs(s_arr[1] - s_arr[0]) if len(s_arr) > 1 else 1.0

    interior = 0.0
    extents: dict = {}
    for sd in (-1, 1):
        on = [i for i in range(len(s_arr)) if present[i] and int(side[i]) == sd]
        if not on:
            continue
        lo_i, hi_i = on[0], on[-1]
        extents[str(sd)] = [round(s_arr[lo_i], 2), round(s_arr[hi_i], 2)]
        # A break is an absent run STRICTLY INSIDE this side's own drawn extent, and
        # only one near enough to this site to bear on its clearance.
        run = 0
        for i in range(lo_i, hi_i + 1):
            if present[i] and int(side[i]) == sd:
                run = 0
                continue
            run += 1
            if abs(s_arr[i] - s_mm) <= window_mm:
                interior = max(interior, run * step)

    nearest = None
    for i, v in enumerate(present):
        if v:
            d = abs(s_arr[i] - s_mm)
            nearest = d if nearest is None else min(nearest, d)

    # Terminal: this site lies outside every drawn canal's extent, so there is no
    # inferior alveolar canal here to have a clearance to.
    inside_any = any(lo <= s_mm <= hi for lo, hi in extents.values())
    return {"interior_gap_mm": round(interior, 2),
            "terminal": (not inside_any) and bool(extents),
            "any_present": bool(extents),
            "nearest_present_mm": None if nearest is None else round(nearest, 2),
            "sides": extents}


def gap_near_site_mm(canal_block: dict, s_mm: float, window_mm: float = 12.0) -> float:
    """The longest INTERIOR run of missing canal label near this arc position.

    Kept as a thin name over `canal_presence_near` because it is what the verdict reads.
    Terminal absence -- the mental foramen -- returns 0.0 here and is reported
    separately; see that function for why conflating the two refused every anterior
    site on every case.
    """
    return canal_presence_near(canal_block, s_mm, window_mm)["interior_gap_mm"]


def approach_direction(sampler, imp: Implant, u_mm: float, curvature: float) -> str:
    """Which way the nearest canal lies, named for a surgeon rather than for an axis.

    `-grad(d)` at the argmin points at the nearest canal voxel. The band's `s` axis is
    CURVILINEAR, so a raw gradient over-weights the mesio-distal component: the true LPS
    direction needs `g_s / (1 + t * kappa)`. Without that correction the component is
    wrong by up to 1.9x at the band edge and a near-diagonal approach gets the wrong
    name. The name is withheld entirely when the top two components are within 15%.
    """
    a = imp.axis()
    p = (imp.s_mm + a[0] * u_mm, imp.t_mm + a[1] * u_mm, imp.z_mm + a[2] * u_mm)
    gs, gt, gz = sampler.gradient("canal", p, 0.3)
    scale = 1.0 + p[1] * (curvature or 0.0)
    gs = gs / scale if abs(scale) > 1e-6 else gs
    comps = {"mesial" if gs > 0 else "distal": abs(gs),
             "buccal" if -gt > 0 else "lingual": abs(gt),
             "apical" if -gz > 0 else "coronal": abs(gz)}
    order = sorted(comps.items(), key=lambda kv: -kv[1])
    if len(order) > 1 and order[0][1] > 0 and \
            (order[0][1] - order[1][1]) / order[0][1] < DIRECTION_TIE:
        return "between " + order[0][0] + " and " + order[1][0]
    return order[0][0]


def inter_implant_distance(a: dict, b: dict, arch: dict) -> Measurement:
    """Surface-to-surface between two implants. EXACT, with no segmentation error at all.

    Both solids are capsules -- the Minkowski sum of an axis segment with a ball -- so

        d(A, B) = d(segment_A, segment_B) - r_A - r_B

    is closed-form geometry between two things the USER placed. There is no sampling,
    no distance field and no model output anywhere in it, which is why it is the one
    measurement in this module that cannot false-positive, and why `plan_safety` grades
    it without deducting an inward error.

    **Computed in LPS, not in the arch frame, and that is not a detail.** In the band,
    `s` is arc length along the MID-LINE, so two points at the same buccolingual offset
    `t` and arc separation `ds` are really `2(R + t) sin(ds / 2R)` apart. At the band's
    own curvature limit (R = 12 mm) and `ds = 7 mm`, the arch frame reads 7.00 mm where
    the truth is 9.20 mm buccally and **4.60 mm lingually** -- so an arch-frame figure
    would pass a lingual pair that is actually 1.6 mm apart against a 3 mm minimum.
    That is a false negative on a safety criterion.

    Exact wherever the closest approach lies on either barrel or either apical dome;
    CONSERVATIVE at a platform, where the flat top means the true distance is larger
    than the segment-derived one. That is the same direction of error `canal_clearance`
    argues for, and it costs nothing: two platforms sit at the crest, where the
    mesio-distal gap is widest anyway.

    A NEGATIVE value means the solids interpenetrate. That is a real state a user can
    drag into and it is returned as such rather than floored at zero.
    """
    from dentistry import plan_geometry as G

    if a.get("jaw") != b.get("jaw"):
        return Measurement(None, "mm",
                           "the two implants are in different jaws",
                           ["a distance between an upper and a lower implant is not an "
                            "inter-implant distance"], {})
    info = (arch or {}).get(a.get("jaw"))
    if not info or not info.get("ok") or "points" not in info:
        return Measurement(None, "mm",
                           f"the {a.get('jaw')} arch was not reconstructed on this case",
                           ["no arch polyline, so neither implant has an LPS pose"], {})
    try:
        pa0, pa1 = G.implant_axis_lps(a, info)
        pb0, pb1 = G.implant_axis_lps(b, info)
    except ValueError as exc:
        return Measurement(None, "mm", str(exc), [str(exc)], {})

    d, sa, sb = G.segment_segment_distance(pa0, pa1, pb0, pb1)
    ra = float(a["diameter_mm"]) / 2.0
    rb = float(b["diameter_mm"]) / 2.0
    return Measurement(round(d - ra - rb, 3), "mm",
                       "implant surface to implant surface, in patient LPS; closed-form "
                       "geometry between two placed solids, with no segmentation and "
                       "therefore no model error in it",
                       [], {"axis_distance_mm": round(d, 4),
                            "radius_a_mm": ra, "radius_b_mm": rb,
                            "at_fraction_a": round(sa, 4), "at_fraction_b": round(sb, 4),
                            "interpenetrating": bool(d - ra - rb < 0)})


def density_ratio(sampler, imp: Implant, refs: dict) -> Measurement:
    """Affine-invariant, or absent. Never a Hounsfield number, never a Misch class.

    Calibration is `y = gain * x + offset`, so a plain ratio is NOT invariant.
    `(site - air) / (reference - air)` is: subtracting a common `air` cancels the offset
    and the ratio cancels the gain. Both operands come from THIS scan.

    CBCT grey values are not calibrated attenuation -- `worker/tf3.calibrate` measures
    gains from 0.47 to 2.60 across real scans -- so the same trabecular bone reads as a
    different absolute number on a different machine. A ratio against a population inside
    the same scan is the only density statement that survives that, and when the scan has
    no such population the honest answer is no number at all.
    """
    air, ref = refs.get("air"), refs.get("cancellous")
    if air is None or ref is None:
        return Measurement(None, "ratio",
                           refs.get("reason", "no cancellous reference in this scan"),
                           ["this scan has no usable reference population"], {})
    if abs(ref - air) < DENSITY_EPS:
        return Measurement(None, "ratio", "the reference population and air coincide",
                           ["reference and air are indistinguishable on this scan"], {})
    pts = []
    n = max(3, int(imp.length_mm / 1.0))
    for i in range(n):
        u = i * imp.length_mm / (n - 1)
        pts.extend(surface_ring(imp, u, n_az=8))
    vals = sampler.sample("grey", pts)
    mean = sum(vals) / len(vals)
    srt = sorted(vals)
    q = lambda f: srt[max(0, min(len(srt) - 1, int(f * (len(srt) - 1))))]
    caveats, detail = _band_caveat(sampler, pts, "the sampled implant surface")
    detail.update({"n": len(vals), "air": air, "reference": ref,
                   "iqr": [round(q(0.25), 1), round(q(0.75), 1)]})
    return Measurement(round((mean - air) / (ref - air), 4), "ratio",
                       "(site mean - air) / (cancellous median - air), both measured on "
                       "this scan; a common air cancels the offset and the ratio cancels "
                       "the gain, so it survives any linear recalibration",
                       caveats, detail)


def bone_beyond_apex(sampler, imp: Implant, refs: dict,
                     label_exit_mm: float | None = None) -> Measurement:
    """How far the bone continues past the apex, from the GREYSCALE.

    Not from the maxilla or sinus labels: both are FOV_LIMITED, their boundary is the
    edge of the scan rather than anatomy, and `labels.py` forbids measuring from them.
    The greyscale is walked apically in RATIO units -- so this is affine-invariant too --
    looking for a cortical peak and then its falling half-maximum edge. That edge, not
    the peak and not where the value reaches air, is the boundary that repeats.

    When a label boundary is available (the mandible has one) it CORROBORATES. If the two
    disagree by more than a millimetre both are reported and the caveat suppresses the
    verdict, rather than one being chosen.
    """
    air, ref = refs.get("air"), refs.get("cancellous")
    if air is None or ref is None:
        return Measurement(None, "mm", "no reference population, so no ratio profile",
                           ["this scan has no usable reference population"], {})
    a = imp.axis()
    step = 0.1
    prof, xs = [], []
    for i in range(int(20.0 / step) + 1):
        u = imp.length_mm + i * step
        p = (imp.s_mm + a[0] * u, imp.t_mm + a[1] * u, imp.z_mm + a[2] * u)
        xs.append(i * step)
        prof.append(p)
    vals = sampler.sample("grey", prof)
    ratio = [(v - air) / (ref - air) for v in vals]

    peak = None
    for i, r in enumerate(ratio):
        if r >= CORTICAL_RATIO:
            peak = i
            break
    if peak is None:
        band_cav, band_det = _band_caveat(sampler, prof, "the apical profile")
        return Measurement(None, "mm",
                           "no cortical plate found within 20 mm of the apex",
                           ["the apex may already be outside bone"] + band_cav,
                           {"max_ratio": round(max(ratio), 3), **band_det})
    half = (ratio[peak] + 1.0) / 2.0
    edge = None
    for i in range(peak, len(ratio)):
        if ratio[i] <= half:
            # linear interpolation onto the half-maximum
            r0, r1 = ratio[i - 1], ratio[i]
            frac = 0.0 if r0 == r1 else (r0 - half) / (r0 - r1)
            edge = xs[i - 1] + frac * step
            break
    if edge is None:
        edge = xs[-1]

    caveats, detail = _band_caveat(sampler, prof, "the apical profile")
    detail.update({"cortical_peak_ratio": round(ratio[peak], 3),
                   "method": "falling half-maximum of the cortical peak"})
    if label_exit_mm is not None:
        detail["label_exit_mm"] = round(label_exit_mm, 2)
        if abs(label_exit_mm - edge) > DISAGREE_MM:
            caveats.append(f"the greyscale edge ({edge:.2f} mm) and the label boundary "
                           f"({label_exit_mm:.2f} mm) disagree by "
                           f"{abs(label_exit_mm - edge):.2f} mm")
    basis = ("greyscale cortical profile past the apex, in ratio units so it is "
             "affine-invariant")
    if imp.jaw == "maxilla":
        basis += (". Greyscale only: the upper jawbone and both maxillary sinuses are "
                  "annotated to the edge of the scan rather than to anatomy, so no "
                  "label corroborates this")
    return Measurement(round(edge, 3), "mm", basis, caveats, detail)
