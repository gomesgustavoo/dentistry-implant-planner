'use strict';
/* ---------------------------------------------------------------- implants */
/* Placement is stored in the ARCH frame -- (s, t, z) plus a tilt -- and never in LPS.
 *
 * With zero yaw the implant lies ENTIRELY inside the cross-section on screen, so the
 * drag is genuinely two-dimensional in the picture rather than a projection of
 * something else, and the browser and the server derive the same pose from the same
 * published polyline. They cannot disagree, because neither converts.
 *
 * `yaw` is carried in the schema and locked to 0 here. A yawed implant leaves the
 * visible plane and has to be drawn as a projection with an out-of-plane badge; that is
 * a later increment, not a shortcut taken quietly.
 *
 * There is no "provisional" in-plane estimate. The design allowed for one -- an upper
 * bound computed in the browser from section polygons -- but POST /measure is a lookup
 * over a precomputed field rather than a computation, so the authoritative answer comes
 * back in tens of milliseconds and an approximation would be a second, worse number for
 * a user to read. The bar shows "measuring" between a drag and its answer, and a verdict
 * colour appears ONLY once the server has replied.
 */
/** The implant size menu. SERVED, not a literal.
 *
 *  This was a hard-coded `{diameter: [...], length: [...]}` here with no server-side
 *  counterpart, so nothing validated a stored implant against a real size and the plan
 *  export could not say what was planned. `GET /v1/implants` now owns it
 *  (`dentistry/implants.py`), which also carries the caveat the panel has to show: the
 *  solid measured and exported is a capsule of the stated diameter and length, a
 *  faithful envelope for clearance and NOT any real implant's thread form.
 *
 *  The fallback exists so the plan tab still works if the catalogue call fails; it is
 *  the smallest sensible menu, not a second source of truth. */
const IMPLANT_SIZES_FALLBACK = {
  diameter_mm: [3.3, 3.75, 4.1, 4.8],
  length_mm: [6, 8, 10, 11.5, 13],
};
let IMPLANT_CATALOG = null;

async function loadImplantCatalog() {
  if (IMPLANT_CATALOG) return IMPLANT_CATALOG;
  try {
    IMPLANT_CATALOG = await api('/implants');
  } catch (e) {
    console.warn('dentistry: implant catalogue unavailable, using the fallback menu:',
                 e.message);
    IMPLANT_CATALOG = { ...IMPLANT_SIZES_FALLBACK, platforms: [], lengths: [],
                        notice: '' };
  }
  return IMPLANT_CATALOG;
}

function implantSizes() {
  const c = IMPLANT_CATALOG || IMPLANT_SIZES_FALLBACK;
  return { diameter: c.diameter_mm || IMPLANT_SIZES_FALLBACK.diameter_mm,
           length: c.length_mm || IMPLANT_SIZES_FALLBACK.length_mm };
}

/** Mirrors `api/routes/plans.MAX_IMPLANTS`. The server enforces it on both `/measure`
 *  and the plan schema; the client disables the Add button so a reader is told the limit
 *  instead of meeting it as a 422. */
const MAX_IMPLANTS = 8;
/** Mirrors the clamp the apex drag applies. One constant, so the number field and the
 *  drag cannot disagree about what is reachable. */
const MAX_TILT_DEG = 35;

/** Mesiodistal angulation, the angle the panoramic draws at true value.
 *
 *  Tighter than the buccolingual clamp on purpose. Buccolingual tilt is routinely large
 *  -- an anterior maxillary implant follows a labially inclined ridge -- while a
 *  mesiodistally angulated implant is fighting the neighbouring roots on both sides,
 *  and past about 30 degrees the abutment cannot be brought back to the occlusal plane.
 *  The server accepts up to 45; the reason the client stops earlier is clinical, not
 *  arithmetic, so it is stated here rather than duplicated as a bare number. */
const MAX_YAW_DEG = 30;
const YAW_STEP_DEG = 1;

/** Clocking, in fifteens: the connection hex has six-fold symmetry, so 15 degrees is
 *  half an index position and there is nothing finer to ask for.
 *
 *  IT MOVES NO MEASUREMENT. The measured solid is a body of revolution about the axis,
 *  so every clearance is invariant under it exactly; `/measure` returns that sentence
 *  in `pose.notes` and the panel prints it. A control that changes the picture and not
 *  the numbers has to say so, or a reader concludes the numbers are broken. */
const ROLL_STEP_DEG = 15;

/** How much of the implant, measured down from the platform, carries the verdict band.
 *
 *  1.2 mm is the machined collar length of a 10 mm implant in the catalogue's middle,
 *  so the band sits on the part of a real implant that has no thread -- and at the
 *  section's ~5.6 px/mm it is 7 px, which is legible without competing with the outline.
 */
