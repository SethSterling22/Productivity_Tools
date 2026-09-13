# Piper TTS microservice, tailnet-only.
# POST /speak  { text, voice? }  -> audio/wav bytes
# GET  /health
import io
import os
import wave
from fastapi import FastAPI
from fastapi.responses import Response, JSONResponse
from pydantic import BaseModel
from piper import PiperVoice

# Voice model (.onnx) mounted into the container; see deploy guide.
DEFAULT_VOICE = os.environ.get("PIPER_VOICE", "/voices/es_MX-ald-medium.onnx")
# For multi-speaker models, pick a speaker index (e.g. a female voice). Blank = default.
_spk = os.environ.get("PIPER_SPEAKER", "")
DEFAULT_SPEAKER = int(_spk) if _spk.strip().isdigit() else None

app = FastAPI(title="piper-tts")

_voices = {}


def get_voice(path):
    if path not in _voices:
        _voices[path] = PiperVoice.load(path)
    return _voices[path]


# Preload the default voice at startup.
try:
    get_voice(DEFAULT_VOICE)
except Exception as e:  # noqa: BLE001
    print(f"[piper] warning: could not preload voice {DEFAULT_VOICE}: {e}")


class SpeakIn(BaseModel):
    text: str
    voice: str | None = None
    speaker: int | None = None


@app.get("/health")
def health():
    return {"ok": True, "voice": os.path.basename(DEFAULT_VOICE), "speaker": DEFAULT_SPEAKER, "loaded": list(_voices.keys())}


@app.post("/speak")
def speak(body: SpeakIn):
    text = (body.text or "").strip()
    if not text:
        return JSONResponse({"ok": False, "error": "empty text"}, status_code=400)
    path = body.voice or DEFAULT_VOICE
    speaker = body.speaker if body.speaker is not None else DEFAULT_SPEAKER
    try:
        voice = get_voice(path)
    except Exception as e:  # noqa: BLE001
        return JSONResponse({"ok": False, "error": f"voice load failed: {e}"}, status_code=500)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        try:
            voice.synthesize(text, wf, speaker_id=speaker)
        except TypeError:
            # Older piper API without speaker_id kwarg.
            voice.synthesize(text, wf)
    return Response(content=buf.getvalue(), media_type="audio/wav")
