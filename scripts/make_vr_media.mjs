#!/usr/bin/env node
/* Cut every ImplantPlan VR web rendition out of the raw Quest captures, driven by one EDL.
 *
 *   node scripts/make_vr_media.mjs                     encode what changed, write the manifest
 *   node scripts/make_vr_media.mjs --only hands,film   just those groups (hands|stills|film|og|fallback|preview)
 *   node scripts/make_vr_media.mjs --preview           also render the hero loop candidates, looped 3x
 *        [--preview-dir DIR]                           (default $MEDIA_WORK/preview)
 *   node scripts/make_vr_media.mjs --prune             delete hashed files neither manifest references
 *   node scripts/make_vr_media.mjs --check             re-verify only (landing/scripts/check-media.mjs)
 *   node scripts/make_vr_media.mjs --force             ignore the encode cache
 *
 * Inputs: `landing/media/edl.json` (every in point, crop, CRF and budget lives there, never
 * here) and the sources it names, relative to the repo root. Outputs: hashed files under
 * `landing/assets/media/` (plus `assets/og-vr.<h>.jpg` and `assets/hero-fallback.<h>.webp`) and
 * `landing/src/generated/media.json`, which `landing/src/lib/media.ts` types. Every number in the
 * manifest (bytes, size, duration, codec string) is measured off the encoded file.
 *
 * COLOUR. The Quest captures are tagged BT.601 (bt470bg/smpte170m). Every raw-derived output
 * goes fps=30 -> lanczos scale -> the `colorspace` filter (matrix only: primaries and transfer
 * are declared equal on both sides) and is tagged BT.709. NOT `scale=...:in_color_matrix=bt601:
 * out_color_matrix=bt709`: measured on raw3 at 214.3 s, that route reads 2.3-3.0 levels dark
 * against the raw decoded through its own tags, the `colorspace` route 0.1-0.3. The hero's
 * frame-0 sky is compared against the raw before the manifest is written, and the build stops
 * if it is off by more than 2 levels. WebP is BT.601 by definition (libwebp ignores tags and the
 * ffmpeg wrapper hands it our YUV planes untouched), so the WebP twin of every image goes back
 * through `colorspace` to BT.601 rather than being read 709-as-601 by every browser.
 *
 * TIMING. The raw is variable frame rate (72 Hz headset pacing, 27.8/41.7 ms frames), so fps=30
 * comes first and every later trim counts in its frames. A frame is addressed as "-ss <in> then
 * fps=30 then trim=start=<offset>", and the checker decodes the reference frame the same way,
 * so "frame 0 of the hero" means the same source frame in both scripts.
 *
 * MACHINE. Bulk intermediates (lossless FFV1, ~25-40 MB per loop) go to $MEDIA_WORK, default
 * /mnt/mldata/implantplan-media-work: the root disk of this KVM guest writes buffered data at
 * about 7 MB/s and has OOM'd the k3s cluster before. Encodes run strictly one at a time at
 * nice 10, because parallel encoders exhaust RAM before they exhaust cores, and the cluster's
 * pods share this box.
 *
 * HASHING. Each output is encoded to $MEDIA_WORK/tmp, hashed (sha256), copied next to its final
 * name as <final>.tmp and renamed, so assets/ never holds a half-written file under a real name.
 * Names are <id>.<aspect|size>.<codec>.<sha8>.<ext>. /assets/ is served immutable for a year,
 * so a changed file MUST change its name.
 *
 * PRUNE keeps the files of the previous manifest too ($MEDIA_WORK/media.previous.json, saved
 * whenever media.json changes, plus the committed HEAD copy): a visitor holding last release's
 * HTML asks for last release's film only when they press play, possibly an hour later.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EDL_PATH, LANDING, MANIFEST_PATH, MEDIA_DIR, PREVIOUS_PATH, ROOT, WORK, HASHED,
  fmtRgb, frameYuv, packets, parseVideoCodec, previousManifests, probe, readJson, referenced, run, sha256, skyCompare,
} from '../landing/scripts/check-media.mjs';

// Bump when a filter graph or encoder argument list changes shape, so the cache cannot
// hand back a file made by the old recipe.
const RECIPE = 3;
const ASSETS = path.join(LANDING, 'assets');
const TMP = path.join(WORK, 'tmp'); const INT = path.join(WORK, 'int'); const CACHE = path.join(WORK, 'cache');

// ---------------------------------------------------------------- arguments

const argv = process.argv.slice(2);
const flag = f => argv.includes(f);
const value = f => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
const GROUPS = ['hands', 'stills', 'film', 'og', 'fallback', 'preview'];
const only = value('--only')?.split(',').map(s => s.trim()).filter(Boolean);
for (const g of only ?? []) if (!GROUPS.includes(g)) { console.error(`unknown group ${g}; one of ${GROUPS.join(', ')}`); process.exit(2); }
const want = g => (only ? only.includes(g) : g !== 'preview' || flag('--preview'));
const FORCE = flag('--force');
const PREVIEW_DIR = path.resolve(value('--preview-dir') ?? process.env.MEDIA_PREVIEW ?? path.join(WORK, 'preview'));

if (flag('--check')) {
  const r = spawnSync('node', [path.join(LANDING, 'scripts/check-media.mjs')], { stdio: 'inherit' });
  process.exit(r.status ?? 1);
}

const edl = readJson(EDL_PATH);
const edlHash = createHash('sha256').update(readFileSync(EDL_PATH)).digest('hex');
const FPS = edl.fps;
for (const d of [TMP, INT, CACHE, MEDIA_DIR]) mkdirSync(d, { recursive: true });

// ---------------------------------------------------------------- small helpers

const n6 = x => String(Math.round(x * 1e6) / 1e6); // 3.3 - 0.3 is 2.9999999999999996 in floats
const kb = b => `${(b / 1000).toFixed(1)} KB`;
const source = id => {
  const f = path.join(ROOT, edl.sources[id]);
  if (!existsSync(f)) throw new Error(`source ${id} not found: ${edl.sources[id]}`);
  return f;
};
/** Cheap identity for a 200 MB capture: path, size and mtime, not a full hash. */
const fp = f => { const s = statSync(f); return `${path.relative(ROOT, f)}:${s.size}:${Math.round(s.mtimeMs)}`; };
const keyOf = o => createHash('sha256').update(JSON.stringify({ RECIPE, ...o })).digest('hex').slice(0, 16);

