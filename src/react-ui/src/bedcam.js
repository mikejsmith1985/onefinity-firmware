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

// Picture pixel -> machine X/Y of a point t mm above the bed
export function toMachine(cal, px, t = 0) {
  const P = apply(cal.H, px.x, px.y);
  const f = (cal.hc - t) / cal.hc;
  return { x: cal.c.x + (P.x - cal.c.x) * f, y: cal.c.y + (P.y - cal.c.y) * f };
}
// Machine X/Y at height t -> picture pixel
export function toPixel(cal, m, t = 0) {
  const f = cal.hc / (cal.hc - t);
  const P = { x: cal.c.x + (m.x - cal.c.x) * f, y: cal.c.y + (m.y - cal.c.y) * f };
  return apply(cal.Hinv, P.x, P.y);
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
