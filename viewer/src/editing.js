/* Editing the segmentation mask, and telling the server exactly what changed.
 *
 * The contours in this product are drawn by a network, and the numbers the implant tab
 * publishes are distances to those contours. So a specialist who can see that the canal
 * roof is a voxel too low has to be able to move it -- and every clearance, every
 * available-bone height and every verdict has to be recomputed from the moved contour,
 * or the edit is a drawing exercise.
 *
 * FOUR FACTS THAT SHAPE ALL OF THIS.
 *
 * 1. **What you edit here is the DISPLAY volume, and it is downsampled.**
 *    `worker/volume_pack.py` ships the browser an 8-bit copy whose longest axis is at
 *    most 256 -- on a dental CBCT that is 0.6 mm voxels against the 0.3 mm grid every
 *    server-side millimetre is measured on. An edit therefore carries a boundary
 *    quantisation of one display voxel, which on a real case is the same order as the
 *    model's own inward error (0.46 mm p95 on the inferior alveolar canal). That is not
 *    a reason to refuse the feature; it is the reason the diff carries its grid and the
 *    server adds the quantisation to the error budget of every structure an edit
 *    touched. A hand-drawn contour is not automatically a more accurate one.
 *
 * 2. **Undo is Cornerstone's, not ours.** 5.8.2 records an RLE memo per stroke through
 *    `LabelmapBaseTool.createMemo` and pushes it to `DefaultHistoryMemo` on mouse-up.
 *    Reimplementing that on top of a full-volume diff would have meant scanning 5.7
 *    million voxels per stroke, and it would have been a second history that disagreed
 *    with the tools' own.
 *
 * 3. **The diff is computed from a BASELINE, not from the memos.** The memo ring is
 *    capped and it is a stack of deltas; what the server needs is "the state now versus
 *    the state the worker produced", which is one comparison against a copy of the
 *    labelmap taken at mount. 5.7 MB of Uint8, once per case.
 *
 * 4. **Only touched slices are scanned.** `SEGMENTATION_DATA_MODIFIED` carries the k
 *    indices the tools wrote to, so the diff scans those planes and no others -- a few
 *    hundred kilobytes of work per stroke instead of the whole volume.
 *
 * What this module deliberately does NOT do is redraw the 3-D surfaces or the
 * cross-sections. Those are server artifacts built from the full-resolution grid, and
 * making the browser approximate them would put two different pictures of the same
 * anatomy on screen with no way to tell which one the numbers came from. Until the edit
 * is applied and the case re-derived, the MPR panes show the edit and everything else
 * says it is showing the unedited segmentation.
 */
import { cache, eventTarget, utilities as csUtils } from '@cornerstonejs/core';
import {
  BrushTool,
  CircleScissorsTool,
  Enums as csToolsEnums,
  PaintFillTool,
  RectangleScissorsTool,
  SphereScissorsTool,
  ToolGroupManager,
  segmentation,
  utilities as csToolsUtils,
} from '@cornerstonejs/tools';

const { MouseBindings } = csToolsEnums;
const { Events: ToolEvents } = csToolsEnums;

/** The editing tools, and the strategy each one runs.
 *
 *  `sphere` variants write through the slab rather than on one plane, which is what a
 *  three-dimensional structure needs: correcting a canal roof on one axial slice and
 *  leaving the two either side is a step, not a correction. `circle` variants are the
 *  ones for detail work on a single plane.
 */
export const EDIT_TOOLS = {
  brush: { tool: BrushTool, strategy: 'FILL_INSIDE_CIRCLE',
           label: 'brush', hint: 'Paint the selected structure on this plane.' },
  erase: { tool: BrushTool, strategy: 'ERASE_INSIDE_CIRCLE',
           label: 'erase', hint: 'Remove the selected structure on this plane.' },
  brush3d: { tool: BrushTool, strategy: 'FILL_INSIDE_SPHERE',
             label: 'brush 3-D', hint: 'Paint through the slab, not just this plane.' },
  erase3d: { tool: BrushTool, strategy: 'ERASE_INSIDE_SPHERE',
             label: 'erase 3-D', hint: 'Remove through the slab, not just this plane.' },
  circle: { tool: CircleScissorsTool, strategy: 'FILL_INSIDE',
            label: 'circle', hint: 'Fill a circle you drag out.' },
  rect: { tool: RectangleScissorsTool, strategy: 'FILL_INSIDE',
          label: 'rectangle', hint: 'Fill a rectangle you drag out.' },
  sphere: { tool: SphereScissorsTool, strategy: 'FILL_INSIDE',
            label: 'sphere', hint: 'Fill a sphere you drag out, through the slab.' },
  fill: { tool: PaintFillTool, strategy: '',
          label: 'flood fill', hint: 'Fill the connected region you click in.' },
};

