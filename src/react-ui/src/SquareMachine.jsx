import React, { useEffect, useRef, useState } from "react";
import { Modal, PadInput, NumPad } from "./ui.jsx";
import { api } from "./controller.js";
import { getPrefs, setPrefs } from "./checkpoint.js";
import { squareText } from "./square.js";
import { StepRail, StepBody, Outcome } from "./steps.jsx";
import { FEET, frameSkew, frameFix, verdict, probeNext, moveParts, MOVE_DIRS, CHECK_NOISE } from "./squaring.js";

// Square the machine (1.53.0): a guided walk through squaring the frame and the gantry, ending
// with the Squareness check. Nothing here homes or probes by itself except the Home button on the
// "Home" step; the measuring is the existing Squareness check (Squareness.jsx), opened as a step.
//
// Where the steps come from:
//  - Seating the gantry (loosen the 8 X-rail bolts with the machine off, power on, don't home,
//    jog Y forward until both sides sit against the front feet, tighten, restart) is Onefinity's
//    method, posted by the Onefinity CNC Official account on their forum (Oct 2022).
//  - Squaring the frame first (gantry sets the rail spacing, equal diagonals, feet flat) is what
//    Onefinity owners describe on the same forum; the gantry seating only lines the gantry up with
//    the front feet, so the feet have to be a rectangle first.
//  - How far to move the feet is worked out from the diagonals you type in (squaring.js).
//
// 1.54.0: after a check that isn't square, "Correct it with the feet" turns the reading into a
// foot move and runs a round: move the feet, reseat the gantry, home, check. The first round moves
// half the amount either way; each later round learns which way and how much from the one before
// (squaring.js probeNext). Rounds are kept in prefs.squaring.rounds.
//
// Progress is kept in prefs.squaring, so the wizard picks up where it was after the controller has
// been turned off (one of the steps asks for that).

const ALL = ["start", "loosen", "spacing", "diag", "flat", "bolts", "seat", "tighten", "home", "check"];
const GANTRY = ["start", "bolts", "seat", "tighten", "home", "check"];
const ROUND = ["bolts", "fix", "seat", "tighten", "home", "check"];   // gantry loose before the feet move
const LABELS = { start: "Start", loosen: "Loosen feet", spacing: "Rail spacing", diag: "Diagonals", flat: "Feet down",
  fix: "Move the feet", bolts: "Gantry bolts", seat: "Seat gantry", tighten: "Tighten", home: "Home", check: "Check" };

export async function squaringStatus() {
  const p = await getPrefs().catch(() => ({}));
  return p.squaring || null;
}

