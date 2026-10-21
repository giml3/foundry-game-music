import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { buildParodyPrompt, fetchParodySong, lyricSkeleton, screenParodyLyrics, syllableCount } from "../scripts/parody.js";
import { handleParody, pickRandomTrack } from "../sidecar/parody-writer.mjs";

const SOURCE = [
  "[00:12.00]Shiny words on a silver line tonight",
  "Dancing under paper moons above",
  "",
  "Hold the lantern near my heart",
  "Every promise painted gold",
  "Silver bells on a midnight road",
  "Carry all my wishes home",
].join("\n");

test("skeleton keeps stanza shape, syllables and rhyme — never the words", () => {
  const sk = lyricSkeleton(SOURCE);
  assert.equal(sk.stanzas.length, 2);
  assert.equal(sk.lineCount, 6);
  assert.ok(sk.stanzas[0].syllables.every((n) => n >= 4), "syllable counts per line");
  assert.match(sk.stanzas[0].scheme, /^[A-Z-]+$/);
  assert.equal(syllableCount("Morr"), 1);
  const prompt = buildParodyPrompt({ skeleton: sk, facts: ["CRITICAL: Bram rolled 99 vs 40"] });
  assert.match(prompt, /Stanza 1: 2 lines, syllables/);
  assert.match(prompt, /Bram rolled 99/);
  assert.doesNotMatch(prompt, /Shiny words|silver line|paper moons/, "source wording never reaches the LLM");
});

test("screen refuses any parody sharing a line or 5-word run with the source", () => {
  const fresh = "[Verse 1]\nGrim taxes ate the lantern light\n[Chorus]\nSing for the dice and doom";
  assert.equal(screenParodyLyrics(fresh, SOURCE), fresh);
  assert.equal(screenParodyLyrics("[Verse]\nShiny words on a silver line tonight\nmore fresh words here now", SOURCE), null, "copied line refused");
  assert.equal(screenParodyLyrics("[Verse]\nwe took shiny words on a silver line out\nmore fresh words here now", SOURCE), null, "shared 5-word run refused");
  assert.equal(screenParodyLyrics("", SOURCE), null);
});

test("fetchParodySong posts the dice facts and returns screened lyrics", async () => {
  let seen = null;
  const fetchImpl = async (url, opts) => {
    seen = { url, body: JSON.parse(opts.body) };
    return { ok: true, json: async () => ({ lyrics: "[Verse 1]\nFresh parody words", source: { trackId: 7 } }) };
  };
  const out = await fetchParodySong({ baseUrl: "http://127.0.0.1:8123/", fetchImpl, payload: { facts: ["FUMBLE: Bram rolled 99"] } });
  assert.equal(seen.url, "http://127.0.0.1:8123/parody");
  assert.match(seen.body.facts[0], /Bram/);
  assert.match(out.lyrics, /Fresh parody/);
  assert.equal(out.source.trackId, 7);
  await assert.rejects(fetchParodySong({ baseUrl: "http://127.0.0.1:8123", fetchImpl: async () => ({ ok: false, status: 502 }) }), /HTTP 502/);
});

function fixtureDb() {
  const dir = mkdtempSync(join(tmpdir(), "bardic-parody-"));
  const db = new DatabaseSync(join(dir, "lrclib.sqlite3"));
  db.exec(`CREATE TABLE tracks (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, name_lower TEXT, artist_name TEXT, artist_name_lower TEXT, album_name TEXT, album_name_lower TEXT, duration FLOAT, last_lyrics_id INTEGER, created_at DATETIME, updated_at DATETIME);
CREATE TABLE lyrics (id INTEGER PRIMARY KEY AUTOINCREMENT, plain_lyrics TEXT, synced_lyrics TEXT, track_id INTEGER, has_plain_lyrics BOOLEAN, has_synced_lyrics BOOLEAN, instrumental BOOLEAN, source TEXT, created_at DATETIME, updated_at DATETIME, lyricsfile TEXT, has_lyricsfile BOOLEAN NOT NULL DEFAULT FALSE, has_word_sync BOOLEAN NOT NULL DEFAULT FALSE);`);
  const insL = db.prepare("INSERT INTO lyrics (plain_lyrics, track_id, has_plain_lyrics, instrumental) VALUES (?, ?, 1, 0)");
  const insT = db.prepare("INSERT INTO tracks (name, artist_name, duration, last_lyrics_id) VALUES (?, ?, ?, ?)");
  const lid = Number(insL.run(SOURCE, 1).lastInsertRowid);
  insT.run("Synthetic Fixture Song", "Fixture Bard", 210, lid);
  const lid2 = Number(insL.run("[Instrumental]", 2).lastInsertRowid);
  insT.run("Instrumental Fixture", "Fixture Bard", 100, lid2);
  return db;
}

