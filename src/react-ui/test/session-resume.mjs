// Resume dialog and tool setter shared across two screens (1.28.0).  Mock with MOCK_INTERRUPTED=1.
import { chromium } from "playwright";
const BASE = process.env.BASE || "http://localhost:8099";
let ok = true;
const check = (n, c, m = "") => { console.log(`${c ? "PASS" : "FAIL"} ${n} ${m}`); ok &&= !!c; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 6000) { const t = Date.now(); for (;;) { try { if (await fn()) return true; } catch {} if (Date.now() - t > ms) return false; await sleep(150); } }
const visible = (p, t) => p.getByText(t, { exact: false }).first().isVisible().catch(() => false);
const browser = await chromium.launch({ executablePath: process.env.CHROME, args: ["--no-sandbox"] });
const screen = async () => { const c = await browser.newContext({ viewport: { width: 1280, height: 800 } }); const p = await c.newPage(); await p.goto(BASE + "/"); await p.waitForSelector(".chip"); return p; };
const A = await screen(), B = await screen();
await sleep(800);
await A.getByRole("button", { name: "Resume…" }).click();
check("resume dialog on A", await until(() => visible(A, "Spindle spin-up wait")));
check("resume dialog on B", await until(() => visible(B, "Spindle spin-up wait")));
const spin = (p) => p.getByLabel(/Spindle spin-up wait/);
await spin(B).fill("17"); await spin(B).blur();
check("spin-up typed on B shows on A", await until(async () => (await spin(A).inputValue()) === "17"));
await A.getByRole("button", { name: "Build resume program" }).click();
check("result shows on B", await until(() => visible(B, "Resume program ready"), 8000));
await B.getByRole("button", { name: "Close" }).click();
check("close on B closes A", await until(async () => !(await visible(A, "Resume program ready"))));
// Tool setter: open on A, adv toggle on B shows on A
await A.getByRole("button", { name: "Tool setter" }).click();
check("setter on B", await until(() => visible(B, "Tool setter")));
await B.getByRole("button", { name: "Close" }).click();
check("setter closed on A", await until(async () => !(await A.getByRole("heading", { name: "Tool setter" }).isVisible().catch(() => false))));
await browser.close();
console.log(ok ? "ALL PASS" : "SOME FAILED"); process.exit(ok ? 0 : 1);
