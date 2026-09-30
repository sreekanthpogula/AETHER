// AETHER's agents. The Core understands the request and hands work to specialists, each with its own tools and
// prompt; independent tasks run in parallel. A keyword router sends clear single-agent requests straight to the
// right specialist (one LLM call fewer), and picks the agents for the offline brain.

export const AGENTS = {
  core: { name: 'Core', color: '#e8f6ff', role: 'understands you, plans the work and hands it to the specialists' },
  hologram: { name: 'Hologram', color: '#4fd8ff', role: 'drives the display: models, exploded views, parts, zoom, rotation and effects' },
  knowledge: { name: 'Knowledge', color: '#b48cff', role: 'explains how things work: the parts on screen, science, history and people, with Wikipedia' },
  world: { name: 'World', color: '#5dffa0', role: 'live facts about the world: the weather and the local time anywhere' },
  systems: { name: 'Systems', color: '#ffa53a', role: 'the machine itself: diagnostics, camera, microphone and recording' },
};
export const SPECIALISTS = ['hologram', 'knowledge', 'world', 'systems'];

// ---------------------------------------------------------------- tools
const fn = (name, description, properties = {}, required = []) => ({ type: 'function', function: { name, description, parameters: { type: 'object', properties, required } } });
export const DISPLAY = ['auto_rotate', 'labels', 'cut_away', 'quiz', 'demo', 'hand_rotation', 'orbit_360'];
export const DEVICES = ['camera', 'recording', 'voice'];

export function agentTools(modelNames) {
  return {
    core: [fn('delegate', 'Hand a task to a specialist agent. Call once per specialist; several calls in one turn run in parallel.', {
      agent: { type: 'string', enum: SPECIALISTS, description: SPECIALISTS.map((a) => `${a}: ${AGENTS[a].role}`).join('; ') },
      task: { type: 'string', description: 'a complete, self-contained instruction for that agent' },
    }, ['agent', 'task'])],
    hologram: [
      fn('show_model', 'Form a model on the hologram (it assembles from the particle cloud).', { name: { type: 'string', enum: modelNames } }, ['name']),
      fn('change_model', 'Go to the next or previous model.', { direction: { type: 'string', enum: ['next', 'previous'] } }, ['direction']),
      fn('explode_view', 'Pull the current model apart to reveal its parts. 1 = fully exploded, 0 = assembled.', { amount: { type: 'number', minimum: 0, maximum: 1 } }, ['amount']),
      fn('select_part', 'Highlight one part of the current model and open its info card.', { name: { type: 'string', description: 'a part name from the display context' } }, ['name']),
      fn('hologram', 'Summon the particle sphere, or dissolve the hologram.', { action: { type: 'string', enum: ['summon', 'dissolve'] } }, ['action']),
      fn('zoom', 'Set the zoom level.', { level: { type: 'number', description: '0.5 (far) to 2.6 (close); 1 is normal' } }, ['level']),
      fn('rotate_view', 'Turn the model: 360 degree view, any side, top or bottom.', { degrees: { type: 'number', description: 'turn left/right; positive = to the left' }, pitch: { type: 'number', description: 'tilt forward/back; positive = look from above' } }),
      fn('set_display', 'Turn a display feature on or off.', { feature: { type: 'string', enum: DISPLAY }, on: { type: 'boolean' } }, ['feature', 'on']),
      fn('fire_repulsor', 'Fire a repulsor blast on the display.'),
    ],
    knowledge: [
      fn('describe_model', 'The model on the hologram: its name, key fact and every labelled part with what it does.'),
      fn('wiki_search', 'Search Wikipedia; returns the top article titles with snippets.', { query: { type: 'string' } }, ['query']),
      fn('wiki_summary', 'The summary of one Wikipedia article.', { title: { type: 'string' } }, ['title']),
    ],
    world: [
      fn('get_weather', 'Current weather for a city.', { city: { type: 'string' } }, ['city']),
      fn('world_clock', 'The local time and date in a city.', { city: { type: 'string' } }, ['city']),
    ],
    systems: [
      fn('system_status', 'Diagnostics: time, battery, network, frame rate, particle count, camera, CPU cores, AI brain.'),
      fn('set_device', 'Turn the camera, video recording or voice input on or off.', { device: { type: 'string', enum: DEVICES }, on: { type: 'boolean' } }, ['device', 'on']),
    ],
  };
}

