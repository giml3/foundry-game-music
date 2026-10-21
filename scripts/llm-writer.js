// Super-small local LLM (default llama3.2:1b via Ollama) that rewrites the
// template verses/jokes fresh for THIS song. It only ever receives roll
// facts (names, careers, totals, styles) — never raw chat, and never any
// existing song text. Every failure falls back to the template words.
import { fallenLabel, hashSeed } from "./prompt-engine.js";

export const SMALL_LLM_SYSTEM = [
  "You are a grimdark tavern bard writing ORIGINAL parody songs for a Warhammer-style game.",
  "Parody the *conventions* of a style only: never copy, quote, rewrite, translate or closely imitate any existing song's lyrics, title, hook, chorus or melody, and never name a real song, band or artist.",
  "Everything is grimdark gallows humour: plague, Morr, gallows, mud, taxes, doom — with jokes to lighten it.",
  "BANNED cosy tavern clichés — never write them: creaking floorboards, flowing/rich/strong ale, raised mugs, clinking tankards, roaring hearths, the winking barmaid. If a draft you are given uses them, replace them.",
  "Draw each song's images fresh from the grimdark world instead — plague carts, Morr's garden, gallows fruit, witch hunters, rats, pox scars, drowned roads, doomstones, unpaid debts, corpse tolls — and never use the same image twice in one song.",
  "Write in English only — every word of every line. No German, French or any other language, even for flavour (Warhammer proper names like Sigmar, Morr and Altdorf are fine).",
  "Jokes must punch at dice rolls, careers/roles and fate, never at real people. Invent every line fresh.",
].join(" ");

const clip = (s, n) => String(s ?? "").slice(0, n);

export function rollFactsForPrompt(features = {}, careers = null) {
  const facts = [];
  const who = (d) => (careers?.[d.actor] ? `${d.actor} the ${careers[d.actor]}` : d.actor);
  for (const d of features.critDetails ?? []) facts.push(`CRITICAL: ${who(d)} rolled ${d.total ?? "?"}${d.target != null ? ` vs ${d.target}` : ""}${d.flavor ? ` (${clip(d.flavor, 40)})` : ""}`);
  for (const d of features.fumbleDetails ?? []) facts.push(`FUMBLE: ${who(d)} rolled ${d.total ?? "?"}${d.target != null ? ` vs ${d.target}` : ""}${d.flavor ? ` (${clip(d.flavor, 40)})` : ""}`);
  for (const w of features.wounds ?? []) facts.push(`CRITICAL WOUND: ${w.actor} took ${clip(w.name, 40)}${w.location ? ` to the ${w.location}` : ""}`);
  for (const d of features.deaths ?? []) facts.push(`DIED: ${fallenLabel(d)}`);
  if (features.keywords?.length) facts.push(`Table keeps mentioning: ${features.keywords.slice(0, 4).join(", ")}`);
  return facts;
}