const COLLAR_BAND_MM = 1.2;

function implantState() {
  const p = planState();
  if (!p.implants) { p.implants = []; p.selected = null; p.measured = {}; p.measuring = false; }
  // Which disclosure rows the reader has opened. In PLAN STATE, not in the `<details>`
  // elements: this panel is rebuilt with `innerHTML =` on every drag frame and every
  // slider tick, so DOM open state survives for about 16 ms.
  if (!p.openRows) p.openRows = new Set();
  return p;
}

/* ------------------------------------------------- the section's view of a 3-D pose
 * THE PROJECTION OF A CAPSULE IS A CAPSULE, and that one fact is the whole reason
 * mesiodistal angulation can be drawn here honestly rather than refused.
 *
 * The measured solid is `segment (+) ball(r)`. Orthogonal projection distributes over a
 * Minkowski sum, the projection of the ball is a disc of the same radius, and the
 * projection of the axis segment is a segment in the SAME in-plane direction: the axis
 * is `(sin y, sin t cos y, down cos t cos y)` in `(s, t, z)`, so dropping the `s`
 * component leaves `cos y * (sin t, down cos t)`. Direction unchanged, length scaled.
 *
 * So a yawed implant costs this drawing exactly one scalar -- `fore` -- and every depth
 * along the axis is drawn at `u * fore`. Nothing else in the outline, the envelope, the
 * hit test or the platform band changes, and at `yaw = 0` every one of them is
 * bit-identical to what it drew before.
 *
 * What it does NOT license is drawing a 3-D distance in this plane. A clearance is
 * measured in three dimensions; its in-plane projection is shorter than the number on
 * the chip. `drawDistances` therefore drops the caliper when the pose is out of plane
 * and keeps the chip, which is the same rule it already applies to mesial/distal.
 */
function sectionAxis(imp) {
  const down = imp.jaw === 'maxilla' ? 1 : -1;
  const tl = (Number(imp.tilt_deg) || 0) * Math.PI / 180;
  const yw = (Number(imp.yaw_deg) || 0) * Math.PI / 180;
  return { a: Math.sin(tl), b: down * Math.cos(tl),
           fore: Math.abs(Math.cos(yw)), yawed: Math.abs(yw) > 1e-9 };
}

/** The implant outline in the section's own (t, z) millimetres: body + apical dome.
 *
 *  Foreshortened by `sectionAxis().fore` when the pose is angulated out of plane; see
 *  the block comment above for why that is exact and not an approximation. */
function implantOutline(imp) {
  const r = imp.diameter_mm / 2;
  const { a, b, fore } = sectionAxis(imp);
  // axis unit in (t, z); the perpendicular is (-b, a)
  const shoulder = (imp.length_mm - r) * fore;
  const pt = (u, w) => [imp.t_mm + a * u - b * w, imp.z_mm + b * u + a * w];
  const out = [pt(0, r), pt(shoulder, r)];
  for (let i = 1; i < 12; i += 1) {
    const th = (i / 12) * Math.PI;
    out.push(pt(shoulder + r * Math.sin(th), r * Math.cos(th)));
  }
  out.push(pt(shoulder, -r), pt(0, -r));
  return out;
}

/* ------------------------------------------------- structure outlines on the section
 * Until now the plan cross-section was bare greyscale: the canal was a dark oval and
 * nothing on screen said WHICH structure the millimetres beside it were measured to, or
 * whether the segmentation agreed with the image at all. That is the product's whole
 * argument, made invisible.
 *
 * The producer is `worker/panoramic.py`, on the SAME sampling grid the picture is built
 * from, at the mid plane of the slab, through `worker/contours.plane_polygons` -- so
 * the outline is the same iso level as the 3-D surface, the STL and the RTSTRUCT.
 * The renderer is `drawContourSlice`, shared verbatim with the tile view.
 */

/** Three states, three behaviours: drawn, this case predates outlines, or fetch failed.
 *  Read from the arch manifest, NEVER from a 404 probe -- with auth on, a 401 and a 404
 *  look identical to a fetch, and "this case predates outlines" must not be what a
 *  session whose token expired is told. */
