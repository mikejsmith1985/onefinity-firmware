// Square the machine (1.53.0): the arithmetic behind the wizard (SquareMachine.jsx).
//
// Seen from the front of the machine: +X to the right, +Y to the back. The four feet are measured
// where the steel rail shafts go into them: FL, FR (front), BL, BR (back).
//
// With the two rails parallel (the gantry sets their spacing W) the frame is a parallelogram: the
// back pair sits a distance s to the side of where it would be for a rectangle. Its diagonals are
//   dA = FL->BR,  dA^2 = (W + s)^2 + L^2
//   dB = FR->BL,  dB^2 = (W - s)^2 + L^2
// so dA^2 - dB^2 = 4 W s exactly, and s = (dA^2 - dB^2) / (4 W). L is the length between the feet.
//
// Homing drives each Y side against its front foot, and the gantry is seated against the front feet
// (Onefinity's method), so the gantry lies along the front feet. A frame skew of s over L then
// shows up as X out of square to Y by the same angle: 400 * s / L mm over 400 mm, the unit the
// Squareness check reports in (and judged with the same limits, see square.js squareText).

export const FEET = [
  ["fr", "Front right"], ["fl", "Front left"], ["br", "Back right"], ["bl", "Back left"],
];

// The same limits as the Squareness check (square.js): mm over 400 mm
export const SQUARE_OK = 0.1, SQUARE_CLOSE = 0.3;

export function verdict(per400) {
  const d = Math.abs(per400);
  return d <= SQUARE_OK ? "square" : d <= SQUARE_CLOSE ? "close" : "out";
}

// r: {w, da, db} in mm (rail spacing centre to centre, diagonal FL->BR, diagonal FR->BL);
// optional front, back: the spacing measured at each end.
// Returns null when the readings can't be a frame, else
//   s: the back pair's offset to the right (+) or left (-) of a rectangle, mm
//   len: the length between the feet, mm
//   per400: the resulting error, mm over 400 mm
//   misread: how much s changes for 1 mm misread on one diagonal, mm
//   taper: back spacing minus front spacing, when both are given
export function frameSkew(r) {
  const w = +r.w, da = +r.da, db = +r.db;
  if (!(w > 0 && da > 0 && db > 0)) return null;
  const s = (da * da - db * db) / (4 * w);
  const l2 = (da * da + db * db) / 2 - w * w - s * s;
  if (!(l2 > 0)) return null;
  const len = Math.sqrt(l2);
  const out = { s, len, per400: (400 * s) / len, misread: Math.max(da, db) / (2 * w) };
  if (+r.front > 0 && +r.back > 0) out.taper = +r.back - +r.front;
  return out;
}

// Which feet move, and which way, to take the skew out. The locked foot stays put, so the pair
// at the other end moves: with a front foot locked the back pair moves by -s; with a back foot
// locked the front pair moves by +s. Returns {pair: "back"|"front", dir: "left"|"right", by: mm}.
export function frameFix(skew, locked) {
  if (!skew) return null;
  const front = locked === "fl" || locked === "fr";
  const move = front ? -skew.s : skew.s;      // + is to the right
  return { pair: front ? "back" : "front", dir: move >= 0 ? "right" : "left", by: Math.abs(move) };
}

// --- 1.54.0: correct with the probe -------------------------------------------------------------
// After the gantry is seated and the Squareness check still reads an error e (mm over 400 mm,
// signed as square.js reports it), the frame is out by the angle e/400. Two moves take it out:
//   "rail": slide the rail on the side away from the locked foot along its length by e/400 * W
//           (W: rail spacing). The rail's own spacing doesn't change.
//   "pair": move the pair of feet at the far end from the locked foot sideways by e/400 * L
//           (L: the frame length between the feet).
// Which way is right depends on how the check's sign maps onto this frame, which isn't known, so
// the first round moves half the amount either way, and every round after that learns the answer
// from what the last one did: k = (after - before) / signed move, next move = -e / k.

// The check repeats to about this (mm over 400 mm, the spread of 3 runs on the machine, Oct 30)
export const CHECK_NOISE = 0.1;

// Direction 0 / 1 for each kind of move, in words
export const MOVE_DIRS = { rail: ["toward the front", "toward the back"], pair: ["to the right", "to the left"] };

export function moveParts(locked) {
  const l = locked || "fr";
  return { rail: l[1] === "r" ? "left" : "right", pair: l[0] === "f" ? "back" : "front" };
}

// e: the error now (signed); rounds: [{method, by, dir, before, after}] (after set once checked);
// dim: W or L in mm. Returns {by, dir (0/1, or null when either way), learned, k, from, small}.
export function probeNext(e, rounds, method, dim) {
  if (!Number.isFinite(e) || !(dim > 0)) return null;
  const same = (rounds || []).filter((r) => r.method === method && r.by > 0 && Number.isFinite(r.after) && Number.isFinite(r.before));
  const usable = same.filter((r) => Math.abs(r.after - r.before) >= CHECK_NOISE);
  const last = usable[usable.length - 1];
  const geo = (Math.abs(e) / 400) * dim;
  const small = same.length > 0 && same[same.length - 1] !== last;
  if (last) {
    const k = (last.after - last.before) / (last.by * (last.dir === 1 ? -1 : 1));
    const m = -e / k;
    return { by: Math.abs(m), dir: m >= 0 ? 0 : 1, learned: true, k, from: last, small, geo,
             odd: Math.abs(m) > 3 * geo || Math.abs(m) < geo / 3 };
  }
  return { by: geo / 2, dir: null, learned: false, small, geo };
}
