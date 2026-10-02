'use strict';
/* The implant-planning views.
 *
 * Two pictures, both rendered server-side from the FULL-RESOLUTION grid and both
 * publishing an exact `pixel_mm`: a panoramic reconstruction swept along the fitted
 * arch, and the buccolingual cross-section perpendicular to it at one arc position.
 *
 * They are not drawn from `volume/image.raw`. That volume is 8-bit, pre-windowed and
 * downsampled to about 0.66 mm -- a display object, as three separate places in this
 * app already say. A cross-section resampled from it would look convincing and would
 * not be measurable, and a ruler on it would disagree with the server about the same
 * gap. Which is also why the Cornerstone LengthTool sitting unused in the bundle
 * stays unused: it binds to the panes showing that volume.
 */
function planState() {
  const v = state.viewer;
  if (!v) return null;
  // `arch: null` until `loadArch()` resolves, and the plan tab is reachable before then
  // -- `setMode('plan')` starts the fetch and returns. So every consumer treats a null
  // arch as "no jaws yet" rather than dereferencing it.
  v.plan = v.plan || { jaw: 'mandible', index: null, indexJaw: null, arch: null, img: null };
  return v.plan;
}

function archUrl() {
  const v = state.viewer;
  return `${API}/jobs/${v.jobId}/files/planning/arch.json`;
}

function xsUrl(jaw, i) {
  const v = state.viewer;
  return `${API}/jobs/${v.jobId}/files/planning/xs/${jaw}/${String(i).padStart(4, '0')}.jpg`;
}

function panUrl(jaw) {
  const v = state.viewer;
  return `${API}/jobs/${v.jobId}/files/planning/pan/${jaw}.jpg`;
}

/** Backing-store multiple for the two plan canvases.
 *
 *  Same argument as the retired Slices tab's 2x render scale, never applied here: the
 *  server JPEG is 480 px across, the pane is 270-370 CSS px, and on a DPR-2 display
 *  that is 540-740 device pixels. Drawing the implant outline, the rulers and the arc
 *  marker into a 480 px buffer threw away half the resolution of the one surface the
 *  reader angles an implant on.
 *
 *  Load-bearing invariant: the canvas COORDINATE SYSTEM stays in image pixels. Every
 *  geometry consumer here -- `xsFrame`'s `colPitch`/`rowPitch`, `drawImplants`,
 *  `drawRulers`, `drawArcMarkerOn`, `jumpToArcColumn` -- speaks image pixels against a
 *  published `pixel_mm`, and re-deriving all of them in device pixels would be six
 *  chances to put an implant in the wrong place. So the buffer grows and a single
 *  `setTransform` scales into it; `canvasPoint` divides back out. Two conversions, both
 *  in this file, both proven by `check-rail.mjs --selftest`.
 */
const XS_RENDER_SCALE = 2;

/** Size a plan canvas for `img` and hand back a context in IMAGE pixels. */
/* ------------------------------------------------------------- the section crop
 * A buccolingual section is 36.1 x 68.1 mm -- aspect 0.53 -- so `object-fit: contain`
 * fits it BY HEIGHT and every extra pixel of width becomes black bar. Measured live:
 * collapsing the left rail gave the picture column 325 more pixels and the section did
 * not grow by one. The only way width stops being slack is to change the picture's
 * ASPECT, which means showing less of the 68 mm.
 *
 * So the section is cropped in `z` only -- `t` is always the full published range,
 * because the buccal and lingual plates are what a section is FOR. One window, applied
 * as a single translation inside the transform `planCtx` already sets, so the drawing
 * coordinate system stays in image pixels and every consumer of it is unchanged.
 *
 * THE TOUCH POINTS, all of them: `planCtx` (the backing store's height and the
 * translation), `planSize` (the visible height), `canvasPoint` (add the offset back)
 * and `withScreenUnits` (same). `tzToPixel` is deliberately NOT one of them: it returns
 * image pixels and the transform does the rest, which is the whole reason the crop is a
 * translation rather than a rescale. `drawImage` is not one either, for the same reason
 * -- the image is drawn at its true size and the canvas clips it.
 */
