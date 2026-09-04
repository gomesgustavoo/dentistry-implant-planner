"""The Task-1 segmentation path, shared by the worker and the offline predictor.

Everything `_segment_toothfairy3` does up to but NOT including the crosswalk to merged
ids: base model, field-of-view guard, component filter, canonicalisation, then the
structure board. It lives here so the composition an evaluation grades is *literally the
same function* the product runs -- there is no second implementation to drift.

The ordering is load-bearing and is argued for at each step below. In short: the
component filter's thresholds are keyed by Task-1 id and expressed in voxels at
0.027 mm3, and `canal_box`/`dental_box` are Task-1-anchored and only mean anything on
the canonical RPI grid. Both facts stop being true after the crosswalk, so the crosswalk
runs last.
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

from dentistry import labels as L

log = logging.getLogger(__name__)


@dataclass
class Task1Result:
    """Task-1 ids on the case's canonical grid, plus everything the report needs."""

    seg: np.ndarray
    reports: dict = field(default_factory=dict)
    runs: list = field(default_factory=list)
    gpu_seconds: float = 0.0
    wait_seconds: float = 0.0
    base: np.ndarray | None = None


def _noop(*_a, **_k):
    pass


class _Rep:
    """Adapts a bare callable to the worker's reporter, which also has check_cancel."""

    def __init__(self, fn):
        self._fn = fn or _noop

    def __call__(self, frac, msg):
        self._fn(frac, msg)

    def check_cancel(self):
        fn = getattr(self._fn, "check_cancel", None)
        if fn:
            fn()


