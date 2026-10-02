'use strict';
/* ------------------------------------------------------- implant editing tools
 * What a planner is expected to let you do, and what this now does.
 *
 * Every implant-planning package converges on the same small set: nudge the implant in
 * the section, change its angulation, change its depth, change its size, step between
 * implants, re-seat it on the ridge, duplicate one you already like, and undo. Dragging
 * covers the coarse move; the keyboard is what makes the last tenth of a millimetre
 * reachable, because a 0.1 mm step is under one screen pixel at ordinary zoom and no
 * pointer can be asked for it.
 *
 * The steps are millimetres and degrees, never pixels, so a nudge means the same thing
 * at every zoom level and on every screen.
 */
const NUDGE_MM = 0.1;
const NUDGE_COARSE_MM = 1.0;
const TILT_STEP_DEG = 1;
const TILT_COARSE_DEG = 5;

/** Undo, over implant edits only. A planner without one makes a drag a commitment. */
const UNDO_DEPTH = 40;
function pushUndo(label) {
  const p = implantState();
  p.undo = p.undo || [];
  p.undo.push({ label, implants: JSON.parse(JSON.stringify(p.implants)),
                selected: p.selected });
  if (p.undo.length > UNDO_DEPTH) p.undo.shift();
}
function popUndo() {
  const p = implantState();
  if (!p.undo || !p.undo.length) return false;
  const prev = p.undo.pop();
  p.implants = prev.implants;
  p.selected = prev.selected;
  requestMeasure(0);
  drawRulers('xs');
  renderImplantPanel();
  return true;
}

/** Apply a keyboard tool to the selected implant. Returns true if it handled the key. */
function implantKey(e) {
  const v = state.viewer;
  if (!v || v.mode !== 'plan') return false;
  const p = implantState();
  const info = ((p.arch || {}).jaws || {})[p.jaw];
  if (!info || !info.ok) return false;
  const key = e.key;
  const mod = e.metaKey || e.ctrlKey;

  if (mod && (key === 'z' || key === 'Z')) { e.preventDefault(); return popUndo(); }
  // Tab steps between implants even with nothing selected, so a plan is navigable from
  // the keyboard alone.
  if (key === 'Tab' && p.implants.length > 1) {
    e.preventDefault();
    const i = p.implants.findIndex((x) => x.id === p.selected);
    const n = p.implants.length;
    selectImplant(p.implants[((i < 0 ? 0 : i) + (e.shiftKey ? n - 1 : 1)) % n].id);
    return true;
  }
  const imp = p.implants.find((x) => x.id === p.selected);
  if (!imp || imp.jaw !== p.jaw) return false;
  const step = e.shiftKey ? NUDGE_COARSE_MM : NUDGE_MM;
  const down = imp.jaw === 'maxilla' ? 1 : -1;
  let did = true;

  switch (key) {
    // Buccolingual and depth, in the section's own axes. Down is APICAL in either jaw,
    // so the key means the same thing in the maxilla as in the mandible.
    case 'ArrowLeft': pushUndo('move'); imp.t_mm -= step; break;
    case 'ArrowRight': pushUndo('move'); imp.t_mm += step; break;
    case 'ArrowDown': pushUndo('depth'); imp.z_mm += down * step; break;
    case 'ArrowUp': pushUndo('depth'); imp.z_mm -= down * step; break;
    // Angulation. Clamped to the same MAX_TILT_DEG the drag and the number field use.
    case ',': case '<':
      pushUndo('tilt');
      imp.tilt_deg = Math.max(-MAX_TILT_DEG,
        imp.tilt_deg - (e.shiftKey ? TILT_COARSE_DEG : TILT_STEP_DEG));
      break;
    case '.': case '>':
      pushUndo('tilt');
      imp.tilt_deg = Math.min(MAX_TILT_DEG,
        imp.tilt_deg + (e.shiftKey ? TILT_COARSE_DEG : TILT_STEP_DEG));
      break;
    // Mesiodistal angulation -- the panoramic's plane. Next to the buccolingual pair on
    // the keyboard because they are the same gesture in two planes, and refused
    // outright when the manifest publishes no tangents: yaw rotates toward +s, and the
    // tangent is what defines which way +s points. Deriving it as `up x n` gets the
    // SIGN wrong at the far ends of real arches, so a refusal beats a mirror.
    case ';': case ':':
      if (!canYaw(info)) { did = false; break; }
      pushUndo('yaw');
      imp.yaw_deg = Math.max(-MAX_YAW_DEG,
        (Number(imp.yaw_deg) || 0) - (e.shiftKey ? TILT_COARSE_DEG : YAW_STEP_DEG));
      break;
    case "'": case '"':
      if (!canYaw(info)) { did = false; break; }
      pushUndo('yaw');
      imp.yaw_deg = Math.min(MAX_YAW_DEG,
        (Number(imp.yaw_deg) || 0) + (e.shiftKey ? TILT_COARSE_DEG : YAW_STEP_DEG));
      break;
    // Clocking. Wraps rather than clamping -- a rotation has no ends -- and is the one
    // tool here that changes no number, which the panel says in as many words.
    case 'r': case 'R':
      pushUndo('clocking');
      imp.roll_deg = (((Number(imp.roll_deg) || 0)
        + (e.shiftKey ? -ROLL_STEP_DEG : ROLL_STEP_DEG) + 360) % 360);
      break;
    // Size, stepped through the served catalogue rather than by free arithmetic: a
    // diameter this app cannot name is a diameter nobody can order.
    case '+': case '=': pushUndo('length'); stepSize(imp, 'length_mm', +1, e.shiftKey); break;
    case '-': case '_': pushUndo('length'); stepSize(imp, 'length_mm', -1, e.shiftKey); break;
    // Re-seat on the ridge: undo a drag that wandered, without deleting the implant.
    case 'c': case 'C':
      pushUndo('re-seat');
      alignToSite(info, imp);
      break;
    // Duplicate, offset one tooth-width mesially. The commonest second implant.
    case 'd': case 'D': {
      if (p.implants.length >= MAX_IMPLANTS) { did = false; break; }
      pushUndo('duplicate');
      const copy = { ...imp, id: null, s_mm: imp.s_mm - 7 };
      const made = addImplant(copy.s_mm, null);
      if (made) Object.assign(made, { ...copy, id: made.id, site_fdi: null });
      break;
    }
    case 'Delete': case 'Backspace':
      pushUndo('remove');
      p.implants = p.implants.filter((x) => x.id !== imp.id);
      p.selected = p.implants.length ? p.implants[0].id : null;
      break;
    default: did = false;
  }
  if (!did) return false;
  e.preventDefault();
  clampImplant(info, imp);
  requestMeasure(220);
  drawRulers('xs');
  renderImplantPanel();
  return true;
}

