// Start job wizard (1.31.0): the steps of a job, worked out from the program's setup sheet, its tool
// changes and its reference bores. Pure functions so they can be tested without a browser.

const n = (v) => {
  const s = (Math.round(v * 10000) / 10000).toFixed(4).replace(/\.?0+$/, "");
  return s === "-0" ? "0" : s;
};

export const STEP_TITLES = {
  overview: "Job", stock: "Load stock", probe: "3D probe", measure: "Measure stock", flip: "Line up side B",
  tool: "Cutter", zset: "Z for the cutter", router: "Router", run: "Run", done: "Done",
};

// sheet: sheetSummary() + parseSetup() bits ({stock, corner, tool, dial}), parts: JobPlan parts
// [{index, tool, tool_name}], refs: flip refs or null, opts: {setter: bool, manual: bool, skip: {}}
// Returns [{id, kind, part, title}]
export function jobSteps({ parts, refs, setter, manual, skip = {} }) {
  const out = [];
  const add = (kind, part = null) => {
    const id = part === null ? kind : `${kind}:${part}`;
    if (skip[id] && kind !== "run" && kind !== "overview" && kind !== "done") return;
    const n = parts.length;
    const t = part === null ? STEP_TITLES[kind] : `${STEP_TITLES[kind]}${n > 1 ? ` · part ${part + 1}/${n}` : ""}`;
    out.push({ id, kind, part, title: t });
  };
  add("overview"); add("stock"); add("probe"); add("measure");
  if (refs) add("flip");
  parts.forEach((p, i) => {
    add("tool", i); add("zset", i);
    if (manual) add("router", i);
    add("run", i);
  });
  add("done");
  return out;
}

// Work position of the middle of the stock, for a zero on corner `origin` of a w x l stock.
export function stockCenter(origin, w, l) {
  const x = origin.endsWith("left") || origin === "x-left" ? w / 2 : origin.endsWith("right") || origin === "x-right" ? -w / 2 : 0;
  const y = origin.startsWith("front") ? l / 2 : origin.startsWith("back") ? -l / 2 : 0;
  return { x, y };
}

// Moves the stylus over the middle of the stock where the last job's stock was, then down to `above`
// mm over its top with a guarded move. last: {x, y, ztop} machine mm (ztop: machine Z of the
// stylus tip on the stock top last time), top: machine Z at the top of travel.
export function overStockProgram({ last, top, above = 10, travel = 1000, token }) {
  const target = last.ztop + above;
  const down = top - target;
  const lines = [
    "(Start job wizard: over the stock)",
    "G21", "M5",
    "#<_ofw_fail> = 0", "#<_ofw_done> = 0",
    `G90 G53 G0 Z${n(top)}`,
    `G53 G0 X${n(last.x)} Y${n(last.y)}`,
  ];
  if (down > 0.01) lines.push(`G91 G38.3 Z${n(-down)} F${travel}`, "o600 if [#5070 EQ 1]", "#<_ofw_fail> = 1", "G91 G0 Z5", "o600 endif");
  lines.push("o601 if [#<_ofw_fail> EQ 0]", `#<_ofw_done> = ${token || 1}`, "o601 endif", "G90", "M2");
  return lines.join("\n") + "\n";
}

// Rough start point for each bore, as work X/Y (after Measure stock set a zero on side B).
// refs: [{x, y}] program coordinates; the program is not turned yet, so these are the same.
export const roughTargets = (refs) => refs.map((r) => ({ x: r.x, y: r.y }));

// Where the camera's crosshair is, in machine coordinates.
export const cameraPoint = (state, off) => ({ x: (state.xp || 0) + off.x, y: (state.yp || 0) + off.y });

// Work X/Y to give the current position so that the program's X0 Y0 lands on `origin` (machine).
export const zeroFor = (state, origin) => ({ x: (state.xp || 0) - origin.x, y: (state.yp || 0) - origin.y });

export const partFileName = (source, k, n) => (n > 1 ? `part${k + 1}of${n}-${source}` : source);

// Same rigid fit as Flip.fit on the controller, used only to predict where the next bore is.
export function fitRefs(nominal, measured) {
  const k = nominal.length;
  const cn = [nominal.reduce((a, p) => a + p.x, 0) / k, nominal.reduce((a, p) => a + p.y, 0) / k];
  const cm = [measured.reduce((a, p) => a + p.x, 0) / k, measured.reduce((a, p) => a + p.y, 0) / k];
  let dot = 0, cross = 0;
  nominal.forEach((p, i) => {
    const ax = p.x - cn[0], ay = p.y - cn[1], bx = measured[i].x - cm[0], by = measured[i].y - cm[1];
    dot += ax * bx + ay * by; cross += ax * by - ay * bx;
  });
  const a = Math.atan2(cross, dot), c = Math.cos(a), s = Math.sin(a);
  return { a, map: (p) => ({ x: cm[0] + (p.x - cn[0]) * c - (p.y - cn[1]) * s, y: cm[1] + (p.x - cn[0]) * s + (p.y - cn[1]) * c }) };
}

// Where to look for bore i, as {pred (work X/Y), opts for boreSpots}.
// refs: sheet refs (program X/Y), meas: [{x, y, manual}|null] machine, off: {x, y} work offset.
export function boreSearch(refs, meas, i, off, searchDeg = 2) {
  const N = refs[i];
  const done = meas.map((m, j) => (m && !m.bad ? j : -1)).filter((j) => j >= 0 && j !== i);
  if (!done.length) {
    const L = Math.hypot(N.x, N.y);
    return { pred: { x: N.x, y: N.y }, opts: L > 1 ? { along: { x: N.x / L, y: N.y / L }, dist: L, searchDeg, slack: 2 } : { slack: 2 } };
  }
  if (done.length === 1) {
    const a = done[0], M = meas[a], dx = N.x - refs[a].x, dy = N.y - refs[a].y, L = Math.hypot(dx, dy);
    return { pred: { x: M.x - off.x + dx, y: M.y - off.y + dy }, opts: { along: { x: dx / L, y: dy / L }, dist: L, searchDeg, slack: M.manual ? 1 : 0.3 } };
  }
  const f = fitRefs(done.map((j) => refs[j]), done.map((j) => meas[j]));
  const p = f.map(N);
  return { pred: { x: p.x - off.x, y: p.y - off.y }, opts: { slack: 0.5 } };
}

// The controller can't switch this spindle (a router with its own switch): same rule as Resume.manual_spindle.
export function manualSpindle(config) {
  const tt = String(config?.tool?.["tool-type"] || "Disabled"), sel = String(config?.tool?.["selected-tool"] || "");
  return tt.toLowerCase() === "disabled" || ["router", "disabled"].includes(sel.toLowerCase());
}

export const WHY = {
  notfound: "Something wasn't found where it should be and the controller stopped (Switch not found). Clear the error, check the position and try again.",
  estop: "The E-stop stopped it. Clear the E-stop and try again.",
  refused: "The controller refused the program (the message is in the error popup). Nothing was moved by this step.",
  nostart: "The controller didn't run the program. Check the connection and that the machine is idle, then try again.",
  send: "This screen isn't connected to the controller, so nothing was sent. Try again when it is connected.",
  stopped: "It stopped before the end.",
};
