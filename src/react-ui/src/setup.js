// Setup sheet: comment lines near the top of a program, written when the program is exported.
//
//   (SETUP key: text)
//
// Every key is shown to the operator before the run. Two keys are also checked by the controller:
//   stock:  x=0..77.36 y=-61..0 z=-12.5..0   the plate area the program may use, in work coordinates
//   tool-d: 3.175                            tool diameter in mm
//   probe-corner: back-left                  corner the work zero must be probed on
//                                            (front-left, front-right, back-left, back-right, center)
//   tool-geom: flat 6.35  /  v 6.35 90       tool the Depth view simulates: shape, diameter in mm and,
//                                            for a V-bit or chamfer mill, the included angle
// Comments are ignored by the planner, so a program with a sheet runs exactly like any other.

import { commentIssues, CORNERS, normCorner } from "./gcodetext.js";

const LINE = /^\s*\(\s*SETUP\s+([A-Za-z0-9-]+)\s*:\s*(.*?)\s*\)\s*$/;
const LABELS = {
  job: "Job", zero: "Work zero", plate: "Plate", probe: "Probe", part: "Part position", tool: "Tool", router: "Router",
  z0: "Z zero", feeds: "Feeds", time: "Run time", chamfer: "Chamfer", before: "Before you start", next: "Next",
};
const HIDDEN = new Set(["stock", "tool-d", "probe-corner", "tool-geom"]);
const HEADER_BYTES = 32768;

const num = (s) => { const v = parseFloat(s); return Number.isFinite(v) ? v : null; };

function parseRange(text, axis) {
  const m = new RegExp(`${axis}\\s*=\\s*(-?[\\d.]+)\\s*\\.\\.\\s*(-?[\\d.]+)`, "i").exec(text);
  if (!m) return null;
  const a = num(m[1]), b = num(m[2]);
  return a === null || b === null ? null : { min: Math.min(a, b), max: Math.max(a, b) };
}

// "flat 6.35" or "v 6.35 90" -> { type: "flat" | "v", dia, angle }. Null when it can't be read.
export function parseToolGeom(text) {
  const m = /^\s*(flat|v)\s+([\d.]+)(?:\s+([\d.]+))?\s*$/i.exec(text || "");
  if (!m) return null;
  const type = m[1].toLowerCase(), dia = num(m[2]), angle = m[3] ? num(m[3]) : null;
  if (!(dia > 0)) return null;
  if (type === "v" && !(angle > 0 && angle < 180)) return null;
  return type === "v" ? { type, dia, angle } : { type, dia };
}

