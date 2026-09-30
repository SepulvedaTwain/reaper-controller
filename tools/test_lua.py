"""Runs reaper/ReaperController.lua in a real Lua 5.4 against a fake REAPER API.

    python -m venv %TEMP%\\rcvenv && %TEMP%\\rcvenv\\Scripts\\pip install lupa
    %TEMP%\\rcvenv\\Scripts\\python tools\\test_lua.py

Checks the JSON the script publishes and that every command does what it should.
"""
import json
import sys
from pathlib import Path

from lupa import lua54

SCRIPT = Path(__file__).resolve().parent.parent / "reaper" / "ReaperController.lua"


class Track:
    def __init__(self, name, guid, fx=(), **info):
        self.name, self.guid = name, guid
        self.fx = [{"name": f, "en": True, "open": False} for f in fx]
        self.info = {"D_VOL": 1.0, "D_PAN": 0.0, "B_MUTE": 0, "I_SOLO": 0, "I_FXEN": 1, "I_RECARM": 0, "I_RECMON": 1,
                     "I_RECMODE": 0, "I_RECINPUT": 4096 | (63 << 5), "B_MAINSEND": 1, "I_FOLDERDEPTH": 0, "I_SELECTED": 0,
                     "I_NCHAN": 2, "B_PHASE": 0, "B_AUTO_RECARM": 0, "I_RECMONITEMS": 0, "I_MIDIHWOUT": -1} | info
        self.chain = False
        self.sends, self.hw = [], []  # sends: {"dest": Track, ...}; hw: {"I_DSTCHAN": n, ...}


