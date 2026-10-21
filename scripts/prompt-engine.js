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

/** Extract muse features from a roll/chat window (+ WFRP wounds/corruption/deaths). */
export function extractFeatures(rolls = [], chats = [], wounds = [], corruptions = [], deaths = []) {
  const norms = rolls.map((r) => r.normalized).filter((n) => typeof n === "number");
  return {
    rollCount: rolls.length,
    crits: rolls.filter((r) => r.isCrit).length,
    fumbles: rolls.filter((r) => r.isFumble).length,
    meanNormalized: norms.length ? norms.reduce((a, b) => a + b, 0) / norms.length : 0.5,
    critActors: countByActor(rolls, (r) => r.isCrit),
    critDetails: rolls.filter((r) => r.isCrit).slice(-4).map((r) => ({ actor: r.actor, total: r.total ?? null, target: r.target ?? null, flavor: r.flavor || "", damage: r.damage ?? null })),
    fumbleDetails: rolls.filter((r) => r.isFumble).slice(-4).map((r) => ({ actor: r.actor, total: r.total ?? null, target: r.target ?? null, flavor: r.flavor || "", damage: r.damage ?? null })),
    latestRoll: rolls.length ? { actor: rolls.at(-1).actor, total: rolls.at(-1).total ?? null, target: rolls.at(-1).target ?? null, flavor: rolls.at(-1).flavor || "", isCrit: Boolean(rolls.at(-1).isCrit), isFumble: Boolean(rolls.at(-1).isFumble) } : null,
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
    deaths: deaths.map((d) => ({ actor: d.actor, career: d.career ?? null, cause: d.cause ?? null })),
    deathCount: deaths.length,
  };
}

/** How badly the table "wants" a fresh song right now (0 = nothing happened). */
export function museSignificance(f) {
  return f.crits * 3 + f.fumbles * 3 + (f.critWounds ?? 0) * 4 + (f.corruptions ?? 0) * 3
    + (f.deathCount ?? f.deaths?.length ?? 0) * 10
    + Math.min(f.rollCount, 12) + (f.keywords.length ? 1 : 0);
}

// `prompt` is the everyday solo-bard register: NO townspeople/crowd noise.
// `crowd` restores the full tavern throng, and is used only for break ballads.
const BAWDY_LINES = {
  clean: {
    choruses: [
      "Sing low, sing grim, for the road is long, and Morr keeps time to a travelling song!",
      "Sing soft, sing low, for the night is deep, and Morr counts all who are fast asleep!",
      "Sing plain, sing true, for the dawn will tell, who kept the faith and who rang the bell!",
    ],
    verses: [
      "The rain on the Reik and the mud on the road, every traveller carries a heavier load.",
      "The frost on the furrow, the smoke on the hill, the road takes all comers and winter takes its fill.",
      "A crust for the stranger, a song for the lame, the Emperor's peace is a flickering flame.",
    ],
    prompt: "wholesome family-friendly tavern folk song, solo bard with a single cheerful voice, no crowd noise, no background chatter",
    crowd: "cheerful singalong chorus with a merry tavern crowd joining in",
  },
  bawdy: {
    choruses: [
      "Pinch a cheek and dodge the priest, we'll laugh at doom till the dooming's ceased!",
      "Raise a boot to the gallows tree, the doomed dance best when the doomed dance free!",
      "Kiss the cook and curse the tithe, we'll sing till Morr comes scything by!",
    ],
    verses: [
      "Oh the landlord's widow keeps a wink and a knife, she'll charm your purse and she'll charm your life.",
      "Oh the hangman's daughter deals the cards, she'll deal you rope or she'll deal you hearts.",
      "Oh the miller's son has a silver tongue, he'll talk the shirt off the newly hung.",
    ],
    prompt: "bawdy medieval drinking song sung by a solo bard, single lusty vocalist, cheeky double-entendre lyrics, no crowd noise, no group chorus, no background chatter",
    crowd: "rowdy tavern chorus, townsfolk singing along, boots stamping",
  },
  filthy: {
    choruses: [
      "Slap a thigh and damn the dawn, we'll sin till the watch comes hammering on!",
      "Grab a wrist and damn the tithe, we'll rut and revel while the doomsmen writhe!",
      "Lift a skirt for the end of days, the world's on fire in a hundred ways!",
    ],
    verses: [
      "Oh the sailor swore he'd be chaste by ten, but the widow's smile made a liar of men.",
      "Oh the ostler's wife keeps a bed half-made, for coin, for love, or a serenade.",
      "Oh the priest of Sigmar lost his pants, at the harvest dance, at the harvest dance.",
    ],
    prompt: "raunchy bawdy tavern drinking song sung by a solo bard, single drunken vocalist, adult innuendo, no crowd noise, no group chorus, no background chatter",
    crowd: "drunken tavern crowd roaring the chorus, townsfolk hollering along, benches overturning",
  },
};

/** Two alternating bards in strict rotation; every 5th song is a duet (verses trade, chorus together). */
export const BARD_VOICES = Object.freeze([
  Object.freeze({ id: "reikland-male", gender: "male", label: "male Reiklander bard (Bavarian German accent)", tag: "Male Vocal", prompt: "MALE VOCALIST ONLY, absolutely no female vocals: one solo male Reiklander bard, warm deep baritone voice, singing in English with a strong Bavarian German Reikland accent, rolled r consonants, hearty Germanic diction, single male singer throughout, ENGLISH ONLY: every sung word is English — the accent colours the pronunciation only, never the words; no German or any other language" }),
  Object.freeze({ id: "bretonnian-female", gender: "female", label: "female Bretonnian bard (French accent)", tag: "Female Vocal", prompt: "FEMALE VOCALIST ONLY, absolutely no male vocals: one solo female Bretonnian bard, clear warm alto voice, singing in English with an elegant French Bretonnian accent, soft French vowels, lilting diction, single female singer throughout, ENGLISH ONLY: every sung word is English — the accent colours the pronunciation only, never the words; no French or any other language" }),
]);
export const BARD_DUET = Object.freeze({
  id: "bard-duet", gender: "duet", label: "both bards in duet (male Reiklander + female Bretonnian)", tag: "Duet",
  prompt: "MALE-FEMALE DUET, exactly two singers: a male Reiklander baritone with a Bavarian German accent sings Verse 1, a female Bretonnian alto with a French accent sings Verse 2, both harmonise together on every Chorus, clearly alternating male and female voices, both singing ENGLISH lyrics only — the accents colour pronunciation only, never the words",
});
export function bardVoiceForSong(songIndex = 0, { duet = false } = {}) {
  const n = Number.isFinite(Number(songIndex)) ? Math.trunc(Number(songIndex)) : 0;
  const r = ((n % 5) + 5) % 5;
  if (duet || r === 4) return BARD_DUET;
  return BARD_VOICES[r % 2];
}
/** Make the singer unmissable to ACE: section tags in the lyrics themselves. */
export function tagLyricsForBard(lyrics, voice) {
  if (!voice) return lyrics;
  if (voice.gender === "duet") {
    return String(lyrics).replace("[Verse 1]", "[Verse 1 - Male Bard]").replace("[Verse 2]", "[Verse 2 - Female Bard]").replace("[Verse 3]", "[Verse 3 - Both Bards]").replaceAll("[Chorus]", "[Chorus - Both Bards]");
  }
  const who = voice.gender === "female" ? "Female Bard" : "Male Bard";
  return `[${voice.tag}]
${String(lyrics).replace("[Verse 1]", `[Verse 1 - ${who}]`).replace("[Verse 2]", `[Verse 2 - ${who}]`).replace("[Verse 3]", `[Verse 3 - ${who}]`)}`;
}
/** Chorus/verse lines rotate by seed (per song/lap) so no single line wears out its welcome. */
export function bawdyFragment(level, seed = 0) {
  const e = BAWDY_LINES[level] ?? BAWDY_LINES[Bawdy.BAWDY];
  const pick = (arr) => arr[Math.abs(Math.trunc(seed) || 0) % arr.length];
  return { chorus: pick(e.choruses), verse: pick(e.verses), prompt: e.prompt, crowd: e.crowd };
}

