---
version: alpha
name: ImplantPlan web app
description: The ImplantPlan dental CBCT segmentation and implant-planning SPA (web/), light chrome with dark imaging screens, as shipped in commit e0bf836.
colors:
  primary: "#7c3aed"
  primary-deep: "#6d28d9"
  accent-gfx: "#8b5cf6"
  accent-wash: "#f1ebff"
  ground: "#fbfbfd"
  surface: "#ffffff"
  surface-2: "#f2f3f8"
  surface-3: "#eaeaf1"
  border: "#0f15201a"
  border-2: "#0f152029"
  ink: "#0f1520"
  muted: "#5b6577"
  bar-neutral: "#c9cdd8"
  ok: "#047857"
  ok-fill: "#34d399"
  warn: "#8a5304"
  warn-fill: "#fbbf24"
  bad: "#b91c1c"
  bad-fill: "#f87171"
  screen: "#000000"
  screen-3d: "#0a0e13"
  screen-surface: "#131a25"
  screen-surface-2: "#1b2230"
  screen-surface-3: "#222b3b"
  screen-border: "#232d3d"
  screen-border-2: "#2e3a4d"
  screen-ink: "#f4f7fa"
  screen-muted: "#93a1b8"
typography:
  display:
    fontFamily: "Archivo Display, Geist, system-ui, sans-serif"
    fontSize: 1.9rem
    fontWeight: 700
    lineHeight: 1.08
    letterSpacing: -0.02em
  headline:
    fontFamily: "Geist, system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
    fontSize: 1rem
    fontWeight: 650
    letterSpacing: -0.015em
  title:
    fontFamily: "Geist, system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
    fontSize: 0.9rem
    fontWeight: 600
  body:
    fontFamily: "Geist, system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
    fontSize: 15px
    fontWeight: 400
    lineHeight: 1.55
    fontFeature: "\"ss01\", \"cv11\""
  label:
    fontFamily: "Geist, system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
    fontSize: 11px
    fontWeight: 600
    letterSpacing: 0.07em
  readout:
    fontFamily: "Geist Mono, ui-monospace, SF Mono, Menlo, Consolas, monospace"
    fontSize: 0.78rem
    fontWeight: 600
    lineHeight: 1.2
rounded:
  sm: 8px
  base: 12px
  pill: 999px
spacing:
  pane-gap: 0.5rem
  gutter: 0.8rem
  card: 0.9rem
  panel: 1.25rem
  topbar: 48px
components:
  button:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.sm}"
    padding: 0.55rem 0.95rem
  button-hover:
    backgroundColor: "{colors.surface-2}"
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.surface}"
    rounded: "{rounded.sm}"
    padding: 0.55rem 0.95rem
  button-primary-hover:
    backgroundColor: "{colors.primary-deep}"
  button-quiet:
    textColor: "{colors.muted}"
    rounded: "{rounded.sm}"
  icon-button:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.muted}"
    rounded: "{rounded.sm}"
    size: 30px
  segmented:
    backgroundColor: "{colors.surface-2}"
    rounded: "{rounded.pill}"
    padding: 2px
  segmented-active:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.pill}"
  nav-item:
    textColor: "{colors.muted}"
    height: "{spacing.topbar}"
  nav-item-active:
    textColor: "{colors.ink}"
  panel:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.base}"
    padding: "{spacing.panel}"
  card:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.base}"
    padding: "{spacing.card}"
  menu:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.base}"
    padding: 0.5rem
  input:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.sm}"
    padding: 0.5rem 0.65rem
  imaging-screen:
    backgroundColor: "{colors.screen}"
    textColor: "{colors.screen-muted}"
    rounded: "{rounded.sm}"
  imaging-screen-3d:
    backgroundColor: "{colors.screen-3d}"
    rounded: "{rounded.sm}"
  verdict-clear:
    textColor: "{colors.ok}"
    rounded: "{rounded.pill}"
  verdict-tight:
    textColor: "{colors.warn}"
    rounded: "{rounded.pill}"
  verdict-breach:
    textColor: "{colors.bad}"
    rounded: "{rounded.pill}"
  verdict-none:
    textColor: "{colors.muted}"
    rounded: "{rounded.pill}"
  clearance-readout:
    textColor: "{colors.ink}"
    typography: "{typography.readout}"
  page:
    backgroundColor: "{colors.ground}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
  dropzone:
    backgroundColor: "{colors.accent-wash}"
    textColor: "{colors.ink}"
    rounded: "{rounded.base}"
  gauge-track:
    backgroundColor: "{colors.surface-3}"
    height: 6px
  gauge-fill-clear:
    backgroundColor: "{colors.ok-fill}"
  gauge-fill-tight:
    backgroundColor: "{colors.warn-fill}"
  gauge-fill-breach:
    backgroundColor: "{colors.bad-fill}"
  gauge-fill-unrated:
    backgroundColor: "{colors.bar-neutral}"
  screen-veil:
    backgroundColor: "{colors.screen-3d}"
    textColor: "{colors.screen-muted}"
