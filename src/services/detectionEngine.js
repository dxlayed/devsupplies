/**
 * Waurks bot checker.
 *
 * Every friend request is scored on six separate groups of checks:
 *   content   - scam words or links in the bio/name, fake "Roblox"/"Admin" display names
 *   age       - how old the account is
 *   activity  - badges, friends, followers, groups, default avatar, follow-spam
 *   name      - keyboard-mash names (weak on purpose: lots of real kids have odd names)
 *   network   - what we've seen across ALL Waurks customers: the same account
 *               spamming many people, the same bio copied across many accounts,
 *               and what other customers decided about it
 *   context   - mutual friends, met in a game, waves of new accounts arriving together
 *
 * Bot points push the score up, real-player points push it down (0-100).
 * To auto-DECLINE we need a high score AND bot evidence from at least TWO groups,
 * so one odd thing (like a name with numbers) never gets a real player declined.
 * To auto-ACCEPT we need a low score AND real signs of a human (old account plus activity,
 * mutual friends, or meeting in a game). Everything in between goes to the
 * "Not sure about these" list so the customer decides.
 */
const crypto = require('crypto');
const db = require('../database');

const ENGINE_SECRET = process.env.ENGINE_SECRET || 'waurks-secure-heuristic-engine-key-2026';

// Network memory tables
db.run(`CREATE TABLE IF NOT EXISTS bio_fingerprints (
  hash TEXT NOT NULL, roblox_id TEXT NOT NULL, seen_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (hash, roblox_id)
)`).catch(() => {});
db.run(`CREATE TABLE IF NOT EXISTS bot_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT, target_id TEXT NOT NULL, user_id INTEGER NOT NULL,
  verdict TEXT NOT NULL CHECK(verdict IN ('BOT', 'HUMAN')), created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (target_id, user_id)
)`).catch(() => {});

// Scam phrases seen in bot bios and names
const SCAM_PATTERNS = [
  /free[\s_.-]*r(o|0)[\s_.-]*b(u|o)x/i, /\brbx[\s_.-]*(free|hub|win|gg|ez|cash)/i, /r(o|0)bux[\s_.-]*(gen|generator|giveaway|free|earn|claim)/i,
  /claim[\s_.-]*(now|gift|reward|card|robux|prize)/i, /give[\s_.-]*away/i, /gift[\s_.-]*card/i, /promo[\s_.-]*code/i,
  /\bgenerator\b/i, /blox\.(promo|land|fun|gg)/i, /getrobux/i, /earn[\s_.-]*(robux|rbx)/i, /double[\s_.-]*(your)?[\s_.-]*robux/i,
  /check[\s_.-]*(my|the)[\s_.-]*(bio|about|desc|profile|link|status)/i, /visit[\s_.-]*(my|the|this)[\s_.-]*(link|site|web)/i,
  /\bhot[\s_.-]*(girls?|pics?)\b/i, /\bdm[\s_.-]*(me)?[\s_.-]*for[\s_.-]*(robux|rbx|free)/i, /\bwin[\s_.-]*\d+[\s_.-]*(robux|rbx)/i
];
// Links, invites and off-site contact
const LINK_PATTERNS = [
  /https?:\/\//i, /\bwww\./i, /discord(\.gg|\.com\/invite|app\.com\/invite)/i, /\.gg\//i, /\bt\.me\b/i, /\bbit\.ly\b/i,
  /\b[a-z0-9-]{3,}\.(xyz|top|site|click|link|tk|ml|ga|cf|gq|ru|shop|live|fun|online|store)\b/i, /pastebin|linktr\.ee|tinyurl|cutt\.ly/i
];
// Display names pretending to be official
const IMPERSONATION = /\b(roblox|admin|moderator|official|staff|support|giveaway|rewards?|robux)\b/i;

function entropy(str) {
  if (!str) return 0;
  const f = {};
  for (const c of str) f[c] = (f[c] || 0) + 1;
  return Object.values(f).reduce((e, n) => { const p = n / str.length; return e - p * Math.log2(p); }, 0);
}

