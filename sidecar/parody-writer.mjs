#!/usr/bin/env node
// Bardic Dice parody writer: serves screened LRCLIB-skeleton parodies.
//
// Picks a random song from a local LRCLIB dump, reduces its lyrics to a
// structural skeleton (stanzas / syllables / rhyme scheme — never the
// words), asks the purpose-built tiny LLM (Ollama, default llama3.2:1b)
// for an original grimdark parody on that skeleton plus the table's dice
// facts, then screens the result against the source lyrics (no shared
// line, no shared 5-word run) before returning it. Source lyrics never
// leave this machine; rejected drafts are retried once, then refused.
//
// One-time setup (the dump is large — check disk space first):
//   gzip -dc lrclib-db-dump-20261012T090639Z.sqlite3.gz > lrclib.sqlite3
// Run:
//   node sidecar/parody-writer.mjs --db lrclib.sqlite3 [--port 8123]
//   PARODY_DB=lrclib.sqlite3 node sidecar/parody-writer.mjs
// The module treats this writer as its core lyric writer (v0.5.0) —
// start-all.sh launches it automatically when the database is present.
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { buildFitPrompt, buildParodyPrompt, lyricSkeleton, scoreCandidateFit, screenParodyLyrics, themeTagsOf } from "../scripts/parody.js";
import { SMALL_LLM_SYSTEM, fetchSmallLlmText } from "../scripts/llm-writer.js";

const argVal = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};

/** Random track with usable plain lyrics, probing from random ids (fast on huge dumps). */
export function pickRandomTrack(db, rng = Math.random) {
  const max = db.prepare("SELECT MAX(id) AS m FROM tracks").get()?.m ?? 0;
  if (!max) return null;
  const stmt = db.prepare(`
    SELECT t.id AS id, t.name AS name, t.artist_name AS artist, t.duration AS duration, l.plain_lyrics AS lyrics
    FROM tracks t JOIN lyrics l ON l.id = t.last_lyrics_id
    WHERE t.id >= ? AND l.plain_lyrics IS NOT NULL AND COALESCE(l.instrumental, 0) = 0
      AND length(l.plain_lyrics) BETWEEN 100 AND 8000
    ORDER BY t.id LIMIT 1`);
  for (let attempt = 0; attempt < 40; attempt++) {
    const row = stmt.get(1 + Math.floor(rng() * max));
    if (row?.lyrics) return row;
  }
  return null;
}

/** A pool of random lyric-bearing candidates to fit against party + enemy. */
export function collectCandidates(db, rng = Math.random, count = 12) {
  const seen = new Set();
  const pool = [];
  for (let attempt = 0; attempt < 80 && pool.length < count; attempt++) {
    const track = pickRandomTrack(db, rng);
    if (!track || seen.has(track.id)) continue;
    seen.add(track.id);
    const skeleton = lyricSkeleton(track.lyrics);
    if (!skeleton.lineCount) continue;
    pool.push({ track, skeleton, tags: themeTagsOf(track.lyrics), stanzas: skeleton.stanzas.length, avgSyllables: skeleton.avgSyllables });
  }
  return pool;
}

/**
 * Choose the candidate whose themes fit the party/enemy: the tiny LLM
 * picks from tag descriptors, with a local overlap score as fallback.
 * Returns { pick, fitReason }.
 */
export async function chooseFit(pool, body = {}, { callLlm } = {}) {
  const party = Array.isArray(body.party) ? body.party.slice(0, 8) : [];
  const enemies = Array.isArray(body.enemies) ? body.enemies.slice(0, 8) : [];
  const scored = pool.map((c) => ({ c, score: scoreCandidateFit(c, party, enemies) }));
  const bestLocal = scored.reduce((a, b) => (b.score > a.score ? b : a), scored[0]);
  if (callLlm && pool.length > 1 && (party.length || enemies.length)) {
    try {
      const raw = await callLlm(buildFitPrompt({ candidates: pool, party, enemies, mode: body.mode ?? "tavern" }));
      const idx = Number.parseInt(String(raw).match(/\d+/)?.[0] ?? "", 10);
      if (Number.isInteger(idx) && pool[idx]) {
        return { pick: pool[idx], fitReason: `lyric LLM picked skeleton for ${party.map((p) => p.name).filter(Boolean).join(", ") || "the party"}${enemies.length ? ` vs ${enemies.map((p) => p.name).filter(Boolean).join(", ")}` : ""}` };
      }
    } catch { /* fall through to the local score */ }
  }
  return {
    pick: bestLocal.c,
    fitReason: bestLocal.score > 0
      ? `theme fit for ${party.map((p) => p.name).filter(Boolean).join(", ") || "the party"}${enemies.length ? ` vs ${enemies.map((p) => p.name).filter(Boolean).join(", ")}` : ""}`
      : "random skeleton (no theme fit found)",
  };
}

/** Themes that make a skeleton funeral-fit for a dirge. */
export const SOLEMN_TAGS = new Set(["death", "dead", "die", "dying", "grave", "graves", "gone", "farewell", "goodbye", "angel", "angels", "heaven", "home", "rest", "sleep", "tears", "cry", "mother", "father", "sailor", "sea", "river", "winter", "snow", "rain", "night", "dark", "cold", "stone", "bell", "bells", "prayer", "amen", "lord", "soul", "spirit", "ghost", "memory", "remember", "lost", "fall", "fallen", "blood", "war", "soldier", "battle", "road", "dust", "ashes", "earth", "sky", "stars", "moon"]);

