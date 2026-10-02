/* The hero loop's player (markup, and why the <video> has no <source>, in LoopFrame.astro).
 *
 * The clip is decoration that happens to carry the page's first impression, so it plays only
 * when ALL of these hold, and pauses the moment one stops holding:
 *   - at least half of it is on screen (it pauses below a quarter; the gap is hysteresis, so
 *     a phone resting near the threshold does not flap between the two);
 *   - the reader has not asked for reduced motion, reduced data, Save-Data or a 2G link;
 *   - the tab is visible and no dialog is open (the film dialog says so with ip:film-open);
 *   - the reader has not paused it (remembered in localStorage, one global choice).
 * A press of Play overrides the motion and data preferences for this page view only: that is
 * the reader choosing, not the page deciding. It is never remembered, so the next visit under
 * reduced motion starts still again.
 *
 * Until the first play the <video> has no src, so a reader for whom it never plays downloads
 * zero video bytes. AV1 is chosen only when MediaCapabilities says it decodes AND is power
 * efficient; a software AV1 decoder on a mid-range phone is a battery drain for a 3 s loop,
 * so anything less gets H.264, which every target decodes in hardware.
 *
 * Refused autoplay is a normal state, not an error: LinkedIn's in-app browser, iOS Low Power
 * Mode and data savers all refuse or stall it. Then the poster stays, the toggle grows a
 * visible "Play the clip" label, and a press plays it inside the reader's gesture.
 */

// A module, not a global script: its top-level names must not collide with other pages' scripts.
export {};

type Aspect = '4x5' | '16x9';
type Codec = 'av1' | 'h264';
interface Rendition { src: string; type: string; width: number; height: number; bytes: number; duration: number }
type Sources = Record<Aspect, Record<Codec, Rendition>>;
/* Not in lib.dom: the Network Information API (Chromium only) and WebKit's legacy fullscreen. */
interface Connection extends EventTarget { saveData?: boolean; effectiveType?: string }
interface WebKitVideo extends HTMLVideoElement {
  webkitDisplayingFullscreen?: boolean;
  webkitExitFullscreen?: () => void;
}

const PAUSED_KEY = 'ip:clips';
/** sessionStorage flag: this browser forced the clip into fullscreen once; stop offering it. */
const INLINE_KEY = 'ip:inline';
/** Long enough for the first GOP of the H.264 4:5 rendition on a slow 4G link, short enough
 *  that a silently refused play is not mistaken for a slow one for long. A late `playing`
 *  clears it, so being wrong costs a label for a moment, never the clip. */
const BLOCK_MS = 3000;

const local = () => window.localStorage;
const session = () => window.sessionStorage;
function read(store: () => Storage, key: string): string | null {
  try { return store().getItem(key); } catch { return null; }
}
function write(store: () => Storage, key: string, value: string | null) {
  // Private modes and blocked site data throw here; the choice then lasts this page view.
  try { if (value === null) store().removeItem(key); else store().setItem(key, value); } catch { /* see above */ }
}

