/* Dentistry CBCT workspace.
 *
 * Deliberately dependency-free and build-free: no bundler, no Tailwind, no JSX.
 * That is partly a schedule decision, but it also sidesteps two traps this platform
 * has already paid for -- Tailwind v4 pruning `@theme` colours no class references
 * (which silently stripped 22 of 23 structure colours from a sibling app), and
 * React's `useId()` emitting colons that are invalid inside `url(#...)`. Structure
 * colours come from the server catalog and are applied as inline styles, so there is
 * nothing for a build step to prune.
 */
'use strict';

// Where the app is mounted, derived from this script's own URL rather than
// hardcoded, so the same files work at the root of dentistry.dicomsegvr.com and
// under the /dentistry path prefix on a sibling host.
const BASE = (() => {
  const src = document.currentScript && document.currentScript.src;
  const dir = new URL('.', src || location.href).pathname;
  return dir.replace(/\/$/, '');
})();
const API = BASE + '/v1';
const $ = (id) => document.getElementById(id);

// Cloudflare caps a request body at 100 MB, so an upload above that dies at the
// edge with a bare 413 that says nothing about why. Checked here so the message
// names the real limit instead.
const EDGE_BODY_LIMIT = 100 * 1024 * 1024;

const state = {
  jobs: [],
  poll: null,
  viewer: null,
  catalog: null,
  me: null,        // /v1/me: plan, subscription, usage, profile
  plans: null,     // /v1/plans, loaded lazily by the settings view
  view: 'cases',   // 'cases' | 'settings' | 'case' | 'invite'
  jobFilter: 'all',
  workspaces: null,        // /v1/tenants: every workspace this user belongs to
  members: null,           // userId -> display name, for the "by ..." line on a card
  // The last invite link minted in this session. Held in state, NOT only in the
  // DOM: the server stores the token hashed and returns the plaintext exactly
  // once, and `renderTeam` rebuilds the whole panel -- so a link written straight
  // into the panel is destroyed by the very refresh that follows creating it, and
  // is then unrecoverable. Cleared when leaving Settings.
  newInvite: null,
  ttlHours: 72,    // overwritten by /v1/system; never hardcode a deployment setting
};

/* ------------------------------------------------------------------ utils */
const AUTH = window.DentistryAuth || null;

/** Merge the bearer token into a fetch init, if we have one. */
/** Jobs whose bytes have changed under a URL that promised they would not.
 *
 *  Written by `markJobStale` after a hand correction is applied, and read by BOTH
 *  `api()` and `cachedFetch()`. It has to be both: `cachedFetch` covers the artifacts
 *  and `api` covers the job row itself, and the row is where `report.edits`, the
 *  re-checked quality block and the re-measured site heights live. Measured live -- with
 *  only `cachedFetch` consulting it, the case reopened after an applied correction and
 *  showed the PRE-EDIT report, correction history and all.
 *
 *  Declared up here rather than beside `markJobStale` because `authed` and `api` are the
 *  first things in this file and a `const` in a later block is not hoisted. */
const staleJobs = new Set();
// A `function`, not an arrow const: it is used by `api()` above it, and only a function
// declaration is hoisted. `web-auth/check-app.js` also only counts declarations, which
// is a fair rule -- a load-bearing helper it cannot see is a helper nothing guards.
function isStaleUrl(url) {
  if (!staleJobs.size) return false;
  for (const id of staleJobs) { if (String(url).includes(id)) return true; }
  return false;
}

async function authed(opts) {
  const init = Object.assign({}, opts);
  if (!AUTH) return init;
  const tok = await AUTH.token();
  if (!tok) return init;
  init.headers = Object.assign({}, init.headers, { Authorization: 'Bearer ' + tok });
  return init;
}

/** A 402 carries a machine-readable reason; the caller renders a real prompt. */
class QuotaError extends Error {
  constructor(detail) {
    super(detail.error || 'quota');
    this.name = 'QuotaError';
    this.detail = detail;
  }
}

async function api(path, opts) {
  // A case whose segmentation has been corrected in place: the row and its artifacts
  // both changed, and neither the HTTP cache nor Cache Storage may answer for them.
  const init = isStaleUrl(path) ? { cache: 'reload', ...(opts || {}) } : opts;
  let res = await fetch(API + path, await authed(init));
  // One retry after a forced renew. An access token is good for 300 s, so a tab
  // left open across that boundary would otherwise 401 on its next poll.
  if (res.status === 401 && AUTH && AUTH.isSignedIn()) {
    res = await fetch(API + path, await authed(init));
  }
  if (res.status === 401 && AUTH) { AUTH.signIn(location.pathname); throw new Error('Signing in'); }
  if (!res.ok) {
    let body = null;
    try { body = await res.json(); } catch (_) {}
    if (res.status === 402 && body && body.detail) throw new QuotaError(body.detail);
    throw new Error((body && body.detail) || res.statusText);
  }
  return res.status === 204 ? null : res.json();
}
const fmtBytes = (n) => n >= 1e9 ? (n / 1e9).toFixed(1) + ' GB' : (n / 1e6).toFixed(1) + ' MB';
const fmtSecs = (s) => s == null ? '—' : (s < 90 ? s.toFixed(0) + ' s' : (s / 60).toFixed(1) + ' min');
const fmtDate = (iso) => {
  if (!iso) return '\u2014';
  const d = new Date(iso);
  return isNaN(d) ? '\u2014' : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
};
/** "just now" / "14 min ago" / "3 days ago". Absolute date past a week, because
 *  "37 days ago" is a number nobody converts back into a date. */
const fmtAgo = (iso) => {
  if (!iso) return '';
  const then = new Date(iso);
  if (isNaN(then)) return '';
  const secs = (Date.now() - then.getTime()) / 1000;
  if (secs < 60) return 'just now';
  if (secs < 3600) return `${Math.floor(secs / 60)} min ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)} h ago`;
  if (secs < 7 * 86400) return `${Math.floor(secs / 86400)} d ago`;
  return fmtDate(iso);
};
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ---------------------------------------------------------- cached fetch */
// The viewer payload is the same bytes every time a case is opened, and the API
// now serves it pre-compressed with a long immutable Cache-Control (see
// worker/bake.py and api/main.py). Cornerstone's own volume cache is in-memory and
// dies with the tab, so a reload re-downloaded everything. Cache Storage survives
// reloads and new tabs, which turns a revisit into zero network.
// BUMP THIS whenever a job is reprocessed IN PLACE.
//
// Artifacts are addressed by job id and served `Cache-Control: immutable`, which is
// honest only because a finished job's files never change. Re-running the pipeline into
// an existing job id breaks that promise: the URL is identical, the bytes are not, and
// `immutable` means no browser will revalidate. A cache whose name changed is dropped
// wholesale, which is the one reliable way to retire entries nobody will re-check.
//
// v2: 2026-09-03, five v1-pack jobs reprocessed in place onto PACK_VERSION 3.
// v3: 2026-09-04, the three examples reprocessed in place for the section contours --
//     which also rewrote `arch.json` with the new `cross_sections.contours` key.
const CACHE_NAME = 'dentistry-artifacts-v3';
let cachePromise = null;
function artifactCache() {
  if (!('caches' in window)) return Promise.resolve(null);
  // Drop superseded caches once per session, so an in-place reprocess cannot leave a
  // reader looking at last week's pictures beside this week's measurements.
  if (!cachePromise && caches.keys) {
    caches.keys().then((ks) => ks.forEach((k) => {
      if (k.startsWith('dentistry-artifacts-') && k !== CACHE_NAME) caches.delete(k);
    })).catch(() => {});
  }
  cachePromise = cachePromise || caches.open(CACHE_NAME).catch(() => null);
  return cachePromise;
}

/** Fetch an immutable artifact, preferring Cache Storage. Returns a Response.
 *
 *  `fresh` forces past BOTH caches. Bumping `CACHE_NAME` drops Cache Storage, but
 *  `api/routes/files.py` serves an example's artifacts
 *  `Cache-Control: public, max-age=2592000, immutable`, so the browser's own HTTP disk
 *  cache holds them for a month and never revalidates. After an in-place reprocess that
 *  is a manifest from before the reprocess describing files from after it -- and the
 *  manifest is exactly where the "does this case have outlines" answer lives, so a
 *  stale one reports "this case predates them" about a case that has them.
 */
async function cachedFetch(url, fresh) {
  // A case whose segmentation has been corrected in place: the URL promised
  // `immutable` and the bytes changed anyway, so neither cache may answer for it.
  if (!fresh && isStaleUrl(url)) fresh = true;
  const store = await artifactCache();
  // Artifacts are behind the same bearer auth as everything else, so the token has
  // to travel with them. A cache HIT deliberately skips it: the bytes were already
  // authorised once and Cache Storage is per-origin and per-profile.
  const init = await authed(fresh ? { cache: 'reload' } : {});
  if (!store) return fetch(url, init);
  const hit = fresh ? null : await store.match(url).catch(() => null);
  if (hit) return hit;
  const res = await fetch(url, init);
  if (res.ok) {
    // put() consumes the body, so cache a clone and hand back the original.
    store.put(url, res.clone()).catch(() => {});
  }
  return res;
}

/** Load an artifact picture through the bearer-authenticated path.
 *
 *  `<img src>` cannot carry an Authorization header. With `DENT_REQUIRE_AUTH` true --
 *  which it has been in production since SSO landed -- `img.src = <api url>` is a
 *  guaranteed 401, and that is exactly how every planning picture and every slice tile
 *  came to be blank in the deployed app while both offline harnesses showed them
 *  perfectly: `check-rail.mjs` and `check-equivalence.mjs` serve `web/` off a static
 *  file server with no auth layer, so the one thing that breaks in production is the
 *  one thing they cannot see. `downloadPlanArtifact` already states this rule for
 *  `<a href>`; this is the same rule for `<img>`.
 *
 *  Bytes go through `cachedFetch`, so Cache Storage still turns a revisit into zero
 *  network. The blob URL is revoked by whoever owns the image -- `revokeImage()` below
 *  -- because an un-revoked object URL pins its blob for the lifetime of the document,
 *  and the tile cache alone holds 400 of them.
 */
async function loadAuthedImage(url) {
  let res = await cachedFetch(url);
  // The same one-shot retry api() does: an access token is good for 300 s, and a tab
  // left open across that boundary would otherwise fail on its next tile.
  if (res.status === 401 && AUTH && AUTH.isSignedIn()) res = await cachedFetch(url);
  if (!res.ok) throw new Error(String(res.status) + ' ' + (res.statusText || 'not available'));
  const blobUrl = URL.createObjectURL(await res.blob());
  try {
    const img = await new Promise((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('the image could not be decoded'));
      el.src = blobUrl;
    });
    img.dsvBlobUrl = blobUrl;
    return img;
  } catch (e) {
    URL.revokeObjectURL(blobUrl);
    throw e;
  }
}

/** Release an image returned by `loadAuthedImage`. Safe on anything else. */
function revokeImage(img) {
  if (img && img.dsvBlobUrl) { URL.revokeObjectURL(img.dsvBlobUrl); img.dsvBlobUrl = null; }
}

/** Is this image actually painted, as opposed to merely settled?
 *
 *  `HTMLImageElement.complete` is `true` for a BROKEN image as well as a loaded one --
 *  per spec it means the request reached a final state, not a successful one. The plan
 *  tab guarded `drawImage` with `img.complete` and therefore fed broken images straight
 *  into a canvas, which throws `InvalidStateError` and took the whole tab down with it:
 *  the throw escaped `drawRulers` into `addImplant`, which had already pushed the new
 *  implant into state, so the panel kept saying "No implant placed" while one was.
 *  `naturalWidth` is the discriminator: 0 on a broken image, never 0 on a decoded one.
 */
function isDrawable(img) {
  return !!(img && img.complete && img.naturalWidth > 0);
}

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

/* -------------------------------------------------------------- workspaces */
// A workspace is a tenant with more than one person in it. Everybody starts owning
// exactly one, so most accounts never see any of this -- which is why the switcher
// only appears once there is something to switch to.
//
// `role` is per workspace and NOT a property of the person: the same user owns
// their personal workspace and may be a plain member of a colleague's. Every render
// below reads it from `state.me.workspace`, never from a cached copy.

function isOwner() {
  return !!(state.me && state.me.workspace && state.me.workspace.role === 'owner');
}

/** userId -> name, so a case card can say who uploaded it. */
async function loadMembers(force) {
  const ws = state.me && state.me.workspace;
  // A workspace of one has exactly one possible answer, so asking is pure noise.
  if (!ws || (ws.members <= 1 && !force)) { state.members = null; return null; }
  try {
    const body = await api('/tenants/current/members');
    state.members = new Map(body.members.map((m) => [m.userId, m.name]));
    return body;
  } catch (err) {
    console.warn('[members]', err.message);
    return null;
  }
}

async function refreshWorkspaces() {
  try {
    state.workspaces = (await api('/tenants')).tenants;
  } catch (err) { console.warn('[workspaces]', err.message); }
  return state.workspaces;
}

async function switchWorkspace(tenantId) {
  try {
    await api('/tenants/switch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tenantId }),
    });
  } catch (err) {
    setNotice('Could not switch workspace: ' + err.message, 'err');
    return;
  }
  // Everything below is scoped to the active workspace, so all of it is stale.
  closeAccountMenu();
  state.jobs = []; state.members = null;
  await refreshAccount();
  await loadMembers();
  await Promise.all([refreshJobs(), refreshWorkspaces()]);
  if (state.view === 'settings') loadSettingsData();
}

/* ------------------------------------------------------------------- team */

function memberRow(m, you, ownerCount) {
  const isYou = m.userId === you;
  // The last owner has no valid action: demoting or removing them would leave a
  // workspace nobody can administer, and the server refuses it with a 409. Better
  // to not offer the button than to offer one that always fails.
  const lastOwner = m.role === 'owner' && ownerCount <= 1;
  const acts = [];
  if (isOwner() && !lastOwner) {
    acts.push(`<button class="link" data-role="${esc(m.userId)}"
      data-to="${m.role === 'owner' ? 'member' : 'owner'}" type="button">${
      m.role === 'owner' ? 'make member' : 'make owner'}</button>`);
  }
  if ((isOwner() || isYou) && !lastOwner) {
    acts.push(`<button class="link danger" data-remove="${esc(m.userId)}" type="button">${
      isYou ? 'leave' : 'remove'}</button>`);
  }
  return `<div class="memberrow">
    <span class="avatar avatar--sm" aria-hidden="true">${esc(initialsOf(m.name))}</span>
    <span class="member-name">${esc(m.name)}${isYou ? ' <span class="hint">(you)</span>' : ''}
      ${m.email && m.email !== m.name ? `<span class="member-mail">${esc(m.email)}</span>` : ''}</span>
    <span class="tag tag--quiet">${esc(m.role)}</span>
    <span class="member-acts">${acts.join('')}</span>
  </div>`;
}

function renderTeam(body) {
  const el = $('teamBody');
  const ws = state.me && state.me.workspace;
  if (!ws || !body) { el.innerHTML = '<p class="empty">Loading\u2026</p>'; return; }

  const ownerCount = body.members.filter((m) => m.role === 'owner').length;
  $('teamHint').textContent = `${body.members.length} member${body.members.length === 1 ? '' : 's'}`
    + ` \u00b7 you are ${ws.role === 'owner' ? 'an owner' : 'a member'}`;

  const others = (state.workspaces || []).filter((w) => w.id !== ws.id);
  el.innerHTML = `
    <div class="kvrow" style="margin-bottom:.9rem">
      <span>Workspace</span><span>${esc(ws.name || '\u2014')}${ws.isPersonal ? ' (personal)' : ''}</span>
    </div>
    ${others.length ? `<p class="hint" style="margin:-.5rem 0 .9rem">You also belong to
       ${others.map((w) => esc(w.name)).join(', ')} \u2014 switch from the account menu.</p>` : ''}
    <div class="memberlist">${body.members.map((m) => memberRow(m, body.yourUserId, ownerCount)).join('')}</div>
    ${(body.pending || []).length ? `<h4 class="subhead">Pending invitations</h4>
      <div class="memberlist">${body.pending.map((i) => `<div class="memberrow">
        <span class="avatar avatar--sm" aria-hidden="true">\u2709</span>
        <span class="member-name">${esc(i.email || 'anyone with the link')}
          <span class="member-mail">invited as ${esc(i.role)}</span></span>
        <span class="tag tag--quiet">pending</span>
        <span class="member-acts"><button class="link danger" data-revoke="${esc(i.id)}"
          type="button">revoke</button></span>
      </div>`).join('')}</div>` : ''}
    ${isOwner() ? `<form class="form invite-form" id="inviteForm">
      <label class="field">
        <span>Invite someone</span>
        <input type="email" id="invEmail" placeholder="colleague@clinic.example (optional)"
               autocomplete="off">
      </label>
      <div class="form-foot">
        <select id="invRole" class="select">
          <option value="member">Member — submit and view cases</option>
          <option value="owner">Owner — also manage members and billing</option>
        </select>
        <button class="btn btn--primary" id="invSend" type="submit">Create invite link</button>
      </div>
      <p class="form-note" id="invNote">Everyone in a workspace shares its cases
        <b>and its monthly allowance</b>. There is no mail sender here, so you will get a
        link to pass on yourself.</p>
      ${inviteLinkHtml()}
    </form>` : `<p class="hint" style="margin-top:.9rem">Only an owner can invite people
      to this workspace.</p>`}`;

  const form = $('inviteForm');
  if (form) form.addEventListener('submit', createInvite);
  wireInviteCopy();
  el.querySelectorAll('[data-remove]').forEach((b) => b.onclick = () => removeMember(b.dataset.remove));
  el.querySelectorAll('[data-role]').forEach((b) => b.onclick = () => setMemberRole(b.dataset.role, b.dataset.to));
  el.querySelectorAll('[data-revoke]').forEach((b) => b.onclick = () => revokeInvite(b.dataset.revoke));
}

/** The one-time invite link, re-rendered from state on every panel rebuild. */
function inviteLinkHtml() {
  const inv = state.newInvite;
  if (!inv) return '<div id="inviteOut" hidden></div>';
  return `<div id="inviteOut">
    <p class="form-note ok">Invite created${inv.email ? ' for ' + esc(inv.email) : ''} \u2014
      copy this link now, it is not shown again.</p>
    <div class="invitelink"><code id="invUrl">${esc(inv.url)}</code>
      <button class="btn btn--sm" id="invCopy" type="button">Copy</button></div>
  </div>`;
}

function wireInviteCopy() {
  const btn = $('invCopy');
  if (!btn || !state.newInvite) return;
  btn.onclick = async () => {
    try {
      await navigator.clipboard.writeText(state.newInvite.url);
      btn.textContent = 'Copied';
    } catch (_) {
      // Clipboard needs a secure context and permission; selecting the text is the
      // fallback that always works.
      const r = document.createRange();
      r.selectNodeContents($('invUrl'));
      const sel = window.getSelection();
      sel.removeAllRanges(); sel.addRange(r);
      btn.textContent = 'Select + copy';
    }
  };
}

async function loadTeam() {
  // `force`: the Workspace panel must list members even for a workspace of one,
  // which is the case where `loadMembers` deliberately skips the request.
  renderTeam(await loadMembers(true));
}

async function createInvite(ev) {
  ev.preventDefault();
  const btn = $('invSend');
  btn.disabled = true;
  try {
    const body = { role: $('invRole').value };
    const email = $('invEmail').value.trim();
    if (email) body.email = email;
    // Stored BEFORE the refresh below, which rebuilds this whole panel.
    state.newInvite = await api('/tenants/current/invites', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    await loadTeam();          // re-renders the link from state, and lists it as pending
  } catch (err) {
    setSettingsNote('invNote', err.message || 'Could not create the invite.', 'err');
  } finally {
    const b = $('invSend');
    if (b) b.disabled = false;
  }
}

async function removeMember(userId) {
  const you = state.me && state.me.user.id;
  const leaving = userId === you;
  if (!window.confirm(leaving
    ? 'Leave this workspace? Its cases stay with the workspace, not with you.'
    : 'Remove this person? Cases they uploaded stay in this workspace.')) return;
  try {
    await api(`/tenants/current/members/${userId}`, { method: 'DELETE' });
  } catch (err) {
    setSettingsNote('invNote', err.message, 'err');
    return;
  }
  // Leaving changes which workspace you are in, so everything is stale.
  if (leaving) { await switchToPersonalAfterLeaving(); return; }
  await Promise.all([refreshAccount(), loadTeam()]);
}

/** After leaving, the server has already dropped us back to our own workspace. */
async function switchToPersonalAfterLeaving() {
  state.jobs = []; state.members = null;
  await refreshAccount();
  await Promise.all([refreshJobs(), refreshWorkspaces()]);
  loadSettingsData();
}

async function setMemberRole(userId, role) {
  try {
    await api(`/tenants/current/members/${userId}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role }),
    });
  } catch (err) { setSettingsNote('invNote', err.message, 'err'); return; }
  await Promise.all([refreshAccount(), loadTeam()]);
}

async function revokeInvite(id) {
  try {
    await api(`/tenants/current/invites/${id}`, { method: 'DELETE' });
  } catch (err) { setSettingsNote('invNote', err.message, 'err'); return; }
  await loadTeam();
}

/* ----------------------------------------------------------------- invites */

async function renderInvite(token) {
  const panel = $('invitePanel');
  panel.innerHTML = '<h1>Checking your invitation\u2026</h1>';
  let inv;
  try {
    inv = await api('/invites/' + encodeURIComponent(token));
  } catch (err) {
    panel.innerHTML = `<h1>That invitation is not valid</h1>
      <p>${esc(err.message)} Invitations expire after 14 days, and each one can be
      used once. Ask whoever invited you for a fresh link.</p>
      <a class="btn btn--primary" href="#/cases">Go to your cases</a>`;
    return;
  }
  if (inv.alreadyMember) {
    panel.innerHTML = `<h1>You are already in ${esc(inv.workspace)}</h1>
      <p>Nothing to do \u2014 switch to it from the account menu whenever you like.</p>
      <a class="btn btn--primary" href="#/cases">Go to your cases</a>`;
    return;
  }
  panel.innerHTML = `<h1>Join ${esc(inv.workspace)}</h1>
    <p>You have been invited as <b>${esc(inv.role)}</b>. Joining lets you see and submit
      cases in this workspace \u2014 everyone in it shares its cases and its monthly
      allowance. Your own workspace stays yours, and you can switch between them.</p>
    <button class="btn btn--primary" id="inviteAccept" type="button">Join ${esc(inv.workspace)}</button>
    <p class="gate__foot"><a href="#/cases">No thanks, take me to my cases</a></p>`;
  $('inviteAccept').onclick = async () => {
    $('inviteAccept').disabled = true;
    try {
      await api(`/invites/${encodeURIComponent(token)}/accept`, { method: 'POST' });
    } catch (err) {
      panel.innerHTML = `<h1>Could not join</h1><p>${esc(err.message)}</p>
        <a class="btn btn--primary" href="#/cases">Go to your cases</a>`;
      return;
    }
    state.jobs = []; state.members = null;
    await refreshAccount();
    await Promise.all([refreshJobs(), refreshWorkspaces(), loadMembers()]);
    navigate('#/cases');
  };
}

/* ----------------------------------------------------------------- router */
// The SPA used to have no router at all, and said so in three comments: with one
// page and one modal it would have been ceremony. A Settings view changes that --
// a view you can be *on* needs an address, or the back button lies and a link to
// it cannot exist. Hash routing, because the app is static files behind nginx and
// a path router would need a rewrite rule per route.
//
//   #/cases          the catalogue (default)
//   #/settings       account, plan, usage
//   #/case/<job-id>  one case open in the workspace
//
// `openViewer`/`closeViewer` only navigate; `route()` is the single place that
// decides what is on screen, so the two cannot disagree.

function parseRoute() {
  const raw = (location.hash || '').replace(/^#\/?/, '');
  const parts = raw.split('/').filter(Boolean);
  if (parts[0] === 'settings') return { view: 'settings' };
  if (parts[0] === 'contact') return { view: 'contact' };
  if (parts[0] === 'case' && parts[1]) return { view: 'case', jobId: parts[1] };
  // The token is the rest of the hash, not just parts[1]: `token_urlsafe` can emit
  // '-' and '_' but never '/', so one segment is right -- and taking the remainder
  // means a future token format cannot silently truncate to a valid-looking prefix.
  if (parts[0] === 'invite' && parts[1]) return { view: 'invite', token: parts.slice(1).join('/') };
  return { view: 'cases' };
}

function navigate(hash) {
  if (location.hash === hash) route();
  else location.hash = hash;
}

async function route() {
  const r = parseRoute();
  // A case is the only view that owns the whole window, so leaving one has to
  // undo that before anything else is shown.
  if (r.view !== 'case' && state.viewer) teardownCase();

  state.view = r.view;
  $('nav').hidden = r.view === 'case';
  $('casebar').hidden = r.view !== 'case';
  document.querySelectorAll('.nav-item')
    .forEach((a) => a.classList.toggle('on', a.dataset.view === r.view));

  $('home').hidden = r.view !== 'cases';
  $('contact').hidden = r.view !== 'contact';
  $('settings').hidden = r.view !== 'settings';
  $('workspace').hidden = r.view !== 'case';
  $('inviteGate').hidden = r.view !== 'invite';
  $('nav').hidden = r.view === 'case' || r.view === 'invite';

  // A one-time secret has no business surviving a navigation.
  if (r.view !== 'settings') state.newInvite = null;
  if (r.view === 'settings') { renderSettings(); loadSettingsData(); }
  if (r.view === 'contact') renderContact();
  // The schematic holds a WebGL context, so it is mounted with the view and disposed
  // when the view leaves. This SPA hides and shows its views rather than reloading, so
  // a leaked context per visit is the kind of thing that works for a week.
  // Not awaited: the router must not block on six mesh fetches, and the picker beside
  // the pane is fully usable without it. Failures are reported inside.
  if (r.view === 'cases') { wireModelsPanel(); mountModelSchematic(); }
  else unmountModelSchematic();
  if (r.view === 'case') await openCase(r.jobId);
  if (r.view === 'invite') await renderInvite(r.token);
  if (r.view !== 'case') window.scrollTo({ top: 0 });
}

/* ============================================================ the model picker
 * "Which model segments which structure" was a DEPLOYMENT setting -- `TF3_BOARD` plus
 * one directory per specialist -- and the person uploading the scan could neither see
 * it nor change it. The board itself was always built for this: a base model that
 * paints the whole taxonomy, and specialists that each overwrite only the Task-1 ids
 * they own, with every voxel outside a specialist's own region asserted byte-identical
 * to the base prediction on every case. What was missing was the choice.
 *
 * Three rules this panel holds to.
 *
 * IT NEVER OFFERS A MODEL THAT IS NOT THERE. The API pod mounts no model store, so
 * availability comes from an inventory the worker writes when it starts. A model whose
 * files are missing is disabled WITH THE REASON, because the alternative is an upload
 * accepted against it and failed forty seconds in, with the volume already written.
 *
 * IT SHOWS THE EVIDENCE, NOT A RECOMMENDATION. "ToothSeg won ToothFairy2" and "our
 * holdout is a split of ToothSeg's own training data, so its wins here prove nothing"
 * are both true and the second is the one that decides the default. Every card carries
 * the measured reason it is on or off, from `dentistry/models.py`, once.
 *
 * `shadow` IS A FIRST-CLASS CHOICE. A model can run, have its opinion recorded in the
 * report, and stamp nothing. That is the honest way to accumulate evidence on real
 * clinical scans for a model our own holdout cannot settle.
 */
let MODEL_MENU = null;
/** `{key: mode}`, the reader's choice. Empty until they touch something, so an upload
 *  with no interaction sends NO config and gets the deployment default -- which is a
 *  different, and truthful, thing from "the reader chose the defaults". */
let modelChoice = {};

async function loadModelMenu() {
  if (MODEL_MENU) return MODEL_MENU;
  try {
    const got = await api('/models');
    // NORMALISED, not trusted. A reply without `models` is what an older API or a
    // proxy error page looks like, and `menu.models.length` on it throws inside
    // `route()` -- which is how a blank app shipped once already. A shape this client
    // cannot use is the same case as a call that failed, and it says so.
    MODEL_MENU = (got && Array.isArray(got.models))
      ? { defaults: {}, ...got }
      : { models: [], defaults: {},
          reason: 'This deployment did not return a model list, so only its default '
                  + 'configuration will run.' };
  } catch (e) {
    MODEL_MENU = { models: [], defaults: {},
                   reason: `The model list could not be loaded (${e.message}).` };
  }
  return MODEL_MENU;
}

function modelMode(m) {
  if (modelChoice[m.key]) return modelChoice[m.key];
  const d = (MODEL_MENU && MODEL_MENU.defaults) || {};
  return d[m.key] || m.default_mode;
}

const MODE_LABEL = {
  apply: 'apply',
  shadow: 'shadow',
  off: 'off',
};
const MODE_WHY = {
  apply: 'Runs, and its output is stamped into your result for the structures it owns.',
  shadow: 'Runs, and its opinion is recorded in the report without changing your result.',
  off: 'Does not run.',
};

/** Render the picker. Idempotent: called on first paint and after every choice. */
function renderModelPicker() {
  const box = $('modelList');
  if (!box) return;
  const menu = MODEL_MENU;
  if (!menu) { box.innerHTML = '<p class="empty">loading the model list&hellip;</p>'; return; }
  if (!(menu.models || []).length) {
    box.innerHTML = `<p class="hint bad">${esc(menu.reason
      || 'No models are published by this deployment.')}</p>`;
    return;
  }
  // TWO SECTIONS, because they answer different questions. A Task-1 specialist competes
  // for structures the base model also draws, so choosing it is a judgement about which
  // model is right. An extended model adds anatomy nothing else draws and structurally
  // cannot overwrite anything, so choosing it is a judgement about whether the anatomy is
  // worth two minutes of GPU. Putting both in one list invites reading the second as the
  // first, which would make a CT-trained soft-tissue model look like a rival to the
  // segmentation the measurements come from.
  const card = (m) => {
    const mode = modelMode(m);
    const off = !m.installed;
    const n = (m.structures || []).length;
    // What it owns, as a COUNT plus the first few names. Thirty-two tooth ids as chips
    // is a wall, and the question is which family rather than which tooth.
    const owns = n === 0 ? 'nothing by default'
      : n > 6 ? `${n} structures &mdash; ${m.groups.join(', ')}`
      : m.structures.map((x) => structureName(x) || x).join(', ');
    const modes = (m.modes || []).map((k) => `
      <button type="button" class="segb ${mode === k ? 'on' : ''}"
        data-model="${esc(m.key)}" data-mode="${k}" ${off || m.modes.length < 2 ? 'disabled' : ''}
        title="${esc(MODE_WHY[k] || '')}">${MODE_LABEL[k] || k}</button>`).join('');
    return `<article class="modelcard ${off ? 'unavail' : ''} ${mode === 'off' ? 'is-off' : ''}"
        data-model="${esc(m.key)}" data-groups="${esc((m.groups || []).join(' '))}"
        tabindex="0" aria-label="${esc(m.name)}">
      <header>
        <b>${esc(m.name)}</b>
        <span class="modelbadge ${m.origin === 'third-party' ? 'third' : ''}"
              title="${m.role === 'base' ? 'The base model. It draws the whole taxonomy; every specialist only overwrites ids inside its own region.' : 'A specialist: it overwrites only the ids it owns, inside a region derived from the base model’s own prediction.'}"
        >${m.role === 'base' ? 'base' : 'specialist'}${m.origin === 'third-party' ? ' &middot; third-party' : ''}</span>
      </header>
      <p class="modelowns">${owns}</p>
      ${m.unmeasured ? `<p class="modelcaveat" title="These are CT-trained models read on
        a CBCT. Whether that transferred is measured on your scan before anything is
        drawn, and none of these structures carries an error budget.">context only
        &mdash; gated on your scan, and never measured from</p>` : ''}
      <div class="modelrow">
        <div class="seg modelmodes" role="group"
             aria-label="How ${esc(m.name)} runs">${modes}</div>
        <span class="modelcost">${m.seconds ? `~${Math.round(m.seconds)} s` : ''}</span>
      </div>
      ${off ? `<p class="hint bad">${esc(m.reason || 'Not installed on this deployment.')}</p>` : ''}
      <details class="sidenote">
        <summary>What is measured about it</summary>
        <p class="finding-why">${esc(m.evidence || '')}</p>
        ${m.tradeoff ? `<p class="finding-why">${esc(m.tradeoff)}</p>` : ''}
        <p class="finding-why">Licence: ${esc(m.license || 'unstated')}.</p>
      </details>
    </article>`;
  };

  const models = menu.models || [];
  const core = models.filter((m) => m.space !== 'extended');
  const ext = models.filter((m) => m.space === 'extended');
  box.innerHTML = core.map(card).join('')
    + (ext.length ? `<div class="modelsection">
        <h3>More anatomy</h3>
        <p class="hint">Structures outside the dental taxonomy, drawn by CT-trained
          models read on your CBCT. They are added <b>beside</b> the segmentation and can
          never overwrite it, so turning one on cannot change a single clearance. Off by
          default; each costs about a minute.</p>
      </div>` : '')
    + ext.map(card).join('');

  // The reader has to be told when the list itself is second-hand.
  const hint = $('modelsHint');
  if (hint) {
    const age = menu.reported_age_hours;
    hint.textContent = menu.reason ? menu.reason
      : menu.stale ? `the worker last reported ${Math.round(age / 24)} days ago`
      : 'choose before you upload';
    hint.className = menu.reason || menu.stale ? 'hint bad' : 'hint';
  }
  wireModelPicker();
}

function wireModelPicker() {
  const box = $('modelList');
  if (!box) return;
  box.querySelectorAll('button[data-mode]').forEach((b) => {
    b.onclick = () => {
      modelChoice[b.dataset.model] = b.dataset.mode;
      renderModelPicker();
      renderUploadPlan();
    };
  });
  // Hover or focus a card: bring its structures forward in the schematic and ghost the
  // rest. Ghosted rather than hidden -- which structures a model does NOT own is half
  // the answer, and a scene that empties out says nothing about where the canals are.
  box.querySelectorAll('.modelcard').forEach((el) => {
    const groups = (el.dataset.groups || '').split(/\s+/).filter(Boolean);
    const on = () => { if (window.DentistryViewer && DentistryViewer.highlightGroups) DentistryViewer.highlightGroups(groups); };
    const offAll = () => { if (window.DentistryViewer && DentistryViewer.highlightGroups) DentistryViewer.highlightGroups(null); };
    el.onmouseenter = on;
    el.onfocus = on;
    el.onmouseleave = offAll;
    el.onblur = offAll;
  });
}

/** One line above the drop area saying what the next upload will actually run. */
function renderUploadPlan() {
  const el = $('uploadPlan');
  if (!el || !MODEL_MENU) return;
  const chosen = (MODEL_MENU.models || [])
    .filter((m) => modelMode(m) !== 'off')
    .map((m) => `${m.name}${modelMode(m) === 'shadow' ? ' (shadow)' : ''}`);
  const secs = (MODEL_MENU.models || [])
    .filter((m) => modelMode(m) !== 'off')
    .reduce((a, m) => a + (m.seconds || 0), 0);
  el.innerHTML = chosen.length
    ? `This upload will run: <b>${esc(chosen.join(' + '))}</b>`
      + (secs ? ` &mdash; about ${Math.round(secs)} s on the GPU, plus the derived views.` : '')
    : '';
}

/** The config to POST with the upload, or null when nothing was chosen.
 *
 *  NULL IS A REAL ANSWER and must survive: `jobs.options` is nullable and null means
 *  "the deployment default at the time", which is the truth about every job uploaded
 *  before this picker existed. Sending the defaults back as if they had been chosen
 *  would make those two states indistinguishable in the row. */
function uploadConfig() {
  if (!Object.keys(modelChoice).length) return null;
  const out = {};
  (((MODEL_MENU || {}).models) || []).forEach((m) => { out[m.key] = modelMode(m); });
  return out;
}

function wireModelsPanel() {
  const reset = $('modelsReset');
  if (reset) {
    reset.onclick = () => { modelChoice = {}; renderModelPicker(); renderUploadPlan(); };
  }
  loadModelMenu().then(() => { renderModelPicker(); renderUploadPlan(); });
}

/** Mount the schematic, once the panel is on screen and the bundle has loaded.
 *
 *  The viewer bundle is a 4 MB script the case view needs anyway; this reuses it rather
 *  than shipping a second WebGL stack. It is deliberately tolerant of failure: no
 *  WebGL, or a bundle that has not arrived, costs the reader a diagram and nothing
 *  else, and the picker beside it is fully usable without it. */
async function mountModelSchematic() {
  const host = $('modelPreview');
  if (!host || !window.DentistryViewer || !DentistryViewer.mountModelPreview) return false;
  if (host.dataset.mounted === '1') { DentistryViewer.resizeModelPreview(); return true; }
  // `mounting` guards the await: the router can show this page twice before the six
  // meshes land, and two concurrent mounts would leak the first one's WebGL context.
  if (host.dataset.mounted === 'pending') return false;
  host.dataset.mounted = 'pending';
  let got = null;
  try {
    got = await DentistryViewer.mountModelPreview(host);
  } catch (e) {
    console.warn('dentistry: the model preview failed to mount: ' + e.message);
  }
  if (!got) {
    host.dataset.mounted = '';
    host.innerHTML = '<p class="empty">The 3-D preview needs WebGL and a loaded asset '
      + 'bundle; one of the two did not arrive. The model list beside it is unaffected.</p>';
    return false;
  }
  host.dataset.mounted = '1';
  DentistryViewer.spinModelPreview(true);
  renderPreviewNote();
  return true;
}

/** Name the case on screen, from the bundle's own manifest.
 *
 *  The picker used to draw a parametric schematic and the caption said so. It draws a
 *  REAL segmentation now, which is a stronger claim and therefore needs a stricter
 *  caption: the title, the dataset and the licence come from the manifest the baker
 *  wrote, so the words on the pane cannot name a case other than the one rendered. */
function renderPreviewNote() {
  const note = $('modelsNote');
  if (!note || !window.DentistryViewer || !DentistryViewer.previewSource) return;
  const src = DentistryViewer.previewSource();
  if (!src) return;
  const absent = (src.absent || []).length
    ? ` This case has no ${src.absent.join(' or ')}, so that group is named in the list
        but not drawn here.`
    : '';
  note.innerHTML = `<b>${esc(src.title)}</b> &mdash; a real segmentation of a published
    example case, not your scan. ${esc(src.attribution)}. Hover a model to see which
    structures it is authoritative for.${absent}`;
}

function unmountModelSchematic() {
  const host = $('modelPreview');
  // 'pending' counts: a mount in flight has to be able to finish and find the flag
  // cleared, or leaving and returning to the page would wedge it forever.
  if (!host || !host.dataset.mounted) return;
  if (window.DentistryViewer && DentistryViewer.disposeModelPreview) {
    DentistryViewer.disposeModelPreview();
  }
  host.dataset.mounted = '';
}

/* ================================================================= the contact page
 * ONE constant, and every link on the page comes from it. The alternative -- an address
 * in the HTML and the same address in a mailto in the JS -- is how a page ends up
 * publishing two different ones. */
const CONTACT = {
  name: 'Gustavo Formento',
  // What I can state without asserting anything I have not verified. A professional
  // title on a public page is a claim about a person, not a nicety.
  role: 'The author of this service',
  email: 'gustavo.formento@rtmedical.com.br',
  linkedin: 'https://www.linkedin.com/in/gustavoogomesss/',
  github: 'https://github.com/gomesgustavoo',
};

function renderContact() {
  const who = $('contactWho');
  const links = $('contactLinks');
  if (who) who.innerHTML = `<b>${esc(CONTACT.name)}</b><br><span class="hint">${esc(CONTACT.role)}</span>`;
  if (!links) return;
  const rows = [];
  if (CONTACT.email) {
    rows.push(`<li><span>Email</span><a href="mailto:${esc(CONTACT.email)}?subject=${
      encodeURIComponent('Custom segmentation model')}">${esc(CONTACT.email)}</a></li>`);
  }
  if (CONTACT.linkedin) {
    rows.push(`<li><span>LinkedIn</span><a href="${esc(CONTACT.linkedin)}" target="_blank"
      rel="noopener">${esc(CONTACT.linkedin.replace(/^https?:\/\/(www\.)?/, ''))}</a></li>`);
  }
  if (CONTACT.github) {
    rows.push(`<li><span>Code</span><a href="${esc(CONTACT.github)}" target="_blank"
      rel="noopener">${esc(CONTACT.github.replace(/^https?:\/\/(www\.)?/, ''))}</a></li>`);
  }
  links.innerHTML = rows.join('');
}

/* ==================================================== correcting the segmentation
 * The contours here are drawn by a network and every millimetre the implant tab
 * publishes is a distance to them. So a specialist who can see that a canal roof is a
 * voxel low has to be able to move it, and the numbers have to move with it -- otherwise
 * the edit is a drawing exercise and the figures beside it describe a mask that no
 * longer exists.
 *
 * FOUR RULES, and each one exists because the alternative is a quiet wrong number.
 *
 * 1. **Editing is a MODE, off by default.** The tools take the primary mouse button,
 *    which belongs to window/level. A viewer whose left button paints is a viewer
 *    somebody edits by accident, on a case they were only reading.
 *
 * 2. **While there are unsaved edits, everything except the MPR panes is out of date,
 *    and the app says so.** The 3-D surfaces are server meshes, the cross-sections are
 *    server JPEGs and every clearance is a lookup into a server distance field: none of
 *    them can follow a browser-side edit. Approximating them here would put two
 *    pictures of the same anatomy on screen with no way to tell which one the numbers
 *    came from.
 *
 * 3. **Apply is a server round trip, and it is not instant.** The diff goes to
 *    `POST /edits`, the worker rebuilds the distance fields, the meshes, the outlines
 *    and the per-site heights, and the case is reopened when it lands. 202, then
 *    polling, then a reload -- never an optimistic repaint.
 *
 * 4. **The reload has to get past both caches.** Artifacts are addressed by job id and
 *    served `immutable`, which is only honest while a finished job's files never
 *    change. An applied edit breaks that, so the job is marked stale: Cache Storage
 *    entries are deleted and every subsequent fetch for it carries `cache: 'reload'`.
 *    This is the same trap an in-place reprocess hit once already.
 */

/** Mark a case's bytes as changed. See `staleJobs` at the top of this file.
 *
 *  Session-scoped and never cleared: once a case has been corrected, its pre-edit copy
 *  in either cache is a picture of a mask nobody is looking at any more. */
function markJobStale(jobId) {
  if (!jobId) return;
  staleJobs.add(jobId);
  // Cache Storage first, because `cache: 'reload'` only reaches the HTTP cache.
  artifactCache().then((store) => {
    if (!store || !store.keys) return;
    store.keys().then((reqs) => reqs.forEach((r) => {
      if (String(r.url).includes(jobId)) store.delete(r).catch(() => {});
    })).catch(() => {});
  }).catch(() => {});
}

function editState() {
  const v = state.viewer;
  if (!v) return null;
  if (!v.edit) v.edit = { on: false, tool: 'brush', segment: 0, brush: 2.0,
                          applying: false, notice: null, edits: [] };
  return v.edit;
}

function viewerEdits() {
  return (window.DentistryViewer && DentistryViewer.setEditTool) ? DentistryViewer : null;
}

/** The tools, in the order they are offered. Labels come from the viewer's own table so
 *  the bar cannot name a tool the bundle does not have. */
function editToolList() {
  const V = viewerEdits();
  const t = (V && V.EDIT_TOOLS) || {};
  return ['brush', 'erase', 'brush3d', 'erase3d', 'circle', 'rect', 'sphere', 'fill']
    .filter((k) => t[k])
    .map((k) => ({ key: k, ...t[k] }));
}

/** Turn the mode on or off. */
function setEditMode(on) {
  const e = editState();
  const V = viewerEdits();
  const v = state.viewer;
  if (!e || !V || !v || !v.mprMounted) return false;
  e.on = !!on;
  V.setEditTool(e.on ? e.tool : null);
  if (e.on) {
    V.setEditSegment(e.segment);
    V.setBrushMm(e.brush);
  }
  const b = $('editBtn');
  if (b) {
    b.setAttribute('aria-pressed', e.on ? 'true' : 'false');
    b.classList.toggle('on', e.on);
  }
  $('editBar').hidden = !e.on;
  document.body.classList.toggle('editing', e.on);
  renderEditBar();
  return true;
}

/** Rebuild the bar, and every counter in it, from the labelmap itself.
 *
 *  Counters are READ BACK rather than accumulated. A running total kept in the client
 *  drifts the moment an undo, a redo or a discard happens, and a "1 240 voxels changed"
 *  that is not true of the array is worse than no number. `editStats()` scans only the
 *  planes the tools actually wrote to. */
function renderEditBar() {
  const e = editState();
  const V = viewerEdits();
  if (!e || !V) return;
  const bar = $('editBar');
  if (!bar || bar.hidden) return;

  // The structure picker: only what this case actually contains, plus background.
  //
  // Keyed on the JOB, not on a boolean. `#editBar` is static markup that outlives a
  // case, so a `built` flag would carry the previous case's structure list into the
  // next one -- and an index that is not present in the new case paints a structure
  // whose colour the LUT never registered, which renders as nothing at all.
  const sel = $('editSegment');
  const v = state.viewer;
  if (sel && sel.dataset.built !== String(v && v.jobId)) {
    const present = presentIndices();
    const opts = ['<option value="0">background (erase)</option>'].concat(
      (allStructures() || [])
        .filter((s) => present.has(s.index))
        .map((s) => `<option value="${s.index}">${esc(s.name)}</option>`));
    sel.innerHTML = opts.join('');
    sel.dataset.built = String(v && v.jobId);
    // Default to the inferior alveolar canal when the case has one: it is the structure
    // every clearance in this product is measured to, so it is the one a specialist
    // opens these tools for.
    //
    // And PUSH it to the viewer, not just into local state. `setEditMode` sets the
    // active segment from `e.segment` before this runs, so without this line the first
    // stroke of every session paints segment 0 -- which is background, i.e. it erases.
    const canal = (allStructures() || []).find((s) => s.id === 'canal');
    if (canal && present.has(canal.index)) {
      e.segment = canal.index;
      V.setEditSegment(e.segment);
    }
  }
  if (sel) sel.value = String(e.segment);
  // The colour of the thing you are about to paint, beside the picker. Without it the
  // only cue is a name in a dropdown, while every other surface in this app identifies a
  // structure by its swatch.
  const swatch = $('editSwatch');
  if (swatch) {
    const st = (allStructures() || []).find((x) => x.index === e.segment);
    swatch.style.background = st ? st.color : 'transparent';
    swatch.style.borderColor = st ? st.color : 'var(--border-2)';
    swatch.title = st ? st.name : 'background (erase)';
  }

  const tools = $('editTools');
  if (tools) {
    // GROUPED BY WHAT THE TOOL DOES, not listed in declaration order. Eight equal text
    // buttons in a grid made the reader work out from the words which ones add and which
    // ones remove -- and "erase" and "erase 3-D" sat between "brush 3-D" and "circle",
    // so the two destructive tools were the least conspicuous things in the panel.
    // Adding and removing are the only distinction that matters before a stroke.
    const glyph = {
      brush: '\u270E', brush3d: '\u25C9', circle: '\u25EF', rect: '\u25A2',
      sphere: '\u2B24', fill: '\u25E9', erase: '\u232B', erase3d: '\u25CE',
    };
    const short = {
      brush: 'Brush', brush3d: 'Brush 3-D', circle: 'Circle', rect: 'Rectangle',
      sphere: 'Sphere', fill: 'Fill', erase: 'Erase', erase3d: 'Erase 3-D',
    };
    const all = editToolList();
    const btn = (t) => `
      <button class="etool ${e.tool === t.key ? 'on' : ''}" data-tool="${t.key}"
        type="button" title="${esc(t.hint)}">
        <span class="etool-i" aria-hidden="true">${glyph[t.key] || '\u25A0'}</span>
        <span class="etool-l">${esc(short[t.key] || t.label)}</span>
      </button>`;
    const group = (name, keys, cls) => {
      const rows = all.filter((t) => keys.includes(t.key));
      return rows.length ? `<div class="etool-group ${cls}">
        <h4>${name}</h4><div class="etool-grid">${rows.map(btn).join('')}</div></div>` : '';
    };
    tools.innerHTML = group('Add', ['brush', 'brush3d', 'circle', 'rect', 'sphere', 'fill'], 'is-add')
      + group('Remove', ['erase', 'erase3d'], 'is-remove');
  }
  const size = $('editSize');
  if (size) size.value = String(e.brush);
  const sizeLabel = $('editSizeLabel');
  if (sizeLabel) sizeLabel.textContent = `${Number(e.brush).toFixed(1)} mm`;
  // The brush has no radius for the scissors or the flood fill, so the control says so
  // rather than sitting there doing nothing.
  const brushy = /^(brush|erase)/.test(e.tool);
  if (size) size.disabled = !brushy;
  if (sizeLabel) sizeLabel.style.opacity = brushy ? '1' : '.45';

  const h = V.editHistory ? V.editHistory() : { canUndo: false, canRedo: false };
  if ($('editUndo')) $('editUndo').disabled = !h.canUndo;
  if ($('editRedo')) $('editRedo').disabled = !h.canRedo;

  const st = V.editStats ? V.editStats() : null;
  const n = st ? st.voxels : 0;
  const names = st ? Object.keys(st.structures || {}) : [];
  const count = $('editCount');
  if (count) {
    count.textContent = e.applying ? 'applying…'
      : n ? `${n.toLocaleString()} voxels on ${st.slices} slice${st.slices === 1 ? '' : 's'}`
            + (names.length ? ` · ${names.map((i) => structureName(
              ((allStructures() || []).find((s) => s.index === Number(i)) || {}).id
              || i)).join(', ')}` : '')
      : 'nothing changed yet';
  }
  if ($('editDiscard')) $('editDiscard').disabled = !n || e.applying;
  if ($('editApply')) $('editApply').disabled = !n || e.applying;

  const note = $('editNote');
  if (note) {
    // The standing statement, and it is the most important text in this bar.
    note.innerHTML = e.notice ? esc(e.notice)
      : n ? 'These strokes change the MPR panes only. The 3-D surfaces, the '
            + 'cross-sections and every clearance still describe the segmentation '
            + '<b>before</b> your corrections — they are rebuilt on the server when '
            + 'you apply. Corrections are made on the '
            + `${editGridMm()} display grid and upsampled to the measurement grid, so an `
            + 'edited boundary carries that much extra uncertainty.'
      : 'Paint or erase on the MPR panes. Nothing is sent until you apply.';
    note.className = 'editnote' + (e.notice ? ' bad' : '');
  }
  // The budget of whatever the picker is pointing at, refreshed with the bar so it
  // tracks the structure rather than lagging one selection behind.
  renderEditBudget();
}

/** The display grid's voxel size, in words. The number the error budget will widen by
 *  is half of it, and the server states that; this states where it comes from. */
function editGridMm() {
  const m = (state.viewer && state.viewer.volumeMeta) || null;
  const sp = m && m.spacing ? Math.min(...m.spacing.map(Number)) : null;
  return sp ? `${sp.toFixed(2)} mm` : 'coarser';
}

/** The display grid's voxel size as a NUMBER, or null when the pack has not landed. */
function editGridSpacing() {
  const m = (state.viewer && state.viewer.volumeMeta) || null;
  const sp = m && m.spacing ? Math.min(...m.spacing.map(Number)) : null;
  return Number.isFinite(sp) && sp > 0 ? sp : null;
}

/** Which measured prior a structure's boundary feeds, mirroring `plan_safety`'s three
 *  fields. Returns null for a structure no implant clearance is measured against --
 *  and saying "no measured prior" is the honest answer there, not borrowing one. */
function budgetFieldFor(id) {
  if (id === 'canal') return 'canal';
  if (id === 'incisive_canal_left' || id === 'incisive_canal_right'
      || id === 'lingual_canal') return 'accessory_canal';
  if (/^tooth_\d+$/.test(id)) return 'tooth';
  return null;
}

/** THE ERROR BUDGET OF THE STRUCTURE THE BRUSH IS ABOUT TO WRITE INTO.
 *
 *  This app's whole claim is that it says how wrong it might be, and the one place that
 *  claim was missing was the moment it matters most: a person about to redraw a boundary
 *  by hand. The arithmetic existed -- `plan_safety.edit_penalty` computes it and the
 *  applied result prints it -- but only AFTER the correction was made and recomputed.
 *  A correction is a decision; the number belongs in front of the person making it.
 *
 *  It is deliberately NOT a warning. A hand-drawn contour is often better than the
 *  model's. It is simply not automatically better, and the budget widens either way,
 *  because the mask a browser can edit is the downsampled display copy and half a
 *  display voxel of quantisation is real whichever direction the hand moved the wall. */
function renderEditBudget() {
  const box = $('editBudget');
  if (!box) return;
  const e = editState();
  const v = state.viewer;
  if (!e || !v) { box.innerHTML = ''; return; }
  const st = (allStructures() || []).find((x) => x.index === e.segment);
  if (!st || !e.segment) {                       // background, or nothing selected
    box.innerHTML = '';
    return;
  }
  const sp = editGridSpacing();
  if (!sp) { box.innerHTML = ''; return; }
  const add = sp / 2;
  const field = budgetFieldFor(st.id);
  if (!field) {
    // No implant clearance is measured against this structure, so there is no budget to
    // widen -- and inventing one would be worse than saying so.
    box.innerHTML = `Correcting <b>${esc(st.name)}</b> quantises its boundary at half a
      ${esc(editGridMm())} display voxel &mdash; <b>${add.toFixed(2)} mm</b>. No implant
      clearance is measured against this structure.`;
    return;
  }
  const prior = MODEL_PRIORS && MODEL_PRIORS.structures
    ? MODEL_PRIORS.structures[field] : null;
  if (!prior) {
    // The priors have not landed (or the endpoint failed). Say the half that IS known
    // rather than the whole of it wrongly -- printing "no clearance is measured against
    // this" for the mandibular canal would be a false statement about the one structure
    // the implant verdicts depend on most.
    box.innerHTML = `Correcting <b>${esc(st.name)}</b> quantises its boundary at half a
      ${esc(editGridMm())} display voxel &mdash; <b>${add.toFixed(2)} mm</b>, on top of
      the model's own error for this structure.`;
    // Fetch them, then say the whole thing. `renderModelPriors` owns the cache.
    renderModelPriors().then(() => {
      const e2 = editState();
      if (e2 && e2.on && e2.segment === st.index) renderEditBudget();
    }).catch(() => {});
    return;
  }
  box.innerHTML = `Correcting <b>${esc(st.name)}</b> widens its error budget:
    <b>${prior.p95_mm.toFixed(2)} mm</b> model
    + <b>${add.toFixed(2)} mm</b> grid
    = <b>${(prior.p95_mm + add).toFixed(2)} mm</b> deducted from every clearance
    measured against it.`;
}

/** The dock: the structure filter, and the tools' own close button. */
function wireDock() {
  const f = $('structFilter');
  if (f) {
    f.oninput = () => {
      if (!state.viewer) return;
      state.viewer.structQuery = f.value;
      renderStructures(state.viewer.report);
    };
    // Esc clears rather than blurring, because a filter left on is a list that looks
    // like a case with fewer structures than it has.
    f.onkeydown = (ev) => {
      if (ev.key !== 'Escape') return;
      ev.stopPropagation();                 // do NOT let this close the case
      f.value = '';
      if (!state.viewer) return;
      state.viewer.structQuery = '';
      renderStructures(state.viewer.report);
    };
  }
  const close = $('editClose');
  if (close) close.onclick = () => setEditMode(false);
}

function wireEditing() {
  const btn = $('editBtn');
  if (btn) {
    btn.onclick = () => {
      const e = editState();
      if (!e) return;
      if (!state.viewer.mprMounted) {
        setNotice('The volume is still loading.', 'err');
        return;
      }
      setEditMode(!e.on);
    };
  }
  const sel = $('editSegment');
  if (sel) {
    sel.onchange = () => {
      const e = editState();
      const V = viewerEdits();
      if (!e || !V) return;
      e.segment = Number(sel.value) || 0;
      V.setEditSegment(e.segment);
      renderEditBar();
    };
  }
  const tools = $('editTools');
  if (tools) {
    tools.onclick = (ev) => {
      const b = ev.target.closest('button[data-tool]');
      const e = editState();
      const V = viewerEdits();
      if (!b || !e || !V) return;
      e.tool = b.dataset.tool;
      V.setEditTool(e.tool);
      renderEditBar();
    };
  }
  const size = $('editSize');
  if (size) {
    size.oninput = () => {
      const e = editState();
      const V = viewerEdits();
      if (!e || !V) return;
      e.brush = Number(size.value);
      V.setBrushMm(e.brush);
      renderEditBar();
    };
  }
  if ($('editUndo')) $('editUndo').onclick = () => { const V = viewerEdits(); if (V) { V.editUndo(); renderEditBar(); } };
  if ($('editRedo')) $('editRedo').onclick = () => { const V = viewerEdits(); if (V) { V.editRedo(); renderEditBar(); } };
  if ($('editDiscard')) {
    $('editDiscard').onclick = () => {
      const V = viewerEdits();
      if (!V) return;
      const st = V.editStats();
      if (!st || !st.voxels) return;
      if (!window.confirm(`Discard ${st.voxels.toLocaleString()} changed voxels and go `
                          + 'back to what the model drew?')) return;
      V.resetEdits();
      renderEditBar();
    };
  }
  if ($('editApply')) $('editApply').onclick = () => applyEdits();

  // The tools write on mouse-up, so the counters are refreshed then. Bound on the
  // stage rather than per pane: the elements are Cornerstone's and are replaced on
  // every mount, while the stage is not.
  const stage = $('mprStage');
  if (stage) {
    stage.addEventListener('pointerup', () => {
      const e = editState();
      if (e && e.on) setTimeout(renderEditBar, 0);
    });
  }
}

/** Send the diff, then wait for the worker, then reopen the case. */
async function applyEdits() {
  const e = editState();
  const V = viewerEdits();
  const v = state.viewer;
  if (!e || !V || !v) return;
  const diff = V.editDiff();
  if (!diff || !diff.voxels) return;
  e.applying = true;
  e.notice = null;
  renderEditBar();
  let row;
  try {
    row = await api(`/jobs/${v.jobId}/edits`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        grid: diff.grid,
        slices: diff.slices,
        voxels: diff.voxels,
        structures: diff.structures,
        note: null,
      }),
    });
  } catch (err) {
    e.applying = false;
    e.notice = 'The correction was not accepted: ' + err.message;
    renderEditBar();
    return;
  }
  e.notice = 'Rebuilding the distance fields, the surfaces and the outlines…';
  renderEditBar();
  const done = await pollEdit(v.jobId, row.id);
  e.applying = false;
  if (!done || done.state !== 'applied') {
    e.notice = (done && done.error)
      ? 'The correction could not be applied: ' + done.error
      : 'The correction is still being applied; the case will not show it until it is.';
    renderEditBar();
    return;
  }
  // The server has the new mask, so this baseline is what the next diff is measured
  // against. Set BEFORE the reopen, because the reopen tears the editing layer down.
  if (V.commitBaseline) V.commitBaseline();
  markJobStale(v.jobId);
  e.notice = null;
  const jobId = v.jobId;
  setEditMode(false);
  setNotice('Correction applied. Every measurement was recomputed from it.', 'ok');
  // A full reopen rather than a partial refresh. `addSurface` is memoised with no
  // update path, the labelmap volume is in the Cornerstone cache, and `arch.json` is
  // held under an `immutable` header -- so a reopen is the only reload that is
  // guaranteed to be showing one consistent generation of the case.
  //
  // `force`, because the case is ALREADY open and `openCase` returns early for that --
  // which is what made this whole path a no-op with a success notice on top of it.
  await openCase(jobId, { force: true });
}

/** Poll one edit until it stops being queued. Bounded, and it says so when it gives up. */
/** MEASURED: 141 s on a 205x205x135 case with both jaws, 84 meshes and a 19 MB
 *  structure set; 19 s on a small-field-of-view one. 600 s is four times the worst
 *  measured run, and the worker requeues anything stuck for 900 s -- so a client that
 *  gives up here has not lost the correction, it has only stopped watching, and it
 *  says exactly that. */
async function pollEdit(jobId, editId, timeoutMs = 600000) {
  const t0 = Date.now();
  let wait = 900;
  while (Date.now() - t0 < timeoutMs) {
    await new Promise((r) => setTimeout(r, wait));
    wait = Math.min(4000, wait * 1.35);
    let list;
    try {
      list = await api(`/jobs/${jobId}/edits`);
    } catch (err) {
      return { state: 'unknown', error: err.message };
    }
    const row = (list.edits || []).find((x) => x.id === editId);
    if (!row) return { state: 'unknown', error: 'the correction is no longer listed' };
    if (row.state === 'applied' || row.state === 'failed') return row;
  }
  return null;
}

/** What has already been corrected on this case, for the rail and the printed sheet.
 *
 *  Read from `report.edits`, which `worker/rederive.py` appends to -- so it survives a
 *  reload, a new session and a different browser, and the sentence about the display
 *  grid travels with it. */
function renderEditHistory(r) {
  const box = $('editsCard');
  if (!box) return;
  const hist = (r && r.edits) || [];
  box.hidden = !hist.length;
  if (!hist.length) { box.innerHTML = ''; return; }
  box.innerHTML = `<div class="card-head"><h3>Hand corrections</h3>
      <span class="hint">${hist.length}</span></div>`
    + hist.slice().reverse().map((h) => {
      const names = Object.keys(h.structures || {}).map((i) => structureName(
        ((allStructures() || []).find((s) => s.index === Number(i)) || {}).id || i));
      return `<div class="editrow">
        <div class="editrow-head">
          <b>${esc(fmtWhen(h.at))}</b>
          <span class="hint">${Number(h.voxels || 0).toLocaleString()} voxels</span>
        </div>
        ${names.length ? `<p class="hint">${esc(names.join(', '))}</p>` : ''}
        <details class="sidenote"><summary>What this means for the numbers</summary>
          <p class="finding-why">${esc(h.basis || '')}</p>
          <p class="finding-why">${esc(h.frozen || '')}</p>
        </details>
      </div>`;
    }).join('');
}

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
  $('settingsWho').textContent = me
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

/* ----------------------------------------------------------------- upload */
function setNotice(msg, kind) {
  const el = $('uploadNotice');
  if (!msg) { el.hidden = true; return; }
  el.hidden = false;
  el.className = 'notice ' + (kind || '');
  el.textContent = msg;
}

async function upload(file) {
  if (!file) return;
  if (!/\.(nii|nii\.gz|zip)$/i.test(file.name)) {
    setNotice(`"${file.name}" is not a NIfTI or a .zip of DICOM slices.`, 'err');
    return;
  }
  if (file.size > EDGE_BODY_LIMIT) {
    setNotice(
      `${file.name} is ${fmtBytes(file.size)}. Uploads through this hostname are capped at ` +
      `100 MB by the CDN, so this one cannot get through yet — chunked upload is a ` +
      `pending item. Try a cropped or downsampled volume.`, 'err');
    return;
  }

  const bar = $('upbar'), fill = $('upbarFill');
  bar.hidden = false; fill.style.width = '0%';
  setNotice(`Uploading ${file.name} (${fmtBytes(file.size)})…`);

  // XHR rather than fetch: a CBCT is hundreds of megabytes and upload progress is
  // the difference between "working" and "frozen" on a slow link.
  const body = new FormData();
  body.append('file', file, file.name);
  // The reader's model choice, alongside the volume in the same multipart request.
  // Omitted entirely when nothing was chosen: `jobs.options` is nullable and null means
  // "the deployment default at the time", which is the honest record for every job
  // uploaded before the picker existed. The API validates this against the worker's
  // model inventory BEFORE writing a byte, so a request naming a model this deployment
  // does not have comes back as a 400 with the reason rather than as a job that runs
  // something else.
  const cfg = uploadConfig();
  if (cfg) body.append('config', JSON.stringify(cfg));
  const xhr = new XMLHttpRequest();
  xhr.open('POST', API + '/jobs');
  // XHR does not go through api(), so the token has to be set by hand here.
  if (AUTH) {
    const tok = await AUTH.token();
    if (tok) xhr.setRequestHeader('Authorization', 'Bearer ' + tok);
  }
  xhr.upload.onprogress = (e) => {
    if (e.lengthComputable) fill.style.width = (e.loaded / e.total * 100).toFixed(1) + '%';
  };
  xhr.onload = () => {
    bar.hidden = true;
    if (xhr.status === 201) {
      setNotice('Queued. It will appear below.', 'ok');
      refreshJobs();
      refreshAccount();
    } else if (xhr.status === 402) {
      // Not "upload failed" -- nothing is wrong with the file. Say what ran out.
      let d = {};
      try { d = (JSON.parse(xhr.responseText).detail) || {}; } catch (_) {}
      setNotice(quotaMessage(d), 'err');
      refreshAccount();
    } else {
      let d = xhr.statusText;
      try { d = JSON.parse(xhr.responseText).detail || d; } catch (_) {}
      setNotice('Upload failed: ' + d, 'err');
    }
  };
  xhr.onerror = () => { bar.hidden = true; setNotice('Upload failed: network error.', 'err'); };
  xhr.send(body);
}

function wireDropzone() {
  const drop = $('drop'), input = $('fileInput');
  drop.addEventListener('click', () => input.click());
  drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
  input.addEventListener('change', () => { upload(input.files[0]); input.value = ''; });
  ['dragenter', 'dragover'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', (e) => upload(e.dataTransfer.files[0]));
}

/* ------------------------------------------------------------------- jobs */
// One card per case. The state is a coloured dot and a badge rather than a word in
// the middle of a sentence, so a list of twenty is scannable without reading any
// of it. Everything else is a fact about the run.

const JOB_FILTERS = {
  all: () => true,
  active: (j) => j.state === 'running' || j.state === 'queued',
  done: (j) => j.state === 'done',
  failed: (j) => j.state === 'failed' || j.state === 'cancelled',
};

/** Hours until the results are deleted, or null when that does not apply. */
function expiresIn(j) {
  if (j.state !== 'done' || j.results_expired || j.is_example || !j.finished_at) return null;
  const done = new Date(j.finished_at);
  if (isNaN(done)) return null;
  const hours = state.ttlHours - (Date.now() - done.getTime()) / 3600000;
  return hours > 0 ? hours : 0;
}

function jobRow(j) {
  const pct = Math.round((j.progress || 0) * 100);
  const active = j.state === 'running' || j.state === 'queued';
  const openable = j.state === 'done' && !j.results_expired;

  const bits = [];
  if (j.created_at) bits.push(esc(fmtAgo(j.created_at)));
  // Only in a SHARED workspace, and only when we can name the person. "by
  // 8f2c1e40" is worse than saying nothing, and in a workspace of one the answer
  // is always "you".
  if (state.members && j.submitted_by) {
    const who = state.members.get(j.submitted_by);
    if (who) bits.push('by ' + esc(who));
  }
  bits.push(esc(j.input_kind), esc(fmtBytes(j.bytes_in)));
  if (j.state === 'done') bits.push(`GPU ${esc(fmtSecs(j.gpu_seconds))}`);
  if (j.wait_seconds > 1) bits.push(`waited ${esc(fmtSecs(j.wait_seconds))}`);
  const left = expiresIn(j);
  if (left != null) {
    const txt = left < 1 ? 'expires within the hour'
      : left < 24 ? `expires in ${Math.round(left)} h`
      : `expires in ${Math.round(left / 24)} d`;
    bits.push(`<span class="${left < 12 ? 'warn' : ''}">${txt}</span>`);
  }
  if (j.results_expired) bits.push('<span class="warn">results expired and were deleted</span>');
  if (j.error) bits.push(`<span class="err">${esc(j.error)}</span>`);

  const actions = [];
  if (openable) actions.push(`<button class="btn btn--sm btn--primary" data-open="${esc(j.id)}" type="button">Open</button>`);
  if (active) actions.push(`<button class="btn btn--sm" data-cancel="${esc(j.id)}" type="button">Cancel</button>`);
  if (!active) actions.push(`<button class="iconbtn" data-delete="${esc(j.id)}" type="button" title="Delete this case" aria-label="Delete">\u00d7</button>`);

  return `<div class="job${openable ? ' is-open' : ''}"${openable ? ` data-card="${esc(j.id)}"` : ''}>
    <span class="job-dot ${esc(j.state)}" aria-hidden="true"></span>
    <div class="job-name" title="${esc(j.filename)}">${esc(j.title || j.filename)}</div>
    <div class="job-actions">
      <span class="badge ${esc(j.state)}">${esc(j.state)}</span>${actions.join('')}
    </div>
    <div class="job-meta">${bits.join('<span class="sep">\u00b7</span>')}</div>
    ${active ? `<div class="job-bar"><i style="width:${pct}%"></i></div>
       <div class="job-meta">${esc(j.stage)} \u2014 ${pct}%</div>` : ''}
  </div>`;
}

function renderJobs() {
  const el = $('jobs');
  const keep = JOB_FILTERS[state.jobFilter] || JOB_FILTERS.all;
  const shown = state.jobs.filter(keep);
  if (!shown.length) {
    el.innerHTML = `<p class="empty">${state.jobs.length
      ? 'No cases match this filter.' : 'No cases yet \u2014 drop a CBCT above to start.'}</p>`;
    return;
  }
  el.innerHTML = shown.map(jobRow).join('');

  // Clicking the card opens it, but not when the click was on a button inside it.
  el.querySelectorAll('[data-card]').forEach((card) => {
    card.onclick = (e) => {
      if (e.target.closest('button')) return;
      navigate('#/case/' + card.dataset.card);
    };
  });
  el.querySelectorAll('[data-open]').forEach((b) => b.onclick = () => navigate('#/case/' + b.dataset.open));
  el.querySelectorAll('[data-cancel]').forEach((b) => b.onclick = async () => {
    b.disabled = true;
    try { await api(`/jobs/${b.dataset.cancel}/cancel`, { method: 'POST' }); } catch (_) {}
    refreshJobs();
  });
  el.querySelectorAll('[data-delete]').forEach((b) => b.onclick = async () => {
    b.disabled = true;
    try { await api(`/jobs/${b.dataset.delete}`, { method: 'DELETE' }); } catch (_) {}
    if (state.viewer && state.viewer.jobId === b.dataset.delete) navigate('#/cases');
    refreshJobs();
  });
}

async function refreshJobs() {
  try {
    const data = await api('/jobs?limit=50');
    state.jobs = data.jobs;
    renderJobs();
  } catch (e) { /* transient; the next tick retries */ }
}

function wireJobFilter() {
  document.querySelectorAll('#jobFilter .segb').forEach((b) => {
    b.onclick = () => {
      state.jobFilter = b.dataset.filter;
      document.querySelectorAll('#jobFilter .segb')
        .forEach((o) => o.classList.toggle('on', o === b));
      renderJobs();
    };
  });
  $('refreshJobs').onclick = refreshJobs;
}

async function loadExamples() {
  try {
    const { examples } = await api('/examples');
    if (!examples.length) return;
    const el = $('examples');
    el.innerHTML = examples.map((j) => {
      const q = (j.reports && j.reports.quality) || {};
      const bits = [
        `${q.teeth_found ?? 0}/32 teeth`,
        `${fmtSecs(j.gpu_seconds)} GPU`,
      ].filter(Boolean);
      return `<button class="ex" data-open="${esc(j.id)}" type="button">
        <span class="ex-title">${esc(j.title || j.filename)}</span>
        <span class="ex-stats">${esc(bits.join(' \u00b7 '))}</span>
        ${j.attribution ? `<span class="ex-attr">${esc(j.attribution)}</span>` : ''}
      </button>`;
    }).join('');
    el.querySelectorAll('[data-open]').forEach((b) => b.onclick = () => navigate('#/case/' + b.dataset.open));
    $('examplesPanel').hidden = false;
  } catch (_) { /* examples are a nicety; never block the app on them */ }
}

async function refreshSystem() {
  try {
    const s = await api('/system');
    const busy = s.running > 0, queued = s.queued;
    // The retention window is a deployment setting; the card list renders
    // "expires in N h" from it and must not carry its own copy of the number.
    if (s.resultTtlHours) state.ttlHours = s.resultTtlHours;
    $('sysdot').className = 'dot ' + (busy ? 'busy' : 'ok');
    $('systext').textContent = busy ? `1 running · ${queued} queued` : (queued ? `${queued} queued` : 'idle');
    $('sysstrip').title = (busy || queued)
      ? 'One GPU, shared: this is the whole queue, not only your cases'
      : 'The worker is idle';
  } catch (e) {
    $('sysdot').className = 'dot bad';
    $('systext').textContent = 'api unreachable';
  }
}

/* ------------------------------------------------------------- the viewer */
// `route()` owns what is on screen. This only navigates, so a deep link, a click on a
// card and the browser back button all take the same path.
//
// `openViewer` used to sit here, with a docstring saying it was "kept under this name
// because the rest of the app calls it". Nothing called it -- card clicks navigate
// directly -- and it passed the wiring check only because its own two comments counted
// as references.

/** Leave the open case. */
function closeViewer() { navigate('#/cases'); }

/** Release a mounted case. Called by the router before showing any other view. */
function teardownCase() {
  $('railToggle').hidden = true;
  document.body.classList.remove('in-case');
  closeDisplayPop();
  // Editing has to come off with the case. It binds the primary mouse button to a
  // brush, and the bar and the crosshair cursor are static markup that outlives the
  // viewer -- so a case closed mid-edit would leave the next one armed.
  { const e = editState(); if (e && e.on) setEditMode(false); }
  document.body.classList.remove('editing');
  { const bar = $('editBar'); if (bar) bar.hidden = true; }
  // Put the 3-D pane back in the MPR grid BEFORE unmounting. `move3dPane` may have
  // parked it in the plan stage, and leaving it there would hand the next case a pane
  // nested in a hidden container -- and `setMode('volume')` short-circuits when the
  // pane is already in the host it names, so it would never come back.
  move3dPane('mpr');
  if (window.DentistryViewer) DentistryViewer.unmount().catch(() => {});
  // Every planning picture and every slice tile is a blob URL now, and an un-revoked
  // one pins its bytes until the document goes away. The tile cache alone holds 400.
  const v = state.viewer;
  if (v) {
    if (v.plan) { revokeImage(v.plan.panImage); revokeImage(v.plan.xsImage); }
  }
  state.viewer = null;
}

/** Load a case into the workspace. The router has already shown the view. */
async function openCase(jobId, opts) {
  // `force` REOPENS a case that is already open, and the distinction is load-bearing.
  //
  // The guard below exists so the router does not remount a mounted case on every hash
  // change -- right for navigation, and wrong for the one caller that means "this
  // case's bytes have changed": after a hand correction is applied, `openCase` was a
  // no-op, so the app printed "Correction applied. Every measurement was recomputed
  // from it" over the pre-edit report, the pre-edit surfaces and the pre-edit numbers.
  // Found by applying a second correction live and watching `report.edits` stay at 1
  // while the API returned 2.
  const force = !!(opts && opts.force);
  if (!force && state.viewer && state.viewer.jobId === jobId) return;
  if (state.viewer) teardownCase();

  $('caseTitle').textContent = 'Loading\u2026';
  $('caseSub').textContent = '';

  let job;
  try {
    job = await api(`/jobs/${jobId}`);
  } catch (err) {
    setNotice('That case could not be opened: ' + err.message, 'err');
    navigate('#/cases');
    return;
  }
  if (job.state !== 'done') {
    setNotice('That case has not finished yet.', 'err');
    navigate('#/cases');
    return;
  }
  if (job.results_expired) {
    setNotice('That case\u2019s results expired and were deleted. Re-upload the scan to segment it again.', 'err');
    navigate('#/cases');
    return;
  }

  const r = job.reports || {};
  state.viewer = {
    jobId, job, report: r,
    hidden: new Set(), isolated: null, centroids: null, structQuery: '',
    mode: 'volume', mprMounted: false, volumeMeta: null,
  };
  if (window.DentistryViewer) await DentistryViewer.unmount().catch(() => {});

  $('caseTitle').textContent = job.title || job.filename;
  $('caseSub').textContent = caseSubtitle(state.viewer);
  $('railToggle').hidden = false;
  $('dockToggle').hidden = false;
  // A filter is per-case; carrying one across cases would open the next scan already
  // hiding structures, with the reason two navigations back.
  { const f = $('structFilter'); if (f) f.value = ''; }
  // Locks the page to the window so the panes fill it instead of running off the
  // bottom. Only with a case open -- the catalogue has to keep scrolling.
  document.body.classList.add('in-case');

  renderFindings(r);
  renderEditHistory(r);
  renderAccuracy(r);
  renderModelPriors();
  renderSeries(state.viewer);
  renderRunDetails(r);
  renderStructures(r);
  renderArch(r);
  renderDownloads(jobId, r);
  // The plan tab exists only for a job that carries planning views. Every archived
  // job predates them, and a tab that opens onto nothing is worse than no tab.
  const planning = r.planning || {};
  const planOk = Object.values(planning.jaws || {}).some((j) => j && j.ok);
  $('planTab').hidden = !planOk;
  if (state.viewer) state.viewer.plan = null;
  setLayout(layout.kind, layout.pane);
  set3dMode('surfaces', true);
  setMode('volume');
  await mountVolume();
}

/* --------------------------------------------------------------- MPR + 3D */
const VIEW_NOTES = {
  volume: '<b>True MPR on the raw voxels</b> \u2014 the label map exactly as the models '
        + 'predicted it.<br>Left-drag window/level \u00b7 wheel scroll \u00b7 right-drag '
        + 'zoom \u00b7 middle-drag pan \u00b7 left-drag rotates in 3D.<br>'
        + 'Double-click a pane to enlarge it. <kbd>1</kbd>\u2013<kbd>4</kbd> focus a pane '
        + '\u00b7 <kbd>0</kbd> grid \u00b7 <kbd>f</kbd> solo \u00b7 <kbd>[</kbd> panel '
        + '\u00b7 <kbd>d</kbd> this menu \u00b7 <kbd>Esc</kbd> close the case.',
  plan: '<b>Reconstructed along the dental arch</b> \u2014 a panoramic through a 12 mm '
      + 'focal trough, and the cross-section perpendicular to the arch at one position. '
      + 'Both are rendered from the full-resolution scan on the server, so the '
      + 'millimetres printed under the cross-section are the scan\u2019s own \u2014 '
      + 'unlike the 3D panes, which show a downsampled copy for display.<br>'
      + 'Click the panoramic to jump \u00b7 drag the slider to scrub \u00b7 '
      + '<kbd>[</kbd> panel \u00b7 <kbd>Esc</kbd> close the case.<br>'
      + '<b>Research preview \u2014 not a medical device, and not for diagnostic or '
      + 'treatment use.</b>',
};

function setMode(mode) {
  const volume = mode === 'volume';
  const plan = mode === 'plan';
  document.querySelectorAll('.mode').forEach((b) => b.classList.toggle('on', b.dataset.mode === mode));
  $('mprStage').hidden = !volume;
  $('planStage').hidden = !plan;
  // What used to be a paragraph of prose permanently under the image. Same text,
  // in the popover you open when you want it -- the viewport gets the space back.
  $('popHelp').innerHTML = VIEW_NOTES[mode] || '';
  // Controls that only mean something for the Cornerstone panes. Left visible in the
  // tile view they are three dead switches next to two live ones.
  // ...and the editing toggle, which only means anything where the labelmap is: the
  // brush writes on the Cornerstone slice views, and there is nothing for it to do in
  // the tile view or the implant tab.
  ['layoutPicker', 'modePicker3d', 'mprReset', 'editBtn']
    .forEach((id) => { const el = $(id); if (el) el.hidden = !volume; });
  // ...and the dock's own toggle, because in the plan tab there is no dock to toggle.
  { const el = $('dockToggle'); if (el) el.hidden = !volume; }
  // CORRECTING THE MASK IS AN MPR-ONLY MODE, and leaving it armed anywhere else is a
  // bug rather than an untidiness. The brush binds Cornerstone's PRIMARY MOUSE BUTTON on
  // the MPR tool group; the plan tab draws on its own canvases, so a tool left active
  // there is invisible, un-undoable from that tab, and still holding the button the
  // moment the reader goes back. It also offered a panel that cannot do anything: there
  // is no labelmap on a server-rendered cross-section to paint into.
  //
  // Enforced HERE, in the one function that changes mode, rather than in the tab's click
  // handler -- `setMode` is also called by `openCase` and by the router, and only two of
  // those three paths went through that handler.
  if (!volume) {
    const ed = editState();
    if (ed && ed.on) setEditMode(false);
    const bar = $('editBar');
    if (bar) bar.hidden = true;
    document.body.classList.remove('editing');
  }
  // The mode has to be recorded BEFORE the early return: renderArch branches on
  // `v.mode === 'plan'` to turn the FDI chart into an implant-site picker, and for
  // as long as this line sat below the return, that mode was never once set.
  if (state.viewer) state.viewer.mode = mode;
  // In the implant tab the rail keeps the dental chart (which IS the placement control)
  // and the Structures card (the only control over what the 3-D pane draws), and drops
  // the rest. Measured before this: 4910 characters of segmentation prose, 82% of it
  // scrolled out of reach, none of it about planning. A class rather than per-element
  // `hidden`, so the print stylesheet can put every card back on paper with one rule.
  $('workspace').classList.toggle('mode-plan', plan);
  // The 3-D pane follows the mode instead of being duplicated. See `move3dPane`.
  move3dPane(plan ? 'plan' : 'mpr');
  // ...and in the plan tab it draws the local neighbourhood only. Measured: all 42
  // surfaces and 1.95 M triangles were drawn, so a molar implant sat behind two tooth
  // roots and the mandible and could not be seen at all. `setSurfaceFocus` NARROWS --
  // it never writes the user's own hidden set, so leaving this tab cannot have changed
  // what the Slices tab shows.
  refreshPlanFocus();
  // `renderArch` branches on the mode to decide what a chart click does and what the
  // tooltip says, and it was never re-run on a mode change -- so the chart kept the
  // wiring and the hint from whichever tab happened to be open when the case loaded.
  if (state.viewer) renderArch(state.viewer.report);
  if (plan) {
    // The dock has just left the grid, so the stage is wider than it was. Cornerstone
    // sizes its canvases at enable time and never again, and the plan tab's own
    // canvases are drawn to a measured box -- without this the 3-D pane keeps the
    // narrower width and every click lands at the wrong point.
    afterLayoutChange();
    // Awaited by the caller where it matters. `renderArch` needs `mode` (set above) to
    // turn the chart into a site picker, and the chart is redrawn when the arch lands.
    loadArch();
    return;
  }
  // Coming back from the plan tab, the MPR panes have been `display:none` and are
  // therefore zero-sized; Cornerstone still holds the canvas dimensions from before
  // and will not notice on its own.
  if (volume) afterLayoutChange();
}

/** Load the volume pack and mount all four panes. */
/** The one-line identity under the case title. Built, never appended to. */
function caseSubtitle(v) {
  const inp = (v.report || {}).input || {};
  return [
    v.job.attribution || null,
    (inp.size_xyz || []).join('×') || null,
    (inp.spacing_xyz || []).length
      ? inp.spacing_xyz.map((x) => x.toFixed(2)).join('×') + ' mm' : null,
  ].filter(Boolean).join(' · ');
}

async function mountVolume() {
  const v = state.viewer;
  if (!v || v.mprMounted) return;
  if (!window.DentistryViewer) { $('mprMeta').textContent = 'viewer bundle failed to load'; return; }
  const files = `${API}/jobs/${v.jobId}/files`;
  const base = `${files}/volume`;
  $('mprLoading').hidden = false;
  $('mprMeta').textContent = 'loading volume…';
  try {
    const meta = await (await cachedFetch(`${base}/meta.json`)).json();

    // Gzipped, the whole viewer payload is under 1.6 MB -- and on any repeat visit it
    // comes from Cache Storage with no network at all.
    const [img, lbl] = await Promise.all([
      cachedFetch(`${base}/image.raw`).then((r) => r.arrayBuffer()),
      cachedFetch(`${base}/labels.raw`).then((r) => r.arrayBuffer()),
    ]);

    const res = await DentistryViewer.mount(
      [$('csAxial'), $('csCoronal'), $('csSagittal')], meta, img, lbl, $('cs3d')
    );
    v.volumeMeta = meta;
    v.centroids = res.centroids || null;
    v.mprMounted = true;
    const st = overlayStyle();
    DentistryViewer.setOverlayStyle(st.fill, st.outline);
    // Re-apply anything already hidden, so no two panes disagree about what is shown.
    v.hidden.forEach((idx) => DentistryViewer.setStructureVisible(idx, false));

    const d = meta.dimensions;
    const lost = (meta.labels.lost_to_downsampling || []).length;
    $('mprMeta').textContent = '';
    $('mprLoading').hidden = true;
    v.archCentre = res.archCentre || null;
    v.mprInfo = `${d.join('×')} @ ${meta.spacing.map((x) => x.toFixed(2)).join('×')} mm` +
      ` · ${Object.keys(meta.colors).length} structures` +
      (lost ? ` · ${lost} too small to show at this resolution` : '');
    // Assigned, not appended. `+=` here meant reopening a case in the same session
    // stacked the same line onto the subtitle again.
    $('caseSub').textContent = caseSubtitle(v) + ' · ' + v.mprInfo;
    renderArch(v.report);   // centroids are known now, so teeth become jumpable
    syncMprToIsolate();     // and if something was already isolated, go to it
    if (res.volumeRendered) loadSurfaces(files);
    else $('surfaceNote').textContent = '3D rendering unavailable in this browser';
  } catch (e) {
    $('mprLoading').hidden = false;
    $('mprMeta').textContent = 'could not load the volume: ' + e.message;
  }
}

/* ------------------------------------------------------------- 3D surfaces */

/** Stream the per-structure meshes into the 3D pane, teeth first.
 *
 * Teeth and the canal before the jaws, because that is the order they matter in and
 * the jaws are most of the bytes: on the post-operative case the 34 small structures
 * are ~1 MB gzipped between them and the two jaws are another ~1.6 MB. Fetched one at
 * a time rather than all at once -- 36 parallel requests through one HTTP/1.1 origin
 * just queue, and serialising them means the first teeth are on screen while the rest
 * are still arriving.
 *
 * Failures are per-structure and non-fatal: a missing mesh costs one surface, and the
 * count is reported rather than the pane silently coming up short. Cases segmented
 * before `mesh/` existed have no manifest at all and fall back to the volume render.
 */
async function loadSurfaces(filesBase) {
  const v = state.viewer;
  const manifest = ((v.report.outputs || {}).mesh) || {};
  const ids = Object.keys(manifest);
  if (!ids.length) {
    $('surfaceNote').textContent =
      'volume rendering — this case predates the browser meshes; the surfaces are the STL downloads';
    set3dMode('bone', true);
    return;
  }
  const byId = {};
  allStructures().forEach((s) => { byId[s.id] = s.index; });
  const jaws = new Set(['maxilla', 'mandible']);
  const order = [...ids.filter((i) => !jaws.has(i)), ...ids.filter((i) => jaws.has(i))];

  let done = 0, tris = 0, failed = 0;
  const token = v.jobId;
  for (const id of order) {
    // A case closed or switched mid-stream must not keep pushing actors at a
    // viewport that now belongs to another scan.
    if (!state.viewer || state.viewer.jobId !== token || !state.viewer.mprMounted) return;
    const index = byId[id];
    if (index == null) continue;
    try {
      const buf = await cachedFetch(`${filesBase}/${manifest[id]}`).then((r) => r.arrayBuffer());
      const n = DentistryViewer.addSurface(index, buf);
      if (n) { done++; tris += n; }
    } catch (err) {
      failed++;
      console.warn(`dentistry: surface ${id} failed: ${err.message}`);
    }
    if (done === 1 || done % 8 === 0) {
      $('surfaceNote').textContent = `loading surfaces… ${done}/${order.length}`;
    }
  }
  DentistryViewer.surfacesReady();
  // Apply the mode now, not at mount: until a surface exists there is nothing to show
  // and hiding the volume actor early would leave an empty pane while they stream in.
  DentistryViewer.set3dMode(v.mode3d || 'surfaces');
  v.surfaceNote = `${done} smoothed surfaces · ${(tris / 1000).toFixed(0)}k triangles`
    + (failed ? ` · ${failed} failed to load` : '');
  $('surfaceNote').textContent = v.surfaceNote;
  syncMprToIsolate();
}

function set3dMode(mode, quiet) {
  const v = state.viewer;
  if (v) v.mode3d = mode;
  document.querySelectorAll('#modePicker3d .segb')
    .forEach((b) => b.classList.toggle('on', b.dataset['3d'] === mode));
  if (!quiet && window.DentistryViewer && v && v.mprMounted) DentistryViewer.set3dMode(mode);
}

function wire3d() {
  document.querySelectorAll('#modePicker3d .segb').forEach((b) => {
    b.onclick = () => set3dMode(b.dataset['3d']);
  });
}

/* ----------------------------------------------------------- the catalogue */
function allStructures() {
  const groups = (state.viewer && state.viewer.report.structures)
    || (state.catalog && state.catalog.groups) || [];
  return groups.flatMap((g) => g.structures.map((s) => ({ ...s, group: g.group })));
}
function colourForIndex(index) {
  const hit = allStructures().find((s) => s.index === Number(index));
  return hit ? hit.color : null;
}
/** Which structures this job actually found, by index. */
function presentIndices() {
  const vols = (state.viewer && state.viewer.report.quality && state.viewer.report.quality.volumes_cm3) || {};
  return new Set(allStructures().filter((s) => vols[s.id] != null).map((s) => s.index));
}

/* --------------------------------------------------------- the arch chart */
// FDI: quadrants 1 and 4 are the patient's RIGHT, 2 and 3 the left; position 1 is
// at the midline and 8 is the third molar. Drawn in the dental convention -- the
// patient's right on the viewer's left -- and labelled, because getting this
// backwards is exactly the failure mode the whole orientation pipeline exists to
// prevent, and a chart that lied about it would undo that work.
const ARCH_ROWS = [
  { quadrants: [1, 2], y: 16, label: 'upper' },
  { quadrants: [4, 3], y: 52, label: 'lower' },
];

function archGeometry() {
  const out = [];
  const W = 200, cx = W / 2;
  ARCH_ROWS.forEach(({ quadrants, y }) => {
    const [right, left] = quadrants;
    for (let pos = 1; pos <= 8; pos++) {
      // Molars sit further back, so step out and curve away from the midline.
      const dx = 8 + (pos - 1) * 11.4;
      const lift = Math.pow((pos - 1) / 7, 2) * 13;
      const w = pos <= 2 ? 8 : pos <= 5 ? 9.5 : 11;
      const h = pos <= 2 ? 11 : pos <= 5 ? 11 : 12.5;
      const upper = y < 30;
      const yy = upper ? y + lift : y - lift;
      out.push({ fdi: right * 10 + pos, x: cx - dx - w / 2, y: yy, w, h, side: 'right' });
      out.push({ fdi: left * 10 + pos, x: cx + dx - w / 2, y: yy, w, h, side: 'left' });
    }
  });
  return out;
}

function renderArch(r) {
  const v = state.viewer;
  const byFdi = new Map(allStructures().filter((s) => s.fdi != null).map((s) => [s.fdi, s]));
  const present = presentIndices();
  const planning = !!(v && v.mode === 'plan');
  const teeth = archGeometry().map((t) => {
    const s = byFdi.get(t.fdi);
    const has = s && present.has(s.index);
    const cls = ['tooth'];
    if (!has) cls.push('absent');
    else {
      if (v && v.hidden.has(s.index)) cls.push('off');
      if (v && v.isolated === s.index) cls.push('sel');
    }
    // In plan mode every position is a site, so every position is a target. Marking
    // them lets the CSS say "clickable here" without re-deriving the rule.
    if (planning) cls.push('site');
    const fill = has ? s.color : 'var(--surface-3)';
    const label = has ? `${s.name}` : `FDI ${t.fdi} — not found`;
    const ty = t.y < 30 ? t.y - 1.6 : t.y + t.h + 4.4;
    return `<g class="${cls.join(' ')}" data-index="${has ? s.index : ''}" data-fdi="${t.fdi}">
      <title>${esc(planning ? siteTitle(t.fdi, label, has) : label)}</title>
      <rect x="${t.x.toFixed(1)}" y="${t.y.toFixed(1)}" width="${t.w}" height="${t.h}"
            rx="${(t.w / 3).toFixed(1)}" fill="${fill}"></rect>
      <text x="${(t.x + t.w / 2).toFixed(1)}" y="${ty.toFixed(1)}">${t.fdi}</text>
    </g>`;
  }).join('');
  $('archChart').innerHTML =
    `<svg viewBox="0 0 200 76" role="img" aria-label="FDI dental chart">${teeth}</svg>`;

  $('archChart').querySelectorAll('.tooth').forEach((g) => {
    // In the plan tab EVERY position is an implant site, not just the absent ones.
    // Restricting it to `.absent` was the reasoning "an implant site is by definition a
    // gap in the dentition" -- true of a healed site and false of an extraction site,
    // and it made the feature unreachable on any full-dentition scan: measured on the
    // both-jaws example case, 32 of 32 teeth present, so ZERO clickable sites existed.
    if (planning) {
      g.onclick = () => syncPlanToIsolate(g.dataset.fdi);
      return;
    }
    if (g.classList.contains('absent')) return;
    g.onclick = () => toggleIsolate(Number(g.dataset.index));
  });
  const n = present.size;
  // The hint read the same in both views, which made it useless in one of them: what
  // a click does depends on which stage is open, and "isolate" is only half of it.
  $('chartHint').textContent =
    planning ? 'click a position — places an implant there'
    : v && v.isolated != null ? 'click again to clear'
    : !(v && v.centroids) ? `${n} structures`
    : v.mode === 'volume' ? 'click a tooth — panes and 3D follow'
    : 'click a tooth — jumps to its slice';
}

/** The chart tooltip in plan mode: what this site is, and how much bone it has.
 *
 *  The height and width come from the WORKER's per-site measurement (`ridge.py`), which
 *  exists so a site can be judged BEFORE an implant is placed there -- its whole reason
 *  for being is to colour this chart, and nothing read it until now. Stated with the
 *  refusal when there is one, because "not measured, and here is why" is a different
 *  fact from "no bone".
 */
function siteTitle(fdi, label, has) {
  const v = state.viewer;
  const jaw = String(fdi)[0] <= '2' ? 'maxilla' : 'mandible';
  const fit = ((v && v.report.arch || {}).jaws || {})[jaw];
  const site = fit && fit.ok && (fit.sites || {})[String(fdi)];
  const lines = [has ? `${label} — click to plan an extraction site here`
                     : `FDI ${fdi} — no tooth found; click to plan a site here`];
  if (!site) return lines.join('\n');
  if (site.s_mm == null) {
    lines.push(site.reason ? `No arc position: ${site.reason}` : 'No arc position for this site');
    return lines.join('\n');
  }
  if (site.height_mm != null) lines.push(`${site.height_mm.toFixed(1)} mm bone height`);
  else if (site.height_reason || site.reason) lines.push(`Height: ${site.height_reason || site.reason}`);
  if (site.width_mm != null) lines.push(`${site.width_mm.toFixed(1)} mm crestal width`);
  else if (site.width_reason) lines.push(`Width: ${site.width_reason}`);
  return lines.join('\n');
}

/** Isolate one structure everywhere, and navigate every view to it.
 *
 * Both halves are load-bearing. Isolating without navigating is what this used to do,
 * and it was indistinguishable from broken: measured on a 29-tooth case in the old
 * Slices tab, clicking a tooth moved the slice **0 times out of 29** and left **28 of
 * 29** showing no overlay at all, because the tooth simply was not on whatever slice
 * happened to be open. The lesson outlived that tab -- every view this isolates in has
 * to be navigated to the structure, or the isolate reads as a failure. */
async function toggleIsolate(index) {
  const v = state.viewer;
  if (!v) return;
  const all = [...presentIndices()];
  if (v.isolated === index) {
    v.isolated = null;
    v.hidden.clear();
  } else {
    v.isolated = index;
    v.hidden = new Set(all.filter((i) => i !== index));
    const c = v.centroids && v.centroids[index];
    if (c && window.DentistryViewer) DentistryViewer.jumpTo(c);
    // The 3D camera is aimed further down, AFTER pushVisibility: it frames whatever is
    // visible, so aiming it while the rest of the arch is still shown would frame the
    // arch and leave the tooth a speck.
  }
  $('isolateClear').hidden = v.isolated == null;
  pushVisibility(all);
  if (v.isolated != null) {
    const c = v.centroids && v.centroids[v.isolated];
    if (c) focus3d(v.isolated, c);
  } else if (window.DentistryViewer && v.mprMounted) {
    DentistryViewer.surfacesReady();      // clearing isolate re-frames the whole arch
  }
  renderStructures(v.report);
  renderArch(v.report);
}

/** Point the MPR cameras at whatever is currently isolated, if anything.
 *
 * Called after a mount and after every switch into the MPR tab, because those are the
 * two moments the cameras can be out of step with the isolate state: `toggleIsolate`
 * calls `jumpTo` at click time, but that does nothing when the volume has not mounted
 * yet (a slow fetch, a failed one, or a click during the ~1.6 MB download) and nothing
 * replayed it afterwards. */
function syncMprToIsolate() {
  const v = state.viewer;
  if (!v || v.isolated == null || !v.mprMounted || !window.DentistryViewer) return false;
  const c = v.centroids && v.centroids[v.isolated];
  if (!c) return false;
  focus3d(v.isolated, c);
  return DentistryViewer.jumpTo(c);
}

/** Point the 3D camera at the isolated structure, from the buccal side.
 *
 * Only for teeth. The jaws and the canal are horseshoes whose centroid is in mid-air,
 * so "look at the centroid from outside the arch" means nothing for them -- for those
 * the framing that already fits everything is the better view, and moving the camera
 * would just be motion for its own sake.
 */
function focus3d(index, centroid) {
  const v = state.viewer;
  if (!v || !v.mprMounted || !window.DentistryViewer) return false;
  const s = allStructures().find((x) => x.index === index);
  if (!s || s.fdi == null) return false;
  return DentistryViewer.focusStructure(centroid, {
    index,
    archCentre: v.archCentre,
    upper: s.fdi < 30,                  // FDI quadrants 1 and 2 are the upper arch
  });
}

/** The ONE place that pushes visibility to every pane.
 *
 * Keeping two copies of this is how `hide all` once redrew the tiles correctly and
 * silently did nothing to the Cornerstone labelmap. Keyed by structure INDEX, never
 * by colour: colour looked like a convenient key because the tile overlay filtered
 * by RGB, but it is not unique -- the two "unnumbered teeth" classes shared a grey,
 * and a colour->index lookup returns only the first match. The tile overlay is gone
 * with the Slices tab; the rule it taught is not.
 */
function pushVisibility(indices) {
  const v = state.viewer;
  if (!v || !v.mprMounted || !window.DentistryViewer) return;
  indices.forEach((idx) => DentistryViewer.setStructureVisible(idx, !v.hidden.has(idx)));
}

/* --------------------------------------------------------------- sidebar */

/* --------------------------------------------------------------- sidebar */

/** Clinical findings only. The engineering telemetry moved to "Run details".
 *
 * These used to share one flat list of 22 rows, so "29 / 32 teeth numbered" sat four
 * lines above a peak-VRAM figure. They answer different questions for different
 * people, and mixing them made the first kind hard to find.
 */
/** One definition-list row set, shared by Findings, Series and Run details.
 *
 * A row whose label starts with two spaces is a sub-row of the one above it. That
 * indent used to be literal leading whitespace held in place by `.kv dt {
 * white-space: pre }` -- which also forbade wrapping, so a long label became an
 * atomic box that widened the whole rail. The marker convention stays (call sites
 * are unchanged); the indent is now a class, and the label can wrap.
 */
function kvList(rows) {
  return `<dl class="kv">${rows.map(([k, val, c]) => {
    const sub = /^ {2}/.test(k);
    return `<dt class="${sub ? 'sub' : ''}">${esc(sub ? k.slice(2) : k)}</dt>`
      + `<dd class="${c}">${esc(val)}</dd>`;
  }).join('')}</dl>`;
}

/** Per-structure accuracy keyed by merged structure id, or null when the job has
 *  none -- which is every upload. Rebuilt per call rather than cached: 45 entries is
 *  nothing, and renderStructures re-runs from the toggleAll handler where stale
 *  state would be worse than the work saved. */
function accuracyById(r) {
  const list = (r.accuracy && r.accuracy.structures) || null;
  return list ? new Map(list.map((s) => [s.id, s])) : null;
}

/** Measured accuracy -- and only where a measurement genuinely exists.
 *
 * Every other panel in this rail scores the result against itself, because that is
 * all an uploaded scan allows: `renderFindings` counts labels made, not labels
 * correct, and says so. This card is the one place that is not true, and the reason
 * is a property of the CASE rather than of the model -- the two published ToothFairy3
 * examples are held-out cases from an annotated research dataset, so a truth exists
 * and the model never saw it.
 *
 * The gate is the presence of `r.accuracy`, which only scripts/tf3_seed_showcase.py
 * writes and only when handed a ground-truth file. A user's scan cannot reach this
 * code path however the client is driven.
 */
let MODEL_PRIORS = null;

/** The holdout error budget, as a PRIOR. Never a measurement of the scan on screen.
 *
 *  Served from `GET /v1/model-accuracy` without a job id, on purpose: it is a fact
 *  about the model, identical for every caller, and keeping it away from a job id is
 *  what stops it being read as this case's score. It sits in its own collapsed card,
 *  separate from `#accuracyCard` -- which only ever appears on a published example that
 *  came with ground truth -- so the two cannot be averaged in a reader's head.
 *
 *  Per STRUCTURE, because one budget cannot serve all of them: the accessory canals are
 *  2.1-2.4x the inferior alveolar canal's inward error, and the teeth are better on the
 *  typical case and worse in the tail. `inward p95` is the direction that costs
 *  clearance -- the drawn wall sitting INSIDE the true one -- and it is what the implant
 *  verdicts deduct. The worst single point is quoted and never subtracted: deducting one
 *  outlier from every case would be theatre.
 */
async function renderModelPriors() {
  const card = $('priorsCard');
  const box = $('priorsBody');
  if (!card || !box) return;
  if (!MODEL_PRIORS) {
    try {
      MODEL_PRIORS = await api('/model-accuracy');
    } catch (e) {
      card.hidden = true;
      return;
    }
  }
  const m = MODEL_PRIORS;
  const st = m.protocol && m.protocol.strict ? m.protocol.strict : {};
  const ch = m.protocol && m.protocol.challenge ? m.protocol.challenge : {};
  const rows = Object.entries(m.structures || {}).map(([, v]) =>
    `<tr><th>${esc(v.label)}</th>
       <td class="mono">${v.p95_mm.toFixed(2)} mm</td>
       <td class="mono">${v.worst_mm.toFixed(2)} mm</td>
       <td class="mono">${v.dice_gt != null ? v.dice_gt.toFixed(3) : ''}</td></tr>`).join('');
  const worst = m.worst_tooth_classes || {};
  box.innerHTML = `
    <p class="finding-why"><b>${esc(m.source)}</b></p>
    ${kvList([
      ['Mean Dice', st.mean_dice != null ? st.mean_dice.toFixed(4) : '', ''],
      ['Mean HD95', st.mean_hd95_mm != null ? `${st.mean_hd95_mm.toFixed(3)} mm` : '', ''],
      ['Mean NSD @ 1 mm', st.mean_nsd != null ? st.mean_nsd.toFixed(4) : '', ''],
      ['Challenge Dice', ch.mean_dice != null ? ch.mean_dice.toFixed(4) : '', ''],
    ])}
    <p class="finding-why">${esc(st.note || '')}</p>
    <p class="finding-why">${esc(ch.note || '')}</p>
    <h4>The structures an implant plan depends on</h4>
    <p class="finding-why">Inward error is the direction that costs clearance: the drawn
      wall sitting <em>inside</em> the true one. The p95 is what the implant verdicts
      deduct; the worst single point is quoted and never subtracted.</p>
    <table class="ptable">
      <thead><tr><th>Structure</th><th>Inward p95</th><th>Worst point</th><th>Dice·GT</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    ${worst.inward_max_mm ? `<p class="finding-why">${esc(worst.note || '')}
      ${Object.entries(worst.inward_max_mm)
        .map(([k, v]) => `${esc(k)} ${v.toFixed(2)} mm`).join(', ')}.</p>` : ''}
    <h4>What this does not claim</h4>
    <ul class="notelist">${(m.not_claimed || [])
      .map((t) => `<li>${esc(t)}</li>`).join('')}</ul>`;
  card.hidden = false;
}

function renderAccuracy(r) {
  const a = r.accuracy, card = $('accuracyCard');
  const agg = (a && a.aggregate) || null;
  if (!agg || agg.mean_dice == null) { card.hidden = true; card.innerHTML = ''; return; }
  card.hidden = false;

  const ref = a.reference || {}, pr = a.protocol || {}, list = a.structures || [];
  const nm = new Map(allStructures().map((s) => [s.id, s.name]));
  const label = (s) => nm.get(s.id) || s.name || s.id;
  // Everything numeric goes through this. check-rail asserts no NaN/undefined/Infinity
  // reaches the rail, and a null metric on an absent structure is the ordinary case.
  const num = (x, nd, unit) => (x == null || !isFinite(x)) ? '\u2014'
    : x.toFixed(nd) + (unit || '');

  const missed = list.filter((s) => s.status === 'missed');
  const spurious = list.filter((s) => s.status === 'spurious');
  const scored = list.filter((s) => s.status === 'scored' && s.dice != null);
  const worst = scored.slice().sort((x, y) => x.dice - y.dice).slice(0, 3);
  const d = agg.mean_dice;

  const rows = [
    ['Mean Dice', num(d, 3), ''],
    ['  over', `${agg.classes_scored ?? scored.length} structures`, ''],
    [`Surface within ${pr.tolerance_mm ?? 1} mm`, num(agg.mean_nsd, 3), ''],
    ['HD95', num(agg.mean_hd95, 2, ' mm'), ''],
    ['Weakest', worst.map((s) => `${label(s)} ${s.dice.toFixed(2)}`).join(' \u00b7 ') || '\u2014', ''],
    ...(missed.length
      ? [['Not found at all', missed.map(label).join(', '), 'bad']] : []),
    ...(spurious.length
      ? [['Not in the annotation', spurious.map(label).join(', '), 'bad']] : []),
    ...(agg.classes_absent_both
      ? [['Absent from both', `${agg.classes_absent_both} \u2014 excluded, not scored 1.0`, '']] : []),
  ];

  card.innerHTML = `
    <div class="card-head"><h3>Measured accuracy</h3>
      <span class="hint">${esc(ref.dataset || 'reference')}</span></div>
    <div class="metric"><b>${num(d, 3)}</b><span>mean Dice against expert annotation</span></div>
    <div class="meter"><i style="width:${Math.max(0, Math.min(100, d * 100))}%"></i></div>
    <p class="acc-ref">
      <b>This is not a patient scan.</b> ${esc(ref.case || 'This case')} comes from the
      ${esc(ref.dataset || 'reference')} research dataset and carries an expert
      annotation; it was held out of training, so this model has never seen it. That is
      what makes a measurement possible here and impossible on an upload &mdash; the
      Findings panel above is what is left when there is nothing to measure against.
      One case, and the easiest kind: read it as a demonstration that the numbers are
      real, not as what your own scan would score.
    </p>
    ${kvList(rows)}
    ${accuracyCanal(list, num)}
    <p class="finding-why" style="margin:.6rem 0 0">
      Strict protocol: a structure absent from both the annotation and the prediction is
      excluded rather than scored 1.0. Dice is unforgiving of small objects &mdash; a
      canal one voxel wide loses a third of its score to a one-voxel wall shift &mdash;
      so read the millimetre figures for those, not the ratio. Computed in the
      ${pr.n_classes ?? 45}-structure space shown here; these are not challenge
      leaderboard numbers.
    </p>`;
}

/** The canal block: the one place a millimetre figure belongs in front of a reader.
 *
 * `inward` is the direction that costs clearance -- the drawn wall sitting inside the
 * true one means a plan believes it has more bone than it has. p95 leads and max is a
 * subordinate clause, because a max moves on a single stray voxel: `ToothFairy3F_041`
 * shows 3.15 mm max against 0.42 mm p95 on one structure.
 */
function accuracyCanal(list, num) {
  const canals = list.filter((s) => s.inward_p95 != null
    && (s.id === 'canal' || /canal/i.test(s.id)));
  if (!canals.length) return '';
  return canals.map((s) => {
    const sides = (s.sides || []).map((sd) => {
      const cov = sd.status === 'not annotated'
        ? 'not annotated on this scan'
        : `${Math.round((sd.covered ?? 0) * 100)}% of the annotated canal covered`
          + (sd.inward_p95 != null ? ` \u00b7 ${num(sd.inward_p95, 2)} mm inward` : '');
      return `<span>${esc(sd.side)}</span><b>${esc(cov)}</b>`;
    }).join('');
    return `<div class="finding">
      <div class="finding-head"><span>${esc(s.name || s.id)}</span>
        <span class="mono">${num(s.inward_p95, 2, ' mm')}</span></div>
      <p class="finding-why">The drawn wall sits up to ${num(s.inward_p95, 2)} mm inside
        the true wall at the 95th percentile (worst single point
        ${num(s.inward_max, 2)} mm). This is the direction that costs clearance: a plan
        drawn on this outline believes it has that much more bone than it has.</p>
      ${sides ? `<div class="acc-side">${sides}</div>` : ''}
    </div>`;
  }).join('');
}

function renderFindings(r) {
  const q = r.quality || {}, roi = r.roi || {};
  const lat = q.laterality_ok;
  const vert = q.vertical_ok;

  const rows = [
    ['Teeth numbered', `${q.teeth_found ?? 0} / 32`, ''],
    ...(absentTeeth(r).length
      ? [['  absent at that position', absentTeeth(r).join(', '), '']] : []),
    ['Fragmented teeth', fragSummary(q), (q.teeth_fragmented || []).length ? 'warn' : 'ok'],
    // Detached fragments in the wrong jaw. Reported, never repaired: the obvious
    // repair -- nnU-Net's keep-largest-component per tooth -- was measured to delete
    // 326 mm3 from tooth 27 on the pre-surgery example, about a third of a molar.
    // `=== true`, not `!== undefined`. The field is always PRESENT -- `assess(arch=None)`
    // emits the whole block zeroed with `arch_checked: false` -- so the old test never
    // fired and a single-model job rendered "not checked" against a comparison that
    // does not exist for it. Absent (pre-check jobs) and false (no second model) both
    // mean "say nothing".
    ...(q.arch_checked !== true ? [] : [(q.arch_conflicts || []).length
      ? ['  wrong arch, detached',
         `${[...new Set(q.arch_conflicts.map((c) => c.fdi))].join(', ')} · `
         + `${Math.round(q.arch_conflict_mm3 || 0)} mm³`, 'warn']
      : ['  wrong arch, detached', 'none', 'ok']]),
    // And the same disagreement counted over the whole label, which is where most of
    // it lives -- a patch fused to the crown it invaded is not a detached fragment.
    // Never zero: the two models always differ by a little at the bite. What matters
    // is whether any one tooth is largely in the other jaw.
    ...(q.arch_checked !== true ? [] : [(() => {
      const bad = (q.arch_wrong_by_tooth || []).filter((e) => e.share_of_tooth >= 0.25);
      return bad.length
        ? ['  wrong arch, in total',
           `${bad.map((e) => `${e.fdi} at ${Math.round(e.share_of_tooth * 100)}%`).join(', ')}`
           + ` of ${Math.round(q.arch_wrong_mm3)} mm³`, 'bad']
        : ['  wrong arch, in total',
           `${Math.round(q.arch_wrong_mm3)} mm³, no tooth over 25%`, 'ok'];
    })()]),
    // Absent field vs empty field. A case segmented before these checks existed has
    // neither, and saying "matched" about a comparison that never ran would be a lie
    // the reader has no way to catch.
    ...(q.symmetry_violations === undefined ? [] : [(q.symmetry_violations.length
      ? ['Left/right volumes',
         q.symmetry_violations.map((v) => `${v.pair[0]}/${v.pair[1]} ${Math.round(v.difference * 100)}%`)
           .join(', '), 'warn']
      : ['Left/right volumes', 'matched', 'ok'])]),
    ['Canal components', q.canal_components ?? '—', q.canal_components === 2 ? 'ok' : 'warn'],
    ['Left/right check', lat == null ? 'not checked' : lat ? 'consistent' : 'FAILED',
      lat == null ? '' : lat ? 'ok' : 'bad'],
    ...(q.laterality_checks || []).filter((c) => c.result === 'FAILED')
        // `check` is an identifier -- `matches_image_orientation` is 25 unbreakable
        // characters, the one raw token that reaches a <dt>.
        .map((c) => ['  ' + c.check.replace(/_/g, ' '), 'failed', 'bad']),
    // The superior-inferior twin. `undefined` on any case segmented before the
    // check existed, and that is shown as "not checked" rather than as a pass --
    // the whole reason this row is here is that a silent absence once let four
    // upside-down examples ship looking perfectly healthy.
    ...(vert === undefined ? [] : [['Up/down check',
      vert == null ? 'not checked' : vert ? 'consistent' : 'FAILED — scan is inverted',
      vert == null ? '' : vert ? 'ok' : 'bad']]),
  ];

  // The headline used to be cross-model Dice, which one model cannot produce. This
  // counts labels made, NOT labels that are correct -- there is no ground truth on a
  // patient scan -- and the meter carries no ok/warn/bad class because fewer than 32
  // is an ordinary dentition, not a failure.
  const found = q.teeth_found ?? 0;
  $('findingsCard').innerHTML = `
    <div class="card-head"><h3>Findings</h3></div>
    <div class="metric">
      <b>${found}</b><span>of 32 FDI positions numbered</span>
    </div>
    <div class="meter"><i style="width:${Math.max(0, Math.min(100, found / 32 * 100))}%"></i></div>
    <p class="finding-why" style="margin:0 0 .7rem">
      A count of what the model labelled, not of what it got right &mdash; there is no
      ground truth on a patient scan. Positions with no tooth material at all are named
      below, and an absent third molar is an ordinary dentition rather than a miss.
    </p>
    ${kvList(rows)}
    ${unnumberedBlock(q)}
    ${roi.laterality_unverified ? `<ul class="warnlist"><li>${esc(roi.laterality_unverified)}</li></ul>` : ''}
    ${roi.toothseg_patch_fallback ? `<ul class="warnlist"><li>The tooth model ran at a reduced ${roi.toothseg_patch_fallback.join('×')} patch after running out of GPU memory; tooth boundaries are less reliable than usual.</li></ul>` : ''}
    ${(q.warnings || []).length ? `<ul class="warnlist">${q.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}
    ${((r.input || {}).warnings || []).length ? `<ul class="warnlist">${r.input.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}
    ${scanFactsBlock(r)}
  `;
}

/** What is measurable about THIS scan with no ground truth, kept apart from findings.
 *
 *  Two lists, and the separation is the substance rather than the styling. A WARNING is
 *  a finding about the segmentation; a NOTE is a fact about the scan. "This structure is
 *  cut by the edge of the field of view" and "this structure is the wrong size" look
 *  identical in a volume table and mean opposite things, and conflating them was the
 *  largest live source of false findings on real uploads: any tooth half-outside the
 *  field fell below its plausible floor, and a canal leaving the field came back in
 *  more pieces than expected.
 *
 *  The other three are things the pipeline already recorded and never showed: how far
 *  the arch fit missed the teeth, whether the scanner's grey values were recalibrated
 *  and by how much, and how much of the prediction the field-of-view guard discarded.
 *  All three are scan-specific and none needs ground truth.
 */
function scanFactsBlock(r) {
  const q = r.quality || {}, roi = r.roi || {}, intensity = r.intensity || {};
  const items = [...(q.notes || [])];

  const fits = ((r.arch || {}).jaws) || {};
  Object.entries(fits).forEach(([jaw, info]) => {
    if (info && info.ok && info.fit && info.fit.residual_p95_mm != null) {
      items.push(`${jaw} arch fit: the curve sits ${info.fit.residual_p95_mm.toFixed(2)} mm `
        + `from the teeth at the 95th percentile (a fit is refused past 5 mm)`);
    } else if (info && !info.ok && info.reason) {
      items.push(`${jaw} arch: no curve was fitted — ${info.reason}`);
    }
  });

  if (intensity.gain != null) {
    items.push(`grey values rescaled by ${Number(intensity.gain).toFixed(2)}× to match `
      + `what the model was trained on`
      + (Number(intensity.gain) > 1.5 || Number(intensity.gain) < 0.67
        ? ' — a large correction, and a sign this scanner is calibrated well away from '
          + 'the training set' : ''));
  } else if (intensity.reason) {
    items.push(`grey values left uncalibrated — ${intensity.reason}`);
  }

  if (roi.fov_dropped_voxels) {
    const mm3 = (r.postprocess || {}).cc_filter || {};
    items.push(`${Number(roi.fov_dropped_voxels).toLocaleString()} predicted voxel(s) `
      + `were discarded outside the padded box around the dentition`
      + (mm3.voxel_mm3 ? ` (${(roi.fov_dropped_voxels * mm3.voxel_mm3).toFixed(0)} mm³)` : '')
      + ` — the model labels cranial structures this product does not claim`);
  }

  if (!items.length) return '';
  return `<div class="scanfacts">
    <h4>About this scan</h4>
    <p class="finding-why">Facts about the image, not findings about the segmentation.
      A structure cut by the edge of the field of view is the wrong size because the scan
      stops, and that is not an error to correct.</p>
    <ul class="notelist">${items.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>
  </div>`;
}

/** FDI numbers with no tooth material of any kind at that position.
 *
 * "29 / 32" reads like a score the model lost. Usually it is not: on the
 * post-operative example, 18, 28 and 38 are simply absent, which is an ordinary
 * post-orthognathic dentition. Naming them is the difference between a finding and
 * an accusation.
 */
function absentTeeth(r) {
  const vols = (r.quality || {}).volumes_cm3 || {};
  return allStructures()
    .filter((s) => s.fdi != null && vols[s.id] == null)
    .map((s) => s.fdi);
}

/** The unnumbered classes, split into what they actually are.
 *
 * `*_teeth_unnumbered` is a residual class that only the retired two-model pipeline
 * could produce: tooth material one model found and the other did not number. It is
 * always zero on a single-model job, which is why the block renders nothing at all
 * rather than a reassuring "none" -- there is no comparison left to report the result
 * of. Archived cases still carry real values, and the film / restorative /
 * free-standing split is the part of this that was never about two models: a dense
 * mass thicker than enamel is a crown whatever produced the label.
 */
function unnumberedBlock(q) {
  const u = q.unnumbered;
  const v = q.volumes_cm3 || {};
  const legacy = (v.upper_teeth_unnumbered || 0) + (v.lower_teeth_unnumbered || 0);
  if (!u) {
    // Segmented before the split existed. Say the total and nothing more -- inventing
    // a breakdown for a case that was never measured that way would be a guess.
    if (!legacy) return '';
    return `<div class="finding"><div class="finding-head"><span>Unnumbered tooth material</span>
      <b>${legacy.toFixed(2)} cm³</b></div>
      <div class="finding-why">Not broken down: this case was segmented before the
      film / restorative / free-standing split existed.</div></div>`;
  }
  // Nothing to report, and nothing to reassure about: on a single-model job this
  // class cannot exist, so a "none" card would answer a question nobody asked.
  if (!u.total_mm3) return '';
  const parts = [
    ['film', u.film_mm3, 'var(--muted)', 'boundary film'],
    ['dense', u.dense_mm3, 'var(--warn)', 'restorative'],
    ['free', u.free_mm3, 'var(--bad)', 'free-standing'],
  ].filter(([, mm3]) => mm3 > 0);
  const bars = parts.map(([, mm3, col]) =>
    `<i style="width:${(100 * mm3 / u.total_mm3).toFixed(1)}%;background:${col}"></i>`).join('');
  const key = parts.map(([, mm3, col, label]) =>
    `<span style="color:${col}">${Math.round(mm3)} mm³ ${esc(label)}</span>`).join('');

  const dense = (u.components || []).filter((c) => c.bucket === 'dense');
  const free = (u.components || []).filter((c) => c.bucket === 'free');
  let why;
  if (dense.length) {
    const d = dense[0];
    why = `A ${Math.round(d.mm3)} mm³ mass ${d.thickness_mm} mm thick at `
        + (d.touches.length ? `teeth ${d.touches.join(', ')}` : 'no numbered tooth')
        + `, denser than this scan's own enamel — restorative material. There is no
           class for crowns, bridges or implants in this label space, so it cannot be
           numbered as a tooth.`;
  } else if (free.length) {
    why = `${free.length} free-standing piece(s), largest ${Math.round(free[0].mm3)} mm³ and
           ${free[0].gap_mm} mm from any numbered tooth — tooth material that was not
           claimed by a numbered tooth.`;
  } else {
    why = `All of it sits within ${u.film_within_mm} mm of a numbered tooth: this is a
           boundary a voxel or two wide, not a missing tooth.`;
  }
  return `<div class="finding">
    <div class="finding-head"><span>Unnumbered tooth material</span>
      <b class="${dense.length || free.length ? 'warn' : ''}">${(u.total_mm3 / 1000).toFixed(2)} cm³</b></div>
    <div class="bars">${bars}</div>
    <div class="barkey">${key}</div>
    <div class="finding-why">${why}</div>
  </div>`;
}

/** "31, 43 · largest 34 mm³ on 31" — a fragment count nobody can act on becomes one they can.
 *
 * The bare list of FDI numbers did not distinguish a root apex sheared off by a metal
 * streak, which is 1 mm away and unremarkable, from a piece of a lower incisor sitting
 * up in the maxilla, which is 17 mm away and wrong. */
function fragSummary(q) {
  const fdis = q.teeth_fragmented || [];
  if (!fdis.length) return 'none';
  const frags = q.tooth_fragments || [];
  if (!frags.length) return fdis.join(', ');
  const worst = frags.reduce((a, b) => (b.mm3 > a.mm3 ? b : a));
  return `${fdis.join(', ')} · largest ${Math.round(worst.mm3)} mm³ on ${worst.fdi}`;
}

/** What this scan is, and only what the file actually says.
 *
 * Field of view and voxel size are the two parameters CBCT practice treats as
 * deciding whether a scan can answer a question at all, and both are computable from
 * the pixel data with no DICOM at all. Everything below them comes from tags, and a
 * tag that is not in the file says exactly that -- there is no placeholder value,
 * because "0 kV" and "this scanner did not record it" are not the same statement.
 */
function renderSeries(v) {
  const r = v.report || {}, inp = r.input || {}, o = r.orientation || {}, job = v.job || {};
  const size = inp.size_xyz || [], sp = inp.spacing_xyz || [];
  const fov = size.length === 3 && sp.length === 3 ? size.map((n, i) => n * sp[i]) : null;
  const iso = sp.length === 3 && sp.every((x) => Math.abs(x - sp[0]) < 5e-3);
  const acq = inp.acquisition || null;

  const rows = [
    ['Source', inp.kind === 'dicom'
      ? `DICOM series · ${inp.n_files} file${inp.n_files === 1 ? '' : 's'}`
      : 'volume file (NIfTI/NRRD)', ''],
    ...(inp.series_description ? [['Series', inp.series_description, '']] : []),
    ['Matrix', size.join(' × ') || '—', ''],
    ['Voxel', sp.length !== 3 ? '—'
      : iso ? `${sp[0].toFixed(2)} mm isotropic`
            : sp.map((x) => x.toFixed(2)).join(' × ') + ' mm', ''],
    ['Field of view', fov ? fov.map((x) => x.toFixed(0)).join(' × ') + ' mm' : '—', ''],
    ...(fov ? [['  coverage', fovClass(fov), '']] : []),
    ['Stored as', o.original ? `${o.original} → ${o.canonical}` : '—', ''],
    ['Patient tilt', o.tilt_degrees != null ? o.tilt_degrees.toFixed(1) + '°' : '—', ''],
    ['Grey values', 'not calibrated HU', 'dim'],
  ];

  // Acquisition. Shown for DICOM whether or not the tags were there, because "this
  // scanner did not record the tube current" is itself worth knowing; hidden entirely
  // for a NIfTI, where the question does not arise.
  const ACQ = [
    ['Scanner', (a) => [a.manufacturer, a.model].filter(Boolean).join(' ') || null],
    ['Tube voltage', (a) => a.kvp != null ? `${a.kvp} kV` : null],
    ['Tube current', (a) => a.tube_current_ma != null ? `${a.tube_current_ma} mA` : null],
    ['Exposure', (a) => a.exposure_mas != null ? `${a.exposure_mas} mAs`
      : (a.exposure_time_ms != null ? `${a.exposure_time_ms} ms` : null)],
    ['Recon diameter', (a) => a.reconstruction_diameter_mm != null
      ? `${a.reconstruction_diameter_mm} mm` : null],
    ['Study date', (a) => a.study_date ? isoDate(a.study_date) : null],
  ];
  if (inp.kind === 'dicom') {
    ACQ.forEach(([label, get]) => {
      const val = acq ? get(acq) : null;
      rows.push([label, val || 'not in file', val ? '' : 'dim']);
    });
  }

  rows.push(['Uploaded', job.created_at ? fmtWhen(job.created_at) : '—', '']);
  rows.push(['Segmented in', fmtSecs(job.gpu_seconds), '']);

  $('seriesBody').innerHTML = kvList(rows);
}

/** Dental FOV classes, by the axial diameter. The usual clinical split: a small field
 *  answers an endodontic question, a medium one covers both arches, a large one is a
 *  maxillofacial study. It matters because it bounds what the scan can be used for. */
function fovClass(fov) {
  const d = Math.max(fov[0], fov[1]) / 10;    // cm
  if (d <= 8) return `small field, ${d.toFixed(0)} cm — single site`;
  if (d <= 15) return `medium field, ${d.toFixed(0)} cm — both arches`;
  return `large field, ${d.toFixed(0)} cm — maxillofacial`;
}

function isoDate(s) {
  return /^\d{8}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6)}` : s;
}

function fmtWhen(iso) {
  const d = new Date(iso);
  return isNaN(d) ? String(iso) : d.toLocaleString(undefined,
    { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** Everything about how the job ran, folded away by default.
 *
 * Not hidden because it is embarrassing -- it is the evidence that the numbers above
 * came from somewhere -- but a dentist opening a case does not need peak VRAM in the
 * third row.
 */
/** A merged structure's display name, falling back to its id. */
function structureName(id) {
  const s = allStructures().find((x) => x.id === id);
  return s ? s.name : id;
}

function renderRunDetails(r) {
  const models = r.models || [], mesh = r.meshes || {}, rt = r.rtstruct || {};
  const ct = r.contours || {}, roi = r.roi || {}, m = r.merge || {}, q = r.quality || {};
  const ctDrops = ct.slices_without_contour_count;
  const ctRecovered = Object.values(ct.slices_recovered_at_lower_iso || {})
    .reduce((a, b) => a + b, 0);
  const specks = Object.values(m.specks_removed || {}).reduce((a, b) => a + b, 0);
  const mt = mesh.totals || {};

  const rows = [];
  // WHAT WAS ASKED FOR, before what ran. `reports.requested` exists only on a job
  // uploaded through the model picker; its absence means the deployment default at the
  // time, which is the truth about every job that predates the picker and must not be
  // rendered as a set of models nobody chose.
  const req = r.requested;
  if (req && req.config) {
    const chosen = Object.keys(req.config).filter((k) => req.config[k] !== 'off');
    rows.push(['Chosen at upload', `${chosen.length} model(s)`, '']);
    (req.unavailable || []).forEach((u) => {
      // A requested model that was not deployed. Loud, because the numbers that come
      // out the far end are clearances to structures whose predicted volume depends on
      // which model drew them -- a quiet fallback here is a wrong number later.
      rows.push(['  not available', `${u.name} — ${u.reason}`, 'bad']);
    });
  }
  // The model NAME is a value, not a label. It used to be interpolated into the
  // `<dt>` -- so "ToothFairy3 U-Mamba2 (Task 1) peak VRAM" became a 263px
  // unwrappable label and took the whole rail with it. Both numbers are optional:
  // a seeded showcase job records neither.
  const board = r.board || [];
  models.forEach((mo) => {
    rows.push(['Model', mo.name, '']);
    if (mo.seconds != null) rows.push(['  time', fmtSecs(mo.seconds), '']);
    if (mo.peak_reserved_mb != null) {
      rows.push(['  peak VRAM', (mo.peak_reserved_mb / 1000).toFixed(2) + ' GB', '']);
    }
    // Which structures this model is authoritative for, and whether it actually ran.
    // Recovering that from a published artifact by matching volumes across every eval
    // run cost an afternoon once; `reports.board` exists so it never has to again.
    const b = board.find((x) => x.name === mo.name);
    if (b) {
      if (b.skipped) {
        rows.push(['  skipped', b.skipped, 'warn']);
      } else {
        if ((b.structures || []).length) {
          rows.push(['  draws', b.structures.map((id) => structureName(id)).join(', '), '']);
        }
        if (b.mode === 'shadow') {
          rows.push(['  mode', 'shadow — recorded, not applied', 'dim']);
        }
      }
    }
    if (mo.origin === 'third-party') {
      rows.push(['  source', `third-party${mo.license ? ' · ' + mo.license : ''}`, 'dim']);
    }
  });
  // The intensity calibration, which on a TF3 job is the largest single thing done to
  // the upload before the network sees it. CBCT grey values are not Hounsfield units
  // and this model was trained on data that is, so a scan seen through the wrong clip
  // window fails in ways that look like anatomy. Absent on every pre-0.11 job.
  const ints = r.intensity;
  if (ints) {
    const hu = (x) => (x == null ? '—' : Math.round(x) + ' HU');
    if (ints.applied) {
      rows.push(['Intensity scale', `air ${hu(ints.air)} → ${hu(ints.air_target)}`, '']);
      rows.push(['  soft tissue', `${hu(ints.soft_tissue)} → ${hu(ints.soft_tissue_target)}`, '']);
      rows.push(['  gain', `${ints.gain.toFixed(2)}×`,
        Math.abs(ints.gain - 1) > 0.5 ? 'warn' : '']);
    } else {
      rows.push(['Intensity scale', 'left uncalibrated', 'warn']);
      if (ints.reason) rows.push(['  why', ints.reason, '']);
    }
  }
  if (roi.shape) {
    rows.push(['Tooth-model ROI', roi.shape.join('×')
      + (roi.fraction_of_volume ? ` · ${(roi.fraction_of_volume * 100).toFixed(0)}% of the scan` : ''), '']);
    if (roi.toothseg_resampled) rows.push(['  resampled for it', 'yes', 'warn']);
  }
  rows.push(['Surfaces', mt.structures
    ? `${mt.structures} · ${(mt.triangles / 1e6).toFixed(2)}M tris` : '—', '']);
  if (mt.web_structures) {
    rows.push(['  browser copy', `${(mt.web_triangles / 1000).toFixed(0)}k tris · `
      + `${(mt.web_bytes / 1e6).toFixed(1)} MB`, '']);
  }
  rows.push(['RT structure set', rt.roi_count
    ? `${rt.roi_count} ROIs · ${(rt.total_points / 1000).toFixed(0)}k points`
    : (rt.error ? 'failed' : '—'), rt.error ? 'bad' : rt.roi_count ? 'ok' : '']);
  rows.push(['Display contours', ct.polygons
    ? `${(ct.polygons / 1000).toFixed(1)}k curves · ${ct.sigma_mm} mm smoothing` : '—', '']);
  if (ctDrops) {
    rows.push(['  slices below iso 0.5',
      `${ctDrops} skipped${ctRecovered ? `, ${ctRecovered} recovered at ${ct.fallback_iso}` : ''}`,
      'warn']);
  }
  if (specks) rows.push(['Specks removed', `${specks} voxels`, '']);

  // Numbering. Worth its own rows because it is the one stage that can silently
  // decline to run: a fallback here means the teeth were numbered by the plain
  // per-voxel argmax, which is what put two colours on one tooth.
  const nb = r.numbering;
  if (nb) {
    if (nb.used) {
      rows.push(['Tooth objects', `${nb.n_instances} found`
        + (nb.n_arch_split ? ` · ${nb.n_arch_split} cut across the bite` : '')
        + (nb.n_split ? ` · ${nb.n_split} split` : ''), 'ok']);
      rows.push(['  arch decided by', `${nb.arch_from_jaw_model} by the jaw model, `
        + `${nb.arch_from_tooth_model} by the tooth model`, '']);
      if (nb.n_resequenced) {
        rows.push(['  renumbered by position',
          nb.resequenced.map((e) => `${e.from}→${e.to}`).join(', '), 'warn']);
      }
      rows.push(['  voxels renumbered', String(nb.changed_voxels), '']);
    } else {
      rows.push(['Tooth objects', 'not used', 'warn']);
      rows.push(['  why', nb.fallback || 'unknown', 'warn']);
    }
  }
  if (q.occlusal_contact_mm2 != null) {
    rows.push(['Upper–lower contact', `${q.occlusal_contact_mm2.toFixed(0)} mm²`, '']);
  }
  if (q.unnumbered && q.unnumbered.tooth_grey_p95 != null) {
    rows.push(['Enamel grey p95', String(q.unnumbered.tooth_grey_p95), '']);
  }

  const numberingWhy = (nb && !nb.used)
    ? `<p class="finding-why" style="margin:.5rem 0 0">Teeth were numbered by the tooth
       model's per-voxel argmax alone. That has no notion of a tooth as an object, so a
       label can flip across the point where an upper and a lower crown touch and one
       tooth can end up carrying two numbers.</p>`
    : '';
  // The component filter's own account of what it did. Worth showing, and the
  // ABSTENTIONS especially: an abstention says the model drew a structure the training
  // distribution does not contain, which is a scan-specific quality signal, and it is
  // the difference between "the filter found nothing to remove" and "the filter
  // declined to judge". Those rendered identically before.
  const cc = (r.postprocess || {}).cc_filter || {};
  const vox = cc.voxel_mm3 || 0;
  const removedTotal = Object.values(cc.removed_voxels || {})
    .reduce((a, b) => a + Number(b), 0);
  if (cc.percentile != null) {
    rows.push(['Fragment filter', `p${cc.percentile} of the training set's own component `
      + `volumes · ${removedTotal.toLocaleString()} voxel(s) removed`
      + (vox ? ` (${(removedTotal * vox).toFixed(0)} mm³)` : ''), '']);
  }
  const abstained = cc.abstained || [];
  if (abstained.length) {
    rows.push(['  filter abstained on', `${abstained.length} structure(s)`, 'warn']);
  }
  const floorCuts = (cc.decisions || []).filter((d) => d.action === 'class_floor');
  if (floorCuts.length) {
    rows.push(['  removed as specks', `${floorCuts.length} class(es) under the `
      + `${cc.class_floor_voxels}-voxel floor`, '']);
  }

  const ccWhy = abstained.length
    ? `<p class="finding-why" style="margin:.5rem 0 0">The fragment filter's thresholds
       are the 2nd percentile of how big each structure is across 512 training
       annotations. Where this scan's largest piece of a structure is smaller than the
       smallest whole one those annotations contain, the threshold does not describe
       this case and nothing is removed &mdash; it is reported instead.
       ${esc(abstained.map((a) => a.reason).slice(0, 1).join(''))}</p>`
    : '';
  $('runBody').innerHTML = kvList(rows)
    + numberingWhy
    + ccWhy
    + (specks ? `<p class="finding-why" style="margin:.5rem 0 0">This case was processed
       by the retired island-removal pass, which kept components above 2% of the largest
       one <em>in the same class</em>. For the two unnumbered classes that floor was set
       by whatever else landed there, so their reported volume is not a stable
       measurement across cases. Current cases use the per-class fragment filter
       reported above instead.</p>` : '');
}

function renderStructures(r) {
  const v = state.viewer;
  const groups = r.structures || (state.catalog && state.catalog.groups) || [];
  const vols = (r.quality && r.quality.volumes_cm3) || {};
  const stls = (r.outputs && r.outputs.stl) || {};
  // Structures whose training annotation stops at the edge of the scan rather than at
  // anatomy. They are still shown and still exported; they must not carry a measurement.
  //
  // The flag is a property of the MODEL, not of the job, so a ToothFairy3 job whose
  // taxonomy was frozen before the flag existed still needs it — otherwise the two
  // already-published examples would never show it. It is read off the live catalog in
  // that case, and ONLY for ToothFairy3 jobs: the retired three-model stack's "Maxilla
  // & upper skull" was DentalSegmentator's cranium class, a different structure that
  // this finding says nothing about. Branch on the positive pipeline marker, never on
  // the absence of a field — a half-written report has no `pipeline` either.
  // Two positive markers, because `pipeline` postdates six of the ToothFairy3 jobs on
  // disk — including the one this project's rail fixture was lifted from. The model
  // name is recorded on every one of them and is just as positive a signal.
  const models = r.models || [];
  const isTf3 = (r.pipeline && r.pipeline.name === 'toothfairy3-umamba2')
    || (models.length > 0 && models.every((mo) => (mo.name || '').startsWith('ToothFairy3')));
  const catalogFov = new Set(
    isTf3 && state.catalog
      ? (state.catalog.groups || []).flatMap((g) => g.structures)
        .filter((x) => x.fov_limited).map((x) => x.id)
      : []);
  const fovLimited = (st) => (st.fov_limited != null ? st.fov_limited : catalogFov.has(st.id));
  let anyFovLimited = false;
  // Measured accuracy, when this job carries any. Null on every upload, and the whole
  // column is then omitted rather than rendered empty -- see the `.with-dice` note in
  // app.css for why that keeps the rail exactly as wide as it was.
  const acc = accuracyById(r);
  // Which structures a SPECIALIST drew, rather than the base model. Overrides only:
  // the base model is the default and saying so 47 times is noise.
  const prov = r.provenance || {};
  let anyProv = false;
  // The filter. 32 of the 47 structures are teeth, so an unfiltered list buries the
  // fifteen a planner actually reads -- both jaws, the four canals, the sinuses, the
  // airway -- under a full dentition. Matches the display name, the group name and the
  // FDI number, because those are the three things a reader has in mind.
  const q = ((v && v.structQuery) || '').trim().toLowerCase();
  const matches = (g, st) => !q
    || st.name.toLowerCase().includes(q)
    || g.group.toLowerCase().includes(q)
    || (st.fdi != null && String(st.fdi).includes(q))
    || st.id.toLowerCase().includes(q);
  let shown = 0, total = 0;
  const html = groups.map((g) => {
    const present = g.structures.filter((s) => vols[s.id] != null);
    total += present.length;
    const rows = present.filter((s) => matches(g, s)).map((s) => {
      shown += 1;
      const cls = ['srow'];
      if (v && v.hidden.has(s.index)) cls.push('off');
      if (v && v.isolated === s.index) cls.push('sel');
      const fov = fovLimited(s);
      if (fov) anyFovLimited = true;
      const mark = fov
        ? `<span class="fovmark" title="This structure's outline is cut by the edge of the scan, not by anatomy — do not measure from it">*</span>`
        : '';
      const by = prov[s.id];
      if (by) anyProv = true;
      const pmark = by
        ? `<span class="provmark" title="${esc(`Drawn by ${by}, not by the base model`)}">\u2022</span>`
        : '';
      const stl = stls[s.id]
        ? `<a class="stl" href="${API}/jobs/${v.jobId}/files/${stls[s.id]}" download
              title="Download ${esc(s.name)} as STL">⤓</a>` : '<span class="stl"></span>';
      const dice = acc ? diceCell(acc.get(s.id)) : '';
      return `<div class="${cls.join(' ')}" data-index="${s.index}">
        <span class="swatch" style="background:${s.color}" data-act="toggle"
              title="Show or hide ${esc(s.name)}"></span>
        <span class="name" data-act="isolate"
              title="Isolate ${esc(s.name)} and go to it">${esc(s.name)}${mark}${pmark}</span>
        <span class="vol">${vols[s.id].toFixed(2)} cm³</span>
        ${dice}
        ${stl}
      </div>`;
    }).join('');
    // The count is the group's PRESENT total, not the filtered one: a heading that
    // read "Upper teeth 2" while a filter was on would look like a case with two upper
    // teeth. It says how many the filter is showing only when it is hiding some.
    const n = present.length;
    const drawn = present.filter((s) => matches(g, s)).length;
    const count = q && drawn !== n ? `${drawn} of ${n}` : String(n);
    return rows ? `<div class="sgroup"><h4>${esc(g.group)}<span class="gcount">${count}</span></h4>
      <div class="slist${acc ? ' with-dice' : ''}">${rows}</div></div>` : '';
  }).join('');
  const el = $('structures');
  const footnote = anyFovLimited
    ? `<p class="hint fovnote">* Bounded by the edge of the scan, not by anatomy —
       these are shown and exported but must not be measured from.</p>` : '';
  const accnote = acc
    ? `<p class="hint fovnote">Dice is measured against this case's expert annotation,
       per structure. Hover for the millimetre figures. A structure the model missed
       entirely has no volume and so has no row here &mdash; those are named in the
       Measured accuracy panel.</p>` : '';
  const provnote = anyProv
    ? `<p class="hint fovnote">\u2022 Drawn by a specialist model rather than the base
       one &mdash; hover for which. Everything unmarked came from
       ${esc((models[0] || {}).name || 'the base model')}.</p>` : '';
  // A filter that hides rows says so. A list that silently omits the structure the
  // reader is hunting for reads as a structure the model missed, which is the one
  // wrong conclusion this panel must never invite.
  const filternote = q && shown < total
    ? `<p class="strempty">${shown} of ${total} shown &mdash;
       <button class="link" id="structFilterClear" type="button">clear the filter</button></p>`
    : '';
  el.innerHTML = q && shown === 0
    ? `<p class="strempty">Nothing matches &ldquo;${esc(q)}&rdquo;.
       <button class="link" id="structFilterClear" type="button">Clear the filter</button></p>`
    : ((html + filternote + footnote + accnote + provnote)
       || '<p class="empty">No structures found.</p>');
  const clr = $('structFilterClear');
  if (clr) clr.onclick = () => {
    state.viewer.structQuery = '';
    $('structFilter').value = '';
    renderStructures(r);
  };

  // The row used to do exactly one thing -- toggle visibility -- so a reader who
  // clicked "Mandibular canal" expecting to be taken there got it switched off
  // instead. Now the swatch is the switch and the name is the navigation, which is
  // also what clicking a tooth on the chart does.
  el.querySelectorAll('.srow').forEach((row) => {
    row.onclick = (e) => {
      if (e.target.classList.contains('stl')) return;   // let the download through
      const idx = Number(row.dataset.index);
      if (e.target.dataset.act === 'isolate') { toggleIsolate(idx); return; }
      const h = state.viewer.hidden;
      if (h.has(idx)) { h.delete(idx); row.classList.remove('off'); }
      else { h.add(idx); row.classList.add('off'); }
      state.viewer.isolated = null;
      $('isolateClear').hidden = true;
      pushVisibility([idx]);
      renderArch(state.viewer.report);
    };
  });
  $('toggleAll').onclick = () => {
    const all = [...presentIndices()];
    const hideAll = state.viewer.hidden.size === 0;
    state.viewer.hidden = hideAll ? new Set(all) : new Set();
    state.viewer.isolated = null;
    $('toggleAll').textContent = hideAll ? 'show all' : 'hide all';
    $('isolateClear').hidden = true;
    pushVisibility(all);
    renderStructures(r);
    renderArch(r);
  };
  $('isolateClear').onclick = () => {
    if (state.viewer.isolated != null) toggleIsolate(state.viewer.isolated);
  };
}

/** One structure's Dice cell.
 *
 * No absolute colour band. These structures span 185 voxels (an incisive canal) to
 * 1.5 M (a mandible), and a fixed threshold would paint a 1 mm nerve red for a
 * one-voxel wall shift while passing a molar at 0.90. Only two things are coloured,
 * and both are categorical rather than a judgement about a number: a structure the
 * annotation does not contain at all, and a very low score that deserves a second look.
 */
function diceCell(a) {
  if (!a) return '<span class="dice" title="not part of the scored comparison">\u2014</span>';
  const mm = (x) => (x == null || !isFinite(x)) ? '\u2014' : x.toFixed(2) + ' mm';
  if (a.status === 'spurious') {
    return `<span class="dice bad" title="The expert annotation has no ${esc(a.name || a.id)} on this scan — every voxel of it is a false positive">0.00</span>`;
  }
  // Normally unreachable: a missed structure has no volume, so renderStructures never
  // gives it a row and only the card can name it. It is handled anyway because the
  // rail must never present a total miss as a merely-low score.
  if (a.status === 'missed') {
    return `<span class="dice bad" title="The annotation has a ${esc(a.name || a.id)} on this scan and the model found none of it">0.00</span>`;
  }
  if (a.dice == null) return '<span class="dice" title="not scored on this case">\u2014</span>';
  const cls = a.dice < 0.5 ? ' warn' : '';
  const title = `Dice ${a.dice.toFixed(4)} · HD95 ${mm(a.hd95)} · surface within tolerance ${a.nsd == null ? '—' : a.nsd.toFixed(3)}`
    + ` · inward p95 ${mm(a.inward_p95)} (worst ${mm(a.inward_max)}) · outward p95 ${mm(a.outward_p95)}`;
  return `<span class="dice${cls}" title="${esc(title)}">${a.dice.toFixed(2)}</span>`;
}

function renderDownloads(jobId, r) {
  const files = `${API}/jobs/${jobId}/files`;
  const rt = r.rtstruct || {};
  const mesh = (r.meshes || {}).totals || {};
  const items = [
    ['segmentation.nii.gz', 'Label map (NIfTI)',
     'The exact model output, on the grid you uploaded. Use this for anything measured.',
     `${files}/segmentation.nii.gz`],
  ];
  if (rt.file && !rt.error) {
    items.push([
      rt.derived_series ? 'rtstruct.zip' : 'RS.dcm',
      'RT structure set' + (rt.derived_series ? ' + derived CT' : ''),
      rt.derived_series
        ? 'The upload was not DICOM, so there was no series to reference. Import BOTH the '
          + 'CT folder and RS.dcm — the structure set alone will not load.'
        : 'References your uploaded series directly.',
      `${files}/${rt.file}`,
    ]);
  }
  items.push(['report.json', 'Full report',
    'Every measurement on this page, plus timings and VRAM.', `${files}/report.json`]);

  $('downloads').innerHTML = items.map(([name, title, note, href]) => `
    <a href="${href}" download>
      <b>${esc(title)}</b><em>${esc(name)}</em><span>${esc(note)}</span>
    </a>`).join('')
    + (mesh.structures ? `<p class="hint" style="margin:.2rem 0 0">
        Per-structure STL: hover a structure above and click ⤓
        (${mesh.structures} meshes, smoothed and decimated).</p>` : '');
}

/* The implant-planning views.
 *
 * Two pictures, both rendered server-side from the FULL-RESOLUTION grid and both
 * publishing an exact `pixel_mm`: a panoramic reconstruction swept along the fitted
 * arch, and the buccolingual cross-section perpendicular to it at one arc position.
 *
 * They are not drawn from `volume/image.raw`. That volume is 8-bit, pre-windowed and
 * downsampled to about 0.66 mm -- a display object, as three separate places in this
 * app already say. A cross-section resampled from it would look convincing and would
 * not be measurable, and a ruler on it would disagree with the server about the same
 * gap. Which is also why the Cornerstone LengthTool sitting unused in the bundle
 * stays unused: it binds to the panes showing that volume.
 */
function planState() {
  const v = state.viewer;
  if (!v) return null;
  // `arch: null` until `loadArch()` resolves, and the plan tab is reachable before then
  // -- `setMode('plan')` starts the fetch and returns. So every consumer treats a null
  // arch as "no jaws yet" rather than dereferencing it.
  v.plan = v.plan || { jaw: 'mandible', index: null, indexJaw: null, arch: null, img: null };
  return v.plan;
}

function archUrl() {
  const v = state.viewer;
  return `${API}/jobs/${v.jobId}/files/planning/arch.json`;
}

function xsUrl(jaw, i) {
  const v = state.viewer;
  return `${API}/jobs/${v.jobId}/files/planning/xs/${jaw}/${String(i).padStart(4, '0')}.jpg`;
}

function panUrl(jaw) {
  const v = state.viewer;
  return `${API}/jobs/${v.jobId}/files/planning/pan/${jaw}.jpg`;
}

/** Backing-store multiple for the two plan canvases.
 *
 *  Same argument as the retired Slices tab's 2x render scale, never applied here: the
 *  server JPEG is 480 px across, the pane is 270-370 CSS px, and on a DPR-2 display
 *  that is 540-740 device pixels. Drawing the implant outline, the rulers and the arc
 *  marker into a 480 px buffer threw away half the resolution of the one surface the
 *  reader angles an implant on.
 *
 *  Load-bearing invariant: the canvas COORDINATE SYSTEM stays in image pixels. Every
 *  geometry consumer here -- `xsFrame`'s `colPitch`/`rowPitch`, `drawImplants`,
 *  `drawRulers`, `drawArcMarkerOn`, `jumpToArcColumn` -- speaks image pixels against a
 *  published `pixel_mm`, and re-deriving all of them in device pixels would be six
 *  chances to put an implant in the wrong place. So the buffer grows and a single
 *  `setTransform` scales into it; `canvasPoint` divides back out. Two conversions, both
 *  in this file, both proven by `check-rail.mjs --selftest`.
 */
const XS_RENDER_SCALE = 2;

/** Size a plan canvas for `img` and hand back a context in IMAGE pixels. */
/* ------------------------------------------------------------- the section crop
 * A buccolingual section is 36.1 x 68.1 mm -- aspect 0.53 -- so `object-fit: contain`
 * fits it BY HEIGHT and every extra pixel of width becomes black bar. Measured live:
 * collapsing the left rail gave the picture column 325 more pixels and the section did
 * not grow by one. The only way width stops being slack is to change the picture's
 * ASPECT, which means showing less of the 68 mm.
 *
 * So the section is cropped in `z` only -- `t` is always the full published range,
 * because the buccal and lingual plates are what a section is FOR. One window, applied
 * as a single translation inside the transform `planCtx` already sets, so the drawing
 * coordinate system stays in image pixels and every consumer of it is unchanged.
 *
 * THE TOUCH POINTS, all of them: `planCtx` (the backing store's height and the
 * translation), `planSize` (the visible height), `canvasPoint` (add the offset back)
 * and `withScreenUnits` (same). `tzToPixel` is deliberately NOT one of them: it returns
 * image pixels and the transform does the rest, which is the whole reason the crop is a
 * translation rather than a rescale. `drawImage` is not one either, for the same reason
 * -- the image is drawn at its true size and the canvas clips it.
 */
const CROP_WINDOW_MM = 36;   // implant (<=16) + envelope + diagnostic margin, and it
                             // makes the aspect 1.00 against the 36.1 mm t-range
const CROP_PAD_MM = 6;
const CROP_MIN_MM = 30;

/* SCROLL TO ZOOM, inside the crop rather than beside it.
 *
 * A free zoom would mean a scale factor in the transform, and then `planSize`,
 * `canvasPoint`, `withScreenUnits` and `drawImage` would each need it -- a fifth
 * coordinate factor on a contract that took a round trip measured at 1.42e-14 px to
 * pin down. There is no need: what limits the section's magnification is its ASPECT,
 * `object-fit: contain` fits it by the long side, and the crop already changes the
 * aspect. Scaling the crop WINDOW is therefore a real zoom that touches no coordinate
 * code at all -- the same single translation, computed from a different span.
 *
 * The window stays anchored on the implant (or the crest), so there is no pan gesture
 * to conflict with the ruler or the drag, and it can never be scrolled to somewhere
 * with nothing in it. Zooming out far enough returns the whole section, which is the
 * same state the `Z` toggle reaches.
 */
const XS_ZOOM_MIN = 0.6;
const XS_ZOOM_MAX = 2.6;
const XS_ZOOM_STEP = 1.12;      // per wheel notch, so a notch is the same proportion

/** Rows [y0, y0+rows) of the section to show, or null for the whole picture. */
function xsCropRows(info) {
  const p = planState();
  if ((p.xsFit || xsFitPref) === 'whole') return null;
  const f = xsFrame(info);
  const nRows = info.cross_sections.size[0];
  let zHi = null; let zLo = null;
  const here = info.cross_sections.s_mm[p.index];
  // The implant on this section, if there is one. Computed from the POSE, and only
  // when the section or the selection changes -- never inside the drag loop. An
  // auto-fit recomputed per pointermove is a positive-feedback loop: the window chases
  // the implant, the implant appears to move under a stationary pointer, and the drag
  // walks away by roughly one pad per event.
  const imp = (p.implants || []).find(
    (i) => i.jaw === p.jaw && Math.abs(i.s_mm - here) <= XS_NEAR_MM);
  if (imp) {
    const zs = implantOutline(imp).map(([, z]) => z);
    zHi = Math.max(...zs) + CROP_PAD_MM;
    zLo = Math.min(...zs) - CROP_PAD_MM;
  } else {
    // Else the crest of the nearest site: the alveolar ridge is what a section that has
    // no implant on it yet is being read for.
    const sites = info.sites || {};
    let best = null;
    Object.keys(sites).forEach((k) => {
      const st = sites[k];
      if (!st || st.crest_z_mm == null || st.s_mm == null) return;
      if (!best || Math.abs(st.s_mm - here) < Math.abs(best.s_mm - here)) best = st;
    });
    if (best && Math.abs(best.s_mm - here) < 6) {
      const up = p.jaw === 'maxilla' ? CROP_WINDOW_MM - 4 : 4;
      zHi = best.crest_z_mm + up;
      zLo = zHi - CROP_WINDOW_MM;
    }
  }
  if (zHi == null) return null;
  const content = Math.max(CROP_MIN_MM, zHi - zLo);
  // A long implant at full tilt can exceed the window. Widening rather than clipping is
  // the only safe direction, and it must be visible in the readout rather than silent.
  let span = Math.max(content, CROP_WINDOW_MM);
  // The reader's zoom, applied to the window and floored at the CONTENT: scrolling in
  // must never hide the platform or the apex of the implant the window is anchored on,
  // because those are the two ends the whole verdict is about.
  span = Math.max(zHi - zLo, span * (Number(p.xsZoom) || 1));
  const mid = (zHi + zLo) / 2;
  let y0 = Math.round((f.zTop - (mid + span / 2)) / f.rowPitch);
  let rows = Math.round(span / f.rowPitch);
  rows = Math.min(rows, nRows);
  y0 = Math.max(0, Math.min(y0, nRows - rows));
  if (rows >= nRows - 2) return null;
  return { y0, rows };
}

function planCtx(cv, img, aspectX, crop) {
  // The panoramic's pixels are NOT square. It is 248 columns at 0.5 mm and 453 rows at
  // 0.150442 mm -- 124 mm of arch by 68 mm tall, a LANDSCAPE picture stored as a
  // portrait bitmap. Drawn 1:1 the whole arch is squashed by 3.324x, which is what it
  // had always been doing; nobody could see it because the panoramic was 401ing. The
  // cross-section is near-isotropic (0.150442 vs 0.150628) and passes ax = 1.
  //
  // Same remedy as the retired Slices tab's 2x render scale, same rule as the DPR scale:
  // the backing store carries the correction, the canvas COORDINATE SYSTEM stays in
  // image pixels, and the two factors are recorded on the element so `planSize` and
  // `canvasPoint` can divide them back out. Nothing downstream has to know.
  const ax = Number(aspectX) > 0 ? Number(aspectX) : (cv.dsvAx || 1);
  const sx = XS_RENDER_SCALE * ax;
  const sy = XS_RENDER_SCALE;
  const w = img ? img.naturalWidth : Math.round(cv.width / sx);
  const h = img ? img.naturalHeight : Math.round(cv.height / sy);
  // The crop, as ONE translation. `y0` is an image row; the canvas is sized to the
  // visible rows only and the transform slides the picture up by that many, so image
  // pixel (x, y) still lands where every consumer expects it and rows outside the
  // window are clipped by the canvas rather than scaled away. Recorded on the element
  // so `planSize`, `canvasPoint` and `withScreenUnits` divide it back out -- the same
  // discipline `dsvAx` already uses for the panoramic's anisotropy.
  const y0 = crop ? Math.max(0, Math.min(crop.y0, h - 1)) : 0;
  const visible = crop ? Math.max(1, Math.min(crop.rows, h - y0)) : h;
  if (cv.width !== Math.round(w * sx)) cv.width = Math.round(w * sx);
  if (cv.height !== Math.round(visible * sy)) cv.height = Math.round(visible * sy);
  cv.dsvAx = ax;
  cv.dsvY0 = y0;
  const g = cv.getContext('2d');
  g.setTransform(sx, 0, 0, sy, 0, -y0 * sy);
  g.imageSmoothingQuality = 'high';
  return { g, w, h, y0, visible };
}

/** A plan canvas's size in IMAGE pixels, whatever its backing store is. */
function planSize(cv) {
  const ax = cv.dsvAx || 1;
  // `h` is the VISIBLE height in image pixels, which with a crop is smaller than the
  // picture. Every caller wants the visible one: `drawArcMarkerOn` draws a full-height
  // rule, `canvasPoint` bounds a click, `drawSectionFrame` sizes the band rectangle.
  return { w: cv.width / (XS_RENDER_SCALE * ax), h: cv.height / XS_RENDER_SCALE,
           y0: cv.dsvY0 || 0 };
}

/** The aspect correction a jaw's panoramic needs: column pitch over row pitch. */
function panAspectX(info) {
  const mm = (info && info.panoramic && info.panoramic.pixel_mm) || null;
  if (!mm || !mm[0] || !mm[1]) return 1;
  return mm[1] / mm[0];
}

/** Pointer event -> position in a canvas's OWN pixels, honouring `object-fit`.
 *
 * `.pan-wrap canvas` and `.xs-wrap canvas` are `max-width:100%; max-height:100%;
 * object-fit: contain` (app.css), so whenever the picture's aspect ratio differs
 * from its box the image is letterboxed inside it. Measuring against the element's
 * bounding rect -- which the arc-jump handler did until 2026-09-01 -- then lands on
 * the wrong column by however wide the bars are.
 *
 * Every pointer interaction on these two canvases goes through here: the arc jump,
 * the ruler and the implant drag. One mapping, one place to be wrong.
 *
 * Returns null for a click on the letterbox itself rather than clamping, because a
 * measurement started outside the image is not a measurement.
 */
function canvasPoint(cv, ev) {
  const r = cv.getBoundingClientRect();
  if (!cv.width || !cv.height || !r.width || !r.height) return null;
  // In IMAGE pixels, not backing-store pixels -- see `XS_RENDER_SCALE`. `object-fit`
  // letterboxes against the backing store's aspect ratio, which the scale does not
  // change, so the fit maths is unaffected and only the returned units differ.
  // `object-fit: contain` letterboxes the BACKING STORE, so the fit is computed against
  // cv.width/cv.height; the result is then divided back into image pixels by the two
  // factors `planCtx` baked in. With an anisotropic panoramic those factors differ, so
  // x and y have different millimetres per screen pixel -- which is true of the picture
  // and has to stay true of the mapping.
  const { w, h } = planSize(cv);
  const k = Math.min(r.width / cv.width, r.height / cv.height);
  const drawnW = cv.width * k;
  const drawnH = cv.height * k;
  const px = (ev.clientX - r.left - (r.width - drawnW) / 2) / k;
  const py = (ev.clientY - r.top - (r.height - drawnH) / 2) / k;
  const x = px / (XS_RENDER_SCALE * (cv.dsvAx || 1));
  const y = py / XS_RENDER_SCALE;
  if (x < 0 || y < 0 || x > w || y > h) return null;
  // ...and back into the PICTURE's rows, so a crop is invisible to every caller. Bounds
  // are checked against the visible height FIRST, above: a click on the letterbox is
  // still refused, and only a click inside the window is translated.
  const yImg = y + (cv.dsvY0 || 0);
  // `scale` is screen pixels per IMAGE pixel along y, which is the axis every metric
  // reading on these canvases uses.
  return { x, y: yImg, scale: k * XS_RENDER_SCALE };
}

async function loadArch() {
  const p = planState();
  if (!p) return;
  if (!p.arch) {
    try {
      // FRESH. The manifest is small, it is read once per case, and it is the one
      // artifact whose staleness is silently wrong rather than merely old.
      const r = await cachedFetch(archUrl(), true);
      p.arch = await r.json();
    } catch (e) {
      $('planEmpty').textContent = 'the planning views are not available for this case';
      return;
    }
  }
  // The viewer needs the PUBLISHED polyline to place an implant in 3D. Handed over by
  // reference and never re-derived: `ArchFit.normals()` picks its sign by moving away
  // from the arch centroid, and reimplementing that rule is a silent mirror waiting to
  // happen. Guarded because the plan tab can open before the volume has mounted --
  // `setImplantArch` is safe either way, and `setImplants` stashes until mount.
  if (window.DentistryViewer && DentistryViewer.setImplantArch) {
    DentistryViewer.setImplantArch(p.arch);
  }
  const jaws = (p.arch && p.arch.jaws) || {};
  // A jaw whose arch fit refused has no pictures. Say which, rather than showing an
  // empty canvas -- a refusal is information, and the reason is worth reading.
  document.querySelectorAll('#planJawTabs .plane').forEach((b) => {
    const info = jaws[b.dataset.jaw];
    b.disabled = !(info && info.ok);
    b.title = (info && info.ok) ? '' : ((info && info.reason) || 'not reconstructed');
  });
  if (!(jaws[p.jaw] && jaws[p.jaw].ok)) {
    const first = Object.keys(jaws).find((j) => jaws[j] && jaws[j].ok);
    if (!first) {
      $('planEmpty').textContent = (jaws[p.jaw] && jaws[p.jaw].reason)
        || 'no arch could be fitted to this scan';
      return;
    }
    p.jaw = first;
  }
  selectJaw(p.jaw);
}

/** The section this jaw should open on.
 *
 *  A site that publishes a crest height is a site an implant could go in, so the first
 *  one of those is the most useful thing to be looking at. Falling back to mid-arch
 *  rather than to index 0, because both ends of the list are ramus.
 */
function openingIndex(info) {
  const sites = info.sites || {};
  const wanted = Object.keys(sites)
    .filter((k) => sites[k] && sites[k].height_mm != null && sites[k].s_mm != null)
    .map((k) => sites[k].s_mm)
    .sort((x, y) => Math.abs(x) - Math.abs(y));
  if (wanted.length) return nearestXsIndex(info, wanted[0]);
  return Math.floor((info.cross_sections.count - 1) / 2);
}

function selectJaw(jaw) {
  const p = planState();
  const info = ((p.arch || {}).jaws || {})[jaw];
  if (!info || !info.ok) return;
  p.jaw = jaw;
  document.querySelectorAll('#planJawTabs .plane').forEach(
    (b) => b.classList.toggle('on', b.dataset.jaw === jaw));
  const n = info.cross_sections.count;
  const sl = $('xsSlider');
  sl.min = 0; sl.max = Math.max(0, n - 1);
  // Where the tab OPENS. `p.index` was seeded 0 and clamped, so on a real case the plan
  // tab opened on cross-section 1 of 248 -- the extreme distal end of the ramus, with no
  // alveolar crest anywhere in the picture. Every pixel this block wins for the section
  // was being spent on the wrong anatomy.
  if (p.index == null || p.jaw !== p.indexJaw) p.index = openingIndex(info);
  p.indexJaw = p.jaw;
  p.index = Math.max(0, Math.min(p.index, n - 1));
  sl.value = p.index;
  $('planArcHint').textContent =
    `${info.arc_length_mm.toFixed(0)} mm of arch · ${n} cross-sections`;
  drawPanoramic();
  loadXsContours();
  selectXs(p.index);
}

async function drawPanoramic() {
  const p = planState();
  const cv = $('panCanvas');
  const url = panUrl(p.jaw);
  try {
    const img = await loadAuthedImage(url);
    // A jaw switch in flight while this awaited: the bytes that just arrived are for
    // the previous jaw, and painting them would label the wrong side of the mouth.
    if (panUrl(p.jaw) !== url) { revokeImage(img); return; }
    revokeImage(p.panImage);
    const info = ((p.arch || {}).jaws || {})[p.jaw];
    const ax = panAspectX(info);
    const { g, w, h } = planCtx(cv, img, ax);
    g.drawImage(img, 0, 0, w, h);
    p.panImage = img;
    // The pane takes the picture's shape, so it has no black bars to waste. In REAL
    // proportions -- columns are 0.5 mm and rows 0.150442 mm, so the displayed
    // width:height is (w * ax) : h, not w : h.
    const stage = $('planStage');
    if (stage && h > 0) stage.style.setProperty('--pan-aspect', String((w * ax) / h));
    $('planEmpty').hidden = true;
    drawRulers('pan');
  } catch (e) {
    revokeImage(p.panImage);
    p.panImage = null;
    const { g, w, h } = planCtx(cv, null);
    g.clearRect(0, 0, w, h);
    $('planEmpty').hidden = false;
    $('planEmpty').textContent = 'the panoramic could not be loaded (' + e.message + ')';
  }
}

/* Where along the panoramic the current cross-section sits. One vertical rule, drawn
 * over a redraw of the picture rather than by saving and restoring pixels -- the
 * image is already in the browser cache, so a redraw costs nothing and cannot leave
 * a smear behind. */
/** Repaint the panoramic: image, arc marker, then any rulers on it. */
function drawArcMarker() {
  drawRulers('pan');
}

/** The section's caption, the slice label and the slider position.
 *
 *  Extracted from `selectXs` so a view change that does not change WHICH section is in
 *  view -- the crop window, the zoom, the whole/site toggle -- can repaint and relabel
 *  without re-fetching the picture. `selectXs` reloads through `loadAuthedImage`, which
 *  is a Cache Storage read, a blob URL and an image decode; at wheel rate that is a
 *  stutter and a lot of garbage for a caption that already has its bytes on screen. */
function renderXsMeta(info) {
  const p = planState();
  const s = info.cross_sections.s_mm[p.index];
  const px = info.cross_sections.pixel_mm[0];
  // The side is named from the sign of s, which the arch fit defines as negative to
  // the patient's RIGHT. Naming it here rather than in the picture keeps the one
  // laterality convention in one place.
  const side = s < 0 ? 'right' : 'left';
  // Four decimals, not two: the pitch is 0.1506 mm, and rounding it to 0.15 in the copy
  // beside a ruler that uses the real value invites somebody to "correct" the ruler.
  $('xsMeta').textContent =
    `${Math.abs(s).toFixed(1)} mm ${side} of the midline · ${px.toFixed(4)} mm per pixel`
    + ' · plane perpendicular to the arch'
    // The slab thickness, and whether the picture is cropped. At 10-14 px/mm a reader
    // starts treating the greyscale as fine detail when it is still a 1 mm AVERAGE, and
    // a cropped picture that does not say so is a picture of somewhere smaller.
    + ` · ${info.cross_sections.slab_mm || 1} mm slab`
    + (() => {
      // The window in MILLIMETRES, not just "cropped": with a zoom the crop is no
      // longer one fixed 36 mm, and a reader has to be able to tell 22 mm of ridge
      // from 44 mm of it or the greyscale is a picture of an unknown extent.
      const c = xsCropRows(info);
      if (!c) return '';
      const f = xsFrame(info);
      return ' · ' + (c.rows * f.rowPitch).toFixed(0) + ' mm of z, at the site';
    })();
  $('xsLabel').textContent = `cross-section ${p.index + 1} of ${info.cross_sections.count}`;
  $('xsSlider').value = p.index;
}

function selectXs(i) {
  const p = planState();
  const info = ((p.arch || {}).jaws || {})[p.jaw];
  if (!info || !info.ok) return;
  p.index = Math.max(0, Math.min(i, info.cross_sections.count - 1));
  const cv = $('xsCanvas');
  // Sequence the loads: the slider and the arrow keys can outrun the network, and a
  // late arrival must not repaint over a newer section while `#xsMeta` names the newer
  // one. Compared by identity, not by index, so a jaw switch counts as a change too.
  const want = xsUrl(p.jaw, p.index);
  p.xsWant = want;
  // The `.catch` below belongs to the LOAD and to nothing else. It used to be chained
  // after the `.then`, so a throw from `planCtx`/`drawImage`/`drawRulers` -- i.e. from
  // the paint -- landed in the load-failure handler and was reported to the user as
  // "this cross-section could not be loaded", then thrown again as an unhandled
  // rejection that no gate watched. Measured: `check-rail` printed ALL PASS with a
  // deliberate throw wired into `drawImplants` at every one of its states. Catching on
  // `loadAuthedImage` itself means a paint bug surfaces AS a paint bug.
  loadAuthedImage(want).catch((e) => {
    if (p.xsWant !== want) return null;
    // Never leave the previous section's pixels under a readout that has already
    // moved on -- that is a picture of one place labelled as another.
    revokeImage(p.xsImage);
    p.xsImage = null;
    const { g, w, h } = planCtx(cv, null);
    g.clearRect(0, 0, w, h);
    $('xsEmpty').hidden = false;
    $('xsEmpty').textContent = 'this cross-section could not be loaded (' + e.message + ')';
    drawRulers('xs');
    return null;
  }).then((img) => {
    if (!img || p.xsWant !== want) { revokeImage(img); return; }
    revokeImage(p.xsImage);
    p.xsImage = img;
    const { g, w, h } = planCtx(cv, img, 1, xsCropRows(info));
    g.drawImage(img, 0, 0, w, h);
    $('xsEmpty').hidden = true;
    drawRulers('xs');
  });
  renderXsMeta(info);
  drawArcMarker();
  renderRulerList();
  renderImplantPanel();
}

/* ------------------------------------------------------------------ ruler */
/* A ruler is only honest on a picture whose millimetres-per-pixel is exact, and only
 * two of this app's surfaces qualify.
 *
 * The CROSS-SECTION does. `worker/panoramic.py` builds each column as `P0 + t*n` with
 * `up = (0,0,1)`, and `n` has no z-component -- so {n, up} is an ORTHONORMAL basis and
 * the picture is a genuine isometric plane section. Pixel distance times pitch is true
 * millimetres in any direction, diagonals included.
 *
 * The PANORAMIC does not, and cannot be made to. Its horizontal axis is arc length
 * swept through a 12 mm curved trough, so a straight line between two points reads long
 * by roughly (1 + t/R) -- up to ~5% at the trough edge on a tight anterior arch. Only
 * its vertical axis is metric, so only a vertical measurement is offered there. A number
 * you can read is a number somebody will use, so the wrong one is not offered at all.
 *
 * Not the MPR panes, either: those show `worker/volume_pack.py`'s 8-bit volume,
 * downsampled to ~0.66 mm. A ruler there would disagree with the server about the same
 * gap, which is the one failure this whole surface exists to avoid. That is also why
 * the Cornerstone LengthTool stays unused.
 */
function rulerState() {
  const p = planState();
  if (!p.rulers) p.rulers = {};
  return p;
}

/** The (t, z) millimetre frame of one cross-section, straight out of arch.json v2. */
function xsFrame(info) {
  const xs = info.cross_sections;
  return {
    rowPitch: xs.pixel_mm[0],
    colPitch: xs.pixel_mm[1],
    zTop: xs.z_top_mm,
    tMin: (xs.t_range_mm || [-xs.half_width_mm, xs.half_width_mm])[0],
  };
}

/** Cross-section pixel -> the arch-frame (t, z) pair, in millimetres. */
function xsPixelToTZ(info, row, col) {
  const f = xsFrame(info);
  return { t_mm: f.tMin + col * f.colPitch, z_mm: f.zTop - row * f.rowPitch };
}

/** Cross-section pixel -> patient LPS millimetres. Exact; see the block comment. */
function xsPixelToLps(info, i, row, col) {
  const k = info.cross_sections.source_indices[i];
  const P0 = info.points[k];
  const n = info.normals[k];
  const { t_mm, z_mm } = xsPixelToTZ(info, row, col);
  return [P0[0] + t_mm * n[0], P0[1] + t_mm * n[1], z_mm];
}

/** Panoramic pixel -> LPS. The column IS a polyline index; only the row is metric. */
function panPixelToLps(info, row, col) {
  const k = Math.max(0, Math.min(Math.round(col), info.points.length - 1));
  const P0 = info.points[k];
  const pitch = info.panoramic.pixel_mm[0];
  return [P0[0], P0[1], info.panoramic.z_top_mm - row * pitch];
}

/** Where this canvas's rulers live. Per cross-section: a measurement that follows you
 *  to a different slice is measuring something you cannot see. */
function rulerKey(which) {
  const p = planState();
  return which === 'pan' ? `pan:${p.jaw}` : `xs:${p.jaw}:${p.index}`;
}

function rulerLabel(r, info, which) {
  const f = xsFrame(info);
  if (which === 'pan') {
    const mm = Math.abs(r.b.y - r.a.y) * info.panoramic.pixel_mm[0];
    return `${mm.toFixed(2)} mm vertical`;
  }
  const dt = (r.b.x - r.a.x) * f.colPitch;
  const dz = (r.b.y - r.a.y) * f.rowPitch;
  return `${Math.hypot(dt, dz).toFixed(2)} mm`;
}

function drawRulers(which) {
  const p = rulerState();
  const info = ((p.arch || {}).jaws || {})[p.jaw];
  if (!info || !info.ok) return;
  const cv = $(which === 'pan' ? 'panCanvas' : 'xsCanvas');
  const img = which === 'pan' ? p.panImage : p.xsImage;
  const { g, w, h } = planCtx(cv, isDrawable(img) ? img : null,
                              which === 'pan' ? panAspectX(info) : 1,
                              which === 'xs' ? xsCropRows(info) : null);
  g.clearRect(0, 0, w, h);
  if (isDrawable(img)) {
    // The brightness/contrast preference, on the PICTURE and on nothing else. Set
    // around `drawImage` and cleared immediately, so every overlay below -- outlines,
    // implant, envelope rings, chips, scale bar -- is drawn at full strength on top.
    const filt = picFilter();
    if (filt !== 'none' && 'filter' in g) g.filter = filt;
    g.drawImage(img, 0, 0, w, h);
    if ('filter' in g) g.filter = 'none';
  }
  if (which === 'pan') { drawArcMarkerOn(g, info, cv); drawPanImplants(g, cv, info); }

  if (which === 'xs') {
    // Anatomy first, then the implant on top of it: the implant is the thing being
    // positioned and must never be the thing that is occluded.
    drawXsContours(g, info);
    drawImplants(g, info);
    drawDistances(g, cv, info);
    drawSectionFrame(g, cv, info);
    syncImplants3d();
  }
  const list = p.rulers[rulerKey(which)] || [];
  const live = p.dragging && p.dragging.which === which ? [p.dragging] : [];
  [...list, ...live].forEach((r, i) => {
    const vertical = which === 'pan';
    const ax = r.a.x;
    const bx = vertical ? r.a.x : r.b.x;
    g.save();
    g.strokeStyle = '#38bdf8'; g.fillStyle = '#38bdf8';
    g.lineWidth = 1.5; g.setLineDash(r === p.dragging ? [4, 3] : []);
    g.beginPath(); g.moveTo(ax, r.a.y); g.lineTo(bx, r.b.y); g.stroke();
    g.setLineDash([]);
    g.restore();
    // Round dots, not ellipses. Drawn in image pixels under the panoramic's anisotropic
    // transform they came out 3.3x wider than tall.
    withScreenUnits(g, cv, (px) => {
      g.fillStyle = '#38bdf8';
      [[ax, r.a.y], [bx, r.b.y]].forEach(([x, y]) => {
        const [sx, sy] = px(x, y);
        g.beginPath(); g.arc(sx, sy, 3.5, 0, Math.PI * 2); g.fill();
      });
    });
    g.save();
    g.restore();
    const text = rulerLabel({ a: { x: ax, y: r.a.y }, b: { x: bx, y: r.b.y } }, info, which);
    const mx = (ax + bx) / 2; const my = (r.a.y + r.b.y) / 2;
    // In SCREEN units. Drawn under `planCtx`'s transform the glyphs were stretched
    // 3.3x on the panoramic and their on-screen size floated between ~11 and ~20 CSS px
    // depending on which canvas they landed on.
    withScreenUnits(g, cv, (px) => {
      const [sx, sy] = px(mx + 6, my);
      drawChip(g, cv, sx, sy, text, { size: 12, fg: '#e6f6ff' });
    });
  });
}

/* -------------------------------------------------------------- glyphs and chips
 * Every decoration in this file used to be drawn in IMAGE pixels, under the transform
 * `planCtx` sets. Two consequences, both measured:
 *
 *  - on the PANORAMIC that transform is anisotropic (sx = 2 * 3.324, sy = 2), so every
 *    endpoint dot rendered as an ellipse 3.3x wider than tall, every glyph was stretched
 *    3.3x, and `lineWidth` was direction-dependent;
 *  - the font was 13 IMAGE pixels, so its ON-SCREEN size floated with the picture --
 *    about 20 CSS px on the 240-wide section and about 11 on the panoramic.
 *
 * `withScreenUnits` runs a block under the identity transform, so a millimetre of text
 * is a millimetre of text. Geometry stays in image pixels; only the ink changes units.
 */
function withScreenUnits(g, cv, fn) {
  const ax = cv.dsvAx || 1;
  g.save();
  g.setTransform(1, 0, 0, 1, 0, 0);
  // Image pixel -> backing-store pixel, so a caller can place a glyph at a geometric
  // point without re-deriving the transform.
  const y0 = cv.dsvY0 || 0;
  fn((x, y) => [x * XS_RENDER_SCALE * ax, (y - y0) * XS_RENDER_SCALE]);
  g.restore();
}

/** A label chip, clamped inside the canvas.
 *
 *  The ruler chips were never clamped: `fillRect(mx + 8, my - 16, w, 20)` runs straight
 *  off the right edge for anything near the last column, and off the top for anything
 *  in the first 16 rows. With three distance chips competing for a 240 px picture that
 *  stops being an edge case. */
function drawChip(g, cv, x, y, text, opts) {
  const o = opts || {};
  g.font = `600 ${o.size || 12}px ui-monospace, ui-sans-serif, monospace`;
  const tw = g.measureText(text).width;
  const w = tw + 10; const h = (o.size || 12) + 8;
  let cx = Math.min(Math.max(2, x), cv.width - w - 2);
  let cy = Math.min(Math.max(2, y - h), cv.height - h - 2);
  if (!Number.isFinite(cx)) cx = 2;
  if (!Number.isFinite(cy)) cy = 2;
  g.fillStyle = o.bg || 'rgba(8,12,20,.86)';
  g.fillRect(cx, cy, w, h);
  if (o.edge) { g.strokeStyle = o.edge; g.lineWidth = 1; g.strokeRect(cx + .5, cy + .5, w - 1, h - 1); }
  g.fillStyle = o.fg || '#e6f6ff';
  g.fillText(text, cx + 5, cy + h - 6);
  return { x: cx, y: cy, w, h };
}

/* ------------------------------------------------- distances on the cross-section
 * "Print the distance for the segmented parts" -- drawn where the direction is KNOWN,
 * and only there.
 *
 * The direction comes from `approach_direction`, which the server already computes and
 * already publishes as a word. The words that lie in the section plane -- buccal,
 * lingual, apical, coronal and their pairs -- are drawn as a leader of the published
 * length from the implant surface. `mesial` and `distal` are ALONG the arch: they are
 * out of this plane by construction, and a line drawn for them would be a projection
 * whose length is not the number beside it. Those get an edge marker and the word.
 *
 * No new server field, no descent on a distance field, no new failure mode: the number
 * on the chip is the number the panel shows, and the line is only ever drawn when its
 * length IS that number.
 */
const APPROACH_TZ = {
  buccal: [1, 0], lingual: [-1, 0], apical: [0, 1], coronal: [0, -1],
};

/** Unit (t, z) for an approach word, in the implant's own frame; null if out of plane. */
function approachVector(word, imp) {
  if (!word) return null;
  const parts = String(word).split(/\s+and\s+|\s+/).filter((w) => APPROACH_TZ[w]);
  if (!parts.length) return null;
  // "between apical and lingual" is the sum of its two unit directions.
  let a = 0; let b = 0;
  parts.forEach((w) => { a += APPROACH_TZ[w][0]; b += APPROACH_TZ[w][1]; });
  const n = Math.hypot(a, b);
  if (!n) return null;
  // Apical/coronal are along the implant AXIS, buccal/lingual across it, so the word is
  // resolved in the implant's frame and then rotated into the section's.
  const down = imp.jaw === 'maxilla' ? 1 : -1;
  const sa = Math.sin(imp.tilt_deg * Math.PI / 180);
  const sb = down * Math.cos(imp.tilt_deg * Math.PI / 180);
  const across = a / n; const along = b / n;
  return [across * -sb + along * sa, across * sa + along * sb];
}

/** Draw the clearances for the selected implant on the section. */
function drawDistances(g, cv, info) {
  const p = implantState();
  // NEVER while a measurement is in flight. The panel blanks its numbers during a drag
  // for exactly this reason: `p.measured` still holds the PREVIOUS pose's answer, and a
  // crisp two-decimal chip anchored to the implant's new position would assert a
  // distance nobody computed.
  if (p.measuring || !p.selected) return;
  const imp = p.implants.find((i) => i.id === p.selected);
  if (!imp || imp.jaw !== p.jaw) return;
  const here = info.cross_sections.s_mm[p.index];
  if (Math.abs(imp.s_mm - here) > XS_NEAR_MM) return;
  const m = p.measured[imp.id] || {};
  const f = xsFrame(info);
  const { a: sa, b: sb, fore, yawed } = sectionAxis(imp);
  const r = imp.diameter_mm / 2;

  const rows = [
    ['clearance', 'verdict', 'canal', m.approach],
    ['accessory_canal', 'accessory_canal_verdict', 'incisive', null],
    ['tooth', 'tooth_verdict', 'tooth', null],
  ];
  const chips = [];
  rows.forEach(([mk, vk, label]) => {
    const mm = m[mk]; const v = m[vk] || (mk === 'clearance' ? m.verdict : null);
    if (!mm || !v || !v.level) return;
    const val = mm.value;
    const bound = ((v.numbers || {}).at_least_mm);
    if (val == null && bound == null) return;
    const u = Number((mm.detail || {}).at_depth_mm || 0);
    // The implant-side end: on the AXIS at the argmin depth, pushed out to the surface.
    // `u` is a depth along the TRUE axis, so it is foreshortened onto the picture the
    // same way every other mark on the implant is.
    const base = { t: imp.t_mm + sa * u * fore, z: imp.z_mm + sb * u * fore };
    // No caliper on an out-of-plane pose. The clearance is a three-dimensional number
    // and its projection into this section is shorter, so a line drawn at the printed
    // length would measure something that is not on screen -- the same reason
    // mesial/distal never get one. The chip stays; only the line goes.
    const dir = (mk === 'clearance' && !yawed) ? approachVector(m.approach, imp) : null;
    const cue = verdictColour(v, false);
    const text = val == null ? `> ${Number(bound).toFixed(1)}` : `${val.toFixed(2)}`;
    if (dir && val != null && val > 0) {
      const from = { t: base.t + dir[0] * r, z: base.z + dir[1] * r };
      const to = { t: from.t + dir[0] * val, z: from.z + dir[1] * val };
      const a = tzToPixel(info, from.t, from.z);
      const b = tzToPixel(info, to.t, to.z);
      g.save();
      g.strokeStyle = cue; g.lineWidth = 1.2; g.setLineDash([4, 3]);
      g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.stroke();
      g.setLineDash([]);
      // Caliper jaws, so the segment reads as a measurement and not as an axis.
      const perp = [-dir[1], dir[0]];
      const jaw = 1.1 / f.colPitch;
      [[a, from], [b, to]].forEach(([q, w]) => {
        const j1 = tzToPixel(info, w.t + perp[0] * 1.1, w.z + perp[1] * 1.1);
        const j2 = tzToPixel(info, w.t - perp[0] * 1.1, w.z - perp[1] * 1.1);
        g.beginPath(); g.moveTo(j1.x, j1.y); g.lineTo(j2.x, j2.y); g.stroke();
        return jaw;
      });
      g.restore();
      chips.push([(a.x + b.x) / 2, (a.y + b.y) / 2, `${text} ${label}`, cue, true]);
    } else {
      // Direction unknown or out of the section plane. The NUMBER is still true; a line
      // would not be, so there is none -- and the chip says so with a mark rather than
      // with a sentence. "direction not in this plane" measured 230 px on a 366 px
      // picture, which is more ink than the number saves; the words are in the panel
      // and on the printed sheet, where there is room for them.
      const a = tzToPixel(info, base.t + (imp.t_mm >= 0 ? r : -r), base.z);
      chips.push([a.x, a.y, `${text} ${label} \u2197`, cue, false]);
    }
  });
  if (!chips.length) return;
  withScreenUnits(g, cv, (px) => {
    // Stacked downward from each anchor, so three chips on a 240 px picture do not
    // land on top of one another. `drawChip` clamps each to the canvas.
    const used = [];
    chips.forEach(([x, y, text, cue, anchored]) => {
      const [sx, sy] = px(x + 6, y);
      let ty = sy;
      for (let k = 0; k < 12 && used.some((u) => Math.abs(u - ty) < 22); k++) ty += 22;
      used.push(ty);
      const box = drawChip(g, cv, sx, ty, text, { size: 12, edge: cue, fg: '#eef4ff' });
      // A hairline back to where the number belongs, for the ones with no leader: the
      // chip has been pushed off its anchor by the stacking, and a floating number
      // beside an implant would otherwise look like it names the nearest thing to it.
      if (!anchored) {
        const [ax0, ay0] = px(x, y);
        g.strokeStyle = cue; g.globalAlpha = .5; g.lineWidth = 1;
        g.beginPath(); g.moveTo(ax0, ay0); g.lineTo(box.x, box.y + box.h / 2); g.stroke();
        g.globalAlpha = 1;
      }
    });
  });
}

/** The measurable band, and the scale. Both are statements about the PICTURE. */
function drawSectionFrame(g, cv, info) {
  const p = planState();
  const f = xsFrame(info);
  const band = ((p.measured || {}).__band) || null;
  // The band the measurement pack covers: t in [-12, +12], z over the lattice. Outside
  // it the picture is visible but UNMEASURED, and nothing on screen said so. Published
  // per case in the pack header; the fallback is the documented default.
  const t0 = (band && band.t0) != null ? band.t0 : -12;
  const t1 = (band && band.t1) != null ? band.t1 : 12;
  const a = tzToPixel(info, t0, f.zTop);
  const b = tzToPixel(info, t1, f.zTop - (info.cross_sections.size[0] - 1) * f.rowPitch);
  g.save();
  g.strokeStyle = 'rgba(148,163,184,.30)';
  g.lineWidth = 1; g.setLineDash([3, 5]);
  g.strokeRect(Math.min(a.x, b.x), 0, Math.abs(b.x - a.x), planSize(cv).h);
  g.restore();

  withScreenUnits(g, cv, (px) => {
    // A 10 mm bar: the largest round length under 40% of the 36.1 mm picture width.
    const mmBar = 10;
    const x0 = px(4, 0)[0]; const y0 = cv.height - 14;
    const len = (mmBar / f.colPitch) * XS_RENDER_SCALE * (cv.dsvAx || 1);
    g.strokeStyle = 'rgba(230,246,255,.85)'; g.lineWidth = 2;
    g.beginPath();
    g.moveTo(x0, y0); g.lineTo(x0 + len, y0);
    g.moveTo(x0, y0 - 3); g.lineTo(x0, y0 + 3);
    g.moveTo(x0 + len, y0 - 3); g.lineTo(x0 + len, y0 + 3);
    g.stroke();
    g.font = '600 11px ui-monospace, monospace';
    g.fillStyle = 'rgba(230,246,255,.85)';
    g.fillText(`${mmBar} mm`, x0 + len + 6, y0 + 4);
    // Which way is buccal. A buccolingual section with no orientation letters is
    // ambiguous, and the manifest publishes `t_axis: "buccal_positive"`.
    const buccalRight = (info.cross_sections.t_axis || 'buccal_positive') === 'buccal_positive';
    g.font = '600 12px ui-sans-serif, sans-serif';
    g.fillStyle = 'rgba(230,246,255,.7)';
    g.fillText(buccalRight ? 'L' : 'B', 6, cv.height / 2);
    const rt = g.measureText(buccalRight ? 'B' : 'L').width;
    g.fillText(buccalRight ? 'B' : 'L', cv.width - rt - 6, cv.height / 2);
  });
}

/** The arc marker, factored out so drawRulers can repaint it without recursing. */
function drawArcMarkerOn(g, info, cv) {
  const p = planState();
  const src = info.cross_sections.source_indices[p.index];
  const x = (src / Math.max(1, info.panoramic.size[1] - 1)) * (planSize(cv).w - 1);
  g.save();
  g.strokeStyle = '#ffd23b'; g.lineWidth = 2; g.globalAlpha = 0.9;
  g.beginPath(); g.moveTo(x, 0); g.lineTo(x, planSize(cv).h); g.stroke();
  g.restore();
}

/* ------------------------------------------- the panoramic as the MESIODISTAL view
 * Two things were true at once: the panoramic strip did not show where any implant
 * was, and mesiodistal angulation was pinned to zero because no view could show it.
 * They are the same gap. The cross-section is the BUCCOLINGUAL plane -- `tilt` lives
 * there and is drawn at true angle -- and the plane `yaw` lives in is (s, z), which is
 * exactly the plane the panoramic reconstructs.
 *
 * This chart is honest in the ARCH frame, and says where it is not. Columns are
 * polyline indices at `step_mm` apiece, rows are `pixel_mm[0]` of true z, and `planCtx`
 * already folds the 3.32x pixel anisotropy into the backing store -- so a capsule drawn
 * here in `(s_mm, z_mm)` has the right angle and the right length in that frame. What it
 * is NOT is straight-line millimetres: `s` is arc length along the mid-line, so a
 * structure at buccolingual offset `t` reads long by about `1 + t/R`. That is
 * `metric_axes: "vertical_only"`, which `arch.json` already publishes, and it is
 * exactly zero at `t = 0`, which is where a seated implant starts. The authoritative
 * figure is still the three-dimensional one `/measure` returns; this is where the ANGLE
 * is set, and no millimetre is printed on this canvas.
 */

/** `(s, z)` millimetres -> panoramic image pixels. Mirrors `drawArcMarkerOn`'s column
 *  map exactly, so the section marker and an implant at the same `s` line up. */
function panPixelOf(info, cv, sMm, zMm) {
  const step = Number(info.step_mm) || 0.5;
  const s0 = Number(info.s0_index) || 0;
  const cols = Math.max(2, Number(info.panoramic.size[1]) || 2);
  const w = planSize(cv).w;
  const k = Number(sMm) / step + s0;
  return { x: (k / (cols - 1)) * (w - 1),
           y: (Number(info.panoramic.z_top_mm) - Number(zMm))
              / Number(info.panoramic.pixel_mm[0]) };
}

/** The inverse, for the drag. */
function panMmOf(info, cv, pt) {
  const step = Number(info.step_mm) || 0.5;
  const s0 = Number(info.s0_index) || 0;
  const cols = Math.max(2, Number(info.panoramic.size[1]) || 2);
  const w = planSize(cv).w;
  const k = pt.x * ((cols - 1) / Math.max(1, w - 1));
  return { s_mm: (k - s0) * step,
           z_mm: Number(info.panoramic.z_top_mm)
                 - pt.y * Number(info.panoramic.pixel_mm[0]) };
}

/** The panoramic's view of one pose: the in-plane axis unit and the foreshortening.
 *
 *  The same Minkowski argument `sectionAxis` sets out, one plane over. Dropping the
 *  `t` component of `(sin y, sin t cos y, down cos t cos y)` leaves
 *  `(sin y, down cos t cos y)`, whose norm is what this plane loses -- so here it is
 *  BUCCOLINGUAL tilt that foreshortens and yaw that is drawn at true angle, the exact
 *  mirror of the section. */
function panAxis(imp) {
  const down = imp.jaw === 'maxilla' ? 1 : -1;
  const tl = (Number(imp.tilt_deg) || 0) * Math.PI / 180;
  const yw = (Number(imp.yaw_deg) || 0) * Math.PI / 180;
  const s = Math.sin(yw);
  const z = down * Math.cos(tl) * Math.cos(yw);
  const n = Math.hypot(s, z) || 1;
  return { ds: s / n, dz: z / n, fore: n, tilted: Math.abs(tl) > 1e-9 };
}

/** The implant outline in the panoramic's own `(s, z)` millimetres. */
function panImplantOutline(imp) {
  const r = imp.diameter_mm / 2;
  const { ds, dz, fore } = panAxis(imp);
  const shoulder = (imp.length_mm - r) * fore;
  const pt = (u, w) => [imp.s_mm + ds * u - dz * w, imp.z_mm + dz * u + ds * w];
  const out = [pt(0, r), pt(shoulder, r)];
  for (let i = 1; i < 12; i += 1) {
    const th = (i / 12) * Math.PI;
    out.push(pt(shoulder + r * Math.sin(th), r * Math.cos(th)));
  }
  out.push(pt(shoulder, -r), pt(0, -r));
  return out;
}

/** Every implant of this jaw, on the panoramic. The SAME colour rule as the section:
 *  the body is titanium grey, and the only coloured mark is the collar band. */
function drawPanImplants(g, cv, info) {
  const p = implantState();
  if (!info || !info.ok || !info.panoramic) return;
  (p.implants || []).forEach((imp) => {
    if (imp.jaw !== p.jaw) return;
    const sel = p.selected === imp.id;
    const cue = verdictColour((p.measured[imp.id] || {}).verdict, p.measuring);
    const r = imp.diameter_mm / 2;
    const { ds, dz, fore } = panAxis(imp);
    const at = (u, w) => panPixelOf(info, cv,
      imp.s_mm + ds * u * fore - dz * w, imp.z_mm + dz * u * fore + ds * w);
    const poly = panImplantOutline(imp).map(([s, z]) => panPixelOf(info, cv, s, z));

    g.save();
    g.beginPath();
    poly.forEach((q, i) => (i ? g.lineTo(q.x, q.y) : g.moveTo(q.x, q.y)));
    g.closePath();
    g.fillStyle = 'rgba(199,204,212,.18)';
    g.fill();
    g.strokeStyle = IMPLANT_BODY;
    g.lineWidth = sel ? 2 : 1.2;
    g.stroke();

    // The axis, which on this canvas IS the mesiodistal angulation.
    const a0 = at(0.4, 0); const a1 = at(imp.length_mm - r * 0.4, 0);
    g.beginPath(); g.moveTo(a0.x, a0.y); g.lineTo(a1.x, a1.y);
    g.strokeStyle = 'rgba(199,204,212,.55)';
    g.lineWidth = sel ? 1 : 0.7;
    g.setLineDash([2, 3]); g.stroke(); g.setLineDash([]);

    // The collar band carries the verdict here too, so a reader glancing at the strip
    // sees WHICH implant is the problem without opening the panel.
    g.beginPath();
    [[0, r], [COLLAR_BAND_MM, r], [COLLAR_BAND_MM, -r], [0, -r]].forEach(([u, w], i) => {
      const q = at(u, w);
      return i ? g.lineTo(q.x, q.y) : g.moveTo(q.x, q.y);
    });
    g.closePath();
    g.fillStyle = cue;
    g.globalAlpha = sel ? 0.85 : 0.55;
    g.fill();
    g.globalAlpha = 1;
    g.restore();
  });
}

/** Which part of an implant a panoramic click landed on. Mirrors `hitTest`, in (s, z).
 *  `apex` is the yaw handle, `body` moves the implant along the arch. */
function panHitTest(imp, info, cv, pt) {
  const q = panMmOf(info, cv, pt);
  const { ds, dz, fore } = panAxis(imp);
  const dS = q.s_mm - imp.s_mm;
  const dZ = q.z_mm - imp.z_mm;
  const along = dS * ds + dZ * dz;
  const across = Math.abs(-dS * dz + dZ * ds);
  const len = imp.length_mm * fore;
  if (across > imp.diameter_mm / 2 + 1.0) return null;
  if (along < -1.0 || along > len + 1.0) return null;
  if (along > len - 1.4) return 'apex';
  return 'body';
}

function wireRuler() {
  [['xsCanvas', 'xs'], ['panCanvas', 'pan']].forEach(([id, which]) => {
    const cv = $(id);
    cv.addEventListener('pointerdown', (e) => {
      const p = rulerState();
      const info = ((p.arch || {}).jaws || {})[p.jaw];
      if (!info || !info.ok) return;
      const pt = canvasPoint(cv, e);
      if (!pt) return;
      // A plain click on the panoramic still jumps the arc; a DRAG measures. The
      // threshold is applied on pointerup, so neither gesture has to be declared first.
      p.dragging = { which, a: { x: pt.x, y: pt.y }, b: { x: pt.x, y: pt.y }, moved: false };
      cv.setPointerCapture(e.pointerId);
    });
    cv.addEventListener('pointermove', (e) => {
      const p = planState();
      if (!p.dragging || p.dragging.which !== which) return;
      const pt = canvasPoint(cv, e);
      if (!pt) return;
      let { x, y } = pt;
      // Shift constrains to the axis the drag is already closest to.
      if (e.shiftKey && which === 'xs') {
        if (Math.abs(x - p.dragging.a.x) > Math.abs(y - p.dragging.a.y)) y = p.dragging.a.y;
        else x = p.dragging.a.x;
      }
      p.dragging.b = { x, y };
      p.dragging.moved = Math.hypot(x - p.dragging.a.x, y - p.dragging.a.y) > 4;
      drawRulers(which);
    });
    cv.addEventListener('pointerup', (e) => {
      const p = planState();
      if (!p.dragging || p.dragging.which !== which) return;
      const d = p.dragging;
      p.dragging = null;
      if (d.moved) {
        const key = rulerKey(which);
        (p.rulers[key] = p.rulers[key] || []).push({ a: d.a, b: d.b });
        renderRulerList();
      } else if (which === 'pan') {
        jumpToArcColumn(d.a.x);
      }
      drawRulers(which);
      try { cv.releasePointerCapture(e.pointerId); } catch { /* already gone */ }
    });
  });
  // Escape here CLAIMS the key, because the viewer's own Escape handler closes the
  // case. Both are on `document` in the bubble phase and this one is registered first,
  // so without stopping propagation "Esc clears" -- which is what the panel's own hint
  // promises -- cleared the rulers and then discarded every unsaved implant with them.
  // Only claimed when there was actually something to clear; otherwise Escape must
  // still close the case, which is the behaviour everywhere else in the app.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const p = state.viewer && state.viewer.plan;
    if (!p || !p.rulers) return;
    const had = p.dragging || Object.keys(p.rulers).some((k) => (p.rulers[k] || []).length);
    if (!had) return;
    e.stopPropagation();
    e.preventDefault();
    p.rulers = {}; p.dragging = null;
    drawRulers('xs'); drawRulers('pan'); renderRulerList();
  });
}

/** The measured list under the section, with a delete affordance per entry. */
/** The rulers, for the printed sheet.
 *
 *  `#rulerList` lives in the sidebar, and the sidebar is `display: none` on paper now
 *  that the panel no longer double-prints. A ruler is a measurement the user took by
 *  hand on this case; dropping it from the record would be the exact loss the sheet
 *  exists to prevent. Location included, because a number with no place in the patient
 *  is not a measurement.
 */
function rulerText() {
  const p = rulerState();
  const info = ((p.arch || {}).jaws || {})[p.jaw];
  if (!info || !info.ok) return '';
  const items = [];
  [['xs', rulerKey('xs')], ['pan', rulerKey('pan')]].forEach(([which, key]) => {
    (p.rulers[key] || []).forEach((r) => {
      const a = which === 'pan' ? { x: r.a.x, y: r.a.y } : r.a;
      const b = which === 'pan' ? { x: r.a.x, y: r.b.y } : r.b;
      const lps = which === 'pan'
        ? [panPixelToLps(info, a.y, a.x), panPixelToLps(info, b.y, b.x)]
        : [xsPixelToLps(info, p.index, a.y, a.x), xsPixelToLps(info, p.index, b.y, b.x)];
      const fmt = (q) => `(${q.map((v) => v.toFixed(1)).join(', ')})`;
      items.push(`<li>${esc(rulerLabel({ a, b }, info, which))}
        <small>${which === 'pan' ? 'panoramic, vertical axis only' : 'cross-section'},
        from ${fmt(lps[0])} to ${fmt(lps[1])} mm in patient LPS</small></li>`);
    });
  });
  return items.length
    ? `<h4>Measurements taken by hand</h4><ul class="pbasis">${items.join('')}</ul>` : '';
}

function renderRulerList() {
  const p = rulerState();
  const info = ((p.arch || {}).jaws || {})[p.jaw];
  const box = $('rulerList');
  if (!info || !info.ok) { box.innerHTML = ''; return; }
  const items = [];
  [['xs', rulerKey('xs')], ['pan', rulerKey('pan')]].forEach(([which, key]) => {
    (p.rulers[key] || []).forEach((r, i) => {
      const a = which === 'pan' ? { x: r.a.x, y: r.a.y } : r.a;
      const b = which === 'pan' ? { x: r.a.x, y: r.b.y } : r.b;
      // Where in the PATIENT this was measured, not just where on the picture. The
      // two mappings are the same ones the server uses, so a measurement can be
      // located in the scan afterwards rather than being an anonymous number.
      const lps = which === 'pan'
        ? [panPixelToLps(info, a.y, a.x), panPixelToLps(info, b.y, b.x)]
        : [xsPixelToLps(info, p.index, a.y, a.x), xsPixelToLps(info, p.index, b.y, b.x)];
      const fmt = (q) => `(${q.map((v) => v.toFixed(1)).join(', ')})`;
      const where = `from ${fmt(lps[0])} to ${fmt(lps[1])} mm, patient LPS`;
      items.push(`<li title="${esc(where)}"><span class="mono">${esc(rulerLabel({ a, b }, info, which))}</span>
        <span class="hint">${which === 'pan' ? 'panoramic, vertical' : 'cross-section'}</span>
        <button class="link" data-key="${esc(key)}" data-i="${i}" type="button">remove</button></li>`);
    });
  });
  box.innerHTML = items.length
    ? `<ul class="rulers">${items.join('')}</ul>`
    : '<p class="hint">Drag on the section to measure &middot; Shift constrains &middot; Esc clears</p>';
  box.querySelectorAll('button[data-key]').forEach((b) => {
    b.onclick = () => {
      const list = p.rulers[b.dataset.key] || [];
      list.splice(Number(b.dataset.i), 1);
      drawRulers('xs'); drawRulers('pan'); renderRulerList();
    };
  });
}

function jumpToArcColumn(x) {
  const p = planState();
  const info = ((p.arch || {}).jaws || {})[p.jaw];
  if (!info) return;
  const want = x * ((info.panoramic.size[1] - 1)
                    / Math.max(1, planSize($('panCanvas')).w - 1));
  const src = info.cross_sections.source_indices;
  let best = 0;
  for (let k = 1; k < src.length; k += 1) {
    if (Math.abs(src[k] - want) < Math.abs(src[best] - want)) best = k;
  }
  selectXs(best);
}

/* ---------------------------------------------------------------- implants */
/* Placement is stored in the ARCH frame -- (s, t, z) plus a tilt -- and never in LPS.
 *
 * With zero yaw the implant lies ENTIRELY inside the cross-section on screen, so the
 * drag is genuinely two-dimensional in the picture rather than a projection of
 * something else, and the browser and the server derive the same pose from the same
 * published polyline. They cannot disagree, because neither converts.
 *
 * `yaw` is carried in the schema and locked to 0 here. A yawed implant leaves the
 * visible plane and has to be drawn as a projection with an out-of-plane badge; that is
 * a later increment, not a shortcut taken quietly.
 *
 * There is no "provisional" in-plane estimate. The design allowed for one -- an upper
 * bound computed in the browser from section polygons -- but POST /measure is a lookup
 * over a precomputed field rather than a computation, so the authoritative answer comes
 * back in tens of milliseconds and an approximation would be a second, worse number for
 * a user to read. The bar shows "measuring" between a drag and its answer, and a verdict
 * colour appears ONLY once the server has replied.
 */
/** The implant size menu. SERVED, not a literal.
 *
 *  This was a hard-coded `{diameter: [...], length: [...]}` here with no server-side
 *  counterpart, so nothing validated a stored implant against a real size and the plan
 *  export could not say what was planned. `GET /v1/implants` now owns it
 *  (`dentistry/implants.py`), which also carries the caveat the panel has to show: the
 *  solid measured and exported is a capsule of the stated diameter and length, a
 *  faithful envelope for clearance and NOT any real implant's thread form.
 *
 *  The fallback exists so the plan tab still works if the catalogue call fails; it is
 *  the smallest sensible menu, not a second source of truth. */
const IMPLANT_SIZES_FALLBACK = {
  diameter_mm: [3.3, 3.75, 4.1, 4.8],
  length_mm: [6, 8, 10, 11.5, 13],
};
let IMPLANT_CATALOG = null;

async function loadImplantCatalog() {
  if (IMPLANT_CATALOG) return IMPLANT_CATALOG;
  try {
    IMPLANT_CATALOG = await api('/implants');
  } catch (e) {
    console.warn('dentistry: implant catalogue unavailable, using the fallback menu:',
                 e.message);
    IMPLANT_CATALOG = { ...IMPLANT_SIZES_FALLBACK, platforms: [], lengths: [],
                        notice: '' };
  }
  return IMPLANT_CATALOG;
}

function implantSizes() {
  const c = IMPLANT_CATALOG || IMPLANT_SIZES_FALLBACK;
  return { diameter: c.diameter_mm || IMPLANT_SIZES_FALLBACK.diameter_mm,
           length: c.length_mm || IMPLANT_SIZES_FALLBACK.length_mm };
}

/** Mirrors `api/routes/plans.MAX_IMPLANTS`. The server enforces it on both `/measure`
 *  and the plan schema; the client disables the Add button so a reader is told the limit
 *  instead of meeting it as a 422. */
const MAX_IMPLANTS = 8;
/** Mirrors the clamp the apex drag applies. One constant, so the number field and the
 *  drag cannot disagree about what is reachable. */
const MAX_TILT_DEG = 35;

/** Mesiodistal angulation, the angle the panoramic draws at true value.
 *
 *  Tighter than the buccolingual clamp on purpose. Buccolingual tilt is routinely large
 *  -- an anterior maxillary implant follows a labially inclined ridge -- while a
 *  mesiodistally angulated implant is fighting the neighbouring roots on both sides,
 *  and past about 30 degrees the abutment cannot be brought back to the occlusal plane.
 *  The server accepts up to 45; the reason the client stops earlier is clinical, not
 *  arithmetic, so it is stated here rather than duplicated as a bare number. */
const MAX_YAW_DEG = 30;
const YAW_STEP_DEG = 1;

/** Clocking, in fifteens: the connection hex has six-fold symmetry, so 15 degrees is
 *  half an index position and there is nothing finer to ask for.
 *
 *  IT MOVES NO MEASUREMENT. The measured solid is a body of revolution about the axis,
 *  so every clearance is invariant under it exactly; `/measure` returns that sentence
 *  in `pose.notes` and the panel prints it. A control that changes the picture and not
 *  the numbers has to say so, or a reader concludes the numbers are broken. */
const ROLL_STEP_DEG = 15;

/** How much of the implant, measured down from the platform, carries the verdict band.
 *
 *  1.2 mm is the machined collar length of a 10 mm implant in the catalogue's middle,
 *  so the band sits on the part of a real implant that has no thread -- and at the
 *  section's ~5.6 px/mm it is 7 px, which is legible without competing with the outline.
 */
const COLLAR_BAND_MM = 1.2;

function implantState() {
  const p = planState();
  if (!p.implants) { p.implants = []; p.selected = null; p.measured = {}; p.measuring = false; }
  // Which disclosure rows the reader has opened. In PLAN STATE, not in the `<details>`
  // elements: this panel is rebuilt with `innerHTML =` on every drag frame and every
  // slider tick, so DOM open state survives for about 16 ms.
  if (!p.openRows) p.openRows = new Set();
  return p;
}

/* ------------------------------------------------- the section's view of a 3-D pose
 * THE PROJECTION OF A CAPSULE IS A CAPSULE, and that one fact is the whole reason
 * mesiodistal angulation can be drawn here honestly rather than refused.
 *
 * The measured solid is `segment (+) ball(r)`. Orthogonal projection distributes over a
 * Minkowski sum, the projection of the ball is a disc of the same radius, and the
 * projection of the axis segment is a segment in the SAME in-plane direction: the axis
 * is `(sin y, sin t cos y, down cos t cos y)` in `(s, t, z)`, so dropping the `s`
 * component leaves `cos y * (sin t, down cos t)`. Direction unchanged, length scaled.
 *
 * So a yawed implant costs this drawing exactly one scalar -- `fore` -- and every depth
 * along the axis is drawn at `u * fore`. Nothing else in the outline, the envelope, the
 * hit test or the platform band changes, and at `yaw = 0` every one of them is
 * bit-identical to what it drew before.
 *
 * What it does NOT license is drawing a 3-D distance in this plane. A clearance is
 * measured in three dimensions; its in-plane projection is shorter than the number on
 * the chip. `drawDistances` therefore drops the caliper when the pose is out of plane
 * and keeps the chip, which is the same rule it already applies to mesial/distal.
 */
function sectionAxis(imp) {
  const down = imp.jaw === 'maxilla' ? 1 : -1;
  const tl = (Number(imp.tilt_deg) || 0) * Math.PI / 180;
  const yw = (Number(imp.yaw_deg) || 0) * Math.PI / 180;
  return { a: Math.sin(tl), b: down * Math.cos(tl),
           fore: Math.abs(Math.cos(yw)), yawed: Math.abs(yw) > 1e-9 };
}

/** The implant outline in the section's own (t, z) millimetres: body + apical dome.
 *
 *  Foreshortened by `sectionAxis().fore` when the pose is angulated out of plane; see
 *  the block comment above for why that is exact and not an approximation. */
function implantOutline(imp) {
  const r = imp.diameter_mm / 2;
  const { a, b, fore } = sectionAxis(imp);
  // axis unit in (t, z); the perpendicular is (-b, a)
  const shoulder = (imp.length_mm - r) * fore;
  const pt = (u, w) => [imp.t_mm + a * u - b * w, imp.z_mm + b * u + a * w];
  const out = [pt(0, r), pt(shoulder, r)];
  for (let i = 1; i < 12; i += 1) {
    const th = (i / 12) * Math.PI;
    out.push(pt(shoulder + r * Math.sin(th), r * Math.cos(th)));
  }
  out.push(pt(shoulder, -r), pt(0, -r));
  return out;
}

/* ------------------------------------------------- structure outlines on the section
 * Until now the plan cross-section was bare greyscale: the canal was a dark oval and
 * nothing on screen said WHICH structure the millimetres beside it were measured to, or
 * whether the segmentation agreed with the image at all. That is the product's whole
 * argument, made invisible.
 *
 * The producer is `worker/panoramic.py`, on the SAME sampling grid the picture is built
 * from, at the mid plane of the slab, through `worker/contours.plane_polygons` -- so
 * the outline is the same iso level as the 3-D surface, the STL and the RTSTRUCT.
 * The renderer is `drawContourSlice`, shared verbatim with the tile view.
 */

/** Three states, three behaviours: drawn, this case predates outlines, or fetch failed.
 *  Read from the arch manifest, NEVER from a 404 probe -- with auth on, a 401 and a 404
 *  look identical to a fetch, and "this case predates outlines" must not be what a
 *  session whose token expired is told. */
async function loadXsContours() {
  const p = planState();
  const v = state.viewer;
  const info = ((p.arch || {}).jaws || {})[p.jaw];
  const rel = info && info.cross_sections && info.cross_sections.contours;
  p.xsc = p.xsc || {};
  if (!rel) { p.xsc[p.jaw] = { state: 'unpublished' }; return null; }
  if (p.xsc[p.jaw] && p.xsc[p.jaw].state !== 'pending') return p.xsc[p.jaw].data || null;
  if (p.xscPending && p.xscPending[p.jaw]) return p.xscPending[p.jaw];
  p.xscPending = p.xscPending || {};
  p.xscPending[p.jaw] = (async () => {
    const jaw = p.jaw;
    try {
      const r = await cachedFetch(`${API}/jobs/${v.jobId}/files/planning/${rel}`);
      p.xsc[jaw] = { state: 'ok', data: await r.json() };
    } catch (e) {
      p.xsc[jaw] = { state: 'failed', reason: e.message };
      console.warn('dentistry: section outlines unavailable:', e.message);
    }
    setXsOverlay(xsOverlayPref);
    return (p.xsc[jaw] || {}).data || null;
  })();
  return p.xscPending[p.jaw];
}

/** The structures the plan tab draws by default.
 *
 *  Not "everything on the section": a molar section cuts the mandible, one or two
 *  teeth, the canal and sometimes an accessory canal, and drawing all of them at the
 *  tile view's fill would bury the greyscale the outline exists to be checked against.
 *  Not "the canal only" either -- the tooth clearance and any EXISTING implant or
 *  restoration beside the site are things the reader is deciding against.
 *
 *  Derived from the served catalogue by id, never from hard-coded indices: the label
 *  set has been renumbered before and an integer here would silently point at a
 *  different structure. */
function planKeySet(opts) {
  const v = state.viewer;
  const p = (v && v.plan) || {};
  const forThree = !!(opts && opts.three);
  // The implant being worked on, and the tooth it is REPLACING. On an extraction-site
  // plan that tooth is still in the scan, and in 3-D it sits exactly between the camera
  // and the implant -- measured: the pane showed a solid tooth and no implant at all.
  // It is still drawn on the SECTION, where it is behind the outline rather than in
  // front of it and is the thing the -2.05 mm is measured to.
  const sel = (p.implants || []).find((i) => i.id === p.selected);
  const siteFdi = sel && sel.site_fdi != null ? String(sel.site_fdi) : null;
  const sites = (((p.arch || {}).jaws || {})[p.jaw] || {}).sites || {};
  const here = sel ? sel.s_mm : null;
  const out = new Set();
  (allStructures() || []).forEach((st) => {
    const id = String(st.id || '');
    const fdi = st.fdi != null ? String(st.fdi) : null;
    if (/canal/.test(id) || /sinus/.test(id) || id === p.jaw) { out.add(st.index); return; }
    if (!/^tooth_/.test(id)) return;
    if (forThree && fdi && fdi === siteFdi) return;          // the tooth being replaced
    // In 3-D, only the neighbours: 14 mm along the arch reaches two teeth anteriorly
    // and one posteriorly, which is the span the adjacent-tooth clearance is about.
    if (forThree && here != null && fdi && sites[fdi] && sites[fdi].s_mm != null
        && Math.abs(sites[fdi].s_mm - here) > NEIGHBOUR_SPAN_MM) return;
    out.add(st.index);
  });
  return out;
}

/** How far along the arch a tooth still counts as a neighbour of this site. */
const NEIGHBOUR_SPAN_MM = 14;

/* How see-through the anatomy is while planning.
 *
 * An implant is INSIDE bone and BETWEEN roots, so at implant zoom every one of its
 * neighbours is between it and the camera. Measured at the catalogue's opacities: the
 * pane showed a solid tooth, then bone, then two roots, and the implant not at all.
 * Ghosting them keeps the context -- which is what the 3-D pane is for, since the
 * SECTION is where the millimetres are read -- and lets the metal be the thing you see.
 *
 * The jaw goes lower than the teeth because it fully encloses the implant, while a
 * neighbouring root only crosses part of it.
 */
// 0.10 was tuned on a full dentition, where 32 opaque teeth carry the picture and the
// jaw is genuinely just a wrapper. On a partially edentulous case -- which is the case an
// implant is actually planned on -- the jaw IS the anatomy, and at 0.10 the pane showed
// two red canals floating in black. 0.18 keeps the implant dominant and gives the ridge
// back its shape.
const PLAN_JAW_OPACITY = 0.18;
const PLAN_TOOTH_OPACITY = 0.30;

/** Keep the 3-D pane's focus in step with the selection. */
function refreshPlanFocus() {
  const v = state.viewer;
  if (!v || !window.DentistryViewer || !DentistryViewer.setSurfaceFocus) return;
  const plan = v.mode === 'plan';
  DentistryViewer.setSurfaceFocus(plan ? planKeySet({ three: true }) : null);
  if (!DentistryViewer.setSurfaceOpacity) return;
  (allStructures() || []).forEach((st) => {
    const id = String(st.id || '');
    const ghost = /jaw|maxilla|mandible/.test(id) ? PLAN_JAW_OPACITY
      : /^tooth_/.test(id) ? PLAN_TOOTH_OPACITY : null;
    if (ghost == null) return;
    DentistryViewer.setSurfaceOpacity(st.index, plan ? ghost : null);
  });
}

/** Paint this section's outlines, in IMAGE pixels.
 *
 *  `sx = sy = 1` because `planCtx` has already put the context in image pixels -- the
 *  the retired tile view passed a 2x scale because its context was in backing-store px.
 *  Outline-only by default (fill 0): a fill hides the greyscale the outline is there to
 *  be checked against, which is the opposite of the point.
 */
function drawXsContours(g, info) {
  const p = planState();
  const v = state.viewer;
  if (!info || !info.ok || !v) return;
  if ((p.xsOverlay || xsOverlayPref) === 'off') return;
  const store = (p.xsc || {})[p.jaw];
  if (!store || store.state !== 'ok') { loadXsContours(); return; }
  const slice = store.data && store.data[String(p.index)];
  if (!slice) return;
  // 2 image px = 0.30 mm at the published 0.1506 mm/px. The canal is ~2.7 mm across, so
  // the outline is ~11% of its diameter: visible without swallowing it. In IMAGE pixels
  // rather than CSS, so it scales with the picture rather than getting hairline-thin as
  // the section grows.
  drawContourSlice(g, slice, { sx: 1, sy: 1, fill: 0, outline: 2,
    only: (p.xsOverlay || xsOverlayPref) === 'all' ? null : planKeySet() });
}

/** The implant grown by `m` millimetres: the exact Minkowski offset of the capsule.
 *
 *  Substituting `d -> d + 2m` and `L -> L + m` into `implantOutline` gives
 *  `r' = r + m` and `shoulder' = (L + m) - (r + m) = L - r` -- the SAME axis segment
 *  with the radius grown by exactly `m`. So the envelope needs no new geometry, and it
 *  cannot drift from the outline it surrounds. */
function implantEnvelope(imp, m) {
  return implantOutline({ ...imp, diameter_mm: imp.diameter_mm + 2 * m,
                          length_mm: imp.length_mm + m });
}

/** (t, z) mm -> canvas pixels on the current cross-section. */
function tzToPixel(info, t_mm, z_mm) {
  const f = xsFrame(info);
  return { x: (t_mm - f.tMin) / f.colPitch, y: (f.zTop - z_mm) / f.rowPitch };
}

function hitTest(imp, info, pt) {
  const f = xsFrame(info);
  const t = f.tMin + pt.x * f.colPitch;
  const z = f.zTop - pt.y * f.rowPitch;
  const { a, b, fore } = sectionAxis(imp);
  const dt = t - imp.t_mm, dz = z - imp.z_mm;
  const along = dt * a + dz * b;                 // depth down the PROJECTED axis
  const across = Math.abs(-dt * b + dz * a);
  // The grab zones are on the picture, so they are measured on the projection: a
  // 45-degree yaw draws a 10 mm implant 7.1 mm long, and an apex handle at 10 mm
  // would sit 2.9 mm past the end of the thing on screen.
  const len = imp.length_mm * fore;
  if (across > imp.diameter_mm / 2 + 0.8) return null;
  if (along < -0.8 || along > len + 0.8) return null;
  if (along > len - 1.2) return 'apex';
  if (along < 1.2) return 'platform';
  return 'body';
}

/** THE ONE COLOUR RULE, and it holds in every view.
 *
 *  The implant body is TITANIUM GREY -- on the section, in the panoramic and in 3-D.
 *  The verdict is never the implant's own colour. It was, and two things went wrong at
 *  once: the user could not tell metal from a warning, and `breach` salmon collided with
 *  the coral the inferior alveolar canal surface is already drawn in, so the alarm and
 *  the thing it was about were the same hue in the 3-D pane.
 *
 *  So the verdict lives on marks that are not the implant: a collar band at the
 *  platform, the safety envelope, and the chip in the side panel. `verdictColour` is
 *  the single source for all of them, and `viewer/src/implants.js`'s `VERDICT_RGB` is
 *  its twin -- `web-auth/check-app.js` asserts the two agree, so this ternary's SHAPE is
 *  load-bearing and must not be refactored into a lookup without moving that check.
 */
function verdictColour(v, measuring) {
  return !v || measuring ? '#94a3b8'
    : v.level === 'breach' ? '#f87171'
    : v.level === 'tight' ? '#fbbf24'
    : v.level === 'clear' ? '#34d399' : '#94a3b8';
}

/** The pose in words, for the printed sheet and for the print-only `::after`.
 *
 *  Every angle that is set is named, and CLOCKING SAYS WHAT IT DOES NOT DO. A reader
 *  looking at a printed plan with "37 degrees rotation" on it and no number changed
 *  anywhere would otherwise be entitled to think a measurement had been missed; the
 *  measured solid is a body of revolution about the axis, so the invariance is exact.
 */
function anglePrint(imp) {
  const bits = [];
  const t = Number(imp.tilt_deg) || 0;
  const y = Number(imp.yaw_deg) || 0;
  const r = Number(imp.roll_deg) || 0;
  if (t) bits.push(`${t.toFixed(0)}\u00b0 buccolingual`);
  if (y) bits.push(`${y.toFixed(0)}\u00b0 mesiodistal`);
  if (r) bits.push(`${r.toFixed(0)}\u00b0 clocking (changes no clearance)`);
  return bits.join(', ');
}
function sizeOnly(imp) {
  return `${imp.diameter_mm} \u00d7 ${imp.length_mm} mm`;
}
function posePrint(imp) {
  const a = anglePrint(imp);
  return a ? `${sizeOnly(imp)}, ${a}` : sizeOnly(imp);
}

/** Machined titanium, the same grey the 3-D body uses. */
const IMPLANT_BODY = '#c7ccd4';

/** Draw the implants that lie on the section in view.
 *
 *  Takes its context and its manifest as ARGUMENTS. It used to reach for
 *  `cv.getContext('2d')` and inherit whatever transform `drawRulers` had left, which
 *  was correct only because `drawRulers` was the sole caller -- and silently wrong for
 *  any future one. `drawRulers` already holds both, so this costs nothing.
 */
function drawImplants(g, info) {
  const p = implantState();
  if (!info || !info.ok) return;
  const here = p.implants.filter((i) => i.jaw === p.jaw
    && Math.abs(i.s_mm - info.cross_sections.s_mm[p.index]) <= XS_NEAR_MM);
  here.forEach((imp) => {
    const poly = implantOutline(imp).map(([t, z]) => tzToPixel(info, t, z));
    const sel = p.selected === imp.id;
    const v = (p.measured[imp.id] || {}).verdict;
    // The verdict colour still reports the SERVER and nothing else, and is neutral while
    // a drag is in flight -- a colour a reader takes for "safe" must never come from
    // anything but a completed measurement. It just no longer paints the metal.
    const cue = verdictColour(v, p.measuring);
    const r = imp.diameter_mm / 2;
    const { a, b, fore, yawed } = sectionAxis(imp);
    // `u` is a TRUE depth down the implant axis and is projected here, once, so every
    // mark below -- axis, platform, collar band, apex cross -- lands on the same
    // foreshortened body the outline draws.
    const at = (u, w) => tzToPixel(info,
      imp.t_mm + a * u * fore - b * w, imp.z_mm + b * u * fore + a * w);

    g.save();
    // The SAFETY ENVELOPE, before the body so the implant sits on top of it.
    //
    // TWO rings, because there are two different true statements and only drawing one
    // of them would be misleading. The inner is the stated minimum -- 2.00 mm to nerve,
    // the number a coDiagnostiX user expects to see labelled "the margin". The outer is
    // the surface the verdict is ACTUALLY computed against: `plan_safety.budget_for`
    // grades a breach when `clearance < margin + inward_p95`, so on the canal the real
    // boundary is 2.46 mm. Both radii are read from the /measure reply -- no prior is
    // ever a literal here, so if `plan_safety` moves one, the drawn ring moves with it.
    if (sel && p.priors) {
      const pr = p.priors;
      const isMand = imp.jaw !== 'maxilla';
      const margin = Number(isMand ? pr.margin_mm : pr.adjacent_margin_mm);
      const field = isMand ? 'canal' : 'tooth';
      const p95 = Number(((pr.by_structure || {})[field] || {}).p95_mm);
      [[margin, [3, 3], .34], [margin + p95, [1, 3], .5]].forEach(([mm, dash, alpha]) => {
        if (!Number.isFinite(mm)) return;
        const ring = implantEnvelope(imp, mm).map(([t, z]) => tzToPixel(info, t, z));
        g.beginPath();
        ring.forEach((q, i) => (i ? g.lineTo(q.x, q.y) : g.moveTo(q.x, q.y)));
        g.closePath();
        g.strokeStyle = cue; g.globalAlpha = alpha;
        g.lineWidth = 1; g.setLineDash(dash);
        g.stroke();
      });
      g.globalAlpha = 1; g.setLineDash([]);
    }
    // The body.
    g.beginPath();
    poly.forEach((q, i) => (i ? g.lineTo(q.x, q.y) : g.moveTo(q.x, q.y)));
    g.closePath();
    g.fillStyle = 'rgba(199,204,212,.20)';
    g.fill();
    g.strokeStyle = IMPLANT_BODY;
    g.lineWidth = sel ? 2.2 : 1.4;
    g.setLineDash(p.measuring && sel ? [5, 4] : []);
    g.stroke();
    g.setLineDash([]);

    // The axis, so the angulation is readable without measuring it off the outline.
    g.beginPath();
    const ax0 = at(0.4, 0), ax1 = at(imp.length_mm - r * 0.4, 0);
    g.moveTo(ax0.x, ax0.y); g.lineTo(ax1.x, ax1.y);
    g.strokeStyle = 'rgba(199,204,212,.55)';
    g.lineWidth = sel ? 1.0 : 0.7;
    g.setLineDash([2, 3]);
    g.stroke();
    g.setLineDash([]);

    // The platform, drawn as the flat coronal face it is, and the COLLAR BAND that
    // carries the verdict. This is the only coloured mark on the implant.
    g.beginPath();
    const pl0 = at(0, r), pl1 = at(0, -r);
    g.moveTo(pl0.x, pl0.y); g.lineTo(pl1.x, pl1.y);
    g.strokeStyle = IMPLANT_BODY;
    g.lineWidth = sel ? 2.6 : 1.8;
    g.stroke();

    g.beginPath();
    const cb = COLLAR_BAND_MM;
    [[0, r], [cb, r], [cb, -r], [0, -r]].forEach(([u, w], i) => {
      const q = at(u, w);
      return i ? g.lineTo(q.x, q.y) : g.moveTo(q.x, q.y);
    });
    g.closePath();
    g.fillStyle = cue;
    g.globalAlpha = sel ? 0.85 : 0.6;
    g.fill();
    g.globalAlpha = 1;

    // The apex. It is where the canal verdict is decided, so it gets a mark of its own.
    const ap = at(imp.length_mm, 0);
    g.beginPath();
    g.moveTo(ap.x - 3, ap.y); g.lineTo(ap.x + 3, ap.y);
    g.moveTo(ap.x, ap.y - 3); g.lineTo(ap.x, ap.y + 3);
    g.strokeStyle = IMPLANT_BODY;
    g.lineWidth = sel ? 1.2 : 0.9;
    g.stroke();
    g.restore();
  });
}

/** Mirror the implant list into the 3D pane.
 *
 *  Driven off the same `p.implants` array the section draws from, so the two views
 *  cannot show different poses. The verdict that travels with each implant is
 *  `worstVerdict(..., {gradedOnly: true})` -- the worst grade actually established over
 *  every structure, not the canal's alone; see that function for why the shell and the
 *  strip rank `no_verdict` differently on purpose. And the same rule applies as in the
 *  2-D outline: while a measurement is in flight the level is null, which the viewer
 *  paints NEUTRAL. A colour the reader interprets as "safe" must never come from
 *  anything but a completed measurement. */
function syncImplants3d() {
  if (!window.DentistryViewer || !DentistryViewer.setImplants) return;
  const p = implantState();
  const v = state.viewer;
  if (!v || !v.mprMounted) return;
  DentistryViewer.setImplants(p.implants.map((imp) => ({
    ...imp,
    // `selected` drives the safety envelope's opacity, so the one being worked on reads
    // clearly and the others stay context rather than becoming soup.
    selected: p.selected === imp.id,
    // The worst COMPLETED grade, not the canal's alone -- see `worstVerdict`. Neutral
    // only when nothing at all was graded; ungradedness is reported by the strip and the
    // clearance rows, not by draining the colour out of the envelope.
    verdict: p.measuring ? null : worstVerdict(imp, p, { gradedOnly: true }),
  })));
}

/** Seed an implant at an arc position, sized from the catalogue's middle. */
function addImplant(s_mm, fdi) {
  const p = implantState();
  const info = ((p.arch || {}).jaws || {})[p.jaw];
  if (!info || !info.ok) return null;
  if (p.implants.length >= MAX_IMPLANTS) return null;
  // `i${length + 1}` COLLIDES: place i1 and i2, remove i1, add again and the new implant
  // is also "i2". Ids key `p.measured`, the 3-D actor registry and the pairwise table,
  // so a duplicate silently merges two implants into one everywhere at once. Counter
  // that only goes up.
  p.nextId = Math.max(Number(p.nextId) || 1,
                      ...p.implants.map((i) => (Number(String(i.id).slice(1)) || 0) + 1));
  const id = `i${p.nextId}`;
  p.nextId += 1;
  const imp = { id, jaw: p.jaw, s_mm, t_mm: 0, tilt_deg: 0, yaw_deg: 0, roll_deg: 0,
                length_mm: 10, diameter_mm: 4.1,
                // Added from the section rather than from the chart? Adopt whatever
                // site this arc position IS. Without it `+ Add implant` had no site, so
                // it fell back to the occlusal plane and spawned in the crown -- the
                // chart path aligned to bone and the button path did not, for no reason
                // a user could see.
                site_fdi: fdi == null ? siteAt(info, s_mm) : Number(fdi) };
  alignToSite(info, imp);
  p.implants.push(imp);
  p.selected = id;
  const i = nearestXsIndex(info, s_mm);
  if (i !== p.index) selectXs(i); else { drawRulers('xs'); }
  requestMeasure(0);
  renderImplantPanel();
  return imp;
}

/** Select an implant: the section follows it, the 3-D pane frames it, the panel
 *  re-renders and the 3-D focus set is recomputed around it. ONE path, shared by the
 *  panel click, Tab and the canvas -- three copies of this drifted once already. */
function selectImplant(id) {
  const p = implantState();
  const info = ((p.arch || {}).jaws || {})[p.jaw];
  const imp = p.implants.find((i) => i.id === id);
  if (!imp) return false;
  p.selected = id;
  if (info) selectXs(nearestXsIndex(info, imp.s_mm));
  // Framed along the arch, swung buccally, so the 3-D pane reproduces the picture the
  // cross-section shows without looking straight through the neighbouring roots.
  if (window.DentistryViewer && DentistryViewer.focusImplant) {
    DentistryViewer.focusImplant(id);
  }
  renderImplantPanel();
  return true;
}

/* ------------------------------------------------------- implant editing tools
 * What a planner is expected to let you do, and what this now does.
 *
 * Every implant-planning package converges on the same small set: nudge the implant in
 * the section, change its angulation, change its depth, change its size, step between
 * implants, re-seat it on the ridge, duplicate one you already like, and undo. Dragging
 * covers the coarse move; the keyboard is what makes the last tenth of a millimetre
 * reachable, because a 0.1 mm step is under one screen pixel at ordinary zoom and no
 * pointer can be asked for it.
 *
 * The steps are millimetres and degrees, never pixels, so a nudge means the same thing
 * at every zoom level and on every screen.
 */
const NUDGE_MM = 0.1;
const NUDGE_COARSE_MM = 1.0;
const TILT_STEP_DEG = 1;
const TILT_COARSE_DEG = 5;

/** Undo, over implant edits only. A planner without one makes a drag a commitment. */
const UNDO_DEPTH = 40;
function pushUndo(label) {
  const p = implantState();
  p.undo = p.undo || [];
  p.undo.push({ label, implants: JSON.parse(JSON.stringify(p.implants)),
                selected: p.selected });
  if (p.undo.length > UNDO_DEPTH) p.undo.shift();
}
function popUndo() {
  const p = implantState();
  if (!p.undo || !p.undo.length) return false;
  const prev = p.undo.pop();
  p.implants = prev.implants;
  p.selected = prev.selected;
  requestMeasure(0);
  drawRulers('xs');
  renderImplantPanel();
  return true;
}

/** Apply a keyboard tool to the selected implant. Returns true if it handled the key. */
function implantKey(e) {
  const v = state.viewer;
  if (!v || v.mode !== 'plan') return false;
  const p = implantState();
  const info = ((p.arch || {}).jaws || {})[p.jaw];
  if (!info || !info.ok) return false;
  const key = e.key;
  const mod = e.metaKey || e.ctrlKey;

  if (mod && (key === 'z' || key === 'Z')) { e.preventDefault(); return popUndo(); }
  // Tab steps between implants even with nothing selected, so a plan is navigable from
  // the keyboard alone.
  if (key === 'Tab' && p.implants.length > 1) {
    e.preventDefault();
    const i = p.implants.findIndex((x) => x.id === p.selected);
    const n = p.implants.length;
    selectImplant(p.implants[((i < 0 ? 0 : i) + (e.shiftKey ? n - 1 : 1)) % n].id);
    return true;
  }
  const imp = p.implants.find((x) => x.id === p.selected);
  if (!imp || imp.jaw !== p.jaw) return false;
  const step = e.shiftKey ? NUDGE_COARSE_MM : NUDGE_MM;
  const down = imp.jaw === 'maxilla' ? 1 : -1;
  let did = true;

  switch (key) {
    // Buccolingual and depth, in the section's own axes. Down is APICAL in either jaw,
    // so the key means the same thing in the maxilla as in the mandible.
    case 'ArrowLeft': pushUndo('move'); imp.t_mm -= step; break;
    case 'ArrowRight': pushUndo('move'); imp.t_mm += step; break;
    case 'ArrowDown': pushUndo('depth'); imp.z_mm += down * step; break;
    case 'ArrowUp': pushUndo('depth'); imp.z_mm -= down * step; break;
    // Angulation. Clamped to the same MAX_TILT_DEG the drag and the number field use.
    case ',': case '<':
      pushUndo('tilt');
      imp.tilt_deg = Math.max(-MAX_TILT_DEG,
        imp.tilt_deg - (e.shiftKey ? TILT_COARSE_DEG : TILT_STEP_DEG));
      break;
    case '.': case '>':
      pushUndo('tilt');
      imp.tilt_deg = Math.min(MAX_TILT_DEG,
        imp.tilt_deg + (e.shiftKey ? TILT_COARSE_DEG : TILT_STEP_DEG));
      break;
    // Mesiodistal angulation -- the panoramic's plane. Next to the buccolingual pair on
    // the keyboard because they are the same gesture in two planes, and refused
    // outright when the manifest publishes no tangents: yaw rotates toward +s, and the
    // tangent is what defines which way +s points. Deriving it as `up x n` gets the
    // SIGN wrong at the far ends of real arches, so a refusal beats a mirror.
    case ';': case ':':
      if (!canYaw(info)) { did = false; break; }
      pushUndo('yaw');
      imp.yaw_deg = Math.max(-MAX_YAW_DEG,
        (Number(imp.yaw_deg) || 0) - (e.shiftKey ? TILT_COARSE_DEG : YAW_STEP_DEG));
      break;
    case "'": case '"':
      if (!canYaw(info)) { did = false; break; }
      pushUndo('yaw');
      imp.yaw_deg = Math.min(MAX_YAW_DEG,
        (Number(imp.yaw_deg) || 0) + (e.shiftKey ? TILT_COARSE_DEG : YAW_STEP_DEG));
      break;
    // Clocking. Wraps rather than clamping -- a rotation has no ends -- and is the one
    // tool here that changes no number, which the panel says in as many words.
    case 'r': case 'R':
      pushUndo('clocking');
      imp.roll_deg = (((Number(imp.roll_deg) || 0)
        + (e.shiftKey ? -ROLL_STEP_DEG : ROLL_STEP_DEG) + 360) % 360);
      break;
    // Size, stepped through the served catalogue rather than by free arithmetic: a
    // diameter this app cannot name is a diameter nobody can order.
    case '+': case '=': pushUndo('length'); stepSize(imp, 'length_mm', +1, e.shiftKey); break;
    case '-': case '_': pushUndo('length'); stepSize(imp, 'length_mm', -1, e.shiftKey); break;
    // Re-seat on the ridge: undo a drag that wandered, without deleting the implant.
    case 'c': case 'C':
      pushUndo('re-seat');
      alignToSite(info, imp);
      break;
    // Duplicate, offset one tooth-width mesially. The commonest second implant.
    case 'd': case 'D': {
      if (p.implants.length >= MAX_IMPLANTS) { did = false; break; }
      pushUndo('duplicate');
      const copy = { ...imp, id: null, s_mm: imp.s_mm - 7 };
      const made = addImplant(copy.s_mm, null);
      if (made) Object.assign(made, { ...copy, id: made.id, site_fdi: null });
      break;
    }
    case 'Delete': case 'Backspace':
      pushUndo('remove');
      p.implants = p.implants.filter((x) => x.id !== imp.id);
      p.selected = p.implants.length ? p.implants[0].id : null;
      break;
    default: did = false;
  }
  if (!did) return false;
  e.preventDefault();
  clampImplant(info, imp);
  requestMeasure(220);
  drawRulers('xs');
  renderImplantPanel();
  return true;
}

/** Move one catalogue step. `wide` steps the DIAMETER instead of the length. */
function stepSize(imp, field, dir, wide) {
  const cat = implantSizes();
  const list = wide ? cat.diameter : cat.length;
  const f = wide ? 'diameter_mm' : field;
  const i = list.findIndex((x) => Math.abs(x - imp[f]) < 1e-6);
  const j = Math.max(0, Math.min(list.length - 1, (i < 0 ? 0 : i) + dir));
  imp[f] = list[j];
}

/** Whether mesiodistal angulation is available on this jaw's manifest.
 *
 *  It needs `tangents`, and for one reason: yaw rotates the axis toward +s, and the
 *  tangent array is the only published thing that says which direction that is.
 *  `plan_geometry.implant_frame` raises rather than derive it from `up x n`, because the
 *  handedness of the published normals relative to the published tangents FLIPS at the
 *  extreme ends of 2 of 10 real jaw fits -- so a derived sign would mirror the
 *  angulation exactly where a third molar sits. The control is disabled with that
 *  reason on it, which is a stated absence rather than a dead input. */
function canYaw(info) {
  return !!(info && Array.isArray(info.tangents) && info.tangents.length);
}

/** Keep an implant inside the picture it is drawn on. A pose the section cannot show is
 *  a pose the reader cannot check. */
function clampImplant(info, imp) {
  const f = xsFrame(info);
  const tMax = Math.abs(f.tMin) - imp.diameter_mm / 2;
  imp.t_mm = Math.max(-tMax, Math.min(tMax, imp.t_mm));
  const zLo = f.zTop - (info.cross_sections.size[0] - 1) * f.rowPitch;
  imp.z_mm = Math.max(zLo + 1, Math.min(f.zTop - 1, imp.z_mm));
  // ...and inside the ARCH, now that the panoramic can drag it along one. Off the end
  // of the polyline the frame is clamped to the last index, so the implant would stop
  // moving while its stored `s_mm` kept going -- two poses, one picture.
  const arc = (info.cross_sections || {}).s_mm || [];
  if (arc.length) {
    imp.s_mm = Math.max(Math.min(arc[0], arc[arc.length - 1]),
                        Math.min(Math.max(arc[0], arc[arc.length - 1]), imp.s_mm));
  }
  if (!canYaw(info)) imp.yaw_deg = 0;
}

/** How near a published site has to be, along the arch, to count as THIS site.
 *  Half a premolar: close enough to be the same position, far enough that a click
 *  between two teeth does not silently claim one of them. */
const SITE_ADOPT_MM = 3.5;

/** The FDI position this arc coordinate belongs to, or null. */
function siteAt(info, s_mm) {
  const sites = info.sites || {};
  let best = null; let bestD = Infinity;
  Object.keys(sites).forEach((k) => {
    const st = sites[k];
    if (!st || st.s_mm == null) return;
    const d = Math.abs(st.s_mm - s_mm);
    if (d < bestD) { bestD = d; best = k; }
  });
  return bestD <= SITE_ADOPT_MM ? Number(best) : null;
}

/** How far below the crest the platform sits. A slightly sub-crestal platform is the
 *  ordinary placement: it puts the rough surface in bone and gives the soft tissue
 *  somewhere to sit. */
const SUBCRESTAL_MM = 0.5;

/** The bone this app will not plan into: the safety margin plus the segmentation's own
 *  inward error, which is exactly the surface the verdict is graded against. */
const APICAL_RESERVE_MM = 2.5;

/** Buccal and lingual plate this app will not plan through, per side.
 *
 *  0.75 is the FLOOR -- what the geometry forbids, not what a surgeon would accept. The
 *  restorative-driven diameter below is what is actually offered; this only ever narrows
 *  it. */
const PLATE_RESERVE_MM = 0.75;

/** The diameter a site WANTS, by the tooth being replaced, before the ridge has a say.
 *
 *  This is the half of implant selection the previous version had backwards. It chose
 *  "the widest that leaves 0.75 mm of plate", which on a 9.4 mm molar ridge is a 6.0 mm
 *  implant -- an implant nobody places at a first molar, sitting in a site that would
 *  then have 1.7 mm of bone a side. Diameter is chosen by the RESTORATION: what tooth is
 *  being replaced, and what emergence profile its crown needs. The ridge then narrows
 *  that choice or refuses the site; it never widens it.
 *
 *  Central values, by FDI position number. Wider than these exist and are placed, but a
 *  planner's STARTING point is a standard-platform implant for the tooth, and the reader
 *  changes it from a sensible number rather than down from an extreme one. */
const SITE_DIAMETER_MM = {
  1: 3.5,   // central incisor
  2: 3.3,   // lateral incisor -- the narrowest site in the mouth
  3: 3.75,  // canine
  4: 4.1,   // first premolar
  5: 4.1,   // second premolar
  6: 4.8,   // first molar
  7: 4.8,   // second molar
  8: 4.3,   // third molar, when it is restored at all
};

/** Longer is not better, and this is the cap that says so.
 *
 *  Beyond roughly 13 mm there is no survival benefit in the literature, and the binding
 *  constraint on a lower posterior implant is the inferior alveolar canal rather than
 *  the total height of the mandible. A 24 mm site does not license a 16 mm implant; it
 *  licenses the same 10-13 mm implant with more bone under it. */
const MAX_PLANNED_LENGTH_MM = 13;
/** What a planner reaches for first when the bone allows it. */
const PREFERRED_LENGTH_MM = 10;

/** Put a new implant where a clinician would start it, not where the code found it easy.
 *
 *  It used to seed `z = occlusal_z_mm - 1.0`: one millimetre below the BITING SURFACE.
 *  That is the top of the crown, not the top of the bone -- on a molar site with 8 mm of
 *  crown the implant spawned floating in the tooth, and every plan began by dragging it
 *  down. `ridge.py` has published `crest_z_mm` per site all along.
 *
 *  So: platform half a millimetre below the crest, and a size a clinician would actually
 *  start from --
 *    - diameter: what the TOOTH needs (`SITE_DIAMETER_MM`), narrowed by the measured
 *      ridge if the ridge cannot take it;
 *    - length: 10 mm where the bone allows, the longest that fits below that, and never
 *      more than 13 -- capped independently of how much bone is underneath.
 *
 *  This used to take the widest and the longest that geometrically fit, which produced a
 *  6.0 x 16 mm implant at a lower first molar with 23.9 mm of height and a 9.4 mm ridge.
 *  Both numbers were true and neither was a plan: nobody places a 6 mm implant at a 46,
 *  and the extra 6 mm of length buys nothing while spending the clearance the whole
 *  product exists to grade. Fitting is a CONSTRAINT, not an objective.
 *
 *  Both fall back to the catalogue default when the site publishes no measurement, and
 *  the fallback is a REFUSAL to guess rather than a guess: the default is not claimed to
 *  fit.
 */
function alignToSite(info, imp) {
  const cat = implantSizes();
  const site = imp.site_fdi != null
    ? (info.sites || {})[String(imp.site_fdi)] : null;
  const down = imp.jaw === 'maxilla' ? 1 : -1;
  const crest = site && site.crest_z_mm != null ? site.crest_z_mm : null;
  // No crest: fall back to the occlusal plane, and say so rather than pretending.
  imp.z_mm = crest != null ? crest + down * SUBCRESTAL_MM
    : info.occlusal_z_mm + down * 1.0;
  imp.t_mm = 0;                 // the crest midline, which is where `ridge.py` measures
  imp.tilt_deg = 0;
  // ALL THREE angles, not just the one. `C` is "re-seat on the ridge", and a re-seat
  // that left a 20-degree mesiodistal angulation in place would put the platform on
  // the crest and the apex somewhere nobody asked for -- which is exactly the
  // half-reset that made a "complete record" necessary in `measure_sites`.
  imp.yaw_deg = 0;
  imp.roll_deg = 0;
  imp.alignedTo = crest != null ? 'crest' : 'occlusal';

  // LENGTH. Preferred first, capped second, and only then limited by the bone.
  const h = site && site.height_mm != null ? site.height_mm : null;
  if (h != null) {
    const usable = Math.min(h - SUBCRESTAL_MM - APICAL_RESERVE_MM, MAX_PLANNED_LENGTH_MM);
    const fits = cat.length.filter((L) => L <= usable);
    if (!fits.length) {
      imp.length_mm = Math.min(...cat.length);
      imp.lengthFrom = 'shortest available — this site is short of bone';
    } else if (fits.includes(PREFERRED_LENGTH_MM)) {
      imp.length_mm = PREFERRED_LENGTH_MM;
      imp.lengthFrom = 'the usual starting length, and the bone takes it';
    } else {
      imp.length_mm = Math.max(...fits);
      imp.lengthFrom = usable >= MAX_PLANNED_LENGTH_MM
        ? 'the longest this planner offers' : 'the longest the measured height takes';
    }
  } else {
    imp.lengthFrom = null;
  }

  // DIAMETER. What the tooth needs, narrowed by the ridge — never widened by it.
  const w = site && site.width_mm != null ? site.width_mm : null;
  const pos = imp.site_fdi != null ? Number(String(imp.site_fdi).slice(-1)) : null;
  const wanted = (pos != null && SITE_DIAMETER_MM[pos]) || null;
  if (w != null) {
    const usable = w - 2 * PLATE_RESERVE_MM;
    const fits = cat.diameter.filter((D) => D <= usable);
    if (!fits.length) {
      imp.diameter_mm = Math.min(...cat.diameter);
      imp.diameterFrom = 'narrowest available — this ridge is too thin for it';
    } else if (wanted != null && fits.some((D) => D >= wanted)) {
      // The catalogue value nearest what the tooth wants, from those the ridge allows.
      imp.diameter_mm = fits.reduce((best, D) =>
        Math.abs(D - wanted) < Math.abs(best - wanted) ? D : best, fits[0]);
      imp.diameterFrom = 'the usual platform for this tooth, and the ridge takes it';
    } else {
      imp.diameter_mm = Math.max(...fits);
      imp.diameterFrom = wanted != null
        ? 'narrowed from the usual platform — the ridge is too thin for it'
        : 'the widest the measured ridge takes';
    }
  } else if (wanted != null) {
    imp.diameter_mm = wanted;
    imp.diameterFrom = 'the usual platform for this tooth — this ridge was not measured';
  } else {
    imp.diameterFrom = null;
  }
  return imp;
}

function nearestXsIndex(info, s_mm) {
  const arr = info.cross_sections.s_mm;
  let best = 0;
  for (let k = 1; k < arr.length; k += 1) {
    if (Math.abs(arr[k] - s_mm) < Math.abs(arr[best] - s_mm)) best = k;
  }
  return best;
}

function wireImplants() {
  const cv = $('xsCanvas');
  cv.addEventListener('pointerdown', (e) => {
    const p = implantState();
    const info = ((p.arch || {}).jaws || {})[p.jaw];
    if (!info || !info.ok || !p.implants.length) return;
    const pt = canvasPoint(cv, e);
    if (!pt) return;
    for (const imp of p.implants) {
      if (imp.jaw !== p.jaw) continue;
      const part = hitTest(imp, info, pt);
      if (part) {
        // Grabbing an implant is a placement gesture, not a measurement one, so the
        // ruler must not also start a drag from the same pointerdown.
        e.stopImmediatePropagation();
        p.selected = imp.id;
        p.drag = { id: imp.id, part, from: pt, t0: imp.t_mm, z0: imp.z_mm,
                   tilt0: imp.tilt_deg, len0: imp.length_mm };
        cv.setPointerCapture(e.pointerId);
        renderImplantPanel();
        drawRulers('xs');
        return;
      }
    }
  }, true);                            // capture: ahead of the ruler's listener

  cv.addEventListener('pointermove', (e) => {
    const p = planState();
    if (!p.drag) return;
    const info = ((p.arch || {}).jaws || {})[p.jaw];
    const pt = canvasPoint(cv, e);
    if (!pt) return;
    const f = xsFrame(info);
    const dt = (pt.x - p.drag.from.x) * f.colPitch;
    const dz = -(pt.y - p.drag.from.y) * f.rowPitch;
    const imp = p.implants.find((i) => i.id === p.drag.id);
    if (!imp) return;
    if (p.drag.part === 'body' || p.drag.part === 'platform') {
      imp.t_mm = p.drag.t0 + dt;
      imp.z_mm = p.drag.z0 + dz;
    } else if (p.drag.part === 'apex') {
      // The apex steers the tilt within the section plane; Shift lengthens instead.
      if (e.shiftKey) {
        imp.length_mm = Math.max(6, Math.min(16, p.drag.len0 + (imp.jaw === 'maxilla' ? dz : -dz)));
      } else {
        imp.tilt_deg = Math.max(-MAX_TILT_DEG,
                                Math.min(MAX_TILT_DEG, p.drag.tilt0 + dt * 3));
      }
    }
    drawRulers('xs');
    requestMeasure(220);
  });

  cv.addEventListener('pointerup', (e) => {
    const p = planState();
    if (!p.drag) return;
    p.drag = null;
    try { cv.releasePointerCapture(e.pointerId); } catch { /* already gone */ }
    requestMeasure(0);
  });
}

/** The panoramic's own pointer gestures: move along the arch, and set the yaw.
 *
 *  Registered in the CAPTURE phase, ahead of `wireRuler`'s listener on the same
 *  element, and it stops immediate propagation when it takes the gesture -- otherwise
 *  the same pointerdown would also start a ruler and, on release without movement,
 *  scrub the section stack out from under the implant being dragged.
 *
 *  These two are the gestures the panoramic had none of. Mesiodistal POSITION had no
 *  pointer at all -- `s_mm` was only reachable by placing a new implant or by `D`,
 *  which offsets by a fixed 7 mm -- and mesiodistal ANGULATION had no control anywhere.
 */
function wirePanImplants() {
  const cv = $('panCanvas');
  if (!cv) return;
  cv.addEventListener('pointerdown', (e) => {
    const p = implantState();
    const info = ((p.arch || {}).jaws || {})[p.jaw];
    if (!info || !info.ok || !p.implants.length) return;
    const pt = canvasPoint(cv, e);
    if (!pt) return;
    for (const imp of p.implants) {
      if (imp.jaw !== p.jaw) continue;
      const part = panHitTest(imp, info, cv, pt);
      if (!part) continue;
      e.stopImmediatePropagation();
      p.selected = imp.id;
      p.panDrag = { id: imp.id, part, from: panMmOf(info, cv, pt),
                    s0: imp.s_mm, z0: imp.z_mm, yaw0: imp.yaw_deg || 0 };
      cv.setPointerCapture(e.pointerId);
      renderImplantPanel();
      drawRulers('pan');
      return;
    }
  }, true);

  cv.addEventListener('pointermove', (e) => {
    const p = planState();
    if (!p || !p.panDrag) return;
    const info = ((p.arch || {}).jaws || {})[p.jaw];
    const pt = canvasPoint(cv, e);
    if (!pt) return;
    const imp = p.implants.find((i) => i.id === p.panDrag.id);
    if (!imp) return;
    const now = panMmOf(info, cv, pt);
    if (p.panDrag.part === 'body') {
      imp.s_mm = p.panDrag.s0 + (now.s_mm - p.panDrag.from.s_mm);
      imp.z_mm = p.panDrag.z0 + (now.z_mm - p.panDrag.from.z_mm);
      // The site follows the position, or is dropped: a plan that still claims FDI 36
      // after being dragged onto 34 measures its tooth clearance against the wrong
      // exclusion and prints the wrong tooth number on the sheet.
      imp.site_fdi = siteAt(info, imp.s_mm);
    } else {
      // The yaw handle. Solve the pose for the direction the pointer is asking for
      // rather than accumulating pixels: the axis satisfies
      //   axis_s / axis_z = tan(yaw) / (down * cos(tilt)),
      // so a target `(ds, dz)` gives `tan(yaw) = (ds / dz_apical) * cos(tilt)` and the
      // gesture means the same thing at every zoom level and on every screen.
      const down = imp.jaw === 'maxilla' ? 1 : -1;
      const ds = now.s_mm - imp.s_mm;
      const apical = (now.z_mm - imp.z_mm) * down;
      if (apical > 0.5) {
        const ct = Math.cos((Number(imp.tilt_deg) || 0) * Math.PI / 180);
        const want = Math.atan2(ds * ct, apical) * 180 / Math.PI;
        imp.yaw_deg = Math.max(-MAX_YAW_DEG, Math.min(MAX_YAW_DEG, want));
      }
    }
    clampImplant(info, imp);
    drawRulers('pan');
    // The section has to follow: the implant may have left the slice in view, and the
    // outline there is what the clearance chips hang off.
    drawRulers('xs');
    requestMeasure(220);
  });

  cv.addEventListener('pointerup', (e) => {
    const p = planState();
    if (!p || !p.panDrag) return;
    const imp = p.implants.find((i) => i.id === p.panDrag.id);
    p.panDrag = null;
    try { cv.releasePointerCapture(e.pointerId); } catch { /* already gone */ }
    // Land on the section the implant is now nearest to, so the buccolingual view and
    // the mesiodistal one are looking at the same place.
    const info = ((p.arch || {}).jaws || {})[p.jaw];
    if (imp && info) selectXs(nearestXsIndex(info, imp.s_mm));
    requestMeasure(0);
    renderImplantPanel();
  });
}

let _measureTimer = null;
/** Ask the server. Debounced during a drag; immediate on release. */
function requestMeasure(delayMs) {
  const p = implantState();
  if (_measureTimer) clearTimeout(_measureTimer);
  if (!p.implants.length) { p.measured = {}; renderImplantPanel(); return; }
  p.measuring = true;
  renderImplantPanel();
  // Neutral the 3-D actors for the whole interval between here and the server's reply.
  if (window.DentistryViewer && DentistryViewer.setImplantVerdict) {
    p.implants.forEach((imp) => DentistryViewer.setImplantVerdict(imp.id, null));
  }
  _measureTimer = setTimeout(async () => {
    const v = state.viewer;
    try {
      const r = await api(`/jobs/${v.jobId}/measure`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ implants: p.implants }),
      });
      p.measured = Object.fromEntries((r.implants || []).map((m) => [m.id, m]));
      // Pairwise distances are PLAN-level, not per-implant, so they live beside the
      // map rather than in it. Sorted ascending by the server, so [0] is the binding
      // pair and that is the one worth putting in front of the reader.
      p.pairs = r.pairs || [];
      // `edits` and `edit_penalty` travel WITH the priors rather than beside them: they
      // are terms in the same budget, and a reader looking at "0.76 mm deducted" has to
      // be able to find the 0.46 and the 0.30 in one place.
      p.priors = { ...(r.priors || {}), edits: r.edits || [],
                   edit_penalty: r.edit_penalty || {} };
      p.notice = r.notice;
      p.measureError = null;
      p.measuredStale = null;
    } catch (err) {
      p.measureError = err.message;
      // The pack outlives nothing: results are deleted after RESULT_TTL_HOURS (72) and
      // the plan is not. `db.CasePlan` says a plan whose pack has expired must render
      // its LAST numbers with the date and a note -- "never silently stale, never
      // blank" -- and the server now caches exactly that on every save. Fall back to
      // it, clearly dated, rather than showing an error where numbers used to be.
      const cur = (planListState() || {}).current;
      const cached = cur && cur.measured;
      if (cached && (cached.implants || []).length) {
        p.measured = Object.fromEntries((cached.implants || []).map((m) => [m.id, m]));
        p.pairs = cached.pairs || [];
        p.priors = cached.priors; p.notice = cached.notice;
        p.measuredStale = cur.measured_at || 'an earlier session';
      }
    }
    p.measuring = false;
    renderImplantPanel();
    drawRulers('xs');
    if (window.DentistryViewer && DentistryViewer.setImplantVerdict) {
      p.implants.forEach((imp) => DentistryViewer.setImplantVerdict(
        imp.id, worstVerdict(imp, p, { gradedOnly: true })));
    }
  }, delayMs);
}

/** The clearance bar: the budget drawn literally, hatch and all. */
/** One clearance's arithmetic, drawn with every term named.
 *
 *  Takes the VERDICT rather than the measurement, so it can draw the canal, the
 *  accessory canals and the teeth identically -- each with its OWN inward-error term,
 *  which differ by 2-3x and must not be interchanged. `exact: true` (the inter-implant
 *  case) has no error term at all and says so, because a deduction that does not apply
 *  would be theatre. */
/** The millimetre span every bar in one implant's block is drawn against.
 *
 *  Each bar used to pick its own `Math.max(6, val + 1.5)`, so two bars stacked in the
 *  same card had different millimetres per pixel and a 13 mm clearance could look
 *  identical to a 2 mm one. A bar chart whose bars are not comparable is a decoration.
 *  Recomputed per render from every value in view, floored so a set of tiny clearances
 *  still has a readable axis.
 */
let _barSpanMm = 8;
function setBarSpan(verdicts) {
  let hi = 0;
  (verdicts || []).forEach((v) => {
    const n = (v || {}).numbers || {};
    [n.clearance_mm, n.distance_mm, n.at_least_mm, n.margin_mm].forEach((x) => {
      if (typeof x === 'number' && Number.isFinite(x)) hi = Math.max(hi, x);
    });
  });
  _barSpanMm = Math.max(6, hi * 1.12);
}

/** @param bare  draw the TRACK only, with no legend.
 *
 *  The legend is the arithmetic spelled out -- "13.66 measured, minus 0.46 the canal may
 *  be under-drawn by, against a 2.00 margin" -- and it is ~120 characters per bar, three
 *  bars per implant. It is worth reading once and not on every glance, so the compact
 *  row draws the picture and the disclosure carries the words. The bar itself never
 *  goes away: it is the only thing that makes two clearances comparable, and it carries
 *  the margin rule, which is the single most important mark this product draws. */
function budgetBar(v, bare) {
  const n = (v || {}).numbers || {};
  const val = n.clearance_mm != null ? n.clearance_mm : n.distance_mm;
  const cls = { clear: 'ok', tight: 'warn', breach: 'bad' }[v.level] || 'none';
  const span = _barSpanMm;
  const pct = (x) => `${Math.max(0, Math.min(100, (x / span) * 100))}%`;
  // The saturated branch: the field ran out of range, so the answer is a BOUND, not a
  // number. It used to fall through the `val == null` guard and render no bar at all --
  // which meant the SAFEST implants, the ones far enough away to exhaust the distance
  // field, were the only ones with no picture. Drawn open-ended, because "at least this
  // far" is exactly what the geometry supports.
  if (val == null && typeof n.at_least_mm === 'number') {
    return `<div class="cbar ${cls}">
      <div class="cbar-track">
        <i class="cbar-fill cbar-open" style="width:${pct(n.at_least_mm)}"></i>
        <i class="cbar-rule" style="left:${pct(n.margin_mm)}"></i>
      </div>
      ${bare ? '' : `<div class="cbar-legend">
        more than <span class="mono">${n.at_least_mm.toFixed(2)} mm</span> &mdash; beyond
        what this measurement reaches, so it is stated as a bound, against a
        <span class="mono">${Number(n.margin_mm).toFixed(2)}</span> mm minimum
      </div>`}
    </div>`;
  }
  if (val == null) return '';
  if (n.exact) {
    return `<div class="cbar ${cls}">
      <div class="cbar-track">
        <i class="cbar-fill" style="width:${pct(val)}"></i>
        <i class="cbar-rule" style="left:${pct(n.margin_mm)}"
           title="the ${n.margin_mm} mm minimum"></i>
      </div>
      ${bare ? '' : `<div class="cbar-legend">
        <span class="mono">${val.toFixed(2)} mm</span> exact &mdash; no segmentation in
        this figure, so nothing is deducted &rarr;
        <b class="mono">${n.headroom_mm >= 0 ? '+' : ''}${n.headroom_mm.toFixed(2)} mm</b>
        beyond the <span class="mono">${n.margin_mm.toFixed(2)}</span> mm minimum
      </div>`}
    </div>`;
  }
  return `<div class="cbar ${cls}">
    <div class="cbar-track">
      <i class="cbar-fill" style="width:${pct(n.informed_mm)}"></i>
      <i class="cbar-hatch" style="left:${pct(n.informed_mm)};width:${pct(n.inward_p95_mm)}"></i>
      <i class="cbar-rule" style="left:${pct(n.margin_mm)}"
         title="the ${n.margin_mm} mm margin"></i>
    </div>
    ${bare ? '' : `<div class="cbar-legend">
      <span class="mono">${val.toFixed(2)} mm</span> measured
      &minus; <span class="mono">${n.inward_p95_mm.toFixed(2)}</span> the
      ${esc(n.measured_against || 'segmentation')} may be under-drawn by
      = <span class="mono">${n.informed_mm.toFixed(2)}</span> against a
      <span class="mono">${n.margin_mm.toFixed(2)}</span> margin
      &rarr; <b class="mono">${n.headroom_mm >= 0 ? '+' : ''}${n.headroom_mm.toFixed(2)} mm</b> headroom
    </div>`}
  </div>`;
}

/** One structure's block: headline, bar, and the reasons.
 *
 *  Still used for the PAIRWISE list and by the print sheet's prose. The per-implant
 *  panel uses `clearanceRow` instead -- see there for why. */
function clearanceBlock(v, label) {
  if (!v || !v.headline) return '';
  return `<div class="cblock">
    <p class="verdict ${v.level}"><span class="cblabel">${esc(label)}</span>
      ${esc(v.headline)}</p>
    ${budgetBar(v)}
    ${(v.because || []).length
      ? `<ul class="why">${v.because.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}
  </div>`;
}

/** The word a verdict level is READ as. Never colour alone.
 *
 *  `no_verdict` is the reason this exists. It is not a weaker `clear`; it means the
 *  measurement carried a caveat and the grader refused to grade it. Rendered as a
 *  colour it was a paler green, and a paler green reads as a paler pass. */
const VERDICT_WORD = { breach: 'breach', tight: 'tight', clear: 'clear',
                       no_verdict: 'not graded' };

/** What the row's number says, in as few characters as it can be true in. */
function clearanceValueText(v) {
  const n = (v || {}).numbers || {};
  const val = n.clearance_mm != null ? n.clearance_mm : n.distance_mm;
  if (typeof val === 'number') return `${val.toFixed(2)} mm`;
  if (typeof n.at_least_mm === 'number') return `> ${n.at_least_mm.toFixed(1)} mm`;
  return '\u2014';
}

/** One structure, as ONE LINE, with the prose behind a disclosure.
 *
 *  Measured on the live site before this: a single implant produced 2745 characters in
 *  an 1118 px card, and 65% of the sidebar was scrolled out of reach with no scrollbar
 *  to say so. Three `clearanceBlock`s alone were 816 px of it, most of that the
 *  `because[]` lists -- which the printed sheet already carries, DE-DUPLICATED, in
 *  "How every figure above was obtained". So on screen they are one click away and on
 *  paper they are unchanged.
 *
 *  WHAT NEVER HIDES, in any state: the structure label, the verdict as a WORD, the
 *  number (or the bound, or an em dash), the bar on the one shared millimetre scale,
 *  and a marker when the measurement carried a caveat. A collapsed row that could hide
 *  a breach would be worse than the wall of text it replaces.
 *
 *  The open/closed state lives in `p.openRows`, NOT in the `<details>` element: this
 *  panel re-renders on every drag frame and every slider tick, and DOM state does not
 *  survive `innerHTML =`.
 */
function clearanceRow(v, m, label, rowKey, p) {
  if (!v || !v.level) return '';
  const caveated = !!((m || {}).caveats || []).length;
  // Forced open, not merely open by default: an ungraded or caveated row is exactly the
  // one a reader must not skim past.
  const forced = v.level === 'no_verdict' || caveated;
  const open = forced || (p.openRows && p.openRows.has(rowKey));
  // REASONS and PROVENANCE are two different things and the server's `because[]` mixes
  // them: "tooth 46 is still present in this scan, so this may be the distance to the
  // tooth being replaced" sits in the same list as "the drawn wall may sit up to 0.46 mm
  // inside the true one at the 95th percentile". The first is why this number cannot be
  // trusted here; the second is how every number in the plan was obtained, identical
  // across implants, and already on the printed sheet DE-DUPLICATED.
  //
  // So the row body shows the headline and the CAVEATS -- the server's own "do not
  // trust this" channel, the one a non-empty entry in which suppresses the verdict --
  // and `because[]` goes one level deeper. Nothing is lost and a forced-open row stays
  // short enough to read.
  const caveats = ((m || {}).caveats) || [];
  return `<details class="crow c-${v.level}" data-row="${esc(rowKey)}" ${open ? 'open' : ''}>
    <summary>
      <span class="vchip v-${v.level}">${VERDICT_WORD[v.level] || v.level}</span>
      <span class="crow-label">${esc(label)}${caveated ? ' <b class="crow-flag" title="this measurement carries a caveat">!</b>' : ''}</span>
      <span class="crow-mm mono">${clearanceValueText(v)}</span>
      ${budgetBar(v, true)}
    </summary>
    <div class="crow-why">
      <p>${esc(v.headline)}</p>
      ${caveats.length
        ? `<ul class="why">${caveats.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>` : ''}
    </div>
  </details>`;
}


/* ------------------------------------------------------------------ plan persistence
 * `api/routes/plans.py` has implemented the whole CRUD surface, an auditable
 * `export.json` and an implant STL in patient LPS since the planning views shipped --
 * and NOTHING called any of it. Implants lived in `state.viewer.plan.implants` and
 * `openCase()` nulled the plan on the way in, so a plan did not survive closing the
 * case. A planning tool you cannot save a plan in is a demo.
 *
 * `PATCH` is a full replace, not a partial patch, so every save sends the whole implant
 * list. `measured` is written with it: the server keeps that as a cache so a plan whose
 * measurement pack has expired can still show its last numbers with the date, and
 * nothing was writing it.
 */
function planListState() {
  const v = state.viewer;
  if (!v) return null;
  v.plans = v.plans || { rows: null, current: null, busy: false, error: null };
  return v.plans;
}

async function loadPlans() {
  const v = state.viewer;
  const ps = planListState();
  if (!v || !ps) return;
  try {
    ps.rows = (await api(`/jobs/${v.jobId}/plans`)).plans || [];
    ps.error = null;
  } catch (e) {
    ps.rows = [];
    ps.error = e.message;
  }
  renderPlanBar();
}

async function savePlan(name) {
  const v = state.viewer;
  const p = implantState();
  const ps = planListState();
  if (!v || !ps) return;
  ps.busy = true; ps.error = null; renderPlanBar();
  const body = {
    name: name || (ps.current && ps.current.name) || 'Plan',
    jaw: p.jaw,
    notes: (ps.current && ps.current.notes) || null,
    implants: p.implants,
  };
  try {
    const saved = ps.current
      ? await api(`/jobs/${v.jobId}/plans/${ps.current.id}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body) })
      : await api(`/jobs/${v.jobId}/plans`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body) });
    ps.current = saved;
  } catch (e) {
    ps.error = e.message;
  }
  ps.busy = false;
  await loadPlans();
}

async function openPlan(planId) {
  const v = state.viewer;
  const ps = planListState();
  const p = implantState();
  if (!v || !ps) return;
  try {
    const row = await api(`/jobs/${v.jobId}/plans/${planId}`);
    ps.current = row;
    ps.error = null;
    p.implants = (row.implants || []).map((i) => ({ ...i }));
    p.selected = p.implants.length ? p.implants[0].id : null;
    p.measured = {}; p.pairs = [];
    // A saved plan may be for the other jaw. Switching redraws the section stack, so
    // it has to happen before anything is measured against the wrong arch.
    if (row.jaw && row.jaw !== p.jaw) selectJaw(row.jaw);
    drawRulers('xs');
    requestMeasure(0);
  } catch (e) {
    ps.error = e.message;
  }
  renderPlanBar();
}

async function deletePlan(planId) {
  const v = state.viewer;
  const ps = planListState();
  if (!v || !ps) return;
  try {
    await api(`/jobs/${v.jobId}/plans/${planId}`, { method: 'DELETE' });
    if (ps.current && ps.current.id === planId) ps.current = null;
  } catch (e) {
    ps.error = e.message;
  }
  await loadPlans();
}

/** Download an authenticated artifact. A plain <a href> cannot carry the bearer token,
 *  so the bytes are fetched and handed to the browser as a blob. */
async function downloadPlanArtifact(planId, path, filename) {
  const v = state.viewer;
  const ps = planListState();
  try {
    const res = await fetch(`${API}/jobs/${v.jobId}/plans/${planId}/${path}`,
                            await authed({}));
    if (!res.ok) {
      let d = null;
      try { d = await res.json(); } catch (_) {}
      throw new Error((d && d.detail) || res.statusText);
    }
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  } catch (e) {
    if (ps) { ps.error = e.message; renderPlanBar(); }
  }
}

function renderPlanBar() {
  const box = $('planBar');
  if (!box) return;
  const ps = planListState();
  const p = implantState();
  if (!ps) { box.innerHTML = ''; return; }
  const rows = ps.rows || [];
  const cur = ps.current;
  const dirty = cur
    ? JSON.stringify(cur.implants || []) !== JSON.stringify(p.implants || [])
    : (p.implants || []).length > 0;
  box.innerHTML = `
    <div class="planbar-row">
      <label class="hint">Plan
        <select id="planPick">
          <option value="">${rows.length ? 'unsaved\u2026' : 'no saved plan'}</option>
          ${rows.map((r) => `<option value="${esc(r.id)}" ${cur && cur.id === r.id ? 'selected' : ''}
             >${esc(r.name)} &middot; ${esc((r.updated_at || r.created_at || '').slice(0, 16).replace('T', ' '))}</option>`).join('')}
        </select>
      </label>
      <input id="planName" type="text" maxlength="120" placeholder="Plan name"
             value="${esc(cur ? cur.name : '')}">
      <button id="planSave" type="button" ${ps.busy || !(p.implants || []).length ? 'disabled' : ''}
        >${cur ? (dirty ? 'Save changes' : 'Saved') : 'Save plan'}</button>
      ${cur ? `<button id="planSaveAs" type="button">Save as new</button>` : ''}
      ${cur ? `<button id="planDel" class="link" type="button">delete</button>` : ''}
    </div>
    ${cur ? `<div class="planbar-row">
      <button id="planExpJson" class="link" type="button">export measurements (JSON)</button>
      <button id="planExpStl" class="link" type="button">implant solids (STL)</button>
      <span class="hint">Patient LPS millimetres, the same frame as the anatomy STLs.</span>
    </div>` : ''}
    ${ps.error ? `<p class="hint bad">${esc(ps.error)}</p>` : ''}`;

  const pick = $('planPick');
  if (pick) pick.onchange = () => { if (pick.value) openPlan(pick.value); };
  const save = $('planSave');
  if (save) save.onclick = () => savePlan(($('planName') || {}).value);
  const asNew = $('planSaveAs');
  if (asNew) asNew.onclick = () => {
    ps.current = null;
    savePlan(($('planName') || {}).value || 'Plan copy');
  };
  const del = $('planDel');
  if (del) del.onclick = () => { if (cur) deletePlan(cur.id); };
  const ej = $('planExpJson');
  if (ej) ej.onclick = () => downloadPlanArtifact(
    cur.id, 'export.json', `${(cur.name || 'plan').replace(/[^\w.-]+/g, '_')}.json`);
  const es = $('planExpStl');
  if (es) es.onclick = () => downloadPlanArtifact(
    cur.id, 'implants.stl', `${(cur.name || 'plan').replace(/[^\w.-]+/g, '_')}-implants.stl`);
}

/** How far off the current section an implant may be and still be drawn on it.
 *  Matches the tolerance `drawImplants` paints with, so the list and the picture agree
 *  about which implants are visible. */
const XS_NEAR_MM = 1.5;

/** The sidebar's implant section: a header that always offers "Add", then one card per
 *  implant, then the pairwise distances.
 *
 *  The add affordance used to be a text link rendered ONLY inside the empty state, and
 *  on the deployed site it was unclickable: `#xsMeta` is absolutely positioned, later
 *  in the DOM and was `pointer-events: auto`, so `elementFromPoint` at the button's
 *  centre returned the caption, not the button. Combined with the chart offering sites
 *  only for ABSENT teeth -- of which a full-dentition case has none -- there was no
 *  reachable way to place an implant at all. A primary action gets a permanent button.
 */
function renderImplantPanel() {
  const p = implantState();
  const box = $('implantPanel');
  if (!box) return;
  const info = ((p.arch || {}).jaws || {})[p.jaw];
  if (!info || !info.ok) { box.innerHTML = ''; return; }

  const canAdd = p.implants.length < MAX_IMPLANTS;
  const head = `<div class="side-head">
      <h4>Implants${p.implants.length ? ' \u00b7 ' + p.implants.length : ''}</h4>
      <span class="spacer"></span>
      <button class="btn-add" id="implantAdd" type="button" ${canAdd ? '' : 'disabled'}
        title="${canAdd ? 'Place an implant on the section in view'
                        : 'A plan holds at most ' + MAX_IMPLANTS + ' implants'}"
        >+ Add implant</button>
    </div>`;

  if (!p.implants.length) {
    box.innerHTML = head + `<p class="hint">No implant placed yet. Add one on the section
      in view, or click any position in the dental chart &mdash; a missing tooth is a
      healed site, a present one is an extraction site.</p>`
      + (p.siteNote ? `<p class="hint bad">${esc(p.siteNote)}</p>` : '');
    wireImplantAdd(info);
    return;
  }

  // One scale for every bar in this panel, computed before any of them is drawn.
  setBarSpan([
    ...p.implants.flatMap((imp) => {
      const m = p.measured[imp.id] || {};
      return [m.verdict, m.accessory_canal_verdict, m.tooth_verdict];
    }),
    ...(p.pairs || []).map((pr) => pr.verdict),
  ]);

  const rows = p.implants.map((imp) => {
    const m = p.measured[imp.id] || {};
    const v = m.verdict || {};
    const sel = p.selected === imp.id;
    const cat = implantSizes();
    const yawOk = canYaw(info);
    const opts = (arr, cur) => arr
      .map((x) => `<option value="${x}" ${x === cur ? 'selected' : ''}>${x}</option>`).join('');
    const title = imp.site_fdi
      ? `FDI ${imp.site_fdi}`
      : `${Math.abs(imp.s_mm).toFixed(1)} mm ${imp.s_mm < 0 ? 'right' : 'left'} of the midline`;
    // An implant more than XS_NEAR_MM off this section is not painted on it. Saying so,
    // with a way to get there, beats an implant that has silently vanished.
    const here = info.cross_sections.s_mm[p.index];
    const off = Math.abs(imp.s_mm - here) > XS_NEAR_MM;
    return `<div class="imp ${sel ? 'sel' : ''}" data-id="${imp.id}" tabindex="0"
         role="button" aria-pressed="${sel}" aria-label="Implant at ${esc(title)}">
      <div class="imp-head">
        <b>${esc(title)}</b>
        <button class="link imp-del" data-del="${imp.id}" type="button"
          aria-label="Remove the implant at ${esc(title)}">remove</button>
      </div>
      <div class="imp-ctl row" data-print="${posePrint(imp)}">
        <span class="sep">&#8960;</span>
        <select data-f="diameter_mm" data-id="${imp.id}"
          aria-label="Diameter in millimetres">${opts(cat.diameter, imp.diameter_mm)}</select>
        <span class="sep">&times;</span>
        <select data-f="length_mm" data-id="${imp.id}"
          aria-label="Length in millimetres">${opts(cat.length, imp.length_mm)}</select>
        <span class="sep">mm</span>
      </div>
      <div class="imp-ang row">
        <span class="sep" title="Buccolingual angulation, in the cross-section plane. Drawn there at true angle.">B</span>
        <input type="number" data-f="tilt_deg" data-id="${imp.id}"
          data-lo="${-MAX_TILT_DEG}" data-hi="${MAX_TILT_DEG}"
          min="${-MAX_TILT_DEG}" max="${MAX_TILT_DEG}" step="1"
          value="${Number(imp.tilt_deg || 0).toFixed(0)}"
          aria-label="Buccolingual angulation in degrees">
        <span class="sep" title="${yawOk ? 'Mesiodistal angulation, along the arch. Drawn at true angle on the panoramic; the cross-section shows it foreshortened.' : 'Unavailable on this case'}">M</span>
        <input type="number" data-f="yaw_deg" data-id="${imp.id}"
          data-lo="${-MAX_YAW_DEG}" data-hi="${MAX_YAW_DEG}"
          min="${-MAX_YAW_DEG}" max="${MAX_YAW_DEG}" step="1"
          value="${Number(imp.yaw_deg || 0).toFixed(0)}" ${yawOk ? '' : 'disabled'}
          title="${yawOk ? '' : 'This case\u2019s arch manifest publishes no tangents, so the direction mesiodistal angulation rotates toward is unknown. Re-running the case publishes them.'}"
          aria-label="Mesiodistal angulation in degrees">
        <span class="sep" title="Clocking: rotation about the implant\u2019s own axis. It moves no clearance \u2014 the measured solid is a body of revolution about that axis \u2014 and is here for the connection.">R</span>
        <input type="number" data-f="roll_deg" data-id="${imp.id}"
          data-lo="-360" data-hi="360" min="-360" max="360" step="${ROLL_STEP_DEG}"
          value="${Number(imp.roll_deg || 0).toFixed(0)}"
          aria-label="Rotation about the implant axis in degrees; changes no measurement">
        ${Number(imp.yaw_deg) ? `<span class="oop" title="Angulated ${Math.abs(Number(imp.yaw_deg)).toFixed(0)}\u00b0 out of the cross-section plane, so the section draws it at ${(Math.abs(Math.cos(Number(imp.yaw_deg) * Math.PI / 180)) * 100).toFixed(0)}% of its length. Every number below is measured in three dimensions.">&#8599;</span>` : ''}
      </div>
      ${off ? `<p class="imp-off">Not on this section &mdash;
        <button type="button" data-goto="${imp.id}">go to it</button></p>` : ''}
      ${p.measuring ? '<p class="hint">measuring&hellip;</p>' : `
        ${clearanceRow(v, m.clearance, 'Nerve canal', imp.id + ':canal', p)}
        ${clearanceRow(m.accessory_canal_verdict, m.accessory_canal,
                       'Incisive / lingual', imp.id + ':acc', p)}
        ${clearanceRow(m.tooth_verdict, m.tooth, 'Adjacent tooth', imp.id + ':tooth', p)}
        ${siteLine(info, imp)}`}
    </div>`;
  }).join('');

  // Pairwise distances belong to the PLAN, not to either implant, so they are rendered
  // once below the list. Every pair is shown, not only the adjacent ones -- "adjacent"
  // is a judgement the app should not be making on the reader's behalf, and the server
  // sorts them so the binding pair is first.
  const pairs = (!p.measuring && (p.pairs || []).length)
    ? `<div class="pairs"><h4>Between implants</h4>` +
      // Escaped ONCE, by `clearanceBlock`. Escaping here as well turned an `&` in an
      // id into `&amp;amp;`.
      p.pairs.map((pr) => clearanceBlock(pr.verdict, `${pr.a} \u2194 ${pr.b}`)).join('') +
      `</div>`
    : '';

  renderPlanBar();
  renderPlanPriors();
  // The two standing notices -- the catalogue's "these are size classes, not a
  // manufacturer's product" and the no-guide notice -- are 483 characters that do not
  // change between implants, between plans or between cases. They are on the printed
  // sheet in full and in the print banner on every page; on screen they are one line
  // that opens. A sentence nobody can avoid is a sentence nobody reads.
  // The provenance, ONCE. The same three sentences -- the holdout prior, the basis, the
  // component-count note -- were repeated under every clearance of every implant, so a
  // two-implant plan printed them six times. `planPrintTable` already collects them
  // de-duplicated under "How every figure above was obtained" and that form is strictly
  // better; this is the same collection, on screen.
  const provenance = [];
  p.implants.forEach((imp) => {
    const m = p.measured[imp.id] || {};
    [m.verdict, m.accessory_canal_verdict, m.tooth_verdict].forEach((v) => {
      ((v || {}).because || []).forEach((w) => {
        if (w && !provenance.includes(w)) provenance.push(w);
      });
    });
    // What each angle does to the numbers, from the SERVER's own `pose.notes` -- so
    // the sentence that clocking changes no clearance, and the sentence that a yawed
    // implant is measured in three dimensions and drawn foreshortened, are stated by
    // the thing that computed them and not paraphrased here.
    ((m.pose || {}).notes || []).forEach((w) => {
      if (w && !provenance.includes(w)) provenance.push(w);
    });
  });
  const notices = [IMPLANT_CATALOG && IMPLANT_CATALOG.notice, p.notice].filter(Boolean);
  box.innerHTML = head + rows + pairs +
    (p.siteNote ? `<p class="hint bad">${esc(p.siteNote)}</p>` : '') +
    // Order matters: when the cache carried the plan, say THAT, not "could not
    // measure" -- the numbers above are real, they are just not from today.
    (p.measuredStale
      ? `<p class="hint warn">Measured ${esc(fmtWhen(p.measuredStale))}; the results have
         since expired, so these could not be recomputed.</p>`
      : p.measureError ? `<p class="hint bad">Could not measure: ${esc(p.measureError)}</p>` : '') +
    (provenance.length
      ? `<details class="sidenote"><summary>How every figure above was obtained</summary>
         <ul class="why">${provenance.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>
         </details>` : '') +
    (notices.length
      ? `<details class="sidenote"><summary>What these numbers are, and are not</summary>
         ${notices.map((n) => `<p class="finding-why">${esc(n)}</p>`).join('')}</details>`
      : '');
  renderVerdictStrip();
  refreshPlanFocus();

  wireImplantAdd(info);

  // Disclosure state -> plan state. Written on toggle rather than read back at render
  // time, so a row the reader opened stays open across the re-render that a drag, a
  // slider tick or a fresh measurement triggers.
  box.querySelectorAll('details.crow[data-row]').forEach((d) => {
    d.addEventListener('toggle', () => {
      if (d.open) p.openRows.add(d.dataset.row); else p.openRows.delete(d.dataset.row);
    });
  });

  box.querySelectorAll('button[data-del]').forEach((b) => {
    b.onclick = (e) => {
      e.stopPropagation();
      const id = b.dataset.del;
      p.implants = p.implants.filter((i) => i.id !== id);
      delete p.measured[id];
      // Was left dangling, so the panel kept a selection that no longer existed and
      // `focusImplant` was called with a dead id.
      if (p.selected === id) p.selected = (p.implants[0] || {}).id || null;
      drawRulers('xs');
      requestMeasure(0);
      renderImplantPanel();
    };
  });
  box.querySelectorAll('button[data-goto]').forEach((b) => {
    b.onclick = (e) => {
      e.stopPropagation();
      const imp = p.implants.find((i) => i.id === b.dataset.goto);
      if (imp) { selectXs(nearestXsIndex(info, imp.s_mm)); renderImplantPanel(); }
    };
  });
  box.querySelectorAll('select[data-f]').forEach((sel) => {
    sel.onchange = () => {
      const imp = p.implants.find((i) => i.id === sel.dataset.id);
      if (imp) { imp[sel.dataset.f] = Number(sel.value); drawRulers('xs'); requestMeasure(0); }
    };
  });
  // Angulation was drag-only, on the apex, at 3 degrees per pixel -- unusable for a
  // stated angle and unreachable without a mouse. The number input is the same value
  // the drag writes, so the two stay in sync through `renderImplantPanel`.
  box.querySelectorAll('input[data-f]').forEach((inp) => {
    inp.onchange = () => {
      const imp = p.implants.find((i) => i.id === inp.dataset.id);
      if (!imp) return;
      const n = Number(inp.value);
      // PER FIELD, from the input's own bounds. This clamped every numeric input to
      // MAX_TILT_DEG, which was right while there was exactly one; with three angles it
      // would have silently pinned clocking to 35 degrees and made five of the six
      // hex index positions unreachable.
      const lo = Number(inp.dataset.lo);
      const hi = Number(inp.dataset.hi);
      const clamped = Math.max(lo, Math.min(hi, Number.isFinite(n) ? n : 0));
      imp[inp.dataset.f] = clamped;
      if (clamped !== n) inp.value = String(clamped);
      drawRulers('xs'); drawRulers('pan'); requestMeasure(0);
    };
  });
  box.querySelectorAll('.imp').forEach((el) => {
    const pick = () => selectImplant(el.dataset.id);
    el.onclick = (e) => {
      if (e.target.closest('button, select, input')) return;
      pick();
    };
    el.onkeydown = (e) => {
      if (e.target.closest('button, select, input')) return;
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      pick();
    };
  });
}

/** The holdout error budget, on screen.
 *
 *  `POST /measure` returns a whole `priors` block -- the p95 the budget deducts, the
 *  worst point ever measured, all three margins and a per-structure table -- and the
 *  only way to see any of it was to PRINT the plan. That is a strange place to keep the
 *  one thing no competitor publishes. Kept visually separate from the findings, and
 *  labelled with its own source line verbatim, because it is a prior about 20 held-out
 *  cases and not a measurement of this scan.
 */
function renderPlanPriors() {
  const box = $('planPriors');
  if (!box) return;
  const p = implantState();
  const pr = p.priors;
  if (!pr) { box.innerHTML = ''; return; }
  const mm = (x) => (typeof x === 'number' ? x.toFixed(2) : '—');
  // Only the structures THIS plan was graded against. `#priorsCard` in the rail already
  // answers "how accurate is the model" over everything; repeating that table here
  // would be the same list twice in one viewport. The question this panel answers is
  // narrower and more useful: what was deducted from the numbers above.
  const by = pr.by_structure || {};
  const used = new Set();
  p.implants.forEach((imp) => {
    const m = p.measured[imp.id] || {};
    [m.verdict, m.accessory_canal_verdict, m.tooth_verdict].forEach((v) => {
      const f = ((v || {}).numbers || {}).field;
      if (f) used.add(f);
    });
  });
  const rows = Object.keys(by).filter((k) => used.has(k)).map((k) => {
    const e = by[k] || {};
    return `<tr><td>${esc(e.label || k)}</td>
      <td class="mono">${mm(e.p95_mm)}</td>
      <td class="mono">${mm(e.worst_mm)}</td></tr>`;
  }).join('');
  // Collapsed by default. The three sentences below are ~340 characters that do not
  // change between implants or between cases, and they are on the printed sheet in
  // full. The one number that has to stay visible without a click is the deduction
  // itself, so it goes in the summary line.
  // WHAT WAS ACTUALLY DEDUCTED, read back from the verdicts rather than taken from the
  // top-level prior. They are the same number on an uncorrected case and they are not
  // on an edited one: `plan_safety` deducts the model's p95 PLUS the display grid's
  // quantisation for a field a person has corrected, so quoting the constant here would
  // have printed 0.46 as "deducted from every clearance" beside bars drawn at 0.76.
  const deducted = [];
  p.implants.forEach((imp) => {
    const m = p.measured[imp.id] || {};
    [m.verdict, m.accessory_canal_verdict, m.tooth_verdict].forEach((v) => {
      const x = ((v || {}).numbers || {}).inward_p95_mm;
      if (typeof x === 'number' && !deducted.includes(x)) deducted.push(x);
    });
  });
  deducted.sort((a, b) => a - b);
  const deductText = deducted.length
    ? (deducted.length === 1 ? `${mm(deducted[0])} mm`
       : `${mm(deducted[0])}\u2013${mm(deducted[deducted.length - 1])} mm`)
    : `${mm(pr.inward_p95_mm)} mm`;
  box.innerHTML = `<details class="sidenote">
    <summary>Error budget &mdash; <span class="mono">${deductText}</span>
      deducted from the clearances above</summary>
    <p class="finding-why">${esc(pr.source || '')}</p>
    <ul class="notelist">
      <li>Every clearance above has <span class="mono">${deductText}</span>
        deducted for how far the contour it was measured to may sit inside the
        truth.</li>
      <li>The worst single point ever measured on the holdout is
        <span class="mono">${mm(pr.worst_measured_inward_mm)} mm</span>. It is quoted, never
        deducted &mdash; deducting a one-voxel outlier would refuse every plan.</li>
      <li>Minimums applied: <span class="mono">${mm(pr.margin_mm)}</span> mm to nerve,
        <span class="mono">${mm(pr.adjacent_margin_mm)}</span> mm to an adjacent tooth,
        <span class="mono">${mm(pr.inter_implant_margin_mm)}</span> mm between implants.</li>
    </ul>
    ${rows ? `<table class="ptable ptable-dark"><thead><tr><th>Graded against</th>
      <th>p95 inward</th><th>worst</th></tr></thead><tbody>${rows}</tbody></table>` : ''}
    ${(() => {
      // A HAND-CORRECTED field is graded against a WIDER budget, and the reader has to
      // be able to see which one and by how much. Both terms separately: "0.76 mm
      // deducted" is not something anybody can check, while "0.46 the model may
      // under-draw plus 0.30 of edit quantisation" is.
      const pen = pr.edit_penalty || {};
      const keys = Object.keys(pen).filter((k) => used.has(k));
      if (!keys.length) return '';
      return `<ul class="notelist">` + keys.map((k) => {
        const base = ((by[k] || {}).p95_mm);
        const add = pen[k].add_p95_mm;
        // ALL THREE NUMBERS. The summary above prints the range across every field, so
        // an edited field's own deduction never appears there -- and "0.30 mm of
        // quantisation" beside a bar drawn at 0.76 is not something a reader can
        // check. The arithmetic, spelled out, is.
        return `<li><b>${esc(((by[k] || {}).label) || k)}</b> was corrected by hand:
          <span class="mono">${mm(base)}</span> the model may under-draw
          + <span class="mono">${mm(add)}</span> of display-grid quantisation
          = <span class="mono">${mm((Number(base) || 0) + (Number(add) || 0))} mm</span>
          deducted. ${esc(pen[k].note)}</li>`;
      }).join('') + `</ul>`;
    })()}
  </details>`;
}

/** Bind the persistent Add button. Separate because the empty state needs it too. */
function wireImplantAdd(info) {
  const b = $('implantAdd');
  if (!b) return;
  b.onclick = () => {
    const p = implantState();
    // At the section in view, which is where the reader is looking. `site_fdi` is null
    // and the adjacent-tooth verdict says so rather than measuring against nothing.
    addImplant(info.cross_sections.s_mm[p.index], null);
  };
}

/** Available bone at this implant's site, from the WORKER's per-site measurement.
 *
 *  `dentistry/ridge.py` has been computing crest-to-canal height and crestal width per
 *  FDI position and publishing it into `arch.json` since it was written, and nothing
 *  read it -- there was not one reference to `height_mm` in this file. It is the only
 *  number that answers the maxillary question at all, because there is no inferior
 *  alveolar canal up there for `canal_verdict` to grade against.
 *
 *  Independent of any placement, so it is stated as a site fact, and a refusal is
 *  printed as a refusal: `measure_sites` emits a complete record every time precisely
 *  so a stale reason cannot survive beside a live value.
 */
/** The bone available at this site, as one line, with its basis behind a disclosure.
 *
 *  `ridge.py`'s `basis_height` and `basis_width` are 224 and 175 characters, and until
 *  now both were printed in full under every implant -- 430 characters of provenance
 *  for two numbers. The numbers are what a reader acts on; the provenance is what they
 *  check once. A refusal, by contrast, stays on the face of the line: "not measured"
 *  with no reason is the kind of blank this product does not ship.
 */
function siteLine(info, imp) {
  if (imp.site_fdi == null) return '';
  const site = (info.sites || {})[String(imp.site_fdi)];
  if (!site) return '';
  const vals = [];
  const why = [];
  if (site.height_mm != null) {
    vals.push(`<span class="mono">${site.height_mm.toFixed(1)}</span> h`);
    if (site.basis_height) why.push(site.basis_height);
  } else if (site.height_reason || site.reason) {
    vals.push('<span class="crow-none">no height</span>');
    why.push(site.height_reason || site.reason);
  }
  if (site.width_mm != null) {
    vals.push(`<span class="mono">${site.width_mm.toFixed(1)}</span> w`);
    if (site.basis_width) why.push(site.basis_width);
  } else if (site.width_reason) {
    vals.push('<span class="crow-none">no width</span>');
    why.push(site.width_reason);
  }
  if (!vals.length) return '';
  return `<details class="crow crow-site">
    <summary><span class="crow-label">Bone at this site</span>
      <span class="crow-mm">${vals.join(' &middot; ')} mm</span></summary>
    <div class="crow-why"><ul class="why">${
      why.map((w) => `<li>${esc(w)}</li>`).join('')}</ul></div>
  </details>`;
}

/** The worst verdict per implant, in the tools row, where the sidebar cannot take it.
 *
 *  This is what makes collapsing the panel safe. `no_verdict` deliberately outranks
 *  `tight`: an ungraded structure is not safer than one measured near its margin, and
 *  a strip that quietly downgraded "we could not grade this" to "fine" would be the
 *  worst thing on the page.
 */
const VERDICT_RANK = { breach: 3, no_verdict: 2, tight: 1, clear: 0 };

/** Every level standing against one implant: the canal, the accessory canals, the
 *  adjacent teeth, and the other implants. Unordered, `no_verdict` included. */
function implantLevels(imp, p) {
  const m = p.measured[imp.id] || {};
  return [m.verdict, m.accessory_canal_verdict, m.tooth_verdict]
    .concat((p.pairs || []).filter((pr) => pr.a === imp.id || pr.b === imp.id)
      .map((pr) => pr.verdict))
    .map((v) => (v || {}).level).filter(Boolean);
}

/** The worst verdict standing against one implant.
 *
 *  Hoisted out of `renderVerdictStrip` so the 3-D safety envelope stops disagreeing with
 *  it. It did disagree, visibly: 3-D was fed `m.verdict.level`, the CANAL verdict alone,
 *  and `plan_safety.canal_verdict` returns `no_verdict` for every maxillary implant
 *  because there is no inferior alveolar canal in the upper jaw. So an upper implant
 *  breaching an adjacent tooth showed red in the strip and neutral in 3-D, from one
 *  measurement, in one frame.
 *
 *  ## Two callers, two rankings, and the difference is deliberate
 *
 *  The STRIP ranks `no_verdict` ABOVE `tight` (see `VERDICT_RANK`): it is a one-chip
 *  summary of whether this implant still needs looking at, and an ungraded structure is
 *  not safer than one measured near its margin.
 *
 *  The 3-D SHELL passes `gradedOnly` and takes the worst over completed grades only,
 *  falling back to neutral just when nothing was graded at all. Applying the strip's
 *  ranking to the shell was measured on the example case and is wrong for it: a lower
 *  molar site with the canal CLEAR at 5.81 mm and the incisive canal CLEAR at >9.7 mm
 *  still carries an ungraded adjacent tooth -- tooth 36 is present, so there is no
 *  extraction socket to measure to -- and the shell went grey. That is greyer than the
 *  canal-only behaviour it replaced, on an implant with two completed clear grades.
 *
 *  The shell is not the place that reports ungradedness; the strip and the clearance
 *  rows both already say NOT GRADED, and `clearanceRow` force-opens on it. The shell's
 *  one job is to colour the envelope by the worst grade actually established, which is
 *  strictly more than the canal alone ever said -- a maxillary implant breaching a
 *  neighbour now turns red, and it never did before.
 */
function worstVerdict(imp, p, opts) {
  p = p || implantState();
  let levels = implantLevels(imp, p);
  if (opts && opts.gradedOnly) levels = levels.filter((lv) => lv !== 'no_verdict');
  if (!levels.length) return null;
  return levels.reduce((a, b) => (VERDICT_RANK[b] > VERDICT_RANK[a] ? b : a));
}

function renderVerdictStrip() {
  const strip = $('verdStrip');
  if (!strip) return;
  const p = implantState();
  if (p.measuring || !p.implants.length) { strip.innerHTML = ''; return; }
  strip.innerHTML = p.implants.map((imp) => {
    const lv = worstVerdict(imp, p);
    if (!lv) return '';
    const name = imp.site_fdi ? `FDI ${imp.site_fdi}` : imp.id;
    return `<span class="vchip v-${lv}" title="worst verdict on this implant"
      >${VERDICT_WORD[lv] || lv}<span class="vid">${esc(name)}</span></span>`;
  }).join('');
}

/** The FDI chart is the implant-site picker: any position is a site.
 *
 *  Every refusal here used to be a silent `return false` into a discarded return value.
 *  Measured on the edentulous example case, that was 31 dead clicks in a row: all 31
 *  absent sites carry `s_mm: null` ("this site has no arc position"), so the one case
 *  this feature exists for responded to nothing at all and said nothing about why.
 */
function syncPlanToIsolate(fdi) {
  const v = state.viewer;
  if (!v || v.mode !== 'plan') return false;
  const arch = (v.report.arch || {}).jaws || {};
  const jaw = String(fdi)[0] <= '2' ? 'maxilla' : 'mandible';
  const fit = arch[jaw];
  const p = planState();
  const say = (msg) => { p.siteNote = msg; renderImplantPanel(); return false; };
  if (!fit || !fit.ok) {
    return say(`FDI ${fdi} is in the ${jaw === 'maxilla' ? 'upper' : 'lower'} jaw, and `
      + `no arch could be fitted to it${fit && fit.reason ? ': ' + fit.reason : ''}.`);
  }
  const site = (fit.sites || {})[String(fdi)];
  if (!site) return say(`This scan publishes no site record for FDI ${fdi}.`);
  if (site.s_mm == null) {
    return say(`FDI ${fdi} has no position on the fitted arch`
      + `${site.reason ? ` (${site.reason})` : ''}, so an implant cannot be placed from `
      + `the chart. Use Add implant on the section you want.`);
  }
  if (p.implants.length >= MAX_IMPLANTS) {
    return say(`A plan holds at most ${MAX_IMPLANTS} implants. Remove one first.`);
  }
  p.siteNote = null;
  if (p.jaw !== jaw) selectJaw(jaw);
  addImplant(site.s_mm, fdi);
  return true;
}

/** Print the plan. No server code and no headless renderer: the canvases are already
 *  in the DOM and print as images, so this is a stylesheet plus one call. */
/** The printed plan.
 *
 *  Every measurement with its BASIS, every caveat, the error budget and the no-guide
 *  notice -- because a printed number with no provenance is the one artifact that
 *  outlives the screen it was read on, and the whole posture of this product is that a
 *  number travels with how it was obtained.
 *
 *  Built into the print stylesheet rather than as a server-rendered PDF: the canvases
 *  are already in the DOM and print as images, so this is markup plus one call. */
function planPrintTable() {
  const p = implantState();
  const cur = (planListState() || {}).current;
  const rows = (p.implants || []).map((imp) => {
    const m = p.measured[imp.id] || {};
    const site = imp.site_fdi ? `FDI ${imp.site_fdi}` : `${imp.s_mm.toFixed(1)} mm`;
    const cell = (v) => {
      if (!v || !v.headline) return '<td class="pnone">not measured</td>';
      const n = v.numbers || {};
      const val = n.clearance_mm != null ? n.clearance_mm : n.distance_mm;
      return `<td class="p-${v.level}">${val != null ? `${val.toFixed(2)} mm` : '&mdash;'}
        <small>${esc(v.headline)}</small></td>`;
    };
    return `<tr>
      <th>${esc(site)}</th>
      <td>${imp.diameter_mm} &times; ${imp.length_mm} mm${
        posePrint(imp) === sizeOnly(imp) ? '' : `, ${esc(anglePrint(imp))}`}</td>
      ${cell(m.verdict)}
      ${cell(m.accessory_canal_verdict)}
      ${cell(m.tooth_verdict)}
      ${(() => {
        // The apex statement -- how much bone lies beyond the apex -- was computed,
        // shown on screen and left out of the printed sheet, which is the artifact
        // somebody carries into a consultation.
        const st = m.statements || {};
        return `<td><small>${esc(st.density || '')}</small>`
          + `${st.apex ? `<small>${esc(st.apex)}</small>` : ''}`
          + `${siteText(imp)}</td>`;
      })()}
    </tr>`;
  }).join('');
  const bases = [];
  (p.implants || []).forEach((imp) => {
    const m = p.measured[imp.id] || {};
    ['clearance', 'accessory_canal', 'tooth', 'density', 'apex'].forEach((k) => {
      const mm = m[k];
      if (mm && mm.basis && !bases.includes(mm.basis)) bases.push(mm.basis);
      (mm && mm.caveats || []).forEach((c) => {
        if (!bases.includes(c)) bases.push(c);
      });
    });
  });
  // Print the pair's reasoning too. It used to carry only the headline, so the one
  // artifact designed to hold provenance dropped the "exact, both solids were placed by
  // you, no segmentation in this figure" justification that makes the number credible.
  const pairs = (p.pairs || []).map((pr) => {
    const v = pr.verdict || {};
    const why = (v.because || []).map((w) => `<small>${esc(w)}</small>`).join('');
    const d = pr.distance || {};
    return `<li>${esc(pr.a)} &harr; ${esc(pr.b)}: ${esc(v.headline || '')}${why}`
      + `${d.basis ? `<small>${esc(d.basis)}</small>` : ''}</li>`;
  }).join('');
  return `
    <h3>${esc(cur ? cur.name : 'Unsaved plan')}</h3>
    <table class="ptable">
      <thead><tr><th>Site</th><th>Implant</th><th>Inferior alveolar canal</th>
        <th>Incisive / lingual canal</th><th>Adjacent tooth</th><th>Bone density</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    ${pairs ? `<h4>Between implants</h4><ul class="pbasis">${pairs}</ul>` : ''}
    ${rulerText()}
    ${(() => {
      // The per-structure BUDGET ARITHMETIC. It was the `.cbar-legend` under every bar
      // on screen and it appeared nowhere on paper, so moving the legend behind a
      // disclosure would have removed it from the record entirely. Spelled out once per
      // implant per structure, which is where a reader checking a number looks.
      const out = [];
      (p.implants || []).forEach((imp) => {
        const m = p.measured[imp.id] || {};
        [['Inferior alveolar canal', m.verdict],
         ['Incisive / lingual canal', m.accessory_canal_verdict],
         ['Adjacent tooth', m.tooth_verdict]].forEach(([label, vv]) => {
          const n = (vv || {}).numbers || {};
          if (n.clearance_mm == null && n.at_least_mm == null) return;
          const site = imp.site_fdi ? `FDI ${imp.site_fdi}` : imp.id;
          out.push(n.clearance_mm == null
            ? `<li><b>${esc(site)} &mdash; ${esc(label)}</b>: more than
               ${Number(n.at_least_mm).toFixed(2)} mm, a bound rather than a measurement,
               against a ${Number(n.margin_mm).toFixed(2)} mm minimum.</li>`
            : `<li><b>${esc(site)} &mdash; ${esc(label)}</b>:
               ${Number(n.clearance_mm).toFixed(2)} mm measured,
               &minus; ${Number(n.inward_p95_mm).toFixed(2)} mm the
               ${esc(n.measured_against || 'segmentation')} may be under-drawn by,
               = ${Number(n.informed_mm).toFixed(2)} mm against a
               ${Number(n.margin_mm).toFixed(2)} mm margin
               &rarr; ${n.headroom_mm >= 0 ? '+' : ''}${Number(n.headroom_mm).toFixed(2)} mm
               of headroom.</li>`);
        });
      });
      return out.length
        ? `<h4>How each clearance was graded</h4><ul class="pbasis">${out.join('')}</ul>`
        : '';
    })()}
    ${(p.measuredStale
      ? `<p class="pnotice">These numbers were measured on ${esc(fmtWhen(p.measuredStale))}
         and saved with the plan. This case's results have since expired, so they could
         not be recomputed.</p>` : '')}
    ${((IMPLANT_CATALOG && IMPLANT_CATALOG.notice)
      ? `<p class="pbasis">${esc(IMPLANT_CATALOG.notice)}</p>` : '')}
    <h4>How every figure above was obtained</h4>
    <ul class="pbasis">${bases.map((b) => `<li>${esc(b)}</li>`).join('')}</ul>
    <h4>The error budget these verdicts allow for</h4>
    <ul class="pbasis">
      ${Object.entries(((p.priors || {}).by_structure) || {}).map(([k, v]) =>
        `<li><b>${esc(v.label)}</b>: the drawn wall may sit up to
          ${v.p95_mm.toFixed(2)} mm inside the true one at the 95th percentile; the worst
          single point measured is ${v.worst_mm.toFixed(2)} mm. ${esc(v.source)}.</li>`).join('')}
      <li>${esc((p.priors || {}).source || '')}</li>
    </ul>
    ${(() => {
      // HAND CORRECTIONS, on paper. A clearance measured to a contour a person moved is
      // a different claim from one measured to the model's, and the sheet is the
      // artifact somebody carries into a consultation -- so the widened budget and the
      // reason for it belong here in full rather than behind a disclosure on screen.
      const ed = (p.priors && p.priors.edits) || [];
      const pen = (p.priors && p.priors.edit_penalty) || {};
      if (!ed.length && !Object.keys(pen).length) return '';
      return `<h4>Hand corrections to the segmentation</h4><ul class="pbasis">`
        + ed.map((e) => `<li>${esc(fmtWhen(e.at))} &mdash;
            ${Number(e.voxels || 0).toLocaleString()} voxels, affecting
            ${esc((e.fields || []).join(', ') || 'no measured field')}.</li>`).join('')
        + Object.entries(pen).map(([f, v]) =>
            `<li><b>${esc(f)}</b>: ${esc(v.note)}</li>`).join('')
        + `</ul>`;
    })()}
    <p class="pbasis">The 3-D view draws a generic threaded screw. The solid this plan
      MEASURES and the solid the STL EXPORTS are the envelope of that thread &mdash; a
      cylinder of the stated diameter and length closed by a rounded apex &mdash; so
      every clearance above is computed against the widest surface the implant can have.
      No manufacturer's thread form, drilling protocol or prosthetic component is
      implied.</p>
    <p class="pnotice">${esc(p.notice || '')}</p>`;
}

/** The site's available bone, as one printable line. Same source as `siteLine`. */
function siteText(imp) {
  const p = implantState();
  const info = ((p.arch || {}).jaws || {})[imp.jaw || p.jaw];
  if (!info || imp.site_fdi == null) return '';
  const site = (info.sites || {})[String(imp.site_fdi)];
  if (!site) return '';
  const bits = [];
  if (site.height_mm != null) bits.push(`${site.height_mm.toFixed(1)} mm bone height`);
  if (site.width_mm != null) bits.push(`${site.width_mm.toFixed(1)} mm crestal width`);
  if (!bits.length) return '';
  return `<small>${esc(bits.join(', '))}</small>`;
}

/** Fill the printed sheet and the repeated banner. Idempotent. */
function fillPrintSheet() {
  const p = planState();
  const v = state.viewer;
  const when = new Date().toISOString().slice(0, 16).replace('T', ' ');
  $('printBanner').textContent =
    `${(v && v.job && (v.job.title || v.job.filename)) || 'case'} \u00b7 ${when} \u00b7 `
    + `research preview, not a medical device \u00b7 ${p.notice || ''}`;
  const sheet = $('planPrintSheet');
  if (sheet) sheet.innerHTML = planPrintTable();
}

function wirePlanPrint() {
  const b = $('planPrint');
  if (!b) return;
  b.onclick = () => { fillPrintSheet(); window.print(); };
  // ALSO on `beforeprint`, and this is now load-bearing rather than a nicety. The
  // on-screen panel is `display: none` on paper -- otherwise every headline, bar and
  // budget printed TWICE, once inline and once on the sheet -- so the sheet is the
  // only copy. It used to be filled by this button alone, which means Ctrl+P, the
  // browser menu and a print stylesheet preview would all have produced a blank page
  // where the plan should be.
  if (!window.__dsvPrintHook) {
    window.__dsvPrintHook = true;
    window.addEventListener('beforeprint', () => {
      const st = state.viewer;
      if (st && st.mode === 'plan') fillPrintSheet();
    });
  }
}

function wirePlan() {
  $('planJawTabs').addEventListener('click', (e) => {
    const b = e.target.closest('.plane');
    if (b && !b.disabled) selectJaw(b.dataset.jaw);
  });
  $('xsSlider').addEventListener('input', (e) => selectXs(Number(e.target.value)));
  // Clicking the panoramic jumps to that arc position and DRAGGING measures on it;
  // both are pointer gestures on the same canvas, so they are wired together in
  // wireRuler() and told apart by whether the pointer moved.
  wirePlanPrint();
  wireRuler();
  // The catalogue is a menu, not per-case data, so it is fetched once and cached.
  loadImplantCatalog().then(() => { if (planState()) renderImplantPanel(); });
  // In CAPTURE order ahead of the ruler: grabbing an implant is a placement gesture,
  // and the ruler must not also start a measurement from the same pointerdown.
  wireImplants();
  wirePanImplants();
  wireXsZoom();
  wireXsPic();
  wirePanPane();
}

/* The segmentation overlay is vector, not raster.
 *
 * `preview/contours.json` holds simplified polygons per plane, per sampled slice,
 * per structure, taken from the same Gaussian-smoothed indicator at iso 0.5 that
 * produced the STL meshes and the RTSTRUCT contours -- so the curve drawn here is
 * the curve in the structure set, not a lookalike. Canvas antialiases fill and
 * stroke at device resolution, which is what makes fill %, outline width and
 * per-structure visibility live controls instead of server round-trips.
 *
 * It replaced a 1-voxel outline PNG per slice: 2.3 MB per case of stair-stepped
 * boundary with no fill to fade, against ~810 KB of curves that stay smooth at any
 * zoom. */
/** Draw one slice's structure outlines. The ONE copy, shared by the tile view and the
 *  plan cross-section.
 *
 *  `slice` is `{structureIndex: [ring, ...]}` with rings in `[row, col]` of the picture
 *  the overlay belongs to; `sx`/`sy` scale those into whatever units the context is in.
 *  That is the whole difference between the two callers: the tile context is in BACKING
 *  STORE pixels so it passed a 2x scale, and `planCtx` has already put the plan
 *  canvas in IMAGE pixels so it passes 1. Getting that backwards puts every contour at
 *  2x and off the picture, which would read as a data bug rather than a units bug --
 *  hence one function with the scale as an argument rather than two copies.
 *
 *  `only`, when given, NARROWS: a structure must be in it AND not hidden. Hiding stays
 *  "do not draw anywhere"; `only` is a per-view preference and can never reveal
 *  something the user has switched off.
 */
function drawContourSlice(ctx, slice, opts) {
  const v = state.viewer;
  const { sx, sy, fill, outline, only } = opts;
  if (!slice || !v || (fill <= 0 && outline <= 0)) return 0;
  // Build one Path2D per structure, then fill everything and stroke everything.
  // Two passes so an outline is never buried under a neighbour's fill.
  const paths = [];
  Object.keys(slice).forEach((sidx) => {
    const idx = Number(sidx);
    if (v.hidden.has(idx)) return;                // hiding is "do not draw"
    if (only && !only.has(idx)) return;
    const colour = colourForIndex(idx);
    if (!colour) return;
    const path = new Path2D();
    slice[sidx].forEach((ring) => {
      ring.forEach(([row, col], i) => {
        const x = col * sx, y = row * sy;
        if (i === 0) path.moveTo(x, y); else path.lineTo(x, y);
      });
      path.closePath();
    });
    paths.push([path, colour]);
  });
  ctx.save();
  if (fill > 0) {
    ctx.globalAlpha = fill;
    paths.forEach(([path, colour]) => {
      ctx.fillStyle = colour;
      // Even-odd, so a nested ring carves a hole instead of filling it solid --
      // the same convention the RTSTRUCT relies on.
      ctx.fill(path, 'evenodd');
    });
  }
  if (outline > 0) {
    ctx.globalAlpha = 1;
    ctx.lineWidth = outline;
    ctx.lineJoin = 'round';
    paths.forEach(([path, colour]) => { ctx.strokeStyle = colour; ctx.stroke(path); });
  }
  ctx.restore();
  return paths.length;
}

/** Fill alpha and outline width, as the two sliders currently read. */
function overlayStyle() {
  return {
    fill: Number($('fillAlpha').value) / 100,
    outline: Number($('outlineW').value),
  };
}

/* ------------------------------------------------------------------- boot */
function wireViewer() {
  // One pair of controls that means the same thing in both views. The single
  // "overlay" slider they replace drove fillAlpha in the MPR view but, in the slice
  // view, had nothing to fade except a 1-voxel outline -- those tiles carried no
  // fill at all, so one control looked broken in one tab and fine in the other.
  //
  // The two halves are updated at very different rates, on purpose. Redrawing the
  // tile view is a canvas fill and stroke, so it tracks the slider live. The MPR
  // view cannot: `segmentation.config.style.setStyle` makes Cornerstone re-render
  // the whole labelmap representation -- `display.render()` per representation,
  // drained one animation frame at a time -- which measured at **over 800 ms for a
  // single change**. Driving that from `input` means a drag queues dozens of
  // full re-renders and the picture arrives seconds behind the handle, which is
  // exactly what "I cannot change the opacity" looks like. So the expensive half
  // fires once the slider settles.
  let styleTimer = null;
  const applyStyle = () => {
    if (!(state.viewer && state.viewer.mprMounted && window.DentistryViewer)) return;
    clearTimeout(styleTimer);
    styleTimer = setTimeout(() => {
      const st = overlayStyle();
      DentistryViewer.setOverlayStyle(st.fill, st.outline);
    }, 200);
  };
  $('fillAlpha').oninput = applyStyle;
  $('outlineW').oninput = applyStyle;
  document.querySelectorAll('.mode').forEach((b) => b.onclick = async () => {
    setMode(b.dataset.mode);
    // `mountVolume` returns immediately once mounted, so the re-jump has to happen
    // here too -- otherwise isolating a tooth in the slice view and switching to
    // MPR left the panes wherever they were, which is indistinguishable from the
    // chart not working. The slice view has always self-healed here (`draw` re-runs
    // Leaving the MPR panes has to give the primary mouse button back. Editing binds
    // it to a brush, and the plan tab's own drag lives on a different canvas -- so a
    // mode left armed here would be a brush waiting on a tab nobody is editing in.
    if (b.dataset.mode !== 'volume') {
      const ed = editState();
      if (ed && ed.on) setEditMode(false);
    }
    if (b.dataset.mode === 'volume') { await mountVolume(); syncMprToIsolate(); }
    else if (b.dataset.mode === 'plan') { await loadArch(); loadPlans(); }
  });
  $('mprReset').onclick = () => window.DentistryViewer && DentistryViewer.resetCameras();
  $('backHome').onclick = closeViewer;
  wireDisplayPop();
  wireEditing();
  wireRail();
  wireLayout();
  wire3d();
  wirePlan();
  document.addEventListener('keydown', (e) => {
    if (!state.viewer || $('workspace').hidden) return;
    if (e.key === 'Escape') {
      // Innermost thing first: a popover over the image, then the case itself.
      if (!$('displayPop').hidden) { closeDisplayPop(); return; }
      closeViewer(); return;
    }
    if (/^(INPUT|TEXTAREA|SELECT)$/.test((e.target || {}).tagName || '')) return;
    // Undo is the one chord this app claims, and it claims it BEFORE the blanket
    // modifier bail below -- Cmd+Z on a planning surface means undo everywhere else and
    // has to here too.
    if ((e.metaKey || e.ctrlKey) && (e.key === 'z' || e.key === 'Z')) {
      if (implantKey(e)) return;
    }
    // Ignore any other chord -- Cmd+1 switches browser tabs and must keep doing so.
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    // The implant tools: nudge, angulate, resize, re-seat, duplicate, step, remove.
    // Before the single-letter view toggles below, so a selected implant owns the keys
    // that move it and the view keeps the ones that do not.
    if (implantKey(e)) return;
    if (e.key === '[') { e.preventDefault(); toggleRail(); return; }
    if (e.key === ']' && state.viewer && state.viewer.mode === 'plan') {
      e.preventDefault(); toggleSide(); return;
    }
    if (e.key === 'o' && state.viewer && state.viewer.mode === 'plan') {
      e.preventDefault();
      const b = $('xsOverlayBtn'); if (b && !b.disabled) b.click();
      return;
    }
    if (e.key === 'z' && state.viewer && state.viewer.mode === 'plan') {
      e.preventDefault();
      const b = $('xsFitBtn'); if (b) b.click();
      return;
    }
    if (e.key === 'p' && state.viewer && state.viewer.mode === 'plan') {
      e.preventDefault();
      const b = $('panPaneBtn'); if (b) b.click();
      return;
    }
    if (e.key === 'b' && state.viewer && state.viewer.mode === 'plan') {
      e.preventDefault();
      const b = $('xsPicBtn'); if (b) b.click();
      return;
    }
    if (e.key === 'd') { e.preventDefault(); toggleDisplayPop(); return; }
    if (e.key === 'e' && state.viewer.mode === 'volume') {
      e.preventDefault();
      const b = $('editBtn'); if (b) b.click();
      return;
    }
    if (state.viewer.mode === 'volume') {
      const pane = { 1: 'axial', 2: 'coronal', 3: 'sagittal', 4: '3d' }[e.key];
      if (pane) { e.preventDefault(); setLayout('focus', pane); return; }
      if (e.key === '0') { e.preventDefault(); setLayout('grid'); return; }
      if (e.key === 'f') { e.preventDefault(); setLayout(layout.kind === 'solo' ? 'grid' : 'solo'); return; }
      return;
    }
    if (e.key === '\\') { e.preventDefault(); toggleDock(); return; }
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    // Scrubbing the cross-section stack is the plan tab's primary gesture. It used to
    // fall through to the Slices tab's `#slice` -- hidden in plan mode -- and then call
    // a `draw()` that early-returned unless the mode was 'slices', so the arrow keys
    // silently moved an invisible control. The Slices tab is gone; the branch stays,
    // because the MPR panes scrub on the wheel and have no business on the arrow keys.
    if (state.viewer.mode !== 'plan') return;
    const xs = $('xsSlider');
    if (!xs) return;
    e.preventDefault();
    const step = e.key === 'ArrowRight' ? 1 : -1;
    const want = Math.max(0, Math.min(Number(xs.max), Number(xs.value) + step));
    xs.value = String(want);
    selectXs(want);
  });
}

/* ------------------------------------------------------- shell and layout */

/* The Display popover.
 *
 * Everything in here used to sit permanently in the stage bar: the 3D mode
 * switch, two sliders, a reset button and a paragraph of prose under the image.
 * That is five controls and three lines of chrome around a medical image, and four
 * of the five are touched once per session if at all. The one that is not -- the
 * view switch and the pane layout -- stayed outside.
 *
 * The popover is NOT unmounted when closed, only hidden: the two range inputs are
 * read by `overlayStyle()`, and rebuilding them would drop their values and their
 * listeners.
 */
function closeDisplayPop() {
  const pop = $('displayPop');
  if (pop) pop.hidden = true;
  const btn = $('displayBtn');
  if (btn) { btn.setAttribute('aria-expanded', 'false'); btn.classList.remove('on'); }
}

function toggleDisplayPop(force) {
  const pop = $('displayPop');
  const btn = $('displayBtn');
  const open = force === undefined ? pop.hidden : !!force;
  pop.hidden = !open;
  btn.setAttribute('aria-expanded', String(open));
  btn.classList.toggle('on', open);
}

function wireDisplayPop() {
  const pop = $('displayPop');
  const btn = $('displayBtn');
  btn.onclick = (e) => { e.stopPropagation(); toggleDisplayPop(); };
  // Clicks inside must not close it -- dragging a slider fires them constantly.
  pop.addEventListener('click', (e) => e.stopPropagation());
  document.addEventListener('click', () => closeDisplayPop());
}

/** Collapse the side panel to give the viewport the whole window. */
function toggleRail(force) {
  const ws = $('workspace');
  const collapsed = force === undefined ? !ws.classList.contains('rail-collapsed') : !!force;
  ws.classList.toggle('rail-collapsed', collapsed);
  $('railToggle').setAttribute('aria-expanded', String(!collapsed));
  $('railToggle').title = (collapsed ? 'Show' : 'Collapse') + ' the side panel  ( [ )';
  try { localStorage.setItem('dentistry.rail', collapsed ? 'off' : 'on'); } catch (_) {}
  afterLayoutChange();
}

/** Collapse the right dock -- tools and structures -- to give the panes the width.
 *
 *  Key `\` rather than `]`, which `toggleSide` already owns for the plan tab's
 *  measurements sidebar. Both are right-hand panels and both can be open at once in the
 *  plan tab, so one key could not mean both without picking a winner silently.
 *
 *  `afterLayoutChange` is NOT optional here. Cornerstone sizes its canvases when a
 *  viewport is enabled and never again, so a collapse that widened the stage without it
 *  leaves every click landing at the wrong voxel -- mis-aimed, not merely stretched. */
function toggleDock(force) {
  const ws = $('workspace');
  const collapsed = force === undefined ? !ws.classList.contains('dock-collapsed') : !!force;
  ws.classList.toggle('dock-collapsed', collapsed);
  const btn = $('dockToggle');
  btn.setAttribute('aria-expanded', String(!collapsed));
  btn.title = (collapsed ? 'Show' : 'Collapse')
    + ' the tools and structures panel  ( \\ )';
  try { localStorage.setItem('dentistry.dock', collapsed ? 'off' : 'on'); } catch (_) {}
  afterLayoutChange();
}

/** Collapse the measurements sidebar. Mirrors `toggleRail`, key `]` beside its `[`.
 *
 *  Safe to collapse only because the verdict strip lives in the TOOLS row, not in the
 *  panel: a collapse that hid the answer and kept the working would be worse than no
 *  collapse at all. */
function toggleSide(force) {
  const stage = $('planStage');
  const btn = $('sideToggle');
  if (!stage || !btn) return;
  const collapsed = force === undefined
    ? !stage.classList.contains('side-collapsed') : !!force;
  stage.classList.toggle('side-collapsed', collapsed);
  btn.setAttribute('aria-expanded', String(!collapsed));
  btn.title = (collapsed ? 'Show' : 'Collapse') + ' the measurements panel  ( ] )';
  try { localStorage.setItem('dentistry.planside', collapsed ? 'off' : 'on'); } catch (_) {}
  // Cornerstone measures a viewport when it is enabled and never again, so a pane that
  // changed size without this reports the OLD box for hit-testing and every click in
  // the 3-D pane lands at the wrong voxel. Not cosmetic.
  afterLayoutChange();
}

/* The two section preferences live at MODULE level, not in plan state.
 *
 * `planState()` returns null until a case is open, and these are wired at BOOT -- so
 * reading plan state here threw `Cannot set properties of null` inside `wireViewer`,
 * which killed `boot()` and left the whole app at "connecting..." with a blank page.
 *
 * The offline harness cannot see this class of defect AT ALL: it sets
 * `DENTISTRY_NO_BOOT = true` and calls `openCase()` directly, so `boot()` ->
 * `wireViewer` -> `wireRail` -> `wireSide` never runs there. Anything that only breaks
 * on the wiring path is invisible to every gate and visible on the first real page load.
 */
const XS_OVERLAY_STATES = ['key', 'all', 'off'];
let xsOverlayPref = 'key';
let xsFitPref = 'site';

/** Cycle the section overlay: key -> all -> off. */
function setXsOverlay(mode) {
  const p = planState();
  xsOverlayPref = XS_OVERLAY_STATES.includes(mode) ? mode : 'key';
  if (p) p.xsOverlay = xsOverlayPref;
  const b = $('xsOverlayBtn');
  if (b) {
    const store = ((p && p.xsc) || {})[p && p.jaw] || {};
    // Three states, three messages. An absent artifact says WHY, because a silently
    // empty overlay is indistinguishable from "there is nothing there".
    b.textContent = store.state === 'unpublished' ? 'outlines: not in this case'
      : store.state === 'failed' ? 'outlines: unavailable'
      : `outlines: ${xsOverlayPref}`;
    b.disabled = store.state === 'unpublished';
    b.title = store.state === 'unpublished'
      ? 'This case was processed before the section outlines existed. Re-upload the scan to get them.'
      : store.state === 'failed'
        ? `The outlines could not be loaded (${store.reason || 'unknown'})`
        : 'Structure outlines on the section  ( o )';
  }
  try { localStorage.setItem('dentistry.xsoverlay', xsOverlayPref); } catch (_) {}
  if (p && p.arch) drawRulers('xs');
}

/** Site-cropped or whole section. */
function setXsFit(mode) {
  const p = planState();
  xsFitPref = mode === 'whole' ? 'whole' : 'site';
  if (p) p.xsFit = xsFitPref;
  const b = $('xsFitBtn');
  if (b) b.textContent = `view: ${xsFitPref}`;
  try { localStorage.setItem('dentistry.xsfit', xsFitPref); } catch (_) {}
  // A full repaint, not just a decoration: the backing store's height changes with the
  // window, so the picture has to be blitted again. `drawRulers` does exactly that --
  // it calls `planCtx` with the current crop and re-draws the held image -- so this no
  // longer goes through `selectXs`, which would re-fetch and re-decode a JPEG that is
  // already on screen.
  if (p && p.arch) {
    const info = ((p.arch || {}).jaws || {})[p.jaw];
    drawRulers('xs');
    if (info && info.ok) renderXsMeta(info);
  }
}

/* ------------------------------------------------------- plan view options
 * Three, and each is a statement about the PICTURE rather than about the anatomy.
 *
 * `zoom`  scales the crop window; see `xsCropRows`. Scroll or pinch on the section.
 * `pane`  gives the panoramic working height instead of locator height, which is what
 *         makes mesiodistal angulation adjustable rather than merely visible.
 * `pic`   brightness and contrast, applied to the JPEG and to nothing else.
 *
 * `pic` is the one that needs a rule written down. The section and the panoramic are
 * SERVER-RENDERED JPEGs, already windowed at a bone window from the full-resolution
 * grid, and every millimetre in this app is measured server-side on that grid. So this
 * cannot change any number, and it must not look as though it could: the filter is set
 * on the context around `drawImage` only, so the outlines, the implant, the envelope
 * rings and the chips are drawn at full strength over an adjusted picture, and the
 * caption says which adjustment is on.
 */
const XS_PIC = [
  { key: 'normal', filter: 'none', label: 'as rendered' },
  { key: 'bright', filter: 'brightness(1.25) contrast(1.05)', label: 'brighter' },
  { key: 'hard', filter: 'brightness(0.95) contrast(1.45)', label: 'harder edges' },
];
let xsPicPref = 'normal';

function picFilter() {
  const hit = XS_PIC.find((x) => x.key === xsPicPref);
  return hit ? hit.filter : 'none';
}

function setXsPic(key) {
  xsPicPref = XS_PIC.some((x) => x.key === key) ? key : 'normal';
  const hit = XS_PIC.find((x) => x.key === xsPicPref);
  const b = $('xsPicBtn');
  if (b) {
    b.textContent = `picture: ${hit.label}`;
    b.title = 'Brightness and contrast of the rendered picture only. It changes no '
      + 'measurement: every millimetre in this app is measured on the full-resolution '
      + 'volume, server-side, and these are pre-windowed JPEGs of it.  ( b )';
  }
  try { localStorage.setItem('dentistry.xspic', xsPicPref); } catch (_) { /* private mode */ }
  const p = planState();
  if (p && p.arch) { drawRulers('xs'); drawRulers('pan'); }
}

function wireXsPic() {
  const b = $('xsPicBtn');
  if (!b) return;
  let start = 'normal';
  try { start = localStorage.getItem('dentistry.xspic') || 'normal'; } catch (_) { /* private */ }
  setXsPic(start);
  b.onclick = () => {
    const i = XS_PIC.findIndex((x) => x.key === xsPicPref);
    setXsPic(XS_PIC[(i + 1) % XS_PIC.length].key);
  };
}

/** Scroll or pinch on the section: step the crop window. See `XS_ZOOM_STEP`. */
function wireXsZoom() {
  const cv = $('xsCanvas');
  if (!cv) return;
  cv.addEventListener('wheel', (e) => {
    const p = planState();
    const info = p && ((p.arch || {}).jaws || {})[p.jaw];
    if (!info || !info.ok) return;
    e.preventDefault();
    // macOS pinch arrives as a wheel event with `ctrlKey` set, so one handler covers
    // the trackpad gesture and the mouse wheel -- the same reason the 3-D pane's zoom
    // is written this way.
    const k = e.deltaY > 0 ? XS_ZOOM_STEP : 1 / XS_ZOOM_STEP;
    p.xsZoom = Math.max(XS_ZOOM_MIN, Math.min(XS_ZOOM_MAX, (Number(p.xsZoom) || 1) * k));
    // Zooming the window while the whole section is shown would do nothing at all, so
    // the gesture implies the cropped view. Stated in the caption either way.
    if ((p.xsFit || xsFitPref) === 'whole') { setXsFit('site'); return; }
    drawRulers('xs');
    renderXsMeta(info);
  }, { passive: false });
  // Double-click restores the default window. A zoom with no way back is a trap.
  cv.addEventListener('dblclick', () => {
    const p = planState();
    const info = p && ((p.arch || {}).jaws || {})[p.jaw];
    if (!info || !info.ok) return;
    p.xsZoom = 1;
    drawRulers('xs');
    renderXsMeta(info);
  });
}

/** The panoramic at working height instead of locator height.
 *
 *  The strip is deliberately short -- its horizontal axis is arc length and it is a
 *  locator, so the pixels belong to the two views you plan against. But it is also the
 *  only plane mesiodistal angulation is visible in, and 104 px of it is not enough to
 *  set an angle on. So it is a TOGGLE, off by default, and the tall state is a mode the
 *  reader chose rather than a default that quietly costs the section 92 px. */
function setPanPane(open) {
  const stage = $('planStage');
  if (!stage) return;
  stage.classList.toggle('pan-tall', !!open);
  const b = $('panPaneBtn');
  if (b) {
    b.setAttribute('aria-pressed', open ? 'true' : 'false');
    b.textContent = open ? 'mesiodistal: open' : 'mesiodistal';
    b.title = open
      ? 'Back to the locator strip, and give the pixels to the section  ( p )'
      : 'Open the panoramic to working height: the plane mesiodistal angulation is '
        + 'drawn in, and the one you can drag it in  ( p )';
  }
  try { localStorage.setItem('dentistry.panpane', open ? '1' : '0'); } catch (_) { /* private */ }
  // Cornerstone measures a viewport once, at enable time, and the 3-D pane is a grid
  // sibling of this one: without the resize a click in it lands on the wrong voxel.
  afterLayoutChange();
  const p = planState();
  if (p && p.arch) { drawRulers('pan'); drawRulers('xs'); }
}

function wirePanPane() {
  const b = $('panPaneBtn');
  if (!b) return;
  let open = false;
  try { open = localStorage.getItem('dentistry.panpane') === '1'; } catch (_) { /* private */ }
  setPanPane(open);
  b.onclick = () => setPanPane(!$('planStage').classList.contains('pan-tall'));
}

function wireXsFit() {
  const b = $('xsFitBtn');
  if (!b) return;
  let start = 'site';
  try { start = localStorage.getItem('dentistry.xsfit') || 'site'; } catch (_) {}
  setXsFit(start);
  b.onclick = () => setXsFit(xsFitPref === 'whole' ? 'site' : 'whole');
}

function wireXsOverlay() {
  const b = $('xsOverlayBtn');
  if (!b) return;
  let start = 'key';
  try { start = localStorage.getItem('dentistry.xsoverlay') || 'key'; } catch (_) {}
  setXsOverlay(start);
  b.onclick = () => {
    const i = XS_OVERLAY_STATES.indexOf(xsOverlayPref);
    setXsOverlay(XS_OVERLAY_STATES[(i + 1) % XS_OVERLAY_STATES.length]);
  };
}

function wireSide() {
  const btn = $('sideToggle');
  if (!btn) return;
  btn.onclick = () => toggleSide();
  wireXsOverlay();
  wireXsFit();
  try {
    if (localStorage.getItem('dentistry.planside') === 'off') toggleSide(true);
  } catch (_) {}
}

function wireRail() {
  $('railToggle').onclick = () => toggleRail();
  $('dockToggle').onclick = () => toggleDock();
  wireSide();
  wireDock();
  try {
    if (localStorage.getItem('dentistry.rail') === 'off') toggleRail(true);
  } catch (_) {}
  try {
    if (localStorage.getItem('dentistry.dock') === 'off') toggleDock(true);
  } catch (_) {}
  ['seriesCard', 'runCard'].forEach((id) => {
    const el = $(id);
    if (!el) return;
    try {
      const saved = localStorage.getItem('dentistry.fold.' + id);
      if (saved !== null) el.open = saved === 'open';
    } catch (_) {}
    el.addEventListener('toggle', () => {
      try { localStorage.setItem('dentistry.fold.' + id, el.open ? 'open' : 'shut'); } catch (_) {}
    });
  });
}

const layout = { kind: 'grid', pane: 'axial' };

/** Cornerstone sizes its canvases when a viewport is enabled and never again.
 *
 * So every layout change needs an explicit resize, or the old canvas stays stretched
 * over the new box: the image letterboxes and, worse, every click lands at the wrong
 * voxel because the canvas-to-world mapping is stale. One frame of delay so the grid
 * has actually reflowed before we measure it -- `requestAnimationFrame`, never
 * awaited, because awaiting one in a load path deadlocked `mount()` in a background
 * tab and left cases stuck on "loading" forever.
 */
/** Move the LIVE Cornerstone 3-D pane between the MPR grid and the plan stage.
 *
 *  The plan tab needs a 3-D view -- placing an implant you cannot see in space is the
 *  feature working on paper only -- and `#cs3d` lived inside `#mprStage`, which
 *  `setMode` hides whenever the plan tab is open. So the implants were pushed into a
 *  zero-sized hidden viewport on every drag frame, and `focusImplant` reframed a camera
 *  nobody could look at: you placed implants in a tab with no 3-D and saw the 3-D in a
 *  tab where you could not place them.
 *
 *  Reparenting rather than mounting a second viewport. A second one would hold another
 *  copy of the volume and all 42 surfaces on the GPU to show the same picture. Moving
 *  the mounted element keeps its WebGL context -- verified on the RTX 3080: the pane
 *  came back 416x416 with an 832x832 backing store, 42 surfaces and both implant
 *  actors intact. `resize()` is what makes it stick, because Cornerstone measures a
 *  viewport at enable time and never again.
 */
function move3dPane(where) {
  const pane = document.querySelector('.pane-3d');
  if (!pane) return;
  const host = where === 'plan' ? $('plan3d') : $('mprStage');
  if (!host || pane.parentElement === host) return;
  // `.pane-3d` is a `.grid4` child in the MPR stage and must go back in its grid slot;
  // in the plan stage it fills its host. One class, toggled, rather than inline styles.
  pane.classList.toggle('in-plan', where === 'plan');
  host.appendChild(pane);
  const empty = $('plan3dEmpty');
  if (empty) {
    empty.hidden = where === 'plan' && !!(state.viewer && state.viewer.mprMounted);
    empty.textContent = (state.viewer && state.viewer.mprMounted)
      ? '' : 'the 3-D view needs the volume, which is still loading';
  }
  afterLayoutChange();
}

function afterLayoutChange() {
  requestAnimationFrame(() => {
    if (window.DentistryViewer && state.viewer && state.viewer.mprMounted) DentistryViewer.resize();
    // The plan tab had no branch here at all, so a window resize or a rail collapse
    // left the 3-D pane at its old canvas size and never repainted the section's
    // overlays. Both matter now that the 3-D pane lives in this stage.
    if (state.viewer && state.viewer.mode === 'plan' && state.viewer.plan
        && state.viewer.plan.arch) {
      drawRulers('xs'); drawRulers('pan');
      // `resize()` re-fits the camera to the new viewport, which throws away the
      // framing `focusImplant` set. Collapsing the rail or resizing the window would
      // otherwise silently zoom back out to the whole jaw and lose the implant the
      // reader was looking at.
      const sel = state.viewer.plan.selected;
      if (sel && window.DentistryViewer && DentistryViewer.focusImplant) {
        DentistryViewer.focusImplant(sel);
      }
    }
  });
}

function setLayout(kind, pane) {
  layout.kind = kind;
  if (pane) layout.pane = pane;
  // "focus"/"solo" with nothing chosen yet means the last pane the user picked.
  const stage = $('mprStage');
  stage.classList.toggle('focus', kind === 'focus');
  stage.classList.toggle('solo', kind === 'solo');
  stage.querySelectorAll('.pane').forEach((p) => {
    p.classList.toggle('is-focus', kind !== 'grid' && p.dataset.pane === layout.pane);
  });
  document.querySelectorAll('#layoutPicker .segb')
    .forEach((b) => b.classList.toggle('on', b.dataset.layout === kind));
  afterLayoutChange();
}

function wireLayout() {
  document.querySelectorAll('#layoutPicker .segb').forEach((b) => {
    b.onclick = () => setLayout(b.dataset.layout);
  });
  // Double-click a pane to enlarge it, double-click it again to go back. The handler
  // goes on `.pane` rather than `.cs`: Cornerstone's tools own the inner element, and
  // a double-click there also delivers two window/level drags.
  $('mprStage').addEventListener('dblclick', (e) => {
    const pane = e.target.closest && e.target.closest('.pane');
    if (!pane || !pane.dataset.pane) return;
    e.preventDefault();
    const already = layout.kind === 'focus' && layout.pane === pane.dataset.pane;
    setLayout(already ? 'grid' : 'focus', pane.dataset.pane);
  });
  // The panes also change size when the window does, and when the sidebar animates.
  let rt = null;
  window.addEventListener('resize', () => {
    clearTimeout(rt);
    rt = setTimeout(afterLayoutChange, 120);
  });
}

async function boot() {
  // Sign in FIRST. Everything below needs a token, and the alternative -- render,
  // then 401, then redirect -- flashes an empty workspace on every cold load.
  let pendingPlan = null;
  if (AUTH) {
    // Read ?plan= before init(), which strips its own callback params.
    pendingPlan = pendingPlanFromUrl();
    let user = null;
    try { user = await AUTH.init(); } catch (err) { console.error('[auth]', err); }
    if (!user) {
      // Not a dead end: the landing page is the public face and this is the app.
      showSignIn(pendingPlan);
      return;
    }
  }

  wireDropzone();
  wireViewer();
  wireJobFilter();
  wireAccountMenu();
  wireSettings();
  window.addEventListener('hashchange', () => route());

  try {
    state.catalog = await api('/structures');
    // The hero used to claim "37 structures" in hand-written prose, which went
    // stale the moment the taxonomy grew to 47. The catalogue is the only thing
    // that knows.
    if (state.catalog && state.catalog.count) $('factStructures').textContent = state.catalog.count;
  } catch (_) {}

  await refreshAccount();
  // Both are cheap and both change what the catalogue renders -- the switcher in
  // the account menu, and the "by ..." line on a shared workspace's cards.
  await Promise.all([refreshWorkspaces(), loadMembers()]);
  renderAccount();
  refreshSystem(); refreshJobs(); loadExamples();
  await route();

  // A CTA on the pricing page lands here with ?plan=; take them straight there
  // rather than making them find the button again.
  if (pendingPlan && state.me && state.me.billingEnabled) startCheckout(pendingPlan);

  state.poll = setInterval(() => {
    refreshSystem();
    // Poll fast only while something is moving; a done-only list does not need a
    // request every two seconds.
    const active = state.jobs.some((j) => j.state === 'running' || j.state === 'queued');
    if (active || Date.now() % 20000 < 2500) refreshJobs();
  }, 2500);
}

/** The pre-auth screen. Deliberately not an error: nothing has gone wrong. */
function showSignIn(pendingPlan) {
  const gate = $('signinGate');
  ['home', 'settings', 'workspace', 'inviteGate'].forEach((id) => {
    const el = $(id); if (el) el.hidden = true;
  });
  $('nav').hidden = true;
  $('usageChip').hidden = true;
  $('acctBtn').hidden = true;
  // `boot()` returns before `refreshSystem()` ever runs on this path, so the pill
  // would read "connecting..." for as long as the gate is on screen. Queue depth is
  // also not something to tell a stranger.
  $('sysstrip').hidden = true;
  if (!gate) { AUTH.signIn(location.pathname + location.search); return; }
  gate.hidden = false;
  const btn = $('signinBtn');
  if (btn) {
    btn.onclick = () => AUTH.signIn(
      location.pathname + (pendingPlan ? '?plan=' + pendingPlan : ''));
  }
}
// The harnesses (web-auth/check-rail.mjs and web/selftest.html) load this file to call
// individual render functions against a fixture; booting would immediately try to reach
// Keycloak and the API and fail. Nothing else sets this flag, so the browser path is
// unchanged.
if (!window.DENTISTRY_NO_BOOT) boot();
