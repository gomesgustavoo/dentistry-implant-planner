const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
// Rendered by Base.astro in the page's own language.
const T: Record<string, string> = (() => {
  try { return JSON.parse(document.getElementById('ui-strings')?.textContent || '{}'); } catch { return {}; }
})();
const say = (key: string, fallback: string) => T[key] || fallback;
const nav = document.querySelector<HTMLElement>('.nav');
const toggle = document.querySelector<HTMLButtonElement>('#navToggle');
const menu = document.querySelector<HTMLElement>('#navMenu');
const scrim = document.querySelector<HTMLElement>('#navScrim');
let menuOpen = false;
function setMenu(open: boolean, restoreFocus = false) {
  menuOpen = open;
  toggle?.setAttribute('aria-expanded', String(open));
  toggle?.setAttribute('aria-label', open ? say('closeMenu', 'Close menu') : say('openMenu', 'Open menu'));
  menu?.classList.toggle('is-open', open);
  if (scrim) scrim.hidden = !open;
  // Keep the sticky header in its scroll container; don't lock <html> overflow.
  document.querySelectorAll<HTMLElement>('main, footer').forEach(el => { el.inert = open; });
  if (open) menu?.querySelector<HTMLElement>('a')?.focus();
  else if (restoreFocus) toggle?.focus();
}
toggle?.addEventListener('click', () => setMenu(!menuOpen, menuOpen));
scrim?.addEventListener('click', () => setMenu(false, true));
menu?.addEventListener('click', e => { if ((e.target as Element).closest('a')) setMenu(false); });
document.addEventListener('keydown', e => {
  if (!menuOpen) return;
  if (e.key === 'Escape') { setMenu(false, true); return; }
  if (e.key === 'Tab') {
    const elements = [toggle, ...Array.from(menu?.querySelectorAll<HTMLAnchorElement>('a') || [])].filter(Boolean) as HTMLElement[];
    const first = elements[0], last = elements[elements.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
  }
});
window.matchMedia('(min-width: 1000px)').addEventListener('change', e => { if (e.matches) setMenu(false); });

// Prepare only offscreen content. Starting a fade on an already-visible card
// makes it disappear for a frame, especially during slow or restored scrolling.
// Without these APIs (or JavaScript), the normal document stays visible.
if ('IntersectionObserver' in window && 'animate' in Element.prototype && !reduced.matches) {
  const pending = new Map<HTMLElement, Animation>();
  const release = (el: HTMLElement) => {
    pending.get(el)?.cancel();
    pending.delete(el);
    observer.unobserve(el);
  };
  const observer = new IntersectionObserver(entries => {
    const arriving = entries.filter(entry => entry.isIntersecting);
    arriving.forEach(entry => {
      const el = entry.target as HTMLElement;
      const animation = pending.get(el);
      if (!animation) return;
      // Stagger neighbors on the same visual row, never stacked mobile cards.
      const column = arriving.filter(other => other.target.parentElement === el.parentElement
        && Math.abs(other.boundingClientRect.top - entry.boundingClientRect.top) < 8
        && other.boundingClientRect.left < entry.boundingClientRect.left).length;
      animation.effect?.updateTiming({ delay: Math.min(column, 2) * 70 });
      animation.play();
      observer.unobserve(el);
    });
  }, { rootMargin: '0px 0px 64px 0px', threshold: 0 });
  document.querySelectorAll<HTMLElement>('[data-reveal]').forEach(el => {
    // Leave the current viewport and everything already passed untouched,
    // including anchor navigation and pages restored while scripts were loading.
    if (el.getBoundingClientRect().top < window.innerHeight + 64) return;
    const animation = el.animate([
      { opacity: 0, translate: '0 16px' },
      { opacity: 1, translate: '0 0' },
    ], { duration: 800, easing: 'cubic-bezier(.22,.61,.36,1)', fill: 'both' });
    animation.pause();
    animation.currentTime = 0;
    animation.onfinish = () => release(el);
    pending.set(el, animation);
    observer.observe(el);
  });
  // Keyboard navigation must never land on a transparent control.
  document.addEventListener('focusin', event => {
    const el = (event.target as Element).closest<HTMLElement>('[data-reveal]');
    if (el) release(el);
  });
  reduced.addEventListener('change', () => {
    if (!reduced.matches) return;
    pending.forEach((_, el) => release(el));
    observer.disconnect();
  });
}

// Keep the scene visible when a phone's copy + scene exceed one viewport.
const stage = document.querySelector<HTMLElement>('[data-filmstage]');
const pin = document.querySelector<HTMLElement>('.stage-pin');
function sizePin() {
  if (!pin || !stage) return;
  const height = pin.offsetHeight;
  const header = nav?.offsetHeight || 64;
  stage.style.setProperty('--pin-height', `${height}px`);
  stage.style.setProperty('--pin-top', `${Math.min(header, window.innerHeight - height)}px`);
}
let scrollPending = false;
function updateScroll() {
  scrollPending = false;
  nav?.classList.toggle('is-scrolled', window.scrollY > 8);
  if (stage) {
    const travel = stage.offsetHeight - window.innerHeight;
    const progress = travel > 0 ? Math.max(0, Math.min(1, -stage.getBoundingClientRect().top / travel)) : 0;
    stage.style.setProperty('--scene-progress', String(progress));
  }
}
window.addEventListener('scroll', () => { if (!scrollPending) { scrollPending = true; requestAnimationFrame(updateScroll); } }, { passive: true });
window.addEventListener('resize', sizePin, { passive: true });
if (pin && 'ResizeObserver' in window) new ResizeObserver(sizePin).observe(pin);
document.fonts.ready.then(sizePin);
sizePin(); updateScroll();
document.querySelectorAll<HTMLAnchorElement>('a[href="#top"]').forEach(a => a.addEventListener('click', e => {
  e.preventDefault(); window.scrollTo({ top: 0, behavior: reduced.matches ? 'instant' : 'smooth' });
  history.replaceState(null, '', location.pathname + location.search);
}));

document.querySelectorAll<HTMLElement>('[data-video-id]').forEach(screen => {
  screen.querySelector<HTMLButtonElement>('button')?.addEventListener('click', () => {
    const iframe = document.createElement('iframe');
    const url = new URL(`https://www.youtube-nocookie.com/embed/${screen.dataset.videoId}`);
    url.search = new URLSearchParams({ start: screen.dataset.videoStart || '0', autoplay: '1', playsinline: '1', rel: '0' }).toString();
    iframe.src = url.href;
    iframe.title = screen.dataset.videoTitle || say('video', 'Video demonstration');
    iframe.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen';
    iframe.allowFullscreen = true;
    iframe.referrerPolicy = 'strict-origin-when-cross-origin';
    screen.replaceChildren(iframe);
    iframe.focus();
  }, { once: true });
});
document.querySelectorAll<HTMLDetailsElement>('.faq details').forEach(item => item.addEventListener('toggle', () => {
  if (item.open) document.querySelectorAll<HTMLDetailsElement>('.faq details').forEach(other => { if (other !== item) other.open = false; });
}));

// The engineering appendix keeps the original tooth-chart inspection accessible.
const chart = document.querySelector('#archChart');
const output = document.querySelector<HTMLElement>('#archReadout');
let latched: HTMLButtonElement | null = null;
const idle = say('toothIdle', 'Select a tooth to see what the segmentation found.');
function describeTooth(button: HTMLButtonElement | null) {
  if (!output) return;
  if (!button) { output.textContent = idle; return; }
  const d = button.dataset;
  if (button.classList.contains('tooth--absent')) { output.textContent = `FDI ${d.fdi} · ${say('toothAbsent', 'No label produced here')}`; return; }
  const n = Number(d.comp);
  const unit = n === 1 ? say('component', 'connected component') : say('components', 'connected components');
  const vol = d.vol ? Number(d.vol).toLocaleString(document.documentElement.lang, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—';
  output.textContent = `FDI ${d.fdi} · ${vol} cm³ · ${d.comp || '—'} ${unit}`;
}
chart?.addEventListener('click', event => {
  const button = (event.target as Element).closest<HTMLButtonElement>('.tooth');
  if (!button) return;
  const previous = latched;
  previous?.classList.remove('is-active'); previous?.setAttribute('aria-pressed', 'false');
  latched = previous === button ? null : button;
  latched?.classList.add('is-active'); latched?.setAttribute('aria-pressed', 'true'); describeTooth(latched);
});
chart?.addEventListener('focusin', event => describeTooth((event.target as Element).closest('.tooth')));
