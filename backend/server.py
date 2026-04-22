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

@app.on_event("startup")
async def _rehydrate_jobs():
    """Load persisted job metadata back into memory on server start."""
    import json as _json
    for meta_file in STEMS_DIR.glob("*/meta.json"):
        try:
            with open(meta_file) as f:
                meta = _json.load(f)
            job_id = meta.get("job_id")
            if not job_id:
                continue
            stem_paths = {}
            for stem_name, stem_url in meta.get("stems", {}).items():
                # Convert URL back to filesystem path
                path = STEMS_DIR / stem_url.lstrip("/stems/")
                if path.exists():
                    stem_paths[stem_name] = str(path)
            jobs[job_id] = {
                "status": "ready",
                "filename": meta.get("filename"),
                "duration": meta.get("duration"),
                "bpm": meta.get("bpm"),
                "stems": stem_paths,
                "swapped": {},
                "swap_history": meta.get("swap_history", []),
            }
        except Exception as e:
            print(f"[startup] failed to load {meta_file}: {e}")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Serve files statically
app.mount("/stems", StaticFiles(directory=str(STEMS_DIR)), name="stems")
app.mount("/exports", StaticFiles(directory=str(EXPORTS_DIR)), name="exports")
app.mount("/uploads", StaticFiles(directory=str(UPLOAD_DIR)), name="uploads")

# ---------------------------------------------------------------------------
# In-memory job tracker
# ---------------------------------------------------------------------------
jobs: dict = {}

# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------
class YouTubeRequest(BaseModel):
    url: str
    start_seconds: Optional[float] = None
    end_seconds: Optional[float] = None

class SwapRequest(BaseModel):
    job_id: str
    stem: str  # drums, bass, vocals, other, melody (mapped from demucs output)
    style_prompt: str  # e.g. "jazz brushes, swing rhythm, soft dynamics"
    duration_seconds: float = 30.0

class ExportRequest(BaseModel):
    job_id: str
    stem_choices: dict  # { "drums": "jazz", "bass": "original", ... }

class SuggestMatchRequest(BaseModel):
    job_id: str
    keywords: Optional[str] = ""

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

    # Detect BPM with librosa
    try:
        import librosa
        y, sr = librosa.load(file_path, sr=None, mono=True)
        tempo, _ = librosa.beat.beat_track(y=y, sr=sr)
        bpm = round(float(tempo[0]) if hasattr(tempo, '__len__') else float(tempo))
        jobs[job_id]["bpm"] = bpm
    except Exception as e:
        print(f"BPM detection failed: {e}")
        jobs[job_id]["bpm"] = None

    # Save job metadata to disk for library
    _save_job_meta(job_id)


def _save_job_meta(job_id: str):
    """Persist job metadata to a JSON file so the library survives restarts."""
    import json as _json
    job = jobs[job_id]
    meta = {
        "job_id": job_id,
        "filename": job.get("filename"),
        "duration": job.get("duration"),
        "bpm": job.get("bpm"),
        "status": job.get("status"),
        "stems": {},
        "swap_history": job.get("swap_history", []),
    }
    # Build stem URLs
    for stem_name, file_path in job.get("stems", {}).items():
        rel = Path(file_path).relative_to(STEMS_DIR)
        meta["stems"][stem_name] = f"/stems/{rel}"
    meta_path = STEMS_DIR / job_id / "meta.json"
    meta_path.parent.mkdir(parents=True, exist_ok=True)
    with open(meta_path, "w") as f:
        _json.dump(meta, f)


