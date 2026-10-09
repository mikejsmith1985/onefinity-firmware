import React, { useRef, useState } from "react";
import { api } from "./controller.js";

export default function Files({ state }) {
  const input = useRef(null);
  const [err, setErr] = useState("");
  const [confirm, setConfirm] = useState(null);
  const files = (state.files || []).filter((f) => !f.startsWith("EgZjaHJvbWUq"));

  const pick = (f) => fetch(`/api/file/${encodeURIComponent(f)}`).catch(() => setErr("Could not open that file."));
  const upload = async (list) => {
    setErr("");
    for (const f of list) {
      try {
        const r = await fetch(`/api/file/${encodeURIComponent(f.name)}`, { method: "PUT", body: f });
        if (!r.ok) throw new Error(await r.text());
      } catch (e) { setErr(`Upload failed for ${f.name}: ${e.message}`); }
    }
  };
  const del = async (f) => {
    if (confirm !== f) { setConfirm(f); setTimeout(() => setConfirm((c) => (c === f ? null : c)), 3000); return; }
    setConfirm(null);
    try { await api.del(`file/${encodeURIComponent(f)}`); } catch (e) { setErr(e.message); }
  };

  return (
    <div className="files">
      <div className="files-head">
        <button onClick={() => input.current.click()}>Upload G-code</button>
        <input ref={input} type="file" multiple hidden accept=".nc,.ngc,.gcode,.tap,.txt,.gc" onChange={(e) => { upload([...e.target.files]); e.target.value = ""; }} />
        {err && <span className="err">{err}</span>}
      </div>
      {files.length === 0 && <p className="empty">No programs yet. Upload a G-code file to get started.</p>}
      <ul>
        {files.map((f) => (
          <li key={f} className={f === state.selected ? "sel" : ""}>
            <button className="name" onClick={() => pick(f)}>{f}</button>
            <button className={`rm${confirm === f ? " armed" : ""}`} onClick={() => del(f)}>{confirm === f ? "Tap again to delete" : "Delete"}</button>
          </li>
        ))}
      </ul>
    </div>
  );
}
