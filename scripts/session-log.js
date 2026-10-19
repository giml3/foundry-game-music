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

/** Build a roll event from a Foundry-like chat message, or null if it has no rolls. */
export function rollEventFromMessage(msg, now = Date.now()) {
  const rolls = Array.isArray(msg?.rolls) ? msg.rolls : [];
  if (!rolls.length) return null;
  const parsed = rolls.map(parseRoll).filter(Boolean);
  if (!parsed.length) return null;
  const primary = parsed[0];
  const totalDamageHint = /damage/i.test(String(msg?.flavor ?? "")) ? primary.total : null;
  return {
    kind: "roll",
    ts: Number(msg?.timestamp) || now,
    actor: String(msg?.speaker?.alias ?? msg?.alias ?? "Someone"),
    flavor: sanitizeChatText(msg?.flavor ?? "", 120),
    formula: primary.formula,
    total: primary.total,
    isCrit: parsed.some((r) => r.isCrit),
    isFumble: parsed.some((r) => r.isFumble),
    normalized: primary.normalized,
    natural: primary.natural,
    damage: totalDamageHint,
    rollCount: parsed.length,
  };
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
      total: this.events.length,
      sinceTs: w[0]?.ts ?? null,
    };
  }
}