const TAGS = ['-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', '-color_range', 'tv'];
const CLEAN = ['-an', '-sn', '-dn', '-map_metadata', '-1', '-map_chapters', '-1'];
// Matrix-only conversions. Primaries and transfer are declared identical on both sides, so the
// filter changes the YUV matrix and nothing else; that is what makes it exact.
const CS_601_TO_709 = 'colorspace=space=bt709:ispace=bt470bg:primaries=bt470bg:iprimaries=bt470bg:trc=smpte170m:itrc=smpte170m:range=tv:irange=tv';
const CS_709_TO_601 = 'colorspace=space=bt470bg:ispace=bt709:primaries=bt709:iprimaries=bt709:trc=bt709:itrc=bt709:range=tv:irange=tv';
const toBt709 = id => ({ bt601: CS_601_TO_709, bt709: null })[edl.matrix[id]];

async function ff(args) {
  const t0 = Date.now();
  await run('nice', ['-n', '10', 'ffmpeg', '-hide_banner', '-nostdin', '-y', '-v', 'error', ...args]);
  return (Date.now() - t0) / 1000;
}

/** Return the cached record for `key` if its file still exists unchanged, else build it. */
async function cached(key, build) {
  const f = path.join(CACHE, `${key}.json`);
  if (!FORCE && existsSync(f)) {
    const rec = readJson(f);
    // A record is one published file ({abs, bytes, ...}) or a pair of them ({avif, webp}).
    const files = rec.abs ? [rec] : Object.values(rec).filter(v => v && typeof v === 'object' && v.abs);
    if (files.length && files.every(a => existsSync(a.abs) && statSync(a.abs).size === a.bytes)) return rec;
  }
  const rec = await build();
  writeFileSync(f, JSON.stringify(rec));
  return rec;
}

