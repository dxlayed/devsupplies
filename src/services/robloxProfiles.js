/**
 * Collects public info about a Roblox account from several Roblox APIs,
 * so the bot checker can look at much more than the name.
 *
 * Everything here uses public endpoints (no cookie needed). Results are cached
 * for 12 hours so we don't hammer Roblox when the same account shows up again.
 * If an API fails, that field is left as null ("unknown") and the checker
 * simply doesn't use it, instead of guessing.
 */
const db = require('../database');

const CACHE_HOURS = 12;

db.run(`CREATE TABLE IF NOT EXISTS profile_cache (
  roblox_id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  fetched_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`).catch(() => {});

db.run(`CREATE TABLE IF NOT EXISTS asset_prices (
  asset_id TEXT PRIMARY KEY, name TEXT, price INTEGER, is_limited INTEGER, creator_id TEXT,
  fetched_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`).catch(() => {});

const sleep = ms => new Promise(r => setTimeout(r, ms));

// GET JSON with a timeout and a polite retry when Roblox says "slow down" (429)
async function getJson(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 waurks' }, signal: AbortSignal.timeout(10000) });
      if (r.status === 429) { await sleep(1500 * (i + 1)); continue; }
      if (!r.ok) return null;
      return await r.json();
    } catch (e) {
      if (i === tries - 1) return null;
      await sleep(500);
    }
  }
  return null;
}

/**
 * Full profile for one account. `base` can carry fields we already have
 * (for example from the friend request list) so we don't fetch them twice.
 */
async function getProfile(id, base = {}, authGet = null) {
  id = String(id);
  const cached = await db.get(
    `SELECT data FROM profile_cache WHERE roblox_id = ? AND fetched_at > datetime('now', ?)`,
    [id, `-${CACHE_HOURS} hours`]
  ).catch(() => null);
  if (cached) {
    const c = JSON.parse(cached.data);
    if (c.name && c.created) return { ...c, ...pickDefined(base) };
  }

  const [user, friends, followers, followings, badges, groups, avatar, names] = await Promise.all([
    base.created && base.description !== undefined && base.name ? null
      : getJson(`https://users.roblox.com/v1/users/${id}`).then(u => u || (authGet ? authGet(`https://users.roblox.com/v1/users/${id}`).catch(() => null) : null)),
    getJson(`https://friends.roblox.com/v1/users/${id}/friends/count`),
    getJson(`https://friends.roblox.com/v1/users/${id}/followers/count`),
    getJson(`https://friends.roblox.com/v1/users/${id}/followings/count`),
    // Roblox now needs a login to read badges, so this uses the customer's own session when we have it
    authGet ? authGet(`https://badges.roblox.com/v1/users/${id}/badges?limit=25&sortOrder=Desc`).catch(() => null) : null,
    getJson(`https://groups.roblox.com/v2/users/${id}/groups/roles`),
    getJson(`https://avatar.roblox.com/v1/users/${id}/avatar`),
    getJson(`https://users.roblox.com/v1/users/${id}/username-history?limit=10&sortOrder=Desc`, 1) // heavily rate-limited, one try only
  ]);

  const profile = {
    id: Number(id),
    name: user?.name ?? base.name ?? '',
    displayName: user?.displayName ?? base.displayName ?? '',
    description: user?.description ?? base.description ?? '',
    created: user?.created ?? base.created ?? null,
    isBanned: user?.isBanned ?? base.isBanned ?? false,
    hasVerifiedBadge: user?.hasVerifiedBadge ?? base.hasVerifiedBadge ?? false,
    friendsCount: numOrNull(friends?.count),
    followersCount: numOrNull(followers?.count),
    followingsCount: numOrNull(followings?.count),
    // Up to 25 badges is enough to tell "plays games" from "never played"
    badgeCount: Array.isArray(badges?.data) ? badges.data.length : null,
    groupsCount: Array.isArray(groups?.data) ? groups.data.length : null,
    // How many items the avatar wears. 0-2 usually means the default avatar nobody customized.
    avatarAssetCount: Array.isArray(avatar?.assets) ? avatar.assets.length : null,
    nameChanges: Array.isArray(names?.data) ? names.data.length : null,
    paidItem: await findPaidItem(id, avatar?.assets)
  };

  if (profile.name && profile.created) db.run(
    `INSERT INTO profile_cache (roblox_id, data, fetched_at) VALUES (?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(roblox_id) DO UPDATE SET data = excluded.data, fetched_at = excluded.fetched_at`,
    [id, JSON.stringify(profile)]
  ).catch(() => {});

  return { ...profile, ...pickDefined(base) };
}

