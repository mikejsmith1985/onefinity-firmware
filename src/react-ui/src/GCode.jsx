import React, { useEffect, useMemo, useRef, useState } from "react";
import { getPrefs } from "./checkpoint.js";
import { colorLines } from "./gcodeColor.js";

export default function GCode({ state, lines }) {
  const cur = useRef(null);
  const [colors, setColors] = useState(false);
  useEffect(() => { getPrefs().then((p) => setColors(!!p.gcodeColors)); }, []);
  useEffect(() => { cur.current?.scrollIntoView({ block: "center" }); }, [state.line, lines]);
  const tagged = useMemo(() => (colors ? colorLines(lines) : null), [colors, lines]);
  if (!state.selected) return <p className="empty">Pick a program in Files to read its G-code here.</p>;
  return (
    <pre className="code">
      {lines.map((l, i) => {
        const t = tagged && tagged[i];
        const cls = [i + 1 === state.line ? "now" : "", t && t.marker ? "tag-marker" : ""].filter(Boolean).join(" ");
        return (
          <div key={i} ref={i + 1 === state.line ? cur : null} className={cls} style={t && t.color ? { color: t.color } : undefined}>
            <span>{i + 1}</span>{t ? t.text : l}
          </div>
        );
      })}
    </pre>
  );
}
