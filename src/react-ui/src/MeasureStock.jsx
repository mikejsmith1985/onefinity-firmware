import React, { useEffect, useRef, useState } from "react";
import { NumInput, Modal, SharedText } from "./ui.jsx";
import { ME, useUi, useDriver, uiGet, uiCas, uiUpdate, uiPatch, uiClose } from "./shared.js";
import { api } from "./controller.js";
import { remotePut } from "./store.js";
import { getPrefs, setPrefs } from "./checkpoint.js";
import { readSetup } from "./setup.js";
import { probeActive, setterProgram, refStatus, probeRefValue } from "./setter.js";
import { getSetter, saveSetter, setterArgs } from "./ToolSetter.jsx";
import { MEASURE_DEFAULTS, FAILS, ORIGINS_XY, ORIGINS_X, checkOpts, measureProgram, calibratedBall } from "./measure.js";

// Measure stock with a 3D touch probe: finds the top and the real edges,
// reports the size and sets the work zero.  See measure.js for the program.

const STEPS = { setup: "Setup", check: "Check probe", place: "Position", run: "Measuring", setter: "Tool setter", done: "Result" };
const CORNERS = new Set(["center", "front-left", "front-right", "back-left", "back-right"]);

export default function MeasureStock({ config, state, send, subscribe, metric, onClose, openId }) {
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
      const cur = await uiGet("measure");
      if (cur.v && cur.v.id === openId) return;
      await uiCas("measure", { id: openId, driver: ME, step: "setup", calib: false, p: m, form: { w: w ? show(w, 2) : "", l: l ? show(l, 2) : "", trueW: "" },
        adv: false, hint: hintText, result: null, jogStep: 10, useSetter: true, seenOpen: false, phase: null, started: false }, cur.rev);
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
  const origins = p?.probeY ? ORIGINS_XY : ORIGINS_X;

  // Only the screen whose Measure the controller accepted first sends the program.
  const start = async () => {
    const o = opts, base = p;
    const r = await uiUpdate("measure", (d) => (d && d.id === openId && d.step === "place" ? { ...d, step: "run", phase: "measure", started: false, driver: ME } : undefined)).catch(() => ({ ok: false }));
    if (!r.ok) return;
    R.current.failed = false;
    setPrefs({ measure: { ...base, w: calib ? base.w : o.w, l: o.l || base.l } });
    send(measureProgram(o));
  };

  const finish = async () => {
    // Claim the finish so it runs once, on this screen.
    const r = await uiUpdate("measure", (d) => (d && d.id === openId && d.step === "run" && d.driver === ME ? { ...d, step: "finishing" } : undefined)).catch(() => ({ ok: false }));
    if (!r.ok) return;
    const s = R.current.state;
    const failed = R.current.failed || s.xx === "ESTOPPED";
    const ok = s.ofm_ok === 1 && !failed;
    const res = { ok, fail: failed ? "edge" : s.ofm_fail, w: s.ofm_w, l: s.ofm_l };
    if (ok && calib) {
      res.ball = calibratedBall(s.ofm_rxa, s.ofm_rxb, opts.w);
      res.ballOk = res.ball > 0.3 && res.ball < 10;
    }
    if (ok && !calib) {
      remotePut("probe", { loc: opts.origin, time: Date.now(), off: { x: s.offset_x ?? null, y: opts.probeY ? s.offset_y ?? null : null, z: s.offset_z ?? null }, measured: { w: s.ofm_w, l: opts.probeY ? s.ofm_l : null } });
    }
    if (ok && !calib && setterOn) {
      // Reference the tool setter with the probe while its Z zero is fresh
      R.current.failed = false;
      await patch({ result: res, step: "setter", phase: "setter", started: false });
      send(setterProgram(setterArgs(s, config, setter, "ref")));
      return;
    }
    patch({ result: res, step: "done" });
  };

  const finishSetter = async () => {
    const r = await uiUpdate("measure", (d) => (d && d.id === openId && d.step === "setter" && d.driver === ME ? { ...d, step: "finishing" } : undefined)).catch(() => ({ ok: false }));
    if (!r.ok) return;
    const s = R.current.state;
    const ok = s.ofs_ok === 1 && !R.current.failed && s.xx !== "ESTOPPED";
    if (ok) {
      // Stored corrected for the probe-vs-cutter difference (if calibrated); the raw value is kept for calibrating.
      const now = Date.now();
      const n = { ...setter, ref: { ref: probeRefValue(s.ofs_ref, setter), offZ: s.offset_z, time: now, by: "probe", corrected: typeof setter.corr?.c === "number" },
        lastProbe: { ref: s.ofs_ref, offZ: s.offset_z, time: now } };
      setSetter(n); saveSetter(n);
    }
    const notFound = R.current.failed || s.xx === "ESTOPPED";
    patch((d) => ({ result: { ...(d.result || {}), setter: ok ? "ok" : notFound ? "notfound" : "fail" }, step: "done" }));
  };

  R.current.finish = finish;
  R.current.finishSetter = finishSetter;

  const saveBall = () => { const b = Math.round(result.ball * 1000) / 1000; patch((d) => ({ p: { ...d.p, ball: b }, calib: false, step: "setup", result: null })); setPrefs({ measure: { ...p, ball: b } }); };

  // Wait for the stylus to be touched before any motion
  const touched = probeActive(state);
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

  if (!D) return null;
  return (
    <Modal title={calib ? "Calibrate the stylus" : "Measure stock"} wide dismissable={false} onClose={stop}
      actions={<>
        {step !== "done" && <button onClick={stop}>Cancel</button>}
        {step === "setup" && <button className="primary" data-autofocus disabled={!p || errs.length > 0} onClick={() => setStep("check")}>Next</button>}
        {step === "place" && <button className="primary" data-autofocus disabled={touched} onClick={start}>{calib ? "Measure the block" : "Measure"}</button>}
        {step === "done" && result?.ok && calib && result.ballOk && <button className="primary" data-autofocus onClick={saveBall}>Save {show(result.ball)} {unit}</button>}
        {step === "done" && <button className={result?.ok && !calib ? "primary" : ""} onClick={done}>Done</button>}
      </>}>
      <div className="probe">
        <ol className="probe-steps" aria-label="Steps">
          <li className="count">Step {list.indexOf(step === "finishing" ? "run" : step) + 1} of {list.length}</li>
          {list.map((s) => <li key={s} className={s === (step === "finishing" ? "run" : step) ? "active" : ""}>{STEPS[s]}</li>)}
        </ol>
        <div className="probe-main">
          {step === "setup" && p && (calib ? <>
            <p>Clamp a block you know the exact width of (a 1-2-3 block, a gauge block, or a part you measured with calipers) with its ends free. The machine touches both ends and works out the effective size of the stylus ball. Work zero is not changed.</p>
            <div className="stack">
              <label className="stack">Exact X width of the block ({unit})
                <SharedText inputMode="decimal" data-autofocus value={form.trueW} onChange={(v) => setForm((f) => ({ ...f, trueW: v }))} /></label>
            </div>
            <p><button onClick={() => setCalib(false)}>Back to measuring</button></p>
          </> : <>
            <p>Measures the top and the real edges of the stock with a 3D touch probe, then sets the work zero. Only the stylus touches the stock; swap to your cutter afterwards and probe Z as usual.</p>
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
          </>)}
          {step === "setup" && errs.length > 0 && p && <ul className="plain err">{errs.map((e) => <li key={e}>{e}</li>)}</ul>}

          {step === "check" && <>
            <p>Put the 3D probe in the collet and plug it in.</p>
            <p><b>Push the stylus sideways with your finger.</b> This step moves on by itself when the controller sees the touch.</p>
            <div className="indet" />
            {touched && !seenOpen ? <p className="err">The probe input already reads as touched. With normally-closed wiring that means the loop is open: plug the probe in (and the setter), or fit the shorting plug.</p>
              : <p className="dim">Nothing happening? Check the probe cable, and that the probe input type under I/O matches your probe (normally open or normally closed).</p>}
          </>}

          {step === "place" && <>
            <p>Jog the stylus over the <b>middle</b> of the {calib ? "block" : "stock"}, about 3 to 15 {metric ? "mm" : "mm (⅛ to ½ in)"} above the top. It doesn't need to be exact.</p>
            <div className="probe-jog">
              <div className="radios inline">Step: {[10, 1].map((v) => <label key={v}><input type="radio" name="mjs" checked={jogStep === v} onChange={() => setJogStep(v)} /> {v} {unit}</label>)}</div>
              <div className="jgrid">
                <span /><button onClick={() => jog("Y", 1)}>Y+ (back)</button><span /><button onClick={() => jog("Z", 1)}>Z+ (up)</button>
                <button onClick={() => jog("X", -1)}>X− (left)</button><span /><button onClick={() => jog("X", 1)}>X+ (right)</button><span />
                <span /><button onClick={() => jog("Y", -1)}>Y− (front)</button><span /><button onClick={() => jog("Z", -1)}>Z− (down)</button>
              </div>
            </div>
            <div className="why"><b>What happens next</b><p>The stylus touches the top, lifts {show(opts.clear, 0)} {unit}, then drops {show(opts.margin, 0)} {unit} outside each {calib || !opts.probeY ? "end" : "edge"} and touches it {show(opts.depth, 0)} {unit} below the top. Any unexpected touch stops it.</p></div>
          </>}

          {step === "setter" && <><p>Touching the tool setter with the probe…</p><div className="indet" /></>}
          {(step === "run" || step === "finishing") && <><p>Measuring…</p><div className="indet" /><p className="dim">Cancel stops the machine.</p></>}

          {step === "done" && result && (result.ok ? (calib ? <>
            <h3>Stylus ball: {show(result.ball)} {unit}</h3>
            {result.ballOk ? <p>Save it to use it for every measurement from now on. Run this again if you change the stylus.</p>
              : <p className="err">That isn't a believable stylus size. Check the width you typed and that the block's ends are square, then try again.</p>}
          </> : <>
            <h3>{show(result.w)}{opts.probeY ? ` × ${show(result.l)}` : ""} {unit}</h3>
            <p>Measured {opts.probeY ? "X × Y" : "X length"}{Number.isFinite(opts.w) ? ` (you typed ${show(opts.w, 2)}${opts.probeY ? ` × ${show(opts.l, 2)}` : ""})` : ""}.</p>
            <p>Zero is set: Z on the top, {origins.find(([v]) => v === opts.origin)?.[1].replace(/ \(.*\)$/, "").toLowerCase()} for {opts.probeY ? "X and Y" : "X (Y not changed)"}. The stylus is parked over it.</p>
            {result.setter === "ok" ? <div className="why"><b>Next: take the probe out</b><p>Put your cutter in, open <b>Tool setter</b> and press <b>Measure tool</b>. Z zero follows the cutter; X and Y stay as measured.</p></div>
              : result.setter ? <div className="why bad"><b>The tool setter reference didn't work</b><p>{result.setter === "notfound" ? "The probe didn't reach the setter and the controller stopped with an E-stop. Check the setter position and cable." : "The setter routine stopped early."} The stock measurement and zero are fine. Put your cutter in and use Probe Z, or fix the setter and take a reference from the Tool setter screen.</p></div>
              : <div className="why"><b>Next: take the probe out</b><p>Put your cutter in and run <b>Probe Z</b>. X and Y stay as measured.</p></div>}
          </>) : <>
            <h3>Stopped</h3>
            {result.fail === "edge" ? <>
              <p>An edge wasn't where it should be, so the controller stopped with an emergency stop. The stock may be smaller than the size you typed, or the touch depth is deeper than the stock is thick.</p>
              <p>Clear the E-stop, then try again.</p>
            </> : <p>{FAILS[result.fail] || "The measurement didn't finish."}</p>}
            <p className="dim">Work zero was not changed.</p>
          </>)}
        </div>
      </div>
    </Modal>
  );
}
