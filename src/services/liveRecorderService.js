const https = require('https');
const http = require('http');
const { spawn, exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const db = require('../database');

const VOLUME_DIR = (process.env.DB_PATH && path.isAbsolute(process.env.DB_PATH)) ? path.dirname(process.env.DB_PATH) : null;
const RECORDINGS_DIR = VOLUME_DIR ? path.join(VOLUME_DIR, 'recordings') : path.join(__dirname, '..', '..', 'public', 'recordings');
try { fs.mkdirSync(RECORDINGS_DIR, { recursive: true }); } catch (e) {}
// Also ensure public/recordings exists for static fallback
try { fs.mkdirSync(path.join(__dirname, '..', '..', 'public', 'recordings'), { recursive: true }); } catch (e) {}

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

function selectOptimalFlv(streamDataObj) {
  if (!streamDataObj || !streamDataObj.data) return null;
  const qData = streamDataObj.data;
  // 1. Look for standard H.264 streams first (hd, sd, uhd_60, hd_60) which remux cleanly to MP4
  for (const q of ['hd', 'sd', 'uhd_60', 'hd_60']) {
    if (qData[q]?.main?.flv) {
      return qData[q].main.flv;
    }
  }
  // 2. Check if sdk_params explicitly specifies H.264
  for (const key of Object.keys(qData)) {
    try {
      const sp = qData[key]?.main?.sdk_params;
      const parsed = typeof sp === 'string' ? JSON.parse(sp) : sp;
      if (parsed?.VCodec?.toLowerCase() === 'h264' && qData[key]?.main?.flv) {
        return qData[key].main.flv;
      }
    } catch (e) {}
  }
  // 3. Fallbacks
  for (const q of ['origin', 'ld']) {
    if (qData[q]?.main?.flv) return qData[q].main.flv;
  }
  return null;
}

function getFfmpegBinary() {
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

  try {
    const ffmpegPkg = require('@ffmpeg-installer/ffmpeg');
    if (ffmpegPkg && ffmpegPkg.path && fs.existsSync(ffmpegPkg.path)) {
      try { fs.chmodSync(ffmpegPkg.path, 0o755); } catch (e) {}
      return ffmpegPkg.path;
    }
  } catch (e) {}

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

    if (!fs.existsSync(rawFlvPath) || fs.statSync(rawFlvPath).size === 0) {
      return resolve({ success: false, reason: 'empty_raw_file' });
    }

    // Always use fast stream copy with faststart and -nostdin
    // TikTok streams are native H.264/AAC. Stream copy is instantaneous (0.5s), zero quality loss, and never times out.
    const args = ['-nostdin', '-y', '-i', rawFlvPath, '-c', 'copy', '-movflags', '+faststart', targetMp4Path];

    console.log(`[remuxToMp4] Fast stream copy: ${ffmpegBin} ${args.join(' ')}`);

    let proc;
    try {
      proc = spawn(ffmpegBin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (spawnErr) {
      console.error('[remuxToMp4] Spawn error:', spawnErr);
      try {
        if (rawFlvPath !== targetMp4Path && fs.existsSync(rawFlvPath) && !fs.existsSync(targetMp4Path)) {
          fs.copyFileSync(rawFlvPath, targetMp4Path);
        }
      } catch (e) {}
      return resolve({ success: false, reason: spawnErr.message });
    }

    let resolved = false;
    const safeResolve = (val) => {
      if (resolved) return;
      resolved = true;
      resolve(val);
    };

    let stderrTail = '';
    proc.stderr.on('data', chunk => {
      stderrTail += chunk.toString();
      if (stderrTail.length > 2000) stderrTail = stderrTail.slice(-2000);
    });
    proc.stdout.on('data', () => {});

    // Fast 5-second timeout for stream copy. If it takes longer, kill and fall back immediately.
    const timer = setTimeout(() => {
      try {
        console.warn('[remuxToMp4] FFmpeg process timed out (5s), killing and falling back to direct copy');
        if (process.platform === 'win32') {
          exec(`taskkill /pid ${proc.pid} /t /f`).catch(() => {});
        } else {
          proc.kill('SIGKILL');
        }
      } catch (e) {}

      try {
        if (rawFlvPath !== targetMp4Path && fs.existsSync(rawFlvPath) && (!fs.existsSync(targetMp4Path) || fs.statSync(targetMp4Path).size === 0)) {
          fs.copyFileSync(rawFlvPath, targetMp4Path);
        }
      } catch (e) {}
      safeResolve({ success: false, reason: 'timeout_fallback' });
    }, 5000);

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0 && fs.existsSync(targetMp4Path) && fs.statSync(targetMp4Path).size > 0) {
        console.log(`[remuxToMp4] Success! MP4 created: ${targetMp4Path} (${fs.statSync(targetMp4Path).size} bytes)`);
        if (rawFlvPath !== targetMp4Path) {
          try { fs.unlinkSync(rawFlvPath); } catch (e) {}
        }
        safeResolve({ success: true, orientation });
      } else {
        console.warn(`[remuxToMp4] Stream copy exited with code ${code}. Falling back to copy.`);
        // Fallback: copy file directly so data is NEVER lost
        try {
          if (rawFlvPath !== targetMp4Path && fs.existsSync(rawFlvPath) && (!fs.existsSync(targetMp4Path) || fs.statSync(targetMp4Path).size === 0)) {
            fs.copyFileSync(rawFlvPath, targetMp4Path);
          }
        } catch (e) {}
        safeResolve({ success: false, reason: 'ffmpeg_exit_' + code });
      }
    });

    proc.on('error', (procErr) => {
      clearTimeout(timer);
      console.error('[remuxToMp4] Process error:', procErr.message);
      try {
        if (rawFlvPath !== targetMp4Path && fs.existsSync(rawFlvPath) && !fs.existsSync(targetMp4Path)) {
          fs.copyFileSync(rawFlvPath, targetMp4Path);
        }
      } catch (e) {}
      safeResolve({ success: false, reason: procErr.message });
    });
  });
}

