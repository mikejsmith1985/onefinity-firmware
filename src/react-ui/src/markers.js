// Bed camera calibration from the carved crosses (1.41.0).
//
// On the machine the overhead camera can't see the probe's light (the router
// and dust shoe are on top of it), but it sees the V-bit crosses clearly once
// they are inked. Each cross's machine position is known (the controller chose
// it and carved it, and the probe measured the bed height there), so finding
// them in one picture is enough to calibrate:
//  - detectCrosses: dark "+" shapes in the picture, centres to a fraction of a pixel
//  - matchCrosses: which found cross is which carved one (an asymmetric layout,
//    and a camera above the bed can't see it mirrored, so only one match fits)
//  - fitCamera: a pinhole camera (focal length, position, angle) through the
//    matches, which gives the camera's height and the point under it, so the
//    top of stock can be placed allowing for its height (parallax)
// The result has the same form as bedcam.js calibrate(): {H, c, hc, zBed, ...}.
import { fitHomography, apply, inv3, undistortPx } from "./bedcam.js";

// ---------- finding crosses ----------
function grayOf(img) {
  const { width: w, height: h, data } = img, g = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) g[i] = 0.3 * data[i * 4] + 0.59 * data[i * 4 + 1] + 0.11 * data[i * 4 + 2];
  return g;
}
function boxMean(g, w, h, r) {
  const I = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) { let s = 0; for (let x = 0; x < w; x++) { s += g[y * w + x]; I[(y + 1) * (w + 1) + x + 1] = I[y * (w + 1) + x + 1] + s; } }
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1), y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1);
    out[y * w + x] = (I[y1 * (w + 1) + x1] - I[y0 * (w + 1) + x1] - I[y1 * (w + 1) + x0] + I[y0 * (w + 1) + x0]) / ((x1 - x0) * (y1 - y0));
  }
  return out;
}
// Total-least-squares line through points: {cx, cy, dx, dy, spread (rms off the line)}
function fitLine(pts) {
  const n = pts.length; let mx = 0, my = 0;
  for (const p of pts) { mx += p.x; my += p.y; } mx /= n; my /= n;
  let sxx = 0, syy = 0, sxy = 0;
  for (const p of pts) { const u = p.x - mx, v = p.y - my; sxx += u * u; syy += v * v; sxy += u * v; }
  const a = 0.5 * Math.atan2(2 * sxy, sxx - syy), dx = Math.cos(a), dy = Math.sin(a);
  let off = 0; for (const p of pts) { const d = -(p.x - mx) * dy + (p.y - my) * dx; off += d * d; }
  return { cx: mx, cy: my, dx, dy, spread: Math.sqrt(off / n) };
}
// A dark mark is a cross when its pixels lie on two lines that cross near the
// middle of both, with an arm on each side of the crossing on both lines.
function crossOf(pix) {
  const n = pix.length;
  let mx = 0, my = 0; for (const p of pix) { mx += p.x; my += p.y; } mx /= n; my /= n;
  let ext = 0; for (const p of pix) ext = Math.max(ext, Math.hypot(p.x - mx, p.y - my));
  const w = Math.max(1.6, ext * 0.14);
  let best = null;
  for (let k = 0; k < 60; k++) {           // the line with the most pixels close to it
    const a = (k * Math.PI) / 60, dx = Math.cos(a), dy = Math.sin(a);
    let c = 0; for (const p of pix) if (Math.abs(-(p.x - mx) * dy + (p.y - my) * dx) < w) c++;
    if (!best || c > best.c) best = { c, a };
  }
  const near = (p, L, ww) => Math.abs(-(p.x - L.cx) * L.dy + (p.y - L.cy) * L.dx) < ww;
  const A0 = { cx: mx, cy: my, dx: Math.cos(best.a), dy: Math.sin(best.a) };
  const onA = pix.filter((p) => near(p, A0, w)), rest = pix.filter((p) => !near(p, A0, w));
  if (onA.length < 6 || rest.length < 6) return null;
  const A = fitLine(onA), B = fitLine(rest);
  const cosAB = Math.abs(A.dx * B.dx + A.dy * B.dy);
  if (cosAB > 0.7) return null;                     // the two lines must really cross (within ~45 deg of square)
  // crossing point
  const den = A.dx * B.dy - A.dy * B.dx;
  const t = ((B.cx - A.cx) * B.dy - (B.cy - A.cy) * B.dx) / den;
  const X = { x: A.cx + t * A.dx, y: A.cy + t * A.dy };
  // arms: pixels on each side of the crossing, along each line
  const arms = (P, L) => { let lo = 0, hi = 0, mn = 0, mxx = 0; for (const p of P) { const s = (p.x - X.x) * L.dx + (p.y - X.y) * L.dy; if (s < -w) lo++; if (s > w) hi++; mn = Math.min(mn, s); mxx = Math.max(mxx, s); } return { lo, hi, len: mxx - mn, mn, mxx }; };
  const aA = arms(onA, A), aB = arms(rest, B);
  if (Math.min(aA.lo, aA.hi, aB.lo, aB.hi) < 3) return null;
  // arms of similar length, crossing near the middle of each line
  const balance = (a) => Math.min(-a.mn, a.mxx) / Math.max(-a.mn, a.mxx);
  if (balance(aA) < 0.45 || balance(aB) < 0.45) return null;
  const ratio = Math.min(aA.len, aB.len) / Math.max(aA.len, aB.len);
  if (ratio < 0.45) return null;
  // thin lines: off-line spread small compared with the arm length
  const thin = Math.max(A.spread, B.spread) / Math.min(aA.len, aB.len);
  if (thin > 0.12) return null;
  const score = (onA.length + rest.length) / n * ratio * Math.min(balance(aA), balance(aB)) * (1 - thin * 4);
  return { x: X.x, y: X.y, size: (aA.len + aB.len) / 2, score };
}

