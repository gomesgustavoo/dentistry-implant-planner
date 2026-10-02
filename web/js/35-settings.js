'use strict';
/* --------------------------------------------------------------- settings */

function setSettingsNote(id, msg, kind) {
  const el = $(id);
  if (!el) return;
  el.textContent = msg || '';
  el.className = 'form-note ' + (kind || '');
}

/** Paint whatever we already know. Called before the network, so the view never
 *  flashes empty on a revisit. */
function renderSettings() {
  const me = state.me;
  const ws = me && me.workspace;
  $('settingsWho').textContent = noAccounts()
    ? 'This server runs without accounts: every case on it is visible to anyone who can reach it.'
    : me
    ? [displayName(me), ws && !ws.isPersonal ? ws.name : null, me.plan.name]
        .filter(Boolean).join(' \u00b7 ')
    : 'Loading your account\u2026';

  const pf = (me && me.profile) || {};
  // Only overwrite the inputs when they are not being edited, or a poll would
  // yank half-typed text out from under the user.
  const name = $('pfName'), org = $('pfOrg');
  if (document.activeElement !== name) name.value = pf.displayName || '';
  if (document.activeElement !== org) org.value = pf.organisation || '';

  $('identityBlock').innerHTML = me ? `
    <div class="kvrow"><span>Email</span><span>${esc(pf.email || me.user.email || '\u2014')}</span></div>
    <div class="kvrow"><span>Username</span><span>${esc(pf.username || me.user.username || '\u2014')}</span></div>
    <div class="kvrow"><span>Account id</span><span>${esc(me.user.id || '\u2014')}</span></div>
    <p class="hint" style="margin:.5rem 0 0">
      Email, password and two-factor sign-in are held by the identity provider, not
      by this application, so they are changed
      <a href="${esc(pf.accountUrl || '#')}" target="_blank" rel="noopener">in your account console</a>.
    </p>` : '';

  renderPlanPanel();
  applyAccountMode();
}

function renderPlanPanel() {
  const me = state.me;
  const body = $('planBody');
  if (!me) { body.innerHTML = '<p class="empty">Loading\u2026</p>'; return; }

  const u = me.usage;
  const unlimited = u.limit == null;
  const left = unlimited ? '\u221e' : Math.max(0, u.limit - u.used);
  const frac = unlimited ? 1 : (u.limit ? Math.max(0, u.limit - u.used) / u.limit : 0);
  const scope = u.basis === 'trial' ? 'in your trial' : 'this month';
  const days = trialDaysLeft(me);
  const sub = me.subscription;

  const facts = [];
  if (days != null) facts.push(`trial ends in ${days} day${days === 1 ? '' : 's'}`);
  if (sub.currentPeriodEnd) {
    facts.push(`${sub.cancelAtPeriodEnd ? 'ends' : 'renews'} ${fmtDate(sub.currentPeriodEnd)}`);
  }
  facts.push(`status: ${sub.status}`);

  $('planHint').textContent = me.billingEnabled ? 'billed by Stripe' : 'billing not enabled';
  const meterClass = unlimited ? '' : (frac === 0 ? ' out' : frac <= 0.2 ? ' low' : '');
  let html = `<div class="planstate">
      <div class="planstate-top">
        <b>${esc(me.plan.name)}</b>
        <span class="hint">${left} of ${unlimited ? '\u221e' : u.limit} left ${scope}</span>
      </div>
      <div class="meterwide${meterClass}"><i style="width:${Math.round(frac * 100)}%"></i></div>
      <span class="hint">${esc(facts.join(' \u00b7 '))}</span>
    </div>`;

  if (!me.billingEnabled) {
    // Honest rather than a dead button: the server reports billingEnabled false
    // whenever Stripe has no key, and that is a deployment state, not an error.
    html += `<p class="empty">Online payment is not enabled on this deployment yet.
      Your plan can be changed by getting in touch.</p>`;
  } else {
    const hasSub = sub.status === 'active' || sub.status === 'past_due';
    html += `<div class="plans">${(state.plans || [])
      .filter((pl) => !pl.isTrial)
      .map((pl) => {
        const current = pl.id === me.plan.id;
        const label = current ? 'Current plan' : (hasSub ? 'Change in portal' : 'Choose');
        return `<div class="plancard${current ? ' current' : ''}">
          <span class="plancard-name">${esc(pl.name)}${current ? '<span class="tag">current</span>' : ''}</span>
          <span class="plancard-price">${pl.priceMonthly.toFixed(2)} / month</span>
          <span class="plancard-quota">${pl.jobQuota == null ? 'unlimited' : pl.jobQuota} segmentations a month</span>
          <button class="btn btn--sm${current ? '' : ' btn--primary'}" type="button"
            ${current ? 'disabled' : ''}
            data-plan="${esc(pl.id)}" data-portal="${hasSub ? '1' : ''}">${label}</button>
        </div>`;
      }).join('')}</div>`;
    if (hasSub) {
      html += `<div class="form-foot" style="margin-top:.9rem">
        <button class="btn" id="portalBtn" type="button">Manage billing</button>
        <span class="form-note" id="planNote">Invoices, card and cancellation are handled by Stripe.</span>
      </div>`;
    } else {
      html += '<p class="form-note" id="planNote" style="margin-top:.9rem"></p>';
    }
  }
  body.innerHTML = html;

  body.querySelectorAll('[data-plan]').forEach((b) => {
    b.onclick = () => (b.dataset.portal ? openPortal() : startCheckout(b.dataset.plan));
  });
  const portal = $('portalBtn');
  if (portal) portal.onclick = openPortal;
}

