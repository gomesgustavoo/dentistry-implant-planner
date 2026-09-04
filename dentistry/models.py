"""The model menu: which networks can run, what each owns, and what is known about it.

**Why this module exists at all.** `worker/board.py` already had the menu -- "config
chooses; the menu is code" -- and that was right, except for one thing: the menu was
unreachable from the API. `worker/board` imports numpy at module scope and its factories
read a model store the API pod does not mount, so `GET /v1/models` could not have been
written against it, and a per-job choice of models could not have been validated.

So the DECLARATIVE half moves here, where both sides can import it:

* what a model is called, what it owns, where its ids come from, and what it costs;
* the measured evidence for or against running it, in prose, once;
* which config key names its directory.

`worker/board.py` keeps the machinery -- the ROI, the engine, the GPU lease, the
composition and the ownership assertions -- and builds its `Specialist` objects FROM
these entries, so a model's ownership cannot be one set of ids in the picker and a
different set in the pipeline.

**Numpy-free, deliberately**, like `plan_metrics` and `plan_geometry`. A subprocess
check in `tests/test_phantom.py` asserts it, because the API image has no numpy and an
import added here would take the whole endpoint down at deploy time rather than at
review time.

**Availability is REPORTED, not guessed.** The API cannot see the model store: no mount,
no `DENT_TF3_*` environment. So the worker writes an inventory into the shared data
directory at startup and the API serves that, with its timestamp. An absent inventory
produces "the worker has not reported which models are installed" -- a stated absence --
and never an offer to run something that is not there.
"""

from __future__ import annotations

import json
import os
import time
from dataclasses import dataclass, field
from pathlib import Path

#: Where the worker writes what it has, relative to `DATA_DIR`.
INVENTORY_FILE = "models.json"
INVENTORY_VERSION = 1

#: How stale an inventory may be before the API says so. The worker rewrites it on
#: every start, and a worker that has not started in a week is a worker whose model
#: store nobody has checked.
INVENTORY_FRESH_HOURS = 24 * 7


@dataclass(frozen=True)
class ModelEntry:
    """One network on the menu.

    `owns_task1` is in TOOTHFAIRY3 TASK-1 ids, not merged ids and not the model's own.
    That is the space the board composes in, the space `cc_filter`'s thresholds are
    keyed in and the space `canal_box`/`dental_box` are anchored in -- so it is the
    space ownership has to be declared in, and `structures()` converts for the UI.

    `modes` is what a caller may ask for.
      * `apply`  -- this model's output is stamped into the result.
      * `shadow` -- it runs and its opinion is RECORDED without stamping anything. The
        honest way to accumulate evidence on real clinical scans for a model our own
        holdout cannot settle, because the holdout is a split of that model's own
        training data.
      * `off`    -- it does not run.
    A model whose evidence is not settled offers all three and defaults to `shadow`; the
    base model offers only `apply`, because something has to paint the canvas.
    """

    key: str
    name: str
    role: str                       # base | specialist
    owns_task1: tuple
    origin: str                     # first-party | third-party
    license: str
    dir_setting: str                # the settings attribute naming its directory
    fold_setting: str = ""
    checkpoint_setting: str = ""
    label_rule: str = "task1-identity"
    roi: str = "canal"
    engine: str = "npy"             # npy | blocked
    default_mode: str = "shadow"
    modes: tuple = ("off", "shadow", "apply")
    #: Order of application. Later specialists overwrite earlier ones inside their own
    #: ROI, so this is load-bearing and not cosmetic.
    order: int = 50
    #: Rough wall-clock on the RTX 3080, from the run reports. For the picker, so a
    #: reader choosing three models knows it costs minutes.
    seconds: float = 0.0
    evidence: str = ""
    #: What the reader gives up by turning it off, or takes on by turning it on.
    tradeoff: str = ""
    groups: tuple = ()              # the UI's coarse grouping of what it owns
    #: Which composition space this model writes in.
    #:
    #: `task1`    -- ToothFairy3 Task-1 ids 1-46, fused by `worker/board.py`. Two models
    #:               can claim the same structure there and one has to win, which is what
    #:               `owns_task1` and `assert_owns_only` exist to arbitrate.
    #: `extended` -- merged ids 48+, composed by `worker/extended_board.py`, which may
    #:               only paint into BACKGROUND. Nothing in that space can overwrite a
    #:               structure that carries a measurement, so `owns_task1` is empty for
    #:               these and ownership never arises. See `dentistry/extended.py`.
    space: str = "task1"

    def structures(self) -> list:
        """The merged structure ids this model is authoritative for. Numpy-free."""
        from dentistry import crosswalk
        from dentistry import labels as L

        if self.space == "extended":
            # Extended models do not OWN anything -- nothing else draws these structures,
            # and the pass that composes them may only paint background. So "what it is
            # authoritative for" is simply everything it draws.
            from dentistry import extended as EX
            return [e.id for e in EX.for_model(self.key)]
        lut = crosswalk.task1_to_merged_map()
        out = []
        for t1 in self.owns_task1:
            idx = lut.get(int(t1))
            if idx:
                out.append(L.BY_INDEX[idx].id)
        return out

    def describe(self, inventory: dict | None = None) -> dict:
        """The picker's view of this model, including whether it can actually run."""
        inv = ((inventory or {}).get("models") or {}).get(self.key) or {}
        return {
            "key": self.key,
            "name": self.name,
            "role": self.role,
            "origin": self.origin,
            # The picker groups by this: a Task-1 specialist competes for structures the
            # base model also draws, an extended one adds structures nothing else draws
            # and cannot overwrite anything. Those are different questions and the UI
            # should not put them in one list.
            "space": self.space,
            # True for the extended space, and it is the load-bearing caveat: these are
            # CT-trained models read on CBCT, gated per case, carrying no error budget
            # and therefore forbidden as measurement targets.
            "unmeasured": self.space == "extended",
            "license": self.license,
            "owns_task1": list(self.owns_task1),
            "structures": self.structures(),
            "groups": list(self.groups),
            "modes": list(self.modes),
            "default_mode": self.default_mode,
            "order": self.order,
            "seconds": self.seconds,
            "evidence": self.evidence,
            "tradeoff": self.tradeoff,
            "installed": bool(inv.get("installed")),
            "reason": inv.get("reason"),
            "checkpoint": inv.get("checkpoint"),
        }


