/* The ImplantPlan trailer: drive the real app, capture frames, emit the storyboard.
 *
 * A sibling of `record_tour.mjs`, not a replacement for it. That one is the
 * DOCUMENTATION tour -- 161 seconds, fourteen beats, every caveat in shot. This is a
 * ~90-second piece with one argument to make, so it keeps that script's rig (the CDP
 * client, the auth stub, the GPU guard, the timed capture loop) and replaces its
 * storyboard and its copy. Both are kept because a trailer that drifts into
 * completeness stops being a trailer, and a tour that drifts into salesmanship stops
 * being documentation.
 *
 * ## The argument
 *
 * Every planner draws the nerve. This one states how wrong the nerve might be and
 * SUBTRACTS it, and then refuses a verdict rather than guessing. So the spine is one
 * plan going CLEAR -> TIGHT -> BREACH as it is pushed toward the canal, which is also
 * the only beat the previous recording proved captures well.
 *
 * ## What is deliberately not filmed
 *
 * The MPR panes. `tour_probe.mjs` settled that headless: `volumeRendered: true`,
 * `lut.ok: true`, canvases present at 738x662, and `mprMounted` false with "No imageId
 * found within the specified criteria" on the console. The plan tab is a different
 * stack -- server-rendered images on 2-D canvases plus vtk.js actors -- and captures
 * perfectly. A trailer built on the MPR view would be a trailer of black rectangles.
 *
 * ## The dataset credit
 *
 * The case subtitle carries "ToothFairy3 (CC BY-NC-SA), held out of training". It is
 * blanked below FOR THE RECORDING ONLY -- a DOM write in this script, never a change to
 * what a user sees -- because the piece is about implant planning and the credit does
 * not belong burned into all ninety seconds of it. CC BY-NC-SA is BY as well as NC, so
 * the attribution is not dropped: it ships on the end card, which `trailer_overlays.py`
 * builds from `CREDITS`.
 *
 *     ./scripts/record_trailer.sh
 */
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';

const PORT = Number(process.env.TOUR_PORT || 8807);
const DEBUG_PORT = Number(process.env.TOUR_DEBUG_PORT || 9333);
const CASE = process.env.TOUR_CASE || '';
const FRAMES = process.env.TOUR_FRAMES || '/tmp/dentistry-trailer/frames';
const FPS = Number(process.env.TOUR_FPS || 10);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ CDP plumbing */
async function cdp(debugPort) {
  const deadline = Date.now() + 60000;
  let info;
  for (;;) {
    try { info = await (await fetch(`http://127.0.0.1:${debugPort}/json/version`)).json(); break; }
    catch {
      if (Date.now() > deadline) throw new Error('no DevTools port');
      await sleep(250);
    }
  }
  const ws = new WebSocket(info.webSocketDebuggerUrl);
  await new Promise((ok, no) => { ws.onopen = ok; ws.onerror = () => no(new Error('cdp connect failed')); });
  let id = 0; const waiting = new Map();
  let dead = null;
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && waiting.has(msg.id)) {
      const { ok, no } = waiting.get(msg.id); waiting.delete(msg.id);
      msg.error ? no(new Error(JSON.stringify(msg.error))) : ok(msg.result);
    }
  };
  /* A CLOSED SOCKET MUST REJECT, or the recorder ends silently mid-take.
   *
   * Measured: a stale Chrome from a killed run still held :9333, the new one failed to
   * bind, and this client attached to the ORPHAN -- which later died. Every in-flight
   * promise, in `main()` and in the capture loop alike, then simply never settled. Both
   * were awaiting a CDP reply rather than a timer, so nothing was left holding the event
   * loop open and node exited ZERO, forty seconds into a ninety-second storyboard, with
   * no error anywhere. The shell then assembled the 371 frames it had and reported
   * success. A truncated recording that claims to have worked is the worst outcome this
   * script has, worse than any crash. */
  const fail = (why) => {
    if (!dead) dead = new Error(`CDP socket ${why} -- the browser went away mid-recording`);
    for (const [, { no }] of waiting) no(dead);
    waiting.clear();
  };
  ws.onclose = () => fail('closed');
  ws.onerror = () => fail('errored');
  /* ...and a TIMEOUT on every call, because a closed socket is only the tidiest way for
   * the browser to die. The messier one, measured here: `pkill` took most of Chrome but
   * left one process holding the socket OPEN. Nothing closed, nothing errored, so
   * `onclose` never fired -- the pending call simply hung, the capture loop hung with it
   * on its own pending call, and the run sat at 57 s of 90 producing no frames and no
   * error for as long as anyone let it. A hung call is indistinguishable from a slow one
   * except by the clock, so the clock is what decides.
   * 45 s is far longer than any legitimate call in this script; the slowest is a
   * screenshot of a 3-D pane mid-render, measured in tens of milliseconds. */
  const CALL_TIMEOUT_MS = Number(process.env.TOUR_CALL_TIMEOUT_MS || 45000);
  return (method, params = {}, sessionId) => new Promise((ok, no) => {
    if (dead) { no(dead); return; }
    id += 1;
    const mine = id;
    const timer = setTimeout(() => {
      if (!waiting.has(mine)) return;
      waiting.delete(mine);
      no(new Error(`CDP ${method} did not answer in ${CALL_TIMEOUT_MS} ms `
                 + '-- the browser is up but not responding'));
    }, CALL_TIMEOUT_MS);
    waiting.set(mine, {
      ok: (v) => { clearTimeout(timer); ok(v); },
      no: (e) => { clearTimeout(timer); no(e); },
    });
    try {
      ws.send(JSON.stringify({ id: mine, method, params, ...(sessionId ? { sessionId } : {}) }));
    } catch (e) {
      clearTimeout(timer); waiting.delete(mine); no(e);
    }
  });
}