// Reads the SETUP lines out of the start of a program. Returns null when the program has no sheet.
export function parseSetup(text) {
  const fields = [];
  const raw = {};
  const bad = []; // SETUP lines the planner reads differently from how they look (1.29.0)
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = LINE.exec(line);
    if (m || /^\s*\(\s*SETUP\b/i.test(line)) {
      // "(SETUP tool: T1 (6.35mm))": the comment ends at the first ")", and the planner stops on the rest
      const { issues } = commentIssues(line);
      if (issues.length) bad.push({ line: i + 1, text: line.trim(), issues });
    }
    if (m) { raw[m[1].toLowerCase()] = m[2]; continue; }
    // The sheet ends at the first line of real code
    if (/^\s*N?\d*\s*[GMTXYZ]/i.test(line) && !/^\s*\(/.test(line)) break;
  }
  if (!Object.keys(raw).length) return null;
  for (const k of Object.keys(raw)) if (!HIDDEN.has(k) && k !== "sheet") fields.push({ key: k, label: LABELS[k] || k.replace(/-/g, " ").replace(/^./, (c) => c.toUpperCase()), text: raw[k] });
  const stock = raw.stock ? { x: parseRange(raw.stock, "x"), y: parseRange(raw.stock, "y") } : null;
  const stockOk = !!(stock && stock.x && stock.y);
  const corner = raw["probe-corner"] ? normCorner(raw["probe-corner"]) : null;
  return {
    fields, stock: stockOk ? stock : null, toolD: raw["tool-d"] ? num(raw["tool-d"]) : null,
    // A stock line that can't be read is reported, not silently skipped (1.29.0)
    stockBad: raw.stock !== undefined && !stockOk ? raw.stock : null,
    corner: corner && CORNERS.includes(corner) ? corner : null,
    cornerBad: corner && !CORNERS.includes(corner) ? raw["probe-corner"] : null,
    toolGeom: parseToolGeom(raw["tool-geom"]),
    bad,
  };
}

// Fetches a program from the controller. Reads only the start unless `all` is set.
async function fetchProgram(file, all) {
  const r = await fetch(`/api/file/${encodeURIComponent(file)}`, { cache: "no-cache" });
  if (!r.ok) throw new Error("Could not read the program.");
  if (all || !r.body || !r.body.getReader) return r.text();
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let text = "";
  while (text.length < HEADER_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    text += dec.decode(value, { stream: true });
  }
  reader.cancel().catch(() => {});
  return text;
}

// Reads only the sheet at the top of a program, without measuring the whole program.
export async function readSetupHeader(file) {
  if (!file) return null;
  return parseSetup(await fetchProgram(file, false));
}

// Where the program moves, from the controller's G-code check (1.31.5). The check is kept per file
// version on the controller, so this is quick once the file has been checked. Up to 1.31.4 every Run,
// Setup sheet and file selection downloaded the whole program and read it on the screen: several
// seconds for a large program on the controller's own touchscreen. Falls back to reading it here when
// the controller doesn't give one (older firmware, incremental moves).
async function controllerExtent(file) {
  try {
    const r = await fetch(`/api/lint/${encodeURIComponent(file)}`);
    if (!r.ok) return undefined;
    const res = await r.json();
    if (!res || !("extent" in res)) return undefined;
    const e = res.extent;
    return e && [e.minx, e.maxx, e.miny, e.maxy].every(Number.isFinite) ? { ...e, moves: res.lines } : undefined;
  } catch { return undefined; }
}

export async function readSetup(file) {
  if (!file) return null;
  const head = await fetchProgram(file, false);
  const setup = parseSetup(head);
  if (!setup) return null;
  if (setup.stock) {
    setup.ext = await controllerExtent(file);
    if (setup.ext === undefined) {
      try { setup.ext = programExtent(await fetchProgram(file, true)); }
      catch { setup.ext = null; }
    }
  }
  return setup;
}

const stripComments = (l) => l.replace(/\([^)]*\)/g, "").replace(/;.*$/, "");

// Smallest box around every X/Y the program moves to, in work coordinates (mm).
// Machine-coordinate moves (G53, used for parking) are skipped. Returns null when the program uses
// incremental moves, which this simple scan cannot follow, so the caller reports it as not checked.
export function programExtent(text) {
  let x = 0, y = 0, scale = 1, incremental = false;
  let minx = Infinity, maxx = -Infinity, miny = Infinity, maxy = -Infinity, moves = 0;
  const add = (px, py) => { minx = Math.min(minx, px); maxx = Math.max(maxx, px); miny = Math.min(miny, py); maxy = Math.max(maxy, py); };
  for (const raw of text.split("\n")) {
    const l = stripComments(raw).toUpperCase();
    if (!l.trim()) continue;
    if (/G20(?!\d)/.test(l)) scale = 25.4;
    if (/G21(?!\d)/.test(l)) scale = 1;
    if (/G91(?!\.)/.test(l)) incremental = true;
    if (/G90(?!\.)/.test(l)) incremental = false;
    if (/G53(?!\d)|G28|G30|G92/.test(l)) continue;
    const w = {};
    for (const m of l.matchAll(/([XYIJ])\s*(-?\d*\.?\d+)/g)) w[m[1]] = parseFloat(m[2]) * scale;
    if (w.X === undefined && w.Y === undefined) continue;
    if (incremental) return null;
    const nx = w.X === undefined ? x : w.X, ny = w.Y === undefined ? y : w.Y;
    const arc = /G0?([23])(?!\d)/.exec(l);
    if (arc && (w.I !== undefined || w.J !== undefined)) {
      // Include the points where the arc reaches its furthest left, right, back and front
      const cx = x + (w.I || 0), cy = y + (w.J || 0), r = Math.hypot(x - cx, y - cy);
      const ccw = arc[1] === "3";
      let a0 = Math.atan2(y - cy, x - cx), a1 = Math.atan2(ny - cy, nx - cx);
      let sweep = ccw ? a1 - a0 : a0 - a1;
      while (sweep <= 1e-9) sweep += 2 * Math.PI;
      for (let q = 0; q < 4; q++) {
        const qa = (q * Math.PI) / 2;
        let d = ccw ? qa - a0 : a0 - qa;
        while (d < 0) d += 2 * Math.PI;
        if (d <= sweep) add(cx + r * Math.cos(qa), cy + r * Math.sin(qa));
      }
    }
    add(nx, ny);
    x = nx; y = ny; moves++;
  }
  return moves ? { minx, maxx, miny, maxy, moves } : null;
}

