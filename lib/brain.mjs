// AETHER's brain proxy, shared by the local server (server.mjs) and the Vercel functions (api/aether/*).
// It holds the OpenRouter key so the browser never sees it, and only ever calls FREE models, so a public deployment
// can't spend money: pinned models must end in ":free" unless AETHER_ALLOW_PAID=1.
//   status()                     -> { online, models, locked }
//   chat(body)                   -> { message, model }       (throws HttpError)
//   guard(headers, { host })     -> null | HttpError         (same-origin + optional access code)
const OR = 'https://openrouter.ai/api/v1';
const FALLBACK_MODELS = ['qwen/qwen3.8-27b:free', 'google/gemma-4-31b-it:free', 'nvidia/nemotron-3-super-120b-a12b:free', 'meta-llama/llama-3.3-70b-instruct:free'];
// general-purpose chat models first; coding-only and app-restricted models are skipped
const PREFER = ['qwen3', 'gemma-4', 'nemotron-3-super', 'nemotron-3.5', 'nemotron-3-ultra', 'llama', 'deepseek', 'gpt-oss', 'mistral', 'ling'];
const SKIP = /inkling|laguna|code|coder|preview|reasoning|2.6b|nano/i;
const blocked = new Set();                 // models that refused us (403/404): not retried by this instance
const BUDGET_MS = 50000, PER_MODEL_MS = 22000;   // Vercel functions stop at 60 s
const ROLES = new Set(['system', 'user', 'assistant', 'tool']);
const LIMITS = { messages: 40, chars: 24000, tools: 16, body: 256 * 1024 };
let modelCache = { at: 0, list: [] };

export class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
export const key = () => process.env.OPENROUTER_API_KEY || process.env.OPEN_ROUTER_KEY || process.env.OPENROUTER_KEY || '';
const freeOnly = (ids) => (process.env.AETHER_ALLOW_PAID === '1' ? ids : ids.filter((id) => id.endsWith(':free')));

/** Free models that accept tools, best first. Cached for an hour; a model that answered moves to the front. */
export async function candidateModels() {
  if (process.env.OPENROUTER_MODEL) return freeOnly(process.env.OPENROUTER_MODEL.split(',').map((s) => s.trim()).filter(Boolean));
  if (modelCache.list.length && Date.now() - modelCache.at < 3600e3) return modelCache.list.filter((m) => !blocked.has(m));
  try {
    const r = await fetch(`${OR}/models`, { signal: AbortSignal.timeout(10000) });
    const { data = [] } = await r.json();
    const free = data.filter((m) => m.id.endsWith(':free') && m.supported_parameters?.includes('tools') && !m.id.startsWith('openrouter/') && !SKIP.test(m.id));
    const rank = (m) => { const i = PREFER.findIndex((p) => m.id.includes(p)); return i < 0 ? PREFER.length : i; };
    free.sort((a, b) => rank(a) - rank(b) || (b.context_length || 0) - (a.context_length || 0));
    modelCache = { at: Date.now(), list: free.slice(0, 8).map((m) => m.id) };
  } catch (e) {
    console.warn('AETHER: could not list OpenRouter models, using defaults', e.message);
  }
  if (!modelCache.list.length) modelCache = { at: Date.now(), list: FALLBACK_MODELS };
  return modelCache.list;
}

export async function status() {
  return { online: !!key(), models: key() ? (await candidateModels()).slice(0, 3) : [], locked: !!process.env.AETHER_ACCESS_CODE };
}

/**
 * Who may spend the key. Local: this machine only (AETHER_ALLOW_LAN=1 opens the LAN). Deployed: requests must come
 * from the app's own origin (stops other websites from using it), plus the access code when AETHER_ACCESS_CODE is set.
 */
export function guard(headers, { host, loopback = null } = {}) {
  if (loopback === false && process.env.AETHER_ALLOW_LAN !== '1' && process.env.JARVIS_ALLOW_LAN !== '1') return new HttpError(403, 'AETHER only answers on localhost');
  const origin = headers.get('origin');
  if (origin && host) { try { if (new URL(origin).host !== host) return new HttpError(403, 'cross-origin requests are not allowed'); } catch { return new HttpError(403, 'bad origin'); } }
  const code = process.env.AETHER_ACCESS_CODE;
  if (code && headers.get('x-aether-code') !== code) return new HttpError(401, 'access code required: open the app with ?code=YOUR_CODE');
  return null;
}

/** Keep only what a chat turn needs, and cap its size, so the proxy can't be used as a general-purpose LLM relay. */
function sanitize(body) {
  const { messages, tools } = body || {};
  if (!Array.isArray(messages) || !messages.length) throw new HttpError(400, 'messages missing');
  const clean = messages.slice(-LIMITS.messages).map((m) => {
    if (!m || !ROLES.has(m.role)) throw new HttpError(400, 'bad message role');
    const out = { role: m.role, content: String(m.content ?? '').slice(0, LIMITS.chars) };
    if (m.tool_calls) out.tool_calls = m.tool_calls;
    if (m.tool_call_id) out.tool_call_id = String(m.tool_call_id);
    return out;
  });
  if (tools && (!Array.isArray(tools) || tools.length > LIMITS.tools)) throw new HttpError(400, 'too many tools');
  return { messages: clean, tools: tools?.length ? tools : undefined };
}

/** One chat turn. Free models are often rate-limited, so try the candidates in order until one answers. */
export async function chat(body, { referer = 'http://localhost' } = {}) {
  if (!key()) throw new HttpError(503, 'OPENROUTER_API_KEY is not set');
  const { messages, tools } = sanitize(body);
  const models = await candidateModels(), errors = [], t0 = Date.now();
  if (!models.length) throw new HttpError(503, 'no free models configured');
  for (const model of models) {
    const left = BUDGET_MS - (Date.now() - t0);
    if (left < 4000) { errors.push('out of time'); break; }
    try {
      const r = await fetch(`${OR}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key()}`, 'Content-Type': 'application/json', 'HTTP-Referer': referer, 'X-Title': 'AETHER' },
        body: JSON.stringify({ model, messages, tools, max_tokens: 700, temperature: 0.6 }),
        signal: AbortSignal.timeout(Math.min(PER_MODEL_MS, left)),
      });
      const j = await r.json().catch(() => ({}));
      const message = j.choices?.[0]?.message;
      if (r.ok && message && !j.error) {
        if (!process.env.OPENROUTER_MODEL) modelCache.list = [model, ...modelCache.list.filter((m) => m !== model)];
        return { message, model: j.model || model };
      }
      errors.push(`${model}: ${r.status} ${j.error?.message || 'no answer'}`);
      if (r.status === 401) break;                                // bad key: no point trying the others
      if (r.status === 403 || r.status === 404) { blocked.add(model); modelCache.list = modelCache.list.filter((m) => m !== model); }   // restricted / gone
    } catch (e) { errors.push(`${model}: ${e.message}`); }
  }
  throw new HttpError(502, errors.join(' · ') || 'no models available');
}

export const BODY_LIMIT = LIMITS.body;
