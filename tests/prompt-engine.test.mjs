import test from "node:test";
import assert from "node:assert/strict";
import { buildBridgeRequest, buildTrackRequest, extractFeatures, museSignificance } from "../scripts/prompt-engine.js";
import { Mode } from "../scripts/constants.js";

const roll = (o) => ({ actor: "Aria", total: 10, normalized: 0.5, isCrit: false, isFumble: false, flavor: "", ...o });

test("quiet table gets a steady tavern standard", () => {
  const r = buildTrackRequest({ mode: Mode.TAVERN, rolls: [], chats: [] });
  assert.match(r.prompt, /tavern folk/);
  assert.ok(r.bpm >= 70 && r.bpm <= 128, `bpm ${r.bpm} in tavern range`);
  assert.match(r.why, /quiet table/);
});

test("crits make tavern music faster and give a heroic verse", () => {
  const quiet = buildTrackRequest({ rolls: [roll({})] });
  const crits = buildTrackRequest({ rolls: [roll({ isCrit: true, normalized: 1, total: 20 }), roll({ actor: "Bram", isCrit: true, normalized: 1, total: 20 })] });
  assert.ok(crits.bpm > quiet.bpm, `${crits.bpm} > ${quiet.bpm}`);
  assert.match(crits.lyrics, /Aria rolled like a legend/);
  assert.match(crits.why, /crits: Aria×1/);
});

test("three crits means jig time 6/8", () => {
  const r = buildTrackRequest({ rolls: [roll({ isCrit: true, normalized: 1 }), roll({ isCrit: true, normalized: 1 }), roll({ isCrit: true, normalized: 1 })] });
  assert.equal(r.timeSignature, "6");
});

test("fumble-heavy window gets drunken 3/4 waltz and a mocking verse", () => {
  const r = buildTrackRequest({ rolls: [roll({ actor: "Bram", isFumble: true, normalized: 0 }), roll({ actor: "Bram", isFumble: true, normalized: 0 })] });
  assert.equal(r.timeSignature, "3");
  assert.equal(r.title, "The Drunken Waltz");
  assert.match(r.lyrics, /Poor Bram dropped it/);
});

test("combat is faster than tavern for the same rolls", () => {
  const rolls = [roll({}), roll({})];
  const t = buildTrackRequest({ mode: Mode.TAVERN, rolls });
  const c = buildTrackRequest({ mode: Mode.COMBAT, rolls });
  assert.ok(c.bpm >= 118 && c.bpm > t.bpm, `combat ${c.bpm} > tavern ${t.bpm}`);
  assert.match(c.prompt, /war drum/);
  assert.match(c.prompt, /hurdy-gurdy/);
});

test("chat keywords season the lyrics without quoting chat verbatim", () => {
  const chats = [{ text: "the dragon hoard dragon gold" }, { text: "dragon again, more gold" }];
  const r = buildTrackRequest({ rolls: [roll({})], chats });
  assert.match(r.lyrics, /dragon/);
  assert.doesNotMatch(r.lyrics, /dragon again, more gold/);
  assert.match(r.why, /chat talk of dragon/);
});

test("bawdy levels change the prompt register", () => {
  assert.match(buildTrackRequest({ bawdy: "clean" }).prompt, /family-friendly/);
  assert.match(buildTrackRequest({ bawdy: "bawdy" }).prompt, /bawdy medieval drinking song/);
  assert.match(buildTrackRequest({ bawdy: "filthy" }).prompt, /raunchy/);
});

test("tracks default to long loop-friendly durations with seamless-loop tags", () => {
  const t = buildTrackRequest({ mode: Mode.TAVERN, rolls: [roll({})] });
  const c = buildTrackRequest({ mode: Mode.COMBAT, rolls: [roll({})] });
  assert.equal(t.duration, 180);
  assert.equal(c.duration, 180);
  assert.match(t.prompt, /seamless loop/);
  assert.match(c.prompt, /seamless loop/);
});

test("each loop keeps the chorus but varies the verses", () => {
  const rolls = [roll({ isCrit: true, normalized: 1, total: 20 }), roll({ actor: "Bram", isFumble: true, normalized: 0, total: 1 })];
  const loop0 = buildTrackRequest({ rolls, loopIndex: 0 });
  const loop1 = buildTrackRequest({ rolls, loopIndex: 1, recentVerses: loop0.verseLines });
  const chorus = (lyrics) => lyrics.split("[Chorus]")[1]?.split("\n").filter(Boolean)[0];
  assert.equal(chorus(loop0.lyrics), chorus(loop1.lyrics), "chorus hook is stable across loops");
  assert.ok(loop0.verseLines.length >= 2 && loop1.verseLines.length >= 2, "two verses worth of lines");
  assert.notDeepEqual(loop1.verseLines, loop0.verseLines, "verses change per loop");
  for (const line of loop1.verseLines) assert.ok(!loop0.verseLines.includes(line), `loop 1 must not repeat loop 0 line: ${line}`);
  assert.match(loop1.lyrics, /\[Verse 2\]/);
});

test("bridges are long instrumentals that blend tempos between styles", () => {
  const rolls = [roll({}), roll({})];
  const bridge = buildBridgeRequest({ mode: Mode.COMBAT, fromMode: Mode.TAVERN, rolls });
  const tavern = buildTrackRequest({ mode: Mode.TAVERN, rolls });
  const combat = buildTrackRequest({ mode: Mode.COMBAT, rolls });
  assert.equal(bridge.instrumental, true);
  assert.match(bridge.prompt, /instrumental/);
  assert.match(bridge.prompt, /seamless loop/);
  assert.doesNotMatch(bridge.lyrics, /\[Verse/);
  assert.equal(bridge.duration, 180);
  assert.ok(bridge.bpm > tavern.bpm && bridge.bpm < combat.bpm, `bridge ${bridge.bpm} between tavern ${tavern.bpm} and combat ${combat.bpm}`);
  assert.match(bridge.why, /bridge/);
});

test("significance scores crits and fumbles heavily", () => {
  const f = extractFeatures([roll({ isCrit: true }), roll({ isFumble: true })], []);
  assert.ok(museSignificance(f) >= 6);
  assert.equal(museSignificance(extractFeatures([], [])), 0);
});
