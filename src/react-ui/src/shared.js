// The shared screen session (1.28.0).
//
// The touchscreen, a PC and a phone are one session: a dialog opened on one is
// open on all of them, at the same step, and OK on any screen closes it
// everywhere.  The controller keeps the values (Session.py) and sends them to
// every screen in the live state as state.ui = {name: {v, rev}}.
//
// Writes are compare-and-set when it matters: a step that moves the machine is
// only taken by the screen whose write the controller accepted, so pressing
// Next on two screens at once can never send a probe twice.
//
// The screen that last pressed something in a dialog is its "driver": it runs
// the watchers (probe contact, program finished) and shows that it is alive with
// a heartbeat.  If the driver goes away (a phone that went to sleep), another
// screen takes the dialog over and carries on from the same step.
import { useEffect, useState, useRef } from "react";
import { api } from "./controller.js";

const rid = () => Math.random().toString(36).slice(2, 10);
// One id per browser tab (kept across reloads of the same tab).
export const ME = (() => {
  try { let id = sessionStorage.getItem("next-screen"); if (!id) { id = rid(); sessionStorage.setItem("next-screen", id); } return id; }
  catch { return rid(); }
})();

const put = (key, v, rev) => api.put(`ui/${key}`, rev === undefined ? { v } : { v, rev });
export const uiGet = (key) => api.get(`ui/${key}`);

// This screen sees its own writes at once; the controller's broadcast follows about 0.25 s later.
const overlay = new Map(); // key -> {v, rev, t}
const subs = new Set();
const bump = () => subs.forEach((f) => f());
const hold = (key, v, rev) => { overlay.set(key, { v, rev, t: Date.now() }); bump(); };

export function readUi(state, key) {
  const srv = state?.ui?.[key] || { v: null, rev: 0 };
  const o = overlay.get(key);
  if (o) {
    if (srv.rev >= o.rev || Date.now() - o.t > 3000) overlay.delete(key);
    else return { v: o.v, rev: o.rev };
  }
  return { v: srv.v ?? null, rev: srv.rev || 0 };
}

// Re-render when this screen writes (the live state re-renders for everyone else's writes).
export function useUiTick() {
  const [, tick] = useState(0);
  useEffect(() => { const f = () => tick((n) => n + 1); subs.add(f); return () => subs.delete(f); }, []);
}

export function useUi(state, key) { useUiTick(); return readUi(state, key); }

// Unconditional write (settings typed into a dialog: last one wins).
export async function uiSet(key, v) {
  const r = await put(key, v);
  hold(key, r.v, r.rev);
  return r;
}

// Write only if nobody changed it since rev. Resolves {ok, v, rev}.
export async function uiCas(key, v, rev) {
  const r = await put(key, v, rev);
  if (r.ok) hold(key, r.v, r.rev);
  return r;
}

// Read-modify-write, retried if another screen wrote in between. fn(current) returns the new value,
// or undefined to give up (for example the dialog was closed meanwhile). Resolves {ok, v, rev}.
export async function uiUpdate(key, fn, tries = 5) {
  let cur = await uiGet(key);
  for (let i = 0; i < tries; i++) {
    const nv = fn(cur.v);
    if (nv === undefined) return { ok: false, ...cur };
    const r = await put(key, nv, cur.rev);
    if (r.ok) { hold(key, r.v, r.rev); return r; }
    cur = r;
  }
  return { ok: false, ...cur };
}

// Merge fields into an open dialog. Does nothing if it was closed.
export const uiPatch = (key, patch) => uiUpdate(key, (d) => (d ? { ...d, ...(typeof patch === "function" ? patch(d) : patch) } : undefined));

// Open a dialog on every screen. Refused (resolves false) if one is already open.
export async function uiOpen(key, v) {
  const cur = await uiGet(key);
  if (cur.v) return false;
  const r = await uiCas(key, v, cur.rev);
  return r.ok;
}
export const uiClose = (key) => uiSet(key, null).catch(() => {});

