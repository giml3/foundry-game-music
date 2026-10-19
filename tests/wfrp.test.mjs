import test from "node:test";
import assert from "node:assert/strict";
import { parseWfrpTest, rollEventFromMessage, SessionLog } from "../scripts/session-log.js";
import { buildTrackRequest, extractFeatures, museSignificance } from "../scripts/prompt-engine.js";
import { aggregateBreakStats, buildBreakRequest, buildTemplateBallad } from "../scripts/recap.js";
import { Mode } from "../scripts/constants.js";

const wtest = (roll, target, extra = {}) => ({
  result: { roll, target, outcome: roll <= target || roll === 1 ? "success" : "failure", ...extra },
});

test("WFRP: doubles under target are criticals, doubles over are fumbles", () => {
  assert.equal(parseWfrpTest(wtest(22, 50)).isCrit, true);
  assert.equal(parseWfrpTest(wtest(66, 40)).isFumble, true);
  assert.equal(parseWfrpTest(wtest(11, 5)).isFumble, true, "11 over a target of 5 fumbles");
  assert.equal(parseWfrpTest(wtest(23, 50)).isCrit, false);
  assert.equal(parseWfrpTest(wtest(23, 50)).isFumble, false);
});

test("WFRP: 99 and 100 always fumble, 01 is a fine success", () => {
  assert.equal(parseWfrpTest(wtest(99, 90)).isFumble, true);
  assert.equal(parseWfrpTest(wtest(100, 95)).isFumble, true);
  const one = parseWfrpTest(wtest(1, 40));
  assert.equal(one.isFumble, false);
  assert.ok(one.normalized > 0.85, `normalized ${one.normalized}`);
  assert.ok(parseWfrpTest(wtest(100, 40)).normalized < 0.1);
});

test("WFRP: explicit system labels win (result.critical / isCriticalFumble)", () => {
  const p = parseWfrpTest({ isCriticalFumble: "critical", result: { roll: 30, target: 50, outcome: "success" } });
  assert.equal(p.isCrit, true);
  const f = parseWfrpTest({ result: { roll: 30, target: 50, outcome: "success", fumble: "Fumble" } });
  assert.equal(f.isFumble, true);
});

test("rollEventFromMessage prefers the WFRP test payload over raw dice", () => {
  const ev = rollEventFromMessage({
    wfrpTest: { result: { roll: 33, target: 55, outcome: "success", damage: 12, hitloc: "head" } },
    speaker: { alias: "Brunhilde" }, flavor: "Longsword", timestamp: 42,
  });
  assert.equal(ev.isCrit, true);
  assert.equal(ev.actor, "Brunhilde");
  assert.equal(ev.damage, 12);
  assert.equal(ev.system, "wfrp4e");
});

test("critical wounds darken and slow the tavern track, named in why + lyrics", () => {
  const wounds = [{ kind: "critwound", actor: "Bram", name: "Torn Muscle", location: "rArm" }];
  const plain = buildTrackRequest({ mode: Mode.TAVERN, rolls: [] });
  const hurt = buildTrackRequest({ mode: Mode.TAVERN, rolls: [], wounds });
  assert.equal(hurt.keyScale, "G minor");
  assert.ok(hurt.bpm < plain.bpm, `${hurt.bpm} < ${plain.bpm}`);
  assert.match(hurt.why, /Critical Wound: Bram \(Torn Muscle\)/);
  assert.match(hurt.lyrics, /Bram/);
  assert.match(hurt.lyrics, /Torn Muscle/);
  assert.ok(museSignificance(extractFeatures([], [], wounds)) >= 4);
});

test("critical wounds raise combat intensity", () => {
  const wounds = [{ kind: "critwound", actor: "Aria", name: "Fractured Skull", location: "head" }];
  const a = buildTrackRequest({ mode: Mode.COMBAT, rolls: [] });
  const b = buildTrackRequest({ mode: Mode.COMBAT, rolls: [], wounds });
  assert.ok(b.bpm > a.bpm, `${b.bpm} > ${a.bpm}`);
  assert.match(b.lyrics, /Fractured Skull/);
});

test("no townspeople crowd in tavern or combat prompts; break keeps the crowd", () => {
  const crowd = /rowdy (tavern )?chorus|group chorus|clinking|singalong|townsfolk|background chatter, /;
  for (const mode of [Mode.TAVERN, Mode.COMBAT]) {
    const r = buildTrackRequest({ mode, rolls: [] });
    assert.doesNotMatch(r.prompt.replaceAll("no crowd noise", "").replaceAll("no group chorus", ""), crowd, mode);
    assert.match(r.prompt, /solo/i, mode);
    assert.match(r.prompt, /no crowd noise/i, mode);
  }
  const stats = aggregateBreakStats([]);
  const brk = buildBreakRequest({ stats, lyrics: "x" });
  assert.match(brk.prompt, /group chorus/);
  assert.match(brk.prompt, /crowd|townsfolk|singalong/);
});

