// ==UserScript==
// @name         Waurks Anti-Botter for Roblox
// @namespace    https://waurks.app/
// @version      2.1.0
// @description  Automated, uncrackable bot protection for your Roblox friend requests. Auto-declines scam bots, auto-accepts real players.
// @author       Waurks Security
// @match        https://www.roblox.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @run-at       document-end
// ==/UserScript==

(function () {
  'use strict';

  // Configurable backend URL (Default to local server or hosted Waurks domain)
  const API_BASE = 'http://localhost:3000';

  // Local storage keys
  const STORAGE_KEY = 'waurks_license_key';
  const STORAGE_HWID = 'waurks_client_hwid';

  // State
  let licenseKey = (typeof GM_getValue !== 'undefined' ? GM_getValue(STORAGE_KEY, '') : localStorage.getItem(STORAGE_KEY)) || '';
  let clientHwid = (typeof GM_getValue !== 'undefined' ? GM_getValue(STORAGE_HWID, '') : localStorage.getItem(STORAGE_HWID)) || '';
  let isScanning = false;
  let autoLoop = false;
  let autoLoopTimer = null;
  let csrfToken = null;
  let licenseStatus = { valid: false, message: 'No key entered' };

  // Settings
  let settings = {
    autoDeclineBots: true,
    autoAcceptPlayers: true,
    holdReview: true,
    delayMs: 2500 // Safe delay between Roblox API calls to prevent rate-limits
  };

  // Generate unique client HWID if not present
  if (!clientHwid) {
    clientHwid = 'HWID-' + Math.random().toString(36).substring(2, 10).toUpperCase() + '-' + Date.now().toString(36).toUpperCase();
    if (typeof GM_setValue !== 'undefined') GM_setValue(STORAGE_HWID, clientHwid);
    else localStorage.setItem(STORAGE_HWID, clientHwid);
  }

  // -------------------------------------------------------------
  // STYLES & UI INJECTION
  // -------------------------------------------------------------
  const styles = `
    #waurks-widget {
      position: fixed;
      bottom: 24px;
      right: 24px;
      width: 380px;
      max-height: 600px;
      background: #101622;
      border: 1px solid #26334d;
      border-radius: 16px;
      box-shadow: 0 12px 40px rgba(0, 0, 0, 0.7), 0 0 0 1px rgba(77, 141, 255, 0.2);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      color: #e8edf6;
      z-index: 999999;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      font-size: 13px;
      transition: all 0.2s ease;
    }
    #waurks-widget.minimized {
      height: 48px;
      width: 220px;
      overflow: hidden;
    }
    .waurks-header {
      background: #141c2c;
      padding: 12px 16px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      border-bottom: 1px solid #26334d;
      cursor: pointer;
      user-select: none;
    }
    .waurks-brand {
      display: flex;
      align-items: center;
      gap: 8px;
      font-weight: 700;
      font-size: 14px;
      color: #ffffff;
    }
    .waurks-badge-status {
      font-size: 11px;
      padding: 3px 8px;
      border-radius: 20px;
      font-weight: 600;
      background: #2a354c;
      color: #8b97ad;
    }
    .waurks-badge-status.active {
      background: rgba(52, 209, 126, 0.15);
      color: #34d17e;
      border: 1px solid rgba(52, 209, 126, 0.3);
    }
    .waurks-badge-status.invalid {
      background: rgba(255, 77, 94, 0.15);
      color: #ff4d5e;
      border: 1px solid rgba(255, 77, 94, 0.3);
    }
    .waurks-content {
      padding: 14px;
      display: flex;
      flex-direction: column;
      gap: 12px;
      overflow-y: auto;
      max-height: 520px;
    }
    .waurks-input-group {
      display: flex;
      gap: 6px;
    }
    .waurks-input {
      flex: 1;
      background: #090d15;
      border: 1px solid #26334d;
      border-radius: 8px;
      padding: 8px 10px;
      color: #e8edf6;
      font-size: 12px;
      outline: none;
    }
    .waurks-input:focus {
      border-color: #4d8dff;
    }
    .waurks-btn {
      background: #4d8dff;
      color: #ffffff;
      border: none;
      padding: 8px 14px;
      border-radius: 8px;
      font-weight: 600;
      font-size: 12px;
      cursor: pointer;
      transition: 0.15s;
    }
    .waurks-btn:hover {
      filter: brightness(1.1);
    }
    .waurks-btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    .waurks-btn-action {
      background: #34d17e;
      color: #0a0e16;
      font-weight: 700;
      padding: 10px;
      width: 100%;
    }
    .waurks-btn-stop {
      background: #ff4d5e;
      color: #fff;
    }
    .waurks-stats {
      display: grid;
      grid-template-columns: 1fr 1fr 1fr;
      gap: 8px;
      background: #141c2c;
      padding: 10px;
      border-radius: 10px;
      border: 1px solid #26334d;
      text-align: center;
    }
    .waurks-stat-val {
      font-size: 16px;
      font-weight: 800;
      font-family: monospace;
    }
    .waurks-stat-lbl {
      font-size: 10px;
      color: #8b97ad;
      text-transform: uppercase;
      margin-top: 2px;
    }
    .waurks-options {
      display: flex;
      flex-direction: column;
      gap: 6px;
      background: #141c2c;
      padding: 10px;
      border-radius: 10px;
      border: 1px solid #26334d;
    }
    .waurks-opt-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-size: 12px;
    }
    .waurks-opt-item input[type="checkbox"] {
      cursor: pointer;
      accent-color: #4d8dff;
    }
    .waurks-log {
      max-height: 140px;
      overflow-y: auto;
      background: #090d15;
      border: 1px solid #26334d;
      border-radius: 8px;
      padding: 8px;
      font-family: monospace;
      font-size: 11px;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .waurks-log-entry {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 2px 0;
      border-bottom: 1px solid #1a2234;
    }
    .waurks-log-entry.block { color: #ff6b7a; }
    .waurks-log-entry.pass { color: #51e69b; }
    .waurks-log-entry.review { color: #f0b429; }
    .waurks-min-toggle {
      background: transparent;
      border: none;
      color: #8b97ad;
      cursor: pointer;
      font-size: 14px;
    }
  `;

  // Inject styles
  const styleEl = document.createElement('style');
  styleEl.innerHTML = styles;
  document.head.appendChild(styleEl);

  // Stats Counters
  let stats = {
    blocked: 0,
    accepted: 0,
    reviewed: 0
  };

  // Build and insert HTML
  const widget = document.createElement('div');
  widget.id = 'waurks-widget';
  widget.innerHTML = `
    <div class="waurks-header" id="waurksHeader">
      <div class="waurks-brand">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M12 2l8 3v6c0 5-3.5 8.5-8 11-4.5-2.5-8-6-8-11V5l8-3z" fill="#4d8dff" fill-opacity=".3" stroke="#4d8dff" stroke-width="1.8"/><path d="M8.5 12l2.5 2.5 4.5-5" stroke="#34d17e" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>
        Waurks Anti-Botter
      </div>
      <div style="display:flex;align-items:center;gap:8px">
        <span class="waurks-badge-status" id="waurksStatusBadge">CHECKING...</span>
        <button class="waurks-min-toggle" id="waurksMinToggle">▼</button>
      </div>
    </div>
    <div class="waurks-content" id="waurksContent">
      <!-- License Key Row -->
      <div>
        <label style="font-size:11px;color:#8b97ad;margin-bottom:4px;display:block;">LICENSE KEY</label>
        <div class="waurks-input-group">
          <input type="text" id="waurksKeyInput" class="waurks-input" placeholder="WAURKS-XXXX-XXXX-XXXX-XXXX" value="${licenseKey}">
          <button class="waurks-btn" id="waurksActivateBtn">Activate</button>
        </div>
        <div id="waurksKeyInfo" style="font-size:11px;color:#8b97ad;margin-top:4px;">Checking key status...</div>
      </div>

      <!-- Quick Stats -->
      <div class="waurks-stats">
        <div>
          <div class="waurks-stat-val" id="statBlocked" style="color:#ff4d5e">0</div>
          <div class="waurks-stat-lbl">Bots Blocked</div>
        </div>
        <div>
          <div class="waurks-stat-val" id="statAccepted" style="color:#34d17e">0</div>
          <div class="waurks-stat-lbl">Real Players</div>
        </div>
        <div>
          <div class="waurks-stat-val" id="statReviewed" style="color:#f0b429">0</div>
          <div class="waurks-stat-lbl">Review Held</div>
        </div>
      </div>

      <!-- Settings -->
      <div class="waurks-options">
        <label class="waurks-opt-item">
          <span>Auto-decline spam bots</span>
          <input type="checkbox" id="optDeclineBots" checked>
        </label>
        <label class="waurks-opt-item">
          <span>Auto-accept verified players</span>
          <input type="checkbox" id="optAcceptPlayers" checked>
        </label>
        <label class="waurks-opt-item">
          <span>Hold borderline for review</span>
          <input type="checkbox" id="optHoldReview" checked>
        </label>
        <label class="waurks-opt-item">
          <span>Continuous background monitor</span>
          <input type="checkbox" id="optAutoLoop">
        </label>
      </div>

      <!-- Run Button -->
      <button class="waurks-btn waurks-btn-action" id="waurksRunBtn">Scan Friend Requests</button>

      <!-- Live Activity Log -->
      <div>
        <div style="font-size:11px;color:#8b97ad;margin-bottom:4px;display:flex;justify-content:space-between">
          <span>ACTIVITY LOG</span>
          <span id="waurksLogCount">0 events</span>
        </div>
        <div class="waurks-log" id="waurksLog">
          <div style="color:#62728f">Ready. Enter key and click Scan.</div>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(widget);

  // Elements
  const header = document.getElementById('waurksHeader');
  const minToggle = document.getElementById('waurksMinToggle');
  const keyInput = document.getElementById('waurksKeyInput');
  const activateBtn = document.getElementById('waurksActivateBtn');
  const keyInfo = document.getElementById('waurksKeyInfo');
  const statusBadge = document.getElementById('waurksStatusBadge');
  const runBtn = document.getElementById('waurksRunBtn');
  const logEl = document.getElementById('waurksLog');
  const statBlockedEl = document.getElementById('statBlocked');
  const statAcceptedEl = document.getElementById('statAccepted');
  const statReviewedEl = document.getElementById('statReviewed');
  const optDeclineBots = document.getElementById('optDeclineBots');
  const optAcceptPlayers = document.getElementById('optAcceptPlayers');
  const optHoldReview = document.getElementById('optHoldReview');
  const optAutoLoop = document.getElementById('optAutoLoop');

  // Minimize toggle
  let isMinimized = false;
  minToggle.addEventListener('click', (e) => {
    e.stopPropagation();
    isMinimized = !isMinimized;
    widget.classList.toggle('minimized', isMinimized);
    minToggle.textContent = isMinimized ? '▲' : '▼';
  });

  // Log function
  function appendLog(text, type = 'info') {
    const entry = document.createElement('div');
    entry.className = `waurks-log-entry ${type}`;
    const time = new Date().toLocaleTimeString().split(' ')[0];
    entry.innerHTML = `<span>[${time}] ${text}</span>`;
    logEl.prepend(entry);
    if (logEl.children.length > 50) logEl.removeChild(logEl.lastChild);
  }

  // -------------------------------------------------------------
  // KEY ACTIVATION & SERVER VERIFICATION
  // -------------------------------------------------------------
  async function verifyKey(keyToTest) {
    if (!keyToTest) {
      statusBadge.textContent = 'NO KEY';
      statusBadge.className = 'waurks-badge-status invalid';
      keyInfo.textContent = 'Enter a valid Waurks key to begin';
      keyInfo.style.color = '#ff4d5e';
      licenseStatus = { valid: false };
      return false;
    }

    try {
      const resp = await fetch(`${API_BASE}/api/v1/keys/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: keyToTest, hwid: clientHwid })
      });
      const data = await resp.json();

      if (data.valid) {
        statusBadge.textContent = 'ACTIVE';
        statusBadge.className = 'waurks-badge-status active';
        keyInfo.textContent = `Active (${data.tier}) — ${data.daysRemaining} days remaining`;
        keyInfo.style.color = '#34d17e';
        licenseKey = keyToTest;
        licenseStatus = { valid: true, ...data };

        if (typeof GM_setValue !== 'undefined') GM_setValue(STORAGE_KEY, keyToTest);
        else localStorage.setItem(STORAGE_KEY, keyToTest);

        appendLog(`Key verified. Tier: ${data.tier}, Days: ${data.daysRemaining}`, 'pass');
        return true;
      } else {
        statusBadge.textContent = data.expired ? 'EXPIRED' : 'INVALID';
        statusBadge.className = 'waurks-badge-status invalid';
        keyInfo.textContent = data.reason || 'Invalid license key';
        keyInfo.style.color = '#ff4d5e';
        licenseStatus = { valid: false };
        appendLog(`Key check failed: ${data.reason}`, 'block');
        return false;
      }
    } catch (e) {
      statusBadge.textContent = 'OFFLINE';
      statusBadge.className = 'waurks-badge-status invalid';
      keyInfo.textContent = 'Cannot reach Waurks security server';
      keyInfo.style.color = '#ff4d5e';
      licenseStatus = { valid: false };
      return false;
    }
  }

  activateBtn.addEventListener('click', () => {
    verifyKey(keyInput.value.trim());
  });

  // Verify stored key on start
  if (licenseKey) {
    verifyKey(licenseKey);
  } else {
    statusBadge.textContent = 'NO KEY';
    statusBadge.className = 'waurks-badge-status invalid';
    keyInfo.textContent = 'Get a key from Waurks site to activate';
  }

  // -------------------------------------------------------------
  // ROBLOX API HELPERS (CSRF, REQUESTS, ACCEPT/DECLINE)
  // -------------------------------------------------------------
  async function fetchWithCsrf(url, options = {}) {
    options.headers = options.headers || {};
    options.credentials = 'include';
    if (csrfToken) {
      options.headers['x-csrf-token'] = csrfToken;
    }

    let response = await fetch(url, options);

    // Roblox requires a fresh x-csrf-token header for state-changing POST requests
    if (response.status === 403 && response.headers.get('x-csrf-token')) {
      csrfToken = response.headers.get('x-csrf-token');
      options.headers['x-csrf-token'] = csrfToken;
      response = await fetch(url, options);
    }

    return response;
  }

  async function getPendingFriendRequests() {
    try {
      const resp = await fetchWithCsrf('https://friends.roblox.com/v1/my/friends/requests?limit=25&sortOrder=Desc');
      if (!resp.ok) throw new Error(`Roblox Friends API HTTP ${resp.status}`);
      const data = await resp.json();
      return data.data || [];
    } catch (e) {
      appendLog(`Error fetching pending requests: ${e.message}`, 'block');
      return [];
    }
  }

  async function getUserProfile(userId) {
    try {
      const resp = await fetch(`https://users.roblox.com/v1/users/${userId}`);
      if (!resp.ok) return null;
      return await resp.json();
    } catch (e) {
      return null;
    }
  }

  async function declineFriend(userId) {
    return await fetchWithCsrf(`https://friends.roblox.com/v1/users/${userId}/decline-friend-request`, {
      method: 'POST'
    });
  }

  async function acceptFriend(userId) {
    return await fetchWithCsrf(`https://friends.roblox.com/v1/users/${userId}/accept-friend-request`, {
      method: 'POST'
    });
  }

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // -------------------------------------------------------------
  // THE SECURE SCAN & FILTER PIPELINE
  // The client sends candidate requests to Waurks server-side
  // engine. Without a valid key, server returns 401 and rejects!
  // -------------------------------------------------------------
  async function runScan() {
    if (isScanning) return;
    if (!licenseStatus.valid) {
      appendLog('Valid license key required to scan.', 'block');
      alert('Waurks: Please enter an active license key to start anti-bot protection.');
      return;
    }

    isScanning = true;
    runBtn.textContent = 'Scanning...';
    runBtn.classList.add('waurks-btn-stop');

    try {
      appendLog('Fetching pending Roblox friend requests...', 'info');
      const pending = await getPendingFriendRequests();

      if (pending.length === 0) {
        appendLog('No pending friend requests found.', 'info');
        finishScan();
        return;
      }

      appendLog(`Found ${pending.length} pending request(s). Gathering profiles...`, 'info');

      // Fetch user profile metadata
      const candidateProfiles = [];
      for (const item of pending) {
        const profile = await getUserProfile(item.id);
        if (profile) {
          candidateProfiles.push({
            id: profile.id,
            name: profile.name,
            displayName: profile.displayName,
            description: profile.description,
            created: profile.created,
            isBanned: profile.isBanned
          });
        }
      }

      // Submit to Waurks Server-Side Heuristic Oracle
      appendLog('Sending to Waurks Cloud Threat Engine...', 'info');
      const evalResp = await fetch(`${API_BASE}/api/v1/scan/evaluate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${licenseKey}`,
          'x-hwid': clientHwid
        },
        body: JSON.stringify({ profiles: candidateProfiles })
      });

      if (!evalResp.ok) {
        const err = await evalResp.json();
        throw new Error(err.error || `Server HTTP ${evalResp.status}`);
      }

      const evalData = await evalResp.json();
      appendLog(`Threat analysis complete. Processing actions safely...`, 'info');

      for (const item of evalData.evaluations) {
        if (item.verdict === 'DECLINE') {
          if (optDeclineBots.checked) {
            appendLog(`[BOT BLOCKED] ${item.name} (${item.reasons[0]})`, 'block');
            await declineFriend(item.id);
            stats.blocked++;
            statBlockedEl.textContent = stats.blocked;
          } else {
            appendLog(`[BOT DETECTED] ${item.name} (Auto-decline off)`, 'block');
          }
        } else if (item.verdict === 'ACCEPT') {
          if (optAcceptPlayers.checked) {
            appendLog(`[PLAYER ACCEPTED] ${item.name}`, 'pass');
            await acceptFriend(item.id);
            stats.accepted++;
            statAcceptedEl.textContent = stats.accepted;
          } else {
            appendLog(`[PLAYER DETECTED] ${item.name} (Auto-accept off)`, 'pass');
          }
        } else {
          appendLog(`[REVIEW QUEUED] ${item.name} (${item.reasons[0]})`, 'review');
          stats.reviewed++;
          statReviewedEl.textContent = stats.reviewed;
        }

        // Safety throttle between actions
        await sleep(settings.delayMs);
      }

      appendLog(`Batch finished: ${evalData.summary.botsDetected} bots, ${evalData.summary.playersApproved} players.`, 'pass');
    } catch (err) {
      appendLog(`Scan aborted: ${err.message}`, 'block');
    } finally {
      finishScan();
    }
  }

  function finishScan() {
    isScanning = false;
    runBtn.textContent = 'Scan Friend Requests';
    runBtn.classList.remove('waurks-btn-stop');
  }

  runBtn.addEventListener('click', () => {
    if (isScanning) {
      isScanning = false;
      finishScan();
    } else {
      runScan();
    }
  });

  // Background Auto-loop toggle
  optAutoLoop.addEventListener('change', (e) => {
    autoLoop = e.target.checked;
    if (autoLoop) {
      appendLog('Continuous monitoring enabled (every 60s).', 'pass');
      autoLoopTimer = setInterval(() => {
        if (!isScanning) runScan();
      }, 60000);
    } else {
      appendLog('Continuous monitoring paused.', 'info');
      if (autoLoopTimer) clearInterval(autoLoopTimer);
    }
  });

  console.log('[Waurks] Anti-Botter extension initialized.');
})();

