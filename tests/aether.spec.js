// AETHER: wake word + agent routing, the agents running in parallel (dots + task cards), direct @agent tasks,
// the Core -> specialist delegation loop against a mocked /api/aether, error fallback, tools and the repulsor.
// No network or API key needed (Wikipedia and OpenRouter are mocked).
import { test, expect } from '@playwright/test';
import { openApp, shot, status, play, watchErrors } from './helpers.js';

test.describe.configure({ mode: 'serial' });
const silence = (page) => page.evaluate(() => { window.__spoken = []; if (window.speechSynthesis) window.speechSynthesis.speak = (u) => { window.__spoken.push(u.text); u.onend?.(); }; });
const ask = (page, q) => page.evaluate((t) => window.aether.ask(t), q);

test('A1 wake word and the agent router', async ({ page }) => {
  const noErrors = watchErrors(page);
  await openApp(page);
  const r = await page.evaluate(async () => {
    const { stripWake } = await import('/src/aether.js');
    const { route } = await import('/src/agents.js');
    return {
      wake: ['Aether, show me the heart', 'hey ether open it', 'OK Aether', 'show me the heart', 'aetherial'].map((s) => stripWake(s).woke),
      rest: stripWake('Aether, show me the heart').rest,
      routes: ['show me the arc reactor', "what's the weather in London", 'turn on the camera', 'run a diagnostic', 'tell me about Nikola Tesla',
        'what does the palladium core do', 'show me the heart and tell me how it works', 'what time is it in Tokyo', 'hello there'].map(route),
    };
  });
  expect(r.wake).toEqual([true, true, true, false, false]);
  expect(r.rest).toBe('show me the heart');
  expect(r.routes).toEqual([['hologram'], ['world'], ['systems'], ['systems'], ['knowledge'], ['knowledge'], ['hologram', 'knowledge'], ['world'], []]);
  noErrors();
});

