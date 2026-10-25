// Tool setter keep-out check (1.27.0, guard rules 1.34.0).  node src/react-ui/test/keepout.mjs
// Also writes test/keepout-parity.json for src/py/tests/test_setter_guard_parity.py, which checks
// that the controller (SetterGuard.py) refuses exactly the moves this screen check finds.
import { writeFileSync } from "fs";
import { setterClash, setterChecks, guardZone, segmentHits, guardText } from "../src/setter.js";
let ok = true;
const check = (name, cond, msg = "") => { console.log(`${cond ? "PASS" : "FAIL"} ${name} ${msg}`); ok &&= !!cond; };
const P = (...pts) => new Float32Array(pts.flat());

// Setter at machine X 400 Y 50. Work zero at machine X 300, Y 0, Z -50 -> setter at work X 100 Y 50.
// Reference: setter top at work Z +8 -> machine -42; with 2 mm clearance moves must stay above machine -40.
const setter = { x: 400, y: 50, keep: 30, ref: { ref: 8, offZ: -50, time: 0, by: "tool" } };
const state = { offset_x: 300, offset_y: 0, offset_z: -50 };
const opts = { zMax: 0 };

let c = setterChecks({ positions: P([0, 50, 15], [0, 50, 5], [200, 50, 5]) }, setter, state, 6.35, true, opts);
check("cut across the setter below its top is blocked", c[0].level === "stop" && c[0].block, c[0].text);
check("the message says how to fix it", /mark it removed/.test(c[0].text));
c = setterChecks({ positions: P([0, 50, 15], [200, 50, 15]) }, setter, state, 6.35, true, opts);
check("rapid over it 7 mm above the top is fine", c[0].level === "ok", c[0].text);
c = setterChecks({ positions: P([0, 90, 5], [200, 90, 5]) }, setter, state, 6.35, true, opts);
check("low cut 40 mm away is fine", c[0].level === "ok", c[0].text);
c = setterChecks({ positions: P([0, 83, 5], [200, 83, 5]) }, setter, state, 12.7, true, opts);
check("33 mm away with a 1/2 in cutter is blocked (cutter radius counted)", c[0].block === true);
c = setterChecks({ positions: P([0, 84, 5], [200, 84, 5]) }, setter, state, 3.175, true, opts);
check("34 mm away with a 1/8 in cutter clears 30 + 3.2 allowance", c[0].level === "ok", c[0].text);

// No valid reference: only moves with the spindle within 5 mm of the top of Z (machine -5 = work 45) count as safe
c = setterChecks({ positions: P([0, 50, 15], [200, 50, 15]) }, setter, { ...state, offset_z: -60 }, 6.35, true, opts);
check("no reference: passing over at work Z 15 is blocked", c[0].block === true, c[0].text);
check("no reference: the message suggests a reference", /take a setter reference/.test(c[0].text));
c = setterChecks({ positions: P([0, 50, 58], [200, 50, 58]) }, setter, { ...state, offset_z: -60 }, 6.35, true, opts);
check("no reference: over it with the spindle near the top is fine", c[0].level === "ok", c[0].text);

c = setterChecks({ positions: P([0, 50, 5], [200, 50, 5]) }, { ...setter, installed: false }, state, 6.35, true, opts);
check("marked removed: not checked, said so", c.length === 1 && c[0].level === "ok" && /removed/.test(c[0].text));
check("no setter saved: nothing reported", setterChecks({ positions: P([0, 0, 0], [1, 1, 1]) }, {}, state, 6.35, true, opts).length === 0);
c = setterChecks({ positions: P([0, 50, 5], [200, 50, 5]) }, { ...setter, ref: null }, state, 6.35, true, {});
check("not homed (no Z top) and no reference: warning", c[0].level === "warn");
c = setterChecks({ positions: P([0, 50, 5], [10, 50, 5]) }, setter, { ...state, offset_x: 395 }, 6.35, true, opts);
check("work zero moved onto the setter is blocked", c[0].block === true);

// Dry run: checked where the machine really goes (lifted, capped at the top)
c = setterChecks({ positions: P([0, 50, 5], [200, 50, 5]) }, setter, state, 6.35, true, { zMax: 0, dryLift: 20 });
check("dry run lifted 20 mm clears it", c[0].level === "ok", c[0].text);
c = setterChecks({ positions: P([0, 50, 5], [200, 50, 5]) }, setter, state, 6.35, true, { zMax: 0, dryLift: 3 });
check("dry run lifted 3 mm still blocked", c[0].block === true);

// Settings are honoured
c = setterChecks({ positions: P([0, 50, 12], [200, 50, 12]) }, { ...setter, zMargin: 5 }, state, 6.35, true, opts);
check("bigger clearance setting blocks a pass 4 mm above the top", c[0].block === true);
const z = guardZone({ ...setter, keep: 40, allow: 6.35 }, state, 0);
check("keep-out and allowance settings set the radius", Math.abs(z.r - 46.35) < 1e-9, z.r);
check("guard text: on with reference", /^On\. /.test(guardText(guardZone(setter, state, 0), setter, true)));
check("guard text: removed", /^Off: the setter is marked removed/.test(guardText(guardZone({ ...setter, installed: false }, state, 0), setter, true)));

// Speed: 300k segments
const big = new Float32Array(900003); for (let i = 0; i < big.length; i += 3) { big[i] = (i / 3) % 200; big[i + 1] = 0; big[i + 2] = -2; }
const zone = guardZone(setter, state, 0);
const t0 = performance.now(); setterClash(big, zone, { x: 300, y: 0, z: -50 }); const ms = performance.now() - t0;
check("300k segments checked quickly", ms < 300, `${ms.toFixed(0)} ms`);

// Parity cases for the controller: random moves around a setter, with the screen's verdict
let seed = 12345; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const cases = [];
for (let i = 0; i < 4000; i++) {
  const a = [340 + rnd() * 120, -10 + rnd() * 120, -70 + rnd() * 70];
  const b = rnd() < 0.2 ? [a[0], a[1], -70 + rnd() * 70] : [340 + rnd() * 120, -10 + rnd() * 120, -70 + rnd() * 70];
  cases.push({ a, b, hit: segmentHits(a, b, zone.x, zone.y, zone.r, zone.zLimit) !== null });
}
writeFileSync(new URL("./keepout-parity.json", import.meta.url), JSON.stringify({ setter, offset_z: state.offset_z, z_max: 0, zone, cases }));
check("parity cases written", cases.filter((k) => k.hit).length > 300, `${cases.filter((k) => k.hit).length} hits of ${cases.length}`);

console.log(ok ? "ALL PASS" : "SOME FAILED"); process.exit(ok ? 0 : 1);
