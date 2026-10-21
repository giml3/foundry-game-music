#!/usr/bin/env node
// Bardic Dice mini-corpus builder.
// Harvests English-language songs (metadata + plain/synced lyrics) from the
// public LRCLIB search API, filters hard for English, and builds a compact
// sqlite database in EXACTLY the shape sidecar/parody-writer.mjs queries:
//   tracks(id, name, artist_name, album_name, duration, last_lyrics_id)
//   lyrics(id, track_id, plain_lyrics, synced_lyrics, instrumental)
//   pick: JOIN lyrics l ON l.id = t.last_lyrics_id,
//         plain_lyrics NOT NULL, instrumental = 0, length 100..8000.
//
// Raw harvests append to a staging JSONL so an interrupted run RESUMES
// (queries already done are skipped, tracks already seen are deduped).
// Usage: node harvest-corpus.mjs [--out PATH] [--target 20000] [--pace 800]
import { appendFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const argVal = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};
const OUT = argVal("out", "/Volumes/external/foundry-game-music/lrclib.sqlite3.new");
const STAGING = argVal("staging", "/tmp/lrclib-harvest.jsonl");
const TARGET = Number(argVal("target", "20000"));
const PACE = Number(argVal("pace", "800"));
const UA = "BardicDice/0.5 (personal hobby project; mini corpus builder)";
const stamp = () => new Date().toTimeString().slice(0, 8);
const say = (...a) => console.log(`[${stamp()}]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------- query vocabulary (song-title English) ----------------
const WORDS = [...new Set(("love heart night day light dark fire rain wind sky sea river road home town city girl boy man woman baby angel devil god heaven hell soul spirit ghost blood war battle soldier king queen gold silver stone dust ashes earth moon sun stars winter summer spring fall snow storm thunder dream sleep wake cry tears smile dance sing song music guitar freedom free wild young old run fly high low sweet blue black white red green golden broken lonely crazy beautiful tonight tomorrow yesterday forever never always away back down gone lost found hold keep give take make break shake burn turn stay leave come walk talk stand truth lies time life live die dead death grave tomb bell prayer lord father mother brother sister friend enemy stranger hero devil's hunter sailor captain cowboy rebel outlaw gypsy wanderer drifter preacher sinner saint whiskey wine smoke mirror shadow flame ember ocean mountain valley desert island bridge tower garden roses thorns crown throne sword shield arrow spear hammer anvil iron steel copper crystal diamond ruby pearl silk velvet leather lace honey sugar salt bitter poison medicine doctor fever pain pleasure sorrow joy hope faith grace mercy glory honor shame pride greed envy wrath sloth lust hunger thirst bread feast famine plague curse blessing miracle wonder mystery secret promise vow oath kiss touch skin bones flesh breath pulse vein scar wound heal hurt harm safe danger warning stranger danger thunder lightning hurricane earthquake volcano flood drought harvest seed flower tree leaf root branch wolf dog cat bird fish horse lion tiger bear snake spider butterfly bee moth raven crow eagle hawk dove sparrow robin wren lark nightingale mockingbird bluebird redbird blackbird phoenix dragon unicorn mermaid siren witch wizard warlock fairy elf dwarf giant troll goblin vampire werewolf zombie skeleton phantom wraith demon imp sprite pixie dryad nymph satyr centaur minotaur pegasus griffin chimera hydra kraken leviathan behemoth titan atlas hercules achilles odysseus perseus theseus icarus daedalus orpheus eurydice persephone hades zeus hera athena apollo artemis ares aphrodite hephaestus hermes dionysus demeter hestia poseidon").split(/\s+/))];
const PAIR_LEFT = ["love","heart","night","baby","girl","boy","man","woman","angel","fire","rain","road","river","sea","sky","moon","sun","star","dream","song","dance","rock","roll","blue","black","sweet","wild","young","free","good","bad","long","last","first","one","two","little","big","old","new","true","real","hard","easy","hot","cold","dark","light"];
const PAIR_RIGHT = ["love","heart","night","baby","girl","boy","man","woman","angel","fire","rain","road","river","sea","sky","moon","sun","star","dream","song","dance","blue","black","sweet","wild","young","free","good","bad","long","last","first","one","little","old","true","real","hard","hot","cold","dark"];

function buildQueries() {
  const qs = [];
  for (const w of WORDS) { qs.push(["track_name", w]); qs.push(["q", w]); qs.push(["artist_name", w]); }
  for (const a of PAIR_LEFT) for (const b of PAIR_RIGHT) if (a !== b) qs.push(["track_name", `${a} ${b}`]);
  // deterministic shuffle so an early stop still yields broad coverage
  let s = 1234567;
  const rnd = () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let i = qs.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [qs[i], qs[j]] = [qs[j], qs[i]]; }
  return qs;
}

// ---------------- English filter ----------------
const CORE = new Set(("the be to of and a in that it was for on are as with his they i at be this have from or one had by but not what all were we when your can said there use an each which she do how their will up other about out many then them these so some her would make like him into time has look two more write go see number no way could people my than first water been call who oil its now find long down day did get come made may part love live life heart night never know take feel good world man woman baby girl boy over such because through much before line right too means old any same tell follow came want show also around form three small set put end does another well large must big even such turned here why ask went men read need land different home us move try kind hand picture again change off play spell air away animal house point page letter mother answer found study still learn should world high every near add food between own below country plant last school father keep tree once head hard start city earth eye light thought head story saw far left few along might close something seem next open example begin always those both paper together got group often run don't oh quick").split(/\s+/));
const ANCHORS = ["the", "and", "you", "i", "to", "it", "my", "me", "we", "your"];
const DENY = new Set(("el la los las una unos unas que por para con del desde hasta entre sobre cuando donde porque tambien esta esto este como pero muy sin sus les des est dans qui une aux sur pas cette sont vous nous mon ma mes ton ta tes und die das der den ich nicht ein eine einen einem einer ist bin du er sie es wir ihr mein dein sein kein auch sich dem bei zu von mit nach über unter zwischen schon noch immer wieder sehr wenn als wie man wird werden wurde kann muss soll will doch nur le les lui leur cette ces était sont été aux après comme tout tous toute toutes della delle degli anche sono questo questa quello quelli molto dove quando perché perché sempre ancora ogni altro altra altri altra coisa você não meu minha seu sua são pelo pela pelos pelas com sem sob sobre entre depois antes quando onde porque também já foi era eram lhe lhes yang dan aku kau untuk dengan ini itu tidak akan dari pada dalam oleh juga sudah atau karena hanya saja bila lagi telah jadi bisa mau ingin maka yakni ialah sebuah para antara setelah sebelum setiap orang dalam").split(/\s+/));
const NON_LATIN = /[\u0370-\u03FF\u0400-\u04FF\u0530-\u058F\u0590-\u05FF\u0600-\u06FF\u0700-\u074F\u0900-\u097F\u0E00-\u0E7F\u10A0-\u10FF\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7AF]/g;

function englishCheck(lyrics) {
  const letters = lyrics.replace(/[^\p{L}]/gu, "");
  if (letters.length < 200) return { ok: false, why: "too few letters" };
  const nonLatin = (lyrics.match(NON_LATIN) || []).length;
  if (nonLatin / letters.length > 0.02) return { ok: false, why: "non-Latin script" };
  const tokens = lyrics.toLowerCase().replace(/[^\p{L}' ]/gu, " ").split(/\s+/).filter(Boolean);
  if (tokens.length < 40) return { ok: false, why: "too few words" };
  let core = 0, deny = 0; const distinct = new Set();
  for (const t of tokens) { if (CORE.has(t)) { core++; distinct.add(t); } if (DENY.has(t)) deny++; }
  const anchorHits = ANCHORS.filter((a) => tokens.includes(a)).length;
  if (anchorHits < 3) return { ok: false, why: `weak anchors (${anchorHits})` };
  if (core / tokens.length < 0.09 || distinct.size < 8) return { ok: false, why: `low English density (${(core / tokens.length).toFixed(2)}, ${distinct.size} distinct)` };
  if (deny > core * 0.35) return { ok: false, why: `foreign function words dominate (deny ${deny} vs core ${core})` };
  return { ok: true };
}

function cleanLyrics(raw) {
  const lines = String(raw).split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !/^\[[^\]]*\]$/.test(l));
  return lines.join("\n");
}

// ---------------- harvest (resumable) ----------------
const seenIds = new Set();
const doneQueries = new Set();
if (existsSync(STAGING)) {
  for (const line of readFileSync(STAGING, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try { const r = JSON.parse(line); if (r.__q) doneQueries.add(r.__q); else if (r.id != null) seenIds.add(String(r.id)); } catch { /* torn last line */ }
  }
  say(`Resuming: ${seenIds.size} tracks staged, ${doneQueries.size} queries already done.`);
}

const queries = buildQueries();
say(`Query plan: ${queries.length} searches, target ${TARGET} unique tracks, pace ${PACE}ms.`);
let done = 0, fetched = 0;
for (const [param, term] of queries) {
  if (seenIds.size >= TARGET) break;
  const key = `${param}=${term}`;
  if (doneQueries.has(key)) continue;
  const url = `https://lrclib.net/api/search?${param}=${encodeURIComponent(term)}`;
  let rows = null;
  for (let tryN = 0; tryN < 3 && rows === null; tryN++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(20000) });
      if (res.status === 429) { say("Rate-limited by LRCLIB — backing off 30s."); await sleep(30000); continue; }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      rows = await res.json();
    } catch (e) { if (tryN === 2) say(`query ${key} failed (${e.message}) — skipping`); else await sleep(3000); }
  }
  if (Array.isArray(rows)) {
    let fresh = 0;
    for (const r of rows) {
      if (!r || r.id == null || !r.plainLyrics || r.instrumental) continue;
      const id = String(r.id);
      if (seenIds.has(id)) continue;
      seenIds.add(id); fresh++;
      appendFileSync(STAGING, JSON.stringify({ id, name: r.trackName ?? r.name ?? "", artist: r.artistName ?? "", album: r.albumName ?? "", duration: r.duration ?? null, plain: r.plainLyrics, synced: r.syncedLyrics ?? null }) + "\n");
    }
    fetched += fresh;
  }
  appendFileSync(STAGING, JSON.stringify({ __q: key }) + "\n");
  done++;
  if (done % 100 === 0) say(`progress: ${done} queries run, ${seenIds.size} unique tracks staged (${fetched} new this run)`);
  await sleep(PACE);
}
say(`Harvest complete: ${seenIds.size} unique tracks staged.`);

