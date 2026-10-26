import React, { useState, useEffect, useRef } from "react";
import { api } from "./controller.js";
import { fmtTime, computeAxis } from "./axis.js";
import { useNote } from "./notes.js";
import { markStopped } from "./history.js";
import ParkDialog from "./ParkDialog.jsx";
import Checklist, { buildChecks, skipChecklist, SheetView, lintChecks, toolChecks } from "./Checklist.jsx";
import { readSetup, stockChecks, probeChecks, sheetLineChecks } from "./setup.js";
import { remoteGet } from "./store.js";
import { getSetter } from "./ToolSetter.jsx";
import { setterChecks } from "./setter.js";
import { Modal } from "./ui.jsx";
import { useUi, uiSet, uiCas, uiOpen, uiClose, uiPatch, usePref, setPref, getPref } from "./shared.js";
import { useCheckpoint } from "./checkpoint.js";
import { useFinished } from "./doover.js";
import DoOverDialog from "./DoOverDialog.jsx";
import { PlugStrip } from "./Plugs.jsx";

function Override({ label, kind, hint, value }) {
  // Shows the controller's override (the same on every screen) except while this slider is being dragged.
  const [drag, setDrag] = useState(null);
  const v = drag ?? (Number.isFinite(value) ? Math.round(value / 10) : 100);
  const setV = setDrag;
  const commit = (x) => { setDrag(null); api.put(`override/${kind}/${(x / 100).toFixed(2)}`).catch(() => {}); };
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
  // The run checklist, the park question and the setup sheet are shared: open on one screen, open on all.
  const checkUi = useUi(state, "runcheck");
  const check = checkUi.v;
  const setCheck = (c) => (c ? uiSet("runcheck", c) : uiClose("runcheck"));
  const parkAsk = !!useUi(state, "park-ask").v;
  const setParkAsk = (on) => (on ? uiOpen("park-ask", { at: Date.now() }) : uiClose("park-ask"));
  // Dry run (1.33.0: quick): the controller sends the first pass of each operation, at 3000 mm/min, with
  // repeated depth levels left out and long facing passes cut short, 30 mm (or the chosen lift) higher with the router,
  // mist and probing blocked. It lasts for one run only, so it can never be left on.
  const dry = !!useUi(state, "dry").v;
  const setDry = (on) => uiSet("dry", on ? true : null).catch(() => {});
  const lift = usePref("dry.lift", 30);
  const setLift = (v) => setPref("dry.lift", +v);
  // Set with buttons in 5 mm steps (5 to 100 mm), so it needs no keyboard on the controller's touch screen.
  const liftMm = Math.min(100, Math.max(5, Math.round((+lift || 30) / 5) * 5));
  const [err, setErr] = useState("");
  const note = useNote(state.selected).split("\n")[0];
  // ack: the operator ticked "run anyway" on a checklist with red items. Without it the controller runs
  // its own check (1.29.0) and refuses a program with G-code errors or the wrong zero corner.
  const start = (ack = false) => {
    setErr("");
    const body = { ...(dry ? { dry_lift: liftMm } : {}), ...(ack ? { ack: true } : {}) };
    return api.put("start", Object.keys(body).length ? body : undefined)
      .then(() => setDry(false))
      .catch((e) => setErr(String(e.message || e).replace(/^\{"message":"|","code":\d+\}$/g, "")));
  };
  // Setter guard inputs (1.34.0): machine Z top of travel, and the dry run lift when Dry run is ticked.
  const guardOpts = (isDry) => {
    let zMax;
    try { const z = config ? computeAxis(state, config, "z", true) : null; if (z && z.homed && isFinite(z.max)) zMax = z.max; } catch { /* no config yet */ }
    return { zMax, dryLift: isDry ? liftMm : 0 };
  };
  // Always-visible warning when the loaded program's zero corner or plate does not match what the controller knows.
  const [live, setLive] = useState([]);
  // The probe record is saved after probing ends (when Done is pressed), after the offsets stop changing,
  // so the check also re-runs when a new record is saved, and every few seconds while a warning shows.
  const [probeTick, setProbeTick] = useState(0);
  const sheetCache = useRef({ file: null, setup: undefined });
  const lintCache = useRef({ file: null, lint: undefined });
  useEffect(() => {
    const bump = () => setProbeTick((t) => t + 1);
    window.addEventListener("next-store:probe", bump);
    window.addEventListener("next-store:prefs", bump); // tool setter position or reference changed
    return () => { window.removeEventListener("next-store:probe", bump); window.removeEventListener("next-store:prefs", bump); };
  }, []);
  useEffect(() => {
    if (!live.length) return undefined;
    const t = setInterval(() => setProbeTick((n) => n + 1), 3000);
    return () => clearInterval(t);
  }, [live.length]);
  useEffect(() => {
    let gone = false;
    if (!state.selected) { setLive([]); return undefined; }
    (async () => {
      try {
        // The sheet only changes with the program, so it is read once per file; the probe record is re-read every time.
        const key = `${state.selected}|${state.selected_time || ""}`; // a re-uploaded file gets a new time
        let setup = sheetCache.current.file === key ? sheetCache.current.setup : undefined;
        if (setup === undefined) { setup = await readSetup(state.selected); sheetCache.current = { file: key, setup }; }
        const setter = await getSetter();
        const sc = path?.positions ? setterChecks(path, setter, state, setup?.toolD, metric, guardOpts(dry)) : [];
        const rec = setup?.corner ? await remoteGet("probe") : null;
        // The G-code check only changes with the program (1.31.2: it was asked for again every 3 s while
        // a warning showed). A failed read is not kept, so it is tried again on the next pass.
        let lint = lintCache.current.file === key ? lintCache.current.lint : undefined;
        let raw = lintCache.current.file === key ? lintCache.current.raw : null;
        if (lint === undefined) {
          try {
            raw = await api.get(`lint/${encodeURIComponent(state.selected)}`);
            lint = lintChecks(raw).filter((c) => c.level === "stop");
            lintCache.current = { file: key, lint, raw };
          } catch { lint = []; /* checked again at Run */ }
        }
        if (!dry) lint = [...lint, ...toolChecks(raw, config)]; // the Tool can change without the program changing; a dry run keeps the spindle off
        const nested = lint.some((c) => c.key === "comment-nested");
        const bad = [...probeChecks(setup, rec, state), ...stockChecks(setup, metric), ...(nested ? [] : sheetLineChecks(setup)), ...lint, ...sc].filter((c) => c.level !== "ok");
        if (!gone) setLive(bad);
      } catch { if (!gone) setLive([]); }
    })();
    return () => { gone = true; };
  }, [state.selected, state.selected_time, state.offset_x, state.offset_y, state.offset_z, metric, probeTick, path, dry, liftMm, config?.tool?.["selected-tool"]]); // eslint-disable-line react-hooks/exhaustive-deps
  // Cut deeper (1.30.0): offered once the selected program has run to the end
  const { cp } = useCheckpoint(state);
  const doover = useUi(state, "doover").v;
  const finished = useFinished(cp, state.selected);
  const sheet = useUi(state, "sheet").v;
  const setSheet = (v) => (v ? uiSet("sheet", v) : uiClose("sheet"));
  const [sheetBusy, setSheetBusy] = useState(false);
  const tryStart = async () => {
    setErr("");
    // Every read the checks need must work, or the job does not start (1.29.0: a failed read used to
    // skip the setup sheet checks and run anyway).
    const file = state.selected;
    let setup = null, rec = null, lint = null;
    try { setup = await readSetup(file); }
    catch (e) { setErr(`Not started: the setup sheet at the top of ${file} could not be read (${e.message || e}). Check the connection and press Run again.`); return; }
    try { rec = setup?.corner ? await remoteGet("probe") : null; }
    catch (e) { setErr(`Not started: the record of the last probe could not be read (${e.message || e}), so the zero corner cannot be checked. Press Run again.`); return; }
    try { lint = await api.get(`lint/${encodeURIComponent(file)}`); }
    catch (e) { setErr(`Not started: the controller could not check ${file} (${String(e.message || e).replace(/^\{"message":"|","code":\d+\}$/g, "")}). Press Run again.`); return; }
    let extra = [];
    try { extra = setterChecks(path, await getSetter(), state, setup?.toolD, metric, guardOpts(dry)); } catch { /* no setter saved */ }
    extra = [...lintChecks(lint), ...(dry ? [] : toolChecks(lint, config)), ...extra];
    const checks = buildChecks(state, config, metric, file, setup, rec, extra);
    // A program with a setup sheet always shows it. A move outside the plate is never skipped.
    const stopped = checks.some((c) => c.level === "stop");
    // A dry run only interrupts for a red item (wrong zero corner, move outside the plate); a normal run always shows the sheet.
    if (dry && !stopped) return start();
    const mustShow = !!setup || stopped;
    if (skipChecklist() && !mustShow) start(); else setCheck({ checks, setup });
  };
  const openSheet = async () => {
    setSheetBusy(true); setErr("");
    try {
      const setup = await readSetup(state.selected);
      const rec = setup?.corner ? await remoteGet("probe") : null;
      let sc = [];
      try { sc = setterChecks(path, await getSetter(), state, setup?.toolD, metric, guardOpts(dry)); } catch { /* no setter saved */ }
      setSheet(setup ? { setup, checks: [...probeChecks(setup, rec, state), ...stockChecks(setup, metric), ...sheetLineChecks(setup), ...sc] } : { setup: null, checks: sc });
    } catch (e) { setErr(String(e.message || e)); }
    setSheetBusy(false);
  };
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
        {file && !active && <button className="linkish" disabled={sheetBusy} onClick={openSheet} title="Where to zero, which corner to probe, tool and feeds for this program">{sheetBusy ? "Reading…" : "Setup sheet"}</button>}
        {file && !active && finished && <button className="linkish" onClick={() => uiOpen("doover", { file, at: Date.now() })} title="The cut didn't go all the way through: run only the deepest passes again, deeper">Cut deeper…</button>}
        {note && <em className="file-note" title={note}>{note}</em>}
      </div>
      <div className="bar" role="progressbar" aria-valuenow={active ? pct : 0} aria-valuemin="0" aria-valuemax="100"><i style={{ width: `${active ? (pct || 2) : 0}%` }} /></div>
      {state.dry_run && <div className="dry-banner" role="status">DRY RUN – {state.dry_note ? state.dry_note + " " : ""}Moves are lifted {Math.round(state.dry_lift || 0)} mm. Router, mist and probing are blocked. Normal runs are unaffected.</div>}
      {!active && (
        <div className="dry-opt">
          <label title="Run the selected program in the air: Z lifted, router and mist blocked. Applies to the next run only.">
            <input type="checkbox" checked={dry} onChange={(e) => setDry(e.target.checked)} /> Dry run
          </label>
          {dry && (
            <span className="dry-lift" role="group" aria-label="Dry run lift">
              lift
              <button type="button" aria-label="Lift 5 mm less" disabled={liftMm <= 5} onClick={() => setLift(String(Math.max(5, liftMm - 5)))}>−</button>
              <output id="dry-lift" aria-live="polite">{liftMm} mm</output>
              <button type="button" aria-label="Lift 5 mm more" disabled={liftMm >= 100} onClick={() => setLift(String(Math.min(100, liftMm + 5)))}>+</button>
            </span>
          )}
        </div>
      )}
      {err && <div className="dry-err" role="alert">{err}</div>}
      {!active && live.length > 0 && (
        <div className={`live-warn ${live.some((c) => c.level === "stop") ? "stop" : "warn"}`} role="alert">
          {live.map((c, i) => <p key={i}><b>{c.name}.</b> {c.text}</p>)}
        </div>
      )}
      <div className="runrow">
        {!active && <button className={dry ? "go dry" : "go"} disabled={!canStart} onClick={tryStart}>{dry ? "Dry run" : "Run"}</button>}
        {running && <button className="hold" onClick={() => api.put("pause")}>Pause</button>}
        {holding && <button className="go" onClick={() => api.put("unpause")}>Resume</button>}
        <button className="halt" disabled={!active} onClick={() => { markStopped(); api.put("stop"); }}>Stop</button>
        {active && <button className="park" title="Stop here, lift Z and switch the machine off. Finish the job later with Resume." onClick={() => setParkAsk(true)}>Park…</button>}
      </div>
      <PlugStrip state={state} />
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
      <Override label="Feed" kind="feed" hint="Feed rate override" value={state.fo} />
      <Override label="Speed" kind="speed" hint="Spindle speed override" value={state.so} />
      {doover && <DoOverDialog state={state} metric={metric} onClose={() => uiClose("doover")} />}
      {(parkAsk || state.park) && <ParkDialog state={state} config={config} active={active} onClose={() => setParkAsk(false)} />}
      {check && <Checklist checks={check.checks} setup={check.setup} ack={!!check.ack} never={!!check.never}
        onAck={(on) => uiPatch("runcheck", { ack: on })} onNever={(on) => uiPatch("runcheck", { never: on })}
        onCancel={() => setCheck(null)}
        // Only the screen whose Run the controller takes first starts the job.
        onRun={async () => { const acked = !!check.ack && check.checks.some((c) => c.level === "stop"); const r = await uiCas("runcheck", null, checkUi.rev).catch(() => null); if (r && r.ok) start(acked); }} />}
      {sheet && (
        <Modal title="Setup sheet" wide onClose={() => setSheet(null)} actions={<button data-autofocus onClick={() => setSheet(null)}>Close</button>}>
          {sheet.setup ? <SheetView setup={sheet.setup} /> : <p>This program has no setup sheet.</p>}
          {sheet.checks.length > 0 && (
            <ul className="checks">{sheet.checks.map((c, i) => <li key={i} className={c.level}><span className="mark" aria-label={c.level}>{c.level === "ok" ? "✓" : c.level === "warn" ? "!" : "✕"}</span><b>{c.name}</b><span>{c.text}</span></li>)}</ul>
          )}
          {sheet.checks.length > 0 && <p className="sheet-note">These checks run again when you press Run.</p>}
        </Modal>
      )}
    </div>
  );
}
