import test from "node:test";
import assert from "node:assert/strict";
import { careerFromActor, deathEventFromActor, deathEventFromTransition, deathSnapshotFromActor, isFatalCriticalWound, parseWfrpTest, rollEventFromMessage, SessionLog } from "../scripts/session-log.js";
import { buildDirgeRequest, buildTrackRequest, extractFeatures, fallenLabel, museSignificance } from "../scripts/prompt-engine.js";
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
  assert.match(hurt.keyScale, /minor$/, "wounds force some minor key");
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
  assert.match(dark.keyScale, /minor$/, "corruption forces some minor key");
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

test("plain 1d100 rolls in a WFRP world are roll-under: low is good", () => {
  const low = rollEventFromMessage({ rolls: [{ total: 8, formula: "1d100", dice: [{ faces: 100, values: [8] }] }], systemId: "wfrp4e", speaker: { alias: "Lottie" }, timestamp: 1 }, 1);
  const high = rollEventFromMessage({ rolls: [{ total: 91, formula: "1d100", dice: [{ faces: 100, values: [91] }] }], systemId: "wfrp4e", speaker: { alias: "Lottie" }, timestamp: 2 }, 2);
  assert.ok(low.normalized >= 0.9, `low roll scores well (${low.normalized})`);
  assert.ok(high.normalized <= 0.1, `high roll scores badly (${high.normalized})`);
  const d20 = rollEventFromMessage({ rolls: [{ total: 19, formula: "1d20", dice: [{ faces: 20, values: [19] }] }], systemId: "dnd5e", speaker: { alias: "Aria" }, timestamp: 3 }, 3);
  assert.ok(d20.normalized >= 0.9, "generic d20 stays roll-high");
});

const pc = (over = {}) => ({
  id: "actor-1", type: "character", name: "Brunhilde",
  currentCareer: { name: "Soldier" },
  system: { status: { wounds: { value: 10, max: 14 }, criticalWounds: { value: 0, max: 4 } } },
  items: [], effects: [], ...over,
});

test("career comes from currentCareer, the flagged career item, or details", () => {
  assert.equal(careerFromActor(pc()), "Soldier");
  assert.equal(careerFromActor(pc({
    currentCareer: null,
    items: [{ type: "career", name: "Rat Catcher", system: {} }, { type: "career", name: "Witch Hunter", system: { current: true } }],
  })), "Witch Hunter");
  assert.equal(careerFromActor(pc({ currentCareer: null, system: { details: { career: { value: "Barge Master" } } } })), "Barge Master");
  assert.equal(careerFromActor({ type: "character", name: "Nameless", items: [] }), null);
  assert.equal(fallenLabel({ actor: "Brunhilde", career: "Soldier" }), "Brunhilde the Soldier");
  assert.equal(fallenLabel({ actor: "Brunhilde", career: null }), "Brunhilde");
});

test("a PC death fires once on wounds reaching 0 — never for NPCs, corpses, or first sight", () => {
  const alive = deathSnapshotFromActor(pc());
  const fallen = deathSnapshotFromActor(pc({ system: { status: { wounds: { value: 0, max: 14 } } } }));
  const ev = deathEventFromTransition(alive, fallen, 1000);
  assert.deepEqual(ev, { kind: "death", ts: 1000, actor: "Brunhilde", career: "Soldier", actorId: "actor-1", cause: null });
  assert.equal(deathEventFromTransition(alive, alive, 1000), null, "still alive");
  assert.equal(deathEventFromTransition(fallen, fallen, 1000), null, "was already dead");
  assert.equal(deathEventFromTransition(null, fallen, 1000), null, "first observation is only a baseline");
  const npcAlive = deathSnapshotFromActor(pc({ type: "npc", hasPlayerOwner: false }));
  const npcDead = deathSnapshotFromActor(pc({ type: "npc", hasPlayerOwner: false, system: { status: { wounds: { value: 0 } } } }));
  assert.equal(deathEventFromTransition(npcAlive, npcDead, 1000), null, "enemy deaths earn no dirge");
});

