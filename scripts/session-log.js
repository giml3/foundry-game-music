// Rolling session log: dice rolls + public chat + combat markers for the
// last 2-3 hours. Pure module (no Foundry globals) so parsing/pruning is
// unit-testable; main.js adapts real ChatMessage/Roll objects into the
// plain shapes consumed here.
import { LOG_MAX_EVENTS, LOG_WINDOW_MS, MUSE_MAX_ROLLS, MUSE_WINDOW_MS } from "./constants.js";

/** Strip HTML from chat content and collapse it to a single safe line. */
export function sanitizeChatText(content, maxLen = 300) {
  let s = String(content ?? "");
  s = s.replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ");
  s = s.replace(/<[^>]*>/g, " ");
  s = s
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'");
  s = s.replace(/\s+/g, " ").trim();
  return s.length > maxLen ? s.slice(0, maxLen - 1) + "…" : s;
}

/**
 * Normalize one Foundry-like roll into muse features.
 * Accepts a real Roll or a plain test double:
 * { total, formula, dice:[{faces, values|results:[{result}|number]}], isCritical, isFumble }
 */
export function parseRoll(roll) {
  if (!roll || typeof roll !== "object") return null;
  const total = Number(roll.total);
  const dice = [];
  const rawDice = Array.isArray(roll.dice) ? roll.dice : [];
  for (const d of rawDice) {
    const faces = Number(d?.faces) || 0;
    const vals = [];
    const src = d?.values ?? d?.results ?? [];
    for (const v of src) {
      const n = typeof v === "number" ? v : Number(v?.result);
      if (Number.isFinite(n)) vals.push(n);
    }
    if (faces > 0) dice.push({ faces, values: vals });
  }
  // Natural d20 detection: exactly one d20 in the pool.
  let natural = null;
  const d20s = dice.filter((d) => d.faces === 20);
  if (d20s.length === 1 && d20s[0].values.length === 1) natural = d20s[0].values[0];
  const isCrit = Boolean(roll.isCritical ?? roll.isCrit ?? (natural === 20));
  const isFumble = Boolean(roll.isFumble ?? (natural === 1));
  // Normalized 0..1 position of the total within the dice pool's range (ignores flat mods
  // only approximately — good enough for mood, and crits/fumbles dominate the mapping).
  let normalized = null;
  if (dice.length && Number.isFinite(total)) {
    const count = dice.reduce((a, d) => a + Math.max(d.values.length, 0), 0);
    const max = dice.reduce((a, d) => a + d.faces * Math.max(d.values.length, 0), 0);
    if (count > 0 && max > count) normalized = Math.min(1, Math.max(0, (total - count) / (max - count)));
    else if (natural != null) normalized = (natural - 1) / 19;
  } else if (natural != null) normalized = (natural - 1) / 19;
  return {
    total: Number.isFinite(total) ? total : null,
    formula: String(roll.formula ?? ""),
    dice, natural, isCrit, isFumble, normalized,
  };
}

const clamp01 = (n) => Math.min(1, Math.max(0, n));

/**
 * Parse a WFRP4e (Warhammer Fantasy Roleplay 4th ed.) test payload.
 * Mirrors the system's own rule (TestWFRP.isCriticalFumble): a doubles roll
 * (11, 22, … 99) at or under the target is a Critical, doubles over the
 * target — plus 99 and 100 — are Fumbles. Explicit system labels win.
 * @param {object} test plain {result:{roll,target,outcome,critical,fumble,hitloc,damage}, isCriticalFumble}
 */
