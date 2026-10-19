// Colored comment lines in the G-code tab.
//
// A comment that starts with @<color> colors its line:
//
//   (@blue Material: 24 x 12 x 0.75 in)       one line, shown as (Material: 24 x 12 x 0.75 in)
//   ; @red Bit: 1/4" downcut, 18000 RPM        semicolon comments work too
//   G0 X0 Y0 (@green start here)               a tag in a trailing comment colors the whole line
//
// A tag on its own starts a block that runs until the next block tag or @end:
//
//   (@green)
//   (Zero: front-left corner)
//   (Z: top of stock)
//   (@end)                                     back to the normal color (also @default, @black, @normal)
//
// Colors: blue, red, green, yellow, orange, purple, cyan, pink, gray/grey, white, or a hex code (@#ff8800).
// Tags are case-insensitive. Everything is a comment, so the planner ignores it and a tagged file runs
// the same on any controller; without this feature the tags just show as plain comment text.

export const COLORS = {
  blue: "var(--blue)", red: "var(--red)", green: "var(--green)", yellow: "var(--yellow)",
  orange: "#ff9f43", purple: "#b583ff", cyan: "#3dd6d0", pink: "#ff7eb6",
  gray: "var(--dim)", grey: "var(--dim)", white: "#ffffff",
};
const RESET = new Set(["end", "default", "black", "normal", "reset"]);

// @word or @#hex right after a comment opener. Group 1: opener + spaces, 2: tag, 3: what follows the tag.
const TAG = /(\(\s*|;\s*)@(#[0-9a-f]{3}(?:[0-9a-f]{3})?|[a-z]+)\b([^)]*)/i;

const colorOf = (tag) => {
  const t = tag.toLowerCase();
  if (t.startsWith("#")) return t;
  return COLORS[t] || null;
};

// Reads one line. Returns null when it has no recognized tag, otherwise
// { color, reset, bare, text } where text is the line with the tag removed.
export function readTag(line) {
  const m = TAG.exec(line);
  if (!m) return null;
  const tag = m[2].toLowerCase();
  const reset = RESET.has(tag);
  const color = reset ? null : colorOf(tag);
  if (!reset && !color) return null; // @something we don't know: leave the line alone
  const rest = m[3];
  const bare = rest.trim() === "";
  // Drop "@tag" and one following space so (@blue Material) reads (Material)
  const text = line.slice(0, m.index) + m[1] + rest.replace(/^ /, "") + line.slice(m.index + m[0].length);
  return { color, reset, bare, text };
}

// Colors for every line of a program: [{ color, text, marker }] (null entries for plain lines).
export function colorLines(lines) {
  const out = new Array(lines.length).fill(null);
  let block = null;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    // Fast skip: no "@" means no tag, so the line only takes the open block's color
    if (l.indexOf("@") < 0) { if (block) out[i] = { color: block, text: l }; continue; }
    const t = readTag(l);
    if (!t) { if (block) out[i] = { color: block, text: l }; continue; }
    if (t.bare) {
      // Block marker: open or close a block, and show the marker itself dimmed
      block = t.reset ? null : t.color;
      out[i] = { color: null, text: l, marker: true };
    } else {
      out[i] = { color: t.reset ? null : t.color, text: t.text };
    }
  }
  return out;
}