/* Verbatim from `record_tour.mjs`, including the reason it is a defineProperty getter:
 * `app.js` reads `window.DentistryAuth` at module top level and `auth.js` assigns it, so
 * a plain object is overwritten before boot() runs. And `init()` must RESOLVE TO A USER
 * -- `boot()` calls showSignIn() on a falsy result, so `async () => {}` is signed in by
 * isSignedIn() and signed out by the only test that decides what renders. */
const AUTH_STUB = `
const __u = { sub: 'trailer', name: 'Demo', email: 'demo@example.invalid',
              preferred_username: 'demo' };
Object.defineProperty(window, 'DentistryAuth', {
  configurable: true,
  get: () => ({
    init: async () => __u, isSignedIn: () => true, profile: () => __u,
    signIn: () => {}, signOut: () => {}, token: () => 'trailer',
  }),
  set: () => {},
});
`;

/* One beat. `headline` is what `trailer_overlays.py` sets in Archivo; `eyebrow` is the
 * condensed mono line above it; `numeral` is the figure, set in tabular mono, and is the
 * one thing on screen that is allowed to be a number. `at` is wall-clock seconds from
 * the same t0 the frames are stamped with, so a plate cannot drift off what it names. */
const beats = [];
// The storyboard's own length, asserted at the end. Update this when a beat is added or
// cut -- that is the point: a change to the cut should be a deliberate edit here, not
// something a crashed browser can do silently.
const EXPECTED_BEATS = 13;
let t0 = 0;
function beat(eyebrow, headline, numeral = '') {
  const at = (Date.now() - t0) / 1000;
  beats.push({ at: Number(at.toFixed(2)), eyebrow, headline, numeral });
  console.log(`  ${at.toFixed(1).padStart(6)}s  ${headline}`);
}

