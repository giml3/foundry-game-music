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

## Local LLM (break-ballad writer) — Ollama

"On Break" can send the session recap to a local LLM for richer verses.
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
`http://127.0.0.1:11434/v1`, model `llama3.1`, key blank. Until that
toggle is on, nothing leaves the table and the built-in template ballad
is used instead. Ollama stays bound to `127.0.0.1`; only the GM client
talks to it. Verify any time with `curl http://127.0.0.1:11434/api/tags`.
