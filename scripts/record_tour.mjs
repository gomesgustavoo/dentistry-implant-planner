/* Record the product tour: the real app, the real API, a real case, on the real GPU.
 *
 * ## Why this is not a screen recording of the live site
 *
 * The live site is behind Keycloak, and a recording script has no business holding
 * somebody's credentials. It does not need to: everything the tour shows is the app
 * running against a finished case, and both halves of that exist locally.
 *
 *   * the REAL FastAPI app, started here by `scripts/record_tour.sh` with
 *     `DENT_REQUIRE_AUTH=false` -- a flag the service already has, which attributes an
 *     untokened request to the legacy tenant. Example cases are readable by anyone
 *     (`api/deps.load_owned`), and the tour uses an example. So the measurement endpoint
 *     in the video is the real one, computing against the real planning pack;
 *   * the REAL web bundle out of `web/`, unmodified.
 *
 * The only thing stubbed is the browser-side OIDC object, exactly as
 * `web-auth/check-rail.mjs` stubs it, and for the same reason: `app.js` captures
 * `window.DentistryAuth` at load, so a defineProperty guard has to win the race against
 * `auth.js`.
 *
 * ## The GPU is real, and getting it required NOT using a display
 *
 * The obvious recording rig -- Xvfb plus `ffmpeg -f x11grab` -- was built first and is
 * the wrong one on this box. Chrome on the X11 backend goes through DRI3, which this
 * virtual display does not provide, and Chrome answers by BLOCKLISTING WebGL entirely:
 *
 *     libEGL warning: DRI3 error: Could not get DRI3 device
 *     ContextResult::kFatalFailure: WebGL2 blocklisted
 *
 * The configuration that does reach the RTX 3080 is the one
 * `viewer/check-equivalence.mjs` already asserts a renderer string for:
 * `--headless=new --ozone-platform=headless --use-angle=gl-egl`, and NOT `--disable-gpu`.
 *
 * That has no X display to grab, so frames come over CDP. NOT `Page.startScreencast`,
 * which was tried and emits on compositor damage -- measured here at roughly one frame
 * every two seconds even while the 3-D pane was turning, i.e. a slideshow. A TIMED
 * `Page.captureScreenshot` loop asks for frames at a rate this script chooses, which is
 * both smoother and the reason the captions can be aligned at all: the video's clock and
 * the storyboard's clock are the same clock.
 *
 * Frames are exactly the page's -- no window chrome, no sandbox infobar, no cursor.
 *
 * A tour recorded on SwiftShader would be a video of a software rasteriser -- the volume
 * render and the 42 surfaces are precisely what would be too slow to look real -- so the
 * renderer string is checked and the run REFUSES rather than producing a slow-looking
 * video of a fast product.
 *
 * Usage (via the shell wrapper, which owns uvicorn, Chrome and ffmpeg):
 *     ./scripts/record_tour.sh
 */
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';

const PORT = Number(process.env.TOUR_PORT || 8807);
const DEBUG_PORT = Number(process.env.TOUR_DEBUG_PORT || 9333);
const CASE = process.env.TOUR_CASE || '';
const FRAMES = process.env.TOUR_FRAMES || '/tmp/dentistry-tour/frames';
// Capture rate. 10 is plenty for a UI tour and keeps a 140 s recording to ~1400 frames;
// the 3-D turntable is the only continuously moving thing and it turns 0.25 degrees a
// frame, so it reads as smooth well below cinema rates.
const FPS = Number(process.env.TOUR_FPS || 10);
const ROOT = path.dirname(path.dirname(new URL(import.meta.url).pathname));

