'use strict';
/* ------------------------------------------------------------------ ruler */
/* A ruler is only honest on a picture whose millimetres-per-pixel is exact, and only
 * two of this app's surfaces qualify.
 *
 * The CROSS-SECTION does. `worker/panoramic.py` builds each column as `P0 + t*n` with
 * `up = (0,0,1)`, and `n` has no z-component -- so {n, up} is an ORTHONORMAL basis and
 * the picture is a genuine isometric plane section. Pixel distance times pitch is true
 * millimetres in any direction, diagonals included.
 *
 * The PANORAMIC does not, and cannot be made to. Its horizontal axis is arc length
 * swept through a 12 mm curved trough, so a straight line between two points reads long
 * by roughly (1 + t/R) -- up to ~5% at the trough edge on a tight anterior arch. Only
 * its vertical axis is metric, so only a vertical measurement is offered there. A number
 * you can read is a number somebody will use, so the wrong one is not offered at all.
 *
 * Not the MPR panes, either: those show `worker/volume_pack.py`'s 8-bit volume,
 * downsampled to ~0.66 mm. A ruler there would disagree with the server about the same
 * gap, which is the one failure this whole surface exists to avoid. That is also why
 * the Cornerstone LengthTool stays unused.
 */
function rulerState() {
  const p = planState();
  if (!p.rulers) p.rulers = {};
  return p;
}

/** The (t, z) millimetre frame of one cross-section, straight out of arch.json v2. */
function xsFrame(info) {
  const xs = info.cross_sections;
  return {
    rowPitch: xs.pixel_mm[0],
    colPitch: xs.pixel_mm[1],
    zTop: xs.z_top_mm,
    tMin: (xs.t_range_mm || [-xs.half_width_mm, xs.half_width_mm])[0],
  };
}

/** Cross-section pixel -> the arch-frame (t, z) pair, in millimetres. */
function xsPixelToTZ(info, row, col) {
  const f = xsFrame(info);
  return { t_mm: f.tMin + col * f.colPitch, z_mm: f.zTop - row * f.rowPitch };
}

/** Cross-section pixel -> patient LPS millimetres. Exact; see the block comment. */
function xsPixelToLps(info, i, row, col) {
  const k = info.cross_sections.source_indices[i];
  const P0 = info.points[k];
  const n = info.normals[k];
  const { t_mm, z_mm } = xsPixelToTZ(info, row, col);
  return [P0[0] + t_mm * n[0], P0[1] + t_mm * n[1], z_mm];
}

/** Panoramic pixel -> LPS. The column IS a polyline index; only the row is metric. */
function panPixelToLps(info, row, col) {
  const k = Math.max(0, Math.min(Math.round(col), info.points.length - 1));
  const P0 = info.points[k];
  const pitch = info.panoramic.pixel_mm[0];
  return [P0[0], P0[1], info.panoramic.z_top_mm - row * pitch];
}

/** Where this canvas's rulers live. Per cross-section: a measurement that follows you
 *  to a different slice is measuring something you cannot see. */
function rulerKey(which) {
  const p = planState();
  return which === 'pan' ? `pan:${p.jaw}` : `xs:${p.jaw}:${p.index}`;
}

function rulerLabel(r, info, which) {
  const f = xsFrame(info);
  if (which === 'pan') {
    const mm = Math.abs(r.b.y - r.a.y) * info.panoramic.pixel_mm[0];
    return `${mm.toFixed(2)} mm vertical`;
  }
  const dt = (r.b.x - r.a.x) * f.colPitch;
  const dz = (r.b.y - r.a.y) * f.rowPitch;
  return `${Math.hypot(dt, dz).toFixed(2)} mm`;
}

