// Step illustrations for the probing screens (1.31.1). Drawn here rather than as fixed pictures so
// they follow the choices on screen: which corner, which block, which move is running now.
// Plan views: the stock seen from above, front at the bottom. Side views: seen from the front.
import React from "react";

const W = 320, H = 210;
const Frame = ({ children, label }) => (
  <svg className="art" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label} xmlns="http://www.w3.org/2000/svg">
    <defs>
      <marker id="art-head" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" className="art-headfill" /></marker>
      <marker id="art-head-on" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" className="art-headfill on" /></marker>
    </defs>
    {children}
  </svg>
);

// ---- plan view helpers ----
const S = { x0: 52, x1: 268, y0: 44, y1: 166 };      // stock outline
const PLATE = 78, LIP = 7;
export const cornerOf = (loc) => ({
  sx: loc === "front-right" || loc === "back-right" ? -1 : 1,
  sy: loc === "back-left" || loc === "back-right" ? -1 : 1,
});
const rect = (a, b) => ({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) });

function Stock({ labels = true }) {
  return <g>
    <rect className="art-stock" x={S.x0} y={S.y0} width={S.x1 - S.x0} height={S.y1 - S.y0} rx="2" />
    {labels && <>
      <text className="art-label" x={(S.x0 + S.x1) / 2} y={S.y1 + 18} textAnchor="middle">Front</text>
      <text className="art-label" x={(S.x0 + S.x1) / 2} y={S.y0 - 8} textAnchor="middle">Back</text>
      <text className="art-label" x={S.x0 - 8} y={(S.y0 + S.y1) / 2} textAnchor="end">L</text>
      <text className="art-label" x={S.x1 + 8} y={(S.y0 + S.y1) / 2}>R</text>
    </>}
  </g>;
}

// The touch plate on a stock corner, lips over the two outer edges. Returns its geometry too.
function plateGeom(loc) {
  const { sx, sy } = cornerOf(loc);
  const C = { x: sx > 0 ? S.x0 : S.x1, y: sy > 0 ? S.y1 : S.y0 };
  const u = { x: sx, y: -sy };                       // into the stock, on screen
  const at = (a, b) => ({ x: C.x + u.x * a, y: C.y + u.y * b });
  return { C, u, at, sx, sy };
}
function Plate({ g, faded }) {
  const lip = rect(g.at(-LIP, -LIP), g.at(PLATE, PLATE));
  const top = rect(g.at(0, 0), g.at(PLATE, PLATE));
  return <g className={faded ? "faded" : ""}>
    <rect className="art-lip" {...lip} rx="2" />
    <rect className="art-plate" {...top} rx="2" />
    <circle className="art-origin" cx={g.C.x} cy={g.C.y} r="4" />
  </g>;
}
const Bit = ({ p, on, label }) => <g className={`art-bit${on ? " on" : ""}`}>
  <circle cx={p.x} cy={p.y} r="7" /><circle cx={p.x} cy={p.y} r="2" className="art-bitc" />
  {label && <text className="art-note" x={p.x + 11} y={p.y - 9}>{label}</text>}
</g>;

// One drawn move: an arrow, or a dot with an up/down sign for a vertical move.
function Seg({ s, state }) {
  const cls = `art-seg ${state}${s.guard ? " guard" : ""}${s.touch ? " touch" : ""}`;
  const head = state === "on" ? "url(#art-head-on)" : "url(#art-head)";
  if (s.dot) {
    const up = s.dot === "up";
    return <g className={cls}>
      <circle cx={s.at.x} cy={s.at.y} r="9" />
      <path d={up ? `M${s.at.x} ${s.at.y + 5}V${s.at.y - 4}` : `M${s.at.x} ${s.at.y - 5}V${s.at.y + 4}`} markerEnd={head} />
    </g>;
  }
  return <path className={cls} d={`M${s.from.x} ${s.from.y}L${s.to.x} ${s.to.y}`} markerEnd={head} />;
}
function Path({ segs, cur }) {
  return <g>{segs.map((s, i) => s && <Seg key={i} s={s} state={cur < 0 ? "plan" : i < cur ? "done" : i === cur ? "on" : "todo"} />)}
    {cur >= 0 && segs[cur] && <Seg s={segs[cur]} state="on" />}</g>;
}

