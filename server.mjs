// Zero-dependency local server for AETHER. The camera API needs a secure context: http://localhost is one.
//   node server.mjs [port]      ->  http://localhost:5173
// It also proxies AETHER's agent "brain" to OpenRouter so the API key never reaches the browser (lib/brain.mjs,
// the same code the Vercel functions in api/ run):
//   GET  /api/aether/status     -> { online, models, locked }
//   POST /api/aether            -> { messages, tools }  ->  { message, model }
// Put OPENROUTER_API_KEY=... in .env (see .env.example). OPENROUTER_MODEL=a,b,c pins the (free) models to try, in order;
// otherwise the free models that support tool calling are discovered from OpenRouter and tried in turn.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)));
await loadEnv(join(ROOT, '.env'));
const { status, chat, guard, key, HttpError, BODY_LIMIT } = await import('./lib/brain.mjs');
const PORT = Number(process.argv[2] || process.env.PORT || 5173);
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.wasm': 'application/wasm', '.task': 'application/octet-stream',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.map': 'application/json', '.gif': 'image/gif', '.mp4': 'video/mp4',
};
// the hand-tracking runtime: served from node_modules here, copied to dist/vendor by scripts/build.mjs for Vercel
const VENDOR = { '/vendor/mediapipe/': join(ROOT, 'node_modules', '@mediapipe', 'tasks-vision') };

/** KEY=value lines; real environment variables win. */
async function loadEnv(path) {
  const text = await readFile(path, 'utf8').catch(() => '');
  for (const raw of text.split(/\r?\n/)) {
    const m = raw.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const json = (res, code, body) => res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(body));
async function readBody(req) {
  let size = 0; const chunks = [];
  for await (const c of req) { size += c.length; if (size > BODY_LIMIT) throw new HttpError(413, 'request too large'); chunks.push(c); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { throw new HttpError(400, 'bad JSON'); }
}

async function api(req, res, path) {
  const denied = guard(new Headers(req.headers), { host: req.headers.host, loopback: LOOPBACK.has(req.socket.remoteAddress) });
  if (denied && !(denied.status === 401 && path === '/api/aether/status')) return json(res, denied.status, { error: denied.message });
  try {
    if (path === '/api/aether/status') return json(res, 200, await status());
    if (path === '/api/aether' && req.method === 'POST') return json(res, 200, await chat(await readBody(req), { referer: `http://localhost:${PORT}` }));
    return json(res, 404, { error: 'not found' });
  } catch (e) { return json(res, e.status || 502, { error: e.message }); }
}

// ---------------------------------------------------------------- static files
createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) { await api(req, res, url.pathname); return; }
    const pathname = decodeURIComponent(url.pathname), alias = Object.keys(VENDOR).find((p) => pathname.startsWith(p));
    const base = alias ? VENDOR[alias] : ROOT;
    let path = normalize(join(base, alias ? pathname.slice(alias.length) : pathname));
    if (!path.startsWith(base) || /[\\/]\.env/.test(path)) { res.writeHead(403).end('forbidden'); return; }
    if ((await stat(path).catch(() => null))?.isDirectory()) path = join(path, 'index.html');
    const body = await readFile(path);
    res.writeHead(200, { 'Content-Type': TYPES[extname(path).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(body);
  } catch {
    if (!res.headersSent) res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found');
  }
}).listen(PORT, () => console.log(`AETHER running at http://localhost:${PORT}  ·  brain: ${key() ? 'OpenRouter' : 'offline (add OPENROUTER_API_KEY to .env)'}`));
