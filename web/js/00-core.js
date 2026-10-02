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
// hardcoded, so the same files work at the root of a host and under a path prefix.
// One directory UP from the script, because the scripts live in `js/`; `location`
// (no script URL, e.g. evaluated by a harness) is already the mount.
const BASE = (() => {
  const src = document.currentScript && document.currentScript.src;
  const dir = new URL(src ? '..' : '.', src || location.href).pathname;
  return dir.replace(/\/$/, '');
})();
const API = BASE + '/v1';
const $ = (id) => document.getElementById(id);

// The deployment's own settings (web/config.js, rewritten by the container at start).
const CFG = window.DENTISTRY_CONFIG || {};

// A CDN in front of the app may cap a request body (Cloudflare: 100 MB), and an upload
// above that dies at the edge with a bare 413 that says nothing about why. Checked here
// so the message names the real limit instead. No CDN configured, no cap.
const EDGE_BODY_LIMIT_MB = Number(CFG.edgeBodyLimitMB) || 0;
const EDGE_BODY_LIMIT = EDGE_BODY_LIMIT_MB ? EDGE_BODY_LIMIT_MB * 1024 * 1024 : Infinity;

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
  // The headset pairing code, the same shape for the same reason: the server returns
  // the plaintext exactly once and `renderHeadsets` rebuilds its whole panel.
  // `{id, code, payload, expiresAt, expired, ticks, warned}`; `stopPairing` clears it.
  pairing: null,
  devices: null,   // /v1/pair/devices, loaded by the settings view
  ttlHours: 72,    // overwritten by /v1/system; never hardcode a deployment setting
};

/* ------------------------------------------------------------------ utils */
// Accounts are on only when the deployment names an OpenID Connect provider. Without
// one the app runs anonymously against an API that does not require a token.
const AUTH = (CFG.oidc && window.DentistryAuth) || null;

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
  if (res.status === 401 && AUTH) { AUTH.signIn(location.pathname + location.hash); throw new Error('Signing in'); }
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
/* `null` and `undefined` escape to NOTHING, not to their own names.
   `String(undefined)` is the four-letter word "undefined", and this function is the last
   thing every readout in the app passes through -- so one absent field anywhere renders
   the word into the page as though it were a value. Found exactly that way: the model
   priors card printed "How accurate is the model? undefined" above the Dice table,
   because the accuracy payload carried no `source`. `BAD_TOKENS` in check-rail.mjs exists
   to catch this class; it was invisible only because the card is `display: none` in the
   plan tab and `innerText` skips what is not rendered. */
const esc = (s) => (s == null ? '' : String(s)).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

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

