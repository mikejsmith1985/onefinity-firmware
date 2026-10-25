import { marker, STEP_RESET } from "./progress.js";
// Tool setter: a switch bolted to the table that every tool touches, so Z
// can be set for a new tool without putting a touch plate on the stock.
//
// "Reference" is the work Z the tool tip reads when it trips the setter,
// measured with a tool whose Z zero is right (the 3D probe straight after
// Measure stock, or any tool after a normal Z probe).  For any later tool the
// program touches the setter and sets the current work Z to that reference:
// both tips are then at the same physical height, so Z zero is right for the
// new tool too.
//
// Moves use machine coordinates (G53) so they don't depend on the work zero.
// The descent to the setter is guarded (G38.3) so a tool much longer than
// expected stops on contact instead of crashing.

export const SETTER_DEFAULTS = {
  clear: 30,     // start the touch this far above the saved height (covers longer tools)
  travel: 1000,  // mm/min for the guarded descent
  keep: 30,      // keep-out radius around the saved center, mm (programs that pass closer are checked)
  // Setter guard (1.34.0). The controller reads the same settings (SetterGuard.py) and refuses any
  // planned move or jog that would hit the setter; these screens show it before you run.
  installed: true, // the setter is on the table; untick while it is lifted out (e.g. surfacing)
  allow: 3.2,      // extra for the cutter's radius when the cutter isn't known, mm
  safeDrop: 5,     // without a reference: over the setter only within this of the top of Z, mm
  zMargin: 2,      // clearance kept above the setter's top, mm
};
const num = (v) => typeof v === "number" && isFinite(v);
const setting = (s, k) => (num(s?.[k]) && s[k] >= 0 ? s[k] : SETTER_DEFAULTS[k]);

export const SETTER_FAILS = {
  1: "The tool touched the setter before the slow touch started. This tool is more than the clearance longer than the one used to save the setter position. Raise the clearance, or save the setter position again with a longer tool.",
};

const n = (v) => {
  const s = (Math.round(v * 10000) / 10000).toFixed(4).replace(/\.?0+$/, "");
  return s === "-0" ? "0" : s;
};

// Is the probe input touched?  The controller reports the raw pin level (pw)
// and the input type (pt: 1 normally open, 2 normally closed).
export function probeActive(state) {
  if (state.pt === 2) return state.pw === 1;
  return state.pw === 0;
}

// o: {mode: "ref"|"tool", setter: {x, y, z} machine mm, top: machine Z to
//     travel at, back: {x, y} machine mm to return to, ref: work Z (tool mode),
//     clear, travel, fast, slow}
export function setterProgram(o) {
  const { x, y, z } = o.setter;
  const start = Math.min(o.top, z + o.clear);
  const descend = o.top - start;
  const search = start - z + 25;   // down to 25 mm below the saved height
  const mark = marker(); // which move is running, for the screen (1.31.1)
  const lines = [
    `(Tool setter: ${o.mode === "ref" ? "reference" : "measure tool"})`,
    "G21",
    "M5", // never probe with the spindle on (the controller refuses it too)
    "#<_ofs_ok> = 0",
    "#<_ofs_fail> = 0",
    ...(o.token ? ["#<_ofs_done> = 0"] : []),
    STEP_RESET,
    mark("Go up to travel height"),
    `G90 G53 G0 Z${n(o.top)}`,
    mark("Move over the setter"),
    `G53 G0 X${n(x)} Y${n(y)}`,
  ];
  if (descend > 0.01) {
    lines.push(mark("Go down towards the setter, guarded"), `G91 G38.3 Z${n(-descend)} F${o.travel}`,
      "o300 if [#5070 EQ 1]", "#<_ofs_fail> = 1", "o300 endif");
  }
  lines.push("o301 if [#<_ofs_fail> EQ 0]",
    mark("Touch the setter"),
    `G91 G38.2 Z${n(-search)} F${o.fast}`,
    "G91 G1 Z1",
    `G91 G38.2 Z-2 F${o.slow}`,
    "#<_ofs_trip> = #5063",
    o.mode === "ref" ? "#<_ofs_ref> = #5063" : `G92 Z${n(o.ref)}`,
    "#<_ofs_ok> = 1",
    "o301 endif",
    mark("Lift and move back"),
    `G90 G53 G0 Z${n(o.top)}`);
  if (o.back) lines.push(`G53 G0 X${n(o.back.x)} Y${n(o.back.y)}`);
  // 1.31.0: the screen only counts a touch as done when this run's token is set at the end
  if (o.token) lines.push("o302 if [#<_ofs_ok> EQ 1]", `#<_ofs_done> = ${o.token}`, "o302 endif");
  lines.push("G90", "M2");
  return lines.join("\n") + "\n";
}

