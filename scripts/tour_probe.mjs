/* Can the PLAN TAB be captured headless? Ask it, do not guess.
 *
 * The first tour recording found the Cornerstone MPR panes black in headless capture --
 * `volumeRendered: true`, `lut.ok: true`, canvases present, and `mprMounted` false with
 * `No imageId found within the specified criteria` on the console. That killed a tour
 * built around the MPR view.
 *
 * The plan tab is a different stack: the panoramic and the cross-section are SERVER-
 * rendered images drawn to plain 2-D canvases, and the 3-D pane is vtk.js actors, which
 * did render in that same capture. So a tour built around the implant may capture
 * perfectly where one built around MPR could not. This settles it by placing a real
 * implant and writing the frame to disk.
 *
 *   node scripts/tour_probe.mjs                 # expects tour_stack.sh's servers up
 */
import { writeFileSync } from 'node:fs';

const PORT = Number(process.env.TOUR_PORT || 8807);
const DEBUG_PORT = Number(process.env.TOUR_DEBUG_PORT || 9333);
const CASE = process.env.TOUR_CASE || '4aaa5797-69a3-4a3d-b8d2-bb8192a9b0fd';
const OUT = process.env.TOUR_PROBE_OUT || '/tmp/dentistry-tour/probe.png';

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
  let id = 0; const waiting = new Map(); const handlers = new Map();
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && waiting.has(msg.id)) {
      const { ok, no } = waiting.get(msg.id); waiting.delete(msg.id);
      msg.error ? no(new Error(JSON.stringify(msg.error))) : ok(msg.result);
    } else if (msg.method && handlers.has(msg.method)) {
      handlers.get(msg.method).forEach((f) => f(msg.params));
    }
  };
  const send = (m, p = {}, s) => new Promise((ok, no) => {
    id += 1; waiting.set(id, { ok, no });
    ws.send(JSON.stringify({ id, method: m, params: p, ...(s ? { sessionId: s } : {}) }));
  });
  const on = (m, f) => { if (!handlers.has(m)) handlers.set(m, []); handlers.get(m).push(f); };
  return { send, on };
}

const AUTH_STUB = `
const __u = { sub: 'tour', name: 'Demo', email: 'demo@example.invalid' };
Object.defineProperty(window, 'DentistryAuth', { configurable: true,
  get: () => ({ init: async () => __u, isSignedIn: () => true, profile: () => __u,
                signIn: () => {}, signOut: () => {}, token: () => 'tour' }),
  set: () => {} });
`;

const { send, on } = await cdp(DEBUG_PORT);
const t = await send('Target.getTargets');
const page = t.targetInfos.find((x) => x.type === 'page');
const { sessionId } = await send('Target.attachToTarget', { targetId: page.targetId, flatten: true });
const ev = (m, p = {}) => send(m, p, sessionId);

await ev('Page.enable'); await ev('Runtime.enable'); await ev('Network.enable');
await ev('Log.enable');
await ev('Page.addScriptToEvaluateOnNewDocument', { source: AUTH_STUB });
await ev('Emulation.setDeviceMetricsOverride',
         { width: 2560, height: 1440, deviceScaleFactor: 1, mobile: false });

const bad = []; const errs = [];
on('Network.responseReceived', (p) => {
  if (p.response.status >= 400) bad.push(`${p.response.status} ${p.response.url.slice(-70)}`);
});
on('Log.entryAdded', (p) => { if (p.entry.level === 'error') errs.push(p.entry.text.slice(0, 160)); });

const js = async (expression) => {
  const r = await ev('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) {
    const x = r.exceptionDetails.exception || {};
    return { __error: x.description || x.value || r.exceptionDetails.text };
  }
  return r.result.value;
};

await ev('Page.navigate', { url: `http://127.0.0.1:${PORT}/index.html?probe=1#/case/${CASE}` });
console.log('mounting…');
await sleep(26000);

console.log('\n--- into the plan tab, and place a real implant --------------------');
console.log(await js(`(async () => {
  const tab = document.querySelector('[data-mode="plan"]');
  if (!tab || tab.hidden) return 'no plan tab';
  tab.click();
  await new Promise(r => setTimeout(r, 11000));
  const site = document.querySelector('#archChart .tooth[data-fdi="46"]');
  if (!site) return 'no site 46 on the chart';
  site.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  await new Promise(r => setTimeout(r, 16000));
  const p = implantState();
  const i = p.implants[0];
  if (!i) return 'no implant placed';
  const m = p.measured[i.id] || {};
  return JSON.stringify({
    fdi: i.site_fdi, dia: i.diameter_mm, len: i.length_mm,
    canal: (m.verdict || {}).level,
    shell: DentistryViewer.debugState().implants.verdicts[i.id],
  });
})()`));

console.log('\n--- do the plan tab canvases actually have PIXELS? -----------------');
// Chromatic-pixel counting, the method this repo already relies on: it separates "a
// canvas exists" from "something was drawn on it", which a screenshot cannot.
console.log(JSON.stringify(await js(`(() => {
  const out = {};
  const count = (c) => {
    if (!c || !c.width) return 'no canvas';
    try {
      const g = c.getContext('2d');
      if (!g) return 'webgl (no 2d readback)';
      const d = g.getImageData(0, 0, c.width, c.height).data;
      let lit = 0;
      for (let k = 0; k < d.length; k += 4) if (d[k] + d[k+1] + d[k+2] > 40) lit++;
      return { px: c.width + 'x' + c.height, lit };
    } catch (e) { return 'err: ' + e.message; }
  };
  out.panoramic = count(document.getElementById('panCanvas'));
  out.section = count(document.getElementById('xsCanvas'));
  const g3 = document.querySelector('#cs3d canvas');
  out.pane3d = g3 ? { px: g3.width + 'x' + g3.height, webgl: true } : 'no canvas';
  return out;
})()`), null, 1));

console.log('\n--- writing a frame to disk ---------------------------------------');
const shot = await ev('Page.captureScreenshot', { format: 'png' });
writeFileSync(OUT, Buffer.from(shot.data, 'base64'));
console.log(OUT);

console.log('\n--- failed requests ---'); console.log(bad.length ? [...new Set(bad)].slice(0, 8).join('\n') : '(none)');
console.log('\n--- console errors ---'); console.log(errs.length ? [...new Set(errs)].slice(0, 6).join('\n') : '(none)');
process.exit(0);
