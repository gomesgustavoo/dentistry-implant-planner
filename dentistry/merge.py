"""Combine the two source predictions into one label volume, and score them.

Priority, lowest to highest (later writes win):

    maxilla / mandible  ->  unnumbered teeth  ->  numbered teeth  ->  canal

Two of those orderings are decisions, not accidents:

* **Numbered teeth beat the jaws.** DentalSegmentator's jaw labels bleed into
  alveolar bone around the roots; ToothSeg is the model that was trained to
  find tooth boundaries.
* **The canal beats everything, including teeth.** Overlap should be almost
  nothing, but where two models disagree about nerve-versus-root the safer error
  in implant planning is to over-show the nerve. The overlap is counted and
  reported rather than silently resolved, so a large one is visible.
"""

from __future__ import annotations

from dataclasses import dataclass, field, asdict

import numpy as np

from . import labels as L


@dataclass
class MergeReport:
    voxels: dict[str, int] = field(default_factory=dict)  # structure id -> voxel count
    teeth_found: list[int] = field(default_factory=list)  # FDI numbers present
    unnumbered_upper_voxels: int = 0
    unnumbered_lower_voxels: int = 0
    canal_tooth_overlap_voxels: int = 0
    canal_jaw_overlap_voxels: int = 0
    tooth_agreement_dice: float | None = None
    tooth_only_in_toothseg_voxels: int = 0
    tooth_only_in_dentalseg_voxels: int = 0

    def to_dict(self) -> dict:
        return asdict(self)


ARCH_NONE, ARCH_UPPER, ARCH_LOWER = 0, 1, 2
ARCH_NAMES = {ARCH_UPPER: "upper", ARCH_LOWER: "lower"}


def arch_mask(dentalseg: np.ndarray) -> np.ndarray:
    """DentalSegmentator's per-voxel opinion about which arch a tooth voxel is in.

    Returned separately from `merge` rather than folded into the merged volume,
    because the merged volume cannot carry it: ToothSeg's numbered teeth overwrite
    exactly the voxels this is interesting for, so by the time `merge` returns, the
    arch of every numbered tooth voxel has been erased.

    It exists because the one tooth-numbering error this pipeline makes repeatably is
    an arch crossing. Measured across all four stored cases, 8 of the 19 extra
    connected components on numbered teeth were a lower-arch tooth sitting up in the
    maxilla against its own mirror-numbered counterpart -- tooth 31 beside tooth 21,
    33 beside 23, 42 beside 12, 43 beside 13 -- which is the two arches being confused
    where the incisors meet. Those are the small components (0.4-33.5 mm3). The 11
    same-arch ones are the large ones (8.8-326 mm3) and are not errors of this kind.

    Two independently trained models disagreeing about which jaw a voxel is in is the
    strongest evidence available here, since these scans have no ground truth. It is
    reported, never acted on: see `dentistry/quality.py::_check_arches`.
    """
    out = np.zeros(dentalseg.shape, dtype=np.uint8)
    out[dentalseg == L.DENTALSEG_UPPER_TEETH] = ARCH_UPPER
    out[dentalseg == L.DENTALSEG_LOWER_TEETH] = ARCH_LOWER
    return out


CONFLICT_NONE = 0
CONFLICT_TOOTHSEG_ONLY = 1
CONFLICT_DENTALSEG_ONLY = 2
CONFLICT_CANAL_TOOTH = 3
# There is deliberately no "canal over bone" value. `canal_jaw_overlap_voxels` above
# looks like a companion to `canal_tooth_overlap_voxels`, but the two are not alike:
# the canal and the jaws both come from DentalSegmentator, whose output is a single
# argmax label map, so those masks are mutually exclusive by construction and that
# counter is structurally always zero -- as it is on all three stored cases. Only the
# canal-versus-TOOTH overlap crosses models and can be non-zero. A channel value that
# cannot occur is not a conservative extra; it is a legend entry nobody will ever see
# light up, which reads as a check that never fires.
CONFLICT_NAMES = {
    CONFLICT_TOOTHSEG_ONLY: "Tooth model only",
    CONFLICT_DENTALSEG_ONLY: "Jaw model only",
    CONFLICT_CANAL_TOOTH: "Canal over tooth",
}
# Deliberately not in the structure palette: these are not anatomy, they are the
# seam between two opinions, and they are drawn on top of it.
CONFLICT_COLORS = {
    CONFLICT_TOOTHSEG_ONLY: "#22d3ee",
    CONFLICT_DENTALSEG_ONLY: "#f472b6",
    CONFLICT_CANAL_TOOTH: "#facc15",
}


