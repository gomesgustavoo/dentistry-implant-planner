'use strict';
/* ==================================================== correcting the segmentation
 * The contours here are drawn by a network and every millimetre the implant tab
 * publishes is a distance to them. So a specialist who can see that a canal roof is a
 * voxel low has to be able to move it, and the numbers have to move with it -- otherwise
 * the edit is a drawing exercise and the figures beside it describe a mask that no
 * longer exists.
 *
 * FOUR RULES, and each one exists because the alternative is a quiet wrong number.
 *
 * 1. **Editing is a MODE, off by default.** The tools take the primary mouse button,
 *    which belongs to window/level. A viewer whose left button paints is a viewer
 *    somebody edits by accident, on a case they were only reading.
 *
 * 2. **While there are unsaved edits, everything except the MPR panes is out of date,
 *    and the app says so.** The 3-D surfaces are server meshes, the cross-sections are
 *    server JPEGs and every clearance is a lookup into a server distance field: none of
 *    them can follow a browser-side edit. Approximating them here would put two
 *    pictures of the same anatomy on screen with no way to tell which one the numbers
 *    came from.
 *
 * 3. **Apply is a server round trip, and it is not instant.** The diff goes to
 *    `POST /edits`, the worker rebuilds the distance fields, the meshes, the outlines
 *    and the per-site heights, and the case is reopened when it lands. 202, then
 *    polling, then a reload -- never an optimistic repaint.
 *
 * 4. **The reload has to get past both caches.** Artifacts are addressed by job id and
 *    served `immutable`, which is only honest while a finished job's files never
 *    change. An applied edit breaks that, so the job is marked stale: Cache Storage
 *    entries are deleted and every subsequent fetch for it carries `cache: 'reload'`.
 *    This is the same trap an in-place reprocess hit once already.
 */

/** Mark a case's bytes as changed. See `staleJobs` at the top of this file.
 *
 *  Session-scoped and never cleared: once a case has been corrected, its pre-edit copy
 *  in either cache is a picture of a mask nobody is looking at any more. */
function markJobStale(jobId) {
  if (!jobId) return;
  staleJobs.add(jobId);
  // Cache Storage first, because `cache: 'reload'` only reaches the HTTP cache.
  artifactCache().then((store) => {
    if (!store || !store.keys) return;
    store.keys().then((reqs) => reqs.forEach((r) => {
      if (String(r.url).includes(jobId)) store.delete(r).catch(() => {});
    })).catch(() => {});
  }).catch(() => {});
}

function editState() {
  const v = state.viewer;
  if (!v) return null;
  if (!v.edit) v.edit = { on: false, tool: 'brush', segment: 0, brush: 2.0,
                          applying: false, notice: null, edits: [] };
  return v.edit;
}

function viewerEdits() {
  return (window.DentistryViewer && DentistryViewer.setEditTool) ? DentistryViewer : null;
}

/** The tools, in the order they are offered. Labels come from the viewer's own table so
 *  the bar cannot name a tool the bundle does not have. */
function editToolList() {
  const V = viewerEdits();
  const t = (V && V.EDIT_TOOLS) || {};
  return ['brush', 'erase', 'brush3d', 'erase3d', 'circle', 'rect', 'sphere', 'fill']
    .filter((k) => t[k])
    .map((k) => ({ key: k, ...t[k] }));
}

/** Turn the mode on or off. */
function setEditMode(on) {
  const e = editState();
  const V = viewerEdits();
  const v = state.viewer;
  if (!e || !V || !v || !v.mprMounted) return false;
  e.on = !!on;
  V.setEditTool(e.on ? e.tool : null);
  if (e.on) {
    V.setEditSegment(e.segment);
    V.setBrushMm(e.brush);
  }
  const b = $('editBtn');
  if (b) {
    b.setAttribute('aria-pressed', e.on ? 'true' : 'false');
    b.classList.toggle('on', e.on);
  }
  $('editBar').hidden = !e.on;
  document.body.classList.toggle('editing', e.on);
  renderEditBar();
  return true;
}

/** Rebuild the bar, and every counter in it, from the labelmap itself.
 *
 *  Counters are READ BACK rather than accumulated. A running total kept in the client
 *  drifts the moment an undo, a redo or a discard happens, and a "1 240 voxels changed"
 *  that is not true of the array is worse than no number. `editStats()` scans only the
 *  planes the tools actually wrote to. */
