/* The depth gauge under the live readout (markup in DepthGauge.astro).
 *
 * It draws ONE number: the platform depth hero3d.js measured for the frame it just rendered,
 * which it writes to the readout as data-depth (hero3d.js applyVerdict). Watching that
 * attribute, rather than recomputing depth from scroll progress here, is the point: the gauge
 * can never show a depth the scene did not grade, including when hero3d holds the seat still
 * at a crossing, eases toward the scroll position, or freezes under reduced motion.
 *
 * It is data, so it has no transition and no reduced-motion variant: the marker is wherever
 * the measurement is. Only transforms are written, on the elements themselves.
 * Before the scene is live (and forever, if WebGL or an asset fails) data-depth is absent and
 * the gauge stays at 0 with its ticks: a scale, not a reading.
 */
// A module, not a global script: its top-level names must not collide with other pages' scripts.
export {};

const gauge = document.querySelector<HTMLElement>('[data-gauge]');
const readout = document.querySelector<HTMLElement>('[data-hero-readout]');
const stage = document.querySelector<HTMLElement>('[data-filmstage]');

if (gauge && readout) {
  const max = Number(gauge.dataset.max);
  const track = gauge.querySelector<HTMLElement>('.gauge__track');
  const fill = gauge.querySelector<HTMLElement>('.gauge__fill');
  const marker = gauge.querySelector<HTMLElement>('.gauge__marker');
  let width = track?.clientWidth ?? 0;
  let shown = -1;

  const paint = () => {
    // The fallback readout is a saved example from another scan; a depth from the dead live
    // scene must not sit next to it.
    const live = !stage || stage.classList.contains('filmstage--live');
    const depth = Number(readout.dataset.depth);
    const f = live && Number.isFinite(depth) && max > 0 ? Math.min(1, Math.max(0, depth / max)) : 0;
    const px = f * width;
    if (f === shown && marker?.dataset.px === px.toFixed(1)) return;
    shown = f;
    if (fill) fill.style.transform = `scaleX(${f.toFixed(4)})`;
    if (marker) { marker.dataset.px = px.toFixed(1); marker.style.transform = `translateX(${px.toFixed(1)}px)`; }
  };

  // hero3d rewrites data-depth on every rendered frame while the seat moves; the observer
  // batches those into one paint per task, and paint() skips the write when nothing changed.
  new MutationObserver(paint).observe(readout, { attributes: true, attributeFilter: ['data-depth'] });
  if (stage) new MutationObserver(paint).observe(stage, { attributes: true, attributeFilter: ['class'] });
  if (track && 'ResizeObserver' in window) {
    new ResizeObserver(() => { width = track.clientWidth; paint(); }).observe(track);
  }
  paint();
}
