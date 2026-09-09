#!/usr/bin/env python
"""Rank scans by how well they would showcase implant planning.

WHY THIS EXISTS. The first trailer was shot on a full-dentition case and planned into
FDI 38 -- a socket that still had a tooth in it. The app said so on screen, in the card:
"tooth 38 is still present in this scan, so this may be the distance to the tooth being
replaced rather than to a neighbour". That is an extraction site, not an implant site,
and it is the wrong thing to put in a film about implant planning.

WHAT NOT TO USE. ToothFairy3's ground truth is **partially annotated** -- teeth are
labelled in 27-92% of cases depending on the class -- so an unlabelled tooth in the GT
means "nobody drew it", not "the patient does not have it". Ranking on GT absence puts
every case in the list with the same four teeth missing, which is a property of the
annotation protocol and not of any patient. `eval/COMPARISON.md` keeps `Dice-GT` and
`Dice-scored` apart for the same reason.

So this reads PREDICTIONS. What the model draws on a scan is what the app will show, and
the app's own "absent at that position" finding is computed the same way.

A site is worth filming when:
  * it is genuinely edentulous -- no predicted tooth at that FDI position;
  * it is in the POSTERIOR MANDIBLE (34-37, 44-47), which is where the inferior alveolar
    canal runs and therefore where a clearance verdict means anything;
  * at least one neighbour is present, so the gap reads as a gap on screen rather than as
    an empty jaw, and the adjacent-tooth measurement has something to measure.

Bone height is NOT decided here -- it comes from `ridge.py` in the full pipeline. This
narrows 20 cases to a shortlist worth paying the pipeline for.
"""
from __future__ import annotations

import argparse
import glob
import os
import sys
from pathlib import Path

import nibabel as nib
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from dentistry import toothfairy3 as tf3  # noqa: E402

# Task-1 ids are NOT FDI codes -- id 33 is FDI 37, id 45 is the lingual canal, id 46 is
# pulp. Reading them as FDI reports canals as missing teeth in every case.
TASK1_TO_FDI = tf3.TASK1_INDEX_TO_FDI

LOWER = [48, 47, 46, 45, 44, 43, 42, 41, 31, 32, 33, 34, 35, 36, 37, 38]
UPPER = [18, 17, 16, 15, 14, 13, 12, 11, 21, 22, 23, 24, 25, 26, 27, 28]
POSTERIOR_MAND = [34, 35, 36, 37, 44, 45, 46, 47]
NAME = {1: "central incisor", 2: "lateral incisor", 3: "canine", 4: "1st premolar",
        5: "2nd premolar", 6: "1st molar", 7: "2nd molar", 8: "3rd molar"}
# a tooth needs this many voxels to count as drawn; below it is a speck, not a tooth
MIN_VOXELS = 200
# Task-1 id 1 is "Lower Jawbone" -- read off the dataset's own label names, not guessed.
MANDIBLE_ID = 1
# A lower crown stands roughly 7-8 mm above the alveolar crest. Ask for 6 mm of scan
# above the ridge before believing a missing tooth is missing rather than cropped.
MIN_HEADROOM_MM = 6.0


def neighbours(fdi: int) -> list[int]:
    quadrant, position = divmod(fdi, 10)
    out = []
    if position > 1:
        out.append(quadrant * 10 + position - 1)
    if position < 8:
        out.append(quadrant * 10 + position + 1)
    return out


def _superior_mm(affine: np.ndarray, idx: np.ndarray) -> np.ndarray:
    """World superior-inferior coordinate for voxel indices. nibabel's affine maps to
    RAS, so a LARGER value is more superior regardless of how the file stores its axes --
    which matters here because ToothFairy3 is RPI and its third index runs downwards."""
    return (affine[2, 0] * idx[0] + affine[2, 1] * idx[1]
            + affine[2, 2] * idx[2] + affine[2, 3])


def headroom_mm(arr, affine, mandible_id: int, centre_ij, radius_vox: float) -> float | None:
    """How much scan there is ABOVE the alveolar crest at a site, in mm.

    THE DISTINCTION THIS EXISTS FOR. Most ToothFairy3 scans are ~51 mm tall, so a tooth
    that is not predicted is very often a tooth the field of view never covered -- not a
    tooth the patient is missing. Ranking on "no tooth predicted" alone puts cropped scans
    at the top of the list, which is how you end up filming an implant in a site that is
    simply off-camera.

    So: find the highest mandible voxel in a column around the site, and measure from
    there to the top of the reconstructed volume. Plenty of headroom means a crown would
    have been in frame, and its absence is real. No headroom means the scan stops at the
    ridge and the question cannot be answered from this image.
    """
    i0, j0 = centre_ij
    ii, jj = np.meshgrid(np.arange(arr.shape[0]), np.arange(arr.shape[1]), indexing="ij")
    col = ((ii - i0) ** 2 + (jj - j0) ** 2) <= radius_vox ** 2
    sub = arr[col]                                   # (n_columns, n_slices)
    hits = np.argwhere(sub == mandible_id)
    if hits.size == 0:
        return None
    cols = np.argwhere(col)
    # most superior mandible voxel in the column
    best, best_s = None, -1e9
    for n, k in hits:
        i, j = cols[n]
        s = _superior_mm(affine, np.array([i, j, k]))
        if s > best_s:
            best_s, best = s, (i, j, k)
    # the most superior voxel the volume has at all, along that same column
    tops = [_superior_mm(affine, np.array([best[0], best[1], k]))
            for k in (0, arr.shape[2] - 1)]
    return float(max(tops) - best_s)


