"""Structures beyond the dental taxonomy, and the space they compose in.

## Why this is a separate space, and not more ToothFairy3 classes

The board composes in **ToothFairy3 Task-1 id space (1-46)** and everything about that
space is load-bearing: `crosswalk.task1_to_merged_lut()` is a 47-element `uint8` array,
`cc_filter`'s thresholds are keyed by Task-1 id at 0.027 mm3 voxels, `canal_box` and
`dental_box` are anchored in it, and `config.MAX_LOGIT_GIB` is literally
`47 x voxels x 2 B` -- so a class added there costs host RAM on every case whether the
model that draws it ran or not. A tongue has no Task-1 id and cannot be given one without
touching all four of those at once.

So the extended structures live in **merged id space, from 48 upward**, and are composed
by a SECOND pass that runs after the crosswalk. Merged indices are `uint8` on disk with
headroom to 255, `labels.STRUCTURES` is append-only by rule, and every artifact writer in
the worker iterates `L.STRUCTURES` and picks new entries up for free.

## The invariant that makes this safe

    merged_before != 0  =>  merged_after == merged_before

The extended pass may only paint into BACKGROUND. It can never overwrite a dental
structure, so it cannot degrade any of the 47 that carry a measurement, and no clearance,
verdict or error budget can change because a soft-tissue model was switched on. Asserted
in `worker/extended_board.py`, not promised here.

## What these models are, and the honest problem with them

Three TotalSegmentator head/neck tasks, Apache-2.0, 492 training subjects each:
`Dataset777_head_muscles`, `Dataset775_head_glands_cavities`,
`Dataset776_headneck_bones_vessels`. All three declare
`nnUNetTrainer_DASegOrd0_NoMirroring`, so `prepare_models.py`'s axis-2 assertion is
satisfied by construction rather than by luck.

**They are trained on CT in Hounsfield units, and the input here is CBCT**, whose grey
values are not calibrated and whose miscalibration axis is gain rather than offset. Their
plans declare `CTNormalization`, so `tf3`'s intensity calibration is applied to them the
same way it is applied to any CT-trained specialist -- but calibration is a mapping, not
a guarantee, and whether these transfer AT ALL on a given scan is a question about that
scan. `worker/extended_board.py` answers it per case with a measured probe rather than
assuming, and withholds the whole set when the probe fails. See `eval/extended.md`.

**No open model publishes a LIP class.** The nearest honest structures are the soft
palate and the oral cavity below, and TotalSegmentator's `head` envelope in the
craniofacial task. A lip label is not invented here.
"""
from __future__ import annotations

from dataclasses import dataclass

# The first extended index. 1-47 are the dental taxonomy and are frozen by every stored
# job's label volume; see `labels._build`.
FIRST_INDEX = 48

# Groups, in the order the rail renders them. Deliberately AFTER every dental group:
# a reader scanning the structure list should reach the teeth and the canals before the
# masseter, because that is the order the product is about.
GROUP_MUSCLES = "Muscles"
GROUP_CAVITIES = "Airway & cavities"
GROUP_GLANDS = "Glands & orbit"
GROUP_BONES = "Bones & cartilage"
GROUP_VESSELS = "Vessels"
GROUP_ORDER = [GROUP_MUSCLES, GROUP_CAVITIES, GROUP_GLANDS, GROUP_BONES, GROUP_VESSELS]


@dataclass(frozen=True)
class Extended:
    """One extended structure.

    `source_label` is the name in the SOURCE model's own `dataset.json`, and it is the
    join key -- `crosswalk`'s foreign rules resolve by anatomical name and raise rather
    than absorb a renumber, and this space keeps that discipline. `roi_name` is the
    RTSTRUCT short name, capped at 16 characters for Varian Eclipse; `rtstruct._check_names`
    runs at import and refuses a collision or an overlong name, so these are decided here
    rather than generated.
    """
    index: int
    id: str
    name: str
    group: str
    color: str
    model: str            # the catalogue key of the model that draws it
    source_label: str     # its name in that model's dataset.json
    roi_name: str         # <= 16 chars, unique across the WHOLE taxonomy


# Paired left/right structures get the same hue at two lightnesses, the lighter one on
# the patient's right, exactly as `labels._tooth_color` ramps a quadrant. A swapped pair
# then reads as a break in the ramp rather than as two plausible colours.
_M = "head-muscles"
_G = "head-glands"
_B = "headneck-bones"