async function loadXsContours() {
  const p = planState();
  const v = state.viewer;
  const info = ((p.arch || {}).jaws || {})[p.jaw];
  const rel = info && info.cross_sections && info.cross_sections.contours;
  p.xsc = p.xsc || {};
  if (!rel) { p.xsc[p.jaw] = { state: 'unpublished' }; return null; }
  if (p.xsc[p.jaw] && p.xsc[p.jaw].state !== 'pending') return p.xsc[p.jaw].data || null;
  if (p.xscPending && p.xscPending[p.jaw]) return p.xscPending[p.jaw];
  p.xscPending = p.xscPending || {};
  p.xscPending[p.jaw] = (async () => {
    const jaw = p.jaw;
    try {
      const r = await cachedFetch(`${API}/jobs/${v.jobId}/files/planning/${rel}`);
      p.xsc[jaw] = { state: 'ok', data: await r.json() };
    } catch (e) {
      p.xsc[jaw] = { state: 'failed', reason: e.message };
      console.warn('dentistry: section outlines unavailable:', e.message);
    }
    setXsOverlay(xsOverlayPref);
    return (p.xsc[jaw] || {}).data || null;
  })();
  return p.xscPending[p.jaw];
}

/** The structures the plan tab draws by default.
 *
 *  Not "everything on the section": a molar section cuts the mandible, one or two
 *  teeth, the canal and sometimes an accessory canal, and drawing all of them at the
 *  tile view's fill would bury the greyscale the outline exists to be checked against.
 *  Not "the canal only" either -- the tooth clearance and any EXISTING implant or
 *  restoration beside the site are things the reader is deciding against.
 *
 *  Derived from the served catalogue by id, never from hard-coded indices: the label
 *  set has been renumbered before and an integer here would silently point at a
 *  different structure. */
function planKeySet(opts) {
  const v = state.viewer;
  const p = (v && v.plan) || {};
  const forThree = !!(opts && opts.three);
  // The implant being worked on, and the tooth it is REPLACING. On an extraction-site
  // plan that tooth is still in the scan, and in 3-D it sits exactly between the camera
  // and the implant -- measured: the pane showed a solid tooth and no implant at all.
  // It is still drawn on the SECTION, where it is behind the outline rather than in
  // front of it and is the thing the -2.05 mm is measured to.
  const sel = (p.implants || []).find((i) => i.id === p.selected);
  // NOTHING SELECTED, NOTHING TO NARROW FOR. The 3-D narrowing exists for one reason:
  // at implant zoom every neighbour sits between the implant and the camera. With no
  // implant on screen there is nothing being hidden, and narrowing anyway left the plan
  // tab opening on a partial case -- one jaw, no restorations -- which reads as a worse
  // segmentation rather than as a focused view. `null` means "no focus" to the viewer.
  if (forThree && !sel) return null;
  const siteFdi = sel && sel.site_fdi != null ? String(sel.site_fdi) : null;
  const sites = (((p.arch || {}).jaws || {})[p.jaw] || {}).sites || {};
  const here = sel ? sel.s_mm : null;
  const out = new Set();
  (allStructures() || []).forEach((st) => {
    const id = String(st.id || '');
    const fdi = st.fdi != null ? String(st.fdi) : null;
    // AN ALLOWLIST, not "everything that is not a tooth".
    //
    // The denylist version was written first and it pulled in the PHARYNX -- a purple
    // column running the height of the scan, which at implant zoom is a translucent wall
    // straight through the middle of the pane, burying the neighbouring roots this change
    // exists to reveal. It was the same mistake as adding the opposing jaw, which was
    // tried in the same pass and reverted for the same reason. A denylist admits whatever
    // is added to the taxonomy next, and the taxonomy has 89 entries now.
    //
    // What is context for placing a screw, and nothing else:
    //   * every nerve canal -- the thing the whole product measures to;
    //   * the maxillary sinuses -- the upper jaw's equivalent constraint;
    //   * bridges, crowns and existing implants -- what the docstring above calls
    //     "things the reader is deciding against", and what the old code silently
    //     dropped despite saying so;
    //   * the WORKING jaw, ghosted, because it encloses the implant;
    //   * the neighbouring teeth, below.
    if (/canal/.test(id) || /^sinus_max/.test(id)
        || id === 'bridge' || id === 'crown' || id === 'implant') {
      out.add(st.index); return;
    }
    if (id === 'maxilla' || id === 'mandible') {
      // The opposing jaw is a wall between the camera and a site in this one.
      if (id === p.jaw) out.add(st.index);
      return;
    }
    if (!/^tooth_/.test(id)) return;
    if (forThree && fdi && fdi === siteFdi) return;          // the tooth being replaced
    // In 3-D, the neighbours. 14 mm reached ONE tooth each way on a molar site -- a
    // lower molar is 10-11 mm across, so the second neighbour fell outside by a
    // millimetre and vanished. 24 mm reaches two each way, which is the span a reader
    // checks an emergence profile and a mesiodistal gap against.
    if (forThree && here != null && fdi && sites[fdi] && sites[fdi].s_mm != null
        && Math.abs(sites[fdi].s_mm - here) > NEIGHBOUR_SPAN_MM) return;
    out.add(st.index);
  });
  return out;
}

