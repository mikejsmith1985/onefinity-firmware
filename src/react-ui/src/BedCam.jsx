import React, { useEffect, useMemo, useRef, useState } from "react";
import { api } from "./controller.js";
import { remoteGet, remotePut } from "./store.js";
import { computeAxis, fmtLen } from "./axis.js";
import { errText } from "./checkpoint.js";
import { probeActive } from "./setter.js";
import { useProgramRunner } from "./ToolSetter.jsx";
import { readSetup } from "./setup.js";
import {
  calibrate, revive, toPixel, findStock, stockInMachine, fitCheck, travelArea, thin,
  bedTouchProgram, liftProgram, parkProgram,
} from "./bedcam.js";

// Bed camera (1.36.0): a camera above the table looking down.
//  - Calibrate: the 3D probe touches the bed at a few spots and you tap the stylus in the picture.
//  - Empty-bed picture: what the bed looks like with nothing on it, gantry parked.
//  - Find stock: park, take a picture, compare it with the empty bed, outline what's new.
//    Measure stock then starts from there (position, size), and the probe measures it exactly.
//  - Program fit: the loaded program drawn on the picture and checked against the stock outline.
// All positions are machine coordinates, valid while the machine is homed.

const LIFT = 60;               // mm the probe lifts for the camera-height taps
const FRESH = 30 * 60 * 1000;  // a found stock is offered to Measure stock for 30 minutes

export const loadBedcam = () => remoteGet("bedcam").then((d) => d || {});
export async function saveBedcam(patch) {
  const cur = (await remoteGet("bedcam")) || {};
  const next = { ...cur, ...patch };
  await remotePut("bedcam", next);
  return next;
}
// The found stock, if it is recent and the calibration is there (used by Measure stock)
export function freshLocated(doc) {
  const l = doc && doc.located;
  if (!l || !doc.cal || Date.now() - l.time > FRESH) return null;
  return l;
}

// A still picture from the controller: {url, w, h, data (ImageData)}
async function takePicture() {
  const r = await fetch(`/api/camera/frame?t=${Date.now()}`, { cache: "no-store" });
  if (!r.ok) throw new Error("No picture from the camera. Is it plugged in?");
  const url = URL.createObjectURL(await r.blob());
  return loadPicture(url);
}
function loadPicture(url) {
  return new Promise((resolve, reject) => {
    const im = new Image();
    im.onload = () => {
      const cv = document.createElement("canvas"); cv.width = im.naturalWidth; cv.height = im.naturalHeight;
      const g = cv.getContext("2d"); g.drawImage(im, 0, 0);
      resolve({ url, w: cv.width, h: cv.height, data: g.getImageData(0, 0, cv.width, cv.height), canvas: cv });
    };
    im.onerror = () => reject(new Error("The camera picture could not be read."));
    im.src = url;
  });
}

// The picture with drawings on top. Taps come back in picture pixels.
function Picture({ pic, live, overlay, onTap, zoomAt, onZoomTap }) {
  const ref = useRef(null);
  const tap = (e) => {
    if (!onTap || !pic) return;
    const b = ref.current.getBoundingClientRect();
    onTap({ x: ((e.clientX - b.left) / b.width) * pic.w, y: ((e.clientY - b.top) / b.height) * pic.h });
  };
  const w = pic ? pic.w : 1280, h = pic ? pic.h : 720;
  return (
    <div className="bedpic-wrap">
      <div className="bedpic">
        {live || !pic ? <img src="/api/video" alt="Camera view" /> : <img src={pic.url} alt="Camera picture" />}
        <svg ref={ref} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" onClick={tap} style={{ cursor: onTap ? "crosshair" : "default" }}>{overlay}</svg>
      </div>
      {zoomAt && pic && <Zoom pic={pic} at={zoomAt} onTap={onZoomTap} />}
    </div>
  );
}

