'use strict';
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
    <div class="card-head"><h3>Plan</h3></div>
    <div class="planbar-row">
      <label class="hint">
        <select id="planPick" aria-label="Saved plans on this case">
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
      <button id="planExpStl" class="link"
        title="Patient LPS millimetres, the same frame as the anatomy STLs."
        type="button">implant solids (STL)</button>
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
        <span class="sep">&deg;</span>
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
      if (!imp) return;
      imp[sel.dataset.f] = Number(sel.value);
      drawRulers('xs'); requestMeasure(0);
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

