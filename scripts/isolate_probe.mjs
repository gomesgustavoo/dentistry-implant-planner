/* Does the MULTI-STRUCTURE isolate actually work on a real case, on a real GPU?
 *
 * `check-rail.mjs` drives the same code, but with no volume mounted: `pushVisibility`
 * returns early, `focusIsolated` returns false, and the 3-D pane does not exist. So it
 * proves the SET and the DOM and nothing about the thing the feature is for -- the
 * canal and the two teeth over it being visible together in one framed view.
 *
 * This mounts the real case, isolates three structures, and reads back what the viewer
 * itself believes: which surfaces are visible, and where the 3-D camera ended up. That
 * is the half no headless-fixture harness can see.
 *
 *   ./scripts/tour_stack.sh node scripts/isolate_probe.mjs
 */
import { writeFileSync } from 'node:fs';

const PORT = Number(process.env.TOUR_PORT || 8807);
const DEBUG_PORT = Number(process.env.TOUR_DEBUG_PORT || 9333);
const CASE = process.env.TOUR_CASE || '4aaa5797-69a3-4a3d-b8d2-bb8192a9b0fd';
const DIR = process.env.PROBE_DIR || '/tmp/dentistry-tour';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function cdp(port) {
  const deadline = Date.now() + 60000;
  let info;
  for (;;) {
    try { info = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); break; }
    catch { if (Date.now() > deadline) throw new Error('no DevTools'); await sleep(250); }
  }
  const ws = new WebSocket(info.webSocketDebuggerUrl);
  await new Promise((ok, no) => { ws.onopen = ok; ws.onerror = () => no(new Error('cdp')); });
  let id = 0; const waiting = new Map();
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && waiting.has(msg.id)) {
      const { ok, no } = waiting.get(msg.id); waiting.delete(msg.id);
      msg.error ? no(new Error(JSON.stringify(msg.error))) : ok(msg.result);
    }
  };
  return (m, p = {}, s) => new Promise((ok, no) => {
    id += 1; waiting.set(id, { ok, no });
    ws.send(JSON.stringify({ id, method: m, params: p, ...(s ? { sessionId: s } : {}) }));
  });
}

const AUTH_STUB = `
const __u = { sub: 'probe', name: 'Demo', email: 'demo@example.invalid' };
Object.defineProperty(window, 'DentistryAuth', { configurable: true,
  get: () => ({ init: async () => __u, isSignedIn: () => true, profile: () => __u,
                signIn: () => {}, signOut: () => {}, token: () => 'probe' }),
  set: () => {} });
`;

const send = await cdp(DEBUG_PORT);
const t = await send('Target.getTargets');
const page = t.targetInfos.find((x) => x.type === 'page');
const { sessionId } = await send('Target.attachToTarget', { targetId: page.targetId, flatten: true });
const ev = (m, p = {}) => send(m, p, sessionId);

await ev('Page.enable'); await ev('Runtime.enable');
await ev('Page.addScriptToEvaluateOnNewDocument', { source: AUTH_STUB });
await ev('Emulation.setDeviceMetricsOverride',
         { width: 2560, height: 1440, deviceScaleFactor: 1, mobile: false });

const js = async (e) => {
  const r = await ev('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) {
    const x = r.exceptionDetails.exception || {};
    return { __error: x.description || x.value || r.exceptionDetails.text };
  }
  return r.result.value;
};
const shot = async (name) => {
  const s = await ev('Page.captureScreenshot', { format: 'png' });
  const f = `${DIR}/${name}.png`;
  writeFileSync(f, Buffer.from(s.data, 'base64'));
  return f;
};

await ev('Page.navigate', { url: `http://127.0.0.1:${PORT}/index.html?iso=1#/case/${CASE}` });
console.log('mounting the real case…');
await sleep(30000);

// Read the camera from the viewer, not from a screenshot: a 3-D pane that renders the
// old framing and one that renders the new one are the same picture to a pixel count
// when the change is a zoom.
const CAM = `(() => {
  try {
    const d = DentistryViewer.debugState();
    return d && d.camera3d ? d.camera3d : null;
  } catch (e) { return { err: e.message }; }
})()`;

// `debugState().surfaces` reports the meshes that EXIST and the ones hidden, so what is
// showing is the difference. Read that way round rather than trusting the app's own
// `hidden` set -- the whole point is whether the app's intent reached the viewer.
const SHOWING = `(() => {
  try {
    const s = DentistryViewer.debugState().surfaces;
    return { added: s.added, hidden: s.hidden.slice().sort((a, b) => a - b),
             showing: s.added - s.hidden.length };
  } catch (e) { return { err: e.message }; }
})()`;