test("dead status and critical wounds past the maximum also count as death", () => {
  const alive = deathSnapshotFromActor(pc());
  const flagged = deathSnapshotFromActor(pc({ statuses: new Set(["dead"]) }));
  assert.equal(deathEventFromTransition(alive, flagged, 5)?.actor, "Brunhilde");
  const tooManyCrits = deathSnapshotFromActor(pc({ system: { status: { wounds: { value: 3, max: 14 }, criticalWounds: { value: 5, max: 4 } } } }));
  assert.equal(deathEventFromTransition(alive, tooManyCrits, 5)?.career, "Soldier");
  // Explicit proven-death path (combatant marked Defeated / GM macro).
  assert.equal(deathEventFromActor(pc(), 7)?.career, "Soldier");
  assert.equal(deathEventFromActor({ actor: "Bram", career: "Rat Catcher" }, 7)?.actor, "Bram");
  assert.equal(deathEventFromActor(pc({ type: "npc", hasPlayerOwner: false }), 7), null);
});

test("fatal critical wounds say the victim died; ordinary ones do not", () => {
  assert.equal(isFatalCriticalWound({ type: "critical", name: "Decapitated", system: {} }), true);
  assert.equal(isFatalCriticalWound({ type: "critical", name: "Crushed", system: { description: { value: "<p>The victim dies instantly</p>" } } }), true);
  assert.equal(isFatalCriticalWound({ type: "critical", name: "Torn Muscle", system: { description: { value: "A painful tear" } } }), false);
  assert.equal(isFatalCriticalWound({ type: "weapon", name: "Deadly Blade", system: {} }), false);
});

test("the dirge names the fallen player and their career, slow and solemn", () => {
  const dirge = buildDirgeRequest({ death: { actor: "Brunhilde", career: "Soldier" } });
  assert.equal(dirge.title, "Dirge for Brunhilde");
  assert.match(dirge.lyrics, /Brunhilde the Soldier/);
  assert.match(dirge.why, /Brunhilde the Soldier has died/);
  assert.match(dirge.prompt, /dirge/i);
  assert.match(dirge.prompt, /no crowd noise/i);
  assert.doesNotMatch(dirge.prompt, /bawdy|raunchy|seamless loop/i, "a dirge is reverent and ends");
  assert.ok(dirge.bpm <= 70, `dirge is slow (${dirge.bpm} BPM)`);
  assert.match(dirge.keyScale, /minor$/, "dirges pick a solemn minor key");
  assert.ok(dirge.bpm < buildTrackRequest({ mode: Mode.TAVERN }).bpm, "slower than any tavern song");
  assert.match(buildDirgeRequest({ death: { actor: "Brunhilde", career: "Soldier" }, songIndex: 1 }).prompt, /female Bretonnian bard/, "dirges take their bard turn");
  const careerless = buildDirgeRequest({ death: { actor: "Nameless" } });
  assert.match(careerless.lyrics, /Nameless/);
  assert.doesNotMatch(careerless.lyrics, /undefined|null/);
});

test("deaths darken the next song, feed the muse, and are sung in the recap", () => {
  const deaths = [{ kind: "death", actor: "Brunhilde", career: "Soldier" }];
  const plain = buildTrackRequest({ mode: Mode.TAVERN, rolls: [] });
  const grieving = buildTrackRequest({ mode: Mode.TAVERN, rolls: [], deaths });
  assert.ok(grieving.bpm < plain.bpm, "grief slows the next song");
  assert.match(grieving.keyScale, /minor$/, "grief forces some minor key");
  assert.match(grieving.lyrics, /Brunhilde the Soldier/);
  assert.match(grieving.why, /Death: Brunhilde the Soldier has died/);
  assert.ok(museSignificance(extractFeatures([], [], [], [], deaths)) >= 10);

  const now = 10_000_000_000;
  const log = new SessionLog();
  log.add({ kind: "death", ts: now - 1000, actor: "Brunhilde", career: "Soldier" }, now);
  assert.equal(log.museDeaths(now).length, 1);
  assert.equal(log.summary(now).deaths, 1);

  const stats = aggregateBreakStats([{ kind: "death", ts: 1, actor: "Brunhilde", career: "Soldier" }]);
  assert.equal(stats.deaths.length, 1);
  assert.match(stats.highlights.join(" "), /Brunhilde the Soldier died/);
  assert.match(buildTemplateBallad(stats).lyrics, /Brunhilde the Soldier died/);
  assert.match(buildBreakRequest({ stats, lyrics: "x" }).keyScale, /minor$/, "a death in the recap forces minor");
});
