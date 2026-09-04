"""The ToothFairy3 label space, and the Task-1 remapping the challenge winners used.

Kept torch-free like the rest of `dentistry/`, so the API image can import it.

ToothFairy3 ships 77 raw label ids with gaps in them: six `NA` placeholders sit
where teeth would be in a strict FDI numbering, and the pulps live up at
111-148. nnU-Net wants contiguous ids, so training runs against a remapped copy.
`TASK1_MAPPING` reproduces `mapping_DS119_singlepulp` from the winners' fork
(`nnunetv2/dataset_conversion/Dataset119_ToothFairy3_All.py`) -- the mapping
their Task-1 submission was actually trained with. It drops the NA classes and
collapses all 32 per-tooth pulps into one, giving 46 foreground classes.

Read `RAW_LABELS` as the *expected* label space, not the authoritative one. The
authoritative copy is the `dataset.json` that ships with the download; call
`verify_raw_labels()` against it before converting anything. The project already
takes this line with `labels.validate_source_labels()`, and for the same reason:
a silent label-space drift renumbers teeth without anything appearing to break.

Verified against the real ToothFairy3 download on 2026-08-23: 532 cases, 78
labels, `channel_names` of `{"0": "CBCT"}`. Ids 1-10, 11-48 and 103-105 match
this module exactly.

Trap worth stating explicitly: **ToothFairy3 label 1 is the LOWER jawbone and 2
is the UPPER jawbone.** `dentistry/labels.py` numbers the merged output the other
way round (1 maxilla, 2 mandible). Confusing the two swaps the jaws silently.
"""

from __future__ import annotations

# --- Two different questions about orientation ------------------------------
# Conflating these cost 0.9 Dice once and published four upside-down examples once,
# so they are named separately and neither name is a frame you can guess.
#
#   MODEL_INPUT_ORIENTATION   what the network must be fed
#   RAW_FILE_HEADER_DECLARES  what a ToothFairy3 file CLAIMS, which is not true
#
# MEASURED on the raw holdout labels using FDI numbers, which encode anatomical
# position and are therefore evidence about the VOXELS rather than about the header:
#
#     upper teeth (FDI 1x/2x)   array axis 0 mean   57.1
#     lower teeth (FDI 3x/4x)   array axis 0 mean  143.4   -> axis 0 runs INFERIOR
#     right teeth (FDI 1x/4x)   array axis 2 mean  271.9
#     left  teeth (FDI 2x/3x)   array axis 2 mean  144.7   -> axis 2 runs RIGHT
#
# Every ToothFairy3 file declares LPS with an identity direction and a zero origin.
# That claims axis 0 increases superiorly and axis 2 increases toward patient-left.
# Both are false; the anterior-posterior axis is the only one the header gets right.
# The voxels are in **RPI**, and nnU-Net does not reorient -- `SimpleITKIO` reads the
# array as stored and `transpose_forward` is [0, 1, 2] -- so RPI is what the network
# was trained on and RPI is what it must be fed.
#
# RPI is, by coincidence, exactly `worker.orient.CANONICAL`. So the production
# pipeline needs NO special handling: `worker/ingest.py` already canonicalises every
# upload to RPI, and a CBCT with a truthful header arrives in the right frame by
# doing nothing at all.
#
# The trap is the opposite of what it looks like. Writing
# `orient.to_canonical(img, "LPS")` is correct ONLY for a raw ToothFairy3 file, and
# only because LPS -> LPS is a no-op that leaves the lying header's array untouched.
# Applied to an honest CBCT it rotates the volume 180 degrees about the
# anterior-posterior axis: the model then labels a mirrored, inverted head, holdout
# Dice collapses from ~0.9 to 0.11, and midline structures such as the jawbones keep
# scoring 0.98 -- which is what makes the failure look like a label bug rather than a
# geometry one. Use `fix_raw_header()` on raw files and nothing at all on uploads.
MODEL_INPUT_ORIENTATION = "RPI"
RAW_FILE_HEADER_DECLARES = "LPS"


