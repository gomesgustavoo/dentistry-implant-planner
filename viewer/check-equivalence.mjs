/* Runtime differential test: does the rebuilt bundle BEHAVE like the shipped one?
 *
 * `check-bundle.mjs` compares the artifacts. This mounts a real case in a real browser
 * under each bundle in turn and compares `debugState()` -- which the viewer exports for
 * exactly this purpose, and which deliberately reports READ-BACK values (`lut.ok`,
 * `colorsMatchPalette`, actor visibility, camera geometry) rather than what the code
 * intended. A state vector made of intentions would agree with itself and prove nothing.
 *
 * ## This runs on the GPU, and that is new
 *
 * The standing note in this project is that "headless Chrome measurements of Cornerstone
 * on this box are worthless" -- it invented a 150-400 ms blank-pane transient that does
 * not exist and reported an 11 s mount that is really 173 ms. That was measured with
 * `--disable-gpu` on the command line, which GUARANTEES SwiftShader and fully explains
 * it. Measured 2026-09-02 with `--use-angle=gl-egl --ozone-platform=headless` and no
 * `--disable-gpu`, this box reports:
 *
 *     ANGLE (NVIDIA Corporation, NVIDIA GeForce RTX 3080/PCIe/SSE2, OpenGL ES 3.2)
 *
 * so Cornerstone renders on the real card here. The renderer string is asserted below
 * rather than assumed, and the run refuses to compare anything if it says SwiftShader --
 * a comparison on a software rasteriser would be two wrong answers agreeing.
 *
 * TIMING IS STILL NEVER ASSERTED. A headless GPU context is not the user's browser and
 * a frame budget measured here would be a number about this harness.
 *
 * Usage:
 *   node viewer/check-equivalence.mjs                 # auto-picks a stored case
 *   node viewer/check-equivalence.mjs --case <job-id>
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.join(HERE, '..');
const DATA = path.join(ROOT, 'data', 'tenants');
// The ORACLE is the PRESERVED v5 copy, not `web/viewer.js`. Once the rebuilt
// bundle ships, `web/viewer.js` IS the candidate, and comparing it against
// itself would pass vacuously. See viewer/reference/README.md.
const SHIPPED = process.env.DENT_VIEWER_ORACLE
  || path.join(ROOT, 'viewer', 'reference', 'viewer-v5-shipped.js');
const CANDIDATE = path.join(HERE, 'dist', 'viewer.js');

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
  return ok;
};

/* ------------------------------------------------------------------ the case */

function findCase(wanted) {
  if (!existsSync(DATA)) return null;
  const candidates = [];
  for (const tenant of readdirSync(DATA)) {
    const results = path.join(DATA, tenant, 'results');
    if (!existsSync(results)) continue;
    for (const job of readdirSync(results)) {
      if (wanted && job !== wanted) continue;
      const dir = path.join(results, job);
      // A case is usable only if it has the volume pack AND some meshes: the mount path
      // needs the first and `addSurface` needs the second, and a case missing either
      // would produce a green run that exercised nothing.
      if (existsSync(path.join(dir, 'volume', 'meta.json'))
          && existsSync(path.join(dir, 'volume', 'image.raw'))
          && existsSync(path.join(dir, 'volume', 'labels.raw'))
          && existsSync(path.join(dir, 'report.json'))
          && existsSync(path.join(dir, 'mesh'))) {
        // Prefer a case whose colour map is already in the shape the viewer wants, so
        // the run is not depending on the in-page repair above to work.
        let hex = false;
        try {
          const c = JSON.parse(readFileSync(path.join(dir, 'volume', 'meta.json'),
                                            'utf8')).colors || {};
          const first = c[Object.keys(c)[0]];
          hex = !!first && typeof first.color === 'string';
        } catch { /* unreadable */ }
        candidates.push({ job, dir, hex });
      }
    }
  }
  candidates.sort((x, y) => Number(y.hex) - Number(x.hex));
  return candidates[0] || null;
}

/* ---------------------------------------------------------------- the server */

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.jpg': 'image/jpeg', '.png': 'image/png',
  '.raw': 'application/octet-stream', '.msh': 'application/octet-stream',
};

/** Serve `web/` plus one real case's artifacts, with `viewer.js` swapped per run.
 *
 *  The path mapping mirrors `api/routes/files.py`: `/v1/jobs/<id>/files/<path>` reads
 *  `results/<id>/<path>`, and `planning/pack/` is refused there so it is refused here.
 *  Serving from the real tree rather than from fixtures is the point -- a mount over
 *  synthetic data would not exercise the volume-size guard, the colour LUT read-back or
 *  the DSVM parser against anything the worker actually wrote.
 */
