// Bed camera (1.36.0): a camera fixed above the table, looking down.
//
// Calibration maps picture pixels to machine X/Y.  The 3D probe touches the
// bed at a few spots; at each one the operator taps the stylus in the picture.
// That gives a homography H from pixels to machine X/Y on the bed plane.
//
// Things standing above the bed look bigger and further from the point under
// the camera (parallax).  At two of the spots the probe is also raised a known
// height and tapped again; that gives the point under the camera (c) and the
// camera height (hc).  A point at height t above the bed that shows up at bed
// coordinates P really sits at  X = c + (P - c) * (hc - t) / hc.
//
// Finding stock: a picture of the empty bed is kept.  A new picture is
// compared with it; the biggest area that changed is the stock.  Its outline
// and smallest enclosing rectangle are worked out in picture pixels and then
// turned into machine coordinates at the stock's height.
//
// Everything here is plain math on arrays so it can be tested without a
// browser (test/bedcam.mjs).

// ---------- small linear algebra ----------
function solve(A, b) {
  // Gaussian elimination with partial pivoting; A is n x n (array of rows)
  const n = b.length, M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-12) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((r, i) => r[n] / r[i]);
}

function leastSquares(rows, rhs) {
  const n = rows[0].length;
  const AtA = Array.from({ length: n }, () => new Array(n).fill(0)), Atb = new Array(n).fill(0);
  rows.forEach((r, i) => {
    for (let a = 0; a < n; a++) {
      Atb[a] += r[a] * rhs[i];
      for (let b = 0; b < n; b++) AtA[a][b] += r[a] * r[b];
    }
  });
  return solve(AtA, Atb);
}

const mul3 = (A, B) => A.map((r) => [0, 1, 2].map((j) => r[0] * B[0][j] + r[1] * B[1][j] + r[2] * B[2][j]));
export function inv3(m) {
  const [a, b, c] = m[0], [d, e, f] = m[1], [g, h, i] = m[2];
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-15) return null;
  return [[A / det, -(b * i - c * h) / det, (b * f - c * e) / det],
    [B / det, (a * i - c * g) / det, -(a * f - c * d) / det],
    [C / det, -(a * h - b * g) / det, (a * e - b * d) / det]];
}
export const apply = (H, x, y) => {
  const w = H[2][0] * x + H[2][1] * y + H[2][2];
  return { x: (H[0][0] * x + H[0][1] * y + H[0][2]) / w, y: (H[1][0] * x + H[1][1] * y + H[1][2]) / w };
};

// Similarity transform that moves points to mean 0, mean distance sqrt(2)
function normalizer(pts) {
  const mx = pts.reduce((s, p) => s + p.x, 0) / pts.length, my = pts.reduce((s, p) => s + p.y, 0) / pts.length;
  const d = pts.reduce((s, p) => s + Math.hypot(p.x - mx, p.y - my), 0) / pts.length || 1;
  const k = Math.SQRT2 / d;
  return [[k, 0, -k * mx], [0, k, -k * my], [0, 0, 1]];
}

// Homography from >= 4 pairs {from:{x,y}, to:{x,y}}
export function fitHomography(pairs) {
  if (pairs.length < 4) return null;
  const Tf = normalizer(pairs.map((p) => p.from)), Tt = normalizer(pairs.map((p) => p.to));
  const rows = [], rhs = [];
  for (const { from, to } of pairs) {
    const u = apply(Tf, from.x, from.y), X = apply(Tt, to.x, to.y);
    rows.push([u.x, u.y, 1, 0, 0, 0, -u.x * X.x, -u.y * X.x]); rhs.push(X.x);
    rows.push([0, 0, 0, u.x, u.y, 1, -u.x * X.y, -u.y * X.y]); rhs.push(X.y);
  }
  const h = leastSquares(rows, rhs);
  if (!h) return null;
  const Hn = [[h[0], h[1], h[2]], [h[3], h[4], h[5]], [h[6], h[7], 1]];
  const TtInv = inv3(Tt);
  if (!TtInv) return null;
  const H = mul3(mul3(TtInv, Hn), Tf);
  const s = H[2][2];
  return H.map((r) => r.map((v) => v / s));
}