/** Hash a finished temp file and move it to <dir>/<base>.<sha8>.<ext> via <final>.tmp. */
async function publish(tmp, dir, base, ext) {
  const sum = await sha256(tmp);
  const name = `${base}.${sum.slice(0, edl.hashLen)}.${ext}`;
  const abs = path.join(dir, name);
  if (!(existsSync(abs) && statSync(abs).size === statSync(tmp).size)) {
    copyFileSync(tmp, `${abs}.tmp`);
    renameSync(`${abs}.tmp`, abs);
  }
  rmSync(tmp, { force: true });
  return describe(abs, sum);
}

/** The manifest record of a published file, every field measured. */
async function describe(abs, sum) {
  const p = await probe(abs);
  const v = p.streams.find(s => s.codec_type === 'video');
  const ext = path.extname(abs).slice(1);
  const type = { mp4: 'video/mp4', avif: 'image/avif', webp: 'image/webp', jpg: 'image/jpeg' }[ext];
  const rel = path.relative(LANDING, abs).split(path.sep).join('/');
  const a = { src: `/${rel}`, bytes: statSync(abs).size, width: v.width, height: v.height, type };
  if (ext === 'mp4') {
    a.codecs = parseVideoCodec(abs).codecs;
    a.duration = Number(((await packets(abs)).length / FPS).toFixed(3));
  }
  return { ...a, abs, sha256: sum };
}
/** Manifest view of a record: exactly the `Asset` fields of landing/src/lib/media.ts. */
const asset = ({ src, bytes, width, height, type, codecs, duration }) =>
  ({ src, bytes, width, height, type, ...(codecs ? { codecs } : {}), ...(duration != null ? { duration } : {}) });

const report = []; // rows for the closing table
const note = (rec, budget, extra = '') => { report.push({ src: rec.src, bytes: rec.bytes, budget, extra }); return rec; };

// ---------------------------------------------------------------- encoders

function codecArgs(codec, s, crf) {
  if (codec === 'av1') return ['-c:v', 'libsvtav1', '-preset', String(s.preset), '-crf', String(crf), '-g', String(s.g),
    '-svtav1-params', 'tune=0', '-pix_fmt', 'yuv420p'];
  if (codec === 'h264') return ['-c:v', 'libx264', '-preset', s.preset, '-crf', String(crf), '-profile:v', 'high',
    '-level:v', '3.1', '-pix_fmt', 'yuv420p', '-g', String(s.g), '-keyint_min', String(s.keyintMin), '-bf', String(s.bf), '-tag:v', 'avc1'];
  throw new Error(codec);
}

/** Encode one MP4 rendition, raising CRF by 2 (up to 3 times) until it fits its budget.
 *  With a hard cap (the loops) a file still over budget but under the cap ships with a warning,
 *  so one busy shot cannot stall a release; without one (the film) the budget is the cap. */
async function encodeVideo({ input, inputKey, base, codec, s, budget, cap, pre = [], vf = null, extra = [] }) {
  const key = keyOf({ kind: 'video', inputKey, base, codec, s, budget, cap, pre, vf, extra });
  return cached(key, async () => {
    for (let attempt = 0, crf = s.crf; ; attempt++, crf += 2) {
      const tmp = path.join(TMP, `${base}.${codec}.tmp.mp4`);
      const secs = await ff([...pre, '-i', input, ...(vf ? ['-vf', vf] : []), ...CLEAN, ...codecArgs(codec, s, crf), ...extra,
        ...TAGS, '-movflags', '+faststart', tmp]);
      const bytes = statSync(tmp).size;
      console.log(`  ${base}.${codec} crf ${crf}: ${kb(bytes)} (budget ${kb(budget)}) in ${secs.toFixed(1)} s`);
      if (bytes <= budget || attempt === 3) {
        if (bytes > (cap ?? budget)) throw new Error(`${base}.${codec} is ${kb(bytes)} at crf ${crf}, over the ${kb(cap ?? budget)} ${cap ? 'hard cap' : 'budget'}`);
        if (bytes > budget) console.warn(`  WARN ${base}.${codec} ships over budget (${kb(bytes)} > ${kb(budget)}), under the ${kb(cap)} cap`);
        return { ...(await publish(tmp, MEDIA_DIR, `${base}.${codec}`, 'mp4')), crf };
      }
    }
  });
}

