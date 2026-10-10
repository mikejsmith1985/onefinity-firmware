// Run history, kept in this browser. A run starts when a program starts and ends when the machine goes idle or E-stops.
import { useEffect, useRef, useState } from "react";

const KEY = "next-runs";
const subs = new Set();
let list = (() => { try { return JSON.parse(localStorage.getItem(KEY) || "[]"); } catch { return []; } })();
const save = () => { try { localStorage.setItem(KEY, JSON.stringify(list.slice(0, 200))); } catch {} subs.forEach((f) => f()); };
export const clearRuns = () => { list = []; save(); };
let stopFlag = false;
export const markStopped = () => { stopFlag = true; };

export function useRuns() {
  const [, tick] = useState(0);
  useEffect(() => { const f = () => tick((n) => n + 1); subs.add(f); return () => subs.delete(f); }, []);
  return list;
}

export function useRunTracker(state) {
  const cur = useRef(null);
  const { xx, cycle, selected } = state;
  useEffect(() => {
    const now = Date.now(), c = cur.current;
    if (!c) {
      if (xx === "RUNNING" && cycle === "running") { stopFlag = false; cur.current = { file: selected || "", at: now, hold: 0, holdAt: null, stopping: false }; }
      return;
    }
    if (xx === "HOLDING" && c.holdAt === null) c.holdAt = now;
    if (xx === "RUNNING" && c.holdAt !== null) { c.hold += now - c.holdAt; c.holdAt = null; }
    if (xx === "STOPPING") c.stopping = true;
    if (xx === "READY" || xx === "ESTOPPED") {
      if (c.holdAt !== null) c.hold += now - c.holdAt;
      const ms = now - c.at;
      const status = xx === "ESTOPPED" ? "E-stop" : (stopFlag || c.stopping) ? "Stopped" : "Finished";
      list = [{ file: c.file, at: c.at, ms, runMs: Math.max(0, ms - c.hold), status }, ...list]; save();
      cur.current = null; stopFlag = false;
    }
  }, [xx, cycle, selected]);
}