/** Move one catalogue step. `wide` steps the DIAMETER instead of the length. */
function stepSize(imp, field, dir, wide) {
  const cat = implantSizes();
  const list = wide ? cat.diameter : cat.length;
  const f = wide ? 'diameter_mm' : field;
  const i = list.findIndex((x) => Math.abs(x - imp[f]) < 1e-6);
  const j = Math.max(0, Math.min(list.length - 1, (i < 0 ? 0 : i) + dir));
  imp[f] = list[j];
}

/** Whether mesiodistal angulation is available on this jaw's manifest.
 *
 *  It needs `tangents`, and for one reason: yaw rotates the axis toward +s, and the
 *  tangent array is the only published thing that says which direction that is.
 *  `plan_geometry.implant_frame` raises rather than derive it from `up x n`, because the
 *  handedness of the published normals relative to the published tangents FLIPS at the
 *  extreme ends of 2 of 10 real jaw fits -- so a derived sign would mirror the
 *  angulation exactly where a third molar sits. The control is disabled with that
 *  reason on it, which is a stated absence rather than a dead input. */
function canYaw(info) {
  return !!(info && Array.isArray(info.tangents) && info.tangents.length);
}

/** Keep an implant inside the picture it is drawn on. A pose the section cannot show is
 *  a pose the reader cannot check. */
function clampImplant(info, imp) {
  const f = xsFrame(info);
  const tMax = Math.abs(f.tMin) - imp.diameter_mm / 2;
  imp.t_mm = Math.max(-tMax, Math.min(tMax, imp.t_mm));
  const zLo = f.zTop - (info.cross_sections.size[0] - 1) * f.rowPitch;
  imp.z_mm = Math.max(zLo + 1, Math.min(f.zTop - 1, imp.z_mm));
  // ...and inside the ARCH, now that the panoramic can drag it along one. Off the end
  // of the polyline the frame is clamped to the last index, so the implant would stop
  // moving while its stored `s_mm` kept going -- two poses, one picture.
  const arc = (info.cross_sections || {}).s_mm || [];
  if (arc.length) {
    imp.s_mm = Math.max(Math.min(arc[0], arc[arc.length - 1]),
                        Math.min(Math.max(arc[0], arc[arc.length - 1]), imp.s_mm));
  }
  if (!canYaw(info)) imp.yaw_deg = 0;
}

/** How near a published site has to be, along the arch, to count as THIS site.
 *  Half a premolar: close enough to be the same position, far enough that a click
 *  between two teeth does not silently claim one of them. */
const SITE_ADOPT_MM = 3.5;