function drawRulers(which) {
  const p = rulerState();
  const info = ((p.arch || {}).jaws || {})[p.jaw];
  if (!info || !info.ok) return;
  const cv = $(which === 'pan' ? 'panCanvas' : 'xsCanvas');
  const img = which === 'pan' ? p.panImage : p.xsImage;
  const { g, w, h } = planCtx(cv, isDrawable(img) ? img : null,
                              which === 'pan' ? panAspectX(info) : 1,
                              which === 'xs' ? xsCropRows(info) : null);
  g.clearRect(0, 0, w, h);
  if (isDrawable(img)) {
    // The brightness/contrast preference, on the PICTURE and on nothing else. Set
    // around `drawImage` and cleared immediately, so every overlay below -- outlines,
    // implant, envelope rings, chips, scale bar -- is drawn at full strength on top.
    const filt = picFilter();
    if (filt !== 'none' && 'filter' in g) g.filter = filt;
    g.drawImage(img, 0, 0, w, h);
    if ('filter' in g) g.filter = 'none';
  }
  if (which === 'pan') { drawArcMarkerOn(g, info, cv); drawPanImplants(g, cv, info); }

  if (which === 'xs') {
    // Anatomy first, then the implant on top of it: the implant is the thing being
    // positioned and must never be the thing that is occluded.
    drawXsContours(g, info);
    drawImplants(g, info);
    drawDistances(g, cv, info);
    drawSectionFrame(g, cv, info);
    syncImplants3d();
  }
  const list = p.rulers[rulerKey(which)] || [];
  const live = p.dragging && p.dragging.which === which ? [p.dragging] : [];
  [...list, ...live].forEach((r, i) => {
    const vertical = which === 'pan';
    const ax = r.a.x;
    const bx = vertical ? r.a.x : r.b.x;
    g.save();
    g.strokeStyle = '#38bdf8'; g.fillStyle = '#38bdf8';
    g.lineWidth = 1.5; g.setLineDash(r === p.dragging ? [4, 3] : []);
    g.beginPath(); g.moveTo(ax, r.a.y); g.lineTo(bx, r.b.y); g.stroke();
    g.setLineDash([]);
    g.restore();
    // Round dots, not ellipses. Drawn in image pixels under the panoramic's anisotropic
    // transform they came out 3.3x wider than tall.
    withScreenUnits(g, cv, (px) => {
      g.fillStyle = '#38bdf8';
      [[ax, r.a.y], [bx, r.b.y]].forEach(([x, y]) => {
        const [sx, sy] = px(x, y);
        g.beginPath(); g.arc(sx, sy, 3.5, 0, Math.PI * 2); g.fill();
      });
    });
    g.save();
    g.restore();
    const text = rulerLabel({ a: { x: ax, y: r.a.y }, b: { x: bx, y: r.b.y } }, info, which);
    const mx = (ax + bx) / 2; const my = (r.a.y + r.b.y) / 2;
    // In SCREEN units. Drawn under `planCtx`'s transform the glyphs were stretched
    // 3.3x on the panoramic and their on-screen size floated between ~11 and ~20 CSS px
    // depending on which canvas they landed on.
    withScreenUnits(g, cv, (px) => {
      const [sx, sy] = px(mx + 6, my);
      drawChip(g, cv, sx, sy, text, { size: 12, fg: '#e6f6ff' });
    });
  });
}

/* -------------------------------------------------------------- glyphs and chips
 * Every decoration in this file used to be drawn in IMAGE pixels, under the transform
 * `planCtx` sets. Two consequences, both measured:
 *
 *  - on the PANORAMIC that transform is anisotropic (sx = 2 * 3.324, sy = 2), so every
 *    endpoint dot rendered as an ellipse 3.3x wider than tall, every glyph was stretched
 *    3.3x, and `lineWidth` was direction-dependent;
 *  - the font was 13 IMAGE pixels, so its ON-SCREEN size floated with the picture --
 *    about 20 CSS px on the 240-wide section and about 11 on the panoramic.
 *
 * `withScreenUnits` runs a block under the identity transform, so a millimetre of text
 * is a millimetre of text. Geometry stays in image pixels; only the ink changes units.
 */
function withScreenUnits(g, cv, fn) {
  const ax = cv.dsvAx || 1;
  g.save();
  g.setTransform(1, 0, 0, 1, 0, 0);
  // Image pixel -> backing-store pixel, so a caller can place a glyph at a geometric
  // point without re-deriving the transform.
  const y0 = cv.dsvY0 || 0;
  fn((x, y) => [x * XS_RENDER_SCALE * ax, (y - y0) * XS_RENDER_SCALE]);
  g.restore();
}

/** A label chip, clamped inside the canvas.
 *
 *  The ruler chips were never clamped: `fillRect(mx + 8, my - 16, w, 20)` runs straight
 *  off the right edge for anything near the last column, and off the top for anything
 *  in the first 16 rows. With three distance chips competing for a 240 px picture that
 *  stops being an edge case. */
