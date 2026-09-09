/* Film TWO: the pipeline. Upload, the model catalogue, the segmentation, the report.
 *
 * `record_trailer.mjs` is the implant film -- one plan going CLEAR -> TIGHT -> BREACH.
 * This is the half that gets you there: what you choose before you upload, what comes
 * back, and what the report says about it. Same rig, same guards, its own storyboard.
 *
 * ## Anonymised in the frame, credited on the card
 *
 * Model names, dataset names and case titles are rewritten in the DOM FOR THE RECORDING
 * ONLY -- the catalogue reads Model A..G and the cases read as sites. Nothing here
 * touches what a user sees. The licences those models ship under require attribution and
 * they get it on the end card, which `trailer_overlays.py` builds from `CREDITS`.
 *
 * ## One claim, kept true
 *
 * Two of the seven models in this catalogue were trained here: the base and the anterior
 * canal specialist. The other five are third-party Apache-2.0 weights this app RUNS.
 * So the beat that says "we trained this" is pinned to the two that are ours and carries
 * the number that backs it, rather than being said over the catalogue as a whole -- which
 * would be claiming five other people's work.
 *
 *     ./scripts/record_pipeline.sh
 */
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';

const PORT = Number(process.env.TOUR_PORT || 8807);
const DEBUG_PORT = Number(process.env.TOUR_DEBUG_PORT || 9333);
const CASE = process.env.TOUR_CASE || '';
const FRAMES = process.env.TOUR_FRAMES || '/tmp/dentistry-pipeline/frames';
const FPS = Number(process.env.TOUR_FPS || 10);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ CDP plumbing
 * Identical to `record_trailer.mjs`, including the three guards that film taught us:
 * a closed socket rejects, a hung call times out, and the process exits explicitly. */
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
  const fail = (why) => {
    if (!dead) dead = new Error(`CDP socket ${why} -- the browser went away mid-recording`);
    for (const [, { no }] of waiting) no(dead);
    waiting.clear();
  };
  ws.onclose = () => fail('closed');
  ws.onerror = () => fail('errored');
  const CALL_TIMEOUT_MS = Number(process.env.TOUR_CALL_TIMEOUT_MS || 45000);
  return (method, params = {}, sessionId) => new Promise((ok, no) => {
    if (dead) { no(dead); return; }
    id += 1;
    const mine = id;
    const timer = setTimeout(() => {
      if (!waiting.has(mine)) return;
      waiting.delete(mine);
      no(new Error(`CDP ${method} did not answer in ${CALL_TIMEOUT_MS} ms`));
    }, CALL_TIMEOUT_MS);
    waiting.set(mine, {
      ok: (v) => { clearTimeout(timer); ok(v); },
      no: (e) => { clearTimeout(timer); no(e); },
    });
    try {
      ws.send(JSON.stringify({ id: mine, method, params, ...(sessionId ? { sessionId } : {}) }));
    } catch (e) { clearTimeout(timer); waiting.delete(mine); no(e); }
  });
}

const AUTH_STUB = `
const __u = { sub: 'film2', name: 'Demo', email: 'demo@example.invalid',
              preferred_username: 'demo' };
Object.defineProperty(window, 'DentistryAuth', {
  configurable: true,
  get: () => ({
    init: async () => __u, isSignedIn: () => true, profile: () => __u,
    signIn: () => {}, signOut: () => {}, token: () => 'film2',
  }),
  set: () => {},
});
`;

/* THE ANONYMISER, installed on every document load rather than run once.
 *
 * A MutationObserver, not a single pass: the model catalogue, the case list and the
 * upload line are all rendered asynchronously after their fetches land, and a one-shot
 * rewrite would run against an empty panel and report success. It relabels the cards in
 * DOM order -- Model A, B, C... -- and scrubs the dataset and third-party model names
 * wherever they appear in text.
 *
 * Recording only. This is injected into a throwaway headless profile and never reaches
 * the app. (No backticks: this is a template literal.) */
