import { marker, STEP_RESET } from "./progress.js";
// Bore centre with the 3D probe (1.31.0), for lining up side B on reference bores.
//
// The stylus goes over the bore at travel height, then down into it, both as guarded moves (G38.3):
// if it touches anything on the way (a clamp, or solid stock because it isn't over the bore) the move
// stops, #<_ofb_fail> says which one, and the stylus lifts. Inside the bore it touches the +X and -X
// walls (fast seek, back off 1 mm, slow seek) and moves to the middle, then the same in Y, then X and
// Y again from the middle: 8 touches.
//
// Frames: the middle is reached with relative moves worked out from differences between touches,
// so it doesn't matter whether #5061 to #5063 hold work or machine coordinates (the open question
// from 1.29.0): both give the same physical middle. The UI then reads the machine position the
// controller reports (xp, yp) once the program has ended, with the stylus still over the middle.
// Diameters and the repeat check are differences too.
//
// Published (all mm): ofb_ok, ofb_fail, ofb_done (this run's token, only when it finished),
// ofb_dx, ofb_dy (diameter from the second X and Y touches), ofb_sx, ofb_sy (how far the middle
// moved between the first and second touches).

export const BORE_DEFAULTS = {
  depth: 3,       // touch depth below the top (Z0), mm
  clear: 5,       // travel height above Z0, mm
  travel: 1000,   // mm/min for guarded travel
  diaTol: 0.25,   // measured diameter may differ from the sheet by this much
  roundTol: 0.08, // X and Y diameters may differ by this much
  repeatTol: 0.03 // the middle may move this much between the two rounds of touches
};

export const BORE_FAILS = {
  1: "The stylus touched something while moving over the bore at travel height. Look for a clamp in the way, or raise the travel height.",
  2: "The stylus touched solid stock at every spot it tried, so it never found the bore. Jog it over the bore by eye and use Probe here, or check that the stock was turned over the way the setup sheet says.",
};

const n = (v) => {
  const s = (Math.round(v * 10000) / 10000).toFixed(4).replace(/\.?0+$/, "");
  return s === "-0" ? "0" : s;
};

export function checkBore(o) {
  const errs = [];
  if (!(o.d >= 2 && o.d <= 60)) errs.push("Bore diameter must be 2 to 60 mm.");
  if (!(o.ball >= 0 && o.ball < o.d - 1)) errs.push("The stylus ball must be at least 1 mm smaller than the bore.");
  if (!(o.depth >= 1 && o.depth <= 20)) errs.push("Touch depth must be 1 to 20 mm.");
  if (!(o.clear >= 2 && o.clear <= 50)) errs.push("Travel height must be 2 to 50 mm.");
  if (!(o.fast > 0 && o.slow > 0)) errs.push("Probe seek speeds are not set.");
  if (!(typeof o.fromZ === "number" && o.fromZ > 0.5)) errs.push("Lift the stylus above the stock top (Z0) first.");
  return errs;
}

