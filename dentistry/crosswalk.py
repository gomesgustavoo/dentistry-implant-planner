"""Comparison spaces: scoring two different label taxonomies against each other.

The pipeline emits 37 merged structures (`dentistry/labels.py`); ToothFairy3
ground truth uses its own 77-class space, and a finetuned Task-1 model emits 46.
None of the three line up id-for-id, and two of the mismatches are not
one-to-one at all:

  * `canal` is ONE merged class here and TWO in ToothFairy3 (left and right
    inferior alveolar canal), so comparing it means unioning the ground-truth pair.
  * `upper/lower_teeth_unnumbered` are teeth the pipeline could not number.
    ToothFairy3 has no equivalent, so they are excluded rather than scored
    against something arbitrary.

A comparison class therefore names a set of ids on each side, not a single id.
"""

from __future__ import annotations

from dataclasses import dataclass

from dentistry import labels as L
from dentistry import toothfairy3 as tf3


@dataclass(frozen=True)
class ComparisonClass:
    """One scored structure: which ids form its mask in ground truth, and in the prediction."""

    name: str
    gt_ids: tuple[int, ...]
    pred_ids: tuple[int, ...]
    group: str


def _teeth(pred_index_of) -> list[ComparisonClass]:
    out = []
    for fdi in tf3.FDI_NUMBERS:
        pred = pred_index_of(fdi)
        if pred is None:
            continue
        out.append(ComparisonClass(
            name=f"tooth_{fdi}",
            gt_ids=(fdi,),
            pred_ids=(pred,),
            group="Upper teeth" if fdi // 10 in (1, 2) else "Lower teeth",
        ))
    return out


def merged_vs_toothfairy3() -> list[ComparisonClass]:
    """The 35 structures the CURRENT 3-model pipeline and ToothFairy3 can both express.

    Ground-truth ids are RAW ToothFairy3 (as downloaded); prediction ids are the
    merged taxonomy in `dentistry/labels.py`. Note the jaw ids cross over --
    ToothFairy3 numbers the LOWER jaw 1, this project numbers the maxilla 1.
    """
    out = [
        ComparisonClass("maxilla", (2,), (L.MERGED_MAXILLA,), "Jaws"),
        ComparisonClass("mandible", (1,), (L.MERGED_MANDIBLE,), "Jaws"),
        # One predicted canal class against both ground-truth canals.
        ComparisonClass("canal", (3, 4), (L.MERGED_CANAL,), "Nerve canal"),
    ]
    out += _teeth(lambda fdi: L.BY_FDI[fdi].index)
    return out


def toothfairy3_task1() -> list[ComparisonClass]:
    """The full 46-class Task-1 space, prediction and ground truth in the same ids.

    Ground truth is expected to have been remapped with `tf3.TASK1_MAPPING`.
    """
    groups = {
        1: "Jaws", 2: "Jaws",
        3: "Nerve canal", 4: "Nerve canal",
        5: "Sinuses", 6: "Sinuses", 7: "Airway",
        8: "Dental work", 9: "Dental work", 10: "Dental work",
        43: "Accessory canals", 44: "Accessory canals", 45: "Accessory canals",
        46: "Pulp",
    }
    out = []
    for idx in range(1, tf3.TASK1_NUM_FOREGROUND + 1):
        fdi = tf3.TASK1_INDEX_TO_FDI.get(idx)
        if fdi is not None:
            group = "Upper teeth" if fdi // 10 in (1, 2) else "Lower teeth"
            name = f"tooth_{fdi}"
        else:
            group = groups.get(idx, "Other")
            name = tf3.TASK1_LABELS[idx]
        out.append(ComparisonClass(name, (idx,), (idx,), group))
    return out


def toothfairy3_task1_vs_raw_gt() -> list[ComparisonClass]:
    """Task-1 predictions scored against RAW (unmapped) ToothFairy3 ground truth.

    Saves remapping the ground truth on disk. The pulp class expands back out to
    all 32 per-tooth pulp ids, which is exactly how the challenge scores it.
    """
    out = []
    for c in toothfairy3_task1():
        idx = c.pred_ids[0]
        if idx == 46:
            gt_ids = tuple(sorted(PULP_RAW_IDS))
        else:
            gt_ids = tuple(k for k, v in tf3.TASK1_MAPPING.items() if v == idx)
        out.append(ComparisonClass(c.name, gt_ids, c.pred_ids, c.group))
    return out


