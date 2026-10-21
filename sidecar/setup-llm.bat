@echo off
REM Bardic Dice - local LLM setup (Windows). Installs Ollama via winget if
REM needed, starts its server, pulls the recap-writer model, smoke-tests it.
REM Override the model:  set BARDIC_LLM_MODEL=qwen2.5:7b  before running.
setlocal
if "%BARDIC_LLM_MODEL%"=="" set BARDIC_LLM_MODEL=llama3.2:1b
set OLLAMA_BASE=http://127.0.0.1:11434

where ollama >nul 2>nul
if %errorlevel%==0 goto have_ollama
echo Installing Ollama with winget...
where winget >nul 2>nul
if %errorlevel% neq 0 (
  echo winget not found. Install Ollama manually from https://ollama.com/download then re-run.
  exit /b 1
)
winget install -e --id Ollama.Ollama --accept-source-agreements --accept-package-agreements
REM The Ollama app normally autostarts its server; a fresh terminal picks up PATH.
set "PATH=%PATH%;%LOCALAPPDATA%\Programs\Ollama"

:have_ollama
curl -fsS --max-time 3 %OLLAMA_BASE%/api/tags >nul 2>nul
if %errorlevel%==0 goto is_up
echo Starting Ollama server...
start "" /min ollama serve
for /l %%i in (1,1,30) do (
  curl -fsS --max-time 3 %OLLAMA_BASE%/api/tags >nul 2>nul && goto is_up
  timeout /t 1 /nobreak >nul
)
echo Ollama did not come up on %OLLAMA_BASE%.
exit /b 1

:is_up
echo Ollama server is up on %OLLAMA_BASE%
echo Pulling tiny model %BARDIC_LLM_MODEL% (first run downloads ~1 GB)...
ollama pull %BARDIC_LLM_MODEL%
if %errorlevel% neq 0 exit /b %errorlevel%

echo Smoke-testing %OLLAMA_BASE%/v1/chat/completions ...
curl -fsS --max-time 120 %OLLAMA_BASE%/v1/chat/completions -H "Content-Type: application/json" -d "{\"model\":\"%BARDIC_LLM_MODEL%\",\"temperature\":0,\"max_tokens\":16,\"messages\":[{\"role\":\"user\",\"content\":\"Say the word ready and nothing else.\"}]}" | findstr /c:"\"content\"" >nul
if %errorlevel% neq 0 (
  echo Smoke test failed - see output above.
  exit /b 1
)
echo.
echo Local LLM is running. In Foundry (Module Settings, Bardic Dice) set:
echo   Enable External LLM Recap Writer : on
echo   Summarizer API URL               : %OLLAMA_BASE%/v1
echo   Summarizer Model                 : %BARDIC_LLM_MODEL%
echo   Summarizer API Key               : (leave blank)
echo   Small LLM Lyric/Joke Writer      : on (default)
echo   Small LLM API URL                : %OLLAMA_BASE%/v1
echo   Small LLM Model                  : %BARDIC_LLM_MODEL%
endlocal
