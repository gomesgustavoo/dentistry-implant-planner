#!/usr/bin/env python
"""Publish a held-out case as a site example, through the PRODUCTION path.

The examples are the product's shop window, and the honest way to build one is to run
the real pipeline on a real scan rather than to assemble artifacts by hand. So this
enqueues an ordinary job -- same row, same worker, same board, same artifact set -- and
only afterwards marks it as an example and, optionally, attaches the measured-accuracy
block.

Two rules carried forward from the August provenance archaeology, when a published
example's model could not be read off the artifact and recovering it cost an afternoon
of matching volumes across every eval run:

* the FULL prediction identity is recorded, never a basename;
* the accuracy block is **recomputed in merged space from the published voxels**, never
  crosswalked out of an eval run's `metrics.json`. The published file went through the
  component filter and the board; a `pred/` variant did not. And the merged canal's HD95,
  NSD and directed error are simply not derivable from the two Task-1 sides.

The identity that proves the recomputation is right: the merged union Dice must equal the
voxel-weighted mean of ToothFairy3's two canal sides,
`(d3(g3+p3) + d4(g4+p4)) / (g3+p3+g4+p4)`. It matched to delta 0 last time.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))


def _env():
    root = Path(__file__).resolve().parent.parent
    for line in (root / ".worker.env").read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            os.environ.setdefault(k, v)


def enqueue(image: Path, title: str, attribution: str) -> str:
    from sqlalchemy import text

    from dentistry import db, storage

    job_id = str(uuid.uuid4())
    tenant = None
    with db.SessionLocal() as s:
        tid = db.system_tenant(s, "examples") or db.system_tenant(s, "system")
        tenant = tid
    storage.ensure_tenant(tenant)
    up = storage.job_dir(tenant, "uploads", job_id)
    up.mkdir(parents=True, exist_ok=True)
    dest = up / image.name
    # CORRECT THE HEADER BEFORE UPLOADING, not after predicting.
    #
    # A raw ToothFairy3 volume DECLARES LPS and STORES RPI. The worker trusts declared
    # headers -- correctly, because a real clinical upload's header is honest -- so
    # handing it a raw TF3 file makes it canonicalise by a declaration that is wrong on
    # two axes, and every laterally-paired structure comes out mirrored.
    #
    # It is invisible from inside: the pipeline is self-consistent in the wrong frame, so
    # `quality._check_laterality` reports nothing and the segmentation looks perfect. It
    # showed up only against ground truth, where the predicted LEFT maxillary sinus
    # overlapped the annotated RIGHT one by 113 906 voxels and the case scored 0.1276.
    #
    # `scripts/tf3_predict.py --raw-header tf3` does the same thing for the same reason.
    import SimpleITK as _sitk
    from dentistry import toothfairy3 as _tf3
    _img = _sitk.ReadImage(str(image))
    _fixed = _tf3.fix_raw_header(_img)
    if _fixed.GetDirection() != _img.GetDirection():
        print("  header corrected: this file declared "
              f"{_sitk.DICOMOrientImageFilter.GetOrientationFromDirectionCosines(_img.GetDirection())}"
              " and stores RPI")
    _sitk.WriteImage(_fixed, str(dest), True)

    with db.SessionLocal() as s:
        s.execute(text(
            "INSERT INTO jobs (id, state, stage, progress, filename, input_kind, "
            "bytes_in, attempts, title, attribution, tenant_id, is_example) "
            "VALUES (:i, 'queued', 'queued', 0, :f, 'nifti', :b, 0, :t, :a, :tn, 0)"),
            {"i": job_id, "f": image.name, "b": dest.stat().st_size,
             "t": title, "a": attribution, "tn": tenant})
        s.commit()
    print(f"queued {job_id[:8]}  {image.name}  tenant={tenant}")
    return job_id


def wait(job_id: str, timeout_s: int = 3600) -> dict:
    from sqlalchemy import text

    from dentistry import db

    t0 = time.monotonic()
    last = None
    while time.monotonic() - t0 < timeout_s:
        with db.SessionLocal() as s:
            r = s.execute(text("SELECT state, stage, progress, error FROM jobs "
                               "WHERE id = :i"), {"i": job_id}).mappings().first()
        if r is None:
            raise SystemExit("the job row vanished")
        key = (r["state"], r["stage"])
        if key != last:
            print(f"  {r['state']:8} {r['stage'] or '':38} {int((r['progress'] or 0) * 100):3}%",
                  flush=True)
            last = key
        if r["state"] in ("done", "failed", "cancelled"):
            if r["state"] != "done":
                raise SystemExit(f"job {r['state']}: {r['error']}")
            return dict(r)
        time.sleep(5)
    raise SystemExit("timed out waiting for the worker")


def attach_accuracy(job_id: str, gt: Path, case: str, dataset: str, pred_id: str) -> dict:
    """Recompute accuracy in MERGED space from the published segmentation."""
    import numpy as np
    import SimpleITK as sitk
    from sqlalchemy import text

    from dentistry import crosswalk, db, metrics, storage
    from dentistry import toothfairy3 as tf3d
    from worker import orient

    with db.SessionLocal() as s:
        row = s.execute(text("SELECT tenant_id FROM jobs WHERE id = :i"),
                        {"i": job_id}).mappings().first()
    results = storage.resolve(row["tenant_id"], "results", job_id)
    seg_path = next(results.glob("segmentation*.nii.gz"), None)
    if seg_path is None:
        raise SystemExit(f"no segmentation under {results}")

    pred_img = sitk.ReadImage(str(seg_path))
    # The same correction the upload got: the prediction now lives in an honestly
    # declared frame, so the annotation must too. BOTH sides or NEITHER -- correcting
    # one of them is what produced 0.1276 with 42 classes matched and none missed,
    # which is what a pure mirror looks like.
    gt_img = tf3d.fix_raw_header(sitk.ReadImage(str(gt)))
    # BOTH sides get the same treatment, and here that means NEITHER is header-corrected.
    #
    # The worker wrote this segmentation back onto the frame the INPUT file declared, and
    # the input was a raw ToothFairy3 volume -- which declares LPS while storing RPI. The
    # model was trained on files carrying that same defect, so the whole pipeline is
    # self-consistent in it. Correcting only the ground truth then flips one side of the
    # comparison and nothing else: the first run of this scored **0.0712** with 42
    # classes matched and none missed, which is what a pure mirror looks like.
    #
    # `fix_raw_header` is for reading TF3 volumes into a frame that means something
    # geometrically. It is exactly wrong for comparing two volumes that already share a
    # frame, however wrong that frame's declaration is.
    if pred_img.GetDirection() != gt_img.GetDirection():
        raise SystemExit(
            "the prediction and the annotation declare different orientations; they must "
            "share a frame before either is canonicalised")
    pred_c, _ = orient.to_canonical(pred_img)
    gt_c, _ = orient.to_canonical(gt_img)
    pred = sitk.GetArrayFromImage(pred_c)
    gtv = sitk.GetArrayFromImage(gt_c)
    if pred.shape != gtv.shape:
        raise SystemExit(f"shape mismatch: prediction {pred.shape} vs truth {gtv.shape}")

    classes = crosswalk.SPACES["merged-vs-tf3-full"]()
    spacing = tuple(reversed(pred_c.GetSpacing()))
    scores = metrics.score_comparison(gtv, pred, spacing, classes)
    agg = metrics.aggregate(scores)

    import hashlib
    block = {
        "reference": {"case": case, "dataset": dataset,
                      "annotation_sha256": hashlib.sha256(gt.read_bytes()).hexdigest(),
                      "prediction": pred_id},
        "protocol": {"name": "strict", "tolerance_mm": 1.0,
                     "n_classes": len(classes), "space": "merged-vs-tf3-full"},
        "aggregate": agg,
        "structures": [{**sc.as_dict(), "index": sc.label, "id": c.name}
                       for sc, c in zip(scores, classes)],
    }
    with db.SessionLocal() as s:
        s.execute(text("UPDATE jobs SET reports = jsonb_set(reports, '{accuracy}', "
                       "CAST(:a AS jsonb)), is_example = 1, updated_at = now() "
                       "WHERE id = :i"),
                  {"a": json.dumps(block, default=float), "i": job_id})
        s.commit()
    return agg


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--image", type=Path)
    ap.add_argument("--ground-truth", type=Path)
    ap.add_argument("--case", default=None)
    ap.add_argument("--dataset", default="ToothFairy3")
    ap.add_argument("--title", default=None)
    ap.add_argument("--attribution",
                    default="ToothFairy3 (CC BY-NC-SA), held out of training")
    ap.add_argument("--timeout", type=int, default=3600)
    ap.add_argument("--attach-only", metavar="JOB_ID",
                    help="recompute accuracy for a job already processed")
    args = ap.parse_args()

    _env()
    case = args.case or args.image.name.replace("_0000.nii.gz", "").replace(".nii.gz", "")
    if args.attach_only:
        from dentistry.config import Settings
        st = Settings()
        pred_id = (f"{st.TOOTHFAIRY3_DIR}/fold_{st.TF3_FOLD}/{st.TF3_CHECKPOINT}"
                   f" + board[{st.TF3_BOARD}] via worker.pipeline.segment_task1")
        agg = attach_accuracy(args.attach_only, args.ground_truth, case,
                              args.dataset, pred_id)
        print(f"accuracy: mean Dice {agg['mean_dice']:.4f}  "
              f"HD95 {agg['mean_hd95']:.2f} mm  {agg['classes_scored']} scored, "
              f"{agg['classes_missed']} missed, {agg['classes_spurious']} spurious")
        return 0
    title = args.title or f"{case} — held-out example"
    job_id = enqueue(args.image, title, args.attribution)
    wait(job_id, args.timeout)
    print(f"done: {job_id}")

    if args.ground_truth:
        from dentistry.config import Settings
        st = Settings()
        pred_id = (f"{st.TOOTHFAIRY3_DIR}/fold_{st.TF3_FOLD}/{st.TF3_CHECKPOINT}"
                   f" + board[{st.TF3_BOARD}] via worker.pipeline.segment_task1")
        agg = attach_accuracy(job_id, args.ground_truth, case, args.dataset, pred_id)
        print(f"accuracy: mean Dice {agg['mean_dice']:.4f}  HD95 {agg['mean_hd95']:.2f} mm  "
              f"{agg['classes_scored']} scored, {agg['classes_missed']} missed, "
              f"{agg['classes_spurious']} spurious")
    else:
        from sqlalchemy import text
        from dentistry import db
        with db.SessionLocal() as s:
            s.execute(text("UPDATE jobs SET is_example = 1 WHERE id = :i"), {"i": job_id})
            s.commit()
        print("published as an example (no accuracy block: no ground truth given)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