/** How far along the arch a tooth still counts as a neighbour of this site.
 *
 *  24, not 14. A lower first molar is 10-11 mm mesiodistally, so at 14 the SECOND
 *  neighbour each way missed the cut by about a millimetre and simply was not drawn --
 *  which looks like the model failed to segment it, on a pane whose whole job is showing
 *  the implant among the teeth it has to sit between. */
const NEIGHBOUR_SPAN_MM = 24;

/* How see-through the anatomy is while planning.
 *
 * An implant is INSIDE bone and BETWEEN roots, so at implant zoom every one of its
 * neighbours is between it and the camera. Measured at the catalogue's opacities: the
 * pane showed a solid tooth, then bone, then two roots, and the implant not at all.
 * Ghosting them keeps the context -- which is what the 3-D pane is for, since the
 * SECTION is where the millimetres are read -- and lets the metal be the thing you see.
 *
 * The jaw goes lower than the teeth because it fully encloses the implant, while a
 * neighbouring root only crosses part of it.
 */
// 0.10 was tuned on a full dentition, where 32 opaque teeth carry the picture and the
// jaw is genuinely just a wrapper. On a partially edentulous case -- which is the case an
// implant is actually planned on -- the jaw IS the anatomy, and at 0.10 the pane showed
// two red canals floating in black. 0.18 keeps the implant dominant and gives the ridge
// back its shape.
const PLAN_JAW_OPACITY = 0.18;
const PLAN_TOOTH_OPACITY = 0.30;

/** Keep the 3-D pane's focus in step with the selection. */
function refreshPlanFocus() {
  const v = state.viewer;
  if (!v || !window.DentistryViewer || !DentistryViewer.setSurfaceFocus) return;
  const plan = v.mode === 'plan';
  const focus = plan ? planKeySet({ three: true }) : null;
  DentistryViewer.setSurfaceFocus(focus);
  if (!DentistryViewer.setSurfaceOpacity) return;
  // GHOSTING IS FOR SEEING PAST SOMETHING. It exists because at implant zoom the jaw
  // encloses the implant and the neighbours cross it, so both have to go translucent for
  // the metal to be visible at all. With no implant selected there is nothing to see past
  // -- `focus` is null for exactly that reason -- and ghosting anyway just handed the
  // reader a washed-out case and called it a plan view.
  const ghosting = plan && focus != null;
  (allStructures() || []).forEach((st) => {
    const id = String(st.id || '');
    const ghost = /jaw|maxilla|mandible/.test(id) ? PLAN_JAW_OPACITY
      : /^tooth_/.test(id) ? PLAN_TOOTH_OPACITY : null;
    if (ghost == null) return;
    DentistryViewer.setSurfaceOpacity(st.index, ghosting ? ghost : null);
  });
}

/** Paint this section's outlines, in IMAGE pixels.
 *
 *  `sx = sy = 1` because `planCtx` has already put the context in image pixels -- the
 *  the retired tile view passed a 2x scale because its context was in backing-store px.
 *  Outline-only by default (fill 0): a fill hides the greyscale the outline is there to
 *  be checked against, which is the opposite of the point.
 */
function drawXsContours(g, info) {
  const p = planState();
  const v = state.viewer;
  if (!info || !info.ok || !v) return;
  if ((p.xsOverlay || xsOverlayPref) === 'off') return;
  const store = (p.xsc || {})[p.jaw];
  if (!store || store.state !== 'ok') { loadXsContours(); return; }
  const slice = store.data && store.data[String(p.index)];
  if (!slice) return;
  // 2 image px = 0.30 mm at the published 0.1506 mm/px. The canal is ~2.7 mm across, so
  // the outline is ~11% of its diameter: visible without swallowing it. In IMAGE pixels
  // rather than CSS, so it scales with the picture rather than getting hairline-thin as
  // the section grows.
  drawContourSlice(g, slice, { sx: 1, sy: 1, fill: 0, outline: 2,
    only: (p.xsOverlay || xsOverlayPref) === 'all' ? null : planKeySet() });
}

/** The implant grown by `m` millimetres: the exact Minkowski offset of the capsule.
 *
 *  Substituting `d -> d + 2m` and `L -> L + m` into `implantOutline` gives
 *  `r' = r + m` and `shoulder' = (L + m) - (r + m) = L - r` -- the SAME axis segment
 *  with the radius grown by exactly `m`. So the envelope needs no new geometry, and it
 *  cannot drift from the outline it surrounds. */
function implantEnvelope(imp, m) {
  return implantOutline({ ...imp, diameter_mm: imp.diameter_mm + 2 * m,
                          length_mm: imp.length_mm + m });
}

