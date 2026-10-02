/* Chapter rows in section#demo: the word rises letter by letter and the still wipes open,
 * once, as the row scrolls in. Echoes the film's own Place. / Inspect. / Cut. cards (0:06-0:13).
 *
 * The contract every scroll effect on this page keeps (and check-motion / check-implantplan
 * assert):
 *   - only rows still below the fold when this runs are armed; anything on screen, or already
 *     scrolled past (a restored scroll, a #hash, late JS), is never hidden, not even for a frame;
 *   - never armed under prefers-reduced-motion, and a switch to reduce mid-session disarms all;
 *   - keyboard focus landing in an armed row releases it at once;
 *   - the hidden state is CSS that applies only with .is-armed and only inside
 *     @media (prefers-reduced-motion: no-preference) (VrSection.astro), so without this script
 *     nothing is ever hidden.
 * The marker is data-chapter-reveal, not data-reveal: the shared interactions.ts owns that
 * attribute and runs its own WAAPI fade on it.
 */
const reduce = matchMedia('(prefers-reduced-motion: reduce)');

function onChange(query: MediaQueryList, listener: () => void) {
  if (typeof query.addEventListener === 'function') query.addEventListener('change', listener);
  else query.addListener?.(listener); // Safari < 14
}

function boot() {
  const rows = Array.from(document.querySelectorAll<HTMLElement>('[data-chapter-reveal]'));
  if (!rows.length || reduce.matches || !('IntersectionObserver' in window)) return;

  const pending = new Set<HTMLElement>();
  const observer = new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const row = entry.target as HTMLElement;
      observer.unobserve(row);
      pending.delete(row);
      row.classList.add('is-in'); // the armed state has been styled by now: this transitions
    }
  }, { rootMargin: '0px 0px -12% 0px', threshold: 0 });

  const release = (row: HTMLElement) => {
    observer.unobserve(row);
    pending.delete(row);
    row.classList.remove('is-armed', 'is-in'); // the transitions live on .is-armed, so this is instant
  };

  const fold = window.innerHeight;
  for (const row of rows) {
    // top < fold covers both "on screen now" and "already above the viewport".
    if (row.getBoundingClientRect().top < fold) continue;
    row.classList.add('is-armed');
    pending.add(row);
    observer.observe(row);
  }
  if (!pending.size) return;

  document.addEventListener('focusin', event => {
    const row = (event.target as Element | null)?.closest?.<HTMLElement>('[data-chapter-reveal]');
    if (row && pending.has(row)) release(row);
  });
  onChange(reduce, () => {
    if (!reduce.matches) return;
    rows.forEach(release);
    observer.disconnect();
  });
}

boot();
