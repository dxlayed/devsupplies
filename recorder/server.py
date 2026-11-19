import os
import sys
import time
from pathlib import Path
from typing import Optional
from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.responses import FileResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from recorder import StreamRecorderManager, RECORDINGS_DIR, format_size, normalize_username

app = FastAPI(title="TikTok Live Recorder & Downloader", version="1.0.0")

# Enable CORS for local dev / extensions
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

manager = StreamRecorderManager()

STATIC_DIR = Path(__file__).parent / "static"
STATIC_DIR.mkdir(parents=True, exist_ok=True)


class UsernameRequest(BaseModel):
    username: str


class StopRequest(BaseModel):
    job_id: str


@app.get("/api/status")
def get_system_status():
    return {
        "status": "online",
        "recordings_dir": str(RECORDINGS_DIR),
        "active_jobs_count": len([j for j in manager.jobs.values() if j.status in ["starting", "recording"]]),
        "watchers_count": len(manager.watchers),
    }


@app.post("/api/check-live")
def check_live(req: UsernameRequest):
    if not req.username:
        raise HTTPException(status_code=400, detail="Username is required")
    result = manager.check_live_status(req.username)
    return result


@app.post("/api/record/start")
def start_record(req: UsernameRequest):
    if not req.username:
        raise HTTPException(status_code=400, detail="Username is required")
    job = manager.start_recording(req.username)
    return {"message": "Recording initiated", "job": job.to_dict()}


@app.post("/api/record/stop")
def stop_record(req: StopRequest):
    job = manager.stop_recording(req.job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Recording job not found")
    return {"message": "Recording stopped", "job": job.to_dict()}


@app.get("/api/jobs")
def list_jobs():
    return {"jobs": manager.list_jobs()}


@app.get("/api/recordings/saved")
def list_saved_recordings():
    files_list = []
    if RECORDINGS_DIR.exists():
        for file in sorted(RECORDINGS_DIR.glob("*.*"), key=lambda f: f.stat().st_mtime, reverse=True):
            if file.is_file() and file.suffix.lower() in [".mp4", ".ts", ".flv", ".mkv"]:
                stat = file.stat()
                files_list.append({
                    "filename": file.name,
                    "size_bytes": stat.st_size,
                    "size_human": format_size(stat.st_size),
                    "modified_time": stat.st_mtime,
                    "modified_readable": time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(stat.st_mtime)),
                    "download_url": f"/api/recordings/download/{file.name}",
                    "stream_url": f"/api/recordings/stream/{file.name}",
                })
    return {"files": files_list}


@app.get("/api/recordings/download/{filename}")
def download_recording(filename: str):
    file_path = RECORDINGS_DIR / filename
    if not file_path.exists() or not file_path.is_file():
        raise HTTPException(status_code=404, detail="File not found")
    return FileResponse(
        file_path,
        media_type="video/mp4",
        filename=filename,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'}
    )


@app.get("/api/recordings/stream/{filename}")
def stream_recording(filename: str, request: Request):
    """Serve video with HTTP range support for browser seeking."""
    file_path = RECORDINGS_DIR / filename
    if not file_path.exists() or not file_path.is_file():
        raise HTTPException(status_code=404, detail="File not found")
    return FileResponse(file_path, media_type="video/mp4")


@app.delete("/api/recordings/{filename}")
def delete_recording(filename: str):
    file_path = RECORDINGS_DIR / filename
    if not file_path.exists():
        raise HTTPException(status_code=404, detail="File not found")
    try:
        file_path.unlink()
        return {"status": "deleted", "filename": filename}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to delete file: {e}")


# --- Auto Watchers ---
@app.get("/api/watchers")
def list_watchers():
    return {"watchers": manager.list_watchers()}


@app.post("/api/watchers")
def add_watcher(req: UsernameRequest):
    if not req.username:
        raise HTTPException(status_code=400, detail="Username is required")
    watcher = manager.add_watcher(req.username)
    return {"message": "Auto-recorder watcher added", "watcher": watcher.to_dict()}


@app.delete("/api/watchers/{username}")
def remove_watcher(username: str):
    success = manager.remove_watcher(username)
    if not success:
        raise HTTPException(status_code=404, detail="Watcher not found")
    return {"status": "removed", "username": username}


# Serve static dashboard
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


@app.get("/")
def index():
    index_file = STATIC_DIR / "index.html"
    if index_file.exists():
        return FileResponse(index_file)
    return HTMLResponse("<h1>TikTok Live Recorder Backend is Running</h1><p>Static files missing.</p>")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("server:app", host="127.0.0.1", port=8000, reload=True)
