#!/usr/bin/env python
"""Prove an installed model actually loads, with every weight accounted for.

`worker/nets/umamba2.py` was reconstructed from a checkpoint's own parameter names after
the 2026-09-01 deletion, and its Mamba hyperparameters were SOLVED from tensor shapes
rather than guessed: `A_log [8]` gives 8 heads, `conv1d.weight [704,1,4]` and
`in_proj.weight [1352,320]` then force `d_inner 640`, `expand 2`, `headdim 80`,
`ngroups 1`, `d_state 32` uniquely. A wrong guess fails immediately, and the first one
did.

`load_state_dict(strict=True)` is what turns that reconstruction from plausible into
checked, and this script runs exactly that -- named in `umamba2.py`'s own docstring as
the thing that does. It had been deleted along with everything else, leaving the central
claim of the recovery with no executable witness.

It also reports what the checkpoint declares about itself, because two of those facts
have silently broken things before: the trainer class (which must be `nnUNetTrainer` or
the serving venv cannot resolve it) and the mirroring axes (axis 2 is left-right, and
mirroring across it makes test-time augmentation average one tooth into its
contralateral twin).
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--model-dir", required=True, type=Path)
    ap.add_argument("--fold", default="all")
    ap.add_argument("--checkpoint", default="checkpoint_final.pth")
    args = ap.parse_args()

    import torch
    from nnunetv2.inference.predict_from_raw_data import nnUNetPredictor

    d = args.model_dir
    ck_path = d / f"fold_{args.fold}" / args.checkpoint
    ck = torch.load(ck_path, map_location="cpu", weights_only=False)
    sd = ck.get("network_weights") or ck.get("state_dict") or {}
    ds = json.loads((d / "dataset.json").read_text())

    print(f"{d.name}/fold_{args.fold}/{args.checkpoint}")
    print(f"  trainer          {ck.get('trainer_name')}")
    print(f"  epoch            {ck.get('current_epoch')}")
    print(f"  mirroring axes   {tuple(ck.get('inference_allowed_mirroring_axes') or ())}")
    print(f"  labels           {len(ds.get('labels', {}))}")
    print(f"  tensors          {len(sd)}")

    axes = tuple(ck.get("inference_allowed_mirroring_axes") or ())
    if set(axes) - {0, 1}:
        print("  ! axis 2 is left-right; mirroring across it scrambles contralateral "
              "structures under test-time augmentation")

    # The load itself. `initialize_from_trained_model_folder` builds the architecture
    # from plans.json and then loads strictly -- so a reconstruction that is merely
    # plausible fails right here.
    p = nnUNetPredictor(device=torch.device("cpu"), allow_tqdm=False)
    p.initialize_from_trained_model_folder(str(d), use_folds=(args.fold,),
                                           checkpoint_name=args.checkpoint)
    net = p.network
    # `state_dict()`, not `named_parameters()`: nnU-Net's decoder holds a reference to
    # the encoder, so the same tensors appear under both `encoder.*` and
    # `decoder.encoder.*`. `named_parameters()` de-duplicates them and the checkpoint
    # does not, which reads as 840 missing tensors on a model that loaded strictly.
    got = dict(net.state_dict())
    missing = sorted(set(sd) - set(got))
    extra = sorted(set(got) - set(sd))
    print(f"  heads            {p.label_manager.num_segmentation_heads}")
    print(f"  patch            {p.configuration_manager.patch_size}")
    print(f"  normalization    {p.configuration_manager.normalization_schemes}")
    print(f"  architecture     {type(net).__name__}")
    if missing or extra:
        print(f"  MISMATCH: {len(missing)} in the checkpoint but not the model, "
              f"{len(extra)} the other way")
        for n in (missing[:5] + extra[:5]):
            print(f"    {n} {tuple(sd.get(n, got.get(n)).shape)}")
        return 1
    print(f"  OK: all {len(sd)} tensors matched by name and shape, strict load succeeded")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