export function buildLyricPrompt({ fallbackLyrics = "", kind = "song", styleId = "", keyScale = "", progression = "", bardLabel = "", facts = [], storyLines = [], recentLines = [], recentJokes = [], bawdy = "bawdy", loopSections = [], loopHook = "" } = {}) {
  return [
    `Rewrite these draft lyrics as a fresh original ${kind === "dirge" ? "funeral dirge (solemn; at most one wry line, no mockery of the dead)" : "grimdark comedy parody song"}.`,
    `Style: ${clip(styleId, 40) || "tavern folk"} in ${clip(keyScale, 20)} (${clip(progression, 60)}), sung by the ${clip(bardLabel, 60) || "bard"}. Bawdy level: ${bawdy} (clean = family-friendly).`,
    "Keep the [Verse]/[Chorus]/[Instrumental] markers and every named character. Keep it singable: short rhymed lines, under 24 lines.",
    "No stock tavern imagery: no creaking floorboards, ale, mugs, tankards or hearths anywhere — swap any in the draft for fresh grimdark images (plague, Morr, gallows, mud, rats, witch hunters, debts, doom) and use a different image in every verse.",
    "English only: write every line in English — no German, French or other languages, even for flavour.",
    loopSections.length ? `Preserve the loop blocks exactly: same section tags in the same order and count (${loopSections.map((s) => `[${s}]`).join(" ")}), including any " - Male Bard" / " - Female Bard" / " - Both Bards" qualifiers. Rewrite only the verse words inside each block.` : "",
    loopHook ? `Keep this chorus hook word-for-word in every [Chorus]: "${clip(loopHook, 160)}"` : "",
    facts.some((f) => /^CRITICAL:/.test(f)) ? "CRITICAL CALLOUT (mandatory): shout every CRITICAL fact — include a line beginning \"Critical!\" naming the hero and their roll. Criticals must never pass unremarked." : "",
    facts.length ? `Work THESE true dice facts into fresh jokes (do not invent other heroes):\n${facts.map((f) => `- ${f}`).join("\n")}` : "No big rolls lately: joke about dice, fate, taxes and Morr generally.",
    storyLines.length ? `Long-term saga (all-time stats — drop at most one callback):\n${storyLines.slice(0, 7).map((l) => `- ${clip(l, 140)}`).join("\n")}` : "",
    recentLines.length ? `Never reuse or lightly reword these recently sung lines:\n${recentLines.slice(-12).map((l) => `- ${clip(l, 120)}`).join("\n")}` : "",
    recentJokes.length ? `Never reuse these recent jokes or their punchlines:\n${recentJokes.slice(-8).map((l) => `- ${clip(l, 120)}`).join("\n")}` : "",
    `Draft:\n${clip(fallbackLyrics, 1800)}`,
    "Return ONLY the rewritten lyrics.",
  ].filter(Boolean).join("\n");
}

export function buildJokePrompt({ facts = [], storyLines = [], recentJokes = [], bardLabel = "" } = {}) {
  return [
    `Invent ONE fresh one-line grimdark tavern joke in English (spoken by the ${clip(bardLabel, 60) || "bard"}) about dice rolls and careers; under 180 characters, no quotes around it.`,
    facts.length ? `Base it on a true fact if you can:\n${facts.map((f) => `- ${f}`).join("\n")}` : "No notable rolls: joke about dice, fate, taxes, Morr or the watch.",
    storyLines.length ? `Or needle a long-term legend: ${clip(storyLines.slice(0, 3).join("; "), 240)}` : "",
    recentJokes.length ? `Do NOT reuse these jokes or their punchlines:\n${recentJokes.slice(-10).map((l) => `- ${clip(l, 120)}`).join("\n")}` : "",
    "Return ONLY the joke line.",
  ].filter(Boolean).join("\n");
}

