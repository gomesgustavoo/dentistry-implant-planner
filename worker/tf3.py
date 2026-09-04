"""The ToothFairy3 serving path: calibrate, preprocess, segment, put back.

Reconstructed 2026-09-01. Every constant that was MEASURED rather than chosen is
quoted with its measurement, so it is not silently re-guessed later.

Three things in here are load-bearing and easy to get subtly wrong:

**The frame.** The network trained on volumes stored in RPI, which is exactly
`worker.orient.CANONICAL`, so an upload that has been canonicalised needs no
special handling at all. `canal_box`, `dental_box` and `pterygoid_box` index by
fractions or millimetre offsets of a numpy axis and mean nothing outside that
frame -- composing on an LPS-stored volume measured 0.0-0.3% containment of the
accessory canals against the 100% the box was validated at.

**The intensity scale.** CBCT grey values are not Hounsfield units. Measured
calibration gain across six real clinical scans spans 0.47x to 2.60x, and the
model normalises with `CTNormalization`, which clips against fixed training
percentiles BEFORE the affine -- so an uncorrected scan has its bone, soft tissue
and air collapsed into one end of the window and the network floods the largest
class it has. That is what a 118 cm3 mandible looked like.

**The memory.** A 47-class logit array at the original shape of a head CBCT is
33.7 GiB in fp32. Everything here is arranged so that never has to exist: the
logits are fp16, the accumulator lives in host RAM, and a volume too tall for one
pass is tiled along z with a halo.
"""
from __future__ import annotations

import contextlib
import logging
import time
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

from dentistry import toothfairy3 as TF3

log = logging.getLogger(__name__)

# nnU-Net 2.8.1 allocates the sliding-window accumulator as torch.half
# unconditionally, so the budget arithmetic is in 2-byte units. Checked against
# `predict_sliding_window_return_logits`; if a future version changes this the
# budget silently becomes a factor of two optimistic, which is why it is named.
LOGIT_BYTES = 2

TASK1_MAPPING = TF3.TASK1_MAPPING
MODEL_INPUT_ORIENTATION = TF3.MODEL_INPUT_ORIENTATION

# Task-1 ids for the 32 FDI teeth, used to anchor the field-of-view guard.
TEETH_CLASSES = np.arange(11, 43)


class TooLarge(RuntimeError):
    """One patch over this volume's plane would exceed the logit budget.

    Not a failure to be retried smaller: `plan_blocks` tiles along z ONLY, so a
    volume that is too WIDE has no affordable path through this model. That is a
    real product limitation and the message says so rather than pretending.
    """


# --------------------------------------------------------------------------- #
# Hardware                                                                     #
# --------------------------------------------------------------------------- #
_TUNED = False


def tune_for_hardware() -> dict:
    """Ampere-friendly defaults, set once per process.

    TF32 is the free one: on an RTX 3080 it roughly doubles convolution throughput
    against fp32 with an accuracy cost far below the noise floor of a segmentation
    argmax. `cudnn.benchmark` pays for itself because every forward pass in this
    pipeline uses the SAME patch size -- the autotuner runs once and every
    subsequent block reuses the plan. It would be the wrong setting for variable
    input shapes, which is why it is here and not in a library.
    """
    global _TUNED
    import torch

    if _TUNED or not torch.cuda.is_available():
        return {"tuned": _TUNED}
    torch.backends.cuda.matmul.allow_tf32 = True
    torch.backends.cudnn.allow_tf32 = True
    torch.backends.cudnn.benchmark = True
    _TUNED = True
    name = torch.cuda.get_device_name(0)
    total = torch.cuda.get_device_properties(0).total_memory / (1 << 30)
    log.info("cuda tuned: %s, %.1f GiB, tf32 on, cudnn.benchmark on", name, total)
    return {"tuned": True, "device": name, "total_gib": round(total, 1)}


# --------------------------------------------------------------------------- #
# Predictors, and keeping them warm                                            #
# --------------------------------------------------------------------------- #
_CACHE: dict[tuple, object] = {}
_CACHE_LIMIT = 3