def conflict_map(dentalseg: np.ndarray, toothseg: np.ndarray) -> np.ndarray:
    """Where the two models contradict each other, as its own label volume.

    The merged volume is one uint8 per voxel, so by construction it cannot show an
    overlap: every contradiction below is resolved by the precedence order at the
    top of this file and then invisible. Three of the four are erased outright --
    ToothSeg-only voxels win the argmax and read as ordinary tooth, and both canal
    overlaps are overwritten by the canal, which beats everything. The fourth is
    the one users do see, as `*_teeth_unnumbered`, and measurement says it is
    mostly not a missing tooth at all: 60-94% of it lies within 1 mm of a numbered
    tooth, which is the two models disagreeing about where a tooth ends.

    So this is a second channel, drawn over the first on request. It answers "are
    these structures conflicting where the models are summed" with the actual
    voxels rather than a count, and it changes nothing about what is exported.

    Same shape as the inputs, uint8, and sparse enough to gzip to near nothing.
    """
    ds_teeth = (dentalseg == L.DENTALSEG_UPPER_TEETH) | (dentalseg == L.DENTALSEG_LOWER_TEETH)
    ds_canal = dentalseg == L.DENTALSEG_CANAL
    ts_any = toothseg > 0

    out = np.zeros(dentalseg.shape, dtype=np.uint8)
    # Written in the merge's own precedence order, so the last write wins here for
    # the same reason it wins there and the two stay consistent.
    out[ts_any & ~ds_teeth] = CONFLICT_TOOTHSEG_ONLY
    out[ds_teeth & ~ts_any] = CONFLICT_DENTALSEG_ONLY
    out[ds_canal & ts_any] = CONFLICT_CANAL_TOOTH
    return out


def conflict_catalog() -> dict:
    """What the viewer needs to colour and label the second channel."""
    return {
        str(v): {"id": f"conflict_{v}", "name": CONFLICT_NAMES[v], "color": CONFLICT_COLORS[v]}
        for v in sorted(CONFLICT_NAMES)
    }


def merge(dentalseg: np.ndarray, toothseg: np.ndarray) -> tuple[np.ndarray, MergeReport]:
    """Merge two same-shape integer label volumes into the 37-structure taxonomy."""
    if dentalseg.shape != toothseg.shape:
        raise ValueError(f"shape mismatch: dentalseg {dentalseg.shape} vs toothseg {toothseg.shape}")

    rep = MergeReport()
    out = np.zeros(dentalseg.shape, dtype=np.uint8)

    ds_maxilla = dentalseg == L.DENTALSEG_MAXILLA
    ds_mandible = dentalseg == L.DENTALSEG_MANDIBLE
    ds_upper = dentalseg == L.DENTALSEG_UPPER_TEETH
    ds_lower = dentalseg == L.DENTALSEG_LOWER_TEETH
    ds_canal = dentalseg == L.DENTALSEG_CANAL
    ts_any = toothseg > 0

    out[ds_maxilla] = L.MERGED_MAXILLA
    out[ds_mandible] = L.MERGED_MANDIBLE

    # Tooth voxels DentalSegmentator found that ToothSeg did not number. Dropping
    # them would silently lose deciduous teeth and ToothSeg misses.
    upper_unnumbered = ds_upper & ~ts_any
    lower_unnumbered = ds_lower & ~ts_any
    out[upper_unnumbered] = L.MERGED_UPPER_UNNUMBERED
    out[lower_unnumbered] = L.MERGED_LOWER_UNNUMBERED
    rep.unnumbered_upper_voxels = int(upper_unnumbered.sum())
    rep.unnumbered_lower_voxels = int(lower_unnumbered.sum())

    for ts_index, fdi in L.TOOTHSEG_INDEX_TO_FDI.items():
        m = toothseg == ts_index
        n = int(m.sum())
        if n:
            out[m] = L.BY_FDI[fdi].index
            rep.teeth_found.append(fdi)
    rep.teeth_found.sort()

    rep.canal_tooth_overlap_voxels = int((ds_canal & ts_any).sum())
    rep.canal_jaw_overlap_voxels = int((ds_canal & (ds_mandible | ds_maxilla)).sum())
    out[ds_canal] = L.MERGED_CANAL

    for s in L.STRUCTURES:
        n = int((out == s.index).sum())
        if n:
            rep.voxels[s.id] = n

    # Cross-model agreement on "is this voxel a tooth", the one quality signal
    # available with no ground truth: two independently trained models, one
    # trained on ToothFairy2 and one on 470 scans from elsewhere, either agree
    # about where the teeth are or they do not.
    ds_teeth = ds_upper | ds_lower
    inter = int((ds_teeth & ts_any).sum())
    a, b = int(ds_teeth.sum()), int(ts_any.sum())
    rep.tooth_agreement_dice = (2.0 * inter / (a + b)) if (a + b) else None
    rep.tooth_only_in_toothseg_voxels = b - inter
    rep.tooth_only_in_dentalseg_voxels = a - inter
    return out, rep