# --------------------------------------------------------------------------- catalogue
#
# The evidence prose is the point of this table. Every one of these numbers was measured
# on the 20-case holdout or on external data, and it is written beside the model rather
# than in a commit message, because "which model should segment my teeth" is a question
# a user is about to be asked and they cannot answer it from a name.

BASE = ModelEntry(
    key="toothfairy3",
    name="ToothFairy3 U-Mamba2",
    role="base",
    # Everything. The base model paints the whole canvas and each specialist then
    # overwrites only the ids it owns.
    owns_task1=tuple(range(1, 47)),
    origin="first-party",
    license="CC BY-NC-SA 4.0 (ToothFairy3-derived weights)",
    dir_setting="TOOTHFAIRY3_DIR",
    fold_setting="TF3_FOLD",
    checkpoint_setting="TF3_CHECKPOINT",
    default_mode="apply",
    modes=("apply",),
    order=0,
    seconds=95.0,
    evidence=("Our own nnU-Net with a U-Mamba2 bottleneck, fine-tuned on ToothFairy3. "
              "Strict Dice 0.8292, HD95 1.235 mm, NSD 0.9736, challenge Dice 0.8965 on "
              "20 held-out annotated cases -- above the published SegResNet entry "
              "(0.87) and within 0.012 of the ToothFairy3 challenge winners (0.908)."),
    tradeoff=("It cannot be switched off: something has to draw the whole taxonomy, and "
              "every specialist below only overwrites ids inside its own region."),
    groups=("jaws", "teeth", "canals", "sinuses", "airway", "restorations"),
)

