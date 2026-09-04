/* DentistryViewer -- the Cornerstone3D + vtk.js viewport behind the dentistry app.
 *
 * ============================================================================
 * PROVENANCE. This file was TRANSCRIBED from `web/viewer.js` on 2026-09-02,
 * function for function. The `viewer/` tree was destroyed on 2026-09-01 and the
 * built bundle was the only surviving copy; identifiers there are mangled but every
 * function, constant, transfer function, tool binding and error string survived
 * intact, so this is a transcription against a known dependency set rather than a
 * reinvention. The app-authored region is bytes 3,981,451..3,997,975 of that file
 * (16,524 bytes), immediately after the last `@cornerstonejs/tools` statement
 * (`OX.toolName="VideoRedaction";`).
 *
 * The COMMENTS are new. The original prose is gone and inventing it would be
 * inventing history -- the same standard `RECOVERY-2026-09-01.md` sets for itself.
 * What is written here is either recovered behaviour (marked as such) or a reason
 * established by measurement since.
 * ============================================================================
 *
 * Consumed by `web/app.js` through the `window.DentistryViewer` global. The web image
 * has NO build step, so `web/viewer.js` is a committed artifact:
 *
 *     npm --prefix viewer run build:candidate   # -> viewer/dist/viewer.js
 *     npm --prefix viewer run check             # differential test vs the shipped file
 *     npm --prefix viewer run build             # copies over web/viewer.js
 *
 * Dependency versions are PINNED and not chosen: `@cornerstonejs/tools@5.8.2` declares
 * `@cornerstonejs/core@5.8.2`, `@kitware/vtk.js@36.4.1`, `gl-matrix@3.4.3`,
 * `d3-array@3.2.4` and `d3-interpolate@3.0.1` as exact peers, and every one of those
 * has a literal fingerprint in the shipped bundle.
 *
 * Four things in here look wrong and are not. Each cost something to learn:
 *
 *  1. `polySeg` is stubbed to no-ops. Cornerstone 5.8.2's Surface representation does
 *     not render supplied geometry, and worse, `getUpdateFunction` closes over
 *     `polySeg` with no null check, so registration THROWS before `render()`. Surfaces
 *     are therefore plain vtk.js actors (`addSurface`). The stub is also what keeps
 *     `@cornerstonejs/polymorphic-segmentation` and `@icr/polyseg-wasm` out of the
 *     bundle -- two reasons, one object.
 *  2. `renderViewports(mprIds)` fires INSIDE the `if` test, before the
 *     `SEGMENTATION_RENDERED` await. Written the obvious way -- render after the block
 *     -- nothing ever triggers the event, the 4 s timeout always expires, and the 3D
 *     pane starves the segmentation render loop again. It still WORKS, just slowly and
 *     in the wrong order, so no test catches it. See `mount`.
 *  3. There is no Crosshairs, Length, Angle or Probe tool. The MPR volume is an 8-bit
 *     copy downsampled to ~0.66 mm, so a ruler on it would disagree with the server
 *     about the same gap. All measurement lives in the plan tab against server-published
 *     `pixel_mm`.
 *  4. The colour LUT is written and then READ BACK. `colorLUTOrIndex` has to be nested
 *     inside `config`, and passing it at the top level type-checks, does nothing, and
 *     reports no error -- so the only way to know it took is to ask.
 */
import {
  Enums,
  RenderingEngine,
  cache,
  eventTarget,
  geometryLoader,
  imageLoader,
  volumeLoader,
  setVolumesForViewports,
  init as coreInit,
} from '@cornerstonejs/core';
import {
  Enums as csToolsEnums,
  PanTool,
  StackScrollTool,
  ToolGroupManager,
  TrackballRotateTool,
  WindowLevelTool,
  ZoomTool,
  addTool,
  segmentation,
  init as toolsInit,
  version as toolsVersion,
} from '@cornerstonejs/tools';
import vtkCellArray from '@kitware/vtk.js/Common/Core/CellArray';
import vtkPolyData from '@kitware/vtk.js/Common/DataModel/PolyData';
import vtkActor from '@kitware/vtk.js/Rendering/Core/Actor';
import vtkMapper from '@kitware/vtk.js/Rendering/Core/Mapper';

import * as implants from './implants.js';

// `GeometryType` is destructured and never used. It is transcribed anyway: it appears
// exactly once in the whole 4 MB artifact, which makes it provably dead code that the
// minifier still emitted, and removing it changes the output. Do not tidy it while
// `check-bundle.mjs` is comparing against the shipped file.
const { ViewportType, OrientationAxis, GeometryType } = Enums;
const { MouseBindings } = csToolsEnums;
const { SegmentationRepresentations } = csToolsEnums;

const LOADER_SCHEME = 'dentistryLocal';
const MPR_TOOL_GROUP = 'dentistry-mpr';
const TOOL_GROUP_3D = 'dentistry-3d';
const VIEWPORT_3D = 'dent-3d';

/* -------------------------------------------------------------- wheel zoom (3-D)
 * `ZoomTool` is bound to the SECONDARY mouse button, which on a trackpad is a
 * two-finger click-drag -- discoverable by nobody. A two-finger SCROLL is what everyone
 * actually reaches for, and macOS pinch arrives as a wheel event with `ctrlKey` set, so
 * one handler covers both.
 *
 * Driven by `parallelScale` rather than by camera distance, because the 3-D viewport is
 * a PARALLEL projection: moving the camera closer changes nothing at all, and that cost
 * a build cycle to learn once already.
 *
 * Exponential, so a notch is the same proportional step at every zoom level, and the
 * gesture feels the same close in as far out.
 */
const ZOOM_PER_NOTCH = 0.0015;   // per pixel of wheel delta
const ZOOM_MIN_MM = 1.5;         // half-height; below this a 4 mm implant fills the pane
const ZOOM_MAX_MM = 260;         // the whole head and then some

let wheelHost = null;
function onWheelZoom(e) {
  if (!engine) return;
  const viewport = engine.getViewport(VIEWPORT_3D);
  if (!viewport) return;
  // The page must not scroll under the gesture, and macOS pinch must not page-zoom.
  e.preventDefault();
  try {
    const cam = viewport.getCamera();
    if (!cam || !cam.parallelScale) return;
    // A pinch (ctrlKey) reports much larger deltas than a scroll for the same intent.
    const k = e.ctrlKey ? 0.35 : 1;
    const next = cam.parallelScale * Math.exp(e.deltaY * ZOOM_PER_NOTCH * k);
    viewport.setCamera({
      parallelScale: Math.min(ZOOM_MAX_MM, Math.max(ZOOM_MIN_MM, next)),
    });
    if (viewport.resetCameraClippingRange) viewport.resetCameraClippingRange();
    viewport.render();
  } catch (err) {
    console.warn('dentistry: 3-D wheel zoom failed: ' + err.message);
  }
}

