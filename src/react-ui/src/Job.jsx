import React, { useState } from "react";
import { api } from "./controller.js";

function Override({ label, kind }) {
  const [v, setV] = useState(100);
  const commit = (x) => api.put(`override/${kind}/${(x / 100).toFixed(2)}`).catch(() => {});
  return (
    <label className="ov">
      <span>{label}</span>
      <input type="range" min="10" max="200" step="5" value={v}
        onChange={(e) => setV(+e.target.value)} onPointerUp={(e) => commit(+e.target.value)} onKeyUp={(e) => commit(+e.target.value)} />
      <output>{v}%</output>
    </label>
  );
}

export default function Job({ state, mach, path }) {
  const file = state.selected || "";
  const running = mach === "RUNNING" || mach === "HOMING";
  const holding = mach === "HOLDING" || mach === "STOPPING";
  const active = running || holding;
  const total = path?.time || 0;
  const pct = total ? Math.min(100, Math.round(((state.plan_time || 0) / total) * 100)) : 0;
  const canStart = !!file && mach === "READY";
  return (
    <div className="job">
      <div className="job-file">
        <small>Program</small>
        <strong title={file}>{file || "No program selected"}</strong>
      </div>
      <div className="bar" aria-label="Progress"><i style={{ width: `${active ? (pct || 3) : 0}%` }} /></div>
      <div className="job-meta">
        <span>Line {state.line || 0}</span>
        <span>{state.feed ? `${Math.round(state.feed)} mm/min` : "—"}</span>
        <span>{state.speed ? `${Math.round(state.speed)} rpm` : "—"}</span>
        <span>Tool {state.tool ?? "—"}</span>
      </div>
      <div className="runrow">
        {!active && <button className="go" disabled={!canStart} onClick={() => api.put("start")}>Run</button>}
        {running && <button className="hold" onClick={() => api.put("pause")}>Pause</button>}
        {holding && <button className="go" onClick={() => api.put("unpause")}>Resume</button>}
        <button className="halt" disabled={!active} onClick={() => api.put("stop")}>Stop</button>
      </div>
      <Override label="Feed" kind="feed" />
      <Override label="Spindle" kind="speed" />
    </div>
  );
}
