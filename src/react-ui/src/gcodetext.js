// Comments read the way the planner (CAMotics) reads them (1.29.0), the same rules as
// src/py/bbctrl/GCodeText.py: a comment ends at the first ")", so "(a (b) c)" leaves " c)" as code.
// Returns the problems on one line: "nested" ( inside a comment ), "stray" ( ")" outside one ), "unclosed".
export function commentIssues(line, inComment = false) {
  const issues = new Set();
  let open = inComment;
  for (const ch of line) {
    if (open) {
      if (ch === ")") open = false;
      else if (ch === "(") issues.add("nested");
    } else if (ch === "(") open = true;
    else if (ch === ")") issues.add("stray");
    else if (ch === ";") break;
  }
  if (open) issues.add("unclosed");
  return { issues: [...issues], open };
}

export const CORNERS = ["front-left", "front-right", "back-left", "back-right", "center", "center-x"];
// "Front Left", "front_left", " FRONT-LEFT " -> "front-left"
export const normCorner = (t) => (t == null ? null : String(t).trim().toLowerCase().replace(/[\s_]+/g, "-"));
