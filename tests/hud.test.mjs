import test from "node:test";
import assert from "node:assert/strict";
import { hudLines, renderBardicHud } from "../scripts/hud.js";

test("HUD shows now-playing with countdown, the queue, and recent bard/LLM activity", () => {
  const lines = hudLines({
    state: "playing", mode: "combat", nowPlaying: "Combat Jig", remainSec: 125,
    nextTrack: "War Song", queued: 2,
    activity: [
      { actor: "bard", text: "combat called — switching within 12s, stale tracks dropped" },
      { actor: "lyric-llm", text: "fresh verses written (FUMBLE: Bram rolled 99)" },
      { actor: "memory", text: "saga memory: 40 rolls, 3 crits, 1 deaths all-time" },
    ],
    why: "combat → faster (140 BPM, A minor)",
  });
  assert.match(lines[0], /Combat Jig \(combat · 2:05 left\)/);
  assert.match(lines[1], /Next: War Song \(\+1 queued\)/);
  assert.ok(lines.some((l) => l.startsWith("BARD: combat called")), lines.join("\n"));
  assert.ok(lines.some((l) => l.startsWith("LYRIC: fresh verses")), lines.join("\n"));
  assert.ok(lines.some((l) => l.startsWith("MEMORY: saga memory")), lines.join("\n"));
  assert.ok(lines.some((l) => l.startsWith("Why: combat")), lines.join("\n"));
});

test("HUD is honest when stopped or composing instead of pretending to play", () => {
  assert.deepEqual(hudLines(null), ["♪ Bardic Dice — stopped"]);
  assert.match(hudLines({ state: "generating", generating: true })[0], /composing/);
  assert.match(hudLines({ state: "playing", mode: "tavern", nowPlaying: "Tankard Song", nextTrack: "—", queued: 0, activity: [] })[1], /composing when this track nears its end/);
});

test("HUD renders into a corner element without a framework", () => {
  const kids = [];
  const el = { id: "", children: kids, setAttribute() {}, appendChild(k) { kids.push(k); }, set textContent(_v) { kids.length = 0; }, get textContent() { return kids.map((k) => k.textContent).join("\n"); } };
  const doc = {
    body: { appendChild() {} },
    getElementById: (id) => (id === "bardic-dice-hud" && el.id ? el : null),
    createElement: () => ({ className: "", textContent: "" }),
  };
  el.id = "bardic-dice-hud";
  renderBardicHud({ state: "playing", mode: "tavern", nowPlaying: "Tankard Song", remainSec: 61, nextTrack: "Next Song", queued: 1, activity: [{ actor: "bard", text: "singing Tankard Song" }] }, doc);
  assert.match(el.textContent, /Tankard Song/);
  assert.match(el.textContent, /BARD: singing/);
});
