'use strict';
/* --------------------------------------------------------- the arch chart */
// FDI: quadrants 1 and 4 are the patient's RIGHT, 2 and 3 the left; position 1 is
// at the midline and 8 is the third molar. Drawn in the dental convention -- the
// patient's right on the viewer's left -- and labelled, because getting this
// backwards is exactly the failure mode the whole orientation pipeline exists to
// prevent, and a chart that lied about it would undo that work.
const ARCH_ROWS = [
  { quadrants: [1, 2], y: 16, label: 'upper' },
  { quadrants: [4, 3], y: 52, label: 'lower' },
];

function archGeometry() {
  const out = [];
  const W = 200, cx = W / 2;
  ARCH_ROWS.forEach(({ quadrants, y }) => {
    const [right, left] = quadrants;
    for (let pos = 1; pos <= 8; pos++) {
      // Molars sit further back, so step out and curve away from the midline.
      const dx = 8 + (pos - 1) * 11.4;
      const lift = Math.pow((pos - 1) / 7, 2) * 13;
      const w = pos <= 2 ? 8 : pos <= 5 ? 9.5 : 11;
      const h = pos <= 2 ? 11 : pos <= 5 ? 11 : 12.5;
      const upper = y < 30;
      const yy = upper ? y + lift : y - lift;
      out.push({ fdi: right * 10 + pos, x: cx - dx - w / 2, y: yy, w, h, side: 'right' });
      out.push({ fdi: left * 10 + pos, x: cx + dx - w / 2, y: yy, w, h, side: 'left' });
    }
  });
  return out;
}

function renderArch(r) {
  const v = state.viewer;
  const byFdi = new Map(allStructures().filter((s) => s.fdi != null).map((s) => [s.fdi, s]));
  const present = presentIndices();
  const planning = !!(v && v.mode === 'plan');
  const teeth = archGeometry().map((t) => {
    const s = byFdi.get(t.fdi);
    const has = s && present.has(s.index);
    const cls = ['tooth'];
    if (!has) cls.push('absent');
    else {
      if (v && v.hidden.has(s.index)) cls.push('off');
      if (v && v.isolated.has(s.index)) cls.push('sel');
    }
    // In plan mode every position is a site, so every position is a target. Marking
    // them lets the CSS say "clickable here" without re-deriving the rule.
    if (planning) cls.push('site');
    const fill = has ? s.color : 'var(--surface-3)';
    const label = has ? `${s.name}` : `FDI ${t.fdi} — not found`;
    const ty = t.y < 30 ? t.y - 1.6 : t.y + t.h + 4.4;
    return `<g class="${cls.join(' ')}" data-index="${has ? s.index : ''}" data-fdi="${t.fdi}">
      <title>${esc(planning ? siteTitle(t.fdi, label, has) : label)}</title>
      <rect x="${t.x.toFixed(1)}" y="${t.y.toFixed(1)}" width="${t.w}" height="${t.h}"
            rx="${(t.w / 3).toFixed(1)}" fill="${fill}"></rect>
      <text x="${(t.x + t.w / 2).toFixed(1)}" y="${ty.toFixed(1)}">${t.fdi}</text>
    </g>`;
  }).join('');
  $('archChart').innerHTML =
    `<svg viewBox="0 0 200 76" role="img" aria-label="FDI dental chart">${teeth}</svg>`;

  $('archChart').querySelectorAll('.tooth').forEach((g) => {
    // In the plan tab EVERY position is an implant site, not just the absent ones.
    // Restricting it to `.absent` was the reasoning "an implant site is by definition a
    // gap in the dentition" -- true of a healed site and false of an extraction site,
    // and it made the feature unreachable on any full-dentition scan: measured on the
    // both-jaws example case, 32 of 32 teeth present, so ZERO clickable sites existed.
    if (planning) {
      g.onclick = () => syncPlanToIsolate(g.dataset.fdi);
      return;
    }
    if (g.classList.contains('absent')) return;
    g.onclick = (e) => toggleIsolate(Number(g.dataset.index), addKey(e));
  });
  const n = present.size;
  // The hint read the same in both views, which made it useless in one of them: what
  // a click does depends on which stage is open, and "isolate" is only half of it.
  $('chartHint').textContent =
    planning ? 'click a position — places an implant there'
    : v && v.isolated.size > 1 ? `${v.isolated.size} isolated — ${ADD_KEY}-click to add or drop one`
    : v && v.isolated.size ? `click again to clear — ${ADD_KEY}-click to add another`
    : !(v && v.centroids) ? `${n} structures`
    : v.mode === 'volume' ? 'click a tooth — panes and 3D follow'
    : 'click a tooth — jumps to its slice';
}

