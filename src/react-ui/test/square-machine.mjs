// Square the machine (1.53.0): Probe setup → Square the machine, against the mock.
//   (cd src/react-ui && npx vite build && PORT=8097 node mock/server.mjs &) ; node test/square-machine.mjs
import { chromium } from "playwright";
const BASE = process.env.BASE || "http://localhost:8097";
let ok = true;
const check = (n, c, m = "") => { console.log(`${c ? "PASS" : "FAIL"} ${n} ${m}`); ok &&= !!c; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 8000) { const t = Date.now(); for (;;) { try { if (await fn()) return true; } catch {} if (Date.now() - t > ms) return false; await sleep(150); } }
const get = (p) => fetch(BASE + p).then((r) => r.json());
const put = (p, b) => fetch(BASE + p, { method: "PUT", body: JSON.stringify(b) });
const mdis = () => get("/api/mdis");

await put("/mock/abcard", { reset: "ab" });
const prefs0 = (await get("/api/next-store/prefs")) || {};
const before = { eps: 0.0018, deg: 0.103, drift400: 0.72, spread: 0.1, runs: 3, block: "123-3x2", time: Date.now() - 86400e3 };
await put("/api/next-store/prefs", { ...prefs0, square: before, squaring: null });

const browser = await chromium.launch({ executablePath: process.env.CHROME, args: ["--no-sandbox"] });
const p = await (await browser.newContext({ viewport: { width: 800, height: 480 } })).newPage();
const errors = []; p.on("pageerror", (e) => errors.push(String(e)));
const shot = async (n) => { if (process.env.SHOTS) await p.screenshot({ path: `${process.env.SHOTS}/sq-${n}.png` }); };
const dlg = () => p.getByRole("dialog", { name: "Square the machine" });
const btn = (name) => dlg().getByRole("button", { name, exact: true });
const openFromSetup = async () => {
  if (await until(() => dlg().isVisible(), 1500)) return true;   // the shared session still has it open
  await p.getByRole("button", { name: "Probe setup" }).click();
  const b = p.getByRole("dialog", { name: "Probe setup" }).locator("li", { has: p.locator("b", { hasText: "Square the machine" }) }).getByRole("button");
  await b.click();
  return until(() => dlg().isVisible());
};

await p.goto(BASE + "/");
await until(() => p.getByRole("button", { name: "Probe setup" }).isVisible());
await sleep(800);
if (await dlg().isVisible()) { await btn("Close (keeps your place)").click(); await sleep(300); }
check("Probe setup lists it (out of square: not done)", await (async () => {
  await p.getByRole("button", { name: "Probe setup" }).click();
  const r = await until(() => p.locator(".setup-steps li:not(.done) b", { hasText: "Square the machine" }).isVisible());
  await p.keyboard.press("Escape"); return r;
})());
check("opens from Probe setup", await openFromSetup());
check("start: last check shown, don't-home warning", await dlg().getByText(/0\.72 mm over 400 mm/).isVisible() && await dlg().getByText("Don't home while the feet are loose").isVisible());
await shot("1-start");
const m0 = (await mdis()).length;
await btn("Start").click();
check("loosen: Next needs the locked foot", await btn("Next").isDisabled());
await dlg().getByLabel("Front right stays tight").check();
await btn("Next").click();
check("spacing step", await dlg().getByText("Let the gantry set the rail spacing").isVisible());
await dlg().getByRole("button", { name: "Y+ (back)" }).click();
check("jog sends a relative Y move", await until(async () => (await mdis()).slice(m0).some((t) => /G91 G1 Y10\.0000 F1500/.test(t))));
check("no homing so far", !(await mdis()).slice(m0).some((t) => /G28|\$home/i.test(t)));
await btn("Next").click();

