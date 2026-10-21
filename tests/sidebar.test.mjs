import test from "node:test";
import assert from "node:assert/strict";
import { renderBardicSidebar, sidebarModel } from "../scripts/sidebar.js";

const status = {
  state: "playing", mode: "combat", nowPlaying: "Combat Jig", remainSec: 65,
  nextTrack: "War Song", queued: 2, why: "combat → faster (140 BPM, A minor); LYRIC parody (skeleton #7)",
  work: [
    { ts: 1700000000000, actor: "parody", text: "hunting a skeleton fitting Bram vs Skaven…", detail: "Party: Bram the Rat Catcher · Enemy: Skaven · Dice facts: FUMBLE: Bram rolled 99 vs 40" },
    { ts: 1700000005000, actor: "parody", text: "lyric LLM picked skeleton for Bram vs Skaven (track #7) — bards will sing it", detail: "Screened against source (no shared line / 5-word run)" },
    { ts: 1700000010000, actor: "memory", text: "saga memory: 40 rolls, 3 crits, 1 deaths all-time", detail: "legend Bram the Rat Catcher (2 crits)" },
  ],
};

test("sidebar model shows the lyric bot's work newest-first with evidence", () => {
  const m = sidebarModel(status);
  assert.match(m.now, /Combat Jig \(combat · 1:05 left\)/);
  assert.match(m.next, /Next: War Song/);
  assert.equal(m.work.length, 3);
  assert.equal(m.work[0].label, "MEMORY", "newest entry first");
  assert.equal(m.work[1].label, "PARODY");
  assert.match(m.work[1].detail, /Screened against source/);
  assert.match(m.work[2].detail, /Dice facts: FUMBLE/);
  assert.match(sidebarModel(null).now, /stopped/);
  assert.match(sidebarModel({ state: "stopped" }).now, /stopped/);
});

test("sidebar renders the work log as text into a docked panel", () => {
  const made = [];
  const body = { className: "", textContent: "", children: [], appendChild(k) { this.children.push(k); } };
  const panel = {
    id: "bardic-dice-sidebar", open: false, children: [],
    appendChild(k) { this.children.push(k); },
    insertBefore() {},
    querySelector(sel) { return sel === ".bd-sidebar-body" ? body : null; },
  };
  const sidebarEl = { firstChild: null, inserted: null, insertBefore(el, ref) { this.inserted = el; } };
  const doc = {
    getElementById: (id) => (id === "bardic-dice-sidebar" && made.length ? panel : null),
    querySelector: (sel) => (sel === "#sidebar" ? sidebarEl : null),
    createElement: (tag) => { const el = { tag, className: "", textContent: "", children: [], appendChild(k) { this.children.push(k); }, querySelector: panel.querySelector.bind(panel) }; made.push(el); return el; },
  };
  // First render mounts <details> into #sidebar; reuse the stub panel body.
  panel.querySelector = (sel) => (sel === ".bd-sidebar-body" ? body : null);
  made.push(panel);
  renderBardicSidebar(status, doc);
  const text = body.children.map((c) => c.textContent).join("\n");
  assert.match(text, /Combat Jig/);
  assert.match(text, /PARODY: lyric LLM picked skeleton/);
  assert.match(text, /Screened against source/);
});

function fakeEl(tag) {
  return {
    tag, id: "", open: false, className: "", textContent: "", children: [], firstChild: null,
    classList: { added: [], add(c) { this.added.push(c); } },
    appendChild(k) { this.children.push(k); },
    insertBefore(k) { this.children.unshift(k); },
    querySelector(sel) { return this.children.find((c) => sel === `.${c.className}`) ?? null; },
    setAttribute() {},
  };
}

test("sidebar falls back to #ui-right when the sidebar app element is absent", () => {
  const uiRight = fakeEl("div");
  const doc = {
    body: fakeEl("body"),
    getElementById: () => null,
    querySelector: (sel) => (sel === "#ui-right" ? uiRight : null),
    createElement: (tag) => fakeEl(tag),
  };
  const el = renderBardicSidebar({ state: "stopped" }, doc);
  assert.ok(el, "panel still mounts");
  assert.equal(uiRight.children[0]?.id, "bardic-dice-sidebar");
  const body = el.querySelector(".bd-sidebar-body");
  assert.match(body.children.map((c) => c.textContent).join("\n"), /Bardic Dice — stopped/);
});

test("sidebar floats on the body when neither sidebar nor #ui-right exists", () => {
  const doc = {
    body: fakeEl("body"),
    getElementById: () => null,
    querySelector: () => null,
    createElement: (tag) => fakeEl(tag),
  };
  const el = renderBardicSidebar({ state: "stopped" }, doc);
  assert.ok(el, "panel still mounts");
  assert.equal(doc.body.children[0]?.id, "bardic-dice-sidebar");
  assert.ok(el.classList.added.includes("bd-sidebar-floating"), "floating dock class applied");
});