// ---------- calibration ----------
// points: [{m:{x,y,z}, px:{x,y}, up?:{x,y,dz}}]  m = machine position of the
// probe tip touching the bed, px = where it shows in the picture, up = where
// it shows after lifting dz mm straight up.
export function calibrate(points, size) {
  const low = points.filter((p) => p.m && p.px);
  if (low.length < 4) return { error: "Touch the bed at 4 or more spots, spread out over the area you use." };
  const H = fitHomography(low.map((p) => ({ from: p.px, to: p.m })));
  if (!H) return { error: "Those spots don't work out. They may be in a line, or a tap missed the stylus. Spread them out and try again." };
  const Hinv = inv3(H);
  const raised = low.filter((p) => p.up && p.up.dz > 5);
  if (raised.length < 2) return { error: "Lift the probe and tap it again at 2 of the spots, so the camera height can be worked out." };
  // P = k A + d  for every raised point (same dz), with d = (1 - k) c
  const rows = [], rhs = [];
  for (const p of raised) {
    const P = apply(H, p.up.x, p.up.y);
    rows.push([p.m.x, 1, 0]); rhs.push(P.x);
    rows.push([p.m.y, 0, 1]); rhs.push(P.y);
  }
  const s = leastSquares(rows, rhs);
  const dz = raised.reduce((a, p) => a + p.up.dz, 0) / raised.length;
  if (!s || !(s[0] > 1.0005)) return { error: "The lifted taps didn't move outwards the way they should. Check you tapped the stylus tip after lifting, and try again." };
  const k = s[0], c = { x: s[1] / (1 - k), y: s[2] / (1 - k) };
  const hc = (k * dz) / (k - 1);
  if (!(hc > 100 && hc < 5000)) return { error: `That puts the camera ${Math.round(hc)} mm above the bed, which can't be right. Tap again more carefully.` };
  const zBed = low.reduce((a, p) => a + p.m.z, 0) / low.length;
  const cal = { H, Hinv, c, hc, zBed, size, n: low.length, time: Date.now() };
  const errs = low.map((p) => { const q = apply(H, p.px.x, p.px.y); return Math.hypot(q.x - p.m.x, q.y - p.m.y); });
  const upErrs = raised.map((p) => { const q = toMachine(cal, p.up, p.up.dz); return Math.hypot(q.x - p.m.x, q.y - p.m.y); });
  cal.rms = Math.sqrt([...errs, ...upErrs].reduce((a, e) => a + e * e, 0) / (errs.length + upErrs.length));
  cal.worst = Math.max(...errs, ...upErrs);
  cal.mmPerPx = mmPerPixel(cal);
  return cal;
}

// Picture pixel -> where it would be with a straight lens (the inverse of the k1 bend above)
export function undistortPx(px, f, k1, size) {
  if (!k1) return px;
  const xd = (px.x - size.w / 2) / f, yd = (px.y - size.h / 2) / f;
  let xu = xd, yu = yd;
  for (let i = 0; i < 8; i++) { const k = 1 + k1 * (xu * xu + yu * yu); xu = xd / k; yu = yd / k; }
  return { x: size.w / 2 + f * xu, y: size.h / 2 + f * yu };
}
export function distortPx(px, f, k1, size) {
  if (!k1) return px;
  const xu = (px.x - size.w / 2) / f, yu = (px.y - size.h / 2) / f, k = 1 + k1 * (xu * xu + yu * yu);
  return { x: size.w / 2 + f * xu * k, y: size.h / 2 + f * yu * k };
}

// Picture pixel -> machine X/Y of a point t mm above the bed
// (1.41.1: a calibration from the crosses also undoes the lens's bend, cal.k1)
export function toMachine(cal, px, t = 0) {
  if (cal.k1) px = undistortPx(px, cal.f, cal.k1, cal.size);
  const P = apply(cal.H, px.x, px.y);
  const f = (cal.hc - t) / cal.hc;
  return { x: cal.c.x + (P.x - cal.c.x) * f, y: cal.c.y + (P.y - cal.c.y) * f };
}
// Machine X/Y at height t -> picture pixel
export function toPixel(cal, m, t = 0) {
  const f = cal.hc / (cal.hc - t);
  const P = { x: cal.c.x + (m.x - cal.c.x) * f, y: cal.c.y + (m.y - cal.c.y) * f };
  const q = apply(cal.Hinv, P.x, P.y);
  return cal.k1 ? distortPx(q, cal.f, cal.k1, cal.size) : q;
}
function mmPerPixel(cal) {
  const cx = cal.size ? cal.size.w / 2 : 320, cy = cal.size ? cal.size.h / 2 : 240;
  const a = apply(cal.H, cx, cy), b = apply(cal.H, cx + 10, cy);
  return Math.hypot(b.x - a.x, b.y - a.y) / 10;
}
// Calibrations saved in a browser lose Hinv in JSON; give it back
export function revive(cal) {
  if (!cal || !cal.H) return null;
  return { ...cal, Hinv: cal.Hinv || inv3(cal.H) };
}

// ---------- geometry ----------
export function convexHull(pts) {
  const p = pts.slice().sort((a, b) => a.x - b.x || a.y - b.y);
  if (p.length < 3) return p;
  const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lo = [], hi = [];
  for (const q of p) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
  for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (hi.length >= 2 && cross(hi[hi.length - 2], hi[hi.length - 1], q) <= 0) hi.pop(); hi.push(q); }
  return lo.slice(0, -1).concat(hi.slice(0, -1));
}

// Smallest rectangle around a point set: {cx, cy, w, l, angle (deg), corners}
// w is the side closer to the X direction; angle is that side's tilt from X.
export function minAreaRect(pts) {
  const hull = convexHull(pts);
  if (hull.length < 3) return null;
  let best = null;
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i], b = hull[(i + 1) % hull.length];
    const th = Math.atan2(b.y - a.y, b.x - a.x), c = Math.cos(th), s = Math.sin(th);
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const p of hull) {
      const u = p.x * c + p.y * s, v = -p.x * s + p.y * c;
      x0 = Math.min(x0, u); x1 = Math.max(x1, u); y0 = Math.min(y0, v); y1 = Math.max(y1, v);
    }
    const area = (x1 - x0) * (y1 - y0);
    if (!best || area < best.area) best = { area, th, x0, x1, y0, y1 };
  }
  const { th, x0, x1, y0, y1 } = best, c = Math.cos(th), s = Math.sin(th);
  const back = (u, v) => ({ x: u * c - v * s, y: u * s + v * c });
  const corners = [back(x0, y0), back(x1, y0), back(x1, y1), back(x0, y1)];
  const ctr = back((x0 + x1) / 2, (y0 + y1) / 2);
  let w = x1 - x0, l = y1 - y0, ang = (th * 180) / Math.PI;
  // Report the side nearest the X axis as w, angle in -45..45
  while (ang > 45) { ang -= 90; [w, l] = [l, w]; }
  while (ang <= -45) { ang += 90; [w, l] = [l, w]; }
  return { cx: ctr.x, cy: ctr.y, w, l, angle: ang, corners };
}