const ANONYMISE = `
(() => {
  const LETTERS = 'ABCDEFGH';
  // Names that must not appear in frame. Order matters: longest first, so a shorter
  // pattern cannot eat the head of a longer one and leave a fragment behind.
  const SCRUB = [
    // FIRST, and it is a whole sentence rather than a token. The worker reports an
    // uninstalled model as "<SETTING> is not set, so this model is not deployed on this
    // worker", and those settings are named TF3_TOOTHSEG_DIR, TF3_TOTALSEG_DIR and so
    // on -- so the token rules below chewed them into "Model A C is not set", which is
    // gibberish and shipped in a delivered cut. Replaced with the app's own wording for
    // the same state before any token rule can reach it.
    [/[A-Z0-9_]*(?:TF3|TOOTHFAIRY3|TOOTHSEG|TOTALSEG)[A-Z0-9_]* is not set, so this model is not deployed on this worker/gi,
     'Not installed on this deployment'],
    [/ToothFairy3 U-Mamba2/gi, 'Model A'],
    [/Anterior canal specialist \\(incisive \\+ lingual\\)/gi, 'Model B'],
    [/Anterior canal specialist/gi, 'Model B'],
    [/ToothSeg semantic \\(teeth\\)/gi, 'Model C'],
    [/TotalSegmentator teeth \\(Dataset113\\)/gi, 'Model D'],
    [/Head muscles \\+ tongue/gi, 'Model E'],
    [/Airway, palate, glands and orbit/gi, 'Model F'],
    [/Neck bones, cartilage and great vessels/gi, 'Model G'],
    [/ToothFairy3 F_?041[^,\\n]*/g, 'Lower right posterior'],
    [/ToothFairy3[^,\\n]*/g, 'held-out case'],
    [/ToothFairy3/g, ''],
    [/ToothSeg/g, 'Model C'],
    [/TotalSegmentator/g, 'Model D'],
    [/MIC-DKFZ[^)\\s]*/gi, ''],
    [/wasserth[^)\\s]*/gi, ''],
    [/CC BY-NC-SA[^)\\n]*/gi, 'research licence'],
    // Model KEYS, which are lowercase slugs and appear in provenance chips and run
    // details rather than in the catalogue headings.
    [/toothseg[a-z0-9_-]*/gi, 'Model C'],
    [/totalsegmentator[a-z0-9_-]*/gi, 'Model D'],
    [/toothfairy3?[a-z0-9_-]*/gi, 'Model A'],
    [/\\btf3[a-z0-9_-]*/gi, 'Model A'],
  ];
  const scrub = (s) => SCRUB.reduce((acc, [re, to]) => acc.replace(re, to), s);
  const walk = (root) => {
    // Cards first, so the letter follows DOM order rather than whatever the scrub table
    // happened to match.
    const cards = root.querySelectorAll ? root.querySelectorAll('#modelList .modelcard') : [];
    cards.forEach((c, i) => {
      const want = 'Model ' + LETTERS[i];
      const b = c.querySelector('header b');
      if (b && b.textContent !== want) b.textContent = want;
      // GUARDED, like the line above it. Writing the same value back is still a mutation,
      // the observer fires on it, and the callback writes it again -- an unconditional
      // setAttribute here was an infinite microtask loop that pinned the main thread and
      // made the page stop answering CDP at all. It looked like a hung browser.
      if (c.getAttribute('aria-label') !== want) c.setAttribute('aria-label', want);
    });
    // SCOPED, not the whole document. The names live in four places; the structures dock
    // alone is 47 rows and the report is hundreds more nodes, and none of them mention a
    // model. Walking all of it on every mutation pinned the main thread hard enough that
    // Chrome stopped answering CDP -- twice, from two different directions. The
    // end-of-run leak check still scans the WHOLE body, so anything this misses is
    // reported by name rather than silently shipped.
    // Enumerated rather than walking the whole body, and the guard below names anything
    // this misses. The last three are the home page's own attribution links -- they are
    // scrubbed in the RECORDING only, and the credit they carry ships on the end card.
    const SCOPES = ['#modelList', '#uploadPlan', '#casebar', '.rail', '#modelsNote',
                    '#examplesPanel', '#drop', '#uploadNotice',
                    '#homeFoot', '#aboutPanel', '#contact',
                    '.fovnote', '#findingsCard', '#priorsCard'];
    SCOPES.forEach((sel) => {
      document.querySelectorAll(sel).forEach((el) => {
      const it = document.createNodeIterator(el, NodeFilter.SHOW_TEXT);
      let n;
      while ((n = it.nextNode())) {
        const t = n.nodeValue;
        if (!t || t.length < 4) continue;
        const s = scrub(t);
        if (s !== t) n.nodeValue = s;
      }
      });
    });
  };
  // The observer is DISCONNECTED while walking and reconnected after, so a rewrite can
  // never be the thing that schedules the next rewrite. Belt as well as braces: the
  // guards above make each pass idempotent, and this makes a non-idempotent one in
  // future cost a wasted pass rather than the whole main thread.
  let obs = null;
  let inside = false;
  let pending = 0;
  const walkNow = () => {
    if (inside || !document.body) return;
    inside = true;
    if (obs) obs.disconnect();
    try { walk(document.body); } catch (e) {}
    if (obs) obs.observe(document.documentElement, { childList: true, subtree: true });
    inside = false;
  };
  // DEBOUNCED. The walk is a full-document NodeIterator, and on a case page -- 47
  // structure rows, every report card, the run details -- that is thousands of text
  // nodes. Running it on every mutation of an app that re-renders constantly saturated
  // the main thread badly enough that the page stopped answering CDP at all, which the
  // call timeout then reported as a hung browser. One walk per 250 ms is far more often
  // than any of this content actually changes.
  const run = () => {
    if (pending) return;
    pending = setTimeout(() => { pending = 0; walkNow(); }, 250);
  };
  // STARTED WHEN THERE IS A DOCUMENT TO OBSERVE.
  // This is injected by addScriptToEvaluateOnNewDocument, which runs at document-START --
  // before the parser has produced documentElement, let alone body. Calling
  // observe(null, ...) throws, and the throw took the whole IIFE with it, so the interval
  // was never registered and nothing was ever renamed. The catalogue guard caught it and
  // refused to film, which is the only reason this was a failed run rather than a
  // published video with the dataset name in every frame.
  const start = () => {
    if (!document.documentElement) { setTimeout(start, 5); return; }
    // characterData is deliberately NOT watched. The only text this rewrites is text it
    // wrote itself or text the app rendered, and both arrive as childList changes -- but
    // watching characterData means every rewrite is also an event, which is half of how
    // the loop above got started.
    // (No backticks anywhere in this IIFE: it is stringified into a template literal.)
    obs = new MutationObserver(run);
    obs.observe(document.documentElement, { childList: true, subtree: true });
    document.addEventListener('DOMContentLoaded', run);
    // The interval is a SAFETY NET for a render the observer somehow misses, not the
    // main mechanism, so it is slow. The observer plus the 250 ms debounce does the work.
    setInterval(run, 3000);
    walkNow();
  };
  start();
})();
`;