const mm = (v, metric) => (metric ? `${v.toFixed(1)} mm` : `${(v / 25.4).toFixed(2)} in`);

// Checks the program against the stock area in the sheet. Y+ is the back of the machine.
export function stockChecks(setup, metric = true) {
  if (setup?.stockBad != null) return [{ level: "warn", name: "Stock", text: `The setup sheet's stock line could not be read ("${setup.stockBad}"; it should look like x=0..300 y=0..200 z=-19..0), so this program was NOT checked against the plate.` }];
  if (!setup?.stock) return [];
  const { x, y } = setup.stock;
  const e = setup.ext;
  if (!e) return [{ level: "warn", name: "Stock", text: "Could not measure where this program moves, so it was not checked against the plate." }];
  const r = (setup.toolD || 0) / 2;
  const over = [
    ["left", x.min - (e.minx - r)],
    ["right", e.maxx + r - x.max],
    ["back", e.maxy + r - y.max],
    ["front", y.min - (e.miny - r)],
  ].filter(([, d]) => d > 0.05);
  const area = `X ${x.min} to ${x.max}, Y ${y.min} to ${y.max}`;
  if (over.length) {
    return [{
      level: "stop", name: "Stock",
      text: `This program moves past the ${over.map(([s, d]) => `${s} edge by ${mm(d, metric)}`).join(" and past the ")} of the plate area its setup sheet declares (${area}). The file may have been edited. Do not run it until you know why.`,
    }];
  }
  const spare = Math.min(e.minx - r - x.min, x.max - e.maxx - r, e.miny - r - y.min, y.max - e.maxy - r);
  return [{ level: "ok", name: "Stock", text: `Every move stays inside the plate area the sheet declares (${area}), with ${mm(spare, metric)} to spare at the tightest side. Your plate must be at least that big.` }];
}

const CORNER_NAMES = { "front-left": "front-left corner", "front-right": "front-right corner", "back-left": "back-left corner", "back-right": "back-right corner", center: "center of the stock", "center-x": "X center of the stock" };
const cornerName = (c) => CORNER_NAMES[c] || c;

// Compares the last probe the controller remembers with the corner the sheet needs.
// rec: {loc, time, off:{x,y,z}} saved by the probe dialog, state: live controller state.
export function probeChecks(setup, rec, state) {
  if (setup?.cornerBad) return [{ level: "warn", name: "Zero", text: `The setup sheet asks for zero on "${setup.cornerBad}", which is not a corner this controller knows (front-left, front-right, back-left, back-right, center, center-x). The zero was not checked: confirm it by eye before you run.` }];
  if (!setup?.corner) return [];
  const want = setup.corner;
  const WANT = cornerName(want).toUpperCase();
  if (!rec || !rec.loc) {
    return [{ level: "warn", name: "Zero", text: `This program needs zero on the ${WANT}. The controller has no record of a corner probe, so it cannot confirm that. Check it by eye before you run.` }];
  }
  if (normCorner(rec.loc) !== want) {
    return [{ level: "stop", name: "WRONG ZERO", text: `This program was written for zero on the ${WANT}. Your last probe was on the ${cornerName(rec.loc).toUpperCase()}. Every cut would land in the wrong place. Probe XYZ on the ${cornerName(want)}, then run again.` }];
  }
  const moved = ["x", "y"].filter((a) => rec.off && rec.off[a] != null && state && state[`offset_${a}`] != null && Math.abs(state[`offset_${a}`] - rec.off[a]) > 0.05);
  const when = rec.time ? new Date(rec.time).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" }) : "earlier";
  if (moved.length) {
    return [{ level: "warn", name: "Zero", text: `The ${cornerName(want)} was probed (${when}), but ${moved.map((a) => a.toUpperCase()).join(" and ")} zero has been changed since. Confirm zero is still on that corner.` }];
  }
  return [{ level: "ok", name: "Zero", text: `Probed on the ${cornerName(want)} (${when}), and zero has not been changed since.` }];
}

