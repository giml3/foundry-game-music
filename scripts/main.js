// Bardic Dice — entry point. Wires Foundry hooks to the session log and the
// GM-side playback engine. Only the *active* GM persists the log and drives
// automatic generation; manual toolbar actions are GM-gated in the engine.
import { MODULE_ID, Mode, SOCKET_CHANNEL } from "./constants.js";
import { getConfig, registerSettings } from "./settings.js";
import { BardicPlayer } from "./player-engine.js";
import { BardicStatusApp } from "./status-app.js";
import { registerSceneControls } from "./controls.js";
import { SessionLog, chatEventFromMessage, isPublicMessage, rollEventFromMessage } from "./session-log.js";
import { extractFeatures, museSignificance } from "./prompt-engine.js";

const sessionLog = new SessionLog();
let mirrorStatus = null;
let statusApp = null;
let persistTimer = null;
let museTimer = null;

function isActiveGM() {
  return game.user?.isGM === true && (game.users?.activeGM?.id ?? game.user.id) === game.user.id;
}

function persistLogSoon() {
  if (!isActiveGM()) return Promise.resolve();
  if (persistTimer) clearTimeout(persistTimer);
  return new Promise((resolve) => {
    persistTimer = setTimeout(async () => {
      try { await game.settings.set(MODULE_ID, "sessionLogData", sessionLog.toJSON()); } catch { /* best effort */ }
      resolve();
    }, 2000);
  });
}

async function persistLogNow() {
  if (!isActiveGM()) return;
  if (persistTimer) clearTimeout(persistTimer);
  try { await game.settings.set(MODULE_ID, "sessionLogData", sessionLog.toJSON()); } catch { /* best effort */ }
}

const player = new BardicPlayer({
  sessionLog,
  getConfig,
  persistLog: persistLogNow,
  onStateChange: (s) => { mirrorStatus = s; if (statusApp?.rendered) void statusApp.render(); },
});

function currentStatus() {
  return mirrorStatus ?? player.status();
}

function openStatus() {
  if (!statusApp) statusApp = new BardicStatusApp({ player, log: sessionLog, mirror: currentStatus });
  void player.checkHealth();
  void statusApp.render(true);
}

/** A fresh crit/fumble at a loud table earns an early next-track composition. */
function scheduleMusePrefetch() {
  if (!isActiveGM() || player.state !== "playing" || player.next || player.generating) return;
  if (museTimer) return;
  museTimer = setTimeout(() => {
    museTimer = null;
    const f = extractFeatures(sessionLog.museRolls(), sessionLog.museChat());
    if (museSignificance(f) >= 6) void player.ensureNext().catch((e) => player.failSoftly(e));
  }, 4000);
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

  if (getConfig().autoCombat && game.combat?.started) player.mode = Mode.COMBAT;

  game.socket?.on(SOCKET_CHANNEL, (payload) => {
    if (payload?.type === "state") {
      mirrorStatus = payload.status;
      if (statusApp?.rendered) void statusApp.render();
    }
  });

  const mod = game.modules.get(MODULE_ID);
  if (mod) {
    mod.api = {
      player, sessionLog,
      start: () => player.start(), pause: () => player.pauseToggle(),
      stop: () => player.stop(), onBreak: () => player.onBreak(),
      status: currentStatus, openStatus,
    };
  }

  if (isActiveGM()) void player.checkHealth();
  console.log(`${MODULE_ID} | ready (${sessionLog.events.length} logged events restored)`);
});

Hooks.on("createChatMessage", (message) => {
  try {
    const cfg = getConfig();
    if (message.getFlag?.(MODULE_ID, "recap")) return;
    if ((message.speaker?.alias ?? "") === "Bardic Dice") return;
    if (!isPublicMessage(message) && !cfg.includeSecret) return;
    const now = Date.now();
    const rollEv = rollEventFromMessage({
      rolls: message.rolls, flavor: message.flavor, speaker: message.speaker, timestamp: message.timestamp,
    }, now);
    if (rollEv) {
      sessionLog.add(rollEv, now);
      persistLogSoon();
      if (rollEv.isCrit || rollEv.isFumble) scheduleMusePrefetch();
      return;
    }
    const text = String(message.content ?? "").trim();
    if (!text || text.startsWith("/")) return;
    const chatEv = chatEventFromMessage({
      content: message.content, speaker: message.speaker, timestamp: message.timestamp,
    }, now);
    if (chatEv) { sessionLog.add(chatEv, now); persistLogSoon(); }
  } catch (e) { console.warn(`${MODULE_ID} | chat capture failed`, e); }
});

Hooks.on("combatStart", (combat) => {
  sessionLog.addCombat("start", Date.now(), { round: combat?.round ?? 1 });
  persistLogSoon();
  if (getConfig().autoCombat && isActiveGM()) void player.setMode(Mode.COMBAT);
});

Hooks.on("updateCombat", (combat, changed) => {
  if (changed && "round" in changed) {
    sessionLog.addCombat("round", Date.now(), { round: changed.round });
    persistLogSoon();
  }
});

Hooks.on("deleteCombat", () => {
  sessionLog.addCombat("end", Date.now());
  persistLogSoon();
  if (getConfig().autoCombat && isActiveGM()) {
    const stillFighting = game.combats?.some?.((c) => c.started) ?? false;
    if (!stillFighting) void player.setMode(Mode.TAVERN);
  }
});
