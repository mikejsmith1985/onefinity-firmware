// Squareness, Run 3 times (1.55.0): one press runs all 3 checks as one program and the average is
// saved by itself, shown on every screen. On Nov 2 the runs and the average lived only on the
// screen that ran them, so a phone couldn't see or save them.
//   (cd src/react-ui && npx vite build && PORT=8098 node mock/server.mjs &) ; BASE=http://localhost:8098 node test/square-run3.mjs
import { chromium } from "playwright";
const BASE = process.env.BASE || "http://localhost:8098";
let ok = true;
const check = (n, c, m = "") => { console.log(`${c ? "PASS" : "FAIL"} ${n} ${m}`); ok &&= !!c; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 15000) { const t = Date.now(); for (;;) { try { if (await fn()) return true; } catch {} if (Date.now() - t > ms) return false; await sleep(200); } }
const get = (p) => fetch(BASE + p).then((r) => r.json());
const put = (p, b) => fetch(BASE + p, { method: "PUT", body: JSON.stringify(b) });

const prefs0 = (await get("/api/next-store/prefs")) || {};
const oldSquare = { eps: 0.0018, deg: 0.1029, drift400: 0.718, spread: 0.098, runs: 3, block: "123-3x2", time: Date.now() - 3 * 86400e3 };
const measure = { ...(prefs0.measure || {}), ball: 1.923, ballTime: Date.now() - 3 * 86400e3, ballRuns: 3 };
await put("/api/next-store/prefs", { ...prefs0, square: oldSquare, measure, tune: null, setter: null });

const browser = await chromium.launch({ executablePath: process.env.CHROME, args: ["--no-sandbox"] });
const ctl = await (await browser.newContext({ viewport: { width: 1278, height: 718 } })).newPage();   // the controller's screen
const errors = []; ctl.on("pageerror", (e) => errors.push(String(e)));
const ws = (page, t) => page.evaluate((t) => new Promise((r) => { const s = new WebSocket("ws://" + location.host + "/websocket"); s.onopen = () => { s.send(t); setTimeout(() => { s.close(); r(); }, 150); }; }), t);

await ctl.goto(BASE + "/");
await until(() => ctl.getByRole("button", { name: "Probe setup" }).isVisible());
await sleep(800);
for (const t of ["Cancel", "Not now", "Later"]) { const l = ctl.locator(`.modal button:has-text("${t}")`); if (await l.count()) await l.first.click(); }
await ws(ctl, "mock:pos 200 150 -30");
await ctl.getByRole("button", { name: "Probe setup" }).click();
await ctl.locator('.setup-steps li:has-text("Check X/Y squareness") button').click();
const sqd = ctl.getByRole("dialog", { name: "Check X/Y squareness" });
check("Squareness offers Run 3 times, hands-off", await until(() => sqd.getByRole("button", { name: "Run 3 times, hands-off" }).isVisible()));
await sqd.getByRole("button", { name: "Run 3 times, hands-off" }).click();
const tun = (page) => page.getByRole("dialog", { name: "Check squareness 3 times" });
check("opens the hands-off run, squareness only", await until(() => tun(ctl).isVisible()) && await tun(ctl).getByText(/measured 3 times and the average is saved, with the stylus size already saved \(1\.923 mm\)/).isVisible());
await tun(ctl).getByRole("button", { name: "Next" }).click();
await ws(ctl, "mock:touch"); await sleep(1000);
check("position step", await until(() => tun(ctl).getByRole("button", { name: "Start: run all 3" }).isVisible()));
const m0 = (await get("/api/mdis")).length;
await tun(ctl).getByRole("button", { name: "Start: run all 3" }).click();
check("one program, squareness only (no stylus runs)", await until(async () => (await get("/api/mdis")).slice(m0).some((t) => t.includes("(Squareness x3") && !t.includes("_oft_c1"))));

// A phone opens the controller's page while it runs: it shows the same run
const phone = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
await phone.goto(BASE + "/");
check("the phone shows the same run", await until(() => tun(phone).isVisible()) && await until(() => tun(phone).getByText(/Squareness, run \d of 3/).isVisible()));
// The controller's screen goes away mid-run: the phone still saves the result
await ctl.close();
check("the phone saves the average when it finishes", await until(async () => { const p = await get("/api/next-store/prefs"); return p.square && p.square.time > oldSquare.time && p.square.runs === 3 && p.square.by === "tune"; }, 20000));
const p1 = await get("/api/next-store/prefs");
check("  the mock's skew, in mm over 400 mm", Math.abs(p1.square.drift400 - 400 * Math.tan(0.03 * Math.PI / 180)) < 0.01, p1.square.drift400);
check("  the stylus size untouched", p1.measure.ball === 1.923 && p1.measure.ballTime === measure.ballTime, JSON.stringify(p1.measure));
check("the phone shows the result and the runs", await until(() => tun(phone).getByText(/Squareness .* over 400 mm \(saved\)/).isVisible()) && await tun(phone).getByText(/Runs: .* over 400 mm\./).isVisible());
check("  and nothing about a stylus calibration", !(await tun(phone).getByText(/Stylus/).count()));
check("no page errors", errors.length === 0, errors.join(" | "));

await put("/api/next-store/prefs", prefs0);
await browser.close();
console.log(ok ? "ALL PASS" : "SOME FAILED");
process.exit(ok ? 0 : 1);
