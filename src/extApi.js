/**
 * API for the Waurks browser extension.
 *
 * The extension has NO filtering logic. It only:
 *   1. reads the friend request list from roblox.com (using the browser's own Roblox login),
 *   2. sends it here with the customer's key,
 *   3. carries out the instructions we send back (accept / decline).
 * Every decision, rule, list and the key check live on this server.
 *
 * Anti-sharing:
 *   - a key is locked to one device (existing HWID lock) and one Roblox account
 *   - each key can sync at most once per second
 */
const db = require('./database');
const { keyService } = require('./services/keyService');
const robloxCloudService = require('./services/robloxCloudService');
const friendRemover = require('./friendRemover');

const crypto = require('crypto');
const hashToken = t => crypto.createHash('sha256').update(String(t)).digest('hex');

/**
 * Find the customer behind a request: a sign-in token from the Connect flow (normal),
 * or a license key (older extension versions). Returns { user, license } or { error, status }.
 */
async function identify(b, ip) {
  const device = String(b.device || '').slice(0, 100);
  if (b.token) {
    const t = await db.get(`SELECT * FROM ext_tokens WHERE token_hash = ?`, [hashToken(b.token)]);
    if (!t) return { status: 401, error: 'This browser is not connected anymore. Press Connect in the extension.', reconnect: true };
    await db.run(`UPDATE ext_tokens SET last_used_at = CURRENT_TIMESTAMP, device = COALESCE(?, device) WHERE token_hash = ?`, [device || null, t.token_hash]);
    const user = await db.get(`SELECT * FROM users WHERE id = ?`, [t.user_id]);
    const license = await db.get(
      `SELECT * FROM licenses WHERE user_id = ? AND status = 'active' AND expires_at > datetime('now') ORDER BY expires_at DESC LIMIT 1`,
      [t.user_id]
    );
    if (!license) return { status: 401, error: 'You need an active key. Get one on the site.', expired: true };
    // Connected to site: ensure license is not blocked by old device lock
    if (license.hwid_binding && device && license.hwid_binding !== device) {
      await db.run(`UPDATE licenses SET hwid_binding = ? WHERE id = ?`, [device, license.id]);
    }
    return { user, license, tokenHash: t.token_hash };
  }
  const key = String(b.key || '').trim();
  if (!key) return { status: 400, error: 'Press Connect in the extension' };
  const licenseRow = await db.get(
    `SELECT * FROM licenses WHERE license_key = ? AND status = 'active' AND expires_at > datetime('now')`,
    [key]
  );
  if (licenseRow && device && licenseRow.hwid_binding && licenseRow.hwid_binding !== device) {
    await db.run(`UPDATE licenses SET hwid_binding = ? WHERE id = ?`, [device, licenseRow.id]);
    licenseRow.hwid_binding = device;
  }
  const v = await keyService.validateKey(key, device, ip);
  if (!v.valid) return { status: 401, error: v.reason, expired: !!v.expired };
  const license = await db.get(`SELECT * FROM licenses WHERE id = ?`, [v.licenseId]);
  const user = await db.get(`SELECT * FROM users WHERE id = ?`, [license.user_id]);
  return { user, license };
}

const lastSync = new Map(); // licenseId -> time of last sync (rate limit)
const MAX_REQUESTS_PER_SYNC = 1200; // supports 500+ backlogs in one go

function cleanId(v) {
  const s = String(v ?? '').replace(/\D/g, '');
  return s.length > 0 && s.length < 20 ? s : null;
}