/** AVIF + WebP of one frame of a BT.709 yuv420p input (frame index, CFR). AVIF raises CRF by 3
 *  up to twice, WebP drops quality by 8 up to three times; past that the budget is a failure. */
async function encodeImages({ input, inputKey, frame = 0, base, s, budget, dir = MEDIA_DIR }) {
  const key = keyOf({ kind: 'images', inputKey, frame, base, s, budget });
  return cached(key, async () => {
    const pick = frame ? `select=eq(n\\,${frame}),` : '';
    const out = {};
    for (let attempt = 0, crf = s.crf; ; attempt++, crf += 3) {
      const tmp = path.join(TMP, `${base}.tmp.avif`);
      await ff(['-i', input, '-vf', `${pick}format=yuv420p`, '-frames:v', '1', ...CLEAN,
        '-c:v', 'libaom-av1', '-still-picture', '1', '-crf', String(crf), '-b:v', '0', '-cpu-used', '2', '-row-mt', '1',
        '-pix_fmt', 'yuv420p', ...TAGS, tmp]);
      const bytes = statSync(tmp).size;
      if (bytes <= budget.avif) { out.avif = { ...(await publish(tmp, dir, base, 'avif')), crf }; break; }
      if (attempt === 2) throw new Error(`${base}.avif is ${kb(bytes)} at crf ${crf}, budget ${kb(budget.avif)}`);
    }
    for (let attempt = 0, q = s.webpQuality; ; attempt++, q -= 8) {
      const tmp = path.join(TMP, `${base}.tmp.webp`);
      await ff(['-i', input, '-vf', `${pick}${CS_709_TO_601},format=yuv420p`, '-frames:v', '1', ...CLEAN,
        '-c:v', 'libwebp', '-quality', String(q), '-compression_level', '6', tmp]);
      const bytes = statSync(tmp).size;
      if (bytes <= budget.webp) { out.webp = { ...(await publish(tmp, dir, base, 'webp')), q }; break; }
      if (attempt === 3) throw new Error(`${base}.webp is ${kb(bytes)} at q ${q}, budget ${kb(budget.webp)}`);
    }
    return out;
  });
}

/** The lossless loop body for one candidate and crop: fps -> crop -> lanczos -> 601->709, then
 *  the head (in .. in+F) crossfaded onto the tail, so the last frame flows into frame 0 = in+F. */
async function loopIntermediate(loop, name, aspect) {
  const cand = loop.candidates[name]; const crop = loop.crops[aspect];
  const src = source(loop.src);
  const key = keyOf({ kind: 'loop-int', src: fp(src), cand, crop, fps: FPS, matrix: edl.matrix[loop.src] });
  const out = path.join(INT, `${loop.id}.${name}.${aspect}.${key.slice(0, 8)}.mkv`);
  if (!FORCE && existsSync(out)) return { file: out, key };
  const { len: L, xfade: F } = cand; const [x, y, w, h] = crop.rect; const [ow, oh] = crop.out;
  const chain = [`fps=${FPS}`, `crop=${w}:${h}:${x}:${y}`, `scale=${ow}:${oh}:flags=lanczos`, toBt709(loop.src),
    'setsar=1', 'format=yuv420p'].filter(Boolean).join(',');
  const graph = `[0:v]${chain},split[a][b];` +
    `[a]trim=start=${n6(F)}:duration=${n6(L)},setpts=PTS-STARTPTS[body];` +
    `[b]trim=start=0:duration=${n6(F)},setpts=PTS-STARTPTS[head];` +
    // format after xfade too: left alone, negotiation upsamples the result to yuv444p.
    `[body][head]xfade=transition=fade:duration=${n6(F)}:offset=${n6(L - F)},format=yuv420p[v]`;
  const tmp = `${out}.tmp.mkv`;
  const secs = await ff(['-ss', n6(cand.in), '-t', n6(L + F + 0.2), '-i', src, ...CLEAN, '-filter_complex', graph,
    '-map', '[v]', '-c:v', 'ffv1', '-level', '3', '-g', '1', '-pix_fmt', 'yuv420p', ...TAGS, tmp]);
  const frames = (await packets(tmp)).length;
  if (frames !== Math.round(L * FPS)) throw new Error(`${path.basename(out)}: ${frames} frames, expected ${Math.round(L * FPS)}`);
  renameSync(tmp, out);
  console.log(`  ${path.basename(out)}: ${frames} frames, ${n6(cand.in)}+${n6(L + F)} s of ${loop.src}, ${secs.toFixed(1)} s`);
  return { file: out, key };
}