export function parseWfrpTest(test) {
  const r = test?.result;
  if (!r) return null;
  const roll = Number(r.roll);
  if (!Number.isFinite(roll)) return null;
  const target = Number(r.target);
  const hasTarget = Number.isFinite(target);
  let icf = typeof test.isCriticalFumble === "string" ? test.isCriticalFumble : "";
  if (!icf && r.critical) icf = "critical";
  if (!icf && r.fumble) icf = "fumble";
  if (!icf && hasTarget) {
    if ((roll > target && roll % 11 === 0) || roll === 100 || roll === 99) icf = "fumble";
    else if (roll <= target && roll % 11 === 0) icf = "critical";
  }
  const succeeded = r.outcome ? r.outcome === "success" : (hasTarget ? (roll <= target || roll === 1) && roll !== 100 : false);
  const normalized = hasTarget ? clamp01((target - roll + 50) / 100) : clamp01((101 - roll) / 100);
  const rawDamage = typeof r.damage === "number" ? r.damage : Number(r.damage?.value);
  return {
    roll, target: hasTarget ? target : null, succeeded,
    isCrit: icf === "critical", isFumble: icf === "fumble", isCriticalFumble: icf,
    normalized,
    damage: Number.isFinite(rawDamage) && rawDamage > 0 ? rawDamage : null,
    hitloc: r.hitloc?.result ?? (typeof r.hitloc === "string" ? r.hitloc : null) ?? r.hitLocation ?? null,
  };
}

/**
 * Extract a plain WFRP4e test payload from a live ChatMessage-like object.
 * The system stores the recreated test at `message.system.test`; every getter
 * is read defensively because opposed/legacy messages may be incomplete.
 */
export function wfrpTestPayloadFromMessage(message) {
  try {
    const test = message?.system?.test;
    const result = test?.result;
    if (!test || !result || !Number.isFinite(Number(result.roll))) return null;
    let isCriticalFumble = "";
    try { if (typeof test.isCriticalFumble === "string") isCriticalFumble = test.isCriticalFumble; } catch { /* derive later */ }
    let damage = null;
    try {
      const raw = typeof result.damage === "number" || typeof result.damage?.value === "number"
        ? (result.damage?.value ?? result.damage)
        : test.damage;
      const parsed = typeof raw === "number" ? raw : Number(raw?.value ?? raw);
      if (Number.isFinite(parsed)) damage = parsed;
    } catch { /* damage is optional flavour */ }
    let hitloc = null;
    try {
      hitloc = result.hitloc?.result ?? (typeof result.hitloc === "string" ? result.hitloc : null) ?? result.hitLocation ?? null;
      if (typeof hitloc !== "string") hitloc = null;
    } catch { /* optional */ }
    return {
      isCriticalFumble,
      result: {
        roll: result.roll,
        target: result.target,
        outcome: result.outcome,
        critical: result.critical,
        fumble: result.fumble,
        hitloc,
        damage,
      },
    };
  } catch {
    return null;
  }
}

/** Convert an owned WFRP4e Critical Wound item into a muse event. */
export function critWoundEventFromItem(item, now = Date.now()) {
  if (!item || item.type !== "critical" || !item.parent) return null;
  if (item.parent.documentName && item.parent.documentName !== "Actor") return null;
  const rawLocation = item.system?.location;
  const location = typeof rawLocation === "string"
    ? rawLocation
    : (typeof rawLocation?.key === "string" && rawLocation.key
      ? rawLocation.key
      : (typeof rawLocation?.value === "string" ? rawLocation.value : null));
  return {
    kind: "critwound",
    ts: now,
    actor: String(item.parent?.name ?? item.actor?.name ?? "Someone"),
    name: sanitizeChatText(item.name ?? "Critical Wound", 120) || "Critical Wound",
    location,
  };
}

/** Return a Corruption muse event only when the point total actually rose. */
export function corruptionGainEvent(previousValue, currentValue, actor, now = Date.now()) {
  const previous = Number(previousValue);
  const current = Number(currentValue);
  if (!Number.isFinite(previous) || !Number.isFinite(current) || current <= previous) return null;
  return {
    kind: "corruption",
    ts: now,
    actor: String(actor ?? "Someone"),
    points: current - previous,
  };
}

/** Normalize a Foundry embedded collection (or plain test array) to an array. */
function embeddedList(collection) {
  try {
    if (Array.isArray(collection)) return collection;
    if (collection && typeof collection[Symbol.iterator] === "function") return [...collection];
    if (typeof collection?.filter === "function") return collection.filter(() => true);
  } catch { /* fall through */ }
  return [];
}

