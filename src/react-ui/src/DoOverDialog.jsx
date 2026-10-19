import React, { useEffect } from "react";
import { Modal } from "./ui.jsx";
import { useUi, uiPatch } from "./shared.js";
import { api } from "./controller.js";
import { errText } from "./checkpoint.js";
import { depthList, clamp, showDepthView } from "./doover.js";

// Cut deeper (1.30.0): writes doover-<program>.nc that runs only the deepest passes of the chosen operations
// again, lower, so a profile or hole that left a skin at the bottom can be finished. Shared in the session
// ("doover"): the same fields and result on every screen.
const mm = (v) => (v === null || v === undefined ? "—" : `${(+v).toFixed(2).replace(/\.?0+$/, "")} mm`);
const zt = (v) => (v === null || v === undefined ? "—" : `Z${(+v).toFixed(3).replace(/\.?0+$/, "")}`);

function Stepper({ label, value, step, k, onChange, unit = "mm", digits = 1, hint }) {
  const set = (v) => onChange(+clamp(k, +(+v).toFixed(3)).toFixed(3));
  return (
    <div className="dv-step" role="group" aria-label={label} title={hint}>
      <span>{label}</span>
      <span className="dry-lift">
        <button type="button" aria-label={`${label}: less`} onClick={() => set(value - step)}>−</button>
        <output aria-live="polite">{(+value).toFixed(digits)} {unit}</output>
        <button type="button" aria-label={`${label}: more`} onClick={() => set(value + step)}>+</button>
      </span>
    </div>
  );
}