/** Grey MSE (x1e3, 320x180, 0-1) between the frame the loop starts on and the frame its body
 *  would run into: the seam the crossfade has to hide. Measured, printed, not enforced. */
async function closure(loop, name) {
  const cand = loop.candidates[name]; const src = source(loop.src);
  const grab = async off => (await frameYuv(src, { pre: ['-ss', n6(cand.in), '-t', n6(off + 0.2)],
    vf: `fps=${FPS},trim=start=${n6(off)},scale=320:180:flags=area`, w: 320, h: 180 })).Y;
  const a = await grab(cand.xfade), b = await grab(cand.xfade + cand.len);
  let s = 0; for (let i = 0; i < a.length; i++) s += ((a[i] - b[i]) / 255) ** 2;
  return (s / a.length) * 1e3;
}

// ---------------------------------------------------------------- groups

const built = {};

async function buildPreview() {
  console.log(`\npreview -> ${PREVIEW_DIR}`);
  mkdirSync(PREVIEW_DIR, { recursive: true });
  for (const loop of edl.loops) {
    const names = Object.keys(loop.candidates);
    for (const name of names) {
      const c = loop.candidates[name];
      console.log(`  ${loop.id} ${name}: in ${c.in}, ${c.len} s, xfade ${c.xfade}, frame 0 = ${n6(c.in + c.xfade)} s, closure ${(await closure(loop, name)).toFixed(2)}`);
    }
    const font = (await run('fc-match', ['-f', '%{file}', 'DejaVu Sans:bold']).catch(() => null))?.stdout.toString();
    for (const aspect of Object.keys(loop.crops)) {
      const ints = {};
      for (const name of names) {
        ints[name] = (await loopIntermediate(loop, name, aspect)).file;
        const out = path.join(PREVIEW_DIR, `loop-${name}-${aspect}.mp4`);
        // Three passes back to back, so the seam is seen twice the way a looping <video> shows it.
        await ff(['-stream_loop', '2', '-i', ints[name], ...CLEAN, '-c:v', 'libx264', '-preset', 'medium', '-crf', '20',
          '-pix_fmt', 'yuv420p', ...TAGS, '-movflags', '+faststart', out]);
        const sheet = path.join(PREVIEW_DIR, `sheet-${name}-${aspect}.jpg`);
        const n = Math.round(loop.candidates[name].len * FPS);
        // Every 0.5 s, then the last 6 frames and the first 2: the crossfade and the wrap.
        await ff(['-i', ints[name], '-vf', `select='not(mod(n\\,15))+gte(n\\,${n - 6})+lte(n\\,1)',scale=-2:270,tile=6x3`,
          '-frames:v', '1', '-q:v', '3', sheet]);
        console.log(`  ${path.basename(out)}  ${path.basename(sheet)}`);
      }
      if (names.length === 2 && font) {
        const [A, B] = names; const ca = loop.candidates[A], cb = loop.candidates[B];
        const span = 3 * Math.max(ca.len, cb.len);
        const label = (nm, c) => `drawtext=fontfile=${font}:text='${nm}  ${n6(c.in + c.xfade)} s  ${c.len} s loop':x=16:y=16:fontsize=28:fontcolor=white:box=1:boxcolor=black@0.6:boxborderw=8`;
        const out = path.join(PREVIEW_DIR, `loop-${A}${B}-${aspect}.mp4`);
        await ff(['-stream_loop', String(Math.ceil(span / ca.len)), '-i', ints[A], '-stream_loop', String(Math.ceil(span / cb.len)), '-i', ints[B],
          '-filter_complex', `[0:v]${label(A, ca)}[a];[1:v]${label(B, cb)}[b];[a][b]hstack=inputs=2:shortest=1,format=yuv420p[v]`,
          '-map', '[v]', '-t', n6(span), ...CLEAN, '-c:v', 'libx264', '-preset', 'medium', '-crf', '22', ...TAGS, '-movflags', '+faststart', out]);
        console.log(`  ${path.basename(out)} (side by side)`);
      }
    }
  }
}

