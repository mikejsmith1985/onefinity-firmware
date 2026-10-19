// Probe programs for the touch-plate dialog (1.29.0: moved out of ProbeDialog.jsx so they can be tested).
//
// Every program:
//   - starts with M5 (the controller also refuses any probe move with the spindle on),
//   - clears #<_ofprobe_done> and #<_ofprobe_fail> first and sets #<_ofprobe_done> to a per-run token
//     just before M2, only if nothing went wrong. The controller publishes them as ofprobe_done and
//     ofprobe_fail, and the dialog only calls a probe complete when ofprobe_done is this run's token.
//     A Stop, an E-stop, "Switch not found", a refused or dropped command: none of them reach the end,
//     so none of them can look like a finished probe any more.
//   - makes every move relative (G91) and every move that goes down beside the block or along it at
//     depth a guarded move (G38.3). If the bit touches the block where it should not (it was started
//     too far from the edge), the move stops, #<_ofprobe_fail> says which one, the rest is skipped
//     and the bit lifts 25 mm.
// The #5061 to #5063 values are used exactly as before (see the 1.29.0 release notes, item 2).

export const FAILS = {
  1: "The bit touched the probe block while going down beside it, so it was too far from the edge to clear it. Start with the bit over the block, less than 20 mm in from the edges it probes.",
  2: "The bit touched the probe block while moving along its side. The block may be turned. Square it to the stock and start again.",
  3: "The bit touched the probe block while moving round to its second edge, so it started too far from that edge. Start with the bit less than 20 mm in from both edges.",
};

const n = (v) => {
  const s = (Math.round(v * 10000) / 10000).toFixed(4).replace(/\.?0+$/, "");
  return s === "-0" ? "0" : s;
};

export const newToken = () => 1 + Math.floor(Math.random() * 999998);