export default function DoOverDialog({ state, metric, onClose }) {
  const D = useUi(state, "doover").v || {};
  const patch = (p) => uiPatch("doover", p).catch(() => {});
  const { file, data = null, loading = false, err = "", opts = null, busy = false, info = null, ack = false, collet = false, zbusy = "", zmsg = null } = D;
  const setOpt = (k, v) => uiPatch("doover", (d) => ({ opts: { ...(d.opts || {}), [k]: v } })).catch(() => {});

  const analyse = async () => {
    await patch({ loading: true, err: "" });
    try {
      const r = await api.put("next-doover", { action: "analyse", file });
      await uiPatch("doover", (d) => ({
        data: r, loading: false,
        opts: d.opts || { extra: r.suggest_extra, step: r.defaults.step, start_above: r.defaults.start_above, plunge: r.defaults.plunge, tabs: "keep", pause: true, ops: r.ops.filter((o) => o.default).map((o) => o.index) },
      })).catch(() => {});
    } catch (e) { patch({ loading: false, err: errText(e) }); }
  };
  useEffect(() => { if (file && !data && !loading && !err) analyse(); }, [file, !!data]); // eslint-disable-line react-hooks/exhaustive-deps

  const idle = state.cycle === "idle";
  const run = data?.run || {};
  const restore = async (axes) => {
    patch({ zbusy: axes, zmsg: null, err: "" });
    try {
      const r = await api.put("next-doover", { action: "restore_zero", file, axes });
      patch({ zmsg: { ok: true, text: `Work zero put back on ${r.axes.map((a) => a.toUpperCase()).join(", ")} from the run of ${file}.${axes.includes("z") ? "" : " Set Z zero again the way you did for that run."}` }, zbusy: "" });
      await new Promise((ok) => setTimeout(ok, 1500));
      await analyse(); // check again with the new zero
    } catch (e) { patch({ zmsg: { ok: false, text: errText(e) }, zbusy: "" }); }
  };

  const build = async () => {
    patch({ busy: true, err: "" });
    try {
      const r = await api.put("next-doover", { action: "build", file, opts: { ...opts, ack_unknown: run.status === "unknown" && !!ack } });
      patch({ info: r, busy: false });
    } catch (e) { patch({ busy: false, err: errText(e) }); }
  };

  if (info) {
    const lw = (info.lint?.issues || []).filter((i) => i.level !== "info");
    return (
      <Modal title="Cut deeper program ready" wide onClose={onClose} actions={<>
        <button onClick={onClose}>Close</button>
        <button className="primary" data-autofocus onClick={() => { showDepthView(); onClose(); }}>Show in Depth view</button>
      </>}>
        <p><b>{info.file}</b> is loaded. Check it in the Depth view, then press Run in the Job panel. The Run checklist and the setup sheet apply to it like any program.</p>
        <dl className="rdl">
          <div className="rrow"><dt>Operations</dt><dd>{info.ops.map((o) => `${o.name} (old floor ${zt(o.floor)})`).join(", ")}</dd></div>
          <div className="rrow"><dt>New floor</dt><dd>{zt(info.deepest)}, {mm(info.extra)} deeper, at most {mm(info.step)} per pass</dd></div>
          <div className="rrow"><dt>Cuts</dt><dd>{info.passes} pass{info.passes === 1 ? "" : "es"}{info.holes ? `, ${info.holes} hole${info.holes === 1 ? "" : "s"}` : ""}, about {Math.max(1, Math.round(info.time / 60))} min</dd></div>
          <div className="rrow"><dt>Tabs</dt><dd>{info.tabs === "under" ? "cut through: the part will come free" : "kept"}</dd></div>
          <div className="rrow"><dt>Before cutting</dt><dd>{info.manual_spindle ? "Z lifts, the tool moves over the first cut and the job pauses: switch the router ON, let it reach speed, then press Start." : "Z lifts, the tool moves over the first cut and the job pauses so you can check it."}</dd></div>
        </dl>
        {info.warnings.map((w, i) => <p key={i} className="warnbox">{w}</p>)}
        {lw.length > 0 && <p className="note">G-code check: {lw.map((i) => i.msg).join(" ")}</p>}
      </Modal>
    );
  }

  const ops = data?.ops || [];
  const chosen = ops.filter((o) => opts?.ops?.includes(o.index));
  const floors = chosen.map((o) => o.floor).filter((v) => v !== null);
  const deepest = floors.length ? Math.min(...floors) - (opts?.extra || 0) : null;
  const passes = floors.length ? depthList(Math.min(...floors), opts?.extra, opts?.step) : [];
  const intoBoard = data?.stock_bottom !== null && data?.stock_bottom !== undefined && deepest !== null ? data.stock_bottom - deepest : null;
  const blocked = run.status === "interrupted" || run.status === "moved" || (run.status === "unknown" && !ack) || run.homed === false;
  const toggleOp = (i) => setOpt("ops", opts.ops.includes(i) ? opts.ops.filter((x) => x !== i) : [...opts.ops, i].sort((a, b) => a - b));
  const anyTabs = chosen.some((o) => o.tabs > 0);

  return (
    <Modal title="Cut deeper" wide onClose={onClose} actions={<>
      <button onClick={onClose}>Cancel</button>
      <button className="primary" disabled={!data || !opts || busy || !idle || blocked || !chosen.length} onClick={build}>{busy ? "Writing…" : `Write ${data?.output || "program"}`}</button>
    </>}>
      <p>For a cut that did not go all the way through: this writes a new program that runs only the deepest passes of <b>{file}</b> again, lower, in steps. It goes down through the old cut at a feed to just above the old floor, then cuts into what is left. Everything above the old floor is skipped. Nothing moves until you press Run.</p>
      {loading && <p className="dim">Reading {file}…</p>}
      {err && <p className="warnbox" role="alert">{err}</p>}
      {data && (
        <>
          {run.status === "ok" && <p className="okbox">{run.msg}</p>}
          {run.status === "interrupted" && <div className="live-warn stop" role="alert"><p><b>Last run did not finish.</b> {run.msg}</p></div>}
          {run.status === "moved" && (
            <div className="live-warn stop" role="alert">
              <p><b>WRONG ZERO.</b> {run.msg}</p>
              <label className="check"><input type="checkbox" checked={collet} onChange={(e) => patch({ collet: e.target.checked })} /> The cutter hasn't been taken out of the collet or moved in it since the run</label>
              <div className="rbtns">
                <button className="primary" disabled={!!zbusy || !idle || !collet || run.homed === false} onClick={() => restore("xyz")}>{zbusy === "xyz" ? "Restoring…" : "Put back X, Y and Z"}</button>
                <button disabled={!!zbusy || !idle || run.homed === false} onClick={() => restore("xy")}>{zbusy === "xy" ? "Restoring…" : "Put back X and Y only"}</button>
              </div>
            </div>
          )}
          {run.status === "unknown" && (
            <div className="warnbox">
              <p>{run.msg}</p>
              <label className="check"><input type="checkbox" checked={!!ack} onChange={(e) => patch({ ack: e.target.checked })} /> The stock has not moved, the work zero and the tool are the same as for that run, and it ran to the end</label>
            </div>
          )}
          {zmsg && <p className={zmsg.ok ? "okbox" : "warnbox"} role="status">{zmsg.text}</p>}
          {(run.notes || []).map((n, i) => <p key={i} className="warnbox">{n}</p>)}

          <h3 className="dv-h">Operations</h3>
          <ul className="dv-ops">
            {ops.map((o) => (
              <li key={o.index} className={o.reason ? "off" : ""}>
                <label className="check">
                  <input type="checkbox" disabled={!!o.reason} checked={!!opts?.ops?.includes(o.index)} onChange={() => toggleOp(o.index)} />
                  <span><b>{o.name}</b>{o.tool !== null && o.tool !== undefined ? ` · T${o.tool}` : ""} · deepest {zt(o.floor)} · lines {o.lines[0]}–{o.lines[1]}
                    <small>{o.reason ? `Can't be cut deeper: it ${o.reason}.` : [o.passes ? `${o.passes} pass${o.passes === 1 ? "" : "es"} along the bottom` : "", o.holes ? `${o.holes} hole${o.holes === 1 ? "" : "s"}` : "", o.tabs ? `${o.tabs} tab${o.tabs === 1 ? "" : "s"}` : ""].filter(Boolean).join(", ")}</small>
                  </span>
                </label>
              </li>
            ))}
          </ul>
          {opts && (
            <div className="rform">
              <Stepper label="Extra depth" k="extra" value={opts.extra} step={0.1} digits={2} onChange={(v) => setOpt("extra", v)} hint="How much deeper than the old floor the new program cuts" />
              <Stepper label="Start above the old floor" k="start_above" value={opts.start_above} step={0.1} onChange={(v) => setOpt("start_above", v)} hint="Where the slow feed into the leftover material starts" />
              <Stepper label="Deepest step per pass" k="step" value={opts.step} step={0.1} onChange={(v) => setOpt("step", v)} hint="1 mm is the aluminum baseline" />
              <Stepper label="Feed into the material" k="plunge" value={opts.plunge} step={50} digits={0} unit="mm/min" onChange={(v) => setOpt("plunge", v)} />
              {anyTabs && (
                <div className="dv-tabs" role="radiogroup" aria-label="Tabs">
                  <span>Tabs</span>
                  <label className="check"><input type="radio" name="dv-tabs" checked={opts.tabs !== "under"} onChange={() => setOpt("tabs", "keep")} /> Keep (go over them)</label>
                  <label className="check"><input type="radio" name="dv-tabs" checked={opts.tabs === "under"} onChange={() => setOpt("tabs", "under")} /> Cut through (the part comes free)</label>
                </div>
              )}
              <label className="check"><input type="checkbox" checked={opts.pause !== false} onChange={(e) => setOpt("pause", e.target.checked)} /> Pause over the first cut so I can check it</label>
            </div>
          )}
          {chosen.length > 0 && opts && (
            <p className="note">New floor {zt(deepest)}, passes at {passes.map(zt).join(", ")}{metric ? "" : ` (${(opts.extra / 25.4).toFixed(4)} in deeper)`}. The program is written in mm.</p>
          )}
          {intoBoard !== null && intoBoard > 1 && <p className="warnbox">The new floor is {mm(intoBoard)} below the bottom of the stock on the setup sheet: that cuts into the spoilboard.</p>}
          {data.stock_bottom === null && <p className="note">The setup sheet has no stock Z range, so the new floor can't be checked against the bottom of the stock.</p>}
          {!idle && <p className="warnbox">Wait until the machine is idle.</p>}
        </>
      )}
    </Modal>
  );
}