/**
 * Fetch many profiles, a few at a time, so Roblox doesn't rate-limit us.
 */
async function getProfiles(list, authGet = null, concurrency = 3) {
  const out = new Array(list.length);
  let next = 0;
  async function worker() {
    while (next < list.length) {
      const i = next++;
      out[i] = await getProfile(list[i].id, list[i], authGet);
      await sleep(150);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, list.length) }, worker));
  return out;
}

/**
 * Is this account wearing something that cost Robux? Returns the first paid item or null.
 * Paid = price above 0, or a classic Limited. Free items (including free UGC limiteds) don't count,
 * and neither do items the account made itself (creators own their own items for free).
 * Prices are cached for 7 days since they rarely change.
 */
async function findPaidItem(userId, assets) {
  if (!Array.isArray(assets)) return null;
  for (const a of assets.slice(0, 20)) {
    const aid = String(a.id);
    let row = await db.get(`SELECT * FROM asset_prices WHERE asset_id = ? AND fetched_at > datetime('now', '-7 days')`, [aid]).catch(() => null);
    if (!row) {
      const d = await getJson(`https://economy.roblox.com/v2/assets/${aid}/details`, 2);
      if (!d) continue;
      row = { asset_id: aid, name: d.Name || a.name, price: Number(d.PriceInRobux) || 0, is_limited: d.IsLimited ? 1 : 0, creator_id: String(d.Creator?.Id ?? '') };
      db.run(`INSERT INTO asset_prices (asset_id, name, price, is_limited, creator_id, fetched_at) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(asset_id) DO UPDATE SET name = excluded.name, price = excluded.price, is_limited = excluded.is_limited, creator_id = excluded.creator_id, fetched_at = excluded.fetched_at`,
        [row.asset_id, row.name, row.price, row.is_limited, row.creator_id]).catch(() => {});
    }
    if (row.creator_id && row.creator_id === String(userId)) continue;
    if (row.price > 0 || row.is_limited) return { id: aid, name: row.name, price: row.price, limited: !!row.is_limited };
  }
  return null;
}

/**
 * Names for many accounts in one request (Roblox's batch endpoint is much less rate-limited).
 * Returns a Map of id -> { name, displayName, hasVerifiedBadge }.
 */
async function getNames(ids, authPost = null) {
  const out = new Map();
  const list = [...new Set(ids.map(String))].filter(Boolean);
  for (let i = 0; i < list.length; i += 100) {
    const body = { userIds: list.slice(i, i + 100).map(Number), excludeBannedUsers: false };
    let data = null;
    try {
      const r = await fetch('https://users.roblox.com/v1/users', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0 waurks' },
        body: JSON.stringify(body), signal: AbortSignal.timeout(10000)
      });
      if (r.ok) data = await r.json();
    } catch (e) { /* fall through */ }
    if (!data && authPost) data = await authPost('https://users.roblox.com/v1/users', body).catch(() => null);
    for (const u of data?.data || []) out.set(String(u.id), { name: u.name, displayName: u.displayName, hasVerifiedBadge: u.hasVerifiedBadge });
  }
  return out;
}

function numOrNull(v) { return typeof v === 'number' ? v : null; }
function pickDefined(o) {
  const r = {};
  for (const k of Object.keys(o || {})) if (o[k] !== undefined && o[k] !== null) r[k] = o[k];
  return r;
}

module.exports = { getProfile, getProfiles, getNames };
