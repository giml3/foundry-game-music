// LRCLIB parody core (pure, browser-safe). The GM-side parody sidecar picks
// a random song from the local LRCLIB dump and reduces its lyrics to a
// structural skeleton — stanza shapes, syllable counts, rhyme scheme. Only
// that skeleton (never the source words) reaches the purpose-built tiny
// LLM, and its output is screened against the source before a bard sings
// it: any shared line or 5-word run sends it back. Source lyrics never
// leave the GM machine.

const clip = (s, n) => String(s ?? "").slice(0, n);

export function syllableCount(line) {
  const words = String(line ?? "").toLowerCase().match(/[a-z']+/g) ?? [];
  let total = 0;
  for (const w of words) {
    const groups = w.replace(/e$/, "").match(/[aeiouy]+/g);
    total += Math.max(1, groups ? groups.length : 1);
  }
  return total;
}

function rhymeKey(line) {
  const words = String(line ?? "").toLowerCase().match(/[a-z']+/g);
  if (!words?.length) return "";
  const last = words.at(-1).replace(/'/g, "");
  const m = last.match(/[aeiouy]+[^aeiouy]*$/);
  return m ? m[0] : last.slice(-2);
}

/**
 * Reduce plain lyrics to a singable skeleton: per-stanza line counts,
 * per-line syllable counts and an A/B/C rhyme scheme. Timestamps and
 * bracketed stage directions are dropped; words are never kept.
 */
export function lyricSkeleton(plainLyrics, { maxStanzas = 6, maxLines = 28 } = {}) {
  const clean = String(plainLyrics ?? "")
    .replace(/\[\d{1,2}:\d{2}(?:[.:]\d{1,3})?\]/g, "")
    .replace(/\[[^\]]*\]/g, "");
  const stanzas = [];
  let lineTotal = 0;
  for (const block of clean.split(/\n\s*\n/)) {
    const lines = block.split("\n").map((l) => l.trim()).filter(Boolean);
    if (!lines.length || stanzas.length >= maxStanzas || lineTotal >= maxLines) continue;
    const take = lines.slice(0, Math.max(0, maxLines - lineTotal));
    const keys = take.map(rhymeKey);
    const seen = new Map();
    let next = 0;
    const scheme = keys.map((k) => {
      if (!k) return "-";
      if (!seen.has(k)) seen.set(k, String.fromCharCode(65 + next++));
      return seen.get(k);
    }).join("");
    stanzas.push({ lines: take.length, syllables: take.map(syllableCount), scheme });
    lineTotal += take.length;
  }
  return {
    stanzas,
    lineCount: lineTotal,
    avgSyllables: lineTotal ? Math.round(stanzas.flatMap((s) => s.syllables).reduce((a, b) => a + b, 0) / lineTotal) : 0,
  };
}

/** Prompt for the purpose-built tiny LLM. Contains no source wording. */
export function buildParodyPrompt({ skeleton, facts = [], storyLines = [], bardLabel = "", bawdy = "bawdy", styleId = "", keyScale = "", loopSections = [], loopHook = "", party = [], enemies = [], mode = "tavern" } = {}) {
  const partyLine = party.length ? `Party (cheer them, name them): ${party.map((p) => `${p.name ?? "?"}${p.career ? ` the ${p.career}` : ""}`).join("; ")}.` : "";
  const enemyLine = enemies.length ? `Current enemy (mock them mercilessly${mode === "combat" ? ", this is a battle song against them" : ""}): ${enemies.map((p) => `${p.name ?? "?"}${p.type ? ` (${p.type})` : ""}`).join("; ")}.` : "";
  const shape = (skeleton?.stanzas ?? []).map((s, i) => `Stanza ${i + 1}: ${s.lines} lines, syllables ${s.syllables.join("/")}, rhyme scheme ${s.scheme}`).join("\n");
  return [
    "Write an ORIGINAL grimdark tavern parody song for a Warhammer-style game, built on the song skeleton below (a classic song's stanza shapes, line lengths and rhyme scheme — its words are deliberately withheld; invent every word yourself).",
    "Parody the conventions and shape only: never copy, quote, rewrite or closely imitate any existing song's lyrics, title, hook or melody, and never name a real song, band or artist. Grimdark gallows humour: plague, Morr, gallows, mud, taxes, doom — with jokes to lighten it.",
    shape ? `Skeleton (match these stanza shapes, syllable counts and rhyme schemes):\n${shape}` : "Skeleton: four-line stanzas, about 8 syllables a line, ABAB rhymes.",
    `Style: ${clip(styleId, 40) || "tavern folk"} in ${clip(keyScale, 20)}, sung by the ${clip(bardLabel, 60) || "bard"}. Bawdy level: ${bawdy} (clean = family-friendly).`,
    loopSections.length ? `Fit the words into exactly these loop blocks, same tags in the same order and count: ${loopSections.map((s) => `[${s}]`).join(" ")}. Keep any " - Male Bard" / " - Female Bard" / " - Both Bards" qualifiers.` : "Use [Verse]/[Chorus] markers.",
    loopHook ? `Keep this chorus hook word-for-word in every [Chorus]: "${clip(loopHook, 160)}"` : "",
    partyLine,
    enemyLine,
    facts.some((f) => /^CRITICAL:/.test(f)) ? "CRITICAL CALLOUT (mandatory): shout every CRITICAL fact — include a line beginning \"Critical!\" naming the hero and their roll." : "",
    facts.length ? `Work THESE true dice facts into fresh jokes (do not invent other heroes):\n${facts.map((f) => `- ${f}`).join("\n")}` : "No big rolls lately: joke about dice, fate, taxes and Morr generally.",
    storyLines.length ? `Long-term saga (drop at most one callback):\n${storyLines.slice(0, 5).map((l) => `- ${clip(l, 140)}`).join("\n")}` : "",
    "Return ONLY the parody lyrics.",
  ].filter(Boolean).join("\n");
}

const normWords = (text) => String(text ?? "").toLowerCase().match(/[a-z0-9']+/g) ?? [];

export function wordNGrams(text, n = 5) {
  const w = normWords(text);
  const out = new Set();
  for (let i = 0; i + n <= w.length; i++) out.add(w.slice(i, i + n).join(" "));
  return out;
}

/**
 * Fail-closed screen: the parody must share no full line (4+ words) and no
 * 5-word run with the source lyrics. Returns the text, or `fallback`.
 */
export function screenParodyLyrics(text, sourceLyrics, fallback = null) {
  const out = String(text ?? "").trim();
  if (!out) return fallback;
  const sourceGrams = wordNGrams(sourceLyrics, 5);
  for (const g of wordNGrams(out, 5)) if (sourceGrams.has(g)) return fallback;
  const sourceLines = new Set(String(sourceLyrics ?? "").split("\n").map((l) => normWords(l).join(" ")).filter((l) => l.split(" ").length >= 4));
  for (const l of out.split("\n")) if (sourceLines.has(normWords(l).join(" "))) return fallback;
  return out;
}

const THEME_STOP = new Set("the and for with that this from have will just like into your you are was were been has had not but all can out who get got let say see she her his him they them then than too very over under again once here there when where which while about would could should their these those being yeah oh la na gonna wanna".split(" "));

/** Top theme words of a lyric sheet. Sidecar-local: never sent to browsers. */
export function themeTagsOf(plainLyrics, limit = 6) {
  const counts = new Map();
  for (const w of String(plainLyrics ?? "").toLowerCase().match(/[a-z][a-z'-]{3,}/g) ?? []) {
    if (!THEME_STOP.has(w)) counts.set(w, (counts.get(w) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, limit).map(([w]) => w);
}

/** Prompt asking the tiny LLM to pick the candidate skeleton fitting party + enemy. Tags only — no lyric lines. */
export function buildFitPrompt({ candidates = [], party = [], enemies = [], mode = "tavern" } = {}) {
  const who = (list) => list.map((p) => `${p.name ?? "?" }${p.career ? ` the ${p.career}` : ""}${p.type ? ` (${p.type})` : ""}`).join("; ") || "none known";
  return [
    "Pick the ONE song skeleton whose themes best fit this adventuring party and their current enemy, for a grimdark tavern parody. Combat songs should feel like facing the enemy; tavern songs should flatter/mocking the party.",
    `Mode: ${clip(mode, 20)}`,
    `Party: ${who(party)}`,
    `Enemy: ${who(enemies)}`,
    "Candidates (index: theme tags; stanza shape):",
    ...candidates.map((c, i) => `${i}: ${c.tags.join(", ") || "plain"}; ${c.stanzas} stanzas, ~${c.avgSyllables} syllables/line`),
    "Return ONLY the candidate number, nothing else.",
  ].join("\n");
}

const contextTerms = (party = [], enemies = []) => {
  const text = [...party, ...enemies].map((p) => `${p.name ?? ""} ${p.career ?? ""} ${p.type ?? ""}`).join(" ").toLowerCase();
  return new Set(text.match(/[a-z][a-z'-]{3,}/g) ?? []);
};

/** Local fallback fit score: theme-tag overlap with party/enemy terms. */
export function scoreCandidateFit(candidate, party = [], enemies = []) {
  const terms = contextTerms(party, enemies);
  let score = 0;
  for (const tag of candidate?.tags ?? []) {
    if (terms.has(tag)) score += 2;
    else if ([...terms].some((t) => tag.startsWith(t.slice(0, 4)) || t.startsWith(tag.slice(0, 4)))) score += 1;
  }
  return score;
}

/** Ask the GM-side parody sidecar for one fresh screened parody song. */
export async function fetchParodySong({ baseUrl, fetchImpl = null, timeoutMs = 25000, payload = {} } = {}) {
  if (!baseUrl) throw new Error("Parody sidecar URL not configured");
  const doFetch = fetchImpl ?? ((...a) => globalThis.fetch(...a));
  const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
  try {
    const res = await doFetch(`${String(baseUrl).replace(/\/+$/, "")}/parody`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      ...(ctrl ? { signal: ctrl.signal } : {}),
    });
    if (!res.ok) throw new Error(`Parody sidecar HTTP ${res.status}`);
    const json = await res.json();
    if (!json?.lyrics) throw new Error("Parody sidecar returned no lyrics");
    return { lyrics: String(json.lyrics), source: json.source ?? null, skeleton: json.skeleton ?? null, fit: json.fit ?? null };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
