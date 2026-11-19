// DevSupplies TikTok Live Recorder - Frontend Client

const state = {
  activeJobs: [],
  watchers: [],
  savedFiles: [],
};

// DOM Elements
const usernameInput = document.getElementById("usernameInput");
const btnCheckLive = document.getElementById("btnCheckLive");
const btnStartRecord = document.getElementById("btnStartRecord");
const btnWatch = document.getElementById("btnWatch");
const checkResult = document.getElementById("checkResult");

const serverStatusDot = document.getElementById("serverStatusDot");
const serverStatusText = document.getElementById("serverStatusText");

const activeList = document.getElementById("activeList");
const activeCount = document.getElementById("activeCount");
const btnRefreshActive = document.getElementById("btnRefreshActive");

const watchersList = document.getElementById("watchersList");
const watchersCount = document.getElementById("watchersCount");

const savedTableBody = document.getElementById("savedTableBody");
const savedCount = document.getElementById("savedCount");
const btnRefreshSaved = document.getElementById("btnRefreshSaved");

// Modal Elements
const videoModal = document.getElementById("videoModal");
const modalBackdrop = document.getElementById("modalBackdrop");
const btnCloseModal = document.getElementById("btnCloseModal");
const modalVideoTitle = document.getElementById("modalVideoTitle");
const modalDownloadLink = document.getElementById("modalDownloadLink");
const player = document.getElementById("player");

// Helper to format duration in MM:SS or HH:MM:SS
function formatDuration(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const pad = (n) => String(n).padStart(2, "0");
  return h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

// Check Server Health
async function checkHealth() {
  try {
    const res = await fetch("/api/status");
    if (res.ok) {
      serverStatusDot.classList.add("online");
      serverStatusText.textContent = "Server Online";
    } else {
      throw new Error();
    }
  } catch (err) {
    serverStatusDot.classList.remove("online");
    serverStatusText.textContent = "Offline";
  }
}

// Check Live Status
btnCheckLive.addEventListener("click", async () => {
  const user = usernameInput.value.trim();
  if (!user) {
    showCheckAlert("Please enter a TikTok username or URL", "error");
    return;
  }

  showCheckAlert("Checking live status...", "offline");
  btnCheckLive.disabled = true;

  try {
    const res = await fetch("/api/check-live", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: user }),
    });
    const data = await res.json();

    if (data.is_live) {
      showCheckAlert(`● @${data.username} is currently LIVE! Click "Start Recording" to capture now.`, "live");
    } else {
      showCheckAlert(`@${data.username} is currently offline. Use "Auto-Watch" to record automatically when they go live.`, "offline");
    }
  } catch (err) {
    showCheckAlert(`Error checking live status: ${err.message}`, "error");
  } finally {
    btnCheckLive.disabled = false;
  }
});

function showCheckAlert(message, type) {
  checkResult.className = `check-result ${type}`;
  checkResult.textContent = message;
  checkResult.classList.remove("hidden");
}

// Start Recording
btnStartRecord.addEventListener("click", async () => {
  const user = usernameInput.value.trim();
  if (!user) {
    showCheckAlert("Please enter a TikTok username or URL", "error");
    return;
  }

  btnStartRecord.disabled = true;
  try {
    const res = await fetch("/api/record/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: user }),
    });
    const data = await res.json();
    showCheckAlert(`Recording launched for @${data.job.username}!`, "live");
    fetchJobs();
  } catch (err) {
    showCheckAlert(`Failed to start recording: ${err.message}`, "error");
  } finally {
    btnStartRecord.disabled = false;
  }
});

// Auto-Watch Streamer
btnWatch.addEventListener("click", async () => {
  const user = usernameInput.value.trim();
  if (!user) {
    showCheckAlert("Please enter a TikTok username or URL", "error");
    return;
  }

  try {
    const res = await fetch("/api/watchers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: user }),
    });
    const data = await res.json();
    showCheckAlert(`Added @${data.watcher.username} to auto-watchers!`, "live");
    fetchWatchers();
  } catch (err) {
    showCheckAlert(`Failed to add auto-watcher: ${err.message}`, "error");
  }
});

// Fetch Active Jobs
async function fetchJobs() {
  try {
    const res = await fetch("/api/jobs");
    const data = await res.json();
    state.activeJobs = data.jobs.filter((j) => j.status === "starting" || j.status === "recording");
    renderActiveJobs();
  } catch (err) {
    console.error("Failed to fetch jobs:", err);
  }
}

function renderActiveJobs() {
  activeCount.textContent = state.activeJobs.length;

  if (state.activeJobs.length === 0) {
    activeList.innerHTML = `<div class="empty-state">No active recording jobs running right now.</div>`;
    return;
  }

  activeList.innerHTML = state.activeJobs
    .map(
      (job) => `
    <div class="job-card">
      <div class="job-card-header">
        <span class="job-user">@${job.username}</span>
        <span class="live-badge"><span class="rec-dot"></span> REC</span>
      </div>
      <div class="job-stats">
        <span>⏱️ ${formatDuration(job.duration_seconds)}</span>
        <span>💾 ${job.file_size_human}</span>
      </div>
      <button class="btn btn-sm btn-danger" onclick="stopJob('${job.job_id}')">
        Stop Recording
      </button>
    </div>
  `
    )
    .join("");
}

