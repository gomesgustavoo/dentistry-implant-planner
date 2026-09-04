#!/usr/bin/env python
"""Score segmentations against ground truth: Dice, HD95, NSD, directed error.

Predictions and ground truth are matched by case id and scored through a
**comparison space** (`dentistry/crosswalk.py`), which is what lets a 47-structure
prediction be graded against 77-class ToothFairy3 ground truth: each scored
structure names a set of ids on either side, so the pipeline's single `canal` class
can be compared against the union of the annotator's left and right.

**Two denominators, and reading only one is how a finding gets retracted.**

    Dice-GT      mean over cases where GROUND TRUTH has the class. Delineation.
    Dice-scored  also counts cases where the model predicted a class the truth does
                 not have, scored 0. Detection cost.

A model that never abstains wins the first and loses the second. On our own holdout
the maxilla reads 0.53 "scored", 0.80 "present" and 0.94 "present and over 10 cm3" --
three answers to three different questions, and the table has to say which.

**Two protocols, not interchangeable.** `strict` excludes a class absent from both
masks. `challenge` is ToothFairy3's own evaluator: it averages all 46 Task-1
classes, scores absent-in-both as 1.0 (9-13 free ones per case here) and reports
HD95 in VOXELS. It is comparable to a leaderboard and to nothing else, so it only
runs on a `tf3-task1*` space.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import numpy as np  # noqa: E402

from dentistry import crosswalk, metrics  # noqa: E402


def _load(path: Path):
    import SimpleITK as sitk

    img = sitk.ReadImage(str(path))
    arr = sitk.GetArrayFromImage(img)
    spacing = tuple(reversed(img.GetSpacing()))
    del img
    return arr, spacing


def score_case(gt_path: Path, pred_path: Path, classes, tolerance_mm: float,
               surface: bool, challenge: bool) -> dict:
    gt, spacing = _load(gt_path)
    pred, _ = _load(pred_path)
    if gt.shape != pred.shape:
        raise ValueError(f"shape mismatch: gt {gt.shape} vs prediction {pred.shape}")
    scores = metrics.score_comparison(gt, pred, spacing, classes,
                                      tolerance_mm=tolerance_mm, surface=surface)
    out = {
        "aggregate": metrics.aggregate(scores),
        "meta": {"shape": [int(x) for x in gt.shape],
                 "spacing_zyx": [float(x) for x in spacing]},
        "classes": [s.as_dict() for s in scores],
    }
    if challenge:
        out["challenge"] = metrics.challenge_aggregate(scores, gt.shape, spacing)
    del gt, pred
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--gt", required=True, type=Path)
    ap.add_argument("--pred", required=True, type=Path)
    ap.add_argument("--space", default="tf3-task1-raw-gt", choices=sorted(crosswalk.SPACES))
    ap.add_argument("--out", required=True, type=Path)
    ap.add_argument("--tolerance-mm", type=float, default=1.0)
    ap.add_argument("--no-surface", action="store_true")
    args = ap.parse_args()

    classes = crosswalk.SPACES[args.space]()
    for i, c in enumerate(classes, start=1):
        if not hasattr(c, "index"):
            object.__setattr__(c, "index", i) if hasattr(c, "__dataclass_fields__") else None
    # The challenge protocol is defined over ToothFairy3's exact 46 Task-1 classes
    # and works in voxels. Running it over any other space would produce something
    # that looks like a leaderboard number and is not one.
    challenge = args.space.startswith("tf3-task1")

    cases = sorted(p.name.replace(".nii.gz", "") for p in args.pred.glob("*.nii.gz"))
    if not cases:
        raise SystemExit(f"no predictions under {args.pred}")

    per_case: dict = {}
    for i, cid in enumerate(cases, 1):
        gt_path = args.gt / f"{cid}.nii.gz"
        if not gt_path.exists():
            print(f"  [{i}/{len(cases)}] {cid}: no ground truth -- skipped")
            continue
        per_case[cid] = score_case(gt_path, args.pred / f"{cid}.nii.gz", classes,
                                   args.tolerance_mm, not args.no_surface, challenge)
        a = per_case[cid]["aggregate"]
        print(f"  [{i}/{len(cases)}] {cid}: Dice {a['mean_dice']:.4f} "
              f"HD95 {a['mean_hd95'] if a['mean_hd95'] is None else round(a['mean_hd95'], 2)} "
              f"({a['classes_scored']} scored, {a['classes_missed']} missed, "
              f"{a['classes_spurious']} spurious)", flush=True)

    # --- per class, both denominators ---------------------------------------
    per_class: dict = {}
    for rec in per_case.values():
        for c in rec["classes"]:
            # `inward_max` is aggregated because the PRODUCT quotes it: it is
            # `plan_safety.MODEL_INWARD_WORST_MM`, published by POST /measure and
            # named in `NO_GUIDE_NOTICE`. It used to reach `per_case` only, so the
            # one number a clinician reads in a safety notice could not be found in
            # `metrics.md` at all -- which is how two docstrings came to call the
            # largest per-case p95 (2.96 mm) "the worst single point" when the worst
            # single point is 5.10 mm.
            e = per_class.setdefault(c["name"], {"dice": [], "dice_gt": [], "hd95": [],
                                                 "nsd": [], "recall": [], "vol_ratio": [],
                                                 "inward_p95": [], "outward_p95": [],
                                                 "inward_max": [], "outward_max": [],
                                                 "n_missed": 0, "n_spurious": 0})
            if c["status"] == "absent_both":
                continue
            if c["status"] == "missed":
                e["n_missed"] += 1
            if c["status"] == "spurious":
                e["n_spurious"] += 1
            if c["dice"] is not None:
                e["dice"].append(c["dice"])
                if c["status"] != "spurious":
                    e["dice_gt"].append(c["dice"])
            for k in ("hd95", "nsd", "recall", "vol_ratio", "inward_p95", "outward_p95",
                      "inward_max", "outward_max"):
                if c.get(k) is not None:
                    e[k].append(c[k])

    def mean(v):
        return float(np.mean(v)) if v else None

    overall = {
        "n_cases": len(per_case),
        "strict": {
            "mean_dice": mean([r["aggregate"]["mean_dice"] for r in per_case.values()
                               if r["aggregate"]["mean_dice"] is not None]),
            "mean_hd95": mean([r["aggregate"]["mean_hd95"] for r in per_case.values()
                               if r["aggregate"]["mean_hd95"] is not None]),
            "mean_nsd": mean([r["aggregate"]["mean_nsd"] for r in per_case.values()
                              if r["aggregate"]["mean_nsd"] is not None]),
        },
    }
    if challenge:
        overall["challenge"] = {
            "mean_dice": mean([r["challenge"]["mean_dice"] for r in per_case.values()]),
            "mean_hd95_voxels": mean([r["challenge"]["mean_hd95_voxels"]
                                      for r in per_case.values()]),
            "free_true_negatives_per_case": mean(
                [r["challenge"]["free_true_negatives"] for r in per_case.values()]),
        }

    args.out.mkdir(parents=True, exist_ok=True)
    (args.out / "metrics.json").write_text(json.dumps(
        {"overall": overall, "per_case": per_case,
         "per_class": {k: {kk: (vv if isinstance(vv, int) else vv)
                           for kk, vv in v.items()} for k, v in per_class.items()}},
        indent=1, default=float) + "\n")

    # `inward p95` is the MEAN of the per-case p95s -- the typical under-draw, and what
    # `plan_safety` deducts. `inward worst` is the MAX of the per-case maxima, not their
    # mean: it is a single worst point and averaging it would hide exactly the outlier
    # the no-guide notice exists to quote. The two differ by 2.14 mm on the left IAC.
    lines = [f"# {args.space} — {len(per_case)} cases", "",
             "| structure | Dice·GT | Dice·scored | HD95 mm | NSD | recall | vol/GT | "
             "inward p95 mm | inward worst mm | n·GT | missed | spurious |",
             "|---|---|---|---|---|---|---|---|---|---|---|---|"]
    for name, e in per_class.items():
        def f(v, p=4):
            return "" if v is None else f"{v:.{p}f}"
        worst = max(e["inward_max"]) if e["inward_max"] else None
        lines.append(f"| {name} | {f(mean(e['dice_gt']))} | {f(mean(e['dice']))} | "
                     f"{f(mean(e['hd95']), 2)} | {f(mean(e['nsd']))} | "
                     f"{f(mean(e['recall']))} | {f(mean(e['vol_ratio']), 2)} | "
                     f"{f(mean(e['inward_p95']), 3)} | {f(worst, 3)} | "
                     f"{len(e['dice_gt'])} | {e['n_missed']} | {e['n_spurious']} |")
    (args.out / "metrics.md").write_text("\n".join(lines) + "\n")

    print("\n" + "=" * 64)
    st = overall["strict"]
    print(f"OVERALL  mean Dice {st['mean_dice']:.4f}  HD95 {st['mean_hd95']:.2f} mm  "
          f"NSD {st['mean_nsd']:.4f}   over {len(per_case)} cases")
    if challenge:
        ch = overall["challenge"]
        vox = min(next(iter(per_case.values()))["meta"]["spacing_zyx"])
        print(f"CHALLENGE PROTOCOL (comparable to the leaderboard):  "
              f"Dice {ch['mean_dice']:.4f}  HD95 {ch['mean_hd95_voxels']:.2f} vox "
              f"= {ch['mean_hd95_voxels'] * vox:.2f} mm")
        print(f"  ^ inflated by {ch['free_true_negatives_per_case']:.1f} classes/case "
              f"scoring 1.0 for being absent from both masks. Use the strict number "
              f"above to track our own progress.")
    print(f"wrote {args.out / 'metrics.json'} and {args.out / 'metrics.md'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
