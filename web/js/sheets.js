// Side panels: Input, Record (monitoring + record mode), Routing (sends / receives / hardware),
// Track options (rename, insert, delete…). They re-render live as REAPER changes.

import { store, lua } from "./api.js";
import { icons, esc, on, clamp, dragValue, volToDb, dbToVol, posToDb, dbToPos, fmtDb, fmtPan, toast } from "./ui.js";
import { RECMODES, inputLabel, trackById } from "./mixer.js";

const dlg = document.getElementById("sheet");
let current = null; // { title, render, id }
let interacting = false; // don't re-render under a finger

export function openSheet(id, title, render) {
  current = { id, title, render };
  dlg.innerHTML = `
    <div class="sheet">
      <div class="sheet-head"><h2></h2><button class="icon-btn" data-close aria-label="Close">${icons.close}</button></div>
      <div class="sheet-body"></div>
    </div>`;
  dlg.querySelector("[data-close]").onclick = close;
  draw();
  dlg.showModal();
}

function close() {
  current = null;
  dlg.close();
}

function draw() {
  if (!current) return;
  const track = current.id ? trackById(current.id) : {};
  if (!track) return close(); // deleted meanwhile
  dlg.querySelector("h2").textContent = current.title(track);
  const body = dlg.querySelector(".sheet-body");
  const scroll = body.scrollTop;
  current.render(body, track);
  body.scrollTop = scroll;
}

dlg.addEventListener("click", (e) => { if (e.target === dlg) close(); });
dlg.addEventListener("pointerdown", () => { interacting = true; });
window.addEventListener("pointerup", () => { interacting = false; });
window.addEventListener("pointercancel", () => { interacting = false; });
on("state", () => { if (current && !interacting) draw(); });

const title = (t) => (t.id === "master" ? "MASTER" : `${t.n} · ${t.name || `Track ${t.n}`}`);
const set = (t, key, value) => lua({ cmd: "set", id: t.id, key, value }, `set:${t.id}:${key}`);
const choice = (value, label, active, extra = "") =>
  `<button class="choice${active ? " on" : ""}" data-v="${value}" ${extra}>${esc(label)}</button>`;
const toggle = (key, label, hint, checked) =>
  `<label class="toggle"><input type="checkbox" data-k="${key}" ${checked ? "checked" : ""}><span>${label}${hint ? `<small>${hint}</small>` : ""}</span></label>`;

// --- Input ------------------------------------------------------------------------------------

const midiPick = new Map(); // track id → device chosen in the MIDI section

export function openInput(id) {
  openSheet(id, (t) => `Input · ${title(t)}`, (body, t) => {
    const d = store.state.devices;
    const v = t.input;
    const isMidi = v >= 0 && (v & 4096);
    const dev = midiPick.get(t.id) ?? (isMidi ? (v >> 5) & 63 : 63);
    const ch = isMidi && ((v >> 5) & 63) === dev ? v & 31 : -1;
    const midiDevices = [[63, "All MIDI inputs"], [62, "Virtual MIDI keyboard"], ...d.midiIn.map((m) => [m.idx, m.name])];
    const audio = d.audioIn;
    body.innerHTML = `
      <p class="current">Now: <b>${esc(inputLabel(v, d))}</b></p>
      <div class="group"><div class="choices">${choice(-1, "None", v < 0)}</div></div>
      <h3>MIDI</h3>
      <div class="choices" data-group="dev">${midiDevices.map(([i, n]) => choice(i, n, i === dev)).join("")}</div>
      <div class="choices channels" data-group="ch">${choice(0, "All", ch === 0)}${Array.from({ length: 16 }, (_, i) => choice(i + 1, i + 1, ch === i + 1)).join("")}</div>
      <p class="hint">Pick a device, then a channel. Arco pages use the Virtual MIDI keyboard.</p>
      <h3>Audio · mono</h3>
      <div class="choices">${audio.map((n, i) => choice(i, n, v >= 0 && !(v & 4096) && !(v & 1024) && (v & 1023) === i)).join("") || "<p class='hint'>No audio inputs</p>"}</div>
      <h3>Audio · stereo</h3>
      <div class="choices">${audio.slice(0, -1).map((n, i) => (i % 2 ? "" : choice(i | 1024, `${n}/${audio[i + 1]}`, v >= 0 && !(v & 4096) && (v & 1024) && (v & 1023) === i))).join("")}</div>`;

    body.querySelector('.group [data-v="-1"]').onclick = () => set(t, "input", -1);
    body.querySelectorAll('[data-group="dev"] .choice').forEach((b) => {
      b.onclick = () => {
        const newDev = Number(b.dataset.v);
        midiPick.set(t.id, newDev);
        set(t, "input", 4096 | (newDev << 5) | Math.max(0, ch)); // keep the channel when switching device
      };
    });
    body.querySelectorAll('[data-group="ch"] .choice').forEach((b) => {
      b.onclick = () => set(t, "input", 4096 | (dev << 5) | Number(b.dataset.v));
    });
    body.querySelectorAll("h3 ~ .choices:not([data-group]) .choice").forEach((b) => {
      b.onclick = () => set(t, "input", Number(b.dataset.v));
    });
  });
}

