import React, { useEffect, useMemo, useRef, useState } from "react";
import { NumInput, Modal, SharedText } from "./ui.jsx";
import { ME, useUi, useDriver, uiGet, uiCas, uiUpdate, uiPatch, uiClose } from "./shared.js";
import { api } from "./controller.js";
import { remotePut } from "./store.js";
import { getPrefs, setPrefs } from "./checkpoint.js";
import { readSetup } from "./setup.js";
import { probeActive, setterProgram, refStatus, probeRefValue, tripToWork, REF_FORMAT } from "./setter.js";
import { getSetter, saveSetter, setterArgs, useProgramRunner } from "./ToolSetter.jsx";
import { loadBedcam, saveBedcam, freshLocated, locateStock } from "./BedCam.jsx";
import { moveOverProgram, stockInMachine, revive } from "./bedcam.js";
import { computeAxis } from "./axis.js";
import { MEASURE_DEFAULTS, FAILS, ORIGINS_XY, ORIGINS_X, checkOpts, measureProgram, calibratedBall } from "./measure.js";
import { programMoves, moveStatus } from "./progress.js";
import { StepRail, StepBody, RunProgress, Outcome, useRunStep } from "./steps.jsx";
import { CheckArt, MeasureArt, SetterArt } from "./art.jsx";

// Measure stock with a 3D touch probe: finds the top and the real edges,
// reports the size and sets the work zero.  See measure.js for the program.

const STEPS = { setup: "Setup", check: "Check probe", place: "Position", run: "Measure", setter: "Tool setter", done: "Done" };
const CORNERS = new Set(["center", "front-left", "front-right", "back-left", "back-right"]);