/* ------------------------------------------------------------------ CDP plumbing */
async function cdp(debugPort) {
  const deadline = Date.now() + 60000;
  let info;
  for (;;) {
    try { info = await (await fetch(`http://127.0.0.1:${debugPort}/json/version`)).json(); break; }
    catch {
      if (Date.now() > deadline) throw new Error('no DevTools port');
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  const ws = new WebSocket(info.webSocketDebuggerUrl);
  await new Promise((ok, no) => { ws.onopen = ok; ws.onerror = () => no(new Error('cdp connect failed')); });
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
  const send = (method, params = {}, sessionId) => new Promise((ok, no) => {
    id += 1; waiting.set(id, { ok, no });
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  const on = (method, fn) => {
    if (!handlers.has(method)) handlers.set(method, []);
    handlers.get(method).push(fn);
  };
  return { send, on, ws };
}

/* The browser-side auth stub.
 *
 * Two things it has to get right, and the first recording got the second one wrong.
 *
 * 1. `app.js` reads `window.DentistryAuth` at module top level and `auth.js` assigns it,
 *    so this has to be a defineProperty that swallows the later assignment -- a plain
 *    object would be overwritten before boot() ran. Lifted from `check-rail.mjs`.
 *
 * 2. **`init()` must RESOLVE TO A USER.** `boot()` does `let user = await AUTH.init()`
 *    and calls `showSignIn()` on a falsy result -- so an `async () => {}` stub is signed
 *    in by `isSignedIn()` and signed OUT by the only test that decides what renders.
 *    `check-rail.mjs` never meets this because it sets `DENTISTRY_NO_BOOT` and calls
 *    render functions directly; a recording drives the real boot path and does.
 *    The first tour was 143 seconds of the sign-in gate for exactly this reason. */
const AUTH_STUB = `
const __tourUser = { sub: 'tour', name: 'Demo', email: 'demo@example.invalid',
                     preferred_username: 'demo' };
Object.defineProperty(window, 'DentistryAuth', {
  configurable: true,
  get: () => ({
    init: async () => __tourUser,
    isSignedIn: () => true,
    profile: () => __tourUser,
    signIn: () => {}, signOut: () => {},
    token: () => 'tour',
  }),
  set: () => {},
});
`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** One storyboard beat. `caption` is burned in later by ffmpeg from `beats.json`. */
const beats = [];
let t0 = 0;
function beat(caption, note = '') {
  const at = (Date.now() - t0) / 1000;
  beats.push({ at: Number(at.toFixed(2)), caption, note });
  console.log(`  ${at.toFixed(1).padStart(6)}s  ${caption}`);
}

async function main() {
  const { send, on } = await cdp(DEBUG_PORT);
  const targets = await send('Target.getTargets');
  const page = targets.targetInfos.find((t) => t.type === 'page');
  const { sessionId } = await send('Target.attachToTarget', { targetId: page.targetId, flatten: true });
  const ev = (m, p = {}) => send(m, p, sessionId);

  await ev('Page.enable');
  await ev('Runtime.enable');
  await ev('Page.addScriptToEvaluateOnNewDocument', { source: AUTH_STUB });

  const js = async (expression) => {
    const r = await ev('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) {
      const x = r.exceptionDetails.exception || {};
      throw new Error(x.description || x.value || r.exceptionDetails.text);
    }
    return r.result.value;
  };

  const base = `http://127.0.0.1:${PORT}`;
  // A HASH-ONLY navigation does not reload the document, so
  // `addScriptToEvaluateOnNewDocument` never fires and the auth stub never exists -- the
  // first recording of this tour was 143 seconds of the sign-in gate for exactly that
  // reason. A cache-busting query forces a real document load every time; the app's own
  // router reads the hash either way.
  let nav = 0;
  const go = async (hash) => {
    nav += 1;
    await ev('Page.navigate', { url: `${base}/index.html?tour=${nav}${hash}` });
    await sleep(1800);
  };

  // 2560x1440 regardless of any window the platform did or did not give us. Headless
  // Chrome's default viewport is 800x600 and would record a phone-shaped app.
  // 1920x1080, not 2560x1440. `Page.captureScreenshot` at 2560 measured about 3-4 frames
  // a second on this box, which reads as a slideshow however honest the timing is; 1920
  // roughly doubles the rate and is still a crisp target for a product tour. The pixels
  // this gives up are the ones nobody was going to look at.
  await ev('Emulation.setDeviceMetricsOverride', {
    width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false,
  });

  // Confirm the GPU before recording anything. A tour on SwiftShader is a video of a
  // software rasteriser and is not worth the disk.
  await go('#/cases');
  await sleep(3000);
  const renderer = await js(`(() => {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2') || c.getContext('webgl');
    if (!gl) return 'no webgl';
    const d = gl.getExtension('WEBGL_debug_renderer_info');
    return d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : 'unknown';
  })()`);
  console.log(`renderer: ${renderer}`);
  // "no webgl" has to fail too. The first run reported it and recorded anyway, because
  // the guard only looked for the word SwiftShader -- an absent context is a worse
  // outcome than a slow one, and it slipped through the check meant to catch it.
  if (!/nvidia|geforce/i.test(String(renderer))) {
    throw new Error(`refusing to record without the GPU: renderer is "${renderer}"`);
  }
  // ...and the app has to be PAST the gate. Asserted on the DOM rather than on
  // `isSignedIn()`: the first recording passed that check and filmed the sign-in card
  // anyway, because what decides the render is `await AUTH.init()` returning a user.
  const gated = await js(`(() => {
    const g = document.getElementById('signinGate');
    return !!(g && !g.hidden);
  })()`);
  if (gated) throw new Error('the app is showing the sign-in gate: the auth stub did not take');

  // The case with MISSING TEETH, deliberately. A full dentition has no edentulous site,
  // so every adjacent-tooth clearance comes back "not graded" and the tour would be a
  // tour of a caveat. This one is 30 of 32 with real gaps and 24 mm of bone at one molar
  // site and 14 at another, which is what makes the grading beat possible at all.
  const caseId = CASE || await js(`(async () => {
    const r = await fetch('/v1/examples').then((x) => x.json());
    const ex = (r.examples || []).find((e) => e.state === 'done' && /F_041/i.test(e.title || ''))
      || (r.examples || []).find((e) => e.state === 'done');
    return ex ? ex.id : '';
  })()`);
  if (!caseId) throw new Error('no finished example case to record');
  console.log(`case: ${caseId}`);

  // Open the case and let it mount BEFORE the capture loop starts, so the recording does
  // not open on twenty seconds of a loading spinner. The rail is forced open because its
  // collapsed state persists in localStorage and the dental chart lives in it.
  await go(`#/case/${caseId}`);
  await sleep(24000);
  await js(`(() => { try { toggleRail(false); } catch (e) {} })()`);
  await sleep(2500);
  const ready = await js(`(() => ({
    mounted: !!(window.state && state.viewer && state.viewer.mprMounted),
    planTab: !(document.getElementById('planTab') || {}).hidden,
  }))()`);
  console.log('ready:', JSON.stringify(ready));
  if (!ready.planTab) throw new Error('this case has no plan tab; nothing to record');

  // ------------------------------------------------------- the capture loop
  // A timed loop rather than the compositor's own stream: see the module docstring.
  // Frames are stamped with elapsed seconds from t0, which is the SAME clock the beats
  // use, so the captions cannot drift from what they name.
  //
  // It runs concurrently with the storyboard and is deliberately not awaited -- a
  // capture that blocked each step would stretch the very animations it is recording.
  rmSync(FRAMES, { recursive: true, force: true });
  mkdirSync(FRAMES, { recursive: true });
  const shots = [];
  let capturing = true;
  t0 = Date.now();
  const capture = (async () => {
    const period = 1000 / FPS;
    while (capturing) {
      const started = Date.now();
      try {
        const r = await ev('Page.captureScreenshot', { format: 'jpeg', quality: 88 });
        const i = shots.length;
        const name = `f${String(i).padStart(6, '0')}.jpg`;
        writeFileSync(path.join(FRAMES, name), Buffer.from(r.data, 'base64'));
        shots.push({ file: name, at: (started - t0) / 1000 });
      } catch { /* a navigation can drop one; the next tick recovers */ }
      const spent = Date.now() - started;
      if (spent < period) await sleep(period - spent);
    }
  })();

  console.log('\nrecording\n');

  /* ------------------------------------------------------------- the storyboard
   * IMPLANT-FIRST, and everything else cut.
   *
   * The first tour opened on the catalogue and the model picker and reached an implant
   * at 76 seconds. That is a tour of a settings page. What this product does that
   * nothing else does is grade a clearance with the segmentation's own measured error
   * subtracted -- so the tour is the implant, and the beat it is built around is a plan
   * going CLEAR -> TIGHT -> BREACH as it is pushed toward the canal.
   *
   * It also never touches the MPR panes, and that is not only editorial: those are the
   * one thing that does not render in a headless capture (`mprMounted` false,
   * "No imageId found within the specified criteria"). The plan tab is server-rendered
   * canvases plus vtk.js actors and captures perfectly, which `tour_probe.mjs` proved
   * before this was written.
   */

  // ---------------------------------------------------------------- 1. the site
  beat('Both jaws, every tooth numbered, the nerve canal found',
       'plan tab open on a finished case');
  await js(`(() => { const t = document.querySelector('[data-mode="plan"]'); if (t) t.click(); })()`);
  await sleep(11000);

  beat('Click a tooth position to plan an implant there');
  await sleep(3500);
  await js(`(() => {
    const el = document.querySelector('#archChart .tooth[data-fdi="46"]');
    if (el) el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  })()`);
  await sleep(15000);

  // ---------------------------------------------------------------- 2. the plan
  beat('A first molar seeds a 4.8 x 10 mm implant — the platform that tooth needs');
  await sleep(6000);

  beat('12.45 mm to the inferior alveolar canal. CLEAR.');
  await sleep(6000);

  beat('Every clearance graded with the model\u2019s own measured error subtracted');
  await sleep(6000);

  // ---------------------------------------------------------------- 3. in context
  beat('The implant in its neighbourhood — roots either side, canal below');
  await js(`(() => { if (window.selectImplant) selectImplant(implantState().implants[0].id); })()`);
  await sleep(9000);

  // ---------------------------------------------------------------- 4. angulation
  beat('Angulate it — the cross-section draws the true buccolingual angle');
  for (const _ of [1, 2, 3, 4]) {
    await js(`(() => {
      const inp = document.querySelector('#implantPanel input[data-f="tilt_deg"]');
      if (!inp) return;
      inp.value = String(Number(inp.value || 0) + 3);
      inp.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await sleep(2400);
  }
  await sleep(5000);

  // ---------------------------------------------------------------- 5. a tight site
  beat('A site where the canal is close: 14 mm of bone, not 24');
  await js(`(() => {
    const inp = document.querySelector('#implantPanel input[data-f="tilt_deg"]');
    if (inp) { inp.value = '0'; inp.dispatchEvent(new Event('change', { bubbles: true })); }
  })()`);
  await sleep(3000);
  await js(`(() => {
    const p = implantState();
    while (p.implants.length) {
      const id = p.implants[0].id; p.implants.shift();
      try { DentistryViewer.removeImplant(id); } catch (e) {}
    }
    p.measured = {}; renderImplantPanel();
    const el = document.querySelector('#archChart .tooth[data-fdi="38"]');
    if (el) el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  })()`);
  await sleep(17000);

  beat('It seeds SHORTER on its own — the longest length that measures clear here');
  await sleep(7000);

  // ---------------------------------------------------------------- 6. the grading
  beat('Push it deeper and the plan is graded, not just drawn');
  await js(`(() => { const i = implantState().implants[0]; i.length_mm = 10;
                     requestMeasure(0); renderImplantPanel(); })()`);
  await sleep(9000);

  beat('10 mm — TIGHT. 2.95 mm of clearance.');
  await sleep(6000);

  await js(`(() => { const i = implantState().implants[0]; i.length_mm = 11.5;
                     requestMeasure(0); renderImplantPanel(); })()`);
  await sleep(9000);

  beat('11.5 mm — BREACH. 1.85 mm, inside the margin.');
  await sleep(6500);

  // ---------------------------------------------------------------- 7. and back
  beat('Back to a plan that clears — and it says so in millimetres');
  await js(`(() => { const i = implantState().implants[0]; i.length_mm = 8;
                     requestMeasure(0); renderImplantPanel(); })()`);
  await sleep(10000);

  beat('dentistry.dicomsegvr.com — research preview, not a medical device');
  await sleep(5500);

  capturing = false;
  await capture;
  const total = (Date.now() - t0) / 1000;
  if (shots.length < 30) {
    throw new Error(`only ${shots.length} frames captured; the screencast did not run`);
  }
  // Already relative to t0, which is also the beats' zero -- no rebasing, which is the
  // point of sharing the clock.
  writeFileSync(path.join(FRAMES, 'frames.json'), JSON.stringify(
    shots.map((s) => ({ file: s.file, at: Number(s.at.toFixed(3)) })), null, 0));
  console.log(`\nstoryboard ran ${total.toFixed(1)}s, ${shots.length} frames`);
  console.log(JSON.stringify({ seconds: total, renderer, case: caseId,
                               frames: shots.length, beats }));
  return 0;
}

main().then(() => process.exit(0), (e) => { console.error('FAILED:', e.message); process.exit(1); });
