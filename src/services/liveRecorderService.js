const https = require('https');
const http = require('http');
const { spawn, exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const db = require('../database');

const RECORDINGS_DIR = path.join(__dirname, '..', '..', 'public', 'recordings');
try { fs.mkdirSync(RECORDINGS_DIR, { recursive: true }); } catch (e) {}

function cleanUsername(raw) {
  let clean = String(raw || '').trim();
  if (clean.includes('tiktok.com/@')) {
    clean = clean.split('tiktok.com/@')[1].split('/')[0].split('?')[0];
  }
  return clean.replace(/^@/, '').trim();
}

function formatSize(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

function formatDuration(seconds) {
  if (!seconds || seconds <= 0) return '0:00';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  if (mins >= 60) {
    const hrs = Math.floor(mins / 60);
    const remMins = mins % 60;
    return `${hrs}:${String(remMins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

function getFlvDimensions(filePath) {
  try {
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(4096);
    fs.readSync(fd, buf, 0, 4096, 0);
    fs.closeSync(fd);
    const str = buf.toString('latin1');
    const wIdx = str.indexOf('width');
    const hIdx = str.indexOf('height');
    if (wIdx !== -1 && hIdx !== -1) {
      const width = buf.readDoubleBE(wIdx + 6);
      const height = buf.readDoubleBE(hIdx + 7);
      if (width > 0 && height > 0) return { width: Math.round(width), height: Math.round(height) };
    }
  } catch (e) {}
  return null;
}

function getFfmpegBinary() {
  try {
    const ffmpegPkg = require('@ffmpeg-installer/ffmpeg');
    if (ffmpegPkg && ffmpegPkg.path && fs.existsSync(ffmpegPkg.path)) {
      return ffmpegPkg.path;
    }
  } catch (e) {}

  const candidates = [
    'ffmpeg',
    '/root/.nix-profile/bin/ffmpeg',
    '/nix/var/nix/profiles/default/bin/ffmpeg',
    '/usr/bin/ffmpeg',
    '/usr/local/bin/ffmpeg'
  ];
  for (const bin of candidates) {
    try {
      require('child_process').execSync(`${bin} -version`, { timeout: 1500, stdio: 'ignore' });
      return bin;
    } catch (e) {}
  }
  return null;
}

function remuxToMp4(rawFlvPath, targetMp4Path, orientation = 'portrait') {
  return new Promise((resolve) => {
    const ffmpegBin = getFfmpegBinary();
    if (!ffmpegBin) {
      console.warn('[remuxToMp4] No ffmpeg binary found, copying raw file');
      try {
        if (rawFlvPath !== targetMp4Path && fs.existsSync(rawFlvPath)) {
          fs.copyFileSync(rawFlvPath, targetMp4Path);
        }
      } catch (e) {}
      return resolve({ success: false, reason: 'ffmpeg_not_installed' });
    }

    const dims = getFlvDimensions(rawFlvPath);
    let args = [];

    if (orientation === 'landscape') {
      // Landscape/original: fast stream copy to MP4
      args = ['-y', '-i', rawFlvPath, '-c', 'copy', '-movflags', '+faststart', targetMp4Path];
    } else {
      // Portrait (9:16)
      if (dims && dims.height > dims.width) {
        // Stream is already native 9:16 portrait (e.g. 720x1280 vertical phone stream)
        args = ['-y', '-i', rawFlvPath, '-c', 'copy', '-movflags', '+faststart', targetMp4Path];
      } else {
        // Stream is landscape or square (e.g. 720x720, 1280x720)
        // Pad to standard 720:1280 vertical portrait (9:16) with black letterbox top & bottom
        args = [
          '-y',
          '-i', rawFlvPath,
          '-vf', 'scale=w=720:h=1280:force_original_aspect_ratio=decrease,pad=720:1280:(ow-iw)/2:(oh-ih)/2:black',
          '-c:v', 'libx264',
          '-preset', 'ultrafast',
          '-crf', '22',
          '-c:a', 'aac',
          '-movflags', '+faststart',
          targetMp4Path
        ];
      }
    }

    const proc = spawn(ffmpegBin, args);
    proc.on('close', (code) => {
      if (code === 0 && fs.existsSync(targetMp4Path) && fs.statSync(targetMp4Path).size > 0) {
        try { fs.unlinkSync(rawFlvPath); } catch (e) {}
        resolve({ success: true, orientation });
      } else {
        console.warn(`[remuxToMp4] FFmpeg exited with code ${code}, falling back to copy`);
        try {
          if (!fs.existsSync(targetMp4Path) && fs.existsSync(rawFlvPath)) {
            fs.copyFileSync(rawFlvPath, targetMp4Path);
          }
        } catch (e) {}
        resolve({ success: false, reason: 'ffmpeg_exit_' + code });
      }
    });
    proc.on('error', (procErr) => {
      console.error('[remuxToMp4] Process error:', procErr.message);
      try {
        if (!fs.existsSync(targetMp4Path) && fs.existsSync(rawFlvPath)) {
          fs.copyFileSync(rawFlvPath, targetMp4Path);
        }
      } catch (e) {}
      resolve({ success: false, reason: procErr.message });
    });
  });
}

class LiveRecorderService {
  constructor() {
    this.activeJobs = new Map(); // jobId -> job details
    this.scanAndRemuxLegacy().catch(() => {});
  }

  async scanAndRemuxLegacy() {
    try {
      const files = fs.readdirSync(RECORDINGS_DIR);
      for (const file of files) {
        if (file.endsWith('.mp4')) {
          const fullPath = path.join(RECORDINGS_DIR, file);
          try {
            const fd = fs.openSync(fullPath, 'r');
            const header = Buffer.alloc(4);
            fs.readSync(fd, header, 0, 4, 0);
            fs.closeSync(fd);
            if (header.toString('utf8', 0, 3) === 'FLV') {
              console.log(`[LiveRecorder] Remuxing legacy FLV recording to portrait MP4: ${file}`);
              const tempRaw = path.join(RECORDINGS_DIR, file.replace('.mp4', '_temp.flv'));
              fs.renameSync(fullPath, tempRaw);
              await remuxToMp4(tempRaw, fullPath, 'portrait');
            }
          } catch (err) {}
        }
      }
    } catch (e) {}
  }

  /**
   * Fast, reliable live status check using TikTok's official Web API
   * status 2 = LIVE, status 4 = OFFLINE
   */
  async checkStatus(rawUsername) {
    const user = cleanUsername(rawUsername);
    if (!user) return { username: '', is_live: false, message: 'Invalid username' };

    // Method 1: Official api-live/user/room endpoint
    try {
      const apiUrl = `https://www.tiktok.com/api-live/user/room?aid=1988&sourceType=54&staleTime=600000&uniqueId=${encodeURIComponent(user.toLowerCase())}`;
      const res = await fetch(apiUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
          'Referer': `https://www.tiktok.com/@${user}/live`,
          'Accept': 'application/json, text/plain, */*'
        },
        signal: AbortSignal.timeout(8000)
      });

      if (res.ok) {
        const json = await res.json().catch(() => null);
        if (json && json.data) {
          const room = json.data.liveRoom;
          const u = json.data.user;
          const status = room?.status;

          // In TikTok API: status 2 is LIVE, status 4 is OFFLINE
          const isLive = status === 2;
          let streamUrl = null;

          if (room?.streamData?.pull_data?.stream_data) {
            try {
              const streamJson = JSON.parse(room.streamData.pull_data.stream_data);
              const qualities = streamJson.data || {};
              for (const q of ['origin', 'uhd_60', 'hd_60', 'hd', 'sd', 'ld']) {
                if (qualities[q]?.main?.flv) {
                  streamUrl = qualities[q].main.flv;
                  break;
                }
              }
            } catch (e) {}
          }

          return {
            username: u?.uniqueId || user,
            nickname: u?.nickname || user,
            avatar: u?.avatarLarger || u?.avatarThumb || null,
            title: room?.title || 'Live Stream',
            is_live: isLive,
            status_code: status,
            stream_url: streamUrl,
            message: isLive ? `@${user} is LIVE right now!` : `@${user} is currently offline.`
          };
        }
      }
    } catch (err) {
      console.warn('[LiveCheck] API endpoint check error:', err.message);
    }

    // Method 2: HTML Page Fallback
    try {
      const pageUrl = `https://www.tiktok.com/@${encodeURIComponent(user)}/live`;
      const resPage = await fetch(pageUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
        },
        signal: AbortSignal.timeout(8000)
      });

      if (resPage.ok) {
        const html = await resPage.text();
        const isOffline = html.includes('"status":4') || html.includes('"status": 4') || html.includes('not currently live');
        const isLive = !isOffline && (html.includes('"status":2') || html.includes('"status": 2') || (html.includes('liveRoom') && html.includes('room_id')));

        return {
          username: user,
          is_live: isLive,
          status_code: isLive ? 2 : 4,
          url: pageUrl,
          message: isLive ? `@${user} is LIVE right now!` : `@${user} is currently offline.`
        };
      }
    } catch (err) {
      console.warn('[LiveCheck] HTML fallback check error:', err.message);
    }

    return {
      username: user,
      is_live: false,
      status_code: 4,
      message: `@${user} is currently offline.`
    };
  }

  async startRecording(userId, username, orientation = 'portrait') {
    const user = cleanUsername(username);
    if (!user) throw new Error('Valid username required');

    // Check if job already active for this username
    for (const [id, j] of this.activeJobs.entries()) {
      if (j.username.toLowerCase() === user.toLowerCase() && j.status === 'recording') {
        return this.formatJob(j);
      }
    }

    // Check live status to get stream info
    const statusInfo = await this.checkStatus(user);
    if (!statusInfo.is_live && !statusInfo.stream_url) {
      throw new Error(`@${user} is currently offline. The streamer must be live to start recording.`);
    }

    const timestamp = Date.now();
    const jobId = `${user}_${timestamp}`;
    const rawFilename = `${jobId}_raw.flv`;
    const rawPath = path.join(RECORDINGS_DIR, rawFilename);
    const filename = `${jobId}.mp4`;
    const filePath = path.join(RECORDINGS_DIR, filename);

    const job = {
      jobId,
      userId: userId || null,
      username: user,
      orientation: orientation || 'portrait',
      title: statusInfo.title || `Live Stream (@${user})`,
      filename,
      filePath,
      rawPath,
      streamUrl: statusInfo.stream_url,
      startTime: Date.now(),
      bytesWritten: 0,
      status: 'recording',
      error: null,
      httpReq: null,
      fileStream: null
    };

    // If direct stream URL is found, stream directly over HTTP into the raw file
    if (job.streamUrl) {
      try {
        const fileStream = fs.createWriteStream(rawPath);
        job.fileStream = fileStream;

        const client = job.streamUrl.startsWith('https') ? https : http;
        const req = client.get(job.streamUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
            'Referer': `https://www.tiktok.com/@${user}/live`
          }
        }, res => {
          res.on('data', chunk => {
            job.bytesWritten += chunk.length;
          });
          res.pipe(fileStream);

          res.on('end', () => {
            if (this.activeJobs.has(jobId)) {
              this.finishJob(jobId);
            }
          });
          res.on('error', err => {
            job.error = err.message;
            if (this.activeJobs.has(jobId)) {
              this.finishJob(jobId);
            }
          });
        });

        req.on('error', err => {
          job.error = err.message;
        });

        job.httpReq = req;
      } catch (e) {
        console.error('Error starting HTTP stream capture:', e);
      }
    } else {
      // Fallback: spawn streamlink if available
      try {
        const url = `https://www.tiktok.com/@${user}/live`;
        const proc = spawn('python', ['-m', 'streamlink', '--loglevel', 'info', '--force', url, 'best', '-o', rawPath], {
          windowsHide: true
        });
        job.process = proc;
        proc.on('close', () => {
          if (this.activeJobs.has(jobId)) this.finishJob(jobId);
        });
      } catch (e) {
        console.error('Streamlink spawn error:', e);
      }
    }

    this.activeJobs.set(jobId, job);
    return this.formatJob(job);
  }

  async stopRecording(jobId) {
    const job = this.activeJobs.get(jobId);
    if (!job) throw new Error('Recording job not found');

    if (job.httpReq) {
      try {
        job.httpReq.destroy();
      } catch (e) {}
    }
    if (job.fileStream) {
      try {
        job.fileStream.end();
      } catch (e) {}
    }
    if (job.process && !job.process.killed) {
      try {
        if (process.platform === 'win32') {
          exec(`taskkill /pid ${job.process.pid} /t /f`);
        } else {
          job.process.kill('SIGTERM');
        }
      } catch (e) {}
    }

    // Wait brief tick for file write stream to flush
    await new Promise(r => setTimeout(r, 600));

    return await this.finishJob(jobId);
  }

  async finishJob(jobId) {
    const job = this.activeJobs.get(jobId);
    if (!job) return null;

    job.status = 'finished';
    this.activeJobs.delete(jobId);

    // Convert raw FLV stream to genuine MP4 in requested orientation
    if (job.rawPath && fs.existsSync(job.rawPath)) {
      try {
        await remuxToMp4(job.rawPath, job.filePath, job.orientation || 'portrait');
      } catch (err) {
        console.error('Error during remuxToMp4:', err);
      }
    }

    let fileSize = job.bytesWritten || 0;
    try {
      if (fs.existsSync(job.filePath)) {
        fileSize = fs.statSync(job.filePath).size;
      }
    } catch (e) {}

    const durationSeconds = Math.max(1, Math.round((Date.now() - job.startTime) / 1000));

    // Save to database
    let savedRow = null;
    try {
      const res = await db.run(
        `INSERT INTO recordings (user_id, username, title, filename, file_path, file_size_bytes, duration_seconds)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [job.userId, job.username, job.title || `Live Stream (@${job.username})`, job.filename, job.filePath, fileSize, durationSeconds]
      );
      savedRow = await db.get(`SELECT * FROM recordings WHERE id = ?`, [res.lastID]);
    } catch (err) {
      console.error('Error inserting recording record:', err);
    }

    return {
      jobId: job.jobId,
      id: savedRow ? savedRow.id : null,
      username: job.username,
      title: job.title,
      filename: job.filename,
      downloadUrl: `/recordings/${job.filename}`,
      fileSize,
      fileSizeFormatted: formatSize(fileSize),
      durationSeconds,
      durationFormatted: formatDuration(durationSeconds),
      status: 'finished'
    };
  }

  getActiveJobs(userId = null) {
    const list = [];
    for (const [id, job] of this.activeJobs.entries()) {
      if (!userId || job.userId === userId) {
        list.push(this.formatJob(job));
      }
    }
    return list;
  }

  formatJob(job) {
    let currentSize = job.bytesWritten || 0;
    try {
      if (fs.existsSync(job.filePath)) {
        currentSize = fs.statSync(job.filePath).size;
      } else if (job.rawPath && fs.existsSync(job.rawPath)) {
        currentSize = fs.statSync(job.rawPath).size;
      }
    } catch (e) {}

    const elapsed = Math.round((Date.now() - job.startTime) / 1000);
    return {
      jobId: job.jobId,
      username: job.username,
      title: job.title,
      filename: job.filename,
      startTime: job.startTime,
      elapsedSeconds: elapsed,
      durationFormatted: formatDuration(elapsed),
      fileSizeBytes: currentSize,
      fileSizeFormatted: formatSize(currentSize),
      status: job.status,
      error: job.error
    };
  }

  async getRecordings(userId = null) {
    let sql = `SELECT * FROM recordings`;
    const params = [];
    if (userId) {
      sql += ` WHERE user_id = ? OR user_id IS NULL`;
      params.push(userId);
    }
    sql += ` ORDER BY id DESC LIMIT 50`;

    const rows = await db.all(sql, params);
    return rows.map(r => ({
      id: r.id,
      username: r.username,
      title: r.title || `Live Stream`,
      filename: r.filename,
      downloadUrl: `/recordings/${r.filename}`,
      fileSizeBytes: r.file_size_bytes,
      fileSizeFormatted: formatSize(r.file_size_bytes),
      durationSeconds: r.duration_seconds,
      durationFormatted: formatDuration(r.duration_seconds),
      createdAt: r.created_at,
      dateFormatted: new Date(r.created_at).toLocaleDateString('en-US', {
        day: 'numeric',
        month: 'short',
        hour: 'numeric',
        minute: '2-digit'
      })
    }));
  }

  async deleteRecording(id, userId = null) {
    const record = await db.get(`SELECT * FROM recordings WHERE id = ?`, [id]);
    if (!record) throw new Error('Recording not found');

    if (record.file_path && fs.existsSync(record.file_path)) {
      try {
        fs.unlinkSync(record.file_path);
      } catch (e) {
        console.error('Error deleting file:', e);
      }
    }
    const rawLeftover = record.file_path?.replace('.mp4', '_raw.flv');
    if (rawLeftover && fs.existsSync(rawLeftover)) {
      try {
        fs.unlinkSync(rawLeftover);
      } catch (e) {}
    }

    await db.run(`DELETE FROM recordings WHERE id = ?`, [id]);
    return { success: true };
  }
}

module.exports = new LiveRecorderService();
