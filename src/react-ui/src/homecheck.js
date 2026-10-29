// Homing check (1.42.0).
//
// Stall homing stops wherever the motor feels enough resistance. A dust hose that drags makes it
// stop early, so X and Y can come out a few millimetres different from one homing to the next (on
// the machine: about 5 mm between two sessions). Everything kept in machine coordinates moves with
// it: the tool setter's position, the carved crosses, the bed camera's calibration.
//
// The tool setter is bolted to the table, so its centre is a fixed point. The 3D probe finds it to
// about 0.01 mm (setter.js, 1.40). The first time the probe is used after a homing, the centre is
// found and compared with the reference (the centre found on an earlier, good homing). The machine
// position is then shifted by the difference (G28.3 sets it, as homing itself does), so the setter's
// centre reads the same as on that homing and everything else lines up again. The work zero stays
// where it physically is (G92), and the probe goes back to where it started.
//
// The first check ever (no reference yet) takes this homing as the reference.
import { findSetterCentre } from "./setter.js";
import { computeAxis } from "./axis.js";

// The machine's X/Y travel, for keeping the way back inside it
export function travelLim(state, config) {
  try {
    const x = computeAxis(state, config, "x", true), y = computeAxis(state, config, "y", true);
    return { x0: x.min, x1: x.max, y0: y.min, y1: y.max };
  } catch { return {}; }
}

export const HOMECHK = {
  quiet: 0.05, // mm: closer than this is left as it is
  warn: 1,     // mm: more than this is reported as a homing problem (a dragging hose, a slipping coupler)
  max: 12,     // mm: more than this isn't corrected (the setter was moved, or this isn't the setter)
  keep: 10,    // checks kept in the log
};

const n = (v) => {
  const s = (Math.round(v * 10000) / 10000).toFixed(4).replace(/\.?0+$/, "");
  return s === "-0" ? "0" : s;
};
const num = (v) => typeof v === "number" && isFinite(v);

// Is a check due? state: controller state (home_at: the id of the last X/Y homing);
// setter: saved setter record.
export function homeCheckDue(state, setter) {
  if (!setter || !num(setter.x) || !num(setter.y) || setter.installed === false) return false;
  if (!num(state?.home_at)) return false;
  return !setter.hchk || setter.hchk.at !== state.home_at;
}

// Where the machine should be after the check: its position shifted by d, kept inside the travel
// (lim: {x0, x1, y0, y1, z1} machine mm).
const clamp = (v, lo, hi) => (num(lo) && v < lo ? lo : num(hi) && v > hi ? hi : v);

// The correction and the way back, run after the centre was found.
// o: {now: {x, y} machine position when it runs (over the setter, at the top of Z),
//     off: {x, y} work offsets (machine = work + offset), d: {x, y} shift (0 for none),
//     back: {x, y, z} where the probe was before the check (machine, before the shift),
//     top: machine Z to travel at, lim}
export function homeFixProgram(o) {
  const d = o.d || { x: 0, y: 0 }, lim = o.lim || {};
  const shift = Math.hypot(d.x, d.y) > 0;
  const L = ["(Tool setter: homing check)", "G21", "G90", `G53 G0 Z${n(o.top)}`];
  if (shift) {
    // The machine position, moved by d: from here on the setter's centre reads the reference
    L.push(`G28.3 X${n(o.now.x + d.x)} Y${n(o.now.y + d.y)}`);
    // The work zero stays where it physically is: the position keeps its old work value.
    // (An axis with no work zero set has offset 0 and is left alone.)
    const w = [];
    if (num(o.off?.x) && Math.abs(o.off.x) > 1e-9) w.push(`X${n(o.now.x - o.off.x)}`);
    if (num(o.off?.y) && Math.abs(o.off.y) > 1e-9) w.push(`Y${n(o.now.y - o.off.y)}`);
    if (w.length) L.push(`G92 ${w.join(" ")}`);
  }
  if (o.back) {
    // Back over the same physical spot, then down to the same height
    const bx = clamp(o.back.x + d.x, lim.x0, lim.x1), by = clamp(o.back.y + d.y, lim.y0, lim.y1);
    L.push(`G53 G0 X${n(bx)} Y${n(by)}`);
    if (num(o.back.z) && o.back.z < o.top) L.push(`G53 G0 Z${n(o.back.z)}`);
  }
  L.push("G90", "M2");
  return L.join("\n") + "\n";
}