EXTENDED: list[Extended] = [
    # --- Dataset777_head_muscles ------------------------------------------------
    # The muscles of mastication, plus the tongue and the digastrics. Clinically these
    # are context rather than targets: nobody plans an implant against a masseter. They
    # earn their place by making the airway and the palate legible -- a tongue is the
    # floor of the oral cavity, and without it a soft palate floats in nothing.
    Extended(48, "masseter_right", "Right masseter", GROUP_MUSCLES, "#e8836b", _M, "masseter_right", "MasseterR"),
    Extended(49, "masseter_left", "Left masseter", GROUP_MUSCLES, "#c25f47", _M, "masseter_left", "MasseterL"),
    Extended(50, "temporalis_right", "Right temporalis", GROUP_MUSCLES, "#e89c6b", _M, "temporalis_right", "TemporalisR"),
    Extended(51, "temporalis_left", "Left temporalis", GROUP_MUSCLES, "#c27a47", _M, "temporalis_left", "TemporalisL"),
    Extended(52, "lat_pterygoid_right", "Right lateral pterygoid", GROUP_MUSCLES, "#d98fa8", _M, "lateral_pterygoid_right", "LatPterygoidR"),
    Extended(53, "lat_pterygoid_left", "Left lateral pterygoid", GROUP_MUSCLES, "#b3697f", _M, "lateral_pterygoid_left", "LatPterygoidL"),
    Extended(54, "med_pterygoid_right", "Right medial pterygoid", GROUP_MUSCLES, "#c99ad4", _M, "medial_pterygoid_right", "MedPterygoidR"),
    Extended(55, "med_pterygoid_left", "Left medial pterygoid", GROUP_MUSCLES, "#a375ae", _M, "medial_pterygoid_left", "MedPterygoidL"),
    Extended(56, "tongue", "Tongue", GROUP_MUSCLES, "#f0768f", _M, "tongue", "Tongue"),
    Extended(57, "digastric_right", "Right digastric", GROUP_MUSCLES, "#9fb87d", _M, "digastric_right", "DigastricR"),
    Extended(58, "digastric_left", "Left digastric", GROUP_MUSCLES, "#7a9159", _M, "digastric_left", "DigastricL"),

    # --- Dataset775_head_glands_cavities: the airway and the palate --------------
    # The pharynx ToothFairy3 already draws is ONE class; these three are its named
    # divisions from a different model and a different taxonomy. They are NOT a split of
    # index 40 -- they are a second opinion about overlapping tissue, and because the
    # extended pass only paints background, wherever the two disagree the ToothFairy3
    # pharynx wins and these show only what it did not claim. That is stated rather than
    # hidden: it is the direct consequence of the invariant at the top of this file.
    Extended(59, "nasopharynx", "Nasopharynx", GROUP_CAVITIES, "#7fc4d6", _G, "nasopharynx", "Nasopharynx"),
    Extended(60, "oropharynx", "Oropharynx", GROUP_CAVITIES, "#5aa3b8", _G, "oropharynx", "Oropharynx"),
    Extended(61, "hypopharynx", "Hypopharynx", GROUP_CAVITIES, "#3d8399", _G, "hypopharynx", "Hypopharynx"),
    Extended(62, "nasal_cavity_right", "Right nasal cavity", GROUP_CAVITIES, "#9ad6c4", _G, "nasal_cavity_right", "NasalCavityR"),
    Extended(63, "nasal_cavity_left", "Left nasal cavity", GROUP_CAVITIES, "#6bb3a0", _G, "nasal_cavity_left", "NasalCavityL"),
    # The palate is the floor of the nasal cavity and the roof of the mouth, which makes
    # it the one structure in this file a maxillary implant can actually run into.
    Extended(64, "hard_palate", "Hard palate", GROUP_CAVITIES, "#d6c48f", _G, "hard_palate", "HardPalate"),
    Extended(65, "soft_palate", "Soft palate", GROUP_CAVITIES, "#c49a6b", _G, "soft_palate", "SoftPalate"),
    Extended(66, "auditory_canal_right", "Right auditory canal", GROUP_CAVITIES, "#b8a3d6", _G, "auditory_canal_right", "AuditoryCanR"),
    Extended(67, "auditory_canal_left", "Left auditory canal", GROUP_CAVITIES, "#8f7ab0", _G, "auditory_canal_left", "AuditoryCanL"),

    # --- Dataset775: the glands and the orbit -----------------------------------
    Extended(68, "parotid_right", "Right parotid gland", GROUP_GLANDS, "#e0b877", _G, "parotid_gland_right", "ParotidR"),
    Extended(69, "parotid_left", "Left parotid gland", GROUP_GLANDS, "#b8914f", _G, "parotid_gland_left", "ParotidL"),
    Extended(70, "submandibular_right", "Right submandibular gland", GROUP_GLANDS, "#e8cf94", _G, "submandibular_gland_right", "SubmandR"),
    Extended(71, "submandibular_left", "Left submandibular gland", GROUP_GLANDS, "#bfa66c", _G, "submandibular_gland_left", "SubmandL"),
    Extended(72, "eye_right", "Right eye", GROUP_GLANDS, "#8fb8e8", _G, "eye_right", "EyeR"),
    Extended(73, "eye_left", "Left eye", GROUP_GLANDS, "#6690c2", _G, "eye_left", "EyeL"),
    Extended(74, "eye_lens_right", "Right lens", GROUP_GLANDS, "#cfe4ff", _G, "eye_lens_right", "LensR"),
    Extended(75, "eye_lens_left", "Left lens", GROUP_GLANDS, "#a6bcd9", _G, "eye_lens_left", "LensL"),
    Extended(76, "optic_nerve_right", "Right optic nerve", GROUP_GLANDS, "#ffd98f", _G, "optic_nerve_right", "OpticNerveR"),
    Extended(77, "optic_nerve_left", "Left optic nerve", GROUP_GLANDS, "#d6ab5c", _G, "optic_nerve_left", "OpticNerveL"),

    # --- Dataset776_headneck_bones_vessels ---------------------------------------
    # `larynx_air` is a cavity, not a bone, and goes in the cavities group: the model it
    # comes from is organised by acquisition, this taxonomy by anatomy.
    Extended(78, "larynx_air", "Laryngeal airway", GROUP_CAVITIES, "#4a9ba8", _B, "larynx_air", "LarynxAir"),
    Extended(79, "thyroid_cartilage", "Thyroid cartilage", GROUP_BONES, "#b9c4d4", _B, "thyroid_cartilage", "ThyroidCart"),
    Extended(80, "cricoid_cartilage", "Cricoid cartilage", GROUP_BONES, "#93a0b3", _B, "cricoid_cartilage", "CricoidCart"),
    Extended(81, "hyoid", "Hyoid", GROUP_BONES, "#d8dfe8", _B, "hyoid", "Hyoid"),
    Extended(82, "zygomatic_arch_right", "Right zygomatic arch", GROUP_BONES, "#dccbb0", _B, "zygomatic_arch_right", "ZygomaticR"),
    Extended(83, "zygomatic_arch_left", "Left zygomatic arch", GROUP_BONES, "#b5a488", _B, "zygomatic_arch_left", "ZygomaticL"),
    Extended(84, "styloid_right", "Right styloid process", GROUP_BONES, "#cbb9d4", _B, "styloid_process_right", "StyloidR"),
    Extended(85, "styloid_left", "Left styloid process", GROUP_BONES, "#a693ae", _B, "styloid_process_left", "StyloidL"),
    # Arteries red, veins blue, which is the one colour convention in medicine a reader
    # will already have. Both are deep to the mandibular ramus and are the reason a
    # posterior mandibular block matters, so they are worth drawing even as context.
    Extended(86, "carotid_int_right", "Right internal carotid", GROUP_VESSELS, "#e05555", _B, "internal_carotid_artery_right", "CarotidIntR"),
    Extended(87, "carotid_int_left", "Left internal carotid", GROUP_VESSELS, "#b83a3a", _B, "internal_carotid_artery_left", "CarotidIntL"),
    Extended(88, "jugular_int_right", "Right internal jugular", GROUP_VESSELS, "#5570e0", _B, "internal_jugular_vein_right", "JugularIntR"),
    Extended(89, "jugular_int_left", "Left internal jugular", GROUP_VESSELS, "#3a4fb8", _B, "internal_jugular_vein_left", "JugularIntL"),
]

