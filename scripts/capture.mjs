// Regenerates the README media in docs/media: screenshots of the real app and a frame-perfect demo video.
// The app runs on its deterministic clock (?manual=1), so every frame is rendered exactly once, at 30 fps.
//   node scripts/capture.mjs                 screenshots + video frames
//   FFMPEG=/path/to/ffmpeg node scripts/capture.mjs   also encodes demo.mp4 + demo.gif (ffmpeg on PATH works too)
// The AI agents are driven by a scripted brain (no API key, no network), so the output is reproducible.
import { chromium } from '@playwright/test';
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = join(ROOT, 'docs', 'media'), FRAMES = join(ROOT, '.tmp', 'frames');
const PORT = 5190, BASE = `http://localhost:${PORT}`;
const FFMPEG = process.env.FFMPEG || 'ffmpeg';
mkdirSync(OUT, { recursive: true });

const server = spawn(process.execPath, [join(ROOT, 'server.mjs'), String(PORT)], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 800));
const browser = await chromium.launch({ args: [...(process.platform === 'win32' ? ['--use-angle=d3d11'] : []), '--enable-gpu', '--ignore-gpu-blocklist'] });

/** Scripted brain for the agent shots: the Core delegates to two agents, each calls its tools, then reports. */
async function scriptedBrain(page) {
  await page.route('**/api/aether', async (route) => {
    const body = route.request().postDataJSON(), sys = body.messages[0].content, last = body.messages.at(-1);
    const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
    const first = last.role === 'user';
    let message;
    if (sys.includes('You are the Core')) message = first
      ? { role: 'assistant', content: '', tool_calls: [call('d1', 'delegate', { agent: 'hologram', task: 'show the Royal Enfield Classic 350 and explode it' }), call('d2', 'delegate', { agent: 'knowledge', task: 'what makes the J-series engine special' }), call('d3', 'delegate', { agent: 'world', task: 'weather in Chennai' })] }
      : { role: 'assistant', content: "Here's the Classic 350, opened up. Its 349 cc J-series single makes 20 horsepower, and it's 31 degrees and sunny in Chennai: good riding weather." };
    else if (sys.includes('You are the Hologram agent')) message = first
      ? { role: 'assistant', content: '', tool_calls: [call('h1', 'show_model', { name: 'Royal Enfield Classic 350' }), call('h2', 'explode_view', { amount: 1 })] }
      : { role: 'assistant', content: 'The Classic 350 is formed and fully exploded.' };
    else if (sys.includes('You are the Knowledge agent')) message = first
      ? { role: 'assistant', content: '', tool_calls: [call('k1', 'describe_model', {})] }
      : { role: 'assistant', content: 'The J-series is an air-oil cooled 349 cc single: 20.2 hp and 27 Nm, with a balancer shaft for smoothness.' };
    else message = first
      ? { role: 'assistant', content: '', tool_calls: [call('w1', 'get_weather', { city: 'Chennai' })] }
      : { role: 'assistant', content: "It's 31 degrees and sunny in Chennai." };
    await new Promise((r) => setTimeout(r, 350));
    await route.fulfill({ json: { message, model: 'qwen/qwen3.8-27b:free' } });
  });
  await page.route('https://geocoding-api.open-meteo.com/**', (r) => r.fulfill({ json: { results: [{ name: 'Chennai', country: 'India', latitude: 13.08, longitude: 80.27, timezone: 'Asia/Kolkata' }] } }));
  await page.route('https://api.open-meteo.com/**', (r) => r.fulfill({ json: { current: { temperature_2m: 31, apparent_temperature: 36, relative_humidity_2m: 62, weather_code: 0, wind_speed_10m: 14 } } }));
}

async function open(page, query = '') {
  await page.goto(`${BASE}/?manual=1&dpr=1&n=250000&${query}`);
  await page.waitForFunction(() => window.aether?.ready);
  await page.evaluate(() => window.aether.ready());
  await page.evaluate(() => window.aether.advance(1 / 60, null));
}
const adv = (page, s, hand = null) => page.evaluate(([t, h]) => window.aether.advance(t, h ? window.aether.synth(h) : null), [s, hand]);
const tool = (page, name, args = {}) => page.evaluate(([n, a]) => window.aether.tool(n, a), [name, args]);
const shot = async (page, name) => {
  await page.evaluate(() => document.getElementById('toast')?.classList.remove('show'));
  await page.waitForTimeout(700);                                                  // CSS fades run in real time, the app clock doesn't
  await page.screenshot({ path: join(OUT, `${name}.png`) }); console.log('  shot', name);
};
/** Form a model and hold a flattering 3/4 camera angle (auto-rotate off). */
const form = async (page, name, explode = 0, yaw = 0.6) => {
  await tool(page, 'show_model', { name }); if (explode) await tool(page, 'explode_view', { amount: explode });
  await page.evaluate((y) => { const a = window.aether.app; a.autoRotate = false; a.spin = y; a.$('bRotate').classList.remove('on'); }, yaw);
  await adv(page, 4.2);
};