function renderUsageHistory(months) {
  const body = $('usageBody');
  if (!months || !months.length) {
    body.innerHTML = '<p class="empty">No segmentations recorded yet.</p>';
    return;
  }
  const peak = Math.max(...months.map((m) => m.jobs), 1);
  body.innerHTML = '<div class="usagelist">' + months.map((m) => {
    const when = new Date(m.month + 'T00:00:00Z');
    const label = when.toLocaleDateString(undefined, { year: 'numeric', month: 'short', timeZone: 'UTC' });
    const gpu = m.gpuSeconds ? ` \u00b7 ${fmtSecs(m.gpuSeconds)} GPU` : '';
    return `<div class="usagerow">
      <span>${esc(label)}</span>
      <span class="usagebar"><i style="width:${Math.round((m.jobs / peak) * 100)}%"></i></span>
      <span>${m.jobs}${esc(gpu)}</span>
    </div>`;
  }).join('') + '</div>';
}

async function loadSettingsData() {
  // /me first: everything else on this page is rendered against it.
  await refreshAccount();
  renderSettings();
  try {
    if (!state.plans) state.plans = (await api('/plans')).plans;
    renderPlanPanel();
  } catch (err) { console.warn('[plans]', err.message); }
  await refreshWorkspaces();
  await loadTeam();
  // Not awaited: the device list is one more panel, not a dependency of the ones below.
  loadDevices();
  try {
    renderUsageHistory((await api('/me/usage?months=12')).months);
  } catch (err) {
    $('usageBody').innerHTML = '<p class="empty">Usage history is unavailable right now.</p>';
  }
}

async function saveProfile(ev) {
  ev.preventDefault();
  const btn = $('pfSave');
  btn.disabled = true;
  setSettingsNote('pfNote', 'Saving\u2026');
  try {
    // Send both fields every time. PATCH treats an absent key as "leave alone",
    // and the form always knows the intended value of both -- including "" for a
    // field the user just cleared, which is a real edit and not a no-op.
    const profile = await api('/me', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName: $('pfName').value, organisation: $('pfOrg').value }),
    });
    if (state.me) state.me.profile = profile;
    renderAccount();
    $('settingsWho').textContent = `${displayName(state.me)} \u00b7 ${state.me.plan.name}`;
    setSettingsNote('pfNote', 'Saved.', 'ok');
  } catch (err) {
    setSettingsNote('pfNote', err.message || 'Could not save.', 'err');
  } finally {
    btn.disabled = false;
  }
}

function wireSettings() {
  $('profileForm').addEventListener('submit', saveProfile);
}

