// Mock Onefinity controller for developing the React UI without a machine.
// Serves /api/* and the raw /websocket state feed on :8080.
import http from "node:http";
import fs from "node:fs";
import path_ from "node:path";
import { fileURLToPath } from "node:url";
const NEXT = path_.resolve(path_.dirname(fileURLToPath(import.meta.url)), "../../resources/next");
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".woff": "font/woff" };
import { WebSocketServer } from "ws";

const PORT = process.env.PORT || 8080;

const state = {
  sid: "mock",
  xx: "READY", cycle: "idle", pr: "", er: "", line: 0,
  selected: "fuel_filter_outline.nc", selected_time: 1,
  files: ["fuel_filter_outline.nc", "alternator_arm.nc", "tap_holes.nc"],
  messages: [],
  xp: 120.5, yp: 88.06, zp: -3.35, ap: 0, bp: 0, cp: 0,
  offset_x: 0, offset_y: 0, offset_z: 0,
  "0homed": true, "1homed": true, "2homed": true, "3homed": true,
  "0tn": 0, "0tm": 816, "1tn": 0, "1tm": 816, "2tn": 0, "2tm": 816, "3tn": -133, "3tm": 0,
  "0an": 0, "1an": 1, "2an": 1, "3an": 2,
  macros_list: [], non_macros_list: [], gcode_list: { folders: [], files: [] },
  vin: 24.1, vout: 5.0, temp: 41, rpi_temp: 52, mx: 17000, ss: 17000, pd: 0,
  log: [], 1: 0,
  feed: 0, speed: 0, s: 17000, v: 0, tool: 5, plan_time: 0, metric: true,
  imperial: false, power_shutdown: false,
  path_min_x: 0, path_max_x: 150, path_min_y: 0, path_max_y: 90, path_min_z: -15, path_max_z: 15,
};
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
config.full_version = "1.9.0"; config.macros = macros; config.settings = config.settings || {}; config.settings.units = "METRIC";
state.macros = macros; state.macros_list = macros.map((m) => m.file_name); state.non_macros_list = state.files;
state.gcode_list = { folders: [{ name: "Jobs", files: ["alternator_arm.nc"] }], files: ["fuel_filter_outline.nc", "tap_holes.nc"] };
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
const positions = Buffer.from(new Float32Array(pts).buffer);
const speeds = Buffer.from(new Float32Array(spd).buffer);

let timer = null;
function broadcast(diff) {
  Object.assign(state, diff);
  const msg = JSON.stringify(diff);
  for (const c of wss.clients) if (c.readyState === 1) c.send(msg);
}
function run() {
  const n = pts.length / 3;
  let i = 0;
  broadcast({ xx: "RUNNING", cycle: "running", feed: 1500, speed: 17000, v: 0 });
  clearInterval(timer);
  timer = setInterval(() => {
    if (state.xx === "HOLDING") return;
    if (i >= n) {
      clearInterval(timer);
      broadcast({ xx: "READY", cycle: "idle", feed: 0, speed: 0, line: 0, plan_time: 0 });
      return;
    }
    broadcast({ xp: pts[i * 3], yp: pts[i * 3 + 1], zp: pts[i * 3 + 2], line: i + 1, plan_time: i * 4 });
    i++;
  }, 400);
}
function mdi(text) {
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

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  const p = url.pathname;
  if (p === "/next" || p === "/next/") { res.writeHead(200, { "Content-Type": "text/html" }); return res.end(fs.readFileSync(path_.join(NEXT, "index.html"))); }
  if (p.startsWith("/next/")) {
    const f = path_.join(NEXT, p.slice(6));
    if (f.startsWith(NEXT) && fs.existsSync(f)) { res.writeHead(200, { "Content-Type": MIME[path_.extname(f)] || "application/octet-stream" }); return res.end(fs.readFileSync(f)); }
    res.writeHead(404); return res.end();
  }
  if (p === "/config-template.json" || /^\/onefinity.*\.json$/.test(p)) { res.writeHead(200, { "Content-Type": "application/json" }); return res.end(fs.readFileSync(path_.join(R, p.slice(1)))); }
  if (p === "/api/config/load") return json(res, config);
  if (p === "/api/config/save") { let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => { try { Object.assign(config, JSON.parse(b)); } catch {} json(res, "ok"); }); return; }
  if (p === "/api/hostname") return json(res, "onefinity");
  if (p === "/api/network") return json(res, { ipAddresses: ["192.168.1.42"], hostname: "onefinity", wifi: { enabled: true, ssid: "Shop-WiFi", networks: [{ Name: "Shop-WiFi", Quality: 78 }, { Name: "Neighbor", Quality: 34 }, { Name: "Guest", Quality: 55 }] } });
  if (p === "/api/time") return json(res, { timeinfo: "Local time: Fri 2026-10-09 10:15:00\nTime zone: America/New_York (EDT)", timezones: "America/New_York\nAmerica/Chicago\nUTC" });
  if (p === "/api/screen-rotation") return json(res, { rotated: false });
  if (p === "/api/video") { res.writeHead(404); return res.end(); }
  if (p === "/api/path/" + state.selected + "/positions" || /\/positions$/.test(p)) {
    res.writeHead(200, { "Content-Type": "application/octet-stream" }); return res.end(positions);
  }
  if (/\/speeds$/.test(p)) { res.writeHead(200, { "Content-Type": "application/octet-stream" }); return res.end(speeds); }
  if (p.startsWith("/api/path/")) {
    return json(res, { progress: 1, time: 600, bounds: { min: { x: 0, y: 0, z: -15 }, max: { x: 150, y: 90, z: 15 } } });
  }
  if (p.startsWith("/api/file/")) {
    if (req.method === "GET") { res.writeHead(200, { "Content-Type": "text/plain" }); return res.end("G21\nG90\nG0 Z15\nM3 S17000\nG1 X10 Y10 F300\nG1 Z-5\nG1 X140 F1500\nG1 Y80\nG1 X10\nG1 Y10\nM5\nM30\n"); }
    return json(res, "ok");
  }
  if (p === "/api/start") { run(); return json(res, "ok"); }
  if (p === "/api/pause") { broadcast({ xx: "HOLDING", pr: "User pause" }); return json(res, "ok"); }
  if (p === "/api/unpause") { broadcast({ xx: "RUNNING", pr: "" }); return json(res, "ok"); }
  if (p === "/api/stop") { clearInterval(timer); broadcast({ xx: "READY", cycle: "idle", feed: 0, speed: 0, pr: "" }); return json(res, "ok"); }
  if (p === "/api/estop") { clearInterval(timer); broadcast({ xx: "ESTOPPED", er: "User E-stop", feed: 0, speed: 0 }); return json(res, "ok"); }
  if (p === "/api/clear") { broadcast({ xx: "READY", er: "" }); return json(res, "ok"); }
  if (p.startsWith("/api/home")) { broadcast({ "0homed": true, "1homed": true, "2homed": true }); return json(res, "ok"); }
  if (p.startsWith("/api/position/")) {
    const a = p.split("/").pop();
    return json(res, "ok");
  }
  return json(res, "ok");
});

const wss = new WebSocketServer({ server, path: "/websocket" });
wss.on("connection", (ws) => {
  ws.send(JSON.stringify(state));
  ws.on("message", (d) => mdi(d.toString()));
});
setInterval(() => { for (const c of wss.clients) if (c.readyState === 1) c.send(JSON.stringify({ heartbeat: 1 })); }, 3000);

server.listen(PORT, () => console.log(`mock controller on :${PORT}`));
