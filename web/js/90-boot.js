'use strict';
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