---

# Design System: ImplantPlan web app

## Overview

**Creative North Star: "The Instrument Bench in Daylight"**

ImplantPlan is read at a clinical workstation under office light, beside the practice's own CBCT software. The chrome is therefore light and quiet: a near-white bench, white panels with hairline edges, deep-ink text and one violet. The only thing that wants a dark surround is the scan, so every CBCT slice, panoramic, cross-section and 3-D view is a dark **screen** set into the bench with a hairline edge and a soft offset frame shadow. It reads as a display, not as a hole in the page.

Every number a screen produces comes out to the chrome as a measured readout: a label, a hairline leader, and a tabular mono value. The clearance bar is drawn as a depth gauge, so the reader sees the margin and the thresholds, not only the number. The palette is the landing page's, which is the product's published identity. Technology cues come from ImplantPlan VR (leader lines, the depth gauge, the perspective measuring grid under the dropzone, translucent floating surfaces), not its panels.

The workspace is dense and fills the monitor: a findings rail, the imaging stage and a tools dock. Hierarchy comes from small uppercase section labels and tone steps rather than from large type. Large display type appears twice in the whole app.

**Key Characteristics:**
- Light chrome, dark imaging screens; the screens own their palette.
- One violet for controls (`primary`), a brighter violet for graphics only (`accent-gfx`).
- Verdict colours are reserved for verdicts and job state, and every verdict is a word.
- Readouts are leader-lined and tabular mono.
- Depth is a hairline plus a soft offset shadow, violet-tinted where something lifts.
- Motion is short and decelerating, and disappears under reduced motion.

## Colors

A cool near-white bench with slate text, one saturated violet, a split verdict palette (ink for text, bright for fills), and a dark screen palette scoped to the imaging panes.

### Primary
- **Control Violet** (`primary`): the primary button, links, the active nav underline, focus rings, hover borders, the queued job dot, the dropzone tile. 5.5:1 on the ground, so it is legal as link text.
- **Pressed Violet** (`primary-deep`): primary button hover.
- **Graphics Violet** (`accent-gfx`): the 3-D scene, the focused-pane ring, text selection tint, the right end of the progress gradient. Never text.
- **Violet Wash** (`accent-wash`): the dropzone's lower gradient and add-button hover fill.

The progress fill (upload bar, job bar, meters) is a 90° gradient from Control Violet to Graphics Violet.

### Neutral
- **Bench** (`ground`): the page ground the panels sit on.
- **Panel White** (`surface`): panels, cards, dock sections, menus, buttons, inputs.
- **Well** (`surface-2`): wells inside a panel (row hover, the segmented track, hovered buttons).
- **Track** (`surface-3`): bar tracks, scrollbar thumbs, badges.
- **Hairline** (`border`, ink at 10 %): every panel and card edge.
- **Control Edge** (`border-2`, ink at 16 %): the edge of a button, input or icon button.
- **Deep Ink** (`ink`): all body text. **Slate** (`muted`): secondary text, section labels; 5.7:1 on the ground, AA for body text.
- **Unrated Fill** (`bar-neutral`): a clearance fill that has no server verdict yet.

