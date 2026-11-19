import os
import sys
import time
import subprocess
import threading
from pathlib import Path
from typing import Dict, Optional, List

RECORDINGS_DIR = Path(__file__).parent / "recordings"
RECORDINGS_DIR.mkdir(parents=True, exist_ok=True)


def normalize_username(user_input: str) -> str:
    """Extract clean username from @handle or URL."""
    clean = user_input.strip()
    if "tiktok.com/@" in clean:
        parts = clean.split("tiktok.com/@")[1].split("/")[0].split("?")[0]
        return parts.strip().lstrip("@")
    return clean.lstrip("@").strip()


class RecordingJob:
    def __init__(self, username: str, output_format: str = "mp4"):
        self.username = normalize_username(username)
        self.job_id = f"{self.username}_{int(time.time())}"
        self.filename = f"{self.job_id}.{output_format}"
        self.filepath = RECORDINGS_DIR / self.filename
        self.start_time = time.time()
        self.end_time: Optional[float] = None
        self.status = "starting"  # starting, recording, stopped, finished, error
        self.error_message: Optional[str] = None
        self.process: Optional[subprocess.Popen] = None
        self.bytes_written = 0

    def to_dict(self):
        duration = (self.end_time or time.time()) - self.start_time
        current_size = 0
        if self.filepath.exists():
            try:
                current_size = self.filepath.stat().st_size
            except OSError:
                current_size = self.bytes_written

        return {
            "job_id": self.job_id,
            "username": self.username,
            "filename": self.filename,
            "status": self.status,
            "start_time": self.start_time,
            "duration_seconds": int(duration),
            "file_size_bytes": current_size,
            "file_size_human": format_size(current_size),
            "error_message": self.error_message,
        }


class WatcherTarget:
    def __init__(self, username: str, check_interval: int = 45):
        self.username = normalize_username(username)
        self.check_interval = check_interval
        self.active = True
        self.last_checked: Optional[float] = None
        self.is_live = False
        self.current_job_id: Optional[str] = None

    def to_dict(self):
        return {
            "username": self.username,
            "active": self.active,
            "last_checked": self.last_checked,
            "is_live": self.is_live,
            "current_job_id": self.current_job_id,
        }