/* Add-to-selection is the platform's own modifier, named the way the reader's own
 * keyboard names it. A hint that says "Ctrl-click" to a Mac user is a hint that does
 * not work, and this is the only affordance the multi-structure isolate has. */
const ADD_KEY = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent) ? '⌘' : 'Ctrl';
const addKey = (e) => !!(e && (e.ctrlKey || e.metaKey || e.shiftKey));

/** The chart tooltip in plan mode: what this site is, and how much bone it has.
 *
 *  The height and width come from the WORKER's per-site measurement (`ridge.py`), which
 *  exists so a site can be judged BEFORE an implant is placed there -- its whole reason
 *  for being is to colour this chart, and nothing read it until now. Stated with the
 *  refusal when there is one, because "not measured, and here is why" is a different
 *  fact from "no bone".
 */
function siteTitle(fdi, label, has) {
  const v = state.viewer;
  const jaw = String(fdi)[0] <= '2' ? 'maxilla' : 'mandible';
  const fit = ((v && v.report.arch || {}).jaws || {})[jaw];
  const site = fit && fit.ok && (fit.sites || {})[String(fdi)];
  const lines = [has ? `${label} — click to plan an extraction site here`
                     : `FDI ${fdi} — no tooth found; click to plan a site here`];
  if (!site) return lines.join('\n');
  if (site.s_mm == null) {
    lines.push(site.reason ? `No arc position: ${site.reason}` : 'No arc position for this site');
    return lines.join('\n');
  }
  if (site.height_mm != null) lines.push(`${site.height_mm.toFixed(1)} mm bone height`);
  else if (site.height_reason || site.reason) lines.push(`Height: ${site.height_reason || site.reason}`);
  if (site.width_mm != null) lines.push(`${site.width_mm.toFixed(1)} mm crestal width`);
  else if (site.width_reason) lines.push(`Width: ${site.width_reason}`);
  return lines.join('\n');
}

/** Isolate one structure everywhere, and navigate every view to it.
 *
 * Both halves are load-bearing. Isolating without navigating is what this used to do,
 * and it was indistinguishable from broken: measured on a 29-tooth case in the old
 * Slices tab, clicking a tooth moved the slice **0 times out of 29** and left **28 of
 * 29** showing no overlay at all, because the tooth simply was not on whatever slice
 * happened to be open. The lesson outlived that tab -- every view this isolates in has
 * to be navigated to the structure, or the isolate reads as a failure. */
async function toggleIsolate(index, additive) {
  const v = state.viewer;
  if (!v) return;
  const all = [...presentIndices()];
  const sel = v.isolated;
  if (additive) {
    // Additive click never clears the whole selection by accident: dropping the last
    // member does end the isolate, but only because the set became empty, and the
    // branch below restores everything rather than leaving a case with nothing shown.
    if (sel.has(index)) sel.delete(index);
    else sel.add(index);
  } else if (sel.size === 1 && sel.has(index)) {
    sel.clear();
  } else {
    sel.clear();
    sel.add(index);
  }
  v.isolateLast = sel.has(index) ? index : ([...sel][sel.size - 1] ?? null);
  v.hidden = sel.size ? new Set(all.filter((i) => !sel.has(i))) : new Set();
  renderIsolateClear();
  pushVisibility(all);
  if (sel.size) {
    // The 3D camera is aimed AFTER pushVisibility: it frames whatever is visible, so
    // aiming it while the rest of the arch is still shown would frame the arch and
    // leave the selection a speck.
    const c = v.centroids && v.isolateLast != null && v.centroids[v.isolateLast];
    if (c && window.DentistryViewer) DentistryViewer.jumpTo(c);
    focusIsolated();
  } else if (window.DentistryViewer && v.mprMounted) {
    DentistryViewer.surfacesReady();      // clearing isolate re-frames the whole arch
  }
  renderStructures(v.report);
  renderArch(v.report);
}

/** End the isolate and put every structure back. */
function clearIsolate() {
  const v = state.viewer;
  if (!v || !v.isolated.size) return;
  v.isolated.clear();
  v.isolateLast = null;
  v.hidden.clear();
  renderIsolateClear();
  pushVisibility([...presentIndices()]);
  if (window.DentistryViewer && v.mprMounted) DentistryViewer.surfacesReady();
  renderStructures(v.report);
  renderArch(v.report);
}

/** The clear button carries the count, because with a multi-structure isolate the
 *  reader cannot otherwise tell "two selected" from "one selected and one hidden". */
