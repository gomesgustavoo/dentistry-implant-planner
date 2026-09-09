#!/usr/bin/env bash
# The README hero: TIGHT -> BREACH -> CLEAR, as an animated GIF.
#
# WHY A GIF, when there is a 1080p master sitting next to it, and when GitHub does have a
# video player. Because the player is not reachable from a file in the repository.
#
# `<video>` survives GitHub's sanitizer -- that was measured, not assumed, via the
# `/markdown` API, which returns the tag intact for ANY src. But the site's own render
# pipeline then drops the element unless the src is an attachment URL
# (`github.com/user-attachments/assets/<uuid>`), which it REWRITES into a signed
# `private-user-images.githubusercontent.com/...` URL. Measured on a repo page: four
# candidate sources -- relative path, `/raw/`, `raw.githubusercontent.com`, `?raw=1` --
# produced zero <video> elements in the DOM; NVlabs/Eagle's attachment-backed page
# produced two, already rewritten to the signed host.
#
# Attachment URLs only come from GitHub's own uploader (drag a file into an issue or
# comment box), so they cannot be produced by a build step or a commit. A file committed
# to the repository can therefore never autoplay in a README. The GIF can, so the GIF is
# what moves on the page, and the master is one click behind it.
#
# WHY THESE THREE WINDOWS. The film's state changes a beat BEFORE the caption plate that
# names it -- the recorder drives the app, then the plate for that beat fades up. A window
# that straddles a plate boundary therefore shows BREACH underneath "Inside the
# comfortable band", which is the one thing this clip must not do. Each window here sits
# wholly inside one plate, on the state that plate is about. Verified per window, not
# assumed: the check at the bottom reads the verdict chip back out of the rendered GIF.
#
# The offsets are MASTER time, not body time. `build_trailer.sh` prepends a title card,
# so every beat in `trailer-beats.json` lands TRAILER_TITLE_S later in the file than the
# recorder logged it. Re-cut the film and these numbers move with it.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

SRC="${1:-marketing/video/implantplan-plan.mp4}"
OUT="${2:-marketing/preview/verdict-sequence.gif}"
WIDTH="${PREVIEW_WIDTH:-800}"
FPS="${PREVIEW_FPS:-12}"

[ -f "$SRC" ] || { echo "no master at $SRC -- run scripts/build_trailer.sh first"; exit 1; }
mkdir -p "$(dirname "$OUT")"

# start;duration  -- inside one plate each, on the state that plate names
WINDOWS=("71.9;3.6" "81.5;3.6" "91.3;2.7")

IN_ARGS=(); PRE=""; CAT=""
for i in "${!WINDOWS[@]}"; do
  w="${WINDOWS[$i]}"
  IN_ARGS+=(-ss "${w%%;*}" -t "${w#*;}" -i "$SRC")
  PRE+="[$i:v]fps=${FPS},scale=${WIDTH}:-2:flags=lanczos,setpts=PTS-STARTPTS[w$i];"
  CAT+="[w$i]"
done

# One palette across all three windows, generated from the concatenated stream. A palette
# per window makes the cuts flash, because the dark UI's greys get quantised differently
# on each side of the join. `stats_mode=diff` weights the pixels that actually move,
# which on this footage is the numerals and the verdict chips -- the only thing worth
# spending 200 colours on.
ffmpeg -v error -y "${IN_ARGS[@]}" -filter_complex "
    ${PRE}
    ${CAT}concat=n=${#WINDOWS[@]}:v=1:a=0,split[s0][s1];
    [s0]palettegen=max_colors=200:stats_mode=diff[p];
    [s1][p]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle
  " -loop 0 "$OUT"

printf '%-44s %s  %ss\n' "$OUT" \
  "$(du -h "$OUT" | cut -f1)" \
  "$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$OUT" | cut -c1-5)"

# The clip is three verdicts or it is not this clip, and this reads them back OUT of the
# rendered GIF rather than trusting the offsets above. Not by OCR -- by hue. The nerve
# canal's verdict chip is amber at TIGHT, red at BREACH and green at CLEAR, and those
# three sit far enough apart on the wheel (42 deg / 342 deg / 159 deg measured) that the
# median of the chip's saturated pixels tells them apart with room to spare. The p90 runs
# up to 250 deg because the card's violet border clips the crop; the median does not care,
# which is why it is the median.
#
# This is the assertion that catches a re-cut film sliding the windows onto the wrong
# beats -- the failure that shipped once already, as BREACH under a caption reading
# "Inside the comfortable band".
echo "== verdicts read back out of the GIF"
./venv/bin/python - "$OUT" <<'PY'
import colorsys, io, subprocess, sys
from PIL import Image

gif = sys.argv[1]
# label, midpoint of its window in the concatenated timeline, permitted hue arc
WANT = [
    ("TIGHT",  1.8, (25, 60)),
    ("BREACH", 5.4, (320, 375)),   # wraps zero; hues below 15 are read as +360
    ("CLEAR",  9.0, (130, 185)),
]
bad = []
for label, t, (lo, hi) in WANT:
    png = subprocess.run(
        ["ffmpeg", "-v", "error", "-ss", str(t), "-i", gif, "-frames:v", "1",
         # the nerve-canal chip alone, top row of the implant card
         "-vf", "crop=iw*0.10:ih*0.030:iw*0.762:ih*0.222", "-f", "image2", "-"],
        check=True, capture_output=True).stdout
    px = list(Image.open(io.BytesIO(png)).convert("RGB").getdata())
    hsv = [colorsys.rgb_to_hsv(r / 255, g / 255, b / 255) for r, g, b in px]
    hues = sorted(h * 360 for h, s, v in hsv if s > 0.35 and v > 0.35)
    if not hues:
        bad.append(f"{label}: no saturated pixel in the chip -- is the crop still on it?")
        continue
    med = hues[len(hues) // 2]
    if med < 15:
        med += 360
    ok = lo <= med <= hi
    print(f"   t={t:>4}s  hue {med:6.1f}  expect {lo}-{hi}  {label:<6} {'ok' if ok else 'WRONG'}")
    if not ok:
        bad.append(f"{label} at {t}s: hue {med:.1f} is outside {lo}-{hi}")
if bad:
    print("\nthe preview is not showing the three verdicts:")
    for b in bad:
        print("  -", b)
    sys.exit(1)
print("   TIGHT -> BREACH -> CLEAR, in that order.")
PY
