'use strict';
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
  const card = (m) => {
    const mode = modelMode(m);
    const off = !m.installed;
    const n = (m.structures || []).length;
    // What it owns, as a COUNT plus the first few names. Thirty-two tooth ids as chips
    // is a wall, and the question is which family rather than which tooth.
    const owns = n === 0 ? 'nothing by default'
      : n > 6 ? `${n} structures &mdash; ${m.groups.join(', ')}`
      : m.structures.map((x) => structureName(x) || x).join(', ');
    const fixed = (m.modes || []).length < 2;
    const modes = fixed ? `<span class="modelfixed" title="${esc(MODE_WHY[m.modes && m.modes[0]] || '')}">always runs</span>`
      : (m.modes || []).map((k) => `
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
      <div class="modelrow">
        ${fixed ? modes : `<div class="seg modelmodes" role="group"
             aria-label="How ${esc(m.name)} runs">${modes}</div>`}
        <span class="modelcost">${m.seconds ? `~${Math.round(m.seconds)} s` : ''}</span>
      </div>
      ${off ? `<p class="hint">Not installed on this server.</p>` : ''}
      <details class="sidenote">
        <summary>What is measured about it</summary>
        <p class="finding-why">${esc(m.evidence || '')}</p>
        ${m.tradeoff ? `<p class="finding-why">${esc(m.tradeoff)}</p>` : ''}
        <p class="finding-why">Licence: ${esc(m.license || 'unstated')}.</p>
        ${off && m.reason ? `<p class="finding-why">Why it is unavailable: ${esc(m.reason)}</p>` : ''}
      </details>
    </article>`;
  };

  box.innerHTML = (menu.models || []).map(card).join('');

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
  // From the upload line to the choice it summarises. A scroll, not a route: the hash
  // belongs to the router, and `#modelsPanel` would be read as an unknown view.
  const change = $('changeModels');
  if (change) {
    change.onclick = (e) => {
      e.preventDefault();
      $('modelsPanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
    };
  }
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