function serve(viewerPath, kase) {
  const web = path.join(ROOT, 'web');
  const srv = createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    let p = decodeURIComponent(url.pathname);

    if (p === '/viewer.js') {
      const body = readFileSync(viewerPath);
      res.writeHead(200, { 'content-type': 'text/javascript',
                           'content-length': body.length });
      return res.end(body);
    }

    const filesAt = `/v1/jobs/${kase.job}/files/`;
    if (p.startsWith(filesAt)) {
      const rel = p.slice(filesAt.length);
      if (rel.startsWith('planning/pack/')) {           // as the API refuses it
        res.writeHead(404); return res.end('the measurement pack is mmap-only');
      }
      const file = path.join(kase.dir, rel);
      if (!file.startsWith(kase.dir) || !existsSync(file)) {
        res.writeHead(404); return res.end('no such artifact');
      }
      const body = readFileSync(file);
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream',
                           'content-length': body.length });
      return res.end(body);
    }

    if (p === '/' || p === '') p = '/index.html';
    const file = path.join(web, p);
    if (!file.startsWith(web) || !existsSync(file) || statSync(file).isDirectory()) {
      res.writeHead(404); return res.end('not found');
    }
    const body = readFileSync(file);
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream',
                         'content-length': body.length });
    res.end(body);
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1',
    () => resolve({ srv, port: srv.address().port })));
}

/* -------------------------------------------------------------------- chrome */

async function cdp(port) {
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 300));
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      const ws = (await r.json()).webSocketDebuggerUrl;
      if (ws) {
        const sock = new globalThis.WebSocket(ws);
        await new Promise((res, rej) => {
          sock.addEventListener('open', res);
          sock.addEventListener('error', rej);
        });
        let id = 0;
        return {
          send: (method, params = {}, sessionId) => new Promise((res) => {
            const myId = ++id;
            const on = (e) => {
              const m = JSON.parse(e.data);
              if (m.id === myId) { sock.removeEventListener('message', on); res(m.result); }
            };
            sock.addEventListener('message', on);
            sock.send(JSON.stringify({ id: myId, method, params, sessionId }));
          }),
          close: () => sock.close(),
        };
      }
    } catch { /* not up yet */ }
  }
  throw new Error('chrome did not expose a debugger');
}

/** The page script: mount the real case under whichever viewer.js was served.
 *
 *  `DENTISTRY_NO_BOOT` keeps `app.js` from starting OIDC. Everything else is driven
 *  directly rather than through the app, so a failure is attributable to the viewer.
 */
