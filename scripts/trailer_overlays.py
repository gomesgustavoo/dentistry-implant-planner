"""Trailer overlays: caption plates, title and end cards, and the social frames.

## Why HTML and Chrome rather than PIL or drawtext

`tour_cards.py` draws its two cards with PIL, and that was right for two cards of
DejaVu Sans. This is a branded piece: it needs Archivo at a width axis, a gradient
clipped to text, a feathered scrim and a mono numeral column, and PIL does none of
those without becoming a layout engine. `drawtext` is worse -- `caption_tour.sh`'s
header records fifteen captions' worth of escaping bugs that failed silently.

The identity's own guide already answers this. Its social cards are built the same
way and the section is called "Composed, not generated": *the type, the aurora mesh
and the dot grid are the live tokens, so the cards cannot drift from the pages they
represent*. This loads `brand/tokens/platform.css` and `band-implantplan.css` from
disk, so a colour changed there changes the trailer without anyone editing this file.

## No generated imagery

Nothing here is drawn by a model. The identity's Never list opens with "Draw or
generate anatomy", and the one place image generation appears in the whole system is
an image-to-image relight of an existing VTK render, which ships with a disclosure
sentence. Every pixel below is either type, a token colour, or `logo.png`.

## Transparent PNGs

`--default-background-color=00000000` is the flag that makes Chrome screenshot with
alpha; without it the plates composite as black boxes over the footage. Lifted from
`~/marketing/build/shoot.sh`, which is the same trick this house already uses.

    ./venv/bin/python scripts/trailer_overlays.py --beats /tmp/dentistry-tour/beats.json
"""
from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import tempfile
import pathlib
from pathlib import Path

BRAND = Path.home() / "brand"
TOKENS = BRAND / "tokens"
FONTS = BRAND / "fonts"
LOGO = BRAND / "raster" / "implantplan" / "logo.png"
WORDMARK = BRAND / "raster" / "implantplan" / "wordmark.png"
# The 1200x630 card the README opens with. It IS the opening frame, so the film and
# the page lead on the same image and the video's thumbnail is that image rather than
# whatever the first frame happened to be.
BANNER = pathlib.Path(__file__).resolve().parent.parent / "marketing" / "brand" / "banner.png"

# The mandatory footer line, verbatim from the identity's own guide. It ships wherever
# anything ImplantPlan-branded ships, and a video is the one artifact that travels away
# from the site it was recorded on.
PERSONAL = "Personal projects. Not affiliated with any employer, and not a medical device."
RESEARCH = "Research preview — not for diagnostic or treatment use."
# Attribution is not optional and does not depend on the film. The base weights carry a
# CC BY-NC-SA term whose BY half survives however the catalogue is labelled on screen, and
# the third-party models this app RUNS are Apache-2.0 and credited by name here even
# though the frames call them Model C and Model D.
CREDITS = [
    "Base and canal specialist trained here; weights derived from a "
    "CC BY-NC-SA 4.0 research dataset, held out of training.",
    "Third-party models run by this app: ToothSeg (MIC-DKFZ) and "
    "TotalSegmentator (Wasserthal et al.), both Apache-2.0.",
    "Mark stylised from a render of real segmentation data.",
]


def font_face(family: str, filename: str, weights: str) -> str:
    return (f"@font-face{{font-family:'{family}';"
            f"src:url('file://{FONTS / filename}') format('woff2');"
            f"font-weight:{weights};font-display:block;}}")


def head(extra_css: str) -> str:
    """Tokens first, then exactly one band file -- the identity's Always list, in order."""
    platform = (TOKENS / "platform.css").read_text(encoding="utf-8")
    band = (TOKENS / "band-implantplan.css").read_text(encoding="utf-8")
    return f"""<!doctype html><meta charset="utf-8"><style>
{font_face('Archivo', 'Archivo-latin.woff2', '100 900')}
{font_face('Geist', 'Geist-latin.woff2', '300 800')}
{font_face('Geist Mono', 'GeistMono-latin.woff2', '400 600')}
{platform}
{band}
*{{box-sizing:border-box;margin:0;padding:0}}
html,body{{width:100%;height:100%;background:transparent}}
body{{font-family:'Geist',system-ui,sans-serif;-webkit-font-smoothing:antialiased}}
{extra_css}
</style>"""