/** The FDI position this arc coordinate belongs to, or null. */
function siteAt(info, s_mm) {
  const sites = info.sites || {};
  let best = null; let bestD = Infinity;
  Object.keys(sites).forEach((k) => {
    const st = sites[k];
    if (!st || st.s_mm == null) return;
    const d = Math.abs(st.s_mm - s_mm);
    if (d < bestD) { bestD = d; best = k; }
  });
  return bestD <= SITE_ADOPT_MM ? Number(best) : null;
}

/** How far below the crest the platform sits. A slightly sub-crestal platform is the
 *  ordinary placement: it puts the rough surface in bone and gives the soft tissue
 *  somewhere to sit. */
const SUBCRESTAL_MM = 0.5;

/** The bone this app will not plan into: the safety margin plus the segmentation's own
 *  inward error, which is exactly the surface the verdict is graded against. */
const APICAL_RESERVE_MM = 2.5;

/** Buccal and lingual plate this app will not plan through, per side.
 *
 *  0.75 is the FLOOR -- what the geometry forbids, not what a surgeon would accept. The
 *  restorative-driven diameter below is what is actually offered; this only ever narrows
 *  it. */
const PLATE_RESERVE_MM = 0.75;

/** The diameter a site WANTS, by the tooth being replaced, before the ridge has a say.
 *
 *  This is the half of implant selection the previous version had backwards. It chose
 *  "the widest that leaves 0.75 mm of plate", which on a 9.4 mm molar ridge is a 6.0 mm
 *  implant -- an implant nobody places at a first molar, sitting in a site that would
 *  then have 1.7 mm of bone a side. Diameter is chosen by the RESTORATION: what tooth is
 *  being replaced, and what emergence profile its crown needs. The ridge then narrows
 *  that choice or refuses the site; it never widens it.
 *
 *  Central values, by FDI position number. Wider than these exist and are placed, but a
 *  planner's STARTING point is a standard-platform implant for the tooth, and the reader
 *  changes it from a sensible number rather than down from an extreme one. */
const SITE_DIAMETER_MM = {
  1: 3.5,   // central incisor
  2: 3.3,   // lateral incisor -- the narrowest site in the mouth
  3: 3.75,  // canine
  4: 4.1,   // first premolar
  5: 4.1,   // second premolar
  6: 4.8,   // first molar
  7: 4.8,   // second molar
  8: 4.3,   // third molar, when it is restored at all
};

/** Longer is not better, and this is the cap that says so.
 *
 *  Beyond roughly 13 mm there is no survival benefit in the literature, and the binding
 *  constraint on a lower posterior implant is the inferior alveolar canal rather than
 *  the total height of the mandible. A 24 mm site does not license a 16 mm implant; it
 *  licenses the same 10-13 mm implant with more bone under it. */
const MAX_PLANNED_LENGTH_MM = 13;
/** What a planner reaches for first when the bone allows it. */
const PREFERRED_LENGTH_MM = 10;

/** Put a new implant where a clinician would start it, not where the code found it easy.
 *
 *  It used to seed `z = occlusal_z_mm - 1.0`: one millimetre below the BITING SURFACE.
 *  That is the top of the crown, not the top of the bone -- on a molar site with 8 mm of
 *  crown the implant spawned floating in the tooth, and every plan began by dragging it
 *  down. `ridge.py` has published `crest_z_mm` per site all along.
 *
 *  So: platform half a millimetre below the crest, and a size a clinician would actually
 *  start from --
 *    - diameter: what the TOOTH needs (`SITE_DIAMETER_MM`), narrowed by the measured
 *      ridge if the ridge cannot take it;
 *    - length: 10 mm where the bone allows, the longest that fits below that, and never
 *      more than 13 -- capped independently of how much bone is underneath.
 *
 *  This used to take the widest and the longest that geometrically fit, which produced a
 *  6.0 x 16 mm implant at a lower first molar with 23.9 mm of height and a 9.4 mm ridge.
 *  Both numbers were true and neither was a plan: nobody places a 6 mm implant at a 46,
 *  and the extra 6 mm of length buys nothing while spending the clearance the whole
 *  product exists to grade. Fitting is a CONSTRAINT, not an objective.
 *
 *  Both fall back to the catalogue default when the site publishes no measurement, and
 *  the fallback is a REFUSAL to guess rather than a guess: the default is not claimed to
 *  fit.
 */
