import React, { useState } from "react";
import { api } from "./controller.js";

const STEPS = {
  metric: [["Fine", 0.1], ["Small", 1], ["Medium", 10], ["Large", 100]],
  imperial: [["Fine", 0.005], ["Small", 0.05], ["Medium", 0.5], ["Large", 5]],
};

export default function Jog({ state, config, send, metric, locked }) {
  const [idx, setIdx] = useState(1);
  const [armed, setArmed] = useState(null);
  const steps = STEPS[metric ? "metric" : "imperial"];
  const amt = steps[idx][1];
  const unit = metric ? "mm" : "in";

  const step = (axis, dir) => send(`M70\nG91\n${metric ? "G21" : "G20"}\nG0 ${axis}${dir * amt}\nM72`);
  const goZero = () => send(`G90\nG0 X0 Y0`);

  const macros = (config?.macros || []).filter((m) => m && m.file_name && m.file_name !== "default");
  const runMacro = async (m, i) => {
    if (armed !== i) { setArmed(i); setTimeout(() => setArmed((a) => (a === i ? null : a)), 3000); return; }
    setArmed(null);
    try { await api.get(`file/${encodeURIComponent(m.file_name)}`); await api.put("start"); } catch (e) { console.error(e); }
  };

  return (
    <div className="jog">
      <div className="steps" role="radiogroup" aria-label="Step size">
        {steps.map(([name, v], i) => (
          <button key={name} role="radio" aria-checked={i === idx} className={i === idx ? "on" : ""} onClick={() => setIdx(i)}>
            <b>{v}</b><small>{name}</small>
          </button>
        ))}
      </div>

      <div className="pads">
        <div className="xy">
          <button className="k up" disabled={locked} onClick={() => step("Y", 1)} aria-label="Y plus">Y+</button>
          <button className="k left" disabled={locked} onClick={() => step("X", -1)} aria-label="X minus">X−</button>
          <button className="k mid" disabled={locked} onClick={goZero} title="Move to X0 Y0">X0 Y0</button>
          <button className="k right" disabled={locked} onClick={() => step("X", 1)} aria-label="X plus">X+</button>
          <button className="k down" disabled={locked} onClick={() => step("Y", -1)} aria-label="Y minus">Y−</button>
        </div>
        <div className="z">
          <button className="k" disabled={locked} onClick={() => step("Z", 1)} aria-label="Z up">Z+</button>
          <div className="zl">{amt} {unit}</div>
          <button className="k" disabled={locked} onClick={() => step("Z", -1)} aria-label="Z down">Z−</button>
        </div>
      </div>

      {macros.length > 0 && (
        <div className="macros">
          {macros.map((m, i) => (
            <button key={i} disabled={locked} className={armed === i ? "armed" : ""} style={{ "--m": m.color || "var(--blue)" }} onClick={() => runMacro(m, i)}>
              {armed === i ? "Tap again to run" : m.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