# ----------------------------------------------------------------- caption plates
# Bottom third, left aligned. NOT centred: a centred caption re-centres itself on every
# line-length change, so a fourteen-beat sequence shimmers horizontally. A fixed left
# margin holds still and lets the eye stay where the last one ended.
#
# The width axis is the one typographic liberty this product has, and it is used
# semantically: display runs expanded and the eyebrow runs condensed, mirroring an arch.
PLATE_CSS = """
.wrap{position:absolute;left:96px;right:96px;bottom:84px;display:flex;
  flex-direction:column;align-items:flex-start;gap:14px}
/* A scrim, not a box. The footage under a caption is a greyscale CBCT whose luminance
   swings from black air to white enamel inside one frame, so a plate that is legible
   over bone is invisible over air. This is feathered upward from the bottom edge and
   sits behind everything, which keeps the type legible without drawing a rectangle
   around it. */
.scrim{position:absolute;left:0;right:0;bottom:0;height:420px;
  background:linear-gradient(to top,rgba(6,9,13,.92) 0%,rgba(6,9,13,.72) 42%,
    rgba(6,9,13,0) 100%)}
.eyebrow{font-family:'Geist Mono',ui-monospace,monospace;font-size:20px;
  letter-spacing:.18em;text-transform:uppercase;font-weight:500;
  font-stretch:var(--ds-narrow,78%);
  background:var(--ds-grad-cta);-webkit-background-clip:text;background-clip:text;
  color:transparent}
/* `filter` and an inherited `text-shadow` both break background-clip:text -- the guide
   records both traps by name. Neither is used here. */
.head{font-family:'Archivo',sans-serif;font-weight:700;font-size:56px;line-height:1.1;
  letter-spacing:-.02em;font-stretch:var(--ds-wide,116%);color:var(--ds-ink);
  max-width:1500px}
.head em{font-style:normal;color:var(--ds-accent-hi)}
.rule{width:88px;height:3px;background:var(--ds-grad-cta);border-radius:2px}
.num{font-family:'Geist Mono',ui-monospace,monospace;font-weight:600;font-size:44px;
  color:var(--ds-ink);font-variant-numeric:tabular-nums;letter-spacing:-.01em}
.num small{font-size:24px;color:var(--ds-muted);font-weight:400;margin-left:8px}
"""


def plate_html(eyebrow: str, headline: str, numeral: str = "") -> str:
    num = ""
    if numeral:
        # Split "12.45 mm" into figure + unit so the unit sets at reading size. Mono is
        # the instrument-readout voice in this system; the unit is a label, not a value.
        parts = numeral.split(" ", 1)
        unit = f"<small>{parts[1]}</small>" if len(parts) > 1 else ""
        num = f'<div class="num">{parts[0]}{unit}</div>'
    return (head(PLATE_CSS) + '<body><div class="scrim"></div><div class="wrap">'
            + (f'<div class="eyebrow">{eyebrow}</div>' if eyebrow else "")
            + '<div class="rule"></div>'
            + f'<div class="head">{headline}</div>'
            + num + "</div></body>")


# --------------------------------------------------------------------- the cards
CARD_CSS = """
body{background:var(--ds-ground);display:flex;align-items:center;
  justify-content:center;flex-direction:column}
/* The aurora, at the identity's own opacity. Decorative: --ds-grad-brand fails AA by
   design and never carries a label. */
.mesh{position:absolute;inset:0;opacity:.30;
  background:
    radial-gradient(60% 55% at 22% 28%, rgba(139,92,246,.55), transparent 70%),
    radial-gradient(55% 50% at 78% 72%, rgba(106,109,242,.45), transparent 70%)}
.dots{position:absolute;inset:0;opacity:.16;
  background-image:radial-gradient(rgba(244,247,250,.5) 1px, transparent 1px);
  background-size:28px 28px}
.stack{position:relative;display:flex;flex-direction:column;align-items:center;
  text-align:center;gap:18px;padding:0 120px}
/* The lockup already contains the wordmark, so the card does not repeat it -- one name,
   once. 440px of a 1080-tall frame gives the object presence without crowding the line
   under it; at 340 the card read as a small picture floating in a lot of ground.
   Scaled as a UNIT: the scrim behind the glyphs is baked into the PNG and carries the
   4.9:1 this lockup measures, which is the weakest of the three and not to be
   re-typeset. */
.logo{width:440px;height:440px;object-fit:contain;margin-bottom:-26px}
.banner-wrap{position:absolute;inset:0;display:flex;align-items:center;
  justify-content:center;background:var(--ds-ground)}
.banner{width:100%;height:auto;display:block}
.word{height:74px;width:auto}
.tag{font-family:'Archivo',sans-serif;font-weight:700;font-size:40px;
  font-stretch:var(--ds-wide,116%);letter-spacing:-.02em;color:var(--ds-ink)}
.sub{font-size:26px;color:var(--ds-muted);max-width:1180px;line-height:1.45}
.host{font-family:'Geist Mono',ui-monospace,monospace;font-size:30px;font-weight:600;
  background:var(--ds-grad-cta);-webkit-background-clip:text;background-clip:text;
  color:transparent;letter-spacing:.02em}
.fine{position:absolute;left:0;right:0;bottom:52px;text-align:center;
  font-size:17px;line-height:1.65;color:var(--ds-faint)}
.fine b{color:var(--ds-muted);font-weight:500}
"""


