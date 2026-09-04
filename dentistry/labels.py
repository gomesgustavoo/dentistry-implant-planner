"""The merged output taxonomy, and the two source models it is assembled from.

Neither published model covers dental anatomy on its own:

* **DentalSegmentator** (CC BY 4.0, Dot et al. 2024) gives five coarse structures
  including the one thing every implant plan needs — the mandibular canal — but
  lumps all teeth into "upper" and "lower".
* **ToothSeg** (CC BY 4.0, van Nistelrooij / Isensee et al. 2025) numbers every
  tooth individually in FDI notation, but segments *only* teeth.

Their union is 37 structures: two jaws, the canal, and 32 numbered teeth, plus
two "unnumbered tooth" fallbacks for tooth voxels DentalSegmentator found and
ToothSeg did not label (deciduous teeth and misses — dropping those voxels
silently would be worse than showing them as unnumbered).

Indices 38–47 are a third source: a ToothFairy3-finetuned U-Mamba2 model, which
adds the maxillary sinuses, pharynx, three kinds of prosthetic work, the two
mandibular incisive canals, the lingual canal and pulp. **Those ten are produced
only by a job that ran that model**; the live pipeline still emits 37, which is
why the public copy in `web/` and `landing/` still says 37 and should keep saying
so until the model is actually wired into the worker. The UI already renders only
the structures a job reported (`web/app.js` `presentIndices`), so a normal job is
unaffected by their existence.

The extension is append-only. Stored jobs carry their own frozen copy of
`grouped()`, but the label VOLUMES on disk are indexed too, so renumbering an
existing structure would silently reassign voxels in every archived case.

The label *indices* below are what we assume the checkpoints emit. They are
asserted against each model's shipped ``dataset.json`` at load time by
``validate_source_labels`` rather than trusted, because a silent off-by-one in a
tooth index puts a contour on the wrong tooth in a patient.
"""

from __future__ import annotations

from dataclasses import dataclass

# --------------------------------------------------------------------------- #
# Source model 1 — DentalSegmentator, nnU-Net Dataset112, 5 foreground labels.  #
# Order confirmed from the 3D Slicer module that ships with the weights         #
# (SlicerDentalSegmentator, DentalSegmentatorLib/SegmentationWidget.py):        #
#   labels = ["Maxilla & Upper Skull", "Mandible", "Upper Teeth",               #
#             "Lower Teeth", "Mandibular canal"]                               #
# --------------------------------------------------------------------------- #
DENTALSEG_LABELS: dict[int, str] = {
    1: "Maxilla & Upper Skull",
    2: "Mandible",
    3: "Upper Teeth",
    4: "Lower Teeth",
    5: "Mandibular canal",
}
DENTALSEG_MAXILLA = 1
DENTALSEG_MANDIBLE = 2
DENTALSEG_UPPER_TEETH = 3
DENTALSEG_LOWER_TEETH = 4
DENTALSEG_CANAL = 5

# --------------------------------------------------------------------------- #
# Source model 2 — ToothSeg semantic branch, nnU-Net Dataset121, 32 teeth.      #
# Index arithmetic from nnUNet's Dataset119_ToothFairy2_All.py::mapping_DS121:  #
#   11..18 -> i-10 (1..8) | 21..28 -> i-12 (9..16)                             #
#   31..38 -> i-14 (17..24) | 41..48 -> i-16 (25..32)                          #
# (the inline comments in that upstream file are stale; the arithmetic is not.) #
# --------------------------------------------------------------------------- #
def _toothseg_index_to_fdi() -> dict[int, int]:
    m: dict[int, int] = {}
    for fdi in range(11, 19):
        m[fdi - 10] = fdi
    for fdi in range(21, 29):
        m[fdi - 12] = fdi
    for fdi in range(31, 39):
        m[fdi - 14] = fdi
    for fdi in range(41, 49):
        m[fdi - 16] = fdi
    return m


TOOTHSEG_INDEX_TO_FDI: dict[int, int] = _toothseg_index_to_fdi()
FDI_TO_TOOTHSEG_INDEX: dict[int, int] = {v: k for k, v in TOOTHSEG_INDEX_TO_FDI.items()}

