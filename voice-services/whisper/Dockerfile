# GPU image: CUDA 12 + cuDNN runtime (faster-whisper needs cuDNN).
FROM nvidia/cuda:12.2.2-cudnn8-runtime-ubuntu22.04

RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-pip ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt ./
RUN pip3 install --no-cache-dir -r requirements.txt

COPY app.py ./

ENV WHISPER_MODEL=small
ENV WHISPER_DEVICE=cuda
ENV WHISPER_COMPUTE=float16
EXPOSE 8100

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8100"]