function renderEditBar() {
  const e = editState();
  const V = viewerEdits();
  if (!e || !V) return;
  const bar = $('editBar');
  if (!bar || bar.hidden) return;

  // The structure picker: only what this case actually contains, plus background.
  //
  // Keyed on the JOB, not on a boolean. `#editBar` is static markup that outlives a
  // case, so a `built` flag would carry the previous case's structure list into the
  // next one -- and an index that is not present in the new case paints a structure
  // whose colour the LUT never registered, which renders as nothing at all.
  const sel = $('editSegment');
  const v = state.viewer;
  if (sel && sel.dataset.built !== String(v && v.jobId)) {
    const present = presentIndices();
    const opts = ['<option value="0">background (erase)</option>'].concat(
      (allStructures() || [])
        .filter((s) => present.has(s.index))
        .map((s) => `<option value="${s.index}">${esc(s.name)}</option>`));
    sel.innerHTML = opts.join('');
    sel.dataset.built = String(v && v.jobId);
    // Default to the inferior alveolar canal when the case has one: it is the structure
    // every clearance in this product is measured to, so it is the one a specialist
    // opens these tools for.
    //
    // And PUSH it to the viewer, not just into local state. `setEditMode` sets the
    // active segment from `e.segment` before this runs, so without this line the first
    // stroke of every session paints segment 0 -- which is background, i.e. it erases.
    const canal = (allStructures() || []).find((s) => s.id === 'canal');
    if (canal && present.has(canal.index)) {
      e.segment = canal.index;
      V.setEditSegment(e.segment);
    }
  }
  if (sel) sel.value = String(e.segment);
  // The colour of the thing you are about to paint, beside the picker. Without it the
  // only cue is a name in a dropdown, while every other surface in this app identifies a
  // structure by its swatch.
  const swatch = $('editSwatch');
  if (swatch) {
    const st = (allStructures() || []).find((x) => x.index === e.segment);
    swatch.style.background = st ? st.color : 'transparent';
    swatch.style.borderColor = st ? st.color : 'var(--border-2)';
    swatch.title = st ? st.name : 'background (erase)';
  }

  const tools = $('editTools');
  if (tools) {
    // GROUPED BY WHAT THE TOOL DOES, not listed in declaration order. Eight equal text
    // buttons in a grid made the reader work out from the words which ones add and which
    // ones remove -- and "erase" and "erase 3-D" sat between "brush 3-D" and "circle",
    // so the two destructive tools were the least conspicuous things in the panel.
    // Adding and removing are the only distinction that matters before a stroke.
    // Drawn icons from the sprite in index.html, one per tool; a tool the sprite does
    // not know falls back to the plain square rather than to a font glyph.
    const glyph = (key) => `<svg class="ic" aria-hidden="true"><use href="#t-${
      ['brush', 'brush3d', 'circle', 'rect', 'sphere', 'fill', 'erase', 'erase3d']
        .includes(key) ? key : 'rect'}"/></svg>`;
    const short = {
      brush: 'Brush', brush3d: 'Brush 3-D', circle: 'Circle', rect: 'Rectangle',
      sphere: 'Sphere', fill: 'Fill', erase: 'Erase', erase3d: 'Erase 3-D',
    };
    const all = editToolList();
    const btn = (t) => `
      <button class="etool ${e.tool === t.key ? 'on' : ''}" data-tool="${t.key}"
        type="button" title="${esc(t.hint)}">
        <span class="etool-i" aria-hidden="true">${glyph(t.key)}</span>
        <span class="etool-l">${esc(short[t.key] || t.label)}</span>
      </button>`;
    const group = (name, keys, cls) => {
      const rows = all.filter((t) => keys.includes(t.key));
      return rows.length ? `<div class="etool-group ${cls}">
        <h4>${name}</h4><div class="etool-grid">${rows.map(btn).join('')}</div></div>` : '';
    };
    tools.innerHTML = group('Add', ['brush', 'brush3d', 'circle', 'rect', 'sphere', 'fill'], 'is-add')
      + group('Remove', ['erase', 'erase3d'], 'is-remove');
  }
  const size = $('editSize');
  if (size) size.value = String(e.brush);
  const sizeLabel = $('editSizeLabel');
  if (sizeLabel) sizeLabel.textContent = `${Number(e.brush).toFixed(1)} mm`;
  // The brush has no radius for the scissors or the flood fill, so the control says so
  // rather than sitting there doing nothing.
  const brushy = /^(brush|erase)/.test(e.tool);
  if (size) size.disabled = !brushy;
  if (sizeLabel) sizeLabel.style.opacity = brushy ? '1' : '.45';

  const h = V.editHistory ? V.editHistory() : { canUndo: false, canRedo: false };
  if ($('editUndo')) $('editUndo').disabled = !h.canUndo;
  if ($('editRedo')) $('editRedo').disabled = !h.canRedo;

  const st = V.editStats ? V.editStats() : null;
  const n = st ? st.voxels : 0;
  const names = st ? Object.keys(st.structures || {}) : [];
  const count = $('editCount');
  if (count) {
    count.textContent = e.applying ? 'applying…'
      : n ? `${n.toLocaleString()} voxels on ${st.slices} slice${st.slices === 1 ? '' : 's'}`
            + (names.length ? ` · ${names.map((i) => structureName(
              ((allStructures() || []).find((s) => s.index === Number(i)) || {}).id
              || i)).join(', ')}` : '')
      : 'nothing changed yet';
  }
  if ($('editDiscard')) $('editDiscard').disabled = !n || e.applying;
  if ($('editApply')) $('editApply').disabled = !n || e.applying;

  const note = $('editNote');
  if (note) {
    // The standing statement, and it is the most important text in this bar.
    note.innerHTML = e.notice ? esc(e.notice)
      : n ? 'These strokes change the MPR panes only. The 3-D surfaces, the '
            + 'cross-sections and every clearance still describe the segmentation '
            + '<b>before</b> your corrections — they are rebuilt on the server when '
            + 'you apply. Corrections are made on the '
            + `${editGridMm()} display grid and upsampled to the measurement grid, so an `
            + 'edited boundary carries that much extra uncertainty.'
      : 'Paint or erase on the MPR panes. Nothing is sent until you apply.';
    note.className = 'editnote' + (e.notice ? ' bad' : '');
  }
  // The budget of whatever the picker is pointing at, refreshed with the bar so it
  // tracks the structure rather than lagging one selection behind.
  renderEditBudget();
}

