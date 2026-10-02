/* The ImplantPlan VR APK, from a hand-dropped file to a content-hashed download plus the
 * manifest the /vr/ page renders from (src/generated/apk.json, typed in src/lib/apk.ts).
 *
 * Gustavo drops the signed build into landing/download/ (gitignored, so it reaches the
 * Docker build context but never git). This script is the only way it gets published:
 * `download/` is not on prepare-static.mjs's copy allowlist, so a file that fails here
 * cannot ship under any name.
 *
 * Three outcomes, and which ones stop the build is an owner decision (2026-10-01):
 *   - no APK at all       -> {available:false} and a loud warning. Production DEPLOYS like
 *                            this: /vr/ shows "The download opens here shortly." with no
 *                            button, version, size or SHA, and a later tag adds the file.
 *   - exactly one, valid  -> hashed copy + {available:true, ...}.
 *   - anything else       -> throw. A misnamed APK, two candidates, a truncated upload or a
 *                            zip that is not an Android package would otherwise publish a
 *                            page whose figures describe the wrong bytes, or silently fall
 *                            back to "coming soon" while the owner thinks it shipped.
 *
 * Every figure on the page (version, bytes, SHA-256) is read off the file here. Nothing is
 * typed: the version comes from the file NAME, because reading versionName would mean
 * parsing binary AXML, and the name is what the page tells people to type into adb.
 *
 * CLI (the tests, and a quick look without a full build):
 *   APK_DIR=<dir with the .apk> OUT_DIR=<public root> APK_JSON=<manifest path> node scripts/apk-manifest.mjs
 * Each variable defaults to the real location; prepare-static.mjs imports `apkManifest`.
 */