function attachWheelZoom(el) {
  if (!el || wheelHost === el) return;
  detachWheelZoom();
  wheelHost = el;
  // NOT passive: the whole point is to preventDefault the page scroll.
  el.addEventListener('wheel', onWheelZoom, { passive: false });
}

function detachWheelZoom() {
  if (!wheelHost) return;
  wheelHost.removeEventListener('wheel', onWheelZoom);
  wheelHost = null;
}
const SEG_RENDERED_TIMEOUT_MS = 4e3;
const FRAME_OF_REFERENCE_UID = 'dentistry-local';

// Per-structure surface opacity in the 3D pane, keyed by `Structure.id`. The jaws are
// translucent because DentalSegmentator's maxilla class is the maxilla AND the upper
// skull: opaque, it is a sealed vault with every tooth hidden inside it. Teeth are
// opaque. Anything not listed here renders opaque, which is why `volume_pack.py`
// omitting `id` from its colour map made the jaws solid and hid the whole dentition.
const SURFACE_OPACITY = {
  maxilla: 0.22,
  mandible: 0.34,
  upper_teeth_unnumbered: 0.75,
  lower_teeth_unnumbered: 0.75,
};

const MPR_VIEWPORTS = [
  { id: 'dent-axial', orientation: OrientationAxis.AXIAL, label: 'Axial' },
  { id: 'dent-coronal', orientation: OrientationAxis.CORONAL, label: 'Coronal' },
  { id: 'dent-sagittal', orientation: OrientationAxis.SAGITTAL, label: 'Sagittal' },
];

let initialised = false;
let engine = null;
let volumeRendered = false;
let state = null;
let mountCounter = 0;

/* ------------------------------------------------------------------ image loader */

/** Serve an image straight out of the Cornerstone cache.
 *
 *  Cornerstone consults the loader registry only on a cache MISS, and then throws
 *  naming the SCHEME rather than the image -- which is why the original bug read as
 *  "No image loader found for scheme 'x'" and told you nothing about what was missing.
 *  Registered both for our scheme and as the unknown-scheme fallback.
 */
function loadLocalImage(imageId) {
  const image = cache.getImage(imageId);
  return image
    ? { promise: Promise.resolve(image) }
    : {
      promise: Promise.reject(new Error(
        `dentistry: ${imageId} is not in the Cornerstone cache; the local volume was `
        + 'never created, or was evicted before the viewport asked for it')),
    };
}

/* ------------------------------------------------------------------- drift guard */

/* Thirteen Cornerstone entry points this file depends on, asserted to still be
 * functions before anything touches them. Two of these moved in the past and each
 * time the failure was silent and downstream: `addColorLUT` is declared at the
 * namespace root in the `.d.ts` but only re-exported under `config.color`, so the wrong
 * path type-checks and then minifies to "x.addColorLUT is not a function"; and
 * `setSegmentIndexVisibility` is a SILENT no-op for a segment index the segmentation
 * was never told about.
 *
 * Two names in this list are guarded and never called -- `createAndCacheGeometry` and
 * `removeSegmentationRepresentations` -- and one that IS called is not guarded
 * (`config.visibility.getHiddenSegmentIndices`, used by `debugState`). The asymmetry is
 * transcribed as found: "fixing" it would change the error string and the bundle's
 * literal set, which is one of the fingerprints the differential test compares.
 */
const API_SURFACE = [
  ['segmentation.addSegmentations', () => segmentation.addSegmentations],
  ['segmentation.addSegmentationRepresentations',
    () => segmentation.addSegmentationRepresentations],
  ['segmentation.removeSegmentation', () => segmentation.removeSegmentation],
  ['segmentation.config.color.addColorLUT', () => segmentation.config.color.addColorLUT],
  ['segmentation.config.color.setColorLUT', () => segmentation.config.color.setColorLUT],
  ['segmentation.config.color.getSegmentIndexColor',
    () => segmentation.config.color.getSegmentIndexColor],
  ['segmentation.config.visibility.setSegmentIndexVisibility',
    () => segmentation.config.visibility.setSegmentIndexVisibility],
  ['segmentation.config.style.setStyle', () => segmentation.config.style.setStyle],
  ['volumeLoader.createLocalVolume', () => volumeLoader.createLocalVolume],
  ['volumeLoader.createLocalLabelmapVolume',
    () => volumeLoader.createLocalLabelmapVolume],
  ['imageLoader.registerImageLoader', () => imageLoader.registerImageLoader],
  ['geometryLoader.createAndCacheGeometry', () => geometryLoader.createAndCacheGeometry],
  ['segmentation.removeSegmentationRepresentations',
    () => segmentation.removeSegmentationRepresentations],
];

function assertCornerstoneApi() {
  const moved = API_SURFACE.filter(([, get]) => {
    try {
      return typeof get() !== 'function';
    } catch {
      return true;
    }
  }).map(([name]) => name);
  if (moved.length) {
    throw new Error(`Cornerstone API moved -- these are not functions in `
      + `@cornerstonejs/tools ${toolsVersion || '?'}: ${moved.join(', ')}`);
  }
}

/* See the module header, point 1. Every method is a no-op that refuses to compute. */
const POLYSEG_STUB = {
  init() {},
  canComputeRequestedRepresentation: () => false,
  computeSurfaceData: async () => null,
  computeLabelmapData: async () => null,
  computeContourData: async () => null,
  extractContourData: async () => null,
  updateSurfaceData: async () => {},
  clipAndCacheSurfacesForViewport: async () => {},
  createAndAddContourSegmentationsFromClippedSurfaces: async () => {},
};

async function ensureInit() {
  if (initialised) return;
  await coreInit();
  await toolsInit({ addons: { polySeg: POLYSEG_STUB } });
  assertCornerstoneApi();
  [PanTool, ZoomTool, StackScrollTool, WindowLevelTool, TrackballRotateTool]
    .forEach(addTool);
  imageLoader.registerImageLoader(LOADER_SCHEME, loadLocalImage);
  // Process-wide, and it stays that way: this makes the dentistry loader the fallback
  // for EVERY unrecognised scheme, which is fine here because nothing else on the page
  // uses Cornerstone, and hostile to any second consumer that ever does.
  imageLoader.registerUnknownImageLoader(loadLocalImage);
  initialised = true;
}

/** Resolve on the first `SEGMENTATION_RENDERED`, or after `ms`, whichever comes first.
 *
 *  The timeout is a fallback, not the mechanism -- see the module header, point 2. If
 *  the render is never triggered this still resolves, so a mount that takes the full
 *  4 s is the signal that the ordering has been broken.
 */
