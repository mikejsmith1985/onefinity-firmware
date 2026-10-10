import React, { useEffect, useState } from "react";
import { loadPath } from "./controller.js";
import Dro from "./Dro.jsx";
import Jog from "./Jog.jsx";
import Job from "./Job.jsx";
import Workspace from "./Workspace.jsx";
import ProbeDialog from "./ProbeDialog.jsx";

export default function ControlPage({ ctl, cfg, mach, metric }) {
  const { state, send, subscribe, logs, clearLogs } = ctl;
  const [path, setPath] = useState(null);
  const [pathBusy, setPathBusy] = useState(false);
  const [probe, setProbe] = useState(null);

  useEffect(() => {
    const f = state.selected;
    setPath(null);
    if (!f) return;
    let dead = false;
    setPathBusy(true);
    loadPath(f).then((p) => !dead && setPath(p)).catch(() => {}).finally(() => !dead && setPathBusy(false));
    return () => { dead = true; };
  }, [state.selected, state.selected_time]);

  const busy = mach === "RUNNING" || mach === "HOLDING" || mach === "STOPPING" || mach === "HOMING";
  const estopped = mach === "ESTOPPED";
  const idle = state.cycle === "idle";
  const ready = mach === "READY";
  const rotary = state["2an"] === 3;

  return (
    <main className="grid">
      <section className="band dro-band"><Dro state={state} config={cfg.config} metric={metric} idle={idle && !estopped} /></section>
      <section className="band jog-band">
        <Jog state={state} config={cfg.config} send={send} metric={metric} locked={busy || estopped} idle={idle && !estopped} ready={ready} onProbe={setProbe} />
      </section>
      <section className="band job-band"><Job state={state} mach={mach} path={path} metric={metric} config={cfg.config} /></section>
      <section className="band work-band">
        <Workspace state={state} path={path} pathBusy={pathBusy} send={send} mach={mach} cfg={cfg} idle={idle && !estopped} logs={logs} clearLogs={clearLogs} />
      </section>
      {probe && cfg.config && (
        <ProbeDialog type={probe} config={cfg.config} state={state} send={send} subscribe={subscribe} rotary={rotary} metric={metric} onClose={() => setProbe(null)} />
      )}
    </main>
  );
}
