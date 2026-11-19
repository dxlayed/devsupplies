# DevSupplies — Modern TikTok Live Recorder & Downloader

DevSupplies is a high-speed, 24/7 automated TikTok Live stream recorder and downloader. Capture any TikTok Live stream in crisp 1080p 60FPS video, preview recordings in your browser, and download high-bitrate MP4 files directly to your device.

- **🔴 Real-Time Stream Capture**: Record active TikTok Live streams in pristine source quality with synchronized AAC audio.
- **👁️ 24/7 Background Auto-Watcher**: Monitor your favorite creators continuously; recording starts automatically the second they go live.
- **🔎 Instant Live Status Checker**: Quickly check whether a creator is currently streaming before recording.
- **⚡ Built-in Web Player & Library**: Preview captured videos directly in your browser with direct 1-click MP4 downloads.
- **🔑 Automated Key & Licensing System**: Instant license key issuance with automated Litecoin (LTC) payment confirmation.

---

## 💰 Pricing Tiers

| Tier | Price | Duration | Features |
| :--- | :--- | :--- | :--- |
| **Weekly** | **$5.00** | 7 Days | Full access, 1080p stream capture, Auto-Watcher |
| **Monthly** | **$10.00** | 30 Days | Full access, background auto-record, unlimited downloads |
| **Lifetime** | **$15.00** | Yours Forever | Permanent access, unlimited concurrent recordings, priority updates |

---

## 🚀 How to Run

### 1. Web Service (Full Platform)
```bash
npm install
npm start
```
Default port: `http://localhost:3000` (or `PORT` in `.env`).

### 2. Standalone Python Recorder Engine
Located in `/recorder`:
```bash
cd recorder
pip install -r requirements.txt
python server.py
```
Or double-click `start.bat` on Windows.
Open `http://localhost:8000` to access the local recording control panel.

---

## 📁 Repository Structure

```
├── public/                 # Web client (Landing page, checkout, dashboard, theme)
│   ├── index.html          # Modern cyberpunk landing page
│   ├── checkout.html       # Automated LTC checkout & key issuance
│   ├── dashboard.html      # User license & recorder management
│   ├── devsupplies-recorder.zip # Standalone recorder package
│   └── theme.css           # Glowing violet dark aesthetic
├── recorder/               # Standalone Python TikTok recording engine
│   ├── recorder.py         # Streamlink capture & auto-watcher
│   ├── server.py           # FastAPI local recording API & UI
│   ├── start.bat           # 1-click Windows launcher
│   └── static/             # Local recording web interface
├── src/                    # Node.js Express backend & licensing
│   ├── server.js           # API routes & static file server
│   ├── services/
│   │   ├── keyService.js   # License key generation & tier management
│   │   ├── ltcPayments.js  # Automated BIP32 Litecoin verification
│   │   └── paymentService.js # Order lifecycle management
│   └── database.js         # SQLite database schema
└── package.json
```

---

## 🔒 License & Disclaimer
Not affiliated with or endorsed by TikTok or ByteDance Ltd.
