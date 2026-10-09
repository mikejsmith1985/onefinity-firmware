import React from "react";
import { api } from "./controller.js";

const AXES = [["x", 0], ["y", 1], ["z", 2]];
const fmt = (mm, metric) => (metric ? mm.toFixed(3) : (mm / 25.4).toFixed(4));

function Row({ axis, motor, state, metric, locked }) {
  const abs = state[`${axis}p`] ?? 0;
  const off = state[`offset_${axis}`] ?? 0;
  const pos = Math.abs(abs - off) < 1e-5 ? 0 : abs - off;
  const lo = state[`${motor}tn`] ?? 0;
  const hi = state[`${motor}tm`] ?? 1;
  const homed = !!state[`${motor}homed`];
  const frac = Math.min(1, Math.max(0, (abs - lo) / (hi - lo || 1)));
  const neg = pos < 0;
  return (
    <div className="axis">
      <div className="axis-top">
        <span className="axis-name">{axis.toUpperCase()}</span>
        <span className={`axis-val${neg ? " neg" : ""}`}>{fmt(pos, metric)}</span>
      </div>
      <div className="travel" role="img" aria-label={`${axis.toUpperCase()} travel position`}>
        <div className="travel-track"><i style={{ left: `${frac * 100}%` }} /></div>
        <div className="travel-ends"><span>{fmt(lo, metric)}</span><span>{fmt(hi, metric)}</span></div>
      </div>
      <div className="axis-actions">
        <button disabled={locked} onClick={() => api.put(`position/${axis}`, { position: 0 })}>Zero {axis.toUpperCase()}</button>
        <button disabled={locked} onClick={() => api.put(`home/${axis}`)}>{homed ? "Re-home" : "Home"}</button>
        {!homed && <span className="flag">Not homed</span>}
      </div>
    </div>
  );
}

export default function Dro({ state, metric, locked }) {
  return (
    <div className="dro">
      {AXES.map(([a, m]) => <Row key={a} axis={a} motor={m} state={state} metric={metric} locked={locked} />)}
      <div className="dro-foot">
        <button disabled={locked} onClick={() => api.put("home")}>Home all</button>
        <button disabled={locked} onClick={() => ["x", "y", "z"].forEach((a) => api.put(`position/${a}`, { position: 0 }))}>Zero all</button>
      </div>
    </div>
  );
}