test("sidecar picks a random lyric-bearing song and serves a screened parody", async () => {
  const db = fixtureDb();
  try {
    const track = pickRandomTrack(db, () => 0);
    assert.equal(track.name, "Synthetic Fixture Song", "instrumental/short rows are skipped");
    const out = await handleParody(db, { facts: ["CRITICAL: Bram rolled 11 vs 55"], loopSections: ["Verse 1", "Chorus"], loopHook: "hook line here" }, {
      rng: () => 0,
      callLlm: async (prompt) => {
        assert.doesNotMatch(prompt, /Shiny words/, "LLM only ever sees the skeleton");
        return "[Verse 1]\nBram the bold rolled eleven bright\n[Chorus]\nhook line here";
      },
    });
    assert.match(out.lyrics, /Bram the bold/);
    assert.equal(out.source.trackId, track.id);
    await assert.rejects(
      handleParody(db, {}, { rng: () => 0, callLlm: async () => "Shiny words on a silver line tonight\nDancing under paper moons above\nHold the lantern near my heart\nEvery promise painted gold" }),
      /echoed its source/,
      "a draft copying the source is refused, never served",
    );
  } finally { db.close(); }
});

function fitFixtureDb() {
  const dir = mkdtempSync(join(tmpdir(), "bardic-fit-"));
  const db = new DatabaseSync(join(dir, "lrclib.sqlite3"));
  db.exec(`CREATE TABLE tracks (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, name_lower TEXT, artist_name TEXT, artist_name_lower TEXT, album_name TEXT, album_name_lower TEXT, duration FLOAT, last_lyrics_id INTEGER, created_at DATETIME, updated_at DATETIME);
CREATE TABLE lyrics (id INTEGER PRIMARY KEY AUTOINCREMENT, plain_lyrics TEXT, synced_lyrics TEXT, track_id INTEGER, has_plain_lyrics BOOLEAN, has_synced_lyrics BOOLEAN, instrumental BOOLEAN, source TEXT, created_at DATETIME, updated_at DATETIME, lyricsfile TEXT, has_lyricsfile BOOLEAN NOT NULL DEFAULT FALSE, has_word_sync BOOLEAN NOT NULL DEFAULT FALSE);`);
  const insL = db.prepare("INSERT INTO lyrics (plain_lyrics, track_id, has_plain_lyrics, instrumental) VALUES (?, ?, 1, 0)");
  const insT = db.prepare("INSERT INTO tracks (name, artist_name, duration, last_lyrics_id) VALUES (?, ?, ?, ?)");
  const rats = ["Rats in the sewer, rats in the dark tonight", "Rats and the plague run under the floor", "", "Rats gnaw the tunnels, rats steal the grain", "Rats in the walls of the rotten old town"].join("\n");
  const sea = ["Sails on the water, sails in the wind tonight", "Sails and the storm run over the wave", "", "Sails fill with thunder, sails steal the rain", "Sails on the tide of the rolling old sea"].join("\n");
  insT.run("Sewer Song", "Fixture Bard", 200, Number(insL.run(rats, 1).lastInsertRowid));
  insT.run("Sail Song", "Fixture Bard", 200, Number(insL.run(sea, 2).lastInsertRowid));
  return db;
}

