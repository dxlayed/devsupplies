const crypto = require('crypto');
const db = require('../database');
const detectionEngine = require('./detectionEngine');
const robloxProfiles = require('./robloxProfiles');
const presence = require('./presence');
db.run(`ALTER TABLE roblox_accounts ADD COLUMN last_error TEXT`).catch(() => {});
db.run(`ALTER TABLE roblox_accounts ADD COLUMN last_error_at DATETIME`).catch(() => {});
db.run(`ALTER TABLE roblox_accounts ADD COLUMN filter_level TEXT DEFAULT 'normal'`).catch(() => {});
db.run(`CREATE TABLE IF NOT EXISTS friend_requests (
  user_id INTEGER NOT NULL, target_id TEXT NOT NULL, name TEXT, display_name TEXT, avatar_url TEXT,
  verdict TEXT, score INTEGER, reasons TEXT, facts TEXT, status TEXT DEFAULT 'pending', auto INTEGER DEFAULT 0,
  sent_at TEXT, checked_at DATETIME, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, target_id)
)`).catch(() => {});

db.run(`ALTER TABLE roblox_accounts ADD COLUMN accept_filter TEXT DEFAULT 'standard'`).catch(() => {});
const MM2_LEVEL10_BADGE = '196198137'; // Murder Mystery 2 "Level 10"
// Adopt Me (Uplift Games, universe 383310974): any of these badges = plays Adopt Me
const ADOPTME_UNIVERSE = '383310974';
const ADOPTME_GROUP = '295182'; // Uplift Games community
const ADOPTME_BADGES = ['2124439922', '2124439923', '2124439924', '2124439925', '2124439926', '2124439927', '2124439928', '3720272393025103', '2344531550519489'];
const MM2_UNIVERSE = '66654135';
// Words that tag a request's reasons with the game mode it was checked for
const GAME_TAG = { mm2: 'MM2', adoptme: 'Adopt Me' };

db.run(`ALTER TABLE roblox_accounts ADD COLUMN last_check_at DATETIME`).catch(() => {});

db.run(`ALTER TABLE roblox_accounts ADD COLUMN mode TEXT DEFAULT 'cloud'`).catch(() => {});
db.run(`ALTER TABLE roblox_accounts ADD COLUMN scan_requested INTEGER DEFAULT 0`).catch(() => {});
db.run(`ALTER TABLE licenses ADD COLUMN roblox_id TEXT`).catch(() => {});
// Accept/decline clicks from the website, waiting for the customer's extension to carry them out
db.run(`CREATE TABLE IF NOT EXISTS ext_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, target_id TEXT NOT NULL, action TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP, done INTEGER DEFAULT 0
)`).catch(() => {});
db.run(`ALTER TABLE friend_requests ADD COLUMN retry_error TEXT`).catch(() => {});
db.run(`ALTER TABLE friend_requests ADD COLUMN retry_after DATETIME`).catch(() => {});
db.run(`ALTER TABLE friend_requests ADD COLUMN priority INTEGER DEFAULT 0`).catch(() => {});
db.run(`ALTER TABLE ext_actions ADD COLUMN priority INTEGER DEFAULT 0`).catch(() => {});
db.run(`ALTER TABLE ext_actions ADD COLUMN retry_after DATETIME`).catch(() => {});
db.run(`ALTER TABLE ext_actions ADD COLUMN last_error TEXT`).catch(() => {});

// Browser extension sign-in (no key needed): one-time connect codes and per-browser tokens
db.run(`CREATE TABLE IF NOT EXISTS ext_connect (
  code TEXT PRIMARY KEY, device TEXT NOT NULL, user_id INTEGER, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`).catch(() => {});
db.run(`CREATE TABLE IF NOT EXISTS ext_tokens (
  token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL, device TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP, last_used_at DATETIME
)`).catch(() => {});

const isTestCookie = c => c.startsWith('TEST_COOKIE_') || c.startsWith('DEMO_');
const toMs = d => new Date(String(d).replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(String(d)) ? '' : 'Z')).getTime();
const safeJson = (v, dflt) => {
  try {
    const out = JSON.parse(v);
    if (out === null || out === undefined) return dflt;
    if (Array.isArray(dflt) !== Array.isArray(out)) return dflt;
    return out;
  } catch (e) { return dflt; }
};
function isHidden(level, verdict, score) {
  if (verdict === 'DECLINE') return true;
  if (level === 'strict') return verdict !== 'ACCEPT';
  if (level === 'normal') return verdict === 'REVIEW' && score >= 40;
  return false; // relaxed
}
// Fake requests for test accounts (no real Roblox login)
function demoRequests(cookie = '') {
  const d = n => new Date(Date.now() - n * 86400000).toISOString();
  // TEST_COOKIE_FLOOD...: 60 fake requests, to test how a bot flood is handled
  if (cookie.includes('FLOOD')) {
    return Array.from({ length: 60 }, (_, i) => i % 4 === 0
      ? { id: 8100000 + i, name: 'player_' + i, displayName: 'Player ' + i, description: '', created: d(500 + i), badgeCount: 20, friendsCount: 30 }
      : { id: 8100000 + i, name: 'bot' + i + 'xqz', displayName: 'bot' + i, description: 'free robux at rbx-win.xyz', created: d(1), badgeCount: 0, friendsCount: 0 });
  }
  return [
    { id: 9817263, name: 'ClaimRobux_x882', displayName: 'Robux Giveaway', description: 'Visit giftcard.gg/free for 10,000 robux!', created: d(1), badgeCount: 0, friendsCount: 0 },
    { id: 1827364, name: 'BlockyGamer_Ethan', displayName: 'Ethan', description: 'Builder and anime fan', created: d(400), badgeCount: 22, friendsCount: 30 },
    { id: 2938475, name: 'free_rbx_bot99', displayName: 'FreeRobux', description: 'ro-bux generator link in bio', created: d(2), badgeCount: 0, friendsCount: 0 },
    { id: 3847561, name: 'PixelSammy', displayName: 'Sammy', description: 'hello world', created: d(700), badgeCount: 12, friendsCount: 45 },
    { id: 4958672, name: 'mia_plays', displayName: 'Mia', description: '', created: d(5), badgeCount: 1, friendsCount: 2, avatarAssetCount: 4 },
    { id: 5069783, name: 'qwrtzpls8812', displayName: 'qwrtzpls8812', description: '', created: d(9), badgeCount: 0, friendsCount: 0, avatarAssetCount: 1 },
    { id: 7392016, name: 'old_sleeper', displayName: 'Sleeper', description: '', created: d(900), badgeCount: 25, friendsCount: 40, avatarAssetCount: 9, online: false },
    { id: 7503127, name: 'afk_trader', displayName: 'AFK', description: '', created: d(600), badgeCount: 25, friendsCount: 30, mm2: true, online: false },
    { id: 7281905, name: 'kev_trades', displayName: 'Kev', description: '', created: d(3), badgeCount: 12, friendsCount: 1, avatarAssetCount: 3, mm2: true },
    { id: 6170894, name: 'skate_jay', displayName: 'Jay', description: 'new here', created: d(2), badgeCount: 0, friendsCount: 0, avatarAssetCount: 3, paidItem: { name: 'Black Beanie', price: 75 } }
  ];
}
const { keyService } = require('./keyService');

const ENCRYPTION_SECRET = process.env.ENCRYPTION_SECRET || 'waurks-cloud-roblox-vault-secret-key-32b';
// 32 bytes key for AES-256
const CIPHER_KEY = crypto.createHash('sha256').update(ENCRYPTION_SECRET).digest();

class RobloxCloudService {
  constructor() {
    this.csrfCache = new Map(); // robloxId -> csrfToken
    this.daemonInterval = null;
    this.isDaemonRunning = false;
  }

  /**
   * AES-256-CBC Encryption for storing credentials securely at rest
   */
  encrypt(text) {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', CIPHER_KEY, iv);
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    return {
      encrypted,
      iv: iv.toString('hex')
    };
  }

