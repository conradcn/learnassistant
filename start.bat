@echo off
setlocal
cd /d "%~dp0"
if not exist "node_modules" (
  echo [learn-assistant] Installing dependencies...
  call npm install || exit /b 1
)
if not defined PORT set PORT=31544
echo [learn-assistant] Open http://localhost:%PORT%
call npm run start -- %*