/** (t, z) mm -> canvas pixels on the current cross-section. */
function tzToPixel(info, t_mm, z_mm) {
  const f = xsFrame(info);
  return { x: (t_mm - f.tMin) / f.colPitch, y: (f.zTop - z_mm) / f.rowPitch };
}

function hitTest(imp, info, pt) {
  const f = xsFrame(info);
  const t = f.tMin + pt.x * f.colPitch;
  const z = f.zTop - pt.y * f.rowPitch;
  const { a, b, fore } = sectionAxis(imp);
  const dt = t - imp.t_mm, dz = z - imp.z_mm;
  const along = dt * a + dz * b;                 // depth down the PROJECTED axis
  const across = Math.abs(-dt * b + dz * a);
  // The grab zones are on the picture, so they are measured on the projection: a
  // 45-degree yaw draws a 10 mm implant 7.1 mm long, and an apex handle at 10 mm
  // would sit 2.9 mm past the end of the thing on screen.
  const len = imp.length_mm * fore;
  if (across > imp.diameter_mm / 2 + 0.8) return null;
  if (along < -0.8 || along > len + 0.8) return null;
  if (along > len - 1.2) return 'apex';
  if (along < 1.2) return 'platform';
  return 'body';
}

/** THE ONE COLOUR RULE, and it holds in every view.
 *
 *  The implant body is TITANIUM GREY -- on the section, in the panoramic and in 3-D.
 *  The verdict is never the implant's own colour. It was, and two things went wrong at
 *  once: the user could not tell metal from a warning, and `breach` salmon collided with
 *  the coral the inferior alveolar canal surface is already drawn in, so the alarm and
 *  the thing it was about were the same hue in the 3-D pane.
 *
 *  So the verdict lives on marks that are not the implant: a collar band at the
 *  platform, the safety envelope, and the chip in the side panel. `verdictColour` is
 *  the single source for all of them, and `viewer/src/implants.js`'s `VERDICT_RGB` is
 *  its twin -- `web-auth/check-app.js` asserts the two agree, so this ternary's SHAPE is
 *  load-bearing and must not be refactored into a lookup without moving that check.
 */
function verdictColour(v, measuring) {
  return !v || measuring ? '#94a3b8'
    : v.level === 'breach' ? '#f87171'
    : v.level === 'tight' ? '#fbbf24'
    : v.level === 'clear' ? '#34d399' : '#94a3b8';
}

/** The pose in words, for the printed sheet and for the print-only `::after`.
 *
 *  Every angle that is set is named, and CLOCKING SAYS WHAT IT DOES NOT DO. A reader
 *  looking at a printed plan with "37 degrees rotation" on it and no number changed
 *  anywhere would otherwise be entitled to think a measurement had been missed; the
 *  measured solid is a body of revolution about the axis, so the invariance is exact.
 */
function anglePrint(imp) {
  const bits = [];
  const t = Number(imp.tilt_deg) || 0;
  const y = Number(imp.yaw_deg) || 0;
  const r = Number(imp.roll_deg) || 0;
  if (t) bits.push(`${t.toFixed(0)}\u00b0 buccolingual`);
  if (y) bits.push(`${y.toFixed(0)}\u00b0 mesiodistal`);
  if (r) bits.push(`${r.toFixed(0)}\u00b0 clocking (changes no clearance)`);
  return bits.join(', ');
}
function sizeOnly(imp) {
  return `${imp.diameter_mm} \u00d7 ${imp.length_mm} mm`;
}
function posePrint(imp) {
  const a = anglePrint(imp);
  return a ? `${sizeOnly(imp)}, ${a}` : sizeOnly(imp);
}

/** Machined titanium, the same grey the 3-D body uses. */
const IMPLANT_BODY = '#c7ccd4';

/** Draw the implants that lie on the section in view.
 *
 *  Takes its context and its manifest as ARGUMENTS. It used to reach for
 *  `cv.getContext('2d')` and inherit whatever transform `drawRulers` had left, which
 *  was correct only because `drawRulers` was the sole caller -- and silently wrong for
 *  any future one. `drawRulers` already holds both, so this costs nothing.
 */