PULP_RAW_IDS = frozenset(k for k, v in tf3.TASK1_MAPPING.items() if v == 46)


# Raw ToothFairy3 id -> merged structure STRING id. Module level deliberately: the
# conversion LUT below and the `merged-vs-tf3-full` comparison space must both read
# it, or the viewer would show one structure and grade another.
#
# Note 1 -> mandible and 2 -> maxilla: ToothFairy3 numbers the LOWER jaw 1 and
# labels.py numbers the maxilla 1. The inversion is the whole reason this table is
# written out rather than computed.
RAW_TO_MERGED_ID = {
    1: "mandible", 2: "maxilla",
    3: "canal", 4: "canal",
    5: "sinus_max_left", 6: "sinus_max_right", 7: "pharynx",
    8: "bridge", 9: "crown", 10: "implant",
    103: "incisive_canal_left", 104: "incisive_canal_right", 105: "lingual_canal",
}


def merged_vs_toothfairy3_full() -> list[ComparisonClass]:
    """45 classes: the merged taxonomy scored against RAW ToothFairy3 ground truth.

    The older `merged_vs_toothfairy3` covers 35 and was built for the retired
    three-model stack, so it is missing exactly the ten ToothFairy3-only structures
    the published examples exist to show.

    Two classes are lossy and both are documented rather than hidden:

    * **canal** -- merged id 3 is one class where ToothFairy3 has 3 and 4. The union
      Dice is honest (it describes the object on screen) but there is no per-side
      Dice to be had, because the merged prediction carries no side attribution.
    * **pulp** -- lossless in fact: merged 47 and Task-1 46 are the same union of
      the same 32 raw ids.
    """
    out: list[ComparisonClass] = []
    for sid in dict.fromkeys(RAW_TO_MERGED_ID.values()):
        st = L.BY_ID[sid]
        gt = tuple(k for k, v in RAW_TO_MERGED_ID.items() if v == sid)
        out.append(ComparisonClass(st.id, gt, (st.index,), st.group))
    out.append(ComparisonClass("pulp", tuple(sorted(PULP_RAW_IDS)),
                               (L.BY_ID["pulp"].index,), L.BY_ID["pulp"].group))
    for fdi in tf3.FDI_NUMBERS:
        st = L.BY_FDI.get(fdi)
        if st is not None:
            out.append(ComparisonClass(st.id, (fdi,), (st.index,), st.group))
    return out


def task1_to_merged_lut():
    """LUT turning a ToothFairy3 Task-1 label map (0-46) into merged indices (0-47).

    This is a *conversion*, not a comparison: it is what lets a ToothFairy3
    prediction be rendered, meshed and exported by the same code that handles the
    three-model pipeline's output.

    Three mappings deserve to be stated out loud, because each is a place a silent
    error would put a contour on the wrong anatomy:

    1. **The jawbones are inverted.** ToothFairy3 numbers `1 = Lower Jawbone,
       2 = Upper Jawbone`; `labels.py` numbers `1 = maxilla, 2 = mandible`. A
       straight-through copy swaps the jaws and nothing downstream would complain.
    2. **Both inferior alveolar canals collapse into one.** The merged taxonomy has
       a single `canal`, so ToothFairy3's left (3) and right (4) both land on it.
       That is lossy and deliberate -- index 3 is what every stored job means by
       "canal", and splitting it is a migration rather than an addition.
    3. **Teeth go by FDI, never by index arithmetic.** Both sides number teeth by
       position, and both use a different contiguous packing, so the FDI number is
       the only safe intermediate.

    Anything unmapped stays 0, so a label this function does not know about is
    dropped rather than silently rendered as some other structure.

    **Caveat on the maxilla, measured on the holdout 2026-08-24.** ToothFairy3's
    "Upper Jawbone" is NOT the same extent as DentalSegmentator's "Maxilla & upper
    skull". Across the holdout its ground truth runs 0.00-1.40 cm3 against a Lower
    Jawbone of 51-58 cm3 -- it is a thin sliver, not a whole bone, and in several
    cases it is not annotated at all even though the field of view clearly contains
    the maxilla and its teeth. Mapping it onto `maxilla` therefore puts a ~1 cm3
    object under a name that the three-model pipeline uses for a ~100 cm3 one.
    They are kept mapped because they are the same anatomy, but any UI showing both
    sources side by side will show wildly different volumes for the same label.

    This used to claim `quality.PLAUSIBLE_CM3` would flag that "correctly". It would
    not: that table has entries for the mandible and the canal ONLY, and never had a
    maxilla one. A promised check that does not exist is worse than an absent one,
    because it stops anyone writing it. `quality.PLAUSIBLE_CM3` now carries a
    SOURCE-KEYED maxilla band for exactly this reason -- one band cannot serve a
    ~1 cm3 sliver and a ~100 cm3 cranium under the same label.
    """
    import numpy as np

    lut = np.zeros(tf3.TASK1_NUM_CHANNELS, dtype=np.uint8)
    for t1, merged in task1_to_merged_map().items():
        lut[t1] = merged
    return lut


