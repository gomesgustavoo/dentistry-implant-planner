"""The per-class connected-component filter, in Task-1 id space.

The single biggest post-processing lever this model has: challenge Dice +0.056 and
HD95 72.4 -> 41.8 voxels at the 2nd percentile of the training set's own component
volumes. It replaces an older `remove_small_islands` entirely.

**Two invariants, and both stop being true one step later in the pipeline.**

1. The thresholds are keyed by **Task-1 id**, so this must run BEFORE the crosswalk
   to the merged taxonomy.
2. They are **voxel counts at 0.027 mm3**, so this must run on the 0.3 mm plan grid,
   not on the case's own grid.

The exemption list is derived from `labels.NO_COMPONENT_FILTER` THROUGH the
crosswalk rather than restated here, so the two taxonomies cannot drift. Exempting
the canals is worth +0.046 and +0.036 Dice on the left and right inferior alveolar
canal, and it prevents both being deleted outright in 1 case of 20: a thin tube
that a partial-volume gap has broken into three pieces is still a canal, and each
piece is small enough to look like an island.

**The statistic and its application used to disagree, and it destroyed real
anatomy.** `scripts/tf3_cc_thresholds.py` records the LARGEST component per case --
a prior on how big the whole structure is, at the 2nd percentile over 512
annotations -- and this module applied that number to EACH component
independently. Those are different quantities. Measured over the 20-case holdout,
spurious classes fell 81 -> 23 but **missed classes rose 2 -> 28**, and on
`ToothFairy3F_043` the entire lower jawbone was deleted: 501,559 predicted voxels
against a 521,383-voxel ground truth and a threshold of 881,756, as a SINGLE
connected component. Dice 0.9740 -> 0.0000.

It also disabled a second model. The filter runs before the board, and
`worker/board._roi_box` anchors the canal specialist on `tf3.canal_box(mandible)`,
which returns None with no mandible -- so the specialist was skipped and Task-1
43/44/45 reverted to the base model's opinion. Specialist skipped 0/21 -> 1/20. No
Dice table on this filter alone can show that; only the board report can.

So `apply` now has two rules ahead of the per-component threshold, and the first
is not a tuned knob -- it is the only application of the table consistent with how
the table was built:

* **abstain** when the class's own largest component is BELOW the threshold. The
  table describes whole structures; a case whose largest component is smaller than
  the smallest whole structure in 512 annotations is outside the distribution the
  table describes, and the table has no jurisdiction over it. Delete nothing and
  say so.
* **a class floor**, which is a statement about resolution rather than anatomy: if
  a class's TOTAL mass is under `min(CLASS_FLOOR_VOXELS, its own p0.5)`, it is
  specks and goes. The per-class term exists so the absolute number can never
  exceed what the annotators demonstrated is possible.

Both are audited per case, because "the filter abstained" and "the filter found
nothing to remove" are different facts.
"""
from __future__ import annotations

import json
import logging
from pathlib import Path

import numpy as np

log = logging.getLogger(__name__)

# A component under 13.5 mm3 at 0.027 mm3/voxel cannot be a whole tooth: the smallest
# tooth any of the 512 annotators drew is 720 voxels (Task-1 5, at p0.5), so 500 sits
# well below it. Capped per class by that class's own p0.5 in `class_floor_for`, so the
# absolute number can never exceed what the annotations demonstrate is possible -- four
# classes have a p0.5 under 500 (Task-1 45 at 25, 44 at 82, 46 at 101, 2 at 243).
CLASS_FLOOR_VOXELS = 500


def _merged_to_task1() -> dict[int, set[int]]:
    from dentistry import crosswalk

    lut = crosswalk.task1_to_merged_lut()
    out: dict[int, set[int]] = {}
    for t1, merged in enumerate(lut):
        if merged:
            out.setdefault(int(merged), set()).add(int(t1))
    return out


def exempt_task1_classes() -> set[int]:
    """Task-1 ids never island-filtered: the thin tubes."""
    from dentistry import labels as L

    m2t = _merged_to_task1()
    return {t for idx in L.NO_COMPONENT_FILTER for t in m2t.get(int(idx), ())}


def single_component_task1_classes() -> set[int]:
    """Task-1 ids that are anatomically ONE object, so keep-largest is legal."""
    from dentistry import labels as L

    m2t = _merged_to_task1()
    return {t for idx in L.SINGLE_COMPONENT for t in m2t.get(int(idx), ())}


def load_thresholds(path, percentile: float = 2.0) -> dict[int, int]:
    """`{task1_id: minimum voxels}` from a built table, or an empty dict.

    An empty dict means "filter nothing", which is the honest degradation: a
    missing table must not silently become a guessed threshold that deletes real
    anatomy. It is logged loudly instead.
    """
    p = Path(path)
    if not p.exists():
        log.warning("no component-threshold table at %s -- nothing will be filtered", p)
        return {}
    table = json.loads(p.read_text())
    key = f"p{percentile:g}"
    by_pct = table.get("percentiles", {})
    if key not in by_pct:
        log.warning("threshold table has no %s (has %s) -- nothing will be filtered",
                    key, ", ".join(sorted(by_pct)) or "nothing")
        return {}
    return {int(k): int(v) for k, v in by_pct[key].items()}