function awaitSegmentationRendered(ms = SEG_RENDERED_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let done = false;
    const fire = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        eventTarget.removeEventListener(csToolsEnums.Events.SEGMENTATION_RENDERED, fire);
      } catch { /* the listener was never attached */ }
      resolve();
    };
    const timer = setTimeout(fire, ms);
    try {
      eventTarget.addEventListener(csToolsEnums.Events.SEGMENTATION_RENDERED, fire);
    } catch {
      fire();
    }
  });
}

/* --------------------------------------------------------------------- metadata */

/** A dense RGBA colour LUT indexed by segment number.
 *
 *  Sized from `max(index)`, so `volume_pack.py` shipping only the structures actually
 *  PRESENT is load-bearing: listing all 47 on a scan carrying 12 makes Cornerstone
 *  allocate and register 35 segments that can never be drawn.
 */
function buildColorLut(colors, maxIndex) {
  const lut = [];
  for (let i = 0; i <= maxIndex; i++) lut.push([0, 0, 0, 0]);
  Object.entries(colors).forEach(([index, meta]) => {
    const rgb = parseInt(meta.color.slice(1), 16);
    lut[Number(index)] = [(rgb >> 16) & 255, (rgb >> 8) & 255, rgb & 255, 255];
  });
  return lut;
}

/** Synthesised DICOM metadata for the local volume.
 *
 *  The browser copy is 8-bit and already windowed by `worker/volume_pack.py`, so the
 *  VOI is a fixed 0..255 ramp and NOT a CT preset keyed to Hounsfield units -- a stock
 *  preset would be wrong for these values. `PixelSpacing` is `[spacing[1], spacing[0]]`:
 *  DICOM orders it row-then-column, which is the opposite of the volume's `[x, y, z]`.
 */
function volumeMetadata(meta) {
  const [columns, rows] = meta.dimensions;
  return {
    BitsAllocated: 8,
    BitsStored: 8,
    SamplesPerPixel: 1,
    HighBit: 7,
    PhotometricInterpretation: 'MONOCHROME2',
    PixelRepresentation: 0,
    Modality: 'CT',
    ImageOrientationPatient: meta.direction.slice(0, 6),
    PixelSpacing: [meta.spacing[1], meta.spacing[0]],
    FrameOfReferenceUID: FRAME_OF_REFERENCE_UID,
    Columns: columns,
    Rows: rows,
    voiLut: [{ windowWidth: 255, windowCenter: 128 }],
  };
}

/* -------------------------------------------------------------------- centroids */

/** A representative LPS point per label, computed in the browser from the labelmap.
 *
 *  Two passes on purpose. The first takes each label's mean voxel; the second finds the
 *  voxel OF THAT LABEL nearest to it. The mean of a horseshoe-shaped jaw lands in the
 *  middle of the mouth -- outside the structure -- and a centroid that is not inside the
 *  thing it names cannot be used to jump a slice onto it.
 */
export function centroidsFromLabelmap(labels, meta) {
  const [nx, ny, nz] = meta.dimensions;
  const [sx, sy, sz] = meta.spacing;
  const origin = meta.origin;
  const direction = meta.direction;

  const sums = new Map();
  let i = 0;
  for (let z = 0; z < nz; z++) {
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++, i++) {
        const v = labels[i];
        if (!v) continue;
        let acc = sums.get(v);
        if (!acc) {
          acc = [0, 0, 0, 0];
          sums.set(v, acc);
        }
        acc[0] += x;
        acc[1] += y;
        acc[2] += z;
        acc[3]++;
      }
    }
  }

  const nearest = new Map();
  i = 0;
  for (let z = 0; z < nz; z++) {
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++, i++) {
        const v = labels[i];
        if (!v) continue;
        const acc = sums.get(v);
        const dx = (x - acc[0] / acc[3]) * sx;
        const dy = (y - acc[1] / acc[3]) * sy;
        const dz = (z - acc[2] / acc[3]) * sz;
        const d2 = dx * dx + dy * dy + dz * dz;
        const best = nearest.get(v);
        if (!best || d2 < best[3]) nearest.set(v, [x, y, z, d2]);
      }
    }
  }

  const toLps = (x, y, z) => {
    const a = x * sx;
    const b = y * sy;
    const c = z * sz;
    return [
      origin[0] + direction[0] * a + direction[1] * b + direction[2] * c,
      origin[1] + direction[3] * a + direction[4] * b + direction[5] * c,
      origin[2] + direction[6] * a + direction[7] * b + direction[8] * c,
    ];
  };

  const out = {};
  sums.forEach((acc, label) => {
    const n = nearest.get(label);
    out[label] = n
      ? toLps(n[0], n[1], n[2])
      : toLps(acc[0] / acc[3], acc[1] / acc[3], acc[2] / acc[3]);
  });
  return out;
}

/** `{index: [r, g, b]}` from the served hex colours, for the vtk.js surface actors. */
function rgbFromColors(colors) {
  const out = {};
  Object.entries(colors).forEach(([index, meta]) => {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(meta.color || ''));
    if (!m) return;
    const v = parseInt(m[1], 16);
    out[Number(index)] = [(v >> 16) & 255, (v >> 8) & 255, v & 255];
  });
  return out;
}

/** The mean of the TOOTH centroids: where the 3D camera aims from.
 *
 *  Teeth rather than all structures, because the jaws include the upper skull and their
 *  centroid is somewhere in the middle of the head. Depends on `colors[i].id` -- which
 *  `worker/volume_pack.py` omitted, making this null and the framing fall back to a
 *  fixed direction.
 */
function archCentreFromTeeth(centroids, colors) {
  const teeth = Object.entries(centroids)
    .filter(([index]) => /^tooth_/.test((colors[index] || {}).id || ''))
    .map(([, point]) => point);
  if (!teeth.length) return null;
  return [0, 1, 2].map((k) => teeth.reduce((sum, p) => sum + p[k], 0) / teeth.length);
}

/* ------------------------------------------------------------------------ mount */