test('A2 offline: two agents run in parallel, each with a dot and a task card', async ({ page }) => {
  const noErrors = watchErrors(page);
  await openApp(page);
  await silence(page);
  expect(await page.evaluate(() => window.aether.voice('Aether, show me the arc reactor and what time is it'))).toEqual(['aether']);
  await page.waitForFunction(() => window.aether.status().aether.log.some((m) => m.role === 'aether'));
  const s = await status(page);
  expect(s.aether.tasks.map((T) => [T.agent, T.state])).toEqual([['hologram', 'done'], ['world', 'done']]);
  expect(s.aether.agents.hologram.runs).toBe(1);
  expect(s.aether.agents.world.runs).toBe(1);
  expect(s.aether.log.at(-1).text).toMatch(/Arc Reactor.*It's \d/);
  await expect(page.locator('.atask[data-agent="hologram"]')).toHaveCount(1);
  await expect(page.locator('.atask[data-agent="world"].done')).toHaveCount(1);
  await expect(page.locator('.agent[data-agent="hologram"]')).toHaveAttribute('data-state', /done|idle/);
  await play(page, 3.2, null);
  expect(await status(page).then((x) => [x.state, x.name])).toEqual(['formed', 'Arc Reactor']);
  await shot(page, 'A2-agents-parallel');
  noErrors();
});

test('A3 direct @agent tasks, knowledge from the model and from Wikipedia (mocked)', async ({ page }) => {
  const noErrors = watchErrors(page);
  await page.route('https://en.wikipedia.org/**', (route) => {
    const u = route.request().url();
    if (u.includes('/w/api.php')) return route.fulfill({ json: { query: { search: [{ title: 'Nikola Tesla', snippet: 'Serbian-American <b>inventor</b>' }] } } });
    return route.fulfill({ json: { title: 'Nikola Tesla', extract: 'Nikola Tesla was a Serbian-American inventor. He is best known for AC power. He died in 1943.', content_urls: { desktop: { page: 'https://en.wikipedia.org/wiki/Nikola_Tesla' } } } });
  });
  await openApp(page, 'n=100000');
  await silence(page);
  expect(await ask(page, '@systems run a diagnostic')).toMatch(/100,000 particles/);
  expect(await ask(page, 'tell me about Nikola Tesla')).toBe('Nikola Tesla: Nikola Tesla was a Serbian-American inventor. He is best known for AC power.');
  await page.evaluate(() => window.aether.tool('show_model', { name: 'Arc Reactor' }));
  await play(page, 3.2, null);
  expect(await ask(page, 'what does the palladium core do')).toMatch(/Palladium core: the power source/);
  const s = await status(page);
  expect(s.aether.tasks.map((T) => T.agent)).toEqual(['systems', 'knowledge', 'knowledge']);
  expect(s.aether.tasks[1].steps).toEqual(['describe model', 'wiki summary · nikola tesla']);   // checks the screen first
  noErrors();
});

test('A4 Core delegates to two specialists in parallel (mocked OpenRouter), then combines their reports', async ({ page }) => {
  const noErrors = watchErrors(page);
  const seen = [];
  await page.route('**/api/aether', async (route) => {
    const body = route.request().postDataJSON(), sys = body.messages[0].content, last = body.messages.at(-1);
    const who = sys.includes('You are the Core') ? 'core' : sys.includes('You are the Hologram agent') ? 'hologram' : sys.includes('You are the Knowledge agent') ? 'knowledge' : '?';
    seen.push({ who, tools: (body.tools || []).map((t) => t.function.name), last: last.role });
    const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
    let message;
    if (who === 'core') message = last.role === 'user'
      ? { role: 'assistant', content: '', tool_calls: [call('d1', 'delegate', { agent: 'hologram', task: 'show the Iron Man Helmet and explode it' }), call('d2', 'delegate', { agent: 'knowledge', task: 'what does the faceplate do' })] }
      : { role: 'assistant', content: 'The helmet is open, and the faceplate hinges up to let the pilot out.' };
    else if (who === 'hologram') message = last.role === 'user'
      ? { role: 'assistant', content: '', tool_calls: [call('h1', 'show_model', { name: 'Iron Man Helmet' }), call('h2', 'explode_view', { amount: 0.9 })] }
      : { role: 'assistant', content: 'Helmet formed and opened.' };
    else message = last.role === 'user'
      ? { role: 'assistant', content: '', tool_calls: [call('k1', 'describe_model', {})] }
      : { role: 'assistant', content: '<think>…</think>The **faceplate** hinges up.' };
    await route.fulfill({ json: { message, model: 'mock/aether:free' } });
  });
  await openApp(page, 'n=150000');
  await silence(page);
  await page.evaluate(() => { window.aether.app.aether.online = true; });
  await page.fill('#aInput', 'Aether, show me the helmet and explain what the faceplate does');
  await page.press('#aInput', 'Enter');
  await page.waitForFunction(() => window.aether.status().aether.log.some((m) => m.role === 'aether'));
  await play(page, 4.5, null);
  const s = await status(page);
  expect([s.state, s.name]).toEqual(['formed', 'Iron Man Helmet']);
  expect(s.explode).toBeGreaterThan(0.85);
  expect(s.aether.log.at(-1).text).toBe('The helmet is open, and the faceplate hinges up to let the pilot out.');
  expect(s.aether.tasks.map((T) => [T.agent, T.state, T.steps])).toEqual([
    ['hologram', 'done', ['show model · Iron Man Helmet', 'explode view · 0.9']], ['knowledge', 'done', ['describe model']]]);
  expect(s.aether.tasks[1].reply).toBe('The faceplate hinges up.');
  expect(seen.map((x) => x.who)).toEqual(expect.arrayContaining(['core', 'hologram', 'knowledge']));
  expect(seen.filter((x) => x.who === 'core')).toHaveLength(2);                                  // plan + combine
  expect(seen.find((x) => x.who === 'core').tools).toEqual(['delegate']);
  expect(seen.find((x) => x.who === 'hologram').tools).toContain('show_model');
  expect(seen.find((x) => x.who === 'knowledge').tools).toEqual(['describe_model', 'wiki_search', 'wiki_summary']);
  await expect(page.locator('.atask.done')).toHaveCount(2);
  await shot(page, 'A4-core-delegates');
  noErrors();
});

test('A5 a single-agent request skips the Core; brain errors fall back to local protocols', async ({ page }) => {
  const noErrors = watchErrors(page);
  const who = [];
  await page.route('**/api/aether', (route) => {
    who.push(route.request().postDataJSON().messages[0].content.includes('You are the Core') ? 'core' : 'agent');
    return route.fulfill({ json: { error: 'rate limited' } });
  });
  await openApp(page);
  await silence(page);
  await page.evaluate(() => { window.aether.app.aether.online = true; console.warn = () => {}; });
  const reply = await ask(page, 'run a diagnostic');
  expect(who).toEqual(['agent']);                                                            // routed straight to Systems
  expect(reply).toMatch(/All systems nominal/);
  const r2 = await ask(page, 'who are you');                                                  // Core fails -> local
  expect(r2).toContain('AETHER');
  expect(r2).toContain('local protocols');
  noErrors();
});

test('A6 "call me …" is remembered and used in replies', async ({ page }) => {
  const noErrors = watchErrors(page);
  await openApp(page);
  await silence(page);
  expect(await ask(page, 'call me boss')).toBe('Very well, Boss.');
  expect(await ask(page, 'thanks')).toMatch(/, Boss\.$/);
  expect((await status(page)).aether.address).toBe('Boss');
  expect(await ask(page, 'stop calling me that')).toMatch(/No more titles/);
  expect((await status(page)).aether.address).toBe('');
  noErrors();
});

test('A7 hologram tools: explode before it formed, parts, zoom, rotate, display features', async ({ page }) => {
  const noErrors = watchErrors(page);
  await openApp(page, 'n=150000');
  const tool = (n, a) => page.evaluate(([name, args]) => window.aether.tool(name, args), [n, a]);
  expect((await tool('show_model', { name: 'Arc Reactor' })).ok).toBe(true);
  expect((await tool('explode_view', { amount: 1 })).ok).toBe(true);
  expect((await tool('select_part', { name: 'palladium core' })).ok).toBe(true);   // queued until formed
  await play(page, 4.5, null);
  let s = await status(page);
  expect([s.state, s.name, s.selected]).toEqual(['formed', 'Arc Reactor', 'Palladium core']);
  expect(s.explode).toBeGreaterThan(0.95);
  expect((await tool('select_part', { name: 'copper coils' })).part).toBe('Copper coil windings');
  expect((await tool('select_part', { name: 'flux capacitor' })).ok).toBe(false);
  expect((await tool('describe_model', {})).parts.length).toBe(7);
  const yaw0 = s.yaw;
  await tool('zoom', { level: 1.6 });
  await tool('rotate_view', { degrees: 90 });
  await tool('set_display', { feature: 'cut_away', on: true });
  await play(page, 2, null);
  s = await status(page);
  expect(s.zoom).toBeGreaterThan(1.5);
  expect(s.yaw - yaw0).toBeGreaterThan(1.2);
  expect(s.cut.on).toBe(true);
  await tool('show_model', { name: 'Eiffel Tower' });
  await play(page, 3, null);
  expect((await tool('explode_view', { amount: 1 })).ok).toBe(false);                // landmarks don't come apart
  expect((await tool('system_status', {})).brain).toBe('local protocols');
  noErrors();
});

test('A8 repulsor: an open palm pushed at the camera fires once (cooldown), a steady hand never does', async ({ page }) => {
  const noErrors = watchErrors(page);
  await openApp(page);
  const r = await page.evaluate(async () => {
    const { RepulsorDetector } = await import('/src/logic/gestures.js');
    const { hand } = await import('/src/logic/synth.js');
    const d = new RepulsorDetector();
    let steady = 0, push = 0, fist = 0;
    for (let i = 0; i < 60; i++) if (d.update(hand({ pose: 'open', s: 0.09 }), 'open', i / 30)) steady++;
    for (let i = 0; i < 30; i++) if (d.update(hand({ pose: 'open', s: 0.08 + 0.004 * i }), 'open', 3 + i / 30)) push++;
    for (let i = 0; i < 30; i++) if (d.update(hand({ pose: 'fist', s: 0.08 + 0.004 * i }), 'fist', 5 + i / 30)) fist++;
    return { steady, push, fist };
  });
  expect(r).toEqual({ steady: 0, push: 1, fist: 0 });
  await page.evaluate(async () => {
    const W = window.aether, t0 = W.app.t;
    await W.advance(0.6, (t) => W.synth({ cx: 0.4, cy: 0.5, pose: 'open', s: 0.07 + 0.25 * Math.min(1, (t - t0) / 0.5) }));
  });
  expect(await page.evaluate(() => !!window.aether.app.blast)).toBe(true);
  await expect(page.locator('#toast')).toContainText('Repulsor');
  noErrors();
});

test('A9 Royal Enfield Classic 350 + 360 degree view: drag any direction, orbit, double-click reset', async ({ page }) => {
  const noErrors = watchErrors(page);
  await openApp(page, 'n=200000');
  expect((await page.evaluate(() => window.aether.tool('show_model', { name: 'Royal Enfield Classic 350' }))).ok).toBe(true);
  await play(page, 3.5, null);
  let s = await status(page);
  expect([s.state, s.name, s.category, s.labels]).toEqual(['formed', 'Royal Enfield Classic 350', 'Vehicles', 17]);
  await shot(page, 'A9a-enfield-classic-350');
  await page.mouse.move(1000, 300); await page.mouse.down(); await page.mouse.move(1150, 560, { steps: 8 }); await page.mouse.up();   // drag down-right
  await play(page, 0.2, null);
  s = await status(page);
  expect(s.viewPitch).toBeGreaterThan(1.9);                                                   // tilted over the top: no pitch limit
  await shot(page, 'A9b-enfield-from-above');
  await page.keyboard.press('y');
  await play(page, 3, null);
  const o = await status(page);
  expect(o.orbit).toBe(true);
  expect(Math.abs(o.yaw - s.yaw)).toBeGreaterThan(1.2);
  await page.keyboard.press('e');
  await play(page, 2.5, null);
  await shot(page, 'A9c-enfield-exploded-orbit');
  await page.mouse.dblclick(1000, 300);
  await play(page, 0.2, null);
  s = await status(page);
  expect([s.orbit, s.viewPitch]).toEqual([false, 0]);
  expect(await page.evaluate(() => window.aether.voice('show me the royal enfield'))).toEqual(['Royal Enfield Classic 350']);
  noErrors();
});
