"""Ground-truth segmentation metrics: Dice, HD95, normalised surface Dice.

This project has never had one of these. `merge.tooth_agreement_dice` measures
whether two models agree, and `dentistry/quality.py` scores plausibility without
a reference -- useful, but neither is accuracy. Everything here needs labelled
ground truth and reports accuracy against it.

Torch-free on purpose, like the rest of `dentistry/`.

Surface metrics are computed on a cropped bounding box around the union of the
two masks. A whole-head CBCT at 0.3 mm is ~10^8 voxels and a Euclidean distance
transform over that, 46 times, is not worth waiting for; every voxel outside the
union box is farther from both surfaces than any voxel inside it, so the crop
does not change the result.
"""

from __future__ import annotations

from dataclasses import dataclass, asdict

import numpy as np
from scipy import ndimage


@dataclass
class Score:
    """One class scored against ground truth. Distances are in millimetres."""

    label: int
    name: str
    dice: float | None
    hd95: float | None
    nsd: float | None
    gt_voxels: int
    pred_voxels: int
    status: str  # scored | absent_both | missed | spurious
    # Recall and volume ratio separate "the model is wrong" from "the two datasets
    # annotate different objects". PMCanalSeg draws a canal 2.5x narrower than
    # ToothFairy3 does, so every model we own reads as over-drawing against it --
    # a fact about the labels, visible only once coverage and width are apart.
    recall: float | None = None
    vol_ratio: float | None = None
    # Dice and HD95 are symmetric. For a structure a drill has to avoid they must
    # not be: see `directed_error`.
    inward_p95: float | None = None
    inward_max: float | None = None
    outward_p95: float | None = None
    outward_max: float | None = None

    def as_dict(self) -> dict:
        return asdict(self)


def dice(gt: np.ndarray, pred: np.ndarray) -> float:
    """Sorensen-Dice. Both empty is 1.0 by convention -- callers filter on status."""
    g, p = int(gt.sum()), int(pred.sum())
    if g + p == 0:
        return 1.0
    return 2.0 * float(np.logical_and(gt, pred).sum()) / (g + p)


def _union_box(gt: np.ndarray, pred: np.ndarray, margin: int = 2):
    any_ = np.logical_or(gt, pred)
    if not any_.any():
        return None
    sl = []
    for axis in range(any_.ndim):
        others = tuple(i for i in range(any_.ndim) if i != axis)
        idx = np.where(any_.any(axis=others))[0]
        lo = max(int(idx[0]) - margin, 0)
        hi = min(int(idx[-1]) + 1 + margin, any_.shape[axis])
        sl.append(slice(lo, hi))
    return tuple(sl)


def surface_distances(gt: np.ndarray, pred: np.ndarray, spacing) -> tuple[np.ndarray, np.ndarray]:
    """Symmetric surface distances (gt->pred, pred->gt) in mm.

    A surface voxel is one in the mask with a background face-neighbour, so a
    one-voxel-thick structure -- which the mandibular canal genuinely is at
    0.3 mm -- is entirely surface rather than vanishing under erosion.
    """
    box = _union_box(gt, pred)
    if box is None:
        return np.empty(0), np.empty(0)
    g, p = gt[box], pred[box]
    if not g.any() or not p.any():
        return np.empty(0), np.empty(0)

    structure = ndimage.generate_binary_structure(g.ndim, 1)  # 6-connectivity in 3D
    g_surf = g & ~ndimage.binary_erosion(g, structure, border_value=0)
    p_surf = p & ~ndimage.binary_erosion(p, structure, border_value=0)

    d_to_p = ndimage.distance_transform_edt(~p, sampling=spacing)
    d_to_g = ndimage.distance_transform_edt(~g, sampling=spacing)
    return d_to_p[g_surf], d_to_g[p_surf]


def hd95(d_gp: np.ndarray, d_pg: np.ndarray) -> float | None:
    if d_gp.size == 0 or d_pg.size == 0:
        return None
    return float(max(np.percentile(d_gp, 95), np.percentile(d_pg, 95)))