  /**
   * AES-256-CBC Decryption
   */
  decrypt(encryptedHex, ivHex) {
    const iv = Buffer.from(ivHex, 'hex');
    const decipher = crypto.createDecipheriv('aes-256-cbc', CIPHER_KEY, iv);
    let decrypted = decipher.update(encryptedHex, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  }

  /**
   * Verifies and fetches identity and pending request stats for a Roblox .ROBLOSECURITY cookie
   */
  async verifyRobloxCookie(rawCookie) {
    if (!rawCookie || typeof rawCookie !== 'string') {
      throw new Error('Please enter your Roblox .ROBLOSECURITY cookie.');
    }

    // Clean any accidental whitespace, outer quotes, or prefix
    let cookie = rawCookie.trim().replace(/^["']|["']$/g, '');
    if (cookie.startsWith('.ROBLOSECURITY=')) {
      cookie = cookie.slice('.ROBLOSECURITY='.length).trim();
    }

    // Test / Demo cookie format support for local testing without real Roblox login
    if (cookie.startsWith('TEST_COOKIE_') || cookie.startsWith('DEMO_')) {
      const mockName = cookie.replace(/^(TEST_COOKIE_|DEMO_)/, '') || 'RobloxGamer';
      return {
        robloxId: '123456789',
        robloxUsername: mockName,
        displayName: mockName,
        avatarUrl: 'https://tr.rbxcdn.com/30DAY-AvatarHeadshot-123456789/150/150/AvatarHeadshot/Png/isCircular',
        pendingRequestsCount: 4,
        cleanCookie: cookie
      };
    }

    const cookieHeader = `.ROBLOSECURITY=${cookie}`;

    try {
      const response = await fetch('https://users.roblox.com/v1/users/authenticated', {
        headers: {
          'Cookie': cookieHeader,
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      });

      if (!response.ok) {
        throw new Error('Invalid or expired Roblox security cookie. Make sure you copied the entire .ROBLOSECURITY value.');
      }

      const userData = await response.json();
      let avatarUrl = 'https://tr.rbxcdn.com/30DAY-AvatarHeadshot-default/150/150/AvatarHeadshot/Png/isCircular';
      let pendingRequestsCount = 0;

      // 1. Fetch avatar headshot
      try {
        const thumbRes = await fetch(`https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${userData.id}&size=150x150&format=Png&isCircular=true`);
        if (thumbRes.ok) {
          const thumbData = await thumbRes.json();
          if (thumbData.data && thumbData.data[0]?.imageUrl) {
            avatarUrl = thumbData.data[0].imageUrl;
          }
        }
      } catch (e) {}

      // 2. Fetch current pending friend requests count from Roblox
      try {
        const reqCountRes = await fetch('https://friends.roblox.com/v1/my/friends/requests/count', {
          headers: {
            'Cookie': cookieHeader,
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
          }
        });
        if (reqCountRes.ok) {
          const countData = await reqCountRes.json();
          pendingRequestsCount = countData.count || 0;
        }
      } catch (e) {}

      return {
        robloxId: String(userData.id),
        robloxUsername: userData.name,
        displayName: userData.displayName || userData.name,
        avatarUrl,
        pendingRequestsCount,
        cleanCookie: cookie
      };
    } catch (err) {
      throw new Error('Roblox connection error: ' + err.message);
    }
  }

  /**
   * Connects a user's Roblox account to Waurks cloud and kicks off initial scan
   */
  async connectAccount(userId, rawCookie) {
    const verification = await this.verifyRobloxCookie(rawCookie);
    const { encrypted, iv } = this.encrypt(verification.cleanCookie);

    // Check if user already has an active key
    const activeLicense = await db.get(
      `SELECT * FROM licenses WHERE user_id = ? AND status = 'active' AND expires_at > datetime('now') ORDER BY id DESC LIMIT 1`,
      [userId]
    );

    const existing = await db.get(`SELECT * FROM roblox_accounts WHERE user_id = ?`, [userId]);

    if (existing) {
      await db.run(
        `UPDATE roblox_accounts 
         SET roblox_id = ?, roblox_username = ?, avatar_url = ?, encrypted_cookie = ?, cookie_iv = ?, license_id = ?, is_active = 1
         WHERE id = ?`,
        [verification.robloxId, verification.robloxUsername, verification.avatarUrl, encrypted, iv, activeLicense?.id || null, existing.id]
      );
    } else {
      await db.run(
        `INSERT INTO roblox_accounts (user_id, license_id, roblox_id, roblox_username, avatar_url, encrypted_cookie, cookie_iv, is_active, auto_accept_players)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0)`,
        [userId, activeLicense?.id || null, verification.robloxId, verification.robloxUsername, verification.avatarUrl, encrypted, iv]
      );
    }

    // Auto-trigger immediate initial scan if active license is present
    if (activeLicense) {
      setTimeout(() => {
        this.runCloudScan(userId).catch(() => {});
      }, 500);
    }

    const status = await this.getAccountStatus(userId);
    return {
      ...status,
      pendingRequestsCount: verification.pendingRequestsCount
    };
  }

  /**
   * Retrieves connected Roblox account status and stats for dashboard
   */
  async getAccountStatus(userId) {
    const account = await db.get(
      `SELECT ra.*, l.key_code, l.tier, l.expires_at as key_expires_at, l.status as license_status
       FROM roblox_accounts ra
       LEFT JOIN licenses l ON ra.license_id = l.id
       WHERE ra.user_id = ?`,
      [userId]
    );

    if (!account) return { connected: false };

    // Fetch recent 15 activity logs
    const logs = await db.all(
      `SELECT * FROM scan_activity_logs WHERE user_id = ? ORDER BY id DESC LIMIT 15`,
      [userId]
    );

    const stats = await db.get(
      `SELECT 
        COUNT(*) as total_scanned,
        SUM(CASE WHEN verdict = 'DECLINE' THEN 1 ELSE 0 END) as bots_declined,
        SUM(CASE WHEN verdict = 'ACCEPT' THEN 1 ELSE 0 END) as players_accepted,
        SUM(CASE WHEN verdict = 'REVIEW' THEN 1 ELSE 0 END) as held_review
       FROM scan_activity_logs WHERE user_id = ?`,
      [userId]
    );

    return {
      connected: true,
      account: {
        id: account.id,
        robloxId: account.roblox_id,
        robloxUsername: account.roblox_username,
        avatarUrl: account.avatar_url,
        isActive: !!account.is_active,
        autoDeclineBots: !!account.auto_decline_bots,
        autoAcceptPlayers: !!account.auto_accept_players,
        holdReview: !!account.hold_review,
        minAccountAgeDays: account.min_account_age_days || 7,
        minBadges: account.min_badges || 0,
        customBlacklist: account.custom_blacklist || '',
        customWhitelist: account.custom_whitelist || '',
        lastScanAt: account.last_scan_at,
        lastError: account.last_error || null,
        mode: account.mode || 'cloud',
        extensionOnline: account.mode === 'extension' && !!account.last_check_at
          && Date.now() - new Date(String(account.last_check_at).replace(' ', 'T') + 'Z').getTime() < 45000,
        lastCheckAt: account.last_check_at || null,
        licenseKey: account.key_code,
        licenseTier: account.tier,
        keyExpiresAt: account.key_expires_at
      },
      stats: {
        totalScanned: stats?.total_scanned || 0,
        botsDeclined: stats?.bots_declined || 0,
        playersAccepted: stats?.players_accepted || 0,
        heldReview: stats?.held_review || 0
      },
      logs
    };
  }

  /**
   * Updates custom filtering rules
   */
  async updateCustomFilters(userId, { minAccountAgeDays = 7, minBadges = 0, customBlacklist = '', customWhitelist = '' }) {
    await db.run(
      `UPDATE roblox_accounts 
       SET min_account_age_days = ?, min_badges = ?, custom_blacklist = ?, custom_whitelist = ? 
       WHERE user_id = ?`,
      [parseInt(minAccountAgeDays) || 7, parseInt(minBadges) || 0, customBlacklist.trim(), customWhitelist.trim(), userId]
    );
    return { success: true };
  }

  /**
   * Retrieves pending borderline review requests
   */
  async getReviewQueue(userId) {
    const queue = await db.all(
      `SELECT * FROM review_queue WHERE user_id = ? AND status = 'pending' ORDER BY id DESC`,
      [userId]
    );
    return queue;
  }

  /**
   * Manually resolves a review item (Accept / Decline from the website dashboard)
   */
  async resolveReviewItem(userId, reviewId, action) {
    const item = await db.get(`SELECT * FROM review_queue WHERE id = ? AND user_id = ?`, [reviewId, userId]);
    if (!item) throw new Error('Review item not found');

    const account = await db.get(`SELECT * FROM roblox_accounts WHERE user_id = ?`, [userId]);
    if (!account) throw new Error('No connected Roblox account');

    const cookie = this.decrypt(account.encrypted_cookie, account.cookie_iv);

    if (action.toUpperCase() === 'ACCEPT') {
      if (!cookie.startsWith('TEST_COOKIE_') && !cookie.startsWith('DEMO_')) {
        await this.robloxRequest(
          `https://friends.roblox.com/v1/users/${item.target_id}/accept-friend-request`,
          'POST',
          cookie,
          null,
          account.roblox_id
        );
      }
      await db.run(`UPDATE review_queue SET status = 'accepted' WHERE id = ?`, [reviewId]);
      await detectionEngine.recordReport(item.target_id, userId, false);
      await db.run(
        `INSERT INTO scan_activity_logs (user_id, roblox_id, target_id, target_username, verdict, threat_score, reason)
         VALUES (?, ?, ?, ?, 'ACCEPT', ?, 'Approved manually via Dashboard Review Tray')`,
        [userId, account.roblox_id, item.target_id, item.target_username, item.threat_score]
      );
    } else {
      if (!cookie.startsWith('TEST_COOKIE_') && !cookie.startsWith('DEMO_')) {
        await this.robloxRequest(
          `https://friends.roblox.com/v1/users/${item.target_id}/decline-friend-request`,
          'POST',
          cookie,
          null,
          account.roblox_id
        );
      }
      await db.run(`UPDATE review_queue SET status = 'declined' WHERE id = ?`, [reviewId]);
      await detectionEngine.recordReport(item.target_id, userId, true);
      await db.run(
        `INSERT INTO scan_activity_logs (user_id, roblox_id, target_id, target_username, verdict, threat_score, reason)
         VALUES (?, ?, ?, ?, 'DECLINE', ?, 'Declined manually via Dashboard Review Tray')`,
        [userId, account.roblox_id, item.target_id, item.target_username, item.threat_score]
      );
    }

    return { success: true, action: action.toUpperCase() };
  }

  /**
   * Toggles 24/7 background protection active status
   */
  async toggleProtection(userId, isActive) {
    await db.run(`UPDATE roblox_accounts SET is_active = ? WHERE user_id = ?`, [isActive ? 1 : 0, userId]);
    return { success: true, isActive: !!isActive };
  }

  /**
   * Updates protection settings
   */
  async updateSettings(userId, { autoDeclineBots, autoAcceptPlayers, holdReview }) {
    await db.run(
      `UPDATE roblox_accounts 
       SET auto_decline_bots = ?, auto_accept_players = ?, hold_review = ? 
       WHERE user_id = ?`,
      [autoDeclineBots ? 1 : 0, autoAcceptPlayers ? 1 : 0, holdReview ? 1 : 0, userId]
    );
    return { success: true };
  }

  /**
   * Disconnects a Roblox account from the cloud
   */
  async disconnectAccount(userId) {
    await db.run(`DELETE FROM roblox_accounts WHERE user_id = ?`, [userId]);
    return { success: true };
  }

  /**
   * Helper to perform authenticated Roblox requests with auto-renewing CSRF tokens
   */
  async robloxRequest(url, method, cookie, body = null, robloxId = null) {
    const cleanCookie = cookie.startsWith('.ROBLOSECURITY=') ? cookie : `.ROBLOSECURITY=${cookie}`;
    let csrf = this.csrfCache.get(robloxId);

    const headers = {
      'Cookie': cleanCookie,
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    };
    if (csrf) headers['x-csrf-token'] = csrf;

    let response = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined
    });

    // If 403, Roblox returns the required x-csrf-token header for future state changes
    if (response.status === 403 && response.headers.get('x-csrf-token')) {
      csrf = response.headers.get('x-csrf-token');
      this.csrfCache.set(robloxId, csrf);
      headers['x-csrf-token'] = csrf;
      response = await fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined
      });
    }

    return response;
  }