function generateThumbnail(videoPath, thumbPath) {
  return new Promise((resolve) => {
    const ffmpegBin = getFfmpegBinary();
    if (!ffmpegBin || !fs.existsSync(videoPath)) return resolve(null);
    const args = ['-nostdin', '-y', '-i', videoPath, '-frames:v', '1', '-q:v', '2', thumbPath];
    let proc;
    try {
      proc = spawn(ffmpegBin, args, { stdio: ['ignore', 'ignore', 'ignore'] });
    } catch (e) {
      return resolve(null);
    }
    const timer = setTimeout(() => {
      try {
        if (process.platform === 'win32') {
          exec(`taskkill /pid ${proc.pid} /t /f`).catch(() => {});
        } else {
          proc.kill('SIGKILL');
        }
      } catch (e) {}
      resolve(null);
    }, 4000);

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0 && fs.existsSync(thumbPath) && fs.statSync(thumbPath).size > 0) {
        return resolve(thumbPath);
      }
      resolve(null);
    });
    proc.on('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
  });
}

class LiveRecorderService {
  constructor() {
    this.activeJobs = new Map(); // jobId -> job details
    this.finishingJobs = new Map(); // jobId -> Promise<recording>
    this.cleanUpDiskSpace().catch(() => {});
    this.scanAndRemuxLegacy().catch(() => {});
    setInterval(() => this.cleanUpDiskSpace().catch(() => {}), 15 * 60 * 1000);
  }

