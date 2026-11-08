const crypto = require('crypto');
const db = require('../database');

const TIER_CONFIG = {
  weekly: {
    name: 'Weekly',
    price: 15.00,
    days: 7,
    durationMs: 7 * 24 * 60 * 60 * 1000,
    prefix: 'WAURKS-W7D'
  },
  monthly: {
    name: 'Monthly',
    price: 45.00,
    days: 30,
    durationMs: 30 * 24 * 60 * 60 * 1000,
    prefix: 'WAURKS-M30'
  },
  yearly: {
    name: 'Yearly',
    price: 115.00,
    days: 365,
    durationMs: 365 * 24 * 60 * 60 * 1000,
    prefix: 'WAURKS-Y1Y'
  }
};

/**
 * Generates an unguessable 24-character cryptographic key string
 */
function generateKeyString(tier) {
  const cfg = TIER_CONFIG[tier] || TIER_CONFIG.weekly;
  const chunk1 = crypto.randomBytes(3).toString('hex').toUpperCase();
  const chunk2 = crypto.randomBytes(3).toString('hex').toUpperCase();
  const chunk3 = crypto.randomBytes(3).toString('hex').toUpperCase();
  return `${cfg.prefix}-${chunk1}-${chunk2}-${chunk3}`;
}

class KeyService {
  /**
   * Issues a new key for a user upon completed payment
   */
  async issueKey(userId, tier) {
    const config = TIER_CONFIG[tier];
    if (!config) throw new Error(`Invalid tier: ${tier}`);

    const keyCode = generateKeyString(tier);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + config.durationMs);

    const result = await db.run(
      `INSERT INTO licenses (key_code, user_id, tier, status, expires_at) VALUES (?, ?, ?, 'active', ?)`,
      [keyCode, userId, tier, expiresAt.toISOString()]
    );

    return {
      licenseId: result.lastID,
      keyCode,
      tier,
      expiresAt: expiresAt.toISOString(),
      days: config.days
    };
  }

  /**
   * Validates a license key with anti-crack, HWID binding, and expiration verification
   */
  async validateKey(keyCode, clientHwid = null, ip = null) {
    if (!keyCode || typeof keyCode !== 'string') {
      return { valid: false, reason: 'Key required' };
    }

    const cleanKey = keyCode.trim().toUpperCase();
    const license = await db.get(
      `SELECT l.*, u.username as owner_username, u.discord_id 
       FROM licenses l 
       JOIN users u ON l.user_id = u.id 
       WHERE l.key_code = ?`,
      [cleanKey]
    );

    if (!license) {
      return { valid: false, reason: 'Invalid license key' };
    }

    if (license.status === 'revoked') {
      return { valid: false, reason: 'This license has been permanently revoked for security violations.' };
    }

    const now = new Date();
    const expiresAt = new Date(license.expires_at);

    if (now > expiresAt) {
      if (license.status !== 'expired') {
        await db.run(`UPDATE licenses SET status = 'expired' WHERE id = ?`, [license.id]);
      }
      return {
        valid: false,
        reason: 'License key expired. Please renew your subscription to continue.',
        expired: true,
        expiresAt: license.expires_at
      };
    }

    // Hardware / Browser fingerprint enforcement to stop key sharing
    if (clientHwid) {
      if (!license.hwid_binding) {
        // First activation: bind to this client fingerprint
        await db.run(`UPDATE licenses SET hwid_binding = ? WHERE id = ?`, [clientHwid, license.id]);
        license.hwid_binding = clientHwid;
      } else if (license.hwid_binding !== clientHwid) {
        await db.run(
          `INSERT INTO audit_logs (license_id, action, details, ip_address) VALUES (?, 'HWID_MISMATCH', ?, ?)`,
          [license.id, `Attempted access with HWID ${clientHwid}, bound to ${license.hwid_binding}`, ip]
        );
        return {
          valid: false,
          reason: 'Key is bound to another device or browser. Reset device binding on your Waurks dashboard if you recently switched devices.'
        };
      }
    }

    // Update last used timestamp
    await db.run(`UPDATE licenses SET last_used_at = CURRENT_TIMESTAMP WHERE id = ?`, [license.id]);

    const msRemaining = expiresAt.getTime() - now.getTime();
    const daysRemaining = Math.max(0, Math.ceil(msRemaining / (1000 * 60 * 60 * 24)));
    const hoursRemaining = Math.max(0, Math.ceil(msRemaining / (1000 * 60 * 60)));

    return {
      valid: true,
      licenseId: license.id,
      tier: license.tier,
      expiresAt: license.expires_at,
      daysRemaining,
      hoursRemaining,
      owner: license.owner_username,
      totalFiltered: license.total_requests_filtered,
      botsBlocked: license.total_bots_blocked,
      playersAccepted: license.total_players_accepted
    };
  }

  /**
   * Resets HWID binding (allowed by the account owner)
   */
  async resetHwid(userId, licenseId) {
    const license = await db.get(`SELECT * FROM licenses WHERE id = ? AND user_id = ?`, [licenseId, userId]);
    if (!license) throw new Error('License not found or unauthorized');

    await db.run(`UPDATE licenses SET hwid_binding = NULL WHERE id = ?`, [licenseId]);
    await db.run(
      `INSERT INTO audit_logs (license_id, action, details) VALUES (?, 'HWID_RESET', 'User reset HWID binding')`,
      [licenseId]
    );
    return { success: true };
  }

  /**
   * Updates usage statistics for a license
   */
  async recordStats(licenseId, { filtered = 0, blocked = 0, accepted = 0 }) {
    await db.run(
      `UPDATE licenses 
       SET total_requests_filtered = total_requests_filtered + ?,
           total_bots_blocked = total_bots_blocked + ?,
           total_players_accepted = total_players_accepted + ?
       WHERE id = ?`,
      [filtered, blocked, accepted, licenseId]
    );
  }

  /**
   * Get active licenses for a user
   */
  async getUserLicenses(userId) {
    const licenses = await db.all(
      `SELECT * FROM licenses WHERE user_id = ? ORDER BY id DESC`,
      [userId]
    );
    const now = new Date();
    return licenses.map(lic => {
      const exp = new Date(lic.expires_at);
      const isExpired = now > exp || lic.status === 'expired';
      const msRem = Math.max(0, exp.getTime() - now.getTime());
      const daysRem = Math.ceil(msRem / (1000 * 60 * 60 * 24));
      return {
        ...lic,
        isExpired,
        daysRemaining: isExpired ? 0 : daysRem
      };
    });
  }
}

module.exports = {
  keyService: new KeyService(),
  TIER_CONFIG
};