function drawImplants(g, info) {
  const p = implantState();
  if (!info || !info.ok) return;
  const here = p.implants.filter((i) => i.jaw === p.jaw
    && Math.abs(i.s_mm - info.cross_sections.s_mm[p.index]) <= XS_NEAR_MM);
  here.forEach((imp) => {
    const poly = implantOutline(imp).map(([t, z]) => tzToPixel(info, t, z));
    const sel = p.selected === imp.id;
    const v = (p.measured[imp.id] || {}).verdict;
    // The verdict colour still reports the SERVER and nothing else, and is neutral while
    // a drag is in flight -- a colour a reader takes for "safe" must never come from
    // anything but a completed measurement. It just no longer paints the metal.
    const cue = verdictColour(v, p.measuring);
    const r = imp.diameter_mm / 2;
    const { a, b, fore, yawed } = sectionAxis(imp);
    // `u` is a TRUE depth down the implant axis and is projected here, once, so every
    // mark below -- axis, platform, collar band, apex cross -- lands on the same
    // foreshortened body the outline draws.
    const at = (u, w) => tzToPixel(info,
      imp.t_mm + a * u * fore - b * w, imp.z_mm + b * u * fore + a * w);

    g.save();
    // The SAFETY ENVELOPE, before the body so the implant sits on top of it.
    //
    // TWO rings, because there are two different true statements and only drawing one
    // of them would be misleading. The inner is the stated minimum -- 2.00 mm to nerve,
    // the number a coDiagnostiX user expects to see labelled "the margin". The outer is
    // the surface the verdict is ACTUALLY computed against: `plan_safety.budget_for`
    // grades a breach when `clearance < margin + inward_p95`, so on the canal the real
    // boundary is 2.46 mm. Both radii are read from the /measure reply -- no prior is
    // ever a literal here, so if `plan_safety` moves one, the drawn ring moves with it.
    if (sel && p.priors) {
      const pr = p.priors;
      const isMand = imp.jaw !== 'maxilla';
      const margin = Number(isMand ? pr.margin_mm : pr.adjacent_margin_mm);
      const field = isMand ? 'canal' : 'tooth';
      const p95 = Number(((pr.by_structure || {})[field] || {}).p95_mm);
      [[margin, [3, 3], .34], [margin + p95, [1, 3], .5]].forEach(([mm, dash, alpha]) => {
        if (!Number.isFinite(mm)) return;
        const ring = implantEnvelope(imp, mm).map(([t, z]) => tzToPixel(info, t, z));
        g.beginPath();
        ring.forEach((q, i) => (i ? g.lineTo(q.x, q.y) : g.moveTo(q.x, q.y)));
        g.closePath();
        g.strokeStyle = cue; g.globalAlpha = alpha;
        g.lineWidth = 1; g.setLineDash(dash);
        g.stroke();
      });
      g.globalAlpha = 1; g.setLineDash([]);
    }
    // The body.
    g.beginPath();
    poly.forEach((q, i) => (i ? g.lineTo(q.x, q.y) : g.moveTo(q.x, q.y)));
    g.closePath();
    g.fillStyle = 'rgba(199,204,212,.20)';
    g.fill();
    g.strokeStyle = IMPLANT_BODY;
    g.lineWidth = sel ? 2.2 : 1.4;
    g.setLineDash(p.measuring && sel ? [5, 4] : []);
    g.stroke();
    g.setLineDash([]);

    // The axis, so the angulation is readable without measuring it off the outline.
    g.beginPath();
    const ax0 = at(0.4, 0), ax1 = at(imp.length_mm - r * 0.4, 0);
    g.moveTo(ax0.x, ax0.y); g.lineTo(ax1.x, ax1.y);
    g.strokeStyle = 'rgba(199,204,212,.55)';
    g.lineWidth = sel ? 1.0 : 0.7;
    g.setLineDash([2, 3]);
    g.stroke();
    g.setLineDash([]);

    // The platform, drawn as the flat coronal face it is, and the COLLAR BAND that
    // carries the verdict. This is the only coloured mark on the implant.
    g.beginPath();
    const pl0 = at(0, r), pl1 = at(0, -r);
    g.moveTo(pl0.x, pl0.y); g.lineTo(pl1.x, pl1.y);
    g.strokeStyle = IMPLANT_BODY;
    g.lineWidth = sel ? 2.6 : 1.8;
    g.stroke();

    g.beginPath();
    const cb = COLLAR_BAND_MM;
    [[0, r], [cb, r], [cb, -r], [0, -r]].forEach(([u, w], i) => {
      const q = at(u, w);
      return i ? g.lineTo(q.x, q.y) : g.moveTo(q.x, q.y);
    });
    g.closePath();
    g.fillStyle = cue;
    g.globalAlpha = sel ? 0.85 : 0.6;
    g.fill();
    g.globalAlpha = 1;

    // The apex. It is where the canal verdict is decided, so it gets a mark of its own.
    const ap = at(imp.length_mm, 0);
    g.beginPath();
    g.moveTo(ap.x - 3, ap.y); g.lineTo(ap.x + 3, ap.y);
    g.moveTo(ap.x, ap.y - 3); g.lineTo(ap.x, ap.y + 3);
    g.strokeStyle = IMPLANT_BODY;
    g.lineWidth = sel ? 1.2 : 0.9;
    g.stroke();
    g.restore();
  });
}

