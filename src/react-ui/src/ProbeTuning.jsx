import React, { useEffect, useRef, useState } from "react";
import { Modal } from "./ui.jsx";
import { api } from "./controller.js";
import { computeAxis } from "./axis.js";
import { getPrefs, setPrefs } from "./checkpoint.js";
import { probeActive } from "./setter.js";
import { useProgramRunner, getSetter, saveSetter, setterArgs } from "./ToolSetter.jsx";
import { BLOCKS, squareText } from "./square.js";
import { TUNE, tuneProgram, tuneResults } from "./tune.js";
import { runHomeCheck, homeCheckText, homeCheckDue, travelLim } from "./homecheck.js";
import { StepRail, StepBody, Outcome } from "./steps.jsx";
import { CheckArt } from "./art.jsx";

// Hands-off probe tuning (1.48.0): the stylus calibration 3 times, then the squareness check 3
// times, as one program on the controller (see tune.js). Once Start is pressed nothing needs
// pressing: the homing is checked first if it's due, the 6 runs go one after the other, and the
// results are saved. They're saved by whichever screen is open when it finishes, or the next time
// this or Probe setup is opened, so a phone going to sleep doesn't lose anything.
const STEPS = { setup: "Block", check: "Check probe", place: "Position", run: "Running", done: "Results" };

// Save the results of a finished run that hasn't been saved yet. Returns the record (or null).
export async function savePendingTune(state) {
  const prefs = await getPrefs();
  const t = prefs.tune;
  if (!t || t.saved || state.oft_done !== t.token) return t && t.saved ? t : null;
  const r = tuneResults(state, t);
  const patch = {};
  const now = Date.now();
  if (r.calOk) patch.measure = { ...(prefs.measure || {}), ball: Math.round(r.ball * 1000) / 1000, ballTime: now, ballRuns: TUNE.calRuns, ballBy: "tune" };
  if (r.sqOk) patch.square = { eps: r.avg.eps, deg: r.avg.deg, drift400: r.avg.drift400, spread: r.avg.spread, runs: TUNE.sqRuns, block: t.block, time: now, by: "tune" };
  const rec = { ...t, saved: true, savedAt: now, result: { balls: r.balls, ball: r.ball, calSpread: r.calSpread, calOk: r.calOk, sqOk: r.sqOk, avg: r.avg || null,
    runs: r.square.map((x) => x.drift400), size: r.square[0] ? [r.square[0].w, r.square[0].l] : null, turn: r.square[0]?.turn ?? null, endTurn: r.endTurn, problems: r.problems, ball0: t.ball } };
  await setPrefs({ ...patch, tune: rec });
  return rec;
}