BY_INDEX = {e.index: e for e in EXTENDED}
BY_ID = {e.id: e for e in EXTENDED}
INDICES = frozenset(e.index for e in EXTENDED)
LAST_INDEX = max(BY_INDEX) if BY_INDEX else FIRST_INDEX - 1


def for_model(key: str) -> list[Extended]:
    """Everything one catalogue model draws, in index order."""
    return [e for e in EXTENDED if e.model == key]


def label_map(key: str) -> dict[str, int]:
    """`{source dataset.json name: merged index}` for one model.

    The join is by ANATOMICAL NAME, never by the source model's integer id. A vendor
    renumbering its own classes between releases is the exact failure `crosswalk` was
    built to refuse, and this space refuses it the same way: a name that stops resolving
    raises instead of silently mapping to whatever now sits at that number.
    """
    return {e.source_label: e.index for e in EXTENDED if e.model == key}


# Thin, low-contrast tubes that legitimately come out in pieces, on the same reasoning as
# `labels.NO_COMPONENT_FILTER`: filtering them would delete what they exist to show.
NO_COMPONENT_FILTER = frozenset({
    BY_ID["optic_nerve_right"].index, BY_ID["optic_nerve_left"].index,
    BY_ID["carotid_int_right"].index, BY_ID["carotid_int_left"].index,
    BY_ID["jugular_int_right"].index, BY_ID["jugular_int_left"].index,
    BY_ID["auditory_canal_right"].index, BY_ID["auditory_canal_left"].index,
})

