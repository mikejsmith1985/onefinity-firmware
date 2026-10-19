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
};

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
  const lines = [
    `(Tool setter: ${o.mode === "ref" ? "reference" : "measure tool"})`,
    "G21",
    "M5", // never probe with the spindle on (the controller refuses it too)
    "#<_ofs_ok> = 0",
    "#<_ofs_fail> = 0",
    ...(o.token ? ["#<_ofs_done> = 0"] : []),
    `G90 G53 G0 Z${n(o.top)}`,
    `G53 G0 X${n(x)} Y${n(y)}`,
  ];
  if (descend > 0.01) {
    lines.push(`G91 G38.3 Z${n(-descend)} F${o.travel}`,
      "o300 if [#5070 EQ 1]", "#<_ofs_fail> = 1", "o300 endif");
  }
  lines.push("o301 if [#<_ofs_fail> EQ 0]",
    `G91 G38.2 Z${n(-search)} F${o.fast}`,
    "G91 G1 Z1",
    `G91 G38.2 Z-2 F${o.slow}`,
    "#<_ofs_trip> = #5063",
    o.mode === "ref" ? "#<_ofs_ref> = #5063" : `G92 Z${n(o.ref)}`,
    "#<_ofs_ok> = 1",
    "o301 endif",
    `G90 G53 G0 Z${n(o.top)}`);
  if (o.back) lines.push(`G53 G0 X${n(o.back.x)} Y${n(o.back.y)}`);
  // 1.31.0: the wizard only counts a touch as done when this run's token is set at the end
  if (o.token) lines.push("o302 if [#<_ofs_ok> EQ 1]", `#<_ofs_done> = ${o.token}`, "o302 endif");
  lines.push("G90", "M2");
  return lines.join("\n") + "\n";
}