const CROP_WINDOW_MM = 36;   // implant (<=16) + envelope + diagnostic margin, and it
                             // makes the aspect 1.00 against the 36.1 mm t-range
const CROP_PAD_MM = 6;
const CROP_MIN_MM = 30;

/* SCROLL TO ZOOM, inside the crop rather than beside it.
 *
 * A free zoom would mean a scale factor in the transform, and then `planSize`,
 * `canvasPoint`, `withScreenUnits` and `drawImage` would each need it -- a fifth
 * coordinate factor on a contract that took a round trip measured at 1.42e-14 px to
 * pin down. There is no need: what limits the section's magnification is its ASPECT,
 * `object-fit: contain` fits it by the long side, and the crop already changes the
 * aspect. Scaling the crop WINDOW is therefore a real zoom that touches no coordinate
 * code at all -- the same single translation, computed from a different span.
 *
 * The window stays anchored on the implant (or the crest), so there is no pan gesture
 * to conflict with the ruler or the drag, and it can never be scrolled to somewhere
 * with nothing in it. Zooming out far enough returns the whole section, which is the
 * same state the `Z` toggle reaches.
 */
const XS_ZOOM_MIN = 0.6;
const XS_ZOOM_MAX = 2.6;
const XS_ZOOM_STEP = 1.12;      // per wheel notch, so a notch is the same proportion

/** Rows [y0, y0+rows) of the section to show, or null for the whole picture. */
function xsCropRows(info) {
  const p = planState();
  if ((p.xsFit || xsFitPref) === 'whole') return null;
  const f = xsFrame(info);
  const nRows = info.cross_sections.size[0];
  let zHi = null; let zLo = null;
  const here = info.cross_sections.s_mm[p.index];
  // The implant on this section, if there is one. Computed from the POSE, and only
  // when the section or the selection changes -- never inside the drag loop. An
  // auto-fit recomputed per pointermove is a positive-feedback loop: the window chases
  // the implant, the implant appears to move under a stationary pointer, and the drag
  // walks away by roughly one pad per event.
  const imp = (p.implants || []).find(
    (i) => i.jaw === p.jaw && Math.abs(i.s_mm - here) <= XS_NEAR_MM);
  if (imp) {
    const zs = implantOutline(imp).map(([, z]) => z);
    zHi = Math.max(...zs) + CROP_PAD_MM;
    zLo = Math.min(...zs) - CROP_PAD_MM;
  } else {
    // Else the crest of the nearest site: the alveolar ridge is what a section that has
    // no implant on it yet is being read for.
    const sites = info.sites || {};
    let best = null;
    Object.keys(sites).forEach((k) => {
      const st = sites[k];
      if (!st || st.crest_z_mm == null || st.s_mm == null) return;
      if (!best || Math.abs(st.s_mm - here) < Math.abs(best.s_mm - here)) best = st;
    });
    if (best && Math.abs(best.s_mm - here) < 6) {
      const up = p.jaw === 'maxilla' ? CROP_WINDOW_MM - 4 : 4;
      zHi = best.crest_z_mm + up;
      zLo = zHi - CROP_WINDOW_MM;
    }
  }
  if (zHi == null) return null;
  const content = Math.max(CROP_MIN_MM, zHi - zLo);
  // A long implant at full tilt can exceed the window. Widening rather than clipping is
  // the only safe direction, and it must be visible in the readout rather than silent.
  let span = Math.max(content, CROP_WINDOW_MM);
  // The reader's zoom, applied to the window and floored at the CONTENT: scrolling in
  // must never hide the platform or the apex of the implant the window is anchored on,
  // because those are the two ends the whole verdict is about.
  span = Math.max(zHi - zLo, span * (Number(p.xsZoom) || 1));
  const mid = (zHi + zLo) / 2;
  let y0 = Math.round((f.zTop - (mid + span / 2)) / f.rowPitch);
  let rows = Math.round(span / f.rowPitch);
  rows = Math.min(rows, nRows);
  y0 = Math.max(0, Math.min(y0, nRows - rows));
  if (rows >= nRows - 2) return null;
  return { y0, rows };
}