// img: {width, height, data} (RGBA). Returns crosses, best first.
// o: {minSize, maxSize} expected arm-to-arm length in pixels
export function detectCrosses(img, o = {}) {
  const { width: w, height: h } = img;
  const minSize = o.minSize ?? 10, maxSize = o.maxSize ?? Math.max(w, h) / 8;
  const g = grayOf(img), bg = boxMean(g, w, h, Math.round(Math.max(8, maxSize / 3)));
  const dark = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) dark[i] = bg[i] - g[i] > Math.max(18, bg[i] * 0.16) ? 1 : 0;
  const seen = new Uint8Array(w * h), out = [];
  const stack = [];
  for (let s = 0; s < w * h; s++) {
    if (!dark[s] || seen[s]) continue;
    const pix = []; let x0 = w, x1 = 0, y0 = h, y1 = 0;
    stack.push(s); seen[s] = 1;
    while (stack.length) {
      const i = stack.pop(), x = i % w, y = (i - x) / w;
      pix.push({ x: x + 0.5, y: y + 0.5 });
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      if (pix.length > 20000) break;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const X = x + dx, Y = y + dy;
        if (X < 0 || Y < 0 || X >= w || Y >= h) continue;
        const j = Y * w + X;
        if (dark[j] && !seen[j]) { seen[j] = 1; stack.push(j); }
      }
    }
    stack.length = 0;
    const span = Math.max(x1 - x0, y1 - y0);
    if (span < minSize || span > maxSize * 1.5 || pix.length < 12) continue;
    const c = crossOf(pix);
    if (c && c.size >= minSize * 0.8 && c.size <= maxSize * 1.4) out.push(c);
  }
  return out.sort((a, b) => b.score - a.score);
}

// ---------- which cross is which ----------
function homographyError(H, pairs) {
  let worst = 0, ss = 0;
  for (const p of pairs) { const q = apply(H, p.from.x, p.from.y); const e = Math.hypot(q.x - p.to.x, q.y - p.to.y); worst = Math.max(worst, e); ss += e * e; }
  return { worst, rms: Math.sqrt(ss / pairs.length) };
}
// Seen from above, the picture of the bed is never mirrored: image x right / y down
// against machine X right / Y back always turns the same way (negative determinant).
function notMirrored(H, size) {
  const cx = size.w / 2, cy = size.h / 2, a = apply(H, cx, cy), bx = apply(H, cx + 10, cy), by = apply(H, cx, cy + 10);
  return (bx.x - a.x) * (by.y - a.y) - (bx.y - a.y) * (by.x - a.x) < 0;
}
function* permutations(arr, k) {
  if (k === 0) { yield []; return; }
  for (let i = 0; i < arr.length; i++) {
    const rest = arr.slice(0, i).concat(arr.slice(i + 1));
    for (const p of permutations(rest, k - 1)) yield [arr[i], ...p];
  }
}
// found: crosses in the picture; marks: [{id, x, y}] carved (machine). Every mark must be found.
// Returns {pairs: [{id, px, m}], worst, rms (mm on the bed), next (the next best match's worst)}
export function matchCrosses(found, marks, size, o = {}) {
  const need = marks.length;
  if (need < 4) return { error: "Calibrating from the crosses needs at least 4 carved crosses." };
  const cand = found.slice(0, o.max ?? Math.min(found.length, need + 4));
  if (cand.length < need) return { error: `The camera found ${cand.length} of the ${need} crosses. Check they're inked and nothing covers them.` };
  let best = null, second = Infinity;
  for (const perm of permutations(cand, need)) {
    const pairs = marks.map((m, i) => ({ from: perm[i], to: m }));
    // quick reject from the first 4 before fitting all of them
    const H = fitHomography(pairs);
    if (!H || !notMirrored(H, size)) continue;
    const e = homographyError(H, pairs);
    if (!best || e.worst < best.worst) { if (best) second = Math.min(second, best.worst); best = { H, pairs, ...e }; }
    else second = Math.min(second, e.worst);
  }
  if (!best) return { error: "The crosses found don't line up with the carved ones." };
  return { pairs: best.pairs.map((p, i) => ({ id: marks[i].id, px: { x: p.from.x, y: p.from.y }, m: marks[i] })), H: best.H, worst: best.worst, rms: best.rms, next: second };
}

