// Zero-dependency static server for AETHER. The camera API needs a secure context: http://localhost is one.
//   node server.mjs [port]      ->  http://localhost:5173
// It also proxies AETHER's agent "brain" to OpenRouter so the API key never reaches the browser:
//   GET  /api/aether/status     -> { online, models }
//   POST /api/aether            -> { messages, tools }  ->  { message, model }
// Put OPENROUTER_API_KEY=... in .env (see .env.example). OPENROUTER_MODEL=a,b,c pins the models to try, in order;
// otherwise the free models that support tool calling are discovered from OpenRouter and tried in turn.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)));
await loadEnv(join(ROOT, '.env'));
const PORT = Number(process.argv[2] || process.env.PORT || 5173);
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.wasm': 'application/wasm', '.task': 'application/octet-stream',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.map': 'application/json',
};

/** KEY=value lines; real environment variables win. */
async function loadEnv(path) {
  const text = await readFile(path, 'utf8').catch(() => '');
  for (const raw of text.split(/\r?\n/)) {
    const m = raw.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}

// ---------------------------------------------------------------- AETHER brain (OpenRouter)
const OR = 'https://openrouter.ai/api/v1';
const KEY = () => process.env.OPENROUTER_API_KEY || process.env.OPEN_ROUTER_KEY || process.env.OPENROUTER_KEY || '';
const FALLBACK_MODELS = ['meta-llama/llama-3.3-70b-instruct:free', 'qwen/qwen3-235b-a22b:free', 'mistralai/mistral-small-3.2-24b-instruct:free', 'deepseek/deepseek-chat-v3-0324:free'];
const PREFER = ['llama-3.3-70b', 'qwen3', 'deepseek-chat', 'gpt-oss', 'mistral-small', 'gemini', 'llama-4'];
let modelCache = { at: 0, list: [] };

/** Free models that accept tools, best first. Cached for an hour; a model that answered moves to the front. */
async function candidateModels() {
  if (process.env.OPENROUTER_MODEL) return process.env.OPENROUTER_MODEL.split(',').map((s) => s.trim()).filter(Boolean);
  if (modelCache.list.length && Date.now() - modelCache.at < 3600e3) return modelCache.list;
  try {
    const r = await fetch(`${OR}/models`, { signal: AbortSignal.timeout(10000) });
    const { data = [] } = await r.json();
    const free = data.filter((m) => (m.id.endsWith(':free') || (m.pricing?.prompt === '0' && m.pricing?.completion === '0'))
      && m.supported_parameters?.includes('tools') && !m.id.startsWith('openrouter/'));
    const rank = (m) => { const i = PREFER.findIndex((p) => m.id.includes(p)); return i < 0 ? PREFER.length : i; };
    free.sort((a, b) => rank(a) - rank(b) || (b.context_length || 0) - (a.context_length || 0));
    modelCache = { at: Date.now(), list: free.slice(0, 8).map((m) => m.id) };
  } catch (e) {
    console.warn('AETHER: could not list OpenRouter models, using defaults', e.message);
  }
  if (!modelCache.list.length) modelCache = { at: Date.now(), list: FALLBACK_MODELS };
  return modelCache.list;
}

/** One chat turn. Free models are often rate-limited, so try the candidates in order until one answers. */
async function think({ messages, tools }) {
  const models = await candidateModels(), errors = [];
  for (const model of models) {
    try {
      const r = await fetch(`${OR}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${KEY()}`, 'Content-Type': 'application/json', 'HTTP-Referer': `http://localhost:${PORT}`, 'X-Title': 'AETHER' },
        body: JSON.stringify({ model, messages, tools: tools?.length ? tools : undefined, max_tokens: 700, temperature: 0.6 }),
        signal: AbortSignal.timeout(45000),
      });
      const j = await r.json().catch(() => ({}));
      const message = j.choices?.[0]?.message;
      if (r.ok && message && !j.error) {
        if (!process.env.OPENROUTER_MODEL) modelCache.list = [model, ...modelCache.list.filter((m) => m !== model)];
        return { message, model: j.model || model };
      }
      errors.push(`${model}: ${r.status} ${j.error?.message || 'no answer'}`);
      if (r.status === 401 || r.status === 403) break;          // bad key: no point trying the others
    } catch (e) { errors.push(`${model}: ${e.message}`); }
  }
  throw new Error(errors.join(' · ') || 'no models available');
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const json = (res, code, body) => res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(body));
async function readBody(req, limit = 512 * 1024) {
  let size = 0; const chunks = [];
  for await (const c of req) { size += c.length; if (size > limit) throw new Error('request too large'); chunks.push(c); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

async function api(req, res, path) {
  // the key is yours: only this machine may spend it (set AETHER_ALLOW_LAN=1 to let phones on your network in)
  if (!LOOPBACK.has(req.socket.remoteAddress) && process.env.AETHER_ALLOW_LAN !== '1' && process.env.JARVIS_ALLOW_LAN !== '1') return json(res, 403, { error: 'AETHER only answers on localhost' });
  if (path === '/api/aether/status') {
    return json(res, 200, { online: !!KEY(), models: KEY() ? (await candidateModels()).slice(0, 3) : [] });
  }
  if (path === '/api/aether' && req.method === 'POST') {
    if (!KEY()) return json(res, 503, { error: 'OPENROUTER_API_KEY is not set (add it to .env and restart)' });
    try {
      const { messages, tools } = await readBody(req);
      if (!Array.isArray(messages) || !messages.length) return json(res, 400, { error: 'messages missing' });
      return json(res, 200, await think({ messages: messages.slice(-40), tools }));
    } catch (e) { return json(res, 502, { error: e.message }); }
  }
  return json(res, 404, { error: 'not found' });
}

// ---------------------------------------------------------------- static files
createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) { await api(req, res, url.pathname); return; }
    let path = normalize(join(ROOT, decodeURIComponent(url.pathname)));
    if (!path.startsWith(ROOT) || /[\\/]\.env/.test(path)) { res.writeHead(403).end('forbidden'); return; }
    if ((await stat(path).catch(() => null))?.isDirectory()) path = join(path, 'index.html');
    const body = await readFile(path);
    res.writeHead(200, { 'Content-Type': TYPES[extname(path).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(body);
  } catch {
    if (!res.headersSent) res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found');
  }
}).listen(PORT, () => console.log(`AETHER running at http://localhost:${PORT}  ·  brain: ${KEY() ? 'OpenRouter' : 'offline (add OPENROUTER_API_KEY to .env)'}`));
