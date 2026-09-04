"""The second composition pass: soft tissue, the airway, the orbit, the great vessels.

Runs AFTER the crosswalk, in merged id space, and is separated from `worker/board.py` by
more than convenience. That board fuses opinions about the SAME structures in ToothFairy3
Task-1 ids, where two models can disagree about a tooth and one has to win. This one adds
structures nothing else draws, in a space that starts above everything measured, under a
rule that makes disagreement impossible:

    merged_before != 0  =>  merged_after == merged_before

The extended pass paints only into background. It cannot overwrite a jaw, a tooth, a
canal or a sinus, so switching a soft-tissue model on cannot move a single clearance,
verdict or error budget. `assert_dental_unchanged` proves it per case rather than
promising it here, and it is cheap: one `!=` over the volume.

## The honest problem, and the probe that answers it

These weights are trained on CT in Hounsfield units. The input is CBCT, whose grey values
are uncalibrated and whose miscalibration axis is gain rather than offset. Their plans
declare `CTNormalization`, so `tf3`'s intensity calibration runs -- but a mapping is not a
guarantee, and whether a CT-trained network transfers to a particular CBCT is a question
about that scan, not about the model.

So it is measured, per case, before anything is drawn. `models/totalseg_craniofacial`
(`Dataset115_mandible`, already on disk, same vendor, same CT training distribution) is
run on the same calibrated volume and its MANDIBLE is scored against ours -- a structure
we segment at Dice 0.9401 on a 20-case holdout and can therefore treat as a reference
here. That single number says whether this family of models found anatomy in this scan at
all.

Below the pre-committed threshold the extended structures are **withheld, with the
measured value and the reason recorded in the report**. Not degraded, not shown with a
caveat: withheld. It is the same posture `plan_safety` takes when it refuses a verdict,
and it is the whole reason this is worth shipping -- a tongue drawn confidently in the
wrong place on a scan the model could not read is worse than no tongue.

The threshold and the argument for it are in `eval/extended.md`, written before the
number was measured.
"""
from __future__ import annotations

import logging
import time
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

log = logging.getLogger(__name__)

# The pre-committed gate. See `eval/extended.md` -- written BEFORE this was measured on
# any case, which is the only thing that makes a threshold evidence rather than a fit.
#
# 0.80 against our own mandible, not against ground truth. Our mandible scores 0.9401 on
# the holdout, so a craniofacial run agreeing with it at 0.80 has found the same bone;
# one at 0.3 has found something else, and nothing else it drew on that scan is worth
# showing. The number is deliberately well below our own 0.9401 -- the two models have
# different boundary conventions for the condyle and the coronoid, and this is a transfer
# probe, not a competition.
TRANSFER_GATE_DICE = 0.80
PROBE_MODEL_KEY = "craniofacial-probe"
PROBE_LABEL = "mandible"


@dataclass
class ExtendedRun:
    key: str
    name: str
    mode: str
    seconds: float = 0.0
    wait_seconds: float = 0.0
    voxels: int = 0
    structures: list = field(default_factory=list)
    skipped: str | None = None


def _dice(a: np.ndarray, b: np.ndarray) -> float:
    """Dice between two boolean volumes. 0.0 when both are empty is WRONG here -- two
    empty masks agree perfectly and that is a meaningless agreement, so it returns 0 and
    the caller reads it as a failed probe."""
    inter = int(np.count_nonzero(a & b))
    total = int(np.count_nonzero(a)) + int(np.count_nonzero(b))
    if total == 0:
        return 0.0
    return 2.0 * inter / total


