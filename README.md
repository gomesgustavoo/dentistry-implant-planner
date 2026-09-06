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

The safety envelope is drawn in the verdict's colour, at the surface the verdict is
actually computed against — `margin + inward_p95`, not the bare margin — and it carries
the **worst grade established over every structure**, not the canal's alone. Where nothing
could be graded it is a neutral shell, dimmer than any verdict: "we could not grade this"
must never be able to read as "clear".

**A new implant is seeded as a restoration, then fitted to the measurement.** The
diameter comes from the tooth the site is meant to replace — 3.3 mm at a lateral
incisor, 4.8 mm at a first molar — narrowed if the measured ridge cannot take it; the
length starts at the 10 mm a planner reaches for and is capped at 13 mm however much
bone there is. It is deliberately not "the largest fixture that fits", which is what the
seeding used to compute and no clinician would plan.

Then the seed is closed against the server's own answer rather than a proxy for it: the
implant is measured, and if the canal clearance does not come back clear it steps down
one catalogue length and measures again, up to three times. The card says which happened
— *shortened 2 sizes — the longest length that measures clear of the canal here*, or the
refusal that no catalogue length did. Any deliberate edit ends the loop, so it can never
fight the person using it.

**Correct the mask, and every number is recomputed from the correction.** Cornerstone's
labelmap tools in the right dock; on apply, the worker rebuilds the distance fields, the
meshes, the outlines, the structure set and the per-site bone heights. What it does not
rebuild is stated in the artifact rather than assumed: the arch curve and the section
list are frozen so a saved plan's coordinates keep meaning the same place, and the
greyscale is the scan.

And because the mask a browser can edit is the downsampled display copy, an edited
contour's error budget is **widened by half a display voxel**. The dock states that
arithmetic *before the stroke* — pick the mandibular canal and it reads
`0.46 mm model + 0.30 mm grid = 0.76 mm deducted from every clearance measured against
it`. A correction is a decision, and a hand-drawn contour is not automatically a more
accurate one.

**Choose which models run on your upload.** A base model paints the whole taxonomy and
specialists overwrite only the Task-1 ids they own, with every voxel outside a
specialist's region asserted byte-identical to the base prediction on every case. The
picker shows what each model owns, what is measured about it, and whether it is installed
at all — availability is reported by the worker, never guessed — and a request for a model
this deployment does not have is **refused before the upload is written** rather than
quietly downgraded.

## The anatomy beyond the teeth, and why it is switched off

The taxonomy has room for **89** structures: the 47 dental ones, plus 42 in a second id
space — the muscles of mastication and the tongue, the pharyngeal divisions, the nasal
cavities, the palate, the salivary glands, the orbit, the neck cartilages and the great
vessels — drawn by three Apache-2.0 TotalSegmentator head/neck models.

**All three ship `off`, because they were measured and they do not transfer.** They are
trained on CT in Hounsfield units; cone-beam CT has neither calibrated Hounsfield units
nor usable soft-tissue contrast. Across three holdout cases and 126 structure
opportunities, **one** survived the plausibility gate: the tongue came out at 1.76 cm³
against an anatomical 70–100, one masseter was found and the other was not inside a field
of view containing both, and the oropharynx arrived in 155 connected pieces.

What ships is the machinery, and it is worth having on its own:

- a **second composition space** that cannot reach the first. The extended pass paints
  only where the merged label is 0, so switching a soft-tissue model on is structurally
  incapable of moving a clearance, a verdict or an error budget;
- a **per-case transfer probe** — a same-family CT model scored against our own mandible —
  which passes at 0.85 and 0.82 on two cases and catches a total failure at 0.12 on a
  third;
- a **per-structure plausibility gate** on volume, connectedness and left/right symmetry,
  which is what caught the soft-tissue failure the probe missed, and which distinguishes
  "cut by a 123 mm field of view" from "present, in frame, and wrong".

That is what a model trained on CBCT would drop into. See `eval/extended.md` — the
threshold was committed before the numbers were measured.

## Layout

| | |
|---|---|
| `api/` | FastAPI. Jobs, files, plans, measurement. Deliberately **numpy-free** — a subprocess test asserts it. |
| `worker/` | The GPU pipeline, a host systemd unit rather than a pod. Segmentation, the extended pass, meshes, RTSTRUCT, panoramic + cross-sections, the measurement pack. |
| `dentistry/` | The domain: label taxonomy, the extended space, arch fitting, ridge measurement, implant geometry, clearance metrics, the safety grader. |
| `web/` | The app. Vanilla JS, no build step. |
| `viewer/` | Cornerstone3D + vtk.js, bundled by esbuild into `web/viewer.js`. |
| `web-auth/` | OIDC bundle, and the two headless gates. |
| `tests/`, `scripts/`, `eval/` | Phantom tests, generators, and the evaluation write-ups. |

