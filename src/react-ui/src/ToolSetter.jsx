import React, { useEffect, useMemo, useRef, useState } from "react";
import { NumInput, Modal } from "./ui.jsx";
import { ME, useUi, useDriver, uiGet, uiCas, uiUpdate, uiPatch, uiClose } from "./shared.js";
import { api } from "./controller.js";
import { computeAxis } from "./axis.js";
import { getPrefs, setPrefs } from "./checkpoint.js";
import { SETTER_DEFAULTS, SETTER_FAILS, CORR_MAX, setterProgram, refStatus, probeActive, probeCorrection } from "./setter.js";
import { programMoves, moveStatus } from "./progress.js";
import { RunProgress, Outcome, useRunStep, StepBody } from "./steps.jsx";
import { SetterArt } from "./art.jsx";

// Tool setter screen: save where the setter is, take the reference with a
// tool whose Z zero is right, and measure each new tool so Z stays right.

export async function getSetter() {
  const p = await getPrefs();
  return { ...SETTER_DEFAULTS, ...(p.setter || {}) };
}
export const saveSetter = (s) => setPrefs({ setter: s });

// Runs a setter program and resolves with the controller state when it ends.
export function useProgramRunner(state, subscribe, send) {
  const R = useRef({ state });
  R.current.state = state;
  useEffect(() => subscribe((d) => {
    const r = R.current;
    if (d.log?.msg === "Switch not found" && r.running) r.notFound = true;
    if (d.cycle !== undefined && r.running) {
      if (d.cycle !== "idle") r.started = true;
      else if (r.started) { r.running = false; setTimeout(() => r.resolve({ ...R.current.state, notFound: r.notFound }), 400); }
    }
  }), [subscribe]);
  return (prog) => new Promise((resolve) => {
    Object.assign(R.current, { running: true, started: false, notFound: false, resolve });
    send(prog);
  });
}

export function setterArgs(state, config, setter, mode, ref) {
  const z = computeAxis(state, config, "z", true);
  return {
    mode, ref, setter: { x: setter.x, y: setter.y, z: setter.z },
    top: z.max - 1, back: { x: state.xp || 0, y: state.yp || 0 },
    clear: setter.clear, travel: setter.travel,
    fast: config.probe["probe-fast-seek"], slow: config.probe["probe-slow-seek"],
  };
}

