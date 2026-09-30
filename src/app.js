// AETHER (browser): snap -> particle burst, fist -> form a model, open hand -> next wonder or EXPLODED VIEW
// (hand openness = how far apart the parts fly), twist = rotate, ✌ = next, ☝ point = pick a part, pinch = pull it
// out, two hands = zoom, snap = dissolve. Plus quiz, voice, cut-away, recording, beating heart / breathing lungs.
// MediaPipe (hands) + WebGL2 (GPU particles via transform feedback) + procedural models.
import { CATALOG, isMachine, buildModel } from './models/catalog.js';
import { Controller } from './logic/controller.js';
import { OPEN, FIST, PEACE, POINT, NONE, RepulsorDetector } from './logic/gestures.js';
import { IDLE, SPHERE, FORMED, DISSOLVE, SIM } from './logic/state.js';
import { Renderer, perspective, mul4, translate4, rotY4, rot4, project } from './gl/renderer.js';
import { HandCamera } from './hands.js';
import { hand as synthHand } from './logic/synth.js';
import { rotX, rotY, matMul, matVec, deg } from './lib/vec.js';
import { parseCommand, Voice, speak, Recorder } from './features.js';
import { Aether, stripWake, sfx } from './aether.js';
import { AGENTS } from './agents.js';

const qs = new URLSearchParams(location.search);
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const wrapPi = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const HAND_YAW_GAIN = 2.2;     // twisting the hand by 45 deg turns the model ~100 deg
const HAND_PITCH_GAIN = 2.5;   // raising / lowering the hand by 10 % of the frame tilts the model ~14 deg
const DWELL_S = 0.45;          // point at a part this long to select it
const QUIZ_LEN = 5;

const CFG = {
  n: clamp(parseInt(qs.get('n'), 10) || 200000, 5000, 1000000),
  manual: qs.get('manual') === '1',             // tests: deterministic clock, frames only via aether.advance()
  autostart: qs.get('autostart'),                // 'camera' | 'nocamera'
  start: clamp(parseInt(qs.get('model'), 10) || 0, 0, CATALOG.length - 1),
  dpr: qs.get('dpr') ? parseFloat(qs.get('dpr')) : Math.min(window.devicePixelRatio || 1, 2),
  trails: qs.get('trails') !== '0',
  address: qs.get('address') || '',
  holo: qs.get('holo') === '0' ? 0 : 1,          // realistic hologram look (shimmer, scan band, depth fade); ?holo=0 = plain glow              // what AETHER calls you, e.g. ?address=sir (or say "call me …")
};

const HAND_EDGES = [[0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16], [13, 17], [17, 18], [18, 19], [19, 20], [0, 17]];
const POSE_UI = { [OPEN]: ['✋', 'Open hand'], [FIST]: ['✊', 'Fist'], [PEACE]: ['✌', 'Peace'], [POINT]: ['☝', 'Pointing'], other: ['🤚', 'Moving'], [NONE]: ['·', 'No hand'] };
const POSE_COLOR = { [OPEN]: '#66e0ff', [FIST]: '#ffd166', [PEACE]: '#ff6bd6', [POINT]: '#7dff9b', other: '#e8f1ff', [NONE]: '#e8f1ff' };
const rgbCss = (c, a = 1) => `rgba(${Math.round(c[0] * 255)}, ${Math.round(c[1] * 255)}, ${Math.round(c[2] * 255)}, ${a})`;
const CATEGORIES = [...new Set(CATALOG.map((d) => d.category))];

// ---------------------------------------------------------------- model cache (built in a worker)
class ModelStore {
  constructor(n) {
    this.n = n; this.cache = new Map(); this.pending = new Map(); this.lru = []; this.nextId = 1; this.errors = [];
    try {
      this.worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
      this.worker.onmessage = (e) => this.onResult(e.data);
      this.worker.onerror = (e) => { console.warn('model worker failed, building on the main thread', e); this.worker = null; this.flushSync(); };
    } catch (e) { this.worker = null; }
  }
  get(i) { const m = this.cache.get(i); if (m) this.touch(i); return m || null; }
  touch(i) { this.lru = [i, ...this.lru.filter((k) => k !== i)]; while (this.lru.length > 6) this.cache.delete(this.lru.pop()); }
  request(i) {
    if (this.cache.has(i)) return Promise.resolve(this.cache.get(i));
    if (this.pending.has(i)) return this.pending.get(i).promise;
    let resolve, reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    const job = { id: this.nextId++, promise, resolve, reject };
    this.pending.set(i, job);
    if (this.worker) this.worker.postMessage({ id: job.id, index: i, n: this.n });
    else setTimeout(() => this.buildSync(i), 0);
    return promise;
  }
  buildSync(i) {
    if (!this.pending.has(i)) return;
    try { const m = buildModel(i, this.n); this.onResult({ ...m, index: i }); } catch (e) { this.onResult({ index: i, error: String(e.stack || e) }); }
  }
  flushSync() { for (const i of [...this.pending.keys()]) this.buildSync(i); }
  onResult(d) {
    const job = this.pending.get(d.index);
    this.pending.delete(d.index);
    if (d.error) { this.errors.push(d.error); console.error('model build failed', CATALOG[d.index]?.name, d.error); job?.reject(new Error(d.error)); return; }
    const m = { ...d, def: CATALOG[d.index] };
    this.cache.set(d.index, m); this.touch(d.index);
    job?.resolve(m);
  }
}

// ---------------------------------------------------------------- scripted demo (synthetic hand, no camera needed)
class Demo {
  constructor(app) {
    this.app = app; this.t0 = null; this.segs = []; this.cur = -1;
    const at = { cx: 0.2, cy: 0.55, s: 0.09 };
    const H = (pose) => () => synthHand({ ...at, pose });
    const add = (dur, hand, onStart) => this.segs.push({ dur, hand, onStart });
    const snap = () => { add(0.13, H('snap_pressed')); add(0.3, H('snap_released')); };
    const pick = (i) => () => { app.ctl.state.index = i; app.ctl.state.targetDirty = true; app.store.request(i); };
    if (app.ctl.state.state !== IDLE) { snap(); add(1.5, () => null); }
    for (const name of ['Eiffel Tower', 'Human Brain', 'Human Heart', 'Sports Car']) {
      const i = CATALOG.findIndex((d) => d.name === name);
      add(0.4, () => null, pick(i)); snap(); add(1.4, H('open')); add(3.0, H('fist'));
      if (isMachine(i)) {
        add(2.6, (u) => synthHand({ ...at, pose: 'partial', f: u }));
        add(1.4, H('open'));
        add(3.2, (u) => synthHand({ ...at, pose: 'open', angle: 0.55 * Math.sin(u * Math.PI * 2) }));   // twist to turn it
        add(2.2, (u) => synthHand({ ...at, pose: 'partial', f: 1 - u }));
        add(1.2, H('fist'));
      } else add(1.5, H('fist'));
      snap(); add(1.6, () => null);
    }
  }
  tick(t) {
    if (this.t0 === null) this.t0 = t;
    let el = t - this.t0, i = 0;
    while (i < this.segs.length && el > this.segs[i].dur) { el -= this.segs[i].dur; i++; }
    if (i >= this.segs.length) { this.app.stopDemo(); return; }
    const s = this.segs[i];
    if (i !== this.cur) { this.cur = i; s.onStart?.(); }
    this.app.demoHand = s.hand(clamp(el / s.dur, 0, 1));
  }
}

// ---------------------------------------------------------------- app
class App {
  constructor() {
    const $ = (id) => document.getElementById(id);
    this.$ = $;
    this.canvas = $('gl'); this.overlay = $('overlay'); this.octx = this.overlay.getContext('2d');
    this.video = $('cam');
    this.renderer = new Renderer(this.canvas, CFG.n, { preserve: CFG.manual });
    this.ctl = new Controller(CATALOG.length, isMachine);
    this.ctl.state.index = CFG.start;
    this.store = new ModelStore(CFG.n);
    this.model = null; this.uploaded = -1; this.uploadT = 0;
    this.cam = null; this.camOn = false; this.hasVideo = false;
    this.color = [...CATALOG[CFG.start].color];
    this.explode = 0; this.manualExplode = 0; this.tintMix = 0; this.scale = 1;
    this.spin = 0; this.pitch = 0; this.grab = null; this.handRotate = true; this.handRotating = false;
    this.dragYaw = 0; this.dragPitch = 0; this.turnPitch = 0; this.orbit = false; this.viewT = -1e9; this.autoRotate = true; this.labelsOn = true; this.trails = CFG.trails;
    this.zoom = 1; this.zoomTarget = 1; this.zoomGrab = null;
    this.pulse = 1; this.flow = 0; this.expHist = []; this.wasBusy = false;
    this.sel = -1; this.pulled = false; this.pullAmt = 0; this.hover = { li: -1, t0: 0 }; this.anchors = []; this.pointer = null; this.lostT = 0;
    this.quiz = null;
    this.cut = { on: false, x: 0.35, target: 0.35 };
    this.voice = new Voice((text) => this.heard(text)); this.voiceOn = false; this.spoken = []; this.lastHeard = '';
    this.repulsor = new RepulsorDetector(); this.blast = null; this.turn = 0; this.pendingExplode = null; this.pendingPart = null;
    this.battery = null; this.clockKey = '';
    navigator.getBattery?.().then((b) => { this.battery = b; }).catch(() => {});
    this.aether = new Aether({
      context: () => this.aetherContext(),
      run: (name, args) => this.aetherTool(name, args),
      command: (text) => this.localCommand(text, true),
      speak: (text, onend) => { this.spoken.push(text); return speak(text, { onend }); },
      onLog: (role, text) => this.aetherLog(role, text),
      onState: () => this.aetherState(),
      onTask: (e) => this.aetherTask(e),
    }, CATALOG.map((d) => d.name), { address: CFG.address });
    this.taskEls = new Map();
    this.recorder = new Recorder(this.canvas, this.overlay); this.lastRecording = null;
    this.t = 0; this.last = null; this.frames = 0; this.fps = 0; this._fpsN = 0; this._fpsT = 0;
    this.handSource = null; this.handSource2 = null; this.lastSynthT = -1; this.demo = null; this.demoHand = undefined;
    this.autoFormAt = null; this.hudTick = 0; this.lastIndexShown = -1; this.sliderActive = false;
    this.activeCat = CATALOG[CFG.start].category;
    this.gain = clamp(0.22 * Math.sqrt(250000 / CFG.n), 0.15, 0.6);
    this.resize();
    addEventListener('resize', () => this.resize());
    this.buildUI();
    this.bindInput();
    this.store.request(CFG.start).then(() => this.prefetch());
    this.aetherState();
    if (!CFG.manual) this.aether.connect();
  }