import { createReadStream } from 'node:fs';
import { copyFile, link, mkdir, open, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

/** ImplantPlanVR-<semver>.apk. The capture is what adb, the page and the hashed URL all use. */
export const APK_NAME = /^ImplantPlanVR-(\d+\.\d+\.\d+(?:[-+][\w.]+)?)\.apk$/;
/** Decimal, like the size the page prints. A Quest build with Unity/OpenXR is tens of MB;
 *  anything under 5 MB is a stub, an LFS pointer or an interrupted copy. */
const MIN_BYTES = 5_000_000;

const LOCAL_FILE_SIG = 0x04034b50;  // "PK\x03\x04"
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
const ZIP64_LOCATOR_SIG = 0x07064b50;
const ZIP64_EOCD_SIG = 0x06064b50;
const EOCD_BYTES = 22;
/** The EOCD is the last record, followed only by a comment of at most 0xffff bytes. */
const EOCD_SEARCH = EOCD_BYTES + 0xffff;  // 65,557
/** A central directory is ~80 bytes per entry; 64 MiB is far past any real APK and keeps a
 *  corrupt size field from asking for gigabytes. */
const MAX_CENTRAL_BYTES = 64 * 1024 * 1024;

/** Short path for messages: relative when it is under the cwd, absolute otherwise. */
const rel = p => { const r = path.relative(process.cwd(), p); return !r ? '.' : r.startsWith('..') ? p : r; };

class ApkError extends Error {}
const bad = (file, why) => new ApkError(`${rel(file)}: ${why}`);

/** pread that refuses short reads: a truncated file must fail here, not parse zeros. */
async function readAt(fh, file, length, position) {
  const buf = Buffer.alloc(length);
  const { bytesRead } = await fh.read(buf, 0, length, position);
  if (bytesRead !== length) throw bad(file, `truncated: wanted ${length} bytes at offset ${position}, got ${bytesRead}`);
  return buf;
}

/**
 * Structural check, enough to know the file is a complete zip that is an Android package.
 * It reads the header, the tail and the central directory, never the whole file. It is not
 * signature verification: the published SHA-256 is what lets a reader check the bytes.
 */
async function validateApk(file) {
  const fh = await open(file, 'r');
  try {
    const { size } = await fh.stat();
    if (size < MIN_BYTES) throw bad(file, `${size} bytes, under the ${MIN_BYTES.toLocaleString('en')}-byte floor. A real build is far larger; this looks like a stub or an interrupted copy.`);

    const head = await readAt(fh, file, 4, 0);
    if (head.readUInt32LE(0) !== LOCAL_FILE_SIG) throw bad(file, 'does not start with a zip local file header (PK\\x03\\x04), so it is not an APK.');

    // Scan backwards for the End of Central Directory record. The signature bytes can occur
    // inside the archive comment, so a hit only counts when its own comment length lands
    // exactly on the end of the file.
    const tailLen = Math.min(size, EOCD_SEARCH);
    const tailStart = size - tailLen;
    const tail = await readAt(fh, file, tailLen, tailStart);
    let eocd = -1;
    for (let i = tailLen - EOCD_BYTES; i >= 0; i--) {
      if (tail.readUInt32LE(i) === EOCD_SIG && i + EOCD_BYTES + tail.readUInt16LE(i + 20) === tailLen) { eocd = i; break; }
    }
    if (eocd < 0) throw bad(file, `no End of Central Directory record in its last ${EOCD_SEARCH.toLocaleString('en')} bytes: the upload is truncated or this is not a zip.`);

    let entries = tail.readUInt16LE(eocd + 10);
    let cdSize = tail.readUInt32LE(eocd + 12);
    let cdOffset = tail.readUInt32LE(eocd + 16);
    // ZIP64: the classic fields saturate and the real values live in the ZIP64 record, which
    // the locator 20 bytes before the EOCD points at. Rare for an APK, but legal.
    if (entries === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
      const loc = eocd - 20;
      if (loc < 0 || tail.readUInt32LE(loc) !== ZIP64_LOCATOR_SIG) throw bad(file, 'ZIP64 sentinel values but no ZIP64 locator before the end record.');
      const recordAt = Number(tail.readBigUInt64LE(loc + 8));
      const record = await readAt(fh, file, 56, recordAt);
      if (record.readUInt32LE(0) !== ZIP64_EOCD_SIG) throw bad(file, 'the ZIP64 locator points at something that is not a ZIP64 end record.');
      entries = Number(record.readBigUInt64LE(32));
      cdSize = Number(record.readBigUInt64LE(40));
      cdOffset = Number(record.readBigUInt64LE(48));
    }
    if (cdOffset + cdSize > tailStart + eocd) throw bad(file, `its central directory (${cdSize} bytes at ${cdOffset}) runs past the end record at ${tailStart + eocd}.`);
    if (cdSize > MAX_CENTRAL_BYTES) throw bad(file, `central directory claims ${cdSize} bytes; refusing to read that much.`);

    // Walk every central directory header. The count has to agree with the end record, which
    // also catches a directory that was cut short.
    const cd = await readAt(fh, file, cdSize, cdOffset);
    let p = 0, seen = 0, manifest = false;
    while (p + 46 <= cd.length && cd.readUInt32LE(p) === CENTRAL_SIG) {
      const nameLen = cd.readUInt16LE(p + 28), extraLen = cd.readUInt16LE(p + 30), commentLen = cd.readUInt16LE(p + 32);
      if (p + 46 + nameLen > cd.length) break;
      if (cd.toString('utf8', p + 46, p + 46 + nameLen) === 'AndroidManifest.xml') manifest = true;
      p += 46 + nameLen + extraLen + commentLen;
      seen++;
    }
    if (seen !== entries) throw bad(file, `the central directory lists ${seen} entries but the end record says ${entries}.`);
    if (!manifest) throw bad(file, 'is a zip with no AndroidManifest.xml entry, so it is not an Android package.');
    return { size, entries };
  } finally {
    await fh.close();
  }
}

async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file, { highWaterMark: 1 << 20 })) hash.update(chunk);
  return hash.digest('hex');
}

/**
 * A hard link, not a copy, when both sides share a filesystem. On the dev box buffered
 * writes to / run at ~7 MB/s and a bulk write can starve the k3s node, so a 150 MB copy
 * here (and another when Astro copies publicDir into dist) is real cost for no gain. The
 * link is safe: the source is never written in place by anything in the build, and
 * .generated-public is rebuilt from scratch on every run.
 */
async function place(src, dest) {
  try {
    await link(src, dest);
    return 'linked';
  } catch (e) {
    if (!['EXDEV', 'EPERM', 'ENOTSUP', 'EMLINK', 'EACCES'].includes(e.code)) throw e;
  }
  await copyFile(src, dest);
  return 'copied';
}

/** Written only when it changes (git status and the Astro dev watcher both notice), and
 *  atomically, so a concurrent `astro dev` never imports half a file. The unavailable form
 *  is byte-identical to the committed stub. */
async function writeManifest(file, manifest) {
  const text = manifest.available ? `${JSON.stringify(manifest, null, 2)}\n` : '{ "available": false }\n';
  let previous = null;
  try { previous = await readFile(file, 'utf8'); } catch { /* first run */ }
  if (previous === text) return;
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, text);
  await rename(tmp, file);
}

