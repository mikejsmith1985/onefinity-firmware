// Link watchdog (1.31.2).  node src/react-ui/test/linkwatch.mjs
import { linkVerdict, WATCH_MS, QUIET_MS, WATCH_LATE_MS } from "../src/linkwatch.js";
let ok = true;
const check = (name, cond, msg = "") => { console.log(`${cond ? "PASS" : "FAIL"} ${name} ${msg}`); ok &&= !!cond; };

check("limit is 20 s, checked every 2 s, late after 4 s", QUIET_MS === 20000 && WATCH_MS === 2000 && WATCH_LATE_MS === 4000);
// Simulate the timer: heartbeats every hb ms until `stopAt`, the page frozen during [f0, f1)
function run({ hb = 3000, stopAt = Infinity, freeze = null, until = 60000 }) {
  let lastMsg = 0, lastTick = 0, dead = null, nextHb = hb, t = WATCH_MS;
  const frozen = (x) => freeze && x >= freeze[0] && x < freeze[1];
  while (t <= until && dead === null) {
    if (frozen(t)) { t = freeze[1]; continue; }       // the timer fires late, once, when the page thaws
    // messages that arrived while frozen are handled after this timer task, as in a browser
    const verdict = linkVerdict({ now: t, lastTick, lastMsg });
    lastTick = t;
    if (verdict === "dead") dead = t;
    while (nextHb <= t && nextHb < stopAt) { lastMsg = nextHb; nextHb += hb; }
    t += WATCH_MS;
  }
  return dead;
}
check("healthy link: never dead", run({}) === null);
const busy = (ms) => { let lastMsg = 0, lastTick = 0, dead = null; for (let t = 2000; t <= 40000; t += 2000) { const silent = t > 3000 && t < 3000 + ms; const v = linkVerdict({ now: t, lastTick, lastMsg }); lastTick = t; if (v === "dead") { dead = t; break; } if (!silent && t % 3000 < 2000) lastMsg = t; } return dead; };
check("controller busy 9 s (dropped at 8 s up to 1.31.1): not dead", busy(9000) === null);
check("server silent 15 s: not dead", busy(15000) === null);
check("server silent 30 s: dead", busy(30000) !== null);
check("link really gone: dead within 20-22 s", (() => { const d = run({ stopAt: 3001, until: 40000 }); return d !== null && d - 3000 > 20000 && d - 3000 <= 22000 + WATCH_MS; })(), run({ stopAt: 3001, until: 40000 }));
check("page frozen 30 s with the link fine: the late check is skipped, not dead", run({ freeze: [10000, 40000], until: 60000 }) === null);
check("hidden page is never judged", linkVerdict({ now: 100000, lastTick: 98000, lastMsg: 0, hidden: true }) === "skip");
check("closed socket is never judged", linkVerdict({ now: 100000, lastTick: 98000, lastMsg: 0, open: false }) === "skip");
check("on time and silent 21 s: dead", linkVerdict({ now: 21000, lastTick: 19000, lastMsg: 0 }) === "dead");
check("late (5 s since last check) and silent 21 s: skipped", linkVerdict({ now: 21000, lastTick: 16000, lastMsg: 0 }) === "skip");
console.log(ok ? "ALL PASS" : "SOME FAILED"); process.exit(ok ? 0 : 1);