def task1_to_merged_map() -> dict:
    """The same mapping as `task1_to_merged_lut`, as a `{Task-1 id: merged index}` dict.

    NUMPY-FREE, and that is the whole reason it exists. The array form is what the
    pipeline indexes a whole volume with; this is what the API needs -- it has neither
    numpy nor scipy (see `requirements-api.txt`), and `GET /v1/models` has to be able to
    say which merged structures a model owns. One source, two shapes: the array is now
    built from this dict, so the two cannot drift into disagreeing about which label is
    which -- which on this particular mapping means the jaws swapping over.
    """
    raw_to_merged = {
        1: "mandible",           # ToothFairy3 "Lower Jawbone" -- NOT maxilla
        2: "maxilla",            # ToothFairy3 "Upper Jawbone"
        3: "canal", 4: "canal",  # left + right IAC both fold into the single canal
        5: "sinus_max_left", 6: "sinus_max_right", 7: "pharynx",
        8: "bridge", 9: "crown", 10: "implant",
        103: "incisive_canal_left", 104: "incisive_canal_right", 105: "lingual_canal",
    }
    out = {}
    for raw, merged_id in raw_to_merged.items():
        out[int(tf3.TASK1_MAPPING[raw])] = int(L.BY_ID[merged_id].index)
    for task1_idx, fdi in tf3.TASK1_INDEX_TO_FDI.items():
        out[int(task1_idx)] = int(L.BY_FDI[fdi].index)
    # Pulp: ToothFairy3 collapses all 32 per-tooth pulps into one class, and so do we.
    out[int(tf3.TASK1_MAPPING[111])] = int(L.BY_ID["pulp"].index)
    return out

SPACES = {
    "merged-vs-tf3": merged_vs_toothfairy3,
    "tf3-task1": toothfairy3_task1,
    "tf3-task1-raw-gt": toothfairy3_task1_vs_raw_gt,
    "merged-vs-tf3-full": merged_vs_toothfairy3_full,
}


# --------------------------------------------------------------------------- #
# Foreign label spaces
#
# A model on the structure board emits its OWN ids and they have to become Task-1 ids
# before anything downstream is true: `cc_filter`'s thresholds are keyed by Task-1 id,
# `dental_box`/`canal_box` are Task-1-anchored, and `task1_to_merged_lut` is the only
# conversion the report and the meshes agree on.
#
# Every rule below DERIVES that mapping from the model's own `dataset.json` at load
# time, by anatomical NAME, and raises if a name does not resolve. It is deliberately
# not a table of id pairs: the ids are the thing most likely to move upstream, and a
# renumber absorbed silently produces a confident, self-consistent, entirely wrong
# result -- the maxilla drawn where the mandible is, or tooth 11 labelled 21.
# --------------------------------------------------------------------------- #

class ForeignLabelMismatch(RuntimeError):
    """A third-party model's labels no longer resolve to the space we measured it in."""


