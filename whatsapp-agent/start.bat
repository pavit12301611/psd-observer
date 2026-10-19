@echo off
REM Observer WhatsApp Agent - double-click launcher for Windows (free, native WhatsApp)
title Observer WhatsApp Agent
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Install Node 20+ free from https://nodejs.org and run this again.
  pause
  exit /b 1
)

if not exist ".env" (
  echo Creating .env from .env.example - your numbers are already in it.
  copy ".env.example" ".env" >nul
)

if not exist "node_modules" (
  echo Installing dependencies ^(first run only^)...
  call npm install
)

echo.
echo Starting agent. Scan the QR with the AGENT phone (8859555795):
echo WhatsApp - Linked devices - Link a device
echo Then message it from YOUR number (9528923866): /help
echo Keep this window open while you want the agent awake. Ctrl+C stops it.
echo.
call npm start
pause