let failures = 0;
const check = (ok, msg) => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${msg}`); if (!ok) failures += 1; };

const mounted = await js(`(() => ({
  mounted: !!(state.viewer && state.viewer.mprMounted),
  surfaces: (() => { try { return DentistryViewer.debugState().surfaces.added; } catch (e) { return -1; } })(),
  present: presentIndices().size,
}))()`);
console.log(JSON.stringify(mounted));
check(mounted.mounted === true, 'the volume mounted (without this every assertion below is vacuous)');

// The three that make the feature worth having: the canal a molar is graded against,
// and the two teeth either side of the site.
const pick = await js(`(() => {
  const all = allStructures();
  const vols = ((state.viewer.report.quality || {}).volumes_cm3) || {};
  const has = (id) => all.find((s) => s.id === id && vols[s.id] != null);
  const canal = has('canal_mand_right') || all.find((s) => /canal/.test(s.id) && vols[s.id] != null);
  const t1 = has('tooth_46') || has('tooth_47');
  const t2 = has('tooth_45') || has('tooth_44');
  return { canal: canal && canal.index, t1: t1 && t1.index, t2: t2 && t2.index,
           names: [canal, t1, t2].filter(Boolean).map((s) => s.id) };
})()`);
console.log('picked:', JSON.stringify(pick));

const run = async (expr) => js(expr);

await run(`toggleIsolate(${pick.canal})`);
await sleep(1200);
const one = await run(`(() => ({
  size: state.viewer.isolated.size,
  surf: ${SHOWING},
  cam: ${CAM},
}))()`);
console.log('one:', JSON.stringify(one));

await run(`toggleIsolate(${pick.t1}, true)`);
await run(`toggleIsolate(${pick.t2}, true)`);
await sleep(1500);
const three = await run(`(() => ({
  size: state.viewer.isolated.size,
  hidden: state.viewer.hidden.size,
  surf: ${SHOWING},
  cam: ${CAM},
  label: (document.getElementById('isolateClear') || {}).textContent,
  sel: document.querySelectorAll('#structures .srow.sel').length,
}))()`);
console.log('three:', JSON.stringify(three));

check(three.size === 3, `three structures isolated at once — got ${three.size}`);
check(three.hidden === mounted.present - 3,
      `${three.hidden} hidden of ${mounted.present} present, expected ${mounted.present - 3}`);
check(three.sel === 3, `${three.sel} rows marked as isolated, expected 3`);
check(/\(3\)/.test(String(three.label || '')), `the clear button carries the count — "${three.label}"`);
if (three.surf && !three.surf.err) {
  const want = [pick.canal, pick.t1, pick.t2];
  const stillHidden = want.filter((i) => three.surf.hidden.includes(i));
  check(stillHidden.length === 0,
        `every isolated structure reached the 3-D pane VISIBLE — hidden anyway: ${JSON.stringify(stillHidden)}`);
  check(three.surf.showing === 3,
        `exactly 3 surfaces are showing of ${three.surf.added} — got ${three.surf.showing}`);
}
// The camera must have MOVED between one and three, and the parallel scale must have
// grown: framing three structures on one structure's zoom is the defect this exists for.
if (one.cam && three.cam && one.cam.parallelScale && three.cam.parallelScale) {
  check(three.cam.parallelScale > one.cam.parallelScale * 1.05,
        `the 3-D pane zoomed OUT to fit all three — ${one.cam.parallelScale.toFixed(1)}`
        + ` -> ${three.cam.parallelScale.toFixed(1)}`);
} else {
  console.log('  note  no camera read-back; add camera3d to debugState() to assert framing');
}
console.log('frame:', await shot('isolate-three'));

await run('clearIsolate()');
await sleep(1200);
const cleared = await run(`(() => ({
  size: state.viewer.isolated.size, hidden: state.viewer.hidden.size,
  surf: ${SHOWING},
  btn: (document.getElementById('isolateClear') || {}).hidden,
}))()`);
console.log('cleared:', JSON.stringify(cleared));
check(cleared.size === 0 && cleared.hidden === 0, 'clearing put every structure back');
if (cleared.surf && !cleared.surf.err) {
  check(cleared.surf.hidden.length === 0,
        `no surface is left hidden after clearing — ${cleared.surf.hidden.length} still hidden`);
}
check(cleared.btn === true, 'the clear button hid itself');
console.log('frame:', await shot('isolate-cleared'));

console.log(failures ? `\nFAILURES: ${failures}` : '\nALL PASS');
process.exit(failures ? 1 : 0);
