// Small JSON documents kept on the controller (so every browser sees the same data).
export const remoteGet = (name) =>
  fetch(`/api/next-store/${name}`, { cache: "no-cache" }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
export const remotePut = (name, data) =>
  fetch(`/api/next-store/${name}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) })
    .then((r) => r.ok).catch(() => false);
export function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