  prefetch() { this.store.request((this.ctl.state.index + 1) % CATALOG.length); }

  resize() {
    const w = innerWidth, h = innerHeight, dpr = CFG.dpr;
    for (const c of [this.canvas, this.overlay]) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
    const aspect = w / h, wide = aspect > 1.25 && w > 820;
    this.offX = wide ? 0.9 * Math.min(1.15, aspect / 1.78) : 0;       // the model sits in the right third (like the demo)
    this.offY = wide ? 0 : 0.22;
    this.dist = Math.max(3.4, 1.25 / (Math.tan((20 * Math.PI) / 180) * aspect));
    this.proj = perspective(40, aspect, 0.05, 30);
    this.projView = mul4(this.proj, translate4(this.offX, this.offY, -this.dist));
  }

  // ------------------------------------------------------------ frame
  frame(t) {
    const dt = this.last === null ? 1 / 60 : clamp(t - this.last, 0, 1 / 30);   // clamp dt: spring physics stays stable on hitches
    this.last = t; this.t = t;
    const ctl = this.ctl, st = ctl.state;

    // 1. hand input — real camera (up to 2 hands), else synthetic streams (tests / demo) at camera rate (30 Hz)
    ctl.aspect = this.cam?.running && this.video.videoWidth ? this.video.videoWidth / this.video.videoHeight : 1;
    if (this.cam?.running) {
      const hands = this.cam.poll();
      if (hands !== undefined) ctl.onHands(hands, t);
      if (this.cam.newFrame) { this.renderer.uploadVideo(this.video); this.cam.newFrame = false; this.hasVideo = true; }
    }
    if (this.demo) this.demo.tick(t);
    const src = this.demo ? () => this.demoHand ?? null : this.handSource;
    if (src && t - this.lastSynthT >= 1 / 30 - 1e-6) {
      this.lastSynthT = t;
      ctl.onHands([src(t), this.handSource2?.(t)].filter(Boolean), t);
    }
    if (this.autoFormAt !== null && t >= this.autoFormAt) { this.autoFormAt = null; if (st.state === SPHERE) ctl.keyPose(FIST, t); }
    ctl.tick(t);
    if (ctl.lastHandT === t && this.repulsor.update(ctl.landmarks, ctl.rawPose, t)) this.fireRepulsor();   // palm pushed at the camera

    // 2. make sure the current model is on the GPU (built in the worker)
    if (st.targetDirty) {
      const m = this.store.get(st.index);
      if (m) {
        this.renderer.setModel(m); this.model = m; this.uploaded = st.index; this.uploadT = t; st.targetDirty = false;
        this.manualExplode = this.quiz ? 1 : this.pendingExplode ?? 0; this.pendingExplode = null; this.sel = -1; this.pulled = false; this.zoomTarget = 1; this.prefetch();
      } else this.store.request(st.index);
    }
    const ready = this.uploaded === st.index && !st.targetDirty;
    const machine = ready && isMachine(st.index);
    const formed = st.state === FORMED && ready;
    let mode = st.simMode(), formT = st.formT(t);
    if (st.state === FORMED && !ready) mode = SIM.sphere;                 // hold the swirl until the model is uploaded
    if (formed) formT = t - Math.max(st.tState, this.uploadT);
    const vis = ctl.handVisible(t);
    const pointing = vis && (ctl.pose === POINT || ctl.rawPose === POINT);
    const busyHand = pointing || ctl.pinch;                               // pointing / pinching must not move or explode the model
    const twoHands = vis && ctl.secondVisible(t) && formed;

    // 3. exploded view: hand openness when a hand is visible, else slider / keys / wheel / voice / quiz
    let target = 0;
    if (formed && machine) {
      // only a hand in THIS frame steers it (a hand that just left keeps its last openness for a while)
      if (vis && ctl.landmarks && !busyHand && !twoHands) { target = smooth(0.12, 0.85, ctl.openness); this.manualExplode = target; }
      else target = this.manualExplode;
      // curling the fingers into a point / pinch briefly reads as "closing": restore the openest recent value
      this.expHist.push([t, target]);
      while (this.expHist[0][0] < t - 0.5) this.expHist.shift();
      if (busyHand && !this.wasBusy) { this.manualExplode = Math.max(...this.expHist.map((h) => h[1])); target = this.manualExplode; }
    } else this.expHist = [];
    this.wasBusy = busyHand;
    this.explode += (target - this.explode) * (1 - Math.exp(-dt * 7));
    if (Math.abs(this.explode - target) < 1e-4) this.explode = target;

    // 4. zoom: two hands apart = bigger, together = smaller (relative to where they started)
    if (twoHands) {
      const a = ctl.landmarks[9], b = ctl.second[9], spread = Math.hypot((a[0] - b[0]) * ctl.aspect, a[1] - b[1]);
      if (!this.zoomGrab) this.zoomGrab = { spread: Math.max(spread, 0.02), zoom: this.zoomTarget };
      this.zoomTarget = clamp((this.zoomGrab.zoom * spread) / this.zoomGrab.spread, 0.5, 2.6);
    } else this.zoomGrab = null;
    this.zoom += (this.zoomTarget - this.zoom) * (1 - Math.exp(-dt * 8));

    // 5. rotation. A hand in view drives it: twist (roll) turns the model, raise / lower tilts it — relative to where
    //    the hand grabbed it, so nothing jumps. Otherwise: auto-spin + mouse drag; exploded -> ease to a 3/4 view.
    const def = CATALOG[st.index];
    const handRot = this.handRotate && formed && vis && !!ctl.landmarks && !busyHand && !twoHands;
    if (handRot) {
      if (!this.grab) this.grab = { roll: ctl.roll, y: ctl.handY, spin: this.spin, pitch: this.pitch };
      const yaw = this.grab.spin + HAND_YAW_GAIN * wrapPi(ctl.roll - this.grab.roll);
      const pitch = clamp(this.grab.pitch + HAND_PITCH_GAIN * (ctl.handY - this.grab.y), -0.75, 0.75);
      const kr = 1 - Math.exp(-dt * 9);
      this.spin += (yaw - this.spin) * kr; this.pitch += (pitch - this.pitch) * kr;
    } else {
      this.grab = null;
      if (!(vis && (busyHand || twoHands))) {
        if (this.autoRotate && this.sel < 0) this.spin += dt * 0.35 * (1 - this.explode);
        if (this.explode > 0 && def.viewYaw !== undefined) {
          const d = ((((def.viewYaw - this.spin) % Math.PI) + Math.PI * 1.5) % Math.PI) - Math.PI / 2;
          this.spin += d * (1 - Math.exp(-dt * 3.5 * this.explode));
        }
        this.pitch *= Math.exp(-dt * 1.5);
      }
    }
    this.handRotating = handRot;
    if (this.turn) { const d = this.turn * (1 - Math.exp(-dt * 3)); this.dragYaw += d; this.turn = Math.abs(this.turn - d) < 1e-3 ? 0 : this.turn - d; }   // "turn it 90 degrees" (like a mouse drag, so the exploded-view easing leaves it alone)
    if (this.turnPitch) { const d = this.turnPitch * (1 - Math.exp(-dt * 3)); this.dragPitch = wrapPi(this.dragPitch + d); this.turnPitch = Math.abs(this.turnPitch - d) < 1e-3 ? 0 : this.turnPitch - d; this.viewT = t; }
    if (this.orbit) { this.dragYaw += dt * 0.5; this.dragPitch = wrapPi(this.dragPitch + dt * 0.21); this.viewT = t; }   // 360 degree orbit: every side, top and bottom
    const rot = matMul(rotX(deg(def.tilt || 0) + this.pitch + this.dragPitch), rotY(this.spin + this.dragYaw));

    // 6. life: the heart beats (lub-dub), the lungs breathe; light pulses flow through them
    const life = formed ? smooth(0.5, 1.5, formT) : 0;
    let pulse = 1, flow = 0;
    if (def.pulse) {
      const p = ((t * def.pulse.bpm) / 60) % 1, g = (x) => Math.exp(-((x / 0.065) ** 2));
      pulse = 1 - def.pulse.amp * (g(p) + g(p - 1) + 0.6 * g(p - 0.3)); flow = 1;
    } else if (def.breath) {
      pulse = 1 + def.breath.amp * 0.5 * (1 - Math.cos((2 * Math.PI * t) / def.breath.period)); flow = 0.6;
    }
    this.pulse = 1 + (pulse - 1) * life; this.flow = flow * life;

    const m = ready ? this.model : null;
    this.scale = m ? 1 + (m.fitScale - 1) * this.explode : 1;
    const scale = this.scale * this.pulse;
    const exCenter = m ? m.exCenter : [0, 0, 0];
    // while exploded, slide the model toward the middle so both label columns have room
    this.projView = mul4(this.proj, translate4(this.offX * (1 - 0.45 * this.explode), this.offY, -this.dist / this.zoom));

    // 7. parts: screen anchors, point-to-pick (dwell), pinch-to-pull, quiz, cut-away plane
    this.computeAnchors(formed && machine && m, rot, exCenter, scale);
    this.updatePicking(t, pointing, formed && machine);
    if (this.pendingPart && formed && machine && m && formT > 0.8) {                // a part the Hologram agent was asked for before the model formed
      const li = this.findPart(this.pendingPart); this.pendingPart = null;
      if (li >= 0) this.selectPart(li, 'aether');
    }
    this.pullAmt += ((this.pulled && this.sel >= 0 ? 1 : 0) - this.pullAmt) * (1 - Math.exp(-dt * 6));
    this.updateQuiz(t, formed && machine && m);
    if (this.cut.on) {
      if (vis && !busyHand && ctl.landmarks) {
        const c0 = project(this.projView, [0, 0, 0]), rr = this.globeRadiusPx();
        const px = this.toScreen([ctl.handX, ctl.handY])[0], cx = (c0[0] * 0.5 + 0.5) * this.overlay.width;
        this.cut.target = clamp((px - cx) / rr, -1.25, 1.25);
      }
      this.cut.x += (this.cut.target - this.cut.x) * (1 - Math.exp(-dt * 10));
    }

    const kick = st.consumeKick() ? 1 : 0;                                // one-frame impulse, read exactly once
    const sel = this.sel >= 0 && formed ? this.sel : -100;
    this.renderer.step({ dt, time: t, mode, formT, kick, rot, sphereR: 0.85, explode: this.explode, scale, exCenter, sel, pull: [0, 0, 0.5 * this.pullAmt] });

    // 8. colour morph + per-part colours once a machine has formed
    const k = 1 - Math.exp(-dt * 4);
    for (let i = 0; i < 3; i++) this.color[i] += (def.color[i] - this.color[i]) * k;
    const tintT = machine && st.state === FORMED ? smooth(0.2, 1.4, formT) : 0;
    this.tintMix += (tintT - this.tintMix) * (1 - Math.exp(-dt * 5));
    const alpha = st.alpha(t);

    this.renderer.draw({
      projView: this.projView, globeMvp: mul4(mul4(this.projView, rot4(matMul(rotX(this.dragPitch), rotY(this.dragYaw)))), rotY4(0.1 * t)),   // the globe turns with the 360 view
      depth: [this.dist / this.zoom - 1.1, this.dist / this.zoom + 1.1], holo: CFG.holo, color: this.color, tintMix: this.tintMix,
      alpha, trails: this.trails, trailLen: 0.06, pointPx: this.canvas.height * 0.012 * Math.sqrt(this.zoom), gain: this.gain,
      video: { has: this.hasVideo && this.camOn, dim: 0.65 }, sel, cutOn: this.cut.on && formed, cut: this.cut.x, flow: this.flow, time: t,
    });
    this.drawOverlay(t, machine, formT, pointing);
    this.recorder.frame();
    this.frames++; this._fpsN++;
    if (t - this._fpsT >= 1) { this.fps = this._fpsN / (t - this._fpsT); this._fpsN = 0; this._fpsT = t; }
    if (++this.hudTick % 3 === 0 || CFG.manual) this.updateHud(t, formT);
  }

