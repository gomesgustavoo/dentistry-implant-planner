'use strict';
/* --------------------------------------------------------------- headsets */
// Pairing a Quest with this workspace. The dashboard mints a code, the headset reads it
// (QR or typed) and from then on carries an opaque device token of the API's own -- see
// api/routes/pair.py for why that is not a JWT and what it costs. This side has three
// jobs: list the devices so a credential can be seen and taken away, show the code
// exactly once, and say "Paired" the moment a headset claims it. There is no "was my
// code claimed?" endpoint and none is needed: `GET /pair/devices` lists claimed rows and
// its `id` is the `id` `/pair/start` returned, so the match is a poll over the list the
// panel shows anyway.

// The countdown's interval handle. Module-level rather than in `state` because nothing
// renders it; `stopPairing` is the only thing that should touch it.
let pairingTimer = null;

async function loadDevices() {
  const el = $('headsetBody');
  try {
    state.devices = (await api('/pair/devices')).devices;
  } catch (err) {
    state.devices = null;
    if (el) el.innerHTML = `<p class="empty">Paired headsets are unavailable right now
      (${esc(err.message)}).</p>`;
    return;
  }
  renderHeadsets();
}

/** The whole panel, from state: device rows, then the connect button or the live code. */
function renderHeadsets() {
  const el = $('headsetBody');
  if (!el) return;
  const devices = state.devices;
  const p = state.pairing;
  // `expiresAt` is the hard ceiling; `/pair/refresh` moves it on every reconnection, so
  // a headset in use never reaches it and one in a drawer does.
  const statusOf = (d) => d.revokedAt ? 'revoked'
    : (d.expiresAt && new Date(d.expiresAt).getTime() < Date.now()) ? 'expired' : 'active';

  const active = (devices || []).filter((d) => statusOf(d) === 'active').length;
  $('headsetHint').textContent = devices
    ? `${active} active · ${isOwner() ? 'every headset in this workspace' : 'the ones you paired'}`
    : '';

  const rows = (devices || []).map((d) => {
    const st = statusOf(d);
    const facts = [`paired by ${d.pairedBy || '—'} ${fmtAgo(d.pairedAt)}`];
    if (d.lastSeenAt) facts.push(`seen ${fmtAgo(d.lastSeenAt)}`);
    if (st === 'active') facts.push(`expires ${fmtDate(d.expiresAt)}`);
    return `<div class="memberrow">
      <span class="avatar avatar--sm" aria-hidden="true">VR</span>
      <span class="member-name">${esc(d.label)}
        <span class="member-mail">${esc(facts.join(' · '))}</span></span>
      <span class="tag tag--quiet">${st}</span>
      <span class="member-acts">${st === 'active'
        ? `<button class="link danger" data-revoke-device="${esc(d.id)}" type="button">revoke</button>`
        : ''}</span>
    </div>`;
  });

  // The code block is rendered from state, never written into the DOM directly, for the
  // reason `inviteLinkHtml` gives. An expired code stays on screen struck through: the
  // reader should see WHICH code died, not only that one did.
  const pairing = !p ? '' : `<div class="pairing">
    <div class="pairing-qr"><canvas id="pairQr" role="img"
      aria-label="QR code carrying pairing code ${esc(p.code)}"></canvas></div>
    <div class="pairmeta">
      <code class="paircode${p.expired ? ' expired' : ''}">${esc(p.code)}</code>
      <p class="form-note" id="pairLeft">${p.expired ? 'expired' : ''}</p>
      <p class="hint">Put on the headset, open ImplantPlan VR and look at this code
        — or type it on the sign-in panel. It works once.</p>
      <div class="form-foot">${p.expired
        ? '<button class="btn btn--primary" id="pairStart" type="button">New code</button>'
        : '<button class="btn btn--sm" id="pairCancel" type="button">Cancel</button>'}</div>
    </div>
  </div>`;

  el.innerHTML = `
    ${devices && devices.length ? `<div class="memberlist">${rows.join('')}</div>`
      : `<p class="empty">${devices
          ? 'No headset is paired yet. A paired headset opens this workspace’s cases in ImplantPlan VR.'
          : 'Loading…'}</p>`}
    ${p ? '' : `<div class="form-foot" style="margin-top:.9rem">
      <button class="btn btn--primary" id="pairStart" type="button">Connect a headset</button>
    </div>`}
    ${pairing}`;

  const start = $('pairStart');
  if (start) start.onclick = startPairing;
  const cancel = $('pairCancel');
  if (cancel) cancel.onclick = () => { stopPairing(); renderHeadsets(); };
  el.querySelectorAll('[data-revoke-device]')
    .forEach((b) => b.onclick = () => revokeDevice(b.dataset.revokeDevice));

  if (p) {
    const canvas = $('pairQr');
    // No encoder (blocked or failed script): hide the tile, keep the typed code.
    if (!drawQr(canvas, p.payload)) canvas.parentElement.hidden = true;
    if (!p.expired) tickPairing(true);   // paint the countdown now, not in a second
  }
}