export function polygonArea(poly) {
  let a = 0;
  for (let i = 0; i < poly.length; i++) { const p = poly[i], q = poly[(i + 1) % poly.length]; a += p.x * q.y - q.x * p.y; }
  return a / 2;
}
export function pointInPolygon(p, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}
function segDist(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y, L = dx * dx + dy * dy;
  const t = L ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / L)) : 0;
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
}
// Distance inside the outline (positive) or outside (negative)
export function signedDistance(p, poly) {
  let d = Infinity;
  for (let i = 0; i < poly.length; i++) d = Math.min(d, segDist(p, poly[i], poly[(i + 1) % poly.length]));
  return pointInPolygon(p, poly) ? d : -d;
}

// Douglas-Peucker
export function simplify(pts, eps) {
  if (pts.length < 3) return pts;
  let best = 0, at = 0;
  const a = pts[0], b = pts[pts.length - 1];
  for (let i = 1; i < pts.length - 1; i++) { const d = segDist(pts[i], a, b); if (d > best) { best = d; at = i; } }
  if (best <= eps) return [a, b];
  return simplify(pts.slice(0, at + 1), eps).slice(0, -1).concat(simplify(pts.slice(at), eps));
}

// ---------- finding the stock ----------
// img: {width, height, data: RGBA bytes}.  Works on a copy shrunk to <= 640 px wide.
function shrink(img, maxW = 640) {
  const s = Math.max(1, Math.ceil(img.width / maxW));
  const w = Math.floor(img.width / s), h = Math.floor(img.height / s);
  const out = new Float32Array(w * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let r = 0, g = 0, b = 0;
    for (let dy = 0; dy < s; dy++) for (let dx = 0; dx < s; dx++) {
      const i = ((y * s + dy) * img.width + (x * s + dx)) * 4;
      r += img.data[i]; g += img.data[i + 1]; b += img.data[i + 2];
    }
    const n = s * s, o = (y * w + x) * 3;
    out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n;
  }
  return { w, h, s, px: out };
}

function median(arr) { const a = Array.from(arr).sort((x, y) => x - y); return a[a.length >> 1] || 1; }

function boxBlur(v, w, h) {
  const o = new Float32Array(v.length);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let s = 0, n = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const X = x + dx, Y = y + dy;
      if (X >= 0 && Y >= 0 && X < w && Y < h) { s += v[Y * w + X]; n++; }
    }
    o[y * w + x] = s / n;
  }
  return o;
}

function otsu(v, lo) {
  const hist = new Array(256).fill(0);
  for (const x of v) hist[Math.min(255, Math.max(0, Math.round(x)))]++;
  const total = v.length;
  let sum = 0; for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, best = 0, th = lo;
  for (let i = 0; i < 256; i++) {
    wB += hist[i]; if (!wB) continue;
    const wF = total - wB; if (!wF) break;
    sumB += i * hist[i];
    const mB = sumB / wB, mF = (sum - sumB) / wF, between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) { best = between; th = i; }
  }
  return Math.max(lo, th);
}

function morph(m, w, h, grow) {
  const o = new Uint8Array(m.length);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let any = 0, all = 1;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const X = x + dx, Y = y + dy;
      const v = X >= 0 && Y >= 0 && X < w && Y < h ? m[Y * w + X] : 0;
      any |= v; all &= v;
    }
    o[y * w + x] = grow ? any : all;
  }
  return o;
}

// Moore-neighbour trace of the outside boundary of the region with label id
function trace(lab, w, h, id, start) {
  const dirs = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
  const at = (x, y) => x >= 0 && y >= 0 && x < w && y < h && lab[y * w + x] === id;
  const pts = [];
  let x = start.x, y = start.y, d = 6, guard = 0;
  do {
    pts.push({ x, y });
    let found = false;
    for (let k = 0; k < 8; k++) {
      const nd = (d + 6 + k) % 8, nx = x + dirs[nd][0], ny = y + dirs[nd][1];
      if (at(nx, ny)) { x = nx; y = ny; d = nd; found = true; break; }
    }
    if (!found) break;
  } while ((x !== start.x || y !== start.y) && ++guard < w * h);
  return pts;
}