/** Brush radius in MILLIMETRES -- `brushSize` is a world-space radius, and Cornerstone's
 *  own default of 25 is a 5 cm brush. 2 mm is about a canal's diameter. */
export const BRUSH_MM = { min: 0.3, max: 8, step: 0.1, default: 2.0 };

let host = null;      // { engine, toolGroupId, segId, segVolumeId, viewportIds, meta }
let baseline = null;  // Uint8Array, the worker's labelmap as shipped
let touched = null;   // Set<number> of modified k indices
let activeTool = null;
let activeSegment = 0;
let listener = null;
let restore = null;   // what to put back on the primary button when editing stops

/** The Cornerstone editing surface, asserted before anything is bound.
 *
 *  Same discipline as `assertCornerstoneApi` next door and for the same reason: a
 *  renamed helper here fails at the first brush stroke, in a browser, on a real case,
 *  and looks like a rendering bug. Better to refuse at mount with the name in the
 *  message. */
const EDIT_API = [
  ['segmentation.segmentIndex.setActiveSegmentIndex',
    () => segmentation.segmentIndex && segmentation.segmentIndex.setActiveSegmentIndex],
  ['segmentation.activeSegmentation.setActiveSegmentation',
    () => segmentation.activeSegmentation
      && segmentation.activeSegmentation.setActiveSegmentation],
  ['utilities.segmentation.setBrushSizeForToolGroup',
    () => csToolsUtils.segmentation && csToolsUtils.segmentation.setBrushSizeForToolGroup],
  ['utilities.HistoryMemo.DefaultHistoryMemo',
    () => csUtils.HistoryMemo && csUtils.HistoryMemo.DefaultHistoryMemo],
  ['triggerSegmentationDataModified',
    () => segmentation.triggerSegmentationEvents
      && segmentation.triggerSegmentationEvents.triggerSegmentationDataModified],
];

export function assertEditApi() {
  const missing = EDIT_API.filter(([, get]) => {
    try { return !get(); } catch { return true; }
  }).map(([n]) => n);
  if (missing.length) {
    throw new Error('Cornerstone editing API moved — missing: ' + missing.join(', '));
  }
  return EDIT_API.length;
}

/** The tools to register once, at init. Exported so `ensureInit` can add them to the
 *  single `addTool` list rather than keeping a second registration path. */
export const EDIT_TOOL_CLASSES = [BrushTool, CircleScissorsTool, RectangleScissorsTool,
                                  SphereScissorsTool, PaintFillTool];

export function attach(h, labelBuffer) {
  detach();
  assertEditApi();
  host = h;
  // A COPY, not a view: `createLocalLabelmapVolume` was handed `new Uint8Array(buffer)`
  // and Cornerstone mutates that one in place. A view over the same bytes would be the
  // edited state comparing itself to the edited state, and every diff would be empty.
  baseline = new Uint8Array(labelBuffer.slice(0));
  touched = new Set();
  activeTool = null;
  activeSegment = 0;
  listener = (evt) => {
    const d = (evt && evt.detail) || {};
    if (!host || d.segmentationId !== host.segId) return;
    const slices = d.modifiedSlicesToUse;
    if (Array.isArray(slices) && slices.length) slices.forEach((k) => touched.add(Number(k)));
    // No slice list means the writer did not say. Widening to the whole volume is the
    // only safe answer -- a diff that misses a plane silently ships a partial edit --
    // and it costs one full scan rather than a wrong result.
    else touched.add(-1);
  };
  eventTarget.addEventListener(ToolEvents.SEGMENTATION_DATA_MODIFIED, listener);
  return true;
}

export function detach() {
  if (listener) {
    eventTarget.removeEventListener(ToolEvents.SEGMENTATION_DATA_MODIFIED, listener);
  }
  listener = null;
  host = null;
  baseline = null;
  touched = null;
  activeTool = null;
  restore = null;
  return true;
}

