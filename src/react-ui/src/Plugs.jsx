import React, { useEffect, useState } from "react";
import { api } from "./controller.js";
import { getPrefs, setPrefs } from "./checkpoint.js";

// Router and shop vac power plugs (1.35.0). The controller (Plugs.py) does the switching:
// the router follows M3/M5, the vac runs while a program runs, and both go off at the end of
// the program, on Stop, on E-stop and while a job is paused. Every "on" carries the plug's own
// auto-off timer, re-armed every 3 s, so a plug the controller stops talking to switches itself off.

const NAMES = [["router", "Router"], ["vac", "Vac"]];
const DEFAULTS = { router: { ip: "", auto: false }, vac: { ip: "", auto: false }, spinup: 4, vacAfter: 5 };
const clean = (msg) => String(msg || "").replace(/^\{"message":"|","code":\d+\}$/g, "");

function label(s, w) {
  if (s === "on") return `On${w ? ` · ${w} W` : ""}`;
  if (s === "off") return "Off";
  if (s === "offline") return "Not answering";
  return "Not set up";
}

// The strip on the control page: status of each plug and a switch for it.
export function PlugStrip({ state }) {
  const [err, setErr] = useState("");
  const shown = NAMES.filter(([n]) => state[`plug_${n}`] && state[`plug_${n}`] !== "unset");
  if (!shown.length) return null;
  const flip = (n, on) => { setErr(""); api.put("plugs", { plug: n, on }).catch((e) => setErr(clean(e.message || e))); };
  return (
    <div className="plugs" role="group" aria-label="Power plugs">
      {shown.map(([n, name]) => {
        const s = state[`plug_${n}`], auto = !!state[`plug_${n}_auto`];
        return (
          <div key={n} className={`plug ${s}`}>
            <span className="plug-name">{name}</span>
            <span className="plug-state" aria-live="polite">{label(s, state[`plug_${n}_w`])}{!auto ? " · manual" : ""}</span>
            {auto && (s === "on"
              ? <button onClick={() => flip(n, false)}>Off</button>
              : <button disabled={s === "offline" || state.xx === "ESTOPPED"} onClick={() => flip(n, true)}>On</button>)}
          </div>
        );
      })}
      {err && <p className="plug-err" role="alert">{err}</p>}
    </div>
  );
}

// Settings: plug addresses, Auto, spin-up wait and vac run-on.
export function PlugPrefs({ state }) {
  const [p, setP] = useState(null);
  useEffect(() => { getPrefs().then((all) => setP({ ...DEFAULTS, ...(all?.plugs || {}) })); }, []);
  if (!p) return <p className="dim">Loading…</p>;
  const save = (next) => { setP(next); setPrefs({ plugs: next }); };
  const plug = (n, k, v) => save({ ...p, [n]: { ...DEFAULTS[n], ...p[n], [k]: v } });
  return (
    <>
      <p className="note">Shelly Wi-Fi plugs (Gen 2 or later) for the router and the shop vac. With Auto on, the router plug follows the program (on at M3, off at M5) and the program waits the spin-up time before it moves; the vac runs while a program runs. Both go off at the end of the program, on Stop, on E-stop, and while a job is paused (Continue brings the router back up to speed before the machine moves). Leave the router's own switch on and set its speed dial as usual. If the controller loses contact, a plug switches itself off within 15 s, and a job using the router is paused. A program will not start while the router plug is not answering. Dry runs leave both off.</p>
      {NAMES.map(([n, name]) => {
        const q = { ...DEFAULTS[n], ...(p[n] || {}) };
        const s = state[`plug_${n}`];
        return (
          <div key={n} className="rform plug-pref">
            <label>{name} plug address
              <input type="text" inputMode="decimal" autoComplete="off" placeholder="192.168.4.x" defaultValue={q.ip}
                onBlur={(e) => { const v = e.target.value.trim(); if (v !== q.ip) plug(n, "ip", v); }} />
            </label>
            <label className="check"><input type="checkbox" className="switch" checked={!!q.auto} disabled={!q.ip} onChange={(e) => plug(n, "auto", e.target.checked)} /> Auto (the controller switches it)</label>
            <p className="dim">Status: {label(s, state[`plug_${n}_w`])}</p>
          </div>
        );
      })}
      <div className="rform">
        <label>Router spin-up wait after M3 (seconds)<input type="text" inputMode="numeric" autoComplete="off" defaultValue={p.spinup}
          onBlur={(e) => save({ ...p, spinup: +e.target.value || 0 })} /></label>
        <label>Vac runs on after the job (seconds)<input type="text" inputMode="numeric" autoComplete="off" defaultValue={p.vacAfter}
          onBlur={(e) => save({ ...p, vacAfter: +e.target.value || 0 })} /></label>
      </div>
    </>
  );
}
