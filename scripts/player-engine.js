// Playback engine (GM client only): generates tracks with ACE-Step,
// uploads them to Foundry storage, and plays them through a dedicated
// Playlist so every player hears the same music with native sync/volume.
// The next track is composed while the current one plays; mode changes
// (tavern <-> combat) land on track boundaries because ACE-Step renders
// whole files, never streams.
import { JOURNAL_NAME, Mode, MODULE_ID, PLAYLIST_NAME, SOCKET_CHANNEL, State } from "./constants.js";
import { AceStepClient } from "./ace-client.js";
import { buildTrackRequest } from "./prompt-engine.js";
import { aggregateBreakStats, buildBreakRequest, buildTemplateBallad, fetchSummarizerLyrics } from "./recap.js";

export function escapeHtml(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function trackFilename(mode, seq, date = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  const stamp = `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
  return `bardic-${stamp}-${seq}-${String(mode).replace(/[^a-z0-9-]/gi, "")}.mp3`;
}

export class BardicPlayer {
  constructor({ sessionLog, getConfig, onStateChange = null, persistLog = null } = {}) {
    this.log = sessionLog;
    this.getConfig = getConfig;
    this.onStateChange = onStateChange;
    this.persistLog = persistLog;
    this.state = State.STOPPED;
    this.mode = Mode.TAVERN;
    this.current = null; // {soundId,title,why,duration,kind,startedAt,lyrics}
    this.next = null;
    this.generating = false;
    this.generation = 0; // bump to cancel in-flight work on Stop
    this.trackSeq = 0;
    this.healthOk = null;
    this.lastWhy = "";
    this._prefetchTimer = null;
    this._advanceTimer = null;
  }

  ace() {
    const c = this.getConfig();
    return new AceStepClient({ baseUrl: c.aceBaseUrl, apiKey: c.aceApiKey });
  }

  status() {
    return {
      state: this.state, mode: this.mode, generating: this.generating,
      nowPlaying: this.current?.title ?? "—", nextTrack: this.next?.title ?? (this.generating ? "composing…" : "—"),
      why: this.lastWhy, healthOk: this.healthOk,
    };
  }

  emit() {
    const s = this.status();
    try { this.onStateChange?.(s); } catch { /* UI observer */ }
    try { game.socket?.emit(SOCKET_CHANNEL, { type: "state", status: s }); } catch { /* no socket */ }
    try { Hooks.callAll("bardicDiceState", s); } catch { /* no Hooks in tests */ }
  }

  assertGM() {
    if (game.user?.isGM) return true;
    ui.notifications?.warn(game.i18n?.localize("BARDICDICE.OnlyGM") ?? "Only the GM can control Bardic Dice generation.");
    return false;
  }

  async checkHealth() {
    this.healthOk = await this.ace().healthCheck();
    this.emit();
    return this.healthOk;
  }

  async ensurePlaylist() {
    let pl = game.playlists?.getName(PLAYLIST_NAME) ?? game.playlists?.find((p) => p.name === PLAYLIST_NAME);
    if (!pl) pl = await Playlist.create({ name: PLAYLIST_NAME });
    return pl;
  }

  async uploadBlob(blob, filename) {
    const folder = this.getConfig().uploadFolder || "bardic-dice";
    try { await FilePicker.createDirectory("data", folder); } catch { /* already exists */ }
    const file = new File([blob], filename, { type: "audio/mpeg" });
    const resp = await FilePicker.upload("data", folder, file, {}, { notify: false });
    if (!resp?.path) throw new Error("FilePicker upload returned no path");
    return resp.path;
  }

  /** Generate + upload + register one track (does not start playback). */
  async generateTrack(req, kind) {
    const c = this.getConfig();
    const token = this.generation;
    this.generating = true;
    this.lastWhy = req.why ?? "";
    this.emit();
    try {
      ui.notifications?.info(`♪ ${game.i18n?.localize("BARDICDICE.Generating") ?? "Bard is composing…"}`);
      const out = await this.ace().generate({
        prompt: req.prompt, lyrics: req.lyrics, bpm: req.bpm, keyScale: req.keyScale,
        timeSignature: req.timeSignature, duration: req.duration,
        model: c.aceModel, inferenceSteps: c.inferenceSteps, thinking: c.thinking,
        vocalLanguage: c.vocalLanguage, useFormat: true,
      });
      if (token !== this.generation) return null; // stopped while composing
      const path = await this.uploadBlob(out.blob, trackFilename(kind, ++this.trackSeq));
      if (token !== this.generation) return null;
      const pl = await this.ensurePlaylist();
      const [sound] = await pl.createEmbeddedDocuments("PlaylistSound", [{
        name: req.title, path, volume: c.volume, repeat: false,
        flags: { [MODULE_ID]: { why: req.why ?? "", lyrics: out.lyrics ?? req.lyrics ?? "" } },
      }]);
      await this.pruneOldSounds(pl);
      return { soundId: sound.id, title: req.title, why: req.why ?? "", duration: req.duration, kind, lyrics: out.lyrics ?? req.lyrics ?? "" };
    } finally {
      this.generating = false;
      this.emit();
    }
  }

  async pruneOldSounds(pl) {
    try {
      const keep = new Set([this.current?.soundId, this.next?.soundId].filter(Boolean));
      const sounds = [...(pl.sounds ?? [])];
      const excess = sounds.slice(0, Math.max(0, sounds.length - 8)).filter((s) => !keep.has(s.id) && !s.playing);
      if (excess.length) await pl.deleteEmbeddedDocuments("PlaylistSound", excess.map((s) => s.id));
    } catch { /* pruning is best-effort */ }
  }

  buildNextRequest(mode) {
    const c = this.getConfig();
    const now = Date.now();
    return buildTrackRequest({
      mode, rolls: this.log.museRolls(now), chats: this.log.museChat(now),
      bawdy: c.bawdy, tavernDuration: c.tavernDuration, combatDuration: c.combatDuration,
    });
  }

  async playTrack(track) {
    const pl = await this.ensurePlaylist();
    const sound = pl.sounds?.get(track.soundId);
    if (!sound) throw new Error("PlaylistSound vanished before playback");
    await pl.playSound(sound);
    this.current = { ...track, startedAt: Date.now() };
    if (this.next?.soundId === track.soundId) this.next = null;
    this.state = State.PLAYING;
    this.lastWhy = track.why ?? this.lastWhy;
    this.scheduleTimers(track.duration);
    this.emit();
  }

  scheduleTimers(durationSec, elapsedSec = 0) {
    this.clearTimers();
    const remain = Math.max(5, durationSec - elapsedSec);
    const prefetchIn = Math.max(5, remain - 25) * 1000;
    const advanceIn = (remain + 1) * 1000;
    this._prefetchTimer = setTimeout(() => { void this.ensureNext().catch((e) => this.failSoftly(e)); }, prefetchIn);
    this._advanceTimer = setTimeout(() => { void this.advance().catch((e) => this.failSoftly(e)); }, advanceIn);
  }

  clearTimers() {
    if (this._prefetchTimer) clearTimeout(this._prefetchTimer);
    if (this._advanceTimer) clearTimeout(this._advanceTimer);
    this._prefetchTimer = this._advanceTimer = null;
  }

  async ensureNext() {
    if (this.state !== State.PLAYING || this.generating || this.next) return;
    if (this.current?.kind === Mode.BREAK && !this._resumeAfterBreak) return;
    const track = await this.generateTrack(this.buildNextRequest(this.mode), this.mode);
    if (track && this.state === State.PLAYING && !this.next) { this.next = track; this.emit(); }
  }

  async advance() {
    if (this.state !== State.PLAYING) return;
    if (this.current?.kind === Mode.BREAK && !this._resumeAfterBreak) {
      this.state = State.STOPPED;
      this.current = null;
      this.emit();
      return;
    }
    if (this.next) { await this.playTrack(this.next); return; }
    const track = await this.generateTrack(this.buildNextRequest(this.mode), this.mode);
    if (track && this.state === State.PLAYING) await this.playTrack(track);
  }

  failSoftly(e) {
    console.error(`${MODULE_ID} |`, e);
    ui.notifications?.error(`Bardic Dice: ${e?.message ?? e}`);
    if (this.state === State.GENERATING) this.state = State.STOPPED;
    this.emit();
  }

  /** Toolbar: Start */
  async start() {
    if (!this.assertGM() || this.state === State.PLAYING) return;
    const c = this.getConfig();
    if (c.autoCombat && game.combat?.started) this.mode = Mode.COMBAT;
    this.state = State.GENERATING;
    this.emit();
    try {
      if (!(await this.checkHealth())) {
        ui.notifications?.error(game.i18n?.localize("BARDICDICE.ServerDown") ?? "ACE-Step server unreachable — is the sidecar running?");
        this.state = State.STOPPED;
        this.emit();
        return;
      }
      await this.ensurePlaylist();
      if (this.next) { await this.playTrack(this.next); return; }
      const track = await this.generateTrack(this.buildNextRequest(this.mode), this.mode);
      if (track) await this.playTrack(track);
      else if (this.state === State.GENERATING) this.state = State.STOPPED;
    } catch (e) { this.state = State.STOPPED; this.failSoftly(e); }
  }

  /** Toolbar: Pause / Resume (synced for everyone through the PlaylistSound doc). */
  async pauseToggle() {
    if (!this.assertGM()) return;
    try {
      const pl = await this.ensurePlaylist();
      const sound = this.current ? pl.sounds?.get(this.current.soundId) : null;
      if (this.state === State.PLAYING && sound) {
        const t = sound.sound?.currentTime ?? sound.pausedTime ?? 0;
        await sound.update({ playing: false, pausedTime: t });
        this.current.pausedTime = t;
        this.state = State.PAUSED;
        this.clearTimers();
      } else if (this.state === State.PAUSED && sound) {
        await pl.playSound(sound);
        this.state = State.PLAYING;
        this.scheduleTimers(this.current.duration, this.current.pausedTime ?? 0);
      }
    } catch (e) { this.failSoftly(e); }
    this.emit();
  }

  /** Toolbar: Stop — halts playback and cancels in-flight generation. */
  async stop() {
    if (!this.assertGM()) return;
    this.generation += 1;
    this.clearTimers();
    this.state = State.STOPPED;
    this.current = null;
    try { await (await this.ensurePlaylist()).stopAll(); } catch { /* already silent */ }
    this.emit();
  }

  /** Called by combat hooks. The new tempo starts with the next track. */
  async setMode(mode) {
    if (mode === this.mode) return;
    this.mode = mode;
    this.next = null; // a queued tavern track must not play over round 1
    this.emit();
    if (this.state === State.PLAYING) {
      // Compose the new-mode track now so the switch lands quickly.
      try { await this.ensureNext(); } catch (e) { this.failSoftly(e); }
    }
  }

  /** Toolbar: On Break — recap ballad of the last 2-3 hours (or since last break). */
  async onBreak() {
    if (!this.assertGM()) return;
    const c = this.getConfig();
    const now = Date.now();
    const events = this.log.breakWindow(now);
    const stats = aggregateBreakStats(events);
    const template = buildTemplateBallad(stats, { bawdy: c.bawdy });
    let lyrics = template.lyrics;
    ui.notifications?.info(game.i18n?.localize("BARDICDICE.BreakStarted") ?? "On break — composing your recap ballad…");
    if (c.summarizerEnabled) {
      try {
        lyrics = await fetchSummarizerLyrics({
          baseUrl: c.summarizerBaseUrl, apiKey: c.summarizerApiKey, model: c.summarizerModel,
          stats, events, bawdy: c.bawdy,
        });
      } catch (e) {
        console.warn(`${MODULE_ID} | summarizer failed, using template ballad`, e);
        ui.notifications?.warn(`Bardic Dice: recap writer unreachable (${e?.message ?? e}) — using the house ballad.`);
      }
    }
    const wasPlaying = this.state === State.PLAYING;
    this._resumeAfterBreak = wasPlaying;
    if (!wasPlaying) this.state = State.GENERATING;
    try {
      const req = buildBreakRequest({ stats, lyrics, bawdy: c.bawdy, breakDuration: c.breakDuration });
      const track = await this.generateTrack(req, Mode.BREAK);
      this.log.markBreak(Date.now());
      try { await this.persistLog?.(); } catch { /* persistence is best-effort */ }
      await this.postRecap({ title: template.title, lyrics: track?.lyrics || lyrics, summaryLines: template.summaryLines, journal: c.journalRecap });
      if (track) {
        this.next = null;
        await this.playTrack({ ...track, kind: Mode.BREAK });
      } else if (!wasPlaying) {
        this.state = State.STOPPED;
      }
    } catch (e) {
      if (!wasPlaying) this.state = State.STOPPED;
      this.failSoftly(e);
    }
    this.emit();
  }

  async postRecap({ title, lyrics, summaryLines, journal }) {
    const statsHtml = summaryLines.map((l) => `<li>${escapeHtml(l)}</li>`).join("");
    const html = `<div class="bardic-dice-card"><h4>♪ ${escapeHtml(title)}</h4><ul class="bd-stats">${statsHtml}</ul><p class="bd-lyrics">${escapeHtml(lyrics)}</p></div>`;
    try {
      await ChatMessage.create({ content: html, speaker: { alias: "Bardic Dice" }, flags: { [MODULE_ID]: { recap: true } } });
    } catch (e) { console.warn(`${MODULE_ID} | recap chat card failed`, e); }
    if (!journal) return;
    try {
      let entry = game.journal?.getName(JOURNAL_NAME) ?? game.journal?.find((j) => j.name === JOURNAL_NAME);
      if (!entry) entry = await JournalEntry.create({ name: JOURNAL_NAME });
      const pageName = `${new Date().toLocaleDateString()} — ${title}`;
      await entry.createEmbeddedDocuments("JournalEntryPage", [{
        name: pageName, type: "text",
        text: { content: html, format: 1 },
      }]);
    } catch (e) { console.warn(`${MODULE_ID} | recap journal failed`, e); }
  }
}
