"""Several models per inference, each authoritative for the structures it owns.

The merged taxonomy was always meant to be assembled from more than one network --
`dentistry/labels.py` carries a `source` field per structure precisely because it
is -- and the retired three-model stack did exactly that. What was missing is a way
to say it declaratively for the ToothFairy3 arm, so a model that measurably wins one
structure group can own it without a second hand-written pipeline.

The base model paints the whole canvas; each specialist then overwrites ONLY the
ids it owns, and only inside an ROI derived from the base model's own prediction.

Three invariants, each of which cost something to learn:

**Fuse in Task-1 id space, on the canonical case grid.** The component filter's
thresholds are keyed by Task-1 id and calibrated to 0.027 mm3 voxels, and
`tf3.canal_box`/`tf3.dental_box` are Task-1-anchored. After the crosswalk to merged
ids every one of those is wrong. The crosswalk therefore runs AFTER composition --
which is free, because it is a per-voxel LUT and `to_canonical` is
nearest-neighbour, so applying it before or after the resample gives the same array.

**The ROI must be computed in the canonical RPI frame.** `canal_box` indexes the
mandible bounding box by FRACTIONS of each numpy axis, and those fractions only
mean anything when axis 0 runs superior-inferior and axis 2 left-right. Composing
on an LPS-stored volume measured 0.0-0.3% containment of the accessory canals
against the 100% the box was validated at over 512 training cases.

**Take the GPU mutex per model, not once around the run.** The lease also
serialises DicomSegVR and voxtell-worker, and `tf3.borrowed_gpu` parks the network
on the CPU and empties the cache BEFORE unlocking -- releasing the lock while still
holding ~1.7 GB is what killed a training run at epoch 126.

Everything outside a specialist's box is asserted byte-identical to the base
prediction, on every case. That assertion is what makes "several models" safe
rather than merely plausible.
"""
from __future__ import annotations

import logging
import time
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

log = logging.getLogger(__name__)

MANDIBLE_T1 = 1  # ToothFairy3 Task-1 numbers the LOWER jaw 1. See crosswalk.py.


