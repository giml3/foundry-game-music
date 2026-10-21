// "On Break" recap: aggregate the last 2-3 hours of rolls/chat into stats,
// then turn them into a singable ballad. The template ballad always works
// offline; an optional OpenAI-compatible LLM writes richer verses when the
// GM explicitly enables it. Pure module (injectable fetch) for Node tests.
import { Bawdy } from "./constants.js";
import { bardVoiceForSong, bawdyFragment, clamp, fallenLabel, hashSeed, pickMusicalVariety, tagLyricsForBard, topKeywords } from "./prompt-engine.js";

export function aggregateBreakStats(events = []) {
  const rolls = events.filter((e) => e.kind === "roll");
  const chats = events.filter((e) => e.kind === "chat");
  const byActor = new Map();
  const flavorCounts = new Map();
  let biggestHit = null;
  let bestRoll = null;
  for (const r of rolls) {
    const a = byActor.get(r.actor) ?? { actor: r.actor, rolls: 0, crits: 0, fumbles: 0, bestTotal: null, bestNormalized: null, damageTotal: 0 };
    a.rolls += 1;
    if (r.isCrit) a.crits += 1;
    if (r.isFumble) a.fumbles += 1;
    // "Best" means highest quality (normalized), never highest raw total:
    // WFRP4e rolls UNDER the target, so a 91 is a disaster, not a highlight.
    if (typeof r.normalized === "number") {
      if (a.bestNormalized == null || r.normalized > a.bestNormalized) { a.bestNormalized = r.normalized; a.bestTotal = r.total; }
    } else if (a.bestNormalized == null && typeof r.total === "number") {
      a.bestTotal = a.bestTotal == null ? r.total : Math.max(a.bestTotal, r.total);
    }
    if (typeof r.damage === "number") a.damageTotal += r.damage;
    byActor.set(r.actor, a);
    if (r.flavor) flavorCounts.set(r.flavor, (flavorCounts.get(r.flavor) ?? 0) + 1);
    if (typeof r.damage === "number" && (!biggestHit || r.damage > biggestHit.total)) {
      biggestHit = { actor: r.actor, total: r.damage, flavor: r.flavor || "" };
    }
    if (typeof r.normalized === "number" && typeof r.total === "number"
      && (!bestRoll || r.normalized > bestRoll.normalized || (r.normalized === bestRoll.normalized && r.isCrit && !bestRoll.isCrit))) {
      bestRoll = { actor: r.actor, total: r.total, target: r.target ?? null, normalized: r.normalized, isCrit: Boolean(r.isCrit), flavor: r.flavor || "" };
    }
  }
  const woundEvents = events.filter((e) => e.kind === "critwound");
  const byWounded = new Map();
  for (const w of woundEvents) {
    const a = byWounded.get(w.actor) ?? { actor: w.actor, count: 0, names: [] };
    a.count += 1;
    a.names.push(w.name ?? "Critical Wound");
    byWounded.set(w.actor, a);
  }
  const topWounded = [...byWounded.values()].sort((x, y) => y.count - x.count)[0] ?? null;
  const corruptEvents = events.filter((e) => e.kind === "corruption");
  const byCorrupt = new Map();
  for (const e2 of corruptEvents) {
    const a = byCorrupt.get(e2.actor) ?? { actor: e2.actor, points: 0 };
    a.points += Number(e2.points) || 1;
    byCorrupt.set(e2.actor, a);
  }
  const topCorrupted = [...byCorrupt.values()].sort((x, y) => y.points - x.points)[0] ?? null;
  const deaths = events.filter((e) => e.kind === "death").map((e) => ({ actor: e.actor, career: e.career ?? null, cause: e.cause ?? null }));
  const perActor = [...byActor.values()].sort((x, y) => y.rolls - x.rolls);
  const topCritter = [...perActor].sort((x, y) => y.crits - x.crits)[0] ?? null;
  const topFumbler = [...perActor].sort((x, y) => y.fumbles - x.fumbles)[0] ?? null;
  const mostRolledFlavor = [...flavorCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const spanMs = events.length ? (events[events.length - 1].ts - events[0].ts) : 0;
  const highlights = [];
  if (topCritter?.crits) highlights.push(`${topCritter.actor} landed ${topCritter.crits} critical${topCritter.crits > 1 ? "s" : ""}`);
  if (topFumbler?.fumbles) highlights.push(`${topFumbler.actor} fumbled ${topFumbler.fumbles} time${topFumbler.fumbles > 1 ? "s" : ""}`);
  if (biggestHit) highlights.push(`biggest hit: ${biggestHit.actor} — ${biggestHit.total} damage${biggestHit.flavor ? ` (${biggestHit.flavor})` : ""}`);
  if (bestRoll) highlights.push(`best roll: ${bestRoll.actor} — ${bestRoll.total}${bestRoll.target != null ? ` vs ${bestRoll.target}` : ""}${bestRoll.flavor ? ` (${bestRoll.flavor})` : ""}`);
  if (mostRolledFlavor) highlights.push(`most rolled: ${mostRolledFlavor}`);
  if (topWounded) highlights.push(`${topWounded.actor} suffered ${topWounded.count} Critical Wound${topWounded.count > 1 ? "s" : ""} (${[...new Set(topWounded.names)].join(", ")})`);
  if (topCorrupted) highlights.push(`${topCorrupted.actor} gained ${topCorrupted.points} Corruption`);
  for (const d of deaths) highlights.push(`${fallenLabel(d)} died`);
  return {
    totalRolls: rolls.length,
    totalChats: chats.length,
    combats: events.filter((e) => e.kind === "combat" && e.phase === "start").length,
    crits: rolls.filter((r) => r.isCrit).length,
    fumbles: rolls.filter((r) => r.isFumble).length,
    critWounds: woundEvents.length,
    topWounded,
    corruptionPoints: corruptEvents.reduce((a2, e2) => a2 + (Number(e2.points) || 1), 0),
    topCorrupted,
    deaths,
    perActor, topCritter: topCritter?.crits ? topCritter : null,
    topFumbler: topFumbler?.fumbles ? topFumbler : null,
    biggestHit, bestRoll, mostRolledFlavor,
    keywords: topKeywords(chats, 6),
    spanMinutes: Math.max(0, Math.round(spanMs / 60000)),
    highlights,
  };
}

/** Offline template ballad — always available, names real table events. Break-only crowd singing is fine here. */
export function buildTemplateBallad(stats, { bawdy = Bawdy.BAWDY } = {}) {
  const b = bawdyFragment(bawdy);
  const title = "The Ballad of the Break";
  const v = [];
  let verse = 0;
  const addVerse = (...lines) => { verse += 1; if (v.length) v.push(""); v.push(`[Verse ${verse}]`, ...lines); };
  addVerse(
    `Come gather round and hear the tale of ${stats.totalRolls} rolls tonight,`,
    `of ${stats.crits} fine crits and ${stats.fumbles} falls, by roaring firelight.`,
  );
  if (stats.topCritter) addVerse(
    `Oh ${stats.topCritter.actor} was golden, with ${stats.topCritter.crits} crit${stats.topCritter.crits > 1 ? "s" : ""} shining bright,`,
    "the tavern roared and raised their mugs each time they rolled it right.",
  );
  if (stats.topFumbler) addVerse(
    `Poor ${stats.topFumbler.actor} fumbled ${stats.topFumbler.fumbles} time${stats.topFumbler.fumbles > 1 ? "s" : ""}, oh the shame, oh the pain,`,
    "we sing it loud so all the town remembers them by name!",
  );
  if (stats.topWounded) addVerse(
    `And ${stats.topWounded.actor} bore ${stats.topWounded.count} Critical Wound${stats.topWounded.count > 1 ? "s" : ""} (${[...new Set(stats.topWounded.names)].join(", ")}), the grimmest sight of all,`,
    "the crowd went quiet, the fiddle wept, yet still they did not fall.",
  );
  if (stats.topCorrupted) addVerse(
    `Dark ${stats.topCorrupted.actor} took on ${stats.topCorrupted.points} Corruption, and the strings all soured then,`,
    "one sad discordant note rang out — may Sigmar guard such men.",
  );
  for (const d of stats.deaths ?? []) addVerse(
    `And ${fallenLabel(d)} died, and the room fell still and the songs all died away,`,
    "we rang the bell and sang the dirge — Morr keep them till the day.",
  );
  if (stats.biggestHit) addVerse(
    `The biggest hit was ${stats.biggestHit.actor}'s ${stats.biggestHit.total}${stats.biggestHit.flavor ? `, for ${stats.biggestHit.flavor}` : ""}, a blow to shake the hall,`,
    "the rafters rang, the barmaid sang, and envy gripped them all.",
  );
  else if (stats.bestRoll) addVerse(
    `The finest roll was ${stats.bestRoll.actor}'s ${stats.bestRoll.total}${stats.bestRoll.target != null ? ` against ${stats.bestRoll.target}` : ""}, clean under the mark so true,`,
    "the lowest dice are the sweetest dice — this song is proof for you.",
  );
  if (stats.keywords.length) addVerse(
    `They spoke of ${stats.keywords.slice(0, 4).join(", ")} as the candles burned,`,
    "and half the tales were surely true — the rest, well, lessons learned.",
  );
  v.push("", "[Chorus]", b.chorus, "Sing hey for the heroes and ho for the fools, the dice make the legends and break all the rules!");
  const summaryLines = [
    `${stats.totalRolls} rolls · ${stats.crits} crits · ${stats.fumbles} fumbles · ${stats.combats} combat${stats.combats === 1 ? "" : "s"}${stats.critWounds ? ` · ${stats.critWounds} critical wounds` : ""}${stats.corruptionPoints ? ` · ${stats.corruptionPoints} corruption` : ""}${stats.deaths?.length ? ` · ${stats.deaths.length} death${stats.deaths.length === 1 ? "" : "s"}` : ""} · ~${stats.spanMinutes} min`,
    ...stats.highlights,
  ];
  return { title, lyrics: v.join("\n"), summaryLines };
}

/** Prompt handed to the optional external LLM. Contains actor names/public chat samples only. */
export function buildRecapPrompt(stats, events = [], { bawdy = Bawdy.BAWDY } = {}) {
  const chatSamples = events.filter((e) => e.kind === "chat").slice(-40).map((e) => `${e.actor}: ${e.text}`);
  const tone = bawdy === "clean" ? "wholesome and family-friendly" : bawdy === "filthy" ? "raunchy adult bawdy with innuendo" : "cheeky bawdy drinking-song";
  return [
    `Write ORIGINAL singable tavern-ballad lyrics recapping an RPG session: a style parody only — never copy, rewrite or closely imitate any existing song lyric, title, hook or melody. Grimdark Old World gallows humour. Tone: ${tone}.`,
    "Use [Verse]/[Chorus] markers, rhyme, and MUST name these real events:",
    ...stats.highlights.map((h) => `- ${h}`),
    stats.keywords.length ? `Recurring table talk: ${stats.keywords.join(", ")}` : "",
    ...(stats.storyLines?.length ? ["Long-term saga so far (use as callbacks):", ...stats.storyLines.map((l) => `- ${l}`)] : []),
    chatSamples.length ? `Recent table chat (flavour only, do not quote verbatim):\n${chatSamples.join("\n")}` : "",
    "Return ONLY the lyrics.",
  ].filter(Boolean).join("\n");
}

/** Call an OpenAI-compatible /chat/completions endpoint. Throws on failure (caller falls back). */
export async function fetchSummarizerLyrics({ baseUrl, apiKey = "", model, stats, events = [], bawdy = Bawdy.BAWDY, fetchImpl = null } = {}) {
  const doFetch = fetchImpl ?? ((...a) => globalThis.fetch(...a));
  const url = `${String(baseUrl).replace(/\/+$/, "")}/chat/completions`;
  const res = await doFetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
    body: JSON.stringify({
      model,
      temperature: 0.8,
      messages: [
        { role: "system", content: "You are a tavern bard who writes recap ballads." },
        { role: "user", content: buildRecapPrompt(stats, events, { bawdy }) },
      ],
    }),
  });
  if (!res.ok) throw new Error(`Summarizer HTTP ${res.status}`);
  const json = await res.json();
  const text = json?.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error("Summarizer returned no lyrics");
  return text;
}

