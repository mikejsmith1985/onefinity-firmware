import { execFileSync } from "child_process";
import { squarePoints } from "../src/square.js";
// Mock Onefinity controller for developing the React UI without a machine.
// Serves /api/* and the raw /websocket state feed on :8080.
import http from "node:http";
import fs from "node:fs";
import path_ from "node:path";
import { fileURLToPath } from "node:url";
const NEXT = process.env.MOCK_UI_DIR || path_.resolve(path_.dirname(fileURLToPath(import.meta.url)), "../../resources/next");
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".woff": "font/woff" };
import { WebSocketServer } from "ws";
import { spawnSync } from "node:child_process";

const PORT = process.env.PORT || 8080;

const state = {
  sid: "mock",
  xx: "READY", cycle: "idle", pr: "", er: "", line: 0,
  selected: "fuel_filter_outline.nc", selected_time: 1,
  files: ["fuel_filter_outline.nc", "alternator_arm.nc", "tap_holes.nc"],
  messages: [],
  xp: 120.5, yp: 88.06, zp: -3.35, ap: 0, bp: 0, cp: 0,
  offset_x: 0, offset_y: 0, offset_z: 0,
  "0homed": true, "1homed": true, "2homed": true, "3homed": true, home_at: 1,
  "0tn": 0, "0tm": 816, "1tn": 0, "1tm": 816, "2tn": 0, "2tm": 816, "3tn": -133, "3tm": 0,
  "0an": 0, "1an": 1, "2an": 1, "3an": 2,
  macros_list: [], non_macros_list: [], gcode_list: { folders: [], files: [] },
  vin: 24.1, vout: 5.0, temp: 41, rpi_temp: 52, mx: 17000, ss: 17000, pd: 0,
  log: [], 1: 0,
  feed: 0, speed: 0, s: 17000, v: 0, tool: 5, plan_time: 0, metric: true,
  imperial: false, power_shutdown: false,
  // Router and vac plugs (1.35.0). MOCK_PLUG_OFFLINE=1: the router plug does not answer.
  plug_router: process.env.MOCK_PLUG_OFFLINE ? "offline" : "off", plug_router_auto: true, plug_router_w: 0,
  plug_vac: "off", plug_vac_auto: true, plug_vac_w: 0,
  path_min_x: 0, path_max_x: 150, path_min_y: 0, path_max_y: 90, path_min_z: -15, path_max_z: 15,
};
// MOCK_START_UNHOMED=1 starts with no axis homed (as after a controller restart).
if (process.env.MOCK_START_UNHOMED) for (const i of [0, 1, 2, 3]) state[`${i}homed`] = false;
const jogLog = [];
const made = {}; // programs written by the mock (Cut deeper)
const MOCK_TEXT = "G21\nG90\nG0 Z15\nM3 S17000\nG1 X10 Y10 F300\nG1 Z-5\nG1 X140 F1500\nG1 Y80\nG1 X10\nG1 Y10\nT2 M6\nG1 X20\nM5\nT3\nM6\nM30\n";
const store = { checkpoint: process.env.MOCK_FINISHED ? { v: 1, seq: 7, t: Math.floor(Date.now() / 1000) - 600, status: "stopped", file: "fuel_filter_outline.nc", nlines: 100, line: 100, tool: 1, offset: { x: 0, y: 0, z: 0 } } : process.env.MOCK_INTERRUPTED ? { v: 1, seq: 5, t: Math.floor(Date.now() / 1000) - 3600, status: "running", file: "alternator_arm.nc", nlines: 12840, line: 4212, offset: { x: 163.142, y: 217.435, z: -58.989 } } : null };
// MOCK_OFFSET=1: the zero has changed since the job stopped (as after a restart restored an older zero)
if (process.env.MOCK_OFFSET) Object.assign(state, { offset_x: 188.322, offset_y: 146.319, offset_z: -55.036 });
const macros = [
  { name: "Dry Run On", color: "#4f8cff", file_name: "DryRun_On.nc" },
  { name: "Dry Run Off", color: "#4f8cff", file_name: "DryRun_Off.nc" },
  { name: "Set Laser Zero", color: "#46c37b", file_name: "laser.nc" },
  { name: "Tool Change", color: "#f5c518", file_name: "Tool_Change_FrontCenter.nc" },
];
const R = path_.resolve(NEXT, "..");
const rj = (f) => JSON.parse(fs.readFileSync(path_.join(R, f), "utf8"));
const deepMerge = (a, b) => { for (const k of Object.keys(b)) { if (b[k] && typeof b[k] === "object" && !Array.isArray(b[k]) && a[k] && typeof a[k] === "object") deepMerge(a[k], b[k]); else a[k] = b[k]; } return a; };
const config = rj("onefinity_defaults.json"); const variant = rj("onefinity_machinist_x35_defaults.json");
config.motors = config.motors.map((m, i) => ({ ...m, ...(variant.motors[i] || {}), axis: ["X", "Y", "Y", "Z"][i] }));
config.motors[3]["max-soft-limit"] = 133; config.motors[3]["homing-mode"] = "stall-max";
const TOOL = process.env.MOCK_TOOL || "custom-modbus-vfd";
const TNAME = { "custom-modbus-vfd": "Custom Modbus VFD", "delta-vfd": "Delta VFD015M21A (Beta)", "redline-vfd": "Redline VFD", laser: "PWM Spindle", router: "Disabled" }[TOOL];
config.tool["selected-tool"] = TOOL; config.tool["tool-type"] = TNAME;
if (TOOL === "laser") config.tool["max-spin"] = 1000; // MOCK_TOOL=laser: the router program below asks for S17000
const regs = config["modbus-spindle"].regs = Array.from({ length: 32 }, () => ({ "reg-type": "disabled", "reg-addr": 0, "reg-value": 0 }));
regs[0] = { "reg-type": "connect-write", "reg-addr": 8192, "reg-value": 1 }; regs[1] = { "reg-type": "freq-set", "reg-addr": 8193, "reg-value": 0 }; regs[2] = { "reg-type": "status-read", "reg-addr": 8448, "reg-value": 0 };
const TY = ["disabled","connect-write","max-freq-read","max-freq-fixed","freq-set","freq-signed-set","freq-scaled-set","stop-write","forward-write","reverse-write","freq-read","freq-signed-read","freq-actech-read","status-read","disconnect-write"];
"0123".split("").forEach((r, i) => { state[r + "vt"] = TY.indexOf(regs[i]["reg-type"]); state[r + "va"] = regs[i]["reg-addr"]; state[r + "vv"] = regs[i]["reg-value"]; state[r + "vr"] = i === 2 ? 3 : 0; });
state.mx = 1;
// User I/O settings (1.45.0): template defaults, as Config._defaults() fills them on the controller
{ const ut = rj("config-template.json")["user-io"]; config["user-io"] = Object.fromEntries(Object.entries(ut).map(([k, v]) => [k, v.default])); }
config.full_version = "1.9.0"; config.macros = macros; config.settings = config.settings || {}; config.settings.units = "METRIC";
state.macros = macros; state.macros_list = macros.map((m) => m.file_name); state.non_macros_list = state.files;
// Same shape as the real controller's config: folders with {file_name} entries. tap_holes.nc is in no folder
// (as when a program is uploaded straight to /api/file) and must still show in the default folder.
state.gcode_list = [{ name: "default", type: "folder", files: [{ file_name: "fuel_filter_outline.nc" }] }, { name: "Jobs", type: "folder", files: [{ file_name: "alternator_arm.nc" }] }];
config.gcode_list = JSON.parse(JSON.stringify(state.gcode_list)); config.non_macros_list = state.files.map((f) => ({ file_name: f }));
state.messages = [];
state.log = [];