function planCtx(cv, img, aspectX, crop) {
  // The panoramic's pixels are NOT square. It is 248 columns at 0.5 mm and 453 rows at
  // 0.150442 mm -- 124 mm of arch by 68 mm tall, a LANDSCAPE picture stored as a
  // portrait bitmap. Drawn 1:1 the whole arch is squashed by 3.324x, which is what it
  // had always been doing; nobody could see it because the panoramic was 401ing. The
  // cross-section is near-isotropic (0.150442 vs 0.150628) and passes ax = 1.
  //
  // Same remedy as the retired Slices tab's 2x render scale, same rule as the DPR scale:
  // the backing store carries the correction, the canvas COORDINATE SYSTEM stays in
  // image pixels, and the two factors are recorded on the element so `planSize` and
  // `canvasPoint` can divide them back out. Nothing downstream has to know.
  const ax = Number(aspectX) > 0 ? Number(aspectX) : (cv.dsvAx || 1);
  const sx = XS_RENDER_SCALE * ax;
  const sy = XS_RENDER_SCALE;
  const w = img ? img.naturalWidth : Math.round(cv.width / sx);
  const h = img ? img.naturalHeight : Math.round(cv.height / sy);
  // The crop, as ONE translation. `y0` is an image row; the canvas is sized to the
  // visible rows only and the transform slides the picture up by that many, so image
  // pixel (x, y) still lands where every consumer expects it and rows outside the
  // window are clipped by the canvas rather than scaled away. Recorded on the element
  // so `planSize`, `canvasPoint` and `withScreenUnits` divide it back out -- the same
  // discipline `dsvAx` already uses for the panoramic's anisotropy.
  const y0 = crop ? Math.max(0, Math.min(crop.y0, h - 1)) : 0;
  const visible = crop ? Math.max(1, Math.min(crop.rows, h - y0)) : h;
  if (cv.width !== Math.round(w * sx)) cv.width = Math.round(w * sx);
  if (cv.height !== Math.round(visible * sy)) cv.height = Math.round(visible * sy);
  cv.dsvAx = ax;
  cv.dsvY0 = y0;
  const g = cv.getContext('2d');
  g.setTransform(sx, 0, 0, sy, 0, -y0 * sy);
  g.imageSmoothingQuality = 'high';
  return { g, w, h, y0, visible };
}

/** A plan canvas's size in IMAGE pixels, whatever its backing store is. */
function planSize(cv) {
  const ax = cv.dsvAx || 1;
  // `h` is the VISIBLE height in image pixels, which with a crop is smaller than the
  // picture. Every caller wants the visible one: `drawArcMarkerOn` draws a full-height
  // rule, `canvasPoint` bounds a click, `drawSectionFrame` sizes the band rectangle.
  return { w: cv.width / (XS_RENDER_SCALE * ax), h: cv.height / XS_RENDER_SCALE,
           y0: cv.dsvY0 || 0 };
}

/** The aspect correction a jaw's panoramic needs: column pitch over row pitch. */
function panAspectX(info) {
  const mm = (info && info.panoramic && info.panoramic.pixel_mm) || null;
  if (!mm || !mm[0] || !mm[1]) return 1;
  return mm[1] / mm[0];
}

/** Pointer event -> position in a canvas's OWN pixels, honouring `object-fit`.
 *
 * `.pan-wrap canvas` and `.xs-wrap canvas` are `max-width:100%; max-height:100%;
 * object-fit: contain` (app.css), so whenever the picture's aspect ratio differs
 * from its box the image is letterboxed inside it. Measuring against the element's
 * bounding rect -- which the arc-jump handler did until 2026-09-01 -- then lands on
 * the wrong column by however wide the bars are.
 *
 * Every pointer interaction on these two canvases goes through here: the arc jump,
 * the ruler and the implant drag. One mapping, one place to be wrong.
 *
 * Returns null for a click on the letterbox itself rather than clamping, because a
 * measurement started outside the image is not a measurement.
 */
