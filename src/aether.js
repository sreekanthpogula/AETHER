// AETHER: the conversational layer on top of the hologram. The Core (an LLM on OpenRouter, proxied by server.mjs so
// the key stays on the server) hands each request to specialist agents (agents.js) that run in parallel, each with
// its own tool loop in the browser. Every task and tool step is reported through hooks.onTask, which the app draws
// as the agent dots and task cards. Without a key (or when the brain is down) the same agents run on local rules.
// Kept free of app state: the app passes in context(), run(tool, args), command(text), speak() and the UI hooks.
import { AGENTS, SPECIALISTS, agentTools, corePrompt, agentPrompt, route } from './agents.js';

/** "Aether, …" / "hey Aether …" (plus the ways speech recognition hears it). */
const WAKE = /^\s*(?:(?:hey|ok|okay|hi|yo)[\s,]+)?(?:aether|ether|aither|ayther|eether|esther)\b[\s,.!?:;-]*/i;
export function stripWake(text) {
  const m = String(text).match(WAKE);
  return m ? { woke: true, rest: text.slice(m[0].length).trim() } : { woke: false, rest: String(text).trim() };
}

const FOLLOW_UP_MS = 8000;           // after AETHER answers, the next sentence needs no wake word
const IDLE_AFTER_MS = 2600;          // an agent's dot shows done / error this long, then dims

// ---------------------------------------------------------------- world + knowledge tools (free, no key)
const WMO = { 0: 'clear sky', 1: 'mainly clear', 2: 'partly cloudy', 3: 'overcast', 45: 'fog', 48: 'freezing fog', 51: 'light drizzle', 53: 'drizzle', 55: 'heavy drizzle',
  61: 'light rain', 63: 'rain', 65: 'heavy rain', 66: 'freezing rain', 67: 'freezing rain', 71: 'light snow', 73: 'snow', 75: 'heavy snow', 77: 'snow grains',
  80: 'rain showers', 81: 'rain showers', 82: 'violent rain showers', 85: 'snow showers', 86: 'snow showers', 95: 'a thunderstorm', 96: 'a thunderstorm with hail', 99: 'a thunderstorm with hail' };
