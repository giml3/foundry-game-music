import test from "node:test";
import assert from "node:assert/strict";
import { SessionLog, bardAckText, chatEventFromMessage, isInitiativeRoll, isPublicMessage, mergeBardRequests, parseBardRequest, parseRoll, requestEventFromMessage, rollEventFromMessage, sanitizeChatText } from "../scripts/session-log.js";
import { LOG_MAX_EVENTS, LOG_WINDOW_MS } from "../scripts/constants.js";

const d20 = (v) => ({ total: v, formula: "1d20", dice: [{ faces: 20, results: [{ result: v }] }] });

test("natural 20 is a crit, natural 1 is a fumble", () => {
  assert.equal(parseRoll(d20(20)).isCrit, true);
  assert.equal(parseRoll(d20(1)).isFumble, true);
  assert.equal(parseRoll(d20(11)).isCrit, false);
  assert.equal(parseRoll(d20(11)).natural, 11);
});

test("system isCritical/isFumble flags win over heuristics", () => {
  assert.equal(parseRoll({ total: 5, formula: "2d6", dice: [{ faces: 6, values: [2, 3] }], isCritical: true }).isCrit, true);
});

test("normalized maps dice pools into 0..1", () => {
  const r = parseRoll({ total: 7, formula: "2d6", dice: [{ faces: 6, values: [3, 4] }] });
  assert.ok(Math.abs(r.normalized - 0.5) < 1e-9);
});

test("rollEventFromMessage extracts actor, damage hint, crit", () => {
  const ev = rollEventFromMessage({ rolls: [d20(20)], flavor: "Frostbite Damage", speaker: { alias: "Aria" }, timestamp: 100 });
  assert.equal(ev.actor, "Aria");
  assert.equal(ev.isCrit, true);
  assert.equal(ev.damage, 20);
  assert.equal(rollEventFromMessage({ rolls: [] }), null);
});

test("sanitizeChatText strips HTML and scripts", () => {
  assert.equal(sanitizeChatText('<p>Hi <b>there</b></p><script>alert(1)</script> &amp; bye'), "Hi there & bye");
});

test("whispers and blind rolls are not public", () => {
  assert.equal(isPublicMessage({ whisper: [] }), true);
  assert.equal(isPublicMessage({ whisper: ["user1"] }), false);
  assert.equal(isPublicMessage({ blind: true }), false);
});

test("log prunes to the 3h window and the size cap", () => {
  const now = 10_000_000_000;
  const log = new SessionLog();
  log.add({ kind: "chat", ts: now - LOG_WINDOW_MS - 1, actor: "Old", text: "gone" }, now);
  log.add({ kind: "chat", ts: now, actor: "New", text: "kept" }, now);
  assert.deepEqual(log.events.map((e) => e.text), ["kept"]);
  const big = new SessionLog(Array.from({ length: LOG_MAX_EVENTS + 50 }, (_, i) => ({ kind: "chat", ts: now, actor: "A", text: String(i) })));
  big.prune(now);
  assert.equal(big.events.length, LOG_MAX_EVENTS);
  assert.equal(big.events[0].text, "50");
});

test("muse window only sees recent rolls; break window respects checkpoint", () => {
  const now = 10_000_000_000;
  const log = new SessionLog();
  log.add({ kind: "roll", ts: now - 60 * 60 * 1000, actor: "A" }, now);
  log.add({ kind: "roll", ts: now - 1000, actor: "B" }, now);
  assert.equal(log.museRolls(now).length, 1);
  assert.equal(log.breakWindow(now).length, 2);
  log.markBreak(now - 500);
  assert.equal(log.breakWindow(now).length, 0);
});

test("log round-trips through JSON", () => {
  const log = new SessionLog([{ kind: "roll", ts: 5, actor: "A" }], 3);
  const back = SessionLog.fromJSON(JSON.parse(JSON.stringify(log.toJSON())));
  assert.equal(back.events.length, 1);
  assert.equal(back.checkpointTs, 3);
  assert.equal(SessionLog.fromJSON(null).events.length, 0);
});

