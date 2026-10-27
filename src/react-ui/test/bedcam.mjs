// Bed camera math and stock finding, against a simulated pinhole camera.
//   node src/react-ui/test/bedcam.mjs
import { calibrate, toMachine, toPixel, findStock, stockInMachine, fitCheck, minAreaRect, revive, signedDistance } from "../src/bedcam.js";

let ok = true;
const check = (name, cond, msg = "") => { console.log(`${cond ? "PASS" : "FAIL"} ${name} ${msg}`); ok = ok && !!cond; };
let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

// --- simulated camera: 1280x720, about 750 mm above the bed, tilted and turned a little ---
const W = 1280, H = 720, F = 1000;
function camera({ cx = 210, cy = 190, hc = 750, tilt = 0.12, roll = -0.05, yaw = 0.08 }) {
  const C = [cx, cy, hc];
  const Rx = (a) => [[1, 0, 0], [0, Math.cos(a), -Math.sin(a)], [0, Math.sin(a), Math.cos(a)]];
  const Ry = (a) => [[Math.cos(a), 0, Math.sin(a)], [0, 1, 0], [-Math.sin(a), 0, Math.cos(a)]];
  const Rz = (a) => [[Math.cos(a), -Math.sin(a), 0], [Math.sin(a), Math.cos(a), 0], [0, 0, 1]];
  const mm = (A, B) => A.map((r) => [0, 1, 2].map((j) => r[0] * B[0][j] + r[1] * B[1][j] + r[2] * B[2][j]));
  const base = [[1, 0, 0], [0, -1, 0], [0, 0, -1]]; // looking straight down, picture y = machine -Y
  const R = mm(mm(mm(Rz(yaw), Rx(tilt)), Ry(roll)), base);
  const project = (p) => {
    const d = [p.x - C[0], p.y - C[1], (p.z || 0) - C[2]];
    const c = R.map((r) => r[0] * d[0] + r[1] * d[1] + r[2] * d[2]);
    return { x: W / 2 + (F * c[0]) / c[2], y: H / 2 + (F * c[1]) / c[2] };
  };
  // Where the ray through a pixel meets the plane z = t (the true camera, for drawing pictures)
  project.unproject = (px, t) => {
    const c = [(px.x - W / 2) / F, (px.y - H / 2) / F, 1];
    const d = [0, 1, 2].map((j) => R[0][j] * c[0] + R[1][j] * c[1] + R[2][j] * c[2]); // R^T c
    const k = (t - C[2]) / d[2];
    return { x: C[0] + k * d[0], y: C[1] + k * d[1] };
  };
  return project;
}
const cam = camera({});
const noisy = (p, s = 0.5) => ({ x: p.x + (rnd() - 0.5) * 2 * s, y: p.y + (rnd() - 0.5) * 2 * s });

// --- calibration: probe touches the bed at 6 spots, 2 of them also lifted 60 mm ---
const zBedMachine = -80; // machine Z of the probe tip on the bed
const spots = [[30, 30], [380, 30], [380, 370], [30, 370], [205, 200], [120, 280]];
const points = spots.map(([x, y], i) => {
  const p = { m: { x, y, z: zBedMachine + (rnd() - 0.5) * 0.3 }, px: noisy(cam({ x, y, z: 0 })) };
  if (i === 0 || i === 2) p.up = { ...noisy(cam({ x, y, z: 60 })), dz: 60 };
  return p;
});
const cal = calibrate(points, { w: W, h: H });
check("calibration solves", !cal.error, cal.error || `rms ${cal.rms.toFixed(2)} mm, worst ${cal.worst.toFixed(2)} mm, ${cal.mmPerPx.toFixed(2)} mm/px`);
check("camera height found", Math.abs(cal.hc - 750) < 25, `hc ${cal.hc.toFixed(1)} mm (true 750)`);
check("bed Z", Math.abs(cal.zBed - zBedMachine) < 0.2, cal.zBed.toFixed(2));