// The touch-plate moves, from the labels of the program's marks (progress.js), so the picture is
// always the program that runs. Coordinates are only roughly to scale (20 mm ~ 29 px).
function cornerSegs(g, labels) {
  const B = g.at(PLATE - 16, PLATE - 16);
  // the block's outer faces are its lips, hanging over the stock edges: the bit goes out past them,
  // down beside the block, then in to touch
  const out = -LIP - 20, touch = -LIP - 8;
  const xo = g.at(out, PLATE - 16), xf = g.at(touch, PLATE - 16);
  const yo = g.at(out, out), yb = g.at(PLATE - 16, out), yf = g.at(PLATE - 16, touch);
  let at = B;
  return labels.map((l) => {
    if (/block top/.test(l)) { at = B; return { dot: "down", at: B, touch: true }; }
    if (/^Move out past/.test(l)) { const s = { from: at, to: xo }; at = xo; return s; }
    if (/^Go down beside/.test(l)) return { dot: "down", at, guard: true };
    if (/^Touch the (left|right) face/.test(l)) return { from: xo, to: xf, touch: true };
    if (/^Move along/.test(l)) { at = yo; return { from: xo, to: yo, guard: true }; }
    if (/^Move round/.test(l)) { at = yb; return { from: yo, to: yb, guard: true }; }
    if (/^Touch the (front|back) face/.test(l)) return { from: yb, to: yf, touch: true };
    if (/^Lift/.test(l)) return { dot: "up", at };
    return null;
  });
}

export function CornerArt({ loc = "front-left", moves, cur = -1, showPath, second }) {
  const g = plateGeom(loc);
  const labels = (moves || []).map((m) => m.label);
  const segs = showPath ? cornerSegs(g, labels.length ? labels : ["Touch the block top", "Move out past the face", "Go down beside the block", "Touch the left face", "Move along", "Move round", "Touch the front face", "Lift clear"]) : [];
  const B = g.at(PLATE - 16, PLATE - 16);
  const name = loc.replace("-", " ");
  return <Frame label={`Probe block on the ${name} corner${showPath ? ", with the probing moves" : ""}`}>
    <Stock />
    <Plate g={g} />
    {showPath && <Path segs={segs} cur={cur} />}
    <Bit p={B} on={cur < 0} label={showPath ? null : "start the bit here"} />
    <text className="art-note" x={g.C.x + g.u.x * -2} y={g.C.y + (g.sy > 0 ? 14 : -6)} textAnchor={g.sx > 0 ? "start" : "end"}>{second ? "second placement" : "X0 Y0"}</text>
  </Frame>;
}

export function LocationArt({ loc }) {
  const corners = ["front-left", "front-right", "back-left", "back-right"];
  return <Frame label={`Zero corner: ${loc.replace("-", " ")}`}>
    <Stock />
    {corners.map((c) => { const g = plateGeom(c); return c === loc ? <Plate key={c} g={g} /> : <circle key={c} className="art-corner" cx={g.C.x} cy={g.C.y} r="6" />; })}
    {(loc === "center" || loc === "center-x") && <>
      <Plate g={plateGeom("front-left")} />
      <g className="faded"><Plate g={plateGeom(loc === "center" ? "back-right" : "front-right")} /></g>
      <circle className="art-origin" cx={(S.x0 + S.x1) / 2} cy={loc === "center" ? (S.y0 + S.y1) / 2 : S.y1} r="5" />
      <text className="art-note" x={(S.x0 + S.x1) / 2} y={(loc === "center" ? (S.y0 + S.y1) / 2 : S.y1) - 10} textAnchor="middle">{loc === "center" ? "X0 Y0: the center" : "X0: the middle"}</text>
    </>}
  </Frame>;
}

// ---- side views ----
const TABLE = 186;
function Table() { return <line className="art-table" x1="10" x2={W - 10} y1={TABLE} y2={TABLE} />; }
function Tool({ x, tip, probe }) {
  return <g className="art-tool">
    <rect x={x - 16} y={tip - 92} width="32" height="40" rx="3" className="art-collet" />
    {probe ? <><rect x={x - 3} y={tip - 52} width="6" height="46" /><circle cx={x} cy={tip - 4} r="5" className="art-ball" /></>
      : <><rect x={x - 6} y={tip - 52} width="12" height="52" rx="1" /><path className="art-flute" d={`M${x - 6} ${tip - 40}l12 -8M${x - 6} ${tip - 26}l12 -8M${x - 6} ${tip - 12}l12 -8`} /></>}
  </g>;
}

