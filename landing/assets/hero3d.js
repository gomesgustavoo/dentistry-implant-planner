// hero3d.js — real-time WebGL dental hero: a jaw that opens.
//
// Renders the real 34-structure segmentation (assets/arch.<hash>.glb, baked from a
// finished job by scripts/export_arch_glb.py) on a TRANSPARENT canvas so the page's
// violet glow shows through. Scroll scrubs one smoothed progress value (0..1)
// through: turn -> the mandible hinges open about the condylar axis -> the jaws go
// translucent and the mandibular canal is left glowing inside.
//
// The hinge is not an arbitrary rotation, and not even a pure rotation. Opening a
// jaw is a rototranslation: the condyle hinges, then slides down the articular
// eminence. scripts/export_arch_glb.py measures this patient's condyles and solves
// the whole motion -- angle, slide, and the sign -- shipping it in the GLB's
// asset.extras. On the example case that is 30 degrees plus 18 mm of translation,
// giving a 40.3 mm interincisal opening from a 3.5 mm overbite. Nothing about the
// motion is chosen in this file.
//
// WebGL/asset failure degrades to the static poster via `filmstage--static`.
// Vendored Three.js r169 (assets/vendor/three) via the import map in index.html.

import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";

// Bump BUILD (and the matching ?v= on the hero3d.js <script> in index.html) on
// every redeploy. /assets/ is served immutable behind Cloudflare, so the pointer
// file (stable URL, new GLB hashes each regen) must be query-busted to refresh.
const BUILD = "3";
const ASSETS_URL = "/assets/arch.assets.json?v=" + BUILD;

// --- tunables ---------------------------------------------------------------
const FOV = 34;
const FILL = 0.82;              // fraction of the viewport the arch fills
// The GLB is baked (Left, Superior, Anterior) — already Y-up and already facing
// the camera, so no tilt is needed and the only rotation is the turntable.
const START_YAW = -0.20;
const TURN_RADIANS = Math.PI * 0.42;   // a quarter turn to a three-quarter view
const OPEN_START = 0.42;        // progress at which the jaw starts to open
const OPEN_END = 0.78;          // ...and is fully open
const REVEAL_END = 1.0;         // jaws fade to their translucent values by here
// Opening is rotation THEN translation, as a real jaw is: the condyle hinges first
// and only starts sliding down the articular eminence once the bite is well open.
// Fraction of the open window after which the slide begins.
const SLIDE_FROM = 0.4;
const CLIMAX_AT = 0.86;
const SMOOTH_LAMBDA = 7.5;      // 1/s
const DOLLY = 0.14;             // gentle pull-back as the jaw opens

const ACCENT = 0x8b5cf6;        // brand violet — fill light only
const ACCENT_2 = 0x6366f1;
const CANAL_GLOW = 0xff3b30;    // the canal lights itself; it is the point of the shot

const HOVER_MIN_PROGRESS = 0.12;
const GLOW_INTENSITY = 0.85;

const stage = document.querySelector("[data-filmstage]");
const canvas = document.getElementById("heroCanvas");

const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const coarse = window.matchMedia("(pointer: coarse)").matches;
const finePointer = !coarse && window.matchMedia("(pointer: fine)").matches;

let renderer, scene, camera, model, envRT;
let root_ = null;   // the loaded GLB scene, kept for measure()
let incisalUpper = null, incisalLower = null;  // { mesh, index } for measure()
let lowerPivot = null;          // Group placed at the condylar axis
let hinge = null;               // solved motion, from the GLB's asset.extras
const pivotHome = new THREE.Vector3();
const slideDir = new THREE.Vector3();
let jaws = [];                  // [{ mesh, target }] for the opacity reveal
let canalMeshes = [];
let modelRadius = 1, baseDist = 4;
const boxSize = new THREE.Vector3();
let targetP = 0, smoothP = 0;
let raf = null, running = false, lastT = 0;
let visible = true, initialized = false;

const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();
let meshList = [];
let hovered = null;
let pointerInside = false, pointerMoved = false;
let ptrX = 0, ptrY = 0;
let tipEl = null, tipDot = null, tipLabel = null, tipMeta = null;
let structures = {};            // id -> { name, fdi, colour } from the manifest

