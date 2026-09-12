# Voice services (Phase 2) — Whisper STT + Piper TTS

Self-hosted speech services for Rebeca, deployed on **Sadida** (GPU node) and
reachable over the tailnet, just like Ollama.

- Whisper (STT): `http://sadida.stegosaurus-panga.ts.net:8100` — `POST /transcribe`
- Piper (TTS): `http://sadida.stegosaurus-panga.ts.net:8200` — `POST /speak`

## Prerequisites on Sadida

- Docker + Docker Compose.
- **NVIDIA Container Toolkit** (so containers can use the GPU). Quick check:
  `docker run --rm --gpus all nvidia/cuda:12.2.2-base-ubuntu22.04 nvidia-smi`
  If that prints the GPU table, you're set. (This is the infra/GPU layer — coordinate
  with whoever administers Sadida if it's not enabled.)

## 1. Download a Piper voice

Piper needs a voice model (`.onnx`) **and** its config (`.onnx.json`). Spanish voice
example (Mexican Spanish, medium quality):

```bash
cd voice-services
mkdir -p voices && cd voices
BASE=https://huggingface.co/rhasspy/piper-voices/resolve/main/es/es_MX/ald/medium
wget "$BASE/es_MX-ald-medium.onnx"
wget "$BASE/es_MX-ald-medium.onnx.json"
```

Browse other voices at https://huggingface.co/rhasspy/piper-voices/tree/main/es
(e.g. `es_ES-sharvard-medium`, `es_AR-daniela-high`). If you pick another, set
`PIPER_VOICE_FILE` in a `.env` next to the compose file.

## 2. Build & run

```bash
cd voice-services
sudo docker compose -f docker-compose.sadida.yaml up -d --build
```

First run downloads the Whisper model weights (cached in the image/container).

## 3. Test

```bash
# Health
curl http://localhost:8100/health
curl http://localhost:8200/health

# Transcribe an audio file
curl -F "file=@sample.ogg" http://localhost:8100/transcribe

# Synthesize speech to a WAV
curl -X POST http://localhost:8200/speak \
  -H "Content-Type: application/json" \
  -d '{"text":"Hola Sebastian, soy Rebeca."}' --output out.wav
```

From another tailnet node (e.g. Ocra), replace `localhost` with
`sadida.stegosaurus-panga.ts.net`.

## Notes

- `WHISPER_MODEL` can be `base`, `small`, `medium`, or `large-v3`. Bigger = more
  accurate + slower + more VRAM. `small` is a good default for voice notes.
- Ports 8100/8200 are published on Sadida's host, so they're reachable across the
  tailnet by MagicDNS. They are NOT public (no Funnel).
- assistant-core reaches these via `WHISPER_URL` / `PIPER_URL` (wired next).
