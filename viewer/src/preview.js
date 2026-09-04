/* A real segmented dentition in 3-D, for the model picker.
 *
 * ## What this used to be, and why it changed
 *
 * It used to be a SCHEMATIC: an arch swept from a parametric curve with ellipsoid teeth
 * on it, and a caption that had to admit it was "not a segmentation, and not your scan".
 * The argument for that was honest and worth restating, because it has not gone away:
 * the picker sits on the upload page, where there is no scan and no case, so drawing
 * somebody else's anatomy risks a reader taking those shapes for what the model will
 * draw on theirs.
 *
 * What changed is the answer to it, not the argument. This product's whole claim is the
 * segmentation; illustrating that claim with a drawing is arguing it with a prop. The
 * honest version shows a REAL segmentation and names it -- and the case it shows is one
 * already published in the app as an example, from a public research dataset, held out
 * of training. A reader can go and open it. That is a stronger guarantee than a
 * disclaimer under a diagram, and the caption in `web/index.html` carries the naming.
 *
 * Baked by `scripts/export_case_meshes.py` into `assets/preview/`: one merged DSVM mesh
 * per picker GROUP -- six, not forty-seven -- because the picker's question is which
 * structures a model is authoritative for, and its answer is per group. ~725 KB gzipped
 * for the set, which every visitor to the upload page pays before sign-in; the ceiling
 * is asserted in the baker rather than hoped for here.
 *
 * A group the source case does not contain ships as `present: false` with no file
 * (`restorations`, on the current dentition -- it has no bridge, crown or implant).
 * Declared rather than hidden, so hovering a model that owns it can SAY so instead of
 * ghosting the whole scene and highlighting nothing, which reads as a broken hover.
 * Borrowing that group from a second patient was the alternative, and it would put two
 * people's anatomy in one picture -- exactly the thing the caption could then not
 * honestly say.
 *
 * Standalone, not the case viewer. `mount()` needs a volume, a labelmap and a
 * Cornerstone rendering engine; this needs none of those and must work before sign-in.
 * So it drives a `vtkGenericRenderWindow` directly.
 *
 * The palette is its own, and stays its own. `web/app.js` and `implants.js` share a
 * verdict palette and a check asserts they agree; this one is deliberately not in that
 * relationship. These are FAMILY colours for a diagram about groups -- the catalogue's
 * per-structure colours would paint the dentition in quadrant hues, which is data the
 * picker is not showing and a question it is not asking.
 */
import vtkActor from '@kitware/vtk.js/Rendering/Core/Actor';
import vtkCellArray from '@kitware/vtk.js/Common/Core/CellArray';
import vtkGenericRenderWindow from '@kitware/vtk.js/Rendering/Misc/GenericRenderWindow';
import vtkMapper from '@kitware/vtk.js/Rendering/Core/Mapper';
import vtkPolyData from '@kitware/vtk.js/Common/DataModel/PolyData';

import { parseWebMesh } from './mesh.js';

/** Where the baked bundle lives, relative to the page. Resolved against the document so
 *  the same build serves `dentistry.dicomsegvr.com/app/` and the `/dentistry/` path. */
const ASSET_DIR = 'assets/preview/';

const GROUP_RGB = {
  jaws: [214, 205, 186],
  teeth: [246, 246, 241],
  canals: [232, 122, 108],
  sinuses: [126, 176, 222],
  airway: [150, 190, 170],
  restorations: [176, 182, 196],
};

/* A BASE opacity per group, and the reason is the canals.
 *
 * Every group at 1 draws an opaque jaw with the nerve canals sealed inside it, so the
 * one structure a reader most wants to locate is the one they cannot see -- the same
 * mistake the case viewer made until the jaws were given `.22`/`.34`. The bone is
 * see-through, the sinuses and the airway are cavities and read as such, and the teeth,
 * the canals and the restorations are solid because they are the things being pointed
 * at. `highlightGroups` ghosts to GHOST_OPACITY and restores to THESE rather than to 1,
 * so a highlight cannot make the diagram less readable than it was.
 *
 * The jaw number is lower than the schematic's 0.72 and that is a consequence of the
 * change, not a preference: a real mandible and maxilla are a closed shell around the
 * whole dentition, where the drawn arch was an open band. At 0.72 a real jaw hides
 * everything inside it and the picker becomes a picture of bone. */
const GROUP_OPACITY = {
  jaws: 0.30,
  teeth: 1,
  canals: 1,
  sinuses: 0.45,
  airway: 0.32,
  restorations: 1,
};
const GHOST_OPACITY = 0.14;

