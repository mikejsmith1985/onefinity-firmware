// Built-in Wi-Fi or a USB adapter (1.46.0): Admin > Network shows which and switches with a warning.
//   (cd src/react-ui && npx vite build && PORT=8097 node mock/server.mjs &) ; node test/wifi-adapter.mjs
import { chromium } from "playwright";
const BASE = process.env.BASE || "http://localhost:8097";
let ok = true;
const check = (n, c, m = "") => { console.log(`${c ? "PASS" : "FAIL"} ${n} ${m}`); ok &&= !!c; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 8000) { const t = Date.now(); for (;;) { try { if (await fn()) return true; } catch {} if (Date.now() - t > ms) return false; await sleep(150); } }
const browser = await chromium.launch({ executablePath: process.env.CHROME, args: ["--no-sandbox"] });
const p = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
const errors = []; p.on("pageerror", (e) => errors.push(String(e)));
const puts = []; p.on("request", (r) => { if (r.method() === "PUT" && r.url().includes("/api/network")) puts.push(r.postData()); });
await p.goto(BASE + "/#admin-network");
const row = () => p.locator(".stat", { hasText: "Wi-Fi adapter" }).locator("dd");
check("shows the built-in adapter", await until(async () => (await row().innerText()).startsWith("Built-in")));
await p.getByRole("button", { name: "Use a USB adapter" }).click();
check("warns that Wi-Fi is lost if the adapter fails", await until(() => p.getByText("has no Wi-Fi until you switch back").isVisible()));
await p.getByRole("button", { name: "Cancel" }).click();
check("cancel sends nothing", puts.length === 0);
await p.getByRole("button", { name: "Use a USB adapter" }).click();
await p.getByRole("button", { name: "Switch and reboot" }).click();
check("sends only the adapter change", await until(() => puts.length === 1) && JSON.parse(puts[0]).wifi.internal === false, puts.join());
check("says it is rebooting", await until(() => p.getByText("Turning off the built-in Wi-Fi").isVisible()));
await p.reload();
check("after the reboot: USB adapter, and the switch back is offered", await until(async () => (await row().innerText()).startsWith("USB adapter")) && await p.getByRole("button", { name: "Use the built-in Wi-Fi" }).isVisible());
check("no page errors", errors.length === 0, errors.join(" | "));
await browser.close();
console.log(ok ? "ALL PASS" : "SOME FAILED"); process.exit(ok ? 0 : 1);
