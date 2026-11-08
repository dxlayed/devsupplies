/**
 * Online check (Standard filter, Step 2).
 * Bots are usually offline, so a request that passes the normal bot check
 * also has to come from someone who is online right now.
 */

// Is this presence record "online"? (0 = offline; 1 = website, 2 = in game, 3 = in Studio)
function normalizePresenceStatus(presence) {
  if (presence == null) return false;

  const userPresenceType = Number(presence.userPresenceType);
  if (Number.isInteger(userPresenceType) && userPresenceType >= 0 && userPresenceType <= 3) {
    return userPresenceType !== 0;
  }

  const presenceType =
    typeof presence.presenceType === 'string'
      ? presence.presenceType
      : typeof presence.status === 'string'
        ? presence.status
        : '';

  if (presenceType) {
    const status = presenceType.toLowerCase();
    return status !== 'offline' && status !== 'none' && status !== 'unknown';
  }

  return Boolean(presence.isOnline || presence.online);
}

// Find one user's record in a presence API reply (handles the different reply shapes)
function getPresenceRecord(payload, userId) {
  const userPresences = Array.isArray(payload?.userPresences)
    ? payload.userPresences
    : Array.isArray(payload)
      ? payload
      : Array.isArray(payload?.data)
        ? payload.data
        : [];

  const match = userPresences.find(presence => String(presence.userId) === String(userId));

  return match ?? (String(payload?.userId) === String(userId) ? payload : null);
}

/**
 * Presence for many users in one call. `robloxPost(url, body)` must send an
 * authenticated POST (Roblox needs a login + CSRF token for this endpoint).
 * Returns a Map of userId -> presence record, or null if Roblox didn't answer
 * (then Step 2 is skipped instead of filtering everyone).
 */
async function getUserPresences(userIds, robloxPost) {
  const ids = [...new Set(userIds.map(String))].filter(Boolean);
  if (ids.length === 0) return new Map();
  const res = await robloxPost('https://presence.roblox.com/v1/presence/users', { userIds: ids.map(Number) });
  if (!res || !res.ok) return null;
  const payload = await res.json().catch(() => null);
  if (!payload) return null;
  const out = new Map();
  for (const id of ids) {
    const rec = getPresenceRecord(payload, id);
    if (rec) out.set(id, rec);
  }
  return out;
}

// Same rule as before: accept only if they passed the check AND are online
function shouldAcceptFriendRequest(presence, passedCheck) {
  if (!presence || !passedCheck) return false;
  return normalizePresenceStatus(presence);
}

module.exports = { normalizePresenceStatus, getPresenceRecord, getUserPresences, shouldAcceptFriendRequest };
