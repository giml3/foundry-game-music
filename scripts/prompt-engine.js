// Dice+chat -> ACE-Step prompt engine. Pure and deterministic for a given
// input, so the mapping is unit-testable: crits make it rowdier/faster,
// fumbles make it drunken and mocking, combat adds tempo and war drums.
import { Bawdy, Mode } from "./constants.js";

export const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

const STOPWORDS = new Set("the and for with that this from have will just like into your you are was were been has had not but all can out who get got let say see she her his him they them then than too very over under again once here there when where which while about would could should their there these those being".split(" "));

/** Top recurring content words from chat texts (lyric seasoning, not raw quotes). */
export function topKeywords(chats = [], limit = 5) {
  const counts = new Map();
  for (const c of chats) {
    for (const w of String(c?.text ?? "").toLowerCase().match(/[a-z][a-z'-]{3,}/g) ?? []) {
      if (!STOPWORDS.has(w)) counts.set(w, (counts.get(w) ?? 0) + 1);
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, limit).map(([w]) => w);
}

function countByActor(rolls, pred) {
  const m = new Map();
  for (const r of rolls) if (pred(r)) m.set(r.actor, (m.get(r.actor) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([actor, count]) => ({ actor, count }));
}

/** Extract muse features from a roll/chat window. */
export function extractFeatures(rolls = [], chats = []) {
  const norms = rolls.map((r) => r.normalized).filter((n) => typeof n === "number");
  return {
    rollCount: rolls.length,
    crits: rolls.filter((r) => r.isCrit).length,
    fumbles: rolls.filter((r) => r.isFumble).length,
    meanNormalized: norms.length ? norms.reduce((a, b) => a + b, 0) / norms.length : 0.5,
    critActors: countByActor(rolls, (r) => r.isCrit),
    fumbleActors: countByActor(rolls, (r) => r.isFumble),
    actors: [...new Set(rolls.map((r) => r.actor).filter(Boolean))],
    flavors: [...new Set(rolls.map((r) => r.flavor).filter(Boolean))].slice(0, 4),
    biggestTotal: rolls.reduce((m, r) => (typeof r.total === "number" && (m == null || r.total > m) ? r.total : m), null),
    keywords: topKeywords(chats),
  };
}

/** How badly the table "wants" a fresh song right now (0 = nothing happened). */
export function museSignificance(f) {
  return f.crits * 3 + f.fumbles * 3 + Math.min(f.rollCount, 12) + (f.keywords.length ? 1 : 0);
}

const BAWDY_LINES = {
  clean: {
    chorus: "Raise your mug and sing along, the night is young and the ale is strong!",
    verse: "In the corner by the firelight glow, hear the fiddle laugh and the tankards flow.",
    prompt: "wholesome family-friendly tavern folk song, cheerful singalong chorus",
  },
  bawdy: {
    chorus: "Raise your mug and pinch a cheek, the barmaid winks and the floorboards creak!",
    verse: "Oh the landlord's daughter with a wink and a sway, keeps the ale and the lads coming back all day.",
    prompt: "bawdy medieval drinking song, cheeky double-entendre lyrics, rowdy tavern chorus, lusty singalong",
  },
  filthy: {
    chorus: "Raise your mug and slap a thigh, the night gets hotter as the moon rides high!",
    verse: "Oh the sailor swore he'd be home by ten, but the barmaid's smile made a liar of men.",
    prompt: "raunchy bawdy tavern drinking song, adult innuendo, rowdy lusty chorus, drunken singalong",
  },
};

export function bawdyFragment(level) {
  return BAWDY_LINES[level] ?? BAWDY_LINES[Bawdy.BAWDY];
}

function tavernLyrics(f, bawdy) {
  const b = bawdyFragment(bawdy);
  const lines = ["[Verse 1]", b.verse];
  if (f.critActors.length) {
    const a = f.critActors[0];
    lines.push(`Oh ${a.actor} rolled like a legend tonight, ${a.count > 1 ? `${a.count} times golden` : "once pure golden"}, a glorious sight!`);
  }
  if (f.fumbleActors.length) {
    const a = f.fumbleActors[0];
    lines.push(`Poor ${a.actor} dropped it all on the floor, the whole inn laughed till their bellies were sore!`);
  }
  if (!f.critActors.length && !f.fumbleActors.length && f.actors.length) {
    lines.push(`Here's to ${f.actors.slice(0, 3).join(", ")} and the road they tread, may their mugs stay full and their purses well-fed.`);
  }
  if (f.keywords.length) lines.push(`They talk of ${f.keywords.slice(0, 3).join(", ")} by candlelight, and argue it merry till deep in the night.`);
  lines.push("", "[Chorus]", b.chorus, "Sing hey for the dice and ho for the ale, every roll tells another fine tale!");
  return lines.join("\n");
}

function combatLyrics(f, bawdy) {
  const b = bawdyFragment(bawdy);
  const lines = ["[Verse 1]", "Steel is ringing and the drums beat fast, hold the line now, make every blow last!"];
  if (f.critActors.length) lines.push(`${f.critActors[0].actor} strikes and the foe falls down, the loudest cheer in the whole damn town!`);
  if (f.fumbleActors.length) lines.push(`${f.fumbleActors[0].actor} slips but the band plays on, get up, get up, till the battle is won!`);
  if (f.flavors.length) lines.push(`By ${f.flavors[0]} the tide shall turn, let courage blaze and the banners burn!`);
  lines.push("", "[Chorus]", "Faster, faster, fiddle and drum, fight till the morning, fight till they run!", b.chorus);
  return lines.join("\n");
}

/**
 * Build an ACE-Step request for the next tavern/combat track.
 * @returns {{prompt, lyrics, bpm, keyScale, timeSignature, duration, title, why, features}}
 */
export function buildTrackRequest({ mode = Mode.TAVERN, rolls = [], chats = [], bawdy = Bawdy.BAWDY, tavernDuration = 90, combatDuration = 90 } = {}) {
  const f = extractFeatures(rolls, chats);
  const b = bawdyFragment(bawdy);
  const moodLift = (f.meanNormalized - 0.5) * 20;
  const whyParts = [];

  let bpm, keyScale, timeSignature, duration, prompt, lyrics, title;
  if (mode === Mode.COMBAT) {
    bpm = Math.round(clamp(132 + f.crits * 4 - f.fumbles * 2 + moodLift, 118, 165));
    keyScale = f.crits > f.fumbles ? "A minor" : "D minor";
    timeSignature = "4";
    duration = combatDuration;
    prompt = `fast medieval tavern battle music, driving fiddle, war drum, hurdy-gurdy, lute, urgent dance jig, ${b.prompt}`;
    lyrics = combatLyrics(f, bawdy);
    title = "Combat Jig";
    whyParts.push(`combat → faster (${bpm} BPM, ${keyScale})`);
  } else {
    bpm = Math.round(clamp(92 + f.crits * 6 - f.fumbles * 4 + moodLift + Math.min(f.rollCount, 12), 70, 128));
    const drunken = f.fumbles >= 2 && f.fumbles > f.crits;
    timeSignature = drunken ? "3" : (f.crits >= 3 ? "6" : "4");
    keyScale = drunken ? "G minor" : (f.crits > 0 ? "D major" : "G major");
    duration = tavernDuration;
    prompt = `medieval tavern folk, lute, fiddle, bodhran drum, wooden flute, accordion, clinking tankards, warm inn acoustics, ${b.prompt}`;
    lyrics = tavernLyrics(f, bawdy);
    title = drunken ? "The Drunken Waltz" : (f.crits >= 2 ? "Golden Dice Reel" : "Tankard Song");
    if (drunken) whyParts.push(`${f.fumbles} fumbles → drunken 3/4 waltz`);
    else if (f.crits >= 3) whyParts.push(`${f.crits} crits → jig time (6/8)`);
  }
  if (f.critActors.length) whyParts.push(`crits: ${f.critActors.map((a) => `${a.actor}×${a.count}`).join(", ")} → rowdier verse`);
  if (f.fumbleActors.length) whyParts.push(`fumble: ${f.fumbleActors.map((a) => a.actor).join(", ")} → mocking verse`);
  if (f.keywords.length) whyParts.push(`chat talk of ${f.keywords.slice(0, 3).join(", ")}`);
  if (!whyParts.length) whyParts.push("quiet table → steady tavern standard");

  return { prompt, lyrics, bpm, keyScale, timeSignature, duration, title, why: whyParts.join("; "), features: f };
}