def class_floor_for(t1: int, floors: dict[int, int] | None) -> int:
    """`min(CLASS_FLOOR_VOXELS, this class's own p0.5)`, the speck floor for one class.

    The absolute term says a component this small cannot be a whole structure. The
    per-class term stops that absolute number from exceeding what the 512 annotations
    demonstrate is possible for the classes whose smallest whole instance is under it.
    """
    own = (floors or {}).get(int(t1))
    return min(CLASS_FLOOR_VOXELS, int(own)) if own else CLASS_FLOOR_VOXELS


def apply(seg: np.ndarray, thresholds: dict[int, int], exempt: set[int] | None = None,
          single_component: bool = True, floors: dict[int, int] | None = None
          ) -> tuple[np.ndarray, dict[int, int], list[dict]]:
    """Filter in place. Returns `(seg, {task1_id: voxels_removed}, audit)`.

    Passes, in this order:

    * **keep-largest** for the anatomically-single structures, minus anything
      exempt. This is worth +0.0000 Dice on the holdout and removes 0.013 cm3 per
      case -- it is here for the tall-volume case, where a stray component 10 cm
      away cut HD95 from 10.28 mm to 1.11 mm.
    * **class floor**: a class whose whole predicted mass is specks goes entirely.
    * **abstain**: a class whose largest component is below the threshold is left
      alone, because the threshold does not describe it. See the module docstring.
    * **size threshold** per component, for everything the table does describe.

    `audit` is one dict per class the filter made a decision about, so a deletion or
    an abstention can be read off the report rather than inferred from a Dice drop.
    """
    from scipy import ndimage

    exempt = set(exempt if exempt is not None else exempt_task1_classes())
    removed: dict[int, int] = {}
    audit: list[dict] = []

    if single_component:
        for t1 in sorted(single_component_task1_classes() - exempt):
            mask = seg == t1
            if not mask.any():
                continue
            lab, n = ndimage.label(mask)
            if n <= 1:
                continue
            sizes = ndimage.sum(mask, lab, range(1, n + 1))
            keep = int(np.argmax(sizes)) + 1
            drop = mask & (lab != keep)
            cnt = int(drop.sum())
            if cnt:
                seg[drop] = 0
                removed[t1] = removed.get(t1, 0) + cnt
                audit.append({"task1": int(t1), "action": "keep_largest",
                              "removed_voxels": cnt, "components": int(n),
                              "reason": "anatomically one object"})

    for t1, minimum in sorted(thresholds.items()):
        if t1 in exempt or minimum <= 0:
            continue
        mask = seg == t1
        if not mask.any():
            continue
        lab, n = ndimage.label(mask)
        if n == 0:
            continue
        sizes = ndimage.sum(mask, lab, range(1, n + 1))
        total, largest = int(sizes.sum()), int(sizes.max())
        floor = class_floor_for(t1, floors)

        if total < floor:
            drop = mask
            cnt = int(drop.sum())
            seg[drop] = 0
            removed[t1] = removed.get(t1, 0) + cnt
            audit.append({
                "task1": int(t1), "action": "class_floor",
                "removed_voxels": cnt, "total_voxels": total,
                "largest_voxels": largest, "components": int(n), "floor": floor,
                "reason": f"the whole class is {total} voxels, under the {floor}-voxel "
                          f"speck floor for this class"})
            continue

        if largest < minimum:
            # The table's statistic is the largest component per case. A case whose
            # largest component is smaller than the smallest whole structure in the
            # training annotations is not described by it, so it is left alone.
            audit.append({
                "task1": int(t1), "action": "abstain",
                "removed_voxels": 0, "total_voxels": total,
                "largest_voxels": largest, "components": int(n),
                "threshold": int(minimum),
                "reason": "the largest component is below the smallest whole structure "
                          "the training annotations contain, so the threshold does not "
                          "describe this case"})
            continue

        small = np.flatnonzero(sizes < minimum) + 1
        if not small.size:
            continue
        drop = np.isin(lab, small)
        cnt = int(drop.sum())
        if cnt:
            seg[drop] = 0
            removed[t1] = removed.get(t1, 0) + cnt
            audit.append({
                "task1": int(t1), "action": "threshold",
                "removed_voxels": cnt, "total_voxels": total,
                "largest_voxels": largest, "components": int(n),
                "threshold": int(minimum), "removed_components": int(small.size),
                "reason": f"{int(small.size)} of {int(n)} components below "
                          f"{int(minimum)} voxels"})
    return seg, removed, audit


def table_voxel_mm3(path) -> float | None:
    """The voxel volume the thresholds are counted in, read from the table itself.

    Not from the case and not from a constant: the thresholds ARE voxel counts at the
    training spacing, so anything else would be a different unit wearing the same name.
    """
    p = Path(path)
    if not p.exists():
        return None
    sp = json.loads(p.read_text()).get("spacing")
    if not sp or len(sp) != 3:
        return None
    return round(float(sp[0]) * float(sp[1]) * float(sp[2]), 6)


def load_floors(path, percentile: float = 0.5) -> dict[int, int]:
    """`{task1_id: p0.5 voxels}` -- the smallest whole structure the annotations show."""
    p = Path(path)
    if not p.exists():
        return {}
    by_pct = json.loads(p.read_text()).get("percentiles", {})
    key = f"p{percentile:g}"
    if key not in by_pct:
        log.warning("threshold table has no %s -- the class floor falls back to the "
                    "absolute %d voxels", key, CLASS_FLOOR_VOXELS)
        return {}
    return {int(k): int(v) for k, v in by_pct[key].items()}
