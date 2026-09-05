#!/usr/bin/env python
"""Title and end cards for the tour, drawn with PIL rather than ffmpeg's drawtext.

Same reason `caption_tour.sh` uses a subtitle file: a drawtext chain goes through the
shell as one argument, every `:` inside it needs escaping, and a wrong escape turns a
style parameter into part of the previous value with no error at all. Two cards with five
lines between them is not worth that. PIL draws them, ffmpeg only concatenates.

The palette is the app's own (`web/app.css`): the near-black ground, the violet accent and
the muted grey, so the cards read as part of the product rather than as something bolted
to the front of it.

    ./venv/bin/python scripts/tour_cards.py --out /tmp/dentistry-tour
"""
from __future__ import annotations

import argparse
import subprocess
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

GROUND = (10, 14, 19)
INK = (244, 247, 250)
MUTED = (147, 161, 184)
ACCENT = (139, 92, 246)

FONT_DIRS = [
    "/usr/share/fonts/truetype/dejavu",
    "/usr/share/fonts/truetype/liberation",
]


def _font(name: str, size: int):
    for d in FONT_DIRS:
        p = Path(d) / name
        if p.exists():
            return ImageFont.truetype(str(p), size)
    return ImageFont.load_default()


def _centre(draw, y, text, font, fill, w):
    box = draw.textbbox((0, 0), text, font=font)
    draw.text(((w - (box[2] - box[0])) / 2, y), text, font=font, fill=fill)
    return box[3] - box[1]


def title_card(w: int, h: int, out: Path) -> Path:
    img = Image.new("RGB", (w, h), GROUND)
    d = ImageDraw.Draw(img)
    big = _font("DejaVuSans-Bold.ttf", int(h * 0.062))
    mid = _font("DejaVuSans.ttf", int(h * 0.028))
    small = _font("DejaVuSans.ttf", int(h * 0.020))

    y = int(h * 0.34)
    y += _centre(d, y, "Dentistry CBCT", big, INK, w) + int(h * 0.055)
    y += _centre(d, y, "Segment a cone-beam CT. Plan an implant against it.",
                 mid, MUTED, w) + int(h * 0.030)
    _centre(d, y, "Every clearance graded with the model’s own measured error subtracted",
            small, ACCENT, w)

    # A single rule under the title, in the accent. The one piece of furniture.
    rw = int(w * 0.09)
    ry = int(h * 0.30)
    d.rectangle([(w - rw) // 2, ry, (w + rw) // 2, ry + max(2, h // 340)], fill=ACCENT)
    img.save(out)
    return out


def end_card(w: int, h: int, out: Path) -> Path:
    img = Image.new("RGB", (w, h), GROUND)
    d = ImageDraw.Draw(img)
    big = _font("DejaVuSans-Bold.ttf", int(h * 0.040))
    mid = _font("DejaVuSans.ttf", int(h * 0.026))
    small = _font("DejaVuSans.ttf", int(h * 0.019))

    y = int(h * 0.36)
    y += _centre(d, y, "dentistry.dicomsegvr.com", big, INK, w) + int(h * 0.045)
    y += _centre(d, y, "Gustavo Formento · gustavo.formento@rtmedical.com.br",
                 mid, MUTED, w) + int(h * 0.055)
    # The disclaimer is on the end card and not only in the footer, because a video is the
    # one artifact that travels away from the site it was recorded on.
    _centre(d, y, "Research preview — not a medical device, and not for diagnostic use.",
            small, ACCENT, w)
    img.save(out)
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="/tmp/dentistry-tour")
    ap.add_argument("--width", type=int, default=1920)
    ap.add_argument("--height", type=int, default=1080)
    args = ap.parse_args()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    t = title_card(args.width, args.height, out / "title.png")
    e = end_card(args.width, args.height, out / "end.png")
    print(t)
    print(e)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
