const crypto = require('crypto');
const db = require('../database');
const detectionEngine = require('./detectionEngine');
const robloxProfiles = require('./robloxProfiles');
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

db.run(`ALTER TABLE roblox_accounts ADD COLUMN last_check_at DATETIME`).catch(() => {});

const isTestCookie = c => c.startsWith('TEST_COOKIE_') || c.startsWith('DEMO_');
const toMs = d => new Date(String(d).replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(String(d)) ? '' : 'Z')).getTime();
const safeJson = (v, dflt) => { try { return JSON.parse(v); } catch (e) { return dflt; } };
function isHidden(level, verdict, score) {
  if (verdict === 'DECLINE') return true;
  if (level === 'strict') return verdict !== 'ACCEPT';
  if (level === 'normal') return verdict === 'REVIEW' && score >= 40;
  return false; // relaxed
}
// Fake requests for test accounts (no real Roblox login)
function demoRequests() {
  const d = n => new Date(Date.now() - n * 86400000).toISOString();
  return [
    { id: 9817263, name: 'ClaimRobux_x882', displayName: 'Robux Giveaway', description: 'Visit giftcard.gg/free for 10,000 robux!', created: d(1), badgeCount: 0, friendsCount: 0 },
    { id: 1827364, name: 'BlockyGamer_Ethan', displayName: 'Ethan', description: 'Builder and anime fan', created: d(400), badgeCount: 22, friendsCount: 30 },
    { id: 2938475, name: 'free_rbx_bot99', displayName: 'FreeRobux', description: 'ro-bux generator link in bio', created: d(2), badgeCount: 0, friendsCount: 0 },
    { id: 3847561, name: 'PixelSammy', displayName: 'Sammy', description: 'hello world', created: d(700), badgeCount: 12, friendsCount: 45 },
    { id: 4958672, name: 'mia_plays', displayName: 'Mia', description: '', created: d(5), badgeCount: 1, friendsCount: 2, avatarAssetCount: 4 },
    { id: 5069783, name: 'qwrtzpls8812', displayName: 'qwrtzpls8812', description: '', created: d(9), badgeCount: 0, friendsCount: 0, avatarAssetCount: 1 },
    { id: 7281905, name: 'kev_trades', displayName: 'Kev', description: '', created: d(3), badgeCount: 0, friendsCount: 1, avatarAssetCount: 3, mm2: true },
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
      if (opts.force) throw new Error('Already checking, give it a few seconds');
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

    const cookie = this.decrypt(account.encrypted_cookie, account.cookie_iv);

    // 2. Get every waiting friend request (up to 8 pages of 25)
    const pendingList = [];
    if (isTestCookie(cookie)) {
      pendingList.push(...demoRequests());
    } else {
      let cursor = '';
      for (let page = 0; page < 8; page++) {
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
        if (!cursor) break;
      }
    }
    if (opts.force) await db.run(`UPDATE friend_requests SET checked_at = NULL WHERE user_id = ? AND status = 'pending'`, [userId]);
    return await this.processRequests(userId, account, activeLicense, pendingList, cookie);
  }

  /**
   * Scores waiting requests, declines/accepts on Roblox if the customer's switches say so,
   * and saves each one so the Friend requests page can show it.
   */
  async processRequests(userId, account, activeLicense, pendingList, cookie) {
    const live = !isTestCookie(cookie);
    // MM2 filter = only check for the MM2 "Level 10" badge. No bot checks, nothing declined or hidden.
    const mm2Filter = account.accept_filter === 'mm2';
    const senderId = a => a.id ?? a.friendRequest?.senderId;
    const ids = new Set(pendingList.map(a => String(senderId(a))).filter(Boolean));

    // Requests that disappeared from Roblox (accepted/declined in the Roblox app) are marked gone
    const rows = await db.all(`SELECT target_id, checked_at FROM friend_requests WHERE user_id = ? AND status = 'pending'`, [userId]);
    for (const r of rows) {
      if (!ids.has(String(r.target_id))) {
        await db.run(`UPDATE friend_requests SET status = 'gone', updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND target_id = ?`, [userId, r.target_id]);
      }
    }

    // Only score new ones, plus anything not re-checked in the last hour
    const fresh = new Set(rows.filter(r => r.checked_at && Date.now() - toMs(r.checked_at) < 3600000).map(r => String(r.target_id)));
    const toCheck = pendingList.filter(a => senderId(a) && !fresh.has(String(senderId(a))));
    if (toCheck.length === 0) {
      await db.run(`UPDATE roblox_accounts SET last_scan_at = CURRENT_TIMESTAMP WHERE id = ?`, [account.id]);
      return { scanned: 0, botsDeclined: 0, playersAccepted: 0, heldReview: 0, message: 'Nothing new to check.' };
    }

    const bases = toCheck.map(a => ({
      id: senderId(a), name: a.name, displayName: a.displayName, description: a.description,
      created: a.created, isBanned: a.isBanned, hasVerifiedBadge: a.hasVerifiedBadge,
      // test requests carry their own extra info
      badgeCount: a.badgeCount, friendsCount: a.friendsCount, avatarAssetCount: a.avatarAssetCount, paidItem: a.paidItem,
      mm2: a.mm2
    }));

    let profiles, headshots = new Map(), authGet = null;
    if (live) {
      authGet = async url => {
        const r = await this.robloxRequest(url, 'GET', cookie, null, account.roblox_id);
        return r.ok ? r.json() : null;
      };
      // The request list sometimes comes back without names, so fill them in with one batch call
      const authPost = async (url, body) => {
        const r = await this.robloxRequest(url, 'POST', cookie, body, account.roblox_id);
        return r.ok ? r.json() : null;
      };
      const names = await robloxProfiles.getNames(bases.map(b => b.id), authPost);
      for (const b of bases) {
        const n = names.get(String(b.id));
        if (n) { b.name = b.name || n.name; b.displayName = b.displayName || n.displayName; if (n.hasVerifiedBadge) b.hasVerifiedBadge = true; }
      }
      profiles = mm2Filter ? bases : await robloxProfiles.getProfiles(bases, authGet);
      headshots = await robloxProfiles.getHeadshots(bases.map(b => b.id));
    } else {
      profiles = bases;
    }

    // Waves of brand-new accounts: how many OTHER new requesters were made within 3 days of this one
    const createdAt = profiles.map(p => (p.created ? new Date(p.created).getTime() : null));
    const isNew = createdAt.map(t => t !== null && Date.now() - t < 30 * 86400000);
    const burst = createdAt.map((t, i) => !isNew[i] ? 0
      : createdAt.filter((u, j) => j !== i && isNew[j] && Math.abs(u - t) < 3 * 86400000).length);

    let botsCount = 0, playersCount = 0, reviewCount = 0;
    const actionErrors = [];

    for (let i = 0; i < toCheck.length; i++) {
      const sid = String(senderId(toCheck[i]));
      const profile = profiles[i];
      const name = profile.name || bases[i].name || `User ${sid}`;
      const displayName = profile.displayName || bases[i].displayName || name;
      const fr = toCheck[i].friendRequest || {};
      const mutuals = Array.isArray(toCheck[i].mutualFriendsList) ? toCheck[i].mutualFriendsList.length : 0;

      let evaluation, mm2 = null;
      if (mm2Filter) {
        // MM2 filter: the badge is the only thing we look at
        mm2 = live ? await robloxProfiles.ownsBadge(sid, MM2_LEVEL10_BADGE, authGet) : !!bases[i].mm2;
        evaluation = mm2 === true
          ? { verdict: 'ACCEPT', threatScore: 0, reasons: ['MM2 trades accepted'] }
          : { verdict: 'REVIEW', threatScore: 0, reasons: [mm2 === null ? 'Inventory is private, could not check' : 'No MM2 Level 10 badge'] };
      } else {
        // Standard filter: the full bot checker, no badge check
        evaluation = await detectionEngine.evaluateProfile(profile, {
          forUserId: userId,
          mutualFriends: mutuals,
          metInGame: !!fr.sourceUniverseId || /ingame/i.test(String(fr.originSourceType || '')),
          burstSiblings: burst[i]
        });
      }

      // Act on Roblox when the customer's switches say so
      let status = 'pending';
      if (evaluation.verdict === 'DECLINE') {
        botsCount++;
        {
          if (live) {
            const r = await this.robloxRequest(`https://friends.roblox.com/v1/users/${sid}/decline-friend-request`, 'POST', cookie, null, account.roblox_id);
            if (r.ok) status = 'declined'; else actionErrors.push(`decline ${name}: ${r.status}`);
          } else status = 'declined';
        }
      } else if (evaluation.verdict === 'ACCEPT') {
        playersCount++;
        if (account.auto_accept_players && (!mm2Filter || mm2 === true)) {
          if (live) {
            const r = await this.robloxRequest(`https://friends.roblox.com/v1/users/${sid}/accept-friend-request`, 'POST', cookie, null, account.roblox_id);
            if (r.ok) status = 'accepted'; else actionErrors.push(`accept ${name}: ${r.status}`);
          } else status = 'accepted';
        }
      } else {
        reviewCount++;
      }

      const ageDays = profile.created ? Math.floor((Date.now() - new Date(profile.created).getTime()) / 86400000) : null;
      const facts = {
        ageDays, badges: profile.badgeCount ?? null, friends: profile.friendsCount ?? null,
        paidItem: profile.paidItem ? profile.paidItem.name : null, mutuals,
        mm2: mm2 === true ? true : undefined
      };
      await db.run(
        `INSERT INTO friend_requests (user_id, target_id, name, display_name, avatar_url, verdict, score, reasons, facts, status, auto, sent_at, checked_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
         ON CONFLICT(user_id, target_id) DO UPDATE SET name = excluded.name, display_name = excluded.display_name,
           avatar_url = COALESCE(excluded.avatar_url, friend_requests.avatar_url), verdict = excluded.verdict, score = excluded.score,
           reasons = excluded.reasons, facts = excluded.facts, status = excluded.status, auto = excluded.auto,
           checked_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP`,
        [userId, sid, name, displayName, headshots.get(sid) || null, evaluation.verdict, evaluation.threatScore,
         JSON.stringify(evaluation.reasons.slice(0, 4)), JSON.stringify(facts), status, status === 'pending' ? 0 : 1, fr.sentAt || null]
      );

      await db.run(
        `INSERT INTO scan_activity_logs (user_id, roblox_id, target_id, target_username, verdict, threat_score, reason)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [userId, account.roblox_id, sid, name, evaluation.verdict, evaluation.threatScore, evaluation.reasons[0] || '']
      );

      if (live && status !== 'pending') await new Promise(r => setTimeout(r, 400));
    }

    await keyService.recordStats(activeLicense.id, { filtered: toCheck.length, blocked: botsCount, accepted: playersCount });
    await db.run(`UPDATE roblox_accounts SET last_scan_at = CURRENT_TIMESTAMP WHERE id = ?`, [account.id]);
    if (actionErrors.length) {
      throw new Error(`Roblox blocked ${actionErrors.length} accept/decline action(s) (${actionErrors.slice(0, 2).join(', ')}). Your cookie may need refreshing.`);
    }
    return { scanned: toCheck.length, botsDeclined: botsCount, playersAccepted: playersCount, heldReview: reviewCount, simulated: !live || undefined };
  }

  /**
   * What the Friend requests page shows. The filter level decides what counts as "hidden":
   *   relaxed - hide only sure bots
   *   normal  - also hide suspicious accounts
   *   strict  - only show accounts that clearly look real
   */
  async getRequests(userId) {
    const account = await db.get(`SELECT filter_level, last_scan_at, last_check_at, last_error, is_active, auto_accept_players, accept_filter FROM roblox_accounts WHERE user_id = ?`, [userId]);
    if (!account) return { connected: false };
    const level = account.filter_level || 'normal';
    const rows = await db.all(
      `SELECT * FROM friend_requests WHERE user_id = ? AND (status = 'pending' OR (status = 'declined' AND auto = 1 AND updated_at > datetime('now', '-7 days')))
       ORDER BY COALESCE(sent_at, checked_at) DESC LIMIT 300`,
      [userId]
    );
    const visible = [], hidden = [];
    for (const r of rows) {
      const item = {
        id: r.target_id, name: r.name, displayName: r.display_name, avatar: r.avatar_url,
        verdict: r.verdict, score: r.score, reasons: safeJson(r.reasons, []), facts: safeJson(r.facts, {}),
        status: r.status, sentAt: r.sent_at
      };
      if (r.status === 'declined' || (account.accept_filter !== 'mm2' && isHidden(level, r.verdict, r.score))) hidden.push(item);
      else visible.push(item);
    }
    return {
      connected: true, level, active: !!account.is_active, autoAccept: !!account.auto_accept_players,
      acceptFilter: account.accept_filter || 'standard',
      lastScanAt: [account.last_check_at, account.last_scan_at].filter(Boolean).sort().pop() || null, lastError: account.last_error,
      requests: visible, hidden
    };
  }

  /**
   * Auto-accept switch on the Friend requests page. Turning it on also accepts
   * the waiting requests that clearly look real, right away.
   */
  async setAutoAccept(userId, enabled) {
    await db.run(`UPDATE roblox_accounts SET auto_accept_players = ? WHERE user_id = ?`, [enabled ? 1 : 0, userId]);
    let accepted = 0;
    if (enabled) {
      const acc = await db.get(`SELECT accept_filter FROM roblox_accounts WHERE user_id = ?`, [userId]);
      let rows = await db.all(`SELECT target_id, facts FROM friend_requests WHERE user_id = ? AND status = 'pending' AND verdict = 'ACCEPT'`, [userId]);
      if (acc?.accept_filter === 'mm2') rows = rows.filter(r => safeJson(r.facts, {}).mm2 === true);
      for (const r of rows) {
        try { await this.answerRequest(userId, r.target_id, true); accepted++; } catch (e) { /* skip ones Roblox refuses */ }
        await new Promise(res => setTimeout(res, 300));
      }
    }
    return { success: true, autoAccept: !!enabled, accepted };
  }

  async setAcceptFilter(userId, filter) {
    if (!['standard', 'mm2'].includes(filter)) throw new Error('Unknown filter');
    await db.run(`UPDATE roblox_accounts SET accept_filter = ? WHERE user_id = ?`, [filter, userId]);
    // Re-check waiting requests with the new filter on the next pass
    await db.run(`UPDATE friend_requests SET checked_at = NULL WHERE user_id = ? AND status = 'pending'`, [userId]);
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
    const cookie = this.decrypt(account.encrypted_cookie, account.cookie_iv);
    if (!isTestCookie(cookie)) {
      const r = await this.robloxRequest(
        `https://friends.roblox.com/v1/users/${row.target_id}/${accept ? 'accept' : 'decline'}-friend-request`,
        'POST', cookie, null, account.roblox_id
      );
      if (!r.ok && r.status !== 400) throw new Error(`Roblox didn't allow that (error ${r.status}). Try again.`);
    }
    await db.run(`UPDATE friend_requests SET status = ?, auto = 0, updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND target_id = ?`,
      [accept ? 'accepted' : 'declined', userId, row.target_id]);
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
        accounts = await db.all(`SELECT * FROM roblox_accounts WHERE is_active = 1`);
      } catch (e) { return; }
      const now = Date.now();
      for (const acc of accounts) {
        if (this.scanning.has(acc.user_id)) continue;
        if ((this.nextCheck.get(acc.user_id) || 0) > now) continue;
        this.scanning.add(acc.user_id);
        this.watchOne(acc).finally(() => {
          this.scanning.delete(acc.user_id);
          this.nextCheck.set(acc.user_id, Date.now() + randomWait());
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
      if (changed || stale) {
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