// A small toolpath: outline rectangle with a few plunges.
const pts = [];
const spd = [];
function seg(x, y, z, s) { pts.push(x, y, z); spd.push(s); }
seg(0, 0, 15, NaN);
seg(10, 10, 15, NaN);
for (const depth of [-5, -10, -15]) {
  seg(10, 10, depth, 300);
  seg(140, 10, depth, 1500);
  seg(140, 80, depth, 1500);
  seg(10, 80, depth, 1500);
  seg(10, 10, depth, 1500);
}
seg(10, 10, 15, NaN);
// MOCK_POSITIONS=file: serve a real controller path (positions.bin from /api/path/<file>/positions)
const positions = process.env.MOCK_POSITIONS ? fs.readFileSync(process.env.MOCK_POSITIONS) : Buffer.from(new Float32Array(pts).buffer);
const speeds = Buffer.from(new Float32Array(spd).buffer);

let timer = null;
// M62-M66 (1.45.0): state.user_io as the controller works it out (UserIO.plan via mock/userio.py)
function mockUserIo() {
  try { return JSON.parse(execFileSync("python3", [new URL("./userio.py", import.meta.url).pathname], { input: JSON.stringify(config) }).toString()); }
  catch (e) { return { outputs: {}, inputs: {}, notes: ["mock: " + e.message] }; }
}

