// Royal Enfield Classic 350 in Medallion Bronze (cm, x forward, y up, z to the rider's right). Built to the real
// numbers: 2145 mm long, 1390 mm wheelbase, 805 mm seat, 19" front / 18" rear 40-spoke wheels, 349 cc J-series single.
import { line, polyline, box, revolve, cylinder, ring, orient, tube, disc, paramSurface, torus, helix, gear, TAU } from '../lib/sampling.js';
import { add, mul, norm, linspace } from '../lib/vec.js';
import { blob, vessel } from '../lib/shapes.js';
import { G } from './engines.js';

const X = [1, 0, 0], Y = [0, 1, 0], Z = [0, 0, 1];
const BRONZE = [0.86, 0.55, 0.3], CHROME = [0.86, 0.9, 0.98], TYRE = [0.42, 0.42, 0.47], ENGINE = [0.55, 0.58, 0.65];
const SEAT = [0.62, 0.38, 0.22], FRAME = [0.38, 0.43, 0.54], LAMP = [1.0, 0.92, 0.7], CHAIN = [0.95, 0.75, 0.35];
const FX = 69.5, RX = -69.5, AY = 32.5;                        // axles: 1390 mm wheelbase, 650 mm tyres

/** 40-spoke wheel: tyre, chromed rim, hub and crossed spokes laced to both hub flanges. */
function wheel(cx, tyreR) {
  const P = [torus([cx, AY, 0], tyreR - 4.2, 4.2, Z, 0.6), orient(ring([0, 0, 0], 24, { density: 5 }), Z, [cx, AY, 1.8]), orient(ring([0, 0, 0], 24, { density: 5 }), Z, [cx, AY, -1.8]),
    orient(cylinder([0, 0, 0], 4.5, 12, { density: 1.5, cap: true, capBottom: true }), Z, [cx, AY, -6])];
  for (let k = 0; k < 40; k++) {
    const a = (k / 40) * TAU, side = k % 2 ? 5 : -5, b = a + (k % 4 < 2 ? 0.35 : -0.35);
    P.push(line([cx + 4.3 * Math.cos(a), AY + 4.3 * Math.sin(a), side], [cx + 23.6 * Math.cos(b), AY + 23.6 * Math.sin(b), side * 0.2], 0, 2.2));
  }
  return P;
}