  async scanAndRemuxLegacy() {
    try {
      const files = fs.readdirSync(RECORDINGS_DIR);

      // Pass 1: Auto-recover any _temp.flv or _raw.flv files whose target .mp4 is missing or broken
      for (const file of files) {
        if (file.endsWith('_temp.flv') || file.endsWith('_raw.flv')) {
          const targetMp4 = file.replace(/_temp\.flv$|_raw\.flv$/, '.mp4');
          const targetPath = path.join(RECORDINGS_DIR, targetMp4);
          const sourcePath = path.join(RECORDINGS_DIR, file);
          const statSource = fs.statSync(sourcePath);
          const needsRestore = !fs.existsSync(targetPath) || fs.statSync(targetPath).size < 1000;

          if (needsRestore && statSource.size > 1000) {
            console.log(`[AutoRecover] Restoring recording from ${file} to ${targetMp4} (${statSource.size} bytes)`);
            await remuxToMp4(sourcePath, targetPath, 'landscape');
            if (!fs.existsSync(targetPath) || fs.statSync(targetPath).size < 1000) {
              try { fs.copyFileSync(sourcePath, targetPath); } catch (_) {}
            }
          }

          // If target MP4 is healthy, immediately delete the leftover raw FLV to reclaim precious disk space!
          if (fs.existsSync(targetPath) && fs.statSync(targetPath).size > 1000) {
            try {
              fs.unlinkSync(sourcePath);
              console.log(`[scanAndRemuxLegacy] Cleaned up obsolete FLV ${file} to free disk space`);
            } catch (_) {}
          }
        }
      }

      // Pass 2: Ensure all MP4s have covers
      const updatedFiles = fs.readdirSync(RECORDINGS_DIR);
      for (const file of updatedFiles) {
        if (file.endsWith('.mp4')) {
          const fullPath = path.join(RECORDINGS_DIR, file);
          const thumbFilename = file.replace('.mp4', '_thumb.jpg');
          const thumbPath = path.join(RECORDINGS_DIR, thumbFilename);
          if (!fs.existsSync(thumbPath)) {
            await generateThumbnail(fullPath, thumbPath).catch(() => {});
            await db.run(`UPDATE recordings SET thumbnail_url = ? WHERE filename = ?`, [`/recordings/${thumbFilename}`, file]).catch(() => {});
          }
        }
      }

      // Pass 3: Auto-register existing MP4 files on disk into recordings table so pre-records survive redeploy
      const scanDirs = [...new Set([RECORDINGS_DIR, path.join(__dirname, '..', '..', 'public', 'recordings')])];
      for (const d of scanDirs) {
        try {
          if (!fs.existsSync(d)) continue;
          const diskFiles = fs.readdirSync(d);
          for (const f of diskFiles) {
            if (f.endsWith('.mp4')) {
              const row = await db.get(`SELECT id FROM recordings WHERE filename = ?`, [f]);
              if (!row) {
                const fullP = path.join(d, f);
                const st = fs.statSync(fullP);
                if (st.size > 1000) {
                  let uname = 'paragontechh';
                  if (f.includes('showcase')) uname = 'paragontechh';
                  else {
                    const unameMatch = f.match(/^([a-zA-Z0-9_.-]+)_\d+/);
                    if (unameMatch) uname = unameMatch[1];
                  }
                  const thumbName = f.replace('.mp4', '_thumb.jpg');
                  const hasThumb = fs.existsSync(path.join(d, thumbName));
                  const tUrl = hasThumb ? `/recordings/${thumbName}` : null;
                  await db.run(
                    `INSERT INTO recordings (user_id, username, title, filename, file_path, file_size_bytes, duration_seconds, thumbnail_url, user_deleted)
                     VALUES (NULL, ?, ?, ?, ?, ?, 2661, ?, 0)`,
                    [uname, `Lets Go LIVE! (@${uname})`, f, fullP, st.size, tUrl]
                  );
                  console.log(`[scanAndRemuxLegacy] Registered recording ${f} (${st.size} bytes) for @${uname}`);
                }
              }
            }
          }
        } catch (_) {}
      }
      // Ensure prerecords/showcases have user_id = NULL and user_deleted = 0 so ALL members can watch them
      await db.run(`UPDATE recordings SET user_id = NULL, user_deleted = 0 WHERE filename LIKE '%showcase%' OR filename LIKE '%prerecord%'`).catch(() => {});
    } catch (e) {
      console.warn('[scanAndRemuxLegacy] Notice:', e.message);
    }
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
          let landscapeUrl = null;
          let portraitUrl = null;

          // Extract roomId without 64-bit float precision loss
          let roomId = null;
          const rawStreamData = room?.streamData?.pull_data?.stream_data || '';
          const matchRoomId = rawStreamData.match(/"room_id":\s*(\d+)/);
          if (matchRoomId) {
            roomId = matchRoomId[1];
          }

          // Extract base stream URL from web API
          if (rawStreamData) {
            try {
              const streamJson = JSON.parse(rawStreamData);
              const opt = selectOptimalFlv(streamJson);
              if (opt) landscapeUrl = opt;
            } catch (e) {}
          }

          // If live and roomId is known, query mobile webcast API for true Dual Layout scenes (Portrait vs Landscape)
          if (isLive && roomId) {
            try {
              const webcastUrl = `https://webcast.tiktok.com/webcast/room/info/?aid=1233&room_id=${roomId}&device_platform=iphone`;
              const mRes = await fetch(webcastUrl, {
                headers: {
                  'User-Agent': 'TikTok 30.1.0 (iPhone; iOS 17.4; Scale/3.00)',
                  'Accept': 'application/json'
                },
                signal: AbortSignal.timeout(5000)
              });
              if (mRes.ok) {
                const mJson = await mRes.json().catch(() => null);
                const mRoom = mJson?.data;

                // multi_stream_url is the dedicated portrait scene for Dual Stream / TikTok Live Studio
                if (mRoom?.multi_stream_url?.live_core_sdk_data?.pull_data?.stream_data) {
                  try {
                    const msd = JSON.parse(mRoom.multi_stream_url.live_core_sdk_data.pull_data.stream_data);
                    const opt = selectOptimalFlv(msd);
                    if (opt) portraitUrl = opt;
                  } catch (e) {}
                }

                // stream_url is the desktop/game landscape scene
                if (mRoom?.stream_url?.live_core_sdk_data?.pull_data?.stream_data) {
                  try {
                    const lsd = JSON.parse(mRoom.stream_url.live_core_sdk_data.pull_data.stream_data);
                    const opt = selectOptimalFlv(lsd);
                    if (opt) landscapeUrl = opt;
                  } catch (e) {}
                }
              }
            } catch (mErr) {
              console.warn('[LiveCheck] Mobile webcast dual stream query warning:', mErr.message);
            }
          }

          if (!portraitUrl) portraitUrl = landscapeUrl;
          if (!landscapeUrl) landscapeUrl = portraitUrl;

          const diamonds = room?.stats?.fan_ticket || 0;
          const estLiveEarnings = (diamonds * 0.005).toFixed(2);
          const tikleapUrl = `https://www.tikleap.com/profile/${encodeURIComponent(u?.uniqueId || user)}`;

          return {
            username: u?.uniqueId || user,
            nickname: u?.nickname || user,
            avatar: u?.avatarLarger || u?.avatarThumb || u?.avatarMedium || null,
            title: room?.title || 'Live Stream',
            is_live: isLive,
            status_code: status,
            diamonds: diamonds,
            est_earnings: estLiveEarnings,
            tikleap_url: tikleapUrl,
            portrait_stream_url: portraitUrl,
            landscape_stream_url: landscapeUrl,
            stream_url: portraitUrl,
            has_dual_scene: !!(portraitUrl && landscapeUrl && portraitUrl !== landscapeUrl),
            viewer_count: room?.user_count || 0,
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

    // Enforce 1 active recording at a time per user
    if (userId) {
      for (const [id, j] of this.activeJobs.entries()) {
        if (j.userId === userId && j.status === 'recording') {
          if (j.username.toLowerCase() === user.toLowerCase()) {
            return this.formatJob(j);
          }
          throw new Error(`A recording for @${j.username} is already in progress. Please stop it before starting another.`);
        }
      }
    }

    // Check if job already active for this username
    for (const [id, j] of this.activeJobs.entries()) {
      if (j.username.toLowerCase() === user.toLowerCase() && j.status === 'recording') {
        return this.formatJob(j);
      }
    }

    // Check live status to get stream info
    const statusInfo = await this.checkStatus(user);
    if (!statusInfo.is_live || !statusInfo.stream_url) {
      throw new Error(`@${user} is currently offline. The streamer must be live to start recording.`);
    }

    const timestamp = Date.now();
    const jobId = `${user}_${timestamp}`;
    const rawFilename = `${jobId}_raw.flv`;
    const rawPath = path.join(RECORDINGS_DIR, rawFilename);
    const filename = `${jobId}.mp4`;
    const filePath = path.join(RECORDINGS_DIR, filename);

    const targetStreamUrl = (orientation === 'landscape')
      ? (statusInfo.landscape_stream_url || statusInfo.stream_url)
      : (statusInfo.portrait_stream_url || statusInfo.stream_url);

    const job = {
      jobId,
      userId: userId || null,
      username: user,
      avatarUrl: statusInfo.avatar || null,
      orientation: orientation || 'portrait',
      title: statusInfo.title || `Live Stream (@${user})`,
      filename,
      filePath,
      rawPath,
      streamUrl: targetStreamUrl,
      startTime: Date.now(),
      lastDataTime: Date.now(),
      bytesWritten: 0,
      status: 'recording',
      error: null,
      httpReq: null,
      fileStream: null,
      watchdogTimer: null
    };

    // If direct stream URL is found, stream directly over HTTP into the raw file with full redirect handling
    if (job.streamUrl) {
      try {
        try { fs.mkdirSync(path.dirname(rawPath), { recursive: true }); } catch (e) {}
        try { fs.mkdirSync(path.join(__dirname, '..', '..', 'public', 'recordings'), { recursive: true }); } catch (e) {}

        const fileStream = fs.createWriteStream(rawPath);
        fileStream.on('error', err => {
          console.error(`[liveRecorderService] fileStream error for @${user}:`, err.message);
          job.error = err.message;
        });
        job.fileStream = fileStream;

        const connectStream = (streamUrl, redirectHops = 0) => {
          if (redirectHops > 6) {
            console.error(`[liveRecorderService] Too many redirects for @${user}`);
            if (this.activeJobs.has(jobId)) this.finishJob(jobId);
            return;
          }
          const client = streamUrl.startsWith('https') ? https : http;
          let parsedUrl;
          try {
            parsedUrl = new URL(streamUrl);
          } catch (e) {
            console.error(`[liveRecorderService] Invalid stream URL: ${streamUrl}`);
            if (this.activeJobs.has(jobId)) this.finishJob(jobId);
            return;
          }

          const req = client.get(streamUrl, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
              'Referer': `https://www.tiktok.com/@${user}/live`,
              'Accept': '*/*'
            }
          }, res => {
            job.httpRes = res;
            // Handle HTTP 301, 302, 303, 307, 308 redirects automatically
            if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
              const nextUrl = new URL(res.headers.location, streamUrl).href;
              console.log(`[liveRecorderService] Following stream redirect (${res.statusCode}) for @${user} -> ${nextUrl.slice(0, 80)}...`);
              res.resume();
              return connectStream(nextUrl, redirectHops + 1);
            }

            if (res.statusCode < 200 || res.statusCode >= 300) {
              console.warn(`[liveRecorderService] Stream HTTP error: ${res.statusCode} for @${user}`);
              res.resume();
              if (job.bytesWritten < 50000 && statusInfo.landscape_stream_url && statusInfo.landscape_stream_url !== streamUrl) {
                console.log(`[liveRecorderService] Trying fallback landscape stream for @${user}...`);
                return connectStream(statusInfo.landscape_stream_url, redirectHops + 1);
              }
              if (this.activeJobs.has(jobId)) this.finishJob(jobId);
              return;
            }

            res.on('data', chunk => {
              job.bytesWritten += chunk.length;
              job.lastDataTime = Date.now();
            });
            res.pipe(fileStream, { end: false });

            res.on('end', () => {
              // If ended with virtually no data (<50KB) and stream just started (<8s), retry once
              if (job.bytesWritten < 50000 && (Date.now() - job.startTime) < 8000 && redirectHops < 2) {
                console.log(`[liveRecorderService] Stream ended early (<50KB), retrying connection in 1.5s...`);
                setTimeout(() => {
                  if (this.activeJobs.has(jobId) && job.status === 'recording') {
                    connectStream(streamUrl, redirectHops + 1);
                  }
                }, 1500);
                return;
              }

              if (this.activeJobs.has(jobId)) {
                console.log(`[liveRecorderService] Stream ended for @${user}, finishing capture.`);
                this.finishJob(jobId);
              }
            });

            res.on('error', err => {
              job.error = err.message;
              console.warn(`[liveRecorderService] Stream socket error:`, err.message);
              if (this.activeJobs.has(jobId)) {
                this.finishJob(jobId);
              }
            });
          });

          req.on('error', err => {
            job.error = err.message;
            console.warn(`[liveRecorderService] Request error:`, err.message);
          });

          job.httpReq = req;
        };

        connectStream(job.streamUrl, 0);
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

    // Live Stream End Watchdog: continuously monitors if the live ended so recording auto-saves
    let consecutiveOfflineCount = 0;
    job.watchdogTimer = setInterval(async () => {
      if (!this.activeJobs.has(jobId) || job.status !== 'recording') {
        if (job.watchdogTimer) clearInterval(job.watchdogTimer);
        return;
      }
      try {
        const elapsed = Date.now() - job.startTime;
        const idleMs = Date.now() - (job.lastDataTime || job.startTime);

        // Allow at least 25 seconds of continuous buffering before checking offline
        if (elapsed < 25000) return;

        // Check if stream has been completely idle (no chunks received for 18 seconds)
        if (idleMs > 18000) {
          const st = await this.checkStatus(user);
          if (!st.is_live) {
            consecutiveOfflineCount++;
            if (consecutiveOfflineCount >= 2) {
              console.log(`[Watchdog] Stream for @${user} ended by creator. Finalizing and saving MP4...`);
              if (job.watchdogTimer) clearInterval(job.watchdogTimer);
              await this.stopRecording(jobId);
              return;
            }
          } else {
            consecutiveOfflineCount = 0;
          }
        }
      } catch (e) {}
    }, 10000);

    this.activeJobs.set(jobId, job);
    return this.formatJob(job);
  }

