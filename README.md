# Dentistry CBCT — segmentation and implant planning

A cone-beam CT segmentation service with a browser implant planner. One model on one GPU
segments both jaws, every tooth in FDI notation, the mandibular canal and the sinuses,
airway and nerve canals around them; the planner places implants against that anatomy and
grades each clearance **with the segmentation's own measured error subtracted**.

Live at <https://dentistry.dicomsegvr.com>. Research preview — **not a medical device and
not for diagnostic use**.

## What makes it different

Every competitor draws a nerve and reports a distance to it. None of them says how wrong
that nerve might be.

This one does. On a 20-case holdout the inferior alveolar canal's boundary sits up to
**0.46 mm inside the truth at the 95th percentile** (worst single voxel 5.10 mm); the
incisive and lingual canals are 2–3× worse. Every clearance is graded as
`measured − that structure's own inward p95` against the margin, per structure, and a
measurement that carries a caveat is refused a verdict rather than given a hopeful one.

The solid it measures is a capsule of the stated diameter and length. The 3-D view draws
a threaded screw **strictly inside** that capsule — asserted, not asserted-by-comment:
every drawn vertex is inside the measured envelope to 4e-6 mm, and the thread crest
touches it to 2e-8 mm. So the picture can only ever occupy less space than the number.

## What it lets you do

**Place an implant and get graded distances.** Buccolingual and mesiodistal angulation
plus clocking, in the two planes each one is visible in: the cross-section draws the
buccolingual angle at true angle and the mesiodistal one foreshortened by exactly
`cos(yaw)` — the orthogonal projection of a capsule is a capsule, so that is exact
rather than approximate — and the panoramic is the other way round. Clocking is carried,
drawn, and **stated to change no measurement**, because the measured solid is a body of
revolution about the axis.

**Correct the mask, and every number is recomputed from the correction.** Cornerstone's
labelmap tools on the MPR panes; on apply, the worker rebuilds the distance fields, the
meshes, the outlines, the structure set and the per-site bone heights. What it does not
rebuild is stated in the artifact rather than assumed: the arch curve and the section
list are frozen so a saved plan's coordinates keep meaning the same place, and the
greyscale is the scan. And because the mask a browser can edit is the downsampled display
copy, an edited contour's error budget is **widened by half a display voxel** — 0.46 mm
of model error plus 0.30 mm of grid quantisation on a real case — with the arithmetic
printed beside the number. A hand-drawn contour is not automatically a more accurate one.

**Choose which models run on your upload.** A base model paints the whole taxonomy and
specialists overwrite only the Task-1 ids they own, with every voxel outside a
specialist's region asserted byte-identical to the base prediction on every case. The
picker shows what each model owns, what is measured about it, and whether it is installed
at all — availability is reported by the worker, never guessed — and a request for a model
this deployment does not have is **refused before the upload is written** rather than
quietly downgraded.

## Layout

| | |
|---|---|
| `api/` | FastAPI. Jobs, files, plans, measurement. Deliberately **numpy-free** — a subprocess test asserts it. |
| `worker/` | The GPU pipeline, a host systemd unit rather than a pod. Segmentation, meshes, RTSTRUCT, panoramic + cross-sections, the measurement pack. |
| `dentistry/` | The domain: label taxonomy, arch fitting, ridge measurement, implant geometry, clearance metrics, the safety grader. |
| `web/` | The app. Vanilla JS, no build step. |
| `viewer/` | Cornerstone3D + vtk.js, bundled by esbuild into `web/viewer.js`. |
| `web-auth/` | OIDC bundle, and the two headless gates. |
| `tests/`, `scripts/`, `eval/` | Phantom tests, generators, and the evaluation write-ups. |

## Gates

Nothing here is asserted by comment if it can be asserted by a check.

```bash
./venv/bin/python -m pytest tests/test_phantom.py -q   # geometry and safety, numpy-free API included
node web-auth/check-app.js                             # static wiring, palettes, CSS contracts
node web-auth/check-rail.mjs                           # 114 rendered states in real Chrome
node web-auth/check-rail.mjs --prove                   # every assertion proven to fail when broken
node web-auth/check-rail.mjs --selftest                # the JS coordinate map against Python's vectors
node viewer/check-bundle.mjs                           # the bundle kept every behaviour it had
node viewer/check-equivalence.mjs                      # browser vs Python geometry, on a real GPU
```

`--prove` is the one worth knowing about: an assertion that cannot be shown to fail is
treated as a bug, because this repo has shipped vacuous ones before.

## What is not in this repository

- **Model weights** (~2.2 GB). Trained on
  [ToothFairy3](https://toothfairy3.grand-challenge.org/), which is **CC BY-NC-SA 4.0**,
  so anything derived from it is research and non-commercial use only.
- **Patient volumes and job results.**
- **Evaluation dumps** (~1 GB of per-case `.npy`). The metrics and the write-ups that
  cite them are committed.
- **Harness fixtures derived from a CBCT** — two JPEGs and their manifests. Regenerate
  with `scripts/make_web_fixtures.py <results-dir>`; without them `check-rail.mjs` cannot
  render a section.
- **Secrets.** `.worker.env` is git-ignored; the k8s manifests reference a cluster Secret
  by name and carry no values.

## Licensing

No licence is granted on this code yet — all rights reserved until one is chosen.

Separately: the segmentation model derives from ToothFairy3 (CC BY-NC-SA 4.0), and the
running service says so in its own footer. That constrains the *model*, not this source.