CANAL = ModelEntry(
    key="canal",
    name="Anterior canal specialist (incisive + lingual)",
    role="specialist",
    owns_task1=(43, 44, 45),
    origin="first-party",
    license="CC BY-NC-SA 4.0 (ToothFairy3-derived weights)",
    dir_setting="TF3_CANAL_SPECIALIST_DIR",
    fold_setting="TF3_CANAL_SPECIALIST_FOLD",
    checkpoint_setting="TF3_CANAL_SPECIALIST_CHECKPOINT",
    label_rule="canal-roi",
    roi="canal",
    default_mode="apply",
    order=10,
    seconds=2.5,
    evidence=("A second network trained on the anterior mandible alone. In-distribution "
              "it gains +0.0505 / +0.0874 / +0.0172 Dice on the left incisive, right "
              "incisive and lingual canals and corrects their predicted volume from "
              "155-205% of ground truth to 99-111%; on 40 external PMCanalSeg cases it "
              "beats the base model at p = 7.6e-4."),
    tradeoff=("These three canals are what an ANTERIOR implant has to clear -- the "
              "inferior alveolar canal ends at the mental foramen, so there is no IAC "
              "in front of it. Turning this off leaves the base model's opinion, whose "
              "volumes run to twice the truth."),
    groups=("canals",),
)

TOOTHSEG = ModelEntry(
    key="toothseg-teeth",
    name="ToothSeg semantic (teeth)",
    role="specialist",
    owns_task1=tuple(range(11, 43)),
    origin="third-party",
    license="Apache-2.0 (MIC-DKFZ/ToothSeg)",
    dir_setting="TF3_TOOTHSEG_DIR",
    fold_setting="TF3_TOOTHSEG_FOLD",
    checkpoint_setting="TF3_TOOTHSEG_CHECKPOINT",
    label_rule="toothseg",
    roi="teeth",
    default_mode="shadow",
    order=20,
    seconds=60.0,
    evidence=("The ToothFairy2 challenge winner on teeth. Our holdout CANNOT SETTLE IT: "
              "ToothSeg trained on ToothFairy2, which is a subset of ToothFairy3, and "
              "our 20 cases are a split of that same public release -- so on our own "
              "numbers only its losses are informative and its wins prove nothing."),
    tradeoff=("Defaults to shadow for that reason: it runs, its opinion is recorded in "
              "the report, and nothing it says is stamped into your result. Set it to "
              "apply only if you intend to compare the two yourself."),
    groups=("teeth",),
)

TOTALSEG = ModelEntry(
    key="totalseg",
    name="TotalSegmentator teeth (Dataset113)",
    role="specialist",
    # Ownership is CONFIGURED for this one and defaults to nothing, because the
    # measurement says it should own nothing. See `evidence`.
    owns_task1=(),
    origin="third-party",
    license="Apache-2.0 (wasserth/TotalSegmentator)",
    dir_setting="TF3_TOTALSEG_DIR",
    fold_setting="TF3_TOTALSEG_FOLD",
    checkpoint_setting="TF3_TOTALSEG_CHECKPOINT",
    label_rule="totalseg",
    roi="full",
    engine="blocked",
    default_mode="shadow",
    order=30,
    seconds=180.0,
    evidence=("Measured on 18 cases and it took ownership of NOTHING: zero "
              "accessory-canal voxels in 18 of 18, pulp -0.078 Dice, the two inferior "
              "alveolar canals -0.014 and -0.021. Leakage could only have helped it, so "
              "those losses are real."),
    tradeoff=("Kept on the menu so that measurement can be reproduced, not because it "
              "is expected to win. It runs over the whole volume through the z-tiler "
              "and costs about three minutes."),
    groups=("teeth",),
)


# --- the extended space: structures nothing else in this catalogue draws ------------
#
# Three TotalSegmentator head/neck tasks, Apache-2.0, 492 training subjects each. They
# compose in MERGED ids 48+ through `worker/extended_board.py`, which may only paint into
# background -- so `owns_task1` is empty and stays empty, and switching any of these on
# cannot move a clearance, a verdict or an error budget.
#
# ALL THREE DEFAULT TO `off`, and that is not timidity. They are trained on CT in
# Hounsfield units and the input here is CBCT; whether they transfer is measured per case
# by a probe, and the standard path should not pay two minutes of GPU for anatomy most
# implant plans do not need. A reader who wants the tongue asks for the tongue.
_EXT_LICENSE = "Apache-2.0 (wasserth/TotalSegmentator, v2.3.0-weights)"
_EXT_TRADEOFF_TAIL = (
    "Trained on CT in Hounsfield units and run here on CBCT. MEASURED on three holdout "
    "CBCTs and it does not transfer: across 126 structure-opportunities exactly ONE "
    "survived the plausibility gate. Cone-beam CT images dense bone well and soft tissue "
    "badly -- scatter, and no calibrated Hounsfield units -- which is what a CT-trained "
    "soft-tissue network depends on. Left on the menu so the measurement is reproducible "
    "and so a wider field of view can be tried, NOT because it is expected to draw "
    "anything. Nothing here carries an error budget, so nothing here may be measured "
    "from. See eval/extended.md.")

