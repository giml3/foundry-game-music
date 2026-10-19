// Compact ApplicationV2 status popover opened from the scene-controls tool.
// Falls back gracefully if ApplicationV2 internals shift: rendering is all
// Handlebars via a single template part.
import { MODULE_ID } from "./constants.js";

export class BardicStatusApp extends foundry.applications.api.HandlebarsApplicationMixin(foundry.applications.api.ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "bardic-dice-status",
    window: { title: "Bardic Dice", resizable: false },
    position: { width: 360, height: "auto" },
    actions: {
      "bd-start": BardicStatusApp.#onStart,
      "bd-pause": BardicStatusApp.#onPause,
      "bd-stop": BardicStatusApp.#onStop,
      "bd-break": BardicStatusApp.#onBreak,
      "bd-refresh": BardicStatusApp.#onRefresh,
    },
  };

  static PARTS = {
    main: { template: `modules/${MODULE_ID}/templates/status.hbs` },
  };

  /** @param {{player: object, log: object, mirror: Function}} deps */
  constructor(deps, options = {}) {
    super(options);
    this.deps = deps;
  }

  async _prepareContext() {
    const s = this.deps.mirror();
    const sum = this.deps.log.summary();
    return {
      state: s.state + (s.generating ? " (composing…)" : ""),
      mode: s.mode,
      nowPlaying: s.nowPlaying,
      nextTrack: s.nextTrack,
      healthOk: s.healthOk === true,
      why: s.why ?? "",
      isGM: game.user?.isGM === true,
      logSummary: `${sum.rolls} rolls · ${sum.chats} chats · ${sum.combats} combats`,
    };
  }

  static async #onStart() { await this.deps.player.start(); void this.render(); }
  static async #onPause() { await this.deps.player.pauseToggle(); void this.render(); }
  static async #onStop() { await this.deps.player.stop(); void this.render(); }
  static async #onBreak() { await this.deps.player.onBreak(); void this.render(); }
  static async #onRefresh() { await this.deps.player.checkHealth(); void this.render(); }
}