// ---------------------------------------------------------------- screenshots (1600 x 900)
{
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } }), page = await ctx.newPage();
  await page.goto(`${BASE}/?dpr=1`); await page.waitForTimeout(1500); await shot(page, 'start');

  await open(page);
  await form(page, 'Royal Enfield Classic 350', 0, 0.55);
  await page.evaluate(() => { window.aether.app.labelsOn = true; });
  await shot(page, 'hero-enfield');
  await tool(page, 'explode_view', { amount: 1 }); await adv(page, 3); await shot(page, 'enfield-exploded');
  await tool(page, 'explode_view', { amount: 0 }); await adv(page, 2); await tool(page, 'rotate_view', { pitch: 62, degrees: 35 }); await adv(page, 1.6); await shot(page, 'view-360');

  await open(page);
  await form(page, 'Arc Reactor', 1); await tool(page, 'select_part', { name: 'Palladium core' }); await adv(page, 1.5); await shot(page, 'arc-reactor');
  await open(page);
  await form(page, 'Iron Man Helmet', 1); await adv(page, 1); await shot(page, 'helmet');
  await open(page);
  await form(page, 'Human Heart', 1); await adv(page, 1); await shot(page, 'heart');
  await open(page);
  await form(page, 'Supercharged HEMI V8', 1); await adv(page, 1); await shot(page, 'v8');

  await open(page);
  await scriptedBrain(page);
  await form(page, 'Royal Enfield Classic 350', 0, 0.55);                        // on screen already: the agents open it up
  await page.evaluate(() => { window.aether.app.aether.online = true; window.aether.app.aether.models = ['qwen/qwen3.8-27b:free']; window.speechSynthesis.speak = () => {}; });
  await page.fill('#aInput', 'Aether, show me the Royal Enfield, explain its engine and check the weather in Chennai');
  await page.press('#aInput', 'Enter');
  let live = false;
  for (let i = 0; i < 150; i++) {                                                 // agents work in real time; frames keep advancing
    await adv(page, 1 / 30); await page.waitForTimeout(30);
    const s = await page.evaluate(() => window.aether.status().aether);
    if (!live && s.tasks.length >= 3 && s.tasks.some((T) => T.state === 'running') && s.tasks.some((T) => T.steps.length)) { await shot(page, 'agents-live'); live = true; }
    if (s.log.some((m) => m.role === 'aether')) break;
  }
  await page.evaluate(() => { const a = window.aether.app; a.autoRotate = false; });
  await adv(page, 3.5);
  await page.evaluate(() => document.querySelectorAll('.atask').forEach((t) => t.classList.add('open')));
  await shot(page, 'agents');
  await ctx.close();
}

// ---------------------------------------------------------------- demo video (1280 x 720 @ 30 fps)
{
  rmSync(FRAMES, { recursive: true, force: true }); mkdirSync(FRAMES, { recursive: true });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } }), page = await ctx.newPage();
  await open(page, 'n=200000');
  let f = 0;
  const rec = async (seconds, hand = null, each) => {
    for (let i = 0, n = Math.round(seconds * 30); i < n; i++) {
      if (each) await each(i / n);
      await adv(page, 1 / 30, typeof hand === 'function' ? hand(i / n) : hand);
      await page.screenshot({ path: join(FRAMES, `f${String(f++).padStart(4, '0')}.png`) });
    }
  };
  const H = { cx: 0.42, cy: 0.56, s: 0.1 };                                           // in view, between the panel and the model
  await page.evaluate(() => { const A = window.aether, st = A.app.ctl.state; st.index = A.CATALOG.findIndex((d) => d.name === 'Arc Reactor'); st.targetDirty = true; });
  await rec(0.6, null);
  await rec(0.14, { ...H, pose: 'snap_pressed' }); await rec(0.3, { ...H, pose: 'snap_released' });   // snap: particles burst
  await rec(1.4, { ...H, pose: 'open' });
  await rec(3.0, { ...H, pose: 'fist' });                                                            // fist: the arc reactor forms
  await rec(2.4, (u) => ({ ...H, pose: 'partial', f: u }));                                          // open the hand: it explodes
  await rec(1.8, (u) => ({ ...H, pose: 'open', angle: 0.5 * Math.sin(u * Math.PI * 2) }));           // twist: it turns
  await rec(1.2, (u) => ({ ...H, pose: 'partial', f: 1 - u }));
  await tool(page, 'show_model', { name: 'Royal Enfield Classic 350' });
  await rec(3.6, null);
  await tool(page, 'explode_view', { amount: 1 }); await page.evaluate(() => window.aether.app.toggleOrbit());
  await rec(5.5, null);                                                                               // 360 orbit, exploded
  await page.evaluate(() => { const a = window.aether.app; a.resetView(); a.toast = () => {}; }); await tool(page, 'explode_view', { amount: 0 });
  await tool(page, 'show_model', { name: 'Iron Man Helmet' });
  await rec(3.4, null);
  await tool(page, 'explode_view', { amount: 1 });
  await rec(2.6, null);
  await ctx.close();
  console.log(`  ${f} frames`);
}
await browser.close();
server.kill();

// ---------------------------------------------------------------- encode
try {
  execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-framerate', '30', '-i', join(FRAMES, 'f%04d.png'),
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '27', '-preset', 'slow', '-movflags', '+faststart', join(OUT, 'demo.mp4')]);
  execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-framerate', '30', '-i', join(FRAMES, 'f%04d.png'),
    '-ss', '0.5', '-t', '19.5', '-vf', 'fps=10,scale=600:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle', join(OUT, 'demo.gif')]);
  for (const n of ['demo.mp4', 'demo.gif']) console.log(`  ${n}: ${(statSync(join(OUT, n)).size / 1e6).toFixed(1)} MB`);
  rmSync(FRAMES, { recursive: true, force: true });
} catch (e) {
  console.log(existsSync(FRAMES) ? `  frames kept in ${FRAMES} (ffmpeg not found: set FFMPEG to encode)` : e.message);
}
