// Playback engine (GM client only): generates tracks with ACE-Step,
// uploads them to Foundry storage, and plays them through a dedicated
// Playlist so every player hears the same music with native sync/volume.
// Playback is a loop: long vocal roll-songs (stable chorus, fresh verses
// each lap) alternate with long instrumental bridges that pad the time
// while the next song composes and blend tempo across style changes.
// Mode changes (tavern <-> combat) land on track boundaries because
// ACE-Step renders whole files, never streams.
import { BRIDGE_CHECK_SEC, BRIDGE_MIN_SEC, COMBAT_BRIDGE_CAP_SEC, COMBAT_DURATION_CAP_SEC, CROSSFADE_MS, EXPEDITE_COOLDOWN_MS, JOURNAL_NAME, MODE_SWITCH_SEC, Mode, MODULE_ID, MUSE_SWITCH_SEC, PLAYLIST_NAME, QUEUE_AHEAD, SOCKET_CHANNEL, State, URGENT_POLISH_WINDOW_MS } from "./constants.js";
import { AceStepClient } from "./ace-client.js";
import { buildBridgeRequest, buildDirgeRequest, buildTrackRequest, pickMusicalVariety } from "./prompt-engine.js";
import { careerFromActor, mergeBardRequests } from "./session-log.js";
import { StoryTracker, buildJokePrompt, buildLyricPrompt, ensureCritCallout, fetchSmallLlmText, fitLyricsToLoop, rollFactsForPrompt, sanitizeLlmJoke, sanitizeLlmLyrics } from "./llm-writer.js";
import { fetchParodySong } from "./parody.js";
import { aggregateBreakStats, buildBreakRequest, buildTemplateBallad, fetchSummarizerLyrics } from "./recap.js";

