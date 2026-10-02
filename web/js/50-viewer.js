'use strict';
/* ------------------------------------------------------------- the viewer */
// `route()` owns what is on screen. This only navigates, so a deep link, a click on a
// card and the browser back button all take the same path.
//
// `openViewer` used to sit here, with a docstring saying it was "kept under this name
// because the rest of the app calls it". Nothing called it -- card clicks navigate
// directly -- and it passed the wiring check only because its own two comments counted
// as references.

/** Leave the open case. */
function closeViewer() { navigate('#/cases'); }

/** Release a mounted case. Called by the router before showing any other view. */
function teardownCase() {
  $('railToggle').hidden = true;
  document.body.classList.remove('in-case');
  closeDisplayPop();
  // Editing has to come off with the case. It binds the primary mouse button to a
  // brush, and the bar and the crosshair cursor are static markup that outlives the
  // viewer -- so a case closed mid-edit would leave the next one armed.
  { const e = editState(); if (e && e.on) setEditMode(false); }
  document.body.classList.remove('editing');
  { const bar = $('editBar'); if (bar) bar.hidden = true; }
  // Put the 3-D pane back in the MPR grid BEFORE unmounting. `move3dPane` may have
  // parked it in the plan stage, and leaving it there would hand the next case a pane
  // nested in a hidden container -- and `setMode('volume')` short-circuits when the
  // pane is already in the host it names, so it would never come back.
  move3dPane('mpr');
  // Same discipline for the chart: it may be parked in the plan tab's site bar, and the
  // next case's `renderArch` writes into the element wherever it happens to be. Left
  // there it would render inside a hidden stage on a case opened straight into MPR.
  moveChartCard('mpr');
  if (window.DentistryViewer) DentistryViewer.unmount().catch(() => {});
  // Every planning picture and every slice tile is a blob URL now, and an un-revoked
  // one pins its bytes until the document goes away. The tile cache alone holds 400.
  const v = state.viewer;
  if (v) {
    if (v.plan) { revokeImage(v.plan.panImage); revokeImage(v.plan.xsImage); }
  }
  state.viewer = null;
}

/** Load a case into the workspace. The router has already shown the view. */
async function openCase(jobId, opts) {
  // `force` REOPENS a case that is already open, and the distinction is load-bearing.
  //
  // The guard below exists so the router does not remount a mounted case on every hash
  // change -- right for navigation, and wrong for the one caller that means "this
  // case's bytes have changed": after a hand correction is applied, `openCase` was a
  // no-op, so the app printed "Correction applied. Every measurement was recomputed
  // from it" over the pre-edit report, the pre-edit surfaces and the pre-edit numbers.
  // Found by applying a second correction live and watching `report.edits` stay at 1
  // while the API returned 2.
  const force = !!(opts && opts.force);
  if (!force && state.viewer && state.viewer.jobId === jobId) return;
  if (state.viewer) teardownCase();

  $('caseTitle').textContent = 'Loading\u2026';
  $('caseSub').textContent = '';

  let job;
  try {
    job = await api(`/jobs/${jobId}`);
  } catch (err) {
    setNotice('That case could not be opened: ' + err.message, 'err');
    navigate('#/cases');
    return;
  }
  if (job.state !== 'done') {
    setNotice('That case has not finished yet.', 'err');
    navigate('#/cases');
    return;
  }
  if (job.results_expired) {
    setNotice('That case\u2019s results expired and were deleted. Re-upload the scan to segment it again.', 'err');
    navigate('#/cases');
    return;
  }

  const r = job.reports || {};
  state.viewer = {
    jobId, job, report: r,
    // `isolated` is a SET, not one index: a planner comparing a canal against the two
    // teeth either side of a site needs all three up at once, and the single-index
    // version made that three clicks that each undid the last.
    hidden: new Set(), isolated: new Set(), isolateLast: null,
    centroids: null, structQuery: '',
    mode: 'volume', mprMounted: false, volumeMeta: null,
  };
  if (window.DentistryViewer) await DentistryViewer.unmount().catch(() => {});

  $('caseTitle').textContent = job.title || job.filename;
  $('caseSub').textContent = caseSubtitle(state.viewer);
  $('railToggle').hidden = false;
  $('dockToggle').hidden = false;
  // A filter is per-case; carrying one across cases would open the next scan already
  // hiding structures, with the reason two navigations back.
  { const f = $('structFilter'); if (f) f.value = ''; }
  // Locks the page to the window so the panes fill it instead of running off the
  // bottom. Only with a case open -- the catalogue has to keep scrolling.
  document.body.classList.add('in-case');

  renderFindings(r);
  renderEditHistory(r);
  renderAccuracy(r);
  renderModelPriors();
  renderSeries(state.viewer);
  renderRunDetails(r);
  renderStructures(r);
  renderArch(r);
  renderDownloads(jobId, r);
  // The plan tab exists only for a job that carries planning views. Every archived
  // job predates them, and a tab that opens onto nothing is worse than no tab.
  const planning = r.planning || {};
  const planOk = Object.values(planning.jaws || {}).some((j) => j && j.ok);
  $('planTab').hidden = !planOk;
  if (state.viewer) state.viewer.plan = null;
  setLayout(layout.kind, layout.pane);
  set3dMode('surfaces', true);
  setMode('volume');
  await mountVolume();
}