  // ------------------------------------------------------------ parts: anchors, picking, pulling
  globeRadiusPx() { const P = this.projView, c0 = project(P, [0, 0, 0]); return Math.abs((project(P, [0, 1, 0])[1] - c0[1]) * 0.5 * this.overlay.height); }
  computeAnchors(on, rot, exCenter, scale) {
    this.anchors = [];
    if (!on) return;
    const W = this.overlay.width, H = this.overlay.height, P = this.projView;
    this.model.labels.forEach((L, li) => {
      const s0 = clamp((this.explode - L.stage) / Math.max(1 - L.stage, 1e-3), 0, 1), s = s0 * s0 * (3 - 2 * s0);
      const q = [0, 1, 2].map((i) => (L.centroid[i] + L.offset[i] * s - exCenter[i] * this.explode) * scale);
      const w = matVec(rot, q);
      if (li === this.sel) w[2] += 0.5 * this.pullAmt;
      const [nx, ny] = project(P, w);
      this.anchors.push({ li, L, px: (nx * 0.5 + 0.5) * W, py: (0.5 - ny * 0.5) * H });
    });
  }
  nearestAnchor(x, y, maxPx) {
    let best = -1, bd = maxPx;
    for (const a of this.anchors) { const d = Math.hypot(a.px - x, a.py - y); if (d < bd) { bd = d; best = a.li; } }
    return best;
  }
  updatePicking(t, pointing, active) {
    const ctl = this.ctl, dpr = CFG.dpr;
    this.pointer = null;
    if (!active) { this.hover = { li: -1, t0: t }; return; }
    if (pointing && ctl.landmarks) {
      const [x, y] = this.toScreen(ctl.landmarks[8]);
      const li = this.nearestAnchor(x, y, 120 * dpr);
      if (li !== this.hover.li) this.hover = { li, t0: t };
      const prog = li >= 0 ? clamp((t - this.hover.t0) / DWELL_S, 0, 1) : 0;
      this.pointer = { x, y, li, prog };
      if (li >= 0 && prog >= 1 && li !== this.sel) this.selectPart(li, 'point');
      if (li >= 0) this.lostT = t;
      else if (t - this.lostT > 1.4 && this.sel >= 0 && !this.quiz) this.deselect();
    } else this.hover = { li: -1, t0: t };
    if (ctl.pinchStart) {
      ctl.pinchStart = false;
      if (this.sel >= 0) { this.pulled = !this.pulled; this.toast(this.pulled ? `🤏 Pulled out: ${this.model.labels[this.sel].label}` : '🤏 Put back'); }
    }
  }
  selectPart(li, source = 'click') {
    if (!this.model || !this.model.labels[li]) return;
    if (this.quiz && !this.quiz.done && this.quiz.phase === 'ask') { this.answerQuiz(li); return; }
    this.sel = li; this.pulled = false;
    const L = this.model.labels[li];
    this.say(`${L.label}. ${L.info}.`);
    this.toast(`☝ ${L.label} — ${L.info}`);
  }
  deselect() { this.sel = -1; this.pulled = false; }
  say(text) { this.spoken.push(text); if (this.voiceOn) speak(text); }

  // ------------------------------------------------------------ quiz: "find the hippocampus"
  startQuiz() {
    const st = this.ctl.state;
    if (!isMachine(st.index)) this.selectModel(CATALOG.findIndex((d) => d.name === 'Human Brain'));
    else if (st.state !== FORMED) this.selectModel(st.index);
    this.quiz = { pending: true, total: QUIZ_LEN, asked: 0, score: 0, target: -1, phase: 'wait', nextAt: 0, done: false, feedback: '', seed: this.frames };
    this.manualExplode = 1;
    this.toast('🎓 Quiz: point at the part I name');
  }
  stopQuiz() { this.quiz = null; this.deselect(); }
  updateQuiz(t, ready) {
    const q = this.quiz;
    if (!q || !ready) return;
    if (q.pending) {
      q.pending = false;
      const n = this.model.labels.length, order = [...Array(n).keys()];
      let s = (q.seed * 2654435761) >>> 0;
      for (let i = n - 1; i > 0; i--) { s = (s * 1664525 + 1013904223) >>> 0; const j = s % (i + 1); [order[i], order[j]] = [order[j], order[i]]; }
      q.order = order; this.manualExplode = 1; this.nextQuestion();
    }
    if (q.phase === 'feedback' && t >= q.nextAt) this.nextQuestion();
    if (q.done && t >= q.nextAt + 4) this.stopQuiz();
  }
  nextQuestion() {
    const q = this.quiz;
    this.deselect();
    if (q.asked >= q.total) {
      q.done = true; q.phase = 'done'; q.nextAt = this.t;
      q.feedback = `🏆 Score ${q.score} / ${q.total}`;
      this.say(`Quiz finished. You scored ${q.score} out of ${q.total}.`);
      return;
    }
    q.target = q.order[q.asked % q.order.length]; q.asked++; q.phase = 'ask'; q.feedback = '';
    this.say(`Find the ${this.model.labels[q.target].label}`);
  }
  answerQuiz(li) {
    const q = this.quiz, L = this.model.labels;
    const ok = li === q.target;
    if (ok) q.score++;
    q.phase = 'feedback'; q.nextAt = this.t + 1.8;
    q.feedback = ok ? `✅ Correct! ${L[li].label}: ${L[li].info}` : `❌ That's the ${L[li].label}. Here is the ${L[q.target].label}.`;
    this.sel = q.target;                                                // reveal the right answer
    this.say(ok ? `Correct! ${L[li].info}` : `No, that's the ${L[li].label}.`);
  }

  // ------------------------------------------------------------ voice
  /** From the microphone. While AETHER talks, only its name gets through (so it doesn't answer itself). */
  heard(text) {
    if (window.speechSynthesis?.speaking) {
      if (!stripWake(text).woke) return;
      window.speechSynthesis.cancel();
    }
    this.voiceCommand(text);
  }
  /** "Aether, …" (or a follow-up right after it spoke) goes to AETHER's agents; anything else is a quick keyword command. */
  voiceCommand(text) {
    const w = stripWake(text);
    if (w.woke || this.aether.following()) {
      this.lastHeard = text; sfx('listen');
      this.aether.hear(w.rest);
      return ['aether'];
    }
    return this.localCommand(text);
  }
  localCommand(text, quiet = false) {
    this.lastHeard = text;
    const acts = parseCommand(text, CATALOG, this.model && isMachine(this.uploaded) && this.uploaded === this.ctl.state.index ? this.model.labels : []);
    const st = this.ctl.state, done = [];
    for (const a of acts) {
      if (a.type === 'model') { this.selectModel(CATALOG.findIndex((d) => d.name === a.name)); done.push(a.name); }
      else if (a.type === 'part') { this.selectPart(a.index, 'voice'); done.push(this.model.labels[a.index].label); }
      else if (a.type === 'explode') { this.manualExplode = 1; done.push('explode'); }
      else if (a.type === 'assemble') { this.manualExplode = 0; done.push('assemble'); }
      else if (a.type === 'next') { this.selectModel(st.index + 1); done.push('next'); }
      else if (a.type === 'prev') { this.selectModel(st.index - 1); done.push('previous'); }
      else if (a.type === 'snap') { if (st.state === IDLE) this.ctl.keySnap(this.t); done.push('snap'); }
      else if (a.type === 'dissolve') { if (st.state !== IDLE) this.ctl.keySnap(this.t); done.push('dissolve'); }
      else if (a.type === 'quiz') { this.startQuiz(); done.push('quiz'); }
      else if (a.type === 'stopQuiz') { this.stopQuiz(); done.push('stop quiz'); }
      else if (a.type === 'cut') { this.toggleCut(); done.push('cut'); }
      else if (a.type === 'zoomIn') { this.zoomTarget = clamp(this.zoomTarget * 1.3, 0.5, 2.6); done.push('zoom in'); }
      else if (a.type === 'zoomOut') { this.zoomTarget = clamp(this.zoomTarget / 1.3, 0.5, 2.6); done.push('zoom out'); }
      else if (a.type === 'rotate') { this.toggle('autoRotate', 'bRotate'); done.push('rotate'); }
      else if (a.type === 'record') { this.toggleRecord(); done.push('record'); }
      else if (a.type === 'describe') {
        const L = this.sel >= 0 && this.model?.labels[this.sel];
        this.say(L ? `${L.label}. ${L.info}.` : `${CATALOG[st.index].name}. ${CATALOG[st.index].fact || ''}`); done.push('describe');
      }
    }
    if (!quiet) this.toast(`🎤 “${text}”${done.length ? ' → ' + done.join(', ') : ' (not understood)'}`);
    return done;
  }

