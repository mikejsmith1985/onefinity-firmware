import React, { useEffect, useRef, useState } from "react";
import { Modal, SharedText, NumInput } from "./ui.jsx";
import { ME, useUi, useDriver, uiUpdate, uiPatch, uiClose, uiOpen } from "./shared.js";
import { api } from "./controller.js";
import { remotePut } from "./store.js";
import { getPrefs, setPrefs, errText, useCheckpoint } from "./checkpoint.js";
import { readSetup, sheetSummary } from "./setup.js";
import { computeAxis } from "./axis.js";
import { MEASURE_DEFAULTS, FAILS as MEASURE_FAILS, ORIGINS_XY, measureProgram, checkOpts } from "./measure.js";
import { probeActive, refStatus, setterTouchProgram, setterLiftProgram, touchTrip, probeRefValue } from "./setter.js";
import { getSetter, saveSetter } from "./ToolSetter.jsx";
import { BORE_DEFAULTS, BORE_FAILS, boreProgram, boreSpots, boreOrder, boreVerdict, checkBore } from "./bore.js";
import { jobSteps, stockCenter, overStockProgram, zeroFor, boreSearch, manualSpindle, cameraPoint, WHY } from "./wizard.js";
import { newToken } from "./probe.js";
import { useFinished } from "./doover.js";
import { programMoves, moveStatus } from "./progress.js";
import { RunProgress, StepBody, Outcome, useRunStep } from "./steps.jsx";
import { MeasureArt, SetterArt, BoreArt } from "./art.jsx";

// Start job wizard (1.31.0). Driven by the program's setup sheet: load the stock, put the 3D probe in,
// measure the stock and set zero on the sheet's corner, line side B up on its reference bores, then
// for each tool: swap the cutter, set its Z on the tool setter, switch the router on and run its part.
//
// The whole wizard is shared (key "wizard"), so every screen shows the same step. The screen that
// pressed a step's button runs its program and watches it end; a step only counts as done when the
// program set this run's token at its very end (the 1.29.0 pattern). Every step can be skipped, and
// the place is remembered (prefs "wizard"), so closing the wizard or reloading the page carries on
// from the same step.

const FLIPS = { y: "over left to right (about the Y axis)", x: "over front to back (about the X axis)", none: "as the setup sheet's positions already are" };

// Runs one program and resolves when it has ended: {ok, why, msg, state}. key/token: the variable the
// program sets to the token just before M2; without a key it only waits for the end.
function useRunner(state, subscribe, send) {
  const R = useRef({ state });
  R.current.state = state;
  useEffect(() => subscribe((d) => {
    const r = R.current;
    if (!r.running) return;
    const msg = d.log?.msg || "";
    if (msg === "Switch not found") r.why = "notfound";
    else if (/^(Command refused|Probing refused)/.test(msg) && (d.log.level === "error" || d.log.level === "critical")) { r.why = "refused"; r.msg = msg; }
    if (d.cycle !== undefined) {
      if (d.cycle !== "idle") r.started = true;
      else if (r.started && r.end) r.end();
    }
  }), [subscribe]);
  return (prog, key, token) => new Promise((resolve) => {
    const r = R.current;
    let over = false;
    const finish = (res) => { if (over) return; over = true; r.running = false; r.end = null; clearTimeout(r.t); resolve({ ...res, state: R.current.state }); };
    const judge = () => {
      const s = R.current.state;
      const tok = !key || s[key] === token;
      const est = s.xx === "ESTOPPED";
      finish({ ok: tok && !r.why && !est, why: r.why || (est ? "estop" : tok ? null : "stopped"), msg: r.msg });
    };
    Object.assign(r, { running: true, started: false, why: null, msg: "", end: () => setTimeout(judge, 1200) });
    // Never seen running: a short program that ended between two updates (the token tells), or one that never started
    r.t = setTimeout(() => { if (!r.started) { const s = R.current.state; if (key ? s[key] === token : s.cycle === "idle") finish({ ok: true }); else finish({ ok: false, why: r.why || "nostart", msg: r.msg }); } }, 8000);
    if (send(prog) === false) finish({ ok: false, why: "send" });
  });
}

const fmt = (v, p = 3) => (typeof v === "number" && Number.isFinite(v) ? v.toFixed(p) : "—");