@dataclass(frozen=True)
class Specialist:
    """One model on the board, and the structures it is authoritative for.

    `label_rule` names a rule in `crosswalk.LABEL_RULES`, which DERIVES this model's
    id -> Task-1 mapping from its own `dataset.json` at load time and raises if a label
    stops resolving. The mapping is deliberately not written down here: the ids are the
    thing most likely to move upstream, and a renumber absorbed silently produces a
    confident, self-consistent, entirely wrong result. (For the canal specialist the
    derived map is `{1:43, 2:44, 3:45, 4:drop}` -- identical to the literal it replaced,
    which is how the replacement was checked.)

    `owns` is the set of Task-1 ids cleared inside the box before pasting. It is usually
    the values of the derived map, but kept separate so a specialist can own a class it
    sometimes predicts as absent: clearing has to happen even when the specialist finds
    nothing, or the base model's opinion would survive as a silent fallback.

    `calibrate=None` means "ask the model": a model whose plans declare
    `CTNormalization` needs the scan on the training grey scale first, and one declaring
    `ZScoreNormalization` is already invariant to an affine change of it. Deriving beats
    configuring -- a CT-normalised model fed uncalibrated CBCT is the 118 cm3 mandible
    documented in `worker/tf3.py`.

    `mirror_axes` is CLAMPED, never inherited. Test-time mirroring honours whatever the
    checkpoint declares, and a model declaring axis 2 would have TTA average tooth 11's
    logit into tooth 21's position -- a silent left/right scramble on exactly the group
    a teeth specialist is bought for. (0, 1) is what every model here is trained with.

    `mode="shadow"` runs the model and records what it WOULD have drawn without
    stamping anything. That is the honest way to accumulate evidence on real clinical
    scans for a model our own holdout cannot settle, because the holdout is a split of
    that model's own training data.
    """

    name: str
    model_dir: Path
    fold: str
    checkpoint: str
    owns: tuple
    label_rule: str = "task1-identity"
    roi: str = "canal"
    engine: str = "npy"                 # npy | blocked -- see compose()
    calibrate: bool | None = None       # None -> derived from the model's own plans
    tile_step: float = 0.5
    mirror_axes: tuple = (0, 1)
    origin: str = "first-party"         # first-party | third-party
    license: str = ""
    mode: str = "apply"                 # apply | shadow
    #: The `dentistry.models` catalogue key this was built from. Travels into the run
    #: report so a reader can join "what was asked for" to "what actually ran" -- which
    #: is the difference between a specialist that found nothing and one that was
    #: skipped, and those two used to render identically.
    key: str = ""

    def _json(self, name: str) -> dict:
        import json
        return json.loads((self.model_dir / name).read_text())

    def label_lut(self):
        """source id -> Task-1 id, derived from THIS model's dataset.json. Cached."""
        key = str(self.model_dir)
        hit = _LUT_CACHE.get(key)
        stamp = (self.model_dir / "dataset.json").stat().st_mtime_ns
        if hit and hit[0] == (stamp, self.label_rule):
            return hit[1]
        from dentistry import crosswalk
        rule = crosswalk.LABEL_RULES.get(self.label_rule)
        if rule is None:
            raise ValueError(f"unknown label rule {self.label_rule!r}")
        lut = rule(self._json("dataset.json")["labels"])
        _LUT_CACHE[key] = ((stamp, self.label_rule), lut)
        return lut

    def normalization(self) -> list:
        """The normalization schemes this model's own plans declare, resolving inherits."""
        plans = self._json("plans.json")
        cfgs = plans.get("configurations", {})
        cfg = cfgs.get(plans.get("configuration")) or {}
        # The serving configuration is not named in plans.json, so take the 3d one that
        # declares schemes; every model here has exactly one 3d_fullres-ish entry that does.
        best = cfg.get("normalization_schemes")
        if not best:
            for k, v in cfgs.items():
                if "3d" in k and v.get("normalization_schemes"):
                    best = v["normalization_schemes"]
                    if "torchres" in k or k == "3d_fullres":
                        break
        return list(best or [])

    def needs_calibration(self) -> bool:
        if self.calibrate is not None:
            return bool(self.calibrate)
        return any("CTNormalization" in s for s in self.normalization())

    def structures(self) -> list:
        """The merged structure ids this specialist is authoritative for, for the UI."""
        from dentistry import crosswalk
        from dentistry import labels as L
        lut = crosswalk.task1_to_merged_lut()
        out = []
        for t1 in self.owns:
            idx = int(lut[t1])
            if idx:
                out.append(L.BY_INDEX[idx].id)
        return out

    def describe(self) -> dict:
        return {"name": self.name, "key": self.key,
                "checkpoint": f"{self.model_dir.name}/fold_{self.fold}/{self.checkpoint}",
                "owns": list(self.owns), "roi": self.roi, "engine": self.engine,
                "mode": self.mode, "origin": self.origin,
                "calibrated": self.needs_calibration(),
                "mirror_axes": list(self.mirror_axes),
                "structures": self.structures(),
                **({"license": self.license} if self.license else {})}


_LUT_CACHE: dict = {}


@dataclass
class BoardRun:
    name: str
    seconds: float
    checkpoint: str
    owns: list
    box: list | None = None
    voxels_before: dict = field(default_factory=dict)
    voxels_after: dict = field(default_factory=dict)
    skipped: str | None = None
    mode: str = "apply"

    def as_dict(self) -> dict:
        d = {"name": self.name, "seconds": round(self.seconds, 1),
             "checkpoint": self.checkpoint, "owns": self.owns, "mode": self.mode}
        if self.skipped:
            d["skipped"] = self.skipped
        else:
            d["box"] = self.box
            d["voxels"] = {str(k): [self.voxels_before.get(k, 0), self.voxels_after.get(k, 0)]
                           for k in self.owns}
        return d


