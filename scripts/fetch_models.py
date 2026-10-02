#!/usr/bin/env python3
"""Install and verify the model weights a self-hosted worker needs.

    python scripts/fetch_models.py --toothseg            # the public ToothSeg specialist
    python scripts/fetch_models.py --verify              # check what is in the model store
    python scripts/fetch_models.py --mirror URL --manifest FILE
                                                         # your own weights, from your own server

Standard library only, so it runs before anything else is installed.

WHICH WEIGHTS ARE PUBLIC. The base network (ToothFairy3 U-Mamba2) and the anterior canal
specialist are first-party checkpoints and are NOT distributed with this project. A
deployment supplies its own, in nnU-Net's layout, under the model store:

    <store>/toothfairy3/       dataset.json  plans.json  cc_thresholds.json  fold_all/checkpoint_final.pth
    <store>/canal_specialist/  dataset.json  plans.json  fold_all/checkpoint_final.pth   (optional)

`--verify` checks that layout. To move your own weights between machines, stage them
with `scripts/package_weights.py` (which writes a manifest of SHA-256 hashes), serve that
directory from any web server, and point `--mirror`/`--manifest` at it: every file is
then checked against its hash, and a mismatch deletes the file and fails.

ToothSeg (MIC-DKFZ, CC BY 4.0) is public and pinned in `scripts/models.manifest.json`.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PUBLIC_MANIFEST = Path(__file__).resolve().parent / "models.manifest.json"
UA = "implantplan-fetch-models/1"

#: What the worker needs to find for each first-party model (models.py's install check).
REQUIRED = {
    "toothfairy3": ("dataset.json", "plans.json", "cc_thresholds.json",
                    "fold_all/checkpoint_final.pth"),
    "canal_specialist": ("dataset.json", "plans.json", "fold_all/checkpoint_final.pth"),
}


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def download(url: str, dest: Path, size: int | None) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    part = dest.with_name(dest.name + ".part")
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=60) as r, part.open("wb") as out:
        total = size or int(r.headers.get("Content-Length") or 0)
        got, last = 0, 0.0
        while True:
            chunk = r.read(1 << 20)
            if not chunk:
                break
            out.write(chunk)
            got += len(chunk)
            now = time.monotonic()
            if total and now - last > 1.0:
                last = now
                print(f"\r  {dest.name}: {got / 1e6:7.1f} / {total / 1e6:.1f} MB", end="", flush=True)
    print(f"\r  {dest.name}: {got / 1e6:7.1f} MB downloaded{' ' * 20}")
    part.replace(dest)


def fetch(url: str, dest: Path, want_sha: str, size: int | None) -> None:
    if dest.exists() and sha256(dest) == want_sha:
        print(f"  ok   {dest.name} (already present, hash matches)")
        return
    download(url, dest, size)
    got = sha256(dest)
    if got != want_sha:
        dest.unlink(missing_ok=True)
        raise SystemExit(f"SHA-256 mismatch for {dest.name}: got {got}, want {want_sha}. "
                         "The file was deleted; nothing was installed from it.")
    print(f"  verified {dest.name}")


def verify(store: Path) -> int:
    """Report, per first-party model, whether the worker will find it. 0 if the base is there."""
    status = 0
    for model, files in REQUIRED.items():
        missing = [f for f in files if not (store / model / f).exists()]
        if missing:
            role = "REQUIRED" if model == "toothfairy3" else "optional"
            print(f"  missing  {model} ({role}): {', '.join(missing)}")
            if model == "toothfairy3":
                status = 1
        else:
            print(f"  ok       {model}")
    ts = store / "toothseg_semantic"
    print(f"  {'ok      ' if (ts / 'fold_5').is_dir() else 'absent  '} toothseg_semantic (optional)")
    if status:
        print("\nThe base model is not installed, so the worker cannot segment. The first-party "
              "weights are not distributed with this project; see docs/self-hosting.md, "
              "'Model weights'.")
    return status


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--dest", type=Path,
                    default=Path(os.environ.get("DENT_MODEL_STORE") or ROOT / "models"),
                    help="the model store (default: $DENT_MODEL_STORE, else ./models)")
    ap.add_argument("--toothseg", action="store_true",
                    help="install the public ToothSeg teeth specialist (920 MB zip, Zenodo)")
    ap.add_argument("--mirror", help="base URL of your own staged weights (package_weights.py)")
    ap.add_argument("--manifest", type=Path,
                    help="the manifest.json package_weights.py wrote for that mirror")
    ap.add_argument("--verify", action="store_true", help="only check the model store")
    args = ap.parse_args()
    dest = args.dest.resolve()
    print(f"model store: {dest}")

    if args.mirror or args.manifest:
        if not (args.mirror and args.manifest):
            raise SystemExit("--mirror and --manifest go together")
        m = json.loads(args.manifest.read_text())
        base = args.mirror.rstrip("/")
        print(f"weights:     {base}")
        for f in m["files"]:
            fetch(f"{base}/{f['path']}", dest / f["path"], f["sha256"], f.get("bytes"))

    if args.toothseg:
        z = json.loads(PUBLIC_MANIFEST.read_text())["toothseg"]
        zpath = ROOT / "vendor" / "downloads" / z["file"]
        print(f"ToothSeg:    {z['url']}")
        fetch(z["url"], zpath, z["sha256"], z.get("bytes"))
        out = dest / z["install_as"]
        if (out / f"fold_{z['fold']}" / "checkpoint_final.pth").exists():
            print(f"  ok   {z['install_as']} already installed")
        else:
            # prepare_models.py rewrites the trainer name, checks the mirroring axes and
            # proves the result loads; it needs the worker's own Python (torch, nnU-Net).
            subprocess.run([sys.executable, str(ROOT / "scripts" / "prepare_models.py"),
                            "--model", "toothseg-semantic", "--zip", str(zpath),
                            "--fold", z["fold"], "--out", str(out)], check=True)

    print("\nmodel store:")
    return verify(dest)


if __name__ == "__main__":
    raise SystemExit(main())
