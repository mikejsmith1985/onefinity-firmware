// User I/O on the I/O tab (1.45.0): choosing pins for M62-M66, the state shown per port and the
// controller's notes for refused pins (the mock works them out with the controller's UserIO.plan).
//   (cd src/react-ui && npx vite build && PORT=8097 node mock/server.mjs &) ; node test/user-io.mjs
import { chromium } from "playwright";
const BASE = process.env.BASE || "http://localhost:8097";
let ok = true;
const check = (n, c, m = "") => { console.log(`${c ? "PASS" : "FAIL"} ${n} ${m}`); ok &&= !!c; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 8000) { const t = Date.now(); for (;;) { try { if (await fn()) return true; } catch {} if (Date.now() - t > ms) return false; await sleep(150); } }
const browser = await chromium.launch({ executablePath: process.env.CHROME, args: ["--no-sandbox"] });
const p = await (await browser.newContext({ viewport: { width: 1280, height: 1000 } })).newPage();
const errors = []; p.on("pageerror", (e) => errors.push(String(e)));
await p.goto(BASE + "/#io"); await p.waitForSelector("text=User outputs (M62–M65)"); await sleep(600);

const outs = p.locator(".uio-row").filter({ has: p.locator("select") });
check("four output and four input rows", (await outs.count()) === 8, String(await outs.count()));
check("unset ports say not used", (await p.locator(".uio-row .pin", { hasText: "not used" }).count()) === 8);

const sel = (i) => p.locator(".uio-row").nth(i).locator("select").first();
await sel(1).selectOption({ label: "tool-direction (pin 16)" });
await sel(2).selectOption({ label: "tool-direction (pin 16)" });
await sel(4).selectOption({ label: "pin 3 (motor 0 min)" });
await p.getByRole("button", { name: "Save changes" }).click();
check("P1 is in use after saving", await until(() => p.locator(".uio-row").nth(1).locator(".pin").filter({ hasText: "off" }).isVisible()));
check("the same pin twice: note shown", await until(() => p.getByText("pin 16 is already output P1").isVisible()));
check("P2 stays not used", await p.locator(".uio-row").nth(2).locator(".pin", { hasText: "not used" }).isVisible());
check("input P0 is in use", await until(async () => !(await p.locator(".uio-row").nth(4).locator(".pin", { hasText: "not used" }).isVisible())));
if (process.env.SHOT) await p.screenshot({ path: process.env.SHOT, fullPage: true });

await sel(2).selectOption({ label: "none" });
await p.getByRole("button", { name: "Save changes" }).click();
check("note clears once fixed", await until(async () => !(await p.getByText("already output P1").isVisible())));

await p.goto(BASE + "/#cheat-sheet"); await sleep(600);
check("cheat sheet lists M62-M65 and M66 as supported", await p.getByRole("link", { name: "M62 - M65" }).isVisible() && await p.getByRole("link", { name: "M66", exact: true }).isVisible());
check("no page errors", errors.length === 0, errors.join(" | "));
await browser.close();
console.log(ok ? "ALL PASS" : "SOME FAILED"); process.exit(ok ? 0 : 1);
