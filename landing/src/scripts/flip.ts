/* Desktop container morph for the film dialog (GSAP Flip + CustomEase).
 *
 * Reached only through `import('./flip')` in player.ts, which warms the chunk on pointer or
 * focus intent over a film trigger, and only with (min-width:1024px) and (pointer:fine) and no
 * reduced motion. A click never waits for it: if the chunk is not here yet, or anything below
 * throws, the player runs its plain fade instead.
 *
 * The morph: the 16:9 media the visitor clicked (film card, chapter still, hero loop) grows
 * into the 16:9 player frame. Two things move together on the same curve:
 *   - the dark panel's clip-path, from the origin's rectangle out to the panel's own box;
 *   - the frame, through Flip.fit (x/y/scale only, so nothing re-lays out per frame).
 * Because both interpolate linearly between the same start rectangle and nested end
 * rectangles, the frame never leaves the clipped panel while it travels. The panel fades in
 * over the first 180 ms, so the first painted frame is the page's own still, not a dark box;
 * the side column follows 160 ms in. Transform, opacity and clip-path only.
 */
import { gsap } from 'gsap';
import { Flip } from 'gsap/Flip';
import { CustomEase } from 'gsap/CustomEase';

gsap.registerPlugin(Flip, CustomEase);
// The same curves as chrome.css --ease-out-expo and --ease-out.
const EXPO = CustomEase.create('ip.expo', '.16,1,.3,1');
const OUT = CustomEase.create('ip.out', '.23,1,.32,1');
const PANEL_RADIUS = 14; // FilmDialog.astro .player border-radius at desktop
const MEDIA_RADIUS = 10; // .ip-frame

/** A running open or close, as player.ts drives it. `finished` always settles. */
export interface Motion { finished: Promise<void>; finish(): void; cancel(): void }

/** Only a visible 16:9 origin morphs; anything else (a text link, a far-off card) fades. */
export function canMorph(origin: Element): boolean {
  const r = origin.getBoundingClientRect();
  if (r.width < 160 || r.height < 90 || Math.abs(r.width / r.height - 16 / 9) > 0.08) return false;
  const visible = Math.min(r.bottom, innerHeight) - Math.max(r.top, 0);
  return visible >= r.height * 0.4 && r.right > 0 && r.left < innerWidth;
}

const inset = (rect: DOMRect, box: DOMRect, radius: number) =>
  `inset(${rect.top - box.top}px ${box.right - rect.right}px ${box.bottom - rect.bottom}px ${rect.left - box.left}px round ${radius}px)`;
const FULL = `inset(0px 0px 0px 0px round ${PANEL_RADIUS}px)`;

/** Drop every inline style GSAP wrote, so the next open (morph or fade) starts clean. */
export function reset(dialog: HTMLElement, frame: HTMLElement, extras: HTMLElement[]) {
  dialog.classList.remove('is-morphing');
  gsap.killTweensOf([dialog, frame, ...extras]);
  gsap.set(dialog, { clearProps: 'clipPath,opacity' });
  gsap.set(frame, { clearProps: 'transform' });
  if (extras.length) gsap.set(extras, { clearProps: 'opacity,transform' });
}

function run(dialog: HTMLElement, frame: HTMLElement, extras: HTMLElement[], clearAtEnd: boolean,
  build: (tl: gsap.core.Timeline) => void): Motion {
  let settle!: () => void;
  const finished = new Promise<void>(resolve => { settle = resolve; });
  const tl = gsap.timeline({
    onComplete: () => {
      // The open ends on the natural layout, so its inline styles can go. The close ends on
      // the origin's rectangle and must hold there until dialog.close(); player.ts then calls
      // cancel(), which resets.
      if (clearAtEnd) reset(dialog, frame, extras);
      settle();
    },
  });
  build(tl);
  return {
    finished,
    finish: () => { tl.progress(1); settle(); },
    cancel: () => { tl.kill(); reset(dialog, frame, extras); settle(); },
  };
}

/** Call right after showModal(), in the same task, so the first painted frame is the start. */
export function morphOpen(dialog: HTMLElement, frame: HTMLElement, origin: Element, extras: HTMLElement[]): Motion {
  // The frame starts outside the panel's box; the panel scrolls (overflow:auto), which would
  // clip it. The clip-path does the clipping instead while the morph runs.
  dialog.classList.add('is-morphing');
  const from = inset(origin.getBoundingClientRect(), dialog.getBoundingClientRect(), MEDIA_RADIUS);
  const fit = Flip.fit(frame, origin, { scale: true, getVars: true }) as gsap.TweenVars;
  return run(dialog, frame, extras, true, tl => {
    tl.fromTo(dialog, { clipPath: from }, { clipPath: FULL, duration: 0.42, ease: EXPO }, 0)
      .fromTo(dialog, { opacity: 0 }, { opacity: 1, duration: 0.18, ease: 'none' }, 0)
      .from(frame, { ...fit, duration: 0.42, ease: EXPO }, 0);
    if (extras.length) tl.fromTo(extras, { opacity: 0, x: 8 }, { opacity: 1, x: 0, duration: 0.2, ease: OUT }, 0.16);
  });
}

/** The reverse, shorter (300 ms): the frame shrinks back onto the origin and dissolves. */
export function morphClose(dialog: HTMLElement, frame: HTMLElement, origin: Element, extras: HTMLElement[]): Motion {
  dialog.classList.add('is-morphing');
  const to = inset(origin.getBoundingClientRect(), dialog.getBoundingClientRect(), MEDIA_RADIUS);
  const fit = Flip.fit(frame, origin, { scale: true, getVars: true }) as gsap.TweenVars;
  return run(dialog, frame, extras, false, tl => {
    tl.fromTo(dialog, { clipPath: FULL }, { clipPath: to, duration: 0.3, ease: EXPO }, 0)
      .to(frame, { ...fit, duration: 0.3, ease: EXPO }, 0)
      .to(dialog, { opacity: 0, duration: 0.15, ease: 'none' }, 0.15);
    if (extras.length) tl.to(extras, { opacity: 0, duration: 0.12, ease: 'none' }, 0);
  });
}
