@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>&1
if errorlevel 1 (
  echo FEHLER: Node.js ist nicht installiert. Bitte von https://nodejs.org installieren.
  pause
  exit /b 1
)
if not exist .env (
  echo Die Datei .env fehlt.
  echo Bitte .env.example kopieren und als .env speichern, dann OWNER_EMAIL eintragen.
  pause
  exit /b 1
)
echo =============================================
echo SUMMITLINE CITY ROLEPLAY - TEAMZENTRALE
echo =============================================
node server.js
echo.
echo Der Server wurde beendet. Fehlermeldungen stehen oben.
pause
