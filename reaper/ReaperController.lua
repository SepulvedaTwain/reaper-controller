--[[
  Reaper Controller — companion script (runs inside REAPER).

  The tablet page is served by REAPER's own web server (Preferences → Control/OSC/web → Web browser
  interface). REAPER's built-in web API already covers volume, pan, mute, solo, arm, meters and
  transport; this script adds everything else — FX lists, opening plugin windows, inputs, record
  modes, routing, adding/removing tracks — through REAPER's "ExtState" key/value store, which the
  web API can read and write:

    ReaperController/state   JSON snapshot (tracks, FX, routing, devices), rewritten when it changes
    ReaperController/ver     bumped every time state changes (the page polls this, not the big blob)
    ReaperController/alive   heartbeat, so the page knows this script is running
    ReaperController/in      {"s": seq, "c": [commands]} written by the page
    ReaperController/ack     seq of the last batch executed (the page then sends the next one)

  Run once: Actions → Show action list → New action → Load ReaScript… → pick this file → Run.
  It keeps running in the background until REAPER closes (run it again → Terminate to stop).
]]

local SECTION = "ReaperController"
local INTERVAL = 1 / 15

-- ---------------------------------------------------------------------------------------
-- JSON. Arrays are created with A() so empty arrays encode as [] (not {}).

local ARRAY = {}
local function A() return setmetatable({}, ARRAY) end

local ESCAPES = { ['"'] = '\\"', ["\\"] = "\\\\", ["\n"] = "\\n", ["\r"] = "\\r", ["\t"] = "\\t" }
local function escape(s)
  return (s:gsub('[%c"\\]', function(c) return ESCAPES[c] or string.format("\\u%04x", c:byte()) end))
end