// ---------------------------------------------------------------------------
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const remap = (x, a, b) => clamp01((x - a) / (b - a));
const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

function progress() {
  const rect = stage.getBoundingClientRect();
  const total = stage.offsetHeight - window.innerHeight;
  if (total <= 0) return 0;
  return clamp01(-rect.top / total);
}

function failToPoster() {
  if (stage) stage.classList.add("filmstage--static");
  cancel();
}

function hasWebGL() {
  try {
    const c = document.createElement("canvas");
    return !!(window.WebGLRenderingContext &&
      (c.getContext("webgl2") || c.getContext("webgl")));
  } catch (_) {
    return false;
  }
}

// gltfpack keeps the structure id on a parent NODE and strips the mesh name, so
// GLTFLoader labels the leaf "mesh_N" — walk up to the real name.
function structureId(o) {
  for (let n = o; n; n = n.parent) {
    if (n.name && n.name !== "world" && n.name !== "upper" && n.name !== "lower" &&
        !/^mesh_\d+$/.test(n.name)) return n.name;
  }
  return "";
}

// "tooth_16" -> "16 · upper right first molar"; "canal" -> "Mandibular canal"
function prettyLabel(id) {
  const s = structures[id];
  if (!s) return id || "Structure";
  return s.fdi ? s.fdi + " · " + s.name.toLowerCase() : s.name;
}

// ---- hover: glow the structure + name it ----------------------------------
// Styles ship WITH this versioned module (not styles.css, a stable URL on a long
// Cloudflare cache that could lag the JS and leave the tooltip unstyled).
function injectTooltipStyles() {
  if (document.getElementById("hero3d-style")) return;
  const css = `
.hero3d-tooltip{position:fixed;left:0;top:0;z-index:60;pointer-events:none;
  display:inline-flex;align-items:center;gap:.55rem;padding:.42rem .72rem;
  font-family:var(--mono,ui-monospace,SFMono-Regular,Menlo,monospace);
  font-size:.72rem;letter-spacing:.04em;color:var(--text,#f4f7fa);
  background:rgba(10,14,19,.78);border:1px solid var(--glass-border,rgba(255,255,255,.14));
  border-radius:var(--radius-sm,8px);-webkit-backdrop-filter:blur(12px) saturate(1.2);
  backdrop-filter:blur(12px) saturate(1.2);box-shadow:0 6px 24px rgba(0,0,0,.5);
  white-space:nowrap;opacity:0;transition:opacity .12s ease}
.hero3d-tooltip.is-visible{opacity:1}
.hero3d-tooltip__dot{width:.58rem;height:.58rem;flex:none;border-radius:50%;
  box-shadow:0 0 8px currentColor}
.hero3d-tooltip__meta{opacity:.62;font-variant-numeric:tabular-nums}`;
  const el = document.createElement("style");
  el.id = "hero3d-style";
  el.textContent = css;
  document.head.appendChild(el);
}

function setGlow(mesh, on) {
  const m = mesh && mesh.material;
  if (!m || !m.emissive) return;
  if (on) { m.emissive.copy(m.color); m.emissiveIntensity = GLOW_INTENSITY; }
  else { m.emissive.setHex(mesh.userData.baseEmissive || 0x000000);
         m.emissiveIntensity = mesh.userData.baseEmissiveIntensity || 1; }
}

function positionTooltip() {
  if (!tipEl) return;
  const pad = 16;
  const w = tipEl.offsetWidth, h = tipEl.offsetHeight;
  let x = ptrX + pad, y = ptrY + pad;
  if (x + w > window.innerWidth - 8) x = ptrX - pad - w;
  if (y + h > window.innerHeight - 8) y = ptrY - pad - h;
  tipEl.style.left = x + "px";
  tipEl.style.top = y + "px";
}

