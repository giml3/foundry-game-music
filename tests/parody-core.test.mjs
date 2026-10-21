import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { buildParodyPrompt, fetchParodyHealth, lyricSkeleton } from "../scripts/parody.js";
import { handleParody, solemnScore } from "../sidecar/parody-writer.mjs";

const SOURCE = [
  "[00:12.00]Shiny words on a silver line tonight",
  "Dancing under paper moons above",
  "",
  "Hold the lantern near my heart",
  "Every promise painted gold",
  "Silver bells on a midnight road",
  "Carry all my wishes home",
].join("\n");

test("parody prompts go solemn for dirges and recap for break ballads", () => {
  const skeleton = lyricSkeleton(SOURCE);
  const dirge = buildParodyPrompt({ skeleton, facts: ["DIED: Bram Stout the Rat Catcher (a skaven blade)"], party: [{ name: "Aria", career: "Soldier" }], enemies: [{ name: "Skaven", type: "npc" }], mode: "dirge" });
  assert.match(dirge, /solemn funeral dirge/);
  assert.match(dirge, /name the fallen exactly as written/);
  assert.match(dirge, /Bram Stout/);
  assert.doesNotMatch(dirge, /mock them mercilessly/, "dirges never mock the enemy");
  const brk = buildParodyPrompt({ skeleton, facts: ["Bram rolled three crits"], mode: "break" });
  assert.match(brk, /recap ballad/);
  assert.match(brk, /session highlights/);
  const tav = buildParodyPrompt({ skeleton, facts: ["FUMBLE: Bram rolled 99"], mode: "tavern" });
  assert.match(tav, /tavern parody song/);
  assert.match(tav, /dice facts into fresh jokes/);
});

test("solemnScore counts funeral themes only", () => {
  assert.ok(solemnScore(["grave", "heaven", "tears", "home"]) >= 4);
  assert.equal(solemnScore(["party", "dancing", "silver"]), 0);
  assert.equal(solemnScore([]), 0);
});

const SOLEMN = [
  "The grave is cold in winter rain",
  "And heaven hears the bell at night",
  "We carried him home through deep snow",
  "With tears upon the dark cold road",
  "",
  "The grave will keep him safe from war",
  "While heaven holds his weary soul",
  "We laid him home beneath the stone",
  "And tears fell soft on frozen earth",
  "",
  "No grave can hold a tale so bright",
  "For heaven keeps the songs we sang",
  "He walks the road beyond the night",
  "While tears give way to morning sky",
].join("\n");

function solemnDb() {
  const dir = mkdtempSync(join(tmpdir(), "bardic-parody-"));
  const db = new DatabaseSync(join(dir, "lrclib.sqlite3"));
  db.exec(`CREATE TABLE tracks (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, name_lower TEXT, artist_name TEXT, artist_name_lower TEXT, album_name TEXT, album_name_lower TEXT, duration FLOAT, last_lyrics_id INTEGER, created_at DATETIME, updated_at DATETIME);
CREATE TABLE lyrics (id INTEGER PRIMARY KEY AUTOINCREMENT, plain_lyrics TEXT, synced_lyrics TEXT, track_id INTEGER, has_plain_lyrics BOOLEAN, has_synced_lyrics BOOLEAN, instrumental BOOLEAN, source TEXT, created_at DATETIME, updated_at DATETIME, lyricsfile TEXT, has_lyricsfile BOOLEAN NOT NULL DEFAULT FALSE, has_word_sync BOOLEAN NOT NULL DEFAULT FALSE);`);
  const insL = db.prepare("INSERT INTO lyrics (plain_lyrics, track_id, has_plain_lyrics, instrumental) VALUES (?, ?, 1, 0)");
  const insT = db.prepare("INSERT INTO tracks (name, artist_name, duration, last_lyrics_id) VALUES (?, ?, ?, ?)");
  const lid = Number(insL.run(SOLEMN, 1).lastInsertRowid);
  insT.run("Solemn Fixture Song", "Fixture Bard", 200, lid);
  return db;
}