/** The display grid's voxel size, in words. The number the error budget will widen by
 *  is half of it, and the server states that; this states where it comes from. */
function editGridMm() {
  const m = (state.viewer && state.viewer.volumeMeta) || null;
  const sp = m && m.spacing ? Math.min(...m.spacing.map(Number)) : null;
  return sp ? `${sp.toFixed(2)} mm` : 'coarser';
}

/** The display grid's voxel size as a NUMBER, or null when the pack has not landed. */
function editGridSpacing() {
  const m = (state.viewer && state.viewer.volumeMeta) || null;
  const sp = m && m.spacing ? Math.min(...m.spacing.map(Number)) : null;
  return Number.isFinite(sp) && sp > 0 ? sp : null;
}

/** Which measured prior a structure's boundary feeds, mirroring `plan_safety`'s three
 *  fields. Returns null for a structure no implant clearance is measured against --
 *  and saying "no measured prior" is the honest answer there, not borrowing one. */
function budgetFieldFor(id) {
  if (id === 'canal') return 'canal';
  if (id === 'incisive_canal_left' || id === 'incisive_canal_right'
      || id === 'lingual_canal') return 'accessory_canal';
  if (/^tooth_\d+$/.test(id)) return 'tooth';
  return null;
}

/** THE ERROR BUDGET OF THE STRUCTURE THE BRUSH IS ABOUT TO WRITE INTO.
 *
 *  This app's whole claim is that it says how wrong it might be, and the one place that
 *  claim was missing was the moment it matters most: a person about to redraw a boundary
 *  by hand. The arithmetic existed -- `plan_safety.edit_penalty` computes it and the
 *  applied result prints it -- but only AFTER the correction was made and recomputed.
 *  A correction is a decision; the number belongs in front of the person making it.
 *
 *  It is deliberately NOT a warning. A hand-drawn contour is often better than the
 *  model's. It is simply not automatically better, and the budget widens either way,
 *  because the mask a browser can edit is the downsampled display copy and half a
 *  display voxel of quantisation is real whichever direction the hand moved the wall. */