export async function mount(elements, meta, imageBuffer, labelBuffer, element3d) {
  await ensureInit();
  await unmount();

  const n = ++mountCounter;
  const volumeId = `${LOADER_SCHEME}:image${n}`;
  const segVolumeId = `${LOADER_SCHEME}:seg${n}`;
  const segId = `dentistrySegmentation:${n}`;

  const dimensions = meta.dimensions;
  const spacing = meta.spacing;
  const origin = meta.origin;
  const direction = meta.direction;
  const voxels = dimensions[0] * dimensions[1] * dimensions[2];
  // Both buffers are uint8, so byte length IS voxel count. A mismatch here means the
  // manifest and the raw files disagree, and every downstream symptom of that looks
  // like a rendering bug rather than a packaging one.
  if (imageBuffer.byteLength !== voxels || labelBuffer.byteLength !== voxels) {
    throw new Error(`volume size mismatch: meta says ${voxels} voxels, got image `
      + `${imageBuffer.byteLength} and labels ${labelBuffer.byteLength}`);
  }

  const metadata = volumeMetadata(meta);
  volumeLoader.createLocalVolume(volumeId, {
    metadata, dimensions, spacing, origin, direction,
    scalarData: new Uint8Array(imageBuffer),
  });
  // NOTE the argument order: `createLocalVolume(id, options)` but
  // `createLocalLabelmapVolume(options, id)`. It is reversed between the two, and
  // getting it wrong fails in a way that looks like a bad buffer.
  volumeLoader.createLocalLabelmapVolume({
    metadata, dimensions, spacing, origin, direction,
    scalarData: new Uint8Array(labelBuffer),
    referencedVolumeId: volumeId,
  }, segVolumeId);

  engine = engine || new RenderingEngine('dentistry-engine');

  const inputs = MPR_VIEWPORTS.map((v, i) => ({
    viewportId: v.id,
    type: ViewportType.ORTHOGRAPHIC,
    element: elements[i],
    defaultOptions: { orientation: v.orientation, background: [0, 0, 0] },
  }));
  const want3d = !!element3d;
  engine.setViewports(inputs);
  const mprIds = MPR_VIEWPORTS.map((v) => v.id);
  await setVolumesForViewports(engine, [{ volumeId }], mprIds);

  const maxIndex = Math.max(...Object.keys(meta.colors || {}).map(Number), 1);
  const lutIndex = segmentation.config.color.addColorLUT(
    buildColorLut(meta.colors || {}, maxIndex));

  // EVERY index is declared. `setSegmentIndexVisibility` is a silent no-op for an index
  // the segmentation was never told about, and Cornerstone auto-registers only some --
  // so "hide all" once hid about half the structures with no error at all. Worst case a
  // clinician reads a structure as absent when it is merely unregistered.
  const segments = {};
  Object.entries(meta.colors || {}).forEach(([index, m]) => {
    segments[Number(index)] = { label: m.name, active: false, locked: false };
  });
  segmentation.addSegmentations([{
    segmentationId: segId,
    representation: { type: SegmentationRepresentations.Labelmap, data: { volumeId: segVolumeId } },
    config: {
      label: 'Dentistry structures',
      segments,
      segmentOrder: Object.keys(segments).map(Number).sort((a, b) => a - b),
    },
  }]);

  mprIds.forEach((id) => {
    // `colorLUTOrIndex` must be nested inside `config`. At the top level it
    // type-checks, silently does nothing, and every structure renders in
    // Cornerstone's generic palette -- so the rail and the MPR disagree about colour.
    segmentation.addSegmentationRepresentations(id, [{
      segmentationId: segId,
      type: SegmentationRepresentations.Labelmap,
      config: { colorLUTOrIndex: lutIndex },
    }]);
    try {
      segmentation.config.color.setColorLUT(id, segId, lutIndex);
    } catch (e) {
      console.warn(`dentistry: setColorLUT failed on ${id}: ${e.message}`);
    }
  });

  // Read the palette BACK. See the module header, point 4.
  const lutCheck = { ok: true, checked: 0, mismatches: [] };
  Object.entries(meta.colors || {}).forEach(([index, m]) => {
    const want = m.color.slice(1).match(/../g).map((h) => parseInt(h, 16));
    let got = null;
    try {
      got = segmentation.config.color.getSegmentIndexColor(mprIds[0], segId, Number(index));
    } catch { /* an unregistered index; the mismatch below records it */ }
    lutCheck.checked++;
    if (!got || got[0] !== want[0] || got[1] !== want[1] || got[2] !== want[2]) {
      lutCheck.ok = false;
      if (lutCheck.mismatches.length < 5) {
        lutCheck.mismatches.push({ index: Number(index), id: m.id, want, got: got && [...got] });
      }
    }
  });
  if (!lutCheck.ok) {
    console.error(`dentistry: the segmentation colour LUT did not take effect — `
      + `${lutCheck.mismatches.length}+ of ${lutCheck.checked} segments are the wrong `
      + `colour`, lutCheck.mismatches);
  }

  segmentation.config.style.setStyle({ type: SegmentationRepresentations.Labelmap }, {
    renderOutline: true,
    outlineWidth: 2,
    outlineOpacity: 1,
    renderFill: true,
    fillAlpha: 0.45,
    renderOutlineInactive: true,
    outlineWidthInactive: 2,
    fillAlphaInactive: 0.45,
  });

  /* The 3D volume transfer function, hand-built.
   *
   * The browser volume is 8-bit and already windowed, so a stock CT preset keyed to
   * Hounsfield units is meaningless on it. These control points are the recovered
   * ones: nothing below 110 is visible, bone comes up through 165 and 215, and the
   * RGB ramp is a warm bone tone rather than the blue-white of a generic preset.
   */
  const applyTransferFunction = () => {
    try {
      const viewport = engine.getViewport(VIEWPORT_3D);
      const defaultActor = viewport && viewport.getDefaultActor && viewport.getDefaultActor();
      const actor = defaultActor && defaultActor.actor;
      const property = actor && actor.getProperty && actor.getProperty();
      if (!property) return;
      const opacity = property.getScalarOpacity(0);
      opacity.removeAllPoints();
      opacity.addPoint(0, 0);
      opacity.addPoint(110, 0);
      opacity.addPoint(165, 0.12);
      opacity.addPoint(215, 0.55);
      opacity.addPoint(255, 0.9);
      const rgb = property.getRGBTransferFunction(0);
      rgb.removeAllPoints();
      rgb.addRGBPoint(110, 0.3, 0.24, 0.2);
      rgb.addRGBPoint(180, 0.78, 0.7, 0.6);
      rgb.addRGBPoint(255, 1, 0.98, 0.94);
      property.setShade(true);
      property.setAmbient(0.32);
      property.setDiffuse(0.78);
      property.setSpecular(0.18);
      property.setInterpolationTypeToLinear();
      volumeRendered = true;
    } catch (e) {
      console.warn('dentistry: 3D volume rendering unavailable: ' + e.message);
    }
  };

  let mprGroup = ToolGroupManager.getToolGroup(MPR_TOOL_GROUP);
  if (!mprGroup) {
    mprGroup = ToolGroupManager.createToolGroup(MPR_TOOL_GROUP);
    [PanTool, ZoomTool, StackScrollTool, WindowLevelTool]
      .forEach((t) => mprGroup.addTool(t.toolName));
    mprGroup.setToolActive(WindowLevelTool.toolName,
      { bindings: [{ mouseButton: MouseBindings.Primary }] });
    mprGroup.setToolActive(PanTool.toolName,
      { bindings: [{ mouseButton: MouseBindings.Auxiliary }] });
    mprGroup.setToolActive(ZoomTool.toolName,
      { bindings: [{ mouseButton: MouseBindings.Secondary }] });
    mprGroup.setToolActive(StackScrollTool.toolName,
      { bindings: [{ mouseButton: MouseBindings.Wheel }] });
  }
  mprIds.forEach((id) => mprGroup.addViewport(id, engine.id));

  const allIds = want3d ? [...mprIds, VIEWPORT_3D] : mprIds;

  // The render fires INSIDE the `if` test, and it has to. See the module header,
  // point 2: with `VOLUME_3D` in the engine from the start, only the axial pane drew
  // its labelmap for about a minute. Three camera-based fixes failed; enabling the 3D
  // element only after the slice views have rendered their segmentation is what worked.
  if ((engine.renderViewports(mprIds), want3d)) {
    await awaitSegmentationRendered();
    engine.enableElement({
      viewportId: VIEWPORT_3D,
      type: ViewportType.VOLUME_3D,
      element: element3d,
      defaultOptions: { background: [0.04, 0.055, 0.075] },
    });
    await setVolumesForViewports(engine, [{ volumeId }], [VIEWPORT_3D]);
    applyTransferFunction();

    let group3d = ToolGroupManager.getToolGroup(TOOL_GROUP_3D);
    if (!group3d) {
      group3d = ToolGroupManager.createToolGroup(TOOL_GROUP_3D);
      [TrackballRotateTool, ZoomTool, PanTool].forEach((t) => group3d.addTool(t.toolName));
      group3d.setToolActive(TrackballRotateTool.toolName,
        { bindings: [{ mouseButton: MouseBindings.Primary }] });
      group3d.setToolActive(PanTool.toolName,
        { bindings: [{ mouseButton: MouseBindings.Auxiliary }] });
      group3d.setToolActive(ZoomTool.toolName,
        { bindings: [{ mouseButton: MouseBindings.Secondary }] });
    }
    group3d.addViewport(VIEWPORT_3D, engine.id);
    attachWheelZoom(element3d);
    const viewport3d = engine.getViewport(VIEWPORT_3D);
    if (viewport3d) {
      try {
        viewport3d.resetCamera();
      } catch { /* no actors yet; surfacesReady() frames it properly later */ }
    }
    engine.renderViewports(allIds);
  }

  const centroids = centroidsFromLabelmap(new Uint8Array(labelBuffer), meta);
  state = {
    volumeId,
    segVolumeId,
    segId,
    lutIndex,
    viewportIds: mprIds,
    allIds,
    centroids,
    lutCheck,
    surfaces: new Map(),
    hidden3d: new Set(),
    // A plan-tab narrowing, never the user's own hiding. See `surfaceShouldShow`.
    focus3d: null,
    // Per-structure opacity OVERRIDES, held apart from `SURFACE_OPACITY` so a view
    // preference never rewrites the catalogue value. See `setSurfaceOpacity`.
    opacity3d: new Map(),
    mode3d: 'surfaces',
    rgb: rgbFromColors(meta.colors || {}),
    ids: Object.fromEntries(
      Object.entries(meta.colors || {}).map(([index, m]) => [Number(index), m.id])),
    archCentre: archCentreFromTeeth(centroids, meta.colors || {}),
  };
  implants.attach({ engine, viewportId: VIEWPORT_3D, isMounted: () => !!state });
  return {
    viewportIds: mprIds,
    allIds,
    volumeRendered,
    centroids,
    archCentre: state.archCentre,
    labels: Object.keys(meta.colors || {}).map(Number),
  };
}

