"""Per-case anatomical plausibility checks.

Dice against a hidden test set is a claim about a benchmark. These are claims
about *this* scan, computable with no ground truth, and they target the specific
ways dental CBCT segmentation is known to fail:

* **Left/right confusion.** The dominant failure mode on CBCT jaws — the reason
  the ToothFairy2 winner disabled left/right mirror augmentation and gained
  0.164 Dice. Teeth 1x/4x must sit on the patient's right of the dental midline
  and 2x/3x on the left. A model that mirrors a quadrant fails this check
  loudly, which no volume statistic would.
* **Fragmented teeth.** A tooth split into several components is either a
  genuine root separation or a segmentation break; either way the operator
  should see the count.
* **Canal continuity.** The canal should be two long thin runs, one per side.
* **Arch crossings.** A piece of a lower tooth sitting in the upper jaw, caught by
  asking the *other* model which arch those voxels are in. This is the one
  tooth-numbering error the pipeline makes repeatably -- see
  `dentistry/merge.py::arch_mask` for the measurements.
* **Left/right volume symmetry.** Contralateral teeth are near-identical in volume;
  a pair that is not usually means one of them lost or gained a neighbour's voxels.
* **Implausible volumes.** A mandible of 4 cm3 or 400 cm3 means the scan was
  out of distribution, not that the anatomy is unusual. Per-tooth ranges catch the
  opposite failure: a "third molar" of 86 mm3 is a fragment, not a tooth.

Everything is reported, nothing is silently corrected. That is a deliberate line: the
alternative for arch crossings was to relabel or delete them, and the measured cost of
the obvious version of that -- nnU-Net's keep-largest-component, per tooth -- is 326
mm3 removed from tooth 27 on the pre-surgery case, about a third of a molar. A quality
panel that tells the truth is worth more than a label map quietly edited to look
tidier than the models actually are.
"""

from __future__ import annotations

from dataclasses import dataclass, field, asdict

import numpy as np

from . import labels as L

# Adult reference ranges, deliberately wide -- these are "is this even plausible"
# gates, not diagnostic norms. Mandible ~45-95 cm3 and maxilla+upper skull is
# highly FOV-dependent (DentalSegmentator's maxilla class includes upper skull,
# so its volume scales with how much head is in the frame).
PLAUSIBLE_CM3 = {
    "mandible": (25.0, 140.0),
    "canal": (0.2, 8.0),
    # SOURCE-KEYED, because `maxilla` is not one structure across pipelines.
    # ToothFairy3's "Upper Jawbone" is a thin sliver -- 0.00-1.40 cm3 across the holdout
    # against a Lower Jawbone of 51-58 -- while DentalSegmentator's class 1 was the
    # maxilla AND the upper skull at ~111 cm3. Same merged index, different objects, so
    # one band cannot serve both and a single band would fire on whichever pipeline it
    # was not written for. `dentistry/crosswalk.py` promised this flag existed for a
    # while before it did.
    #
    # Skipped entirely when the structure is TRUNCATED: `maxilla` is `FOV_LIMITED`, its
    # boundary is the edge of the scan rather than anatomy, and a volume compared
    # against a whole-organ range is then measuring the field of view.
    "maxilla": {"toothfairy3-umamba2": (0.05, 6.0)},
}

# A structure whose mask reaches the edge of the reconstructed volume has an extent that
# is a fact about the SCAN, not about the segmentation. Its volume cannot be compared
# against a whole-organ range and its component count cannot be compared against a
# whole-organ topology. Saying so is information; calling it an error is a false
# positive, and on real uploads it is the largest single source of them.
#
# 0.001 = 0.1% of the mask sitting on the one-voxel boundary shell. Measured on
# `ToothFairy3F_043`, whose reconstruction cylinder genuinely cuts several structures:
# the cut ones read 0.7-2.2% (lower jawbone 0.7%, crown 2.2%, the two IACs 1.0-1.6%)
# while every structure comfortably inside reads exactly 0.000%. A 0.1% floor sits an
# order of magnitude below the smallest real truncation and above single-voxel leakage.
# The measured fraction is reported alongside the boolean so the threshold is auditable.
TRUNCATION_BOUNDARY_FRACTION = 0.001

# Per-tooth crown+root volume, by FDI position within the quadrant. Wide on purpose:
# the job is to catch a fragment being reported as a whole tooth, not to grade anatomy.
# Anchored on the 116 teeth in the four stored cases (incisors 214-512 mm3, premolars
# 313-526, molars 686-1024) and widened well past both ends. Third molars get the
# loosest range of all -- they are genuinely variable and often partly erupted.
PLAUSIBLE_TOOTH_MM3 = {
    1: (120.0, 700.0),    # central incisor
    2: (110.0, 650.0),    # lateral incisor
    3: (180.0, 900.0),    # canine
    4: (150.0, 900.0),    # first premolar
    5: (150.0, 900.0),    # second premolar
    6: (350.0, 1800.0),   # first molar
    7: (300.0, 1800.0),   # second molar
    8: (150.0, 1800.0),   # third molar
}
# Contralateral teeth differ by 0.7-6.2% by volume on 12 of the 14 pairs measured;
# the two that do not are the lower incisors, at 18.8% and 21.3%. Set above both so
# the check means "something took or lost a neighbour's voxels", not "teeth differ".
SYMMETRY_WARN_FRACTION = 0.30
# An arch vote needs this share of the component's voxels to have an opinion at all,
# and this share of those to point the other way, before it counts as a contradiction.
ARCH_MIN_COVERAGE = 0.50
ARCH_MIN_MAJORITY = 0.60

