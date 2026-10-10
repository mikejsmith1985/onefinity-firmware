import React from "react";
import { isInterrupted } from "./checkpoint.js";

const WHY = { running: "The controller lost power or restarted during the job.", estop: "The job ended with an E-stop.", stopped: "The job was stopped before it finished.", parked: "The job was parked." };

export default function Interrupted({ cp, busy, onDismiss }) {
  if (busy || !isInterrupted(cp)) return null;
  const when = new Date(cp.t * 1000).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  return (
    <div className="interrupted" role="status">
      <div>
        <b>Interrupted job: {cp.file}</b>
        <span> Last saved at line {Number(cp.line).toLocaleString()}{cp.nlines ? ` of ${cp.nlines.toLocaleString()}` : ""}, {when}. {WHY[cp.status]}</span>
        <small>Note the line number. Do not assume the machine position is still correct: re-home before you do anything else.</small>
      </div>
      <button onClick={onDismiss}>Dismiss</button>
    </div>
  );
}