// ---- driver of a dialog ----
// d.driver is the screen running the dialog's watchers. It writes "<key>-beat" every 2 s.
const BEAT_MS = 2000, STALE_MS = 7000;
export function useDriver(state, key, d) {
  const isDriver = !!d && d.driver === ME;
  const beat = readUi(state, `${key}-beat`).v;
  // Heartbeat while this screen drives the dialog.
  useEffect(() => {
    if (!isDriver) return undefined;
    const f = () => uiSet(`${key}-beat`, { by: ME, at: Date.now() }).catch(() => {});
    f(); const t = setInterval(f, BEAT_MS);
    return () => clearInterval(t);
  }, [isDriver, key]);
  // Take over a dialog whose driver went quiet.
  const seen = useRef({ by: null, at: 0, local: 0 });
  useEffect(() => {
    if (!d || isDriver) return undefined;
    const t = setInterval(() => {
      const s = seen.current;
      const b = beat && beat.by === d.driver ? beat.at : 0;
      if (b !== s.at || s.by !== d.driver) { seen.current = { by: d.driver, at: b, local: Date.now() }; return; }
      if (Date.now() - s.local > STALE_MS) {
        const old = d.driver;
        uiUpdate(key, (cur) => (cur && cur.driver === old ? { ...cur, driver: ME } : undefined)).catch(() => {});
        seen.current = { by: null, at: 0, local: Date.now() };
      }
    }, 1000);
    return () => clearInterval(t);
  }, [d && d.driver, isDriver, beat && beat.at, key]); // eslint-disable-line react-hooks/exhaustive-deps
  return isDriver;
}

// ---- durable per-user settings (jog step, cutter size, depth view tool, MDI history, ...) ----
// Kept in the next-store document "uiprefs" on the controller. Every screen re-reads it as soon as it changes.
let prefs = null, loading = null;
const prefSubs = new Set();
const LEGACY = {
  "jog.idx": "next-jog-idx", "jog.mode": "next-jog-mode", "jog.spd": "next-jog-spd", "probe.dia": "cutterDiameter", "probe.diaRot": "cutterDiameterRotary",
  "probe.loc": "probeLocation", "probe.centerSide": "probeCenterSide", "depth.dia": "next-dia", "depth.type": "next-type", "depth.vangle": "next-vangle",
  "dry.lift": "dryLift", "checklist.skip": "next-skip-checklist",
};
const readJson = async () => { try { const r = await fetch("/api/next-store/uiprefs", { cache: "no-cache" }); return r.ok ? (await r.json()) || {} : {}; } catch { return {}; } };
export async function loadPrefs(force) {
  if (prefs && !force) return prefs;
  if (loading && !force) return loading;
  loading = (async () => {
    const p = await readJson();
    // Bring settings this browser kept before 1.28 into the shared document once.
    let moved = false;
    try {
      for (const [k, ls] of Object.entries(LEGACY)) {
        const v = localStorage.getItem(ls);
        if (v !== null && p[k] === undefined) { p[k] = v; moved = true; }
      }
      const mdi = localStorage.getItem("next-mdi");
      if (mdi && !p["mdi.hist"]) { p["mdi.hist"] = JSON.parse(mdi); moved = true; }
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith("next-depth:")) {
          p["depth.files"] = p["depth.files"] || {};
          const f = k.slice(11);
          if (!p["depth.files"][f]) { try { p["depth.files"][f] = JSON.parse(localStorage.getItem(k)); moved = true; } catch { /* bad entry */ } }
        }
      }
    } catch { /* no local storage */ }
    prefs = p; loading = null;
    if (moved) await writePrefs();
    prefSubs.forEach((f) => f());
    return prefs;
  })();
  return loading;
}
let writing = Promise.resolve();
const writePrefs = () => (writing = writing.then(() => fetch("/api/next-store/uiprefs", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(prefs) }).catch(() => {})));
export const getPref = (k, d) => (prefs && prefs[k] !== undefined && prefs[k] !== null ? prefs[k] : d);
export async function setPref(k, v) {
  await loadPrefs();
  // Merge with what another screen may have saved meanwhile.
  const fresh = await readJson();
  prefs = { ...prefs, ...fresh, [k]: v };
  prefSubs.forEach((f) => f());
  return writePrefs();
}
export function usePref(k, d) {
  const [, tick] = useState(0);
  useEffect(() => {
    const f = () => tick((n) => n + 1);
    prefSubs.add(f); loadPrefs().then(f);
    return () => prefSubs.delete(f);
  }, []);
  return getPref(k, d);
}
if (typeof window !== "undefined") window.addEventListener("next-store:uiprefs", () => { loadPrefs(true); });
