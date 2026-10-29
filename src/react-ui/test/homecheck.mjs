// Homing check (1.42.0), against a model machine whose homing stops a few mm early.
//   node src/react-ui/test/homecheck.mjs
// The model keeps physical positions. The machine reads physical - shift (shift: how early this
// homing stopped); work = machine - offset. The setter is a fixed physical point. Programs are
// run by what they say: the centre-finding program reports touches around where the setter reads,
// G28.3 sets the machine reading (so changes the shift), G92 sets the work reading (so changes
// the offset), G53 G0 moves go to machine positions.
import { runHomeCheck, homeFixProgram, homeCheckDue, homeCheckText, HOMECHK } from "../src/homecheck.js";

let ok = true;
const check = (name, cond, msg = "") => { console.log(`${cond ? "PASS" : "FAIL"} ${name} ${msg}`); ok = ok && !!cond; };
const near = (a, b, e = 1e-3) => Math.abs(a - b) < e;

const SETTER = { x: 380.8, y: 381.2 }; // physical, in the reference homing's coordinates
function machine(shift) {
  const m = { shift: { ...shift }, phys: { x: 100, y: 120, z: -40 }, off: { x: 0, y: 0 }, progs: [], home_at: 1 };
  m.read = () => ({ x: m.phys.x - m.shift.x, y: m.phys.y - m.shift.y });
  m.state = () => { const r = m.read(); return { xp: r.x, yp: r.y, zp: m.phys.z, offset_x: m.off.x, offset_y: m.off.y, home_at: m.home_at, xx: "READY", cycle: "idle" }; };
  // work zero at a physical point
  m.zeroAt = (p) => { m.off = { x: p.x - m.shift.x, y: p.y - m.shift.y }; };
  m.workZeroPhys = () => ({ x: m.off.x + m.shift.x, y: m.off.y + m.shift.y });
  m.run = async (prog) => {
    m.progs.push(prog);
    const out = {};
    if (prog.includes("(Tool setter: find centre)")) {
      const R = 14.43, cx = SETTER.x - m.shift.x, cy = SETTER.y - m.shift.y;
      const [sx, sy] = /G53 G0 X(-?[\d.]+) Y(-?[\d.]+)/.exec(prog).slice(1).map(Number);
      if (Math.hypot(sx - cx, sy - cy) > 12) return { ...m.state(), ofx_ok: 0, ofx_fail: 1 };
      for (let i = 0; i < 8; i++) { const a = (i * Math.PI) / 4; Object.assign(out, { [`ofx_p${i}`]: 1, [`ofx_x${i}`]: cx + R * Math.cos(a), [`ofx_y${i}`]: cy + R * Math.sin(a) }); }
      Object.assign(out, { ofx_ok: 1, ofx_fail: 0, ofx_top: -61.8 });
      // ends over the last direction's start, at the top
      m.phys = { x: SETTER.x + 25 * Math.cos(7 * Math.PI / 4), y: SETTER.y + 25 * Math.sin(7 * Math.PI / 4), z: -1 };
      return { ...m.state(), ...out };
    }
    for (const line of prog.split("\n")) {
      let g;
      if ((g = /^G28\.3 X(-?[\d.]+) Y(-?[\d.]+)/.exec(line))) { m.shift = { x: m.phys.x - +g[1], y: m.phys.y - +g[2] }; }
      else if ((g = /^G92 (.*)/.exec(line))) {
        const r = m.read();
        for (const [, a, v] of g[1].matchAll(/([XY])(-?[\d.]+)/g)) { if (a === "X") m.off.x = r.x - +v; else m.off.y = r.y - +v; }
      } else if ((g = /^G53 G0 X(-?[\d.]+) Y(-?[\d.]+)/.exec(line))) { m.phys.x = +g[1] + m.shift.x; m.phys.y = +g[2] + m.shift.y; }
      else if ((g = /^G53 G0 Z(-?[\d.]+)/.exec(line))) { m.phys.z = +g[1]; }
    }
    return m.state();
  };
  return m;
}
const deps = (m, store) => ({
  run: m.run, getSetter: async () => ({ ...store.s }), saveSetter: async (s) => { store.s = s; },
  args: (s) => ({ setter: { x: s.x, y: s.y, z: -62 }, top: -1, clear: 30, travel: 1000, fast: 200, slow: 25 }),
  state: m.state(), lim: { x0: 0, x1: 410, y0: 0, y1: 410 },
});
const fmt = (mm) => `${mm.toFixed(2)} mm`;

// 1. First check: this homing becomes the reference (no shift: a good homing)
let m = machine({ x: 0, y: 0 });
const store = { s: { x: 378, y: 383, z: -62, installed: true } };  // saved roughly
check("a check is due after homing", homeCheckDue(m.state(), store.s));
let r = await runHomeCheck(deps(m, store));
check("first check: the setter's centre is saved as the reference", r.ok && r.adopted && near(store.s.href.x, SETTER.x) && near(store.s.href.y, SETTER.y) && near(store.s.x, SETTER.x), JSON.stringify(store.s.href));
check("  nothing shifted (no G28.3)", !m.progs.some((p) => p.includes("G28.3")));
check("  back where it started", near(m.phys.x, 100) && near(m.phys.y, 120) && near(m.phys.z, -40), JSON.stringify(m.phys));
check("  not due again on the same homing", !homeCheckDue(m.state(), store.s));
console.log("   ", homeCheckText(r, fmt));