### Verdict
- **CLEAR** text `ok`, fill `ok-fill`. **TIGHT** text `warn`, fill `warn-fill`. **BREACH** text `bad`, fill `bad-fill`.
- Text always takes the ink variant (AA on white); bars, dots, leaders and chip tints take the fill variant. Inside a screen both resolve to the fill variant.

### The Screen
- **Screen Black** (`screen`): the slice, panoramic and cross-section panes. **3-D Screen** (`screen-3d`): the 3-D panes.
- Drawn on a screen (captions, loading veils, empty states, spinners): `screen-surface` to `screen-surface-3`, `screen-border`, `screen-border-2`, `screen-ink`, `screen-muted`.

### Named Rules
**The Screen Owns Its Palette Rule.** Every imaging container (slice panes, the panoramic, the cross-section, the 3-D wraps, the models canvas, the stage overlay, and anything marked as a screen) re-declares the dark palette and `color-scheme: dark` in one scoped block, so everything drawn on it inherits dark values whatever the chrome says. A light veil over a scan, or slate captions on black, is the chrome damaging the picture.

**The Two Violets Rule.** Control Violet is for things you press and read; Graphics Violet is for things you look at. Graphics Violet is never text.

**The Verdict Monopoly Rule.** Green, amber and red mean CLEAR, TIGHT, BREACH (and done, running, failed for jobs). A QA notice that is not a verdict carries amber only on its list marker, never as text.

**The Catalogue Colour Rule.** Structure colours (teeth, canals, jaws) are never declared in CSS. They come from the server catalogue as inline styles, so nothing can prune them.

## Typography

**Display Font:** Archivo Display 700 (a 10 KB subset; falls back to Geist)
**Body Font:** Geist (with system-ui)
**Label/Mono Font:** Geist Mono (with ui-monospace)

**Character:** A neutral, technical grotesque for everything, a mono for every measured value, and one heavy display cut kept for the two page titles.

### Hierarchy
- **Display** (`display`): the catalogue title only, and the settings title at 1.75rem/1.1. Nowhere else.
- **Headline** (`headline`): panel headings on the catalogue and settings pages.
- **Title** (`title`): the case name in the top bar; card and job names run 0.86 to 0.88rem at 600.
- **Body** (`body`): 15 px, rising to 15.5 px at 2200 px and 16 px at 2560 px. Most panel copy runs smaller (0.72 to 0.82rem).
- **Label** (`label`): dock and card section headings, uppercase, slate, wide tracking (0.05 to 0.07em). Pane captions use the same style at 0.62 to 0.7rem on the screen.
- **Readout** (`readout`): clearance millimetres, key-value values, volumes, coordinates, the hero facts (600 1.2rem).

### Named Rules
**The Tabular Rule.** Every measurement is read against another one, so every numeric readout is tabular figures, in Geist Mono.

**The Two Titles Rule.** Archivo Display sets the catalogue and settings page titles and nothing else.

## Layout