// --- Record (monitoring + mode) ----------------------------------------------------------

export function openRecord(id) {
  openSheet(id, (t) => `Record · ${title(t)}`, (body, t) => {
    body.innerHTML = `
      <h3>Monitoring</h3>
      <div class="choices" data-group="mon">
        ${choice(0, "Off", t.mon === 0)}${choice(1, "Monitor input", t.mon === 1)}${choice(2, "Tape auto style", t.mon === 2)}
      </div>
      ${toggle("monitems", "Monitor track media when recording", "", t.monitems)}
      <h3>Record</h3>
      <div class="choices column" data-group="mode">
        ${RECMODES.map(([v, label]) => choice(v, `Record: ${label}`, t.recmode === v)).join("")}
      </div>
      <p class="hint">MIDI overdub adds to existing items; replace overwrites what's under the new recording.</p>
      ${toggle("autoarm", "Automatic record-arm when track selected", "", t.autoarm)}`;
    body.querySelectorAll('[data-group="mon"] .choice').forEach((b) => { b.onclick = () => set(t, "mon", Number(b.dataset.v)); });
    body.querySelectorAll('[data-group="mode"] .choice').forEach((b) => { b.onclick = () => set(t, "recmode", Number(b.dataset.v)); });
    body.querySelectorAll("[data-k]").forEach((i) => { i.onchange = () => set(t, i.dataset.k, i.checked); });
  });
}

// --- Routing -------------------------------------------------------------------------------

function routeRow(t, r, cat, label) {
  const db = volToDb(r.vol);
  return `
    <div class="route" data-cat="${cat}" data-idx="${r.idx}">
      <div class="route-head">
        <span class="route-name">${label}</span>
        <button class="s-btn mini${r.mute ? " on" : ""}" data-act="mute" aria-pressed="${r.mute}">M</button>
        <button class="icon-btn sm" data-act="remove" aria-label="Remove">${icons.trash}</button>
      </div>
      <div class="route-ctl">
        <div class="hslider" data-act="vol"><div class="hs-fill" style="width:${dbToPos(db) * 100}%"></div><span>${fmtDb(db)} dB</span></div>
        <div class="hslider pan" data-act="pan"><div class="hs-fill" style="left:${50 + Math.min(0, r.pan) * 50}%;width:${Math.abs(r.pan) * 50}%"></div><span>${fmtPan(r.pan)}</span></div>
      </div>
    </div>`;
}

function hwName(dst, d) {
  const i = dst & 1023;
  const a = d.audioOut[i] ?? `Output ${i + 1}`;
  return dst & 1024 ? a : `${a}/${d.audioOut[i + 1] ?? `Output ${i + 2}`}`;
}