/* --------------------------------------------------------------- MPR + 3D */
const VIEW_NOTES = {
  volume: '<b>True MPR on the raw voxels</b> \u2014 the label map exactly as the models '
        + 'predicted it.<br>Left-drag window/level \u00b7 wheel scroll \u00b7 right-drag '
        + 'zoom \u00b7 middle-drag pan \u00b7 left-drag rotates in 3D.<br>'
        + 'Double-click a pane to enlarge it. <kbd>1</kbd>\u2013<kbd>4</kbd> focus a pane '
        + '\u00b7 <kbd>0</kbd> grid \u00b7 <kbd>f</kbd> solo \u00b7 <kbd>[</kbd> panel '
        + '\u00b7 <kbd>d</kbd> this menu \u00b7 <kbd>Esc</kbd> close the case.',
  plan: '<b>Reconstructed along the dental arch</b> \u2014 a panoramic through a 12 mm '
      + 'focal trough, and the cross-section perpendicular to the arch at one position. '
      + 'Both are rendered from the full-resolution scan on the server, so the '
      + 'millimetres printed under the cross-section are the scan\u2019s own \u2014 '
      + 'unlike the 3D panes, which show a downsampled copy for display.<br>'
      + 'Click the panoramic to jump \u00b7 drag the slider to scrub \u00b7 '
      + '<kbd>[</kbd> panel \u00b7 <kbd>Esc</kbd> close the case.<br>'
      + '<b>Research preview \u2014 not a medical device, and not for diagnostic or '
      + 'treatment use.</b>',
};

function setMode(mode) {
  const volume = mode === 'volume';
  const plan = mode === 'plan';
  document.querySelectorAll('.mode').forEach((b) => b.classList.toggle('on', b.dataset.mode === mode));
  $('mprStage').hidden = !volume;
  $('planStage').hidden = !plan;
  // What used to be a paragraph of prose permanently under the image. Same text,
  // in the popover you open when you want it -- the viewport gets the space back.
  $('popHelp').innerHTML = VIEW_NOTES[mode] || '';
  // Controls that only mean something for the Cornerstone panes. Left visible in the
  // tile view they are three dead switches next to two live ones.
  // ...and the editing toggle, which only means anything where the labelmap is: the
  // brush writes on the Cornerstone slice views, and there is nothing for it to do in
  // the tile view or the implant tab.
  ['layoutPicker', 'modePicker3d', 'mprReset', 'editBtn']
    .forEach((id) => { const el = $(id); if (el) el.hidden = !volume; });
  // ...and the dock's own toggle, because in the plan tab there is no dock to toggle.
  { const el = $('dockToggle'); if (el) el.hidden = !volume; }
  // CORRECTING THE MASK IS AN MPR-ONLY MODE, and leaving it armed anywhere else is a
  // bug rather than an untidiness. The brush binds Cornerstone's PRIMARY MOUSE BUTTON on
  // the MPR tool group; the plan tab draws on its own canvases, so a tool left active
  // there is invisible, un-undoable from that tab, and still holding the button the
  // moment the reader goes back. It also offered a panel that cannot do anything: there
  // is no labelmap on a server-rendered cross-section to paint into.
  //
  // Enforced HERE, in the one function that changes mode, rather than in the tab's click
  // handler -- `setMode` is also called by `openCase` and by the router, and only two of
  // those three paths went through that handler.
  if (!volume) {
    const ed = editState();
    if (ed && ed.on) setEditMode(false);
    const bar = $('editBar');
    if (bar) bar.hidden = true;
    document.body.classList.remove('editing');
  }
  // The mode has to be recorded BEFORE the early return: renderArch branches on
  // `v.mode === 'plan'` to turn the FDI chart into an implant-site picker, and for
  // as long as this line sat below the return, that mode was never once set.
  if (state.viewer) state.viewer.mode = mode;
  // In the implant tab the rail keeps the dental chart (which IS the placement control)
  // and the Structures card (the only control over what the 3-D pane draws), and drops
  // the rest. Measured before this: 4910 characters of segmentation prose, 82% of it
  // scrolled out of reach, none of it about planning. A class rather than per-element
  // `hidden`, so the print stylesheet can put every card back on paper with one rule.
  $('workspace').classList.toggle('mode-plan', plan);
  // The 3-D pane follows the mode instead of being duplicated. See `move3dPane`.
  move3dPane(plan ? 'plan' : 'mpr');
  // ...and so does the dental chart. See `moveChartCard`.
  moveChartCard(plan ? 'plan' : 'mpr');
  // With the chart gone, the plan rail holds only the corrections history, which is
  // `[hidden]` on every case whose mask was never touched. Rather than leave a 300 px
  // column holding nothing, the track is removed and the toggle with it -- and both come
  // back the moment there IS a correction to show. Read from the element rather than
  // from a flag, so it cannot drift from what is actually rendered.
  {
    const edits = $('editsCard');
    const empty = plan && !!(edits && edits.hidden);
    $('workspace').classList.toggle('rail-empty', empty);
    const rt = $('railToggle');
    if (rt) rt.hidden = empty;
  }
  // ...and in the plan tab it draws the local neighbourhood only. Measured: all 42
  // surfaces and 1.95 M triangles were drawn, so a molar implant sat behind two tooth
  // roots and the mandible and could not be seen at all. `setSurfaceFocus` NARROWS --
  // it never writes the user's own hidden set, so leaving this tab cannot have changed
  // what the Slices tab shows.
  refreshPlanFocus();
  // `renderArch` branches on the mode to decide what a chart click does and what the
  // tooltip says, and it was never re-run on a mode change -- so the chart kept the
  // wiring and the hint from whichever tab happened to be open when the case loaded.
  if (state.viewer) renderArch(state.viewer.report);
  if (plan) {
    // The dock has just left the grid, so the stage is wider than it was. Cornerstone
    // sizes its canvases at enable time and never again, and the plan tab's own
    // canvases are drawn to a measured box -- without this the 3-D pane keeps the
    // narrower width and every click lands at the wrong point.
    afterLayoutChange();
    // Awaited by the caller where it matters. `renderArch` needs `mode` (set above) to
    // turn the chart into a site picker, and the chart is redrawn when the arch lands.
    loadArch();
    return;
  }
  // Coming back from the plan tab, the MPR panes have been `display:none` and are
  // therefore zero-sized; Cornerstone still holds the canvas dimensions from before
  // and will not notice on its own.
  if (volume) afterLayoutChange();
}

