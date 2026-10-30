// Hands-off probe tuning (1.48.0): the stylus calibration 3 times, then the squareness check 3
// times, on a 1-2-3 block, as ONE program on the controller.
//
// One program, so nothing depends on a screen staying awake between runs: a phone can sleep or
// go away and the machine carries on. Every run's results are copied into their own variables
// (#<_oft_*>), and any screen works them out and saves them afterwards (tuneResults below).
//
// Each run starts from where the stylus was at Start (up to the top of Z, across, down again),
// so every run is the same as a run started by hand from there. The runs are the programs the
// screens already use (measure.js calibration, square.js), with their block numbers moved so
// they don't repeat. A run that doesn't finish stops the rest (#<_oft_abort>), and a touch that
// finds nothing E-stops the controller as always.
import { measureProgram, MEASURE_DEFAULTS } from "./measure.js";
import { squareProgram, squareResult, squareAverage } from "./square.js";

export const TUNE = { calRuns: 3, sqRuns: 3, calSpread: 0.05, sqSpread: 0.15 };

const n = (v) => {
  const s = (Math.round(v * 10000) / 10000).toFixed(4).replace(/\.?0+$/, "");
  return s === "-0" ? "0" : s;
};
// A run's program without its own end, with its block numbers moved by `by`
function body(prog, by) {
  return prog.split("\n")
    .filter((l) => l.trim() !== "M2")
    .map((l) => l.replace(/^o(\d+)(\s)/, (m, d, sp) => `o${Number(d) + by}${sp}`))
    .join("\n");
}

// o: {a, b: block size along X and Y; ball: stylus ball now; start: {x, y, z} machine (where the
//     stylus was at Start); top: machine Z to travel at; fast, slow; travel; token; measure: the
//     saved Measure stock settings (clear, depth, margin)}
export function tuneProgram(o) {
  const m = { ...MEASURE_DEFAULTS, ...(o.measure || {}) };
  const back = ["G90", `G53 G0 Z${n(o.top)}`, `G53 G0 X${n(o.start.x)} Y${n(o.start.y)}`, `G53 G0 Z${n(o.start.z)}`];
  const L = [`(Probe tuning: stylus x${TUNE.calRuns}, squareness x${TUNE.sqRuns}, block ${n(o.a)} x ${n(o.b)})`, "G21", "M5",
    "#<_oft_abort> = 0", "#<_oft_run> = 0", "#<_oft_done> = 0",
    // everything copied below is set first, so a run that stops early copies 0s, never an unset name
    "#<_ofm_rxa> = 0", "#<_ofm_rxb> = 0", "#<_ofm_ok> = 0", "#<_ofq_ok> = 0", "#<_ofq_fail> = 0",
    ...[...Array(8)].flatMap((_, j) => [`#<_ofq_x${j}> = 0`, `#<_ofq_y${j}> = 0`])];
  let k = 0;
  const run = (kind, i, prog, copy, okVar) => {
    k++;
    L.push(`o${9000 + k} if [#<_oft_abort> EQ 0]`, `#<_oft_run> = ${k}`, ...back, body(prog, 1000 * k),
      ...copy, `o${9100 + k} if [${okVar} NE 1]`, "#<_oft_abort> = 1", `o${9100 + k} endif`, `o${9000 + k} endif`);
  };
  for (let i = 1; i <= TUNE.calRuns; i++) {
    const prog = measureProgram({ ...m, w: o.a, l: o.b, probeY: false, origin: "center-x", calibrate: true, ball: o.ball, fast: o.fast, slow: o.slow });
    run("cal", i, prog, [`#<_oft_c${i}a> = #<_ofm_rxa>`, `#<_oft_c${i}b> = #<_ofm_rxb>`, `#<_oft_c${i}ok> = #<_ofm_ok>`], "#<_ofm_ok>");
  }
  for (let i = 1; i <= TUNE.sqRuns; i++) {
    const prog = squareProgram({ a: o.a, b: o.b, ball: o.ball, top: o.top, fast: o.fast, slow: o.slow });
    const copy = [`#<_oft_s${i}ok> = #<_ofq_ok>`, `#<_oft_s${i}fail> = #<_ofq_fail>`];
    for (let j = 0; j < 8; j++) copy.push(`#<_oft_s${i}x${j}> = #<_ofq_x${j}>`, `#<_oft_s${i}y${j}> = #<_ofq_y${j}>`);
    run("sq", i, prog, copy, "#<_ofq_ok>");
  }
  L.push("G90", `G53 G0 Z${n(o.top)}`, `G53 G0 X${n(o.start.x)} Y${n(o.start.y)}`,
    "o9999 if [#<_oft_abort> EQ 0]", `#<_oft_done> = ${o.token}`, "o9999 endif", "G90", "M2");
  return L.join("\n") + "\n";
}