def _load_library() -> list:
    """Load all saved job metadata from disk."""
    import json as _json
    library = []
    for meta_file in STEMS_DIR.glob("*/meta.json"):
        try:
            with open(meta_file) as f:
                library.append(_json.load(f))
        except Exception:
            pass
    library.sort(key=lambda x: meta_file.stat().st_mtime, reverse=True)
    return library


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
                    mime = part["inlineData"].get("mimeType", "")
                    # Lyria returns MP3 — convert to WAV for consistent playback
                    if "mpeg" in mime or "mp3" in mime:
                        tmp_mp3 = output_path + ".mp3"
                        with open(tmp_mp3, "wb") as f:
                            f.write(audio_bytes)
                        conv = await asyncio.create_subprocess_exec(
                            "ffmpeg", "-y", "-i", tmp_mp3, "-ar", "44100", "-ac", "2", output_path,
                            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
                        )
                        await conv.communicate()
                        os.remove(tmp_mp3)
                    else:
                        with open(output_path, "wb") as f:
                            f.write(audio_bytes)
                    return output_path

            raise HTTPException(502, "Lyria returned no audio in response")


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@app.get("/api/library")
async def get_library():
    """Return all saved stem sessions."""
    return _load_library()


@app.get("/api/swap-history")
async def get_swap_history():
    """Return all available stems across all jobs, grouped by stem type.
    Includes original Demucs stems and any Lyria-generated swaps."""
    lib = _load_library()
    history = {"drums": [], "bass": [], "vocals": [], "other": []}
    seen = set()

    for item in lib:
        song_name = item.get("filename", "Unknown")

        # Include original Demucs stems from each song
        for stem_name, stem_url in item.get("stems", {}).items():
            key = f"{stem_name}_original_{stem_url}"
            if key not in seen:
                seen.add(key)
                history.setdefault(stem_name, []).append({
                    "style": f"Original",
                    "url": stem_url,
                    "from_song": song_name,
                })

        # Include Lyria-generated swaps
        for swap in item.get("swap_history", []):
            key = f"{swap['stem']}_{swap['style']}_{swap['url']}"
            if key not in seen:
                seen.add(key)
                history.setdefault(swap["stem"], []).append({
                    "style": swap["style"],
                    "url": swap["url"],
                    "from_song": song_name,
                })

    return history


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