function renderIsolateClear() {
  const v = state.viewer;
  const b = $('isolateClear');
  if (!b || !v) return;
  const n = v.isolated.size;
  b.hidden = n === 0;
  b.textContent = n > 1 ? `clear isolate (${n})` : 'clear isolate';
}

/** Point the MPR cameras at whatever is currently isolated, if anything.
 *
 * Called after a mount and after every switch into the MPR tab, because those are the
 * two moments the cameras can be out of step with the isolate state: `toggleIsolate`
 * calls `jumpTo` at click time, but that does nothing when the volume has not mounted
 * yet (a slow fetch, a failed one, or a click during the ~1.6 MB download) and nothing
 * replayed it afterwards. */
function syncMprToIsolate() {
  const v = state.viewer;
  if (!v || !v.isolated.size || !v.mprMounted || !window.DentistryViewer) return false;
  // The crosshair goes to ONE point, so it goes to the structure that was clicked last
  // rather than to the mean of the selection -- with a canal and two teeth up, the mean
  // is a point in bone that belongs to none of them.
  const last = v.isolateLast != null && v.isolated.has(v.isolateLast)
    ? v.isolateLast : [...v.isolated][0];
  const c = v.centroids && v.centroids[last];
  if (!c) return false;
  focusIsolated();
  return DentistryViewer.jumpTo(c);
}

/** Frame the 3D pane on the isolate, however many structures are in it.
 *
 *  One structure keeps the old single-structure path exactly. Two or more are framed
 *  from the UNION of their mesh bounds, which is the only thing that fits a canal and
 *  the teeth over it in one view -- aiming at the mean centroid with a single
 *  structure's zoom put the selection half off-screen. */
function focusIsolated() {
  const v = state.viewer;
  if (!v || !v.mprMounted || !window.DentistryViewer) return false;
  const sel = [...v.isolated];
  if (!sel.length) return false;
  if (sel.length === 1) {
    const c = v.centroids && v.centroids[sel[0]];
    return c ? focus3d(sel[0], c) : false;
  }
  const pts = sel.map((i) => v.centroids && v.centroids[i]).filter(Boolean);
  if (!pts.length) return false;
  const mean = [0, 1, 2].map((k) => pts.reduce((a, p) => a + Number(p[k]), 0) / pts.length);
  const all = allStructures();
  const fdis = sel.map((i) => (all.find((s) => s.index === i) || {}).fdi);
  // Tilt up at the upper arch and down at the lower one, as the single-structure path
  // does -- but only when the whole selection is in one arch. A selection spanning both,
  // or containing a structure that belongs to neither, is viewed straight from the
  // buccal side, because either tilt would look through one arch at the other.
  const upper = fdis.every((f) => f != null && f < 30) ? true
    : fdis.every((f) => f != null && f >= 30) ? false
    : null;
  return DentistryViewer.focusStructure(mean, {
    indices: sel,
    archCentre: v.archCentre,
    upper,
  });
}

/** Point the 3D camera at the isolated structure, from the buccal side.
 *
 * Only for teeth. The jaws and the canal are horseshoes whose centroid is in mid-air,
 * so "look at the centroid from outside the arch" means nothing for them -- for those
 * the framing that already fits everything is the better view, and moving the camera
 * would just be motion for its own sake.
 */
function focus3d(index, centroid) {
  const v = state.viewer;
  if (!v || !v.mprMounted || !window.DentistryViewer) return false;
  const s = allStructures().find((x) => x.index === index);
  if (!s || s.fdi == null) return false;
  return DentistryViewer.focusStructure(centroid, {
    index,
    archCentre: v.archCentre,
    upper: s.fdi < 30,                  // FDI quadrants 1 and 2 are the upper arch
  });
}

/** The ONE place that pushes visibility to every pane.
 *
 * Keeping two copies of this is how `hide all` once redrew the tiles correctly and
 * silently did nothing to the Cornerstone labelmap. Keyed by structure INDEX, never
 * by colour: colour looked like a convenient key because the tile overlay filtered
 * by RGB, but it is not unique -- the two "unnumbered teeth" classes shared a grey,
 * and a colour->index lookup returns only the first match. The tile overlay is gone
 * with the Slices tab; the rule it taught is not.
 */
function pushVisibility(indices) {
  const v = state.viewer;
  if (!v || !v.mprMounted || !window.DentistryViewer) return;
  indices.forEach((idx) => DentistryViewer.setStructureVisible(idx, !v.hidden.has(idx)));
}

