/* A schematic dentition in 3-D, for the model picker.
 *
 * WHY IT IS SCHEMATIC, and why that is the honest choice. The picker is on the upload
 * page: there is no scan, no segmentation and no case, so there is nothing real to draw.
 * The alternative -- rendering a published example case's meshes -- would put a picture
 * of somebody's actual anatomy behind a question about YOUR upload, and a reader would
 * reasonably take the shapes for what this model will draw on their scan. So every
 * surface here is generated from a parametric curve, it says so on the pane, and no
 * number is printed on it. What it communicates is exactly one thing: WHICH STRUCTURES
 * a model is authoritative for.
 *
 * Standalone, not the case viewer. `mount()` needs a volume, a labelmap and a
 * Cornerstone rendering engine; this needs none of those and must work before sign-in.
 * So it drives a `vtkGenericRenderWindow` directly, with one actor per structure GROUP
 * -- six actors, not forty-seven -- because the question is about groups.
 *
 * The palette is its own. `web/app.js` and `implants.js` share a verdict palette and a
 * check asserts they agree; this one is deliberately not in that relationship, because
 * these are family colours for a diagram rather than the catalogue's per-structure
 * colours, and pretending otherwise would make a drawing look like data.
 */
import vtkActor from '@kitware/vtk.js/Rendering/Core/Actor';
import vtkCellArray from '@kitware/vtk.js/Common/Core/CellArray';
import vtkGenericRenderWindow from '@kitware/vtk.js/Rendering/Misc/GenericRenderWindow';
import vtkMapper from '@kitware/vtk.js/Rendering/Core/Mapper';
import vtkPolyData from '@kitware/vtk.js/Common/DataModel/PolyData';

/** Arch half-width and depth, in millimetres. A real adult mandibular arch is about
 *  52 mm across the second molars and 32 mm deep, which is what these are. */
const ARCH_A = 26;
const ARCH_B = 32;
/** Where each jaw's occlusal plane sits, and which way its crowns point. */
/* The two occlusal planes, half a millimetre apart. They used to be 6 mm apart, which
 * drew a dentition with its mouth open -- and read, at the pane's size, as a grin
 * rather than as an arch. Real teeth occlude: with both biting surfaces at the same
 * height the crowns meet exactly, because each one is built from its own surface toward
 * its own root. The 0.5 mm is there only so two coplanar surfaces do not z-fight. */
const JAWS = {
  mandible: { z: 0, down: -1 },
  maxilla: { z: 0.5, down: 1 },
};
const N_AZ = 24;

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
 * at. `highlightGroups` ghosts to 0.14 and restores to THESE rather than to 1, so a
 * highlight cannot make the diagram less readable than it was. */
const GROUP_OPACITY = {
  // 0.72, not 0.42. At 0.42 every tooth ROOT showed through the bone and the diagram
  // read as a ring of fangs rather than as a dentition -- 32 long cones seen through a
  // translucent wall. At 0.72 the bone hides the roots and the crowns read as an arch,
  // and the canals inside it come back the moment a canal model is hovered, which is
  // what the highlight is for and what the caption tells the reader to do.
  jaws: 0.72,
  teeth: 1,
  canals: 1,
  sinuses: 0.5,
  airway: 0.35,
  restorations: 1,
};
const GHOST_OPACITY = 0.14;

/* ---------------------------------------------------------------- mesh primitives
 * A tiny builder: `push` a vertex, `ring` a circle in a frame, `skin` two rings into a
 * band. The same three operations `implants.js` uses, kept separate rather than shared
 * because that file's rings live in an implant's own frame and carry an analytic normal
 * per vertex for a specular highlight, and none of that applies to a diagram.
 */
function builder() {
  const verts = [];
  const cells = [];
  const push = (x, y, z) => { verts.push(x, y, z); return verts.length / 3 - 1; };
  const tri = (a, b, c) => { cells.push(3, a, b, c); };
  const skin = (lo, hi) => {
    for (let i = 0; i < lo.length; i += 1) {
      const j = (i + 1) % lo.length;
      tri(lo[i], lo[j], hi[j]);
      tri(lo[i], hi[j], hi[i]);
    }
  };
  return { verts, cells, push, tri, skin };
}