// The touch height the controller reports (#5063) is in MACHINE coordinates, not work
// coordinates (the CAMotics planner fills #5061-#5063 from the machine position; measured on the
// machine in 1.34.2: a setter top at machine Z -61.8 read -61.792 with a Z offset of -111.782).
// The reference is a work Z, so it is converted with the Z offset in force at the touch
// (machine = work + offset). 1.34.3.
export const REF_FORMAT = 2; // records made before 1.34.3 stored the machine Z: never used
export function tripToWork(raw, offsetZ) {
  if (typeof raw !== "number" || typeof offsetZ !== "number") return null;
  return raw - offsetZ;
}

// Reference record kept on the controller: {ref, offZ, time, by, f}.
// It is valid while the Z offset is still the one we left it at.
export function refStatus(rec, state) {
  if (!rec || typeof rec.ref !== "number") return { ok: false, why: "none" };
  if (rec.f !== REF_FORMAT) return { ok: false, why: "old" };
  if (typeof state.offset_z === "number" && typeof rec.offZ === "number" && Math.abs(state.offset_z - rec.offZ) > 0.01) {
    return { ok: false, why: "moved" };
  }
  return { ok: true };
}

// Probe-to-cutter calibration.
//
// The 3D probe and a cutter don't trip the setter at the same point: a cutter
// is rigid, so it trips when the setter plunger has pressed down by the
// setter's own pre-travel, but the probe's stylus gives too, and whichever of
// the two switches trips first ends the touch. The probe also tripped on the
// stock top after its own pre-travel when Measure stock set Z zero. So a
// reference taken with the probe is off from one taken with a cutter by a
// small, fixed amount that depends on the probe and the setter.
//
// It is measured once: take a reference with the probe (Measure stock), then,
// without moving the stock, Probe Z with a cutter and take a reference with
// it. Both references are in their own tool's work Z, so the difference is the
// correction, independent of either tool's length:
//   corr = probe reference - cutter reference
// Later probe references are stored already corrected (probe ref - corr).
export const CORR_MAX = 5; // mm; anything bigger means the stock moved or a step was missed

export function probeCorrection(probeRef, cutterRef) {
  if (typeof probeRef !== "number" || typeof cutterRef !== "number") return { ok: false, why: "missing" };
  const c = probeRef - cutterRef;
  if (!(Math.abs(c) <= CORR_MAX)) return { ok: false, why: "big", c };
  return { ok: true, c };
}

// The reference to store after the probe touched the setter (raw = work Z at the trip, from tripToWork).
export function probeRefValue(raw, setter) {
  const c = setter?.corr?.f === REF_FORMAT && typeof setter.corr.c === "number" ? setter.corr.c : 0;
  return raw - c;
}

// Setter guard (1.34.0). The setter is a column: a circle on the table (saved center, keep-out
// radius plus the cutter's radius) up to its top. The top's machine Z comes from the reference
// (work Z of the top + the current Z offset) when it is still valid. Without one the tool's length
// is unknown, so moves over the setter only count as safe with the spindle within safeDrop of the
// top of Z travel. Mirrors SetterGuard.py; keep the two in step.
export function guardZone(setter, state, zMax, toolR = 0) {
  if (!setter || !num(setter.x) || !num(setter.y)) return { on: false, why: "unsaved" };
  if (setter.installed === false) return { on: false, why: "removed" };
  const keep = setting(setter, "keep") || SETTER_DEFAULTS.keep;
  const r = keep + Math.max(setting(setter, "allow"), toolR || 0);
  const ref = refStatus(setter.ref, state);
  if (ref.ok && num(state.offset_z)) {
    return { on: true, how: "ref", x: setter.x, y: setter.y, r, zLimit: setter.ref.ref + state.offset_z + setting(setter, "zMargin") };
  }
  if (!num(zMax)) return { on: false, why: "unhomed" };
  return { on: true, how: "top", x: setter.x, y: setter.y, r, zLimit: zMax - setting(setter, "safeDrop") };
}

// Lowest Z of the move a -> b inside the column, or null when the move is clear (machine mm).
export function segmentHits(a, b, cx, cy, r, zLimit) {
  const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
  const ox = a[0] - cx, oy = a[1] - cy;
  const A = dx * dx + dy * dy, B = 2 * (ox * dx + oy * dy), C = ox * ox + oy * oy - r * r;
  let t0, t1;
  if (A < 1e-12) { if (C >= 0) return null; t0 = 0; t1 = 1; }
  else {
    const disc = B * B - 4 * A * C;
    if (disc <= 0) return null;
    const q = Math.sqrt(disc);
    t0 = Math.max(0, (-B - q) / (2 * A)); t1 = Math.min(1, (-B + q) / (2 * A));
    if (t1 <= t0) return null;
  }
  const low = Math.min(a[2] + dz * t0, a[2] + dz * t1);
  return low < zLimit ? low : null;
}