export default function JobWizard({ config, state, send, subscribe, metric, mach }) {
  const ui = useUi(state, "wizard");
  const D = ui.v;
  const isDriver = useDriver(state, "wizard", D);
  const patch = (x) => uiPatch("wizard", x).catch(() => {});
  const runRaw = useRunner(state, subscribe, send);
  // 1.31.1: every screen shows the running program's moves (its progress marks, progress.js)
  const run = (prog, key, token) => {
    const mv = programMoves(prog);
    const kind = /^\(Bore/.test(prog) ? "bore" : /^\(Measure stock/.test(prog) ? "measure" : /^\(Tool setter/.test(prog) ? "setter" : "move";
    patch(mv.length ? { runMoves: mv, runAt: Date.now(), runKind: kind } : { runMoves: null });
    return runRaw(prog, key, token);
  };
  const runStep = useRunStep(state.of_step, D?.busy && D?.runMoves ? `${D.runKind}:${D.runAt}` : null);
  const [setter, setSetter] = useState(null);
  const [prefs, setPrefsState] = useState(null);
  const toolOpen = !!useUi(state, "tool").v;
  const checkOpen = !!useUi(state, "runcheck").v;
  const { cp } = useCheckpoint(state);
  const finished = useFinished(cp, D?.launched || null);
  const R = useRef({});
  R.current.D = D; R.current.state = state;

  useEffect(() => {
    const f = () => { getSetter().then(setSetter); getPrefs().then(setPrefsState); };
    f(); window.addEventListener("next-store:prefs", f);
    return () => window.removeEventListener("next-store:prefs", f);
  }, []);

  // ---- start: the screen that opened it reads the program and lays out the steps ----
  useEffect(() => {
    if (!D || D.steps || D.loading || D.driver !== ME) return;
    (async () => {
      await patch({ loading: true, err: "" });
      try {
        const file = D.file;
        const setup = await readSetup(file);
        const sum = sheetSummary(setup);
        const plan = await api.put("next-wizard", { action: "plan", file });
        let refs = null;
        const hasRefs = setup && setup.fields.some((f) => /^ref\d$/.test(f.key));
        const aligned = file.startsWith("flip-") || setup?.corner === "flip";
        if (hasRefs && !aligned) refs = await api.put("next-wizard", { action: "flip_refs", file });
        const manual = manualSpindle(config);
        const sheet = {
          stock: setup?.stock || null, corner: setup?.corner || null, toolD: setup?.toolD || null,
          tool: sum?.tool || null, dial: sum?.dial || null, rpm: sum?.rpm || null, before: sum?.before || "", z0: sum?.z0 || null,
        };
        const p = await getPrefs();
        const saved = p.wizard && (p.wizard.file === file || p.wizard.src === file) && Date.now() - (p.wizard.at || 0) < 7 * 86400000 && p.wizard.i > 0 ? p.wizard : null;
        // A flip-aligned copy already has its X/Y zero from the reference bores: measuring the stock
        // again would move it, so those steps start skipped (Z is set on the setter or the plate).
        const skip = aligned ? { stock: true, probe: true, measure: true } : {};
        await patch({
          loading: false, setup: !!setup, sheet, plan: plan.parts, refs, manual, src: file, aligned,
          steps: jobSteps({ parts: plan.parts, refs, manual, skip }), i: 0, skip,
          measured: refs ? refs.refs.map(() => null) : null, sol: null, partFiles: {}, saved,
        });
      } catch (e) { patch({ loading: false, err: errText(e) }); }
    })();
  }, [D && D.id, D && D.driver, !!(D && D.steps)]); // eslint-disable-line react-hooks/exhaustive-deps

  // Remember the place, so closing the wizard (or a reload, or a restart) carries on from this step
  useEffect(() => {
    if (!D || !D.steps || !isDriver || !D.i) return;
    if (D.steps[D.i]?.kind === "done") { setPrefs({ wizard: null }); return; }
    setPrefs({ wizard: { file: D.file, at: Date.now(), i: D.i, steps: D.steps, src: D.src, plan: D.plan, refs: D.refs, measured: D.measured, sol: D.sol, partFiles: D.partFiles, flip: D.flip || null, aligned: D.aligned } });
  }, [D && D.i, D && D.src, D && JSON.stringify(D.measured)]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- a part that was started from the wizard: wait for the end, then go on ----
  useEffect(() => {
    if (!D || !isDriver || !D.launched) return undefined;
    if (state.cycle && state.cycle !== "idle") { if (!D.seenRun) patch({ seenRun: true }); return undefined; }
    if (!D.seenRun || state.cycle !== "idle") return undefined;
    const t = setTimeout(() => {
      const d = R.current.D;
      if (!d || !d.launched) return;
      if (finished) patch((x) => ({ launched: null, seenRun: false, min: false, msg: null, i: Math.min(x.i + 1, x.steps.length - 1) }));
      else patch({ launched: null, seenRun: false, min: false, msg: { ok: false, text: `${d.launched} stopped before the end. Use Resume to finish it, or run the part again.` } });
    }, 1500);
    return () => clearTimeout(t);
  }, [D && D.launched, D && D.seenRun, state.cycle, finished, isDriver]); // eslint-disable-line react-hooks/exhaustive-deps

  // Probe Z (touch plate) opened from the wizard: come back when it closes
  useEffect(() => {
    if (D && isDriver && D.waitTool && !toolOpen) patch({ waitTool: null, min: false, zByPlate: true });
  }, [toolOpen, D && D.waitTool, isDriver]); // eslint-disable-line react-hooks/exhaustive-deps

  // 3D probe check: moves on once the stylus has been seen open, then touched
  const touched = probeActive(state);
  const stepNow = D?.steps?.[D.i];
  useEffect(() => {
    if (!D || !stepNow || stepNow.kind !== "probe" || !isDriver) return;
    if (!touched) { if (!D.seenOpen) patch({ seenOpen: true }); }
    else if (D.seenOpen) patch((x) => (x.steps[x.i]?.kind === "probe" ? { i: x.i + 1, seenOpen: false } : {}));
  }, [touched, D && D.seenOpen, stepNow && stepNow.id, isDriver]); // eslint-disable-line react-hooks/exhaustive-deps

  // Every bore found: work out the turn and shift on the controller (same code that writes the copy)
  const allMeasured = !!(D && D.measured && D.measured.every((m) => m && !m.bad));
  const solve = async () => {
    const d = R.current.D;
    try { const sol = await api.put("next-wizard", { action: "flip_solve", file: d.src, measured: d.measured.map((m) => ({ x: m.x, y: m.y })) }); patch({ sol, msg: null }); }
    catch (e) { patch({ msg: { ok: false, text: errText(e) } }); }
  };
  useEffect(() => { if (D && isDriver && !D.flip && D.steps?.[D.i]?.kind === "flip" && allMeasured && !D.sol && !D.busy) solve(); }, [allMeasured, D && D.sol, D && D.i, D && D.busy, isDriver]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!D) return null;
  const close = () => uiClose("wizard");
  const cancel = () => { setPrefs({ wizard: null }); uiClose("wizard"); };

  const u = metric ? 1 : 25.4, unit = metric ? "mm" : "in";
  const L = (mm, p = 2) => (typeof mm === "number" ? `${(mm / u).toFixed(metric ? p : p + 1)} ${unit}` : "—");
  const homed = !!config && ["x", "y", "z"].every((a) => computeAxis(state, config, a, metric).homed);
  const idle = state.cycle === "idle" && state.xx !== "ESTOPPED";
  const busy = D.busy || "";
  const canMove = homed && idle && !busy;
  const work = { x: (state.xp || 0) - (state.offset_x || 0), y: (state.yp || 0) - (state.offset_y || 0), z: (state.zp || 0) - (state.offset_z || 0) };
  const zTop = config ? computeAxis(state, config, "z", true).max - 1 : 0;

  // Claim a step's button so only one screen runs it
  const claim = async (what) => {
    const r = await uiUpdate("wizard", (d) => (d && d.id === D.id && !d.busy ? { ...d, busy: what, msg: null, driver: ME } : undefined)).catch(() => ({ ok: false }));
    return r.ok;
  };
  const release = (extra = {}) => patch({ busy: "", runMoves: null, ...extra });
  const next = (extra = {}) => patch((x) => ({ i: Math.min(x.i + 1, x.steps.length - 1), msg: null, ...extra }));
  const back = () => patch((x) => ({ i: Math.max(0, x.i - 1), msg: null }));
  const fail = (res, extra = "") => release({ msg: { ok: false, text: `${WHY[res.why] || "It didn't finish."}${res.msg ? ` (${res.msg})` : ""}${extra ? ` ${extra}` : ""}` } });

  const mprefs = { ...MEASURE_DEFAULTS, ...(prefs?.measure || {}) };
  const fast = config?.probe?.["probe-fast-seek"], slow = config?.probe?.["probe-slow-seek"];
  const S = D.sheet || {};
  const W = S.stock ? S.stock.x.max - S.stock.x.min : null, Lg = S.stock ? S.stock.y.max - S.stock.y.min : null;
  const origin = S.corner && ORIGINS_XY.some(([v]) => v === S.corner) ? S.corner : S.corner === "center-x" ? "center-x" : D.origin || "front-left";
  const probeY = origin !== "center-x" && D.probeY !== false;
  const last = prefs?.wizardLast;
  const sameStock = last && W && Math.abs(last.w - W) < 5 && (!Lg || !last.l || Math.abs(last.l - Lg) < 5);

  // ---- programs ----
  const overStock = async () => {
    if (!(await claim("move"))) return;
    const token = newToken();
    const res = await run(overStockProgram({ last, top: zTop, above: 10, travel: mprefs.travel, token }), "ofw_done", token);
    if (!res.ok) return fail(res, res.state.ofw_fail ? "The stylus touched something on the way down: the stock may be thicker than last time. Jog it over the middle of the stock instead." : "");
    release({ msg: { ok: true, text: "The stylus is over the middle of the stock, about 10 mm above it. Check by eye, then measure." } });
  };

  const measure = async () => {
    const o = { ...mprefs, w: D.mw || W, l: D.ml || Lg, probeY, origin, calibrate: false, fast, slow };
    const errs = checkOpts(o);
    if (errs.length) { patch({ msg: { ok: false, text: errs.join(" ") } }); return; }
    if (!(await claim("measure"))) return;
    const token = newToken();
    const res = await run(measureProgram({ ...o, token }), "ofm_done", token);
    const s = res.state;
    if (!res.ok) return fail(res, Number(s.ofm_fail) ? MEASURE_FAILS[s.ofm_fail] : "Work zero was not changed.");
    remotePut("probe", { loc: origin, time: Date.now(), off: { x: s.offset_x ?? null, y: probeY ? s.offset_y ?? null : null, z: s.offset_z ?? null }, measured: { w: s.ofm_w, l: probeY ? s.ofm_l : null }, by: "wizard" });
    const c = stockCenter(origin, s.ofm_w || o.w, s.ofm_l || o.l || 0);
    setPrefs({ wizardLast: { x: (s.offset_x || 0) + c.x, y: (s.offset_y || 0) + c.y, ztop: s.offset_z || 0, w: s.ofm_w, l: s.ofm_l || null, time: Date.now() } });
    let text = `Measured ${L(s.ofm_w)}${probeY ? ` × ${L(s.ofm_l)}` : ""}. Zero is set: Z on the top, X/Y on the ${origin.replace("-", " ")}.`;
    // The tool setter, touched with the probe while its Z zero is fresh (frame-free touch)
    const st = await getSetter();
    if (st && typeof st.x === "number" && D.useSetter !== false) {
      const t2 = newToken();
      const r2 = await run(setterTouchProgram({ setter: st, top: zTop, clear: st.clear, travel: st.travel, fast, slow, token: t2 }), "ofs_done", t2);
      if (r2.ok) {
        const trip = touchTrip(r2.state.zp, r2.state.offset_z);
        const now = Date.now();
        const nst = { ...st, ref: { ref: probeRefValue(trip, st), offZ: r2.state.offset_z, time: now, by: "probe", corrected: typeof st.corr?.c === "number" }, lastProbe: { ref: trip, offZ: r2.state.offset_z, time: now } };
        await saveSetter(nst); setSetter(nst);
        text += " The tool setter was touched with the probe, so each cutter can be measured there.";
      } else text += ` The tool setter touch didn't work (${WHY[r2.why] || "stopped"}): set Z for the cutter with the touch plate instead.`;
      await run(setterLiftProgram(zTop, { x: c.x + (s.offset_x || 0), y: c.y + (s.offset_y || 0) }));
    }
    release({ msg: { ok: true, text }, measuredOk: true });
  };

  const order = D.refs ? boreOrder(D.refs.refs) : [];
  const ball = mprefs.ball;
  const camOff = prefs?.camera?.offsets?.[config?.tool?.["selected-tool"] || "default"];

  const probeBore = async (i, mode) => {
    const ref = D.refs.refs[i];
    const off = { x: state.offset_x || 0, y: state.offset_y || 0 };
    let targets = null;
    if (mode === "find") {
      const s = boreSearch(D.refs.refs, D.measured, i, off);
      targets = boreSpots(s.pred, ref.d, ball, s.opts);
    } else if (mode === "camera") {
      const p = cameraPoint(state, camOff);
      targets = boreSpots({ x: p.x - off.x, y: p.y - off.y }, ref.d, ball, { slack: 2 });
    }
    const o = { d: ref.d, ball, depth: Math.min(BORE_DEFAULTS.depth, ref.depth ? ref.depth - 1 : 99), clear: mprefs.clear, travel: mprefs.travel, fast, slow, fromX: work.x, fromY: work.y, fromZ: work.z, targets, name: ref.name };
    const errs = checkBore(o);
    if (errs.length) { patch({ msg: { ok: false, text: errs.join(" ") } }); return; }
    if (!(await claim(`bore${i}`))) return;
    const token = newToken();
    const res = await run(boreProgram({ ...o, token }), "ofb_done", token);
    const s = res.state;
    if (!res.ok) return fail(res, Number(s.ofb_fail) ? BORE_FAILS[s.ofb_fail] : "");
    const r = { dx: s.ofb_dx, dy: s.ofb_dy, sx: s.ofb_sx, sy: s.ofb_sy };
    const v = boreVerdict(r, ref.d);
    const m = { x: s.xp, y: s.yp, ...r, dia: v.dia, round: v.round, rep: v.rep, bad: !v.ok, probs: v.probs, spots: s.ofb_in };
    const meas = D.measured.slice(); meas[i] = m;
    release({ measured: meas, sol: null, msg: v.ok ? null : { ok: false, text: `${ref.name}: ${v.probs.join(" ")}` } });
  };
  const manualBore = (i) => { const meas = D.measured.slice(); meas[i] = { x: state.xp, y: state.yp, manual: true }; patch({ measured: meas, sol: null }); };
  const clearBore = (i) => { const meas = D.measured.slice(); meas[i] = null; patch({ measured: meas, sol: null }); };


  const lineUp = async () => {
    if (!idle || !homed) return;
    if (!(await claim("lineup"))) return;
    try {
      const info = await api.put("next-wizard", { action: "flip_build", file: D.src, measured: D.measured.map((m) => ({ x: m.x, y: m.y })) });
      const z = zeroFor(state, info.origin);
      await api.put("position/x", { position: z.x });
      await api.put("position/y", { position: z.y });
      remotePut("probe", { loc: "flip", time: Date.now(), file: info.file, off: { x: info.origin.x, y: info.origin.y, z: state.offset_z ?? null }, angle: info.angle, by: "wizard" });
      const plan = await api.put("next-wizard", { action: "plan", file: info.file });
      const steps = jobSteps({ parts: plan.parts, refs: D.refs, manual: D.manual, skip: D.skip || {} });
      release({ src: info.file, flip: { file: info.file, angle: info.angle, origin: info.origin, res: info.residuals }, plan: plan.parts, steps, msg: { ok: true, text: `Lined up: turned ${info.angle.toFixed(3)}°, X/Y zero set on the program's X0 Y0. ${info.file} is loaded.` } });
    } catch (e) { release({ msg: { ok: false, text: errText(e) } }); }
  };

  const k = stepNow?.part;
  const part = k !== null && k !== undefined && D.plan ? D.plan[k] : null;
  const refOk = setter && typeof setter.x === "number" && refStatus(setter.ref, state).ok;

  const measureTool = async () => {
    const st = await getSetter();
    if (!st || typeof st.x !== "number" || !refStatus(st.ref, state).ok) { patch({ msg: { ok: false, text: "There's no current tool setter reference. Set Z with the touch plate instead." } }); return; }
    if (!(await claim("setter"))) return;
    const token = newToken();
    const res = await run(setterTouchProgram({ setter: st, top: zTop, clear: st.clear, travel: st.travel, fast, slow, token }), "ofs_done", token);
    if (!res.ok) { await run(setterLiftProgram(zTop)); return fail(res, Number(res.state.ofs_fail) ? "The tool touched the setter early: it is much longer than the probe. Raise the setter clearance on the Tool setter screen." : "Z zero was not changed."); }
    // The tool stopped 1 mm above the trip: that point is the reference + 1 in work Z
    const zp = res.state.zp;
    try { await api.put("position/z", { position: st.ref.ref + 1 }); }
    catch (e) { await run(setterLiftProgram(zTop)); return release({ msg: { ok: false, text: `Z zero could not be set: ${errText(e)}` } }); }
    const nst = { ...st, ref: { ...st.ref, offZ: zp - (st.ref.ref + 1) } };
    await saveSetter(nst); setSetter(nst);
    await run(setterLiftProgram(zTop));
    release({ msg: { ok: true, text: `Z zero is set for T${part?.tool ?? ""} on the same stock top.` }, zDone: { ...(D.zDone || {}), [k]: true } });
  };

  const plateZ = () => { patch({ min: true, waitTool: "z" }); uiOpen("tool", { kind: "z", id: `${Date.now()}-${ME}` }); };

  const preparePart = async () => {
    if (!(await claim("part"))) return;
    try {
      let file;
      if (D.plan.length > 1) file = (await api.put("next-wizard", { action: "part", file: D.src, index: k })).file;
      else { file = D.src; if (state.selected !== file) await fetch(`/api/file/${encodeURIComponent(file)}`); }
      release({ partFiles: { ...(D.partFiles || {}), [k]: file } });
    } catch (e) { release({ msg: { ok: false, text: errText(e) } }); }
  };
  const runPart = async () => {
    const file = D.partFiles?.[k];
    if (!file) return;
    if (state.selected !== file) await fetch(`/api/file/${encodeURIComponent(file)}`).catch(() => {});
    await patch({ launched: file, seenRun: false, min: true, msg: null });
    window.dispatchEvent(new CustomEvent("next-run-request", { detail: { file } }));
  };

  // ---- minimized while a part runs, the Run checklist is open, or Probe Z is open ----
  if (D.min || (toolOpen && !D.loading) || checkOpen) {
    return (
      <div className="wz-banner" role="status">
        <span><b>Start job</b> · {stepNow?.title || ""}{D.launched ? ` · ${D.launched}${D.seenRun ? " running" : ""}` : ""}</span>
        {!D.launched || !D.seenRun ? <button onClick={() => patch({ min: false, launched: null, waitTool: null })}>Back to the wizard</button> : null}
      </div>
    );
  }

  const steps = D.steps || [];
  const kind = stepNow?.kind;
  const msgBox = D.msg && <Outcome ok={D.msg.ok} title={D.msg.ok ? "Done" : "Stopped"}><p>{D.msg.text}</p></Outcome>;
  const toolLine = (p) => p ? `T${p.tool ?? "?"}${p.tool_name ? ` · ${p.tool_name.replace(/^T\d+\s*/, "")}` : ""}` : "";
  const stick = S.tool?.stick && (!part || String(part.tool) === String(S.tool?.num)) ? S.tool.stick : null;

  const actions = <>
    <button onClick={close} title="Close; the wizard remembers this step">Close</button>
    {D.i > 0 && kind !== "done" && <button disabled={!!busy} onClick={back}>Back</button>}
    {(kind === "measure" || kind === "flip") && <button disabled={!!busy} onClick={() => patch({ min: true })} title="Hide the wizard to use the jog buttons or the camera; it stays on this step">Hide to jog</button>}
    {kind && !["overview", "done", "run"].includes(kind) && <button disabled={!!busy} onClick={() => next()}>Skip</button>}
    {kind === "overview" && D.saved && <button onClick={() => patch({ ...D.saved, saved: null, msg: null })}>Continue at {D.saved.steps?.[D.saved.i]?.title || "the saved step"}</button>}
    {kind === "overview" && <button className="primary" data-autofocus disabled={!D.steps} onClick={() => next({ saved: null })}>Start</button>}
    {kind === "stock" && <button className="primary" data-autofocus onClick={() => next()}>Stock is clamped</button>}
    {kind === "measure" && D.measuredOk && <button className="primary" data-autofocus onClick={() => next({ measuredOk: false })}>Next</button>}
    {kind === "flip" && D.flip && <button className="primary" data-autofocus onClick={() => next()}>Next</button>}
    {kind === "tool" && <button className="primary" data-autofocus onClick={() => next()}>{`T${part?.tool ?? ""} is in`}</button>}
    {kind === "zset" && (D.zDone?.[k] || D.zByPlate) && <button className="primary" data-autofocus onClick={() => next({ zByPlate: false })}>Next</button>}
    {kind === "router" && <button className="primary" data-autofocus disabled={!D.routerOn?.[k]} onClick={() => next()}>Next</button>}
    {kind === "done" && <button className="primary" data-autofocus onClick={cancel}>Finish</button>}
  </>;

  return (
    <Modal title="Start job" wide dismissable={false} onClose={close} actions={actions}>
      <div className="probe wizard">
        <ol className="probe-steps" aria-label="Steps">
          <li className="count">Step {D.i + 1} of {steps.length || 1}</li>
          {steps.map((s, j) => <li key={s.id} className={j === D.i ? "active" : j < D.i ? "done" : ""}>{s.title}</li>)}
        </ol>
        <div className="probe-main">
          {D.loading && <p>Reading {D.file}…</p>}
          {D.err && <p className="err">{D.err}</p>}

          {kind === "overview" && <>
            <p><b>{D.file}</b>{D.setup ? "" : " has no setup sheet, so the wizard can't measure the stock or check the zero for you."}</p>
            <dl className="rdl">
              {S.stock && <div className="rrow"><dt>Stock</dt><dd>{L(W, 1)} × {L(Lg, 1)}</dd></div>}
              <div className="rrow"><dt>Zero</dt><dd>{D.aligned ? "the flip alignment (reference bores)" : S.corner ? S.corner.replace("-", " ") : "not on the sheet"}{S.z0 ? `, Z0 on ${S.z0}` : ""}</dd></div>
              <div className="rrow"><dt>Tools</dt><dd>{(D.plan || []).map((p) => toolLine(p)).join(" → ") || "—"}{D.plan?.length > 1 ? ` (${D.plan.length} parts, one per tool)` : ""}</dd></div>
              {D.refs && <div className="rrow"><dt>Side B</dt><dd>{D.refs.refs.length} reference bores; turned {FLIPS[D.refs.flip]}</dd></div>}
              {D.manual && <div className="rrow"><dt>Router</dt><dd>switched by hand{S.dial ? `, dial ${S.dial}` : ""}</dd></div>}
              <div className="rrow"><dt>Tool setter</dt><dd>{setter && typeof setter.x === "number" ? (setter.corr ? "saved and calibrated" : "saved, probe not calibrated against a cutter yet") : "not saved: Z for each cutter is set with the touch plate"}</dd></div>
            </dl>
            {D.aligned && <p className="warnbox">This is a copy lined up on side B's reference bores. Its X/Y zero comes from that alignment, so the stock isn't measured again; if the stock was moved since, open the original program and line it up again.</p>}
            {D.refs?.warnings?.map((w) => <p key={w} className="warnbox">{w}</p>)}
            {!D.aligned && <label className="check"><input type="checkbox" checked={!!D.skip?.zeroSet} onChange={(e) => { const on = e.target.checked; const skip = { ...(D.skip || {}), zeroSet: on, stock: on, probe: on, measure: on }; patch({ skip, steps: jobSteps({ parts: D.plan, refs: D.refs, manual: D.manual, skip }) }); }} /> The stock is already clamped and its zero is set (skip to the cutter)</label>}
          </>}

          {kind === "stock" && <>
            <p>Clamp the stock{S.stock ? <> (<b>{L(W, 1)} × {L(Lg, 1)}</b>)</> : ""}. Keep clamps clear of the {S.corner ? `${S.corner.replace("-", " ")} corner and the ` : ""}edges the probe touches, and of the tool setter.</p>
            {D.refs && <div className="why"><b>Side B</b><p>Turn the stock {FLIPS[D.refs.flip]} and clamp it with side A's reference bores clear of clamps. Blow the bores out: a chip in a bore moves its centre.</p></div>}
            {S.before && <p className="dim">{S.before}</p>}
          </>}

          {kind === "probe" && <>
            <p>Put the 3D probe in the collet and plug it in.</p>
            <p><b>Push the stylus sideways with your finger.</b> This step moves on by itself when the controller sees the touch.</p>
            <div className="indet" />
            {touched && !D.seenOpen ? <p className="err">The probe input already reads as touched. A normally open probe (like the EasyTouch) reads open until it is pushed: check the probe input type under I/O, and the cable.</p>
              : <p className="dim">Nothing happening? Check the cable, and that the probe input type under I/O matches your probe (normally open for the EasyTouch).</p>}
          </>}

          {kind === "measure" && <>
            <p>The probe finds the top and the edges of the stock and sets zero on the <b>{origin.replace("-", " ")}</b>{probeY ? "" : " (X only)"}.</p>
            {!W && <div className="measure-grid">
              <label className="stack">Approximate X size ({unit})<SharedText inputMode="decimal" value={D.mwText || ""} onChange={(v) => patch({ mwText: v, mw: parseFloat(v) * u })} /></label>
              <label className="stack">Approximate Y size ({unit})<SharedText inputMode="decimal" value={D.mlText || ""} onChange={(v) => patch({ mlText: v, ml: parseFloat(v) * u })} /></label>
            </div>}
            {!S.corner && <label className="stack">Set zero at<select value={origin} onChange={(e) => patch({ origin: e.target.value })}>{ORIGINS_XY.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>}
            <p>Put the stylus over the <b>middle</b> of the stock, 3 to 15 mm above it{sameStock ? ", or let the machine take it where the last stock was" : ""}.</p>
            {sameStock && <p><button disabled={!canMove} onClick={overStock}>{busy === "move" ? "Moving…" : "Move over the middle of the stock (where the last one was)"}</button></p>}
            {origin !== "center-x" && <label className="check"><input type="checkbox" checked={probeY} onChange={(e) => patch({ probeY: e.target.checked })} /> Touch the front and back faces too (they must stand above the vise jaws and clamps)</label>}
            {setter && typeof setter.x === "number" && <label className="check"><input type="checkbox" checked={D.useSetter !== false} onChange={(e) => patch({ useSetter: e.target.checked })} /> Then touch the tool setter with the probe</label>}
            <p><button className="primary" disabled={!canMove || touched} onClick={measure}>{busy === "measure" ? "Measuring…" : "Measure stock"}</button></p>
          </>}

          {kind === "flip" && D.refs && <>
            <p>The probe finds the middle of each of side A's reference bores. Then the program is turned and shifted to match the stock.</p>
            <ul className="wz-refs">
              {order.map((i) => { const r = D.refs.refs[i], m = D.measured[i]; return (
                <li key={r.name} className={m ? (m.bad ? "bad" : "ok") : ""}>
                  <b>{r.name}</b> · ⌀{fmt(r.d, 2)} mm at X {fmt(r.x, 2)} Y {fmt(r.y, 2)}
                  {m && <small>{m.manual ? `Position typed or taken by eye: machine X ${fmt(m.x)} Y ${fmt(m.y)}` : `Centre at machine X ${fmt(m.x)} Y ${fmt(m.y)} · ⌀${fmt(m.dia)} · ${fmt(m.round)} out of round · repeat ${fmt(m.rep)} mm`}{m.probs?.length ? <span className="err"> {m.probs.join(" ")}</span> : null}</small>}
                  <span className="row-end">
                    <button disabled={!canMove || touched} onClick={() => probeBore(i, "find")}>{busy === `bore${i}` ? "Probing…" : m ? "Probe again" : "Find and probe"}</button>
                    <button disabled={!canMove || touched} onClick={() => probeBore(i, "here")} title="Jog the stylus over the bore first">Probe here</button>
                    {camOff && <button disabled={!canMove || touched} onClick={() => probeBore(i, "camera")} title="Put the camera crosshair on the bore first">From the camera</button>}
                    <button disabled={!!busy} onClick={() => manualBore(i)} title="Jog a pointed bit or the stylus over the middle by eye">Use this position</button>
                    {m && <button className="quiet" disabled={!!busy} onClick={() => clearBore(i)}>Clear</button>}
                  </span>
                  {m?.manual && <span className="measure-grid">
                    <label className="stack">Machine X (mm)<NumInput digits={3} value={m.x} onChange={(v) => { const meas = D.measured.slice(); meas[i] = { ...m, x: v }; patch({ measured: meas, sol: null }); }} /></label>
                    <label className="stack">Machine Y (mm)<NumInput digits={3} value={m.y} onChange={(v) => { const meas = D.measured.slice(); meas[i] = { ...m, y: v }; patch({ measured: meas, sol: null }); }} /></label>
                  </span>}
                </li>); })}
            </ul>
            {D.sol && <div className={D.sol.ok ? "okbox" : "warnbox"}>
              <p>Turned <b>{D.sol.angle.toFixed(3)}°</b>, program X0 Y0 at machine X {fmt(D.sol.origin.x)} Y {fmt(D.sol.origin.y)}.</p>
              {D.sol.pairs.map((p) => <p key={p.a + p.b} className={Math.abs(p.err) > D.sol.tol ? "err" : "dim"}>{p.a}–{p.b}: {fmt(p.measured)} mm measured, {fmt(p.expected)} expected ({p.err >= 0 ? "+" : ""}{fmt(p.err)} mm; limit ±{D.sol.tol})</p>)}
              {D.sol.problems.map((t) => <p key={t} className="err">{t}</p>)}
              {D.sol.warnings.map((t) => <p key={t}>{t}</p>)}
            </div>}
            <p className="dim">To put the stylus over a bore by eye, or the camera crosshair on it (Camera tab), press Hide to jog, jog, then come back with the button at the bottom of the screen.{camOff ? "" : " From the camera needs the camera offset calibrated on the Camera tab."}</p>
            {!D.flip && <p><button className="primary" disabled={!canMove || !allMeasured || !D.sol?.ok} onClick={lineUp}>{busy === "lineup" ? "Lining up…" : "Line up side B and set X/Y zero"}</button></p>}
          </>}

          {kind === "tool" && part && <>
            <p>{k === 0 ? "Take the 3D probe out." : `Part ${k} is done. Take T${D.plan[k - 1].tool} out.`} Put in <b>{toolLine(part)}</b>{stick ? <>, with at least <b>{stick} mm</b> below the collet</> : ""}.</p>
            {k === 0 && <p className="dim">Unplug the probe cable{setter && typeof setter.x === "number" ? " (leave the tool setter plugged in)" : ""}.</p>}
          </>}

          {kind === "zset" && part && <>
            {refOk ? <>
              <p>Measure <b>T{part.tool}</b> on the tool setter. Z zero follows the cutter; X and Y stay as they are.</p>
              {setter && !setter.corr && setter.ref?.by === "probe" && <p className="warnbox">The probe hasn't been calibrated against a cutter on the setter yet, so Z can be off by a fraction of a millimetre. Calibrate once on the Tool setter screen.</p>}
              <p><button className="primary" disabled={!canMove || touched} onClick={measureTool}>{busy === "setter" ? "Measuring…" : "Measure on the tool setter"}</button></p>
            </> : <p>{setter && typeof setter.x === "number" ? "There's no current tool setter reference (Z zero changed since it was taken)." : "No tool setter is saved."} Set Z for this cutter with the touch plate.</p>}
            <p><button disabled={!homed || !idle || !!busy} onClick={plateZ}>Probe Z with the touch plate…</button></p>
            {D.zByPlate && !D.zDone?.[k] && <p className="dim">Back from Probe Z. If it finished, press Next.</p>}
          </>}

          {kind === "router" && part && <>
            <p>Switch the router <b>ON</b>{S.dial ? <> at dial <b>{S.dial}</b></> : ""}{S.rpm ? ` (about ${S.rpm} rpm)` : ""} and let it reach speed. The program starts moving as soon as you press Run.</p>
            <label className="check"><input type="checkbox" checked={!!D.routerOn?.[k]} onChange={(e) => patch({ routerOn: { ...(D.routerOn || {}), [k]: e.target.checked } })} /> The router is on{S.dial ? ` at dial ${S.dial}` : ""}</label>
          </>}

          {kind === "run" && part && <>
            <p>{D.plan.length > 1 ? <>Part <b>{k + 1} of {D.plan.length}</b>: T{part.tool}, lines {part.start} to {part.end}. </> : null}The Run checklist and the setup sheet checks apply as for any program.</p>
            {!D.partFiles?.[k] ? <p><button className="primary" disabled={!idle || !!busy} onClick={preparePart}>{busy === "part" ? "Writing…" : D.plan.length > 1 ? `Write part ${k + 1}` : "Load the program"}</button></p>
              : <p><b>{D.partFiles[k]}</b> {state.selected === D.partFiles[k] ? "is loaded." : "is ready."} <button className="primary" data-autofocus disabled={!idle || mach !== "READY"} onClick={runPart}>Run…</button></p>}
            {k < D.plan.length - 1 && <p className="dim">When it ends, Z goes to the top and the wizard asks for T{D.plan[k + 1].tool}.</p>}
          </>}

          {kind === "done" && <>
            <h3>Job done</h3>
            <p>{D.plan?.length > 1 ? `All ${D.plan.length} parts ran to the end.` : "The program ran to the end."} Switch the router off{D.manual ? " at its own switch" : ""} before you unclamp.</p>
          </>}

          {!homed && kind !== "overview" && kind !== "done" && <p className="err">Home the machine first.</p>}
          {busy && D.runMoves && (() => {
            const cur = runStep === null ? -1 : moveStatus(D.runMoves, runStep).cur;
            const art = D.runKind === "bore" ? <BoreArt moves={D.runMoves} cur={cur} /> : D.runKind === "measure" ? <MeasureArt moves={D.runMoves} cur={cur} probeY={probeY} />
              : D.runKind === "setter" ? <SetterArt moves={D.runMoves} cur={cur} probe /> : null;
            const title = { bore: "Probing the bore", measure: "Measuring the stock", setter: "Touching the tool setter", move: "Moving over the stock" }[D.runKind] || "Running";
            return <div className="wz-run"><StepBody art={art}><RunProgress title={title} moves={D.runMoves} step={runStep} started={state.cycle !== "idle"} note="Keep a hand near the E-stop. Cancel stops the machine." /></StepBody></div>;
          })()}
          {msgBox}
        </div>
      </div>
    </Modal>
  );
}
