// Mixer strips: FX slots, input, record controls, fader + meter, pan, mute/solo, FX chain, routing.
// Structure (FX, inputs, routing) comes from ReaperController.lua; volume, pan, mute, solo, arm,
// monitoring and meters from REAPER's native web API, so they update instantly.

import { store, native, lua, FLAG, has } from "./api.js";
import {
  icons, esc, on, emit, clamp, onPress, tapOrHold, dragValue, setPressed,
  volToDb, dbToVol, posToDb, dbToPos, fmtDb, fmtPan, meterPos, toast,
} from "./ui.js";

const masterEl = document.getElementById("masterStrip");
const tracksEl = document.getElementById("tracks");
const strips = new Map(); // id → Strip

// Values the user is touching right now win over polled ones (no jitter while dragging).
const touching = new Map(); // `${id}:${what}` → { value, until }
const hold = (id, what, value, ms = 700) => touching.set(`${id}:${what}`, { value, until: performance.now() + ms });
const held = (id, what) => {
  const h = touching.get(`${id}:${what}`);
  return h && performance.now() < h.until ? h : null;
};

export const RECMODES = [
  [0, "input", "IN"], [7, "MIDI overdub", "OVR"], [8, "MIDI replace", "REP"], [9, "MIDI touch-replace", "T-RP"],
  [16, "MIDI latch-replace", "L-RP"], [1, "output (stereo)", "OUT"], [5, "output (mono)", "OUT"],
  [4, "output (MIDI)", "OUT"], [2, "disable (monitoring only)", "OFF"],
];
export const recmodeShort = (m) => RECMODES.find(([v]) => v === m)?.[2] ?? "IN";

export function inputLabel(v, devices, short = false) {
  if (v == null || v < 0) return "None";
  if (v & 4096) {
    const dev = (v >> 5) & 63;
    const ch = v & 31;
    const name = dev === 63 ? "All" : dev === 62 ? (short ? "VKB" : "Virtual keyboard")
      : devices?.midiIn?.find((m) => m.idx === dev)?.name ?? `Device ${dev}`;
    return short ? `MIDI ${name}:${ch || "All"}` : `MIDI: ${name}: ${ch ? `ch ${ch}` : "all channels"}`;
  }
  if (v & 2048) return short ? "Multi" : "Multichannel";
  const i = v & 1023;
  const a = devices?.audioIn?.[i] ?? `Input ${i + 1}`;
  if (v & 1024) return `${a}/${devices?.audioIn?.[i + 1] ?? `Input ${i + 2}`}`;
  return a;
}

class Strip {
  constructor(track, isMaster) {
    this.id = track.id;
    this.isMaster = isMaster;
    this.fxSig = "";
    const el = (this.el = document.createElement("div"));
    el.className = `strip${isMaster ? " master" : ""}`;
    el.innerHTML = `
      <div class="s-color"></div>
      <div class="s-fx"></div>
      ${isMaster ? "" : `
      <button class="s-input" title="Input"></button>
      <div class="s-row s-rec">
        <button class="s-btn arm" title="Record arm">${icons.record}</button>
        <button class="s-btn mon" title="Record monitoring">${icons.eye}</button>
        <button class="s-btn mode" title="Record mode"></button>
      </div>`}
      <div class="s-body">
        <div class="s-db"></div>
        <div class="s-faderwrap">
          <div class="s-fader"><div class="s-scale"></div><div class="s-thumb"></div></div>
          <div class="s-meter"><div class="m-l"></div><div class="m-r"></div></div>
        </div>
      </div>
      <div class="s-pan"><div class="s-pan-track"><div class="s-pan-fill"></div></div><span class="s-pan-label"></span></div>
      <div class="s-row">
        <button class="s-btn mute" title="Mute">M</button>
        <button class="s-btn solo" title="Solo">S</button>
      </div>
      <div class="s-row">
        <button class="s-btn fxchain" title="FX chain">FX</button>
        <button class="s-btn io" title="Routing">${icons.route}</button>
        ${isMaster ? "" : `<button class="s-btn menu" title="Track options">${icons.more}</button>`}
      </div>
      <button class="s-name"><span class="s-num"></span><span class="s-title"></span></button>`;
    this.q = (sel) => el.querySelector(sel);
    this.bind();
  }

