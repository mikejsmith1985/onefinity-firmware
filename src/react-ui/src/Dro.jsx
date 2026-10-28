import React, { useState } from "react";
import { api } from "./controller.js";
import { computeAxis, fmtLen } from "./axis.js";
import { Modal, Confirm, parseNum } from "./ui.jsx";
import { isEnter } from "./vkbd.js";

const STATUS_TEXT = { HOMED: "Homed", UNHOMED: "Not homed", FAULT: "Motor fault", SHUTDOWN: "Power shutdown" };
const FIT_TEXT = { OVER: "Over limit", UNDER: "Under limit", "NO FIT": "Won't fit" };

function PositionDialog({ axis, metric, onClose, title, label, action, initial = "0" }) {
  const [v, setV] = useState(initial);
  const ok = parseNum(v) !== null;
  const go = (raw = v) => { const n = parseNum(raw); if (n === null) return; action(metric ? n : n * 25.4); onClose(); };
  return (
    <Modal title={title} onClose={onClose} actions={<>
      <button onClick={onClose}>Cancel</button>
      <button className="primary" disabled={!ok} onClick={() => go()}>Set</button>
    </>}>
      <label className="stack">{label}
        <input data-autofocus type="text" inputMode="decimal" autoComplete="off" spellCheck="false" value={v} onChange={(e) => setV(e.target.value)} onKeyUp={(e) => { if (isEnter(e)) go(e.currentTarget.value); }} />
        <small>{metric ? "mm" : "in"}</small>
      </label>
    </Modal>
  );
}

// 1.39.0: tapping a position moves the machine there. Setting the position
// (changing the work zero) is still there, as the smaller choice.
function MoveDialog({ a, metric, zTop, send, onSet, onClose }) {
  const A = a.axis.toUpperCase();
  const [v, setV] = useState(String(Number(fmtLen(a.pos, metric))));
  const [machine, setMachine] = useState(false);
  const [lift, setLift] = useState(a.axis !== "z");
  const n = parseNum(v);
  const k = metric ? 1 : 1 / 25.4;
  const lim = (mm) => (metric ? mm : mm / 25.4);
  // Where it would end up, in machine coordinates (mm), to check the travel
  const target = n === null ? null : (machine ? n / k : n / k + a.off);
  const inside = target !== null && !(isFinite(a.min) && target < a.min - 1e-6) && !(isFinite(a.max) && target > a.max + 1e-6);
  const fmt = (x) => Number(x.toFixed(metric ? 3 : 4));
  const go = (raw = v) => {
    const m = parseNum(raw); if (m === null) return;
    const t = machine ? m / k : m / k + a.off;
    if ((isFinite(a.min) && t < a.min - 1e-6) || (isFinite(a.max) && t > a.max + 1e-6)) return;
    const lines = ["G90"];
    if (lift && a.axis !== "z" && Number.isFinite(zTop)) lines.push(`G53 G0 Z${fmt(lim(zTop))}`);
    lines.push(`${machine ? "G53 " : ""}G0 ${A}${fmt(m)}`);
    send(lines.join("\n"));
    onClose();
  };
  return (
    <Modal title={`Move ${A}`} onClose={onClose} actions={<>
      <button className="quiet" disabled={n === null} onClick={() => { onSet(n / k); onClose(); }}
        title={`Keep the machine where it is and make ${A} read this value (changes the work zero)`}>Set {A} to this instead</button>
      <button onClick={onClose}>Cancel</button>
      <button className="primary" disabled={!inside} onClick={() => go()}>Move</button>
    </>}>
      <label className="stack">Move {A} to
        <input data-autofocus type="text" inputMode="decimal" autoComplete="off" spellCheck="false" value={v}
          onChange={(e) => setV(e.target.value)} onKeyUp={(e) => { if (isEnter(e)) go(e.currentTarget.value); }} />
        <small>{metric ? "mm" : "in"}, {machine ? "machine position (from home)" : "work position (what the screen shows)"}</small>
      </label>
      <label className="check"><input type="checkbox" checked={machine} onChange={(e) => setMachine(e.target.checked)} /> Machine position (measured from home) instead of the work position</label>
      {a.axis !== "z" && <label className="check"><input type="checkbox" checked={lift} onChange={(e) => setLift(e.target.checked)} /> Lift Z to the top first</label>}
      {target !== null && !inside && <p className="warn">That's outside {A}'s travel ({fmtLen(a.min - (machine ? 0 : a.off), metric)} to {fmtLen(a.max - (machine ? 0 : a.off), metric)}{machine ? " machine" : ""}).</p>}
      {target !== null && inside && <p className="dim">Moves at rapid speed{lift && a.axis !== "z" ? ", after lifting Z" : ", in a straight line"}. {machine ? `Work ${A} there will read ${fmtLen(target - a.off, metric)}.` : `Machine ${A} ${fmtLen(target, metric)}.`}</p>}
    </Modal>
  );
}

