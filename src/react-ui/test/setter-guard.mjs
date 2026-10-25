// Tool setter guard screens (1.34.0), against the mock controller.
//   (cd src/react-ui && npx vite build && PORT=8099 node mock/server.mjs &) ; node test/setter-guard.mjs
// The mock's program cuts a rectangle X 10-140, Y 10-80 down to Z -15 (work = machine, Z top of travel 0).
import { chromium } from "playwright";
const BASE = process.env.BASE || "http://localhost:8099";
let ok = true;
const check = (n, c, m = "") => { console.log(`${c ? "PASS" : "FAIL"} ${n} ${m}`); ok &&= !!c; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 6000) { const t = Date.now(); for (;;) { try { if (await fn()) return true; } catch {} if (Date.now() - t > ms) return false; await sleep(150); } }
const getPrefs = () => fetch(BASE + "/api/next-store/prefs").then((r) => r.json());
const putPrefs = (p) => fetch(BASE + "/api/next-store/prefs", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(p) });

// A setter right on the program's front edge, no reference yet
await putPrefs({ ...(await getPrefs() || {}), setter: { x: 75, y: 10, z: -20, keep: 30 } });

const browser = await chromium.launch({ executablePath: process.env.CHROME, args: ["--no-sandbox"] });
const p = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
const errors = []; p.on("pageerror", (e) => errors.push(String(e)));
await p.goto(BASE + "/"); await p.waitForSelector(".chip"); await sleep(1200);

// 1. The Job panel warns as soon as the program is loaded
check("Job panel shows the setter clash", await until(() => p.locator(".live-warn").filter({ hasText: "TOOL SETTER" }).isVisible()));

// 2. Run: blocked, with no way to run anyway
const s0 = await fetch(BASE + "/api/starts").then((r) => r.json());
await p.getByRole("button", { name: "Run", exact: true }).first().click();
const dlg = p.locator(".modal, [role=dialog]").first();
check("checklist opens with the setter item", await until(() => p.locator(".stop-banner").filter({ hasText: "TOOL SETTER" }).isVisible()));
check("no Run anyway button", (await dlg.getByRole("button", { name: /Run anyway|^Run$/ }).count()) === 0);
check("no 'run anyway' tick box", (await p.getByLabel(/I know this is wrong/).count()) === 0);
check("says it can't be run as it is", await p.locator(".block-note").isVisible());
await p.screenshot({ path: process.env.SHOT_DIR ? `${process.env.SHOT_DIR}/guard-blocked.png` : "/dev/null" }).catch(() => {});
await dlg.getByRole("button", { name: /Cancel/ }).click();
check("nothing was started", (await fetch(BASE + "/api/starts").then((r) => r.json())) === s0);

// 3. Tool setter screen: guard section and the installed switch
await p.getByRole("button", { name: "Tool setter" }).first().click();
check("guard section shown", await until(() => p.getByText("Collision guard").isVisible()));
check("guard on without a reference, explained", await until(() => p.locator(".guard-state.on").filter({ hasText: "without a reference" }).isVisible()));
await p.screenshot({ path: process.env.SHOT_DIR ? `${process.env.SHOT_DIR}/guard-panel.png` : "/dev/null" }).catch(() => {});
await p.getByLabel("On the table").uncheck();
check("unticking saves installed: false", await until(async () => (await getPrefs()).setter.installed === false));
check("guard shows off / removed", await until(() => p.locator(".guard-state.off").filter({ hasText: "marked removed" }).isVisible()));

// 4. Settings in the details are saved
await p.getByRole("button", { name: /Show details/ }).click();
await sleep(300);
await p.screenshot({ path: process.env.SHOT_DIR ? `${process.env.SHOT_DIR}/guard-details.png` : "/dev/null", fullPage: true }).catch(() => {});
check("cutter allowance setting present", await p.getByText("Cutter allowance", { exact: false }).first().isVisible());
check("clearance and safe band settings present", await p.getByText("Height margin over its top").first().isVisible() && await p.getByText("Safe band without a reference").first().isVisible());
check("typed setter position fields present", await p.getByText("Setter center, machine X").first().isVisible());
await p.getByRole("button", { name: "Close" }).last().click();
await sleep(500);

// 5. Marked removed: the program is no longer blocked
await p.getByRole("button", { name: "Run", exact: true }).first().click();
await until(() => p.locator(".modal, [role=dialog]").first().isVisible());
check("removed: no setter block in the checklist", (await p.locator(".stop-banner").filter({ hasText: "TOOL SETTER" }).count()) === 0);
check("removed: the checklist says it wasn't checked", await p.locator(".checks li").filter({ hasText: "Marked removed" }).isVisible());
await p.locator(".modal, [role=dialog]").first().getByRole("button", { name: /Cancel/ }).click();

// 6. Setter back on, moved clear of the program: fine
const pr = await getPrefs();
await putPrefs({ ...pr, setter: { ...pr.setter, installed: true, x: 300, y: 300 } });
await sleep(800);
check("moved clear: Job panel warning gone", await until(async () => (await p.locator(".live-warn").filter({ hasText: "TOOL SETTER" }).count()) === 0));

check("no page errors", errors.length === 0, errors.join(" | "));
await browser.close();
console.log(ok ? "ALL PASS" : "SOME FAILED"); process.exit(ok ? 0 : 1);