// "xkqzvbnm", "bnmqwrtz77" -> keyboard mash. Real names have vowels.
function looksGibberish(name) {
  const letters = name.toLowerCase().replace(/[^a-z]/g, '');
  if (letters.length < 6) return false;
  const vowels = (letters.match(/[aeiouy]/g) || []).length;
  const longestConsonantRun = Math.max(0, ...(letters.match(/[^aeiouy]+/g) || ['']).map(s => s.length));
  return vowels / letters.length < 0.2 || longestConsonantRun >= 5;
}

function ageDays(created) {
  if (!created) return null;
  const t = new Date(created).getTime();
  return Number.isFinite(t) ? (Date.now() - t) / 86400000 : null;
}

function bioHash(bio) {
  const norm = String(bio || '').toLowerCase().replace(/\s+/g, ' ').replace(/[0-9]/g, '#').trim();
  return norm.length >= 12 ? crypto.createHash('sha1').update(norm).digest('hex') : null;
}

class DetectionEngine {
  calculateEntropy(str) { return entropy(str); }

  /**
   * What we've learned about an account across every Waurks customer.
   */
  async networkInfo(id, description, forUserId) {
    const out = { fanOut: 0, sameBio: 0, botReports: 0, humanReports: 0 };
    if (!id) return out;
    const sid = String(id);
    try {
      const fan = await db.get(
        `SELECT COUNT(DISTINCT user_id) AS n FROM scan_activity_logs
         WHERE target_id = ? AND created_at > datetime('now', '-7 days') AND (? IS NULL OR user_id != ?)`,
        [sid, forUserId ?? null, forUserId ?? null]
      );
      out.fanOut = fan?.n || 0;

      const h = bioHash(description);
      if (h) {
        await db.run(`INSERT OR IGNORE INTO bio_fingerprints (hash, roblox_id) VALUES (?, ?)`, [h, sid]);
        const same = await db.get(
          `SELECT COUNT(*) AS n FROM bio_fingerprints WHERE hash = ? AND roblox_id != ? AND seen_at > datetime('now', '-30 days')`,
          [h, sid]
        );
        out.sameBio = same?.n || 0;
      }

      const rep = await db.get(
        `SELECT SUM(verdict = 'BOT') AS bot, SUM(verdict = 'HUMAN') AS human FROM bot_reports WHERE target_id = ? AND (? IS NULL OR user_id != ?)`,
        [sid, forUserId ?? null, forUserId ?? null]
      );
      out.botReports = rep?.bot || 0;
      out.humanReports = rep?.human || 0;
    } catch (e) { /* network memory is a bonus, never block a check on it */ }
    return out;
  }

