// Start job wizard (1.31.0) in the browser, against the mock running the real JobPlan.py and Flip.py.
//   (cd src/react-ui && npx vite build && MOCK_WIZARD=1 MOCK_RUN_FAST=1 MOCK_TOOL=router \
//     MOCK_PROGRAM=test/fixtures/sideb-job.nc PORT=8099 node mock/server.mjs &) ; node test/session-wizard.mjs
// Two screens: steps started on one show on the other. Side B of a two-tool job with two reference
// bores: load stock, 3D probe check, Measure stock (+ tool setter touch), find both bores, line up,
// then per tool: swap, Z on the setter, router on, run the part; close and continue halfway.
// The miss scenario also finds a bore from the camera crosshair and hides the wizard to jog.
// SCENARIO=miss (mock started with MOCK_FLIP_DEG=8): the stock is turned too far to find the first
// bore; the wizard says so, nothing is lined up, and the manual position can still be used.
import { chromium } from "playwright";
const BASE = process.env.BASE || "http://localhost:8099";
const SCENARIO = process.env.SCENARIO || "ok";
let ok = true;
const check = (n, c, m = "") => { console.log(`${c ? "PASS" : "FAIL"} ${n} ${m}`); ok &&= !!c; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 8000) { const t = Date.now(); for (;;) { try { if (await fn()) return true; } catch {} if (Date.now() - t > ms) return false; await sleep(150); } }
const visible = (p, t) => p.getByText(t, { exact: false }).first().isVisible().catch(() => false);
const put = (p, name, v) => p.evaluate(([n, b]) => fetch(`/api/next-store/${n}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) }), [name, v]);
const browser = await chromium.launch({ executablePath: process.env.CHROME, args: ["--no-sandbox"] });
const screen = async () => { const c = await browser.newContext({ viewport: { width: 1280, height: 900 } }); const p = await c.newPage(); await p.goto(BASE + "/"); await p.waitForSelector(".chip"); return p; };
const A = await screen(), B = await screen();
await sleep(800);
const ws = await A.evaluateHandle(() => new WebSocket(`ws://${location.host}/websocket`));
await A.evaluate((s) => new Promise((r) => { if (s.readyState === 1) r(); else s.onopen = r; }), ws);
const mock = (cmd) => A.evaluate(([s, t]) => s.send(t), [ws, cmd]);
const mstate = () => A.evaluate(() => new Promise((r) => { const s = new WebSocket(`ws://${location.host}/websocket`); s.onmessage = (e) => { r(JSON.parse(e.data)); s.close(); }; }));
// A saved tool setter (machine X20 Y20 Z-75) and a 2 mm stylus
// miss: the camera offset puts the crosshair on ref2 (stock turned 8° in the mock) from where the mock's stylus sits
const camera = SCENARIO === "miss" ? { offsets: { router: { x: 176.986 - 120.5, y: 186.150 - 88.06 } } } : undefined;
await put(A, "prefs", { setter: { x: 20, y: 20, z: -75, clear: 30, travel: 1000, keep: 30 }, measure: { ball: 2 }, camera });
await sleep(300);

const dlg = (p) => p.getByRole("dialog", { name: "Start job" });
const btn = (p, name) => dlg(p).getByRole("button", { name, exact: true });
const wtext = (p, t) => dlg(p).getByText(t, { exact: false }).first().isVisible().catch(() => false);

await A.locator(".job-file").getByRole("button", { name: "Start job…" }).click();
check("wizard on A", await until(() => wtext(A, "sideb-job.nc")));
check("wizard on B", await until(() => wtext(B, "sideb-job.nc")));
check("overview: two parts, T1 then T2", await until(() => wtext(A, "(2 parts, one per tool)")) && await wtext(A, "T1") && await wtext(A, "T2"));
check("overview: two reference bores, turned over about Y", await wtext(A, "2 reference bores; turned over left to right"));
check("overview: router switched by hand, dial 4", await wtext(A, "switched by hand, dial 4"));
check("14 steps", await until(() => wtext(A, "Step 1 of 14")));
await btn(B, "Start").click();
check("B's Start moves A on: load stock", await until(() => wtext(A, "Clamp the stock")));
check("side B turn-over note", await wtext(A, "Turn the stock over left to right"));
await btn(A, "Stock is clamped").click();
check("3D probe step", await until(() => wtext(B, "Push the stylus sideways")));
await sleep(500);
await mock("mock:touch");
check("touch moves on to Measure stock", await until(() => wtext(A, "sets zero on the front left")));
await btn(A, "Measure stock").click();
check("measured, zero set, setter touched", await until(() => wtext(B, "The tool setter was touched with the probe"), 10000));
await btn(A, "Next").click();
check("Line up side B step", await until(() => wtext(A, "middle of each of side A's reference bores")));
const row = (p, name) => dlg(p).locator(".wz-refs li", { hasText: name });
const order = await dlg(A).locator(".wz-refs li b").allTextContents();
check("nearest bore first (ref2 at X30 Y95, then ref1)", order.join(",") === "ref2,ref1", order.join(","));
if (SCENARIO === "miss") {
  await row(A, "ref2").getByRole("button", { name: "Find and probe" }).click();
  check("miss: never found, said so on both", await until(() => wtext(B, "never found the bore"), 10000) && await wtext(A, "never found the bore"));
  check("miss: no centre recorded", !(await row(A, "ref2").getByText("Centre at machine").isVisible().catch(() => false)));
  check("miss: Line up disabled", await btn(A, "Line up side B and set X/Y zero").isDisabled());
  await row(A, "ref2").getByRole("button", { name: "Use this position" }).click();
  check("miss: manual entry offered", await until(() => row(B, "ref2").getByText("Position typed or taken by eye").isVisible()));
  await row(A, "ref2").getByRole("button", { name: "Clear" }).click();
  await until(() => row(A, "ref2").getByRole("button", { name: "From the camera" }).isEnabled());
  await row(A, "ref2").getByRole("button", { name: "From the camera" }).click();
  check("miss: found from the camera crosshair", await until(() => row(B, "ref2").getByText("Centre at machine").isVisible(), 10000));
  await btn(A, "Hide to jog").click();
  check("miss: hidden to jog, banner on both", await until(() => visible(A, "Back to the wizard")) && await until(() => visible(B, "Back to the wizard")));
  check("miss: jog buttons reachable", !(await dlg(A).isVisible().catch(() => false)));
  await B.getByRole("button", { name: "Back to the wizard" }).click();
  check("miss: back on the same step", await until(() => wtext(A, "middle of each of side A's reference bores")));
  await btn(A, "Close").click();
  await browser.close();
  console.log(ok ? "ALL PASS" : "SOME FAILED");
  process.exit(ok ? 0 : 1);
}
await row(A, "ref2").getByRole("button", { name: "Find and probe" }).click();
check("ref2 found", await until(() => row(B, "ref2").getByText("Centre at machine").isVisible(), 10000));
await row(B, "ref1").getByRole("button", { name: "Find and probe" }).click();
check("ref1 found from ref2 (the far bore, with the stock turned 0.8°)", await until(() => row(A, "ref1").getByText("Centre at machine").isVisible(), 10000));
check("fit: turned 0.800°", await until(() => wtext(A, "Turned 0.800°")));
check("pair distance within the limit", await wtext(A, "ref1–ref2"));
await btn(A, "Line up side B and set X/Y zero").click();
check("lined up, flip copy loaded", await until(() => wtext(B, "flip-sideb-job.nc is loaded")));
check("flip copy selected", await until(() => A.locator(".job-file strong").textContent().then((t) => t === "flip-sideb-job.nc")));
const flipText = await A.evaluate(() => fetch("/api/file/flip-sideb-job.nc").then((r) => r.text()));
check("copy: probe-corner flip and rotated", flipText.includes("(SETUP probe-corner: flip)") && /Rotated 0\.8/.test(flipText), flipText.split("\n").slice(0, 4).join(" | "));
let st = await mstate();
const probe = await A.evaluate(() => fetch("/api/next-store/probe").then((r) => r.json()));
check("probe record loc flip with the offset", probe.loc === "flip" && Math.abs(probe.off.x - st.offset_x) < 1e-3 && Math.abs(probe.off.y - st.offset_y) < 1e-3, JSON.stringify(probe.off));
check("X/Y zero on the program's X0 Y0 (corner + 0.3, -0.2)", Math.abs(st.offset_x - 160.5) < 0.01 && Math.abs(st.offset_y - 87.9) < 0.01, `${st.offset_x} ${st.offset_y}`);

// Close halfway and continue: the place is remembered
await btn(A, "Next").click();
check("cutter step: T1", await until(() => wtext(A, "Take the 3D probe out")));
await btn(A, "Close").click();
check("closed on both", await until(async () => !(await dlg(B).isVisible().catch(() => false))));
await sleep(600);
await B.locator(".job-file").getByRole("button", { name: "Start job…" }).click();
check("reopened (on the flip copy) offers to continue", await until(() => btn(B, "Continue at Cutter · part 1/2").isVisible()));
await btn(B, "Continue at Cutter · part 1/2").click();
check("continued at the cutter step", await until(() => wtext(A, "Take the 3D probe out")));
check("needs 25 mm below the collet", await wtext(A, "25 mm"));
await btn(A, "T1 is in").click();
await mock("mock:toollen 5");
check("Z step offers the setter", await until(() => btn(A, "Measure on the tool setter").isVisible()));
await btn(A, "Measure on the tool setter").click();
check("Z set for T1", await until(() => wtext(B, "Z zero is set for T1"), 10000));
st = await mstate();
check("Z zero follows a cutter 5 mm longer than the probe", Math.abs(st.offset_z - (-42.3 + 5)) < 0.01, String(st.offset_z));
await btn(A, "Next").click();
check("router step: dial 4", await until(() => wtext(A, "Switch the router")) && await wtext(A, "dial 4"));
check("Next waits for the router box", await btn(A, "Next").isDisabled());
await dlg(B).getByLabel(/The router is on/).click();
await until(() => btn(A, "Next").isEnabled());
await btn(A, "Next").click();
await btn(A, "Write part 1").click();
check("part 1 written", await until(() => wtext(A, "part1of2-flip-sideb-job.nc")));
const p1 = await A.evaluate(() => fetch("/api/file/part1of2-flip-sideb-job.nc").then((r) => r.text()));
check("part 1 ends lifted, before T2", p1.includes("Next: T2") && !/\bT2 M6\b/.test(p1));
await btn(A, "Run…").click();
check("Run checklist shown, wizard minimised", await until(() => A.getByRole("button", { name: /^Run( anyway)?$/ }).last().isVisible()) && await until(() => visible(A, "Back to the wizard")));
check("checklist: zero from the flip alignment ok", await until(() => visible(A, "Probed on the reference bores")));
await A.locator(".modal-actions").getByRole("button", { name: /^Run( anyway)?$/ }).click();
check("part 1 ran, wizard asks for T2", await until(() => wtext(A, "Part 1 is done. Take T1 out"), 15000));
check("B shows the same step", await until(() => wtext(B, "Part 1 is done")));
await btn(A, "T2 is in").click();
await mock("mock:toollen -2");
await btn(A, "Measure on the tool setter").click();
check("Z set for T2", await until(() => wtext(A, "Z zero is set for T2"), 10000));
st = await mstate();
check("T2 2 mm shorter", Math.abs(st.offset_z - (-42.3 - 2)) < 0.01, String(st.offset_z));
await btn(A, "Next").click();
await dlg(A).getByLabel(/The router is on/).click();
await until(() => btn(A, "Next").isEnabled());
await btn(A, "Next").click();
await btn(A, "Write part 2").click();
check("part 2 written", await until(() => wtext(A, "part2of2-flip-sideb-job.nc")));
const p2 = await A.evaluate(() => fetch("/api/file/part2of2-flip-sideb-job.nc").then((r) => r.text()));
check("part 2 starts safe: M5, lift, then T2", /M5\nM9\nG21 G90 G17 G54 G94\nG53 G0 Z/.test(p2) && p2.includes("T2"));
await btn(A, "Run…").click();
await until(() => A.locator(".modal-actions").getByRole("button", { name: /^Run( anyway)?$/ }).isVisible());
await A.locator(".modal-actions").getByRole("button", { name: /^Run( anyway)?$/ }).click();
check("job done", await until(() => wtext(B, "Job done"), 15000));
await btn(B, "Finish").click();
check("closed", await until(async () => !(await dlg(A).isVisible().catch(() => false))));
const prefs = await A.evaluate(() => fetch("/api/next-store/prefs").then((r) => r.json()));
check("saved place cleared", !prefs.wizard);
await browser.close();
console.log(ok ? "ALL PASS" : "SOME FAILED");
process.exit(ok ? 0 : 1);
