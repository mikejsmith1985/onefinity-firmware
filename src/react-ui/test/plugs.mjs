// Router and vac plugs (1.35.0): the strip on the control page and the settings.
//   (cd src/react-ui && npx vite build && PORT=8099 node mock/server.mjs &) ; node test/plugs.mjs
//   With MOCK_PLUG_OFFLINE=1 on the mock: OFFLINE=1 node test/plugs.mjs
import { chromium } from "playwright";
const BASE = process.env.BASE || "http://localhost:8099";
let ok = true;
const check = (n, c, m = "") => { console.log(`${c ? "PASS" : "FAIL"} ${n} ${m}`); ok &&= !!c; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 6000) { const t = Date.now(); for (;;) { try { if (await fn()) return true; } catch {} if (Date.now() - t > ms) return false; await sleep(150); } }
const getPrefs = () => fetch(BASE + "/api/next-store/prefs").then((r) => r.json()).catch(() => ({}));

const browser = await chromium.launch({ executablePath: process.env.CHROME, args: ["--no-sandbox"] });
for (const [w, h] of [[1280, 900], [800, 480]]) {
  const p = await (await browser.newContext({ viewport: { width: w, height: h } })).newPage();
  const errors = []; p.on("pageerror", (e) => errors.push(String(e)));
  await p.goto(BASE + "/"); await p.waitForSelector(".chip"); await sleep(1000);
  const strip = p.locator(".plugs");
  check(`${w}: strip shown`, await until(() => strip.isVisible()));
  const router = strip.locator(".plug").filter({ hasText: "Router" }), vac = strip.locator(".plug").filter({ hasText: "Vac" });
  if (process.env.OFFLINE) {
    check(`${w}: offline router shown in red text`, await router.getByText("Not answering").isVisible());
    check(`${w}: offline router: On disabled`, await router.getByRole("button", { name: "On" }).isDisabled());
  } else {
    check(`${w}: both off`, (await router.textContent()).includes("Off") && (await vac.textContent()).includes("Off"));
    await vac.getByRole("button", { name: "On" }).click();
    check(`${w}: vac on with watts`, await until(() => vac.getByText("On · 980 W").isVisible()));
    await vac.getByRole("button", { name: "Off" }).click();
    check(`${w}: vac back off`, await until(async () => (await vac.textContent()).includes("Off")));
  }
  const box = await strip.boundingBox();
  check(`${w}: strip fits the panel width`, box && box.x >= 0 && box.x + box.width <= w + 1, JSON.stringify(box));
  if (process.env.SHOT_DIR) await strip.screenshot({ path: `${process.env.SHOT_DIR}/plugs-strip-${w}${process.env.OFFLINE ? "-offline" : ""}.png` });
  check(`${w}: no page errors`, errors.length === 0, errors.join(" | "));
  await p.close();
}

// Settings
const p = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
await p.goto(BASE + "/"); await p.waitForSelector(".chip"); await sleep(800);
await p.evaluate(() => { location.hash = "#admin-general"; }); await sleep(800);
const grp = p.locator("section, .group, fieldset").filter({ hasText: "Router and vac plugs" }).last();
check("settings: group shown", await until(() => p.getByText("Router and vac plugs").first().isVisible()));
const ip = p.getByLabel("Router plug address");
await ip.fill("192.168.4.173"); await ip.blur(); await sleep(600);
check("settings: address saved", (await getPrefs())?.plugs?.router?.ip === "192.168.4.173");
const auto = p.locator(".plug-pref").first().getByRole("checkbox");
if (!(await auto.isChecked())) await auto.check();
await sleep(600);
check("settings: Auto saved", (await getPrefs())?.plugs?.router?.auto === true);
const spin = p.getByLabel("Router spin-up wait after M3 (seconds)");
await spin.fill("5"); await spin.blur(); await sleep(600);
const pr = await getPrefs();
check("settings: spin-up saved, other prefs kept", pr?.plugs?.spinup === 5 && pr?.plugs?.router?.ip === "192.168.4.173");
if (process.env.SHOT_DIR) await p.getByText("Router and vac plugs").first().locator("xpath=..").screenshot({ path: `${process.env.SHOT_DIR}/plugs-settings.png` });
await browser.close();
console.log(ok ? "ALL PASS" : "SOME FAILED"); process.exit(ok ? 0 : 1);
