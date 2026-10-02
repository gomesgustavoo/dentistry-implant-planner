/* The chaptered film player: one native <dialog id="film">, opened by any a[data-film-open].
 *
 * Contract (shared with Intro, VrSection and loop.ts):
 *   - every trigger is an <a> whose href is the 720p H.264 file (#t=N when it has a start),
 *     so without JS, or without HTMLDialogElement.showModal, the link simply plays the file;
 *   - data-t="95" opens the player at 95 s;
 *   - window gets `ip:film-open` before the dialog opens and `ip:film-close` after it closes
 *     (the hero loop pauses and resumes on them). No analytics of any kind.
 *
 * The rules this file keeps, and why:
 *   - play() runs inside the click handler: iOS and the LinkedIn WebView only allow playback
 *     started synchronously from the gesture. The seek waits for loadedmetadata, because
 *     Safari drops a currentTime set before it.
 *   - All cleanup lives in the `close` event. Chrome's close watcher may close the dialog on a
 *     second Esc without firing `cancel`, so nothing may depend on our exit animation running.
 *   - Motion: phones get a WAAPI bottom sheet (--ease-drawer), desktop a 200 ms fade/scale or,
 *     when the GSAP chunk is already warm, the Flip morph in flip.ts; reduced motion gets a
 *     150 ms opacity fade and nothing else. Exits run at 70% of the entrance. WAAPI rather than
 *     CSS transitions because the dialog needs one stored, finishable handle per direction
 *     (a second Esc finishes the exit at once), and the shared stylesheet's reduced-motion
 *     kill (`transition:none!important`) does not apply to it; we gate on the query ourselves.
 */
import type { Motion } from './flip';

type FlipModule = typeof import('./flip');

// chrome.css tokens, mirrored: --ease-drawer, --ease-out, --dur-sheet (380 ms x 0.8 on phones).
const EASE_DRAWER = 'cubic-bezier(.32,.72,0,1)';
const EASE_OUT = 'cubic-bezier(.23,1,.32,1)';
const EXIT = 0.7;

const dialogEl = document.getElementById('film');
const supported = typeof HTMLDialogElement === 'function' && typeof HTMLDialogElement.prototype.showModal === 'function';
if (dialogEl instanceof HTMLElement && supported) init(dialogEl as HTMLDialogElement);