# FDI position 1..8 within a quadrant -> anatomical name.
_TOOTH_POSITION_NAMES = {
    1: "Central incisor",
    2: "Lateral incisor",
    3: "Canine",
    4: "First premolar",
    5: "Second premolar",
    6: "First molar",
    7: "Second molar",
    8: "Third molar",
}
_QUADRANT_NAMES = {
    1: ("Upper right", "upper"),
    2: ("Upper left", "upper"),
    3: ("Lower left", "lower"),
    4: ("Lower right", "lower"),
}


def fdi_name(fdi: int) -> str:
    """'11' -> 'Upper right central incisor (11)'."""
    quadrant, position = divmod(fdi, 10)
    return f"{_QUADRANT_NAMES[quadrant][0]} {_TOOTH_POSITION_NAMES[position].lower()} ({fdi})"


# --------------------------------------------------------------------------- #
# The merged output label map.                                                 #
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class Structure:
    index: int  # value in the merged label volume
    id: str  # stable machine id, used in URLs and the UI
    name: str  # display name
    group: str  # UI grouping
    color: str  # #rrggbb
    source: str  # dentalseg | toothseg | dentalseg-fallback
    fdi: int | None = None


# Groups, in the order a clinician reads them.
GROUP_JAWS = "Jaws"
GROUP_CANAL = "Nerve canal"
GROUP_SINUS = "Airway & sinuses"
GROUP_WORK = "Dental work"
GROUP_UPPER = "Upper teeth"
GROUP_LOWER = "Lower teeth"
GROUP_PULP = "Tooth pulp"
GROUP_ORDER = [GROUP_JAWS, GROUP_CANAL, GROUP_SINUS, GROUP_WORK,
               GROUP_UPPER, GROUP_LOWER, GROUP_PULP]


def _tooth_color(fdi: int) -> str:
    """Colour teeth by quadrant hue, lightening from the midline backwards.

    Deliberately not a random palette: a clinician scanning an overlay should be
    able to tell an upper-left premolar from a lower-right one at a glance, and
    position within the quadrant should read as a gradient so a mis-numbered
    tooth shows up as a break in the ramp rather than just "a different colour".
    """
    import colorsys

    quadrant, position = divmod(fdi, 10)
    # Upper right / upper left / lower left / lower right, spread around the wheel.
    base_hue = {1: 0.58, 2: 0.45, 3: 0.11, 4: 0.93}[quadrant]
    # position 1 (midline) -> darkest/most saturated, 8 (third molar) -> lightest.
    t = (position - 1) / 7.0
    light = 0.42 + 0.30 * t
    sat = 0.78 - 0.28 * t
    r, g, b = colorsys.hls_to_rgb(base_hue, light, sat)
    return "#%02x%02x%02x" % (round(r * 255), round(g * 255), round(b * 255))