def _from_catalogue(entry, settings, mode: str | None = None):
    """Build a `Specialist` from a `dentistry.models` entry, or None if not deployed.

    THE MENU MOVED, and only the declarative half of it. What a model is called, what
    it owns, where its ids come from, its ROI, its engine and its licence now live in
    `dentistry/models.py`, where the API can read them too -- because a per-job model
    choice has to be validated by the endpoint that accepts the upload, and this module
    imports numpy at module scope and reads a model store the API pod does not mount.

    Everything that made those declarations trustworthy stays here: the GPU lease, the
    composition, `assert_outside_box_unchanged` and `assert_owns_only`. One consequence
    worth stating: ownership can no longer differ between the picker and the pipeline,
    because there is one tuple and both read it.

    `calibrate` stays DERIVED rather than declared. A model whose plans say
    `CTNormalization` needs the scan on the training grey scale first and one saying
    `ZScoreNormalization` is already invariant to an affine change of it -- so the
    answer follows the weights if a model is ever retrained differently, which a
    catalogue literal would not.
    """
    name = (getattr(settings, entry.dir_setting, "") or "").strip()
    if not name:
        return None
    owns = entry.owns_task1
    if entry.key == "totalseg":
        # The one entry whose ownership is CONFIGURED, and it defaults to nothing
        # because the measurement says it should own nothing. See its `evidence`.
        owns = tuple(getattr(settings, "TF3_TOTALSEG_OWNS", ()) or ())
    return Specialist(
        name=entry.name,
        model_dir=Path(settings.MODEL_STORE) / name,
        fold=getattr(settings, entry.fold_setting, "all") if entry.fold_setting else "all",
        checkpoint=(getattr(settings, entry.checkpoint_setting, "checkpoint_final.pth")
                    if entry.checkpoint_setting else "checkpoint_final.pth"),
        owns=owns,
        label_rule=entry.label_rule,
        roi=entry.roi,
        engine=entry.engine,
        calibrate=None,
        origin=entry.origin,
        license=entry.license,
        mode=(mode or _mode_from_settings(entry, settings)),
        key=entry.key,
    )


def _mode_from_settings(entry, settings) -> str:
    """The mode a deployment-wide setting asks for, or the catalogue default."""
    attr = {"toothseg-teeth": "TF3_TOOTHSEG_MODE",
            "totalseg": "TF3_TOTALSEG_MODE"}.get(entry.key)
    if attr:
        return (getattr(settings, attr, "") or entry.default_mode)
    return entry.default_mode


def load_board(settings, config: dict | None = None) -> list:
    """The specialists to run, in application order.

    `config` is a per-job `{model key: mode}` -- what the uploader chose. `None` keeps
    the deployment-wide behaviour exactly: the specialists named by `TF3_BOARD`, each in
    whatever mode its own setting says, with an unset directory yielding None and an
    empty board. That path is what `scripts/tf3_predict.py` and every evaluation use,
    and it has to stay bit-identical or the numbers stop describing the shipped system.

    A per-job config never reorders anything: the order comes from the catalogue,
    because "a later specialist overwrites an earlier one inside its own ROI" is a
    property `assert_owns_only` relies on and not a preference.
    """
    from dentistry import models as M

    if config is not None:
        out = []
        for key, mode in M.board_keys(config):
            spec = _from_catalogue(M.BY_KEY[key], settings, mode=mode)
            if spec is not None:
                out.append(spec)
        return out

    names = [n.strip() for n in
             (getattr(settings, "TF3_BOARD", "canal") or "").split(",") if n.strip()]
    out = []
    for n in names:
        entry = M.BY_KEY.get(n)
        if entry is None or entry.role != "specialist":
            raise ValueError(f"unknown board member {n!r}; known: "
                             f"{sorted(M.SPECIALIST_KEYS)}")
        spec = _from_catalogue(entry, settings)
        if spec is not None:
            out.append(spec)
    return out


def preflight(board: list) -> list:
    """Resolve every label rule and normalization BEFORE the GPU is touched.

    Same reasoning as asserting the base model's label space first: a renumbered
    upstream model otherwise produces a wrong answer forty seconds later, with every
    intermediate step reporting success.
    """
    out = []
    for spec in board:
        spec.label_lut()                      # raises ForeignLabelMismatch
        out.append(spec.describe())
    return out


def _roi_box(kind: str, seg_t1: np.ndarray, spacing_zyx=None):
    from worker import tf3

    if kind == "canal":
        return tf3.canal_box(seg_t1 == MANDIBLE_T1)
    if kind == "pterygoid":
        return tf3.pterygoid_box(np.isin(seg_t1, tf3.TEETH_CLASSES), spacing_zyx)
    if kind == "teeth":
        # `dental_box` is the teeth-anchored FOV guard the pipeline already trusts, with
        # measured pads. Reusing it means no new constant and no risk of clipping a tooth
        # the base model happened to put outside a tighter box.
        return tf3.dental_box(seg_t1, spacing_zyx)
    if kind == "full":
        return tuple((0, int(n)) for n in seg_t1.shape)
    raise ValueError(f"unknown ROI rule {kind!r}")