export function escapeHtml(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** The playback loop alternates kinds: vocal song -> bridge -> vocal ... */
export function nextKindToGenerate(lastKind) {
  return lastKind === "vocal" ? "bridge" : "vocal";
}

/** Shuffle-without-replacement rotation for pregenerated library tracks. */
export class ShuffleBag {
  constructor(items = [], rng = Math.random) {
    this.items = [...items];
    this.rng = rng;
    this.bag = [];
    this.last = null;
  }
  refill() {
    this.bag = [...this.items];
    for (let i = this.bag.length - 1; i > 0; i--) {
      const j = Math.floor(this.rng() * (i + 1));
      [this.bag[i], this.bag[j]] = [this.bag[j], this.bag[i]];
    }
    if (this.bag.length > 1 && this.bag.at(-1) === this.last) {
      [this.bag[0], this.bag[this.bag.length - 1]] = [this.bag[this.bag.length - 1], this.bag[0]];
    }
  }
  next() {
    if (!this.items.length) return null;
    if (!this.bag.length) this.refill();
    const value = this.bag.pop();
    this.last = value;
    return value;
  }
}

export function trackFilename(mode, seq, date = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  const stamp = `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
  return `bardic-${stamp}-${seq}-${String(mode).replace(/[^a-z0-9-]/gi, "")}.mp3`;
}

export class BardicPlayer {
  constructor({ sessionLog, getConfig, onStateChange = null, persistLog = null, storyTracker = null } = {}) {
    this.log = sessionLog;
    this.story = storyTracker ?? new StoryTracker();
    this.getConfig = getConfig;
    this.onStateChange = onStateChange;
    this.persistLog = persistLog;
    this.state = State.STOPPED;
    this.mode = Mode.TAVERN;
    this.current = null; // {soundId,title,why,duration,kind,bridge,startedAt,lyrics}
    this.queue = []; // upcoming tracks, alternating vocal/bridge
    this.loopIndex = 0; // verse-rotation counter for vocal loops
    this.bridgeIndex = 0; // interlude counter (every third gets a joke)
    this.recentVerses = []; // verse lines already sung (never repeated next lap)
    this._lastQueuedKind = null; // "vocal" | "bridge"
    this._prevMode = null; // mode before last switch (bridge tempo blend)
    this._library = null; // pregenerated bridge entries (null = not loaded)
    this._libraryBag = null;
    this._requestCursor = 0; // ts of last consumed player request
    this._filling = false;
    this.generating = false;
    this.generation = 0; // bump to cancel in-flight work on Stop
    this.trackSeq = 0;
    this.healthOk = null;
    this._lastSongIndex = null; // last vocal song heard (bard alternation)
    this._assignedSongIndex = null; // last vocal song composed/queued
    this._varietySeedBase = Math.floor(Math.random() * 1_000_000_000); // per-session style shuffle
    this._recentJokes = [];
    this._smallLlmCooldownUntil = 0;
    this._pendingDirges = []; // deaths waiting while a dirge composes/plays
    this._dirgeBusy = false;
    this._resumeAfterDirge = false;
    this.lastWhy = "";
    this._prefetchTimer = null;
    this._advanceTimer = null;
    this._queueEpoch = 0; // bumped when queued/in-flight tracks go stale
    this._expediteCooldownUntil = 0;
    this._parodyCooldownUntil = 0;
    this._urgentUntil = 0; // LLM polish is skipped while an urgent switch is fresh
    this._aceAbort = null; // AbortController for the in-flight ACE poll
    this.activity = []; // recent bard / lyric-LLM / memory actions for the HUD
    this.workLog = []; // fuller lyric-bot working notes for the sidebar
  }

  /** Record what the bard, lyric LLM or memory is doing right now (HUD + status). */
  noteActivity(actor, text) {
    this.activity = [...this.activity.slice(-5), { ts: Date.now(), actor, text: String(text ?? "").slice(0, 140) }];
  }

  /** Show-your-work entry for the sidebar: step title plus the evidence behind it. */
  noteWork(actor, text, detail = "") {
    this.workLog = [...this.workLog.slice(-11), { ts: Date.now(), actor, text: String(text ?? "").slice(0, 140), detail: String(detail ?? "").slice(0, 400) }];
    this.noteActivity(actor, text);
  }

  /** Drop every queued track; in-flight compositions for the old queue are discarded on arrival. */
  invalidateQueue() {
    this._queueEpoch += 1;
    this.queue = [];
    this._assignedSongIndex = this._lastSongIndex;
    // Stop polling ACE for the stale render so the GPU queue drains to the
    // track that matters (the server may finish the orphan; we stop waiting).
    try { this._aceAbort?.abort(); } catch { /* already settled */ }
    this._aceAbort = null;
  }

  /** Mark the next moments urgent: the lyric writers stand down for the switch. */
  markUrgent() {
    this._urgentUntil = Date.now() + URGENT_POLISH_WINDOW_MS;
  }

  /** Make the current track yield within `withinSec` once a successor is queued. */
  expediteCurrent(withinSec = MODE_SWITCH_SEC) {
    if (this.state !== State.PLAYING || !this.current) return;
    if (this.current.bridge) {
      this.current.minDwellSec = Math.min(this.current.minDwellSec ?? BRIDGE_MIN_SEC, withinSec);
    }
    this.scheduleAdvanceCheck(withinSec);
  }

  ace() {
    const c = this.getConfig();
    return new AceStepClient({ baseUrl: c.aceBaseUrl, apiKey: c.aceApiKey });
  }

  status() {
    const elapsed = this.elapsedSec();
    return {
      state: this.state, mode: this.mode, generating: this.generating,
      nowPlaying: this.current?.title ?? "—", nextTrack: this.queue[0]?.title ?? (this.generating ? "composing…" : "—"),
      nextKind: this.queue[0] ? (this.queue[0].bridge ? "bridge" : "song") : null,
      why: this.lastWhy, healthOk: this.healthOk,
      loopIndex: this.loopIndex, bridge: Boolean(this.current?.bridge), queued: this.queue.length,
      bard: this.current?.bard?.label ?? null,
      startedAt: this.current?.startedAt ?? null,
      duration: this.current?.duration ?? null,
      remainSec: this.current?.duration ? Math.max(0, Math.round(this.current.duration - elapsed)) : null,
      activity: [...this.activity],
      work: [...this.workLog],
    };
  }

  /** Party (PCs + careers) and current enemies (hostile combatants) for song fitting. */
  partyContext() {
    const party = [];
    const enemies = [];
    try {
      for (const a of game.actors ?? []) {
        if (a?.type === "character") party.push({ name: a.name, career: careerFromActor(a) });
      }
    } catch { /* no actors in tests */ }
    try {
      for (const c of game.combat?.combatants ?? []) {
        const a = c?.actor;
        if (!a) continue;
        const disp = c.token?.disposition ?? a.token?.disposition;
        if (disp != null && disp >= 0) continue; // friendly/neutral: not the enemy
        enemies.push({ name: a.name, type: a.type ?? null });
      }
    } catch { /* no combat in tests */ }
    return { party: party.slice(0, 8), enemies: enemies.slice(0, 8) };
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

  /** Parody-sidecar lyrics for a vocal song, screened into the loop blocks. Null on any failure. */
  async parodyLyrics(req, kind, c) {
    if (kind === Mode.DIRGE || kind === Mode.BREAK || !c.parodyEnabled || !c.parodyBaseUrl) return null;
    if (Date.now() < this._parodyCooldownUntil) return null;
    if (Date.now() < this._urgentUntil) { this.noteWork("parody", "standing down for the urgent switch — GPU reserved for the bard", "Parody hunting resumes on the next song."); return null; }
    try {
      const facts = rollFactsForPrompt(req.features ?? {}, req.careers ?? null);
      this.storySummary(req.careers);
      const { party, enemies } = this.partyContext();
      this.noteWork("parody", `hunting a skeleton fitting ${party.map((p) => p.name).join(", ") || "the party"}${enemies.length ? ` vs ${enemies.map((p) => p.name).join(", ")}` : ""}…`,
        `Party: ${party.map((p) => `${p.name}${p.career ? ` the ${p.career}` : ""}`).join("; ") || "—"} · Enemy: ${enemies.map((p) => p.name).join("; ") || "—"} · Dice facts: ${facts.join(" | ") || "quiet table"} · Saga lines fed: ${this.story.contextLines().length}`);
      const par = await fetchParodySong({
        baseUrl: c.parodyBaseUrl,
        payload: {
          facts, storyLines: this.story.contextLines(), bardLabel: req.bard?.label ?? "", bawdy: c.bawdy,
          styleId: req.variety?.styleId ?? "", keyScale: req.keyScale ?? "",
          loopSections: req.loopSections ?? [], loopHook: req.loopHook ?? "",
          party, enemies, mode: kind,
        },
      });
      const fitted = fitLyricsToLoop(par.lyrics, req.lyrics, { loopHook: req.loopHook ?? "" });
      const lyrics = (req.features?.crits ?? 0) > 0 || (req.features?.critDetails?.length ?? 0) > 0 ? ensureCritCallout(fitted, req.lyrics) : fitted;
      if (lyrics === req.lyrics) { this.noteWork("parody", "draft had too little usable text — template words stand", `Blocks required: ${(req.loopSections ?? []).join(" → ") || "—"} · Hook kept word-for-word: ${req.loopHook ?? "—"}`); return null; }
      this.noteWork("parody", `${par.fit ?? "skeleton picked"} (track #${par.source?.trackId ?? "?"}) — bards will sing it`,
        `Skeleton source track #${par.source?.trackId ?? "?"} · Screened against source (no shared line / 5-word run) · Fitted into ${(req.loopSections ?? []).join(" → ") || "the loop blocks"} · Bard: ${req.bard?.label ?? "—"}`);
      return { ...req, lyrics, llmWritten: true, parodySource: par.source ?? null, parodyFit: par.fit ?? null, why: `${req.why ?? ""}; LRCLIB parody${par.fit ? ` — ${par.fit}` : ""} (skeleton #${par.source?.trackId ?? "?"})` };
    } catch (e) {
      this._parodyCooldownUntil = Date.now() + 5 * 60 * 1000;
      this.noteWork("parody", "writer unreachable — normal writers take this song (5 min cooldown)", `Endpoint: ${c.parodyBaseUrl}`);
      console.warn(`${MODULE_ID} | parody writer unavailable, using normal writers (5 min cooldown)`, e);
      return null;
    }
  }

  /** Fresh-ify lyrics/jokes with the tiny LLM; any failure keeps template words. */
  async polishWithSmallLlm(req, kind, { bridge = false } = {}) {
    try {
      const c = this.getConfig();
      if (!bridge) {
        const parody = await this.parodyLyrics(req, kind, c);
        if (parody) return parody;
      }
      if (c.smallLlmEnabled === false || !c.smallLlmBaseUrl || !c.smallLlmModel) return req;
      if (Date.now() < this._smallLlmCooldownUntil) return req;
      const facts = rollFactsForPrompt(req.features ?? {}, req.careers ?? null);
      this.storySummary(req.careers); const storyLines = this.story.contextLines();
      const call = (prompt, maxTokens) => fetchSmallLlmText({
        baseUrl: c.smallLlmBaseUrl, apiKey: c.smallLlmApiKey, model: c.smallLlmModel,
        prompt, maxTokens, timeoutMs: 12000,
      });
      if (bridge) {
        if (!req.joke) return req;
        this.noteWork("lyric-llm", "writing a bridge joke", `Facts: ${facts.join(" | ") || "quiet table"} · Recent jokes avoided: ${this._recentJokes.length} · Saga: ${storyLines.slice(0, 2).join(" | ") || "—"}`);
        const joke = sanitizeLlmJoke(await call(buildJokePrompt({ facts, storyLines, recentJokes: this._recentJokes, bardLabel: req.bard?.label ?? "" }), 90), req.joke, { recentJokes: this._recentJokes });
        this.noteWork("lyric-llm", joke === req.joke ? "joke draft rejected — template joke stands" : "fresh bridge joke written", joke === req.joke ? "Repeated, too long, or linked draft refused by the screen." : joke);
        return joke === req.joke ? req : { ...req, joke, lyrics: String(req.lyrics).replace(req.joke, joke), why: `${req.why ?? ""}; small-LLM fresh joke` };
      }
      this.noteWork("lyric-llm", `writing fresh verses for ${req.bard?.label ?? "the bard"}`, `Facts: ${facts.join(" | ") || "quiet table"} · Saga: ${storyLines.slice(0, 3).join(" | ") || "—"} · Recent lines avoided: ${this.recentVerses.length} · Blocks: ${(req.loopSections ?? []).join(" → ") || "—"}`);
      const mustMention = kind === Mode.DIRGE ? (req.features?.deaths?.[0]?.actor ?? null) : null;
      const raw = await call(buildLyricPrompt({
        fallbackLyrics: req.lyrics, kind: kind === Mode.DIRGE ? "dirge" : "song",
        styleId: req.variety?.styleId ?? "", keyScale: req.keyScale, progression: req.variety?.progressionLabel ?? "",
        bardLabel: req.bard?.label ?? "", facts, storyLines, recentLines: this.recentVerses, recentJokes: this._recentJokes, bawdy: c.bawdy,
        loopSections: req.loopSections ?? [], loopHook: req.loopHook ?? "",
      }), 650);
      const screened = sanitizeLlmLyrics(raw, req.lyrics, { mustMention });
      const fitted = mustMention && !String(raw).includes(mustMention) ? req.lyrics : fitLyricsToLoop(screened === req.lyrics ? raw : screened, req.lyrics, { loopHook: req.loopHook ?? "" });
      const hasCrit = (req.features?.crits ?? 0) > 0 || (req.features?.critDetails?.length ?? 0) > 0;
      const lyrics = hasCrit ? ensureCritCallout(fitted, req.lyrics) : fitted;
      if (lyrics === req.lyrics) this.noteWork("lyric-llm", "draft had too little usable text — template verses stand", "Drafts are repaired into the loop blocks; only near-empty or linked drafts are refused outright.");
      else this.noteWork("lyric-llm", `fresh verses written, answering the bard's ${req.title ?? "song"} (${facts.length ? facts[0].slice(0, 60) : "quiet table"})${hasCrit ? " — Critical called out" : ""}`, `First sung line: ${lyrics.split("\n").find((l) => l.trim() && !l.startsWith("[")) ?? "—"}`);
      return lyrics === req.lyrics ? req : { ...req, lyrics, llmWritten: true, why: `${req.why ?? ""}; small-LLM fresh lyrics` };
    } catch (e) {
      this._smallLlmCooldownUntil = Date.now() + 5 * 60 * 1000;
      this.noteWork("lyric-llm", "unreachable — template verses (5 min cooldown)", "Writer endpoint unreachable; template words stand.");
      console.warn(`${MODULE_ID} | small LLM unavailable, using template words (5 min cooldown)`, e);
      return req;
    }
  }

  /** Generate + upload + register one track (does not start playback). */
  async generateTrack(req, kind, { bridge = false, smallLlm = true } = {}) {
    const c = this.getConfig();
    const token = this.generation;
    this.generating = true;
    this.lastWhy = req.why ?? "";
    this.noteWork("bard", `composing ${bridge ? "a bridge" : "a song"} — ${req.title ?? kind} (${kind}, ${req.bpm ?? "?"} BPM${req.keyScale ? `, ${req.keyScale}` : ""})`, req.why ?? "");
    this.emit();
    if (smallLlm) req = await this.polishWithSmallLlm(req, kind, { bridge });
    const aceStarted = Date.now();
    this._aceAbort = typeof AbortController !== "undefined" ? new AbortController() : null;
    try {
      ui.notifications?.info(`♪ ${game.i18n?.localize("BARDICDICE.Generating") ?? "Bard is composing…"}`);
      let out;
      try {
        out = await this.ace().generate({
        prompt: req.prompt, lyrics: req.lyrics, bpm: req.bpm, keyScale: req.keyScale,
        timeSignature: req.timeSignature, duration: req.duration,
        model: c.aceModel, inferenceSteps: c.inferenceSteps, thinking: c.thinking,
        vocalLanguage: c.vocalLanguage, useFormat: true,
        ...(Number.isFinite(Number(req.aceSeed ?? req.varietySeed)) ? { seed: Math.abs(Math.trunc(Number(req.aceSeed ?? req.varietySeed))) % 2147483647 } : {}),
        }, { signal: this._aceAbort?.signal ?? null });
      } catch (e) {
        if (this._aceAbort?.signal.aborted) return null; // superseded: switch/stop already moved on
        throw e;
      }
      const aceSec = Math.round((Date.now() - aceStarted) / 1000);
      if (aceSec >= 45) this.noteWork("bard", `ACE-Step took ${aceSec}s for ${req.title ?? "that track"} — GPU is the bottleneck`, "Queue depth is 1 and combat renders are capped; lower track durations in settings if this persists.");
      if (this._aceAbort?.signal.aborted) return null; // superseded while rendering
      if (token !== this.generation) return null; // stopped while composing
      const path = await this.uploadBlob(out.blob, trackFilename(kind, ++this.trackSeq));
      if (token !== this.generation) return null;
      const pl = await this.ensurePlaylist();
      const [sound] = await pl.createEmbeddedDocuments("PlaylistSound", [{
        name: req.title, path, volume: c.volume, repeat: false, fade: CROSSFADE_MS,
        flags: { [MODULE_ID]: { why: req.why ?? "", lyrics: out.lyrics ?? req.lyrics ?? "", bridge } },
      }]);
      await this.pruneOldSounds(pl);
      if (!bridge) {
        const sung = String(out.lyrics ?? req.lyrics ?? "").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("["));
        if (req.verseLines?.length) this.loopIndex += 1;
        this.recentVerses = [...this.recentVerses, ...(sung.length ? sung : (req.verseLines ?? []))].slice(-24);
      }
      if (bridge && req.joke) this._recentJokes = [...this._recentJokes, req.joke].slice(-32);
      return { soundId: sound.id, title: req.title, why: req.why ?? "", duration: req.duration, kind, bridge, minDwellSec: req.minDwellSec ?? null, lyrics: out.lyrics ?? req.lyrics ?? "", songIndex: req.songIndex ?? null, bard: req.bard ?? null, joke: req.joke ?? null, variety: req.variety ?? null, loopForm: req.loopForm ?? null, loopSections: req.loopSections ?? null, loopHook: req.loopHook ?? null, parodySource: req.parodySource ?? null };
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

  /** Merged player requests not yet consumed by a vocal song (peek, no consume). */
  pendingRequestMerge() {
    const events = this.log.pendingRequests?.(this._requestCursor) ?? [];
    return { events, merged: mergeBardRequests(events) };
  }

  /** Next alternating-bard index along the actual playback chain. */
  nextSongIndex({ ignoreQueue = false } = {}) {
    const known = [this._lastSongIndex];
    if (!ignoreQueue) {
      known.push(this._assignedSongIndex);
      for (const t of this.queue) if (!t.bridge) known.push(t.songIndex);
    }
    const nums = known.filter((n) => Number.isFinite(n));
    return nums.length ? Math.max(...nums) + 1 : 0;
  }

  reserveSongIndex(opts) {
    const index = this.nextSongIndex(opts);
    this._assignedSongIndex = index;
    return index;
  }

  /** Refresh (dedupe-ingest the log) and return all-time stats for the bards. */
  storySummary(extraCareers = null) {
    try {
      this.story.ingest(this.log?.events ?? [], { ...this.careerMap(), ...(extraCareers ?? {}) });
      const s = this.story.summaryForBards();
      if (s.totals.rolls || s.totals.deaths || s.totals.wounds) {
        const text = `saga memory: ${s.totals.rolls} rolls, ${s.totals.crits} crits, ${s.totals.fumbles} fumbles, ${s.totals.deaths} deaths all-time`;
        if (this.activity.at(-1)?.text !== text) {
          const legends = [s.topCritter ? `legend ${s.topCritter.label} (${s.topCritter.crits} crits)` : "", s.topFumbler ? `butt ${s.topFumbler.label} (${s.topFumbler.fumbles} fumbles)` : "", s.fallen?.length ? `fallen: ${s.fallen.join(", ")}` : ""].filter(Boolean).join(" · ");
          this.noteWork("memory", text, legends || "No legends yet — the saga is young.");
        }
        return s;
      }
      return null;
    } catch { return null; }
  }

  careerMap() {
    const map = {};
    try { for (const a of game.actors ?? []) { const c = careerFromActor(a); if (c) map[a.name] = c; } } catch { /* tests / no actors */ }
    return map;
  }

  buildNextRequest(mode) {
    const c = this.getConfig();
    const now = Date.now();
    const { events, merged } = this.pendingRequestMerge();
    if (events.length) this._requestCursor = events.at(-1).ts;
    return buildTrackRequest({
      mode, rolls: this.log.museRolls(now), chats: this.log.museChat(now),
      wounds: this.log.museWounds?.(now) ?? [], corruptions: this.log.museCorruption?.(now) ?? [],
      deaths: this.log.museDeaths?.(now) ?? [],
      bawdy: c.bawdy, tavernDuration: c.tavernDuration, combatDuration: Math.min(c.combatDuration ?? 180, COMBAT_DURATION_CAP_SEC),
      loopIndex: this.loopIndex, songIndex: this.reserveSongIndex(), careers: this.careerMap(),
      varietySeed: this._varietySeedBase, story: this.storySummary(), recentVerses: this.recentVerses,
      requests: merged && !merged.empty ? merged : null,
    });
  }

  /** Load pregenerated plucky interludes (manifest first, folder listing as fallback). */
  async loadLibrary() {
    if (this._library) return this._library;
    const dir = `${this.getConfig().uploadFolder || "bardic-dice"}/library`;
    let entries = [];
    try {
      const res = await fetch(`${dir}/manifest.json`);
      if (res.ok) {
        const manifest = await res.json();
        entries = (manifest.tracks ?? []).filter((t) => t.file).map((t) => ({
          path: t.file.startsWith(dir) ? t.file : `${dir}/${t.file}`,
          duration: Number(t.duration) || this.getConfig().bridgeDuration,
          flavor: t.flavor ?? "strum", title: t.title ?? "Plucky Interlude",
        }));
      }
    } catch { /* no manifest yet */ }
    if (!entries.length) {
      try {
        const listing = await FilePicker.browse("data", dir);
        entries = (listing.files ?? []).filter((f) => /\.mp3$/i.test(f)).map((path) => ({
          path, duration: this.getConfig().bridgeDuration, flavor: "strum", title: "Plucky Interlude",
        }));
      } catch { /* no library folder yet */ }
    }
    this._library = entries;
    this._libraryBag = new ShuffleBag(entries);
    return entries;
  }

  /** Next pregenerated plucky interlude as a playlist track, or null. */
  async libraryBridgeTrack() {
    const c = this.getConfig();
    if (c.bridgeLibrary === false) return null;
    const entries = await this.loadLibrary();
    const entry = entries.length ? this._libraryBag.next() : null;
    if (!entry) return null;
    const pl = await this.ensurePlaylist();
    const [sound] = await pl.createEmbeddedDocuments("PlaylistSound", [{
      name: entry.title, path: entry.path, volume: c.volume, repeat: false, fade: CROSSFADE_MS,
      flags: { [MODULE_ID]: { why: `pregenerated ${entry.flavor} interlude`, lyrics: "[Instrumental]", bridge: true, library: true } },
    }]);
    await this.pruneOldSounds(pl);
    return {
      soundId: sound.id, title: entry.title, duration: entry.duration, kind: this.mode, bridge: true,
      minDwellSec: 90, lyrics: "[Instrumental]",
      why: `pregenerated ${entry.flavor} interlude (${entry.duration}s, library)`,
    };
  }

  buildBridgeReq(mode) {
    const c = this.getConfig();
    const now = Date.now();
    // Pair the bridge with the next vocal loop: same style template, key,
    // hook and chord cycle, so the interlude pre-hears the coming song.
    const pairVariety = pickMusicalVariety({ mode, songIndex: this.nextSongIndex(), seed: this._varietySeedBase });
    return buildBridgeRequest({
      mode, fromMode: this._prevMode,
      rolls: this.log.museRolls(now), chats: this.log.museChat(now),
      wounds: this.log.museWounds?.(now) ?? [], corruptions: this.log.museCorruption?.(now) ?? [],
      bridgeDuration: mode === Mode.COMBAT ? Math.min(c.bridgeDuration ?? 360, COMBAT_BRIDGE_CAP_SEC) : c.bridgeDuration, bridgeIndex: this.bridgeIndex,
      deaths: this.log.museDeaths?.(now) ?? [],
      varietySeed: this._varietySeedBase, recentJokes: this._recentJokes, careers: this.careerMap(),
      flavor: this.pendingRequestMerge().merged?.flavor ?? ["strum", "drum", "mixed"][this.bridgeIndex % 3],
      requests: this.pendingRequestMerge().merged,
      pairVariety,
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
    this.noteActivity("bard", `${track.bridge ? "bridging with" : "singing"} ${track.title}${track.bard?.label ? ` — ${track.bard.label}` : ""}`);
    if (!track.bridge && Number.isFinite(track.songIndex)) this._lastSongIndex = track.songIndex;
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
      ? Math.min(remain, this.current.minDwellSec ?? BRIDGE_MIN_SEC) * 1000
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
    if (this.state !== State.PLAYING || this._filling || this._dirgeBusy) return;
    if (this.current?.kind === Mode.BREAK && !this._resumeAfterBreak) return;
    if (this.current?.kind === Mode.DIRGE && !this._resumeAfterDirge) return;
    if (this._pendingDirges.length && this.current?.kind !== Mode.DIRGE) return;
    this._filling = true;
    try {
      while (this.state === State.PLAYING && this.queue.length < QUEUE_AHEAD && !this.generating) {
        const epoch = this._queueEpoch;
        const last = this.queue.at(-1);
        const kind = nextKindToGenerate(last ? (last.bridge ? "bridge" : "vocal") : (this._lastQueuedKind ?? (this.current?.bridge ? "bridge" : "vocal")));
        let track = null;
        if (kind === "bridge") {
          const jokeLap = this.mode !== Mode.COMBAT && this.bridgeIndex % 3 === 2;
          const wantsInstrumental = this.pendingRequestMerge().merged?.instrumental === true;
          if (this.mode !== Mode.COMBAT && !jokeLap && !wantsInstrumental) {
            try { track = await this.libraryBridgeTrack(); } catch { track = null; }
          }
          if (!track) track = await this.generateTrack(this.buildBridgeReq(this.mode), this.mode, { bridge: true });
        } else {
          track = await this.generateTrack(this.buildNextRequest(this.mode), this.mode);
        }
        if (epoch !== this._queueEpoch) continue; // composed for a stale mode/event: discard, refill fresh
        if (!track || this.state !== State.PLAYING) break;
        this._lastQueuedKind = kind;
        if (kind === "bridge") this.bridgeIndex += 1;
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
    if (this.current?.kind === Mode.DIRGE) {
      // Sing every fallen hero out before resuming the set.
      const nextDirge = this._pendingDirges.shift();
      if (nextDirge) { await this.playDirge(nextDirge, { resumeAfter: this._resumeAfterDirge }); return; }
      if (!this._resumeAfterDirge) {
        this.state = State.STOPPED;
        this.current = null;
        this.emit();
        return;
      }
      this._resumeAfterDirge = false; // fall through: resume tavern/combat
    } else if (this._pendingDirges.length && !this._dirgeBusy) {
      await this.playDirge(this._pendingDirges.shift());
      return;
    }
    if (this.current?.bridge) {
      // Bridges loop as padding: yield to a queued vocal song once the
      // minimum dwell passed; otherwise keep (re)playing and re-check.
      const vocalIdx = this.queue.findIndex((t) => !t.bridge);
      if (vocalIdx >= 0 && this.elapsedSec() >= (this.current.minDwellSec ?? BRIDGE_MIN_SEC)) {
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
      // An expedited check fired before the natural end while the next song
      // is still composing: wait, do not restart the song from the top.
      if (this.elapsedSec() < (this.current.duration ?? Infinity) - CROSSFADE_MS / 1000 - 1) {
        this.scheduleAdvanceCheck(BRIDGE_CHECK_SEC);
        return;
      }
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
    this.bridgeIndex = 0;
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
    this.invalidateQueue();
    this._pendingDirges = [];
    this._resumeAfterDirge = false;
    this._assignedSongIndex = this._lastSongIndex;
    try { await (await this.ensurePlaylist()).stopAll(); } catch { /* already silent */ }
    this.emit();
  }

  /** Called by combat hooks. The new mode lands within seconds, not at the next natural track end. */
  async setMode(mode) {
    if (mode === this.mode) return;
    this._prevMode = this.mode;
    this.mode = mode;
    // Queued and in-flight old-mode tracks are stale: discard them, compose
    // a vocal in the new mode first, and yield the current track promptly.
    this.invalidateQueue();
    this.markUrgent();
    this._lastQueuedKind = "bridge"; // nextKindToGenerate("bridge") = vocal first
    this.noteActivity("bard", `${mode === Mode.COMBAT ? "combat called" : "combat over"} — switching within ${MODE_SWITCH_SEC}s, stale tracks dropped`);
    this.emit();
    if (this.state === State.PLAYING) {
      this.expediteCurrent(MODE_SWITCH_SEC);
      try { await this.ensureNext(); } catch (e) { this.failSoftly(e); }
    }
  }

  /**
   * A fresh crit/fumble (or wound/corruption) earns a fresh track soon:
   * stale queued tracks are dropped and the current track yields within
   * MUSE_SWITCH_SEC. Cooldown-gated so a crit chain cannot thrash ACE.
   * @returns {Promise<boolean>} true when an expedited switch was armed.
   */
  async expediteForMuse() {
    if (this.state !== State.PLAYING || this._dirgeBusy) return false;
    if (this.current?.kind === Mode.BREAK || this.current?.kind === Mode.DIRGE) return false;
    const now = Date.now();
    if (now < this._expediteCooldownUntil) return false;
    this._expediteCooldownUntil = now + EXPEDITE_COOLDOWN_MS;
    this.invalidateQueue();
    this.markUrgent();
    this._lastQueuedKind = "bridge"; // fresh vocal first, with the new event in its verses
    this.noteActivity("bard", `big roll at the table — fresh song within ${MUSE_SWITCH_SEC}s`);
    this.expediteCurrent(MUSE_SWITCH_SEC);
    try { await this.ensureNext(); } catch (e) { this.failSoftly(e); }
    return true;
  }

  /**
   * Sing a fallen player character out. The current set stops at once (a
   * moment of silence while ACE-Step composes), the dirge naming the dead
   * and their career plays, then tavern/combat music resumes if it was on.
   * Further deaths queue their own dirges. @returns {Promise<boolean>}
   */
  async playDirge(death, { resumeAfter = null } = {}) {
    const actorName = String(death?.actor ?? "").trim();
    if (!actorName) return false;
    const c = this.getConfig();
    if (c.deathDirge === false) return false;
    const sameDirge = (d) => d?.actor === actorName;
    if (this._pendingDirges.some(sameDirge) || this._dirgeFor === actorName) return false;
    if (this.current?.kind === Mode.DIRGE && this.current.title === `Dirge for ${actorName}`) return false;
    if (this._dirgeBusy || (this.current?.kind === Mode.DIRGE && resumeAfter == null)) { this._pendingDirges.push(death); return true; }

    this._dirgeBusy = true;
    this._dirgeFor = actorName;
    const token = this.generation;
    const wasActive = resumeAfter ?? (this.state === State.PLAYING || this.state === State.GENERATING);
    this._resumeAfterDirge = wasActive;
    try {
      const dirgeSong = this.reserveSongIndex({ ignoreQueue: true });
      const req = buildDirgeRequest({ death, dirgeDuration: c.dirgeDuration ?? 180, songIndex: dirgeSong, varietySeed: this._varietySeedBase });
      this.clearTimers();
      this.invalidateQueue();
      this.current = null;
      this.state = State.GENERATING;
      this.lastWhy = req.why;
      this.emit();
      // Silence first, so no jig plays over the corpse while composing.
      try { await (await this.ensurePlaylist()).stopAll(); } catch { /* already silent */ }
      ui.notifications?.info(game.i18n?.localize("BARDICDICE.DirgeStarted") ?? `A dirge for ${actorName}…`);
      await this.postDirge(req);
      // An in-flight tavern/combat composition finishes first; its track is
      // discarded (not queued) because the state is no longer PLAYING.
      while (this.generating && token === this.generation) {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      if (token !== this.generation) return false; // Stop pressed: stay silent
      const track = await this.generateTrack(req, Mode.DIRGE);
      if (token !== this.generation) return false;
      if (track) {
        this.queue = [];
        await this.playTrack({ ...track, kind: Mode.DIRGE });
        return true;
      }
      throw new Error("Dirge generation produced no track");
    } catch (e) {
      this.failSoftly(e);
      // The words are already in chat; bring the set back if it was playing.
      if (wasActive && token === this.generation) {
        try {
          const track = await this.generateTrack(this.buildNextRequest(this.mode), this.mode);
          if (track && token === this.generation) await this.playTrack(track);
        } catch (resumeError) { this.failSoftly(resumeError); }
      }
      if (this.state === State.GENERATING && token === this.generation) this.state = State.STOPPED;
      return false;
    } finally {
      this._dirgeBusy = false;
      this._dirgeFor = null;
      this.emit();
      if (this._pendingDirges.length && this.current?.kind !== Mode.DIRGE && token === this.generation) {
        void this.playDirge(this._pendingDirges.shift(), { resumeAfter: wasActive }).catch((e) => this.failSoftly(e));
      }
    }
  }

  /** Post the dirge card to chat (and the ballads journal) before it plays. */
  async postDirge(req) {
    const html = `<div class="bardic-dice-card"><h4>🪦 ${escapeHtml(req.title)}</h4><ul class="bd-stats"><li>${escapeHtml(req.why)}</li></ul><p class="bd-lyrics">${escapeHtml(req.lyrics)}</p></div>`;
    try {
      await ChatMessage.create({ content: html, speaker: { alias: "Bardic Dice" }, flags: { [MODULE_ID]: { recap: true, dirge: true } } });
    } catch (e) { console.warn(`${MODULE_ID} | dirge chat card failed`, e); }
    if (!this.getConfig().journalRecap) return;
    try {
      let entry = game.journal?.getName(JOURNAL_NAME) ?? game.journal?.find((j) => j.name === JOURNAL_NAME);
      if (!entry) entry = await JournalEntry.create({ name: JOURNAL_NAME });
      await entry.createEmbeddedDocuments("JournalEntryPage", [{
        name: `${new Date().toLocaleDateString()} — ${req.title}`, type: "text",
        text: { content: html, format: 1 },
      }]);
    } catch (e) { console.warn(`${MODULE_ID} | dirge journal failed`, e); }
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
    this.storySummary(); stats.storyLines = this.story.contextLines(5);
    let usedSummarizer = false;
    if (c.summarizerEnabled) {
      try {
        lyrics = await fetchSummarizerLyrics({
          baseUrl: c.summarizerBaseUrl, apiKey: c.summarizerApiKey, model: c.summarizerModel,
          stats, events, bawdy: c.bawdy,
        });
        usedSummarizer = true;
      } catch (e) {
        console.warn(`${MODULE_ID} | summarizer failed, using template ballad`, e);
        ui.notifications?.warn(`Bardic Dice: recap writer unreachable (${e?.message ?? e}) — using the house ballad.`);
      }
    }
    const wasPlaying = this.state === State.PLAYING;
    this._resumeAfterBreak = wasPlaying;
    if (!wasPlaying) this.state = State.GENERATING;
    try {
      const breakSong = this.reserveSongIndex({ ignoreQueue: true });
      const req = buildBreakRequest({ stats, lyrics, bawdy: c.bawdy, breakDuration: c.breakDuration, songIndex: breakSong, varietySeed: this._varietySeedBase });
      const track = await this.generateTrack(req, Mode.BREAK, { smallLlm: !usedSummarizer });
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
