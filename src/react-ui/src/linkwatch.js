// The link watchdog (1.31.2). The controller sends a heartbeat every 3 s. The page checks every
// WATCH_MS; QUIET_MS without any message means the link is dead even if the socket still looks open
// (a common Wi-Fi failure). A check that runs more than WATCH_LATE_MS after the one before is
// skipped: the page itself was frozen (a big program being drawn, a busy touchscreen), and messages
// that arrived meanwhile are still queued behind the timer, so the silence is not the controller's.
// Up to 1.31.1 the limit was 8 s with no late check, and a controller busy checking a large
// program for 8 s, or a frozen page, showed "Lost connection".
export const WATCH_MS = 2000, QUIET_MS = 20000, WATCH_LATE_MS = 4000;

// "skip" (not open, hidden, or the check is late), "ok" or "dead"
export function linkVerdict({ now, lastTick, lastMsg, open = true, hidden = false }) {
  if (!open || hidden || now - lastTick > WATCH_LATE_MS) return "skip";
  return now - lastMsg > QUIET_MS ? "dead" : "ok";
}
