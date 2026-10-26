// The controller's G-code check (/api/lint, 1.29.0) as checklist items. Errors stop the run unless the
// operator ticks "run anyway"; warnings are shown; notes for the record are left out.
// A router program while the Laser (or PWM spindle) is the selected tool (1.35.1): S above the
// tool's maximum, or a setup sheet that names a router. M3 would drive the laser output and the
// router plug would stay off. Same rule as Lint.tool_mismatch() on the controller.
export function toolChecks(res, config) {
  const t = config?.tool || {};
  const sel = String(t["selected-tool"] || "").toLowerCase();
  if (!res || !["laser", "pwm"].includes(sel)) return [];
  const top = +t["max-spin"] || 0, s = +res.max_speed || 0;
  const router = !!(res.setup && "router" in res.setup);
  if (!((top && s > top) || router)) return [];
  const name = sel === "laser" ? "Laser" : "PWM spindle";
  const why = top && s > top ? `it asks for S${s}, above the ${name.toLowerCase()} maximum of ${top}` : "its setup sheet names a router";
  return [{ level: "stop", name: "Wrong tool", key: "tool",
    text: `The Tool is set to ${name}, but this looks like a router program (${why}). M3 would switch the ${sel === "laser" ? "laser" : "PWM"} output on and the router plug would stay off. Set the Tool to Router on the Tool tab.` }];
}

export function lintChecks(res) {
  if (!res || !Array.isArray(res.issues)) return [];
  return res.issues.filter((i) => i.level === "error" || i.level === "warn").map((i) => {
    const where = i.lines && i.lines.length ? `Line${i.lines.length > 1 ? "s" : ""} ${i.lines.join(", ")}${i.count > i.lines.length ? ` and ${i.count - i.lines.length} more` : ""}: ` : "";
    return { level: i.level === "error" ? "stop" : "warn", name: "G-code", key: i.key, text: where + i.msg };
  });
}