export default function ProbeTuning({ config, state, send, subscribe, metric, onClose }) {
  const [step, setStep] = useState("setup");
  const [blockId, setBlockId] = useState(BLOCKS[0][0]);
  const [prefs, setPrefsState] = useState(null);
  const [seenOpen, setSeenOpen] = useState(false);
  const [msg, setMsg] = useState(null);     // the homing check's line, or why it stopped
  const [rec, setRec] = useState(null);     // saved results
  const [jogStep, setJogStep] = useState(10);
  const run = useProgramRunner(state, subscribe, send);
  const R = useRef({}); R.current.state = state;
  const reload = () => getPrefs().then((p) => { setPrefsState(p); if (p.square?.block) setBlockId(p.square.block); return p; });
  useEffect(() => {
    reload().then((p) => {
      const t = p.tune;
      // A run started earlier (on this screen or another) still going, or finished and not yet saved
      if (t && !t.saved && state.oft_done === t.token) savePendingTune(state).then((r) => { setRec(r); setStep("done"); });
      else if (t && !t.saved && state.cycle !== "idle" && state.oft_run > 0) { R.current.started = true; setStep("run"); }
    }).catch(() => setPrefsState({}));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // The 6-run program has started once the controller leaves idle after it was sent
  useEffect(() => { if (R.current.sent && state.cycle !== "idle") R.current.started = true; }, [state.cycle]);
  // Finished while open: save
  useEffect(() => {
    if (step !== "run" || !prefs?.tune || state.cycle !== "idle" || !R.current.started) return;
    const t = setTimeout(() => {
      const st = R.current.state;
      if (st.cycle !== "idle") return;
      savePendingTune(st).then((r) => { setRec(r || { result: tuneResults(st, prefs.tune), stopped: true }); setStep("done"); reload(); });
    }, 1500);
    return () => clearTimeout(t);
  }, [step, state.cycle, state.oft_done]); // eslint-disable-line react-hooks/exhaustive-deps

  const u = metric ? 1 : 25.4, unit = metric ? "mm" : "in";
  const mm = (v, p = 3) => `${(v / u).toFixed(metric ? p : p + 1)} ${unit}`;
  const blk = BLOCKS.find((b) => b[0] === blockId) || BLOCKS[0];
  const touched = probeActive(state);
  const idle = state.cycle === "idle" && state.xx !== "ESTOPPED";
  const ball0 = Number.isFinite(prefs?.measure?.ball) ? prefs.measure.ball : 2;

  useEffect(() => {
    if (step !== "check") return;
    if (!touched) { if (!seenOpen) setSeenOpen(true); } else if (seenOpen) setStep("place");
  }, [step, touched, seenOpen]);

  const start = async () => {
    setMsg(null); setStep("run"); R.current.sent = false; R.current.started = false;
    // 1. The homing, if it hasn't been checked since the machine was homed (it comes back here)
    const setter = await getSetter();
    if (homeCheckDue(R.current.state, setter)) {
      setMsg({ ok: true, text: "Checking the homing on the tool setter first…" });
      const h = await runHomeCheck({ run, getSetter, saveSetter, args: (x) => setterArgs(R.current.state, config, x, "ref"), state: R.current.state, lim: travelLim(R.current.state, config) });
      if (h.error) { setMsg({ ok: false, text: homeCheckText(h, (v) => mm(v, 2)) }); setStep("done"); return; }
      setMsg({ ok: true, text: homeCheckText(h, (v) => mm(v, 2)) });
      await new Promise((r) => setTimeout(r, 800));
    }
    // 2. All 6 runs as one program, from here
    const st = R.current.state, z = computeAxis(st, config, "z", true);
    const token = (Date.now() % 900000000) + 1000;
    const t = { token, a: blk[2], b: blk[3], block: blockId, ball: ball0, time: Date.now(), saved: false };
    await setPrefs({ tune: t }); setPrefsState((p) => ({ ...(p || {}), tune: t }));
    R.current.sent = true; R.current.started = false;
    send(tuneProgram({ a: blk[2], b: blk[3], ball: ball0, start: { x: st.xp, y: st.yp, z: st.zp }, top: z.max - 1,
      fast: config.probe["probe-fast-seek"], slow: config.probe["probe-slow-seek"], token, measure: prefs?.measure }));
  };
  const stop = () => api.put("stop").catch(() => {});
  const jog = (axis, dir) => send(`G21\nG91 G0 ${axis}${dir * jogStep * u}\nG90\n`);
  const runLabel = (k) => (k >= 1 && k <= 3 ? `Stylus calibration, run ${k} of 3` : k >= 4 && k <= 6 ? `Squareness, run ${k - 3} of 3` : "Starting");

  const r = rec?.result;
  const sq = r?.avg ? squareText(r.avg, (v) => mm(v, 2)) : null;
  return (
    <Modal title="Tune the probe automatically" wide dismissable={step !== "run"} onClose={onClose}
      actions={<>
        {step === "run" ? <button className="danger" onClick={stop}>Stop</button> : <button onClick={onClose}>{step === "done" ? "Close" : "Cancel"}</button>}
        {step === "setup" && <button className="primary" data-autofocus disabled={!prefs} onClick={() => { setSeenOpen(false); setStep("check"); }}>Next</button>}
        {step === "place" && <button className="primary" data-autofocus disabled={touched || !idle} onClick={start}>Start: run all 6</button>}
        {step === "done" && <button onClick={() => { setRec(null); setMsg(null); setStep("place"); }}>Run it again</button>}
      </>}>
      <div className="probe">
        <StepRail steps={Object.keys(STEPS)} labels={STEPS} current={step} />
        <div>
          {step === "setup" && <StepBody title="Put the 1-2-3 block on the bed">
            <p>One start, then hands off: the stylus is calibrated on the block 3 times and the average is saved, then X/Y squareness is measured 3 times and the average is saved. About 6 minutes. If the homing hasn't been checked since the machine was homed, that's done first (about 30 s).</p>
            <p>Lay the block flat, 1 in side up, roughly lined up with X and Y, with about 15 mm clear all round. Wipe it and the bed. It doesn't need clamping.</p>
            <div className="radios">{BLOCKS.map(([id, label]) => <label key={id}><input type="radio" name="tub" checked={blockId === id} onChange={() => setBlockId(id)} /> {label}</label>)}</div>
            <p className="dim">The stylus is calibrated on the block's ends along X ({mm(blk[2], 1)}). The block's turn on the bed is measured by the squareness runs and taken out of the stylus size.</p>
          </StepBody>}
          {step === "check" && <StepBody title="Check the probe" art={<CheckArt probe />}>
            <p>Put the 3D probe in and plug it in. <b>Push the stylus sideways with your finger.</b> This step moves on by itself.</p>
            {touched && !seenOpen && <p className="err">The probe input already reads as touched. Plug the probe in, or fit the shorting plug.</p>}
          </StepBody>}
          {step === "place" && <StepBody title="Position the stylus">
            <p>Jog the stylus over the <b>middle</b> of the block, in the solid gap between the two middle holes, 3 to 10 mm above it. Every run starts from here.</p>
            <div className="probe-jog">
              <div className="radios inline">Step: {[10, 1].map((v) => <label key={v}><input type="radio" name="tujs" checked={jogStep === v} onChange={() => setJogStep(v)} /> {v} {unit}</label>)}</div>
              <div className="jgrid">
                <span /><button onClick={() => jog("Y", 1)}>Y+ (back)</button><span /><button onClick={() => jog("Z", 1)}>Z+ (up)</button>
                <button onClick={() => jog("X", -1)}>X− (left)</button><span /><button onClick={() => jog("X", 1)}>X+ (right)</button><span />
                <span /><button onClick={() => jog("Y", -1)}>Y− (front)</button><span /><button onClick={() => jog("Z", -1)}>Z− (down)</button>
              </div>
            </div>
            <div className="why"><b>Then you can walk away</b><p>It runs on the controller, so this screen can go to sleep. The results are saved when it finishes and shown here and in Probe setup. Any unexpected touch stops it.</p></div>
          </StepBody>}
          {step === "run" && <StepBody title="Running">
            {msg && <p className={msg.ok ? "dim" : "err"}>{msg.text}</p>}
            <p className="big">{state.cycle !== "idle" && state.oft_run > 0 ? runLabel(state.oft_run) : msg ? "" : "Starting…"}</p>
            {state.oft_run > 0 && <div className="tune-runs">{[1, 2, 3, 4, 5, 6].map((k) => <span key={k} className={k < state.oft_run ? "done" : k === state.oft_run ? "on" : ""}>{k <= 3 ? `S${k}` : `Q${k - 3}`}</span>)}</div>}
            <p className="dim">You can leave. Stop here or E-stop ends it.</p>
          </StepBody>}
          {step === "done" && <StepBody>
            {msg && !msg.ok && <Outcome ok={false} title="Stopped before the runs"><p>{msg.text}</p></Outcome>}
            {r && <>
              <Outcome ok={r.calOk && rec.saved} title={r.calOk && rec.saved ? `Stylus ball ${mm(r.ball)} (saved)` : "Stylus calibration not saved"}>
                {r.balls?.length > 0 && <p>Runs: {r.balls.map((b) => mm(b)).join(", ")}; spread {mm(r.calSpread || 0)}. Before: {mm(r.ball0 ?? ball0)}.</p>}
                {r.endTurn !== null && r.endTurn !== undefined && <p className="dim">Corrected for the block's ends being turned {((r.endTurn * 180) / Math.PI).toFixed(2)}° on the bed.</p>}
              </Outcome>
              <Outcome ok={r.sqOk && rec.saved} title={r.sqOk && rec.saved && sq ? `Squareness ${sq.head} (saved)` : "Squareness not saved"}>
                {sq && <><p><b>{sq.verdict}</b></p><p>{sq.detail}</p></>}
                {r.runs?.length > 0 && <p>Runs: {r.runs.map((x) => (x / u).toFixed(metric ? 2 : 4)).join(", ")} {unit} over 400 mm.</p>}
                {r.size && <p className="dim">Block measured {mm(r.size[0], 2)} × {mm(r.size[1], 2)} (true {mm(blk[2], 2)} × {mm(blk[3], 2)}).</p>}
              </Outcome>
              {r.problems?.length > 0 && <div className="why bad"><b>Problems</b>{r.problems.map((p, i) => <p key={i}>{p}</p>)}</div>}
            </>}
            {!r && !msg && <p>Nothing finished. If the machine E-stopped, the banner at the top says why.</p>}
            {rec?.stopped && <p className="err">It didn't run to the end, so nothing was saved. The banner or the problems above say why.</p>}
          </StepBody>}
        </div>
      </div>
    </Modal>
  );
}