HEAD_MUSCLES = ModelEntry(
    key="head-muscles",
    name="Head muscles + tongue",
    role="specialist",
    owns_task1=(),
    origin="third-party",
    license=_EXT_LICENSE,
    dir_setting="TF3_HEAD_MUSCLES_DIR",
    fold_setting="TF3_HEAD_MUSCLES_FOLD",
    checkpoint_setting="TF3_HEAD_MUSCLES_CHECKPOINT",
    label_rule="extended",
    roi="full",
    engine="blocked",
    space="extended",
    default_mode="off",
    order=60,
    seconds=45.0,
    evidence=("Dataset777_head_muscles_492subj: the four muscles of mastication "
              "bilaterally, the digastrics, and the tongue. 492 annotated CT subjects, "
              "NoMirroring. MEASURED on dental CBCT and it fails: the tongue came out at "
              "1.76 and 2.71 cm3 against an anatomical 70-100, one masseter was found and "
              "the other was not inside a field of view containing both, and every muscle "
              "was one to two orders of magnitude too small. Zero of eleven survived the "
              "gate on any case."),
    tradeoff=("The tongue is what makes the oral cavity and the soft palate legible in "
              "3-D; the masticatory muscles are context, not targets. " + _EXT_TRADEOFF_TAIL),
    groups=("muscles",),
)

HEAD_GLANDS = ModelEntry(
    key="head-glands",
    name="Airway, palate, glands and orbit",
    role="specialist",
    owns_task1=(),
    origin="third-party",
    license=_EXT_LICENSE,
    dir_setting="TF3_HEAD_GLANDS_DIR",
    fold_setting="TF3_HEAD_GLANDS_FOLD",
    checkpoint_setting="TF3_HEAD_GLANDS_CHECKPOINT",
    label_rule="extended",
    roi="full",
    engine="blocked",
    space="extended",
    default_mode="off",
    order=61,
    seconds=45.0,
    evidence=("Dataset775_head_glands_cavities_492subj: the three pharyngeal divisions, "
              "both nasal cavities, the hard and soft palate, the salivary glands, the "
              "globes, lenses and optic nerves. 492 annotated CT subjects, NoMirroring. "
              "MEASURED on dental CBCT: the orbit and the glands fall outside a 123 mm "
              "field of view entirely, the oropharynx arrived in 155 connected pieces, "
              "and the nasal cavities and hard palate were cut by the scan edge on every "
              "case. Zero of nineteen survived the gate."),
    tradeoff=("The hard palate is the one structure here a maxillary implant can run "
              "into, and it is drawn but NOT measured -- see below. Its three pharyngeal "
              "divisions overlap the single ToothFairy3 pharynx, and because this pass "
              "only paints background, ToothFairy3 wins every voxel they disagree on. "
              + _EXT_TRADEOFF_TAIL),
    groups=("airway", "glands"),
)

HEADNECK_BONES = ModelEntry(
    key="headneck-bones",
    name="Neck bones, cartilage and great vessels",
    role="specialist",
    owns_task1=(),
    origin="third-party",
    license=_EXT_LICENSE,
    dir_setting="TF3_HEADNECK_BONES_DIR",
    fold_setting="TF3_HEADNECK_BONES_FOLD",
    checkpoint_setting="TF3_HEADNECK_BONES_CHECKPOINT",
    label_rule="extended",
    roi="full",
    engine="blocked",
    space="extended",
    default_mode="off",
    order=62,
    seconds=45.0,
    evidence=("Dataset776_headneck_bones_vessels_492subj: the hyoid, the thyroid and "
              "cricoid cartilages, the laryngeal airway, both zygomatic arches and "
              "styloid processes, and the internal carotids and jugulars. 492 annotated "
              "CT subjects, NoMirroring. MEASURED on dental CBCT: almost everything it "
              "draws sits below or behind a dental field of view, and what was in frame "
              "came out cut or a tenth of its size. Zero of twelve survived the gate."),
    tradeoff=("The carotid and the jugular sit deep to the mandibular ramus, which is "
              "why a posterior block matters -- they are drawn as context and carry no "
              "clearance. Most dental CBCT fields of view cut the larynx and the "
              "cartilages off entirely, and a structure cut by the scan edge is reported "
              "as absent rather than as small. " + _EXT_TRADEOFF_TAIL),
    groups=("bones", "vessels"),
)