# --- the unnumbered classes ------------------------------------------------
# `*_teeth_unnumbered` is a pure residual: `ds_teeth & ~ts_any`, a hard set
# subtraction with no tolerance band (dentistry/merge.py:93). So every sub-voxel
# disagreement about where a tooth ends becomes a named structure, and the single
# number the UI showed could not tell a missing molar from a rind.
#
# Measured on the three stored examples: 60-94% of that volume lies within 1 mm of
# a numbered tooth, its meshed mean thickness is 0.53-1.25 mm against 1.77-2.10 mm
# for real teeth, and its largest component routinely touches SEVEN OR MORE
# different teeth at one voxel's distance -- one connected rind bridging the
# interproximal gaps, not a tooth. Separately, one component on the head CBCT is
# 755 mm3 at median grey 2870 with 47% of voxels above 3000, against 1251 for teeth
# and a ceiling near 2500 for bone: that is metal, and ToothSeg has no class for it
# (models/toothseg_semantic/dataset.json is background plus the 32 permanent teeth,
# with no implant, bridge, pontic or deciduous label).
#
# Three buckets, in that order of confidence.
FILM_VOXELS = 1.0        # within this many voxels of a numbered tooth -> boundary film
# Restorative material needs TWO things to be true, because either one alone
# misfires on real data.
#
# *Thickness*, as the largest sphere that fits inside the component. A film is the
# gap between two model boundaries, so it is thin however far it spreads; a crown or
# a bridge is a solid object. Measured across the three cases: the one metallic mass
# has a 4.08 mm inscribed radius and every other component on every case is
# 0.43-2.00 mm, including a 195 mm3 rind that spans eight teeth.
DENSE_MIN_THICKNESS_MM = 2.5
# *Density*, against the case's OWN enamel rather than an absolute number, because
# CBCT grey values are not calibrated HU and a fixed threshold means nothing across
# scanners. The 95th percentile of numbered-tooth grey is enamel.
#
# Grey alone flagged 14 masses on the pre-operative case -- its teeth are dim
# (p95 1485) so ordinary rind sits just above the line -- and thickness alone would
# eventually meet a genuinely thick segmentation error. Requiring both is what makes
# the row worth reading.
DENSE_ABOVE_TOOTH_P95 = 1.0
# Below this a component is a speck, reported in the totals but not listed one by one.
UNNUMBERED_LIST_MM3 = 5.0


@dataclass
class QualityReport:
    spacing_mm: tuple[float, float, float] = (0.0, 0.0, 0.0)
    voxel_volume_mm3: float = 0.0
    volumes_cm3: dict[str, float] = field(default_factory=dict)
    components: dict[str, int] = field(default_factory=dict)
    teeth_found: int = 0
    teeth_fragmented: list[int] = field(default_factory=list)
    # Every non-largest component of a numbered tooth, with enough detail to act on:
    # {fdi, mm3, fraction_of_tooth, gap_mm, arch, expected_arch, touches}. The bare
    # `teeth_fragmented` list above stays because the UI reads it, but "31, 43" told
    # nobody whether that was a split root apex or a chunk in the wrong jaw.
    tooth_fragments: list[dict] = field(default_factory=list)
    # Components whose arch contradicts their FDI quadrant, per merge.arch_mask.
    arch_conflicts: list[dict] = field(default_factory=list)
    arch_conflict_mm3: float = 0.0
    # The same contradiction counted over the WHOLE label rather than only over
    # detached components. The fragment check above cannot see the common case -- a
    # wrong-arch patch fused to the crown of the tooth it invaded -- and measurement
    # says that is where most of it lives: on the three stored examples the fragment
    # figure was 22, 87 and 9 mm3 while the whole-label figure was several times
    # larger. `arch_conflict_mm3` is a subset of this, not a separate finding.
    arch_wrong_mm3: float = 0.0
    arch_wrong_by_tooth: list[dict] = field(default_factory=list)
    # Total interface area between an upper-quadrant label and a lower-quadrant one.
    # Teeth in occlusion do touch, so this is never zero and is not by itself an
    # error -- it is the number that collapses when the numbering stops flipping
    # across the contact, which makes it the cheapest before/after this pipeline has.
    occlusal_contact_mm2: float = 0.0
    occlusal_contact_pairs: list[dict] = field(default_factory=list)
    # Whether the jaw model's arch opinion was available at all. Without this an empty
    # `arch_conflicts` is ambiguous -- "checked, nothing found" and "never checked"
    # look identical, and a quality panel that cannot tell those apart is worse than
    # one that admits the gap. Results segmented before this check existed have no
    # such key, which the UI reads as "not checked".
    arch_checked: bool = False
    # Contralateral pairs differing by more than SYMMETRY_WARN_FRACTION.
    symmetry_violations: list[dict] = field(default_factory=list)
    laterality_ok: bool | None = None
    laterality_violations: list[dict] = field(default_factory=list)
    laterality_checks: list[dict] = field(default_factory=list)
    # The superior-inferior counterpart of the laterality block. It exists because
    # its absence let a real bug ship: a dataset whose header declared LPS while its
    # voxels were RPI was published upside down, and every laterality check passed --
    # the left-right half of the error had been corrected, so nothing was left to
    # notice that the mandible was above the maxilla. A head is symmetric left to
    # right, which is why laterality needs three careful cross-checks; it is NOT
    # symmetric top to bottom, so this one is cheap and near-unambiguous.
    vertical_ok: bool | None = None
    vertical_violations: list[dict] = field(default_factory=list)
    vertical_checks: list[dict] = field(default_factory=list)
    canal_components: int = 0
    warnings: list[str] = field(default_factory=list)

    # NOTES are facts about the scan; WARNINGS are findings about the segmentation.
    # Keeping them apart is the whole point: "this structure is cut by the edge of the
    # field of view" and "this structure is the wrong size" look identical in a volume
    # table and mean opposite things, and conflating them was the largest live source of
    # false findings on real uploads.
    notes: list[str] = field(default_factory=list)
    # Per structure id: {truncated, faces, boundary_voxels, boundary_fraction}.
    truncated: dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        return asdict(self)


def _largest_components(mask: np.ndarray, min_fraction: float = 0.05) -> int:
    """Count connected components that are at least `min_fraction` of the largest.

    Counting raw components would report marching-cubes-scale specks; the
    significant-component idea is the same one `dicomsegvr/worker/converter/
    meshing.py` settled on for tree detection.
    """
    from scipy import ndimage

    lab, n = ndimage.label(mask)
    if n <= 1:
        return int(n)
    sizes = np.bincount(lab.ravel())[1:]
    return int((sizes >= max(1, sizes.max() * min_fraction)).sum())


