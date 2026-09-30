# Reaper Controller

**REAPER's mixer on your tablet, over Wi‑Fi.**

A touch mixer for REAPER that runs in any tablet browser: every track with its FX, input, record arm,
monitoring, record mode, fader with meters, pan, mute/solo, FX chain and routing. Tap a plugin and its
window opens in REAPER. Add and remove tracks, change inputs and record modes, create sends — from the couch
or the vocal booth.

![The mixer: master and tracks with FX slots, inputs, record controls, faders with meters, pan and routing](docs/images/mixer.png)

- **Nothing extra to run.** The page is served by REAPER's own web server, and one Lua script inside REAPER does
  the rest. No Python, no extensions, no drivers.
- **Fast, and undo-friendly.** Mute, solo, arm, meters and transport use REAPER's built-in web API; fader and
  pan moves stream to the script and become **one undo step per drag**.
- Works with any browser (iPad, Android, phone, another computer) on the same network.

---

## How it works

```mermaid
flowchart LR
    T["Tablet browser"] -- "HTTP · port 2307" --> W["REAPER web interface<br/>(serves the page)"]
    W -- "built-in API: mute, solo, arm,<br/>meters, transport" --> R["REAPER"]
    W -- "ExtState: state ⇄ commands" --> L["ReaperController.lua<br/>(runs inside REAPER)"]
    L -- "ReaScript API: volume/pan, FX, inputs,<br/>record modes, routing, add/remove tracks" --> R
```

REAPER's web interface already exposes mute, solo, arm, meters and transport (and volume/pan — but its volume
command makes an undo point for every update, so one fader drag became many undo steps). Everything else —
the FX list, opening plugin windows, inputs, record modes, sends, adding/removing tracks — isn't in that API,
so a small ReaScript running inside REAPER handles it. The page and the script talk through REAPER's *ExtState*
store, which the web interface can read and write: the script publishes a JSON snapshot of the mixer (only when
something changes) and runs command batches the page sends, acknowledging each one so nothing is lost or doubled.
While a fader or pan is being dragged, its values go through a separate fast key the script applies straight away
without undo points; the value where you let go arrives as a normal command and makes exactly one undo point.

## Install

1. **Enable REAPER's web interface** (skip if you already have one, e.g. on port 2307):
   Options → Preferences → **Control/OSC/web → Add → Web browser interface**, pick a port (e.g. **2307**), OK.
2. **Copy the files into REAPER:** double-click **`install.bat`**. It copies
   - `web\` → `%APPDATA%\REAPER\reaper_www_root\reaper-controller\`
   - `reaper\ReaperController.lua` → `%APPDATA%\REAPER\Scripts\ReaperController\`

   and prints the address to open. (Portable REAPER: `install.bat -ReaperPath "D:\Your\REAPER"`.)
3. **Start the script in REAPER.** `install.bat` asks whether to **start it automatically whenever REAPER
   opens** (it adds a few marked lines to `Scripts\__startup.lua`; delete them to turn that off). To start it
   right away without restarting REAPER: Actions → Show action list → **New action → Load ReaScript…** → pick
   `Scripts\ReaperController\ReaperController.lua` → **Run**. It keeps running in the background until REAPER
   closes. After updating, run it again → *Terminate instances*, then run it once more.
4. **On the tablet** open

   ```
   http://<your PC's IP>:2307/reaper-controller/index.html
   ```

   (e.g. `http://192.168.1.23:2307/reaper-controller/index.html`; `install.bat` prints yours).
   On iPad: Safari → Share → **Add to Home Screen** for a full-screen app.

**Windows Firewall has to allow REAPER** on your Wi‑Fi's network profile. If the page works on the PC but the tablet
hangs on *loading* and times out, Windows is blocking REAPER (common when the Wi‑Fi is set to *Public* and the
firewall prompt was dismissed). Fix, in PowerShell **as administrator** — allows only devices on your own network:

```nSet-NetFirewallRule -DisplayName "REAPER" -Action Allow -RemoteAddress LocalSubnet
```

