@echo off
cd /d "%~dp0"
if exist dataset_recibos_aprendidos.json (
    notepad dataset_recibos_aprendidos.json
) else (
    echo Aún no hay recibos entrenados.
    echo Coloca fotos en la carpeta 'recibos_para_entrenar' y ejecuta el bat 1.
    pause
)
