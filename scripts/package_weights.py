#!/usr/bin/env python3
"""Stage the first-party weights for publication, and pin them in the manifest.

    python scripts/package_weights.py --out /path/to/staging --repo <owner>/<name>

Copies `models/toothfairy3` and `models/canal_specialist` into a staging directory
laid out exactly as the model store expects (so `fetch_models.py` can drop them in
place), with two changes and nothing else:

* `PROVENANCE.json` loses the absolute training path (`source_dir` kept as its last
  two components: the dataset and the trainer/plans identifier, which is what a reader
  needs to reproduce it), and
* a model card `README.md` is written at the root, carrying the licence.

Then it writes `scripts/models.manifest.json` with the SHA-256 and size of every
staged file. Upload the staging directory to the named Hugging Face model repository
(the user's own account; this script never uploads anything), then set `revision` in
the manifest to the commit the upload produced.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MODELS = ("toothfairy3", "canal_specialist")
FILES = ("dataset.json", "plans.json", "PROVENANCE.json", "fold_all/checkpoint_final.pth")
EXTRA = {"toothfairy3": ("cc_thresholds.json",)}

CARD = """---
license: cc-by-nc-sa-4.0
tags: [medical-imaging, cbct, dental, segmentation, nnunet, implant-planning]
---

# ImplantPlan segmentation weights

The two networks the ImplantPlan worker runs on a dental cone-beam CT
(code: https://github.com/gomesgustavoo/dentistry-implant-planner, MIT).

| Directory | Network | What it draws |
|---|---|---|
| `toothfairy3/` | nnU-Net (ResEnc L) with a U-Mamba2 bottleneck, fine-tuned 1000 epochs | 46 ToothFairy3 Task-1 classes: jaws, 32 FDI teeth, canals, sinuses, airway, restorations |
| `canal_specialist/` | nnU-Net ResEnc M on an anterior-mandible ROI | incisive (left, right) and lingual canals |

Measured on 20 held-out ToothFairy3 cases: strict Dice 0.8292, HD95 1.235 mm, NSD 0.9736,
challenge Dice 0.8965. These are numbers about a held-out split of the training
distribution, not about your scanner.

## Licence

**CC BY-NC-SA 4.0.** These weights are derived from the ToothFairy3 dataset
(University of Modena and Reggio Emilia), which is CC BY-NC-SA 4.0, so they are for
research and non-commercial use only and derivatives must carry the same licence.

## Not a medical device

Research software. Not cleared for clinical or diagnostic use. CBCT grey values are not
calibrated Hounsfield units.

## Credits

- ToothFairy3 challenge dataset — University of Modena and Reggio Emilia
  (https://toothfairy3.grand-challenge.org/).
- U-Mamba2 — Wu et al., MICCAI 2025.
- nnU-Net — Isensee et al., Nature Methods 2021.

## Use

    python scripts/fetch_models.py      # from the ImplantPlan repository

`scripts/models.manifest.json` there pins the SHA-256 of every file in this repository.
"""


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--repo", required=True, help="Hugging Face model repo, owner/name")
    ap.add_argument("--store", type=Path, default=ROOT / "models")
    args = ap.parse_args()
    out = args.out.resolve()
    out.mkdir(parents=True, exist_ok=True)
    entries = []
    for model in MODELS:
        for rel in FILES + EXTRA.get(model, ()):
            src = args.store / model / rel
            dst = out / model / rel
            dst.parent.mkdir(parents=True, exist_ok=True)
            if rel == "PROVENANCE.json":
                prov = json.loads(src.read_text())
                if prov.get("source_dir"):
                    prov["source_dir"] = "/".join(Path(prov["source_dir"]).parts[-2:])
                dst.write_text(json.dumps(prov, indent=1) + "\n")
            else:
                shutil.copy2(src, dst)
            entries.append({"path": f"{model}/{rel}", "sha256": sha256(dst),
                            "bytes": dst.stat().st_size})
            print(f"  {model}/{rel}  {entries[-1]['bytes']:>12,}  {entries[-1]['sha256'][:16]}")
    (out / "README.md").write_text(CARD)

    manifest_path = Path(__file__).resolve().parent / "models.manifest.json"
    manifest = json.loads(manifest_path.read_text()) if manifest_path.exists() else {}
    manifest["huggingface"] = {"repo": args.repo,
                               "revision": manifest.get("huggingface", {}).get("revision", "main"),
                               "license": "CC-BY-NC-SA-4.0", "files": entries}
    manifest_path.write_text(json.dumps(manifest, indent=1) + "\n")
    print(f"\nstaged {len(entries)} files in {out}\nmanifest: {manifest_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
