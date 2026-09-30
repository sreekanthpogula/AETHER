// Static build for Vercel: copies the app into dist/ and the MediaPipe hand-tracking runtime into dist/vendor/mediapipe
// (locally, server.mjs serves the same path straight from node_modules). The API lives in api/ as Vercel functions.
import { cpSync, mkdirSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url)), DIST = join(ROOT, 'dist');
const MP = join(ROOT, 'node_modules', '@mediapipe', 'tasks-vision');
if (!existsSync(MP)) throw new Error('run npm install first: @mediapipe/tasks-vision is missing');

rmSync(DIST, { recursive: true, force: true });
mkdirSync(join(DIST, 'vendor', 'mediapipe'), { recursive: true });
for (const f of ['index.html', 'styles.css']) cpSync(join(ROOT, f), join(DIST, f));
for (const d of ['src', 'models']) cpSync(join(ROOT, d), join(DIST, d), { recursive: true });
cpSync(join(ROOT, 'docs', 'media', 'logo.svg'), join(DIST, 'logo.svg'));
cpSync(join(MP, 'vision_bundle.mjs'), join(DIST, 'vendor', 'mediapipe', 'vision_bundle.mjs'));
cpSync(join(MP, 'wasm'), join(DIST, 'vendor', 'mediapipe', 'wasm'), { recursive: true });
console.log('dist/:', readdirSync(DIST).join(', '), '· vendor/mediapipe/wasm:', readdirSync(join(DIST, 'vendor', 'mediapipe', 'wasm')).length, 'files');
