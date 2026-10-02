import { cp, mkdir, rm, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { apkManifest } from './apk-manifest.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const out = path.join(root, '.generated-public');
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
// Only this allowlist can be published. Tooling and source files never enter dist.
//   - download/ is deliberately absent: apk-manifest.mjs below validates the dropped APK and
//     publishes it under its content-hashed name only, so an unvalidated or stale file can
//     never be served from a stable URL.
//   - styles.css and main.js (the pre-Astro page) are gone: nothing has referenced them
//     since the Astro build, and shipping them only kept a dead stable-URL tier alive.
// The unminified three.module.js stays in the repo because scripts/check_hero.mjs resolves
// `three` to it under Node; the browser loads three.module.min.js, so dist skips 1.3 MB.
const SKIP = new Set(['assets/vendor/three/three.module.js']);
for (const name of ['assets', '50x.html']) {
  try { await access(path.join(root, name)); } catch { continue; }
  await cp(path.join(root, name), path.join(out, name), {
    recursive: true,
    filter: src => !SKIP.has(path.relative(root, src).split(path.sep).join('/')),
  });
}
// APK_DIR points a local build at a test APK without putting it in landing/download/
// (which is in the Docker build context). The image build never sets it.
try {
  await apkManifest({ apkDir: process.env.APK_DIR || undefined });
} catch (e) {
  console.error(`\nprepare-static: ${e.message}\n`);
  process.exit(1);
}