function drawChip(g, cv, x, y, text, opts) {
  const o = opts || {};
  g.font = `600 ${o.size || 12}px ui-monospace, ui-sans-serif, monospace`;
  const tw = g.measureText(text).width;
  const w = tw + 10; const h = (o.size || 12) + 8;
  let cx = Math.min(Math.max(2, x), cv.width - w - 2);
  let cy = Math.min(Math.max(2, y - h), cv.height - h - 2);
  if (!Number.isFinite(cx)) cx = 2;
  if (!Number.isFinite(cy)) cy = 2;
  g.fillStyle = o.bg || 'rgba(8,12,20,.86)';
  g.fillRect(cx, cy, w, h);
  if (o.edge) { g.strokeStyle = o.edge; g.lineWidth = 1; g.strokeRect(cx + .5, cy + .5, w - 1, h - 1); }
  g.fillStyle = o.fg || '#e6f6ff';
  g.fillText(text, cx + 5, cy + h - 6);
  return { x: cx, y: cy, w, h };
}

/* ------------------------------------------------- distances on the cross-section
 * "Print the distance for the segmented parts" -- drawn where the direction is KNOWN,
 * and only there.
 *
 * The direction comes from `approach_direction`, which the server already computes and
 * already publishes as a word. The words that lie in the section plane -- buccal,
 * lingual, apical, coronal and their pairs -- are drawn as a leader of the published
 * length from the implant surface. `mesial` and `distal` are ALONG the arch: they are
 * out of this plane by construction, and a line drawn for them would be a projection
 * whose length is not the number beside it. Those get an edge marker and the word.
 *
 * No new server field, no descent on a distance field, no new failure mode: the number
 * on the chip is the number the panel shows, and the line is only ever drawn when its
 * length IS that number.
 */
const APPROACH_TZ = {
  buccal: [1, 0], lingual: [-1, 0], apical: [0, 1], coronal: [0, -1],
};

/** Unit (t, z) for an approach word, in the implant's own frame; null if out of plane. */
function approachVector(word, imp) {
  if (!word) return null;
  const parts = String(word).split(/\s+and\s+|\s+/).filter((w) => APPROACH_TZ[w]);
  if (!parts.length) return null;
  // "between apical and lingual" is the sum of its two unit directions.
  let a = 0; let b = 0;
  parts.forEach((w) => { a += APPROACH_TZ[w][0]; b += APPROACH_TZ[w][1]; });
  const n = Math.hypot(a, b);
  if (!n) return null;
  // Apical/coronal are along the implant AXIS, buccal/lingual across it, so the word is
  // resolved in the implant's frame and then rotated into the section's.
  const down = imp.jaw === 'maxilla' ? 1 : -1;
  const sa = Math.sin(imp.tilt_deg * Math.PI / 180);
  const sb = down * Math.cos(imp.tilt_deg * Math.PI / 180);
  const across = a / n; const along = b / n;
  return [across * -sb + along * sa, across * sa + along * sb];
}

