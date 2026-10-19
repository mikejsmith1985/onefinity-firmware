// Setup sheet, quick-read layout (1.28.1).
// The three things checked before every run sit at the top in large type: which bit, the Makita dial,
// and where to probe (drawn, not written). "Before you start" follows as a callout; everything else
// the post wrote is under "All details".
import React from "react";
import { sheetSummary, sentenceCase } from "./setup.js";

const SHOWN = new Set(["tool", "router", "before"]);

// Top view of the plate: back at the top, like standing at the machine.
function ZeroPicture({ corner, probe, what }) {
  const W = 132, H = 84, x0 = 22, y0 = 18;
  const pt = {
    "front-left": [x0, y0 + H], "front-right": [x0 + W, y0 + H], "back-left": [x0, y0], "back-right": [x0 + W, y0],
    center: [x0 + W / 2, y0 + H / 2], "center-x": [x0 + W / 2, y0 + H / 2],
  }[corner];
  const zOnly = probe === "z";
  return (
    <svg className="zero-pic" viewBox="0 0 176 128" role="img"
      aria-label={`${zOnly ? "Probe Z only, keep XY" : "Probe XYZ"}${corner ? ` - zero on the ${corner.replace("-", " ")} corner of the ${what}` : ""}`}>
      <text x="88" y="11" className="lbl">BACK</text>
      <text x="88" y="124" className="lbl">FRONT · you stand here</text>
      <rect x={x0} y={y0} width={W} height={H} rx="3" className="plate" />
      {what === "board" && <text x={x0 + 6} y={y0 + 14} className="lbl l">board</text>}
      {pt && !zOnly && (<g>
        <circle cx={pt[0]} cy={pt[1]} r="13" className="halo" />
        <circle cx={pt[0]} cy={pt[1]} r="5" className="dot" />
        <path d={`M${pt[0] - 18} ${pt[1]}H${pt[0] + 18}M${pt[0]} ${pt[1] - 18}V${pt[1] + 18}`} className="cross" />
      </g>)}
      {pt && zOnly && <circle cx={pt[0]} cy={pt[1]} r="5" className="dot kept" />}
      {zOnly && (<g>
        <path d={`M${x0 + W / 2} ${y0 + 10}V${y0 + H / 2 + 8}`} className="arrow" />
        <path d={`M${x0 + W / 2 - 8} ${y0 + H / 2}L${x0 + W / 2} ${y0 + H / 2 + 10}L${x0 + W / 2 + 8} ${y0 + H / 2}`} className="arrow head" />
        <text x={x0 + W / 2 + 14} y={y0 + H / 2 - 4} className="big">Z</text>
      </g>)}
    </svg>
  );
}

export default function SheetView({ setup }) {
  if (!setup?.fields?.length) return null;
  const s = sheetSummary(setup);
  const rest = setup.fields.filter((f) => !SHOWN.has(f.key));
  const corner = s.corner ? s.corner.replace("-", " ") : null;
  return (
    <section className="sheet" aria-label="Setup sheet">
      <div className="sheet-top">
        {s.tool && (
          <div className="tile bit">
            <span className="cap">Bit</span>
            {s.tool.num && <span className="huge">T{s.tool.num}</span>}
            <span className="name">{s.tool.name}</span>
            {s.tool.geom && <span className="sub">{s.tool.geom.type === "v" ? `${s.tool.geom.angle}° V · ` : "Flat · "}{s.tool.geom.dia} mm</span>}
            {s.tool.stick && <span className="sub">At least {s.tool.stick} mm out of the collet nut</span>}
          </div>
        )}
        {s.dial && (
          <div className="tile dial">
            <span className="cap">Makita dial</span>
            <span className="huge">{s.dial}</span>
            {s.rpm && <span className="sub">{s.rpm.toLocaleString()} rpm</span>}
          </div>
        )}
        {(s.corner || s.probe) && (
          <div className="tile zero">
            <span className="cap">{s.probe === "z" ? "Probe Z only" : "Probe XYZ"}</span>
            <ZeroPicture corner={s.corner} probe={s.probe} what={s.what} />
            <span className="sub">
              {s.probe === "z" ? `Keep XY${corner ? ` (${corner} of the ${s.what})` : ""}` : corner ? `${corner[0].toUpperCase()}${corner.slice(1)} corner of the ${s.what}` : ""}
              {s.z0 ? ` · Z0 on ${s.z0}` : ""}
            </span>
          </div>
        )}
      </div>
      {s.before && <div className="sheet-before"><b>Before you start</b><p>{s.before}</p></div>}
      <details className="sheet-more">
        <summary>All details</summary>
        <dl>
          {rest.map((f) => <div key={f.key}><dt>{f.label}</dt><dd>{sentenceCase(f.text)}</dd></div>)}
          {setup.fields.filter((f) => f.key === "tool" || f.key === "router").map((f) => <div key={f.key}><dt>{f.label}</dt><dd>{f.text}</dd></div>)}
        </dl>
      </details>
    </section>
  );
}