function group() {
  return host ? ToolGroupManager.getToolGroup(host.toolGroupId) : null;
}

/** The LIVE labelmap array, and the voxel manager that owns it.
 *
 *  `getScalarData()` on a scalar-volume manager returns the array itself, which is what
 *  a diff has to read: `getCompleteScalarDataArray()` can be a cached EXPANSION, and a
 *  diff computed against a copy would compare the edited state to a snapshot of the
 *  edited state and always come back empty. Writes go through `setAtIndex`, which is
 *  what maintains the manager's own `modifiedSlices` and its dirty bounds. */
function labelmap() {
  if (!host) return null;
  const vol = cache.getVolume(host.segVolumeId);
  if (!vol) return null;
  const vm = vol.voxelManager;
  if (vm && vm.getScalarData) {
    try { return vm.getScalarData(); } catch { /* no scalar data on this manager */ }
  }
  if (vm && vm.getCompleteScalarDataArray) return vm.getCompleteScalarDataArray();
  return (vol.getScalarData && vol.getScalarData()) || null;
}

function voxels() {
  if (!host) return null;
  const vol = cache.getVolume(host.segVolumeId);
  return (vol && vol.voxelManager) || null;
}

/* --------------------------------------------------------------------- the tools */

/** Turn one editing tool on, or `null` to hand the primary button back.
 *
 *  The primary mouse button belongs to `WindowLevelTool` in the MPR group, and taking it
 *  without giving it back leaves a viewer that can never adjust its own window again.
 *  So the previous binding is remembered and restored, rather than assumed.
 */
export function setEditTool(name) {
  const g = group();
  if (!g) return false;
  const spec = name ? EDIT_TOOLS[name] : null;
  if (name && !spec) throw new Error(`unknown editing tool ${name}`);

  Object.keys(EDIT_TOOLS).forEach((k) => {
    try { g.setToolPassive(EDIT_TOOLS[k].tool.toolName); } catch { /* not added */ }
  });
  if (!spec) {
    if (restore) {
      try {
        g.setToolActive(restore, { bindings: [{ mouseButton: MouseBindings.Primary }] });
      } catch { /* the tool went away with the mount */ }
      restore = null;
    }
    activeTool = null;
    return true;
  }
  if (!restore) {
    // Remember what we are displacing, and READ it rather than assume it. It is
    // `WindowLevelTool` by construction, but this file must not encode the other file's
    // binding table -- `getActivePrimaryMouseButtonTool` is Cornerstone's own answer to
    // the same question.
    restore = (g.getActivePrimaryMouseButtonTool
      ? g.getActivePrimaryMouseButtonTool() : null) || null;
  }
  // ...and take the button OFF it. `setToolActive` MERGES bindings -- it does
  // `[...prevBindings, ...newBindings]` and de-duplicates -- so activating a brush on
  // the primary button while window/level still holds it leaves TWO tools claiming it,
  // and which one wins is whichever `getActivePrimaryMouseButtonTool` happens to find
  // first in an object's key order. Passive first, then active.
  if (restore) {
    try { g.setToolPassive(restore); } catch { /* already gone */ }
  }
  const tn = spec.tool.toolName;
  if (spec.strategy) {
    const inst = g.getToolInstance(tn);
    if (inst) inst.configuration.activeStrategy = spec.strategy;
  }
  g.setToolActive(tn, { bindings: [{ mouseButton: MouseBindings.Primary }] });
  activeTool = name;
  return true;
}

export function editTool() {
  return activeTool;
}

/** Which structure the tools write. 0 is a valid choice and means "erase to background".
 *
 *  Set on the segmentation AND made the active segmentation of every MPR viewport: the
 *  strategies read their operation data from the viewport's active segmentation, so
 *  setting only the index paints into whichever segmentation Cornerstone happened to
 *  consider active -- which, with one segmentation, works by luck. */
export function setEditSegment(index) {
  if (!host) return false;
  activeSegment = Number(index) || 0;
  (host.viewportIds || []).forEach((id) => {
    try { segmentation.activeSegmentation.setActiveSegmentation(id, host.segId); }
    catch { /* not represented in this viewport */ }
  });
  segmentation.segmentIndex.setActiveSegmentIndex(host.segId, activeSegment);
  return true;
}

