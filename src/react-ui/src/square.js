import { marker, STEP_RESET } from "./progress.js";
// Squareness check (1.43.0): is X square to Y?
//
// A ground block (a 1-2-3 block) has corners square to a few ten-thousandths of an inch. It sits
// on the bed, roughly lined up with the axes. The 3D probe touches its top, then each of its four
// sides at two points. Each side gives a line, and the angle between the X-direction sides and the
// Y-direction sides is what the machine reads for a true 90°. The block's own turn on the bed
// doesn't matter: only the angle between its sides does.
//
// Moves (all relative to where the top was touched, the block's middle):
//   - travel at the clear height is guarded (G38.3): a clamp in the way stops it
//   - the drop beside each side is guarded: something beside the block stops it
//   - the touch itself is G38.2 (fast, back off 1 mm, slow), as in Measure stock
//   - back out along the same line (G53, machine coordinates) and up to the clear height
// No if/else (1.41.1: the controller's G-code reader can take a wrong else).
//
// Results: #<_ofq_*> -> ofq_* (machine mm).

export const SQUARE_DEFAULTS = { clear: 5, depth: 4, margin: 10, travel: 1000, along: 0.3 };

// Blocks, size along machine X and Y (mm)
export const BLOCKS = [
  ["123-3x2", "1-2-3 block, the 3 in side along X", 76.2, 50.8],
  ["123-2x3", "1-2-3 block, the 3 in side along Y", 50.8, 76.2],
];

export const SQUARE_FAILS = {
  1: "The stylus touched something while moving at the travel height. Look for a clamp or something tall near the block, or start lower over the block.",
  2: "The stylus touched something while going down beside the block. Keep about 15 mm clear around it, and check the block size you picked (the 3 in side along X or Y).",
};

const n = (v) => {
  const s = (Math.round(v * 10000) / 10000).toFixed(4).replace(/\.?0+$/, "");
  return s === "-0" ? "0" : s;
};

// The eight touches: side, which way the probe moves, and where it starts (relative to the middle)
export function squarePoints(o) {
  const r = o.ball / 2, m = o.margin ?? SQUARE_DEFAULTS.margin, k = o.along ?? SQUARE_DEFAULTS.along;
  const xo = o.a / 2 + m + r, yo = o.b / 2 + m + r, sa = k * o.a, sb = k * o.b;
  return [
    { side: "front", axis: "Y", dir: 1, x: -sa, y: -yo }, { side: "front", axis: "Y", dir: 1, x: sa, y: -yo },
    { side: "right", axis: "X", dir: -1, x: xo, y: -sb }, { side: "right", axis: "X", dir: -1, x: xo, y: sb },
    { side: "back", axis: "Y", dir: -1, x: sa, y: yo }, { side: "back", axis: "Y", dir: -1, x: -sa, y: yo },
    { side: "left", axis: "X", dir: 1, x: -xo, y: sb }, { side: "left", axis: "X", dir: 1, x: -xo, y: -sb },
  ];
}

// o: {a, b: block size along X, Y; ball; clear, depth, margin, travel, fast, slow, top: machine Z to end at}
export function squareProgram(o) {
  const clear = o.clear ?? SQUARE_DEFAULTS.clear, depth = o.depth ?? SQUARE_DEFAULTS.depth;
  const m = o.margin ?? SQUARE_DEFAULTS.margin, travel = o.travel ?? SQUARE_DEFAULTS.travel;
  const search = 2 * m + 2;
  const mark = marker();
  let oid = 300;
  const L = [
    `(Squareness check, block ${n(o.a)} x ${n(o.b)}, ball ${n(o.ball)})`, "G21", "M5",
    "#<_ofq_ok> = 0", "#<_ofq_fail> = 0", STEP_RESET,
    mark("Touch the block top"),
    `G91 G38.2 Z-25 F${o.fast}`, "G91 G1 Z1", `G91 G38.2 Z-2 F${o.slow}`,
    "#<_ofq_zt> = #5063", "#<_ofq_cx> = #5061", "#<_ofq_cy> = #5062",
    `G91 G0 Z${n(clear)}`,
  ];
  // A guarded move: on contact, set the failure and stop doing anything else
  // (it backs off 2 mm, so the stylus isn't dragged along whatever it touched on the way up)
  const guarded = (axis, d, feed, code) => {
    const id = oid++;
    return [`G91 G38.3 ${axis}${n(d)} F${feed}`, `o${id} if [#5070 EQ 1]`, `#<_ofq_fail> = ${code}`, `G91 G1 ${axis}${d > 0 ? -2 : 2} F${o.fast}`, `o${id} endif`];
  };
  const block = (lines) => { const id = oid++; L.push(`o${id} if [#<_ofq_fail> EQ 0]`, ...lines, `o${id} endif`); };
  let at = { x: 0, y: 0 };
  squarePoints(o).forEach((p, i) => {
    const dx = p.x - at.x, dy = p.y - at.y;
    if (Math.abs(dx) > 1e-6) block([mark(`Move to the ${p.side} side, guarded`), ...guarded("X", dx, travel, 1)]);
    if (Math.abs(dy) > 1e-6) block([mark(`Move to the ${p.side} side, guarded`), ...guarded("Y", dy, travel, 1)]);
    block([mark(`Go down beside the ${p.side} side, guarded`), ...guarded("Z", -(clear + depth), o.fast, 2)]);
    const ax = p.axis, back = ax === "X" ? `[#<_ofq_cx> + ${n(p.x)}]` : `[#<_ofq_cy> + ${n(p.y)}]`;
    block([mark(`Touch the ${p.side} side`),
      `G91 G38.2 ${ax}${n(p.dir * search)} F${o.fast}`, `G91 G1 ${ax}${n(-p.dir)}`, `G91 G38.2 ${ax}${n(p.dir * 2)} F${o.slow}`,
      `#<_ofq_x${i}> = #5061`, `#<_ofq_y${i}> = #5062`,
      `G90 G53 G1 ${ax}${back} F${o.fast}`, `G90 G53 G0 Z[#<_ofq_zt> + ${n(clear)}]`, "G91"]);
    at = { x: p.x, y: p.y };
  });
  L.push(mark("Up and back over the block"), "G90", `G53 G0 Z${n(o.top)}`,
    "o399 if [#<_ofq_fail> EQ 0]", "G53 G0 X[#<_ofq_cx>] Y[#<_ofq_cy>]", "#<_ofq_ok> = 1", "o399 endif",
    "G90", "M2");
  return L.join("\n") + "\n";
}