function Row({ a, metric, idle, setDlg }) {
  const A = a.axis.toUpperCase();
  const neg = a.pos < 0;
  const frac = isFinite(a.max - a.min) && a.max !== a.min ? Math.min(1, Math.max(0, (a.abs - a.min) / (a.max - a.min))) : 0;
  const bad = a.status === "FAULT" || a.status === "SHUTDOWN";
  return (
    <div className="axis">
      <div className="axis-top">
        <span className="axis-name">{A}</span>
        <button className={`axis-val${neg ? " neg" : ""}`} disabled={!idle} onClick={() => setDlg({ kind: "pos", a })}
          title={`Move ${A} to a position`} aria-label={`${A} position ${fmtLen(a.pos, metric)}. Click to move to a position.`}>{fmtLen(a.pos, metric)}</button>
      </div>
      <div className="travel" role="img" aria-label={`${A} travel`}>
        <div className="travel-track"><i style={{ left: `${frac * 100}%` }} /></div>
        {isFinite(a.min) && isFinite(a.max) && <div className="travel-ends"><span>{fmtLen(a.min, metric)}</span><span>{fmtLen(a.max, metric)}</span></div>}
      </div>
      <div className="axis-actions">
        <button disabled={!idle} onClick={() => api.put(`position/${a.axis}`, { position: 0 })}>Zero {A}</button>
        <button disabled={!idle} onClick={() => (a.homingMode === "manual" ? setDlg({ kind: "home", a }) : api.put(`home/${a.axis}`))}>{a.homed ? "Re-home" : "Home"}</button>
        {a.homed && <button className="quiet" disabled={!idle} onClick={() => api.put(`home/${a.axis}/clear`)} title="Forget that this axis is homed">Unhome</button>}
        <span className={`flag ${bad ? "bad" : a.homed ? "ok" : "warn"}`}>{STATUS_TEXT[a.status]}</span>
        {FIT_TEXT[a.fit] && <span className={`flag ${a.fit === "NO FIT" ? "bad" : "warn"}`} title={a.fitMsg}>{FIT_TEXT[a.fit]}</span>}
      </div>
    </div>
  );
}

export default function Dro({ state, config, metric, idle, send }) {
  const [dlg, setDlg] = useState(null);
  const all = ["x", "y", "z", "a"].map((x) => computeAxis(state, config, x, metric));
  let rows = all.filter((a) => a.enabled);
  if (!rows.length) rows = all.slice(0, 3);
  const anyUnhomed = rows.some((a) => !a.homed);
  return (
    <div className="dro">
      {rows.map((a) => <Row key={a.axis} a={a} metric={metric} idle={idle} setDlg={setDlg} />)}
      <div className="dro-foot">
        <button disabled={!idle} className={anyUnhomed ? "primary" : ""} onClick={() => api.put("home")}>Home all</button>
        <button disabled={!idle} onClick={() => rows.forEach((a) => api.put(`position/${a.axis}`, { position: 0 }))}>Zero all</button>
      </div>
      {dlg?.kind === "pos" && (
        <MoveDialog a={dlg.a} metric={metric} send={send} onClose={() => setDlg(null)}
          zTop={(() => { const z = all.find((r) => r.axis === "z"); return z && isFinite(z.max) ? z.max - 1 : NaN; })()}
          onSet={(mm) => api.put(`position/${dlg.a.axis}`, { position: mm })} />
      )}
      {dlg?.kind === "home" && (
        <PositionDialog title={`Set ${dlg.a.axis.toUpperCase()} home`} metric={metric}
          label={`Jog ${dlg.a.axis.toUpperCase()} to its home position, then enter the value it should read there`}
          initial="0" onClose={() => setDlg(null)} action={(mm) => api.put(`home/${dlg.a.axis}/set`, { position: mm })} />
      )}
    </div>
  );
}
