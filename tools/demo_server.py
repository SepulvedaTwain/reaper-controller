"""Demo server: imitates REAPER's web interface + ReaperController.lua with a simulated mixer.

For developing the page and taking screenshots without touching a real REAPER project.
Not needed to use Reaper Controller (REAPER itself serves the page).

    python tools/demo_server.py            → http://127.0.0.1:4831/reaper-controller/

Implements the parts of REAPER's web API the page uses: TRANSPORT, NTRACK, TRACK,
SET/TRACK/<i>/VOL|PAN|MUTE|SOLO|RECARM|SEL, transport action IDs, and GET/SET/EXTSTATE —
where writing ReaperController/in runs the commands like the Lua script would.
"""
import argparse
import json
import math
import mimetypes
import random
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Lock
from urllib.parse import unquote

WEB = (Path(__file__).resolve().parent.parent / "web").resolve()
SECTION = "ReaperController"
mimetypes.add_type("text/javascript", ".js")
mimetypes.add_type("text/css", ".css")


def db(v):
    return 10 ** (v / 20)


def new_track(name, color=None, fx=(), folder=0, vol_db=0.0, inp=4096 | (63 << 5), **extra):
    instruments = ("Serum 2", "Superior Drummer 3", "Kontakt 8", "Sylenth1", "Prophet-5 V")
    t = {
        "id": "{" + str(uuid.uuid4()).upper() + "}", "name": name, "color": color, "vol": db(vol_db), "pan": 0.0,
        "mute": False, "solo": False, "arm": False, "sel": False, "fxen": True, "chain": False,
        "fx": [{"name": f, "en": True, "open": False, "inst": i == 0 and f in instruments} for i, f in enumerate(fx)],
        "mon": 1, "recmode": 0, "input": inp, "mainsend": True, "folder": folder, "nchan": 2, "phase": False,
        "autoarm": False, "monitems": False, "midiout": -1, "sends": [], "hw": [], "level": 0.0,
    }
    t.update(extra)
    return t


