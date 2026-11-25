@echo off
title Sound Sticker Studio (Modo Multi-Sesion Compartido)
cd /d "%~dp0"
set PERSIST_LOCAL_SESSION=false
set HOST=127.0.0.1
set PORT=3000
set MAX_SESSIONS=12
set SESSION_TTL_MIN=10
echo ============================================================
echo  Iniciando en modo MULTI-SESION EFIMERA (en memoria RAM)
echo  Cada persona escanea su propio QR y se borra automaticamente.
echo  Para compartir por internet gratis, abre otra consola y corre:
echo    cloudflared tunnel --url http://127.0.0.1:3000
echo ============================================================
deno task start
pause
