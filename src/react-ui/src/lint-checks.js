// The controller's G-code check (/api/lint, 1.29.0) as checklist items. Errors stop the run unless the
// operator ticks "run anyway"; warnings are shown; notes for the record are left out.
export function lintChecks(res) {
  if (!res || !Array.isArray(res.issues)) return [];
  return res.issues.filter((i) => i.level === "error" || i.level === "warn").map((i) => {
    const where = i.lines && i.lines.length ? `Line${i.lines.length > 1 ? "s" : ""} ${i.lines.join(", ")}${i.count > i.lines.length ? ` and ${i.count - i.lines.length} more` : ""}: ` : "";
    return { level: i.level === "error" ? "stop" : "warn", name: "G-code", key: i.key, text: where + i.msg };
  });
}
