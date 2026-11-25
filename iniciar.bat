@echo off
title Sound Sticker Studio (Modo Local Personal)
cd /d "%~dp0"
set PERSIST_LOCAL_SESSION=true
set HOST=127.0.0.1
set PORT=3000
start "" http://127.0.0.1:3000
deno task start
pause
