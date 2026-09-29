import { cp, mkdir, rm, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
const out = path.join(root, '.generated-public');
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
// Only this allowlist can be published. Tooling and source files never enter dist.
for (const name of ['assets', 'download', 'privacy.html', 'terms.html', 'get-app.html', '50x.html', 'styles.css', 'main.js']) {
  try { await access(path.join(root, name)); } catch { continue; }
  await cp(path.join(root, name), path.join(out, name), { recursive: true });
}
