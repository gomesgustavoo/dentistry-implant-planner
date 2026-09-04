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
  await ev('Emulation.setDeviceMetricsOverride', {
    width: 2560, height: 1440, deviceScaleFactor: 1, mobile: false,
  });

  // Confirm the GPU before recording anything. A tour on SwiftShader is a video of a
  // software rasteriser and is not worth the disk.
  await go('#/cases');
  await sleep(2500);
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

  const caseId = CASE || await js(`(async () => {
    const r = await fetch('/v1/examples').then((x) => x.json());
    const ex = (r.examples || []).find((e) => e.state === 'done' && /Full dentition/i.test(e.title || ''))
      || (r.examples || []).find((e) => e.state === 'done');
    return ex ? ex.id : '';
  })()`);
  if (!caseId) throw new Error('no finished example case to record');
  console.log(`case: ${caseId}`);

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

  // ---------------------------------------------------------------- 1. the picker
  beat('Every tooth gets one number', 'the catalogue page, real segmented dentition spinning');
  await go('#/cases');
  await sleep(9000);

  beat('47 structures from one model on one GPU');
  await js(`window.scrollTo({top: 260, behavior: 'smooth'})`);
  await sleep(4500);

  beat('The picker shows what each model owns, and what is measured about it');
  await js(`(() => {
    const c = [...document.querySelectorAll('.modelcard')][1];
    if (c) { c.scrollIntoView({block:'center', behavior:'smooth'}); c.dispatchEvent(new Event('mouseenter')); }
  })()`);
  await sleep(5000);
  await js(`document.querySelectorAll('.modelcard').forEach(c => c.dispatchEvent(new Event('mouseleave')))`);
  await js(`window.scrollTo({top: 0, behavior: 'smooth'})`);
  await sleep(2000);

  // ---------------------------------------------------------------- 2. the case
  beat('A finished case: both jaws, 32 teeth, the canal');
  await go(`#/case/${caseId}`);
  await sleep(16000);

  beat('MPR on the raw voxels, and 42 smoothed surfaces in 3-D');
  await sleep(6000);

  // ---------------------------------------------------------------- 3. the dock
  beat('Filter 47 structures down to the ones you are reading');
  await js(`(() => {
    const f = document.getElementById('structFilter');
    if (!f) return;
    f.value = 'canal'; f.dispatchEvent(new Event('input'));
  })()`);
  await sleep(4500);

  beat('Isolate the mandibular canal — every pane follows');
  await js(`(() => {
    const row = [...document.querySelectorAll('#structures .srow')]
      .find(r => /Mandibular canal/.test(r.textContent));
    if (row) row.querySelector('.name').click();
  })()`);
  await sleep(7000);

  await js(`(() => {
    const b = document.getElementById('isolateClear'); if (b && !b.hidden) b.click();
    const f = document.getElementById('structFilter');
    if (f) { f.value = ''; f.dispatchEvent(new Event('input')); }
  })()`);
  await sleep(3500);

  // ---------------------------------------------------------------- 4. correcting
  beat('Correct the mask — and see the cost before the stroke');
  await js(`document.getElementById('editBtn').click()`);
  await sleep(2500);
  await js(`(() => {
    const sel = document.getElementById('editSegment');
    const opt = [...sel.options].find(o => /Mandibular canal/.test(o.textContent));
    if (opt) { sel.value = opt.value; sel.dispatchEvent(new Event('change')); }
  })()`);
  await sleep(6500);

  beat('0.46 mm model + 0.30 mm grid = 0.76 mm off every clearance');
  await sleep(5000);
  await js(`document.getElementById('editBtn').click()`);
  await sleep(2000);

  // ---------------------------------------------------------------- 5. the plan
  beat('Place an implant');
  await js(`document.querySelector('[data-mode="plan"]').click()`);
  await sleep(9000);
  await js(`(() => {
    const b = [...document.querySelectorAll('button')].find(x => /add implant/i.test(x.textContent));
    if (b) b.click();
  })()`);
  await sleep(11000);

  beat('Graded against the canal, the incisive canals and the neighbouring teeth');
  await sleep(6000);

  beat('The safety envelope carries the worst grade, at the surface it is graded on');
  await js(`(() => {
    if (window.DentistryViewer && DentistryViewer.focusImplant) DentistryViewer.focusImplant('i1');
  })()`);
  await sleep(8000);

  beat('Angulate it — the section draws the true angle, the panoramic the other one');
  for (const _ of [1, 2, 3, 4]) {
    await js(`(() => {
      const inp = document.querySelector('#implantPanel input[data-f="tilt_deg"]');
      if (!inp) return;
      inp.value = String(Number(inp.value || 0) + 4);
      inp.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await sleep(2200);
  }
  await sleep(5000);

  beat('Every clearance, with that structure’s own measured error subtracted');
  await js(`(() => {
    if (window.DentistryViewer && DentistryViewer.resetCameras) DentistryViewer.resetCameras();
    if (window.DentistryViewer && DentistryViewer.surfacesReady) DentistryViewer.surfacesReady();
  })()`);
  await sleep(7000);

  beat('dentistry.dicomsegvr.com — research preview, not a medical device');
  await sleep(4500);

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
