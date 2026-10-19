import test from "node:test";
import assert from "node:assert/strict";
import { SessionLog, chatEventFromMessage, isPublicMessage, parseRoll, rollEventFromMessage, sanitizeChatText } from "../scripts/session-log.js";
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