const PROBE = (job) => `(async () => {
  const R = (p) => fetch('/v1/jobs/${job}/files/' + p);
  const meta = await (await R('volume/meta.json')).json();
  // NOTE: this whole function is the body of a template literal. NO BACKTICKS in these
  // comments, or the literal closes and the file is a syntax error.
  //
  // The stored artifacts predate two fixes, and both are patched in memory here -- for
  // BOTH runs, so the comparison exercises those paths rather than silently skipping
  // them. report.json is the source because it carries index, id and a hex colour for
  // every structure, which is what the viewer needs and what volume/meta.json lacks:
  //   * Structure.id, omitted by the 2026-09-01 reconstruction. The surface OPACITY
  //     table and archCentre are both keyed on it, so without it the jaws render
  //     opaque and hide every tooth, and the 3D framing falls back to a fixed direction.
  //   * color as an r,g,b ARRAY on the three older cases, where the viewer does
  //     color.slice(1) and dies on "Cannot read properties of undefined".
  const report = await (await R('report.json')).json();
  const byIndex = {};
  (report.structures || []).forEach((g) => (g.structures || []).forEach((s) => {
    byIndex[s.index] = s;
  }));
  Object.entries(meta.colors || {}).forEach(([i, m]) => {
    const known = byIndex[i];
    if (!m.id && known) m.id = known.id;
    if (Array.isArray(m.color)) {
      m.color = '#' + m.color.map((v) => Number(v).toString(16).padStart(2, '0')).join('');
    } else if (typeof m.color !== 'string' && known) {
      m.color = known.color;
    }
  });
  const image = await (await R('volume/image.raw')).arrayBuffer();
  const labels = await (await R('volume/labels.raw')).arrayBuffer();

  const mk = (id) => { const d = document.createElement('div');
    d.id = id; d.style.cssText = 'width:320px;height:320px;position:relative';
    document.body.appendChild(d); return d; };
  const els = ['a', 'b', 'c'].map(mk);
  const el3d = mk('d');

  const gl = document.createElement('canvas').getContext('webgl2');
  const dbg = gl && gl.getExtension('WEBGL_debug_renderer_info');
  const renderer = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : 'unknown';

  const mounted = await DentistryViewer.mount(els, meta, image, labels, el3d);

  // Stream every mesh the case has, in a stable order, so the triangle total and the
  // actor count are comparable between runs.
  const names = (meta.labels && meta.labels.present || Object.keys(meta.colors || {}))
    .map(Number).sort((x, y) => x - y);
  const added = [];
  for (const idx of names) {
    const id = (meta.colors[idx] || {}).id;
    if (!id) continue;
    try {
      const res = await R('mesh/' + id + '.msh');
      if (!res.ok) continue;
      const n = DentistryViewer.addSurface(idx, await res.arrayBuffer());
      if (n) added.push([idx, n]);
    } catch (e) { /* absent mesh */ }
  }
  const framed = DentistryViewer.surfacesReady();
  DentistryViewer.set3dMode('surfaces');

  // Exercise the parts app.js drives, so the comparison covers them.
  DentistryViewer.setOverlayStyle(0.45, 2);
  const firstTooth = names.find((i) => /^tooth_/.test((meta.colors[i] || {}).id || ''));
  if (firstTooth != null) {
    DentistryViewer.setStructureVisible(firstTooth, false);
    DentistryViewer.setStructureVisible(firstTooth, true);
    if (mounted.centroids && mounted.centroids[firstTooth]) {
      DentistryViewer.jumpTo(mounted.centroids[firstTooth]);
      DentistryViewer.focusStructure(mounted.centroids[firstTooth],
        { index: firstTooth, archCentre: mounted.archCentre });
    }
  }
  DentistryViewer.resetCameras();

  return {
    renderer,
    version: DentistryViewer.version,
    planes: DentistryViewer.planes,
    viewport3dId: DentistryViewer.viewport3dId,
    mounted: { volumeRendered: mounted.volumeRendered,
               centroids: Object.keys(mounted.centroids || {}).length,
               archCentre: mounted.archCentre
                 && mounted.archCentre.map((v) => +v.toFixed(3)),
               labels: mounted.labels },
    surfacesAdded: added,
    framed,
    state: DentistryViewer.debugState(),
  };
})()`;

/* The implant probe. NO BACKTICKS in the comments inside it -- it is the body of a
 * template literal, and a backtick closes the literal and turns the file into a syntax
 * error. That trap has now been paid for twice in this repo. */