def _build() -> list[Structure]:
    out: list[Structure] = [
        # "Maxilla", not "Maxilla & upper skull". The old name described
        # DentalSegmentator's class 1, which was the whole cranium -- measured at
        # 111.5 cm3 on the pre-surgery example against 15.5 for ToothFairy3's Upper
        # Jawbone on the same scan. The two are different structures that shared an
        # index, and the index is what has to stay put. Renaming is safe and is the
        # point of freezing `grouped()` into each job: an archived report keeps the
        # name that was true when it was made.
        Structure(1, "maxilla", "Maxilla", GROUP_JAWS, "#d9c9a3", "dentalseg"),
        Structure(2, "mandible", "Mandible", GROUP_JAWS, "#c2a878", "dentalseg"),
        # The canal is the highest-stakes structure here (implant drilling), so it
        # gets the one unmissable colour and is never merged into a jaw.
        Structure(3, "canal", "Mandibular canal", GROUP_CANAL, "#ff3b30", "dentalseg"),
        # Fallbacks: tooth voxels DentalSegmentator found that ToothSeg left
        # unnumbered. Desaturated on purpose -- "present but unidentified", not a
        # finding -- but NOT the same colour as each other: the slice overlay encodes
        # each structure as its own RGB and filters by colour match, so two structures
        # sharing one colour cannot be toggled independently there.
        Structure(4, "upper_teeth_unnumbered", "Upper teeth (unnumbered)", GROUP_UPPER, "#9aa3ad", "dentalseg-fallback"),
        Structure(5, "lower_teeth_unnumbered", "Lower teeth (unnumbered)", GROUP_LOWER, "#8b96a6", "dentalseg-fallback"),
    ]
    idx = 6
    for quadrant in (1, 2, 3, 4):
        for position in range(1, 9):
            fdi = quadrant * 10 + position
            out.append(
                Structure(
                    index=idx,
                    id=f"tooth_{fdi}",
                    name=fdi_name(fdi),
                    group=GROUP_UPPER if quadrant in (1, 2) else GROUP_LOWER,
                    color=_tooth_color(fdi),
                    source="toothseg",
                    fdi=fdi,
                )
            )
            idx += 1

    # --- ToothFairy3 additions, indices 38-47 -----------------------------
    # APPEND-ONLY, and deliberately so. Indices 1-37 are what every stored job
    # was written against; `worker/main.py` freezes `grouped()` into the job's
    # JSONB report, so old jobs keep rendering their own taxonomy, but the label
    # VOLUMES on disk are indexed too and renumbering would silently reassign
    # them. New structures go on the end, never in the middle.
    #
    # These ten are exactly what the three-model stack cannot produce. They come
    # from the finetuned ToothFairy3 model and are absent from any job that did
    # not run it -- which the UI already handles, filtering on the volumes a job
    # actually reported (web/app.js `presentIndices`).
    #
    # Note we do NOT split the existing merged `canal` into left and right here.
    # ToothFairy3 does segment them separately, but index 3 is load-bearing for
    # every existing job and for `MERGED_CANAL`; splitting it is a migration, not
    # an addition. The two mandibular incisive canals below are genuinely new
    # structures, not a split of that one.
    out += [
        # Sinuses and airway. Segmented by ToothFairy3 and well outside the dental
        # crop `worker/roi.py` applies, which is why serving this model needs a
        # different ROI strategy than the current stack.
        Structure(38, "sinus_max_left", "Left maxillary sinus", GROUP_SINUS, "#4fb3bf", "toothfairy3"),
        Structure(39, "sinus_max_right", "Right maxillary sinus", GROUP_SINUS, "#2e8b96", "toothfairy3"),
        Structure(40, "pharynx", "Pharynx", GROUP_SINUS, "#b07fd6", "toothfairy3"),
        # Accessory neural canals. Same clinical class as the mandibular canal --
        # you do not want to drill through one -- so they share its group and get
        # warm, high-visibility colours rather than blending into bone.
        Structure(41, "incisive_canal_left", "Left mandibular incisive canal", GROUP_CANAL, "#ff8f3b", "toothfairy3"),
        Structure(42, "incisive_canal_right", "Right mandibular incisive canal", GROUP_CANAL, "#e0722a", "toothfairy3"),
        Structure(43, "lingual_canal", "Lingual canal", GROUP_CANAL, "#ffd23b", "toothfairy3"),
        # Prosthetic work. These are the classes whose absence produced the
        # "unnumbered dense mass" the README describes: with no label for a bridge,
        # its metal was landing in whichever tooth class was nearest.
        Structure(44, "bridge", "Bridge", GROUP_WORK, "#5b6b8c", "toothfairy3"),
        Structure(45, "crown", "Crown", GROUP_WORK, "#d4af37", "toothfairy3"),
        Structure(46, "implant", "Implant", GROUP_WORK, "#3f4a5a", "toothfairy3"),
        # ToothFairy3 collapses all 32 per-tooth pulps into one class, so this is a
        # single structure and NOT per-tooth. Do not give it an `fdi`.
        Structure(47, "pulp", "Pulp", GROUP_PULP, "#ff5fa2", "toothfairy3"),
    ]
    return out