local encode
encode = function(v)
  local t = type(v)
  if t == "nil" then return "null" end
  if t == "boolean" then return v and "true" or "false" end
  if t == "number" then
    if v ~= v or v == math.huge or v == -math.huge then return "null" end
    if math.type(v) == "integer" then return tostring(v) end
    local s = string.format("%.4f", v):gsub("0+$", ""):gsub("%.$", "")
    return s
  end
  if t == "string" then return '"' .. escape(v) .. '"' end
  if t == "table" then
    local parts = {}
    if getmetatable(v) == ARRAY or v[1] ~= nil then
      for i = 1, #v do parts[i] = encode(v[i]) end
      return "[" .. table.concat(parts, ",") .. "]"
    end
    for k, val in pairs(v) do parts[#parts + 1] = '"' .. escape(tostring(k)) .. '":' .. encode(val) end
    return "{" .. table.concat(parts, ",") .. "}"
  end
  return "null"
end

local UNESCAPE = { ['"'] = '"', ["\\"] = "\\", ["/"] = "/", b = "\b", f = "\f", n = "\n", r = "\r", t = "\t" }

local function decode(s)
  local pos = 1
  local function skip() pos = s:find("[^ \t\r\n]", pos) or #s + 1 end
  local function char() return s:sub(pos, pos) end
  local value

  local function str()
    pos = pos + 1 -- opening quote
    local out = {}
    while true do
      local j = s:find('["\\]', pos)
      if not j then error("unterminated string") end
      out[#out + 1] = s:sub(pos, j - 1)
      pos = j
      if char() == '"' then pos = pos + 1; return table.concat(out) end
      local e = s:sub(pos + 1, pos + 1)
      if UNESCAPE[e] then
        out[#out + 1] = UNESCAPE[e]; pos = pos + 2
      elseif e == "u" then
        out[#out + 1] = utf8.char(tonumber(s:sub(pos + 2, pos + 5), 16) or 63); pos = pos + 6
      else
        error("bad escape")
      end
    end
  end

  value = function()
    skip()
    local c = char()
    if c == "{" then
      pos = pos + 1
      local t = {}
      skip()
      if char() == "}" then pos = pos + 1; return t end
      while true do
        skip()
        local k = str()
        skip(); pos = pos + 1 -- ':'
        t[k] = value()
        skip()
        local d = char(); pos = pos + 1
        if d == "}" then return t end
        if d ~= "," then error("expected , or }") end
      end
    elseif c == "[" then
      pos = pos + 1
      local t = {}
      skip()
      if char() == "]" then pos = pos + 1; return t end
      while true do
        t[#t + 1] = value()
        skip()
        local d = char(); pos = pos + 1
        if d == "]" then return t end
        if d ~= "," then error("expected , or ]") end
      end
    elseif c == '"' then
      return str()
    elseif s:sub(pos, pos + 3) == "true" then pos = pos + 4; return true
    elseif s:sub(pos, pos + 4) == "false" then pos = pos + 5; return false
    elseif s:sub(pos, pos + 3) == "null" then pos = pos + 4; return nil
    end
    local n = s:match("^-?%d+%.?%d*[eE]?[-+]?%d*", pos)
    if not n or n == "" then error("unexpected character at " .. pos) end
    pos = pos + #n
    return tonumber(n)
  end

  return value()
end

-- ---------------------------------------------------------------------------------------
-- Reading REAPER

local function info(tr, key) return reaper.GetMediaTrackInfo_Value(tr, key) end
local function int(x) return math.floor(x + 0.5) end

local function trackColor(tr)
  local c = reaper.GetTrackColor(tr)
  if c == 0 then return nil end
  local r, g, b = reaper.ColorFromNative(c)
  return string.format("#%02x%02x%02x", r, g, b)
end

-- "VST3i: Serum 2 (Xfer Records)" → "Serum 2", the way the mixer shows it.
local function cleanFxName(name)
  name = name:gsub("^%w+:%s*", "")
  name = name:gsub("%s*%([^()]*%)%s*$", "")
  return name
end

local function trackName(tr)
  local _, name = reaper.GetSetMediaTrackInfo_String(tr, "P_NAME", "", false)
  return name
end

local function trackId(tr)
  if tr == reaper.GetMasterTrack(0) then return "master" end
  return reaper.GetTrackGUID(tr)
end

-- category: 0 = sends, -1 = receives, 1 = hardware outputs
local function routes(tr, category)
  local list = A()
  for i = 0, reaper.GetTrackNumSends(tr, category) - 1 do
    local r = {
      idx = i,
      vol = reaper.GetTrackSendInfo_Value(tr, category, i, "D_VOL"),
      pan = reaper.GetTrackSendInfo_Value(tr, category, i, "D_PAN"),
      mute = reaper.GetTrackSendInfo_Value(tr, category, i, "B_MUTE") == 1,
      mode = int(reaper.GetTrackSendInfo_Value(tr, category, i, "I_SENDMODE")),
    }
    if category == 1 then
      r.dst = int(reaper.GetTrackSendInfo_Value(tr, 1, i, "I_DSTCHAN"))
    else
      local ok, other = pcall(reaper.GetTrackSendInfo_Value, tr, category, i, category == 0 and "P_DESTTRACK" or "P_SRCTRACK")
      if ok and type(other) == "userdata" then
        r.track = trackId(other)
        r.n = int(info(other, "IP_TRACKNUMBER"))
        r.name = trackName(other)
      end
    end
    list[#list + 1] = r
  end
  return list
end

local function trackState(tr, isMaster)
  local t = {
    id = trackId(tr),
    n = isMaster and 0 or int(info(tr, "IP_TRACKNUMBER")),
    name = isMaster and "MASTER" or trackName(tr),
    color = trackColor(tr),
    fxen = info(tr, "I_FXEN") ~= 0,
    chain = reaper.TrackFX_GetChainVisible(tr) ~= -1,
    fx = A(),
  }
  local instrument = reaper.TrackFX_GetInstrument(tr)
  for i = 0, reaper.TrackFX_GetCount(tr) - 1 do
    local _, name = reaper.TrackFX_GetFXName(tr, i, "")
    t.fx[#t.fx + 1] = {
      name = cleanFxName(name),
      en = reaper.TrackFX_GetEnabled(tr, i),
      open = reaper.TrackFX_GetOpen(tr, i),
      inst = i == instrument,
    }
  end
  if not isMaster then
    t.mon = int(info(tr, "I_RECMON"))
    t.recmode = int(info(tr, "I_RECMODE"))
    t.input = int(info(tr, "I_RECINPUT"))
    t.mainsend = info(tr, "B_MAINSEND") == 1
    t.folder = int(info(tr, "I_FOLDERDEPTH"))
    t.nchan = int(info(tr, "I_NCHAN"))
    t.phase = info(tr, "B_PHASE") == 1
    t.autoarm = info(tr, "B_AUTO_RECARM") == 1
    t.monitems = info(tr, "I_RECMONITEMS") == 1
    t.midiout = int(info(tr, "I_MIDIHWOUT"))
    t.sends = routes(tr, 0)
    t.recvs = routes(tr, -1)
    t.hw = routes(tr, 1)
  end
  return t
end

local function devices()
  local d = { audioIn = A(), audioOut = A(), midiIn = A(), midiOut = A() }
  for i = 0, reaper.GetNumAudioInputs() - 1 do d.audioIn[#d.audioIn + 1] = reaper.GetInputChannelName(i) end
  for i = 0, reaper.GetNumAudioOutputs() - 1 do d.audioOut[#d.audioOut + 1] = reaper.GetOutputChannelName(i) end
  for i = 0, reaper.GetNumMIDIInputs() - 1 do
    local ok, name = reaper.GetMIDIInputName(i, "")
    if ok then d.midiIn[#d.midiIn + 1] = { idx = i, name = name } end
  end
  for i = 0, reaper.GetNumMIDIOutputs() - 1 do
    local ok, name = reaper.GetMIDIOutputName(i, "")
    if ok then d.midiOut[#d.midiOut + 1] = { idx = i, name = name } end
  end
  return d
end

local deviceCache, deviceTime = nil, -100

local function buildState(now)
  if now - deviceTime > 5 then deviceCache, deviceTime = devices(), now end
  local s = { v = 1, devices = deviceCache, master = trackState(reaper.GetMasterTrack(0), true), tracks = A() }
  for i = 0, reaper.CountTracks(0) - 1 do s.tracks[#s.tracks + 1] = trackState(reaper.GetTrack(0, i), false) end
  return s
end

-- ---------------------------------------------------------------------------------------
-- Commands from the page

local function byId(id)
  if id == "master" then return reaper.GetMasterTrack(0) end
  for i = 0, reaper.CountTracks(0) - 1 do
    local tr = reaper.GetTrack(0, i)
    if reaper.GetTrackGUID(tr) == id then return tr end
  end
end

local TRACK_KEYS = {
  mon = "I_RECMON", recmode = "I_RECMODE", input = "I_RECINPUT", mainsend = "B_MAINSEND", fxen = "I_FXEN",
  phase = "B_PHASE", nchan = "I_NCHAN", autoarm = "B_AUTO_RECARM", monitems = "I_RECMONITEMS", midiout = "I_MIDIHWOUT",
}
local ROUTE_KEYS = { vol = "D_VOL", pan = "D_PAN", mute = "B_MUTE", mode = "I_SENDMODE", dst = "I_DSTCHAN" }

local function num(v)
  if v == true then return 1 elseif v == false then return 0 end
  return tonumber(v)
end

local function undoable(desc, fn)
  reaper.Undo_BeginBlock()
  fn()
  reaper.TrackList_AdjustWindows(false)
  reaper.Undo_EndBlock("Reaper Controller: " .. desc, -1)
end

local HANDLERS = {
  set = function(c, tr)
    local key, value = TRACK_KEYS[c.key], num(c.value)
    if tr and key and value then reaper.SetMediaTrackInfo_Value(tr, key, value) end
  end,
  name = function(c, tr)
    if tr and c.id ~= "master" then
      undoable("rename track", function() reaper.GetSetMediaTrackInfo_String(tr, "P_NAME", tostring(c.value or ""), true) end)
    end
  end,
  select = function(_, tr) if tr then reaper.SetOnlyTrackSelected(tr) end end,
  fx_float = function(c, tr)
    if tr and c.fx then reaper.TrackFX_Show(tr, c.fx, reaper.TrackFX_GetOpen(tr, c.fx) and 2 or 3) end
  end,
  fx_chain = function(_, tr)
    if not tr then return end
    if reaper.TrackFX_GetChainVisible(tr) ~= -1 then reaper.TrackFX_Show(tr, 0, 0) else reaper.TrackFX_Show(tr, 0, 1) end
  end,
  fx_enable = function(c, tr)
    if tr and c.fx then reaper.TrackFX_SetEnabled(tr, c.fx, c.value and true or false) end
  end,
  track_add = function(c)
    undoable("add track", function()
      local idx = reaper.CountTracks(0)
      local after = c.after and byId(c.after)
      if after and c.after ~= "master" then idx = int(info(after, "IP_TRACKNUMBER")) end
      reaper.InsertTrackAtIndex(idx, true)
      local tr = reaper.GetTrack(0, idx)
      if tr and c.name and c.name ~= "" then reaper.GetSetMediaTrackInfo_String(tr, "P_NAME", tostring(c.name), true) end
    end)
  end,
  track_delete = function(c, tr)
    if tr and c.id ~= "master" then undoable("delete track", function() reaper.DeleteTrack(tr) end) end
  end,
  send_add = function(c, tr)
    local dest = c.dest and byId(c.dest)
    if tr and dest and dest ~= tr then undoable("add send", function() reaper.CreateTrackSend(tr, dest) end) end
  end,
  recv_add = function(c, tr)
    local src = c.src and byId(c.src)
    if tr and src and src ~= tr then undoable("add receive", function() reaper.CreateTrackSend(src, tr) end) end
  end,
  hw_add = function(c, tr)
    if not tr then return end
    undoable("add hardware output", function()
      local i = reaper.CreateTrackSend(tr, nil)
      if i >= 0 and c.dst then reaper.SetTrackSendInfo_Value(tr, 1, i, "I_DSTCHAN", c.dst) end
    end)
  end,
  route_remove = function(c, tr)
    if tr and c.cat and c.idx then undoable("remove send", function() reaper.RemoveTrackSend(tr, c.cat, c.idx) end) end
  end,
  route_set = function(c, tr)
    local key, value = ROUTE_KEYS[c.key], num(c.value)
    if tr and key and value and c.cat and c.idx then reaper.SetTrackSendInfo_Value(tr, c.cat, c.idx, key, value) end
  end,
}

local function run(c)
  if type(c) ~= "table" then return end
  local handler = HANDLERS[c.cmd]
  if handler then handler(c, c.id and byId(c.id)) end
end

local lastSeq = nil

local function handleInbox()
  local raw = reaper.GetExtState(SECTION, "in")
  if raw == "" then return end
  local ok, msg = pcall(decode, raw)
  reaper.DeleteExtState(SECTION, "in", false)
  if not ok or type(msg) ~= "table" then return end
  local seq = tostring(msg.s)
  if seq ~= lastSeq then
    lastSeq = seq
    for _, c in ipairs(msg.c or {}) do pcall(run, c) end
  end
  reaper.SetExtState(SECTION, "ack", seq, false)
end

-- ---------------------------------------------------------------------------------------
-- Main loop

local lastState, lastTick, ver, beat, lastError = "", 0, math.random(1, 1000000), 0, nil

local function tick()
  handleInbox()
  local now = reaper.time_precise()
  if now - lastTick >= INTERVAL then
    lastTick = now
    local state = encode(buildState(now))
    if state ~= lastState then
      lastState = state
      ver = ver + 1
      reaper.SetExtState(SECTION, "state", state, false)
      reaper.SetExtState(SECTION, "ver", tostring(ver), false)
    end
    beat = beat + 1
    reaper.SetExtState(SECTION, "alive", tostring(beat), false)
  end
end

local function loop()
  -- Never let one bad read stop the script; report each distinct error once.
  local ok, err = pcall(tick)
  if not ok and err ~= lastError then
    lastError = err
    reaper.ShowConsoleMsg("Reaper Controller: " .. tostring(err) .. "\n")
  end
  reaper.defer(loop)
end

reaper.atexit(function()
  for _, key in ipairs({ "alive", "state", "ver", "in", "ack" }) do reaper.DeleteExtState(SECTION, key, false) end
end)

loop()