/** Draw the clearances for the selected implant on the section. */
function drawDistances(g, cv, info) {
  const p = implantState();
  // NEVER while a measurement is in flight. The panel blanks its numbers during a drag
  // for exactly this reason: `p.measured` still holds the PREVIOUS pose's answer, and a
  // crisp two-decimal chip anchored to the implant's new position would assert a
  // distance nobody computed.
  if (p.measuring || !p.selected) return;
  const imp = p.implants.find((i) => i.id === p.selected);
  if (!imp || imp.jaw !== p.jaw) return;
  const here = info.cross_sections.s_mm[p.index];
  if (Math.abs(imp.s_mm - here) > XS_NEAR_MM) return;
  const m = p.measured[imp.id] || {};
  const f = xsFrame(info);
  const { a: sa, b: sb, fore, yawed } = sectionAxis(imp);
  const r = imp.diameter_mm / 2;

  const rows = [
    ['clearance', 'verdict', 'canal', m.approach],
    ['accessory_canal', 'accessory_canal_verdict', 'incisive', null],
    ['tooth', 'tooth_verdict', 'tooth', null],
  ];
  const chips = [];
  rows.forEach(([mk, vk, label]) => {
    const mm = m[mk]; const v = m[vk] || (mk === 'clearance' ? m.verdict : null);
    if (!mm || !v || !v.level) return;
    const val = mm.value;
    const bound = ((v.numbers || {}).at_least_mm);
    if (val == null && bound == null) return;
    const u = Number((mm.detail || {}).at_depth_mm || 0);
    // The implant-side end: on the AXIS at the argmin depth, pushed out to the surface.
    // `u` is a depth along the TRUE axis, so it is foreshortened onto the picture the
    // same way every other mark on the implant is.
    const base = { t: imp.t_mm + sa * u * fore, z: imp.z_mm + sb * u * fore };
    // No caliper on an out-of-plane pose. The clearance is a three-dimensional number
    // and its projection into this section is shorter, so a line drawn at the printed
    // length would measure something that is not on screen -- the same reason
    // mesial/distal never get one. The chip stays; only the line goes.
    const dir = (mk === 'clearance' && !yawed) ? approachVector(m.approach, imp) : null;
    const cue = verdictColour(v, false);
    const text = val == null ? `> ${Number(bound).toFixed(1)}` : `${val.toFixed(2)}`;
    if (dir && val != null && val > 0) {
      const from = { t: base.t + dir[0] * r, z: base.z + dir[1] * r };
      const to = { t: from.t + dir[0] * val, z: from.z + dir[1] * val };
      const a = tzToPixel(info, from.t, from.z);
      const b = tzToPixel(info, to.t, to.z);
      g.save();
      g.strokeStyle = cue; g.lineWidth = 1.2; g.setLineDash([4, 3]);
      g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.stroke();
      g.setLineDash([]);
      // Caliper jaws, so the segment reads as a measurement and not as an axis.
      const perp = [-dir[1], dir[0]];
      const jaw = 1.1 / f.colPitch;
      [[a, from], [b, to]].forEach(([q, w]) => {
        const j1 = tzToPixel(info, w.t + perp[0] * 1.1, w.z + perp[1] * 1.1);
        const j2 = tzToPixel(info, w.t - perp[0] * 1.1, w.z - perp[1] * 1.1);
        g.beginPath(); g.moveTo(j1.x, j1.y); g.lineTo(j2.x, j2.y); g.stroke();
        return jaw;
      });
      g.restore();
      chips.push([(a.x + b.x) / 2, (a.y + b.y) / 2, `${text} ${label}`, cue, true]);
    } else {
      // Direction unknown or out of the section plane. The NUMBER is still true; a line
      // would not be, so there is none -- and the chip says so with a mark rather than
      // with a sentence. "direction not in this plane" measured 230 px on a 366 px
      // picture, which is more ink than the number saves; the words are in the panel
      // and on the printed sheet, where there is room for them.
      const a = tzToPixel(info, base.t + (imp.t_mm >= 0 ? r : -r), base.z);
      chips.push([a.x, a.y, `${text} ${label} \u2197`, cue, false]);
    }
  });
  if (!chips.length) return;
  withScreenUnits(g, cv, (px) => {
    // Stacked downward from each anchor, so three chips on a 240 px picture do not
    // land on top of one another. `drawChip` clamps each to the canvas.
    const used = [];
    chips.forEach(([x, y, text, cue, anchored]) => {
      const [sx, sy] = px(x + 6, y);
      let ty = sy;
      for (let k = 0; k < 12 && used.some((u) => Math.abs(u - ty) < 22); k++) ty += 22;
      used.push(ty);
      const box = drawChip(g, cv, sx, ty, text, { size: 12, edge: cue, fg: '#eef4ff' });
      // A hairline back to where the number belongs, for the ones with no leader: the
      // chip has been pushed off its anchor by the stacking, and a floating number
      // beside an implant would otherwise look like it names the nearest thing to it.
      if (!anchored) {
        const [ax0, ay0] = px(x, y);
        g.strokeStyle = cue; g.globalAlpha = .5; g.lineWidth = 1;
        g.beginPath(); g.moveTo(ax0, ay0); g.lineTo(box.x, box.y + box.h / 2); g.stroke();
        g.globalAlpha = 1;
      }
    });
  });
}

