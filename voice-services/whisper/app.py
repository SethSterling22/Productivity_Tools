# Whisper STT microservice (faster-whisper), tailnet-only.
# POST /transcribe  (multipart: file=<audio>, optional language) -> { ok, text, language }
# GET  /health
import os
import tempfile
from fastapi import FastAPI, UploadFile, File, Form
from faster_whisper import WhisperModel

MODEL_SIZE = os.environ.get("WHISPER_MODEL", "small")      # base|small|medium|large-v3
DEVICE     = os.environ.get("WHISPER_DEVICE", "cuda")      # cuda | cpu
COMPUTE    = os.environ.get("WHISPER_COMPUTE", "float16")  # float16 (gpu) | int8 (cpu)

app = FastAPI(title="whisper-stt")
model = WhisperModel(MODEL_SIZE, device=DEVICE, compute_type=COMPUTE)


@app.get("/health")
def health():
    return {"ok": True, "model": MODEL_SIZE, "device": DEVICE}


@app.post("/transcribe")
async def transcribe(file: UploadFile = File(...), language: str = Form(None)):
    data = await file.read()
    suffix = os.path.splitext(file.filename or "")[1] or ".ogg"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp.write(data)
        path = tmp.name
    try:
        segments, info = model.transcribe(path, language=language, vad_filter=True)
        text = "".join(seg.text for seg in segments).strip()
        return {"ok": True, "text": text, "language": info.language}
    except Exception as e:
        return {"ok": False, "error": str(e)}
    finally:
        try:
            os.remove(path)
        except OSError:
            pass