def segment_task1(image, settings, *, rep=None, use_lock=True, board=None,
                  config=None, keep_base=False, load_labels=None):
    """Run the base model and the board, returning Task-1 ids on the canonical grid.

    `board=None` loads one; pass `[]` for the base model alone, which is what an A/B
    needs so the two arms differ by the board and nothing else.

    `config` is the UPLOADER's `{model key: mode}` choice, and it is only consulted when
    `board` is None. `config=None` in turn keeps the deployment-wide behaviour exactly
    -- the specialists named by `TF3_BOARD` -- which is the path every evaluation takes,
    and it has to stay bit-identical or the published numbers stop describing the
    shipped system.

    WHAT WAS ASKED FOR is recorded whether or not it could be honoured
    (`reports["requested"]`). A specialist that was requested and is not deployed shows
    up there as a named substitution rather than as a board that quietly has one fewer
    member: the numbers that come out the far end are clearances to structures whose
    predicted volume depends on which model drew them.
    """
    from dentistry import crosswalk  # noqa: F401  (kept: callers convert afterwards)
    from worker import board as board_mod
    from worker import cc_filter, tf3

    rep = _Rep(rep)
    reports: dict = {}
    model_dir = tf3.model_dir(settings)
    # Assert the checkpoint's label space against ours BEFORE touching the GPU: a
    # renumbered upstream model would otherwise produce a confident, self-consistent
    # and entirely wrong result forty seconds later.
    if load_labels is not None:
        L.validate_toothfairy3_labels(load_labels(model_dir))

    rep(0.10, "Loading the model")
    predictor = tf3.build_predictor(model_dir, settings.TF3_FOLD, settings.TF3_CHECKPOINT,
                                    tile_step=settings.TILE_STEP_SIZE_TF3,
                                    mirroring=settings.USE_MIRRORING_TF3)
    n_classes = predictor.label_manager.num_segmentation_heads

    rep(0.15, "Preparing the volume")
    pre = tf3.preprocess(image, predictor)

    t0 = time.monotonic()
    wait0 = time.monotonic()
    wait_seconds = 0.0
    with tf3.borrowed_gpu(predictor, True, on_wait=lambda: rep(0.18, "Waiting for the GPU")):
        wait_seconds = round(time.monotonic() - wait0, 1)
        rep(0.20, "Segmenting jaws, teeth, canals and sinuses")
        seg_t1, srep = tf3.segment(predictor, pre, n_classes, settings.MAX_LOGIT_GIB)
    gpu_seconds = round(time.monotonic() - t0, 1)
    rep.check_cancel()

    reports["models"] = [{
        "name": "ToothFairy3 U-Mamba2 (Task 1)",
        "seconds": gpu_seconds,
        "checkpoint": f"{settings.TOOTHFAIRY3_DIR}/fold_{settings.TF3_FOLD}/{settings.TF3_CHECKPOINT}",
    }]
    reports["intensity"] = pre.calibration.as_report()

    fov = tf3.dental_box(seg_t1, pre.spacing_zyx, settings.TF3_FOV_PAD_MM,
                         settings.TF3_FOV_PAD_SUP_MM)
    seg_t1, dropped_fov = tf3.restrict_to(seg_t1, fov)
    reports["roi"] = {"mode": srep.mode, "blocks": srep.blocks, "halo": srep.halo,
                      "logit_gib_full": srep.logit_gib_full,
                      "logit_gib_peak": srep.logit_gib_peak,
                      "block_shape": srep.block_shape, "notes": srep.notes,
                      "fov_dropped_voxels": int(dropped_fov),
                      "fov_box": [list(b) for b in fov] if fov else None}
    reports["pipeline"] = {"name": "toothfairy3-umamba2", "taxonomy": L.N_STRUCTURES,
                           "orientation": tf3.MODEL_INPUT_ORIENTATION}

    # BEFORE the crosswalk and on the 0.3 mm grid: the thresholds are keyed by
    # Task-1 id and expressed in voxels at 0.027 mm3, and both facts stop being true
    # after either step. See worker/cc_filter.py.
    rep(0.70, "Removing spurious fragments")
    _cc_table = Path(settings.MODEL_STORE) / settings.TF3_CC_TABLE
    seg_t1, removed, cc_audit = cc_filter.apply(
        seg_t1,
        cc_filter.load_thresholds(_cc_table, settings.TF3_CC_PERCENTILE),
        floors=cc_filter.load_floors(_cc_table))
    # The audit is the point, not a nicety: an ABSTENTION says the model drew something
    # the training distribution does not contain, which is a scan-specific quality
    # signal worth reading, and a deletion that only shows up as a Dice drop is a
    # deletion nobody can review. `voxel_mm3` travels with it so the report does not
    # have to be joined against the plan spacing to be read in millimetres.
    reports["postprocess"] = {"cc_filter": {
        "percentile": settings.TF3_CC_PERCENTILE,
        "voxel_mm3": cc_filter.table_voxel_mm3(_cc_table),
        "removed_voxels": {str(k): v for k, v in removed.items()},
        "class_floor_voxels": cc_filter.CLASS_FLOOR_VOXELS,
        "decisions": cc_audit,
        "abstained": [a for a in cc_audit if a["action"] == "abstain"],
        "exempt": sorted(cc_filter.exempt_task1_classes()),
    }}

    # Onto the case's own grid while still in Task-1 ids. The crosswalk used to run
    # first, on the plan grid; moving it after costs nothing (a per-voxel LUT and a
    # nearest-neighbour resample commute, and the LUT maps 0 to 0) and it is what
    # lets the board below use `canal_box`, which is Task-1-anchored and only means
    # anything in the canonical RPI frame.
    seg_case = tf3.to_canonical(seg_t1, pre, image)
    del seg_t1, pre

    if board is None:
        board = board_mod.load_board(settings, config)
        if config is not None:
            from dentistry import models as M

            ran = {sp.key for sp in board}
            reports["requested"] = {
                "config": dict(config),
                "ran": sorted(ran),
                "unavailable": [
                    {"key": k, "mode": mode, "name": M.BY_KEY[k].name,
                     "reason": "not deployed on this worker: "
                               f"{M.BY_KEY[k].dir_setting} is unset or its files are "
                               "missing"}
                    for k, mode in M.board_keys(config) if k not in ran],
            }
    board_runs = []
    base_keep = seg_case.copy() if keep_base else None
    if board:
        # Resolve every label rule BEFORE the GPU is touched. A renumbered upstream
        # model otherwise produces a wrong answer forty seconds later, with every
        # intermediate step reporting success -- the same reasoning that puts
        # validate_toothfairy3_labels ahead of build_predictor.
        reports["board_config"] = board_mod.preflight(board)
        rep(0.72, "Running the specialist models")
        base_copy = seg_case.copy()
        seg_case, board_runs = board_mod.compose(
            seg_case, image, board, use_lock=use_lock,
            on_wait=lambda: rep(0.72, "Waiting for the GPU"))
        # Not a test-only nicety: this is what makes "several models" safe. A
        # specialist that leaked outside its ROI would have silently rewritten a
        # structure it does not own, and nothing downstream could detect it.
        board_mod.assert_outside_box_unchanged(base_copy, seg_case, board_runs)
        # ...and the one that still bites when a specialist's ROI is the whole volume,
        # where the check above compares nothing and passes unconditionally.
        board_mod.assert_owns_only(base_copy, seg_case, board, board_runs)
        del base_copy
        reports["models"].extend(
            {"name": r.name, "seconds": r.seconds, "checkpoint": r.checkpoint,
             "origin": s.origin, **({"license": s.license} if s.license else {})}
            for r, s in zip(board_runs, board))
        reports["board"] = [r.as_dict() for r in board_runs]
        reports["provenance"] = board_mod.provenance(board_runs)

    return Task1Result(seg=seg_case, reports=reports, runs=board_runs,
                       gpu_seconds=gpu_seconds, wait_seconds=wait_seconds,
                       base=base_keep)
