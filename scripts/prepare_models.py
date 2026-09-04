#!/usr/bin/env python
"""Install a third-party nnU-Net model into `models/<slug>` so the board can mount it.

Three things happen here that must not be skipped, each of which has cost this project
real time when it was missing:

1. **The trainer name is rewritten to `nnUNetTrainer`.** Third-party checkpoints name
   trainer classes (`nnUNetTrainer_onlyMirror01`, `nnUNetTrainer_DASegOrd0_NoMirroring`)
   that do not exist in the serving venv, and nnU-Net resolves the class by name at load
   time. Without this the model simply will not load.

2. **Mirroring axes are asserted to exclude axis 2.** Test-time augmentation honours
   whatever the checkpoint declares, and axis 2 is left-right: a model declaring it
   would have TTA average tooth 11's logit into tooth 21's position. That is a silent
   left/right scramble on exactly the structure group a teeth model is bought for, and
   it is the same trap that cost DKFZ 0.16 Dice on ToothFairy2.

3. **The derived label map and a sha256 of `dataset.json` go into PROVENANCE.json.**
   `crosswalk`'s rules re-derive the map from the model's own labels at every load and
   raise if a name stops resolving; this second layer catches anything at all changing
   since the measurement, including a change that still resolves. A model that quietly
   became a different model is a published number that quietly became wrong.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import sys
import tempfile
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from dentistry import crosswalk  # noqa: E402

# Everything about a third-party model that is OUR decision, kept beside the evidence
# rather than passed on a command line where it would be retyped differently each time.
KNOWN = {
    "totalseg-tf3": {
        "zip": "Dataset113_ToothFairy3.zip",
        "slug": "totalsegmentator_teeth",
        "label_rule": "totalseg",
        "license": "Apache-2.0",
        "source": "https://github.com/wasserth/TotalSegmentator (v2.5.0-weights)",
        "note": ("Ids 1-45 are ToothFairy3 Task-1 ids; pulp is 32 per-tooth classes "
                 "where the challenge merges to one. Measured on our holdout before the "
                 "2026-09-01 deletion: strict 0.8014, and it took ownership of NOTHING "
                 "-- zero accessory-canal voxels in 18/18 cases."),
    },
    "totalseg-craniofacial": {
        "zip": "Dataset115_mandible.zip",
        "slug": "totalseg_craniofacial",
        "label_rule": None,          # its own space; scored, never composed
        "license": "Apache-2.0",
        "source": "https://github.com/wasserth/TotalSegmentator (v2.5.0-weights)",
        "note": ("Carries `sinus_maxillary`, the one structure ToothFairy3 cannot teach. "
                 "Pre-committed gate was an anatomical sinus on three clinical scans; it "
                 "passed on one, and its mandible Dice was 0.8247-0.8534 against our "
                 "0.9891. Not adopted."),
    },
    "toothseg-semantic": {
        "zip": "ToothSeg.zip",
        "slug": "toothseg_semantic",
        "label_rule": "toothseg",
        "license": "Apache-2.0",
        "source": "https://zenodo.org/records/14893540 (MIC-DKFZ/ToothSeg)",
        "note": ("The ToothFairy2 challenge winner on teeth (Dice 0.9253), at our own "
                 "0.3 mm. Trained on ToothFairy2, a SUBSET of ToothFairy3 -- so our "
                 "holdout is leaked for it and only its LOSSES there are informative."),
    },
}


def _sha256(p: Path) -> str:
    h = hashlib.sha256()
    with p.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _find_fold(root: Path, fold: str) -> Path:
    """The results directory holding `fold_<fold>` plus plans.json and dataset.json."""
    for cand in sorted(root.rglob("plans.json")):
        d = cand.parent
        if (d / "dataset.json").exists() and (d / f"fold_{fold}").is_dir():
            return d
    raise SystemExit(f"no results directory with fold_{fold} under {root}")


def install(src: Path, out: Path, fold: str, checkpoint: str, meta: dict,
            force: bool) -> dict:
    if out.exists() and not force:
        raise SystemExit(f"{out} exists; pass --force to replace it")
    run = _find_fold(src, fold)
    plans = json.loads((run / "plans.json").read_text())
    ds = json.loads((run / "dataset.json").read_text())

    ck_path = run / f"fold_{fold}" / checkpoint
    if not ck_path.exists():
        raise SystemExit(f"missing {ck_path}")

    import torch
    ck = torch.load(ck_path, map_location="cpu", weights_only=False)
    axes = tuple(ck.get("inference_allowed_mirroring_axes") or ())
    if set(axes) - {0, 1}:
        raise SystemExit(
            f"REFUSING: this checkpoint declares mirroring axes {axes}. Axis 2 is "
            f"left-right; mirroring across it makes test-time augmentation average one "
            f"tooth's logit into its contralateral twin. Clamp it deliberately or do not "
            f"install this model.")
    before = ck.get("trainer_name")
    ck["trainer_name"] = "nnUNetTrainer"
    ck.pop("optimizer_state", None)

    # The label map, derived NOW from this model's own dataset.json, so a later drift
    # can be detected rather than absorbed.
    label_map = None
    if meta.get("label_rule"):
        lut = crosswalk.LABEL_RULES[meta["label_rule"]](ds["labels"])
        label_map = {str(i): int(v) for i, v in enumerate(lut) if int(v)}

    out.mkdir(parents=True, exist_ok=True)
    (out / f"fold_{fold}").mkdir(exist_ok=True)
    tmp = out / f"fold_{fold}" / (checkpoint + ".tmp")
    torch.save(ck, tmp)
    tmp.replace(out / f"fold_{fold}" / checkpoint)       # atomic
    shutil.copy2(run / "plans.json", out / "plans.json")
    shutil.copy2(run / "dataset.json", out / "dataset.json")

    prov = {
        "slug": out.name,
        "source": meta["source"],
        "license": meta["license"],
        "note": meta["note"],
        "source_run": str(run.relative_to(src)) if src in run.parents else str(run),
        "rewritten_trainer_name": {"from": before, "to": "nnUNetTrainer"},
        "optimizer_state_dropped": True,
        "inference_allowed_mirroring_axes": list(axes),
        "label_rule": meta.get("label_rule"),
        "label_map": label_map,
        "dataset_sha256": hashlib.sha256(
            json.dumps(ds, sort_keys=True).encode()).hexdigest(),
        "normalization_schemes": sorted({
            n for c in plans.get("configurations", {}).values()
            for n in (c.get("normalization_schemes") or [])}),
        "n_labels": len(ds.get("labels", {})),
        "bytes": (out / f"fold_{fold}" / checkpoint).stat().st_size,
    }
    (out / "PROVENANCE.json").write_text(json.dumps(prov, indent=1) + "\n")
    return prov


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--model", required=True, choices=sorted(KNOWN))
    ap.add_argument("--zip", type=Path, default=None)
    ap.add_argument("--downloads", type=Path,
                    default=Path(__file__).resolve().parent.parent / "vendor/downloads")
    ap.add_argument("--out", type=Path, default=None)
    ap.add_argument("--fold", default="0")
    ap.add_argument("--checkpoint", default="checkpoint_final.pth")
    ap.add_argument("--force", action="store_true")
    args = ap.parse_args()

    meta = KNOWN[args.model]
    zpath = args.zip or (args.downloads / meta["zip"])
    if not zpath.exists():
        raise SystemExit(f"missing {zpath}")
    root = Path(__file__).resolve().parent.parent
    out = args.out or (root / "models" / meta["slug"])

    print(f"{args.model}: {zpath.name}  sha256 {_sha256(zpath)[:16]}...")
    with tempfile.TemporaryDirectory(dir="/tmp") as td:
        with zipfile.ZipFile(zpath) as z:
            z.extractall(td)
        prov = install(Path(td), out, args.fold, args.checkpoint, meta, args.force)
    print(json.dumps(prov, indent=1))

    # It has to LOAD in the serving venv, or the install proved nothing.
    from nnunetv2.inference.predict_from_raw_data import nnUNetPredictor
    p = nnUNetPredictor(device=__import__("torch").device("cpu"), allow_tqdm=False)
    p.initialize_from_trained_model_folder(str(out), use_folds=(args.fold,),
                                           checkpoint_name=args.checkpoint)
    print(f"\nverified: loads in the serving venv, "
          f"{p.label_manager.num_segmentation_heads} heads, "
          f"mirroring {p.allowed_mirroring_axes}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
