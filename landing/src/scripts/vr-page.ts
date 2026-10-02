/* /vr/ behaviour. Every control here ships `hidden` in the HTML (VrDownload.astro) and is
 * revealed only once this runs, so a reader without JS never meets a Copy or Share button
 * that does nothing. Every promise is caught: clipboard and share are permission-gated and
 * reject in some in-app browsers (LinkedIn's WebView among them), and a rejection there must
 * degrade to "select the text", never to a console error.
 */
const root = document.querySelector<HTMLElement>('[data-vr]');
if (root) init(root);

function init(root: HTMLElement) {
  const status = root.querySelector<HTMLElement>('[data-vr-status]');
  /** Clear first so the same message twice in a row is announced twice. */
  const announce = (message: string) => {
    if (!status) return;
    status.textContent = '';
    window.setTimeout(() => { status.textContent = message; }, 60);
  };

  // Copy: SHA-256, the adb and checksum commands, the page link.
  root.querySelectorAll<HTMLButtonElement>('button[data-copy]').forEach(button => {
    button.hidden = false;
    let reset = 0;
    button.addEventListener('click', () => {
      const text = button.dataset.copy || '';
      copyText(text, button)
        .then(ok => {
          if (!ok) { selectTarget(button); return; }
          button.dataset.state = 'done';
          announce(button.dataset.done || '');
          window.clearTimeout(reset);
          reset = window.setTimeout(() => { delete button.dataset.state; }, 2000);
        })
        .catch(() => selectTarget(button));
    });
  });

  // Share sheet: rendered only where the browser has one.
  const share = root.querySelector<HTMLButtonElement>('button[data-share]');
  if (share && typeof navigator.share === 'function') {
    const data: ShareData = { title: share.dataset.title || document.title, url: share.dataset.url || location.href };
    let supported = true;
    try { supported = typeof navigator.canShare !== 'function' || navigator.canShare(data); } catch { supported = false; }
    if (supported) {
      share.hidden = false;
      // AbortError is the visitor closing the sheet; there is nothing to report either way.
      share.addEventListener('click', () => { navigator.share(data).catch(() => {}); });
    }
  }

  // The mailto link works anywhere; it waits for JS only so the three actions appear together.
  root.querySelectorAll<HTMLElement>('[data-js-only]').forEach(el => { el.hidden = false; });

  // In the headset's own browser: say where the install actually happens.
  if (/OculusBrowser/.test(navigator.userAgent)) {
    root.querySelector<HTMLElement>('[data-quest-note]')?.removeAttribute('hidden');
  }

  // On a phone the APK button is the secondary action. The look is CSS (it holds without
  // JS); the class makes the same state visible to scripts/check-implantplan.mjs.
  const download = root.querySelector<HTMLElement>('[data-apk-download]');
  if (download) {
    const phone = window.matchMedia('(pointer: coarse) and (max-width: 767px)');
    const sync = () => download.classList.toggle('button--secondary', phone.matches);
    sync();
    listen(phone, sync);
  }

  // The sticky card sticks by its bottom when it is taller than the viewport (see the CSS).
  const card = root.querySelector<HTMLElement>('[data-vr-card]');
  if (card && 'ResizeObserver' in window) {
    new ResizeObserver(() => {
      card.style.setProperty('--vr-card-h', `${Math.ceil(card.offsetHeight)}px`);
    }).observe(card);
  }
}

async function copyText(text: string, origin: HTMLElement): Promise<boolean> {
  if (!text) return false;
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Denied (no user-activation credit, or a WebView without the permission): fall back.
    }
  }
  return legacyCopy(text, origin);
}

/** execCommand('copy') from an off-screen read-only textarea: the path older iOS and most
 *  WebViews still honour. 16 px so iOS does not zoom when it takes focus. */
function legacyCopy(text: string, origin: HTMLElement): boolean {
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.setAttribute('aria-hidden', 'true');
  area.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;padding:0;border:0;opacity:0;font-size:16px;pointer-events:none';
  document.body.append(area);
  let ok = false;
  try {
    area.focus({ preventScroll: true });
    area.select();
    area.setSelectionRange(0, text.length);
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  area.remove();
  origin.focus({ preventScroll: true });
  return ok;
}

/** Last resort: select the visible text, so the system's own copy menu is one tap away. */
function selectTarget(button: HTMLElement) {
  const target = button.dataset.copyTarget ? document.getElementById(button.dataset.copyTarget) : null;
  const selection = window.getSelection();
  if (!target || !selection) return;
  try {
    const range = document.createRange();
    range.selectNodeContents(target);
    selection.removeAllRanges();
    selection.addRange(range);
  } catch {
    // Nothing else to try; the text is still on screen.
  }
}

/** MediaQueryList.addEventListener arrived in Safari 14; addListener is the older spelling. */
function listen(query: MediaQueryList, handler: () => void) {
  if (typeof query.addEventListener === 'function') query.addEventListener('change', handler);
  else query.addListener(handler);
}
