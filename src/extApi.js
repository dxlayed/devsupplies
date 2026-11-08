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

const lastSync = new Map(); // licenseId -> time of last sync (rate limit)
const MAX_REQUESTS_PER_SYNC = 200;

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
      const key = String(b.key || '').trim();
      const device = String(b.device || '').slice(0, 100);
      const robloxId = cleanId(b.roblox?.id);
      if (!key || !device) return res.status(400).json({ error: 'Missing key' });
      if (!robloxId) return res.status(400).json({ error: 'Log in to roblox.com in this browser first' });

      // 1) Key + device lock
      const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
      const v = await keyService.validateKey(key, device, ip);
      if (!v.valid) return res.status(401).json({ error: v.reason, expired: !!v.expired });
      const license = await db.get(`SELECT * FROM licenses WHERE id = ?`, [v.licenseId]);

      // 2) One Roblox account per key
      if (license.roblox_id && license.roblox_id !== robloxId) {
        return res.status(403).json({ error: 'This key is already used on a different Roblox account.' });
      }
      if (!license.roblox_id) await db.run(`UPDATE licenses SET roblox_id = ? WHERE id = ?`, [robloxId, license.id]);

      const user = await db.get(`SELECT * FROM users WHERE id = ?`, [license.user_id]);
      if (!user || user.banned) return res.status(403).json({ error: 'This account is banned.' });

      // 3) Rate limit: at most one sync per second per key
      const now = Date.now();
      if (now - (lastSync.get(license.id) || 0) < 1000) return res.status(429).json({ error: 'Too fast', nextMs: 2000 });
      lastSync.set(license.id, now);

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

      // 5) Results of last time's instructions: a failed accept goes back to waiting
      for (const d of Array.isArray(b.done) ? b.done.slice(0, 100) : []) {
        const id = cleanId(d.id);
        if (id && d.do === 'accept' && d.ok === false) {
          await db.run(`UPDATE friend_requests SET status = 'pending', auto = 0 WHERE user_id = ? AND target_id = ?`, [user.id, id]);
        }
      }

      // 6) Website Accept/Decline clicks waiting to be carried out
      const queued = await db.all(`SELECT id, target_id, action FROM ext_actions WHERE user_id = ? AND done = 0 ORDER BY id LIMIT 50`, [user.id]);
      if (queued.length) await db.run(`UPDATE ext_actions SET done = 1 WHERE id IN (${queued.map(() => '?').join(',')})`, queued.map(q => q.id));
      const actions = queued.map(q => ({ id: q.target_id, do: q.action }));

      await db.run(`UPDATE roblox_accounts SET last_check_at = CURRENT_TIMESTAMP, last_error = NULL WHERE id = ?`, [account.id]);
      const wait = () => 5000 + Math.floor(Math.random() * 5000);

      // Paused from the website? Only carry out clicks, don't filter.
      if (!account.is_active) return res.json({ ok: true, paused: true, actions, nextMs: wait() });

      // 7) Run every check here on the server
      const badges = b.badges && typeof b.badges === 'object' ? b.badges : {};
      const list = (Array.isArray(b.requests) ? b.requests : []).slice(0, MAX_REQUESTS_PER_SYNC).map(r => {
        const id = cleanId(r?.id ?? r?.friendRequest?.senderId);
        if (!id) return null;
        const item = {
          id: Number(id), name: r.name, displayName: r.displayName, description: r.description,
          created: r.created, isBanned: r.isBanned, hasVerifiedBadge: r.hasVerifiedBadge,
          friendRequest: r.friendRequest, mutualFriendsList: r.mutualFriendsList
        };
        const bc = Number(badges[id]);
        if (Number.isFinite(bc) && bc >= 0) item.badgeCount = Math.min(bc, 25);
        return item;
      }).filter(Boolean);
      if (b.complete) list.complete = true;

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

      const behind = robloxCloudService.backlog && robloxCloudService.backlog.get(user.id) > 0;
      if (account.scan_requested) await db.run(`UPDATE roblox_accounts SET scan_requested = 0 WHERE id = ?`, [account.id]);
      res.json({ ok: true, actions: actions.concat(result.actions || []), checking: behind ? robloxCloudService.backlog.get(user.id) : 0, nextMs: behind ? 1500 : wait() });
    } catch (err) {
      console.error('[ext] sync failed:', err.message);
      res.status(500).json({ error: 'Server error, retrying soon', nextMs: 10000 });
    }
  });

  // Quick key check for the extension's popup
  app.post('/api/v1/ext/check', async (req, res) => {
    try {
      const key = String(req.body?.key || '').trim();
      const device = String(req.body?.device || '').slice(0, 100);
      const v = await keyService.validateKey(key, device || null, req.headers['x-forwarded-for'] || req.socket.remoteAddress);
      if (!v.valid) return res.status(401).json({ error: v.reason });
      res.json({ ok: true, plan: v.tier === 'yearly' ? 'Lifetime' : v.tier, daysLeft: v.tier === 'yearly' ? null : v.daysRemaining });
    } catch (err) {
      res.status(500).json({ error: 'Server error' });
    }
  });
}

module.exports = { mount };
