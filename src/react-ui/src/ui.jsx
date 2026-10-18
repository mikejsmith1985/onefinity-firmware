import React, { useEffect, useRef, useState } from "react";
import { isEnter } from "./vkbd.js";

// A number written in a plain text box. Returns null unless the text is a complete number.
export const parseNum = (s) => {
  const t = String(s ?? "").trim().replace(",", ".");
  if (!/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};

// Number entry. A text box (not type=number) because the touch screen's keyboard can't edit
// number boxes, and it keeps exactly what was typed ("", "-", "1.") so nothing snaps back while
// typing. onChange gets a number each time the text is a complete number inside min..max.
// Leaving the box puts back the last good value, clamped to min..max.
export function NumInput({ value, onChange, onEnter, digits, min, max, int, ...rest }) {
  const fmt = (v) => {
    if (v === undefined || v === null || v === "" || !Number.isFinite(Number(v))) return "";
    const n = Number(v);
    return String(digits !== undefined ? Number(n.toFixed(digits)) : n);
  };
  const [draft, setDraft] = useState(() => fmt(value));
  const same = (a, b) => a !== null && b !== "" && b !== null && b !== undefined && Math.abs(a - Number(b)) <= 1e-9 * Math.max(1, Math.abs(Number(b)));
  // Follow changes made elsewhere (a probe result, a reset), but not our own edits.
  useEffect(() => { if (!same(parseNum(draft), fmt(value))) setDraft(fmt(value)); }, [value]); // eslint-disable-line
  const inRange = (n) => (min === undefined || n >= min) && (max === undefined || n <= max);
  return (
    <input type="text" inputMode={int ? "numeric" : "decimal"} autoComplete="off" spellCheck="false" {...rest} value={draft}
      onChange={(e) => {
        const s = e.target.value; setDraft(s);
        let n = parseNum(s);
        if (n !== null && int) n = Math.round(n);
        if (n !== null && inRange(n)) onChange(n);
      }}
      onBlur={(e) => {
        let n = parseNum(draft);
        if (n === null) setDraft(fmt(value));
        else {
          if (int) n = Math.round(n);
          const c = Math.min(max ?? Infinity, Math.max(min ?? -Infinity, n));
          if (c !== n || !same(c, fmt(value))) onChange(c);
          if (c !== n) setDraft(fmt(c));
        }
        rest.onBlur && rest.onBlur(e);
      }}
      onKeyUp={(e) => { if (onEnter && isEnter(e)) onEnter(e.currentTarget.value); rest.onKeyUp && rest.onKeyUp(e); }} />
  );
}

// A text box whose value is shared with every screen. Typing stays local and smooth; the text is sent
// a moment after each keystroke, and a change made on another screen shows here unless this box has focus.
export function SharedText({ value, onChange, delay = 250, ...rest }) {
  const [draft, setDraft] = useState(value ?? "");
  const ref = useRef(null), timer = useRef(null), sent = useRef(value ?? "");
  useEffect(() => {
    if (document.activeElement !== ref.current && (value ?? "") !== draft) setDraft(value ?? "");
  }, [value]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => clearTimeout(timer.current), []);
  const flush = (s) => { clearTimeout(timer.current); if (s !== sent.current) { sent.current = s; onChange(s); } };
  return <input type="text" autoComplete="off" spellCheck="false" {...rest} ref={ref} value={draft}
    onChange={(e) => { const s = e.target.value; setDraft(s); clearTimeout(timer.current); timer.current = setTimeout(() => flush(s), delay); }}
    onBlur={(e) => { flush(draft); rest.onBlur && rest.onBlur(e); }} />;
}

export function Modal({ title, children, actions, onClose, wide, dismissable = true }) {
  const ref = useRef(null);
  // Callers pass a new onClose on every render. Keep it in a ref so the focus
  // effect runs once, when the dialog opens. Re-running it on each keystroke
  // moved focus around and made the on-screen keyboard open and close.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const prev = document.activeElement;
    ref.current?.querySelector("[data-autofocus]")?.focus({ preventScroll: true });
    return () => { prev && prev.focus && prev.focus(); };
  }, []);
  useEffect(() => {
    const key = (e) => { if (e.key === "Escape" && dismissable && closeRef.current) closeRef.current(); };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [dismissable]);
  return (
    <div className="scrim" onMouseDown={(e) => { if (e.target === e.currentTarget && dismissable && onClose) onClose(); }}>
      <div className={`modal${wide ? " wide" : ""}`} role="dialog" aria-modal="true" aria-label={title} ref={ref}>
        <h2>{title}</h2>
        <div className="modal-body">{children}</div>
        {actions && <div className="modal-actions">{actions}</div>}
      </div>
    </div>
  );
}

