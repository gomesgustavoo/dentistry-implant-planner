---
version: alpha
name: ImplantPlan web app
description: The ImplantPlan dental CBCT segmentation and implant-planning SPA (web/), as shipped in web:0.30.1.
colors:
  primary: "#8b5cf6"
  accent: "#8b5cf6"
  accent-2: "#6a6df2"
  ground: "#0a0e13"
  surface: "#131a25"
  surface-2: "#1b2230"
  surface-3: "#222b3b"
  border: "#232d3d"
  border-2: "#2e3a4d"
  ink: "#f4f7fa"
  muted: "#93a1b8"
  ok: "#34d399"
  warn: "#fbbf24"
  bad: "#f87171"
typography:
  sans:
    fontFamily: system-ui
    fontSize: 15px
    lineHeight: 1.55
  mono:
    fontFamily: ui-monospace
rounded:
  base: 12px
  sm: 8px
components:
  button:
    backgroundColor: "{colors.surface-2}"
    textColor: "{colors.ink}"
    rounded: "{rounded.sm}"
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.ground}"
    rounded: "{rounded.sm}"
  panel:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.base}"
  card:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.base}"
  popover:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.base}"
  verdict-clear:
    textColor: "{colors.ok}"
  verdict-tight:
    textColor: "{colors.warn}"
  verdict-breach:
    textColor: "{colors.bad}"
  verdict-none:
    textColor: "{colors.muted}"
---

## Overview

ImplantPlan is a clinical-research tool. It segments a dental cone-beam CT, then has the reader place implants and read their clearances to the canals, sinuses and neighbouring teeth. The interface is a dense, dark, instrument-like workspace: an image viewport that takes the whole monitor, flanked by a scrolling rail of findings and a dock of tools. The violet accent is chosen so that it collides with nothing in the anatomical structure palette.

## Colors

- The accent family (`accent`, `accent-2`, and the 135° gradient between them) belongs to interaction and brand: the primary button, the active tab underline, hover borders, progress fill and links. It never carries a clinical meaning.
- `ok` / `warn` / `bad` are clinical verdict colours: CLEAR, TIGHT, BREACH. They also mark job state (done, running, failed). Any other use dilutes the verdict.
- Structure colours (teeth, canals, jaws) are never declared in CSS. They come from the server catalogue and are applied inline, so no build step or token sweep can prune them.
- `accent-2` was moved from `#6366f1` to clear AA for text against `ground`. Any accent used as text has to keep that margin.

## Typography

- Body text is the platform system stack at 15 px.
- Measurements, coordinates, keyboard hints and voxel sizes use the mono stack.
- Section and card headings are small uppercase labels with wide tracking, in `muted`. Hierarchy comes from that label style rather than from large type.

## Layout

- The body grid has exactly two in-flow children: the topbar and `#views`. Every view lives inside `#views`. A third body child would take the `1fr` row and stretch to the window.
- With a case open the page does not scroll. The workspace fills `100dvh`; the rail and dock scroll inside themselves.
- The rail (`clamp(300px, 18vw, 480px)`) and dock (`clamp(300px, 20vw, 460px)`) scale with the window. Text-shaped views (settings, contact) are capped at a reading measure. The image workspace ignores that cap.
- The MPR stage is a 2×2 grid with focus and solo layouts. Its grid template is never animated, because Cornerstone must resize after the boxes settle.
- The implant-plan stage is a tools row, then a strip of panoramic, dental chart and plan bar, then the cross-section beside the 3-D view, with the implant panel in a right column.

## Elevation & Depth

- Depth comes from stepping through the surface ladder (`ground` → `surface` → `surface-2` → `surface-3`) with a 1 px border. Shadows are not used for depth.
- A shadow appears only on things that float above the page: popovers, menus and the sign-in panel.
- The topbar is translucent `surface` with a backdrop blur, sticky above the views.

## Shapes

- `rounded.base` is used for panels, cards, dock sections and popovers.
- `rounded.sm` is used for buttons, icon buttons and model cards.
- Pills (full radius) are reserved for segmented controls, verdict chips and progress bars.

## Components

- **Buttons**:
  - The default is `surface-2` with a `border-2` hairline, and hover moves the border to `accent`.
  - Primary is the accent gradient with dark ink, at most one per view.
  - Quiet is borderless `muted` text.
- **Segmented control** (`.seg`/`.segb`): a pill track whose active segment is lifted to `surface-3`. Use it for mutually exclusive modes: layouts, model modes, jaw tabs.
- **Verdict chip** (`.vchip`):
  - The verdict is written as an uppercase word on a 16 % tint of its colour, with a 40 % border.
  - `no_verdict` is dashed and muted, never a paler green, because an ungraded structure must not read as a weaker pass.
- **Panel / card / dock section**: the same surface and border. Cards and dock sections differ only in padding rhythm.
- **Icon button**: a 30 px square, `surface-2`. Its `.on` state uses the accent border.

## Do's and Don'ts

- Do write every verdict as a word. Never rely on colour alone.
- Do load every authenticated image through a blob URL. An `<img src>` cannot carry the bearer token.
- Don't put an icon beside a wordmark in the brand slot. The brand is one image.
- Don't let any element other than `#views` be a second in-flow child of `body`.
- Don't animate the MPR grid template.

## Target Direction (approved 2026-10-02)

This section records the approved redesign brief. It supersedes the sections above wherever the two disagree, and it becomes the canonical system once the redesign ships.

- **Light chrome.** The ground, surfaces, borders and text follow the landing page's light theme, which is the published ImplantPlan identity: near-white ground, white surfaces, hairline borders, deep-ink text. The accent darkens to the landing's AA-safe violet for text and controls. The brighter violet stays for graphics only.
- **Imaging panes stay dark.** Every CBCT slice, panoramic and cross-section sits in a dark inset "screen" inside the light chrome, because greyscale anatomy needs a dark surround. The 3-D view may take a light studio backdrop, with a dark option.
- **Keep the panels.** The panel set and placement shown in the product films stay: rail, stage, dock; the panoramic, dental chart and plan bar strip; the cross-section beside the 3-D view; the implant panel. The redesign restyles them and does not rearrange them.
- **Logomark only.** The brand slot is the implant-in-bone tile alone, with no wordmark beside it or in place of it.
- **Technology cues from ImplantPlan VR, not its panels:**
  - clearance readouts as leader-line callouts, with a mono millimetre value joined to its target by a hairline in the verdict colour;
  - clearance bars drawn as a depth-gauge ruler with ticks at the TIGHT and BREACH thresholds;
  - tabular mono readouts;
  - CLEAR / TIGHT / BREACH chips;
  - translucent, layered surfaces for floating elements.
- **Motion** is short and decelerating, matching the landing's ease-out curve, and is removed entirely under reduced motion.
