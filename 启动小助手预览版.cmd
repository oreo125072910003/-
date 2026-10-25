@echo off
chcp 65001 >nul
powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\launch-desktop.ps1" %*
if errorlevel 1 pause
