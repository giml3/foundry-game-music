@echo off
REM Keep the Bardic Dice local LLM (Ollama) running. Run setup-llm.bat once first.
curl -fsS --max-time 3 http://127.0.0.1:11434/api/tags >nul 2>nul
if %errorlevel%==0 (
  echo Ollama is already running on http://127.0.0.1:11434 - nothing to do.
  exit /b 0
)
where ollama >nul 2>nul
if %errorlevel% neq 0 (
  echo Ollama not installed. Run setup-llm.bat first.
  exit /b 1
)
ollama serve