// Cutter diameter parsing (same rules as the original dialog)
const RX = /^\s*(?:(\d+)\s*\/\s*(\d+)|(\d*\.\d+)|(\d+(?:\.\d+)?))\s*("|in|inch|inches|mm|millimeters)\s*$/;
const FRACS = [[0.75, "3/4"], [0.625, "5/8"], [0.5, "1/2"], [0.375, "3/8"], [0.25, "1/4"], [0.1875, "3/16"], [0.125, "1/8"], [0.09375, "3/32"], [0.0625, "1/16"], [0.03125, "1/32"]];
export function parseDia(str) {
  const m = (str || "").match(RX); if (!m) return undefined;
  const [, a, b, d1, d2, unit] = m;
  const metric = (unit || "").includes("m");
  let value;
  if (a && b) value = Number(a) / Number(b);
  else if (d1 && Number(d1) !== 0) value = Number(d1);
  else if (d2 && Number(d2) !== 0) value = Number(d2);
  else return undefined;
  return { value, metric, mm: metric ? value : value * 25.4 };
}
export function normDia(str) {
  const p = parseDia(str); if (!p) return "";
  if (p.metric) return `${p.value} mm`;
  const f = FRACS.find(([v]) => v === p.value);
  return `${f ? f[1] : p.value} in`;
}

const begin = (token) => `G21
M5
#<_ofprobe_done> = 0
#<_ofprobe_fail> = 0`;
const end = (token, id = 990) => `G90
o${id} if [#<_ofprobe_fail> EQ 0]
#<_ofprobe_done> = ${token}
o${id} endif
M2
`;

// Guarded feed: as fast as the fast seek, at least 300 mm/min so the extra moves don't drag.
const guardFeed = (fast) => n(Math.min(Math.max(Number(fast) || 0, 300), 1000));

// One corner: Z on the block top, then the X face and (unless probeY is false) the Y face.
// o: {sx, sy, plunge, zLift, fastSeek, slowSeek, afterZ, afterX, afterY, remember, probeY, skipZ, base}
export function cornerProbeSequence(o) {
  let id = o.base || 100;
  const keep = (name, param) => (o.remember ? `#<_ofprobe_${name}> = ${param}\n` : "");
  const gf = guardFeed(o.fastSeek);
  const out = [];
  const add = (s) => out.push(s.replace(/\n+$/, ""));
  const guard = (body) => { const k = id++; add(`o${k} if [#<_ofprobe_fail> EQ 0]\n${body}\no${k} endif`); };
  // On contact: say which move it was, and back 1 mm off the block before the final lift
  const guarded = (axis, dist, code) => {
    const k = id++;
    return `G91 G38.3 ${axis}${n(dist)} F${gf}\no${k} if [#5070 EQ 1]\n#<_ofprobe_fail> = ${code}\nG91 G1 ${axis}${n(dist > 0 ? -1 : 1)} F${o.fastSeek}\no${k} endif`;
  };

  if (!o.skipZ) {
    add(`G91 G38.2 Z-25 F${o.fastSeek}
G91 G1 Z1
G91 G38.2 Z-2 F${o.slowSeek}
${keep("zt", "#5063")}${keep("ok", "-1")}${o.afterZ || ""}`);
  }
  add(`G91 G0 Z${n(o.zLift)}
G91 G0 X${n(20 * o.sx)}`);
  add(guarded("Z", -o.plunge, 1));
  guard(`G91 G38.2 X${n(-20 * o.sx)} F${o.fastSeek}
G91 G1 X${n(o.sx)}
G91 G38.2 X${n(-2 * o.sx)} F${o.slowSeek}
${keep("xa", "#5061")}${o.afterX || ""}
G91 G0 X${n(o.sx)}`);
  if (o.probeY !== false) {
    guard(guarded("Y", 20 * o.sy, 2));
    guard(guarded("X", -20 * o.sx, 3));
    guard(`G91 G38.2 Y${n(-20 * o.sy)} F${o.fastSeek}
G91 G1 Y${n(o.sy)}
G91 G38.2 Y${n(-2 * o.sy)} F${o.slowSeek}
${keep("ya", "#5062")}${o.afterY || ""}
G91 G0 Y${n(3 * o.sy)}`);
  }
  // Always lift, whatever happened above
  add("G91 G0 Z25");
  return out.filter(Boolean).join("\n").replace(/\n{2,}/g, "\n");
}

// The first (or only) probe. ctx: {config, rotary, type, loc, dia: {mm}, token}
export function probeProgram({ config, rotary, type, loc, dia: d, token }) {
  const cfg = rotary ? config["probe-rotary"] : config.probe;
  const w = cfg["probe-xdim"], l = cfg["probe-ydim"], zOffset = cfg["probe-zdim"], slow = cfg["probe-slow-seek"], fast = cfg["probe-fast-seek"];
  const cutterLength = 12.7, zLift = 1, cd = d ? d.mm : 0;
  const xOffset = w + cd / 2, yOffset = l + cd / 2;
  if (type === "z") {
    return `${begin(token)}
G92 Z0
G91 G38.2 Z-25.4 F${fast}
G91 G1 Z1
G91 G38.2 Z-2 F${slow}
G92 Z${n(zOffset)}
G91 G0 Z25
${end(token)}`;
  }
  const plunge = Math.min(cutterLength, zOffset * 0.9) + zLift;
  if (rotary) {
    return `${begin(token)}
G92 X0 Y0 Z0
${cornerProbeSequence({ sx: 1, sy: 1, plunge, zLift, fastSeek: fast, slowSeek: slow, afterZ: `G92 Z${n(zOffset)}`, afterX: `G92 X${n(xOffset)}`, afterY: `G92 Y${n(yOffset)}` })}
${end(token)}`;
  }
  const sx = loc === "front-right" || loc === "back-right" ? -1 : 1;
  const sy = loc === "back-left" || loc === "back-right" ? -1 : 1;
  const rotated90 = loc === "front-right" || loc === "back-left";
  const xOff = rotated90 ? yOffset : xOffset, yOff = rotated90 ? xOffset : yOffset;
  const keepY = loc === "center-x";
  return `${begin(token)}
${keepY ? "G92 X0 Z0" : "G92 X0 Y0 Z0"}
${cornerProbeSequence({ sx, sy, plunge, zLift, fastSeek: fast, slowSeek: slow, afterZ: `G92 Z${n(zOffset)}`, afterX: `G92 X${n(sx * xOff)}`, afterY: `G92 Y${n(sy * yOff)}`, remember: loc === "center" || keepY, probeY: !keepY })}
${end(token)}`;
}

// Second placement for center probing: mirror of the first, then take the midpoints.
// The two Z touches must agree within 0.5 mm, or nothing is moved sideways (ofprobe_ok = 0).
export function centerSecondProgram({ config, loc, dia: d, token }) {
  const cfg = config.probe;
  const h = cfg["probe-zdim"], slow = cfg["probe-slow-seek"], fast = cfg["probe-fast-seek"];
  const zLift = 1, plunge = Math.min(12.7, h * 0.9) + zLift, r = (d ? d.mm : 0) / 2;
  const keepY = loc === "center-x";
  const leftDim = cfg["probe-xdim"], rightDim = keepY ? cfg["probe-ydim"] : cfg["probe-xdim"], frontDim = cfg["probe-ydim"], backDim = cfg["probe-ydim"];
  const halfX = `[[#5061 - #<_ofprobe_xa> + ${leftDim} + ${rightDim}] / 2 + ${n(r)}]`;
  const halfY = `[[#5062 - #<_ofprobe_ya> + ${frontDim} + ${backDim}] / 2 + ${n(r)}]`;
  const rest = cornerProbeSequence({
    sx: -1, sy: -1, plunge, zLift, fastSeek: fast, slowSeek: slow, skipZ: true, base: 120,
    afterX: `#<_ofprobe_hx> = ${halfX}\nG92 X[[#5061 - #<_ofprobe_xa> + ${leftDim} - ${rightDim}] / 2]`,
    afterY: `#<_ofprobe_hy> = ${halfY}\nG92 Y[[#5062 - #<_ofprobe_ya>] / 2]`,
    probeY: !keepY,
  }).replace(/\nG91 G0 Z25$/, ""); // lifted below, on every path
  return `${begin(token)}
#<_ofprobe_ok> = 0
G91 G38.2 Z-25 F${fast}
G91 G1 Z1
G91 G38.2 Z-2 F${slow}
#<_ofprobe_dz> = [#5063 - #<_ofprobe_zt>]
#<_ofprobe_ok> = 1
o110 if [ABS[#<_ofprobe_dz>] GT 0.5]
#<_ofprobe_ok> = 0
o110 endif
o111 if [#<_ofprobe_ok> EQ 1]
${rest}
o111 endif
G91 G0 Z25
${end(token)}`;
}

// Why a probe step did not complete: shown on the Done step.
export const FAIL_TEXT = {
  notfound: ["Probe block not found", "Make sure the tip of the bit is less than 25 mm (1 in) above the probe block, and try again."],
  estop: ["Emergency stop", "Probing was stopped by the E-stop. Zero may be partly changed: probe again before running a job."],
  stopped: ["Probing stopped", "The probe program stopped before the end. Zero may be partly changed: probe again before running a job."],
  nostart: ["Probing did not start", "The controller did not run the probe program. Check the connection and that the machine is idle, then try again."],
  send: ["Probing not sent", "The probe program could not be sent: this screen is not connected to the controller. Nothing was moved. Try again when it is connected."],
  refused: ["Probing refused", "The controller refused the probe program. The message is in the error popup. Nothing was moved by this step."],
  spindle: ["Spindle is turning", "The controller reports the spindle turning. Probing needs it stopped: switch it off (M5, or the router's own switch) and wait until it has stopped. Nothing was moved."],
  guard: ["Probing stopped", ""],
};
export function failText(reason, code, extra) {
  const [title, text] = FAIL_TEXT[reason] || FAIL_TEXT.stopped;
  if (reason === "guard") return [title, `${FAILS[code] || "A guarded move touched something."} Zero may be partly changed: probe again before running a job.`];
  return [title, extra ? `${text} ${extra}` : text];
}
