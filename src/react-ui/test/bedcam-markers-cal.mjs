// Bed camera calibration from the carved crosses (1.41.0), against a simulated overhead camera
// like the one on the machine (looking down from the front, the router hiding the probe), and the
// machine's own picture of its first three inked crosses.
//   node src/react-ui/test/bedcam-markers-cal.mjs
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";
import path from "path";
import { detectCrosses, matchCrosses, calibrateMarkers } from "../src/markers.js";
import { markerSpots, toMachine } from "../src/bedcam.js";

let ok = true;
const check = (name, cond, msg = "") => { console.log(`${cond ? "PASS" : "FAIL"} ${name} ${msg}`); ok = ok && !!cond; };
const HERE = path.dirname(fileURLToPath(import.meta.url));

// --- a pinhole camera over the bed
const W = 1280, H = 720, BED = -96.5;
function camera({ C, f = 900, tilt = 0.28, yaw = 0.02, roll = 0.015, turn = 0 }) {
  const Rx = (a) => [[1, 0, 0], [0, Math.cos(a), -Math.sin(a)], [0, Math.sin(a), Math.cos(a)]];
  const Ry = (a) => [[Math.cos(a), 0, Math.sin(a)], [0, 1, 0], [-Math.sin(a), 0, Math.cos(a)]];
  const Rz = (a) => [[Math.cos(a), -Math.sin(a), 0], [Math.sin(a), Math.cos(a), 0], [0, 0, 1]];
  const mm = (A, B) => A.map((r) => [0, 1, 2].map((j) => r[0] * B[0][j] + r[1] * B[1][j] + r[2] * B[2][j]));
  const base = [[1, 0, 0], [0, -1, 0], [0, 0, -1]];          // looking straight down, image up = machine back
  const R = mm(mm(mm(mm(Rz(turn), Rz(yaw)), Rx(-tilt)), Ry(roll)), base);
  const project = (p) => { const d = [p.x - C[0], p.y - C[1], p.z - C[2]]; const c = R.map((r) => r[0] * d[0] + r[1] * d[1] + r[2] * d[2]); return { x: W / 2 + (f * c[0]) / c[2], y: H / 2 + (f * c[1]) / c[2] }; };
  const ray = (u, v, z) => { // pixel -> machine x, y on the plane z
    const dc = [(u - W / 2) / f, (v - H / 2) / f, 1];
    const d = [0, 1, 2].map((j) => R[0][j] * dc[0] + R[1][j] * dc[1] + R[2][j] * dc[2]); // R^T dc
    const k = (z - C[2]) / d[2];
    return { x: C[0] + k * d[0], y: C[1] + k * d[1] };
  };
  return { project, ray, C, f };
}
// --- the bed: 406 mm board of 5 MDF slats and 4 aluminium tracks, screws, holes, the setter, inked crosses
let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const marks = markerSpots({ fl: { x: 3.3, y: 1.2 }, fr: { x: 407.2, y: 1.3 }, bl: { x: 2.7, y: 402.9 } }, { x0: 0, x1: 410, y0: 0, y1: 410 }, { x: 375.55, y: 376.3, r: 36.4 }).spots;
const zAt = (m) => BED + 0.02 * (m.x / 400) - 0.03 * (m.y / 400);  // bed not quite flat
function shade(x, y, opt) {
  if (x < 2 || x > 408 || y < 0 || y > 404) return 95;                    // table around the board
  const tracks = [69, 151, 255, 337];
  for (const t of tracks) if (Math.abs(x - t) < 9.5) {
    for (let k = 1; k < 4; k++) if (Math.hypot(x - t, y - k * 100) < 3) return 70; // screws
    return 215;                                                          // aluminium
  }
  if (Math.hypot(x - 375.55, y - 376.3) < 14) return 40;                 // the setter, from above
  if (Math.hypot(x - 375.55, y - 376.3) < 15.5) return 25;               // its pocket edge
  for (const h of [[190, 200], [215, 200], [195, 170]]) if (Math.hypot(x - h[0], y - h[1]) < 3) return 60; // holes
  for (const m of [...opt.marks, ...(opt.extra || [])]) {
    if (opt.hide === m.id) continue;
    const dx = x - m.x, dy = y - m.y, half = 10, wl = 0.75;
    if ((Math.abs(dy) < wl && Math.abs(dx) < half) || (Math.abs(dx) < wl && Math.abs(dy) < half)) return 45;
  }
  return 168 + 6 * Math.sin(x * 0.11) * Math.cos(y * 0.07);               // MDF
}
function picture(cam, opt = {}) {
  const data = new Uint8ClampedArray(W * H * 4);
  for (let v = 0; v < H; v++) for (let u = 0; u < W; u++) {
    let s = 0;
    for (const [a, b] of [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]]) { const p = cam.ray(u + a, v + b, BED); s += shade(p.x, p.y, { marks, ...opt }); }
    const g = s / 4 + (rnd() - 0.5) * 10, i = (v * W + u) * 4;
    data[i] = g * 1.0; data[i + 1] = g * 0.92; data[i + 2] = g * 0.78; data[i + 3] = 255;
  }
  return { width: W, height: H, data };
}
const marksZ = marks.map((m) => ({ ...m, z: zAt(m) }));
function accuracy(cal, cam) {
  let w0 = 0, w19 = 0;
  for (let x = 20; x <= 390; x += 37) for (let y = 20; y <= 390; y += 37) {
    const p0 = cam.project({ x, y, z: BED }), p19 = cam.project({ x, y, z: BED + 19 });
    const q0 = toMachine(cal, p0, 0), q19 = toMachine(cal, p19, 19);
    w0 = Math.max(w0, Math.hypot(q0.x - x, q0.y - y)); w19 = Math.max(w19, Math.hypot(q19.x - x, q19.y - y));
  }
  return { w0, w19 };
}

