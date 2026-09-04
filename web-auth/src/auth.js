/**
 * DentistryAuth — the app's entire authentication surface, six functions wide.
 *
 * RECONSTRUCTED 2026-09-01. The built bundle `web/auth.js` survived the deletion of the
 * project tree; its source did not, and there is no sourcemap. So this is a
 * re-implementation of the wrapper, not a decompilation: the bulk of those 71 KB is
 * vendored `oidc-client-ts`, and what was actually lost is the ~120 lines below.
 *
 * The contract is fixed by `web/app.js`, which reads `window.DentistryAuth` at module
 * top level and calls exactly:
 *
 *     init()         -> the signed-in user, or null. Also completes a redirect callback.
 *     isSignedIn()   -> boolean, synchronous. Used to decide whether a 401 is worth retrying.
 *     profile()      -> {sub, email, username} or null.
 *     token()        -> a fresh access token, or null. May silently renew.
 *     signIn(returnTo)
 *     signOut()
 *
 * Every setting below was read out of the surviving bundle rather than guessed, because
 * a wrong `redirect_uri` or `client_id` fails at the identity provider with an error the
 * user sees and cannot act on.
 */
import { UserManager, WebStorageStateStore } from 'oidc-client-ts';

/** The app is served under /app, and Keycloak's registered redirect URI ends there.
 *  Derived from the current path rather than hardcoded so a preview host still works. */
function appRoot() {
  const p = window.location.pathname;
  const i = p.indexOf('/app');
  return window.location.origin + (i >= 0 ? p.slice(0, i + 4) : '/app');
}

const settings = {
  authority: 'https://auth.dicomsegvr.com/realms/dicomsegvr',
  client_id: 'dentistry-console',
  redirect_uri: appRoot() + '/',
  post_logout_redirect_uri: window.location.origin + '/',
  response_type: 'code',                 // authorization code + PKCE; no implicit flow
  scope: 'openid profile email',
  automaticSilentRenew: true,
  accessTokenExpiringNotificationTimeInSeconds: 60,
  includeIdTokenInSilentRenew: true,
  // Session monitoring needs a third-party iframe against the IdP, which modern
  // browsers block anyway. Renewal is handled by the silent-renew path instead.
  monitorSession: false,
  // sessionStorage, not localStorage: a token that outlives the tab is a token left
  // behind on a shared machine.
  userStore: new WebStorageStateStore({ store: window.sessionStorage }),
  stateStore: new WebStorageStateStore({ store: window.sessionStorage }),
};

let manager = null;
let user = null;
let renewing = null;

function mgr() {
  manager = manager || new UserManager(settings);
  return manager;
}

/**
 * Complete a redirect callback if we are on one, then report the current user.
 *
 * The OAuth parameters are stripped from the address bar afterwards: leaving `code` and
 * `state` in the URL means a refresh replays a one-time code and fails confusingly, and
 * it puts them in the browser history.
 */
export async function init(overrides) {
  if (overrides) Object.assign(settings, overrides);
  const m = mgr();
  const q = new URLSearchParams(window.location.search);
  if (q.has('code') && q.has('state')) {
    try {
      user = await m.signinRedirectCallback();
      const url = new URL(window.location.href);
      ['code', 'state', 'session_state', 'iss'].forEach((k) => url.searchParams.delete(k));
      // `returnTo` comes back from the IdP inside the state, so it is attacker-influenced
      // in principle. Only a same-origin ABSOLUTE path is honoured -- "//evil.example" is
      // a protocol-relative URL and would leave the site.
      const want = user && user.state && user.state.returnTo;
      const to = (typeof want === 'string' && want.startsWith('/') && !want.startsWith('//'))
        ? want
        : url.pathname + url.search + url.hash;
      window.history.replaceState({}, '', to);
    } catch (err) {
      console.error('[auth] callback failed:', err);
      await m.removeUser().catch(() => {});
    }
  }
  if (!user) user = await m.getUser().catch(() => null);
  if (user && user.expired) user = null;
  return user;
}

export function signIn(returnTo) {
  const here = window.location.pathname + window.location.search + window.location.hash;
  return mgr().signinRedirect({ state: { returnTo: returnTo || here } });
}

export function signOut() {
  user = null;
  return mgr().signoutRedirect();
}

/**
 * A usable access token, renewing silently if the current one has expired.
 *
 * The in-flight renewal is shared. `app.js` calls this before every request, so a page
 * that fires six fetches on load would otherwise start six concurrent renewals against
 * the IdP and race to store six users.
 */
export async function token() {
  if (user && !user.expired && user.access_token) return user.access_token;
  if (!renewing) {
    renewing = mgr().signinSilent()
      .then((u) => { user = u; return u; })
      .catch((err) => { console.warn('[auth] silent renew failed:', err); return null; })
      .finally(() => { renewing = null; });
  }
  const u = await renewing;
  return u && u.access_token ? u.access_token : null;
}

export function profile() {
  if (!user) return null;
  const p = user.profile || {};
  return { sub: p.sub, email: p.email, username: p.preferred_username || p.email };
}

export const isSignedIn = () => !!(user && !user.expired);
