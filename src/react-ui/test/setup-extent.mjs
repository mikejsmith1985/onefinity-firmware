// readSetup takes the plate check's extent from the controller's G-code check (1.31.5).
//   node src/react-ui/test/setup-extent.mjs
import { readSetup, programExtent } from "../src/setup.js";
let ok = true;
const check = (name, cond, msg = "") => { console.log(`${cond ? "PASS" : "FAIL"} ${name} ${msg}`); ok &&= !!cond; };
const PROG = "(SETUP stock: x=0..100 y=0..50 z=0..10)\n(SETUP tool-d: 6.35)\nG21 G90\nG0 X10 Y10\nG1 X90 Y40 F500\nM30\n";
let calls, lintBody;
globalThis.fetch = async (url) => {
  calls.push(url);
  if (url.startsWith("/api/lint/")) return { ok: lintBody !== null, json: async () => lintBody };
  return { ok: true, body: null, text: async () => PROG };
};
calls = []; lintBody = { lines: 6, extent: { minx: 10, maxx: 90, miny: 10, maxy: 40 } };
let s = await readSetup("a.nc");
check("extent from the controller's check", s.ext.minx === 10 && s.ext.maxy === 40, JSON.stringify(s.ext));
check("program read once, for the sheet only", calls.filter((u) => u.startsWith("/api/file/")).length === 1, calls.join(" "));
calls = []; lintBody = { lines: 6, issues: [] }; // older controller: no extent
s = await readSetup("a.nc");
check("older controller: measured on the screen", JSON.stringify(s.ext) === JSON.stringify(programExtent(PROG)), JSON.stringify(s.ext));
calls = []; lintBody = { lines: 6, extent: null }; // incremental moves
s = await readSetup("a.nc");
check("no extent from the controller: measured on the screen", s.ext && s.ext.maxx === 90);
calls = []; lintBody = null; // check failed
s = await readSetup("a.nc");
check("check failed: measured on the screen", s.ext && s.ext.maxx === 90);
console.log(ok ? "ALL PASS" : "SOME FAILED"); process.exit(ok ? 0 : 1);
