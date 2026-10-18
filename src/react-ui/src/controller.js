import { useEffect, useRef, useState, useCallback } from "react";

async function call(method, url, body) {
  const opts = { method, cache: "no-cache", headers: {} };
  if (body !== undefined) {
    if (body instanceof Blob || body instanceof FormData) opts.body = body;
    else { opts.headers["Content-Type"] = "application/json; charset=utf-8"; opts.body = JSON.stringify(body); }
  }
  const r = await fetch(`/api/${url}`, opts);
  if (!r.ok) throw new Error(await r.text());
  const text = await r.text();
  try { return JSON.parse(text); } catch { return text; }
}
export const api = {
  get: (u) => call("GET", u),
  put: (u, b) => call("PUT", u, b),
  del: (u) => call("DELETE", u),
};

export const MACRO_PREFIX = "EgZjaHJvbWUqCggBEAAYsQMYgAQyBggAEEUYOTIKCAE";
export const DELETE_LIST_PREFIX = "DINCAIQABiDARixAxiABDIHCAMQABiABDIHCAQQABiABDIH";

export async function loadPath(file) {
  // The planner answers {progress} until the path is ready.
  for (;;) {
    const info = await api.get(`path/${encodeURIComponent(file)}`);
    if (info.progress === undefined || info.progress === 1) {
      const [p, s] = await Promise.all(
        ["positions", "speeds"].map((k) =>
          fetch(`/api/path/${encodeURIComponent(file)}/${k}`).then((r) => r.arrayBuffer())
        )
      );
      return { bounds: info.bounds, time: info.time, lines: info.lines, positions: new Float32Array(p), speeds: new Float32Array(s) };
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

import { recordDown, recordUp } from "./drops.js";
import { ME, readUi, uiSet, uiClose, useUiTick } from "./shared.js";

// Live machine state over the controller's raw websocket.
export function useController() {
  const [state, setState] = useState({});
  const [online, setOnline] = useState(false);
  const [logs, setLogs] = useState([]);
  const [lastError, setLastError] = useState(null);
  const ws = useRef(null);
  const listeners = useRef(new Set());
  const storeRev = useRef(null);

  useEffect(() => {
    let closed = false, timer, lastMsg = Date.now(), everUp = false;
    // The controller sends a heartbeat every 3 s. Silence for 8 s means the link is dead even if the
    // socket still looks open (a common Wi-Fi failure). Close it so it reconnects and the drop is logged.
    const watch = setInterval(() => {
      const s = ws.current;
      if (!s || s.readyState !== 1 || document.hidden) return;
      const quiet = Date.now() - lastMsg;
      if (quiet > 8000) { recordDown(`No data for ${Math.round(quiet / 1000)} s`); setOnline(false); s.close(); }
    }, 2000);
    const connect = () => {
      const proto = location.protocol === "https:" ? "wss" : "ws";
      const s = new WebSocket(`${proto}://${location.host}/websocket`);
      ws.current = s;
      s.onopen = () => { lastMsg = Date.now(); everUp = true; recordUp(); setOnline(true); };
      s.onmessage = (e) => {
        lastMsg = Date.now();
        let d; try { d = JSON.parse(e.data); } catch { return; }
        setOnline(true);
        delete d.heartbeat;
        if (!Object.keys(d).length) return;
        listeners.current.forEach((f) => f(d));
        // Another screen saved a shared document (notes, history, settings): re-read it here too.
        if (d.store_rev && typeof d.store_rev === "object") {
          const prev = storeRev.current; storeRev.current = d.store_rev;
          for (const [name, n] of Object.entries(d.store_rev)) {
            if (prev && prev[name] !== n) { try { window.dispatchEvent(new Event(`next-store:${name}`)); } catch { /* old browser */ } }
          }
        }
        if (d.log) {
          const m = { ...d.log, level: d.log.level || "info", id: Math.random() };
          setLogs((l) => {
            if (l.length && l[0].msg === m.msg && l[0].level === m.level) return [{ ...l[0], repeat: (l[0].repeat || 1) + 1 }, ...l.slice(1)];
            return [m, ...l].slice(0, 256);
          });
          if (m.level === "error" || m.level === "critical") setLastError({ ...m, at: Date.now() });
        }
        setState((prev) => {
          if (d.sid && prev.sid && d.sid !== prev.sid) location.reload();
          return { ...prev, ...d };
        });
      };
      s.onclose = () => { setOnline(false); if (!closed && everUp) recordDown("Connection closed"); if (!closed) timer = setTimeout(connect, 2000); };
    };
    connect();
    return () => { closed = true; clearTimeout(timer); clearInterval(watch); ws.current && ws.current.close(); };
  }, []);

  // true when the command went to the controller, false when it could not be sent (1.29.0: before, a
  // command typed or sent while the connection was down was dropped without a word).
  const send = useCallback((gcode) => {
    if (!ws.current || ws.current.readyState !== 1) return false;
    try { ws.current.send(gcode); return true; } catch { return false; }
  }, []);
  const subscribe = useCallback((fn) => { listeners.current.add(fn); return () => listeners.current.delete(fn); }, []);
  return { state, online, send, subscribe, logs, clearLogs: () => setLogs([]), lastError, clearError: () => setLastError(null) };
}

const clone = (o) => JSON.parse(JSON.stringify(o));

function fixVersion(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:[-.]?(.*))?$/.exec((v || "").trim());
  if (!m) return v || "";
  let out = `${m[1]}.${m[2]}.${m[3]}`;
  if (m[4]) {
    const b = /([a-zA-Z])(\d+)/.exec(m[4]);
    out += b && b[1] === "b" ? `-beta.${b[2]}` : `-${m[4]}`;
  }
  return out;
}

// Configuration: the saved copy from the controller plus the operator's unsaved edits.
// Unsaved edits are part of the shared session ("cfg-draft"): a setting changed on the PC shows as unsaved on
// the touchscreen too, and Save or Discard on any screen finishes it everywhere.
export function useConfig(state) {
  useUiTick();
  const [draft, setDraft] = useState(null);
  const [template, setTemplate] = useState(null);
  const [net, setNet] = useState({});
  const [modified, setModified] = useState(false);
  const modRef = useRef(false);
  modRef.current = modified;

  const reload = useCallback(async (force) => {
    const c = await api.get("config/load");
    c.full_version = fixVersion(c.full_version);
    if (force || !modRef.current) { setDraft(c); setModified(false); }
    api.get("wifi").then((w) => setNet({ ip: w.ipAddresses, wifi: w.wifi })).catch(() => {});
    return c;
  }, []);

  useEffect(() => {
    reload(true).then(() => {
      // Another screen has unsaved edits: show them here as well.
      const sh = sharedRef.current;
      if (sh && sh.by !== ME && sh.draft) { setDraft(sh.draft); setModified(true); }
    }).catch(() => {});
    fetch("/config-template.json", { cache: "no-cache" }).then((r) => r.json()).then(setTemplate).catch(() => {});
  }, [reload]);

  const shareTimer = useRef(null);
  const shareDraft = useCallback((c) => {
    clearTimeout(shareTimer.current);
    shareTimer.current = setTimeout(() => uiSet("cfg-draft", { by: ME, draft: c, at: Date.now() }).catch(() => {}), 300);
  }, []);
  const edit = useCallback((fn) => {
    setDraft((d) => { if (!d) return d; const c = clone(d); fn(c); shareDraft(c); return c; });
    setModified(true);
  }, [shareDraft]);

  // Follow edits made on another screen, and its Save or Discard.
  const shared = readUi(state, "cfg-draft").v;
  const sharedRef = useRef(null);
  useEffect(() => {
    const prev = sharedRef.current; sharedRef.current = shared;
    if (shared && shared.by !== ME && shared.draft) {
      setDraft((d) => (JSON.stringify(d) === JSON.stringify(shared.draft) ? d : shared.draft));
      setModified(true);
    } else if (!shared && prev && modRef.current) {
      clearTimeout(shareTimer.current);
      reload(true).catch(() => {});
    }
  }, [shared && shared.at, !!shared]); // eslint-disable-line react-hooks/exhaustive-deps
  // Saved on another screen: take the new saved copy unless there are edits here.
  useEffect(() => {
    const f = () => { if (!modRef.current) reload(true).catch(() => {}); };
    window.addEventListener("next-store:config", f);
    return () => window.removeEventListener("next-store:config", f);
  }, [reload]);

  const patch = useCallback((fn) => {
    setDraft((d) => { if (!d) return d; const c = clone(d); fn(c); return JSON.stringify(c) === JSON.stringify(d) ? d : c; });
  }, []);

  const save = useCallback(async (extra) => {
    const c = clone(draft);
    for (const k of ["macros", "macros_list", "non_macros_list", "gcode_list"]) if (state[k]) c[k] = clone(state[k]);
    if (extra) extra(c);
    const sel = c.tool && c.tool["selected-tool"];
    if (sel) {
      const saveModbus = sel !== "pwm" && sel !== "laser" && sel !== "router";
      const tool = { ...c.tool }; delete tool["tool-type"];
      c["selected-tool-settings"] = c["selected-tool-settings"] || {};
      c["selected-tool-settings"][sel] = { tool, "pwm-spindle": { ...c["pwm-spindle"] }, "modbus-spindle": saveModbus ? { ...c["modbus-spindle"] } : undefined };
    }
    await api.put("config/save", c);
    clearTimeout(shareTimer.current);
    setModified(false);
    uiClose("cfg-draft");
    await reload(true);
  }, [draft, state, reload]);

  // Change only the program lists (folders, files) in the saved settings. Unsaved edits to other settings,
  // on this screen or another, are not saved by it and stay unsaved.
  const saveLists = useCallback(async (fn) => {
    const c = await api.get("config/load");
    fn(c);
    await api.put("config/save", c);
    const fresh = await api.get("config/load");
    fresh.full_version = fixVersion(fresh.full_version);
    setDraft((d) => (!d || !modRef.current ? fresh : { ...d, gcode_list: fresh.gcode_list, non_macros_list: fresh.non_macros_list, macros_list: fresh.macros_list }));
  }, []);
  const discard = useCallback(() => { clearTimeout(shareTimer.current); uiClose("cfg-draft"); return reload(true); }, [reload]);
  return { config: draft, template, net, modified, edit, patch, save, saveLists, reload, discard };
}

export const metricOf = (config) => !config || (config.settings?.units || "METRIC") === "METRIC";
