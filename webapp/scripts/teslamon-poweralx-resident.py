#!/usr/bin/env python3
"""PowerALX resident TeslaMon speech backend. Loopback only; no model downloads.

Use only with existing Life Recorder release and model cache. The normal Life
Recorder one-shot worker is NOT modified. The shared GPU lock is held while
processing each request, not during idle time.
"""
from __future__ import annotations
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
import hashlib
import hmac
import json
import os
import re
import sys
import time

ROOT=Path(r"C:\Users\Amesh\life-recorder-worker")
RELEASE=ROOT/"releases"/"phase1-20260912-b"
JOB_ROOT=(ROOT/"teslamon-jobs").resolve()
TOKEN_FILE=ROOT/"teslamon-resident"/"token.txt"
LOCK=ROOT/"production-gpu.lock"
PORT=38491

def boot():
    os.chdir(RELEASE)
    sys.path.insert(0,str(RELEASE))
    os.environ.update(
        HF_HOME=str(ROOT/"hf-cache"),
        LIFE_RECORDER_TRANSLATOR_HELPER=str(ROOT/"models"/"indictrans2-indic-en-int8"/"translate.py"),
        LIFE_RECORDER_WORKER_LOCK=str(LOCK),
        HF_HUB_OFFLINE="1",
        TRANSFORMERS_OFFLINE="1",
        HF_DATASETS_OFFLINE="1",
        HF_HUB_DISABLE_TELEMETRY="1"
    )
    # Match original worker imports, models and inference configuration.
    import onnx_asr
    from faster_whisper import WhisperModel
    from faster_whisper.audio import decode_audio
    from faster_whisper.vad import VadOptions,get_speech_timestamps
    from worker import pipeline as w
    conf={
        "whisper":os.environ.get("LIFE_RECORDER_WHISPER","large-v3"),
        "translator":os.environ.get("LIFE_RECORDER_TRANSLATOR","200m"),
        "max_group_seconds":25.0,
        "implementation_sha256":w.audio_sha256(Path(w.__file__))
    }
    with w.gpu_lock(LOCK):
        whisper=w.WhisperASR(WhisperModel(conf["whisper"],device="cuda",compute_type="float16"))
        indic={
            "ml":w.IndicASR(onnx_asr.load_model("OpenVoiceOS/ai4bharat-indicconformer-ml-onnx"),
                          "ai4bharat IndicConformer Malayalam"),
            "hi":w.IndicASR(onnx_asr.load_model("OpenVoiceOS/ai4bharat-indicconformer-hi-onnx"),
                          "ai4bharat IndicConformer Hindi")
        }
        translator=w.load_translator(conf["translator"])
    def vad(path):
        samples=decode_audio(str(path),sampling_rate=16000)
        return get_speech_timestamps(samples,vad_options=VadOptions(
            threshold=0.50,min_speech_duration_ms=220,max_speech_duration_s=6.0,
            min_silence_duration_ms=320,speech_pad_ms=140),sampling_rate=16000)
    return w,conf,whisper,indic,translator,vad

class Handler(BaseHTTPRequestHandler):
    # Avoid logging tokens, audio names, user speech or headers.
    def log_message(self,*_):pass
    def send_result(self,code,obj):
        body=json.dumps(obj,separators=(",",":")).encode()
        self.send_response(code)
        self.send_header("Content-Type","application/json")
        self.send_header("Cache-Control","no-store")
        self.send_header("Content-Length",str(len(body)))
        self.end_headers();self.wfile.write(body)
    def do_POST(self):
        raw=self.headers.get("Authorization","")
        if not hmac.compare_digest(raw,"Bearer "+self.server.token):
            return self.send_result(403,{"status":"failed","code":"unauthorized"})
        if self.path=="/health":
            return self.send_result(200,{"status":"ready","resident":True})
        if self.path!="/process":
            return self.send_result(404,{"status":"failed","code":"not_found"})
        try:
            length=int(self.headers.get("Content-Length","0"))
            if length<2 or length>128:raise ValueError("bad_length")
            data=json.loads(self.rfile.read(length))
            job=data.get("id")
            if not isinstance(job,str) or not re.fullmatch(
                r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}",job):
                raise ValueError("bad_job_id")
            directory=(JOB_ROOT/job).resolve()
            if directory.parent!=JOB_ROOT:raise ValueError("bad_job_folder")
            meta_file=directory/"metadata.json"
            meta=json.loads(meta_file.read_text(encoding="utf-8"))
            if meta.get("id")!=job:raise ValueError("metadata_mismatch")
            audio_files=[p for p in directory.iterdir() if p.name in (
                "audio.m4a","audio.wav","audio.webm","audio.ogg")]
            if len(audio_files)!=1 or not (128<=audio_files[0].stat().st_size<=5*1024*1024):
                raise ValueError("bad_audio")
            audio=audio_files[0]
            if float(meta.get("duration",0))<=0.1 or float(meta["duration"])>21:
                raise ValueError("bad_duration")
            with self.server.worker.gpu_lock(LOCK):
                output=self.server.worker.process(
                    audio,meta,directory/"result.json",
                    self.server.whisper,self.server.indic,self.server.translator,
                    self.server.vad,self.server.conf)
            return self.send_result(200,{"status":"complete" if output.get("final") else "incomplete",
                                         "id":job})
        except (OSError,ValueError,TypeError,KeyError,json.JSONDecodeError):
            return self.send_result(400,{"status":"failed","code":"invalid_job"})
        except Exception as ex:
            return self.send_result(503,{"status":"failed","code":"worker_failed",
                                          "kind":type(ex).__name__})
if __name__=="__main__":
    if os.name!="nt":raise SystemExit("This worker only runs on PowerALX Windows")
    token=TOKEN_FILE.read_text().strip()
    if len(token)<40:raise SystemExit("missing private access token")
    t0=time.time()
    w,conf,whisper,indic,translator,vad=boot()
    server=HTTPServer(("127.0.0.1",PORT),Handler)
    server.token=token
    server.worker=w;server.conf=conf
    server.whisper=whisper;server.indic=indic;server.translator=translator;server.vad=vad
    print(json.dumps({"status":"ready","port":PORT,
                      "startup_seconds":round(time.time()-t0,2)}),flush=True)
    server.serve_forever(poll_interval=0.25)
