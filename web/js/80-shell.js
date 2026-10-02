'use strict';
/* ------------------------------------------------------------------- boot */
function wireViewer() {
  // One pair of controls that means the same thing in both views. The single
  // "overlay" slider they replace drove fillAlpha in the MPR view but, in the slice
  // view, had nothing to fade except a 1-voxel outline -- those tiles carried no
  // fill at all, so one control looked broken in one tab and fine in the other.
  //
  // The two halves are updated at very different rates, on purpose. Redrawing the
  // tile view is a canvas fill and stroke, so it tracks the slider live. The MPR
  // view cannot: `segmentation.config.style.setStyle` makes Cornerstone re-render
  // the whole labelmap representation -- `display.render()` per representation,
  // drained one animation frame at a time -- which measured at **over 800 ms for a
  // single change**. Driving that from `input` means a drag queues dozens of
  // full re-renders and the picture arrives seconds behind the handle, which is
  // exactly what "I cannot change the opacity" looks like. So the expensive half
  // fires once the slider settles.
  let styleTimer = null;
  const applyStyle = () => {
    if (!(state.viewer && state.viewer.mprMounted && window.DentistryViewer)) return;
    clearTimeout(styleTimer);
    styleTimer = setTimeout(() => {
      const st = overlayStyle();
      DentistryViewer.setOverlayStyle(st.fill, st.outline);
    }, 200);
  };
  $('fillAlpha').oninput = applyStyle;
  $('outlineW').oninput = applyStyle;
  document.querySelectorAll('.mode').forEach((b) => b.onclick = async () => {
    setMode(b.dataset.mode);
    // `mountVolume` returns immediately once mounted, so the re-jump has to happen
    // here too -- otherwise isolating a tooth in the slice view and switching to
    // MPR left the panes wherever they were, which is indistinguishable from the
    // chart not working. The slice view has always self-healed here (`draw` re-runs
    // Leaving the MPR panes has to give the primary mouse button back. Editing binds
    // it to a brush, and the plan tab's own drag lives on a different canvas -- so a
    // mode left armed here would be a brush waiting on a tab nobody is editing in.
    if (b.dataset.mode !== 'volume') {
      const ed = editState();
      if (ed && ed.on) setEditMode(false);
    }
    if (b.dataset.mode === 'volume') { await mountVolume(); syncMprToIsolate(); }
    else if (b.dataset.mode === 'plan') { await loadArch(); loadPlans(); }
  });
  $('mprReset').onclick = () => window.DentistryViewer && DentistryViewer.resetCameras();
  $('backHome').onclick = closeViewer;
  wireDisplayPop();
  wireEditing();
  wireRail();
  wireLayout();
  wire3d();
  wirePlan();
  document.addEventListener('keydown', (e) => {
    if (!state.viewer || $('workspace').hidden) return;
    if (e.key === 'Escape') {
      // Innermost thing first: a popover over the image, then the case itself.
      if (!$('displayPop').hidden) { closeDisplayPop(); return; }
      closeViewer(); return;
    }
    if (/^(INPUT|TEXTAREA|SELECT)$/.test((e.target || {}).tagName || '')) return;
    // Undo is the one chord this app claims, and it claims it BEFORE the blanket
    // modifier bail below -- Cmd+Z on a planning surface means undo everywhere else and
    // has to here too.
    if ((e.metaKey || e.ctrlKey) && (e.key === 'z' || e.key === 'Z')) {
      if (implantKey(e)) return;
    }
    // Ignore any other chord -- Cmd+1 switches browser tabs and must keep doing so.
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    // The implant tools: nudge, angulate, resize, re-seat, duplicate, step, remove.
    // Before the single-letter view toggles below, so a selected implant owns the keys
    // that move it and the view keeps the ones that do not.
    if (implantKey(e)) return;
    if (e.key === '[') { e.preventDefault(); toggleRail(); return; }
    if (e.key === ']' && state.viewer && state.viewer.mode === 'plan') {
      e.preventDefault(); toggleSide(); return;
    }
    if (e.key === 'o' && state.viewer && state.viewer.mode === 'plan') {
      e.preventDefault();
      const b = $('xsOverlayBtn'); if (b && !b.disabled) b.click();
      return;
    }
    if (e.key === 'z' && state.viewer && state.viewer.mode === 'plan') {
      e.preventDefault();
      const b = $('xsFitBtn'); if (b) b.click();
      return;
    }
    if (e.key === 'p' && state.viewer && state.viewer.mode === 'plan') {
      e.preventDefault();
      const b = $('panPaneBtn'); if (b) b.click();
      return;
    }
    if (e.key === 'b' && state.viewer && state.viewer.mode === 'plan') {
      e.preventDefault();
      const b = $('xsPicBtn'); if (b) b.click();
      return;
    }
    if (e.key === 'd') { e.preventDefault(); toggleDisplayPop(); return; }
    if (e.key === 'e' && state.viewer.mode === 'volume') {
      e.preventDefault();
      const b = $('editBtn'); if (b) b.click();
      return;
    }
    if (state.viewer.mode === 'volume') {
      const pane = { 1: 'axial', 2: 'coronal', 3: 'sagittal', 4: '3d' }[e.key];
      if (pane) { e.preventDefault(); setLayout('focus', pane); return; }
      if (e.key === '0') { e.preventDefault(); setLayout('grid'); return; }
      if (e.key === 'f') { e.preventDefault(); setLayout(layout.kind === 'solo' ? 'grid' : 'solo'); return; }
      return;
    }
    if (e.key === '\\') { e.preventDefault(); toggleDock(); return; }
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    // Scrubbing the cross-section stack is the plan tab's primary gesture. It used to
    // fall through to the Slices tab's `#slice` -- hidden in plan mode -- and then call
    // a `draw()` that early-returned unless the mode was 'slices', so the arrow keys
    // silently moved an invisible control. The Slices tab is gone; the branch stays,
    // because the MPR panes scrub on the wheel and have no business on the arrow keys.
    if (state.viewer.mode !== 'plan') return;
    const xs = $('xsSlider');
    if (!xs) return;
    e.preventDefault();
    const step = e.key === 'ArrowRight' ? 1 : -1;
    const want = Math.max(0, Math.min(Number(xs.max), Number(xs.value) + step));
    xs.value = String(want);
    selectXs(want);
  });
}