export function openRouting(id) {
  openSheet(id, (t) => `Routing · ${title(t)}`, (body, t) => {
    const d = store.state.devices;
    const others = store.state.tracks.filter((x) => x.id !== t.id);
    const options = (placeholder) => `<option value="">${placeholder}</option>` +
      others.map((x) => `<option value="${esc(x.id)}">${x.n} · ${esc(x.name || `Track ${x.n}`)}</option>`).join("");
    const isMaster = t.id === "master";
    body.innerHTML = `
      ${isMaster ? "" : `
      ${toggle("mainsend", "Master send", "Send this track to the master / parent track", t.mainsend)}
      <label class="field">Track channels
        <select data-k="nchan">${Array.from({ length: 32 }, (_, i) => (i + 1) * 2).map((n) => `<option ${n === t.nchan ? "selected" : ""}>${n}</option>`).join("")}</select>
      </label>
      <h3>Sends</h3>
      ${(t.sends || []).map((r) => routeRow(t, r, 0, `→ ${r.n} · ${esc(r.name || `Track ${r.n}`)}`)).join("") || '<p class="hint">No sends</p>'}
      <select class="add" data-add="send">${options("Add new send…")}</select>
      <h3>Receives</h3>
      ${(t.recvs || []).map((r) => routeRow(t, r, -1, `← ${r.n} · ${esc(r.name || `Track ${r.n}`)}`)).join("") || '<p class="hint">No receives</p>'}
      <select class="add" data-add="recv">${options("Add new receive…")}</select>`}
      <h3>Audio hardware outputs</h3>
      ${(t.hw || []).map((r) => routeRow(t, r, 1, `⇥ ${esc(hwName(r.dst, d))}`)).join("") || '<p class="hint">No hardware outputs</p>'}
      ${isMaster ? '<p class="hint">The master\'s own outputs are set in REAPER.</p>' : `
      <select class="add" data-add="hw"><option value="">Add new hardware output…</option>
        ${d.audioOut.map((n, i) => (i % 2 ? "" : `<option value="${i}">${esc(n)}/${esc(d.audioOut[i + 1] ?? "")}</option>`)).join("")}
      </select>
      <h3>MIDI hardware output</h3>
      <select data-k="midiout">
        <option value="-1" ${t.midiout < 0 ? "selected" : ""}>&lt;no output&gt;</option>
        ${d.midiOut.map((m) => `<option value="${m.idx << 5}" ${t.midiout >= 0 && t.midiout >> 5 === m.idx ? "selected" : ""}>${esc(m.name)} — original channels</option>`).join("")}
      </select>`}`;

    body.querySelectorAll("input[data-k]").forEach((i) => { i.onchange = () => set(t, i.dataset.k, i.checked); });
    body.querySelectorAll("select[data-k]").forEach((s) => { s.onchange = () => set(t, s.dataset.k, Number(s.value)); });
    body.querySelectorAll("select[data-add]").forEach((s) => {
      s.onchange = () => {
        if (!s.value) return;
        const kind = s.dataset.add;
        if (kind === "send") lua({ cmd: "send_add", id: t.id, dest: s.value });
        if (kind === "recv") lua({ cmd: "recv_add", id: t.id, src: s.value });
        if (kind === "hw") lua({ cmd: "hw_add", id: t.id, dst: Number(s.value) });
        toast("Added");
      };
    });
    body.querySelectorAll(".route").forEach((row) => {
      const cat = Number(row.dataset.cat);
      const idx = Number(row.dataset.idx);
      const list = cat === 0 ? t.sends : cat === -1 ? t.recvs : t.hw;
      const r = list.find((x) => x.idx === idx);
      const routeSet = (key, value) => lua({ cmd: "route_set", id: t.id, cat, idx, key, value }, `route:${t.id}:${cat}:${idx}:${key}`);
      row.querySelector('[data-act="mute"]').onclick = () => routeSet("mute", !r.mute);
      row.querySelector('[data-act="remove"]').onclick = () => lua({ cmd: "route_remove", id: t.id, cat, idx });
      const vol = row.querySelector('[data-act="vol"]');
      dragValue(vol, {
        axis: "x",
        get: () => dbToPos(volToDb(r.vol)),
        onMove: (p) => {
          r.vol = dbToVol(posToDb(clamp(p, 0, 1)));
          vol.querySelector(".hs-fill").style.width = `${dbToPos(volToDb(r.vol)) * 100}%`;
          vol.querySelector("span").textContent = `${fmtDb(volToDb(r.vol))} dB`;
          routeSet("vol", r.vol);
        },
        onReset: () => routeSet("vol", 1),
      });
      const pan = row.querySelector('[data-act="pan"]');
      dragValue(pan, {
        axis: "x",
        scale: 2,
        get: () => r.pan,
        onMove: (p) => {
          r.pan = clamp(p, -1, 1);
          const f = pan.querySelector(".hs-fill");
          f.style.left = `${50 + Math.min(0, r.pan) * 50}%`;
          f.style.width = `${Math.abs(r.pan) * 50}%`;
          pan.querySelector("span").textContent = fmtPan(r.pan);
          routeSet("pan", r.pan);
        },
        onReset: () => routeSet("pan", 0),
      });
    });
  });
}