// Compare a picture with the empty-bed picture.  Returns null when nothing
// changed, else {outline, rect, area, mask:{w,h,s,bits}} in full-size pixels.
// mask (optional) limits the search to a polygon in pixels (the bed area).
export function findStock(base, cur, opts = {}) {
  if (!base || !cur || base.width !== cur.width || base.height !== cur.height) return { error: "size" };
  const A = shrink(base), B = shrink(cur), w = A.w, h = A.h, n = w * h;
  // Even out a change in overall brightness between the two pictures
  const lumA = new Float32Array(n), lumB = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    lumA[i] = (A.px[i * 3] + A.px[i * 3 + 1] + A.px[i * 3 + 2]) / 3;
    lumB[i] = (B.px[i * 3] + B.px[i * 3 + 1] + B.px[i * 3 + 2]) / 3;
  }
  const gain = median(lumA) / median(lumB);
  let diff = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let d = 0;
    for (let c = 0; c < 3; c++) d += Math.abs(A.px[i * 3 + c] - B.px[i * 3 + c] * gain);
    diff[i] = d / 3;
  }
  diff = boxBlur(boxBlur(diff, w, h), w, h);
  const th = otsu(diff, opts.minDiff || 8);
  let m = new Uint8Array(n);
  const inArea = opts.area ? opts.area.map((p) => ({ x: p.x / A.s, y: p.y / A.s })) : null;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    m[i] = diff[i] > th && (!inArea || pointInPolygon({ x: x + 0.5, y: y + 0.5 }, inArea)) ? 1 : 0;
  }
  // Remove specks, fill pinholes
  m = morph(morph(m, w, h, false), w, h, true);
  m = morph(morph(m, w, h, true), w, h, false);
  // Biggest connected area
  const lab = new Int32Array(n); let best = 0, bestN = 0, bestStart = null, id = 0;
  const stack = [];
  for (let i = 0; i < n; i++) {
    if (!m[i] || lab[i]) continue;
    id++; let cnt = 0, first = null; stack.push(i); lab[i] = id;
    while (stack.length) {
      const j = stack.pop(); cnt++;
      const x = j % w, y = (j / w) | 0;
      if (!first || y < first.y || (y === first.y && x < first.x)) first = { x, y };
      const nb = [j - 1, j + 1, j - w, j + w];
      if (x === 0) nb[0] = -1; if (x === w - 1) nb[1] = -1;
      for (const k of nb) if (k >= 0 && k < n && m[k] && !lab[k]) { lab[k] = id; stack.push(k); }
    }
    if (cnt > bestN) { bestN = cnt; best = id; bestStart = first; }
  }
  if (!best || bestN < n * (opts.minArea || 0.003)) return null;
  const s = A.s;
  const raw = trace(lab, w, h, best, bestStart).map((p) => ({ x: (p.x + 0.5) * s, y: (p.y + 0.5) * s }));
  const outline = simplify(raw.concat([raw[0]]), 0.75 * s).slice(0, -1);
  const pix = [];
  for (let i = 0; i < n; i++) if (lab[i] === best) pix.push({ x: ((i % w) + 0.5) * s, y: (((i / w) | 0) + 0.5) * s });
  const rect = minAreaRect(raw.length > 2 ? raw : pix);
  // Full boundary (every other point) for accurate rectangles in machine units
  const contour = raw.filter((_, i) => i % 2 === 0);
  const touchesEdge = raw.some((p) => p.x < s * 1.5 || p.y < s * 1.5 || p.x > base.width - s * 1.5 || p.y > base.height - s * 1.5);
  return { outline, contour, rect, areaPx: bestN * s * s, touchesEdge, threshold: th };
}

// Rectangle around a traced boundary.  The smallest-box angle is pulled
// towards pixel steps on a stair-stepped edge, so for oblong shapes the angle
// comes from the boundary's principal axis instead (an average over the whole
// edge), and the box is then fitted along that axis.
export function boundaryRect(pts) {
  const mr = minAreaRect(pts);
  if (!mr || pts.length < 8) return mr;
  if (Math.max(mr.w, mr.l) / Math.min(mr.w, mr.l) < 1.12) return mr; // nearly square: axis is ill-defined
  // Resample the closed boundary evenly so dense stretches don't weigh more
  const per = []; let L = 0;
  for (let i = 0; i < pts.length; i++) { const a = pts[i], b = pts[(i + 1) % pts.length]; const d = Math.hypot(b.x - a.x, b.y - a.y); per.push(d); L += d; }
  const step = L / 600, even = [];
  let acc = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length], d = per[i];
    while (acc <= d && d > 0) { even.push({ x: a.x + ((b.x - a.x) * acc) / d, y: a.y + ((b.y - a.y) * acc) / d }); acc += step; }
    acc -= d;
  }
  const mx = even.reduce((s, p) => s + p.x, 0) / even.length, my = even.reduce((s, p) => s + p.y, 0) / even.length;
  let sxx = 0, syy = 0, sxy = 0;
  for (const p of even) { const dx = p.x - mx, dy = p.y - my; sxx += dx * dx; syy += dy * dy; sxy += dx * dy; }
  const th = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const c = Math.cos(th), s = Math.sin(th);
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const p of pts) { const u = p.x * c + p.y * s, v = -p.x * s + p.y * c; x0 = Math.min(x0, u); x1 = Math.max(x1, u); y0 = Math.min(y0, v); y1 = Math.max(y1, v); }
  const back = (u, v) => ({ x: u * c - v * s, y: u * s + v * c });
  const ctr = back((x0 + x1) / 2, (y0 + y1) / 2);
  let w = x1 - x0, l = y1 - y0, ang = (th * 180) / Math.PI;
  while (ang > 45) { ang -= 90; [w, l] = [l, w]; }
  while (ang <= -45) { ang += 90; [w, l] = [l, w]; }
  return { cx: ctr.x, cy: ctr.y, w, l, angle: ang, corners: [back(x0, y0), back(x1, y0), back(x1, y1), back(x0, y1)] };
}

// Outline in pixels -> machine X/Y at height t; rectangle too
export function stockInMachine(cal, found, t) {
  const outline = found.outline.map((p) => toMachine(cal, p, t));
  const r = boundaryRect((found.contour || found.outline).map((p) => toMachine(cal, p, t)));
  return { outline, rect: r, t };
}