/* ------------------------------------------------------- shell and layout */

/* The Display popover.
 *
 * Everything in here used to sit permanently in the stage bar: the 3D mode
 * switch, two sliders, a reset button and a paragraph of prose under the image.
 * That is five controls and three lines of chrome around a medical image, and four
 * of the five are touched once per session if at all. The one that is not -- the
 * view switch and the pane layout -- stayed outside.
 *
 * The popover is NOT unmounted when closed, only hidden: the two range inputs are
 * read by `overlayStyle()`, and rebuilding them would drop their values and their
 * listeners.
 */
function closeDisplayPop() {
  const pop = $('displayPop');
  if (pop) pop.hidden = true;
  const btn = $('displayBtn');
  if (btn) { btn.setAttribute('aria-expanded', 'false'); btn.classList.remove('on'); }
}

function toggleDisplayPop(force) {
  const pop = $('displayPop');
  const btn = $('displayBtn');
  const open = force === undefined ? pop.hidden : !!force;
  pop.hidden = !open;
  btn.setAttribute('aria-expanded', String(open));
  btn.classList.toggle('on', open);
}

function wireDisplayPop() {
  const pop = $('displayPop');
  const btn = $('displayBtn');
  btn.onclick = (e) => { e.stopPropagation(); toggleDisplayPop(); };
  // Clicks inside must not close it -- dragging a slider fires them constantly.
  pop.addEventListener('click', (e) => e.stopPropagation());
  document.addEventListener('click', () => closeDisplayPop());
}

