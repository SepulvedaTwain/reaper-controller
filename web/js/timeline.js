// Timeline bar: where the play position is in the whole project, with regions and markers.
// Tap or drag to jump there (moves REAPER's edit cursor and playback).

import { store, lua } from "./api.js";
import { on, clamp, esc } from "./ui.js";

const bar = document.getElementById("tlBar");
const marksEl = document.getElementById("tlMarks");
const playedEl = document.getElementById("tlPlayed");
const headEl = document.getElementById("tlHead");
const endEl = document.getElementById("tlEnd");
const nowEl = document.getElementById("tlNow");

let scrub = null; // position (s) under the finger while dragging

const fmt = (s) => {
  s = Math.max(0, s || 0);
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
};
const length = () => Math.max(store.state?.project?.len || 0, store.transport.pos || 0, 1);

function renderMarks() {
  const p = store.state?.project;
  const len = length();
  endEl.textContent = fmt(p?.len ?? len);
  marksEl.innerHTML = (p?.marks || [])
    .map((m) => {
      const left = (m.pos / len) * 100;
      if (m.rgn) {
        const width = ((m.end - m.pos) / len) * 100;
        return `<div class="tl-region" style="left:${left}%;width:${width}%;--mc:${m.color || "#6b7280"}" title="${esc(m.name)}"><span>${esc(m.name)}</span></div>`;
      }
      return `<div class="tl-marker" style="left:${left}%;--mc:${m.color || "#e6c34a"}" title="${esc(m.name)}"><span>${esc(m.name)}</span></div>`;
    })
    .join("");
}

function renderHead() {
  const pos = scrub ?? store.transport.pos ?? 0;
  const f = clamp(pos / length(), 0, 1);
  headEl.style.left = `${f * 100}%`;
  playedEl.style.width = `${f * 100}%`;
  nowEl.textContent = fmt(pos);
}

function posAt(e) {
  const r = bar.getBoundingClientRect();
  return clamp((e.clientX - r.left) / r.width, 0, 1) * length();
}

let dragId = null;
bar.addEventListener("pointerdown", (e) => {
  if (document.body.classList.contains("layout-mode")) return;
  e.preventDefault();
  dragId = e.pointerId;
  try { bar.setPointerCapture(dragId); } catch {}
  scrub = posAt(e);
  lua({ cmd: "seek", pos: scrub }, "seek");
  renderHead();
});
bar.addEventListener("pointermove", (e) => {
  if (e.pointerId !== dragId) return;
  scrub = posAt(e);
  lua({ cmd: "seek", pos: scrub }, "seek");
  renderHead();
});
const end = (e) => {
  if (e.pointerId !== dragId) return;
  dragId = null;
  setTimeout(() => { scrub = null; }, 400); // let REAPER catch up before following it again
};
bar.addEventListener("pointerup", end);
bar.addEventListener("pointercancel", end);

on("state", () => { renderMarks(); renderHead(); });
on("native", renderHead);