class Demo:
    def __init__(self):
        self.lock = Lock()
        self.ext = {}
        self.ver = 1000
        self.beat = 0
        self.last_state = ""
        self.last_seq = None
        self.transport = {"state": 0, "pos": 159.67, "rep": False, "bpm": 152.0, "t": time.time()}
        self.devices = {
            "audioIn": [f"Input {i}" for i in range(1, 9)],
            "audioOut": [f"Output {i}" for i in range(1, 9)],
            "midiIn": [{"idx": 0, "name": "Arturia KeyStep 37"}],
            "midiOut": [{"idx": 0, "name": "Arturia KeyStep 37"}],
        }
        T = new_track
        self.master = T("MASTER", fx=["Pro-L 2", "Youlean Loudness Meter 2"], vol_db=-1.0)
        self.master["id"] = "master"
        self.tracks = [
            T("Guitar DI", "#b45f3c", ["Morgan Amps Suite", "Avocado Ducking"], vol_db=-4.7, inp=0, mute=True),
            T("Serum Lead", "#3c78b4", ["Serum 2", "ValhallaRoom", "ValhallaDelay"], vol_db=-7.0),
            T("Drums", "#8a5cc2", ["Superior Drummer 3", "Pro-Q 4", "Transient-Driven FX"], vol_db=-6.9,
              inp=4096 | (62 << 5) | 10, solo=True),
            T("Serum Pad", "#3c78b4", ["Serum 2", "Virtual Tape Machines", "Pro-Q 4"], vol_db=-8.3,
              inp=4096 | (63 << 5) | 3, arm=True, recmode=7, sel=True),
            T("Variation 12", None, ["Superior Drummer 3", "Virtual Mix Rack"], vol_db=-4.1),
            T("Glitch (granular)", "#4f9a6a", ["Bitcrush", "EQ — HPF 100 Hz", "ValhallaDelay", "Supermassive"],
              vol_db=-2.0, inp=1024, pan=0.27),
            T("Sylenth Bass", "#b4a03c", ["Sylenth1"], vol_db=-5.5, inp=4096 | (63 << 5) | 2),
            T("Orchestra", "#6b7280", [], folder=1, inp=-1),
            T("bass trombones", None, ["Kontakt 8"], vol_db=-4.4, inp=4096 | (62 << 5) | 2, pan=-0.35),
            T("bassoons", None, ["Kontakt 8"], vol_db=-5.9),
            T("violas", None, ["Kontakt 8"], vol_db=-3.5, inp=4096 | (62 << 5) | 2, pan=0.2),
            T("Violins 1", None, ["Kontakt 8"], folder=-1, inp=4096 | (62 << 5) | 3, pan=-0.45),
            T("Prophet-5", "#c2415c", ["Prophet-5 V", "ValhallaSpaceModulator"], vol_db=-3.0),
            T("Snare (SD3)", "#8a5cc2", ["Superior Drummer 3", "EQ — subtractive", "EQ — tonal"], vol_db=-6.5),
        ]
        self.tracks[1]["sends"].append({"dest": self.tracks[5]["id"], "vol": db(-6), "pan": 0.0, "mute": False, "mode": 0})
        self.tracks[3]["sends"].append({"dest": self.tracks[5]["id"], "vol": db(-12), "pan": 0.2, "mute": False, "mode": 3})
        self.tracks[0]["hw"].append({"dst": 2, "vol": 1.0, "pan": 0.0, "mute": False, "mode": 0})
        self.tracks[1]["fx"][1]["open"] = True
        self.tracks[4]["fx"][1]["en"] = False
        self.project = {"len": 420.0, "undo": "Reaper Controller: add send", "marks": [
            {"pos": 0.0, "end": 60.0, "name": "Intro", "rgn": True, "color": "#3c78b4"},
            {"pos": 60.0, "end": 150.0, "name": "Verse", "rgn": True, "color": "#4f9a6a"},
            {"pos": 150.0, "end": 240.0, "name": "Chorus", "rgn": True, "color": "#c2415c"},
            {"pos": 240.0, "end": 330.0, "name": "Bridge", "rgn": True, "color": "#8a5cc2"},
            {"pos": 105.0, "name": "drop", "rgn": False},
            {"pos": 300.0, "name": "strings in", "rgn": False},
        ]}
        self.ext[(SECTION, "perf")] = "0.42"
        self._publish()

    # --- what ReaperController.lua would publish ------------------------------------------
    def _find(self, tid):
        return self.master if tid == "master" else next((t for t in self.tracks if t["id"] == tid), None)

    def _n(self, tid):
        return next((i + 1 for i, t in enumerate(self.tracks) if t["id"] == tid), 0)

    def _receives(self, t):
        return [(src, s) for src in self.tracks for s in src["sends"] if s["dest"] == t["id"]]

    def _view(self, t, n):
        v = {k: t[k] for k in ("id", "name", "fxen", "chain", "fx")}
        v["n"] = n
        if t.get("color"):
            v["color"] = t["color"]
        if t is self.master:
            return v
        for k in ("mon", "recmode", "input", "mainsend", "folder", "nchan", "phase", "autoarm", "monitems", "midiout"):
            v[k] = t[k]
        route = lambda s: {k: s[k] for k in ("vol", "pan", "mute", "mode")}
        v["sends"] = [{"idx": i, "track": s["dest"], "n": self._n(s["dest"]), "name": self._find(s["dest"])["name"], **route(s)}
                      for i, s in enumerate(t["sends"])]
        v["recvs"] = [{"idx": i, "track": src["id"], "n": self._n(src["id"]), "name": src["name"], **route(s)}
                      for i, (src, s) in enumerate(self._receives(t))]
        v["hw"] = [{"idx": i, "dst": h["dst"], **route(h)} for i, h in enumerate(t["hw"])]
        return v

    def _publish(self):
        state = json.dumps({"v": 1, "devices": self.devices, "project": self.project, "master": self._view(self.master, 0),
                            "tracks": [self._view(t, i + 1) for i, t in enumerate(self.tracks)]})
        if state != self.last_state:
            self.last_state = state
            self.ver += 1
            self.ext[(SECTION, "state")] = state
            self.ext[(SECTION, "ver")] = str(self.ver)

    # --- commands (like the Lua HANDLERS) ----------------------------------------------------
    def run(self, c):
        cmd, t = c.get("cmd"), self._find(c.get("id"))
        if cmd == "seek":
            self.transport["pos"] = max(0.0, float(c["pos"]))
            return
        if cmd == "track_add":
            idx = self._n(c["after"]) if c.get("after") else len(self.tracks)
            self.tracks.insert(idx or len(self.tracks), new_track(c.get("name") or ""))
        elif t is None:
            return
        elif cmd == "set" and c.get("key") in ("vol", "pan"):
            t[c["key"]] = float(c["value"])
        elif cmd == "set" and c.get("key") in ("mon", "recmode", "input", "mainsend", "fxen", "phase", "nchan",
                                              "autoarm", "monitems", "midiout"):
            v = c["value"]
            t[c["key"]] = bool(v) if c["key"] in ("mainsend", "fxen", "phase", "autoarm", "monitems") else v
        elif cmd == "name":
            t["name"] = c["value"]
        elif cmd == "select":
            for x in self.tracks:
                x["sel"] = x is t
        elif cmd == "fx_float":
            t["fx"][c["fx"]]["open"] = not t["fx"][c["fx"]]["open"]
        elif cmd == "fx_chain":
            t["chain"] = not t["chain"]
        elif cmd == "fx_enable":
            t["fx"][c["fx"]]["en"] = bool(c["value"])
        elif cmd == "track_delete" and t is not self.master:
            self.tracks.remove(t)
            for x in self.tracks:
                x["sends"] = [s for s in x["sends"] if s["dest"] != t["id"]]
        elif cmd == "send_add" and self._find(c.get("dest")) not in (None, t):
            t["sends"].append({"dest": c["dest"], "vol": 1.0, "pan": 0.0, "mute": False, "mode": 0})
        elif cmd == "recv_add" and self._find(c.get("src")) not in (None, t):
            self._find(c["src"])["sends"].append({"dest": t["id"], "vol": 1.0, "pan": 0.0, "mute": False, "mode": 0})
        elif cmd == "hw_add":
            t["hw"].append({"dst": c.get("dst", 0), "vol": 1.0, "pan": 0.0, "mute": False, "mode": 0})
        elif cmd in ("route_remove", "route_set"):
            cat, idx = c["cat"], c["idx"]
            if cat == -1:
                src, s = self._receives(t)[idx]
                lst, i = src["sends"], src["sends"].index(s)
            else:
                lst, i = (t["sends"] if cat == 0 else t["hw"]), idx
            if cmd == "route_remove":
                lst.pop(i)
            elif c.get("key") in ("vol", "pan", "mute", "mode", "dst"):
                lst[i][c["key"]] = bool(c["value"]) if c["key"] == "mute" else c["value"]

    # --- REAPER web API --------------------------------------------------------------------
    def api(self, commands: str) -> str:
        out = []
        with self.lock:
            self._advance()
            for cmd in commands.split(";"):
                parts = cmd.split("/")
                head = parts[0]
                if head == "TRANSPORT":
                    tr = self.transport
                    beats = tr["pos"] * tr["bpm"] / 60
                    b = f"{int(beats // 4) + 1}.{int(beats % 4) + 1}.{int((beats % 1) * 100):02d}"
                    out.append(f"TRANSPORT\t{tr['state']}\t{tr['pos']:.6f}\t{int(tr['rep'])}\t{b}\t{b}")
                elif head == "NTRACK":
                    out.append(f"NTRACK\t{len(self.tracks)}")
                elif head == "TRACK":
                    rng = range(len(self.tracks) + 1)
                    if len(parts) > 1 and parts[1].isdigit():
                        rng = [int(parts[1])]
                    for i in rng:
                        out.append(self._track_line(i))
                elif head == "SET" and len(parts) >= 5 and parts[1] == "TRACK":
                    self._set_track(int(parts[2]), parts[3], parts[4])
                elif head == "SET" and len(parts) >= 4 and parts[1] == "EXTSTATE":
                    self._set_ext(parts[2], parts[3], unquote("/".join(parts[4:])))
                elif head == "GET" and len(parts) >= 4 and parts[1] == "EXTSTATE":
                    val = self.ext.get((parts[2], parts[3]), "")
                    val = val.replace("\\", "\\\\").replace("\t", "\\t").replace("\n", "\\n")
                    out.append(f"EXTSTATE\t{parts[2]}\t{parts[3]}\t{val}")
                elif head.isdigit():
                    self._action(int(head))
            self.beat += 1
            self.ext[(SECTION, "alive")] = str(self.beat)
        return "".join(line + "\n" for line in out)

    def _advance(self):
        tr, now = self.transport, time.time()
        dt, tr["t"] = now - tr["t"], now
        playing = tr["state"] in (1, 5)
        if playing:
            tr["pos"] += dt
        soloed = any(t["solo"] for t in self.tracks)
        for t in self.tracks + [self.master]:
            audible = playing and not t["mute"] and (t["fx"] or t is self.master) and (not soloed or t["solo"] or t is self.master)
            target = min(1.3, t["vol"] * random.uniform(0.3, 0.9)) if audible else 0.0
            t["level"] = max(target, t["level"] * 0.75)

    def _track_line(self, i):
        t = self.master if i == 0 else self.tracks[i - 1]
        flags = (1 if t.get("folder") == 1 else 0) | (2 if t["sel"] else 0) | (4 if t["fx"] else 0) | (8 if t["mute"] else 0) \
            | (16 if t["solo"] else 0) | (64 if t["arm"] else 0) | (128 if t.get("mon") == 1 else 0) \
            | (256 if t.get("mon") == 2 else 0) | (512 if i == 0 else 0)
        lvl = t["level"]
        peak = int(round(20 * math.log10(lvl) * 10)) if lvl > 1e-5 else -1500
        name = "MASTER" if i == 0 else t["name"]
        return (f"TRACK\t{i}\t{name}\t{flags}\t{t['vol']:.6f}\t{t['pan']:.6f}\t{peak}\t{peak}\t1.000000\t3\t"
                f"{len(t['sends'])}\t{len(self._receives(t))}\t{len(t['hw'])}\t0")

    def _set_track(self, i, what, value):
        if not 0 <= i <= len(self.tracks):
            return
        t = self.master if i == 0 else self.tracks[i - 1]
        key = {"VOL": "vol", "PAN": "pan", "MUTE": "mute", "SOLO": "solo", "RECARM": "arm", "SEL": "sel"}.get(what)
        if not key:
            return
        v = float(value.rstrip("eEg"))  # REAPER suffixes: e = end of touch, g = ignore ganging
        if key in ("vol", "pan"):
            t[key] = max(0.0, v) if key == "vol" else max(-1.0, min(1.0, v))
        else:
            t[key] = (not t[key]) if v < 0 else bool(v)

    def _set_ext(self, section, key, value):
        if value == "":
            self.ext.pop((section, key), None)
            return
        self.ext[(section, key)] = value
        if (section, key) == (SECTION, "live"):
            # Like the Lua script: apply dragged values straight away, then clear.
            del self.ext[(section, key)]
            try:
                for tid, v in json.loads(value).items():
                    t = self._find(tid)
                    if t:
                        if "vol" in v: t["vol"] = max(0.0, float(v["vol"]))
                        if "pan" in v: t["pan"] = max(-1.0, min(1.0, float(v["pan"])))
            except (ValueError, AttributeError, TypeError):
                pass
            return
        if (section, key) == (SECTION, "in"):
            # What ReaperController.lua does with its inbox.
            del self.ext[(section, key)]
            try:
                msg = json.loads(value)
            except ValueError:
                return
            seq = str(msg.get("s"))
            if seq != self.last_seq:
                self.last_seq = seq
                for c in msg.get("c") or []:
                    try:
                        self.run(c)
                    except (KeyError, IndexError, TypeError, ValueError):
                        pass
            self.ext[(SECTION, "ack")] = seq
        self._publish()

    def _action(self, action_id):
        tr = self.transport
        if action_id == 1007:
            tr["state"] = 1
        elif action_id == 1016:
            tr["state"] = 0
        elif action_id == 1008:
            tr["state"] = 2 if tr["state"] in (1, 5) else 1
        elif action_id == 1013:
            tr["state"] = 5
        elif action_id == 40042:
            tr["pos"] = 0.0
        elif action_id == 1068:
            tr["rep"] = not tr["rep"]
        elif action_id == 40029:
            self.project["redo"], self.project["undo"] = self.project.get("undo"), None
        elif action_id == 40030:
            self.project["undo"], self.project["redo"] = self.project.get("redo"), None
        self._publish()


def make_handler(demo: Demo):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def _send(self, status, body: bytes, ctype="text/plain"):
            self.send_response(status)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            path = self.path.split("?", 1)[0]
            if path.startswith("/_/"):
                return self._send(200, demo.api(path[3:]).encode("utf-8"))
            if path in ("/", "/reaper-controller"):
                self.send_response(302)
                self.send_header("Location", "/reaper-controller/")
                self.end_headers()
                return
            if path == "/shot.html":  # README screenshot harness (tools/shot.html)
                return self._send(200, (Path(__file__).resolve().parent / "shot.html").read_bytes(), "text/html")
            if path.startswith("/reaper-controller/"):
                rel = unquote(path[len("/reaper-controller/"):]) or "index.html"
                target = (WEB / rel).resolve()
                if target.is_file() and target.is_relative_to(WEB):
                    ctype = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
                    return self._send(200, target.read_bytes(), ctype)
            self._send(404, b"Not found")

    return Handler


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--port", type=int, default=4831)
    args = ap.parse_args()
    server = ThreadingHTTPServer(("0.0.0.0", args.port), make_handler(Demo()))
    print(f"Demo mixer on http://127.0.0.1:{args.port}/reaper-controller/  (Ctrl+C to stop)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
