// Indicators tab layout at the touchscreen's 1280x720 (1.34.1): the legend stays inside its panel.
//   (cd src/react-ui && npx vite build && PORT=8099 node mock/server.mjs &) ; node test/indicators-layout.mjs
import { chromium } from "playwright";
const BASE = process.env.BASE || "http://localhost:8099";
let ok = true;
const check = (n, c, m = "") => { console.log(`${c ? "PASS" : "FAIL"} ${n} ${m}`); ok &&= !!c; };
const browser = await chromium.launch({ executablePath: process.env.CHROME, args: ["--no-sandbox"] });
const p = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
await p.goto(BASE + "/"); await p.waitForSelector(".chip"); await p.waitForTimeout(800);
await p.getByRole("tab", { name: "Indicators", exact: true }).first().click();
await p.waitForSelector(".indicators .legend");
const r = await p.evaluate(() => {
  const box = (e) => e.getBoundingClientRect();
  const leg = box(document.querySelector(".indicators .legend"));
  const panel = box(document.querySelector(".indicators"));
  const btns = [...document.querySelectorAll("button")].filter((b) => /Home all|Zero all/.test(b.textContent)).map(box);
  const overlap = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
  return { leg: [leg.left, leg.top, leg.right, leg.bottom], panel: [panel.left, panel.top, panel.right, panel.bottom],
    inside: leg.left >= panel.left - 1 && leg.right <= panel.right + 1 && leg.top >= panel.top - 1,
    hitsButtons: btns.some((b) => overlap(leg, b)), pos: getComputedStyle(document.querySelector(".indicators .legend")).position };
});
check("legend is in the normal flow", r.pos === "static", r.pos);
check("legend sits inside the Indicators panel", r.inside, JSON.stringify(r));
check("legend doesn't cover Home all / Zero all", !r.hitsButtons);
if (process.env.SHOT) await p.screenshot({ path: process.env.SHOT });
await browser.close();
console.log(ok ? "ALL PASS" : "SOME FAILED"); process.exit(ok ? 0 : 1);