def compose(seg_t1: np.ndarray, image, board: list, *, use_lock: bool = True,
            on_wait=None, spacing_zyx=None):
    """Apply every specialist to `seg_t1` in place. Both are on the canonical grid.

    `seg_t1` is Task-1 ids on the case's canonical (RPI) grid -- i.e. after
    `tf3.to_canonical` and after the component filter, and BEFORE the crosswalk.
    `image` is the canonical SimpleITK image the case arrived as, in raw
    intensities: a specialist runs its own preprocessing from its own plans.
    """
    import SimpleITK as sitk

    from worker import tf3

    if spacing_zyx is None:
        spacing_zyx = tuple(reversed(image.GetSpacing()))

    runs: list = []
    for spec in board:
        t0 = time.monotonic()
        ck = f"{spec.model_dir.name}/fold_{spec.fold}/{spec.checkpoint}"
        box = _roi_box(spec.roi, seg_t1, spacing_zyx)
        if box is None:
            # A whole-head scan with no mandible found is a real case, and guessing
            # a box from nothing would put the specialist somewhere arbitrary. Say
            # so in the report and leave the base model's opinion standing.
            log.warning("%s: no ROI (%s) -- skipped", spec.name, spec.roi)
            runs.append(BoardRun(spec.name, time.monotonic() - t0, ck, list(spec.owns),
                                 skipped=f"no {spec.roi} ROI in this scan"))
            continue

        (z0, z1), (y0, y1), (x0, x1) = box
        sub = seg_t1[z0:z1, y0:y1, x0:x1]
        before = {t1: int((sub == t1).sum()) for t1 in spec.owns}

        roi = sitk.RegionOfInterest(image, size=(x1 - x0, y1 - y0, z1 - z0),
                                    index=(x0, y0, z0))
        arr = sitk.GetArrayFromImage(roi).astype(np.float32)[None]
        if spec.needs_calibration():
            tf3.calibrate(arr[0]).apply(arr)
        props = {"spacing": list(roi.GetSpacing())[::-1]}
        del roi

        predictor = tf3.build_predictor(spec.model_dir, spec.fold, spec.checkpoint,
                                        tile_step=spec.tile_step, mirroring=True)
        # CLAMPED, never inherited. Whatever the checkpoint declares, axis 2 is the
        # left-right one: mirroring across it makes TTA average tooth 11's logit into
        # tooth 21's position. This is the trap that cost DKFZ 0.16 Dice on ToothFairy2.
        want = tuple(spec.mirror_axes)
        got = tuple(getattr(predictor, "allowed_mirroring_axes", ()) or ())
        if set(got) - set(want):
            log.warning("%s: checkpoint declares mirroring %s; clamping to %s",
                        spec.name, got, want)
        predictor.allowed_mirroring_axes = want

        with tf3.borrowed_gpu(predictor, use_lock, on_wait=on_wait):
            out = predictor.predict_single_npy_array(arr, props, None, None, False)
        del arr

        # One LUT pass, not one full-ROI comparison per source label: TotalSegmentator
        # folds 32 pulp classes into one, and 32 passes over a whole-volume ROI is not
        # affordable. `lut[out]` is 0 wherever this model contributes nothing.
        lut = spec.label_lut()
        mapped = lut[np.clip(out, 0, len(lut) - 1)]
        if spec.mode == "shadow":
            # Runs, records, stamps NOTHING. `assert_owns_only` then requires zero
            # changed voxels, which is a real check on shadow mode itself.
            after = {t1: int((mapped == t1).sum()) for t1 in spec.owns}
            runs.append(BoardRun(spec.name, time.monotonic() - t0, ck, list(spec.owns),
                                 box=[[int(a), int(b)] for a, b in box],
                                 voxels_before=before, voxels_after=after,
                                 mode="shadow"))
            log.info("%s [shadow]: would draw %s (nothing stamped)", spec.name, after)
            del out, mapped, sub
            continue

        # Clear first, then stamp. Clearing has to happen even where the specialist
        # predicts nothing, or the base model's opinion survives as a silent
        # fallback and the composition would be neither model's answer.
        for t1 in spec.owns:
            sub[sub == t1] = 0
        np.copyto(sub, mapped, where=mapped > 0)
        del mapped
        seg_t1[z0:z1, y0:y1, x0:x1] = sub
        after = {t1: int((sub == t1).sum()) for t1 in spec.owns}
        del out, sub

        runs.append(BoardRun(spec.name, time.monotonic() - t0, ck, list(spec.owns),
                             box=[[int(a), int(b)] for a, b in box],
                             voxels_before=before, voxels_after=after))
        log.info("%s: %s -> %s in %.1fs", spec.name, before, after, runs[-1].seconds)
    return seg_t1, runs