/** The measurable band, and the scale. Both are statements about the PICTURE. */
function drawSectionFrame(g, cv, info) {
  const p = planState();
  const f = xsFrame(info);
  const band = ((p.measured || {}).__band) || null;
  // The band the measurement pack covers: t in [-12, +12], z over the lattice. Outside
  // it the picture is visible but UNMEASURED, and nothing on screen said so. Published
  // per case in the pack header; the fallback is the documented default.
  const t0 = (band && band.t0) != null ? band.t0 : -12;
  const t1 = (band && band.t1) != null ? band.t1 : 12;
  const a = tzToPixel(info, t0, f.zTop);
  const b = tzToPixel(info, t1, f.zTop - (info.cross_sections.size[0] - 1) * f.rowPitch);
  g.save();
  g.strokeStyle = 'rgba(148,163,184,.30)';
  g.lineWidth = 1; g.setLineDash([3, 5]);
  g.strokeRect(Math.min(a.x, b.x), 0, Math.abs(b.x - a.x), planSize(cv).h);
  g.restore();

  withScreenUnits(g, cv, (px) => {
    // A 10 mm bar: the largest round length under 40% of the 36.1 mm picture width.
    const mmBar = 10;
    const x0 = px(4, 0)[0]; const y0 = cv.height - 14;
    const len = (mmBar / f.colPitch) * XS_RENDER_SCALE * (cv.dsvAx || 1);
    g.strokeStyle = 'rgba(230,246,255,.85)'; g.lineWidth = 2;
    g.beginPath();
    g.moveTo(x0, y0); g.lineTo(x0 + len, y0);
    g.moveTo(x0, y0 - 3); g.lineTo(x0, y0 + 3);
    g.moveTo(x0 + len, y0 - 3); g.lineTo(x0 + len, y0 + 3);
    g.stroke();
    g.font = '600 11px ui-monospace, monospace';
    g.fillStyle = 'rgba(230,246,255,.85)';
    g.fillText(`${mmBar} mm`, x0 + len + 6, y0 + 4);
    // Which way is buccal. A buccolingual section with no orientation letters is
    // ambiguous, and the manifest publishes `t_axis: "buccal_positive"`.
    const buccalRight = (info.cross_sections.t_axis || 'buccal_positive') === 'buccal_positive';
    g.font = '600 12px ui-sans-serif, sans-serif';
    g.fillStyle = 'rgba(230,246,255,.7)';
    g.fillText(buccalRight ? 'L' : 'B', 6, cv.height / 2);
    const rt = g.measureText(buccalRight ? 'B' : 'L').width;
    g.fillText(buccalRight ? 'B' : 'L', cv.width - rt - 6, cv.height / 2);
  });
}

/** The arc marker, factored out so drawRulers can repaint it without recursing. */
function drawArcMarkerOn(g, info, cv) {
  const p = planState();
  const src = info.cross_sections.source_indices[p.index];
  const x = (src / Math.max(1, info.panoramic.size[1] - 1)) * (planSize(cv).w - 1);
  g.save();
  g.strokeStyle = '#ffd23b'; g.lineWidth = 2; g.globalAlpha = 0.9;
  g.beginPath(); g.moveTo(x, 0); g.lineTo(x, planSize(cv).h); g.stroke();
  g.restore();
}

/* ------------------------------------------- the panoramic as the MESIODISTAL view
 * Two things were true at once: the panoramic strip did not show where any implant
 * was, and mesiodistal angulation was pinned to zero because no view could show it.
 * They are the same gap. The cross-section is the BUCCOLINGUAL plane -- `tilt` lives
 * there and is drawn at true angle -- and the plane `yaw` lives in is (s, z), which is
 * exactly the plane the panoramic reconstructs.
 *
 * This chart is honest in the ARCH frame, and says where it is not. Columns are
 * polyline indices at `step_mm` apiece, rows are `pixel_mm[0]` of true z, and `planCtx`
 * already folds the 3.32x pixel anisotropy into the backing store -- so a capsule drawn
 * here in `(s_mm, z_mm)` has the right angle and the right length in that frame. What it
 * is NOT is straight-line millimetres: `s` is arc length along the mid-line, so a
 * structure at buccolingual offset `t` reads long by about `1 + t/R`. That is
 * `metric_axes: "vertical_only"`, which `arch.json` already publishes, and it is
 * exactly zero at `t = 0`, which is where a seated implant starts. The authoritative
 * figure is still the three-dimensional one `/measure` returns; this is where the ANGLE
 * is set, and no millimetre is printed on this canvas.
 */

/** `(s, z)` millimetres -> panoramic image pixels. Mirrors `drawArcMarkerOn`'s column
 *  map exactly, so the section marker and an implant at the same `s` line up. */
