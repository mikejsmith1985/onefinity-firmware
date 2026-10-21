// Setup sheet parsing and checks (1.29.0).  node src/react-ui/test/setup-sheet.mjs
import { parseSetup, stockChecks, probeChecks, sheetLineChecks } from "../src/setup.js";
import { commentIssues, normCorner } from "../src/gcodetext.js";
import { lintChecks, } from "../src/lint-checks.js";
let ok = true;
const check = (name, cond, msg = "") => { console.log(`${cond ? "PASS" : "FAIL"} ${name} ${msg}`); ok &&= !!cond; };

// Comment reading, the same rules as GCodeText.py
check("plain comment", commentIssues("G1 X1 (feed) Y2").issues.length === 0);
check("nested + stray", commentIssues("(SETUP tool: T1 (6.35mm))").issues.sort().join() === "nested,stray");
check("unclosed carries", commentIssues("(open").open === true && commentIssues("X1)", true).issues.length === 0);
check("semicolon ends the line", commentIssues("G0 X1 ; a (b) c)").issues.length === 0);
check("corner names normalised", normCorner(" Front Left ") === "front-left" && normCorner("BACK_RIGHT") === "back-right");

const sheet = (lines) => parseSetup(lines.join("\n") + "\nG21\nG0 X0 Y0\n");
// 1. A good sheet
let s = sheet(["(SETUP stock: x=0..300 y=0..200 z=-19..0)", "(SETUP tool-d: 6.35)", "(SETUP probe-corner: front-left)", "(SETUP tool: T1 FLAT 1/4in [6.35mm])"]);
check("good sheet", s.stock && s.stock.x.max === 300 && s.corner === "front-left" && !s.stockBad && !s.cornerBad && s.bad.length === 0, JSON.stringify(s.bad));
// 1b. Stock top for the Depth view (1.32.1)
check("stock top from the stock line", sheet(["(SETUP stock: x=0..152.4 y=0..304.8 z=0..24.3)"]).stockTop === 24.3);
check("stock top from plate when Z0 is on the stock bottom", sheet(["(SETUP plate: 152.4 X 304.8 X 24.3 MM)", "(SETUP zero: FRONT-LEFT CORNER, Z0 ON STOCK BOTTOM, +Y IS THE BACK)"]).stockTop === 24.3);
check("stock top from plate when Z0 is on the MDF", sheet(["(SETUP plate: 100 x 50 x 12 mm)", "(SETUP zero: front-left, Z0 on MDF)"]).stockTop === 12);
check("stock top 0 when Z0 is on the stock top", sheet(["(SETUP zero: back-left, Z0 ON STOCK TOP)"]).stockTop === 0);
check("no stock top when the sheet doesn't say", sheet(["(SETUP job: test)"]).stockTop === null);
// 2. Nested brackets in a SETUP line are flagged as a stop
s = sheet(["(SETUP tool: T1 FLAT 1/4in (6.35mm) - 2FL)", "(SETUP router: DIAL 4)"]);
check("nested SETUP line flagged", s.bad.length === 1 && s.bad[0].line === 1, JSON.stringify(s.bad));
const sl = sheetLineChecks(s);
check("as a red item", sl.length === 1 && sl[0].level === "stop" && /\[ \]/.test(sl[0].text), sl[0]?.text);
check("the field is still shown", s.fields.some((f) => f.key === "tool" && f.text.includes("6.35mm")));
// 3. A stock line that can't be read: a warning, not silence
s = sheet(["(SETUP stock: 300 x 200 x 19)"]);
const sc = stockChecks(s);
check("malformed stock warns", s.stock === null && s.stockBad === "300 x 200 x 19" && sc.length === 1 && sc[0].level === "warn" && /NOT checked/.test(sc[0].text), sc[0]?.text);
s = sheet(["(SETUP stock: x=0..300)"]);
check("stock without y warns", stockChecks(s)[0]?.level === "warn");
check("no stock line: nothing", stockChecks(sheet(["(SETUP job: test)"])).length === 0);
// 4. Corners: written differently still matches; unknown corner warns instead of a false WRONG ZERO
s = sheet(["(SETUP probe-corner: Front Left)"]);
check("'Front Left' reads as front-left", s.corner === "front-left");
check("matches a front-left probe", probeChecks(s, { loc: "front-left", time: 1, off: {} }, {})[0].level === "ok");
check("a different probe is WRONG ZERO", probeChecks(s, { loc: "back-left", time: 1 }, {})[0].name === "WRONG ZERO");
s = sheet(["(SETUP probe-corner: top-middle)"]);
const pc = probeChecks(s, { loc: "front-left" }, {});
check("unknown corner warns, no stop", s.corner === null && s.cornerBad === "top-middle" && pc.length === 1 && pc[0].level === "warn", pc[0]?.text);

// 5. The controller's G-code check as checklist items
const items = lintChecks({ issues: [
  { key: "g83", level: "error", msg: "G83 runs as G81.", lines: [12, 40], count: 5 },
  { key: "plunge", level: "warn", msg: "Straight plunge.", lines: [7], count: 1 },
  { key: "wcs", level: "info", msg: "No G54.", lines: [3], count: 1 }] });
check("errors are red, warnings amber, notes left out", items.length === 2 && items[0].level === "stop" && items[1].level === "warn");
check("lines listed with the rest counted", items[0].text.startsWith("Lines 12, 40 and 3 more: "), items[0].text);
check("no result: no items", lintChecks(null).length === 0);
console.log(ok ? "ALL PASS" : "SOME FAILED"); process.exit(ok ? 0 : 1);
