'use strict';
/* ---------------------------------------------------------------- account */
// Identity, plan and remaining allowance. Two surfaces, deliberately:
//
//   * a fixed-size chip in the topbar -- always visible, never grows. It replaced
//     a full-bleed strip that was a direct child of the body grid and therefore
//     absorbed the `1fr` row, which is what made a one-line trial countdown fill
//     a large monitor.
//   * an account menu behind the avatar, and a Settings view, for everything that
//     needs more than a number.

const PLAN_ORDER = ['explorer', 'clinician', 'enterprise'];

function quotaMessage(detail) {
  const err = detail && detail.error;
  const limit = detail && detail.limit;
  if (err === 'trial_expired') {
    return 'Your 14-day trial has ended. Choose a plan to keep segmenting.';
  }
  if (err === 'quota_exceeded') {
    return detail.basis === 'trial'
      ? `Your trial's ${limit} segmentations are used up. Choose a plan to continue.`
      : `You have used all ${limit} segmentations this month. They reset on the 1st, `
        + `or you can move up a plan now.`;
  }
  if (err === 'subscription_inactive') {
    return 'Your subscription is not active. Open billing to sort out the payment.';
  }
  if (err === 'no_subscription') return 'This account has no plan yet.';
  return 'This account cannot submit another scan right now.';
}

/** Trial days remaining, or null when this is not a trial. */
function trialDaysLeft(me) {
  if (!me || !me.plan.isTrial || !me.subscription.trialEndsAt) return null;
  const ends = new Date(me.subscription.trialEndsAt);
  return Math.max(0, Math.ceil((ends - Date.now()) / 86400000));
}

/** Who to call this account, in order of how much the user chose it. */
function displayName(me) {
  if (!me) return '';
  const pf = me.profile || {};
  return pf.displayName || me.user.username || pf.email || me.user.email || 'Account';
}

function initialsOf(name) {
  const parts = String(name || '').trim().split(/[\s@._-]+/).filter(Boolean);
  if (!parts.length) return '\u2014';
  const first = parts[0][0] || '';
  const second = parts.length > 1 ? (parts[1][0] || '') : '';
  return (first + second).toUpperCase().slice(0, 2);
}

/** The topbar chip. Everything about it is a fixed size -- that is the point. */
function renderUsageChip() {
  const chip = $('usageChip');
  const me = state.me;
  if (!chip) return;
  if (!me) { chip.hidden = true; return; }
  chip.hidden = false;

  const u = me.usage;
  const unlimited = u.limit == null;
  const left = unlimited ? Infinity : Math.max(0, u.limit - u.used);
  const frac = unlimited ? 1 : (u.limit ? left / u.limit : 0);
  $('usageFill').style.width = (unlimited ? 100 : Math.round(frac * 100)) + '%';
  chip.classList.toggle('low', !unlimited && left > 0 && frac <= 0.2);
  chip.classList.toggle('out', !unlimited && left === 0);

  const days = trialDaysLeft(me);
  const bits = [unlimited ? '\u221e' : `${left} left`];
  // The trial countdown lives here, at .72rem, and nowhere else in the chrome.
  if (days != null) bits.push(days === 0 ? 'trial ends today' : `${days}d trial`);
  $('usageText').textContent = bits.join(' \u00b7 ');
  chip.title = unlimited
    ? 'Unlimited segmentations on this plan'
    : `${u.used} of ${u.limit} used ${u.basis === 'trial' ? 'in your trial' : 'this month'}`;
}

/** Whether this deployment runs without accounts: no identity provider configured in
 *  web/config.js, or an API that says it requires none. Every request is then the one
 *  anonymous workspace, so what only an account can use -- profile, team, headsets,
 *  billing, the usage chip and the avatar -- is hidden rather than left loading. */
function noAccounts() {
  return !AUTH || !!(state.me && state.me.authRequired === false);
}

function applyAccountMode() {
  const off = noAccounts();
  ['acctBtn', 'usageChip', 'profilePanel', 'teamPanel', 'headsetPanel', 'planPanel']
    .forEach((id) => { const el = $(id); if (el && off) el.hidden = true; });
  ['sharedNoteHome'].forEach((id) => { const el = $(id); if (el) el.hidden = !off; });
}