export default function ToolSetter({ config, state, send, subscribe, metric, onClose, openId }) {
  const [s, setS] = useState(null);
  // What the dialog shows (busy, the last message, advanced open) is shared, key "setter".
  // The setter's position and reference are saved in prefs, which every screen re-reads when it changes.
  const ui = useUi(state, "setter");
  const D = ui.v && ui.v.id === openId ? ui.v : null;
  const isDriver = useDriver(state, "setter", D);
  const busy = D?.busy || "", msg = D?.msg || null, adv = !!D?.adv;
  const setMsg = (m) => uiPatch("setter", { msg: m }).catch(() => {});
  const setAdv = (fn) => uiPatch("setter", (d) => ({ adv: typeof fn === "function" ? fn(!!d.adv) : fn })).catch(() => {});
  const run = useProgramRunner(state, subscribe, send);
  const local = useRef(false); // a setter program started on this screen is running
  useEffect(() => {
    getSetter().then(setS);
    const f = () => getSetter().then(setS);
    window.addEventListener("next-store:prefs", f);
    return () => window.removeEventListener("next-store:prefs", f);
  }, []);
  useEffect(() => {
    if (D) return;
    (async () => { const cur = await uiGet("setter"); if (cur.v && cur.v.id === openId) return; await uiCas("setter", { id: openId, driver: ME, busy: "", msg: null, adv: false }, cur.rev); })().catch(() => {});
  }, [openId, !!D]); // eslint-disable-line react-hooks/exhaustive-deps
  // Took this dialog over from a screen that went away in the middle of a measurement.
  useEffect(() => {
    if (!isDriver || !busy || local.current) return undefined;
    const t = setTimeout(() => {
      if (state.cycle === "idle") uiPatch("setter", { busy: "", msg: { ok: false, text: "The screen that started this measurement went away before it finished. Check Z zero before cutting, or measure again." } }).catch(() => {});
    }, 8000);
    return () => clearTimeout(t);
  }, [isDriver, busy, state.cycle]);
  const close = () => { uiClose("setter"); uiClose("tool"); onClose && onClose(); };

  const u = metric ? 1 : 25.4, unit = metric ? "mm" : "in";
  const fmt = (mm) => (mm / u).toFixed(metric ? 3 : 4);
  const homed = !!config && ["x", "y", "z"].every((a) => computeAxis(state, config, a, metric).homed);
  const idle = state.cycle === "idle" && state.xx !== "ESTOPPED";
  const touched = probeActive(state);
  const located = s && typeof s.x === "number";
  const ref = s ? refStatus(s.ref, state) : { ok: false };
  const canMove = homed && idle && !touched && located && !busy;
  const lp = s?.lastProbe;
  // Calibrating needs a probe reference, then a cutter whose Z was set by Probe Z after it (so Z zero changed).
  const calibReady = !!lp && typeof state.offset_z === "number" && Math.abs(state.offset_z - lp.offZ) > 0.01;
  const corr = s?.corr;

  const update = (fn) => setS((x) => { const n = fn({ ...x }); saveSetter(n); return n; });
  // The running program's moves (progress marks, see progress.js) and the one running now (1.31.1)
  const moves = useMemo(() => {
    if (!busy || !s || typeof s.x !== "number" || !config) return [];
    try { return programMoves(setterProgram(setterArgs(state, config, s, busy === "calib" ? "ref" : busy, s.ref?.ref))); } catch { return []; }
  }, [busy, s, !!config]); // eslint-disable-line react-hooks/exhaustive-deps
  const runStep = useRunStep(state.of_step, busy && D?.runAt ? `${busy}:${D.runAt}` : null);

  const saveLocation = () => {
    update((x) => ({ ...x, x: state.xp, y: state.yp, z: state.zp, ref: null, lastProbe: null }));
    setMsg({ ok: true, text: "Setter position saved. The old reference was cleared: take a new one with a tool whose Z zero is right." });
  };

  const go = async (mode) => {
    // Only one screen runs it: the one whose press the controller accepted first.
    const r = await uiUpdate("setter", (d) => (d && d.id === openId && !d.busy ? { ...d, busy: mode, msg: null, driver: ME, runAt: Date.now() } : undefined)).catch(() => ({ ok: false }));
    if (!r.ok) return;
    local.current = true;
    const res = await run(setterProgram(setterArgs(state, config, s, mode === "calib" ? "ref" : mode, s.ref?.ref)));
    local.current = false;
    await uiPatch("setter", { busy: "" }).catch(() => {});
    if (res.notFound) { setMsg({ ok: false, text: "The tool didn't reach the setter. The controller stopped with an emergency stop. Check the setter position and its cable, clear the E-stop and try again." }); return; }
    if (res.ofs_ok !== 1) { setMsg({ ok: false, text: SETTER_FAILS[res.ofs_fail] || "The setter routine didn't finish. Z zero was not changed." }); return; }
    if (mode === "calib") {
      const c = probeCorrection(s.lastProbe?.ref, res.ofs_ref);
      if (!c.ok) {
        setMsg({ ok: false, text: c.why === "big"
          ? `The cutter and the probe differ by ${fmt(Math.abs(c.c))} ${unit}, more than ${fmt(CORR_MAX)} ${unit}. That's far more than the switches' travel, so the stock has probably moved, or Probe Z wasn't run on the same stock top. Nothing was saved. Run Measure stock again and repeat.`
          : "There's no probe reference to compare with. Run Measure stock with the tool setter step first." });
        return;
      }
      update((x) => ({ ...x, corr: { c: c.c, time: Date.now() }, ref: { ref: res.ofs_ref, offZ: res.offset_z, time: Date.now(), by: "tool" } }));
      setMsg({ ok: true, text: `Calibrated. The probe reads ${fmt(Math.abs(c.c))} ${unit} ${c.c >= 0 ? "higher" : "lower"} on the setter than a cutter does, and that's now taken off every reference Measure stock takes. This cutter's reference is saved too, so Measure tool works straight away.` });
      return;
    }
    if (mode === "ref") {
      update((x) => ({ ...x, ref: { ref: res.ofs_ref, offZ: res.offset_z, time: Date.now(), by: "tool" } }));
      setMsg({ ok: true, text: "Reference taken. From now on, measure each new tool here and Z zero follows it." });
    } else {
      update((x) => ({ ...x, ref: { ...x.ref, offZ: res.offset_z } }));
      setMsg({ ok: true, text: "Tool measured. Z zero is set for this tool, on the same stock top as before." });
    }
  };

  const status = !located ? "Setter position not saved yet."
    : ref.ok ? `Reference taken ${new Date(s.ref.time).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })}${s.ref.by === "probe" ? ` with the 3D probe after Measure stock${s.ref.corrected ? ", corrected for the probe" : ""}` : ""}.`
    : ref.why === "moved" ? "Z zero has been changed since the reference was taken (for example by Probe Z), so the reference no longer matches. Take a new one."
    : "No reference yet.";

  return (
    <Modal title="Tool setter" wide onClose={close} actions={<button data-autofocus onClick={close}>Close</button>}>
      {!s ? <p>Loading…</p> : busy ? <div className="setter"><StepBody title={busy === "tool" ? "Measuring the tool" : busy === "calib" ? "Calibrating with this cutter" : "Taking the reference"}
          art={<SetterArt moves={moves} cur={runStep === null ? -1 : moveStatus(moves, runStep).cur} />}>
          <RunProgress title="Tool setter" moves={moves} step={runStep} started={state.cycle !== "idle"} />
          <p><button className="danger" onClick={() => api.put("stop").catch(() => {})}>Stop</button></p>
        </StepBody></div> : <div className="setter">
        {msg && <Outcome ok={msg.ok} title={msg.ok ? "Done" : "Stopped"}><p>{msg.text}</p></Outcome>}
        <p className={ref.ok ? "" : "dim"}>{status}</p>

        <div className="setter-actions">
          <div>
            <button className="primary big" disabled={!canMove || !ref.ok} onClick={() => go("tool")}>{busy === "tool" ? "Measuring…" : "Measure tool"}</button>
            <small>After a tool change. Sets Z zero for the new tool.</small>
          </div>
          <div>
            <button disabled={!canMove} onClick={() => go("ref")}>{busy === "ref" ? "Measuring…" : "Take reference with this tool"}</button>
            <small>Only when this tool's Z zero is right, for example straight after Probe Z. Measure stock does this for you with the 3D probe.</small>
          </div>
          <div>
            <button disabled={!homed || !idle || !!busy} onClick={saveLocation}>{located ? "Save setter position again" : "Save setter position"}</button>
            <small>Jog the tool over the middle of the setter, about 5 {metric ? "mm" : "mm (¼ in)"} above it, then save. Do this once, and again if you move the setter.</small>
          </div>
        </div>

        {ref.ok && s.ref.by === "probe" && !s.ref.corrected && <p className="err">This reference was taken with the 3D probe before the probe was calibrated against a cutter, so tools measured from it can be off by a fraction of a millimeter. Calibrate once (below), then they'll match.</p>}

        <section className="setter-calib" aria-label="Probe calibration">
          <h3>Probe vs cutter calibration</h3>
          {corr ? <p>Calibrated {new Date(corr.time).toLocaleDateString()}: the probe reads {fmt(Math.abs(corr.c))} {unit} {corr.c >= 0 ? "higher" : "lower"} on the setter than a cutter. Measure stock corrects for it.</p>
            : <p className="dim">Not calibrated yet. The probe and a cutter trip the setter at slightly different points, so do this once before relying on Measure stock with the setter.</p>}
          <ol className="dim">
            <li>Run <b>Measure stock</b> with the tool setter step ticked.{lp ? ` Done ${new Date(lp.time).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })}.` : ""}</li>
            <li>Without moving the stock, put a cutter in and run <b>Probe Z</b> with the touch plate on the stock top.</li>
            <li>Press <b>Calibrate with this cutter</b>.</li>
          </ol>
          <button disabled={!canMove || !calibReady} onClick={() => go("calib")}>{busy === "calib" ? "Measuring…" : corr ? "Calibrate again with this cutter" : "Calibrate with this cutter"}</button>
          {!lp && <small>Needs step 1 first.</small>}
          {lp && !calibReady && <small>Z zero hasn't changed since Measure stock. Run Probe Z with the cutter first (step 2).</small>}
          {corr && <button className="quiet" disabled={!!busy} onClick={() => update((x) => ({ ...x, corr: null }))}>Clear calibration</button>}
        </section>

        {touched && <p className="err">The probe input reads as touched. With normally-closed wiring that also means a probe or setter is unplugged: plug it in, or fit the shorting plug.</p>}
        {!homed && <p className="err">Home the machine first. The setter position is in machine coordinates.</p>}

        <button className="quiet" onClick={() => setAdv((a) => !a)}>{adv ? "Hide" : "Show"} details</button>
        {adv && <div className="measure-grid">
          <label className="stack">Clearance above the saved height ({unit})
            <NumInput digits={3} min={0} value={s.clear / u} onChange={(n) => update((x) => ({ ...x, clear: n * u }))} />
            <small>How much longer a new tool can be than the one used to save the position.</small></label>
          <label className="stack">Keep-out radius ({unit})
            <NumInput digits={3} min={0} value={(s.keep || SETTER_DEFAULTS.keep) / u} onChange={(n) => update((x) => ({ ...x, keep: n * u }))} />
            <small>Programs that move within this distance of the setter's center (plus the cutter's radius) and below its top are stopped before they run. Make it at least the setter's widest point from its center, including any bracket.</small></label>
          {located && <p className="dim">Setter at machine X {fmt(s.x)}, Y {fmt(s.y)}, Z {fmt(s.z)} {unit}.{s.ref ? ` Reference ${fmt(s.ref.ref)} ${unit}.` : ""}</p>}
        </div>}
      </div>}
    </Modal>
  );
}
