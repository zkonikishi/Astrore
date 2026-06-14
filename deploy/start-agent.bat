@echo off
cd /d "%~dp0"
echo Astrore Agent is starting at http://127.0.0.1:1421/
echo Keep this window open while using Astrore.
start "" powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 2; Start-Process 'http://127.0.0.1:1421/'"
astrore-agent.exe
pause