def build_predictor(model_dir, fold: str, checkpoint: str, tile_step: float = 0.9,
                    mirroring: bool = True, on_device: bool = False, cache: bool = True):
    """A predictor for an installed model, reused across jobs when possible.

    `tile_step=0.9` follows the challenge winners: -12.9% inference time for -0.002
    Dice. Mirroring is ON and the AXES come from the checkpoint's own
    `inference_allowed_mirroring_axes`, which is (0, 1) for every model we ship.
    Axis 2 (left-right) is excluded there and must stay excluded: test-time
    augmentation averages logits without touching label ids, so mirroring it would
    average tooth 11's logit into tooth 21's position.

    `on_device=False` keeps the sliding-window accumulator in host RAM. On a 12 GB
    card the weights plus one patch already take ~5.5 GiB.

    **The cache is the multi-model optimisation.** Loading a 546 MB checkpoint costs
    seconds of disk and rebuild time, and a board that runs three models would pay
    it three times per job. Cached predictors are parked on the CPU between uses by
    `borrowed_gpu`, so a warm predictor costs host RAM and no VRAM at all.
    """
    import torch
    from nnunetv2.inference.predict_from_raw_data import nnUNetPredictor

    tune_for_hardware()
    key = (str(Path(model_dir).resolve()), fold, checkpoint, tile_step, mirroring, on_device)
    if cache and key in _CACHE:
        log.debug("predictor cache hit: %s", Path(model_dir).name)
        return _CACHE[key]

    pred = nnUNetPredictor(
        tile_step_size=tile_step,
        use_gaussian=True,
        use_mirroring=mirroring,
        perform_everything_on_device=on_device and torch.cuda.is_available(),
        device=torch.device("cuda:0" if torch.cuda.is_available() else "cpu"),
        allow_tqdm=False,
    )
    pred.initialize_from_trained_model_folder(str(model_dir), use_folds=(fold,),
                                              checkpoint_name=checkpoint)
    if cache:
        if len(_CACHE) >= _CACHE_LIMIT:
            # Evict the oldest rather than growing without bound: three warm models
            # is the whole board, and a fourth means something changed.
            old = next(iter(_CACHE))
            _CACHE.pop(old, None)
            log.info("predictor cache evicted %s", Path(old[0]).name)
        _CACHE[key] = pred
    return pred


def drop_cached_predictors() -> int:
    """Release every warm predictor. Returns how many were dropped."""
    import torch

    n = len(_CACHE)
    _CACHE.clear()
    if torch.cuda.is_available():
        torch.cuda.empty_cache()
    return n


def model_dir(settings):
    return Path(settings.MODEL_STORE) / settings.TOOTHFAIRY3_DIR


@contextlib.contextmanager
def borrowed_gpu(predictor, enabled: bool = True, on_wait=None):
    """Hold the shared GPU mutex, and hand the card back COMPLETELY.

    Releasing the advisory lock is not the same as releasing the memory, and only
    the first is automatic. nnU-Net parks the network on the device and leaves it
    there between calls, so a plain `with gpu_lock()` unlocks while still holding
    roughly 850 MB of weights. A training run resuming behind that was sized for
    the whole card and dies. That is not hypothetical: it killed the intensity run
    at epoch 126 on 2026-08-28, because the caller called `empty_cache()` and
    thought that was enough. Emptying the allocator cache frees the slack, not the
    weights. Moving the network to the host is safe -- the predictor moves it back
    on the next call.

    Per unit of work rather than per run, deliberately: this mutex also serialises
    DicomSegVR's inference and voxtell-worker, and a long batch that held it would
    stall both.
    """
    if not enabled:
        yield
        return
    import os

    if not os.environ.get("GPU_LOCK_DSN"):
        # A borrower that ASKED for the lock must not silently run without it. That
        # exact degradation OOM'd a prediction against the live trainer on
        # 2026-08-29: launched from a shell that never exported the DSN, the lock
        # no-opped, and the "locked" run went straight into an 11.2 GiB epoch.
        raise RuntimeError(
            "borrowed_gpu(enabled=True) but GPU_LOCK_DSN is unset -- source "
            "scripts/tf3_env.sh (or export the key from .worker.env) and retry")
    import torch

    from dentistry import gpu_lock

    with gpu_lock.gpu_lock(on_wait=on_wait or (lambda: log.info("waiting for the GPU ..."))):
        try:
            yield
        finally:
            try:
                if getattr(predictor, "network", None) is not None:
                    predictor.network.to("cpu")
            finally:
                if torch.cuda.is_available():
                    torch.cuda.empty_cache()