/** A closed tube of elliptical cross-section along a polyline, capped at both ends. */
function tube(b, path, rx, ry, nAz = N_AZ) {
  if (path.length < 2) return;
  const rings = [];
  for (let k = 0; k < path.length; k += 1) {
    const p = path[k];
    const q = path[Math.min(path.length - 1, k + 1)];
    const o = path[Math.max(0, k - 1)];
    // The frame: tangent from a central difference, `up` fixed, side from their cross
    // product. A fixed `up` is enough here because no path in this diagram is vertical.
    const t = norm([q[0] - o[0], q[1] - o[1], q[2] - o[2]]);
    const s = norm(cross(t, [0, 0, 1]));
    const u = norm(cross(s, t));
    const ring = [];
    for (let i = 0; i < nAz; i += 1) {
      const th = (2 * Math.PI * i) / nAz;
      const a = Math.cos(th) * (typeof rx === 'function' ? rx(k / (path.length - 1)) : rx);
      const c = Math.sin(th) * (typeof ry === 'function' ? ry(k / (path.length - 1)) : ry);
      ring.push(b.push(p[0] + s[0] * a + u[0] * c,
                       p[1] + s[1] * a + u[1] * c,
                       p[2] + s[2] * a + u[2] * c));
    }
    rings.push(ring);
  }
  for (let k = 1; k < rings.length; k += 1) b.skin(rings[k - 1], rings[k]);
  [[rings[0], path[0]], [rings[rings.length - 1], path[path.length - 1]]]
    .forEach(([ring, p], end) => {
      const c = b.push(p[0], p[1], p[2]);
      for (let i = 0; i < ring.length; i += 1) {
        const j = (i + 1) % ring.length;
        if (end) b.tri(ring[i], ring[j], c); else b.tri(ring[j], ring[i], c);
      }
    });
}

/** A lathe: revolve a `[radius, z]` profile about the local z axis at `(x, y)`. */
function lathe(b, x, y, z0, profile, nAz = N_AZ) {
  const rings = profile.map(([r, dz]) => {
    const ring = [];
    for (let i = 0; i < nAz; i += 1) {
      const th = (2 * Math.PI * i) / nAz;
      ring.push(b.push(x + r * Math.cos(th), y + r * Math.sin(th), z0 + dz));
    }
    return ring;
  });
  for (let k = 1; k < rings.length; k += 1) b.skin(rings[k - 1], rings[k]);
}

function ellipsoid(b, c, r, nAz = N_AZ) {
  const rings = [];
  const nEl = Math.max(6, nAz / 2);
  for (let k = 0; k <= nEl; k += 1) {
    const ph = -Math.PI / 2 + (Math.PI * k) / nEl;
    const ring = [];
    for (let i = 0; i < nAz; i += 1) {
      const th = (2 * Math.PI * i) / nAz;
      ring.push(b.push(c[0] + r[0] * Math.cos(ph) * Math.cos(th),
                       c[1] + r[1] * Math.cos(ph) * Math.sin(th),
                       c[2] + r[2] * Math.sin(ph)));
    }
    rings.push(ring);
  }
  for (let k = 1; k < rings.length; k += 1) b.skin(rings[k - 1], rings[k]);
}

const norm = (v) => {
  const n = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / n, v[1] / n, v[2] / n];
};
const cross = (u, v) => [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2],
                         u[0] * v[1] - u[1] * v[0]];

/** The arch curve: `u` in [-1, 1] runs right to left. */
function archPoint(u, jaw, inset = 0) {
  const a = ARCH_A - inset;
  const bb = ARCH_B - inset;
  const th = u * 1.16;
  return [a * Math.sin(th), -bb * Math.cos(th) + bb * 0.42, JAWS[jaw].z];
}