// --- Track options ----------------------------------------------------------------------------

export function openMenu(id) {
  openSheet(id, (t) => title(t), (body, t) => {
    if (t.id === "master") {
      body.innerHTML = `<p class="hint">The master track can't be renamed or deleted.</p>`;
      return;
    }
    body.innerHTML = `
      <label class="field">Name
        <div class="row"><input type="text" id="mName" value="${esc(t.name)}" placeholder="Track ${t.n}"><button class="btn" id="mRename">Rename</button></div>
      </label>
      ${toggle("phase", "Invert phase", "", t.phase)}
      <div class="stack">
        <button class="btn" id="mSelect">Select in REAPER</button>
        <button class="btn" id="mInsert">${icons.plus} Insert new track after this one</button>
        <button class="btn danger" id="mDelete">${icons.trash} Delete track</button>
      </div>
      <p class="hint">Adding, deleting and renaming can be undone in REAPER (Ctrl+Z).</p>`;
    const name = body.querySelector("#mName");
    const rename = () => { lua({ cmd: "name", id: t.id, value: name.value }); toast("Renamed"); };
    body.querySelector("#mRename").onclick = rename;
    name.onkeydown = (e) => { if (e.key === "Enter") rename(); };
    body.querySelector('[data-k="phase"]').onchange = (e) => set(t, "phase", e.target.checked);
    body.querySelector("#mSelect").onclick = () => lua({ cmd: "select", id: t.id });
    body.querySelector("#mInsert").onclick = () => { lua({ cmd: "track_add", after: t.id }); toast("Track added"); close(); };
    body.querySelector("#mDelete").onclick = () => {
      if (!confirm(`Delete track ${t.n}${t.name ? ` "${t.name}"` : ""}? (Ctrl+Z in REAPER undoes it)`)) return;
      lua({ cmd: "track_delete", id: t.id });
      close();
      toast("Track deleted");
    };
  });
}

// --- Add track ------------------------------------------------------------------------------

export function openAddTrack() {
  if (!store.scriptAlive) {
    toast("Adding tracks needs ReaperController.lua running in REAPER");
    return;
  }
  const selected = () => store.state?.tracks.find((t) => (store.native[t.n]?.flags ?? 0) & 2);
  let where = selected() ? "after" : "end";
  openSheet(null, () => "Add track", (body) => {
    const sel = selected();
    if (!sel && where === "after") where = "end";
    const prev = body.querySelector("#aName")?.value ?? "";
    body.innerHTML = `
      <label class="field">Name (optional)
        <input type="text" id="aName" placeholder="New track" value="${esc(prev)}">
      </label>
      <h3>Where</h3>
      <div class="choices" id="aWhere">
        ${sel ? choice("after", `After ${sel.n} · ${sel.name || `Track ${sel.n}`} (selected)`, where === "after") : ""}
        ${choice("end", "At the end", where === "end")}
      </div>
      <button class="btn primary" id="aAdd">${icons.plus} Add track</button>`;
    body.querySelectorAll("#aWhere .choice").forEach((b) => { b.onclick = () => { where = b.dataset.v; draw(); }; });
    const add = () => {
      lua({ cmd: "track_add", after: where === "after" ? selected()?.id : undefined, name: body.querySelector("#aName").value.trim() });
      toast("Track added");
      close();
    };
    body.querySelector("#aAdd").onclick = add;
    body.querySelector("#aName").onkeydown = (e) => { if (e.key === "Enter") add(); };
  });
}

on("open-input", openInput);
on("open-record", openRecord);
on("open-routing", openRouting);
on("open-menu", openMenu);