# --------------------------------------------------------------------------- #
# Intensity calibration                                                        #
# --------------------------------------------------------------------------- #
# ToothFairy3's own intensity landmarks, measured 2026-08-25 over 18 training
# volumes -- six evenly spaced from each of the F, P and S subsets:
#
#     air peak     -999 +- 1      (in every one of the 18)
#     soft peak    -43 .. +134    (median +58)
#
# The targets are the training set's own medians, so the median ToothFairy3 scan
# maps to itself exactly and the correction is near-identity on the data the model
# was trained on. They are derived, not round numbers chosen for tidiness.
AIR_TARGET = -996.0
SOFT_TARGET = 58.0
SOFT_OFFSET = 400.0        # a soft-tissue peak is searched above air + this
MIN_SOFT_VOXELS = 1000     # below this there is no second landmark to fit
GAIN_LIMITS = (0.2, 5.0)   # outside this the fit is not believable; refuse instead

# A scan whose air already sits near Hounsfield air needs no search. Testing for a
# KNOWN value before searching for an unknown one is what fixed the detector: three
# of six real scans carry an out-of-field FILL value far below their actual air
# (-4255, -3209, -2048), and taking the histogram mode read that fill as air. It
# put MG_test_scan at gain 0.30 when the truth was 0.90.
HU_AIR_BAND = (-1100.0, -900.0)


@dataclass
class Calibration:
    gain: float = 1.0
    offset: float = 0.0
    air: float | None = None
    soft: float | None = None
    air_from: str = "unknown"
    applied: bool = False
    reason: str | None = None

    def apply(self, arr: np.ndarray) -> np.ndarray:
        """In place, and a no-op when this calibration refused."""
        if not self.applied:
            return arr
        arr *= self.gain
        arr += self.offset
        return arr

    def as_report(self) -> dict:
        return {
            "applied": self.applied,
            "gain": round(float(self.gain), 4),
            "offset_hu": round(float(self.offset), 1),
            "air": None if self.air is None else round(float(self.air), 1),
            "soft_tissue": None if self.soft is None else round(float(self.soft), 1),
            "air_from": self.air_from,
            "air_target": AIR_TARGET,
            "soft_tissue_target": SOFT_TARGET,
            **({"reason": self.reason} if self.reason else {}),
        }


def _mode(values: np.ndarray, lo: float, hi: float, bins: int = 400) -> float | None:
    sel = values[(values >= lo) & (values <= hi)]
    if sel.size < 64:
        return None
    hist, edges = np.histogram(sel, bins=bins)
    k = int(np.argmax(hist))
    return float(0.5 * (edges[k] + edges[k + 1]))