STRUCTURES: list[Structure] = _build()
BY_INDEX: dict[int, Structure] = {s.index: s for s in STRUCTURES}
BY_ID: dict[str, Structure] = {s.id: s for s in STRUCTURES}
BY_FDI: dict[int, Structure] = {s.fdi: s for s in STRUCTURES if s.fdi is not None}
N_STRUCTURES = len(STRUCTURES)

# Merged-volume indices, named so callers never hard-code an integer.
MERGED_MAXILLA = BY_ID["maxilla"].index
MERGED_MANDIBLE = BY_ID["mandible"].index
MERGED_CANAL = BY_ID["canal"].index
MERGED_UPPER_UNNUMBERED = BY_ID["upper_teeth_unnumbered"].index
MERGED_LOWER_UNNUMBERED = BY_ID["lower_teeth_unnumbered"].index
MERGED_TOOTH_INDICES = frozenset(s.index for s in STRUCTURES if s.fdi is not None)
MERGED_ANY_TOOTH = MERGED_TOOTH_INDICES | {MERGED_UPPER_UNNUMBERED, MERGED_LOWER_UNNUMBERED}

# Small-component removal is applied per structure EXCEPT the canal: it is a thin
# tube that legitimately fragments, and the reference DentalSegmentator Slicer
# module makes exactly this exception ("Remove small islands on all segments
# except mandibular canals").
# The three ToothFairy3 accessory canals are the same kind of object -- thin,
# low-contrast tubes that legitimately come out in pieces -- so they get the same
# exemption. Filtering them would delete exactly the structures they exist to show.
NO_COMPONENT_FILTER = frozenset({
    MERGED_CANAL,
    BY_ID["incisive_canal_left"].index,
    BY_ID["incisive_canal_right"].index,
    BY_ID["lingual_canal"].index,
})


# The ANTERIOR neurovascular structures: everything in the nerve-canal group except the
# inferior alveolar canal itself. Named as a set because implant planning needs it as
# one thing -- the inferior alveolar canal ends at the mental foramen (measured: a 58 mm
# absence across the anterior mandible), so an anterior implant's clearance is to these
# and not to the IAC. Derived by subtraction rather than listed, so a fourth accessory
# canal in a future taxonomy joins it automatically.
#
# They are the canal specialist's own classes (Task-1 43/44/45) and the model's weakest:
# Dice.GT 0.64-0.70 and a mean inward p95 of 0.99-1.11 mm against the left IAC's 0.46.
# Anything grading a clearance to one of them MUST use its own prior -- see
# `plan_safety.STRUCTURE_PRIORS`.
ACCESSORY_CANALS = frozenset(
    {s.index for s in STRUCTURES if s.group == GROUP_CANAL} - {MERGED_CANAL})


# Structures whose ANNOTATION is bounded by the edge of the scan rather than by
# anatomy, so their extent is a fact about the field of view and not about the
# patient. Measured over 36 evenly spaced ToothFairy3 training cases:
#
#     class            annotated in   touches slice 0   % of class in the top 3 mm
#     Lower Jawbone       36/36           36/36                    2.0 %
#     Upper Jawbone       19/36           17/19                   59.3 %
#     L Maxillary Sinus    4/36            4/4                    81.6 %
#     R Maxillary Sinus    3/36            3/3                    62.5 %
#
# Confirmed again on 2026-09-01 from all 512 training labels: the largest maxillary
# sinus ever annotated is 3.85 cm3 against an anatomical 10-20, and our own
# predictions on real full-FOV clinical CBCT come out at 0.15-4.71 cm3. The dataset
# does not contain the structure.
#
# They stay in the export and stay visible. They must NEVER carry a surgical
# measurement -- `worker/panoramic.py` and the implant surface derive the sinus
# floor from the greyscale instead, precisely so nothing depends on this label.
FOV_LIMITED = frozenset({
    MERGED_MAXILLA,
    BY_ID["sinus_max_left"].index,
    BY_ID["sinus_max_right"].index,
})

