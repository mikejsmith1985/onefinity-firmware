import React, { useEffect, useMemo, useRef, useState } from "react";
import { api } from "./controller.js";
import { remoteGet, remotePut } from "./store.js";
import { computeAxis, fmtLen } from "./axis.js";
import { errText } from "./checkpoint.js";
import { probeActive, setterProgram, REF_FORMAT } from "./setter.js";
import { useProgramRunner, getSetter, setterArgs } from "./ToolSetter.jsx";
import { readSetup } from "./setup.js";
import {
  calibrate, revive, toPixel, findStock, stockInMachine, fitCheck, travelArea, thin,
  bedTouchProgram, liftProgram, parkProgram,
  calibrateLed, detectLedFlip, detectLedMoved, autoSpots, autoTouchProgram, awayMove, sidewaysProgram, LED_H,
  markerSpots, markerCarveProgram, markerShowProgram, MARK, CORNER_NAMES,
} from "./bedcam.js";

// Bed camera (1.36.0): a camera above the table looking down.
//  - Calibrate: the 3D probe touches the bed at a few spots and you tap the stylus in the picture.
//  - Empty-bed picture: what the bed looks like with nothing on it, gantry parked.
//  - Find stock: park, take a picture, compare it with the empty bed, outline what's new.
//    Measure stock then starts from there (position, size), and the probe measures it exactly.
//  - Program fit: the loaded program drawn on the picture and checked against the stock outline.
// All positions are machine coordinates, valid while the machine is homed.
//
// 1.38.0: calibrating is hands-off (the machine touches the bed itself and the
// camera finds the probe's LED ring, see bedcam.js), the empty-bed picture is
// taken at the end of it, and the park position defaults to the tool setter.

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

// Where the gantry waits for pictures: the saved park position, else over the
// tool setter (out of the way of the stock, and where tools are measured anyway).
export async function parkPosition(doc) {
  if (doc && doc.park) return { ...doc.park, from: "saved" };
  const s = await getSetter().catch(() => null);
  if (s && Number.isFinite(s.x) && Number.isFinite(s.y)) return { x: s.x, y: s.y, from: "setter" };
  return null;
}

// Park, take a picture and find what's new on the bed. Saves it as the located
// stock (Measure stock picks it up) and returns it. runOk runs a program and
// throws if it was stopped; top is the machine Z to travel at.
export async function locateStock({ runOk, top, lim, tGuess }) {
  const doc = await loadBedcam();
  const calib = revive(doc.cal);
  if (!calib) throw new Error("The bed camera isn't calibrated yet.");
  if (!doc.base) throw new Error("There's no empty-bed picture yet.");
  const pp = await parkPosition(doc);
  if (!pp) throw new Error("Save the tool setter position (or a park position) first.");
  await runOk(parkProgram({ top, x: pp.x, y: pp.y }));
  await settle();
  const [p, b] = await Promise.all([takePicture(), loadPicture(doc.base)]);
  if (p.w !== b.w || p.h !== b.h) throw new Error("The empty-bed picture is a different size. Take it again on the Camera tab.");
  const f = findStock(b.data, p.data, { area: travelArea(calib, lim) });
  if (!f) throw new Error("The camera sees nothing new on the bed. Is the stock in view? If the light changed a lot, retake the empty-bed picture.");
  const t = Number.isFinite(tGuess) ? tGuess : doc.tGuess || 19;
  const m = stockInMachine(calib, f, t);
  const located = { time: Date.now(), cx: m.rect.cx, cy: m.rect.cy, w: m.rect.w, l: m.rect.l, angle: m.rect.angle, t,
    pxContour: thin(f.contour || f.outline), pxOutline: thin(f.outline, 200), outline: thin(m.outline, 200) };
  await saveBedcam({ located, outline: { pts: located.outline, t, time: located.time, pxOutline: located.pxOutline } });
  return { located, touchesEdge: f.touchesEdge, pic: p };
}

const settle = (ms = 700) => new Promise((r) => setTimeout(r, ms)); // a fresh frame after the machine stops