function alignToSite(info, imp) {
  const cat = implantSizes();
  const site = imp.site_fdi != null
    ? (info.sites || {})[String(imp.site_fdi)] : null;
  const down = imp.jaw === 'maxilla' ? 1 : -1;
  const crest = site && site.crest_z_mm != null ? site.crest_z_mm : null;
  // No crest: fall back to the occlusal plane, and say so rather than pretending.
  imp.z_mm = crest != null ? crest + down * SUBCRESTAL_MM
    : info.occlusal_z_mm + down * 1.0;
  // ON THE RIDGE, not on the arch curve. This was `0` with the comment "the crest
  // midline, which is where ridge.py measures" -- and that was true of the measurement
  // and false of the anatomy: `_crest_z` sampled only the `t = 0` column, so the curve
  // WAS the midline by assumption rather than by finding the bone. On a sloped or
  // atrophic ridge the curve falls on the flank, and a fixture seated there has its
  // buccal wall against the outer cortex. `ridge.py` now sweeps for the top of the
  // ridge and publishes where it found it; seat on that.
  imp.t_mm = site && site.crest_t_mm != null ? site.crest_t_mm : 0;
  imp.tilt_deg = 0;
  // ALL THREE angles, not just the one. `C` is "re-seat on the ridge", and a re-seat
  // that left a 20-degree mesiodistal angulation in place would put the platform on
  // the crest and the apex somewhere nobody asked for -- which is exactly the
  // half-reset that made a "complete record" necessary in `measure_sites`.
  imp.yaw_deg = 0;
  imp.roll_deg = 0;
  imp.alignedTo = crest != null ? 'crest' : 'occlusal';

  // LENGTH. Preferred first, capped second, and only then limited by the bone.
  const h = site && site.height_mm != null ? site.height_mm : null;
  if (h != null) {
    const usable = Math.min(h - SUBCRESTAL_MM - APICAL_RESERVE_MM, MAX_PLANNED_LENGTH_MM);
    const fits = cat.length.filter((L) => L <= usable);
    if (!fits.length) {
      imp.length_mm = Math.min(...cat.length);
      imp.lengthFrom = 'shortest available — this site is short of bone';
    } else if (fits.includes(PREFERRED_LENGTH_MM)) {
      imp.length_mm = PREFERRED_LENGTH_MM;
      imp.lengthFrom = 'the usual starting length, and the bone takes it';
    } else {
      imp.length_mm = Math.max(...fits);
      imp.lengthFrom = usable >= MAX_PLANNED_LENGTH_MM
        ? 'the longest this planner offers' : 'the longest the measured height takes';
    }
  } else {
    imp.lengthFrom = null;
  }

  // DIAMETER. What the tooth needs, narrowed by the ridge — never widened by it.
  const w = site && site.width_mm != null ? site.width_mm : null;
  const pos = imp.site_fdi != null ? Number(String(imp.site_fdi).slice(-1)) : null;
  const wanted = (pos != null && SITE_DIAMETER_MM[pos]) || null;
  if (w != null) {
    const usable = w - 2 * PLATE_RESERVE_MM;
    const fits = cat.diameter.filter((D) => D <= usable);
    if (!fits.length) {
      imp.diameter_mm = Math.min(...cat.diameter);
      imp.diameterFrom = 'narrowest available — this ridge is too thin for it';
    } else if (wanted != null && fits.some((D) => D >= wanted)) {
      // The catalogue value nearest what the tooth wants, from those the ridge allows.
      imp.diameter_mm = fits.reduce((best, D) =>
        Math.abs(D - wanted) < Math.abs(best - wanted) ? D : best, fits[0]);
      imp.diameterFrom = 'the usual platform for this tooth, and the ridge takes it';
    } else {
      imp.diameter_mm = Math.max(...fits);
      imp.diameterFrom = wanted != null
        ? 'narrowed from the usual platform — the ridge is too thin for it'
        : 'the widest the measured ridge takes';
    }
  } else if (wanted != null) {
    imp.diameter_mm = wanted;
    imp.diameterFrom = 'the usual platform for this tooth — this ridge was not measured';
  } else {
    imp.diameterFrom = null;
  }
  return imp;
}

function nearestXsIndex(info, s_mm) {
  const arr = info.cross_sections.s_mm;
  let best = 0;
  for (let k = 1; k < arr.length; k += 1) {
    if (Math.abs(arr[k] - s_mm) < Math.abs(arr[best] - s_mm)) best = k;
  }
  return best;
}