function init(dialog: HTMLDialogElement) {
  const video = dialog.querySelector<HTMLVideoElement>('.player__video');
  const frame = dialog.querySelector<HTMLElement>('.player__frame');
  const title = dialog.querySelector<HTMLElement>('#filmTitle');
  if (!video || !frame || !title) return;
  const fsButton = dialog.querySelector<HTMLButtonElement>('.player__fs');
  const errorBox = dialog.querySelector<HTMLElement>('[data-film-error]');
  const nav = dialog.querySelector<HTMLElement>('.player__chapters');
  const chapters = Array.from(dialog.querySelectorAll<HTMLButtonElement>('.player__chapters button[data-t]'));
  const starts = chapters.map(b => Number(b.dataset.t));
  const fills = Array.from(dialog.querySelectorAll<HTMLElement>('.chapter-bar__fill'));
  const extras = Array.from(dialog.querySelectorAll<HTMLElement>('[data-flip-extra]'));
  const manifestDuration = Number(dialog.dataset.duration) || 0;

  const desk = matchMedia('(min-width: 1024px) and (pointer: fine)');
  const reduce = matchMedia('(prefers-reduced-motion: reduce)');
  const phone = matchMedia('(max-width: 767px)');
  const canAnimate = 'animate' in Element.prototype;

  let opener: HTMLElement | null = null;
  let origin: Element | null = null;
  let pendingSeek: number | null = null;
  let motion: Motion | null = null;
  let closing = false;
  let current = -1;
  let inerted: HTMLElement[] = [];
  let flip: FlipModule | null = null;
  let flipRequested = false;

  // ---- media -------------------------------------------------------------------------------
  // AV1 is listed first. Where decoding it would not be power efficient (software AV1 on
  // mid-tier Android) those devices should take the H.264 file instead. The answer is async,
  // so it is only noted here; the swap happens in open(), inside the click, because the
  // load() that re-runs source selection also overrides preload="none" in Chromium (an
  // explicit load() fetches), and nothing may be fetched before the visitor asks.
  const av1 = video.querySelector<HTMLSourceElement>('source[data-codec="av1"]');
  let dropAv1 = false;
  if (av1 && navigator.mediaCapabilities?.decodingInfo) {
    navigator.mediaCapabilities.decodingInfo({
      type: 'file',
      video: { contentType: av1.type, width: 1280, height: 720, bitrate: Number(av1.dataset.bitrate) || 800_000, framerate: 30 },
    }).then(info => { dropAv1 = !(info.supported && info.powerEfficient); })
      .catch(() => { /* keep the browser's own choice */ });
  }

  const frameSrc = () => video.querySelector<HTMLSourceElement>('source:last-of-type')?.src ?? '';
  const totalTime = () => (Number.isFinite(video.duration) && video.duration > 0 ? video.duration : manifestDuration);

  function seek(t: number) {
    if (video!.readyState >= 1) {
      try { video!.currentTime = t; } catch { /* not seekable yet; the next loadedmetadata retries */ pendingSeek = t; return; }
      pendingSeek = null;
    } else pendingSeek = t;
    update(t);
  }

  video.addEventListener('loadedmetadata', () => {
    if (fsButton) fsButton.disabled = false;
    if (pendingSeek !== null) {
      const t = pendingSeek;
      pendingSeek = null;
      try { video.currentTime = t; } catch { /* leave it at the start */ }
    }
  });
  video.addEventListener('timeupdate', () => update(video.currentTime));
  video.addEventListener('seeked', () => update(video.currentTime));

  // Every source failed (or the file is broken): say so and hand over the file itself.
  const showError = () => { if (errorBox) errorBox.hidden = false; };
  video.addEventListener('error', showError);
  video.querySelector('source:last-of-type')?.addEventListener('error', showError);

  // ---- chapters ----------------------------------------------------------------------------
  function update(time: number) {
    let index = 0;
    for (let i = 0; i < starts.length; i++) if (time + 0.25 >= starts[i]) index = i;
    if (index !== current) {
      current = index;
      chapters.forEach((b, i) => {
        if (i === index) b.setAttribute('aria-current', 'true');
        else b.removeAttribute('aria-current');
      });
    }
    const total = totalTime();
    fills.forEach((fill, i) => {
      const start = starts[i] ?? 0;
      const end = starts[i + 1] ?? total;
      const share = end > start ? Math.min(1, Math.max(0, (time - start) / (end - start))) : 0;
      fill.style.transform = `scaleX(${share})`;
    });
  }
  // Every chapter is a Tab stop: seven 48 px buttons are a short run, and a roving tab stop
  // without a composite role hid six of them from keyboard and screen-reader users. The arrow
  // keys stay as a shortcut on top.
  nav?.addEventListener('keydown', event => {
    const at = chapters.indexOf(document.activeElement as HTMLButtonElement);
    if (at < 0) return;
    const last = chapters.length - 1;
    const next = event.key === 'ArrowDown' ? Math.min(at + 1, last)
      : event.key === 'ArrowUp' ? Math.max(at - 1, 0)
      : event.key === 'Home' ? 0
      : event.key === 'End' ? last : -1;
    if (next < 0) return;
    event.preventDefault();
    chapters[next].focus();
  });

  // ---- full screen ---------------------------------------------------------------------------
  // Disabled until loadedmetadata: iPhone's webkitEnterFullscreen throws before it, and it
  // must be called synchronously from the tap. Elsewhere the frame goes full screen and,
  // where the platform allows it (Android Chrome), the screen locks to landscape.
  fsButton?.addEventListener('click', () => {
    const v = video as HTMLVideoElement & { webkitEnterFullscreen?: () => void };
    if (!document.fullscreenEnabled || typeof frame.requestFullscreen !== 'function') {
      try { v.webkitEnterFullscreen?.(); } catch { /* the native controls still offer it */ }
      return;
    }
    if (document.fullscreenElement) { document.exitFullscreen().catch(() => {}); return; }
    frame.requestFullscreen({ navigationUI: 'hide' }).then(() => {
      const orientation = screen.orientation as (ScreenOrientation & { lock?: (o: string) => Promise<void> }) | undefined;
      orientation?.lock?.('landscape').catch(() => { /* desktop and iOS refuse; that is fine */ });
    }).catch(() => { /* refused: the native control remains */ });
  });
  document.addEventListener('fullscreenchange', () => {
    if (document.fullscreenElement) return;
    try { (screen.orientation as ScreenOrientation & { unlock?: () => void } | undefined)?.unlock?.(); } catch { /* nothing locked */ }
  });

  // ---- motion --------------------------------------------------------------------------------
  const settled: Motion = { finished: Promise.resolve(), finish() {}, cancel() {} };
  function waapi(...animations: (Animation | null)[]): Motion {
    const list = animations.filter((a): a is Animation => !!a);
    return {
      finished: Promise.all(list.map(a => a.finished.then(() => {}, () => {}))).then(() => {}),
      finish: () => list.forEach(a => { try { a.finish(); } catch { a.cancel(); } }),
      cancel: () => list.forEach(a => a.cancel()),
    };
  }
  function both(a: Motion, b: Motion): Motion {
    return {
      finished: Promise.all([a.finished, b.finished]).then(() => {}),
      finish: () => { a.finish(); b.finish(); },
      cancel: () => { a.cancel(); b.cancel(); },
    };
  }
  function backdrop(entering: boolean, duration: number): Animation | null {
    try {
      return dialog.animate({ opacity: entering ? [0, 1] : [1, 0] },
        { duration, easing: 'linear', pseudoElement: '::backdrop', fill: entering ? 'none' : 'forwards' });
    } catch { return null; } // no pseudo-element animation: the backdrop just appears
  }
  const sheetMs = () => 380 * (phone.matches ? 0.8 : 1);

  function enter(): Motion {
    if (!canAnimate) return settled;
    if (reduce.matches) {
      return waapi(dialog.animate({ opacity: [0, 1] }, { duration: 150, easing: 'linear' }), backdrop(true, 150));
    }
    if (desk.matches) {
      if (flip && origin && flip.canMorph(origin)) {
        try { return both(flip.morphOpen(dialog, frame!, origin, extras), waapi(backdrop(true, 280))); }
        catch { flip.reset(dialog, frame!, extras); }
      }
      return waapi(dialog.animate({ opacity: [0, 1], transform: ['scale(.98)', 'none'] }, { duration: 200, easing: EASE_OUT }), backdrop(true, 200));
    }
    const ms = sheetMs();
    return waapi(dialog.animate({ transform: ['translateY(100%)', 'none'] }, { duration: ms, easing: EASE_DRAWER }), backdrop(true, 200));
  }

  function leave(): Motion {
    if (!canAnimate) return settled;
    if (reduce.matches) {
      return waapi(dialog.animate({ opacity: [1, 0] }, { duration: 150 * EXIT, easing: 'linear', fill: 'forwards' }), backdrop(false, 150 * EXIT));
    }
    if (desk.matches) {
      // Morph back only to an origin still on screen, and only from an unscrolled panel
      // (the morph turns the panel's scrolling off, which would jump its content).
      if (flip && origin && dialog.scrollTop === 0 && flip.canMorph(origin)) {
        try { return both(flip.morphClose(dialog, frame!, origin, extras), waapi(backdrop(false, 300))); }
        catch { flip.reset(dialog, frame!, extras); }
      }
      return waapi(dialog.animate({ opacity: [1, 0], transform: ['none', 'scale(.98)'] }, { duration: 200 * EXIT, easing: EASE_OUT, fill: 'forwards' }), backdrop(false, 200 * EXIT));
    }
    const ms = sheetMs() * EXIT;
    return waapi(dialog.animate({ transform: ['none', 'translateY(100%)'] }, { duration: ms, easing: EASE_DRAWER, fill: 'forwards' }), backdrop(false, ms));
  }

  // ---- open / close --------------------------------------------------------------------------
  // The rest of the page goes inert too: showModal() already blocks it, but `inert` is what
  // older engines and our checks read, and it keeps find-in-page out of the covered page.
  function setInert(on: boolean) {
    if (on) {
      inerted = Array.from(document.body.children).filter((el): el is HTMLElement =>
        el instanceof HTMLElement && !(el instanceof HTMLScriptElement) && !el.contains(dialog) && !el.inert);
      inerted.forEach(el => { el.inert = true; });
    } else {
      inerted.forEach(el => { el.inert = false; });
      inerted = [];
    }
  }

  /** The 16:9 media a trigger stands for: its own, its row's, or (hero CTA) the loop frame. */
  function originFor(trigger: HTMLElement): Element | null {
    return trigger.querySelector('[data-flip-origin]')
      ?? trigger.closest('[data-flip-scope]')?.querySelector('[data-flip-origin]')
      ?? trigger.closest('section')?.querySelector('.loop__frame')
      ?? null;
  }

  function open(trigger: HTMLElement, t: number | null) {
    if (dialog.open) { if (t !== null) { seek(t); video!.play().catch(() => {}); } return; }
    opener = trigger;
    origin = originFor(trigger);
    closing = false;
    window.dispatchEvent(new CustomEvent('ip:film-open', { detail: { t } }));
    document.documentElement.classList.add('is-modal');
    if (dropAv1 && av1?.isConnected && video!.readyState === 0) {
      av1.remove();
      video!.load(); // re-select: the H.264 source is now first
    }
    if (video!.preload !== 'auto') video!.preload = 'auto';
    try {
      dialog.showModal();
    } catch {
      // Not connected, or opened non-modally by something else: undo, and let the link
      // do what it does without JS.
      document.documentElement.classList.remove('is-modal');
      window.dispatchEvent(new CustomEvent('ip:film-close'));
      location.assign(trigger instanceof HTMLAnchorElement ? trigger.href : frameSrc());
      return;
    }
    dialog.scrollTop = 0;
    setInert(true);
    if (t !== null) seek(t);
    // Still inside the click: this is the call the autoplay policy is judging. A refusal
    // leaves the native controls and the poster; the visitor presses play.
    video!.play().catch(() => {});
    motion = enter();
    title!.focus({ preventScroll: true });
  }

  function requestClose() {
    if (!dialog.open) return;
    if (closing) { motion?.finish(); return; } // second Esc or click: finish now
    closing = true;
    motion?.finish(); // an entrance still running ends first, so the exit starts from rest
    const exit = leave();
    motion = exit;
    exit.finished.then(() => { if (dialog.open && closing && motion === exit) dialog.close(); });
  }

  dialog.addEventListener('cancel', event => { event.preventDefault(); requestClose(); });
  dialog.addEventListener('close', () => {
    motion?.cancel();
    motion = null;
    closing = false;
    if (flip) flip.reset(dialog, frame, extras);
    video.pause(); // keep currentTime: reopening resumes where the visitor left
    if (document.fullscreenElement && dialog.contains(document.fullscreenElement)) document.exitFullscreen().catch(() => {});
    setInert(false);
    document.documentElement.classList.remove('is-modal');
    window.dispatchEvent(new CustomEvent('ip:film-close'));
    opener?.focus({ preventScroll: true });
    opener = null;
    origin = null;
  });

  dialog.addEventListener('click', event => {
    const target = event.target as Element;
    if (target === dialog) {
      // Clicks on ::backdrop land on the dialog itself; inside its box they are padding.
      const r = dialog.getBoundingClientRect();
      const { clientX: x, clientY: y } = event;
      if (x < r.left || x > r.right || y < r.top || y > r.bottom) requestClose();
      return;
    }
    if (target.closest('[data-film-close]')) { requestClose(); return; }
    const seekTo = target.closest<HTMLElement>('[data-t]');
    if (seekTo && dialog.contains(seekTo)) {
      const t = Number(seekTo.dataset.t);
      if (!Number.isFinite(t)) return;
      seek(t);
      video.play().catch(() => {}); // a chapter jump keeps (or starts) playing; no animation
    }
  });

  // ---- triggers ------------------------------------------------------------------------------
  document.addEventListener('click', event => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const trigger = (event.target as Element | null)?.closest?.<HTMLAnchorElement>('a[data-film-open]');
    if (!trigger || dialog.contains(trigger)) return;
    event.preventDefault();
    const raw = trigger.dataset.t;
    const t = raw !== undefined && raw !== '' && Number.isFinite(Number(raw)) ? Number(raw) : null;
    open(trigger, t);
  });

  // Warm the GSAP chunk on intent, desktop + fine pointer + motion allowed only. The open
  // never awaits it; a first click before it arrives simply fades.
  const warm = (event: Event) => {
    if (flipRequested || !desk.matches || reduce.matches) return;
    if (!(event.target as Element | null)?.closest?.('a[data-film-open]')) return;
    flipRequested = true;
    import('./flip').then(m => { flip = m; }).catch(() => { /* fade it is */ });
  };
  document.addEventListener('pointerover', warm, { passive: true });
  document.addEventListener('focusin', warm);

  update(0);
}
