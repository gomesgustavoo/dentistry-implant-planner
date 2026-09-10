#!/usr/bin/env python3
"""WCAG contrast for every pair the LANDING page actually renders.

`~/brand/verify-contrast.py` checks the platform's dark ground and only that ground:
the brand kit defines exactly one, `#0a0e13`. The landing page is paper, so its pairs
are new surface and none of them are covered there.

Two failure modes this is written against, both already observed in this palette's
ancestors:

  * A saturated brand violet is in the luminance dead zone where NEITHER dark ink nor
    white clears 4.5:1. `#8b5cf6` measures 4.10:1 against this page's ground. It has to
    be a graphics colour, and a separate, darker value has to carry text.
  * The verdict and status colours are tuned for a dark ground and measure 1.6-3.4:1 on
    paper. They survive as chip FILLS with dark ink on top, and that pairing is checked
    here rather than assumed.

Token values are read out of `landing/styles.css`, so this cannot pass against a palette
the page does not actually use.

    python3 scripts/check_landing_contrast.py          report and gate
    python3 scripts/check_landing_contrast.py --all    print every pair, passing or not
"""
from __future__ import annotations

import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
CSS = ROOT / "landing/styles.css"
AA, AA_LARGE, AA_UI = 4.5, 3.0, 3.0


def strip_comments(css: str) -> str:
    """Remove /* ... */ before scanning for tokens.

    Without this, a token NAME mentioned in prose inside a comment matches as a
    declaration and its value -- matched as [^;}]+ -- runs on until the next real
    semicolon, swallowing the genuine declaration that followed. That silently DELETES
    tokens from the report, so the check passes by omission. The same trap is documented
    in ~/brand/verify-contrast.py, and this file's header comment discusses half the
    palette by name, so it would fire here immediately.
    """
    return re.sub(r"/\*.*?\*/", " ", css, flags=re.S)


def lum(hexv: str) -> float:
    h = hexv.lstrip("#")
    if len(h) == 3:
        h = "".join(c * 2 for c in h)
    ch = []
    for i in (0, 2, 4):
        c = int(h[i:i + 2], 16) / 255
        ch.append(c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4)
    return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2]


def ratio(a: str, b: str) -> float:
    la, lb = lum(a), lum(b)
    hi, lo = max(la, lb), min(la, lb)
    return (hi + 0.05) / (lo + 0.05)


def tokens() -> dict[str, str]:
    css = strip_comments(CSS.read_text())
    root = re.search(r":root\s*\{(.*?)\}", css, re.S)
    if not root:
        sys.exit("no :root block in landing/styles.css")
    out = {}
    for name, value in re.findall(r"(--[\w-]+)\s*:\s*([^;}]+)", root.group(1)):
        v = value.strip()
        if re.fullmatch(r"#[0-9a-fA-F]{3,8}", v):
            out[name] = v[:7]
    return out


T = tokens()
WHITE = "#ffffff"


def t(name: str) -> str:
    if name not in T:
        sys.exit(f"landing/styles.css defines no {name}")
    return T[name]


