// Talks to REAPER's built-in web interface (the page is served by it, so requests go to "/_/…").
//
// Native REAPER web API (instant): TRANSPORT, TRACK (volume, pan, flags, meters), SET/TRACK/…, action IDs.
// ReaperController.lua via ExtState: FX, inputs, record modes, routing, adding/removing tracks.
//   state  JSON snapshot · ver bumped on change · alive heartbeat
//   in     {"s": seq, "c": [commands]} → the script runs them and sets ack = seq

import { emit } from "./ui.js";

const SECTION = "ReaperController";
const POLL_MS = 50;

export const store = {
  connected: false, // REAPER's web server answers
  scriptAlive: false, // ReaperController.lua is running
  state: null, // from the script: { devices, master, tracks: [...] }
  native: [], // index 0 = master, 1… = tracks: { name, flags, vol, pan, peak, sends, recvs, hw }
  transport: { state: 0, pos: 0, rep: false, beats: "", time: "" },
};

// --- outgoing ------------------------------------------------------------------------------

const nativeQueue = new Map(); // key → command, newest wins (fader moves)
let luaQueue = []; // commands in order; continuous ones are replaced in place
let inflight = null; // { seq, text, sentAt }
let seq = Date.now();

/** Queue a native REAPER web command, e.g. native(`vol:3`, "SET/TRACK/3/VOL/0.5"). */
export function native(key, command) {
  nativeQueue.set(key, command);
}

/** Queue a command for ReaperController.lua. `coalesce` replaces an unsent command with the same key. */
export function lua(command, coalesce) {
  if (coalesce) {
    const i = luaQueue.findIndex((c) => c.__key === coalesce);
    if (i >= 0) { luaQueue[i] = { ...command, __key: coalesce }; return; }
    luaQueue.push({ ...command, __key: coalesce });
    return;
  }
  luaQueue.push(command);
}

export const action = (id) => native(`action:${id}:${Math.random()}`, String(id));

// --- polling ------------------------------------------------------------------------------

let lastVer = null;
let lastAlive = null;
let aliveChangedAt = 0;
let wantState = true;

function unescapeExt(v) {
  return v.replace(/\\(.)/g, (_, c) => (c === "t" ? "\t" : c === "n" ? "\n" : c === "r" ? "\r" : c));
}

function parse(text) {
  const native = [];
  const ext = {};
  for (const line of text.split("\n")) {
    if (!line) continue;
    const f = line.split("\t");
    if (f[0] === "TRANSPORT") {
      store.transport = { state: +f[1], pos: +f[2], rep: f[3] === "1", time: f[4], beats: f[5] };
    } else if (f[0] === "TRACK") {
      native[+f[1]] = {
        name: f[2], flags: +f[3], vol: +f[4], pan: +f[5], peak: +f[6] / 10,
        sends: +f[10], recvs: +f[11], hw: +f[12],
      };
    } else if (f[0] === "EXTSTATE" && f[1] === SECTION) {
      ext[f[2]] = unescapeExt(f.slice(3).join("\t"));
    }
  }
  return { native, ext };
}

function outgoingParts() {
  const parts = [...nativeQueue.values()];
  nativeQueue.clear();
  const now = performance.now();
  if (!inflight && luaQueue.length) {
    seq += 1;
    const c = luaQueue.map(({ __key, ...cmd }) => cmd);
    luaQueue = [];
    inflight = { seq, text: JSON.stringify({ s: seq, c }), sentAt: 0 };
  }
  // (Re)send the batch in flight until the script acknowledges it.
  if (inflight && now - inflight.sentAt > 1500) {
    parts.push(`SET/EXTSTATE/${SECTION}/in/${encodeURIComponent(inflight.text)}`);
    inflight.sentAt = now;
  }
  return parts;
}

async function request(parts) {
  const res = await fetch("/_/" + parts.join(";"), { cache: "no-store" });
  if (!res.ok) throw new Error(res.status);
  return res.text();
}

async function pollOnce() {
  const parts = outgoingParts();
  parts.push("TRANSPORT", "TRACK", `GET/EXTSTATE/${SECTION}/ver`, `GET/EXTSTATE/${SECTION}/ack`, `GET/EXTSTATE/${SECTION}/alive`);
  if (wantState) parts.push(`GET/EXTSTATE/${SECTION}/state`);
  const { native, ext } = parse(await request(parts));

  if (!store.connected) { store.connected = true; emit("link"); }
  store.native = native;

  const now = performance.now();
  if (ext.alive !== lastAlive) { lastAlive = ext.alive; aliveChangedAt = now; }
  const alive = !!ext.alive && now - aliveChangedAt < 2500;
  if (alive !== store.scriptAlive) {
    store.scriptAlive = alive;
    if (!alive) inflight = null; // script gone: don't wait for an ack that won't come
    emit("link");
  }
  if (inflight && ext.ack === String(inflight.seq)) inflight = null;

  if (wantState && ext.state) {
    try {
      store.state = JSON.parse(ext.state);
      wantState = false;
      emit("state");
    } catch { /* half-written: try again next poll */ }
  }
  if (ext.ver && ext.ver !== lastVer) {
    lastVer = ext.ver;
    wantState = true;
  }
  if (!ext.state && !ext.ver) wantState = true;
  if (!store.scriptAlive) basicState(native);
  emit("native");
}

/** Without the script, still show a basic mixer from the native track list (faders, M/S, arm, meters). */
let basicSig = null;
function basicState(native) {
  const sig = native.map((n) => n?.name).join("\u0001");
  if (sig === basicSig && store.state?.basic) return;
  basicSig = sig;
  const empty = { name: "", fx: [], fxen: true, chain: false, input: -1, recmode: 0, mon: 1, folder: 0, sends: [], recvs: [], hw: [] };
  store.state = {
    basic: true,
    devices: { audioIn: [], audioOut: [], midiIn: [], midiOut: [] },
    master: { ...empty, id: "master", n: 0, name: "MASTER" },
    tracks: native.slice(1).map((n, i) => ({ ...empty, id: `#${i + 1}`, n: i + 1, name: n?.name ?? "" })),
  };
  wantState = true;
  emit("state");
}

export async function startPolling() {
  for (;;) {
    const t0 = performance.now();
    try {
      await pollOnce();
    } catch {
      if (store.connected) { store.connected = false; emit("link"); }
      await new Promise((r) => setTimeout(r, 1000));
    }
    const wait = POLL_MS - (performance.now() - t0);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }
}

// --- helpers for native flags ------------------------------------------------------------
export const FLAG = { folder: 1, selected: 2, hasFx: 4, mute: 8, solo: 16, soloInPlace: 32, armed: 64, monOn: 128, monAuto: 256 };
export const has = (n, bit) => !!n && (n.flags & bit) !== 0;