// Accuracy across the bed at different heights
let worst0 = 0, worst19 = 0, worst50 = 0;
for (let x = 20; x <= 390; x += 37) for (let y = 20; y <= 380; y += 40) {
  for (const [t, set] of [[0, (e) => (worst0 = Math.max(worst0, e))], [19, (e) => (worst19 = Math.max(worst19, e))], [50, (e) => (worst50 = Math.max(worst50, e))]]) {
    const q = toMachine(cal, cam({ x, y, z: t }), t);
    set(Math.hypot(q.x - x, q.y - y));
  }
}
check("bed-level points within 1 mm", worst0 < 1, `${worst0.toFixed(2)} mm`);
check("19 mm stock top within 1.5 mm (height corrected)", worst19 < 1.5, `${worst19.toFixed(2)} mm`);
check("50 mm stock top within 2 mm", worst50 < 2, `${worst50.toFixed(2)} mm`);
let worstNoCorr = 0;
for (let x = 20; x <= 390; x += 37) for (let y = 20; y <= 380; y += 40) { const q = toMachine(cal, cam({ x, y, z: 50 }), 0); worstNoCorr = Math.max(worstNoCorr, Math.hypot(q.x - x, q.y - y)); }
check("height correction matters (50 mm without it is off a lot)", worstNoCorr > 8, `${worstNoCorr.toFixed(1)} mm without correction`);
const back = toPixel(cal, { x: 100, y: 100 }, 19), truth = cam({ x: 100, y: 100, z: 19 });
check("machine -> pixel round trip", Math.hypot(back.x - truth.x, back.y - truth.y) < 2, `${Math.hypot(back.x - truth.x, back.y - truth.y).toFixed(2)} px`);
const saved = revive(JSON.parse(JSON.stringify({ ...cal, Hinv: undefined })));
check("calibration survives saving", Math.abs(toPixel(saved, { x: 50, y: 60 }).x - toPixel(cal, { x: 50, y: 60 }).x) < 1e-6);

// Bad calibrations are refused
check("3 spots refused", !!calibrate(points.slice(0, 3), { w: W, h: H }).error);
check("no lifted taps refused", !!calibrate(points.map((p) => ({ ...p, up: undefined })), { w: W, h: H }).error);
check("spots in a line refused", !!calibrate([0, 1, 2, 3, 4].map((i) => ({ m: { x: 30 + i * 80, y: 50, z: -80 }, px: cam({ x: 30 + i * 80, y: 50 }), up: i < 2 ? { ...cam({ x: 30 + i * 80, y: 50, z: 60 }), dz: 60 } : undefined })), { w: W, h: H }).error);

// --- synthetic pictures: MDF bed with T-tracks, then stock on it ---
function picture(stock, gain = 1, noise = 6) {
  const data = new Uint8ClampedArray(W * H * 4);
  // inverse-map each pixel to the bed (z = 0) by sampling: use calibration from the true camera
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4;
    const m = cam.unproject({ x, y }, 0);
    let r = 150 + 10 * Math.sin(m.x * 0.05) + 8 * Math.cos(m.y * 0.07), g = r - 18, b = r - 45;
    if (Math.abs((m.y % 100) - 50) < 9) { r = g = b = 110; } // aluminium T-track
    if (stock) {
      const q = cam.unproject({ x, y }, stock.t);
      if (stock.inside(q)) { r = stock.rgb[0]; g = stock.rgb[1]; b = stock.rgb[2]; }
    }
    const nz = () => (rnd() - 0.5) * 2 * noise;
    data[i] = (r + nz()) * gain; data[i + 1] = (g + nz()) * gain; data[i + 2] = (b + nz()) * gain; data[i + 3] = 255;
  }
  return { width: W, height: H, data };
}
const empty = picture(null);