export function editSegment() {
  return activeSegment;
}

export function setBrushMm(mm) {
  if (!host) return false;
  const v = Math.max(BRUSH_MM.min, Math.min(BRUSH_MM.max, Number(mm) || BRUSH_MM.default));
  csToolsUtils.segmentation.setBrushSizeForToolGroup(host.toolGroupId, v);
  return v;
}

export function brushMm() {
  if (!host) return null;
  return csToolsUtils.segmentation.getBrushSizeForToolGroup(host.toolGroupId);
}

/* ------------------------------------------------------------------ undo and redo */
export function editUndo() {
  const h = csUtils.HistoryMemo.DefaultHistoryMemo;
  if (!h.canUndo) return false;
  h.undo();
  return true;
}

export function editRedo() {
  const h = csUtils.HistoryMemo.DefaultHistoryMemo;
  if (!h.canRedo) return false;
  h.redo();
  return true;
}

export function editHistory() {
  const h = csUtils.HistoryMemo.DefaultHistoryMemo;
  return { canUndo: !!h.canUndo, canRedo: !!h.canRedo };
}

/* -------------------------------------------------------------------- the diff */

/** Which k planes to scan. `-1` in the touched set means "a writer did not say", and
 *  then every plane is scanned. */
function planes() {
  const dims = host.meta.dimensions;
  if (!touched || touched.has(-1)) {
    return Array.from({ length: dims[2] }, (_, k) => k);
  }
  return [...touched].filter((k) => k >= 0 && k < dims[2]).sort((a, b) => a - b);
}

/** The grid the diff is expressed on, so the server never has to guess at it.
 *
 *  `downsample_factor` is the load-bearing field: the server upsamples each display
 *  voxel to the `f x f x f` block of the full-resolution grid it was sampled from, and
 *  the resulting boundary quantisation is what gets added to the error budget of every
 *  structure this edit touched. A diff without it could be applied at the wrong scale
 *  and every voxel would land somewhere plausible and wrong.
 */
function gridBlock() {
  const m = host.meta;
  return {
    dimensions: m.dimensions.slice(),
    spacing: m.spacing.slice(),
    origin: (m.origin || []).slice(),
    direction: (m.direction || []).slice(),
    downsample_factor: Number(m.downsample_factor) || 1,
  };
}

/** Run-length encode the CHANGED voxels of the touched planes.
 *
 *  `[offset, length, value]` per run, where `offset = j * X + i` inside the plane and
 *  `value` is the new label. Runs rather than points because a brush stroke is
 *  contiguous along x by construction, and a 2 mm brush on a 0.6 mm grid is 7 voxels
 *  across: points would be seven objects where a run is one.
 */
export function editDiff() {
  if (!host || !baseline) return null;
  const cur = labelmap();
  if (!cur) return null;
  const [X, Y] = host.meta.dimensions;
  const plane = X * Y;
  const out = [];
  let voxels = 0;
  const structures = new Map();     // index -> {added, removed}
  planes().forEach((k) => {
    const base = k * plane;
    let runs = null;
    let o = 0;
    while (o < plane) {
      if (cur[base + o] === baseline[base + o]) { o += 1; continue; }
      const v = cur[base + o];
      let n = 1;
      while (o + n < plane && cur[base + o + n] !== baseline[base + o + n]
             && cur[base + o + n] === v) n += 1;
      for (let q = 0; q < n; q += 1) {
        const was = baseline[base + o + q];
        if (was) {
          const rec = structures.get(was) || { added: 0, removed: 0 };
          rec.removed += 1; structures.set(was, rec);
        }
        if (v) {
          const rec = structures.get(v) || { added: 0, removed: 0 };
          rec.added += 1; structures.set(v, rec);
        }
      }
      (runs = runs || []).push([o, n, v]);
      voxels += n;
      o += n;
    }
    if (runs) out.push({ k, runs });
  });
  return {
    voxels,
    slices: out,
    structures: Object.fromEntries([...structures].map(([i, r]) => [i, r])),
    grid: gridBlock(),
  };
}

/** Counts only, for the panel: the same scan as `editDiff` without keeping the runs. */
export function editStats() {
  const d = editDiff();
  if (!d) return null;
  const sp = (host.meta.spacing || [1, 1, 1]).reduce((a, b) => a * Number(b), 1);
  return { voxels: d.voxels, slices: d.slices.length, structures: d.structures,
           mm3: d.voxels * sp };
}