/* -------------------------------------------------------------------- the scene
 * One axial coordinate for everything: `w` is millimetres from the BITING SURFACE
 * toward the root, and physical z is `occlusal + down * w`. The mandible's crowns point
 * up and the maxilla's point down, so writing every profile in `w` is what keeps the
 * two jaws from being mirror images by accident -- the same reason `plan_metrics` states
 * its poses in `(s, t, z)` with a `down` factor rather than in signed z.
 *
 * Rough anatomy, and it only has to be rough: crown about 8 mm, root about 13, the bone
 * crest at the neck, the inferior alveolar canal below the molar apices and ending at
 * the mental foramen, the incisive canals carrying on to the midline from there.
 */
const CREST_W = 8;          // the bone crest, at the tooth's neck
const CANAL_W = 24;         // the inferior alveolar canal, below the molar apices

function buildGroups() {
  const g = {};

  // --- jaws: an extruded ellipse along each arch, starting at the crest ----------
  g.jaws = builder();
  ['mandible', 'maxilla'].forEach((jaw) => {
    const d = JAWS[jaw].down;
    const path = [];
    for (let k = 0; k <= 40; k += 1) {
      const p = archPoint(-1 + (2 * k) / 40, jaw, 0);
      path.push([p[0], p[1], p[2] + d * (CREST_W + 11)]);
    }
    // 4.6 across, not 5.5: a narrower ridge leaves the arch's curve visible from above
    // instead of closing it into a wall.
    tube(g.jaws, path, 4.6, 11.0);
  });

  // --- teeth: sixteen lathes per jaw, molars wider and shorter-crowned ----------
  g.teeth = builder();
  ['mandible', 'maxilla'].forEach((jaw) => {
    const d = JAWS[jaw].down;
    for (let i = 0; i < 16; i += 1) {
      const u = -1 + (2 * i) / 15;
      const p = archPoint(u, jaw, 0);
      const molar = Math.abs(u) > 0.62;
      const w = molar ? 4.4 : Math.abs(u) > 0.3 ? 3.4 : 2.7;
      const crown = molar ? 7 : 9;
      const root = molar ? 11 : 13;
      // A BLUNT occlusal surface. The first version went from `0.62 w` straight into a
      // taper, which makes a cone -- and a cone is a fang. A real crown is flat on top
      // with a rounded margin, so the profile holds `0.86 w` for the first fifth of a
      // millimetre and only then widens to full and narrows to the neck.
      const profile = [
        [0.05, -0.5],                       // capped, or the lathe is an open tube
        [w * 0.86, -0.2],
        [w, 0.5],
        [w * 0.99, crown * 0.45],
        [w * 0.78, crown * 0.85],
        [w * 0.66, crown],                  // the neck, at the bone crest
        [w * 0.58, crown + root * 0.25],
        [w * 0.40, crown + root * 0.7],
        [0.35, crown + root],               // the apex
      ];
      lathe(g.teeth, p[0], p[1], p[2], profile.map(([r, ww]) => [r, d * ww]));
    }
  });

  // --- canals -------------------------------------------------------------------
  g.canals = builder();
  // The two inferior alveolar canals. They STOP at the mental foramen, which is the
  // anatomy that made the anterior verdict impossible to grade until the accessory
  // canals were measured: there is no IAC in front of it to be near.
  [[-1, -0.34], [0.34, 1]].forEach(([u0, u1]) => {
    const path = [];
    for (let k = 0; k <= 24; k += 1) {
      const u = u0 + ((u1 - u0) * k) / 24;
      const p = archPoint(u, 'mandible', 3.2);
      const d = JAWS.mandible.down;
      path.push([p[0], p[1], p[2] + d * (CANAL_W - 2 * Math.cos(u * 1.6))]);
    }
    tube(g.canals, path, 1.5, 1.5, 14);
  });
  // ...and the incisive canals, which are what an ANTERIOR implant has to clear.
  [[-0.34, -0.02], [0.34, 0.02]].forEach(([u0, u1]) => {
    const path = [];
    for (let k = 0; k <= 12; k += 1) {
      const u = u0 + ((u1 - u0) * k) / 12;
      const p = archPoint(u, 'mandible', 4.2);
      const d = JAWS.mandible.down;
      path.push([p[0], p[1], p[2] + d * (CANAL_W - 4 - 3 * Math.abs(u))]);
    }
    tube(g.canals, path, 0.8, 0.8, 10);
  });

  // --- sinuses, above the maxillary posteriors ---------------------------------
  g.sinuses = builder();
  [-1, 1].forEach((side) => {
    const p = archPoint(side * 0.72, 'maxilla', 2);
    ellipsoid(g.sinuses, [p[0] + side * 2, p[1] + 5, p[2] + CREST_W + 14], [9, 12, 9]);
  });

  // --- airway: the pharynx, behind the arch ------------------------------------
  g.airway = builder();
  tube(g.airway, [[0, 17, -30], [0, 18, -5], [0, 18, 20], [0, 16, 38]], 7.5, 9.5, 16);

  // --- restorations: one crown and one implant, so the class has a shape --------
  g.restorations = builder();
  {
    const d = JAWS.mandible.down;
    const p = archPoint(-0.48, 'mandible', 0);
    lathe(g.restorations, p[0], p[1], p[2],
          [[0.2, -0.6], [3.4, 0.5], [3.5, 4.5], [2.9, 6.4], [0.2, 6.8]]
            .map(([r, ww]) => [r, d * ww]));
    const q = archPoint(0.48, 'mandible', 0);
    lathe(g.restorations, q[0], q[1], q[2],
          [[0.2, CREST_W - 0.4], [2.05, CREST_W], [2.05, CREST_W + 10],
           [1.4, CREST_W + 11.6], [0.2, CREST_W + 12]]
            .map(([r, ww]) => [r, d * ww]));
  }
  return g;
}