function canvasPoint(cv, ev) {
  const r = cv.getBoundingClientRect();
  if (!cv.width || !cv.height || !r.width || !r.height) return null;
  // In IMAGE pixels, not backing-store pixels -- see `XS_RENDER_SCALE`. `object-fit`
  // letterboxes against the backing store's aspect ratio, which the scale does not
  // change, so the fit maths is unaffected and only the returned units differ.
  // `object-fit: contain` letterboxes the BACKING STORE, so the fit is computed against
  // cv.width/cv.height; the result is then divided back into image pixels by the two
  // factors `planCtx` baked in. With an anisotropic panoramic those factors differ, so
  // x and y have different millimetres per screen pixel -- which is true of the picture
  // and has to stay true of the mapping.
  const { w, h } = planSize(cv);
  const k = Math.min(r.width / cv.width, r.height / cv.height);
  const drawnW = cv.width * k;
  const drawnH = cv.height * k;
  const px = (ev.clientX - r.left - (r.width - drawnW) / 2) / k;
  const py = (ev.clientY - r.top - (r.height - drawnH) / 2) / k;
  const x = px / (XS_RENDER_SCALE * (cv.dsvAx || 1));
  const y = py / XS_RENDER_SCALE;
  if (x < 0 || y < 0 || x > w || y > h) return null;
  // ...and back into the PICTURE's rows, so a crop is invisible to every caller. Bounds
  // are checked against the visible height FIRST, above: a click on the letterbox is
  // still refused, and only a click inside the window is translated.
  const yImg = y + (cv.dsvY0 || 0);
  // `scale` is screen pixels per IMAGE pixel along y, which is the axis every metric
  // reading on these canvases uses.
  return { x, y: yImg, scale: k * XS_RENDER_SCALE };
}

async function loadArch() {
  const p = planState();
  if (!p) return;
  if (!p.arch) {
    try {
      // FRESH. The manifest is small, it is read once per case, and it is the one
      // artifact whose staleness is silently wrong rather than merely old.
      const r = await cachedFetch(archUrl(), true);
      p.arch = await r.json();
    } catch (e) {
      $('planEmpty').textContent = 'the planning views are not available for this case';
      return;
    }
  }
  // The viewer needs the PUBLISHED polyline to place an implant in 3D. Handed over by
  // reference and never re-derived: `ArchFit.normals()` picks its sign by moving away
  // from the arch centroid, and reimplementing that rule is a silent mirror waiting to
  // happen. Guarded because the plan tab can open before the volume has mounted --
  // `setImplantArch` is safe either way, and `setImplants` stashes until mount.
  if (window.DentistryViewer && DentistryViewer.setImplantArch) {
    DentistryViewer.setImplantArch(p.arch);
  }
  const jaws = (p.arch && p.arch.jaws) || {};
  // A jaw whose arch fit refused has no pictures. Say which, rather than showing an
  // empty canvas -- a refusal is information, and the reason is worth reading.
  document.querySelectorAll('#planJawTabs .plane').forEach((b) => {
    const info = jaws[b.dataset.jaw];
    b.disabled = !(info && info.ok);
    b.title = (info && info.ok) ? '' : ((info && info.reason) || 'not reconstructed');
  });
  if (!(jaws[p.jaw] && jaws[p.jaw].ok)) {
    const first = Object.keys(jaws).find((j) => jaws[j] && jaws[j].ok);
    if (!first) {
      $('planEmpty').textContent = (jaws[p.jaw] && jaws[p.jaw].reason)
        || 'no arch could be fitted to this scan';
      return;
    }
    p.jaw = first;
  }
  selectJaw(p.jaw);
}

/** The section this jaw should open on.
 *
 *  A site that publishes a crest height is a site an implant could go in, so the first
 *  one of those is the most useful thing to be looking at. Falling back to mid-arch
 *  rather than to index 0, because both ends of the list are ramus.
 */
function openingIndex(info) {
  const sites = info.sites || {};
  const wanted = Object.keys(sites)
    .filter((k) => sites[k] && sites[k].height_mm != null && sites[k].s_mm != null)
    .map((k) => sites[k].s_mm)
    .sort((x, y) => Math.abs(x) - Math.abs(y));
  if (wanted.length) return nearestXsIndex(info, wanted[0]);
  return Math.floor((info.cross_sections.count - 1) / 2);
}