def transfer_probe(image, merged: np.ndarray, settings, *, use_lock: bool) -> dict:
    """Does the CT-trained family find anatomy in this CBCT? Returns a report block.

    Never raises. A probe that cannot run is a probe that did not pass -- the caller
    withholds on `ok: False` either way, and an exception here must not cost the user
    their segmentation.
    """
    from dentistry import labels as L
    from worker import tf3

    out: dict = {"model": PROBE_MODEL_KEY, "gate": TRANSFER_GATE_DICE,
                 "reference": "our mandible", "ok": False}
    name = (getattr(settings, "TF3_CRANIOFACIAL_DIR", "") or "").strip()
    if not name:
        out["reason"] = ("TF3_CRANIOFACIAL_DIR is not set, so the CBCT transfer probe "
                         "cannot run and the extended structures are withheld")
        return out

    model_dir = Path(settings.MODEL_STORE) / name
    ours = merged == L.MERGED_MANDIBLE
    if not ours.any():
        out["reason"] = ("this scan has no mandible in our own segmentation, so there is "
                         "nothing to probe the CT-trained models against")
        return out

    t0 = time.monotonic()
    try:
        theirs_idx = _label_index(model_dir, PROBE_LABEL)
        pred = _run_whole_volume(
            model_dir,
            fold=str(getattr(settings, "TF3_CRANIOFACIAL_FOLD", "0") or "0"),
            checkpoint=str(getattr(settings, "TF3_CRANIOFACIAL_CHECKPOINT",
                                   "checkpoint_final.pth") or "checkpoint_final.pth"),
            image=image, target_shape=ours.shape, settings=settings, use_lock=use_lock)
        theirs = pred == theirs_idx
        out["dice"] = round(_dice(ours, theirs), 4)
        out["ok"] = out["dice"] >= TRANSFER_GATE_DICE
        if not out["ok"]:
            out["reason"] = (
                f"the CT-trained probe agrees with our mandible at Dice {out['dice']:.3f}, "
                f"below the pre-committed {TRANSFER_GATE_DICE:.2f}. Its family of models "
                f"did not transfer to this scan, so nothing they drew is shown.")
    except Exception as exc:  # noqa: BLE001
        log.exception("the CBCT transfer probe failed")
        out["reason"] = (f"the transfer probe raised {type(exc).__name__}: {exc}. "
                         f"A probe that cannot run has not passed.")
    out["seconds"] = round(time.monotonic() - t0, 2)
    return out


def _label_index(model_dir: Path, wanted: str) -> int:
    """The integer a model gives one anatomical name, from its OWN dataset.json.

    By name, never by a number written down here. A vendor renumbering its classes
    between releases is the failure `crosswalk` exists to refuse, and this refuses it the
    same way.
    """
    import json

    labels = json.loads((model_dir / "dataset.json").read_text()).get("labels", {})
    if wanted not in labels:
        raise KeyError(f"{model_dir.name}/dataset.json has no label {wanted!r}; "
                       f"it has {sorted(labels)[:8]}...")
    return int(labels[wanted])


def assert_dental_unchanged(before: np.ndarray, after: np.ndarray) -> None:
    """THE INVARIANT. The extended pass may only paint into background.

    Raises rather than warns. A soft-tissue model that has moved a canal voxel has
    invalidated every clearance in the report, and continuing would publish measurements
    computed against one mask and displayed over another.
    """
    touched = (before != 0) & (after != before)
    n = int(np.count_nonzero(touched))
    if n:
        ids = np.unique(before[touched])[:8].tolist()
        raise AssertionError(
            f"the extended pass overwrote {n} voxel(s) of the dental taxonomy "
            f"(merged ids {ids}). It may only paint into background: the 47 dental "
            f"structures carry every published measurement.")


