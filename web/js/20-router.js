'use strict';
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
  if (r.view !== 'settings') { state.newInvite = null; stopPairing(); }
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