test("break recap counts critical wounds and sings the worst hurt", () => {
  const events = [
    { kind: "critwound", ts: 100, actor: "Bram", name: "Torn Muscle", location: "rArm" },
    { kind: "critwound", ts: 200, actor: "Bram", name: "Broken Ribs", location: "body" },
    { kind: "roll", ts: 300, actor: "Aria", total: 22, isCrit: true, isFumble: false, flavor: "Sword" },
  ];
  const s = aggregateBreakStats(events);
  assert.equal(s.critWounds, 2);
  assert.equal(s.topWounded.actor, "Bram");
  assert.match(s.highlights.join(" "), /Bram suffered 2 Critical Wounds/);
  assert.match(buildTemplateBallad(s).lyrics, /Bram/);
  assert.match(buildTemplateBallad(s).lyrics, /[Cc]ritical [Ww]ound/);
});

test("session log exposes recent critical wounds to the muse", () => {
  const now = 10_000_000_000;
  const log = new SessionLog();
  log.add({ kind: "critwound", ts: now - 60_000, actor: "Bram", name: "Torn Muscle" }, now);
  log.add({ kind: "critwound", ts: now - 3600_000, actor: "Old", name: "Scar" }, now);
  assert.deepEqual(log.museWounds(now).map((w) => w.name), ["Torn Muscle"]);
});

test("corruption makes the next track briefly discordant and sad", () => {
  const cor = [{ kind: "corruption", actor: "Brunhilde", points: 1 }];
  const plain = buildTrackRequest({ mode: Mode.TAVERN, rolls: [] });
  const dark = buildTrackRequest({ mode: Mode.TAVERN, rolls: [], corruptions: cor });
  assert.match(dark.prompt, /discordant/i);
  assert.match(dark.why, /Corruption: Brunhilde/);
  assert.equal(dark.keyScale, "G minor");
  assert.ok(dark.bpm <= plain.bpm);
  assert.match(dark.lyrics, /Brunhilde/);
  assert.ok(museSignificance(extractFeatures([], [], [], cor)) >= 3);
});

test("break recap counts corruption gains", () => {
  const events = [
    { kind: "corruption", ts: 100, actor: "Brunhilde", points: 1 },
    { kind: "corruption", ts: 200, actor: "Brunhilde", points: 2 },
  ];
  const s = aggregateBreakStats(events);
  assert.equal(s.corruptionPoints, 3);
  assert.equal(s.topCorrupted.actor, "Brunhilde");
  assert.match(s.highlights.join(" "), /Brunhilde gained 3 Corruption/);
});

test("session log exposes recent corruption to the muse", () => {
  const now = 10_000_000_000;
  const log = new SessionLog();
  log.add({ kind: "corruption", ts: now - 1000, actor: "Brunhilde", points: 1 }, now);
  assert.equal(log.museCorruption(now).length, 1);
});

test("message adapter extracts a live WFRP system test without depending on getters", async () => {
  const { wfrpTestPayloadFromMessage } = await import("../scripts/session-log.js");
  const message = {
    system: {
      test: {
        isCriticalFumble: "critical",
        damage: 14,
        result: {
          roll: 44,
          target: 58,
          outcome: "success",
          critical: "Critical",
          hitloc: { result: "rArm" },
        },
      },
    },
  };
  const payload = wfrpTestPayloadFromMessage(message);
  assert.equal(payload.isCriticalFumble, "critical");
  assert.equal(payload.result.damage, 14);
  assert.equal(payload.result.hitloc, "rArm");
  const event = rollEventFromMessage({
    wfrpTest: payload,
    speaker: { alias: "Brunhilde" },
    flavor: "Melee (Basic)",
    timestamp: 123,
  });
  assert.equal(event.isCrit, true);
  assert.equal(event.damage, 14);
});

test("Critical Wound items and Corruption increases become muse events", async () => {
  const { corruptionGainEvent, critWoundEventFromItem } = await import("../scripts/session-log.js");
  const wound = critWoundEventFromItem({
    type: "critical",
    name: "Torn Muscle (Minor)",
    parent: { name: "Bram" },
    system: { location: { value: "Right Arm", key: "rArm" } },
  }, 99);
  assert.deepEqual(wound, {
    kind: "critwound",
    ts: 99,
    actor: "Bram",
    name: "Torn Muscle (Minor)",
    location: "rArm",
  });
  assert.equal(critWoundEventFromItem({ type: "weapon", name: "Sword" }, 99), null);

  assert.deepEqual(corruptionGainEvent(2, 5, "Brunhilde", 100), {
    kind: "corruption",
    ts: 100,
    actor: "Brunhilde",
    points: 3,
  });
  assert.equal(corruptionGainEvent(5, 5, "Brunhilde", 100), null);
  assert.equal(corruptionGainEvent(5, 4, "Brunhilde", 100), null);
  assert.equal(corruptionGainEvent(undefined, 4, "Brunhilde", 100), null);
});
