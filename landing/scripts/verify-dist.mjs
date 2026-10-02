/* Proves the image serves what its HTML points at. Runs in the Docker build stage right
 * after `astro build` (Dockerfile.landing), where there is node but no ffprobe, so it checks
 * bytes and names, not codecs (scripts/check-media.mjs does those on the dev box).
 *
 *   1. Every /assets/, /download/ and /film/ URL that any dist HTML or CSS references exists
 *      in dist. A missing poster or a stale hashed name is a broken page that no type
 *      checker sees; nginx would answer 404 with nothing logged.
 *   2. Hashed names are honest. Everything under /assets/ is served immutable for a year, so
 *      a name whose 8-hex segment is not the file's SHA-256 prefix would pin the wrong bytes
 *      in every cache, Cloudflare's included. Every file under dist/assets/media/ must carry
 *      such a hash, referenced or not (older hashes are kept for visitors mid-session).
 *   3. The APK: when src/generated/apk.json says available, the hashed file in dist has the
 *      manifest's bytes and SHA-256, it is the only file in dist/download/, it is the only
 *      /download/ URL anywhere, and every /vr/ page carries the same SHA-256 in data-sha256
 *      (the number a reader compares against shasum). When unavailable: no /download/
 *      reference anywhere and no data-sha256, i.e. the page really is in its coming-soon state.
 *
 * Exit 1 with every failure listed. Env: DIST_DIR, APK_JSON override the defaults.
 */
import { createReadStream } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const dist = path.resolve(process.env.DIST_DIR || path.join(root, 'dist'));
const apkJsonPath = path.resolve(process.env.APK_JSON || path.join(root, 'src/generated/apk.json'));
/** The /vr/ page in every locale (src/pages/[...lang]/vr/index.astro). */
const VR_PAGES = ['vr/index.html', 'es/vr/index.html', 'pt-br/vr/index.html'];

// The site origin, so absolute URLs to this site (og:image, JSON-LD downloadUrl) are checked
// too and every other host is left alone.
const config = await readFile(path.join(root, 'astro.config.mjs'), 'utf8').catch(() => '');
const siteHost = (() => { try { return new URL(/site:\s*['"]([^'"]+)['"]/.exec(config)?.[1] ?? '').host; } catch { return ''; } })();

const failures = [];
const fail = msg => failures.push(msg);
let checked = 0;

async function walk(dir) {
  const out = [];
  let entries = [];
  try { entries = await readdir(dir, { withFileTypes: true }); } catch (e) { if (e.code === 'ENOENT') return out; throw e; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...await walk(full));
    else if (e.isFile()) out.push(full);
  }
  return out;
}

const hashes = new Map();
function sha256(file) {
  if (!hashes.has(file)) {
    hashes.set(file, new Promise((resolve, reject) => {
      const h = createHash('sha256');
      createReadStream(file, { highWaterMark: 1 << 20 }).on('data', c => h.update(c)).on('error', reject).on('end', () => resolve(h.digest('hex')));
    }));
  }
  return hashes.get(file);
}
async function isFile(file) {
  try { return (await stat(file)).isFile(); } catch { return false; }
}
const toDist = urlPath => path.join(dist, ...decodeURIComponent(urlPath).split('/').filter(Boolean));
/** `name.<8 hex>.ext` or `name.<aspect>.<codec>.<8 hex>.ext`: the last dot-segment before the
 *  extension. Returns null for an unhashed name. */
const hashOf = file => /\.([0-9a-f]{8})\.[a-z0-9]+$/i.exec(path.basename(file))?.[1]?.toLowerCase() ?? null;

if (!(await isFile(path.join(dist, 'index.html')))) {
  console.error(`verify-dist: ${dist}/index.html is missing. Run astro build first.`);
  process.exit(1);
}

