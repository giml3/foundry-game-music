// "On Break" recap: aggregate the last 2-3 hours of rolls/chat into stats,
// then turn them into a singable ballad. The template ballad always works
// offline; an optional OpenAI-compatible LLM writes richer verses when the
// GM explicitly enables it. Pure module (injectable fetch) for Node tests.
import { Bawdy } from "./constants.js";
import { bawdyFragment, clamp, topKeywords } from "./prompt-engine.js";

export function aggregateBreakStats(events = []) {
  const rolls = events.filter((e) => e.kind === "roll");
  const chats = events.filter((e) => e.kind === "chat");
  const byActor = new Map();
  const flavorCounts = new Map();
  let biggestHit = null;
  for (const r of rolls) {
    const a = byActor.get(r.actor) ?? { actor: r.actor, rolls: 0, crits: 0, fumbles: 0, bestTotal: null, damageTotal: 0 };
    a.rolls += 1;
    if (r.isCrit) a.crits += 1;
    if (r.isFumble) a.fumbles += 1;
    if (typeof r.total === "number") a.bestTotal = a.bestTotal == null ? r.total : Math.max(a.bestTotal, r.total);
    if (typeof r.damage === "number") a.damageTotal += r.damage;
    byActor.set(r.actor, a);
    if (r.flavor) flavorCounts.set(r.flavor, (flavorCounts.get(r.flavor) ?? 0) + 1);
    const hitValue = typeof r.damage === "number" ? r.damage : r.total;
    if (typeof hitValue === "number" && (!biggestHit || hitValue > biggestHit.total)) {
      biggestHit = { actor: r.actor, total: hitValue, flavor: r.flavor || "" };
    }
  }
  const perActor = [...byActor.values()].sort((x, y) => y.rolls - x.rolls);
  const topCritter = [...perActor].sort((x, y) => y.crits - x.crits)[0] ?? null;
  const topFumbler = [...perActor].sort((x, y) => y.fumbles - x.fumbles)[0] ?? null;
  const mostRolledFlavor = [...flavorCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const spanMs = events.length ? (events[events.length - 1].ts - events[0].ts) : 0;
  const highlights = [];
  if (topCritter?.crits) highlights.push(`${topCritter.actor} landed ${topCritter.crits} critical${topCritter.crits > 1 ? "s" : ""}`);
  if (topFumbler?.fumbles) highlights.push(`${topFumbler.actor} fumbled ${topFumbler.fumbles} time${topFumbler.fumbles > 1 ? "s" : ""}`);
  if (biggestHit) highlights.push(`biggest roll: ${biggestHit.actor} — ${biggestHit.total}${biggestHit.flavor ? ` (${biggestHit.flavor})` : ""}`);
  if (mostRolledFlavor) highlights.push(`most rolled: ${mostRolledFlavor}`);
  return {
    totalRolls: rolls.length,
    totalChats: chats.length,
    combats: events.filter((e) => e.kind === "combat" && e.phase === "start").length,
    crits: rolls.filter((r) => r.isCrit).length,
    fumbles: rolls.filter((r) => r.isFumble).length,
    perActor, topCritter: topCritter?.crits ? topCritter : null,
    topFumbler: topFumbler?.fumbles ? topFumbler : null,
    biggestHit, mostRolledFlavor,
    keywords: topKeywords(chats, 6),
    spanMinutes: Math.max(0, Math.round(spanMs / 60000)),
    highlights,
  };
}

/** Offline template ballad — always available, names real table events. */
export function buildTemplateBallad(stats, { bawdy = Bawdy.BAWDY } = {}) {
  const b = bawdyFragment(bawdy);
  const title = "The Ballad of the Break";
  const v = [];
  v.push("[Verse 1]");
  v.push(`Come gather round and hear the tale of ${stats.totalRolls} rolls tonight,`);
  v.push(`of ${stats.crits} fine crits and ${stats.fumbles} falls, by roaring firelight.`);
  if (stats.topCritter) {
    v.push("", "[Verse 2]");
    v.push(`Oh ${stats.topCritter.actor} was golden, with ${stats.topCritter.crits} crit${stats.topCritter.crits > 1 ? "s" : ""} shining bright,`);
    v.push("the tavern roared and raised their mugs each time they rolled it right.");
  }
  if (stats.topFumbler) {
    v.push("", "[Verse 3]");
    v.push(`Poor ${stats.topFumbler.actor} fumbled ${stats.topFumbler.fumbles} time${stats.topFumbler.fumbles > 1 ? "s" : ""}, oh the shame, oh the pain,`);
    v.push("we sing it loud so all the town remembers them by name!");
  }
  if (stats.biggestHit) {
    v.push("", "[Verse 4]");
    v.push(`The biggest roll was ${stats.biggestHit.actor}'s ${stats.biggestHit.total}${stats.biggestHit.flavor ? `, for ${stats.biggestHit.flavor}` : ""}, a blow to shake the hall,`);
    v.push("the rafters rang, the barmaid sang, and envy gripped them all.");
  }
  if (stats.keywords.length) {
    v.push("", "[Verse 5]");
    v.push(`They spoke of ${stats.keywords.slice(0, 4).join(", ")} as the candles burned,`);
    v.push("and half the tales were surely true — the rest, well, lessons learned.");
  }
  v.push("", "[Chorus]", b.chorus, "Sing hey for the heroes and ho for the fools, the dice make the legends and break all the rules!");
  const summaryLines = [
    `${stats.totalRolls} rolls · ${stats.crits} crits · ${stats.fumbles} fumbles · ${stats.combats} combat${stats.combats === 1 ? "" : "s"} · ~${stats.spanMinutes} min`,
    ...stats.highlights,
  ];
  return { title, lyrics: v.join("\n"), summaryLines };
}

/** Prompt handed to the optional external LLM. Contains actor names/public chat samples only. */
export function buildRecapPrompt(stats, events = [], { bawdy = Bawdy.BAWDY } = {}) {
  const chatSamples = events.filter((e) => e.kind === "chat").slice(-40).map((e) => `${e.actor}: ${e.text}`);
  const tone = bawdy === "clean" ? "wholesome and family-friendly" : bawdy === "filthy" ? "raunchy adult bawdy with innuendo" : "cheeky bawdy drinking-song";
  return [
    `Write singable tavern-ballad lyrics recapping an RPG session. Tone: ${tone}.`,
    "Use [Verse]/[Chorus] markers, rhyme, and MUST name these real events:",
    ...stats.highlights.map((h) => `- ${h}`),
    stats.keywords.length ? `Recurring table talk: ${stats.keywords.join(", ")}` : "",
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
export function buildBreakRequest({ stats, lyrics, bawdy = Bawdy.BAWDY, breakDuration = 240 } = {}) {
  const b = bawdyFragment(bawdy);
  const ratio = stats.totalRolls ? (stats.crits - stats.fumbles) / stats.totalRolls : 0;
  const bpm = Math.round(clamp(98 + ratio * 60 + Math.min(stats.crits, 8) * 2, 78, 132));
  return {
    prompt: `medieval tavern folk ballad, storytelling bard with lute and fiddle, bodhran, group chorus finale, ${b.prompt}`,
    lyrics,
    bpm,
    keyScale: stats.fumbles > stats.crits ? "G minor" : "G major",
    timeSignature: "4",
    duration: clamp(breakDuration, 30, 600),
    title: "The Ballad of the Break",
    why: `break recap of ~${stats.spanMinutes} min: ${stats.highlights.join("; ") || "a quiet stretch"}`,
  };
}
