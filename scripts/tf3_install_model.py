#!/usr/bin/env python
"""Install a finetuned nnU-Net run into the serving model store.

Three fixes, all of which the serving venv needs and none of which touch a weight:

1. **Rewrite `trainer_name` to `nnUNetTrainer`.** The fork's trainer classes
   (`nnUNetTrainer_TF3_Task1_*`, `nnUNetTrainerCanalROI`, ...) do not exist in the
   stock 2.8.1 install, and `initialize_from_trained_model_folder` dies resolving
   the class before it ever looks at a tensor. This is safe for inference: the
   architecture is rebuilt from `plans.json` plus the configuration name, and the
   reduced-axis test-time augmentation travels separately in the checkpoint's own
   `inference_allowed_mirroring_axes`, which is asserted to survive.

2. **Drop the optimizer and grad-scaler state.** Roughly halves the file with no
   effect on inference.

3. **Write atomically.** `torch.save` of a 1.1 GB checkpoint to the root filesystem
   takes over two minutes at ~7 MB/s on this box; a `.tmp` plus `os.replace` means
   an interrupted install leaves the previous model intact rather than a truncated
   one.

The mirroring assertion is not decorative. `inference_allowed_mirroring_axes` is
(0, 1) for every model we ship -- superior-inferior and anterior-posterior only.
Axis 2 is left-right and must stay excluded: test-time augmentation averages logits
without touching label ids, so mirroring it averages tooth 11's logit into tooth
21's position.
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))


def install(run: Path, fold: str, checkpoint: str, out: Path, force: bool) -> dict:
    import torch

    src_fold = run / f"fold_{fold}"
    src_ck = src_fold / checkpoint
    for p in (run / "plans.json", run / "dataset.json", src_ck):
        if not p.exists():
            raise FileNotFoundError(p)

    dst_fold = out / "fold_all"
    dst_ck = dst_fold / "checkpoint_final.pth"
    if dst_ck.exists() and not force:
        raise FileExistsError(f"{dst_ck} exists; pass --force to replace it")
    dst_fold.mkdir(parents=True, exist_ok=True)

    ck = torch.load(src_ck, map_location="cpu", weights_only=False)
    original = ck.get("trainer_name")
    mirror = ck.get("inference_allowed_mirroring_axes")
    ck["trainer_name"] = "nnUNetTrainer"
    for k in ("optimizer_state", "grad_scaler_state"):
        ck.pop(k, None)
    if ck.get("inference_allowed_mirroring_axes") != mirror:
        raise AssertionError("the mirroring axes did not survive the rewrite")

    tmp = dst_ck.with_suffix(".tmp")
    torch.save(ck, tmp)
    os.replace(tmp, dst_ck)
    for name in ("plans.json", "dataset.json"):
        shutil.copy2(run / name, out / name)

    info = {
        "source_dir": str(run), "source_checkpoint": checkpoint, "source_fold": fold,
        "original_trainer_name": original, "rewritten_trainer_name": "nnUNetTrainer",
        "inference_allowed_mirroring_axes": list(mirror) if mirror else None,
        "optimizer_state_dropped": True,
        "current_epoch": ck.get("current_epoch"),
        "bytes": dst_ck.stat().st_size,
    }
    (out / "PROVENANCE.json").write_text(json.dumps(info, indent=1) + "\n")
    return info


def verify(out: Path) -> str:
    """Load it the way the worker will. The only check that proves it serves."""
    import torch
    from nnunetv2.inference.predict_from_raw_data import nnUNetPredictor

    p = nnUNetPredictor(device=torch.device("cuda:0" if torch.cuda.is_available() else "cpu"),
                        allow_tqdm=False)
    p.initialize_from_trained_model_folder(str(out), use_folds=("all",),
                                           checkpoint_name="checkpoint_final.pth")
    n = p.label_manager.num_segmentation_heads
    patch = p.configuration_manager.patch_size
    return (f"loads OK — {n} heads, patch {list(patch)}, "
            f"mirroring {p.allowed_mirroring_axes}")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--run", required=True, type=Path, help="an nnUNet_results run dir")
    ap.add_argument("--fold", default="all")
    ap.add_argument("--checkpoint", default="checkpoint_final.pth")
    ap.add_argument("--out", required=True, type=Path, help="models/<slug>")
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--no-verify", action="store_true")
    args = ap.parse_args()

    if args.dry_run:
        print(f"would install {args.run}/fold_{args.fold}/{args.checkpoint}\n"
              f"           -> {args.out}/fold_all/checkpoint_final.pth")
        return 0
    info = install(args.run, args.fold, args.checkpoint, args.out, args.force)
    print(json.dumps(info, indent=1))
    if not args.no_verify:
        print(verify(args.out))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