/** Load the volume pack and mount all four panes. */
/** The one-line identity under the case title. Built, never appended to. */
function caseSubtitle(v) {
  const inp = (v.report || {}).input || {};
  return [
    v.job.attribution || null,
    (inp.size_xyz || []).join('×') || null,
    (inp.spacing_xyz || []).length
      ? inp.spacing_xyz.map((x) => x.toFixed(2)).join('×') + ' mm' : null,
  ].filter(Boolean).join(' · ');
}

async function mountVolume() {
  const v = state.viewer;
  if (!v || v.mprMounted) return;
  if (!window.DentistryViewer) { $('mprMeta').textContent = 'viewer bundle failed to load'; return; }
  const files = `${API}/jobs/${v.jobId}/files`;
  const base = `${files}/volume`;
  $('mprLoading').hidden = false;
  $('mprMeta').textContent = 'loading volume…';
  try {
    const meta = await (await cachedFetch(`${base}/meta.json`)).json();

    // Gzipped, the whole viewer payload is under 1.6 MB -- and on any repeat visit it
    // comes from Cache Storage with no network at all.
    const [img, lbl] = await Promise.all([
      cachedFetch(`${base}/image.raw`).then((r) => r.arrayBuffer()),
      cachedFetch(`${base}/labels.raw`).then((r) => r.arrayBuffer()),
    ]);

    const res = await DentistryViewer.mount(
      [$('csAxial'), $('csCoronal'), $('csSagittal')], meta, img, lbl, $('cs3d')
    );
    v.volumeMeta = meta;
    v.centroids = res.centroids || null;
    v.mprMounted = true;
    const st = overlayStyle();
    DentistryViewer.setOverlayStyle(st.fill, st.outline);
    // Re-apply anything already hidden, so no two panes disagree about what is shown.
    v.hidden.forEach((idx) => DentistryViewer.setStructureVisible(idx, false));

    const d = meta.dimensions;
    const lost = (meta.labels.lost_to_downsampling || []).length;
    $('mprMeta').textContent = '';
    $('mprLoading').hidden = true;
    v.archCentre = res.archCentre || null;
    v.mprInfo = `${d.join('×')} @ ${meta.spacing.map((x) => x.toFixed(2)).join('×')} mm` +
      ` · ${Object.keys(meta.colors).length} structures` +
      (lost ? ` · ${lost} too small to show at this resolution` : '');
    // Assigned, not appended. `+=` here meant reopening a case in the same session
    // stacked the same line onto the subtitle again.
    $('caseSub').textContent = caseSubtitle(v) + ' · ' + v.mprInfo;
    renderArch(v.report);   // centroids are known now, so teeth become jumpable
    syncMprToIsolate();     // and if something was already isolated, go to it
    if (res.volumeRendered) loadSurfaces(files);
    else $('surfaceNote').textContent = '3D rendering unavailable in this browser';
  } catch (e) {
    $('mprLoading').hidden = false;
    $('mprMeta').textContent = 'could not load the volume: ' + e.message;
  }
}