/** Mirror the implant list into the 3D pane.
 *
 *  Driven off the same `p.implants` array the section draws from, so the two views
 *  cannot show different poses. The verdict that travels with each implant is
 *  `worstVerdict(..., {gradedOnly: true})` -- the worst grade actually established over
 *  every structure, not the canal's alone; see that function for why the shell and the
 *  strip rank `no_verdict` differently on purpose. And the same rule applies as in the
 *  2-D outline: while a measurement is in flight the level is null, which the viewer
 *  paints NEUTRAL. A colour the reader interprets as "safe" must never come from
 *  anything but a completed measurement. */
function syncImplants3d() {
  if (!window.DentistryViewer || !DentistryViewer.setImplants) return;
  const p = implantState();
  const v = state.viewer;
  if (!v || !v.mprMounted) return;
  DentistryViewer.setImplants(p.implants.map((imp) => ({
    ...imp,
    // `selected` drives the safety envelope's opacity, so the one being worked on reads
    // clearly and the others stay context rather than becoming soup.
    selected: p.selected === imp.id,
    // The worst COMPLETED grade, not the canal's alone -- see `worstVerdict`. Neutral
    // only when nothing at all was graded; ungradedness is reported by the strip and the
    // clearance rows, not by draining the colour out of the envelope.
    verdict: p.measuring ? null : worstVerdict(imp, p, { gradedOnly: true }),
  })));
  // FRAME THE NEW ONE, once, here -- because here is the first moment it can be framed.
  // `addImplant` sets `p.selected` directly rather than going through `selectImplant`, so
  // nothing ever called `focusImplant` for a freshly placed implant; and calling it there
  // would not have worked anyway, since `focusImplant` looks the id up in the viewer's
  // actor registry and returns false when it is absent -- which it is until this function
  // has run. Measured before this: place an implant and the 3-D pane stayed framed on the
  // whole mandible, so a 552 x 594 px pane showed the screw as a speck, and the framing
  // only arrived if the reader happened to resize something (`afterLayoutChange` re-fits
  // on the way past). One flag, cleared as it is consumed, so a later re-sync never
  // yanks the camera back from wherever the reader has since moved it.
  if (p.focusPending && p.focusPending === p.selected && DentistryViewer.focusImplant) {
    if (DentistryViewer.focusImplant(p.focusPending)) p.focusPending = null;
  }
}

/** Seed an implant at an arc position, sized from the catalogue's middle. */
function addImplant(s_mm, fdi) {
  const p = implantState();
  const info = ((p.arch || {}).jaws || {})[p.jaw];
  if (!info || !info.ok) return null;
  if (p.implants.length >= MAX_IMPLANTS) return null;
  // `i${length + 1}` COLLIDES: place i1 and i2, remove i1, add again and the new implant
  // is also "i2". Ids key `p.measured`, the 3-D actor registry and the pairwise table,
  // so a duplicate silently merges two implants into one everywhere at once. Counter
  // that only goes up.
  p.nextId = Math.max(Number(p.nextId) || 1,
                      ...p.implants.map((i) => (Number(String(i.id).slice(1)) || 0) + 1));
  const id = `i${p.nextId}`;
  p.nextId += 1;
  const imp = { id, jaw: p.jaw, s_mm, t_mm: 0, tilt_deg: 0, yaw_deg: 0, roll_deg: 0,
                length_mm: 10, diameter_mm: 4.1,
                // Added from the section rather than from the chart? Adopt whatever
                // site this arc position IS. Without it `+ Add implant` had no site, so
                // it fell back to the occlusal plane and spawned in the crown -- the
                // chart path aligned to bone and the button path did not, for no reason
                // a user could see.
                site_fdi: fdi == null ? siteAt(info, s_mm) : Number(fdi) };
  alignToSite(info, imp);
  // Seeded, not chosen. `autofitAfterMeasure` shortens it if the server's own canal
  // clearance says the seed is tight, and clears the flag the moment it settles.
  imp.autofit = true;
  p.implants.push(imp);
  p.selected = id;
  // Claimed here, consumed by `syncImplants3d` as soon as the actor exists.
  p.focusPending = id;
  const i = nearestXsIndex(info, s_mm);
  if (i !== p.index) selectXs(i); else { drawRulers('xs'); }
  // The seeding measure is the auto-fit's FIRST pass, not a user edit, so it must not
  // clear the flag it was just given.
  _autofitPass = true;
  requestMeasure(0);
  renderImplantPanel();
  return imp;
}