  // ------------------------------------------------------------ AETHER: display context + agent tools
  findPart(name) {
    const L = this.model && this.uploaded === this.ctl.state.index ? this.model.labels : [], q = String(name || '').toLowerCase().trim();
    if (!q) return -1;
    let i = L.findIndex((l) => l.label.toLowerCase() === q);
    if (i < 0) i = L.findIndex((l) => l.label.toLowerCase().includes(q) || q.includes(l.label.toLowerCase()));
    if (i < 0) {                                                        // best word overlap ("the left atrium" -> "Left atrium")
      const ws = q.split(/[^a-z0-9]+/).filter((w) => w.length > 3);
      let best = 0;
      L.forEach((l, k) => { const s = ws.filter((w) => l.label.toLowerCase().includes(w)).length; if (s > best) { best = s; i = k; } });
    }
    return i;
  }
  ensureFormed() {
    const st = this.ctl.state;
    if (st.state === IDLE || st.state === DISSOLVE) this.selectModel(st.index);
    else if (st.state === SPHERE && this.autoFormAt === null) this.autoFormAt = this.t + 0.4;
  }
  aetherContext() {
    const st = this.ctl.state, def = CATALOG[st.index], ready = this.uploaded === st.index && this.model;
    return {
      model: def.name, category: def.category, fact: def.fact || '', explodable: isMachine(st.index), scene: st.state,
      exploded: `${Math.round(this.explode * 100)}%`, zoom: +this.zoom.toFixed(2), selectedPart: this.sel >= 0 && ready ? this.model.labels[this.sel].label : null,
      parts: ready && isMachine(st.index) ? this.model.labels.map((l) => l.label) : [],
      camera: this.camOn, handInView: this.ctl.handVisible(this.t), quiz: !!this.quiz, recording: this.recorder.on,
    };
  }
  systemStatus() {
    const b = this.battery;
    return {
      time: new Date().toLocaleTimeString(), date: new Date().toLocaleDateString(), fps: Math.round(this.fps), particles: CFG.n,
      camera: this.cam?.running ? `on, ${this.cam.fps.toFixed(0)} fps, hand tracking on ${this.cam.delegate}` : 'off',
      battery: b ? `${Math.round(b.level * 100)}%${b.charging ? ' and charging' : ''}` : null, network: navigator.onLine ? 'online' : 'offline',
      cpuCores: navigator.hardwareConcurrency || null, memoryGB: navigator.deviceMemory || null,
      brain: this.aether.online ? `OpenRouter ${this.aether.model || this.aether.models[0] || ''}`.trim() : 'local protocols',
    };
  }
  async aetherTool(name, a = {}) {
    const st = this.ctl.state, clampN = (x, lo, hi, d) => clamp(Number.isFinite(+x) ? +x : d, lo, hi);
    const flag = (prop, btn, on) => { if (!!this[prop] !== on) this.toggle(prop, btn); };
    switch (name) {
      case 'show_model': {
        const q = String(a.name || '').toLowerCase();
        let i = CATALOG.findIndex((d) => d.name.toLowerCase() === q);
        if (i < 0) i = CATALOG.findIndex((d) => d.name.toLowerCase().includes(q) || (q && q.includes(d.name.toLowerCase())));
        if (i < 0) return { ok: false, error: `no model called ${a.name}` };
        this.selectModel(i);
        return { ok: true, model: CATALOG[i].name, explodable: isMachine(i), fact: CATALOG[i].fact || '' };
      }
      case 'change_model': this.selectModel(st.index + (a.direction === 'previous' ? -1 : 1)); return { ok: true, model: CATALOG[st.index].name };
      case 'explode_view': {
        if (!isMachine(st.index)) return { ok: false, error: `${CATALOG[st.index].name} is a landmark: it does not come apart` };
        const v = clampN(a.amount, 0, 1, 1);
        this.ensureFormed(); this.manualExplode = v;
        if (st.targetDirty || this.uploaded !== st.index) this.pendingExplode = v;
        return { ok: true, exploded: `${Math.round(v * 100)}%` };
      }
      case 'select_part': {
        if (!isMachine(st.index)) return { ok: false, error: 'this model has no labelled parts' };
        this.ensureFormed();
        if (st.state !== FORMED || this.uploaded !== st.index) { this.pendingPart = a.name; return { ok: true, note: 'will highlight it once the model has formed' }; }
        const li = this.findPart(a.name);
        if (li < 0) return { ok: false, error: `no part called ${a.name}`, parts: this.model.labels.map((l) => l.label) };
        this.sel = li; this.pulled = false; this.manualExplode = Math.max(this.manualExplode, 0.6);
        const L = this.model.labels[li];
        return { ok: true, part: L.label, whatItDoes: L.info };
      }
      case 'hologram':
        if (a.action === 'dissolve') { if (st.state !== IDLE && st.state !== DISSOLVE) this.ctl.keySnap(this.t); }
        else if (st.state === IDLE || st.state === DISSOLVE) this.ctl.keySnap(this.t);
        return { ok: true, scene: st.state };
      case 'zoom': this.zoomTarget = clampN(a.level, 0.5, 2.6, 1); return { ok: true, zoom: this.zoomTarget };
      case 'rotate_view':
        this.turn += deg(clampN(a.degrees, -720, 720, 0)); this.turnPitch += deg(clampN(a.pitch, -720, 720, 0));
        if (!a.degrees && !a.pitch) this.turn += deg(90);
        return { ok: true };
      case 'describe_model': {
        const def = CATALOG[st.index], ready = this.uploaded === st.index && this.model;
        return { ok: true, model: def.name, category: def.category, fact: def.fact || '', explodable: isMachine(st.index),
          parts: ready ? this.model.labels.map((l) => ({ label: l.label, info: l.info })) : [], selectedPart: this.sel >= 0 && ready ? this.model.labels[this.sel].label : null };
      }
      case 'set_display': case 'set_device': case 'set_feature': {
        const on = a.on !== false, feature = a.feature || a.device;
        switch (feature) {
          case 'auto_rotate': flag('autoRotate', 'bRotate', on); break;
          case 'labels': flag('labelsOn', 'bLabels', on); break;
          case 'hand_rotation': flag('handRotate', 'bHandRot', on); break;
          case 'cut_away': if (this.cut.on !== on) this.toggleCut(); break;
          case 'recording': if (this.recorder.on !== on) this.toggleRecord(); break;
          case 'quiz': if (on && !this.quiz) this.startQuiz(); else if (!on && this.quiz) this.stopQuiz(); break;
          case 'camera': if (this.camOn !== on) { if (on) return { ok: await this.startCamera() }; this.stopCamera(); } break;
          case 'demo': if (!!this.demo !== on) this.toggleDemo(); break;
          case 'orbit_360': if (this.orbit !== on) this.toggleOrbit(); break;
          case 'voice': if (this.voiceOn !== on) this.toggleVoice(); break;
          default: return { ok: false, error: `unknown feature ${feature}` };
        }
        return { ok: true, feature, on };
      }
      case 'fire_repulsor': this.fireRepulsor(); return { ok: true };
      case 'system_status': return this.systemStatus();
      default: return { ok: false, error: `unknown tool ${name}` };
    }
  }
  fireRepulsor() {
    const lm = this.ctl.handVisible(this.t) ? this.ctl.landmarks : null;
    const [x, y] = lm ? this.toScreen([(lm[0][0] + lm[9][0]) / 2, (lm[0][1] + lm[9][1]) / 2]) : [this.overlay.width / 2, this.overlay.height / 2];
    this.blast = { t0: this.t, x, y };
    if (this.ctl.state.state === SPHERE) this.ctl.state.kick = true;           // the swirl bursts outward
    sfx('repulsor');
    this.toast('💥 Repulsor!');
  }
  // ------------------------------------------------------------ AETHER console: chat, agent dots, task cards
  aetherAppend(el) {
    const log = this.$('aLog');
    log.appendChild(el);
    while (log.children.length > 40) { const old = log.firstChild; old.remove(); for (const [k, v] of this.taskEls) if (v.root === old) this.taskEls.delete(k); }
    log.scrollTop = log.scrollHeight;
  }
  aetherLog(role, text) {
    const el = document.createElement('div');
    el.className = `amsg by-${role}`; el.textContent = text;
    this.aetherAppend(el);
    if (role === 'aether') this.$('aether').classList.remove('min');
  }
  /** A task card per agent run: coloured dot, the task, a live list of tool steps, then the agent's report. */
  aetherTask(e) {
    const T = e.task;
    let c = this.taskEls.get(T.id);
    if (e.type === 'start' || !c) {
      const root = document.createElement('div'), A = AGENTS[T.agent];
      root.className = 'atask running'; root.dataset.agent = T.agent; root.style.setProperty('--agent', A.color);
      root.innerHTML = '<div class="thead"><i class="dot"></i><b></b><span class="ttext"></span><span class="tstat"></span></div><ol class="tsteps"></ol><div class="treply"></div>';
      root.querySelector('b').textContent = A.name; root.querySelector('.ttext').textContent = T.text;
      root.querySelector('.thead').onclick = () => root.classList.toggle('open');
      c = { root, steps: root.querySelector('.tsteps'), stepEls: new Map() };
      this.taskEls.set(T.id, c); this.aetherAppend(root);
    }
    if (e.type === 'step') {
      let li = c.stepEls.get(e.step);
      if (!li) { li = document.createElement('li'); li.textContent = e.step.label; c.steps.appendChild(li); c.stepEls.set(e.step, li); }
      li.className = e.step.ok === null ? 'run' : e.step.ok ? 'ok' : 'fail';
      this.$('aLog').scrollTop = this.$('aLog').scrollHeight;
    }
    if (e.type === 'end') {
      c.root.classList.remove('running'); c.root.classList.add(T.state);
      c.root.querySelector('.tstat').textContent = T.state === 'done' ? `✓ ${T.steps.length} step${T.steps.length === 1 ? '' : 's'}` : '✕';
      c.root.querySelector('.treply').textContent = T.reply;
    }
  }
  aetherState() {
    const X = this.aether, el = this.$('aState');
    if (!el) return;
    const brain = X.online ? `online · ${(X.model || X.models[0] || 'OpenRouter').replace(/:free$/, '').split('/').pop()}` : 'local protocols';
    const working = Object.entries(X.agents).filter(([k, A]) => k !== 'core' && (A.state === 'thinking' || A.state === 'working')).map(([k]) => AGENTS[k].name);
    el.textContent = working.length ? `${working.join(' + ')} working…` : X.busy ? 'thinking…' : X.speaking ? 'speaking…' : this.voiceOn ? `listening · ${brain}` : brain;
    const orb = this.$('aOrb');                                          // the voice dots: idle / listening / thinking / speaking
    orb.dataset.mode = X.speaking ? 'speaking' : X.busy ? 'thinking' : this.voiceOn ? 'listening' : 'idle';
    orb.classList.toggle('online', X.online);
    for (const b of this.$('aAgents').children) {
      const A = X.agents[b.dataset.agent];
      b.dataset.state = A.state;
      b.title = `${AGENTS[b.dataset.agent].name}: ${AGENTS[b.dataset.agent].role}${A.task ? `\nNow: ${A.task}` : ''}\nRuns: ${A.runs}`;
    }
  }
  toggleVoice() {
    if (this.voiceOn) { this.voice.stop(); this.voiceOn = false; this.toast('🎤 Voice off'); }
    else {
      this.voiceOn = true;
      const ok = this.voice.start();
      this.toast(ok ? '🎤 Listening: say “Aether, show me the arc reactor”, or just “explode”, “next”…' : '🎤 Speech recognition is not available here: type to AETHER instead');
    }
    this.$('bVoice').classList.toggle('on', this.voiceOn);
    this.$('aMic').classList.toggle('on', this.voiceOn);
    this.aetherState();
  }