# ---------------------------------------------------------------- plausibility bands
#
# WHY THIS EXISTS, and it is the most important thing in this module.
#
# The craniofacial transfer probe passes on real dental CBCT -- Dice 0.85 and 0.82 against
# our own mandible on two ToothFairy3 holdout cases. And on those same two cases the
# structures below came out as follows: a TONGUE of 1.76 and 2.71 cm3 where anatomy is
# 70-100; a right masseter found twice and a left masseter once at 0.03 cm3, inside a
# field of view that contains both equally; an oropharynx in 155 connected components.
#
# The probe was measuring the wrong thing. A mandible is dense cortical bone and is the
# one tissue cone-beam CT images well; soft tissue is what CBCT is worst at, because
# scatter and the absence of calibrated Hounsfield units are precisely what a CT-trained
# soft-tissue network depends on. Bone transferring says nothing about muscle.
#
# So a scalar gate over the whole set is not enough, and these bands are the second gate:
# per structure, does what was drawn have the volume and the connectedness of the thing it
# is named after. `(low_cm3, high_cm3)` are adult anatomical ranges, deliberately WIDE --
# they are there to catch a 2 cm3 tongue, not to grade a 60 cm3 one.
#
# A structure below its band that TOUCHES THE SCAN EDGE is truncated, which is ordinary on
# a 123 mm dental field of view and is reported as absent rather than as wrong. One below
# its band in the middle of the volume is a failure, and is withheld.
PLAUSIBLE_CM3 = {
    "masseter_right": (8.0, 60.0), "masseter_left": (8.0, 60.0),
    "temporalis_right": (8.0, 70.0), "temporalis_left": (8.0, 70.0),
    "lat_pterygoid_right": (1.5, 20.0), "lat_pterygoid_left": (1.5, 20.0),
    "med_pterygoid_right": (2.0, 25.0), "med_pterygoid_left": (2.0, 25.0),
    "tongue": (25.0, 180.0),
    "digastric_right": (1.0, 15.0), "digastric_left": (1.0, 15.0),
    "nasopharynx": (2.0, 40.0), "oropharynx": (2.0, 40.0), "hypopharynx": (1.0, 30.0),
    "nasal_cavity_right": (2.0, 40.0), "nasal_cavity_left": (2.0, 40.0),
    "hard_palate": (1.5, 20.0), "soft_palate": (1.0, 20.0),
    "auditory_canal_right": (0.05, 4.0), "auditory_canal_left": (0.05, 4.0),
    "parotid_right": (8.0, 60.0), "parotid_left": (8.0, 60.0),
    "submandibular_right": (2.0, 25.0), "submandibular_left": (2.0, 25.0),
    "eye_right": (4.0, 12.0), "eye_left": (4.0, 12.0),
    "eye_lens_right": (0.03, 0.6), "eye_lens_left": (0.03, 0.6),
    "optic_nerve_right": (0.2, 3.0), "optic_nerve_left": (0.2, 3.0),
    "larynx_air": (1.0, 40.0),
    "thyroid_cartilage": (1.0, 25.0), "cricoid_cartilage": (0.5, 12.0),
    "hyoid": (0.5, 10.0),
    "zygomatic_arch_right": (0.5, 12.0), "zygomatic_arch_left": (0.5, 12.0),
    "styloid_right": (0.05, 4.0), "styloid_left": (0.05, 4.0),
    "carotid_int_right": (0.5, 20.0), "carotid_int_left": (0.5, 20.0),
    "jugular_int_right": (0.5, 25.0), "jugular_int_left": (0.5, 25.0),
}

# The fraction of a structure's mass that must sit in its LARGEST connected component.
# Every structure here is one object; an oropharynx in 155 pieces is noise wearing a name.
# 0.5 rather than something near 1 because a genuinely truncated structure can be cut into
# two real parts by the field of view.
MIN_LARGEST_FRACTION = 0.5

# The widest left/right VOLUME ratio a paired structure may have and still be believed.
# Reported everywhere, but enforced only when NEITHER side is truncated -- a dental field
# of view routinely cuts one side of a neck structure and not the other, and that is
# asymmetry of the scan rather than of the patient.
MAX_LR_RATIO = 3.0


# NOT surgical measurement targets, and the list is everything in this file.
#
# Every structure here comes from a CT-trained model run on CBCT through an intensity
# mapping, scored on nothing. `labels.FOV_LIMITED` marks structures whose ANNOTATION is
# cut by the scan edge; this marks structures whose ERROR IS UNQUANTIFIED, which is a
# different and stronger reason to refuse a millimetre. `plan_safety` has no prior for
# any of them, and until one is measured a clearance to a masseter would be a number with
# no budget behind it -- which is exactly what this product exists not to do.
UNMEASURED = INDICES