/** Collapse the side panel to give the viewport the whole window. */
function toggleRail(force) {
  const ws = $('workspace');
  const collapsed = force === undefined ? !ws.classList.contains('rail-collapsed') : !!force;
  ws.classList.toggle('rail-collapsed', collapsed);
  $('railToggle').setAttribute('aria-expanded', String(!collapsed));
  $('railToggle').title = (collapsed ? 'Show' : 'Collapse') + ' the side panel  ( [ )';
  try { localStorage.setItem('dentistry.rail', collapsed ? 'off' : 'on'); } catch (_) {}
  afterLayoutChange();
}

/** Collapse the right dock -- tools and structures -- to give the panes the width.
 *
 *  Key `\` rather than `]`, which `toggleSide` already owns for the plan tab's
 *  measurements sidebar. Both are right-hand panels and both can be open at once in the
 *  plan tab, so one key could not mean both without picking a winner silently.
 *
 *  `afterLayoutChange` is NOT optional here. Cornerstone sizes its canvases when a
 *  viewport is enabled and never again, so a collapse that widened the stage without it
 *  leaves every click landing at the wrong voxel -- mis-aimed, not merely stretched. */
function toggleDock(force) {
  const ws = $('workspace');
  const collapsed = force === undefined ? !ws.classList.contains('dock-collapsed') : !!force;
  ws.classList.toggle('dock-collapsed', collapsed);
  const btn = $('dockToggle');
  btn.setAttribute('aria-expanded', String(!collapsed));
  btn.title = (collapsed ? 'Show' : 'Collapse')
    + ' the tools and structures panel  ( \\ )';
  try { localStorage.setItem('dentistry.dock', collapsed ? 'off' : 'on'); } catch (_) {}
  afterLayoutChange();
}

/** Collapse the measurements sidebar. Mirrors `toggleRail`, key `]` beside its `[`.
 *
 *  Safe to collapse only because the verdict strip lives in the TOOLS row, not in the
 *  panel: a collapse that hid the answer and kept the working would be worse than no
 *  collapse at all. */
function toggleSide(force) {
  const stage = $('planStage');
  const btn = $('sideToggle');
  if (!stage || !btn) return;
  const collapsed = force === undefined
    ? !stage.classList.contains('side-collapsed') : !!force;
  stage.classList.toggle('side-collapsed', collapsed);
  btn.setAttribute('aria-expanded', String(!collapsed));
  btn.title = (collapsed ? 'Show' : 'Collapse') + ' the measurements panel  ( ] )';
  try { localStorage.setItem('dentistry.planside', collapsed ? 'off' : 'on'); } catch (_) {}
  // Cornerstone measures a viewport when it is enabled and never again, so a pane that
  // changed size without this reports the OLD box for hit-testing and every click in
  // the 3-D pane lands at the wrong voxel. Not cosmetic.
  afterLayoutChange();
}

/* The two section preferences live at MODULE level, not in plan state.
 *
 * `planState()` returns null until a case is open, and these are wired at BOOT -- so
 * reading plan state here threw `Cannot set properties of null` inside `wireViewer`,
 * which killed `boot()` and left the whole app at "connecting..." with a blank page.
 *
 * The offline harness cannot see this class of defect AT ALL: it sets
 * `DENTISTRY_NO_BOOT = true` and calls `openCase()` directly, so `boot()` ->
 * `wireViewer` -> `wireRail` -> `wireSide` never runs there. Anything that only breaks
 * on the wiring path is invisible to every gate and visible on the first real page load.
 */
const XS_OVERLAY_STATES = ['key', 'all', 'off'];
let xsOverlayPref = 'key';
let xsFitPref = 'site';

/** Cycle the section overlay: key -> all -> off. */
function setXsOverlay(mode) {
  const p = planState();
  xsOverlayPref = XS_OVERLAY_STATES.includes(mode) ? mode : 'key';
  if (p) p.xsOverlay = xsOverlayPref;
  const b = $('xsOverlayBtn');
  if (b) {
    const store = ((p && p.xsc) || {})[p && p.jaw] || {};
    // Three states, three messages. An absent artifact says WHY, because a silently
    // empty overlay is indistinguishable from "there is nothing there".
    b.textContent = store.state === 'unpublished' ? 'outlines: not in this case'
      : store.state === 'failed' ? 'outlines: unavailable'
      : `outlines: ${xsOverlayPref}`;
    b.disabled = store.state === 'unpublished';
    b.title = store.state === 'unpublished'
      ? 'This case was processed before the section outlines existed. Re-upload the scan to get them.'
      : store.state === 'failed'
        ? `The outlines could not be loaded (${store.reason || 'unknown'})`
        : 'Structure outlines on the section  ( o )';
  }
  try { localStorage.setItem('dentistry.xsoverlay', xsOverlayPref); } catch (_) {}
  if (p && p.arch) drawRulers('xs');
}