# Structures that are anatomically ONE object, so keeping only the largest connected
# component is legal. Teeth are deliberately absent: a crowned tooth genuinely splits
# into two components and keep-largest cost ToothFairy3P_241 0.26 Dice on tooth 36.
SINGLE_COMPONENT = frozenset({
    MERGED_MANDIBLE,
    MERGED_MAXILLA,
    BY_ID["sinus_max_left"].index,
    BY_ID["sinus_max_right"].index,
    BY_ID["pharynx"].index,
})


def grouped() -> list[dict]:
    """Catalog for the UI, grouped and ordered."""
    buckets: dict[str, list[Structure]] = {}
    for s in STRUCTURES:
        buckets.setdefault(s.group, []).append(s)
    return [
        {
            "group": g,
            "structures": [
                {"index": s.index, "id": s.id, "name": s.name, "color": s.color,
                 "fdi": s.fdi, "fov_limited": s.index in FOV_LIMITED}
                for s in buckets[g]
            ],
        }
        for g in GROUP_ORDER
        if g in buckets
    ]


class LabelMismatch(RuntimeError):
    """A model's shipped dataset.json disagrees with what this module assumes."""


def validate_source_labels(dentalseg: dict[str, int | str], toothseg: dict[str, int | str]) -> None:
    """Assert both checkpoints emit the indices this module assumes.

    ``dentalseg``/``toothseg`` are the ``labels`` dicts straight out of each
    model's ``dataset.json`` (nnU-Net writes them as ``{name: index}``).
    Raises ``LabelMismatch`` with a specific reason — never a bare assert — so a
    future model revision fails at startup with an actionable message instead of
    quietly re-numbering teeth.
    """
    ds = {str(k): int(v) for k, v in dentalseg.items() if int(v) != 0}
    if len(ds) != len(DENTALSEG_LABELS):
        raise LabelMismatch(
            f"DentalSegmentator: expected {len(DENTALSEG_LABELS)} foreground labels, got {len(ds)}: {sorted(ds)}"
        )
    if sorted(ds.values()) != sorted(DENTALSEG_LABELS):
        raise LabelMismatch(
            f"DentalSegmentator: label indices {sorted(ds.values())} != expected {sorted(DENTALSEG_LABELS)}"
        )

    ts = {str(k): int(v) for k, v in toothseg.items() if int(v) != 0}
    expected = sorted(TOOTHSEG_INDEX_TO_FDI)
    if sorted(ts.values()) != expected:
        raise LabelMismatch(
            f"ToothSeg: label indices {sorted(ts.values())} != expected contiguous 1..32 {expected}"
        )
    # The shipped names are anatomical, not numeric ("Upper Right Central
    # Incisor": 1), so parse quadrant + position out of the words. This is the
    # assertion that actually catches an upstream re-numbering -- counting
    # indices alone would not notice if the two arches were swapped.
    for name, index in ts.items():
        parsed = parse_tooth_name(name)
        if parsed is None:
            raise LabelMismatch(f"ToothSeg: cannot parse a tooth from label name {name!r}")
        if TOOTHSEG_INDEX_TO_FDI.get(index) != parsed:
            raise LabelMismatch(
                f"ToothSeg: dataset.json maps {name!r} (= FDI {parsed}) to index {index}, "
                f"but our table says index {index} is FDI {TOOTHSEG_INDEX_TO_FDI.get(index)}"
            )