CATALOGUE = (BASE, CANAL, TOOTHSEG, TOTALSEG, HEAD_MUSCLES, HEAD_GLANDS, HEADNECK_BONES)
BY_KEY = {m.key: m for m in CATALOGUE}
SPECIALIST_KEYS = tuple(m.key for m in CATALOGUE if m.role == "specialist")


def default_config(inventory: dict | None = None) -> dict:
    """`{key: mode}` -- what an upload gets when the reader chooses nothing.

    A model this worker does not have defaults to `off`, not to its catalogue default.
    Otherwise the picker's own defaults would be a configuration the picker then
    refuses, and `board_keys` would name specialists the pipeline is about to skip --
    which is how "the specialist was skipped" and "the specialist found nothing" came to
    render identically once already.
    """
    inv = (inventory or {}).get("models") or {}
    out = {}
    for m in CATALOGUE:
        if m.role == "specialist" and inventory is not None \
                and not (inv.get(m.key) or {}).get("installed"):
            out[m.key] = "off"
        else:
            out[m.key] = m.default_mode
    return out


# ------------------------------------------------------------------------- inventory
def inventory_path(data_dir: str | os.PathLike) -> Path:
    return Path(data_dir) / INVENTORY_FILE


def write_inventory(settings, data_dir: str | os.PathLike | None = None) -> dict:
    """Record which catalogue entries this worker can actually run.

    Called by the worker at startup, into the data directory both it and the API pod
    see. `installed` is not "the setting is non-empty": it is the setting resolved
    against `MODEL_STORE`, with the directory, `dataset.json`, `plans.json` and the
    named checkpoint all present -- because a half-mounted model store fails forty
    seconds into a job, after the upload, and the picker is where that has to be said.
    """
    root = Path(data_dir if data_dir is not None else settings.DATA_DIR)
    store = Path(getattr(settings, "MODEL_STORE", "") or ".")
    out = {"version": INVENTORY_VERSION, "written_at": time.time(),
           "model_store": str(store), "models": {}}
    for m in CATALOGUE:
        name = (getattr(settings, m.dir_setting, "") or "").strip()
        rec: dict = {"dir": name}
        if not name:
            rec.update(installed=False,
                       reason=f"{m.dir_setting} is not set, so this model is not "
                              f"deployed on this worker")
            out["models"][m.key] = rec
            continue
        d = store / name
        ckpt_name = (getattr(settings, m.checkpoint_setting, "")
                     or "checkpoint_final.pth") if m.checkpoint_setting else ""
        fold = (getattr(settings, m.fold_setting, "") or "all") if m.fold_setting else "all"
        ckpt = d / f"fold_{fold}" / ckpt_name if ckpt_name else None
        missing = [str(q.relative_to(store)) for q in
                   [d, d / "dataset.json", d / "plans.json"] + ([ckpt] if ckpt else [])
                   if not q.exists()]
        if missing:
            rec.update(installed=False,
                       reason="missing under the model store: " + ", ".join(missing))
        else:
            rec.update(installed=True, reason=None,
                       checkpoint=f"{name}/fold_{fold}/{ckpt_name}" if ckpt_name else name,
                       checkpoint_mtime=(ckpt.stat().st_mtime if ckpt else None))
        out["models"][m.key] = rec
    root.mkdir(parents=True, exist_ok=True)
    tmp = inventory_path(root).with_suffix(".json.tmp")
    tmp.write_text(json.dumps(out, indent=1) + "\n")
    # Atomic, so a reader never sees a half-written file.
    tmp.replace(inventory_path(root))
    return out


