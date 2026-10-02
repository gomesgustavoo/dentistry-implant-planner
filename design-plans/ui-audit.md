# UI audit: ImplantPlan web app (improve-ui)

Written against: `5c1c666` (branch `feat/app-redesign-oss`)

## Design language
- **Audited surface:** `web/` SPA. The shell (`header.topbar`, `#views`), the case workspace imaging panes (`#mprStage` `.pane`, `#planStage` `.pan-wrap` / `.xs-wrap` / `.pane3d-wrap`), and the verdict chips in the plan tools row (`.verdstrip` `.vchip`).
- **Design sources:** `web/DESIGN.md`, including its "Target Direction (approved 2026-10-02)" section, and the `web/app.css` `:root` tokens (l.10-70).
- **Documented decisions:**
  - Logomark only in the brand slot.
  - Light chrome, with imaging panes kept dark as inset screens.
  - `ok` / `warn` / `bad` are the clinical verdict colours.
  - Verdicts are always written as words.
- **Governing owners and consumers:**
  - `:root` tokens → every rule using `var(--ink|--muted|--border|--ground|--ok|--warn|--bad)`.
  - `.brand-word` / `.brand-icon` (`index.html:38-43`, `app.css:135-137, 1245-1246`).
  - `.pane` (`app.css:761`), `.pan-wrap, .xs-wrap, .pane3d-wrap` (`app.css:925`), `.pane-label`, `.pane-note`, `.stage-overlay`, `.stage-empty`.
  - `.vchip` / `.v-*` (`app.css:1064-1074`).
- **Explicit exceptions:** None documented.

## Findings
| # | Problem | Evidence | Proposed change | Scope | Confidence |
| --- | --- | --- | --- | --- | --- |
| 1 | The brand slot shows the wordmark at ≥900 px. | Contract: DESIGN.md Target Direction says "Logomark only … no wordmark beside it or in place of it." Runtime: `index.html:39` renders `img.brand-word` and `app.css:137` hides `.brand-icon` above the 900 px breakpoint (`app.css:1245-1246` swaps them only below it). | Render `img.brand-icon` (`assets/brand/icon-64.png`) at every width and remove `img.brand-word`. | `index.html` brand slot, `app.css` brand rules, and the `Dockerfile.web` cache-bust grep that asserts `wordmark.png?v=`. | High |
| 2 | Text and veils drawn on the dark imaging screens read the chrome tokens. Once the chrome goes light they would paint light-theme values onto black. | Contract: DESIGN.md Target Direction says "Imaging panes stay dark … a dark inset screen inside the light chrome." Runtime: the panes are literal `#000` (`app.css:762, 926`) but their overlays are chrome-token driven: `.pane-label`/`.pane-note` `color: var(--muted)` (`768-776`), `.stage-overlay` `background: color-mix(var(--ground) 82%)` (`780-784`), `.stage-empty` `var(--muted)` (`794`), and pane borders `var(--border)`. With the target ground and muted values, the loading veil becomes a near-white sheet over the CBCT and the labels go grey-on-black. | Scope the current dark values to the imaging screens: re-declare `--ground`, `--surface-3`, `--ink`, `--muted`, `--border` and `--border-2` at their present dark values on `.pane, .pan-wrap, .xs-wrap, .pane3d-wrap`, so everything inside a screen keeps today's palette when `:root` changes. | Every descendant of the four pane classes, in both the MPR and plan stages. | High |
| 3 | Verdict chips hard-code the dark-theme verdict hexes instead of the verdict tokens. | Contract: DESIGN.md Colors says "`ok` / `warn` / `bad` are clinical verdict colours: CLEAR, TIGHT, BREACH." Runtime: `.v-clear`/`.v-tight`/`.v-breach` (`app.css:1068-1070`) use the literals `#34d399` / `#fbbf24` / `#f87171` and their `rgba()` tints. These equal the `:root` values today but would not follow a light-theme retune, leaving `#fbbf24` text on a pale tint in light chrome. | Express each `.v-*` chip's colour, tint and border from `var(--ok)` / `var(--warn)` / `var(--bad)` with `color-mix()` (tint 16 %, border 40 %; breach 18 % / 50 %), keeping the current ratios. | The `.vchip` consumers: the tools-row verdict strip and the implant panel. | High |

## Improve first
Finding 2. It is the only one where moving to the target palette would actively damage the clinical image: a light veil and low-contrast labels painted over the CBCT. The fix uses the existing dark values in one scoped rule, before any `:root` change lands.

---

# Plan 1: The brand slot shows the logomark only

Written against: `5c1c666`

