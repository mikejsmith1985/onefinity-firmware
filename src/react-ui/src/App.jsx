import React, { useEffect, useState } from "react";
import { useController, metricOf, api, loadPath } from "./controller.js";
import Dro from "./Dro.jsx";
import Jog from "./Jog.jsx";
import Job from "./Job.jsx";
import Workspace from "./Workspace.jsx";

export function machState(state) {
  const { cycle, xx } = state;
  if (xx !== "ESTOPPED" && (cycle === "jogging" || cycle === "homing")) return cycle.toUpperCase();
  return xx || "";
}

function statusText(state, mach) {
  if (mach === "ESTOPPED") return state.er || "Emergency stop";
  if (mach === "HOLDING") return state.pr || "Paused";
  const m = state.messages;
  return m && m.length ? m[m.length - 1].text : "";
}

const TONE = { READY: "ready", RUNNING: "run", HOMING: "run", JOGGING: "run", STOPPING: "warn", HOLDING: "warn", ESTOPPED: "stop" };

export default function App() {
  const { state, config, online, send } = useController();
  const [metricPref, setMetricPref] = useState(null);
  const metric = metricPref ?? metricOf(config);
  const mach = machState(state);
  const [path, setPath] = useState(null);
  const [pathBusy, setPathBusy] = useState(false);
  useEffect(() => {
    const f = state.selected;
    setPath(null);
    if (!f) return;
    let dead = false;
    setPathBusy(true);
    loadPath(f).then((p) => !dead && setPath(p)).catch(() => {}).finally(() => !dead && setPathBusy(false));
    return () => { dead = true; };
  }, [state.selected, state.selected_time]);
  const tone = TONE[mach] || "idle";
  const estopped = mach === "ESTOPPED";
  const busy = mach === "RUNNING" || mach === "HOLDING" || mach === "STOPPING" || mach === "HOMING";

  return (
    <div className="shell">
      <header className="strip">
        <div className={`chip ${tone}`}><span className="dot" />{mach ? mach[0] + mach.slice(1).toLowerCase() : "Connecting"}</div>
        <div className="msg" title={statusText(state, mach)}>{statusText(state, mach)}</div>
        <button className="unit" onClick={() => setMetricPref(!metric)} aria-label="Switch units">{metric ? "mm" : "in"}</button>
        <div className={`link ${online ? "up" : "down"}`}>{online ? "Connected" : "Offline"}</div>
        {estopped
          ? <button className="estop reset" onClick={() => api.put("clear")}>Clear E-stop</button>
          : <button className="estop" onClick={() => api.put("estop")}>E-stop</button>}
      </header>

      <main className="grid">
        <section className="band dro-band"><Dro state={state} metric={metric} locked={busy} /></section>
        <section className="band jog-band"><Jog state={state} config={config} send={send} metric={metric} locked={busy || estopped} /></section>
        <section className="band job-band"><Job state={state} mach={mach} path={path} /></section>
        <section className="band work-band"><Workspace state={state} path={path} pathBusy={pathBusy} /></section>
      </main>
    </div>
  );
}