class StreamRecorderManager:
    def __init__(self):
        self.jobs: Dict[str, RecordingJob] = {}
        self.watchers: Dict[str, WatcherTarget] = {}
        self._lock = threading.Lock()
        self._watcher_thread = threading.Thread(target=self._watcher_loop, daemon=True)
        self._watcher_thread.start()

    def check_live_status(self, username: str) -> dict:
        """Check if TikTok user is currently live using streamlink."""
        user = normalize_username(username)
        url = f"https://www.tiktok.com/@{user}/live"
        cmd = [
            sys.executable,
            "-m",
            "streamlink",
            "--json",
            url,
        ]
        try:
            res = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=20,
            )
            # If streamlink finds streams, json output contains streams
            stdout = res.stdout.strip()
            stderr = res.stderr.strip()
            is_live = False
            if '"streams":' in stdout or '"best":' in stdout:
                is_live = True

            offline_keywords = ["offline", "No playable streams", "not currently live", "error"]
            if any(k in stderr.lower() or k in stdout.lower() for k in ["offline", "no playable streams"]):
                is_live = False

            return {
                "username": user,
                "is_live": is_live,
                "url": url,
                "message": "User is LIVE!" if is_live else "User is currently offline."
            }
        except subprocess.TimeoutExpired:
            return {"username": user, "is_live": False, "error": "Request timed out checking live status"}
        except Exception as e:
            return {"username": user, "is_live": False, "error": str(e)}

    def start_recording(self, username: str) -> RecordingJob:
        user = normalize_username(username)
        with self._lock:
            # Check if there is already an active recording for this user
            for job in self.jobs.values():
                if job.username.lower() == user.lower() and job.status in ["starting", "recording"]:
                    return job

            job = RecordingJob(user)
            self.jobs[job.job_id] = job

        # Launch recording thread
        t = threading.Thread(target=self._run_streamlink_job, args=(job,), daemon=True)
        t.start()
        return job

    def stop_recording(self, job_id: str) -> Optional[RecordingJob]:
        with self._lock:
            job = self.jobs.get(job_id)
            if not job:
                return None

        if job.process and job.process.poll() is None:
            try:
                # On Windows, try SIGINT/CTRL_BREAK or terminate
                job.process.terminate()
                try:
                    job.process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    job.process.kill()
            except Exception as e:
                print(f"[Recorder] Error stopping job {job_id}: {e}")

        job.status = "stopped"
        job.end_time = time.time()
        return job

    def _run_streamlink_job(self, job: RecordingJob):
        url = f"https://www.tiktok.com/@{job.username}/live"
        cmd = [
            sys.executable,
            "-m",
            "streamlink",
            "--loglevel", "info",
            "--force",
            url,
            "best",
            "-o",
            str(job.filepath),
        ]

        try:
            # Windows creation flags to allow graceful handling
            creation_flags = 0
            if sys.platform == "win32":
                creation_flags = subprocess.CREATE_NEW_PROCESS_GROUP

            proc = subprocess.Popen(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                creationflags=creation_flags,
                bufsize=1,
            )
            job.process = proc

            # Read initial output to determine if stream started
            recording_started = False
            for _ in range(30):
                if proc.poll() is not None:
                    break
                # Check if file has appeared and has data
                if job.filepath.exists() and job.filepath.stat().st_size > 0:
                    recording_started = True
                    job.status = "recording"
                    break
                time.sleep(1)

            if proc.poll() is not None and not recording_started:
                # Failed early
                out = proc.stdout.read() if proc.stdout else ""
                job.status = "error"
                job.error_message = out.strip()[-300:] if out else "Channel appears offline or stream failed to open"
                job.end_time = time.time()
                return

            job.status = "recording"

            # Monitor until stream ends
            proc.wait()
            job.end_time = time.time()
            if job.status == "recording":
                job.status = "finished"

        except Exception as e:
            job.status = "error"
            job.error_message = str(e)
            job.end_time = time.time()

    def get_job(self, job_id: str) -> Optional[RecordingJob]:
        return self.jobs.get(job_id)

    def list_jobs(self) -> List[dict]:
        with self._lock:
            # Update file sizes
            return [job.to_dict() for job in reversed(list(self.jobs.values()))]

    # --- Auto-Record Watcher ---
    def add_watcher(self, username: str) -> WatcherTarget:
        user = normalize_username(username)
        with self._lock:
            if user not in self.watchers:
                self.watchers[user] = WatcherTarget(user)
            else:
                self.watchers[user].active = True
            return self.watchers[user]

    def remove_watcher(self, username: str) -> bool:
        user = normalize_username(username)
        with self._lock:
            if user in self.watchers:
                del self.watchers[user]
                return True
        return False

    def list_watchers(self) -> List[dict]:
        with self._lock:
            return [w.to_dict() for w in self.watchers.values()]

    def _watcher_loop(self):
        while True:
            time.sleep(15)
            with self._lock:
                targets = [w for w in self.watchers.values() if w.active]

            for target in targets:
                try:
                    # If already recording, check if job is still going
                    if target.current_job_id:
                        job = self.jobs.get(target.current_job_id)
                        if job and job.status in ["starting", "recording"]:
                            continue
                        else:
                            target.current_job_id = None
                            target.is_live = False

                    # Check live status
                    status = self.check_live_status(target.username)
                    target.last_checked = time.time()
                    target.is_live = status.get("is_live", False)

                    if target.is_live and not target.current_job_id:
                        print(f"[Watcher] Auto-starting recording for @{target.username}!")
                        job = self.start_recording(target.username)
                        target.current_job_id = job.job_id
                except Exception as e:
                    print(f"[Watcher] Error monitoring @{target.username}: {e}")


def format_size(size_bytes: int) -> str:
    """Convert bytes to human-readable format."""
    if size_bytes < 1024:
        return f"{size_bytes} B"
    elif size_bytes < 1024 * 1024:
        return f"{size_bytes / 1024:.1f} KB"
    elif size_bytes < 1024 * 1024 * 1024:
        return f"{size_bytes / (1024 * 1024):.1f} MB"
    else:
        return f"{size_bytes / (1024 * 1024 * 1024):.2f} GB"