export function Confirm({ title, children, confirmLabel = "Confirm", danger, onConfirm, onCancel }) {
  return (
    <Modal title={title} onClose={onCancel} actions={<>
      <button onClick={onCancel}>Cancel</button>
      <button data-autofocus className={danger ? "danger" : "primary"} onClick={onConfirm}>{confirmLabel}</button>
    </>}>{children}</Modal>
  );
}

const pretty = (k) => { const s = k.replace(/[-_]/g, " "); return s[0].toUpperCase() + s.slice(1); };
export const NAMES = {
  units: "Units", "probing-prompts": "Show safety prompts", "easy-adapter": "Easy Adapter",
  "probe-xdim": "Probe block width", "probe-ydim": "Probe block length", "probe-zdim": "Probe block height",
  "probe-fast-seek": "Fast seek speed", "probe-slow-seek": "Slow seek speed",
  "program-start": "On program start", "tool-change": "On tool change", "program-end": "On program end",
  "max-deviation": "Maximum deviation", "junction-accel": "Junction acceleration",
};

const optVal = (o) => (o !== null && typeof o === "object" ? o.value : o);
const optTitle = (o) => (o !== null && typeof o === "object" ? o.title : String(o));

// One setting, rendered from its entry in config-template.json.
export function Field({ id, name, tpl, value, onChange, metric = true, extra, disabled }) {
  const scaled = tpl.scale && !metric;
  const unit = !metric && tpl.iunit ? tpl.iunit : tpl.unit;
  const label = NAMES[name] || pretty(name);
  const help = [tpl.help, tpl.default !== undefined && tpl.type !== "text" ? `Default ${tpl.default}${tpl.unit ? " " + tpl.unit : ""}` : null].filter(Boolean).join("\n");
  const fid = `f-${id || name}`;

  let control;
  if (tpl.type === "bool") {
    control = <input id={fid} type="checkbox" className="switch" checked={!!value} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />;
  } else if (tpl.type === "enum" || (tpl.values && tpl.type !== "enum")) {
    control = (
      <select id={fid} value={String(value)} disabled={disabled}
        onChange={(e) => { const raw = e.target.value; const hit = tpl.values.find((o) => String(optVal(o)) === raw); const v = optVal(hit); onChange(tpl.type === "int" || tpl.type === "float" ? Number(v) : v); }}>
        {tpl.values.map((o) => <option key={String(optVal(o))} value={String(optVal(o))}>{optTitle(o)}</option>)}
      </select>
    );
  } else if (tpl.type === "text") {
    control = <textarea id={fid} rows={5} spellCheck="false" value={value ?? ""} disabled={disabled} onChange={(e) => onChange(e.target.value)} />;
  } else if (tpl.type === "int" || tpl.type === "float") {
    const shown = value === undefined || value === null || value === "" ? "" : scaled ? Number((value / tpl.scale).toFixed(4)) : Number(Number(value).toFixed(3));
    control = (
      <NumInput id={fid} value={shown} disabled={disabled} int={tpl.type === "int"}
        min={tpl.min !== undefined ? (scaled ? tpl.min / tpl.scale : tpl.min) : undefined}
        max={tpl.max !== undefined ? (scaled ? tpl.max / tpl.scale : tpl.max) : undefined}
        onChange={(n) => onChange(scaled ? n * tpl.scale : n)} />
    );
  } else {
    control = <input id={fid} type="text" value={value ?? ""} disabled={disabled} onChange={(e) => onChange(e.target.value)} />;
  }

  return (
    <div className={`field${tpl.type === "text" ? " wide" : ""}`}>
      <label htmlFor={fid} title={help}>{label}</label>
      <div className="ctl">{control}{unit && <span className="unit-tag">{unit}</span>}{extra && <span className="extra">{extra}</span>}</div>
      {tpl.help && <p className="hint">{tpl.help}</p>}
    </div>
  );
}

export function Page({ title, children, actions }) {
  return (
    <div className="page">
      <div className="page-head"><h1>{title}</h1>{actions && <div className="page-actions">{actions}</div>}</div>
      {children}
    </div>
  );
}

export function SubTabs({ items, value, onChange }) {
  return (
    <div className="subtabs" role="tablist">
      {items.map(([id, label]) => (
        <button key={id} role="tab" aria-selected={value === id} className={value === id ? "on" : ""} onClick={() => onChange(id)}>{label}</button>
      ))}
    </div>
  );
}

export function Group({ title, children, note }) {
  return (
    <section className="group">
      {title && <h2>{title}</h2>}
      {children}
      {note && <p className="note">{note}</p>}
    </section>
  );
}