// ---------- does a program fit on the stock? ----------
// pts: Float32Array of x,y,z work positions (from the planner).  off: work offsets.
// Only moves below Z0 + 0.01 count (cutting).  r: tool radius.
export function fitCheck(pts, off, outline, r = 0, maxPoints = 20000) {
  const n = Math.floor(pts.length / 3);
  if (!n || !outline || outline.length < 3) return null;
  const step = Math.max(1, Math.floor(n / maxPoints));
  let worst = Infinity, at = null, cutting = 0;
  for (let i = 0; i < n; i += step) {
    const z = pts[i * 3 + 2];
    if (!(z < 0.01)) continue;
    cutting++;
    const p = { x: pts[i * 3] + (off.x || 0), y: pts[i * 3 + 1] + (off.y || 0) };
    const d = signedDistance(p, outline) - r;
    if (d < worst) { worst = d; at = p; }
  }
  if (!cutting) return { cutting: 0 };
  return { cutting, worst, at, fits: worst >= 0 };
}

// ---------- machine programs ----------
const n4 = (v) => { const s = (Math.round(v * 10000) / 10000).toFixed(4).replace(/\.?0+$/, ""); return s === "-0" ? "0" : s; };

// Calibration: touch the bed straight down from where the probe is, then sit
// 0.2 mm above it for the picture.  #5063 is the machine Z (see setter.js).
export function bedTouchProgram({ fast, slow }) {
  return ["(Bed camera: touch the bed)", "G21", "#<_ofc_ok> = 0",
    `G91 G38.2 Z-30 F${fast}`, "G91 G1 Z1", `G91 G38.2 Z-2 F${slow}`,
    "#<_ofc_z> = #5063", "G91 G1 Z0.2", "#<_ofc_ok> = 1", "G90", "M2"].join("\n") + "\n";
}
export const liftProgram = (dz) => ["(Bed camera: lift)", "G21", `G91 G0 Z${n4(dz)}`, "G90", "M2"].join("\n") + "\n";

// Out of the camera's way, at the top of Z
export const parkProgram = ({ top, x, y }) =>
  ["(Bed camera: park)", "G21", `G90 G53 G0 Z${n4(top)}`, `G53 G0 X${n4(x)} Y${n4(y)}`, "G90", "M2"].join("\n") + "\n";

// Measure stock from the camera: over the middle of what the camera saw, come
// down guarded until the stylus meets the top, touch it slowly, then wait
// `above` mm over it.  Nothing under it: back to the top, nothing changed.
export function moveOverProgram({ top, x, y, zStop, travel, fast, slow, above = 8 }) {
  const down = top - zStop;
  return ["(Measure stock: move over the stock the camera found)", "G21",
    "#<_ofb_ok> = 0", "#<_ofb_hit> = 0",
    `G90 G53 G0 Z${n4(top)}`, `G53 G0 X${n4(x)} Y${n4(y)}`,
    `G91 G38.3 Z${n4(-down)} F${Math.min(travel, 600)}`,
    "o410 if [#5070 EQ 1]",
    "#<_ofb_hit> = 1",
    `G91 G1 Z1 F${fast}`,
    `G91 G38.2 Z-2 F${slow}`,
    "#<_ofb_top> = #5063",
    `G91 G0 Z${n4(above)}`,
    "#<_ofb_ok> = 1",
    "o410 else",
    `G90 G53 G0 Z${n4(top)}`,
    "o410 endif",
    "G90", "M2"].join("\n") + "\n";
}

// Machine travel rectangle -> picture polygon (where to look for stock)
export function travelArea(cal, lim) {
  if (!cal || !lim) return null;
  return [[lim.x0, lim.y0], [lim.x1, lim.y0], [lim.x1, lim.y1], [lim.x0, lim.y1]].map(([x, y]) => toPixel(cal, { x, y }, 0));
}

// Fewer points for storing
export const thin = (pts, max = 400) => { const k = Math.max(1, Math.ceil(pts.length / max)); return pts.filter((_, i) => i % k === 0).map((p) => ({ x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10 })); };

// ---------- hands-off calibration with the probe's LED ring (1.38.0) ----------
//
// The probe's LED ring glows green, and red while the stylus is touched. The
// machine touches the bed itself at a few spots; at each one the camera takes a
// picture with the stylus still pressed (red ring) and one just after lifting it
// 0.35 mm (green ring). The ring is the only thing whose colour flips between the
// two, so it is found without anyone tapping the picture. At two spots the probe
// is then lifted further and found again for the height: a picture lifted, and
// one with the probe moved sideways, so the ring is the green spot that went away.
//
// The ring sits ledH mm above the stylus tip, so its pixels describe the plane
// ledH above the bed. calibrateLed() fits that plane like calibrate() fits the
// bed, then moves the result down to the bed along the rays from the camera.
export const LED_H = 31.5; // mm, LED ring above the stylus tip (EasyTouch drawing: 26 mm stylus + 5.6 mm to the ring groove)

export const LED_R = 16.5; // mm, radius of the LED ring (the probe body is 33 mm across)

// The middle of a ring seen at an angle isn't quite where its centre is in the
// picture (perspective). Once there is a first calibration, work out that
// offset for each spot and take it off, then calibrate again.
function ringBias(cal, m, t, r = LED_R) {
  const c = toPixel(cal, m, t);
  let sx = 0, sy = 0;
  for (let k = 0; k < 36; k++) {
    const a = (k * Math.PI) / 18, q = toPixel(cal, { x: m.x + r * Math.cos(a), y: m.y + r * Math.sin(a) }, t);
    sx += q.x; sy += q.y;
  }
  return { x: sx / 36 - c.x, y: sy / 36 - c.y };
}

