'use strict';
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
      `${EDGE_BODY_LIMIT_MB} MB by the CDN, so this one cannot get through yet — chunked upload is a ` +
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
    // The panel is laid out from the first paint, with its row reserved, so the models
    // section below it does not jump ~300 px when the examples arrive. Only a deployment
    // that has none hides it -- once, at the end.
    if (!examples.length) { $('examplesPanel').hidden = true; return; }
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
  } catch (_) {
    // Examples are a nicety; never block the app on them.
    $('examplesPanel').hidden = true;
  }
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

