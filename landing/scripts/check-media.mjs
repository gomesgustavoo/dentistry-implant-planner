/* Verify every hashed VR rendition against the manifest that names it and the EDL that made it.
 *
 *   node scripts/check-media.mjs            (npm run check:media; needs ffmpeg + ffprobe)
 *
 * `landing/src/generated/media.json` is what the page renders from: sizes, codec strings and
 * durations go straight into <source type>, width/height and the player's clock. A manifest
 * that has drifted from its files is a page that lies quietly (a codecs string that names the
 * wrong level makes Safari skip a source it could have played; a stale byte count is a wrong
 * bitrate handed to mediaCapabilities). So everything here is re-measured off the files and
 * compared, nothing is trusted from the script that wrote them:
 *
 *  - the 8-hex name prefix IS the sha256 prefix, bytes match, and assets/media holds nothing
 *    that neither the current nor the previous manifest references (the previous one stays
 *    servable for visitors still holding last release's HTML; see make_vr_media.mjs --prune);
 *  - budgets from the EDL (loops: WARN over budget, FAIL over the hard cap; everything else FAIL);
 *  - video: no audio, moov before mdat, yuv420p, BT.709 tags, CFR 30 measured on the packet
 *    timestamps (r_frame_rate alone is a container claim), even dimensions, duration within
 *    one frame of the manifest, and the codecs string re-parsed from avcC / av1C;
 *  - posters equal the frame they stand in for (mean abs RGB diff <= 4/255 at 160 px), so the
 *    swap from <picture> to <video> does not jump;
 *  - the film has a keyframe within one frame of every chapter and deep-link time (H.264) and
 *    no further than one 2.0 s GOP before it (AV1), so a chapter click lands where it says;
 *  - the hero's frame-0 sky decoded as BT.709 is within 2 levels of the raw capture decoded
 *    through its own BT.601 tags. This is the check that would have caught the scale-filter
 *    matrix route, which darkens the sky by about 2.5 levels and passes every other test.
 *
 * Colour is decoded HERE, from raw yuv420p planes, with the matrix written out below, and
 * deliberately not through ffmpeg's `scale` YUV->RGB path: measured on this box (ffmpeg 6.1.1),
 * swscale's yuv420p->rgb24 reads the raw capture 1.0-1.8 levels dark against zimg and against
 * the matrix done by hand, which is the same size as the error this check exists to catch.
 *
 * The MP4 box walker and the YUV reader are exported; scripts/make_vr_media.mjs imports them so
 * the manifest is written by the same parser that checks it. The parser itself is cross-checked
 * against ffprobe's own profile/level fields, so a parser bug cannot pass by agreeing with itself.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, createReadStream, existsSync, fstatSync, openSync, readFileSync, readSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const LANDING = fileURLToPath(new URL('../', import.meta.url));
export const ROOT = path.resolve(LANDING, '..');
export const EDL_PATH = path.join(LANDING, 'media/edl.json');
export const MANIFEST_PATH = path.join(LANDING, 'src/generated/media.json');
export const MEDIA_DIR = path.join(LANDING, 'assets/media');
export const WORK = process.env.MEDIA_WORK || '/mnt/mldata/implantplan-media-work';
/** Written by make_vr_media.mjs each time it replaces media.json with something different. */
export const PREVIOUS_PATH = path.join(WORK, 'media.previous.json');
/** <name>.<sha8>.<ext>: the only shape a file under assets/media may have. */
export const HASHED = /^(.+)\.([0-9a-f]{8})\.(mp4|avif|webp|jpg)$/;
const MIME = { mp4: 'video/mp4', avif: 'image/avif', webp: 'image/webp', jpg: 'image/jpeg' };

// ---------------------------------------------------------------- process helpers

