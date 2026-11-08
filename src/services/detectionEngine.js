const crypto = require('crypto');
const db = require('../database');

// Secret for signing operational decision nonces
const ENGINE_SECRET = process.env.ENGINE_SECRET || 'waurks-secure-heuristic-engine-key-2026';

// Common scam phrases found in bot bios & usernames
const SCAM_PATTERNS = [
  /free[\s_.-]*robux/i,
  /claim[\s_.-]*(now|gift|reward|card)/i,
  /giveaway/i,
  /rbx[\s_.-]*(free|hub|win|gg|ez)/i,
  /ro[\s_.-]*bux/i,
  /giftcard/i,
  /\.gg\b/i,
  /discord[\s_.-]*(gg|\.gg)/i,
  /t\.me\b/i,
  /pastebin\.com/i,
  /check[\s_.-]*my[\s_.-]*(bio|about|desc|link)/i,
  /visit[\s_.-]*(my|the)[\s_.-]*(link|site|web)/i,
  /promocode/i,
  /generator/i,
  /blox\.promo/i,
  /getrobux/i
];

// Common automated bot naming formats (e.g. name + 4 to 6 digits)
const BOT_NAME_REGEXES = [
  /^[A-Za-z]+[0-9]{4,7}$/,                // e.g. AidenMason4471, JackSmith99212
  /^[A-Z][a-z]+[A-Z][a-z]+[0-9]{3,6}$/,   // e.g. ToddlerPlays88219 (if newly registered)
  /^CLAIM_NOW/i,
  /^FreeRobux/i,
  /^[a-z]{3,4}[0-9]{5,8}$/i               // e.g. abcd982713
];

class DetectionEngine {
  /**
   * Calculates Shannon entropy of a string (higher = more random/generated)
   */
  calculateEntropy(str) {
    if (!str || str.length === 0) return 0;
    const len = str.length;
    const frequencies = {};
    for (let i = 0; i < len; i++) {
      const char = str[i];
      frequencies[char] = (frequencies[char] || 0) + 1;
    }
    let entropy = 0;
    for (const char in frequencies) {
      const p = frequencies[char] / len;
      entropy -= p * Math.log2(p);
    }
    return entropy;
  }