const deg = (rad) => (rad * 180) / Math.PI;
// r: controller state with ofq_*; o: {a, b, ball}
// -> {eps (radians: the block's corner reads 90° + eps), drift400 (mm over 400 mm), par (deg),
//     w, l (block size measured), turn (deg), error}
export function squareResult(r, o) {
  if (r.ofq_ok !== 1) return { error: SQUARE_FAILS[r.ofq_fail] || "The check didn't finish." };
  const P = [];
  for (let i = 0; i < 8; i++) {
    const x = r[`ofq_x${i}`], y = r[`ofq_y${i}`];
    if (typeof x !== "number" || typeof y !== "number") return { error: "The controller didn't report every touch. Try again." };
    P.push({ x, y });
  }
  const ang = (p, q) => Math.atan2(q.y - p.y, q.x - p.x);
  const af = ang(P[0], P[1]), ab = ang(P[5], P[4]);   // front and back sides, left to right
  const ar = ang(P[2], P[3]), al = ang(P[7], P[6]);   // right and left sides, front to back
  const ax = (af + ab) / 2, ay = (ar + al) / 2;
  const eps = ay - ax - Math.PI / 2;
  const par = Math.max(Math.abs(deg(af - ab)), Math.abs(deg(ar - al)));
  const mid = (p, q) => ({ x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 });
  const dot = (v, u) => v.x * u.x + v.y * u.y;
  const rm = mid(P[2], P[3]), lm = mid(P[6], P[7]), fm = mid(P[0], P[1]), bm = mid(P[4], P[5]);
  const w = dot({ x: rm.x - lm.x, y: rm.y - lm.y }, { x: Math.cos(ax), y: Math.sin(ax) }) - o.ball;
  const l = dot({ x: bm.x - fm.x, y: bm.y - fm.y }, { x: -Math.sin(ax), y: Math.cos(ax) }) - o.ball;
  const res = { eps, deg: deg(eps), drift400: 400 * Math.tan(eps), par, w, l, turn: deg(ax) };
  if (par > 0.05) return { ...res, error: `The block's opposite sides don't come out parallel (${par.toFixed(3)}° apart), so the block moved or a touch landed on dirt or a burr. Wipe the block and the bed, and try again.` };
  return res;
}

// Average of several runs (eps in radians)
export function squareAverage(runs) {
  const e = runs.reduce((s, x) => s + x.eps, 0) / runs.length;
  const spread = runs.length > 1 ? Math.max(...runs.map((x) => x.drift400)) - Math.min(...runs.map((x) => x.drift400)) : 0;
  return { eps: e, deg: deg(e), drift400: 400 * Math.tan(e), spread };
}

// Plain words for a result. mm(v) -> text with units
export function squareText(s, mm) {
  const d = Math.abs(s.drift400), dirn = s.drift400 > 0 ? "right (+X)" : "left (−X)";
  const verdict = d <= 0.1 ? "Square: nothing to do." : d <= 0.3 ? "Close: fine for most work, worth fixing for tight-fitting parts." : "Out of square: worth fixing.";
  const corner = (90 - Math.abs(s.deg)).toFixed(3), other = (90 + Math.abs(s.deg)).toFixed(3);
  return {
    head: `${mm(d)} over 400 mm`,
    verdict,
    detail: d < 0.005 ? "A square corner reads 90.000°." : `A square corner reads ${(90 + s.deg).toFixed(3)}°. Moving 400 mm in +Y, the machine moves ${mm(d)} to the ${dirn} of a true right angle. A square cut comes out with its ${s.deg > 0 ? "front-left and back-right" : "front-right and back-left"} corners at ${corner}° and the other two at ${other}°.`,
  };
}