def read_inventory(data_dir: str | os.PathLike) -> dict | None:
    """What the worker last reported, or None. Never raises on a malformed file."""
    f = inventory_path(data_dir)
    try:
        got = json.loads(f.read_text())
    except (OSError, ValueError):
        return None
    return got if isinstance(got, dict) and got.get("models") else None


def inventory_age_hours(inventory: dict | None) -> float | None:
    at = (inventory or {}).get("written_at")
    if not at:
        return None
    return max(0.0, (time.time() - float(at)) / 3600.0)


# ------------------------------------------------------------------------- validation
class ConfigRefused(ValueError):
    """A requested inference configuration cannot be honoured, with the reason."""


def resolve_config(requested: dict | None, inventory: dict | None) -> dict:
    """Normalise a requested `{key: mode}` into one this worker can run, or refuse.

    Refuses rather than falls back. An upload that asked for the anterior canal
    specialist and quietly got the base model's opinion is the failure mode this whole
    module is against: the number that comes out the far end is a clearance to a
    structure whose predicted volume runs to twice the truth, and nothing on screen
    would have said so.

    A model that is simply NOT INSTALLED is refused at request time, which is before the
    upload is written, so the reader is told while there is still something to change.
    """
    req = dict(requested or {})
    fallback = default_config(inventory)
    unknown = [k for k in req if k not in BY_KEY]
    if unknown:
        raise ConfigRefused(
            "unknown model(s) " + ", ".join(sorted(unknown))
            + "; this deployment offers " + ", ".join(sorted(BY_KEY)))
    out = {}
    for m in CATALOGUE:
        mode = str(req.get(m.key, fallback[m.key]))
        if mode not in m.modes:
            raise ConfigRefused(
                f"{m.name} cannot run in mode {mode!r}; it offers "
                + ", ".join(m.modes))
        rec = ((inventory or {}).get("models") or {}).get(m.key) or {}
        if mode != "off" and inventory is not None and not rec.get("installed"):
            raise ConfigRefused(
                f"{m.name} is not available on this deployment: "
                + (rec.get("reason") or "the worker did not report it"))
        out[m.key] = mode
    if out.get(BASE.key) != "apply":
        raise ConfigRefused(f"{BASE.name} is the base model and always runs")
    return out


def board_keys(config: dict | None) -> list:
    """The specialist keys to run, in application order, with their modes.

    Returns `[(key, mode), ...]` for everything not `off`. Order comes from the
    catalogue rather than from the request: a caller cannot reorder ownership, because
    "later wins inside its own ROI" is a property the ownership assertions rely on.
    """
    cfg = config or default_config()   # no inventory here: the worker has the truth
    picked = [(m.order, m.key, str(cfg.get(m.key, m.default_mode)))
              for m in CATALOGUE
              if m.role == "specialist" and m.space == "task1"]
    return [(k, mode) for _o, k, mode in sorted(picked) if mode != "off"]


def extended_keys(config: dict | None) -> list:
    """The EXTENDED-space models to run, in application order, with their modes.

    Separate from `board_keys` because the two passes are separate: `worker/board.py`
    fuses Task-1 ids and would try to build a `Specialist` (with an ROI box, an ownership
    tuple and a `crosswalk` label rule) out of a model that has none of those. Splitting
    the lists is what keeps a soft-tissue model from being handed to the arbitration
    machinery that exists to settle disputes it cannot have.
    """
    cfg = config or default_config()
    picked = [(m.order, m.key, str(cfg.get(m.key, m.default_mode)))
              for m in CATALOGUE if m.space == "extended"]
    return [(k, mode) for _o, k, mode in sorted(picked) if mode != "off"]


def describe_all(inventory: dict | None) -> dict:
    """The whole menu, for `GET /v1/models`."""
    return {
        "models": [m.describe(inventory) for m in CATALOGUE],
        "defaults": default_config(inventory),
        "reported_at": (inventory or {}).get("written_at"),
        "reported_age_hours": inventory_age_hours(inventory),
        "stale": (inventory_age_hours(inventory) or 0.0) > INVENTORY_FRESH_HOURS,
        # A stated absence, not an empty list: "no models" and "nobody has said" are
        # different facts and must not render identically.
        "reason": None if inventory else (
            "The worker has not reported which models are installed, so only the base "
            "model is offered. It writes this inventory when it starts."),
    }