// Find the centre, compare, correct, go back.
// deps: {run(prog) -> state at the end, getSetter(), saveSetter(s), args(setter) -> setterArgs,
//        state (now), lim}
// Returns {ok, adopted, d: {x, y}, dist, big, skipped, error}
export async function runHomeCheck(deps) {
  const st = deps.state;
  const setter = await deps.getSetter();
  if (!setter || !num(setter.x)) return { error: "The tool setter's position isn't saved yet (Tool setter screen)." };
  const args = deps.args(setter);
  const back = { x: st.xp, y: st.yp, z: st.zp };
  let last = null, stopped = false;
  const run = async (prog) => {
    const r = await deps.run(prog);
    last = r;
    if (r.estop || r.notFound || r.xx === "ESTOPPED") stopped = true;
    return r;
  };
  const c = await findSetterCentre(run, args);
  if (stopped) return { error: "The machine stopped (E-stop) while checking the homing. Nothing was changed." };
  const goBack = async (d) => {
    if (!last) return null;
    const r = await run(homeFixProgram({ now: { x: last.xp, y: last.yp }, off: { x: last.offset_x, y: last.offset_y }, d, back, top: args.top, lim: deps.lim }));
    if (stopped) throw new Error("The machine stopped (E-stop) while correcting the homing.");
    return r;
  };
  if (c.error) {
    await goBack(null).catch(() => {});
    return { error: c.error };
  }
  const ref = setter.href && num(setter.href.x) ? setter.href : null;
  const now = Date.now(), at = st.home_at;
  const keep = (rec, extra) => ({ ...setter, ...extra, hchk: { at, time: now, ...rec }, hlog: [{ time: now, ...rec }, ...(setter.hlog || [])].slice(0, HOMECHK.keep) });
  if (!ref) {
    // First check: this homing is the reference from now on
    await goBack(null);
    await deps.saveSetter(keep({ dx: 0, dy: 0, adopted: true }, { x: c.x, y: c.y, href: { x: c.x, y: c.y, time: now } }));
    return { ok: true, adopted: true, d: { x: 0, y: 0 }, dist: 0, skipped: c.skipped, centre: c };
  }
  const d = { x: ref.x - c.x, y: ref.y - c.y }, dist = Math.hypot(d.x, d.y);
  if (dist > HOMECHK.max) {
    await goBack(null);
    return { error: `The tool setter's centre is ${dist.toFixed(1)} mm from where it was on the reference homing. That's more than homing slips, so nothing was changed: either the setter was moved (save its centre again on the Tool setter screen), or the machine lost its position (home again).`, dist, d };
  }
  const fix = dist >= HOMECHK.quiet ? d : null;
  await goBack(fix);
  await deps.saveSetter(keep({ dx: d.x, dy: d.y, fixed: !!fix }, { x: ref.x, y: ref.y }));
  return { ok: true, d, dist, fixed: !!fix, big: dist > HOMECHK.warn, skipped: c.skipped, centre: c };
}

// One line for the screens. fmt(mm) -> text with units.
export function homeCheckText(r, fmt) {
  if (r.error) return `Homing check: ${r.error}`;
  if (r.adopted) return "Homing check: the tool setter's centre was found and saved as the reference. From now on each homing is checked against this one and corrected to match.";
  if (!r.fixed) return `Homing check: spot on (${fmt(r.dist)} from the reference homing).`;
  const t = `Homing check: homing was ${fmt(r.dist)} off (X ${fmt(r.d.x)}, Y ${fmt(r.d.y)}). Corrected: machine positions now match the reference homing, and the work zero didn't move.`;
  return r.big ? `${t} That's more than homing should vary: something is dragging (a dust or mister hose) or slipping.` : t;
}