def assert_outside_box_unchanged(base: np.ndarray, composed: np.ndarray, runs: list) -> None:
    """Every voxel outside every applied ROI must be byte-identical.

    Cheap (one masked comparison) and the only check that proves a specialist did
    not quietly rewrite a structure it does not own. Raises rather than logging: a
    composition that leaked is not a result worth shipping.
    """
    mask = np.ones(base.shape, dtype=bool)
    for r in runs:
        if r.box is None:
            continue
        (z0, z1), (y0, y1), (x0, x1) = r.box
        mask[z0:z1, y0:y1, x0:x1] = False
    if not np.array_equal(base[mask], composed[mask]):
        n = int((base[mask] != composed[mask]).sum())
        raise AssertionError(f"specialist changed {n} voxels outside its ROI")


def assert_owns_only(base: np.ndarray, composed: np.ndarray, board: list, runs: list) -> None:
    """Inside every applied ROI, only ids a specialist OWNS may have changed.

    `assert_outside_box_unchanged` goes VACUOUS the moment a specialist uses
    `roi="full"`: the outside mask is empty, the comparison is over nothing, and it
    passes unconditionally. This is the check that still bites, and it is the
    prerequisite for ever mounting a whole-volume foreign model.

    The rule, stated exactly, because a looser or a tighter one both look reasonable:

        new in owns                      -- the specialist claimed a voxel. Legal even
                                            when the base model had called it mandible:
                                            inside its ROI the specialist is
                                            authoritative for the ids it owns, and
                                            taking a voxel from the parent structure is
                                            what "authoritative" means.
        new == 0 and old in owns         -- the specialist cleared its own class. Legal.
        anything else                    -- ILLEGAL. Either it wrote an id it does not
                                            own (a teeth model redrawing the mandible)
                                            or it deleted one (old not owned -> 0).

    An earlier draft required the OLD value to be owned too. That is wrong and a phantom
    check caught it: it would have forbidden the canal specialist from ever taking a
    voxel the base model had assigned to bone, which is its whole job.

    It also checks shadow mode honestly: a shadow run owns ids but must change nothing,
    so its box is required to be byte-identical.
    """
    for r in runs:
        if r.box is None:
            continue
        (z0, z1), (y0, y1), (x0, x1) = r.box
        b = base[z0:z1, y0:y1, x0:x1]
        c = composed[z0:z1, y0:y1, x0:x1]
        diff = b != c
        if not diff.any():
            continue
        if r.mode == "shadow":
            raise AssertionError(
                f"{r.name}: shadow mode changed {int(diff.sum())} voxels; it must stamp nothing")
        owns = list(r.owns)
        was, now = b[diff], c[diff]
        legal = np.isin(now, owns) | ((now == 0) & np.isin(was, owns))
        bad = ~legal
        if bad.any():
            raise AssertionError(
                f"{r.name} changed {int(bad.sum())} voxel(s) outside what it owns "
                f"(owns {sorted(owns)}): "
                f"{sorted({int(v) for v in was[bad][:64]})} -> "
                f"{sorted({int(v) for v in now[bad][:64]})}")


def provenance(runs: list) -> dict:
    """{merged structure id: model name} for the structures a specialist drew.

    Only the overrides, not all 47 -- the base model is the default and saying so
    47 times is noise. The point is that a published artifact can be asked which
    network produced a given structure, which is exactly what could NOT be answered
    about the two showcase examples in August and cost an afternoon of matching
    volumes across every eval run to recover.
    """
    from dentistry import crosswalk
    from dentistry import labels as L

    lut = crosswalk.task1_to_merged_lut()
    out: dict = {}
    for r in runs:
        if r.skipped or r.mode == "shadow":
            continue
        for t1 in r.owns:
            idx = int(lut[t1])
            if idx:
                out[L.BY_INDEX[idx].id] = r.name
    return out
