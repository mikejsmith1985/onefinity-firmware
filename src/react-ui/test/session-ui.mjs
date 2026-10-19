// Two screens on one controller (1.28.0 shared session), against the mock server.
//   (cd src/react-ui && npx vite build && PORT=8099 node mock/server.mjs &) ; node test/session-ui.mjs
import { chromium } from "playwright";

const BASE = process.env.BASE || "http://localhost:8099";
let ok = true;
const check = (name, cond, msg = "") => { console.log(`${cond ? "PASS" : "FAIL"} ${name} ${msg}`); ok &&= !!cond; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = (p, body) => fetch(BASE + p, body === undefined ? {} : { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());
async function until(fn, ms = 6000) { const t = Date.now(); for (;;) { try { if (await fn()) return true; } catch {} if (Date.now() - t > ms) return false; await sleep(150); } }
const visible = (page, text) => page.getByText(text, { exact: false }).first().isVisible().catch(() => false);
const mdis = async () => (await api("/api/mdis")).filter((t) => /G38\.2/.test(t) && !/_ofm_ok|_ofs_ok/.test(t));

const browser = await chromium.launch({ executablePath: process.env.CHROME || "/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell", args: ["--no-sandbox"] });
const screen = async (w, h) => { const c = await browser.newContext({ viewport: { width: w, height: h } }); const p = await c.newPage(); await p.goto(BASE + "/"); await p.waitForSelector(".chip"); return { c, p }; };
const A = await screen(1280, 800);   // PC
const B = await screen(1024, 600);   // touchscreen
await sleep(800);

// 1. Error popup: shown on both, OK on one closes both
await fetch(BASE + "/mock/error?msg=Invalid%20character%3A%20%27%2C%27");
check("error shows on screen A", await until(() => visible(A.p, "Invalid character")));
check("error shows on screen B", await until(() => visible(B.p, "Invalid character")));
await A.p.getByRole("button", { name: "OK" }).click();
check("OK on A closes the error on B", await until(async () => !(await visible(B.p, "Invalid character"))));

// 2. Probe Z opened on A shows on B; B drives it to the end; the probe is sent exactly once
const before = (await mdis()).length;
await A.p.getByRole("button", { name: "Probe Z" }).click();
check("probe dialog on A", await until(() => visible(A.p, "Probing Z")));
check("probe dialog on B", await until(() => visible(B.p, "Probing Z")));
// Check probe: touch the probe (mock), both move on
await A.p.evaluate(() => {}); // keep A alive
const ws = await B.p.evaluateHandle(() => new WebSocket(`ws://${location.host}/websocket`));
await B.p.evaluate((s) => new Promise((r) => { if (s.readyState === 1) r(); else s.onopen = r; }), ws);
await B.p.evaluate((s) => s.send("mock:touch"), ws);
check("contact moves both screens to Place probe block", await until(async () => (await visible(A.p, "Place the probe block face down")) && (await visible(B.p, "Place the probe block face down"))));
// Next pressed on both screens at the same moment: one probe only
// (a press that loses the race finds its button gone with the step: it must not land on a later step)
await Promise.all([A.p.getByRole("button", { name: "Start probing" }).click({ timeout: 4000 }).catch(() => {}), B.p.getByRole("button", { name: "Start probing" }).click({ timeout: 4000 }).catch(() => {})]);
await until(async () => (await mdis()).length > before, 3000);
await sleep(1500);
check("simultaneous Next sends the probe once", (await mdis()).length - before === 1, `sent ${(await mdis()).length - before}`);
check("both screens reach Done", await until(async () => (await visible(A.p, "put away the probe")) && (await visible(B.p, "put away the probe")), 8000));
await B.p.getByRole("button", { name: "Done" }).click();
check("Done on B closes the dialog on A", await until(async () => !(await visible(A.p, "Probing Z"))));

// 2b. A tool closed and opened again (1.28.1: the second open did nothing on the real controller)
for (let i = 0; i < 3; i++) {
  await A.p.getByRole("button", { name: "Probe Z" }).click();
  check(`probe Z opens again (${i + 1})`, await until(() => visible(B.p, "Probing Z")));
  await B.p.getByRole("button", { name: "Cancel" }).click();
  check(`cancel closes it (${i + 1})`, await until(async () => !(await visible(A.p, "Probing Z"))));
}
await A.p.getByRole("button", { name: "Probe XYZ" }).click();
check("probe XYZ opens after", await until(() => visible(B.p, "Probing XYZ") .then(async (v) => v || visible(B.p, "Probe XYZ"))));
await A.p.getByRole("button", { name: "Cancel" }).click();
await until(async () => !(await A.p.locator(".modal").isVisible().catch(() => false)));

// 3. Shared settings: jog step chosen on A shows on B
const radio = (p) => p.getByRole("radio", { name: /Large/ }).first();
await radio(A.p).click();
check("jog step follows on B", await until(async () => (await radio(B.p).getAttribute("aria-checked")) === "true"));

// 4. Driver goes away mid-probe: the other screen finishes the dialog
await A.p.getByRole("button", { name: "Probe Z" }).click();
check("second probe dialog on B", await until(() => visible(B.p, "Probing Z")));
await A.p.evaluate(() => { const s = new WebSocket(`ws://${location.host}/websocket`); s.onopen = () => s.send("mock:touch"); });
await until(() => visible(A.p, "Place the probe block face down"));
const n0 = (await mdis()).length;
await A.p.getByRole("button", { name: "Start probing" }).click(); // A sends the probe and drives the dialog
await until(async () => (await mdis()).length > n0, 3000);
await A.c.close();                                          // the PC goes away while probing
check("B takes over and reaches Done", await until(() => visible(B.p, "put away the probe"), 20000));
check("still only one probe for that run", (await mdis()).length - n0 === 1);
await B.p.getByRole("button", { name: "Done" }).click();
check("B closes it", await until(async () => !(await visible(B.p, "Probing Z"))));

// 5. A new screen opened later joins the open dialog at the same step
const C = await screen(400, 800); // phone
await B.p.getByRole("button", { name: "Measure stock" }).click();
check("measure stock on B", await until(() => visible(B.p, "Measures the top and the real edges")));
check("phone joins at the same step", await until(() => visible(C.p, "Measures the top and the real edges")));
await C.p.getByRole("button", { name: "Cancel" }).click();
check("cancel on phone closes it on B", await until(async () => !(await visible(B.p, "Measures the top and the real edges"))));

// 6. Settings edited on one screen show as unsaved on the other; Discard there ends it everywhere
await sleep(500);
await B.p.locator("button.unit").click(); // the mm/in switch edits the settings
check("unsaved edit shows Save on the other screen", await until(() => C.p.getByRole("button", { name: "Save changes" }).isVisible(), 6000));
await C.p.getByRole("button", { name: "Discard" }).click().catch(() => {});
check("discard on one clears both", await until(async () => !(await B.p.getByRole("button", { name: "Save changes" }).isVisible())));

// 7. Move a program to another folder
await B.p.goto(BASE + "/#control"); await sleep(800);
const filesTab = B.p.getByRole("tab", { name: "Files" }).first();
await filesTab.click().catch(() => {});
await sleep(500);
const box = B.p.getByLabel("Select fuel_filter_outline.nc");
if (await box.isVisible().catch(() => false)) {
  await box.check();
  await B.p.getByRole("button", { name: /Move 1 selected/ }).click();
  await B.p.locator(".modal select, [role=dialog] select").first().selectOption("Jobs");
  await B.p.getByRole("button", { name: "Move", exact: true }).click();
  const moved = await until(async () => { const s = await fetch(BASE + "/api/config/load").then((r) => r.json()); const jobs = s.gcode_list.find((f) => f.name === "Jobs"); const def = s.gcode_list.find((f) => f.name === "default"); return jobs.files.some((f) => f.file_name === "fuel_filter_outline.nc") && !def.files.some((f) => f.file_name === "fuel_filter_outline.nc"); });
  check("program moved to Jobs", moved);
} else check("files tab reachable", false, "no file checkbox found");

// 8. Run checklist on both screens; Run pressed on both starts the job once
await B.p.goto(BASE + "/#control"); await C.p.goto(BASE + "/#control"); await sleep(1500);
const s0 = await api("/api/starts");
await B.p.getByRole("button", { name: "Run", exact: true }).first().click();
check("checklist on B", await until(() => visible(B.p, "Ready to run?") .then(async (v) => v || visible(B.p, "Do not run yet"))));
check("checklist on phone", await until(async () => (await visible(C.p, "Ready to run?")) || (await visible(C.p, "Do not run yet"))));
const runBtn = (p) => p.locator(".modal, [role=dialog]").getByRole("button", { name: /^Run/ }).first();
const stopBanner = await visible(B.p, "Do not run yet");
if (stopBanner) { console.log("INFO checklist stop:", (await B.p.locator(".modal").innerText()).replace(/\n/g, " / ").slice(0, 400)); await B.p.getByLabel(/I know this is wrong/).click(); await until(async () => !(await runBtn(C.p).isDisabled())); }
await Promise.all([runBtn(B.p).click(), runBtn(C.p).click()]);
await sleep(1500);
check("job started exactly once", (await api("/api/starts")) - s0 === 1, `starts ${(await api("/api/starts")) - s0}`);
check("checklist closed on both", !(await visible(B.p, "Ready to run?")) && !(await visible(C.p, "Ready to run?")) && !(await visible(C.p, "Do not run yet")));
await fetch(BASE + "/api/stop", { method: "PUT" });

await browser.close();
console.log(ok ? "ALL PASS" : "SOME FAILED");
process.exit(ok ? 0 : 1);
