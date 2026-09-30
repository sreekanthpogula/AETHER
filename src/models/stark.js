// Stark Industries: arc reactor, Mark III helmet and repulsor gauntlet. Explodable like the machines, every part
// labelled with what it does. Film-accurate in spirit, not in blueprint: proportions are sized to a real head / hand.
import { line, box, revolve, disc, torus, helix, tube, paramSurface, TAU } from '../lib/sampling.js';
import { mul, linspace } from '../lib/vec.js';
import { blob, vessel, dots } from '../lib/shapes.js';
import { G } from './engines.js';

const X = [1, 0, 0], Y = [0, 1, 0], Z = [0, 0, 1];
const RED = [0.95, 0.18, 0.14], GOLD = [1.0, 0.76, 0.24], GLOW = [0.55, 0.92, 1.0], CORE = [0.85, 0.97, 1.0];
const COPPER = [1.0, 0.52, 0.22], TITAN = [0.62, 0.68, 0.8];

// ============================================================ ARC REACTOR (mm, faces +z)
function arcReactor() {
  const coils = [];
  for (let k = 0; k < 10; k++) {
    const a = (k / 10) * TAU, dir = [Math.cos(a), Math.sin(a), 0];
    coils.push(helix(mul(dir, 14), 2.8, 12, 9, dir, 1.6), tube(mul(dir, 14), mul(dir, 26), 1.6, 1.6, 0.8));
  }
  const fins = [];
  for (let k = 0; k < 24; k++) {
    const a = (k / 24) * TAU, c = Math.cos(a), s = Math.sin(a);
    fins.push(line([8 * c, 8 * s, -6.5], [28 * c, 28 * s, -6.5], 0.25, 2));
  }
  const conduits = [0, 1, 2].map((k) => {
    const a = (k / 3) * TAU + Math.PI / 2, c = Math.cos(a), s = Math.sin(a);
    return vessel([[6 * c, 6 * s, -6], [10 * c, 10 * s, -14], [14 * c, 14 * s, -24]], 1.6, 1.2, 2);
  });
  const lens = paramSurface((u, v) => [27 * Math.cos(v) * Math.cos(u), 27 * Math.cos(v) * Math.sin(u), 4.5 + 5 * Math.sin(v)], 0, TAU, 0, Math.PI / 2, { density: 0.35 });
  return [
    G('Glass lens', GLOW, [0, 0, 44], 0, lens, { info: 'sealed cover that lets the blue glow shine out' }),
    G('Palladium core', CORE, [0, 0, 30], 0.08, [disc([0, 0, 2], 0, 6, Z, 4), torus([0, 0, 2.5], 6.5, 0.8, Z, 3)], { info: 'the power source: about 3 gigajoules every second' }),
    G('Containment ring', GLOW, [0, 0, 17], 0.12, [torus([0, 0, 1], 12, 1.4, Z, 1.5), disc([0, 0, 1], 9, 12, Z, 1)], { info: 'magnetic ring that holds the plasma around the core' }),
    G('Copper coil windings', COPPER, [0, 0, 4], 0.15, coils, { info: 'ten electromagnets that shape the energy field' }),
    G('Titanium casing', TITAN, [0, 0, -12], 0.1, [tube([0, 0, -4], [0, 0, 4], 30, 30, 0.6), torus([0, 0, 4], 29, 1.2, Z, 1), torus([0, 0, -4], 29, 1.2, Z, 1)], { info: 'shields the reactor and locks it into the chest' }),
    G('Heat-sink back plate', [0.45, 0.55, 0.75], [0, 0, -28], 0.15, [disc([0, 0, -6], 0, 30, Z, 0.4), fins], { info: 'draws heat away from the core through 24 fins' }),
    G('Power conduits', GOLD, [0, 0, -46], 0.2, conduits, { info: 'carry power to the suit and the electromagnet in the chest' }),
  ];
}

