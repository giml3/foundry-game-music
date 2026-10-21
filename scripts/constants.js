// Shared constants. Pure module: safe to import in Node tests (no Foundry globals).
export const MODULE_ID = "foundry-game-music";
export const MODULE_TITLE = "Bardic Dice";
export const SOCKET_CHANNEL = `module.${MODULE_ID}`;
export const PLAYLIST_NAME = "Bardic Dice — Live";
export const JOURNAL_NAME = "Session Ballads";
export const DEFAULT_ACE_URL = "http://127.0.0.1:8001";
export const DEFAULT_ACE_MODEL = "acestep-v15-turbo";

/** Playback / generation states. */
export const State = Object.freeze({
  STOPPED: "stopped",
  PLAYING: "playing",
  PAUSED: "paused",
  GENERATING: "generating",
  BREAK: "break",
});

/** Musical modes that select a prompt profile. */
export const Mode = Object.freeze({
  TAVERN: "tavern",
  COMBAT: "combat",
  BREAK: "break",
  DIRGE: "dirge",
});

export const Bawdy = Object.freeze({ CLEAN: "clean", BAWDY: "bawdy", FILTHY: "filthy" });

/** Rolling session-log limits: the "last 2-3 hours" the break ballad covers. */
export const LOG_WINDOW_MS = 3 * 60 * 60 * 1000;
export const LOG_MAX_EVENTS = 2000;
/** Window the *next-track* muse looks at. */
export const MUSE_WINDOW_MS = 5 * 60 * 1000;
export const MUSE_MAX_ROLLS = 12;

/** Loop playback: vocal songs alternate with instrumental bridges. */
export const CROSSFADE_MS = 4000;
/** A bridge plays at least this long before yielding to the next vocal song. */
export const BRIDGE_MIN_SEC = 25;
/** While a bridge (or loop-hold) plays, re-check for the next vocal this often. */
export const BRIDGE_CHECK_SEC = 15;
/** After combat starts/ends, the current track yields within this long. */
export const MODE_SWITCH_SEC = 12;
/** A fresh crit/fumble earns a fresh track within this long. */
export const MUSE_SWITCH_SEC = 40;
/** Minimum gap between crit/fumble-expedited track changes. */
export const EXPEDITE_COOLDOWN_MS = 90_000;
/** Only this many tracks are composed ahead (GPU relief: fewer orphans). */
export const QUEUE_AHEAD = 1;
/** Combat renders are capped here so a switch lands fast (tracks loop). */
export const COMBAT_DURATION_CAP_SEC = 120;
/** Combat bridge renders are capped here for the same reason. */
export const COMBAT_BRIDGE_CAP_SEC = 60;
/** LLM polish is skipped while an urgent switch is younger than this. */
export const URGENT_POLISH_WINDOW_MS = 30_000;