// 4x close-up around a tap, so it can be placed on the stylus exactly
function Zoom({ pic, at, onTap }) {
  const ref = useRef(null), R = 30, S = 6;
  useEffect(() => {
    const cv = ref.current; if (!cv) return;
    const g = cv.getContext("2d"); g.imageSmoothingEnabled = false;
    g.fillStyle = "#000"; g.fillRect(0, 0, cv.width, cv.height);
    g.drawImage(pic.canvas, at.x - R, at.y - R, 2 * R, 2 * R, 0, 0, 2 * R * S, 2 * R * S);
    g.strokeStyle = "#ffcc00"; g.lineWidth = 1;
    g.beginPath(); g.moveTo(R * S, 0); g.lineTo(R * S, 2 * R * S); g.moveTo(0, R * S); g.lineTo(2 * R * S, R * S); g.stroke();
  }, [pic, at.x, at.y]);
  const tap = (e) => {
    const b = ref.current.getBoundingClientRect();
    onTap({ x: at.x - R + ((e.clientX - b.left) / b.width) * 2 * R, y: at.y - R + ((e.clientY - b.top) / b.height) * 2 * R });
  };
  return <div className="bedzoom"><canvas ref={ref} width={2 * R * S} height={2 * R * S} onClick={tap} /><small className="dim">Close-up: tap again here to place it exactly.</small></div>;
}

