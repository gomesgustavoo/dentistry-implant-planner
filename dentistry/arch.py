"""The dental arch as a curve, and the frame that hangs off it.

Every view an implant plan is read on is defined relative to this curve. A
panoramic reconstruction is a slab swept along it; a buccolingual cross-section is
the plane perpendicular to it at one arc position; "site 46" is an arc position.
Nothing in this project fitted one before, so this module is the foundation the
whole planning surface stands on -- and the reason it refuses rather than guesses
is that a plausible-but-wrong curve silently rotates every cross-section, which is
the failure `worker/orient.py` exists to prevent.

Frames, stated once because everything below depends on them:

* the merged labelmap is (z, y, x) in the canonical **RPI** frame, so numpy axis 0
  runs superior->inferior, axis 1 anterior->posterior, axis 2 left->right;
* the curve is emitted in **LPS millimetres**, the frame the meshes, the RTSTRUCT
  and the viewer all already speak.

The fit is deliberately NOT a spline through tooth centroids. An implant patient is
by definition partially edentulous, so a centroid fit degrades exactly where the
feature is needed -- and it degrades quietly, by shortcutting across the gap that
the implant is going into. The mask's own mid-line is used instead, and the tooth
centroids are kept to VALIDATE the result.

The maxilla outline is never used for the maxillary arch. `labels.FOV_LIMITED`
records that its lateral extent is a scan boundary rather than anatomy -- 59% of
the upper-jawbone annotation sits in the top 3 mm of the training volumes -- so an
arc length measured from it would be measuring the field of view.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field

import numpy as np

from . import labels as L

STEP_MM = 0.5            # arc-length sampling of the emitted polyline
N_SECTORS = 180          # angular resolution of the mid-line sweep
OCCLUSAL_BAND = 0.60     # central fraction of the arch's tooth voxels
POLE_BEHIND_MM = 10.0    # how far posterior of the centroid the sweep pole sits
# Half-angle of the sweep. 90 degrees stops short of the third molars and leaves
# them 6.5-7.3 mm off the curve; 110 reaches them. Measured over five holdout
# cases, the residual p95 against the tooth centroids is 4.16 mm at 90 degrees and
# 2.53 mm at 110/10 mm, on a plateau wide enough (110-130 degrees x 10-15 mm all
# land within 0.06 mm) that this is a setting rather than a knife edge.
SWEEP_HALF_DEG = 110.0

# Refusal thresholds. An adult mandibular arch is roughly 90-130 mm of arc; the
# band is wide enough to admit a child or a resected jaw and narrow enough that a
# fit which wandered into the ramus or the skull base cannot pass.
MIN_ARC_MM, MAX_ARC_MM = 60.0, 200.0
MAX_INTERPOLATED = 0.25  # share of sectors allowed to be empty and filled in
# p95 distance from a present tooth's centroid to the curve. This is a
# gross-failure detector, not an accuracy certificate: a molar is ~10 mm
# buccolingually and its centroid legitimately sits a couple of mm off the
# mid-crest line, so good fits measure 1.2-3.3 mm. Broken ones are nowhere near
# that -- a 90-degree sweep that stops short of the third molars gives 6.8-11 mm
# and a teeth-only fit that shortcuts across an edentulous span gives 14.6 mm.
# 5.0 separates them with room on both sides.
MAX_RESIDUAL_MM = 5.0

UPPER_FDI = tuple(range(11, 19)) + tuple(range(21, 29))
LOWER_FDI = tuple(range(31, 39)) + tuple(range(41, 49))


@dataclass
class ArchFit:
    """A fitted arch, or the reason there is not one."""

    jaw: str
    ok: bool
    reason: str | None = None
    points: np.ndarray | None = None      # (N, 3) LPS mm, at the occlusal height
    tangents: np.ndarray | None = None    # (N, 3) unit, in the axial plane
    step_mm: float = STEP_MM
    s0_index: int = 0                     # index where s = 0 (mid-sagittal crossing)
    occlusal_z_mm: float | None = None
    arc_length_mm: float | None = None
    interpolated_sectors: int = 0
    residual_p95_mm: float | None = None
    sites: dict = field(default_factory=dict)

    @property
    def s(self) -> np.ndarray:
        """Arc position of each point, in mm, negative to the patient's right."""
        return (np.arange(len(self.points)) - self.s0_index) * self.step_mm

    def normals(self) -> np.ndarray:
        """Unit buccal-ish normal per point: the tangent rotated in the axial plane.

        Which of the two rotations points buccally is decided once, by the sign that
        moves AWAY from the arch's own centroid. Hard-coding a rotation direction
        would be right for one handedness and silently mirrored for the other.
        """
        t = self.tangents
        n = np.stack([-t[:, 1], t[:, 0], np.zeros(len(t))], axis=1)
        n = n / np.maximum(np.linalg.norm(n, axis=1, keepdims=True), 1e-9)
        centre = self.points[:, :2].mean(axis=0)
        outward = self.points[:, :2] - centre
        flip = np.sign((outward * n[:, :2]).sum(axis=1))
        flip[flip == 0] = 1.0
        return n * flip[:, None]

    def as_dict(self) -> dict:
        d = {"jaw": self.jaw, "ok": self.ok}
        if not self.ok:
            d["reason"] = self.reason
            return d
        d.update({
            "arc_length_mm": round(float(self.arc_length_mm), 2),
            "step_mm": self.step_mm,
            "s0_index": int(self.s0_index),
            "n_points": int(len(self.points)),
            "occlusal_z_mm": round(float(self.occlusal_z_mm), 2),
            "fit": {"method": "polar-midline", "sectors": N_SECTORS,
                    "interpolated_sectors": int(self.interpolated_sectors),
                    "residual_p95_mm": (None if self.residual_p95_mm is None
                                        else round(float(self.residual_p95_mm), 2))},
            "sites": {str(k): v for k, v in sorted(self.sites.items())},
        })
        return d