def air_level(arr: np.ndarray) -> tuple[float, str]:
    """`(air_value, how_it_was_found)`.

    Tests for a KNOWN value first. If a real population of voxels already sits in
    the Hounsfield air band, that IS air and no search is needed -- which is what
    stops an out-of-field fill value from being mistaken for it. Only when no such
    population exists does this fall back to the histogram mode, and then over
    values ABOVE the array minimum, so a constant fill is stepped over rather than
    counted.
    """
    flat = arr.ravel()
    if flat.size > 4_000_000:                # a landmark needs no full-resolution pass
        flat = flat[:: max(1, flat.size // 4_000_000)]
    in_band = flat[(flat >= HU_AIR_BAND[0]) & (flat <= HU_AIR_BAND[1])]
    if in_band.size >= max(MIN_SOFT_VOXELS, int(0.005 * flat.size)):
        peak = _mode(flat, *HU_AIR_BAND)
        if peak is not None:
            return peak, "hounsfield-band"
    lo = float(flat.min())
    above = flat[flat > lo + 1e-6]
    if above.size < MIN_SOFT_VOXELS:
        return lo, "constant"
    peak = _mode(above, float(above.min()), float(np.percentile(above, 60)))
    return (peak if peak is not None else float(np.median(above))), "modal"


def calibrate(arr: np.ndarray) -> Calibration:
    """A two-point affine putting this scan's air and soft tissue on the training scale.

    Both landmarks are MODES, not percentiles. A percentile moves with how much air
    is in the field of view; a peak does not, and the field of view is the one thing
    that varies wildly between a dental crop and a whole head.

    Refuses rather than guessing when there is no second landmark (a tight crop, a
    volume that has already been segmented out) or when the resulting gain is not
    believable. A refusal applies identity and says why, which is visible in
    `report.intensity`.
    """
    air, how = air_level(arr)
    flat = arr.ravel()
    if flat.size > 4_000_000:
        flat = flat[:: max(1, flat.size // 4_000_000)]
    soft_pool = flat[flat > air + SOFT_OFFSET]
    if soft_pool.size < MIN_SOFT_VOXELS:
        return Calibration(air=air, air_from=how, applied=False,
                           reason=("no soft-tissue peak above air + "
                                   f"{SOFT_OFFSET:.0f} -- nothing to fit a scale to"))
    soft = _mode(soft_pool, float(np.percentile(soft_pool, 1)),
                 float(np.percentile(soft_pool, 90)))
    if soft is None or abs(soft - air) < 1e-3:
        return Calibration(air=air, air_from=how, applied=False,
                           reason="the two landmarks coincide")
    gain = (SOFT_TARGET - AIR_TARGET) / (soft - air)
    if not (GAIN_LIMITS[0] <= gain <= GAIN_LIMITS[1]):
        return Calibration(air=air, soft=soft, air_from=how, applied=False,
                           reason=(f"gain {gain:.3f} is outside the believable "
                                   f"{GAIN_LIMITS[0]}-{GAIN_LIMITS[1]} band"))
    return Calibration(gain=float(gain), offset=float(AIR_TARGET - gain * air),
                       air=air, soft=soft, air_from=how, applied=True)


# --------------------------------------------------------------------------- #
# Preprocessing                                                                #
# --------------------------------------------------------------------------- #
@dataclass
class Preprocessed:
    """What the network eats, plus everything needed to undo the geometry."""

    data: np.ndarray                 # (1, z, y, x) float32, normalised
    spacing_zyx: tuple               # the PLAN spacing, not the case's
    shape_before_cropping: tuple
    bbox: tuple                      # nnU-Net's crop_to_nonzero box, numpy (z, y, x)
    shape_after_cropping: tuple
    calibration: Calibration


@dataclass
class TileReport:
    mode: str = "whole"
    blocks: int = 1
    halo: int = 0
    seconds: float = 0.0
    logit_gib_full: float = 0.0
    logit_gib_peak: float = 0.0
    block_shape: list | None = None
    notes: list = field(default_factory=list)


def logit_gib(shape, n_classes: int) -> float:
    """Exact size of the sliding-window accumulator, in GiB."""
    return float(np.prod(shape)) * n_classes * LOGIT_BYTES / (1 << 30)


def preprocess(image, predictor, calibrate_intensity: bool = True) -> Preprocessed:
    """Calibrate, then hand the volume to nnU-Net's own preprocessor.

    Order matters and is deliberate: calibration runs on RAW intensities, before
    `CTNormalization` clips against the training percentiles. Clipping is where the
    information is destroyed, so a correction applied afterwards would be correcting
    values that had already been flattened.

    It has one documented side effect. Calibration is an affine over EVERY voxel, so
    a volume's zero padding stops being zero and nnU-Net's `crop_to_nonzero` finds
    nothing to remove. On a dental-FOV upload that costs nothing; on a 292 mm
    whole-head volume it is the difference between fitting and not.

    `calibrate_intensity=False` is for a source already on the training scale, and
    for models that normalise with ZScore -- those are affine-invariant by
    construction, so calibrating first is a no-op the network standardises away.
    """
    import SimpleITK as sitk
    from nnunetv2.preprocessing.preprocessors.default_preprocessor import DefaultPreprocessor

    arr = sitk.GetArrayFromImage(image).astype(np.float32)[None]
    cal = (calibrate(arr[0]) if calibrate_intensity
           else Calibration(applied=False,
                            reason="skipped: the source is already on the training scale"))
    cal.apply(arr[0])

    spacing = tuple(float(s) for s in reversed(image.GetSpacing()))
    props = {"spacing": list(spacing)}
    shape_before = tuple(int(x) for x in arr.shape[1:])

    pp = DefaultPreprocessor(verbose=False)
    # nnU-Net 2.8.1 returns `(data, seg, properties)` and hands back its OWN
    # properties dict. Reading the crop geometry from the returned one rather than
    # from the dict we passed in is what keeps `to_canonical` correct across
    # versions -- 2.6.2 mutated in place, 2.8.1 does not necessarily.
    data, _seg, out_props = pp.run_case_npy(
        arr, None, props, predictor.plans_manager,
        predictor.configuration_manager, predictor.dataset_json)
    del arr, _seg
    geom = out_props if "bbox_used_for_cropping" in out_props else props
    return Preprocessed(
        data=data,
        spacing_zyx=tuple(predictor.configuration_manager.spacing),
        shape_before_cropping=shape_before,
        bbox=tuple(tuple(b) for b in geom["bbox_used_for_cropping"]),
        shape_after_cropping=tuple(geom["shape_after_cropping_and_before_resampling"]),
        calibration=cal,
    )


# --------------------------------------------------------------------------- #
# Blocked inference                                                            #
# --------------------------------------------------------------------------- #
def plan_blocks(shape, patch, n_classes: int, budget_gib: float):
    """`(blocks, halo)` -- how to cover `shape` without exceeding the logit budget.

    Tiles along **z only**. That is a real limitation, not an oversight: the
    accumulator is proportional to the whole plane, so a volume that is too WIDE
    cannot be rescued by cutting it into more pieces. A wide-field-of-view upload
    therefore has no affordable path through this model, and `TooLarge` says so
    rather than failing later with an out-of-memory error that looks like a bug.

    Each block is `((work_lo, work_hi), (read_lo, read_hi))`: the region it is
    responsible for, and the region it reads. The halo is one patch depth, so every
    voxel a block is responsible for is seen with full context by at least one
    window.
    """
    z, y, x = (int(v) for v in shape)
    pz = int(patch[0])
    plane = logit_gib((min(pz, z), y, x), n_classes)
    if plane > budget_gib:
        raise TooLarge(
            f"one {pz}-slice patch over a {y}x{x} plane is {plane:.1f} GiB, over the "
            f"{budget_gib:.1f} GiB budget. plan_blocks tiles along z only, so a field "
            f"of view this wide cannot be segmented by this model.")
    full = logit_gib((z, y, x), n_classes)
    if full <= budget_gib:
        return [((0, z), (0, z))], 0

    halo = pz
    # The largest z depth whose logits fit, minus the halo it must read on each side.
    per = max(pz, int(budget_gib * (1 << 30) / (n_classes * LOGIT_BYTES * y * x)))
    step = max(pz, per - 2 * halo)
    blocks = []
    lo = 0
    while lo < z:
        hi = min(z, lo + step)
        blocks.append(((lo, hi), (max(0, lo - halo), min(z, hi + halo))))
        lo = hi
    return blocks, halo


def segment(predictor, pre: Preprocessed, n_classes: int, budget_gib: float):
    """Task-1 labels at the PLAN shape and spacing, plus how it was computed."""
    import torch

    t0 = time.monotonic()
    data = pre.data
    shape = tuple(int(v) for v in data.shape[1:])
    patch = predictor.configuration_manager.patch_size
    blocks, halo = plan_blocks(shape, patch, n_classes, budget_gib)
    rep = TileReport(
        mode="whole" if len(blocks) == 1 else "tiled",
        blocks=len(blocks), halo=halo,
        logit_gib_full=round(logit_gib(shape, n_classes), 2),
    )

    out = np.zeros(shape, dtype=np.uint8)
    peak = 0.0
    for (w0, w1), (r0, r1) in blocks:
        sub = np.ascontiguousarray(data[:, r0:r1])
        peak = max(peak, logit_gib(sub.shape[1:], n_classes))
        with torch.no_grad():
            logits = predictor.predict_sliding_window_return_logits(torch.from_numpy(sub))
        # argmax on the device the logits are already on, then take only the region
        # this block owns. Doing it per block is what keeps one 47-channel array of
        # the WHOLE volume from ever existing.
        lab = torch.argmax(logits, dim=0).to(torch.uint8).cpu().numpy()
        del logits
        out[w0:w1] = lab[w0 - r0: w1 - r0]
        del lab, sub
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    rep.logit_gib_peak = round(peak, 2)
    rep.block_shape = [int(v) for v in patch]
    rep.seconds = round(time.monotonic() - t0, 1)
    if rep.mode == "tiled":
        rep.notes.append(f"tiled into {len(blocks)} z-blocks with a {halo}-slice halo "
                         f"to stay under {budget_gib:.1f} GiB of logits")
    return out, rep


def to_canonical(seg_plan: np.ndarray, pre: Preprocessed, canonical):
    """Put plan-spacing labels back on the grid the case arrived on.

    Two undos, in order: the resample to the plan spacing, then nnU-Net's crop to
    the non-zero region. Nearest-neighbour throughout -- interpolating labels
    invents values that mean other teeth.

    The geometry is reconstructed rather than guessed. nnU-Net resizes with
    `F.interpolate(..., align_corners=False)`, which preserves the OUTER extent, so
    the effective spacing is `extent / new_shape` (close to, but not exactly, the
    plan spacing) and every voxel centre shifts by half the difference.

    We argmax first and resample labels nearest-neighbour; nnU-Net resamples the
    LOGITS trilinearly and argmaxes afterwards. That costs a fraction of a voxel on
    small structures and is what makes the whole path fit in memory -- nnU-Net's
    order needs an fp32 array of 47 channels at the ORIGINAL shape, 33.7 GiB on a
    head CBCT. It vanishes entirely for a volume already at the plan spacing, which
    every ToothFairy3-scale dental CBCT is.
    """
    import SimpleITK as sitk

    d = np.array(canonical.GetDirection(), dtype=float).reshape(3, 3)
    src_spacing = np.array(canonical.GetSpacing(), dtype=float)          # (i, j, k)
    origin = np.array(canonical.GetOrigin(), dtype=float)

    # Origin of the cropped sub-volume. bbox is numpy (z, y, x); sitk index is (i, j, k).
    start_ijk = np.array([pre.bbox[2][0], pre.bbox[1][0], pre.bbox[0][0]], dtype=float)
    crop_origin = origin + d @ (src_spacing * start_ijk)

    cropped_shape_ijk = np.array(pre.shape_after_cropping[::-1], dtype=float)
    plan_shape_ijk = np.array(seg_plan.shape[::-1], dtype=float)
    extent = cropped_shape_ijk * src_spacing
    eff_spacing = extent / plan_shape_ijk
    plan_origin = crop_origin + d @ (0.5 * (eff_spacing - src_spacing))

    img = sitk.GetImageFromArray(seg_plan)
    img.SetSpacing(tuple(eff_spacing))
    img.SetDirection(tuple(d.flatten()))
    img.SetOrigin(tuple(plan_origin))

    ref = sitk.Image(canonical.GetSize(), sitk.sitkUInt8)
    ref.SetSpacing(canonical.GetSpacing())
    ref.SetDirection(canonical.GetDirection())
    ref.SetOrigin(canonical.GetOrigin())
    out = sitk.Resample(img, ref, sitk.Transform(), sitk.sitkNearestNeighbor, 0,
                        sitk.sitkUInt8)
    return sitk.GetArrayFromImage(out)


# --------------------------------------------------------------------------- #
# Regions of interest                                                          #
# --------------------------------------------------------------------------- #
# The teeth-anchored field-of-view guard. A whole-head CBCT contains a great deal
# this model never saw, and the maxilla in particular runs to the top of the scan
# because that is how it was annotated (see labels.FOV_LIMITED). Restricting the
# result to a padded box around the DENTITION keeps the output to the region the
# model is entitled to an opinion about.
FOV_PAD_MM = 45.0
FOV_PAD_SUP_MM = 20.0


def dental_box(seg_t1: np.ndarray, spacing_zyx, pad_mm: float = FOV_PAD_MM,
               pad_sup_mm: float | None = None):
    """A padded box around the teeth, or None when no tooth was found.

    The superior pad is separate and smaller. In canonical RPI axis 0 runs
    superior->inferior, so `lo[0]` is the superior face -- the one that decides how
    far up the maxilla is allowed to run, and the only face where a generous pad
    does harm.
    """
    w = np.argwhere(np.isin(seg_t1, TEETH_CLASSES))
    if not w.size:
        return None
    sp = np.asarray(spacing_zyx, dtype=float)
    pad = np.ceil(np.array([pad_mm, pad_mm, pad_mm]) / sp).astype(int)
    sup = int(np.ceil((pad_sup_mm if pad_sup_mm is not None else pad_mm) / sp[0]))
    lo = np.maximum(w.min(0) - pad, 0)
    hi = np.minimum(w.max(0) + 1 + pad, np.array(seg_t1.shape))
    lo[0] = max(0, int(w.min(0)[0]) - sup)
    return tuple((int(a), int(b)) for a, b in zip(lo, hi))


def restrict_to(seg_t1: np.ndarray, box) -> tuple[np.ndarray, int]:
    """Zero everything outside `box`. Returns `(seg, voxels_dropped)`."""
    if box is None:
        return seg_t1, 0
    keep = np.zeros(seg_t1.shape, dtype=bool)
    (z0, z1), (y0, y1), (x0, x1) = box
    keep[z0:z1, y0:y1, x0:x1] = True
    dropped = int(np.count_nonzero(seg_t1[~keep]))
    seg_t1[~keep] = 0
    return seg_t1, dropped


# The canal-specialist crop, as fractions of the mandible bounding box. Derived
# 2026-08-29 from all 512 training annotations: every accessory canal (Task-1
# 43/44/45) lies INSIDE the mandible bbox in every case, and inside these fractions
# with zero violations. The two extremes that forced hi[1] up from 0.45 to 0.65 are
# ToothFairy3P_190 (lingual) and S_0014 (left incisive). Median crop at these
# fractions: 128 x 195 x 305 voxels at 0.3 mm.
CANAL_BOX_FRAC_LO = (0.30, 0.00, 0.08)
CANAL_BOX_FRAC_HI = (1.00, 0.65, 0.92)
CANAL_BOX_PAD_VOX = 8


def canal_box(mandible: np.ndarray):
    """The anterior-mandible ROI the canal specialist trains and serves on.

    `mandible` is a boolean mask in the caller's own label space -- Task-1 label 1
    at training time, the merged mandible at serving time -- so this function
    cannot be wrong about which jaw is which (the two spaces number them
    oppositely). One function for both sides on purpose: the specialist's
    train/serve distributions match only if the crop rule is literally the same
    code. Returns None when there is no mandible to anchor on, in which case the
    caller must skip the specialist and say so, not guess a box.

    Requires CANONICAL RPI. Indexing a bounding box by fractions of a numpy axis
    means nothing otherwise -- on LPS-stored volumes this measured 0.0-0.3%
    containment of the accessory canals against the 100% it was validated at.
    """
    w = np.argwhere(mandible)
    if not w.size:
        return None
    mlo, mhi = w.min(0), w.max(0)
    span = mhi - mlo
    lo = np.maximum(mlo + np.floor(span * np.array(CANAL_BOX_FRAC_LO)).astype(int)
                    - CANAL_BOX_PAD_VOX, 0)
    hi = np.minimum(mlo + np.ceil(span * np.array(CANAL_BOX_FRAC_HI)).astype(int)
                    + CANAL_BOX_PAD_VOX, np.array(mandible.shape))
    return tuple((int(a), int(b)) for a, b in zip(lo, hi))


# The pterygopalatine-canal crop, as MILLIMETRE offsets from the dental arch's own
# centroid. Millimetres rather than fractions because the anchor is a centroid
# rather than a bounding box, and because PMCanalSeg's field of view varies from
# 176 to 285 mm -- a fraction of that would mean something different case to case.
#
# Measured 2026-09-01 over PMCanalSeg `upper/`: relative to the centroid of the
# dense-tissue (dental arch) mask, the canal occupies +14.0..+45.5 mm superior,
# +1.3..+31.1 mm posterior and -20.6..+21.4 mm lateral.
#
# The margin is 10 mm of anatomical spread plus 8 mm of ANCHOR DISAGREEMENT. That
# second term is measured, not guessed: on seven ToothFairy3 holdout cases the
# training anchor (an intensity threshold) and the serving anchor (the predicted
# teeth) land a median 6.0 mm and at most 8.0 mm apart, systematically superior
# because enamel sits at the occlusal surface. Signs are in canonical RPI, where
# axis 0 runs superior->inferior, so superior offsets are negative.
PTERYGOID_BOX_MM_LO = (-64.0, -17.0, -40.0)
PTERYGOID_BOX_MM_HI = (3.0, 49.0, 40.0)


def pterygoid_box(teeth: np.ndarray, spacing_zyx):
    """The posterior-maxilla ROI for the pterygopalatine-canal specialist.

    `teeth` is a boolean mask of the dental arch in the caller's own label space --
    an intensity threshold at training time, the predicted teeth at serving time.
    Like `canal_box`, one function for both so the train and serve distributions
    are the same by construction, and `None` rather than a guess with no anchor.
    """
    w = np.argwhere(teeth)
    if not w.size:
        return None
    centre = w.mean(axis=0)
    sp = np.asarray(spacing_zyx, dtype=float)
    lo = np.maximum(np.floor(centre + np.asarray(PTERYGOID_BOX_MM_LO) / sp), 0).astype(int)
    hi = np.minimum(np.ceil(centre + np.asarray(PTERYGOID_BOX_MM_HI) / sp),
                    np.asarray(teeth.shape)).astype(int)
    if np.any(hi <= lo):
        return None
    return tuple((int(a), int(b)) for a, b in zip(lo, hi))


def dense_tissue(volume: np.ndarray, n_objects: int = 12, stride: int = 2):
    """A cheap dental-arch locator: the densest structures in a head CBCT.

    Enamel is the densest tissue in the head, so a high percentile plus the largest
    connected components finds the arch without a network. This exists because the
    volumes the pterygopalatine specialist trains on are 176-285 mm across and
    cannot be segmented at all -- `plan_blocks` tiles along z only.

    Returns `(mask_at_stride, stride)`. Subsampled deliberately: an anchor centroid
    does not need 0.24 mm detail, and the full array is 250-400 Mvox.
    """
    from scipy import ndimage

    sub = volume[::stride, ::stride, ::stride]
    body = sub > np.percentile(sub, 60)
    if not body.any():
        return np.zeros(sub.shape, dtype=bool), stride
    # `>=`, not `>`: a strict comparison against a percentile selects nothing at all
    # when the dense voxels share a value, which is every phantom and any scan with
    # a saturated metal restoration.
    dense = sub >= float(np.percentile(sub[body], 99.0))
    lab, n = ndimage.label(dense)
    if n == 0:
        return np.zeros(sub.shape, dtype=bool), stride
    sizes = ndimage.sum(dense, lab, range(1, n + 1))
    keep = np.argsort(sizes)[::-1][:n_objects] + 1
    return np.isin(lab, keep), stride