// ============================================================ MARK III HELMET (cm, y up, face +z)
const HEAD = [10, 13, 11.5], V0 = -1.15;                       // ellipsoid radii; v0 leaves the neck open
const eyeY = (x) => 2.2 + 0.28 * (Math.abs(x) - 3.6);          // slits slant up toward the temples
const inEye = (x, y) => Math.abs(Math.abs(x) - 3.6) < 1.9 && Math.abs(y - eyeY(x)) < 0.55;
const inMouth = (x, y) => Math.abs(y + 6.4) < 0.28 && Math.abs(x) < 3.2;
const isCheek = (x, y, z) => Math.abs(x) > 7.2 && y < 3 && z > -3;
const isFace = (x, y, z) => z > 3.5 && y < 8 && !isCheek(x, y, z);
const chin = (u, v) => 1 - 0.12 * Math.max(0, -Math.sin(v)) * Math.max(0, Math.sin(u));   // narrower jaw at the front
const shell = (keep, density = 1) => blob([0, 0, 0], HEAD, { bump: chin, keep, density, v0: V0, gu: 48, gv: 32 });
const surfZ = (x, y) => HEAD[2] * Math.sqrt(Math.max(0, 1 - (x / HEAD[0]) ** 2 - (y / HEAD[1]) ** 2));

function helmet() {
  const slit = [];
  for (const sx of [-1, 1]) for (const s of linspace(-1.8, 1.8, 24)) { const x = sx * (3.6 + s); slit.push([x, eyeY(x), surfZ(x, eyeY(x)) - 0.35]); }
  const hud = paramSurface((u, v) => [8 * Math.sin(u), 1.5 + 2.6 * v, 8.2 * Math.cos(u)], -0.8, 0.8, -1, 1, { density: 0.8, gu: 20, gv: 8 });
  const grid = linspace(-0.8, 0.8, 7).map((u) => line([8 * Math.sin(u), -1.1, 8.2 * Math.cos(u)], [8 * Math.sin(u), 4.1, 8.2 * Math.cos(u)], 0, 3));
  const cheek = (s) => shell((x, y, z) => s * x > 0 && isCheek(x, y, z), 1.4);
  const audio = (s) => [disc([s * 9.7, 0.5, 0.5], 0.3, 1.9, X, 4), torus([s * 9.8, 0.5, 0.5], 2.1, 0.25, X, 4)];
  return [
    G('Faceplate', GOLD, [0, 7, 14], 0, shell((x, y, z) => isFace(x, y, z) && !inEye(x, y) && !inMouth(x, y), 1.5), { info: 'gold-titanium mask that hinges up to open the helmet' }),
    G('Eye slits', GLOW, [0, 8, 19], 0, dots(slit, 0.12, 14), { info: 'glowing eye displays the pilot looks through' }),
    G('HUD display', [0.35, 0.85, 1.0], [0, 1, 7], 0.25, [hud, grid], { info: 'heads-up display: targeting, flight data and J.A.R.V.I.S.' }),
    G('Helmet shell', RED, [0, 3, -11], 0.05, shell((x, y, z) => !isFace(x, y, z) && !isCheek(x, y, z)), { info: 'gold-titanium alloy skull shell' }),
    G('Cheek plate', RED, [10, -1, 3], 0.1, cheek(1), { info: 'side armour that seals around the jaw' }),
    G('Cheek plate (L)', RED, [-10, -1, 3], 0.1, cheek(-1), { showLabel: false }),
    G('Audio & comms', GOLD, [15, 1, 0], 0.2, audio(1), { info: 'speakers and microphones: J.A.R.V.I.S. talks to you here' }),
    G('Audio & comms (L)', GOLD, [-15, 1, 0], 0.2, audio(-1), { showLabel: false }),
    G('Onboard computer', GLOW, [0, 5, -4], 0.3, box([0, 4, -6], [5, 3, 2.5], 0.7, 3), { info: 'processor that links the suit to J.A.R.V.I.S.' }),
    G('Neck seal', TITAN, [0, -9, 0], 0.1, [torus([0, -12, 0.3], 4.6, 0.7, Y, 2), torus([0, -13.2, 0.3], 4.3, 0.4, Y, 2)], { info: 'pressure seal that locks the helmet to the suit' }),
  ];
}

