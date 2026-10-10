import React, { useEffect, useState } from "react";
import { getNote, setNote } from "./notes.js";

export default function Notes({ file }) {
  const [v, setV] = useState(() => getNote(file));
  useEffect(() => setV(getNote(file)), [file]);
  if (!file) return <p className="empty">Pick a program in Files to write notes about it.</p>;
  return (
    <div className="notes-pane">
      <label htmlFor="note">Notes for <b>{file}</b></label>
      <textarea id="note" rows="10" value={v} placeholder="Bit, speeds, stock, work zero, fixture. Anything you want to see before you run it again."
        onChange={(e) => { setV(e.target.value); setNote(file, e.target.value); }} />
      <p className="note">Kept in this browser only, per file. The first line shows in the Job panel.</p>
    </div>
  );
}
