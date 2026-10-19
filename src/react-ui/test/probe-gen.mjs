// Probe program generation (probe.js, 1.29.0).  node src/react-ui/test/probe-gen.mjs
// Motion is checked in probe-sim.py; this checks the structure every program must have.
import { probeProgram, centerSecondProgram, cornerProbeSequence, parseDia, normDia, failText, newToken } from "../src/probe.js";
let ok = true;
const check = (name, cond, msg = "") => { console.log(`${cond ? "PASS" : "FAIL"} ${name} ${msg}`); ok &&= !!cond; };
const config = { probe: { "probe-xdim": 53.975, "probe-ydim": 53.975, "probe-zdim": 15.4, "probe-slow-seek": 25, "probe-fast-seek": 75 },
  "probe-rotary": { "probe-xdim": 40, "probe-ydim": 40, "probe-zdim": 12, "probe-slow-seek": 25, "probe-fast-seek": 75 } };
const dia = parseDia("1/4 in");
check("parseDia", Math.abs(dia.mm - 6.35) < 1e-9 && normDia("0.25in") === "1/4 in" && normDia("6 mm") === "6 mm" && parseDia("abc") === undefined);
const t = newToken();
check("token is a positive integer", Number.isInteger(t) && t > 0 && t < 1e6);

const progs = {
  z: probeProgram({ config, type: "z", dia, token: 7 }),
  rotary: probeProgram({ config, type: "xyz", rotary: true, dia, token: 7 }),
  ...Object.fromEntries(["front-left", "front-right", "back-left", "back-right", "center", "center-x"].map((loc) => [loc, probeProgram({ config, type: loc.startsWith("center") ? "center" : "xyz", loc, dia, token: 7 })])),
  "center 2": centerSecondProgram({ config, loc: "center", dia, token: 7 }),
  "center-x 2": centerSecondProgram({ config, loc: "center-x", dia, token: 7 }),
};
for (const [name, p] of Object.entries(progs)) {
  const L = p.split("\n").map((l) => l.trim()).filter(Boolean);
  check(`${name}: G21, M5, flags cleared first`, L[0] === "G21" && L[1] === "M5" && L[2] === "#<_ofprobe_done> = 0" && L[3] === "#<_ofprobe_fail> = 0", L.slice(0, 4).join(" | "));
  const iDone = L.indexOf("#<_ofprobe_done> = 7");
  check(`${name}: token set once, only if nothing failed, right before M2`, iDone === L.length - 3 && L[iDone - 1].includes("[#<_ofprobe_fail> EQ 0]") && L[L.length - 1] === "M2" && p.split("#<_ofprobe_done> = 7").length === 2);
  check(`${name}: no rapid or feed down, every probe move relative`, !L.some((l) => /^(G91 )?G[01] Z-/.test(l)) && L.filter((l) => /G38/.test(l)).every((l) => l.startsWith("G91 ")));
  check(`${name}: no "else" and no spaces inside words`, !/\belse\b/.test(p) && !/\b[XYZF] [-\d]/.test(p));
  const opens = L.filter((l) => / if /.test(l)).map((l) => l.split(" ")[0]), closes = L.filter((l) => / endif$/.test(l)).map((l) => l.split(" ")[0]);
  check(`${name}: every o-word if has its endif, numbers unique`, opens.length === closes.length && new Set(opens).size === opens.length && opens.every((o) => closes.includes(o)));
  check(`${name}: lifts 25 mm at the end on every path`, L.lastIndexOf("G91 G0 Z25") > L.findLastIndex((l) => / endif$/.test(l) && !l.startsWith("o990")));
}
const plunge = progs["front-left"].split("\n").find((l) => /G38\.3 Z/.test(l));
check("plunge beside the block is guarded at max(fast, 300) mm/min", plunge === "G91 G38.3 Z-13.7 F300", plunge);
check("Z-only probe has no sideways moves", !/ [XY]-?\d/.test(progs.z.replace(/G92 Z[\d.]+/, "")));
check("center second: Z check before any sideways move", progs["center 2"].indexOf("ABS[#<_ofprobe_dz>] GT 0.5") < progs["center 2"].indexOf("X-20"));
check("center-x second: Y not probed or set", !/G92 Y|G38\.\d Y/.test(progs["center-x 2"]));
check("center-x first: Y zero kept", /G92 X0 Z0/.test(progs["center-x"]) && !/G92 Y/.test(progs["center-x"]));
const seq = cornerProbeSequence({ sx: 1, sy: 1, plunge: 13.7, zLift: 1, fastSeek: 75, slowSeek: 25, skipZ: true });
check("skipZ leaves out the Z touch", !/G38\.2 Z/.test(seq));
check("fail texts", failText("guard", 1)[1].includes("going down beside it") && failText("notfound")[0] === "Probe block not found" && failText("send")[1].includes("Nothing was moved"));
console.log(ok ? "ALL PASS" : "SOME FAILED"); process.exit(ok ? 0 : 1);