const cleanCareer = (value) => {
  const text = sanitizeChatText(typeof value === "string" ? value : (value?.value ?? value?.name ?? ""), 80);
  return text || null;
};

/**
 * The actor's current career (WFRP4e) for the dirge. Priority: the system's
 * `currentCareer`, the career item flagged current, `system.details.career`,
 * then any career/class item. Returns null when no career is known.
 */
export function careerFromActor(actor) {
  try {
    const current = cleanCareer(actor?.currentCareer?.name ?? actor?.currentCareer);
    if (current) return current;
    const items = embeddedList(actor?.items);
    const careers = items.filter((i) => i?.type === "career");
    const flagged = careers.find((i) => i.system?.current === true || i.system?.current?.value === true);
    if (flagged?.name) return cleanCareer(flagged.name);
    const details = cleanCareer(actor?.system?.details?.career);
    if (details) return details;
    if (careers[0]?.name) return cleanCareer(careers[0].name);
    const klass = items.find((i) => i?.type === "class");
    return klass?.name ? cleanCareer(klass.name) : cleanCareer(actor?.system?.details?.class);
  } catch {
    return null;
  }
}

/** Explicit death flags/statuses, ignoring the wounds/HP total itself. */
export function actorHasDeadFlag(actor) {
  try {
    if (actor?.system?.status?.isDead === true || actor?.system?.status?.dead === true) return true;
    const cw = actor?.system?.status?.criticalWounds;
    const cwValue = Number(cw?.value);
    const cwMax = Number(cw?.max);
    // WFRP4e: Critical Wounds beyond the maximum (Toughness Bonus) kill.
    if (Number.isFinite(cwValue) && Number.isFinite(cwMax) && cwMax > 0 && cwValue > cwMax) return true;
    const statuses = actor?.statuses;
    if (statuses?.has?.("dead") || (statuses && embeddedList(statuses).includes("dead"))) return true;
    for (const effect of embeddedList(actor?.effects)) {
      const ids = embeddedList(effect?.statuses);
      if (ids.includes("dead") || effect?.system?.conditionId === "dead") return true;
      if (/^dead$/i.test(String(effect?.name ?? effect?.label ?? "").trim())) return true;
    }
  } catch { /* a malformed actor is never declared dead */ }
  return false;
}

/** Plain death-relevant snapshot of an actor, for transition detection. */
export function deathSnapshotFromActor(actor) {
  const wounds = Number(actor?.system?.status?.wounds?.value);
  const hp = Number(actor?.system?.attributes?.hp?.value);
  const health = Number.isFinite(wounds) ? wounds : (Number.isFinite(hp) ? hp : null);
  const deadFlag = actorHasDeadFlag(actor);
  return {
    actorId: actor?.id ?? null,
    actor: String(actor?.name ?? "Someone"),
    career: careerFromActor(actor),
    isPlayerCharacter: actor?.type === "character" || actor?.hasPlayerOwner === true,
    health,
    deadFlag,
    dead: deadFlag || (health != null && health <= 0),
  };
}

/**
 * A death event only on a proven alive -> dead transition for a player
 * character. Null baseline never fires (importing a corpse is not a death),
 * and a health-only death needs a previously known health total.
 */
export function deathEventFromTransition(previous, current, now = Date.now(), cause = null) {
  if (!previous || !current?.isPlayerCharacter || previous.dead || !current.dead) return null;
  if (!current.deadFlag && previous.health == null) return null;
  return {
    kind: "death",
    ts: now,
    actor: current.actor,
    career: current.career ?? null,
    actorId: current.actorId ?? null,
    cause: cause ? sanitizeChatText(cause, 120) || null : null,
  };
}