/** Prompt tags that make ACE-Step render tracks which loop back cleanly. */
export const LOOP_TAGS = "seamless loop, loopable, steady repeating groove, circular chord progression resolving back to the tonic at the end, no fade-out, no final ending flourish";


// --- Musical variety: abstract genre *craft* only (generic progressions,
// forms, grooves). No song titles, artists, melodies or lyric lines are
// stored or prompted; every pick is transposed, and progressions are
// regularly reversed/rotated, so output stays an original parody of a
// style's conventions rather than a copy of any work. -------------------
export function hashSeed(seed = 0) {
  let h = 2166136261;
  for (const ch of String(seed)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
const VT = (id, style, parody, progression, structure, o = {}) => ({ id, style, parody, progression, structure, bpmShift: o.bpm ?? 0, meter: o.meter ?? null, tonality: o.tonality ?? "minor", modes: o.modes ?? ["tavern", "combat", "bridge"], title: o.title ?? null });
export const MUSICAL_VARIETY = Object.freeze([
  VT("pop-anthem", "big singalong pop-anthem energy", "gleefully overblown tavern pop-anthem parody", ["i", "v", "III", "VII"], "verse-prechorus-chorus-bridge", { bpm: 10, title: "Dice Anthem" }),
  VT("chant-verse", "punchy half-spoken chant verses over a three-chord grind", "mock-heroic chant-song parody", ["i", "VI", "VII"], "chant-verses-big-hook", { bpm: -4, modes: ["tavern", "combat"], title: "One Roll Only" }),
  VT("rock-journey", "building folk-rock journey, quiet verse to roaring peak", "mock-epic stair-climbing rock parody without any borrowed riff", ["i", "VII", "III", "iv", "VI", "V"], "build-to-solo", { bpm: 2, title: "Long Road Rising" }),
  VT("two-chord-funk", "syncopated two-chord funk vamp, lute chops on the offbeat", "strutting funk-vamp parody", ["i7", "V7"], "vamp-and-breaks", { bpm: 4, title: "Gallows Strut" }),
  VT("chorus-first-country", "bright country-folk, chorus first and often", "pleading country-chorus parody", ["i", "III", "VII", "i"], "chorus-first", { bpm: 6, title: "Chorus First, Questions Later" }),
  VT("dance-lift", "folk-dance build into a drum-and-lute lift after each chorus", "festival dance-lift parody played on lute and bodhran", ["vi", "IV", "I", "V"], "verse-prechorus-lift", { bpm: 10, tonality: "major", title: "Wake the Rafters" }),
  VT("jazz-lilt", "swinging folk-jazz lilt, two-chord modal vamp, long solo trade-offs", "smug tavern-jazz parody", ["i", "v7"], "head-solos-head", { bpm: 8, meter: "6", title: "Smug Lilt in Six" }),
  VT("motif-classical", "short fateful motif developed and recapitulated like a miniature symphony", "mock-symphonic miniature parody with an original motif", ["i", "iv", "V7", "i"], "motif-development", { bpm: 0, title: "Little Fate Symphony" }),
  VT("minor-blues", "twelve-bar minor blues form, AAB complained-and-answered lines", "grumbling twelve-bar dice-blues parody", ["i", "iv", "VI", "V", "i"], "aab-blues", { bpm: -6, modes: ["tavern", "bridge"], title: "Soup-Bones Blues" }),
  VT("offbeat-reggae", "sunny offbeat lute chops, rolling hand-drum one-drop", "cheerfully unbothered offbeat parody", ["I", "IV", "V"], "chorus-first", { bpm: 8, tonality: "major", title: "Three Small Dice" }),
  VT("strophic-folk", "strophic folk verses, same tune, new scandal every verse", "earnest question-song folk parody", ["I", "IV", "V"], "strophic", { bpm: -4, tonality: "major", modes: ["tavern", "bridge"], title: "How Many Roads to Altdorf" }),
  VT("soul-shout", "two-chord soul groove, vocal call answered by plucky lute", "demanding soul-shout parody about respect for the dice", ["I7", "IV7"], "call-and-response", { bpm: 6, tonality: "major", title: "Spell It With Dice" }),
  VT("punk-blast", "three chords, maximum speed, zero ornament", "shouted three-chord punk parody", ["I", "IV", "V"], "verse-chorus-blast", { bpm: 20, tonality: "major", modes: ["combat", "tavern"], title: "Hey Ho Roll Low" }),
  VT("metal-riff", "heavy palm-muted lute riff, half-step menace, war-drum stomp", "mock-metal riff parody on acoustic instruments", ["i", "III", "II"], "riff-verses-solo", { bpm: 8, modes: ["combat", "bridge"], title: "Cellar Riff" }),
  VT("disco-strut", "four-on-the-floor bodhran disco strut, octave lute pops", "strutting disco-survival parody", ["i7", "VII"], "verse-chorus-strut", { bpm: 6, title: "Strut Past the Gallows" }),
  VT("house-loop", "hypnotic four-chord house loop turned into lute and tabor", "tavern house-loop parody", ["vi", "IV", "V", "I"], "loop-and-lift", { bpm: 10, tonality: "major", title: "Loop the Lantern" }),
  VT("pedal-build", "one-chord pedal build, breakdown and release", "mock-electronic build parody with only wood and skin", ["i"], "build-break-release", { bpm: 12, modes: ["combat", "bridge"], title: "Pedal-Tone Panic" }),
  VT("anthem-build", "soaring anthem build, breakdown then a huge final chorus", "overblown festival-anthem parody", ["i", "VI", "III", "VII"], "build-anthem", { bpm: 12, title: "Breakdown Anthem" }),
  VT("synth-minor", "icy three-chord minor hook with hurdy-gurdy as the synth", "deadpan synth-hook parody on hurdy-gurdy", ["i", "VI", "V"], "hook-verses", { bpm: 8, title: "Cold Hook, Cold Grave" }),
  VT("quiet-loud", "quiet-loud two-chord dynamics, whispered verse to shouted chorus", "brooding quiet-loud parody", ["i", "VII"], "quiet-loud-solo", { bpm: 6, title: "Quiet Verse, Loud Doom" }),
  VT("afro-groove", "lilting interlocking hand drums and lute, four-chord sway", "sun-drenched dance-groove parody", ["i", "VI", "III", "VII"], "groove-verses", { bpm: 4, title: "Four Chords and Sunshine" }),
  VT("andalusian-dance", "Andalusian descent with montuno-style plucky lute arpeggios", "flirting southern-dance parody", ["i", "VII", "VI", "V"], "montuno-call-response", { bpm: 10, title: "Andalusian Dice Dance" }),
  VT("ska-stabs", "racing offbeat ska chops, fiddle and flute stabs like horns", "rude-boy ska parody with fiddle stabs", ["I", "IV", "V"], "verses-hornbreak", { bpm: 14, tonality: "major", title: "Stop Rolling Like That" }),
  VT("bluegrass-break", "breakneck bluegrass picking, every instrument takes a break", "manic bluegrass-break parody", ["I", "IV", "V"], "verses-with-breaks", { bpm: 16, tonality: "major", title: "Breakneck Sorry Song" }),
  VT("americana-wheel", "rolling Americana four-chord wheel, fiddle solo turn", "wagon-train Americana parody", ["I", "V", "vi", "IV"], "verse-chorus-fiddlebreak", { bpm: 10, tonality: "major", title: "Wagon Wheel of Fate" }),
  VT("riff-garage", "one nagging original riff, verses hang off it (never quote a famous riff)", "minimal garage-riff parody", ["i", "III", "VI", "V"], "riff-verses", { bpm: 8, title: "One Riff Regiment" }),
]);
const KEY_POOL = {
  major: ["C major", "G major", "D major", "A major", "E major", "F major", "Bb major"],
  minor: ["A minor", "E minor", "B minor", "F# minor", "D minor", "G minor", "C minor"],
};
const NOTE_SEMITONE = { C: 0, "C#": 1, Db: 1, D: 2, Eb: 3, E: 4, F: 5, "F#": 6, Gb: 6, G: 7, Ab: 8, A: 9, Bb: 10, B: 11 };
const NOTE_NAMES = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];
const ROMAN_DEGREE = { I: 0, II: 1, III: 2, IV: 3, V: 4, VI: 5, VII: 6 };
export function chordsForProgression(keyScale, tokens = []) {
  const m = String(keyScale).match(/^([A-G](?:#|b)?)\s+(major|minor)$/i);
  if (!m) return tokens.join("–");
  const tonic = NOTE_SEMITONE[m[1]] ?? 0;
  const scale = m[2].toLowerCase() === "major" ? [0, 2, 4, 5, 7, 9, 11] : [0, 2, 3, 5, 7, 8, 10];
  return tokens.map((tok) => {
    const flat = tok.startsWith("b") && tok.length > 1 && /[iv]/i.test(tok[1]);
    const clean = flat ? tok.slice(1) : tok;
    const roman = clean.replace(/7|°/g, "").toUpperCase();
    const deg = ROMAN_DEGREE[roman] ?? 0;
    const note = NOTE_NAMES[(tonic + scale[deg] - (flat ? 1 : 0) + 12) % 12];
    const minorChord = /^[iv]/.test(clean) && clean.replace(/7|°/g, "") !== clean.replace(/7|°/g, "").toUpperCase();
    return `${note}${clean.includes("°") ? "dim" : minorChord ? (clean.includes("7") ? "m7" : "m") : (clean.includes("7") ? "7" : "")}`;
  }).join("–");
}
export function transformProgression(tokens = [], variant = 0) {
  const base = [...tokens];
  if (base.length < 2) return { tokens: base, label: "pedal" };
  if (variant % 4 === 1) return { tokens: [...base].reverse(), label: "reversed" };
  if (variant % 4 === 2) return { tokens: [...base.slice(1), base[0]], label: "rotated" };
  if (variant % 4 === 3) return { tokens: [...base].reverse().slice(1).concat(base.at(-1)), label: "reversed and rotated" };
  return { tokens: base, label: "straight" };
}
export const STYLE_LOOP_HOOKS = Object.freeze({
  "pop-anthem": "Every fist in the air for the roll that lights the hall!",
  "chant-verse": "One chance only — throw it true and shout it loud!",
  "rock-journey": "Every bend in the road makes the chorus climb!",
  "two-chord-funk": "Two chords only and the tavern floor still moves!",
  "chorus-first-country": "Please, dice, please, don't take my dignity home!",
  "dance-lift": "When the chorus lifts, kick the dust off doom!",
  "jazz-lilt": "Take the long way round and make the sorrow swing!",
  "motif-classical": "Four dark knocks and the whole road answers!",
  "minor-blues": "Same sad bones but a brand-new hurt to sing!",
  "offbeat-reggae": "Every small roll is a reason to stand in the sun!",
  "strophic-folk": "How many roads till the dice learn mercy?",
  "soul-shout": "Spell it out loud — D-I-C-E, come and save me!",
  "punk-blast": "Three chords, one shout, roll it before we count!",
  "metal-riff": "When the riff comes down, hold the gate or fall!",
  "disco-strut": "Keep on strutting while the doom keeps time!",
  "house-loop": "Round the loop and show the lantern light!",
  "pedal-build": "One chord rising till the whole den shakes!",
  "anthem-build": "Break it down, then roar it back as one!",
  "synth-minor": "Cold little hook and a colder grave!",
  "quiet-loud": "Whisper the verse, then shout down the dark!",
  "afro-groove": "Every hand on the drum makes worry miss a step!",
  "andalusian-dance": "Slow hips, fast hands, let the descent dance!",
  "ska-stabs": "Pick it up, pick it up — don't drop the roll!",
  "bluegrass-break": "Every string takes a turn at outrunning fate!",
  "americana-wheel": "Keep the wheel rolling through the carrion rain!",
  "riff-garage": "One sour riff and a regiment of bad ideas!",
});

const LOOP_FORM = (label, sections) => Object.freeze({ label, sections: Object.freeze(sections) });
const STANDARD_FORM = LOOP_FORM("verse-chorus loop", ["Intro", "Verse 1", "Chorus", "Verse 2", "Chorus"]);
export const LOOP_FORMS = Object.freeze({
  "verse-prechorus-chorus-bridge": LOOP_FORM("pre-chorus lift loop", ["Intro", "Verse 1", "Pre-Chorus", "Chorus", "Verse 2", "Pre-Chorus", "Chorus", "Bridge", "Chorus"]),
  "chant-verses-big-hook": LOOP_FORM("chant-and-hook loop", ["Intro", "Verse 1", "Chorus", "Verse 2", "Chorus"]),
  "build-to-solo": LOOP_FORM("journey-and-solo loop", ["Intro", "Verse 1", "Chorus", "Verse 2", "Instrumental", "Bridge", "Chorus"]),
  "vamp-and-breaks": LOOP_FORM("two-chord break loop", ["Verse 1", "Chorus", "Instrumental", "Verse 2", "Chorus"]),
  "chorus-first": LOOP_FORM("chorus-first loop", ["Intro", "Chorus", "Verse 1", "Chorus", "Verse 2", "Chorus"]),
  "verse-prechorus-lift": LOOP_FORM("lift-and-drop loop", ["Intro", "Verse 1", "Pre-Chorus", "Chorus", "Drop", "Verse 2", "Pre-Chorus", "Chorus", "Drop"]),
  "head-solos-head": LOOP_FORM("head-solos-head loop", ["Intro", "Chorus", "Verse 1", "Instrumental", "Verse 2", "Chorus"]),
  "motif-development": LOOP_FORM("motif-and-development loop", ["Intro", "Verse 1", "Chorus", "Bridge", "Verse 2", "Chorus"]),
  "aab-blues": LOOP_FORM("AAB twelve-bar loop", ["Verse 1", "Chorus", "Verse 2", "Chorus"]),
  "strophic": LOOP_FORM("strophic-refrain loop", ["Verse 1", "Verse 2", "Verse 3", "Chorus"]),
  "call-and-response": LOOP_FORM("call-and-response loop", ["Verse 1", "Chorus", "Verse 2", "Chorus", "Instrumental"]),
  "verse-chorus-blast": LOOP_FORM("blast-and-shout loop", ["Intro", "Verse 1", "Chorus", "Verse 2", "Chorus"]),
  "riff-verses-solo": LOOP_FORM("riff-and-solo loop", ["Intro", "Verse 1", "Chorus", "Instrumental", "Verse 2", "Chorus"]),
  "verse-chorus-strut": LOOP_FORM("strut loop", ["Intro", "Verse 1", "Pre-Chorus", "Chorus", "Verse 2", "Chorus"]),
  "loop-and-lift": LOOP_FORM("loop-and-lift cycle", ["Intro", "Verse 1", "Pre-Chorus", "Chorus", "Instrumental", "Verse 2", "Pre-Chorus", "Chorus"]),
  "build-break-release": LOOP_FORM("build-break-release loop", ["Intro", "Verse 1", "Chorus", "Bridge", "Verse 2", "Chorus"]),
  "build-anthem": LOOP_FORM("breakdown-anthem loop", ["Intro", "Verse 1", "Pre-Chorus", "Chorus", "Bridge", "Verse 2", "Chorus"]),
  "hook-verses": LOOP_FORM("hook-and-verse loop", ["Intro", "Chorus", "Verse 1", "Chorus", "Verse 2", "Chorus"]),
  "quiet-loud-solo": LOOP_FORM("quiet-loud loop", ["Intro", "Verse 1", "Chorus", "Instrumental", "Verse 2", "Chorus"]),
  "groove-verses": LOOP_FORM("groove-and-verse loop", ["Intro", "Verse 1", "Chorus", "Verse 2", "Chorus"]),
  "montuno-call-response": LOOP_FORM("montuno call loop", ["Intro", "Verse 1", "Pre-Chorus", "Chorus", "Instrumental", "Verse 2", "Pre-Chorus", "Chorus"]),
  "verses-hornbreak": LOOP_FORM("stab-and-break loop", ["Intro", "Verse 1", "Chorus", "Instrumental", "Verse 2", "Chorus"]),
  "verses-with-breaks": LOOP_FORM("everyone-takes-a-break loop", ["Verse 1", "Instrumental", "Chorus", "Verse 2", "Instrumental", "Chorus"]),
  "verse-chorus-fiddlebreak": LOOP_FORM("wheel-and-fiddle-break loop", ["Intro", "Verse 1", "Chorus", "Instrumental", "Verse 2", "Chorus"]),
  "riff-verses": LOOP_FORM("one-riff loop", ["Intro", "Verse 1", "Chorus", "Verse 2", "Chorus"]),
});

export function loopFormForTemplate(template) {
  return LOOP_FORMS[template?.structure] ?? STANDARD_FORM;
}

function progressionPlan(keyScale, tokens, variant) {
  const plan = (label, tokensTx) => {
    const romanTx = tokensTx.join("–");
    return { label, tokens: tokensTx, roman: romanTx, chords: chordsForProgression(keyScale, tokensTx), text: `${chordsForProgression(keyScale, tokensTx)} (${romanTx}, ${label})` };
  };
  return {
    verse: plan(transformProgression(tokens, variant).label, transformProgression(tokens, variant).tokens),
    chorus: plan(transformProgression(tokens, variant + 1).label, transformProgression(tokens, variant + 1).tokens),
    bridge: plan(transformProgression(tokens, variant + 2).label, transformProgression(tokens, variant + 2).tokens),
    finalChorus: plan(transformProgression(tokens, variant).label, transformProgression(tokens, variant).tokens),
  };
}

const IMPROVS = ["improvised plucky lute solo break", "improvised fiddle solo break", "improvised wooden-flute solo break", "hurdy-gurdy and lute trading improvised licks", "bodhran break with improvised lute fills", "improvised ornamented lute fills between phrases"];
/** Seeded style pick: neighbouring songs always change style, key and shape. */
export function pickMusicalVariety({ mode = Mode.TAVERN, songIndex = 0, seed = songIndex, forceMinor = false, preferMinor = false } = {}) {
  const pool = MUSICAL_VARIETY.filter((v) => v.modes.includes(mode === Mode.COMBAT ? "combat" : mode === "bridge" ? "bridge" : "tavern"));
  const h = hashSeed(seed);
  const n = Number.isFinite(Number(songIndex)) ? Math.trunc(Number(songIndex)) : 0;
  const template = pool[Math.abs(h % 97 + n * 7) % pool.length] ?? MUSICAL_VARIETY[0];
  const tonality = forceMinor || (preferMinor && template.tonality !== "major") ? "minor" : template.tonality;
  const keys = KEY_POOL[tonality];
  const keyScale = keys[Math.abs((h >> 7) % 89 + n * 5) % keys.length];
  const variant = (h >> 13) + n;
  const tx = transformProgression(template.progression, variant);
  const improv = IMPROVS[Math.abs((h >> 19) + n * 3) % IMPROVS.length];
  const roman = tx.tokens.join("–");
  const chords = chordsForProgression(keyScale, tx.tokens);
  const form = loopFormForTemplate(template);
  const harmony = progressionPlan(keyScale, template.progression, variant);
  const hook = STYLE_LOOP_HOOKS[template.id] ?? "Hey for the dice and ho for the doom, every roll tells another grim tale!";
  const loop = {
    styleId: template.id, form: form.label, sections: [...form.sections], hook,
    harmony, sectionText: form.sections.join(" -> "),
    instruction: `one continuous ${form.label}: ${form.sections.join(" -> ")}; verse harmony ${harmony.verse.text}; chorus harmony ${harmony.chorus.text}; bridge or solo harmony ${harmony.bridge.text}; final chorus returns to ${harmony.finalChorus.text}; keep the same ${hook}`,
  };
  return {
    template, styleId: template.id, keyScale, tonality, roman, chords,
    progressionLabel: `${chords} (${roman}, ${tx.label})`, transform: tx.label,
    bpmShift: template.bpmShift, meter: template.meter, structure: template.structure,
    improv, titleHint: template.title, loop,
    phrase: `${template.parody}, ${template.style}, original melody only (no borrowed tune, title or lyric), ${loop.instruction}, ${improv}, vary ornament and dynamics on every repeat without changing the loop's key, hook or chord cycle`,
  };
}

// Rotating filler verses so consecutive loops of the "same" song sing fresh
// lines around a stable chorus hook. The bawdy-level verse joins this pool.
const TAVERN_VERSE_POOL = [
  "The fire is low and the benches groan, every wanderer's welcome — no one dies alone.",
  "My lute is patched and my boots are thin, but the road keeps rhyming with the state I'm in.",
  "There's a song for the miller and a song for the thief, and a tune for the priest with a hole in his belief.",
  "Oh the moon's on the Reik and the barges glide, with a lantern, a lover, and the turning tide.",
  "Three pennies for supper and a song for the rest, the road's been unkind but this inn is the best.",
  "I have sung in Altdorf and I have sung in the rain, and the rain paid better — now sing it again.",
  "The plague cart creaks and the watchman yawns, so we sing a bit louder to frighten the dawns.",
  "Old Morr keeps a garden and tends it with care, we are all on his list — so refill, don't despair.",
  "The gallows tree blossoms with black little fruit, pass the bottle, good neighbour, and laugh in your boot.",
  "A mutant, a taxman, a priest walk in sore — the taxman is feared by the other two more.",
  "The witch hunter's knocking with a list and a brand, smile wide, sing sweet, keep your charms off your hand.",
  "The rats hold court in the cellar below, they have eaten the verdict and taxed what we owe.",
  "A pox took the miller, a flood took the mill, but the song keeps its chorus and the road climbs still.",
  "The bridge toll is corpses in the spring when it floods, we pay with our singing and a prayer in the mud.",
  "Sigmar's hammer hangs rusty and old, yet the fist that still swings it is worth more than gold.",
  "The dead pay no taxes, the dead owe no rent — the collector from Altdorf has not got the hint.",
  "A doomstone hums where the old road bends, we whistle straight past it and wave to our ends.",
  "My shadow grows horns when the moon's at its worst, so I sing to it nightly — better charmed than cursed.",
];
const COMBAT_VERSE_POOL = [
  "Shields together and the drum beats on, hold through the night till the foe is gone!",
  "Boots in the mud and steel in the rain, sing for the living, stand up again!",
  "The banner dips but it does not fall, answer the drum now, answer the call!",
  "Every heartbeat a drumbeat, every breath a blade, fight in the rhythm the fiddler made!",
  "Mud to the ankles and doom overhead, laugh in its face now or laugh when you're dead!",
  "The crows keep the score and the crows never lie, give them a chorus to scream at the sky!",
];

/** "{Name} the {Career}" when a career is known, else just the name. */
export function fallenLabel(death) {
  const name = String(death?.actor ?? death?.name ?? "Someone");
  const career = String(death?.career ?? "").trim();
  return career ? `${name} the ${career}` : name;
}

const rollFact = (d) => d ? [d.total != null ? `a ${d.total}` : "the bones", d.target != null ? `against ${d.target}` : "", d.flavor ? `on ${d.flavor}` : ""].filter(Boolean).join(" ") : "the bones";
const who = (a, careers) => careers?.[a.actor] ? `${a.actor} the ${careers[a.actor]}` : a.actor;
const CRIT_OPEN = ["Oh {who} rolled {fact} — pure Sigmar-touched", "Hear it for {who}: {fact}, clean as a chapel bell", "{who} threw {fact} and the dice stood to attention", "Mark {who}: {fact}, and even Morr looked up", "{who} rolled {fact} like the rent was due to Ranald", "Gold! {who}, {fact}, while the crows applauded"];
const CRIT_END = ["the rafters shook and the landlord wept glad", "buy that hero a sausage before luck sobers up", "the gallows outside got jealous of the drop", "somewhere a tax collector felt a chill", "the dice demanded an encore and a tip", "even the plague cart slowed down to watch"];
const FUM_OPEN = ["Poor {who} rolled {fact} — a symphony of soup", "{who} threw {fact} and the dice filed a complaint", "Oh {who}: {fact}. Morr checked his list twice", "{who} rolled {fact}; the table needed a priest and a mop", "Behold {who}: {fact}, artisanal disaster, locally sourced", "{who} cast {fact} and the candles pretended not to see"];
const FUM_END = ["we will sing of it until the bruises learn the words", "the dice are now in witness protection", "somewhere a goblin is telling it better", "that sound was dignity leaving by the back door", "even the rats asked for a refund", "a career highlight, if the career is falling over"];
const pickCombo = (opens, ends, a, v, careers, detail) => `${opens[Math.abs(v * 3 + a.actor.length) % opens.length].replace("{who}", who(a, careers)).replace("{fact}", rollFact(detail))}, ${ends[Math.abs(v * 5 + (detail?.total ?? 1)) % ends.length]}!`;
const detailFor = (details, a) => [...(details ?? [])].reverse().find((d) => d.actor === a.actor) ?? null;
const critLine = (a, v, careers = null, details = null) => `Critical! ${pickCombo(CRIT_OPEN, CRIT_END, a, v, careers, detailFor(details, a))}`;
const fumbleLine = (a, v, careers = null, details = null) => pickCombo(FUM_OPEN, FUM_END, a, v, careers, detailFor(details, a));
const critCombatLine = critLine;
const fumbleCombatLine = (a, v, careers = null, details = null) => `${pickCombo(FUM_OPEN, FUM_END, a, v, careers, detailFor(details, a)).replace(/!$/, "")} — get up, get up, die later!`;

/** Rotate through candidates from `start`, skipping excluded (recent) lines. Returns null when the pool is exhausted. */
function rotatePick(candidates, start, exclude) {
  for (let i = 0; i < candidates.length; i++) {
    const line = candidates[(start + i) % candidates.length];
    if (line && !exclude.has(line)) return line;
  }
  return null;
}

function loopLyrics({ pool, eventLines, chorusLines, loopIndex = 0, recentVerses = [], structure = "verse-chorus", form = null }) {
  const loopForm = form ?? LOOP_FORMS[structure] ?? STANDARD_FORM;
  const exclude = new Set(recentVerses);
  const picked = [];
  const take = (line) => { if (line && !picked.includes(line) && !exclude.has(line)) picked.push(line); };
  for (const line of eventLines.slice(0, 4)) take(line);
  let cursor = loopIndex * 2;
  while (picked.length < 4) {
    const line = rotatePick(pool, cursor, new Set([...exclude, ...picked]));
    cursor += 1;
    if (!line || picked.includes(line)) break;
    take(line);
  }
  const extras = [];
  while (extras.length < 3) {
    const line = rotatePick(pool, cursor, new Set([...exclude, ...picked, ...extras]));
    cursor += 1;
    if (!line || picked.includes(line) || extras.includes(line)) break;
    extras.push(line);
  }
  const [v1a, v1b, v2a, v2b] = [picked[0] ?? chorusLines[0], picked[1] ?? chorusLines[0], picked[2] ?? chorusLines[0], picked[3] ?? chorusLines[0]];
  const sections = {
    "Intro": ["[Intro]"],
    "Verse 1": ["[Verse 1]", v1a, v1b],
    "Verse 2": ["[Verse 2]", v2a, v2b],
    "Verse 3": ["[Verse 3]", extras[2] ?? v1b, extras[1] ?? v2a],
    "Pre-Chorus": ["[Pre-Chorus]", extras[0] ?? v2b],
    "Chorus": ["[Chorus]", ...chorusLines],
    "Bridge": ["[Bridge]", extras[1] ?? extras[0] ?? "Turn the wheel and turn the tale, let the old road rhyme again."],
    "Drop": ["[Drop]"],
    "Instrumental": ["[Instrumental]"],
  };
  let lines;
  if (structure === "aab-blues") {
    lines = ["[Verse 1]", v1a, v1a, v1b, "", "[Chorus]", ...chorusLines, "", "[Verse 2]", v2a, v2a, v2b, "", "[Chorus]", ...chorusLines];
  } else {
    lines = loopForm.sections.flatMap((section, i) => [...(i ? [""] : []), ...(sections[section] ?? sections.Chorus)]);
  }
  return {
    lyrics: lines.filter((l) => l != null).join("\n"),
    verseLines: picked,
    loopSections: [...loopForm.sections],
    loopForm: loopForm.label,
  };
}

function tavernLyrics(f, bawdy, loop = {}, requests = null, careers = null, story = null) {
  const b = bawdyFragment(bawdy, loop.songIndex ?? 0); // per SONG, not per lap — a song's chorus is stable across its laps, but rotates between songs
  const v = loop.loopIndex ?? 0;
  const eventLines = [];
  if (f.deaths?.length) eventLines.push(`We raise a cup for ${fallenLabel(f.deaths[f.deaths.length - 1])}, lost and gone before, Morr keep their soul forevermore.`);
  if (requests?.dedication) eventLines.push(`This one's for ${requests.dedication}, by special request, may your dice roll high and Morr lose your address!`);
  if (requests?.topic) eventLines.push(`You called for a song of ${requests.topic}, so hear it ring true, I polished this chorus especially for you!`);
  if (f.critActors.length) eventLines.push(critLine(f.critActors[v % f.critActors.length], v, careers, f.critDetails));
  if (f.fumbleActors.length) eventLines.push(fumbleLine(f.fumbleActors[v % f.fumbleActors.length], v, careers, f.fumbleDetails));
  if (f.wounds?.length) {
    const w = f.wounds[f.wounds.length - 1 - (v % f.wounds.length)];
    eventLines.push(`Poor ${w.actor} took a ${w.name}${w.location ? ` to the ${w.location}` : ""} full sore, I sang soft while they limped to the door.`);
  }
  if (f.corruptActors?.length) {
    eventLines.push(`A shadow touched ${f.corruptActors[0].actor} and my strings turned sour, one sad wrong note for corruption's dark hour.`);
  }
  if (!f.critActors.length && !f.fumbleActors.length && story?.topCritter) {
    eventLines.push(`Remember ${story.topCritter.label}: ${story.topCritter.crits} crits and counting, a legend the crows recite before mounting.`);
  } else if (!f.critActors.length && !f.fumbleActors.length && story?.topFumbler) {
    eventLines.push(`And ${story.topFumbler.label} still leads the fumbles with ${story.topFumbler.fumbles}, a crown no sane soul covets or crumbles.`);
  }
  if (!f.critActors.length && !f.fumbleActors.length && f.actors.length) {
    eventLines.push(`Here's to ${f.actors.slice(0, 3).join(", ")} and the road they tread, may their boots stay dry and their graves stay empty.`);
  }
  if (f.keywords.length) {
    const kw = [0, 1, 2].map((i) => f.keywords[(v + i) % f.keywords.length]);
    eventLines.push(`They talk of ${[...new Set(kw)].join(", ")} by candlelight, and argue it merry till deep in the night.`);
  }
  if (f.critActors.length > 1) eventLines.push(critLine(f.critActors[(v + 1) % f.critActors.length], v + 1, careers, f.critDetails));
  return loopLyrics({
    pool: [b.verse, ...TAVERN_VERSE_POOL],
    eventLines,
    chorusLines: [b.chorus, loop.hook ?? "Sing hey for the dice and ho for the grave, every roll tells a tale of the bold and the brave!"],
    ...loop,
  });
}

function combatLyrics(f, bawdy, loop = {}, requests = null, careers = null, story = null) {
  const b = bawdyFragment(bawdy, loop.songIndex ?? 0); // per SONG, not per lap — a song's chorus is stable across its laps, but rotates between songs
  const v = loop.loopIndex ?? 0;
  const eventLines = ["Steel is ringing and the drums beat fast, hold the line now, make every blow last!"];
  if (f.deaths?.length) eventLines.push(`For ${fallenLabel(f.deaths[f.deaths.length - 1])} fallen, we fight through grief and pain, their name upon our lips as we stand again!`);
  if (requests?.dedication) eventLines.push(`This one's for ${requests.dedication}, by special request, now charge like you mean it and give them no rest!`);
  if (requests?.topic) eventLines.push(`You called for a song of ${requests.topic} in the thick of the fray, I will sing it in blood till the end of the day!`);
  if (f.critActors.length) eventLines.push(critCombatLine(f.critActors[v % f.critActors.length], v, careers, f.critDetails));
  if (f.fumbleActors.length) eventLines.push(fumbleCombatLine(f.fumbleActors[v % f.fumbleActors.length], v, careers, f.fumbleDetails));
  if (f.wounds?.length) {
    const w = f.wounds[f.wounds.length - 1 - (v % f.wounds.length)];
    eventLines.push(`${w.actor} took a ${w.name}${w.location ? ` to the ${w.location}` : ""} yet stands tall, the bravest bloodied fool of all!`);
  }
  if (f.corruptActors?.length) eventLines.push(`Corruption kissed ${f.corruptActors[0].actor} and the strings went wrong, one sour note curdling the battle song.`);
  if (story?.fallen?.length && !f.deaths?.length) eventLines.push(`For ${story.fallen.at(-1)} watching from Morr's dark shore, hold the line, hold the line once more!`);
  if (f.flavors.length) eventLines.push(`By ${f.flavors[0]} the tide shall turn, let courage blaze and the banners burn!`);
  return loopLyrics({
    pool: COMBAT_VERSE_POOL,
    eventLines,
    chorusLines: ["Faster, faster, fiddle and drum, fight till the morning, fight till they run!", b.chorus, loop.hook ?? "Sing hey for the dice and ho for the fight, stand through the dark till morning light!"],
    ...loop,
  });
}

function bpmForMode(mode, f) {
  const moodLift = (f.meanNormalized - 0.5) * 20;
  const griefDrag = Math.min(f.deathCount ?? 0, 1);
  if (mode === Mode.COMBAT) {
    return Math.round(clamp(132 + f.crits * 4 - f.fumbles * 2 + moodLift + Math.min(f.critWounds, 2) * 6 - Math.min(f.corruptions, 2) * 2 - griefDrag * 8, 118, 165));
  }
  return Math.round(clamp(104 + f.crits * 6 - f.fumbles * 4 + moodLift + Math.min(f.rollCount, 12) - Math.min(f.critWounds, 2) * 8 - Math.min(f.corruptions, 2) * 4 - griefDrag * 12, 84, 136));
}

/**
 * Build an ACE-Step request for the next tavern/combat track. Consecutive
 * tracks in the same mode are loops of one song: the chorus hook is stable,
 * verses rotate (`loopIndex`) and never repeat `recentVerses` lines.
 * @returns {{prompt, lyrics, verseLines, bpm, keyScale, timeSignature, duration, title, why, features}}
 */
export function buildTrackRequest({ mode = Mode.TAVERN, rolls = [], chats = [], wounds = [], corruptions = [], deaths = [], bawdy = Bawdy.BAWDY, tavernDuration = 180, combatDuration = 180, loopIndex = 0, songIndex = loopIndex, varietySeed = songIndex, careers = null, story = null, recentVerses = [], requests = null } = {}) {
  const f = extractFeatures(rolls, chats, wounds, corruptions, deaths);
  const b = bawdyFragment(bawdy, songIndex);
  const voice = bardVoiceForSong(songIndex);
  const whyParts = [];
  const grief = f.deathCount > 0 || f.critWounds > 0 || f.corruptions > 0;
  const drunken = f.fumbles >= 2 && f.fumbles > f.crits;
  const variety = pickMusicalVariety({ mode, songIndex, seed: varietySeed, forceMinor: grief || drunken, preferMinor: mode === Mode.COMBAT });
  const loop = { loopIndex, songIndex, recentVerses, structure: variety.structure, form: loopFormForTemplate(variety.template), hook: variety.loop.hook };
  const dissonance = f.corruptions > 0 ? ", brief discordant detuned strings, one sad sour wrong note that slowly fades" : "";

  let bpm, keyScale, timeSignature, duration, prompt, built, title;
  if (mode === Mode.COMBAT) {
    bpm = clamp(bpmForMode(Mode.COMBAT, f) + variety.bpmShift + (requests?.tempoShift ?? 0), 118, 168);
    keyScale = variety.keyScale;
    timeSignature = variety.meter ?? "4";
    duration = combatDuration;
    prompt = `${voice.prompt}. Fast medieval tavern battle music, grimdark gallows humour, lyrics sung in English only, ${variety.phrase}, bright plucky lute lead, driving fiddle, war drum and frame drum, hurdy-gurdy, urgent dance jig, lively and energetic, ${LOOP_TAGS}${requests?.mood?.length ? `, ${requests.mood.join(", ")}` : ""}, ${b.prompt}${dissonance}`;
    built = combatLyrics(f, bawdy, loop, requests, careers, story);
    title = variety.titleHint ?? "Combat Jig";
    whyParts.push(`combat → faster (${bpm} BPM, ${keyScale})`);
  } else {
    bpm = clamp(bpmForMode(Mode.TAVERN, f) + variety.bpmShift + (requests?.tempoShift ?? 0), 84, 142);
    timeSignature = drunken ? "3" : (f.crits >= 3 ? "6" : (variety.meter ?? "4"));
    keyScale = variety.keyScale;
    duration = tavernDuration;
    prompt = `${voice.prompt}. Lively medieval tavern folk, grimdark gallows humour that keeps laughing at doom, all lyrics sung in English only, ${variety.phrase}, bright plucky lute lead with crisp fingerpicked lute ostinato, fiddle, prominent bodhran and frame drum groove, wooden flute, upbeat toe-tapping energy, dry recording, ${LOOP_TAGS}${requests?.mood?.length ? `, ${requests.mood.join(", ")}` : ""}, ${b.prompt}${dissonance}`;
    built = tavernLyrics(f, bawdy, loop, requests, careers, story);
    title = drunken ? "The Drunken Waltz" : (variety.titleHint ?? (f.crits >= 2 ? "Golden Dice Reel" : "Gallows Song"));
    if (drunken) whyParts.push(`${f.fumbles} fumbles → drunken 3/4 waltz`);
    else if (f.crits >= 3) whyParts.push(`${f.crits} crits → jig time (6/8)`);
  }
  whyParts.push(`bard: ${voice.label}; loop: ${variety.loop.form} [${variety.loop.sectionText}]; style: ${variety.styleId} in ${keyScale} (${variety.progressionLabel})`);
  for (const d of f.deaths.slice(-2)) whyParts.push(`Death: ${fallenLabel(d)} has died → memorial verse`);
  if (f.critActors.length) whyParts.push(`crits: ${f.critActors.map((a) => `${a.actor}×${a.count}`).join(", ")} → rowdier verse`);
  if (f.fumbleActors.length) whyParts.push(`fumble: ${f.fumbleActors.map((a) => a.actor).join(", ")} → mocking verse`);
  for (const w of f.wounds.slice(-2)) whyParts.push(`Critical Wound: ${w.actor} (${w.name}) → grim verse`);
  if (f.corruptActors.length) whyParts.push(`Corruption: ${f.corruptActors.map((a) => `${a.actor}×${a.count}`).join(", ")} → discordant note`);
  if (f.keywords.length) whyParts.push(`chat talk of ${f.keywords.slice(0, 3).join(", ")}`);
  if (whyParts.length <= 1) whyParts.push("quiet table → steady tavern standard"); // <=1: the bard line alone
  if (requests && !requests.empty) {
    const bits = [];
    if (requests.tempoShift) bits.push(requests.tempoShift > 0 ? "faster" : "slower");
    if (requests.mood?.length) bits.push(requests.mood.join(" + "));
    if (requests.topic) bits.push(`about "${requests.topic}"`);
    if (requests.dedication) bits.push(`for ${requests.dedication}`);
    if (requests.encore) bits.push("encore");
    if (bits.length) whyParts.push(`by request: ${bits.join(", ")}`);
  }
  if (loopIndex > 0) whyParts.push(`loop ${loopIndex + 1}: fresh verses in the ${variety.loop.form}`);

  if (story) whyParts.push("long-term story stats fed the verse");
  return { prompt, lyrics: tagLyricsForBard(built.lyrics, voice), verseLines: built.verseLines, loopSections: built.loopSections, loopForm: built.loopForm, loopHook: variety.loop.hook, bpm, keyScale, timeSignature, duration, title, why: whyParts.join("; "), features: f, songIndex, bard: voice, variety, varietySeed, aceSeed: hashSeed(`${varietySeed}:${songIndex}`), careers: careers ?? null, story: story ?? null };
}

/**
 * Build the dirge for a fallen player character: a slow, reverent one-shot
 * lament (never a loop, never bawdy) that names the dead and their career.
 * @param {{death:{actor:string, career?:string|null, cause?:string|null}, dirgeDuration?:number}} args
 * @returns {{prompt, lyrics, verseLines, bpm, keyScale, timeSignature, duration, title, why, features}}
 */
export function buildDirgeRequest({ death, dirgeDuration = 180, songIndex = 0, varietySeed = songIndex } = {}) {
  const name = String(death?.actor ?? death?.name ?? "Someone");
  const career = String(death?.career ?? "").trim() || null;
  const fallen = fallenLabel({ actor: name, career });
  const calling = career
    ? `No road shall call the ${career} now, no wage, no work, no war,`
    : "No road shall call them homeward now, no wage, no work, no war,";
  const causeLine = death?.cause
    ? `Struck down, struck down — ${death.cause} — and the firelight seemed to dim,`
    : "The dice fell silent on the board, and the firelight seemed to dim,";
  const lyrics = [
    "[Verse 1]",
    `Lay down the arms of ${fallen}, the long road's reached its end,`,
    causeLine,
    "we sang for gold and glory once — now sing for a fallen friend.",
    "",
    "[Chorus]",
    `Gone, gone, ${fallen} is gone, and Morr has closed the door,`,
    `ring low, ring slow for ${name}, who shall come home no more.`,
    "",
    "[Verse 2]",
    calling,
    `the ${career ?? "wanderer"}'s tools lie still at last, the weary hands at rest,`,
    `we'll carve the name of ${name} deep, and lay a stone upon their breast.`,
    "",
    "[Chorus]",
    `Gone, gone, ${fallen} is gone, and Morr has closed the door,`,
    `ring low, ring slow for ${name}, who shall come home no more.`,
    "",
    "[Verse 3]",
    `So drink one quiet cup for ${fallen}, then set the cup down dry,`,
    "and if the bards must sing tonight, they'll sing them to the sky.",
  ].join("\n");
  return {
    prompt: `${BARD_VOICES[((songIndex % 2) + 2) % 2].prompt}. Somber medieval funeral dirge with English-only lyrics, chord progression ${pickMusicalVariety({ mode: "tavern", songIndex, seed: varietySeed, forceMinor: true }).progressionLabel}, slow solemn mourning lament, sparse plucked lute, low frame drum like a slowing heartbeat, distant tolling hand bell, funeral march, grief and quiet dignity, gentle final cadence fading to silence, no crowd noise, no group chorus, no background chatter`,
    lyrics: tagLyricsForBard(lyrics, BARD_VOICES[((songIndex % 2) + 2) % 2]),
    verseLines: [],
    bpm: 60,
    keyScale: pickMusicalVariety({ mode: "tavern", songIndex, seed: varietySeed, forceMinor: true }).keyScale,
    timeSignature: "4",
    duration: clamp(dirgeDuration, 60, 300),
    title: `Dirge for ${name}`,
    why: `Death: ${fallen} has died → dirge; bard: ${BARD_VOICES[((songIndex % 2) + 2) % 2].label}`,
    songIndex, bard: BARD_VOICES[((songIndex % 2) + 2) % 2], varietySeed, aceSeed: hashSeed(`dirge:${varietySeed}:${songIndex}`),
    features: extractFeatures([], [], [], [], [{ actor: name, career, cause: death?.cause ?? null }]),
  };
}

const normJoke = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
/** Fresh one-liner built from the latest actual roll; never repeats a recent joke. */
export function freshRollJoke(f, { seed = 0, recentJokes = [], careers = null } = {}) {
  const seen = new Set(recentJokes.map(normJoke));
  const cands = [];
  const fum = f?.fumbleDetails?.at(-1), crit = f?.critDetails?.at(-1), last = f?.latestRoll;
  const name = (d) => d ? (careers?.[d.actor] ? `${d.actor} the ${careers[d.actor]}` : d.actor) : "Someone";
  if (fum) for (const end of ["the dice have retained a witch hunter", "Morr checked the list, then checked it again", "the rats under the floor won money on that", "dignity left by the back door and took the good cloak", "somewhere a goblin tells it taller", "the candles pretended not to see", "Ranald is framing that one", "the watch wrote it down as a public nuisance"]) cands.push(`${name(fum)} rolled ${rollFact(fum)} — ${end}.`);
  if (crit) for (const end of ["Sigmar is claiming he taught them that", "the gallows got jealous of the drop", "even the tax collector felt a chill", "the crows are asking for an encore", "luck like that gets audited in Altdorf", "the dice demanded a tip and a sausage"]) cands.push(`${name(crit)} rolled ${rollFact(crit)} — ${end}.`);
  if (last && !fum && !crit) for (const end of ["not heroic, not fatal: the Empire's favourite flavour", "the dice shrugged in Old Reikspiel", "Morr yawned and went back to gardening", "a roll so average it qualifies for a pension"]) cands.push(`${name(last)} rolled ${rollFact(last)} — ${end}.`);
  for (const w of f?.wounds ?? []) cands.push(`${w.actor} took a ${w.name}${w.location ? ` to the ${w.location}` : ""} — on the bright side, the screaming was in tune.`);
  const factual = [...cands];
  cands.push(...INTERLUDE_JOKES_FALLBACK);
  const pool = factual.length ? factual : cands; // true roll jokes first; generics only when nothing happened
  const start = hashSeed(seed) % pool.length;
  for (let i = 0; i < pool.length; i++) { const j = pool[(start + i) % pool.length]; if (!seen.has(normJoke(j))) return j; }
  for (const j of cands) if (!seen.has(normJoke(j))) return j;
  return pool[start];
}
const INTERLUDE_JOKES_FALLBACK = [
  "I asked Morr for an encore. He said everyone gets exactly one final bow.",
  "My lute has six strings and no regrets — that is five more strings than sense, mind you.",
  "A dwarf walks under a bar. Lucky. The elf before him walked into it twice.",
  "The landlord calls it stew because 'evidence' tests poorly with travellers.",
];
// One-liners the bard drops between songs on every third plucky interlude.


/**
 * Build a bridge/interlude request: the loop layer played between vocal
 * roll-songs (padding time while the next song composes) and between
 * styles (tempo blends from `fromMode` toward `mode` on a transition).
 * Outside combat these are long (5-10 min), lively plucky-lute interludes
 * with prominent drums; every third drops a single spoken tavern joke.
 * Combat bridges stay short and driving.
 * @returns {{prompt, lyrics, verseLines, instrumental, joke, minDwellSec, bpm, keyScale, timeSignature, duration, title, why, features}}
 */
export function buildBridgeRequest({ mode = Mode.TAVERN, fromMode = null, rolls = [], chats = [], wounds = [], corruptions = [], deaths = [], bridgeDuration = 360, bridgeIndex = 0, varietySeed = bridgeIndex, recentJokes = [], careers = null, flavor = "strum", requests = null, pairVariety = null } = {}) {
  const f = extractFeatures(rolls, chats, wounds, corruptions, deaths);
  const variety = pairVariety ?? pickMusicalVariety({ mode: mode === Mode.COMBAT ? Mode.COMBAT : "bridge", songIndex: bridgeIndex, seed: varietySeed, forceMinor: f.deathCount > 0 || f.critWounds > 0 || f.corruptions > 0, preferMinor: mode === Mode.COMBAT });
  const loop = variety.loop;
  const bridgeStyle = `${variety.template.parody}, ${variety.template.style}, chord progression ${variety.progressionLabel}, one continuous ${loop.form}: ${loop.sectionText}; verse harmony ${loop.harmony.verse.text}; chorus harmony ${loop.harmony.chorus.text}; bridge or solo harmony ${loop.harmony.bridge.text}; instrumental hook motif "${loop.hook}" played on plucky lute (never sung), trading improvised solos between plucky lute, fiddle and wooden flute, builds and breakdowns so a long stretch never sits still${pairVariety ? "; paired with the next vocal loop: same style, key, hook and chord cycle" : ""}`;
  const transitioning = fromMode && fromMode !== mode;
  const dissonance = f.corruptions > 0 ? ", one brief discordant detuned string figure that slowly fades" : "";

  if (mode === Mode.COMBAT) {
    const target = bpmForMode(Mode.COMBAT, f);
    const bpm = clamp((transitioning ? Math.round((bpmForMode(fromMode, f) + target) / 2) : target) + clamp(variety.bpmShift, -4, 10) + (requests?.tempoShift ?? 0), 118, 168);
    return {
      prompt: `instrumental medieval battle bridge, grimdark energy, ${bridgeStyle}, bright plucky lute riffs, driving fiddle ostinato, prominent war drum, frame drum and bodhran pulse, hurdy-gurdy drone, lively and urgent, no vocals, no singing, no lyrics, ${LOOP_TAGS}${dissonance}`,
      lyrics: "[Instrumental]",
      verseLines: [],
      instrumental: true,
      joke: null,
      minDwellSec: 15,
      bpm,
      keyScale: variety.keyScale,
      timeSignature: variety.meter ?? "4",
      duration: clamp(bridgeDuration, 30, 180),
      title: "War-Drum Bridge",
      loopForm: loop.form, loopSections: [...loop.sections], loopHook: loop.hook,
      why: `${transitioning ? `bridge ${fromMode} → ${mode}; ` : "instrumental bridge loop; "}loop: ${loop.form} [${loop.sectionText}]; style: ${variety.styleId} (${bpm} BPM, ${variety.keyScale}, ${variety.progressionLabel})`,
      features: f, variety, varietySeed, aceSeed: hashSeed(`bridge:${varietySeed}:${bridgeIndex}`),
    };
  }

  const livelyTarget = clamp(bpmForMode(Mode.TAVERN, f) + 6, 96, 128);
  const bpm = clamp((transitioning ? Math.round((bpmForMode(fromMode, f) + livelyTarget) / 2) : Math.round(livelyTarget)) + clamp(variety.bpmShift, -4, 12) + (requests?.tempoShift ?? 0), 88, 142);
  const keyScale = variety.keyScale;
  const duration = clamp(bridgeDuration, 60, 600);
  const joke = bridgeIndex % 3 === 2 ? freshRollJoke(f, { seed: varietySeed, recentJokes, careers }) : null;
  const instruments = flavor === "drum"
    ? "prominent bodhran, frame drum and tabor groove with hand percussion, bright plucky lute riffs, lively fiddle fills"
    : flavor === "mixed"
      ? "bright plucky lute lead and rhythmic lute strumming over a prominent bodhran, frame drum and tabor groove, lively fiddle and wooden flute fills"
      : "bright plucky lute lead with crisp fingerpicked ostinato, prominent bodhran and frame drum groove, lively fiddle fills";
  return {
    prompt: `lively medieval tavern interlude, grimdark gallows humour in the playing, ${bridgeStyle}, ${instruments}, upbeat toe-tapping danceable groove, energetic plucky lute and drums, ${LOOP_TAGS}${dissonance}${joke ? ", mostly instrumental with one brief spoken tavern joke in English from the bard, then straight back to lively plucky lute and drums" : ", no vocals, no singing, no lyrics"}`,
    lyrics: joke ? `[Instrumental]\n[Spoken]\n${joke}\n[Instrumental]` : "[Instrumental]",
    verseLines: [],
    instrumental: true,
    joke,
    minDwellSec: 90,
    bpm,
    keyScale,
    timeSignature: variety.meter ?? "4",
    duration,
    title: "Plucky Interlude",
    loopForm: loop.form, loopSections: [...loop.sections], loopHook: loop.hook,
    why: `${transitioning ? `bridge ${fromMode} → ${mode}; ` : ""}lively plucky interlude loop; loop: ${loop.form} [${loop.sectionText}]; style: ${variety.styleId} (${bpm} BPM, ${keyScale}, ${variety.progressionLabel}, ${duration}s${joke ? ", with a fresh joke" : ""})`,
    features: f, variety, varietySeed, aceSeed: hashSeed(`bridge:${varietySeed}:${bridgeIndex}`),
  };
}

/**
 * Deterministic pregeneration plan for a lively bridge library. 48 tracks
 * of 5-10 minutes average ~6 hours of unique interludes: over a 24-hour
 * session each one returns about four times, hours apart. Zero repeats
 * for 24h would need 144 ten-minute (or 288 five-minute) tracks.
 * @returns {Array<{index, flavor, duration, bpm, keyScale, seed}>}
 */
export function planLibraryTracks(count = 48) {
  const flavors = ["strum", "drum", "strum", "mixed", "strum", "drum"];
  return Array.from({ length: count }, (_, i) => {
    const seed = 4100 + i * 97;
    const variety = pickMusicalVariety({ mode: "bridge", songIndex: i, seed });
    return {
      index: i,
      flavor: flavors[i % flavors.length],
      duration: 300 + ((i * 137) % 301),
      bpm: Math.round(clamp(108 + variety.bpmShift + ((i * 7) % 13) - 6, 96, 132)),
      keyScale: variety.keyScale,
      styleId: variety.styleId,
      progression: variety.progressionLabel,
      loopForm: variety.loop.form,
      loopSections: [...variety.loop.sections],
      loopHook: variety.loop.hook,
      seed,
    };
  });
}
