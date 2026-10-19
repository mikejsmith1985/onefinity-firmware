import { remotePut } from "./store.js";
import { ME, useUi, useDriver, uiGet, uiCas, uiUpdate, uiPatch, uiClose, loadPrefs, getPref, setPref } from "./shared.js";
import { probeActive } from "./setter.js";
import { parseDia, normDia, probeProgram, centerSecondProgram, newToken, failText } from "./probe.js";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { api } from "./controller.js";
import { Modal, SharedText } from "./ui.jsx";
import BitDiameter from "./svgs/probe-bit-diameter.svg?raw";
import CheckXYZ from "./svgs/probe-check-xyz.svg?raw";
import CheckZ from "./svgs/probe-check-z.svg?raw";
import PlaceXYZ from "./svgs/probe-place-xyz.svg?raw";
import PlaceZ from "./svgs/probe-place-z.svg?raw";
import PutAwayXYZ from "./svgs/probe-put-away-xyz.svg?raw";
import PutAwayZ from "./svgs/probe-put-away-z.svg?raw";

const Svg = ({ data, w }) => <div className="probe-svg" style={{ width: w }} dangerouslySetInnerHTML={{ __html: data }} />;

const LABELS = {
  CheckProbe: "Check probe", BitDimensions: "Bit dimensions", ProbeLocation: "Probe location", PlaceProbeBlock: "Place probe block",
  Probe: "Probe", MoveProbeBlock: "Move probe block", Probe2: "Probe second corner", Done: "Done",
};
const PRESET_BITS = ["1/8 in", "1/4 in"];

const LOCATIONS = [
  ["front-left", "Front-left corner (standard)"], ["front-right", "Front-right corner"], ["back-left", "Back-left corner"], ["back-right", "Back-right corner"],
  ["center", "Side A: center of stock (sets X, Y and Z)"], ["center-x", "Side B, after an end-for-end flip (sets X and Z, keeps Y)"],
];
const isCenterLoc = (l) => l === "center" || l === "center-x";


// The probe programs are in probe.js (1.29.0). A step only completes when the program reached its end:
// ofprobe_done must be the token written into the dialog when the step was entered.
// Spindle turning: the drive reports a speed and the last programmed speed is not 0 (a drive that reports
// a speed while stopped, or a programmed speed left over after a stop, alone does not block probing).
const spinning = (st) => !!st && Number(st.s) > 0.5 && Number(st.speed || 0) !== 0;

// ---- The wizard as a shared state machine (1.28.0) ----
// Its whole state lives in the shared session under "probe", so the touchscreen, the PC and the phone show
// the same step. Any screen can press Next or Cancel. A step that moves the machine is only taken by the
// screen whose write the controller accepted first (compare-and-set), and that screen sends the G-code and
// becomes the dialog's driver: it watches for the probe touch and for the program to finish. If the driver
// goes quiet (a phone that went to sleep), another screen takes over from the same step.
const nextIn = (list, s) => list[list.indexOf(s) + 1] || "Done";

export function buildSteps({ type, rotary, safety }) {
  const isXYZ = type === "xyz" || type === "center";
  const locationStep = isXYZ && !rotary;
  return [
    safety && !rotary ? "CheckProbe" : null, isXYZ ? "BitDimensions" : null, locationStep ? "ProbeLocation" : null,
    safety ? "PlaceProbeBlock" : null, "Probe", locationStep ? "MoveProbeBlock" : null, locationStep ? "Probe2" : null, "Done",
  ].filter(Boolean);
}