/** Put every touched voxel back to what the worker produced.
 *
 *  Not an undo -- undo walks the tools' own memo ring and can only reach as far as the
 *  ring is long. This is "discard my edits", which has to be reachable however many
 *  strokes ago they started. */
export function resetEdits() {
  if (!host || !baseline) return false;
  const cur = labelmap();
  const vm = voxels();
  if (!cur) return false;
  const [X, Y] = host.meta.dimensions;
  const plane = X * Y;
  const ks = planes();
  let n = 0;
  ks.forEach((k) => {
    const base = k * plane;
    for (let o = 0; o < plane; o += 1) {
      if (cur[base + o] === baseline[base + o]) continue;
      // Through the voxel manager, so its own dirty bounds and modified-slice set come
      // back into line with the array. Writing the typed array directly would leave
      // Cornerstone believing a plane is still dirty that has just been restored.
      if (vm && vm.setAtIndex) vm.setAtIndex(base + o, baseline[base + o]);
      else cur[base + o] = baseline[base + o];
      n += 1;
    }
  });
  segmentation.triggerSegmentationEvents.triggerSegmentationDataModified(host.segId, ks);
  touched.clear();
  return n;
}

/** TEST-ONLY: write a known pattern into the labelmap, and say exactly what it wrote.
 *
 *  Named `...ForTest` like `implantGeometryForTest` and `parseWebMeshForTest`, and
 *  nothing in the app calls it. It exists because the DIFF ENCODER is the one piece of
 *  this module a wrong answer would travel through silently: the server upsamples every
 *  run onto the measurement grid, and a run at the wrong offset paints a stripe across
 *  the far side of the head. A brush stroke in a headless browser cannot produce a
 *  KNOWN voxel count; this can, and `viewer/check-equivalence.mjs` compares the two.
 *
 *  It goes through `setAtIndex` and fires the real `SEGMENTATION_DATA_MODIFIED` event,
 *  so the touched-plane bookkeeping is exercised too rather than bypassed. */
export function editWriteForTest(value = 3) {
  if (!host) return null;
  const cur = labelmap();
  const vm = voxels();
  if (!cur || !vm || !vm.setAtIndex) return null;
  const [X, Y, Z] = host.meta.dimensions.map(Number);
  const plane = X * Y;
  const k0 = Math.floor(Z / 2);
  const k1 = Math.min(Z - 1, k0 + 1);
  // Two runs on one plane with a gap between them, and one on the next plane: enough
  // to catch a run-length encoder that merges across a gap or loses a plane.
  const spec = [[k0, 5 * X + 7, 37], [k0, 5 * X + 60, 4], [k1, 9 * X + 11, 6]];
  const wrote = [];
  spec.forEach(([k, o, n]) => {
    let hit = 0;
    for (let q = 0; q < n; q += 1) {
      const idx = k * plane + o + q;
      if (cur[idx] === value) continue;          // already this label; not a change
      vm.setAtIndex(idx, value);
      hit += 1;
    }
    wrote.push({ k, offset: o, requested: n, changed: hit });
  });
  segmentation.triggerSegmentationEvents.triggerSegmentationDataModified(
    host.segId, [k0, k1]);
  return { value, dimensions: [X, Y, Z], planes: [k0, k1], wrote,
           changed: wrote.reduce((a, w) => a + w.changed, 0) };
}

/** Adopt the current state as the new baseline. Called after the server has accepted an
 *  edit, so the next diff is "what changed since the last apply" rather than a re-send
 *  of everything. */
export function commitBaseline() {
  if (!host) return false;
  const cur = labelmap();
  if (!cur) return false;
  baseline = new Uint8Array(cur);
  touched.clear();
  return true;
}

/** Read-back for the checks, in the same style as `debugState`. */
export function editDebug() {
  if (!host) return null;
  const st = editStats();
  return {
    attached: true,
    tool: activeTool,
    segment: activeSegment,
    brushMm: brushMm(),
    touchedPlanes: touched ? (touched.has(-1) ? 'all' : touched.size) : 0,
    history: editHistory(),
    voxels: st ? st.voxels : 0,
    structures: st ? st.structures : {},
  };
}
