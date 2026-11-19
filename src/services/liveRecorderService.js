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

class LiveRecorderService {
  constructor() {
    this.activeJobs = new Map(); // jobId -> job details
  }

  async checkStatus(username) {
    const user = cleanUsername(username);
    if (!user) return { username: '', is_live: false, message: 'Invalid username' };

    const url = `https://www.tiktok.com/@${user}/live`;

    return new Promise(resolve => {
      const proc = spawn('python', ['-m', 'streamlink', '--json', url], { timeout: 15000 });
      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', d => { stdout += d.toString(); });
      proc.stderr.on('data', d => { stderr += d.toString(); });

      proc.on('close', code => {
        let isLive = false;
        try {
          const parsed = JSON.parse(stdout);
          if (parsed && (parsed.streams || parsed.metadata)) {
            isLive = true;
          }
        } catch (e) {
          if (stdout.includes('"streams":') || stdout.includes('"best":')) {
            isLive = true;
          }
        }

        resolve({
          username: user,
          is_live: isLive,
          url,
          message: isLive ? `@${user} is LIVE right now!` : `@${user} is currently offline.`
        });
      });

      proc.on('error', err => {
        resolve({ username: user, is_live: false, url, error: err.message });
      });
    });
  }

  async startRecording(userId, username) {
    const user = cleanUsername(username);
    if (!user) throw new Error('Valid username required');

    // Check if job already active for this username
    for (const [id, j] of this.activeJobs.entries()) {
      if (j.username.toLowerCase() === user.toLowerCase() && j.status === 'recording') {
        return this.formatJob(j);
      }
    }

    const timestamp = Date.now();
    const jobId = `${user}_${timestamp}`;
    const filename = `${jobId}.mp4`;
    const filePath = path.join(RECORDINGS_DIR, filename);
    const url = `https://www.tiktok.com/@${user}/live`;

    const args = [
      '-m', 'streamlink',
      '--loglevel', 'info',
      '--force',
      url,
      'best',
      '-o', filePath
    ];

    const proc = spawn('python', args, {
      windowsHide: true,
      detached: false
    });

    const job = {
      jobId,
      userId: userId || null,
      username: user,
      filename,
      filePath,
      process: proc,
      startTime: Date.now(),
      status: 'recording',
      error: null
    };

    proc.stdout.on('data', data => {
      const str = data.toString();
      if (str.includes('error') || str.includes('No playable streams')) {
        job.error = str.trim();
      }
    });

    proc.stderr.on('data', data => {
      const str = data.toString();
      if (str.includes('error') || str.includes('No playable streams')) {
        job.error = str.trim();
      }
    });

    proc.on('close', async () => {
      if (this.activeJobs.has(jobId)) {
        await this.finishJob(jobId);
      }
    });

    this.activeJobs.set(jobId, job);
    return this.formatJob(job);
  }

  async stopRecording(jobId) {
    const job = this.activeJobs.get(jobId);
    if (!job) throw new Error('Recording job not found');

    if (job.process && !job.process.killed) {
      try {
        if (process.platform === 'win32') {
          exec(`taskkill /pid ${job.process.pid} /t /f`);
        } else {
          job.process.kill('SIGTERM');
        }
      } catch (e) {
        console.error('Error stopping streamlink process:', e);
      }
    }

    return await this.finishJob(jobId);
  }

  async finishJob(jobId) {
    const job = this.activeJobs.get(jobId);
    if (!job) return null;

    job.status = 'finished';
    this.activeJobs.delete(jobId);

    let fileSize = 0;
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
        [job.userId, job.username, `TikTok Live Stream (@${job.username})`, job.filename, job.filePath, fileSize, durationSeconds]
      );
      savedRow = await db.get(`SELECT * FROM recordings WHERE id = ?`, [res.lastID]);
    } catch (err) {
      console.error('Error inserting recording record:', err);
    }

    return {
      jobId: job.jobId,
      id: savedRow ? savedRow.id : null,
      username: job.username,
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
    let currentSize = 0;
    try {
      if (fs.existsSync(job.filePath)) {
        currentSize = fs.statSync(job.filePath).size;
      }
    } catch (e) {}

    const elapsed = Math.round((Date.now() - job.startTime) / 1000);
    return {
      jobId: job.jobId,
      username: job.username,
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

    await db.run(`DELETE FROM recordings WHERE id = ?`, [id]);
    return { success: true };
  }
}

module.exports = new LiveRecorderService();