- **The two-child body.** The body is a two-row grid (top bar, `#views`) with an explicit `minmax(0, 1fr)` column, and `#views` is the only second in-flow child. Every view lives inside it.
- **The case does not scroll.** With a case open the page is `100dvh` and the rail, dock and structure list scroll inside themselves.
- **Workspace.** Three columns: rail `clamp(300px, 18vw, 480px)`, stage `minmax(0, 1fr)`, dock `clamp(300px, 20vw, 460px)`, with a 0.8rem gutter. Every collapsed state restates the whole template and removes the track; none uses a `0` track. In the plan tab the dock is gone and the rail is removed when it has nothing to show.
- **MPR stage.** A 2×2 grid of screens with a 0.5rem gap (0.8rem at 2560 px), plus focus (3fr/1fr) and solo layouts.
- **Plan stage.** A tools row; a site bar (`clamp(112px, 15vh, 150px)` tall) holding the panoramic, the dental chart and the plan bar; then the cross-section beside the 3-D view; the implant panel in a right column `clamp(20rem, 22vw, 34rem)`.
- **Text-shaped views** (catalogue, settings, contact) sit on a reading measure: `min(1720px, 94vw)`, settings at 820 px. The workspace ignores the measure.
- **Catalogue hero.** Two columns: the copy and hero facts on the left, the dropzone and everything about the next upload under it on the right; one column below 860 px.
- **Density** steps up with the monitor at 1900, 2200 and 2560 px (more workspace padding and gap, slightly larger body). The workspace stacks to one column below 1000 px.

## Elevation & Depth

A hybrid: tone steps and hairlines carry most structure, and a soft offset shadow, tinted toward violet, marks anything that lifts or floats. Nothing uses a hard offset shadow.

### Shadow Vocabulary
- **Rest** (`0 1px 2px rgb(15 21 32 / .05)`): panels, cards, dock sections, buttons. Barely lifts.
- **Float** (`0 0 0 1px` hairline, `0 18px 40px -18px rgb(76 29 149 / .28)`, `0 6px 14px -8px rgb(15 21 32 / .18)`): menus and popovers, which also carry a 16 px backdrop blur on an 86 % surface.
- **Screen Frame** (`0 0 0 1px rgb(15 21 32 / .55)`, `0 14px 30px -20px rgb(15 21 32 / .55)`): every imaging screen. The focused pane adds a 2 px Graphics Violet ring.
- **Hover Lift** (`0 12px 24px -18px rgb(76 29 149 / .45)` with a 1 px rise): example cards and openable job cards.
- **Focus Ring** (2 px surface gap, then 2 px Control Violet at 70 %): every keyboard-reachable element, drawn outside so it never shifts layout.

### Named Rules
**The Translucent Float Rule.** Things that float above the page (the top bar, menus) are translucent surface over a backdrop blur. Things in the page are opaque.

## Shapes

- **Gently rounded panels** (`rounded.base`): panels, cards, dock sections, menus, the dropzone, its icon tile.
- **Tighter controls** (`rounded.sm`): buttons, icon buttons, inputs, menu items, example and job cards, and every imaging screen.
- **Pills** (`rounded.pill`): segmented controls, verdict chips, badges, progress and bar tracks, scrollbar thumbs.
- Rows inside lists (structure rows, clearance rows) use a small 5 to 6 px radius on hover only.
- The icon set is one drawn sprite: 16 px, 1.6 stroke, round caps and joins, `currentColor`.

## Components

### Buttons
Quiet, white and edged; the primary is the one solid colour in a view.
- **Shape:** gently rounded (`rounded.sm`), 550 weight at 0.82rem, rest shadow.
- **Default:** Panel White with a Control Edge; hover moves to Well and tints the edge 45 % toward Control Violet; press drops 1 px.
- **Primary:** solid Control Violet with white text, a violet glow shadow; hover goes to Pressed Violet. At most one per view.
- **Quiet:** borderless slate text; hover fills Well and goes to ink.
- **Small:** 0.74rem with tighter padding.
- **Icon button:** a 30 px square on Panel White; hover to ink on Well.

### Segmented control
A pill track in Well with a hairline; the active segment is lifted to Panel White with a hairline ring and a small shadow. Used for mutually exclusive modes: layouts, model modes, jaw tabs.

### Navigation
View tabs in the 48 px translucent top bar, as an underline rather than a pill so the bar reads as navigation and not as another segmented control. Slate at rest, ink on hover, ink plus a 2 px Control Violet underline when active. Inside a case, the case name and provenance line replace the tabs; the provenance line goes first below 1240 px.