  /**
   * Scans an account and executes real-time bot filtering in the cloud
   */
  async runCloudScan(userId, opts = {}) {
    // One check at a time per account (the automatic watcher and the Scan now button can overlap)
    this.activeScans = this.activeScans || new Set();
    if (this.activeScans.has(userId)) {
      if (opts.force) { const e = new Error('Already checking, give it a few seconds'); e.busy = true; throw e; }
      return { scanned: 0, botsDeclined: 0, playersAccepted: 0, heldReview: 0 };
    }
    this.activeScans.add(userId);
    try {
      return await this._runCloudScan(userId, opts);
    } finally {
      this.activeScans.delete(userId);
    }
  }

  async _runCloudScan(userId, opts = {}) {
    const account = await db.get(
      `SELECT ra.*, l.key_code, l.id as license_id, l.expires_at, l.status as license_status 
       FROM roblox_accounts ra
       LEFT JOIN licenses l ON ra.license_id = l.id
       WHERE ra.user_id = ?`,
      [userId]
    );

    if (!account) throw new Error('No connected Roblox account found.');

    // 1. License Check: If key is expired or missing, stop protection immediately!
    const activeLicense = await db.get(
      `SELECT * FROM licenses WHERE user_id = ? AND status = 'active' AND expires_at > datetime('now') ORDER BY id DESC LIMIT 1`,
      [userId]
    );

    if (!activeLicense) {
      throw new Error('You need an active key. Get one on the Get a key page.');
    }

    // Ensure account is linked to the active license
    if (account.license_id !== activeLicense.id) {
      await db.run(`UPDATE roblox_accounts SET license_id = ? WHERE id = ?`, [activeLicense.id, account.id]);
    }

    if (account.mode === 'extension') {
      throw new Error('Your account is connected through the browser extension. Keep your browser open.');
    }
    const cookie = this.decrypt(account.encrypted_cookie, account.cookie_iv);

    // 2. Get every waiting friend request (up to 40 pages of 25 = 1,000 requests)
    const pendingList = [];
    if (isTestCookie(cookie)) {
      pendingList.push(...demoRequests(cookie));
    } else {
      let cursor = '';
      for (let page = 0; page < 40; page++) {
        const res = await this.robloxRequest(
          `https://friends.roblox.com/v1/my/friends/requests?limit=25&sortOrder=Desc${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
          'GET', cookie, null, account.roblox_id
        );
        if (!res.ok) {
          if (res.status === 401) {
            await db.run(`UPDATE roblox_accounts SET is_active = 0 WHERE id = ?`, [account.id]);
            throw new Error('Your Roblox login expired. Unlink and paste a fresh cookie.');
          }
          if (page === 0) throw new Error(`Roblox said no when we asked for your friend requests (error ${res.status}). Try again in a minute.`);
          break;
        }
        const data = await res.json();
        pendingList.push(...(data.data || []));
        cursor = data.nextPageCursor;
        if (!cursor) { pendingList.complete = true; break; }
      }
    }
    if (isTestCookie(cookie)) pendingList.complete = true;
    if (opts.force) await db.run(`UPDATE friend_requests SET checked_at = NULL WHERE user_id = ? AND status = 'pending'`, [userId]);
    return await this.processRequests(userId, account, activeLicense, pendingList, cookie);
  }

  /**
   * Scores waiting requests, declines/accepts on Roblox if the customer's switches say so,
   * and saves each one so the Friend requests page can show it.
   */
  async processRequests(userId, account, activeLicense, pendingList, cookie, opts = {}) {
    // Extension mode: the customer's browser fetched the list and will do the clicking.
    // The server still makes every decision; accepts come back as instructions.
    const ext = !!opts.ext;
    const live = ext || !isTestCookie(cookie || '');
    const instructions = [];
    const publicPost = async (url, body) => {
      try {
        return await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0 waurks' },
          body: JSON.stringify(body), signal: AbortSignal.timeout(10000) });
      } catch (e) { return null; }
    };
    // MM2 filter = only check for the MM2 "Level 10" badge. No bot checks, nothing declined or hidden.
    const mm2Filter = true; // game filters only (MM2 or Adopt Me)
    const game = account.accept_filter === 'adoptme' ? 'adoptme' : 'mm2';
    const tag = GAME_TAG[game];
    const senderId = a => a.id ?? a.friendRequest?.senderId;
    const ids = new Set(pendingList.map(a => String(senderId(a))).filter(Boolean));

    // Requests that disappeared from Roblox (accepted/declined in the Roblox app) are marked gone
    const rows = await db.all(`SELECT target_id, checked_at FROM friend_requests WHERE user_id = ? AND status = 'pending'`, [userId]);
    for (const r of rows) {
      // Only mark "gone" when we saw the whole list; with a flood we only see the newest 200
      if (pendingList.complete && !ids.has(String(r.target_id))) {
        await db.run(`UPDATE friend_requests SET status = 'gone', updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND target_id = ?`, [userId, r.target_id]);
      }
    }

    // Only score new ones, plus anything not re-checked in the last hour
    // Anything we already handled or checked in the last hour (declined, accepted or waiting) is skipped
    const recent = await db.all(`SELECT target_id, reasons FROM friend_requests WHERE user_id = ? AND checked_at > datetime('now', '-1 hour')`, [userId]);
    // Only skip ones checked by the CURRENT filter (switching Standard <-> MM2 re-checks them)
    const fresh = new Set(recent.filter(r => String(r.reasons || '').includes(tag)).map(r => String(r.target_id)));
    // Once filtered as a bot, always a bot for this customer: never re-checked, never shown, never auto-accepted.
    // ("Checking..." isn't a decision yet, so those still get checked. Accepting by hand is the only way out.)
    const settledBots = await db.all(
      `SELECT target_id FROM friend_requests WHERE user_id = ? AND verdict = 'DECLINE' AND status = 'pending'
         AND COALESCE(reasons, '') NOT LIKE '%Checking%'
         AND (COALESCE(reasons, '') LIKE ? OR COALESCE(reasons, '') LIKE '%block list%')`,
      [userId, '%' + tag + '%']
    );
    for (const r of settledBots) fresh.add(String(r.target_id));
    // Flood wave detection: requests arriving together or backlog >= 25
    const isWave = pendingList.length >= 25;
    // Newest first. In flood waves and MM2/Adopt Me modes, pre-classify spam bots and process the entire list
    // so nothing is left behind in a backlog ("Checking X more...")
    const unchecked = pendingList.filter(a => senderId(a) && !fresh.has(String(senderId(a))));
    const toCheck = unchecked;
    this.backlog = this.backlog || new Map();
    this.backlog.set(userId, 0);
    if (toCheck.length === 0) {
      await db.run(`UPDATE roblox_accounts SET last_scan_at = CURRENT_TIMESTAMP WHERE id = ?`, [account.id]);
      return { scanned: 0, botsDeclined: 0, playersAccepted: 0, heldReview: 0, message: 'Nothing new to check.', actions: [] };
    }

    const bases = toCheck.map(a => ({
      id: senderId(a), name: a.name, displayName: a.displayName, description: a.description,
      created: a.created, isBanned: a.isBanned, hasVerifiedBadge: a.hasVerifiedBadge,
      // test requests carry their own extra info
      badgeCount: a.badgeCount, badgesHidden: a.badgesHidden, friendsCount: a.friendsCount, avatarAssetCount: a.avatarAssetCount, paidItem: a.paidItem,
      mm2: a.mm2, online: a.online
    }));

    let profiles, headshots = new Map(), authGet = null, allPresences = null;
    if (live) {
      authGet = ext ? null : async url => {
        const r = await this.robloxRequest(url, 'GET', cookie, null, account.roblox_id);
        return r.ok ? r.json() : null;
      };
      // The request list sometimes comes back without names, so fill them in with one batch call
      const authPost = ext
        ? async (url, body) => { const r = await publicPost(url, body); return r && r.ok ? r.json() : null; }
        : async (url, body) => {
          const r = await this.robloxRequest(url, 'POST', cookie, body, account.roblox_id);
          return r.ok ? r.json() : null;
        };
      const idsToCheck = bases.map(b => b.id);
      // For large floods, only fetch headshots for the first 50 to avoid hammering Roblox thumbnails API
      const idsForHeadshots = idsToCheck.length > 50 ? idsToCheck.slice(0, 50) : idsToCheck;
      const [names, gotHeadshots, presMap] = await Promise.all([
        robloxProfiles.getNames(idsToCheck, authPost).catch(() => new Map()),
        robloxProfiles.getHeadshots(idsForHeadshots).catch(() => new Map()),
        // Only check presence for Standard filter. MM2 mode only checks badge.
        mm2Filter ? null : presence.getUserPresences(idsToCheck.slice(0, 50), ext ? publicPost : (url, body) => this.robloxRequest(url, 'POST', cookie, body, account.roblox_id)).catch(() => null)
      ]);
      headshots = gotHeadshots || new Map();
      allPresences = presMap;
      for (const b of bases) {
        const n = names.get(String(b.id));
        if (n) { b.name = b.name || n.name; b.displayName = b.displayName || n.displayName; if (n.hasVerifiedBadge) b.hasVerifiedBadge = true; }
      }
    }
    // Flood shield: how many requests were sent within 15 minutes of each one.
    // Uses Roblox's sent time; if Roblox doesn't give one, a backlog of 100+ waiting counts as a wave.
    const sentTimes = pendingList.map(a => Date.parse(a.friendRequest?.sentAt || a.sentAt || '') || null);
    const haveTimes = sentTimes.filter(Boolean).length >= Math.min(10, pendingList.length);
    const waveOf = item => {
      if (!haveTimes) return pendingList.length >= 100 ? pendingList.length : 0;
      const t = Date.parse(item.friendRequest?.sentAt || item.sentAt || '');
      if (!t) return 0;
      return sentTimes.filter(u => u && Math.abs(u - t) <= 15 * 60000).length;
    };

    // Profiles are fetched in concurrent chunks of 20, and each request is saved the moment it's scored,
    // so the page fills up instantly while the rest are still being evaluated.
    const CHUNK = 20;
    profiles = new Array(bases.length);
    const burst = new Array(bases.length).fill(0);
    // Step 2 (Standard filter): online status from pre-fetched batch presence
    const online = new Array(bases.length).fill(null);
    bases.forEach((b, k) => {
      if (!live) {
        online[k] = b.online === false ? false : true;
      } else if (allPresences) {
        const rec = allPresences.get(String(b.id));
        online[k] = rec ? presence.normalizePresenceStatus(rec) : null;
      }
    });

    const loadChunk = async start => {
      const part = bases.slice(start, start + CHUNK);
      const got = (!live || mm2Filter) ? part : await robloxProfiles.getProfiles(part, authGet, CHUNK);
      got.forEach((p, k) => { profiles[start + k] = p; });
      // Waves of brand-new accounts arriving together
      const ts = got.map(p => (p && p.created ? new Date(p.created).getTime() : null));
      const fresh30 = ts.map(t => t !== null && Date.now() - t < 30 * 86400000);
      ts.forEach((t, k) => {
        burst[start + k] = !fresh30[k] ? 0 : ts.filter((u, j) => j !== k && fresh30[j] && Math.abs(u - t) < 3 * 86400000).length;
      });
    };

    const mm2BadgeMap = new Map();
    const adoptWhy = new Map(); // why someone passed Adopt Me step 1 (community / favorites)
    if (live && mm2Filter) {
      const idsToCheck = bases.map(b => b.id);
      const BATCH = 15;
      for (let i = 0; i < idsToCheck.length; i += BATCH) {
        const slice = idsToCheck.slice(i, i + BATCH);
        await Promise.all(slice.map(async id => {
          const sid = String(id);
          const baseItem = bases.find(b => String(b.id) === sid);
          // If known 0 badges or badges hidden, cannot own MM2 Level 10 badge -> skip network call instantly!
          if (baseItem && (baseItem.badgeCount === 0 || baseItem.badgesHidden)) {
            mm2BadgeMap.set(sid, false);
            return;
          }
          // If part of flood wave spam without verified badge or mutual friends -> skip network call instantly!
          if (isWave && (!baseItem?.hasVerifiedBadge && !(baseItem?.mutualFriendsList?.length))) {
            mm2BadgeMap.set(sid, false);
            return;
          }
          if (game === 'mm2') { mm2BadgeMap.set(sid, await robloxProfiles.ownsBadge(sid, MM2_LEVEL10_BADGE, authGet)); return; }
          // Adopt Me step 1: in the Uplift Games community, or Adopt Me in favorites, or any Adopt Me badge.
          // Any one of these is enough. Stop at the first hit.
          const [grp, fav] = await Promise.all([
            robloxProfiles.inGroup(sid, ADOPTME_GROUP).catch(() => null),
            robloxProfiles.favoritedGame(sid, ADOPTME_UNIVERSE).catch(() => null)
          ]);
          if (grp === true || fav === true) { mm2BadgeMap.set(sid, true); adoptWhy.set(sid, grp === true ? 'in Uplift Games community' : 'Adopt Me in favorites'); return; }
          let any = false, unknown = false;
          for (let j = 0; j < ADOPTME_BADGES.length && !any; j += 3) {
            const res = await Promise.all(ADOPTME_BADGES.slice(j, j + 3).map(b => robloxProfiles.ownsBadge(sid, b, authGet)));
            if (res.includes(true)) any = true; else if (res.includes(null)) unknown = true;
          }
          mm2BadgeMap.set(sid, any ? true : unknown ? null : false);
        }));
      }
    }

    // Adopt Me mode only, step 2: anyone with no Adopt Me badge gets an online check. Online = counts as real.
    // (Anyone who already has an Adopt Me badge skips this.)
    const onlineMap = new Map();
    if (live && game === 'adoptme') {
      const failed = bases.map(b => String(b.id)).filter(id => mm2BadgeMap.get(id) !== true && !isWave);
      if (failed.length) {
        const pres = await presence.getUserPresences(failed.slice(0, 50), ext ? publicPost : (url, body) => this.robloxRequest(url, 'POST', cookie, body, account.roblox_id)).catch(() => null);
        if (pres) failed.forEach(id => { const rec = pres.get(id); onlineMap.set(id, rec ? presence.normalizePresenceStatus(rec) : false); });
      }
    }

    let botsCount = 0, playersCount = 0, reviewCount = 0;
    const actionErrors = [];

    await db.run('BEGIN TRANSACTION').catch(() => {});
    try {
      for (let i = 0; i < toCheck.length; i++) {
      if (i % CHUNK === 0) await loadChunk(i);
      const sid = String(senderId(toCheck[i]));
      const profile = profiles[i];
      const name = profile.name || bases[i].name || `User ${sid}`;
      const displayName = profile.displayName || bases[i].displayName || name;
      const fr = toCheck[i].friendRequest || {};
      const mutuals = Array.isArray(toCheck[i].mutualFriendsList) ? toCheck[i].mutualFriendsList.length : 0;

      let evaluation, mm2 = null, recheckSoon = false;
      const [globalBlocked, userBlocked] = await Promise.all([
        db.get(`SELECT reason FROM global_bot_blacklist WHERE roblox_user_id = ?`, [sid]).catch(() => null),
        db.get(`SELECT reason FROM user_bot_blacklist WHERE user_id = ? AND roblox_user_id = ?`, [userId, sid]).catch(() => null)
      ]);
      if (userBlocked || globalBlocked) {
        evaluation = {
          verdict: 'DECLINE',
          threatScore: 100,
          reasons: [userBlocked ? 'On your bot block list' : 'On the Waurks block list']
        };
      } else if (mm2Filter) {
        // MM2 filter: only checks the MM2 Level 10 badge (no online check)
        const isLive = live;
        if (game === 'mm2') {
          // For MM2: ONLY players who confirmed have the MM2 Level 10 badge (196198137) are accepted.
          // fromGame does NOT bypass the badge requirement!
          // If badges cannot be seen (ownsBadge is null, inventory private, badges hidden) or badgeCount === 0 -> filter them.
          const badgeOwned = isLive ? mm2BadgeMap.get(sid) : (!!bases[i].mm2 && bases[i].badgeCount !== 0);
          const cannotSeeBadges = isLive ? (badgeOwned === null || bases[i].badgesHidden || (profile && profile.badgesHidden)) : false;
          const hasZeroBadges = (profile && profile.badgeCount === 0) || bases[i].badgeCount === 0;

          if (badgeOwned === true && !hasZeroBadges && !cannotSeeBadges) {
            mm2 = true;
            evaluation = { verdict: 'ACCEPT', threatScore: 0, reasons: ['MM2 trades accepted (Level 10 badge)'] };
          } else {
            mm2 = false;
            evaluation = {
              verdict: 'DECLINE',
              threatScore: 100,
              reasons: [
                cannotSeeBadges
                  ? 'No visible MM2 Level 10 badge (badges hidden or private)'
                  : hasZeroBadges
                  ? 'No MM2 Level 10 badge (0 badges)'
                  : 'No MM2 Level 10 badge'
              ]
            };
          }
        } else {
          // Adopt Me logic
          mm2 = live ? mm2BadgeMap.get(sid) : !!bases[i].mm2;
          const fromGame = String(fr.sourceUniverseId || '') === ADOPTME_UNIVERSE;
          if (fromGame) mm2 = true;
          let onlineNow = false;
          if (mm2 !== true) {
            onlineNow = live ? onlineMap.get(sid) === true : bases[i].online === true;
            if (onlineNow) mm2 = true;
          }
          evaluation = mm2 === true && onlineNow
            ? { verdict: 'ACCEPT', threatScore: 0, reasons: ['Real Adopt Me player (online now)'] }
            : mm2 === true
            ? { verdict: 'ACCEPT', threatScore: 0, reasons: [fromGame ? 'Real Adopt Me player (sent from Adopt Me)' : adoptWhy.has(sid) ? 'Real Adopt Me player (' + adoptWhy.get(sid) + ')' : 'Real Adopt Me player'] }
            : { verdict: 'DECLINE', threatScore: 100, reasons: [mm2 === null ? 'No sign of Adopt Me (inventory private), offline' : 'No sign of Adopt Me, offline'] };
        }
      } else {
        // Standard filter: the full bot checker, no badge check
        evaluation = await detectionEngine.evaluateProfile(profile, {
          forUserId: userId,
          mutualFriends: mutuals,
          metInGame: !!fr.sourceUniverseId || /ingame/i.test(String(fr.originSourceType || '')),
          burstSiblings: burst[i],
          wave: waveOf(toCheck[i])
        });
        // Badge rule: 0 badges, or badges we can't see, = flagged
        if (evaluation.verdict !== 'DECLINE' && live && !(profile.badgeCount > 0)) {
          const unknown = profile.badgeCount === null || profile.badgeCount === undefined;
          const hidden = unknown && (profile.badgesHidden || bases[i].badgesHidden);
          evaluation.verdict = 'DECLINE';
          evaluation.threatScore = Math.max(evaluation.threatScore, 70);
          evaluation.reasons = [hidden ? 'Badges hidden' : unknown ? 'Checking badges...' : 'No badges', ...evaluation.reasons];
          // Not looked up yet (not hidden): check again in about 30 seconds
          if (unknown && !hidden) recheckSoon = true;
        }
        // STEP 2: anyone who passed Step 1 also has to be online right now (bots are usually offline)
        if (evaluation.verdict !== 'DECLINE' && online[i] === false) {
          evaluation.verdict = 'DECLINE';
          evaluation.threatScore = Math.max(evaluation.threatScore, 70);
          evaluation.reasons = ['Offline (failed step 2)', ...evaluation.reasons];
        }
      }

      // Act on Roblox when the customer's switches say so
      let status = 'pending';
      if (evaluation.verdict === 'DECLINE') {
        botsCount++;
        // Automatically decline filtered bots on Roblox so they are removed from friend requests
        if (ext) {
          instructions.push({ id: sid, do: 'decline' });
          status = 'declined';
        } else {
          try {
            const cookie = this.decrypt(account.encrypted_cookie, account.cookie_iv);
            if (!isTestCookie(cookie)) {
              await this.robloxRequest(`https://friends.roblox.com/v1/users/${sid}/decline-friend-request`, 'POST', cookie, null, account.roblox_id);
            }
          } catch (_) {}
          status = 'declined';
        }
      } else if (evaluation.verdict === 'ACCEPT') {
        playersCount++;
        if (account.auto_accept_players && (!mm2Filter || mm2 === true)) {
          if (ext) {
            // Queue for extension to accept, but keep status = 'pending' in database!
            // Only when the extension reports back that Roblox returned 200 OK does it become 'accepted'.
            // If Roblox rate limits (429) or fails, it remains 'pending' and retries automatically!
            instructions.push({ id: sid, do: 'accept' });
            status = 'pending';
          } else if (live) {
            const r = await this.robloxRequest(`https://friends.roblox.com/v1/users/${sid}/accept-friend-request`, 'POST', cookie, null, account.roblox_id);
            if (r.ok) status = 'accepted';
            else {
              status = 'pending';
              actionErrors.push(`accept ${name}: ${r.status}`);
            }
          } else status = 'accepted';
        }
      } else {
        reviewCount++;
      }