function renderEditBudget() {
  const box = $('editBudget');
  if (!box) return;
  const e = editState();
  const v = state.viewer;
  if (!e || !v) { box.innerHTML = ''; return; }
  const st = (allStructures() || []).find((x) => x.index === e.segment);
  if (!st || !e.segment) {                       // background, or nothing selected
    box.innerHTML = '';
    return;
  }
  const sp = editGridSpacing();
  if (!sp) { box.innerHTML = ''; return; }
  const add = sp / 2;
  const field = budgetFieldFor(st.id);
  if (!field) {
    // No implant clearance is measured against this structure, so there is no budget to
    // widen -- and inventing one would be worse than saying so.
    box.innerHTML = `Correcting <b>${esc(st.name)}</b> quantises its boundary at half a
      ${esc(editGridMm())} display voxel &mdash; <b>${add.toFixed(2)} mm</b>. No implant
      clearance is measured against this structure.`;
    return;
  }
  const prior = MODEL_PRIORS && MODEL_PRIORS.structures
    ? MODEL_PRIORS.structures[field] : null;
  if (!prior) {
    // The priors have not landed (or the endpoint failed). Say the half that IS known
    // rather than the whole of it wrongly -- printing "no clearance is measured against
    // this" for the mandibular canal would be a false statement about the one structure
    // the implant verdicts depend on most.
    box.innerHTML = `Correcting <b>${esc(st.name)}</b> quantises its boundary at half a
      ${esc(editGridMm())} display voxel &mdash; <b>${add.toFixed(2)} mm</b>, on top of
      the model's own error for this structure.`;
    // Fetch them, then say the whole thing. `renderModelPriors` owns the cache.
    renderModelPriors().then(() => {
      const e2 = editState();
      if (e2 && e2.on && e2.segment === st.index) renderEditBudget();
    }).catch(() => {});
    return;
  }
  box.innerHTML = `Correcting <b>${esc(st.name)}</b> widens its error budget:
    <b>${prior.p95_mm.toFixed(2)} mm</b> model
    + <b>${add.toFixed(2)} mm</b> grid
    = <b>${(prior.p95_mm + add).toFixed(2)} mm</b> deducted from every clearance
    measured against it.`;
}

/** The dock: the structure filter, and the tools' own close button. */
function wireDock() {
  const f = $('structFilter');
  if (f) {
    f.oninput = () => {
      if (!state.viewer) return;
      state.viewer.structQuery = f.value;
      renderStructures(state.viewer.report);
    };
    // Esc clears rather than blurring, because a filter left on is a list that looks
    // like a case with fewer structures than it has.
    f.onkeydown = (ev) => {
      if (ev.key !== 'Escape') return;
      ev.stopPropagation();                 // do NOT let this close the case
      f.value = '';
      if (!state.viewer) return;
      state.viewer.structQuery = '';
      renderStructures(state.viewer.report);
    };
  }
  const close = $('editClose');
  if (close) close.onclick = () => setEditMode(false);
}

function wireEditing() {
  const btn = $('editBtn');
  if (btn) {
    btn.onclick = () => {
      const e = editState();
      if (!e) return;
      if (!state.viewer.mprMounted) {
        setNotice('The volume is still loading.', 'err');
        return;
      }
      setEditMode(!e.on);
    };
  }
  const sel = $('editSegment');
  if (sel) {
    sel.onchange = () => {
      const e = editState();
      const V = viewerEdits();
      if (!e || !V) return;
      e.segment = Number(sel.value) || 0;
      V.setEditSegment(e.segment);
      renderEditBar();
    };
  }
  const tools = $('editTools');
  if (tools) {
    tools.onclick = (ev) => {
      const b = ev.target.closest('button[data-tool]');
      const e = editState();
      const V = viewerEdits();
      if (!b || !e || !V) return;
      e.tool = b.dataset.tool;
      V.setEditTool(e.tool);
      renderEditBar();
    };
  }
  const size = $('editSize');
  if (size) {
    size.oninput = () => {
      const e = editState();
      const V = viewerEdits();
      if (!e || !V) return;
      e.brush = Number(size.value);
      V.setBrushMm(e.brush);
      renderEditBar();
    };
  }
  if ($('editUndo')) $('editUndo').onclick = () => { const V = viewerEdits(); if (V) { V.editUndo(); renderEditBar(); } };
  if ($('editRedo')) $('editRedo').onclick = () => { const V = viewerEdits(); if (V) { V.editRedo(); renderEditBar(); } };
  if ($('editDiscard')) {
    $('editDiscard').onclick = () => {
      const V = viewerEdits();
      if (!V) return;
      const st = V.editStats();
      if (!st || !st.voxels) return;
      if (!window.confirm(`Discard ${st.voxels.toLocaleString()} changed voxels and go `
                          + 'back to what the model drew?')) return;
      V.resetEdits();
      renderEditBar();
    };
  }
  if ($('editApply')) $('editApply').onclick = () => applyEdits();

  // The tools write on mouse-up, so the counters are refreshed then. Bound on the
  // stage rather than per pane: the elements are Cornerstone's and are replaced on
  // every mount, while the stage is not.
  const stage = $('mprStage');
  if (stage) {
    stage.addEventListener('pointerup', () => {
      const e = editState();
      if (e && e.on) setTimeout(renderEditBar, 0);
    });
  }
}