export function calibrateLed(points, size, ledH = LED_H) {
  let cal = calibrateLedOnce(points, size, ledH);
  for (let it = 0; it < 2 && cal && !cal.error; it++) {
    const fixed = points.map((p) => {
      if (!p.m || !p.px) return p;
      const b = ringBias(cal, p.m, ledH), q = { ...p, px: { x: p.px.x - b.x, y: p.px.y - b.y } };
      if (p.up) { const bu = ringBias(cal, p.m, ledH + p.up.dz); q.up = { ...p.up, x: p.up.x - bu.x, y: p.up.y - bu.y }; }
      return q;
    });
    const next = calibrateLedOnce(fixed, size, ledH);
    if (!next || next.error) break;
    cal = next;
  }
  return cal;
}

function calibrateLedOnce(points, size, ledH) {
  const low = points.filter((p) => p.m && p.px);
  if (low.length < 4) return { error: "The camera found the probe at fewer than 4 spots. Check it can see the probe's light, or calibrate by tapping." };
  const HL = fitHomography(low.map((p) => ({ from: p.px, to: p.m })));
  if (!HL) return { error: "The spots the camera found don't fit together. Calibrate by tapping instead." };
  const raised = low.filter((p) => p.up && p.up.dz > 5);
  if (raised.length < 2) return { error: "The camera didn't find the lifted probe at 2 spots, so it can't work out heights. Calibrate by tapping instead." };
  const rows = [], rhs = [];
  for (const p of raised) {
    const P = apply(HL, p.up.x, p.up.y);
    rows.push([p.m.x, 1, 0]); rhs.push(P.x);
    rows.push([p.m.y, 0, 1]); rhs.push(P.y);
  }
  const s = leastSquares(rows, rhs);
  const dz = raised.reduce((a, p) => a + p.up.dz, 0) / raised.length;
  if (!s || !(s[0] > 1.0005)) return { error: "The lifted probe didn't move in the picture the way it should. Calibrate by tapping instead." };
  const k = s[0], c = { x: s[1] / (1 - k), y: s[2] / (1 - k) };
  const hcL = (k * dz) / (k - 1);                 // camera above the LED plane
  const hc = hcL + ledH;                          // camera above the bed
  if (!(hc > 100 && hc < 5000)) return { error: `That puts the camera ${Math.round(hc)} mm above the bed, which can't be right. Calibrate by tapping instead.` };
  // The bed seen through a pixel lies further out from c than the LED plane, by f
  const f = hc / hcL;
  const S = [[f, 0, c.x * (1 - f)], [0, f, c.y * (1 - f)], [0, 0, 1]];
  const H = mul3(S, HL);
  const zs = low.map((p) => p.m.z).sort((a, b) => a - b), zBed = zs[zs.length >> 1];
  const cal = { H, Hinv: inv3(H), c, hc, zBed, size, n: low.length, time: Date.now(), led: true, ledH };
  const errs = low.map((p) => { const q = toMachine(cal, p.px, ledH); return Math.hypot(q.x - p.m.x, q.y - p.m.y); });
  const upErrs = raised.map((p) => { const q = toMachine(cal, p.up, ledH + p.up.dz); return Math.hypot(q.x - p.m.x, q.y - p.m.y); });
  cal.rms = Math.sqrt([...errs, ...upErrs].reduce((a, e) => a + e * e, 0) / (errs.length + upErrs.length));
  cal.worst = Math.max(...errs, ...upErrs);
  cal.mmPerPx = mmPerPixel(cal);
  return cal;
}

// Find a blob from a per-pixel score (on a shrunk copy). Returns its centroid in
// full-size pixels, weighted by score over the strongest part, or null.
function blob(score, w, h, s, minScore, near, radius) {
  let max = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (near && Math.hypot((x + 0.5) * s - near.x, (y + 0.5) * s - near.y) > radius) continue;
    if (score[y * w + x] > max) max = score[y * w + x];
  }
  if (max < minScore) return null;
  // Connected area around the strongest pixel above 40% of it
  const th = 0.4 * max, seen = new Uint8Array(w * h);
  let start = -1;
  for (let i = 0; i < w * h && start < 0; i++) if (score[i] === max) {
    const x = i % w, y = (i / w) | 0;
    if (!near || Math.hypot((x + 0.5) * s - near.x, (y + 0.5) * s - near.y) <= radius) start = i;
  }
  const stack = [start], pts = []; seen[start] = 1;
  while (stack.length) {
    const j = stack.pop(); pts.push(j);
    const x = j % w, y = (j / w) | 0;
    // 8-neighbours, and a 1-pixel gap, so the ring's segments join up
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const X = x + dx, Y = y + dy;
      if (X < 0 || Y < 0 || X >= w || Y >= h) continue;
      const k = Y * w + X;
      if (!seen[k] && score[k] > th) { seen[k] = 1; stack.push(k); }
    }
  }
  if (pts.length < 3) return null;
  let sx = 0, sy = 0, sw = 0, x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const j of pts) {
    const x = j % w, y = (j / w) | 0, v = score[j] - th;
    sx += (x + 0.5) * v; sy += (y + 0.5) * v; sw += v;
    x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
  }
  return { x: (sx / sw) * s, y: (sy / sw) * s, n: pts.length, size: Math.max(x1 - x0 + 1, y1 - y0 + 1) * s, peak: max };
}

