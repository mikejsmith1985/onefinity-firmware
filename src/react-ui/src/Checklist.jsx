import React, { useState } from "react";
import { Modal } from "./ui.jsx";
import { computeAxis, fmtLen } from "./axis.js";
import { status_to_string } from "./modbus.js";
import { stockChecks, probeChecks } from "./setup.js";

const KEY = "next-skip-checklist";
export const skipChecklist = () => { try { return localStorage.getItem(KEY) === "1"; } catch { return false; } };

// Builds the list of checks. level: ok | warn | stop
export function buildChecks(state, config, metric, file, setup = null, probeRec = null) {
  const out = [];
  out.push({ level: file ? "ok" : "stop", name: "Program", text: file || "No program is selected." });

  const axes = [..."xyz" + (state["2an"] === 3 ? "a" : "")];
  const cs = axes.map((a) => computeAxis(state, config, a, metric)).filter((c) => c.enabled);

  const unhomed = cs.filter((c) => !c.homed).map((c) => c.axis.toUpperCase());
  out.push(unhomed.length
    ? { level: "warn", name: "Homing", text: `${unhomed.join(", ")} not homed. Positions and limits may be wrong.` }
    : { level: "ok", name: "Homing", text: "All axes are homed." });

  const bad = cs.filter((c) => ["NO FIT", "OVER", "UNDER"].includes(c.fit));
  if (bad.length) bad.forEach((c) => out.push({ level: "stop", name: `Fit ${c.axis.toUpperCase()}`, text: c.fitMsg }));
  else if (cs.some((c) => c.fit === "OK")) out.push({ level: "ok", name: "Fit", text: "The program fits within travel on every axis." });

  // Setup sheet in the program: check the moves against the plate it describes
  out.push(...probeChecks(setup, probeRec, state));
  out.push(...stockChecks(setup, metric));

  const zero = cs.map((c) => `${c.axis.toUpperCase()} ${fmtLen(c.off, metric)}`).join("   ");
  out.push({ level: "ok", name: "Work zero", text: `Machine position of zero: ${zero}. Confirm this is where you set it.` });

  const sel = config?.tool?.["selected-tool"];
  const modbus = sel && !["disabled", "laser", "router", "pwm"].includes(sel);
  if (modbus) {
    const st = status_to_string(state.mx);
    out.push({ level: st === "Ok" ? "ok" : "warn", name: "Spindle drive", text: st === "Ok" ? "VFD is connected." : `VFD status: ${st}.` });
  } else if (sel === "disabled") out.push({ level: "warn", name: "Spindle", text: "No spindle is configured. S and M3 commands will not turn anything on." });

  if (state.power_shutdown) out.push({ level: "stop", name: "Power", text: "The controller is in power shutdown." });
  return out;
}

const ICON = { ok: "✓", warn: "!", stop: "✕" };

// The setup sheet written into the program when it was exported
export function SheetView({ setup }) {
  if (!setup?.fields?.length) return null;
  return (
    <section className="sheet" aria-label="Setup sheet">
      <h3>Setup sheet</h3>
      <dl>
        {setup.fields.map((f) => <div key={f.key}><dt>{f.label}</dt><dd>{f.text}</dd></div>)}
      </dl>
    </section>
  );
}

export default function Checklist({ checks, setup, onRun, onCancel }) {
  const [never, setNever] = useState(false);
  const stops = checks.some((c) => c.level === "stop");
  const warns = checks.some((c) => c.level === "warn");
  const go = () => { if (never) { try { localStorage.setItem(KEY, "1"); } catch {} } onRun(); };
  return (
    <Modal title="Ready to run?" onClose={onCancel} actions={<>
      <button data-autofocus onClick={onCancel}>Cancel</button>
      <button className={stops || warns ? "danger" : "primary"} onClick={go}>{stops || warns ? "Run anyway" : "Run"}</button>
    </>}>
      <SheetView setup={setup} />
      <ul className="checks">
        {checks.map((c, i) => (
          <li key={i} className={c.level}><span className="mark" aria-label={c.level}>{ICON[c.level]}</span><b>{c.name}</b><span>{c.text}</span></li>
        ))}
      </ul>
      {stops && <p className="err">Fix the red items first, or run anyway if you know the move is safe.</p>}
      <label className="check"><input type="checkbox" checked={never} onChange={(e) => setNever(e.target.checked)} /> Don't show this check again on this device</label>
    </Modal>
  );
}
