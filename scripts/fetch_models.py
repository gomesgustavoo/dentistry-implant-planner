#!/usr/bin/env python3
"""Download the model weights a self-hosted worker needs, and verify every byte.

    python scripts/fetch_models.py               # ToothFairy3 U-Mamba2 + canal specialist
    python scripts/fetch_models.py --toothseg    # ... plus the optional ToothSeg specialist
    python scripts/fetch_models.py --dest /models

Standard library only, so it runs before anything else is installed. What it fetches
is pinned by `scripts/models.manifest.json`: the Hugging Face repository, a revision,
and the SHA-256 and size of every file. A file whose hash does not match is deleted
and the run fails, so a half-downloaded or substituted checkpoint can never be
mistaken for an installed one. Files already present with the right hash are skipped.

Licences. The two first-party networks are fine-tuned on ToothFairy3 and are
CC BY-NC-SA 4.0: research and non-commercial use only. ToothSeg (MIC-DKFZ) is
CC BY 4.0 on Zenodo.

Mirrors: set IMPLANTPLAN_WEIGHTS_URL to any server holding the same paths. Read the model card on the Hugging Face repository before use.
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
MANIFEST = Path(__file__).resolve().parent / "models.manifest.json"
UA = "implantplan-fetch-models/1"


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


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--dest", type=Path,
                    default=Path(os.environ.get("DENT_MODEL_STORE") or ROOT / "models"),
                    help="the model store (default: $DENT_MODEL_STORE, else ./models)")
    ap.add_argument("--toothseg", action="store_true",
                    help="also install the optional ToothSeg teeth specialist (920 MB zip)")
    args = ap.parse_args()
    m = json.loads(MANIFEST.read_text())
    dest = args.dest.resolve()
    hf = m["huggingface"]
    if "REPLACE" in hf["repo"]:
        raise SystemExit("scripts/models.manifest.json names no published repository yet")
    print(f"model store: {dest}")
    # A mirror (an air-gapped clinic's own file server, say) is any URL that serves the
    # same paths; the hashes in the manifest are what make it trustworthy, not the host.
    base = (os.environ.get("IMPLANTPLAN_WEIGHTS_URL")
            or f"https://huggingface.co/{hf['repo']}/resolve/{hf['revision']}").rstrip("/")
    print(f"weights:     {base}")
    for f in hf["files"]:
        url = f"{base}/{f['path']}"
        fetch(url, dest / f["path"], f["sha256"], f.get("bytes"))

    if args.toothseg:
        z = m["toothseg"]
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
    print("\ndone. The worker reports what it found at start-up "
          "(GET /v1/models, or its log).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
