/**
 * Friend remover: remove all your Roblox friends except the ones you keep (whitelist).
 * The browser extension only sends the friend list and clicks "unfriend" when told to.
 * Everything else (who to remove) is decided here.
 */
const db = require('./database');
const profiles = require('./services/robloxProfiles');

db.run(`CREATE TABLE IF NOT EXISTS ext_friends (
  user_id INTEGER NOT NULL, target_id TEXT NOT NULL, name TEXT, display_name TEXT, avatar_url TEXT,
  PRIMARY KEY (user_id, target_id))`).catch(() => {});
db.run(`CREATE TABLE IF NOT EXISTS friend_whitelist (
  user_id INTEGER NOT NULL, target_id TEXT NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, target_id))`).catch(() => {});
db.run(`ALTER TABLE roblox_accounts ADD COLUMN friends_wanted_at DATETIME`).catch(() => {});
db.run(`ALTER TABLE roblox_accounts ADD COLUMN friends_synced_at DATETIME`).catch(() => {});

const cleanId = v => { const s = String(v ?? '').replace(/\D/g, ''); return s && s.length <= 20 ? s : null; };

/** Extension sent the full friend list. Replace what we have. */
async function saveFriends(userId, ids) {
  const list = [...new Set((ids || []).map(cleanId).filter(Boolean))].slice(0, 2000);
  const names = await profiles.getNames(list).catch(() => new Map());
  const pics = await profiles.getHeadshots(list).catch(() => new Map());
  await db.run(`DELETE FROM ext_friends WHERE user_id = ?`, [userId]);
  for (const id of list) {
    const n = names.get(id) || {};
    await db.run(`INSERT OR REPLACE INTO ext_friends (user_id, target_id, name, display_name, avatar_url) VALUES (?, ?, ?, ?, ?)`,
      [userId, id, n.name || `User ${id}`, n.displayName || n.name || `User ${id}`, pics.get(id) || null]);
  }
  await db.run(`UPDATE roblox_accounts SET friends_synced_at = CURRENT_TIMESTAMP WHERE user_id = ?`, [userId]);
  return list.length;
}

/** Should the extension send the friend list this time? */
async function wantsFriends(userId) {
  const a = await db.get(`SELECT friends_wanted_at, friends_synced_at FROM roblox_accounts WHERE user_id = ?`, [userId]);
  return !!(a && a.friends_wanted_at && (!a.friends_synced_at || a.friends_wanted_at > a.friends_synced_at));
}

async function removed(userId, targetId) {
  await db.run(`DELETE FROM ext_friends WHERE user_id = ? AND target_id = ?`, [userId, String(targetId)]);
}

function mount(app, authMiddleware) {
  // The list, with who is kept
  app.get('/api/v1/roblox/friends', authMiddleware, async (req, res) => {
    try {
      const acc = await db.get(`SELECT mode, last_check_at, friends_wanted_at, friends_synced_at FROM roblox_accounts WHERE user_id = ?`, [req.user.id]);
      if (!acc) return res.json({ connected: false });
      const rows = await db.all(
        `SELECT f.target_id, f.name, f.display_name, f.avatar_url, (w.target_id IS NOT NULL) AS kept
         FROM ext_friends f LEFT JOIN friend_whitelist w ON w.user_id = f.user_id AND w.target_id = f.target_id
         WHERE f.user_id = ? ORDER BY kept DESC, LOWER(f.display_name)`, [req.user.id]);
      const left = await db.get(`SELECT COUNT(*) AS n FROM ext_actions WHERE user_id = ? AND action = 'unfriend' AND done = 0`, [req.user.id]);
      res.json({
        connected: true,
        extensionOnline: !!acc.last_check_at && Date.now() - new Date(String(acc.last_check_at).replace(' ', 'T') + 'Z').getTime() < 45000,
        loading: !!acc.friends_wanted_at && (!acc.friends_synced_at || acc.friends_wanted_at > acc.friends_synced_at),
        syncedAt: acc.friends_synced_at,
        removing: left ? left.n : 0,
        friends: rows.map(r => ({ id: r.target_id, name: r.name, displayName: r.display_name, avatar: r.avatar_url, kept: !!r.kept }))
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Ask the extension for a fresh friend list
  app.post('/api/v1/roblox/friends/refresh', authMiddleware, async (req, res) => {
    await db.run(`UPDATE roblox_accounts SET friends_wanted_at = CURRENT_TIMESTAMP WHERE user_id = ?`, [req.user.id]);
    res.json({ ok: true });
  });

  // Keep / stop keeping one friend
  app.post('/api/v1/roblox/friends/:id/keep', authMiddleware, async (req, res) => {
    const id = cleanId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Bad id' });
    if (req.body && req.body.keep === false) await db.run(`DELETE FROM friend_whitelist WHERE user_id = ? AND target_id = ?`, [req.user.id, id]);
    else await db.run(`INSERT OR IGNORE INTO friend_whitelist (user_id, target_id) VALUES (?, ?)`, [req.user.id, id]);
    // Kept now? make sure it's not waiting to be removed
    if (!(req.body && req.body.keep === false)) await db.run(`DELETE FROM ext_actions WHERE user_id = ? AND target_id = ? AND action = 'unfriend' AND done = 0`, [req.user.id, id]);
    res.json({ ok: true });
  });

  // Remove everyone not kept
  app.post('/api/v1/roblox/friends/remove-all', authMiddleware, async (req, res) => {
    try {
      const rows = await db.all(
        `SELECT f.target_id FROM ext_friends f WHERE f.user_id = ?
           AND f.target_id NOT IN (SELECT target_id FROM friend_whitelist WHERE user_id = ?)
           AND f.target_id NOT IN (SELECT target_id FROM ext_actions WHERE user_id = ? AND action = 'unfriend' AND done = 0)`,
        [req.user.id, req.user.id, req.user.id]);
      for (const r of rows) await db.run(`INSERT INTO ext_actions (user_id, target_id, action) VALUES (?, ?, 'unfriend')`, [req.user.id, r.target_id]);
      res.json({ ok: true, queued: rows.length });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Stop removing
  app.post('/api/v1/roblox/friends/stop', authMiddleware, async (req, res) => {
    const r = await db.run(`DELETE FROM ext_actions WHERE user_id = ? AND action = 'unfriend' AND done = 0`, [req.user.id]);
    res.json({ ok: true, stopped: r && r.changes });
  });
}

module.exports = { mount, saveFriends, wantsFriends, removed };