export function CheckArt({ probe }) {
  const x = 150, tip = 120;
  return <Frame label={probe ? "Touch the stylus: the probe light comes on" : "Clip the magnet on, touch the block to the bit"}>
    <Tool x={x} tip={tip} probe={probe} />
    {!probe && <><rect className="art-magnet" x={x + 16} y={tip - 84} width="14" height="12" rx="2" />
      <path className="art-wire" d={`M${x + 30} ${tip - 78}C${x + 90} ${tip - 78} ${x + 110} ${tip + 60} ${x + 60} ${tip + 22}`} />
      <rect className="art-plate side" x={x - 40} y={tip + 2} width="90" height="22" rx="2" /></>}
    {probe && <path className="art-finger" d={`M${x + 70} ${tip + 4}C${x + 40} ${tip + 6} ${x + 22} ${tip + 2} ${x + 9} ${tip - 2}`} />}
    <circle className="art-spark" cx={x} cy={tip + (probe ? -4 : 1)} r="11" />
    <text className="art-note" x={x + 30} y={tip + 54}>{probe ? "touch the stylus: the light comes on" : "touch the block to the bit"}</text>
  </Frame>;
}

export function BitArt({ dia }) {
  const x = 160, tip = 150;
  return <Frame label="Cutter diameter">
    <rect className="art-collet" x={x - 30} y={20} width="60" height="44" rx="3" />
    <rect className="art-toolbody" x={x - 22} y={64} width="44" height={tip - 64} rx="2" />
    <path className="art-flute" d={`M${x - 22} 90l44 -16M${x - 22} 112l44 -16M${x - 22} 134l44 -16`} />
    <path className="art-dim" d={`M${x - 22} ${tip + 22}H${x + 22}`} markerStart="url(#art-head)" markerEnd="url(#art-head)" />
    <path className="art-dimext" d={`M${x - 22} ${tip + 4}V${tip + 28}M${x + 22} ${tip + 4}V${tip + 28}`} />
    <text className="art-big" x={x} y={tip + 46} textAnchor="middle">Ø {dia || "?"}</text>
  </Frame>;
}

export function ZArt({ phase = "place", cur = -1, moves }) {
  const x = 150, top = 150, tip = phase === "done" ? 60 : 112;
  const labels = (moves || []).map((m) => m.label);
  return <Frame label={phase === "place" ? "Block face down on the stock, bit over its recess" : "Probing Z"}>
    <Table />
    <rect className="art-stock side" x="30" y={top + 14} width="260" height={TABLE - top - 14} />
    {phase !== "done" && <rect className="art-plate side" x={x - 45} y={top - 8} width="90" height="22" rx="2" />}
    <Tool x={x} tip={tip} />
    {phase === "place" && <><path className="art-dim" d={`M${x + 50} ${tip}V${top - 8}`} markerStart="url(#art-head)" markerEnd="url(#art-head)" />
      <text className="art-note" x={x + 58} y={(tip + top) / 2}>less than 25 mm</text></>}
    {phase === "run" && <Path cur={cur} segs={labels.map((l) => (/top/.test(l) ? { dot: "down", at: { x: x + 60, y: tip }, touch: true } : /Lift/.test(l) ? { dot: "up", at: { x: x + 60, y: tip - 30 } } : null))} />}
    {phase === "done" && <><rect className="art-plate side faded" x={x + 70} y={top - 8} width="90" height="22" rx="2" />
      <path className="art-seg plan" d={`M${x + 20} ${top - 30}C${x + 60} ${top - 60} ${x + 100} ${top - 50} ${x + 120} ${top - 16}`} markerEnd="url(#art-head)" />
      <text className="art-note" x={x + 70} y={top + 30}>put the block and magnet away</text></>}
  </Frame>;
}

