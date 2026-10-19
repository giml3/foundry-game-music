import test from "node:test";
import assert from "node:assert/strict";
import { buildTrackRequest, extractFeatures, museSignificance } from "../scripts/prompt-engine.js";
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

test("significance scores crits and fumbles heavily", () => {
  const f = extractFeatures([roll({ isCrit: true }), roll({ isFumble: true })], []);
  assert.ok(museSignificance(f) >= 6);
  assert.equal(museSignificance(extractFeatures([], [])), 0);
});
