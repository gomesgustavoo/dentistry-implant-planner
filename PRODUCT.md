# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users
The primary users are dentists and implantologists planning a dental implant from their own patient's cone-beam CT. They upload a scan, check that the segmentation is right (and correct it if it is not), place one or more implants at a missing-tooth or extraction site, and read the clearances to the nerve canals, sinuses and neighbouring teeth before surgery.

Two secondary audiences:
- dental and AI researchers evaluating the segmentation and clearance metrics;
- open-source users who self-host the whole stack on their own GPU.

## Product Purpose
ImplantPlan segments a dental CBCT into 47 structures: the jaws, all 32 teeth in FDI notation, the mandibular and accessory canals, the sinuses, the airway and restorations. It does this with CBCT-trained models only. It then turns the segmentation into an implant plan with measured clearances and an exportable result: a label map, RTSTRUCT, STL meshes and a printed plan sheet.

Success is a clinician who can tell, from one screen, whether a planned implant clears the structures it must not touch, and who knows how far to trust that number.

## Positioning
Measured, honest numbers. Every clearance is a measurement with a stated error budget, and the evidence behind each model is stated beside it. The app is a research preview, not a medical device, and it says so. The same plan opens in ImplantPlan VR on Meta Quest, so the reader can inspect it with their hands.

## Operating Context
- Desktop browser, used at clinical workstation widths from a laptop up to 3440 px monitors, often next to the practice's own CBCT software.
- Scans arrive as NIfTI or a zipped DICOM series.
- Hosted service: `/app` behind single sign-on, workspaces for teams, plans with monthly quotas. Self-hosted: no accounts, one shared server.
- A paired Quest headset opens the workspace's cases in ImplantPlan VR.

## Capabilities and Constraints
- Views: the case catalogue (upload, model choice, examples, your cases), the case workspace (MPR + 3-D with a findings rail and a structures/tools dock), the implant-plan tab, settings and a custom-model contact page.
- Only CBCT-trained models. The CT-trained TotalSegmentator models were measured not to transfer and were removed.
- Grey values are not calibrated Hounsfield units. The app must never quote absolute HU or bone-density classes (Misch, D1–D4) in a measurement.
- Verdicts are CLEAR, TIGHT, BREACH or no verdict, always written as words.
- The static app has no build step: classic scripts and one stylesheet.
- Licences: code MIT; first-party weights CC BY-NC-SA 4.0 (ToothFairy3-derived); ToothSeg Apache-2.0.

## Brand Commitments
- Name: ImplantPlan. The brand slot shows the logomark only (the implant-in-bone tile), with no wordmark.
- Sibling product: ImplantPlan VR (Quest). The web app takes its technology cues, not its panels.
- The public landing page is the published identity of the product.

## Evidence on Hand
- Measured model evidence lives in `dentistry/models.py` and `eval/`. Example cases are held-out ToothFairy3 scans.
- Product films: `marketing/video/implantplan-plan.mp4` and `implantplan-pipeline.mp4`. VR captures are under `marketing/video/implantplanVR-videos/`.
- There are no customer testimonials, clinical validations or regulatory clearances. Never imply any.

## Product Principles
- A number is shown with how far to trust it, or not shown.
- The scan is the subject: chrome recedes, and the anatomy is never obscured.
- Say what ran, what was refused and why. No silent fallback.
- One obvious next step per screen.

## Accessibility & Inclusion
- WCAG 2.2 AA contrast for all chrome text.
- Verdicts never rely on colour alone.
- Every control is reachable by keyboard; the plan tab has full keyboard placement.