/** Site-cropped or whole section. */
function setXsFit(mode) {
  const p = planState();
  xsFitPref = mode === 'whole' ? 'whole' : 'site';
  if (p) p.xsFit = xsFitPref;
  const b = $('xsFitBtn');
  if (b) b.textContent = `view: ${xsFitPref}`;
  try { localStorage.setItem('dentistry.xsfit', xsFitPref); } catch (_) {}
  // A full repaint, not just a decoration: the backing store's height changes with the
  // window, so the picture has to be blitted again. `drawRulers` does exactly that --
  // it calls `planCtx` with the current crop and re-draws the held image -- so this no
  // longer goes through `selectXs`, which would re-fetch and re-decode a JPEG that is
  // already on screen.
  if (p && p.arch) {
    const info = ((p.arch || {}).jaws || {})[p.jaw];
    drawRulers('xs');
    if (info && info.ok) renderXsMeta(info);
  }
}

/* ------------------------------------------------------- plan view options
 * Three, and each is a statement about the PICTURE rather than about the anatomy.
 *
 * `zoom`  scales the crop window; see `xsCropRows`. Scroll or pinch on the section.
 * `pane`  gives the panoramic working height instead of locator height, which is what
 *         makes mesiodistal angulation adjustable rather than merely visible.
 * `pic`   brightness and contrast, applied to the JPEG and to nothing else.
 *
 * `pic` is the one that needs a rule written down. The section and the panoramic are
 * SERVER-RENDERED JPEGs, already windowed at a bone window from the full-resolution
 * grid, and every millimetre in this app is measured server-side on that grid. So this
 * cannot change any number, and it must not look as though it could: the filter is set
 * on the context around `drawImage` only, so the outlines, the implant, the envelope
 * rings and the chips are drawn at full strength over an adjusted picture, and the
 * caption says which adjustment is on.
 */
const XS_PIC = [
  { key: 'normal', filter: 'none', label: 'as rendered' },
  { key: 'bright', filter: 'brightness(1.25) contrast(1.05)', label: 'brighter' },
  { key: 'hard', filter: 'brightness(0.95) contrast(1.45)', label: 'harder edges' },
];
let xsPicPref = 'normal';

function picFilter() {
  const hit = XS_PIC.find((x) => x.key === xsPicPref);
  return hit ? hit.filter : 'none';
}

function setXsPic(key) {
  xsPicPref = XS_PIC.some((x) => x.key === key) ? key : 'normal';
  const hit = XS_PIC.find((x) => x.key === xsPicPref);
  const b = $('xsPicBtn');
  if (b) {
    b.textContent = `picture: ${hit.label}`;
    b.title = 'Brightness and contrast of the rendered picture only. It changes no '
      + 'measurement: every millimetre in this app is measured on the full-resolution '
      + 'volume, server-side, and these are pre-windowed JPEGs of it.  ( b )';
  }
  try { localStorage.setItem('dentistry.xspic', xsPicPref); } catch (_) { /* private mode */ }
  const p = planState();
  if (p && p.arch) { drawRulers('xs'); drawRulers('pan'); }
}

function wireXsPic() {
  const b = $('xsPicBtn');
  if (!b) return;
  let start = 'normal';
  try { start = localStorage.getItem('dentistry.xspic') || 'normal'; } catch (_) { /* private */ }
  setXsPic(start);
  b.onclick = () => {
    const i = XS_PIC.findIndex((x) => x.key === xsPicPref);
    setXsPic(XS_PIC[(i + 1) % XS_PIC.length].key);
  };
}