function setHover(mesh) {
  if (mesh === hovered) return;              // no change -> no work
  if (hovered) setGlow(hovered, false);
  hovered = mesh || null;
  if (hovered) {
    setGlow(hovered, true);
    if (tipEl) {
      tipLabel.textContent = hovered.userData.label || "Structure";
      tipMeta.textContent = hovered.userData.meta || "";
      tipDot.style.background = hovered.userData.swatch || "#fff";
      tipDot.style.color = hovered.userData.swatch || "#fff";
      tipEl.classList.add("is-visible");
      positionTooltip();
    }
  } else if (tipEl) {
    tipEl.classList.remove("is-visible");
  }
}

function onPointerMove(e) {
  ptrX = e.clientX; ptrY = e.clientY;
  const r = canvas.getBoundingClientRect();
  ndc.x = ((e.clientX - r.left) / r.width) * 2 - 1;
  ndc.y = -((e.clientY - r.top) / r.height) * 2 + 1;
  pointerMoved = true;
  if (hovered) positionTooltip();            // immediate, DOM-only follow
  if (smoothP > HOVER_MIN_PROGRESS) wake();
}

function updateHover() {
  if (!pointerInside || smoothP <= HOVER_MIN_PROGRESS) {
    if (hovered) setHover(null);
    pointerMoved = false;
    return;
  }
  if (pointerMoved || smoothP !== targetP) {
    scene.updateMatrixWorld();
    raycaster.setFromCamera(ndc, camera);
    const hits = raycaster.intersectObjects(meshList, false);
    setHover(hits.length ? hits[0].object : null);
  }
  pointerMoved = false;
}

// ---------------------------------------------------------------------------
function createRenderer() {
  renderer = new THREE.WebGLRenderer({
    canvas, antialias: true, alpha: true, powerPreference: "high-performance",
  });
  renderer.setClearAlpha(0);                 // transparent — CSS glow shows through
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, coarse ? 1.5 : 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.92;       // bone is a mid tone; the brain's 0.78 muddied it
  canvas.addEventListener("webglcontextlost", (e) => { e.preventDefault(); cancel(); }, false);
  canvas.addEventListener("webglcontextrestored", () => failToPoster(), false);
}

function createScene() {
  scene = new THREE.Scene();
  scene.background = null;
  camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 5000);

  const pmrem = new THREE.PMREMGenerator(renderer);
  envRT = pmrem.fromScene(new RoomEnvironment(), 0.04);
  scene.environment = envRT.texture;
  scene.environmentIntensity = 0.22;         // subtle, so the bone tones read true
  pmrem.dispose();

  // Neutral key so enamel and cortical bone keep their own colour; the brand
  // violet is a fill and a rim for page cohesion, never a wash.
  const key = new THREE.DirectionalLight(0xfff6e8, 1.05);
  key.position.set(0.45, 0.95, 0.85);
  scene.add(key);

  const fill = new THREE.DirectionalLight(ACCENT, 0.34);
  fill.position.set(-0.95, -0.15, 0.45);
  scene.add(fill);

  const rim = new THREE.DirectionalLight(ACCENT_2, 0.5);
  rim.position.set(-0.25, 0.6, -0.95);
  scene.add(rim);

  scene.add(new THREE.AmbientLight(0xc6cedd, 0.16));
}

function fitCamera() {
  // Fit the visible silhouette. The arch is wider (x) and taller (y) than it is
  // deep, and it yaws, so fit the larger of width/depth horizontally.
  const vFov = (FOV * Math.PI) / 180;
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * camera.aspect);
  const halfH = boxSize.y / 2;
  const halfW = Math.max(boxSize.x, boxSize.z) / 2;
  const distH = (halfH / FILL) / Math.tan(vFov / 2);
  const distW = (halfW / FILL) / Math.tan(hFov / 2);
  baseDist = Math.max(distH, distW) + halfW;
}