# Two films, two title cards. The implant film argues that a clearance is a number; the
# pipeline film argues that the number has a scan and a trained model behind it. Neither
# headline is a slogan invented for the video -- the first is the portfolio's own line and
# the second is what the catalogue actually does.
TITLES = {
    "trailer": ("The clearance is the product,<br>and it is a number.",
                "Dental CBCT: 37 structures, 32 teeth in FDI, "
                "the mandibular canal — and an implant graded against them."),
    "pipeline": ("One scan in.<br>Thirty-seven structures out.",
                 "Choose the models before you upload, watch what each one owns, "
                 "and get a report that says how wrong it might be."),
}


def title_html(variant: str = "trailer") -> str:
    """The opening card IS the README's banner, full bleed.

    It used to be the logo lockup over a tag line, which meant the film opened on one
    image and the page it links from opened on another. One image doing both jobs is
    also the video's thumbnail, and a thumbnail is the only frame most people ever see.

    The banner is 1200x630 (1.90:1) against a 16:9 frame, so it is CONTAINed rather than
    cropped -- its corner brackets sit close to the edge and covering would cut them off.
    The letterbox is the brand ground the banner's own corners fade to, so the seam does
    not read as a seam.
    """
    return (head(CARD_CSS)
            + '<body style="background:var(--ds-ground)">'
              '<div class="banner-wrap">'
              f'<img class="banner" src="file://{BANNER}">'
              "</div></body>")


def end_html(host: str) -> str:
    fine = f"<b>{PERSONAL}</b><br>{RESEARCH}<br>" + "<br>".join(CREDITS)
    return (head(CARD_CSS) + '<body><div class="mesh"></div><div class="dots"></div>'
            '<div class="stack">'
            f'<img class="word" src="file://{WORDMARK}">'
            f'<div class="host">{host}</div>'
            "</div>"
            f'<div class="fine">{fine}</div></body>')


# --------------------------------------------------------------- the corner bug
BUG_CSS = """
.bug{position:absolute;right:56px;top:44px;height:26px;width:auto;opacity:.92}
"""


def bug_html() -> str:
    return head(BUG_CSS) + f'<body><img class="bug" src="file://{WORDMARK}"></body>'


# ------------------------------------------------------------- the social frames
# The master is PLACED in these, never cropped into them. A 9:16 crop of 1920x1080 is
# 608x1080 upscaled 1.78x, which is visibly soft on type that was already small; the
# footage keeps its native scale here and the frame supplies the rest of the canvas.
FRAME_CSS = """
body{background:var(--ds-ground);position:relative}
.mesh{position:absolute;inset:0;opacity:.22;
  background:radial-gradient(70% 40% at 50% 8%, rgba(139,92,246,.5), transparent 70%),
             radial-gradient(70% 40% at 50% 94%, rgba(106,109,242,.4), transparent 70%)}
.top{position:absolute;left:0;right:0;top:%TOP%px;text-align:center}
.top img{height:%WORDH%px;width:auto}
.bot{position:absolute;left:0;right:0;bottom:%BOT%px;text-align:center;padding:0 64px}
.line{font-family:'Archivo',sans-serif;font-weight:700;font-size:%HEADPX%px;
  font-stretch:var(--ds-wide,116%);color:var(--ds-ink);letter-spacing:-.02em;
  line-height:1.15}
.host{margin-top:18px;font-family:'Geist Mono',ui-monospace,monospace;
  font-size:%HOSTPX%px;font-weight:600;background:var(--ds-grad-cta);
  -webkit-background-clip:text;background-clip:text;color:transparent}
/* The window the footage lands in, so the frame and the ffmpeg overlay agree on one
   number rather than two that drift. */
.slot{position:absolute;left:0;top:%SLOTY%px;width:1080px;height:%SLOTH%px;
  border-top:1px solid var(--ds-border);border-bottom:1px solid var(--ds-border)}
"""