function panPixelOf(info, cv, sMm, zMm) {
  const step = Number(info.step_mm) || 0.5;
  const s0 = Number(info.s0_index) || 0;
  const cols = Math.max(2, Number(info.panoramic.size[1]) || 2);
  const w = planSize(cv).w;
  const k = Number(sMm) / step + s0;
  return { x: (k / (cols - 1)) * (w - 1),
           y: (Number(info.panoramic.z_top_mm) - Number(zMm))
              / Number(info.panoramic.pixel_mm[0]) };
}

/** The inverse, for the drag. */
function panMmOf(info, cv, pt) {
  const step = Number(info.step_mm) || 0.5;
  const s0 = Number(info.s0_index) || 0;
  const cols = Math.max(2, Number(info.panoramic.size[1]) || 2);
  const w = planSize(cv).w;
  const k = pt.x * ((cols - 1) / Math.max(1, w - 1));
  return { s_mm: (k - s0) * step,
           z_mm: Number(info.panoramic.z_top_mm)
                 - pt.y * Number(info.panoramic.pixel_mm[0]) };
}

/** The panoramic's view of one pose: the in-plane axis unit and the foreshortening.
 *
 *  The same Minkowski argument `sectionAxis` sets out, one plane over. Dropping the
 *  `t` component of `(sin y, sin t cos y, down cos t cos y)` leaves
 *  `(sin y, down cos t cos y)`, whose norm is what this plane loses -- so here it is
 *  BUCCOLINGUAL tilt that foreshortens and yaw that is drawn at true angle, the exact
 *  mirror of the section. */
function panAxis(imp) {
  const down = imp.jaw === 'maxilla' ? 1 : -1;
  const tl = (Number(imp.tilt_deg) || 0) * Math.PI / 180;
  const yw = (Number(imp.yaw_deg) || 0) * Math.PI / 180;
  const s = Math.sin(yw);
  const z = down * Math.cos(tl) * Math.cos(yw);
  const n = Math.hypot(s, z) || 1;
  return { ds: s / n, dz: z / n, fore: n, tilted: Math.abs(tl) > 1e-9 };
}

/** The implant outline in the panoramic's own `(s, z)` millimetres. */
function panImplantOutline(imp) {
  const r = imp.diameter_mm / 2;
  const { ds, dz, fore } = panAxis(imp);
  const shoulder = (imp.length_mm - r) * fore;
  const pt = (u, w) => [imp.s_mm + ds * u - dz * w, imp.z_mm + dz * u + ds * w];
  const out = [pt(0, r), pt(shoulder, r)];
  for (let i = 1; i < 12; i += 1) {
    const th = (i / 12) * Math.PI;
    out.push(pt(shoulder + r * Math.sin(th), r * Math.cos(th)));
  }
  out.push(pt(shoulder, -r), pt(0, -r));
  return out;
}

/** Every implant of this jaw, on the panoramic. The SAME colour rule as the section:
 *  the body is titanium grey, and the only coloured mark is the collar band. */
function drawPanImplants(g, cv, info) {
  const p = implantState();
  if (!info || !info.ok || !info.panoramic) return;
  (p.implants || []).forEach((imp) => {
    if (imp.jaw !== p.jaw) return;
    const sel = p.selected === imp.id;
    const cue = verdictColour((p.measured[imp.id] || {}).verdict, p.measuring);
    const r = imp.diameter_mm / 2;
    const { ds, dz, fore } = panAxis(imp);
    const at = (u, w) => panPixelOf(info, cv,
      imp.s_mm + ds * u * fore - dz * w, imp.z_mm + dz * u * fore + ds * w);
    const poly = panImplantOutline(imp).map(([s, z]) => panPixelOf(info, cv, s, z));

    g.save();
    g.beginPath();
    poly.forEach((q, i) => (i ? g.lineTo(q.x, q.y) : g.moveTo(q.x, q.y)));
    g.closePath();
    g.fillStyle = 'rgba(199,204,212,.18)';
    g.fill();
    g.strokeStyle = IMPLANT_BODY;
    g.lineWidth = sel ? 2 : 1.2;
    g.stroke();

    // The axis, which on this canvas IS the mesiodistal angulation.
    const a0 = at(0.4, 0); const a1 = at(imp.length_mm - r * 0.4, 0);
    g.beginPath(); g.moveTo(a0.x, a0.y); g.lineTo(a1.x, a1.y);
    g.strokeStyle = 'rgba(199,204,212,.55)';
    g.lineWidth = sel ? 1 : 0.7;
    g.setLineDash([2, 3]); g.stroke(); g.setLineDash([]);

    // The collar band carries the verdict here too, so a reader glancing at the strip
    // sees WHICH implant is the problem without opening the panel.
    g.beginPath();
    [[0, r], [COLLAR_BAND_MM, r], [COLLAR_BAND_MM, -r], [0, -r]].forEach(([u, w], i) => {
      const q = at(u, w);
      return i ? g.lineTo(q.x, q.y) : g.moveTo(q.x, q.y);
    });
    g.closePath();
    g.fillStyle = cue;
    g.globalAlpha = sel ? 0.85 : 0.55;
    g.fill();
    g.globalAlpha = 1;
    g.restore();
  });
}