or Windows Security → Firewall & network protection → Allow an app through firewall → REAPER → tick your
network type (Public/Private).

## Using it

The status pill shows **Connected** (REAPER + script), **Script not running** (REAPER reachable — faders, mute,
solo, arm, meters and transport still work; anything that needs the script says so when you tap it) or
**REAPER offline**. Tap the pill to see how much time the script spends per snapshot.

### Top bar and timeline

- **Transport:** ⏮ go to start · ▶ play · ⏸ pause · ■ stop · ● record · ⟲ repeat, and the play position
  (bars.beats and time).
- **Undo / redo:** REAPER's undo and redo; hover/hold shows what they'll undo (e.g. *Undo: add send*).
- **Timeline:** the whole project as a bar — regions (coloured, named), markers, the play position (red while
  recording). **Tap or drag** to jump there.
- **S / M / L** strip width, **Layout** (see below), **+ Track** (name + after the selected track or at the end).

### Mixer strips

From top to bottom, like REAPER's mixer:

| Part | Tap | Hold / more |
|---|---|---|
| **FX slots** | Opens / closes that plugin's window in REAPER | Hold: bypass / un-bypass |
| **Input** | Choose the record input (MIDI device + channel, mono or stereo audio, none) | |
| **● ⦿ mode** | Arm · record monitoring (👁 grey = off, green = on — you hear the input, yellow = tape auto: only while recording/stopped) · record mode (IN / OVR / REP…) | Mode opens the record panel |
| **Fader** | Drag up/down (moves from where it is, never jumps); one undo step per drag | Double-tap: 0 dB |
| **Meter** | Peak level, -60 to +6 dB | |
| **Pan** | Drag sideways | Double-tap: centre |
| **M / S** | Mute / solo | |
| **FX** | Opens / closes the FX chain window in REAPER (green = has FX, red = FX bypassed) | |
| **Routing** ↩ | Opens the routing panel (blue = has sends/receives/outputs) | |
| **⋯** | Track options | |
| **Name** | Selects the track in REAPER | Hold: track options |

The master strip is pinned on the left; tracks scroll sideways.

### Layout mode

Tap the **Layout** button (square-in-corners icon); touches don't change anything while it's on:

| Pinch on… | Changes |
|---|---|
| Top bar | size of the whole top bar (transport, undo/redo, buttons) |
| Timeline | ↕ its height |
| Mixer | ↔ strip width · ↕ how many FX slots show per strip (0 hides them) |

**Reset** restores the defaults, **Done** returns to playing. Saved on the device. On a computer: Ctrl+wheel (↔) /
Shift+wheel (↕) over the same areas.

### Panels

![Record panel: monitoring options and record modes](docs/images/record.png)

- **Record** (the mode button): Monitoring *off / monitor input / tape auto style*, *monitor track media when
  recording*, record mode — **input, MIDI overdub, MIDI replace, MIDI touch-replace, MIDI latch-replace,
  output (stereo / mono / MIDI), disable (monitoring only)** — and *automatic record-arm when track selected*.
- **Input**: None · MIDI (All MIDI inputs / Virtual MIDI keyboard / each device, then All or channel 1–16) ·
  audio mono · audio stereo pairs.

![Routing panel: master send, track channels, sends with volume, pan and mute, receives, hardware outputs](docs/images/routing.png)

- **Routing** (the routing button): master send on/off, track channel count, **sends** and **receives** (volume,
  pan, mute, remove, *add new send / receive…*), **audio hardware outputs** (add, level, pan, mute, remove) and
  the **MIDI hardware output**.
- **Track options** (⋯ or hold the name): rename, invert phase, select in REAPER, insert a new track after,
  delete the track (asks with a separate Cancel / Delete button).

![Input panel: MIDI devices and channels, audio inputs](docs/images/input.png)