def _index_to_lps(origin, direction, spacing_xyz):
    """`(origin, M)` with `lps = origin + M @ [x, y, z]`."""
    o = np.asarray(origin, dtype=np.float64)
    d = np.asarray(direction, dtype=np.float64).reshape(3, 3)
    sp = np.asarray(spacing_xyz, dtype=np.float64)
    return o, d * sp[np.newaxis, :]


def _savgol(y: np.ndarray, window: int, order: int = 2) -> np.ndarray:
    """Savitzky-Golay on a PERIODIC signal -- wrapping matters, the sweep is angular."""
    from scipy.signal import savgol_filter

    window = min(window if window % 2 else window + 1, len(y) - (1 - len(y) % 2))
    if window <= order + 1:
        return y
    return savgol_filter(y, window, order, mode="wrap")


def _tooth_indices(jaw: str) -> list:
    fdi = UPPER_FDI if jaw == "maxilla" else LOWER_FDI
    return [L.BY_FDI[f].index for f in fdi if f in L.BY_FDI]


def _arch_mask(merged: np.ndarray, jaw: str):
    """`(mask_for_fitting, teeth_mask)` for this jaw.

    The mandible is a real anatomical object with a real boundary, so its own label
    is the best mid-line source. The maxilla is FOV-limited and must not define the
    arc, so the upper arch is fitted from its teeth alone.
    """
    teeth = np.zeros(merged.shape, dtype=bool)
    for idx in _tooth_indices(jaw):
        teeth |= merged == idx
    if jaw == "mandible":
        return (merged == L.MERGED_MANDIBLE) | teeth, teeth
    return teeth, teeth


