'use strict';
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