export function solemnScore(tags = []) {
  return tags.reduce((n, t) => n + (SOLEMN_TAGS.has(String(t).toLowerCase()) ? 1 : 0), 0);
}

/** One screened parody. `callLlm(prompt)` is injectable for tests. */
export async function handleParody(db, body = {}, { callLlm, rng = Math.random } = {}) {
  const party = Array.isArray(body.party) ? body.party.slice(0, 8) : [];
  const enemies = Array.isArray(body.enemies) ? body.enemies.slice(0, 8) : [];
  const mode = body.mode ?? "tavern";
  const pool = collectCandidates(db, rng, mode === "dirge" ? 24 : (party.length || enemies.length ? 12 : 1));
  if (!pool.length) throw new Error("No usable song found in the LRCLIB dump");
  let pick = null;
  let fitReason = null;
  if (mode === "dirge") {
    const ranked = pool.map((c) => ({ c, s: solemnScore(c.tags) })).sort((a, b) => b.s - a.s);
    if (ranked[0]?.s > 0) {
      pick = ranked[0].c;
      fitReason = `funeral-fit skeleton (solemn themes: ${pick.tags.filter((t) => SOLEMN_TAGS.has(String(t).toLowerCase())).slice(0, 4).join(", ")})`;
    }
  }
  if (!pick) ({ pick, fitReason } = await chooseFit(pool, body, { callLlm }));
  const track = pick.track;
  const skeleton = pick.skeleton;
  if (!skeleton.lineCount) throw new Error("Picked song has no usable lyric skeleton");
  const prompt = buildParodyPrompt({
    skeleton,
    facts: Array.isArray(body.facts) ? body.facts.slice(0, 8) : [],
    storyLines: Array.isArray(body.storyLines) ? body.storyLines.slice(0, 5) : [],
    bardLabel: body.bardLabel ?? "", bawdy: body.bawdy ?? "bawdy",
    styleId: body.styleId ?? "", keyScale: body.keyScale ?? "",
    loopSections: Array.isArray(body.loopSections) ? body.loopSections.slice(0, 12) : [],
    loopHook: body.loopHook ?? "",
    party, enemies, mode: body.mode ?? "tavern",
  });
  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await callLlm(attempt ? `${prompt}\nYour previous draft echoed its source — invent every line from scratch.` : prompt);
    const screened = screenParodyLyrics(raw, track.lyrics, null);
    if (screened) {
      return {
        lyrics: screened,
        source: { trackId: track.id, name: track.name ?? null, artist: track.artist ?? null, duration: track.duration ?? null },
        skeleton: { stanzas: skeleton.stanzas.length, lines: skeleton.lineCount, avgSyllables: skeleton.avgSyllables },
        fit: fitReason,
        candidates: pool.length,
      };
    }
  }
  throw new Error("Parody draft echoed its source twice — refused");
}

function resolveDbPath() {
  const wanted = argVal("db", process.env.PARODY_DB ?? "");
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [wanted, join(process.cwd(), "lrclib.sqlite3"), join(here, "..", "lrclib.sqlite3")].filter(Boolean);
  for (const p of candidates) if (existsSync(p)) return p;
  console.error("LRCLIB database not found. Decompress the dump once (check disk space — it is large):");
  console.error("  gzip -dc lrclib-db-dump-20261012T090639Z.sqlite3.gz > lrclib.sqlite3");
  console.error("then: node sidecar/parody-writer.mjs --db lrclib.sqlite3");
  process.exit(1);
}

function main() {
  const dbPath = resolveDbPath();
  if (dbPath.endsWith(".gz")) {
    console.error(`${dbPath} is still gzipped — decompress it first: gzip -dc "${dbPath}" > lrclib.sqlite3`);
    process.exit(1);
  }
  const port = Number(argVal("port", process.env.PARODY_PORT ?? "8123"));
  const ollama = {
    baseUrl: argVal("ollama", process.env.PARODY_OLLAMA ?? "http://127.0.0.1:11434/v1"),
    apiKey: process.env.PARODY_LLM_KEY ?? "",
    model: argVal("model", process.env.PARODY_LLM_MODEL ?? "llama3.2:1b"),
  };
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const callLlm = (prompt) => fetchSmallLlmText({ ...ollama, prompt, system: SMALL_LLM_SYSTEM, maxTokens: 700, timeoutMs: 60000 });
  const server = createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
    const send = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
    try {
      if (req.method === "GET" && req.url === "/health") {
        const n = db.prepare("SELECT COUNT(*) AS n FROM tracks").get()?.n ?? 0;
        send(200, { ok: true, db: dbPath, tracks: n, model: ollama.model });
        return;
      }
      if (req.method === "POST" && req.url === "/parody") {
        let raw = "";
        for await (const chunk of req) { raw += chunk; if (raw.length > 65536) throw new Error("Request too large"); }
        const out = await handleParody(db, raw ? JSON.parse(raw) : {}, { callLlm });
        console.log(`parody: track #${out.source.trackId} (${out.skeleton.stanzas} stanzas) screened and served`);
        send(200, out);
        return;
      }
      send(404, { error: "not found" });
    } catch (e) {
      send(502, { error: String(e?.message ?? e) });
    }
  });
  server.listen(port, "127.0.0.1", () => console.log(`Bardic Dice parody writer on http://127.0.0.1:${port} (db: ${dbPath}, model: ${ollama.model})`));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