  /**
   * Evaluates a single Roblox user profile against multi-layered heuristics
   */
  async evaluateProfile(profile) {
    const {
      id,
      name = '',
      displayName = '',
      description = '',
      created = null,
      isBanned = false,
      friendsCount = null,
      badgeCount = null
    } = profile;

    let threatScore = 0;
    const flags = [];

    // 1. Check Global Blacklist
    if (id) {
      const blacklisted = await db.get(
        `SELECT * FROM global_bot_blacklist WHERE roblox_user_id = ?`,
        [String(id)]
      );
      if (blacklisted) {
        return {
          id,
          name,
          threatScore: 100,
          verdict: 'DECLINE',
          reasons: [`Matched Global Threat Database: ${blacklisted.reason}`]
        };
      }
    }

    // Check blacklist regex on name
    const allRegexBlacklist = await db.all(`SELECT username_pattern, reason FROM global_bot_blacklist WHERE username_pattern IS NOT NULL`);
    for (const row of allRegexBlacklist) {
      try {
        const reg = new RegExp(row.username_pattern, 'i');
        if (reg.test(name) || reg.test(displayName)) {
          return {
            id,
            name,
            threatScore: 99,
            verdict: 'DECLINE',
            reasons: [`Blacklisted name pattern: ${row.reason}`]
          };
        }
      } catch (e) {}
    }

    // 2. Scan Bio / Description for Scam/Phishing patterns
    const bioText = (description || '').toLowerCase();
    for (const pattern of SCAM_PATTERNS) {
      if (pattern.test(bioText)) {
        threatScore += 65;
        flags.push(`Bio contains phishing/scam trigger pattern`);
        break;
      }
    }

    // Check for suspicious URLs or link shorteners in bio
    if (/https?:\/\/[^\s]+/i.test(bioText) || /[a-z0-9-]+\.(xyz|top|site|click|link|tk|ml|ga|cf|gq)/i.test(bioText)) {
      threatScore += 50;
      flags.push('Unverified external URL or shady TLD in bio');
    }

    // 3. Username Heuristics & Entropy
    for (const pattern of SCAM_PATTERNS) {
      if (pattern.test(name) || pattern.test(displayName)) {
        threatScore += 70;
        flags.push('Username or Display name matches spam keyword');
        break;
      }
    }

    for (const botNameRegex of BOT_NAME_REGEXES) {
      if (botNameRegex.test(name)) {
        threatScore += 25;
        flags.push('Username matches known mass-generator naming format');
        break;
      }
    }

    const entropy = this.calculateEntropy(name);
    if (entropy > 3.6 && name.length >= 10) {
      threatScore += 20;
      flags.push('High character entropy in username (randomized letters/numbers)');
    }

    // 4. Account Age Heuristics
    if (created) {
      const createdDate = new Date(created);
      const now = new Date();
      const ageInDays = (now - createdDate) / (1000 * 60 * 60 * 24);

      if (ageInDays < 2) {
        threatScore += 45;
        flags.push('Brand new account (created < 48 hours ago)');
      } else if (ageInDays < 7) {
        threatScore += 30;
        flags.push('Very recent account (created < 7 days ago)');
      } else if (ageInDays < 30) {
        threatScore += 15;
        flags.push('Account is less than 30 days old');
      } else if (ageInDays > 365 * 2) {
        // Established account (> 2 years old) - strong human signal
        threatScore -= 30;
        flags.push('Established account (> 2 years active)');
      } else if (ageInDays > 120) {
        threatScore -= 15;
      }
    }

    // 5. Social & Badge signals (if provided)
    if (badgeCount !== null) {
      if (badgeCount === 0) {
        threatScore += 25;
        flags.push('0 game badges earned');
      } else if (badgeCount > 5) {
        threatScore -= 35;
        flags.push(`Active player with ${badgeCount} game badges`);
      }
    }

    if (friendsCount !== null) {
      if (friendsCount === 0) {
        threatScore += 15;
        flags.push('0 existing friends');
      } else if (friendsCount > 5) {
        threatScore -= 20;
        flags.push(`Has ${friendsCount} existing friends`);
      }
    }

    if (isBanned) {
      threatScore = 100;
      flags.push('Account is banned or flagged by Roblox');
    }

    // Normalize threat score between 0 and 100
    threatScore = Math.max(0, Math.min(100, threatScore));

    // Determine verdict
    let verdict = 'REVIEW';
    if (threatScore >= 60) {
      verdict = 'DECLINE';
    } else if (threatScore <= 25) {
      verdict = 'ACCEPT';
    } else {
      verdict = 'REVIEW';
    }

    return {
      id,
      name,
      displayName: displayName || name,
      threatScore,
      verdict,
      reasons: flags.length > 0 ? flags : ['Standard player activity indicators']
    };
  }

  /**
   * Batch evaluates candidate friend requests and returns cryptographically signed verdicts
   */
  async evaluateBatch(profiles, licenseInfo) {
    const results = [];
    let botsCount = 0;
    let playersCount = 0;

    for (const profile of profiles) {
      const evaluation = await this.evaluateProfile(profile);

      // Sign decision token with HMAC so client cannot forge actions
      const hmac = crypto.createHmac('sha256', ENGINE_SECRET);
      const actionPayload = `${profile.id}:${evaluation.verdict}:${Date.now()}:${licenseInfo.licenseId}`;
      const actionToken = hmac.update(actionPayload).digest('hex');

      if (evaluation.verdict === 'DECLINE') botsCount++;
      if (evaluation.verdict === 'ACCEPT') playersCount++;

      results.push({
        ...evaluation,
        actionToken,
        timestamp: Date.now()
      });
    }

    return {
      evaluations: results,
      summary: {
        total: profiles.length,
        botsDetected: botsCount,
        playersApproved: playersCount,
        heldForReview: profiles.length - botsCount - playersCount
      }
    };
  }
}

module.exports = new DetectionEngine();