async function buildLoops() {
  built.loops = {};
  for (const loop of edl.loops) {
    const cand = loop.candidates[loop.pick];
    console.log(`\nloop ${loop.id}: candidate ${loop.pick}, ${loop.src} ${cand.in}+${cand.len} s, frame 0 = ${n6(cand.in + cand.xfade)} s`);
    const entry = { id: loop.id, source: loop.src, in: cand.in, out: Number(n6(cand.in + cand.len + cand.xfade)), duration: null, poster: {}, video: {} };
    for (const aspect of Object.keys(loop.crops)) {
      const { file, key } = await loopIntermediate(loop, loop.pick, aspect);
      const b = loop.budget[aspect]; const base = `${loop.id}.${aspect}`;
      const v = {};
      for (const codec of ['av1', 'h264']) {
        v[codec] = await encodeVideo({ input: file, inputKey: key, base, codec, s: loop[codec], budget: b[codec], cap: loop.hardCap });
        note(v[codec], b[codec], `crf ${v[codec].crf}`);
      }
      // Posters from frame 0 of the H.264 file: the frame the <video> paints when it takes over.
      const imgs = await encodeImages({ input: v.h264.abs, inputKey: v.h264.sha256, frame: 0, base: `${base}.poster`, s: loop.poster, budget: { avif: b.avif, webp: b.webp } });
      note(imgs.avif, b.avif, `crf ${imgs.avif.crf}`); note(imgs.webp, b.webp, `q ${imgs.webp.q}`);
      entry.video[aspect] = { av1: asset(v.av1), h264: asset(v.h264) };
      entry.poster[aspect] = { avif: asset(imgs.avif), webp: asset(imgs.webp) };
      entry.duration ??= v.h264.duration;
      if (loop.id === edl.hero) {
        for (const codec of ['h264', 'av1']) {
          const s = await skyCompare(edl, loop, aspect, v[codec].abs);
          console.log(`  sky ${aspect} ${codec}: raw as BT.601 ${fmtRgb(s.raw)}  output as BT.709 ${fmtRgb(s.out)}  max diff ${s.diff.toFixed(2)} levels`);
          if (s.diff > 2) throw new Error(`${base}.${codec}: frame-0 sky is ${s.diff.toFixed(2)} levels off the raw (max 2); the colour route is wrong`);
        }
      }
    }
    built.loops[loop.id] = entry;
  }
}

