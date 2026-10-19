@echo off
REM friend-chat -- start the server and open it in a browser.
cd /d "%~dp0"

REM There is one dependency now (the Anthropic SDK, for Question Bot). Fetch it
REM on the first run so this stays a double-click rather than two steps.
if not exist "node_modules" (
  echo First run: installing dependencies, this takes a moment...
  call npm install
  if errorlevel 1 (
    echo.
    echo npm install failed. friendchat needs Node 22.5 or newer.
    pause
    exit /b 1
  )
)

start "" http://localhost:3000
node --experimental-sqlite server.mjs
pause