The viewer is three panes: a rail of findings and provenance, the MPR/3-D stage, and a
right dock holding the contouring tools and the structure list. There is no separate
slice tab — the MPR panes show the same three planes from the same volume and
cross-reference each other, so it was a second and worse way to do what the tab beside it
already did.

The dock belongs to the MPR tab alone. Switching to implant planning takes it away
entirely, along with the button that opens it: there is no mask editing on that tab, and a
toolbar that cannot write is worse than no toolbar. The plan tab narrows the 3-D pane to
the anatomy the implant is graded against — the canals, the sinuses, the working jaw, the
teeth within 24 mm of the site and any restorations among them — and shows the whole case
when no implant is selected.

In the structure list a click isolates one structure and takes every pane to it;
⌘/Ctrl-click adds to the isolate rather than replacing it, so a canal and the two teeth
either side of a site can be up together. The 3-D camera then frames the union of what is
selected, and a selection spanning both arches is viewed straight from the buccal side
rather than tilted through one arch at the other.

## Gates

Nothing here is asserted by comment if it can be asserted by a check.

```bash
./venv/bin/python -m pytest tests/test_phantom.py -q   # geometry and safety, numpy-free API included
node web-auth/check-app.js                             # static wiring, palettes, CSS contracts
node web-auth/check-rail.mjs                           # 156 rendered states in real Chrome, 640-3440px
node web-auth/check-rail.mjs --prove                   # every assertion proven to fail when broken
node web-auth/check-rail.mjs --selftest                # the JS coordinate map against Python's vectors
node viewer/check-bundle.mjs                           # the bundle kept every behaviour it had
node viewer/check-equivalence.mjs                      # browser vs Python geometry, on a real GPU
```

`--prove` is the one worth knowing about: an assertion that cannot be shown to fail is
treated as a bug, because this repo has shipped vacuous ones before. It currently proves
12 of 12 — and not all twelve breaks are fixture edits: the multi-structure isolate is
guarded by a break that reverts the app to single-select at runtime, because no amount of
mutated JSON can exercise a defect that lives in a click handler.

Some things only fail while a volume is mounted, which the fixture harness never does.
`scripts/isolate_probe.mjs` is the pattern for those: it drives the real case in headless
Chrome on the real GPU and reads the answer back out of the viewer rather than off the
screen — for the isolate, that the camera's `parallelScale` actually grew to fit the
selection, which no screenshot comparison would catch.

## What is not in this repository

- **Model weights** (~2.8 GB). The base model is trained on
  [ToothFairy3](https://toothfairy3.grand-challenge.org/), which is **CC BY-NC-SA 4.0**,
  so anything derived from it is research and non-commercial use only. The three
  head/neck models are Apache-2.0 and are fetched by `scripts/prepare_models.py`.
- **Patient volumes and job results.**
- **Evaluation dumps** (~1 GB of per-case `.npy`). The metrics and the write-ups that
  cite them are committed.
- **Harness fixtures derived from a CBCT** — two JPEGs and their manifests. Regenerate
  with `scripts/make_web_fixtures.py <results-dir>`; without them `check-rail.mjs` cannot
  render a section.
- **Secrets.** `.worker.env` is git-ignored; the k8s manifests reference a cluster Secret
  by name and carry no values.
- **The tour recording.** `scripts/record_tour.sh` drives the real app in headless Chrome
  and stamps a caption timestamp at each step, `caption_tour.sh` burns them in from a
  subtitle file and `finish_tour.sh` adds the cards — three commands from a clean tree.
  The cut itself is not committed for the same reason the fixtures are not: it is a
  recording of a held-out ToothFairy3 case, and redistributing that imagery is a
  licensing decision this repository should not make on its own.

## Contact

**Gustavo Formento** — the author of this service.

- Email: <gustavo.formento@rtmedical.com.br>
- LinkedIn: [linkedin.com/in/gustavoogomesss](https://www.linkedin.com/in/gustavoogomesss/)
- GitHub: [github.com/gomesgustavoo](https://github.com/gomesgustavoo)

Open an issue for bugs; email for custom model work.

## Licensing

No licence is granted on this code yet — all rights reserved until one is chosen.

Separately: the segmentation model derives from ToothFairy3 (CC BY-NC-SA 4.0), and the
running service says so in its own footer. That constrains the *model*, not this source.
The three head/neck models are Apache-2.0 (wasserth/TotalSegmentator) and carry no such
restriction.