@app.post("/api/youtube")
async def youtube_download(req: YouTubeRequest):
    """Download audio from YouTube — returns audio URL for preview. Does NOT run Demucs yet."""
    job_id = str(uuid.uuid4())[:8]
    output_path = UPLOAD_DIR / f"{job_id}.mp3"

    # Download audio with yt-dlp
    cmd = [
        "yt-dlp",
        "-x", "--audio-format", "mp3",
        "--no-playlist",
        "-o", str(output_path),
        req.url,
    ]

    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout, stderr = await proc.communicate()

    if proc.returncode != 0:
        raise HTTPException(400, f"yt-dlp failed: {stderr.decode()[-300:]}")

    # yt-dlp may add extra extension — find the actual file
    actual = None
    for f in UPLOAD_DIR.glob(f"{job_id}*"):
        actual = f
        break
    if not actual or not actual.exists():
        raise HTTPException(500, "Download failed — no output file")

    # Get title
    title = "YouTube audio"
    try:
        info_cmd = ["yt-dlp", "--get-title", "--no-playlist", req.url]
        info_proc = await asyncio.create_subprocess_exec(
            *info_cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
        info_out, _ = await info_proc.communicate()
        if info_out:
            title = info_out.decode().strip()[:80]
    except Exception:
        pass

    # Get duration
    duration = 0
    try:
        probe_cmd = ["ffprobe", "-v", "quiet", "-print_format", "json", "-show_format", str(actual)]
        probe = await asyncio.create_subprocess_exec(
            *probe_cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
        probe_out, _ = await probe.communicate()
        import json as _json
        info = _json.loads(probe_out.decode())
        duration = float(info.get("format", {}).get("duration", 0))
    except Exception:
        pass

    # Track job (not started yet)
    rel = actual.relative_to(UPLOAD_DIR)
    jobs[job_id] = {
        "status": "downloaded",
        "filename": f"{title}.mp3",
        "upload_path": str(actual),
        "stems": {},
        "swapped": {},
        "duration": duration,
    }

    return {
        "job_id": job_id,
        "status": "downloaded",
        "filename": f"{title}.mp3",
        "audio_url": f"/uploads/{rel}",
        "duration": duration,
    }


class TrimAndProcessRequest(BaseModel):
    job_id: str
    start_seconds: Optional[float] = None
    end_seconds: Optional[float] = None


@app.post("/api/trim-and-process")
async def trim_and_process(req: TrimAndProcessRequest, background_tasks: BackgroundTasks):
    """Trim a downloaded audio file and kick off Demucs."""
    if req.job_id not in jobs:
        raise HTTPException(404, "Job not found")

    job = jobs[req.job_id]
    actual = Path(job["upload_path"])

    if not actual.exists():
        raise HTTPException(400, "Audio file not found")

    # Trim if start/end specified
    if req.start_seconds is not None or req.end_seconds is not None:
        trimmed_path = UPLOAD_DIR / f"{req.job_id}_trimmed.mp3"
        trim_cmd = ["ffmpeg", "-y", "-i", str(actual)]
        if req.start_seconds is not None:
            trim_cmd.extend(["-ss", str(req.start_seconds)])
        if req.end_seconds is not None:
            trim_cmd.extend(["-to", str(req.end_seconds)])
        trim_cmd.extend(["-c", "copy", str(trimmed_path)])

        proc = await asyncio.create_subprocess_exec(
            *trim_cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        await proc.communicate()
        if trimmed_path.exists():
            actual = trimmed_path
            job["upload_path"] = str(actual)

    job["status"] = "uploaded"
    background_tasks.add_task(run_demucs, str(actual), req.job_id)

    return {"job_id": req.job_id, "status": "processing", "filename": job["filename"]}


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
        result["bpm"] = job.get("bpm")
        result["swap_history"] = job.get("swap_history", [])

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

    # Add to swap history
    if "swap_history" not in job:
        job["swap_history"] = []
    rel = output_path.relative_to(STEMS_DIR)
    job["swap_history"].append({
        "stem": req.stem,
        "style": req.style_prompt,
        "url": f"/stems/{rel}",
    })

    # Update persisted metadata
    _save_job_meta(job_id=req.job_id)

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


async def _search_youtube_by_bpm(bpm: int, limit: int = 8, keywords: str = "") -> list:
    """Use yt-dlp to search YouTube for songs at a given BPM."""
    kw = f" {keywords.strip()}" if keywords and keywords.strip() else ""
    queries = [
        f"{bpm} bpm{kw} songs",
        f"{bpm} bpm{kw} music",
    ]
    results = []
    seen_urls = set()

    for query in queries:
        if len(results) >= limit:
            break
        cmd = [
            "yt-dlp", f"ytsearch{limit * 2}:{query}",
            "--match-filter", "duration < 300",
            "--print", "%(title)s|||%(webpage_url)s",
            "--flat-playlist", "--no-warnings", "--no-playlist",
        ]
        proc = await asyncio.create_subprocess_exec(
            *cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE
        )
        stdout, _ = await proc.communicate()
        for line in stdout.decode().strip().splitlines():
            if "|||" not in line:
                continue
            title, url = line.split("|||", 1)
            if url in seen_urls or not url.startswith("https://www.youtube.com"):
                continue
            seen_urls.add(url)
            results.append({"title": title.strip(), "artist": "", "bpm": bpm, "youtube_url": url.strip()})
            if len(results) >= limit:
                break

    print(f"[yt-search] found {len(results)} results for bpm={bpm}")
    return results


@app.post("/api/suggest-match")
async def suggest_match(req: SuggestMatchRequest):
    """Find BPM-matched songs via Tunebat and resolve YouTube URLs."""
    import json as _json
    bpm = None
    if req.job_id in jobs:
        bpm = jobs[req.job_id].get("bpm")
    if not bpm:
        # Fall back to persisted metadata
        meta_path = STEMS_DIR / req.job_id / "meta.json"
        if meta_path.exists():
            with open(meta_path) as f:
                bpm = _json.load(f).get("bpm")
    if not bpm:
        raise HTTPException(400, "BPM not found — reload the song first")

    suggestions = await _search_youtube_by_bpm(bpm, keywords=req.keywords or "")
    if not suggestions:
        raise HTTPException(404, "No results found — try again")

    return {"bpm": bpm, "suggestions": suggestions}


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