def unnumbered_report(merged: np.ndarray, grey: np.ndarray, spacing_zyx) -> dict:
    """Split `*_teeth_unnumbered` into buckets a reader can act on.

    Deliberately NOT part of `assess`. It needs the grey volume, and `assess` runs
    before the grey array is loaded in the worker; calling it there would mean
    holding a second copy of the scan through the merge and quality stages, which
    is exactly the allocation pattern that OOM-killed this node once. Here `grey` is
    already resident for the preview render, so the marginal cost is one crop.

    Everything below works inside the bounding box of tooth material, for the same
    reason `_tooth_fragments` does: a full-volume distance transform on the 0.25 mm
    case is 193 M voxels of float64.

    Returns a dict merged into `report["quality"]["unnumbered"]`. Changes no voxels.
    """
    from scipy import ndimage

    vox_mm3 = float(np.prod(spacing_zyx))
    unn_idx = (L.MERGED_UPPER_UNNUMBERED, L.MERGED_LOWER_UNNUMBERED)
    numbered = sorted(s.index for s in L.STRUCTURES if s.fdi is not None)
    fdi_of = {s.index: s.fdi for s in L.STRUCTURES if s.fdi is not None}

    unn = np.isin(merged, unn_idx)
    if not unn.any():
        return {"total_mm3": 0.0, "film_mm3": 0.0, "dense_mm3": 0.0, "free_mm3": 0.0,
                "components": [], "n_components": 0, "checked": True}

    num = np.isin(merged, numbered)
    box = ndimage.find_objects((unn | num).astype(np.uint8))[0]
    u, n_mask, mcrop = unn[box], num[box], merged[box]
    gcrop = grey[box]
    del unn, num

    # Grey scale of this scan's own enamel, so "dense" means dense FOR THIS SCAN.
    tooth_p95 = float(np.percentile(gcrop[n_mask], 95)) if n_mask.any() else float("inf")
    film_mm = FILM_VOXELS * float(max(spacing_zyx))

    # Two distance transforms over the same crop: outward, to find how far each
    # component sits from a numbered tooth, and inward, to find how thick it is.
    dist = ndimage.distance_transform_edt(~n_mask, sampling=spacing_zyx)
    thick = ndimage.distance_transform_edt(u, sampling=spacing_zyx)
    lab, k = ndimage.label(u)
    if k == 0:
        return {"total_mm3": 0.0, "film_mm3": 0.0, "dense_mm3": 0.0, "free_mm3": 0.0,
                "components": [], "n_components": 0, "checked": True}
    sizes = np.bincount(lab.ravel())
    sizes[0] = 0

    buckets = {"film": 0.0, "dense": 0.0, "free": 0.0}
    listed: list[dict] = []
    for c in range(1, k + 1):
        if not sizes[c]:
            continue
        comp = lab == c
        mm3 = float(sizes[c]) * vox_mm3
        gap = float(dist[comp].min())
        rad = float(thick[comp].max())
        med = float(np.median(gcrop[comp]))
        # Order matters. A bridge touches the teeth it spans, so the film test would
        # claim it if it ran first; the density test is checked before the geometry
        # one for exactly that reason.
        if rad >= DENSE_MIN_THICKNESS_MM and med > tooth_p95 * DENSE_ABOVE_TOOTH_P95:
            bucket = "dense"
        elif gap <= film_mm:
            bucket = "film"
        else:
            bucket = "free"
        buckets[bucket] += mm3
        if mm3 < UNNUMBERED_LIST_MM3:
            continue
        # Which teeth this piece is actually against. A rind reads as "touches 7
        # teeth"; a genuinely unnumbered tooth touches one or none, and that
        # distinction is the whole reason to list them.
        near = ndimage.binary_dilation(comp, iterations=2) & n_mask
        touches = sorted({fdi_of[int(v)] for v in np.unique(mcrop[near]) if int(v) in fdi_of})
        arch_id = L.BY_INDEX.get(int(np.bincount(mcrop[comp]).argmax()))
        listed.append({
            "mm3": round(mm3, 1),
            "bucket": bucket,
            "gap_mm": round(gap, 2),
            "thickness_mm": round(rad, 2),
            "median_grey": round(med, 1),
            "touches": touches,
            "arch": "upper" if arch_id and arch_id.index == L.MERGED_UPPER_UNNUMBERED else "lower",
        })
    listed.sort(key=lambda e: -e["mm3"])

    # The gates that did not exist. Nothing in this module bounded classes 4 and 5 --
    # PLAUSIBLE_CM3 covers only the mandible and the canal, and every per-tooth loop
    # skips `s.fdi is None` -- so a whole unnumbered molar produced no warning at all,
    # just a larger number in one display row. Only the two buckets that mean
    # something raise one; a film is expected and saying so every time is noise.
    warnings: list[str] = []
    dense = [e for e in listed if e["bucket"] == "dense"]
    if dense:
        warnings.append(
            f"{len(dense)} dense unnumbered mass(es), {sum(e['mm3'] for e in dense):.0f} mm3, "
            f"largest {dense[0]['mm3']:.0f} mm3 at teeth "
            f"{', '.join(str(t) for t in dense[0]['touches']) or 'no numbered neighbour'} "
            f"-- grey well above this scan's enamel, so restorative material. The tooth "
            f"model has no class for crowns, bridges or implants and cannot number these."
        )
    free = [e for e in listed if e["bucket"] == "free" and e["mm3"] >= PLAUSIBLE_TOOTH_MM3[1][0]]
    if free:
        warnings.append(
            f"{len(free)} free-standing unnumbered piece(s) of tooth-like size, largest "
            f"{free[0]['mm3']:.0f} mm3 and {free[0]['gap_mm']:.1f} mm from any numbered "
            f"tooth -- the jaw model found tooth material the tooth model did not number."
        )

    return {
        "warnings": warnings,
        "total_mm3": round(sum(buckets.values()), 1),
        "film_mm3": round(buckets["film"], 1),
        "dense_mm3": round(buckets["dense"], 1),
        "free_mm3": round(buckets["free"], 1),
        "n_components": int((sizes > 0).sum()),
        "film_within_mm": round(film_mm, 2),
        "tooth_grey_p95": round(tooth_p95, 1),
        "components": listed[:20],
        "checked": True,
    }


