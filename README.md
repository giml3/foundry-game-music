# Bardic Dice — ACE-Step Tavern Music for Foundry VTT v14

A Foundry VTT **v14** module (`foundry-game-music`) that generates a live,
bawdy tavern soundtrack with a local [ACE-Step 1.5](https://github.com/ACE-Step/ACE-Step-1.5)
sidecar. The music listens to your table:

- **Dice steer the songs.** Crits make the next track rowdier and faster and
  earn the roller a heroic verse; fumbles earn a mocking verse and, in
  numbers, a drunken 3/4 waltz. Recent public chat seasons the lyrics.
- **Combat speeds up.** Starting combat switches to a faster battle jig —
  war drum, hurdy-gurdy, roughly +35 BPM in a minor key — landing on the
  next track. Ending combat drifts back to tavern tempo.
- **On Break sings the session back to you.** One button composes a recap
  ballad of the last 2–3 hours (top critter, worst fumbler, biggest roll,
  running table talk), posts the lyrics and stats to chat, and optionally
  files them in a "Session Ballads" journal.
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
have no silence gap; mode changes land on track boundaries because
ACE-Step renders whole files rather than streaming.

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
api.status();      // {state, mode, nowPlaying, nextTrack, why, healthOk}
api.openStatus();
```

## Notes & limits

- Foundry **v14 only** (uses the v14 object-keyed scene-controls API).
  System-agnostic: crits/fumbles come from natural d20s plus any
  `isCritical`/`isFumble` flags your system sets; other dice still
  steer tempo by how hot the rolling runs.
- Pause stores the position in the PlaylistSound (`pausedTime`) and
  resumes for everyone at once.
- Generated MP3s accumulate in the configured upload folder
  (default `bardic-dice/`); old playlist *entries* are pruned, files are
  yours to keep or clean out between campaigns. On The Forge, uploads
  go to your Assets library quota — 90-second MP3s are ~1–2 MB each.
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