async function geocode(city) {
  const g = await (await fetch(`https://geocoding-api.open-meteo.com/v1/search?count=1&name=${encodeURIComponent(city)}`)).json();
  return g.results?.[0] || null;
}
export async function weather(city) {
  if (!city) return { ok: false, error: 'no city given: ask the user which city' };
  try {
    const p = await geocode(city);
    if (!p) return { ok: false, error: `no place called ${city}` };
    const w = await (await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${p.latitude}&longitude=${p.longitude}&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m`)).json();
    const c = w.current;
    return { ok: true, place: `${p.name}${p.country ? ', ' + p.country : ''}`, conditions: WMO[c.weather_code] || 'unknown conditions',
      temperatureC: c.temperature_2m, feelsLikeC: c.apparent_temperature, humidityPct: c.relative_humidity_2m, windKmh: c.wind_speed_10m };
  } catch (e) { return { ok: false, error: `weather service unreachable (${e.message})` }; }
}
export async function worldClock(city) {
  if (!city) return { ok: false, error: 'no city given' };
  try {
    const p = await geocode(city);
    if (!p?.timezone) return { ok: false, error: `no place called ${city}` };
    const now = new Date(), tz = p.timezone;
    return { ok: true, place: `${p.name}${p.country ? ', ' + p.country : ''}`, timezone: tz,
      time: now.toLocaleTimeString([], { timeZone: tz, hour: 'numeric', minute: '2-digit' }), date: now.toLocaleDateString([], { timeZone: tz, weekday: 'long', month: 'long', day: 'numeric' }) };
  } catch (e) { return { ok: false, error: `time service unreachable (${e.message})` }; }
}
const WIKI = 'https://en.wikipedia.org';
const strip = (h) => String(h || '').replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#0?39;/g, "'");
export async function wikiSearch(query) {
  if (!query) return { ok: false, error: 'empty query' };
  try {
    const j = await (await fetch(`${WIKI}/w/api.php?action=query&list=search&format=json&origin=*&srlimit=3&srsearch=${encodeURIComponent(query)}`)).json();
    const results = (j.query?.search || []).map((r) => ({ title: r.title, snippet: strip(r.snippet) }));
    return results.length ? { ok: true, results } : { ok: false, error: `nothing on Wikipedia for ${query}` };
  } catch (e) { return { ok: false, error: `Wikipedia unreachable (${e.message})` }; }
}
export async function wikiSummary(title) {
  if (!title) return { ok: false, error: 'no title' };
  try {
    const s = await wikiSearch(title);                               // resolve the exact article title first (no 404s)
    if (!s.ok) return s;
    const t = s.results[0].title;
    const j = await (await fetch(`${WIKI}/api/rest_v1/page/summary/${encodeURIComponent(t.replace(/ /g, '_'))}`)).json();
    return { ok: true, title: j.title || t, description: j.description || '', extract: j.extract || s.results[0].snippet, url: j.content_urls?.desktop?.page || '' };
  } catch (e) { return { ok: false, error: `Wikipedia unreachable (${e.message})` }; }
}
const OWN_TOOLS = { get_weather: (a) => weather(a.city), world_clock: (a) => worldClock(a.city), wiki_search: (a) => wikiSearch(a.query), wiki_summary: (a) => wikiSummary(a.title) };

// ---------------------------------------------------------------- sound effects (Web Audio, synthesised)
let actx = null;
export function sfx(kind) {
  try {
    actx = actx || new (window.AudioContext || window.webkitAudioContext)();
    if (actx.state === 'suspended') actx.resume();
    const a = actx, t = a.currentTime, out = a.createGain();
    out.connect(a.destination);
    const tone = (f0, f1, dur, type = 'sine', vol = 0.15, at = 0) => {
      const o = a.createOscillator(), g = a.createGain();
      o.type = type; o.frequency.setValueAtTime(f0, t + at); o.frequency.exponentialRampToValueAtTime(f1, t + at + dur);
      g.gain.setValueAtTime(0.0001, t + at); g.gain.exponentialRampToValueAtTime(vol, t + at + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + at + dur);
      o.connect(g); g.connect(out); o.start(t + at); o.stop(t + at + dur + 0.05);
    };
    if (kind === 'repulsor') {
      const n = a.sampleRate * 0.6, buf = a.createBuffer(1, n, a.sampleRate), d = buf.getChannelData(0);
      for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n) ** 2;
      const src = a.createBufferSource(), lp = a.createBiquadFilter(), g = a.createGain();
      lp.type = 'lowpass'; lp.frequency.setValueAtTime(4000, t); lp.frequency.exponentialRampToValueAtTime(200, t + 0.55);
      g.gain.value = 0.35; src.buffer = buf; src.connect(lp); lp.connect(g); g.connect(out); src.start(t);
      tone(1400, 90, 0.5, 'sawtooth', 0.08); tone(220, 55, 0.6, 'sine', 0.25);
    } else if (kind === 'boot') {
      tone(440, 440, 0.25, 'sine', 0.08); tone(660, 660, 0.25, 'sine', 0.08, 0.12); tone(880, 1320, 0.5, 'triangle', 0.06, 0.26);
    } else if (kind === 'listen') {
      tone(900, 1300, 0.12, 'sine', 0.06);
    } else if (kind === 'agent') {
      tone(1200, 1500, 0.08, 'sine', 0.03);
    }
  } catch { /* no audio: fine */ }
}

// ---------------------------------------------------------------- helpers
const clean = (s) => String(s || '').replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/[*_#`]+/g, '').replace(/\s+/g, ' ').trim();
const pick = (xs) => xs[Math.floor(Math.random() * xs.length)];
const sentences = (s, n) => (String(s).match(/[^.!?]+[.!?]+/g) || [s]).slice(0, n).join(' ').trim();
const parseArgs = (c) => { try { const a = c.function?.arguments; return typeof a === 'string' ? JSON.parse(a || '{}') : a || {}; } catch { return {}; } };
const ADDRESS_KEY = 'aether.address';
const store = { get: (k) => { try { return localStorage.getItem(k) || ''; } catch { return ''; } }, set: (k, v) => { try { if (v) localStorage.setItem(k, v); else localStorage.removeItem(k); } catch { /* private mode */ } } };

/** Short human label for a tool step in a task card. */
export function stepLabel(name, a = {}) {
  const v = a.name ?? a.city ?? a.query ?? a.title ?? a.feature ?? a.device ?? a.direction ?? a.action ?? a.level ?? a.degrees ?? a.amount;
  const on = typeof a.on === 'boolean' ? (a.on ? ' on' : ' off') : '';
  return `${name.replace(/_/g, ' ')}${v !== undefined ? ` · ${v}${on}` : on}`;
}

// ---------------------------------------------------------------- the assistant
export class Aether {
  /**
   * hooks: context() -> display state, run(name, args) -> app tool result (may be async), command(text) -> local
   * keyword actions performed, speak(text, onend) -> bool, onLog(role, text), onState(), onTask(event)
   */
  constructor(hooks, modelNames, { address = '' } = {}) {
    this.h = hooks; this.tools = agentTools(modelNames);
    this.address = store.get(ADDRESS_KEY) || address;
    this.online = false; this.models = []; this.model = ''; this.lastError = '';
    this.history = []; this.busy = false; this.speaking = false; this.followUntil = 0; this.log = [];
    this.agents = Object.fromEntries(Object.keys(AGENTS).map((k) => [k, { state: 'idle', task: '', runs: 0 }]));
    this.tasks = []; this.seq = 0; this._idle = {};
  }

  async connect() {
    try {
      const s = await (await fetch('/api/aether/status')).json();
      this.online = !!s.online; this.models = s.models || [];
    } catch { this.online = false; }
    this.h.onState?.();
    return this.online;
  }

  following() { return performance.now() < this.followUntil; }
  /** "Done." -> "Done, sir." when the user asked to be called something. */
  a(s) { return this.address ? s.replace(/([.!?])$/, `, ${this.address}$1`) : s; }

  greet() {
    const h = new Date().getHours(), part = h < 5 ? 'evening' : h < 12 ? 'morning' : h < 18 ? 'afternoon' : 'evening';
    return `Good ${part}${this.address ? ', ' + this.address : ''}. AETHER online, with four specialist agents standing by${this.online ? '' : ' on local protocols'}.`;
  }

  say(text) {
    this.push('aether', text);
    this.speaking = true; this.h.onState?.();
    let finished = false;
    const done = () => { if (finished) return; finished = true; this.speaking = false; this.followUntil = performance.now() + FOLLOW_UP_MS; this.h.onState?.(); };
    if (!this.h.speak(text, done)) done();
    else setTimeout(done, 2500 + text.length * 90);                  // Chrome sometimes never fires onend
  }

  push(role, text) {
    this.log.push({ role, text });
    if (this.log.length > 40) this.log.shift();
    this.h.onLog?.(role, text);
  }

  // ------------------------------------------------------------ agent bookkeeping (drives the dots + task cards)
  setAgent(id, state, task) {
    const A = this.agents[id];
    clearTimeout(this._idle[id]);
    A.state = state; if (task !== undefined) A.task = task;
    if (state === 'done' || state === 'error') this._idle[id] = setTimeout(() => { A.state = 'idle'; this.h.onState?.(); }, IDLE_AFTER_MS);
    this.h.onState?.();
  }
  /** Active agents for the HUD orbit. */
  active() { return Object.entries(this.agents).filter(([, A]) => A.state !== 'idle').map(([id, A]) => ({ id, state: A.state, color: AGENTS[id].color })); }

  /** Run one agent task: a card, a dot, steps; never throws. */
  async task(agent, text, work) {
    const T = { id: ++this.seq, agent, text, steps: [], state: 'running', reply: '' };
    this.tasks.push(T); if (this.tasks.length > 30) this.tasks.shift();
    this.agents[agent].runs++;
    this.setAgent(agent, 'thinking', text);
    this.h.onTask?.({ type: 'start', task: T });
    sfx('agent');
    try {
      T.reply = clean(await work(T)) || this.a('Done.');
      T.state = 'done'; this.setAgent(agent, 'done');
    } catch (e) {
      T.state = 'error'; T.reply = `${AGENTS[agent].name} agent: ${e.message}`;
      this.setAgent(agent, 'error');
    }
    this.h.onTask?.({ type: 'end', task: T });
    return T;
  }
  /** Execute one tool for a task, recording it as a step. */
  async tool(T, name, args = {}) {
    this.setAgent(T.agent, 'working');
    const S = { label: stepLabel(name, args), ok: null };
    T.steps.push(S); this.h.onTask?.({ type: 'step', task: T, step: S });
    let result;
    try { result = OWN_TOOLS[name] ? await OWN_TOOLS[name](args) : await this.h.run(name, args); } catch (e) { result = { ok: false, error: e.message }; }
    S.ok = result?.ok !== false; this.h.onTask?.({ type: 'step', task: T, step: S });
    this.setAgent(T.agent, 'thinking');
    return result ?? { ok: true };
  }

  // ------------------------------------------------------------ one user turn
  /** A sentence for AETHER (wake word already removed). */
  async hear(text) {
    text = String(text || '').trim();
    if (!text) { this.say(this.a(pick(['Yes?', 'Listening.', 'At your service.']))); return ''; }
    this.push('user', text);
    this.busy = true; this.h.onState?.();
    let reply = '';
    try {
      const addr = this.addressing(text), direct = text.match(/^@(\w+)[\s,:]+(.+)$/);
      const agent = direct && SPECIALISTS.find((a) => a === direct[1].toLowerCase() || AGENTS[a].name.toLowerCase() === direct[1].toLowerCase());
      if (addr) reply = addr;
      else if (agent) reply = (await this.runAll([{ agent, task: direct[2] }]))[0].reply;   // "@world weather in Paris": skip the Core
      else if (this.online) {
        try { reply = await this.think(text); }
        catch (e) {
          this.lastError = e.message; console.warn('AETHER brain:', e.message);
          reply = `${await this.offline(text)} My language core is not responding, so I am on local protocols.`;
        }
      } else reply = await this.offline(text);
    } finally { this.busy = false; this.setAgent('core', 'idle'); }
    this.say(reply || this.a('Done.'));
    return reply;
  }

  /** "Call me Tony" / "stop calling me that": remembered on this device. */
  addressing(text) {
    if (/\b(stop calling me|don't call me|do not call me)\b/i.test(text)) { this.address = ''; store.set(ADDRESS_KEY, ''); return 'Understood. No more titles.'; }
    const m = text.match(/\b(?:call me|address me as)\s+([a-z][a-z .'-]{0,24}?)\s*[.!]?$/i);
    if (!m) return '';
    this.address = m[1].trim().replace(/\b\w/g, (c) => c.toUpperCase()); store.set(ADDRESS_KEY, this.address);
    return `Very well, ${this.address}.`;
  }

  /** Online turn. A clear single-agent request skips the Core's planning call; anything else is planned by the Core. */
  async think(text) {
    const routed = route(text);
    let reply;
    if (routed.length === 1) {
      this.setAgent('core', 'working', `routing to ${AGENTS[routed[0]].name}`);
      [reply] = (await this.runAll([{ agent: routed[0], task: text }])).map((T) => T.reply);
    } else reply = await this.plan(text);
    this.history.push({ role: 'user', content: text }, { role: 'assistant', content: reply });
    while (this.history.length > 16) this.history.shift();
    return reply;
  }

  async plan(text) {
    this.setAgent('core', 'thinking', 'planning');
    const msgs = [{ role: 'system', content: corePrompt(this.h.context(), this.address) }, ...this.history, { role: 'user', content: text }];
    const m = await this.llm(msgs, this.tools.core);
    const calls = (m.tool_calls || []).filter((c) => c.function?.name === 'delegate');
    if (!calls.length) return clean(m.content) || this.a('Done.');
    const jobs = calls.map((c) => ({ c, ...parseArgs(c) })).filter((j) => SPECIALISTS.includes(j.agent));
    if (!jobs.length) return clean(m.content) || this.a('Done.');
    this.setAgent('core', 'working', `delegating to ${jobs.map((j) => AGENTS[j.agent].name).join(', ')}`);
    const done = await this.runAll(jobs.map((j) => ({ agent: j.agent, task: j.task || text })));
    if (done.length === 1) return done[0].reply;                    // one specialist: its report is the answer
    this.setAgent('core', 'thinking', 'combining the reports');
    msgs.push({ role: 'assistant', content: m.content || '', tool_calls: jobs.map((j) => j.c) },
      ...jobs.map((j, i) => ({ role: 'tool', tool_call_id: j.c.id, content: JSON.stringify({ agent: j.agent, ok: done[i].state === 'done', report: done[i].reply }) })));
    try { return clean((await this.llm(msgs, [])).content) || done.map((T) => T.reply).join(' '); }
    catch { return done.map((T) => T.reply).join(' '); }
  }

  /** Specialists in parallel; each falls back to its local rules if the brain fails mid-task. */
  runAll(jobs) {
    return Promise.all(jobs.map((j) => this.task(j.agent, j.task, async (T) => {
      if (!this.online) return this.local(T, j.task);
      try { return await this.agentLoop(T, j.task); }
      catch (e) { this.lastError = e.message; return this.local(T, j.task); }
    })));
  }

  /** One specialist's LLM tool loop. */
  async agentLoop(T, task) {
    const msgs = [{ role: 'system', content: agentPrompt(T.agent, this.h.context(), this.address) }, { role: 'user', content: task }];
    for (let round = 0; round < 5; round++) {
      const m = await this.llm(msgs, this.tools[T.agent]);
      const calls = m.tool_calls || [];
      msgs.push(calls.length ? { role: 'assistant', content: m.content || '', tool_calls: calls } : { role: 'assistant', content: m.content || '' });
      if (!calls.length) return m.content;
      for (const c of calls) {
        const result = await this.tool(T, c.function?.name, parseArgs(c));
        msgs.push({ role: 'tool', tool_call_id: c.id, content: JSON.stringify(result) });
      }
    }
    return this.a('Done.');
  }

  async llm(messages, tools) {
    const r = await fetch('/api/aether', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages, tools }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.message) throw new Error(j.error || `HTTP ${r.status}`);
    this.model = j.model || ''; this.h.onState?.();
    return j.message;
  }

  // ------------------------------------------------------------ offline brain: the same agents on local rules
  async offline(text) {
    const routed = route(text);
    if (!routed.length) return this.coreLocal(text);
    this.setAgent('core', 'working', `routing to ${routed.map((a) => AGENTS[a].name).join(', ')}`);
    const done = await this.runAll(routed.map((agent) => ({ agent, task: text })));
    return done.map((T) => T.reply).join(' ');
  }

  coreLocal(text) {
    const t = text.toLowerCase();
    if (/\b(who are you|what are you|your name|introduce yourself)\b/.test(t)) return 'I am AETHER: Adaptive Engine for Thinking, Holograms, Experiments and Reasoning. I run this workshop with four agents: Hologram, Knowledge, World and Systems.';
    if (/\b(thank|thanks|cheers|good job|well done)\b/.test(t)) return this.a(pick(['Always a pleasure.', 'My pleasure.']));
    if (/^(hello|hi|hey|good (morning|afternoon|evening)|are you there|wake up)\b/.test(t)) return this.greet();
    const done = this.h.command(text);
    if (done.length) return `${this.a(pick(['Right away.', 'Of course.', 'Done.']))} ${done.join(', ')}.`;
    return this.online ? this.a("I'm afraid I didn't catch that.") : "That's beyond my local protocols. Add an OpenRouter key and my agents can do a great deal more.";
  }

  /** Local rules for one specialist (also the fallback when the brain fails mid-task). */
  async local(T, text) {
    const t = text.toLowerCase(), city = (re) => (t.match(re) || [])[1]?.replace(/\b(today|now|right now|please|tonight)\b/g, '').trim();
    if (T.agent === 'world') {
      if (/\b(weather|temperature|forecast|rain|raining|snow|snowing|sunny|humid|windy)\b/.test(t)) {
        const c = city(/\b(?:in|at|for)\s+([a-z][a-z .'-]*?)(?:\s+(?:and|today|now|right now|please)\b|[?.!,]|$)/);
        if (!c) return 'Which city?';
        const w = await this.tool(T, 'get_weather', { city: c });
        return w.ok ? `In ${w.place} it's ${Math.round(w.temperatureC)} degrees with ${w.conditions}, wind ${Math.round(w.windKmh)} kilometres an hour.` : `I couldn't get the weather: ${w.error}.`;
      }
      const c = city(/\btime\s+(?:is it\s+)?in\s+([a-z][a-z .'-]*?)(?:\s+(?:and|right now|now)\b|[?.!,]|$)/);
      if (c) { const k = await this.tool(T, 'world_clock', { city: c }); return k.ok ? `It's ${k.time} on ${k.date} in ${k.place}.` : `I couldn't find the time there: ${k.error}.`; }
      if (/\b(date|what day)\b/.test(t)) return `Today is ${new Date().toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}.`;
      return this.a(`It's ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.`);
    }
    if (T.agent === 'systems') {
      const on = !/\b(off|stop|disable|end|close)\b/.test(t);
      for (const [re, device] of [[/\b(camera|webcam)\b/, 'camera'], [/\b(record|recording)\b/, 'recording'], [/\b(microphone|mic)\b/, 'voice']]) {
        if (re.test(t)) { const r = await this.tool(T, 'set_device', { device, on }); return r.ok === false ? `The ${device} didn't respond: ${r.error || 'unknown error'}.` : `${device[0].toUpperCase() + device.slice(1)} ${on ? 'on' : 'off'}.`; }
      }
      const s = await this.tool(T, 'system_status', {});
      return `All systems nominal. ${s.particles.toLocaleString()} particles at ${s.fps} frames per second, camera ${s.camera}${s.battery ? `, battery at ${s.battery}` : ''}.`;
    }
    if (T.agent === 'knowledge') {
      const d = await this.tool(T, 'describe_model', {});
      const part = d.parts?.find((p) => t.includes(p.label.toLowerCase()) || p.label.toLowerCase().split(/[^a-z]+/).filter((w) => w.length > 4).some((w) => t.includes(w)));
      if (part) return `The ${part.label}: ${part.info}.`;
      if (/\b(this|it|the model|on screen)\b/.test(t) && !/\b(about|who|history)\b/.test(t)) return `This is the ${d.model}. ${d.fact || ''}`.trim();
      const subject = (t.match(/\b(?:tell me about|who (?:is|was|were)|what (?:is|are|was)(?: an?| the)?|explain(?: how)?|define|history of|learn about)\s+(.+?)[?.!]*$/) || [])[1]?.replace(/^(an?|the)\s+/, '').replace(/\s+works?$/, '');
      if (!subject) return this.a("I'll need a subject for that one.");
      const w = await this.tool(T, 'wiki_summary', { title: subject });
      return w.ok ? `${w.title}: ${sentences(w.extract, 2)}` : `I couldn't find that: ${w.error}.`;
    }
    // hologram
    if (/\b(fire|blast|shoot)\b/.test(t) || (/\brepulsors?\b/.test(t) && !/\b(gauntlet|glove|show|model|see)\b/.test(t))) {
      await this.tool(T, 'fire_repulsor', {});
      return 'Repulsors charged and firing.';
    }
    const done = this.h.command(text);
    for (const d of done) { T.steps.push({ label: d, ok: true }); this.h.onTask?.({ type: 'step', task: T, step: T.steps.at(-1) }); }
    return done.length ? `${this.a(pick(['Right away.', 'Of course.', 'Done.']))} ${done.join(', ')}.` : "The hologram didn't recognise that command.";
  }
}