/** Spawn and collect. Rejects with the tail of stderr, because ffmpeg's first lines are noise. */
export function run(cmd, args, { quiet = true } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const out = []; let err = '';
    p.stdout.on('data', d => out.push(d));
    p.stderr.on('data', d => { err += d; if (!quiet) process.stderr.write(d); if (err.length > 1e6) err = err.slice(-2e5); });
    p.on('error', reject);
    p.on('close', code => code === 0
      ? resolve({ stdout: Buffer.concat(out), stderr: err })
      : reject(new Error(`${cmd} exited ${code}: ${err.trim().split('\n').slice(-6).join('\n')}\n  args: ${args.join(' ')}`)));
  });
}

export async function sha256(file) {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(file)) h.update(chunk);
  return h.digest('hex');
}

export async function probe(file) {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file]);
  return JSON.parse(stdout.toString());
}

/** Video packet timestamps (presentation order) and which ones are sync samples. */
export async function packets(file) {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'packet=pts_time,flags', '-of', 'csv=p=0', file]);
  const rows = stdout.toString().trim().split('\n').map(l => l.split(','))
    .map(([t, f]) => ({ t: Number(t), key: (f || '').includes('K') }))
    .filter(p => Number.isFinite(p.t));
  return rows.sort((a, b) => a.t - b.t);
}

// ---------------------------------------------------------------- MP4 boxes

function readAt(fd, pos, len) {
  const b = Buffer.alloc(len);
  return b.subarray(0, readSync(fd, b, 0, len, pos));
}

/** Top-level boxes in file order, read header by header so a 17 MB mdat is never loaded. */
export function topLevelBoxes(file) {
  const fd = openSync(file, 'r');
  try {
    const size = fstatSync(fd).size; const boxes = [];
    for (let pos = 0; pos + 8 <= size;) {
      const h = readAt(fd, pos, 16);
      let len = h.readUInt32BE(0); let hdr = 8;
      const type = h.toString('latin1', 4, 8);
      if (len === 1) { len = Number(h.readBigUInt64BE(8)); hdr = 16; } else if (len === 0) len = size - pos;
      if (len < hdr || pos + len > size) throw new Error(`${file}: corrupt ${type} box at byte ${pos}`);
      boxes.push({ type, start: pos, size: len, hdr });
      pos += len;
    }
    return boxes;
  } finally { closeSync(fd); }
}

function* children(buf, start, end) {
  for (let pos = start; pos + 8 <= end;) {
    let len = buf.readUInt32BE(pos); let hdr = 8;
    const type = buf.toString('latin1', pos + 4, pos + 8);
    if (len === 1) { len = Number(buf.readBigUInt64BE(pos + 8)); hdr = 16; } else if (len === 0) len = end - pos;
    if (len < hdr || pos + len > end) throw new Error(`corrupt ${type} box at moov+${pos}`);
    yield { type, body: pos + hdr, end: pos + len };
    pos += len;
  }
}
function child(buf, parent, type) {
  for (const b of children(buf, parent.body, parent.end)) if (b.type === type) return b;
  throw new Error(`no ${type} box`);
}
const hex2 = n => n.toString(16).padStart(2, '0');

/** RFC 6381 codec string of the first video track, parsed from the avcC / av1C box bytes.
 *  Returns the raw fields too, so the caller can cross-check them against ffprobe. */