// ============================================================ REPULSOR GAUNTLET (cm, fingers up, palm faces +z)
function gauntlet() {
  const FX = [-3.3, -1.1, 1.1, 3.3], FL = [[3.2, 2.2, 1.8], [3.8, 2.6, 2.0], [3.6, 2.4, 1.9], [2.8, 1.9, 1.6]];
  const fingers = [], knuckles = [];
  FX.forEach((x, i) => {
    let y = 10.2;
    for (const [j, L] of FL[i].entries()) { const r = 0.85 - 0.12 * j; fingers.push(tube([x, y, 0], [x, y + L, 0.25 * j], r, r * 0.92, 3)); y += L + 0.25; }
    knuckles.push(box([x, 10, 0.9], [1.9, 1.1, 2.6], 0.7, 3));
  });
  const thumb = [tube([4.4, 2.8, 0.6], [6.2, 6.0, 1.4], 1.0, 0.95, 3), tube([6.3, 6.3, 1.5], [7.1, 8.8, 2.0], 0.9, 0.85, 3), tube([7.2, 9.1, 2.0], [7.6, 10.9, 2.3], 0.8, 0.75, 3)];
  const bracer = [revolve([-22, -1], [3.5, 4.4], { center: [0, 0, 0], sz: 0.82, density: 0.9 }),
    ...linspace(0, TAU, 9).slice(0, 8).map((a) => line([3.6 * Math.cos(a), -21, 3.0 * Math.sin(a)], [4.45 * Math.cos(a), -1.5, 3.65 * Math.sin(a)], 0.05, 2))];
  const conduits = [-1.4, 1.4].map((x) => vessel([[x, -20, 3.2], [x, -11, 3.9], [x, -1.5, 3.9], [x * 0.6, 3, 1.9]], 0.32, 0.32, 3));
  const flap = (s) => [box([s * 4.2, -12, -0.4], [0.5, 9, 3.2], 1.5, 3)];
  return [
    G('Repulsor emitter', GLOW, [0, 0, 10], 0, [disc([0, 5, 1.65], 0, 2, Z, 5), torus([0, 5, 1.65], 2.3, 0.35, Z, 5)], { info: 'fires a focused energy beam, and gives thrust for flight' }),
    G('Hand plates', RED, [0, 2, -3], 0.1, box([0, 5, 0], [9, 9.4, 3], 1.1, 3), { info: 'palm and back armour around the emitter' }),
    G('Fingers', GOLD, [0, 9, 0], 0.15, fingers, { info: 'articulated plates with three joints per finger' }),
    G('Knuckle guards', RED, [0, 6, 5], 0.15, knuckles, { info: 'layered plates that protect a punch' }),
    G('Thumb', GOLD, [7, 4, 0], 0.15, thumb, { info: 'opposable armoured thumb for gripping' }),
    G('Wrist joint', GOLD, [0, -3, 0], 0.1, [torus([0, 0, 0], 4.3, 0.7, Y, 2), torus([0, 0.9, 0], 4.1, 0.4, Y, 2)], { info: 'sealed rotating ring for full wrist movement' }),
    G('Forearm bracer', RED, [0, -11, -2], 0.05, bracer, { info: 'armoured sleeve that houses the actuators' }),
    G('Power conduits', [0.35, 0.9, 1.0], [0, -8, 8], 0.2, conduits, { info: 'feed arc-reactor power to the repulsor' }),
    G('Flight stabiliser', TITAN, [8, -10, 0], 0.2, flap(1), { info: 'flaps that deploy to steady the arm in flight' }),
    G('Flight stabiliser (L)', TITAN, [-8, -10, 0], 0.2, flap(-1), { showLabel: false }),
  ];
}

export const STARK = [
  { name: 'Arc Reactor', groups: arcReactor, color: GLOW, tilt: 12, viewYaw: 0.95, fact: '60 mm wide · palladium core · 3 GJ/s' },
  { name: 'Iron Man Helmet', groups: helmet, color: [1.0, 0.4, 0.25], tilt: 8, viewYaw: 0.75, fact: 'Mark III · gold-titanium alloy · HUD by J.A.R.V.I.S.' },
  { name: 'Repulsor Gauntlet', groups: gauntlet, color: [1.0, 0.35, 0.2], tilt: 6, viewYaw: 0.6, fact: 'Mark III · palm repulsor · flight stabilisers' },
];
