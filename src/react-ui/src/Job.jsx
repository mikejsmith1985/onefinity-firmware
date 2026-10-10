import React, { useState } from "react";
import { api } from "./controller.js";
import { fmtTime } from "./axis.js";
import { useNote } from "./notes.js";
import { markStopped } from "./history.js";
import ParkDialog from "./ParkDialog.jsx";
import Checklist, { buildChecks, skipChecklist } from "./Checklist.jsx";

function Override({ label, kind, hint }) {
  const [v, setV] = useState(100);
  const commit = (x) => api.put(`override/${kind}/${(x / 100).toFixed(2)}`).catch(() => {});
  return (
    <label className="ov" title={hint}>
      <span>{label}</span>
      <input type="range" min="0" max="200" step="5" value={v}
        onChange={(e) => setV(+e.target.value)} onPointerUp={(e) => commit(+e.target.value)} onKeyUp={(e) => commit(+e.target.value)} />
      <output>{v}%</output>
    </label>
  );
}

const Stat = ({ k, v, title }) => <div className="stat" title={title}><dt>{k}</dt><dd>{v}</dd></div>;

export default function Job({ state, mach, path, metric, config, changes = [] }) {
  const [check, setCheck] = useState(null);
  const [parkAsk, setParkAsk] = useState(false);
  // Dry run: the controller sends the same program 30 mm (or the chosen lift) higher with the router,
  // mist and probing blocked. It lasts for one run only, so it can never be left on.
  const [dry, setDry] = useState(false);
  const [lift, setLift] = useState(() => { try { return +localStorage.getItem("dryLift") || 30; } catch { return 30; } });
  const [err, setErr] = useState("");
  const note = useNote(state.selected).split("\n")[0];
  const start = () => {
    setErr("");
    if (dry) { try { localStorage.setItem("dryLift", String(lift)); } catch { /* storage unavailable */ } }
    return api.put("start", dry ? { dry_lift: +lift } : undefined)
      .then(() => setDry(false))
      .catch((e) => setErr(String(e.message || e).replace(/^\{"message":"|","code":\d+\}$/g, "")));
  };
  const tryStart = () => { if (dry || skipChecklist()) start(); else setCheck(buildChecks(state, config, metric, state.selected)); };
  const file = state.selected || "";
  const running = mach === "RUNNING" || mach === "HOMING";
  const holding = mach === "HOLDING" || mach === "STOPPING";
  const active = running || holding;
  const total = path?.time || 0;
  const done = state.plan_time || 0;
  const pct = total ? Math.min(100, Math.round((done / total) * 100)) : 0;
  const remaining = active ? Math.max(0, total - done) : total;
  const eta = total ? new Date(Date.now() + remaining * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "—";
  const nextChange = changes.find((c) => c.line > (state.line || 0));
  const canStart = !!file && mach === "READY";
  const feed = state.feed ? (metric ? `${Math.round(state.feed)} mm/min` : `${(state.feed / 25.4).toFixed(1)} IPM`) : "—";
  const vel = state.v !== undefined ? (metric ? `${(state.v).toFixed(2)} m/min` : `${(state.v / 0.0254).toFixed(1)} IPM`) : "—";
  return (
    <div className="job">
      <div className="job-file">
        <small>Program</small>
        <strong title={file}>{file || "No program selected"}</strong>
        {note && <em className="file-note" title={note}>{note}</em>}
      </div>
      <div className="bar" role="progressbar" aria-valuenow={active ? pct : 0} aria-valuemin="0" aria-valuemax="100"><i style={{ width: `${active ? (pct || 2) : 0}%` }} /></div>
      {state.dry_run && <div className="dry-banner" role="status">DRY RUN – moves are lifted {Math.round(state.dry_lift || 0)} mm. Router, mist and probing are blocked. Normal runs are unaffected.</div>}
      {!active && (
        <label className="dry-opt" title="Run the selected program in the air: Z lifted, router and mist blocked. Applies to the next run only.">
          <input type="checkbox" checked={dry} onChange={(e) => setDry(e.target.checked)} /> Dry run
          {dry && <span> lift <input type="number" min="5" max="100" step="5" value={lift} onChange={(e) => setLift(e.target.value)} /> mm</span>}
        </label>
      )}
      {err && <div className="dry-err" role="alert">{err}</div>}
      <div className="runrow">
        {!active && <button className={dry ? "go dry" : "go"} disabled={!canStart} onClick={tryStart}>{dry ? "Dry run" : "Run"}</button>}
        {running && <button className="hold" onClick={() => api.put("pause")}>Pause</button>}
        {holding && <button className="go" onClick={() => api.put("unpause")}>Resume</button>}
        <button className="halt" disabled={!active} onClick={() => { markStopped(); api.put("stop"); }}>Stop</button>
        {active && <button className="park" title="Stop here, lift Z and switch the machine off. Finish the job later with Resume." onClick={() => setParkAsk(true)}>Park…</button>}
      </div>
      <dl className="stats">
        <Stat k="Progress" v={`${active ? pct : 0}%`} />
        <Stat k={active ? "Remaining" : "Run time"} v={total ? fmtTime(remaining) : "—"} title="Time left, then total program time" />
        <Stat k="Finish at" v={eta} />
        <Stat k="Line" v={`${Math.max(0, state.line || 0).toLocaleString()}${path?.lines ? ` of ${path.lines.toLocaleString()}` : ""}`} />
        <Stat k="Feed" v={feed} title="Programmed feed rate" />
        <Stat k="Velocity" v={vel} title="Current velocity" />
        <Stat k="Spindle" v={`${Math.round(state.speed || 0)}${!isNaN(state.s) && state.s !== undefined ? ` (${Math.round(state.s)})` : ""} rpm`} title="Programmed and actual speed" />
        <Stat k="Tool" v={state.tool || 0} />
        {changes.length > 0 && <Stat k="Next change" v={nextChange ? `T${nextChange.tool} · L${nextChange.line} · ${changes.indexOf(nextChange) + 1}/${changes.length}` : `none left (${changes.length} total)`} title="Tool changes (M6) in this program" />}
        <Stat k="Loads" v={`1:${state["1oa"] ? "On" : "Off"}  2:${state["2oa"] ? "On" : "Off"}`} title="Load switch states" />
      </dl>
      <Override label="Feed" kind="feed" hint="Feed rate override" />
      <Override label="Speed" kind="speed" hint="Spindle speed override" />
      {(parkAsk || state.park) && <ParkDialog state={state} active={active} onClose={() => setParkAsk(false)} />}
      {check && <Checklist checks={check} onCancel={() => setCheck(null)} onRun={() => { setCheck(null); start(); }} />}
    </div>
  );
}