// d: the shared dialog; ev: {name, step?, ofprobe?}. Returns {d, fx} (new state and side effects) or null to ignore.
export function probeTransition(d, ev) {
  if (!d) return null;
  if (ev.step && ev.step !== d.step) return null; // pressed on a step another screen already left
  const fx = [];
  let n = { ...d };
  const goTo = (s) => {
    n.step = s; n.started = false; n.sent = s === "Probe" || s === "Probe2" ? s : null;
    if (n.sent) { n.token = ev.token || newToken(); n.sentAt = Date.now(); fx.push(s === "Probe" ? "probe1" : "probe2"); }
  };
  switch (ev.name) {
    case "cancel":
      if ((d.step === "Probe" || d.step === "Probe2") && d.sent) fx.push("stop");
      fx.push("close"); return { d: null, fx };
    case "contact":
      if (d.step !== "CheckProbe") return null;
      goTo(nextIn(d.steps, "CheckProbe")); break;
    case "fail":
      if (d.step !== "Probe" && d.step !== "Probe2") return null;
      n.failed = true; n.failReason = ev.reason || "stopped"; n.failCode = ev.code ?? null; n.failMsg = ev.msg || "";
      if (n.failReason === "nostart") fx.push("stop"); // in case it starts late
      goTo("Done"); break;
    case "complete":
      // Only a program that reached its end, for this very step (1.29.0)
      if (!d.token || ev.done !== d.token) return null;
      if (d.step === "Probe") goTo(nextIn(d.steps, "Probe"));
      else if (d.step === "Probe2") { n.centerOk = ev.ofprobe?.ok ?? null; n.centerDz = ev.ofprobe?.dz ?? null; goTo("Done"); }
      else return null;
      break;
    case "next":
      switch (d.step) {
        case "CheckProbe": case "Probe": case "Probe2": return null; // these move on by themselves
        case "BitDimensions":
          if (!parseDia(d.rotary ? d.diaRot : d.dia)) return null;
          fx.push("saveDia"); goTo(nextIn(d.steps, "BitDimensions")); break;
        case "ProbeLocation":
          fx.push("saveLoc");
          if (isCenterLoc(d.loc)) { n.centerOk = null; n.centerDz = null; }
          else n.steps = d.steps.filter((s) => s !== "MoveProbeBlock" && s !== "Probe2");
          goTo(nextIn(n.steps, "ProbeLocation")); break;
        case "Done":
          if (!d.failed) fx.push("finish");
          fx.push("close"); return { d: null, fx };
        default: goTo(nextIn(d.steps, d.step));
      }
      break;
    default: return null;
  }
  return { d: n, fx };
}

