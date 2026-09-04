/* Why are the MPR panes black in the recording? Ask the viewer, do not guess.
 *
 * Mounts the tour's own case through the tour's own server, in the tour's own Chrome
 * configuration, and reads back `DentistryViewer.debugState()` plus every failed network
 * request. `viewer/check-equivalence.mjs` mounts the same case headless successfully but
 * serves artifacts straight off disk; this serves them through the API, and the whole
 * question is whether that difference is what breaks the volume.
 *
 *   node scripts/tour_probe.mjs            # expects record_tour.sh's servers to be up
 */
const PORT = Number(process.env.TOUR_PORT || 8807);
const DEBUG_PORT = Number(process.env.TOUR_DEBUG_PORT || 9333);
const CASE = process.env.TOUR_CASE || 'e9d0c06b-0e97-4c00-a43c-d9ea0ba8200e';

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

const bad = [];
const consoleErrs = [];
on('Network.responseReceived', (p) => {
  if (p.response.status >= 400) bad.push(`${p.response.status} ${p.response.url}`);
});
on('Network.loadingFailed', (p) => bad.push(`FAILED ${p.errorText} ${p.requestId}`));
on('Log.entryAdded', (p) => {
  if (p.entry.level === 'error') consoleErrs.push(p.entry.text.slice(0, 200));
});
on('Runtime.consoleAPICalled', (p) => {
  if (p.type === 'error' || p.type === 'warning') {
    consoleErrs.push((p.args || []).map((a) => a.value || a.description || '').join(' ').slice(0, 200));
  }
});

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
await sleep(30000);

console.log('\n--- viewer state -------------------------------------------------');
console.log(JSON.stringify(await js(`(() => {
  if (!window.DentistryViewer || !DentistryViewer.debugState) return 'no viewer';
  const s = DentistryViewer.debugState();
  if (!s) return 'debugState() is null — nothing mounted';
  return {
    volumeRendered: s.volumeRendered, surfaces: s.surfaces && s.surfaces.length,
    lutOk: s.lut && s.lut.ok, mprCameras: s.mpr && s.mpr.map(v => v.slice),
    actorsPerMpr: s.actorsPerViewport, mounted: s.mounts,
  };
})()`), null, 1));

console.log('\n--- app state ----------------------------------------------------');
console.log(JSON.stringify(await js(`(() => ({
  gated: !!(document.getElementById('signinGate') && !document.getElementById('signinGate').hidden),
  mode: (document.querySelector('.mode.on')||{}).dataset ? document.querySelector('.mode.on').dataset.mode : null,
  planTabHidden: (document.getElementById('planTab')||{}).hidden,
  mprMounted: !!(window.state && state.viewer && state.viewer.mprMounted),
  volumeMeta: !!(window.state && state.viewer && state.viewer.volumeMeta),
  mprLoadingText: (document.getElementById('mprMeta')||{}).textContent,
  rows: document.querySelectorAll('#structures .srow').length,
}))()`), null, 1));

console.log('\n--- canvas pixels (chromatic count per MPR pane) ------------------');
console.log(JSON.stringify(await js(`(() => {
  const out = {};
  ['csAxial','csCoronal','csSagittal','cs3d'].forEach((id) => {
    const host = document.getElementById(id);
    const c = host && host.querySelector('canvas');
    if (!c) { out[id] = 'no canvas'; return; }
    out[id] = { w: c.width, h: c.height };
  });
  return out;
})()`), null, 1));

console.log('\n--- failed requests ----------------------------------------------');
console.log(bad.length ? bad.slice(0, 15).join('\n') : '(none)');
console.log('\n--- console errors -----------------------------------------------');
console.log(consoleErrs.length ? [...new Set(consoleErrs)].slice(0, 12).join('\n') : '(none)');
process.exit(0);
