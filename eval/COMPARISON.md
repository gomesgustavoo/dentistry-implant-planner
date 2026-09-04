# What the serving model scores, and how that was re-established

*Rebuilt 2026-09-01, after the project tree was destroyed and `eval/` was lost entirely.
Every number below was re-measured on this box; none is transcribed from the record.*

All rows: the 20-case ToothFairy3 holdout (`/mnt/mldata/tf3/holdout`, seed 42), scored by
`scripts/eval_dice.py --space tf3-task1-raw-gt`, predicted by `scripts/tf3_predict.py` —
which calls `worker.pipeline.segment_task1`, **the same function `worker/main.py` calls**,
so the composition graded here is the composition the product runs.

## Two denominators, and reading only one is how a finding gets retracted

`Dice·GT` averages over cases where the **ground truth has** the class — delineation.
`Dice·scored` also counts cases where the model predicted a class the truth does not
have, at 0 — the detection cost. A model that never abstains wins the first and loses the
second, and on the partially annotated classes here the two differ by up to 0.13.

## The component filter, and a defect that cost 0.029

| run | strict Dice | strict HD95 | NSD | challenge Dice |
|---|--:|--:|--:|--:|
| base + canal board, **filter inert** | 0.8001 | 1.06 mm | 0.9712 | 0.8565 |
| base + canal board, **p2 filter** | **0.8292** | 1.23 mm | 0.9736 | **0.8965** |
| *the pre-deletion published figure* | *0.8330* | *1.08 mm* | — | *0.8919* |

The first row is not a variant worth having — it is the bug. The threshold table rebuilt
after the deletion took the 2nd percentile over **every** connected component in the
training annotations, and ground truth is not clean: the lower jawbone has **17 733
components across 512 cases, about 34 per case where anatomy has one.** The rest are
single-voxel specks. So every threshold came out as **1 voxel** and the filter removed
nothing.

The statistic has to be the **largest component per case** — the structure the annotator
actually drew. With that, p2 spans 44 voxels (lingual canal) to 881 756 (lower jawbone),
and the run lands within 0.004 of the published strict figure while **beating** its
challenge figure by 0.005. `scripts/tf3_cc_thresholds.py` now warns loudly if any p2
threshold lands at ≤1.

## Per class

| structure | Dice·GT | Dice·scored | n | missed | spurious | inward p95 |
|---|--:|--:|--:|--:|--:|--:|
| Lower Jawbone | 0.9401 | 0.9401 | 20 | 1 | 0 | 0.30 mm |
| Left Inferior Alveolar Canal | 0.9008 | 0.9008 | 20 | 0 | 0 | 0.46 mm |
| Right Inferior Alveolar Canal | 0.9009 | 0.9009 | 20 | 0 | 0 | 0.37 mm |
| Pharynx | 0.9312 | 0.9312 | 20 | 1 | 0 | 0.40 mm |
| **lower teeth** (16) | 0.9471 | 0.9471 | | 6 | 0 | |
| **upper teeth** (16) | 0.8594 | 0.7870 | | 19 | 17 | |
| Pulp | 0.8684 | 0.8684 | 19 | 0 | 0 | 4.53 mm |
| Left Maxillary Sinus | 0.8772 | 0.8772 | **2** | 0 | 0 | 1.52 mm |
| Upper Jawbone | 0.8015 | 0.6679 | 10 | 0 | 2 | 9.91 mm |
| Left Mandibular Incisive Canal | 0.6864 | 0.6864 | 20 | 0 | 0 | 0.99 mm |
| Lingual Canal | 0.6972 | 0.6972 | 20 | 0 | 0 | 1.11 mm |
| Right Mandibular Incisive Canal | 0.6417 | 0.5776 | 18 | 0 | 2 | 1.06 mm |

Three things this table says that a single mean does not:

* **The inferior alveolar canals reproduce the published 0.9009 / 0.9011 to four
  decimals**, which is the strongest single check that the rebuilt worker is the same
  worker.
* **The upper/lower tooth gap is 0.088 on `Dice·GT` and 0.160 on `Dice·scored`.** Almost
  all of it is detection, not delineation, and it tracks the annotation rate: upper teeth
  are labelled in 27–60% of training cases, lower teeth in 52–92%.
* **`Upper Jawbone`'s inward p95 is 9.91 mm** — an order above every other structure.
  That is the FOV-limited behaviour `labels.FOV_LIMITED` exists for: the annotation's
  boundary is the edge of the scan, so the "error" is measured against a scan edge. It is
  shown, exported, and forbidden as a surgical measurement.

The maxillary sinus appears in **2 of 20** cases. Treat 0.8772 as an anecdote.

## The canal specialist

Composed by `worker/board.py` into an anterior-mandible ROI derived from the base model's
own predicted mandible, with every voxel outside the box asserted byte-identical and
`assert_owns_only` asserting that only ids it owns changed inside it.

Its three classes score 0.686 / 0.642 / 0.697 here, reproducing the pre-deletion
0.69 / 0.64 / 0.70. The plain variant ships rather than the Skeleton-Recall one: in
distribution it gained +0.0505 / +0.0874 / +0.0172 Dice and corrected the predicted
volume from 155–205% of ground truth to 99–111%.

## Third-party models

See `eval/ownership.md`. In short, and stated before the numbers: **our holdout cannot
grant ownership to either of them.** TotalSegmentator trained on the public ToothFairy3
release and ToothSeg on ToothFairy2, a subset of it, while this holdout is a split we made
out of that same release. A win here is uninterpretable; only a loss is evidence.
