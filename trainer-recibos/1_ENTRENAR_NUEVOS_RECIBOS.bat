@echo off
chcp 65001 > nul
title Fonsi - Entrenador de Recibos
cd /d "%~dp0"
echo ======================================================
echo    FONSI (EN UN 2X3) - ENTRENADOR DE RECIBOS REALES
echo ======================================================
echo.
python entrenador.py
pause