export function parseVideoCodec(file) {
  const moovBox = topLevelBoxes(file).find(b => b.type === 'moov');
  if (!moovBox) throw new Error(`${file}: no moov box`);
  const fd = openSync(file, 'r');
  let buf; try { buf = readAt(fd, moovBox.start, moovBox.size); } finally { closeSync(fd); }
  const moov = { body: moovBox.hdr, end: buf.length };
  for (const trak of children(buf, moov.body, moov.end)) {
    if (trak.type !== 'trak') continue;
    const mdia = child(buf, trak, 'mdia');
    const hdlr = child(buf, mdia, 'hdlr');
    // hdlr is a FullBox: version+flags (4), pre_defined (4), then handler_type.
    if (buf.toString('latin1', hdlr.body + 8, hdlr.body + 12) !== 'vide') continue;
    const stsd = child(buf, child(buf, child(buf, mdia, 'minf'), 'stbl'), 'stsd');
    // stsd: version+flags (4) + entry_count (4), then the sample entries.
    const entry = children(buf, stsd.body + 8, stsd.end).next().value;
    // VisualSampleEntry: 6 reserved + data_reference_index (2) + 70 bytes of fixed fields,
    // then its child boxes, among them the decoder configuration record.
    const kids = { body: entry.body + 8 + 70, end: entry.end };
    if (entry.type === 'avc1' || entry.type === 'avc3') {
      const c = buf.subarray(child(buf, kids, 'avcC').body);
      // configurationVersion, AVCProfileIndication, profile_compatibility, AVCLevelIndication
      if (c[0] !== 1) throw new Error(`${file}: avcC version ${c[0]}`);
      return { codecs: `${entry.type}.${hex2(c[1])}${hex2(c[2])}${hex2(c[3])}`, profile: c[1], level: c[3] };
    }
    if (entry.type === 'av01') {
      const c = buf.subarray(child(buf, kids, 'av1C').body);
      // marker(1)+version(7) = 0x81; seq_profile(3) seq_level_idx_0(5); seq_tier_0(1)
      // high_bitdepth(1) twelve_bit(1) monochrome(1) subsampling_x(1) subsampling_y(1) ...
      if (c[0] !== 0x81) throw new Error(`${file}: av1C marker/version ${hex2(c[0])}`);
      const profile = c[1] >> 5; const level = c[1] & 0x1f;
      const tier = c[2] & 0x80 ? 'H' : 'M';
      const depth = c[2] & 0x40 ? (c[2] & 0x20 ? 12 : 10) : 8;
      return { codecs: `av01.${profile}.${String(level).padStart(2, '0')}${tier}.${String(depth).padStart(2, '0')}`, profile, level };
    }
    throw new Error(`${file}: sample entry ${entry.type} is neither avc1 nor av01`);
  }
  throw new Error(`${file}: no video track`);
}

// ---------------------------------------------------------------- colour

/** One frame as raw yuv420p planes. No matrix is applied: the caller says how to read it. */
export async function frameYuv(file, { pre = [], vf = null, w, h }) {
  const args = ['-v', 'error', '-nostdin', ...pre, '-i', file, ...(vf ? ['-vf', vf] : []),
    '-frames:v', '1', '-pix_fmt', 'yuv420p', '-f', 'rawvideo', '-'];
  const { stdout } = await run('ffmpeg', args);
  const cw = Math.ceil(w / 2), ch = Math.ceil(h / 2);
  if (stdout.length !== w * h + 2 * cw * ch) throw new Error(`${file}: got ${stdout.length} bytes, not a ${w}x${h} yuv420p frame`);
  return { w, h, cw, Y: stdout.subarray(0, w * h), U: stdout.subarray(w * h, w * h + cw * ch), V: stdout.subarray(w * h + cw * ch) };
}

const KRB = { bt601: [0.299, 0.114], bt709: [0.2126, 0.0722] };
/** Limited-range YUV -> display RGB (0-255, clipped as a screen would). */
function toRgb(f, kr, kb, x, y) {
  const Y = (f.Y[y * f.w + x] - 16) / 219;
  const i = (y >> 1) * f.cw + (x >> 1);
  const U = (f.U[i] - 128) / 224, V = (f.V[i] - 128) / 224;
  const R = Y + 2 * (1 - kr) * V, B = Y + 2 * (1 - kb) * U;
  const G = (Y - kr * R - kb * B) / (1 - kr - kb);
  return [R, G, B].map(c => Math.min(255, Math.max(0, c * 255)));
}

/** Mean RGB of a rect [x, y, w, h], decoded with the named matrix. */
export function meanRgb(f, matrix, [x0, y0, w, h] = [0, 0, f.w, f.h]) {
  const [kr, kb] = KRB[matrix]; const s = [0, 0, 0];
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) {
    const p = toRgb(f, kr, kb, x, y); s[0] += p[0]; s[1] += p[1]; s[2] += p[2];
  }
  return s.map(v => v / (w * h));
}