// The results from the controller's state (oft_*). o: {a, b, token}
// -> {done, balls, ball, calSpread, calOk, square: [{...squareResult}], avg, sqOk, problems: []}
export function tuneResults(st, o) {
  const out = { done: st.oft_done === o.token, balls: [], square: [], problems: [] };
  // The squareness runs first: they say how the block's ends are turned. The stylus runs touch the
  // ends along X, so on a block turned by a the ends are (block + ball) / cos a apart along X: on
  // the machine's own block turned 1.5 degrees that's 0.026 mm, all of it wrongly put on the ball.
  // (Squareness doesn't depend on the ball; only the block size it reports does.)
  const sq = [];
  for (let i = 1; i <= TUNE.sqRuns; i++) {
    if (st[`oft_s${i}ok`] === undefined) continue;
    const r = { ofq_ok: st[`oft_s${i}ok`], ofq_fail: st[`oft_s${i}fail`] };
    for (let j = 0; j < 8; j++) { r[`ofq_x${j}`] = st[`oft_s${i}x${j}`]; r[`ofq_y${j}`] = st[`oft_s${i}y${j}`]; }
    sq.push({ i, r, first: squareResult(r, { a: o.a, b: o.b, ball: o.ball ?? 2 }) });
  }
  const good = sq.filter((x) => !x.first.error);
  // the ends' normal: the X-direction sides' turn plus the skew (the ends are the Y-direction sides)
  out.endTurn = good.length ? good.reduce((s, x) => s + (x.first.turn * Math.PI) / 180 + x.first.eps, 0) / good.length : null;
  const cosA = out.endTurn === null ? 1 : Math.cos(out.endTurn);
  for (let i = 1; i <= TUNE.calRuns; i++) {
    if (st[`oft_c${i}ok`] !== 1) continue;
    const b = Math.abs(st[`oft_c${i}b`] - st[`oft_c${i}a`]) * cosA - o.a;
    if (b > 0.3 && b < 10) out.balls.push(b);
    else out.problems.push(`Stylus run ${i} gave a ball of ${b.toFixed(3)} mm, which can't be right.`);
  }
  if (out.balls.length) {
    out.ball = out.balls.reduce((s, x) => s + x, 0) / out.balls.length;
    out.calSpread = Math.max(...out.balls) - Math.min(...out.balls);
  }
  out.calOk = out.balls.length === TUNE.calRuns && out.calSpread <= TUNE.calSpread && out.endTurn !== null;
  if (out.balls.length === TUNE.calRuns && out.calSpread > TUNE.calSpread) out.problems.push(`The stylus runs differ by ${out.calSpread.toFixed(3)} mm, more than ${TUNE.calSpread}. Check the probe is tight in the collet and the block didn't move.`);
  if (out.balls.length && out.endTurn === null) out.problems.push("The squareness runs didn't finish, so the stylus size couldn't be corrected for how the block is turned. It wasn't saved.");
  const ball = out.ball ?? o.ball ?? 2;
  for (const { i, r } of sq) {
    const res = squareResult(r, { a: o.a, b: o.b, ball });
    if (res.error) out.problems.push(`Squareness run ${i}: ${res.error}`);
    else out.square.push(res);
  }
  if (out.square.length) out.avg = squareAverage(out.square);
  out.sqOk = out.square.length === TUNE.sqRuns && out.avg.spread <= TUNE.sqSpread;
  if (out.square.length === TUNE.sqRuns && !out.sqOk) out.problems.push(`The squareness runs differ by ${out.avg.spread.toFixed(2)} mm over 400 mm. Check the block hasn't moved and nothing is on it.`);
  return out;
}
