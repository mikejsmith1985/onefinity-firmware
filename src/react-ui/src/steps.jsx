// The common frame of the probing screens (1.31.1): Probe XYZ/Z, Measure stock, Tool setter and the
// Start job wizard's probing steps all show their steps, illustrations, running moves and results
// the same way.
import React, { useRef } from "react";
import { moveStatus } from "./progress.js";

// The step list on the left: done steps ticked, the current one marked.
export function StepRail({ steps, labels, current, label = "Steps" }) {
  const i = steps.indexOf(current);
  return (
    <ol className="probe-steps" aria-label={label}>
      <li className="count">Step {Math.max(i + 1, 1)} of {steps.length || 1}</li>
      {steps.map((s, k) => <li key={s} className={k === i ? "active" : k < i ? "done" : ""} aria-current={k === i ? "step" : undefined}>
        <span className="tick" aria-hidden="true">{k < i ? "✓" : k + 1}</span>{labels[s] || s}</li>)}
    </ol>
  );
}

// One step: a title, the text and controls, and the illustration beside them.
export function StepBody({ title, art, children }) {
  return (
    <div className="step-body">
      <div className="step-text">{title && <h3 className="step-title">{title}</h3>}{children}</div>
      {art && <div className="step-art">{art}</div>}
    </div>
  );
}

// The running move. The controller reports of_step (see progress.js); a value counts for this run
// once it has changed (or read 0) while this run was on, so the last move of the previous run never
// shows as this one's.
export function useRunStep(ofStep, runKey) {
  const R = useRef({ key: null, first: undefined, ok: false });
  const r = R.current;
  if (r.key !== runKey) { r.key = runKey; r.first = ofStep; r.ok = Number(ofStep) === 0; }
  else if (!r.ok && (ofStep !== r.first || Number(ofStep) === 0)) r.ok = true;
  return runKey && r.ok ? Number(ofStep) || 0 : null;
}

// What is running now: "Move 3 of 8", a bar, and the list of moves.
export function RunProgress({ title = "Probing", moves = [], step, started, note }) {
  const st = moveStatus(moves, step ?? -1);
  const cur = st.cur, of = moves.length;
  const pct = cur >= 0 && of ? Math.round(((cur + 0.5) / of) * 100) : 0;
  return (
    <div className="run" role="status" aria-live="polite">
      <div className="run-head">
        <b>{title}</b>
        <span className="run-count">{cur >= 0 ? `Move ${cur + 1} of ${of}` : started ? "Starting…" : "Sending the program…"}</span>
      </div>
      {cur >= 0 ? <div className="bar" role="progressbar" aria-valuemin={0} aria-valuemax={of} aria-valuenow={cur + 1}><i style={{ width: `${pct}%` }} /></div> : <div className="indet" />}
      {cur >= 0 && <p className="run-now">{st.label}</p>}
      {of > 0 && <ol className="moves">{moves.map((m, i) => <li key={m.n} className={cur < 0 ? "" : i < cur ? "done" : i === cur ? "on" : ""}>
        <span className="tick" aria-hidden="true">{cur >= 0 && i < cur ? "✓" : i + 1}</span>{m.label}</li>)}</ol>}
      <p className="dim run-note">{note || "Keep a hand near the E-stop. Stop halts the machine at once."}</p>
    </div>
  );
}

// The end of a run: done, or stopped and why.
export function Outcome({ ok, title, children }) {
  return (
    <div className={`outcome ${ok ? "ok" : "bad"}`} role={ok ? "status" : "alert"}>
      <span className="mark" aria-hidden="true">{ok ? "✓" : "!"}</span>
      <div><h3>{title}</h3>{children}</div>
    </div>
  );
}