/* ------------------------------------------------------------------- visibility */

/** Show or hide one structure everywhere: all three MPR panes and the 3D surface.
 *
 *  Keyed by structure INDEX, never by colour. A colour->index lookup returns only the
 *  first match, and the two `*_teeth_unnumbered` classes once shared one grey -- so
 *  hiding by colour hid the wrong things and looked right because the slice overlay
 *  filters by RGB.
 *
 *  A state change with no render leaves the previous frame on screen, which is why the
 *  render at the end is not optional.
 */
/** THE one place that decides whether a 3-D surface actor is drawn.
 *
 *  Three conditions, and all three had their own copy: `hidden3d` (the user's global
 *  choice, shared with the MPR panes and the slice overlay), `mode3d` (surfaces vs
 *  volume-rendered bone) and now `focus3d` (a plan-tab NARROWING). Refactored into one
 *  function in the same change that introduced the third, because two of three sites
 *  updated would leave a path that ignores the focus and shows a tooth that should be
 *  hidden -- which looks like a Cornerstone bug and is not one.
 *
 *  `focus3d` can only ever narrow: a structure must be in it AND not hidden. A view
 *  preference must never be able to reveal something the user switched off.
 */
function surfaceShouldShow(index) {
  if (!state) return false;
  const i = Number(index);
  if (state.hidden3d.has(i)) return false;
  if (state.mode3d === 'bone') return false;
  if (state.focus3d && !state.focus3d.has(i)) return false;
  return true;
}

function applySurfaceVisibility() {
  if (!state) return;
  state.surfaces.forEach((surface, index) => {
    surface.actor.setVisibility(surfaceShouldShow(index));
  });
}

/** Narrow what the 3-D pane draws, without touching what the user has hidden.
 *
 *  The plan tab draws all 42 surfaces and 1.95 M triangles, so a molar implant sits
 *  behind two tooth roots and the jaw. Passing a set here shows only those; passing
 *  `null` restores the user's own choice exactly. NEVER writes `hidden3d`, so leaving
 *  the plan tab cannot have changed what the Slices tab shows.
 */
export function setSurfaceFocus(indices) {
  if (!state) return false;
  state.focus3d = indices ? new Set([...indices].map(Number)) : null;
  applySurfaceVisibility();
  if (engine) engine.renderViewports([VIEWPORT_3D]);
  return true;
}

/** Override one surface's opacity, or restore its catalogue value with `null`.
 *
 *  `SURFACE_OPACITY` is applied once at add time and there was no way to change it
 *  afterwards. The plan tab needs one: an implant sits INSIDE bone, and at the mandible's
 *  0.34 the jaw reads solid at implant zoom -- measured, the pane showed bone and a
 *  green envelope and no implant. This is a VIEW override, held separately from the
 *  catalogue value so leaving the plan tab restores exactly what the other tabs show.
 */
