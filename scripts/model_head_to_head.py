#!/usr/bin/env python
"""Compare two eval runs class by class, paired over the cases they share.

Zero GPU: pure post-processing of two `metrics.json` files. Everything here exists
because a single mean Dice cannot settle ownership of a structure.

**Both denominators, always.** `Dice-GT` averages over cases where the ground truth HAS
the class -- delineation. `Dice-scored` also counts cases where a model predicted a class
the truth does not have, at 0 -- the detection cost. A model that never abstains wins the
first and loses the second, and on this dataset the gap reaches 0.27 on partially
annotated classes. A table that reports one is a table that can be read backwards.

**Paired, not two independent means.** The delta is computed per case and then averaged,
with a Wilcoxon signed-rank test over the pairs. Comparing two overall means across
different case sets is how a subset difference gets published as a model difference.

**Subsets, because of leakage.** TotalSegmentator trained on the public ToothFairy3
release and ToothSeg on ToothFairy2 -- a SUBSET of it -- while our 20-case holdout is a
split we made out of that same release. So on our holdout their wins prove nothing and
only their losses are informative. `--subset S` restricts to the 5 `S` cases, which are
precisely the ToothFairy3 addition (63 F + 417 P = 480 = ToothFairy2's training count)
and therefore leak-free for ToothSeg -- though NOT for TotalSegmentator, which saw
ToothFairy3 itself.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))


def _load(p: Path) -> dict:
    d = json.loads((p if p.name.endswith(".json") else p / "metrics.json").read_text())
    return d


def _wilcoxon(deltas):
    """Signed-rank p-value, two-sided. scipy is available in the worker venv."""
    xs = [d for d in deltas if d != 0]
    if len(xs) < 5:
        return None
    try:
        from scipy.stats import wilcoxon
        return float(wilcoxon(xs).pvalue)
    except Exception:                                    # noqa: BLE001
        return None


def _subset(cid: str, which: str) -> bool:
    if which == "all":
        return True
    return f"ToothFairy3{which}" in cid or cid.startswith(which)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--a", required=True, type=Path, help="baseline eval dir or metrics.json")
    ap.add_argument("--b", required=True, type=Path, help="challenger")
    ap.add_argument("--name-a", default="A")
    ap.add_argument("--name-b", default="B")
    ap.add_argument("--subset", default="all", help="all | F | P | S")
    ap.add_argument("--out", type=Path)
    args = ap.parse_args()

    A, B = _load(args.a), _load(args.b)
    shared = sorted(set(A["per_case"]) & set(B["per_case"]))
    shared = [c for c in shared if _subset(c, args.subset)]
    if not shared:
        raise SystemExit(f"no shared cases in subset {args.subset!r}")

    # Collect per-class, per-case scores from both arms.
    def rows(run):
        out = {}
        for cid in shared:
            for s in run["per_case"][cid]["classes"]:
                out.setdefault(s["name"], {})[cid] = s
        return out

    ra, rb = rows(A), rows(B)
    classes = sorted(set(ra) | set(rb))

    table = []
    for name in classes:
        pa, pb = ra.get(name, {}), rb.get(name, {})
        gt_cases = [c for c in shared
                    if (pa.get(c) or {}).get("gt_voxels", 0) > 0
                    or (pb.get(c) or {}).get("gt_voxels", 0) > 0]
        gt_present = [c for c in gt_cases
                      if (pa.get(c) or {}).get("gt_voxels", 0) > 0]

        def dice(p, cs, only_gt):
            vals = []
            for c in cs:
                s = p.get(c)
                if not s or s["status"] == "absent_both":
                    continue
                if only_gt and s.get("gt_voxels", 0) == 0:
                    continue
                vals.append(s.get("dice") if s.get("dice") is not None else 0.0)
            return (sum(vals) / len(vals)) if vals else None

        da_gt, db_gt = dice(pa, gt_present, True), dice(pb, gt_present, True)
        da_sc, db_sc = dice(pa, gt_cases, False), dice(pb, gt_cases, False)
        deltas = []
        for c in gt_present:
            sa, sb = pa.get(c), pb.get(c)
            if sa and sb and sa.get("dice") is not None and sb.get("dice") is not None:
                deltas.append(sb["dice"] - sa["dice"])
        miss = lambda p: sum(1 for c in shared if (p.get(c) or {}).get("status") == "missed")
        spur = lambda p: sum(1 for c in shared if (p.get(c) or {}).get("status") == "spurious")
        table.append({
            "class": name, "n_gt": len(gt_present),
            "a_gt": da_gt, "b_gt": db_gt,
            "a_scored": da_sc, "b_scored": db_sc,
            "delta_gt": (db_gt - da_gt) if (da_gt is not None and db_gt is not None) else None,
            "p": _wilcoxon(deltas), "n_pairs": len(deltas),
            "a_missed": miss(pa), "b_missed": miss(pb),
            "a_spurious": spur(pa), "b_spurious": spur(pb),
        })

    hdr = (f"# {args.name_b} vs {args.name_a} — {len(shared)} shared case(s), "
           f"subset {args.subset}\n")
    lines = [hdr,
             "`Dice-GT` averages over cases where GROUND TRUTH has the class (delineation). ",
             "`Dice-scored` also counts cases where a model predicted a class the truth ",
             "does not have, at 0 (detection cost). A model that never abstains wins the ",
             "first and loses the second.\n",
             "| class | n | " + f"{args.name_a}·GT | {args.name_b}·GT | Δ·GT | p | "
             f"{args.name_a}·scored | {args.name_b}·scored | miss A→B | spur A→B |",
             "|---|--:|--:|--:|--:|--:|--:|--:|:--:|:--:|"]
    def f(x):
        return "\u2014" if x is None else f"{x:.4f}"

    def sgn(x):
        return "\u2014" if x is None else f"{x:+.4f}"

    def pv(x):
        return "\u2014" if x is None else f"{x:.2g}"

    for r in sorted(table, key=lambda r: (r["delta_gt"] is None, r["delta_gt"] or 0)):
        lines.append(
            f"| {r['class']} | {r['n_gt']} | {f(r['a_gt'])} | {f(r['b_gt'])} | "
            f"{sgn(r['delta_gt'])} | {pv(r['p'])} | "
            f"{f(r['a_scored'])} | {f(r['b_scored'])} | "
            f"{r['a_missed']}\u2192{r['b_missed']} | "
            f"{r['a_spurious']}\u2192{r['b_spurious']} |")

    text = "\n".join(lines) + "\n"
    print(text)
    if args.out:
        args.out.mkdir(parents=True, exist_ok=True)
        (args.out / "headtohead.md").write_text(text)
        (args.out / "headtohead.json").write_text(json.dumps(
            {"a": args.name_a, "b": args.name_b, "subset": args.subset,
             "cases": shared, "classes": table}, indent=1) + "\n")
        print(f"wrote {args.out}/headtohead.{{md,json}}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