const IMPLANT_PROBE = (job, vec) => `(async () => {
  const V = ${JSON.stringify(vec)};
  const R = (p) => fetch('/v1/jobs/${job}/files/' + p);
  const meta = await (await R('volume/meta.json')).json();
  const report = await (await R('report.json')).json();
  const byIndex = {};
  (report.structures || []).forEach((g) => (g.structures || []).forEach((x) => {
    byIndex[x.index] = x;
  }));
  Object.entries(meta.colors || {}).forEach(([i, m]) => {
    const k = byIndex[i];
    if (!m.id && k) m.id = k.id;
    if (Array.isArray(m.color)) {
      m.color = '#' + m.color.map((v) => Number(v).toString(16).padStart(2, '0')).join('');
    } else if (typeof m.color !== 'string' && k) { m.color = k.color; }
  });
  const image = await (await R('volume/image.raw')).arrayBuffer();
  const labels = await (await R('volume/labels.raw')).arrayBuffer();
  const mk = (id) => { const d = document.createElement('div');
    d.id = id; d.style.cssText = 'width:320px;height:320px;position:relative';
    document.body.appendChild(d); return d; };
  const els = ['a','b','c'].map(mk); const el3d = mk('d');
  await DentistryViewer.mount(els, meta, image, labels, el3d);

  // The arch manifest the golden vectors were generated against, so the browser and
  // Python are placing implants on the SAME polyline. Anything else would compare two
  // poses rather than two implementations of one pose.
  DentistryViewer.setImplantArch({ jaws: V.manifest });

  const dot = (u, w) => u[0]*w[0] + u[1]*w[1] + u[2]*w[2];
  const poses = [];
  for (const pose of V.poses) {
    const imp = { ...pose.implant, id: 'g' };
    DentistryViewer.setImplants([imp]);
    const g = DentistryViewer.debugState().implants;
    const probe = DentistryViewer.implantGeometryForTest && DentistryViewer.implantGeometryForTest('g');
    if (!probe) { poses.push({ frameError: 1, vertexError: 1, orthoError: 1,
                               trianglesMatch: false, sampled: 0,
                               outside: 1, touch: 1 }); continue; }
    const f = pose.frame;
    const frameError = Math.max(
      ...['origin','e1','e2','ax'].flatMap((k) => f[k].map((v, i) =>
        Math.abs(v - probe.frame[k][i]))));
    // Compared against the ENVELOPE, not the drawn mesh.
    //
    // The drawn solid is now a generic thread and Python has no thread. The CLAIM is
    // unchanged -- a capsule of the stated diameter and length, placed by this frame --
    // and that is what the STL exports, what 'plan_metrics' measures and what the 2-D
    // outline draws, so it is what has to match Python. 'implantGeometryForTest'
    // returns it built by the SAME 'capsuleLocal' and transformed by the SAME map, so
    // this still catches a shear, a mirrored axis or a wrong scale exactly as before.
    //
    // The JS mesh is INDEXED and the Python one is per-triangle, so the index buffer
    // is expanded and compared triangle for triangle in emission order. Comparing raw
    // vertex arrays by offset would compare ~380 unique vertices against 2160
    // duplicated ones and report an 8 mm error on geometry that matches to 1e-10.
    let vertexError = 0, sampled = 0;
    const env = probe.envelope || { points: probe.points, cells: probe.cells,
                                    nTris: probe.nTris };
    const cells = env.cells;
    pose.sampled_triangles.forEach(([ti, want]) => {
      const c = ti * 4;
      if (c + 3 >= cells.length) return;
      sampled++;
      for (let v = 0; v < 3; v++) {
        const base = cells[c + 1 + v] * 3;
        for (let k = 0; k < 3; k++) {
          vertexError = Math.max(vertexError,
                                 Math.abs(want[v][k] - env.points[base + k]));
        }
      }
    });
    // CONTAINMENT: every drawn vertex is inside the measured capsule, and the crest
    // reaches it. The capsule is convex -- a Minkowski sum of a segment and a ball --
    // so checking the vertices proves it for every point of every triangle, which is
    // strictly stronger than the 40 sampled triangles above. In the implant's own
    // frame, recovered by projecting onto the published axes.
    let outside = -Infinity, touch = Infinity, sliver = 0;
    {
      // A thread face that spans more than one PITCH in z is the signature of a profile
      // wrapped back to its own first station inside one column -- a triangle that jumps
      // backward a whole turn. It renders as a flat plate, and a stack of them reads as
      // a pile of discs rather than a screw. Measured on the real pane before the fix.
      // Only faces that vary in radius count: a plain cylinder wall spans the whole
      // barrel legitimately.
      const cl = probe.cells; const pts = probe.points;
      const o = probe.frame.origin, e1s = probe.frame.e1, e2s = probe.frame.e2, axs = probe.frame.ax;
      const loc = (i) => { const d = [pts[i]-o[0], pts[i+1]-o[1], pts[i+2]-o[2]];
        return [Math.hypot(dot(d, e1s), dot(d, e2s)), dot(d, axs)]; };
      for (let c = 0; c + 3 < cl.length; c += 4) {
        const v = [0,1,2].map((k) => loc(cl[c+1+k]*3));
        const rr = v.map((q) => q[0]); const zz = v.map((q) => q[1]);
        if (Math.max(...rr) - Math.min(...rr) < 0.05) continue;
        sliver = Math.max(sliver, Math.max(...zz) - Math.min(...zz));
      }
    }
    {
      const o = probe.frame.origin, e1 = probe.frame.e1, e2 = probe.frame.e2, ax = probe.frame.ax;
      const r = Number(pose.implant.diameter_mm) / 2;
      const shoulder = Math.max(0, Number(pose.implant.length_mm) - r);
      for (let i = 0; i < probe.points.length; i += 3) {
        const d = [probe.points[i] - o[0], probe.points[i+1] - o[1], probe.points[i+2] - o[2]];
        const a = dot(d, e1), b = dot(d, e2), c = dot(d, ax);
        const rho = Math.hypot(a, b);
        const out = c < 0 ? -c
          : (c > shoulder ? Math.hypot(rho, c - shoulder) - r : rho - r);
        outside = Math.max(outside, out);
        if (c > 0.4 && c < shoulder - 0.1) touch = Math.min(touch, Math.abs(rho - r));
      }
    }
    const orthoError = Math.max(
      Math.abs(dot(probe.frame.ax, probe.frame.e1)),
      Math.abs(dot(probe.frame.ax, probe.frame.e2)),
      Math.abs(dot(probe.frame.e1, probe.frame.e2)));

    poses.push({ frameError, vertexError, sampled, orthoError, outside, touch, sliver,
                 threadDepth: probe.profile ? probe.profile.depthMaxMm : 0,
                 // The ENVELOPE's tessellation is what must equal Python's. The drawn
                 // mesh is a thread and has its own count, which is checked separately
                 // by the containment bound rather than by a number.
                 trianglesMatch: (probe.envelope ? probe.envelope.nTris : probe.nTris)
                                 === pose.n_triangles });
    DentistryViewer.removeImplant('g');
  }

  // Behaviour: two implants, verdict colours, a drag, a removal, a resize, a teardown.
  const jaw = Object.keys(V.manifest)[0];
  const base = (id, s_mm) => ({ id, jaw, s_mm, t_mm: 0,
    z_mm: V.poses.find((p) => p.implant.jaw === jaw).implant.z_mm,
    tilt_deg: 0, yaw_deg: 0, length_mm: 10, diameter_mm: 4.1 });
  DentistryViewer.setImplants([{ ...base('i1', -4), verdict: 'breach' },
                               { ...base('i2', 6), verdict: 'clear' }]);
  const placed = DentistryViewer.debugState().implants;

  DentistryViewer.setImplantVerdict('i1', null);
  const neutral = DentistryViewer.debugState().implants;

  const centre = () => {
    const pr = DentistryViewer.implantGeometryForTest('i1');
    let sx = 0, sy = 0, sz = 0, n = pr.points.length / 3;
    for (let i = 0; i < pr.points.length; i += 3) {
      sx += pr.points[i]; sy += pr.points[i+1]; sz += pr.points[i+2];
    }
    return [sx/n, sy/n, sz/n];
  };
  const before = centre();
  DentistryViewer.updateImplant('i1', { t_mm: 3.0 });
  const after = centre();
  const moved = Math.hypot(after[0]-before[0], after[1]-before[1], after[2]-before[2]);

  const span = (b) => Math.max(b[1]-b[0], b[3]-b[2], b[5]-b[4]);
  const originalTriangles = DentistryViewer.implantGeometryForTest('i1').nTris;
  const b0 = DentistryViewer.implantGeometryForTest('i1').bounds;
  const originalSpan = span(b0);
  DentistryViewer.setImplants([{ ...base('i1', -4), t_mm: 3.0, length_mm: 16,
                                 diameter_mm: 6.0 },
                               base('i2', 6)]);
  const resizedTriangles = DentistryViewer.implantGeometryForTest('i1').nTris;
  const b1 = DentistryViewer.implantGeometryForTest('i1').bounds;
  const resizedSpan = span(b1);

  DentistryViewer.removeImplant('i2');
  const afterRemove = DentistryViewer.debugState().implants;

  await DentistryViewer.unmount();
  const st = DentistryViewer.debugState();
  return { poses, placed, neutral, moved, afterRemove,
           originalTriangles, resizedTriangles, originalSpan, resizedSpan,
           afterUnmount: st && st.implants ? st.implants : null };
})()`;

