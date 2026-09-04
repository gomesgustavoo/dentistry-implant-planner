#!/usr/bin/env python
"""Measure the CBCT transfer probe, and what the extended models draw, on stored cases.

THE QUESTION. Three TotalSegmentator head/neck models are trained on CT in Hounsfield
units. The input here is CBCT, whose grey values are uncalibrated and whose
miscalibration axis is gain rather than offset. Do they transfer at all?

THE PROBE, and why it is the one available honest answer. There is no CBCT ground truth
for a tongue or a parotid gland anywhere in this project, so nothing here can score them.
What CAN be scored is a structure both sides draw: `totalseg_craniofacial`
(`Dataset115_mandible`) is the same vendor, the same CT training distribution and the
same normalisation, and it outputs a MANDIBLE -- which we segment at Dice 0.9401 on a
20-case holdout. Running it on the same calibrated volume and scoring its mandible
against ours asks "did this family of models find real anatomy in this scan", which is
the question that has to be answered before any of its other outputs mean anything.

It is a NECESSARY condition, not a sufficient one. A passing probe does not make a tongue
correct; it only rules out the failure where the network saw noise. That distinction is
the whole reason `dentistry/extended.py::UNMEASURED` forbids measuring from any of these.

WHAT ELSE THIS REPORTS, because a Dice alone would hide the interesting failures:
plausibility per structure -- was it found at all, in how many pieces, at what volume,
and does a left/right pair agree in size. A model that transfers but draws a 4 cm3
tongue in the ramus passes the probe and fails anatomy, and only the second table shows
it.

    ./venv/bin/python scripts/extended_probe_eval.py --limit 3 --out eval/extended
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from dentistry import extended as EX  # noqa: E402
from dentistry import labels as L  # noqa: E402
from dentistry.config import settings  # noqa: E402


def holdout_cases(images: Path, limit: int) -> list[Path]:
    """The ToothFairy3 holdout, which is where the CBCTs are.

    NOT the stored jobs: `worker/retention.py` purges the upload the moment a job reaches
    `done`, so a finished case has a segmentation and no image to re-run a model on. The
    holdout has both, at 0.3 mm, and its ground truth is what our own mandible Dice of
    0.9401 was measured against -- so the probe's reference here is the same reference the
    threshold was argued from.
    """
    out = sorted(images.glob("*_0000.nii.gz"))
    return out[:limit] if limit else out


def load_case(image_path: Path):
    """The canonical image, and OUR OWN segmentation of it, on one grid.

    Ours is produced here rather than read from disk: the probe compares a CT-trained
    model's mandible against ours, so ours has to come from the same code path the
    product runs. `pipeline.segment_task1` is that path -- the same function
    `worker/main.py` calls and the same one every evaluation grades.
    """
    import SimpleITK as sitk

    from dentistry import crosswalk
    from worker import orient, pipeline

    raw = sitk.ReadImage(str(image_path))
    img, _code = orient.to_canonical(raw)
    res = pipeline.segment_task1(img, settings, rep=lambda *a, **k: None,
                                 use_lock=True, config=None,
                                 load_labels=_load_labels)
    merged = crosswalk.task1_to_merged_lut()[res.seg]
    return img, merged, res.reports


def _load_labels(model_dir) -> dict:
    return {k: int(v) for k, v in
            json.loads((Path(model_dir) / "dataset.json").read_text())["labels"].items()}


def plausibility(merged: np.ndarray, spacing_zyx) -> list[dict]:
    """Per extended structure: found, volume, components, and left/right symmetry.

    A Dice cannot see any of this. These are the checks that separate "the model ran"
    from "the model drew anatomy", and they need no ground truth -- which is the point,
    because there is none.
    """
    from scipy import ndimage

    vox_cm3 = float(np.prod(spacing_zyx)) / 1000.0
    rows = []
    for e in EX.EXTENDED:
        m = merged == e.index
        n = int(np.count_nonzero(m))
        if not n:
            rows.append({"id": e.id, "name": e.name, "found": False})
            continue
        lab, ncomp = ndimage.label(m)
        sizes = np.bincount(lab.ravel())[1:]
        rows.append({
            "id": e.id, "name": e.name, "found": True,
            "cm3": round(n * vox_cm3, 3),
            "components": int(ncomp),
            "largest_frac": round(float(sizes.max() / sizes.sum()), 4),
        })
    # Left/right volume agreement. A paired structure whose sides differ by more than a
    # factor of two is either genuinely asymmetric, cut by the field of view, or wrong --
    # and the first two are common enough on dental CBCT that this is reported, never
    # asserted.
    by_id = {r["id"]: r for r in rows}
    for r in rows:
        if not r["id"].endswith("_right"):
            continue
        other = by_id.get(r["id"][:-6] + "_left")
        if not other or not r.get("found") or not other.get("found"):
            continue
        a, b = r["cm3"], other["cm3"]
        r["lr_ratio"] = round(max(a, b) / max(min(a, b), 1e-6), 2)
    return rows


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=3)
    ap.add_argument("--images", default="/mnt/mldata/tf3/holdout/images")
    ap.add_argument("--out", default="eval/extended")
    ap.add_argument("--models", default="head-muscles,head-glands,headneck-bones")
    args = ap.parse_args()

    root = Path(__file__).resolve().parents[1]
    out_dir = root / args.out
    out_dir.mkdir(parents=True, exist_ok=True)

    from worker import extended_board

    cases = holdout_cases(Path(args.images), args.limit)
    if not cases:
        raise SystemExit(f"no CBCTs under {args.images}")
    print(f"{len(cases)} case(s)\n")

    config = {k: "apply" for k in args.models.split(",") if k}
    results = []
    for image_path in cases:
        name = image_path.name.replace("_0000.nii.gz", "")
        print(f"=== {name}")
        image, merged, _report = load_case(image_path)
        spacing_zyx = tuple(reversed(image.GetSpacing()))

        t0 = time.monotonic()
        probe = extended_board.transfer_probe(image, merged, settings, use_lock=True)
        print(f"    probe: dice={probe.get('dice')} ok={probe.get('ok')} "
              f"({probe.get('seconds')}s)")
        if probe.get("reason"):
            print(f"           {probe['reason']}")

        before = merged.copy()
        merged, runs, rep = extended_board.compose(
            merged, image, settings, config, use_lock=True, probe=probe,
            spacing_zyx=spacing_zyx)
        # The invariant, checked here too rather than trusted from inside compose.
        extended_board.assert_dental_unchanged(before, merged)

        rows = plausibility(merged, spacing_zyx)
        found = [r for r in rows if r.get("found")]
        print(f"    drew {len(found)}/{len(rows)} extended structures "
              f"in {round(time.monotonic() - t0, 1)}s")
        results.append({
            "case": name,
            "probe": probe,
            "extended": rep,
            "runs": [vars(r) for r in runs],
            "spacing_zyx": [round(float(v), 4) for v in spacing_zyx],
            "structures": rows,
        })
        print()

    (out_dir / "probe.json").write_text(json.dumps(results, indent=1) + "\n")
    print(f"wrote {out_dir / 'probe.json'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