// 2. Next session: homing stopped 5.2 / 4.9 mm early (the dust hose), work zero set before the check
m = machine({ x: -5.2, y: -4.9 }); m.home_at = 2;
m.zeroAt({ x: 150, y: 160 });
const zero0 = m.workZeroPhys();
check("a new homing: due again", homeCheckDue(m.state(), store.s));
r = await runHomeCheck(deps(m, store));
const rc = m.read(), sc = { x: SETTER.x - m.shift.x, y: SETTER.y - m.shift.y };
check("homing 5.2/4.9 mm off: found and corrected", r.ok && r.fixed && near(r.dist, Math.hypot(5.2, 4.9)), homeCheckText(r, fmt));
check("  the setter's centre now reads the reference", near(sc.x, SETTER.x) && near(sc.y, SETTER.y), JSON.stringify(sc));
check("  the machine reads as on the reference homing (shift gone)", near(m.shift.x, 0) && near(m.shift.y, 0), JSON.stringify(m.shift));
const zero1 = m.workZeroPhys();
check("  the work zero didn't move physically", near(zero0.x, zero1.x) && near(zero0.y, zero1.y), `${JSON.stringify(zero0)} -> ${JSON.stringify(zero1)}`);
check("  the probe is back over the same physical spot and height", near(m.phys.x, 100) && near(m.phys.y, 120) && near(m.phys.z, -40), JSON.stringify(m.phys));
check("  reported as more than homing should vary", r.big && /dragging/.test(homeCheckText(r, fmt)));
check("  logged", store.s.hlog.length === 2 && store.s.hchk.at === 2);
const fixProg = m.progs[m.progs.length - 1];
check("  the program: G28.3 then G92 then the way back, starts as a setter routine", /^\(Tool setter: homing check\)/.test(fixProg) && fixProg.indexOf("G28.3") < fixProg.indexOf("G92") && fixProg.indexOf("G92") < fixProg.lastIndexOf("G53 G0 X"), "\n" + fixProg);

// 3. A small slip: corrected, not called a problem
m = machine({ x: 0.18, y: -0.07 }); m.home_at = 3;
r = await runHomeCheck(deps(m, store));
check("0.19 mm off: corrected quietly", r.ok && r.fixed && !r.big && near(m.shift.x, 0) && near(m.shift.y, 0), homeCheckText(r, fmt));
// 4. Within 0.05 mm: left alone
m = machine({ x: 0.02, y: 0.01 }); m.home_at = 4;
r = await runHomeCheck(deps(m, store));
check("0.02 mm off: left alone, called spot on", r.ok && !r.fixed && !m.progs.some((p) => p.includes("G28.3")) && /spot on/.test(homeCheckText(r, fmt)));
// 5. No work zero set (offset 0): no G92, so no zero is made up
m = machine({ x: -1, y: 2 }); m.home_at = 5;
r = await runHomeCheck(deps(m, store));
check("no work zero set: corrected without a G92", r.ok && r.fixed && !m.progs[m.progs.length - 1].includes("G92"));
// 6. Far off (setter moved): nothing changed
const store2 = { s: { ...store.s, href: { x: SETTER.x + 20, y: SETTER.y, time: 1 }, x: SETTER.x + 3, y: SETTER.y } };
m = machine({ x: 0, y: 0 }); m.home_at = 6;
r = await runHomeCheck(deps(m, store2));
check("20 mm from the reference: refused, nothing shifted, still due", !!r.error && !m.progs.some((p) => p.includes("G28.3")) && homeCheckDue(m.state(), store2.s), r.error);
check("  and back where it started", near(m.phys.x, 100) && near(m.phys.y, 120));
// 7. The setter not found: error, nothing saved
const store3 = { s: { ...store.s, x: SETTER.x + 30 } };
m = machine({ x: 0, y: 0 }); m.home_at = 7;
r = await runHomeCheck(deps(m, store3));
check("setter not under the probe: says so, nothing changed", !!r.error && !m.progs.some((p) => p.includes("G28.3")) && homeCheckDue(m.state(), store3.s), r.error);
// 8. The way back is kept inside the travel
const p8 = homeFixProgram({ now: { x: 380, y: 380 }, off: {}, d: { x: -3, y: 0 }, back: { x: 1, y: 409, z: -5 }, top: -1, lim: { x0: 0, x1: 410, y0: 0, y1: 410 } });
check("the way back stays inside the travel", /G53 G0 X0 Y409\n/.test(p8), p8);
// 9. Not due without a homing id, or with the setter lifted out
check("no homing id (older controller or not homed): not due", !homeCheckDue({}, store.s));
check("setter lifted out: not due", !homeCheckDue({ home_at: 99 }, { ...store.s, installed: false }));
check("quiet threshold is 0.05 mm, refuse above 12 mm", HOMECHK.quiet === 0.05 && HOMECHK.max === 12);

console.log(ok ? "ALL PASS" : "SOME FAILED"); process.exit(ok ? 0 : 1);