/** Shorten a freshly seeded implant until the server says its canal clearance is CLEAR.
 *
 *  ## Why seeding needed a feedback loop rather than a better formula
 *
 *  `alignToSite` sizes from `site.height_mm`, and that is already the right quantity:
 *  `ridge.py` publishes it as "cortical crest to the roof of the drawn inferior alveolar
 *  canal, read from the same distance field the implant clearance is measured against".
 *  It is not a proxy for the canal distance -- it IS a canal distance.
 *
 *  It still disagreed with the verdict by about 0.85 mm at a real site, and the reasons
 *  are geometric rather than fixable by tuning a reserve:
 *
 *    * the height is sampled on ONE line -- the crest midline, or wherever the canal
 *      roof is closest, which on the measured case was 2.0 mm buccal of it -- while the
 *      clearance is the minimum over the whole implant surface;
 *    * the implant is a CAPSULE. Its apex is a hemisphere of radius d/2, so the nearest
 *      point to the canal is on a curved shoulder, not at the axis tip, and how much
 *      that costs depends on the angle between the axis and the canal;
 *    * `tight` is a band above `breach`, so clearing the breach threshold that
 *      `APICAL_RESERVE_MM` approximates still lands inside it.
 *
 *  Any constant that made this site seed clear would be wrong at the next one. So the
 *  seed is a first guess and the SERVER's own number is what settles it: if the canal
 *  comes back tight or breached, step down one catalogue length and ask again. That is
 *  the same number the verdict is computed from, which is the only one that cannot
 *  disagree with the verdict.
 *
 *  Bounded at three steps, and it stops at the shortest implant in the catalogue: a site
 *  where even that is not clear is a site this planner should be SAYING is short of
 *  bone, not one it should keep shrinking an implant into. `lengthFrom` records which
 *  ending happened, and the panel prints it.
 *
 *  Only ever on `autofit`, which `addImplant` sets and any human edit clears -- a reader
 *  who deliberately chooses 13 mm over a canal must keep the 13 mm and the red verdict.
 */
const AUTOFIT_MAX_STEPS = 3;

/** Any deliberate change ends the seeding loop. Driven from `requestMeasure` rather than
 *  from each edit path -- see `_autofitPass`. */
function cancelAutofit(imp) {
  if (!imp || !imp.autofit) return;
  delete imp.autofit;
  delete imp.autofitSteps;
}
function autofitAfterMeasure(p) {
  const imp = p.implants.find((i) => i.autofit);
  if (!imp) return false;
  const m = p.measured[imp.id] || {};
  const level = ((m.verdict || {}).level) || null;
  const steps = Number(imp.autofitSteps) || 0;
  // Clear, ungradeable, or out of steps: this is the length, whatever it is.
  if (level === 'clear' || level == null || level === 'no_verdict'
      || steps >= AUTOFIT_MAX_STEPS) {
    delete imp.autofit; delete imp.autofitSteps;
    if (steps > 0 && level === 'clear') {
      imp.lengthFrom = `shortened ${steps} size${steps === 1 ? '' : 's'} — `
        + 'the longest length that measures clear of the canal here';
    } else if (steps > 0) {
      imp.lengthFrom = 'the shortest this planner will seed — the canal is close at '
        + 'this site and no catalogue length measured clear';
    }
    renderImplantPanel();
    return false;
  }
  const cat = implantSizes();
  const shorter = cat.length.filter((L) => L < imp.length_mm);
  if (!shorter.length) {
    delete imp.autofit; delete imp.autofitSteps;
    imp.lengthFrom = 'the shortest implant in the catalogue, and the canal is still '
      + 'closer than the margin — this site may not take an implant';
    renderImplantPanel();
    return false;
  }
  imp.length_mm = Math.max(...shorter);
  imp.autofitSteps = steps + 1;
  _autofitPass = true;
  requestMeasure(0);
  return true;
}

/** Select an implant: the section follows it, the 3-D pane frames it, the panel
 *  re-renders and the 3-D focus set is recomputed around it. ONE path, shared by the
 *  panel click, Tab and the canvas -- three copies of this drifted once already. */
function selectImplant(id) {
  const p = implantState();
  const info = ((p.arch || {}).jaws || {})[p.jaw];
  const imp = p.implants.find((i) => i.id === id);
  if (!imp) return false;
  p.selected = id;
  if (info) selectXs(nearestXsIndex(info, imp.s_mm));
  // Framed along the arch, swung buccally, so the 3-D pane reproduces the picture the
  // cross-section shows without looking straight through the neighbouring roots.
  if (window.DentistryViewer && DentistryViewer.focusImplant) {
    DentistryViewer.focusImplant(id);
  }
  renderImplantPanel();
  return true;
}

