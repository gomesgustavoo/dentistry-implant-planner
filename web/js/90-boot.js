'use strict';
async function boot() {
  // Sign in FIRST. Everything below needs a token, and the alternative -- render,
  // then 401, then redirect -- flashes an empty workspace on every cold load.
  let pendingPlan = null;
  if (AUTH) {
    // Read ?plan= before init(), which strips its own callback params.
    pendingPlan = pendingPlanFromUrl();
    let user = null;
    try { user = await AUTH.init(CFG.oidc); } catch (err) { console.error('[auth]', err); }
    if (!user) {
      // No sign-in page: straight to the identity provider, and back to the catalogue.
      // A live provider session answers with an immediate redirect, so a returning
      // reader never sees a form at all.
      redirectToSignIn(pendingPlan);
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

/** Where a signed-out arrival is sent back to after the provider: the page it asked
 *  for, or the catalogue. `?plan=` survives the round trip so a pricing-page CTA still
 *  lands on checkout; an invite link keeps its hash and so keeps its token. */
function signInReturnTo(pendingPlan) {
  return location.pathname + (pendingPlan ? '?plan=' + pendingPlan : '')
    + (location.hash && location.hash !== '#' ? location.hash : '#/cases');
}

/** The hand-off to the identity provider. Deliberately not an error and not a page:
 *  only the logomark and one live line are painted, and a way out appears only if the
 *  redirect has visibly stalled (a blocked pop-up policy, an unreachable provider). */
function redirectToSignIn(pendingPlan) {
  ['home', 'settings', 'contact', 'workspace', 'inviteGate'].forEach((id) => {
    const el = $(id); if (el) el.hidden = true;
  });
  // `boot()` returns before `refreshSystem()` ever runs on this path, so the pill
  // would read "connecting..." for as long as the splash is up. Queue depth is also
  // not something to tell a stranger.
  ['nav', 'usageChip', 'acctBtn', 'sysstrip'].forEach((id) => {
    const el = $(id); if (el) el.hidden = true;
  });
  const to = signInReturnTo(pendingPlan);
  const splash = $('authSplash');
  if (splash) splash.hidden = false;
  const go = () => Promise.resolve(AUTH.signIn(to)).catch((err) => {
    console.error('[auth] redirect failed:', err);
    const fb = $('authFallback'); if (fb) fb.hidden = false;
  });
  const retry = $('authRetry');
  if (retry) retry.onclick = go;
  setTimeout(() => { const fb = $('authFallback'); if (fb) fb.hidden = false; }, 5000);
  go();
}

// The harnesses (web-auth/check-rail.mjs and web/selftest.html) load this file to call
// individual render functions against a fixture; booting would immediately try to reach
// Keycloak and the API and fail. Nothing else sets this flag, so the browser path is
// unchanged.
if (!window.DENTISTRY_NO_BOOT) boot();