### Cards / Containers
- **Panel / card / dock section** share Panel White, the hairline and the rest shadow; they differ only in padding (1.25rem, 0.9rem, 0.6rem).
- Catalogue sections below the hero (jobs, examples, models) drop the container and sit on a top hairline.
- **Job card:** a status dot (verdict fill colours, violet when queued, a halo when running), name, meta line, a 3 px progress bar.

### Inputs / Fields
Panel White, Control Edge, `rounded.sm`, slate label above. Focus turns the edge Control Violet with a 3 px 18 % violet halo.

### Menu
The account menu: translucent Panel White over a blur, the Float shadow, borderless, items on `rounded.sm` with Well hover. Destructive items are slate until hover, then BREACH ink.

### Verdict chip
An uppercase word (650, 0.66rem, 0.04em tracking) on a pill with a 16 % tint of the verdict fill and a 40 % fill border (breach 18 % / 50 %). No verdict is transparent, slate and dashed.

### Clearance row (signature)
One structure, one line: verdict chip, slate label, a **leader** hairline, and the millimetres in Readout type; under it the depth gauge. The leader is dashed slate until a verdict exists, then a solid 1 px line in the verdict's fill colour. Key-value readouts elsewhere use the same device as a dotted slate leader between label and mono value.

### Depth-gauge clearance bar (signature)
A slim 6 px track in Track with an inset hairline; the measured span as a fill in the verdict fill colour (Unrated Fill before a verdict); the segmentation error budget as a 45° hatched band; the required margin as a 2 px ink marker standing 5 px proud of the track, ringed in the panel colour. A saturated, lower-bound value fades its fill out to the right so it never reads as "it stops here". Its colour comes only from a server verdict, never from a drag in flight.

### Dropzone (catalogue)
A lit bench: Control-Violet-tinted edge, a white-to-Violet-Wash gradient, a solid violet icon tile, and a faint measuring grid laid back in perspective as the floor, masked to fade before it reaches the words. Hover or drag-over darkens the grid and the edge and lifts the shadow.

### Imaging screen
`rounded.sm`, Screen Black (3-D Screen for 3-D), no border, the Screen Frame shadow. Captions are small uppercase slate at reduced opacity with a dark text shadow, `pointer-events: none`. Loading overlays are 82 % screen ground with a 2 px blur and a violet-topped spinner.

### Motion
Hover and state changes take 120 ms (controls) or 180 ms (cards, dropzone, bars) on `cubic-bezier(.23, 1, .32, 1)`. Under `prefers-reduced-motion` every transition and animation is cut to zero.

## Do's and Don'ts

### Do:
- **Do** write every verdict as a word (CLEAR, TIGHT, BREACH, or no verdict). Never rely on colour alone.
- **Do** load every authenticated image through a blob URL. An `<img src>` cannot carry the bearer token.
- **Do** put every scan inside a dark screen and let the scoped screen palette style anything drawn on it.
- **Do** use the ink verdict variant for text and the fill variant for bars, dots, leaders and tints.
- **Do** set every measured value in Geist Mono with tabular figures, joined to its label by a leader.
- **Do** keep the primary button to one per view.
- **Do** restate the whole grid template for every collapsed workspace state and remove the track rather than zeroing it.

### Don't:
- **Don't** put an icon beside a wordmark, or a wordmark at all, in the brand slot. The brand is the implant-in-bone logomark alone.
- **Don't** let any element other than `#views` be a second in-flow child of `body`.
- **Don't** animate the MPR grid template. Cornerstone must resize after the boxes settle.
- **Don't** use Graphics Violet (`accent-gfx`) for text.
- **Don't** use green, amber or red for anything that is not a verdict or a job state.
- **Don't** draw an ungraded structure as a paler green. No verdict is dashed and slate.
- **Don't** quote absolute HU or bone-density classes in any readout; grey values are not calibrated.
- **Don't** declare structure colours in CSS.
