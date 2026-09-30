// Shared helpers: icons, events, gestures, value formatting.

const svg = (paths) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;

export const icons = {
  play: svg('<path d="M7 5l12 7-12 7z" fill="currentColor"/>'),
  stop: svg('<rect x="6" y="6" width="12" height="12" rx="1.5" fill="currentColor"/>'),
  pause: svg('<path d="M8 5v14M16 5v14" stroke-width="3"/>'),
  record: svg('<circle cx="12" cy="12" r="6.5" fill="currentColor"/>'),
  start: svg('<path d="M6 5v14M19 5l-10 7 10 7z" fill="currentColor"/>'),
  repeat: svg('<path d="M17 2l4 4-4 4"/><path d="M3 11V9a3 3 0 0 1 3-3h15M7 22l-4-4 4-4"/><path d="M21 13v2a3 3 0 0 1-3 3H3"/>'),
  plus: svg('<path d="M12 5v14M5 12h14"/>'),
  close: svg('<path d="M6 6l12 12M18 6L6 18"/>'),
  more: svg('<circle cx="5" cy="12" r="1.6" fill="currentColor"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/><circle cx="19" cy="12" r="1.6" fill="currentColor"/>'),
  route: svg('<path d="M4 7h10a4 4 0 0 1 0 8H9"/><path d="M12 12l-3 3 3 3"/><path d="M20 7h-2"/>'),
  eye: svg('<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>'),
  trash: svg('<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>'),
  folder: svg('<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>'),
  size: svg('<path d="M4 6h16M4 12h10M4 18h6"/>'),
  undo: svg('<path d="M9 14L4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>'),
  redo: svg('<path d="M15 14l5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/>'),
  layout: svg('<path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3"/><rect x="8" y="8" width="8" height="8" rx="1"/>'),
};

export const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// --- tiny event bus -------------------------------------------------------------------
const listeners = {};
export const on = (evt, fn) => { (listeners[evt] ||= []).push(fn); };
export const emit = (evt, arg) => { for (const fn of listeners[evt] || []) fn(arg); };

// --- volume / pan ----------------------------------------------------------------------
export const volToDb = (v) => (v <= 1e-7 ? -Infinity : 20 * Math.log10(v));
export const dbToVol = (db) => (db === -Infinity ? 0 : 10 ** (db / 20));
// Fader travel ↔ dB, close to REAPER's feel: +12 dB at the top, 0 dB about ¾ of the way up.
export const posToDb = (p) => (p <= 0.001 ? -Infinity : 12 - (1 - p) ** 2 * 150);
export const dbToPos = (db) => (db === -Infinity ? 0 : clamp(1 - Math.sqrt(Math.max(0, 12 - db) / 150), 0, 1));
export const fmtDb = (db) => (db === -Infinity || db < -144 ? "-inf" : (db > 0 ? "+" : "") + db.toFixed(1));
export const fmtPan = (p) => (Math.abs(p) < 0.005 ? "C" : `${Math.round(Math.abs(p) * 100)}${p < 0 ? "L" : "R"}`);
// Meter height for a peak in dB: -60 … +6 dB.
export const meterPos = (db) => clamp((db + 60) / 66, 0, 1);

// --- gestures ----------------------------------------------------------------------------

/** Run `fn` as soon as a finger lands (works during multi-touch, unlike click on iPad). */
export function onPress(el, fn) {
  el.addEventListener("pointerdown", (e) => {
    if (e.button > 0) return;
    e.preventDefault();
    e.stopPropagation();
    fn(e);
  });
  el.addEventListener("click", (e) => { if (e.detail === 0) fn(e); });
}

/** Tap → `tap`, press-and-hold (500 ms) → `hold`. */
export function tapOrHold(el, tap, hold, ms = 500) {
  let timer = 0;
  let held = false;
  let start = null;
  el.addEventListener("pointerdown", (e) => {
    held = false;
    start = { x: e.clientX, y: e.clientY };
    timer = setTimeout(() => { held = true; hold(); }, ms);
  });
  el.addEventListener("pointermove", (e) => {
    if (start && Math.hypot(e.clientX - start.x, e.clientY - start.y) > 10) clearTimeout(timer); // scrolling
  });
  el.addEventListener("pointerup", (e) => {
    clearTimeout(timer);
    if (!held && start && Math.hypot(e.clientX - start.x, e.clientY - start.y) <= 10) tap();
    start = null;
  });
  el.addEventListener("pointercancel", () => { clearTimeout(timer); start = null; });
  el.addEventListener("contextmenu", (e) => e.preventDefault());
}

/** Detects a second tap within 300 ms near the first. Call on every pointerdown. */
export function doubleTapper() {
  let last = { t: 0, x: 0, y: 0 };
  return (e) => {
    const now = performance.now();
    const hit = now - last.t < 300 && Math.hypot(e.clientX - last.x, e.clientY - last.y) < 40;
    last = hit ? { t: 0, x: 0, y: 0 } : { t: now, x: e.clientX, y: e.clientY };
    return hit;
  };
}

/**
 * Relative drag along one axis. onMove(start + delta) with delta in "track lengths";
 * the value never jumps to the finger. Double-tap → onReset().
 */
export function dragValue(el, { axis = "y", get, onMove, onEnd, onReset, scale = 1 }) {
  let drag = null;
  const isDouble = doubleTapper();
  el.addEventListener("pointerdown", (e) => {
    if (drag) return;
    e.preventDefault();
    if (onReset && isDouble(e)) { onReset(); return; }
    try { el.setPointerCapture(e.pointerId); } catch {}
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY, start: get() };
    el.classList.add("active");
  });
  el.addEventListener("pointermove", (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const r = el.getBoundingClientRect();
    const d = axis === "y" ? (drag.y - e.clientY) / r.height : (e.clientX - drag.x) / r.width;
    onMove(drag.start + d * scale);
  });
  const end = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    drag = null;
    el.classList.remove("active");
    onEnd?.();
  };
  el.addEventListener("pointerup", end);
  el.addEventListener("pointercancel", end);
}

export function toast(msg) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove("show"), 1600);
}

export const setPressed = (el, on) => el.setAttribute("aria-pressed", String(!!on));
