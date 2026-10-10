@echo off
title VidSave Downloader Server Launcher
echo ===================================================
echo   Starting VidSave - Media Downloader (Backend + Frontend)
echo ===================================================

echo [1/2] Launching Backend Server on port 5000...
start cmd /k "cd server && node index.js"

timeout /t 2 >nul

echo [2/2] Launching Frontend Client on port 3000...
start cmd /k "cd client && npm run dev"

echo.
echo Application started!
echo Frontend: http://localhost:3000
echo Backend:  http://localhost:5000
echo ===================================================
pause