/** Scroll or pinch on the section: step the crop window. See `XS_ZOOM_STEP`. */
function wireXsZoom() {
  const cv = $('xsCanvas');
  if (!cv) return;
  cv.addEventListener('wheel', (e) => {
    const p = planState();
    const info = p && ((p.arch || {}).jaws || {})[p.jaw];
    if (!info || !info.ok) return;
    e.preventDefault();
    // macOS pinch arrives as a wheel event with `ctrlKey` set, so one handler covers
    // the trackpad gesture and the mouse wheel -- the same reason the 3-D pane's zoom
    // is written this way.
    const k = e.deltaY > 0 ? XS_ZOOM_STEP : 1 / XS_ZOOM_STEP;
    p.xsZoom = Math.max(XS_ZOOM_MIN, Math.min(XS_ZOOM_MAX, (Number(p.xsZoom) || 1) * k));
    // Zooming the window while the whole section is shown would do nothing at all, so
    // the gesture implies the cropped view. Stated in the caption either way.
    if ((p.xsFit || xsFitPref) === 'whole') { setXsFit('site'); return; }
    drawRulers('xs');
    renderXsMeta(info);
  }, { passive: false });
  // Double-click restores the default window. A zoom with no way back is a trap.
  cv.addEventListener('dblclick', () => {
    const p = planState();
    const info = p && ((p.arch || {}).jaws || {})[p.jaw];
    if (!info || !info.ok) return;
    p.xsZoom = 1;
    drawRulers('xs');
    renderXsMeta(info);
  });
}

/** The panoramic at working height instead of locator height.
 *
 *  The strip is deliberately short -- its horizontal axis is arc length and it is a
 *  locator, so the pixels belong to the two views you plan against. But it is also the
 *  only plane mesiodistal angulation is visible in, and 104 px of it is not enough to
 *  set an angle on. So it is a TOGGLE, off by default, and the tall state is a mode the
 *  reader chose rather than a default that quietly costs the section 92 px. */
function setPanPane(open) {
  const stage = $('planStage');
  if (!stage) return;
  stage.classList.toggle('pan-tall', !!open);
  const b = $('panPaneBtn');
  if (b) {
    b.setAttribute('aria-pressed', open ? 'true' : 'false');
    b.textContent = open ? 'mesiodistal: open' : 'mesiodistal';
    b.title = open
      ? 'Back to the locator strip, and give the pixels to the section  ( p )'
      : 'Open the panoramic to working height: the plane mesiodistal angulation is '
        + 'drawn in, and the one you can drag it in  ( p )';
  }
  try { localStorage.setItem('dentistry.panpane', open ? '1' : '0'); } catch (_) { /* private */ }
  // Cornerstone measures a viewport once, at enable time, and the 3-D pane is a grid
  // sibling of this one: without the resize a click in it lands on the wrong voxel.
  afterLayoutChange();
  const p = planState();
  if (p && p.arch) { drawRulers('pan'); drawRulers('xs'); }
}

function wirePanPane() {
  const b = $('panPaneBtn');
  if (!b) return;
  let open = false;
  try { open = localStorage.getItem('dentistry.panpane') === '1'; } catch (_) { /* private */ }
  setPanPane(open);
  b.onclick = () => setPanPane(!$('planStage').classList.contains('pan-tall'));
}

function wireXsFit() {
  const b = $('xsFitBtn');
  if (!b) return;
  let start = 'site';
  try { start = localStorage.getItem('dentistry.xsfit') || 'site'; } catch (_) {}
  setXsFit(start);
  b.onclick = () => setXsFit(xsFitPref === 'whole' ? 'site' : 'whole');
}

function wireXsOverlay() {
  const b = $('xsOverlayBtn');
  if (!b) return;
  let start = 'key';
  try { start = localStorage.getItem('dentistry.xsoverlay') || 'key'; } catch (_) {}
  setXsOverlay(start);
  b.onclick = () => {
    const i = XS_OVERLAY_STATES.indexOf(xsOverlayPref);
    setXsOverlay(XS_OVERLAY_STATES[(i + 1) % XS_OVERLAY_STATES.length]);
  };
}

