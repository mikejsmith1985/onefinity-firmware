// Hands-off bed camera calibration (1.38.0): finding the probe's LED ring in pictures,
// and calibrating from it, against a simulated pinhole camera.
//   node src/react-ui/test/bedcam-led.mjs
import { calibrateLed, calibrate, toMachine, detectLedFlip, detectLedMoved, awayMove, autoSpots, autoTouchProgram, LED_H, LED_R } from "../src/bedcam.js";

let ok = true;
const check = (name, cond, msg = "") => { console.log(`${cond ? "PASS" : "FAIL"} ${name} ${msg}`); ok = ok && !!cond; };
let seed = 11; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

const W = 1280, H = 720, F = 1100;
function camera({ cx = 205, cy = -60, hc = 700, tilt = 0.32, roll = -0.03, yaw = 0.05 }) {
  // In front of the machine, looking down and back at the bed (like Mike's)
  const C = [cx, cy, hc];
  const Rx = (a) => [[1, 0, 0], [0, Math.cos(a), -Math.sin(a)], [0, Math.sin(a), Math.cos(a)]];
  const Ry = (a) => [[Math.cos(a), 0, Math.sin(a)], [0, 1, 0], [-Math.sin(a), 0, Math.cos(a)]];
  const Rz = (a) => [[Math.cos(a), -Math.sin(a), 0], [Math.sin(a), Math.cos(a), 0], [0, 0, 1]];
  const mm = (A, B) => A.map((r) => [0, 1, 2].map((j) => r[0] * B[0][j] + r[1] * B[1][j] + r[2] * B[2][j]));
  const base = [[1, 0, 0], [0, -1, 0], [0, 0, -1]];
  const R = mm(mm(mm(Rz(yaw), Rx(-tilt)), Ry(roll)), base);
  const project = (p) => {
    const d = [p.x - C[0], p.y - C[1], (p.z || 0) - C[2]];
    const c = R.map((r) => r[0] * d[0] + r[1] * d[1] + r[2] * d[2]);
    return { x: W / 2 + (F * c[0]) / c[2], y: H / 2 + (F * c[1]) / c[2] };
  };
  return project;
}
const cam = camera({});
const BED = -112;   // machine Z of the bed

// A picture: MDF, a green tape mark that never moves, and the probe's ring at tip (x, y, zAboveBed)
function picture(probe, color, gain = 1) {
  const data = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    const n = (rnd() - 0.5) * 8;
    data[i * 4] = (160 + n) * gain; data[i * 4 + 1] = (140 + n) * gain; data[i * 4 + 2] = (105 + n) * gain; data[i * 4 + 3] = 255;
  }
  const paint = (px, rgb, r = 2) => {
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      const X = Math.round(px.x + dx), Y = Math.round(px.y + dy);
      if (X < 0 || Y < 0 || X >= W || Y >= H) continue;
      const i = (Y * W + X) * 4; data[i] = rgb[0]; data[i + 1] = rgb[1]; data[i + 2] = rgb[2];
    }
  };
  // Green tape on the bed at machine (330, 60): always there
  for (let a = 0; a < 40; a += 1) for (let b = 0; b < 12; b += 1) paint(cam({ x: 310 + a, y: 55 + b, z: 0 }), [40, 170, 70], 1);
  if (probe) {
    const rgb = color === "red" ? [240, 50, 40] : [50, 235, 90];
    // A dim glow on the bed under it
    if (probe.z < 5) for (let a = 0; a < 360; a += 6) for (const rr of [6, 12, 18]) paint(cam({ x: probe.x + rr * Math.cos(a * Math.PI / 180), y: probe.y + rr * Math.sin(a * Math.PI / 180), z: 0 }), color === "red" ? [190, 120, 95] : [140, 175, 110], 1);
    // The probe body (dark) and the ring, LED_R radius, LED_H above the tip
    for (let h = LED_H + 2; h < LED_H + 22; h += 1) paint(cam({ x: probe.x, y: probe.y, z: probe.z + h }), [30, 30, 32], 6);
    for (let a = 0; a < 360; a += 2) paint(cam({ x: probe.x + LED_R * Math.cos(a * Math.PI / 180), y: probe.y + LED_R * Math.sin(a * Math.PI / 180), z: probe.z + LED_H }), rgb, 2);
  }
  return { width: W, height: H, data };
}
const ringPx = (x, y, z) => cam({ x, y, z: z + LED_H });

// 1. Finding the ring by its colour flip
const red = picture({ x: 120, y: 90, z: 0 }, "red"), green = picture({ x: 120, y: 90, z: 0.35 }, "green", 1.03);
const d = detectLedFlip(red, green), truth = ringPx(120, 90, 0.2);
check("ring found from the red/green flip", !!d, d ? `at ${d.x.toFixed(1)},${d.y.toFixed(1)}` : "");
check("found within 1.5 px of the ring's centre", d && Math.hypot(d.x - truth.x, d.y - truth.y) < 1.5, d ? `${Math.hypot(d.x - truth.x, d.y - truth.y).toFixed(2)} px off` : "");
check("not fooled by green tape that doesn't change", !detectLedFlip(picture(null), picture(null, null, 1.02)));
// Lifted 60 mm: the newly green spot
const up = picture({ x: 120, y: 90, z: 60.35 }, "green"), away = picture({ x: 200, y: 90, z: 60.35 }, "green");
const u = detectLedMoved(away, up, d, 400), utruth = ringPx(120, 90, 60.35);
check("lifted ring found as the newly green spot", u && Math.hypot(u.x - utruth.x, u.y - utruth.y) < 1.5, u ? `${Math.hypot(u.x - utruth.x, u.y - utruth.y).toFixed(2)} px off` : "none");

