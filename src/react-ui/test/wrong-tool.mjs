// Router program with the Laser selected (1.35.1): red warning under the program, red stop at Run, none for a dry run.
//   (cd src/react-ui && npx vite build && MOCK_TOOL=laser PORT=8097 node mock/server.mjs &) ; node test/wrong-tool.mjs
import { chromium } from "playwright";
const BASE = process.env.BASE || "http://localhost:8097";
let ok = true;
const check = (n, c, m = "") => { console.log(`${c ? "PASS" : "FAIL"} ${n} ${m}`); ok &&= !!c; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 8000) { const t = Date.now(); for (;;) { try { if (await fn()) return true; } catch {} if (Date.now() - t > ms) return false; await sleep(150); } }
const browser = await chromium.launch({ executablePath: process.env.CHROME, args: ["--no-sandbox"] });
const p = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
const errors = []; p.on("pageerror", (e) => errors.push(String(e)));
await p.goto(BASE + "/"); await p.waitForSelector(".chip"); await sleep(1200);
check("live warning under the program", await until(() => p.locator(".live-warn").filter({ hasText: "Wrong tool" }).isVisible()));
await p.getByRole("button", { name: "Run", exact: true }).first().click();
check("Run: red stop names the tool", await until(() => p.locator(".stop-banner").filter({ hasText: "Tool is set to Laser" }).isVisible()));
if (process.env.SHOT) await p.locator(".stop-banner").screenshot({ path: process.env.SHOT });
await p.getByRole("button", { name: /Cancel/ }).first().click(); await sleep(400);
await p.getByLabel("Dry run").click(); await until(() => p.getByLabel("Dry run").isChecked());
check("dry run: no wrong-tool warning", await until(async () => (await p.locator(".live-warn").filter({ hasText: "Wrong tool" }).count()) === 0));
check("no page errors", errors.length === 0, errors.join(" | "));
await browser.close();
console.log(ok ? "ALL PASS" : "SOME FAILED"); process.exit(ok ? 0 : 1);
