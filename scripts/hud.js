// Bottom-left corner feedback: what the bard, the lyric/humor LLM and the
// story memory are doing right now, so a table can SEE a switch coming
// instead of wondering why the music has not changed yet. Pure formatter
// (testable) + a tiny DOM mount that every client (GM and players) runs;
// players receive the same lines through the socket status mirror.

const ACTOR_LABEL = { bard: "BARD", "lyric-llm": "LYRIC", parody: "PARODY", memory: "MEMORY" };

/** Format a player status object into HUD lines. */
export function hudLines(status) {
  if (!status) return ["♪ Bardic Dice — stopped"];
  const lines = [];
  const remain = status.remainSec != null ? ` · ${Math.floor(status.remainSec / 60)}:${String(status.remainSec % 60).padStart(2, "0")} left` : "";
  if (status.state === "playing") {
    lines.push(`♪ ${status.nowPlaying ?? "—"} (${status.mode ?? "tavern"}${remain})`);
  } else if (status.generating || status.state === "generating") {
    lines.push("♪ Bard is composing…");
  } else {
    lines.push(`♪ Bardic Dice — ${status.state ?? "stopped"}`);
  }
  if (status.state === "playing") {
    lines.push(status.nextTrack && status.nextTrack !== "—"
      ? `Next: ${status.nextTrack}${status.queued ? ` (+${status.queued - 1} queued)` : ""}`
      : "Next: composing when this track nears its end");
  }
  for (const a of (status.activity ?? []).slice(-3)) {
    lines.push(`${ACTOR_LABEL[a.actor] ?? "BARD"}: ${a.text}`);
  }
  if (status.why) lines.push(`Why: ${String(status.why).slice(0, 110)}`);
  return lines;
}

/** Create/update the corner panel. Returns the element (null without a DOM). */
export function mountBardicHud(doc = globalThis.document) {
  if (!doc?.body) return null;
  let el = doc.getElementById("bardic-dice-hud");
  if (!el) {
    el = doc.createElement("div");
    el.id = "bardic-dice-hud";
    el.setAttribute("aria-live", "polite");
    doc.body.appendChild(el);
  }
  return el;
}

export function renderBardicHud(status, doc = globalThis.document) {
  const el = mountBardicHud(doc);
  if (!el) return null;
  el.textContent = "";
  for (const line of hudLines(status)) {
    const row = doc.createElement("div");
    row.className = line.startsWith("♪") ? "bd-hud-now" : "bd-hud-line";
    row.textContent = line;
    el.appendChild(row);
  }
  return el;
}