// Diagonals for a frame 700 wide, 1100 long, back pair 1.3 mm to the right
const W = 700, L = 1100, s = 1.3;
const fill = async (label, v) => { const f = dlg().getByLabel(label); await f.fill(String(v)); await f.blur(); };
await fill("Rail spacing, centre to centre", W);
await fill("Diagonal front-left → back-right", Math.hypot(W + s, L).toFixed(3));
await fill("Diagonal front-right → back-left", Math.hypot(W - s, L).toFixed(3));
check("diagonals: move the back pair 1.30 mm left", await until(() => dlg().getByText("Move the back pair of feet 1.30 mm to the left").isVisible()));
check("diagonals: error over 400 mm", await dlg().getByText("0.47 mm over 400 mm from the frame").isVisible());
await fill("Spacing at the front (optional)", 700); await fill("Spacing at the back (optional)", 701.5);
check("taper flagged", await until(() => dlg().getByText(/spacing differs by 1\.50 mm between front and back/).isVisible()));
await shot("2-diag");
await btn("Save this reading").click();
check("reading saved", await until(() => dlg().getByText(/Saved readings: 0\.47/).isVisible()));
await btn("Next").click();
check("feet down: Next needs the box", await btn("Next").isDisabled());
await dlg().getByLabel(/The feet are flat and tight/).check();
await btn("Next").click();
check("bolts: turn off, trial warning", await dlg().getByText("Turn the controller off.").isVisible() &&
  !(await dlg().getByText(/on trial/).isVisible()));

// The controller is turned off here: the place is kept
await put("/mock/abcard", { trial: true, running: "b", default: "a" });
await p.reload();
await until(() => p.getByRole("button", { name: "Probe setup" }).isVisible());
check("comes back where it was", await openFromSetup() && await dlg().getByText("Loosen the gantry bolts").isVisible());
check("trial warning when restarting would change slot", await until(() => dlg().getByText(/running slot B on trial/).isVisible()));
await btn("Next").click();
const m1 = (await mdis()).length;
check("seat: only 1 and 5 mm steps, Y+ off", await dlg().getByLabel("1 mm").isVisible() && await dlg().getByRole("button", { name: "Y+ (back)" }).isDisabled());
await dlg().getByLabel("1 mm").check();
await dlg().getByRole("button", { name: "Y− (front)" }).click();
check("seat jog is slow", await until(async () => (await mdis()).slice(m1).some((t) => /G91 G1 Y-1\.0000 F300/.test(t))));
await dlg().getByLabel("Both sides are against the front feet").check();
await btn("Next").click();
check("tighten: restart off while on trial", await dlg().getByRole("button", { name: "Restart the controller now" }).isDisabled());
await put("/mock/abcard", { trial: false, default: "b" });
await btn("Next").click();
check("home step", await dlg().getByText("Home, and watch the Y sides").isVisible());
await dlg().getByRole("button", { name: "Home all" }).click();
await dlg().getByLabel("Both Y sides stopped against their front feet").check();
await btn("Next").click();

// The check: Squareness opens, a new result is saved, the wizard comes back with it
await dlg().getByRole("button", { name: "Check squareness" }).click();
check("Squareness check opens", await until(() => p.getByRole("dialog", { name: "Check X/Y squareness" }).isVisible()));
const pr = await get("/api/next-store/prefs");
await put("/api/next-store/prefs", { ...pr, square: { ...before, drift400: 0.06, deg: 0.0086, eps: 0.00015, time: Date.now() } });
await p.getByRole("dialog", { name: "Check X/Y squareness" }).getByRole("button", { name: "Cancel" }).click();
check("back with the new result", await until(() => dlg().getByText("Now 0.06 mm over 400 mm").isVisible()) && await dlg().getByText("Before: 0.72 mm over 400 mm.").isVisible());
check("verdict square", await dlg().getByText("Square: nothing to do.").isVisible());
await shot("3-done");
await btn("Finish").click();
let fin = null; await until(async () => (fin = (await get("/api/next-store/prefs")).squaring) && fin.finished);
check("finished recorded", fin && fin.finished && Math.abs(fin.result - 0.06) < 1e-9, JSON.stringify(fin && fin.result));
await p.getByRole("button", { name: "Probe setup" }).click();
check("Probe setup shows it done", await until(() => p.locator(".setup-steps li.done", { hasText: "Square the machine" }).getByText(/Done .*0\.06 mm over 400 mm/).isVisible()));
await p.keyboard.press("Escape");
check("no page errors", errors.length === 0, errors.join(" | "));

await put("/api/next-store/prefs", prefs0);
await put("/mock/abcard", { reset: "plain" });
await browser.close();
console.log(ok ? "ALL PASS" : "SOME FAILED");
process.exit(ok ? 0 : 1);