test("sidecar hunts a funeral-fit skeleton for dirges", async () => {
  const db = solemnDb();
  try {
    const out = await handleParody(db, { mode: "dirge", facts: ["DIED: Bram Stout the Rat Catcher"] }, {
      rng: () => 0,
      callLlm: async () => "[Verse 1]\nMorr keep the fallen in his garden still\nThe bell has tolled, the road is run\n[Chorus]\nGone and remembered evermore",
    });
    assert.match(out.fit, /funeral-fit skeleton/);
    assert.match(out.lyrics, /Morr keep the fallen/);
    const tav = await handleParody(db, { mode: "tavern", facts: ["FUMBLE: Bram rolled 99"] }, {
      rng: () => 0,
      callLlm: async () => "[Verse 1]\nGrim taxes ate the lantern light\n[Chorus]\nSing for the dice and doom",
    });
    assert.doesNotMatch(tav.fit ?? "", /funeral-fit/);
  } finally { db.close(); }
});

test("fetchParodyHealth answers true/false and never throws", async () => {
  assert.equal(await fetchParodyHealth({ baseUrl: "http://127.0.0.1:8123", fetchImpl: async () => ({ ok: true }) }), true);
  assert.equal(await fetchParodyHealth({ baseUrl: "http://127.0.0.1:8123", fetchImpl: async () => ({ ok: false }) }), false);
  assert.equal(await fetchParodyHealth({ baseUrl: "http://127.0.0.1:8123", fetchImpl: async () => { throw new Error("down"); } }), false);
  assert.equal(await fetchParodyHealth({ baseUrl: "" }), false);
});

test("dirges and break ballads sing the parody core too (no opt-in flag)", async () => {
  const { BardicPlayer } = await import("../scripts/player-engine.js");
  const { SessionLog } = await import("../scripts/session-log.js");
  const { buildDirgeRequest } = await import("../scripts/prompt-engine.js");
  const { aggregateBreakStats, buildBreakRequest, buildTemplateBallad } = await import("../scripts/recap.js");
  const cfg = { parodyBaseUrl: "http://127.0.0.1:8123", smallLlmEnabled: false, bawdy: "bawdy" };
  const player = new BardicPlayer({ sessionLog: new SessionLog([]), getConfig: () => cfg });
  const oldFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    seen.push(body);
    const lyrics = body.mode === "dirge"
      ? "[Verse 1]\nFresh dirge verse one\nFresh dirge verse two\nFresh dirge verse three\n[Chorus]\nFresh dirge chorus words\nFresh dirge chorus two\n[Verse 2]\nMore fresh dirge verse\nAnd another fresh line\nOne more fresh line\n[Chorus]\nFresh dirge chorus words\nFresh dirge chorus two\n[Verse 3]\nFinal fresh dirge verse\nLast fresh line here"
      : "[Verse 1]\nFresh ballad verse about Bram\nAnother fresh ballad line\nFresh ballad line three\n[Chorus]\nFresh chorus words here\nMore fresh chorus words";
    return { ok: true, json: async () => ({ lyrics, source: { trackId: 9 }, fit: "funeral-fit skeleton (solemn themes: grave)" }) };
  };
  try {
    const dirgeReq = buildDirgeRequest({ death: { actor: "Bram Stout", career: "Rat Catcher", cause: "a skaven blade" } });
    const dOut = await player.polishWithSmallLlm(dirgeReq, "dirge");
    assert.equal(seen.at(-1).mode, "dirge");
    assert.deepEqual(seen.at(-1).enemies, [], "dirges send no enemy to mock");
    assert.ok(seen.at(-1).facts.some((f) => /DIED: Bram Stout/.test(f)), "the death fact reaches the writer");
    assert.match(dOut.lyrics, /Bram Stout/, "the fallen is still named after the fit");
    assert.match(dOut.lyrics, /Fresh dirge verse one/);
    assert.equal(dOut.parodySource.trackId, 9);

    const stats = aggregateBreakStats([]);
    const ballad = buildTemplateBallad(stats);
    const breakReq = buildBreakRequest({ stats, lyrics: ballad.lyrics });
    assert.ok(Array.isArray(breakReq.parodyFacts) && breakReq.parodyFacts.length >= 1, "break requests carry parody facts");
    const bOut = await player.polishWithSmallLlm(breakReq, "break");
    assert.equal(seen.at(-1).mode, "break");
    assert.match(seen.at(-1).facts[0], /rolls tonight/);
    assert.equal(bOut.parodySource.trackId, 9);
    assert.match(bOut.why, /LRCLIB parody core/);
  } finally { globalThis.fetch = oldFetch; }
});