export function setSurfaceOpacity(index, opacity) {
  if (!state) return false;
  const i = Number(index);
  state.opacity3d = state.opacity3d || new Map();
  if (opacity == null) state.opacity3d.delete(i);
  else state.opacity3d.set(i, Number(opacity));
  const surface = state.surfaces.get(i);
  if (surface) {
    surface.actor.getProperty().setOpacity(
      state.opacity3d.has(i) ? state.opacity3d.get(i)
        : (SURFACE_OPACITY[(state.ids || {})[i]] ?? 1));
  }
  if (engine) engine.renderViewports([VIEWPORT_3D]);
  return true;
}

export function setStructureVisible(index, visible) {
  if (!state) return;
  state.viewportIds.forEach((id) => {
    segmentation.config.visibility.setSegmentIndexVisibility(
      id,
      { segmentationId: state.segId, type: SegmentationRepresentations.Labelmap },
      Number(index),
      !!visible);
  });
  const i = Number(index);
  if (visible) state.hidden3d.delete(i);
  else state.hidden3d.add(i);
  const surface = state.surfaces.get(i);
  if (surface) {
    surface.hidden = !visible;
    surface.actor.setVisibility(surfaceShouldShow(i));
  }
  if (engine) engine.renderViewports(state.allIds || state.viewportIds);
}

/* ----------------------------------------------------------------------- meshes */

/** Parse the custom `DSVM` browser mesh format written by `worker/meshes.py`.
 *
 *  Not STL: STL is 50 bytes per triangle with the normal repeated and no shared
 *  vertices. This is `'DSVM'` + uint32 version + uint32 nPoints + uint32 nTris, then
 *  the points as float32 LPS millimetres and the triangles as uint32 indices. The
 *  exact byte-length assertion is what catches a truncated fetch, which otherwise
 *  renders as a partial mesh that looks like a segmentation error.
 *
 *  vtk.js wants its cell array with an explicit vertex count per cell, so the three
 *  indices per triangle are expanded to `[3, a, b, c]` here.
 */
