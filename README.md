# Bardic Dice — WFRP4e ACE-Step Tavern Music for Foundry VTT v14

A Foundry VTT **v14** module (`foundry-game-music`) for **Warhammer Fantasy
Roleplay 4th Edition** that generates a live, bawdy solo-bard soundtrack with
a local [ACE-Step 1.5](https://github.com/ACE-Step/ACE-Step-1.5) sidecar.
The music listens to your table:

- **WFRP dice steer the songs.** Doubles under the target are Criticals and
  doubles over it — plus 99/100 — are Fumbles, following the system test
  result. Criticals earn heroic verses; Fumbles earn mocking verses and, in
  numbers, a drunken 3/4 waltz. Recent public chat seasons the lyrics.
- **Critical Wounds turn the music grim.** A newly applied WFRP Critical
  Wound slows and darkens a tavern track, intensifies combat, and is named
  in the next verse and break recap.
- **Corruption sounds wrong immediately.** When an actor gains Corruption,
  everyone hears a short sad discordant sting; the next generated track
  also gets a brief sour, detuned passage.
- **A player death stops the set for a dirge.** When a player character
  dies — Wounds/HP reach 0, a Dead condition lands, Critical Wounds pass
  their maximum, a fatal Critical Wound is applied, or the combatant is
  marked Defeated in the tracker — the music falls silent, a slow dirge
  naming the fallen character **and their career** is composed, posted to
  chat (and the ballads journal), and sung, then the set resumes. NPC
  deaths never trigger it (toggle: *Dirge on Player-Character Death*).
- **Two bards, alternating every song — and duetting.** Solo songs swap
  a male Reiklander baritone (Bavarian German accent) and a female
  Bretonnian alto (French accent), stamped into both the ACE prompt and
  the lyric section tags; solo songs alternate strictly so both bards get
  equal time, every fifth song (and every break ballad) is a duet —
  verses trade, choruses harmonise. Dirges stay solo.
- **A style roulette, grimdark-comedy parodies.** Every song and bridge
  draws an abstract style template (progression, structure, groove) from
  26 genre crafts, transposes it to a fresh key, and often reverses or
  rotates the progression — original parodies of conventions only: no
  copied lyrics, titles, hooks or melodies are stored or prompted.
  Neighbouring songs never repeat style or key; improvised lute/fiddle/
  flute solo breaks are built in. Jokes are generated from the actual
  latest rolls/careers and never repeat a recent punchline.
- **LRCLIB parody core writer.** The parody writer is the core lyric
  writer for every vocal song — tavern, combat, PC-death dirges and
  break-recap ballads. Each song is built on a real song's *skeleton* from
  a local LRCLIB dump (stanza shapes, syllable counts, rhyme scheme — the
  source words never leave the GM machine). The lyric/humor/memory LLM
  picks the skeleton that fits the party and the current enemy (theme
  tags only; local scoring when the LLM is down), writes fresh grimdark
  words with the table's dice facts, and the draft is screened against
  the source before a bard sings it. Dirges hunt funeral-fit (solemn)
  skeletons and must keep the fallen's name; `start-all.sh` launches the
  writer with the rest of the stack. When it is unreachable, the
  template/LLM writers take over as the fallback. See
  [`sidecar/README.md`](sidecar/README.md).
- **A corner readout of what everyone is doing.** A small panel in the
  bottom-left corner (all clients) shows the current song and how long it
  has left, what is queued next, and the latest BARD / LYRIC / PARODY /
  MEMORY actions — so when a combat switch or crit song is coming, the
  table can see it coming instead of guessing. For the full working, the
  right sidebar's **Lyric Bot at Work** panel shows each step with its
  evidence: the party/enemy fit hunt, dice facts and saga lines fed to
  the writer, screens passed or refused, and the legends memory returns.
- **Plucky and lively, never a lullaby.** Bright plucky lute leads every
  track; bridges keep a prominent bodhran/frame-drum/tabor groove at
  song tempo so a marathon session stays awake (dirges stay solemn).
- **No townspeople during play.** Tavern and combat tracks use one bard and
  explicitly exclude crowd noise/chatter. The full crowd only returns for
  the On Break ballad.
- **Combat speeds up.** Starting combat — the tracker hook, an initiative
  roll in chat, or initiative landing on a combatant, whichever is noticed
  first — switches to a faster battle jig —
  war drum, hurdy-gurdy, roughly +35 BPM in a minor key. Queued and
  in-flight tavern tracks are discarded and the current track yields
  within seconds, so the jig is heard almost at once. A fresh Critical or
  Fumble likewise earns a fresh song (heroic/mocking verse included)
  within the minute, cooldown-gated so crit chains cannot thrash the
  composer. Ending combat drifts back to tavern tempo.
- **On Break sings the session back to you.** One button composes a recap
  ballad of the last 2–3 hours (top critter, worst fumbler, biggest roll,
  running table talk), posts the lyrics and stats to chat, and optionally
  files them in a "Session Ballads" journal.
- **Songs loop; bridges pad the gaps.** Each style template owns its loop:
  a fixed block form (verses, pre-choruses, choruses, solo/break blocks), a
  per-style chorus hook, and per-block harmony (verse/chorus/bridge chord
  cycles). Vocal songs are long (3 minutes by default) and loop as one
  continuous performance in that form: the hook stays word-for-word while
  every lap sings fresh verses about the latest rolls and chat, and the
  tiny-LLM polish must preserve the blocks and hook or the template words
  stand. Between songs — and across tavern/combat style changes — long
  instrumental bridges loop in the *next* song's style, key, hook motif
  and chord cycle (tempo-blended on a style switch), so the music never
  goes silent while the next song is composing.
- **One button on the left toolbar.** A music-note scene control opens the
  submenu: **Start · Pause/Resume · Stop · On Break · Status**.

## How it works

ACE-Step is a Python/GPU model — it cannot run inside Foundry — so the GM
runs it as a sidecar service and this module is the client:

```
GM browser ──POST /release_task, poll /query_result──▶ ACE-Step api_server :8001
     ◀────────────── GET /v1/audio (MP3) ─────────────
     └── re-uploads MP3 to Foundry storage, plays it via a
         "Bardic Dice — Live" Playlist → all players hear it in sync
```

Only the GM client talks to ACE-Step. Players never touch the sidecar,
and whispers/secret rolls never steer the music unless the GM opts in.
The next track is composed while the current one plays, so transitions
have no silence gap. ACE-Step renders whole files rather than streaming,
so a mode change cannot crossfade mid-file — instead stale queued and
in-flight tracks are discarded and the current file yields within
seconds to a freshly composed track in the new mode. To keep one local
GPU responsive: only one track is composed ahead, combat renders are
capped (120s songs / 60s bridges — they loop), stale ACE polling is
aborted on a switch, the parody hunt stands down during urgent switches,
and slow renders are reported in the sidebar (`ACE-Step took Ns…`).
Lyric drafts are repaired into the loop blocks rather than rejected, so
the tiny model's words actually get sung; every Critical rolled at the
table is shouted with an explicit `Critical!` callout naming the hero.

## Install

1. **Start the ACE-Step sidecar** on the GM machine — see
   [`sidecar/README.md`](sidecar/README.md). Check it:
   `curl http://127.0.0.1:8001/health`
   For the LLM-written break ballads, also run the local LLM setup once
   (`sidecar/setup-llm.sh`, or `setup-llm.bat` on Windows) — it installs
   Ollama, pulls the model, starts the server, and prints the Foundry
   settings to enter. `./sidecar/start-all.sh` runs both sidecars.
2. **Install the module** in Foundry via *Add-on Modules → Install Module*
   with this manifest URL:
   `https://raw.githubusercontent.com/giml3/foundry-game-music/main/module.json`
   (or copy this folder to `Data/modules/foundry-game-music/`), then
   enable **Bardic Dice** in the world.
3. **Configure** under *Game Settings → Module Settings → Bardic Dice*:
   ACE-Step URL/key/model, track lengths, bawdy level
   (Clean / Bawdy / Filthy), volume, and the optional recap LLM.
4. Press the **music-note button** on the left toolbar → **Start**.

## The break ballad's writers

- **House ballad (default, offline):** a built-in template that always
  names the table's actual crits, fumbles, and biggest rolls.
- **Small LLM lyric/joke writer + story tracker:** a tiny local model
  (`llama3.2:1b` via Ollama) rewrites everyday verses and bridge jokes
  fresh per song from dice facts, guided by a persistent all-time story
  tracker (crit/fumble legends, scars, corruption, the fallen, saga
  milestones) that survives across sessions and feeds callbacks into both
  template and LLM lyrics. Only names/careers/roll facts/stats go to the
  (default-local) endpoint — never raw chat, never source lyrics; any
  failure falls back to templates. API: `api.story()`.
- **External LLM (opt-in):** run `sidecar/setup-llm.sh` once to install
  and start a local Ollama, or point *Summarizer API URL* at any
  OpenAI-compatible endpoint (e.g. local Ollama at
  `http://127.0.0.1:11434/v1`) and enable it. Actor names, roll stats,
  and samples of *public* chat are sent there — that's why it's off by
  default. Any failure falls back to the house ballad.
- Either way, ACE-Step's own LM (`thinking`) polishes the lyrics into
  singable form during generation.

## Macro / API

```js
const api = game.modules.get("foundry-game-music").api;
api.start(); api.pause(); api.stop(); api.onBreak();
api.dirge("Brunhilde", "Soldier"); // manual dirge if a death was missed
api.status();      // {state, mode, nowPlaying, nextTrack, why, healthOk}
api.openStatus();
```

## Notes & limits

- Foundry **v14 only** (uses the v14 object-keyed scene-controls API).
  WFRP4e is the primary verified system: tests are read from
  `message.system.test`, Critical Wounds from owned `critical` items,
  Corruption from `system.status.corruption.value`, and PC deaths from
  `system.status.wounds.value` / `system.status.criticalWounds`, Dead
  statuses, fatal Critical Wounds, and combatant Defeated flags (career
  from `currentCareer` / the current career item / `details.career`).
  Generic natural-d20
  and `isCritical`/`isFumble` detection remains as a fallback elsewhere.
- Pause stores the position in the PlaylistSound (`pausedTime`) and
  resumes for everyone at once.
- Generated MP3s accumulate in the configured upload folder
  (default `bardic-dice/`); old playlist *entries* are pruned, files are
  yours to keep or clean out between campaigns. On The Forge, uploads
  go to your Assets library quota — 3-minute MP3s are ~3–5 MB each.
- HTTPS Foundry + `http://127.0.0.1:8001` sidecar works in Chromium
  (localhost is trustworthy). A sidecar on another host needs HTTPS and
  CORS for your Foundry origin.

## Development

```bash
npm test        # node:test — prompt mapping, session log, recap, ACE client
npm run check   # syntax-check every shipped script
npm run mock-ace  # fake ACE-Step server on :8001 for Foundry testing without a GPU
```

The mock server provides `/health`, `/v1/models`, `/release_task`,
`/query_result`, and `/v1/audio` (a short generated tone as MP3 bytes),
so the full Start → combat → break flow can be exercised end-to-end.