def validate_toothfairy3_labels(labels: dict[str, int | str]) -> None:
    """Assert the installed ToothFairy3 checkpoint emits the Task-1 space we assume.

    Same job and same strictness as `validate_source_labels`, for the model that
    replaced those two. `labels` is the `labels` dict straight out of the model's
    `dataset.json`.

    Counting indices is not enough, and the reason is the same one that makes this
    worth doing at all: every id downstream is POSITIONAL. `TASK1_MAPPING`, the
    crosswalk and the CC-threshold table are all keyed by number, so a dataset whose
    ids shifted by one produces a model that looks healthy and names every tooth
    wrongly. The names are anatomical ("Upper Right Central Incisor"), so they can be
    parsed back to an FDI number and checked against the table -- which is the
    assertion that would catch an upstream swapping the two arches.

    The two structural traps are asserted here as well, because they are exactly the
    kind of thing a refactor breaks quietly: ToothFairy3 numbers the LOWER jawbone 1
    and the UPPER jawbone 2, which is the opposite of this module, and both inferior
    alveolar canals collapse into the single merged `canal`.
    """
    from dentistry import crosswalk, toothfairy3 as TF3

    got = {str(k): int(v) for k, v in labels.items()}
    want = TF3.TASK1_LABELS
    if sorted(got.values()) != sorted(want):
        raise LabelMismatch(
            f"ToothFairy3: label indices {sorted(got.values())} != expected "
            f"contiguous 0..{TF3.TASK1_NUM_FOREGROUND} {sorted(want)}"
        )
    by_index = {v: k for k, v in got.items()}
    for index, expected in want.items():
        actual = by_index.get(index)
        if actual is None or actual.strip().lower() != expected.strip().lower():
            raise LabelMismatch(
                f"ToothFairy3: index {index} is {actual!r}, expected {expected!r}"
            )
    for index, fdi in TF3.TASK1_INDEX_TO_FDI.items():
        parsed = parse_tooth_name(by_index[index])
        if parsed != fdi:
            raise LabelMismatch(
                f"ToothFairy3: dataset.json maps {by_index[index]!r} to index {index}, "
                f"which our table says is FDI {fdi}, but the name parses to {parsed}"
            )

    lut = crosswalk.task1_to_merged_lut()
    if int(lut[1]) != MERGED_MANDIBLE or int(lut[2]) != MERGED_MAXILLA:
        raise LabelMismatch(
            f"crosswalk: ToothFairy3 1 (Lower Jawbone) -> {int(lut[1])} and 2 (Upper "
            f"Jawbone) -> {int(lut[2])}, expected {MERGED_MANDIBLE} and {MERGED_MAXILLA}. "
            f"The two label spaces number the jaws the opposite way round; getting this "
            f"wrong swaps the jaws in every case and nothing else fails."
        )
    if not (int(lut[3]) == int(lut[4]) == MERGED_CANAL):
        raise LabelMismatch(
            f"crosswalk: the two inferior alveolar canals map to {int(lut[3])} and "
            f"{int(lut[4])}, expected both to collapse into {MERGED_CANAL}"
        )
    seen: dict[int, int] = {}
    for t1, fdi in TF3.TASK1_INDEX_TO_FDI.items():
        m = int(lut[t1])
        if m in seen:
            raise LabelMismatch(
                f"crosswalk: Task-1 {t1} (FDI {fdi}) and {seen[m]} both map to merged "
                f"index {m}; two teeth cannot share one label"
            )
        seen[m] = t1


_ARCH_WORDS = {"upper": (1, 2), "lower": (4, 3)}  # (right quadrant, left quadrant)
_SIDE_WORDS = {"right": 0, "left": 1}
_POSITION_WORDS = {
    "central incisor": 1,
    "lateral incisor": 2,
    "canine": 3,
    "first premolar": 4,
    "second premolar": 5,
    "first molar": 6,
    "second molar": 7,
    "third molar": 8,
}


def parse_tooth_name(name: str) -> int | None:
    """'Upper Right Third Molar (Wisdom Tooth)' -> 18. None if it is not a tooth.

    Also accepts a bare FDI number anywhere in the string, so a future model that
    labels teeth numerically still validates.
    """
    low = name.lower()
    digits = "".join(c for c in name if c.isdigit())
    if len(digits) == 2 and digits[0] in "1234" and digits[1] in "12345678":
        return int(digits)
    arch = next((a for a in _ARCH_WORDS if a in low), None)
    side = next((s for s in _SIDE_WORDS if s in low), None)
    if arch is None or side is None:
        return None
    # Longest match first so "first molar" never shadows "first premolar".
    position = None
    for words in sorted(_POSITION_WORDS, key=len, reverse=True):
        if words in low:
            position = _POSITION_WORDS[words]
            break
    if position is None:
        return None
    return _ARCH_WORDS[arch][_SIDE_WORDS[side]] * 10 + position
