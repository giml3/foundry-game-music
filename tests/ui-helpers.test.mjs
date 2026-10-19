import test from "node:test";
import assert from "node:assert/strict";
import { buildSceneControl } from "../scripts/controls.js";
import { escapeHtml, nextKindToGenerate, trackFilename } from "../scripts/player-engine.js";

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