const LED_SCALE = 2; // work on a copy half the size: plenty for a ring 20+ px across

// red: picture with the stylus pressed (red ring); green: just after lifting (green ring)
export function detectLedFlip(red, green) {
  if (!red || !green || red.width !== green.width || red.height !== green.height) return null;
  const A = shrink(red, red.width / LED_SCALE), B = shrink(green, green.width / LED_SCALE), w = A.w, h = A.h;
  const score = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const dG = B.px[i * 3 + 1] - A.px[i * 3 + 1];   // greener now
    const dR = A.px[i * 3] - B.px[i * 3];           // was redder
    score[i] = dG > 0 && dR > 0 ? Math.min(dG, dR) : 0;
  }
  const r = blob(score, w, h, A.s, 25);
  return r && r.size < red.width * 0.2 ? r : null;
}

// here: the lifted ring; away: the same, with the probe moved sideways (so the
// ring is somewhere else and nothing overlaps it). The green spot that is in
// `here` and not in `away`, near `near`. Green things that never move cancel.
export function detectLedMoved(away, here, near, radius) {
  if (!away || !here || away.width !== here.width) return null;
  const A = shrink(away, away.width / LED_SCALE), B = shrink(here, here.width / LED_SCALE), w = A.w, h = A.h;
  const green = (P, i) => P.px[i * 3 + 1] - Math.max(P.px[i * 3], P.px[i * 3 + 2]);
  const score = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) score[i] = Math.max(0, green(B, i) - Math.max(0, green(A, i)));
  const r = blob(score, w, h, A.s, 25, near, radius || away.width * 0.3);
  return r && r.size < away.width * 0.2 ? r : null;
}

// Spots spread over the machine's reach, kept clear of the tool setter
// (a 3 x 3 grid: corners and middle first, so the first 6 already cover the whole
// reach; calibration stops once it has 6 the camera saw)
export function autoSpots(lim, setter) {
  const order = [[0.15, 0.15], [0.85, 0.15], [0.85, 0.85], [0.15, 0.85], [0.5, 0.5], [0.5, 0.15], [0.85, 0.5], [0.5, 0.85], [0.15, 0.5]];
  const out = [];
  for (const [xf, yf] of order) {
    {
      let x = lim.x0 + (lim.x1 - lim.x0) * xf, y = lim.y0 + (lim.y1 - lim.y0) * yf;
      if (setter && Number.isFinite(setter.x)) {
        const keep = (setter.r || 33.2) + 25;
        for (let n = 0; n < 6 && Math.abs(x - setter.x) < keep && Math.abs(y - setter.y) < keep; n++) {
          // step towards the middle of the reach until clear of the setter
          const mx = (lim.x0 + lim.x1) / 2, my = (lim.y0 + lim.y1) / 2, d = Math.hypot(mx - x, my - y) || 1;
          x += ((mx - x) / d) * 30; y += ((my - y) / d) * 30;
        }
      }
      out.push({ x: Math.round(x), y: Math.round(y) });
    }
  }
  return out;
}

// Up to the top, across, then down to the bed. The first time the bed height
// isn't known: come down guarded from the top. After that, rapid to `approach`
// (a little above the bed) and touch from there. Ends pressed 0.15 mm into the
// touch (red ring), so the picture can be taken; liftProgram(0.35) lets it go.
export function autoTouchProgram({ top, x, y, approach, zMin, travel, fast, slow }) {
  const lines = ["(Bed camera: auto touch)", "G21", "#<_ofa_ok> = 0",
    `G90 G53 G0 Z${n4(top)}`, `G53 G0 X${n4(x)} Y${n4(y)}`];
  if (Number.isFinite(approach)) lines.push(`G53 G0 Z${n4(approach)}`);
  const from = Number.isFinite(approach) ? approach : top;
  lines.push(`G91 G38.3 Z${n4(-(from - zMin))} F${Math.min(travel, 800)}`,
    "o420 if [#5070 EQ 1]",
    `G91 G1 Z1 F${fast}`, `G91 G38.2 Z-2 F${slow}`,
    "#<_ofa_z> = #5063",
    `G91 G1 Z-0.15 F${slow}`,
    "#<_ofa_ok> = 1",
    "o420 else",
    `G90 G53 G0 Z${n4(top)}`,
    "o420 endif",
    "G90", "M2");
  return lines.join("\n") + "\n";
}

// Sideways move for the lifted picture: towards the middle of the reach
export const AWAY = 80;
export function awayMove(spot, lim) {
  const mx = (lim.x0 + lim.x1) / 2;
  return spot.x < mx ? AWAY : -AWAY;
}
export const sidewaysProgram = (dx) => ["(Bed camera: sideways)", "G21", `G91 G0 X${n4(dx)}`, "G90", "M2"].join("\n") + "\n";

// ----- Bed markers (1.39.0) -----
// Three small crosses carved with a V-bit near the corners of the spoilboard
// that don't have the tool setter, at positions the controller picks and
// saves. Later pictures look for them, so a camera that got bumped is noticed.
// You only show it the board: jog over three of its corners. The outer pieces
// of a slatted spoilboard are MDF, so a spot a little in from a corner is MDF.
export const MARK = { inset: 25, size: 20, depth: 1.2, plunge: 300, feed: 1000, rpm: 18000 };
// 1.41.0: two more, part way up the left and right sides, at different heights and further in
// from the edge than the corner ones (not in line with them: three crosses in a line, or the two
// on a side swapped, would fit a camera just as well). So the layout has no symmetry and the
// camera calibration can tell which cross is which. Still on the outer slats.
const SIDES = { ml: 0.4, mr: 0.62 }, SIDE_IN = 45;
export const MARK_IDS = ["fl", "fr", "bl", "ml", "mr"];
export const CORNER_NAMES = { fl: "front-left", fr: "front-right", bl: "back-left", ml: "left side", mr: "right side" };

