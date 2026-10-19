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

/** Human label for a WFRP hit-location code, for lyric lines. */
export function woundLocationLabel(loc) {
  const map = { head: "head", body: "body", larm: "left arm", rarm: "right arm", lleg: "left leg", rleg: "right leg", lArm: "left arm", rArm: "right arm", lLeg: "left leg", rLeg: "right leg" };
  if (!loc) return "";
  return map[loc] ?? String(loc);
}

/** Extract muse features from a roll/chat window (+ WFRP wounds/corruption). */
export function extractFeatures(rolls = [], chats = [], wounds = [], corruptions = []) {
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
    critWounds: wounds.length,
    wounds: wounds.map((w) => ({ actor: w.actor, name: w.name ?? "Critical Wound", location: woundLocationLabel(w.location) })),
    woundActors: countByActor(wounds, () => true),
    corruptions: corruptions.length,
    corruptionPoints: corruptions.reduce((a, e) => a + (Number(e.points) || 1), 0),
    corruptActors: countByActor(corruptions, () => true),
  };
}

/** How badly the table "wants" a fresh song right now (0 = nothing happened). */
export function museSignificance(f) {
  return f.crits * 3 + f.fumbles * 3 + (f.critWounds ?? 0) * 4 + (f.corruptions ?? 0) * 3
    + Math.min(f.rollCount, 12) + (f.keywords.length ? 1 : 0);
}