def nsd(d_gp: np.ndarray, d_pg: np.ndarray, tolerance_mm: float) -> float | None:
    """Normalised surface Dice: the fraction of surface within `tolerance_mm`."""
    if d_gp.size == 0 or d_pg.size == 0:
        return None
    hit = int((d_gp <= tolerance_mm).sum()) + int((d_pg <= tolerance_mm).sum())
    return hit / float(d_gp.size + d_pg.size)


def score_label(gt_mask: np.ndarray, pred_mask: np.ndarray, spacing,
                label: int, name: str, tolerance_mm: float = 1.0,
                surface: bool = True) -> Score:
    g, p = int(gt_mask.sum()), int(pred_mask.sum())
    if g == 0 and p == 0:
        # Not an achievement. A scan with no implant scores nothing for implants;
        # averaging 1.0 here would quietly inflate the mean.
        return Score(label, name, None, None, None, 0, 0, "absent_both")
    if g == 0:
        return Score(label, name, 0.0, None, None, 0, p, "spurious", recall=None,
                     vol_ratio=None)
    if p == 0:
        return Score(label, name, 0.0, None, None, g, 0, "missed", recall=0.0,
                     vol_ratio=0.0)

    d = dice(gt_mask, pred_mask)
    h = n = None
    directed = {}
    if surface:
        d_gp, d_pg = surface_distances(gt_mask, pred_mask, spacing)
        h, n = hd95(d_gp, d_pg), nsd(d_gp, d_pg, tolerance_mm)
        directed = directed_error(d_gp, d_pg)
    # Coverage and width, reported apart. `recall` is how much of the truth we
    # covered; `vol_ratio` is how much wider we drew it. A dataset that annotates a
    # narrower object than ours drives Dice down through vol_ratio alone, with
    # recall near 1.0 -- which is a fact about the labels, not about the model.
    rec = float(np.logical_and(gt_mask, pred_mask).sum()) / g
    return Score(label, name, d, h, n, g, p, "scored",
                 recall=rec, vol_ratio=(p / g if g else None), **directed)


def score_volume(gt: np.ndarray, pred: np.ndarray, spacing, names: dict[int, str],
                 tolerance_mm: float = 1.0, surface: bool = True,
                 labels: list[int] | None = None) -> list[Score]:
    """Score every foreground label in `names` (or `labels`) of one case."""
    if gt.shape != pred.shape:
        raise ValueError(f"shape mismatch: gt {gt.shape} vs prediction {pred.shape}")
    wanted = labels if labels is not None else [i for i in sorted(names) if i != 0]
    return [
        score_label(gt == i, pred == i, spacing, i, names.get(i, str(i)),
                    tolerance_mm=tolerance_mm, surface=surface)
        for i in wanted
    ]


def aggregate(scores: list[Score]) -> dict:
    """Mean over classes that were actually present. Absent-in-both never counts.

    `missed` and `spurious` DO count, at Dice 0 -- a model that never predicts
    the lingual canal should not score the same as one that finds it.
    """
    counted = [s for s in scores if s.status != "absent_both"]
    with_surface = [s for s in counted if s.hd95 is not None]
    mean = lambda xs: float(np.mean(xs)) if xs else None
    return {
        "mean_dice": mean([s.dice for s in counted]),
        "mean_hd95": mean([s.hd95 for s in with_surface]),
        "mean_nsd": mean([s.nsd for s in with_surface]),
        "classes_scored": len(counted),
        "classes_absent_both": len(scores) - len(counted),
        "classes_missed": sum(s.status == "missed" for s in scores),
        "classes_spurious": sum(s.status == "spurious" for s in scores),
    }


