// Entry point: top bar (transport, undo/redo, status, add track, layout) and startup.

import { store, action, startPolling } from "./api.js";
import { icons, on, onPress, setPressed, toast } from "./ui.js";
import { initLayout } from "./layout.js";
import "./mixer.js";
import "./timeline.js";
import { openAddTrack } from "./sheets.js";

const $ = (id) => document.getElementById(id);

for (const el of document.querySelectorAll("[data-icon]")) el.insertAdjacentHTML("afterbegin", icons[el.dataset.icon]);

// Transport + undo/redo: REAPER action IDs (Play 1007, Pause 1008, Stop 1016, Record 1013,
// Go to start 40042, Toggle repeat 1068, Undo 40029, Redo 40030).
const ACTIONS = { tStart: 40042, tPlay: 1007, tPause: 1008, tStop: 1016, tRec: 1013, tRepeat: 1068 };
for (const [id, cmd] of Object.entries(ACTIONS)) onPress($(id), () => action(cmd));
onPress($("tUndo"), () => {
  const what = store.state?.project?.undo;
  action(40029);
  toast(what ? `Undo: ${what}` : "Undo");
});
onPress($("tRedo"), () => {
  const what = store.state?.project?.redo;
  action(40030);
  toast(what ? `Redo: ${what}` : "Redo");
});

on("native", () => {
  const t = store.transport;
  $("pos").textContent = t.beats || "—";
  $("time").textContent = t.time && t.time !== t.beats ? t.time : "";
  setPressed($("tPlay"), t.state === 1 || t.state === 5);
  setPressed($("tPause"), t.state === 2 || t.state === 6);
  setPressed($("tRec"), t.state >= 5);
  setPressed($("tRepeat"), t.rep);
  document.body.classList.toggle("recording", t.state >= 5);
});

on("state", () => {
  const p = store.state?.project;
  $("tUndo").title = p?.undo ? `Undo: ${p.undo}` : "Nothing to undo";
  $("tRedo").title = p?.redo ? `Redo: ${p.redo}` : "Nothing to redo";
  $("tUndo").classList.toggle("dim", !!p && !p.undo);
  $("tRedo").classList.toggle("dim", !!p && !p.redo);
});

on("link", () => {
  const pill = $("status");
  const ok = store.connected && store.scriptAlive;
  pill.className = `pill ${ok ? "on" : store.connected ? "warn" : "off"}`;
  pill.querySelector(".text").textContent = !store.connected ? "REAPER offline" : store.scriptAlive ? "Connected" : "Script not running";
  $("scriptHint").hidden = !store.connected || store.scriptAlive;
  $("offlineHint").hidden = store.connected;
});
onPress($("status"), () => {
  if (!store.connected) return toast("Can't reach REAPER");
  if (!store.scriptAlive) return toast("Start ReaperController.lua in REAPER");
  toast(store.perf != null ? `Script cost: ${store.perf.toFixed(2)} ms per snapshot (~15/s while a tablet is connected)` : "Connected");
});
on("needs-script", () => toast("That needs ReaperController.lua running in REAPER (Actions → ReaperController)"));

onPress($("addTrack"), openAddTrack);

document.addEventListener("gesturestart", (e) => e.preventDefault());
initLayout();
startPolling();
