import React, { useEffect, useRef, useState } from "react";

export default function GCode({ state }) {
  const [lines, setLines] = useState([]);
  const cur = useRef(null);
  useEffect(() => {
    if (!state.selected) { setLines([]); return; }
    fetch(`/api/file/${encodeURIComponent(state.selected)}`, { cache: "no-cache" })
      .then((r) => r.text()).then((t) => setLines(t.split("\n"))).catch(() => setLines([]));
  }, [state.selected, state.selected_time]);
  useEffect(() => { cur.current?.scrollIntoView({ block: "center" }); }, [state.line, lines]);
  if (!state.selected) return <p className="empty">Pick a program in Files to read its G-code here.</p>;
  return (
    <pre className="code">
      {lines.map((l, i) => (
        <div key={i} ref={i + 1 === state.line ? cur : null} className={i + 1 === state.line ? "now" : ""}>
          <span>{i + 1}</span>{l}
        </div>
      ))}
    </pre>
  );
}