function selectJaw(jaw) {
  const p = planState();
  const info = ((p.arch || {}).jaws || {})[jaw];
  if (!info || !info.ok) return;
  p.jaw = jaw;
  document.querySelectorAll('#planJawTabs .plane').forEach(
    (b) => b.classList.toggle('on', b.dataset.jaw === jaw));
  const n = info.cross_sections.count;
  const sl = $('xsSlider');
  sl.min = 0; sl.max = Math.max(0, n - 1);
  // Where the tab OPENS. `p.index` was seeded 0 and clamped, so on a real case the plan
  // tab opened on cross-section 1 of 248 -- the extreme distal end of the ramus, with no
  // alveolar crest anywhere in the picture. Every pixel this block wins for the section
  // was being spent on the wrong anatomy.
  if (p.index == null || p.jaw !== p.indexJaw) p.index = openingIndex(info);
  p.indexJaw = p.jaw;
  p.index = Math.max(0, Math.min(p.index, n - 1));
  sl.value = p.index;
  // The count came off. `#xsLabel`, two centimetres to the left in the same row, already
  // reads "cross-section 196 of 248" -- so this said "248 cross-sections" beside a
  // control that says "of 248", and the arc length was the only thing here that was not
  // already on screen.
  $('planArcHint').textContent = `${info.arc_length_mm.toFixed(0)} mm of arch`;
  drawPanoramic();
  loadXsContours();
  selectXs(p.index);
}

async function drawPanoramic() {
  const p = planState();
  const cv = $('panCanvas');
  const url = panUrl(p.jaw);
  try {
    const img = await loadAuthedImage(url);
    // A jaw switch in flight while this awaited: the bytes that just arrived are for
    // the previous jaw, and painting them would label the wrong side of the mouth.
    if (panUrl(p.jaw) !== url) { revokeImage(img); return; }
    revokeImage(p.panImage);
    const info = ((p.arch || {}).jaws || {})[p.jaw];
    const ax = panAspectX(info);
    const { g, w, h } = planCtx(cv, img, ax);
    g.drawImage(img, 0, 0, w, h);
    p.panImage = img;
    // The pane takes the picture's shape, so it has no black bars to waste. In REAL
    // proportions -- columns are 0.5 mm and rows 0.150442 mm, so the displayed
    // width:height is (w * ax) : h, not w : h.
    const stage = $('planStage');
    if (stage && h > 0) stage.style.setProperty('--pan-aspect', String((w * ax) / h));
    $('planEmpty').hidden = true;
    drawRulers('pan');
  } catch (e) {
    revokeImage(p.panImage);
    p.panImage = null;
    const { g, w, h } = planCtx(cv, null);
    g.clearRect(0, 0, w, h);
    $('planEmpty').hidden = false;
    $('planEmpty').textContent = 'the panoramic could not be loaded (' + e.message + ')';
  }
}

/* Where along the panoramic the current cross-section sits. One vertical rule, drawn
 * over a redraw of the picture rather than by saving and restoring pixels -- the
 * image is already in the browser cache, so a redraw costs nothing and cannot leave
 * a smear behind. */
/** Repaint the panoramic: image, arc marker, then any rulers on it. */
function drawArcMarker() {
  drawRulers('pan');
}

/** The section's caption, the slice label and the slider position.
 *
 *  Extracted from `selectXs` so a view change that does not change WHICH section is in
 *  view -- the crop window, the zoom, the whole/site toggle -- can repaint and relabel
 *  without re-fetching the picture. `selectXs` reloads through `loadAuthedImage`, which
 *  is a Cache Storage read, a blob URL and an image decode; at wheel rate that is a
 *  stutter and a lot of garbage for a caption that already has its bytes on screen. */