      const ageDays = profile.created ? Math.floor((Date.now() - new Date(profile.created).getTime()) / 86400000) : null;
      const facts = {
        ageDays, badges: profile.badgeCount ?? null, friends: profile.friendsCount ?? null,
        paidItem: profile.paidItem ? profile.paidItem.name : null, mutuals,
        mm2: mm2 === true && game === 'mm2' ? true : undefined,
        game: mm2 === true ? game : undefined
      };
      await db.run(
        `INSERT INTO friend_requests (user_id, target_id, name, display_name, avatar_url, verdict, score, reasons, facts, status, auto, sent_at, checked_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now', ?), CURRENT_TIMESTAMP)
         ON CONFLICT(user_id, target_id) DO UPDATE SET name = excluded.name, display_name = excluded.display_name,
           avatar_url = COALESCE(excluded.avatar_url, friend_requests.avatar_url), verdict = excluded.verdict, score = excluded.score,
           reasons = excluded.reasons, facts = excluded.facts, status = CASE WHEN friend_requests.status = 'cleared' THEN 'cleared' ELSE excluded.status END, auto = excluded.auto,
           checked_at = excluded.checked_at, updated_at = CURRENT_TIMESTAMP`,
        [userId, sid, name, displayName, headshots.get(sid) || null, evaluation.verdict, evaluation.threatScore,
         JSON.stringify(evaluation.reasons.slice(0, 4)), JSON.stringify(facts), status, status === 'pending' ? 0 : 1, fr.sentAt || null,
         recheckSoon ? '-3570 seconds' : '+0 seconds']
      );

