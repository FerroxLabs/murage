@echo off
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0external.ps1" diskpart %*
exit /b %errorlevel%