class FakeReaper:
    def __init__(self):
        self.master = Track("", "master-guid", ["Pro-L 2 (FabFilter)"])
        self.tracks = [
            Track("Serum Lead", "{A}", ["VST3i: Serum 2 (Xfer Records)", "VST3: ValhallaRoom (Valhalla DSP, LLC)"]),
            Track("Drums \"live\"", "{B}", ["VSTi: Superior Drummer 3 (Toontrack)"], I_RECARM=1, I_RECMODE=7),
            Track("Bus", "{C}", [], I_FOLDERDEPTH=1),
        ]
        self.tracks[0].sends.append({"dest": self.tracks[2], "D_VOL": 0.5, "D_PAN": 0.0, "B_MUTE": 0, "I_SENDMODE": 0})
        self.tracks[1].hw.append({"I_DSTCHAN": 2, "D_VOL": 1.0, "D_PAN": 0.0, "B_MUTE": 0, "I_SENDMODE": 0})
        self.ext, self.deferred, self.clock, self.console = {}, None, 0.0, []
        self.undo = []

    # --- tracks
    def CountTracks(self, p): return len(self.tracks)
    def GetTrack(self, p, i): return self.tracks[i] if 0 <= i < len(self.tracks) else None
    def GetMasterTrack(self, p): return self.master
    def GetTrackGUID(self, t): return t.guid
    def GetMediaTrackInfo_Value(self, t, k):
        if k == "IP_TRACKNUMBER":
            return -1 if t is self.master else self.tracks.index(t) + 1
        return t.info[k]
    def SetMediaTrackInfo_Value(self, t, k, v): t.info[k] = v; return True
    def GetSetMediaTrackInfo_String(self, t, k, v, set_):
        if set_:
            t.name = v
        return True, t.name
    def GetTrackColor(self, t): return 0 if t is not self.tracks[0] else 0x1000000 | 0x3c78b4
    def ColorFromNative(self, c): return (c >> 16) & 255, (c >> 8) & 255, c & 255
    def SetOnlyTrackSelected(self, t):
        for x in self.tracks:
            x.info["I_SELECTED"] = 1 if x is t else 0
    def InsertTrackAtIndex(self, i, defaults): self.tracks.insert(i, Track("", "{NEW%d}" % len(self.tracks)))
    def DeleteTrack(self, t): self.tracks.remove(t)
    def TrackList_AdjustWindows(self, x): pass
    def Undo_BeginBlock(self): pass
    def Undo_EndBlock(self, desc, flags): self.undo.append(desc)
    # --- fx
    def TrackFX_GetCount(self, t): return len(t.fx)
    def TrackFX_GetFXName(self, t, i, buf): return True, t.fx[i]["name"]
    def TrackFX_GetEnabled(self, t, i): return t.fx[i]["en"]
    def TrackFX_SetEnabled(self, t, i, en): t.fx[i]["en"] = bool(en)
    def TrackFX_GetOpen(self, t, i): return t.fx[i]["open"]
    def TrackFX_GetInstrument(self, t): return 0 if t.fx and t.fx[0]["name"].startswith(("VST3i", "VSTi")) else -1
    def TrackFX_GetChainVisible(self, t): return 0 if t.chain else -1
    def TrackFX_Show(self, t, i, flag):
        if flag == 3: t.fx[i]["open"] = True
        elif flag == 2: t.fx[i]["open"] = False
        elif flag == 1: t.chain = True
        elif flag == 0: t.chain = False
    # --- routing
    def _list(self, t, cat):
        if cat == 0: return t.sends
        if cat == 1: return t.hw
        return [s for src in self.tracks for s in src.sends if s["dest"] is t]
    def GetTrackNumSends(self, t, cat): return len(self._list(t, cat))
    def GetTrackSendInfo_Value(self, t, cat, i, k):
        s = self._list(t, cat)[i]
        if k == "P_DESTTRACK": return s["dest"]
        if k == "P_SRCTRACK": return next(src for src in self.tracks if s in src.sends)
        return s[k]
    def SetTrackSendInfo_Value(self, t, cat, i, k, v): self._list(t, cat)[i][k] = v; return True
    def CreateTrackSend(self, src, dest):
        if dest is None:
            src.hw.append({"I_DSTCHAN": 0, "D_VOL": 1.0, "D_PAN": 0.0, "B_MUTE": 0, "I_SENDMODE": 0})
            return len(src.hw) - 1
        src.sends.append({"dest": dest, "D_VOL": 1.0, "D_PAN": 0.0, "B_MUTE": 0, "I_SENDMODE": 0})
        return len(src.sends) - 1
    def RemoveTrackSend(self, t, cat, i):
        lst = self._list(t, cat)
        s = lst[i]
        if cat == -1:
            next(src for src in self.tracks if s in src.sends).sends.remove(s)
        else:
            lst.remove(s)
        return True
    # --- devices
    def GetNumAudioInputs(self): return 4
    def GetInputChannelName(self, i): return f"Input {i + 1}"
    def GetNumAudioOutputs(self): return 4
    def GetOutputChannelName(self, i): return f"Output {i + 1}"
    def GetNumMIDIInputs(self): return 2
    def GetMIDIInputName(self, i, buf): return (True, "KeyStep 37") if i == 0 else (False, "")
    def GetNumMIDIOutputs(self): return 1
    def GetMIDIOutputName(self, i, buf): return True, "KeyStep 37"
    # --- extstate / runtime
    def GetExtState(self, s, k): return self.ext.get((s, k), "")
    def SetExtState(self, s, k, v, persist): self.ext[(s, k)] = v
    def DeleteExtState(self, s, k, persist): self.ext.pop((s, k), None)
    def defer(self, f): self.deferred = f
    def atexit(self, f): pass
    def time_precise(self): self.clock += 0.1; return self.clock
    def ShowConsoleMsg(self, m): self.console.append(m)