async function buildStills() {
  console.log('\nstills');
  built.stills = {};
  for (const st of edl.stills) {
    const src = source(st.src);
    const ss = Math.max(0, st.t - 0.5);
    const sizes = {};
    for (const [w, h] of edl.stillOut) {
      const key = keyOf({ kind: 'still', src: fp(src), t: st.t, w, h, matrix: edl.matrix[st.src] });
      const master = path.join(INT, `still.${st.id}.${w}.${key.slice(0, 8)}.mkv`);
      if (FORCE || !existsSync(master)) {
        await ff(['-ss', n6(ss), '-t', '1', '-i', src, '-vf',
          [`fps=${FPS}`, `trim=start=${n6(st.t - ss)}`, `scale=${w}:${h}:flags=lanczos`, toBt709(st.src), 'setsar=1', 'format=yuv420p'].filter(Boolean).join(','),
          '-frames:v', '1', ...CLEAN, '-c:v', 'ffv1', '-pix_fmt', 'yuv420p', ...TAGS, `${master}.tmp.mkv`]);
        renameSync(`${master}.tmp.mkv`, master);
      }
      const b = edl.stillBudget[String(w)];
      const imgs = await encodeImages({ input: master, inputKey: key, base: `${st.id}.${w}`, s: edl.still, budget: b });
      note(imgs.avif, b.avif, `crf ${imgs.avif.crf}`); note(imgs.webp, b.webp, `q ${imgs.webp.q}`);
      sizes[String(w)] = { avif: asset(imgs.avif), webp: asset(imgs.webp) };
    }
    built.stills[st.id] = { id: st.id, source: st.src, t: st.t, sizes };
    console.log(`  ${st.id}: ${st.src} @ ${st.t} s  (${st.shows})`);
  }
}

async function buildFilm() {
  const f = edl.film; const src = source(f.src);
  console.log('\nfilm');
  const times = [...f.chapters, ...f.links].sort((a, b) => a - b);
  const [w, h] = f.out;
  // Already BT.709 (the delivered film): scale only, no colour conversion.
  const common = { input: src, inputKey: fp(src), base: `film.${h}`, vf: [`scale=${w}:${h}:flags=lanczos`, toBt709(f.src), 'setsar=1', 'format=yuv420p'].filter(Boolean).join(','),
    extra: ['-fps_mode', 'cfr', '-r', String(FPS), '-force_key_frames', times.map(n6).join(',')] };
  const v = {};
  for (const codec of ['av1', 'h264']) {
    v[codec] = await encodeVideo({ ...common, codec, s: f[codec], budget: f.budget[codec] });
    note(v[codec], f.budget[codec], `crf ${v[codec].crf}`);
  }
  // The film's own title frame, taken from the H.264 rendition the poster stands in front of.
  const frame = Math.round(f.posterT * FPS);
  const imgs = await encodeImages({ input: v.h264.abs, inputKey: v.h264.sha256, frame, base: `film.${h}.poster`, s: f.poster, budget: { avif: f.budget.avif, webp: f.budget.webp } });
  note(imgs.avif, f.budget.avif, `frame ${frame}`); note(imgs.webp, f.budget.webp, `frame ${frame}`);
  built.film = { duration: v.h264.duration, poster: { avif: asset(imgs.avif), webp: asset(imgs.webp) },
    av1: asset(v.av1), h264: asset(v.h264), chapters: f.chapters, links: f.links };
}

async function buildOg() {
  const o = edl.og; const src = source(o.src);
  console.log('\nog');
  const key = keyOf({ kind: 'og', src: fp(src), o });
  built.og = asset(note(await cached(key, async () => {
    const [x, y, w, h] = o.crop;
    for (let attempt = 0, q = o.q; ; attempt++, q++) {
      const tmp = path.join(TMP, 'og-vr.tmp.jpg');
      // JPEG in, JPEG out: full-range BT.601 both sides, so no matrix is touched.
      await ff(['-i', src, '-vf', `crop=${w}:${h}:${x}:${y},scale=${o.out[0]}:${o.out[1]}:flags=lanczos`, '-frames:v', '1', ...CLEAN, '-q:v', String(q), tmp]);
      const bytes = statSync(tmp).size;
      if (bytes <= o.budget) return { ...(await publish(tmp, ASSETS, 'og-vr', 'jpg')), q };
      if (attempt === 3) throw new Error(`og-vr is ${kb(bytes)} at q ${q}, budget ${kb(o.budget)}`);
    }
  }), o.budget));
}