def fit_arch(merged: np.ndarray, spacing_zyx, origin_xyz, direction,
             jaw: str = "mandible") -> ArchFit:
    """Fit one jaw's arch. Returns an `ArchFit` whose `ok` may be False."""
    def fail(why):
        return ArchFit(jaw=jaw, ok=False, reason=why)

    mask, teeth = _arch_mask(merged, jaw)
    if not mask.any():
        return fail(f"no {jaw} structures were found in this scan")
    if teeth.sum() < 50:
        return fail(f"too few {jaw} teeth to locate the occlusal plane")

    sp = np.asarray(spacing_zyx, dtype=np.float64)
    origin, M = _index_to_lps(origin_xyz, direction, sp[::-1])

    # --- 1. the occlusal band -------------------------------------------------
    zs = np.argwhere(teeth)[:, 0]
    lo_q, hi_q = (1.0 - OCCLUSAL_BAND) / 2.0, 1.0 - (1.0 - OCCLUSAL_BAND) / 2.0
    z_lo, z_hi = int(np.quantile(zs, lo_q)), int(np.quantile(zs, hi_q))
    if z_hi <= z_lo:
        z_lo, z_hi = int(zs.min()), int(zs.max()) + 1
    flat = mask[z_lo:z_hi + 1].any(axis=0)          # (y, x): the axial footprint
    if flat.sum() < 100:
        return fail("the occlusal band is empty once projected")

    # --- 2. the sweep, in millimetres -----------------------------------------
    pts = np.argwhere(flat).astype(np.float64) * np.array([sp[1], sp[2]])
    centre = pts.mean(axis=0)
    # Axis 1 increases posteriorly in RPI, so the horseshoe opens toward +axis1 and
    # its concavity -- the only place the footprint is star-shaped -- is behind the
    # centroid.
    pole = centre + np.array([POLE_BEHIND_MM, 0.0])

    rel = pts - pole
    ang = np.arctan2(rel[:, 1], -rel[:, 0])       # 0 = straight anterior
    rad = np.hypot(rel[:, 0], rel[:, 1])
    half = math.radians(SWEEP_HALF_DEG)
    edges = np.linspace(-half, half, N_SECTORS + 1)
    which = np.digitize(ang, edges) - 1
    inside = (which >= 0) & (which < N_SECTORS)
    which, rad_in = which[inside], rad[inside]

    order = np.argsort(which)
    which, rad_in = which[order], rad_in[order]
    bounds = np.searchsorted(which, np.arange(N_SECTORS + 1))
    mid = np.full(N_SECTORS, np.nan)
    for k in range(N_SECTORS):
        r = rad_in[bounds[k]:bounds[k + 1]]
        if r.size >= 3:
            # Midpoint of the radial extent: the mid-line between the buccal and
            # lingual walls, which is where an implant goes and where a panoramic
            # focal trough is centred.
            mid[k] = 0.5 * (r.min() + r.max())

    empty = int(np.isnan(mid).sum())
    if empty > MAX_INTERPOLATED * N_SECTORS:
        return fail(f"{empty} of {N_SECTORS} sectors are empty — the arch is too "
                    f"broken to fit (edentulous span or a cropped scan)")
    if empty:
        good = ~np.isnan(mid)
        mid = np.interp(np.arange(N_SECTORS), np.flatnonzero(good), mid[good])
    mid = _savgol(mid, window=max(5, N_SECTORS // 12))

    theta = 0.5 * (edges[:-1] + edges[1:])
    curve = pole + np.stack([-mid * np.cos(theta), mid * np.sin(theta)], axis=1)

    # --- 3. uniform arc length ------------------------------------------------
    seg = np.linalg.norm(np.diff(curve, axis=0), axis=1)
    arc = np.concatenate([[0.0], np.cumsum(seg)])
    total = float(arc[-1])
    if not (MIN_ARC_MM <= total <= MAX_ARC_MM):
        return fail(f"arc length {total:.0f} mm is outside the plausible "
                    f"{MIN_ARC_MM:.0f}-{MAX_ARC_MM:.0f} mm band")
    n_out = int(total / STEP_MM) + 1
    want = np.linspace(0.0, total, n_out)
    resampled = np.stack([np.interp(want, arc, curve[:, 0]),
                          np.interp(want, arc, curve[:, 1])], axis=1)

    # --- 4. back to LPS -------------------------------------------------------
    z_mid = 0.5 * (z_lo + z_hi)
    idx_yx = resampled / np.array([sp[1], sp[2]])
    ijk = np.stack([idx_yx[:, 1], idx_yx[:, 0], np.full(n_out, z_mid)], axis=1)
    lps = origin[None, :] + ijk @ M.T

    tang = np.gradient(lps, axis=0)
    tang[:, 2] = 0.0
    tang /= np.maximum(np.linalg.norm(tang, axis=1, keepdims=True), 1e-9)

    fit = ArchFit(jaw=jaw, ok=True, points=lps, tangents=tang,
                  occlusal_z_mm=float(lps[:, 2].mean()), arc_length_mm=total,
                  interpolated_sectors=empty)
    _orient_and_score(fit, merged, sp, origin, M, jaw)
    if fit.residual_p95_mm is not None and fit.residual_p95_mm > MAX_RESIDUAL_MM:
        return fail(f"the fitted curve misses the teeth by {fit.residual_p95_mm:.1f} mm "
                    f"at the 95th percentile (limit {MAX_RESIDUAL_MM})")
    return fit


def _orient_and_score(fit: ArchFit, merged, sp, origin, M, jaw: str) -> None:
    """Anchor s = 0 at the midline, sign s to the patient's right, and validate.

    The tooth centroids are the independent check: they were never used to build the
    curve, so their distance to it is a real residual rather than a restatement.
    """
    from scipy import ndimage

    lps = fit.points
    # Negative s is the patient's RIGHT, which is -x in LPS. Order the polyline so
    # index 0 is the most-right point and s increases leftward.
    if lps[0, 0] > lps[-1, 0]:
        fit.points = lps = lps[::-1].copy()
        fit.tangents = -fit.tangents[::-1].copy()
    fit.s0_index = int(np.argmin(np.abs(lps[:, 0] - 0.5 * (lps[0, 0] + lps[-1, 0]))))

    resid, sites = [], {}
    fdi_list = UPPER_FDI if jaw == "maxilla" else LOWER_FDI
    for f in fdi_list:
        st = L.BY_FDI.get(f)
        if st is None:
            continue
        m = merged == st.index
        if not m.any():
            sites[f] = {"present": False}
            continue
        cz, cy, cx = ndimage.center_of_mass(m)
        p = origin + M @ np.array([cx, cy, cz])
        d = np.linalg.norm(lps[:, :2] - p[None, :2], axis=1)
        k = int(np.argmin(d))
        resid.append(float(d[k]))
        sites[f] = {"present": True, "s_mm": round(float(fit.s[k]), 2)}

    # An absent tooth still has a site: interpolate its arc position from the present
    # neighbours, and SAY that it was interpolated. This is what makes the existing
    # FDI chart usable as an implant-site picker -- an implant site is by definition
    # a missing tooth, and `renderArch` currently skips exactly those.
    order = list(fdi_list)
    known = [(i, sites[f]["s_mm"]) for i, f in enumerate(order)
             if sites.get(f, {}).get("present")]
    if len(known) >= 2:
        xs = np.array([k[0] for k in known])
        ys = np.array([k[1] for k in known])
        for i, f in enumerate(order):
            if f in sites and not sites[f]["present"]:
                sites[f] = {"present": False, "interpolated": True,
                            "s_mm": round(float(np.interp(i, xs, ys)), 2)}
    fit.sites = sites
    fit.residual_p95_mm = float(np.percentile(resid, 95)) if resid else None


def revive_from_manifest(block: dict, jaw: str) -> "ArchFit":
    """An `ArchFit` rebuilt from a published `arch.json` jaw block.

    **The arch is FROZEN across a hand edit, and that is a decision rather than a
    shortcut.** A re-derive after a contour correction could re-fit the arch from the
    edited labelmap -- and then `s`, `t` and the section list would all mean something
    slightly different, so every saved plan's `(s, t, z)` would silently refer to a
    different place and two plans on the same case would stop being comparable. Freezing
    it keeps the coordinate contract, and the cost is stated: an edit does not move the
    curve the sections are cut along.

    So this reads the polyline the worker published and recomputes nothing that is in
    the manifest. `normals()` is the exception and it is deliberate: it is derived from
    the tangents by the same centroid rule the original fit used, and the caller can
    compare the result against the PUBLISHED `normals` to prove the revival landed on
    the same fit. `worker/rederive.py` does exactly that and refuses if it does not.
    """
    import numpy as np

    if not block or not block.get("ok"):
        return ArchFit(jaw=jaw, ok=False,
                       reason=(block or {}).get("reason") or "not fitted")
    pts = np.asarray(block["points"], dtype=np.float64)
    tang = np.asarray(block["tangents"], dtype=np.float64)
    return ArchFit(
        jaw=jaw, ok=True,
        points=pts,
        tangents=tang,
        step_mm=float(block["step_mm"]),
        s0_index=int(block["s0_index"]),
        occlusal_z_mm=float(block["occlusal_z_mm"]),
        arc_length_mm=float(block.get("arc_length_mm")
                            or (len(pts) - 1) * float(block["step_mm"])),
        sites={int(k): v for k, v in (block.get("sites") or {}).items()},
    )


def describe(fits: dict) -> dict:
    """The `report.arch` block: summary and site table, never the polyline."""
    return {"jaws": {name: f.as_dict() for name, f in fits.items()}}