// SETUP lines with brackets inside the comment: the planner stops on them (1.29.0)
export function sheetLineChecks(setup) {
  if (!setup?.bad?.length) return [];
  const list = setup.bad.slice(0, 3).map((b) => `line ${b.line}: ${b.text}`).join("; ");
  return [{ level: "stop", name: "Setup sheet", key: "comment-nested", text: `${setup.bad.length === 1 ? "A setup sheet line has" : `${setup.bad.length} setup sheet lines have`} brackets inside the comment (${list}). The planner ends a comment at the first ")" and stops with an error on the rest. Write the inner brackets as [ ] in the post processor and export again.` }];
}

// ---- quick-read summary of a sheet (1.28.1) ----
// The sheet comes out of the post processor in capitals. This turns the parts the operator needs at a glance
// (bit, router dial, where and how to probe) into short values, and the rest into sentence case.
const KEEP_UPPER = /^(x|y|z|xy|xyz|xz|yz|z0|x0|y0|mdf|ca|cnc|rpm|fpr\w*|t\d+|op-?\d*|n\d+\w*|s\d+|d[\d.]+|v|ok|pla|petg|2fl|o-flute|1-flute|2-flute|3-flute|4-flute|wcs|id|od)$/i;
export function sentenceCase(text) {
  if (!text) return text;
  const letters = text.replace(/[^A-Za-z]/g, "");
  if (!letters || letters.replace(/[^A-Z]/g, "").length < letters.length * 0.8) return text; // already mixed case
  let out = text.toLowerCase().replace(/[a-z0-9](?:[a-z0-9_/-]|\.(?=[a-z0-9]))*/g, (w) => (KEEP_UPPER.test(w) ? w.toUpperCase() : w));
  out = out.replace(/\bside ([ab])\b/g, (m, a) => `side ${a.toUpperCase()}`);
  out = out.replace(/(^|[.!?]\s+)([a-z])/g, (m, a, b) => a + b.toUpperCase());
  out = out.replace(/(\d)\s+X\s+(\d)/g, "$1 × $2");
  return out.replace(/\bmm\b/g, "mm").replace(/(\d)\s?mm\b/g, "$1 mm");
}

const field = (setup, k) => (setup?.fields || []).find((f) => f.key === k)?.text || "";

export function sheetSummary(setup) {
  if (!setup) return null;
  const tool = field(setup, "tool"), router = field(setup, "router"), zero = field(setup, "zero"), before = field(setup, "before");
  const tm = /^\s*T(\d+)\s+(.*?)(?:\s+-\s+|$)/i.exec(tool);
  const stick = /NEEDS\s+([\d.]+)\s*MM\s+BELOW THE COLLET/i.exec(tool);
  const dial = /DIAL\s*([\d.]+)/i.exec(router), rpm = /\bS(\d{3,6})\b/i.exec(router);
  const geom = setup.toolGeom;
  let corner = setup.corner;
  if (!corner) { const m = /\b(FRONT|BACK)-(LEFT|RIGHT)\b/i.exec(zero); corner = m ? `${m[1]}-${m[2]}`.toLowerCase() : /\bCENT(ER|RE)\b/i.test(zero) ? "center" : null; }
  const probeText = `${before} ${field(setup, "job")}`;
  const probe = /PROBE\s+XYZ/i.test(probeText) ? "xyz" : /PROBE\s+Z\b/i.test(probeText) ? "z" : setup.corner ? "xyz" : null;
  const what = /BOARD/i.test(zero) ? "board" : "plate";
  const z0 = /Z0 ON ([^,]+)/i.exec(zero);
  return {
    tool: tm ? { num: tm[1], name: tm[2], stick: stick ? +stick[1] : null, geom } : tool ? { num: null, name: tool.split(" - ")[0], stick: null, geom } : null,
    dial: dial ? dial[1] : null, rpm: rpm ? +rpm[1] : null,
    corner, probe, what, z0: z0 ? sentenceCase(z0[1]).toLowerCase() : null,
    before: sentenceCase(before),
  };
}