/** Build a death event for an explicitly proven death (defeated / fatal wound / GM macro). */
export function deathEventFromActor(actor, now = Date.now(), cause = null) {
  if (!actor) return null;
  // Plain {actor, career} shape, used by the manual dirge API.
  if (typeof actor === "object" && actor.actor && !actor.name && !actor.system) {
    return {
      kind: "death", ts: now,
      actor: String(actor.actor),
      career: actor.career ? sanitizeChatText(actor.career, 80) || null : null,
      actorId: actor.actorId ?? null,
      cause: cause ? sanitizeChatText(cause, 120) || null : null,
    };
  }
  const snap = deathSnapshotFromActor(actor);
  if (!snap.isPlayerCharacter) return null;
  return {
    kind: "death", ts: now,
    actor: snap.actor, career: snap.career, actorId: snap.actorId,
    cause: cause ? sanitizeChatText(cause, 120) || null : null,
  };
}

/** True when a Critical Wound item itself says the victim died. */
export function isFatalCriticalWound(item) {
  if (!item || item.type !== "critical") return false;
  const name = String(item.name ?? "");
  if (/\b(dead|killed|slain|decapitat\w*|behead\w*)\b/i.test(name)) return true;
  const raw = item.system?.description?.value ?? item.system?.description ?? "";
  const description = sanitizeChatText(typeof raw === "string" ? raw : "", 600);
  return /\b(dies instantly|is killed|killed outright|character dies|victim dies|dies immediately|instant death)\b/i.test(description);
}

/** True when a chat message is an initiative roll (flavour/content says so). */
export function isInitiativeRoll(msg) {
  const text = `${msg?.flavor ?? ""} ${typeof msg?.content === "string" ? msg.content.replace(/<[^>]*>/g, " ") : ""}`;
  return /\binitiative\b/i.test(text);
}

/** Build a roll event from a Foundry-like chat message, or null if it has no rolls. */
export function rollEventFromMessage(msg, now = Date.now()) {
  const wfrp = msg?.wfrpTest ? parseWfrpTest(msg.wfrpTest) : null;
  if (wfrp) {
    return {
      kind: "roll",
      ts: Number(msg?.timestamp) || now,
      actor: String(msg?.speaker?.alias ?? msg?.alias ?? "Someone"),
      flavor: sanitizeChatText(msg?.flavor ?? "", 120),
      formula: "1d100",
      total: wfrp.roll,
      isCrit: wfrp.isCrit,
      isFumble: wfrp.isFumble,
      normalized: wfrp.normalized,
      natural: wfrp.roll,
      damage: wfrp.damage,
      target: wfrp.target,
      system: "wfrp4e",
      rollCount: 1,
    };
  }
  const rolls = Array.isArray(msg?.rolls) ? msg.rolls : [];
  if (!rolls.length) return null;
  const parsed = rolls.map(parseRoll).filter(Boolean);
  if (!parsed.length) return null;
  const primary = parsed[0];
  const totalDamageHint = /damage/i.test(String(msg?.flavor ?? "")) ? primary.total : null;
  // WFRP4e is roll-UNDER: a plain 1d100 chat roll in that world (no system
  // test attached) scores low-good, the inverse of generic roll-high dice.
  const singleD100 = primary.dice?.length === 1 && primary.dice[0].faces === 100 && primary.dice[0].values.length === 1;
  const rollUnder = msg?.systemId === "wfrp4e" && singleD100 && typeof primary.total === "number";
  return {
    kind: "roll",
    ts: Number(msg?.timestamp) || now,
    actor: String(msg?.speaker?.alias ?? msg?.alias ?? "Someone"),
    flavor: sanitizeChatText(msg?.flavor ?? "", 120),
    formula: primary.formula,
    total: primary.total,
    isCrit: rollUnder ? false : parsed.some((r) => r.isCrit),
    isFumble: rollUnder ? false : parsed.some((r) => r.isFumble),
    normalized: rollUnder ? clamp01((101 - primary.total) / 100) : primary.normalized,
    natural: primary.natural,
    damage: totalDamageHint,
    rollCount: parsed.length,
  };
}

const BARD_MOODS = [
  [/\b(sad|melancholy|somber|sombre|mournful|weepy)\b/i, "melancholy and tender"],
  [/\b(happy|jolly|rowdy|wild|raucous|merry)\b/i, "rowdy and jubilant"],
  [/\b(quiet|chill|calm|soft|gentle|mellow)\b/i, "quiet and mellow"],
  [/\b(dark|scary|spooky|eerie|creepy|haunted)\b/i, "dark and eerie"],
  [/\b(epic|heroic|grand|triumphant)\b/i, "grand and heroic"],
  [/\b(romantic|love|sweetheart)\b/i, "tender and romantic"],
  [/\b(drunken|drunk|boozy)\b/i, "drunken and swaying"],
];

