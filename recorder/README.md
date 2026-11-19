# DevSupplies TikTok Live Recorder & Downloader

A modern local web dashboard to monitor, record, preview, and download TikTok Live streams directly to your computer.

---

## ⚡ Features

1. **🔴 Live Stream Recording**: Capture any TikTok Live stream in real-time in high quality (`.mp4`).
2. **🔎 Instant Live Status Checker**: Quickly check whether a TikTok creator is actively streaming before launching a recording.
3. **👁️ Auto-Watch Mode (Auto-Record)**: Add creators to an automatic background monitor that checks every 45s and automatically begins recording as soon as they go live.
4. **💾 Video Player & File Library**:
   - Preview recorded streams inside the built-in browser player.
   - One-click direct downloads.
   - Live file size and duration tracking.
   - Easy file deletion to manage local disk space.

---

## 🚀 How to Run

### Method 1: One-Click Batch File
Double-click `start.bat` in this folder. It will start the server and automatically open `http://localhost:8000` in your browser.

### Method 2: Command Line
Open a terminal in this folder and run:
```bash
python server.py
```
Then visit:
```
http://localhost:8000
```

---

## 📁 Directory Structure

```
devsupplies/
├── server.py             # FastAPI backend API & static file server
├── recorder.py           # Subprocess stream manager & auto-watcher
├── requirements.txt      # Python dependencies
├── start.bat             # 1-click launcher for Windows
├── static/
│   ├── index.html        # Modern dashboard UI
│   ├── style.css         # Dark cyberpunk / minimalist styling
│   └── app.js            # Frontend logic, real-time polling, and controls
└── recordings/           # Directory where downloaded videos are saved
```