// ---------------------------------------------------------------- prompts
const persona = (address) => [
  'You are part of AETHER (Adaptive Engine for Thinking, Holograms, Experiments & Reasoning), the AI of a holographic workshop',
  'in which up to 250,000 light particles form 3D models that the user controls with hand gestures and voice.',
  `Personality: calm, precise and warm, with dry British wit.${address ? ` Address the user as "${address}".` : ''}`,
  'Everything you write is spoken aloud: plain text only, no markdown, lists or emoji.',
].join('\n');
const facts = (ctx) => `Local time: ${new Date().toLocaleString()}.\nCurrent display: ${JSON.stringify(ctx)}`;

export function corePrompt(ctx, address) {
  return [persona(address),
    'You are the Core. Your specialist agents:', ...SPECIALISTS.map((a) => `- ${a}: ${AGENTS[a].role}`),
    'For anything a specialist can do, call delegate: one call per specialist, several in the same turn when the request has several',
    'parts (they run in parallel). Give each a complete task, e.g. "show the Arc Reactor and explode it fully".',
    'Answer small talk and simple questions yourself without delegating. After the specialists report back, reply to the user in',
    'one to three short sentences that combine their results.', facts(ctx)].join('\n');
}

const HINTS = {
  hologram: 'Model names must be exactly one of the show_model options. Call several tools at once when you can (for example show_model and explode_view).',
  knowledge: 'For the model on screen, call describe_model first. For other facts you are not certain of, use wiki_search then wiki_summary. Keep answers to two or three sentences.',
  world: 'Report temperatures in Celsius and round the numbers.',
  systems: 'Summarise diagnostics in one sentence; mention only what matters.',
};
export function agentPrompt(id, ctx, address) {
  return [persona(address),
    `You are the ${AGENTS[id].name} agent: you ${AGENTS[id].role}. The Core has given you one task.`,
    'Complete it with your tools, then report the outcome in one or two short sentences; your report is read to the user.',
    'Never claim a tool succeeded if its result says otherwise.', HINTS[id], facts(ctx)].join('\n');
}

// ---------------------------------------------------------------- router
const KW = {
  world: /\b(weather|temperature|forecast|raining|rain|snowing|snow|sunny|humid(ity)?|windy|what time|time is it|time in|the time|what('s| is) the date|what day|today's date|time ?zone|clock)\b/,
  systems: /\b(status|diagnostics?|systems? check|battery|cpu|memory|fps|frame ?rate|performance|network|camera|webcam|record|recording|microphone|mic)\b/,
  device: /\b(camera|webcam|record|recording|microphone|mic)\b/,
  knowledgeStrong: /\b(tell me about|explain|history of|who is|who was|who were|who invented|define|definition of|how (does|do|did) .*\b(work|works|made|built)|how it works|why (is|are|does|do))\b/,
  knowledgeWeak: /\b(what is|what's|what are|what does|what do|what was|meaning of|learn about)\b/,
  hologram: /\b(show|display|bring up|pull up|open|explode|apart|assemble|close|together|next|previous|go back|zoom|rotate|turn|spin|summon|dissolve|cut|slice|quiz|labels?|repulsors?|fire|blast|highlight|select|form|build)\b/,
};

/** Specialists that should handle `text`, most relevant first; [] = the Core handles it. */
export function route(text) {
  const t = ` ${String(text).toLowerCase()} `, out = [];
  const hit = (k) => KW[k].test(t);
  const device = hit('device');
  if (hit('hologram') && !(device && !/\b(show|display|explode|zoom|model)\b/.test(t))) out.push('hologram');
  if (hit('knowledgeStrong')) out.push('knowledge');
  if (hit('world')) out.push('world');
  if (hit('systems') && (device || !out.includes('world'))) out.push('systems');
  if (!out.length && hit('knowledgeWeak')) out.push('knowledge');
  return out;
}