/** ACE-Step request for the break ballad. */
export function buildBreakRequest({ stats, lyrics, bawdy = Bawdy.BAWDY, breakDuration = 240, songIndex = 0, varietySeed = songIndex } = {}) {
  const b = bawdyFragment(bawdy);
  const ratio = stats.totalRolls ? (stats.crits - stats.fumbles) / stats.totalRolls : 0;
  const voice = bardVoiceForSong(songIndex, { duet: true }); // break ballads are duets
  const variety = pickMusicalVariety({ mode: "tavern", songIndex, seed: varietySeed, forceMinor: Boolean(stats.deaths?.length) });
  const bpm = Math.round(clamp(110 + ratio * 60 + Math.min(stats.crits, 8) * 2 + variety.bpmShift - (stats.deaths?.length ? 18 : 0), 84, 142));
  return {
    prompt: `${voice.prompt}. Lively medieval tavern folk ballad, grimdark gallows humour, ${variety.phrase}, storytelling lead bards, bright plucky lute lead, fiddle, prominent bodhran and frame drum, ${b.crowd ?? b.prompt}, group chorus finale`,
    songIndex, bard: voice, variety, varietySeed, aceSeed: hashSeed(`break:${varietySeed}:${songIndex}`),
    lyrics: tagLyricsForBard(lyrics, voice),
    bpm,
    keyScale: variety.keyScale,
    timeSignature: variety.meter ?? "4",
    duration: clamp(breakDuration, 30, 600),
    title: "The Ballad of the Break",
    why: `break recap of ~${stats.spanMinutes} min (bard: ${voice.label}; style: ${variety.styleId} in ${variety.keyScale}, ${variety.progressionLabel}): ${stats.highlights.join("; ") || "a lively stretch"}`,
  };
}