function wireImplants() {
  const cv = $('xsCanvas');
  cv.addEventListener('pointerdown', (e) => {
    const p = implantState();
    const info = ((p.arch || {}).jaws || {})[p.jaw];
    if (!info || !info.ok || !p.implants.length) return;
    const pt = canvasPoint(cv, e);
    if (!pt) return;
    for (const imp of p.implants) {
      if (imp.jaw !== p.jaw) continue;
      const part = hitTest(imp, info, pt);
      if (part) {
        // Grabbing an implant is a placement gesture, not a measurement one, so the
        // ruler must not also start a drag from the same pointerdown.
        e.stopImmediatePropagation();
        p.selected = imp.id;
        p.drag = { id: imp.id, part, from: pt, t0: imp.t_mm, z0: imp.z_mm,
                   tilt0: imp.tilt_deg, len0: imp.length_mm };
        cv.setPointerCapture(e.pointerId);
        renderImplantPanel();
        drawRulers('xs');
        return;
      }
    }
  }, true);                            // capture: ahead of the ruler's listener

  cv.addEventListener('pointermove', (e) => {
    const p = planState();
    if (!p.drag) return;
    const info = ((p.arch || {}).jaws || {})[p.jaw];
    const pt = canvasPoint(cv, e);
    if (!pt) return;
    const f = xsFrame(info);
    const dt = (pt.x - p.drag.from.x) * f.colPitch;
    const dz = -(pt.y - p.drag.from.y) * f.rowPitch;
    const imp = p.implants.find((i) => i.id === p.drag.id);
    if (!imp) return;
    if (p.drag.part === 'body' || p.drag.part === 'platform') {
      imp.t_mm = p.drag.t0 + dt;
      imp.z_mm = p.drag.z0 + dz;
    } else if (p.drag.part === 'apex') {
      // The apex steers the tilt within the section plane; Shift lengthens instead.
      if (e.shiftKey) {
        imp.length_mm = Math.max(6, Math.min(16, p.drag.len0 + (imp.jaw === 'maxilla' ? dz : -dz)));
      } else {
        imp.tilt_deg = Math.max(-MAX_TILT_DEG,
                                Math.min(MAX_TILT_DEG, p.drag.tilt0 + dt * 3));
      }
    }
    drawRulers('xs');
    requestMeasure(220);
  });

  cv.addEventListener('pointerup', (e) => {
    const p = planState();
    if (!p.drag) return;
    p.drag = null;
    try { cv.releasePointerCapture(e.pointerId); } catch { /* already gone */ }
    requestMeasure(0);
  });
}

/** The panoramic's own pointer gestures: move along the arch, and set the yaw.
 *
 *  Registered in the CAPTURE phase, ahead of `wireRuler`'s listener on the same
 *  element, and it stops immediate propagation when it takes the gesture -- otherwise
 *  the same pointerdown would also start a ruler and, on release without movement,
 *  scrub the section stack out from under the implant being dragged.
 *
 *  These two are the gestures the panoramic had none of. Mesiodistal POSITION had no
 *  pointer at all -- `s_mm` was only reachable by placing a new implant or by `D`,
 *  which offsets by a fixed 7 mm -- and mesiodistal ANGULATION had no control anywhere.
 */
function wirePanImplants() {
  const cv = $('panCanvas');
  if (!cv) return;
  cv.addEventListener('pointerdown', (e) => {
    const p = implantState();
    const info = ((p.arch || {}).jaws || {})[p.jaw];
    if (!info || !info.ok || !p.implants.length) return;
    const pt = canvasPoint(cv, e);
    if (!pt) return;
    for (const imp of p.implants) {
      if (imp.jaw !== p.jaw) continue;
      const part = panHitTest(imp, info, cv, pt);
      if (!part) continue;
      e.stopImmediatePropagation();
      p.selected = imp.id;
      p.panDrag = { id: imp.id, part, from: panMmOf(info, cv, pt),
                    s0: imp.s_mm, z0: imp.z_mm, yaw0: imp.yaw_deg || 0 };
      cv.setPointerCapture(e.pointerId);
      renderImplantPanel();
      drawRulers('pan');
      return;
    }
  }, true);

  cv.addEventListener('pointermove', (e) => {
    const p = planState();
    if (!p || !p.panDrag) return;
    const info = ((p.arch || {}).jaws || {})[p.jaw];
    const pt = canvasPoint(cv, e);
    if (!pt) return;
    const imp = p.implants.find((i) => i.id === p.panDrag.id);
    if (!imp) return;
    const now = panMmOf(info, cv, pt);
    if (p.panDrag.part === 'body') {
      imp.s_mm = p.panDrag.s0 + (now.s_mm - p.panDrag.from.s_mm);
      imp.z_mm = p.panDrag.z0 + (now.z_mm - p.panDrag.from.z_mm);
      // The site follows the position, or is dropped: a plan that still claims FDI 36
      // after being dragged onto 34 measures its tooth clearance against the wrong
      // exclusion and prints the wrong tooth number on the sheet.
      imp.site_fdi = siteAt(info, imp.s_mm);
    } else {
      // The yaw handle. Solve the pose for the direction the pointer is asking for
      // rather than accumulating pixels: the axis satisfies
      //   axis_s / axis_z = tan(yaw) / (down * cos(tilt)),
      // so a target `(ds, dz)` gives `tan(yaw) = (ds / dz_apical) * cos(tilt)` and the
      // gesture means the same thing at every zoom level and on every screen.
      const down = imp.jaw === 'maxilla' ? 1 : -1;
      const ds = now.s_mm - imp.s_mm;
      const apical = (now.z_mm - imp.z_mm) * down;
      if (apical > 0.5) {
        const ct = Math.cos((Number(imp.tilt_deg) || 0) * Math.PI / 180);
        const want = Math.atan2(ds * ct, apical) * 180 / Math.PI;
        imp.yaw_deg = Math.max(-MAX_YAW_DEG, Math.min(MAX_YAW_DEG, want));
      }
    }
    clampImplant(info, imp);
    drawRulers('pan');
    // The section has to follow: the implant may have left the slice in view, and the
    // outline there is what the clearance chips hang off.
    drawRulers('xs');
    requestMeasure(220);
  });

  cv.addEventListener('pointerup', (e) => {
    const p = planState();
    if (!p || !p.panDrag) return;
    const imp = p.implants.find((i) => i.id === p.panDrag.id);
    p.panDrag = null;
    try { cv.releasePointerCapture(e.pointerId); } catch { /* already gone */ }
    // Land on the section the implant is now nearest to, so the buccolingual view and
    // the mesiodistal one are looking at the same place.
    const info = ((p.arch || {}).jaws || {})[p.jaw];
    if (imp && info) selectXs(nearestXsIndex(info, imp.s_mm));
    requestMeasure(0);
    renderImplantPanel();
  });
}