// `prompt` is the everyday solo-bard register: NO townspeople/crowd noise.
// `crowd` restores the full tavern throng, and is used only for break ballads.
const BAWDY_LINES = {
  clean: {
    chorus: "Raise your mug and sing along, the night is young and the ale is strong!",
    verse: "In the corner by the firelight glow, hear the fiddle laugh and the tankards flow.",
    prompt: "wholesome family-friendly tavern folk song, solo bard with a single cheerful voice, no crowd noise, no background chatter",
    crowd: "cheerful singalong chorus with a merry tavern crowd joining in",
  },
  bawdy: {
    chorus: "Raise your mug and pinch a cheek, the barmaid winks and the floorboards creak!",
    verse: "Oh the landlord's daughter with a wink and a sway, keeps the ale and the lads coming back all day.",
    prompt: "bawdy medieval drinking song sung by a solo bard, single lusty vocalist, cheeky double-entendre lyrics, no crowd noise, no group chorus, no background chatter",
    crowd: "rowdy tavern chorus, townsfolk singing along, clinking tankards",
  },
  filthy: {
    chorus: "Raise your mug and slap a thigh, the night gets hotter as the moon rides high!",
    verse: "Oh the sailor swore he'd be home by ten, but the barmaid's smile made a liar of men.",
    prompt: "raunchy bawdy tavern drinking song sung by a solo bard, single drunken vocalist, adult innuendo, no crowd noise, no group chorus, no background chatter",
    crowd: "drunken tavern crowd roaring the chorus, townsfolk hollering along, tankards slamming",
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
    lines.push(`Poor ${a.actor} dropped it all on the floor, and I laughed till my own poor belly was sore!`);
  }
  if (f.wounds?.length) {
    const w = f.wounds[f.wounds.length - 1];
    lines.push(`Poor ${w.actor} took a ${w.name}${w.location ? ` to the ${w.location}` : ""} full sore, I sang soft while they limped to the door.`);
  }
  if (f.corruptActors?.length) {
    lines.push(`A shadow touched ${f.corruptActors[0].actor} and my strings turned sour, one sad wrong note for corruption's dark hour.`);
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
  if (f.critActors.length) lines.push(`${f.critActors[0].actor} strikes and the foe falls down, I sing it louder than the battle sound!`);
  if (f.fumbleActors.length) lines.push(`${f.fumbleActors[0].actor} slips but the band plays on, get up, get up, till the battle is won!`);
  if (f.wounds?.length) {
    const w = f.wounds[f.wounds.length - 1];
    lines.push(`${w.actor} took a ${w.name}${w.location ? ` to the ${w.location}` : ""} yet stands tall, the bravest bloodied fool of all!`);
  }
  if (f.corruptActors?.length) lines.push(`Corruption kissed ${f.corruptActors[0].actor} and the strings went wrong, one sour note curdling the battle song.`);
  if (f.flavors.length) lines.push(`By ${f.flavors[0]} the tide shall turn, let courage blaze and the banners burn!`);
  lines.push("", "[Chorus]", "Faster, faster, fiddle and drum, fight till the morning, fight till they run!", b.chorus);
  return lines.join("\n");
}

/**
 * Build an ACE-Step request for the next tavern/combat track.
 * @returns {{prompt, lyrics, bpm, keyScale, timeSignature, duration, title, why, features}}
 */
export function buildTrackRequest({ mode = Mode.TAVERN, rolls = [], chats = [], wounds = [], corruptions = [], bawdy = Bawdy.BAWDY, tavernDuration = 90, combatDuration = 90 } = {}) {
  const f = extractFeatures(rolls, chats, wounds, corruptions);
  const b = bawdyFragment(bawdy);
  const moodLift = (f.meanNormalized - 0.5) * 20;
  const whyParts = [];
  const dissonance = f.corruptions > 0 ? ", brief discordant detuned strings, one sad sour wrong note that slowly fades" : "";

  let bpm, keyScale, timeSignature, duration, prompt, lyrics, title;
  if (mode === Mode.COMBAT) {
    bpm = Math.round(clamp(132 + f.crits * 4 - f.fumbles * 2 + moodLift + Math.min(f.critWounds, 2) * 6 - Math.min(f.corruptions, 2) * 2, 118, 165));
    keyScale = f.critWounds > 0 || f.corruptions > 0 ? "D minor" : (f.crits > f.fumbles ? "A minor" : "D minor");
    timeSignature = "4";
    duration = combatDuration;
    prompt = `fast medieval tavern battle music, driving fiddle, war drum, hurdy-gurdy, lute, urgent dance jig, solo bard vocalist, ${b.prompt}${dissonance}`;
    lyrics = combatLyrics(f, bawdy);
    title = "Combat Jig";
    whyParts.push(`combat → faster (${bpm} BPM, ${keyScale})`);
  } else {
    bpm = Math.round(clamp(92 + f.crits * 6 - f.fumbles * 4 + moodLift + Math.min(f.rollCount, 12) - Math.min(f.critWounds, 2) * 8 - Math.min(f.corruptions, 2) * 4, 70, 128));
    const drunken = f.fumbles >= 2 && f.fumbles > f.crits;
    timeSignature = drunken ? "3" : (f.crits >= 3 ? "6" : "4");
    keyScale = (drunken || f.critWounds > 0 || f.corruptions > 0) ? "G minor" : (f.crits > 0 ? "D major" : "G major");
    duration = tavernDuration;
    prompt = `medieval tavern folk, solo lute, fiddle, bodhran drum, wooden flute, single bard vocalist, intimate dry recording, ${b.prompt}${dissonance}`;
    lyrics = tavernLyrics(f, bawdy);
    title = drunken ? "The Drunken Waltz" : (f.crits >= 2 ? "Golden Dice Reel" : "Tankard Song");
    if (drunken) whyParts.push(`${f.fumbles} fumbles → drunken 3/4 waltz`);
    else if (f.crits >= 3) whyParts.push(`${f.crits} crits → jig time (6/8)`);
  }
  if (f.critActors.length) whyParts.push(`crits: ${f.critActors.map((a) => `${a.actor}×${a.count}`).join(", ")} → rowdier verse`);
  if (f.fumbleActors.length) whyParts.push(`fumble: ${f.fumbleActors.map((a) => a.actor).join(", ")} → mocking verse`);
  for (const w of f.wounds.slice(-2)) whyParts.push(`Critical Wound: ${w.actor} (${w.name}) → grim verse`);
  if (f.corruptActors.length) whyParts.push(`Corruption: ${f.corruptActors.map((a) => `${a.actor}×${a.count}`).join(", ")} → discordant note`);
  if (f.keywords.length) whyParts.push(`chat talk of ${f.keywords.slice(0, 3).join(", ")}`);
  if (!whyParts.length) whyParts.push("quiet table → steady tavern standard");

  return { prompt, lyrics, bpm, keyScale, timeSignature, duration, title, why: whyParts.join("; "), features: f };
}
