// Progress marks in every probing program (1.31.1).  node src/react-ui/test/progress.mjs
// Each program numbers its moves with #<_of_step> = N (label); the screens read the labels back
// (progress.js) and show the one the controller reports as running (state of_step).
import { programMoves, moveStatus, STEP_RESET } from "../src/progress.js";
import { probeProgram, centerSecondProgram } from "../src/probe.js";
import { measureProgram, MEASURE_DEFAULTS } from "../src/measure.js";
import { setterProgram, setterTouchProgram } from "../src/setter.js";
import { boreProgram, BORE_DEFAULTS } from "../src/bore.js";
import { overStockProgram } from "../src/wizard.js";
let ok = true;
const check = (name, cond, msg = "") => { console.log(`${cond ? "PASS" : "FAIL"} ${name} ${msg}`); ok &&= !!cond; };

const config = { probe: { "probe-xdim": 53.975, "probe-ydim": 53.975, "probe-zdim": 15.4, "probe-slow-seek": 25, "probe-fast-seek": 75 },
  "probe-rotary": { "probe-xdim": 40, "probe-ydim": 40, "probe-zdim": 12, "probe-slow-seek": 25, "probe-fast-seek": 75 } };
const dia = { mm: 6.35 };
const m = { ...MEASURE_DEFAULTS, w: 100, l: 60, fast: 75, slow: 25, origin: "front-left" };
const st = { setter: { x: 10, y: 20, z: -80 }, top: -1, back: { x: 0, y: 0 }, clear: 20, travel: 1000, fast: 75, slow: 25 };
const progs = {
  "probe z": probeProgram({ config, type: "z", dia, token: 7 }),
  "probe rotary": probeProgram({ config, type: "xyz", rotary: true, dia, token: 7 }),
  ...Object.fromEntries(["front-left", "front-right", "back-left", "back-right", "center", "center-x"].map((loc) =>
    [`probe ${loc}`, probeProgram({ config, type: loc.startsWith("center") ? "center" : "xyz", loc, dia, token: 7 })])),
  "probe center 2": centerSecondProgram({ config, loc: "center", dia, token: 7 }),
  "probe center-x 2": centerSecondProgram({ config, loc: "center-x", dia, token: 7 }),
  "measure X": measureProgram({ ...m, probeY: false, origin: "center-x", token: 5 }),
  "measure XY": measureProgram({ ...m, probeY: true, token: 5 }),
  "measure calib": measureProgram({ ...m, probeY: false, calibrate: true }),
  "setter ref": setterProgram({ ...st, mode: "ref" }),
  "setter tool": setterProgram({ ...st, mode: "tool", ref: -40 }),
  "setter touch": setterTouchProgram({ ...st, token: 3 }),
  "bore": boreProgram({ ...BORE_DEFAULTS, d: 10, ball: 2, depth: 4, clear: 5, travel: 1000, fast: 75, slow: 25, fromX: 0, fromY: 0, fromZ: 20, targets: [{ x: 10, y: 10 }, { x: 12, y: 10 }], token: 9 }),
  "over stock": overStockProgram({ last: { x: 100, y: 100, ztop: -60 }, top: -1, token: 4 }),
};
for (const [name, p] of Object.entries(progs)) {
  const L = p.split("\n").map((l) => l.trim());
  const mv = programMoves(p);
  const iReset = L.indexOf(STEP_RESET), iFirst = L.findIndex((l) => l.startsWith("#<_of_step> = 1 "));
  check(`${name}: reset before the first mark`, iReset >= 0 && iReset < iFirst, `${iReset} ${iFirst}`);
  check(`${name}: marks numbered 1..${mv.length} in order, all labelled`, mv.length >= 2 && mv.every((x, i) => x.n === i + 1 && x.label.length > 3), mv.map((x) => x.n).join());
  const firstMove = L.findIndex((l) => /^(G9[01] )?(G53 )?G(0|1|38\.[23]) /.test(l) || /^G9[01] G53 G0 /.test(l));
  check(`${name}: no move before the first mark`, firstMove > iFirst, `${firstMove} ${iFirst}`);
  check(`${name}: every probing move has a mark since the last one`, L.every((l, i) => !/G38\.[23]/.test(l) || L.slice(0, i).some((x) => x.startsWith("#<_of_step> = ") && x !== STEP_RESET)));
}
const fl = programMoves(progs["probe front-left"]).map((x) => x.label);
check("front-left labels", fl.join(" | ") === "Touch the block top | Move out past the left face | Go down beside the block, guarded | Touch the left face | Move along the left face, guarded | Move round to the front face, guarded | Touch the front face | Lift clear", fl.join(" | "));
const br = programMoves(progs["probe back-right"]).map((x) => x.label);
check("back-right names its faces", br.includes("Touch the right face") && br.includes("Touch the back face"), br.join(" | "));
const s = moveStatus(programMoves(progs["probe front-left"]), 3);
check("moveStatus", s.cur === 2 && s.of === 8 && s.label.startsWith("Go down") && moveStatus([], 0).cur === -1);
console.log(ok ? "ALL PASS" : "SOME FAILED"); process.exit(ok ? 0 : 1);
