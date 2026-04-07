"""
Remix Playground Backend
- POST /api/upload → accepts audio file, runs Demucs, returns stem URLs
- POST /api/swap-stem → takes stem + style prompt, calls Lyria RealTime, returns new audio
- GET /api/stems/{job_id}/{stem} → serves separated stem files
- POST /api/export → mixes selected stems into final file
"""

import os
import uuid
import shutil
import subprocess
import asyncio
from pathlib import Path
from typing import Optional
from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parent.parent / ".env")

from fastapi import FastAPI, UploadFile, File, HTTPException, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from google import genai

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
UPLOAD_DIR = Path("uploads")
STEMS_DIR = Path("stems")
EXPORTS_DIR = Path("exports")
for d in [UPLOAD_DIR, STEMS_DIR, EXPORTS_DIR]:
    d.mkdir(exist_ok=True)

GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")

app = FastAPI(title="Remix Playground API")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Serve stem files statically
app.mount("/stems", StaticFiles(directory=str(STEMS_DIR)), name="stems")
app.mount("/exports", StaticFiles(directory=str(EXPORTS_DIR)), name="exports")

# ---------------------------------------------------------------------------
# In-memory job tracker
# ---------------------------------------------------------------------------
jobs: dict = {}

# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------
class SwapRequest(BaseModel):
    job_id: str
    stem: str  # drums, bass, vocals, other, melody (mapped from demucs output)
    style_prompt: str  # e.g. "jazz brushes, swing rhythm, soft dynamics"
    duration_seconds: float = 30.0

class ExportRequest(BaseModel):
    job_id: str
    stem_choices: dict  # { "drums": "jazz", "bass": "original", ... }

class AnalyzeResponse(BaseModel):
    key: str
    bpm: int
    suggestions: list[str]

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
DEMUCS_STEM_MAP = {
    "drums": "drums",
    "bass": "bass",
    "vocals": "vocals",
    "other": "other",  # covers melody, chords, etc.
}

def get_stem_paths(job_id: str) -> dict:
    """Return dict of stem_name -> file_path for a completed job.
    Demucs outputs to: stems/<job_id>/htdemucs/<input_filename_without_ext>/
    We search recursively for the 4 stem WAV files.
    """
    base = STEMS_DIR / job_id
    paths = {}
    expected = {"drums", "bass", "vocals", "other"}
    for f in base.rglob("*.wav"):
        if f.stem in expected:
            paths[f.stem] = str(f)
    return paths


