"""ToothSeg's second branch: one number per tooth, instead of one number per voxel.

The semantic branch (`models/toothseg_semantic`, Dataset121) is a 33-class argmax
with no notion of a tooth as an object. Where an upper and a lower crown meet in
occlusion there is no boundary cue -- two slabs of enamel touching -- so the label
flips across the contact and part of one tooth is numbered as its opposing
neighbour. Because the competing classes at that spot are the mirror-position
numbers, the flips land as 21/31, 23/33, 12/42, 24/35. Measured on the three stored
examples before this module existed: 232, 72 and 180 mm3 of numbered tooth sitting
more than 2 mm inside the *opposing* jaw, six to thirty-three times more often
lower-numbers-in-the-maxilla than the reverse.

The fix is the branch that was downloaded and never wired in: Dataset123 predicts a
**border-core** map (`center`, `border`) at 0.2 mm, whose connected cores are teeth
as objects. Every voxel of one object then gets one number, so "one tooth, two
colours" stops being representable.

Four things here are deliberately not upstream, three of them because the branch on
its own made the defect worse on the first real scan it saw:

* **The arch is decided first, and by the other model.** Upstream reads it off
  ToothSeg's own class mass, which is precisely the signal that is wrong at the
  occlusal contact. We use DentalSegmentator's independent per-voxel opinion
  (`merge.arch_mask`) -- until now computed and only reported.
* **A core the jaw model puts in both jaws is cut along the line it draws.** The
  border-core model fuses occluding molars just as readily as the semantic one
  mislabels them; `split_across_arches` measures what that cost.
* **The split rule is restricted to one arch**, or it cuts the two-coloured tooth in
  half and frees the halves to be numbered separately. See `_instance_parts`.
* **The tooth extent never changes.** Output is the semantic branch's tooth mask,
  voxel for voxel; the instance map only decides *which number* each of those voxels
  gets, and `renumber` asserts it. That keeps `merge`'s cross-model Dice, the
  unnumbered residual, the meshes and the RTSTRUCT contours identical to what the
  semantic branch alone produced, and confines this module's authority to numbering.

And it never fails a job: every guard below returns the semantic argmax unchanged with
a reason in the report, because a numbering regression must be visible, not silent.

The sequence model is a faithful port of `assign_mincost_tooth_labels.py` from
MIC-DKFZ/ToothSeg (Apache-2.0), reimplemented against our arrays because upstream is
a folder-at-a-time CLI on nibabel with on-disk caching. See `dentistry/vendor/NOTICE`.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field, asdict
from pathlib import Path

import numpy as np

from . import labels as L

log = logging.getLogger("dentistry.instances")

# --------------------------------------------------------------------------- #
# Upstream constants. The two thresholds are VOLUMES IN mm3 and differ from the   #
# acvl_utils defaults of 30/15, so they are always passed explicitly.            #
# --------------------------------------------------------------------------- #
SMALL_CENTER_MM3 = 16.0            # 2000 voxels at 0.2 mm
ISOLATED_BORDER_MM3 = 0.0          # border with no core is deleted, not kept
MIN_INSTANCE_MM3 = 16.0
# A core the semantic branch assigns to two different SAME-ARCH teeth, each with a
# tooth-sized share of it, is two teeth the border-core model failed to separate.
#
# Upstream's version of this rule keys on confidence -- two classes above 0.95 -- and
# on a 0.5 mm scan it never fires while the cores are visibly wrong. Measured on the
# pre-operative example (0.5 mm, upsampled 2.5x to reach the instance branch's working
# spacing, which is asking it to resolve a boundary the acquisition never recorded):
# 27 cores for 31 teeth, and eight of them straddling an adjacent pair -- 18+17, 27+28,
# 26+25, 15+16, 17+16, 37+38. Every one of those is a pair of NEIGHBOURS in the same
# arch, which is the boundary the semantic branch is good at; the boundary it is bad at
# is the occlusal contact, and that is the one place this rule must not fire.
#
# So the criterion is volume, not confidence, and the arch restriction is what makes it
# safe. On that same scan, core 9 holds tooth 24 and a 208 mm3 patch labelled 35 -- the
# exact defect reported -- and because those are opposite arches the core is left whole
# and the whole thing is numbered 24.
#
# Volume also means the rule behaves identically with or without a softmax, which the
# confidence version could not: against a one-hot histogram a 0.95 threshold silently
# becomes "a second class covers a tenth of this core".
SPLIT_MIN_MM3 = 100.0              # under the 150 mm3 floor of the smallest real tooth
SPLIT_MIN_SHARE = 0.20             # ...and this much of the core
BACKGROUND_PROB = 0.95             # an instance the semantic branch calls background
TOOTH_FACTOR = 4.0                 # unary vs pairwise weight in the Viterbi cost
PROB_FLOOR = 1e-6                  # upstream's guard before log()

# An instance the jaw model assigns to BOTH arches, in at least this proportion and
# with at least this much volume on the minority side, is two teeth fused across the
# occlusal contact rather than one tooth.
#
# This is not hypothetical and it is not rare. On the first real scan run through the
# branch (MG_test_scan, 0.33 mm) it returned 24 cores for ~28 teeth: the upper and
# lower molars came back as single objects, so 16, 17, 26 and 27 were each handed a
# fused blob, came out at 1900-2100 mm3 against a 1800 mm3 ceiling for a molar, and
# put 47% of "tooth 16" inside the mandible -- a worse version of the defect the
# branch was wired in to fix. The border-core model has no more signal at that
# contact than the semantic one does; the jaw model does, because it was trained to
# tell the maxilla from the mandible and never had to name a tooth.
ARCH_SPLIT_MIN_SHARE = 0.15
ARCH_SPLIT_MIN_MM3 = 30.0

# A class holding at least this much is a tooth rather than a scattering of voxels,
# and the count of those may not fall by more than TOOTH_LOSS_LIMIT across the
# renumbering. Losing teeth means cores were fused, which is the failure measured
# above; a small fall is expected and fine, because collapsing a spurious handful of
# voxels into the tooth they belong to is the entire point.
REAL_TOOTH_MM3 = 50.0
TOOTH_LOSS_LIMIT = 3

# An instance needs this share of its voxels covered by a DentalSegmentator tooth
# label before its arch vote counts. Mirrors the coverage floor quality.py already
# applies to the same signal.
ARCH_MIN_COVERAGE = 0.20
# How far a semantic tooth voxel may be from any instance and still be adopted by it.
# Beyond this the semantic branch's own class is kept: a speck 10 mm from every tooth
# is not part of the nearest one.
ADOPT_MAX_MM = 3.0

N_CLASSES = 33                     # background + 32 teeth
PER_ARCH = 16

_VENDOR = Path(__file__).resolve().parent / "vendor" / "fdi_pair_distrs.json"


@dataclass
class NumberingReport:
    """What the branch did, in the shape the run-details card wants."""
    used: bool = False
    fallback: str | None = None
    n_instances: int = 0
    n_parts: int = 0
    n_arch_split: int = 0
    # Real teeth in, real teeth out. A numbering pass that loses teeth has
    # merged them, and is worse than the argmax it replaced.
    teeth_before: int = 0
    teeth_after: int = 0
    n_split: int = 0
    n_background: int = 0
    arch_from_jaw_model: int = 0
    arch_from_tooth_model: int = 0
    # instances whose Viterbi number differs from the plain per-instance argmax --
    # i.e. the ones the sequence prior actually moved.
    n_resequenced: int = 0
    resequenced: list[dict] = field(default_factory=list)
    # semantic tooth voxels no instance claimed, and how many were adopted anyway
    orphan_voxels: int = 0
    adopted_voxels: int = 0
    changed_voxels: int = 0
    seconds: float = 0.0

    def to_dict(self) -> dict:
        return asdict(self)


# How far past the semantic tooth mask the probability table is kept. The instance
# branch draws its own boundary, so a core can poke a voxel or two outside; three is
# comfortably past that and still costs almost nothing.
PROB_MASK_DILATE = 3


class ProbTable:
    """Class probabilities, kept only where something will read them.

    nnU-Net hands back a dense `(33, z, y, x)` float32 softmax. On the largest ROI this
    pipeline accepts that is 3.7 GB, and 1.8 GB even as float16 -- on a box with about
    10 GB free that has already been OOM-killed once. But the only thing that ever
    reads it is a per-instance mean over TEETH, which are a few percent of the ROI. So
    the array is kept sparse: float16 values for the tooth mask dilated by a few
    voxels, plus an int32 index. Measured on a 0.33 mm scan, 1.08 GB becomes ~100 MB.

    `gather` returns background for a voxel outside the mask, which after dilation is
    a handful per case and cannot move a mean taken over thousands.
    """

    __slots__ = ("shape", "n_classes", "_index", "_values", "kept", "bytes")

    def __init__(self, probs, mask):
        from scipy import ndimage

        if PROB_MASK_DILATE:
            mask = ndimage.binary_dilation(mask, iterations=PROB_MASK_DILATE)
        self.shape = tuple(probs.shape[1:])
        self.n_classes = int(probs.shape[0])
        self.kept = int(mask.sum())
        self._index = np.full(self.shape, -1, dtype=np.int32)
        self._index[mask] = np.arange(self.kept, dtype=np.int32)
        self._values = probs[:, mask].astype(np.float16)
        self.bytes = self._index.nbytes + self._values.nbytes

    def gather(self, idx) -> np.ndarray:
        """(n_classes, m) float32 for the voxels at `idx`, a tuple of index arrays."""
        pos = self._index[idx]
        out = np.zeros((self.n_classes, pos.size), dtype=np.float32)
        hit = pos >= 0
        if hit.any():
            out[:, hit] = self._values[:, pos[hit]]
        out[0, ~hit] = 1.0
        return out


# --------------------------------------------------------------------------- #
# The vendored tooth-pair prior.                                               #
# --------------------------------------------------------------------------- #
def load_pair_normals(path: Path | None = None):
    """32x32 frozen Gaussians over the centroid offset between two teeth.

    Row/column k is Dataset121 class k+1, so 0-15 is the upper arch and 16-31 the
    lower. Cross-arch entries are None and are never consulted -- the sequence runs
    per arch.

    **The offsets are in (left, anterior, superior) millimetres.** That is not a
    guess and not the RAS the upstream script's variable names suggest; it is read
    straight off the table, which is self-consistent about it: 11 -> 21 is
    (+8.34, 0, 0) and 21 -> 11 is (-8.34, 0, 0), so axis 0 grows toward the patient's
    LEFT, while 11 -> 18 is (-20.37, -44.51, ...) and its mirror 21 -> 28 is
    (+20.37, -44.51, ...), so axis 1 grows ANTERIORLY. Get this wrong and nothing
    raises -- the arch is simply numbered backwards or mirrored, which is the one
    failure this project cannot ship. `tests/test_phantom.py` locks both signs down.
    """
    from scipy.stats import multivariate_normal

    raw = json.loads((path or _VENDOR).read_text())
    means = np.asarray(raw["means"], dtype=np.float64)
    covs = np.asarray(raw["covs"], dtype=np.float64)
    if means.shape != (32, 32, 3) or covs.shape != (32, 32, 3, 3):
        raise ValueError(f"unexpected pair-distribution shape {means.shape} / {covs.shape}")

    out = []
    for i in range(32):
        row = []
        for j in range(32):
            if i // PER_ARCH != j // PER_ARCH:
                row.append(None)          # cross-arch: never used
                continue
            row.append(multivariate_normal(mean=means[i, j][:2], cov=covs[i, j][:2, :2]))
        out.append(row)
    return out


# --------------------------------------------------------------------------- #
# Border-core -> instances.                                                     #
# --------------------------------------------------------------------------- #
def border_core_to_instances(border_core: np.ndarray, spacing_zyx) -> np.ndarray:
    """Dataset123's `center`/`border` map -> one integer per tooth.

    `acvl_utils` is an nnU-Net dependency and already in the venv; this is the same
    call `border_core_to_instances.py` makes, with upstream's thresholds rather than
    the library defaults.
    """
    from acvl_utils.instance_segmentation.instance_as_semantic_seg import (
        BORDER_LABEL, CENTER_LABEL, convert_semantic_to_instanceseg,
        postprocess_instance_segmentation,
    )

    # If these ever stop matching Dataset123's dataset.json the cores and borders
    # swap roles and every tooth merges with its neighbour, silently.
    if (CENTER_LABEL, BORDER_LABEL) != (1, 2):
        raise RuntimeError(
            f"acvl_utils uses center={CENTER_LABEL} border={BORDER_LABEL}, but "
            "Dataset123 emits center=1 border=2"
        )

    spacing = tuple(float(s) for s in spacing_zyx)
    inst = convert_semantic_to_instanceseg(
        np.ascontiguousarray(border_core, dtype=np.uint8),
        spacing=spacing,
        small_center_threshold=SMALL_CENTER_MM3,
        isolated_border_as_separate_instance_threshold=ISOLATED_BORDER_MM3,
    )
    inst = _drop_small_instances(inst, float(np.prod(spacing)), MIN_INSTANCE_MM3)
    inst = postprocess_instance_segmentation(inst)
    return _compact(inst)


def _drop_small_instances(inst: np.ndarray, voxel_mm3: float, min_mm3: float) -> np.ndarray:
    if min_mm3 <= 0:
        return inst
    counts = np.bincount(inst.ravel())
    counts[0] = 0
    victims = np.nonzero(counts * voxel_mm3 < min_mm3)[0]
    victims = victims[victims != 0]
    if victims.size:
        inst = np.where(np.isin(inst, victims), 0, inst)
    return inst


def _compact(inst: np.ndarray) -> np.ndarray:
    """Renumber to 0..n with no gaps, so every downstream array can be indexed by id.

    Narrowed to int16 while it is at it. This array lives on the 0.2 mm grid, which is
    94 M voxels on the largest scan here -- 375 MB as int32 against 188 MB as int16,
    next to whatever `convert_semantic_to_instanceseg` is still holding.
    """
    present = np.unique(inst)
    present = present[present != 0]
    dtype = np.int16 if present.size < 30000 else np.int32
    lut = np.zeros(int(inst.max()) + 1 if inst.size else 1, dtype=dtype)
    lut[present] = np.arange(1, present.size + 1, dtype=dtype)
    return lut[inst]


# --------------------------------------------------------------------------- #
# Geometry.                                                                     #
# --------------------------------------------------------------------------- #
def centroids_las(inst: np.ndarray, n: int, image) -> np.ndarray:
    """(n, 3) instance centroids in (left, anterior, superior) millimetres.

    Derived from the image's own direction cosines rather than from any assumption
    about the canonical frame, so a change to `worker/orient.py` cannot silently
    mirror the numbering. SimpleITK physical space is LPS, and LAS is LPS with the
    posterior axis negated; only offsets are ever used, so the origin cancels.
    """
    idx = np.nonzero(inst)
    lab = inst[idx]
    counts = np.bincount(lab, minlength=n + 1).astype(np.float64)
    counts[counts == 0] = 1.0
    # numpy axes are (z, y, x); SimpleITK indexes (x, y, z).
    cz = np.bincount(lab, weights=idx[0], minlength=n + 1) / counts
    cy = np.bincount(lab, weights=idx[1], minlength=n + 1) / counts
    cx = np.bincount(lab, weights=idx[2], minlength=n + 1) / counts

    D = np.asarray(image.GetDirection(), dtype=np.float64).reshape(3, 3)
    sp = np.asarray(image.GetSpacing(), dtype=np.float64)
    org = np.asarray(image.GetOrigin(), dtype=np.float64)

    ijk = np.stack([cx[1:], cy[1:], cz[1:]], axis=1) * sp     # (n, 3) in xyz
    lps = org + ijk @ D.T
    return np.stack([lps[:, 0], -lps[:, 1], lps[:, 2]], axis=1)


# --------------------------------------------------------------------------- #
# Ported from assign_mincost_tooth_labels.py.                                   #
# --------------------------------------------------------------------------- #
def determine_sequence(centroids: np.ndarray):
    """Order instances along the arch: start at the most posterior, then nearest-first.

    Starting at an *end* of the arch is what makes the chain a chain; starting in the
    middle would zigzag across the midline. Axis 1 is anterior, so argmin is the most
    posterior tooth -- one of the two third molars. Which of the two does not matter,
    because the Viterbi below is initialised over all sixteen positions.
    """
    n = centroids.shape[0]
    order = np.full(n, -1, dtype=int)
    rank = np.full(n, -1, dtype=int)

    first = int(centroids[:, 1].argmin())
    order[0] = first
    rank[first] = 0
    for i in range(1, n):
        free = np.nonzero(rank == -1)[0]
        dists = np.linalg.norm(centroids[free] - centroids[order[i - 1]], axis=-1)
        nxt = int(free[int(dists.argmin())])
        order[i] = nxt
        rank[nxt] = i
    return order, rank


def transition_log_probs(normals, centroids: np.ndarray, is_lower: bool, order) -> np.ndarray:
    """(n-1, 16, 16): log density of the observed step under "position j -> position k"."""
    base = PER_ARCH if is_lower else 0
    out = np.zeros((max(0, centroids.shape[0] - 1), PER_ARCH, PER_ARCH))
    for i, (a, b) in enumerate(zip(order[:-1], order[1:])):
        offset = (centroids[b] - centroids[a])[:2]
        for j in range(PER_ARCH):
            for k in range(PER_ARCH):
                out[i, j, k] = normals[base + j][base + k].logpdf(offset)
    return out


def viterbi(tooth_probs: np.ndarray, order, trans_log_probs: np.ndarray,
            tooth_factor: float = TOOTH_FACTOR):
    """Min-cost path over arch positions: what each tooth looks like, and where it sits.

    `tooth_probs` is (n, 16) per-instance class probability within this arch, `order`
    the walk from `determine_sequence`. Returns the position (0-15) chosen for each
    step of the walk.
    """
    n = tooth_probs.shape[0]
    unary = -tooth_factor * np.log(np.clip(tooth_probs, PROB_FLOOR, None))

    q = np.zeros((n, PER_ARCH))
    back = np.zeros((n, PER_ARCH), dtype=int)
    q[0] = unary[order[0]]
    back[0] = np.arange(PER_ARCH)

    for i in range(1, n):
        costs = q[i - 1][:, None] - trans_log_probs[i - 1]     # (prev, next)
        back[i] = costs.argmin(axis=0)
        q[i] = costs.min(axis=0) + unary[order[i]]

    path = np.zeros(n, dtype=int)
    path[-1] = int(q[-1].argmin())
    for i in range(n - 2, -1, -1):
        path[i] = back[i + 1][path[i + 1]]
    return path, float(q[-1].min())


# --------------------------------------------------------------------------- #
# Cut instances that span both jaws, before anything else looks at them.        #
# --------------------------------------------------------------------------- #
def _fill_by_nearest(mask: np.ndarray, seeds: np.ndarray, spacing_zyx) -> np.ndarray:
    """Grow `seeds` (1..k, 0 = undecided) to cover all of `mask`, nearest seed wins.

    Used wherever a core has to be partitioned and some of its voxels have no opinion
    attached to them: both the arch cut and the same-arch split need the two halves to
    tile the core exactly, with no gap and nothing dropped.
    """
    from scipy import ndimage

    undecided = mask & (seeds == 0)
    if not undecided.any() or not (seeds > 0).any():
        return seeds
    _, ind = ndimage.distance_transform_edt(seeds == 0, sampling=spacing_zyx,
                                            return_indices=True)
    grown = seeds[tuple(ind)]
    out = seeds.copy()
    out[undecided] = grown[undecided]
    return out


def split_across_arches(inst: np.ndarray, n: int, arch, voxel_mm3: float, spacing_zyx):
    """Cut any core the jaw model says is in both jaws, along the line it draws.

    The occlusal contact is two slabs of enamel touching with nothing between them,
    so neither tooth model has a boundary cue there -- which is why the semantic
    branch flips labels across it and why the instance branch sometimes fuses the two
    teeth into one core. The jaw model does have a cue, because maxilla and mandible
    are different bones. Splitting on its opinion puts the cut exactly at the contact.

    Voxels the jaw model has no opinion about go to whichever side is nearer, so the
    two halves partition the core with no gap and no loss.
    """
    from scipy import ndimage

    from .merge import ARCH_LOWER, ARCH_UPPER

    if arch is None or n == 0:
        return inst, n, 0

    flat = inst.ravel()
    sel = flat > 0
    ids = flat[sel]
    a = arch.ravel()[sel]
    up = np.bincount(ids[a == ARCH_UPPER], minlength=n + 1)
    lo = np.bincount(ids[a == ARCH_LOWER], minlength=n + 1)
    minority, voted = np.minimum(up, lo), up + lo
    fused = np.nonzero(
        (voted > 0)
        & (minority >= ARCH_SPLIT_MIN_SHARE * voted)
        & (minority * voxel_mm3 >= ARCH_SPLIT_MIN_MM3)
    )[0]
    fused = fused[fused != 0]
    if fused.size == 0:
        return inst, n, 0

    out = inst.copy()
    boxes = ndimage.find_objects(inst)
    nxt = n
    for i in fused:
        box = boxes[i - 1]
        if box is None:
            continue
        sub = inst[box] == i
        av = arch[box]
        seeds = np.zeros(sub.shape, dtype=np.uint8)
        seeds[sub & (av == ARCH_UPPER)] = 1
        seeds[sub & (av == ARCH_LOWER)] = 2
        seeds = _fill_by_nearest(sub, seeds, spacing_zyx)
        nxt += 1
        out[box][sub & (seeds == 2)] = nxt      # the upper half keeps the original id
        log.info("instance %d spans both jaws (%d/%d voxels) -- cut at the occlusal contact",
                 i, int(minority[i]), int(voted[i]))
    return out, nxt, int(fused.size)


# --------------------------------------------------------------------------- #
# Which arch is this instance in? Answered FIRST, and by the other model.       #
# --------------------------------------------------------------------------- #
def instance_arch(inst: np.ndarray, n: int, arch, semantic: np.ndarray):
    """(lower[n], source[n]) -- upper or lower per instance, jaw model first.

    `arch` is `merge.arch_mask(dentalseg)` on the same grid: DentalSegmentator's own
    per-voxel upper/lower opinion, arrived at without ever looking at a tooth number.
    That independence is the whole point, because the numbering model's arch opinion
    is exactly what fails at the occlusal contact. Where the jaw model covers too
    little of an instance to have an opinion, fall back to the tooth model's own
    class mass, which is what upstream uses unconditionally.

    This runs *before* anything else, because the arch is the one fact that
    constrains everything after it: the split rule, the sequence, and the sixteen
    positions the Viterbi may choose from.
    """
    from .merge import ARCH_LOWER, ARCH_UPPER

    flat = inst.ravel()
    sel = flat > 0
    ids = flat[sel]
    source = np.zeros(n, dtype=np.uint8)          # 0 = tooth model, 1 = jaw model
    if ids.size == 0:
        return np.zeros(n, dtype=bool), source

    sem = semantic.ravel()[sel]
    ts_up = np.bincount(ids[(sem >= 1) & (sem <= PER_ARCH)], minlength=n + 1)[1:]
    ts_lo = np.bincount(ids[sem > PER_ARCH], minlength=n + 1)[1:]
    lower = ts_lo > ts_up

    if arch is not None:
        a = arch.ravel()[sel]
        total = np.bincount(ids, minlength=n + 1)[1:].astype(np.float64)
        n_up = np.bincount(ids[a == ARCH_UPPER], minlength=n + 1)[1:]
        n_lo = np.bincount(ids[a == ARCH_LOWER], minlength=n + 1)[1:]
        coverage = (n_up + n_lo) / np.maximum(total, 1.0)
        decided = (coverage >= ARCH_MIN_COVERAGE) & (n_up != n_lo)
        lower = np.where(decided, n_lo > n_up, lower)
        source[decided] = 1
    return lower, source


# --------------------------------------------------------------------------- #
# Per-instance class distributions, and upstream's split rule.                  #
# --------------------------------------------------------------------------- #
def _instance_parts(inst: np.ndarray, n: int, probs, semantic: np.ndarray,
                    lower: np.ndarray, voxel_mm3: float, spacing_zyx):
    """Cut any core the semantic branch assigns to two same-arch teeth.

    See `SPLIT_MIN_MM3` above for why the criterion is volume rather than upstream's
    confidence, and why the arch restriction is the part that makes it safe. The cut
    itself is a nearest-seed partition of the core using the semantic labels as seeds,
    the same mechanism the arch cut uses, so the parts tile the core exactly.

    Returns `(parts, dists, part_lower, n_split)`.
    """
    from scipy import ndimage

    boxes = ndimage.find_objects(inst)
    parts = np.zeros_like(inst)
    dists: list[np.ndarray] = []
    part_lower: list[bool] = []
    n_split = 0
    nxt = 0

    for i in range(1, n + 1):
        box = boxes[i - 1]
        if box is None:
            continue
        sub = inst[box] == i
        if not sub.any():
            continue
        is_lower = bool(lower[i - 1])
        base = PER_ARCH if is_lower else 0
        where = np.nonzero(sub)

        if probs is not None:
            voxel_probs = probs.gather(
                tuple(w + box[ax].start for ax, w in enumerate(where)))
        else:
            # No softmax available: a one-hot histogram of the argmax is the honest
            # stand-in for the mean distribution the sequence model needs. It is NOT a
            # stand-in for confidence, so the split rule is switched off below rather
            # than run against it. Measured on the head CBCT: against one-hot values
            # the 0.95 test degenerates into "does a second same-arch class cover a
            # tenth of this core", which fired once and split a core that the same
            # scan's real softmax left alone. A looser test wearing a strict test's
            # threshold is worse than no test.
            lab = semantic[box][sub]
            voxel_probs = np.zeros((N_CLASSES, lab.size), dtype=np.float32)
            voxel_probs[lab, np.arange(lab.size)] = 1.0

        # Which same-arch teeth does the semantic branch put inside this core, and how
        # much of it does each one take? The labels answer that, not the probabilities:
        # it is a volume question.
        own = np.arange(1 + base, 1 + base + PER_ARCH)
        lab_sub = semantic[box][sub]
        counts = np.bincount(lab_sub, minlength=N_CLASSES)[own]
        n_vox = max(1, int(sub.sum()))
        qualifying = np.nonzero((counts * voxel_mm3 >= SPLIT_MIN_MM3)
                                & (counts / n_vox >= SPLIT_MIN_SHARE))[0]

        if qualifying.size <= 1:
            split = np.zeros(n_vox, dtype=np.int64)
        else:
            n_split += 1
            log.info("core %d holds %d same-arch teeth (%s) -- splitting", i,
                     qualifying.size,
                     ", ".join(f"{L.TOOTHSEG_INDEX_TO_FDI[int(own[k])]}:"
                               f"{counts[k] * voxel_mm3:.0f}mm3" for k in qualifying))
            seeds = np.zeros(sub.shape, dtype=np.uint8)
            for j, k in enumerate(qualifying, start=1):
                seeds[sub & (semantic[box] == own[k])] = j
            seeds = _fill_by_nearest(sub, seeds, spacing_zyx)
            split = seeds[sub].astype(np.int64) - 1

        for s in np.unique(split):
            nxt += 1
            take = split == s
            parts[box][tuple(w[take] for w in where)] = nxt
            dists.append(voxel_probs[:, take].mean(1).astype(np.float64))
            part_lower.append(is_lower)

    return (parts,
            np.stack(dists) if dists else np.zeros((0, N_CLASSES)),
            np.asarray(part_lower, dtype=bool),
            n_split)


# --------------------------------------------------------------------------- #
# The entry point.                                                              #
# --------------------------------------------------------------------------- #
def renumber(semantic: np.ndarray, inst: np.ndarray, probs, arch, image,
             normals=None) -> tuple[np.ndarray, NumberingReport]:
    """Reassign ToothSeg class indices so that each instance carries exactly one.

    All four arrays are on the semantic branch's grid. Returns a volume in the same
    Dataset121 class-index space `merge()` already consumes (0, then 1..32), so
    nothing downstream changes shape, dtype or meaning.

    **The tooth extent is preserved exactly**: `(out > 0)` equals `(semantic > 0)`,
    asserted below. This module may change which number a tooth voxel carries and
    nothing else.
    """
    import time

    t0 = time.monotonic()
    rep = NumberingReport()
    tooth = semantic > 0
    if isinstance(probs, np.ndarray):
        # A caller that hands over the dense softmax gets it reduced here rather than
        # rejected. The worker does this at the source instead, where the float32 can
        # actually be freed; this is for tests and probes.
        probs = ProbTable(probs, tooth)
    n_inst = int(inst.max())
    if n_inst == 0 or not tooth.any():
        rep.fallback = "the instance branch found no teeth"
        return semantic, rep

    voxel_mm3 = float(np.prod(image.GetSpacing()))
    spacing_zyx = tuple(float(v) for v in reversed(image.GetSpacing()))
    inst, n_inst, rep.n_arch_split = split_across_arches(
        inst, n_inst, arch, voxel_mm3, spacing_zyx)

    lower, arch_src = instance_arch(inst, n_inst, arch, semantic)
    parts, dists, part_lower, rep.n_split = _instance_parts(
        inst, n_inst, probs, semantic, lower, voxel_mm3, spacing_zyx)
    n = dists.shape[0]
    if n == 0:
        rep.fallback = "no instance survived the class table"
        return semantic, rep

    keep = dists[:, 0] < BACKGROUND_PROB
    rep.n_background = int((~keep).sum())
    if not keep.any():
        rep.fallback = "the semantic branch called every instance background"
        return semantic, rep
    rep.arch_from_jaw_model = int(arch_src.sum())
    rep.arch_from_tooth_model = int(n_inst - arch_src.sum())

    centroids = centroids_las(parts, n, image)
    normals = normals if normals is not None else load_pair_normals()

    assigned = np.zeros(n + 1, dtype=np.uint8)          # part id -> Dataset121 class
    for is_lower in (False, True):
        sel = np.nonzero(keep & (part_lower == is_lower))[0]
        if sel.size == 0:
            continue
        base = PER_ARCH if is_lower else 0
        arch_probs = dists[sel][:, 1 + base:1 + base + PER_ARCH].copy()
        totals = arch_probs.sum(axis=1, keepdims=True)
        arch_probs = np.where(totals > 0, arch_probs / np.maximum(totals, PROB_FLOOR),
                              1.0 / PER_ARCH)

        order, _ = determine_sequence(centroids[sel])
        if sel.size == 1:
            path = np.array([int(arch_probs[0].argmax())])
        else:
            trans = transition_log_probs(normals, centroids[sel], is_lower, order)
            path, _ = viterbi(arch_probs, order, trans)

        plain = arch_probs[order].argmax(axis=-1)
        for step, pos in enumerate(path):
            part = int(sel[order[step]])
            assigned[part + 1] = base + int(pos) + 1
            if int(pos) != int(plain[step]):
                rep.n_resequenced += 1
                rep.resequenced.append({
                    "from": L.TOOTHSEG_INDEX_TO_FDI[base + int(plain[step]) + 1],
                    "to": L.TOOTHSEG_INDEX_TO_FDI[base + int(pos) + 1],
                })

    out = np.zeros_like(semantic)
    out[tooth] = assigned[parts[tooth]]

    # Instances stop at the border the instance branch drew; the semantic branch's
    # mask is what everything downstream measures. Give an unclaimed tooth voxel to
    # the instance it is nearest to, but only within a tooth's own reach.
    orphan = tooth & (out == 0)
    rep.orphan_voxels = int(orphan.sum())
    if rep.orphan_voxels:
        out = _adopt(out, orphan, parts, assigned, image)
        rep.adopted_voxels = rep.orphan_voxels - int((tooth & (out == 0)).sum())
        still = tooth & (out == 0)
        out[still] = semantic[still]        # too far from any tooth: keep what it was

    assert np.array_equal(out > 0, tooth), "renumbering changed which voxels are teeth"

    rep.teeth_before = _real_teeth(semantic, voxel_mm3)
    rep.teeth_after = _real_teeth(out, voxel_mm3)
    if rep.teeth_after < rep.teeth_before - TOOTH_LOSS_LIMIT:
        rep.fallback = (
            f"numbering would have gone from {rep.teeth_before} teeth to "
            f"{rep.teeth_after}, so cores were fused rather than separated"
        )
        log.error("%s — keeping the semantic argmax", rep.fallback)
        return semantic, rep

    rep.used = True
    rep.n_instances = n_inst
    rep.n_parts = n
    rep.changed_voxels = int((out != semantic).sum())
    rep.seconds = round(time.monotonic() - t0, 2)
    log.info(
        "numbering: %d instance(s) -> %d part(s), %d split, %d resequenced, "
        "%d/%d tooth voxels renumbered",
        rep.n_instances, n, rep.n_split, rep.n_resequenced,
        rep.changed_voxels, int(tooth.sum()),
    )
    return out, rep


def _real_teeth(volume: np.ndarray, voxel_mm3: float) -> int:
    """Distinct tooth classes big enough to be a tooth rather than a speck."""
    counts = np.bincount(volume.ravel(), minlength=N_CLASSES)
    counts[0] = 0
    return int((counts * voxel_mm3 >= REAL_TOOTH_MM3).sum())


def _adopt(out, orphan, parts, assigned, image):
    """Hand each unclaimed tooth voxel to the nearest instance, within ADOPT_MAX_MM."""
    from scipy import ndimage

    spacing = tuple(float(s) for s in reversed(image.GetSpacing()))
    claimed = parts > 0
    if not claimed.any():
        return out
    box = ndimage.find_objects((claimed | orphan).astype(np.uint8))[0]
    dist, ind = ndimage.distance_transform_edt(
        ~claimed[box], sampling=spacing, return_indices=True)
    near = orphan[box] & (dist <= ADOPT_MAX_MM)
    if near.any():
        src = tuple(a[near] for a in ind)
        out[box][near] = assigned[parts[box][src]]
    return out