def _tooth_fragments(merged, rep, vox_mm3, spacing_zyx, arch, boxes) -> None:
    """Describe every non-largest component of every numbered tooth.

    Runs on the FINAL label volume -- after `remove_small_islands` -- so what is
    reported is what shipped, not an intermediate nobody can download and check.
    """
    from scipy import ndimage

    expected = {1: "upper", 2: "upper", 3: "lower", 4: "lower"}
    # Every structure's bounding box, from ONE pass over the volume. Everything below
    # then works inside a tooth-sized crop rather than the whole scan, which is the
    # difference between seconds and minutes: on the 0.25 mm case (433x667x667 =
    # 193 M voxels) a per-tooth `merged == index` plus `label` plus a distance
    # transform, 29 times over the full array, took **505 s**. Cropping first is
    # exact, not an approximation -- every component of a tooth is inside that tooth's
    # own bounding box by construction, so the nearest main-component voxel to any
    # fragment is inside it too.
    for s in L.STRUCTURES:
        if s.fdi is None:
            continue
        box = boxes[s.index - 1] if 0 < s.index <= len(boxes) else None
        if box is None:
            continue
        sub = merged[box] == s.index
        lab, n = ndimage.label(sub)
        if n <= 1:
            continue
        sizes = np.bincount(lab.ravel())
        sizes[0] = 0
        order = np.argsort(sizes)[::-1]
        main = lab == order[0]
        # Surface gap, not centroid distance: a root apex sheared off by a metal
        # streak sits ~1 mm from the tooth, an arch crossing sits ~17 mm away, and
        # centroid distance cannot tell those apart for an elongated structure.
        gap = ndimage.distance_transform_edt(~main, sampling=spacing_zyx)
        arch_box = arch[box] if arch is not None else None
        want = expected[s.fdi // 10]
        for k in order[1:]:
            if sizes[k] == 0:
                break
            comp = lab == k
            entry = {
                "fdi": s.fdi,
                "mm3": round(float(sizes[k]) * vox_mm3, 1),
                "fraction_of_tooth": round(float(sizes[k]) / float(sizes[order[0]]), 4),
                "gap_mm": round(float(gap[comp].min()), 2),
                "expected_arch": want,
                "arch": None,
            }
            if arch_box is not None:
                votes = arch_box[comp]
                voted = votes[votes != 0]
                coverage = float(voted.size) / float(max(1, int(comp.sum())))
                if coverage >= ARCH_MIN_COVERAGE and voted.size:
                    upper = float((voted == 1).sum()) / voted.size
                    share = max(upper, 1.0 - upper)
                    found = "upper" if upper >= 0.5 else "lower"
                    entry["arch"] = found
                    entry["arch_share"] = round(share, 3)
                    entry["arch_coverage"] = round(coverage, 3)
                    if found != want and share >= ARCH_MIN_MAJORITY:
                        rep.arch_conflicts.append(entry)
                        rep.arch_conflict_mm3 = round(
                            rep.arch_conflict_mm3 + entry["mm3"], 1)
            rep.tooth_fragments.append(entry)

    if rep.arch_conflicts:
        teeth = sorted({e["fdi"] for e in rep.arch_conflicts})
        rep.warnings.append(
            f"{len(rep.arch_conflicts)} tooth fragment(s) on "
            f"{', '.join(str(t) for t in teeth)} sit in the wrong arch "
            f"({rep.arch_conflict_mm3:.0f} mm3 total) -- the tooth model and the jaw "
            f"model disagree about which jaw those voxels are in"
        )


# The warning fires per TOOTH, not on the total. A few percent of every tooth voted
# the other way is the jaw model's own boundary bleed at the occlusal contact and says
# nothing about the numbering; a quarter of one tooth in the opposite jaw is a tooth
# that has been numbered across the contact, which is visible in the 3D view and is
# the thing worth telling someone about. Summing the first kind reaches thousands of
# mm3 on a healthy result and would make the warning fire every time.
ARCH_WRONG_WARN_SHARE = 0.25
ARCH_WRONG_WARN_MM3 = 50.0


def _check_arch_bulk(merged, rep, vox_mm3, arch, boxes) -> None:
    """How much of each numbered tooth the jaw model puts in the other jaw.

    Same evidence as `_tooth_fragments`, counted over the whole label. Two
    independently trained models disagreeing about which jaw a voxel is in is the
    strongest signal available on scans with no ground truth, and until the instance
    branch existed this pipeline could only see the part of it that had broken off.
    """
    if arch is None:
        return
    from .merge import ARCH_LOWER, ARCH_UPPER

    for s in L.STRUCTURES:
        if s.fdi is None:
            continue
        box = boxes[s.index - 1] if 0 < s.index <= len(boxes) else None
        if box is None:
            continue
        sub = merged[box] == s.index
        if not sub.any():
            continue
        votes = arch[box][sub]
        voted = votes[votes != 0]
        if voted.size == 0:
            continue                       # the jaw model has no opinion here
        want = ARCH_LOWER if s.fdi // 10 in (3, 4) else ARCH_UPPER
        wrong = int((voted != want).sum())
        if not wrong:
            continue
        rep.arch_wrong_by_tooth.append({
            "fdi": s.fdi,
            "mm3": round(wrong * vox_mm3, 1),
            "share_of_tooth": round(wrong / float(int(sub.sum())), 4),
            "jaw_model_coverage": round(voted.size / float(int(sub.sum())), 3),
        })
        rep.arch_wrong_mm3 += wrong * vox_mm3

    rep.arch_wrong_mm3 = round(rep.arch_wrong_mm3, 1)
    rep.arch_wrong_by_tooth.sort(key=lambda e: -e["mm3"])
    bad = [e for e in rep.arch_wrong_by_tooth
           if e["share_of_tooth"] >= ARCH_WRONG_WARN_SHARE and e["mm3"] >= ARCH_WRONG_WARN_MM3]
    if bad:
        worst = bad[0]
        rep.warnings.append(
            f"{len(bad)} tooth/teeth largely in the wrong jaw: "
            + ", ".join(f"{e['fdi']} ({e['share_of_tooth'] * 100:.0f}%)" for e in bad[:6])
            + f" -- worst is {worst['mm3']:.0f} mm3 of tooth {worst['fdi']} that the jaw "
            "model puts in the opposite arch, which is a tooth numbered across the "
            "occlusal contact"
        )


def _occlusal_contact(merged, rep, spacing_zyx, boxes) -> None:
    """Interface area where an upper-quadrant label touches a lower-quadrant one.

    Three shifted comparisons inside the union of the tooth bounding boxes, so this
    costs a fraction of a second even on the 193 M voxel case.
    """
    upper = [s.index for s in L.STRUCTURES if s.fdi and s.fdi // 10 in (1, 2)]
    lower = [s.index for s in L.STRUCTURES if s.fdi and s.fdi // 10 in (3, 4)]
    tooth_boxes = [boxes[i - 1] for i in upper + lower
                   if 0 < i <= len(boxes) and boxes[i - 1] is not None]
    if not tooth_boxes:
        return
    box = tuple(
        slice(min(b[a].start for b in tooth_boxes), max(b[a].stop for b in tooth_boxes))
        for a in range(3)
    )
    sub = merged[box]
    # A 256-entry lookup rather than np.isin: `sub` is 48 M voxels on the 0.25 mm case
    # and this runs six times below.
    up_lut = np.zeros(256, dtype=bool)
    lo_lut = np.zeros(256, dtype=bool)
    up_lut[upper], lo_lut[lower] = True, True
    up, lo = up_lut[sub], lo_lut[sub]
    if not (up.any() and lo.any()):
        return

    pairs: dict[tuple[int, int], float] = {}
    for ax in range(3):
        lhs = [slice(None)] * 3
        rhs = [slice(None)] * 3
        lhs[ax], rhs[ax] = slice(0, -1), slice(1, None)
        lhs, rhs = tuple(lhs), tuple(rhs)
        area = float(np.prod([spacing_zyx[a] for a in range(3) if a != ax]))
        a_lab, b_lab = sub[lhs], sub[rhs]
        for touching in (up[lhs] & lo[rhs], lo[lhs] & up[rhs]):
            if not touching.any():
                continue
            fa, fb = a_lab[touching].astype(np.int32), b_lab[touching].astype(np.int32)
            key = np.minimum(fa, fb) * 100 + np.maximum(fa, fb)
            for k, n in zip(*np.unique(key, return_counts=True)):
                pair = (int(k) // 100, int(k) % 100)
                pairs[pair] = pairs.get(pair, 0.0) + float(n) * area

    def _named(i: int, j: int) -> dict:
        a, b = L.BY_INDEX[i].fdi, L.BY_INDEX[j].fdi
        return {"upper": a, "lower": b} if a // 10 in (1, 2) else {"upper": b, "lower": a}

    rep.occlusal_contact_mm2 = round(sum(pairs.values()), 1)
    rep.occlusal_contact_pairs = [
        {**_named(i, j), "mm2": round(v, 1)}
        for (i, j), v in sorted(pairs.items(), key=lambda kv: -kv[1])[:8]
    ]


def _check_symmetry(rep, vox_mm3) -> None:
    """Contralateral teeth should be near-identical in volume."""
    for pair in ((1, 2), (4, 3)):
        for pos in range(1, 9):
            a_fdi, b_fdi = pair[0] * 10 + pos, pair[1] * 10 + pos
            a = rep.volumes_cm3.get(L.BY_FDI[a_fdi].id)
            b = rep.volumes_cm3.get(L.BY_FDI[b_fdi].id)
            if a is None or b is None or (a + b) == 0:
                continue          # a missing tooth is not an asymmetry finding
            diff = abs(a - b) / ((a + b) / 2)
            if diff > SYMMETRY_WARN_FRACTION:
                rep.symmetry_violations.append({
                    "pair": [a_fdi, b_fdi],
                    "mm3": [round(a * 1000, 1), round(b * 1000, 1)],
                    "difference": round(diff, 3),
                })
    if rep.symmetry_violations:
        worst = max(rep.symmetry_violations, key=lambda v: v["difference"])
        rep.warnings.append(
            f"{len(rep.symmetry_violations)} contralateral pair(s) differ by more than "
            f"{SYMMETRY_WARN_FRACTION:.0%} in volume, worst "
            f"{worst['pair'][0]}/{worst['pair'][1]} at {worst['difference']:.0%}"
        )


def truncation(merged: np.ndarray, boxes=None) -> dict:
    """Per structure: does its mask reach the edge of the volume, and by how much.

    Per structure and per FACE, because "the scan is small" and "THIS structure is cut"
    are different claims and only the second licenses withholding a finding about that
    structure.

    The boundary shell is one voxel deep on each of the six faces. A structure with more
    than `TRUNCATION_BOUNDARY_FRACTION` of its mass there was cut by the reconstruction
    rather than by anatomy -- measured, the cut structures on a small-field case read
    0.7-2.2% and everything inside reads exactly 0.
    """
    out: dict = {}
    nz, ny, nx = merged.shape
    faces = {
        "superior": (slice(0, 1), slice(None), slice(None)),
        "inferior": (slice(nz - 1, nz), slice(None), slice(None)),
        "posterior": (slice(None), slice(0, 1), slice(None)),
        "anterior": (slice(None), slice(ny - 1, ny), slice(None)),
        "right": (slice(None), slice(None), slice(0, 1)),
        "left": (slice(None), slice(None), slice(nx - 1, nx)),
    }
    counts = np.bincount(merged.ravel(), minlength=L.N_STRUCTURES + 2)
    per_face: dict[int, dict] = {}
    for name, sl in faces.items():
        fc = np.bincount(merged[sl].ravel(), minlength=L.N_STRUCTURES + 2)
        for idx in np.flatnonzero(fc):
            if not idx:
                continue
            per_face.setdefault(int(idx), {})[name] = int(fc[idx])
    for st in L.STRUCTURES:
        total = int(counts[st.index]) if st.index < len(counts) else 0
        if not total:
            continue
        touched = per_face.get(int(st.index), {})
        boundary = sum(touched.values())
        frac = boundary / total
        out[st.id] = {
            "truncated": frac > TRUNCATION_BOUNDARY_FRACTION,
            "faces": sorted(touched),
            "boundary_voxels": boundary,
            "boundary_fraction": round(frac, 6),
        }
    return out


def assess(
    merged: np.ndarray,
    spacing_zyx: tuple[float, float, float],
    direction=None,
    arch: np.ndarray | None = None,
    pipeline_name: str | None = None,
) -> QualityReport:
    """`merged` is the 37-class volume in (z, y, x); `spacing_zyx` matches it.

    `direction` is the source image's SimpleITK direction cosines, used to check
    FDI laterality against the scan itself rather than only against itself.

    `arch` is `merge.arch_mask(dentalseg)` -- the jaw model's per-voxel opinion about
    which arch a tooth voxel belongs to. Optional because the phantom tests and the
    benchmark script have no second model; without it the fragment report still says
    where each fragment is and how far away, just not who disagrees about it."""
    rep = QualityReport()
    # Computed FIRST: every plausibility check below asks whether the structure it is
    # about is cut by the edge of the scan before it raises a finding.
    rep.truncated = truncation(merged)
    rep.spacing_mm = tuple(float(s) for s in spacing_zyx)
    vox_mm3 = float(np.prod(spacing_zyx))
    rep.voxel_volume_mm3 = vox_mm3

    # Voxel counts for every structure in ONE pass, and every structure's bounding box
    # in a second. Both are shared by everything below.
    #
    # This used to be `{s.id: (merged == s.index) for s in L.STRUCTURES}` -- 37 boolean
    # arrays the size of the scan, held at once. On the 0.25 mm case that is 193 M
    # voxels x 37 = 7.1 GB, and on this single-node box, shared with two live GPU
    # services and the cluster Postgres, it was enough to invoke the OOM killer and
    # take out unrelated pods. Counts and boxes are kilobytes, and every per-structure
    # operation below works inside its own box.
    from scipy import ndimage

    counts = np.bincount(merged.ravel(), minlength=L.N_STRUCTURES + 2)
    boxes = ndimage.find_objects(merged)
    for st in L.STRUCTURES:
        n = int(counts[st.index]) if st.index < len(counts) else 0
        if not n:
            continue
        rep.volumes_cm3[st.id] = round(n * vox_mm3 / 1000.0, 3)

    for sid, band in PLAUSIBLE_CM3.items():
        # A source-keyed band applies only to the pipeline it was measured on. An
        # unrecognised pipeline gets NO band rather than someone else's.
        if isinstance(band, dict):
            band = band.get(pipeline_name)
            if band is None:
                continue
        lo, hi = band
        v = rep.volumes_cm3.get(sid)
        cut = (rep.truncated or {}).get(sid)
        if v is None:
            rep.warnings.append(f"{sid}: absent from the prediction")
        elif cut and cut.get("truncated"):
            # Stated as a fact about the scan, not raised as a finding about the model.
            rep.notes.append(
                f"{sid}: {v} cm3, and it reaches the edge of the reconstructed volume "
                f"({cut['boundary_fraction'] * 100:.1f}% of it on the boundary), so its "
                f"extent is the field of view rather than the anatomy and is not "
                f"compared against the {lo}-{hi} cm3 range")
        elif not (lo <= v <= hi):
            rep.warnings.append(f"{sid}: {v} cm3 outside the plausible range {lo}-{hi} cm3")

    # Per-tooth volume. Only an upper-and-lower band on teeth that ARE present -- an
    # absent tooth is a fact about the patient, not a finding. Measured on this data:
    # tooth 48 on the post-surgery case is 86 mm3, a fifth of the smallest plausible
    # third molar, and it used to pass without comment because only the mandible and
    # the canal had ranges at all.
    implausible = []
    truncated_teeth = []
    for s in L.STRUCTURES:
        if s.fdi is None:
            continue
        v = rep.volumes_cm3.get(s.id)
        if v is None:
            continue
        lo, hi = PLAUSIBLE_TOOTH_MM3[s.fdi % 10]
        mm3 = v * 1000.0
        if lo <= mm3 <= hi:
            continue
        # A tooth clipped by the reconstruction cylinder is SMALL because the scan
        # stops, not because the model failed. This was the second-largest live source
        # of false findings: any tooth half-outside the field fell below its floor.
        cut = (rep.truncated or {}).get(s.id)
        if cut and cut.get("truncated") and mm3 < lo:
            truncated_teeth.append(f"{s.fdi}")
        else:
            implausible.append(f"{s.fdi} ({mm3:.0f} mm3)")
    if implausible:
        rep.warnings.append(
            f"{len(implausible)} tooth/teeth outside the plausible volume range: "
            + ", ".join(implausible)
        )
    if truncated_teeth:
        rep.notes.append(
            f"{len(truncated_teeth)} tooth/teeth are cut by the edge of the "
            f"reconstructed volume and are smaller than a whole tooth for that reason: "
            + ", ".join(truncated_teeth))

    # Fragmentation, per tooth and for the canal -- each inside its own bounding box.
    for st in L.STRUCTURES:
        box = boxes[st.index - 1] if 0 < st.index <= len(boxes) else None
        if box is None:
            continue
        c = _largest_components(merged[box] == st.index)
        rep.components[st.id] = c
        if st.fdi is not None:
            if c > 1:
                rep.teeth_fragmented.append(st.fdi)
        elif st.id == "canal":
            rep.canal_components = c
    rep.teeth_found = sum(1 for st in L.STRUCTURES
                          if st.fdi is not None and rep.volumes_cm3.get(st.id))
    rep.teeth_fragmented.sort()

    # The canal is EXEMPT from component filtering by design -- a thin tube broken by a
    # partial-volume gap is still a canal -- so partial-volume breaks survive into this
    # count, and a canal cut by the edge of the scan is in more pieces for a reason that
    # is not a defect. Measured live: 2 of 5 real cases report 3 components, and this
    # warning used to be the only finding on them.
    #
    # It no longer suppresses the implant verdict either: `plan_safety.canal_verdict`
    # takes the LOCAL test (is the canal broken within a few mm of THIS implant) and
    # carries the count as a note. A global count vetoing a local measurement lost the
    # grade for a fragment 40 mm away.
    canal_cut = (rep.truncated or {}).get("canal", {}).get("truncated")
    if rep.canal_components and rep.canal_components != 2 and canal_cut:
        rep.notes.append(
            f"canal has {rep.canal_components} significant component(s) rather than 2, "
            f"and it reaches the edge of the reconstructed volume -- a canal that leaves "
            f"the field of view is in more pieces for that reason")
    elif rep.canal_components and rep.canal_components != 2:
        rep.warnings.append(
            f"canal has {rep.canal_components} significant component(s); expected 2 (one per side)"
        )

    rep.arch_checked = arch is not None
    _tooth_fragments(merged, rep, vox_mm3, spacing_zyx, arch, boxes)
    _check_arch_bulk(merged, rep, vox_mm3, arch, boxes)
    _occlusal_contact(merged, rep, spacing_zyx, boxes)
    _check_symmetry(rep, vox_mm3)
    _check_laterality(merged, rep, left_axis_sign_from_direction(direction) if direction else None)
    _check_vertical(merged, rep, superior_axis_sign_from_direction(direction) if direction else None)
    return rep


def _check_laterality(merged: np.ndarray, rep: QualityReport, left_axis_sign: int | None) -> None:
    """Is the FDI numbering laterally self-consistent, and does it match the scan?

    FDI quadrants 1 and 4 are the patient's RIGHT, 2 and 3 the LEFT.

    An earlier version of this derived the left/right convention by majority vote
    over all four quadrants and then flagged individual teeth. A phantom with the
    upper arch deliberately mirrored showed why that is wrong: with two quadrants
    flipped and two not, the vote is a coin toss, and it confidently named the
    eight *innocent* lower teeth. Detecting "something is mirrored" while
    accusing the wrong arch is worse than useless in a clinical tool.

    So the check is now three separate relationships, each of which can fail on
    its own and each of which names what it actually observed:

      * `upper_arch`  - quadrants 1 and 2 sit on opposite sides of each other
      * `lower_arch`  - quadrants 4 and 3 sit on opposite sides of each other
      * `arches_agree`- quadrant 1 and quadrant 4 (both patient-right) are on the
                        SAME side. This is the relationship a mirrored arch
                        breaks, and it needs no external reference at all.

    Plus, when the image direction cosines are available, an absolute check that
    quadrants 1/4 really are on the patient's right. `left_axis_sign` is +1 when
    increasing the last array axis moves toward patient-left, -1 when it moves
    right, and None when we could not tell.
    """
    centroids: dict[int, float] = {}
    for s in L.STRUCTURES:
        if s.fdi is None:
            continue
        m = merged == s.index
        counts = m.sum(axis=(0, 1)).astype(np.float64)
        total = counts.sum()
        if total:
            centroids[s.fdi] = float((counts * np.arange(counts.size)).sum() / total)

    def q_mean(*quadrants: int) -> float | None:
        vals = [v for f, v in centroids.items() if f // 10 in quadrants]
        return float(np.mean(vals)) if vals else None

    q1, q2, q3, q4 = (q_mean(n) for n in (1, 2, 3, 4))
    checks: list[dict] = []

    def relation(name: str, a: float | None, b: float | None, want_opposite: bool, detail: str):
        if a is None or b is None:
            checks.append({"check": name, "result": "skipped", "detail": "one side has no teeth"})
            return None
        # "opposite" means a and b straddle their own shared midline.
        separated = abs(a - b) > 1.0
        if not separated:
            checks.append({"check": name, "result": "skipped", "detail": "sides are not separated"})
            return None
        ok = True if want_opposite else None
        checks.append({"check": name, "result": "ok" if ok else "info", "detail": detail,
                       "separation_voxels": round(abs(a - b), 1)})
        return a < b  # True when the first group sits at the lower index

    upper_right_low = relation("upper_arch", q1, q2, True, "quadrants 1 and 2 are separated")
    lower_right_low = relation("lower_arch", q4, q3, True, "quadrants 4 and 3 are separated")

    if upper_right_low is not None and lower_right_low is not None:
        agree = upper_right_low == lower_right_low
        checks.append(
            {
                "check": "arches_agree",
                "result": "ok" if agree else "FAILED",
                "detail": (
                    "the upper and lower arches place the patient's right on the same side"
                    if agree
                    else "the upper and lower arches disagree about which side is the patient's "
                         "right — one arch is mirrored"
                ),
            }
        )
        if not agree:
            rep.warnings.append(
                "LATERALITY: the upper and lower arches disagree about which side is the "
                "patient's right — one arch is numbered mirrored. This is the known "
                "left/right confusion failure mode of CBCT tooth numbering."
            )

    known = upper_right_low if upper_right_low is not None else lower_right_low
    if left_axis_sign is not None and known is not None:
        # `known` is True when FDI-right teeth sit at the LOWER index. Increasing
        # index moves toward patient-left when left_axis_sign is +1, so right
        # teeth SHOULD be at the lower index exactly then.
        expected_right_low = left_axis_sign > 0
        ok = known == expected_right_low
        checks.append(
            {
                "check": "matches_image_orientation",
                "result": "ok" if ok else "FAILED",
                "detail": (
                    "FDI right/left matches the scan's direction cosines"
                    if ok
                    else "every tooth is numbered on the wrong side relative to the scan's "
                         "own orientation — the whole arch is mirrored"
                ),
            }
        )
        if not ok:
            rep.warnings.append(
                "LATERALITY: FDI numbering is mirrored with respect to the scan's direction "
                "cosines — left and right are swapped throughout."
            )
    elif left_axis_sign is None:
        checks.append({"check": "matches_image_orientation", "result": "skipped",
                       "detail": "no usable direction cosines; only internal consistency was checked"})

    rep.laterality_checks = checks
    failed = [c for c in checks if c["result"] == "FAILED"]
    rep.laterality_violations = failed
    if not centroids or len(centroids) < 4:
        rep.laterality_ok = None
        rep.warnings.append(f"laterality not checked: only {len(centroids)} tooth/teeth found")
    elif any(c["result"] == "ok" for c in checks):
        rep.laterality_ok = not failed
    else:
        rep.laterality_ok = None


def _check_vertical(merged: np.ndarray, rep: QualityReport, superior_axis_sign: int | None) -> None:
    """Is the maxilla above the mandible, and does that match the scan's own header?

    Unlike laterality this needs no majority vote and no phantom-driven subtlety:
    a jaw is not vertically symmetric, so "upper structures sit superior to lower
    ones" is true of every head, in every field of view, with no exceptions to
    carve out. That makes it the strongest orientation check available.

    Two relationships, mirroring `_check_laterality`:

      * `arches_stacked` - upper teeth (FDI quadrants 1, 2) and lower teeth
                           (3, 4) are separated along the first array axis. This
                           is internal and needs no reference.
      * `matches_image_orientation` - the upper arch really is at the superior
                           end, according to the direction cosines. THIS is the
                           check that catches a lying header.

    Falls back to maxilla-versus-mandible when there are too few teeth, so a
    small field of view or an edentulous jaw is still covered.

    `superior_axis_sign` is +1 when increasing the FIRST array axis moves toward
    the patient's head, -1 when it moves toward the feet, None when unreadable.
    """
    checks: list[dict] = []

    def axis0_centroid(indices: list[int]) -> float | None:
        m = np.isin(merged, indices) if len(indices) > 1 else (merged == indices[0])
        counts = m.sum(axis=(1, 2)).astype(np.float64)
        total = counts.sum()
        if not total:
            return None
        return float((counts * np.arange(counts.size)).sum() / total)

    upper_idx = [s.index for s in L.STRUCTURES if s.fdi is not None and s.fdi // 10 in (1, 2)]
    lower_idx = [s.index for s in L.STRUCTURES if s.fdi is not None and s.fdi // 10 in (3, 4)]
    upper = axis0_centroid(upper_idx) if upper_idx else None
    lower = axis0_centroid(lower_idx) if lower_idx else None
    source = "teeth"

    # No teeth to speak of: fall back to the jawbones, which are present in almost
    # every scan and are just as unambiguous vertically.
    if upper is None or lower is None or abs(upper - lower) <= 1.0:
        maxilla = next((s.index for s in L.STRUCTURES if s.id == "maxilla"), None)
        mandible = next((s.index for s in L.STRUCTURES if s.id == "mandible"), None)
        if maxilla is not None and mandible is not None:
            u2, l2 = axis0_centroid([maxilla]), axis0_centroid([mandible])
            if u2 is not None and l2 is not None and abs(u2 - l2) > 1.0:
                upper, lower, source = u2, l2, "jawbones"

    if upper is None or lower is None:
        checks.append({"check": "arches_stacked", "result": "skipped",
                       "detail": "no upper/lower pair found to compare"})
        rep.vertical_checks = checks
        rep.vertical_ok = None
        return
    if abs(upper - lower) <= 1.0:
        checks.append({"check": "arches_stacked", "result": "skipped",
                       "detail": f"upper and lower {source} are not vertically separated"})
        rep.vertical_checks = checks
        rep.vertical_ok = None
        return

    upper_low = upper < lower  # upper structures sit at the LOWER array index
    checks.append({"check": "arches_stacked", "result": "ok",
                   "detail": f"upper and lower {source} are separated along the slice axis",
                   "separation_voxels": round(abs(upper - lower), 1),
                   "source": source})

    if superior_axis_sign is None:
        checks.append({"check": "matches_image_orientation", "result": "skipped",
                       "detail": "no usable direction cosines; only internal consistency was checked"})
    else:
        # Increasing index moves toward the head when the sign is +1, so upper
        # structures belong at the HIGHER index exactly then.
        expected_upper_low = superior_axis_sign < 0
        ok = upper_low == expected_upper_low
        checks.append({
            "check": "matches_image_orientation",
            "result": "ok" if ok else "FAILED",
            "detail": (
                "upper structures are superior to lower ones, as the scan's direction "
                "cosines describe"
                if ok
                else "the scan is upside down: its direction cosines put the mandible "
                     "ABOVE the maxilla. Either the header is wrong or the volume was "
                     "flipped along the slice axis."
            ),
        })
        if not ok:
            rep.warnings.append(
                "ORIENTATION: the mandible sits above the maxilla relative to the scan's own "
                "direction cosines — the volume is superior-inferior inverted. Every export "
                "(RTSTRUCT, meshes, slice tiles) inherits this."
            )

    rep.vertical_checks = checks
    rep.vertical_violations = [c for c in checks if c["result"] == "FAILED"]
    rep.vertical_ok = not rep.vertical_violations


def superior_axis_sign_from_direction(direction) -> int | None:
    """+1 if increasing the FIRST array axis moves toward the patient's head.

    The vertical twin of `left_axis_sign_from_direction`. SimpleITK's direction is
    the row-major 3x3 mapping index (i, j, k) to LPS world, and in LPS +z is
    superior. Numpy arrays are (k, j, i), so the first numpy axis is sitk's `k` --
    index column 2 -- and its contribution to world z is `direction[8]`.

    Returns None for a near-degenerate case rather than guessing.
    """
    try:
        d22 = float(direction[8])
    except (TypeError, IndexError, ValueError):
        return None
    if abs(d22) < 0.5:  # the superior-inferior world axis is not primarily this index axis
        return None
    return 1 if d22 > 0 else -1


def left_axis_sign_from_direction(direction) -> int | None:
    """+1 if increasing the LAST array axis moves toward patient-left, else -1.

    SimpleITK's `GetDirection()` is the row-major 3x3 mapping index (i, j, k) to
    LPS world, and in LPS the +x axis IS patient-left. Numpy arrays from
    `GetArrayFromImage` are (k, j, i), so the last numpy axis is sitk's `i` and
    its contribution to world-x is `direction[0]`.

    Returns None for a near-degenerate case rather than guessing, so the caller
    can fall back to internal consistency alone.
    """
    try:
        d00 = float(direction[0])
    except (TypeError, IndexError, ValueError):
        return None
    if abs(d00) < 0.5:  # the left-right world axis is not primarily this index axis
        return None
    return 1 if d00 > 0 else -1
