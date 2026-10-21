// Right-sidebar "Lyric Bot at Work" panel: the writers show their work —
// what the parody hunter picked and why it fits, which dice facts and saga
// lines went into the prompt, what the screen accepted or refused, and
// what the memory is feeding back. Pure model (testable) + a small DOM
// mount docked at the top of Foundry's sidebar; every client sees it via
// the socket status mirror, and text is set with textContent throughout.

const ACTOR_LABEL = { bard: "BARD", "lyric-llm": "LYRIC", parody: "PARODY", memory: "MEMORY" };

/** Sidebar view model from a player status object. */
export function sidebarModel(status) {
  if (!status) return { now: "♪ Bardic Dice — stopped", next: "", why: "", work: [] };
  const remain = status.remainSec != null ? ` · ${Math.floor(status.remainSec / 60)}:${String(status.remainSec % 60).padStart(2, "0")} left` : "";
  const now = status.state === "playing"
    ? `♪ ${status.nowPlaying ?? "—"} (${status.mode ?? "tavern"}${remain})`
    : status.generating || status.state === "generating" ? "♪ Bard is composing…" : `♪ Bardic Dice — ${status.state ?? "stopped"}`;
  const next = status.state === "playing"
    ? (status.nextTrack && status.nextTrack !== "—" ? `Next: ${status.nextTrack}${status.queued ? ` (+${status.queued - 1} queued)` : ""}` : "Next: composing when this track nears its end")
    : "";
  return {
    now,
    next,
    why: status.why ? `Why: ${String(status.why).slice(0, 160)}` : "",
    work: (status.work ?? []).slice(-8).reverse().map((w) => ({
      label: ACTOR_LABEL[w.actor] ?? "BARD",
      text: w.text,
      detail: w.detail ?? "",
      when: w.ts ? new Date(w.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "",
    })),
  };
}

/** Create/find the panel docked at the top of the sidebar. */
export function mountBardicSidebar(doc = globalThis.document) {
  if (!doc?.querySelector) return null;
  let el = doc.getElementById?.("bardic-dice-sidebar");
  if (el) return el;
  // Dock into the sidebar app when it exists; fall back to the right UI
  // column, then to a floating panel on the body — the work log must end
  // up on screen somewhere, never silently nowhere.
  const host = doc.querySelector("#sidebar") ?? doc.querySelector("#ui-right");
  el = doc.createElement("details");
  el.id = "bardic-dice-sidebar";
  el.open = true;
  const summary = doc.createElement("summary");
  summary.textContent = "🎵 Lyric Bot at Work";
  el.appendChild(summary);
  const body = doc.createElement("div");
  body.className = "bd-sidebar-body";
  el.appendChild(body);
  if (host) {
    host.insertBefore(el, host.firstChild ?? null);
  } else if (doc.body) {
    el.classList?.add?.("bd-sidebar-floating");
    doc.body.appendChild(el);
  } else {
    return null;
  }
  return el;
}

export function renderBardicSidebar(status, doc = globalThis.document) {
  const el = mountBardicSidebar(doc);
  if (!el) return null;
  const body = el.querySelector(".bd-sidebar-body") ?? el;
  body.textContent = "";
  const model = sidebarModel(status);
  const add = (text, cls) => {
    if (!text) return;
    const row = doc.createElement("div");
    row.className = cls;
    row.textContent = text;
    body.appendChild(row);
  };
  add(model.now, "bd-sb-now");
  add(model.next, "bd-sb-line");
  add(model.why, "bd-sb-why");
  if (!model.work.length) add("The lyric bot has not written yet this session — start the music and roll some dice.", "bd-sb-line");
  for (const w of model.work) {
    add(`${w.when ? `${w.when} ` : ""}${w.label}: ${w.text}`, "bd-sb-work");
    if (w.detail) add(w.detail, "bd-sb-detail");
  }
  return el;
}