def survey(path: str) -> dict:
    img = nib.load(path)
    arr = np.asanyarray(img.dataobj)
    ids, counts = np.unique(arr, return_counts=True)
    vox = dict(zip(ids.tolist(), counts.tolist()))
    present = {fdi for idx, fdi in TASK1_TO_FDI.items() if vox.get(idx, 0) >= MIN_VOXELS}
    spacing = img.header.get_zooms()[:3]
    fov = [round(float(n * s), 1) for n, s in zip(arr.shape, spacing)]

    fdi_to_task1 = {v: k for k, v in TASK1_TO_FDI.items()}
    affine = img.affine
    mand_id = MANDIBLE_ID

    def centroid_ij(fdi: int):
        tid = fdi_to_task1[fdi]
        hits = np.argwhere(arr == tid)
        if hits.size == 0:
            return None
        return hits[:, 0].mean(), hits[:, 1].mean()

    gaps = []
    for fdi in POSTERIOR_MAND:
        if fdi in present:
            continue
        near = [n for n in neighbours(fdi) if n in present]
        # the site sits between its neighbours; with both, that midpoint is a good
        # estimate. With one, fall back to that neighbour and widen the column.
        cents = [c for c in (centroid_ij(n) for n in near) if c is not None]
        head = None
        if cents:
            ci = sum(c[0] for c in cents) / len(cents)
            cj = sum(c[1] for c in cents) / len(cents)
            head = headroom_mm(arr, affine, mand_id, (ci, cj),
                               radius_vox=(6.0 if len(cents) > 1 else 9.0)
                               / float(spacing[0]))
        gaps.append({
            "fdi": fdi, "name": NAME[fdi % 10], "neighbours_present": near,
            "headroom_mm": None if head is None else round(head, 1),
            # A crown needs real room above the ridge to have been imaged. Below this the
            # scan stops at the bone and "no tooth" is unanswerable from this image.
            "in_frame": bool(head is not None and head >= MIN_HEADROOM_MM),
        })
    # canal ids 3 and 4 are the two inferior alveolar canals
    canal_vox = vox.get(3, 0) + vox.get(4, 0)
    real = [g for g in gaps if g["in_frame"] and g["neighbours_present"]]
    return {
        "case": os.path.basename(path)[: -len(".nii.gz")],
        "fov_mm": fov,
        "teeth": len(present),
        "present": sorted(present),
        "gaps": gaps,
        "anchored_gaps": real,
        "canal_voxels": int(canal_vox),
    }


def score(r: dict) -> tuple:
    """Sort key. A gap with a neighbour beats a gap without; more teeth overall means a
    more legible arch; a bigger canal means more of it is actually in frame."""
    return (
        -len(r["anchored_gaps"]),
        -min(r["teeth"], 26),          # past ~26 teeth, extra teeth stop helping
        -r["canal_voxels"],
    )


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--preds", default="/mnt/mldata/tf3/edentulous-survey",
                    help="directory of PREDICTED Task-1 label maps")
    ap.add_argument("--top", type=int, default=6)
    a = ap.parse_args()

    files = sorted(glob.glob(os.path.join(a.preds, "*.nii.gz")))
    if not files:
        print(f"no predictions in {a.preds}")
        return 1
    rows = [survey(f) for f in files]
    rows.sort(key=score)

    print(f"{len(rows)} cases, ranked by how well they would film\n")
    for r in rows:
        mark = "  <<< FILMABLE" if r["anchored_gaps"] else ""
        print(f"{r['case']:<20} teeth {r['teeth']:>2}/32  "
              f"FOV {r['fov_mm'][0]:.0f}x{r['fov_mm'][1]:.0f}x{r['fov_mm'][2]:.0f}mm  "
              f"canal {r['canal_voxels']:>6}vox{mark}")
        for g in r["gaps"]:
            near = ", ".join(str(n) for n in g["neighbours_present"]) or "none"
            if not g["neighbours_present"]:
                why = "no neighbour in frame — cannot tell a gap from an empty jaw"
            elif g["headroom_mm"] is None:
                why = "no mandible under the site"
            elif not g["in_frame"]:
                why = (f"only {g['headroom_mm']} mm of scan above the ridge "
                       f"— CROPPED, not edentulous")
            else:
                why = f"{g['headroom_mm']} mm above the ridge — REAL GAP"
            print(f"{'':<22}FDI {g['fdi']} ({g['name']:<13}) nb {near:<7} {why}")
        if not r["gaps"]:
            print(f"{'':<22}no posterior mandibular gap")
    print("\nShortlist for the full pipeline (bone height comes from ridge.py, not here):")
    for r in rows[: a.top]:
        if r["anchored_gaps"]:
            sites = ", ".join(str(g["fdi"]) for g in r["anchored_gaps"])
            print(f"  {r['case']}  sites {sites}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
