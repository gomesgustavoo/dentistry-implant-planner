---
version: 1
slug: "web-index-html"
primary_target: "web/index.html"
related_targets: ["web/app.css"]
---

# Surface: ImplantPlan web app (catalogue, case workspace, implant plan, settings)

Mode: Operate. Audience: dentists and implantologists planning an implant from their own CBCT (see PRODUCT.md).
Task: upload a scan, check the segmentation, place implants, read clearances, export.
Constraints: keep the panel layout shown in marketing/video/implantplan-plan.mp4; copy is pinned by web-auth/golden.mjs except where design-plans/ui-audit.md findings require a change; no build step.
Direction: brief-pinned (user, 2026-10-02): inherit the ImplantPlan landing's light identity, not a new world. Code-led, because no image generation is available.

## Direction contract
THESIS: an instrument bench in daylight. Light, quiet chrome holds dark imaging "screens", and every number the screens produce comes out to the chrome as a measured, leader-lined readout. It refuses the category default of a near-black viewer with neon accents.
OWN-WORLD: a near-white ground #fbfbfd, white panels with rgb(15 21 32 / .10) hairlines, ink #0f1520, slate muted #5b6577, and one violet: #7c3aed for controls, #8b5cf6 for graphics. Verdict greens, ambers and reds are kept to verdicts. Geist for the UI, Geist Mono for millimetres, Archivo Display 700 only for the two page titles. Imaging panes are #000 screens with an inset hairline and a soft frame shadow.
STORY: the reader sees their scan first, the chrome second, and trusts each number because its bar shows the margin and the thresholds.
FIRST VIEWPORT: on the catalogue, the dropzone as a lit bench with a faint perspective grid floor, then your cases directly under it. On a case, the screens fill the window, with the rail and dock as light side panels.
FORM: extension of the established landing world (no concept roll: the brief pins it).
SIGNATURE: the depth-gauge clearance ruler, with ticks at the TIGHT and BREACH thresholds and a leader-line value chip.
FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