def compose(merged: np.ndarray, image, settings, config: dict | None, *,
            use_lock: bool, probe: dict,
            spacing_zyx=None) -> tuple[np.ndarray, list[ExtendedRun], dict]:
    """Run the opted-in extended models and paste what they draw into background.

    Returns `(merged, runs, report)`. `merged` is modified IN PLACE and also returned, so
    a caller that ignores the return value still gets the right answer -- the pattern
    `board.compose` already uses.
    """
    from dentistry import extended as EX
    from dentistry import models as M
    from worker import tf3

    runs: list[ExtendedRun] = []
    report: dict = {"probe": probe, "gate": TRANSFER_GATE_DICE, "applied": [],
                    "withheld": [], "structures": 0}

    wanted = [(k, m) for k, m in (config or {}).items()
              if k in M.BY_KEY and M.BY_KEY[k].space == "extended" and m != "off"]
    if not wanted:
        return merged, runs, report

    if not probe.get("ok"):
        # WITHHELD, not degraded. Every requested model is named in the report with the
        # measured probe value beside it, so a reader can see what was asked for, what it
        # would have drawn, and exactly why it is not on screen.
        for key, mode in wanted:
            entry = M.BY_KEY[key]
            runs.append(ExtendedRun(key=key, name=entry.name, mode=mode,
                                    skipped=probe.get("reason", "the transfer probe did not pass")))
            report["withheld"].append({"model": key, "name": entry.name,
                                       "reason": probe.get("reason", "")})
        return merged, runs, report

    before = merged.copy()
    for key, mode in sorted(wanted, key=lambda kv: M.BY_KEY[kv[0]].order):
        entry = M.BY_KEY[key]
        name = (getattr(settings, entry.dir_setting, "") or "").strip()
        if not name:
            runs.append(ExtendedRun(key=key, name=entry.name, mode=mode,
                                    skipped=f"{entry.dir_setting} is not set on this worker"))
            continue
        model_dir = Path(settings.MODEL_STORE) / name
        want = EX.label_map(key)
        t0 = time.monotonic()
        try:
            lut = _lut_for(model_dir, want)
            pred = _run_whole_volume(
                model_dir,
                fold=str(getattr(settings, entry.fold_setting, "0") or "0"),
                checkpoint=str(getattr(settings, entry.checkpoint_setting,
                                       "checkpoint_final.pth") or "checkpoint_final.pth"),
                image=image, target_shape=merged.shape, settings=settings,
                use_lock=use_lock)
            mapped = lut[np.clip(pred, 0, len(lut) - 1)]
        except Exception as exc:  # noqa: BLE001
            # One extended model failing costs its own structures and nothing else. The
            # dental segmentation is already complete and published by this point.
            log.exception("extended model %s failed", key)
            runs.append(ExtendedRun(key=key, name=entry.name, mode=mode,
                                    skipped=f"{type(exc).__name__}: {exc}"))
            report["withheld"].append({"model": key, "name": entry.name,
                                       "reason": f"{type(exc).__name__}: {exc}"})
            continue

        if mode == "shadow":
            runs.append(ExtendedRun(key=key, name=entry.name, mode=mode,
                                    seconds=round(time.monotonic() - t0, 2),
                                    voxels=int(np.count_nonzero(mapped)),
                                    skipped="shadow: recorded, nothing stamped"))
            continue

        # BACKGROUND ONLY. This single `where` is the invariant, and the assertion below
        # is what proves it stayed true rather than trusting the expression.
        paste = (mapped > 0) & (merged == 0)
        np.copyto(merged, mapped, where=paste)
        drew = sorted({int(v) for v in np.unique(mapped[paste])} - {0})
        runs.append(ExtendedRun(key=key, name=entry.name, mode=mode,
                                seconds=round(time.monotonic() - t0, 2),
                                voxels=int(np.count_nonzero(paste)),
                                structures=drew))
        report["applied"].append({"model": key, "name": entry.name,
                                  "structures": len(drew),
                                  "voxels": int(np.count_nonzero(paste))})
        report["structures"] += len(drew)

    # THE PER-STRUCTURE GATE. Everything drawn is now judged on its own shape, and what
    # fails is REMOVED with a stated reason. Running it after the whole board rather than
    # per model is deliberate: the left/right test needs both sides, and two of the three
    # models draw paired structures the other does not.
    drew_all = sorted({int(v) for r in runs for v in r.structures})
    if drew_all and spacing_zyx is not None:
        gate = plausibility_gate(merged, spacing_zyx, drew_all)
        from dentistry import extended as EX
        dropped = []
        for sid, row in gate.items():
            if row["ok"]:
                continue
            idx = EX.BY_ID[sid].index
            merged[merged == idx] = 0
            dropped.append({"id": sid, "name": EX.BY_ID[sid].name,
                            "reason": row["reason"], "cm3": row["cm3"],
                            "truncated": row["truncated"]})
        report["plausibility"] = gate
        report["dropped"] = dropped
        kept = [s for s, r in gate.items() if r["ok"]]
        report["structures"] = len(kept)
        report["kept"] = kept
        for r in runs:
            r.structures = [i for i in r.structures
                            if EX.BY_INDEX[int(i)].id in set(kept)]

    assert_dental_unchanged(before, merged)
    return merged, runs, report