function warnNoApk(apkDir) {
  const line = '!'.repeat(80);
  console.warn([
    '',
    line,
    '!!  NO ImplantPlan VR APK: /vr/ builds in its coming-soon state.',
    `!!  Looked in ${rel(apkDir)}/ for ImplantPlanVR-<x.y.z>.apk and found none.`,
    '!!  The page says "The download opens here shortly." and shows no button,',
    '!!  version, size or SHA-256; its JSON-LD carries no downloadUrl.',
    '!!  To ship the download: drop the signed APK there, rebuild, then run',
    '!!  scripts/verify-dist.mjs and scripts/check_landing_image.sh <tag>.',
    '!!  This is a warning, not an error: production may deploy without the APK.',
    line,
    '',
  ].join('\n'));
}

/**
 * @param {{apkDir?: string, outDir?: string, manifestPath?: string}} [options]
 *   apkDir: where the dropped APK is looked for (default landing/download).
 *   outDir: the public root; the hashed APK lands in <outDir>/download/ (default .generated-public).
 *   manifestPath: the JSON the page imports (default src/generated/apk.json).
 */
export async function apkManifest({
  apkDir = path.join(root, 'download'),
  outDir = path.join(root, '.generated-public'),
  manifestPath = path.join(root, 'src/generated/apk.json'),
} = {}) {
  // Start from an empty download/ so a stale hashed APK from an earlier run can never ship
  // next to (or instead of) the current one.
  const downloadOut = path.join(outDir, 'download');
  await rm(downloadOut, { recursive: true, force: true });

  let names = [];
  try { names = await readdir(apkDir); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  // Anything ending in .apk is a candidate. .gitkeep, .DS_Store and notes are ignored.
  const candidates = names.filter(n => /\.apk$/i.test(n)).sort();
  const misnamed = candidates.filter(n => !APK_NAME.test(n));
  if (misnamed.length) {
    throw new ApkError(`${rel(apkDir)}/ holds ${misnamed.map(n => `"${n}"`).join(', ')}, which ${misnamed.length > 1 ? 'do' : 'does'} not match ImplantPlanVR-<x.y.z>.apk. Rename it: the version in the name is what the page prints and what adb is told to install.`);
  }
  if (candidates.length > 1) {
    throw new ApkError(`${rel(apkDir)}/ holds ${candidates.length} APKs (${candidates.join(', ')}). Keep exactly one; the page can only describe one build.`);
  }
  if (candidates.length === 0) {
    warnNoApk(apkDir);
    const manifest = { available: false };
    await writeManifest(manifestPath, manifest);
    return manifest;
  }

  const name = candidates[0];
  const version = APK_NAME.exec(name)[1];
  const dropped = path.join(apkDir, name);
  let source;
  try {
    source = await realpath(dropped);
    if (!(await stat(source)).isFile()) throw new ApkError(`${rel(dropped)} is not a regular file.`);
  } catch (e) {
    if (e instanceof ApkError) throw e;
    // The usual cause is a symlink to a file outside the Docker build context: COPY brings
    // the link, not its target.
    throw new ApkError(`${rel(dropped)} cannot be read (${e.code || e.message}). If it is a symlink, drop the file itself; Docker copies the link, not what it points at.`);
  }

  const { size } = await validateApk(source);
  const digest = await sha256(source);
  const after = await stat(source);
  if (after.size !== size) throw new ApkError(`${rel(dropped)} changed size while it was being hashed (${size} -> ${after.size}). Wait for the copy to finish and rebuild.`);

  const hashedName = `ImplantPlanVR-${version}-${digest.slice(0, 8)}.apk`;
  await mkdir(downloadOut, { recursive: true });
  const how = await place(source, path.join(downloadOut, hashedName));

  const manifest = {
    available: true,
    version,
    file: name,
    href: `/download/${hashedName}`,
    bytes: size,
    sha256: digest,
  };
  await writeManifest(manifestPath, manifest);
  console.log(`apk-manifest: ${name} -> ${manifest.href} (${size.toLocaleString('en')} bytes, sha256 ${digest}, ${how})`);
  return manifest;
}

// Run directly: env overrides, and a one-line error instead of a stack for the expected failures.
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    await apkManifest({
      apkDir: process.env.APK_DIR || undefined,
      outDir: process.env.OUT_DIR || undefined,
      manifestPath: process.env.APK_JSON || undefined,
    });
  } catch (e) {
    console.error(`\napk-manifest: ${e instanceof ApkError ? e.message : e.stack}\n`);
    process.exit(1);
  }
}
