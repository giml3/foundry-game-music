@echo off
rem Run the Bardic Dice LRCLIB parody writer in the foreground. Ctrl-C stops it.
rem One-time: decompress the dump to lrclib.sqlite3 next to module.json
rem (check disk space first). Ollama must be running too (start-llm.bat).
setlocal
set "DIR=%~dp0.."
if not defined PARODY_DB set "PARODY_DB=%DIR%\lrclib.sqlite3"
if not exist "%PARODY_DB%" (
  echo LRCLIB database not found at %PARODY_DB%.
  echo Decompress the dump once to lrclib.sqlite3, then retry.
  exit /b 1
)
if not defined PARODY_PORT set "PARODY_PORT=8123"
node "%DIR%\sidecar\parody-writer.mjs" --db "%PARODY_DB%" --port "%PARODY_PORT%"
