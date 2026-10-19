@echo off
REM Windows launcher. Set ACE_STEP_HOME to your ACE-Step-1.5 checkout, or use upstream start_api_server.bat.
if "%ACE_STEP_HOME%"=="" set ACE_STEP_HOME=%USERPROFILE%\ACE-Step-1.5
if "%ACESTEP_API_HOST%"=="" set ACESTEP_API_HOST=127.0.0.1
if "%ACESTEP_API_PORT%"=="" set ACESTEP_API_PORT=8001
cd /d "%ACE_STEP_HOME%"
if exist start_api_server.bat (
  call start_api_server.bat
) else (
  python -m acestep.api_server
)
