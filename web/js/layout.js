// Layout mode (like Arco): pinch to resize, saved on this device.
//   top bar   pinch            → transport / top bar size
//   timeline  pinch ↕          → timeline height
//   mixer     pinch ↔ / ↕      → strip width / number of visible FX slots
// On a computer: Ctrl+wheel = ↔, Shift+wheel = ↕ over the same areas. S / M / L set the strip width too.

import { clamp, onPress, setPressed, toast } from "./ui.js";

const $ = (id) => document.getElementById(id);
const KEY = "rc-layout";
const DEFAULTS = { top: 1, strip: 92, fx: 5, tl: 44 };
let L = { ...DEFAULTS };
try { L = { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY)) }; } catch {}

const save = () => { try { localStorage.setItem(KEY, JSON.stringify(L)); } catch {} };
export const isLayoutMode = () => document.body.classList.contains("layout-mode");

export function applyLayout() {
  const root = document.documentElement.style;
  root.setProperty("--strip-w", `${L.strip}px`);
  root.setProperty("--fx-rows", L.fx);
  root.setProperty("--tl-h", `${L.tl}px`);
  $("topbar").style.zoom = L.top;
  document.querySelectorAll("#sizes button").forEach((b) => setPressed(b, Math.abs(SIZES[b.dataset.size] - L.strip) < 1));
}

const SIZES = { s: 72, m: 92, l: 124 };

function setLayoutMode(on) {
  document.body.classList.toggle("layout-mode", on);
  setPressed($("btnLayout"), on);
}

const ratio = (a0, a1) => (Math.abs(a0) < 40 ? 1 : Math.abs(a1) / Math.abs(a0));

/** Pinch on `el` in layout mode. resize(sx, sy, base) where base is the layout when the pinch started. */
function pinchable(el, resize) {
  const pts = new Map();
  let g = null;
  const list = () => [...pts.values()];
  // Capture phase: in layout mode the controls inside don't get the touch at all.
  el.addEventListener("pointerdown", (e) => {
    if (!isLayoutMode() || e.target.closest("#layoutBanner, #btnLayout")) return;
    e.preventDefault();
    e.stopPropagation();
    try { el.setPointerCapture(e.pointerId); } catch {}
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    g = { points: list(), base: { ...L } };
  }, true);
  el.addEventListener("pointermove", (e) => {
    if (!pts.has(e.pointerId)) return;
    e.stopPropagation();
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const p = list(), s = g.points;
    if (p.length < 2 || s.length < 2) return;
    const sx = ratio(s[0].x - s[1].x, p[0].x - p[1].x);
    const sy = ratio(s[0].y - s[1].y, p[0].y - p[1].y);
    const d0 = Math.hypot(s[0].x - s[1].x, s[0].y - s[1].y), d1 = Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y);
    resize(sx, sy, g.base, d0 > 20 ? d1 / d0 : 1);
    applyLayout();
  }, true);
  const end = (e) => {
    if (!pts.delete(e.pointerId)) return;
    g = { points: list(), base: { ...L } };
    if (!pts.size) save();
  };
  el.addEventListener("pointerup", end, true);
  el.addEventListener("pointercancel", end, true);
  el.addEventListener("wheel", (e) => {
    if (!isLayoutMode() || !(e.ctrlKey || e.shiftKey)) return;
    e.preventDefault();
    const f = Math.exp(-e.deltaY * 0.0015);
    resize(e.shiftKey ? 1 : f, e.shiftKey ? f : 1, { ...L }, f);
    applyLayout();
    save();
  }, { passive: false });
}

export function initLayout() {
  pinchable($("topbar"), (sx, sy, base, dist) => { L.top = Math.round(clamp(base.top * dist, 0.8, 1.8) * 100) / 100; });
  // The timeline is too short for a vertical-only pinch (fingers can't be far enough apart inside it),
  // so any pinch on it works: spread = taller, pinch in = shorter.
  pinchable($("timeline"), (sx, sy, base, dist) => { L.tl = Math.round(clamp(base.tl * dist, 24, 140)); });
  pinchable($("mixer"), (sx, sy, base) => {
    L.strip = Math.round(clamp(base.strip * sx, 60, 200));
    L.fx = Math.round(clamp(base.fx * sy, 0, 14));
  });
  onPress($("btnLayout"), () => setLayoutMode(!isLayoutMode()));
  onPress($("btnLayoutDone"), () => setLayoutMode(false));
  onPress($("btnLayoutReset"), () => { L = { ...DEFAULTS }; applyLayout(); save(); toast("Layout reset"); });
  document.querySelectorAll("#sizes button").forEach((b) => onPress(b, () => { L.strip = SIZES[b.dataset.size]; applyLayout(); save(); }));
  applyLayout();
}