async function run(viewerPath, kase, label, probe = null) {
  const { srv, port } = await serve(viewerPath, kase);
  const profile = mkdtempSync(path.join(tmpdir(), 'viewereq-'));
  const dbgPort = 9800 + Math.floor(Math.random() * 300);
  const chrome = spawn('google-chrome', [
    '--headless=new', `--remote-debugging-port=${dbgPort}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--no-sandbox',
    '--disable-dev-shm-usage',
    // NOT --disable-gpu. See the module docstring: that flag is what made every previous
    // headless measurement of this viewer meaningless.
    '--use-angle=gl-egl', '--ozone-platform=headless',
    'about:blank',
  ], { stdio: 'ignore' });
  try {
    const c = await cdp(dbgPort);
    const { targetId } = await c.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await c.send('Target.attachToTarget', { targetId, flatten: true });
    await c.send('Page.enable', {}, sessionId);
    await c.send('Runtime.enable', {}, sessionId);
    await c.send('Page.addScriptToEvaluateOnNewDocument',
                 { source: 'window.DENTISTRY_NO_BOOT = true;' }, sessionId);
    const loaded = new Promise((res) => {
      const on = () => res();
      c.send('Page.navigate', { url: `http://127.0.0.1:${port}/index.html` }, sessionId)
        .then(() => setTimeout(on, 2500));
    });
    await loaded;
    const { result, exceptionDetails } = await c.send('Runtime.evaluate',
      { expression: probe || PROBE(kase.job), awaitPromise: true, returnByValue: true,
        timeout: 120000 }, sessionId);
    c.close();
    if (exceptionDetails) {
      console.log(`  ${label}: threw — `
        + (exceptionDetails.exception?.description || exceptionDetails.text || '?')
          .split('\n')[0]);
      return null;
    }
    return result.value;
  } finally {
    chrome.kill('SIGKILL');
    srv.close();
    await new Promise((r) => setTimeout(r, 300));
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* exiting */ }
  }
}

