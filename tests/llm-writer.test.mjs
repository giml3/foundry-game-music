import test from "node:test";
import assert from "node:assert/strict";
import { StoryTracker, buildJokePrompt, buildLyricPrompt, fetchSmallLlmText, rollFactsForPrompt, sanitizeLlmJoke, sanitizeLlmLyrics } from "../scripts/llm-writer.js";
import { extractFeatures } from "../scripts/prompt-engine.js";

const events = [
  { kind: "roll", ts: 100, actor: "Brunhilde", total: 11, target: 55, isCrit: true, isFumble: false, flavor: "Longsword", damage: 18 },
  { kind: "roll", ts: 110, actor: "Bram", total: 99, target: 40, isCrit: false, isFumble: true, flavor: "Climb" },
  { kind: "roll", ts: 120, actor: "Bram", total: 88, target: 40, isCrit: false, isFumble: true, flavor: "Swim" },
  { kind: "critwound", ts: 130, actor: "Bram", name: "Torn Muscle", location: "rArm" },
  { kind: "corruption", ts: 140, actor: "Brunhilde", points: 2 },
  { kind: "combat", ts: 150, phase: "start" },
  { kind: "chat", ts: 160, actor: "Aria", text: "the dragon hoard, the dragon gold, always the dragon" },
  { kind: "death", ts: 170, actor: "Old Piet", career: "Barge Master" },
];
const careers = { Brunhilde: "Soldier", Bram: "Rat Catcher" };

test("story tracker accumulates all-time legends and never double-counts the log", () => {
  const story = new StoryTracker();
  assert.equal(story.ingest(events, careers), events.length);
  assert.equal(story.ingest(events, careers), 0, "re-ingesting the same log is a no-op");
  const s = story.summaryForBards();
  assert.equal(s.totals.rolls, 3);
  assert.equal(s.totals.deaths, 1);
  assert.equal(s.topCritter.label, "Brunhilde the Soldier");
  assert.equal(s.topFumbler.label, "Bram the Rat Catcher");
  assert.equal(s.topCritter.damage, 18);
  assert.deepEqual(s.fallen, ["Old Piet the Barge Master"]);
  assert.ok(s.keywords.includes("dragon"));
  const lines = story.contextLines().join("\n");
  assert.match(lines, /All-time: 3 rolls/);
  assert.match(lines, /Fallen and still mourned: Old Piet the Barge Master/);
  const restored = StoryTracker.fromJSON(JSON.parse(JSON.stringify(story.toJSON())));
  assert.equal(restored.ingest(events, careers), 0, "restored tracker still dedupes");
  assert.equal(restored.summaryForBards().topFumbler.fumbles, 2);
});

test("llm prompts carry facts and story, and forbid copying existing songs", () => {
  const f = extractFeatures([{ actor: "Bram", total: 99, target: 40, normalized: 0, isCrit: false, isFumble: true, flavor: "Climb" }], []);
  const facts = rollFactsForPrompt(f, careers);
  assert.match(facts.join(" "), /Bram the Rat Catcher rolled 99 vs 40/);
  const prompt = buildLyricPrompt({ fallbackLyrics: "[Verse]\nla", facts, storyLines: ["All-time: 9 rolls"], recentJokes: ["an old joke"] });
  assert.match(prompt, /true dice facts/);
  assert.match(prompt, /Long-term saga/);
  assert.match(buildJokePrompt({ facts, recentJokes: ["an old joke"] }), /Do NOT reuse/);
});

test("sanitizers fall back on junk, URLs, missing fallen names, or repeated jokes", () => {
  const fb = "[Verse]\nfallback";
  assert.equal(sanitizeLlmLyrics("no markers here at all, just prose", fb), fb);
  assert.equal(sanitizeLlmLyrics("[Verse]\nvisit https://example.invalid\n[Chorus]\nx", fb), fb);
  assert.equal(sanitizeLlmLyrics("[Verse]\nsomeone else\n[Chorus]\nla la\nmore", fb, { mustMention: "Brunhilde" }), fb);
  assert.match(sanitizeLlmLyrics("```\n[Verse]\nBrunhilde fell\n[Chorus]\nmourn her\nmore\n```", fb, { mustMention: "Brunhilde" }), /Brunhilde fell/);
  assert.equal(sanitizeLlmJoke("too short", "fallback joke, long enough", {}), "fallback joke, long enough");
  assert.equal(sanitizeLlmJoke('"The same joke again, sadly."', "fresh fallback joke here", { recentJokes: ["The same joke again, sadly."] }), "fresh fallback joke here");
});

test("lyric polish must preserve the loop blocks and hook or the template stands", () => {
  const sections = ["Intro", "Verse 1", "Chorus", "Verse 2", "Chorus"];
  const hook = "Every mug in the air for the roll that lights the hall!";
  const fb = "[Intro]\n[Verse 1]\ntemplate verse\n[Chorus]\n" + hook + "\n[Verse 2]\nmore\n[Chorus]\n" + hook;
  const good = "[Intro]\n[Verse 1 - Male Bard]\nFresh grim verse\n[Chorus - Both Bards]\n" + hook + "\n[Verse 2]\nFresh again\n[Chorus]\n" + hook + "\nextra line";
  assert.equal(sanitizeLlmLyrics(good, fb, { loopSections: sections, loopHook: hook }), good);
  assert.equal(sanitizeLlmLyrics(good.replaceAll(hook, "a different hook entirely"), fb, { loopSections: sections, loopHook: hook }), fb, "dropped hook falls back");
  assert.equal(sanitizeLlmLyrics("[Verse 1]\nFresh\n[Chorus]\n" + hook, fb, { loopSections: sections, loopHook: hook }), fb, "missing blocks fall back");
  const prompt = buildLyricPrompt({ fallbackLyrics: fb, loopSections: sections, loopHook: hook });
  assert.match(prompt, /Preserve the loop blocks exactly/);
  assert.match(prompt, /word-for-word/);
});

