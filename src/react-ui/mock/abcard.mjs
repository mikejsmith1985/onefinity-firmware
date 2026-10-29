// Mock of the controller's A/B SD card API (1.47.0, scripts/ab-card).
// MOCK_ABCARD=ab starts as an A/B card; otherwise the stock single card.
// PUT /mock/abcard with JSON sets the state directly (tests).
const now = () => new Date().toISOString().slice(0, 16).replace("T", " ");
const GB = 1e9;
let s;
export function resetAbCard(kind = process.env.MOCK_ABCARD || "plain") {
  s = {
    ab: kind === "ab", disk: "/dev/mmcblk0", card_size: kind === "ab" ? 31.9 * GB : 7.9 * GB,
    os: "Raspbian GNU/Linux 9 (stretch)", version: "1.47.0",
    firmware: kind === "ab" ? "May 21 2026 14:30:55" : "Mar 13 2018 18:45:24",
    job: null, targets: [{ device: "/dev/sda", size: 31.9 * GB, model: "Generic STORAGE DEVICE" }],
  };
  if (s.ab) Object.assign(s, {
    running: "a", default: "a", other: "b", trial: false,
    slots: { a: { bootable: true, label: "Copy of the original card", version: "1.47.0", os: s.os, written: "2026-11-01 09:12" },
             b: { bootable: false } },
  });
}
resetAbCard();

function job(action, steps, done) {
  s.job = { action, state: "running", progress: 0, message: "Starting", started: now() };
  let i = 0;
  const t = setInterval(() => {
    const [pct, msg] = steps[Math.min(i++, steps.length - 1)];
    if (s.job.state !== "running") return clearInterval(t);
    s.job.progress = pct; s.job.message = msg;
    if (pct >= 100) { clearInterval(t); s.job.state = "done"; s.job.finished = now(); done?.(); }
  }, Number(process.env.MOCK_ABCARD_STEP_MS || 400));
}

const fail = (res, msg) => { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ message: msg, code: 400 })); };

export function abcard(req, res, p, json) {
  if (p === "/mock/abcard" && req.method === "PUT") {
    let b = ""; req.on("data", (d) => (b += d));
    req.on("end", () => { const q = JSON.parse(b || "{}"); if (q.reset) resetAbCard(q.reset); else Object.assign(s, q); json(res, "ok"); });
    return true;
  }
  if (p === "/api/abcard" && req.method === "GET") { json(res, s); return true; }
  if (p === "/api/abcard/upload" && req.method === "PUT") {
    let n = 0; req.on("data", (d) => (n += d.length));
    req.on("end", () => {
      const other = s.other;
      job("write", [[10, "Checking the OS file"], [40, `Writing the system into slot ${other.toUpperCase()}`], [90, "Carrying over settings, Wi-Fi and calibration"], [100, `Slot ${other.toUpperCase()} is ready to try`]],
        () => { s.slots[other] = { bootable: true, label: "Uploaded OS file", version: "2.0.0", os: "Raspberry Pi OS (bookworm)", written: now(), bytes: n }; });
      json(res, "ok");
    });
    return true;
  }
  if (p === "/api/abcard" && req.method === "PUT") {
    let b = ""; req.on("data", (d) => (b += d));
    req.on("end", () => {
      const q = JSON.parse(b || "{}");
      const busy = s.job?.state === "running";
      if (["make", "copy", "fetch"].includes(q.action) && busy) { res.writeHead(409, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ message: "A card job is already running" })); }
      if (q.action === "make") {
        job("make", [[1, `Preparing the card in ${q.device}`], [4, "Formatting"], [30, "Copying the system to slot A (900 of about 3100 MB)"], [70, "Copying the system to slot A (2200 of about 3100 MB)"], [93, "Writing the boot files"], [100, "The new card is ready in the card reader. Shut down, put it in the controller's SD slot and start up."]]);
      } else if (q.action === "copy") {
        if (s.trial) return fail(res, `Slot ${s.running.toUpperCase()} is on trial. Keep it or go back first.`);
        const other = s.other;
        job("copy", [[20, `Copying this system to slot ${other.toUpperCase()} (600 of about 3100 MB)`], [80, `Copying this system to slot ${other.toUpperCase()} (2500 of about 3100 MB)`], [100, `Slot ${other.toUpperCase()} holds a copy of this system`]],
          () => { s.slots[other] = { bootable: true, label: `Copy of slot ${s.running.toUpperCase()}`, version: s.version, os: s.os, written: now() }; });
      } else if (q.action === "try") {
        if (!s.slots[s.other].bootable) return fail(res, `Slot ${s.other.toUpperCase()} has no system to try`);
        if (process.env.MOCK_ABCARD_NO_TRYBOOT) return fail(res, "The boot firmware did not accept the one-shot \"try\" flag, so nothing was changed.");
        // Simulate the restart: the mock comes back on trial
        Object.assign(s, { running: s.other, other: s.running, trial: true });
      } else if (q.action === "keep") {
        if (!s.trial) return fail(res, "No slot is on trial");
        Object.assign(s, { default: s.running, trial: false });
      } else if (q.action === "switch") {
        Object.assign(s, { default: q.slot, running: q.slot, other: q.slot === "a" ? "b" : "a", trial: false });
      } else if (q.action === "dismiss") delete s.trial_ended;
      else return fail(res, "Unknown action");
      json(res, "ok");
    });
    return true;
  }
  return false;
}
