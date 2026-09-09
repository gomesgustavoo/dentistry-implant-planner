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
| `video/implantplan-plan.mp4` | Implant planning end to end: a real edentulous site, seeding, the fit loop, CLEAR → TIGHT → BREACH, angulation with the 3-D turned by hand, the safety envelope. | 1:41 |
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
release upload can produce one.

**And the upload alone is not enough — the asset has to be POSTED.** This was got wrong
here once and it is worth writing down properly. Uploading through an issue composer and
then closing the tab without submitting yields a URL that works *for the account that
uploaded it* and 404s for everyone else, because GitHub only signs a URL for an asset
bound to something in the repository. An orphaned upload is bound to nothing.

The failure is invisible to the person who made it: check the page while signed in as the
uploader and the video plays, which is exactly how a broken README got verified as
working. What separates the two, on the rendered HTML:

```
# posted, and public -- GitHub rewrites to a signed URL
<video src="https://private-user-images.githubusercontent.com/.../....mp4?jwt=eyJ...">
# orphaned -- left as-is, and 404 to anyone but the uploader
<video src="https://github.com/user-attachments/assets/<uuid>">
```

So: `curl -sI https://github.com/user-attachments/assets/<uuid>` from a shell with no
session, or diff `curl -s <repo url> | grep -o '<video[^>]*'` against a repo whose videos
are known to work. Signed-in eyes cannot see this bug.

Until the assets are posted somewhere in the repo, the README uses poster stills linking
to the committed masters — GitHub renders its own player on an `.mp4` blob page, which
needs no attachment and works signed out.

**If you do post them, write only `src`, `controls` and `muted`.** Everything else is
dropped: `poster`, `playsinline` and `width` were all sanitized away, checked on the
rendered element, and GitHub sizes the player to the column itself (836 px) and sets its
own `preload`. `poster` not surviving is why the film's own first frame has to be the
poster — see below.

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

`brand/banner.png` is the 1200×630 card, and it does four jobs with one image: README
header, OG image, link preview, and **the opening frame of the implant film**. That last
one is why `build_trailer.sh` gives the title card no fade-in: frame 0 is the poster every
player shows before anyone presses play, and a half-second fade from black makes that
frame black. `poster` is stripped by GitHub's sanitizer, so the only lever on a video's
thumbnail is the first frame itself.

Its anatomy is a render of real segmentation data, stylised; that sentence is set into the
image itself because the brand kit requires it to travel with the asset.