// A still picture from the controller: {url, w, h, data (ImageData)}
export async function takePicture() {
  const r = await fetch(`/api/camera/frame?t=${Date.now()}`, { cache: "no-store" });
  if (!r.ok) throw new Error("No picture from the camera. Is it plugged in?");
  const url = URL.createObjectURL(await r.blob());
  return loadPicture(url);
}
export function loadPicture(url) {
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
  const [pp, setPp] = useState(null);           // park position (saved, or the tool setter)
  const [auto, setAuto] = useState(null);      // hands-off calibration: {phase, spot, of, points, note, seenOpen, err}
  const [guard, setGuard] = useState(null);    // tool setter, to keep the calibration spots clear of it
  const [mk, setMk] = useState(null);          // bed markers (1.39.0): {phase, spots, z, probeTrip, vbitTrip, notes, err}

  useEffect(() => { loadBedcam().then((d) => { setDoc(d); if (d.tGuess) setTGuess(d.tGuess); }); api.get("camera").then(setCamSt).catch(() => setCamSt({ connected: false })); }, []);
  useEffect(() => { readSetup(state.selected).then((s) => { if (s?.toolD) setToolD(s.toolD); }).catch(() => {}); }, [state.selected]);
  useEffect(() => { if (doc) parkPosition(doc).then(setPp); }, [doc]);
  useEffect(() => { getSetter().then((s) => setGuard(s && Number.isFinite(s.x) && s.installed !== false ? { x: s.x, y: s.y, r: (s.keep || 30) + (s.allow || 3.2) } : null)).catch(() => {}); }, []);
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
    if (!pp) throw new Error("Save the tool setter position, or a park position here, first.");
    await runOk(parkProgram({ top, x: pp.x, y: pp.y }));
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

  // ----- hands-off calibration (1.38.0) -----
  const ledH = Number.isFinite(doc?.ledH) ? doc.ledH : LED_H;
  const startAuto = () => { setMsg(null); setPic(null); setMode("auto"); setAuto({ phase: "check", seenOpen: false, points: [], note: [] }); };
  // The probe has to be shown to work (stylus pushed by hand) before the machine drives it into the bed
  useEffect(() => {
    if (mode !== "auto" || !auto || auto.phase !== "check") return;
    if (!touched && !auto.seenOpen) setAuto((a) => ({ ...a, seenOpen: true }));
    else if (touched && auto.seenOpen) setAuto((a) => ({ ...a, phase: "ready" }));
  }, [mode, auto?.phase, auto?.seenOpen, touched]); // eslint-disable-line react-hooks/exhaustive-deps
  const runAuto = async () => {
    const spots = autoSpots(lim, guard);
    const zMin = zAx.min + 1;
    const points = [], note = [];
    let zRef = null, ups = 0, last = null;
    const show = (o) => setAuto((a) => ({ ...a, ...o, points: [...points], note: [...note] }));
    setBusy("auto"); show({ phase: "run", spot: 0, of: spots.length });
    try {
      for (let i = 0; i < spots.length; i++) {
        const s = spots[i];
        show({ spot: i + 1, doing: "touching the bed" });
        const r = await runOk(autoTouchProgram({ top, x: s.x, y: s.y, approach: zRef === null ? undefined : zRef + 12, zMin, travel: 1000, fast, slow }));
        if (r.ofa_ok !== 1) {
          if (zRef === null) throw new Error(`The probe came all the way down at spot ${i + 1} without touching anything. Is the probe plugged in, and is that spot over the bed?`);
          note.push(`Spot ${i + 1}: nothing under the probe, skipped.`); continue;
        }
        const z = r.ofa_z;
        if (zRef === null) zRef = z;
        if (Math.abs(z - zRef) > 1.5) {
          note.push(`Spot ${i + 1}: the bed there is ${len(z - zRef, 1)} off the others (a T-track slot or something on the bed), skipped.`);
          await runOk(liftProgram(0.35)); continue;
        }
        show({ doing: "taking pictures" });
        await settle(); const red = await takePicture();
        await runOk(liftProgram(0.35)); await settle(); const green = await takePicture();
        setPic(green); last = green;
        const f = detectLedFlip(red.data, green.data);
        const pt = { m: { x: s.x, y: s.y, z }, px: f ? { x: f.x, y: f.y } : null };
        if (!f) note.push(`Spot ${i + 1}: the camera couldn't see the probe's light there, skipped.`);
        // Two lifted spots, far apart: the first one the camera sees, and one at least a third of the reach from it
        const reach = Math.hypot(lim.x1 - lim.x0, lim.y1 - lim.y0);
        const firstUp = points.find((q) => q.up);
        const wantUp = f && ups < 2 && (!firstUp || Math.hypot(s.x - firstUp.m.x, s.y - firstUp.m.y) > reach / 3 || spots.length - i <= 2 - ups);
        if (wantUp) {
          show({ doing: "lifting for the height" });
          await runOk(liftProgram(60)); await settle(); const here = await takePicture();
          const dx = awayMove(s, lim);
          await runOk(sidewaysProgram(dx)); await settle(); const away = await takePicture();
          const g = detectLedMoved(away.data, here.data, f, here.w * 0.3);
          if (g) { pt.up = { x: g.x, y: g.y, dz: 60.2 }; ups++; }
          else note.push(`Spot ${i + 1}: the camera lost the probe when it was lifted.`);
        }
        points.push(pt);
        show({});
        if (points.filter((q) => q.px).length >= 6 && ups >= 2) break;
      }
      const good = points.filter((p) => p.px);
      const res = calibrateLed(good, { w: last ? last.w : sizeNow?.w, h: last ? last.h : sizeNow?.h }, ledH);
      if (res.error) { show({ phase: "error", err: res.error }); setBusy(""); await park().catch(() => {}); return; }
      const { Hinv, ...keep } = res; // eslint-disable-line no-unused-vars
      show({ doing: "taking the empty-bed picture" });
      // The bed is clear for calibrating, so the empty-bed picture comes for free
      await park(); await settle();
      const base = await takePicture();
      await save({ cal: keep, calPoints: good, base: base.canvas.toDataURL("image/jpeg", 0.92), baseSize: { w: base.w, h: base.h }, baseTime: Date.now(), located: null, outline: null });
      setPic(base);
      show({ phase: "done", res: { n: res.n, rms: res.rms, worst: res.worst, hc: res.hc, mmPerPx: res.mmPerPx } });
    } catch (e) { show({ phase: "error", err: errText(e) }); }
    setBusy("");
  };
  const endAuto = () => { setMode(null); setAuto(null); setPic(null); };

  // ----- bed markers (1.39.0) -----
  const corners = doc?.markCorners || {};
  const planned = useMemo(() => markerSpots(corners, lim, guard), [doc?.markCorners, lim?.x0, lim?.x1, lim?.y0, lim?.y1, guard]); // eslint-disable-line react-hooks/exhaustive-deps
  const saveCorner = (id) => save({ markCorners: { ...corners, [id]: { x: state.xp, y: state.yp } } });
  const startMarkers = () => { setMsg(null); setPic(null); setMode("markers"); setMk({ phase: "corners", notes: [] }); };
  useEffect(() => {
    if (mode !== "markers" || !mk || mk.phase !== "check") return;
    if (!touched && !mk.seenOpen) setMk((m) => ({ ...m, seenOpen: true }));
    else if (touched && mk.seenOpen) setMk((m) => ({ ...m, phase: "ready" }));
  }, [mode, mk?.phase, mk?.seenOpen, touched]); // eslint-disable-line react-hooks/exhaustive-deps
  const showSpot = async (sp) => {
    setBusy("show");
    try { await runOk(markerShowProgram({ top, spot: sp })); } catch (e) { fail(e); return; }
    setBusy("");
  };
  const touchSetter = async () => {
    const setter = await getSetter();
    if (!setter || !Number.isFinite(setter.x)) throw new Error("Save the tool setter's position first (Tool setter screen).");
    const r = await runOk(setterProgram(setterArgs(state, config, setter, "ref")));
    if (r.ofs_ok !== 1 || typeof r.ofs_ref !== "number") throw new Error("The touch on the tool setter didn't finish.");
    return { trip: r.ofs_ref, setter };
  };
  const markProbe = async () => {
    const spots = planned.spots, zMin = zAx.min + 1, z = {};
    const step = (o) => setMk((m) => ({ ...m, ...o }));
    setBusy("markers"); step({ phase: "probing", doing: "" });
    try {
      let zRef = null;
      for (const sp of spots) {
        step({ doing: `touching the bed at the ${CORNER_NAMES[sp.id]} spot` });
        const r = await runOk(autoTouchProgram({ top, x: sp.x, y: sp.y, approach: zRef === null ? undefined : zRef + 12, zMin, travel: 1000, fast, slow }));
        if (r.ofa_ok !== 1) throw new Error(`The probe came down at the ${CORNER_NAMES[sp.id]} spot without touching anything. Is the probe plugged in, and is that corner over the board?`);
        await runOk(liftProgram(10));
        z[sp.id] = r.ofa_z; if (zRef === null) zRef = r.ofa_z;
      }
      const zs = Object.values(z), spread = Math.max(...zs) - Math.min(...zs);
      if (spread > 3) throw new Error(`The board heights at the three spots differ by ${len(spread, 1)}. One of them is probably in a T-track slot or on something. Check the corners and start again.`);
      step({ doing: "touching the tool setter with the probe" });
      const { trip, setter } = await touchSetter();
      const corr = setter?.corr?.f === REF_FORMAT && typeof setter.corr.c === "number" ? setter.corr.c : 0;
      step({ phase: "swap", z, probeTrip: trip, corr, spread });
    } catch (e) { step({ phase: "error", err: errText(e) }); }
    setBusy("");
  };
  const markVbit = async () => {
    const step = (o) => setMk((m) => ({ ...m, ...o }));
    setBusy("markers"); step({ phase: "vbit" });
    try {
      const { trip } = await touchSetter();
      const d = trip - mk.probeTrip;
      if (Math.abs(d) > 120) throw new Error(`The V-bit measured ${len(Math.abs(d), 0)} ${d > 0 ? "longer" : "shorter"} than the probe, which can't be right. Measure it again.`);
      const lowest = Math.min(...Object.values(mk.z)) + d + mk.corr - MARK.depth;
      if (lowest < zAx.min + 0.5) throw new Error("With this V-bit the crosses would be below the bottom of Z's travel. Put the V-bit further out of the collet.");
      step({ phase: "carve", vbitTrip: trip });
    } catch (e) { step({ phase: "error", err: errText(e) }); }
    setBusy("");
  };
  const markCarve = async () => {
    const step = (o) => setMk((m) => ({ ...m, ...o }));
    setBusy("markers"); step({ phase: "carving" });
    try {
      const spots = planned.spots.map((sp) => ({ ...sp, z: mk.z[sp.id] }));
      await runOk(markerCarveProgram({ top, spots, probeTrip: mk.probeTrip, vbitTrip: mk.vbitTrip, corr: mk.corr }));
      await save({ markers: { spots: spots.map(({ id, x, y, z }) => ({ id, x, y, z })), size: MARK.size, depth: MARK.depth, time: Date.now() } });
      if (pp) await park().catch(() => {});
      step({ phase: "done" });
    } catch (e) { step({ phase: "error", err: errText(e) }); }
    setBusy("");
  };
  const endMarkers = () => { setMode(null); setMk(null); };

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
  if (mode === "auto" && auto) {
    auto.points.forEach((p, i) => { if (p.px) overlay.push(<Dot key={`a${i}`} p={p.px} c="#4fd18b" />); if (p.up) overlay.push(<Dot key={`au${i}`} p={p.up} c="#4f8cff" />); });
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

        {mode === "markers" && mk ? <MarkersPanel {...{ mk, corners, planned, touched, canMove, busy, len, homed }} onSaveCorner={saveCorner}
          onShow={showSpot} onNext={() => setMk((m) => ({ ...m, phase: "check", seenOpen: false }))} onProbe={markProbe} onVbit={markVbit}
          onCarve={markCarve} onClose={endMarkers} onRestart={() => setMk({ phase: "corners", notes: [] })} />
        : mode === "auto" && auto ? <AutoPanel {...{ auto, touched, canMove, busy, len, ledH }} onStart={runAuto} onClose={endAuto}
          onTapInstead={() => { setAuto(null); setMode("calib"); setPic(null); }} />
        : mode === "calib" ? <CalibPanel {...{ cal, setCal, touched, canMove, busy, needUp, touchBed, acceptTap, liftForTap, skipLift, finishCal, len }}
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
          <p>{pp ? (pp.from === "setter" ? <>Over the tool setter (machine X {len(pp.x)}, Y {len(pp.y)}), at the top of Z.</> : <>Machine X {len(pp.x)}, Y {len(pp.y)}.</>) : "Save the tool setter position, or a park position here."}</p>
          <div className="row-start">
            <button disabled={!canMove || !pp} onClick={() => { setBusy("park"); park().then(() => setBusy("")).catch(fail); }}>{busy === "park" ? "Parking…" : "Park"}</button>
            <button className="quiet" disabled={!homed || !idle || !!busy} onClick={() => save({ park: { x: state.xp, y: state.yp } }).then(() => setMsg({ ok: true, text: "Park position saved. Pictures are taken from here from now on." }))}>Park here instead</button>
            {doc.park && <button className="quiet" disabled={!!busy} onClick={() => save({ park: null }).then(() => setMsg({ ok: true, text: "Parking over the tool setter again." }))}>Back to the tool setter</button>}
          </div>

          <h3>Calibrate</h3>
          <p className="dim">Once, and again whenever the camera moves. Needs the 3D probe in the collet and a clear bed. The machine touches the bed at 6 spots by itself and the camera finds the probe's light, then it takes the empty-bed picture.</p>
          <div className="row-start">
            <button className="primary" disabled={!canMove || !pp || !lim} onClick={startAuto}>{calib ? "Calibrate again" : "Calibrate"}</button>
            <button className="quiet" disabled={!canMove} onClick={() => { setMsg(null); setMode("calib"); setPic(null); }}>Calibrate by tapping</button>
          </div>
          <label className="stack">Probe light height above the stylus tip ({metric ? "mm" : "in"})
            <input type="number" step="any" value={metric ? ledH : +(ledH / 25.4).toFixed(3)} disabled={!!busy} onChange={(e) => { const v = (+e.target.value || 0) * (metric ? 1 : 25.4); if (v > 0) save({ ledH: v }); }} />
            <small>With calipers: from the bottom of the stylus ball to the middle of the light ring.</small></label>

          <h3>Bed markers</h3>
          <p className="dim">{doc.markers ? `Carved ${new Date(doc.markers.time).toLocaleDateString()}: three small crosses near the corners.` : "Three small crosses carved with a V-bit near the board's corners, so the controller can tell if the camera gets bumped."} You show it the board's corners; it picks the spots, measures the bed and the V-bit, and carves.</p>
          <button disabled={!canMove || !lim} onClick={startMarkers}>{doc.markers ? "Carve the markers again" : "Carve bed markers"}</button>

          <h3>Empty-bed picture</h3>
          <p className="dim">{doc.base ? `Taken ${new Date(doc.baseTime).toLocaleString()}.` : "Not taken yet."} Calibrating takes it too. Retake it with a clear bed if the bed or the light changes (the vise can stay if it always sits in the same place).</p>
          <button disabled={!canMove || !ready || !pp} onClick={takeBase}>{busy === "base" ? "Taking it…" : doc.base ? "Take it again" : "Take empty-bed picture"}</button>

          <h3>Find stock</h3>
          {mode === "found" && found ? <FoundPanel {...{ found, tGuess, setTGuess, len, measureIt, keepOutline, metric }} onRetry={() => { setMode("manual"); setManual([]); }} />
            : <>
              <label className="stack">About how thick is it? ({metric ? "mm" : "in"})
                <input type="number" step="any" value={metric ? tGuess : +(tGuess / 25.4).toFixed(3)} onChange={(e) => setTGuess((+e.target.value || 0) * (metric ? 1 : 25.4))} />
                <small>Only for the picture's size estimate. The probe measures the real height.</small></label>
              <div className="row-start">
                <button className="primary" disabled={!canMove || !ready || !doc.base || !pp} onClick={find}>{busy === "find" ? "Looking…" : "Park and find stock"}</button>
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

function AutoPanel({ auto, touched, canMove, busy, len, ledH, onStart, onClose, onTapInstead }) {
  const found = auto.points.filter((p) => p.px).length, up = auto.points.filter((p) => p.up).length;
  return <>
    <h3>Calibrate the bed camera</h3>
    {auto.phase === "check" && <>
      <p>Put the 3D probe in the collet and plug it in. Clear the bed: nothing on it but the tool setter.</p>
      <p><b>Push the stylus sideways with your finger.</b> This makes sure the probe works before the machine drives it into the bed.</p>
      {touched && !auto.seenOpen && <p className="err">The probe already reads as touched. Check the probe and its cable.</p>}
      <div className="row-end"><button onClick={onClose}>Cancel</button></div>
    </>}
    {auto.phase === "ready" && <>
      <p>The probe works. Take your hand away.</p>
      <p className="dim">The machine goes to 6 spots over the bed, comes down until the stylus touches, and the camera finds the probe's light (it turns red on the touch). At 2 spots it also lifts 60 mm and moves sideways. Then it parks and takes the empty-bed picture. Keep a hand near the E-stop.</p>
      <div className="row-end"><button onClick={onClose}>Cancel</button>
        <button className="primary" data-autofocus disabled={!canMove || touched} onClick={onStart}>Start</button></div>
    </>}
    {auto.phase === "run" && <>
      <p>Spot {auto.spot} of {auto.of}{auto.doing ? `: ${auto.doing}` : ""}…</p>
      <p className="dim">Found the probe at {found} spot{found === 1 ? "" : "s"}, lifted at {up}.</p>
    </>}
    {auto.phase === "done" && auto.res && <div className={auto.res.worst < 2 ? "why" : "why bad"}>
      <b>Calibrated from {auto.res.n} spots</b>
      <p>Typical error {len(auto.res.rms, 2)}, worst {len(auto.res.worst, 2)}; about {len(auto.res.mmPerPx, 2)} per pixel, the camera about {Math.round(auto.res.hc)} mm above the bed. The empty-bed picture is taken too.</p>
      {auto.res.worst >= 2 && <p>That's a bit rough. Check the light height ({len(ledH, 1)}) with calipers and calibrate again.</p>}
    </div>}
    {auto.phase === "error" && <div className="why bad"><b>Calibration stopped</b><p>{auto.err}</p></div>}
    {auto.note.length > 0 && <ul className="plain dim">{auto.note.map((n, i) => <li key={i}>{n}</li>)}</ul>}
    {(auto.phase === "done" || auto.phase === "error") && <div className="row-end">
      {auto.phase === "error" && <button disabled={!!busy} onClick={onTapInstead}>Calibrate by tapping</button>}
      <button className="primary" disabled={!!busy} onClick={onClose}>Done</button></div>}
  </>;
}

function MarkersPanel({ mk, corners, planned, touched, canMove, busy, len, homed, onSaveCorner, onShow, onNext, onProbe, onVbit, onCarve, onClose, onRestart }) {
  const ids = ["fl", "fr", "bl"];
  const cancel = <button disabled={!!busy} onClick={onClose}>Cancel</button>;
  return <>
    <h3>Carve bed markers</h3>
    {mk.phase === "corners" && <>
      <p>Jog the tip of whatever is in the spindle over each corner of the spoilboard (roughly is fine; if a corner is past where the machine can reach, go as far as it goes) and press its button. Not the back-right corner: that's the tool setter's.</p>
      <ul className="plain corner-list">{ids.map((id) => <li key={id}>
        <button disabled={!homed || !!busy} onClick={() => onSaveCorner(id)}>{corners[id] ? "Save again" : "Save"} {CORNER_NAMES[id]}</button>{" "}
        <span className="dim">{corners[id] ? `X ${len(corners[id].x)}, Y ${len(corners[id].y)}` : "not saved"}</span></li>)}</ul>
      {planned.error ? (ids.every((id) => corners[id]) && <p className="err">{planned.error}</p>) : <>
        <p>The crosses go {MARK.inset} mm in from both edges at each corner ({MARK.size} mm across, {MARK.depth} mm deep):</p>
        <ul className="plain">{planned.spots.map((sp) => <li key={sp.id}>{CORNER_NAMES[sp.id]}: machine X {len(sp.x)}, Y {len(sp.y)}{" "}
          <button className="quiet" disabled={!canMove} onClick={() => onShow(sp)}>{busy === "show" ? "Moving…" : "Go there"}</button></li>)}</ul>
        {planned.notes.map((n, i) => <p key={i} className="dim">{n}</p>)}
      </>}
      <div className="row-end">{cancel}<button className="primary" disabled={!!planned.error || !!busy} onClick={onNext}>Next</button></div>
    </>}
    {mk.phase === "check" && <>
      <p>Put the 3D probe in and plug it in. It measures the board's height at the three spots and touches the tool setter, so the V-bit can be measured against it.</p>
      <p><b>Push the stylus sideways with your finger</b> to show the probe works.</p>
      {touched && !mk.seenOpen && <p className="err">The probe already reads as touched. Check the probe and its cable.</p>}
      <div className="row-end">{cancel}</div>
    </>}
    {mk.phase === "ready" && <>
      <p>The probe works. Take your hand away. The machine touches the board at the three spots, then touches the tool setter.</p>
      <div className="row-end">{cancel}<button className="primary" data-autofocus disabled={!canMove || touched} onClick={onProbe}>Start</button></div>
    </>}
    {(mk.phase === "probing" || mk.phase === "vbit" || mk.phase === "carving") && <p>{mk.phase === "probing" ? `Measuring: ${mk.doing || "starting"}…` : mk.phase === "vbit" ? "Measuring the V-bit on the tool setter…" : "Carving…"}</p>}
    {mk.phase === "swap" && <>
      <p>Board measured{mk.spread > 0.05 ? ` (the three spots are within ${len(mk.spread, 2)} of each other)` : ""}.</p>
      <p><b>Take the probe out and put the V-bit in.</b> Then it touches the tool setter with the V-bit to find how long it is.</p>
      <div className="row-end">{cancel}<button className="primary" disabled={!canMove} onClick={onVbit}>The V-bit is in: measure it</button></div>
    </>}
    {mk.phase === "carve" && <>
      <p>Ready to carve the three crosses. <b>The router turns on</b> (by itself if it's on the smart plug; otherwise switch it on now). Keep a hand near the E-stop.</p>
      <div className="row-end">{cancel}<button className="primary" disabled={!canMove} onClick={onCarve}>Carve</button></div>
    </>}
    {mk.phase === "done" && <div className="why"><b>Markers carved</b><p>Their positions are saved. Vacuum the dust; a black marker pen in the grooves helps the camera.</p></div>}
    {mk.phase === "error" && <div className="why bad"><b>Stopped</b><p>{mk.err}</p></div>}
    {(mk.phase === "done" || mk.phase === "error") && <div className="row-end">
      {mk.phase === "error" && <button disabled={!!busy} onClick={onRestart}>Start again</button>}
      <button className="primary" disabled={!!busy} onClick={onClose}>Done</button></div>}
  </>;
}