/** Mean absolute RGB difference of two same-size frames, in levels (0-255). */
export function meanAbsDiff(a, ma, b, mb) {
  const [ra, ba] = KRB[ma], [rb, bb] = KRB[mb]; let s = 0;
  for (let y = 0; y < a.h; y++) for (let x = 0; x < a.w; x++) {
    const p = toRgb(a, ra, ba, x, y), q = toRgb(b, rb, bb, x, y);
    s += Math.abs(p[0] - q[0]) + Math.abs(p[1] - q[1]) + Math.abs(p[2] - q[2]);
  }
  return s / (3 * a.w * a.h);
}

/** How a file's pixels must be read: WebP lossy is BT.601 by definition (libwebp ignores tags);
 *  our MP4s and AVIFs are tagged and written BT.709. */
export const matrixOf = file => (file.endsWith('.webp') ? 'bt601' : 'bt709');

/** Frame 0 of a hero rendition against the same source frame of the raw capture.
 *  The raw is decoded with the encode's own seek, fps grid and trim, so it IS frame 0's source. */
export async function skyCompare(edl, loop, aspect, videoFile) {
  const cand = loop.candidates[loop.pick];
  const src = path.join(ROOT, edl.sources[loop.src]);
  const { rect: [cx, cy, cw, ch], out: [ow, oh] } = loop.crops[aspect];
  const [sx, sy, sw, sh] = loop.sky;
  const fx = ow / cw, fy = oh / ch;
  const outRect = [Math.round((sx - cx) * fx), Math.round((sy - cy) * fy), Math.round(sw * fx), Math.round(sh * fy)];
  const s = (await probe(src)).streams.find(x => x.codec_type === 'video');
  const raw = await frameYuv(src, { pre: ['-ss', String(cand.in), '-t', String(cand.xfade + 0.2)],
    vf: `fps=${edl.fps},trim=start=${cand.xfade}`, w: s.width, h: s.height });
  const out = await frameYuv(videoFile, { w: ow, h: oh });
  const a = meanRgb(raw, edl.matrix[loop.src], loop.sky), b = meanRgb(out, 'bt709', outRect);
  return { raw: a, out: b, diff: Math.max(...a.map((v, i) => Math.abs(v - b[i]))), outRect };
}

/** A frame scaled to 160 px wide, for poster comparisons. Scaling YUV->YUV applies no matrix. */
export async function thumbYuv(file, { frame = 0, width, height }) {
  const h = Math.round((height * 160) / width / 2) * 2;
  const vf = `${frame ? `select=eq(n\\,${frame}),` : ''}scale=160:${h}:flags=area`;
  return frameYuv(file, { vf, w: 160, h });
}

export const fmtRgb = c => `(${c.map(v => v.toFixed(1)).join(', ')})`;

// ---------------------------------------------------------------- the check

export function readJson(file) { return JSON.parse(readFileSync(file, 'utf8')); }