const Dot = ({ p, c = "#ffcc00", r = 7 }) => <g><circle cx={p.x} cy={p.y} r={r} fill="none" stroke={c} strokeWidth="2.5" /><circle cx={p.x} cy={p.y} r="1.5" fill={c} /></g>;
const Poly = ({ pts, c, w = 3, dash, fill = "none" }) => pts && pts.length > 1
  ? <polygon points={pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ")} fill={fill} stroke={c} strokeWidth={w} strokeDasharray={dash} vectorEffect="non-scaling-stroke" /> : null;

export default function BedCam({ state, cfg, idle, send, subscribe, path, onMeasure }) {
  const config = cfg.config;
  const metric = !config || (config.settings?.units || "METRIC") === "METRIC";
  const len = (mm, p = 1) => `${fmtLen(mm, metric, p)} ${metric ? "mm" : "in"}`;
  const run = useProgramRunner(state, subscribe, send);

  const [doc, setDoc] = useState(null);
  const [camSt, setCamSt] = useState(null);
  const [pic, setPic] = useState(null);        // the still on screen (null = live)
  const [busy, setBusy] = useState("");
  const [msg, setMsg] = useState(null);        // {ok, text}
  const [mode, setMode] = useState(null);      // null | "calib" | "found" | "manual" | "fit"
  const [cal, setCal] = useState({ points: [], phase: "jog", cur: null, tap: null });
  const [found, setFound] = useState(null);    // {px, mach, t}
  const [manual, setManual] = useState([]);
  const [tGuess, setTGuess] = useState(19);
  const [fit, setFit] = useState(null);
  const [toolD, setToolD] = useState(6.35);

  useEffect(() => { loadBedcam().then((d) => { setDoc(d); if (d.tGuess) setTGuess(d.tGuess); }); api.get("camera").then(setCamSt).catch(() => setCamSt({ connected: false })); }, []);
  useEffect(() => { readSetup(state.selected).then((s) => { if (s?.toolD) setToolD(s.toolD); }).catch(() => {}); }, [state.selected]);
  const save = async (patch) => { const d = await saveBedcam(patch); setDoc(d); return d; };

  const homed = !!config && ["x", "y", "z"].every((a) => computeAxis(state, config, a, metric).homed);
  const zAx = config ? computeAxis(state, config, "z", true) : null;
  const top = zAx ? zAx.max - 1 : 0;
  const lim = config ? (() => { const x = computeAxis(state, config, "x", true), y = computeAxis(state, config, "y", true); return { x0: x.min, x1: x.max, y0: y.min, y1: y.max }; })() : null;
  const touched = probeActive(state);
  const calib = doc && doc.cal ? revive(doc.cal) : null;
  const sizeNow = camSt && camSt.width ? { w: camSt.width, h: camSt.height } : null;
  const sizeOk = !calib || !sizeNow || (calib.size && calib.size.w === sizeNow.w && calib.size.h === sizeNow.h);
  const canMove = homed && idle && !busy;
  const fast = config?.probe?.["probe-fast-seek"] || 200, slow = config?.probe?.["probe-slow-seek"] || 25;

  const fail = (e) => { setBusy(""); setMsg({ ok: false, text: typeof e === "string" ? e : errText(e) }); };
  const runOk = async (prog) => {
    const r = await run(prog);
    if (r.estop || r.xx === "ESTOPPED") throw new Error(r.notFound ? "The probe didn't touch anything within reach, so the controller stopped with an E-stop. Clear it and start the probe closer." : "The machine was E-stopped.");
    return r;
  };
  const park = async () => {
    if (!doc?.park) throw new Error("Save a park position first.");
    await runOk(parkProgram({ top, x: doc.park.x, y: doc.park.y }));
  };

  // ----- resolution -----
  const setSize = async (v) => {
    const [w, h] = v.split("x").map(Number);
    setBusy("size");
    try { setCamSt(await api.put("camera", { width: w, height: h })); setPic(null); setMsg(null); } catch (e) { fail(e); return; }
    setBusy("");
  };

  // ----- calibration -----
  const needUp = cal.points.filter((p) => p.up).length < 2;
  const touchBed = async () => {
    setMsg(null); setBusy("touch");
    try {
      const r = await runOk(bedTouchProgram({ fast, slow }));
      if (r.ofc_ok !== 1) throw new Error("The touch didn't finish.");
      const m = { x: r.xp, y: r.yp, z: r.ofc_z };
      const p = await takePicture();
      setPic(p); setCal((c) => ({ ...c, phase: "tapLow", cur: { m }, tap: null }));
    } catch (e) { fail(e); return; }
    setBusy("");
  };
  const acceptTap = async () => {
    const c = cal;
    if (c.phase === "tapLow") {
      const cur = { ...c.cur, px: c.tap };
      if (needUp) { setCal({ ...c, phase: "lift", cur, tap: null }); return; }
      setCal({ points: [...c.points, cur], phase: "jog", cur: null, tap: null });
      setBusy("lift");
      try { await runOk(liftProgram(10)); } catch (e) { fail(e); return; }
      setBusy(""); setPic(null);
    } else if (c.phase === "tapUp") {
      setCal({ points: [...c.points, { ...c.cur, up: { ...c.tap, dz: LIFT } }], phase: "jog", cur: null, tap: null });
      setPic(null);
    }
  };
  const liftForTap = async () => {
    setBusy("lift");
    try { await runOk(liftProgram(LIFT)); const p = await takePicture(); setPic(p); setCal((c) => ({ ...c, phase: "tapUp", tap: null })); }
    catch (e) { fail(e); return; }
    setBusy("");
  };
  const skipLift = async () => {
    setCal((c) => ({ points: [...c.points, c.cur], phase: "jog", cur: null, tap: null }));
    setBusy("lift"); try { await runOk(liftProgram(10)); } catch (e) { fail(e); return; } setBusy(""); setPic(null);
  };
  const finishCal = async () => {
    const size = pic ? { w: pic.w, h: pic.h } : sizeNow;
    const res = calibrate(cal.points, size);
    if (res.error) { setMsg({ ok: false, text: res.error }); return; }
    const { Hinv, ...keep } = res; // eslint-disable-line no-unused-vars
    await save({ cal: keep, calPoints: cal.points, base: null, located: null, outline: null });
    setMode(null); setCal({ points: [], phase: "jog", cur: null, tap: null }); setPic(null);
    setMsg({ ok: res.worst < 2, text: `Calibrated from ${res.n} spots: typical error ${len(res.rms, 2)}, worst ${len(res.worst, 2)}, about ${len(res.mmPerPx, 2)} per pixel. The camera is about ${Math.round(res.hc)} mm above the bed. ${res.worst < 2 ? "" : "That's a bit rough: tap more carefully, or add spots, and calibrate again. "}Next: take the empty-bed picture.` });
  };

  // ----- empty bed -----
  const takeBase = async () => {
    setMsg(null); setBusy("base");
    try {
      await park();
      const p = await takePicture();
      await save({ base: p.canvas.toDataURL("image/jpeg", 0.92), baseSize: { w: p.w, h: p.h }, baseTime: Date.now() });
      setPic(p); setMsg({ ok: true, text: "Empty-bed picture saved. Take it again if the bed changes (new spoilboard, moved T-track) or the light in the shop is very different." });
    } catch (e) { fail(e); return; }
    setBusy("");
  };

  // ----- find stock -----
  const find = async () => {
    setMsg(null); setFit(null); setBusy("find");
    try {
      await park();
      const [p, b] = await Promise.all([takePicture(), loadPicture(doc.base)]);
      if (p.w !== b.w || p.h !== b.h) throw new Error("The empty-bed picture is a different size. Take it again.");
      const f = findStock(b.data, p.data, { area: travelArea(calib, lim) });
      setPic(p);
      if (!f) { setFound(null); setMode(null); setMsg({ ok: false, text: "Nothing new on the bed compared with the empty-bed picture. If the stock is there, tap its corners instead, or retake the empty-bed picture." }); setBusy(""); return; }
      setFound({ px: f, mach: stockInMachine(calib, f, tGuess) }); setMode("found");
    } catch (e) { fail(e); return; }
    setBusy("");
  };
  useEffect(() => { if (found) setFound((f) => ({ ...f, mach: stockInMachine(calib, f.px, tGuess) })); }, [tGuess]); // eslint-disable-line react-hooks/exhaustive-deps

  const manualDone = () => {
    if (manual.length < 3) return;
    const f = { outline: manual, contour: manual, rect: null };
    setFound({ px: f, mach: stockInMachine(calib, f, tGuess) }); setMode("found"); setManual([]);
  };
  const located = () => {
    const m = found.mach;
    return { time: Date.now(), cx: m.rect.cx, cy: m.rect.cy, w: m.rect.w, l: m.rect.l, angle: m.rect.angle, t: tGuess,
      pxContour: thin(found.px.contour || found.px.outline), pxOutline: thin(found.px.outline, 200), outline: thin(m.outline, 200) };
  };
  const measureIt = async () => {
    const l = located();
    await save({ located: l, outline: { pts: l.outline, t: l.t, time: l.time, pxOutline: l.pxOutline }, tGuess });
    onMeasure && onMeasure();
  };
  const keepOutline = async () => {
    const l = located();
    await save({ outline: { pts: l.outline, t: l.t, time: l.time, pxOutline: l.pxOutline }, tGuess });
    setMsg({ ok: true, text: "Outline saved. Load a program, set zero, then use Check program fits." });
  };

  // ----- program fit -----
  const checkFit = async () => {
    setMsg(null); setBusy("fit");
    try {
      if (!path || !path.positions) throw new Error("Load a program first.");
      const o = doc.outline;
      const off = { x: state.offset_x || 0, y: state.offset_y || 0 };
      const res = fitCheck(path.positions, off, o.pts, toolD / 2);
      if (!pic) { await park(); setPic(await takePicture()); }
      setFit({ ...res, off, t: o.t }); setMode("fit");
    } catch (e) { fail(e); return; }
    setBusy("");
  };
  const fitDots = useMemo(() => {
    if (mode !== "fit" || !fit || !path || !calib) return null;
    const pts = path.positions, n = Math.floor(pts.length / 3), step = Math.max(1, Math.floor(n / 2500)), out = [];
    for (let i = 0; i < n; i += step) if (pts[i * 3 + 2] < 0.01) out.push(toPixel(calib, { x: pts[i * 3] + fit.off.x, y: pts[i * 3 + 1] + fit.off.y }, fit.t));
    return out;
  }, [mode, fit, path, doc]); // eslint-disable-line react-hooks/exhaustive-deps

  // ----- overlays -----
  const overlay = [];
  if (mode === "calib") {
    cal.points.forEach((p, i) => { overlay.push(<Dot key={`p${i}`} p={p.px} c="#4fd18b" />); if (p.up) overlay.push(<Dot key={`u${i}`} p={p.up} c="#4f8cff" />); });
    if (cal.tap) overlay.push(<Dot key="tap" p={cal.tap} />);
  }
  if (mode === "found" && found && calib) {
    overlay.push(<Poly key="o" pts={found.px.outline} c="#ffcc00" fill="rgba(255,204,0,.12)" />);
    if (found.mach.rect) overlay.push(<Poly key="r" pts={found.mach.rect.corners.map((q) => toPixel(calib, q, tGuess))} c="#4fd18b" w={2} dash="8 6" />);
  }
  if (mode === "manual") { manual.forEach((p, i) => overlay.push(<Dot key={`m${i}`} p={p} />)); if (manual.length > 1) overlay.push(<Poly key="mp" pts={manual} c="#ffcc00" w={2} />); }
  if (mode === "fit" && doc?.outline?.pxOutline) {
    overlay.push(<Poly key="so" pts={doc.outline.pxOutline} c="#ffcc00" w={2} />);
    if (fitDots) overlay.push(<g key="fd">{fitDots.map((p, i) => <circle key={i} cx={p.x} cy={p.y} r="3" fill={fit && fit.fits === false ? "#ff6a5f" : "#4fd18b"} />)}</g>);
    if (fit && fit.at && fit.fits === false) overlay.push(<Dot key="bad" p={toPixel(calib, fit.at, fit.t)} c="#ff6a5f" r={12} />);
  }

  const onTap = mode === "calib" && (cal.phase === "tapLow" || cal.phase === "tapUp") ? (p) => setCal((c) => ({ ...c, tap: p }))
    : mode === "manual" ? (p) => setManual((m) => [...m, p]) : null;
  const zoomAt = mode === "calib" && cal.tap ? cal.tap : null;

  if (!doc || !camSt) return <p className="dim">Loading…</p>;
  if (!camSt.connected) return <p className="empty">No camera. Plug a USB camera into the controller and press Reconnect.</p>;
  const ready = calib && sizeOk;

  return (
    <div className="bedcam">
      <div className="bedcam-main">
        <Picture pic={pic} live={!pic} overlay={overlay} onTap={onTap} zoomAt={zoomAt} onZoomTap={(p) => setCal((c) => ({ ...c, tap: p }))} />
        {pic && mode !== "calib" && <button className="quiet" onClick={() => { setPic(null); setMode(null); setFit(null); }}>Back to the live view</button>}
      </div>

      <div className="align bedcam-side">
        {msg && <div className={msg.ok ? "why" : "why bad"}><p>{msg.text}</p></div>}
        {!homed && <p className="err">Home the machine first. The bed camera works in machine coordinates.</p>}

        {mode === "calib" ? <CalibPanel {...{ cal, setCal, touched, canMove, busy, needUp, touchBed, acceptTap, liftForTap, skipLift, finishCal, len }}
          onCancel={() => { setMode(null); setCal({ points: [], phase: "jog", cur: null, tap: null }); setPic(null); }} />
        : mode === "manual" ? <>
          <h3>Tap the corners of the stock</h3>
          <p>Tap each corner of the stock's top face in the picture, in order around it ({manual.length} so far). For odd shapes, tap more points around the edge.</p>
          <div className="row-end"><button onClick={() => { setManual([]); setMode(null); }}>Cancel</button><button onClick={() => setManual((m) => m.slice(0, -1))} disabled={!manual.length}>Undo</button><button className="primary" disabled={manual.length < 3} onClick={manualDone}>Done</button></div>
        </> : <>
          <h3>Camera</h3>
          <p className="dim">{sizeNow ? `${sizeNow.w} × ${sizeNow.h}` : ""}{calib ? ` · calibrated ${new Date(calib.time).toLocaleDateString()}, about ${len(calib.mmPerPx, 2)} per pixel` : " · not calibrated"}</p>
          {camSt.sizes && camSt.sizes.length > 1 && <label className="stack">Picture size
            <select value={sizeNow ? `${sizeNow.w}x${sizeNow.h}` : ""} disabled={!!busy} onChange={(e) => setSize(e.target.value)}>
              {camSt.sizes.map(([w, h]) => <option key={`${w}x${h}`} value={`${w}x${h}`}>{w} × {h}{w === 1280 && h === 720 ? " (recommended)" : ""}</option>)}
            </select></label>}
          {calib && !sizeOk && <p className="err">The picture size changed since calibrating. Calibrate again, or set the size back to {calib.size.w} × {calib.size.h}.</p>}

          <h3>Park position</h3>
          <p className="dim">Where the gantry waits so it's out of the picture. Pictures are always taken parked, so the empty-bed picture and later ones match.</p>
          <p>{doc.park ? <>Machine X {len(doc.park.x)}, Y {len(doc.park.y)}</> : "Not saved yet."}</p>
          <div className="row-start">
            <button disabled={!homed || !idle || !!busy} onClick={() => save({ park: { x: state.xp, y: state.yp } }).then(() => setMsg({ ok: true, text: "Park position saved." }))}>Save park position here</button>
            <button disabled={!canMove || !doc.park} onClick={() => { setBusy("park"); park().then(() => setBusy("")).catch(fail); }}>{busy === "park" ? "Parking…" : "Park"}</button>
          </div>

          <h3>Calibrate</h3>
          <p className="dim">Once, and again whenever the camera moves. Needs the 3D probe in the collet and a clear bed.</p>
          <button disabled={!canMove} onClick={() => { setMsg(null); setMode("calib"); setPic(null); }}>{calib ? "Calibrate again" : "Calibrate"}</button>

          <h3>Empty-bed picture</h3>
          <p className="dim">{doc.base ? `Taken ${new Date(doc.baseTime).toLocaleString()}.` : "Not taken yet."} Clear the bed (the vise can stay if it always sits in the same place).</p>
          <button disabled={!canMove || !ready || !doc.park} onClick={takeBase}>{busy === "base" ? "Taking it…" : doc.base ? "Take it again" : "Take empty-bed picture"}</button>

          <h3>Find stock</h3>
          {mode === "found" && found ? <FoundPanel {...{ found, tGuess, setTGuess, len, measureIt, keepOutline, metric }} onRetry={() => { setMode("manual"); setManual([]); }} />
            : <>
              <label className="stack">About how thick is it? ({metric ? "mm" : "in"})
                <input type="number" step="any" value={metric ? tGuess : +(tGuess / 25.4).toFixed(3)} onChange={(e) => setTGuess((+e.target.value || 0) * (metric ? 1 : 25.4))} />
                <small>Only for the picture's size estimate. The probe measures the real height.</small></label>
              <div className="row-start">
                <button className="primary" disabled={!canMove || !ready || !doc.base || !doc.park} onClick={find}>{busy === "find" ? "Looking…" : "Park and find stock"}</button>
                <button disabled={!ready || !!busy} onClick={async () => { setMsg(null); if (!pic) { try { setPic(await takePicture()); } catch (e) { fail(e); return; } } setMode("manual"); setManual([]); }}>Tap the corners instead</button>
              </div>
            </>}

          {doc.outline && <>
            <h3>Will the program fit?</h3>
            <p className="dim">Draws the loaded program's cuts on the picture, using the current work zero, and checks them against the saved stock outline ({new Date(doc.outline.time).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}).</p>
            <label className="stack">Cutter diameter ({metric ? "mm" : "in"})
              <input type="number" step="any" value={metric ? toolD : +(toolD / 25.4).toFixed(4)} onChange={(e) => setToolD((+e.target.value || 0) * (metric ? 1 : 25.4))} /></label>
            <button disabled={!state.selected || !!busy || !ready} onClick={checkFit}>{busy === "fit" ? "Checking…" : "Check program fits"}</button>
            {mode === "fit" && fit && (fit.cutting === 0 ? <p className="dim">The program has no moves below Z0.</p>
              : fit.fits ? <div className="why"><b>It fits.</b><p>Every cut stays on the stock, at least {len(fit.worst)} from the edge (outline from the camera, so allow 1 to 2 mm).</p></div>
              : <div className="why bad"><b>It goes off the stock.</b><p>A cut reaches {len(-fit.worst)} past the edge, near machine X {len(fit.at.x)}, Y {len(fit.at.y)} (red circle). Move the zero, or use bigger stock.</p></div>)}
          </>}
        </>}
      </div>
    </div>
  );
}

function CalibPanel({ cal, touched, canMove, busy, needUp, touchBed, acceptTap, liftForTap, skipLift, finishCal, onCancel, len }) {
  const nUp = cal.points.filter((p) => p.up).length;
  return <>
    <h3>Calibrate the bed camera · spot {cal.points.length + 1}</h3>
    {cal.phase === "jog" && <>
      <p>Put the 3D probe in. Jog it over a clear spot on the bed, 5 to 20 mm above it. Use 4 to 6 spots spread out over the area you use (near the corners and the middle).</p>
      {touched && <p className="err">The probe input reads as touched. Check the probe is plugged in and nothing is pressing it.</p>}
      <div className="row-end">
        <button onClick={onCancel}>Cancel</button>
        {cal.points.length >= 4 && nUp >= 2 && <button onClick={finishCal}>Finish ({cal.points.length} spots)</button>}
        <button className="primary" disabled={!canMove || touched} onClick={touchBed}>{busy === "touch" ? "Touching…" : "Touch the bed here"}</button>
      </div>
      <p className="dim">{cal.points.length} spots done, {nUp} with the lifted tap (2 needed).</p>
    </>}
    {(cal.phase === "tapLow" || cal.phase === "tapUp") && <>
      <p><b>Tap the bottom of the stylus ball</b> in the picture{cal.phase === "tapUp" ? `, now ${LIFT} mm up` : ", where it touches the bed"}. Then use the close-up to place it exactly.</p>
      <div className="row-end"><button onClick={onCancel}>Cancel</button><button className="primary" disabled={!cal.tap || !!busy} onClick={acceptTap}>Use this tap</button></div>
    </>}
    {cal.phase === "lift" && <>
      <p>Now lift the probe {LIFT} mm straight up and tap it again. That lets the camera tell how high things are ({nUp} of 2 done).</p>
      <div className="row-end">
        {!needUp && <button disabled={!!busy} onClick={skipLift}>Skip</button>}
        <button className="primary" disabled={!canMove} onClick={liftForTap}>{busy === "lift" ? "Lifting…" : `Lift ${LIFT} mm`}</button>
      </div>
    </>}
    {cal.points.length > 0 && <p className="dim">Spots: {cal.points.map((p, i) => `${i + 1}: X ${len(p.m.x, 0)} Y ${len(p.m.y, 0)}${p.up ? " ↑" : ""}`).join(" · ")}</p>}
  </>;
}

function FoundPanel({ found, tGuess, setTGuess, len, measureIt, keepOutline, onRetry, metric }) {
  const r = found.mach.rect;
  const turned = r && Math.abs(r.angle) >= 1;
  return <>
    {r ? <p>Found about <b>{len(r.w, 0)} × {len(r.l, 0)}</b>{turned ? <>, turned <b>{r.angle.toFixed(1)}°</b></> : ", square to the machine"}. Middle at machine X {len(r.cx)}, Y {len(r.cy)}.</p> : <p>Outline taken.</p>}
    {found.px.touchesEdge && <p className="err">It runs off the edge of the picture or the machine's reach, so part of it may be missing.</p>}
    {turned && Math.abs(r.angle) >= 5 && <p className="err">Measure stock measures square to the machine. Straighten the stock first, or its sizes will read large.</p>}
    <label className="stack">About how thick? ({metric ? "mm" : "in"})
      <input type="number" step="any" value={metric ? tGuess : +(tGuess / 25.4).toFixed(3)} onChange={(e) => setTGuess((+e.target.value || 0) * (metric ? 1 : 25.4))} /></label>
    <p className="dim">The yellow line is what the camera sees, the green box the rectangle around it.</p>
    <div className="row-start">
      <button className="primary" onClick={measureIt}>Measure it with the probe</button>
      <button onClick={keepOutline}>Save outline</button>
      <button className="quiet" onClick={onRetry}>Wrong? Tap the corners</button>
    </div>
  </>;
}