function broadcast(diff) {
  Object.assign(state, diff);
  const msg = JSON.stringify(diff);
  for (const c of wss.clients) if (c.readyState === 1) c.send(msg);
}
function run(dryLift = 0) {
  const n = pts.length / 3;
  let i = 0;
  broadcast({ xx: "RUNNING", cycle: "running", feed: 1500, speed: dryLift ? 0 : 17000, v: 0, dry_run: !!dryLift, dry_lift: dryLift, dry_note: dryLift ? "First pass of each of 6 operations at 3000 mm/min, about 2 min 09 s." : "" });
  clearInterval(timer);
  timer = setInterval(() => {
    if (state.xx === "HOLDING") return;
    if (i >= n) {
      clearInterval(timer);
      broadcast({ xx: "READY", cycle: "idle", feed: 0, speed: 0, line: 0, plan_time: 0, dry_run: false, dry_lift: 0, dry_note: "" });
      return;
    }
    broadcast({ xp: pts[i * 3], yp: pts[i * 3 + 1], zp: pts[i * 3 + 2], line: i + 1, plan_time: i * 4 });
    i++;
  }, process.env.MOCK_RUN_FAST ? 25 : 400);
}
const mdiLog = [];
let probeStop = false;
// Shared screen session (Session.py): {name: {v, rev}} with compare-and-set writes.
state.ui = {}; state.store_rev = {}; state.last_error = null; state.fo = 1000; state.so = 1000;
const uiRevs = {}; let errId = 0, starts = 0;
function uiPut(name, body) {
  const cur = state.ui[name], rev = cur ? cur.rev : uiRevs[name] || 0;
  if (body.rev !== undefined && body.rev !== null && +body.rev !== rev && !(+body.rev === 0 && !cur)) return { ok: false, v: cur ? cur.v : null, rev };
  const n = rev + 1; uiRevs[name] = n;
  const ui = { ...state.ui };
  if (body.v === null || body.v === undefined) delete ui[name]; else ui[name] = { v: body.v, rev: n };
  broadcast({ ui });
  return { ok: true, v: body.v ?? null, rev: n };
}
const storeChanged = (name) => broadcast({ store_rev: { ...state.store_rev, [name]: (state.store_rev[name] || 0) + 1 } });
const tokOf = (text, v) => [...text.matchAll(new RegExp(`#<_${v}>\\s*=\\s*(\\d+)`, "g"))].map((m) => +m[1]).filter(Boolean).pop() ?? 0;
// The program's progress marks (#<_of_step> = N, 1.31.1), reported one after the other over ms
// MOCK_SLOW=k stretches the measure / setter runs k times (for screenshots taken mid-run)
const clientLog = [];
const SLOW = +(process.env.MOCK_SLOW || 1);
function playMarks(text, ms) {
  const n = [...text.matchAll(/^#<_of_step> = (\d+) \(/gm)].map((m) => +m[1]);
  broadcast({ of_step: 0 });
  n.forEach((v, i) => setTimeout(() => broadcast({ of_step: v }), ((i + 0.5) * ms) / Math.max(1, n.length)));
}
// Bed camera (1.36.0): a fake overhead camera over a fake bed (mock/bedscene.py)
const BED_Z = -100, STOCK = { cx: 300, cy: 250, w: 150, l: 90, t: 19, ang: (4 * Math.PI) / 180 };
const MOCK_SETTER = [763.2, 757.9]; // where the mock's tool setter really is (1.40.0)
// 1.42.0: how far the current homing reads off (machine = physical - hshift). MOCK_HOME_ERR="dx,dy":
// each homing (PUT /api/home) comes out that far off. "mock:homeerr dx dy" sets it for the next homing.
let hshift = [0, 0], nextHomeErr = (process.env.MOCK_HOME_ERR || "0,0").split(",").map(Number);
let mockTool = 0; // 1.39.0: how much longer the tool in the spindle is than the probe (mock:tool N)
let stockOn = false, camSize = { width: 1280, height: 720 };
const onStock = (x, y) => {
  const dx = x - STOCK.cx, dy = y - STOCK.cy, u = dx * Math.cos(STOCK.ang) + dy * Math.sin(STOCK.ang), v = -dx * Math.sin(STOCK.ang) + dy * Math.cos(STOCK.ang);
  return stockOn && Math.abs(u) <= STOCK.w / 2 && Math.abs(v) <= STOCK.l / 2;
};
function runFake(fn, ms = 500) { broadcast({ xx: "RUNNING", cycle: "running" }); setTimeout(() => broadcast({ ...fn(), xx: "READY", cycle: "idle" }), ms); }
// 1.38.0: the probe's LED (MOCK_NO_LED=1: a camera that can't see it)
const probeLed = () => (process.env.MOCK_NO_LED ? null : (state.pt === 2 ? state.pw === 1 : state.pw === 0) ? "red" : "green");
const probeRest = () => (state.pt === 2 ? 0 : 1);
function bedcamMdi(text) {
  const num = (re) => { const m = re.exec(text); return m ? +m[1] : null; };
  if (text.startsWith("mock:stock ")) { stockOn = text.endsWith("on"); return true; }
  if (text.startsWith("mock:pos ")) { const [x, y, z] = text.slice(9).split(" ").map(Number); broadcast({ xp: x, yp: y, zp: z }); return true; }
  if (text.includes("(Bed camera: touch the bed)")) {
    const floor = onStock(state.xp, state.yp) ? BED_Z + STOCK.t : BED_Z;
    runFake(() => ({ zp: floor + 0.2, ofc_z: floor, ofc_ok: 1 })); return true;
  }
  if (text.includes("(Bed camera: auto touch)")) {
    const x = num(/G53 G0 X(-?[\d.]+)/), y = num(/ Y(-?[\d.]+)/), top = num(/G53 G0 Z(-?[\d.]+)/);
    const floor = onStock(x, y) ? BED_Z + STOCK.t : BED_Z;
    runFake(() => ({ xp: x, yp: y, zp: +(floor - 0.15).toFixed(3), ofa_z: floor, ofa_ok: 1, pw: 1 - probeRest() }), 600); return true;
  }
  if (text.includes("(Bed camera: sideways)")) { const dx = num(/G0 X(-?[\d.]+)/); runFake(() => ({ xp: +(state.xp + dx).toFixed(3) }), 300); return true; }
  if (text.includes("(Bed camera: lift)")) { const dz = num(/G0 Z(-?[\d.]+)/); runFake(() => ({ zp: +(state.zp + dz).toFixed(3), pw: probeRest() })); return true; }
  // 1.39.0: bed markers
  if (text.includes("(Bed markers: show)")) {
    const x = num(/G53 G0 X(-?[\d.]+)/), y = num(/ Y(-?[\d.]+)/);
    runFake(() => ({ xp: x, yp: y, zp: num(/G53 G0 Z(-?[\d.]+)/) }), 300); return true;
  }
  if (text.includes("(Bed markers: carve)")) { runFake(() => ({ zp: num(/G53 G0 Z(-?[\d.]+)/) }), 1200); return true; }
  if (text.startsWith("mock:tool ")) { mockTool = +text.slice(10); return true; }
  if (text.startsWith("mock:homeerr ")) { nextHomeErr = text.slice(13).split(" ").map(Number); return true; }
  // 1.40.0: the probe finds the setter's centre (round body, 13.35 mm to the spindle at a touch)
  // 1.42.0: where it reads depends on how far this homing was off (hshift, see /api/home)
  if (text.includes("(Tool setter: find centre)")) {
    const sx = num(/G53 G0 X(-?[\d.]+) Y/), sy = num(/G53 G0 X-?[\d.]+ Y(-?[\d.]+)/), R = 13.355;
    const cx = MOCK_SETTER[0] - hshift[0], cy = MOCK_SETTER[1] - hshift[1], far = Math.hypot(sx - cx, sy - cy) > 12;
    const pts = {};
    for (let i = 0; i < 8; i++) { const a = (i * Math.PI) / 4; pts[`ofx_p${i}`] = 1; pts[`ofx_x${i}`] = cx + R * Math.cos(a); pts[`ofx_y${i}`] = cy + R * Math.sin(a); }
    runFake(() => (far ? { ofx_ok: 0, ofx_fail: 1 } : { ofx_ok: 1, ofx_fail: 0, ofx_top: -15.2, xp: +(cx + 17.7).toFixed(3), yp: +(cy - 17.7).toFixed(3), zp: -1, ...pts }), 1500);
    return true;
  }
  // 1.43.0: the squareness check, on a 1-2-3 block under the start position, turned 1 degree, on a
  // machine whose X/Y are MOCK_SKEW degrees out of square (default 0.03)
  if (text.includes("(Squareness check")) {
    const [, a, b, ball] = /block (-?[\d.]+) x (-?[\d.]+), ball (-?[\d.]+)/.exec(text).map(Number);
    const skew = +(process.env.MOCK_SKEW ?? 0.03), r = ball / 2, cx = state.xp, cy = state.yp;
    const t = Math.PI / 180, uA = 1 * t, vA = uA + Math.PI / 2 + skew * t;
    const u = [Math.cos(uA), Math.sin(uA)], v = [Math.cos(vA), Math.sin(vA)];
    // the faces as lines p = c + s*dir, pushed out by the ball's radius along their outward normal
    const face = (c, dir, out) => { const nn = [dir[1], -dir[0]], k = nn[0] * out[0] + nn[1] * out[1] > 0 ? 1 : -1; return { p: [c[0] + k * r * nn[0], c[1] + k * r * nn[1]], d: dir }; };
    const F = { front: face([-b / 2 * v[0], -b / 2 * v[1]], u, [0, -1]), back: face([b / 2 * v[0], b / 2 * v[1]], u, [0, 1]),
      left: face([-a / 2 * u[0], -a / 2 * u[1]], v, [-1, 0]), right: face([a / 2 * u[0], a / 2 * u[1]], v, [1, 0]) };
    const pts = squarePoints({ a, b, ball }), out = { ofq_ok: 1, ofq_fail: 0, ofq_zt: -60 };
    pts.forEach((q, i) => {
      const f = F[q.side];
      // where the line from q along the axis meets the face line
      const ax = q.axis === "X" ? [1, 0] : [0, 1];
      const den = ax[0] * f.d[1] - ax[1] * f.d[0], w = [f.p[0] - q.x, f.p[1] - q.y];
      const s2 = (w[0] * f.d[1] - w[1] * f.d[0]) / den;
      out[`ofq_x${i}`] = +(cx + q.x + s2 * ax[0]).toFixed(4); out[`ofq_y${i}`] = +(cy + q.y + s2 * ax[1]).toFixed(4);
    });
    runFake(() => out, 1500);
    return true;
  }
  // 1.42.0: the homing correction: G28.3 sets the machine reading (the homing's error changes),
  // G92 the work reading, then back over the same physical spot
  if (text.includes("(Tool setter: homing check)")) {
    const out = {}; let x = state.xp, y = state.yp, z = state.zp;
    for (const line of text.split("\n")) {
      let g;
      if ((g = /^G28\.3 X(-?[\d.]+) Y(-?[\d.]+)/.exec(line))) { hshift = [x + hshift[0] - +g[1], y + hshift[1] - +g[2]]; x = +g[1]; y = +g[2]; }
      else if ((g = /^G92 (.*)/.exec(line))) for (const [, a, v] of g[1].matchAll(/([XY])(-?[\d.]+)/g)) out[a === "X" ? "offset_x" : "offset_y"] = +((a === "X" ? x : y) - +v).toFixed(4);
      else if ((g = /^G53 G0 X(-?[\d.]+) Y(-?[\d.]+)/.exec(line))) { x = +g[1]; y = +g[2]; }
      else if ((g = /^G53 G0 Z(-?[\d.]+)/.exec(line))) z = +g[1];
    }
    runFake(() => ({ ...out, xp: x, yp: y, zp: z }), 600);
    return true;
  }
  if (text.includes("(Bed camera: park)")) {
    const z = num(/G53 G0 Z(-?[\d.]+)/), x = num(/G53 G0 X(-?[\d.]+)/), y = num(/ Y(-?[\d.]+)/);
    runFake(() => ({ xp: x, yp: y, zp: z }), 800); return true;
  }
  if (text.includes("(Measure stock: move over the stock")) {
    const z = num(/G53 G0 Z(-?[\d.]+)/), x = num(/G53 G0 X(-?[\d.]+)/), y = num(/ Y(-?[\d.]+)/);
    const hit = onStock(x, y), top = BED_Z + STOCK.t;
    runFake(() => (hit ? { xp: x, yp: y, zp: top + 8, ofb_top: top, ofb_ok: 1, ofb_hit: 1 } : { xp: x, yp: y, zp: z, ofb_ok: 0, ofb_hit: 0 }), 1200);
    return true;
  }
  const mv = /^G21\nG90 G53 G0 X(-?[\d.]+) Y(-?[\d.]+)/.exec(text);
  if (mv) { runFake(() => ({ xp: +mv[1], yp: +mv[2] }), 300); return true; }
  return false;
}
function mdi(text) {
  mdiLog.push(text);
  if (bedcamMdi(text)) return;
  // Probing (Probe XYZ / Z): run for a second, then set an offset
  if (/G38\.2/.test(text) && !text.includes("#<_ofm_ok>") && !text.includes("#<_ofs_ok>")) {
    broadcast({ xx: "RUNNING", cycle: "mdi" });
    // 1.31.1: the program runs through the controller's own planner code (mock/probe.py, see
    // src/py/tests/seekharness.py) on a touch plate placed under the bit, and the state updates it
    // produces (the move being run, positions, the done token, the new zero) are played back. A
    // probing move that nobody restarts leaves it RUNNING for ever, as on the machine.
    if (!process.env.MOCK_PROBE_FAIL && !probeStop && !process.env.MOCK_PROBE_SIMPLE) {
      const r = spawnSync("python3", [path_.join(path_.dirname(fileURLToPath(import.meta.url)), "probe.py")],
        { input: JSON.stringify({ program: text, xp: state.xp, yp: state.yp, zp: state.zp }), encoding: "utf8" });
      let frames = null;
      try { frames = JSON.parse(r.stdout); } catch { console.error("mock probe.py:", r.stderr); }
      if (frames) {
        const gap = process.env.MOCK_PROBE_MS ? +process.env.MOCK_PROBE_MS : process.env.MOCK_RUN_FAST ? 60 : 250;
        // MOCK_PROBE_FAIL_AT=N: the touch at move N finds nothing (E-stop "Switch not found"), for the failure page
        const failAt = +(process.env.MOCK_PROBE_FAIL_AT || 0);
        if (failAt) { const k = frames.findIndex((f) => f.of_step >= failAt); if (k >= 0) frames = [...frames.slice(0, k + 1), { estop: 1 }]; }
        const last = frames[frames.length - 1] || {};
        if (last.hang) console.error("mock: probe program stalled:", last.hang);
        frames.forEach((f, i) => setTimeout(() => {
          const { end, hang, estop, ...d } = f;
          if (hang) return; // stays RUNNING
          if (estop) { broadcast({ xx: "ESTOPPED", cycle: "idle", er: "Switch not found" }); return; }
          broadcast(end ? { ...d, xx: "READY", cycle: "idle" } : d);
        }, 300 + i * gap));
        return;
      }
    }
    setTimeout(() => {
      if (process.env.MOCK_PROBE_FAIL) { broadcast({ xx: "ESTOPPED", cycle: "idle", er: "Switch not found" }); return; }
      // The program sets #<_ofprobe_done> to its token just before M2 (1.29.0). A stopped one does not.
      const tok = [...text.matchAll(/#<_ofprobe_done>\s*=\s*(\d+)/g)].map((m) => +m[1]).filter(Boolean).pop() ?? 0;
      if (probeStop) { probeStop = false; broadcast({ xx: "READY", cycle: "idle", ofprobe_done: 0, ofprobe_fail: 0 }); return; }
      broadcast({ xx: "READY", cycle: "idle", offset_z: -57.35, offset_x: text.includes("X") ? 163.142 : state.offset_x, ofprobe_ok: 1, ofprobe_dz: 0.02, ofprobe_done: tok, ofprobe_fail: 0 });
    }, 1200);
    return;
  }
  if (text === "mock:probe-stop") { probeStop = true; return; } // the next probe ends without reaching M2
  // Probe input: pt 1 = normally open (touched reads 0), 2 = normally closed (touched reads 1)
  const rest = state.pt === 2 ? 0 : 1;
  if (text === "mock:touch") { broadcast({ pw: 1 - rest }); setTimeout(() => broadcast({ pw: rest }), 300); return; }
  if (text === "mock:nc") { broadcast({ pt: 2, pw: 0 }); return; }
  if (text === "mock:open-loop") { broadcast({ pw: 1 }); return; }
  if (text.includes("#<_ofs_ok>")) {
    const ref = text.includes("#<_ofs_ref> = #5063");
    broadcast({ xx: "RUNNING", cycle: "running", ofs_ok: 0, ofs_fail: 0 });
    playMarks(text, 1200 * SLOW);
    // MOCK_SETTER_ESTOP=1: the slow touch finds nothing, as on the machine: the log says
    // "Switch not found", the controller E-stops and the cycle never returns to idle.
    if (process.env.MOCK_SETTER_ESTOP) {
      setTimeout(() => { broadcast({ log: { level: "error", msg: "Switch not found" } }); broadcast({ xx: "ESTOPPED", er: "User triggered EStop" }); }, 900 * SLOW);
      return;
    }
    setTimeout(() => {
      if (process.env.MOCK_SETTER_FAIL) broadcast({ ofs_fail: 1 });
      else broadcast(ref ? { ofs_ref: +(-15.2 + mockTool).toFixed(3), ofs_ok: 1 } : { ofs_ok: 1, offset_z: (state.offset_z || 0) + 12.7 });
      broadcast({ xx: "READY", cycle: "idle" });
    }, 1200 * SLOW);
    return;
  }
  if (text.includes("#<_ofm_ok>")) {
    const cal = /calibration/.test(text), y = text.includes("_ofm_l> = [");
    broadcast({ xx: "RUNNING", cycle: "running", ofm_ok: 0, ofm_fail: 0 });
    playMarks(text, 1500 * SLOW);
    setTimeout(() => {
      if (process.env.MOCK_MEASURE_FAIL) broadcast({ ofm_fail: +process.env.MOCK_MEASURE_FAIL });
      else broadcast({ ofm_w: cal ? 52.5 : 101.237, ofm_l: y ? 60.412 : 0, ofm_rxa: 10, ofm_rxb: cal ? 62.5 : 111.237, ofm_ok: 1, ofm_done: tokOf(text, "ofm_done"), offset_x: 160.2, offset_y: y ? 88.1 : state.offset_y, offset_z: -42.3 });
      broadcast({ xx: "READY", cycle: "idle" });
    }, 1500 * SLOW);
    return;
  }
  const m = /G0\s+(.*)/i.exec(text);
  if (/^G91/i.test(text) && m) {
    const d = {};
    for (const [, a, v] of text.matchAll(/([XYZ])(-?[\d.]+)/gi)) {
      const key = a.toLowerCase() + "p";
      d[key] = +(state[key] + parseFloat(v)).toFixed(3);
    }
    broadcast(d);
  }
}

const json = (res, obj, code = 200) => {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
};

let camFocus = null;
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  const p = url.pathname;
  if (p === "/next" || p.startsWith("/next/")) { res.writeHead(302, { Location: "/" }); return res.end(); }
  if (!p.startsWith("/api/") && !p.startsWith("/mock/") && !p.startsWith("/websocket") && !/^\/(config-template|onefinity.*)\.json$/.test(p)) {
    const f = path_.join(NEXT, p === "/" ? "index.html" : p.slice(1));
    if (f.startsWith(NEXT) && fs.existsSync(f) && fs.statSync(f).isFile()) { res.writeHead(200, { "Content-Type": MIME[path_.extname(f)] || "application/octet-stream" }); return res.end(fs.readFileSync(f)); }
    res.writeHead(404); return res.end();
  }
  if (p === "/config-template.json" || /^\/onefinity.*\.json$/.test(p)) { res.writeHead(200, { "Content-Type": "application/json" }); return res.end(fs.readFileSync(path_.join(R, p.slice(1)))); }
  if (p === "/mock/set") { let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => { try { const d = JSON.parse(b); Object.assign(state, d); broadcast(d); } catch {} json(res, "ok"); }); return; }
  // Screen diagnostics (1.37.0): what screens report; GET /api/mock/client-log reads it back for tests
  if (p === "/api/client-log") { let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => { try { clientLog.push(JSON.parse(b)); } catch {} json(res, "ok"); }); return; }
  if (p === "/api/mock/client-log") return json(res, clientLog);
  if (p === "/api/config/load") return json(res, config);
  if (p === "/api/config/save") { let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => { try { const c = JSON.parse(b); Object.assign(config, c); const d = { user_io: mockUserIo() }; for (const k of ["gcode_list", "non_macros_list"]) if (c[k]) d[k] = c[k]; if (Object.keys(d).length) broadcast(d); } catch {} storeChanged("config"); json(res, "ok"); }); return; }
  if (p.startsWith("/api/ui/")) {
    const name = p.slice(8);
    if (req.method === "GET") { const e = state.ui[name]; return json(res, e ? e : { v: null, rev: uiRevs[name] || 0 }); }
    let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => { let body = {}; try { body = JSON.parse(b); } catch {} json(res, uiPut(name, body)); }); return;
  }
  if (p === "/mock/error") { errId++; broadcast({ last_error: { id: errId, msg: url.searchParams.get("msg") || "Invalid character: ','", at: Date.now() / 1000 } }); return json(res, "ok"); }
  if (p === "/api/hostname") return json(res, "onefinity");
  if (p === "/api/network") return json(res, { ipAddresses: ["192.168.1.42"], hostname: "onefinity", wifi: { enabled: true, ssid: "Shop-WiFi", networks: [{ Name: "Shop-WiFi", Quality: 78 }, { Name: "Neighbor", Quality: 34 }, { Name: "Guest", Quality: 55 }] } });
  if (p === "/api/time") return json(res, { timeinfo: "Local time: Fri 2026-10-09 10:15:00\nTime zone: America/New_York (EDT)", timezones: "America/New_York\nAmerica/Chicago\nUTC" });
  if (p === "/api/screen-rotation") return json(res, { rotated: false });
  if (p === "/api/video") {
    const f = path_.join(path_.dirname(new URL(import.meta.url).pathname), "camera.jpg");
    if (!fs.existsSync(f)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "Content-Type": "image/jpeg" }); return res.end(fs.readFileSync(f));
  }
  if (p === "/api/camera/frame") {
    const r = spawnSync("python3", [path_.join(path_.dirname(fileURLToPath(import.meta.url)), "bedscene.py")],
      { input: JSON.stringify({ x: state.xp, y: state.yp, z: state.zp, stock: stockOn, seed: Date.now() % 1000, led: probeLed(),
        marks: process.env.MOCK_NO_MARKS ? [] : (store.bedcam?.markers?.spots || []) }) });  // 1.41.0: the carved, inked crosses
    if (r.status !== 0) { console.error("bedscene:", String(r.stderr)); res.writeHead(503); return res.end(); }
    res.writeHead(200, { "Content-Type": "image/jpeg" }); return res.end(r.stdout);
  }
  if (p === "/api/camera") {
    let b = ""; req.on("data", (d) => (b += d));
    req.on("end", () => {
      if (req.method === "PUT") { const q = JSON.parse(b || "{}"); if ("width" in q) camSize = { width: q.width, height: q.height }; else camFocus = q.focus; }
      json(res, { connected: true, locked: camFocus !== null, focus: camFocus ?? 30, range: { min: 0, max: 250, step: 5, default: 0 }, ...camSize, sizes: [[640, 480], [1280, 720]] });
    });
    return;
  }
  if (p === "/api/next-align") {
    let b = ""; req.on("data", (d) => (b += d));
    req.on("end", () => { const q = JSON.parse(b || "{}"); json(res, { file: "aligned-" + q.file, source: q.file, angle: q.angle, lines: 42 }); });
    return;
  }
  if (p === "/api/path/" + state.selected + "/positions" || /\/positions$/.test(p)) {
    res.writeHead(200, { "Content-Type": "application/octet-stream" }); return res.end(positions);
  }
  if (/\/speeds$/.test(p)) { res.writeHead(200, { "Content-Type": "application/octet-stream" }); return res.end(speeds); }
  if (p.startsWith("/api/path/")) {
    return json(res, { progress: 1, time: 600, bounds: { min: { x: 0, y: 0, z: -15 }, max: { x: 150, y: 90, z: 15 } } });
  }
  // Pre-run G-code check (Lint.py, 1.29.0). MOCK_LINT_ERROR=1 reports one error.
  if (p.startsWith("/api/lint/")) {
    const issues = process.env.MOCK_LINT_ERROR ? [{ key: "g83", level: "error", msg: "G83 (peck drill) runs as a plain G81 drill: one plunge to full depth, no pecking, which can snap a small bit.", lines: [12], count: 1 }] : [];
    return json(res, { lines: 16, errors: issues.length, warnings: 0, issues, stock_top: null, max_speed: 17000, setup: {} });
  }
  if (p.startsWith("/api/file/")) {
    const fname = decodeURIComponent(p.slice("/api/file/".length));
    if (req.method === "GET" && made[fname]) { res.writeHead(200, { "Content-Type": "text/plain" }); return res.end(made[fname]); }
    if (req.method === "GET" && process.env.MOCK_PROGRAM) { res.writeHead(200, { "Content-Type": "text/plain" }); return res.end(fs.readFileSync(process.env.MOCK_PROGRAM)); }
    if (req.method === "GET") { res.writeHead(200, { "Content-Type": "text/plain" }); return res.end("G21\nG90\nG0 Z15\nM3 S17000\nG1 X10 Y10 F300\nG1 Z-5\nG1 X140 F1500\nG1 Y80\nG1 X10\nG1 Y10\nT2 M6\nG1 X20\nM5\nT3\nM6\nM30\n"); }
    return json(res, "ok");
  }
  // Cut deeper (1.30.0): the real DoOver.py runs on the mock program (mock/doover.py)
  if (p === "/api/next-doover") {
    let b = ""; req.on("data", (d) => (b += d));
    req.on("end", () => {
      const q = JSON.parse(b || "{}");
      const rec = store.checkpoint;
      const text = made[q.file] || (process.env.MOCK_PROGRAM ? fs.readFileSync(process.env.MOCK_PROGRAM, "utf8") : MOCK_TEXT);
      let run;
      if (!rec || rec.file !== q.file) run = { status: "unknown", msg: `The controller has no saved run of ${q.file}, so it cannot check that the zero and the cut are the same as before.`, notes: [], delta: {}, homed: true };
      else if (!(rec.nlines && rec.line >= rec.nlines - 5) || ["running", "estop", "parked"].includes(rec.status)) run = { status: "interrupted", msg: `The last run of ${q.file} did not finish. Finish it with Resume first.`, notes: [], delta: {}, homed: true };
      else {
        const d = {}; for (const a of "xyz") if (Math.abs((state["offset_" + a] || 0) - (rec.offset?.[a] || 0)) > 0.05) d[a] = +((state["offset_" + a] || 0) - rec.offset[a]).toFixed(4);
        run = Object.keys(d).length ? { status: "moved", msg: `The work zero has changed since ${q.file} ran (${Object.entries(d).map(([a, v]) => `${a.toUpperCase()} by ${v} mm`).join(", ")}). Put the zero back first.`, delta: d, notes: [], homed: true }
          : { status: "ok", msg: `The work zero is the same as when ${q.file} ran.`, notes: [], delta: {}, homed: true };
      }
      if (q.action === "restore_zero") {
        const d = {}; for (const a of [...(q.axes || "xyz")]) d["offset_" + a] = rec?.offset?.[a] ?? 0;
        broadcast(d); return json(res, { axes: [...(q.axes || "xyz")], cmd: "G92 (mock)", offset: d });
      }
      const py = spawnSync("python3", [path_.join(path_.dirname(fileURLToPath(import.meta.url)), "doover.py")], { input: JSON.stringify({ ...q, text, run }), encoding: "utf8" });
      let out; try { out = JSON.parse(py.stdout); } catch { out = { err: `mock doover.py failed: ${py.stderr}` }; }
      if (out.err) { res.writeHead(400, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ message: out.err, code: 400 })); }
      if (q.action === "build") {
        made[out.ok.file] = out.text;
        const files = state.files.includes(out.ok.file) ? state.files : [...state.files, out.ok.file].sort();
        broadcast({ files, selected: out.ok.file, selected_time: Date.now() });
      }
      json(res, out.ok);
    });
    return;
  }
  if (p === "/api/next-resume") {
    let b = ""; req.on("data", (d) => (b += d));
    req.on("end", () => {
      const q = JSON.parse(b || "{}");
      if (q.action === "build") {
        if (process.env.MOCK_UNHOMED) { res.writeHead(400, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ message: "Home the machine first.", code: 400 })); }
        return json(res, { file: "resume-alternator_arm.nc", source: "alternator_arm.nc", line: 4212, line_text: "G1 X61.25 Y18.4", header_lines: 20, tool: 2, spindle: "M3", speed: 17000, units: "mm", wcs: "G54", pos: { x: 61.25, y: 12.9, z: -6 }, spinup: q.opts.spinup, plunge: q.opts.plunge, pause: q.opts.pause, warnings: [], ...(() => { const sv = store.checkpoint?.offset || {}; const d = {}; for (const a of "xyz") if (sv[a] !== undefined && Math.abs((state["offset_" + a] || 0) - sv[a]) > 0.05) d[a] = +((state["offset_" + a] || 0) - sv[a]).toFixed(4); return { offset_ok: !Object.keys(d).length, offset_delta: d }; })() });
      }
      if (q.action === "restore_zero") {
        const sv = store.checkpoint?.offset || {}, axes = [...(q.axes || "xyz")].filter((a) => sv[a] !== undefined), d = {};
        for (const a of axes) d["offset_" + a] = sv[a];
        broadcast(d);
        return json(res, { axes, cmd: "G92 (mock)", offset: d });
      }
      if (q.action === "park") {
        clearInterval(timer); broadcast({ park: "parking" });
        setTimeout(() => { broadcast({ xx: "READY", cycle: "idle", feed: 0, speed: 0, park: "parked" }); if (store.checkpoint) store.checkpoint.status = "parked"; }, 1500);
        return json(res, "ok");
      }
      if (q.action === "clear") { broadcast({ park: "" }); return json(res, "ok"); }
      res.writeHead(400); res.end("{}");
    });
    return;
  }
  if (p === "/api/next-store/checkpoint") {
    if (req.method === "PUT") { req.on("data", () => {}); req.on("end", () => { if (store.checkpoint) store.checkpoint.status = "dismissed"; json(res, "ok"); }); return; }
    return json(res, store.checkpoint ?? null);
  }
  if (p.startsWith("/api/next-store/")) {
    const n = p.split("/").pop();
    if (req.method === "PUT") { let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => { store[n] = JSON.parse(b); storeChanged(n); json(res, "ok"); }); return; }
    return json(res, store[n] ?? null);
  }
  if (p.startsWith("/api/override/")) { const [, , , kind, v] = p.split("/"); broadcast({ [kind === "feed" ? "fo" : "so"]: Math.round(parseFloat(v) * 1000) }); return json(res, "ok"); }
  if (p === "/api/jog") { let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => { jogLog.push(b); json(res, "ok"); }); return; }
  if (p === "/api/jogs") return json(res, jogLog);
  if (p === "/api/mdis") return json(res, mdiLog);
  if (p === "/api/starts") return json(res, starts);
  if (p === "/api/start") {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      let lift = 0, ack = false;
      try { const b = JSON.parse(body || "{}") || {}; lift = +b.dry_lift || 0; ack = !!b.ack; } catch { /* no body */ }
      if (process.env.MOCK_LINT_ERROR && !ack) { res.writeHead(409, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ message: "Not started. G-code check: G83 (peck drill) runs as a plain G81 drill (line 12)", code: 409 })); }
      starts++;
      run(lift);
      json(res, "ok");
    });
    return;
  }
  if (p === "/api/home-prompt") { broadcast({ home_prompt: "done" }); return json(res, "ok"); }
  if (p === "/api/pause") { broadcast({ xx: "HOLDING", pr: "User pause" }); return json(res, "ok"); }
  if (p === "/api/unpause") { broadcast({ xx: "RUNNING", pr: "" }); return json(res, "ok"); }
  if (p === "/api/stop") { clearInterval(timer); broadcast({ xx: "READY", cycle: "idle", feed: 0, speed: 0, pr: "" }); return json(res, "ok"); }
  if (p === "/api/estop") { clearInterval(timer); broadcast({ xx: "ESTOPPED", er: "User triggered EStop", feed: 0, speed: 0, plug_router: state.plug_router === "offline" ? "offline" : "off", plug_router_w: 0, plug_vac: "off", plug_vac_w: 0 }); return json(res, "ok"); }
  if (p === "/api/plugs") {
    let s = ""; req.on("data", (d) => (s += d)); req.on("end", () => {
      let b = {}; try { b = JSON.parse(s); } catch {}
      if (state[`plug_${b.plug}`] === "offline") { res.writeHead(400, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ message: "The plug is not answering", code: 400 })); }
      broadcast({ [`plug_${b.plug}`]: b.on ? "on" : "off", [`plug_${b.plug}_w`]: b.on ? (b.plug === "vac" ? 980 : 412) : 0 });
      json(res, "ok");
    });
    return;
  }
  if (p === "/api/clear") { broadcast({ xx: "READY", er: "" }); return json(res, "ok"); }
  if (p.startsWith("/api/home")) {
    // the machine's position reading moves by the change in the homing's error
    const d = [nextHomeErr[0] - hshift[0], nextHomeErr[1] - hshift[1]]; hshift = [...nextHomeErr];
    broadcast({ xx: "HOMING", cycle: "homing", home_at: Date.now(), xp: +(state.xp - d[0]).toFixed(3), yp: +(state.yp - d[1]).toFixed(3) });
    setTimeout(() => broadcast({ "0homed": true, "1homed": true, "2homed": true, "3homed": true, xx: "READY", cycle: "idle" }), 1200);
    return json(res, "ok");
  }
  if (p.startsWith("/api/position/")) {
    const a = p.split("/").pop();
    let b = ""; req.on("data", (d) => (b += d));
    req.on("end", () => {
      // Sets the work position of an axis: the offset becomes machine position less it
      json(res, "ok");
    });
    return;
  }
  return json(res, "ok");
});

const wss = new WebSocketServer({ server, path: "/websocket" });
wss.on("connection", (ws) => {
  ws.send(JSON.stringify(state));
  ws.on("message", (d) => mdi(d.toString()));
});
setInterval(() => { for (const c of wss.clients) if (c.readyState === 1) c.send(JSON.stringify({ heartbeat: 1 })); }, 3000);

// MOCK_CHATTER=1: send a small status update every 200 ms, like a real controller does while idle,
// so the UI re-renders while you type (needed to reproduce on-screen keyboard problems).
if (process.env.MOCK_CHATTER) setInterval(() => broadcast({ rpi_temp: 45 + Math.random() }), 200);
state.user_io = mockUserIo();
server.listen(PORT, () => console.log(`mock controller on :${PORT}`));
