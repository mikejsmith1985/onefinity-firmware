// Which move of a probing program is running (1.31.1).
//
// Each program marks its moves with a line   #<_of_step> = N (what it does)   just before them.
// The controller's planner publishes #<_name> globals when the machine gets to them (as of_step),
// exactly the way the done tokens arrive, so a screen can show which move is running now. The
// labels are read back from the program text, so the program is the only list of its moves.
export const STEP_RESET = "#<_of_step> = 0";
const clean = (s) => String(s).replace(/[()\n]/g, "").trim();

// A numbering function for one program: mark("Touch the block top") -> "#<_of_step> = 1 (...)"
export function marker() {
  let n = 0;
  const mark = (label) => `#<_of_step> = ${++n} (${clean(label)})`;
  return mark;
}

// [{n, label}] in program order
export function programMoves(prog) {
  const out = [], seen = new Set();
  for (const m of String(prog || "").matchAll(/^#<_of_step> = (\d+) \(([^)]*)\)\s*$/gm)) {
    const n = Number(m[1]);
    if (!seen.has(n)) { seen.add(n); out.push({ n, label: m[2] }); }
  }
  return out;
}

// What to show while a program runs: {cur: index of the running move or -1, of: count, label}
export function moveStatus(moves, ofStep) {
  const n = Number(ofStep) || 0;
  const i = moves.findIndex((m) => m.n === n);
  return { cur: i, of: moves.length, label: i >= 0 ? moves[i].label : "" };
}
