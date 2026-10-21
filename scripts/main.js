// Bardic Dice — entry point. Wires Foundry hooks to the session log and the
// GM-side playback engine. Only the *active* GM persists the log and drives
// automatic generation; manual toolbar actions are GM-gated in the engine.
import { MODULE_ID, Mode, SOCKET_CHANNEL } from "./constants.js";
import { getConfig, registerSettings } from "./settings.js";
import { BardicPlayer } from "./player-engine.js";
import { BardicStatusApp } from "./status-app.js";
import { registerSceneControls } from "./controls.js";
import {
  SessionLog, bardAckText, chatEventFromMessage, corruptionGainEvent, critWoundEventFromItem,
  careerFromActor, deathEventFromActor, deathEventFromTransition, deathSnapshotFromActor, isFatalCriticalWound,
  isInitiativeRoll, isPublicMessage, requestEventFromMessage, rollEventFromMessage, wfrpTestPayloadFromMessage,
} from "./session-log.js";
import { extractFeatures, museSignificance } from "./prompt-engine.js";
import { StoryTracker } from "./llm-writer.js";
import { renderBardicHud } from "./hud.js";
import { renderBardicSidebar } from "./sidebar.js";

const sessionLog = new SessionLog();
const storyTracker = new StoryTracker();
let mirrorStatus = null;
let statusApp = null;
let persistTimer = null;
let museTimer = null;
const corruptionBaseline = new Map();
const deathBaseline = new Map(); // actorId -> last deathSnapshotFromActor()
const dirgedActorIds = new Set(); // actors already sung out this death (re-armed on revival)