def frame_html(w: int, h: int, slot_y: int, slot_h: int, host: str) -> str:
    css = (FRAME_CSS
           .replace("%TOP%", str(max(48, slot_y // 3)))
           .replace("%WORDH%", "44" if h > 1500 else "38")
           .replace("%BOT%", str(max(48, (h - slot_y - slot_h) // 3)))
           .replace("%HEADPX%", "46" if h > 1500 else "40")
           .replace("%HOSTPX%", "24" if h > 1500 else "22")
           .replace("%SLOTY%", str(slot_y))
           .replace("%SLOTH%", str(slot_h)))
    return (head(css) + '<body><div class="mesh"></div>'
            f'<div class="top"><img src="file://{WORDMARK}"></div>'
            f'<div class="slot"></div>'
            '<div class="bot"><div class="line">Every implant,<br>clear of the canal.</div>'
            f'<div class="host">{host}</div></div></body>')


# --------------------------------------------------------------------- rendering
def shoot(html: str, out: Path, w: int, h: int, transparent: bool) -> Path:
    """One page, one PNG, at exactly its pixel size."""
    with tempfile.TemporaryDirectory() as td:
        page = Path(td) / "p.html"
        page.write_text(html, encoding="utf-8")
        cmd = [
            "google-chrome", "--headless", "--disable-gpu", "--no-sandbox",
            "--hide-scrollbars", "--force-device-scale-factor=1",
            # Fonts are file:// and so is logo.png; without this Chrome refuses both and
            # renders a fallback face on a transparent square, which looks like success.
            "--allow-file-access-from-files",
            f"--screenshot={out}", f"--window-size={w},{h}",
        ]
        if transparent:
            cmd.append("--default-background-color=00000000")
        cmd.append(f"file://{page}")
        subprocess.run(cmd, check=False, capture_output=True)
    if not out.exists():
        raise SystemExit(f"chrome produced nothing for {out.name}")
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--beats", default="/tmp/dentistry-tour/trailer-beats.json")
    ap.add_argument("--out", default="/tmp/dentistry-trailer")
    ap.add_argument("--width", type=int, default=1920)
    ap.add_argument("--height", type=int, default=1080)
    ap.add_argument("--host", default="dentistry.dicomsegvr.com")
    ap.add_argument("--variant", default="trailer", choices=sorted(TITLES))
    a = ap.parse_args()

    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    for f in (LOGO, WORDMARK, TOKENS / "platform.css", TOKENS / "band-implantplan.css"):
        if not f.exists():
            raise SystemExit(f"missing brand asset: {f}")

    W, H = a.width, a.height
    print(f"cards {W}x{H}")
    shoot(title_html(a.variant), out / "title.png", W, H, transparent=False)
    shoot(end_html(a.host), out / "end.png", W, H, transparent=False)
    shoot(bug_html(), out / "bug.png", W, H, transparent=True)

    beats = json.loads(Path(a.beats).read_text(encoding="utf-8")).get("beats", [])
    print(f"plates: {len(beats)}")
    for i, b in enumerate(beats):
        if not b.get("headline"):
            continue
        p = out / f"plate{i:02d}.png"
        shoot(plate_html(b.get("eyebrow", ""), b["headline"], b.get("numeral", "")),
              p, W, H, transparent=True)
        print(f"  {p.name}  {b['headline'][:56]}")

    # 9:16 and 4:5. The slot heights are the 16:9 master scaled to 1080 wide -- 607.5,
    # rounded to an even 608 because H.264 chroma subsampling needs even dimensions and
    # an odd height silently costs a rescale.
    print("social frames")
    shoot(frame_html(1080, 1920, 656, 608, a.host), out / "frame_9x16.png",
          1080, 1920, transparent=False)
    shoot(frame_html(1080, 1350, 371, 608, a.host), out / "frame_4x5.png",
          1080, 1350, transparent=False)

    print(f"\nwrote {len(list(out.glob('*.png')))} PNGs to {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
