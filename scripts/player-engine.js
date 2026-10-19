// Playback engine (GM client only): generates tracks with ACE-Step,
// uploads them to Foundry storage, and plays them through a dedicated
// Playlist so every player hears the same music with native sync/volume.
// Playback is a loop: long vocal roll-songs (stable chorus, fresh verses
// each lap) alternate with long instrumental bridges that pad the time
// while the next song composes and blend tempo across style changes.
// Mode changes (tavern <-> combat) land on track boundaries because
// ACE-Step renders whole files, never streams.
import { BRIDGE_CHECK_SEC, BRIDGE_MIN_SEC, CROSSFADE_MS, JOURNAL_NAME, Mode, MODULE_ID, PLAYLIST_NAME, SOCKET_CHANNEL, State } from "./constants.js";
import { AceStepClient } from "./ace-client.js";
import { buildBridgeRequest, buildTrackRequest } from "./prompt-engine.js";
import { aggregateBreakStats, buildBreakRequest, buildTemplateBallad, fetchSummarizerLyrics } from "./recap.js";

export function escapeHtml(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** The playback loop alternates kinds: vocal song -> bridge -> vocal ... */
export function nextKindToGenerate(lastKind) {
  return lastKind === "vocal" ? "bridge" : "vocal";
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
    this.current = null; // {soundId,title,why,duration,kind,bridge,startedAt,lyrics}
    this.queue = []; // upcoming tracks, alternating vocal/bridge
    this.loopIndex = 0; // verse-rotation counter for vocal loops
    this.recentVerses = []; // verse lines already sung (never repeated next lap)
    this._lastQueuedKind = null; // "vocal" | "bridge"
    this._prevMode = null; // mode before last switch (bridge tempo blend)
    this._filling = false;
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
      nowPlaying: this.current?.title ?? "—", nextTrack: this.queue[0]?.title ?? (this.generating ? "composing…" : "—"),
      why: this.lastWhy, healthOk: this.healthOk,
      loopIndex: this.loopIndex, bridge: Boolean(this.current?.bridge), queued: this.queue.length,
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
  async generateTrack(req, kind, { bridge = false } = {}) {
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
        name: req.title, path, volume: c.volume, repeat: false, fade: CROSSFADE_MS,
        flags: { [MODULE_ID]: { why: req.why ?? "", lyrics: out.lyrics ?? req.lyrics ?? "", bridge } },
      }]);
      await this.pruneOldSounds(pl);
      if (!bridge && req.verseLines?.length) {
        this.recentVerses = [...this.recentVerses, ...req.verseLines].slice(-12);
        this.loopIndex += 1;
      }
      return { soundId: sound.id, title: req.title, why: req.why ?? "", duration: req.duration, kind, bridge, lyrics: out.lyrics ?? req.lyrics ?? "" };
    } finally {
      this.generating = false;
      this.emit();
    }
  }

  async pruneOldSounds(pl) {
    try {
      const keep = new Set([this.current?.soundId, ...this.queue.map((t) => t.soundId)].filter(Boolean));
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
      wounds: this.log.museWounds?.(now) ?? [], corruptions: this.log.museCorruption?.(now) ?? [],
      bawdy: c.bawdy, tavernDuration: c.tavernDuration, combatDuration: c.combatDuration,
      loopIndex: this.loopIndex, recentVerses: this.recentVerses,
    });
  }

  buildBridgeReq(mode) {
    const c = this.getConfig();
    const now = Date.now();
    return buildBridgeRequest({
      mode, fromMode: this._prevMode,
      rolls: this.log.museRolls(now), chats: this.log.museChat(now),
      wounds: this.log.museWounds?.(now) ?? [], corruptions: this.log.museCorruption?.(now) ?? [],
      bridgeDuration: c.bridgeDuration,
    });
  }

  /**
   * Immediate sad discordant sting (bundled asset, broadcast to all clients)
   * when a player gains Corruption. Cooldown-guarded so multi-point updates
   * do not machine-gun. @returns {Promise<boolean>} true if a sting played.
   */
  async playCorruptionSting(actorName = "") {
    const now = Date.now();
    if (this._lastStingAt && now - this._lastStingAt < 4000) return false;
    const c = this.getConfig();
    if (c.corruptionSting === false) return false;
    this._lastStingAt = now;
    const src = `modules/${MODULE_ID}/assets/corruption-sting.wav`;
    const volume = Math.min(1, (c.volume ?? 0.6) * 1.1);
    try {
      const helper = globalThis.AudioHelper ?? globalThis.foundry?.audio?.AudioHelper;
      if (helper?.play) { await helper.play({ src, volume, loop: false }, true); return true; }
      const Sound = globalThis.foundry?.audio?.Sound;
      if (Sound) { const s = new Sound(src); await s.load(); await s.play({ volume }); return true; }
    } catch (e) { console.warn(`${MODULE_ID} | corruption sting failed for ${actorName}`, e); }
    return false;
  }

  async playTrack(track) {
    const pl = await this.ensurePlaylist();
    const sound = pl.sounds?.get(track.soundId);
    if (!sound) throw new Error("PlaylistSound vanished before playback");
    const prev = this.current && this.current.soundId !== track.soundId ? pl.sounds?.get(this.current.soundId) : null;
    await pl.playSound(sound);
    // Crossfade: the incoming sound fades in (its `fade`), then the outgoing
    // one is stopped and fades out under it instead of cutting dead.
    if (prev?.playing) {
      try { await prev.update({ playing: false, pausedTime: 0 }); } catch { /* already stopped */ }
    }
    this.current = { ...track, startedAt: Date.now() };
    this.queue = this.queue.filter((t) => t.soundId !== track.soundId);
    this.state = State.PLAYING;
    this.lastWhy = track.why ?? this.lastWhy;
    this.scheduleTimers(track.duration);
    this.emit();
  }

  /** Replay the current sound from the top (loop-hold while composing). */
  async restartCurrent() {
    const pl = await this.ensurePlaylist();
    const sound = this.current ? pl.sounds?.get(this.current.soundId) : null;
    if (!sound) return false;
    try { await sound.update({ playing: false, pausedTime: 0 }); } catch { /* not playing */ }
    await pl.playSound(sound);
    this.current.startedAt = Date.now();
    return true;
  }

  elapsedSec() {
    return this.current?.startedAt ? (Date.now() - this.current.startedAt) / 1000 : 0;
  }

  scheduleTimers(durationSec, elapsedSec = 0) {
    this.clearTimers();
    const remain = Math.max(5, durationSec - elapsedSec);
    // Compose ahead immediately: long tracks take a while to render, and
    // the bridge/vocal queue should already be filling while this plays.
    this._prefetchTimer = setTimeout(() => { void this.ensureNext().catch((e) => this.failSoftly(e)); }, 5000);
    // Vocal songs hand over early enough to crossfade; bridges yield to the
    // next vocal once their minimum dwell has passed (advance() decides).
    const advanceIn = this.current?.bridge
      ? Math.min(remain, BRIDGE_MIN_SEC) * 1000
      : Math.max(10, remain - CROSSFADE_MS / 1000) * 1000;
    this._advanceTimer = setTimeout(() => { void this.advance().catch((e) => this.failSoftly(e)); }, advanceIn);
  }

  scheduleAdvanceCheck(sec = BRIDGE_CHECK_SEC) {
    if (this._advanceTimer) clearTimeout(this._advanceTimer);
    this._advanceTimer = setTimeout(() => { void this.advance().catch((e) => this.failSoftly(e)); }, sec * 1000);
  }

  clearTimers() {
    if (this._prefetchTimer) clearTimeout(this._prefetchTimer);
    if (this._advanceTimer) clearTimeout(this._advanceTimer);
    this._prefetchTimer = this._advanceTimer = null;
  }

  /** Keep the vocal/bridge queue topped up (called early in each track). */
  async ensureNext() {
    if (this.state !== State.PLAYING || this._filling) return;
    if (this.current?.kind === Mode.BREAK && !this._resumeAfterBreak) return;
    this._filling = true;
    try {
      while (this.state === State.PLAYING && this.queue.length < 2 && !this.generating) {
        const last = this.queue.at(-1);
        const kind = nextKindToGenerate(last ? (last.bridge ? "bridge" : "vocal") : (this._lastQueuedKind ?? (this.current?.bridge ? "bridge" : "vocal")));
        const track = kind === "bridge"
          ? await this.generateTrack(this.buildBridgeReq(this.mode), this.mode, { bridge: true })
          : await this.generateTrack(this.buildNextRequest(this.mode), this.mode);
        if (!track || this.state !== State.PLAYING) break;
        this._lastQueuedKind = kind;
        this.queue.push(track);
        this._prevMode = null; // transition blend applies to the first bridge only
        this.emit();
      }
    } finally {
      this._filling = false;
    }
  }

  async advance() {
    if (this.state !== State.PLAYING) return;
    if (this.current?.kind === Mode.BREAK && !this._resumeAfterBreak) {
      this.state = State.STOPPED;
      this.current = null;
      this.emit();
      return;
    }
    if (this.current?.bridge) {
      // Bridges loop as padding: yield to a queued vocal song once the
      // minimum dwell passed; otherwise keep (re)playing and re-check.
      const vocalIdx = this.queue.findIndex((t) => !t.bridge);
      if (vocalIdx >= 0 && this.elapsedSec() >= BRIDGE_MIN_SEC) {
        await this.playTrack(this.queue[vocalIdx]);
        return;
      }
      if (this.elapsedSec() >= (this.current.duration ?? 0)) await this.restartCurrent();
      void this.ensureNext().catch((e) => this.failSoftly(e));
      this.scheduleAdvanceCheck();
      return;
    }
    if (this.queue.length) { await this.playTrack(this.queue[0]); return; }
    if (this.generating || this._filling) {
      // Next song is still composing: loop the current one seamlessly
      // instead of going silent, then keep checking for the new track.
      await this.restartCurrent();
      this.scheduleAdvanceCheck();
      return;
    }
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
    this.loopIndex = 0;
    this.recentVerses = [];
    this._lastQueuedKind = null;
    this._prevMode = null;
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
      const queuedVocal = this.queue.find((t) => !t.bridge);
      if (queuedVocal) { await this.playTrack(queuedVocal); return; }
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
    this.queue = [];
    try { await (await this.ensurePlaylist()).stopAll(); } catch { /* already silent */ }
    this.emit();
  }

  /** Called by combat hooks. The new tempo starts with the next track. */
  async setMode(mode) {
    if (mode === this.mode) return;
    this._prevMode = this.mode;
    this.mode = mode;
    // Queued old-style tracks must not play over the new style; an
    // instrumental bridge in the new style carries the transition instead.
    this.queue = [];
    this._lastQueuedKind = "vocal";
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
        this.queue = [];
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
