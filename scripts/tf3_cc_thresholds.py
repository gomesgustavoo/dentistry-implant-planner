#!/usr/bin/env python
"""Derive the per-class connected-component thresholds from the training labels.

The filter this table drives is the biggest post-processing lever the ToothFairy3
model has: challenge Dice +0.056 and HD95 72.4 -> 41.8 voxels at the 2nd
percentile. The rule is the challenge winners': a real structure is never smaller
than the smallest one an annotator drew, and an island usually is.

**The statistic is the LARGEST component per case, not every component.** Ground
truth is not clean: measured over all 512 annotations, class 1 (the lower jawbone)
has 17 733 connected components -- about 34 per case, where anatomy has one. The
rest are single-voxel specks left by the annotation tool. Taking a percentile over
that distribution returns 1 for every class, and a threshold of 1 voxel filters
nothing at all.

That is not hypothetical. The table rebuilt on 2026-09-01 after the project tree was
destroyed did exactly this, the component filter silently became a no-op, and the
20-case holdout scored 0.8001 strict against a published 0.8281 -- the whole 0.028
being this one line. The per-case maximum is what "the smallest one an annotator
drew" has to mean.

Two properties of the output that callers depend on:

* thresholds are keyed by **Task-1 id**, so the filter runs before the crosswalk;
* they are **voxel counts at 0.027 mm3** (0.3 mm isotropic), so the filter runs on
  the plan grid and not on the case's own.

Both are asserted by `worker/cc_filter.py`'s docstring and neither survives a step
later in the pipeline, which is why they are stated in the table itself.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import numpy as np  # noqa: E402

PERCENTILES = (0.5, 1.0, 2.0, 5.0)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--labels", type=Path,
                    default=Path("/mnt/mldata/tf3/nnUNet_raw/Dataset119_ToothFairy3/labelsTr"))
    ap.add_argument("--out", type=Path,
                    default=Path("models/toothfairy3/cc_thresholds.json"))
    ap.add_argument("--limit", type=int, default=0)
    args = ap.parse_args()

    import SimpleITK as sitk
    from scipy import ndimage

    files = sorted(args.labels.glob("*.nii.gz"))
    if args.limit:
        files = files[:args.limit]
    if not files:
        raise SystemExit(f"no label files under {args.labels}")
    print(f"{len(files)} training annotations", flush=True)

    sizes: dict[int, list] = {}          # largest component per (case, class)
    all_sizes: dict[int, int] = {}       # how many components in total -- diagnostic
    spacings = set()
    for i, p in enumerate(files, 1):
        img = sitk.ReadImage(str(p))
        spacings.add(tuple(round(float(s), 4) for s in img.GetSpacing()))
        arr = sitk.GetArrayFromImage(img)
        del img
        for v in (int(x) for x in np.unique(arr) if x):
            lab, n = ndimage.label(arr == v)
            if n:
                comp = ndimage.sum(arr == v, lab, range(1, n + 1))
                # The structure the annotator drew, not the specks around it.
                sizes.setdefault(v, []).append(int(max(comp)))
                all_sizes[v] = all_sizes.get(v, 0) + n
            del lab
        del arr
        if i % 50 == 0 or i == len(files):
            print(f"  {i}/{len(files)}", flush=True)

    if len(spacings) > 1:
        print(f"  ! mixed spacings {sorted(spacings)} -- thresholds are voxel counts "
              f"and only mean one thing on one grid")

    table = {
        "source": str(args.labels),
        "n_cases": len(files),
        "spacing": sorted(spacings)[0] if spacings else None,
        "note": ("voxel counts at this spacing, keyed by TASK-1 id. Apply BEFORE the "
                 "crosswalk to merged ids and ON the plan grid; neither is true "
                 "afterwards."),
        "statistic": ("largest connected component per case; see the module docstring "
                      "for why every-component returns a threshold of 1"),
        "cases_with_class": {str(k): len(v) for k, v in sorted(sizes.items())},
        "components_total": {str(k): v for k, v in sorted(all_sizes.items())},
        "percentiles": {},
    }
    for pct in PERCENTILES:
        table["percentiles"][f"p{pct:g}"] = {
            str(k): int(np.percentile(v, pct)) for k, v in sorted(sizes.items())}

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(table, indent=1) + "\n")
    p2 = table["percentiles"]["p2"]
    inert = [k for k, v in p2.items() if v <= 1]
    if inert:
        print(f"  ! {len(inert)} class(es) have a p2 threshold of <=1 voxel, which "
              f"filters nothing: {inert[:8]}")
    print(f"wrote {args.out}: {len(sizes)} classes, percentiles "
          f"{', '.join(table['percentiles'])}")
    print(f"  p2 range {min(p2.values())}..{max(p2.values())} voxels")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