function wireSide() {
  const btn = $('sideToggle');
  if (!btn) return;
  btn.onclick = () => toggleSide();
  wireXsOverlay();
  wireXsFit();
  try {
    if (localStorage.getItem('dentistry.planside') === 'off') toggleSide(true);
  } catch (_) {}
}

function wireRail() {
  $('railToggle').onclick = () => toggleRail();
  $('dockToggle').onclick = () => toggleDock();
  wireSide();
  wireDock();
  try {
    if (localStorage.getItem('dentistry.rail') === 'off') toggleRail(true);
  } catch (_) {}
  try {
    if (localStorage.getItem('dentistry.dock') === 'off') toggleDock(true);
  } catch (_) {}
  ['seriesCard', 'runCard'].forEach((id) => {
    const el = $(id);
    if (!el) return;
    try {
      const saved = localStorage.getItem('dentistry.fold.' + id);
      if (saved !== null) el.open = saved === 'open';
    } catch (_) {}
    el.addEventListener('toggle', () => {
      try { localStorage.setItem('dentistry.fold.' + id, el.open ? 'open' : 'shut'); } catch (_) {}
    });
  });
}

const layout = { kind: 'grid', pane: 'axial' };

/** Cornerstone sizes its canvases when a viewport is enabled and never again.
 *
 * So every layout change needs an explicit resize, or the old canvas stays stretched
 * over the new box: the image letterboxes and, worse, every click lands at the wrong
 * voxel because the canvas-to-world mapping is stale. One frame of delay so the grid
 * has actually reflowed before we measure it -- `requestAnimationFrame`, never
 * awaited, because awaiting one in a load path deadlocked `mount()` in a background
 * tab and left cases stuck on "loading" forever.
 */
/** Move the LIVE Cornerstone 3-D pane between the MPR grid and the plan stage.
 *
 *  The plan tab needs a 3-D view -- placing an implant you cannot see in space is the
 *  feature working on paper only -- and `#cs3d` lived inside `#mprStage`, which
 *  `setMode` hides whenever the plan tab is open. So the implants were pushed into a
 *  zero-sized hidden viewport on every drag frame, and `focusImplant` reframed a camera
 *  nobody could look at: you placed implants in a tab with no 3-D and saw the 3-D in a
 *  tab where you could not place them.
 *
 *  Reparenting rather than mounting a second viewport. A second one would hold another
 *  copy of the volume and all 42 surfaces on the GPU to show the same picture. Moving
 *  the mounted element keeps its WebGL context -- verified on the RTX 3080: the pane
 *  came back 416x416 with an 832x832 backing store, 42 surfaces and both implant
 *  actors intact. `resize()` is what makes it stick, because Cornerstone measures a
 *  viewport at enable time and never again.
 */
function move3dPane(where) {
  const pane = document.querySelector('.pane-3d');
  if (!pane) return;
  const host = where === 'plan' ? $('plan3d') : $('mprStage');
  if (!host || pane.parentElement === host) return;
  // `.pane-3d` is a `.grid4` child in the MPR stage and must go back in its grid slot;
  // in the plan stage it fills its host. One class, toggled, rather than inline styles.
  pane.classList.toggle('in-plan', where === 'plan');
  host.appendChild(pane);
  const empty = $('plan3dEmpty');
  if (empty) {
    empty.hidden = where === 'plan' && !!(state.viewer && state.viewer.mprMounted);
    empty.textContent = (state.viewer && state.viewer.mprMounted)
      ? '' : 'the 3-D view needs the volume, which is still loading';
  }
  afterLayoutChange();
}

