import { useEffect, useRef, useState, useCallback } from "react";

async function call(method, url, body) {
  const opts = { method, cache: "no-cache", headers: {} };
  if (body !== undefined) {
    if (body instanceof Blob) opts.body = body;
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
      return { bounds: info.bounds, time: info.time, positions: new Float32Array(p), speeds: new Float32Array(s) };
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

// Live machine state over the controller's raw websocket.
export function useController() {
  const [state, setState] = useState({});
  const [config, setConfig] = useState(null);
  const [online, setOnline] = useState(false);
  const ws = useRef(null);

  useEffect(() => {
    let closed = false, timer;
    const connect = () => {
      const proto = location.protocol === "https:" ? "wss" : "ws";
      const s = new WebSocket(`${proto}://${location.host}/websocket`);
      ws.current = s;
      s.onopen = () => setOnline(true);
      s.onmessage = (e) => {
        let d; try { d = JSON.parse(e.data); } catch { return; }
        setOnline(true);
        delete d.heartbeat;
        if (!Object.keys(d).length) return;
        setState((prev) => {
          if (d.sid && prev.sid && d.sid !== prev.sid) location.reload();
          return { ...prev, ...d };
        });
      };
      s.onclose = () => { setOnline(false); if (!closed) timer = setTimeout(connect, 2000); };
    };
    connect();
    api.get("config/load").then(setConfig).catch(() => {});
    return () => { closed = true; clearTimeout(timer); ws.current && ws.current.close(); };
  }, []);

  const send = useCallback((gcode) => {
    if (ws.current && ws.current.readyState === 1) ws.current.send(gcode);
  }, []);
  return { state, config, online, send };
}

export const metricOf = (config) => !config || (config.settings?.units || "METRIC") === "METRIC";
