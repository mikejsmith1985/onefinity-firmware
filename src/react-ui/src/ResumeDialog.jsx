import React, { useEffect } from "react";
import { Modal, SharedText } from "./ui.jsx";
import { useUi, uiPatch } from "./shared.js";
import { api } from "./controller.js";
import { computeAxis } from "./axis.js";
import { getPrefs, setPrefs, errText } from "./checkpoint.js";

const Row = ({ k, v }) => <div className="rrow"><dt>{k}</dt><dd>{v}</dd></div>;

// Builds a program that continues the interrupted job and loads it.
// The dialog lives in the shared session ("resume"): its fields, progress and result are the same on every screen.
export default function ResumeDialog({ cp, state, config, metric, onClose }) {
  const D = useUi(state, "resume").v || {};
  const patch = (p) => uiPatch("resume", p).catch(() => {});
  const { prefs = null, busy = false, err = "", info = null, collet = false, zbusy = "", zmsg = null } = D;
  const setBusy = (v) => patch({ busy: v }), setErr = (v) => patch({ err: v }), setInfo = (v) => patch({ info: v });
  const setCollet = (v) => patch({ collet: v }), setZbusy = (v) => patch({ zbusy: v }), setZmsg = (v) => patch({ zmsg: v });
  useEffect(() => { if (!prefs) getPrefs().then((p) => uiPatch("resume", (d) => (d.prefs ? {} : { prefs: p })).catch(() => {})); }, [!!prefs]); // eslint-disable-line react-hooks/exhaustive-deps

  const axes = config ? ["x", "y", "z"].map((a) => computeAxis(state, config, a, metric)) : [];
  const homed = axes.length > 0 && axes.every((a) => a.homed);
  const idle = state.cycle === "idle";
  const edit = (k, v) => uiPatch("resume", (d) => ({ prefs: { ...(d.prefs || {}), [k]: v } })).catch(() => {});

  // Work zero: the checkpoint saved where it was when the job stopped. On a homed machine that is valid again,
  // so it can be put back without probing a part that is already half cut.
  const saved = cp.offset || {};
  const tol = 0.05; // mm (offsets are mm in both unit modes)
  const diff = ["x", "y", "z"].filter((a) => typeof saved[a] === "number" && typeof state[`offset_${a}`] === "number" && Math.abs(state[`offset_${a}`] - saved[a]) > tol);
  const restore = async (axes, rebuild) => {
    setZbusy(axes); setZmsg(null); setErr("");
    try {
      const r = await api.put("next-resume", { action: "restore_zero", axes });
      setZmsg({ ok: true, text: `Work zero put back on ${r.axes.map((a) => a.toUpperCase()).join(", ")} from when the job stopped.${axes.includes("z") ? "" : " Set Z zero again before running."}` });
      if (rebuild) { await new Promise((ok) => setTimeout(ok, 1500)); await build(); }
    } catch (e) { setZmsg({ ok: false, text: errText(e) }); }
    setZbusy("");
  };
  const fmtOff = (v) => (metric ? `${v.toFixed(3)} mm` : `${(v / 25.4).toFixed(4)} in`);
  const zeroBox = (rebuild) => (
    <div className="warnbox">
      <p>Your work zero has changed since the job stopped ({diff.map((a) => `${a.toUpperCase()} by ${fmtOff(state[`offset_${a}`] - saved[a])}`).join(", ")}). Running now would cut in the wrong place.</p>
      <p>The zero from when it stopped is saved, and it is valid again on a homed machine, so you can put it back without probing the part.</p>
      <label className="check"><input type="checkbox" checked={collet} onChange={(e) => setCollet(e.target.checked)} /> The cutter hasn't been taken out of the collet or moved in it since the job stopped</label>
      <div className="rbtns">
        <button className="primary" disabled={!!zbusy || !homed || !idle || !collet} onClick={() => restore("xyz", rebuild)}>{zbusy === "xyz" ? "Restoring…" : "Put back X, Y and Z"}</button>
        <button disabled={!!zbusy || !homed || !idle} onClick={() => restore("xy", rebuild)}>{zbusy === "xy" ? "Restoring…" : "Put back X and Y only"}</button>
      </div>
      <small>Use X and Y only if the cutter was changed or re-seated: then set Z zero again on an uncut part of the stock top before running.</small>
    </div>
  );
  const zeroMsg = zmsg && <p className={zmsg.ok ? "okbox" : "warnbox"} role="status">{zmsg.text}</p>;

  const build = async () => {
    setBusy(true); setErr("");
    try {
      await setPrefs({ spinup: prefs.spinup, plunge: prefs.plunge, pause: prefs.pause });
      setInfo(await api.put("next-resume", { action: "build", opts: { spinup: +prefs.spinup, plunge: +prefs.plunge, pause: !!prefs.pause } }));
    } catch (e) { setErr(errText(e)); }
    setBusy(false);
  };

  if (info) {
    const p = info.pos || {};
    const u = info.units;
    return (
      <Modal title="Resume program ready" onClose={onClose} actions={<button className="primary" data-autofocus onClick={onClose}>Close</button>}>
        <p><b>{info.file}</b> is loaded. Check the points below, then press Run in the Job panel.</p>
        <dl className="rdl">
          <Row k="Restarts at line" v={`${info.line}: ${info.line_text}`} />
          {info.located && <Row k="Found from" v={info.saved_line !== info.line ? `where the tool is now (saved line was ${info.saved_line})` : "where the tool is now, which matches the saved line"} />}
          <Row k="Start point" v={["x", "y", "z"].filter((a) => p[a] !== undefined).map((a) => `${a.toUpperCase()} ${p[a]}`).join("   ") + ` ${u}`} />
          <Row k="Tool" v={info.tool !== null && info.tool !== undefined ? `T${info.tool} must be in the spindle` : "not set by the program"} />
          <Row k="Spindle" v={info.spindle === "off" ? "off at this point" : `${info.spindle} ${Math.round(info.speed || 0)} rpm, ${info.spinup} s to reach speed`} />
          <Row k="Before cutting" v={info.manual_spindle ? "Z lifts to the top, the tool moves over the start point and the job pauses: switch the router ON at its own switch, let it reach speed, then press Start. The tool only goes down after that." : info.pause ? "Z lifts to the top, the tool moves over the start point and the job pauses so you can check it" : "Z lifts to the top and the tool moves over the start point"} />
        </dl>
        {!info.offset_ok && (diff.length ? zeroBox(true) : <p className="warnbox">Your work zero is not where it was when the job was interrupted ({Object.entries(info.offset_delta).map(([a, d]) => `${a.toUpperCase()} off by ${d}`).join(", ")}). Set the zero again before running, or the cut will be in the wrong place.</p>)}
        {zeroMsg}
        {info.warnings.map((w, i) => <p key={i} className="warnbox">{w}</p>)}
        <p className="note">The tool is lowered slowly to the start point and assumes Z0 is the top of the stock. Resume is accurate to how repeatably the machine homes, so use it for roughing and pocketing, and check finishing passes.</p>
      </Modal>
    );
  }

  return (
    <Modal title="Resume job" onClose={onClose} actions={<>
      <button onClick={onClose}>Cancel</button>
      <button className="primary" disabled={busy || !prefs || !homed || !idle} onClick={build}>{busy ? "Building…" : "Build resume program"}</button>
    </>}>
      <p>Continue <b>{cp.file}</b> from line {Number(cp.line).toLocaleString()}. This writes a new program that moves to the restart point, starts the spindle and carries on. If the tool is still on the program's path, the restart point is found from where the tool is, which can be ahead of the saved line. Nothing moves until you press Run.</p>
      <ol className="rsteps">
        <li className={homed ? "ok" : "todo"}>{homed ? "Machine is homed." : "Home the machine first (X, Y and Z). The saved point is only valid after homing."}</li>
        <li>Put the same tool back in the spindle{cp.tool ? <> (T{cp.tool})</> : null} and make sure the stock has not moved.</li>
        <li className={diff.length ? "todo" : "ok"}>{diff.length ? "Work zero has changed since the job stopped. Put it back below." : "Work zero is the same as when the job stopped."}</li>
      </ol>
      {diff.length > 0 && homed && zeroBox(false)}
      {zeroMsg}
      {prefs && (
        <div className="rform">
          <label>Spindle spin-up wait (seconds)<SharedText inputMode="numeric" value={String(prefs.spinup ?? "")} onChange={(v) => edit("spinup", v)} /></label>
          <label>Plunge speed (mm/min)<SharedText inputMode="numeric" value={String(prefs.plunge ?? "")} onChange={(v) => edit("plunge", v)} /></label>
          <label className="check"><input type="checkbox" checked={!!prefs.pause} onChange={(e) => edit("pause", e.target.checked)} /> Pause over the start point so I can check it</label>
        </div>
      )}
      {err && <p className="warnbox" role="alert">{err}</p>}
    </Modal>
  );
}