def fix_raw_header(img):
    """Re-declare a raw ToothFairy3 file's cosines to the frame its voxels are in.

    No voxel is touched. The direction cosines are corrected instead, which is the
    honest description of the defect: the pixels were never wrong, the header was.
    `orient.to_canonical` then sees RPI, recognises its own canonical frame, and
    passes the volume through untouched.

    Chirality is preserved -- negating exactly two index axes is a proper rotation
    (determinant +1), so this introduces no mirroring. The volume's centre is held
    fixed so it still occupies the same region of space.

    An earlier version of this mirrored numpy axis 2 and left the header alone. That
    corrected the left-right half of the error, so the laterality checks in
    `dentistry/quality.py` passed -- and the surviving superior-inferior half
    published four examples with the mandible above the maxilla. `_check_vertical`
    exists to catch precisely that, and is why this function returns a frame rather
    than a flipped array.

    Only for files that came out of the ToothFairy3 download. An upload is not one.
    """
    import numpy as np
    import SimpleITK as sitk

    # IDEMPOTENT. Correcting an already-correct file would negate the same two axes
    # twice and republish the case with the mandible above the maxilla -- which is
    # what happened once, and what `quality._check_vertical` exists to catch. The
    # justification for keying on the declared code is measured: 532 of 532 raw
    # ToothFairy3 files declare LPS, so a file already declaring RPI has been
    # corrected already (or is an honest upload, which must not be touched at all).
    code = sitk.DICOMOrientImageFilter_GetOrientationFromDirectionCosines(
        img.GetDirection())
    if code == "RPI":
        return img

    d = np.array(img.GetDirection(), dtype=float).reshape(3, 3)
    # Negate index axes i (sitk x, numpy axis 2) and k (sitk z, numpy axis 0), i.e.
    # columns 0 and 2. L->R and S->I; the P axis is already right.
    new_d = d @ np.diag([-1.0, 1.0, -1.0])

    size = np.array(img.GetSize(), dtype=float)
    spacing = np.array(img.GetSpacing(), dtype=float)
    centre_index = (size - 1.0) / 2.0
    centre_world = np.array(img.TransformContinuousIndexToPhysicalPoint(tuple(centre_index)))

    out = sitk.Image(img)  # shares the pixels; the geometry is overwritten below
    out.SetDirection(tuple(new_d.flatten()))
    out.SetOrigin(tuple(centre_world - new_d @ (spacing * centre_index)))
    return out


# --- Raw ToothFairy3 label space -------------------------------------------
# Ids 0-48 are inherited unchanged from ToothFairy2; 103-105 and 111-148 are the
# classes ToothFairy3 added (incisive nerves, lingual foramen, per-tooth pulp).

_TOOTH_POSITIONS = [
    "Central Incisor", "Lateral Incisor", "Canine", "First Premolar",
    "Second Premolar", "First Molar", "Second Molar", "Third Molar (Wisdom Tooth)",
]
_QUADRANTS = {1: "Upper Right", 2: "Upper Left", 3: "Lower Left", 4: "Lower Right"}

NON_TOOTH_LABELS = {
    1: "Lower Jawbone",
    2: "Upper Jawbone",
    3: "Left Inferior Alveolar Canal",
    4: "Right Inferior Alveolar Canal",
    5: "Left Maxillary Sinus",
    6: "Right Maxillary Sinus",
    7: "Pharynx",
    8: "Bridge",
    9: "Crown",
    10: "Implant",
}

# ToothFairy3's additions. The dataset page calls 103/104 "incisive nerves" and
# 105 the "lingual nerve"; the nnU-Net dataset.json is the tiebreaker, which is
# what verify_raw_labels() is for.
ACCESSORY_LABELS = {
    103: "Left Mandibular Incisive Canal",
    104: "Right Mandibular Incisive Canal",
    105: "Lingual Canal",
}

# ToothFairy2 carried six placeholder classes at the FDI positions that do not
# exist (19, 20, 29, 30, 39, 40). ToothFairy3 dropped them -- its dataset.json has
# 78 labels, not 84. They stay named here because TASK1_MAPPING deliberately omits
# them, so a ToothFairy2-derived label file run through `remap_array` sends them to
# background rather than onto a real tooth.
NA_LABELS = {19: "NA1", 20: "NA2", 29: "NA3", 30: "NA4", 39: "NA5", 40: "NA6"}


def fdi_name(fdi: int) -> str:
    """FDI number -> the display name ToothFairy uses, e.g. 18 -> 'Upper Right Third Molar (Wisdom Tooth)'."""
    return f"{_QUADRANTS[fdi // 10]} {_TOOTH_POSITIONS[fdi % 10 - 1]}"


