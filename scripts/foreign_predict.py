#!/usr/bin/env python
"""Run one installed third-party model over a folder and emit ToothFairy3 Task-1 ids.

Standalone, not composed: this is for SCORING a foreign model against the same ground
truth and through the same `scripts/eval_dice.py` as every row of `eval/COMPARISON.md`.
Ownership is a separate decision made in `scripts/board_ownership.py`; this only produces
the evidence.

The label mapping comes from `crosswalk.LABEL_RULES`, derived from the model's own
`dataset.json` at load time and cross-checked against the map recorded in its
`PROVENANCE.json` at install. A model that quietly became a different model is a
published number that quietly became wrong.

**Leakage, stated here because the numbers are meaningless without it.** TotalSegmentator
trained on the public ToothFairy3 release and ToothSeg on ToothFairy2, which is a SUBSET
of it; our 20-case holdout is a split we made out of that same release. So on this
holdout their wins prove nothing and only their LOSSES are informative. The 5 `S` cases
are the ToothFairy3 addition (63 F + 417 P = 480 = ToothFairy2's training count) and are
leak-free for ToothSeg alone.
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import numpy as np  # noqa: E402
import SimpleITK as sitk  # noqa: E402

from dentistry import crosswalk  # noqa: E402
from dentistry import toothfairy3 as tf3d  # noqa: E402
from dentistry.config import Settings  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--model-dir", required=True, type=Path)
    ap.add_argument("--label-rule", required=True, choices=sorted(crosswalk.LABEL_RULES))
    ap.add_argument("--fold", default="0")
    ap.add_argument("--checkpoint", default="checkpoint_final.pth")
    ap.add_argument("--images", required=True, type=Path)
    ap.add_argument("--out", required=True, type=Path)
    ap.add_argument("--raw-header", choices=("tf3", "trust"), default="tf3")
    ap.add_argument("--tile-step", type=float, default=0.5)
    ap.add_argument("--limit", type=int)
    args = ap.parse_args()

    # A 256^3 patch with 33 heads leaves ~3.5 GiB reserved-but-unallocated on this card,
    # and the run dies on fragmentation rather than on real demand. Expandable segments
    # is PyTorch's own remedy for exactly that pattern; set here rather than in the
    # environment so the fix travels with the script that needs it.
    import os
    os.environ.setdefault("PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True")

    from worker import tf3

    ds = json.loads((args.model_dir / "dataset.json").read_text())
    lut = crosswalk.LABEL_RULES[args.label_rule](ds["labels"])
    prov_path = args.model_dir / "PROVENANCE.json"
    if prov_path.exists():
        prov = json.loads(prov_path.read_text())
        recorded = prov.get("label_map")
        if recorded:
            now = {str(i): int(v) for i, v in enumerate(lut) if int(v)}
            if now != recorded:
                raise SystemExit(
                    "the derived label map no longer matches the one recorded at install; "
                    "this model is not the one that was measured")
    print(f"{args.model_dir.name}: {int((lut > 0).sum())} labels -> Task-1 "
          f"(rule {args.label_rule})")

    args.out.mkdir(parents=True, exist_ok=True)
    predictor = tf3.build_predictor(args.model_dir, args.fold, args.checkpoint,
                                    tile_step=args.tile_step, mirroring=True)
    # Clamped, never inherited: axis 2 is left-right and mirroring across it makes
    # test-time augmentation average one tooth into its contralateral twin.
    predictor.allowed_mirroring_axes = tuple(
        a for a in (getattr(predictor, "allowed_mirroring_axes", ()) or ()) if a in (0, 1))

    files = sorted(args.images.glob("*.nii.gz"))
    if args.limit:
        files = files[:args.limit]
    for n, p in enumerate(files, 1):
        cid = p.name.replace("_0000.nii.gz", "").replace(".nii.gz", "")
        # Resumable: a 256^3 model on an 11.6 GiB card is close enough to the edge that
        # an OOM part-way through should not cost the cases already done.
        if (args.out / f"{cid}.nii.gz").exists():
            print(f"  [{n}/{len(files)}] {cid}  (already done)", flush=True)
            continue
        t0 = time.monotonic()
        img = sitk.ReadImage(str(p))
        if args.raw_header == "tf3":
            img = tf3d.fix_raw_header(img)
        arr = sitk.GetArrayFromImage(img).astype(np.float32)[None]
        props = {"spacing": list(img.GetSpacing())[::-1]}
        with tf3.borrowed_gpu(predictor, True):
            out = predictor.predict_single_npy_array(arr, props, None, None, False)
        del arr
        mapped = lut[np.clip(out, 0, len(lut) - 1)]
        del out
        seg = sitk.GetImageFromArray(mapped.astype(np.uint8))
        seg.CopyInformation(img)
        sitk.WriteImage(seg, str(args.out / f"{cid}.nii.gz"), True)
        found = int(len(np.unique(mapped)) - 1)
        print(f"  [{n}/{len(files)}] {cid}  {time.monotonic()-t0:6.1f}s  {found} classes",
              flush=True)
        del mapped, seg
    (args.out / "run.json").write_text(json.dumps({
        "model_dir": str(args.model_dir), "label_rule": args.label_rule,
        "fold": args.fold, "checkpoint": args.checkpoint,
        "leakage": ("trained on the public ToothFairy3/ToothFairy2 release, which this "
                    "holdout is a split of: wins here prove nothing, losses are real"),
    }, indent=1) + "\n")
    print(f"wrote {len(files)} predictions to {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