/* ---------------------------------------------------------------------- main */

const wanted = process.argv.includes('--case')
  ? process.argv[process.argv.indexOf('--case') + 1] : null;
const kase = findCase(wanted);
if (!kase) {
  console.error('no stored case with volume/ and mesh/ under data/tenants — '
    + 'process one first (scripts/tf3_seed_showcase.py)');
  process.exit(2);
}
if (!existsSync(CANDIDATE)) {
  console.error('no candidate — run: npm --prefix viewer run build:candidate');
  process.exit(2);
}
console.log(`case ${kase.job}\n`);

console.log('mounting under the SHIPPED bundle...');
const a = await run(SHIPPED, kase, 'shipped');
console.log('mounting under the CANDIDATE bundle...');
const b = await run(CANDIDATE, kase, 'candidate');

console.log('\nRuntime equivalence');
if (!a || !b) {
  check('both bundles mounted the case', false,
        `shipped ${a ? 'ok' : 'FAILED'}, candidate ${b ? 'ok' : 'FAILED'}`);
  console.log(`\nFAILURES: ${failures}`);
  process.exit(1);
}

// The renderer is asserted, not assumed. A comparison on SwiftShader would be two
// wrong answers agreeing with each other.
check('the browser rendered on a real GPU',
      /NVIDIA|AMD|Intel/i.test(a.renderer) && !/SwiftShader|Software/i.test(a.renderer),
      a.renderer);
check('both runs used the same renderer', a.renderer === b.renderer, b.renderer);

check('the same case mounted under both', a.mounted.centroids === b.mounted.centroids
      && JSON.stringify(a.mounted.labels) === JSON.stringify(b.mounted.labels),
      `${a.mounted.centroids} centroids, ${a.mounted.labels.length} labels`);
check('the arch centre agrees to 0.001 mm',
      JSON.stringify(a.mounted.archCentre) === JSON.stringify(b.mounted.archCentre),
      JSON.stringify(a.mounted.archCentre));
check('the volume rendered in both', a.mounted.volumeRendered === b.mounted.volumeRendered
      && a.mounted.volumeRendered === true, String(a.mounted.volumeRendered));
check('the same surfaces were added, with the same triangle counts',
      JSON.stringify(a.surfacesAdded) === JSON.stringify(b.surfacesAdded),
      `${a.surfacesAdded.length} surfaces, `
      + `${a.surfacesAdded.reduce((s, [, n]) => s + n, 0).toLocaleString()} triangles`);
check('the colour LUT took effect, read back from Cornerstone',
      a.state.lut && a.state.lut.ok === true && b.state.lut.ok === true,
      `${a.state.lut && a.state.lut.checked} segments checked, `
      + `${(a.state.lut && a.state.lut.mismatches || []).length} wrong`);
check('every surface actor carries its palette colour',
      a.state.surfaces.colorsMatchPalette === true
      && b.state.surfaces.colorsMatchPalette === true);
check('the same number of actors reached the 3D viewport',
      a.state.volumeActors === b.state.volumeActors,
      `${a.state.volumeActors} actors`);
check('the 3D camera lands in the same place',
      JSON.stringify(a.state.camera3d) === JSON.stringify(b.state.camera3d),
      JSON.stringify(a.state.camera3d));
check('the MPR viewports agree on slice and camera',
      JSON.stringify(a.state.viewports.map((v) => [v.id, v.slice, v.cam]))
      === JSON.stringify(b.state.viewports.map((v) => [v.id, v.slice, v.cam])));
check('visibility state agrees per viewport',
      JSON.stringify(a.state.hiddenPerViewport) === JSON.stringify(b.state.hiddenPerViewport));

/* Two normalisations, and BOTH are legitimately non-deterministic rather than
 * conveniently ignored:
 *
 *  - the mount counter. Volume and segmentation ids carry a per-mount sequence number
 *    and each run mounts once, so they differ by construction.
 *  - Cornerstone's volume-actor UUIDs. It mints a fresh v4 UUID per actor per mount, so
 *    these would not match between two runs of the SAME bundle either. Verified below
 *    rather than asserted: the deterministic uids -- `dent-surface-<index>`, which this
 *    viewer assigns itself -- are compared exactly, so normalising the random ones
 *    cannot hide a real difference in which actors exist.
 */