// ---------- the camera ----------
function rodrigues(r) {
  const t = Math.hypot(r[0], r[1], r[2]);
  if (t < 1e-12) return [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  const [x, y, z] = r.map((v) => v / t), c = Math.cos(t), s = Math.sin(t), C = 1 - c;
  return [[c + x * x * C, x * y * C - z * s, x * z * C + y * s], [y * x * C + z * s, c + y * y * C, y * z * C - x * s], [z * x * C - y * s, z * y * C + x * s, c + z * z * C]];
}
const mul3 = (A, B) => A.map((r) => [0, 1, 2].map((j) => r[0] * B[0][j] + r[1] * B[1][j] + r[2] * B[2][j]));
// p = [f, rx, ry, rz, Cx, Cy, Cz, k1, R0]: the turn (rx, ry, rz) is a small change on top of the
// starting guess R0, which keeps the fit well behaved for any way round the camera is mounted.
// k1: the lens's barrel distortion (1.41.1: the machine's webcam bends the picture enough to put
// the crosses up to 4 mm off a straight-lens fit). World point -> pixel (principal point at the
// picture's middle).
function project(p, size, X) {
  const R = mul3(rodrigues([p[1], p[2], p[3]]), p[8]), d = [X.x - p[4], X.y - p[5], X.z - p[6]];
  const c = R.map((r) => r[0] * d[0] + r[1] * d[1] + r[2] * d[2]);
  const xn = c[0] / c[2], yn = c[1] / c[2], k = 1 + p[7] * (xn * xn + yn * yn);
  return { x: size.w / 2 + p[0] * xn * k, y: size.h / 2 + p[0] * yn * k, z: c[2] };
}
function solve(A, b) {
  const n = b.length, M = A.map((r, i) => [...r, b[i]]);
  for (let i = 0; i < n; i++) {
    let m = i; for (let k = i + 1; k < n; k++) if (Math.abs(M[k][i]) > Math.abs(M[m][i])) m = k;
    [M[i], M[m]] = [M[m], M[i]];
    if (Math.abs(M[i][i]) < 1e-15) return null;
    for (let k = i + 1; k < n; k++) { const f = M[k][i] / M[i][i]; for (let j = i; j <= n; j++) M[k][j] -= f * M[i][j]; }
  }
  const x = new Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) { let s = M[i][n]; for (let j = i + 1; j < n; j++) s -= M[i][j] * x[j]; x[i] = s / M[i][i]; }
  return x;
}
// Levenberg-Marquardt on the pixel error of every match (plus an optional height prior)
function refine(p0, size, pts, prior, NP = 7) {
  let p = p0.slice(), lam = 1e-3;
  const res = (q) => {
    const r = [];
    for (const t of pts) { const s = project(q, size, t.m); if (!(s.z > 0)) return null; r.push(s.x - t.px.x, s.y - t.px.y); }
    if (prior) r.push((q[6] - prior.z) / prior.sd);
    return r;
  };
  let r = res(p); if (!r) return null;
  let cost = r.reduce((a, v) => a + v * v, 0);
  for (let it = 0; it < 200; it++) {
    const J = [], eps = [1, 1e-5, 1e-5, 1e-5, 0.05, 0.05, 0.05, 1e-4];
    for (let k = 0; k < NP; k++) { const q = p.slice(); q[k] += eps[k]; const rq = res(q); if (!rq) return null; J.push(rq.map((v, i) => (v - r[i]) / eps[k])); }
    const A = [...Array(NP)].map((_, i) => [...Array(NP)].map((_, j) => J[i].reduce((a, v, k) => a + v * J[j][k], 0)));
    const g = [...Array(NP)].map((_, i) => J[i].reduce((a, v, k) => a + v * r[k], 0));
    let moved = false;
    for (let tries = 0; tries < 10; tries++) {
      const Al = A.map((row, i) => row.map((v, j) => (i === j ? v * (1 + lam) : v)));
      const d = solve(Al, g.map((v) => -v)); if (!d) { lam *= 10; continue; }
      const q = p.map((v, i) => (i < NP ? v + d[i] : v)); const rq = res(q);
      const cq = rq ? rq.reduce((a, v) => a + v * v, 0) : Infinity;
      if (cq < cost) { p = q; r = rq; const done = cost - cq < 1e-12 * (1 + cost); cost = cq; lam = Math.max(lam / 10, 1e-9); moved = true; if (done) it = 999; break; }
      lam *= 10;
    }
    if (!moved) break;
  }
  return { p, cost };
}
// Starting guess: looking straight down from above the bed point under the picture's middle,
// turned and scaled as the homography says, for a few focal lengths; the best fit wins.
function startGuesses(H, size, zBed, prior) {
  const c = apply(H, size.w / 2, size.h / 2), ex = apply(H, size.w / 2 + 1, size.h / 2), ey = apply(H, size.w / 2, size.h / 2 + 1);
  const sx = Math.hypot(ex.x - c.x, ex.y - c.y), ux = [(ex.x - c.x) / sx, (ex.y - c.y) / sx, 0];
  const uy0 = [ey.x - c.x, ey.y - c.y, 0], sy = Math.hypot(uy0[0], uy0[1]);
  // square up the picture's y direction against its x direction (perspective skews them a little)
  const dot = (uy0[0] * ux[0] + uy0[1] * ux[1]) / sy, uy1 = [uy0[0] / sy - dot * ux[0], uy0[1] / sy - dot * ux[1], 0];
  const n1 = Math.hypot(uy1[0], uy1[1]), uy = [uy1[0] / n1, uy1[1] / n1, 0];
  const uz = [ux[1] * uy[2] - ux[2] * uy[1], ux[2] * uy[0] - ux[0] * uy[2], ux[0] * uy[1] - ux[1] * uy[0]]; // camera axis, pointing down
  const R = [ux, uy, uz];  // rows: camera axes in machine coordinates
  const mm = (sx + sy) / 2;
  if (prior) { const f0 = (prior.z - zBed) / mm; return [0.8, 1, 1.25].map((k) => [f0 * k, 0, 0, 0, c.x, c.y, prior.z, 0, R]); }
  return [500, 800, 1100, 1500, 2200].map((f) => [f, 0, 0, 0, c.x, c.y, zBed + f * mm, 0, R]);
}
// pairs: [{px, m: {x, y, z}}] (z: machine Z of the bed at that cross); size {w, h};
// o.hc: camera height above the bed measured with a tape (optional, used as a gentle prior)
export function fitCamera(pairs, size, o = {}) {
  const pts = pairs.map((p) => ({ px: p.px, m: { x: p.m.x, y: p.m.y, z: p.m.z } }));
  const zBed = pts.reduce((a, p) => a + p.m.z, 0) / pts.length;
  const H = fitHomography(pts.map((p) => ({ from: p.px, to: p.m })));
  if (!H) return { error: "The crosses found don't work out (they may be in a line)." };
  // Straight-lens fit from a few starting points, then with the lens's bend (k1) let free too
  const fit = (prior) => {
    let best = null;
    for (const g of startGuesses(H, size, zBed, prior)) {
      const r = refine(g, size, pts, prior);
      if (r && (!best || r.cost < best.cost)) best = r;
    }
    if (!best || o.straight) return best;
    const b8 = refine(best.p, size, pts, prior, 8);
    // Only kept when the bend clearly explains something: a lens with no bend (or 5 crosses that
    // already fit a straight lens) would otherwise trade the bend against the camera's height.
    const rms = (r) => Math.sqrt(r.cost / (pts.length * 2));
    return b8 && rms(b8) < 0.5 * rms(best) && rms(best) - rms(b8) > 0.1 ? b8 : best;
  };
  const px = (r) => Math.sqrt(r.cost / (pts.length * 2));
  let best = fit(null);
  // A camera looking almost straight down can't tell its height from flat crosses alone
  // (higher with a longer lens looks the same). Check: does forcing it 20% higher make the
  // fit noticeably worse? If not, the height has to come from a tape measure.
  let weak = !best || !(best.p[6] - zBed > 150 && best.p[6] - zBed < 3000);
  if (!weak) {
    const alt = fit({ z: zBed + (best.p[6] - zBed) * 1.2, sd: 0.02 });
    weak = !alt || px(alt) - px(best) < 0.15;
  }
  if (weak) {
    if (!Number.isFinite(o.hc)) return { error: "The camera looks almost straight down, so its height can't be worked out from the crosses alone. Measure from the camera lens down to the bed with a tape, enter it, and calibrate again.", needHeight: true };
    best = fit({ z: zBed + o.hc, sd: 0.05 });
    if (!best || px(best) > 2 || !(best.p[0] > 0)) return { error: "Couldn't work out where the camera is from the crosses and that height. Check the height measurement." };
  }
  if (px(best) > 2 || !(best.p[0] > 0)) return { error: `The crosses don't fit one camera position (off by ${px(best).toFixed(1)} pixels). Something else may have been taken for a cross.` };
  const p = best.p, hc = p[6] - zBed, k1 = Math.abs(p[7]) > 1e-6 ? p[7] : 0;
  // The picture-to-bed map for the straightened picture
  const Hu = k1 ? fitHomography(pts.map((q) => ({ from: undistortPx(q.px, p[0], k1, size), to: q.m }))) : H;
  return { f: p[0], k1, c: { x: p[4], y: p[5] }, hc, H: Hu, zBed, errPx: px(best), fromTape: weak };
}