function parseWebMesh(buffer) {
  const view = new DataView(buffer);
  const magic = String.fromCharCode(
    view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
  if (magic !== 'DSVM') {
    throw new Error(`not a dentistry mesh (magic ${JSON.stringify(magic)})`);
  }
  const version = view.getUint32(4, true);
  if (version !== 1) {
    throw new Error(`mesh format version ${version} is newer than this viewer`);
  }
  const nPoints = view.getUint32(8, true);
  const nTris = view.getUint32(12, true);
  const expected = 16 + nPoints * 12 + nTris * 12;
  if (buffer.byteLength !== expected) {
    throw new Error(`mesh is ${buffer.byteLength} bytes, header says ${expected}`);
  }
  const points = new Float32Array(buffer.slice(16, 16 + nPoints * 12));
  const tris = new Uint32Array(buffer.slice(16 + nPoints * 12));
  const cells = new Uint32Array(nTris * 4);
  for (let t = 0, c = 0, s = 0; t < nTris; t++) {
    cells[c++] = 3;
    cells[c++] = tris[s++];
    cells[c++] = tris[s++];
    cells[c++] = tris[s++];
  }
  return { points, cells, nPoints, nTris };
}

/** Add one anatomy surface to the 3D pane as a plain vtk.js actor.
 *
 *  NOT Cornerstone's Surface representation, which in 5.8.2 does not render supplied
 *  geometry and fails silently at three separate points -- 36 geometries cached, 0
 *  actors, no warning. Plain actors also SHOW UP in `viewport.getActors()`, so
 *  "0 actors" becomes detectable instead of invisible.
 *
 *  Memoised: anatomy is immutable and streams once, so re-adding an index is a no-op.
 *  Implants are the opposite -- mutable, dragged, few -- and live in their own registry
 *  (`./implants.js`) with real update and remove.
 */
export function addSurface(index, buffer) {
  if (!state || !(state.allIds || []).includes(VIEWPORT_3D)) return null;
  const viewport = engine && engine.getViewport(VIEWPORT_3D);
  if (!viewport) return null;
  const i = Number(index);
  if (state.surfaces.has(i)) return state.surfaces.get(i).nTris;

  const { points, cells, nTris } = parseWebMesh(buffer);
  const rgb = state.rgb[i] || [200, 200, 200];

  const polyData = vtkPolyData.newInstance();
  polyData.getPoints().setData(points, 3);
  polyData.setPolys(vtkCellArray.newInstance({ values: cells }));

  const mapper = vtkMapper.newInstance();
  mapper.setInputData(polyData);
  const actor = vtkActor.newInstance();
  actor.setMapper(mapper);

  const property = actor.getProperty();
  property.setColor(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255);
  property.setAmbient(0.22);
  property.setDiffuse(0.82);
  property.setSpecular(0.22);
  property.setSpecularPower(28);
  property.setOpacity((state.opacity3d && state.opacity3d.has(i))
    ? state.opacity3d.get(i)
    : (SURFACE_OPACITY[(state.ids || {})[i]] ?? 1));

  const hidden = state.hidden3d.has(i);
  state.surfaces.set(i, { actor, mapper, nTris, hidden });
  actor.setVisibility(surfaceShouldShow(i));
  viewport.addActor({ uid: `dent-surface-${i}`, actor });
  return nTris;
}

/** Frame the 3D pane on the whole arch once the surfaces have streamed in.
 *
 *  `resetCamera` on a VOLUME_3D viewport frames the VOLUME, not the visible actors --
 *  the same distance whether one tooth or 34 structures are showing -- so the camera is
 *  then aimed at the tooth-centroid mean by hand. The view direction is fixed:
 *  slightly below and in front, looking up at the arch.
 */
export function surfacesReady() {
  if (!state || !engine) return 0;
  const viewport = engine.getViewport(VIEWPORT_3D);
  if (!viewport) return 0;
  try {
    viewport.resetCamera();
    const camera = viewport.getCamera();
    const focalPoint = state.archCentre || camera.focalPoint;
    const distance = Math.hypot(
      camera.position[0] - camera.focalPoint[0],
      camera.position[1] - camera.focalPoint[1],
      camera.position[2] - camera.focalPoint[2]) || 300;
    const dir = [0, -0.92, 0.39];
    viewport.setCamera({
      focalPoint,
      position: [
        focalPoint[0] + dir[0] * distance,
        focalPoint[1] + dir[1] * distance,
        focalPoint[2] + dir[2] * distance,
      ],
      viewUp: [0, 0, 1],
    });
    if (viewport.resetCameraClippingRange) viewport.resetCameraClippingRange();
  } catch (e) {
    console.warn('dentistry: 3D framing failed: ' + e.message);
  }
  engine.renderViewports(state.allIds || state.viewportIds);
  return state.surfaces.size;
}

/** `'surfaces'` shows the meshes, `'bone'` shows the volume rendering. */
export function set3dMode(mode) {
  if (!state || !engine) return;
  state.mode3d = mode;
  const viewport = engine.getViewport(VIEWPORT_3D);
  if (!viewport) return;
  // Implants are deliberately NOT swept by this: seeing the implant inside
  // volume-rendered bone is the single most useful view in the pane, and hiding it
  // with the anatomy would be consistency at the cost of the feature.
  applySurfaceVisibility();
  try {
    const defaultActor = viewport.getDefaultActor && viewport.getDefaultActor();
    if (defaultActor && defaultActor.actor && defaultActor.actor.setVisibility) {
      defaultActor.actor.setVisibility(mode !== 'surfaces');
    }
  } catch (e) {
    console.warn('dentistry: could not toggle the 3D volume actor: ' + e.message);
  }
  engine.renderViewports(state.allIds || state.viewportIds);
}

/** Aim the 3D camera at one structure, from outside the arch.
 *
 *  The VOLUME_3D camera is PARALLEL projection, so moving it closer changes nothing --
 *  `parallelScale` is the only knob that zooms, and that cost a build cycle to learn.
 *  The radial direction comes from the arch centre so the view is always from the
 *  buccal side rather than through the opposing arch.
 */
export function focusStructure(centroid, opts) {
  if (!state || !engine || !centroid) return false;
  const viewport = engine.getViewport(VIEWPORT_3D);
  if (!viewport) return false;
  const target = [Number(centroid[0]), Number(centroid[1]), Number(centroid[2])];
  if (target.some((v) => !Number.isFinite(v))) return false;

  const archCentre = (opts && opts.archCentre) || state.archCentre;
  const upper = !!(opts && opts.upper);
  let distance = (opts && opts.distance) || 95;
  let parallelScale = null;

  const surface = state.surfaces.get(Number((opts && opts.index) ?? -1));
  if (surface) {
    try {
      // The mesh's OWN bounds, because resetCamera would frame the volume instead.
      const b = surface.mapper.getInputData().getBounds();
      const radius = 0.5 * Math.hypot(b[1] - b[0], b[3] - b[2], b[5] - b[4]);
      if (radius > 0.5) {
        parallelScale = radius / 0.62;
        distance = Math.max(18, radius / (Math.tan(Math.PI / 12) * 0.62));
      }
    } catch { /* no input data yet */ }
  }

  let radial = archCentre
    ? [target[0] - archCentre[0], target[1] - archCentre[1], 0]
    : [0, -1, 0];
  let len = Math.hypot(radial[0], radial[1]);
  if (!(len > 0.001)) {
    radial = [0, -1, 0];
    len = 1;
  }
  radial = [radial[0] / len, radial[1] / len, 0];

  const z = upper ? 0.36 : -0.36;
  const dir = [radial[0], radial[1], z];
  const norm = Math.hypot(dir[0], dir[1], dir[2]);
  try {
    viewport.setCamera({
      focalPoint: target,
      position: [
        target[0] + (dir[0] / norm) * distance,
        target[1] + (dir[1] / norm) * distance,
        target[2] + (dir[2] / norm) * distance,
      ],
      viewUp: [0, 0, 1],
      ...(parallelScale ? { parallelScale } : {}),
    });
    if (viewport.resetCameraClippingRange) viewport.resetCameraClippingRange();
    viewport.render();
  } catch (e) {
    console.warn('dentistry: 3D focus failed: ' + e.message);
    return false;
  }
  return true;
}

/** Move all three MPR panes onto one patient point.
 *
 *  The camera's signed distance along its own `viewPlaneNormal` is preserved, so the
 *  zoom level survives the jump. Renders twice -- immediately and on the next macrotask
 *  -- because a single render can land before Cornerstone has recomputed the slice.
 *
 *  Never `await requestAnimationFrame` anywhere near this: rAF does not fire in a
 *  background tab, and doing so once deadlocked `mount()` there permanently.
 */
export function jumpTo(point) {
  if (!state || !engine || !point) return false;
  const target = [Number(point[0]), Number(point[1]), Number(point[2])];
  if (target.some((v) => !Number.isFinite(v))) return false;

  state.viewportIds.forEach((id) => {
    const viewport = engine.getViewport(id);
    if (!viewport) return;
    try {
      const camera = viewport.getCamera();
      const normal = camera.viewPlaneNormal;
      const signed = camera.position && normal
        ? (camera.position[0] - camera.focalPoint[0]) * normal[0]
          + (camera.position[1] - camera.focalPoint[1]) * normal[1]
          + (camera.position[2] - camera.focalPoint[2]) * normal[2]
        : 0;
      viewport.setCamera({
        focalPoint: target,
        position: [
          target[0] + normal[0] * signed,
          target[1] + normal[1] * signed,
          target[2] + normal[2] * signed,
        ],
      });
      viewport.render();
    } catch (e) {
      console.warn(`dentistry: jump failed on ${id}: ${e.message}`);
    }
  });
  engine.renderViewports(state.allIds || state.viewportIds);
  setTimeout(() => {
    if (!engine || !state) return;
    try {
      engine.renderViewports(state.allIds || state.viewportIds);
    } catch { /* unmounted between the two renders */ }
  }, 0);
  return true;
}

/* -------------------------------------------------------------------- debugging */

/** Everything the viewer believes about its own state, for the differential test.
 *
 *  This is the oracle `viewer/check-bundle.mjs` compares the rebuilt bundle against
 *  the shipped one with, so it deliberately reports read-BACK values -- `lut.ok`,
 *  `colorsMatchPalette`, actor visibility -- rather than what the code intended.
 *  A state vector made of intentions would agree with itself and prove nothing.
 */
export function debugState() {
  if (!state) return null;

  const hiddenPerViewport = {};
  state.viewportIds.forEach((id) => {
    try {
      hiddenPerViewport[id] = [...segmentation.config.visibility.getHiddenSegmentIndices(
        id, { segmentationId: state.segId, type: SegmentationRepresentations.Labelmap })];
    } catch (e) {
      hiddenPerViewport[id] = 'error: ' + e.message;
    }
  });

  const out = {
    segId: state.segId,
    hiddenPerViewport,
    volumeRendered,
    centroids: state.centroids ? Object.keys(state.centroids).length : 0,
    lut: state.lutCheck || null,
    viewports: state.viewportIds.map((id) => {
      const viewport = engine && engine.getViewport(id);
      if (!viewport) return { id, missing: true };
      let actors = [];
      try {
        actors = viewport.getActors().map((a) => ({
          uid: a.uid,
          // Clipping planes live on the MAPPER, not the actor, which is why a shared
          // mapper across viewports with different slabs would fight over them.
          planes: (a.actor && a.actor.getMapper && a.actor.getMapper().getClippingPlanes
            && a.actor.getMapper().getClippingPlanes().length) ?? null,
          visible: a.actor && a.actor.getVisibility ? a.actor.getVisibility() : null,
        }));
      } catch (e) {
        actors = [{ error: e.message }];
      }
      let slice = null;
      try {
        slice = viewport.getSliceIndex ? viewport.getSliceIndex() : null;
      } catch { /* not a stack viewport */ }
      let cam = null;
      try {
        const c = viewport.getCamera();
        cam = {
          focal: c.focalPoint.map((v) => +v.toFixed(1)),
          scale: +(c.parallelScale || 0).toFixed(1),
        };
      } catch { /* no camera yet */ }
      return { id, slice, cam, actors };
    }),
  };

  if (engine) {
    try {
      const viewport = engine.getViewport(VIEWPORT_3D);
      out.volumeActors = viewport ? (viewport.getActors() || []).length : 'no viewport';
    } catch (e) {
      out.volumeActors = 'error: ' + e.message;
    }
  }

  out.surfaces = {
    mode: state.mode3d,
    added: state.surfaces.size,
    triangles: [...state.surfaces.values()].reduce((sum, s) => sum + s.nTris, 0),
    hidden: [...state.hidden3d],
    onViewport: typeof out.volumeActors === 'number'
      ? out.volumeActors - state.surfaces.size
      : out.volumeActors,
    colorsMatchPalette: [...state.surfaces.entries()].every(([index, surface]) => {
      const want = state.rgb[index];
      if (!want) return false;
      const got = surface.actor.getProperty().getColor().map((v) => Math.round(v * 255));
      return want.every((v, k) => Math.abs(v - got[k]) <= 1);
    }),
  };

  if (engine) {
    try {
      const viewport = engine.getViewport(VIEWPORT_3D);
      const c = viewport && viewport.getCamera();
      out.camera3d = c ? {
        focal: c.focalPoint.map((v) => +v.toFixed(1)),
        position: c.position.map((v) => +v.toFixed(1)),
        viewUp: c.viewUp.map((v) => +v.toFixed(2)),
        parallel: !!c.parallelProjection,
        parallelScale: +(c.parallelScale || 0).toFixed(1),
        distance: +Math.hypot(
          c.position[0] - c.focalPoint[0],
          c.position[1] - c.focalPoint[1],
          c.position[2] - c.focalPoint[2]).toFixed(1),
      } : 'no viewport';
    } catch (e) {
      out.camera3d = 'error: ' + e.message;
    }
  }

  out.implants = implants.debug();
  return out;
}

/* ----------------------------------------------------------------------- styles */

/** Labelmap fill and outline, live.
 *
 *  `setStyle` costs over 800 ms per change -- it re-renders the whole labelmap one
 *  animation frame at a time -- so never drive this from a slider's `input` event
 *  without debouncing it.
 */
export function setOverlayStyle(fill, outline) {
  if (!state) return;
  const width = Math.max(0, Math.round(Number(outline) || 0));
  const alpha = Math.min(1, Math.max(0, Number(fill) || 0));
  segmentation.config.style.setStyle({ type: SegmentationRepresentations.Labelmap }, {
    renderFill: alpha > 0,
    fillAlpha: alpha,
    fillAlphaInactive: alpha,
    renderOutline: width > 0,
    renderOutlineInactive: width > 0,
    outlineWidth: width,
    outlineWidthInactive: width,
    outlineOpacity: width > 0 ? 1 : 0,
    outlineOpacityInactive: width > 0 ? 1 : 0,
  });
  if (engine) engine.renderViewports(state.allIds || state.viewportIds);
}

/** Re-measure the canvases after a layout change.
 *
 *  Nothing called `RenderingEngine.resize` for a while, and the symptom was not a
 *  stretched image but MIS-AIMED CLICKS: the canvas kept its old size over the new box,
 *  so a click landed at the wrong voxel. Any pane focus, rail collapse or tab switch
 *  has to call this.
 */
export function resize() {
  if (!engine) return false;
  try {
    engine.resize(true, false);
    if (state) engine.renderViewports(state.allIds || state.viewportIds);
  } catch (e) {
    console.warn('dentistry: resize failed: ' + e.message);
    return false;
  }
  return true;
}

export function resetCameras() {
  if (!engine || !state) return;
  state.viewportIds.forEach((id) => {
    const viewport = engine.getViewport(id);
    if (viewport) viewport.resetCamera();
  });
  if ((state.allIds || []).includes(VIEWPORT_3D)) {
    const viewport = engine.getViewport(VIEWPORT_3D);
    if (viewport) {
      try {
        viewport.resetCamera();
      } catch { /* no actors */ }
    }
  }
  engine.renderViewports(state.allIds || state.viewportIds);
}

export async function unmount() {
  if (!state) return;
  detachWheelZoom();
  try {
    if (segmentation.removeAllSegmentationRepresentations) {
      state.viewportIds.forEach((id) => segmentation.removeAllSegmentationRepresentations(id));
    }
  } catch { /* nothing registered */ }
  try {
    segmentation.removeSegmentation(state.segId);
  } catch { /* already gone */ }

  if (engine && state.surfaces.size) {
    const viewport = engine.getViewport(VIEWPORT_3D);
    state.surfaces.forEach((surface, index) => {
      try {
        if (viewport) viewport.removeActors([`dent-surface-${index}`]);
      } catch { /* the viewport went first */ }
      try {
        surface.mapper.delete();
        surface.actor.delete();
      } catch { /* already deleted */ }
    });
    state.surfaces.clear();
  }
  // Implants have their own registry and must be torn down with the rest, or their
  // actors survive into the next case.
  implants.teardown();

  [state.volumeId, state.segVolumeId].forEach((id) => {
    try {
      cache.removeVolumeLoadObject(id);
    } catch { /* never cached */ }
  });
  if (engine) {
    try {
      engine.setViewports([]);
    } catch { /* already torn down */ }
  }
  volumeRendered = false;
  state = null;
}

/* ------------------------------------------------------------------- public API */

export const parseWebMeshForTest = parseWebMesh;
export const planes = MPR_VIEWPORTS.map((v) => ({ id: v.id, label: v.label }));
export const viewport3dId = VIEWPORT_3D;

// A bundle revision counter, NOT a Cornerstone version. 5 was the shipped value; 6 adds
// the implant API below.
export const version = '6';

export const {
  setImplantArch,
  setImplants,
  updateImplant,
  setImplantVerdict,
  removeImplant,
  focusImplant,
  implantGeometryForTest,
} = implants;
