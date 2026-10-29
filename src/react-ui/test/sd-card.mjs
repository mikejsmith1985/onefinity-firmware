// A/B SD card page (1.47.0): Admin > SD card, against the mock (mock/abcard.mjs).
//   (cd src/react-ui && npx vite build && PORT=8097 node mock/server.mjs &) ; node test/sd-card.mjs
import { chromium } from "playwright";
const BASE = process.env.BASE || "http://localhost:8097";
let ok = true;
const check = (n, c, m = "") => { console.log(`${c ? "PASS" : "FAIL"} ${n} ${m}`); ok &&= !!c; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 10000) { const t = Date.now(); for (;;) { try { if (await fn()) return true; } catch {} if (Date.now() - t > ms) return false; await sleep(150); } }
const mock = (b) => fetch(BASE + "/mock/abcard", { method: "PUT", body: JSON.stringify(b) });

await mock({ reset: "plain" });
const browser = await chromium.launch({ executablePath: process.env.CHROME, args: ["--no-sandbox"] });
const p = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
const errors = []; p.on("pageerror", (e) => errors.push(String(e)));
const shot = async (n) => { if (process.env.SHOTS) await p.screenshot({ path: `${process.env.SHOTS}/${n}.png`, fullPage: true }); };

await p.goto(BASE + "/#admin-card");
check("SD card tab", await until(() => p.getByRole("button", { name: "Make the A/B card" }).isVisible()));
check("single card described", await p.getByText("Single system").isVisible() && await p.getByText("7.9 GB").isVisible());
check("the reader's card is offered", await p.locator("select option", { hasText: "Generic STORAGE DEVICE — 31.9 GB" }).count() === 1);
await shot("1-plain");
await p.getByRole("button", { name: "Make the A/B card" }).click();
check("erase warning names the card", await p.getByText(/Everything on Generic STORAGE DEVICE \(31\.9 GB, \/dev\/sda\) is erased/).isVisible());
await p.getByRole("button", { name: "Erase and make the card" }).click();
check("progress shown", await until(() => p.getByText("Making an A/B card").isVisible()));
check("then what to do with the new card", await until(() => p.getByText("Take the old card out of the SD slot").isVisible(), 15000));
await shot("2-made");

await mock({ reset: "ab" });
await p.goto(BASE + "/#admin-card"); await p.reload();
check("A/B card: both slots", await until(() => p.getByText("Slot A", { exact: true }).isVisible()) && await p.getByText("Slot B", { exact: true }).first().isVisible());
check("slot A running and starts normally", await p.locator(".abslot.on .flag", { hasText: "Running" }).isVisible() && await p.locator(".abslot.on .flag", { hasText: "Starts normally" }).isVisible());
check("slot B empty: try disabled", await p.locator(".abslot").nth(1).getByText("Empty").isVisible() && await p.getByRole("button", { name: "Try slot B" }).isDisabled());
await p.getByRole("button", { name: "Copy this system into slot B" }).click();
await p.getByRole("button", { name: "Copy", exact: true }).click();
check("copy runs, then slot B holds it", await until(() => p.locator(".abslot").nth(1).getByText("Copy of slot A").isVisible(), 15000));
check("try enabled", await until(() => p.getByRole("button", { name: "Try slot B" }).isEnabled()));
await shot("3-ab");
await p.getByRole("button", { name: "Try slot B" }).click();
check("try explains how to go back", await p.getByText("turn the controller off and on: it starts slot A again", { exact: false }).isVisible()
  || await p.getByText(/restart or turn the controller off and on: it starts slot A again/).isVisible());
await p.getByRole("button", { name: "Restart and try" }).click();
check("restarting shown", await until(() => p.getByText("Restarting into slot B").isVisible()));
await p.reload();
check("on trial: banner with keep and go back", await until(() => p.getByText("Slot B is on trial.").isVisible()) &&
  await p.getByRole("button", { name: "Keep slot B" }).isVisible() && await p.getByRole("button", { name: "Go back to slot A" }).isVisible());
check("on trial: the known-good slot can't be written", await p.getByText("Slot A is the one you know works").isVisible() &&
  await p.getByRole("button", { name: /Copy this system into/ }).count() === 0);
await shot("4-trial");
await p.getByRole("button", { name: "Keep slot B" }).click();
await p.getByRole("button", { name: "Keep", exact: true }).click();
check("kept: banner gone, B starts normally", await until(async () => !(await p.getByText("is on trial").isVisible())) &&
  await p.locator(".abslot.on .flag", { hasText: "Starts normally" }).isVisible());
check("slot A, tried before, can be started from", await p.getByRole("button", { name: "Start from slot A" }).isEnabled());

// OS file into slot A
await p.locator("input[type=file]").setInputFiles({ name: "onefinity-os-2.0.0.tar.xz", mimeType: "application/x-xz", buffer: Buffer.alloc(3 << 20, 7) });
check("load dialog names the file", await p.getByText("onefinity-os-2.0.0.tar.xz").isVisible());
await p.getByPlaceholder("64 hex digits, from the release page").fill("ab".repeat(32));
await p.getByRole("button", { name: "Load", exact: true }).click();
check("slot A gets the OS file", await until(() => p.locator(".abslot").first().getByText("Uploaded OS file").isVisible(), 15000));
check("an untried slot can't be made the normal one", await p.getByRole("button", { name: "Start from slot A" }).isDisabled() &&
  await p.getByText("hasn't been tried and kept yet").isVisible());

await mock({ trial_ended: { slot: "a", time: "2026-11-02 10:00" } });
await p.reload();
check("trial that didn't take is explained", await until(() => p.getByText(/Either slot A did not start/).isVisible()));
await shot("5-ended");
await p.getByRole("button", { name: "OK", exact: true }).click();
check("and dismissed", await until(async () => !(await p.getByText(/Either slot A did not start/).isVisible())));

await mock({ targets: [{ device: "/dev/sda", size: 15.9e9, model: "SanDisk Cruzer", mounted: ["/media/GCODE"] }] });
await p.reload();
await until(() => p.getByRole("button", { name: "Copy this system to that card" }).isVisible());
await p.getByRole("button", { name: "Copy this system to that card" }).click();
check("a mounted USB stick: warned, erase needs a tick", await p.getByText(/It may be a USB stick with your files/).isVisible() &&
  await p.getByRole("button", { name: "Erase and make the card" }).isDisabled());
await p.getByLabel("It's the new card. Erase it.").check();
check("ticked: erase allowed", await p.getByRole("button", { name: "Erase and make the card" }).isEnabled());
await p.getByRole("button", { name: "Cancel" }).click();
await mock({ targets: [] });
await p.reload();
check("no reader: says what to plug in", await until(() => p.getByText(/Plug a USB SD card reader/).isVisible()));

await p.setViewportSize({ width: 800, height: 480 });
await mock({ reset: "ab" }); await p.reload(); await sleep(800);
const wide = await p.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
check("fits the controller's 800x480 screen without sideways scrolling", !wide);
await shot("6-small");
check("no page errors", errors.length === 0, errors.join(" | "));
await browser.close();
console.log(ok ? "ALL PASS" : "SOME FAILED"); process.exit(ok ? 0 : 1);
