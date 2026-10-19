// Cut deeper (1.30.0): helpers shared by the Job panel, the Files tab and the dialog.
import { useRuns } from "./history.js";

// The last run of `file` finished: the controller's saved run record (the one Cut deeper checks against)
// says it reached the end, or, when progress saving is off, this screen's run history says Finished.
export function finishedRun(cp, runs, file) {
  if (!file) return false;
  if (cp && cp.file === file) {
    if (cp.status === "running" || cp.status === "estop" || cp.status === "parked") return false;
    return !!cp.nlines && cp.line >= cp.nlines - 5;
  }
  const last = (runs || []).find((r) => r.file === file);
  return !!last && last.status === "Finished";
}

export function useFinished(cp, file) {
  const runs = useRuns();
  return finishedRun(cp, runs, file);
}

// Passes the dialog will cut, deepest last (same rule as DoOver.depths on the controller)
export function depthList(floor, extra, step) {
  const out = [];
  let d = 0;
  if (!(extra > 0) || !(step > 0) || !Number.isFinite(floor)) return out;
  while (d < extra - 1e-9 && out.length < 100) { d = Math.min(extra, d + step); out.push(+(floor - d).toFixed(4)); }
  return out;
}

export const LIMITS = { extra: [0.05, 5], step: [0.1, 5], start_above: [0.2, 3], plunge: [10, 2000] };
export const clamp = (k, v) => Math.min(LIMITS[k][1], Math.max(LIMITS[k][0], v));

// Ask this screen's workspace to show the Depth view (each screen keeps its own tab)
export const showDepthView = () => window.dispatchEvent(new CustomEvent("next-work-tab", { detail: "depth" }));