  /**
   * Scores one account. `ctx` is optional extra context from the scan:
   *   { forUserId, mutualFriends, metInGame, burstSiblings }
   */
  async evaluateProfile(profile, ctx = {}) {
    const p = profile || {};
    const id = p.id;
    const name = String(p.name || '');
    const displayName = String(p.displayName || '');
    const bio = String(p.description || '');
    const reasons = [];      // bot-leaning reasons
    const humanReasons = []; // real-player reasons
    const botGroups = new Set();
    let score = 0;

    const bot = (group, pts, why) => { score += pts; botGroups.add(group); reasons.push(why); };
    const human = (pts, why) => { score -= pts; humanReasons.push(why); };
    const result = (verdict, s, why) => ({ id, name, displayName: displayName || name, threatScore: s, verdict, reasons: why });

    // ---- Instant answers ----
    if (id) {
      const listed = await db.get(`SELECT reason FROM global_bot_blacklist WHERE roblox_user_id = ?`, [String(id)]).catch(() => null);
      if (listed) return result('DECLINE', 100, [`On the Waurks block list: ${listed.reason}`]);
    }
    const patterns = await db.all(`SELECT username_pattern, reason FROM global_bot_blacklist WHERE username_pattern IS NOT NULL`).catch(() => []);
    for (const row of patterns) {
      try {
        if (new RegExp(row.username_pattern, 'i').test(name) || new RegExp(row.username_pattern, 'i').test(displayName)) {
          return result('DECLINE', 99, [`Name matches a blocked pattern: ${row.reason}`]);
        }
      } catch (e) { /* bad pattern in admin list, skip it */ }
    }
    if (p.isBanned) return result('DECLINE', 100, ['Account is banned by Roblox']);
    if (p.hasVerifiedBadge) return result('ACCEPT', 0, ['Verified by Roblox']);

    // ---- 1. Profile content ----
    if (SCAM_PATTERNS.some(r => r.test(bio))) bot('content', 40, 'Scam words in bio');
    if (LINK_PATTERNS.some(r => r.test(bio))) bot('content', 25, 'Link or invite in bio');
    if (SCAM_PATTERNS.some(r => r.test(name) || r.test(displayName))) bot('content', 35, 'Scam words in name');
    if (IMPERSONATION.test(displayName) && !IMPERSONATION.test(name)) bot('content', 30, `Display name "${displayName}" pretends to be official`);
    else if (IMPERSONATION.test(name)) bot('content', 20, 'Name pretends to be official');

    // ---- 2. Account age ----
    const age = ageDays(p.created);
    if (age !== null) {
      if (age < 1) bot('age', 30, 'Made today');
      else if (age < 3) bot('age', 25, `Only ${Math.floor(age)} day${Math.floor(age) === 1 ? '' : 's'} old`);
      else if (age < 7) bot('age', 18, `Only ${Math.floor(age)} days old`);
      else if (age < 30) { score += 8; reasons.push(`${Math.floor(age)} days old`); }
      else if (age > 730) human(25, `${Math.floor(age / 365)} years old`);
      else if (age > 365) human(15, 'Over a year old');
    }

    // ---- 3. Activity ----
    let activityBot = 0;
    const act = (pts, why) => { activityBot += pts; score += pts; reasons.push(why); };
    if (p.badgeCount !== null && p.badgeCount !== undefined) {
      if (p.badgeCount === 0) act(18, 'No badges (never really played)');
      else if (p.badgeCount >= 10) human(22, `${p.badgeCount >= 25 ? '25+' : p.badgeCount} badges`);
      else if (p.badgeCount >= 3) human(12, `${p.badgeCount} badges`);
    }
    if (p.friendsCount !== null && p.friendsCount !== undefined) {
      if (p.friendsCount === 0) act(12, 'No friends');
      else if (p.friendsCount >= 25) human(18, `${p.friendsCount} friends`);
      else if (p.friendsCount >= 5) human(10, `${p.friendsCount} friends`);
    }
    if (p.followersCount >= 50) human(10, `${p.followersCount} followers`);
    if (p.followingsCount >= 200 && (p.friendsCount ?? 0) <= 2) act(15, `Follows ${p.followingsCount} people but has almost no friends`);
    if (p.groupsCount !== null && p.groupsCount !== undefined) {
      if (p.groupsCount === 0) act(6, 'Not in any groups');
      else if (p.groupsCount >= 3) human(8, `In ${p.groupsCount} groups`);
    }
    if (p.avatarAssetCount !== null && p.avatarAssetCount !== undefined) {
      if (p.avatarAssetCount <= 2) act(12, 'Still has the default avatar');
      else if (p.avatarAssetCount >= 8) human(6, 'Customized avatar');
    }
    if (activityBot >= 25) botGroups.add('activity');

    // ---- 4. Name shape (weak) ----
    if (looksGibberish(name)) { score += 12; reasons.push('Name looks like random letters'); if (entropy(name) > 3.3) botGroups.add('name'); }
    else if (/^[A-Za-z]+_?\d{5,}$/.test(name)) { score += 5; reasons.push('Name ends in a long number'); }
    if (p.nameChanges >= 3) { score += 8; reasons.push(`Changed name ${p.nameChanges} times`); }

    // ---- 5. Across all Waurks customers ----
    const net = await this.networkInfo(id, bio, ctx.forUserId);
    const established = age !== null && age > 365 && (p.badgeCount ?? 0) >= 10;
    if (net.fanOut >= 2) {
      let pts = net.fanOut >= 8 ? 50 : net.fanOut >= 4 ? 35 : 20;
      if (established) pts = Math.round(pts / 2);
      bot('network', pts, `Sent requests to ${net.fanOut} other Waurks users this week`);
    }
    if (net.sameBio >= 2) bot('network', net.sameBio >= 5 ? 45 : 35, `Same bio as ${net.sameBio} other accounts (bot farm)`);
    if (net.botReports >= 1) bot('network', net.botReports >= 3 ? 40 : 20, `${net.botReports} Waurks user${net.botReports === 1 ? '' : 's'} marked it as a bot`);
    if (net.humanReports >= 1) human(Math.min(40, net.humanReports * 20), `${net.humanReports} Waurks user${net.humanReports === 1 ? '' : 's'} said it's a real player`);

    // ---- 6. How you met ----
    const mutuals = ctx.mutualFriends || 0;
    if (mutuals >= 1) human(mutuals >= 3 ? 50 : 40, `${mutuals} mutual friend${mutuals === 1 ? '' : 's'}`);
    if (ctx.metInGame) human(20, 'Sent from inside a game you were in');
    if ((ctx.burstSiblings || 0) >= 3 && age !== null && age < 30) {
      bot('context', 15, `Came in with ${ctx.burstSiblings} other brand-new accounts`);
    }

    // ---- Decide ----
    score = Math.max(0, Math.min(100, Math.round(score)));
    const humanProof = mutuals >= 1 || ctx.metInGame || net.humanReports >= 1 ||
      (age !== null && age >= 30 && ((p.badgeCount ?? 0) >= 3 || (p.friendsCount ?? 0) >= 5));

    let verdict = 'REVIEW';
    if (score >= 65 && (botGroups.size >= 2 || score >= 90)) verdict = 'DECLINE';
    else if (score <= 15 && humanProof) verdict = 'ACCEPT';

    // Most important reasons first: bot reasons for declines, real-player ones for accepts
    const ordered = verdict === 'ACCEPT' ? [...humanReasons, ...reasons] : [...reasons, ...humanReasons];
    const unique = [...new Set(ordered)];

    return result(verdict, score, unique.length ? unique : ['Not enough info yet']);
  }