function prepareModel(root, extras) {
  root_ = root;
  model = new THREE.Group();
  model.add(root);
  scene.add(model);
  model.updateMatrixWorld(true);

  const box = new THREE.Box3().setFromObject(model);
  modelRadius = box.getBoundingSphere(new THREE.Sphere()).radius;
  box.getSize(boxSize);

  // Re-parent the lower arch under a Group sitting exactly on the condylar axis,
  // so opening the jaw is one rotation about that group's local x — no per-mesh
  // pivot maths, and the teeth, mandible and canal cannot drift apart.
  const lower = root.getObjectByName("lower");
  hinge = (extras && extras.hinge) || null;
  if (lower && hinge && hinge.pivot) {
    // Re-parent the lower arch under a Group sitting exactly on the condylar axis, so
    // opening is one rotation (plus one translation) of that group — the mandible, the
    // 16 lower teeth and the canal cannot drift apart.
    pivotHome.fromArray(hinge.pivot);
    slideDir.fromArray(hinge.translate_dir || [0, -0.7071, 0.7071]);
    lowerPivot = new THREE.Group();
    lowerPivot.position.copy(pivotHome);
    lower.parent.add(lowerPivot);
    lower.position.sub(pivotHome);           // cancel the offset we just introduced
    lowerPivot.add(lower);
    console.info("[hero3d] hinge: " + hinge.open_degrees + " deg + " +
      hinge.translate_mm + " mm slide -> " + hinge.interincisal_open_mm +
      " mm interincisal (intercondylar " + hinge.intercondylar_mm + " mm)");
  } else {
    console.warn("[hero3d] no hinge in the GLB extras — the jaw will stay shut");
  }

  jaws = []; canalMeshes = []; meshList = [];
  root.traverse((o) => {
    if (!o.isMesh) return;
    const id = structureId(o);
    const s = structures[id];
    o.userData.label = prettyLabel(id);
    o.userData.swatch = (s && s.colour) ||
      (o.material && o.material.color ? "#" + o.material.color.getHexString() : "#ffffff");
    o.userData.meta = s && s.volume_cm3 != null ? s.volume_cm3.toFixed(2) + " cm³" : "";

    // Materials arrive from the GLB with the jaws already translucent. Start them
    // opaque so the teeth are hidden inside solid bone, then fade to the baked
    // value during the reveal — that is what makes the canal an arrival.
    if (o.material && o.material.transparent) {
      jaws.push({ mesh: o, target: o.material.opacity });
      o.material.opacity = 1.0;
      o.material.depthWrite = true;
    }
    if (id === "canal") {
      canalMeshes.push(o);
      o.userData.baseEmissive = CANAL_GLOW;
      o.userData.baseEmissiveIntensity = 0;
      o.material.emissive = new THREE.Color(CANAL_GLOW);
      o.material.emissiveIntensity = 0;
      o.renderOrder = 2;                     // draw after the translucent mandible
    }
    meshList.push(o);
  });

  // Record the incisal-edge VERTEX of one upper and one lower central incisor, in
  // the rest pose, so measure() can follow that exact point through the transform.
  // An axis-aligned Box3 cannot: once the mandible has rotated 30 degrees the root
  // apex can become the topmost point of the tooth, and the box then reports an
  // opening ~8 mm smaller than the real one.
  incisalUpper = extremeVertex(root, ["tooth_11", "tooth_21"], false);
  incisalLower = extremeVertex(root, ["tooth_41", "tooth_31"], true);

  model.rotation.order = "YXZ";
  model.rotation.set(0, START_YAW, 0);
}

// An upper incisor's edge is its LOWEST point; a lower incisor's is its highest.
function extremeVertex(root, names, wantHighest) {
  for (const name of names) {
    const node = root.getObjectByName(name);
    if (!node) continue;
    let found = null;
    node.traverse((o) => {
      if (!o.isMesh || found) return;
      o.updateWorldMatrix(true, false);
      const pos = o.geometry.getAttribute("position");
      const v = new THREE.Vector3();
      let best = -1, bestY = wantHighest ? -Infinity : Infinity;
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
        if (wantHighest ? v.y > bestY : v.y < bestY) { bestY = v.y; best = i; }
      }
      if (best >= 0) found = { mesh: o, index: best };
    });
    if (found) return found;
  }
  return null;
}

function vertexWorldY(rec) {
  if (!rec) return null;
  rec.mesh.updateWorldMatrix(true, false);
  const v = new THREE.Vector3()
    .fromBufferAttribute(rec.mesh.geometry.getAttribute("position"), rec.index)
    .applyMatrix4(rec.mesh.matrixWorld);
  return v.y;
}

