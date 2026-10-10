import { useCallback, useEffect, useState } from "react";
import { remoteGet, remotePut } from "./store.js";

const get = () => fetch("/api/next-store/checkpoint", { cache: "no-cache" }).then((r) => (r.ok ? r.json() : null)).catch(() => null);

// An interrupted job is one the controller saved progress for and that did not finish.
export function isInterrupted(cp) {
  if (!cp || !cp.file) return false;
  if (cp.status === "running" || cp.status === "estop" || cp.status === "parked") return true;
  if (cp.status === "stopped") return cp.nlines ? cp.line < cp.nlines - 5 : false;
  return false;
}

export function useCheckpoint(state) {
  const [cp, setCp] = useState(null);
  const refresh = useCallback(() => get().then(setCp), []);
  useEffect(() => { refresh(); }, [refresh, state.xx, state.cycle]);
  useEffect(() => { const f = () => { if (!document.hidden) refresh(); }; document.addEventListener("visibilitychange", f); return () => document.removeEventListener("visibilitychange", f); }, [refresh]);
  const dismiss = useCallback(async () => { await remotePut("checkpoint", { action: "dismiss" }); refresh(); }, [refresh]);
  return { cp, refresh, dismiss };
}

export const getPrefs = () => remoteGet("prefs").then((p) => ({ progress: true, ...(p || {}) }));
export const setPrefs = (p) => remotePut("prefs", p);