  get index() {
    return this.isMaster ? 0 : this.track?.n ?? -1;
  }

  bind() {
    const id = () => this.id;
    // Fader: relative drag, double-tap = 0 dB.
    dragValue(this.q(".s-fader"), {
      get: () => dbToPos(volToDb(this.vol ?? 1)),
      onMove: (p) => this.setVol(dbToVol(posToDb(clamp(p, 0, 1)))),
      onReset: () => this.setVol(1),
    });
    // Pan: relative drag sideways, double-tap = centre.
    dragValue(this.q(".s-pan-track"), {
      axis: "x",
      scale: 2,
      get: () => this.pan ?? 0,
      onMove: (p) => this.setPan(clamp(p, -1, 1)),
      onReset: () => this.setPan(0),
    });
    onPress(this.q(".mute"), () => this.toggleNative("MUTE", "mute", FLAG.mute));
    onPress(this.q(".solo"), () => this.toggleNative("SOLO", "solo", FLAG.solo | FLAG.soloInPlace));
    onPress(this.q(".fxchain"), () => lua({ cmd: "fx_chain", id: id() }));
    onPress(this.q(".io"), () => emit("open-routing", this.id));
    tapOrHold(this.q(".s-name"), () => { if (!this.isMaster) lua({ cmd: "select", id: id() }); }, () => emit("open-menu", this.id));
    if (!this.isMaster) {
      onPress(this.q(".arm"), () => this.toggleNative("RECARM", "arm", FLAG.armed));
      onPress(this.q(".mon"), () => {
        const n = store.native[this.index];
        const cur = has(n, FLAG.monAuto) ? 2 : has(n, FLAG.monOn) ? 1 : 0;
        const next = (cur + 1) % 3; // off → on → auto (tape style)
        hold(this.id, "mon", next, 1500);
        lua({ cmd: "set", id: id(), key: "mon", value: next });
        this.renderNative();
      });
      onPress(this.q(".mode"), () => emit("open-record", this.id));
      onPress(this.q(".s-input"), () => emit("open-input", this.id));
      onPress(this.q(".menu"), () => emit("open-menu", this.id));
    }
  }

  setVol(v) {
    hold(this.id, "vol", v);
    this.vol = v;
    native(`vol:${this.id}`, `SET/TRACK/${this.index}/VOL/${v.toFixed(6)}`);
    this.renderNative();
  }

  setPan(p) {
    hold(this.id, "pan", p);
    this.pan = p;
    native(`pan:${this.id}`, `SET/TRACK/${this.index}/PAN/${p.toFixed(4)}`);
    this.renderNative();
  }

  toggleNative(what, key, bits) {
    const on = !((store.native[this.index]?.flags ?? 0) & bits);
    hold(this.id, key, on, 1200);
    native(`${key}:${this.id}`, `SET/TRACK/${this.index}/${what}/${on ? 1 : 0}`);
    this.renderNative();
  }

  /** Structure: name, colour, FX list, input, record mode. */
  update(track) {
    this.track = track;
    const q = this.q;
    this.el.style.setProperty("--tc", track.color || "transparent");
    this.el.classList.toggle("folder", track.folder === 1);
    this.el.classList.toggle("in-folder-end", track.folder < 0);
    q(".s-num").textContent = this.isMaster ? "" : track.n;
    q(".s-title").textContent = this.isMaster ? "MASTER" : track.name || `Track ${track.n}`;
    q(".s-title").classList.toggle("unnamed", !track.name && !this.isMaster);
    const fx = q(".fxchain");
    fx.classList.toggle("has", track.fx.length > 0);
    fx.classList.toggle("bypassed", !track.fxen);
    setPressed(fx, track.chain);

    const sig = JSON.stringify(track.fx);
    if (sig !== this.fxSig) {
      this.fxSig = sig;
      const box = q(".s-fx");
      box.innerHTML = track.fx
        .map((f, i) => `<button class="fx-slot${f.en ? "" : " off"}${f.open ? " open" : ""}${f.inst ? " inst" : ""}" data-i="${i}" title="Tap: open · Hold: bypass">${esc(f.name)}</button>`)
        .join("");
      box.querySelectorAll(".fx-slot").forEach((b) => {
        const i = Number(b.dataset.i);
        tapOrHold(b,
          () => lua({ cmd: "fx_float", id: this.id, fx: i }),
          () => {
            const f = this.track.fx[i];
            lua({ cmd: "fx_enable", id: this.id, fx: i, value: !f.en });
            toast(`${f.name}: ${f.en ? "bypassed" : "on"}`);
          });
      });
    }
    if (!this.isMaster) {
      q(".s-input").textContent = inputLabel(track.input, store.state?.devices, true);
      q(".mode").textContent = recmodeShort(track.recmode);
      q(".mode").classList.toggle("midi-rec", [7, 8, 9, 16].includes(track.recmode));
    }
    this.renderNative();
  }