// ---------------------------------------------------------------- 1. references
// Root-relative (/assets/...), locale-prefixed (/es/film/...) or absolute to this site.
// srcset lists, CSS url(), importmaps and JSON-LD are all just text to this scan.
const REF = /(https?:\/\/[^\/\s"'<>]+)?(\/(?:(?:es|pt-br)\/)?(?:assets|download|film)\/[^\s"'`()<>,\\]*)/g;
const files = await walk(dist);
const pages = files.filter(f => /\.(html|css)$/.test(f));
const refs = new Map();  // url path -> Set of dist files referencing it
for (const file of pages) {
  const text = await readFile(file, 'utf8');
  for (const m of text.matchAll(REF)) {
    if (m[1]) { try { if (new URL(m[1]).host !== siteHost) continue; } catch { continue; } }
    else if (m.index > 0 && /[\w.~\/-]/.test(text[m.index - 1])) continue;  // the tail of some other path
    const urlPath = m[2].split(/[?#&]/)[0];
    if (!refs.has(urlPath)) refs.set(urlPath, new Set());
    refs.get(urlPath).add(path.relative(dist, file));
  }
}
const where = urlPath => [...refs.get(urlPath)].slice(0, 3).join(', ') + (refs.get(urlPath).size > 3 ? ', ...' : '');

for (const urlPath of [...refs.keys()].sort()) {
  if (urlPath.endsWith('/')) continue;  // a directory prefix: the importmap's three/addons/, or /download/ (nginx redirects it)
  const file = toDist(urlPath);
  checked++;
  if (!(await isFile(file))) { fail(`${urlPath} is referenced by ${where(urlPath)} but is not in dist`); continue; }
  const h = urlPath.startsWith('/assets/') ? hashOf(file) : null;
  if (h && !(await sha256(file)).startsWith(h)) fail(`${urlPath}: the name says ${h} but its SHA-256 starts ${(await sha256(file)).slice(0, 8)}; an immutable URL would pin the wrong bytes`);
}

// ---------------------------------------------------------------- 2. media names
for (const file of files.filter(f => f.startsWith(path.join(dist, 'assets', 'media') + path.sep))) {
  checked++;
  const h = hashOf(file);
  const name = path.relative(dist, file);
  if (!h) { fail(`${name} has no content hash in its name, but /assets/ is served immutable`); continue; }
  const digest = await sha256(file);
  if (!digest.startsWith(h)) fail(`${name}: the name says ${h} but its SHA-256 starts ${digest.slice(0, 8)}`);
}

// ---------------------------------------------------------------- 3. the APK
let apk;
try { apk = JSON.parse(await readFile(apkJsonPath, 'utf8')); } catch (e) {
  fail(`cannot read ${path.relative(root, apkJsonPath)} (${e.message}); prepare-static.mjs writes it`);
  apk = null;
}
const downloads = [...refs.keys()].filter(u => u.startsWith('/download/') && u !== '/download/');
const shipped = (await walk(path.join(dist, 'download'))).map(f => path.relative(dist, f).split(path.sep).join('/'));
const vrHtml = {};
for (const page of VR_PAGES) {
  const file = path.join(dist, page);
  if (await isFile(file)) vrHtml[page] = await readFile(file, 'utf8');
  else fail(`dist/${page} is missing: the /vr/ page did not build in every locale`);
}
const shaAttrs = html => [...html.matchAll(/data-sha256="([^"]*)"/g)].map(m => m[1]);

if (apk?.available === true) {
  const { version, file, href, bytes, sha256: expected } = apk;
  const hashed = `/download/ImplantPlanVR-${version}-${String(expected).slice(0, 8)}.apk`;
  if (!/^[0-9a-f]{64}$/.test(expected)) fail(`apk.json sha256 is not 64 lowercase hex: ${expected}`);
  if (file !== `ImplantPlanVR-${version}.apk`) fail(`apk.json file is "${file}", expected ImplantPlanVR-${version}.apk`);
  if (href !== hashed) fail(`apk.json href is "${href}", expected ${hashed}`);
  if (!Number.isSafeInteger(bytes) || bytes <= 0) fail(`apk.json bytes is not a positive integer: ${bytes}`);
  const onDisk = toDist(href);
  checked++;
  if (!(await isFile(onDisk))) fail(`${href} is in apk.json but not in dist`);
  else {
    const { size } = await stat(onDisk);
    if (size !== bytes) fail(`${href} is ${size} bytes in dist; apk.json says ${bytes}`);
    const digest = await sha256(onDisk);
    if (digest !== expected) fail(`${href} hashes to ${digest} in dist; apk.json says ${expected}`);
  }
  const strays = shipped.filter(f => `/${f}` !== href);
  if (strays.length) fail(`dist/download/ holds more than the current APK: ${strays.join(', ')}`);
  for (const u of downloads) if (u !== href) fail(`${where(u)} links ${u}, which is not the current APK (${href})`);
  for (const [page, html] of Object.entries(vrHtml)) {
    const attrs = shaAttrs(html);
    if (!attrs.length) fail(`dist/${page} has no data-sha256; it should carry ${expected}`);
    for (const a of attrs) if (a !== expected) fail(`dist/${page} shows data-sha256="${a}", but the APK in dist is ${expected}`);
    if (!html.includes(`href="${href}"`)) fail(`dist/${page} does not link ${href}`);
    if (!html.includes(`download="${file}"`)) fail(`dist/${page} does not set download="${file}", so the saved name would not match the adb command`);
  }
} else if (apk) {
  if (apk.available !== false) fail(`apk.json "available" is ${JSON.stringify(apk.available)}, neither true nor false`);
  for (const u of downloads) fail(`${where(u)} links ${u}, but apk.json says no APK is available`);
  if (shipped.length) fail(`dist/download/ is not empty although apk.json says no APK: ${shipped.join(', ')}`);
  for (const [page, html] of Object.entries(vrHtml)) {
    if (shaAttrs(html).length) fail(`dist/${page} carries data-sha256 although no APK is available`);
  }
}

// ---------------------------------------------------------------- report
const state = apk?.available ? `APK ${apk.version} (${apk.bytes} bytes, sha256 ${apk.sha256})` : 'no APK: /vr/ in its coming-soon state';
if (failures.length) {
  console.error(`verify-dist: ${failures.length} failure${failures.length > 1 ? 's' : ''} in ${path.relative(process.cwd(), dist) || dist}:`);
  for (const f of failures) console.error(`  FAIL ${f}`);
  process.exit(1);
}
console.log(`verify-dist: ${checked} files checked, ${refs.size} referenced URLs, ${state}. OK`);
