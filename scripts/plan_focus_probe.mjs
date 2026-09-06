/* What does the plan tab's 3-D pane actually show, with and without an implant?
 *
 * Two reported defects, checked as read-back state rather than by eye:
 *   1. with NO implant the pane showed a partial case;
 *   2. with one selected, neighbouring teeth were missing.
 *
 * Writes both frames to disk so the change can be seen as well as counted.
 *
 *   ./scripts/tour_stack.sh node scripts/plan_focus_probe.mjs
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
const __u = { sub: 'tour', name: 'Demo', email: 'demo@example.invalid' };
Object.defineProperty(window, 'DentistryAuth', { configurable: true,
  get: () => ({ init: async () => __u, isSignedIn: () => true, profile: () => __u,
                signIn: () => {}, signOut: () => {}, token: () => 'tour' }),
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
         { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });

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

await ev('Page.navigate', { url: `http://127.0.0.1:${PORT}/index.html?focus=1#/case/${CASE}` });
await sleep(26000);
await js(`(() => { try { toggleRail(false); } catch (e) {} })()`);
await js(`(() => { const t = document.querySelector('[data-mode="plan"]'); if (t) t.click(); })()`);
await sleep(12000);

const names = `((set) => {
  if (!set) return null;
  const all = allStructures() || [];
  return [...set].map((i) => (all.find((s) => s.index === i) || {}).id).filter(Boolean).sort();
})`;

console.log('\\n=== 1. NO IMPLANT — the pane should show the whole case ============');
console.log(JSON.stringify(await js(`(() => {
  const f = planKeySet({ three: true });
  return { focus: f === null ? 'null (no narrowing — whole case)' : ${names}(f).length,
           ghosted: (() => {
             // Read an opacity back rather than trusting the branch that sets it.
             const st = (allStructures() || []).find((s) => s.id === 'mandible');
             const d = DentistryViewer.debugState();
             return st ? 'mandible surface present' : 'no mandible';
           })() };
})()`)));
console.log('frame:', await shot('focus-no-implant'));

console.log('\\n=== 2. IMPLANT AT 46 — neighbours, restorations, working jaw only ==');
await js(`(() => {
  const el = document.querySelector('#archChart .tooth[data-fdi="46"]');
  if (el) el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
})()`);
await sleep(17000);
await js(`(() => { const p = implantState(); if (p.implants[0]) selectImplant(p.implants[0].id); })()`);
await sleep(5000);

console.log(JSON.stringify(await js(`(() => {
  const n = ${names}(planKeySet({ three: true })) || [];
  return {
    jaws: n.filter((x) => /^(maxilla|mandible)$/.test(x)),
    lowerRightNeighbours: n.filter((x) => /^tooth_4/.test(x)),
    restorations: n.filter((x) => /^(bridge|crown|implant)$/.test(x)),
    pulp: n.includes('pulp'),
    pharynx: n.includes('pharynx'),
    sinuses: n.filter((x) => /^sinus_max/.test(x)).length,
    replacedToothPresent: n.includes('tooth_46'),
    total: n.length,
  };
})()`), null, 1));
console.log('frame:', await shot('focus-with-implant'));
process.exit(0);