def _norm(name: str) -> str:
    """Loose name key: case, punctuation and spacing are not part of the identity."""
    return "".join(ch for ch in str(name).lower() if ch.isalnum())


def _task1_by_name() -> dict:
    """{normalised Task-1 label name: Task-1 id}, straight from the challenge's own list."""
    return {_norm(n): i for i, n in tf3.TASK1_LABELS.items() if i}


def _lut_from_names(labels: dict, *, rule: str, drop: frozenset = frozenset(),
                    extra=None):
    """Build a source-id -> Task-1-id LUT from a `dataset.json` labels dict.

    `labels` is nnU-Net's own `{name: id}`. `drop` names map to 0, meaning "this model
    predicts it but we take nothing from it" -- the canal specialist's inferior alveolar
    canal is exactly that: a context class that exists to give the network the parent
    structure at the branch point, while the base model keeps the class it already
    scores 0.90 on.
    """
    import numpy as np

    by_name = _task1_by_name()
    ids = [int(v) for v in labels.values()]
    lut = np.zeros(max(ids) + 1, dtype=np.uint8)
    unresolved = []
    for name, sid in labels.items():
        sid = int(sid)
        if sid == 0:
            continue
        key = _norm(name)
        if key in {_norm(d) for d in drop}:
            continue                                   # stays 0 on purpose
        t1 = (extra or {}).get(key) or by_name.get(key)
        if t1 is None:
            unresolved.append(name)
            continue
        lut[sid] = t1
    if unresolved:
        raise ForeignLabelMismatch(
            f"{rule}: {len(unresolved)} label(s) in this model's dataset.json do not "
            f"resolve to a ToothFairy3 Task-1 structure -> {unresolved[:6]}. Either the "
            f"model changed upstream or it is not the model this rule was written for; "
            f"either way it must not be composed until someone looks.")
    return lut


def task1_identity_lut(labels: dict):
    """A model that already emits Task-1 ids. Verified by name, never assumed."""
    lut = _lut_from_names(labels, rule="task1-identity")
    bad = [(n, int(i)) for n, i in labels.items()
           if int(i) and lut[int(i)] != int(i)]
    if bad:
        raise ForeignLabelMismatch(
            f"task1-identity: {len(bad)} label(s) sit on a different id than their name "
            f"means -> {bad[:6]}")
    return lut


def canal_roi_to_task1_lut(labels: dict):
    """Our own anterior-mandible specialist: 43/44/45, with the IAC as context only."""
    return _lut_from_names(labels, rule="canal-roi",
                           drop=frozenset({"Inferior Alveolar Canal"}))


def totalseg_to_task1_lut(labels: dict):
    """TotalSegmentator `Dataset113_ToothFairy3`.

    Their labels carry a `_fdiNNN` suffix, and NNN is the **raw ToothFairy3 id** rather
    than an FDI number -- `..._pulp_fdi111` is raw 111, not tooth 11. (An earlier version
    of this rule read it as FDI, took the first two digits of 111..142, and collapsed 32
    pulp classes onto 4 distinct numbers. The guard caught it on the first install, which
    is the whole reason the guard exists.)

    That suffix is a gift: it gives a SECOND, independent derivation. Every label is
    resolved both ways -- by raw id through `TASK1_MAPPING`, and by anatomical name with
    the suffix stripped -- and the two must agree. Two derivations agreeing is a much
    stronger statement than either alone, and it is what would catch an upstream that
    renamed a structure while keeping its id, or renumbered one while keeping its name.

    Pulp is the one real divergence: they keep 32 per-tooth classes where the challenge,
    and therefore we, merge to one. That many-to-one fold is asserted at exactly 32,
    because a PARTIAL fold would silently drop pulp on some teeth and nothing downstream
    would notice.
    """
    import re

    import numpy as np

    by_name = _task1_by_name()
    ids = [int(v) for v in labels.values()]
    lut = np.zeros(max(ids) + 1, dtype=np.uint8)
    unresolved, disagree, pulp = [], [], 0

    for name, sid in labels.items():
        sid = int(sid)
        if sid == 0:
            continue
        m = re.search(r"_fdi(\d+)$", str(name))
        raw = int(m.group(1)) if m else None
        stem = re.sub(r"_fdi\d+$", "", str(name))

        by_raw = tf3.TASK1_MAPPING.get(raw) if raw is not None else None
        # Pulp names carry the tooth's own anatomy ("upper_right_central_incisor_pulp"),
        # which resolves to that TOOTH by name; the raw id is what says it is pulp.
        is_pulp = stem.endswith("pulp")
        guess = 46 if is_pulp else by_name.get(_norm(stem))

        if by_raw is None and guess is None:
            unresolved.append(name)
            continue
        t1 = by_raw if by_raw is not None else guess
        if by_raw is not None and guess is not None and by_raw != guess:
            disagree.append((name, by_raw, guess))
        lut[sid] = t1
        pulp += int(t1 == 46)

    if unresolved:
        raise ForeignLabelMismatch(
            f"totalseg: {len(unresolved)} label(s) resolve neither by raw ToothFairy3 id "
            f"nor by name -> {unresolved[:6]}")
    if disagree:
        raise ForeignLabelMismatch(
            f"totalseg: {len(disagree)} label(s) where the raw id and the anatomical name "
            f"disagree -> {disagree[:4]}. One of the two moved upstream; this model is "
            f"not the one that was measured.")
    if pulp != 32:
        raise ForeignLabelMismatch(
            f"totalseg: expected 32 per-tooth pulp classes folding onto Task-1 46, "
            f"found {pulp}. A partial fold drops pulp on some teeth silently.")
    return lut


