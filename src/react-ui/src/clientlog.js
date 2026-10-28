// Screen diagnostics (1.37.0).
//
// Each screen reports its own script errors, and taps on the probe buttons, to
// the controller (PUT /api/client-log), where they appear in the controller log
// with the screen's address. A problem that only happens on one browser (an
// iPhone, say) can then be read from the log instead of guessed at.
//
// Taps are traced in three steps so the log shows where one gets lost: the
// finger landing (touchstart / pointerdown), the browser's click, and the
// button's own handler (traceTap, called from the handler).
const UA = (typeof navigator !== "undefined" && navigator.userAgent) || "";
let sent = 0, windowStart = Date.now();

export function report(kind, msg) {
  const now = Date.now();
  if (now - windowStart > 60000) { windowStart = now; sent = 0; }
  if (++sent > 40) return; // the controller limits too; this keeps a broken page from flooding the network
  try {
    fetch("/api/client-log", {
      method: "PUT", cache: "no-store", keepalive: true,
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ kind, msg: String(msg).slice(0, 600), ua: kind === "error" || kind === "start" ? UA : "" }),
    }).catch(() => {});
  } catch { /* nothing to report to */ }
}

const describe = (el) => {
  const b = el && el.closest ? el.closest("button") : null;
  if (!b) return null;
  return `"${(b.textContent || "").trim().slice(0, 40)}"${b.disabled ? " (disabled)" : ""}`;
};

export function installClientLog() {
  if (typeof window === "undefined" || window.__clientLog) return;
  window.__clientLog = true;
  window.addEventListener("error", (e) => {
    const where = e.filename ? ` at ${String(e.filename).split("/").pop()}:${e.lineno}:${e.colno}` : "";
    report("error", `${e.message || e.error || "script error"}${where}${e.error && e.error.stack ? ` | ${e.error.stack}` : ""}`);
  });
  window.addEventListener("unhandledrejection", (e) => {
    const r = e.reason;
    report("error", `unhandled promise: ${r && r.message ? r.message : r}${r && r.stack ? ` | ${r.stack}` : ""}`);
  });
  // Taps on the probe buttons, seen before anything else on the page can swallow them
  for (const type of ["touchstart", "pointerdown", "click"]) {
    document.addEventListener(type, (e) => {
      const t = e.target;
      if (!t || !t.closest || !t.closest(".probes")) return;
      const b = describe(t);
      // Also what is really under the finger, in case something invisible lies on top
      const p = e.touches && e.touches[0] ? e.touches[0] : e;
      const top = typeof p.clientX === "number" ? document.elementFromPoint(p.clientX, p.clientY) : null;
      const topB = top ? describe(top) : null;
      report("tap", `${type} on ${b || (t.tagName || "?").toLowerCase()}${topB && topB !== b ? `, topmost there ${topB}` : ""}`);
    }, { capture: true, passive: true });
  }
  report("start", `screen loaded ${location.pathname}${location.hash} ${window.innerWidth}x${window.innerHeight}`);
}

// Called from a button's own handler
export const traceTap = (what) => report("tap", `handler: ${what}`);
