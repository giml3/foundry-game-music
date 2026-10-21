import test from "node:test";
import assert from "node:assert/strict";
import { buildSceneControl } from "../scripts/controls.js";
import { ShuffleBag, escapeHtml, nextKindToGenerate, trackFilename } from "../scripts/player-engine.js";

test("scene control has the v14 shape: name/order/icon + button tools keyed by name", () => {
  const calls = [];
  const player = { start: () => calls.push("start"), pauseToggle: () => calls.push("pause"), stop: () => calls.push("stop"), onBreak: () => calls.push("break") };
  const c = buildSceneControl({ player, openStatus: () => calls.push("status"), isGM: true, localize: (k) => k });
  assert.equal(c.name, "bardic-dice");
  assert.equal(typeof c.order, "number");
  assert.match(c.icon, /fa-music/);
  assert.deepEqual(Object.keys(c.tools), ["start", "pause", "stop", "break", "status"]);
  for (const [key, tool] of Object.entries(c.tools)) {
    assert.equal(tool.name, key);
    assert.equal(tool.button, true);
    assert.equal(typeof tool.order, "number");
    assert.equal(typeof tool.onChange, "function");
    tool.onChange();
  }
  assert.deepEqual(calls, ["start", "pause", "stop", "break", "status"]);
});

test("players see only the status tool", () => {
  const c = buildSceneControl({ player: {}, openStatus: () => {}, isGM: false });
  assert.equal(c.tools.start.visible, false);
  assert.equal(c.tools.break.visible, false);
  assert.equal(c.tools.status.visible, true);
});

test("escapeHtml neutralizes chat-card injection", () => {
  assert.equal(escapeHtml('<script>"x"&</script>'), "&lt;script&gt;&quot;x&quot;&amp;&lt;/script&gt;");
});

test("track filenames are timestamped and mode-tagged", () => {
  const f = trackFilename("combat", 3, new Date(2026, 9, 19, 1, 2, 3));
  assert.equal(f, "bardic-20261019-010203-3-combat.mp3");
});

test("corruption sting broadcasts once and obeys its cooldown", async () => {
  const { BardicPlayer } = await import("../scripts/player-engine.js");
  const { SessionLog: Log } = await import("../scripts/session-log.js");
  const calls = [];
  globalThis.AudioHelper = { play: async (...args) => { calls.push(args); return {}; } };
  try {
    const player = new BardicPlayer({
      sessionLog: new Log(),
      getConfig: () => ({ corruptionSting: true, volume: 0.5 }),
    });
    assert.equal(await player.playCorruptionSting("Brunhilde"), true);
    assert.equal(await player.playCorruptionSting("Brunhilde"), false);
    assert.equal(calls.length, 1);
    assert.match(calls[0][0].src, /assets\/corruption-sting\.wav$/);
    assert.equal(calls[0][1], true, "sting is broadcast to other clients");
  } finally {
    delete globalThis.AudioHelper;
  }
});

test("queue alternates vocal songs with instrumental bridges", () => {
  assert.equal(nextKindToGenerate("vocal"), "bridge");
  assert.equal(nextKindToGenerate("bridge"), "vocal");
  assert.equal(nextKindToGenerate(null), "vocal");
});

test("library shuffle bag never repeats until the bag is empty", () => {
  let seed = 42;
  const rng = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const bag = new ShuffleBag(["a", "b", "c", "d"], rng);
  const firstCycle = [bag.next(), bag.next(), bag.next(), bag.next()];
  assert.deepEqual([...firstCycle].sort(), ["a", "b", "c", "d"], "first cycle plays everything once");
  const nextFirst = bag.next();
  assert.notEqual(nextFirst, firstCycle.at(-1), "no immediate repeat across refill");
  assert.equal(new ShuffleBag([], rng).next(), null);
  assert.equal(new ShuffleBag(["only"], rng).next(), "only");
});

const stubPlayer = async () => {
  const { BardicPlayer } = await import("../scripts/player-engine.js");
  const { SessionLog: Log } = await import("../scripts/session-log.js");
  const { State: St } = await import("../scripts/constants.js");
  const player = new BardicPlayer({
    sessionLog: new Log(),
    getConfig: () => ({ bawdy: "bawdy", tavernDuration: 180, combatDuration: 180, bridgeDuration: 360, bridgeLibrary: false }),
  });
  player.state = St.PLAYING;
  player.current = { soundId: "cur", title: "Current", duration: 180, kind: "tavern", bridge: false, startedAt: Date.now() };
  player.checks = [];
  player.scheduleAdvanceCheck = (sec) => { player.checks.push(sec); };
  player.generateTrack = async (req, kind, { bridge = false } = {}) => ({ soundId: `s${Math.random()}`, title: req.title, kind, bridge, duration: 60, why: req.why });
  return player;
};