def plausibility_gate(merged: np.ndarray, spacing_zyx, drew: list[int]) -> dict:
    """Per structure: is what was drawn shaped like the thing it is named after?

    THE SECOND GATE, and the one that matters. The craniofacial probe passes on real
    dental CBCT -- 0.85 and 0.82 against our own mandible -- and on those same cases the
    tongue came out at 1.76 cm3 against an anatomical 70-100, one masseter was found and
    the other was not inside a field of view containing both, and the oropharynx arrived
    in 155 connected components. The probe was measuring the wrong tissue: a mandible is
    dense cortical bone, which is the one thing cone-beam CT images well, and soft tissue
    is what it images worst. Bone transferring says nothing about muscle.

    So every structure is judged on its own: volume against an adult anatomical band,
    mass in its largest connected component, and left/right agreement. A structure that
    fails is REMOVED from the volume with a stated reason -- not dimmed, not flagged.

    TRUNCATION IS NOT FAILURE. A 123 mm dental field of view genuinely cuts the orbit,
    the larynx and half the parotid, so a structure below its band whose mask reaches the
    scan edge is reported as cut rather than as wrong, and is also removed -- a third of a
    parotid drawn as a whole one is a worse picture than no parotid.
    """
    from dentistry import extended as EX
    from dentistry import quality
    from scipy import ndimage

    vox_cm3 = float(np.prod(spacing_zyx)) / 1000.0
    trunc = quality.truncation(merged)
    rows: dict[str, dict] = {}
    for idx in drew:
        e = EX.BY_INDEX.get(int(idx))
        if e is None:
            continue
        m = merged == idx
        n = int(np.count_nonzero(m))
        cm3 = n * vox_cm3
        lab, ncomp = ndimage.label(m)
        sizes = np.bincount(lab.ravel())[1:]
        largest = float(sizes.max() / sizes.sum()) if len(sizes) else 0.0
        lo, hi = EX.PLAUSIBLE_CM3.get(e.id, (0.0, 1e9))
        cut = bool((trunc.get(e.id) or {}).get("truncated"))
        row = {"cm3": round(cm3, 3), "components": int(ncomp),
               "largest_fraction": round(largest, 4), "band": [lo, hi],
               "truncated": cut, "ok": True, "reason": None}
        if cm3 < lo:
            row["ok"] = False
            row["reason"] = (f"cut by the field of view ({cm3:.2f} cm3 of an expected "
                             f"{lo:.0f}-{hi:.0f})" if cut else
                             f"{cm3:.2f} cm3, below the plausible {lo:.0f}-{hi:.0f} cm3 "
                             f"and not cut by the scan edge")
        elif cm3 > hi:
            row["ok"] = False
            row["reason"] = f"{cm3:.2f} cm3, above the plausible {lo:.0f}-{hi:.0f} cm3"
        elif largest < EX.MIN_LARGEST_FRACTION:
            row["ok"] = False
            row["reason"] = (f"{ncomp} disconnected pieces with only "
                             f"{largest:.0%} in the largest; this structure is one object")
        rows[e.id] = row

    # Left/right, and ONLY where neither side was cut. A dental field of view routinely
    # takes one side of a neck structure and not the other, and that is asymmetry of the
    # scan rather than of the patient.
    for e in EX.EXTENDED:
        if not e.id.endswith("_right"):
            continue
        other = e.id[:-6] + "_left"
        a, b = rows.get(e.id), rows.get(other)
        if not a or not b or not a["ok"] or not b["ok"]:
            continue
        if a["truncated"] or b["truncated"]:
            continue
        ratio = max(a["cm3"], b["cm3"]) / max(min(a["cm3"], b["cm3"]), 1e-6)
        a["lr_ratio"] = b["lr_ratio"] = round(ratio, 2)
        if ratio > EX.MAX_LR_RATIO:
            for r in (a, b):
                r["ok"] = False
                r["reason"] = (f"the left and right volumes differ by {ratio:.1f}x with "
                               f"neither side cut by the scan; a paired structure that "
                               f"asymmetric is not believed")
    return rows


