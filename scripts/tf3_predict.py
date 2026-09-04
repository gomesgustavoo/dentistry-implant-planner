#!/usr/bin/env python
"""Predict ToothFairy3 Task-1 labels for a folder of scans, through the PRODUCTION path.

This is not a reimplementation of the worker's inference. It calls
`worker.pipeline.segment_task1` -- the same function `worker/main.py` calls -- so the
composition an evaluation grades is literally the composition the product runs. The
alternative, a script that "does the same thing", is how a published number comes to
describe a system nobody ships.

Output is Task-1 ids on the case's own grid, which is what
`scripts/eval_dice.py --space tf3-task1-raw-gt` expects, plus one `<case>.json` per case
carrying the board report and a `run.json` carrying `board.preflight()` -- the receipt
that ties an eval directory to the exact board that produced it. Recovering which model
made a published artifact by matching volumes across every eval run cost an afternoon
once; it is not being left to chance again.

Two switches worth reading before use:

  --raw-header {tf3,trust}
      ToothFairy3's raw files DECLARE LPS and STORE RPI, and `toothfairy3.fix_raw_header`
      re-declares the cosines to match the voxels. That correction is specific to that
      dataset's defect. Pointed at an honest header -- PMCanalSeg, a clinical scan -- it
      would negate two index axes and the resulting Dice would read as "our model does
      not generalize". Default `tf3` for the holdout; `trust` for anything else.

  --base-from / --save-base
      Compose onto a base prediction saved by an earlier run instead of recomputing it.
      That makes an A/B EXACT rather than approximately paired: both arms share a
      bit-identical base array, so every scored difference is attributable to the board.
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

from dentistry import toothfairy3 as tf3d  # noqa: E402
from dentistry.config import Settings  # noqa: E402
from worker import orient, pipeline  # noqa: E402


def _cases(images: Path, only: list[str] | None):
    out = []
    for p in sorted(images.glob("*.nii.gz")):
        cid = p.name.replace("_0000.nii.gz", "").replace(".nii.gz", "")
        if only and cid not in only:
            continue
        out.append((cid, p))
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--images", required=True, type=Path)
    ap.add_argument("--out", required=True, type=Path)
    ap.add_argument("--cases", type=Path, help="a JSON list of case ids to restrict to")
    ap.add_argument("--board", default=None,
                    help='board preset, e.g. "canal" or "" for the base model alone')
    ap.add_argument("--base-from", type=Path, help="compose onto bases saved here")
    ap.add_argument("--save-base", type=Path, help="write the pre-board arrays here")
    ap.add_argument("--raw-header", choices=("tf3", "trust"), default="tf3")
    ap.add_argument("--no-lock", action="store_true",
                    help="skip the shared GPU mutex (only when nothing else uses the card)")
    ap.add_argument("--limit", type=int)
    args = ap.parse_args()

    settings = Settings()
    if args.board is not None:
        settings.TF3_BOARD = args.board
    board = None if args.board is None else __import__(
        "worker.board", fromlist=["board"]).load_board(settings)

    args.out.mkdir(parents=True, exist_ok=True)
    if args.save_base:
        args.save_base.mkdir(parents=True, exist_ok=True)

    only = json.loads(args.cases.read_text()) if args.cases else None
    if isinstance(only, dict):
        only = only.get("cases") or only.get("holdout")
    cases = _cases(args.images, only)
    if args.limit:
        cases = cases[:args.limit]
    print(f"{len(cases)} case(s) -> {args.out}   board={settings.TF3_BOARD!r}  "
          f"raw-header={args.raw_header}")

    run = {"board": pipeline.__name__, "cases": [], "raw_header": args.raw_header,
           "board_preset": settings.TF3_BOARD}
    from worker import board as board_mod
    run["board_config"] = board_mod.preflight(board if board is not None
                                              else board_mod.load_board(settings))

    for n, (cid, path) in enumerate(cases, 1):
        t0 = time.monotonic()
        img = sitk.ReadImage(str(path))
        if args.raw_header == "tf3":
            img = tf3d.fix_raw_header(img)

        base = None
        if args.base_from:
            bp = args.base_from / f"{cid}.npy"
            if bp.exists():
                base = np.load(bp)

        res = pipeline.segment_task1(img, settings, use_lock=not args.no_lock,
                                     board=board, keep_base=bool(args.save_base))
        seg = res.seg
        if args.save_base and res.base is not None:
            np.save(args.save_base / f"{cid}.npy", res.base)

        # Back onto the file's own frame so eval_dice can compare it to the raw label.
        canon, code = orient.to_canonical(img)
        out_img = orient.label_image_like(seg, canon)
        sitk.WriteImage(orient.from_canonical(out_img, code),
                        str(args.out / f"{cid}.nii.gz"), True)
        (args.out / f"{cid}.json").write_text(json.dumps(res.reports, default=str))
        dt = time.monotonic() - t0
        found = int(len(np.unique(seg)) - 1)
        run["cases"].append({"id": cid, "seconds": round(dt, 1), "classes": found})
        print(f"  [{n}/{len(cases)}] {cid}  {dt:6.1f}s  {found} classes", flush=True)

    (args.out / "run.json").write_text(json.dumps(run, indent=1, default=str))
    print(f"\nwrote {len(cases)} prediction(s) and run.json")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
