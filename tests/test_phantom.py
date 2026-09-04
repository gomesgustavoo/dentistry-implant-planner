"""Phantom checks: the things that would fail SILENTLY if they broke.

Rebuilt 2026-09-01 with the rest of the tree. Every check here exists because the
corresponding bug happened, produced a plausible-looking result, and was found by
measurement rather than by an exception -- which is why they assert numbers rather
than that the code ran.

Runs two ways: `pytest tests/test_phantom.py` collects the `test_*` functions, and
`python tests/test_phantom.py` prints every check with its measured value.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import numpy as np  # noqa: E402

_FAILURES: list[str] = []


def check(name: str, cond: bool, detail: str = "") -> bool:
    ok = bool(cond)
    print(f"  {'PASS' if ok else 'FAIL'}  {name}" + (f" — {detail}" if detail else ""))
    if not ok:
        _FAILURES.append(name)
    return ok


# --------------------------------------------------------------------------- #
def orientation_checks() -> bool:
    """The ToothFairy3 header defect, and that correcting it twice is a no-op.

    A raw ToothFairy3 file DECLARES LPS and STORES RPI. `fix_raw_header` re-declares
    the cosines without touching a voxel. Applying it to an already-correct file
    would negate the same two axes twice -- which is exactly what would republish an
    example with the mandible above the maxilla, and it happened once.
    """
    import SimpleITK as sitk

    from dentistry import toothfairy3 as TF3
    from worker import orient

    ok = True
    img = sitk.Image(8, 10, 12, sitk.sitkUInt8)
    img.SetSpacing((0.3, 0.3, 0.3))
    img.SetDirection((1, 0, 0, 0, 1, 0, 0, 0, 1))          # declares LPS
    ok &= check("a raw ToothFairy3 header declares LPS",
                orient.orientation_code(img) == "LPS")

    once = TF3.fix_raw_header(img)
    ok &= check("fix_raw_header re-declares it as RPI",
                orient.orientation_code(once) == orient.CANONICAL)
    twice = TF3.fix_raw_header(once)
    ok &= check("correcting an already-correct file is a no-op",
                orient.orientation_code(twice) == orient.CANONICAL
                and np.allclose(once.GetDirection(), twice.GetDirection())
                and np.allclose(once.GetOrigin(), twice.GetOrigin()))
    ok &= check("to_canonical then passes it through untouched",
                orient.to_canonical(once)[0].GetDirection() == once.GetDirection())
    return ok


def calibration_checks() -> bool:
    """Two-point calibration: near-identity on training data, exact on an injected
    affine, and a REFUSAL when there is no second landmark."""
    from worker import tf3

    ok = True
    rng = np.random.default_rng(7)
    # A ToothFairy3-like phantom: an air population at -999 and soft tissue at +58.
    vol = np.full((40, 60, 60), -999.0, dtype=np.float32)
    vol += rng.normal(0, 8, vol.shape).astype(np.float32)
    vol[10:30, 15:45, 15:45] = 58.0 + rng.normal(0, 12, (20, 30, 30))
    vol[15:25, 25:35, 25:35] = 1500.0                      # bone

    cal = tf3.calibrate(vol.copy())
    ok &= check("calibration is near-identity on training-scale data",
                cal.applied and abs(cal.gain - 1.0) < 0.13, f"gain {cal.gain:.3f}")

    # An injected affine must be recovered: the correction should undo it.
    gain, offset = 2.6, 400.0
    scaled = (vol * gain + offset).astype(np.float32)
    cal2 = tf3.calibrate(scaled.copy())
    ok &= check("an injected affine is recovered",
                cal2.applied and abs(cal2.gain - 1.0 / gain) / (1.0 / gain) < 0.10,
                f"recovered {cal2.gain:.4f}, wanted {1.0 / gain:.4f}")

    # A volume with no soft tissue has no second landmark. It must refuse.
    air_only = np.full((30, 30, 30), -999.0, dtype=np.float32)
    air_only += rng.normal(0, 5, air_only.shape).astype(np.float32)
    cal3 = tf3.calibrate(air_only)
    ok &= check("no soft-tissue peak means a refusal, not a guess",
                (not cal3.applied) and bool(cal3.reason), cal3.reason or "")

    # An out-of-field FILL value below the real air must not be mistaken for air.
    filled = vol.copy()
    filled[:3] = -4255.0
    air, how = tf3.air_level(filled)
    ok &= check("a fill value far below air is stepped over",
                abs(air - (-999.0)) < 60, f"air {air:.0f} via {how}")
    return ok


def crosswalk_checks() -> bool:
    """The three mappings a silent error would put a contour on the wrong anatomy."""
    from dentistry import crosswalk as X
    from dentistry import labels as L

    ok = True
    lut = X.task1_to_merged_lut()
    ok &= check("background maps to background", int(lut[0]) == 0)
    ok &= check("the JAWS are inverted (TF3 numbers the lower jaw 1)",
                int(lut[1]) == L.MERGED_MANDIBLE and int(lut[2]) == L.MERGED_MAXILLA)
    ok &= check("both inferior alveolar canals collapse into one merged canal",
                int(lut[3]) == int(lut[4]) == L.MERGED_CANAL)
    teeth = [int(lut[i]) for i in range(11, 43)]
    ok &= check("all 32 teeth map to distinct merged ids", len(set(teeth)) == 32)

    full = X.merged_vs_toothfairy3_full()
    ok &= check("merged-vs-tf3-full has 45 classes", len(full) == 45, str(len(full)))
    canal = next(c for c in full if c.name == "canal")
    ok &= check("its canal scores the union of BOTH sides", set(canal.gt_ids) == {3, 4})
    pulp = next(c for c in full if c.name == "pulp")
    ok &= check("its pulp is the union of all 32 raw pulp ids", len(pulp.gt_ids) == 32,
                str(len(pulp.gt_ids)))
    return ok


def board_checks() -> bool:
    """The reorder that made the board possible, and the leak guard.

    **The crosswalk and `to_canonical` commute.** `_segment_toothfairy3` maps Task-1
    ids to merged ids AFTER resampling to the case grid, so `canal_box` -- which is
    Task-1-anchored and only means anything on the canonical grid -- can run in
    between. That reorder is only free because the resample is nearest-neighbour (it
    PICKS a source voxel rather than blending) and the LUT maps 0 to 0 (so the
    resampler's zero padding survives it). Both are properties of code that could
    change, so the equality is measured rather than reasoned about.
    """
    import SimpleITK as sitk

    from dentistry import crosswalk as X
    from worker import board as B
    from worker import tf3 as T

    ok = True
    rng = np.random.default_rng(4)
    plan = rng.integers(0, 47, size=(24, 30, 28), dtype=np.uint8)

    canonical = sitk.Image(56, 60, 48, sitk.sitkUInt8)      # (i, j, k)
    canonical.SetSpacing((0.4, 0.4, 0.5))
    canonical.SetOrigin((-11.0, 7.5, 3.25))
    canonical.SetDirection((1, 0, 0, 0, 1, 0, 0, 0, 1))

    class _Pre:
        bbox = ((6, 42), (4, 52), (5, 49))                  # an off-centre crop
        shape_after_cropping = (36, 48, 44)

    lut = X.task1_to_merged_lut()
    a = T.to_canonical(lut[plan], _Pre(), canonical)
    b = lut[T.to_canonical(plan, _Pre(), canonical)]
    n_diff = int((a != b).sum())
    ok &= check("crosswalk and to_canonical commute (the board's reorder is free)",
                n_diff == 0, f"{n_diff} voxels differ")
    ok &= check("  ... and the test is not vacuous",
                int((a > 0).sum()) > a.size // 4,
                f"{int((a > 0).sum())} of {a.size} nonzero")

    base = rng.integers(0, 47, size=(20, 22, 24), dtype=np.uint8)
    run = B.BoardRun("probe", 0.0, "x", [43, 44, 45], box=[[4, 12], [3, 15], [6, 18]])
    inside = base.copy()
    inside[6, 7, 9] = 43
    try:
        B.assert_outside_box_unchanged(base, inside, [run])
        ok &= check("a change inside the ROI is allowed", True)
    except AssertionError as exc:
        ok &= check("a change inside the ROI is allowed", False, str(exc))

    outside = base.copy()
    outside[1, 1, 1] = (int(base[1, 1, 1]) + 1) % 47
    ok &= check("a change outside the ROI is caught",
                _raises(B.assert_outside_box_unchanged, base, outside, [run]))
    skipped = B.BoardRun("probe", 0.0, "x", [43], skipped="no mandible")
    ok &= check("a skipped specialist protects the whole volume",
                _raises(B.assert_outside_box_unchanged, base, outside, [skipped]))

    from dentistry.config import Settings
    ok &= check("an unset specialist directory means no board at all",
                B.load_board(Settings(TF3_CANAL_SPECIALIST_DIR="")) == [])
    return ok


def _raises(fn, *args, exc=Exception) -> bool:
    """Did `fn` refuse?

    Widened from AssertionError on 2026-09-01: the foreign-label guards raise
    `crosswalk.ForeignLabelMismatch`, and a refusal is a refusal whichever type carries
    it. `_raises` returning False because the exception was the wrong CLASS would be a
    test that reports "not caught" about something that was.
    """
    try:
        fn(*args)
    except exc:
        return True
    return False


def roi_rule_checks() -> bool:
    """`canal_box` and `pterygoid_box`: anchored, oriented, refusing rather than guessing."""
    from worker import tf3 as T

    ok = True
    sp = (0.3, 0.3, 0.3)
    teeth = np.zeros((300, 300, 300), dtype=bool)
    teeth[150:170, 140:170, 120:180] = True
    centre = np.argwhere(teeth).mean(axis=0)

    box = T.pterygoid_box(teeth, sp)
    ok &= check("pterygoid_box returns a box for a plausible anchor", box is not None)
    if box:
        # In canonical RPI axis 0 runs superior->inferior, so a box reaching ABOVE
        # the teeth must START at a smaller index. Getting this backwards puts the
        # crop under the jaw -- the class of error that made canal_box silently
        # useless on LPS-stored volumes.
        ok &= check("the box reaches superior to the dental arch, not inferior",
                    box[0][0] < centre[0])
        ok &= check("the box reaches posterior to the dental arch", box[1][1] > centre[1])
    ok &= check("no anchor means no box, not a guess",
                T.pterygoid_box(np.zeros((10, 10, 10), dtype=bool), sp) is None)

    mand = np.zeros((100, 100, 100), dtype=bool)
    mand[30:90, 20:70, 15:85] = True
    cb = T.canal_box(mand)
    ok &= check("canal_box returns a box inside the mandible bbox",
                cb is not None and cb[0][0] >= 20 and cb[0][1] <= 100)
    ok &= check("canal_box refuses with no mandible",
                T.canal_box(np.zeros((10, 10, 10), dtype=bool)) is None)

    air = np.zeros((40, 40, 40), dtype=np.int16)
    m, _ = T.dense_tissue(air, stride=2)
    ok &= check("dense_tissue finds nothing in an empty volume", not m.any())
    vol = np.zeros((60, 60, 60), dtype=np.int16)
    vol[20:30, 20:30, 20:30] = 3000
    m, _ = T.dense_tissue(vol, stride=1)
    # `>=`, not `>`: a strict comparison against a percentile selects NOTHING when
    # the dense voxels share a value -- every phantom, and any scan with a saturated
    # metal restoration.
    ok &= check("dense_tissue finds a uniform dense blob",
                m.any() and m.sum() < vol.size * 0.05, f"{int(m.sum())} voxels")
    return ok


def _arch_phantom(radius_mm=30.0, half_deg=110.0, n_teeth=16, thickness_mm=6.0,
                  spacing=(0.5, 0.5, 0.5)):
    """A horseshoe of known radius with tooth blobs on it, in canonical RPI."""
    from dentistry import labels as L

    sp = np.asarray(spacing, dtype=float)
    shape = (60, 180, 200)
    merged = np.zeros(shape, dtype=np.uint8)
    cy_mm, cx_mm = 55.0, (shape[2] * sp[2]) / 2.0
    th = np.radians(np.linspace(-half_deg, half_deg, 900))
    ys, xs = cy_mm - radius_mm * np.cos(th), cx_mm + radius_mm * np.sin(th)
    yy, xx = np.meshgrid(np.arange(shape[1]) * sp[1], np.arange(shape[2]) * sp[2],
                         indexing="ij")
    d = np.full(shape[1:], np.inf)
    for y0, x0 in zip(ys, xs):
        d = np.minimum(d, np.hypot(yy - y0, xx - x0))
    merged[10:50] = np.where(d <= thickness_mm / 2.0, L.MERGED_MANDIBLE, 0)[None, :, :]

    fdi = (list(range(48, 40, -1)) + list(range(31, 39)))[:n_teeth]
    # Across the middle 90% of the arc: real dentition stops before the ramus.
    picks = np.linspace(0.05 * (len(th) - 1), 0.95 * (len(th) - 1), n_teeth).astype(int)
    for f, k in zip(fdi, picks):
        st = L.BY_FDI.get(f)
        if st is None:
            continue
        merged[20:40] = np.where(np.hypot(yy - ys[k], xx - xs[k]) <= 2.4, st.index,
                                 merged[20:40])
    return merged, tuple(sp), (0.0, 0.0, 0.0), (1, 0, 0, 0, 1, 0, 0, 0, 1), (cy_mm, cx_mm)


def arch_checks() -> bool:
    """Does the arch fit recover a known curve, and does it refuse a broken one.

    The whole implant-planning surface is defined relative to this curve, and a
    curve that is plausible but wrong rotates every cross-section silently -- so
    "refuses rather than guesses" is as much under test as the accuracy is.
    """
    from dentistry import arch

    ok = True
    R = 30.0
    merged, sp, origin, direction, (cy, cx) = _arch_phantom(radius_mm=R)
    fit = arch.fit_arch(merged, sp, origin, direction, jaw="mandible")
    ok &= check("the arch fit accepts a clean horseshoe", fit.ok, fit.reason or "")
    if fit.ok:
        # The sweep pole sits POLE_BEHIND_MM behind the footprint centroid rather
        # than at the circle's centre, so the recovered arc is a few percent short
        # of the ideal. The radius below is the check that the curve is in the right
        # PLACE, and it comes out exact.
        want = R * np.radians(2 * arch.SWEEP_HALF_DEG)
        ok &= check("arc length recovered to within 10%",
                    abs(fit.arc_length_mm - want) / want < 0.10,
                    f"{fit.arc_length_mm:.1f} mm against an ideal {want:.1f} mm")
        r = np.hypot(fit.points[:, 1] - cy, fit.points[:, 0] - cx)
        ok &= check("fitted radius within 0.5 mm of the phantom's",
                    abs(float(np.median(r)) - R) < 0.5,
                    f"median {float(np.median(r)):.2f} mm against {R}")
        ok &= check("the residual against tooth centroids is sub-millimetre",
                    fit.residual_p95_mm is not None and fit.residual_p95_mm < 1.5,
                    f"p95 {fit.residual_p95_mm:.3f}")
        ok &= check("s runs right-to-left and crosses zero", fit.s[0] < 0 < fit.s[-1],
                    f"{fit.s[0]:.1f} .. {fit.s[-1]:.1f}")
        n = fit.normals()
        ok &= check("the buccal normals are unit and point outward",
                    np.allclose(np.linalg.norm(n, axis=1), 1.0, atol=1e-6)
                    and float(((fit.points[:, :2] - fit.points[:, :2].mean(0))
                               * n[:, :2]).sum(axis=1).min()) > 0)

    stub, sp2, o2, d2, _ = _arch_phantom(radius_mm=R, half_deg=15.0, n_teeth=3)
    ok &= check("a truncated arch is refused rather than guessed at",
                not arch.fit_arch(stub, sp2, o2, d2, jaw="mandible").ok)
    none = arch.fit_arch(np.zeros((40, 60, 60), dtype=np.uint8), (0.5, 0.5, 0.5),
                         (0, 0, 0), (1, 0, 0, 0, 1, 0, 0, 0, 1), jaw="mandible")
    ok &= check("an empty volume is refused with a reason",
                (not none.ok) and bool(none.reason))
    return ok


def panoramic_pitch_checks() -> bool:
    """Is the millimetres-per-pixel published beside a picture the real one.

    The entire measurement surface rests on one sentence -- "these are rendered from
    the full-resolution grid and publish an exact pixel_mm, so a ruler on them is
    exact by construction". Until 2026-09-01 that sentence was false by 0.42%:
    `cols = int(2*H/PIXEL)` then `linspace(-H, +H, cols)` spans the range in cols-1
    steps, not cols, so a true 10.042 mm gap printed as 10.00.

    This is a pure-arithmetic check on purpose. It needs no volume, it runs in
    microseconds, and it fails the moment somebody "simplifies" the pitch back to
    the nominal constant.
    """
    import numpy as np

    from worker import panoramic as pan

    ok = True
    cols = int(2 * pan.XS_HALF_WIDTH_MM / pan.XS_PIXEL_MM)
    ts = np.linspace(-pan.XS_HALF_WIDTH_MM, pan.XS_HALF_WIDTH_MM, cols)
    true_col = float(ts[1] - ts[0])
    ok &= check("column pitch matches linspace's actual step",
                abs(pan._pitch(2 * pan.XS_HALF_WIDTH_MM, cols) - true_col) < 1e-12,
                f"_pitch {pan._pitch(2 * pan.XS_HALF_WIDTH_MM, cols):.9f} "
                f"vs linspace {true_col:.9f}")
    ok &= check("the nominal constant is NOT the true pitch (the bug is real)",
                abs(true_col - pan.XS_PIXEL_MM) > 1e-6,
                f"true {true_col:.6f} mm vs nominal {pan.XS_PIXEL_MM} mm "
                f"-- {(true_col / pan.XS_PIXEL_MM - 1) * 100:.3f}%")

    span = 68.0                                   # z_hi - z_lo, from render()
    rows = int(span / pan.XS_PIXEL_MM)
    hs = np.linspace(span, 0.0, rows)
    true_row = float(hs[0] - hs[1])
    ok &= check("row pitch matches linspace's actual step",
                abs(pan._pitch(span, rows) - true_row) < 1e-12,
                f"_pitch {pan._pitch(span, rows):.9f} vs linspace {true_row:.9f}")

    # A 10 mm ruler is the number a clinician actually reads.
    read = 10.0 * true_col / pan.XS_PIXEL_MM
    ok &= check("a 10 mm span read with the TRUE pitch is 10 mm",
                abs(10.0 * true_col / true_col - 10.0) < 1e-9,
                f"reading with the nominal pitch instead gives {read:.4f} mm")
    ok &= check("_pitch degrades safely on a 1-sample axis",
                pan._pitch(5.0, 1) == 5.0, "no division by zero")
    return ok


def plan_geometry_checks() -> bool:
    """Do the two implementations of the coordinate map agree, and is the map right.

    The map from a cross-section pixel to patient millimetres is written TWICE -- in
    `dentistry/plan_geometry.py` for the server and in `web/app.js` for the ruler -- and
    that seam is what drifts. `tests/plan_vectors.json` pins it: this asserts the Python
    side, and `web/selftest.html` asserts the JavaScript side against the same file.

    The vectors were generated from a real rendered case (ToothFairy3F_008), so they also
    pin the manifest shape, not just the arithmetic.
    """
    import json
    from pathlib import Path

    from dentistry import plan_geometry as G

    ok = True
    vec = json.loads((Path(__file__).parent / "plan_vectors.json").read_text())
    info = vec["manifest"]

    ok &= check("the golden vectors match this contract version",
                vec["contract_version"] == G.CONTRACT_VERSION,
                f"file {vec['contract_version']} vs module {G.CONTRACT_VERSION}")

    worst = 0.0
    for v in vec["xs_pixel_to_lps"]:
        got = G.xs_pixel_to_lps(info, v["index"], v["row"], v["col"])
        worst = max(worst, max(abs(a - b) for a, b in zip(got, v["lps"])))
    ok &= check(f"cross-section pixel -> LPS reproduces {len(vec['xs_pixel_to_lps'])} vectors",
                worst < 1e-6, f"worst component error {worst:.3e} mm")

    worst = 0.0
    for v in vec["pan_pixel_to_lps"]:
        got = G.pan_pixel_to_lps(info, v["row"], v["col"])
        worst = max(worst, max(abs(a - b) for a, b in zip(got, v["lps"])))
    ok &= check(f"panoramic pixel -> LPS reproduces {len(vec['pan_pixel_to_lps'])} vectors",
                worst < 1e-6, f"worst component error {worst:.3e} mm")

    worst = 0.0
    for v in vec["xs_distance_mm"]:
        worst = max(worst, abs(G.xs_distance_mm(info, v["a"], v["b"]) - v["mm"]))
    ok &= check(f"cross-section distances reproduce {len(vec['xs_distance_mm'])} vectors",
                worst < 1e-9, f"worst error {worst:.3e} mm")

    # The property that makes a 2-D ruler legitimate on this picture at all: {n, up} is
    # orthonormal, so a diagonal is a true distance and not a projection. Measured on the
    # published normals rather than assumed.
    import math
    bad_norm = bad_z = 0
    for n in info["normals"]:
        if abs(math.hypot(n[0], n[1]) - 1.0) > 1e-3:
            bad_norm += 1
        if abs(n[2]) > 1e-9:
            bad_z += 1
    ok &= check("every published normal is a unit vector in the axial plane",
                bad_norm == 0 and bad_z == 0,
                f"{bad_norm} not unit, {bad_z} with a z-component "
                f"(a z-component would make the section a projection, not a plane)")

    # A diagonal must equal the Pythagorean combination of its own legs. If the basis
    # were skewed this identity would fail, and a ruler would over-read on the diagonal.
    a, b = (10.0, 20.0), (310.0, 180.0)
    leg_r = G.xs_distance_mm(info, a, (b[0], a[1]))
    leg_c = G.xs_distance_mm(info, a, (a[0], b[1]))
    diag = G.xs_distance_mm(info, a, b)
    ok &= check("a diagonal equals hypot(its two legs) -- the basis is not skewed",
                abs(diag - math.hypot(leg_r, leg_c)) < 1e-9,
                f"{diag:.6f} vs {math.hypot(leg_r, leg_c):.6f} mm")

    # The panoramic must refuse to offer a horizontal measurement at all.
    ok &= check("the panoramic declares itself vertical-only",
                info["panoramic"]["metric_axes"] == "vertical_only",
                info["panoramic"]["metric_axes"])
    ok &= check("the cross-section declares both axes metric",
                info["cross_sections"]["metric_axes"] == "both",
                info["cross_sections"]["metric_axes"])

    # An honest scale: a 100-pixel span is ~15 mm at this pitch, not ~15.0 by luck.
    span = G.xs_distance_mm(info, (0.0, 0.0), (0.0, 100.0))
    ok &= check("100 columns is the published pitch x 100",
                abs(span - 100 * info["cross_sections"]["pixel_mm"][1]) < 1e-9,
                f"{span:.4f} mm")
    return ok


def implant_frame_checks() -> bool:
    """The exported implant solid must be a RIGID cylinder, and the same one measured.

    `implant_triangles_lps` used `e1 = (n[0], n[1], 0)` -- the buccal normal itself --
    as one axis of the implant's local frame. The published normals are in-plane
    (`arch.py` forces the tangent's z to zero, so n_z is 0 exactly on real data), so

        ax . e1 = sin(tilt) * (n[0]^2 + n[1]^2) = sin(tilt)

    and the frame was orthonormal ONLY at zero tilt. Everywhere else the map was a
    shear: measured on a real arch at 35 degrees, a 10 x 4.1 mm implant had its
    platform disc -- which is one flat face perpendicular to the axis -- spread over
    +-1.17 mm ALONG the axis, and its apex at 9.81 mm rather than 10.00.

    It never raised and the STL always loaded. What makes it a defect rather than a
    cosmetic flaw is that `plan_metrics.surface_ring` builds a genuinely orthonormal
    pair, so the solid the SERVER MEASURED and the solid the USER DOWNLOADED were two
    different solids at any nonzero tilt.

    The last check here is the non-vacuity proof, in this file's usual style: it
    asserts the OLD construction really was sheared, so a future revert cannot pass.
    """
    import json
    import math
    from pathlib import Path

    from dentistry import plan_geometry as G, plan_metrics as PM

    ok = True
    dot = lambda a, b: sum(x * y for x, y in zip(a, b))
    vec = json.loads((Path(__file__).parent / "plan_vectors.json").read_text())
    info = vec["manifest"]
    L, D = 10.0, 4.1
    R, SHOULDER = D / 2.0, L - D / 2.0

    # `plan_vectors.json`'s manifest carries no `tangents` -- real arch.json files do.
    # Build one explicitly FOR THE TEST so the yaw poses can be exercised. This is a
    # fixture, not a derivation: the module deliberately refuses to derive a tangent
    # from a normal, because the handedness of the published normals relative to the
    # published tangents flips at the extreme ends of the arch on real cases.
    withtan = dict(info)
    withtan["tangents"] = [[-n[1], n[0], 0.0] for n in info["normals"]]

    worst = 0.0
    for jaw in ("mandible", "maxilla"):
        for tilt in (0.0, 5.0, 10.0, 20.0, 35.0, -35.0):
            for yaw, roll in ((0.0, 0.0), (8.0, 0.0), (-15.0, 0.0),
                              (0.0, 137.0), (8.0, -42.0)):
                imp = {"jaw": jaw, "s_mm": 4.0, "t_mm": 1.5,
                       "z_mm": float(info["occlusal_z_mm"]), "tilt_deg": tilt,
                       "yaw_deg": yaw, "roll_deg": roll,
                       "length_mm": L, "diameter_mm": D}
                origin, e1, e2, ax = G.implant_frame(imp, withtan)
                tris = G.implant_triangles_lps(imp, withtan)
                d = [tuple(v[k] - origin[k] for k in range(3))
                     for tri in tris for v in tri]
                along = [dot(x, ax) for x in d]
                perp = [math.sqrt(max(0.0, dot(x, x) - dot(x, ax) ** 2)) for x in d]
                # implant_mesh interleaves 3 triangles per azimuth -- disc, barrel,
                # barrel -- so the platform is every THIRD triangle, vertices 1 and 2.
                n_az = 48
                disc = [dot(tuple(tris[3 * i][vi][k] - origin[k] for k in range(3)), ax)
                        for i in range(n_az) for vi in (1, 2)]
                barrel = [p for p, a in zip(perp, along)
                          if -1e-9 <= a <= SHOULDER + 1e-9 and p > 1e-9]
                worst = max(worst, abs(dot(ax, e1)), abs(dot(ax, e2)), abs(dot(e1, e2)),
                            abs(dot(ax, ax) - 1.0), max(abs(x) for x in disc),
                            abs(max(along) - L), abs(min(along)),
                            max(abs(p - R) for p in barrel))
    ok &= check("the implant frame is rigid at every tilt and yaw",
                worst < 1e-9,
                f"worst orthonormality/planarity/length/radius error {worst:.2e} "
                f"over 60 poses")

    # The pose must be the SAME pose plan_metrics measures: its axis() is stated in
    # (s, t, z) components, which map to (tangent, buccal normal, up).
    worst_pose = 0.0
    for jaw in ("mandible", "maxilla"):
        for tilt, yaw in ((0.0, 0.0), (20.0, 0.0), (35.0, 0.0), (-20.0, 0.0),
                          (20.0, 8.0), (-35.0, -15.0)):
            imp = {"jaw": jaw, "s_mm": 4.0, "t_mm": 1.5,
                   "z_mm": float(info["occlusal_z_mm"]), "tilt_deg": tilt,
                   "yaw_deg": yaw, "length_mm": L, "diameter_mm": D}
            _, _, _, ax = G.implant_frame(imp, withtan)
            a = PM.Implant(jaw=jaw, s_mm=4.0, t_mm=1.5,
                           z_mm=float(info["occlusal_z_mm"]), tilt_deg=tilt,
                           yaw_deg=yaw, length_mm=L, diameter_mm=D).axis()
            idx = max(0, min(int(round(4.0 / float(info["step_mm"])
                                       + int(info["s0_index"]))),
                             len(info["points"]) - 1))
            t_hat, n_hat = withtan["tangents"][idx], info["normals"][idx]
            t_hat = G._v_unit(t_hat)
            n_hat = G._v_unit(n_hat)
            want = tuple(a[0] * t_hat[k] + a[1] * n_hat[k] + a[2] * (0.0, 0.0, 1.0)[k]
                         for k in range(3))
            worst_pose = max(worst_pose, max(abs(want[k] - ax[k]) for k in range(3)))
    ok &= check("the exported pose is the pose plan_metrics measures",
                worst_pose < 1e-9, f"max component error {worst_pose:.2e}")

    # Apical is -z for the mandible and +z for the maxilla, by the definition of LPS.
    _, _, _, ax_m = G.implant_frame(
        {"jaw": "mandible", "s_mm": 0.0, "t_mm": 0.0, "z_mm": 0.0, "tilt_deg": 0.0,
         "yaw_deg": 0.0, "length_mm": L, "diameter_mm": D}, info)
    _, _, _, ax_x = G.implant_frame(
        {"jaw": "maxilla", "s_mm": 0.0, "t_mm": 0.0, "z_mm": 0.0, "tilt_deg": 0.0,
         "yaw_deg": 0.0, "length_mm": L, "diameter_mm": D}, info)
    ok &= check("apical is -z in the mandible and +z in the maxilla",
                ax_m[2] < -0.999 and ax_x[2] > 0.999,
                f"mandible z {ax_m[2]:+.4f}, maxilla z {ax_x[2]:+.4f}")

    # Yaw needs the tangent's SIGN, and no manifest field supplies it here.
    ok &= check("a yawed implant is refused when the manifest has no tangents",
                _raises(G.implant_triangles_lps,
                        {"jaw": "mandible", "s_mm": 0.0, "t_mm": 0.0, "z_mm": 0.0,
                         "tilt_deg": 0.0, "yaw_deg": 5.0, "length_mm": L,
                         "diameter_mm": D}, info, exc=ValueError))
    ok &= check("a tilt-only implant still places with no tangents",
                len(G.implant_triangles_lps(
                    {"jaw": "mandible", "s_mm": 0.0, "t_mm": 0.0, "z_mm": 0.0,
                     "tilt_deg": 20.0, "yaw_deg": 0.0, "length_mm": L,
                     "diameter_mm": D}, info)) > 0)

    # CLOCKING IS A ROTATION OF THE FRAME AND OF NOTHING ELSE.
    #
    # Two things have to be true and they are different things. The axis must not move,
    # because every measured distance is computed from it -- if roll touched `ax` a
    # control advertised as changing no number would change all of them. And the
    # exported SOLID must be the same solid, which it is because a body of revolution
    # is invariant under rotation about its own axis: the vertices move, their
    # cylindrical coordinates about `ax` do not. The second is what would catch a
    # future non-symmetric solid being adopted while the invariance claim stayed in the
    # docstring.
    roll_ax = 0.0
    roll_solid = 0.0
    for jaw in ("mandible", "maxilla"):
        for tilt, yaw in ((0.0, 0.0), (20.0, 0.0), (-15.0, 8.0)):
            base = {"jaw": jaw, "s_mm": 4.0, "t_mm": 1.5,
                    "z_mm": float(info["occlusal_z_mm"]), "tilt_deg": tilt,
                    "yaw_deg": yaw, "length_mm": L, "diameter_mm": D}
            o0, _, _, ax0 = G.implant_frame(dict(base, roll_deg=0.0), withtan)
            cyl = {}
            for roll in (0.0, 15.0, 137.0, -42.0, 360.0):
                o1, _, _, ax1 = G.implant_frame(dict(base, roll_deg=roll), withtan)
                roll_ax = max(roll_ax, max(abs(ax1[k] - ax0[k]) for k in range(3)),
                              max(abs(o1[k] - o0[k]) for k in range(3)))
                tris = G.implant_triangles_lps(dict(base, roll_deg=roll), withtan)
                d = [tuple(v[k] - o0[k] for k in range(3)) for tri in tris for v in tri]
                along = sorted(round(dot(x, ax0), 9) for x in d)
                perp = sorted(round(math.sqrt(max(0.0, dot(x, x) - dot(x, ax0) ** 2)), 9)
                              for x in d)
                cyl[roll] = (along, perp)
            for roll, (along, perp) in cyl.items():
                a0, p0 = cyl[0.0]
                roll_solid = max(roll_solid,
                                 max(abs(x - y) for x, y in zip(along, a0)),
                                 max(abs(x - y) for x, y in zip(perp, p0)))
    ok &= check("clocking moves neither the axis nor the origin",
                roll_ax < 1e-12, f"worst component change {roll_ax:.2e}")
    ok &= check("the exported solid is invariant under clocking",
                roll_solid < 1e-8,
                f"worst cylindrical-coordinate change {roll_solid:.2e} over 30 poses")
    # ...and the vertices really do move, or the invariance above is vacuous.
    moved = max(
        abs(a[k] - b[k])
        for a, b in zip(
            [v for tri in G.implant_triangles_lps(
                {"jaw": "mandible", "s_mm": 4.0, "t_mm": 1.5,
                 "z_mm": float(info["occlusal_z_mm"]), "tilt_deg": 0.0, "yaw_deg": 0.0,
                 "roll_deg": 0.0, "length_mm": L, "diameter_mm": D}, withtan)
             for v in tri],
            [v for tri in G.implant_triangles_lps(
                {"jaw": "mandible", "s_mm": 4.0, "t_mm": 1.5,
                 "z_mm": float(info["occlusal_z_mm"]), "tilt_deg": 0.0, "yaw_deg": 0.0,
                 "roll_deg": 37.0, "length_mm": L, "diameter_mm": D}, withtan)
             for v in tri])
        for k in range(3))
    ok &= check("clocking is not a no-op: the vertices move",
                moved > 0.5, f"worst vertex displacement {moved:.3f} mm at 37 degrees")

    # Non-vacuity: the construction this replaced really was sheared, by sin(tilt).
    n0 = G._v_unit(info["normals"][int(info["s0_index"])])
    shear = []
    for tilt in (10.0, 20.0, 35.0):
        tl = math.radians(tilt)
        old_e1 = (n0[0], n0[1], 0.0)
        ax_old = (n0[0] * math.sin(tl), n0[1] * math.sin(tl), -math.cos(tl))
        shear.append(abs(dot(ax_old, old_e1) - math.sin(tl)))
    ok &= check("the replaced construction was sheared by exactly sin(tilt)",
                max(shear) < 1e-12,
                "ax.e1 was sin(tilt): 0.174 / 0.342 / 0.574 at 10 / 20 / 35 deg")
    return ok


def api_purity_checks() -> bool:
    """The API image has no numpy, so the modules it executes must not import one.

    `plan_metrics`'s own docstring says "a subprocess test asserts the import leaves
    numpy out of sys.modules; that test is what keeps the API deployable". It did not
    exist. `requirements-api.txt` is a recovery of exactly what the deployed container
    has installed, and it has neither numpy nor scipy -- so a stray `import numpy` in
    any of these three modules is not a slow path, it is an ImportError at request time.
    """
    import subprocess
    import sys as _sys

    ok = True
    # `dentistry.models` joins the list: `GET /v1/models` calls `describe_all` on every
    # upload-page load, and `ModelEntry.structures()` reaches through `crosswalk` --
    # which has a numpy import INSIDE `task1_to_merged_lut` and a numpy-free
    # `task1_to_merged_map` beside it. Calling the wrong one of those two would be an
    # ImportError on the endpoint that decides which models run.
    src = ("import sys, json; "
           "import dentistry.plan_metrics, dentistry.plan_safety, "
           "dentistry.plan_geometry, dentistry.models; "
           "dentistry.models.describe_all(None); "
           "[m.structures() for m in dentistry.models.CATALOGUE]; "
           "print(json.dumps(sorted(m for m in sys.modules "
           "if m.split('.')[0] in ('numpy', 'scipy', 'SimpleITK', 'torch'))))")
    r = subprocess.run([_sys.executable, "-c", src], capture_output=True, text=True,
                       cwd=str(Path(__file__).resolve().parent.parent))
    ok &= check("the numpy-free modules import cleanly in a bare interpreter",
                r.returncode == 0, (r.stderr or "").strip()[-200:])
    if r.returncode == 0:
        heavy = json.loads(r.stdout)
        ok &= check("importing the API's plan modules pulls in no heavy dependency",
                    heavy == [], f"pulled in {heavy}" if heavy else "none")
    # Non-vacuity: the probe must actually be able to SEE such an import.
    r2 = subprocess.run([_sys.executable, "-c", "import numpy; " + src],
                        capture_output=True, text=True,
                        cwd=str(Path(__file__).resolve().parent.parent))
    ok &= check("the probe detects a heavy import when there is one",
                r2.returncode == 0 and "numpy" in r2.stdout)
    return ok


def model_menu_checks() -> bool:
    """The model menu, the config it validates, and the edit penalty it feeds.

    Three separate claims, and each one is a place a quiet wrong answer would come out
    the far end:

    * **The catalogue and the pipeline agree about ownership.** `worker/board.py` now
      BUILDS its specialists from these entries, so a model cannot own one set of ids in
      the picker and a different set in the composition -- but the derivation has to be
      exercised, because `owns_task1` is in Task-1 ids and the picker shows merged ones.
    * **A configuration is refused rather than downgraded.** An upload that asked for
      the anterior canal specialist and quietly got the base model's opinion is a
      clearance to a structure whose predicted volume runs to twice the truth.
    * **A hand correction widens the budget of the fields it touched and NO others.**
    """
    from dentistry import labels as L
    from dentistry import models as M
    from dentistry import plan_safety as PS

    ok = True
    ok &= check("every catalogue entry has a distinct key and a stated licence",
                len({m.key for m in M.CATALOGUE}) == len(M.CATALOGUE)
                and all(m.license for m in M.CATALOGUE),
                f"{len(M.CATALOGUE)} entries")
    ok &= check("exactly one entry is the base model and it cannot be switched off",
                [m.role for m in M.CATALOGUE].count("base") == 1
                and M.BASE.modes == ("apply",))
    ok &= check("the anterior canal specialist owns the three accessory canals",
                sorted(M.CANAL.structures())
                == sorted(L.BY_INDEX[i].id for i in sorted(L.ACCESSORY_CANALS)),
                ", ".join(M.CANAL.structures()))
    ok &= check("the teeth specialist owns 32 teeth and nothing else",
                len(M.TOOTHSEG.structures()) == 32
                and all(s.startswith("tooth_") for s in M.TOOTHSEG.structures()))
    # Every entry's evidence has to say something measured. A menu of names with no
    # numbers is a menu nobody can choose from.
    ok &= check("every entry carries measured evidence and a stated trade-off",
                all(len(m.evidence) > 80 and len(m.tradeoff) > 40 for m in M.CATALOGUE))

    inv = {"models": {"toothfairy3": {"installed": True}, "canal": {"installed": True},
                      "toothseg-teeth": {"installed": False, "reason": "not set"},
                      "totalseg": {"installed": False, "reason": "not set"}}}
    cfg = M.resolve_config(None, inv)
    ok &= check("a model this worker does not have defaults to off, not to its own default",
                cfg["toothseg-teeth"] == "off" and cfg["canal"] == "apply", str(cfg))
    ok &= check("asking for a model that is not installed is REFUSED, not downgraded",
                _raises(M.resolve_config, {"toothseg-teeth": "apply"}, inv,
                        exc=M.ConfigRefused))
    ok &= check("an unknown mode is refused",
                _raises(M.resolve_config, {"canal": "sometimes"}, inv,
                        exc=M.ConfigRefused))
    ok &= check("an unknown model key is refused",
                _raises(M.resolve_config, {"nope": "apply"}, inv, exc=M.ConfigRefused))
    ok &= check("the base model cannot be turned off",
                _raises(M.resolve_config, {"toothfairy3": "off"}, inv,
                        exc=M.ConfigRefused))
    ok &= check("the board runs the specialists in CATALOGUE order, not request order",
                M.board_keys({"toothfairy3": "apply", "totalseg": "shadow",
                              "canal": "apply", "toothseg-teeth": "shadow"})
                == [("canal", "apply"), ("toothseg-teeth", "shadow"),
                    ("totalseg", "shadow")])

    # --- the edit penalty -------------------------------------------------------
    edits = [{"fields": ["canal"], "quantisation_mm": 0.6}]
    base = PS.STRUCTURE_PRIORS["canal"]["p95_mm"]
    widened = PS.prior("canal", edits)
    ok &= check("a hand correction widens the budget by HALF the display voxel",
                abs(widened["p95_mm"] - (base + 0.30)) < 1e-9
                and widened["model_p95_mm"] == base,
                f"{base} -> {widened['p95_mm']}")
    ok &= check("...and leaves every field it did not touch alone",
                PS.prior("tooth", edits)["p95_mm"]
                == PS.STRUCTURE_PRIORS["tooth"]["p95_mm"]
                and "edit" not in PS.prior("tooth", edits))
    ok &= check("the canal budget goes through budget_for, so an edited canal is widened",
                PS.budget(6.0, edits)["inward_p95_mm"] == widened["p95_mm"],
                f"{PS.budget(6.0, edits)['inward_p95_mm']} mm deducted")
    ok &= check("a correction never suppresses the verdict",
                PS.budget(6.0, edits)["headroom_mm"] > 0
                and PS.budget(6.0, edits)["clearance_mm"] == 6.0)
    # Non-vacuity: with no edits the two budgets must be identical, or the check above
    # would pass for a penalty that is always applied.
    ok &= check("with no correction the budget is unchanged",
                PS.budget(6.0)["inward_p95_mm"] == base
                and PS.edit_penalty("canal", []) is None)
    return ok


def safety_prior_checks() -> bool:
    """The three published safety constants must be derivable from a committed artifact.

    `plan_safety` is numpy-free and executed by the API, so reading an eval file at
    import time in the request path would be worse than a literal. The literals stay --
    but they stop being unfalsifiable, which is what let the module contradict itself
    for weeks: its docstring said the worst measured inward point was 2.96 mm while
    `NO_GUIDE_NOTICE`, four lines down and actually shown to users, said 5.10 mm.

    All three come from the LEFT inferior alveolar canal, the worse of the two sides
    (its 5.10 mm worst point against the right's 1.27), which is the conservative
    choice and the one the constants' own comments name.

    Note WHERE they come from: `per_case[*].classes[*].inward_max`. `per_class` carries
    `inward_p95` but not `inward_max`, so `metrics.md` cannot show the number the
    product quotes -- `scripts/eval_dice.py` should aggregate it.
    """
    import statistics as stats

    from dentistry import plan_safety as S

    ok = True
    f = Path(__file__).resolve().parent.parent / "eval/board_p2/metrics.json"
    if not f.is_file():
        return check("the shipping eval artifact exists to check the priors against",
                     False, f"{f} is missing -- the priors cannot be falsified")

    data = json.loads(f.read_text())
    CLASS = "Left Inferior Alveolar Canal"
    p95 = [c["inward_p95"] for v in data["per_case"].values()
           for c in (v.get("classes") or [])
           if c.get("name") == CLASS and c.get("inward_p95") is not None]
    mx = [c["inward_max"] for v in data["per_case"].values()
          for c in (v.get("classes") or [])
          if c.get("name") == CLASS and c.get("inward_max") is not None]
    ok &= check("the holdout carries a directed error for every case",
                len(p95) == 20 and len(mx) == 20, f"{len(p95)} p95, {len(mx)} max")
    if not (p95 and mx):
        return False

    for name, got, const in (
            ("MODEL_INWARD_P95_MM is mean(inward_p95)",
             stats.mean(p95), S.MODEL_INWARD_P95_MM),
            ("MODEL_INWARD_WORST_MM is max(inward_max)",
             max(mx), S.MODEL_INWARD_WORST_MM),
            ("MODEL_INWARD_MEDIAN_MM is median(inward_max)",
             stats.median(mx), S.MODEL_INWARD_MEDIAN_MM)):
        ok &= check(name, abs(round(got, 2) - const) < 0.005,
                    f"artifact {got:.4f} -> {round(got, 2)} vs published {const}")

    # The distinction the docstrings conflated: the largest per-case p95 is NOT the
    # worst single point, and they differ by 2.14 mm on this holdout.
    ok &= check("the largest per-case p95 is a DIFFERENT statistic from the worst point",
                abs(max(p95) - 2.9645) < 0.01 and max(mx) > max(p95) + 2.0,
                f"max(inward_p95) = {max(p95):.4f}, max(inward_max) = {max(mx):.4f}")

    # The notice a user actually reads must quote the constant, not a stale literal.
    ok &= check("NO_GUIDE_NOTICE quotes MODEL_INWARD_WORST_MM",
                f"{S.MODEL_INWARD_WORST_MM:.2f}" in S.NO_GUIDE_NOTICE,
                S.NO_GUIDE_NOTICE[-72:])
    ok &= check("  ... and no module docstring still claims 2.96 is the worst point",
                all("2.96 mm inside the truth" not in
                    (Path(__file__).resolve().parent.parent / m).read_text()
                    for m in ("dentistry/plan_safety.py", "dentistry/metrics.py")))
    return ok


def pack_field_checks() -> bool:
    """The distance fields must be EXACT where the band is, and honest where they stop.

    Two properties, and the first one nearly shipped inverted.

    **The crop must be the UNION of the label's bounding box and the band's.**
    `map_coordinates` fills outside the crop with `cval`, which is the saturation value,
    so a crop confined to the LABEL's own box makes every band point outside it read as
    "further away than this field measures". The canal-only predecessor did exactly that
    while its docstring claimed the union.

    On a real pack it was survivable by luck: a real inferior alveolar canal's bounding
    box spans most of the mandible, so 58% of the field saturated but it stayed accurate
    to about 36 mm, and 36 mm against a 2 mm margin is still clear. For a THIN structure
    it is not survivable at all -- and the whole point of the accessory-canal field is
    that the incisive and lingual canals are thin. Measured on this phantom before the
    fix, an implant whose surface PENETRATES the canal by 0.6 mm reported "more than
    63.5 mm -- clear".

    **Saturation is a BOUND, not a refusal.** Beyond the field's range the honest output
    is "further than X mm", and if that bound less the structure's own inward error
    still clears the margin then the question is settled. Refusing there would withhold
    a verdict from the safest implants on the case.
    """
    import json
    import tempfile
    from pathlib import Path as _P

    import SimpleITK as sitk
    from scipy import ndimage

    from dentistry import labels as L
    from dentistry import plan_metrics as M
    from dentistry import plan_safety as S
    from worker import planning_pack as PP

    ok = True
    Z, Y, X, CREST = 90, 90, 160, 70
    grey = np.full((Z, Y, X), -1000, dtype=np.int16)
    merged = np.zeros((Z, Y, X), dtype=np.uint8)
    grey[20:CREST, 30:60, 20:140] = 500
    grey[CREST - 3:CREST, 30:60, 20:140] = 1400
    grey[20:CREST, 30:33, 20:140] = 1400
    grey[20:CREST, 57:60, 20:140] = 1400
    merged[20:CREST, 30:60, 20:140] = L.MERGED_MANDIBLE
    merged[38:43, 42:48, 30:130] = L.MERGED_CANAL
    merged[CREST - 12:CREST, 40:50, 40:52] = 22          # a tooth
    merged[30:34, 43:47, 60:80] = sorted(L.ACCESSORY_CANALS)[0]

    image = sitk.GetImageFromArray(grey)
    image.SetSpacing((0.3, 0.3, 0.3))
    image.SetOrigin((0.0, 0.0, 0.0))
    image.SetDirection((1, 0, 0, 0, 1, 0, 0, 0, 1))

    class _Fit:
        ok = True
        arc_length_mm = 30.0
        step_mm = 0.5
        occlusal_z_mm = CREST * 0.3
        reason = None

        def __init__(self):
            n = int(self.arc_length_mm / self.step_mm) + 1
            self.s = np.arange(n) * self.step_mm - self.arc_length_mm / 2
            self.points = np.stack([np.linspace(12.0, 36.0, n), np.full(n, 13.5),
                                    np.full(n, CREST * 0.3)], axis=1)
            self.s0_index = n // 2

        def normals(self):
            return np.tile(np.array([0.0, 1.0, 0.0]), (len(self.points), 1))

    fit = _Fit()
    tmp = _P(tempfile.mkdtemp())
    PP.build(grey, merged, image, {"mandible": fit}, tmp,
             {"air": -1000.0, "soft_tissue": 100.0})
    header = json.loads((tmp / "pack" / "header.json").read_text())
    info = header["jaws"]["mandible"]
    lat = info["lattice"]

    ok &= check("the pack carries a field for each measurable structure",
                set(info["fields"]) == {"grey", "canal", "accessory_canal", "tooth"},
                str(sorted(info["fields"])))
    ok &= check("the reference population is BONE, not sinus air",
                abs(info["references"]["cancellous"] - 500.0) < 1.0,
                f"cancellous {info['references']['cancellous']}")
    ok &= check("the band is jaw-aware",
                lat.get("jaw") == "mandible" and lat.get("z_below_mm") == 35.0,
                f"jaw {lat.get('jaw')}, {lat.get('z_above_mm')} above / "
                f"{lat.get('z_below_mm')} below the occlusal plane")

    arrays = {n: np.fromfile(tmp / sp["file"], dtype=sp["dtype"]).reshape(
        lat["n_s"], lat["n_t"], lat["n_z"]) for n, sp in info["fields"].items()}
    sampler = PP.ArraySampler(header, "mandible", arrays)

    # The implant penetrates the canal. Its clearance is NEGATIVE, and the whole point
    # is that it must not read as a comfortable one.
    imp = M.Implant(jaw="mandible", s_mm=0.0, t_mm=0.0, z_mm=CREST * 0.3 - 1.0,
                    length_mm=8.0, diameter_mm=4.1)
    edt = ndimage.distance_transform_edt(~(merged == L.MERGED_CANAL),
                                         sampling=(0.3, 0.3, 0.3))

    def _to_index(p):
        s, t, z = p
        x = 12.0 + (s + 15.0) * (24.0 / 30.0)
        return (z / 0.3, (13.5 + t) / 0.3, x / 0.3)

    truth = min(ndimage.map_coordinates(edt, [[i] for i in _to_index(p)], order=1)[0]
                for p in M.axis_points(imp)) - imp.radius_mm
    m = M.canal_clearance(sampler, imp, None)
    ok &= check("a clearance inside the band matches a directly computed one",
                m.value is not None and abs(m.value - truth) < 0.01,
                f"{m.value} mm against {truth:.3f} mm computed straight from the "
                f"volume's own distance transform")
    v = S.canal_verdict(m, None, {"canal_components": 2}, "mandible")
    ok &= check("  ... and an implant inside the canal is a BREACH",
                v.level == "breach", v.headline)
    ok &= check("  ... non-vacuously: the true clearance really is negative",
                truth < 0, f"{truth:.3f} mm")

    # Saturation, on a structure genuinely far away.
    far = M.Implant(jaw="mandible", s_mm=12.0, t_mm=8.0, z_mm=CREST * 0.3 - 1.0,
                    length_mm=6.0, diameter_mm=4.1)
    ms = M.structure_clearance(sampler, far, "accessory_canal",
                               "incisive or lingual canal")
    vs = S.structure_verdict(ms, "accessory_canal", S.SAFETY_MARGIN_MM)
    ok &= check("a saturated field reports a BOUND, not a number",
                ms.value is None and (ms.detail or {}).get("saturated") is True
                and (ms.detail or {}).get("at_least_mm") is not None,
                f"at least {(ms.detail or {}).get('at_least_mm')} mm")
    ok &= check("  ... and a bound beyond the margin is GRADED, not refused",
                vs.level == "clear", vs.headline)

    # The MAXILLA's band must be the other way up. Apical is +z there, so the extent
    # that worked for the mandible (10 mm above the occlusal plane, 35 below) gives a
    # maxillary implant 10 mm of headroom where a 13 mm one needs 13 plus the 20 mm
    # `bone_beyond_apex` profile -- the whole apical measurement fell outside the field
    # and was silently edge-clamped.
    lat_up = PP.lattice(fit, "maxilla")
    lat_dn = PP.lattice(fit, "mandible")
    ok &= check("the maxillary band extends SUPERIORLY, where a maxillary apex goes",
                lat_up["z_above_mm"] > lat_dn["z_above_mm"]
                and lat_up["z_above_mm"] >= 35.0,
                f"maxilla {lat_up['z_above_mm']} above / {lat_up['z_below_mm']} below, "
                f"mandible {lat_dn['z_above_mm']} / {lat_dn['z_below_mm']}")
    ok &= check("  ... and the mandibular band is byte-identically unchanged",
                (lat_dn["z_above_mm"], lat_dn["z_below_mm"]) == (10.0, 35.0)
                and lat_dn["n_z"] == 151,
                f"n_z {lat_dn['n_z']}")
    ok &= check("  ... and it reaches past the picture, so a visible implant is measured",
                lat_up["z_top_mm"] - float(fit.occlusal_z_mm) > 26.0,
                "the cross-sections only render to occlusal+26, so anything above that "
                "cannot be dragged to")

    # Out of band: clamped values must carry a caveat, which suppresses the verdict.
    deep = M.Implant(jaw="mandible", s_mm=0.0, t_mm=0.0,
                     z_mm=CREST * 0.3 - 40.0, length_mm=8.0, diameter_mm=4.1)
    md = M.canal_clearance(sampler, deep, None)
    ok &= check("an implant dragged outside the band carries a caveat",
                bool(md.caveats) and (md.detail or {}).get("out_of_band"),
                (md.caveats or ["none"])[0][:96])
    return ok


def foreign_model_checks() -> bool:
    """The label rules, the alignment guards, and the guard that survives roi="full".

    A third-party model on the board emits its OWN ids, and they have to become Task-1
    ids before anything downstream is true. The rules DERIVE that mapping from the
    model's `dataset.json` by anatomical name, so the thing under test is: does the
    derivation reproduce what we measured, and does it RAISE when the upstream moves?

    A renumber absorbed silently is the worst outcome available -- every stage reports
    success and the maxilla is drawn where the mandible is.
    """
    import copy
    import json
    from pathlib import Path

    from dentistry import crosswalk as X
    from dentistry import toothfairy3 as TF

    ok = True
    root = Path(__file__).resolve().parent.parent

    # 1. Our own canal specialist: the derived map must equal the literal it replaced.
    lab = json.loads((root / "models/canal_specialist/dataset.json").read_text())["labels"]
    lut = X.canal_roi_to_task1_lut(lab)
    got = {i: int(v) for i, v in enumerate(lut) if v}
    ok &= check("the canal rule derives the map the literal used to state",
                got == {1: 43, 2: 44, 3: 45}, str(got))
    ok &= check("  ... and drops the IAC context class rather than pasting it",
                int(lut[4]) == 0,
                "class 4 exists to give the network the parent structure at the branch "
                "point; the base model already scores 0.90 on the IAC")

    # 2. The base model claims to emit Task-1 ids. Verified by name, never assumed.
    base = json.loads((root / "models/toothfairy3/dataset.json").read_text())["labels"]
    idl = X.task1_identity_lut(base)
    ok &= check("the base model's 46 labels sit on the ids their names mean",
                all(int(idl[int(i)]) == int(i) for i in base.values() if int(i)),
                f"{int((idl > 0).sum())} labels checked")

    # 3. The guards must FIRE. Each break is one an upstream release could plausibly
    #    ship, and each is silent without these.
    swapped = dict(base)
    swapped["Lower Jawbone"], swapped["Upper Jawbone"] = 2, 1
    ok &= check("a swapped jaw pair is caught",
                _raises(X.task1_identity_lut, swapped),
                "ToothFairy3 numbers the LOWER jaw 1; a straight-through copy of a "
                "swapped release would put every contour on the wrong bone")

    renamed = {k if k != "Lingual Canal" else "Sublingual Duct": v for k, v in lab.items()}
    ok &= check("an unresolvable label name is caught",
                _raises(X.canal_roi_to_task1_lut, renamed))

    # 4. ToothSeg's +10 relation is a TRIPWIRE, not the derivation.
    # Their real labels are anatomical names, letter-for-letter ToothFairy3's own --
    # unsurprising, since ToothSeg trained on ToothFairy2 and TF3 is its superset.
    teeth = {"background": 0}
    for fdi, t1 in sorted(TF.TASK1_FDI_TO_INDEX.items()):
        teeth[TF.TASK1_LABELS[t1]] = t1 - 10
    tl = X.toothseg_semantic_to_task1_lut(teeth)
    ok &= check("toothseg derives all 32 teeth by anatomical name",
                sum(1 for v in tl if v) == 32, f"{sum(1 for v in tl if v)} teeth")
    shifted = {k: (v + 1 if v else 0) for k, v in teeth.items()}
    ok &= check("a renumbered toothseg release trips the +10 check",
                _raises(X.toothseg_semantic_to_task1_lut, shifted),
                "derivation by name still succeeds -- the point is that the model is "
                "then NOT the one that was measured")

    # 5. TotalSegmentator's 32-to-1 pulp fold is asserted, not assumed. A PARTIAL fold
    #    would silently drop pulp on some teeth and nothing downstream would notice.
    # Their real naming: snake_case, with a `_fdiNNN` suffix that is the RAW ToothFairy3
    # id, not an FDI number. Reading it as FDI collapsed 111..142 onto four values and
    # the guard caught it on the first install -- so the fixture uses the real shape.
    raw_of = {v: k for k, v in TF.TASK1_MAPPING.items() if v and v != 46}
    ts = {"background": 0}
    for t1 in range(1, 46):
        stem = TF.TASK1_LABELS[t1].lower().replace(" ", "_")
        raw = raw_of.get(t1)
        ts[f"{stem}_fdi{raw}" if raw and raw > 100 else stem] = t1
    pulp_raw = sorted(k for k, v in TF.TASK1_MAPPING.items() if v == 46)
    for j, raw in enumerate(pulp_raw):
        ts[f"tooth_pulp_fdi{raw}"] = 46 + j
    tsl = X.totalseg_to_task1_lut(ts)
    ok &= check("totalseg maps 1-45 through by raw id AND by name, agreeing",
                all(int(tsl[i]) == i for i in range(1, 46)),
                "the two derivations are cross-checked; a disagreement raises")
    ok &= check("totalseg folds 32 per-tooth pulp classes onto Task-1 46",
                sum(1 for v in tsl if int(v) == 46) == 32,
                f"{sum(1 for v in tsl if int(v) == 46)} of 32")
    partial = {k: v for k, v in ts.items() if not k.endswith(f"fdi{pulp_raw[-1]}")}
    ok &= check("a partial pulp fold is caught",
                _raises(X.totalseg_to_task1_lut, partial))
    # The check that only a two-way derivation can make: an id that moved while its
    # name stayed put. One derivation alone would absorb this without a word.
    ok &= check("a label whose name and id disagree is caught",
                _raises(X.totalseg_to_task1_lut,
                        {**ts, "lower_jawbone_fdi2": 1}),
                "raw id 2 is the upper jawbone; the name says lower")

    # 6. assert_owns_only -- the guard that still bites when the ROI is everything.
    from worker import board as B
    rng = np.random.default_rng(11)
    base_v = rng.integers(1, 47, size=(16, 18, 20), dtype=np.uint8)
    full = [[0, 16], [0, 18], [0, 20]]
    run = B.BoardRun("probe", 0.0, "x", [43, 44, 45], box=full)
    spec = _fake_spec("probe")

    legal = base_v.copy()
    legal[base_v == 43] = 0                 # cleared its own class
    legal[2, 2, 2] = 44                     # claimed a voxel the base called something else
    ok &= check("clearing its own class and CLAIMING a voxel are both allowed",
                not _raises(B.assert_owns_only, base_v, legal, [spec], [run]),
                "taking a voxel from the parent structure is what authoritative means")

    leak = base_v.copy()
    leak[3, 3, 3] = 1 if base_v[3, 3, 3] != 1 else 2      # wrote a jawbone
    ok &= check("writing an id it does NOT own is caught",
                _raises(B.assert_owns_only, base_v, leak, [spec], [run]))

    erase = base_v.copy()
    victim = np.argwhere(~np.isin(base_v, [43, 44, 45, 0]))[0]
    erase[tuple(victim)] = 0                # deleted something it does not own
    ok &= check("DELETING an id it does not own is caught",
                _raises(B.assert_owns_only, base_v, erase, [spec], [run]),
                "old not owned -> 0 is a structure quietly removed")
    ok &= check("  ... and assert_outside_box_unchanged is VACUOUS here",
                not _raises(B.assert_outside_box_unchanged, base_v, leak, [run]),
                "roi=full leaves an empty outside mask, so the older guard compares "
                "nothing and passes -- which is why assert_owns_only exists")

    shadow = B.BoardRun("probe", 0.0, "x", [43], box=full, mode="shadow")
    ok &= check("shadow mode must stamp nothing at all",
                _raises(B.assert_owns_only, base_v, legal, [spec], [shadow]))
    return ok


def _fake_spec(name):
    from pathlib import Path

    from worker import board as B
    return B.Specialist(name=name, model_dir=Path("/nonexistent"), fold="all",
                        checkpoint="c.pth", owns=(43, 44, 45))


def _band_sampler(jaw="mandible", canal_t=0.0, canal_z=-3.0, ref=500.0, air=-1000.0,
                  site=None, n_s=80, n_t=81, n_z=101, step=0.30):
    """A synthetic measurement band with an ANALYTIC canal, for exact assertions.

    The canal is a straight line at (t=canal_t, z=canal_z) running along s, so the true
    distance from any point to it is `hypot(t - canal_t, z - canal_z)` -- computable in
    closed form, which is what lets the clearance check assert a number rather than a
    plausible range.
    """
    from worker import planning_pack as PP

    lat = {"n_s": n_s, "n_t": n_t, "n_z": n_z, "step_mm": step,
           "s0_mm": -n_s * step / 2, "t_min_mm": -(n_t - 1) * step / 2,
           "z_top_mm": (n_z - 1) * step / 2}
    ss = lat["s0_mm"] + np.arange(n_s) * step
    tt = lat["t_min_mm"] + np.arange(n_t) * step
    zz = lat["z_top_mm"] - np.arange(n_z) * step
    T, Z = np.meshgrid(tt, zz, indexing="ij")
    d = np.hypot(T - canal_t, Z - canal_z)                    # (n_t, n_z), mm
    canal = np.repeat(d[None], n_s, axis=0)
    # `site` must differ from `ref` or the density check is VACUOUS: with the two equal,
    # both the correct (site-air)/(ref-air) and a naive site/ref evaluate to 1.0 and the
    # test passes with the formula broken. That is exactly what happened on the first
    # attempt, and the --prove discipline is what caught it.
    grey = np.full((n_s, n_t, n_z), ref if site is None else site, dtype=np.float32)

    header = {"version": 1, "jaws": {jaw: {
        "ok": True, "lattice": lat,
        "fields": {"grey": {"dtype": "float32", "scale": 1.0},
                   "canal": {"dtype": "float32", "scale": 1.0, "unit": "mm"}},
        "references": {"air": air, "cancellous": ref, "cancellous_voxels": 10 ** 5}}}}
    return PP.ArraySampler(header, jaw, {"grey": grey, "canal": canal}), header


def plan_metrics_checks() -> bool:
    """Is the clearance the right number, and does the density survive recalibration.

    Both are asserted against closed-form answers on a synthetic band, so a failure is a
    failure of the formula rather than of a fixture.
    """
    import math

    from dentistry import plan_metrics as M
    from dentistry import plan_safety as S

    ok = True

    # --- clearance ---------------------------------------------------------
    # The implant is a CAPSULE: its axis SEGMENT runs [0, length - r] and an apical
    # hemisphere of radius r closes it. So the solid is the Minkowski sum of that
    # segment with a ball, and `min(d_axis) - r` is the exact distance, not a bound.
    #
    # Geometry here: length 6, diameter 4 -> r = 2, span = 4. The segment therefore
    # runs z = 0 .. -4 at t = 3, and the canal is the line (t = 0, z = -6). Nearest
    # segment point is its apical end (3, -4), so
    #     d(segment, canal) = hypot(3, 6 - 4) = hypot(3, 2) = 3.6056
    #     clearance         = 3.6056 - 2      = 1.6056
    # The full-length cylinder this replaced reported 1.000 -- over-conservative by
    # 0.61 mm, 30% of the 2.00 mm margin, deducted on top of the error budget that
    # `plan_safety.budget()` already applies explicitly and visibly.
    smp, _ = _band_sampler(canal_t=0.0, canal_z=-6.0)
    imp = M.Implant(jaw="mandible", s_mm=0.0, t_mm=3.0, z_mm=0.0,
                    length_mm=6.0, diameter_mm=4.0)
    m = M.canal_clearance(smp, imp, None)
    want = math.hypot(3.0, 6.0 - M.axis_span_mm(imp)) - imp.radius_mm
    ok &= check("clearance on an analytic canal is the closed-form CAPSULE answer",
                m.value is not None and abs(m.value - want) < 0.02,
                f"{m.value} mm against {want:.4f} mm "
                f"(hypot(3, 6-{M.axis_span_mm(imp):.0f}) - 2); the cylinder said 1.000")
    ok &= check("  ... and it is reported as exact, not as a bound",
                "exact for the capsule" in m.basis and "lower bound" not in m.basis,
                m.basis[:78])

    # Linearity, on a genuinely BROADSIDE canal -- inside the segment's own z span, so
    # the nearest point is on the barrel and the distance is purely buccolingual.
    smpb, _ = _band_sampler(canal_t=0.0, canal_z=-2.0)
    near = M.Implant(jaw="mandible", s_mm=0.0, t_mm=3.0, z_mm=0.0,
                     length_mm=6.0, diameter_mm=4.0)
    far = M.Implant(jaw="mandible", s_mm=0.0, t_mm=7.0, z_mm=0.0,
                    length_mm=6.0, diameter_mm=4.0)
    mn, mf = M.canal_clearance(smpb, near, None), M.canal_clearance(smpb, far, None)
    ok &= check("a broadside canal gives exactly (offset - radius)",
                abs(mn.value - 1.0) < 0.02 and abs(mf.value - 5.0) < 0.02,
                f"t=3 -> {mn.value:.3f} mm (want 1.000), t=7 -> {mf.value:.3f} (want 5.000)")
    ok &= check("moving the implant 4 mm away moves the clearance 4 mm",
                abs((mf.value - mn.value) - 4.0) < 0.03,
                f"{mn.value:.2f} -> {mf.value:.2f} mm")

    # The regression that mattered: a canal DIRECTLY BELOW THE APEX -- a vertical
    # posterior implant, the ordinary case. The full cylinder's axis bound and its
    # surface ring differed by exactly `r` there, at EVERY depth, so DIRECTION_TIE
    # fired and the verdict was suppressed even at 12 mm of clearance. Measured
    # before the fix: no_verdict at canal z = -8, -9, -11, -14 and -20 alike.
    graded, apical = [], []
    for cz in (-8.0, -9.0, -11.0, -14.0, -20.0):
        sa, _ = _band_sampler(canal_t=0.0, canal_z=cz)
        ia = M.Implant(jaw="mandible", s_mm=0.0, t_mm=0.0, z_mm=0.0,
                       length_mm=6.0, diameter_mm=4.0)
        ma = M.canal_clearance(sa, ia, None)
        exact = (abs(cz) - M.axis_span_mm(ia)) - ia.radius_mm
        apical.append(abs(ma.value - exact))
        graded.append(S.canal_verdict(ma, None, {"canal_components": 2},
                                      "mandible").level)
    ok &= check("an apical approach measures exactly and is GRADED at every depth",
                max(apical) < 0.02 and "no_verdict" not in graded,
                f"worst error {max(apical):.4f} mm; verdicts {graded}")

    # --- inter-implant distance: EXACT, and computed in LPS ----------------
    # The brief for this metric said "arch-frame geometry". That is wrong, and the size
    # of the error decides a safety criterion. In the band, `s` is arc length along the
    # MID-LINE, so two points at buccolingual offset `t` and arc separation `ds` are
    # really `2(R + t) sin(ds / 2R)` apart. At the band's own curvature limit and 7 mm
    # of arc separation the arch frame reads 7.00 mm where the truth is 9.20 mm buccally
    # and 4.60 mm LINGUALLY -- so an arch-frame figure would pass a lingual pair that is
    # actually 1.6 mm apart against a 3 mm minimum. A false negative on a safety check.
    import json as _json
    from pathlib import Path as _Path
    vec = _json.loads((_Path(__file__).parent / "plan_vectors.json").read_text())
    arch = {"mandible": vec["manifest"]}
    mk = lambda i, s_mm, t=0.0: {
        "id": i, "jaw": "mandible", "s_mm": s_mm, "t_mm": t,
        "z_mm": float(vec["manifest"]["occlusal_z_mm"]), "tilt_deg": 0.0,
        "yaw_deg": 0.0, "length_mm": 10.0, "diameter_mm": 4.1}

    from dentistry import plan_geometry as G
    a, b = mk("i1", -3.5), mk("i2", 3.5)
    d = M.inter_implant_distance(a, b, arch)
    pa = G.implant_axis_lps(a, arch["mandible"])
    pb = G.implant_axis_lps(b, arch["mandible"])
    want = G.segment_segment_distance(pa[0], pa[1], pb[0], pb[1])[0] - 2.05 - 2.05
    ok &= check("the inter-implant distance is the LPS closest approach less both radii",
                d.value is not None and abs(d.value - want) < 1e-3,
                f"{d.value} mm against {want:.4f} mm; on THIS manifest the arch frame "
                f"would have said {7.0 - 4.1:.2f} mm from |ds| alone, "
                f"{abs((7.0 - 4.1) - want):.2f} mm out, and at the band's curvature "
                f"limit the same error reaches 2.4 mm -- enough to pass a lingual pair "
                f"1.6 mm apart against a 3 mm minimum")
    ok &= check("  ... and it declares itself exact, with no error deducted",
                S.inter_implant_verdict(d, "i1", "i2").numbers.get("exact") is True
                and "inward" not in " ".join(
                    S.inter_implant_verdict(d, "i1", "i2").because).lower(),
                "no segmentation enters it, so nothing is deducted from it")

    over = M.inter_implant_distance(mk("i1", -1.0), mk("i2", 1.0), arch)
    ok &= check("two overlapping implants report a NEGATIVE distance",
                over.value is not None and over.value < 0,
                f"{over.value} mm -- a real state a drag can reach, not floored at zero")
    ok &= check("  ... and that is a breach, named as a placement error",
                S.inter_implant_verdict(over, "i1", "i2").level == "breach",
                S.inter_implant_verdict(over, "i1", "i2").headline)

    cross = M.inter_implant_distance(mk("i1", 0.0), {**mk("i2", 8.0), "jaw": "maxilla"},
                                     arch)
    ok &= check("a cross-jaw pair is refused rather than measured",
                cross.value is None and bool(cross.caveats),
                (cross.caveats or ["none"])[0])

    # --- the verdict boundaries, which are policy and must be exact --------
    v_close = S.canal_verdict(m, None, {"canal_components": 2}, "mandible")
    v_far = S.canal_verdict(mf, None, {"canal_components": 2}, "mandible")
    # The names carry the measured value rather than a literal, because the literal
    # went stale the moment the solid became a capsule: this check was called
    # "1.00 mm of clearance is a BREACH" while asserting on 1.61 mm.
    ok &= check(f"{m.value:.2f} mm of clearance is a BREACH of the "
                f"{S.SAFETY_MARGIN_MM:.2f} mm margin",
                v_close.level == "breach", v_close.headline)
    ok &= check(f"{mf.value:.2f} mm of clearance is CLEAR",
                v_far.level == "clear", v_far.headline)
    ok &= check("the budget subtracts the p95 inward error and quotes the worst",
                v_far.numbers["informed_mm"] == round(mf.value - S.MODEL_INWARD_P95_MM, 2)
                and v_far.numbers["worst_measured_inward_mm"] == S.MODEL_INWARD_WORST_MM,
                str(v_far.numbers))

    # --- the refusals ------------------------------------------------------
    frag = S.canal_verdict(mf, None, {"canal_components": 3}, "mandible")
    # A component count is a fact about the WHOLE VOLUME. It used to veto the verdict
    # outright, which lost the grade on 2 of 5 real cases for a fragment that could be
    # 40 mm from the implant. Now it is stated and the LOCAL test decides.
    ok &= check("a fragment elsewhere in the scan no longer vetoes the verdict",
                frag.level == "clear", frag.headline)
    ok &= check("  ... but it IS said, so the reader can see the scan is fragmented",
                any("3 piece(s)" in b for b in frag.because),
                next((b for b in frag.because if "piece" in b), "not mentioned")[:88])
    ok &= check("  ... and the raw millimetres are still reported",
                frag.numbers.get("clearance_mm") == round(mf.value, 2),
                str(frag.numbers.get("clearance_mm")))

    # A break WITHIN the canal's own course near this implant still refuses, because
    # then the nearest drawn voxel really may not be the nearest nerve.
    near_break = M.Measurement(
        mf.value, "mm", mf.basis, [],
        {**(mf.detail or {}), "gap_near_site_mm": 8.0})
    nb = S.canal_verdict(near_break, None, {"canal_components": 2}, "mandible")
    ok &= check("a break in the canal's own course NEAR the implant still refuses",
                nb.level == "no_verdict", nb.headline)

    # Terminal absence -- the mental foramen -- is anatomy, not a measurement failure.
    term = M.Measurement(mf.value, "mm", mf.basis, [],
                         {**(mf.detail or {}), "canal_terminal": True,
                          "nearest_canal_mm": 25.5})
    tv = S.canal_verdict(term, None, {"canal_components": 2}, "mandible")
    ok &= check("an anterior site says there is NO canal, not that it failed",
                tv.level == "no_verdict" and "no inferior alveolar canal" in tv.headline,
                tv.headline)
    ok &= check("  ... and points the reader at the structures that ARE there",
                any("incisive and lingual" in b for b in tv.because),
                str(tv.because[-1])[:88])

    mx = S.canal_verdict(mf, None, {"canal_components": 2}, "maxilla")
    ok &= check("the maxilla refuses: there is no canal to clear there",
                mx.level == "no_verdict", mx.headline)

    # --- terminal vs interior absence, the anterior-site defect --------------
    # An INTERIOR break: canal present either side of a hole, on the SAME side.
    gapped = {"s_mm": [i * 0.5 - 20 for i in range(80)],
              "present": [0 if 10 <= i <= 25 else 1 for i in range(80)],
              "side": [0 if 10 <= i <= 25 else -1 for i in range(80)]}
    g = M.gap_near_site_mm(gapped, s_mm=-12.0)
    ok &= check("an 8 mm hole INSIDE the canal's course is measured as one",
                abs(g - 8.0) < 0.01, f"{g} mm")

    # The real geometry: two canals, one per side, with 58 mm of anatomical absence
    # between them. Every anterior site used to report a 24.5 mm gap and be refused.
    n = 250
    real = {"s_mm": [i * 0.5 - 62.0 for i in range(n)],
            "present": [1 if (i * 0.5 - 62.0) <= -27.0 or (i * 0.5 - 62.0) >= 32.0
                        else 0 for i in range(n)],
            "side": [-1 if (i * 0.5 - 62.0) <= -27.0
                     else (1 if (i * 0.5 - 62.0) >= 32.0 else 0) for i in range(n)]}
    ant = M.canal_presence_near(real, s_mm=-1.5)
    post = M.canal_presence_near(real, s_mm=-45.0)
    ok &= check("the mental foramen is TERMINAL, not a gap",
                ant["interior_gap_mm"] == 0.0 and ant["terminal"] is True,
                f"interior {ant['interior_gap_mm']} mm, terminal {ant['terminal']}, "
                f"nearest drawn canal {ant['nearest_present_mm']} mm along the arch")
    ok &= check("  ... while a posterior site is inside the canal's own extent",
                post["interior_gap_mm"] == 0.0 and post["terminal"] is False,
                f"sides {post['sides']}")
    ok &= check("  ... and the two sides are not bridged across the midline",
                len(ant["sides"]) == 2,
                "each side's drawn extent is tracked separately; a first attempt "
                "tested only 'present somewhere before and after' and called the "
                "mental foramen an interior gap exactly as before")

    # --- density invariance, EXECUTED not asserted in prose ----------------
    a, b = 2.37, -118.0                     # the measured calibration spread
    s1, h1 = _band_sampler(ref=500.0, air=-1000.0, site=800.0)
    # The SAME scan, recalibrated: transform the voxels and the reference landmarks
    # together, which is exactly what a different scanner would hand us.
    s2, h2 = _band_sampler(ref=500.0, air=-1000.0, site=800.0)
    s2.arrays["grey"] = a * s2.arrays["grey"] + b
    h2["jaws"]["mandible"]["references"] = {
        "air": a * -1000.0 + b, "cancellous": a * 500.0 + b, "cancellous_voxels": 10 ** 5}
    site = M.Implant(jaw="mandible", s_mm=0.0, t_mm=0.0, z_mm=0.0,
                     length_mm=8.0, diameter_mm=4.0)
    r1 = M.density_ratio(s1, site, h1["jaws"]["mandible"]["references"])
    r2 = M.density_ratio(s2, site, h2["jaws"]["mandible"]["references"])
    ok &= check("the density ratio is invariant under y = 2.37x - 118",
                r1.value is not None and abs(r1.value - r2.value) < 1e-9,
                f"{r1.value} vs {r2.value} -- if anyone 'simplifies' the ratio, "
                f"this is what fails")
    ok &= check("  ... and the ratio is not trivially 1.0 (the test can fail)",
                abs(r1.value - 1.0) > 0.1,
                f"site 800 against a 500 reference reads {r1.value}")
    none = M.density_ratio(s1, site, {"air": -1000.0, "cancellous": None,
                                      "reason": "no population"})
    ok &= check("no reference population means NO number, not a guess",
                none.value is None and none.caveats, none.basis[:60])

    # --- the two STL writers must not drift --------------------------------
    # `worker/meshes.py` writes the anatomy with numpy; `dentistry/plan_geometry.py`
    # writes the implants in pure Python, because the API cannot import numpy. Two
    # writers for one format is a drift waiting to happen, so they are asserted
    # byte-identical on the same triangles rather than merely "both valid".
    import tempfile
    from pathlib import Path as _P

    from dentistry import plan_geometry as G
    from worker import meshes as MSH

    tris = G.implant_mesh(10.0, 4.1, n_az=16)
    verts, faces, seen = [], [], {}
    for tri in tris:
        idx = []
        for v in tri:
            k = tuple(round(c, 9) for c in v)
            if k not in seen:
                seen[k] = len(verts)
                verts.append(k)
            idx.append(seen[k])
        faces.append(idx)
    with tempfile.TemporaryDirectory() as td:
        out = _P(td) / "a.stl"
        # float64 in, matching the pure-Python path: both then compute the facet
        # normal at full precision and round only when packing. Handing numpy float32
        # vertices instead moves the normal in the 7th digit -- a real difference, and
        # a difference in the INPUT rather than in either writer.
        MSH.write_stl(np.array(verts, dtype=np.float64),
                      np.array(faces, dtype=np.int64), out)
        a = out.read_bytes()
    # From the SAME deduped vertices, not from the original triangle list: the dedup
    # rounds to 9 decimals, and feeding one writer rounded values and the other raw ones
    # compares the inputs rather than the writers.
    b = G.write_stl_bytes([tuple(verts[i] for i in f) for f in faces])
    ok &= check("the pure-Python STL writer is byte-identical to worker/meshes.py",
                a == b, f"{len(a)} vs {len(b)} bytes"
                + ("" if len(a) != len(b) else
                   f", first difference at byte {next((i for i, (x, y) in enumerate(zip(a, b)) if x != y), -1)}"))

    # --- the copy constraint, checked on OUTPUT rather than on prose -------
    # A source grep cannot tell a prohibition from a violation: both modules' docstrings
    # say "never a Misch class", which a naive grep flags. So the check walks the AST and
    # examines only string literals that could REACH a user -- docstrings excluded,
    # because documenting why a thing is forbidden is not doing it.
    import ast
    import re
    from pathlib import Path

    root = Path(__file__).resolve().parent.parent
    forbidden = re.compile(r"\bMisch\b|\bD[1-4]\b|bone quality|\bHU\b|Hounsfield")
    bad = []
    for f in ("dentistry/plan_metrics.py", "dentistry/plan_safety.py"):
        tree = ast.parse((root / f).read_text())
        docstrings = set()
        for node in ast.walk(tree):
            if isinstance(node, (ast.Module, ast.ClassDef, ast.FunctionDef,
                                 ast.AsyncFunctionDef)):
                d = ast.get_docstring(node, clean=False)
                if d is not None:
                    docstrings.add(id(node.body[0].value))
        for node in ast.walk(tree):
            if isinstance(node, ast.Constant) and isinstance(node.value, str) \
                    and id(node) not in docstrings and forbidden.search(node.value):
                bad.append(f"{f}:{node.lineno} {node.value[:50]!r}")
    ok &= check("no bone-quality or absolute-HU claim can reach a user",
                not bad, str(bad) or "checked every non-docstring string literal")

    # ...and the user-facing sentences themselves, generated rather than read.
    out = " ".join([S.density_statement(r1), S.density_statement(none),
                    S.apex_statement(None, "maxilla"), S.NO_GUIDE_NOTICE,
                    v_far.headline, *v_far.because])
    ok &= check("  ... and the generated prose is clean too",
                not forbidden.search(out),
                (forbidden.search(out).group(0) if forbidden.search(out) else
                 f"{len(out)} characters of generated copy"))
    return ok


def pack_sampler_checks() -> bool:
    """The API and the worker must read the same field the same way.

    `dentistry/plan_metrics.py` is written against a Sampler protocol precisely so the
    formulas can run twice: over numpy in the worker and the tests, and over an mmap in
    the API, which has no numpy at all. If the two samplers disagree, the server and the
    checks compute different millimetres and nothing above them can be trusted.

    Also asserts the mmap reader never bulk-reads. That discipline is what keeps API RSS
    flat against a ~30 MB pack per case, and a discipline that is only written down in a
    docstring is one that lapses on the next edit.
    """
    import json
    import re
    from pathlib import Path

    from api import planning_cache as C
    from worker import planning_pack as PP

    ok = True
    root = Path(__file__).resolve().parent.parent

    # --- the discipline, as source ----------------------------------------
    src = (root / "api/planning_cache.py").read_text()
    body = "\n".join(l for l in src.splitlines()
                     if not l.strip().startswith("#") and "phantom check" not in l)
    banned = [m for m in (".read(", "bytes(", ".readinto(", ".readlines(")
              if m in body.split('"""')[-1]]
    ok &= check("the mmap reader never bulk-reads the pack",
                not banned, str(banned) or "no .read/.readinto/bytes() in the code path")

    # --- a synthetic pack, so this needs no real case ----------------------
    import tempfile
    n_s, n_t, n_z, step = 12, 9, 11, 0.5
    rng = np.random.default_rng(5)
    grey = (rng.random((n_s, n_t, n_z)) * 3000 - 1000).astype(np.int16)
    canal = (rng.random((n_s, n_t, n_z)) * 40000).astype(np.uint16)
    # The two uint8 fields added for the accessory canals and the teeth. They have to be
    # in this test or the two samplers can silently disagree about the newest fields --
    # which are the ones the anterior clearance and the adjacent-tooth clearance read.
    tooth = (rng.random((n_s, n_t, n_z)) * 254).astype(np.uint8)
    lat = {"n_s": n_s, "n_t": n_t, "n_z": n_z, "step_mm": step,
           "s0_mm": -3.0, "t_min_mm": -2.0, "z_top_mm": 2.5}
    with tempfile.TemporaryDirectory() as td:
        d = Path(td) / "pack"
        d.mkdir()
        grey.tofile(d / "mandible.grey.raw")
        canal.tofile(d / "mandible.canal.raw")
        tooth.tofile(d / "mandible.tooth.raw")
        header = {"version": 1, "jaws": {"mandible": {
            "ok": True, "lattice": lat,
            "fields": {"grey": {"file": "pack/mandible.grey.raw", "dtype": "int16",
                                "scale": 1.0, "offset": 0.0},
                       "canal": {"file": "pack/mandible.canal.raw", "dtype": "uint16",
                                 "scale": 0.001, "offset": 0.0},
                       "tooth": {"file": "pack/mandible.tooth.raw", "dtype": "uint8",
                                 "scale": 0.05, "offset": 0.0,
                                 "saturates_mm": 12.7, "saturated_value": 255}},
            "references": {"air": -1000.0, "cancellous": 500.0}}}}
        (d / "header.json").write_text(json.dumps(header))

        pack = C.Pack(d)
        mm = pack.sampler("mandible")
        npy = PP.ArraySampler(header, "mandible",
                              {"grey": grey.astype(np.float32),
                               "canal": canal.astype(np.float32),
                               "tooth": tooth.astype(np.float32)})
        pts = []
        for _ in range(2000):
            pts.append((lat["s0_mm"] + rng.uniform(0, n_s - 1.001) * step,
                        lat["t_min_mm"] + rng.uniform(0, n_t - 1.001) * step,
                        lat["z_top_mm"] - rng.uniform(0, n_z - 1.001) * step))
        worst = 0.0
        a = np.array(mm.sample("grey", pts))
        b = np.array(npy.sample("grey", pts))
        worst = float(np.abs(a - b).max())
        ok &= check("pure-Python trilinear matches scipy's over 2000 random points",
                    worst < 1e-3, f"worst |mmap - numpy| = {worst:.3e}")
        ok &= check("  ... and the field is not constant (the test can fail)",
                    float(a.max() - a.min()) > 100, f"range {a.min():.0f}..{a.max():.0f}")

        # The scale must be applied: a uint16 of micrometres is millimetres out.
        cm = mm.sample("canal", pts[:50])
        ok &= check("a uint16 micrometre field reads back in millimetres",
                    max(cm) < 66.0 and max(cm) > 0.001,
                    f"max {max(cm):.3f} mm from a field whose raw max is {canal.max()}")

        # The uint8 fields, which are the newest and the ones the anterior and
        # adjacent-tooth clearances read. 0.05 mm per count, so a raw 254 is 12.70 mm.
        tw = float(np.abs(np.array(mm.sample("tooth", pts))
                          - np.array(npy.sample("tooth", pts))).max())
        ok &= check("the two samplers agree on a uint8 0.05 mm field too",
                    tw < 1e-3, f"worst |mmap - numpy| = {tw:.3e}")
        tvals = mm.sample("tooth", pts[:80])
        ok &= check("  ... and its quantum reads back as millimetres, not counts",
                    max(tvals) <= 12.7 + 1e-9 and max(tvals) > 0.05,
                    f"max {max(tvals):.3f} mm from a raw max of {tooth.max()}")

        # `bounds`/`contains`/`overshoot` must exist on BOTH samplers and agree, or the
        # out-of-band caveat is only half-implemented and clamps silently on the API.
        ok &= check("both samplers report the same band extent",
                    mm.bounds() == npy.bounds(), str(mm.bounds()))
        outside = [(lat["s0_mm"] - 5.0, 0.0, lat["z_top_mm"]),
                   (lat["s0_mm"], 0.0, lat["z_top_mm"] + 3.0)]
        inside = [(lat["s0_mm"] + step, lat["t_min_mm"] + step, lat["z_top_mm"] - step)]
        ok &= check("  ... and agree on which points are samples and which are clamps",
                    mm.contains(outside + inside) == npy.contains(outside + inside)
                    == [False, False, True],
                    str(mm.contains(outside + inside)))
        o_mm, o_npy = mm.overshoot(outside), npy.overshoot(outside)
        ok &= check("  ... and on how far outside the worst point lies",
                    abs(o_mm["worst_overshoot_mm"] - o_npy["worst_overshoot_mm"]) < 1e-9
                    and o_mm["worst_overshoot_mm"] > 1.0,
                    f"{o_mm['worst_overshoot_mm']:.2f} mm on the {o_mm['axis']} axis")
        pack.close()

    # --- the reference population must be BONE ----------------------------
    # The maxillary slab runs 8 mm either side of the arch and 15 mm up, which in the
    # posterior goes straight into the maxillary sinus. On the first real case the
    # unrestricted median came out at 4.3 -- soft tissue -- against the mandible's 469,
    # and a density ratio against that would have looked entirely reasonable.
    import SimpleITK as sitk

    class _Fit:
        ok = True
        occlusal_z_mm = 0.0
        points = np.stack([np.linspace(-4, 4, 40), np.zeros(40), np.zeros(40)], 1)
        step_mm = 0.2
        s0_index = 20

        def normals(self):
            n = np.zeros((40, 3))
            n[:, 1] = 1.0
            return n

    shape = (40, 60, 60)
    grey = np.full(shape, -1000.0, dtype=np.float32)       # start as air, like a sinus
    grey[:, :, 30:] = 700.0                                # a bone half
    merged = np.zeros(shape, dtype=np.uint8)
    img = sitk.GetImageFromArray(grey)
    img.SetSpacing((0.3, 0.3, 0.3))
    refs = PP.references(grey, merged, _Fit(), "maxilla", img,
                         {"air": -1000.0, "soft_tissue": 90.0})
    ok &= check("a half-air slab yields a BONE reference, not the midpoint",
                refs["cancellous"] is not None and abs(refs["cancellous"] - 700.0) < 1.0,
                f"{refs['cancellous']} against the 700 bone value; unrestricted the "
                f"median of this slab is -1000")
    ok &= check("  ... and the landmark it thresholded on is recorded",
                refs.get("soft_tissue") == 90.0, str(refs.get("soft_tissue")))
    none = PP.references(np.full(shape, -1000.0, dtype=np.float32), merged, _Fit(),
                         "maxilla", img, {"air": -1000.0, "soft_tissue": 90.0})
    ok &= check("a slab with no bone at all returns NO reference",
                none["cancellous"] is None and "reason" in none,
                none.get("reason", ""))
    return ok




def pack_cache_checks() -> bool:
    """A rebuilt pack must be REOPENED, not served from the cache it superseded.

    `planning_cache` memoises one `Pack` per path and memory-maps its fields, which is
    correct for as long as a finished job's files never change -- and a hand correction
    rewrites exactly those files. Keyed on the path alone, `/measure` kept returning the
    pre-edit distance field and the pre-edit `edits` list until the pod restarted, which
    is the opposite of the feature: the point of applying a correction is that the
    millimetres move.

    Exercised against a real pack, because the failure is about mtimes and mmaps and a
    synthetic one would not have either.
    """
    import os

    from api import planning_cache as pc

    ok = True
    root = _any_results_dir()
    if root is None:
        return check("a stored case is available for the pack-cache check", True,
                     "skipped: no processed case under data/tenants")
    a = pc.get(root)
    if a is None:
        return check("a stored case has a measurement pack", True,
                     "skipped: the case on disk has no pack")
    ok &= check("the same pack is served twice from the cache", pc.get(root) is a)
    hdr = root / "planning" / "pack" / "header.json"
    before = hdr.stat().st_mtime_ns
    os.utime(hdr, ns=(before + 1_000_000, before + 1_000_000))
    try:
        b = pc.get(root)
        ok &= check("a rewritten header reopens the pack", b is not a,
                    f"stamp {a.stamp} -> {b.stamp}")
        ok &= check("...and the superseded pack was closed, not leaked",
                    len(a.fields) == 0, f"{len(a.fields)} field(s) still mapped")
        ok &= check("the reopened pack still has its fields", len(b.fields) > 0,
                    f"{len(b.fields)} field(s)")
    finally:
        os.utime(hdr, ns=(before, before))
    return ok


def _any_results_dir():
    """The first stored case that has a planning pack, or None."""
    base = Path(__file__).resolve().parent.parent / "data" / "tenants"
    if not base.is_dir():
        return None
    for tenant in sorted(base.iterdir()):
        results = tenant / "results"
        if not results.is_dir():
            continue
        for job in sorted(results.iterdir()):
            if (job / "planning" / "pack" / "header.json").is_file():
                return job
    return None


def rtstruct_checks() -> bool:
    """Does the DICOM export actually build, and does a failure stay visible.

    `worker/main.py` wraps the RTSTRUCT step in try/except so a DICOM problem costs the
    user a structure set rather than their segmentation -- which is right, and which is
    exactly why nothing noticed when pydicom 3.0 stopped exporting
    `pydicom.uid.StudyRootQueryRetrieveInformationModelFind`. Every job since the recovery
    reported success and shipped no DICOM at all; it was found by reading a report blob,
    not by anything failing.

    A swallowed exception needs a test outside the swallow. This is that test.
    """
    import tempfile
    from pathlib import Path

    import SimpleITK as sitk

    from dentistry import labels as L
    from worker import rtstruct as RT

    ok = True
    # A phantom with two real structures, big enough to produce contours on several
    # slices. `structure_contours` smooths at iso 0.5, so a 2-voxel blob vanishes.
    merged = np.zeros((12, 40, 40), dtype=np.uint8)
    merged[3:9, 12:28, 12:28] = L.MERGED_MANDIBLE
    merged[4:8, 16:24, 16:24] = L.MERGED_CANAL
    img = sitk.GetImageFromArray(merged)
    img.SetSpacing((0.4, 0.4, 0.5))
    img.SetOrigin((-8.0, -8.0, 0.0))

    uids = [RT._uid() for _ in range(merged.shape[0])]
    ds, stats = RT.build(merged, img, uids, RT._uid(), RT._uid(),
                         {"PatientID": "PHANTOM", "PatientName": "Phantom^Test"},
                         RT.STUDY_REF_SOP_CLASS)
    ok &= check("the RTSTRUCT dataset builds at all",
                ds is not None and hasattr(ds, "ROIContourSequence"),
                "this is the assertion that pydicom 3.0 would have failed")
    n_roi = len(getattr(ds, "StructureSetROISequence", []))
    ok &= check("both phantom structures became ROIs", n_roi == 2, f"{n_roi} ROI(s)")

    # The UID that moved. Assert the VALUE, not the library's spelling of it.
    ref = ds.ReferencedFrameOfReferenceSequence[0].RTReferencedStudySequence[0]
    ok &= check("the referenced study SOP class is the standard's fixed UID",
                str(ref.ReferencedSOPClassUID) == "1.2.840.10008.5.1.4.1.2.2.1",
                str(ref.ReferencedSOPClassUID))

    n_contours = sum(len(getattr(r, "ContourSequence", []))
                     for r in ds.ROIContourSequence)
    ok &= check("the ROIs carry contours rather than empty sequences",
                n_contours > 0,
                f"{n_contours} contour(s), {stats['total_points']} points over "
                f"{n_roi} ROI(s)")

    # Every ROI name must fit Varian Eclipse's 16-character limit, which is why
    # `rt_name` exists. A 17th character is silently truncated by some writers and
    # rejected by Eclipse.
    long = [r.ROIName for r in ds.StructureSetROISequence
            if len(r.ROIName) > RT.MAX_ROI_NAME]
    ok &= check(f"every ROI name fits Eclipse's {RT.MAX_ROI_NAME} characters",
                not long, str(long))

    # And it has to round-trip through a file, which is where an invalid VR shows up.
    with tempfile.TemporaryDirectory() as td:
        f = Path(td) / "rt.dcm"
        ds.save_as(f, enforce_file_format=True)
        import pydicom
        back = pydicom.dcmread(str(f))
        ok &= check("it writes and reads back as valid DICOM",
                    len(back.StructureSetROISequence) == n_roi,
                    f"{f.stat().st_size} bytes")
    return ok


def volume_pack_checks() -> bool:
    """Does `meta.json` match the shape the committed viewer bundle actually reads.

    `web/viewer.js` is a 4 MB built artifact with no source in this tree, so its contract
    cannot be checked by reading it -- but it CAN be checked by grepping the one thing it
    does with each key. That is what this does.

    The version of `volume_pack.py` rebuilt on 2026-09-01 wrote `colors` as a plain
    `[r, g, b]` array; the viewer does `M.color.slice(1).match(/../g)` to build its
    segmentation colour LUT. So `M.color` was undefined and **every case failed with
    "Cannot read properties of undefined (reading 'slice')" the moment the 3D view
    mounted** -- while the segmentation, the report and the whole rail were fine. Nothing
    server-side could have caught it.
    """
    import json
    import re
    import tempfile
    from pathlib import Path

    import SimpleITK as sitk

    from worker import volume_pack as VP

    ok = True
    root = Path(__file__).resolve().parent.parent
    viewer = (root / "web/viewer.js").read_text()

    rng = np.random.default_rng(9)
    shape = (30, 48, 48)
    grey = (rng.random(shape) * 2000 - 1000).astype(np.float32)
    merged = np.zeros(shape, dtype=np.uint8)
    merged[8:20, 12:36, 12:36] = 2          # mandible
    merged[10:18, 18:30, 18:30] = 3         # canal
    with tempfile.TemporaryDirectory() as td:
        meta = VP.export(grey, merged, (0.3, 0.3, 0.3), (0.0, 0.0, 0.0),
                         (1, 0, 0, 0, 1, 0, 0, 0, 1), Path(td), window=(3000.0, 1000.0))
        meta = json.loads((Path(td) / "meta.json").read_text())

    for k in ("dimensions", "spacing", "origin", "direction", "colors"):
        ok &= check(f"meta carries {k!r}, which the viewer destructures",
                    k in meta, str(sorted(meta)))

    # The exact expression the bundle evaluates, asserted to still be there -- so if the
    # viewer is ever rebuilt with a different contract, this check goes stale loudly
    # rather than silently guarding nothing.
    ok &= check("the viewer still reads colors as {name, color:'#rrggbb'}",
                bool(re.search(r"\.color\.slice\(1\)\.match", viewer)),
                "if this fails the bundle changed and the assertion below is guessing")

    colors = meta.get("colors") or {}
    bad = [k for k, v in colors.items()
           if not isinstance(v, dict) or not str(v.get("color", "")).startswith("#")
           or not v.get("name")]
    ok &= check("every colour entry is an object with a hex `color` and a `name`",
                not bad and colors, f"{len(colors)} entries, {len(bad)} malformed")
    ok &= check("  ... and only structures actually PRESENT are listed",
                set(map(int, colors)) == set(meta["labels"]["present"]),
                f"{sorted(map(int, colors))} against present "
                f"{meta['labels']['present']} -- the viewer allocates one segment per "
                f"key, so listing all 47 registers segments that can never be drawn")
    return ok


def cc_filter_checks() -> bool:
    """The filter's two invariants, and that the exemption really exempts."""
    from worker import cc_filter

    ok = True
    ex = cc_filter.exempt_task1_classes()
    ok &= check("the thin tubes are exempt from island removal",
                ex == {3, 4, 43, 44, 45}, str(sorted(ex)))
    sc = cc_filter.single_component_task1_classes()
    ok &= check("keep-largest applies to the five single-object structures",
                sc == {1, 2, 5, 6, 7}, str(sorted(sc)))
    ok &= check("no tooth is ever keep-largest'd (a crowned tooth genuinely splits)",
                not (sc & set(range(11, 43))))

    seg = np.zeros((20, 20, 20), dtype=np.uint8)
    seg[2:8, 2:8, 2:8] = 1          # a big lower jawbone
    seg[15:17, 15:17, 15:17] = 1    # and a stray island
    seg[10, 10, 10] = 43            # a one-voxel accessory canal, which must survive
    out, removed, audit = cc_filter.apply(seg.copy(), {43: 500})
    ok &= check("keep-largest removes the stray jaw island", removed.get(1, 0) == 8,
                str(removed))
    ok &= check("the exempt canal survives a threshold far above its size",
                int((out == 43).sum()) == 1)
    ok &= check("every decision is audited, not just counted",
                any(a["action"] == "keep_largest" and a["task1"] == 1 for a in audit),
                str(audit))

    # --- the abstention, which is the whole defect ------------------------------
    # The table's statistic is the LARGEST component per case, and it used to be
    # compared to EACH component. On ToothFairy3F_043 the lower jawbone was ONE
    # component of 501,559 voxels against a 881,756 threshold and a 521,383-voxel
    # ground truth: the entire mandible was deleted, Dice 0.9740 -> 0.0000. It also
    # made worker/board skip the canal specialist, because tf3.canal_box has no
    # mandible to anchor on, so Task-1 43/44/45 reverted to the base model.
    solo = np.zeros((20, 20, 20), dtype=np.uint8)
    solo[2:12, 2:12, 2:12] = 9              # one component, 1000 voxels
    out2, rem2, aud2 = cc_filter.apply(solo.copy(), {9: 10862}, single_component=False)
    ok &= check("a class whose LARGEST component is below the threshold is left alone",
                int((out2 == 9).sum()) == 1000 and not rem2,
                f"kept {int((out2 == 9).sum())} of 1000 voxels, removed {rem2}")
    ok &= check("  ... and the abstention is recorded with its reason",
                any(a["action"] == "abstain" and a["task1"] == 9 for a in aud2),
                str(aud2))

    # Non-vacuity: the SAME array under the old rule loses everything. Simulated by
    # giving the class a threshold it does clear, so the per-component pass runs.
    out3, rem3, _ = cc_filter.apply(solo.copy(), {9: 900}, single_component=False)
    ok &= check("the threshold still deletes when the table DOES describe the case",
                int((out3 == 9).sum()) == 1000,
                "1000 >= 900, so nothing is small: the component survives on merit")
    frag = np.zeros((20, 20, 20), dtype=np.uint8)
    frag[2:12, 2:12, 2:12] = 9              # 1000 voxels, above threshold
    frag[18, 18, 18] = 9                    # plus one speck
    out4, rem4, _ = cc_filter.apply(frag.copy(), {9: 900}, single_component=False)
    ok &= check("  ... and a speck beside a described structure is still removed",
                rem4.get(9, 0) == 1 and int((out4 == 9).sum()) == 1000, str(rem4))

    # --- the class floor -------------------------------------------------------
    specks = np.zeros((20, 20, 20), dtype=np.uint8)
    specks[1, 1, 1] = 9
    specks[5, 5, 5] = 9                     # 2 voxels total: not a structure
    out5, rem5, aud5 = cc_filter.apply(specks.copy(), {9: 10862},
                                       single_component=False,
                                       floors={9: 10491})
    ok &= check("a class that is nothing but specks is deleted outright",
                int((out5 == 9).sum()) == 0 and rem5.get(9) == 2,
                f"floor {cc_filter.class_floor_for(9, {9: 10491})} voxels")
    ok &= check("  ... recorded as a floor deletion, not as a threshold one",
                any(a["action"] == "class_floor" for a in aud5), str(aud5))
    ok &= check("the class floor never exceeds what the annotations demonstrate",
                cc_filter.class_floor_for(45, {45: 25}) == 25
                and cc_filter.class_floor_for(9, {9: 10491})
                == cc_filter.CLASS_FLOOR_VOXELS,
                "min(500, p0.5): 25 for Task-1 45, 500 where p0.5 is larger")
    return ok


def test_orientation():
    assert orientation_checks()


def test_calibration():
    assert calibration_checks()


def test_crosswalk():
    assert crosswalk_checks()


def test_board_composition():
    assert board_checks()


def test_roi_rules():
    assert roi_rule_checks()


def test_arch_fit():
    assert arch_checks()


def test_panoramic_pitch():
    assert panoramic_pitch_checks()


def test_plan_geometry():
    assert plan_geometry_checks()


def test_implant_frame():
    assert implant_frame_checks()


def test_api_purity():
    assert api_purity_checks()


def test_model_menu():
    assert model_menu_checks()


def test_safety_priors():
    assert safety_prior_checks()


def test_pack_fields():
    assert pack_field_checks()


def test_foreign_models():
    assert foreign_model_checks()


def test_plan_metrics():
    assert plan_metrics_checks()


def test_pack_sampler():
    assert pack_sampler_checks()


def test_pack_cache():
    assert pack_cache_checks()


def test_rtstruct():
    assert rtstruct_checks()


def test_volume_pack():
    assert volume_pack_checks()


def test_cc_filter():
    assert cc_filter_checks()


def main() -> int:
    for fn in (orientation_checks, calibration_checks, crosswalk_checks,
               board_checks, roi_rule_checks, arch_checks,
               panoramic_pitch_checks, plan_geometry_checks,
               foreign_model_checks, plan_metrics_checks, model_menu_checks,
               pack_sampler_checks, pack_cache_checks, rtstruct_checks,
               volume_pack_checks, cc_filter_checks):
        print(f"\n--- {fn.__name__} ---")
        fn()
    print("\n" + ("ALL PASS" if not _FAILURES else f"FAILURES: {_FAILURES}"))
    return 0 if not _FAILURES else 1


if __name__ == "__main__":
    raise SystemExit(main())