def directed_error(d_gp: np.ndarray, d_pg: np.ndarray) -> dict:
    """Split the surface error into the two directions, in mm.

    Dice and HD95 are symmetric, and for a structure a drill has to avoid they must
    not be. `d_gp` is the distance from each ground-truth surface voxel to the
    nearest predicted voxel, so it is zero wherever the prediction covers the truth
    and positive exactly where it does not:

      **inward**  the prediction's wall sits INSIDE the true wall. The real
                  structure extends this much further than the segmentation shows.
                  On an inferior alveolar canal this is the number that matters: a
                  plan drawn on the prediction believes it has this much more bone
                  than it has.

      **outward** the prediction's wall sits outside the true one. It costs usable
                  bone and it is conservative -- the opposite of dangerous.

    Both are reported. A model 0.4 mm outward everywhere and a model 0.4 mm inward
    everywhere have the same Dice, the same HD95, and are not the same model.

    Use the p95, not the max: a maximum moves on one stray voxel. Measured on the
    20-case holdout, the left inferior alveolar canal has a mean inward p95 of
    **0.46 mm** (`mean(inward_p95)` = 0.4643), while its largest per-case p95 is
    **2.96 mm** and its worst SINGLE POINT is **5.10 mm** (`max(inward_max)` = 5.1000,
    on `ToothFairy3P_411`).

    Those last two used to be conflated here, and this docstring called 2.96 "a worst
    single point" -- which is what `plan_safety.MODEL_INWARD_WORST_MM` publishes to
    users, and it publishes 5.10. Two different statistics of the same case; naming
    them apart matters because the product quotes one of them in a safety notice.
    """
    def stat(d):
        if d is None or not len(d):
            return None, None
        return float(np.percentile(d, 95)), float(d.max())

    ip, im = stat(d_gp)
    op, om = stat(d_pg)
    return {"inward_p95": ip, "inward_max": im, "outward_p95": op, "outward_max": om}


def score_comparison(gt: np.ndarray, pred: np.ndarray, spacing, classes,
                     tolerance_mm: float = 1.0, surface: bool = True) -> list:
    """Score a list of comparison classes, duck-typed on `.gt_ids/.pred_ids/.name`.

    Lives here rather than in the eval script so the viewer's accuracy panel and the
    command-line audit compute the same numbers from the same code. `metrics` still
    imports nothing from `crosswalk`; the classes are passed in.
    """
    out = []
    for c in classes:
        gt_mask = np.isin(gt, list(c.gt_ids))
        pred_mask = np.isin(pred, list(c.pred_ids))
        out.append(score_label(gt_mask, pred_mask, spacing, label=getattr(c, "index", 0),
                               name=c.name, tolerance_mm=tolerance_mm, surface=surface))
    return out


# The ToothFairy3 challenge's own protocol, kept separate from `aggregate` because
# the two answer different questions and mixing them up inflates a number by 0.06.
CHALLENGE_N_CLASSES = 46
CHALLENGE_DIAGONAL = None   # set per case: the volume diagonal, in VOXELS


def challenge_aggregate(scores: list, shape, spacing=None) -> dict:
    """Score the way the challenge evaluator does. Comparable to a leaderboard, and
    to nothing else.

    Three differences from `aggregate`, all of which raise the number:

    * it averages over all 46 Task-1 classes, and a class **absent from both** masks
      scores **1.0** rather than being excluded -- on our 20-case holdout that is
      9-13 free ones per case;
    * a missing or spurious class takes the volume DIAGONAL as its HD95 rather than
      being skipped;
    * distances are in **voxels**, not millimetres. The published winner figure of
      21.35 is voxels; at 0.3 mm that is 6.4 mm.

    Only meaningful over ToothFairy3's exact 46 Task-1 classes, so callers gate it
    on the comparison space rather than running it on anything.
    """
    diag = float(np.sqrt(sum(float(s) ** 2 for s in shape)))
    dices, hd95s = [], []
    free = 0
    for sc in scores:
        if sc.status == "absent_both":
            dices.append(1.0)
            hd95s.append(0.0)
            free += 1
        elif sc.status in ("missed", "spurious"):
            dices.append(0.0)
            hd95s.append(diag)
        else:
            dices.append(sc.dice if sc.dice is not None else 0.0)
            # mm -> voxels, using the smallest spacing so the number is comparable
            # to a challenge run on an isotropic grid.
            h = sc.hd95
            if h is None:
                hd95s.append(diag)
            else:
                vox = min(spacing) if spacing else 1.0
                hd95s.append(float(h) / max(vox, 1e-6))
    pad = CHALLENGE_N_CLASSES - len(scores)
    if pad > 0:
        dices.extend([1.0] * pad)
        hd95s.extend([0.0] * pad)
        free += pad
    return {
        "mean_dice": float(np.mean(dices)) if dices else None,
        "mean_hd95_voxels": float(np.mean(hd95s)) if hd95s else None,
        "n_classes": len(dices),
        "free_true_negatives": free,
        "diagonal_penalty_voxels": round(diag, 2),
    }
