#!/usr/bin/env bash
# Cut the landing page's inline verdict loop out of the delivered implant film.
#
# The README plays a 527 KB GIF of these same three beats. A GIF is the right answer THERE
# -- a committed file is the only moving image a README can carry without an external URL --
# but the landing page is served by our own nginx, so it gets an h.264 loop instead: the
# same three windows, four times the pixels, a third of the bytes, and no 256-colour
# palette across a greyscale CBCT.
#
# The windows are `make_preview_gif.sh`'s, unchanged, and for its reasons: each sits INSIDE
# one caption plate, on the state that plate names, after it has faded up and before it
# fades out. The film's state changes a beat before its caption does, so a window picked off
# the caption alone lands on the previous verdict.
#
# Verified, not assumed: the verdict chip's hue is read back out of the rendered output and
# the script exits 1 if a window has slid off its beat. That check exists because the first
# cut of the GIF put BREACH under a caption reading "Inside the comfortable band."
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

SRC="${1:-marketing/video/implantplan-plan.mp4}"
OUT="${2:-landing/assets/verdict-loop.mp4}"
WIDTH="${LOOP_WIDTH:-1280}"

# start;duration -- TIGHT, BREACH, then back to CLEAR. The film's own order, and it ends on
# the resolution rather than on the failure.
WINDOWS=("55.0;3.6" "64.6;3.6" "74.3;3.0")
# The hue of the nerve-canal verdict chip in each window, measured off the 1920x1080
# master: 41.5 deg amber, 339.2 deg red, 163.6 deg green.
#
# The check below matches each window to its NEAREST nominal rather than to an absolute
# tolerance, and that is deliberate. Re-encoding at 1280 with yuv420p bleeds the chroma of
# a 45 px chip -- the breach chip reads 339 deg on the master and 6 deg here, a 24 deg
# shift that an absolute +/-18 band rejects while the window is perfectly on its beat.
# What actually discriminates a slid window is that the three verdicts are 120-160 deg
# apart, so that is what gets asserted: nearest-match, plus a separation floor. An absolute
# band would have been a check that fails on a correct cut, which is worse than no check.
HUES=(41.5 339.2 163.6)
NAMES=(TIGHT BREACH CLEAR)

[ -f "$SRC" ] || { echo "no master at $SRC"; exit 1; }
mkdir -p "$(dirname "$OUT")"

IN_ARGS=(); FILTER=""; CAT=""
for i in "${!WINDOWS[@]}"; do
  IFS=';' read -r start dur <<<"${WINDOWS[$i]}"
  IN_ARGS+=(-ss "$start" -t "$dur" -i "$SRC")
  FILTER+="[${i}:v]scale=${WIDTH}:-2:flags=lanczos,setsar=1,fps=25[v${i}];"
  CAT+="[v${i}]"
done

ffmpeg -v error -y "${IN_ARGS[@]}" \
  -filter_complex "${FILTER}${CAT}concat=n=${#WINDOWS[@]}:v=1:a=0[out]" \
  -map "[out]" -an \
  -c:v libx264 -profile:v high -level 4.0 -pix_fmt yuv420p \
  -crf 21 -preset slow -g 50 -keyint_min 50 -sc_threshold 0 \
  -color_primaries bt709 -color_trc bt709 -colorspace bt709 -color_range tv \
  -movflags +faststart "$OUT"

DUR=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$OUT")
SIZE=$(stat -c%s "$OUT")
echo "wrote $OUT  ${DUR}s  $((SIZE / 1024)) KB  ${WIDTH}px wide"

# ---------------------------------------------------------------- prove the verdicts
# Crop the nerve-canal chip out of the RENDERED loop and take the median hue of its
# saturated pixels. A file listing cannot see that a window slid; this can.
./venv/bin/python - "$OUT" "${HUES[*]}" "${NAMES[*]}" <<'PROBE'
import colorsys, subprocess, sys, tempfile, pathlib
from PIL import Image

out = pathlib.Path(sys.argv[1])
hues = [float(h) for h in sys.argv[2].split()]
names = sys.argv[3].split()
# One sample per window, a beat after it starts so the caption plate has faded up.
offsets = [1.8, 5.4, 9.0]
# The nerve-canal chip in the right rail, as fractions of the frame. Same box
# make_stills.sh and make_preview_gif.sh use, and it is correct for exactly one layout at
# one aspect -- if the app's rail ever moves, this moves with it.
BOX = (0.762, 0.222, 0.815, 0.246)


def circ(a, b):
    d = abs(a - b) % 360
    return min(d, 360 - d)


def median_hue(img):
    w, h = img.size
    px = img.crop((int(BOX[0] * w), int(BOX[1] * h),
                   int(BOX[2] * w), int(BOX[3] * h))).convert("RGB")
    data = px.get_flattened_data() if hasattr(px, "get_flattened_data") else px.getdata()
    hs = []
    for r, g, b in data:
        hh, ll, ss = colorsys.rgb_to_hls(r / 255, g / 255, b / 255)
        if ss > 0.35 and 0.2 < ll < 0.85:
            hs.append(hh * 360)
    if not hs:
        return None
    hs.sort()
    return hs[len(hs) // 2]


fail = 0
got = []
with tempfile.TemporaryDirectory() as td:
    for name, t in zip(names, offsets):
        f = pathlib.Path(td) / (name + ".png")
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-ss", str(t), "-i", str(out),
                        "-frames:v", "1", str(f)], check=True)
        got.append(median_hue(Image.open(f)))

# NEAREST-MATCH, not an absolute band, and the difference matters. Re-encoding at 1280 with
# 4:2:0 chroma bleeds a 45 px chip: breach reads 339 deg on the 1920 master and 6 deg here,
# a 27 deg shift on a colour that straddles zero. An absolute +/-18 band rejects that while
# the window is perfectly on its beat -- and a check that fails on a correct cut is worse
# than no check. What discriminates a SLID window is which verdict the hue is closest to,
# and the three nominals are 60-160 deg apart, so that is what gets asserted: nearest wins,
# and it wins by a margin rather than by a hair.
for name, g in zip(names, got):
    if g is None:
        print("FAIL " + name + ": no saturated pixels in the chip box")
        fail += 1
        continue
    dists = sorted(zip(names, [circ(g, w) for w in hues]), key=lambda x: x[1])
    nearest, best = dists[0]
    runner, second = dists[1]
    ok = nearest == name and (second - best) >= 5
    print(("ok   " if ok else "FAIL ") + name.ljust(6) +
          " chip hue %6.1f deg -> %s by %.0f deg over %s" % (g, nearest, second - best, runner))
    if not ok:
        fail += 1

if fail:
    print("\n%d check(s) failed -- a window has slid off the verdict it claims" % fail)
    sys.exit(1)
print("\nall three verdicts verified from the rendered file")
PROBE