Every change from the tablet is one REAPER undo step — fader and pan drags, adding / deleting / renaming
tracks, inputs, record modes, monitoring, FX bypass, sends — so the **Undo** button (or Ctrl+Z in REAPER) takes
back exactly what you did.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Page doesn't load on the tablet (works on the PC) | Windows Firewall is blocking REAPER — see the firewall note under Install. Also: exact address including `/reaper-controller/index.html`, same Wi‑Fi, the 192.168.x.x address (not a VPN one); VPNs may need *Allow LAN connections*. |
| **Script not running** | Run *ReaperController.lua* from REAPER's action list (see Install step 3). |
| A plugin window doesn't open | It opens on the PC's screen in REAPER — check behind other windows. |
| Changes seem slow | The page polls REAPER ~20×/s and the script snapshots ~15×/s; big projects take a bit longer. |
| **Add track** / FX / routing do nothing | The script isn't running — the page says so; start it (Install step 3). |
| Updated the files | Run `install.bat` again and reload the page. To reload the script: run it again → *Terminate instances*, then run it once more. |

## Performance

The script is light. Every REAPER frame (~30×/s) it only checks for commands; while a tablet is connected it
takes a snapshot of the mixer ~15×/s (reading track settings, FX names and routing — the same data REAPER's own
mixer shows) and publishes it only when something changed. **When no tablet is connected it idles to one
snapshot a second** (the page pings it about once a second). Tap the status pill to see the measured cost per
snapshot on your project. Plugins' audio processing is never touched.

## Development

```
python tools/demo_server.py          # simulated REAPER at http://127.0.0.1:4831/reaper-controller/index.html
```

`tools/demo_server.py` imitates REAPER's web interface *and* the script with a demo mixer, so the page can be
developed and screenshotted without a real project.

`tools/test_lua.py` runs the real `ReaperController.lua` in Lua 5.4 (via [lupa](https://github.com/scoder/lupa))
against a fake REAPER API and checks the published state and every command:

```
python -m venv %TEMP%\rcvenv
%TEMP%\rcvenv\Scripts\pip install lupa
%TEMP%\rcvenv\Scripts\python tools\test_lua.py
```

`tools/screenshots.ps1` regenerates `docs/images` with headless Edge + the demo server.

```
reaper-controller/
├── install.bat / install.ps1     copy the page and the script into REAPER
├── reaper/ReaperController.lua   the in-REAPER script (state snapshot + command runner)
├── web/                          the page (plain HTML/CSS/ES modules, no build step)
│   ├── index.html
│   ├── css/app.css
│   └── js/  main.js (top bar) · api.js (REAPER web API + ExtState protocol) · mixer.js (strips)
│            sheets.js (input / record / routing / track / add-track panels) · timeline.js
│            layout.js (Layout mode, pinch) · ui.js (helpers)
├── tools/  demo_server.py · test_lua.py · screenshots.ps1 · shot.html
└── docs/images/
```

### Protocol

| ExtState key (section `ReaperController`) | Written by | Content |
|---|---|---|
| `state` | script | JSON: devices, master, tracks (FX, input, record mode, monitoring, routing…) |
| `ver` | script | Bumped whenever `state` changes — the page polls this, not the big blob |
| `alive` | script | Heartbeat; the page shows *Script not running* if it stops changing |
| `in` | page | `{"s": seq, "c": [commands]}` |
| `ack` | script | `seq` of the last batch run — the page then sends the next one (and resends if no ack) |

| `live` | page | `{"<track id>": {"vol": v, "pan": p}}` while dragging — applied at once, no undo points |
| `client` | page | Changes about once a second while a tablet is connected (the script idles without it) |
| `perf` | script | Average milliseconds per snapshot |

Commands: `set` (mon, recmode, input, mainsend, fxen, phase, nchan, autoarm, monitems, midiout), `name`, `select`,
`fx_float`, `fx_chain`, `fx_enable`, `track_add`, `track_delete`, `send_add`, `recv_add`, `hw_add`,
`route_set`, `route_remove`, `seek`; `set` also takes `vol` / `pan` (the end of a drag — one undo point).
State also carries `project`: length, markers/regions, next undo/redo. Mute, solo, arm and transport go straight
to REAPER's web API (`SET/TRACK/…`, action IDs).

## License

No license chosen yet — add one (e.g. MIT) before publishing.
