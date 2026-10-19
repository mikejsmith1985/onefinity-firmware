// Tool setter keep-out check (1.27.0).  node src/react-ui/test/keepout.mjs
import { setterClash, setterChecks } from "../src/setter.js";
let ok = true;
const check = (name, cond, msg = "") => { console.log(`${cond ? "PASS" : "FAIL"} ${name} ${msg}`); ok &&= !!cond; };
const P = (...pts) => new Float32Array(pts.flat());
// Setter at machine X 400 Y 50; work zero at machine X 300 Y 0 -> setter at work X 100 Y 50
const setter = { x: 400, y: 50, keep: 30, ref: { ref: -5, offZ: 10, time: 0, by: "tool" } };
const state = { offset_x: 300, offset_y: 0, offset_z: 10 };
// 1. a cut that passes right over the setter at Z -3 (setter top -5, margin 2 -> hazard below -3)
let c = setterChecks({ positions: P([0, 50, 5], [0, 50, -4], [200, 50, -4]) }, setter, state, 6.35);
check("cut through the setter area at Z -4 is stopped", c[0].level === "stop", c[0].text);
// 2. the same path lifted to Z +5 (rapids over the recessed setter) is fine
c = setterChecks({ positions: P([0, 50, 5], [200, 50, 5]) }, setter, state, 6.35);
check("rapid over it at Z 5 is fine", c[0].level === "ok", c[0].text);
// 3. a cut 40 mm away in Y (outside 30 + 3.175) is fine even at depth
c = setterChecks({ positions: P([0, 90, -4], [200, 90, -4]) }, setter, state, 6.35);
check("deep cut 40 mm away is fine", c[0].level === "ok", c[0].text);
// 4. 32 mm away: inside keep-out once the cutter radius is counted
c = setterChecks({ positions: P([0, 82, -4], [200, 82, -4]) }, setter, state, 6.35);
check("deep cut 32 mm away is stopped (cutter radius counted)", c[0].level === "stop");
// 5. no valid reference (Z zero changed): X/Y-only warning
c = setterChecks({ positions: P([0, 50, 5], [200, 50, 5]) }, setter, { ...state, offset_z: 99 }, 6.35);
check("no reference: passing over it is a warning, not a stop", c[0].level === "warn", c[0].text);
// 6. no setter saved: no check at all
check("no setter saved: nothing reported", setterChecks({ positions: P([0, 0, 0], [1, 1, 1]) }, {}, state, 6.35).length === 0);
// 7. work zero moved so the job now sits on the setter
c = setterChecks({ positions: P([0, 50, -4], [10, 50, -4]) }, setter, { ...state, offset_x: 395 }, 6.35);
check("work zero moved onto the setter is stopped", c[0].level === "stop");
// 8. speed: 300k segments
const big = new Float32Array(900003); for (let i = 0; i < big.length; i += 3) { big[i] = (i / 3) % 200; big[i + 1] = 0; big[i + 2] = -2; }
const t0 = performance.now(); setterClash(big, setter, { x: 300, y: 0 }, 3.175, -5); const ms = performance.now() - t0;
check("300k segments checked quickly", ms < 200, `${ms.toFixed(0)} ms`);
console.log(ok ? "ALL PASS" : "SOME FAILED"); process.exit(ok ? 0 : 1);
