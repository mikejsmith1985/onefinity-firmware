// Per-file notes, kept in this browser.
import { useEffect, useState } from "react";
const key = (f) => "next-note:" + f;
export const getNote = (f) => { try { return localStorage.getItem(key(f)) || ""; } catch { return ""; } };
export const setNote = (f, v) => { try { v ? localStorage.setItem(key(f), v) : localStorage.removeItem(key(f)); } catch {} window.dispatchEvent(new Event("next-note")); };
export function useNote(file) {
  const [v, setV] = useState(() => getNote(file));
  useEffect(() => { setV(getNote(file)); const f = () => setV(getNote(file)); window.addEventListener("next-note", f); return () => window.removeEventListener("next-note", f); }, [file]);
  return v;
}