const norm = (s) => JSON.stringify(s)
  .replace(/(dentistrySegmentation:|dentistryLocal:(image|seg))\d+/g, '$1N')
  .replace(/"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"/g, '"UUID"');

// Where the deterministic uids actually are: the `dent-surface-<index>` actors live on
// the 3D viewport, and `debugState().viewports` lists only the three MPR ones. So the
// surface actors are compared by COUNT and by triangle total (above, via
// `surfacesAdded`) plus `surfaces.onViewport`, which is `volumeActors - surfaces.size`
// and is inside the compared blob. Asserting a uid list here would have been vacuous --
// it returned an empty array on both runs.
check('the surface actors reached the 3D viewport, and the same number of them',
      a.state.surfaces.added === b.state.surfaces.added
      && a.state.surfaces.added > 0
      && a.state.surfaces.onViewport === b.state.surfaces.onViewport,
      `${a.state.surfaces.added} surfaces, ${a.state.surfaces.triangles.toLocaleString()} `
      + `triangles, ${a.state.surfaces.onViewport} non-surface actor(s) beside them`);
check('  ... and the same number of actors exists per MPR viewport',
      JSON.stringify(a.state.viewports.map((v) => (v.actors || []).length))
      === JSON.stringify(b.state.viewports.map((v) => (v.actors || []).length)),
      JSON.stringify(a.state.viewports.map((v) => (v.actors || []).length)));
const blobA = norm({ ...a.state, implants: null });
const blobB = norm({ ...b.state, implants: null });
if (blobA !== blobB) {
  // Name the first divergence rather than just reporting inequality: a differential
  // test that says "they differ" and nothing else costs an afternoon.
  let i = 0;
  while (i < blobA.length && i < blobB.length && blobA[i] === blobB[i]) i++;
  const from = Math.max(0, i - 90);
  console.log(`        first divergence at char ${i}:`);
  console.log(`          shipped   ...${blobA.slice(from, i + 90)}`);
  console.log(`          candidate ...${blobB.slice(from, i + 90)}`);
}
check('the whole debugState blob is identical once the mount counter is normalised',
      blobA === blobB, 'the read-back state vector matches exactly');

// The candidate adds the implant registry; the shipped bundle has none.
check('the candidate exposes an implant registry and the shipped one does not',
      a.state.implants === undefined && b.state.implants
      && b.state.implants.count === 0 && b.state.implants.arch === false,
      `candidate: ${JSON.stringify(b.state.implants)}`);
check('the bundle revision moved', a.version === '5' && b.version === '6',
      `${a.version} -> ${b.version}`);

/* ------------------------------------------------------- the implant feature */

/* The implant registry is what the shipped bundle could not have, so there is nothing
 * to compare it against. It is verified against PYTHON instead: `tests/implant_vectors.
 * json` is generated from `dentistry/plan_geometry.implant_triangles_lps`, which is the
 * writer for the STL a user downloads. If the two disagree, the solid on screen is not
 * the solid in the file -- and that is not hypothetical: the Python side was placing a
 * SHEARED solid until 2026-09-02, because it used the buccal normal itself as a frame
 * axis, so the platform face was not perpendicular to the axis at any nonzero tilt.
 */