// deterministic pose from one smoothed progress value
function applyChoreography(p) {
  // Phase 1: a partial turn to a three-quarter view, easing to rest exactly as the
  // jaw begins to open, so the two motions never compete for attention.
  const turn = reducedMotion ? 0 : easeInOutCubic(clamp01(p / OPEN_START));
  model.rotation.y = START_YAW + turn * TURN_RADIANS;

  // Phase 2: the hinge. Rotation about the measured condylar axis, then the condyle
  // slides down the articular eminence — the angle, the direction and the sign are
  // all solved at bake time from this patient's own geometry (see
  // scripts/export_arch_glb.py::solve_open_motion), never guessed here.
  const open = easeInOutCubic(remap(p, OPEN_START, OPEN_END));
  if (lowerPivot && hinge) {
    lowerPivot.rotation.x = hinge.sign * open * (hinge.open_degrees || 0) * Math.PI / 180;
    const slide = easeInOutCubic(remap(open, SLIDE_FROM, 1)) * (hinge.translate_mm || 0);
    lowerPivot.position.copy(pivotHome).addScaledVector(slideDir, slide);
  }

  // Phase 3: the jaws go translucent and the canal lights up inside the mandible.
  const reveal = easeInOutCubic(remap(p, OPEN_END, REVEAL_END));
  for (const j of jaws) {
    j.mesh.material.opacity = 1 - (1 - j.target) * reveal;
    // Only stop writing depth once genuinely translucent, or the teeth behind the
    // maxilla pop through while it is still nearly opaque.
    j.mesh.material.depthWrite = reveal < 0.5;
  }
  for (const c of canalMeshes) {
    c.material.emissiveIntensity = reveal * 1.15;
    c.userData.baseEmissiveIntensity = reveal * 1.15;
  }

  camera.position.set(0, 0, baseDist * (1 + DOLLY * open));
  camera.lookAt(0, 0, 0);

  stage.classList.toggle("is-climax", p > CLIMAX_AT);
}

// ---------------------------------------------------------------------------
function onResize() {
  const bg = canvas.parentNode;
  const w = bg.clientWidth, h = bg.clientHeight;
  if (!w || !h) return;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  fitCamera();
  wake();
}

function tick(now) {
  raf = null;
  const dt = Math.min((now - lastT) / 1000, 0.05);
  lastT = now;

  targetP = progress();
  // Framerate-independent smoothing. A naive `+= (t-s)*0.12` runs twice as fast on
  // a 120 Hz display as on a 60 Hz one.
  const k = 1 - Math.exp(-SMOOTH_LAMBDA * dt);
  smoothP += (targetP - smoothP) * k;
  if (Math.abs(targetP - smoothP) < 0.0005) smoothP = targetP;

  applyChoreography(smoothP);
  if (finePointer) updateHover();
  renderer.render(scene, camera);

  if (visible && smoothP !== targetP) {
    raf = requestAnimationFrame(tick);
  } else {
    running = false;             // settled — sleep until scroll/resize wakes us
  }
}

function wake() {
  if (running || !initialized) return;
  running = true;
  lastT = performance.now();
  raf = requestAnimationFrame(tick);
}

function cancel() {
  if (raf) cancelAnimationFrame(raf);
  raf = null;
  running = false;
}

function dispose() {
  cancel();
  if (tipEl) { tipEl.remove(); tipEl = null; }
  if (renderer) renderer.dispose();
  if (envRT) envRT.dispose();
  if (model) {
    model.traverse((o) => {
      if (o.isMesh) {
        o.geometry?.dispose();
        const m = o.material;
        (Array.isArray(m) ? m : [m]).forEach((mm) => mm?.dispose?.());
      }
    });
  }
}