async function startPairing() {
  const btn = $('pairStart');
  if (btn) btn.disabled = true;
  setSettingsNote('headsetNote', '');
  let r;
  try {
    r = await api('/pair/start', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: null }),
    });
  } catch (err) {
    setSettingsNote('headsetNote', err.message || 'Could not start pairing.', 'err');
    const b = $('pairStart');
    if (b) b.disabled = false;
    return;
  }
  // Stored BEFORE the render below, which rebuilds this whole panel. `ticks` drives the
  // every-fourth-second poll; `warned` makes the one-minute note fire once.
  stopPairing();
  state.pairing = { id: r.id, code: r.code, payload: r.payload, expiresAt: r.expiresAt,
                    expired: false, ticks: 0, warned: false };
  pairingTimer = setInterval(tickPairing, 1000);
  renderHeadsets();
}

/** One second of the countdown. `paintOnly` is the render's immediate first paint. */
function tickPairing(paintOnly) {
  const p = state.pairing;
  if (!p || p.expired) return;
  const left = Math.max(0, Math.round((new Date(p.expiresAt).getTime() - Date.now()) / 1000));
  if (left === 0) {
    // The server stopped honouring the code at `expiresAt`; the panel keeps the struck
    // code and offers a new one. Timer off first, so a slow render cannot tick twice.
    if (pairingTimer) { clearInterval(pairingTimer); pairingTimer = null; }
    p.expired = true;
    setSettingsNote('headsetNote', 'That code expired before a headset used it. Mint a new one when you are ready.');
    renderHeadsets();
    return;
  }
  const out = $('pairLeft');
  if (out) out.textContent = `expires in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
  if (left <= 60 && !p.warned) {
    p.warned = true;
    setSettingsNote('headsetNote', 'One minute left on this code.');
  }
  if (paintOnly === true) return;
  p.ticks += 1;
  if (p.ticks % 4 === 0) pollPaired();
}

/** Has a headset claimed the live code? `/pair/devices` lists claimed rows only, and the
 *  row id is the one `/pair/start` returned. Not awaited by the ticker. */
async function pollPaired() {
  const p = state.pairing;
  if (!p || p.expired) return;
  let devices;
  try { devices = (await api('/pair/devices')).devices; }
  catch (_) { return; }                             // transient; the next poll retries
  if (state.pairing !== p || p.expired) return;     // cancelled, replaced or expired in flight
  const mine = devices.find((d) => d.id === p.id);
  if (!mine) return;      // no re-render: it would redraw the QR under the reader's camera
  state.devices = devices;
  stopPairing();
  setSettingsNote('headsetNote', `Paired: ${mine.label}. It can open this workspace’s cases now.`, 'ok');
  renderHeadsets();
}

/** Drop the code: cancelled, paired, or the reader left Settings. */
function stopPairing() {
  if (pairingTimer) { clearInterval(pairingTimer); pairingTimer = null; }
  state.pairing = null;
  // The view may be hidden right now (leaving Settings), where nothing re-renders it until
  // the next visit's device load -- so take the block down here rather than let a dead
  // code sit in the page until then.
  const block = document.querySelector('#headsetBody .pairing');
  if (block) block.remove();
}

async function revokeDevice(id) {
  if (!window.confirm('Revoke this headset? Its next request is refused. Pair it again to let it back in.')) return;
  try {
    await api(`/pair/devices/${encodeURIComponent(id)}`, { method: 'DELETE' });
  } catch (err) { setSettingsNote('headsetNote', err.message, 'err'); return; }
  setSettingsNote('headsetNote', 'Headset revoked.', 'ok');
  await loadDevices();
}

/** Paint `text` as a QR into `canvas`. Returns false when the vendored encoder is missing
 *  or refuses the text, so the caller can hide the tile and keep the letters. Canvas 2D
 *  only: server text never reaches innerHTML here. ECC MEDIUM, a 4-module quiet zone and
 *  6 CSS px per module: the payload is ~40 bytes, so version 3 and (29 + 8) * 6 = 222 px,
 *  which a headset's passthrough camera reads from across a desk. */
function drawQr(canvas, text) {
  if (!canvas || typeof qrcodegen === 'undefined' || !qrcodegen.QrCode) return false;
  let qr;
  try { qr = qrcodegen.QrCode.encodeText(text, qrcodegen.QrCode.Ecc.MEDIUM); }
  catch (_) { return false; }
  const QUIET = 4, MODULE = 6;
  const cells = qr.size + 2 * QUIET;
  const css = cells * MODULE;
  // Backing store at device pixels, so the modules stay crisp on a 2x display.
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  canvas.width = Math.round(css * dpr);
  canvas.height = Math.round(css * dpr);
  canvas.style.width = css + 'px';
  canvas.style.height = css + 'px';
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, css, css);
  // `--ground`, the page's darkest token. Not `--ink`: on this dark page that is the
  // near-white TEXT colour, and a scanner wants the modules dark.
  ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--ground').trim() || '#0a0e13';
  for (let y = 0; y < qr.size; y++) {
    for (let x = 0; x < qr.size; x++) {
      if (qr.getModule(x, y)) ctx.fillRect((x + QUIET) * MODULE, (y + QUIET) * MODULE, MODULE, MODULE);
    }
  }
  return true;
}