// The whole calibration: picture -> cal (same form as bedcam.js calibrate()).
// marks: [{id, x, y, z}] the carved crosses (z: bed height the probe measured there).
export function calibrateMarkers(img, marks, o = {}) {
  const size = { w: img.width, h: img.height };
  const found = detectCrosses(img, o);
  const m = matchCrosses(found, marks.map((k) => ({ id: k.id, x: k.x, y: k.y, z: k.z })), size);
  if (m.error) return { error: m.error, found };
  // (1.41.1: judged on the camera fit below, which allows for the lens's bend; a straight
  // homography is several mm out on the machine's webcam)
  if (m.worst > 8) return { error: `The crosses found don't line up with the carved ones (${m.worst.toFixed(1)} mm out), so something else may have been taken for a cross, or a cross isn't where it's saved.`, found };
  const cam = fitCamera(m.pairs, size, o);
  if (cam.error) return { ...cam, found, pairs: m.pairs };
  if (!(cam.hc > 150 && cam.hc < 4000)) return { error: `That puts the camera ${Math.round(cam.hc)} mm above the bed, which can't be right.`, found };
  const cal = { H: cam.H, Hinv: inv3(cam.H), c: cam.c, hc: cam.hc, zBed: cam.zBed, size, n: m.pairs.length, time: Date.now(), from: "markers", f: cam.f, k1: cam.k1, errPx: cam.errPx, fromTape: cam.fromTape };
  const errs = m.pairs.map((p) => { const u = undistortPx(p.px, cam.f, cam.k1, size), q = apply(cam.H, u.x, u.y); return Math.hypot(q.x - p.m.x, q.y - p.m.y); });
  cal.rms = Math.sqrt(errs.reduce((a, e) => a + e * e, 0) / errs.length);
  cal.worst = Math.max(...errs);
  { const cx = size.w / 2, cy = size.h / 2, a = apply(cam.H, cx, cy), b = apply(cam.H, cx + 10, cy); cal.mmPerPx = Math.hypot(b.x - a.x, b.y - a.y) / 10; }
  if (cal.worst > 1.5) return { error: `The crosses only line up to within ${cal.worst.toFixed(1)} mm even allowing for the lens, so something may be off: a cross covered or smudged, or one carved somewhere else.`, found };
  cal.pairs = m.pairs.map((p) => ({ id: p.id, px: { x: +p.px.x.toFixed(2), y: +p.px.y.toFixed(2) } }));
  return cal;
}
export const _internals = { refine: (...a) => refine(...a), startGuesses: (...a) => startGuesses(...a), project: (...a) => project(...a) };