test("chatEventFromMessage ignores empty content", () => {
  assert.equal(chatEventFromMessage({ content: "  " }), null);
  assert.equal(chatEventFromMessage({ content: "<p>hello</p>", speaker: { alias: "Aria" }, timestamp: 7 }).text, "hello");
});

test("parseBardRequest hears !bard calls with tempo, topic, and dedication", () => {
  const opts = { actorNames: ["Aria", "Bram"], bardNames: ["Lottie Lautenspiel", "Pieter Pfeifer"] };
  const r = parseBardRequest("!bard sing about the dragon under Bogenhafen, faster, for Aria!", opts);
  assert.ok(r, "request parsed");
  assert.equal(r.tempoShift, 12);
  assert.match(r.topic, /dragon/);
  assert.equal(r.dedication, "Aria");
  assert.equal(parseBardRequest("just chatting about dragons", opts), null);
  assert.equal(parseBardRequest("/roll 1d100", opts), null);
});

test("parseBardRequest understands named bards, moods, and instrumental asks", () => {
  const opts = { actorNames: ["Aria"], bardNames: ["Lottie Lautenspiel"] };
  const r = parseBardRequest("Lottie, something sad and slow please", opts);
  assert.equal(r.bard, "Lottie Lautenspiel");
  assert.equal(r.tempoShift, -12);
  assert.ok(r.mood.some((m) => /melancholy/i.test(m)));
  const drums = parseBardRequest("!bard just drums, no singing", opts);
  assert.equal(drums.instrumental, true);
  assert.equal(drums.flavor, "drum");
  const encore = parseBardRequest("!bard encore!", opts);
  assert.equal(encore.encore, true);
});

test("requests become log events, merge newest-wins, and get a bard ack", () => {
  const ev = requestEventFromMessage(
    { content: "!bard faster, sing about gold", speaker: { alias: "Aria" }, timestamp: 5 },
    5, { actorNames: ["Aria"], bardNames: [] });
  assert.equal(ev.kind, "request");
  assert.equal(ev.actor, "Aria");
  const merged = mergeBardRequests([
    { kind: "request", tempoShift: 12, mood: ["rowdy and jubilant"], topic: "gold", dedication: null, instrumental: false, flavor: null, encore: false },
    { kind: "request", tempoShift: -12, mood: [], topic: null, dedication: "Bram", instrumental: true, flavor: "drum", encore: true },
  ]);
  assert.equal(merged.tempoShift, -12, "newest tempo ask wins");
  assert.equal(merged.topic, "gold");
  assert.equal(merged.dedication, "Bram");
  assert.equal(merged.instrumental, true);
  assert.match(bardAckText(ev), /gold/);
  const log = new SessionLog();
  log.add(ev, 5);
  assert.equal(log.pendingRequests(0).length, 1);
  assert.equal(log.pendingRequests(6).length, 0);
});

test("initiative rolls are recognised from flavour or content", () => {
  assert.equal(isInitiativeRoll({ flavor: "Initiative" }), true);
  assert.equal(isInitiativeRoll({ flavor: "", content: "<p>Rolling Initiative for Bram</p>" }), true);
  assert.equal(isInitiativeRoll({ flavor: "Longsword" }), false);
  assert.equal(isInitiativeRoll({}), false);
  assert.equal(isInitiativeRoll(null), false);
});

test("combat starts are logged once per combat however they are noticed", () => {
  const log = new SessionLog();
  assert.ok(log.markCombatStarted("c1", 1000, { via: "initiative-roll" }), "first notice logs the start");
  assert.equal(log.markCombatStarted("c1", 1100, { via: "hook" }), null, "the hook racing the initiative roll does not double-log");
  assert.equal(log.markCombatStarted(null, 1200, { via: "initiative-roll" }), null, "anonymous initiative rolls dedupe against the open combat");
  assert.equal(log.events.filter((e) => e.kind === "combat" && e.phase === "start").length, 1);
  assert.equal(log.events[0].via, "initiative-roll");
  log.markCombatEnded("c1", 2000);
  assert.ok(log.markCombatStarted("c1", 3000, { via: "hook" }), "a later combat may reuse the id");
  assert.equal(log.events.filter((e) => e.kind === "combat" && e.phase === "start").length, 2);
});
