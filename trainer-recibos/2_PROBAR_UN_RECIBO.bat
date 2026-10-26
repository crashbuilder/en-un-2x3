@echo off
chcp 65001 > nul
title Fonsi - Probar Recibo
cd /d "%~dp0"
echo ======================================================
echo    FONSI (EN UN 2X3) - PROBADOR DE COMPROBANTES
echo ======================================================
echo.
python probar_recibo.py %1
pause