/* Groups excluded from the CAMERA FRAMING, not from the picture. The pharynx is a
 * column that runs from the nasal cavity to below the larynx -- on the source case it is
 * two and a half times the height of the dentition -- so a camera framed to include it
 * makes the thing this picture is about small and off-centre. It is still drawn, still
 * highlightable, and still ghosted like everything else. */
const FRAME_EXCLUDE = ['airway'];

/* --------------------------------------------------------------------- public API */
let scene = null;
/** The baked manifest, once fetched. Cached across mounts: the SPA shows and hides this
 *  page rather than reloading it, and re-fetching six meshes on every visit would make a
 *  tab switch cost what a cold load costs. */
let bundle = null;

async function loadBundle(base) {
  if (bundle) return bundle;
  const root = new URL(ASSET_DIR, base).href;
  const manifest = await fetch(new URL('manifest.json', root).href).then((r) => {
    if (!r.ok) throw new Error(`manifest ${r.status}`);
    return r.json();
  });
  const groups = {};
  await Promise.all(Object.entries(manifest.groups || {})
    .filter(([, g]) => g.present && g.file)
    .map(async ([key, g]) => {
      const buf = await fetch(new URL(g.file, root).href).then((r) => {
        if (!r.ok) throw new Error(`${g.file} ${r.status}`);
        return r.arrayBuffer();
      });
      groups[key] = parseWebMesh(buf);
    }));
  bundle = { manifest, groups };
  return bundle;
}

/** Mount the dentition into `el`. Resolves to the group keys it drew, or null.
 *
 *  ASYNC, where the schematic was synchronous -- it builds nothing now and fetches six
 *  meshes instead. Callers await it; `web/app.js::mountModelSchematic` is the only one.
 *
 *  Idempotent by teardown: mounting twice disposes the first, because the picker is on a
 *  page the SPA shows and hides rather than reloads, and a leaked WebGL context per
 *  visit is the kind of thing that works for a week and then stops.
 */
export async function mountModelPreview(el, baseUrl) {
  if (!el) return null;
  disposeModelPreview();

  let loaded;
  try {
    loaded = await loadBundle(baseUrl || document.baseURI);
  } catch (e) {
    // A missing bundle costs the reader a picture and nothing else. Named, because a
    // silently empty pane is indistinguishable from a WebGL failure and they need
    // different fixes.
    console.warn('dentistry: the model preview bundle did not load: ' + e.message);
    return null;
  }
  if (!Object.keys(loaded.groups).length) {
    console.warn('dentistry: the model preview bundle declares no present groups');
    return null;
  }

  let grw;
  try {
    grw = vtkGenericRenderWindow.newInstance({ background: [0.05, 0.07, 0.1] });
    grw.setContainer(el);
  } catch (e) {
    console.warn('dentistry: the model preview needs WebGL: ' + e.message);
    return null;
  }
  const renderer = grw.getRenderer();
  const actors = {};
  Object.entries(loaded.groups).forEach(([key, mesh]) => {
    const poly = vtkPolyData.newInstance();
    poly.getPoints().setData(mesh.points, 3);
    poly.setPolys(vtkCellArray.newInstance({ values: mesh.cells }));
    const mapper = vtkMapper.newInstance();
    mapper.setInputData(poly);
    const actor = vtkActor.newInstance();
    actor.setMapper(mapper);
    const rgb = GROUP_RGB[key] || [200, 200, 200];
    actor.getProperty().setColor(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255);
    actor.getProperty().setAmbient(0.28);
    actor.getProperty().setDiffuse(0.72);
    actor.getProperty().setSpecular(0.18);
    actor.getProperty().setOpacity(GROUP_OPACITY[key] != null ? GROUP_OPACITY[key] : 1);
    renderer.addActor(actor);
    actors[key] = actor;
  });

  // Frame the scene FIRST, then turn the camera without moving it closer or further.
  //
  // `resetCamera` picks both the focal point (the bounds centre) and the distance that
  // frames them; overriding the position with a literal throws the second away, and on a
  // perspective camera that is the framing. So the direction is replaced and the
  // distance `resetCamera` chose is kept.
  //
  // The vertices are patient LPS millimetres, so `viewUp` is +z = superior and the
  // direction below is from the patient's front right and above -- the angle every
  // dental diagram is drawn from. Elevation matters more than azimuth: too flat and the
  // two arches stack into a barrel and the horseshoe disappears, which is the one thing
  // this picture has to show.
  //
  // FRAMED ON THE DENTITION, not on everything. This was the schematic's one free lunch:
  // its bounds WERE the arch. A real case's bounds are dominated by the pharynx, which
  // runs far down the neck, so `resetCamera` over all of it put the arch in the middle
  // third of the pane and a constant zoom then cropped the mandible off the side rather
  // than centring it. Hiding the tall actors for the reset and restoring them after
  // frames the thing the picture is of, at whatever aspect the pane happens to have.
  const tall = FRAME_EXCLUDE.map((k) => actors[k]).filter(Boolean);
  tall.forEach((a) => a.setVisibility(false));
  renderer.resetCamera();
  tall.forEach((a) => a.setVisibility(true));
  const cam = renderer.getActiveCamera();
  const f = cam.getFocalPoint();
  const d = cam.getDistance();
  const dir = norm([-0.42, -0.60, 0.68]);
  cam.setPosition(f[0] + dir[0] * d, f[1] + dir[1] * d, f[2] + dir[2] * d);
  cam.setViewUp(0, 0, 1);
  // A little air, so the arch does not touch the pane's edges as it turns.
  cam.zoom(0.92);
  // AFTER the actors are visible again, or the airway clips out of the far plane the
  // moment the turntable brings it round.
  renderer.resetCameraClippingRange();
  grw.resize();
  scene = { grw, renderer, actors, el, raf: 0, manifest: loaded.manifest };
  highlightGroups(null);
  return Object.keys(actors);
}