function currentCorruption(actor) {
  try {
    const value = globalThis.foundry?.utils?.getProperty
      ? foundry.utils.getProperty(actor, "system.status.corruption.value")
      : actor?.system?.status?.corruption?.value;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function rememberCorruption(actor) {
  const value = currentCorruption(actor);
  if (actor?.id && value != null) corruptionBaseline.set(actor.id, value);
  return value;
}

function rememberDeath(actor) {
  try {
    if (!actor?.id) return null;
    const snap = deathSnapshotFromActor(actor);
    deathBaseline.set(actor.id, snap);
    if (!snap.dead) dirgedActorIds.delete(actor.id); // revived: a new death earns a new dirge
    return snap;
  } catch { return null; }
}

/** Log a proven PC death exactly once, then (active GM only) sing the dirge. */
function handleDeath(event) {
  if (!event?.actor) return false;
  const key = event.actorId ?? event.actor;
  if (dirgedActorIds.has(key)) return false;
  dirgedActorIds.add(key);
  sessionLog.add(event, event.ts);
  persistLogSoon();
  console.log(`${MODULE_ID} | ${event.actor}${event.career ? ` the ${event.career}` : ""} has died — dirge`);
  if (isActiveGM() && getConfig().deathDirge !== false) {
    void player.playDirge(event).catch((e) => player.failSoftly(e));
  }
  return true;
}

function isActiveGM() {
  return game.user?.isGM === true && (game.users?.activeGM?.id ?? game.user.id) === game.user.id;
}

function storyCareers() {
  const map = {};
  try { for (const a of game.actors ?? []) { const c = careerFromActor(a); if (c) map[a.name] = c; } } catch { /* no actors yet */ }
  return map;
}

async function persistAll() {
  try { storyTracker.ingest(sessionLog.events, storyCareers()); } catch { /* story is best-effort */ }
  try { await game.settings.set(MODULE_ID, "sessionLogData", sessionLog.toJSON()); } catch { /* best effort */ }
  try { await game.settings.set(MODULE_ID, "storyTrackerData", storyTracker.toJSON()); } catch { /* best effort */ }
}

function persistLogSoon() {
  if (!isActiveGM()) return Promise.resolve();
  if (persistTimer) clearTimeout(persistTimer);
  return new Promise((resolve) => {
    persistTimer = setTimeout(async () => { await persistAll(); resolve(); }, 2000);
  });
}

async function persistLogNow() {
  if (!isActiveGM()) return;
  if (persistTimer) clearTimeout(persistTimer);
  await persistAll();
}

const player = new BardicPlayer({
  sessionLog, storyTracker,
  getConfig,
  persistLog: persistLogNow,
  onStateChange: (s) => { mirrorStatus = s; renderUi(); if (statusApp?.rendered) void statusApp.render(); },
});

function currentStatus() {
  return mirrorStatus ?? player.status();
}

/**
 * Paint the on-screen bard feedback (corner HUD + sidebar work log) and
 * report which panels actually mounted, so a mount failure is visible in
 * the console / a GM notification instead of a silently empty screen.
 */
function renderUi() {
  const s = currentStatus();
  let hud = null;
  let sidebar = null;
  try { hud = renderBardicHud(s); } catch (e) { console.warn(`${MODULE_ID} | corner HUD render failed`, e); }
  try { sidebar = renderBardicSidebar(s); } catch (e) { console.warn(`${MODULE_ID} | sidebar panel render failed`, e); }
  return { hud, sidebar };
}

function openStatus() {
  if (!statusApp) statusApp = new BardicStatusApp({ player, log: sessionLog, story: storyTracker, mirror: currentStatus });
  void player.checkHealth();
  void statusApp.render(true);
}

/** A single crit/fumble (or wound/corruption) earns a fresh track soon, not two tracks later. */
function scheduleMusePrefetch() {
  if (!isActiveGM() || player.state !== "playing") return;
  if (museTimer) return;
  museTimer = setTimeout(() => {
    museTimer = null;
    const f = extractFeatures(
      sessionLog.museRolls(), sessionLog.museChat(),
      sessionLog.museWounds(), sessionLog.museCorruption(), sessionLog.museDeaths(),
    );
    if (f.crits > 0 || f.fumbles > 0 || museSignificance(f) >= 6) void player.expediteForMuse().catch((e) => player.failSoftly(e));
  }, 4000);
}

/**
 * Combat start, however it is first noticed: the combatStart hook, an
 * initiative roll in chat, or initiative landing on a combatant. Logged
 * once per combat; the mode switch itself dedupes inside the player.
 */
function handleCombatStart(combatId, via, now = Date.now()) {
  const started = sessionLog.markCombatStarted(combatId ?? null, now, { via });
  if (started) persistLogSoon();
  if (getConfig().autoCombat && isActiveGM()) void player.setMode(Mode.COMBAT);
  return Boolean(started);
}

function bardAndActorNames() {
  const chars = [...(game.actors ?? [])].filter((a) => a.type === "character");
  const bardNames = chars.filter((a) => {
    try { return /busker|entertainer|troubadour|maestro|minstrel|bard/i.test(a.currentCareer?.name ?? ""); } catch { return false; }
  }).map((a) => a.name);
  return { actorNames: chars.map((a) => a.name), bardNames };
}

function bardRequestFromChat(message, now) {
  try {
    return requestEventFromMessage(
      { content: message.content, speaker: message.speaker, timestamp: message.timestamp },
      now, bardAndActorNames(),
    );
  } catch { return null; }
}

async function postBardAck(reqEv) {
  try {
    const bardActor = reqEv.bard ? game.actors?.getName?.(reqEv.bard) : null;
    await ChatMessage.create({
      content: `♪ ${bardAckText(reqEv)}`,
      speaker: bardActor ? { actor: bardActor.id, alias: bardActor.name } : { alias: "The Bards" },
      flags: { [MODULE_ID]: { requestAck: true } },
    });
  } catch (e) { console.warn(`${MODULE_ID} | bard ack failed`, e); }
}

Hooks.once("init", () => {
  registerSettings();
  registerSceneControls({ player, openStatus });
  console.log(`${MODULE_ID} | Bardic Dice initialized`);
});

Hooks.once("ready", async () => {
  try {
    const saved = game.settings.get(MODULE_ID, "sessionLogData");
    const restored = SessionLog.fromJSON(saved);
    sessionLog.events = restored.events;
    sessionLog.checkpointTs = restored.checkpointTs;
    sessionLog.prune();
  } catch (e) { console.warn(`${MODULE_ID} | session log restore failed`, e); }
  try {
    const restoredStory = StoryTracker.fromJSON(game.settings.get(MODULE_ID, "storyTrackerData"));
    Object.assign(storyTracker, restoredStory);
    storyTracker.ingest(sessionLog.events, storyCareers());
  } catch (e) { console.warn(`${MODULE_ID} | story tracker restore failed`, e); }

  if (getConfig().autoCombat && game.combat?.started) player.mode = Mode.COMBAT;
  if (game.system?.id === "wfrp4e") {
    try { for (const actor of game.actors ?? []) rememberCorruption(actor); } catch { /* baselines refill on updates */ }
  }
  // Death baselines for every system: an actor first seen dead earns no dirge.
  try { for (const actor of game.actors ?? []) rememberDeath(actor); } catch { /* baselines refill on updates */ }

  game.socket?.on(SOCKET_CHANNEL, (payload) => {
    if (payload?.type === "state") {
      mirrorStatus = payload.status;
      renderUi();
      if (statusApp?.rendered) void statusApp.render();
    }
  });
  // Foundry rebuilds the sidebar DOM when its app re-renders; re-dock the panel.
  Hooks.on("renderSidebar", () => { try { renderBardicSidebar(currentStatus()); } catch { /* best-effort */ } });

  // Self-check: both on-screen panels must actually mount. The sidebar app
  // can finish rendering after "ready", so retry once before alarming the GM.
  const mounted = renderUi();
  if (!mounted.hud || !mounted.sidebar) {
    setTimeout(() => {
      const retry = renderUi();
      const missing = [!retry.hud && "corner HUD", !retry.sidebar && "Lyric Bot panel"].filter(Boolean);
      if (missing.length) {
        console.warn(`${MODULE_ID} | on-screen panels failed to mount: ${missing.join(", ")}`);
        if (isActiveGM()) ui.notifications?.warn(`Bardic Dice: the ${missing.join(" and ")} did not appear on screen. Reload the world; if it persists, check the browser console.`);
      }
    }, 2500);
  }
  // Keep the corner countdown ticking between state changes.
  setInterval(() => { renderUi(); }, 5000);

  const mod = game.modules.get(MODULE_ID);
  if (mod) {
    mod.api = {
      player, sessionLog, storyTracker,
      story: () => { storyTracker.ingest(sessionLog.events, storyCareers()); return { summary: storyTracker.summaryForBards(), lines: storyTracker.contextLines(9) }; },
      start: () => player.start(), pause: () => player.pauseToggle(),
      stop: () => player.stop(), onBreak: () => player.onBreak(),
      // Manual fallback if detection misses a death: api.dirge("Brunhilde", "Soldier")
      dirge: (actor, career = null) => {
        const ev = deathEventFromActor({ actor: String(actor ?? ""), career }, Date.now());
        return ev ? handleDeath(ev) : false; // handleDeath logs it and sings on the active GM
      },
      status: currentStatus, openStatus,
    };
  }

  if (isActiveGM()) void player.checkHealth();
  console.log(`${MODULE_ID} | ready — v${mod?.version ?? "?"} (${sessionLog.events.length} logged events restored)`);
});

Hooks.on("createChatMessage", (message) => {
  try {
    const cfg = getConfig();
    if (message.getFlag?.(MODULE_ID, "recap") || message.getFlag?.(MODULE_ID, "requestAck")) return;
    if ((message.speaker?.alias ?? "") === "Bardic Dice") return;
    if (!isPublicMessage(message) && !cfg.includeSecret) return;
    const now = Date.now();
    const wfrpTest = game.system?.id === "wfrp4e" ? wfrpTestPayloadFromMessage(message) : null;
    const rollEv = rollEventFromMessage({
      rolls: message.rolls, wfrpTest, systemId: game.system?.id,
      flavor: message.flavor, speaker: message.speaker, timestamp: message.timestamp,
    }, now);
    if (rollEv) {
      sessionLog.add(rollEv, now);
      persistLogSoon();
      if (isInitiativeRoll({ flavor: message.flavor, content: message.content })) {
        handleCombatStart(game.combat?.id ?? null, "initiative-roll", now);
      }
      if (rollEv.isCrit || rollEv.isFumble) scheduleMusePrefetch();
      return;
    }
    const text = String(message.content ?? "").trim();
    if (!text || text.startsWith("/")) return;
    if (cfg.playerRequests !== false) {
      const reqEv = bardRequestFromChat(message, now);
      if (reqEv) {
        sessionLog.add(reqEv, now);
        persistLogSoon();
        if (isActiveGM()) void postBardAck(reqEv);
        scheduleMusePrefetch();
        return;
      }
    }
    const chatEv = chatEventFromMessage({
      content: message.content, speaker: message.speaker, timestamp: message.timestamp,
    }, now);
    if (chatEv) { sessionLog.add(chatEv, now); persistLogSoon(); }
  } catch (e) { console.warn(`${MODULE_ID} | chat capture failed`, e); }
});

Hooks.on("combatStart", (combat) => {
  handleCombatStart(combat?.id ?? null, "hook");
});

Hooks.on("updateCombat", (combat, changed) => {
  if (changed && "round" in changed) {
    sessionLog.addCombat("round", Date.now(), { round: changed.round });
    persistLogSoon();
  }
});

Hooks.on("deleteCombat", (combat) => {
  sessionLog.markCombatEnded(combat?.id ?? null, Date.now());
  persistLogSoon();
  if (getConfig().autoCombat && isActiveGM()) {
    const stillFighting = game.combats?.some?.((c) => c.started) ?? false;
    if (!stillFighting) void player.setMode(Mode.TAVERN);
  }
});

// WFRP4e: an owned Critical Wound item is the moment the wound actually lands.
Hooks.on("createItem", (item) => {
  try {
    if (game.system?.id !== "wfrp4e") return;
    const event = critWoundEventFromItem(item);
    if (!event) return;
    sessionLog.add(event, event.ts);
    persistLogSoon();
    // A fatal Critical Wound ("…dies instantly") is a death even at >0 Wounds.
    if (isFatalCriticalWound(item)) {
      const death = deathEventFromActor(item.parent, event.ts, event.name);
      if (death && handleDeath(death)) return;
    }
    scheduleMusePrefetch();
  } catch (e) { console.warn(`${MODULE_ID} | Critical Wound capture failed`, e); }
});

// Combat tracker: a player character marked Defeated has fallen. This is
// the death the old log missed — no roll chat and no wound item need occur.
Hooks.on("updateCombatant", (combatant, changed) => {
  try {
    if (!changed) return;
    // Initiative landing on a combatant is combat starting, even when the
    // combatStart hook is missed or the tracker starts later.
    if ("initiative" in changed && changed.initiative != null) {
      handleCombatStart(combatant?.combat?.id ?? game.combat?.id ?? null, "initiative");
    }
    if (!("defeated" in changed) || changed.defeated !== true) return;
    const actor = combatant?.actor ?? (combatant?.actorId ? game.actors?.get(combatant.actorId) : null);
    if (!actor) return;
    handleDeath(deathEventFromActor(actor, Date.now()));
  } catch (e) { console.warn(`${MODULE_ID} | defeated capture failed`, e); }
});

// A Dead condition applied as an ActiveEffect may not change actor data.
Hooks.on("createActiveEffect", (effect) => {
  try {
    const actor = effect?.parent;
    if (!actor?.id || (actor.documentName && actor.documentName !== "Actor")) return;
    const previousSnap = deathBaseline.get(actor.id);
    const currentSnap = rememberDeath(actor);
    const death = deathEventFromTransition(previousSnap, currentSnap);
    if (death) handleDeath(death);
  } catch (e) { console.warn(`${MODULE_ID} | Dead-condition capture failed`, e); }
});

// WFRP4e: watch the authoritative Corruption total. A baseline prevents a
// false sting when an actor is first observed or imported mid-session.
Hooks.on("createActor", (actor) => {
  if (game.system?.id === "wfrp4e") rememberCorruption(actor);
  rememberDeath(actor);
});

Hooks.on("updateActor", (actor) => {
  try {
    if (!actor?.id) return;
    // Death (every system): Wounds/HP reaching 0, a Dead status/flag, or
    // WFRP Critical Wounds past their maximum — proven against the baseline.
    const previousSnap = deathBaseline.get(actor.id);
    const currentSnap = rememberDeath(actor);
    const death = deathEventFromTransition(previousSnap, currentSnap);
    if (death) handleDeath(death);

    if (game.system?.id !== "wfrp4e") return;
    const current = currentCorruption(actor);
    if (current == null) return;
    const previous = corruptionBaseline.get(actor.id);
    const event = corruptionGainEvent(previous, current, actor.name);
    corruptionBaseline.set(actor.id, current);
    if (!event) return;
    sessionLog.add(event, event.ts);
    persistLogSoon();
    if (isActiveGM()) void player.playCorruptionSting(actor.name);
    scheduleMusePrefetch();
  } catch (e) { console.warn(`${MODULE_ID} | Actor update capture failed`, e); }
});