async function main() {
  const send = await cdp(DEBUG_PORT);
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
  // A hash-only navigation does not reload the document, so the auth stub never fires.
  let nav = 0;
  const go = async (hash) => {
    nav += 1;
    await ev('Page.navigate', { url: `${base}/index.html?trailer=${nav}${hash}` });
    await sleep(1800);
  };

  // 1920x1080. `record_tour.mjs` measured `Page.captureScreenshot` at 2560 running 3-4
  // frames a second on this box against roughly 8 at 1920, and a trailer that stutters
  // reads worse than one that is 1920. The social cuts place this at native scale rather
  // than cropping into it, so nothing downstream wants the extra pixels either.
  await ev('Emulation.setDeviceMetricsOverride', {
    width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false,
  });

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
  if (!/nvidia|geforce/i.test(String(renderer))) {
    throw new Error(`refusing to record without the GPU: renderer is "${renderer}"`);
  }
  const gated = await js(`(() => {
    const g = document.getElementById('signinGate');
    return !!(g && !g.hidden);
  })()`);
  if (gated) throw new Error('the app is showing the sign-in gate: the auth stub did not take');

  // The case with MISSING TEETH. A full dentition has no edentulous site, so every
  // adjacent-tooth clearance returns "not graded" and the grading beat cannot happen.
  // This one is 30 of 32 with real gaps, 24 mm of bone at one molar site and 14 at
  // another -- which is the whole CLEAR -> TIGHT -> BREACH sequence.
  const caseId = CASE || await js(`(async () => {
    const r = await fetch('/v1/examples').then((x) => x.json());
    const ex = (r.examples || []).find((e) => e.state === 'done' && /F_041/i.test(e.title || ''))
      || (r.examples || []).find((e) => e.state === 'done');
    return ex ? ex.id : '';
  })()`);
  if (!caseId) throw new Error('no finished example case to record');
  console.log(`case: ${caseId}`);

  await go(`#/case/${caseId}`);

  // POLLED, not slept -- but NOT on `mprMounted`, which is the trap this replaced one
  // flaky line with another. `record_tour.mjs` sleeps a hardcoded 24 s here and never
  // checks; the first version of this poll waited on `state.viewer.mprMounted` and timed
  // out every time, because that flag is FALSE BY CONSTRUCTION in this rig. It is the
  // limitation `tour_probe.mjs` exists to document: the Cornerstone MPR panes do not
  // mount headless ("No imageId found within the specified criteria"), which is exactly
  // why the trailer is built on the plan tab and never shows them.
  //
  // What the plan tab actually needs is the CASE REPORT and then the ARCH MANIFEST, so
  // those are what this waits for. Two phases, because the arch is only fetched once
  // `setMode('plan')` has run.
  const waitFor = async (label, expr, ms = 60000) => {
    const deadline = Date.now() + ms;
    for (;;) {
      const st = await js(expr);
      if (st && st.ok) { console.log(`${label}: ${JSON.stringify(st)}`); return st; }
      if (Date.now() > deadline) throw new Error(`${label} never arrived: ${JSON.stringify(st)}`);
      await sleep(1000);
    }
  };
  // `state`, NOT `window.state`. app.js:29 declares it as a top-level `const`, and a
  // top-level const/let does not become a property of `window` -- so `window.state` is
  // undefined and any guard written that way is false forever, whatever the app is
  // doing. `record_tour.mjs:230` has the same expression, but only to print a line, so
  // it has been quietly reporting `mounted: false` on every run without gating anything.
  // Here it WAS a gate, and it timed out against a fully loaded case.
  await waitFor('case open', `(() => ({
    ok: typeof state !== 'undefined' && !!(state.viewer && state.viewer.report),
    planTab: !(document.getElementById('planTab') || {}).hidden,
  }))()`);
  await sleep(1500);

  // RECORDING ONLY. The case subtitle carries the dataset credit and the case title
  // carries "ToothFairy3 F_041". Neither belongs burned into ninety seconds of a piece
  // about implant planning, and the licence's attribution requirement is met on the end
  // card instead. This writes to the DOM of a throwaway headless profile; nothing here
  // reaches the app.
  await js(`(() => {
    const sub = document.getElementById('caseSub');
    if (sub) sub.textContent = '';
    const t = document.getElementById('caseTitle');
    if (t) t.textContent = 'Lower right posterior';
  })()`);

  // ------------------------------------------------------- the capture loop
  // A timed loop rather than the compositor's own stream. `Page.startScreencast` emits
  // on compositor damage -- measured at roughly one frame every two seconds even while
  // the 3-D pane was turning. Frames are stamped from the same t0 the beats use.
  rmSync(FRAMES, { recursive: true, force: true });
  mkdirSync(FRAMES, { recursive: true });
  const shots = [];
  let capturing = true;
  t0 = Date.now();
  let captureError = null;
  const capture = (async () => {
    const period = 1000 / FPS;
    // A navigation legitimately drops the odd frame, so single failures are swallowed --
    // but a RUN of them means the browser is gone, and spinning quietly through that is
    // how a half-length recording gets reported as a whole one.
    let consecutive = 0;
    while (capturing) {
      const started = Date.now();
      try {
        const r = await ev('Page.captureScreenshot', { format: 'jpeg', quality: 90 });
        const name = `f${String(shots.length).padStart(6, '0')}.jpg`;
        writeFileSync(path.join(FRAMES, name), Buffer.from(r.data, 'base64'));
        shots.push({ file: name, at: (started - t0) / 1000 });
        consecutive = 0;
      } catch (e) {
        consecutive += 1;
        if (consecutive >= 20) {
          captureError = new Error(
            `${consecutive} consecutive capture failures (${e.message}) -- stopped at `
            + `${shots.length} frames`);
          capturing = false;
          break;
        }
      }
      const spent = Date.now() - started;
      if (spent < period) await sleep(period - spent);
    }
  })();

  console.log('\nrecording\n');

  // ------------------------------------------------------------ the storyboard
  // Beat 0 has no plate: the title card is concatenated in front of the body, so the
  // opening seconds are the 3-D jaw turning under it with nothing written over them.
  beat('', '');
  await js(`(() => { document.querySelector('[data-mode="plan"]').click(); })()`);
  // The arch manifest is what every later beat drives: no arch, no chart sites, no
  // cross-section, no implant. Waiting on it here rather than sleeping a guess means a
  // slow fetch delays the storyboard instead of silently recording an empty stage.
  await waitFor('arch', `(() => {
    const p = typeof state !== 'undefined' && state.viewer && state.viewer.plan;
    const teeth = document.querySelectorAll('#archChart .tooth').length;
    return { ok: !!(p && p.arch && teeth > 0), teeth };
  })()`);
  await sleep(4500);

  beat('37 structures · 32 teeth in FDI',
       'Both jaws, every tooth numbered,<br>and the nerve the implant has to miss.');
  await sleep(5500);

  beat('The site picker', 'Click a tooth position<br>to plan an implant there.');
  await sleep(2600);
  await js(`(() => {
    const t = document.querySelector('#archChart .tooth[data-fdi="46"]');
    if (!t) throw new Error('no FDI 46 on the chart');
    t.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  })()`);
  await sleep(10500);

  beat('Seeded from the restoration',
       'A first molar seeds 4.8 × 10 mm —<br>the platform that tooth needs.');
  await sleep(5000);

  // THE CAPTION IS READ FROM THE APP, not asserted over it.
  // The first take wrote "it re-measures and steps down until the canal reads clear"
  // and then the auto-fit reported "the usual starting length, and the bone takes it" --
  // 24 mm of bone at this site, so nothing needed shortening. A trailer that narrates a
  // behaviour the footage does not show is the one failure this piece cannot afford,
  // and `imp.lengthFrom` is already a finished human sentence explaining whichever
  // outcome happened. So it becomes the caption. The product speaks for itself and the
  // words cannot drift from the frame they sit on.
  const fit = await js(`(() => {
    const p = implantState();
    const i = (p.implants || [])[0];
    if (!i) return null;
    return { len: i.length_mm, dia: i.diameter_mm, from: String(i.lengthFrom || '') };
  })()`);
  console.log('  autofit:', JSON.stringify(fit));
  const fitLine = fit && fit.from
    ? `${fit.len} mm — ${fit.from}.`
    : 'Measured against the canal, not assumed from the site.';
  beat('Then settled by measurement', fitLine);
  await sleep(5000);

  /** The canal verdict as the panel itself computes it. */
  const readCanal = () => js(`(() => {
    const p = implantState();
    const i = (p.implants || [])[0];
    const m = i && (p.measured || {})[i.id];
    const v = (m && m.verdict) || {};
    const n = v.numbers || {};
    const mm = n.clearance_mm != null ? n.clearance_mm : n.distance_mm;
    return { level: v.level || null, len: i ? i.length_mm : null,
             mm: typeof mm === 'number' ? mm.toFixed(2) : null,
             atLeast: typeof n.at_least_mm === 'number' ? n.at_least_mm.toFixed(1) : null };
  })()`);

  const canal = await readCanal();
  console.log('  canal:', JSON.stringify(canal));
  beat('Clearance to the inferior alveolar canal',
       'Not an impression. A number,<br>with a verdict attached.',
       canal.mm ? `${canal.mm} mm` : (canal.atLeast ? `> ${canal.atLeast} mm` : ''));
  await sleep(6000);

  beat('The error budget',
       'Graded with the model’s own<br>measured error <em>subtracted</em>.');
  await sleep(5000);

  // The second site: 14 mm of bone rather than 24. This is what makes the grading
  // sequence possible at all -- at the first site nothing the catalogue offers breaches.
  await js(`(() => {
    const p = implantState();
    (p.implants || []).slice().forEach((i) => {
      try { DentistryViewer.removeImplant(i.id); } catch (e) {}
    });
    p.implants = []; p.measured = {}; p.selected = null;
    const t = document.querySelector('#archChart .tooth[data-fdi="38"]');
    if (t) t.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  })()`);
  await sleep(12000);
  beat('A site where the canal is close',
       '14 mm of bone here, not 24.<br>It seeds shorter on its own.');
  await sleep(4500);

  // The spine: one plan, three lengths, and the verdict WORD is whatever the server
  // returns rather than whatever the storyboard hoped for. `VERDICT_WORD` is the app's
  // own vocabulary, so the caption and the chip on screen say the same thing by
  // construction. If a push does not change the verdict, that is what the case says and
  // the caption says it too.
  const VERDICT_LINE = {
    clear: 'Clear of the canal,<br>with the margin still to spare.',
    tight: 'Inside the comfortable band.<br>It says so, in millimetres.',
    breach: 'Past the margin.<br>The plan is refused, not softened.',
    no_verdict: 'It will not grade this,<br>and it will not pretend otherwise.',
  };
  const grades = [];
  const push = async (mm, eyebrow) => {
    await js(`(() => {
      const p = implantState();
      const i = (p.implants || [])[0];
      if (!i) return;
      i.length_mm = ${mm};
      requestMeasure(0);
      renderImplantPanel();
    })()`);
    await sleep(6500);
    const v = await readCanal();
    console.log(`  ${mm} mm ->`, JSON.stringify(v));
    grades.push({ mm, ...v });
    const word = String(v.level || 'no_verdict').toUpperCase().replace('_', ' ');
    beat(`${eyebrow} · ${word}`,
         VERDICT_LINE[v.level] || VERDICT_LINE.no_verdict,
         v.mm ? `${v.mm} mm` : (v.atLeast ? `> ${v.atLeast} mm` : ''));
    await sleep(3200);
  };

  await push(10, 'Push it deeper');
  await push(11.5, 'Closer still');
  await push(8, 'Back off one size');

  beat('Verified in three dimensions',
       'The safety envelope is drawn at the surface<br>the verdict is computed against.');
  await sleep(5500);

  beat('And where it cannot grade, it refuses',
       'A measurement with a caveat is shown<br>as <em>not graded</em>, never as clear.');
  await sleep(5500);

  capturing = false;
  await capture;
  if (captureError) throw captureError;

  const seconds = (Date.now() - t0) / 1000;
  writeFileSync(path.join(FRAMES, 'frames.json'), JSON.stringify(shots));
  const summary = {
    seconds: Number(seconds.toFixed(3)),
    frames: shots.length,
    fps: Number((shots.length / seconds).toFixed(2)),
    renderer, case: caseId, beats, grades,
  };
  // A short capture means the loop died, not that the storyboard was quick.
  if (shots.length < 60) {
    throw new Error(`only ${shots.length} frames captured; the capture loop did not run`);
  }
  // ...and a short STORYBOARD means the driver died, which the frame count alone cannot
  // see: the take that stopped at 40 s still had 371 perfectly good frames. Counted
  // rather than timed, because the beat list is the one thing that says how much of the
  // argument actually got filmed.
  if (beats.length !== EXPECTED_BEATS) {
    throw new Error(`storyboard truncated: ${beats.length} of ${EXPECTED_BEATS} beats`);
  }
  if (grades.length !== 3) {
    throw new Error(`the grading sequence is the spine and only ${grades.length} of 3 ran`);
  }
  console.log(`\n${shots.length} frames over ${seconds.toFixed(1)}s (${summary.fps}/s)`);
  console.log(JSON.stringify(summary));
  return summary;
}

/* EXPLICIT exits, both ways.
 *
 * `main()` resolving is not enough to end the process: the CDP WebSocket is an open
 * handle, nothing closes it, and node keeps the event loop alive for as long as it is
 * there. Measured -- the recorder printed its complete summary at 101.8 s and then sat
 * doing nothing until `timeout` killed the wrapper thirteen minutes later with exit 124,
 * so the shell never reached the assembler and a perfectly good take of 946 frames
 * looked like a failed run. */
main()
  .then(() => process.exit(0))
  .catch((e) => { console.error(`\nFAILED: ${e.message}`); process.exit(1); });
