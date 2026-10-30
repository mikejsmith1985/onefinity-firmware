import React, { useEffect, useState } from "react";
import { Modal } from "./ui.jsx";
import { getPrefs } from "./checkpoint.js";
import { getSetter } from "./ToolSetter.jsx";
import { loadBedcam } from "./BedCam.jsx";
import { REF_FORMAT, refStatus } from "./setter.js";
import { savePendingTune } from "./ProbeTuning.jsx";

// Probe setup (1.38.0): the one-off steps for the 3D probe, tool setter and bed
// camera, in order, with what's done ticked. Each step opens the screen that
// does it; when that closes, this comes back with the next step marked.
// After setup the everyday routine is: Measure stock -> Find it and measure,
// swap to the cutter, Tool setter -> Measure tool.

export async function setupStatus(state) {
  const [prefs, setter, bc] = await Promise.all([getPrefs().catch(() => ({})), getSetter().catch(() => ({})), loadBedcam().catch(() => ({}))]);
  const m = prefs.measure || {};
  const located = setter && Number.isFinite(setter.x);
  return [
    { id: "ball", done: !!m.ballTime || (Number.isFinite(m.ball) && m.ball !== 2), // 2 mm is the default; anything else was calibrated
      title: "Calibrate the stylus",
      what: "Clamp a block you know the exact width of. The probe touches both ends, three times, and the average effective ball size is saved.",
      detail: Number.isFinite(m.ball) ? `Stylus ball ${m.ball} mm${m.ballTime ? `, ${new Date(m.ballTime).toLocaleDateString()}` : ""}.` : null, open: { kind: "measure", calib: true }, button: "Calibrate the stylus" },
    { id: "setter", done: located, title: "Save where the tool setter is",
      what: "Jog a cutter over the middle of the setter, about 5 mm above it, and save its position.",
      detail: located ? `Machine X ${setter.x.toFixed(1)}, Y ${setter.y.toFixed(1)}.` : null, open: { kind: "setter" }, button: "Open Tool setter" },
    { id: "probeRef", done: setter?.lastProbe?.f === REF_FORMAT, title: "Measure a block with the setter step",
      what: "Measure stock on the same block with “Then touch the tool setter” ticked. The probe measures the block and touches the setter. Don't move the block afterwards.",
      open: { kind: "measure" }, button: "Open Measure stock" },
    { id: "corr", done: setter?.corr?.f === REF_FORMAT, title: "Probe vs cutter",
      what: "Without moving the block: put a cutter in, run Probe Z with the touch plate on the block, then Tool setter → Calibrate with this cutter.",
      detail: setter?.corr?.f === REF_FORMAT ? `The probe reads ${Math.abs(setter.corr.c).toFixed(3)} mm ${setter.corr.c >= 0 ? "higher" : "lower"} than a cutter.` : null,
      open: { kind: "setter" }, button: "Open Tool setter" },
    { id: "square", done: !!prefs.square?.time, title: "Check X/Y squareness",
      what: "With a 1-2-3 block on the bed, the probe touches its four sides and works out how square X is to Y. Run it 3 times; the average is saved.",
      detail: prefs.square?.time ? `${Math.abs(prefs.square.drift400).toFixed(2)} mm over 400 mm, ${new Date(prefs.square.time).toLocaleDateString()}.` : null,
      open: { kind: "square" }, button: "Check squareness", optional: "block" },
    { id: "camera", done: !!(bc.cal && bc.base), title: "Calibrate the bed camera",
      what: "Probe back in, bed clear. On the Camera tab, press Calibrate: the machine touches the bed at 6 spots by itself, finds the probe's light, and takes the empty-bed picture.",
      detail: bc.cal ? `Calibrated ${new Date(bc.cal.time).toLocaleDateString()}${bc.base ? ", empty-bed picture taken" : ", empty-bed picture still needed"}.` : null,
      tab: "camera", button: "Go to the Camera tab", optional: true },
  ].map((s) => ({ ...s, refOk: s.id === "corr" ? refStatus(setter?.ref, state).ok : undefined }));
}

export default function ProbeSetup({ state, onOpen, onTab, onClose }) {
  const [steps, setSteps] = useState(null);
  // 1.48.0: a hands-off tuning run that finished while no screen had it open is saved now
  useEffect(() => { savePendingTune(state).catch(() => null).then(() => setupStatus(state)).then(setSteps); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (!steps) return null;
  const next = steps.find((s) => !s.done);
  return (
    <Modal title="Probe setup" wide onClose={onClose} actions={<button data-autofocus onClick={onClose}>Close</button>}>
      <p>The one-off steps for the 3D probe, the tool setter and the bed camera, in order. Each one opens the screen that does it; this comes back when you close it.</p>
      <div className="why"><b>Hands-off: stylus and squareness together</b><p>With a 1-2-3 block on the bed: one start runs the stylus calibration 3 times and the squareness check 3 times, and saves both averages. About 6 minutes, and you can walk away.</p>
        <button className="primary" onClick={() => onOpen({ kind: "tune" })}>Tune the probe automatically</button></div>
      <ol className="setup-steps">
        {steps.map((s, i) => (
          <li key={s.id} className={s.done ? "done" : s === next ? "next" : ""}>
            <span className="mark" aria-label={s.done ? "done" : "not done"}>{s.done ? "✓" : i + 1}</span>
            <div>
              <b>{s.title}</b>{s.optional ? <span className="dim">{s.optional === "block" ? " (if you have a 1-2-3 block)" : " (if you have a bed camera)"}</span> : null}
              {s.done && s.detail ? <p className="dim">{s.detail}</p> : <p>{s.what}</p>}
              {(s === next || s.done || s.optional) && <button className={s === next ? "primary" : "quiet"}
                onClick={() => (s.tab ? onTab(s.tab) : onOpen(s.open))}>{s.done ? "Do it again" : s.button}</button>}
            </div>
          </li>
        ))}
      </ol>
      {!next && <div className="why"><b>All set</b><p>From now on: <b>Measure stock</b> → <b>Find it and measure</b>, swap to the cutter, then <b>Tool setter</b> → <b>Measure tool</b>.</p></div>}
    </Modal>
  );
}
