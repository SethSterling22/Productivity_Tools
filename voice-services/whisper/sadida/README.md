# Whisper on Sadida (native, GPU) — no Docker

Runs faster-whisper on Sadida's GPU as a systemd service, reachable on the tailnet
at `http://sadida.stegosaurus-panga.ts.net:8100` (like Ollama).

Prereqs: healthy NVIDIA driver (already fixed), Python 3.13 + venv, ~1 GB free VRAM.

## 1. Place the app and create the venv

```bash
sudo mkdir -p /opt/whisper-stt && cd /opt/whisper-stt
# copy app.py here (from the repo: voice-services/whisper/app.py), or paste it.
sudo python3 -m venv .venv
sudo .venv/bin/pip install --upgrade pip wheel
```

## 2. Install deps (this is the checkpoint — watch for wheel errors on Python 3.13)

```bash
sudo .venv/bin/pip install \
  faster-whisper fastapi "uvicorn[standard]" python-multipart requests \
  nvidia-cublas-cu12 nvidia-cudnn-cu12
```

If pip cannot find a wheel for `ctranslate2` on Python 3.13, stop and report the
error — we'll pin a version or adjust.

## 3. Quick manual test (GPU)

```bash
cd /opt/whisper-stt
export LD_LIBRARY_PATH=/opt/whisper-stt/.venv/lib/python3.13/site-packages/nvidia/cublas/lib:/opt/whisper-stt/.venv/lib/python3.13/site-packages/nvidia/cudnn/lib
WHISPER_MODEL=small WHISPER_DEVICE=cuda WHISPER_COMPUTE=float16 \
  .venv/bin/uvicorn app:app --host 0.0.0.0 --port 8100
```

In another terminal: `curl http://localhost:8100/health` → should say `device: cuda`.
Watch `nvidia-smi` — a python process should appear using VRAM. Ctrl+C to stop.

## 4. Install as a service

```bash
sudo cp whisper-stt.service /etc/systemd/system/whisper-stt.service
sudo systemctl daemon-reload
sudo systemctl enable --now whisper-stt
systemctl status whisper-stt
journalctl -u whisper-stt -f     # watch startup + model download
```

## 5. Point Rebeca at it (on Ocra)

In `~/Productivity_Tools/n8n/.env`:

```
WHISPER_URL=http://sadida.stegosaurus-panga.ts.net:8100
```

Then recreate assistant-core and stop the now-unused Ocra whisper container:

```bash
cd ~/Productivity_Tools/n8n
sudo docker compose up -d --force-recreate --no-deps assistant-core
sudo docker compose stop whisper       # no longer needed on Ocra
```

## Notes

- VRAM: `small` (float16) ≈ 1 GB; with qwen3:1.7b (~1.8 GB) it fits in the 4 GB card.
  If you hit CUDA OOM, set `WHISPER_MODEL=base` (≈ 0.5 GB) in the service file.
- The `LD_LIBRARY_PATH` points at the pip-installed cuBLAS/cuDNN. If the venv's
  python dir isn't `python3.13`, adjust the path in the service file.
- Port 8100 binds on all interfaces, so it's reachable across the tailnet by
  MagicDNS (not public — no Funnel involved).
