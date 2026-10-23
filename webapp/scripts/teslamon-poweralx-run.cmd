@echo off
setlocal
set "ROOT=C:\Users\Amesh\life-recorder-worker"
set "PATH=%ROOT%\runtime\cuda12;%PATH%"
set "HF_HOME=%ROOT%\hf-cache"
set "PYTHONUTF8=1"
set "LIFE_RECORDER_TRANSLATOR_HELPER=%ROOT%\models\indictrans2-indic-en-int8\translate.py"
set "LIFE_RECORDER_WORKER_LOCK=%ROOT%\production-gpu.lock"
set "HF_HUB_OFFLINE=1"
set "TRANSFORMERS_OFFLINE=1"
set "HF_DATASETS_OFFLINE=1"
set "HF_HUB_DISABLE_TELEMETRY=1"
cd /d "%ROOT%\releases\phase1-20260912-b"
"%ROOT%\.venv\Scripts\python.exe" -u "%ROOT%\teslamon-resident\resident.py" >> "%ROOT%\teslamon-resident\stdout.log" 2>> "%ROOT%\teslamon-resident\stderr.log"