def _fdi_numbers() -> list[int]:
    return [q * 10 + p for q in (1, 2, 3, 4) for p in range(1, 9)]


FDI_NUMBERS = _fdi_numbers()
TOOTH_LABELS = {fdi: fdi_name(fdi) for fdi in FDI_NUMBERS}
PULP_LABELS = {100 + fdi: f"{fdi_name(fdi)} Pulp" for fdi in FDI_NUMBERS}

RAW_LABELS: dict[int, str] = {
    0: "background",
    **NON_TOOTH_LABELS,
    **TOOTH_LABELS,
    **ACCESSORY_LABELS,
    **PULP_LABELS,
}  # 78 entries, matching the ToothFairy3 dataset.json exactly


# --- Task 1: the mapping the winning submission trained on ------------------

def _task1_mapping() -> dict[int, int]:
    """mapping_DS119_singlepulp: drop the NA ids, make them contiguous, one pulp class."""
    m: dict[int, int] = {}
    m.update({i: i for i in range(1, 19)})          # 1-10 structures, 11-18 upper-right teeth
    m.update({i: i - 2 for i in range(21, 29)})     # 21-28 -> 19-26
    m.update({i: i - 4 for i in range(31, 39)})     # 31-38 -> 27-34
    m.update({i: i - 6 for i in range(41, 49)})     # 41-48 -> 35-42
    m.update({i: i - 60 for i in range(103, 106)})  # 103-105 -> 43-45
    for q in (1, 2, 3, 4):                          # every pulp -> a single class
        m.update({100 + q * 10 + p: 46 for p in range(1, 9)})
    return m


TASK1_MAPPING = _task1_mapping()
TASK1_NUM_FOREGROUND = 46
TASK1_NUM_CHANNELS = TASK1_NUM_FOREGROUND + 1  # the softmax width, background included


def _task1_labels() -> dict[int, str]:
    out = {0: "background"}
    for raw, new in TASK1_MAPPING.items():
        if new == 46:
            out[46] = "Pulp"
        else:
            out[new] = RAW_LABELS[raw]
    return out


TASK1_LABELS = _task1_labels()
TASK1_FDI_TO_INDEX = {fdi: TASK1_MAPPING[fdi] for fdi in FDI_NUMBERS}
TASK1_INDEX_TO_FDI = {v: k for k, v in TASK1_FDI_TO_INDEX.items()}


def remap_array(arr, mapping: dict[int, int] | None = None):
    """Apply a label mapping to a numpy array via a lookup table.

    Anything not named by the mapping becomes background -- that is deliberate,
    and is how the NA classes get dropped.
    """
    import numpy as np

    mapping = TASK1_MAPPING if mapping is None else mapping
    lut = np.zeros(max(max(mapping), int(arr.max())) + 1, dtype=np.uint8)
    for src, dst in mapping.items():
        lut[src] = dst
    return lut[arr]


class LabelSpaceMismatch(RuntimeError):
    """The downloaded dataset does not have the label space this module assumes."""


def verify_raw_labels(labels: dict[str, int]) -> None:
    """Check a downloaded ToothFairy3 `dataset.json` against RAW_LABELS.

    `labels` is the dataset.json mapping, i.e. name -> id. Raises rather than
    warning: every downstream id in `TASK1_MAPPING` is positional, so a shifted
    label space produces a plausible-looking model that names structures wrongly.
    """
    got = {int(v): k for k, v in labels.items()}
    problems = []
    for idx, expected in sorted(RAW_LABELS.items()):
        actual = got.get(idx)
        if actual is None:
            problems.append(f"  {idx}: missing (expected {expected!r})")
        elif actual.strip().lower() != expected.strip().lower():
            problems.append(f"  {idx}: is {actual!r}, expected {expected!r}")
    for idx in sorted(set(got) - set(RAW_LABELS)):
        problems.append(f"  {idx}: {got[idx]!r} is present but unknown to this module")
    if problems:
        raise LabelSpaceMismatch(
            "ToothFairy3 label space differs from dentistry/toothfairy3.py:\n"
            + "\n".join(problems)
            + "\n\nFix this module against the downloaded dataset.json before converting; "
              "TASK1_MAPPING is positional and will mislabel structures otherwise."
        )
