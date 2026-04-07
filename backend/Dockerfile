FROM python:3.11-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    git \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Pre-download the htdemucs model so first request isn't slow
RUN python -c "import demucs.pretrained; demucs.pretrained.get_model('htdemucs')"

COPY server.py .

RUN mkdir -p uploads stems exports

EXPOSE 8000

CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8000"]
