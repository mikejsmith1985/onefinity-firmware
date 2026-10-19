// Probe completion and the Run checks (1.29.0), against the mock server started with MOCK_LINT_ERROR=1.
//   (cd src/react-ui && npx vite build && MOCK_LINT_ERROR=1 PORT=8099 node mock/server.mjs &) ; node test/session-checks.mjs
import { chromium } from "playwright";
const BASE = process.env.BASE || "http://localhost:8099";
let ok = true;
const check = (n, c, m = "") => { console.log(`${c ? "PASS" : "FAIL"} ${n} ${m}`); ok &&= !!c; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 6000) { const t = Date.now(); for (;;) { try { if (await fn()) return true; } catch {} if (Date.now() - t > ms) return false; await sleep(150); } }
const visible = (p, t) => p.getByText(t, { exact: false }).first().isVisible().catch(() => false);
const browser = await chromium.launch({ executablePath: process.env.CHROME, args: ["--no-sandbox"] });
const c = await browser.newContext({ viewport: { width: 1280, height: 800 } }); const p = await c.newPage();
await p.goto(BASE + "/"); await p.waitForSelector(".chip"); await sleep(800);
const ws = await p.evaluateHandle(() => new WebSocket(`ws://${location.host}/websocket`));
await p.evaluate((s) => new Promise((r) => { if (s.readyState === 1) r(); else s.onopen = r; }), ws);
const mock = (cmd) => p.evaluate(([s, t]) => s.send(t), [ws, cmd]);

// 1. A probe program that ends without reaching its end (Stop) is not a finished probe
const probeZ = async () => {
  await p.getByRole("button", { name: "Probe Z" }).click();
  await until(() => visible(p, "Probing Z"));
  await mock("mock:touch");
  await until(() => visible(p, "Place the probe block face down"));
  await p.getByRole("button", { name: "Start probing" }).click();
};
await mock("mock:probe-stop");
await probeZ();
check("stopped probe: shown as stopped, not done", await until(() => visible(p, "Probing stopped"), 8000));
check("stopped probe: no put-away (success) text", !(await visible(p, "put away the probe")));
await p.getByRole("button", { name: "Done" }).click();
await until(async () => !(await visible(p, "Probing Z")));
// 2. The same probe reaching its end completes
await probeZ();
check("finished probe completes", await until(() => visible(p, "put away the probe"), 8000));
await p.getByRole("button", { name: "Done" }).click();
await until(async () => !(await visible(p, "Probing Z")));

// 3. The controller's G-code check: an error is a red item, the job only starts with "run anyway"
await until(() => visible(p, "G83 (peck drill)"));
const s0 = await fetch(BASE + "/api/starts").then((r) => r.json());
await p.getByRole("button", { name: "Run", exact: true }).first().click();
check("Job panel warns as soon as the program is loaded", await visible(p, "G83 (peck drill)"));
check("checklist shows it as a red item", await until(() => p.locator(".stop-banner").filter({ hasText: "G83" }).isVisible()));
const runBtn = p.locator(".modal, [role=dialog]").getByRole("button", { name: /^Run/ }).first();
check("Run anyway disabled until ticked", await runBtn.isDisabled());
await p.getByLabel(/I know this is wrong/).click();
await until(async () => !(await runBtn.isDisabled()));
await runBtn.click();
check("ticked: started once (ack sent)", await until(async () => (await fetch(BASE + "/api/starts").then((r) => r.json())) - s0 === 1));
await fetch(BASE + "/api/stop", { method: "PUT" });
await sleep(1500);
await browser.close();
console.log(ok ? "ALL PASS" : "SOME FAILED");
process.exit(ok ? 0 : 1);
