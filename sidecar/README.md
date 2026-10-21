# ACE-Step 1.5 sidecar for Bardic Dice

ACE-Step is a Python/GPU music model. It cannot run inside Foundry, so the GM
runs it next to Foundry and Bardic Dice talks to it over HTTP.

## Install (once, on the GM machine)

Requirements: Python 3.11–3.12, CUDA GPU recommended (MPS / ROCm / XPU / CPU also work, slower).

```bash
curl -LsSf https://astral.sh/uv/install.sh | sh   # macOS/Linux; see upstream for Windows
git clone https://github.com/ACE-Step/ACE-Step-1.5.git
cd ACE-Step-1.5
uv sync   # or follow docs/en/INSTALL.md in that repo
```

## Run

```bash
ACE_STEP_HOME=/path/to/ACE-Step-1.5 ./start-api.sh        # Linux/CUDA
ACE_STEP_HOME=/path/to/ACE-Step-1.5 ./start-api-macos.sh  # macOS
start-api.bat                                             # Windows
```

Verify: `curl http://127.0.0.1:8001/health` → `{"data":{"status":"ok",...}}`,
and `curl http://127.0.0.1:8001/v1/models` lists `acestep-v15-turbo`.

Then in Foundry: Module Settings → Bardic Dice → ACE-Step API URL
(default `http://127.0.0.1:8001`). If you set `ACESTEP_API_KEY` on the
sidecar, paste the same key into the module setting.

## Notes

- Keep the sidecar bound to `127.0.0.1`. Players never contact it: the GM
  client downloads each MP3 and re-uploads it to Foundry storage, and
  Foundry's Playlist sync plays it for everyone.
- First generation downloads/loads model weights and is slow; later tracks
  on `acestep-v15-turbo` (8 steps) take seconds on a desktop GPU.
- If Foundry is served over HTTPS, Chromium treats `http://127.0.0.1` as a
  trustworthy local address. A sidecar on another host must be HTTPS or
  reverse-proxied on the same origin, or the browser blocks it as mixed
  content. CORS must allow your Foundry origin.

## Local LLMs (tiny lyric/joke writer + break-ballad writer) — Ollama

Everyday verses/jokes are written by a super-small local model (default `llama3.2:1b`); "On Break" can also send the session recap to a local LLM for richer verses.
That LLM (Ollama) needs to be installed once and running every session —
the setup scripts here handle both:

```bash
# One-time: install Ollama if needed, start it, pull the model, smoke-test
./setup-llm.sh        # macOS / Linux  (Windows: setup-llm.bat)
#   BARDIC_LLM_MODEL=qwen2.5:7b ./setup-llm.sh   # use a different model

# Every session (if Ollama isn't already running):
./start-llm.sh        # foreground — Ctrl-C stops it (Windows: start-llm.bat)

# Or start ACE-Step + LLM together (LLM in the background):
ACE_STEP_HOME=/path/to/ACE-Step-1.5 ./start-all.sh
```

The setup script finishes by printing the exact Foundry module settings:
enable *External LLM Recap Writer*, Summarizer API URL
`http://127.0.0.1:11434/v1`, model `llama3.2:1b`, key blank, plus the *Small LLM* URL/model fields (same values) for the everyday writer. The small-LLM writer only sends names/careers/roll stats (never raw chat); the recap writer stays opt-in. Failures fall back to template lyrics/jokes. Ollama stays bound to `127.0.0.1`; only the GM client
talks to it. Verify any time with `curl http://127.0.0.1:11434/api/tags`.

## Pregenerate a bridge library (marathon sessions)

For very long sessions, render the lively plucky interludes (now in rotating styles/keys/progressions) ahead of time so the
GPU only handles dice-steered vocal songs during play:

```bash
node sidecar/pregenerate-bridges.mjs --out "<FoundryData>/bardic-dice/library"          # 48 tracks ≈ 6 h
node sidecar/pregenerate-bridges.mjs --count 144 --out "<FoundryData>/bardic-dice/library"  # ~24 h, near-zero repeats
```

Sizing for 24 h: zero repeats needs 144 ten-minute (or 288 five-minute)
tracks. The default 48 tracks of 5-10 minutes (~6 h unique, a few hundred
MB) repeat about four times across a full day, hours apart. The script is
resumable, writes `manifest.json` as it goes, and logs render speed with an
ETA. The module prefers library interludes automatically when the folder
exists (Settings: *Prefer Pregenerated Bridge Library*).

## LRCLIB parody writer (random-song skeletons -> fresh parodies)

The parody writer picks a random song from a local [LRCLIB](https://lrclib.net)
database dump, reduces its lyrics to a structural skeleton (stanza shapes,
syllable counts, rhyme scheme — the source words are never sent anywhere),
and has the same tiny Ollama model write an original grimdark parody on
that skeleton with the table's dice facts. Every draft is screened against
the source on the GM machine: a shared lyric line or 5-word run means
refusal (one retry, then fallback to the normal writers). Source lyrics
never leave the GM machine, and no real title/hook/melody is prompted or
sung.

```bash
# One-time (large — check disk space first; the .gz in the repo root is ~45 GB):
gzip -dc lrclib-db-dump-20261012T090639Z.sqlite3.gz > lrclib.sqlite3

# Every session: ./start-all.sh launches the writer in the background
# alongside Ollama and ACE-Step. Standalone run (foreground):
./start-parody.sh        # Ctrl-C stops it (Windows: start-parody.bat)
curl http://127.0.0.1:8123/health
```

The writer is the module's core lyric writer — no setting to enable
(URL default `http://127.0.0.1:8123`; clear the URL in Module Settings
to disable). Every vocal song — tavern, combat, PC-death dirges and
break-recap ballads — sings a screened parody fitted into the song's
blocks and hook; the Status "why" names the skeleton's track id. Dirges
hunt funeral-fit (solemn-themed) skeletons and are refused if the
fallen's name does not survive the fit. Any failure falls back silently
to the tiny-LLM/template writers with a 5-minute cooldown.
Song choice is fitted, not blind: the writer samples a pool of random
candidates, reduces each to theme tags (kept on this machine), and asks
the tiny LLM to pick the skeleton fitting the party's careers and the
current hostile combatants; a local tag-overlap score decides when the
LLM is unreachable. The chosen skeleton's parody prompt names the party
(to cheer) and the enemy (to mock). Watch the module's bottom-left HUD
for `PARODY: lyric LLM picked skeleton for … vs …` lines as it works.
