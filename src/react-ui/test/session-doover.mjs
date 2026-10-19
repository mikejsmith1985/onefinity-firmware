// Cut deeper (1.30.0) in the browser, against the mock running the real DoOver.py.
//   MOCK_FINISHED=1 MOCK_PROGRAM=test/doover-fixture.nc node mock/server.mjs        (SCENARIO=ok)
//   MOCK_FINISHED=1 MOCK_OFFSET=1 MOCK_PROGRAM=test/doover-fixture.nc ...           (SCENARIO=moved)
//   MOCK_PROGRAM=test/doover-fixture.nc ...                                         (SCENARIO=none)
import { chromium } from "playwright";
const BASE = process.env.BASE || "http://localhost:8099";
const SCENARIO = process.env.SCENARIO || "ok";
let ok = true;
const check = (n, c, m = "") => { console.log(`${c ? "PASS" : "FAIL"} ${SCENARIO}: ${n} ${m}`); ok &&= !!c; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 6000) { const t = Date.now(); for (;;) { try { if (await fn()) return true; } catch {} if (Date.now() - t > ms) return false; await sleep(150); } }
const visible = (p, t) => p.getByText(t, { exact: false }).first().isVisible().catch(() => false);
const browser = await chromium.launch({ executablePath: process.env.CHROME, args: ["--no-sandbox"] });
const screen = async () => { const c = await browser.newContext({ viewport: { width: 1280, height: 900 } }); const p = await c.newPage(); await p.goto(BASE + "/"); await p.waitForSelector(".chip"); return p; };
const A = await screen(), B = await screen();
await sleep(1000);
const jobBtn = (p) => p.locator(".job-file").getByRole("button", { name: "Cut deeper…" });

if (SCENARIO === "none") {
  check("no Cut deeper in the Job panel before the program has run", !(await jobBtn(A).isVisible().catch(() => false)));
  await A.getByRole("tab", { name: "Files" }).click();
  const fb = A.locator(".files").getByRole("button", { name: "Cut deeper…" });
  check("Files tab button disabled", await until(() => fb.isDisabled()));
} else if (SCENARIO === "ok") {
  check("Cut deeper offered after a finished run", await until(() => jobBtn(A).isVisible()));
  await A.getByRole("tab", { name: "G-code" }).click();
  await B.getByRole("tab", { name: "MDI" }).click();
  await jobBtn(A).click();
  check("dialog on A", await until(() => visible(A, "runs only the deepest passes")));
  check("dialog on B", await until(() => visible(B, "runs only the deepest passes")));
  check("operations from the program", await until(() => visible(A, "2D Contour1")) && await visible(A, "Bore1") && await visible(A, "Drill1"));
  check("zero same as the run", await until(() => visible(A, "same as when")));
  const box = (p, name) => p.locator(".dv-ops li", { hasText: name }).locator("input[type=checkbox]");
  check("pocket not chosen, contour chosen", !(await box(A, "2D Pocket1").isChecked()) && await box(A, "2D Contour1").isChecked());
  const out = (p, label) => p.getByRole("group", { name: label }).locator("output");
  const before = await out(A, "Extra depth").textContent();
  check("extra depth starts at the suggestion (0.50 mm)", before.trim() === "0.50 mm", before);
  await B.getByRole("button", { name: "Extra depth: more" }).click();
  await B.getByRole("button", { name: "Extra depth: more" }).click();
  check("+ on B shows on A", await until(async () => (await out(A, "Extra depth").textContent()).trim() === "0.70 mm"));
  check("preview shows the new floor", await until(() => visible(A, "New floor Z-3.9")));
  check("tabs choice shown (the contour has a tab)", await visible(A, "Keep (go over them)"));
  await A.getByRole("button", { name: "Write doover-fuel_filter_outline.nc" }).click();
  check("result on A", await until(() => visible(A, "Cut deeper program ready"), 10000));
  check("result on B", await until(() => visible(B, "Cut deeper program ready"), 10000));
  check("new program loaded", await until(() => A.locator(".job-file strong").textContent().then((t) => t === "doover-fuel_filter_outline.nc")));
  const text = await A.evaluate(() => fetch("/api/file/doover-fuel_filter_outline.nc").then((r) => r.text()));
  check("file has the setup sheet and the deeper passes", text.includes("(SETUP do-over:") && text.includes("Z-3.9") && !/G0 Z-3\.[0-9]/.test(text));
  await B.getByRole("button", { name: "Show in Depth view" }).click();
  check("Show in Depth view switches B to the Depth view", await until(() => B.getByRole("tab", { name: "Depth view" }).getAttribute("aria-selected").then((v) => v === "true")));
  check("A keeps its own tab", (await A.getByRole("tab", { name: "G-code" }).getAttribute("aria-selected")) === "true");
  check("closed everywhere", await until(async () => !(await visible(A, "Cut deeper program ready"))));
} else if (SCENARIO === "moved") {
  await A.getByRole("tab", { name: "Files" }).click();
  const fb = A.locator(".files").getByRole("button", { name: "Cut deeper…" });
  check("Files tab offers Cut deeper", await until(() => fb.isEnabled()));
  await fb.click();
  check("WRONG ZERO shown", await until(() => visible(A, "WRONG ZERO")));
  const write = A.getByRole("button", { name: /^Write / });
  check("Write disabled while the zero is wrong", await write.isDisabled());
  check("put back X, Y and Z needs the collet box", await A.getByRole("button", { name: "Put back X, Y and Z" }).isDisabled());
  await A.getByLabel(/hasn't been taken out of the collet/).click();
  check("collet box ticked", await until(() => A.getByLabel(/hasn't been taken out of the collet/).isChecked()));
  await A.getByRole("button", { name: "Put back X, Y and Z" }).click();
  check("zero put back, checked again", await until(() => visible(A, "same as when"), 8000));
  check("Write enabled", await until(() => write.isEnabled()));
}
await browser.close();
console.log(ok ? "ALL PASS" : "SOME FAILED"); process.exit(ok ? 0 : 1);