// ---------------------------------------------------------------------------
async function init() {
  if (!stage || !canvas) return;
  if (!hasWebGL()) { failToPoster(); return; }

  const guard = setTimeout(() => { if (!initialized) failToPoster(); }, 12000);

  try {
    // Revalidate the pointer file: it is tiny, its GLB hashes change on redeploy,
    // and /assets/ is served immutable — force-cache would strand old hashes.
    const assets = await fetch(ASSETS_URL, { cache: "no-cache" }).then((r) => r.json());
    const useMobile = coarse || window.innerWidth <= 820 ||
      (navigator.deviceMemory && navigator.deviceMemory <= 4);
    const url = "/assets/" + (useMobile ? assets.mobile : assets.desktop);

    // The manifest carries the per-structure names, FDI numbers and volumes the
    // tooltip reports. Non-fatal: a missing manifest costs labels, not the hero.
    if (assets.manifest) {
      try {
        const man = await fetch("/assets/" + assets.manifest + "?v=" + BUILD)
          .then((r) => r.json());
        for (const s of man.structures || []) structures[s.id] = s;
      } catch (e) { console.warn("[hero3d] manifest unavailable:", e); }
    }

    createRenderer();
    createScene();

    const loader = new GLTFLoader();
    loader.setMeshoptDecoder(MeshoptDecoder);
    const gltf = await loader.loadAsync(url);

    prepareModel(gltf.scene, gltf.asset && gltf.asset.extras);
    onResize();

    initialized = true;
    clearTimeout(guard);

    window.addEventListener("scroll", wake, { passive: true });
    window.addEventListener("resize", onResize, { passive: true });
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) cancel(); else wake();
    });
    window.addEventListener("pagehide", dispose);

    if ("IntersectionObserver" in window) {
      new IntersectionObserver((entries) => {
        visible = entries[0].isIntersecting;
        if (visible) wake();
      }, { rootMargin: "200px" }).observe(stage);
    }

    if (finePointer) {
      injectTooltipStyles();
      tipEl = document.createElement("div");
      tipEl.className = "hero3d-tooltip";
      tipEl.innerHTML = '<span class="hero3d-tooltip__dot"></span>' +
        '<span class="hero3d-tooltip__label"></span>' +
        '<span class="hero3d-tooltip__meta"></span>';
      document.body.appendChild(tipEl);
      tipDot = tipEl.querySelector(".hero3d-tooltip__dot");
      tipLabel = tipEl.querySelector(".hero3d-tooltip__label");
      tipMeta = tipEl.querySelector(".hero3d-tooltip__meta");
      stage.addEventListener("pointermove", onPointerMove, { passive: true });
      stage.addEventListener("pointerenter", () => { pointerInside = true; });
      stage.addEventListener("pointerleave", () => {
        pointerInside = false; pointerMoved = true; wake();
      });
    }

    // A hook for the verification pass: it can drive the scrub deterministically
    // and read the canvas back, instead of trying to fake scroll events.
    window.__hero3d = {
      set(p) { smoothP = targetP = clamp01(p); applyChoreography(smoothP);
               renderer.render(scene, camera); },
      state() { return { p: smoothP, open: lowerPivot ? lowerPivot.rotation.x : null,
                         meshes: meshList.length, jaws: jaws.length,
                         canal: canalMeshes.length }; },
      // The assertion that actually matters, and the one a pixel count cannot make:
      // how far apart the incisal edges are, in millimetres of real anatomy. Immune
      // to the camera dolly, which otherwise shrinks the silhouette and makes a
      // chromatic-pixel count fall while the jaw is opening.
      measure() {
        scene.updateMatrixWorld(true);
        const uy = vertexWorldY(incisalUpper), ly = vertexWorldY(incisalLower);
        return {
          p: smoothP,
          openDeg: lowerPivot ? +(Math.abs(lowerPivot.rotation.x) * 180 / Math.PI).toFixed(2) : null,
        slide_mm: lowerPivot ? +lowerPivot.position.distanceTo(pivotHome).toFixed(2) : null,
          // vertical separation of the two central incisors, in mm
          interincisal_mm: uy != null && ly != null ? +Math.abs(uy - ly).toFixed(1) : null,
          jawOpacity: jaws.map((j) => +j.mesh.material.opacity.toFixed(3)),
          canalEmissive: canalMeshes.map((c) => +c.material.emissiveIntensity.toFixed(3)),
        };
      },
    };

    smoothP = targetP = progress();
    applyChoreography(smoothP);
    renderer.render(scene, camera);
    wake();
  } catch (err) {
    clearTimeout(guard);
    console.error("[hero3d] init failed:", err);
    failToPoster();
  }
}

init();
