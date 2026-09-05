#!/usr/bin/env bash
# Burn the storyboard captions into the raw capture -> docs/tour.mp4
#
# Via an ASS SUBTITLE FILE, not a chain of `drawtext` filters. The drawtext version was
# written first and its `box=1:boxcolor=black@0.72` silently did not render: the whole
# chain goes through the shell as one `-vf` argument, every `:` inside it has to be
# escaped, and one wrong escape turns a style parameter into part of the previous value
# with no error. Fifteen captions meant fifteen chances to lose the background and no way
# to see which had gone until the video came out.
#
# A subtitle file has none of that. Styling is declared once, the text is quoted by the
# format rather than by the shell, and `subtitles=` takes exactly one filename.
#
# The beats come from `record_tour.mjs`, which stamps a timestamp as it drives each step,
# so the captions are aligned to what the recorder actually did rather than to a guess
# about how long each step took -- the steps are not evenly long, and a case mount is
# 24 s where a length change is 9.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

RAW="${1:-$ROOT/docs/tour-raw.mp4}"
BEATS="${2:-/tmp/dentistry-tour/beats.json}"
OUT="${3:-$ROOT/docs/tour.mp4}"
ASS="${TOUR_ASS:-/tmp/dentistry-tour/captions.ass}"

[ -f "$RAW" ] || { echo "no raw capture at $RAW"; exit 1; }
[ -s "$BEATS" ] || { echo "no beats at $BEATS"; exit 1; }

DUR="$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$RAW")"
W="$(ffprobe -v error -select_streams v:0 -show_entries stream=width -of csv=p=0 "$RAW")"
H="$(ffprobe -v error -select_streams v:0 -show_entries stream=height -of csv=p=0 "$RAW")"
echo "raw: ${W}x${H}, ${DUR}s"

BEATS="$BEATS" DUR="$DUR" W="$W" H="$H" ASS="$ASS" node -e '
const fs = require("fs");
const beats = JSON.parse(fs.readFileSync(process.env.BEATS, "utf8")).beats || [];
const dur = Number(process.env.DUR);
const W = Number(process.env.W), H = Number(process.env.H);
// The recorder stamps t=0 at its first beat, a beat or two after capture begins.
const OFFSET = Number(process.env.TOUR_OFFSET || 0.6);
const t = (s) => {
  s = Math.max(0, s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  const sec = (s % 60).toFixed(2).padStart(5, "0");
  return `${h}:${String(m).padStart(2, "0")}:${sec}`;
};
// &HAABBGGRR — ASS is BGR with an INVERTED alpha (00 opaque, FF transparent).
const head = `[Script Info]
ScriptType: v4.00+
PlayResX: ${W}
PlayResY: ${H}
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, OutlineColour, BackColour, Bold, Italic, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Tour,DejaVu Sans,${Math.round(H * 0.030)},&H00FFFFFF,&H00000000,&HB0000000,0,0,3,${Math.round(H*0.010)},0,2,60,60,${Math.round(H * 0.055)},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
const lines = beats.map((b, i) => {
  const from = b.at + OFFSET;
  const to = (i + 1 < beats.length ? beats[i + 1].at + OFFSET : dur) - 0.15;
  if (to <= from) return null;
  const text = String(b.caption).replace(/\n/g, " ").replace(/\{|\}/g, "");
  return `Dialogue: 0,${t(from)},${t(to)},Tour,,0,0,0,,${text}`;
}).filter(Boolean);
fs.writeFileSync(process.env.ASS, head + lines.join("\n") + "\n");
console.log(`${lines.length} captions -> ${process.env.ASS}`);
'

echo "== burning"
# `subtitles=` takes one filename; no per-caption escaping to get wrong.
ffmpeg -y -loglevel error -i "$RAW" \
  -vf "subtitles=${ASS}" \
  -c:v libx264 -preset slow -crf 20 -pix_fmt yuv420p -movflags +faststart \
  -an "$OUT"

ls -lh "$OUT"
ffprobe -v error -show_entries format=duration:stream=width,height -of default=nw=1 "$OUT"