  /** Fast values from REAPER's native API. */
  renderNative() {
    const n = store.native[this.index];
    if (!n) return;
    const q = this.q;
    this.vol = held(this.id, "vol")?.value ?? n.vol;
    this.pan = held(this.id, "pan")?.value ?? n.pan;
    const flag = (key, bits) => held(this.id, key)?.value ?? has(n, bits);
    const db = volToDb(this.vol);
    q(".s-thumb").style.bottom = `${dbToPos(db) * 100}%`;
    q(".s-db").textContent = fmtDb(db);
    const pan = this.pan;
    q(".s-pan-fill").style.left = `${50 + Math.min(0, pan) * 50}%`;
    q(".s-pan-fill").style.width = `${Math.abs(pan) * 50}%`;
    q(".s-pan-label").textContent = fmtPan(pan);
    setPressed(q(".mute"), flag("mute", FLAG.mute));
    setPressed(q(".solo"), flag("solo", FLAG.solo | FLAG.soloInPlace));
    this.el.classList.toggle("selected", has(n, FLAG.selected));
    if (!this.isMaster) {
      setPressed(q(".arm"), flag("arm", FLAG.armed));
      const mon = held(this.id, "mon")?.value ?? (has(n, FLAG.monAuto) ? 2 : has(n, FLAG.monOn) ? 1 : 0);
      q(".mon").dataset.mon = mon;
      q(".mon").title = ["Monitoring off", "Monitoring on", "Monitoring: tape auto style"][mon];
    }
    const routed = n.sends + n.recvs + n.hw;
    q(".io").classList.toggle("has", routed > 0);
  }

  renderMeter() {
    const n = store.native[this.index];
    if (!n) return;
    const clip = `inset(${(1 - meterPos(n.peak)) * 100}% 0 0 0)`;
    this.q(".m-l").style.clipPath = clip;
    this.q(".m-r").style.clipPath = clip;
    this.q(".s-meter").classList.toggle("clip", n.peak > 0);
  }
}

export function renderMixer() {
  const s = store.state;
  if (!s) return;
  // Master
  let m = strips.get("master");
  if (!m) {
    m = new Strip(s.master, true);
    strips.set("master", m);
    masterEl.append(m.el);
  }
  m.update(s.master);
  // Tracks: reuse strips by id, create new ones, drop deleted ones, keep REAPER's order.
  const seen = new Set();
  let prev = null;
  for (const t of s.tracks) {
    seen.add(t.id);
    let strip = strips.get(t.id);
    if (!strip) {
      strip = new Strip(t, false);
      strips.set(t.id, strip);
    }
    const want = prev ? prev.el.nextSibling : tracksEl.firstChild;
    if (want !== strip.el) tracksEl.insertBefore(strip.el, want);
    strip.update(t);
    prev = strip;
  }
  for (const [id, strip] of strips) {
    if (id !== "master" && !seen.has(id)) {
      strip.el.remove();
      strips.delete(id);
    }
  }
  document.getElementById("emptyHint").hidden = s.tracks.length > 0;
}

export function renderNativeValues() {
  for (const strip of strips.values()) {
    if (strip.track) {
      strip.renderNative();
      strip.renderMeter();
    }
  }
}

export const trackById = (id) => (id === "master" ? store.state?.master : store.state?.tracks.find((t) => t.id === id));

on("state", renderMixer);
on("native", renderNativeValues);