/** Which part of an implant a panoramic click landed on. Mirrors `hitTest`, in (s, z).
 *  `apex` is the yaw handle, `body` moves the implant along the arch. */
function panHitTest(imp, info, cv, pt) {
  const q = panMmOf(info, cv, pt);
  const { ds, dz, fore } = panAxis(imp);
  const dS = q.s_mm - imp.s_mm;
  const dZ = q.z_mm - imp.z_mm;
  const along = dS * ds + dZ * dz;
  const across = Math.abs(-dS * dz + dZ * ds);
  const len = imp.length_mm * fore;
  if (across > imp.diameter_mm / 2 + 1.0) return null;
  if (along < -1.0 || along > len + 1.0) return null;
  if (along > len - 1.4) return 'apex';
  return 'body';
}

function wireRuler() {
  [['xsCanvas', 'xs'], ['panCanvas', 'pan']].forEach(([id, which]) => {
    const cv = $(id);
    cv.addEventListener('pointerdown', (e) => {
      const p = rulerState();
      const info = ((p.arch || {}).jaws || {})[p.jaw];
      if (!info || !info.ok) return;
      const pt = canvasPoint(cv, e);
      if (!pt) return;
      // A plain click on the panoramic still jumps the arc; a DRAG measures. The
      // threshold is applied on pointerup, so neither gesture has to be declared first.
      p.dragging = { which, a: { x: pt.x, y: pt.y }, b: { x: pt.x, y: pt.y }, moved: false };
      cv.setPointerCapture(e.pointerId);
    });
    cv.addEventListener('pointermove', (e) => {
      const p = planState();
      if (!p.dragging || p.dragging.which !== which) return;
      const pt = canvasPoint(cv, e);
      if (!pt) return;
      let { x, y } = pt;
      // Shift constrains to the axis the drag is already closest to.
      if (e.shiftKey && which === 'xs') {
        if (Math.abs(x - p.dragging.a.x) > Math.abs(y - p.dragging.a.y)) y = p.dragging.a.y;
        else x = p.dragging.a.x;
      }
      p.dragging.b = { x, y };
      p.dragging.moved = Math.hypot(x - p.dragging.a.x, y - p.dragging.a.y) > 4;
      drawRulers(which);
    });
    cv.addEventListener('pointerup', (e) => {
      const p = planState();
      if (!p.dragging || p.dragging.which !== which) return;
      const d = p.dragging;
      p.dragging = null;
      if (d.moved) {
        const key = rulerKey(which);
        (p.rulers[key] = p.rulers[key] || []).push({ a: d.a, b: d.b });
        renderRulerList();
      } else if (which === 'pan') {
        jumpToArcColumn(d.a.x);
      }
      drawRulers(which);
      try { cv.releasePointerCapture(e.pointerId); } catch { /* already gone */ }
    });
  });
  // Escape here CLAIMS the key, because the viewer's own Escape handler closes the
  // case. Both are on `document` in the bubble phase and this one is registered first,
  // so without stopping propagation "Esc clears" -- which is what the panel's own hint
  // promises -- cleared the rulers and then discarded every unsaved implant with them.
  // Only claimed when there was actually something to clear; otherwise Escape must
  // still close the case, which is the behaviour everywhere else in the app.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const p = state.viewer && state.viewer.plan;
    if (!p || !p.rulers) return;
    const had = p.dragging || Object.keys(p.rulers).some((k) => (p.rulers[k] || []).length);
    if (!had) return;
    e.stopPropagation();
    e.preventDefault();
    p.rulers = {}; p.dragging = null;
    drawRulers('xs'); drawRulers('pan'); renderRulerList();
  });
}

