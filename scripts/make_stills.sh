#!/usr/bin/env bash
# Pull the marketing stills out of the two delivered masters -- and prove the plan ones
# are named after what they actually show.
#
# THE FILENAME IS A CLAIM. A still called `verdict-breach.jpg` shipped showing a CLEAR
# verdict at 4.43 mm, because it was carried over from a take whose timings had moved.
# Nothing catches that by looking at the file list, so the plan stills are re-derived
# here from the master and each one's verdict chip is read back by hue -- the same
# 42 deg amber / 342 deg red / 159 deg green separation `make_preview_gif.sh` relies on.
#
# Offsets are MASTER time: `build_trailer.sh` prepends a title card, so every beat sits
# TRAILER_TITLE_S later in the file than the recorder logged it. Re-cut a film and these
# move with it -- which is exactly what the hue check is here to notice.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PLAN="${PLAN_MASTER:-marketing/video/implantplan-plan.mp4}"
PIPE="${PIPELINE_MASTER:-marketing/video/implantplan-pipeline.mp4}"
OUT="${STILLS_OUT:-marketing/stills}"
WIDTH="${STILLS_WIDTH:-1440}"

for f in "$PLAN" "$PIPE"; do
  [ -f "$f" ] || { echo "no master at $f -- run scripts/build_trailer.sh first"; exit 1; }
done
mkdir -p "$OUT/plan" "$OUT/pipeline"

grab() {  # grab <master> <seconds> <path>
  ffmpeg -v error -ss "$2" -i "$1" -frames:v 1 \
    -vf "scale=${WIDTH}:-2:flags=lanczos" -q:v 3 -y "$3"
}

# name;seconds;expected verdict (or `--` for a shot with no chip to check).
# Master time = the recorder's beat + TRAILER_TITLE_S.
PLAN_SHOTS=(
  "seeded-clear;34.5;CLEAR"     # the clearance, first stated
  "error-budget;40.5;CLEAR"     # the model's own error subtracted
  "verdict-tight;56.5;TIGHT"    # seated 1.0 mm deeper
  "verdict-breach;66.0;BREACH"  # 1.5 mm deeper, refused
  "verdict-clear;76.0;CLEAR"    # back to the crest
  "angulation;82.5;CLEAR"       # tilt and yaw carried, the 3-D mid-turn
  "safety-envelope;86.5;--"     # the envelope in the verdict's colour
)
for s in "${PLAN_SHOTS[@]}"; do
  IFS=';' read -r name at _ <<<"$s"
  grab "$PLAN" "$at" "$OUT/plan/$name.jpg"
  echo "  plan/$name.jpg  @${at}s"
done

# No hue check applies to these -- there is no verdict chip on the pipeline film -- so
# they are checked by eye on a contact sheet instead, and the seconds are commented with
# what is supposed to be on screen so a re-cut is arguable rather than silent.
PIPE_SHOTS=(
  "model-catalogue;13.5"   # the picker, before a byte is sent
  "model-hover;20.5"       # hovering a card ghosts what that model does not own
  "trained-here;31.5"      # the two first-party models, and the base model's score
  "upload-plan;40.0"       # the runtime the plan commits to
  "findings-report;46.0"   # every quality check, passed or not
  "model-priors;54.0"      # the model's own measured error, per structure
  "structure-list;62.0"    # named, numbered, with volumes
  "exports;72.0"           # label map, RTSTRUCT, STL, printed sheet
  "segmentation;82.0"      # 37 structures out of one scan -- the result itself
)
for s in "${PIPE_SHOTS[@]}"; do
  IFS=';' read -r name at <<<"$s"
  grab "$PIPE" "$at" "$OUT/pipeline/$name.jpg"
  echo "  pipeline/$name.jpg  @${at}s"
done

echo "== verdict chips read back out of the plan stills"
./venv/bin/python - "$OUT/plan" "${PLAN_SHOTS[@]}" <<'PY'
import colorsys, pathlib, sys
from PIL import Image

out = pathlib.Path(sys.argv[1])
# hue arc per verdict; BREACH wraps zero, so hues under 15 are read as +360
ARC = {"TIGHT": (25, 60), "BREACH": (320, 375), "CLEAR": (130, 185)}
bad = []
for spec in sys.argv[2:]:
    name, _at, want = spec.split(";")
    if want == "--":
        continue
    im = Image.open(out / f"{name}.jpg").convert("RGB")
    w, h = im.size
    # the nerve-canal chip, top row of the implant card in the right rail
    chip = im.crop((int(w * 0.762), int(h * 0.222), int(w * 0.862), int(h * 0.252)))
    hues = sorted(
        colorsys.rgb_to_hsv(r / 255, g / 255, b / 255)[0] * 360
        for r, g, b in chip.getdata()
        if colorsys.rgb_to_hsv(r / 255, g / 255, b / 255)[1] > 0.35
        and colorsys.rgb_to_hsv(r / 255, g / 255, b / 255)[2] > 0.35
    )
    if not hues:
        bad.append(f"{name}: no saturated pixel in the chip -- has the layout moved?")
        continue
    med = hues[len(hues) // 2]
    if med < 15:
        med += 360
    lo, hi = ARC[want]
    ok = lo <= med <= hi
    print(f"   {name:<16} hue {med:6.1f}  expect {lo}-{hi}  {want:<6} {'ok' if ok else 'WRONG'}")
    if not ok:
        bad.append(f"{name}.jpg is not showing {want} (hue {med:.1f}, expected {lo}-{hi})")
if bad:
    print("\nstills are named after something they do not show:")
    for b in bad:
        print("  -", b)
    sys.exit(1)
print("   every plan still shows the verdict its filename claims.")
PY