async function buildFallback() {
  const o = edl.heroFallback; const src = source(o.src);
  console.log('\nhero fallback');
  const key = keyOf({ kind: 'fallback', src: fp(src), o });
  built.heroFallback = asset(note(await cached(key, async () => {
    for (let attempt = 0, q = o.quality; ; attempt++, q -= 8) {
      const tmp = path.join(TMP, 'hero-fallback.tmp.webp');
      // bgra: libwebp does its own RGB->YUVA, so the PNG's colours and its alpha both survive.
      await ff(['-i', src, '-frames:v', '1', ...CLEAN, '-pix_fmt', 'bgra', '-c:v', 'libwebp', '-quality', String(q), '-compression_level', '6', tmp]);
      const bytes = statSync(tmp).size;
      if (bytes <= o.budget) return { ...(await publish(tmp, ASSETS, 'hero-fallback', 'webp')), q };
      if (attempt === 3) throw new Error(`hero-fallback is ${kb(bytes)} at q ${q}, budget ${kb(o.budget)}`);
    }
  }), o.budget));
}

// ---------------------------------------------------------------- run

if (want('preview')) await buildPreview();
if (want('hands')) await buildLoops();
if (want('stills')) await buildStills();
if (want('film')) await buildFilm();
if (want('og')) await buildOg();
if (want('fallback')) await buildFallback();

const wroteSomething = ['loops', 'stills', 'film', 'og', 'heroFallback'].some(k => built[k]);
if (wroteSomething) {
  const old = existsSync(MANIFEST_PATH) ? readJson(MANIFEST_PATH) : null;
  const m = {
    version: 1,
    edlHash,
    hero: edl.hero,
    loops: built.loops ?? old?.loops,
    stills: built.stills ?? old?.stills,
    film: built.film ?? old?.film,
    og: built.og ?? old?.og,
    heroFallback: built.heroFallback ?? old?.heroFallback,
  };
  const text = `${JSON.stringify(m, null, 1)}\n`;
  if (old && old.edlHash !== 'STUB' && JSON.stringify(old) !== JSON.stringify(m)) {
    writeFileSync(PREVIOUS_PATH, `${JSON.stringify(old, null, 1)}\n`);
  }
  writeFileSync(MANIFEST_PATH, text);
  const stub = JSON.stringify(m).includes('STUB');
  console.log(`\nwrote ${path.relative(ROOT, MANIFEST_PATH)}${stub ? '  (still holds STUB entries: run without --only)' : ''}`);
}

if (flag('--prune')) {
  const keep = referenced(readJson(MANIFEST_PATH));
  for (const pm of await previousManifests()) for (const u of referenced(pm)) keep.add(u);
  const sweep = (dir, urlDir, match) => {
    for (const name of readdirSync(dir)) {
      if (!match(name)) continue;
      if (keep.has(`${urlDir}/${name}`)) continue;
      rmSync(path.join(dir, name)); console.log(`  pruned ${urlDir}/${name}`);
    }
  };
  console.log('\nprune (keeping the current and the previous manifest)');
  sweep(MEDIA_DIR, '/assets/media', () => true); // nothing unreferenced belongs here, hashed or not
  sweep(ASSETS, '/assets', n => /^(og-vr|hero-fallback)\.[0-9a-f]{8}\.(jpg|webp)(\.tmp)?$/.test(n));
}

if (report.length) {
  const w = Math.max(...report.map(r => r.src.length));
  console.log(`\n${'file'.padEnd(w)}  ${'KB'.padStart(8)}  ${'budget'.padStart(8)}`);
  for (const r of report) console.log(`${r.src.padEnd(w)}  ${(r.bytes / 1000).toFixed(1).padStart(8)}  ${(r.budget / 1000).toFixed(1).padStart(8)}  ${r.extra}`);
}
const leftovers = readdirSync(MEDIA_DIR).filter(n => !HASHED.test(n));
if (leftovers.length) console.warn(`\nWARN unhashed files in assets/media: ${leftovers.join(', ')}`);