## Evidence chain
- Surface: `header.topbar a#brand` on every view.
- Problem: at ≥900 px the brand renders `assets/brand/wordmark.png`. The icon appears only below 900 px.
- Design evidence: `web/DESIGN.md` Target Direction, "Logomark only."
- Owner: `web/index.html:38-43`, `web/app.css:131-137` and `1240-1246`.
- Scope and affected surfaces: topbar at all widths; `Dockerfile.web` (it greps `wordmark.png?v=${VERSION}`).
- Uncertainty: none.

## Design decision
Use one image at every width: the implant-in-bone tile. Delete the breakpoint swap.

## Reuse
- `web/assets/brand/icon-64.png` and the `.brand-icon` class.
- Exemplar: the existing below-900 px rendering.

## Changes
1. `web/index.html`
   - Change: remove `img.brand-word`. Keep `img.brand-icon` with `alt="ImplantPlan"`.
   - Preserve: `a#brand` with `href="#/cases"` and its aria-label.
   - Verify: one `img` inside `#brand`.
2. `web/app.css`
   - Change: give `.brand-icon` `display:block` by default (size it for the 46 px bar), and delete the `.brand-word` rules and the 900 px swap.
   - Verify: the icon is visible at 3440 px and at 640 px.
3. `Dockerfile.web`
   - Change: replace the `wordmark.png?v=` grep with `icon-64.png?v=`.
   - Verify: the image build passes.

## Scope
- Inherit: every view's topbar.
- Verify: `check-rail.mjs` widths.
- Exclude: the landing page.

## Validation
- Repository: `node web-auth/check-app.js` → ALL PASS. `node web-auth/check-rail.mjs` → no overflow.

## Stop conditions
- Stop if another surface references `wordmark.png`. Check with `grep -rn wordmark web/`.

## Design documentation
- Move "Don't put an icon beside a wordmark" to "The brand is the logomark alone" when DESIGN.md is updated after the visual pass.

---

# Plan 2: The imaging screens own their palette

Written against: `5c1c666`

## Evidence chain
- Surface: `#mprStage .pane`, `#planStage .pan-wrap/.xs-wrap/.pane3d-wrap`, and their overlays.
- Problem: the overlays inside the dark screens read the chrome tokens.
- Design evidence: DESIGN.md Target Direction, "Imaging panes stay dark."
- Owner: `web/app.css:761-800, 925-945`.
- Scope and affected surfaces: every descendant of the four classes. That includes `.pane-label`, `.pane-note`, `.stage-overlay`, `.stage-empty`, the `.spinner` track and the xs/pan captions.
- Uncertainty: the 3-D pane may get a light backdrop under the Target Direction. Its labels then need the chrome palette back, which is a per-pane override.

## Design decision
Re-declare the dark values as custom properties on the screen containers. Everything inside a screen inherits the dark palette no matter what `:root` becomes.

## Reuse
- The current `:root` dark values: `#0a0e13`, `#222b3b`, `#f4f7fa`, `#93a1b8`, `#232d3d`, `#2e3a4d`.
- Exemplar: none. This is the first scoped re-declaration, and it introduces no new token names.

## Changes
1. `web/app.css`, directly after `.pane` and `.pan-wrap…`
   - Change: add a `.pane, .pan-wrap, .xs-wrap, .pane3d-wrap { --ground:…; --surface-3:…; --ink:…; --muted:…; --border:…; --border-2:…; color-scheme: dark; }` block carrying today's values.
   - Preserve: `#000` and `#0a0e13` screen grounds.
   - Verify: the computed `color` of `.pane-label` stays `#93a1b8` after `:root` is changed to the light values.

## Scope
- Inherit: all overlays inside the screens.
- Verify: the editing tool cursor and chips drawn in panes.
- Exclude: the chrome.

## Validation
- Interface: loading veil, empty states and labels across both stages, at 640-3440 px.
- Repository: `node web-auth/check-rail.mjs` → ALL PASS.

## Stop conditions
- Stop if any screen descendant must use the light palette, such as a popover anchored inside a pane.

## Design documentation
- Record "imaging screens carry a scoped dark palette" under Elevation & Depth.

---

# Plan 3: Verdict chips derive from the verdict tokens

Written against: `5c1c666`

## Evidence chain
- Surface: `.verdstrip .vchip`, and implant panel chips.
- Problem: literal hexes at `web/app.css:1068-1070`.
- Design evidence: DESIGN.md Colors, "ok/warn/bad are clinical verdict colours."
- Owner: `web/app.css:1064-1074`.
- Uncertainty: `web-auth/check-app.js` compares the verdict palette between `app.js` and `viewer/src/implants.js`, not CSS. Confirm the check stays green.

## Design decision
Chips read `--ok` / `--warn` / `--bad`, so a palette retune is one edit.

## Reuse
- `--ok`, `--warn`, `--bad`, and `color-mix(in srgb, …)` (already used at `app.css:406`).