// 2. Calibration from what the camera finds at the automatic spots
const lim = { x0: 0, x1: 410, y0: 0, y1: 410 };
const setter = { x: 374.5, y: 374.8, r: 33.2 };
const grid = autoSpots(lim, setter), spots = grid.slice(0, 6); // calibrating stops at 6 the camera saw
check("9 candidate spots, none near the setter", grid.length === 9 && grid.every((s) => Math.abs(s.x - setter.x) >= 58 || Math.abs(s.y - setter.y) >= 58), JSON.stringify(grid));
function run(ledHGuess, jitterZ = 0.05) {
  const points = [];
  spots.forEach((s, i) => {
    const z = (rnd() - 0.5) * jitterZ;  // bed not quite flat
    const R = picture({ ...s, z }, "red"), G = picture({ ...s, z: z + 0.35 }, "green");
    const f = detectLedFlip(R, G);
    if (!f) return;
    const p = { m: { x: s.x, y: s.y, z: BED + z }, px: { x: f.x, y: f.y } };
    if (i === 0 || i === 3) {
      const Ug = picture({ ...s, z: z + 60.35 }, "green"), Vg = picture({ ...s, x: s.x + awayMove(s, lim), z: z + 60.35 }, "green");
      const g = detectLedMoved(Vg, Ug, f, 400);
      if (g) p.up = { x: g.x, y: g.y, dz: 60 };
    }
    points.push(p);
  });
  return { points, cal: calibrateLed(points, { w: W, h: H }, ledHGuess) };
}
const { points, cal } = run(LED_H);
check("found the probe at all 6 spots, lifted at 2", points.length === 6 && points.filter((p) => p.up).length === 2);
check("calibration solves", cal && !cal.error, cal.error || `rms ${cal.rms.toFixed(2)} mm, ${cal.mmPerPx.toFixed(2)} mm/px`);
check("camera height found", cal && Math.abs(cal.hc - (700 - 0)) < 30, cal && `${cal.hc.toFixed(0)} mm (true 700)`);
check("bed height from the touches", cal && Math.abs(cal.zBed - BED) < 0.1, cal && cal.zBed.toFixed(2));
let w0 = 0, w19 = 0;
for (let x = 20; x <= 390; x += 37) for (let y = 20; y <= 380; y += 40) {
  const q0 = toMachine(cal, cam({ x, y, z: 0 }), 0), q19 = toMachine(cal, cam({ x, y, z: 19 }), 19);
  w0 = Math.max(w0, Math.hypot(q0.x - x, q0.y - y)); w19 = Math.max(w19, Math.hypot(q19.x - x, q19.y - y));
}
check("bed points within 1 mm", w0 < 1, `${w0.toFixed(2)} mm`);
check("19 mm stock top within 1.5 mm", w19 < 1.5, `${w19.toFixed(2)} mm`);
// If the ring height typed in is off by 1.5 mm (measured with calipers)
for (const dh of [-1.5, 1.5]) {
  const r = run(LED_H + dh).cal;
  let w = 0;
  for (let x = 20; x <= 390; x += 37) for (let y = 20; y <= 380; y += 40) { const q = toMachine(r, cam({ x, y, z: 19 }), 19); w = Math.max(w, Math.hypot(q.x - x, q.y - y)); }
  check(`ring height off by ${dh} mm: 19 mm stock top still within 2 mm`, w < 2, `${w.toFixed(2)} mm`);
}
// Same answer as tapping the stylus by hand (1.36.0) on the same camera
const tapped = calibrate(spots.map((s, i) => ({ m: { x: s.x, y: s.y, z: BED }, px: cam({ ...s, z: 0 }), up: i === 0 || i === 3 ? { ...cam({ ...s, z: 60 }), dz: 60 } : undefined })), { w: W, h: H });
const a = toMachine(cal, cam({ x: 200, y: 200, z: 0 })), b = toMachine(tapped, cam({ x: 200, y: 200, z: 0 }));
check("agrees with a hand-tapped calibration within 1 mm", Math.hypot(a.x - b.x, a.y - b.y) < 1, `${Math.hypot(a.x - b.x, a.y - b.y).toFixed(2)} mm apart`);
check("refused with fewer than 4 spots", !!calibrateLed(points.slice(0, 3), { w: W, h: H }).error);
check("refused without lifted spots", !!calibrateLed(points.map((p) => ({ ...p, up: undefined })), { w: W, h: H }).error);

// 3. The touch program
const prog = autoTouchProgram({ top: -1, x: 61.5, y: 82, approach: -100, zMin: -132, travel: 1000, fast: 200, slow: 25 });
check("touch program: travels at the top, approaches, guarded descent", /G90 G53 G0 Z-1\nG53 G0 X61.5 Y82\nG53 G0 Z-100\nG91 G38.3 Z-32 F800/.test(prog), prog);
check("touch program: ends pressed into the touch (red ring)", /#<_ofa_z> = #5063\nG91 G1 Z-0.15 F25\n#<_ofa_ok> = 1/.test(prog));
check("touch program: nothing under it -> back to the top", /o420 else\nG90 G53 G0 Z-1\no420 endif/.test(prog));
const first = autoTouchProgram({ top: -1, x: 10, y: 10, zMin: -132, travel: 1000, fast: 200, slow: 25 });
check("first spot: guarded all the way down from the top", /G53 G0 X10 Y10\nG91 G38.3 Z-131 F800/.test(first), first);

console.log(ok ? "ALL PASS" : "SOME FAILED"); process.exit(ok ? 0 : 1);
