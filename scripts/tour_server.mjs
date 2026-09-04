/* Static `web/` plus a `/v1` proxy, for the tour recording only.
 *
 * The app expects the API on the same origin (its `API` base is derived from where the
 * bundle was served from). Two servers on two ports would put every fetch through CORS
 * and a bearer-less preflight, so this fronts both: files from `web/`, and anything under
 * `/v1` proxied to the real FastAPI app running on loopback.
 *
 * A proxy rather than a reimplementation on purpose. Every JSON the tour shows -- the
 * model menu, the job row, the arch manifest, and above all `POST /jobs/<id>/measure` --
 * comes from the code that serves the live site, so what is on screen is the product
 * rather than a fixture that resembles it.
 */
import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const PORT = Number(process.argv[2] || 8807);
const API_PORT = Number(process.argv[3] || 8808);
const WEB = path.join(path.dirname(path.dirname(new URL(import.meta.url).pathname)), 'web');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.jpg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.msh': 'application/octet-stream', '.raw': 'application/octet-stream',
};

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname.startsWith('/v1')) {
    const body = ['GET', 'HEAD'].includes(req.method) ? undefined
      : await new Promise((ok) => {
        const chunks = []; req.on('data', (c) => chunks.push(c));
        req.on('end', () => ok(Buffer.concat(chunks)));
      });
    try {
      const upstream = await fetch(`http://127.0.0.1:${API_PORT}${req.url}`, {
        method: req.method,
        headers: { 'content-type': req.headers['content-type'] || 'application/json' },
        body,
      });
      const buf = Buffer.from(await upstream.arrayBuffer());
      // `worker/bake.py` writes `.gz` siblings and the API serves them with
      // `Content-Encoding: gzip`. Node's fetch DECODES that transparently, so `buf` is
      // already plain and the right thing is to send the decoded length and NOT forward
      // the encoding header -- forwarding it would tell the browser to inflate bytes
      // that are already inflated.
      const headers = {
        'content-type': upstream.headers.get('content-type') || 'application/json',
        'content-length': buf.length,
      };
      const etag = upstream.headers.get('etag');
      if (etag) headers.etag = etag;
      return res.writeHead(upstream.status, headers).end(buf);
    } catch (e) {
      res.writeHead(502).end(JSON.stringify({ detail: `tour proxy: ${e.message}` }));
      return;
    }
  }

  let p = decodeURIComponent(url.pathname);
  if (p === '/' || p === '') p = '/index.html';
  const file = path.join(WEB, p);
  // SPA fallback, as `docker/web-default.conf` does: a deep link must not 404.
  const target = (!file.startsWith(WEB) || !existsSync(file) || statSync(file).isDirectory())
    ? path.join(WEB, 'index.html') : file;
  const buf = readFileSync(target);
  res.writeHead(200, {
    'content-type': MIME[path.extname(target)] || 'application/octet-stream',
    'content-length': buf.length,
    'cache-control': 'no-cache',
  });
  res.end(buf);
}).listen(PORT, '127.0.0.1', () => console.log(`tour server on ${PORT} -> api ${API_PORT}`));