function setup(figure: HTMLElement, video: WebKitVideo, toggle: HTMLButtonElement, frame: HTMLElement) {
  let sources: Sources;
  // Without renditions, or in a browser that cannot play inline, the toggle stays hidden: the
  // poster is the hero and "Watch the film" is the way into the footage.
  try { sources = JSON.parse(figure.dataset.sources || ''); } catch { return; }
  if (read(session, INLINE_KEY) === 'no') return;

  const phone = matchMedia('(max-width:767px)');
  const reduce = matchMedia('(prefers-reduced-motion: reduce)');
  const lessData = matchMedia('(prefers-reduced-data: reduce)');
  const connection = (navigator as Navigator & { connection?: Connection }).connection;
  const label = toggle.querySelector<HTMLElement>('.loop__label');
  const words = { pause: toggle.dataset.labelPause || 'Pause', play: toggle.dataset.labelPlay || 'Play' };

  const codec: Partial<Record<Aspect, Codec>> = {};
  let inView = false;
  let dialogOpen = !!document.querySelector('dialog[open]');
  let userPaused = read(local, PAUSED_KEY) === 'paused';
  let userPlay = false;
  /** The poster is what the reader sees although we asked to play: refused, or stalled 3 s. */
  let blocked = false;
  /** play() was refused outright (NotAllowedError); retrying without a gesture is pointless. */
  let refused = false;
  /** The browser forced an autoplay fullscreen once; never autoplay again on this page. */
  let forced = false;
  /** A media error with no rendition left to try, or inline playback is impossible. */
  let broken = false;
  let retried = false;
  /** `playing` fired for the current src and no pause since. */
  let running = false;
  let timer = 0;

  video.muted = true;
  video.defaultMuted = true;

  const aspect = (): Aspect => (phone.matches ? '4x5' : '16x9');
  const lowData = () => connection?.saveData === true
    || /(^|-)2g$/.test(connection?.effectiveType ?? '')
    || lessData.matches;
  const wanted = () => !broken && inView && document.visibilityState === 'visible' && !dialogOpen
    && !userPaused && (userPlay || (!reduce.matches && !lowData() && !refused && !forced));
  /** What a press of the toggle would undo: a play that is running or on its way. */
  const active = () => !video.paused && !blocked;

  async function decide(a: Aspect): Promise<Codec> {
    const av1 = sources[a].av1, h264 = sources[a].h264;
    if (!av1 || video.canPlayType(av1.type) === '') return 'h264';
    if (video.canPlayType(h264.type) === '') return 'av1';
    if (!navigator.mediaCapabilities?.decodingInfo) return 'h264';
    try {
      const info = await navigator.mediaCapabilities.decodingInfo({
        type: 'file',
        video: {
          contentType: av1.type, width: av1.width, height: av1.height, framerate: 30,
          bitrate: Math.max(1, Math.round(av1.duration > 0 ? (av1.bytes * 8) / av1.duration : 1e6)),
        },
      });
      return info.supported && info.powerEfficient ? 'av1' : 'h264';
    } catch { return 'h264'; }
  }

  const rendition = (): Rendition => sources[aspect()][codec[aspect()] ?? 'h264'];

  function paint() {
    const playing = active();
    toggle.dataset.action = playing ? 'pause' : 'play';
    if (label) label.textContent = playing ? words.pause : words.play;
    figure.dataset.state = broken ? 'error' : blocked ? 'blocked' : playing ? 'playing' : 'paused';
  }

  function guard() {
    if (timer) return;
    timer = window.setTimeout(() => {
      timer = 0;
      if (!running) { blocked = true; paint(); }
    }, BLOCK_MS);
  }
  function unguard() { window.clearTimeout(timer); timer = 0; }

  /** Synchronous up to video.play(), so a call from the toggle's click handler keeps the
   *  reader's gesture: a WebView that refuses autoplay allows a play() made inside the
   *  gesture, not one made after an await. */
  function start() {
    const r = rendition();
    if (video.getAttribute('src') !== r.src) {
      delete figure.dataset.shown;
      running = false;
      video.preload = 'auto';
      video.src = r.src;
    }
    if (running && !video.paused) return;
    guard();
    if (!video.paused) return; // a play() is already on its way
    let pending: Promise<void> | undefined;
    try { pending = video.play(); } catch { blocked = true; paint(); return; }
    pending?.then(() => {
      if (video.webkitDisplayingFullscreen) forcedFullscreen();
    }, (error: DOMException | undefined) => {
      if (error?.name === 'AbortError') return; // a pause() or a new src overtook this play
      if (error?.name === 'NotAllowedError') refused = true;
      blocked = true;
      unguard();
      paint();
    });
  }

  function stop() {
    unguard();
    if (!video.paused) video.pause();
  }

  function evaluate() {
    if (wanted()) start(); else stop();
    paint();
  }

  /** The browser took the clip fullscreen (an iOS WebView that ignores playsinline). Back out:
   *  a fullscreen decoration is worse than a still one. After an autoplay this is the blocked
   *  state, so the reader can still choose to play it; if it happens again on the reader's own
   *  press, inline playback is impossible here, so the toggle goes and stays gone for the
   *  session ("Watch the film" remains the way into the footage). */
  function forcedFullscreen() {
    try { video.webkitExitFullscreen?.(); } catch { /* already out */ }
    video.pause();
    unguard();
    forced = true;
    if (userPlay) {
      broken = true;
      write(session, INLINE_KEY, 'no');
      toggle.hidden = true;
    } else {
      blocked = true;
      refused = true;
    }
    paint();
  }

  video.addEventListener('playing', () => {
    running = true;
    // A `playing` that comes with a forced fullscreen is not the clip playing inline.
    if (!forced || userPlay) { blocked = false; refused = false; }
    unguard();
    // Reveal on the first frame actually presented where the browser can say so; `playing`
    // alone can precede it on iOS, and the fade would then start from a black frame.
    const reveal = () => { figure.dataset.shown = ''; };
    if ('requestVideoFrameCallback' in video) video.requestVideoFrameCallback(reveal); else reveal();
    paint();
  });
  video.addEventListener('pause', () => { running = false; paint(); });
  video.addEventListener('webkitbeginfullscreen', forcedFullscreen);
  video.addEventListener('error', () => {
    if (!video.getAttribute('src')) return; // emptied on purpose (rotation while paused)
    const a = aspect();
    // A decoder that claimed AV1 and then failed on the file gets one try on H.264.
    if (codec[a] === 'av1' && !retried) {
      retried = true;
      codec[a] = 'h264';
      if (wanted()) start();
      return;
    }
    broken = true;
    unguard();
    toggle.hidden = true;
    paint();
  });

  toggle.addEventListener('click', () => {
    if (active()) {
      userPaused = true;
      userPlay = false;
      write(local, PAUSED_KEY, 'paused');
      stop();
    } else {
      userPaused = false;
      userPlay = true;
      blocked = false;
      refused = false;
      write(local, PAUSED_KEY, null);
      start();
    }
    paint();
  });

  phone.addEventListener('change', () => {
    // Rotation across 767 px: the <picture> has already swapped to the other crop's poster.
    // Show it until the matching rendition paints, and never keep buffering the wrong one.
    if (!video.getAttribute('src')) return;
    const resume = active() || wanted();
    stop();
    delete figure.dataset.shown;
    if (resume) start();
    else { running = false; video.removeAttribute('src'); video.load(); }
    paint();
  });
  reduce.addEventListener('change', () => { if (reduce.matches) userPlay = false; evaluate(); });
  lessData.addEventListener('change', evaluate);
  connection?.addEventListener?.('change', evaluate);
  document.addEventListener('visibilitychange', evaluate);
  window.addEventListener('ip:film-open', () => { dialogOpen = true; evaluate(); });
  window.addEventListener('ip:film-close', () => { dialogOpen = !!document.querySelector('dialog[open]'); evaluate(); });
  // Back from /vr/: the page leaves the back/forward cache with the clip paused by the browser
  // and no new load. Re-read the world and resume if it still should play.
  window.addEventListener('pageshow', event => {
    if (!event.persisted) return;
    dialogOpen = !!document.querySelector('dialog[open]');
    evaluate();
  });

  toggle.hidden = false;
  paint();

  // Settle both codec choices before the first play, so an early intersection does not start
  // an H.264 download that an AV1 answer a few milliseconds later would have avoided. The
  // queries make no network requests.
  Promise.all((['4x5', '16x9'] as Aspect[]).map(async a => { codec[a] = await decide(a); }))
    .catch(() => { /* rendition() falls back to H.264 */ })
    .finally(() => {
      if (!('IntersectionObserver' in window)) { inView = true; evaluate(); return; }
      new IntersectionObserver(entries => {
        const ratio = entries[entries.length - 1].intersectionRatio;
        // .49, not .5: a box exactly half on screen can report 0.4999 after rounding.
        if (ratio >= 0.49) inView = true;
        else if (ratio < 0.25) inView = false;
        evaluate();
      }, { threshold: [0, 0.25, 0.5] }).observe(frame);
    });
}

// Last, so every module-level binding above exists when setup() runs. Called from the top of
// the module, setup() reached the storage accessors before they were initialised and the
// remembered pause was silently never read (the harness caught it on a reload).
const figure = document.querySelector<HTMLElement>('[data-loop]');
const video = figure?.querySelector<WebKitVideo>('.loop__video');
const toggle = figure?.querySelector<HTMLButtonElement>('.loop__toggle');
const frame = figure?.querySelector<HTMLElement>('.loop__frame');
if (figure && video && toggle && frame) setup(figure, video, toggle, frame);