// Stop Job
window.stopJob = async function (jobId) {
  try {
    const res = await fetch("/api/record/stop", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ job_id: jobId }),
    });
    await res.json();
    fetchJobs();
    fetchSavedRecordings();
  } catch (err) {
    alert(`Failed to stop job: ${err.message}`);
  }
};

// Fetch Watchers
async function fetchWatchers() {
  try {
    const res = await fetch("/api/watchers");
    const data = await res.json();
    state.watchers = data.watchers;
    renderWatchers();
  } catch (err) {
    console.error("Failed to fetch watchers:", err);
  }
}

function renderWatchers() {
  watchersCount.textContent = state.watchers.length;

  if (state.watchers.length === 0) {
    watchersList.innerHTML = `<div class="empty-state">No creators being watched. Click "Auto-Watch" above to add one.</div>`;
    return;
  }

  watchersList.innerHTML = state.watchers
    .map(
      (w) => `
    <div class="watcher-chip ${w.is_live ? "live" : ""}">
      <span class="dot"></span>
      <span>@${w.username}</span>
      <span style="font-size: 11px; color: ${w.is_live ? "var(--accent-green)" : "var(--text-dim)"}">
        ${w.is_live ? "LIVE" : "Watching"}
      </span>
      <button class="watcher-remove-btn" title="Remove watcher" onclick="removeWatcher('${w.username}')">&times;</button>
    </div>
  `
    )
    .join("");
}

// Remove Watcher
window.removeWatcher = async function (username) {
  try {
    await fetch(`/api/watchers/${encodeURIComponent(username)}`, { method: "DELETE" });
    fetchWatchers();
  } catch (err) {
    alert(`Failed to remove watcher: ${err.message}`);
  }
};

// Fetch Saved Recordings
async function fetchSavedRecordings() {
  try {
    const res = await fetch("/api/recordings/saved");
    const data = await res.json();
    state.savedFiles = data.files;
    renderSavedRecordings();
  } catch (err) {
    console.error("Failed to fetch saved recordings:", err);
  }
}

function renderSavedRecordings() {
  savedCount.textContent = state.savedFiles.length;

  if (state.savedFiles.length === 0) {
    savedTableBody.innerHTML = `<tr><td colspan="4" class="empty-state">No recordings found. Completed recordings will appear here.</td></tr>`;
    return;
  }

  savedTableBody.innerHTML = state.savedFiles
    .map(
      (file) => `
    <tr>
      <td style="font-weight: 600;">${file.filename}</td>
      <td style="color: var(--text-dim);">${file.modified_readable}</td>
      <td>${file.size_human}</td>
      <td>
        <div class="table-actions">
          <button class="btn btn-sm btn-secondary" onclick="openPreview('${file.filename}', '${file.stream_url}', '${file.download_url}')">Preview</button>
          <a class="btn btn-sm btn-primary" href="${file.download_url}" download="${file.filename}">Download</a>
          <button class="btn btn-sm btn-danger" onclick="deleteFile('${file.filename}')">Delete</button>
        </div>
      </td>
    </tr>
  `
    )
    .join("");
}

// Delete File
window.deleteFile = async function (filename) {
  if (!confirm(`Are you sure you want to delete ${filename}?`)) return;
  try {
    await fetch(`/api/recordings/${encodeURIComponent(filename)}`, { method: "DELETE" });
    fetchSavedRecordings();
  } catch (err) {
    alert(`Failed to delete recording: ${err.message}`);
  }
};

// Video Modal Preview
window.openPreview = function (filename, streamUrl, downloadUrl) {
  modalVideoTitle.textContent = filename;
  player.src = streamUrl;
  modalDownloadLink.href = downloadUrl;
  modalDownloadLink.setAttribute("download", filename);
  videoModal.classList.remove("hidden");
  player.play().catch(() => {});
};

function closeModal() {
  player.pause();
  player.src = "";
  videoModal.classList.add("hidden");
}

btnCloseModal.addEventListener("click", closeModal);
modalBackdrop.addEventListener("click", closeModal);

// Refresh Buttons
btnRefreshActive.addEventListener("click", fetchJobs);
btnRefreshSaved.addEventListener("click", fetchSavedRecordings);

// Initial Load & Periodic Pollers
checkHealth();
fetchJobs();
fetchWatchers();
fetchSavedRecordings();

setInterval(checkHealth, 10000);
setInterval(fetchJobs, 2000);
setInterval(fetchWatchers, 10000);
setInterval(fetchSavedRecordings, 8000);