async def run_demucs(file_path: str, job_id: str):
    """Run Demucs htdemucs model to separate stems."""
    output_dir = STEMS_DIR / job_id
    output_dir.mkdir(exist_ok=True)

    cmd = [
        "python", "-m", "demucs",
        "-n", "htdemucs",    # best quality model
        "--out", str(output_dir),
        str(file_path),
    ]

    jobs[job_id]["status"] = "separating"

    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout, stderr = await proc.communicate()

    if proc.returncode != 0:
        jobs[job_id]["status"] = "error"
        jobs[job_id]["error"] = stderr.decode()[-500:]
        return

    # Find the generated stems
    stem_paths = get_stem_paths(job_id)
    jobs[job_id]["stems"] = stem_paths
    jobs[job_id]["status"] = "ready"

    # Analyze with ffprobe for basic info
    try:
        probe_cmd = [
            "ffprobe", "-v", "quiet", "-print_format", "json",
            "-show_format", str(file_path)
        ]
        probe = await asyncio.create_subprocess_exec(
            *probe_cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        probe_out, _ = await probe.communicate()
        import json
        info = json.loads(probe_out.decode())
        duration = float(info.get("format", {}).get("duration", 0))
        jobs[job_id]["duration"] = duration
    except Exception:
        jobs[job_id]["duration"] = 30.0


async def generate_silence(duration_seconds: float, output_path: str):
    """Generate a silent WAV file as fallback."""
    cmd = [
        "ffmpeg", "-y", "-f", "lavfi",
        "-i", f"anullsrc=r=44100:cl=stereo",
        "-t", str(duration_seconds),
        output_path,
    ]
    proc = await asyncio.create_subprocess_exec(*cmd,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
    await proc.communicate()


async def call_lyria_realtime(prompt: str, duration_seconds: float, output_path: str) -> str:
    """
    Call Google Lyria via Gemini API to generate a replacement stem.
    Raises on failure instead of silently falling back.
    """
    if not GEMINI_API_KEY:
        raise HTTPException(503, "No Gemini API key configured — cannot call Lyria")

    import aiohttp
    import base64

    url = "https://generativelanguage.googleapis.com/v1beta/models/lyria-3-clip-preview:generateContent"
    headers = {"Content-Type": "application/json"}
    payload = {
        "contents": [{"parts": [{"text": prompt}]}],
        "generationConfig": {
            "responseModalities": ["AUDIO"],
        },
    }

    async with aiohttp.ClientSession() as session:
        async with session.post(
            f"{url}?key={GEMINI_API_KEY}",
            json=payload, headers=headers,
        ) as resp:
            if resp.status != 200:
                error_text = await resp.text()
                print(f"Lyria API error: {resp.status} - {error_text[:500]}")
                raise HTTPException(502, f"Lyria API error ({resp.status}): {error_text[:300]}")

            data = await resp.json()
            parts = data.get("candidates", [{}])[0].get("content", {}).get("parts", [])
            for part in parts:
                if "inlineData" in part:
                    audio_bytes = base64.b64decode(part["inlineData"]["data"])
                    with open(output_path, "wb") as f:
                        f.write(audio_bytes)
                    return output_path

            raise HTTPException(502, "Lyria returned no audio in response")


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@app.post("/api/upload")
async def upload_song(background_tasks: BackgroundTasks, file: UploadFile = File(...)):
    """Upload a song and kick off Demucs separation."""
    # Validate file type
    allowed = {".mp3", ".wav", ".flac", ".ogg", ".m4a", ".aac"}
    ext = Path(file.filename).suffix.lower()
    if ext not in allowed:
        raise HTTPException(400, f"Unsupported format: {ext}. Use: {', '.join(allowed)}")

    # Save upload
    job_id = str(uuid.uuid4())[:8]
    upload_path = UPLOAD_DIR / f"{job_id}{ext}"
    with open(upload_path, "wb") as f:
        shutil.copyfileobj(file.file, f)

    # Track job
    jobs[job_id] = {
        "status": "uploaded",
        "filename": file.filename,
        "upload_path": str(upload_path),
        "stems": {},
        "swapped": {},
    }

    # Run Demucs in background
    background_tasks.add_task(run_demucs, str(upload_path), job_id)

    return {"job_id": job_id, "status": "processing", "filename": file.filename}


@app.get("/api/status/{job_id}")
async def get_status(job_id: str):
    """Poll for separation status."""
    if job_id not in jobs:
        raise HTTPException(404, "Job not found")

    job = jobs[job_id]
    result = {
        "job_id": job_id,
        "status": job["status"],
        "filename": job.get("filename"),
    }

    if job["status"] == "ready":
        # Build stem URLs
        stem_urls = {}
        for stem_name, file_path in job["stems"].items():
            # Serve relative to stems dir
            rel = Path(file_path).relative_to(STEMS_DIR)
            stem_urls[stem_name] = f"/stems/{rel}"
        result["stems"] = stem_urls
        result["duration"] = job.get("duration", 30)

        # Include any swapped stems
        swapped_urls = {}
        for key, file_path in job.get("swapped", {}).items():
            rel = Path(file_path).relative_to(STEMS_DIR)
            swapped_urls[key] = f"/stems/{rel}"
        result["swapped"] = swapped_urls

    elif job["status"] == "error":
        result["error"] = job.get("error", "Unknown error")

    return result


@app.post("/api/swap-stem")
async def swap_stem(req: SwapRequest):
    """Regenerate a stem with a new style using Lyria RealTime."""
    if req.job_id not in jobs:
        raise HTTPException(404, "Job not found")

    job = jobs[req.job_id]
    if job["status"] != "ready":
        raise HTTPException(400, "Stems not ready yet")

    # Build a focused prompt — emphasize ONLY the target instrument
    stem_instructions = {
        "drums": "ONLY drums and percussion, no melodic instruments, no bass, no vocals, no guitar, no piano",
        "bass": "ONLY bass instrument, no drums, no vocals, no melody, no chords",
        "vocals": "ONLY vocal melody or vocal harmonies, no instruments",
        "other": "ONLY melodic instruments (piano, guitar, synth, strings), no drums, no bass, no vocals",
    }
    isolation = stem_instructions.get(req.stem, f"ONLY {req.stem}, no other instruments")

    prompt = f"""Solo isolated {req.stem} track. Style: {req.style_prompt}.
{isolation}.
This is a single stem meant to be mixed with other separate stems. Keep it clean and isolated."""

    # Output path for the regenerated stem
    swap_id = str(uuid.uuid4())[:6]
    output_path = STEMS_DIR / req.job_id / f"{req.stem}_{swap_id}.wav"
    output_path.parent.mkdir(parents=True, exist_ok=True)

    await call_lyria_realtime(
        prompt=prompt,
        duration_seconds=req.duration_seconds,
        output_path=str(output_path),
    )

    # Track the swap
    swap_key = f"{req.stem}_{req.style_prompt}"
    job["swapped"][swap_key] = str(output_path)

    rel = output_path.relative_to(STEMS_DIR)
    return {
        "stem": req.stem,
        "style": req.style_prompt,
        "url": f"/stems/{rel}",
    }


@app.post("/api/analyze")
async def analyze_song(job_id: str):
    """Use Gemini to analyze the song and suggest remixes."""
    if job_id not in jobs:
        raise HTTPException(404, "Job not found")

    default_response = AnalyzeResponse(
        key="C minor",
        bpm=120,
        suggestions=[
            "Try jazz brushes on drums with upright bass",
            "Go lo-fi: slow it down, add vinyl crackle",
            "Strip it to acoustic guitar and vocals",
            "Add orchestral strings for cinematic feel",
            "Electronic remix with synth bass and arps",
        ]
    )

    if not genai_client:
        return default_response

    try:
        prompt = f"""Analyze this song file: {jobs[job_id]['filename']}
Return JSON with:
- key: detected musical key (e.g. "C minor")
- bpm: estimated tempo
- suggestions: array of 5 creative remix ideas, each a short sentence"""

        response = await asyncio.to_thread(
            genai_client.models.generate_content,
            model="gemini-2.5-flash",
            contents=prompt,
        )
        import json
        text = response.text.strip().removeprefix("```json").removesuffix("```").strip()
        data = json.loads(text)
        return AnalyzeResponse(**data)
    except Exception as e:
        print(f"Analyze failed: {e}")
        return default_response


@app.post("/api/export")
async def export_mix(req: ExportRequest):
    """Mix selected stems (original or swapped) into a single file."""
    if req.job_id not in jobs:
        raise HTTPException(404, "Job not found")

    job = jobs[req.job_id]
    if job["status"] != "ready":
        raise HTTPException(400, "Stems not ready")

    # Collect file paths for each stem
    input_files = []
    for stem_name in ["drums", "bass", "vocals", "other"]:
        style = req.stem_choices.get(stem_name, "original")
        if style != "original":
            swap_key = f"{stem_name}_{style}"
            if swap_key in job["swapped"]:
                input_files.append(job["swapped"][swap_key])
                continue
        # Use original stem
        if stem_name in job["stems"]:
            input_files.append(job["stems"][stem_name])

    if not input_files:
        raise HTTPException(400, "No stems to mix")

    # Mix with ffmpeg
    export_id = str(uuid.uuid4())[:8]
    output_path = EXPORTS_DIR / f"remix_{export_id}.wav"

    # Build ffmpeg command to mix all stems
    cmd = ["ffmpeg", "-y"]
    for f in input_files:
        cmd.extend(["-i", f])

    filter_parts = []
    for i in range(len(input_files)):
        filter_parts.append(f"[{i}:a]")
    filter_str = "".join(filter_parts) + f"amix=inputs={len(input_files)}:duration=longest[out]"

    cmd.extend(["-filter_complex", filter_str, "-map", "[out]", str(output_path)])

    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    await proc.communicate()

    if not output_path.exists():
        raise HTTPException(500, "Export failed")

    rel = output_path.relative_to(EXPORTS_DIR)
    return {"url": f"/exports/{rel}", "filename": f"remix_{export_id}.wav"}


@app.get("/api/health")
async def health():
    """Health check — verifies demucs and ffmpeg are available."""
    checks = {}

    # Check demucs
    try:
        proc = await asyncio.create_subprocess_exec(
            "python", "-m", "demucs", "--help",
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
        await proc.communicate()
        checks["demucs"] = proc.returncode == 0
    except Exception:
        checks["demucs"] = False

    # Check ffmpeg
    try:
        proc = await asyncio.create_subprocess_exec(
            "ffmpeg", "-version",
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
        await proc.communicate()
        checks["ffmpeg"] = proc.returncode == 0
    except Exception:
        checks["ffmpeg"] = False

    checks["lyria"] = bool(GEMINI_API_KEY)

    return {"status": "ok" if all(checks.values()) else "degraded", "checks": checks}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