/** The dropdown behind the avatar. Rebuilt on every open, from `state.me`. */
function renderAccount() {
  renderUsageChip();
  const menu = $('acctMenu');
  const me = state.me;
  if (!menu) return;

  const name = displayName(me);
  $('acctInitials').textContent = me ? initialsOf(name) : '\u2014';
  $('acctBtn').title = me ? name : 'Account';

  if (!me) {
    menu.innerHTML = '<button class="menu-item" data-act="signin" type="button">Sign in</button>';
  } else {
    const u = me.usage;
    const cap = u.limit == null ? '\u221e' : u.limit;
    const scope = u.basis === 'trial' ? 'in your trial' : 'this month';
    const days = trialDaysLeft(me);
    const mail = (me.profile || {}).email || me.user.email;

    const notes = [];
    if (days != null) notes.push(`Trial ends in ${days} day${days === 1 ? '' : 's'}.`);
    if (me.subscription.cancelAtPeriodEnd) notes.push('Cancels at period end.');

    menu.innerHTML = `
      <div class="menu-head">
        <span class="menu-name">${esc(name)}</span>
        ${mail && mail !== name ? `<span class="menu-mail">${esc(mail)}</span>` : ''}
      </div>
      <div class="menu-plan"><b>${esc(me.plan.name)}</b><span>${u.used} of ${cap} ${scope}</span></div>
      ${notes.length ? `<p class="menu-note">${esc(notes.join(' '))}</p>` : ''}
      ${workspaceSwitcherHtml()}
      <div class="menu-sep"></div>
      <a class="menu-item" href="#/settings" data-act="close">Settings</a>
      <a class="menu-item" href="#/settings" data-act="close">Plan &amp; billing</a>
      <div class="menu-sep"></div>
      <button class="menu-item danger" data-act="signout" type="button">Sign out</button>`;
  }

  menu.querySelectorAll('[data-switch]').forEach((el) => {
    el.onclick = (e) => { e.preventDefault(); switchWorkspace(el.dataset.switch); };
  });
  menu.querySelectorAll('[data-act]').forEach((el) => {
    el.onclick = () => {
      const act = el.dataset.act;
      if (act === 'signout' && AUTH) AUTH.signOut();
      if (act === 'signin' && AUTH) AUTH.signIn(location.pathname);
      closeAccountMenu();
    };
  });
  applyAccountMode();
}

/** The workspace list inside the account menu.
 *
 * Renders nothing at all for the overwhelmingly common case of one workspace:
 * a switcher with a single entry is a control that teaches the reader there is a
 * concept here, and then does nothing about it.
 */
function workspaceSwitcherHtml() {
  const list = state.workspaces || [];
  if (list.length < 2) return '';
  const active = state.me && state.me.tenantId;
  return '<div class="menu-sep"></div>'
    + '<div class="menu-label">Workspace</div>'
    + list.map((w) => `<a class="menu-item${w.id === active ? ' on' : ''}" href="#"
        data-switch="${esc(w.id)}">
        <span class="menu-ws">${esc(w.name)}${w.isPersonal ? ' <span class="hint">personal</span>' : ''}</span>
        <span class="hint">${w.members > 1 ? w.members + ' members' : w.role}</span>
      </a>`).join('');
}

function closeAccountMenu() {
  const menu = $('acctMenu');
  if (menu) menu.hidden = true;
  $('acctBtn').setAttribute('aria-expanded', 'false');
}

function wireAccountMenu() {
  const btn = $('acctBtn');
  const menu = $('acctMenu');
  btn.onclick = (e) => {
    e.stopPropagation();
    const open = menu.hidden;
    menu.hidden = !open;
    btn.setAttribute('aria-expanded', String(open));
  };
  // Any click outside closes it. `capture` so a handler that stops propagation
  // inside the page cannot leave the menu stuck open.
  document.addEventListener('click', (e) => {
    if (!menu.hidden && !menu.contains(e.target) && e.target !== btn) closeAccountMenu();
  }, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeAccountMenu(); });
}

async function refreshAccount() {
  try {
    state.me = await api('/me');
    renderAccount();
  } catch (err) {
    // A failed /me must not blank the workspace; the chip stays as it was.
    console.warn('[account]', err.message);
  }
}

async function startCheckout(planId) {
  if (!PLAN_ORDER.includes(planId)) planId = 'clinician';
  try {
    setNotice('Opening checkout\u2026');
    const { url } = await api('/billing/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ planId }),
    });
    window.location.assign(url);
  } catch (err) {
    // 409 means the account already has a subscription -- the server refuses to
    // open a second one (see billing.create_checkout). The portal is the way to
    // change plan, so say that rather than reporting a bare failure.
    setNotice('Could not open checkout: ' + err.message, 'err');
    setSettingsNote('planNote', err.message, 'err');
  }
}

async function openPortal() {
  try {
    const { url } = await api('/billing/portal', { method: 'POST' });
    window.location.assign(url);
  } catch (err) {
    setSettingsNote('planNote', 'Could not open billing: ' + err.message, 'err');
  }
}

/* A landing-page CTA can deep-link straight into checkout: /app?plan=clinician.
 * Consumed once and stripped from the URL so a reload does not reopen Stripe. */
function pendingPlanFromUrl() {
  const params = new URLSearchParams(location.search);
  const plan = params.get('plan');
  if (!plan) return null;
  params.delete('plan');
  const qs = params.toString();
  history.replaceState({}, '', location.pathname + (qs ? '?' + qs : '') + location.hash);
  return PLAN_ORDER.includes(plan) ? plan : null;
}

