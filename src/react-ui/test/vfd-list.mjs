// VFD types ported from Buildbotics (1.44.0): each new type is in the Tool tab, its front-panel
// notes and manual link show, and the config value is the one the motion board numbers expect.
//   (cd src/react-ui && npx vite build && PORT=8097 node mock/server.mjs &) ; node test/vfd-list.mjs
import { chromium } from "playwright";
import { readFileSync } from "fs";
const BASE = process.env.BASE || "http://localhost:8097";
let ok = true;
const check = (n, c, m = "") => { console.log(`${c ? "PASS" : "FAIL"} ${n} ${m}`); ok &&= !!c; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The motion board's spindle_type_t order must match the template's tool-type list (the index is sent as "st").
const tmpl = JSON.parse(readFileSync(new URL("../../resources/config-template.json", import.meta.url)));
const names = tmpl.tool["tool-type"].values;
const hdr = readFileSync(new URL("../../avr/src/spindle.h", import.meta.url), "utf8");
const enumBody = hdr.slice(hdr.indexOf("SPINDLE_TYPE_DISABLED"), hdr.indexOf("} spindle_type_t"));
const types = [...enumBody.matchAll(/SPINDLE_TYPE_(\w+)/g)].map((m) => m[1]);
check("template and motion board list the same number of types", names.length === types.length, `${names.length} vs ${types.length}`);
const expect = { 14: "H100", 15: "WJ200", 16: "DMM_DYN4", 17: "GALT_G200", 18: "TECO_E510", 19: "FULING_DZB200", 20: "HUANYANG_GT", 21: "DELTA" };
for (const [i, t] of Object.entries(expect)) check(`type ${i} is ${t} on the motion board`, types[i] === t, `got ${types[i]} for "${names[i]}"`);
check("existing numbers unchanged (Redline 12, EM60 13 on the board)", types[12] === "REDLINE_VFD" && types[13] === "EM60");

const NEW = [
  ["H100", "H100 VFD manual"], ["WJ200", "WJ200 VFD manual"], ["DMM DYN4 (Beta)", "DMM DYN4 VFD manual"],
  ["Galt G200/G500", "Galt G200 VFD manual"], ["Teco Westinghouse E510", "E510 VFD manual"],
  ["Fuling DZB200/300", "Fuling DZB200/300 VFD manual"], ["Huanyang GT-series", "Huanyang GT-series VFD manual"],
  ["Delta VFD (generic)", "Delta VFD015M21A VFD manual"],
];
const browser = await chromium.launch({ executablePath: process.env.CHROME, args: ["--no-sandbox"] });
const p = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
const errors = []; p.on("pageerror", (e) => errors.push(String(e)));
await p.goto(BASE + "/#tool"); await p.waitForSelector("#tool-sel"); await sleep(800);
for (const [name, link] of NEW) {
  const opt = p.locator("#tool-sel option", { hasText: name });
  check(`${name}: listed`, (await opt.count()) === 1);
  await p.selectOption("#tool-sel", { label: name }); await sleep(300);
  check(`${name}: front-panel notes and manual link`, await p.getByRole("link", { name: link }).isVisible());
  check(`${name}: Modbus settings shown`, await p.getByText("VFD status").isVisible());
}
check("no page errors", errors.length === 0, errors.join(" | "));
await browser.close();
console.log(ok ? "ALL PASS" : "SOME FAILED"); process.exit(ok ? 0 : 1);