def main():
    fake = FakeReaper()
    lua = lua54.LuaRuntime(unpack_returned_tuples=True)
    lua.globals().reaper = fake
    lua.execute(SCRIPT.read_text(encoding="utf-8"))

    def tick(n=2):
        for _ in range(n):
            fake.deferred()

    def state():
        return json.loads(fake.ext[("ReaperController", "state")])

    def send(seq, *cmds):
        fake.ext[("ReaperController", "in")] = json.dumps({"s": seq, "c": list(cmds)})
        tick()
        assert fake.ext[("ReaperController", "ack")] == str(seq), "no ack"

    failures = []

    def check(label, cond):
        print(("PASS " if cond else "FAIL ") + label)
        if not cond:
            failures.append(label)

    tick()
    s = state()
    check("state published with 3 tracks + master", len(s["tracks"]) == 3 and s["master"]["id"] == "master")
    t0, t1, t2 = s["tracks"]
    check("FX names cleaned (VST3i: Serum 2 (Xfer Records) -> Serum 2)", [f["name"] for f in t0["fx"]] == ["Serum 2", "ValhallaRoom"])
    check("instrument flagged", t0["fx"][0]["inst"] and not t0["fx"][1]["inst"])
    check("quotes in names survive JSON", t1["name"] == 'Drums "live"')
    check("colour decoded", t0["color"] == "#3c78b4" and t1.get("color") is None)
    check("send listed with destination", t0["sends"][0]["track"] == "{C}" and t0["sends"][0]["n"] == 3 and abs(t0["sends"][0]["vol"] - 0.5) < 1e-6)
    check("receive listed on destination", t2["recvs"][0]["track"] == "{A}")
    check("hardware output listed", t1["hw"][0]["dst"] == 2)
    check("record mode + input", t1["recmode"] == 7 and t0["input"] == 4096 | (63 << 5))
    check("empty arrays stay arrays", t2["fx"] == [] and t2["sends"] == [])
    check("devices listed", s["devices"]["midiIn"] == [{"idx": 0, "name": "KeyStep 37"}] and len(s["devices"]["audioIn"]) == 4)
    ver0 = fake.ext[("ReaperController", "ver")]
    alive0 = fake.ext[("ReaperController", "alive")]
    tick()
    check("heartbeat advances", fake.ext[("ReaperController", "alive")] != alive0)
    check("ver unchanged when nothing changes", fake.ext[("ReaperController", "ver")] == ver0)

    send(101, {"cmd": "set", "id": "{A}", "key": "recmode", "value": 8}, {"cmd": "set", "id": "{A}", "key": "mainsend", "value": False})
    check("set recmode / mainsend", fake.tracks[0].info["I_RECMODE"] == 8 and fake.tracks[0].info["B_MAINSEND"] == 0)
    check("ver bumped after change", fake.ext[("ReaperController", "ver")] != ver0)
    send(102, {"cmd": "fx_float", "id": "{A}", "fx": 1})
    check("fx_float opens plugin window", fake.tracks[0].fx[1]["open"])
    send(103, {"cmd": "fx_float", "id": "{A}", "fx": 1}, {"cmd": "fx_chain", "id": "{B}"}, {"cmd": "fx_enable", "id": "{A}", "fx": 0, "value": False})
    check("fx_float toggles closed, chain opens, bypass", not fake.tracks[0].fx[1]["open"] and fake.tracks[1].chain and not fake.tracks[0].fx[0]["en"])
    send(103, {"cmd": "track_delete", "id": "{A}"})
    check("repeated seq is not executed twice", len(fake.tracks) == 3)
    send(104, {"cmd": "name", "id": "{C}", "value": "Bus \\ 1 — ü"})
    check("rename with backslash/unicode", fake.tracks[2].name == "Bus \\ 1 — ü")
    send(105, {"cmd": "track_add", "after": "{A}", "name": "New Synth"})
    check("track added after Serum Lead", fake.tracks[1].name == "New Synth" and len(fake.tracks) == 4)
    send(106, {"cmd": "send_add", "id": "{B}", "dest": "{C}"}, {"cmd": "hw_add", "id": "{A}", "dst": 4},
         {"cmd": "route_set", "id": "{A}", "cat": 0, "idx": 0, "key": "vol", "value": 0.25})
    check("send + hw output added, send volume set",
          fake.tracks[2].sends[-1]["dest"] is fake.tracks[3] and fake.tracks[0].hw[-1]["I_DSTCHAN"] == 4
          and abs(fake.tracks[0].sends[0]["D_VOL"] - 0.25) < 1e-9)
    send(107, {"cmd": "route_remove", "id": "{C}", "cat": -1, "idx": 0})
    check("receive removed (from source track)", len(fake.tracks[0].sends) == 0)
    send(108, {"cmd": "track_delete", "id": "{NEW3}"}, {"cmd": "track_delete", "id": "master"})
    check("track deleted, master protected", len(fake.tracks) == 3)
    send(109, {"cmd": "nonsense"}, {"cmd": "set", "id": "{B}", "key": "D_VOL", "value": 9})
    check("unknown commands / keys ignored", fake.tracks[1].info["D_VOL"] == 1.0)
    fake.ext[("ReaperController", "in")] = "{not json"
    tick()
    check("bad JSON ignored, inbox cleared", ("ReaperController", "in") not in fake.ext)
    check("undo points for structural changes", "Reaper Controller: add track" in fake.undo and "Reaper Controller: delete track" in fake.undo)
    check("no script errors", not fake.console)
    for m in fake.console:
        print("   console:", m.strip())
    print(f"\n{'ALL PASSED' if not failures else f'{len(failures)} FAILED'}")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
