#!/usr/bin/env python
"""Replay the component filter's variants on committed artifacts, and check the gate.

**Why this script exists.** The p2 component filter's threshold table records the
LARGEST component per case, and `worker/cc_filter.apply` used to compare that number to
EACH component. Those are different quantities, and the mismatch deleted real anatomy:
missed classes 2 -> 28 over the holdout, the entire lower jawbone on `ToothFairy3F_043`.
The guard that replaced it has to be graded, and graded on a gate fixed BEFORE the
measurement -- which is what this file is.

**Every variant is computed in ONE run from ONE input.** That is not tidiness, it is the
only way the comparison means anything. `eval/*/base/*.npy` is dumped BETWEEN the filter
and the board, on the 0.3 mm plan grid, while `eval/*/metrics.json` scored the
post-board, post-`to_canonical` prediction. So the published 0.8292 and anything computed
here are **different predictions of different pipelines**, and grading a replay number
against a published one silently mixes two frames -- it makes a guard that improves by
+0.003 on identical input read as a regression. The gate is therefore stated in DELTAS
only, and the published figures are printed beside the replay's own baseline with this
caveat attached, so nobody repeats the mistake.

**What it cannot measure.** Because the dumps are pre-board, the guard's effect on
Task-1 43/44/45 -- the canal specialist's classes -- is invisible here. Deleting the
mandible makes `worker/board._roi_box` skip the specialist entirely
(`tf3.canal_box` returns None with no mandible to anchor on), so those three classes
revert to the base model. `specialist_skipped` is a gate item as a PROXY for that; the
only real measurement is a GPU re-run of the 20 cases.

One labelling pass per (case, class) serves every variant: components, their sizes and
their ground-truth overlap are computed once, and each variant is just a different
surviving subset. So Dice is exact rather than approximated, and the variants cannot
differ by anything except the decision under test.

    ./venv/bin/python scripts/cc_filter_replay.py
    ./venv/bin/python scripts/cc_filter_replay.py --cases ToothFairy3F_043 --verbose
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

# The gate, fixed before the measurement. Deltas only -- see the module docstring.
GATE = {
    "delta_dice_scored_min": 0.0,      # must not regress the headline
    "delta_dice_gt_min": 0.02,         # delineation must improve materially
    "missed_max": 10,                  # from 28
    "real_mm3_max": 500.0,             # PRIMARY: from ~16,500
    "spurious_max": 55,                # from 23 -- the acknowledged cost
    "specialist_skipped_max": 0,       # from 1; a proxy, see the docstring
    "worst_case_dice_regression_max": 0.02,
}


def variants(sizes: np.ndarray, threshold: int, floor: int, single: bool,
             exempt: bool) -> dict[str, np.ndarray]:
    """Which components each variant KEEPS, as boolean masks over `sizes`.

    `sizes` is one entry per connected component of one class in one case. Every
    variant sees the identical array, so the only difference between them is policy.
    """
    n = len(sizes)
    all_keep = np.ones(n, dtype=bool)
    if exempt or n == 0:
        return {"unfiltered": all_keep, "current": all_keep.copy(),
                "guard": all_keep.copy()}

    base = all_keep.copy()
    if single:
        # Keep-largest runs identically in every filtered variant, so it cannot move
        # the delta -- it is applied so the ABSOLUTE numbers are the pipeline's.
        base = np.zeros(n, dtype=bool)
        base[int(np.argmax(sizes))] = True

    total, largest = int(sizes.sum()), int(sizes.max())

    current = base & (sizes >= threshold) if threshold > 0 else base.copy()

    if threshold <= 0:
        guard = base.copy()
    elif total < floor:
        guard = np.zeros(n, dtype=bool)          # the whole class is specks
    elif largest < threshold:
        guard = base.copy()                      # abstain: no jurisdiction
    else:
        guard = base & (sizes >= threshold)

    return {"unfiltered": all_keep, "current": current, "guard": guard}


def score_case(pred: np.ndarray, gt: np.ndarray, classes, thresholds: dict[int, int],
               floors: dict[int, int], exempt: set[int], single: set[int],
               voxel_mm3: float, verbose: bool = False) -> dict:
    """Score one case's three variants over the COMPARISON SPACE.

    Iterating the space rather than the arrays' own unique labels is not a detail: the
    predictions are in Task-1 ids (1-46) and the holdout ground truth is in RAW
    ToothFairy3 ids (up to 148, with FDI-style tooth numbering), so a direct comparison
    matches on the jaws and canals and mismatches on every tooth. A first version of
    this script did exactly that and reported 508 missed classes on the UNFILTERED
    variant where the eval sees 2 -- the same frame-mixing mistake, in a different
    frame, that the gate is stated in deltas to avoid.

    `dentistry.crosswalk.SPACES[...]` is the one map, used here and by
    `scripts/eval_dice.py`, so the two cannot drift.
    """
    from scipy import ndimage

    from dentistry import crosswalk
    from worker import cc_filter as CC

    out: dict[str, dict] = {v: {"dice": [], "dice_gt": [], "missed": 0, "spurious": 0,
                                "real_voxels_deleted": 0}
                            for v in ("unfiltered", "current", "guard")}
    detail = []

    for cc in classes:
        gt_c = np.isin(gt, list(cc.gt_ids))
        gt_vox = int(gt_c.sum())
        mask = np.isin(pred, list(cc.pred_ids))
        if not mask.any():
            for v in out:
                if gt_vox:
                    out[v]["dice"].append(0.0)
                    out[v]["dice_gt"].append(0.0)
                    out[v]["missed"] += 1
            continue

        lab, n = ndimage.label(mask)
        sizes = np.asarray(ndimage.sum(mask, lab, range(1, n + 1)), dtype=np.int64)
        overlap = (np.asarray(ndimage.sum(gt_c, lab, range(1, n + 1)), dtype=np.int64)
                   if gt_vox else np.zeros(n, dtype=np.int64))

        # The filter is keyed by a SINGLE Task-1 id; every class in this space maps to
        # exactly one, so take it from `pred_ids`.
        t1 = int(cc.pred_ids[0])
        thr = int(thresholds.get(t1, 0))
        floor = CC.class_floor_for(t1, floors)
        keeps = variants(sizes, thr, floor, t1 in single, t1 in exempt)

        for v, keep in keeps.items():
            pred_vox = int(sizes[keep].sum())
            inter = int(overlap[keep].sum())
            out[v]["real_voxels_deleted"] += int(overlap[~keep].sum())
            if gt_vox == 0 and pred_vox == 0:
                continue                                     # absent_both: excluded
            d = (2.0 * inter / (pred_vox + gt_vox)) if (pred_vox + gt_vox) else 0.0
            out[v]["dice"].append(d)
            if gt_vox:
                out[v]["dice_gt"].append(d)
                if pred_vox == 0:
                    out[v]["missed"] += 1
            else:
                out[v]["spurious"] += 1

        if verbose and (keeps["current"] != keeps["guard"]).any():
            detail.append({
                "task1": t1, "name": cc.name, "gt_voxels": gt_vox,
                "components": int(n), "total": int(sizes.sum()),
                "largest": int(sizes.max()), "threshold": thr, "floor": floor,
                "current_keeps": int(keeps["current"].sum()),
                "guard_keeps": int(keeps["guard"].sum()),
                "current_real_deleted": int(overlap[~keeps["current"]].sum()),
                "guard_real_deleted": int(overlap[~keeps["guard"]].sum()),
            })

    res = {}
    for v, e in out.items():
        res[v] = {
            "mean_dice": float(np.mean(e["dice"])) if e["dice"] else None,
            "mean_dice_gt": float(np.mean(e["dice_gt"])) if e["dice_gt"] else None,
            "missed": e["missed"], "spurious": e["spurious"],
            "real_mm3_deleted": e["real_voxels_deleted"] * voxel_mm3,
        }
    if verbose:
        res["detail"] = detail
    return res


def main() -> int:
    import SimpleITK as sitk

    from dentistry import crosswalk
    from worker import cc_filter as CC

    ap = argparse.ArgumentParser()
    ap.add_argument("--base", type=Path, default=ROOT / "eval/base_board/base",
                    help="unfiltered predictions, on the plan grid")
    ap.add_argument("--labels", type=Path, default=Path("/mnt/mldata/tf3/holdout/labels"))
    ap.add_argument("--table", type=Path,
                    default=ROOT / "models/toothfairy3/cc_thresholds.json")
    ap.add_argument("--percentile", type=float, default=2.0)
    ap.add_argument("--space", default="tf3-task1-raw-gt",
                    help="the comparison space; must match scripts/eval_dice.py")
    ap.add_argument("--cases", nargs="*", default=None)
    ap.add_argument("--verbose", action="store_true")
    ap.add_argument("--out", type=Path, default=None)
    a = ap.parse_args()

    classes = crosswalk.SPACES[a.space]()
    thresholds = CC.load_thresholds(a.table, a.percentile)
    floors = CC.load_floors(a.table)
    voxel_mm3 = CC.table_voxel_mm3(a.table) or 0.027
    exempt = CC.exempt_task1_classes()
    single = CC.single_component_task1_classes() - exempt
    if not thresholds:
        print("no threshold table -- nothing to replay", file=sys.stderr)
        return 2

    cases = sorted(p.stem for p in a.base.glob("*.npy"))
    if a.cases:
        cases = [c for c in cases if c in set(a.cases)]
    if not cases:
        print(f"no cases under {a.base}", file=sys.stderr)
        return 2

    print(f"replaying {len(cases)} cases in space {a.space} "
          f"({len(classes)} classes)  |  p{a.percentile:g} thresholds, "
          f"{len(floors)} class floors (absolute {CC.CLASS_FLOOR_VOXELS}), "
          f"voxel {voxel_mm3} mm3")
    print(f"exempt Task-1 classes (never filtered): {sorted(exempt)}")

    per_case: dict[str, dict] = {}
    for i, case in enumerate(cases, 1):
        gt_p = a.labels / f"{case}.nii.gz"
        if not gt_p.is_file():
            print(f"  [{i}/{len(cases)}] {case}: no ground truth, skipped")
            continue
        pred = np.load(a.base / f"{case}.npy")
        gt = sitk.GetArrayFromImage(sitk.ReadImage(str(gt_p)))
        if pred.shape != gt.shape:
            print(f"  [{i}/{len(cases)}] {case}: shape {pred.shape} vs GT {gt.shape}"
                  f" -- skipped, these are different grids")
            continue
        per_case[case] = score_case(pred, gt, classes, thresholds, floors,
                                    exempt, single, voxel_mm3, a.verbose)
        r = per_case[case]
        print(f"  [{i}/{len(cases)}] {case:22s} "
              f"current {r['current']['mean_dice']:.4f} / guard "
              f"{r['guard']['mean_dice']:.4f}  "
              f"real mm3 deleted {r['current']['real_mm3_deleted']:8.1f} -> "
              f"{r['guard']['real_mm3_deleted']:7.1f}")
        if a.verbose:
            for d in r.get("detail", []):
                print(f"        t1={d['task1']:3d} gt={d['gt_voxels']:7d} "
                      f"{d['name'][:22]:22s} comp={d['components']:3d} "
                      f"total={d['total']:7d} "
                      f"largest={d['largest']:7d} thr={d['threshold']:7d} "
                      f"floor={d['floor']:5d} | keeps {d['current_keeps']}->"
                      f"{d['guard_keeps']} | real deleted "
                      f"{d['current_real_deleted']}->{d['guard_real_deleted']}")

    if not per_case:
        print("nothing scored", file=sys.stderr)
        return 2

    agg = {}
    for v in ("unfiltered", "current", "guard"):
        ds = [r[v]["mean_dice"] for r in per_case.values() if r[v]["mean_dice"] is not None]
        dg = [r[v]["mean_dice_gt"] for r in per_case.values()
              if r[v]["mean_dice_gt"] is not None]
        agg[v] = {
            "dice_scored": float(np.mean(ds)),
            "dice_gt": float(np.mean(dg)),
            "missed": sum(r[v]["missed"] for r in per_case.values()),
            "spurious": sum(r[v]["spurious"] for r in per_case.values()),
            "real_mm3": sum(r[v]["real_mm3_deleted"] for r in per_case.values()),
        }

    print("\n" + "=" * 78)
    print(f"{'variant':12s} {'Dice.scored':>12s} {'Dice.GT':>9s} {'missed':>7s} "
          f"{'spurious':>9s} {'real mm3 deleted':>17s}")
    for v in ("unfiltered", "current", "guard"):
        e = agg[v]
        print(f"{v:12s} {e['dice_scored']:12.4f} {e['dice_gt']:9.4f} {e['missed']:7d} "
              f"{e['spurious']:9d} {e['real_mm3']:17.1f}")

    # Filter-attributable: the unfiltered variant deletes nothing, but classes the base
    # model never predicts still show as GT-positive-and-absent. Subtracting the
    # unfiltered baseline isolates what the FILTER destroyed.
    base_mm3 = agg["unfiltered"]["real_mm3"]
    cur_attr = agg["current"]["real_mm3"] - base_mm3
    grd_attr = agg["guard"]["real_mm3"] - base_mm3
    d_scored = agg["guard"]["dice_scored"] - agg["current"]["dice_scored"]
    d_gt = agg["guard"]["dice_gt"] - agg["current"]["dice_gt"]

    print("\nFILTER-ATTRIBUTABLE destruction of real anatomy (unfiltered baseline "
          f"{base_mm3:.1f} mm3 subtracted):")
    print(f"  current {cur_attr:10.1f} mm3     guard {grd_attr:10.1f} mm3"
          + (f"     {cur_attr / grd_attr:.0f}x less" if grd_attr > 0.5 else ""))

    # A regression is the guard scoring WORSE than the current filter on some case, so
    # the quantity to bound is max(current - guard). A negative worst means the guard
    # improved every case.
    worst = max((per_case[c]["current"]["mean_dice_gt"] or 0.0)
                - (per_case[c]["guard"]["mean_dice_gt"] or 0.0)
                for c in per_case)

    print("\nGATE (fixed before the measurement; deltas only):")
    checks = [
        ("delta Dice.scored >= 0", d_scored >= GATE["delta_dice_scored_min"],
         f"{d_scored:+.4f}"),
        ("delta Dice.GT >= +0.02", d_gt >= GATE["delta_dice_gt_min"], f"{d_gt:+.4f}"),
        ("missed <= 10", agg["guard"]["missed"] <= GATE["missed_max"],
         f"{agg['current']['missed']} -> {agg['guard']['missed']}"),
        ("filter-attributable real mm3 <= 500", grd_attr <= GATE["real_mm3_max"],
         f"{cur_attr:.1f} -> {grd_attr:.1f}"),
        ("spurious <= 55 (the acknowledged cost)",
         agg["guard"]["spurious"] <= GATE["spurious_max"],
         f"{agg['current']['spurious']} -> {agg['guard']['spurious']}"),
        ("no case's Dice.GT regresses by > 0.02",
         worst <= GATE["worst_case_dice_regression_max"], f"worst {worst:+.4f}"),
    ]
    ok = True
    for name, passed, detail in checks:
        ok &= passed
        print(f"  {'PASS' if passed else 'FAIL'}  {name}  --  {detail}")
    print("  NOTE  specialist_skipped == 0 cannot be checked here: these arrays are "
          "pre-board.\n        It needs a GPU re-run. See the module docstring.")

    pub = ROOT / "eval/board_p2/metrics.json"
    if pub.is_file():
        o = json.loads(pub.read_text()).get("overall", {}).get("strict", {})
        print(f"\nFor orientation only -- the SHIPPING pipeline's published number is "
              f"{o.get('mean_dice', float('nan')):.4f}.")
        print(f"This replay's own 'current' baseline is "
              f"{agg['current']['dice_scored']:.4f}. The two are DIFFERENT PREDICTIONS: "
              "these arrays are\npre-board and pre-resample. Never grade one against "
              "the other -- that is what the deltas are for.")

    if a.out:
        a.out.parent.mkdir(parents=True, exist_ok=True)
        a.out.write_text(json.dumps(
            {"gate": GATE, "aggregate": agg, "per_case": per_case,
             "filter_attributable_mm3": {"current": cur_attr, "guard": grd_attr},
             "deltas": {"dice_scored": d_scored, "dice_gt": d_gt}},
            indent=1, default=float) + "\n")
        print(f"\nwrote {a.out}")

    print("\n" + ("GATE PASSED" if ok else "GATE FAILED"))
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
