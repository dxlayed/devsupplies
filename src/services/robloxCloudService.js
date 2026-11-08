const crypto = require('crypto');
const db = require('../database');
const detectionEngine = require('./detectionEngine');
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
        `INSERT INTO roblox_accounts (user_id, license_id, roblox_id, roblox_username, avatar_url, encrypted_cookie, cookie_iv, is_active)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
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
  async runCloudScan(userId) {
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
      await db.run(`UPDATE roblox_accounts SET is_active = 0 WHERE id = ?`, [account.id]);
      throw new Error('Active Waurks subscription required. Please purchase or renew your key to continue cloud protection.');
    }

    // Ensure account is linked to the active license
    if (account.license_id !== activeLicense.id) {
      await db.run(`UPDATE roblox_accounts SET license_id = ? WHERE id = ?`, [activeLicense.id, account.id]);
    }

    const cookie = this.decrypt(account.encrypted_cookie, account.cookie_iv);

    // If test / demo mode account
    if (cookie.startsWith('TEST_COOKIE_') || cookie.startsWith('DEMO_')) {
      return await this.simulateCloudScan(userId, account, activeLicense);
    }

    // 2. Fetch pending friend requests from Roblox
    const requestsRes = await this.robloxRequest(
      'https://friends.roblox.com/v1/my/friends/requests?limit=25&sortOrder=Desc',
      'GET',
      cookie,
      null,
      account.roblox_id
    );

    if (!requestsRes.ok) {
      if (requestsRes.status === 401) {
        await db.run(`UPDATE roblox_accounts SET is_active = 0 WHERE id = ?`, [account.id]);
        throw new Error('Roblox cookie expired. Please reconnect your Roblox account on the dashboard.');
      }
      throw new Error(`Roblox Friends API HTTP ${requestsRes.status}`);
    }

    const requestsData = await requestsRes.json();
    const pendingList = requestsData.data || [];

    if (pendingList.length === 0) {
      await db.run(`UPDATE roblox_accounts SET last_scan_at = CURRENT_TIMESTAMP WHERE id = ?`, [account.id]);
      return {
        scanned: 0,
        botsDeclined: 0,
        playersAccepted: 0,
        message: 'No pending friend requests to sort.'
      };
    }

    let botsCount = 0;
    let playersCount = 0;
    let reviewCount = 0;

    for (const applicant of pendingList) {
      // Gather user profile details
      let profile = { id: applicant.id, name: applicant.name, displayName: applicant.displayName };
      try {
        const pRes = await fetch(`https://users.roblox.com/v1/users/${applicant.id}`);
        if (pRes.ok) {
          const pData = await pRes.json();
          profile = { ...profile, description: pData.description, created: pData.created, isBanned: pData.isBanned };
        }
      } catch (e) {}

      // Evaluate profile through Waurks threat heuristics
      const evaluation = await detectionEngine.evaluateProfile(profile);

      // Custom Blacklist Keywords check
      if (account.custom_blacklist) {
        const words = account.custom_blacklist.split(',').map(w => w.trim().toLowerCase()).filter(Boolean);
        const textToCheck = ((profile.name || '') + ' ' + (profile.description || '')).toLowerCase();
        for (const w of words) {
          if (textToCheck.includes(w)) {
            evaluation.verdict = 'DECLINE';
            evaluation.threatScore = 100;
            evaluation.reasons = [`Matched custom blacklist keyword: "${w}"`];
            break;
          }
        }
      }

      // Custom Whitelist Keywords check
      if (account.custom_whitelist) {
        const words = account.custom_whitelist.split(',').map(w => w.trim().toLowerCase()).filter(Boolean);
        const textToCheck = ((profile.name || '') + ' ' + (profile.description || '')).toLowerCase();
        for (const w of words) {
          if (textToCheck.includes(w)) {
            evaluation.verdict = 'ACCEPT';
            evaluation.threatScore = 0;
            evaluation.reasons = [`Matched custom whitelist keyword: "${w}"`];
            break;
          }
        }
      }

      // Custom Minimum Account Age check
      if (account.min_account_age_days && profile.created) {
        const ageDays = (Date.now() - new Date(profile.created).getTime()) / 86400000;
        if (ageDays < account.min_account_age_days && evaluation.verdict !== 'DECLINE') {
          evaluation.verdict = 'DECLINE';
          evaluation.threatScore = Math.max(evaluation.threatScore, 85);
          evaluation.reasons = [`Account is younger than custom filter (${Math.floor(ageDays)}d < ${account.min_account_age_days}d)`];
        }
      }

      // Execute action on Roblox
      if (evaluation.verdict === 'DECLINE') {
        if (account.auto_decline_bots) {
          await this.robloxRequest(
            `https://friends.roblox.com/v1/users/${applicant.id}/decline-friend-request`,
            'POST',
            cookie,
            null,
            account.roblox_id
          );
        }
        botsCount++;
      } else if (evaluation.verdict === 'ACCEPT') {
        if (account.auto_accept_players) {
          await this.robloxRequest(
            `https://friends.roblox.com/v1/users/${applicant.id}/accept-friend-request`,
            'POST',
            cookie,
            null,
            account.roblox_id
          );
        }
        playersCount++;
      } else {
        if (account.hold_review) {
          await db.run(
            `INSERT INTO review_queue (user_id, roblox_id, target_id, target_username, target_display_name, threat_score, reasons)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [userId, account.roblox_id, String(applicant.id), applicant.name, applicant.displayName || applicant.name, evaluation.threatScore, evaluation.reasons.join('; ')]
          );
        }
        reviewCount++;
      }

      // Record in cloud database log
      await db.run(
        `INSERT INTO scan_activity_logs (user_id, roblox_id, target_id, target_username, verdict, threat_score, reason)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [userId, account.roblox_id, String(applicant.id), applicant.name, evaluation.verdict, evaluation.threatScore, evaluation.reasons[0] || '']
      );

      // Throttling to respect Roblox API limits
      await new Promise(r => setTimeout(r, 1500));
    }

    // Update stats
    await keyService.recordStats(activeLicense.id, {
      filtered: pendingList.length,
      blocked: botsCount,
      accepted: playersCount
    });

    await db.run(`UPDATE roblox_accounts SET last_scan_at = CURRENT_TIMESTAMP WHERE id = ?`, [account.id]);

    return {
      scanned: pendingList.length,
      botsDeclined: botsCount,
      playersAccepted: playersCount,
      heldReview: reviewCount
    };
  }

  /**
   * Simulation scanner for demo / test accounts without live Roblox cookies
   */
  async simulateCloudScan(userId, account, activeLicense) {
    const demoRequesters = [
      { id: 9817263, name: 'ClaimRobux_x882', displayName: 'Robux Giveaway', description: 'Visit giftcard.gg/free for 10,000 robux!', created: new Date(Date.now() - 86400000).toISOString() },
      { id: 1827364, name: 'BlockyGamer_Ethan', displayName: 'Ethan', description: 'Builder & Anime fan. Add me!', created: new Date(Date.now() - 86400000 * 400).toISOString(), badgeCount: 22, friendsCount: 30 },
      { id: 2938475, name: 'free_rbx_bot99', displayName: 'FreeRobux', description: 'ro-bux generator link in bio', created: new Date(Date.now() - 86400000 * 2).toISOString() },
      { id: 3847561, name: 'PixelSammy', displayName: 'Sammy', description: 'hello world', created: new Date(Date.now() - 86400000 * 700).toISOString(), badgeCount: 12, friendsCount: 45 }
    ];

    let botsCount = 0;
    let playersCount = 0;
    let reviewCount = 0;

    for (const applicant of demoRequesters) {
      const evaluation = await detectionEngine.evaluateProfile(applicant);

      if (evaluation.verdict === 'DECLINE') botsCount++;
      else if (evaluation.verdict === 'ACCEPT') playersCount++;
      else reviewCount++;

      await db.run(
        `INSERT INTO scan_activity_logs (user_id, roblox_id, target_id, target_username, verdict, threat_score, reason)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [userId, account.roblox_id, String(applicant.id), applicant.name, evaluation.verdict, evaluation.threatScore, evaluation.reasons[0] || '']
      );
    }

    await keyService.recordStats(activeLicense.id, {
      filtered: demoRequesters.length,
      blocked: botsCount,
      accepted: playersCount
    });

    await db.run(`UPDATE roblox_accounts SET last_scan_at = CURRENT_TIMESTAMP WHERE id = ?`, [account.id]);

    return {
      scanned: demoRequesters.length,
      botsDeclined: botsCount,
      playersAccepted: playersCount,
      heldReview: reviewCount,
      simulated: true
    };
  }

  /**
   * Starts the 24/7 background worker loop
   */
  startDaemon(intervalSeconds = 60) {
    if (this.isDaemonRunning) return;
    this.isDaemonRunning = true;
    console.log(`[Waurks Cloud Daemon] Started 24/7 background bot scanner (checking every ${intervalSeconds}s)...`);

    this.daemonInterval = setInterval(async () => {
      try {
        const activeAccounts = await db.all(
          `SELECT DISTINCT user_id FROM roblox_accounts WHERE is_active = 1`
        );
        for (const row of activeAccounts) {
          try {
            await this.runCloudScan(row.user_id);
          } catch (e) {
            // Silently ignore or log per-account scan tick
          }
        }
      } catch (e) {
        console.error('[Waurks Cloud Daemon Error]:', e.message);
      }
    }, intervalSeconds * 1000);
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