function classic350() {
  // fuel tank: 13 L teardrop, tapering to the rear, flat underside on the frame, chrome badges + filler cap
  const tank = [blob([16, 88, 0], [27, 10, 13], { bump: (u) => 1 - 0.2 * Math.max(0, -Math.cos(u)), keep: (x, y) => y > 80.5, density: 2 }),
    ...[-1, 1].flatMap((s) => [disc([14, 89, s * 12.6], 0, 4.5, Z, 3), torus([14, 89, s * 12.7], 4.6, 0.35, Z, 4), blob([2, 86, s * 11.4], [5, 3, 1.2], { density: 2 })]),
    orient(ring([0, 0, 0], 3, { density: 8 }), Y, [22, 97.6, 0])];
  // sprung single saddle + pillion, with the two saddle springs and a grab rail
  const seat = [blob([-20, 83, 0], [15, 3.5, 13], { density: 1.4 }), blob([-50, 81.5, 0], [13, 3, 11], { density: 1.4 }),
    ...[-1, 1].map((s) => helix([-30, 73.5, s * 7], 1.8, 7, 6, Y, 3)), vessel([[-60, 84, -11], [-66, 84.5, 0], [-60, 84, 11]], 0.8, 0.8, 2)];
  // cockpit: swept-back bar, grips, round mirrors, speedo with the Tripper navigation pod
  const bars = [vessel([[37, 104, -36], [40, 103, -18], [42, 101, 0], [40, 103, 18], [37, 104, 36]], 1.1, 1.1, 2),
    ...[-1, 1].flatMap((s) => [tube([37, 104, s * 30], [36, 104.3, s * 40], 1.7, 1.7, 2), line([40, 103, s * 24], [38, 113, s * 27], 0.1, 3), disc([38, 114, s * 27], 0, 5.5, X, 2.5), torus([38, 114, s * 27], 5.6, 0.3, X, 3)]),
    disc([43, 103, 0], 0, 5, norm([-0.4, 1, 0]), 3), torus([43, 103, 0], 5.2, 0.5, norm([-0.4, 1, 0]), 3), disc([43, 103.5, -8], 0, 3, norm([-0.4, 1, 0]), 3)];
  const lamps = [blob([50, 90, 0], [5, 9, 9], { keep: (x) => x > 47, density: 1.4 }), disc([55, 90, 0], 0, 8.5, X, 2.5), torus([55, 90, 0], 8.8, 0.7, X, 3),
    ...[-1, 1].flatMap((s) => [disc([51, 86, s * 12], 0, 2.2, X, 5), torus([51, 86, s * 12], 2.4, 0.3, X, 5), line([46, 88, s * 9], [50, 86.5, s * 11.5], 0.1, 4)])];
  // telescopic fork: 41 mm stanchions raked ~24 degrees, fork covers ("casquette") and yokes
  const fork = [box([42, 99, 0], [7, 2.5, 22], 1.2, 3), box([45, 93, 0], [7, 2.5, 22], 1.2, 3)];
  for (const s of [-1, 1]) fork.push(tube([42, 99, s * 9], [55, 69, s * 9], 2.6, 2.6, 1.3), tube([55, 69, s * 9], [FX, AY, s * 9], 2.1, 2.3, 1.3));
  const brake = [disc([FX, AY, 8], 5, 15, Z, 1.2), torus([FX, AY, 8], 15, 0.5, Z, 3), box([FX - 12, AY + 8, 8], [5, 7, 3.5], 1.2, 3)];
  // engine: crankcase + gearbox, finned barrel leaning slightly forward, head and rocker box, left alternator cover
  const cyl = norm([0.18, 1, 0]), base = [8, 48, 0];
  const engine = [blob([2, 40, 0], [18, 11, 10], { density: 0.9 }), blob([-12, 38, 0], [9, 8, 9], { density: 0.8 }), orient(cylinder([0, 0, 0], 6, 22, { density: 0.8 }), cyl, base),
    orient(box([0, 23, 0], [15, 5, 14], 0.9, 3), cyl, base), disc([4, 40, -10.4], 0, 7, Z, 1.5), torus([4, 40, -10.5], 7, 0.5, Z, 3)];
  for (let k = 1.5; k < 21; k += 2.2) engine.push(orient(disc([0, 0, 0], 6, 9 - 0.04 * k, Y, 1.2), cyl, add(base, mul(cyl, k))));
  const clutch = [disc([-4, 40, 10.5], 0, 8, Z, 2), torus([-4, 40, 10.6], 8.2, 0.6, Z, 3), disc([10, 44, 10.2], 0, 4, Z, 3)];
  const exhaust = [vessel([[16, 60, 3], [23, 47, 7], [16, 29, 11], [-15, 27, 13]], 2.2, 2.2, 1.6),
    tube([-15, 27.5, 13.5], [-92, 40, 14.5], 4.6, 4.0, 0.9), disc([-92, 40, 14.5], 0, 4, norm([-6, 1, 0]), 2)];
  const guard = [];
  for (const s of [-1, 1]) guard.push(vessel([[34, 74, s * 9], [41, 58, s * 19], [40, 42, s * 20], [30, 30, s * 13]], 1.3, 1.3, 2));
  guard.push(tube([40, 50, -19], [40, 50, 19], 1.1, 1.1, 2));
  // twin-downtube cradle frame, rear subframe and swingarm
  const frame = [tube([40, 101, 0], [45, 90, 0], 2.4, 2.4, 1.2), vessel([[42, 96, 0], [10, 86, 0], [-28, 80, 0]], 1.9, 1.9, 1.2)];
  for (const s of [-1, 1]) {
    frame.push(vessel([[43, 90, 0], [36, 62, s * 6], [29, 24, s * 7], [-20, 23, s * 7], [-28, 40, s * 7], [-28, 80, s * 6]], 1.5, 1.5, 1.2),
      vessel([[-28, 80, s * 8], [-60, 78, s * 9], [-86, 75, s * 9]], 1.3, 1.3, 1.2), tube([-28, 44, s * 8], [-60, 78, s * 9], 1.2, 1.2, 1.2), tube([-28, 40, s * 9], [RX, AY, s * 9], 1.9, 1.6, 1.2));
  }
  frame.push(tube([-28, 40, -9], [-28, 40, 9], 1.5, 1.5, 1.2), tube([-45, 37, -9], [-45, 37, 9], 1.2, 1.2, 1.2));
  const shock = (s) => [tube([-42, 45, s * 10.5], [-64, 79, s * 10.5], 1.3, 1.3, 2), helix([-44, 48, s * 10.5], 2.6, 28, 9, norm([-22, 34, 0]), 3),
    torus([-42.5, 45.5, s * 10.5], 2, 0.5, norm([-22, 34, 0]), 3), torus([-63.5, 78, s * 10.5], 2, 0.5, norm([-22, 34, 0]), 3)];
  const panel = (s) => [paramSurface((u, v) => [-32 + 9.5 * v * Math.cos(u), 62 + 8 * v * Math.sin(u), s * 11.5], 0, TAU, 0, 1, { density: 2.6, gu: 24, gv: 4 }),
    orient(ring([0, 0, 0], 1, { sx: 9.6, sz: 8.1, density: 5 }), Z, [-32, 62, s * 11.6])];
  // mudguards: long valanced guards in bronze, stays, round tail lamp and number plate
  const guardArc = (cx, R, a0, a1, w) => paramSurface((a, k) => [cx + R * Math.cos(a), AY + R * Math.sin(a), k * w], a0, a1, -1, 1, { density: 1.6, gu: 28, gv: 5 });
  const skirt = (cx, R, a0, a1, w) => [-1, 1].map((s) => paramSurface((a, k) => [cx + (R - 3.5 * k) * Math.cos(a), AY + (R - 3.5 * k) * Math.sin(a), s * w], a0, a1, 0, 1, { density: 1.6, gu: 28, gv: 3 }));
  const fGuard = [guardArc(FX, 35.5, -0.25, 2.2, 6.5), ...skirt(FX, 35.5, -0.25, 2.2, 6.5), ...[-1, 1].map((s) => line([FX, AY, s * 7], [FX + 25, AY + 24, s * 7], 0.1, 3))];
  const rGuard = [guardArc(RX, 36, 0.75, 3.35, 7.5), ...skirt(RX, 36, 0.75, 3.35, 7.5), blob([-102, 60, 0], [3, 3.5, 4], { density: 3 }), box([-100, 52, 0], [1, 9, 17], 1, 2),
    disc([-104.5, 60, 0], 0, 3, X, 4)];
  const chain = [gear([-6, 36, -9], 4.5, 15, { axis: Z, width: 1.5, density: 2.5 }), gear([RX, AY, -9], 11, 38, { axis: Z, width: 1.5, density: 2 })];
  const loop = [...linspace(-Math.PI / 2, Math.PI / 2, 10).map((a) => [-6 + 5 * Math.cos(a), 36 + 5 * Math.sin(a), -9.8]), ...linspace(Math.PI / 2, 1.5 * Math.PI, 18).map((a) => [RX + 11.6 * Math.cos(a), AY + 11.6 * Math.sin(a), -9.8])];
  chain.push(polyline(loop, 0, 6, true), box([-38, 40, -10.5], [34, 2, 1], 1.2, 3));
  return [
    G('Fuel tank', BRONZE, [5, 45, 0], 0, tank, { info: '13-litre teardrop tank in Medallion Bronze, chrome badges' }),
    G('Sprung saddle & pillion', SEAT, [-12, 34, 0], 0.05, seat, { info: 'sprung single saddle at 805 mm, detachable pillion seat' }),
    G('Handlebar, mirrors & speedo', CHROME, [22, 40, 0], 0.1, bars, { info: 'swept-back bar, round mirrors, speedo with Tripper navigation' }),
    G('Headlamp & pilot lamps', LAMP, [50, 16, 0], 0.05, lamps, { info: 'round headlamp flanked by the two "tiger eye" pilot lamps' }),
    G('Telescopic fork', CHROME, [36, -4, 0], 0.15, [fork, brake], { info: '41 mm fork with 130 mm travel, 300 mm front disc' }),
    G('Front wheel (19 in)', TYRE, [62, -10, 0], 0.15, wheel(FX, 32.5), { info: '40-spoke wheel with a 100/90-19 tyre' }),
    G('Rear wheel (18 in)', TYRE, [-60, -10, 0], 0.15, wheel(RX, 32.5), { info: '40-spoke wheel with a 120/80-18 tyre' }),
    G('Front mudguard', BRONZE, [54, 24, 0], 0.1, fGuard, { info: 'long valanced guard painted to match the tank' }),
    G('Rear mudguard & tail lamp', BRONZE, [-46, 22, 0], 0.1, rGuard, { info: 'deep rear guard carrying the round tail lamp' }),
    G('Engine: 349 cc J-series', ENGINE, [0, -32, 0], 0.2, engine, { info: 'air-oil cooled single: 20.2 hp at 6100 rpm, 27 Nm' }),
    G('Clutch cover', CHROME, [-2, -30, 26], 0.3, clutch, { info: 'polished cover over the wet multi-plate clutch' }),
    G('Peashooter exhaust', CHROME, [-6, -14, 34], 0.15, exhaust, { info: 'chrome silencer that gives the Classic its thump' }),
    G('Crash guard', CHROME, [36, -12, 0], 0.1, guard, { info: 'chrome bar that protects the engine in a tip-over' }),
    G('Frame & swingarm', FRAME, [0, 4, 0], 0, frame, { info: 'steel twin-downtube cradle, the backbone of the bike' }),
    G('Side panels', BRONZE, [-4, 2, 24], 0.2, panel(1), { info: 'battery box and toolbox covers' }),
    G('Side panels (L)', BRONZE, [-4, 2, -24], 0.2, panel(-1), { showLabel: false }),
    G('Twin shocks', CHROME, [-14, 10, 26], 0.25, shock(1), { info: 'gas-charged rear shocks with 6-step preload' }),
    G('Twin shocks (L)', CHROME, [-14, 10, -26], 0.25, shock(-1), { showLabel: false }),
    G('Chain drive', CHAIN, [-16, -20, -30], 0.25, chain, { info: '5-speed gearbox, chain to the rear sprocket' }),
  ];
}

export const ENFIELD = [
  { name: 'Royal Enfield Classic 350', groups: classic350, color: BRONZE, tilt: 10, viewYaw: 0.55, fact: '2145 mm long · 349 cc J-series single · 195 kg · Medallion Bronze' },
];
