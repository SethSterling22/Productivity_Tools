# Piper runs fine on CPU (fast). Voice models are mounted at /voices.
FROM python:3.11-slim

WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py ./

ENV PIPER_VOICE=/voices/es_MX-ald-medium.onnx
EXPOSE 8200

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8200"]