## Changes
1. `web/app.css:1068-1070`
   - Change: `background: color-mix(in srgb, var(--ok) 16%, transparent); color: var(--ok); border: 1px solid color-mix(in srgb, var(--ok) 40%, transparent)`. Do the same for tight (16/40) and breach (18/50).
   - Preserve: `.v-no_verdict` dashed and muted.
   - Verify: the computed colours are identical before and after, in the dark theme.

## Validation
- Repository: `node web-auth/check-app.js` → ALL PASS. `node web-auth/check-rail.mjs` → ALL PASS.

## Stop conditions
- Stop if `check-app.js` asserts the literal CSS hexes.

## Design documentation
- None.

---

# Heuristic evaluation (ux-heuristics: Nielsen 10 + Krug)

**Rendered evidence:** the app served from `web/` with the real API on loopback (`DENT_REQUIRE_AUTH=false`, the `scripts/tour_server.mjs` proxy) and Playwright at 1600×900, 1440×900 and 1024×768. Captured states:
- the gate, with the real `auth.js`;
- the catalogue, settings, the MPR workspace and the plan tab, with `auth.js` stubbed;
- example case `ToothFairy3F_058` for the workspace states.

Frames from `marketing/video/implantplan-plan.mp4` were used for the implant-placed state.

## Score

| Mode | Score | Failing diagnostic rows |
| --- | --- | --- |
| Hosted, signed in | **5 / 10** | main action (plan tab), navigation, error messages, unlabeled controls, "huh?" moments |
| Self-hosted, anonymous | **3 / 10** | the five above, plus system status. Settings never stops "Loading…" (402 on `/v1/me`, 500 on workspaces). |

## Findings

| # | Sev | Heuristic | Where | Problem | Fix |
| --- | --- | --- | --- | --- | --- |
| H1 | 3 | Status (N1), Errors (N9) | Settings, anonymous | "Loading your account…", and "Loading…" under Workspace and Plan & billing, never resolve. The console shows `402 no_subscription` and `500 [workspaces]`. "Connect a headset" is offered to a caller the API will 403. | The API reports `authRequired`. With no account, hide Workspace, Plan & billing and Headsets, and say once: "Running without accounts: every scan on this server is visible to anyone who can reach it." Give the legacy tenant a plan so `/v1/me` answers 200. |
| H2 | 2 | Control (N3), Krug "each click obvious" | `/app` cold load | The landing CTA "Open the app" leads to a second screen whose only content is another "Sign in" button. Then comes Keycloak. A live Keycloak session still sees the gate, because there is no check-sso. | Remove the gate. Try a silent sign-in first, then redirect straight to Keycloak, and return to `#/cases`. While redirecting, show only a logomark splash with live text. After 5 s, offer a fallback link. |
| H3 | 2 | Match (N2), Errors (N9) | Model picker | The unavailable model says "TF3_TOOTHSEG_DIR is not set, so this model is not deployed on this worker" in red, which is an environment variable shown to a clinician. The base model gets a one-option segmented control ("apply") that looks like a control and does nothing. | Plain language: "Not installed on this server", with the technical reason inside "What is measured about it". Render the base model's mode as a static "always runs" label, not a control. |
| H4 | 2 | Minimalist (N8), Krug "half the words" | Catalogue | "Which models segment your scan" is the largest panel on the page: three cards, a 3-D preview and a paragraph. Most readers never change it, and it sits between the examples and the reader's own cases. | Collapse it into one summary line under the dropzone ("Runs: ToothFairy3 + anterior canal specialist · ≈98 s · Change models"). The cards and preview open in a disclosure. Put "Your cases" directly after the upload. |
| H5 | 2 | Recognition (N6), Status (N1) | Plan tab, no implant yet | The implants column is an empty column holding a paragraph that tells you to click a section or the chart. The missing tooth (36) isn't marked in the chart as a candidate, and "+ Add implant" doesn't say where it would go. | Mark missing FDI positions in the chart as candidate sites (dashed outline, accent). In the empty state, show one primary button per missing site ("Plan site 36") above the explanatory line. |
| H6 | 2 | Consistency (N4), DESIGN.md Colors | Findings card | QA flags (fragmented teeth, left/right volume ratios) use `warn` amber. That is the TIGHT verdict colour, which DESIGN.md reserves for verdicts. The left/right volume list is a seven-line amber column. | Give QA notices a neutral "notice" style (ink text with a muted marker). Show L/R ratios as a compact two-column table, and colour only the out-of-band values. |
| H7 | 2 | Trunk test, Match (N2) | Top nav | The "Custom models" nav item opens a contact/sales form, and its page title doesn't match the label. | Drop it from primary nav. Link it as "Request a custom model" from the models summary and the catalogue footer. |
| H8 | 2 | Unlabeled controls (Krug) | Case topbar and plan tools row | The case topbar has six icon-only buttons (✎, three layout glyphs, ⚙, ☰, ◫). The plan tools row has five label:value pills ("outlines: key", "view: site", "picture: as rendered", "mesiodistal", "tools") that read as status but are buttons. | Combine layout, rail, dock and display into one labeled "View" menu. Keep "Edit masks" as a text button. Give the plan tools pills explicit labels ("Outlines", "View", "Picture") with the current value as a secondary line in the popover, and a caret affordance. |
| H9 | 1 | Match (N2) | Topbar status pill | "idle" describes the GPU queue, not the user's work. | Show the pill only while one of the reader's jobs is queued or running ("Segmenting · 45 %"). Otherwise hide it. |
| H10 | 1 | Aesthetic (N8) | Model picker head at 1440 px | The `reset` button sits on the panel's right border, clipped against the edge. | This goes away with H4. Otherwise give `.panel-head` tools the panel padding. |