      await db.run(
        `INSERT INTO scan_activity_logs (user_id, roblox_id, target_id, target_username, verdict, threat_score, reason)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [userId, account?.roblox_id || '0', sid, name, evaluation.verdict, evaluation.threatScore, evaluation.reasons[0] || '']
      );

      if (live && !ext && status !== 'pending') await new Promise(r => setTimeout(r, 150));
    }
    await db.run('COMMIT').catch(() => {});
  } catch (err) {
    await db.run('ROLLBACK').catch(() => {});
    console.error('[processRequests] error:', err.message);
  }

    await keyService.recordStats(activeLicense.id, { filtered: toCheck.length, blocked: botsCount, accepted: playersCount });
    await db.run(`UPDATE roblox_accounts SET last_scan_at = CURRENT_TIMESTAMP WHERE id = ?`, [account.id]);
    if (actionErrors.length) {
      throw new Error(`Roblox blocked ${actionErrors.length} accept/decline action(s) (${actionErrors.slice(0, 2).join(', ')}). Your cookie may need refreshing.`);
    }
    return { scanned: toCheck.length, botsDeclined: botsCount, playersAccepted: playersCount, heldReview: reviewCount, simulated: !live || undefined, actions: instructions };
  }

  /**
   * What the Friend requests page shows. The filter level decides what counts as "hidden":
   *   relaxed - hide only sure bots
   *   normal  - also hide suspicious accounts
   *   strict  - only show accounts that clearly look real
   */
  async getRequests(userId) {
    let account = await db.get(`SELECT filter_level, last_scan_at, last_check_at, last_error, is_active, auto_accept_players, accept_filter, mode FROM roblox_accounts WHERE user_id = ?`, [userId]);
    if (!account) {
      // Check if user has an active license or friend requests
      const lic = await db.get(`SELECT * FROM licenses WHERE user_id = ? AND status = 'active' ORDER BY id DESC LIMIT 1`, [userId]);
      const hasReqs = await db.get(`SELECT COUNT(*) as count FROM friend_requests WHERE user_id = ?`, [userId]);
      if (lic || (hasReqs && hasReqs.count > 0)) {
        const robloxId = lic?.roblox_id || '0';
        await db.run(
          `INSERT INTO roblox_accounts (user_id, license_id, roblox_id, roblox_username, avatar_url, encrypted_cookie, cookie_iv, is_active, auto_accept_players, mode)
           VALUES (?, ?, ?, ?, NULL, '', '', 1, 0, 'extension')`,
          [userId, lic?.id || null, robloxId, `User ${robloxId}`]
        ).catch(() => {});
        account = await db.get(`SELECT filter_level, last_scan_at, last_check_at, last_error, is_active, auto_accept_players, accept_filter, mode FROM roblox_accounts WHERE user_id = ?`, [userId]);
      }
    }
    if (!account) return { connected: false };
    const level = account.filter_level || 'normal';
    const rows = await db.all(
      `SELECT * FROM friend_requests WHERE user_id = ? AND status != 'cleared' AND (status = 'pending' OR (status = 'declined' AND auto = 1 AND updated_at > datetime('now', '-7 days')))
       ORDER BY priority DESC, COALESCE(sent_at, checked_at, updated_at) DESC LIMIT 2000`,
      [userId]
    );
    const visible = [], hidden = [];
    for (const r of rows) {
      const item = {
        id: r.target_id, name: r.name, displayName: r.display_name, avatar: r.avatar_url,
        verdict: r.verdict, score: r.score, reasons: safeJson(r.reasons, []), facts: safeJson(r.facts, {}),
        status: r.status, sentAt: r.sent_at,
        retryError: r.retry_error || null,
        retryAfter: r.retry_after || null,
        priority: r.priority || 0
      };
      {
        // MM2 filter: only people confirmed to have the Level 10 badge are shown. Everything else is filtered.
        const gm = account.accept_filter === 'adoptme' ? 'adoptme' : 'mm2', gTag = GAME_TAG[gm];
        const passed = gm === 'mm2' ? item.facts.mm2 === true : item.facts.game === 'adoptme';
        if (r.status === 'pending' && passed && r.verdict === 'ACCEPT') visible.push(item);
        else {
          if (r.status === 'pending' && !r.verdict && !item.reasons.some(x => x.includes(gTag) || /block list/.test(x))) {
            item.reasons = [gm === 'mm2' ? 'Checking for MM2 badge...' : 'Checking for Adopt Me...'];
          }
          hidden.push(item);
        }
        continue;
      }
      // Not checked yet (saved by the extension, waiting its turn): don't show it as a real person
      if (!r.verdict) { if (r.status === 'pending') { item.reasons = ['Checking...']; hidden.push(item); } continue; }
      if (r.status === 'declined' || isHidden(level, r.verdict, r.score)) hidden.push(item);
      else visible.push(item);
    }
    return {
      connected: true, level, active: !!account.is_active, autoAccept: !!account.auto_accept_players,
      mode: account.mode || 'cloud',
      extensionOnline: account.mode === 'extension' && !!account.last_check_at
        && Date.now() - new Date(String(account.last_check_at).replace(' ', 'T') + 'Z').getTime() < 45000,
      acceptFilter: account.accept_filter === 'adoptme' ? 'adoptme' : 'mm2',
      lastScanAt: [account.last_check_at, account.last_scan_at].filter(Boolean).sort().pop() || null, lastError: account.last_error,
      checking: (this.backlog && this.backlog.get(userId)) || 0, busy: !!(this.activeScans && this.activeScans.has(userId)),
      requests: visible,
      hiddenTotal: hidden.length,
      hidden: hidden.slice(0, 72)
    };
  }

  /**
   * Auto-accept switch on the Friend requests page. Turning it on also accepts
   * the waiting requests that clearly look real, right away.
   */

  /**
   * Clear all filtered bots for a user so they no longer appear on screen.
   */
  async clearFilteredBots(userId) {
    const account = await db.get('SELECT accept_filter, mode, encrypted_cookie, cookie_iv, roblox_id FROM roblox_accounts WHERE user_id = ?', [userId]);
    const gm = account && account.accept_filter === 'adoptme' ? 'adoptme' : 'mm2';
    // Find all target_ids of matching bot requests so we can decline them on Roblox too!
    const toDecline = await db.all(
      `SELECT target_id FROM friend_requests 
       WHERE user_id = ? 
         AND status != 'accepted'
         AND status != 'cleared'
         AND (
           status = 'declined' 
           OR verdict = 'DECLINE' 
           OR score >= 50
           OR (verdict != 'ACCEPT' AND verdict IS NOT NULL)
           OR (facts NOT LIKE ? AND facts IS NOT NULL)
         )`,
      [userId, gm === 'mm2' ? '%"mm2":true%' : '%"game":"adoptme"%']
    );

    // Queue declines for extension or run directly in cloud mode
    if (account?.mode === 'extension') {
      for (const row of toDecline) {
        await db.run(
          `INSERT INTO ext_actions (user_id, target_id, action, done, priority) VALUES (?, ?, 'decline', 0, 5)`,
          [userId, row.target_id]
        ).catch(() => {});
      }
    } else if (account?.encrypted_cookie && account?.cookie_iv) {
      try {
        const cookie = this.decrypt(account.encrypted_cookie, account.cookie_iv);
        if (!isTestCookie(cookie)) {
          for (const row of toDecline.slice(0, 50)) {
            await this.robloxRequest(`https://friends.roblox.com/v1/users/${row.target_id}/decline-friend-request`, 'POST', cookie, null, account.roblox_id).catch(() => {});
          }
        }
      } catch (_) {}
    }

    const res = await db.run(
      `UPDATE friend_requests 
       SET status = 'cleared', updated_at = CURRENT_TIMESTAMP 
       WHERE user_id = ? 
         AND status != 'accepted'
         AND status != 'cleared'
         AND (
           status = 'declined' 
           OR verdict = 'DECLINE' 
           OR score >= 50
           OR (verdict != 'ACCEPT' AND verdict IS NOT NULL)
           OR (facts NOT LIKE ? AND facts IS NOT NULL)
         )`,
      [userId, gm === 'mm2' ? '%"mm2":true%' : '%"game":"adoptme"%']
    );
    return { success: true, cleared: res?.changes || 0 };
  }

  async setAutoAccept(userId, enabled) {
    await db.run(`UPDATE roblox_accounts SET auto_accept_players = ? WHERE user_id = ?`, [enabled ? 1 : 0, userId]);
    let accepted = 0;
    if (enabled) {
      let rows = await db.all(`SELECT target_id, facts FROM friend_requests WHERE user_id = ? AND status = 'pending' AND verdict = 'ACCEPT'`, [userId]);
      const acc = await db.get(`SELECT accept_filter FROM roblox_accounts WHERE user_id = ?`, [userId]);
      const gm = acc && acc.accept_filter === 'adoptme' ? 'adoptme' : 'mm2';
      rows = rows.filter(r => { const f = safeJson(r.facts, {}); return gm === 'mm2' ? f.mm2 === true : f.game === 'adoptme'; });
      for (const r of rows) {
        try { await this.answerRequest(userId, r.target_id, true); accepted++; } catch (e) { /* skip ones Roblox refuses */ }
        await new Promise(res => setTimeout(res, 300));
      }
    }
    return { success: true, autoAccept: !!enabled, accepted };
  }

  async setAcceptFilter(userId, filter) {
    if (!['mm2', 'adoptme'].includes(filter)) throw new Error('Unknown filter');
    await db.run(`UPDATE roblox_accounts SET accept_filter = ? WHERE user_id = ?`, [filter, userId]);
    // Reset checked_at and verdict so requests must be checked fresh before showing
    await db.run(`UPDATE friend_requests SET checked_at = NULL, verdict = NULL WHERE user_id = ? AND status = 'pending'`, [userId]);
    return { success: true, acceptFilter: filter };
  }

  async setFilterLevel(userId, level) {
    if (!['relaxed', 'normal', 'strict'].includes(level)) throw new Error('Pick relaxed, normal or strict');
    await db.run(`UPDATE roblox_accounts SET filter_level = ? WHERE user_id = ?`, [level, userId]);
    return { success: true, level };
  }

  /**
   * Customer pressed Accept or Decline on the Friend requests page.
   */
  async answerRequest(userId, targetId, accept) {
    const row = await db.get(`SELECT * FROM friend_requests WHERE user_id = ? AND target_id = ?`, [userId, String(targetId)]);
    if (!row) throw new Error('That request is gone');
    const account = await db.get(`SELECT * FROM roblox_accounts WHERE user_id = ?`, [userId]);
    if (!account) throw new Error('Link your Roblox account first');
    if (account.mode === 'extension') {
      // Queue action for extension with high priority (20) so it's picked up immediately
      await db.run(
        `INSERT INTO ext_actions (user_id, target_id, action, done, priority, retry_after) VALUES (?, ?, ?, 0, 20, NULL)`,
        [userId, row.target_id, accept ? 'accept' : 'decline']
      );
      if (accept) {
        // Keep status = 'pending', prioritize, and mark initial notice until extension reports
        await db.run(
          `UPDATE friend_requests SET status = 'pending', priority = 20, retry_error = 'Accepting... (waiting for extension)', updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND target_id = ?`,
          [userId, row.target_id]
        );
      } else {
        await db.run(
          `UPDATE friend_requests SET status = 'declined', auto = 0, retry_error = NULL, retry_after = NULL, priority = 0, updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND target_id = ?`,
          [userId, row.target_id]
        );
      }
      return { success: true, queued: true };
    } else {
      const cookie = this.decrypt(account.encrypted_cookie, account.cookie_iv);
      if (!isTestCookie(cookie)) {
        const r = await this.robloxRequest(
          `https://friends.roblox.com/v1/users/${row.target_id}/${accept ? 'accept' : 'decline'}-friend-request`,
          'POST', cookie, null, account.roblox_id
        );
        if (!r.ok && r.status !== 400) {
          // Rate limited on Roblox: don't remove! Retain pending status with 60s retry backoff and red notice
          await db.run(
            `UPDATE friend_requests SET retry_error = 'Roblox rate limited (accepting too fast) · Retrying in 30s...', retry_after = datetime('now', '+30 seconds'), priority = 10, updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND target_id = ?`,
            [userId, row.target_id]
          );
          throw new Error(`Roblox rate limited or didn't allow that (error ${r.status}). Will retry.`);
        }
      }
      await db.run(
        `UPDATE friend_requests SET status = ?, auto = 0, retry_error = NULL, retry_after = NULL, priority = 0, updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND target_id = ?`,
        [accept ? 'accepted' : 'declined', userId, row.target_id]
      );
    }
    // Accepting something the filter thought was a bot teaches it that this account is real
    if (accept && row.verdict !== 'ACCEPT') await detectionEngine.recordReport(row.target_id, userId, false);
    await db.run(
      `INSERT INTO scan_activity_logs (user_id, roblox_id, target_id, target_username, verdict, threat_score, reason) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [userId, account.roblox_id, row.target_id, row.name, accept ? 'ACCEPT' : 'DECLINE', row.score, accept ? 'You accepted' : 'You declined']
    );
    return { success: true };
  }

  async reportBot(userId, targetId) {
    await detectionEngine.recordReport(String(targetId), userId, true);
    return this.answerRequest(userId, targetId, false);
  }

  /**
   * User pressed "This is a bot (adds to bot list)":
   * Adds the account to THIS user's personal block list so it's a bot ONLY for them.
   * Does NOT affect any other user.
   */
  async markUserBot(userId, targetId) {
    const tid = String(targetId).replace(/\D/g, '');
    if (!tid) throw new Error('Bad account ID');
    const row = await db.get(`SELECT name FROM friend_requests WHERE user_id = ? AND target_id = ? LIMIT 1`, [userId, tid]);
    await db.run(
      `INSERT OR IGNORE INTO user_bot_blacklist (user_id, roblox_user_id, reason) VALUES (?, ?, ?)`,
      [userId, tid, 'Marked as a bot by user']
    );
    await detectionEngine.recordReport(tid, userId, true);
    await db.run(
      `UPDATE friend_requests SET verdict = 'DECLINE', score = 100, reasons = ?, updated_at = CURRENT_TIMESTAMP
       WHERE user_id = ? AND target_id = ? AND status = 'pending'`,
      [JSON.stringify(['On your bot block list']), userId, tid]
    );
    try {
      await this.answerRequest(userId, tid, false);
    } catch (_) {}
    return { success: true, message: 'Added to your bot list' };
  }

  /**
   * Admin pressed "This is a bot": put the account on the global block list so it's a bot
   * for EVERY customer (hidden, never auto-accepted), and update everyone's lists right away.
   */
  async adminMarkBot(adminUser, targetId) {
    const tid = String(targetId).replace(/\D/g, '');
    if (!tid) throw new Error('Bad account ID');
    const row = await db.get(`SELECT name FROM friend_requests WHERE target_id = ? LIMIT 1`, [tid]);
    await db.run(
      `INSERT OR IGNORE INTO global_bot_blacklist (roblox_user_id, username_pattern, reason) VALUES (?, NULL, ?)`,
      [tid, `Marked as a bot by admin ${adminUser.username}`]
    );
    await detectionEngine.recordReport(tid, adminUser.id, true);
    await db.run(
      `UPDATE friend_requests SET verdict = 'DECLINE', score = 100, reasons = ?, updated_at = CURRENT_TIMESTAMP
       WHERE target_id = ? AND status = 'pending'`,
      [JSON.stringify(['On the Waurks block list']), tid]
    );
    await db.run(
      `INSERT INTO audit_logs (license_id, action, details) VALUES (NULL, 'ADMIN_BLACKLIST_ADD', ?)`,
      [`${adminUser.username}: marked ${row?.name || tid} (${tid}) as a bot from the Friend requests page`]
    ).catch(() => {});
    return { success: true };
  }

  /**
   * Starts the 24/7 background worker loop
   */
  /**
   * Real-time watcher. Every few seconds it asks Roblox "how many friend requests
   * are waiting?" (one cheap call per account) and only runs a full check when that
   * number goes up or new ones show up. Errors are saved so the account page can show them.
   */
  startDaemon(intervalSeconds = 10) {
    if (this.isDaemonRunning) return;
    this.isDaemonRunning = true;
    this.scanning = new Set();
    this.lastCounts = new Map();
    console.log('[watcher] checking friend requests every 5-10s (random per account)');

    // Each account gets its own random wait of 5-10 seconds between checks,
    // so checks are spread out instead of all hitting Roblox at the same moment.
    this.nextCheck = new Map();
    const randomWait = () => 5000 + Math.floor(Math.random() * 5000);
    const tick = async () => {
      let accounts = [];
      try {
        accounts = await db.all(`SELECT * FROM roblox_accounts WHERE is_active = 1 AND COALESCE(mode, 'cloud') = 'cloud'`);
      } catch (e) { return; }
      const now = Date.now();
      for (const acc of accounts) {
        if (this.scanning.has(acc.user_id)) continue;
        if ((this.nextCheck.get(acc.user_id) || 0) > now) continue;
        this.scanning.add(acc.user_id);
        this.watchOne(acc).catch(err => {
          console.error(`[watcher] scan error on user ${acc.user_id}:`, err?.message || err);
        }).finally(() => {
          this.scanning.delete(acc.user_id);
          // Still working through a flood? Go again in 1 second. Otherwise the normal random 5-10s.
          const behind = this.backlog && this.backlog.get(acc.user_id) > 0;
          this.nextCheck.set(acc.user_id, Date.now() + (behind ? 1000 : randomWait()));
        });
      }
    };
    this.daemonInterval = setInterval(tick, 1000);
    setTimeout(tick, 2000);
  }

  async watchOne(acc) {
    try {
      const cookie = this.decrypt(acc.encrypted_cookie, acc.cookie_iv);
      const isTest = cookie.startsWith('TEST_COOKIE_') || cookie.startsWith('DEMO_');
      // Roblox's "request count" is often wrong (it can say 0 with a full list), so look at the
      // newest requests themselves: if any ID is new since last time, run the full check.
      let ids = null;
      if (!isTest) {
        const r = await this.robloxRequest('https://friends.roblox.com/v1/my/friends/requests?limit=25&sortOrder=Desc', 'GET', cookie, null, acc.roblox_id);
        if (r.status === 401) throw new Error('Your Roblox login expired. Unlink and paste a fresh cookie.');
        if (r.ok) {
          const data = await r.json();
          ids = (data.data || []).map(a => String(a.id ?? a.friendRequest?.senderId)).sort().join(',');
        }
      }
      const prev = this.lastCounts.get(acc.user_id);
      const stale = !acc.last_scan_at || Date.now() - new Date(String(acc.last_scan_at).replace(' ', 'T') + 'Z').getTime() > 60000;
      const changed = ids === null || ids !== prev;
      const behind = (this.backlog && this.backlog.get(acc.user_id)) > 0;
      if (changed || stale || behind) {
        await this.runCloudScan(acc.user_id);
        if (ids !== null) this.lastCounts.set(acc.user_id, ids);
      }
      await db.run(`UPDATE roblox_accounts SET last_check_at = CURRENT_TIMESTAMP WHERE id = ?`, [acc.id]).catch(() => {});
      await this.setScanError(acc.user_id, null);
    } catch (e) {
      await this.setScanError(acc.user_id, e.message);
    }
  }

  async setScanError(userId, message) {
    await db.run(`UPDATE roblox_accounts SET last_error = ?, last_error_at = CASE WHEN ? IS NULL THEN last_error_at ELSE CURRENT_TIMESTAMP END WHERE user_id = ?`,
      [message, message, userId]).catch(() => {});
  }

  /**
   * Stops the background worker
   */
  stopDaemon() {
    if (this.daemonInterval) {
      clearInterval(this.daemonInterval);
      this.daemonInterval = null;
    }
    this.isDaemonRunning = false;
    console.log('[Waurks Cloud Daemon] Background scanner stopped.');
  }
}

module.exports = new RobloxCloudService();

