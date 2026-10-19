// Typing on the controller's own touch screen.
//
// The touch screen types with the "Virtual Keyboard" Chrome extension. It writes each key
// straight into the box (input.value = ...) and then fires key events. React does not count a
// value written that way as an edit, so the change never reaches the component, and on the next
// screen update (several times a second while connected) React writes the component's old value
// back, wiping what was typed. The stock Onefinity UI worked around this by reading boxes on keyup.
//
// This shim fixes it for every box at once: whenever a text box's content differs from what its
// React component holds, it makes React see the difference so the component's onChange runs.
// Normal keyboards and mice are unaffected: their edits already match, so the shim does nothing.

const TEXT_TYPES = new Set(["text", "search", "password", "number", "email", "tel", "url", ""]);

const isTextBox = (el) => {
  if (!el || !el.tagName) return false;
  if (el.tagName === "TEXTAREA") return true;
  return el.tagName === "INPUT" && TEXT_TYPES.has((el.getAttribute("type") || "").toLowerCase());
};

// The props React rendered the box with (React keeps them on the node under __reactProps$<id>).
const reactProps = (el) => {
  const keys = Object.keys(el);
  for (let i = 0; i < keys.length; i++) if (keys[i].indexOf("__reactProps$") === 0) return el[keys[i]];
  return null;
};

// True when the box shows something its component doesn't know about.
const outOfSync = (el) => {
  const p = reactProps(el);
  if (!p || p.value === undefined || p.value === null) return false;
  return String(p.value) !== el.value;
};

// React only fires onChange when the box's value differs from the value it last recorded.
// A value written by script updates that record too, so clear the record to force a change.
const forget = (el) => {
  const t = el._valueTracker;
  if (t && typeof t.setValue === "function") t.setValue(el.value === "\u0000" ? "\u0001" : "\u0000");
};

const target = (e) => (isTextBox(e.target) ? e.target : isTextBox(document.activeElement) ? document.activeElement : null);

let installed = false;
export function installVirtualKeyboardFix() {
  if (installed || typeof document === "undefined") return;
  installed = true;

  // input/change events reach React after this capture listener, so React sees the change itself.
  const onInputEvent = (e) => { const el = target(e); if (el && outOfSync(el)) forget(el); };
  document.addEventListener("input", onInputEvent, true);
  document.addEventListener("change", onInputEvent, true);

  // Key events alone don't make React read the box, so send it an input event.
  const onKey = (e) => {
    const el = target(e);
    if (!el || !outOfSync(el)) return;
    forget(el);
    let ev;
    try { ev = new Event("input", { bubbles: true }); } catch (err) { ev = document.createEvent("Event"); ev.initEvent("input", true, false); }
    el.dispatchEvent(ev);
  };
  document.addEventListener("keyup", onKey, true);
  document.addEventListener("keydown", onKey, true);
}

// Enter from a real keyboard or from the on-screen one (its key events may have no `key`).
export const isEnter = (e) => e.key === "Enter" || e.keyCode === 13 || e.which === 13 || e.code === "Enter" || e.code === "NumpadEnter";