/** The measured list under the section, with a delete affordance per entry. */
/** The rulers, for the printed sheet.
 *
 *  `#rulerList` lives in the sidebar, and the sidebar is `display: none` on paper now
 *  that the panel no longer double-prints. A ruler is a measurement the user took by
 *  hand on this case; dropping it from the record would be the exact loss the sheet
 *  exists to prevent. Location included, because a number with no place in the patient
 *  is not a measurement.
 */
function rulerText() {
  const p = rulerState();
  const info = ((p.arch || {}).jaws || {})[p.jaw];
  if (!info || !info.ok) return '';
  const items = [];
  [['xs', rulerKey('xs')], ['pan', rulerKey('pan')]].forEach(([which, key]) => {
    (p.rulers[key] || []).forEach((r) => {
      const a = which === 'pan' ? { x: r.a.x, y: r.a.y } : r.a;
      const b = which === 'pan' ? { x: r.a.x, y: r.b.y } : r.b;
      const lps = which === 'pan'
        ? [panPixelToLps(info, a.y, a.x), panPixelToLps(info, b.y, b.x)]
        : [xsPixelToLps(info, p.index, a.y, a.x), xsPixelToLps(info, p.index, b.y, b.x)];
      const fmt = (q) => `(${q.map((v) => v.toFixed(1)).join(', ')})`;
      items.push(`<li>${esc(rulerLabel({ a, b }, info, which))}
        <small>${which === 'pan' ? 'panoramic, vertical axis only' : 'cross-section'},
        from ${fmt(lps[0])} to ${fmt(lps[1])} mm in patient LPS</small></li>`);
    });
  });
  return items.length
    ? `<h4>Measurements taken by hand</h4><ul class="pbasis">${items.join('')}</ul>` : '';
}

function renderRulerList() {
  const p = rulerState();
  const info = ((p.arch || {}).jaws || {})[p.jaw];
  const box = $('rulerList');
  if (!info || !info.ok) { box.innerHTML = ''; return; }
  const items = [];
  [['xs', rulerKey('xs')], ['pan', rulerKey('pan')]].forEach(([which, key]) => {
    (p.rulers[key] || []).forEach((r, i) => {
      const a = which === 'pan' ? { x: r.a.x, y: r.a.y } : r.a;
      const b = which === 'pan' ? { x: r.a.x, y: r.b.y } : r.b;
      // Where in the PATIENT this was measured, not just where on the picture. The
      // two mappings are the same ones the server uses, so a measurement can be
      // located in the scan afterwards rather than being an anonymous number.
      const lps = which === 'pan'
        ? [panPixelToLps(info, a.y, a.x), panPixelToLps(info, b.y, b.x)]
        : [xsPixelToLps(info, p.index, a.y, a.x), xsPixelToLps(info, p.index, b.y, b.x)];
      const fmt = (q) => `(${q.map((v) => v.toFixed(1)).join(', ')})`;
      const where = `from ${fmt(lps[0])} to ${fmt(lps[1])} mm, patient LPS`;
      items.push(`<li title="${esc(where)}"><span class="mono">${esc(rulerLabel({ a, b }, info, which))}</span>
        <span class="hint">${which === 'pan' ? 'panoramic, vertical' : 'cross-section'}</span>
        <button class="link" data-key="${esc(key)}" data-i="${i}" type="button">remove</button></li>`);
    });
  });
  // Empty means EMPTY. The standing hint said "Drag on the section to measure · Shift
  // constrains · Esc clears", which is word for word the first line of the `tools`
  // legend two rows above -- so it was two lines of the measurements panel, on every
  // case, for a sentence already on screen and one click from the button that names it.
  box.innerHTML = items.length ? `<ul class="rulers">${items.join('')}</ul>` : '';
  box.querySelectorAll('button[data-key]').forEach((b) => {
    b.onclick = () => {
      const list = p.rulers[b.dataset.key] || [];
      list.splice(Number(b.dataset.i), 1);
      drawRulers('xs'); drawRulers('pan'); renderRulerList();
    };
  });
}

function jumpToArcColumn(x) {
  const p = planState();
  const info = ((p.arch || {}).jaws || {})[p.jaw];
  if (!info) return;
  const want = x * ((info.panoramic.size[1] - 1)
                    / Math.max(1, planSize($('panCanvas')).w - 1));
  const src = info.cross_sections.source_indices;
  let best = 0;
  for (let k = 1; k < src.length; k += 1) {
    if (Math.abs(src[k] - want) < Math.abs(src[best] - want)) best = k;
  }
  selectXs(best);
}