  /**
   * Scores a batch and signs each decision so it can't be forged.
   */
  async evaluateBatch(profiles, licenseInfo = {}, ctx = {}) {
    const results = [];
    let bots = 0, players = 0;
    for (const profile of profiles) {
      const evaluation = await this.evaluateProfile(profile, ctx);
      const token = crypto.createHmac('sha256', ENGINE_SECRET)
        .update(`${profile.id}:${evaluation.verdict}:${Date.now()}:${licenseInfo.licenseId}`).digest('hex');
      if (evaluation.verdict === 'DECLINE') bots++;
      if (evaluation.verdict === 'ACCEPT') players++;
      results.push({ ...evaluation, actionToken: token, timestamp: Date.now() });
    }
    return {
      evaluations: results,
      summary: { total: profiles.length, botsDetected: bots, playersApproved: players, heldForReview: profiles.length - bots - players }
    };
  }

  /**
   * A customer decided by hand. Remember it so it helps every other customer.
   */
  async recordReport(targetId, userId, isBot) {
    await db.run(
      `INSERT INTO bot_reports (target_id, user_id, verdict) VALUES (?, ?, ?)
       ON CONFLICT(target_id, user_id) DO UPDATE SET verdict = excluded.verdict, created_at = CURRENT_TIMESTAMP`,
      [String(targetId), userId, isBot ? 'BOT' : 'HUMAN']
    ).catch(() => {});
  }
}

module.exports = new DetectionEngine();