// 1. A camera like the machine's: about 800 mm up, in front of the middle, looking down and back
const cam = camera({ C: [205, -120, BED + 820] });
const pic = picture(cam);
const found = detectCrosses(pic);
check("finds the 5 crosses and nothing else (tracks, screws, holes, setter)", found.length === 5, found.map((c) => `${c.x.toFixed(0)},${c.y.toFixed(0)}`).join(" "));
const near = marks.every((m) => { const p = cam.project({ ...m, z: zAt(m) }); return found.some((c) => Math.hypot(c.x - p.x, c.y - p.y) < 0.6); });
check("each found within 0.6 px of where the cross really is", near);
const match = matchCrosses(found, marksZ, { w: W, h: H });
check("only one way to match them up (the layout has no symmetry, and the picture isn't mirrored)", !match.error && match.worst < 0.5 && match.next > 5 * Math.max(match.worst, 0.5), match.error || `best ${match.worst.toFixed(2)} mm, next ${match.next.toFixed(1)} mm`);
const cal = calibrateMarkers(pic, marksZ);
check("calibrates, no tape measure needed", !cal.error && !cal.fromTape, cal.error || `${cal.n} crosses, worst ${cal.worst.toFixed(2)} mm, camera ${cal.hc.toFixed(0)} mm up (true 820), f ${cal.f.toFixed(0)} (true 900)`);
if (!cal.error) {
  check("camera height within 4%", Math.abs(cal.hc - 820) < 33, cal.hc.toFixed(0));
  const a = accuracy(cal, cam);
  check("anywhere on the bed within 1 mm", a.w0 < 1, `${a.w0.toFixed(2)} mm`);
  check("the top of 19 mm stock within 1.5 mm", a.w19 < 1.5, `${a.w19.toFixed(2)} mm`);
}
// 2. One cross covered: says so, nothing calibrated
const hid = calibrateMarkers(picture(cam, { hide: "ml" }), marksZ);
check("a covered cross: stops and says how many it found", !!hid.error && /found 4 of the 5/.test(hid.error), hid.error);
// 3. The camera mounted turned a quarter turn, higher and straighter down
const cam2 = camera({ C: [230, 150, BED + 1100], f: 1100, tilt: 0.08, turn: Math.PI / 2 });
const pic2 = picture(cam2);
const no = calibrateMarkers(pic2, marksZ);
check("camera turned 90 degrees, almost straight down: asks for its height (it can't be told from flat crosses)", no.error && no.needHeight, no.error || `got ${no.hc}`);
const cal2 = calibrateMarkers(pic2, marksZ, { hc: 1110 });   // measured with a tape, 10 mm out
const m2 = matchCrosses(detectCrosses(pic2), marksZ, { w: W, h: H });
check("  only one way to match them up from this camera too", !m2.error && m2.next > 5 * Math.max(m2.worst, 0.5), m2.error || `best ${m2.worst.toFixed(2)}, next ${m2.next.toFixed(1)} mm`);
check("  with the height from a tape (10 mm out): calibrates", !cal2.error, cal2.error || `camera ${cal2.hc.toFixed(0)} mm (true 1100)`);
if (!cal2.error) { const a = accuracy(cal2, cam2); check("  bed within 1 mm, 19 mm stock within 1.5 mm", a.w0 < 1 && a.w19 < 1.5, `${a.w0.toFixed(2)} / ${a.w19.toFixed(2)} mm`); }
// 3b. A pencilled "+" somewhere else on the bed is not taken for one of the crosses
const t0 = Date.now();
const calD = calibrateMarkers(picture(cam, { extra: [{ id: "x", x: 200, y: 300 }, { id: "y", x: 120, y: 90 }] }), marksZ);
check("two extra crosses drawn on the bed: still the right five", !calD.error && calD.worst < 0.5 && calD.pairs.every((p) => { const m = marks.find((k) => k.id === p.id); const q = cam.project({ ...m, z: zAt(m) }); return Math.hypot(q.x - p.px.x, q.y - p.px.y) < 1; }), calD.error || `worst ${calD.worst.toFixed(2)} mm, ${Date.now() - t0} ms`);
// 4. The machine's own picture (1.40.0): the three inked crosses, nothing else taken for one
const rgba = execFileSync("python3", ["-c", "import sys;from PIL import Image;sys.stdout.buffer.write(Image.open(sys.argv[1]).convert('RGBA').tobytes())", path.join(HERE, "fixtures", "bedcam-crosses-1.40.jpg")], { maxBuffer: 1 << 24 });
const real = detectCrosses({ width: 1280, height: 720, data: new Uint8ClampedArray(rgba) });
const want = [[929, 582], [421, 87], [370, 568]];
check("machine picture: exactly its 3 crosses found", real.length === 3 && want.every(([x, y]) => real.some((c) => Math.hypot(c.x - x, c.y - y) < 3)), real.map((c) => `${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(" "));

console.log(ok ? "ALL PASS" : "SOME FAILED"); process.exit(ok ? 0 : 1);