const beats = [];
const EXPECTED_BEATS = 11;
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
  await ev('Page.addScriptToEvaluateOnNewDocument', { source: ANONYMISE });

  const js = async (expression) => {
    const r = await ev('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) {
      const x = r.exceptionDetails.exception || {};
      throw new Error(x.description || x.value || r.exceptionDetails.text);
    }
    return r.result.value;
  };

  const base = `http://127.0.0.1:${PORT}`;
  let nav = 0;
  const go = async (hash) => {
    nav += 1;
    await ev('Page.navigate', { url: `${base}/index.html?film=${nav}${hash}` });
    await sleep(2200);
  };
  // Reports how long it waited, not just that it did. A wait that succeeds in 3 s and one
  // that succeeds in 38 s are the same PASS and completely different films -- the second
  // holds a caption over a spinner for half a minute.
  const waitFor = async (label, expr, ms = 60000) => {
    const began = Date.now();
    const deadline = began + ms;
    for (;;) {
      const st = await js(expr);
      if (st && st.ok) {
        const took = ((Date.now() - began) / 1000).toFixed(1);
        console.log(`${label}: ${JSON.stringify(st)} in ${took}s`);
        return st;
      }
      if (Date.now() > deadline) throw new Error(`${label} never arrived: ${JSON.stringify(st)}`);
      await sleep(1000);
    }
  };

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

  // The catalogue has to be on screen and ALREADY RELABELLED before a frame is taken.
  // Asserted rather than slept for: an un-anonymised catalogue is the one mistake in this
  // film that cannot be fixed in the edit.
  const cat = await waitFor('catalogue', `(() => {
    const cards = [...document.querySelectorAll('#modelList .modelcard header b')]
      .map((b) => b.textContent.trim());
    const body = document.body.innerText;
    return { ok: cards.length >= 4 && cards.every((c) => /^Model [A-H]$/.test(c))
                 && !/ToothFairy|ToothSeg|TotalSegmentator/i.test(body),
             cards,
             // Named, so a leak outside the scrub scopes says WHERE in one run rather
             // than three. This is how the example-case panel was found.
             leaks: (() => {
               const bad = /ToothFairy3?|ToothSeg|TotalSegmentator/i;
               const out = [];
               document.querySelectorAll('body *').forEach((e) => {
                 if (out.length >= 4 || e.children.length) return;
                 const m = ((e.innerText || '').trim()).match(bad);
                 if (m) out.push(m[0] + ' in ' + (e.closest('[id]') || {}).id
                                 + ' > ' + e.tagName.toLowerCase());
               });
               return out;
             })() };
  })()`);

  const caseId = CASE || await js(`(async () => {
    const r = await fetch('/v1/examples').then((x) => x.json());
    const ex = (r.examples || []).find((e) => e.state === 'done' && /F_041/i.test(e.title || ''))
      || (r.examples || []).find((e) => e.state === 'done');
    return ex ? ex.id : '';
  })()`);
  if (!caseId) throw new Error('no finished example case to record');
  console.log(`case: ${caseId}`);

  // ------------------------------------------------------- the capture loop
  rmSync(FRAMES, { recursive: true, force: true });
  mkdirSync(FRAMES, { recursive: true });
  const shots = [];
  let capturing = true;
  let paused = false;
  let captureError = null;

  /* An unavoidable wait becomes a CUT, not dead air.
   *
   * The mesh pack takes 60-105 s to parse and upload, and there is no cache for it --
   * the cost is the parse. Every previous attempt to hide that failed the same way:
   * reordering moved the BEAT but not the WAIT, so a caption sat over "loading
   * volume..." for a minute, and the placeholder assertion passed because it ran after
   * the spinner had gone.
   *
   * So the recorder stops writing frames for the duration and then moves `t0` forward by
   * exactly that much. Frames and beats share `t0`, so the timeline simply does not
   * contain the gap -- the cut lands where an editor would put it, and the caption that
   * follows opens on a loaded pane. */
  const cutAway = async (label, fn) => {
    paused = true;
    const began = Date.now();
    try {
      return await fn();
    } finally {
      const gap = Date.now() - began;
      t0 += gap;
      paused = false;
      console.log(`  [cut ${(gap / 1000).toFixed(1)}s: ${label}]`);
    }
  };
  t0 = Date.now();
  const capture = (async () => {
    const period = 1000 / FPS;
    let consecutive = 0;
    while (capturing) {
      // A paused loop writes no frames. See `cutAway`.
      if (paused) { await sleep(period); continue; }
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
          captureError = new Error(`${consecutive} consecutive capture failures (${e.message})`);
          capturing = false; break;
        }
      }
      const spent = Date.now() - started;
      if (spent < period) await sleep(period - spent);
    }
  })();

  console.log('\nrecording\n');

  // ------------------------------------------------------------ the storyboard
  beat('', '');
  await sleep(4000);

  beat('One scan in', 'A cone-beam CT goes in.<br>Nothing else is asked for.');
  // The drop zone, scrolled to rather than clicked: filming a file dialog is filming the
  // operating system, and the feature is what the app does with the file.
  await js(`(() => { const d = document.getElementById('drop');
                     if (d) d.scrollIntoView({ block: 'center', behavior: 'smooth' }); })()`);
  await sleep(6000);

  beat('Chosen before the upload, not after',
       'You pick which models run.<br>The plan is stated before a byte is sent.');
  await js(`(() => { const p = document.getElementById('modelsPanel');
                     if (p) p.scrollIntoView({ block: 'start', behavior: 'smooth' }); })()`);
  await sleep(7000);

  // Hovering a card ghosts every structure the model does NOT own, on the live 3-D
  // schematic. It is the one control in the app that answers "what does this model
  // actually draw" by drawing it.
  beat('Hover a model and the anatomy answers',
       'Each one lights only what it owns.<br>What it does not own stays ghosted.');
  for (const i of [0, 1, 2]) {
    await js(`(() => {
      const c = document.querySelectorAll('#modelList .modelcard')[${i}];
      if (c) c.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
    })()`);
    await sleep(2600);
  }
  await sleep(1500);

  // READ OUT OF THE APP, never typed here. A literal on this line said 0.8887 while the
  // app, `dentistry/models.py` and `eval/COMPARISON.md` all said 0.8965 -- so the film
  // stated a measurement the product does not make, in the one beat that is about our
  // own training, and it shipped. Captions in `record_trailer.mjs` are read from the app
  // for exactly this reason; the numeral had been left behind.
  //
  // `textContent`, not `innerText`: the evidence sits inside a collapsed <details>, and
  // `innerText` returns only RENDERED text, so a closed one comes back empty.
  const dice = await js(`(() => {
    const card = document.querySelector('#modelList .modelcard');
    const m = (card ? card.textContent : '').match(/challenge Dice (0\\.\\d{3,4})/);
    return m ? m[1] : '';
  })()`);
  if (!/^0\.\d{3,4}$/.test(dice)) {
    throw new Error(
      `could not read the base model's challenge Dice out of the catalogue (got ${JSON.stringify(dice)}) `
      + '-- refusing to state a score the app does not');
  }
  console.log(`  base model challenge Dice, read from the app: ${dice}`);
  beat('Two of these are ours',
       'The base model and the canal specialist<br>were trained here, on our own GPUs.',
       dice);
  await sleep(6500);

  beat('Then it runs, remotely',
       'One model on one GPU.<br>About 98 seconds, plus the derived views.');
  await js(`(() => { const u = document.getElementById('uploadPlan');
                     if (u) u.scrollIntoView({ block: 'center', behavior: 'smooth' }); })()`);
  await sleep(6500);

  // ---- what comes back
  await cutAway('case navigation and report fetch', async () => {
    await go(`#/case/${caseId}`);
    await waitFor('case open', `(() => ({
      ok: typeof state !== 'undefined' && !!(state.viewer && state.viewer.report),
    }))()`);
  });
  // SOLO THE 3-D PANE. The case opens on the four-pane MPR grid, and three of those four
  // do not mount in a headless capture -- `tour_probe.mjs` settled that, and the first
  // take of this film proved it again by putting "loading volume..." across the middle of
  // the frame for the last four beats. The 3-D pane is vtk.js and DOES render, so soloing
  // it fills the stage with the thing that works while the rail and the dock keep their
  // real content either side.
  // THE PLAN TAB IS WHAT MOUNTS THE SURFACES. The case opens on the MPR grid and the
  // mesh actors never arrive there in a headless capture -- the pre-warm this replaced
  // waited 90 s on the MPR tab and timed out, while film 1 has surfaces up within its
  // first beat because it clicks the plan tab. So the mount happens on the plan tab,
  // inside the cut, and the film returns to the MPR tab afterwards for the rail and
  // dock content it needs. None of this is on screen: it is all inside `cutAway`.
  await js(`(() => { document.querySelector('[data-mode="plan"]').click(); })()`);
  await cutAway('surface mount via the plan tab', () => waitFor('surfaces', `(() => {
    try {
      const s = DentistryViewer.debugState().surfaces;
      return { ok: !!(s && s.added > 0), added: s.added };
    } catch (e) { return { ok: false }; }
  })()`, 180000));
  await js(`(() => {
    try { setMode('volume'); } catch (e) {}
    try { setLayout('solo', '3d'); } catch (e) {}
    // HIDE THE MPR LOADING OVERLAY. It is #mprLoading, a stage-level .stage-overlay, and
    // in a headless capture it NEVER clears: it waits on the Cornerstone volume mount,
    // which is the one thing this rig cannot do (tour_probe.mjs settled that). Soloing
    // the 3-D pane puts a rendered jaw underneath it, but the overlay sits above the
    // whole stage, so "loading volume..." stayed across the middle of the frame.
    // Recording only, and honest: the overlay is about a volume this film never shows.
    const o = document.getElementById('mprLoading');
    if (o) o.hidden = true;
  })()`);
  // WHAT IS PAINTED, not what class is present. Two takes shipped a spinner past a
  // placeholder check because the element showing it was `.stage-overlay`, not the
  // `.stage-empty` the check looked for -- a name I had guessed rather than read. So this
  // counts CHROMATIC pixels on the 3-D canvas instead, the method `tour_probe.mjs` uses:
  // it separates "a canvas exists" from "something was drawn on it", and it cannot be
  // satisfied by the wrong selector.
  {
    const paint = await js(`(() => {
      const c = document.querySelector('#mprStage .pane-3d canvas');
      if (!c) return { ok: false, why: 'no 3-D canvas' };
      const g = document.createElement('canvas');
      g.width = 240; g.height = 135;
      const x = g.getContext('2d');
      x.drawImage(c, 0, 0, g.width, g.height);
      const d = x.getImageData(0, 0, g.width, g.height).data;
      let lit = 0;
      for (let i = 0; i < d.length; i += 4) {
        const r = d[i], gg = d[i + 1], b = d[i + 2];
        if (Math.max(r, gg, b) - Math.min(r, gg, b) > 18) lit += 1;
      }
      const overlay = (() => {
        const o = document.getElementById('mprLoading');
        return !!(o && !o.hidden && o.offsetParent !== null);
      })();
      return { ok: lit > 400 && !overlay, lit, overlay };
    })()`);
    if (!paint.ok) {
      throw new Error(`the 3-D pane is not painted before the case beats: ${JSON.stringify(paint)}`);
    }
    console.log(`  3-D painted: ${paint.lit} chromatic px`);
  }

  // NOT waited on here. Measured: the mesh pack takes ~105 s to parse and upload on this
  // rig, and a cache does not help because the cost is the parse rather than the
  // download. Blocking here held one caption over a loading pane for the whole of it.
  // So the beats that need no GPU -- the report, the structure list, the exports, all of
  // which live in the rail and the dock -- come FIRST, and the 3-D beat comes last, by
  // which time the surfaces have had a minute of storyboard to arrive in.
  await sleep(2000);
  // Asserted HERE, not only at the end. The end-of-run check passed on a take that held a
  // spinner across four beats, because by the end it had gone -- a placeholder has to be
  // checked at the moment the camera is on it.
  // ---- the beats that need no GPU come first: rail and dock render immediately.
  beat('The report is not a score',
       'Every quality check on this scan,<br>whether it passed or not.');
  await js(`(() => { const c = document.getElementById('findingsCard');
                     if (c) c.scrollIntoView({ block: 'start', behavior: 'smooth' }); })()`);
  await sleep(8000);

  beat('How wrong it might be, per structure',
       'The measured error of the model itself,<br>published beside what it drew.');
  await js(`(() => {
    const p = document.getElementById('priorsCard');
    if (p) { p.hidden = false; p.open = true;
             p.scrollIntoView({ block: 'start', behavior: 'smooth' }); }
  })()`);
  await sleep(8500);

  beat('Every structure, with its volume',
       'Named, numbered, measured —<br>and any one of them on its own.');
  await js(`(() => {
    const f = document.getElementById('structFilter');
    if (f) { f.value = 'canal'; f.dispatchEvent(new Event('input', { bubbles: true })); }
  })()`);
  await sleep(4500);
  await js(`(() => {
    const f = document.getElementById('structFilter');
    if (f) { f.value = ''; f.dispatchEvent(new Event('input', { bubbles: true })); }
  })()`);
  await sleep(3000);

  beat('And it leaves in a format your software reads',
       'Label map, RTSTRUCT, per-structure STL,<br>and the plan as a printed sheet.');
  await js(`(() => { const d = document.getElementById('downloads');
                     if (d) d.scrollIntoView({ block: 'center', behavior: 'smooth' }); })()`);
  await sleep(8000);

  // ---- and the 3-D last, when the mesh pack has had the whole report section to load.
  await js(`(() => { const s = document.getElementById('mprStage');
                     if (s) s.scrollIntoView({ block: 'center', behavior: 'smooth' }); })()`);
  await sleep(2000);
  beat('And this is what comes back',
       '37 structures out of one scan.<br>Both jaws, the canal, every tooth in FDI.');
  await sleep(9000);

  capturing = false;
  await capture;
  if (captureError) throw captureError;

  // No spinner may survive into the cut. "loading volume..." across the middle of the
  // stage is what the first take of this film shipped, and it is invisible to a frame
  // count, a beat count and a leak check alike -- so it gets its own assertion.
  const spinner = await js(`(() => {
    const e = [...document.querySelectorAll('.stage-empty')]
      .filter((x) => x.offsetParent !== null && !x.hidden)
      .map((x) => (x.textContent || '').trim()).filter(Boolean);
    return e.slice(0, 3);
  })()`);
  if (spinner.length) {
    throw new Error(`a loading placeholder was on screen at the end: ${spinner.join(' | ')}`);
  }

  // The anonymiser is re-asserted at the END as well as the start: the case view renders
  // its own titles and the catalogue is long gone by then, so a leak here would be a leak
  // nothing earlier could have caught.
  // Named, not just counted. innerText applies text-transform, so a leak can be a case
  // the scrub table never saw -- the first one found here was "TOOTHSEG", uppercased by
  // CSS out of a lowercase model key. Reporting the element turns a three-run guessing
  // game into one run.
  const leaks = await js(`(() => {
    const bad = /ToothFairy3?|ToothSeg|TotalSegmentator|CC BY-NC-SA|MIC-DKFZ/i;
    const out = [];
    document.querySelectorAll('body *').forEach((e) => {
      if (out.length >= 5 || e.children.length) return;
      const t = (e.innerText || '').trim();
      const m = t.match(bad);
      if (m) out.push(m[0] + ' in ' + e.tagName.toLowerCase()
        + (e.className && typeof e.className === 'string'
            ? '.' + e.className.trim().split(/\\s+/).join('.') : ''));
    });
    return out;
  })()`);
  if (leaks.length) throw new Error(`un-anonymised text on screen: ${leaks.join(' | ')}`);

  // A BAD SCRUB is not a leak, and nothing was looking for it. "TF3_TOOTHSEG_DIR is not
  // set" came out as "Model A C is not set" -- no forbidden name survived, so the leak
  // check passed, and the gibberish shipped in a delivered cut. Two model letters in a
  // row, or a letter immediately followed by an underscore, is always the token rules
  // colliding with something they should not have touched.
  const garbled = await js(`(() => {
    const bad = /Model [A-H][ _]Model [A-H]|Model [A-H] [A-H]\b|Model [A-H]_/;
    const out = [];
    document.querySelectorAll('body *').forEach((e) => {
      if (out.length >= 3 || e.children.length) return;
      const m = ((e.innerText || '').trim()).match(bad);
      if (m) out.push(m[0] + ' in ' + e.tagName.toLowerCase());
    });
    return out;
  })()`);
  if (garbled.length) {
    throw new Error(`the scrub produced gibberish: ${garbled.join(' | ')}`);
  }

  const seconds = (Date.now() - t0) / 1000;
  writeFileSync(path.join(FRAMES, 'frames.json'), JSON.stringify(shots));
  if (shots.length < 60) throw new Error(`only ${shots.length} frames captured`);
  if (beats.length !== EXPECTED_BEATS) {
    throw new Error(`storyboard truncated: ${beats.length} of ${EXPECTED_BEATS} beats`);
  }
  const summary = {
    seconds: Number(seconds.toFixed(3)),
    frames: shots.length,
    fps: Number((shots.length / seconds).toFixed(2)),
    renderer, case: caseId, models: cat.cards, beats,
  };
  console.log(`\n${shots.length} frames over ${seconds.toFixed(1)}s (${summary.fps}/s)`);
  console.log(JSON.stringify(summary));
  return summary;
}

main()
  .then(() => process.exit(0))
  .catch((e) => { console.error(`\nFAILED: ${e.message}`); process.exit(1); });
