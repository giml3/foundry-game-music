// GM-configurable world settings. The API-key fields are world scope but
// only ever read by the GM client that performs generation.
import { Bawdy, DEFAULT_ACE_MODEL, DEFAULT_ACE_URL, MODULE_ID } from "./constants.js";

export function registerSettings() {
  const s = (key, opts) => game.settings.register(MODULE_ID, key, opts);
  const L = (k) => `BARDICDICE.Settings.${k}`;

  s("aceBaseUrl", { name: L("AceBaseUrl"), hint: L("AceBaseUrlHint"), scope: "world", config: true, type: String, default: DEFAULT_ACE_URL });
  s("aceApiKey", { name: L("AceApiKey"), hint: L("AceApiKeyHint"), scope: "world", config: true, type: String, default: "" });
  s("aceModel", { name: L("AceModel"), hint: L("AceModelHint"), scope: "world", config: true, type: String, default: DEFAULT_ACE_MODEL });
  s("inferenceSteps", { name: L("InferenceSteps"), hint: L("InferenceStepsHint"), scope: "world", config: true, type: Number, default: 8, range: { min: 1, max: 200, step: 1 } });
  s("thinking", { name: L("Thinking"), hint: L("ThinkingHint"), scope: "world", config: true, type: Boolean, default: true });
  s("tavernDuration", { name: L("TavernDuration"), scope: "world", config: true, type: Number, default: 90, range: { min: 30, max: 300, step: 10 } });
  s("combatDuration", { name: L("CombatDuration"), scope: "world", config: true, type: Number, default: 90, range: { min: 30, max: 300, step: 10 } });
  s("breakDuration", { name: L("BreakDuration"), scope: "world", config: true, type: Number, default: 240, range: { min: 60, max: 600, step: 10 } });
  s("bawdyLevel", {
    name: L("BawdyLevel"), scope: "world", config: true, type: String, default: Bawdy.BAWDY,
    choices: { clean: L("BawdyClean"), bawdy: L("BawdyBawdy"), filthy: L("BawdyFilthy") },
  });
  s("autoCombat", { name: L("AutoCombat"), hint: L("AutoCombatHint"), scope: "world", config: true, type: Boolean, default: true });
  s("vocalLanguage", { name: L("VocalLanguage"), hint: L("VocalLanguageHint"), scope: "world", config: true, type: String, default: "en" });
  s("includeSecret", { name: L("IncludeSecret"), hint: L("IncludeSecretHint"), scope: "world", config: true, type: Boolean, default: false });
  s("volume", { name: L("Volume"), scope: "world", config: true, type: Number, default: 0.6, range: { min: 0.05, max: 1, step: 0.05 } });
  s("uploadFolder", { name: L("UploadFolder"), hint: L("UploadFolderHint"), scope: "world", config: true, type: String, default: "bardic-dice" });
  s("journalRecap", { name: L("JournalRecap"), scope: "world", config: true, type: Boolean, default: true });
  s("corruptionSting", { name: L("CorruptionSting"), hint: L("CorruptionStingHint"), scope: "world", config: true, type: Boolean, default: true });
  s("summarizerEnabled", { name: L("SummarizerEnabled"), hint: L("SummarizerEnabledHint"), scope: "world", config: true, type: Boolean, default: false });
  s("summarizerBaseUrl", { name: L("SummarizerBaseUrl"), hint: L("SummarizerBaseUrlHint"), scope: "world", config: true, type: String, default: "http://127.0.0.1:11434/v1" });
  s("summarizerApiKey", { name: L("SummarizerApiKey"), scope: "world", config: true, type: String, default: "" });
  s("summarizerModel", { name: L("SummarizerModel"), scope: "world", config: true, type: String, default: "llama3.1" });
  // Hidden persistence: rolling session log survives GM browser refresh.
  s("sessionLogData", { scope: "world", config: false, type: Object, default: { version: 1, checkpointTs: 0, events: [] } });
}

export function getConfig() {
  const g = (k) => game.settings.get(MODULE_ID, k);
  return {
    aceBaseUrl: g("aceBaseUrl"), aceApiKey: g("aceApiKey"), aceModel: g("aceModel"),
    inferenceSteps: g("inferenceSteps"), thinking: g("thinking"),
    tavernDuration: g("tavernDuration"), combatDuration: g("combatDuration"), breakDuration: g("breakDuration"),
    bawdy: g("bawdyLevel"), autoCombat: g("autoCombat"), vocalLanguage: g("vocalLanguage"),
    includeSecret: g("includeSecret"), volume: g("volume"), uploadFolder: g("uploadFolder"),
    journalRecap: g("journalRecap"),
    corruptionSting: g("corruptionSting"),
    summarizerEnabled: g("summarizerEnabled"), summarizerBaseUrl: g("summarizerBaseUrl"),
    summarizerApiKey: g("summarizerApiKey"), summarizerModel: g("summarizerModel"),
  };
}