const VOCAL_TAGS = new Set(["male vocal", "female vocal", "duet"]);
export function sectionTagsOf(lyrics) {
  return [...String(lyrics ?? "").matchAll(/\[([^\]]+)\]/g)].map((m) => m[1].split(" - ")[0].trim()).filter((t) => !VOCAL_TAGS.has(t.toLowerCase()));
}
export function sanitizeLlmLyrics(text, fallback = "", { mustMention = null, loopSections = [], loopHook = "" } = {}) {
  let out = String(text ?? "").replace(/```[a-z]*\n?/gi, "").trim();
  out = out.split("\n").map((l) => l.trimEnd()).join("\n");
  const lines = out.split("\n").filter((l) => l.trim());
  if (lines.length < 4 || out.length > 2600 || /https?:\/\//i.test(out)) return fallback;
  if (!/\[(Verse|Chorus)/i.test(out)) return fallback;
  if (mustMention && !out.includes(mustMention)) return fallback;
  if (loopSections.length) {
    const got = sectionTagsOf(out);
    if (got.length !== loopSections.length || got.some((t, i) => t.toLowerCase() !== String(loopSections[i]).toLowerCase())) return fallback;
  }
  if (loopHook && !out.includes(loopHook)) return fallback;
  return out;
}

const sungLinesOf = (text) => String(text ?? "").replace(/```[a-z]*\n?/gi, "").split("\n")
  .map((l) => l.trim()).filter((l) => l && !l.startsWith("[") && !/https?:\/\//i.test(l)).map((l) => l.slice(0, 200));

/**
 * Repair (do not reject) an LLM draft into the loop: a tiny model's words
 * are redistributed across the fallback's exact blocks, chorus lines stay
 * verbatim, and any block the draft cannot fill keeps its template lines.
 * Returns the fallback only when the draft has too little usable text.
 */
export function fitLyricsToLoop(llmText, fallback = "", { loopHook = "" } = {}) {
  const draft = sungLinesOf(llmText);
  if (draft.length < 4 || String(llmText ?? "").length > 4000) return fallback;
  const blocks = [];
  let cur = null;
  for (const line of String(fallback).split("\n")) {
    const tag = line.match(/^\[([^\]]+)\]/);
    if (tag) { cur = { tag: line.trim(), name: tag[1].split(" - ")[0].trim(), lines: [] }; blocks.push(cur); }
    else if (cur && line.trim()) cur.lines.push(line.trim());
    else if (!cur && line.trim()) { cur = { tag: "", name: "", lines: [line.trim()] }; blocks.push(cur); }
  }
  if (!blocks.length) return fallback;
  let cursor = 0;
  const out = [];
  for (const b of blocks) {
    if (b.tag) out.push(b.tag);
    const isChorus = /^chorus/i.test(b.name);
    const isSilent = /^(intro|instrumental|drop)$/i.test(b.name);
    if (isChorus) { out.push(...(b.lines.length ? b.lines : [loopHook].filter(Boolean))); continue; }
    if (isSilent) continue;
    const want = Math.max(1, b.lines.length);
    const filled = [];
    while (filled.length < want && cursor < draft.length) filled.push(draft[cursor++]);
    out.push(...(filled.length ? filled : b.lines));
  }
  const lyrics = out.join("\n").trim();
  return lyrics.split("\n").filter((l) => l.trim()).length >= 4 ? lyrics : fallback;
}

/** Guarantee the shouted Critical callout: borrow the template's line when the draft forgot it. */
export function ensureCritCallout(lyrics, fallback = "") {
  if (/critical/i.test(lyrics)) return lyrics;
  const callout = String(fallback).split("\n").map((l) => l.trim()).find((l) => /^critical!/i.test(l));
  if (!callout) return lyrics;
  const lines = String(lyrics).split("\n");
  const verseIdx = lines.findIndex((l) => /^\[Verse/i.test(l.trim()));
  if (verseIdx < 0) return `${callout}\n${lyrics}`;
  lines.splice(verseIdx + 1, 0, callout);
  return lines.join("\n");
}

export function sanitizeLlmJoke(text, fallback = null, { recentJokes = [] } = {}) {
  const joke = String(text ?? "").split("\n").map((l) => l.trim().replace(/^["“]|["”]$/g, "")).find((l) => l.length >= 12) ?? "";
  if (!joke || joke.length > 220 || /https?:\/\//i.test(joke)) return fallback;
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  if (recentJokes.some((j) => norm(j) === norm(joke))) return fallback;
  return joke;
}

/** One short OpenAI-compatible chat completion. Throws on any failure. */
export async function fetchSmallLlmText({ baseUrl, apiKey = "", model, prompt, system = SMALL_LLM_SYSTEM, fetchImpl = null, timeoutMs = 12000, maxTokens = 500, temperature = 1.0 } = {}) {
  if (!baseUrl || !model) throw new Error("Small LLM endpoint/model not configured");
  const doFetch = fetchImpl ?? ((...a) => globalThis.fetch(...a));
  const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
  try {
    const res = await doFetch(`${String(baseUrl).replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
      body: JSON.stringify({
        model, temperature, max_tokens: maxTokens,
        messages: [{ role: "system", content: system }, { role: "user", content: prompt }],
      }),
      ...(ctrl ? { signal: ctrl.signal } : {}),
    });
    if (!res.ok) throw new Error(`Small LLM HTTP ${res.status}`);
    const json = await res.json();
    const out = json?.choices?.[0]?.message?.content?.trim();
    if (!out) throw new Error("Small LLM returned nothing");
    return out;
  } finally {
    if (timer) clearTimeout(timer);
  }
}


// --- Story tracker: the writer's long-term memory of the group. --------
// Cumulative across sessions (unlike the 3h SessionLog): per-actor dice
// legends, scars, corruption, deaths, milestones and table obsessions.
// Persisted by main.js in a hidden world setting; fed back to the bards
// as compact stat lines, never as raw chat.
const STOP = new Set("the and for with that this from have will just like into your you are was were been has had not but all can out who get got let say see she her his him they them then than too very over under again once here there when where which while about would could should their these those being".split(" "));
const blankActor = (name) => ({ name, career: null, rolls: 0, crits: 0, fumbles: 0, damage: 0, wounds: 0, corruption: 0, deaths: 0, bestDamage: 0 });
export class StoryTracker {
  constructor(data = null) {
    this.totals = { rolls: 0, crits: 0, fumbles: 0, combats: 0, wounds: 0, corruption: 0, deaths: 0, chats: 0, requests: 0, ...(data?.totals ?? {}) };
    this.actors = (data?.actors && typeof data.actors === "object") ? data.actors : {};
    this.milestones = Array.isArray(data?.milestones) ? data.milestones.slice(-60) : [];
    this.wordCounts = (data?.wordCounts && typeof data.wordCounts === "object") ? data.wordCounts : {};
    this.lastTs = Number(data?.lastTs) || 0;
    this.sameTsSeen = Array.isArray(data?.sameTsSeen) ? data.sameTsSeen.slice(-200) : [];
    this.firstTs = Number(data?.firstTs) || 0;
  }
  static fromJSON(data) { return new StoryTracker(data && typeof data === "object" ? data : null); }
  toJSON() { return { version: 1, totals: this.totals, actors: this.actors, milestones: this.milestones.slice(-60), wordCounts: this.wordCounts, lastTs: this.lastTs, sameTsSeen: this.sameTsSeen.slice(-200), firstTs: this.firstTs }; }
  #actor(name, careers) {
    const key = String(name ?? "Someone");
    this.actors[key] ??= blankActor(key);
    if (careers?.[key]) this.actors[key].career = careers[key];
    return this.actors[key];
  }
  #note(ts, text) { this.milestones.push({ ts, text }); if (this.milestones.length > 60) this.milestones = this.milestones.slice(-60); }
  /** Ingest log events newer than the cursor. Safe to call with the whole log. */
  ingest(events = [], careers = null) {
    if (careers) for (const [name, career] of Object.entries(careers)) if (this.actors[name]) this.actors[name].career = career;
    let added = 0;
    for (const e of events ?? []) {
      if (!e || typeof e.ts !== "number") continue;
      if (e.ts < this.lastTs) continue;
      const fp = String(hashSeed(JSON.stringify(e)));
      if (e.ts === this.lastTs && this.sameTsSeen.includes(fp)) continue;
      if (e.ts > this.lastTs) { this.lastTs = e.ts; this.sameTsSeen = []; }
      this.sameTsSeen.push(fp);
      if (!this.firstTs) this.firstTs = e.ts;
      this.#record(e, careers);
      added += 1;
    }
    if (added) this.#prune();
    return added;
  }
  #record(e, careers) {
    const a = e.actor ? this.#actor(e.actor, careers) : null;
    if (e.kind === "roll") {
      this.totals.rolls++; if (a) a.rolls++;
      if (e.isCrit) { this.totals.crits++; if (a) a.crits++; }
      if (e.isFumble) { this.totals.fumbles++; if (a) a.fumbles++; }
      if (a && typeof e.damage === "number" && e.damage > 0) {
        a.damage += e.damage;
        if (e.damage > a.bestDamage) { a.bestDamage = e.damage; if (e.damage >= 15) this.#note(e.ts, `${a.name} landed a ${e.damage}-damage blow${e.flavor ? ` (${e.flavor})` : ""}`); }
      }
    } else if (e.kind === "critwound") {
      this.totals.wounds++; if (a) a.wounds++;
      this.#note(e.ts, `${e.actor} suffered ${e.name ?? "a Critical Wound"}`);
    } else if (e.kind === "corruption") {
      const pts = Number(e.points) || 1; this.totals.corruption += pts; if (a) a.corruption += pts;
      this.#note(e.ts, `${e.actor} gained ${pts} Corruption`);
    } else if (e.kind === "death") {
      this.totals.deaths++; if (a) { a.deaths++; if (e.career) a.career = e.career; }
      this.#note(e.ts, `${fallenLabel(e)} died${e.cause ? ` (${e.cause})` : ""}`);
    } else if (e.kind === "combat" && e.phase === "start") {
      this.totals.combats++;
    } else if (e.kind === "request") {
      this.totals.requests++;
      if (e.topic) this.#note(e.ts, `${e.actor} requested a song about ${e.topic}`);
    } else if (e.kind === "chat") {
      this.totals.chats++;
      for (const w of String(e.text ?? "").toLowerCase().match(/[a-z][a-z'-]{3,}/g) ?? []) if (!STOP.has(w)) this.wordCounts[w] = (this.wordCounts[w] ?? 0) + 1;
    }
  }
  #prune() {
    const keepWords = Object.entries(this.wordCounts).sort((x, y) => y[1] - x[1]).slice(0, 120);
    this.wordCounts = Object.fromEntries(keepWords);
    const actors = Object.values(this.actors);
    if (actors.length > 80) {
      const keep = new Set([...actors].sort((x, y) => (y.deaths - x.deaths) || (y.rolls + y.wounds - x.rolls - x.wounds)).slice(0, 80).map((a) => a.name));
      this.actors = Object.fromEntries(Object.entries(this.actors).filter(([k]) => keep.has(k)));
    }
  }
  #top(field) { return [...Object.values(this.actors)].filter((a) => a[field] > 0).sort((x, y) => y[field] - x[field])[0] ?? null; }
  label(a) { return a ? fallenLabel({ actor: a.name, career: a.career }) : ""; }
  /** Structured all-time stats for the template lyric engine. */
  summaryForBards() {
    const crit = this.#top("crits"), fum = this.#top("fumbles"), wound = this.#top("wounds"), corrupt = this.#top("corruption");
    const fallen = Object.values(this.actors).filter((a) => a.deaths > 0).map((a) => this.label(a));
    return {
      totals: { ...this.totals },
      topCritter: crit ? { ...crit, label: this.label(crit) } : null,
      topFumbler: fum ? { ...fum, label: this.label(fum) } : null,
      topWounded: wound ? { ...wound, label: this.label(wound) } : null,
      topCorrupted: corrupt ? { ...corrupt, label: this.label(corrupt) } : null,
      fallen,
      keywords: Object.entries(this.wordCounts).sort((x, y) => y[1] - x[1]).slice(0, 5).map(([w]) => w),
      milestones: this.milestones.slice(-6).map((m) => m.text),
    };
  }
  /** Compact lines fed to the small LLM and break writer as saga memory. */
  contextLines(limit = 7) {
    const s = this.summaryForBards();
    const lines = [`All-time: ${s.totals.rolls} rolls, ${s.totals.crits} crits, ${s.totals.fumbles} fumbles, ${s.totals.combats} fights, ${s.totals.deaths} deaths.`];
    if (s.topCritter) lines.push(`Dice legend: ${s.topCritter.label} — ${s.topCritter.crits} crits${s.topCritter.damage ? `, ${s.topCritter.damage} lifetime damage` : ""}.`);
    if (s.topFumbler) lines.push(`Perpetual butt of the songs: ${s.topFumbler.label} — ${s.topFumbler.fumbles} fumbles.`);
    if (s.topWounded) lines.push(`Most scarred: ${s.topWounded.label} — ${s.topWounded.wounds} Critical Wounds survived (so far).`);
    if (s.topCorrupted) lines.push(`Most corrupted: ${s.topCorrupted.label} — ${s.topCorrupted.corruption} Corruption.`);
    if (s.fallen.length) lines.push(`Fallen and still mourned: ${s.fallen.join(", ")}.`);
    if (s.keywords.length) lines.push(`The table never stops talking about: ${s.keywords.join(", ")}.`);
    for (const m of s.milestones.slice(-2)) lines.push(`Saga beat: ${m}.`);
    return lines.slice(0, Math.max(1, limit));
  }
}