## To reach 10 / 10

1. Fix H1 and H2. They are the first screen anyone sees, hosted or self-hosted.
2. Fix H3, H4 and H7. They make the catalogue a single obvious path: drop a scan, see your cases.
3. Fix H5 and H8. They make the plan tab show its first action and name its controls.
4. Fix H6, H9 and H10 in the visual pass.

---

# Web quality audit (web-quality-audit, Lighthouse 13.5.0)

**Conditions.** Local stack: `scripts/tour_server.mjs` serving `web/` with **no gzip**, and the API on loopback. Lighthouse lab runs, mobile (simulated 4G, 4× CPU) and desktop presets, on the catalogue and on case `25ab2735…`. These are lab numbers on an uncompressed server, not field data; production nginx gzips JS, CSS and JSON.

| Signal | Before | After | Notes |
|---|---|---|---|
| Accessibility, catalogue | 96 | **100** | |
| Accessibility, workspace | 96 | 96 → fixed both findings, not re-scored | Two findings: `.gcount` contrast and no main landmark. Both fixed. |
| CLS, catalogue (desktop) | 0.268 | **0.031** | Playwright trace: 0.0305 |
| CLS, catalogue (mobile) | 0.189 | **0.013** | |
| LCP, catalogue (desktop) | 5.7 s | 4.6 s | See P2-1 |
| TBT, catalogue (desktop) | 70 ms | 80 ms | |
| Best practices | 96 | 96 | The one finding is a 402 from the local test API, which runs without `DENT_LEGACY_PLAN`. It is not a product defect; the compose stack answers 200. |
| SEO | 83 | 66 | The drop is intentional: the app is now `noindex`, with a `robots.txt` that disallows everything. The landing page is the indexable surface. |

## Fixed (P0/P1)
- **CLS: the examples row reserved from first paint.** `#examplesPanel` used to appear only after `/v1/examples` returned and push the models section about 300 px. It is now laid out at once with a skeleton row, and hidden only when a deployment has no examples.
- **CLS: the upload summary line reserved.** `.hero > .uploadplan` gets `min-height: 2.9em`, so the hero no longer grows when `/models` fills it.
- **LCP: the catalogue shell painted before the account round-trips.** `boot()` reveals `#home` before awaiting `/me` and `/tenants`. `route()` still decides everything at the end, and the golden network order is unchanged.
- **Contrast: unavailable and off model cards are dimmed by colour, not opacity.** At 2.55:1 on every line they were failing AA.
- **Contrast: the group counts in the structure list** (`.gcount`) are no longer translucent.
- **Landmark:** the case workspace has `role="main"`.
- **SEO/hygiene:** a meta description, `robots: noindex`, `web/robots.txt`, and `theme-color` matching the light ground.

## Recorded, not fixed (P2)
1. **The 4.2 MB viewer bundle (`web/viewer.js`, about 1 MB gzipped) parses before the app on every page,** including the catalogue, where it only drives the small model preview. That is most of the lab LCP and TBT.
   - Fix: load it `async` behind a `viewerReady` promise that `mountModelSchematic`/`mountVolume` await.
   - Every `window.DentistryViewer` call site has to be guarded; there are 24. A separate change, with the golden master and `check-equivalence.mjs` around it.
2. **`GET /v1/examples` returns the full report of each example (705 KB uncompressed)** when the catalogue reads one number from it (`quality.teeth_found`). Fix: a summary projection in `api/routes/jobs.py`.
3. **The model preview loads about 1.3 MB of meshes on catalogue load.** Fix: defer it until the models section scrolls into view (an IntersectionObserver).
4. **Unminified CSS and JS (~280 KB)** because there is no build step by design. With gzip in production the saving is small; leave as is.
5. **`llms.txt` and `ai-catalog.json`** (agentic-browsing category) do not apply to an authenticated application.