let _measureTimer = null;
/** Ask the server. Debounced during a drag; immediate on release. */
/** True only while `autofitAfterMeasure` is asking for its own re-measure.
 *
 *  ONE flag instead of a `cancelAutofit` at each of a dozen call sites. Every other route
 *  into `requestMeasure` -- the size selects, the three angle inputs, the section drag,
 *  the panoramic drag, the keyboard nudges, `alignToSite` on a re-seat -- is a deliberate
 *  act by the reader, and a reader who has touched the implant owns it from that moment,
 *  verdict and all. Enumerating those routes would mean the one that got added later was
 *  the one that fought the user. */
let _autofitPass = false;

function requestMeasure(delayMs) {
  const p = implantState();
  if (!_autofitPass) p.implants.forEach(cancelAutofit);
  _autofitPass = false;
  if (_measureTimer) clearTimeout(_measureTimer);
  if (!p.implants.length) { p.measured = {}; renderImplantPanel(); return; }
  p.measuring = true;
  renderImplantPanel();
  // Neutral the 3-D actors for the whole interval between here and the server's reply.
  if (window.DentistryViewer && DentistryViewer.setImplantVerdict) {
    p.implants.forEach((imp) => DentistryViewer.setImplantVerdict(imp.id, null));
  }
  _measureTimer = setTimeout(async () => {
    const v = state.viewer;
    try {
      const r = await api(`/jobs/${v.jobId}/measure`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ implants: p.implants }),
      });
      p.measured = Object.fromEntries((r.implants || []).map((m) => [m.id, m]));
      // Pairwise distances are PLAN-level, not per-implant, so they live beside the
      // map rather than in it. Sorted ascending by the server, so [0] is the binding
      // pair and that is the one worth putting in front of the reader.
      p.pairs = r.pairs || [];
      // `edits` and `edit_penalty` travel WITH the priors rather than beside them: they
      // are terms in the same budget, and a reader looking at "0.76 mm deducted" has to
      // be able to find the 0.46 and the 0.30 in one place.
      p.priors = { ...(r.priors || {}), edits: r.edits || [],
                   edit_penalty: r.edit_penalty || {} };
      p.notice = r.notice;
      p.measureError = null;
      p.measuredStale = null;
    } catch (err) {
      p.measureError = err.message;
      // The pack outlives nothing: results are deleted after RESULT_TTL_HOURS (72) and
      // the plan is not. `db.CasePlan` says a plan whose pack has expired must render
      // its LAST numbers with the date and a note -- "never silently stale, never
      // blank" -- and the server now caches exactly that on every save. Fall back to
      // it, clearly dated, rather than showing an error where numbers used to be.
      const cur = (planListState() || {}).current;
      const cached = cur && cur.measured;
      if (cached && (cached.implants || []).length) {
        p.measured = Object.fromEntries((cached.implants || []).map((m) => [m.id, m]));
        p.pairs = cached.pairs || [];
        p.priors = cached.priors; p.notice = cached.notice;
        p.measuredStale = cur.measured_at || 'an earlier session';
      }
    }
    p.measuring = false;
    renderImplantPanel();
    drawRulers('xs');
    if (window.DentistryViewer && DentistryViewer.setImplantVerdict) {
      p.implants.forEach((imp) => DentistryViewer.setImplantVerdict(
        imp.id, worstVerdict(imp, p, { gradedOnly: true })));
    }
    // A freshly seeded implant shortens itself until the MEASUREMENT says clear.
    if (autofitAfterMeasure(p)) return;      // it re-measured; this pass is superseded
  }, delayMs);
}