// corners: {fl, fr, bl} machine {x, y} (the fourth corner is where the setter is).
// Returns {spots: [{id, x, y}], error}. The spots sit `inset` in from both edges
// of the board at each corner, along the board's own edges (it may be a little
// turned), kept inside the machine's reach and clear of the setter.
export function markerSpots(corners, lim, setter, o = {}) {
  const inset = o.inset ?? MARK.inset, half = (o.size ?? MARK.size) / 2;
  const { fl, fr, bl } = corners || {};
  if (!fl || !fr || !bl) return { error: "Save all three corners first." };
  const ux = fr.x - fl.x, uy = fr.y - fl.y, vx = bl.x - fl.x, vy = bl.y - fl.y;
  const lu = Math.hypot(ux, uy), lv = Math.hypot(vx, vy);
  if (lu < 4 * inset || lv < 4 * inset) return { error: `The corners are only ${Math.round(lu)} × ${Math.round(lv)} mm apart. Check you jogged to the right corners.` };
  const u = { x: ux / lu, y: uy / lu }, v = { x: vx / lv, y: vy / lv };
  const dot = u.x * v.x + u.y * v.y;
  if (Math.abs(dot) > 0.1) return { error: "Those three corners aren't square to each other. Front-left, front-right, then back-left." };
  if (u.x * v.y - u.y * v.x < 0) return { error: "The corners look swapped: front-right should be to the right of front-left, and back-left behind it." };
  const at = (c, su, sv) => ({ x: c.x + su * inset * u.x + sv * inset * v.x, y: c.y + su * inset * u.y + sv * inset * v.y });
  const side = (c, su, f) => ({ x: c.x + su * SIDE_IN * u.x + f * lv * v.x, y: c.y + su * SIDE_IN * u.y + f * lv * v.y });
  const raw = { fl: at(fl, 1, 1), fr: at(fr, -1, 1), bl: at(bl, 1, -1), ml: side(fl, 1, SIDES.ml), mr: side(fr, -1, SIDES.mr) };
  const notes = [];
  const spots = MARK_IDS.map((id) => {
    let { x, y } = raw[id];
    const m = half + 2;
    if (lim) {
      const cx = Math.min(Math.max(x, lim.x0 + m), lim.x1 - m), cy = Math.min(Math.max(y, lim.y0 + m), lim.y1 - m);
      if (Math.hypot(cx - x, cy - y) > 0.5) notes.push(`The ${CORNER_NAMES[id]} cross moved ${Math.round(Math.hypot(cx - x, cy - y))} mm in, to stay inside the machine's reach.`);
      x = cx; y = cy;
    }
    if (setter && Number.isFinite(setter.x) && Math.hypot(x - setter.x, y - setter.y) < (setter.r || 33) + m)
      return { id, x, y, clash: true };
    return { id, x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10 };
  });
  const bad = spots.find((s) => s.clash);
  if (bad) return { error: `The ${CORNER_NAMES[bad.id]} cross would be on the tool setter. The setter should be at the back-right corner.` };
  return { spots, notes };
}

// The bed height at each spot comes from the probe; the V-bit's length from
// both touching the tool setter: V-bit tip on the bed when the machine is at
// z + (vbitTrip - probeTrip) + corr, where corr is the probe-vs-cutter
// correction (setter.corr.c: the probe trips the setter a little differently
// from a rigid cutter; see setter.js). spots: [{x, y, z}] (z: machine Z the probe touched).
export function markerCarveProgram({ top, spots, probeTrip, vbitTrip, corr = 0, depth = MARK.depth, size = MARK.size, plunge = MARK.plunge, feed = MARK.feed, rpm = MARK.rpm }) {
  const d = vbitTrip - probeTrip + corr, h = size / 2, above = 3;
  const lines = ["(Bed markers: carve)", "G21", "G90", `G53 G0 Z${n4(top)}`, `M3 S${rpm}`];
  for (const s of spots) {
    const surf = s.z + d;
    for (const [sx, sy, mv] of [[s.x - h, s.y, `X${n4(size)}`], [s.x, s.y - h, `Y${n4(size)}`]]) {
      lines.push(`G53 G0 X${n4(sx)} Y${n4(sy)}`, `G53 G0 Z${n4(Math.min(top, surf + above))}`,
        `G91 G1 Z${n4(-(Math.min(top, surf + above) - (surf - depth)))} F${plunge}`, `G1 ${mv} F${feed}`, `G90 G53 G0 Z${n4(top)}`);
    }
  }
  lines.push("M5", "G90", "M2");
  return lines.join("\n") + "\n";
}

// The router off, just above each spot, so you can see where they'll go
export function markerShowProgram({ top, spot, above }) {
  return ["(Bed markers: show)", "G21", "G90", `G53 G0 Z${n4(top)}`, `G53 G0 X${n4(spot.x)} Y${n4(spot.y)}`,
    ...(Number.isFinite(above) ? [`G53 G0 Z${n4(above)}`] : []), "M2"].join("\n") + "\n";
}
