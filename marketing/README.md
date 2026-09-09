# Marketing assets

Everything the root README embeds, plus the vertical cuts for social. All of it is
generated from the running app by scripts in `../scripts/` — nothing here is a mock-up,
a screenshot of a design file, or a frame anyone touched up by hand.

```
marketing/
  brand/      the wordmark and the 1200×630 card
  preview/    the animated GIF the README plays inline
  stills/     frames pulled from the two films
  video/      the two films, 16:9 master + 9:16 + 4:5
```

## The films

| file | what it shows | length |
|---|---|--:|
| `video/implantplan-plan.mp4` | Implant planning end to end: a real edentulous site, seeding, the fit loop, CLEAR → TIGHT → BREACH, the safety envelope. | 1:39 |
| `video/implantplan-pipeline.mp4` | The other half: upload, the model catalogue, segmentation, the findings report, the error budget, the structure list. | 1:34 |

`-9x16` and `-4x5` are the same master **placed** in a branded frame, never cropped or
upscaled. Cropping 1920×1080 to 9:16 gives 608×1080 blown up 1.78×, which is visibly soft
on exactly the readouts these films are about.

## Regenerating

Three steps per film, and the middle one is where the words live.

```bash
# implant planning
scripts/record_trailer.sh                                     # body-raw.mp4 + trailer-beats.json
venv/bin/python scripts/trailer_overlays.py \
  --beats /tmp/dentistry-trailer/trailer-beats.json \
  --out /tmp/dentistry-trailer --variant trailer
scripts/build_trailer.sh                                      # -> video/implantplan-plan.mp4

# the pipeline
scripts/record_pipeline.sh
venv/bin/python scripts/trailer_overlays.py \
  --beats /tmp/dentistry-pipeline/pipeline-beats.json \
  --out /tmp/dentistry-pipeline --variant pipeline
TRAILER_WORK=/tmp/dentistry-pipeline \
TRAILER_BEATS=/tmp/dentistry-pipeline/pipeline-beats.json \
TRAILER_STEM=implantplan-pipeline \
  scripts/build_trailer.sh /tmp/dentistry-pipeline/body-raw.mp4

# the README's animated preview, and the check that it shows what it claims
scripts/make_preview_gif.sh
```

`build_trailer.sh` writes straight into `video/`. Point `TRAILER_OUT` somewhere else to
try a cut without overwriting a published one.

## Getting a GitHub video player

The README's two players are **not** served from this folder, and cannot be. Measured
rather than assumed:

* `<video>` survives GitHub's sanitizer for any `src` — the `/markdown` API returns the
  tag intact for a relative path, `/raw/`, `raw.githubusercontent.com`, `?raw=1` and a
  release download alike.
* The **site's** render pipeline is stricter. On a real repo page all four repo-hosted
  candidates produced **zero** `<video>` elements in the DOM. Only an attachment URL
  survives, and GitHub rewrites it at render time into a signed
  `private-user-images.githubusercontent.com` URL — which is the whole mechanism.

Attachment URLs are minted only by GitHub's own uploader, so no commit, build step or
release upload can produce one. The recipe, when a film is re-cut and the players need
replacing:

1. Open `https://github.com/<owner>/<repo>/issues/new`.
2. Drag the mp4 into the comment box and wait for
   `<!-- Uploading "…" -->` to become a `https://github.com/user-attachments/assets/<uuid>`
   URL.
3. Copy the URL into the README's `<video src=…>`.
4. **Close the tab without submitting.** The issue is only a vehicle for the uploader;
   nothing needs to be posted.

Current URLs — `implantplan-plan.mp4` is `bbe04886-6f4b-4dca-b988-7674f9e9b1ad`,
`implantplan-pipeline.mp4` is `2b29ad19-3fae-4059-8a5c-7dcf145d2fd8`.

**Write only `src`, `controls` and `muted`.** Everything else is dropped: `poster`,
`playsinline` and `width` were all sanitized away, checked on the rendered element, and
GitHub sizes the player to the column itself (836 px) and sets its own `preload`. A
`poster` would have fixed the black opening frame — the title card fades up from black —
but the attribute does not survive, so the only way to change that thumbnail is to change
the first frame of the film.

Because those live outside the repository, the committed masters stay committed and the
in-repo GIF stays the hero. If an attachment URL ever stops resolving, the README loses
two players and keeps everything else.

## Rules these assets are held to

**The site is a real gap, and it is chosen by the case rather than by the script.** The
first cut named FDI 46 and 38 in `record_trailer.mjs` and was shot on a full-dentition
scan, so both "implant sites" still had a tooth standing in them — the app said so on
screen: *"tooth 38 is still present in this scan, so this may be the distance to the tooth
being replaced rather than to a neighbour"*. That is an extraction site, not an implant
site. The recorder now reads the chart's own `.absent` positions, keeps the posterior
mandibular ones, and requires `ridge.py` to have measured both a crest and a bone height
there — without a crest the implant falls back to the occlusal plane, which is a guess.
`scripts/find_edentulous_case.py` ranks candidate scans the same way.

**Numbers come out of the app, never off a keyboard.** Captions quote what the page
rendered — the fit line, the verdict level, the clearance in millimetres — and the
recorder fails rather than narrating a step that did not happen. This is not decoration:
a hand-typed `0.8887` sat in `record_pipeline.mjs` while the app, `dentistry/models.py`
and `eval/COMPARISON.md` all said `0.8965`, and it reached a delivered film. The score is
now scraped from the model card and asserted against `/^0\.\d{3,4}$/`.

**The films name no dataset and no model.** Models are Model A … Model G in capture, and
the case's dataset credit is stripped from the subtitle. The credit is not dropped — it
is on the end card, which is where an attribution belongs in a film rather than burned
into every frame of one. The root README carries the full licensing position.

**Every take is filmed on the real GPU, against the real API.** The recorders hard-fail
unless the WebGL renderer matches `/nvidia|geforce/i`, so a film cannot be shot on
SwiftShader; they refuse a debug port someone else is holding, because a run that
attached to an orphaned browser once ended silently at 40 s of 90 and assembled anyway.

**`make_preview_gif.sh` proves its own output.** The GIF has to show TIGHT, then BREACH,
then CLEAR, and the script reads the three verdicts back out of the rendered file by the
hue of the verdict chip — 42° amber, 342° red, 159° green, which are far enough apart to
tell apart by median. Slide a window one beat and it exits 1. That check exists because
the first cut put BREACH under a caption reading *"Inside the comfortable band."*

## Stills

`stills/plan/` and `stills/pipeline/` are extracted from the delivered masters, so they
carry the same anonymisation and the same numbers. An earlier batch that predated the
scrub fix is deliberately not here.

## Reuse

`brand/banner.png` is the 1200×630 card — README header, OG image, link preview. Its
anatomy is a render of real segmentation data, stylised; that sentence is set into the
image itself because the brand kit requires it to travel with the asset.
