import test from "node:test";
import assert from "node:assert/strict";
import { STYLE_LOOP_HOOKS, bardVoiceForSong, buildBridgeRequest, buildTrackRequest, chordsForProgression, extractFeatures, freshRollJoke, loopFormForTemplate, museSignificance, pickMusicalVariety, planLibraryTracks, transformProgression } from "../scripts/prompt-engine.js";
import { Mode } from "../scripts/constants.js";

const roll = (o) => ({ actor: "Aria", total: 10, normalized: 0.5, isCrit: false, isFumble: false, flavor: "", ...o });

test("quiet table gets a steady tavern standard", () => {
  const r = buildTrackRequest({ mode: Mode.TAVERN, rolls: [], chats: [] });
  assert.match(r.prompt, /tavern folk/);
  assert.ok(r.bpm >= 84 && r.bpm <= 136, `bpm ${r.bpm} in lively tavern range`);
  assert.match(r.prompt, /plucky lute/);
  assert.match(r.why, /quiet table/);
});

test("crits make tavern music faster and give a heroic verse", () => {
  const quiet = buildTrackRequest({ rolls: [roll({})] });
  const crits = buildTrackRequest({ rolls: [roll({ isCrit: true, normalized: 1, total: 20 }), roll({ actor: "Bram", isCrit: true, normalized: 1, total: 20 })] });
  assert.ok(crits.bpm > quiet.bpm, `${crits.bpm} > ${quiet.bpm}`);
  assert.match(crits.lyrics, /Aria rolled a 20/, "crit joke uses the actual roll");
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
  assert.match(r.lyrics, /Bram:/);
  assert.match(r.lyrics, /disaster|filed a complaint|symphony of soup/, "fumble joke is freshly worded");
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
  assert.match(loop1.lyrics, /\[Verse 2/);
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

test("non-combat bridges are long lively plucky interludes with prominent drums", () => {
  const rolls = [roll({})];
  const bridge = buildBridgeRequest({ mode: Mode.TAVERN, rolls });
  const vocal = buildTrackRequest({ mode: Mode.TAVERN, rolls });
  assert.ok(bridge.duration >= 300 && bridge.duration <= 600, `tavern bridge ${bridge.duration}s is 5-10 min`);
  assert.match(bridge.prompt, /lively/i);
  assert.match(bridge.prompt, /plucky lute/);
  assert.match(bridge.prompt, /prominent bodhran/);
  assert.doesNotMatch(bridge.prompt, /chill|lowkey|quiet background|relaxed unhurried/i);
  assert.ok(bridge.bpm >= 96 && bridge.bpm >= vocal.bpm, `lively bridge ${bridge.bpm} keeps up with vocal ${vocal.bpm}`);
  assert.ok(bridge.minDwellSec >= 60, "bridge dwells a while between songs");
  assert.equal(bridge.joke ?? null, null, "first interlude is purely instrumental");
  assert.equal(bridge.title, "Plucky Interlude");
});

test("every third chill interlude drops one spoken joke; combat never jokes", () => {
  const b0 = buildBridgeRequest({ mode: Mode.TAVERN, bridgeIndex: 0 });
  const b2 = buildBridgeRequest({ mode: Mode.TAVERN, bridgeIndex: 2 });
  const b5 = buildBridgeRequest({ mode: Mode.TAVERN, bridgeIndex: 5 });
  const war = buildBridgeRequest({ mode: Mode.COMBAT, bridgeIndex: 2 });
  assert.equal(b0.lyrics, "[Instrumental]");
  assert.ok(b2.joke && b2.lyrics.includes(b2.joke), "third interlude carries its joke in the lyrics");
  assert.match(b2.prompt, /spoken.*joke/i);
  assert.ok(b5.joke && b5.joke !== b2.joke, "jokes rotate");
  assert.equal(war.joke ?? null, null);
  assert.ok(war.duration <= 180, "combat bridges stay short");
  assert.ok(war.minDwellSec < b0.minDwellSec, "combat bridges yield sooner");
});

test("library plan covers a 24h session with varied lively 5-10 min interludes", () => {
  const plan = planLibraryTracks(48);
  assert.equal(plan.length, 48);
  const totalSec = plan.reduce((a, t) => a + t.duration, 0);
  assert.ok(totalSec >= 5.5 * 3600 && totalSec <= 6.5 * 3600, `48 tracks ≈ 6h unique (got ${(totalSec / 3600).toFixed(1)}h)`);
  for (const t of plan) {
    assert.ok(t.duration >= 300 && t.duration <= 600, `duration ${t.duration} in 5-10 min`);
    assert.ok(["strum", "drum", "mixed"].includes(t.flavor), t.flavor);
    assert.ok(t.bpm >= 96 && t.bpm <= 126, `lively bpm ${t.bpm}`);
  }
  assert.deepEqual(planLibraryTracks(48), plan, "plan is deterministic");
});

test("every bridge flavor has prominent drums and plucky lute", () => {
  for (const flavor of ["strum", "drum", "mixed"]) {
    const b = buildBridgeRequest({ mode: Mode.TAVERN, flavor });
    assert.match(b.prompt, /plucky lute/, flavor);
    assert.match(b.prompt, /bodhran/, flavor);
    assert.match(b.prompt, /frame drum/, flavor);
    assert.match(b.prompt, /lively/i, flavor);
  }
  assert.match(buildBridgeRequest({ mode: Mode.COMBAT }).prompt, /plucky lute/);
});

test("player requests steer tempo, mood, topic, and dedication of the next song", () => {
  const rolls = [roll({})];
  const plain = buildTrackRequest({ rolls });
  const asked = buildTrackRequest({ rolls, requests: { tempoShift: 12, mood: ["rowdy and jubilant"], topic: "the dragon under Bogenhafen", dedication: "Aria", instrumental: false, encore: false } });
  assert.equal(asked.bpm, plain.bpm + 12);
  assert.match(asked.prompt, /rowdy and jubilant/);
  assert.match(asked.lyrics, /dragon under Bogenhafen/);
  assert.match(asked.lyrics, /for Aria, by special request/);
  assert.match(asked.why, /by request/);
  const slowed = buildTrackRequest({ mode: Mode.COMBAT, rolls, requests: { tempoShift: -60, mood: [], topic: null, dedication: null } });
  assert.ok(slowed.bpm >= 118, "tempo asks stay inside the mode range");
});

test("songs alternate male Reiklander and female Bretonnian bards", () => {
  assert.equal(bardVoiceForSong(0).gender, "male");
  assert.equal(bardVoiceForSong(1).gender, "female");
  assert.equal(bardVoiceForSong(2).gender, "male");
  const s0 = buildTrackRequest({ songIndex: 0 });
  const s1 = buildTrackRequest({ songIndex: 1 });
  const s2 = buildTrackRequest({ mode: Mode.COMBAT, songIndex: 2 });
  assert.match(s0.prompt, /male Reiklander bard/);
  assert.match(s0.prompt, /Bavarian German .*accent/);
  assert.match(s1.prompt, /female Bretonnian bard/);
  assert.match(s1.prompt, /French Bretonnian accent/);
  assert.match(s2.prompt, /male Reiklander bard/, "combat songs alternate too");
  assert.match(s0.why, /bard: male Reiklander/);
  assert.match(s1.why, /bard: female Bretonnian/);
  assert.equal(s1.bard.gender, "female");
});

test("significance scores crits and fumbles heavily", () => {
  const f = extractFeatures([roll({ isCrit: true }), roll({ isFumble: true })], []);
  assert.ok(museSignificance(f) >= 6);
  assert.equal(museSignificance(extractFeatures([], [])), 0);
});

test("variety engine transposes, reverses progressions and never repeats back-to-back", () => {
  assert.deepEqual(transformProgression(["i", "VI", "III", "VII"], 1).tokens, ["VII", "III", "VI", "i"]);
  assert.equal(chordsForProgression("D minor", ["i", "VI", "III", "VII"]), "Dm–Bb–F–C");
  assert.equal(chordsForProgression("A major", ["I", "V", "vi", "IV"]), "A–E–F#m–D");
  const songs = Array.from({ length: 8 }, (_, i) => buildTrackRequest({ songIndex: i, varietySeed: 12345 }));
  for (let i = 1; i < songs.length; i++) {
    assert.notEqual(songs[i].variety.styleId, songs[i - 1].variety.styleId, `style changes at song ${i}`);
    assert.notEqual(songs[i].keyScale, songs[i - 1].keyScale, `key changes at song ${i}`);
  }
  assert.ok(new Set(songs.map((s) => s.variety.styleId)).size >= 5, "many styles in rotation");
  assert.ok(songs.some((s) => /reversed/.test(s.variety.transform)), "some progressions run backwards");
  assert.ok(songs.every((s) => /grimdark/i.test(s.prompt)), "grimdark everywhere");
  assert.ok(songs.every((s) => /improvis/i.test(s.prompt)), "improv breaks everywhere");
  assert.ok(songs.every((s) => /original melody only/i.test(s.prompt)), "no borrowed tunes");
  assert.ok(pickMusicalVariety({ songIndex: 0, seed: 7 }).phrase.length > 40);
});

test("every fourth song is a male-female duet; solo songs are explicitly one voice", () => {
  const duet = buildTrackRequest({ songIndex: 3, varietySeed: 99 });
  assert.equal(duet.bard.gender, "duet");
  assert.match(duet.prompt, /MALE-FEMALE DUET/);
  assert.match(duet.lyrics, /Verse 1 - Male Bard/);
  assert.match(duet.lyrics, /Verse 2 - Female Bard/);
  assert.match(duet.lyrics, /Chorus - Both Bards/);
  const male = buildTrackRequest({ songIndex: 0, varietySeed: 99 });
  assert.match(male.prompt, /MALE VOCALIST ONLY, absolutely no female vocals/);
  assert.match(male.lyrics, /^\[Male Vocal\]/);
  const female = buildTrackRequest({ songIndex: 1, varietySeed: 99 });
  assert.match(female.prompt, /FEMALE VOCALIST ONLY, absolutely no male vocals/);
  assert.match(female.lyrics, /^\[Female Vocal\]/);
});

const tagsOf = (lyrics) => [...String(lyrics).matchAll(/\[([^\]]+)\]/g)].map((m) => m[1].split(" - ")[0].trim()).filter((t) => !["Male Vocal", "Female Vocal", "Duet"].includes(t));

test("each style template owns a loop form, hook and per-block harmony", () => {
  for (const songIndex of [0, 1, 2, 3, 5, 8]) {
    const r = buildTrackRequest({ songIndex, varietySeed: 4242 });
    assert.ok(STYLE_LOOP_HOOKS[r.variety.styleId], `hook for ${r.variety.styleId}`);
    assert.equal(r.loopHook, STYLE_LOOP_HOOKS[r.variety.styleId]);
    assert.equal(r.loopForm, loopFormForTemplate(r.variety.template).label);
    assert.deepEqual(tagsOf(r.lyrics), r.loopSections, `lyric blocks follow the ${r.variety.styleId} loop form`);
    const chorusBlocks = r.lyrics.split("[Chorus").slice(1);
    assert.ok(chorusBlocks.length >= 1 && chorusBlocks.every((b) => b.includes(r.loopHook)), "hook verbatim in every chorus");
    assert.ok(r.variety.loop.harmony.verse.text && r.variety.loop.harmony.chorus.text && r.variety.loop.harmony.bridge.text, "per-block harmony present");
    assert.match(r.prompt, /one continuous /);
    assert.match(r.why, /loop: /);
  }
});

test("bridges loop in their template form and pair with the next vocal loop", () => {
  const pair = pickMusicalVariety({ mode: Mode.TAVERN, songIndex: 4, seed: 777 });
  const vocal = buildTrackRequest({ songIndex: 4, varietySeed: 777 });
  assert.equal(vocal.variety.styleId, pair.styleId);
  const bridge = buildBridgeRequest({ mode: Mode.TAVERN, bridgeIndex: 0, varietySeed: 1, pairVariety: pair });
  assert.equal(bridge.variety.styleId, vocal.variety.styleId, "bridge pre-hears the next song's style");
  assert.equal(bridge.keyScale, vocal.keyScale);
  assert.equal(bridge.loopHook, vocal.loopHook);
  assert.deepEqual(bridge.loopSections, vocal.loopSections);
  assert.match(bridge.prompt, /paired with the next vocal loop/);
  assert.match(bridge.prompt, /instrumental hook motif/);
  const solo = buildBridgeRequest({ mode: Mode.TAVERN, bridgeIndex: 0, varietySeed: 1 });
  assert.ok(solo.loopForm && solo.loopSections.length >= 4 && solo.loopHook, "unpaired bridges still carry a template loop");
  assert.match(solo.why, /loop: /);
  const plan = planLibraryTracks(4);
  assert.ok(plan.every((t) => t.loopForm && t.loopSections.length >= 4 && t.loopHook), "library plan carries loop forms and hooks");
});

test("fresh roll jokes use the actual fumble and never repeat a recent joke", () => {
  const f = extractFeatures([{ actor: "Bram", total: 99, target: 40, normalized: 0, isCrit: false, isFumble: true, flavor: "Climb" }], []);
  const j1 = freshRollJoke(f, { seed: 5, careers: { Bram: "Rat Catcher" } });
  assert.match(j1, /Bram the Rat Catcher/);
  assert.match(j1, /99/);
  const j2 = freshRollJoke(f, { seed: 5, recentJokes: [j1], careers: { Bram: "Rat Catcher" } });
  assert.notEqual(j2, j1, "same seed still skips the just-told joke");
  const bridge = buildBridgeRequest({ bridgeIndex: 2, varietySeed: 5, rolls: [{ actor: "Bram", total: 99, target: 40, normalized: 0, isCrit: false, isFumble: true, flavor: "Climb" }], recentJokes: [j1, j2] });
  assert.ok(bridge.joke && bridge.joke !== j1 && bridge.joke !== j2);
  assert.match(bridge.prompt, /chord progression/);
  assert.match(bridge.why, /style:/);
});
