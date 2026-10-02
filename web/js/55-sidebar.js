'use strict';
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
    ${m.source ? `<p class="finding-why"><b>${esc(m.source)}</b></p>` : ''}
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
           .join('\n'), 'warn']
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
  // Two lines (the cell is `white-space: pre-line`): which teeth, then the worst one.
  return `${fdis.join(', ')}\nlargest ${Math.round(worst.mm3)} mm³ on ${worst.fdi}`;
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
      if (v && v.isolated.has(s.index)) cls.push('sel');
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
              title="Isolate ${esc(s.name)} and go to it — ${ADD_KEY}-click to add it to the isolate"
              >${esc(s.name)}${mark}${pmark}</span>
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
      if (e.target.dataset.act === 'isolate') { toggleIsolate(idx, addKey(e)); return; }
      const h = state.viewer.hidden;
      if (h.has(idx)) { h.delete(idx); row.classList.remove('off'); }
      else { h.add(idx); row.classList.add('off'); }
      // Hiding something by hand is not an isolate any more: the hidden set no longer
      // matches the selection, and leaving the rows marked `sel` would claim it does.
      state.viewer.isolated.clear();
      state.viewer.isolateLast = null;
      renderIsolateClear();
      // In place rather than a re-render: this list is scrolled and filtered while it
      // is being used, and rebuilding it under the pointer loses both.
      el.querySelectorAll('.srow.sel').forEach((n) => n.classList.remove('sel'));
      pushVisibility([idx]);
      renderArch(state.viewer.report);
    };
  });
  $('toggleAll').onclick = () => {
    const all = [...presentIndices()];
    const hideAll = state.viewer.hidden.size === 0;
    state.viewer.hidden = hideAll ? new Set(all) : new Set();
    state.viewer.isolated.clear();
    state.viewer.isolateLast = null;
    $('toggleAll').textContent = hideAll ? 'show all' : 'hide all';
    renderIsolateClear();
    pushVisibility(all);
    renderStructures(r);
    renderArch(r);
  };
  $('isolateClear').onclick = () => clearIsolate();
  // Re-render, not just toggle: the button carries the selection COUNT, so a render
  // triggered by anything else (the filter, a reopened case) has to restate it.
  renderIsolateClear();
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