/** The clearance bar: the budget drawn literally, hatch and all. */
/** One clearance's arithmetic, drawn with every term named.
 *
 *  Takes the VERDICT rather than the measurement, so it can draw the canal, the
 *  accessory canals and the teeth identically -- each with its OWN inward-error term,
 *  which differ by 2-3x and must not be interchanged. `exact: true` (the inter-implant
 *  case) has no error term at all and says so, because a deduction that does not apply
 *  would be theatre. */
/** The millimetre span every bar in one implant's block is drawn against.
 *
 *  Each bar used to pick its own `Math.max(6, val + 1.5)`, so two bars stacked in the
 *  same card had different millimetres per pixel and a 13 mm clearance could look
 *  identical to a 2 mm one. A bar chart whose bars are not comparable is a decoration.
 *  Recomputed per render from every value in view, floored so a set of tiny clearances
 *  still has a readable axis.
 */
let _barSpanMm = 8;
function setBarSpan(verdicts) {
  let hi = 0;
  (verdicts || []).forEach((v) => {
    const n = (v || {}).numbers || {};
    [n.clearance_mm, n.distance_mm, n.at_least_mm, n.margin_mm].forEach((x) => {
      if (typeof x === 'number' && Number.isFinite(x)) hi = Math.max(hi, x);
    });
  });
  _barSpanMm = Math.max(6, hi * 1.12);
}

/** @param bare  draw the TRACK only, with no legend.
 *
 *  The legend is the arithmetic spelled out -- "13.66 measured, minus 0.46 the canal may
 *  be under-drawn by, against a 2.00 margin" -- and it is ~120 characters per bar, three
 *  bars per implant. It is worth reading once and not on every glance, so the compact
 *  row draws the picture and the disclosure carries the words. The bar itself never
 *  goes away: it is the only thing that makes two clearances comparable, and it carries
 *  the margin rule, which is the single most important mark this product draws. */
function budgetBar(v, bare) {
  const n = (v || {}).numbers || {};
  const val = n.clearance_mm != null ? n.clearance_mm : n.distance_mm;
  const cls = { clear: 'ok', tight: 'warn', breach: 'bad' }[v.level] || 'none';
  const span = _barSpanMm;
  const pct = (x) => `${Math.max(0, Math.min(100, (x / span) * 100))}%`;
  // The saturated branch: the field ran out of range, so the answer is a BOUND, not a
  // number. It used to fall through the `val == null` guard and render no bar at all --
  // which meant the SAFEST implants, the ones far enough away to exhaust the distance
  // field, were the only ones with no picture. Drawn open-ended, because "at least this
  // far" is exactly what the geometry supports.
  if (val == null && typeof n.at_least_mm === 'number') {
    return `<div class="cbar ${cls}">
      <div class="cbar-track">
        <i class="cbar-fill cbar-open" style="width:${pct(n.at_least_mm)}"></i>
        <i class="cbar-rule" style="left:${pct(n.margin_mm)}"></i>
      </div>
      ${bare ? '' : `<div class="cbar-legend">
        more than <span class="mono">${n.at_least_mm.toFixed(2)} mm</span> &mdash; beyond
        what this measurement reaches, so it is stated as a bound, against a
        <span class="mono">${Number(n.margin_mm).toFixed(2)}</span> mm minimum
      </div>`}
    </div>`;
  }
  if (val == null) return '';
  if (n.exact) {
    return `<div class="cbar ${cls}">
      <div class="cbar-track">
        <i class="cbar-fill" style="width:${pct(val)}"></i>
        <i class="cbar-rule" style="left:${pct(n.margin_mm)}"
           title="the ${n.margin_mm} mm minimum"></i>
      </div>
      ${bare ? '' : `<div class="cbar-legend">
        <span class="mono">${val.toFixed(2)} mm</span> exact &mdash; no segmentation in
        this figure, so nothing is deducted &rarr;
        <b class="mono">${n.headroom_mm >= 0 ? '+' : ''}${n.headroom_mm.toFixed(2)} mm</b>
        beyond the <span class="mono">${n.margin_mm.toFixed(2)}</span> mm minimum
      </div>`}
    </div>`;
  }
  return `<div class="cbar ${cls}">
    <div class="cbar-track">
      <i class="cbar-fill" style="width:${pct(n.informed_mm)}"></i>
      <i class="cbar-hatch" style="left:${pct(n.informed_mm)};width:${pct(n.inward_p95_mm)}"></i>
      <i class="cbar-rule" style="left:${pct(n.margin_mm)}"
         title="the ${n.margin_mm} mm margin"></i>
    </div>
    ${bare ? '' : `<div class="cbar-legend">
      <span class="mono">${val.toFixed(2)} mm</span> measured
      &minus; <span class="mono">${n.inward_p95_mm.toFixed(2)}</span> the
      ${esc(n.measured_against || 'segmentation')} may be under-drawn by
      = <span class="mono">${n.informed_mm.toFixed(2)}</span> against a
      <span class="mono">${n.margin_mm.toFixed(2)}</span> margin
      &rarr; <b class="mono">${n.headroom_mm >= 0 ? '+' : ''}${n.headroom_mm.toFixed(2)} mm</b> headroom
    </div>`}
  </div>`;
}

