#!/usr/bin/env bash
# Burn the storyboard captions into the raw capture -> docs/tour.mp4
#
# The beats come from `record_tour.mjs`, which stamps a timestamp as it drives each step,
# so the captions are aligned to what the recorder actually did rather than to a guess
# about how long each step took. That matters because the steps are not evenly long: a
# case mount is 16 s and a filter keystroke is 4.
#
# Each caption shows from its own beat until the next one, in a band at the bottom. No
# fades: this is a product tour, and a caption that is arriving or leaving is a caption
# somebody is reading instead of looking at the thing it names.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

RAW="${1:-$ROOT/docs/tour-raw.mp4}"
BEATS="${2:-/tmp/dentistry-tour/beats.json}"
OUT="${3:-$ROOT/docs/tour.mp4}"

[ -f "$RAW" ] || { echo "no raw capture at $RAW"; exit 1; }
[ -s "$BEATS" ] || { echo "no beats at $BEATS"; exit 1; }

DUR="$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$RAW")"
echo "raw: $DUR s"

FILTER="$(BEATS="$BEATS" DUR="$DUR" node -e '
const fs = require("fs");
const beats = JSON.parse(fs.readFileSync(process.env.BEATS, "utf8")).beats || [];
const dur = Number(process.env.DUR);
// The recorder stamps t=0 at its first beat, which is a couple of seconds after ffmpeg
// starts. Nudging every caption by that offset keeps the words on the frame they belong
// to instead of one step early.
const OFFSET = Number(process.env.TOUR_OFFSET || 2.0);
const esc = (s) => s
  .replace(/\\/g, "\\\\\\\\")
  .replace(/:/g, "\\\\:")
  .replace(/'"'"'/g, "\\u2019")
  .replace(/,/g, "\\,")
  .replace(/%/g, "\\%")
  .replace(/—/g, "-");
const parts = [];
beats.forEach((b, i) => {
  const from = b.at + OFFSET;
  const to = (i + 1 < beats.length ? beats[i + 1].at + OFFSET : dur);
  if (to <= from) return;
  // A band behind the text, so a caption over a white cross-section is still readable.
  parts.push([
    "drawtext=text=" + "'"'"'" + esc(b.caption) + "'"'"'",
    "fontsize=44",
    "fontcolor=white",
    "box=1",
    "boxcolor=black@0.72",
    "boxborderw=26",
    "x=(w-text_w)/2",
    "y=h-190",
    `enable='"'"'between(t,${from.toFixed(2)},${to.toFixed(2)})'"'"'`,
  ].join(":"));
});
process.stdout.write(parts.join(","));
')"

echo "== burning ${#FILTER} chars of filter"
ffmpeg -y -loglevel error -i "$RAW" \
  -vf "$FILTER" \
  -c:v libx264 -preset slow -crf 21 -pix_fmt yuv420p -movflags +faststart \
  -an "$OUT"

ls -lh "$OUT"
ffprobe -v error -show_entries format=duration:stream=width,height -of default=nw=1 "$OUT"
