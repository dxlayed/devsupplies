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
        // Pad to standard 720:1280 vertical portrait (9:16) with ultrafast H.264
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

    console.log(`[remuxToMp4] Running FFmpeg (${orientation}): ${ffmpegBin} ${args.join(' ')}`);

    let proc;
    try {
      proc = spawn(ffmpegBin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (spawnErr) {
      console.error('[remuxToMp4] Spawn error:', spawnErr);
      return resolve({ success: false, reason: spawnErr.message });
    }

    // Drain stderr & stdout so the 64KB OS pipe buffer NEVER blocks FFmpeg
    let stderrTail = '';
    proc.stderr.on('data', chunk => {
      stderrTail += chunk.toString();
      if (stderrTail.length > 2000) stderrTail = stderrTail.slice(-2000);
    });
    proc.stdout.on('data', () => {});

    // Safety timeout: 40 seconds max
    const timer = setTimeout(() => {
      try {
        console.warn('[remuxToMp4] FFmpeg timed out, terminating');
        proc.kill('SIGKILL');
      } catch (e) {}
    }, 40000);

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0 && fs.existsSync(targetMp4Path) && fs.statSync(targetMp4Path).size > 0) {
        console.log(`[remuxToMp4] Success! MP4 created: ${targetMp4Path} (${fs.statSync(targetMp4Path).size} bytes)`);
        try { fs.unlinkSync(rawFlvPath); } catch (e) {}
        resolve({ success: true, orientation });
      } else {
        console.warn(`[remuxToMp4] FFmpeg exited with code ${code}. Tail: ${stderrTail.slice(-200)}`);
        // If re-encode failed, try fast copy fallback
        if (args.includes('-c:v')) {
          console.log('[remuxToMp4] Attempting stream copy fallback...');
          const fallbackArgs = ['-y', '-i', rawFlvPath, '-c', 'copy', '-movflags', '+faststart', targetMp4Path];
          try {
            const fProc = spawn(ffmpegBin, fallbackArgs, { stdio: ['ignore', 'ignore', 'ignore'] });
            fProc.on('close', (fCode) => {
              if (fCode === 0 && fs.existsSync(targetMp4Path) && fs.statSync(targetMp4Path).size > 0) {
                try { fs.unlinkSync(rawFlvPath); } catch (e) {}
                return resolve({ success: true, orientation: 'copied' });
              }
              if (!fs.existsSync(targetMp4Path) && fs.existsSync(rawFlvPath)) {
                fs.copyFileSync(rawFlvPath, targetMp4Path);
              }
              resolve({ success: false, reason: 'ffmpeg_exit_' + code });
            });
            return;
          } catch (e) {}
        }

        if (!fs.existsSync(targetMp4Path) && fs.existsSync(rawFlvPath)) {
          fs.copyFileSync(rawFlvPath, targetMp4Path);
        }
        resolve({ success: false, reason: 'ffmpeg_exit_' + code });
      }
    });

    proc.on('error', (procErr) => {
      clearTimeout(timer);
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

function generateThumbnail(videoPath, thumbPath) {
  return new Promise((resolve) => {
    const ffmpegBin = getFfmpegBinary();
    if (!ffmpegBin || !fs.existsSync(videoPath)) return resolve(null);
    // Method 1: grab first available frame at video start without seeking
    const args = ['-y', '-i', videoPath, '-frames:v', '1', '-q:v', '2', thumbPath];
    const proc = spawn(ffmpegBin, args, { stdio: ['ignore', 'ignore', 'ignore'] });
    const timer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch (e) {}
    }, 8000);
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0 && fs.existsSync(thumbPath) && fs.statSync(thumbPath).size > 0) {
        return resolve(thumbPath);
      }
      // Method 2: fallback to 1s in
      const fbArgs = ['-y', '-ss', '1', '-i', videoPath, '-frames:v', '1', '-q:v', '2', thumbPath];
      const fbProc = spawn(ffmpegBin, fbArgs, { stdio: ['ignore', 'ignore', 'ignore'] });
      fbProc.on('close', (c) => {
        if (c === 0 && fs.existsSync(thumbPath) && fs.statSync(thumbPath).size > 0) {
          resolve(thumbPath);
        } else {
          resolve(null);
        }
      });
      fbProc.on('error', () => resolve(null));
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

            // Generate thumbnail if missing
            const thumbFilename = file.replace('.mp4', '_thumb.jpg');
            const thumbPath = path.join(RECORDINGS_DIR, thumbFilename);
            if (!fs.existsSync(thumbPath)) {
              await generateThumbnail(fullPath, thumbPath);
              await db.run(`UPDATE recordings SET thumbnail_url = ? WHERE filename = ?`, [`/recordings/${thumbFilename}`, file]).catch(() => {});
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
    if (!statusInfo.is_live && !statusInfo.stream_url) {
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
        const fileStream = fs.createWriteStream(rawPath);
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
              'Accept': '*/*',
              'Host': parsedUrl.host,
              'Connection': 'keep-alive'
            }
          }, res => {
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
                if (job.fileStream) job.fileStream.end();
                this.finishJob(jobId);
              }
            });

            res.on('error', err => {
              job.error = err.message;
              console.warn(`[liveRecorderService] Stream socket error:`, err.message);
              if (this.activeJobs.has(jobId)) {
                if (job.fileStream) job.fileStream.end();
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
    const job = this.activeJobs.get(jobId);
    if (!job) throw new Error('Recording job not found');

    if (job.watchdogTimer) {
      clearInterval(job.watchdogTimer);
      job.watchdogTimer = null;
    }

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

    if (job.watchdogTimer) {
      clearInterval(job.watchdogTimer);
      job.watchdogTimer = null;
    }

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

    // Generate high-resolution first-frame video cover
    const thumbFilename = job.filename.replace('.mp4', '_thumb.jpg');
    const thumbPath = path.join(RECORDINGS_DIR, thumbFilename);
    let thumbnailUrl = null;
    try {
      if (fs.existsSync(job.filePath)) {
        const thumbRes = await generateThumbnail(job.filePath, thumbPath);
        if (thumbRes) thumbnailUrl = `/recordings/${thumbFilename}`;
      }
    } catch (e) {
      console.warn('Cover generation warning:', e);
    }

    const durationSeconds = Math.max(1, Math.round((Date.now() - job.startTime) / 1000));

    // Save to database
    let savedRow = null;
    try {
      const res = await db.run(
        `INSERT INTO recordings (user_id, username, title, filename, file_path, file_size_bytes, duration_seconds, thumbnail_url, user_deleted)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
        [job.userId, job.username, job.title || `Live Stream (@${job.username})`, job.filename, job.filePath, fileSize, durationSeconds, thumbnailUrl]
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
      thumbnailUrl: thumbnailUrl,
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

  async getRecordings(userId = null, isAdmin = false) {
    let sql = `SELECT r.*, u.username as owner_username FROM recordings r LEFT JOIN users u ON r.user_id = u.id`;
    const params = [];

    if (!isAdmin) {
      // Normal user only sees non-deleted recordings (or their own)
      sql += ` WHERE (r.user_deleted = 0 OR r.user_deleted IS NULL)`;
      if (userId) {
        sql += ` AND (r.user_id = ? OR r.user_id IS NULL)`;
        params.push(userId);
      }
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
      return {
        id: r.id,
        userId: r.user_id,
        ownerUsername: r.owner_username || 'Guest / Direct',
        username: r.username,
        title: r.title || `Live Stream`,
        filename: r.filename,
        downloadUrl: `/recordings/${r.filename}`,
        thumbnailUrl: r.thumbnail_url || (thumbExists ? `/recordings/${thumbFile}` : null),
        fileSizeBytes: r.file_size_bytes,
        fileSizeFormatted: formatSize(r.file_size_bytes),
        durationSeconds: r.duration_seconds,
        durationFormatted: formatDuration(r.duration_seconds),
        userDeleted: !!r.user_deleted,
        createdAt: r.created_at,
        dateFormatted: new Date(r.created_at).toLocaleDateString('en-US', {
          day: 'numeric',
          month: 'short',
          hour: 'numeric',
          minute: '2-digit'
        })
      };
    });
  }

  // Soft delete for regular user: disappears from their dashboard, but preserved for Admin!
  async userDeleteRecording(id, userId = null) {
    let sql = `UPDATE recordings SET user_deleted = 1 WHERE id = ?`;
    const params = [id];
    if (userId) {
      sql += ` AND (user_id = ? OR user_id IS NULL)`;
      params.push(userId);
    }
    const res = await db.run(sql, params);
    if (!res.changes) throw new Error('Recording not found');
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

module.exports = new LiveRecorderService();