function mount(app) {
  /**
   * Main call. Body:
   *   key, device               - license key + random device ID the extension made
   *   roblox: { id, name }      - the Roblox account logged in to the browser
   *   requests: [...]           - waiting friend requests as Roblox returned them
   *   complete: bool            - true if that's the whole list (not just the newest pages)
   *   badges: { userId: count } - badge counts the extension could see (optional)
   *   done: [{ id, do, ok }]    - results of the instructions we sent last time
   */
  app.post('/api/v1/ext/sync', async (req, res) => {
    try {
      const b = req.body || {};
      const robloxId = cleanId(b.roblox?.id);
      if (!robloxId) return res.status(400).json({ error: 'Log in to roblox.com in this browser first' });

      // 1) Who is this? (sign-in token from Connect, or an old-style key)
      const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
      const who = await identify(b, ip);
      if (who.error) return res.status(who.status).json({ error: who.error, expired: !!who.expired, reconnect: !!who.reconnect });
      const license = who.license;

      // 2) One Roblox account per key
      if (license.roblox_id && license.roblox_id !== robloxId) {
        return res.status(403).json({ error: 'This key is already used on a different Roblox account.' });
      }
      if (!license.roblox_id) await db.run(`UPDATE licenses SET roblox_id = ? WHERE id = ?`, [robloxId, license.id]);

      const user = await db.get(`SELECT * FROM users WHERE id = ?`, [license.user_id]);
      if (!user || user.banned) return res.status(403).json({ error: 'This account is banned.' });

      // 3) Rate limit: at most one sync per 500ms per token/key
      const now = Date.now();
      const rateLimitKey = who.tokenHash || String(license.id);
      if (now - (lastSync.get(rateLimitKey) || 0) < 500) return res.status(429).json({ error: 'Too fast', nextMs: 1000 });
      lastSync.set(rateLimitKey, now);

      // 4) Make sure this customer has an "extension" account row (the website pages read from it)
      const robloxName = String(b.roblox?.name || '').slice(0, 50) || `User ${robloxId}`;
      let account = await db.get(`SELECT * FROM roblox_accounts WHERE user_id = ?`, [user.id]);
      if (!account) {
        await db.run(
          `INSERT INTO roblox_accounts (user_id, license_id, roblox_id, roblox_username, avatar_url, encrypted_cookie, cookie_iv, is_active, auto_accept_players, mode)
           VALUES (?, ?, ?, ?, NULL, '', '', 1, 0, 'extension')`,
          [user.id, license.id, robloxId, robloxName]
        );
      } else if (account.mode !== 'extension' || account.roblox_id !== robloxId || account.license_id !== license.id) {
        await db.run(`UPDATE roblox_accounts SET mode = 'extension', roblox_id = ?, roblox_username = ?, license_id = ? WHERE id = ?`,
          [robloxId, robloxName, license.id, account.id]);
      }
      account = await db.get(`SELECT * FROM roblox_accounts WHERE user_id = ?`, [user.id]);
      if (!account.avatar_url) {
        const pics = await require('./services/robloxProfiles').getHeadshots([robloxId]).catch(() => new Map());
        if (pics.get(robloxId)) await db.run(`UPDATE roblox_accounts SET avatar_url = ? WHERE id = ?`, [pics.get(robloxId), account.id]);
      }

      // 5) Results of last time's instructions: verify real success before marking accepted
      for (const d of Array.isArray(b.done) ? b.done.slice(0, 100) : []) {
        const id = cleanId(d.id);
        if (!id) continue;
        if (d.do === 'accept') {
          if (d.ok === true) {
            // Confirmed accepted on Roblox by the browser extension: clear any retry error!
            await db.run(
              `UPDATE friend_requests SET status = 'accepted', auto = 0, retry_error = NULL, retry_after = NULL, priority = 0, updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND target_id = ?`,
              [user.id, id]
            );
            await db.run(`UPDATE ext_actions SET done = 1 WHERE user_id = ? AND target_id = ? AND action = 'accept'`, [user.id, id]);
          } else {
            // Failed on Roblox (rate limit 429, accepted too fast, etc.): DO NOT REMOVE!
            // Retain pending status, mark red notice, bump priority, and set 1-minute retry cooldown
            const errMsg = d.error || (d.rateLimited ? 'Roblox rate limited (accepting too fast) · Retrying automatically in ~1m' : 'Could not accept on Roblox · Retrying soon');
            await db.run(
              `UPDATE friend_requests 
               SET status = 'pending', auto = 0, retry_error = ?, retry_after = datetime('now', '+60 seconds'), priority = COALESCE(priority, 0) + 10, updated_at = CURRENT_TIMESTAMP 
               WHERE user_id = ? AND target_id = ?`,
              [errMsg, user.id, id]
            );
            await db.run(
              `UPDATE ext_actions 
               SET done = 0, priority = COALESCE(priority, 0) + 10, retry_after = datetime('now', '+60 seconds'), last_error = ? 
               WHERE user_id = ? AND target_id = ? AND action = 'accept'`,
              [errMsg, user.id, id]
            );
          }
        } else if (d.do === 'decline') {
          if (d.ok === true) {
            await db.run(`UPDATE friend_requests SET status = 'declined', auto = 0, retry_error = NULL, retry_after = NULL, priority = 0, updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND target_id = ?`, [user.id, id]);
            await db.run(`UPDATE ext_actions SET done = 1 WHERE user_id = ? AND target_id = ? AND action = 'decline'`, [user.id, id]);
          } else {
            await db.run(`UPDATE ext_actions SET done = 0 WHERE user_id = ? AND target_id = ? AND action = 'decline'`, [user.id, id]);
          }
        }
      }

      // 6) Website Accept/Decline clicks: prioritize high-priority retry items first!
      const queued = await db.all(
        `SELECT id, target_id, action FROM ext_actions 
         WHERE user_id = ? AND done = 0 AND action IN ('accept', 'decline')
           AND (retry_after IS NULL OR retry_after <= CURRENT_TIMESTAMP)
         ORDER BY priority DESC, id ASC 
         LIMIT 30`,
        [user.id]
      );
      if (queued.length) await db.run(`UPDATE ext_actions SET done = 1 WHERE id IN (${queued.map(() => '?').join(',')})`, queued.map(q => q.id));
      const actions = queued.map(q => ({ id: String(q.target_id), do: q.action }));

      await db.run(`UPDATE roblox_accounts SET last_check_at = CURRENT_TIMESTAMP, last_error = NULL WHERE id = ?`, [account.id]);
      const wait = () => 1000;

      // Paused from the website? Only carry out manual clicks, don't filter.
      if (!account.is_active) return res.json({ ok: true, paused: true, actions, nextMs: wait() });

      // 7) Run every check here on the server
      const badges = b.badges && typeof b.badges === 'object' ? b.badges : {};
      const list = (Array.isArray(b.requests) ? b.requests : []).slice(0, MAX_REQUESTS_PER_SYNC).map(r => {
        const id = cleanId(r?.id ?? r?.friendRequest?.senderId);
        if (!id) return null;
        const item = {
          id: Number(id), name: r.name || '', displayName: r.displayName || r.name || '', description: r.description || '',
          created: r.created, isBanned: r.isBanned, hasVerifiedBadge: r.hasVerifiedBadge,
          friendRequest: r.friendRequest, mutualFriendsList: r.mutualFriendsList
        };
        const bc = Number(badges[id]);
        if (Number.isFinite(bc) && bc >= 0) item.badgeCount = Math.min(bc, 25);
        else if (bc === -1) item.badgesHidden = true;
        return item;
      }).filter(Boolean);
      if (b.complete) list.complete = true;

      // FAST STAGE: Save all incoming requests into SQLite immediately in a transaction
      if (list.length > 0) {
        await new Promise(resolve => {
          db.db.serialize(() => {
            db.db.run('BEGIN TRANSACTION');
            const stmt = db.db.prepare(
              `INSERT INTO friend_requests (user_id, target_id, name, display_name, status, auto, sent_at, updated_at)
               VALUES (?, ?, ?, ?, 'pending', 0, ?, CURRENT_TIMESTAMP)
               ON CONFLICT(user_id, target_id) DO UPDATE SET
                 name = CASE WHEN excluded.name != '' THEN excluded.name ELSE friend_requests.name END,
                 display_name = CASE WHEN excluded.display_name != '' THEN excluded.display_name ELSE friend_requests.display_name END,
                 sent_at = COALESCE(excluded.sent_at, friend_requests.sent_at)
               WHERE friend_requests.status = 'pending'`
            );
            for (const item of list) {
              const sid = String(item.id);
              const fr = item.friendRequest || {};
              const displayName = item.displayName || item.name || `User ${sid}`;
              const name = item.name || displayName;
              stmt.run([user.id, sid, name, displayName, fr.sentAt || null]);
            }
            stmt.finalize();
            db.db.run('COMMIT', () => resolve());
          });
        });
      }

      let result = { actions: [] };
      robloxCloudService.activeScans = robloxCloudService.activeScans || new Set();
      if (!robloxCloudService.activeScans.has(user.id)) {
        robloxCloudService.activeScans.add(user.id);
        try {
          result = await robloxCloudService.processRequests(user.id, account, license, list, null, { ext: true });
        } catch (e) {
          await db.run(`UPDATE roblox_accounts SET last_error = ? WHERE id = ?`, [e.message, account.id]);
        } finally {
          robloxCloudService.activeScans.delete(user.id);
        }
      }

      // Safety constraint: only return final accept/decline actions on IDs that were in this user's own request list
      const candidateActions = actions.concat(result.actions || []);
      const verifiedActions = [];
      const incomingIdSet = new Set(list.map(item => String(item.id)));

      for (const act of candidateActions) {
        if (!act || (act.do !== 'accept' && act.do !== 'decline')) continue;
        const targetId = cleanId(act.id);
        if (!targetId) continue;
        // Verify targetId was in this sync batch or exists in user's friend_requests table
        if (incomingIdSet.has(targetId)) {
          verifiedActions.push({ id: targetId, do: act.do });
        } else {
          const staged = await db.get(`SELECT target_id FROM friend_requests WHERE user_id = ? AND target_id = ?`, [user.id, targetId]);
          if (staged) verifiedActions.push({ id: targetId, do: act.do });
        }
      }

      const behind = (robloxCloudService.backlog && robloxCloudService.backlog.get(user.id) > 0) || (!b.complete && list.length >= 25);
      if (account.scan_requested) await db.run(`UPDATE roblox_accounts SET scan_requested = 0 WHERE id = ?`, [account.id]);
      res.json({ ok: true, actions: verifiedActions, checking: (robloxCloudService.backlog && robloxCloudService.backlog.get(user.id)) || 0, nextMs: behind ? 800 : 1000 });
    } catch (err) {
      console.error('[ext] sync failed:', err.message);
      res.status(500).json({ error: 'Server error, retrying soon', nextMs: 10000 });
    }
  });

  // ---- Friend remover: the extension sends the full friend list when the site asks ----
  app.post('/api/v1/ext/friends', async (req, res) => {
    try {
      const b = req.body || {};
      const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
      const who = await identify(b, ip);
      if (who.error) return res.status(who.status).json({ error: who.error });
      const robloxId = cleanId(b.roblox?.id);
      if (!robloxId || (who.license.roblox_id && who.license.roblox_id !== robloxId)) return res.status(403).json({ error: 'Wrong Roblox account' });
      const n = await friendRemover.saveFriends(who.license.user_id, Array.isArray(b.friends) ? b.friends : []);
      res.json({ ok: true, count: n });
    } catch (e) {
      res.status(500).json({ error: 'Server error' });
    }
  });

  // ---- Connect flow (no key needed) ----
  // 1) Extension asks for a one-time code and opens the site's /connect page with it
  app.post('/api/v1/ext/connect/start', async (req, res) => {
    try {
      const device = String(req.body?.device || '').slice(0, 100);
      if (!device) return res.status(400).json({ error: 'Missing device' });
      await db.run(`DELETE FROM ext_connect WHERE created_at < datetime('now', '-15 minutes')`);
      const code = crypto.randomBytes(9).toString('base64url');
      await db.run(`INSERT INTO ext_connect (code, device) VALUES (?, ?)`, [code, device]);
      res.json({ code, path: '/connect?code=' + encodeURIComponent(code) });
    } catch (err) {
      res.status(500).json({ error: 'Server error' });
    }
  });

  // 3) Extension waits here until the person approves on the site, then gets its sign-in token
  app.post('/api/v1/ext/connect/poll', async (req, res) => {
    try {
      const code = String(req.body?.code || '');
      const device = String(req.body?.device || '').slice(0, 100);
      const row = await db.get(`SELECT * FROM ext_connect WHERE code = ? AND created_at > datetime('now', '-15 minutes')`, [code]);
      if (!row) return res.status(404).json({ error: 'Connect link expired. Press Connect again.' });
      if (!row.user_id) return res.json({ pending: true });
      const token = crypto.randomBytes(32).toString('base64url');
      // One connected browser per account: connecting a new one signs the old one out
      await db.run(`DELETE FROM ext_tokens WHERE user_id = ?`, [row.user_id]);
      await db.run(`INSERT INTO ext_tokens (token_hash, user_id, device) VALUES (?, ?, ?)`, [hashToken(token), row.user_id, device]);
      await db.run(`DELETE FROM ext_connect WHERE code = ?`, [code]);
      const user = await db.get(`SELECT username FROM users WHERE id = ?`, [row.user_id]);
      res.json({ token, username: user?.username || '' });
    } catch (err) {
      res.status(500).json({ error: 'Server error' });
    }
  });

  // Quick key check for the extension's popup
  app.post('/api/v1/ext/check', async (req, res) => {
    try {
      const key = String(req.body?.key || '').trim();
      const device = String(req.body?.device || '').slice(0, 100);
      const lic = await db.get(`SELECT * FROM licenses WHERE license_key = ? AND status = 'active' AND expires_at > datetime('now')`, [key]);
      if (lic && device && lic.hwid_binding && lic.hwid_binding !== device) {
        await db.run(`UPDATE licenses SET hwid_binding = ? WHERE id = ?`, [device, lic.id]);
      }
      const v = await keyService.validateKey(key, device || null, req.headers['x-forwarded-for'] || req.socket.remoteAddress);
      if (!v.valid) return res.status(401).json({ error: v.reason });
      res.json({ ok: true, plan: v.tier === 'yearly' ? 'Lifetime' : v.tier, daysLeft: v.tier === 'yearly' ? null : v.daysRemaining });
    } catch (err) {
      res.status(500).json({ error: 'Server error' });
    }
  });
}

module.exports = { mount };
