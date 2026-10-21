import test from "node:test";
import assert from "node:assert/strict";
import { aggregateBreakStats, buildBreakRequest, buildRecapPrompt, buildTemplateBallad, fetchSummarizerLyrics } from "../scripts/recap.js";

const T0 = 1_000_000;
const events = [
  { kind: "roll", ts: T0, actor: "Aria", total: 20, isCrit: true, isFumble: false, flavor: "Longsword" },
  { kind: "roll", ts: T0 + 60000, actor: "Aria", total: 19, isCrit: true, isFumble: false, flavor: "Longsword" },
  { kind: "roll", ts: T0 + 120000, actor: "Bram", total: 1, isCrit: false, isFumble: true, flavor: "Stealth" },
  { kind: "roll", ts: T0 + 180000, actor: "Bram", total: 32, isCrit: false, isFumble: false, flavor: "Fireball Damage", damage: 32 },
  { kind: "chat", ts: T0 + 240000, actor: "Aria", text: "the dragon hoard is ours, dragon gold for everyone" },
  { kind: "combat", ts: T0 + 300000, phase: "start" },
];

test("stats aggregate critter, fumbler, biggest hit, keywords", () => {
  const s = aggregateBreakStats(events);
  assert.equal(s.totalRolls, 4);
  assert.equal(s.crits, 2);
  assert.equal(s.fumbles, 1);
  assert.equal(s.combats, 1);
  assert.equal(s.topCritter.actor, "Aria");
  assert.equal(s.topFumbler.actor, "Bram");
  assert.equal(s.biggestHit.total, 32);
  assert.equal(s.mostRolledFlavor, "Longsword");
  assert.ok(s.keywords.includes("dragon"));
  assert.equal(s.spanMinutes, 5);
});

test("template ballad names the actual table events", () => {
  const b = buildTemplateBallad(aggregateBreakStats(events));
  assert.match(b.lyrics, /Aria was golden, with 2 crits/);
  assert.match(b.lyrics, /Bram fumbled 1 time/);
  assert.match(b.lyrics, /Bram's 32/);
  assert.match(b.summaryLines[0], /4 rolls · 2 crits · 1 fumbles/);
});

test("empty session still produces a singable ballad", () => {
  const b = buildTemplateBallad(aggregateBreakStats([]));
  assert.match(b.lyrics, /0 rolls tonight/);
  assert.match(b.lyrics, /\[Chorus\]/);
});

test("break request clamps duration to the ACE-Step 600s ceiling", () => {
  const s = aggregateBreakStats(events);
  assert.equal(buildBreakRequest({ stats: s, lyrics: "x", breakDuration: 9999 }).duration, 600);
  assert.match(buildBreakRequest({ stats: s, lyrics: "x" }).prompt, /tavern folk ballad/);
});

test("LLM prompt names highlights and forbids verbatim chat quotes", () => {
  const p = buildRecapPrompt(aggregateBreakStats(events), events);
  assert.match(p, /Aria landed 2 criticals/);
  assert.match(p, /do not quote verbatim/);
});

test("summarizer client parses OpenAI-compatible responses and throws on HTTP errors", async () => {
  const ok = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: "[Verse] oh Aria" } }] }) });
  const lyrics = await fetchSummarizerLyrics({ baseUrl: "http://x/v1", model: "m", stats: aggregateBreakStats(events), events, fetchImpl: ok });
  assert.match(lyrics, /oh Aria/);
  await assert.rejects(
   fetchSummarizerLyrics({ baseUrl: "http://x/v1", model: "m", stats: aggregateBreakStats([]), fetchImpl: async () => ({ ok: false, status: 500 }) }),
   /Summarizer HTTP 500/);
});

test("WFRP recap celebrates the LOW best roll, never the highest failure", () => {
  const wfrpEvents = [
    { kind: "roll", ts: T0, actor: "Lottie", total: 91, target: 27, normalized: 0, isCrit: false, isFumble: false, system: "wfrp4e", flavor: "Cool Test" },
    { kind: "roll", ts: T0 + 1, actor: "Lottie", total: 4, target: 46, normalized: 0.92, isCrit: false, isFumble: false, system: "wfrp4e", flavor: "Entertain Test" },
    { kind: "roll", ts: T0 + 2, actor: "Pieter", total: 17, target: 48, normalized: 0.81, isCrit: false, isFumble: false, system: "wfrp4e", flavor: "Play Test" },
  ];
  const s = aggregateBreakStats(wfrpEvents);
  assert.equal(s.biggestHit, null, "no damage rolls means no biggest hit");
  assert.equal(s.bestRoll.total, 4, "best WFRP roll is the low one");
  assert.equal(s.bestRoll.actor, "Lottie");
  assert.ok(s.highlights.some((h) => /best roll: Lottie — 4 vs 46/.test(h)), s.highlights.join("; "));
  assert.ok(!s.highlights.some((h) => /91/.test(h)), "the 91 failure is never celebrated");
  const b = buildTemplateBallad(s);
  assert.match(b.lyrics, /finest roll was Lottie's 4/);
});