// A 150 x 90 mm plank, 19 mm thick, turned 4 degrees, centred at (200, 210)
const ang = (4 * Math.PI) / 180, C0 = { x: 200, y: 210 };
const plank = { t: 19, rgb: [196, 160, 112], inside: (q) => {
  const dx = q.x - C0.x, dy = q.y - C0.y, u = dx * Math.cos(ang) + dy * Math.sin(ang), v = -dx * Math.sin(ang) + dy * Math.cos(ang);
  return Math.abs(u) <= 75 && Math.abs(v) <= 45;
} };
const plankPic = picture(plank, 1.06);
if (process.env.DEBUG_DUMP) {
  const fs = await import("fs");
  const dump = (img, name) => { const hdr = `P6 ${img.width} ${img.height} 255\n`; const buf = Buffer.alloc(img.width * img.height * 3); for (let i = 0; i < img.width * img.height; i++) { buf[i*3] = img.data[i*4]; buf[i*3+1] = img.data[i*4+1]; buf[i*3+2] = img.data[i*4+2]; } fs.writeFileSync(process.env.DEBUG_DUMP + name, Buffer.concat([Buffer.from(hdr), buf])); };
  dump(empty, "empty.ppm"); dump(plankPic, "plank.ppm");
}
const f1 = findStock(empty, plankPic);
if (process.env.DEBUG_DUMP && f1) (await import("fs")).writeFileSync(process.env.DEBUG_DUMP + "f1.json", JSON.stringify(f1));
check("plank found", f1 && !f1.error, f1 ? `threshold ${f1.threshold.toFixed(1)}` : "nothing");
if (f1 && !f1.error) {
  const s = stockInMachine(cal, f1, 19);
  const r = s.rect;
  check("plank size", Math.abs(r.w - 150) < 4 && Math.abs(r.l - 90) < 4, `${r.w.toFixed(1)} x ${r.l.toFixed(1)} mm (true 150 x 90)`);
  check("plank centre", Math.hypot(r.cx - C0.x, r.cy - C0.y) < 2.5, `(${r.cx.toFixed(1)}, ${r.cy.toFixed(1)}) true (200, 210)`);
  check("plank angle", Math.abs(r.angle - 4) < 0.5, `${r.angle.toFixed(2)} deg (true 4)`);
  const wrongT = stockInMachine(cal, f1, 0).rect;
  check("ignoring height would oversize it", wrongT.w - 150 > 2, `${wrongT.w.toFixed(1)} mm if height ignored`);

  // Fit check: a 120 x 60 pocket inside fits, a 160 mm slot does not
  const prog = (len, wid) => { const a = []; for (let x = -len / 2; x <= len / 2; x += 2) for (const y of [-wid / 2, wid / 2]) a.push(x, y, -3); return new Float32Array(a); };
  const fitA = fitCheck(prog(120, 60), { x: C0.x, y: C0.y }, s.outline, 3);
  check("120 x 60 fits inside", fitA.fits, `margin ${fitA.worst.toFixed(1)} mm`);
  const fitB = fitCheck(prog(170, 40), { x: C0.x, y: C0.y }, s.outline, 3);
  check("170 mm long does not fit", !fitB.fits, `goes ${(-fitB.worst).toFixed(1)} mm past the edge`);
  const air = fitCheck(new Float32Array([500, 500, 5]), { x: 0, y: 0 }, s.outline, 3);
  check("moves above the stock are ignored", air.cutting === 0);
}

// Organic scrap: a bean-shaped offcut
const bean = { t: 12, rgb: [120, 85, 60], inside: (q) => {
  const a = Math.atan2(q.y - 150, q.x - 260), rr = 55 + 18 * Math.cos(2 * a) - 10 * Math.sin(3 * a);
  return Math.hypot(q.x - 260, q.y - 150) < rr;
} };
const f2 = findStock(empty, picture(bean, 0.95));
check("scrap found", f2 && !f2.error);
if (f2 && !f2.error) {
  const s = stockInMachine(cal, f2, 12);
  let worstEdge = 0;
  for (let k = 0; k < 72; k++) {
    const a = (k / 72) * 2 * Math.PI, rr = 55 + 18 * Math.cos(2 * a) - 10 * Math.sin(3 * a);
    const p = { x: 260 + rr * Math.cos(a), y: 150 + rr * Math.sin(a) };
    const d = Math.abs(signedDistance(p, s.outline));
    worstEdge = Math.max(worstEdge, d);
  }
  check("scrap outline follows the edge", worstEdge < 4, `furthest true edge point is ${worstEdge.toFixed(1)} mm from the outline (${s.outline.length} points)`);
}

// Nothing on the bed, only light change and noise
const f3 = findStock(empty, picture(null, 1.08, 8));
check("empty bed: nothing found", f3 === null);

const mr = minAreaRect([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 5 }, { x: 0, y: 5 }]);
check("rectangle helper", Math.abs(mr.w - 10) < 1e-9 && Math.abs(mr.l - 5) < 1e-9 && Math.abs(mr.angle) < 1e-9);

console.log(ok ? "ALL OK" : "SOMETHING FAILED");
process.exit(ok ? 0 : 1);
