@echo off
title DevSupplies - TikTok Live Recorder & Downloader
echo ===================================================
echo   DevSupplies - TikTok Live Recorder & Downloader
echo ===================================================
echo.
echo Starting server on http://localhost:8000 ...
echo.

start "" "http://localhost:8000"
python server.py

pause