export default function ProbeDialog({ type, config, state, send, subscribe, rotary, metric, onClose, openId }) {
  const isXYZ = type === "xyz" || type === "center";
  const isCenterButton = type === "center";
  const usesLocation = isXYZ && !rotary;
  const locations = LOCATIONS.filter(([v]) => (isCenterButton ? isCenterLoc(v) : !isCenterLoc(v)));
  const locKey = isCenterButton ? "probe.centerSide" : "probe.loc";

  const ui = useUi(state, "probe");
  const D = ui.v && ui.v.id === openId ? ui.v : null;
  const isDriver = useDriver(state, "probe", D);
  const customRef = useRef(null);
  const R = useRef({}); R.current = { D, rev: ui.rev, state, config, rotary, type, send };

  // Open: the first screen to get here writes the starting state; the others show it.
  useEffect(() => {
    if (D) return;
    (async () => {
      await loadPrefs();
      const savedLoc = String(getPref(locKey, ""));
      const dia = String(getPref("probe.dia", "") || PRESET_BITS[0]), diaRot = String(getPref("probe.diaRot", "") || PRESET_BITS[0]);
      const nd = normDia(dia);
      const init = {
        id: openId, type, rotary: !!rotary, driver: ME,
        steps: buildSteps({ type, rotary, safety: config.settings["probing-prompts"] }),
        dia, diaRot, diaMode: !nd || PRESET_BITS.includes(nd) ? "preset" : "custom",
        loc: locations.some(([v]) => v === savedLoc) ? savedLoc : locations[0][0],
        jogStep: 10, failed: false, centerOk: null, centerDz: null, sent: null, started: false,
      };
      init.step = init.steps[0];
      const cur = await uiGet("probe");
      if (cur.v && cur.v.id === openId) return; // another screen was quicker
      await uiCas("probe", init, cur.rev);
    })().catch(() => {});
  }, [openId, !!D]); // eslint-disable-line react-hooks/exhaustive-deps

  // Run a transition. Only the screen whose write is accepted performs its side effects.
  const act = async (ev) => {
    let out = null;
    const r = await uiUpdate("probe", (cur) => {
      if (!cur || cur.id !== openId) return undefined;
      out = probeTransition(cur, ev);
      if (!out) return undefined;
      return out.d ? { ...out.d, driver: ME } : null;
    }).catch(() => ({ ok: false }));
    if (!r.ok || !out) return;
    const before = R.current.D || {}, d = out.d || before;
    const ctx = { config: R.current.config, rotary: d.rotary, type: d.type, loc: d.loc, dia: parseDia(d.rotary ? d.diaRot : d.dia), send: R.current.send };
    for (const f of out.fx) {
      if (f === "probe1" || f === "probe2") {
        const step = f === "probe1" ? "Probe" : "Probe2";
        if (spinning(R.current.state)) { actRef.current({ name: "fail", step, reason: "spindle" }); continue; }
        const prog = f === "probe1" ? probeProgram({ ...ctx, token: d.token }) : centerSecondProgram({ ...ctx, token: d.token });
        if (R.current.send(prog) === false) actRef.current({ name: "fail", step, reason: "send" });
      }
      if (f === "stop") api.put("stop").catch(() => {});
      if (f === "saveDia") setPref(d.rotary ? "probe.diaRot" : "probe.dia", normDia(d.rotary ? d.diaRot : d.dia));
      if (f === "saveLoc") setPref(locKey, d.loc);
      if (f === "finish") {
        // Remember where zero was set so the Run check can compare it with the program's setup sheet
        if (!(usesLocation && isCenterLoc(before.loc) && before.centerOk === 0)) {
          const st = R.current.state || {};
          if (usesLocation) remotePut("probe", { loc: before.loc, time: Date.now(), off: { x: st.offset_x ?? null, y: st.offset_y ?? null, z: st.offset_z ?? null } });
          if (isXYZ) R.current.send(before.rotary ? "G90\nG0 Y0" : "G90\nG0 X0Y0");
        }
      }
      if (f === "close") { uiClose("tool"); onClose && onClose(); }
    }
  };
  const actRef = useRef(act); actRef.current = act;

  // ---- watchers, on the driving screen only ----
  const step = D?.step || "None";
  // Probe contact moves "Check probe" on.
  const touched = probeActive(state);
  useEffect(() => { if (isDriver && step === "CheckProbe" && touched) actRef.current({ name: "contact", step }); }, [isDriver, step, touched]);
  // A probing program: started once the controller leaves idle, finished when it is idle again. It only
  // counts as complete if it set ofprobe_done to this step's token just before M2 (1.29.0). A Stop, an
  // E-stop, "Switch not found" or a guarded move that touched something never gets there.
  const running = step === "Probe" || step === "Probe2";
  const settle = (then) => {
    // The token arrives with the state update that ends the program; give it a moment, then decide.
    let t2 = null;
    const t1 = setTimeout(() => {
      const s = R.current.state, Dn = R.current.D;
      if (!Dn || Dn.step !== step) return;
      if (s.ofprobe_done === Dn.token) return then(true);
      t2 = setTimeout(() => { const s2 = R.current.state, D2 = R.current.D; if (D2 && D2.step === step) then(s2.ofprobe_done === D2.token); }, 1200);
    }, 300);
    return () => { clearTimeout(t1); clearTimeout(t2); };
  };
  const finishOrFail = (done) => {
    const s = R.current.state, Dn = R.current.D;
    if (done) { actRef.current({ name: "complete", step, done: Dn.token, ofprobe: { ok: s.ofprobe_ok, dz: s.ofprobe_dz } }); return; }
    const code = Number(s.ofprobe_fail) || 0;
    actRef.current({ name: "fail", step, reason: s.xx === "ESTOPPED" ? "estop" : code ? "guard" : "stopped", code });
  };
  useEffect(() => {
    if (!isDriver || !running || !D) return;
    if (state.xx === "ESTOPPED") { actRef.current({ name: "fail", step, reason: "estop" }); return; }
    if (state.cycle && state.cycle !== "idle") { if (!D.started) uiPatch("probe", (cur) => (cur.step === step ? { started: true } : {})).catch(() => {}); return; }
    if (state.cycle === "idle" && D.started) return settle(finishOrFail);
  }, [isDriver, running, step, state.cycle, state.xx, D && D.started]); // eslint-disable-line react-hooks/exhaustive-deps
  // Never seen running: either the program never started (refused, lost), or this screen took over from one
  // that went away after it had finished. Only the token tells them apart; without it this is a failure.
  useEffect(() => {
    if (!isDriver || !running || !D || D.started) return;
    const t = setTimeout(() => {
      const s = R.current.state, Dn = R.current.D;
      if (!Dn || Dn.step !== step || Dn.started || s.cycle !== "idle") return;
      if (s.ofprobe_done === Dn.token) finishOrFail(true);
      else actRef.current({ name: "fail", step, reason: s.xx === "ESTOPPED" ? "estop" : Number(s.ofprobe_fail) ? "guard" : "nostart", code: Number(s.ofprobe_fail) || 0 });
    }, 8000);
    return () => clearTimeout(t);
  }, [isDriver, running, step, D && D.started]); // eslint-disable-line react-hooks/exhaustive-deps
  // From the log while probing: "Switch not found", or the controller refusing the program.
  useEffect(() => subscribe((m) => {
    const Dn = R.current.D, msg = m.log?.msg || "";
    if (!Dn || (Dn.step !== "Probe" && Dn.step !== "Probe2") || Dn.driver !== ME) return;
    if (msg === "Switch not found") actRef.current({ name: "fail", step: Dn.step, reason: "notfound" });
    else if (/^(Command refused|Probing refused)/.test(msg) && (m.log.level === "error" || m.log.level === "critical")) actRef.current({ name: "fail", step: Dn.step, reason: "refused", msg });
  }), [subscribe]);

  const dia = D?.dia ?? "", diaRot = D?.diaRot ?? "", diaMode = D?.diaMode || "preset", loc = D?.loc || locations[0][0];
  const jogStep = D?.jogStep || 10, failed = !!D?.failed, centerOk = D?.centerOk ?? null, centerDz = D?.centerDz ?? null;
  const steps = D?.steps || [];
  const setDia = (v) => uiPatch("probe", { dia: v }).catch(() => {});
  const setDiaRot = (v) => uiPatch("probe", { diaRot: v }).catch(() => {});
  const setDiaMode = (v) => uiPatch("probe", { diaMode: v }).catch(() => {});
  const setLoc = (v) => uiPatch("probe", { loc: v }).catch(() => {});
  const setJogStep = (v) => uiPatch("probe", { jogStep: v }).catch(() => {});
  useEffect(() => { if (diaMode === "custom") customRef.current?.focus(); }, [diaMode]);
  if (!D) return null;

  const curDia = rotary ? parseDia(diaRot) : parseDia(dia);
  const nextDisabled = step === "CheckProbe" || step === "Probe" || step === "Probe2" || (step === "BitDimensions" && !curDia) || step === "None";
  const stepNo = steps.indexOf(step) + 1;
  const isCenter = usesLocation && isCenterLoc(loc), isCenterX = usesLocation && loc === "center-x";
  const jog = (axis, dir) => send(`\n            G91 G0 ${axis}${dir * jogStep}\n            G90\n        `);
  const labels = { ...LABELS, PlaceProbeBlock: rotary ? "Start probe" : LABELS.PlaceProbeBlock, ProbeLocation: isCenterButton ? "Which side?" : LABELS.ProbeLocation };

  const placeText = () => {
    if (usesLocation && loc === "front-right") return "Place the probe block face up on the front-right corner of your workpiece, rotated so its lips hang over the front and right edges.";
    if (usesLocation && loc === "back-left") return "Place the probe block face up on the back-left corner of your workpiece, rotated so its lips hang over the back and left edges.";
    if (usesLocation && loc === "back-right") return "Place the probe block face up on the back-right corner of your workpiece, rotated so its lips hang over the back and right edges.";
    if (usesLocation && loc === "center-x") return "First placement: put the probe block face up on the lower-left (front-left) corner, just like a normal XYZ probe. Only Z and the left end are probed; Y is kept from your earlier setup.";
    if (usesLocation && loc === "center") return "First placement: put the probe block face up on the lower-left (front-left) corner of your workpiece, just like a normal XYZ probe.";
    if (isXYZ && !rotary) return "Place the probe block face up, on the lower-left corner of your workpiece.";
    if (isXYZ && rotary) return "You are about to start probing the rotary. Position the bit above the probe and attach the probe magnet.";
    return "Place the probe block face down, with the bit above the recess.";
  };

  const title = isCenterButton ? "Probing center" : `Probing ${type.toUpperCase()}${rotary ? " (rotary)" : ""}`;
  const showCancel = step !== "Done";
  return (
    <Modal title={title} wide dismissable={false} onClose={() => act({ name: "cancel" })}
      actions={<>
        {showCancel && <button onClick={() => act({ name: "cancel" })}>Cancel</button>}
        <button data-autofocus className="primary" disabled={nextDisabled} onClick={() => act({ name: "next", step })}>{step === "Done" ? "Done" : "Next"}</button>
      </>}>
      <div className="probe">
        <ol className="probe-steps" aria-label="Probing steps">
          <li className="count">Step {Math.max(stepNo, 1)} of {steps.length || 1}</li>
          {steps.map((s) => <li key={s} className={s === step ? "active" : ""}>{labels[s]}</li>)}
        </ol>
        <div className="probe-main">
          {step === "CheckProbe" && <><p>Attach the probe magnet to the collet, then touch the probe block to the bit.</p><Svg data={isXYZ ? CheckXYZ : CheckZ} w={300} /></>}
          {step === "BitDimensions" && <>
            <div className="stack">
              <label className="stack">Cutter diameter
                <select data-autofocus value={diaMode === "custom" ? "custom" : normDia(rotary ? diaRot : dia) || PRESET_BITS[0]}
                  onChange={(e) => {
                    const v = e.target.value; const k = rotary ? "diaRot" : "dia";
                    uiPatch("probe", v === "custom" ? { [k]: "", diaMode: "custom" } : { [k]: v, diaMode: "preset" }).catch(() => {});
                  }}>
                  {PRESET_BITS.map((b) => <option key={b} value={b}>{b}</option>)}
                  <option value="custom">Other size (type it in)</option>
                </select>
              </label>
              {diaMode === "custom" && (
                <label className="stack">Size
                  <SharedText autoFocus placeholder="for example 6 mm or 0.2 in" value={rotary ? diaRot : dia} aria-invalid={!curDia}
                    onChange={(v) => (rotary ? setDiaRot(v) : setDia(v))} />
                  <small>Examples: 3/16", 6 mm, 0.25 in</small>
                </label>
              )}
            </div>
            <Svg data={BitDiameter} w={150} />
          </>}
          {step === "ProbeLocation" && <>
            <p>{isCenterButton ? "Which side are you probing?" : "Which corner should be the XY origin?"}</p>
            <div className="radios">{locations.map(([v, label]) => <label key={v}><input type="radio" name="loc" value={v} checked={loc === v} onChange={() => setLoc(v)} /> {label}</label>)}</div>
            {loc === "center" && <p className="dim">Two placements: front-left, then back-right. No stock size is needed; the center is measured.</p>}
            {loc === "center-x" && <p className="dim">Front-left, then front-right. With the same long edge against the fixed jaw (for example the second side after an end-for-end flip): finds the X center from the two ends along the front edge and sets Z. The Y origin is left exactly as it was.</p>}
          </>}
          {step === "PlaceProbeBlock" && <>
            <p>{placeText()}</p>
            {!rotary && (!usesLocation || loc === "front-left" || loc === "center" || loc === "center-x") && <Svg data={isXYZ ? PlaceXYZ : PlaceZ} w={304} />}
            <p>The router or spindle must be off. The probing procedure will begin as soon as you click Next.</p>
          </>}
          {step === "Probe" && <><p>Probing in progress…</p><div className="indet" /></>}
          {step === "MoveProbeBlock" && <>
            <p>{isCenterX
              ? <>Second placement: put the probe block on the <b>front-right</b> corner, rotated so its lips hang over the front and right edges. Both ends are then touched along the front edge, the edge that sits against the fixed jaw.</>
              : <>Second placement: put the probe block on the <b>back-right</b> corner, rotated 180 degrees so its lips hang over the back and right edges.</>}</p>
            <p>Then jog the bit over the block's <b>{isCenterX ? "left" : "front-left"}</b> corner, a few mm above it: the mirror of where you start the first probe (about 5 to 15 mm in from {isCenterX ? "its left edge" : "both of those edges"}). Keep the probe magnet on the collet.</p>
            <div className="probe-jog">
              <div className="radios inline">Step: {[10, 1].map((v) => <label key={v}><input type="radio" name="js" checked={jogStep === v} onChange={() => setJogStep(v)} /> {v} mm</label>)}</div>
              <div className="jgrid">
                <span /><button onClick={() => jog("Y", 1)}>Y+ (back)</button><span /><button onClick={() => jog("Z", 1)}>Z+ (up)</button>
                <button onClick={() => jog("X", -1)}>X− (left)</button><span /><button onClick={() => jog("X", 1)}>X+ (right)</button><span />
                <span /><button onClick={() => jog("Y", -1)}>Y− (front)</button><span /><button onClick={() => jog("Z", -1)}>Z− (down)</button>
              </div>
            </div>
            <p>{isCenterX ? "Click Next to probe: Z on the block top, then the left face only. Y is not changed." : "Click Next to probe: Z on the block top, then the left and front faces."}</p>
          </>}
          {step === "Probe2" && <><p>Probing the second corner…</p><div className="indet" /></>}
          {step === "Done" && (failed ? (() => {
            const [h, t] = failText(D.failReason, D.failCode);
            return <><h3>{h}</h3><p>{t}</p>{D.failMsg && <p className="dim">{D.failMsg}</p>}</>;
          })() : <>
            <p>{rotary ? "Probing complete." : "Don't forget to put away the probe!"}</p>
            {!rotary && <Svg data={isXYZ ? PutAwayXYZ : PutAwayZ} w={329} />}
            {isXYZ && (rotary ? <p>The machine will now move to the Y origin.</p> : <p>
              {isCenter && centerOk === 0 ? <><b>Second placement rejected.</b> The two Z touches differed by {Math.abs(centerDz ?? 0).toFixed(2)} mm (limit 0.5 mm), so the bit stopped before moving sideways. The X/Y origin was NOT moved to the center. Check the block is on the back-right corner and the stock size is right, then probe again.</>
                : isCenterX ? "X0 is now the center between the two ends; Y0 is unchanged from your earlier setup. The machine will now move there."
                : isCenter ? "The XY origin is now the center of the stock. The machine will now move there."
                : "The machine will now move to the XY origin."}
            </p>)}
            {isXYZ && <p><b>Watch your hands!</b></p>}
          </>)}
        </div>
      </div>
    </Modal>
  );
}