export function PutAwayArt({ loc = "front-left" }) {
  const g = plateGeom(loc);
  return <Frame label="Put the probe block away; the machine moves to X0 Y0">
    <Stock />
    <g className="faded"><Plate g={g} /></g>
    <path className="art-seg plan" d={`M${g.at(PLATE / 2, PLATE / 2).x} ${g.at(PLATE / 2, PLATE / 2).y}Q${(S.x0 + S.x1) / 2} ${(S.y0 + S.y1) / 2} ${W / 2 + 70} ${H / 2 - 40}`} markerEnd="url(#art-head)" />
    <text className="art-note" x={W / 2 + 40} y={H / 2 - 50}>block and magnet away</text>
    <Bit p={g.C} label="moves to X0 Y0" />
  </Frame>;
}

// Measure stock with the 3D probe: the moves round the stock, from the program's marks.
export function MeasureArt({ moves, cur = -1, probeY }) {
  const c = { x: (S.x0 + S.x1) / 2, y: (S.y0 + S.y1) / 2 };
  const L = { o: { x: S.x0 - 22, y: c.y }, f: { x: S.x0 - 4, y: c.y } }, R = { o: { x: S.x1 + 22, y: c.y }, f: { x: S.x1 + 4, y: c.y } };
  const F = { o: { x: c.x, y: S.y1 + 20 }, f: { x: c.x, y: S.y1 + 4 } }, K = { o: { x: c.x, y: S.y0 - 20 }, f: { x: c.x, y: S.y0 - 4 } };
  let at = c;
  const segs = (moves || []).map(({ label: l }) => {
    const go = (to, guard = true) => { const s = { from: at, to, guard }; at = to; return s; };
    if (/stock top/.test(l)) return { dot: "down", at: c, touch: true };
    if (/past the left/.test(l)) return go(L.o);
    if (/past the right/.test(l)) return go(R.o);
    if (/past the front/.test(l)) return go(F.o);
    if (/past the back/.test(l)) return go(K.o);
    if (/back to the middle/.test(l)) return go({ x: c.x, y: at.y });
    if (/^Go down/.test(l)) return { dot: "down", at, guard: true };
    if (/left end/.test(l)) return { from: L.o, to: L.f, touch: true };
    if (/right end/.test(l)) return { from: R.o, to: R.f, touch: true };
    if (/front face/.test(l)) return { from: F.o, to: F.f, touch: true };
    if (/back face/.test(l)) return { from: K.o, to: K.f, touch: true };
    if (/new zero/.test(l)) return { dot: "up", at: c };
    return null;
  });
  return <Frame label="Measure stock: the probe's moves round the stock">
    <Stock labels={false} />
    <text className="art-label" x={c.x} y={S.y1 + 34 > H ? H - 2 : S.y1 + 26} textAnchor="middle">{probeY ? "" : "Front"}</text>
    <Path segs={segs} cur={cur} />
    <Bit p={c} on={cur < 0} label={cur < 0 ? "start over the middle" : null} />
  </Frame>;
}

// The tool setter: up, over, guarded down, touch, back.
export function SetterArt({ moves, cur = -1, probe }) {
  const sx = 220, top = 150, start = 70;
  const labels = (moves || []).map((m) => m.label);
  const segs = labels.map((l) => {
    if (/travel height/.test(l)) return { from: { x: 70, y: 120 }, to: { x: 70, y: 40 } };
    if (/over the setter/.test(l)) return { from: { x: 70, y: 40 }, to: { x: sx - 24, y: 40 } };
    if (/towards the setter/.test(l)) return { from: { x: sx + 26, y: 40 }, to: { x: sx + 26, y: start + 30 }, guard: true };
    if (/Touch the setter/.test(l)) return { from: { x: sx + 26, y: start + 34 }, to: { x: sx + 26, y: top - 6 }, touch: true };
    if (/Lift/.test(l)) return { from: { x: sx - 26, y: top - 20 }, to: { x: sx - 26, y: 40 } };
    return null;
  });
  return <Frame label="Tool setter: the tool goes down onto the setter">
    <Table />
    <rect className="art-setter" x={sx - 18} y={top} width="36" height={TABLE - top} rx="2" />
    <rect className="art-setter-top" x={sx - 12} y={top - 6} width="24" height="6" rx="2" />
    <Tool x={sx} tip={cur >= 0 && /Touch|towards/.test(labels[cur] || "") ? top - 8 : start} probe={probe} />
    <Path segs={segs} cur={cur} />
    <text className="art-note" x={sx - 30} y={TABLE - 8} textAnchor="end">setter</text>
  </Frame>;
}