/* ------------------------------------------------------------- 3D surfaces */

/** Stream the per-structure meshes into the 3D pane, teeth first.
 *
 * Teeth and the canal before the jaws, because that is the order they matter in and
 * the jaws are most of the bytes: on the post-operative case the 34 small structures
 * are ~1 MB gzipped between them and the two jaws are another ~1.6 MB. Fetched one at
 * a time rather than all at once -- 36 parallel requests through one HTTP/1.1 origin
 * just queue, and serialising them means the first teeth are on screen while the rest
 * are still arriving.
 *
 * Failures are per-structure and non-fatal: a missing mesh costs one surface, and the
 * count is reported rather than the pane silently coming up short. Cases segmented
 * before `mesh/` existed have no manifest at all and fall back to the volume render.
 */
async function loadSurfaces(filesBase) {
  const v = state.viewer;
  const manifest = ((v.report.outputs || {}).mesh) || {};
  const ids = Object.keys(manifest);
  if (!ids.length) {
    $('surfaceNote').textContent =
      'volume rendering — this case predates the browser meshes; the surfaces are the STL downloads';
    set3dMode('bone', true);
    return;
  }
  const byId = {};
  allStructures().forEach((s) => { byId[s.id] = s.index; });
  const jaws = new Set(['maxilla', 'mandible']);
  const order = [...ids.filter((i) => !jaws.has(i)), ...ids.filter((i) => jaws.has(i))];

  let done = 0, tris = 0, failed = 0;
  const token = v.jobId;
  for (const id of order) {
    // A case closed or switched mid-stream must not keep pushing actors at a
    // viewport that now belongs to another scan.
    if (!state.viewer || state.viewer.jobId !== token || !state.viewer.mprMounted) return;
    const index = byId[id];
    if (index == null) continue;
    try {
      const buf = await cachedFetch(`${filesBase}/${manifest[id]}`).then((r) => r.arrayBuffer());
      const n = DentistryViewer.addSurface(index, buf);
      if (n) { done++; tris += n; }
    } catch (err) {
      failed++;
      console.warn(`dentistry: surface ${id} failed: ${err.message}`);
    }
    if (done === 1 || done % 8 === 0) {
      $('surfaceNote').textContent = `loading surfaces… ${done}/${order.length}`;
    }
  }
  DentistryViewer.surfacesReady();
  // Apply the mode now, not at mount: until a surface exists there is nothing to show
  // and hiding the volume actor early would leave an empty pane while they stream in.
  DentistryViewer.set3dMode(v.mode3d || 'surfaces');
  v.surfaceNote = `${done} smoothed surfaces · ${(tris / 1000).toFixed(0)}k triangles`
    + (failed ? ` · ${failed} failed to load` : '');
  $('surfaceNote').textContent = v.surfaceNote;
  syncMprToIsolate();
}

function set3dMode(mode, quiet) {
  const v = state.viewer;
  if (v) v.mode3d = mode;
  document.querySelectorAll('#modePicker3d .segb')
    .forEach((b) => b.classList.toggle('on', b.dataset['3d'] === mode));
  if (!quiet && window.DentistryViewer && v && v.mprMounted) DentistryViewer.set3dMode(mode);
}

function wire3d() {
  document.querySelectorAll('#modePicker3d .segb').forEach((b) => {
    b.onclick = () => set3dMode(b.dataset['3d']);
  });
}

/* ----------------------------------------------------------- the catalogue */
function allStructures() {
  const groups = (state.viewer && state.viewer.report.structures)
    || (state.catalog && state.catalog.groups) || [];
  return groups.flatMap((g) => g.structures.map((s) => ({ ...s, group: g.group })));
}
function colourForIndex(index) {
  const hit = allStructures().find((s) => s.index === Number(index));
  return hit ? hit.color : null;
}
/** Which structures this job actually found, by index. */
function presentIndices() {
  const vols = (state.viewer && state.viewer.report.quality && state.viewer.report.quality.volumes_cm3) || {};
  return new Set(allStructures().filter((s) => vols[s.id] != null).map((s) => s.index));
}

