// Screenshots of every probing screen (1.31.1), against the mock server.
//   SCENARIO=xyz LOC=front-left OUT=dir node test/probe-screens.mjs   (mock: MOCK_PROBE_MS=600)
//   SCENARIO=fail ...  (mock: MOCK_PROBE_FAIL_AT=4)    SCENARIO=z    SCENARIO=measure|setter (mock: MOCK_SLOW=6)
import { chromium } from "playwright";
import fs from "node:fs";

const BASE = process.env.BASE || "http://localhost:8099";
const OUT = process.env.OUT || "/workspace/release/probe-ui-1.31.1";
const LOC = process.env.LOC || "front-left", SC = process.env.SCENARIO || "xyz";
fs.mkdirSync(OUT, { recursive: true });
let ok = true, n = 0;
const check = (name, cond, msg = "") => { console.log(`${cond ? "PASS" : "FAIL"} ${name} ${msg}`); ok &&= !!cond; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 8000) { const t = Date.now(); for (;;) { try { if (await fn()) return true; } catch {} if (Date.now() - t > ms) return false; await sleep(100); } }
const browser = await chromium.launch({ executablePath: process.env.CHROME || "/usr/bin/google-chrome", args: ["--no-sandbox"] });
const ctx = await browser.newContext({ viewport: { width: 1024, height: 600 } }); // the controller's touchscreen
const p = await ctx.newPage();
await p.goto(BASE + "/"); await p.waitForSelector(".chip"); await sleep(800);
const visible = (t) => p.getByText(t, { exact: false }).first().isVisible().catch(() => false);
const prefix = SC === "xyz" || SC === "fail" ? `${SC}-${LOC}` : SC;
const shot = async (name) => { const f = `${OUT}/${prefix}-${String(++n).padStart(2, "0")}-${name}.png`; await p.screenshot({ path: f }); console.log("SHOT", f); };
const touch = () => p.evaluate(() => { const s = new WebSocket(`ws://${location.host}/websocket`); s.onopen = () => { s.send("mock:touch"); setTimeout(() => s.close(), 500); }; });
const btn = (name) => { const d = p.getByRole("dialog"); return d.getByRole("button", { name, exact: true }).first(); };
const mainBtn = (name) => p.getByRole("button", { name, exact: true }).first();

if (SC === "xyz" || SC === "fail" || SC === "z") {
  await mainBtn(SC === "z" ? "Probe Z" : "Probe XYZ").click();
  check("check probe", await until(() => visible("touch the probe block to the bit")));
  await shot("check-probe");
  await touch();
  if (SC !== "z") {
    check("bit size", await until(() => visible("Cutter diameter")));
    await shot("bit-size");
    await btn("Next").click();
    check("location", await until(() => visible("Front-left corner")));
    const radio = p.locator(`input[name=loc][value=${LOC}]`);
    await radio.click(); // shared state: checked once the server echoes it
    check("corner chosen", await until(() => radio.isChecked()));
    await sleep(400);
    await shot("zero-corner");
    await btn("Next").click();
  }
  check("place", await until(() => btn("Start probing").isVisible()));
  await shot("place-block");
  await btn("Start probing").click();
  check("running", await until(() => visible("Move 1 of")));
  check("Next disabled while running", await btn("Probing…").isDisabled());
  check("Stop shown while running", await btn("Stop").isVisible());
  await shot("probing-start");
  if (await until(() => visible("Move 3 of"), 6000)) await shot("probing-move3");
  if (SC !== "fail" && await until(() => visible("Move 6 of"), 6000)) await shot("probing-move6");
  if (SC === "fail") {
    check("failure page", await until(() => visible("Stopped during move"), 15000));
    await shot("failed");
  } else {
    check("done", await until(() => visible("put away the probe"), 20000));
    await shot("done");
    await btn("Done").click();
  }
} else if (SC === "measure") {
  await mainBtn("Measure stock").click();
  check("setup", await until(() => visible("Measures the top and the real edges")));
  await p.getByRole("dialog").locator("input").first().fill("100");
  await sleep(400);
  await shot("setup");
  await btn("Next").click();
  check("check", await until(() => visible("Check the probe")));
  await shot("check-probe");
  await touch();
  check("place", await until(() => btn("Start measuring").isVisible()));
  await shot("position");
  await btn("Start measuring").click();
  check("running", await until(() => visible("Move 1 of")));
  await sleep(2500); await shot("measuring");
  await sleep(2500); await shot("measuring-later");
  check("done", await until(() => btn("Done").isVisible(), 20000));
  await sleep(300); await shot("done");
} else if (SC === "setter") {
  await mainBtn("Tool setter").click();
  check("setter", await until(() => visible("Tool setter")));
  await sleep(500); await shot("setter");
  if (await btn("Save setter position").isEnabled().catch(() => false)) { await btn("Save setter position").click(); await sleep(800); }
  const go = btn("Take reference with this tool");
  if (await go.isEnabled().catch(() => false)) {
    await go.click();
    check("running", await until(() => visible("Move 1 of")));
    await sleep(1500); await shot("measuring");
    await until(async () => !(await visible("Move ")), 20000);
    await sleep(300); await shot("result");
  } else check("setter measure enabled", false, "(not ready in the mock)");
}
await browser.close();
console.log(ok ? "ALL PASS" : "SOME FAILED");