  async stopRecording(jobId) {
    if (!jobId) throw new Error('Job ID required');
    if (this.finishingJobs.has(jobId)) {
      return await this.finishingJobs.get(jobId);
    }
    const job = this.activeJobs.get(jobId);
    if (!job) {
      // Check if it already finished and was saved to SQLite
      const existing = await db.get(`SELECT * FROM recordings WHERE filename LIKE ? ORDER BY id DESC LIMIT 1`, [`%${jobId}%`]);
      if (existing) {
        return {
          jobId,
          id: existing.id,
          username: existing.username,
          title: existing.title,
          filename: existing.filename,
          url: `/recordings/${existing.filename}`,
          downloadUrl: `/recordings/${existing.filename}`,
          thumbnailUrl: existing.thumbnail_url,
          fileSize: existing.file_size_bytes,
          fileSizeFormatted: formatSize(existing.file_size_bytes),
          durationSeconds: existing.duration_seconds,
          durationFormatted: formatDuration(existing.duration_seconds),
          status: 'finished'
        };
      }
      return { success: true, message: 'Recording already stopped or saved' };
    }

    return await this.finishJob(jobId);
  }

  async finishJob(jobId) {
    if (!jobId) return null;
    if (this.finishingJobs.has(jobId)) {
      return await this.finishingJobs.get(jobId);
    }

    const job = this.activeJobs.get(jobId);
    if (!job) return null;

    const finishPromise = (async () => {
      try {
        if (job.watchdogTimer) {
          clearInterval(job.watchdogTimer);
          job.watchdogTimer = null;
        }

        job.status = 'finalizing';

        // 1. Terminate incoming stream cleanly and unpipe
        if (job.httpRes) {
          try {
            job.httpRes.unpipe();
            job.httpRes.destroy();
          } catch (e) {}
          job.httpRes = null;
        }
        if (job.httpReq) {
          try {
            job.httpReq.destroy();
          } catch (e) {}
          job.httpReq = null;
        }
        if (job.process && !job.process.killed) {
          try {
            if (process.platform === 'win32') {
              exec(`taskkill /pid ${job.process.pid} /t /f`).catch(() => {});
            } else {
              job.process.kill('SIGTERM');
            }
          } catch (e) {}
        }

        // 2. Cleanly finish and close the file write stream to release OS file locks
        if (job.fileStream) {
          try {
            await new Promise((resolve) => {
              if (job.fileStream.destroyed || job.fileStream.closed) return resolve();
              job.fileStream.once('finish', resolve);
              job.fileStream.once('close', resolve);
              job.fileStream.once('error', resolve);
              try {
                job.fileStream.end();
              } catch (e) {
                resolve();
              }
              setTimeout(resolve, 300);
            });
            try {
              job.fileStream.destroy();
            } catch (e) {}
          } catch (e) {}
          job.fileStream = null;
        }

        // Small grace tick to ensure filesystem write buffers are flushed
        await new Promise(r => setTimeout(r, 100));

        // 3. Remux raw FLV to standard MP4 with faststart (fast stream copy < 5s)
        const rawExists = job.rawPath && fs.existsSync(job.rawPath);
        const rawSize = rawExists ? fs.statSync(job.rawPath).size : 0;

        if (rawExists && rawSize > 0) {
          try {
            console.log(`[finishJob] Remuxing recording for @${job.username} (${rawSize} bytes)...`);
            await remuxToMp4(job.rawPath, job.filePath, job.orientation || 'portrait');
          } catch (err) {
            console.error('[finishJob] Remux error:', err);
          }

          // If remux failed or file missing, copy raw file directly so data is NEVER lost
          if (!fs.existsSync(job.filePath) || fs.statSync(job.filePath).size === 0) {
            try {
              fs.copyFileSync(job.rawPath, job.filePath);
            } catch (cpErr) {
              console.warn('[finishJob] Fallback copy notice:', cpErr.message);
            }
          }

          // Ensure MP4 is mirrored to public/recordings as well so static serving always works
          try {
            const pubDir = path.join(__dirname, '..', '..', 'public', 'recordings');
            if (fs.existsSync(job.filePath)) {
              const localCopy = path.join(pubDir, job.filename);
              if (job.filePath !== localCopy && !fs.existsSync(localCopy)) {
                fs.mkdirSync(pubDir, { recursive: true });
                fs.copyFileSync(job.filePath, localCopy);
              }
            }
          } catch (_) {}
        }

        let fileSize = 0;
        try {
          if (fs.existsSync(job.filePath)) {
            fileSize = fs.statSync(job.filePath).size;
          } else if (rawExists) {
            fileSize = rawSize;
          } else {
            fileSize = job.bytesWritten || 0;
          }
        } catch (e) {}

        const durationSeconds = Math.max(1, Math.round((Date.now() - job.startTime) / 1000));

        // 4. Save to database IMMEDIATELY (guaranteed persistence, never hang!)
        let savedRow = null;
        try {
          const res = await db.run(
            `INSERT INTO recordings (user_id, username, title, filename, file_path, file_size_bytes, duration_seconds, thumbnail_url, user_deleted)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
            [job.userId || null, job.username, job.title || `Live Stream (@${job.username})`, job.filename, job.filePath, fileSize, durationSeconds, null]
          );
          savedRow = await db.get(`SELECT * FROM recordings WHERE id = ?`, [res.lastID]);
          console.log(`[finishJob] Recording #${savedRow?.id} successfully saved to SQLite for @${job.username} (${fileSize} bytes)`);
        } catch (err) {
          console.error('[finishJob] Error inserting recording record:', err);
        }

        // Clean up the temporary raw FLV file to free up volume disk space immediately
        if (job.rawPath && fs.existsSync(job.rawPath) && fs.existsSync(job.filePath) && fs.statSync(job.filePath).size > 1000) {
          try {
            fs.unlinkSync(job.rawPath);
            console.log(`[finishJob] Reclaimed disk space by unlinking raw FLV ${path.basename(job.rawPath)}`);
          } catch (_) {}
        }

        // 5. Generate thumbnail in the background (non-blocking, fast UI response)
        const thumbFilename = job.filename.replace('.mp4', '_thumb.jpg');
        const thumbPath = path.join(RECORDINGS_DIR, thumbFilename);
        let thumbnailUrl = null;

        if (fs.existsSync(job.filePath) && fileSize > 1000) {
          generateThumbnail(job.filePath, thumbPath).then(thumbRes => {
            if (thumbRes && savedRow?.id) {
              db.run(`UPDATE recordings SET thumbnail_url = ? WHERE id = ?`, [`/recordings/${thumbFilename}`, savedRow.id]).catch(() => {});
            }
          }).catch(() => {});
        }

        job.status = 'finished';

        return {
          jobId: job.jobId,
          id: savedRow ? savedRow.id : null,
          username: job.username,
          title: job.title,
          filename: job.filename,
          url: `/recordings/${job.filename}`,
          downloadUrl: `/recordings/${job.filename}`,
          thumbnailUrl: thumbnailUrl,
          fileSize,
          fileSizeFormatted: formatSize(fileSize),
          durationSeconds,
          durationFormatted: formatDuration(durationSeconds),
          status: 'finished'
        };
      } finally {
        this.activeJobs.delete(jobId);
        this.finishingJobs.delete(jobId);
      }
    })();

    this.finishingJobs.set(jobId, finishPromise);
    return await finishPromise;
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
    let diskSize = 0;
    try {
      if (job.filePath && fs.existsSync(job.filePath)) {
        diskSize = fs.statSync(job.filePath).size;
      } else if (job.rawPath && fs.existsSync(job.rawPath)) {
        diskSize = fs.statSync(job.rawPath).size;
      }
    } catch (e) {}

    const currentSize = Math.max(job.bytesWritten || 0, diskSize);
    const elapsed = Math.round((Date.now() - job.startTime) / 1000);
    return {
      jobId: job.jobId,
      username: job.username,
      avatarUrl: job.avatarUrl || null,
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

  async cleanUpDiskSpace() {
    let freedBytes = 0;
    const pubDir = path.join(__dirname, '..', '..', 'public', 'recordings');
    const scanDirs = [...new Set([RECORDINGS_DIR, pubDir])];
    for (const d of scanDirs) {
      try {
        if (!fs.existsSync(d)) continue;
        const files = fs.readdirSync(d);
        for (const file of files) {
          const fp = path.join(d, file);
          try {
            const st = fs.statSync(fp);

            // 1. Delete 0-byte or corrupted files (< 100 bytes) older than 3 minutes
            if (st.size < 100 && (Date.now() - st.mtimeMs > 180000)) {
              fs.unlinkSync(fp);
              freedBytes += st.size;
              console.log(`[cleanUpDiskSpace] Removed tiny/broken file: ${file}`);
              continue;
            }

            // 2. Delete leftover raw FLVs where MP4 already exists or if older than 20 minutes
            if (file.endsWith('_raw.flv') || file.endsWith('_temp.flv')) {
              const mp4Name = file.replace(/_raw\.flv$|_temp\.flv$/, '.mp4');
              const mp4Path = path.join(d, mp4Name);
              const isOld = (Date.now() - st.mtimeMs > 1200000); // 20 mins
              const mp4Exists = fs.existsSync(mp4Path) && fs.statSync(mp4Path).size > 1000;

              if (mp4Exists || isOld) {
                fs.unlinkSync(fp);
                freedBytes += st.size;
                console.log(`[cleanUpDiskSpace] Removed obsolete raw FLV: ${file} (${formatSize(st.size)} freed)`);
              }
            }
          } catch (_) {}
        }
      } catch (_) {}
    }

    // Shrink SQLite database file with VACUUM
    try {
      await db.run('VACUUM').catch(() => {});
    } catch (_) {}

    return freedBytes;
  }

  async syncDiskRecordings() {
    await this.cleanUpDiskSpace().catch(() => {});
    try {
      await db.run(`UPDATE recordings SET user_id = NULL, user_deleted = 0 WHERE filename LIKE '%showcase%' OR filename LIKE '%prerecord%'`).catch(() => {});
    } catch (_) {}

    const pubDir = path.join(__dirname, '..', '..', 'public', 'recordings');
    const scanDirs = [...new Set([RECORDINGS_DIR, pubDir])];
    for (const d of scanDirs) {
      try {
        if (!fs.existsSync(d)) continue;
        const diskFiles = fs.readdirSync(d);
        for (const f of diskFiles) {
          if (f.endsWith('.mp4')) {
            const fullP = path.join(d, f);
            const st = fs.statSync(fullP);
            if (st.size < 1000) continue;

            // Mirror file between VOLUME_DIR and public/recordings so static serve and range stream both work
            try {
              const otherDir = (d === RECORDINGS_DIR) ? pubDir : RECORDINGS_DIR;
              if (d !== otherDir) {
                fs.mkdirSync(otherDir, { recursive: true });
                const mirrorPath = path.join(otherDir, f);
                if (!fs.existsSync(mirrorPath)) {
                  fs.copyFileSync(fullP, mirrorPath);
                }
              }
            } catch (_) {}

            const row = await db.get(`SELECT id, user_id, user_deleted FROM recordings WHERE filename = ?`, [f]);
            if (!row) {
              let uname = 'paragontechh';
              if (f.includes('showcase')) uname = 'paragontechh';
              else {
                const unameMatch = f.match(/^([a-zA-Z0-9_.-]+)_\d+/);
                if (unameMatch) uname = unameMatch[1];
              }
              const thumbName = f.replace('.mp4', '_thumb.jpg');
              const hasThumb = fs.existsSync(path.join(d, thumbName));
              const tUrl = hasThumb ? `/recordings/${thumbName}` : null;
              await db.run(
                `INSERT INTO recordings (user_id, username, title, filename, file_path, file_size_bytes, duration_seconds, thumbnail_url, user_deleted)
                 VALUES (NULL, ?, ?, ?, ?, ?, 2661, ?, 0)`,
                [uname, `Lets Go LIVE! (@${uname})`, f, fullP, st.size, tUrl]
              );
              console.log(`[syncDiskRecordings] Auto-indexed recording ${f} (${st.size} bytes) for all members`);
            } else if (f.includes('showcase') || f.includes('prerecord') || row.user_deleted === 1) {
              await db.run(`UPDATE recordings SET user_id = NULL, user_deleted = 0 WHERE id = ?`, [row.id]).catch(() => {});
            }
          }
        }
      } catch (_) {}
    }
  }

  async getRecordings(userId = null, isAdmin = false) {
    await this.syncDiskRecordings().catch(() => {});

    let sql = `SELECT r.*, u.username as owner_username FROM recordings r LEFT JOIN users u ON r.user_id = u.id`;
    const params = [];

    if (!isAdmin) {
      // Normal user sees non-deleted recordings (or their own)
      sql += ` WHERE (r.user_deleted = 0 OR r.user_deleted IS NULL)`;
      if (userId) {
        sql += ` AND (r.user_id = ? OR r.user_id IS NULL)`;
        params.push(userId);
      }
    } else {
      sql += ` WHERE (r.user_deleted = 0 OR r.user_deleted IS NULL)`;
    }
    sql += ` ORDER BY r.id DESC LIMIT 200`;

    const rows = await db.all(sql, params);
    return rows.map(r => {
      const thumbFile = r.filename ? r.filename.replace('.mp4', '_thumb.jpg') : null;
      const thumbExists = thumbFile && fs.existsSync(path.join(RECORDINGS_DIR, thumbFile));
      if (!thumbExists && thumbFile && r.filename) {
        const vPath = path.join(RECORDINGS_DIR, r.filename);
        const tPath = path.join(RECORDINGS_DIR, thumbFile);
        if (fs.existsSync(vPath)) {
          generateThumbnail(vPath, tPath).then((ok) => {
            if (ok) db.run(`UPDATE recordings SET thumbnail_url = ? WHERE id = ?`, [`/recordings/${thumbFile}`, r.id]).catch(() => {});
          }).catch(() => {});
        }
      }

      let dateFormatted = '';
      try {
        const cStr = String(r.created_at || '').replace(' ', 'T') + (String(r.created_at || '').includes('Z') ? '' : 'Z');
        const dt = new Date(cStr);
        dateFormatted = isNaN(dt.getTime()) ? String(r.created_at || '') : dt.toLocaleDateString('en-US', {
          day: 'numeric',
          month: 'short',
          hour: 'numeric',
          minute: '2-digit'
        });
      } catch (e) {
        dateFormatted = String(r.created_at || '');
      }

      return {
        id: r.id,
        userId: r.user_id,
        ownerUsername: r.owner_username || 'Guest / Direct',
        username: r.username,
        title: r.title || `Live Stream`,
        filename: r.filename,
        url: `/recordings/${r.filename}`,
        downloadUrl: `/recordings/${r.filename}`,
        thumbnailUrl: r.thumbnail_url || (thumbExists ? `/recordings/${thumbFile}` : null),
        fileSizeBytes: r.file_size_bytes,
        fileSizeFormatted: formatSize(r.file_size_bytes),
        durationSeconds: r.duration_seconds,
        durationFormatted: formatDuration(r.duration_seconds),
        userDeleted: !!r.user_deleted,
        createdAt: r.created_at,
        dateFormatted
      };
    });
  }

  // Soft delete for regular user: disappears from their dashboard, but preserved for Admin!
  async userDeleteRecording(id, userId = null) {
    const rec = await db.get(`SELECT filename, user_id FROM recordings WHERE id = ?`, [id]);
    if (!rec) throw new Error('Recording not found');
    if (rec.filename && (rec.filename.includes('showcase') || rec.filename.includes('prerecord'))) {
      throw new Error('Pre-recordings cannot be deleted');
    }
    let sql = `UPDATE recordings SET user_deleted = 1 WHERE id = ?`;
    const params = [id];
    if (userId) {
      sql += ` AND user_id = ?`;
      params.push(userId);
    }
    const res = await db.run(sql, params);
    if (!res.changes) throw new Error('Recording not found or not owned by you');
    return { success: true };
  }

  // Hard delete for Admin: permanently removes file, thumbnail and database entry
  async adminDeleteRecording(id) {
    const record = await db.get(`SELECT * FROM recordings WHERE id = ?`, [id]);
    if (!record) throw new Error('Recording not found');

    if (record.file_path && fs.existsSync(record.file_path)) {
      try { fs.unlinkSync(record.file_path); } catch (e) {}
    }
    const rawLeftover = record.file_path?.replace('.mp4', '_raw.flv');
    if (rawLeftover && fs.existsSync(rawLeftover)) {
      try { fs.unlinkSync(rawLeftover); } catch (e) {}
    }
    const thumbLeftover = record.file_path?.replace('.mp4', '_thumb.jpg');
    if (thumbLeftover && fs.existsSync(thumbLeftover)) {
      try { fs.unlinkSync(thumbLeftover); } catch (e) {}
    }

    await db.run(`DELETE FROM recordings WHERE id = ?`, [id]);
    return { success: true };
  }

  // Saved Creators features
  async getSavedCreators(userId) {
    if (!userId) return [];
    const rows = await db.all(`SELECT * FROM saved_creators WHERE user_id = ? ORDER BY id DESC`, [userId]);
    return rows.map(r => ({
      id: r.id,
      username: r.username,
      nickname: r.nickname || r.username,
      avatarUrl: r.avatar_url || null,
      tikleapUrl: `https://www.tikleap.com/profile/${encodeURIComponent(r.username)}`,
      createdAt: r.created_at
    }));
  }

  async saveCreator(userId, username) {
    if (!userId) throw new Error('Login required');
    const clean = cleanUsername(username);
    if (!clean) throw new Error('Valid username required');

    let nickname = clean;
    let avatarUrl = null;
    try {
      const st = await this.checkStatus(clean);
      if (st) {
        nickname = st.nickname || clean;
        avatarUrl = st.avatar || null;
      }
    } catch (e) {}

    const existing = await db.get(`SELECT id FROM saved_creators WHERE user_id = ? AND LOWER(username) = LOWER(?)`, [userId, clean]);
    if (existing) {
      if (avatarUrl) {
        await db.run(`UPDATE saved_creators SET avatar_url = ?, nickname = ? WHERE id = ?`, [avatarUrl, nickname, existing.id]);
      }
      return { id: existing.id, username: clean, nickname, avatarUrl, alreadySaved: true };
    }

    const res = await db.run(
      `INSERT INTO saved_creators (user_id, username, nickname, avatar_url) VALUES (?, ?, ?, ?)`,
      [userId, clean, nickname, avatarUrl]
    );
    return { id: res.lastID, username: clean, nickname, avatarUrl, created: true };
  }

  async removeSavedCreator(id, userId) {
    if (!userId) throw new Error('Login required');
    await db.run(`DELETE FROM saved_creators WHERE id = ? AND user_id = ?`, [id, userId]);
    return { success: true };
  }
}

const service = new LiveRecorderService();
service.RECORDINGS_DIR = RECORDINGS_DIR;
service.formatSize = formatSize;
module.exports = service;
