// Tool setter run ending in an E-stop (1.34.2): the screen must finish with a message, not sit on the running step.
//   (cd src/react-ui && npx vite build && MOCK_SETTER_ESTOP=1 PORT=8099 node mock/server.mjs &) ; node test/setter-estop.mjs
import { chromium } from "playwright";
const BASE = process.env.BASE || "http://localhost:8099";
let ok = true;
const check = (n, c, m = "") => { console.log(`${c ? "PASS" : "FAIL"} ${n} ${m}`); ok &&= !!c; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 8000) { const t = Date.now(); for (;;) { try { if (await fn()) return true; } catch {} if (Date.now() - t > ms) return false; await sleep(150); } }
const prefs = await fetch(BASE + "/api/next-store/prefs").then((r) => r.json()).catch(() => ({}));
await fetch(BASE + "/api/next-store/prefs", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...(prefs || {}), setter: { x: 300, y: 300, z: -60, keep: 30 } }) });

const browser = await chromium.launch({ executablePath: process.env.CHROME, args: ["--no-sandbox"] });
const p = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
const errors = []; p.on("pageerror", (e) => errors.push(String(e)));
await p.goto(BASE + "/"); await p.waitForSelector(".chip"); await sleep(1200);
await p.getByRole("button", { name: "Tool setter" }).first().click();
await p.getByRole("button", { name: "Take reference with this tool" }).click();
check("run started", await until(() => p.getByText("Taking the reference").isVisible(), 4000));
check("finishes with the E-stop message", await until(() => p.locator(".err, [role=alert]").filter({ hasText: "A touch found nothing" }).first().isVisible()));
check("says nothing was saved", await p.getByText("Nothing was saved", { exact: false }).first().isVisible());
if (process.env.SHOT) await p.screenshot({ path: process.env.SHOT });
check("no page errors", errors.length === 0, errors.join(" | "));
await browser.close();
console.log(ok ? "ALL PASS" : "SOME FAILED"); process.exit(ok ? 0 : 1);