def toothseg_semantic_to_task1_lut(labels: dict):
    """MIC-DKFZ ToothSeg semantic: the 32 teeth, at our own 0.3 mm.

    Their labels are ANATOMICAL names -- "Upper Right Central Incisor" -- and those are
    letter-for-letter ToothFairy3's own Task-1 names, which is unsurprising: ToothSeg was
    trained on ToothFairy2 and ToothFairy3 is its superset. So the derivation is by name,
    with an FDI number accepted as an alternative if a future release adds one.

    The flat `+10` relation between their ids and ours is then asserted as a TRIPWIRE, not
    used as the derivation. Deriving from the offset would absorb an upstream renumber
    without a word, and shipping a different model than the one that was measured is the
    failure this whole section exists to prevent.
    """
    import re

    import numpy as np

    by_name = _task1_by_name()
    ids = [int(v) for v in labels.values()]
    lut = np.zeros(max(ids) + 1, dtype=np.uint8)
    seen, unresolved = [], []
    for name, sid in labels.items():
        sid = int(sid)
        if sid == 0:
            continue
        t1 = by_name.get(_norm(name))
        if t1 is None:
            m = re.search(r"(\d{2})", str(name))
            t1 = tf3.TASK1_FDI_TO_INDEX.get(int(m.group(1))) if m else None
        if t1 is None:
            unresolved.append(name)
            continue
        lut[sid] = t1
        seen.append((name, sid, t1))
    if unresolved:
        raise ForeignLabelMismatch(
            f"toothseg: {len(unresolved)} label(s) resolve to no ToothFairy3 tooth -> "
            f"{unresolved[:6]}")
    if len(seen) != 32:
        raise ForeignLabelMismatch(f"toothseg: expected 32 teeth, found {len(seen)}")
    off = [(n, s, t) for n, s, t in seen if s + 10 != t]
    if off:
        raise ForeignLabelMismatch(
            f"toothseg: the +10 relation no longer holds for {len(off)} label(s) -> "
            f"{off[:4]}. The mapping was re-derived by name and still works, but the "
            f"model is not the one that was measured -- re-score it before composing.")
    return lut


LABEL_RULES = {
    "task1-identity": task1_identity_lut,
    "canal-roi": canal_roi_to_task1_lut,
    "totalseg": totalseg_to_task1_lut,
    "toothseg": toothseg_semantic_to_task1_lut,
}


def assert_totalseg_alignment(labels: dict) -> None:
    """Raise unless TotalSegmentator still means what it meant when we measured it."""
    totalseg_to_task1_lut(labels)


def assert_toothseg_alignment(labels: dict) -> None:
    """Raise unless ToothSeg still means what it meant when we measured it."""
    toothseg_semantic_to_task1_lut(labels)