test("combat switch discards queued tavern tracks and lands a combat vocal first, fast", async () => {
  const player = await stubPlayer();
  player.queue = [{ soundId: "stale", title: "Stale Tavern Song", bridge: false, kind: "tavern" }];
  await player.setMode("combat");
  assert.equal(player.mode, "combat");
  assert.ok(!player.queue.some((t) => t.title === "Stale Tavern Song"), "stale tavern track must not play over combat");
  assert.equal(player.queue[0].bridge, false, "first track in the new mode is a vocal, not a bridge");
  assert.equal(player.queue[0].kind, "combat");
  assert.deepEqual(player.checks, [12], "current track yields within MODE_SWITCH_SEC");
});

test("a crit expedites a fresh vocal and the cooldown stops crit chains thrashing", async () => {
  const player = await stubPlayer();
  player.current = { ...player.current, bridge: true, minDwellSec: 90 };
  player.queue = [{ soundId: "stale", title: "Queued Before The Crit", bridge: false, kind: "tavern" }];
  assert.equal(await player.expediteForMuse(), true);
  assert.equal(player.current.minDwellSec, 40, "bridge dwell is cut to MUSE_SWITCH_SEC");
  assert.equal(player.queue[0].bridge, false, "fresh vocal (with the crit verse) comes first");
  assert.ok(!player.queue.some((t) => t.title === "Queued Before The Crit"));
  const titles = player.queue.map((t) => t.title);
  assert.equal(await player.expediteForMuse(), false, "second crit inside the cooldown does not re-expedite");
  assert.deepEqual(player.queue.map((t) => t.title), titles, "queue is left alone during cooldown");
});

test("an in-flight composition made stale by a mode switch is discarded, not queued", async () => {
  const player = await stubPlayer();
  let releaseFirst;
  const firstGate = new Promise((r) => { releaseFirst = r; });
  let calls = 0;
  player.generateTrack = async (req, kind, { bridge = false } = {}) => {
    calls += 1;
    if (calls === 1) await firstGate;
    return { soundId: `s${calls}`, title: `${kind} take ${calls}`, kind, bridge, duration: 60 };
  };
  const filling = player.ensureNext();
  player.invalidateQueue(); // combat started while take 1 was composing
  releaseFirst();
  await filling;
  assert.ok(calls >= 2, "a fresh track is composed after discarding the stale one");
  assert.ok(!player.queue.some((t) => t.title.endsWith("take 1")), "stale in-flight track never enters the queue");
});

test("player reserves alternating bard turns along the playback chain", async () => {
  const { BardicPlayer } = await import("../scripts/player-engine.js");
  const { SessionLog: Log } = await import("../scripts/session-log.js");
  const player = new BardicPlayer({ sessionLog: new Log(), getConfig: () => ({ bawdy: "bawdy" }) });
  assert.equal(player.buildNextRequest("tavern").bard.gender, "male");
  assert.equal(player.buildNextRequest("tavern").bard.gender, "female");
  player._lastSongIndex = 1; player.queue = []; player._assignedSongIndex = 1;
  assert.equal(player.buildNextRequest("combat").bard.gender, "male", "alternates from the last heard song after a queue clear");
});

test("GPU relief: combat renders are capped, one track ahead, parody stands down when urgent", async () => {
  const player = await stubPlayer();
  assert.ok(player.buildNextRequest("combat").duration <= 120, "combat vocal render capped at 120s");
  assert.ok(player.buildBridgeReq("combat").duration <= 60, "combat bridge render capped at 60s");
  await player.setMode("combat");
  assert.equal(player.queue.length, 1, "only one track is composed ahead");
  const cfg = { parodyEnabled: true, parodyBaseUrl: "http://127.0.0.1:8123" };
  const req = player.buildNextRequest("combat");
  assert.equal(await player.parodyLyrics(req, "combat", cfg), null, "parody hunt stands down during the urgent switch");
  assert.ok(player.workLog.some((w) => /standing down for the urgent switch/.test(w.text)), "the stand-down shows in the sidebar work log");
});