// o: {d, ball, depth, clear, travel, fast, slow, fromX, fromY, fromZ (current work position), targets: [{x, y}] work mm, tried
//     in order until the stylus goes down into the bore (null: start where the stylus is), token, name}
export function boreProgram(o) {
  const S = n(o.d - o.ball + 2); // search: wall to wall plus margin
  let id = 500;
  const out = [];
  const add = (s) => out.push(s);
  const mark = marker(); // which move is running, for the screen (1.31.1)
  const guard = (body) => { const k = id++; add(`o${k} if [#<_ofb_fail> EQ 0]\n${body}\no${k} endif`); };
  const onHit = (code, after) => { const k = id++; return `o${k} if [#5070 EQ 1]\n#<_ofb_fail> = ${code}\n${after}\no${k} endif`; };

  add(`(Bore centre${o.name ? ` ${String(o.name).replace(/[()]/g, "")}` : ""})
G21
M5
#<_ofb_ok> = 0
#<_ofb_fail> = 0
#<_ofb_done> = 0
#<_ofb_in> = 0
#<_ofb_miss> = 0
${STEP_RESET}
G90`);
  // Only ever rapid up. Every move across or down is guarded.
  if (o.fromZ < o.clear - 0.01) add(`${mark("Go up to travel height")}\nG0 Z${n(o.clear)}`);
  const spots = o.targets && o.targets.length ? o.targets : [null];
  // On contact while travelling, back 1 mm off the way it came before lifting
  let from = typeof o.fromX === "number" && typeof o.fromY === "number" ? { x: o.fromX, y: o.fromY } : null;
  const backOff = (t) => {
    if (!from) return "G91 G0 Z3\nG90";
    const dx = t.x - from.x, dy = t.y - from.y, l = Math.hypot(dx, dy);
    return l > 0.01 ? `G91 G1 X${n(-dx / l)} Y${n(-dy / l)} F${o.fast}\nG91 G0 Z3\nG90` : "G91 G0 Z3\nG90";
  };
  spots.forEach((t, j) => {
    const k1 = id++, k2 = id++;
    let body = "";
    const sp = spots.length > 1 ? ` ${j + 1} of ${spots.length}` : "";
    if (t) { body += `${mark(`Move over the bore, spot${sp}, guarded`)}\nG38.3 X${n(t.x)} Y${n(t.y)} F${o.travel}\n${onHit(1, backOff(t))}\n`; from = t; }
    if (j === 0 && o.fromZ > o.clear + 0.01) { const k = id++; body += `o${k} if [#<_ofb_fail> EQ 0]\n${mark("Go down to travel height, guarded")}\nG38.3 Z${n(o.clear)} F${o.travel}\n${onHit(1, "G91 G0 Z3\nG90")}\no${k} endif\n`; }
    // Down: into the bore, or onto solid stock (then lift and try the next spot)
    const k3 = id++, k4 = id++;
    body += `o${k3} if [#<_ofb_fail> EQ 0]
${mark(`Go down into the bore${sp}, guarded`)}
G38.3 Z${n(-o.depth)} F${o.fast}
o${k4} if [#5070 EQ 1]
#<_ofb_miss> = [#<_ofb_miss> + 1]
G90 G0 Z${n(o.clear)}
o${k4} else
#<_ofb_in> = ${j + 1}
o${k4} endif
o${k3} endif`;
    add(`o${k1} if [#<_ofb_in> EQ 0]\no${k2} if [#<_ofb_fail> EQ 0]\n${body}\no${k2} endif\no${k1} endif`);
  });
  add(`o${id} if [#<_ofb_in> EQ 0]\no${id + 1} if [#<_ofb_fail> EQ 0]\n#<_ofb_fail> = 2\no${id + 1} endif\no${id} endif`);
  id += 2;

  const P = { X: "#5061", Y: "#5062" };
  const round = (A, i) => {
    const a = A.toLowerCase(), p = P[A];
    guard(`${mark(`Touch the ${A} walls, round ${i}`)}
G91 G38.2 ${A}${S} F${o.fast}
G91 G1 ${A}-1 F${o.fast}
G91 G38.2 ${A}2 F${o.slow}
#<_ofb_${a}p${i}> = ${p}
G91 G1 ${A}-1 F${o.fast}
G91 G38.2 ${A}-${S} F${o.fast}
G91 G1 ${A}1 F${o.fast}
G91 G38.2 ${A}-2 F${o.slow}
#<_ofb_${a}m${i}> = ${p}
G91 G1 ${A}[[#<_ofb_${a}p${i}> + #<_ofb_${a}m${i}>] / 2 - ${p}] F${o.travel}
G90`);
  };
  round("X", 1); round("Y", 1); round("X", 2); round("Y", 2);
  guard(`#<_ofb_dx> = [#<_ofb_xp2> - #<_ofb_xm2> + ${n(o.ball)}]
#<_ofb_dy> = [#<_ofb_yp2> - #<_ofb_ym2> + ${n(o.ball)}]
#<_ofb_sx> = [[#<_ofb_xp2> + #<_ofb_xm2>] / 2 - [#<_ofb_xp1> + #<_ofb_xm1>] / 2]
#<_ofb_sy> = [[#<_ofb_yp2> + #<_ofb_ym2>] / 2 - [#<_ofb_yp1> + #<_ofb_ym1>] / 2]
#<_ofb_ok> = 1`);
  // Straight up out of the middle of the bore, whatever happened
  add(`${mark("Lift out of the bore")}\nG90 G0 Z${n(o.clear)}`);
  add(`o${id} if [#<_ofb_ok> EQ 1]\n#<_ofb_done> = ${o.token || 1}\no${id} endif`);
  add("M2");
  return out.join("\n") + "\n";
}

// Spots to try for a bore, as work X/Y. pred: predicted position. The unknowns are a shift (slack, mm)
// and a turn of up to searchDeg degrees about a point `dist` mm away in direction `along` (a unit
// vector from that point to the bore): about the zero corner for the first bore, about the bore
// already measured for the next ones (then the shift is known: slack 0). A turn moves the bore across
// that line, so the spots go across it, both ways, a little less than the capture width apart, then
// a cross round the prediction for the shift.
export function boreSpots(pred, d, ball, { along = null, dist = 0, searchDeg = 2, slack = 2 } = {}) {
  const step = Math.max(0.5, d - ball - 0.5);
  const spots = [{ x: pred.x, y: pred.y }];
  const capture = (d - ball) / 2;
  if (along && dist > 0) {
    const px = -along.y, py = along.x;
    const reach = dist * Math.tan((searchDeg * Math.PI) / 180) + slack;
    const k = Math.min(8, Math.ceil(Math.max(0, reach - capture) / step));
    for (let i = 1; i <= k; i++) for (const s of [1, -1]) spots.push({ x: pred.x + s * i * step * px, y: pred.y + s * i * step * py });
  }
  if (slack > capture) {
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) spots.push({ x: pred.x + dx * step, y: pred.y + dy * step });
  }
  return spots;
}

// The order to measure bores in: nearest the zero first (the turn moves it least).
export const boreOrder = (refs) => refs.map((r, i) => [Math.hypot(r.x, r.y), i]).sort((a, b) => a[0] - b[0]).map(([, i]) => i);

// Judges one bore measurement. r: {dx, dy, sx, sy}, d: sheet diameter.
export function boreVerdict(r, d, o = BORE_DEFAULTS) {
  const probs = [];
  const dia = (r.dx + r.dy) / 2, round = Math.abs(r.dx - r.dy), rep = Math.hypot(r.sx || 0, r.sy || 0);
  if (Math.abs(dia - d) > o.diaTol) probs.push(`It measures ${dia.toFixed(3)} mm across, but the setup sheet says ${d} mm. This may not be the right bore, or the stylus size is wrong (calibrate it).`);
  if (round > o.roundTol) probs.push(`It is ${round.toFixed(3)} mm out of round (X ${r.dx.toFixed(3)}, Y ${r.dy.toFixed(3)} mm). Blow out chips and dust and measure again.`);
  if (rep > o.repeatTol) probs.push(`The middle moved ${rep.toFixed(3)} mm between the two rounds of touches. Check that the stock and the probe are tight, and measure again.`);
  return { ok: probs.length === 0, dia, round, rep, probs };
}