const VECTORS = path.join(ROOT, 'tests', 'implant_vectors.json');
if (!existsSync(VECTORS)) {
  check('the implant golden vectors exist', false, `${VECTORS} is missing`);
} else {
  const vec = JSON.parse(readFileSync(VECTORS, 'utf8'));
  console.log('\nThe implant feature, against Python');
  const res = await run(CANDIDATE, kase, 'implants', IMPLANT_PROBE(kase.job, vec));
  if (!res) {
    check('the implant probe ran', false, 'it threw; see above');
  } else {
    check('the browser placed every pose Python did',
          res.poses.length === vec.poses.length,
          `${res.poses.length} of ${vec.poses.length}`);
    const worstFrame = Math.max(...res.poses.map((p) => p.frameError));
    check('the LPS frame matches Python to 1e-9',
          worstFrame < 1e-9, `worst component error ${worstFrame.toExponential(2)}`);
    const worstVert = Math.max(...res.poses.map((p) => p.vertexError));
    check('every sampled vertex matches Python to 1e-4 mm',
          worstVert < 1e-4,
          `worst ${worstVert.toExponential(2)} mm over `
          + `${res.poses.reduce((n, p) => n + p.sampled, 0)} sampled vertices`);
    check('the triangle count matches, so the tessellation is the same solid',
          res.poses.every((p) => p.trianglesMatch),
          `${vec.poses[0].n_triangles} triangles per implant`);
    // The two assertions that replace "the drawn mesh IS Python's mesh", which stopped
    // being true the moment the display became a thread. What has to hold instead is
    // that the drawn solid is strictly INSIDE the measured one and TOUCHES it -- so the
    // display error is one-signed and in the safe direction, and the thread is a
    // rendering of the capsule rather than a different object.
    //
    // Non-vacuity: a screw whose crest radius exceeded the envelope fails the first;
    // reverting `screwLocal` to `capsuleLocal` leaves `touch` at 0 and passes both, so
    // the third check below is what insists a thread is actually there.
    const worstOut = Math.max(...res.poses.map((p) => p.outside));
    check('every drawn vertex is INSIDE the measured capsule',
          worstOut < 1e-4,
          `worst vertex ${worstOut.toExponential(2)} mm outside the envelope`);
    const worstSliver = Math.max(...res.poses.map((p) => p.sliver));
    check('  ... and no thread face jumps a whole turn, so it reads as a screw',
          worstSliver < 1.2,
          `worst radius-varying face spans ${worstSliver.toFixed(3)} mm of axis `
          + '(the pitch is 0.80 mm)');
    const worstTouch = Math.max(...res.poses.map((p) => p.touch));
    check('  ... and the thread crest reaches it, so the solid is not merely smaller',
          worstTouch < 1e-3,
          `crest sits ${worstTouch.toExponential(2)} mm inside the envelope`);
    check('  ... and the frame is orthonormal in the browser too',
          Math.max(...res.poses.map((p) => p.orthoError)) < 1e-9,
          `worst |dot| ${Math.max(...res.poses.map((p) => p.orthoError)).toExponential(2)}`);

    check('two implants become two solids and two safety envelopes on the 3D viewport',
          res.placed.count === 2 && res.placed.onViewport === 2
          && res.placed.shellsOnViewport === 2,
          JSON.stringify(res.placed));
    check('a verdict colours the SAFETY ENVELOPE, read back from vtk.js',
          res.placed.colorsMatchVerdicts === true
          && JSON.stringify(res.placed.verdicts) === '{"i1":"breach","i2":"clear"}',
          JSON.stringify(res.placed.verdicts));
    // The other half of moving the verdict off the body. Without this, "the implant is
    // always titanium" would be a comment rather than a property, and a regression that
    // tinted the body by verdict would pass every check above.
    check('  ... and the implant BODY stays titanium in every state',
          res.placed.bodyIsNeutral === true && res.neutral.bodyIsNeutral === true,
          'the body must never carry the verdict: the canal surface is already coral, '
          + 'and a red implant beside a red nerve is the alarm and its subject in one hue');
    check('a null verdict is NEUTRAL, not optimistic',
          res.neutral.colorsMatchVerdicts === true
          && res.neutral.verdicts.i1 === null,
          'the interval between a drag and the server reply must not read as safe');
    check('dragging an implant moves its geometry',
          res.moved > 0.5, `the actor centre moved ${res.moved.toFixed(2)} mm`);
    check('removing one leaves one, envelope and all',
          res.afterRemove.count === 1 && res.afterRemove.onViewport === 1
          && res.afterRemove.shellsOnViewport === 1,
          JSON.stringify(res.afterRemove));
    // The triangle COUNT cannot distinguish this -- `N_AZIMUTH` and `DOME_RINGS` are
    // constants, so every size tessellates to 720 triangles. What must change is the
    // extent: 10 x 4.1 mm to 16 x 6.0 mm is +6 mm of length and +1.9 mm of diameter, so
    // the bounding box has to grow by several millimetres. A stretched actor would keep
    // the same points and only differ by a transform, which is exactly what this
    // module does NOT do.
    check('a size change rebuilds the mesh, so its extent really changes',
          res.resizedSpan - res.originalSpan > 4.0,
          `longest bounding-box edge ${res.originalSpan.toFixed(2)} -> `
          + `${res.resizedSpan.toFixed(2)} mm for a 10x4.1 -> 16x6.0 implant`);
    check('unmount tears the implant actors down with the anatomy',
          res.afterUnmount === null || res.afterUnmount.count === 0,
          JSON.stringify(res.afterUnmount));
  }
}

console.log(`\n${failures ? `FAILURES: ${failures}` : 'ALL PASS'}`);
process.exit(failures ? 1 : 0);