/**
 * Parse a player chat request to the bards ("!bard sing about dragons,
 * faster, for Aria!"). Also hears bards addressed by name ("Lottie,
 * something sad"). Returns null for ordinary chat. Pure/deterministic.
 */
export function parseBardRequest(content, { actorNames = [], bardNames = [] } = {}) {
  const text = sanitizeChatText(content ?? "", 300);
  if (!text || text.startsWith("/")) return null;
  const lowerText = text.toLowerCase();
  let bard = null;
  let rest = null;
  const bang = text.match(/^!bard\b[,:!\s]*/i) ?? text.match(/^hey\s+bards?\b[,:!\s]*/i);
  if (bang) rest = text.slice(bang[0].length);
  const stripAddress = (value, name) => {
    const lower = value.toLowerCase();
    const candidates = [name.toLowerCase(), name.split(/\s+/)[0].toLowerCase()];
    for (const cand of candidates) {
      const at = lower.startsWith("@") ? 1 : 0;
      if (!lower.startsWith(cand, at)) continue;
      const after = value.slice(at + cand.length);
      if (!/^[\s,:!]/.test(after) && after !== "") continue;
      return after.replace(/^[\s,:!]+/, "");
    }
    return null;
  };
  if (rest == null) {
    for (const name of bardNames) {
      const stripped = stripAddress(text, name);
      if (stripped != null) { bard = name; rest = stripped; break; }
    }
  }
  if (rest == null) return null;
  if (!bard) {
    for (const name of bardNames) {
      const stripped = stripAddress(rest, name);
      if (stripped != null) { bard = name; rest = stripped; break; }
    }
  }
  const body = rest.trim();
  const lower = body.toLowerCase();
  let tempoShift = 0;
  const fasterAt = Math.max(lower.lastIndexOf("faster"), lower.lastIndexOf("quicker"), lower.lastIndexOf("speed up"));
  const slowWordAt = lower.search(/\bslow\b/);
  const slowerAt = Math.max(lower.lastIndexOf("slower"), lower.lastIndexOf("slow down"), slowWordAt);
  if (fasterAt >= 0 || slowerAt >= 0) tempoShift = fasterAt > slowerAt ? 12 : -12;
  const mood = BARD_MOODS.filter(([re]) => re.test(body)).map(([, tag]) => tag).slice(0, 2);
  let topic = null;
  const tm = body.match(/(?:song|songs|sing|play|ballad|tune|about)\s+(?:about\s+|of\s+)?(.+?)(?:\s+for\s+[A-Z][\w'-]*|\s*(?:,|\.|!|\?)\s*(?:faster|slower|please\b.*)?$|$)/i);
  if (tm) {
    const cand = tm[1].replace(/\b(please|now|faster|slower)\b/gi, "").replace(/\s+/g, " ").trim().replace(/[,.!\s]+$/, "");
    if (cand && cand.length >= 3 && !/^(it|that|this|us|me|something|anything)$/i.test(cand)) topic = cand.slice(0, 60);
  }
  let dedication = null;
  const forMatch = body.match(/\bfor\s+([A-Za-z][\w'-]*(?:\s+[A-Za-z][\w'-]*)?)/);
  if (forMatch) {
    const cand = forMatch[1].trim();
    const hit = actorNames.find((n) => n.toLowerCase() === cand.toLowerCase() || n.split(/\s+/)[0].toLowerCase() === cand.split(/\s+/)[0].toLowerCase());
    if (hit) dedication = hit.split(/\s+/)[0];
    else if (!actorNames.length && /^[A-Z]/.test(cand) && !/^(the|a|us|me|everyone|everybody)$/i.test(cand)) dedication = cand.split(/\s+/)[0];
  }
  const instrumental = /instrumental|no singing|just (the )?(music|drums|lute|fiddle|strumming)/i.test(body);
  const flavor = /drum/i.test(body) ? "drum" : (/lute|strum|fiddle/i.test(body) ? "strum" : null);
  const encore = /encore|play it again|again!/i.test(body);
  return {
    bard, tempoShift, mood, topic, dedication, instrumental, flavor, encore,
    empty: tempoShift === 0 && !mood.length && !topic && !dedication && !instrumental && !encore,
  };
}

/** Build a request muse event from a chat message, or null. */
export function requestEventFromMessage(msg, now = Date.now(), opts = {}) {
  const parsed = parseBardRequest(msg?.content ?? "", opts);
  if (!parsed) return null;
  return {
    kind: "request",
    ts: Number(msg?.timestamp) || now,
    actor: String(msg?.speaker?.alias ?? msg?.alias ?? "Someone"),
    text: sanitizeChatText(msg?.content ?? "", 200),
    ...parsed,
  };
}

/** Merge queued requests newest-wins per field for the next song. */
export function mergeBardRequests(events = []) {
  if (!events.length) return null;
  const merged = { tempoShift: 0, mood: [], topic: null, dedication: null, instrumental: false, flavor: null, encore: false, bard: null, count: events.length };
  for (const e of events) {
    if (e.tempoShift) merged.tempoShift = e.tempoShift;
    if (e.mood?.length) merged.mood = [...new Set([...merged.mood, ...e.mood])].slice(-2);
    if (e.topic) merged.topic = e.topic;
    if (e.dedication) merged.dedication = e.dedication;
    if (e.instrumental) merged.instrumental = true;
    if (e.flavor) merged.flavor = e.flavor;
    if (e.encore) merged.encore = true;
    if (e.bard) merged.bard = e.bard;
  }
  merged.empty = merged.tempoShift === 0 && !merged.mood.length && !merged.topic && !merged.dedication && !merged.instrumental && !merged.encore;
  return merged;
}

/** Short in-character acknowledgment the bards post back to chat. */
export function bardAckText(req) {
  if (!req || req.empty) {
    return "Aye? Shout a request and we'll play it — try \"!bard sing about dragons, faster, for a friend!\"";
  }
  const bits = [];
  if (req.encore) bits.push("an encore");
  if (req.topic) bits.push(`a song of ${req.topic}`);
  if (req.tempoShift > 0) bits.push("quicker");
  if (req.tempoShift < 0) bits.push("slower");
  if (req.mood?.length) bits.push(req.mood.join(" and "));
  if (req.instrumental) bits.push(req.flavor === "drum" ? "just the drums" : "no singing, just the strings");
  const what = bits.length ? bits.join(", ") : "your request";
  const forWhom = req.dedication ? ` — for ${req.dedication}!` : "!";
  return `Heard you! Next song: ${what}${forWhom}`;
}

export function chatEventFromMessage(msg, now = Date.now()) {
  const text = sanitizeChatText(msg?.content ?? "");
  if (!text) return null;
  return {
    kind: "chat",
    ts: Number(msg?.timestamp) || now,
    actor: String(msg?.speaker?.alias ?? msg?.alias ?? "Someone"),
    text,
  };
}

/** True when a message is public table talk (not a whisper / blind roll). */
export function isPublicMessage(msg) {
  if (!msg) return false;
  const whisper = msg.whisper ?? msg?.whisperTo ?? [];
  if (Array.isArray(whisper) && whisper.length) return false;
  if (msg.blind) return false;
  return true;
}

export class SessionLog {
  constructor(events = [], checkpointTs = 0) {
    this.events = Array.isArray(events) ? [...events] : [];
    this.checkpointTs = Number(checkpointTs) || 0;
    this._startedCombats = new Set();
  }

  /**
   * Log a combat start at most once per combat id (initiative rolls and
   * the combatStart hook often race). Returns the event, or null if this
   * combat already started. Pass null/undefined id for initiative chat
   * rolls without a combat document — deduped against any open combat.
   */
  markCombatStarted(combatId, now = Date.now(), extra = {}) {
    const key = combatId ?? "__initiative__";
    if (this._startedCombats.has(key)) return null;
    if (combatId == null && this._startedCombats.size) return null;
    this._startedCombats.add(key);
    return this.add({ kind: "combat", ts: now, phase: "start", via: extra.via ?? "hook", ...extra }, now);
  }

  /** Forget a combat's start marker when it ends (same id may be reused). */
  markCombatEnded(combatId, now = Date.now()) {
    this._startedCombats.delete(combatId ?? "__initiative__");
    if (combatId == null) this._startedCombats.clear();
    return this.add({ kind: "combat", ts: now, phase: "end" }, now);
  }

  static fromJSON(data) {
    if (!data || typeof data !== "object") return new SessionLog();
    return new SessionLog(Array.isArray(data.events) ? data.events : [], data.checkpointTs ?? 0);
  }

  toJSON() { return { version: 1, checkpointTs: this.checkpointTs, events: this.events }; }

  add(event, now = Date.now()) {
    if (!event) return null;
    this.events.push(event);
    this.prune(now);
    return event;
  }

  addCombat(phase, now = Date.now(), extra = {}) {
    return this.add({ kind: "combat", ts: now, phase, ...extra }, now);
  }

  /** Drop events older than the 3h window and cap size. */
  prune(now = Date.now()) {
    const floor = Math.max(now - LOG_WINDOW_MS, 0);
    this.events = this.events.filter((e) => (e?.ts ?? 0) >= floor);
    if (this.events.length > LOG_MAX_EVENTS) this.events = this.events.slice(-LOG_MAX_EVENTS);
    return this.events.length;
  }

  /** Rolls steering the next track: last MUSE window, capped, newest last. */
  museRolls(now = Date.now()) {
    return this.events
      .filter((e) => e.kind === "roll" && e.ts >= now - MUSE_WINDOW_MS)
      .slice(-MUSE_MAX_ROLLS);
  }

  museChat(now = Date.now(), limit = 8) {
    return this.events
      .filter((e) => e.kind === "chat" && e.ts >= now - MUSE_WINDOW_MS)
      .slice(-limit);
  }

  /** Corruption points gained in the muse window (WFRP4e). */
  museCorruption(now = Date.now(), limit = 4) {
    return this.events
      .filter((e) => e.kind === "corruption" && e.ts >= now - MUSE_WINDOW_MS)
      .slice(-limit);
  }

  /** Critical Wounds suffered in the muse window (WFRP4e grim spice). */
  museWounds(now = Date.now(), limit = 4) {
    return this.events
      .filter((e) => e.kind === "critwound" && e.ts >= now - MUSE_WINDOW_MS)
      .slice(-limit);
  }

  /** Player-character deaths in the muse window (the next song remembers them). */
  museDeaths(now = Date.now(), limit = 4) {
    return this.events
      .filter((e) => e.kind === "death" && e.ts >= now - MUSE_WINDOW_MS)
      .slice(-limit);
  }

  /** Player bard requests logged strictly after `sinceTs` (consumption cursor). */
  pendingRequests(sinceTs = 0) {
    return this.events.filter((e) => e.kind === "request" && e.ts > sinceTs);
  }

  /** Events the break ballad should cover: since last checkpoint, else last 3h. */
  breakWindow(now = Date.now()) {
    const since = this.checkpointTs > 0 ? this.checkpointTs : now - LOG_WINDOW_MS;
    return this.events.filter((e) => e.ts >= since);
  }

  markBreak(now = Date.now()) { this.checkpointTs = now; }

  summary(now = Date.now()) {
    const w = this.breakWindow(now);
    return {
      rolls: w.filter((e) => e.kind === "roll").length,
      chats: w.filter((e) => e.kind === "chat").length,
      combats: w.filter((e) => e.kind === "combat" && e.phase === "start").length,
      wounds: w.filter((e) => e.kind === "critwound").length,
      deaths: w.filter((e) => e.kind === "death").length,
      total: this.events.length,
      sinceTs: w[0]?.ts ?? null,
    };
  }
}