/** Every /assets/... URL a manifest references (walks the whole object, so a new field is covered). */
export function referenced(manifest) {
  const out = new Set();
  const walk = v => {
    if (typeof v === 'string' && v.startsWith('/assets/')) out.add(v);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(manifest);
  return out;
}

/** The manifests whose files must stay servable: the one written before the current one, and the
 *  committed one (what production most likely serves). Either may be absent. */
export async function previousManifests() {
  const out = [];
  if (existsSync(PREVIOUS_PATH)) { try { out.push(readJson(PREVIOUS_PATH)); } catch { /* unreadable is absent */ } }
  try {
    const rel = path.relative(ROOT, MANIFEST_PATH);
    const { stdout } = await run('git', ['-C', ROOT, 'show', `HEAD:${rel}`]);
    out.push(JSON.parse(stdout.toString()));
  } catch { /* not committed yet, or no git */ }
  return out;
}

async function main() {
  const edl = readJson(EDL_PATH);
  const m = readJson(MANIFEST_PATH);
  const rows = []; // { file, bytes, budget, level, notes[] }
  const fails = [];
  const asset = (file, budget, cap) => {
    const r = { file, bytes: null, budget, cap, problems: [], warns: [], info: [] };
    rows.push(r); return r;
  };
  const fail = (r, msg) => r.problems.push(msg);
  const near = (a, b, tol) => Math.abs(a - b) <= tol;

  if (m.edlHash === 'STUB') { console.error('media.json is still the stub; run scripts/make_vr_media.mjs'); process.exit(1); }
  const edlHash = createHash('sha256').update(readFileSync(EDL_PATH)).digest('hex');
  const global = asset('(manifest)', null);
  if (m.edlHash !== edlHash) fail(global, `edlHash ${m.edlHash.slice(0, 12)} != sha256(edl.json) ${edlHash.slice(0, 12)}: the EDL changed since the manifest was written`);
  if (!m.loops?.[m.hero]) fail(global, `hero "${m.hero}" is not a loop`);
  if (m.hero !== edl.hero) fail(global, `hero ${m.hero} != EDL hero ${edl.hero}`);
  const stillIds = edl.stills.map(s => s.id).sort().join();
  if (Object.keys(m.stills).sort().join() !== stillIds) fail(global, `stills ${Object.keys(m.stills)} != EDL ${stillIds}`);
  if (JSON.stringify(m.film.chapters) !== JSON.stringify(edl.film.chapters)) fail(global, 'film.chapters differ from the EDL');
  if (JSON.stringify(m.film.links) !== JSON.stringify(edl.film.links)) fail(global, 'film.links differ from the EDL');

  /** Checks every asset gets: present, hashed name == content hash, bytes, size, MIME. */
  async function common(r, a) {
    const file = path.join(LANDING, a.src);
    if (!existsSync(file)) { fail(r, `missing ${a.src}`); return null; }
    const name = path.basename(file); const mm = HASHED.exec(name);
    const sum = await sha256(file);
    if (!mm) fail(r, `${name} is not <name>.<sha8>.<ext>`);
    else if (mm[2] !== sum.slice(0, mm[2].length)) fail(r, `name hash ${mm[2]} != sha256 ${sum.slice(0, 8)}`);
    else if (MIME[mm[3]] !== a.type) fail(r, `type ${a.type} for .${mm[3]}`);
    const p = await probe(file);
    r.bytes = Number(p.format.size);
    if (r.bytes !== a.bytes) fail(r, `bytes ${r.bytes} != manifest ${a.bytes}`);
    if (r.budget != null && r.bytes > (r.cap ?? r.budget)) fail(r, `${r.bytes} B over the ${r.cap ? 'hard cap' : 'budget'} ${r.cap ?? r.budget}`);
    else if (r.cap && r.bytes > r.budget) r.warns.push(`over the ${r.budget} B budget (under the ${r.cap} B cap)`);
    const v = p.streams.find(s => s.codec_type === 'video');
    if (!v) { fail(r, 'no video/image stream'); return null; }
    if (v.width !== a.width || v.height !== a.height) fail(r, `${v.width}x${v.height} != manifest ${a.width}x${a.height}`);
    return { file, p, v };
  }
  function tagsBt709(r, v) {
    for (const k of ['color_space', 'color_primaries', 'color_transfer']) if (v[k] !== 'bt709') fail(r, `${k}=${v[k] ?? 'unset'}`);
    if (v.color_range !== 'tv') fail(r, `color_range=${v.color_range ?? 'unset'}`);
    if (v.pix_fmt !== 'yuv420p') fail(r, `pix_fmt=${v.pix_fmt}`);
    if (v.width % 2 || v.height % 2) fail(r, `odd dimensions ${v.width}x${v.height}`);
  }

  async function video(a, budget, cap) {
    const r = asset(a.src, budget, cap);
    const c = await common(r, a); if (!c) return { r };
    const { file, p, v } = c;
    tagsBt709(r, v);
    if (p.streams.some(s => s.codec_type === 'audio')) fail(r, 'has an audio stream');
    if (p.streams.length !== 1) fail(r, `${p.streams.length} streams, expected 1`);
    const top = topLevelBoxes(file).map(b => b.type);
    if (!(top.indexOf('moov') >= 0 && top.indexOf('moov') < top.indexOf('mdat'))) fail(r, `box order ${top.join(' ')}: not faststart`);
    if (v.r_frame_rate !== `${edl.fps}/1`) fail(r, `r_frame_rate ${v.r_frame_rate}`);
    const [an, ad] = v.avg_frame_rate.split('/').map(Number);
    if (!near(an / ad, edl.fps, 0.01)) fail(r, `avg_frame_rate ${v.avg_frame_rate}`);
    const pk = await packets(file);
    const step = 1 / edl.fps;
    const bad = pk.slice(1).findIndex((q, i) => !near(q.t - pk[i].t, step, 1e-3));
    if (bad >= 0) fail(r, `not CFR: packet ${bad + 1} at ${pk[bad + 1].t}s follows ${pk[bad].t}s`);
    const dur = pk.length * step;
    if (!near(dur, a.duration, 0.034)) fail(r, `duration ${dur.toFixed(3)} (${pk.length} frames) != manifest ${a.duration}`);
    if (!near(Number(p.format.duration), a.duration, 0.034)) fail(r, `container duration ${p.format.duration} != manifest ${a.duration}`);
    try {
      const parsed = parseVideoCodec(file);
      if (parsed.codecs !== a.codecs) fail(r, `codecs ${parsed.codecs} != manifest ${a.codecs}`);
      // Independent cross-check of the box parser against ffprobe's own reading of the stream.
      if (v.codec_name === 'h264' && (v.level !== parsed.level || v.profile !== 'High')) fail(r, `avcC level ${parsed.level} / ffprobe ${v.profile} ${v.level}`);
      if (v.codec_name === 'av1' && v.level !== parsed.level) fail(r, `av1C seq_level_idx ${parsed.level} / ffprobe level ${v.level}`);
      r.info.push(parsed.codecs);
    } catch (e) { fail(r, e.message); }
    return { r, file, pk };
  }

  async function image(a, budget, { bt709 = true } = {}) {
    const r = asset(a.src, budget);
    const c = await common(r, a); if (!c) return { r };
    if (a.codecs) fail(r, 'an image has no codecs string');
    if (bt709 && a.type === 'image/avif') tagsBt709(r, c.v);
    // A WebP twin decoded with alpha would mean a stray alpha plane: bytes for nothing.
    if (bt709 && a.type === 'image/webp' && c.v.pix_fmt !== 'yuv420p') fail(r, `pix_fmt=${c.v.pix_fmt}`);
    return { r, file: c.file, v: c.v };
  }

  async function posterMatches(r, posterFile, a, videoFile, frame) {
    if (!posterFile || !videoFile) return;
    const p = await thumbYuv(posterFile, { width: a.width, height: a.height });
    const f = await thumbYuv(videoFile, { frame, width: a.width, height: a.height });
    const d = meanAbsDiff(p, matrixOf(posterFile), f, 'bt709');
    r.info.push(`poster~frame${frame} ${d.toFixed(2)}/255`);
    if (d > 4) fail(r, `poster differs from video frame ${frame} by ${d.toFixed(2)}/255 (max 4)`);
  }

  // ---- loops
  for (const loop of edl.loops) {
    const e = m.loops[loop.id];
    if (!e) { fail(global, `manifest has no loop ${loop.id}`); continue; }
    const cand = loop.candidates[loop.pick];
    if (e.in !== cand.in || !near(e.out, cand.in + cand.len + cand.xfade, 1e-6)) fail(global, `${loop.id} in/out ${e.in}-${e.out} != EDL pick ${loop.pick}`);
    if (!near(e.duration, cand.len, 0.034)) fail(global, `${loop.id} duration ${e.duration} != EDL pick length ${cand.len}`);
    for (const aspect of Object.keys(loop.crops)) {
      const b = loop.budget[aspect];
      const h264 = await video(e.video[aspect].h264, b.h264, loop.hardCap);
      const av1 = await video(e.video[aspect].av1, b.av1, loop.hardCap);
      for (const [kind, pa] of Object.entries(e.poster[aspect])) {
        const img = await image(pa, b[kind]);
        await posterMatches(img.r, img.file, pa, h264.file, 0);
      }
      if (loop.id !== m.hero) continue;
      const raw = path.join(ROOT, edl.sources[loop.src]);
      for (const v of [h264, av1]) {
        if (!v.file) continue;
        if (!existsSync(raw)) { v.r.warns.push(`sky check SKIPPED: raw capture not on this machine (${edl.sources[loop.src]})`); continue; }
        const s = await skyCompare(edl, loop, aspect, v.file);
        v.r.info.push(`sky raw601 ${fmtRgb(s.raw)} out709 ${fmtRgb(s.out)} d=${s.diff.toFixed(2)}`);
        if (s.diff > 2) fail(v.r, `frame-0 sky ${fmtRgb(s.out)} vs raw ${fmtRgb(s.raw)}: ${s.diff.toFixed(2)} levels (max 2)`);
      }
    }
  }

  // ---- stills
  for (const st of edl.stills) {
    const e = m.stills[st.id]; if (!e) continue;
    if (e.t !== st.t || e.source !== st.src) fail(global, `still ${st.id} t/source ${e.source}@${e.t} != EDL ${st.src}@${st.t}`);
    for (const [w, h] of edl.stillOut) {
      const pair = e.sizes[String(w)];
      if (!pair) { fail(global, `still ${st.id} has no ${w} size`); continue; }
      for (const [kind, a] of Object.entries(pair)) {
        const img = await image(a, edl.stillBudget[String(w)][kind]);
        if (img.v && (img.v.width !== w || img.v.height !== h)) fail(img.r, `${img.v.width}x${img.v.height}, EDL says ${w}x${h}`);
      }
    }
  }

  // ---- film
  const film = m.film; const fb = edl.film.budget;
  const fh = await video(film.h264, fb.h264);
  const fa = await video(film.av1, fb.av1);
  const times = [...edl.film.chapters, ...edl.film.links].sort((a, b) => a - b);
  if (fh.pk) {
    const keys = fh.pk.filter(p => p.key).map(p => p.t);
    const miss = times.filter(t => !keys.some(k => Math.abs(k - t) <= 1 / edl.fps + 1e-3));
    if (miss.length) fail(fh.r, `no keyframe within 1 frame of ${miss.join(', ')} s`);
    else fh.r.info.push(`keyframes at all ${times.length} chapter/link times`);
  }
  if (fa.pk) {
    const keys = fa.pk.filter(p => p.key).map(p => p.t);
    const worst = Math.max(...times.map(t => t - Math.max(...keys.filter(k => k <= t + 1e-3))));
    if (!(worst <= 2.0 + 1e-3)) fail(fa.r, `a chapter/link time is ${worst.toFixed(2)} s past its keyframe (max 2.0)`);
    else fa.r.info.push(`worst seek preroll ${worst.toFixed(2)} s`);
  }
  if (!near(film.duration, film.h264.duration, 1e-6)) fail(global, `film.duration ${film.duration} != h264 duration ${film.h264.duration}`);
  const posterFrame = Math.round(edl.film.posterT * edl.fps);
  for (const [kind, a] of Object.entries(film.poster)) {
    const img = await image(a, fb[kind]);
    await posterMatches(img.r, img.file, a, fh.file, posterFrame);
  }

  // ---- OG card and hero fallback (hashed, but they live in /assets/, not /assets/media/)
  const og = await image(m.og, edl.og.budget, { bt709: false });
  if (og.v && (og.v.width !== edl.og.out[0] || og.v.height !== edl.og.out[1])) fail(og.r, `OG is ${og.v.width}x${og.v.height}`);
  const hf = await image(m.heroFallback, edl.heroFallback.budget, { bt709: false });
  if (hf.v && hf.v.pix_fmt !== 'yuva420p') fail(hf.r, `pix_fmt ${hf.v.pix_fmt}: the fallback lost its alpha`);

  // ---- orphans: assets/media holds hashed files the current or previous manifest references, nothing else
  const keep = referenced(m); const prev = new Set();
  for (const pm of await previousManifests()) for (const u of referenced(pm)) prev.add(u);
  const orphan = asset('(assets/media)', null);
  for (const name of existsSync(MEDIA_DIR) ? readdirSync(MEDIA_DIR) : []) {
    const url = `/assets/media/${name}`;
    if (!HASHED.test(name)) fail(orphan, `unhashed or temporary file ${name}`);
    else if (keep.has(url)) continue;
    else if (prev.has(url)) orphan.info.push(`retained for the previous release: ${name}`);
    else fail(orphan, `orphan ${name} (referenced by neither manifest; make_vr_media.mjs --prune)`);
  }

  // ---- chapters VTT, when a build exists (the endpoint renders it from this manifest)
  const vttRow = asset('(chapters.vtt)', null);
  const dist = path.join(LANDING, 'dist');
  const vtts = ['film/chapters.vtt', 'es/film/chapters.vtt', 'pt-br/film/chapters.vtt'].map(p => path.join(dist, p)).filter(existsSync);
  if (!vtts.length) vttRow.warns.push('SKIPPED: no dist/**/film/chapters.vtt (build first)');
  for (const f of vtts) {
    const txt = readFileSync(f, 'utf8').replace(/\r\n/g, '\n');
    const rel = path.relative(LANDING, f);
    if (!/^(﻿)?WEBVTT[ \t\n]/.test(txt)) { fail(vttRow, `${rel}: does not start with WEBVTT`); continue; }
    const ts = s => { const p = s.split(':').map(Number); return p.reduce((acc, v) => acc * 60 + v, 0); };
    const cues = [...txt.matchAll(/^((?:\d+:)?\d{2}:\d{2}\.\d{3}) --> ((?:\d+:)?\d{2}:\d{2}\.\d{3})[^\n]*\n([^\n]+)/gm)]
      .map(c => ({ a: ts(c[1]), b: ts(c[2]), text: c[3].trim() }));
    const starts = cues.map(c => c.a);
    if (JSON.stringify(starts) !== JSON.stringify(edl.film.chapters)) fail(vttRow, `${rel}: cue starts ${starts} != chapters ${edl.film.chapters}`);
    cues.forEach((c, i) => {
      if (!(c.b > c.a)) fail(vttRow, `${rel}: cue ${i + 1} ends before it starts`);
      if (i && cues[i - 1].b > c.a + 1e-6) fail(vttRow, `${rel}: cue ${i + 1} overlaps cue ${i}`);
      if (!c.text) fail(vttRow, `${rel}: cue ${i + 1} has no title`);
    });
    if (cues.length && cues.at(-1).b > film.duration + 0.01) fail(vttRow, `${rel}: last cue ends after the film (${film.duration} s)`);
    if (!vttRow.problems.length) vttRow.info.push(`${rel}: ${cues.length} cues`);
  }

  // ---- report
  const kb = n => (n == null ? '' : (n / 1000).toFixed(1));
  const w = Math.max(...rows.map(r => r.file.length));
  console.log(`${'file'.padEnd(w)}  ${'KB'.padStart(8)}  ${'budget'.padStart(8)}  result  notes`);
  for (const r of rows) {
    const level = r.problems.length ? 'FAIL' : r.warns.length ? 'WARN' : 'PASS';
    const notes = [...r.problems, ...r.warns, ...r.info].join('; ');
    console.log(`${r.file.padEnd(w)}  ${kb(r.bytes).padStart(8)}  ${kb(r.budget).padStart(8)}  ${level.padEnd(6)}  ${notes}`);
    if (r.problems.length) fails.push(...r.problems.map(p => `${r.file}: ${p}`));
  }
  if (fails.length) {
    console.error(`\n${fails.length} problem(s):\n  ${fails.join('\n  ')}`);
    process.exit(1);
  }
  console.log(`\nmedia OK: ${rows.filter(r => r.bytes != null).length} files checked`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(e => { console.error(e.stack || e.message); process.exit(1); });
}