export default function SquareMachine({ state, send, metric, onOpen, onClose }) {
  const [d, setD] = useState(null);           // prefs.squaring
  const [square, setSquare] = useState(null); // prefs.square (the last saved Squareness result)
  const [ab, setAb] = useState(null);         // /api/abcard, for the restart warning
  const [jogStep, setJogStep] = useState(10);
  const [homeErr, setHomeErr] = useState("");
  const [pad, setPad] = useState(null);        // 1.54.1: which number box shows its keypad
  const saveTimer = useRef(null);
  const u = metric ? 1 : 25.4, unit = metric ? "mm" : "in";
  const mm = (v) => `${(v / u).toFixed(metric ? 2 : 3)} ${unit}`;

  useEffect(() => {
    getPrefs().then((p) => { setSquare(p.square || null); setD(p.squaring && p.squaring.step && !p.squaring.finished ? p.squaring : fresh()); })
      .catch(() => setD(fresh()));
    api.get("abcard").then(setAb).catch(() => setAb(null));
  }, []);

  // 1.54.0: a round's check result goes into the round once it's there
  useEffect(() => {
    if (!d || !d.fixing || !square || !(d.rounds || []).length) return;
    const rs = d.rounds, last = rs[rs.length - 1];
    if (Number.isFinite(last.after) || !(square.time > last.time)) return;
    const nd = { ...d, fixing: false, rounds: [...rs.slice(0, -1), { ...last, after: square.drift400, afterTime: square.time }] };
    setD(nd); setPrefs({ squaring: nd }).catch(() => {});
  }, [d, square]);

  if (!d) return null;
  const steps = d.fixing ? ROUND : d.mode === "gantry" ? GANTRY : ALL;
  const step = steps.includes(d.step) ? d.step : "start";
  // Typing saves on every key; the controller copy is written once the keys stop (1.54.1)
  const save = (patch) => {
    const nd = { ...d, ...patch, saved: Date.now() }; setD(nd);
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => setPrefs({ squaring: nd }).catch(() => {}), "read" in patch || "fixPlan" in patch ? 400 : 0);
  };
  const go = (s) => save({ step: s });
  const next = () => go(steps[Math.min(steps.indexOf(step) + 1, steps.length - 1)]);
  const back = () => go(steps[Math.max(steps.indexOf(step) - 1, 0)]);

  const mach = state.xx;
  const idle = state.cycle === "idle" && mach !== "ESTOPPED";
  const homing = mach === "HOMING";
  const jog = (axis, dir, feed) => send(`G21\nG91 G1 ${axis}${(dir * jogStep * u).toFixed(4)} F${feed || 1500}\nG90\n`);
  const trial = ab && ab.ab && ab.trial ? ab : null;

  const r = d.read || {};
  const num = (k) => { const v = parseFloat(String(r[k] ?? "").replace(",", ".")); return Number.isFinite(v) ? v * u : NaN; };
  const skew = frameSkew({ w: num("w"), da: num("da"), db: num("db"), front: num("front"), back: num("back") });
  const fix = frameFix(skew, d.locked);
  const setRead = (k, v) => save({ read: { ...r, [k]: v } });
  const lockedName = (FEET.find((f) => f[0] === d.locked) || FEET[0])[1].toLowerCase();

  const rounds = d.rounds || [];
  // While a round waits for its check, the older result doesn't count
  const waiting = d.fixing && rounds.length ? rounds[rounds.length - 1].time : 0;
  const after = square && d.started && square.time > d.started && square.time > waiting ? square : null;
  const parts = moveParts(d.locked);
  const fp = d.fixPlan || { method: "rail", dim: { rail: r.w || "", pair: "" }, dir: null };
  const dimTxt = (fp.dim || {})[fp.method] ?? "";
  const dimMm = (() => { const v = parseFloat(String(dimTxt).replace(",", ".")); return Number.isFinite(v) ? v * u : NaN; })();
  const plan = after ? probeNext(after.drift400, rounds, fp.method, dimMm) : null;
  const planDir = plan ? (plan.learned ? plan.dir : fp.dir) : null;
  const setPlan = (patch) => save({ fixPlan: { ...fp, ...patch } });
  const moveWords = (rd) => `${rd.method === "rail" ? `the ${moveParts(d.locked).rail} rail` : `the ${moveParts(d.locked).pair} pair`} ${mm(rd.by)} ${MOVE_DIRS[rd.method][rd.dir]}`;
  const startRound = () => save({ fixing: true, step: "bolts", seated: false, homedOk: false,
    rounds: [...rounds, { method: fp.method, dim: dimMm, by: plan.by, dir: planDir, before: after.drift400, time: Date.now() }] });
  const cur = d.fixing ? rounds[rounds.length - 1] : null;
  const finish = () => { setPrefs({ squaring: { ...d, finished: Date.now(), result: after ? after.drift400 : null } }).catch(() => {}); onClose && onClose(); };

  const jogPad = (yOnly, seat) => (
    <div className="probe-jog">
      <div className="radios inline">Step: {(seat ? [1, 5] : [50, 10, 1]).map((v) => <label key={v}><input type="radio" name="smjs" checked={jogStep === v} onChange={() => setJogStep(v)} /> {v} {unit}</label>)}</div>
      <div className="jgrid">
        <span /><button disabled={!idle || seat} onClick={() => jog("Y", 1)}>Y+ (back)</button><span /><span />
        {yOnly ? <><span /><span /><span /><span /></> : <><button disabled={!idle} onClick={() => jog("X", -1)}>X− (left)</button><span /><button disabled={!idle} onClick={() => jog("X", 1)}>X+ (right)</button><span /></>}
        <span /><button disabled={!idle} onClick={() => jog("Y", -1, seat ? 300 : undefined)}>Y− (front)</button><span /><span />
      </div>
    </div>
  );

  const warnRestart = trial && <p className="err">This controller is running slot {trial.running.toUpperCase()} on trial. Turning it off or restarting starts slot {trial.default.toUpperCase()} instead, which may not have this screen. Keep slot {trial.running.toUpperCase()} first (Admin → SD card → Keep), then come back here.</p>;

  return (
    <Modal title="Square the machine" wide onClose={onClose}
      actions={<>
        <button onClick={onClose}>{step === "check" && after ? "Close" : "Close (keeps your place)"}</button>
        {step !== "start" && !(d.fixing && step === "bolts") && <button onClick={back}>Back</button>}
        {d.fixing && (step === "bolts" || step === "fix") && <button onClick={() => save({ fixing: false, step: "check", rounds: rounds.slice(0, -1) })}>Cancel this round</button>}
        {step === "fix" && <button className="primary" data-autofocus disabled={!d.movedOk} onClick={() => save({ step: "seat", movedOk: false })}>Next</button>}
        {step === "start" && <button className="primary" data-autofocus onClick={() => save({ step: steps[1], started: Date.now(), before: square ? { drift400: square.drift400, time: square.time } : null })}>Start</button>}
        {["loosen", "spacing", "flat", "bolts", "tighten"].includes(step) && <button className="primary" data-autofocus disabled={(step === "loosen" && !d.locked) || (step === "flat" && !d.flatOk)} onClick={next}>Next</button>}
        {step === "diag" && <button className="primary" disabled={!skew} onClick={() => { save({ history: [...(d.history || []), { ...r, per400: skew.per400, time: Date.now() }].slice(-10) }); }}>Save this reading</button>}
        {step === "diag" && <button className={skew && verdict(skew.per400) === "square" ? "primary" : ""} disabled={!skew} onClick={next}>Next</button>}
        {step === "seat" && <button className="primary" disabled={!d.seated} onClick={next}>Next</button>}
        {step === "home" && <button className="primary" disabled={!d.homedOk} onClick={next}>Next</button>}
        {step === "check" && <button className="primary" onClick={finish}>Finish</button>}
      </>}>
      <div className="probe">
        <StepRail steps={steps} labels={LABELS} current={step} />
        <div>
          {step === "start" && <StepBody title="Square the frame and the gantry">
            <p>This walks through squaring the machine, then checks the result with the 1-2-3 block. Your place is kept, even when the controller is turned off part way.</p>
            <div className="radios">
              <label><input type="radio" name="smmode" checked={d.mode !== "gantry"} onChange={() => save({ mode: "full" })} /> The frame and the gantry (feet loosened and moved)</label>
              <label><input type="radio" name="smmode" checked={d.mode === "gantry"} onChange={() => save({ mode: "gantry" })} /> The gantry only (the feet stay as they are)</label>
            </div>
            <div className="why"><b>You need</b><p>Wrenches for the feet and for the 8 bolts holding the X rail to the Y carriages. A long tape, or better a bar gauge, for the diagonals. A 1-2-3 block and the 3D probe for the check at the end.</p></div>
            <div className="why bad"><b>Don't home while the feet are loose</b><p>Homing drives each Y side against its front foot and would push a loose foot. Use the jog buttons in this screen until the Home step. With the machine not homed there are no soft limits, so jog in short steps near the ends.</p></div>
            {square && <p className="dim">Last Squareness check ({new Date(square.time).toLocaleDateString()}): {squareText(square, mm).head}. {squareText(square, mm).verdict}</p>}
          </StepBody>}

          {step === "loosen" && <StepBody title="Lock one foot, loosen the others">
            <p>Leave one foot tight: everything else is set from it. Loosen the other three just enough that a foot slides when tapped.</p>
            <div className="radios">{FEET.map(([id, name]) => <label key={id}><input type="radio" name="smlock" checked={d.locked === id} onChange={() => save({ locked: id })} /> {name} stays tight</label>)}</div>
          </StepBody>}

          {step === "spacing" && <StepBody title="Let the gantry set the rail spacing">
            <p>The gantry's carriages are a fixed distance apart, so they set the spacing of the rails:</p>
            <ol>
              <li>Jog the gantry slowly to the <b>back</b>, stopping just short of the back feet. Snug the back feet (not fully tight).</li>
              <li>Jog it to the <b>front</b>, just short of the front feet. Snug the loose front foot.</li>
              <li>Run the whole length a couple of times. It should move evenly, with no tight spot.</li>
            </ol>
            {jogPad(true, false)}
          </StepBody>}

          {step === "diag" && <StepBody title="Measure the diagonals">
            <p>Measure where the rail shafts go into the feet, the same point on every foot. A bar gauge (or two clamped rulers) repeats better than a tape. All in {unit}.</p>
            <div className="rform">
              <label>Rail spacing, centre to centre <PadInput aria-label="Rail spacing, centre to centre" value={r.w || ""} onChange={(v) => setRead("w", v)} open={pad === "w"} onOpen={() => setPad("w")} onClose={() => setPad(null)} /></label>
              {pad === "w" && <NumPad value={r.w || ""} onChange={(v) => setRead("w", v)} onDone={() => { setPad(null); document.activeElement && document.activeElement.blur && document.activeElement.blur(); }} />}
              <label>Diagonal front-left → back-right <PadInput aria-label="Diagonal front-left → back-right" value={r.da || ""} onChange={(v) => setRead("da", v)} open={pad === "da"} onOpen={() => setPad("da")} onClose={() => setPad(null)} /></label>
              {pad === "da" && <NumPad value={r.da || ""} onChange={(v) => setRead("da", v)} onDone={() => { setPad(null); document.activeElement && document.activeElement.blur && document.activeElement.blur(); }} />}
              <label>Diagonal front-right → back-left <PadInput aria-label="Diagonal front-right → back-left" value={r.db || ""} onChange={(v) => setRead("db", v)} open={pad === "db"} onOpen={() => setPad("db")} onClose={() => setPad(null)} /></label>
              {pad === "db" && <NumPad value={r.db || ""} onChange={(v) => setRead("db", v)} onDone={() => { setPad(null); document.activeElement && document.activeElement.blur && document.activeElement.blur(); }} />}
              <label>Spacing at the front (optional) <PadInput aria-label="Spacing at the front (optional)" value={r.front || ""} onChange={(v) => setRead("front", v)} open={pad === "front"} onOpen={() => setPad("front")} onClose={() => setPad(null)} /></label>
              {pad === "front" && <NumPad value={r.front || ""} onChange={(v) => setRead("front", v)} onDone={() => { setPad(null); document.activeElement && document.activeElement.blur && document.activeElement.blur(); }} />}
              <label>Spacing at the back (optional) <PadInput aria-label="Spacing at the back (optional)" value={r.back || ""} onChange={(v) => setRead("back", v)} open={pad === "back"} onOpen={() => setPad("back")} onClose={() => setPad(null)} /></label>
              {pad === "back" && <NumPad value={r.back || ""} onChange={(v) => setRead("back", v)} onDone={() => { setPad(null); document.activeElement && document.activeElement.blur && document.activeElement.blur(); }} />}
            </div>
            {skew && <Outcome ok={verdict(skew.per400) === "square"} title={`${mm(Math.abs(skew.per400))} over 400 mm from the frame`}>
              {verdict(skew.per400) === "square" ? <p><b>The diagonals match closely enough.</b> Go on to putting the feet down.</p>
                : <p><b>Move the {fix.pair} pair of feet {mm(fix.by)} to the {fix.dir}</b>, both by the same amount so the spacing stays the same (the {lockedName} foot stays where it is). Then measure again.</p>}
              <p className="dim">The frame is {mm(skew.len)} long. A 1 mm misread on one diagonal changes the move by about {mm(skew.misread)}, so measure each diagonal twice.</p>
              {Number.isFinite(skew.taper) && <p className={Math.abs(skew.taper) > 0 ? "err" : "dim"}>{Math.abs(skew.taper) > 0 ? `The spacing differs by ${mm(Math.abs(skew.taper))} between front and back. The rails should be the same distance apart at both ends: if that's more than you can read on your tape or gauge, go back to Rail spacing first.` : "Same spacing at the front and the back."}</p>}
            </Outcome>}
            {!skew && (r.w || r.da || r.db) && <p className="dim">Fill in the spacing and both diagonals.</p>}
            {(d.history || []).length > 0 && <p className="dim">Saved readings: {(d.history || []).map((h) => `${(Math.abs(h.per400) / u).toFixed(metric ? 2 : 3)}`).join(", ")} {unit} over 400 mm.</p>}
          </StepBody>}

          {step === "flat" && <StepBody title="Feet down flat, then tighten">
            <ol>
              <li>Check that each foot sits flat: no gap under any of them (a feeler gauge finds it). Shim a gap rather than letting the bolt pull the foot down, which twists the frame.</li>
              <li>Tighten the feet a little at a time, going round all of them.</li>
              <li>Measure the diagonals once more (Back), since tightening can move a foot.</li>
            </ol>
            <label className="check"><input type="checkbox" checked={!!d.flatOk} onChange={(e) => save({ flatOk: e.target.checked })} /> The feet are flat and tight, and the diagonals still match</label>
          </StepBody>}

          {step === "fix" && cur && <StepBody title={`Round ${rounds.length}: move the feet`}>
            <p className="big">Move {moveWords(cur)}.</p>
            <ol>
              {cur.method === "rail"
                ? <li>Loosen both {parts.rail} feet. Slide the whole {parts.rail} rail along its length, both feet by the same amount, so its spacing from the other rail stays the same.</li>
                : <li>Loosen both {parts.pair} feet. Move them sideways together, by the same amount, so the rail spacing stays the same.</li>}
              <li>To move a foot a measured amount: clamp a scrap block against it on the side it's moving toward, with a feeler gauge (or the calipers' depth rod set to the amount) between them. Take the gauge out and tap the foot over until it touches the block. Moving away from the block: put the gauge in and push the foot back against it.</li>
              <li>Feet flat, then tighten them a little at a time. Keep the blocks in place while tightening, so the feet can't creep.</li>
            </ol>
            <p className="dim">The gantry bolts are loose, so the gantry doesn't fight the move. It's seated against the front feet again next.</p>
            <label className="check"><input type="checkbox" checked={!!d.movedOk} onChange={(e) => save({ movedOk: e.target.checked })} /> Moved and tightened</label>
          </StepBody>}

          {step === "bolts" && <StepBody title="Loosen the gantry bolts">
            <ol>
              <li><b>Turn the controller off.</b></li>
              <li>Loosen the 8 bolts that hold the X rail (the gantry) to the two Y carriages, enough for the gantry to shift.</li>
              <li>Turn the controller back on. <b>Don't home.</b> Open Probe setup → Square the machine again: it comes back at the next step.</li>
            </ol>
            {warnRestart}
          </StepBody>}

          {step === "seat" && <StepBody title="Seat both sides against the front feet">
            <p><b>Don't home.</b> Jog Y− (toward the front) in small steps until <b>both</b> sides of the gantry are against their front feet, and keep going a little so they stay there. The motors may grind against the stops; Onefinity says this does no harm.</p>
            {jogPad(true, true)}
            <label className="check"><input type="checkbox" checked={!!d.seated} onChange={(e) => save({ seated: e.target.checked })} /> Both sides are against the front feet</label>
          </StepBody>}

          {step === "tighten" && <StepBody title="Tighten the gantry bolts, then restart">
            <ol>
              <li>With both sides still against the front feet, tighten the 8 bolts.</li>
              <li>Restart the controller (Onefinity's step: the motors lost their place against the stops). This screen comes back at Home.</li>
            </ol>
            {warnRestart}
            <button disabled={!!trial} onClick={() => { save({ step: "home" }); api.put("reboot").catch(() => {}); }}>Restart the controller now</button>
          </StepBody>}

          {step === "home" && <StepBody title="Home, and watch the Y sides">
            <p>Home the machine. Watch both Y sides: each should drive all the way to its front foot and stop there. One side stopping short means it isn't squaring against its foot.</p>
            <button className="primary" disabled={homing || !idle} onClick={() => { setHomeErr(""); api.put("home").catch((e) => setHomeErr(String(e.message || e))); }}>{homing ? "Homing…" : "Home all"}</button>
            {homeErr && <p className="err">{homeErr}</p>}
            {mach === "ESTOPPED" && <p className="err">Clear the E-stop first.</p>}
            <label className="check"><input type="checkbox" checked={!!d.homedOk} onChange={(e) => save({ homedOk: e.target.checked })} /> Both Y sides stopped against their front feet</label>
          </StepBody>}

          {step === "check" && <StepBody title="Check with the 1-2-3 block">
            <p>Run the Squareness check 3 times and save the average. This screen comes back with the result.</p>
            <button className={after ? "" : "primary"} onClick={() => onOpen({ kind: "square" })}>Check squareness</button>
            {after && <Outcome ok={verdict(after.drift400) !== "out"} title={`Now ${squareText(after, mm).head}`}>
              <p><b>{squareText(after, mm).verdict}</b></p>
              {d.before && <p>Before: {mm(Math.abs(d.before.drift400))} over 400 mm.</p>}
              {rounds.filter((x) => Number.isFinite(x.after)).length > 0 && <div className="dim">{rounds.filter((x) => Number.isFinite(x.after)).map((x, i) =>
                <p key={i}>Round {i + 1}: moved {moveWords(x)}: {mm(Math.abs(x.before))} → {mm(Math.abs(x.after))} over 400 mm.</p>)}</div>}
              <div className="radios inline">
                <button onClick={() => save({ step: "bolts", seated: false, homedOk: false })}>Seat the gantry again</button>
                {d.mode !== "gantry" && <button onClick={() => save({ step: "spacing", flatOk: false, seated: false, homedOk: false })}>Go back over the frame</button>}
              </div>
            </Outcome>}
            {after && verdict(after.drift400) !== "square" && <div className="why">
              <b>Correct it with the feet</b>
              <p>The probe reads far finer than a tape. Its result can be turned into a foot move: move the feet, reseat the gantry, home and check again. {d.locked ? `The ${(FEET.find((f) => f[0] === d.locked) || FEET[0])[1].toLowerCase()} foot stays where it is.` : ""}</p>
              {!d.locked && <div className="radios inline">Which foot stays put? {FEET.map(([id, name]) => <label key={id}><input type="radio" name="smlock2" checked={d.locked === id} onChange={() => save({ locked: id })} /> {name}</label>)}</div>}
              <div className="radios">
                <label><input type="radio" name="smmeth" checked={fp.method === "rail"} onChange={() => setPlan({ method: "rail" })} /> Slide the {parts.rail} rail along its length (both {parts.rail} feet): the smaller move, and the machine stays lined up with the table</label>
                <label><input type="radio" name="smmeth" checked={fp.method === "pair"} onChange={() => setPlan({ method: "pair" })} /> Move the {parts.pair} pair of feet sideways</label>
              </div>
              <div className="rform">
                <label>{fp.method === "rail" ? "Rail spacing, centre to centre" : "Frame length, front feet to back feet"} ({unit}) <PadInput value={dimTxt} onChange={(v) => setPlan({ dim: { ...(fp.dim || {}), [fp.method]: v } })} open={pad === "dim"} onOpen={() => setPad("dim")} onClose={() => setPad(null)} /></label>
                {pad === "dim" && <NumPad value={dimTxt} onChange={(v) => setPlan({ dim: { ...(fp.dim || {}), [fp.method]: v } })} onDone={() => { setPad(null); document.activeElement && document.activeElement.blur && document.activeElement.blur(); }} />}
              </div>
              {plan && (plan.learned
                ? <p>Move <b>{fp.method === "rail" ? `the ${parts.rail} rail` : `the ${parts.pair} pair`} {mm(plan.by)} {MOVE_DIRS[fp.method][plan.dir]}</b>. Worked out from round {rounds.indexOf(plan.from) + 1}, where moving {mm(plan.from.by)} changed the reading by {mm(Math.abs(plan.from.after - plan.from.before))} over 400 mm.</p>
                : <><p>Move <b>{mm(plan.by)}</b>: half of what the geometry gives ({mm(plan.geo)}), because which way is right isn't known yet. The next check shows it: if the error shrinks, that was the way; if it grows, the next round goes back the other way.</p>
                  <div className="radios inline">Which way: {MOVE_DIRS[fp.method].map((w, i) => <label key={i}><input type="radio" name="smdir" checked={fp.dir === i} onChange={() => setPlan({ dir: i })} /> {w}</label>)}</div></>)}
              {plan && plan.small && <p className="err">The last round changed the reading by less than the check repeats to ({mm(CHECK_NOISE)} over 400 mm), so it can't tell which way works. This round uses the geometry again; measure the move carefully.</p>}
              {plan && plan.learned && plan.odd && <p className="err">This is far from what the geometry gives ({mm(plan.geo)}). A foot may have moved while tightening, or the check moved. Consider half of it.</p>}
              {plan && plan.by < 0.02 && <p className="dim">The move is too small to make by hand.</p>}
              <button className="primary" disabled={!plan || planDir === null || planDir === undefined || plan.by < 0.02} onClick={startRound}>Start round {rounds.length + 1}</button>
            </div>}
          </StepBody>}
        </div>
      </div>
    </Modal>
  );
}

function fresh() {
  return { step: "start", mode: "full", locked: null, read: {}, history: [] };
}