/** One structure's block: headline, bar, and the reasons.
 *
 *  Still used for the PAIRWISE list and by the print sheet's prose. The per-implant
 *  panel uses `clearanceRow` instead -- see there for why. */
function clearanceBlock(v, label) {
  if (!v || !v.headline) return '';
  return `<div class="cblock">
    <p class="verdict ${v.level}"><span class="cblabel">${esc(label)}</span>
      ${esc(v.headline)}</p>
    ${budgetBar(v)}
    ${(v.because || []).length
      ? `<ul class="why">${v.because.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}
  </div>`;
}

/** The word a verdict level is READ as. Never colour alone.
 *
 *  `no_verdict` is the reason this exists. It is not a weaker `clear`; it means the
 *  measurement carried a caveat and the grader refused to grade it. Rendered as a
 *  colour it was a paler green, and a paler green reads as a paler pass. */
const VERDICT_WORD = { breach: 'breach', tight: 'tight', clear: 'clear',
                       no_verdict: 'not graded' };

/** What the row's number says, in as few characters as it can be true in. */
function clearanceValueText(v) {
  const n = (v || {}).numbers || {};
  const val = n.clearance_mm != null ? n.clearance_mm : n.distance_mm;
  if (typeof val === 'number') return `${val.toFixed(2)} mm`;
  if (typeof n.at_least_mm === 'number') return `> ${n.at_least_mm.toFixed(1)} mm`;
  return '\u2014';
}

/** One structure, as ONE LINE, with the prose behind a disclosure.
 *
 *  Measured on the live site before this: a single implant produced 2745 characters in
 *  an 1118 px card, and 65% of the sidebar was scrolled out of reach with no scrollbar
 *  to say so. Three `clearanceBlock`s alone were 816 px of it, most of that the
 *  `because[]` lists -- which the printed sheet already carries, DE-DUPLICATED, in
 *  "How every figure above was obtained". So on screen they are one click away and on
 *  paper they are unchanged.
 *
 *  WHAT NEVER HIDES, in any state: the structure label, the verdict as a WORD, the
 *  number (or the bound, or an em dash), the bar on the one shared millimetre scale,
 *  and a marker when the measurement carried a caveat. A collapsed row that could hide
 *  a breach would be worse than the wall of text it replaces.
 *
 *  The open/closed state lives in `p.openRows`, NOT in the `<details>` element: this
 *  panel re-renders on every drag frame and every slider tick, and DOM state does not
 *  survive `innerHTML =`.
 */
function clearanceRow(v, m, label, rowKey, p) {
  if (!v || !v.level) return '';
  const caveated = !!((m || {}).caveats || []).length;
  // Forced open, not merely open by default: an ungraded or caveated row is exactly the
  // one a reader must not skim past.
  const forced = v.level === 'no_verdict' || caveated;
  const open = forced || (p.openRows && p.openRows.has(rowKey));
  // REASONS and PROVENANCE are two different things and the server's `because[]` mixes
  // them: "tooth 46 is still present in this scan, so this may be the distance to the
  // tooth being replaced" sits in the same list as "the drawn wall may sit up to 0.46 mm
  // inside the true one at the 95th percentile". The first is why this number cannot be
  // trusted here; the second is how every number in the plan was obtained, identical
  // across implants, and already on the printed sheet DE-DUPLICATED.
  //
  // So the row body shows the headline and the CAVEATS -- the server's own "do not
  // trust this" channel, the one a non-empty entry in which suppresses the verdict --
  // and `because[]` goes one level deeper. Nothing is lost and a forced-open row stays
  // short enough to read.
  const caveats = ((m || {}).caveats) || [];
  return `<details class="crow c-${v.level}" data-row="${esc(rowKey)}" ${open ? 'open' : ''}>
    <summary>
      <span class="vchip v-${v.level}">${VERDICT_WORD[v.level] || v.level}</span>
      <span class="crow-label">${esc(label)}${caveated ? ' <b class="crow-flag" title="this measurement carries a caveat">!</b>' : ''}</span>
      <span class="crow-mm mono">${clearanceValueText(v)}</span>
      ${budgetBar(v, true)}
    </summary>
    <div class="crow-why">
      <p>${esc(v.headline)}</p>
      ${caveats.length
        ? `<ul class="why">${caveats.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>` : ''}
    </div>
  </details>`;
}


