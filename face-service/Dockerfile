FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 MODEL_DIR=/models
WORKDIR /srv

RUN apt-get update && apt-get install -y --no-install-recommends curl unzip ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Pinned model weights, verified by SHA-256.
# SCRFD-10G + ArcFace R50 from InsightFace buffalo_l (non-commercial research licence).
RUN mkdir -p /models && cd /tmp \
 && curl -fsSL -o buffalo_l.zip https://github.com/deepinsight/insightface/releases/download/v0.7/buffalo_l.zip \
 && unzip -q buffalo_l.zip det_10g.onnx w600k_r50.onnx -d /models \
 && rm buffalo_l.zip \
 && echo "5838f7fe053675b1c7a08b633df49e7af5495cee0493c7dcf6697200b85b5b91  /models/det_10g.onnx" | sha256sum -c - \
 && echo "4c06341c33c2ca1f86781dab0e829f88ad5b64be9fba56e56bc9ebdefc619e43  /models/w600k_r50.onnx" | sha256sum -c -

# MiniFASNetV2 anti-spoof (Apache-2.0), converted to ONNX by tools/convert_minifasnet.py
COPY models/minifasnet_v2.onnx /models/minifasnet_v2.onnx
RUN echo "cf065f920212b59522e63e4706ba16a213f1256aac1b454ed04245727d22ec92  /models/minifasnet_v2.onnx" | sha256sum -c -

COPY app/ /srv/app/
WORKDIR /srv/app
RUN useradd -r -u 10001 svc
USER svc
EXPOSE 8080
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8080", "--workers", "1"]
