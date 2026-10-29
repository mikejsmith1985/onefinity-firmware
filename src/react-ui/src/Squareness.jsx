import React, { useEffect, useMemo, useState } from "react";
import { Modal } from "./ui.jsx";
import { api } from "./controller.js";
import { computeAxis } from "./axis.js";
import { getPrefs, setPrefs } from "./checkpoint.js";
import { probeActive } from "./setter.js";
import { useProgramRunner } from "./ToolSetter.jsx";
import { BLOCKS, squareProgram, squareResult, squareAverage, squareText } from "./square.js";
import { programMoves, moveStatus } from "./progress.js";
import { StepRail, StepBody, RunProgress, Outcome, useRunStep } from "./steps.jsx";
import { CheckArt } from "./art.jsx";

// Squareness check (1.43.0): a 1-2-3 block on the bed, the probe touches all four sides at two
// points each, and the angle between them says how square X is to Y. See square.js.
const STEPS = { setup: "Block", check: "Check probe", place: "Position", run: "Measure", done: "Result" };

export default function Squareness({ config, state, send, subscribe, metric, onClose }) {
  const [step, setStep] = useState("setup");
  const [blockId, setBlockId] = useState(BLOCKS[0][0]);
  const [ball, setBall] = useState(null);       // calibrated stylus ball, from Measure stock
  const [saved, setSaved] = useState(null);     // the last saved result
  const [seenOpen, setSeenOpen] = useState(false);
  const [runs, setRuns] = useState([]);
  const [err, setErr] = useState(null);
  const [runAt, setRunAt] = useState(null);
  const [jogStep, setJogStep] = useState(10);
  const run = useProgramRunner(state, subscribe, send);
  useEffect(() => { getPrefs().then((p) => { setBall(Number.isFinite(p.measure?.ball) ? p.measure.ball : 2); setSaved(p.square || null); if (p.square?.block) setBlockId(p.square.block); }).catch(() => setBall(2)); }, []);

  const u = metric ? 1 : 25.4, unit = metric ? "mm" : "in";
  const mm = (v) => `${(v / u).toFixed(metric ? 2 : 4)} ${unit}`;
  const blk = BLOCKS.find((b) => b[0] === blockId) || BLOCKS[0];
  const touched = probeActive(state);
  const idle = state.cycle === "idle" && state.xx !== "ESTOPPED";
  const opts = useMemo(() => {
    if (!config || ball === null) return null;
    const z = computeAxis(state, config, "z", true);
    return { a: blk[2], b: blk[3], ball, top: z.max - 1, fast: config.probe["probe-fast-seek"], slow: config.probe["probe-slow-seek"] };
  }, [config, ball, blockId]); // eslint-disable-line react-hooks/exhaustive-deps
  const moves = useMemo(() => { try { return opts ? programMoves(squareProgram(opts)) : []; } catch { return []; } }, [opts]);
  const runStep = useRunStep(state.of_step, step === "run" && runAt ? `square:${runAt}` : null);

  // The probe check moves on when the stylus is pushed (seen open first)
  useEffect(() => {
    if (step !== "check") return;
    if (!touched) { if (!seenOpen) setSeenOpen(true); } else if (seenOpen) setStep("place");
  }, [step, touched, seenOpen]);

  const start = async () => {
    setErr(null); setStep("run"); setRunAt(Date.now());
    const r = await run(squareProgram(opts));
    if (r.estop || r.notFound) { setErr(r.notFound ? "A touch found nothing, so the controller stopped with an E-stop. Check the block size you picked and that the stylus started over the middle of the block. Clear the E-stop and try again." : "Stopped by the E-stop."); setStep("done"); return; }
    const res = squareResult(r, opts);
    if (res.error) { setErr(res.error); setStep("done"); return; }
    setRuns((x) => [...x, res]); setStep("done");
  };
  const avg = runs.length ? squareAverage(runs) : null;
  const words = avg ? squareText(avg, mm) : null;
  const last = runs[runs.length - 1];
  const save = () => {
    const rec = { eps: avg.eps, deg: avg.deg, drift400: avg.drift400, spread: avg.spread, runs: runs.length, block: blockId, time: Date.now() };
    setPrefs({ square: rec }).then(() => setSaved(rec)).catch(() => {});
  };
  const jog = (axis, dir) => send(`G21\nG91 G0 ${axis}${dir * jogStep * u}\nG90\n`);
  const close = () => { if (step === "run") api.put("stop").catch(() => {}); onClose && onClose(); };

  return (
    <Modal title="Check X/Y squareness" wide dismissable={step !== "run"} onClose={close}
      actions={<>
        <button className={step === "run" ? "danger" : ""} onClick={close}>{step === "run" ? "Stop" : step === "done" ? "Close" : "Cancel"}</button>
        {step === "setup" && <button className="primary" data-autofocus disabled={!opts} onClick={() => { setSeenOpen(false); setStep("check"); }}>Next</button>}
        {step === "place" && <button className="primary" data-autofocus disabled={touched || !idle || !opts} onClick={start}>Start measuring</button>}
        {step === "done" && <button onClick={() => { setErr(null); setStep("place"); }}>Measure again</button>}
        {step === "done" && avg && runs.length >= 3 && <button className="primary" onClick={save} disabled={saved && saved.time && saved.runs === runs.length && Math.abs(saved.eps - avg.eps) < 1e-12}>Save the result</button>}
      </>}>
      <div className="probe">
        <StepRail steps={Object.keys(STEPS)} labels={STEPS} current={step} />
        <div>
          {step === "setup" && <StepBody title="Put the block on the bed">
            <p>Lay a 1-2-3 block flat on a clean part of the bed, its sides roughly lined up with X and Y (a few degrees off is fine). Leave about 15 mm clear all round it. It doesn't need clamping: the touches are light. Wipe the block and the bed first, since a chip under a touch shows up as an error.</p>
            <div className="radios">{BLOCKS.map(([id, label]) => <label key={id}><input type="radio" name="sqb" checked={blockId === id} onChange={() => setBlockId(id)} /> {label}</label>)}</div>
            <p className="dim">The block's own corners are square to a few ten-thousandths of an inch, far closer than the machine. Turning it on the bed doesn't change the result: only the angle between its sides counts.</p>
            {ball === 2 && <p className="err">The stylus hasn't been calibrated (Probe setup → Calibrate the stylus). The squareness is still right; only the block size it reports is off.</p>}
            {saved && <p className="dim">Last saved {new Date(saved.time).toLocaleDateString()}: {squareText(saved, mm).head}. {squareText(saved, mm).verdict}</p>}
          </StepBody>}
          {step === "check" && <StepBody title="Check the probe" art={<CheckArt probe />}>
            <p>Put the 3D probe in the collet and plug it in.</p>
            <p><b>Push the stylus sideways with your finger.</b> This step moves on by itself when the controller sees the touch.</p>
            {touched && !seenOpen && <p className="err">The probe input already reads as touched. Plug the probe in (and the setter), or fit the shorting plug.</p>}
          </StepBody>}
          {step === "place" && <StepBody title="Position the stylus">
            <p>Jog the stylus over the <b>middle</b> of the block, within about 5 mm, and 3 to 10 mm above it.</p>
            <div className="probe-jog">
              <div className="radios inline">Step: {[10, 1].map((v) => <label key={v}><input type="radio" name="sqjs" checked={jogStep === v} onChange={() => setJogStep(v)} /> {v} {unit}</label>)}</div>
              <div className="jgrid">
                <span /><button onClick={() => jog("Y", 1)}>Y+ (back)</button><span /><button onClick={() => jog("Z", 1)}>Z+ (up)</button>
                <button onClick={() => jog("X", -1)}>X− (left)</button><span /><button onClick={() => jog("X", 1)}>X+ (right)</button><span />
                <span /><button onClick={() => jog("Y", -1)}>Y− (front)</button><span /><button onClick={() => jog("Z", -1)}>Z− (down)</button>
              </div>
            </div>
            <div className="why"><b>What happens next</b><p>The stylus touches the top, then drops beside each of the four sides and touches it at two points, 4 mm below the top. Any unexpected touch stops it. About a minute. Run it 3 times without moving the block; the average is what counts.</p></div>
          </StepBody>}
          {step === "run" && <StepBody title="Measuring">
            <RunProgress title="Squareness" moves={moves} step={runStep} started={state.cycle !== "idle"} />
          </StepBody>}
          {step === "done" && <StepBody>
            {err ? <Outcome ok={false} title="Stopped"><p>{err}</p></Outcome>
              : avg && <Outcome ok title={`${words.head}${runs.length > 1 ? ` (average of ${runs.length})` : ""}`}>
                <p><b>{words.verdict}</b></p>
                <p>{words.detail}</p>
                {runs.length > 1 && <p>Runs: {runs.map((x) => (x.drift400 / u).toFixed(metric ? 2 : 4)).join(", ")} {unit} over 400 mm; spread {mm(avg.spread)}.</p>}
                {avg.spread > 0.15 && <p className="err">The runs differ by more than {mm(0.15)}. Check the block hasn't moved and nothing is on it, then measure again.</p>}
                {runs.length < 3 && <p>Measure again {3 - runs.length === 1 ? "once more" : "twice more"} without moving the block. One run can be off by up to about {mm(0.1)} over 400 mm; the average of 3 is the result to go by.</p>}
                {last && <p className="dim">Block measured {mm(last.w)} × {mm(last.l)} (true {mm(blk[2])} × {mm(blk[3])}), turned {last.turn.toFixed(2)}° on the bed.</p>}
              </Outcome>}
          </StepBody>}
        </div>
      </div>
    </Modal>
  );
}