test("the lyric LLM picks the skeleton fitting the party and the enemy", async () => {
  const db = fitFixtureDb();
  const seq = [0.1, 0.9];
  let i = 0;
  const rng = () => seq[i++ % seq.length];
  try {
    const party = [{ name: "Bram", career: "Rat Catcher" }];
    const enemies = [{ name: "Skaven", type: "npc" }];
    const pickedByLlm = await handleParody(db, { party, enemies, mode: "combat" }, {
      rng,
      callLlm: async (prompt) => {
        if (prompt.includes("Pick the ONE")) {
          assert.match(prompt, /Bram the Rat Catcher/);
          assert.match(prompt, /Skaven/);
          const line = prompt.split("\n").find((l) => /\brats\b/.test(l) && /^\d+:/.test(l));
          return line.match(/^(\d+):/)[1];
        }
        return "[Verse 1]\nBram faced the rats below the town\n[Chorus]\nSing hey for the dice";
      },
    });
    assert.equal(pickedByLlm.source.name, "Sewer Song", "rat-catcher vs Skaven fits the sewer skeleton");
    assert.match(pickedByLlm.fit, /lyric LLM picked/);
    i = 0;
    const pickedLocally = await handleParody(db, { party, enemies, mode: "combat" }, {
      rng,
      callLlm: async (prompt) => {
        if (prompt.includes("Pick the ONE")) throw new Error("llm down");
        return "[Verse 1]\nBram faced the rats below the town\n[Chorus]\nSing hey for the dice";
      },
    });
    assert.equal(pickedLocally.source.name, "Sewer Song", "local theme scoring fits the same song when the LLM is down");
  } finally { db.close(); }
});

test("the player sends the actual party and hostile combatants for fitting", async () => {
  const { BardicPlayer } = await import("../scripts/player-engine.js");
  const { SessionLog } = await import("../scripts/session-log.js");
  const player = new BardicPlayer({ sessionLog: new SessionLog([]), getConfig: () => ({}) });
  const oldGame = globalThis.game;
  globalThis.game = {
    actors: [
      { name: "Bram", type: "character", currentCareer: { name: "Rat Catcher" }, items: [] },
      { name: "Aria", type: "character", currentCareer: { name: "Soldier" }, items: [] },
      { name: "Skaven", type: "npc", items: [] },
    ],
    combat: { combatants: [
      { actor: { name: "Bram", type: "character" }, token: { disposition: 1 } },
      { actor: { name: "Skaven", type: "npc" }, token: { disposition: -1 } },
      { actor: { name: "Town Guard", type: "npc" }, token: { disposition: 0 } },
    ] },
  };
  try {
    const { party, enemies } = player.partyContext();
    assert.deepEqual(party, [{ name: "Bram", career: "Rat Catcher" }, { name: "Aria", career: "Soldier" }]);
    assert.deepEqual(enemies, [{ name: "Skaven", type: "npc" }], "only hostile combatants count as the enemy");
  } finally { globalThis.game = oldGame; }
});

test("the bards sing the sidecar parody, screened into the loop blocks", async () => {
  const { BardicPlayer } = await import("../scripts/player-engine.js");
  const { SessionLog } = await import("../scripts/session-log.js");
  const { buildTrackRequest } = await import("../scripts/prompt-engine.js");
  const req = buildTrackRequest({ rolls: [{ actor: "Bram", total: 99, target: 40, normalized: 0, isCrit: false, isFumble: true, flavor: "Climb" }] });
  const fresh = req.loopSections.map((s) => s === "Chorus" ? `[Chorus]\n${req.loopHook}\nMourn and laugh at doom` : s === "Intro" || s === "Instrumental" || s === "Drop" ? `[${s}]` : `[${s}]\nFresh parody verse about Bram`).join("\n");
  const cfg = { parodyEnabled: true, parodyBaseUrl: "http://127.0.0.1:8123", smallLlmEnabled: false, bawdy: "bawdy" };
  const player = new BardicPlayer({ sessionLog: new SessionLog([]), getConfig: () => cfg });
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.match(String(url), /127\.0\.0\.1:8123\/parody/);
    return { ok: true, json: async () => ({ lyrics: fresh, source: { trackId: 42 } }) };
  };
  try {
    const out = await player.polishWithSmallLlm(req, "tavern");
    assert.match(out.lyrics, /Fresh parody verse about Bram/);
    assert.equal(out.parodySource.trackId, 42);
    assert.match(out.why, /LRCLIB parody.*skeleton #42/);
    const work = player.workLog.map((w) => `${w.actor}:${w.text}`).join("\n");
    assert.match(work, /parody:hunting a skeleton/, "sidebar work log records the hunt");
    assert.ok(player.status().work.some((w) => /Party:/.test(w.detail)), "work entries carry the evidence for the sidebar");
  } finally { globalThis.fetch = oldFetch; }
  globalThis.fetch = async () => { throw new Error("down"); };
  try {
    const out = await player.polishWithSmallLlm(req, "tavern");
    assert.equal(out, req, "dead parody sidecar keeps the template words");
    assert.ok(player._parodyCooldownUntil > Date.now(), "failure arms the parody cooldown");
  } finally { globalThis.fetch = oldFetch; }
});