function renderXsMeta(info) {
  const p = planState();
  const s = info.cross_sections.s_mm[p.index];
  const px = info.cross_sections.pixel_mm[0];
  // The side is named from the sign of s, which the arch fit defines as negative to
  // the patient's RIGHT. Naming it here rather than in the picture keeps the one
  // laterality convention in one place.
  const side = s < 0 ? 'right' : 'left';
  // Four decimals, not two: the pitch is 0.1506 mm, and rounding it to 0.15 in the copy
  // beside a ruler that uses the real value invites somebody to "correct" the ruler.
  // "plane perpendicular to the arch" came off. It is a CONSTANT -- true of every one of
  // the 248 sections, on every case -- and it was the clause that pushed this caption onto
  // a second line, where it ran straight through the 10 mm scale bar drawn in the same
  // corner of the picture. A fact that never changes belongs in the documentation, not in
  // a per-section readout that is competing for the same 12 px as a ruler. It is on the
  // pane's own tooltip instead.
  $('xsMeta').textContent =
    `${Math.abs(s).toFixed(1)} mm ${side} of the midline · ${px.toFixed(4)} mm per pixel`
    // The slab thickness, and whether the picture is cropped. At 10-14 px/mm a reader
    // starts treating the greyscale as fine detail when it is still a 1 mm AVERAGE, and
    // a cropped picture that does not say so is a picture of somewhere smaller.
    + ` · ${info.cross_sections.slab_mm || 1} mm slab`
    + (() => {
      // The window in MILLIMETRES, not just "cropped": with a zoom the crop is no
      // longer one fixed 36 mm, and a reader has to be able to tell 22 mm of ridge
      // from 44 mm of it or the greyscale is a picture of an unknown extent.
      const c = xsCropRows(info);
      if (!c) return '';
      const f = xsFrame(info);
      return ' · ' + (c.rows * f.rowPitch).toFixed(0) + ' mm of z, at the site';
    })();
  $('xsLabel').textContent = `cross-section ${p.index + 1} of ${info.cross_sections.count}`;
  $('xsSlider').value = p.index;
}

function selectXs(i) {
  const p = planState();
  const info = ((p.arch || {}).jaws || {})[p.jaw];
  if (!info || !info.ok) return;
  p.index = Math.max(0, Math.min(i, info.cross_sections.count - 1));
  const cv = $('xsCanvas');
  // Sequence the loads: the slider and the arrow keys can outrun the network, and a
  // late arrival must not repaint over a newer section while `#xsMeta` names the newer
  // one. Compared by identity, not by index, so a jaw switch counts as a change too.
  const want = xsUrl(p.jaw, p.index);
  p.xsWant = want;
  // The `.catch` below belongs to the LOAD and to nothing else. It used to be chained
  // after the `.then`, so a throw from `planCtx`/`drawImage`/`drawRulers` -- i.e. from
  // the paint -- landed in the load-failure handler and was reported to the user as
  // "this cross-section could not be loaded", then thrown again as an unhandled
  // rejection that no gate watched. Measured: `check-rail` printed ALL PASS with a
  // deliberate throw wired into `drawImplants` at every one of its states. Catching on
  // `loadAuthedImage` itself means a paint bug surfaces AS a paint bug.
  loadAuthedImage(want).catch((e) => {
    if (p.xsWant !== want) return null;
    // Never leave the previous section's pixels under a readout that has already
    // moved on -- that is a picture of one place labelled as another.
    revokeImage(p.xsImage);
    p.xsImage = null;
    const { g, w, h } = planCtx(cv, null);
    g.clearRect(0, 0, w, h);
    $('xsEmpty').hidden = false;
    $('xsEmpty').textContent = 'this cross-section could not be loaded (' + e.message + ')';
    drawRulers('xs');
    return null;
  }).then((img) => {
    if (!img || p.xsWant !== want) { revokeImage(img); return; }
    revokeImage(p.xsImage);
    p.xsImage = img;
    const { g, w, h } = planCtx(cv, img, 1, xsCropRows(info));
    g.drawImage(img, 0, 0, w, h);
    $('xsEmpty').hidden = true;
    drawRulers('xs');
  });
  renderXsMeta(info);
  drawArcMarker();
  renderRulerList();
  renderImplantPanel();
}