# (label, foreground, background, threshold, note)
PAIRS = [
    # --- body copy on every ground the page uses ---------------------------------
    ("body text on the page", t("--text"), t("--bg"), AA, ""),
    ("body text on a card", t("--text"), t("--surface"), AA, ""),
    ("body text on the raised band", t("--text"), t("--bg-elev"), AA, ""),
    ("body text on surface-2", t("--text"), t("--surface-2"), AA, ""),
    ("muted copy on the page", t("--text-muted"), t("--bg"), AA, ""),
    ("muted copy on a card", t("--text-muted"), t("--surface"), AA, ""),
    ("faint label on the page", t("--text-faint"), t("--bg"), AA_LARGE,
     "large text only -- never body copy"),

    # --- the brand violet, in both roles -----------------------------------------
    ("accent AS TEXT on the page", t("--accent"), t("--bg"), AA,
     "EXPECTED TO FAIL -- --accent is a graphics colour; use --accent-ink"),
    ("accent-ink on the page", t("--accent-ink"), t("--bg"), AA, ""),
    ("accent-ink on a card", t("--accent-ink"), t("--surface"), AA, ""),
    ("accent-deep on the page", t("--accent-deep"), t("--bg"), AA, ""),
    ("accent-deep on the accent wash", t("--accent-deep"), t("--accent-wash"), AA, ""),
    ("white on the primary button", WHITE, t("--accent-ink"), AA, ""),
    ("white on the primary button, hover", WHITE, t("--accent-deep"), AA, ""),

    # --- verdicts: fills with dark ink, which is the whole point ------------------
    ("chip ink on CLEAR", t("--chip-ink"), t("--clear"), AA, ""),
    ("chip ink on TIGHT", t("--chip-ink"), t("--tight"), AA, ""),
    ("chip ink on BREACH", t("--chip-ink"), t("--breach"), AA, ""),
    ("chip ink on NOT GRADED", t("--chip-ink"), t("--neutral"), AA, ""),
    ("chip ink on the canal swatch", t("--chip-ink"), t("--canal"), AA, ""),

    # --- data-voice colours are graphics -----------------------------------------
    # The FILL is decoration and is not checked against the page: a verdict chip is
    # identified by the word inside it and by its outline, not by its tint. The
    # OUTLINE is the non-text contrast that 1.4.11 actually asks for, so that is what
    # is measured. Checking the fills instead is how you end up darkening #34d399
    # until it is no longer the app's green.
    ("canal swatch against the page", t("--canal"), t("--bg"), AA_UI, "swatch, not type"),
    ("bone swatch outline", t("--bone-line"), t("--bg"), AA_UI, "outline of a swatch"),
    ("CLEAR chip outline", t("--clear-line"), t("--bg"), AA_UI, "outline, not fill"),
    ("TIGHT chip outline", t("--tight-line"), t("--bg"), AA_UI, "outline, not fill"),
    ("BREACH chip outline", t("--breach-line"), t("--bg"), AA_UI, "outline, not fill"),
    ("NOT GRADED chip outline", t("--neutral-line"), t("--bg"), AA_UI, "outline, not fill"),
    ("chip ink on the CLEAR outline", t("--chip-ink"), t("--clear-line"), AA_LARGE,
     "the outline may carry the label at large sizes"),
    ("quadrant 1 swatch", t("--q1"), t("--bg"), AA_UI, "swatch, not type"),
    ("quadrant 2 swatch", t("--q2"), t("--bg"), AA_UI, "swatch, not type"),
    ("quadrant 3 swatch", t("--q3"), t("--bg"), AA_UI, "swatch, not type"),
    ("quadrant 4 swatch", t("--q4"), t("--bg"), AA_UI, "swatch, not type"),

    # --- status text --------------------------------------------------------------
    ("ok as an icon/rule", t("--ok"), t("--bg"), AA_UI, "non-text"),
    ("warn as text", t("--warn"), t("--bg"), AA, ""),

    # --- borders have to be seen ---------------------------------------------------
    ("border against a card", t("--border"), t("--surface"), 1.2, "hairline, visible only"),
]

# The one pair that is SUPPOSED to fail. Asserting it fails is what proves the rest of
# the report is measuring anything at all -- a contrast check where everything passes by
# construction is a check nobody has seen work.
EXPECT_FAIL = {"accent AS TEXT on the page"}

show_all = "--all" in sys.argv
failures, surprises = [], []
print(f"# landing/styles.css — ground {t('--bg')}, ink {t('--text')}\n")
for label, fg, bg, need, note in PAIRS:
    r = ratio(fg, bg)
    ok = r >= need
    expected_fail = label in EXPECT_FAIL
    if expected_fail:
        if ok:
            surprises.append(f"{label} now PASSES at {r:.2f}:1 — the palette moved; "
                             "re-read the header before deleting this line")
        mark = "ok  " if not ok else "FAIL"
        print(f"{mark} {r:5.2f}:1  {label}  ({fg} on {bg})  {note}")
        continue
    if not ok:
        failures.append(f"{label}: {r:.2f}:1 against {need}:1  ({fg} on {bg})")
    if show_all or not ok:
        print(f"{'ok  ' if ok else 'FAIL'} {r:5.2f}:1  {label}  ({fg} on {bg})"
              f"{'  ' + note if note else ''}")

print()
if surprises:
    for s in surprises:
        print("SURPRISE:", s)
if failures:
    print(f"{len(failures)} failing pair(s):")
    for f in failures:
        print("  -", f)
    sys.exit(1)
print(f"all {len(PAIRS)} pairs pass (1 of them by failing on purpose)")