// Keep-out check over a planned program path.
// positions: planner path, x,y,z triples in work mm. off: {x, y, z} work offsets (machine = work + off).
// opts.dryLift: a dry run sends every move this much higher (capped at zMax), as the controller does.
export function setterClash(positions, zone, off, opts = {}) {
  if (!positions || positions.length < 6 || !zone?.on) return null;
  const lift = opts.dryLift || 0, zMax = num(opts.zMax) ? opts.zMax : Infinity;
  const mz = (z) => Math.min(z + (off.z || 0) + lift, lift ? zMax : Infinity);
  let hits = 0, lowZ = Infinity, closest = Infinity, first = -1;
  const n = positions.length / 3;
  for (let i = 1; i < n; i++) {
    const j = (i - 1) * 3, k = i * 3;
    const a = [positions[j] + (off.x || 0), positions[j + 1] + (off.y || 0), mz(positions[j + 2])];
    const b = [positions[k] + (off.x || 0), positions[k + 1] + (off.y || 0), mz(positions[k + 2])];
    // Closest XY approach while below the top, for the "clear by" note
    const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
    let t = l2 > 0 ? ((zone.x - a[0]) * dx + (zone.y - a[1]) * dy) / l2 : 0;
    t = Math.max(0, Math.min(1, t));
    if (Math.min(a[2], b[2]) < zone.zLimit) closest = Math.min(closest, Math.hypot(a[0] + t * dx - zone.x, a[1] + t * dy - zone.y));
    const low = segmentHits(a, b, zone.x, zone.y, zone.r, zone.zLimit);
    if (low !== null) { hits++; lowZ = Math.min(lowZ, low); if (first < 0) first = i; }
  }
  return { hits, lowZ, closest, first };
}

const len = (v, metric) => (metric ? `${v.toFixed(1)} mm` : `${(v / 25.4).toFixed(2)} in`);

// Plain-language state of the guard, for the Tool setter screen.
export function guardText(zone, setter, metric) {
  if (!zone.on) {
    return zone.why === "removed" ? "Off: the setter is marked removed. Moves aren't checked against it. Tick “On the table” when it's back."
      : zone.why === "unhomed" ? "Waiting: home the machine and the guard switches on."
      : "Off: save the setter's position to switch it on.";
  }
  return zone.how === "ref"
    ? `On. Nothing may pass within ${len(zone.r, metric)} of the setter's center below machine Z ${len(zone.zLimit, metric)} (its top from the reference, plus ${len(setting(setter, "zMargin"), metric)}).`
    : `On, without a reference: the tool's length is unknown, so moves over the setter are only allowed with the spindle within ${len(setting(setter, "safeDrop"), metric)} of the top of Z. Take a reference to allow lower moves that clear it.`;
}

// Checklist items for the setter keep-out. path: {positions}, setter: saved setter prefs,
// state: controller state, toolD: cutter diameter mm (setup sheet), metric,
// opts: {zMax: machine Z top of travel, dryLift}.
// A clash is a "block": the controller would refuse that move part way through the job,
// so Run stays locked (there is no Run anyway for it).
export function setterChecks(path, setter, state, toolD, metric = true, opts = {}) {
  if (!setter || !num(setter.x)) return [];
  const zone = guardZone(setter, state, opts.zMax, (toolD || 0) / 2);
  if (!zone.on) {
    if (zone.why === "removed") return [{ level: "ok", name: "Tool setter", text: "Marked removed, so moves aren't checked against it. Tick “On the table” on the Tool setter screen when it's back." }];
    if (zone.why === "unhomed") return [{ level: "warn", name: "Tool setter", text: "The machine isn't homed, so the program couldn't be checked against the tool setter." }];
    return [];
  }
  if (!path?.positions) return [{ level: "warn", name: "Tool setter", text: "The program's path isn't ready yet, so it wasn't checked against the tool setter." }];
  const off = { x: state.offset_x || 0, y: state.offset_y || 0, z: state.offset_z || 0 };
  const r = setterClash(path.positions, zone, off, { dryLift: opts.dryLift, zMax: opts.zMax });
  if (!r) return [];
  if (r.hits) {
    const top = zone.how === "ref"
      ? `the setter's top plus clearance is at work Z ${len(zone.zLimit - off.z, metric)}`
      : `with no setter reference the controller only allows moves over it with the spindle within ${len(setting(setter, "safeDrop"), metric)} of the top of Z (work Z ${len(zone.zLimit - off.z, metric)})`;
    return [{ level: "stop", block: true, name: "TOOL SETTER", text: `This program moves within ${len(zone.r, metric)} of the tool setter's center as low as work Z ${len(r.lowZ - off.z, metric)}, and ${top}. The controller would stop the job at that move. Move the stock or the zero, ${zone.how === "top" ? "take a setter reference, " : ""}or lift the setter out and mark it removed on the Tool setter screen.` }];
  }
  if (!isFinite(r.closest)) return [{ level: "ok", name: "Tool setter", text: "Every move near the tool setter stays above its top." }];
  return [{ level: "ok", name: "Tool setter", text: `Clear: below the setter's top, the cutter stays ${len(Math.max(0, r.closest - (toolD || 0) / 2), metric)} from its center.` }];
}