  // ------------------------------------------------------------ cut-away + recording
  toggleCut() { this.cut.on = !this.cut.on; this.$('bCut').classList.toggle('on', this.cut.on); this.toast(this.cut.on ? '✂ Cut-away: move your hand (or the mouse) left / right' : '✂ Cut-away off'); }
  async toggleRecord() {
    if (!Recorder.supported()) { this.toast('Recording is not supported in this browser'); return; }
    if (!this.recorder.on) { this.recorder.start(); this.$('bRec').classList.add('on'); this.toast('⏺ Recording…'); return; }
    const blob = await this.recorder.stop();
    this.$('bRec').classList.remove('on');
    if (!blob) return;
    this.lastRecording = { size: blob.size, type: blob.type };
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `aether-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.webm`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    this.toast(`💾 Saved ${(blob.size / 1e6).toFixed(1)} MB video`);
  }

  // ------------------------------------------------------------ overlay: hands, pointer, labels
  videoAspect() { return this.hasVideo && this.camOn && this.video.videoWidth ? this.video.videoWidth / this.video.videoHeight : 16 / 9; }
  toScreen([x, y]) {
    const W = this.overlay.width, H = this.overlay.height, va = this.videoAspect();
    if (va > W / H) { const dw = H * va; return [(x - 0.5) * dw + W / 2, y * H]; }
    const dh = W / va; return [x * W, (y - 0.5) * dh + H / 2];
  }
  toNorm([px, py]) {
    const W = this.overlay.width, H = this.overlay.height, va = this.videoAspect();
    if (va > W / H) { const dw = H * va; return [(px - W / 2) / dw + 0.5, py / H]; }
    const dh = W / va; return [px / W, (py - H / 2) / dh + 0.5];
  }
  drawHand(g, lm, col, dpr) {
    const P = lm.map((p) => this.toScreen(p));
    g.lineWidth = 2 * dpr; g.strokeStyle = col; g.globalAlpha = 0.75; g.shadowColor = col; g.shadowBlur = 10 * dpr;
    g.beginPath();
    for (const [a, b] of HAND_EDGES) { g.moveTo(P[a][0], P[a][1]); g.lineTo(P[b][0], P[b][1]); }
    g.stroke();
    g.fillStyle = '#fff'; g.globalAlpha = 0.9;
    for (const p of P) { g.beginPath(); g.arc(p[0], p[1], 2.6 * dpr, 0, Math.PI * 2); g.fill(); }
    return P;
  }
  /** Stark HUD: rotating reticle rings around the hologram + the repulsor shockwave. */
  drawHud(g, t, W, H, dpr) {
    const st = this.ctl.state.state;
    const c0 = project(this.projView, [0, 0, 0]), cx = (c0[0] * 0.5 + 0.5) * W, cy = (0.5 - c0[1] * 0.5) * H, rr = this.globeRadiusPx();
    const a = (st === IDLE ? 0.35 : 0.8) * (1 - 0.75 * this.explode);
    if (a > 0.02) {
      g.save(); g.translate(cx, cy); g.lineCap = 'round';
      g.globalAlpha = 0.16 * a; g.strokeStyle = '#6fdcff'; g.lineWidth = 1 * dpr;
      g.beginPath(); g.arc(0, 0, rr * 1.2, 0, Math.PI * 2); g.stroke();
      g.globalAlpha = 0.45 * a; g.lineWidth = 2.2 * dpr;                  // broken arc, slow spin
      for (let k = 0; k < 3; k++) { const s = t * 0.25 + (k * Math.PI * 2) / 3; g.beginPath(); g.arc(0, 0, rr * 1.28, s, s + 1.3); g.stroke(); }
      g.globalAlpha = 0.3 * a; g.lineWidth = 1 * dpr;                     // tick ring, counter-spin
      g.rotate(-t * 0.08);
      for (let k = 0; k < 90; k++) {
        const r0 = rr * 1.36, r1 = r0 + (k % 10 === 0 ? 10 : 4) * dpr, q = (k / 90) * Math.PI * 2;
        g.beginPath(); g.moveTo(Math.cos(q) * r0, Math.sin(q) * r0); g.lineTo(Math.cos(q) * r1, Math.sin(q) * r1); g.stroke();
      }
      g.rotate(t * 0.08);
      g.globalAlpha = 0.7 * a; g.strokeStyle = '#ffb347'; g.lineWidth = 3 * dpr;   // orange gauge = frame budget
      g.beginPath(); g.arc(0, 0, rr * 1.45, Math.PI * 0.8, Math.PI * (0.8 + 0.4 * clamp(this.fps / 60, 0, 1))); g.stroke();
      g.restore();
    }
    if (CFG.holo && st !== IDLE) {                                       // holo-projector: emitter disc + light cone up into the globe
      const by = cy + rr * 1.13, bw = rr * 0.62, bh = rr * 0.09, k = st === DISSOLVE ? 0.4 : 1;
      g.save(); g.globalCompositeOperation = 'lighter';
      const cone = g.createLinearGradient(0, by, 0, cy - rr * 0.5);
      cone.addColorStop(0, `rgba(79, 216, 255, ${0.13 * k})`); cone.addColorStop(1, 'rgba(79, 216, 255, 0)');
      g.fillStyle = cone;
      g.beginPath(); g.moveTo(cx - bw * 0.55, by); g.lineTo(cx + bw * 0.55, by); g.lineTo(cx + rr * 1.02, cy - rr * 0.5); g.lineTo(cx - rr * 1.02, cy - rr * 0.5); g.closePath(); g.fill();
      const pool = g.createRadialGradient(cx, by, 0, cx, by, bw);
      pool.addColorStop(0, `rgba(170, 235, 255, ${0.35 * k})`); pool.addColorStop(1, 'rgba(79, 216, 255, 0)');
      g.fillStyle = pool; g.beginPath(); g.ellipse(cx, by, bw, bh, 0, 0, Math.PI * 2); g.fill();
      g.strokeStyle = '#6fdcff'; g.lineWidth = 1.2 * dpr;
      for (const [s, al] of [[1, 0.55], [0.72, 0.4], [0.44, 0.6]]) {
        g.globalAlpha = al * k; g.setLineDash(s === 0.72 ? [6 * dpr, 5 * dpr] : []); g.lineDashOffset = -t * 30 * dpr;
        g.beginPath(); g.ellipse(cx, by, bw * s, bh * s, 0, 0, Math.PI * 2); g.stroke();
      }
      g.restore();
    }
    if (this.orbit || this.t - this.viewT < 2.5) {                       // 360 view readout
      const yawD = Math.round(((((this.spin + this.dragYaw) * 180) / Math.PI) % 360 + 360) % 360), pitchD = Math.round((wrapPi(this.dragPitch + this.pitch) * 180) / Math.PI);
      g.save(); g.globalAlpha = 0.85; g.fillStyle = '#9be8ff'; g.textAlign = 'center';
      g.font = `600 ${14 * dpr}px Orbitron, Rajdhani, ui-sans-serif, sans-serif`;
      g.fillText(`${this.orbit ? '◉ 360° ORBIT' : '360° VIEW'} · YAW ${yawD}° · PITCH ${pitchD > 0 ? '+' : ''}${pitchD}°`, W / 2, 104 * dpr);   // in the title slot (the title hides while you look around)
      g.restore();
    }
    const agents = this.aether.active().filter((x) => x.id !== 'core');   // active agents orbit the hologram
    agents.forEach((x, i) => {
      const busy = x.state === 'working' || x.state === 'thinking', q = t * (x.state === 'working' ? 1.7 : 0.9) + (i * Math.PI * 2) / agents.length;
      const r = rr * 1.28, px = cx + Math.cos(q) * r, py = cy + Math.sin(q) * r, pr = (busy ? 5 + 1.5 * Math.sin(t * 8 + i) : 4) * dpr;
      g.save();
      g.globalAlpha = busy ? 0.5 : 0.25; g.strokeStyle = x.color; g.lineWidth = 2 * dpr; g.lineCap = 'round';
      g.beginPath(); g.arc(cx, cy, r, q - 0.55, q); g.stroke();                              // comet trail
      g.globalAlpha = x.state === 'error' ? 0.6 : 1; g.fillStyle = x.state === 'error' ? '#ff6b5b' : x.color; g.shadowColor = g.fillStyle; g.shadowBlur = 16 * dpr;
      g.beginPath(); g.arc(px, py, pr, 0, Math.PI * 2); g.fill();
      g.restore();
    });
    const b = this.blast;
    if (b) {
      const u = (t - b.t0) / 0.7;
      if (u >= 1 || u < 0) this.blast = null;
      else {
        g.save();
        g.globalAlpha = 0.35 * (1 - u); g.fillStyle = '#cfefff'; g.fillRect(0, 0, W, H);   // flash
        g.globalAlpha = 1 - u; g.strokeStyle = '#9be8ff'; g.shadowColor = '#6fdcff'; g.shadowBlur = 30 * dpr;
        for (const [k, w] of [[1, 8], [0.6, 3]]) { g.lineWidth = w * dpr * (1 - u); g.beginPath(); g.arc(b.x, b.y, (40 + 900 * u * k) * dpr, 0, Math.PI * 2); g.stroke(); }
        g.restore();
      }
    }
  }
  drawOverlay(t, machine, formT, pointing) {
    const g = this.octx, W = this.overlay.width, H = this.overlay.height, dpr = CFG.dpr, ctl = this.ctl;
    g.clearRect(0, 0, W, H);
    this.drawHud(g, t, W, H, dpr);
    const lm = ctl.handVisible(t) ? ctl.landmarks : null;
    if (lm) {
      const P = this.drawHand(g, lm, ctl.pinch ? '#ff9f43' : POSE_COLOR[ctl.pose] || '#fff', dpr);
      if (machine && ctl.state.state === FORMED && !pointing && !ctl.secondVisible(t)) {   // openness ring around the palm
        const c = this.toScreen([(lm[0][0] + lm[9][0]) / 2, (lm[0][1] + lm[9][1]) / 2]);
        const r = Math.hypot(P[0][0] - P[9][0], P[0][1] - P[9][1]) * 1.4;
        g.globalAlpha = 0.25; g.lineWidth = 6 * dpr; g.beginPath(); g.arc(c[0], c[1], r, 0, Math.PI * 2); g.stroke();
        g.globalAlpha = 0.95; g.strokeStyle = '#ffd166'; g.shadowColor = '#ffd166';
        g.beginPath(); g.arc(c[0], c[1], r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * this.explode); g.stroke();
      }
      g.shadowBlur = 0; g.globalAlpha = 1;
    }
    if (ctl.secondVisible(t)) {                                         // second hand + zoom bridge
      const P2 = this.drawHand(g, ctl.second, '#b69cff', dpr);
      if (lm) {
        const a = this.toScreen(lm[9]), b = P2[9];
        g.shadowBlur = 0; g.setLineDash([6 * dpr, 6 * dpr]); g.strokeStyle = '#b69cff'; g.globalAlpha = 0.8; g.lineWidth = 2 * dpr;
        g.beginPath(); g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]); g.stroke(); g.setLineDash([]);
        g.fillStyle = '#e8dcff'; g.font = `700 ${13 * dpr}px ui-sans-serif, system-ui, sans-serif`; g.textAlign = 'center';
        g.fillText(`🔍 zoom ${this.zoom.toFixed(2)}×`, (a[0] + b[0]) / 2, (a[1] + b[1]) / 2 - 12 * dpr);
      }
      g.shadowBlur = 0; g.globalAlpha = 1;
    }
    if (this.pointer) {                                                 // fingertip cursor + dwell ring
      const { x, y, li, prog } = this.pointer;
      g.strokeStyle = '#7dff9b'; g.lineWidth = 2 * dpr; g.globalAlpha = 0.9;
      g.beginPath(); g.arc(x, y, 14 * dpr, 0, Math.PI * 2); g.stroke();
      if (li >= 0) {
        g.lineWidth = 4 * dpr; g.beginPath(); g.arc(x, y, 20 * dpr, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * prog); g.stroke();
        const a = this.anchors.find((q) => q.li === li);
        if (a) { g.setLineDash([4 * dpr, 4 * dpr]); g.beginPath(); g.moveTo(x, y); g.lineTo(a.px, a.py); g.stroke(); g.setLineDash([]); }
      }
      g.globalAlpha = 1;
    }
    if (this.cut.on && ctl.state.state === FORMED) {                    // cut plane marker
      const c0 = project(this.projView, [0, 0, 0]), rr = this.globeRadiusPx();
      const x = (c0[0] * 0.5 + 0.5) * W + this.cut.x * rr, cy = (0.5 - c0[1] * 0.5) * H;
      g.strokeStyle = '#ffffff'; g.globalAlpha = 0.5; g.setLineDash([8 * dpr, 6 * dpr]); g.lineWidth = 1.5 * dpr;
      g.beginPath(); g.moveTo(x, cy - rr * 1.1); g.lineTo(x, cy + rr * 1.1); g.stroke(); g.setLineDash([]);
      g.globalAlpha = 0.9; g.fillStyle = '#fff'; g.font = `600 ${12 * dpr}px ui-sans-serif, system-ui, sans-serif`; g.textAlign = 'center';
      g.fillText('✂ cross-section', x, cy - rr * 1.1 - 8 * dpr); g.globalAlpha = 1;
    }
    if (!this.anchors.length) return;
    const showAll = this.labelsOn && this.explode > 0.15;
    const items = this.anchors.filter((a) => showAll || a.li === this.sel);
    if (!items.length) return;
    const alpha = showAll ? smooth(0.15, 0.45, this.explode) * smooth(0.6, 1.4, formT) : 1;
    const c0 = project(this.projView, [0, 0, 0]), cx = (c0[0] * 0.5 + 0.5) * W, rr = this.globeRadiusPx();
    // balance the two label columns: split at the median screen x (not the model centre), so neither side overflows
    [...items].sort((p, q) => p.px - q.px).forEach((it, i, arr) => { it.side = arr.length === 1 ? (it.px >= cx ? 1 : -1) : i < Math.floor(arr.length / 2) ? -1 : 1; });
    const big = `600 ${12 * dpr}px ui-sans-serif, system-ui, "Segoe UI", sans-serif`, small = `400 ${10.5 * dpr}px ui-sans-serif, system-ui, "Segoe UI", sans-serif`;
    g.textBaseline = 'middle';
    const card = this.$('partCard'), cardBottom = card.hidden ? 0 : (card.getBoundingClientRect().bottom + 14) * dpr;
    for (const side of [-1, 1]) {
      const col = items.filter((it) => it.side === side).sort((p, q) => p.py - q.py);
      const gap = 31 * dpr, top = side > 0 ? Math.max(110 * dpr, cardBottom) : 110 * dpr;   // keep clear of the part card
      col.forEach((it, i) => { it.ly = Math.max(it.py, i ? col[i - 1].ly + gap : top); });
      const over = col.length ? col[col.length - 1].ly - (H - 130 * dpr) : 0;
      if (over > 0) col.forEach((it) => { it.ly -= over; });
      for (const it of col) {
        const L = it.L, selected = it.li === this.sel, info = L.info;
        g.font = big; let tw = g.measureText(L.label).width;
        if (info) { g.font = small; tw = Math.max(tw, g.measureText(info).width); }
        const lx = side > 0 ? Math.min(cx + rr + 24 * dpr, W - tw - 16 * dpr) : Math.max(cx - rr - 24 * dpr, tw + 16 * dpr);
        const a = selected ? 1 : this.sel >= 0 ? alpha * 0.45 : alpha;
        g.globalAlpha = a * 0.6; g.strokeStyle = rgbCss(L.color); g.lineWidth = (selected ? 2 : 1) * dpr;
        g.beginPath(); g.moveTo(it.px, it.py); g.lineTo(lx - side * 6 * dpr, it.ly); g.lineTo(lx, it.ly); g.stroke();
        g.globalAlpha = a; g.fillStyle = rgbCss(L.color);
        g.beginPath(); g.arc(it.px, it.py, (selected ? 5 : 3) * dpr, 0, Math.PI * 2); g.fill();
        if (selected) { g.strokeStyle = '#fff'; g.lineWidth = 2 * dpr; g.beginPath(); g.arc(it.px, it.py, 11 * dpr, 0, Math.PI * 2); g.stroke(); }
        g.font = big; g.fillStyle = selected ? '#ffffff' : '#eef6ff'; g.textAlign = side > 0 ? 'left' : 'right';
        g.fillText(L.label, lx + side * 4 * dpr, info ? it.ly - 7 * dpr : it.ly);
        if (info) { g.font = small; g.fillStyle = 'rgba(190, 210, 235, 0.9)'; g.fillText(info, lx + side * 4 * dpr, it.ly + 8 * dpr); }
      }
    }
    g.globalAlpha = 1;
  }

  // ------------------------------------------------------------ HUD
  buildUI() {
    const tabs = this.$('catTabs'), chips = this.$('catChips');
    this.tabs = {}; this.chips = [];
    for (const c of CATEGORIES) {
      const b = document.createElement('button');
      b.className = 'tab'; b.textContent = `${c} · ${CATALOG.filter((d) => d.category === c).length}`; b.dataset.cat = c;
      b.addEventListener('click', () => this.showCategory(c));
      tabs.appendChild(b); this.tabs[c] = b;
    }
    CATALOG.forEach((d, i) => {
      const b = document.createElement('button');
      b.className = 'chip'; b.dataset.index = i; b.dataset.cat = d.category;
      b.innerHTML = `<i style="color:${rgbCss(d.color)};background:${rgbCss(d.color)}"></i>${d.name}`;
      b.addEventListener('click', () => this.selectModel(i));
      chips.appendChild(b); this.chips[i] = b;
    });
    this.showCategory(this.activeCat);
    for (const [id, A] of Object.entries(AGENTS)) {                     // one dot per agent; click = talk to that agent directly
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'agent'; b.dataset.agent = id; b.dataset.state = 'idle'; b.style.setProperty('--agent', A.color);
      b.innerHTML = `<i class="dot"></i><span>${A.name}</span>`;
      b.onclick = () => { const inp = this.$('aInput'); inp.value = id === 'core' ? '' : `@${id} `; this.$('aether').classList.remove('min'); inp.focus(); };
      this.$('aAgents').appendChild(b);
    }
    if (innerWidth <= 820) this.$('aether').classList.add('min');     // phones: AETHER starts as a small core
  }
  showCategory(c) {
    this.activeCat = c;
    for (const [k, b] of Object.entries(this.tabs)) b.classList.toggle('active', k === c);
    this.chips.forEach((b) => { b.hidden = b.dataset.cat !== c; });
  }

  guideItems(machine) {
    return [
      ['snap', '🫰', '<b>Snap</b> — summon particles / dissolve'],
      ['fist', '✊', machine ? '<b>Fist</b> — put it together' : '<b>Fist</b> — form the wonder'],
      ['open', '✋', machine ? '<b>Open slowly</b> — explode it, see inside' : '<b>Open hand</b> — morph to the next wonder'],
      ['twist', '🔄', '<b>Twist / raise hand</b> — rotate & tilt it'],
      ...(machine ? [['point', '☝', '<b>Point</b> at a part to learn it · <b>pinch</b> 🤏 pulls it out']] : []),
      ['zoom', '🙌', '<b>Two hands</b> apart / together — zoom'],
      ['peace', '✌', '<b>Peace</b> — jump to the next model'],
      ['repulsor', '🖐', '<b>Push your palm</b> at the camera — repulsor blast'],
    ];
  }

  toast(msg) {
    const el = this.$('toast');
    el.textContent = msg; el.classList.add('show');
    clearTimeout(this._toastT); this._toastT = setTimeout(() => el.classList.remove('show'), 2200);
  }

  updateHud(t, formT) {
    const st = this.ctl.state, def = CATALOG[st.index], $ = this.$, ctl = this.ctl;
    const isM = isMachine(st.index);
    const now = new Date(), ck = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    if (ck !== this.clockKey) {                                          // Stark HUD readouts, once a second
      this.clockKey = ck;
      $('clock').textContent = ck;
      $('date').textContent = now.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }).toUpperCase();
      const b = this.battery, cells = [
        ['PWR', b ? `${Math.round(b.level * 100)}%${b.charging ? '⚡' : ''}` : 'ARC'], ['NET', navigator.onLine ? 'ONLINE' : 'OFFLINE'],
        ['CPU', `${navigator.hardwareConcurrency || '?'} CORES`], ['AI', this.aether.online ? 'ONLINE' : 'LOCAL'],
      ];
      $('sysrow').innerHTML = cells.map(([k, v]) => `<span><i>${k}</i>${v}</span>`).join('');
    }
    if (this.lastIndexShown !== st.index) {
      this.lastIndexShown = st.index;
      $('cat').textContent = def.category; $('name').textContent = def.name; $('fact').textContent = def.fact || '';
      $('bigTitle').querySelector('.t').textContent = def.name; $('bigTitle').querySelector('.s').textContent = def.fact || '';
      $('explodeBox').hidden = !isM;
      this.chips.forEach((c, i) => c.classList.toggle('active', i === st.index));
      if (this.activeCat !== def.category) this.showCategory(def.category);
      this.guideKey = null;
    }
    const pill = $('statePill');
    if (pill.dataset.state !== st.state) { pill.dataset.state = st.state; pill.textContent = st.state; }
    const vis = ctl.handVisible(t), pose = vis ? (ctl.pinch ? 'pinch' : ctl.pose) : NONE;
    const [emo, label] = pose === 'pinch' ? ['🤏', 'Pinch'] : POSE_UI[pose] || POSE_UI.other;
    const pt = `${emo} ${label}${ctl.secondVisible(t) ? ' + 🖐' : ''}`;
    if ($('posePill').textContent !== pt) $('posePill').textContent = pt;
    const op = vis ? ctl.openness : 0;
    $('openBar').style.width = `${Math.round(op * 100)}%`; $('openPct').textContent = `${Math.round(op * 100)}%`;
    $('explodePct').textContent = `${Math.round(this.explode * 100)}%`;
    if (!this.sliderActive) $('explodeSlider').value = Math.round(this.explode * 100);
    const hot = st.state === IDLE || st.state === DISSOLVE ? 'snap' : st.state === SPHERE ? 'fist' : 'open';
    const gk = `${isM}|${hot}`;
    if (this.guideKey !== gk) {
      this.guideKey = gk;
      $('guide').innerHTML = this.guideItems(isM).map(([k, e, txt]) => `<li class="${k === hot || (['peace', 'twist', 'point'].includes(k) && st.state === FORMED) ? 'hot' : ''}"><span class="e">${e}</span><span>${txt}</span></li>`).join('');
    }
    $('bigTitle').classList.toggle('show', st.state === FORMED && formT > 0.8 && this.uploaded === st.index && this.explode < 0.15 && this.sel < 0 && !this.orbit && this.t - this.viewT > 2.5 && !this.quiz);
    // part card
    const card = $('partCard'), L = this.sel >= 0 && this.model?.labels[this.sel];
    card.hidden = !(L && st.state === FORMED && !this.quiz);
    if (L && card.dataset.key !== `${st.index}:${this.sel}`) {
      card.dataset.key = `${st.index}:${this.sel}`;
      card.querySelector('.swatch').style.background = rgbCss(L.color);
      card.querySelector('.pname').textContent = L.label;
      card.querySelector('.pinfo').textContent = L.info;
      card.querySelector('.pmodel').textContent = `${def.name} · part ${this.sel + 1} of ${this.model.labels.length}`;
    }
    card.classList.toggle('pulled', this.pulled);
    // quiz banner
    const qb = $('quiz'), q = this.quiz;
    qb.hidden = !q;
    if (q) {
      const target = q.target >= 0 && this.model?.labels[q.target];
      qb.querySelector('.q').textContent = q.done ? '🎓 Quiz finished' : target ? `🎓 Find: ${target.label}` : '🎓 Get ready…';
      qb.querySelector('.qs').textContent = `question ${Math.max(q.asked, 1)} / ${q.total} · score ${q.score}`;
      qb.querySelector('.qf').textContent = q.feedback || 'point at it with one finger (or click it)';
      qb.classList.toggle('good', q.feedback.startsWith('✅') || q.done);
      qb.classList.toggle('bad', q.feedback.startsWith('❌'));
    }
    const cam = this.cam?.running ? `cam <b>${this.cam.fps.toFixed(0)}</b> fps · hands ${this.cam.delegate} ${this.cam.detectMs.toFixed(0)} ms` : 'camera off';
    const extra = [Math.abs(this.zoom - 1) > 0.02 ? `zoom <b>${this.zoom.toFixed(2)}×</b>` : '', this.recorder.on ? `<span class="rec">● REC ${this.recorder.seconds().toFixed(0)} s</span>` : '', this.voiceOn ? '🎤 listening' : ''].filter(Boolean).join(' · ');
    $('stats').innerHTML = `<b>${this.fps.toFixed(0)}</b> fps · <b>${(CFG.n / 1000).toFixed(0)}k</b> particles<br>${cam}${extra ? '<br>' + extra : ''}`;
    for (const e of st.events.splice(0)) {
      const name = CATALOG[st.index].name;
      if (e === 'snap') this.toast('🫰 Snap! Particles summoned');
      else if (e === 'form') this.toast(isM ? `✊ Assembling: ${name}` : `✊ Forming ${name}`);
      else if (e === 'next') this.toast(`✌ Next: ${name}`);
      else if (e === 'select') this.toast(`→ ${name}`);
      else if (e === 'dissolve') this.toast('💥 Dissolved');
    }
  }

  // ------------------------------------------------------------ input
  selectModel(i, autoForm = true) {
    const n = CATALOG.length;
    i = ((i % n) + n) % n;
    this.stopDemo();
    this.ctl.state.select(i, this.t);
    this.store.request(i);
    this.autoFormAt = autoForm ? this.t + 1.0 : null;
  }

  bindInput() {
    const $ = this.$, ctl = this.ctl;
    const now = () => this.t;
    addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLInputElement && e.target.type !== 'range') return;
      const k = e.key.toLowerCase(), st = ctl.state;
      if (k !== 'd') this.stopDemo();
      if (k === ' ') { e.preventDefault(); ctl.keySnap(now()); }
      else if (k === 'f') ctl.keyPose(FIST, now());
      else if (k === 'o') ctl.keyPose(OPEN, now());
      else if (k === 'v') ctl.keyPose(PEACE, now());
      else if (k === 'arrowright' || k === 'n') this.selectModel(st.index + 1);
      else if (k === 'arrowleft' || k === 'p') this.selectModel(st.index - 1);
      else if (k === 'e') this.manualExplode = this.manualExplode > 0.5 ? 0 : 1;
      else if (k === 'arrowup' || k === ']') { e.preventDefault(); this.manualExplode = clamp(this.manualExplode + 0.1, 0, 1); }
      else if (k === 'arrowdown' || k === '[') { e.preventDefault(); this.manualExplode = clamp(this.manualExplode - 0.1, 0, 1); }
      else if (k === '+' || k === '=') this.zoomTarget = clamp(this.zoomTarget * 1.15, 0.5, 2.6);
      else if (k === '-' || k === '_') this.zoomTarget = clamp(this.zoomTarget / 1.15, 0.5, 2.6);
      else if (k === '0') this.zoomTarget = 1;
      else if (k === 'x') this.toggleCut();
      else if (k === ',') this.cut.target = clamp(this.cut.target - 0.1, -1.25, 1.25);
      else if (k === '.') this.cut.target = clamp(this.cut.target + 0.1, -1.25, 1.25);
      else if (k === 'q') { if (this.quiz) this.stopQuiz(); else this.startQuiz(); }
      else if (k === 'm') this.toggleVoice();
      else if (k === 'k') this.toggleRecord();
      else if (k === 'i') this.voiceCommand('what is this');
      else if (k === 'escape') { if (this.quiz) this.stopQuiz(); this.deselect(); }
      else if (k === 'r') this.toggle('autoRotate', 'bRotate');
      else if (k === 'g') { this.toggle('handRotate', 'bHandRot'); this.toast(`🔄 Hand rotation ${this.handRotate ? 'on' : 'off'}`); }
      else if (k === 'l') this.toggle('labelsOn', 'bLabels');
      else if (k === 't') this.trails = !this.trails;
      else if (k === 'c') this.toggleCamera();
      else if (k === 'd') this.toggleDemo();
      else if (k === 'y') this.toggleOrbit();
      else if (k === 'h' || k === '?') $('help').hidden = !$('help').hidden;
      else if (k === 'j') { e.preventDefault(); $('aether').classList.remove('min'); $('aInput').focus(); }
    });
    // AETHER console: type (or 🎤 talk) to it
    $('aForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const text = $('aInput').value.trim();
      if (!text) return;
      $('aInput').value = '';
      this.aether.hear(stripWake(text).rest);
    });
    $('aInput').addEventListener('keydown', (e) => { if (e.key === 'Escape') e.target.blur(); });
    $('aMic').onclick = () => this.toggleVoice();
    $('aMin').onclick = () => $('aether').classList.toggle('min');
    $('aOrb').onclick = () => $('aether').classList.toggle('min');
    $('bSnap').onclick = () => { this.stopDemo(); ctl.keySnap(now()); };
    $('bForm').onclick = () => { this.stopDemo(); ctl.keyPose(FIST, now()); };
    $('bOpen').onclick = () => {
      this.stopDemo();
      if (isMachine(ctl.state.index) && ctl.state.state === FORMED) this.manualExplode = this.manualExplode > 0.5 ? 0 : 1;
      else ctl.keyPose(OPEN, now());
    };
    $('bNext').onclick = () => { this.stopDemo(); ctl.keyPose(PEACE, now()); };
    $('bLabels').onclick = () => this.toggle('labelsOn', 'bLabels');
    $('bRotate').onclick = () => this.toggle('autoRotate', 'bRotate');
    $('bHandRot').onclick = () => this.toggle('handRotate', 'bHandRot');
    $('bCam').onclick = () => this.toggleCamera();
    $('bDemo').onclick = () => this.toggleDemo();
    $('b360').onclick = () => this.toggleOrbit();
    this.canvas.addEventListener('dblclick', () => this.resetView());
    $('bCut').onclick = () => this.toggleCut();
    $('bQuiz').onclick = () => { if (this.quiz) this.stopQuiz(); else this.startQuiz(); };
    $('bVoice').onclick = () => this.toggleVoice();
    $('bRec').onclick = () => this.toggleRecord();
    $('bHelp').onclick = () => { $('help').hidden = !$('help').hidden; };
    $('partClose').onclick = () => this.deselect();
    $('partPull').onclick = () => { if (this.sel >= 0) this.pulled = !this.pulled; };
    $('partSpeak').onclick = () => { const L = this.model?.labels[this.sel]; if (L) { this.spoken.push(`${L.label}. ${L.info}.`); speak(`${L.label}. ${L.info}.`); } };
    $('quizStop').onclick = () => this.stopQuiz();
    const slider = $('explodeSlider');
    slider.addEventListener('input', () => { this.sliderActive = true; this.manualExplode = slider.value / 100; });
    slider.addEventListener('change', () => { this.sliderActive = false; });
    this.canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (e.ctrlKey || !isMachine(ctl.state.index)) this.zoomTarget = clamp(this.zoomTarget * (e.deltaY < 0 ? 1.1 : 1 / 1.1), 0.5, 2.6);
      else this.manualExplode = clamp(this.manualExplode - Math.sign(e.deltaY) * 0.08, 0, 1);
    }, { passive: false });
    let drag = null;
    const px = (e) => [e.clientX * CFG.dpr, e.clientY * CFG.dpr];
    this.canvas.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, y: e.clientY, yaw: this.dragYaw, pitch: this.dragPitch, moved: false }; this.canvas.setPointerCapture(e.pointerId); });
    this.canvas.addEventListener('pointermove', (e) => {
      if (drag) {                                                     // 360 view: left/right = yaw, up/down = pitch, no limits
        if (Math.abs(e.clientX - drag.x) > 4 || Math.abs(e.clientY - drag.y) > 4) drag.moved = true;
        this.dragYaw = drag.yaw + (e.clientX - drag.x) * 0.008;
        if (drag.moved) { this.dragPitch = wrapPi(drag.pitch + (e.clientY - drag.y) * 0.008); this.viewT = this.t; }
      }
      else if (this.cut.on && !this.ctl.handVisible(this.t)) {
        const c0 = project(this.projView, [0, 0, 0]), rr = this.globeRadiusPx();
        this.cut.target = clamp((px(e)[0] - (c0[0] * 0.5 + 0.5) * this.overlay.width) / rr, -1.25, 1.25);
      }
    });
    this.canvas.addEventListener('pointerup', (e) => {
      if (drag && !drag.moved && this.anchors.length) {             // click = pick the nearest part
        const [x, y] = px(e), li = this.nearestAnchor(x, y, 70 * CFG.dpr);
        if (li >= 0) this.selectPart(li, 'click'); else if (!this.quiz) this.deselect();
      }
      drag = null;
    });
  }

  toggleOrbit() { this.orbit = !this.orbit; this.$('b360').classList.toggle('on', this.orbit); this.toast(this.orbit ? '🌐 360° orbit: every side, top and bottom (Y)' : '🌐 360° orbit off · drag to look around, double-click to reset'); }
  resetView() { this.dragYaw = 0; this.dragPitch = 0; this.turn = 0; this.turnPitch = 0; this.orbit = false; this.$('b360').classList.remove('on'); this.toast('🌐 View reset'); }
  toggle(prop, btn) { this[prop] = !this[prop]; this.$(btn).classList.toggle('on', this[prop]); }

  async startCamera() {
    const msg = this.$('startMsg');
    try {
      this.cam = this.cam || new HandCamera(this.video);
      await this.cam.start((s) => { msg.textContent = s; if (s) this.toast(s); });
      this.camOn = true; this.$('bCam').classList.add('on');
      this.toast('📷 Camera on — snap your fingers!');
      return true;
    } catch (e) {
      console.error(e);
      const text = e.name === 'NotAllowedError' ? 'Camera permission was denied — you can still use the keyboard, mouse and demo.'
        : e.name === 'NotFoundError' ? 'No camera found — you can still use the keyboard, mouse and demo.' : `Camera error: ${e.message}`;
      msg.textContent = text; this.toast(text);
      this.cam?.stop(); this.cam = null; this.camOn = false;
      return false;
    }
  }
  stopCamera() { this.cam?.stop(); this.cam = null; this.camOn = false; this.hasVideo = false; this.$('bCam').classList.remove('on'); this.toast('Camera off'); }
  toggleCamera() { if (this.camOn) this.stopCamera(); else this.startCamera(); }

  toggleDemo() { if (this.demo) this.stopDemo(); else { this.demo = new Demo(this); this.$('bDemo').classList.add('on'); this.toast('▶ Demo — synthetic hand'); } }
  stopDemo() { if (!this.demo) return; this.demo = null; this.demoHand = undefined; this.$('bDemo').classList.remove('on'); this.ctl.onHands([], this.t); }

  // ------------------------------------------------------------ deterministic stepping (tests)
  setHand(h, h2) {
    if (h !== undefined) this.handSource = h === null ? () => null : typeof h === 'function' ? h : () => h;
    this.handSource2 = h2 ? (typeof h2 === 'function' ? h2 : () => h2) : null;
    this.lastSynthT = -1;
  }
  async advance(seconds, hand, hand2) {
    this.setHand(hand, hand2);
    const steps = Math.max(1, Math.round(seconds * 60));
    for (let i = 0; i < steps; i++) {
      const st = this.ctl.state;
      if (st.targetDirty && !this.store.get(st.index)) await this.store.request(st.index);
      this.frame(this.t + 1 / 60);
    }
  }
}