test("fetchSmallLlmText posts to the tiny model and returns its words", async () => {
  let seen = null;
  const fetchImpl = async (url, opts) => {
    seen = { url, body: JSON.parse(opts.body) };
    return { ok: true, json: async () => ({ choices: [{ message: { content: "[Verse]\nFresh grim words\n[Chorus]\nAbout dice" } }] }) };
  };
  const out = await fetchSmallLlmText({ baseUrl: "http://127.0.0.1:11434/v1/", model: "llama3.2:1b", prompt: "sing", fetchImpl });
  assert.match(out, /Fresh grim words/);
  assert.equal(seen.url, "http://127.0.0.1:11434/v1/chat/completions");
  assert.equal(seen.body.model, "llama3.2:1b");
  assert.match(seen.body.messages[0].content, /never copy/i);
  assert.match(seen.body.messages[0].content, /existing song/i);
  await assert.rejects(
    fetchSmallLlmText({ baseUrl: "http://127.0.0.1:11434/v1", model: "x", prompt: "y", fetchImpl: async () => ({ ok: false, status: 503 }) }),
    /HTTP 503/,
  );
});

test("player polish feeds story stats to the tiny LLM and falls back when it dies", async () => {
  const { BardicPlayer } = await import("../scripts/player-engine.js");
  const { SessionLog } = await import("../scripts/session-log.js");
  const { buildTrackRequest, buildBridgeRequest } = await import("../scripts/prompt-engine.js");
  const log = new SessionLog(events);
  const cfg = { smallLlmEnabled: true, smallLlmBaseUrl: "http://127.0.0.1:11434/v1", smallLlmApiKey: "", smallLlmModel: "llama3.2:1b", bawdy: "bawdy" };
  const player = new BardicPlayer({ sessionLog: log, getConfig: () => cfg });
  const prompts = [];
  const songReq = buildTrackRequest({ rolls: [{ actor: "Bram", total: 99, target: 40, normalized: 0, isCrit: false, isFumble: true, flavor: "Climb" }], careers });
  const freshSong = songReq.loopSections.map((s) => s === "Chorus" ? `[Chorus]\n${songReq.loopHook}\nMourn and laugh` : s === "Intro" || s === "Instrumental" || s === "Drop" ? `[${s}]` : `[${s}]\nFresh tiny-model verse about Bram`).join("\n");
  globalThis.fetch = async (_url, opts) => {
    const body = JSON.parse(opts.body);
    prompts.push(body.messages[1].content);
    const isJoke = body.messages[1].content.includes("ONE fresh one-line");
    return { ok: true, json: async () => ({ choices: [{ message: { content: isJoke ? "Bram rolled 99; even the ladder sent condolences." : freshSong } }] }) };
  };
  try {
    const req = songReq;
    const out = await player.polishWithSmallLlm(req, "tavern");
    assert.match(out.lyrics, /Fresh tiny-model verse/);
    assert.match(prompts[0], /Long-term saga/);
    assert.match(prompts[0], /Brunhilde the Soldier/, "story tracker fed the writer");
    const bridge = buildBridgeRequest({ bridgeIndex: 2, rolls: [{ actor: "Bram", total: 99, target: 40, normalized: 0, isCrit: false, isFumble: true, flavor: "Climb" }] });
    const joked = await player.polishWithSmallLlm(bridge, "tavern", { bridge: true });
    assert.match(joked.joke, /ladder sent condolences/);
    assert.match(joked.lyrics, /ladder sent condolences/);
  } finally { delete globalThis.fetch; }
  globalThis.fetch = async () => { throw new Error("down"); };
  try {
    const req2 = buildTrackRequest({});
    assert.equal(await player.polishWithSmallLlm(req2, "tavern"), req2, "dead LLM keeps template words");
    assert.ok(player._smallLlmCooldownUntil > Date.now(), "failure arms the cooldown");
  } finally { delete globalThis.fetch; }
});

test("loose tiny-model drafts are repaired into the loop, and Criticals are always called out", async () => {
  const { fitLyricsToLoop, ensureCritCallout } = await import("../scripts/llm-writer.js");
  const { buildTrackRequest } = await import("../scripts/prompt-engine.js");
  const req = buildTrackRequest({ rolls: [{ actor: "Aria", total: 20, target: 50, normalized: 1, isCrit: true, flavor: "Longsword" }] });
  assert.match(req.lyrics, /Critical!/, "template verses already shout the crit");
  const loose = "[Verse]\nAria danced on the table edge\nSinging doom to the dice gods\n[Chorus]\nWhatever the model felt like\nMore improvised glory here";
  const fitted = fitLyricsToLoop(loose, req.lyrics, { loopHook: req.loopHook });
  assert.notEqual(fitted, req.lyrics, "a usable loose draft now lands instead of being rejected");
  assert.match(fitted, /Aria danced on the table edge/);
  assert.ok(fitted.includes(req.loopHook), "chorus hook stays verbatim after repair");
  const called = ensureCritCallout(fitted, req.lyrics);
  assert.match(called, /Critical!/, "a draft that forgot the crit gets the template callout");
  assert.equal(fitLyricsToLoop("one line only", req.lyrics), req.lyrics, "near-empty drafts still fall back");
  const prompt = buildLyricPrompt({ fallbackLyrics: req.lyrics, facts: rollFactsForPrompt(req.features, null), loopSections: req.loopSections, loopHook: req.loopHook });
  assert.match(prompt, /CRITICAL CALLOUT \(mandatory\)/);
});