export default function MeasureStock({ config, state, send, subscribe, metric, onClose, openId, startCalib }) {
  const u = metric ? 1 : 25.4;                    // display unit -> mm
  const unit = metric ? "mm" : "in";
  const show = (mm, p = 3) => (mm / u).toFixed(metric ? p : p + 1);

  // The whole dialog is shared (key "measure"): every screen shows the same step, fields and result.
  // The screen that pressed Measure sends the program and drives the dialog; another screen takes over
  // if it goes away (see shared.js).
  const ui = useUi(state, "measure");
  const D = ui.v && ui.v.id === openId ? ui.v : null;
  const isDriver = useDriver(state, "measure", D);
  const patch = (x) => uiPatch("measure", x).catch(() => {});
  const step = D?.step || "setup", calib = !!D?.calib, p = D?.p || null, form = D?.form || { w: "", l: "", trueW: "" };
  const adv = !!D?.adv, hint = D?.hint || "", result = D?.result || null, jogStep = D?.jogStep || 10;
  const useSetter = D?.useSetter !== false, seenOpen = !!D?.seenOpen;
  const setStep = (v) => patch({ step: v }), setCalib = (v) => patch({ calib: v }), setAdv = (v) => patch({ adv: typeof v === "function" ? v(adv) : v });
  const setResult = (v) => patch(typeof v === "function" ? (d) => ({ result: v(d.result) }) : { result: v });
  const setJogStep = (v) => patch({ jogStep: v }), setUseSetter = (v) => patch({ useSetter: v }), setSeenOpen = (v) => patch({ seenOpen: v });
  const setP = (fn) => patch((d) => ({ p: typeof fn === "function" ? fn(d.p) : fn }));
  const setForm = (fn) => patch((d) => ({ form: typeof fn === "function" ? fn(d.form || {}) : fn }));
  const [setter, setSetter] = useState(null);
  const R = useRef({ state });
  R.current.state = state; R.current.D = D;

  useEffect(() => { getSetter().then(setSetter); }, []);
  // Open: the first screen to get here fills in the dialog; the others show it.
  useEffect(() => {
    if (D) return;
    (async () => {
      const prefs = await getPrefs();
      const m = { ...MEASURE_DEFAULTS, probeY: false, origin: "center-x", w: 0, l: 0, ...(prefs.measure || {}) };
      let w = m.w, l = m.l, hintText = "";
      try {
        const sheet = await readSetup(state.selected);
        if (sheet?.stock) {
          w = sheet.stock.x.max - sheet.stock.x.min; l = sheet.stock.y.max - sheet.stock.y.min;
          if (sheet.corner && CORNERS.has(sheet.corner)) { m.origin = sheet.corner; m.probeY = true; }
          hintText = `Size and zero filled in from the setup sheet of ${state.selected}.`;
        }
      } catch {}
      // 1.36.0: stock the bed camera found in the last 30 minutes
      let camLoc = null;
      try {
        const bc = await loadBedcam(), loc = freshLocated(bc);
        if (loc) {
          camLoc = { cx: loc.cx, cy: loc.cy, w: loc.w, l: loc.l, angle: loc.angle, t: loc.t, time: loc.time };
          w = Math.round(loc.w); l = Math.round(loc.l);
          hintText = `Size and position from the bed camera (found ${new Date(loc.time).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}). The probe still measures it exactly.`;
        }
      } catch {}
      const cur = await uiGet("measure");
      if (cur.v && cur.v.id === openId) return;
      await uiCas("measure", { id: openId, driver: ME, step: "setup", calib: !!startCalib, p: m, form: { w: w ? show(w, 2) : "", l: l ? show(l, 2) : "", trueW: "" },
        adv: false, hint: hintText, result: null, jogStep: 10, useSetter: true, seenOpen: false, phase: null, started: false, cam: camLoc, camMove: null }, cur.rev);
    })().catch(() => {});
  }, [openId, !!D]); // eslint-disable-line react-hooks/exhaustive-deps

  // Watch the controller while the program runs (driving screen only). Started once it leaves idle, done when idle again.
  const runningStep = step === "run" || step === "setter";
  useEffect(() => {
    if (!isDriver || !runningStep || !D) return undefined;
    if (state.cycle && state.cycle !== "idle") { if (!D.started) patch((d) => (d.step === step ? { started: true } : {})); return undefined; }
    if (state.cycle === "idle" && (D.started || state.xx === "ESTOPPED")) {
      const t = setTimeout(() => (step === "setter" ? R.current.finishSetter() : R.current.finish()), 400);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [isDriver, runningStep, step, state.cycle, state.xx, D && D.started]); // eslint-disable-line react-hooks/exhaustive-deps
  // Taken over from a screen that went away: if the program already finished, carry on.
  useEffect(() => {
    if (!isDriver || !runningStep || !D || D.started) return undefined;
    const t = setTimeout(() => { const st = R.current.state, d = R.current.D; if (d && d.step === step && !d.started && st.cycle === "idle") (step === "setter" ? R.current.finishSetter() : R.current.finish()); }, 8000);
    return () => clearTimeout(t);
  }, [isDriver, runningStep, step, D && D.started]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => subscribe((d) => { if (d.log?.msg === "Switch not found" && R.current.D?.driver === ME) R.current.failed = true; }), [subscribe]);

  // 1.36.0: move over the stock the bed camera found, find its top, size it again at the real height
  const runCam = useProgramRunner(state, subscribe, send);
  const camMove = async () => {
    const c = D.cam;
    patch({ camMove: { state: "moving" }, driver: ME });
    try {
      const bc = await loadBedcam(), cal = revive(bc.cal), loc = bc.located;
      if (!cal || !loc) throw new Error("The bed camera's result is gone. Find the stock again, or jog by hand.");
      const z = computeAxis(state, config, "z", true);
      const r = await runCam(moveOverProgram({ top: z.max - 1, x: c.cx, y: c.cy, zStop: cal.zBed + 2, travel: p.travel, fast: config.probe["probe-fast-seek"], slow: config.probe["probe-slow-seek"], above: 8 }));
      if (r.estop || r.xx === "ESTOPPED") throw new Error("The machine stopped (E-stop) while moving over the stock.");
      if (r.ofb_ok !== 1) { patch({ camMove: { state: "missed" } }); return; }
      const t = r.ofb_top - cal.zBed;
      const again = stockInMachine(cal, { outline: loc.pxOutline, contour: loc.pxContour }, t).rect;
      const shift = Math.hypot(again.cx - c.cx, again.cy - c.cy);
      if (shift > 1 && shift < 30) await runCam(`G21\nG90 G53 G0 X${again.cx.toFixed(3)} Y${again.cy.toFixed(3)}\nG90\nM2\n`);
      const fixed = shift < 30 ? again : { ...again, cx: c.cx, cy: c.cy };
      await saveBedcam({ located: { ...loc, cx: fixed.cx, cy: fixed.cy, w: fixed.w, l: fixed.l, angle: fixed.angle, t } });
      patch((d) => ({ camMove: { state: "ready", t, w: fixed.w, l: fixed.l, angle: fixed.angle, odd: t < 1 || t > 3 * (c.t || 19) + 10 },
        cam: { ...d.cam, cx: fixed.cx, cy: fixed.cy, w: fixed.w, l: fixed.l, t },
        form: { ...(d.form || {}), w: show(fixed.w, 1), l: show(fixed.l, 1) } }));
    } catch (e) { patch({ camMove: { state: "error", text: e.message } }); }
  };

  // 1.38.0: find the stock with the bed camera from here, then measure it hands-off:
  // the check (push the stylus), then the machine moves over it, measures it and
  // touches the setter by itself.
  const [camReady, setCamReady] = useState(false);
  useEffect(() => { loadBedcam().then((bc) => setCamReady(!!(bc.cal && bc.base))).catch(() => {}); }, []);
  const findWithCamera = async () => {
    patch({ finding: true, findErr: null, driver: ME });
    try {
      const z = computeAxis(state, config, "z", true), x = computeAxis(state, config, "x", true), y = computeAxis(state, config, "y", true);
      const runOk = async (prog) => { const r = await runCam(prog); if (r.estop || r.xx === "ESTOPPED") throw new Error("The machine stopped (E-stop) while parking."); return r; };
      const res = await locateStock({ runOk, top: z.max - 1, lim: { x0: x.min, x1: x.max, y0: y.min, y1: y.max } });
      const l = res.located;
      patch((d) => ({ finding: false, auto: true, camMove: null,
        cam: { cx: l.cx, cy: l.cy, w: l.w, l: l.l, angle: l.angle, t: l.t, time: l.time },
        hint: `Found by the bed camera: about ${show(l.w, 0)} × ${show(l.l, 0)} ${unit}. The probe measures it exactly.${res.touchesEdge ? " It runs off the edge of the picture, so check it's all there." : ""}`,
        form: { ...(d.form || {}), w: show(l.w, 1), l: show(l.l, 1) }, step: "check" }));
    } catch (e) { patch({ finding: false, findErr: e.message || String(e) }); }
  };
  const edit = (k, v) => setP((x) => ({ ...x, [k]: v }));
  const mmOf = (s) => { const v = parseFloat(s); return Number.isFinite(v) ? v * u : NaN; };

  const opts = p && {
    ...p,
    w: calib ? mmOf(form.trueW) : mmOf(form.w),
    l: mmOf(form.l),
    probeY: calib ? false : p.probeY,
    origin: calib ? "center-x" : p.origin,
    calibrate: calib,
    fast: config.probe["probe-fast-seek"], slow: config.probe["probe-slow-seek"],
  };
  const errs = opts ? checkOpts(opts) : [];
  const errsNoSize = opts ? checkOpts({ ...opts, w: 100, l: 100 }) : [];
  const origins = p?.probeY ? ORIGINS_XY : ORIGINS_X;

  // Only the screen whose Measure the controller accepted first sends the program.
  const start = async () => {
    const o = opts, base = p;
    const r = await uiUpdate("measure", (d) => (d && d.id === openId && d.step === "place" ? { ...d, step: "run", phase: "measure", started: false, driver: ME, runAt: Date.now() } : undefined)).catch(() => ({ ok: false }));
    if (!r.ok) return;
    R.current.failed = false;
    setPrefs({ measure: { ...base, w: calib ? base.w : o.w, l: o.l || base.l } });
    send(measureProgram(o));
  };

  const finish = async () => {
    const at = R.current.runStep; // the move it was in, before the step changes
    // Claim the finish so it runs once, on this screen.
    const r = await uiUpdate("measure", (d) => (d && d.id === openId && d.step === "run" && d.driver === ME ? { ...d, step: "finishing" } : undefined)).catch(() => ({ ok: false }));
    if (!r.ok) return;
    const s = R.current.state;
    const failed = R.current.failed || s.xx === "ESTOPPED";
    const ok = s.ofm_ok === 1 && !failed;
    const res = { ok, fail: failed ? "edge" : s.ofm_fail, w: s.ofm_w, l: s.ofm_l, at: ok ? null : at ?? null };
    if (ok && calib) {
      res.ball = calibratedBall(s.ofm_rxa, s.ofm_rxb, opts.w);
      res.ballOk = res.ball > 0.3 && res.ball < 10;
      // 1.38.0: runs on the same block are kept, and the average is what gets saved
      if (res.ballOk) res.runs = [...((R.current.D && R.current.D.calibRuns) || []), res.ball];
    }
    if (ok && !calib && D.cam) {
      // The stock is measured: the camera's result is used up; keep its outline at the measured height
      loadBedcam().then((bc) => {
        const cal = revive(bc.cal), t = typeof s.ofm_zt === "number" && cal ? s.ofm_zt - cal.zBed : null;
        const outline = bc.outline && t !== null && bc.outline.pxOutline ? { ...bc.outline, pts: stockInMachine(cal, { outline: bc.outline.pxOutline }, t).outline, t } : bc.outline;
        return saveBedcam({ located: null, outline });
      }).catch(() => {});
    }
    if (ok && !calib) {
      remotePut("probe", { loc: opts.origin, time: Date.now(), off: { x: s.offset_x ?? null, y: opts.probeY ? s.offset_y ?? null : null, z: s.offset_z ?? null }, measured: { w: s.ofm_w, l: opts.probeY ? s.ofm_l : null } });
    }
    if (ok && !calib && setterOn) {
      // Reference the tool setter with the probe while its Z zero is fresh
      R.current.failed = false;
      await patch({ result: res, step: "setter", phase: "setter", started: false, runAt: Date.now() });
      send(setterProgram(setterArgs(s, config, setter, "ref")));
      return;
    }
    patch(res.runs ? { result: res, step: "done", calibRuns: res.runs } : { result: res, step: "done" });
  };

  const finishSetter = async () => {
    const r = await uiUpdate("measure", (d) => (d && d.id === openId && d.step === "setter" && d.driver === ME ? { ...d, step: "finishing" } : undefined)).catch(() => ({ ok: false }));
    if (!r.ok) return;
    const s = R.current.state;
    const ok = s.ofs_ok === 1 && !R.current.failed && s.xx !== "ESTOPPED" && typeof s.ofs_ref === "number" && typeof s.offset_z === "number";
    if (ok) {
      // Stored corrected for the probe-vs-cutter difference (if calibrated); the raw value is kept for calibrating.
      const now = Date.now();
      // The touch is reported in machine coordinates; the reference is a work Z (1.34.3)
      const w = tripToWork(s.ofs_ref, s.offset_z);
      const n = { ...setter, ref: { ref: probeRefValue(w, setter), offZ: s.offset_z, time: now, by: "probe", corrected: setter.corr?.f === REF_FORMAT && typeof setter.corr?.c === "number", f: REF_FORMAT },
        lastProbe: { ref: w, offZ: s.offset_z, time: now, f: REF_FORMAT } };
      setSetter(n); saveSetter(n);
    }
    const notFound = R.current.failed || s.xx === "ESTOPPED";
    patch((d) => ({ result: { ...(d.result || {}), setter: ok ? "ok" : notFound ? "notfound" : "fail" }, step: "done" }));
  };

  R.current.finish = finish;
  R.current.finishSetter = finishSetter;
  R.current.camMove = camMove;
  R.current.start = start;

  const runs = (result && result.runs) || [];
  const avgBall = runs.length ? runs.reduce((a, b) => a + b, 0) / runs.length : result?.ball;
  const spread = runs.length > 1 ? Math.max(...runs) - Math.min(...runs) : 0;
  const saveBall = () => { const b = Math.round(avgBall * 1000) / 1000; patch((d) => ({ p: { ...d.p, ball: b }, calib: false, step: "setup", result: null, calibRuns: [] })); setPrefs({ measure: { ...p, ball: b, ballTime: Date.now(), ballRuns: runs.length } }); };
  const measureAgain = () => patch({ step: "place", result: null });

  // Wait for the stylus to be touched before any motion
  const touched = probeActive(state);
  // Hands-off: once the probe check is done and the hand is away, move over the stock; when the
  // stylus is over it, measure. Each waits a moment so nobody's hand is near the probe.
  useEffect(() => {
    if (!isDriver || !D?.auto || touched || state.cycle !== "idle") return undefined;
    if (step === "place" && D.cam && !D.camMove) { const t = setTimeout(() => R.current.camMove(), 2000); return () => clearTimeout(t); }
    if (step === "place" && D.camMove?.state === "ready" && !D.camMove.odd && Math.abs(D.camMove.angle || 0) < 5) {
      const t = setTimeout(() => R.current.start(), 1500); return () => clearTimeout(t);
    }
    return undefined;
  }, [isDriver, D?.auto, step, D?.camMove?.state, touched, state.cycle]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!D) return;
    if (step !== "check") { if (seenOpen) setSeenOpen(false); return; }
    if (!touched) { if (!seenOpen) setSeenOpen(true); }
    else if (seenOpen) uiPatch("measure", (d) => (d.step === "check" ? { step: "place" } : {})).catch(() => {});
  }, [step, touched, seenOpen, !!D]); // eslint-disable-line react-hooks/exhaustive-deps
  const setterOn = !calib && useSetter && !!setter && typeof setter.x === "number";

  const jog = (axis, dir) => send(`G21\nG91 G0 ${axis}${dir * jogStep * u}\nG90\n`);
  // Cancel on any screen: stop the machine if a measuring program is running, close it everywhere.
  const stop = async () => {
    const was = R.current.D;
    const r = await uiUpdate("measure", (d) => (d && d.id === openId ? null : undefined)).catch(() => ({ ok: false }));
    if (r.ok && was && (was.step === "run" || was.step === "setter")) api.put("stop").catch(() => {});
    uiClose("tool"); onClose && onClose();
  };
  const done = () => { uiUpdate("measure", (d) => (d && d.id === openId ? null : undefined)).catch(() => {}); uiClose("tool"); onClose && onClose(); };
  const list = ["setup", "check", "place", "run", ...(setterOn ? ["setter"] : []), "done"];

  const num = (k, label, help) => (
    <label className="stack">{label}
      <NumInput digits={4} value={p[k] === undefined ? "" : (k === "travel" ? p[k] : p[k] / u)}
        onChange={(n) => edit(k, k === "travel" ? n : n * u)} />
      {help && <small>{help}</small>}
    </label>
  );

  // The moves of the program on screen (its progress marks, see progress.js), and the one running now
  const planMoves = useMemo(() => {
    try { return opts && !errs.length ? programMoves(measureProgram(opts)) : []; } catch { return []; }
  }, [JSON.stringify(opts), errs.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const setterMoves = useMemo(() => {
    try { return setter && typeof setter.x === "number" && config ? programMoves(setterProgram(setterArgs(state, config, setter, "ref"))) : []; } catch { return []; }
  }, [setter, !!config]); // eslint-disable-line react-hooks/exhaustive-deps
  const running = step === "run" || step === "setter";
  const runStep = useRunStep(state.of_step, running && D?.runAt ? `${step}:${D.runAt}` : null);
  R.current.runStep = runStep;
  const runMoves = step === "setter" ? setterMoves : planMoves;
  const cur = runStep === null ? -1 : moveStatus(runMoves, runStep).cur;

  if (!D) return null;
  const stopAt = result && !result.ok && result.at ? moveStatus(planMoves, result.at) : null;
  return (
    <Modal title={calib ? "Calibrate the stylus" : "Measure stock"} wide dismissable={false} onClose={stop}
      actions={<>
        {step !== "done" && <button className={running || step === "finishing" ? "danger" : ""} onClick={stop}>{running || step === "finishing" ? "Stop" : "Cancel"}</button>}
        {step === "setup" && <button className="primary" data-autofocus disabled={!p || errs.length > 0} onClick={() => setStep("check")}>Next</button>}
        {step === "place" && <button className="primary" data-autofocus disabled={touched || D.camMove?.state === "moving" || (!!D.cam && !calib && !D.camMove)} onClick={start}>{calib ? "Measure the block" : "Start measuring"}</button>}
        {(running || step === "finishing") && <button className="primary" disabled>Measuring…</button>}
        {step === "done" && result?.ok && calib && result.ballOk && <button onClick={measureAgain}>Measure again</button>}
        {step === "done" && result?.ok && calib && result.ballOk && <button className={runs.length >= 3 ? "primary" : ""} data-autofocus={runs.length >= 3 || undefined} onClick={saveBall}>Save {show(avgBall)} {unit}{runs.length > 1 ? ` (average of ${runs.length})` : ""}</button>}
        {step === "done" && <button className={result?.ok && !calib ? "primary" : ""} onClick={done}>Done</button>}
      </>}>
      <div className="probe">
        <StepRail steps={list} labels={STEPS} current={step === "finishing" ? "run" : step} />
        <div className="probe-main">
          {step === "setup" && p && <StepBody title={calib ? "Calibrate the stylus ball" : "What to measure"} art={<MeasureArt moves={planMoves} probeY={!!opts?.probeY} />}>{calib ? <>
            <p>Clamp a block you know the exact width of (a 1-2-3 block, a gauge block, or a part you measured with calipers) with its ends free. The machine touches both ends and works out the effective size of the stylus ball. Work zero is not changed.</p>
            <div className="stack">
              <label className="stack">Exact X width of the block ({unit})
                <SharedText inputMode="decimal" data-autofocus value={form.trueW} onChange={(v) => setForm((f) => ({ ...f, trueW: v }))} /></label>
            </div>
            <p><button onClick={() => setCalib(false)}>Back to measuring</button></p>
          </> : <>
            <p>Measures the top and the real edges of the stock with a 3D touch probe, then sets the work zero. Only the stylus touches the stock; swap to your cutter afterwards and probe Z as usual.</p>
            {camReady && !D.auto && <div className="why"><b>Let the bed camera find it</b>
              <p>Parks over the tool setter, finds the stock in a picture, then after the probe check it moves over the stock, measures it{setter && typeof setter.x === "number" && useSetter ? " and touches the tool setter" : ""} by itself.</p>
              <div className="row-start"><button className="primary" disabled={!!D.finding || state.cycle !== "idle" || errsNoSize.length > 0} onClick={findWithCamera}>{D.finding ? "Looking…" : "Find it and measure"}</button></div>
              {D.findErr && <p className="err">{D.findErr}</p>}</div>}
            {hint && <p className="dim">{hint}</p>}
            <div className="measure-grid">
              <label className="stack">Approximate X size ({unit})
                <SharedText inputMode="decimal" value={form.w} onChange={(v) => setForm((f) => ({ ...f, w: v }))} /></label>
              {p.probeY && <label className="stack">Approximate Y size ({unit})
                <SharedText inputMode="decimal" value={form.l} onChange={(v) => setForm((f) => ({ ...f, l: v }))} /></label>}
            </div>
            <small className="dim">Within {show(p.margin, 0)} {unit} is close enough.</small>
            <label className="check"><input type="checkbox" checked={!!p.probeY} onChange={(e) => { const on = e.target.checked; setP((x) => ({ ...x, probeY: on, origin: on ? "center" : "center-x" })); }} /> Also touch the front and back faces (only when they stand above the vise jaws and clamps)</label>
            <label className="stack">Set zero at
              <select value={p.origin} onChange={(e) => edit("origin", e.target.value)}>
                {origins.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select></label>
            {setter && typeof setter.x === "number" && <label className="check"><input type="checkbox" checked={useSetter} onChange={(e) => setUseSetter(e.target.checked)} /> Then touch the tool setter with the probe, so each cutter can be measured there (no touch plate)</label>}
            <p className="dim">Stylus ball: {show(p.ball)} {unit} <button onClick={() => { setCalib(true); }}>Calibrate stylus…</button></p>
            <button className="quiet" onClick={() => setAdv((a) => !a)}>{adv ? "Hide" : "Show"} advanced settings</button>
            {adv && <div className="measure-grid">
              {num("ball", `Stylus ball diameter (${unit})`, "Set by Calibrate stylus.")}
              {num("clear", `Travel height above the top (${unit})`, "Raise it if clamps stand above the stock.")}
              {num("depth", `Touch depth below the top (${unit})`, "Must be less than the stock thickness.")}
              {num("margin", `Drop distance outside the edge (${unit})`, "How far off the typed size can be.")}
              {num("travel", "Travel speed (mm/min)", "Guarded moves stop on any touch.")}
            </div>}
          </>}
          {errs.length > 0 && <ul className="plain err">{errs.map((e) => <li key={e}>{e}</li>)}</ul>}
          </StepBody>}

          {step === "check" && <StepBody title="Check the probe" art={<CheckArt probe />}>
            <p>Put the 3D probe in the collet and plug it in.</p>
            <p><b>Push the stylus sideways with your finger.</b> This step moves on by itself when the controller sees the touch.</p>
            <div className="indet" />
            {touched && !seenOpen ? <p className="err">The probe input already reads as touched. With normally-closed wiring that means the loop is open: plug the probe in (and the setter), or fit the shorting plug.</p>
              : <p className="dim">Nothing happening? Check the probe cable, and that the probe input type under I/O matches your probe (normally open or normally closed).</p>}
          </StepBody>}

          {step === "place" && <StepBody title="Position the stylus" art={<MeasureArt moves={planMoves} probeY={!!opts?.probeY} />}>
            {D.cam && !calib && <div className="why">
              <b>The bed camera found the stock</b>
              {!D.camMove && !D.auto && <><p>The machine can go over its middle by itself: up to the top, across, then down slowly until the stylus touches the top. It stops {show(8, 0)} {unit} above it.</p>
                <div className="row-start"><button className="primary" disabled={touched || state.cycle !== "idle"} onClick={camMove}>Move over the stock</button>
                  <button className="quiet" onClick={() => patch({ camMove: { state: "manual" } })}>Jog by hand instead</button></div></>}
              {!D.camMove && D.auto && <p>{touched ? "Let go of the stylus." : "Moving over it in a moment. Keep your hands clear."}</p>}
              {D.camMove?.state === "moving" && <p>Moving over the stock and finding its top… Keep a hand near the E-stop.</p>}
              {D.camMove?.state === "ready" && D.auto && !D.camMove.odd && Math.abs(D.camMove.angle || 0) < 5 && <p>Measuring in a moment.</p>}
              {D.camMove?.state === "ready" && <p>Ready: the stylus is over the middle, {show(8, 0)} {unit} above the top. The stock is about {show(D.camMove.t, 1)} {unit} thick and {show(D.camMove.w, 0)} × {show(D.camMove.l, 0)} {unit}.
                {D.camMove.odd && <span className="err"> That height looks odd: the stylus may have landed on a clamp. Check before measuring.</span>}
                {Math.abs(D.camMove.angle || 0) >= 5 && <span className="err"> The stock is turned {D.camMove.angle.toFixed(1)}°: straighten it, or the sizes will read large.</span>}</p>}
              {D.camMove?.state === "missed" && <p className="err">The stylus came down to just above the bed without touching anything, so the stock isn't where the camera saw it. It went back up. Jog by hand below, or find the stock again.</p>}
              {D.camMove?.state === "error" && <p className="err">{D.camMove.text}</p>}
            </div>}
            {(!D.cam || calib || ["missed", "error", "manual"].includes(D.camMove?.state)) && <>
            <p>Jog the stylus over the <b>middle</b> of the {calib ? "block" : "stock"}, about 3 to 15 {metric ? "mm" : "mm (⅛ to ½ in)"} above the top. It doesn't need to be exact.</p>
            <div className="probe-jog">
              <div className="radios inline">Step: {[10, 1].map((v) => <label key={v}><input type="radio" name="mjs" checked={jogStep === v} onChange={() => setJogStep(v)} /> {v} {unit}</label>)}</div>
              <div className="jgrid">
                <span /><button onClick={() => jog("Y", 1)}>Y+ (back)</button><span /><button onClick={() => jog("Z", 1)}>Z+ (up)</button>
                <button onClick={() => jog("X", -1)}>X− (left)</button><span /><button onClick={() => jog("X", 1)}>X+ (right)</button><span />
                <span /><button onClick={() => jog("Y", -1)}>Y− (front)</button><span /><button onClick={() => jog("Z", -1)}>Z− (down)</button>
              </div>
            </div>
            </>}
            <div className="why"><b>What happens next</b><p>The stylus touches the top, lifts {show(opts.clear, 0)} {unit}, then drops {show(opts.margin, 0)} {unit} outside each {calib || !opts.probeY ? "end" : "edge"} and touches it {show(opts.depth, 0)} {unit} below the top. Any unexpected touch stops it. Keep a hand near the E-stop.</p></div>
          </StepBody>}

          {step === "setter" && <StepBody title="Touching the tool setter" art={<SetterArt moves={setterMoves} cur={cur} probe />}>
            <RunProgress title="Tool setter reference" moves={setterMoves} step={runStep} started={!!D.started} />
          </StepBody>}
          {(step === "run" || step === "finishing") && <StepBody title={calib ? "Measuring the block" : "Measuring"} art={<MeasureArt moves={planMoves} cur={step === "finishing" ? planMoves.length : cur} probeY={!!opts?.probeY} />}>
            <RunProgress title={calib ? "Measuring the block" : "Measuring the stock"} moves={planMoves} step={step === "finishing" ? null : runStep} started={!!D.started} />
          </StepBody>}

          {step === "done" && result && <StepBody art={<MeasureArt moves={planMoves} cur={result.ok ? planMoves.length : stopAt ? stopAt.cur : -1} probeY={!!opts?.probeY} />}>{result.ok ? (calib ? <Outcome ok title={`Stylus ball: ${show(result.ball)} ${unit}`}>
            {result.ballOk ? <>
              {runs.length > 1 && <p>Runs: {runs.map((b) => show(b)).join(", ")} {unit}. Average {show(avgBall)}, spread {show(spread)} {unit}.</p>}
              {spread > 0.05 ? <p className="err">The runs differ by more than {show(0.05, 2)} {unit}. Check the probe is tight in the collet and the block is clamped, then measure again.</p>
                : runs.length < 3 ? <p>Measure again {3 - runs.length === 1 ? "once more" : "twice more"} without moving anything; the average of 3 runs is saved.</p>
                : <p>Save it to use it for every measurement from now on. Run this again if you change the stylus.</p>}
            </>
              : <p className="err">That isn't a believable stylus size. Check the width you typed and that the block's ends are square, then try again.</p>}
          </Outcome> : <Outcome ok title={`Measured ${show(result.w)}${opts.probeY ? ` × ${show(result.l)}` : ""} ${unit}`}>
            <p>Measured {opts.probeY ? "X × Y" : "X length"}{Number.isFinite(opts.w) ? ` (you typed ${show(opts.w, 2)}${opts.probeY ? ` × ${show(opts.l, 2)}` : ""})` : ""}.</p>
            <p>Zero is set: Z on the top, {origins.find(([v]) => v === opts.origin)?.[1].replace(/ \(.*\)$/, "").toLowerCase()} for {opts.probeY ? "X and Y" : "X (Y not changed)"}. The stylus is parked over it.</p>
            {result.setter === "ok" ? <div className="why"><b>Next: take the probe out</b><p>Put your cutter in, open <b>Tool setter</b> and press <b>Measure tool</b>. Z zero follows the cutter; X and Y stay as measured.</p></div>
              : result.setter ? <div className="why bad"><b>The tool setter reference didn't work</b><p>{result.setter === "notfound" ? "The probe didn't reach the setter and the controller stopped with an E-stop. Check the setter position and cable." : "The setter routine stopped early."} The stock measurement and zero are fine. Put your cutter in and use Probe Z, or fix the setter and take a reference from the Tool setter screen.</p></div>
              : <div className="why"><b>Next: take the probe out</b><p>Put your cutter in and run <b>Probe Z</b>. X and Y stay as measured.</p></div>}
          </Outcome>) : <Outcome ok={false} title="Measuring stopped">
            {result.fail === "edge" ? <>
              <p>An edge wasn't where it should be, so the controller stopped with an emergency stop. The stock may be smaller than the size you typed, or the touch depth is deeper than the stock is thick.</p>
              <p>Clear the E-stop, then try again.</p>
            </> : <p>{FAILS[result.fail] || "The measurement didn't finish."}</p>}
            {stopAt && stopAt.cur >= 0 && <p className="dim">Stopped during move {stopAt.cur + 1} of {stopAt.of}: {stopAt.label}.</p>}
            <p className="dim">Work zero was not changed.</p>
          </Outcome>}</StepBody>}
        </div>
      </div>
    </Modal>
  );
}