/** Send the diff, then wait for the worker, then reopen the case. */
async function applyEdits() {
  const e = editState();
  const V = viewerEdits();
  const v = state.viewer;
  if (!e || !V || !v) return;
  const diff = V.editDiff();
  if (!diff || !diff.voxels) return;
  e.applying = true;
  e.notice = null;
  renderEditBar();
  let row;
  try {
    row = await api(`/jobs/${v.jobId}/edits`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        grid: diff.grid,
        slices: diff.slices,
        voxels: diff.voxels,
        structures: diff.structures,
        note: null,
      }),
    });
  } catch (err) {
    e.applying = false;
    e.notice = 'The correction was not accepted: ' + err.message;
    renderEditBar();
    return;
  }
  e.notice = 'Rebuilding the distance fields, the surfaces and the outlines…';
  renderEditBar();
  const done = await pollEdit(v.jobId, row.id);
  e.applying = false;
  if (!done || done.state !== 'applied') {
    e.notice = (done && done.error)
      ? 'The correction could not be applied: ' + done.error
      : 'The correction is still being applied; the case will not show it until it is.';
    renderEditBar();
    return;
  }
  // The server has the new mask, so this baseline is what the next diff is measured
  // against. Set BEFORE the reopen, because the reopen tears the editing layer down.
  if (V.commitBaseline) V.commitBaseline();
  markJobStale(v.jobId);
  e.notice = null;
  const jobId = v.jobId;
  setEditMode(false);
  setNotice('Correction applied. Every measurement was recomputed from it.', 'ok');
  // A full reopen rather than a partial refresh. `addSurface` is memoised with no
  // update path, the labelmap volume is in the Cornerstone cache, and `arch.json` is
  // held under an `immutable` header -- so a reopen is the only reload that is
  // guaranteed to be showing one consistent generation of the case.
  //
  // `force`, because the case is ALREADY open and `openCase` returns early for that --
  // which is what made this whole path a no-op with a success notice on top of it.
  await openCase(jobId, { force: true });
}

/** Poll one edit until it stops being queued. Bounded, and it says so when it gives up. */
/** MEASURED: 141 s on a 205x205x135 case with both jaws, 84 meshes and a 19 MB
 *  structure set; 19 s on a small-field-of-view one. 600 s is four times the worst
 *  measured run, and the worker requeues anything stuck for 900 s -- so a client that
 *  gives up here has not lost the correction, it has only stopped watching, and it
 *  says exactly that. */
async function pollEdit(jobId, editId, timeoutMs = 600000) {
  const t0 = Date.now();
  let wait = 900;
  while (Date.now() - t0 < timeoutMs) {
    await new Promise((r) => setTimeout(r, wait));
    wait = Math.min(4000, wait * 1.35);
    let list;
    try {
      list = await api(`/jobs/${jobId}/edits`);
    } catch (err) {
      return { state: 'unknown', error: err.message };
    }
    const row = (list.edits || []).find((x) => x.id === editId);
    if (!row) return { state: 'unknown', error: 'the correction is no longer listed' };
    if (row.state === 'applied' || row.state === 'failed') return row;
  }
  return null;
}

/** What has already been corrected on this case, for the rail and the printed sheet.
 *
 *  Read from `report.edits`, which `worker/rederive.py` appends to -- so it survives a
 *  reload, a new session and a different browser, and the sentence about the display
 *  grid travels with it. */
function renderEditHistory(r) {
  const box = $('editsCard');
  if (!box) return;
  const hist = (r && r.edits) || [];
  box.hidden = !hist.length;
  if (!hist.length) { box.innerHTML = ''; return; }
  box.innerHTML = `<div class="card-head"><h3>Hand corrections</h3>
      <span class="hint">${hist.length}</span></div>`
    + hist.slice().reverse().map((h) => {
      const names = Object.keys(h.structures || {}).map((i) => structureName(
        ((allStructures() || []).find((s) => s.index === Number(i)) || {}).id || i));
      return `<div class="editrow">
        <div class="editrow-head">
          <b>${esc(fmtWhen(h.at))}</b>
          <span class="hint">${Number(h.voxels || 0).toLocaleString()} voxels</span>
        </div>
        ${names.length ? `<p class="hint">${esc(names.join(', '))}</p>` : ''}
        <details class="sidenote"><summary>What this means for the numbers</summary>
          <p class="finding-why">${esc(h.basis || '')}</p>
          <p class="finding-why">${esc(h.frozen || '')}</p>
        </details>
      </div>`;
    }).join('');
}

