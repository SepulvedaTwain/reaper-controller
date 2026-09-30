// Entry point: top bar (transport, status, add track, strip size) and startup.

import { store, lua, action, startPolling } from "./api.js";
import { icons, on, onPress, setPressed, toast } from "./ui.js";
import "./mixer.js";
import "./sheets.js";

const $ = (id) => document.getElementById(id);

for (const el of document.querySelectorAll("[data-icon]")) el.insertAdjacentHTML("afterbegin", icons[el.dataset.icon]);

// Transport: REAPER action IDs (Transport: Play / Pause / Stop / Record, go to start, toggle repeat).
const TRANSPORT = { tStart: 40042, tPlay: 1007, tPause: 1008, tStop: 1016, tRec: 1013, tRepeat: 1068 };
for (const [id, cmd] of Object.entries(TRANSPORT)) onPress($(id), () => action(cmd));

on("native", () => {
  const t = store.transport;
  $("pos").textContent = t.beats || "—";
  $("time").textContent = t.time && t.time !== t.beats ? t.time : "";
  const playing = t.state === 1 || t.state === 5;
  setPressed($("tPlay"), playing);
  setPressed($("tPause"), t.state === 2 || t.state === 6);
  setPressed($("tRec"), t.state >= 5);
  setPressed($("tRepeat"), t.rep);
  document.body.classList.toggle("recording", t.state >= 5);
});

on("link", () => {
  const pill = $("status");
  const ok = store.connected && store.scriptAlive;
  pill.className = `pill ${ok ? "on" : store.connected ? "warn" : "off"}`;
  pill.querySelector(".text").textContent = !store.connected ? "REAPER offline" : store.scriptAlive ? "Connected" : "Script not running";
  $("scriptHint").hidden = !store.connected || store.scriptAlive;
  $("offlineHint").hidden = store.connected;
});

// Add track (at the end, or after the selected track).
onPress($("addTrack"), () => {
  const name = prompt("Name for the new track (optional):", "");
  if (name === null) return;
  const selected = store.state?.tracks.find((t) => store.native[t.n] && store.native[t.n].flags & 2);
  lua({ cmd: "track_add", after: selected?.id, name });
  toast(selected ? `Track added after ${selected.n}` : "Track added");
});

// Strip size S / M / L, remembered on this device.
const SIZES = { s: 72, m: 92, l: 124 };
function applySize(size) {
  document.documentElement.style.setProperty("--strip-w", `${SIZES[size]}px`);
  document.querySelectorAll("#sizes button").forEach((b) => setPressed(b, b.dataset.size === size));
  try { localStorage.setItem("rc-size", size); } catch {}
}
document.querySelectorAll("#sizes button").forEach((b) => onPress(b, () => applySize(b.dataset.size)));
let saved = "m";
try { saved = localStorage.getItem("rc-size") || "m"; } catch {}
applySize(SIZES[saved] ? saved : "m");

document.addEventListener("gesturestart", (e) => e.preventDefault());
startPolling();