/* The dental chart is BORROWED by the plan tab, not copied.
   It is one element with one set of click handlers wired by `renderArch`, and a second
   copy would need a second id -- which `check-app.js` forbids outright -- and a second
   set of listeners to keep in step. So it moves, exactly as `.pane-3d` does, and by the
   same rules: a class rather than inline styles, and `teardownCase` puts it home before
   the viewer unmounts.
   Why it moves at all: in the rail it was a 205 px card holding a 2.63:1 picture inside a
   300 px column, and on an uncorrected case it was the ONLY thing in that column -- 300 x
   769 px of window spent on it. In the site bar it is the same width it always was, the
   rail goes away, and the section and the 3-D pane take the 300 px. */
function moveChartCard(where) {
  const card = document.querySelector('.chart-card');
  if (!card) return;
  const bar = $('siteBar');
  const rail = document.querySelector('.rail');
  const host = where === 'plan' ? bar : rail;
  if (!host) return;
  if (card.parentElement !== host) {
    card.classList.toggle('in-plan', where === 'plan');
    // BEFORE the plan bar, so the bar reads panoramic - chart - plan left to right
    // whichever order the two arrivals happen in. `insertBefore(x, null)` appends, so
    // the rail branch needs no special case.
    host.insertBefore(card, where === 'plan' ? $('planBar') : rail.firstChild);
  }
  // The hint is a sentence a first-time reader needs once and every later session pays
  // for in vertical space. In the bar it becomes the chart's tooltip; in the rail, where
  // there is room, it goes back to being visible prose.
  const hint = $('chartHint');
  if (hint) {
    const text = hint.textContent || '';
    if (where === 'plan') card.title = text;
    else card.removeAttribute('title');
  }
}

function afterLayoutChange() {
  requestAnimationFrame(() => {
    if (window.DentistryViewer && state.viewer && state.viewer.mprMounted) DentistryViewer.resize();
    // The plan tab had no branch here at all, so a window resize or a rail collapse
    // left the 3-D pane at its old canvas size and never repainted the section's
    // overlays. Both matter now that the 3-D pane lives in this stage.
    if (state.viewer && state.viewer.mode === 'plan' && state.viewer.plan
        && state.viewer.plan.arch) {
      drawRulers('xs'); drawRulers('pan');
      // `resize()` re-fits the camera to the new viewport, which throws away the
      // framing `focusImplant` set. Collapsing the rail or resizing the window would
      // otherwise silently zoom back out to the whole jaw and lose the implant the
      // reader was looking at.
      const sel = state.viewer.plan.selected;
      if (sel && window.DentistryViewer && DentistryViewer.focusImplant) {
        DentistryViewer.focusImplant(sel);
      }
    }
  });
}

function setLayout(kind, pane) {
  layout.kind = kind;
  if (pane) layout.pane = pane;
  // "focus"/"solo" with nothing chosen yet means the last pane the user picked.
  const stage = $('mprStage');
  stage.classList.toggle('focus', kind === 'focus');
  stage.classList.toggle('solo', kind === 'solo');
  stage.querySelectorAll('.pane').forEach((p) => {
    p.classList.toggle('is-focus', kind !== 'grid' && p.dataset.pane === layout.pane);
  });
  document.querySelectorAll('#layoutPicker .segb')
    .forEach((b) => b.classList.toggle('on', b.dataset.layout === kind));
  afterLayoutChange();
}

function wireLayout() {
  document.querySelectorAll('#layoutPicker .segb').forEach((b) => {
    b.onclick = () => setLayout(b.dataset.layout);
  });
  // Double-click a pane to enlarge it, double-click it again to go back. The handler
  // goes on `.pane` rather than `.cs`: Cornerstone's tools own the inner element, and
  // a double-click there also delivers two window/level drags.
  $('mprStage').addEventListener('dblclick', (e) => {
    const pane = e.target.closest && e.target.closest('.pane');
    if (!pane || !pane.dataset.pane) return;
    e.preventDefault();
    const already = layout.kind === 'focus' && layout.pane === pane.dataset.pane;
    setLayout(already ? 'grid' : 'focus', pane.dataset.pane);
  });
  // The panes also change size when the window does, and when the sidebar animates.
  let rt = null;
  window.addEventListener('resize', () => {
    clearTimeout(rt);
    rt = setTimeout(afterLayoutChange, 120);
  });
}