// Reference record kept on the controller: {ref, offZ, time, by}.
// It is valid while the Z offset is still the one we left it at.
export function refStatus(rec, state) {
  if (!rec || typeof rec.ref !== "number") return { ok: false, why: "none" };
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

// The reference to store after the probe touched the setter (raw = work Z at the trip).
export function probeRefValue(raw, setter) {
  const c = typeof setter?.corr?.c === "number" ? setter.corr.c : 0;
  return raw - c;
}

// Keep-out check: does the loaded program move over the tool setter low enough to hit it?
//
// positions: planner path, x,y,z triples in work mm (Float32Array).
// setter: {x, y} machine mm, keep: keep-out radius mm (from the saved center).
// off: {x, y} machine position of work zero. toolR: cutter radius mm.
// topZ: work Z of the setter top (the current reference), or null when unknown,
// in which case only X/Y is checked.
export const SETTER_KEEP_DEFAULT = 30;
export const SETTER_Z_MARGIN = 2;

export function setterClash(positions, setter, off, toolR, topZ) {
  if (!positions || positions.length < 6 || !setter || typeof setter.x !== "number") return null;
  const cx = setter.x - (off.x || 0), cy = setter.y - (off.y || 0); // setter center in work X/Y
  const reach = (setter.keep > 0 ? setter.keep : SETTER_KEEP_DEFAULT) + (toolR || 0);
  const limitZ = typeof topZ === "number" ? topZ + SETTER_Z_MARGIN : Infinity;
  let closest = Infinity, closestLow = Infinity, hits = 0, lowZ = Infinity;
  const n = positions.length / 3;
  for (let i = 1; i < n; i++) {
    const a = (i - 1) * 3, b = i * 3;
    const ax = positions[a], ay = positions[a + 1], az = positions[a + 2];
    const bx = positions[b], by = positions[b + 1], bz = positions[b + 2];
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
    let t = l2 > 0 ? ((cx - ax) * dx + (cy - ay) * dy) / l2 : 0;
    t = Math.max(0, Math.min(1, t));
    const d = Math.hypot(ax + t * dx - cx, ay + t * dy - cy);
    const z = Math.min(az, bz); // lowest point of the segment, to be safe
    if (d < closest) closest = d;
    if (z < limitZ && d < closestLow) closestLow = d;
    if (d < reach && z < limitZ) { hits++; lowZ = Math.min(lowZ, z); }
  }
  return { hits, closest, closestLow, lowZ, reach, center: { x: cx, y: cy }, zChecked: limitZ !== Infinity };
}

const len = (v, metric) => (metric ? `${v.toFixed(1)} mm` : `${(v / 25.4).toFixed(2)} in`);

// Checklist items for the setter keep-out. path: {positions}, setter: saved setter prefs,
// state: controller state, toolD: cutter diameter mm (from the setup sheet), metric.
export function setterChecks(path, setter, state, toolD, metric = true) {
  if (!setter || typeof setter.x !== "number") return [];
  if (!path?.positions) return [{ level: "warn", name: "Tool setter", text: "The program's path isn't ready yet, so it wasn't checked against the tool setter." }];
  const ref = refStatus(setter.ref, state);
  const topZ = ref.ok ? setter.ref.ref : null;
  const r = setterClash(path.positions, setter, { x: state.offset_x, y: state.offset_y }, (toolD || 0) / 2, topZ);
  if (!r) return [];
  const where = `the tool setter (within ${len(r.reach, metric)} of its center${toolD ? ", counting the cutter's radius" : ""})`;
  if (r.hits && r.zChecked) {
    return [{ level: "stop", name: "TOOL SETTER", text: `This program moves over ${where} as low as Z ${len(r.lowZ, metric)}. The setter's top is at about Z ${len(topZ, metric)}, so the cutter would hit it or pass within ${len(SETTER_Z_MARGIN, metric)} of it. Move the stock or the setter, then run again.` }];
  }
  if (r.hits) {
    return [{ level: "warn", name: "Tool setter", text: `This program moves over ${where}. There's no current setter reference, so the controller can't tell whether those moves are high enough to clear it. Check by eye, or take a reference first.` }];
  }
  const near = r.zChecked ? r.closestLow : r.closest;
  if (!isFinite(near)) return [{ level: "ok", name: "Tool setter", text: `Every move stays at least ${len(SETTER_Z_MARGIN, metric)} above the tool setter's top.` }];
  return [{ level: "ok", name: "Tool setter", text: `The cutter stays ${len(Math.max(0, near - (toolD || 0) / 2), metric)} from the tool setter's center at the closest point${r.zChecked ? " below the setter's top" : ""}.` }];
}

// ---- frame-free setter touch (1.31.0, Start job wizard) ----
// setterProgram() above reads the trip height from #5063 (reference) or sets it with G92 inside the
// program. Both depend on which frame #5061 to #5063 are reported in, which is still open (1.29.0
// release notes). This one doesn't read #5063 at all: it touches the setter like setterProgram, then
// moves exactly 1 mm up (relative) and ends there. The machine Z the controller reports at that
// point, less 1 mm, is the trip height in machine coordinates; the wizard works out the work Z from
// it and the Z offset, and sets Z itself (touchResult). Then it lifts with setterLiftProgram.
export function setterTouchProgram(o) {
  const { x, y, z } = o.setter;
  const start = Math.min(o.top, z + o.clear);
  const descend = o.top - start;
  const search = start - z + 25;
  const lines = [
    "(Tool setter: touch for the Start job wizard)",
    "G21",
    "M5",
    "#<_ofs_ok> = 0",
    "#<_ofs_fail> = 0",
    "#<_ofs_done> = 0",
    `G90 G53 G0 Z${n(o.top)}`,
    `G53 G0 X${n(x)} Y${n(y)}`,
  ];
  if (descend > 0.01) {
    lines.push(`G91 G38.3 Z${n(-descend)} F${o.travel}`,
      "o310 if [#5070 EQ 1]", "#<_ofs_fail> = 1", "G90 G53 G0 Z" + n(o.top), "o310 endif");
  }
  lines.push("o311 if [#<_ofs_fail> EQ 0]",
    `G91 G38.2 Z${n(-search)} F${o.fast}`,
    "G91 G1 Z1",
    `G91 G38.2 Z-2 F${o.slow}`,
    `G91 G1 Z1 F${o.fast}`,
    "#<_ofs_ok> = 1",
    `#<_ofs_done> = ${o.token || 1}`,
    "o311 endif",
    "G90", "M2");
  return lines.join("\n") + "\n";
}

export function setterLiftProgram(top, back) {
  return `G21\nG90 G53 G0 Z${n(top)}\n${back ? `G53 G0 X${n(back.x)} Y${n(back.y)}\n` : ""}G90\nM2\n`;
}

// zp: machine Z reported after setterTouchProgram ended (1 mm above the trip), offZ: Z offset then.
// Returns the trip height as a work Z (what setterProgram stores as the reference).
export const touchTrip = (zp, offZ) => zp - 1 - offZ;