def _run_whole_volume(model_dir: Path, *, fold: str, checkpoint: str, image,
                      target_shape, settings, use_lock: bool) -> np.ndarray:
    """One CT-trained model over the WHOLE volume, back on the caller's grid.

    Goes through `tf3.preprocess` / `tf3.segment` / `tf3.to_canonical` rather than
    calling `predict_single_npy_array` directly, and that is not tidiness. `board.compose`
    can call the predictor directly because every specialist it runs is confined to an ROI
    box a few centimetres across; these are whole-head models with no box, and the direct
    path allocates the logit array from the input shape with no budget. On this machine
    that is the documented 14.3 GB / swap-exhausted condition -- `config.MAX_LOGIT_GIB`
    exists for exactly this and `tf3.segment` is what honours it, tiling along z when one
    sweep will not fit.

    `calibrate_intensity=True` unconditionally: every model that reaches here declares
    `CTNormalization` in its plans, which is the whole reason a CBCT needs mapping onto
    the training scale first.
    """
    from worker import tf3

    predictor = tf3.build_predictor(model_dir, fold, checkpoint,
                                    tile_step=settings.TILE_STEP_SIZE_TF3,
                                    mirroring=False)
    # These checkpoints are `nnUNetTrainer_DASegOrd0_NoMirroring`, so there is nothing to
    # clamp -- but the clamp is stated anyway rather than relied upon, because the axis-2
    # trap is silent when it fires and a future weight release is not bound by this one.
    predictor.allowed_mirroring_axes = ()

    n_classes = _n_classes(model_dir)
    pre = tf3.preprocess(image, predictor, calibrate_intensity=True)
    with tf3.borrowed_gpu(predictor, use_lock):
        seg_plan, _rep = tf3.segment(predictor, pre, n_classes,
                                     settings.MAX_LOGIT_GIB)
    out = tf3.to_canonical(seg_plan, pre, image)
    if tuple(out.shape) != tuple(target_shape):
        raise ValueError(f"{model_dir.name} returned {out.shape}, expected {target_shape}")
    return np.asarray(out)


def _n_classes(model_dir: Path) -> int:
    """Foreground + background, from the model's own dataset.json. Feeds the logit
    budget, so guessing it would mis-size the tiling."""
    import json

    labels = json.loads((model_dir / "dataset.json").read_text()).get("labels", {})
    return max(int(v) for v in labels.values()) + 1


def _lut_for(model_dir: Path, want: dict[str, int]) -> np.ndarray:
    """`model id -> merged index`, derived from the model's own `dataset.json`.

    Every name in `want` must resolve. A model whose labels no longer carry a name this
    taxonomy expects has become a different model, and mapping what is left would publish
    a structure under the wrong name -- the failure mode `crosswalk._lut_from_names`
    exists to refuse, refused here the same way.
    """
    import json

    labels = json.loads((model_dir / "dataset.json").read_text()).get("labels", {})
    missing = [n for n in want if n not in labels]
    if missing:
        raise KeyError(f"{model_dir.name}/dataset.json is missing {missing}; "
                       f"this is not the model the taxonomy was written against")
    size = max(int(v) for v in labels.values()) + 1
    lut = np.zeros(max(size, 1), dtype=np.uint8)
    for source_name, merged_index in want.items():
        lut[int(labels[source_name])] = merged_index
    return lut