/** Bring one model's groups forward and ghost the rest. `null` shows everything.
 *
 *  The ghost is GHOST_OPACITY rather than hidden: which structures a model does NOT own
 *  is half of the answer, and a scene that empties out when you hover a canal model
 *  tells you nothing about where those canals are.
 *
 *  Keys naming a group this case does not contain are ignored rather than treated as a
 *  miss -- see the header. `missing` in the return value is what lets the caller say so.
 */
export function highlightGroups(keys) {
  if (!scene) return false;
  const want = keys && keys.length ? new Set(keys) : null;
  Object.keys(scene.actors).forEach((key) => {
    const p = scene.actors[key].getProperty();
    const on = !want || want.has(key);
    const base = GROUP_OPACITY[key] != null ? GROUP_OPACITY[key] : 1;
    p.setOpacity(on ? base : GHOST_OPACITY);
    p.setAmbient(on ? 0.28 : 0.5);
  });
  scene.grw.getRenderWindow().render();
  return true;
}

/** Which of `keys` the mounted case does not contain. Empty when it contains them all. */
export function missingGroups(keys) {
  if (!scene || !keys) return [];
  return keys.filter((k) => !scene.actors[k]);
}

/** How the caption should name what is on screen. Null before the bundle lands. */
export function previewSource() {
  if (!scene || !scene.manifest) return null;
  const m = scene.manifest;
  return { title: m.title || '', attribution: m.attribution || '',
           job: m.source_job || '', absent: m.absent_groups || [] };
}

/** Resize to the container. The SPA changes this pane's width on every breakpoint. */
export function resizeModelPreview() {
  if (!scene) return false;
  scene.grw.resize();
  scene.grw.getRenderWindow().render();
  return true;
}

/** Slowly rotate, so the shape reads as a shape. Stops itself when disposed. */
export function spinModelPreview(on) {
  if (!scene) return false;
  if (scene.raf) { cancelAnimationFrame(scene.raf); scene.raf = 0; }
  if (!on) return true;
  const step = () => {
    if (!scene) return;
    scene.renderer.getActiveCamera().azimuth(0.25);
    scene.renderer.resetCameraClippingRange();
    scene.grw.getRenderWindow().render();
    scene.raf = requestAnimationFrame(step);
  };
  scene.raf = requestAnimationFrame(step);
  return true;
}

export function disposeModelPreview() {
  if (!scene) return false;
  if (scene.raf) cancelAnimationFrame(scene.raf);
  try {
    Object.values(scene.actors).forEach((a) => {
      scene.renderer.removeActor(a);
      a.delete();
    });
    scene.grw.delete();
  } catch { /* already gone */ }
  scene = null;
  return true;
}

/** Read-back for the checks, in the same style as `debugState`. */
export function previewDebug() {
  if (!scene) return null;
  const out = {};
  Object.keys(scene.actors).forEach((k) => {
    const m = scene.actors[k].getMapper().getInputData();
    out[k] = { points: m.getPoints().getNumberOfPoints(),
               opacity: Number(scene.actors[k].getProperty().getOpacity().toFixed(3)) };
  });
  return { groups: out, spinning: !!scene.raf,
           source: scene.manifest ? (scene.manifest.source_job || '') : '',
           absent: (scene.manifest && scene.manifest.absent_groups) || [] };
}

function norm(v) {
  const n = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / n, v[1] / n, v[2] / n];
}