// ---------------------------------------------------------------- boot
function boot() {
  let app;
  try { app = new App(); }
  catch (e) {
    console.error(e);
    document.getElementById('startMsg').textContent = `Cannot start: ${e.message}`;
    document.getElementById('bStartCam').disabled = true; document.getElementById('bStartNoCam').disabled = true;
    return;
  }
  const start = document.getElementById('start');
  const hideStart = () => { start.hidden = true; };
  const online = () => { sfx('boot'); app.aether.connect().then(() => app.aether.say(app.aether.greet())); };
  document.getElementById('bStartCam').onclick = async () => { if (await app.startCamera()) { hideStart(); online(); } };
  document.getElementById('bStartNoCam').onclick = () => { hideStart(); online(); app.toast('Keyboard: Space = snap · F = fist · J = talk to AETHER · D = demo · H = help'); };
  if (CFG.autostart === 'camera') { hideStart(); app.startCamera(); }
  else if (CFG.autostart === 'nocamera' || CFG.manual) hideStart();

  window.aether = {
    app, CATALOG, CFG, synth: synthHand,
    ready: () => app.store.request(app.ctl.state.index),
    advance: (s, hand, hand2) => app.advance(s, hand, hand2),
    clearHand: () => { app.handSource = null; app.handSource2 = null; },
    select: (i, autoForm = false) => app.selectModel(i, autoForm),
    voice: (text) => app.voiceCommand(text),
    ask: (text) => app.aether.hear(text),
    tool: (name, args) => app.aetherTool(name, args),
    /** Screen position (CSS px) of a labelled part, or null. */
    anchor: (label) => { const a = app.anchors.find((q) => q.L.label === label); return a ? { x: a.px / CFG.dpr, y: a.py / CFG.dpr } : null; },
    /** Synthetic-hand params that put a pointing index fingertip at CSS pixel (x, y). */
    pointAt: (x, y, s = 0.085) => { const [nx, ny] = app.toNorm([x * CFG.dpr, y * CFG.dpr]); return { cx: nx + 0.35 * s, cy: ny + 1.1 * s, s }; },
    status: () => {
      const st = app.ctl.state, L = app.model?.labels || [], q = app.quiz;
      return {
        state: st.state, index: st.index, name: CATALOG[st.index].name, kind: CATALOG[st.index].kind, category: CATALOG[st.index].category, uploaded: app.uploaded,
        pose: app.ctl.pose, rawPose: app.ctl.rawPose, pinch: app.ctl.pinch, openness: app.ctl.openness, explode: app.explode, scale: app.scale,
        yaw: app.spin + app.dragYaw, pitch: app.pitch, viewPitch: app.dragPitch, orbit: app.orbit, handRotating: app.handRotating, roll: app.ctl.roll,
        zoom: app.zoom, twoHands: app.ctl.secondVisible(app.t), pulse: app.pulse, flow: app.flow,
        selected: app.sel >= 0 ? L[app.sel]?.label : null, pulled: app.pulled, pullAmt: app.pullAmt, pointing: !!app.pointer,
        cut: { ...app.cut }, labels: L.length, anchors: app.anchors.length, activeCat: app.activeCat,
        quiz: q ? { target: q.target >= 0 ? L[q.target]?.label : null, score: q.score, asked: q.asked, total: q.total, phase: q.phase, done: q.done, feedback: q.feedback } : null,
        voice: { on: app.voiceOn, supported: app.voice.supported, heard: app.lastHeard }, spoken: app.spoken.slice(-3), spokenCount: app.spoken.length,
        recording: app.recorder.on, lastRecording: app.lastRecording,
        aether: { online: app.aether.online, busy: app.aether.busy, model: app.aether.model, log: app.aether.log.slice(-4), address: app.aether.address,
          agents: Object.fromEntries(Object.entries(app.aether.agents).map(([k, A]) => [k, { state: A.state, runs: A.runs }])),
          tasks: app.aether.tasks.map((T) => ({ agent: T.agent, state: T.state, steps: T.steps.map((s) => s.label), reply: T.reply })) },
        tintMix: app.tintMix, alpha: st.alpha(app.t), t: app.t, fps: app.fps, n: CFG.n, frames: app.frames,
        modelErrors: app.store.errors.length, gl: app.renderer.info,
        camera: app.cam ? { running: app.cam.running, fps: app.cam.fps, frames: app.cam.frames, delegate: app.cam.delegate, detectMs: app.cam.detectMs, videoW: app.video.videoWidth, videoH: app.video.videoHeight } : null,
      };
    },
    /** Particle stats over the whole cloud: mean/max radius and bounding box (model space). */
    cloud: () => {
      const d = app.renderer.readParticles(CFG.n);
      let sum = 0, max = 0, finite = true, speed = 0;
      const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < CFG.n; i++) {
        const x = d[i * 6], y = d[i * 6 + 1], z = d[i * 6 + 2];
        if (!Number.isFinite(x + y + z)) finite = false;
        const r = Math.hypot(x, y, z); sum += r; max = Math.max(max, r);
        speed += Math.hypot(d[i * 6 + 3], d[i * 6 + 4], d[i * 6 + 5]);
        lo[0] = Math.min(lo[0], x); lo[1] = Math.min(lo[1], y); lo[2] = Math.min(lo[2], z);
        hi[0] = Math.max(hi[0], x); hi[1] = Math.max(hi[1], y); hi[2] = Math.max(hi[2], z);
      }
      return { meanR: sum / CFG.n, maxR: max, lo, hi, finite, meanSpeed: speed / CFG.n };
    },
  };
  if (!CFG.manual) {
    const loop = (ms) => { app.frame(ms / 1000); requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
  }
}
boot();