/* --------------------------------------------------------------------- public API */
let scene = null;

/** Mount the schematic into `el`. Returns the group keys it drew, or null.
 *
 *  Idempotent by teardown: mounting twice disposes the first, because the picker is on
 *  a page the SPA shows and hides rather than reloads, and a leaked WebGL context per
 *  visit is the kind of thing that works for a week and then stops.
 */
export function mountModelPreview(el) {
  if (!el) return null;
  disposeModelPreview();
  let grw;
  try {
    grw = vtkGenericRenderWindow.newInstance({ background: [0.05, 0.07, 0.1] });
    grw.setContainer(el);
  } catch (e) {
    console.warn('dentistry: the model preview needs WebGL: ' + e.message);
    return null;
  }
  const renderer = grw.getRenderer();
  const groups = buildGroups();
  const actors = {};
  Object.keys(groups).forEach((key) => {
    const b = groups[key];
    const poly = vtkPolyData.newInstance();
    poly.getPoints().setData(Float32Array.from(b.verts), 3);
    poly.setPolys(vtkCellArray.newInstance({ values: Uint32Array.from(b.cells) }));
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
  // frames them; overriding the position with a literal threw the second away, and on a
  // perspective camera that is the framing. So the direction is replaced and the
  // distance `resetCamera` chose is kept -- three-quarter, from the patient's front
  // right and above, which is the angle every dental diagram is drawn from.
  renderer.resetCamera();
  const cam = renderer.getActiveCamera();
  const f = cam.getFocalPoint();
  const d = cam.getDistance();
  // Elevation matters more than azimuth here. At 25 degrees above the occlusal plane
  // the two arches stack into a barrel and the horseshoe is invisible; at 45 the arch
  // reads as an arch, which is the one thing this diagram has to communicate.
  const dir = norm([-0.42, -0.60, 0.68]);
  cam.setPosition(f[0] + dir[0] * d, f[1] + dir[1] * d, f[2] + dir[2] * d);
  cam.setViewUp(0, 0, 1);
  renderer.resetCameraClippingRange();
  grw.resize();
  scene = { grw, renderer, actors, el, spin: 0, raf: 0 };
  highlightGroups(null);
  return Object.keys(actors);
}

/** Bring one model's groups forward and ghost the rest. `null` shows everything.
 *
 *  The ghost is 0.16 opacity rather than hidden: which structures a model does NOT own
 *  is half of the answer, and a scene that empties out when you hover a canal model
 *  tells you nothing about where those canals are. */
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
  return { groups: out, spinning: !!scene.raf };
}