// ---------------- filter + build ----------------
const best = new Map();
for (const line of readFileSync(STAGING, "utf8").split("\n")) {
  if (!line.trim()) continue;
  let r; try { r = JSON.parse(line); } catch { continue; }
  if (!r || r.__q || r.id == null) continue;
  const key = `${String(r.name).toLowerCase().trim()}|${String(r.artist).toLowerCase().trim()}`;
  if (!best.has(key)) best.set(key, r);
}
say(`After title/artist dedupe: ${best.size} tracks.`);
const rejected = {};
const accepted = [];
for (const r of best.values()) {
  const plain = cleanLyrics(r.plain ?? "");
  if (plain.length < 100 || plain.length > 8000) { rejected.length = (rejected.length ?? 0) + 1; continue; }
  if (/karaoke/i.test(`${r.name} ${r.artist}`)) { rejected.karaoke = (rejected.karaoke ?? 0) + 1; continue; }
  const chk = englishCheck(plain);
  if (!chk.ok) { const k = chk.why.split(" (")[0]; rejected[k] = (rejected[k] ?? 0) + 1; continue; }
  accepted.push({ ...r, plain });
}
say(`English + quality filter: ${accepted.length} accepted. Rejections: ${JSON.stringify(rejected)}`);
if (accepted.length < 3000) { say(`FATAL: only ${accepted.length} usable tracks — below the 3000 floor. Database NOT built.`); process.exit(2); }
// shuffle for uniform random picks, then renumber densely
let s2 = 987654321;
const rnd2 = () => (s2 = (s2 * 1103515245 + 12345) % 2147483648) / 2147483648;
for (let i = accepted.length - 1; i > 0; i--) { const j = Math.floor(rnd2() * (i + 1)); [accepted[i], accepted[j]] = [accepted[j], accepted[i]]; }
rmSync(OUT, { force: true });
const db = new DatabaseSync(OUT);
db.exec(`CREATE TABLE tracks (id INTEGER PRIMARY KEY, name TEXT, artist_name TEXT, album_name TEXT, duration REAL, last_lyrics_id INTEGER);
CREATE TABLE lyrics (id INTEGER PRIMARY KEY, track_id INTEGER, plain_lyrics TEXT, synced_lyrics TEXT, instrumental INTEGER DEFAULT 0);
CREATE INDEX idx_lyrics_track_id ON lyrics(track_id);`);
const insT = db.prepare("INSERT INTO tracks (id, name, artist_name, album_name, duration, last_lyrics_id) VALUES (?, ?, ?, ?, ?, ?)");
const insL = db.prepare("INSERT INTO lyrics (id, track_id, plain_lyrics, synced_lyrics, instrumental) VALUES (?, ?, ?, ?, 0)");
db.exec("BEGIN");
accepted.forEach((r, i) => { const id = i + 1; insT.run(id, r.name, r.artist, r.album ?? null, typeof r.duration === "number" ? r.duration : null, id); insL.run(id, id, r.plain, r.synced ?? null); });
db.exec("COMMIT");
const n = db.prepare("SELECT COUNT(*) AS n FROM tracks").get().n;
db.close();
say(`BUILT ${OUT}: ${n} tracks.`);
