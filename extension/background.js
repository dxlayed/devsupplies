/*
 * Waurks browser extension - background service worker.
 *
 * 1. Reads pending friend requests from roblox.com using the active browser session.
 * 2. Forwards request IDs & metadata to the Waurks detection engine (https://devsupplies.cc).
 * 3. Carries out server instructions (accept / decline).
 */

const API_BASE = 'https://devsupplies.cc';
const MAX_PAGES = 100;          // up to 5,000 requests per sync (handles massive floods of thousands)
const BADGE_LOOKUPS_PER_SYNC = 100;  // badge checks per round
const BADGE_PARALLEL = 10;           // how many at the same time
const BADGE_CACHE_MAX = 20000;       // remembered across browser restarts

let running = false;
let csrfToken = null;
let lastDone = [];
const badgeCache = new Map(); // userId -> badge count, or -1 if Roblox hides them (data only, the server decides)
let badgeCacheLoaded = false;
let badgePauseUntil = 0;       // set when Roblox says "slow down"

async function loadBadgeCache() {
  if (badgeCacheLoaded) return;
  badgeCacheLoaded = true;
  const { badgeCacheData } = await chrome.storage.local.get('badgeCacheData');
  if (badgeCacheData && typeof badgeCacheData === 'object') {
    for (const [k, v] of Object.entries(badgeCacheData)) badgeCache.set(k, v);
  }
}
async function saveBadgeCache() {
  // Keep the newest entries only
  const entries = [...badgeCache.entries()].slice(-BADGE_CACHE_MAX);
  await chrome.storage.local.set({ badgeCacheData: Object.fromEntries(entries) });
}

// ---------- storage helpers ----------
async function getSettings() {
  const s = await chrome.storage.local.get(['key', 'token', 'device']);
  if (!s.device) {
    s.device = 'ext-' + crypto.randomUUID();
    await chrome.storage.local.set({ device: s.device });
  }
  return { key: s.key || '', token: s.token || '', device: s.device };
}
async function setStatus(patch) {
  const { status = {} } = await chrome.storage.local.get('status');
  await chrome.storage.local.set({ status: { ...status, ...patch, updatedAt: Date.now() } });
}

// ---------- Roblox calls (your own session) ----------
async function roblox(url, method = 'GET', body = null) {
  const opts = { method, credentials: 'include', headers: { 'Content-Type': 'application/json' } };
  if (csrfToken) opts.headers['x-csrf-token'] = csrfToken;
  if (body) opts.body = JSON.stringify(body);
  let res = await fetch(url, opts);
  // Roblox hands out a fresh CSRF token on the first refused POST
  if (res.status === 403 && res.headers.get('x-csrf-token')) {
    csrfToken = res.headers.get('x-csrf-token');
    opts.headers['x-csrf-token'] = csrfToken;
    res = await fetch(url, opts);
  }
  return res;
}

async function getMe() {
  const r = await roblox('https://users.roblox.com/v1/users/authenticated');
  if (!r.ok) return null;
  const d = await r.json();
  return { id: d.id, name: d.name };
}

async function getRequests() {
  const all = [];
  let cursor = '';
  let complete = false;
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = 'https://friends.roblox.com/v1/my/friends/requests?limit=25&sortOrder=Desc' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : '');
    const r = await roblox(url);
    if (!r.ok) break;
    const d = await r.json();
    const batch = Array.isArray(d.data) ? d.data : [];
    all.push(...batch);
    cursor = d.nextPageCursor;
    if (!cursor || batch.length === 0) { complete = true; break; }
    await new Promise(res => setTimeout(res, 15));
  }
  return { list: all, complete };
}

// Badge counts need a login, so the extension looks them up: up to 100 per round, 10 at a time.
// Newest requests first (the list is already newest-first). -1 = Roblox hides this person's badges.
let collectingBadges = false;
function collectBadgesInBackground(list) {
  if (collectingBadges || Date.now() < badgePauseUntil) return;
  collectingBadges = true;
  (async () => {
    try {
      const toFetch = [];
      for (const r of list) {
        const id = String(r.id ?? r.friendRequest?.senderId ?? '');
        if (id && !badgeCache.has(id)) {
          toFetch.push(id);
          if (toFetch.length >= 25) break;
        }
      }
      if (toFetch.length === 0) return;
      let changed = false;
      for (let i = 0; i < toFetch.length; i += BADGE_PARALLEL) {
        if (Date.now() < badgePauseUntil) break;
        const slice = toFetch.slice(i, i + BADGE_PARALLEL);
        await Promise.all(slice.map(async id => {
          try {
            const res = await roblox(`https://badges.roblox.com/v1/users/${id}/badges?limit=25&sortOrder=Desc`);
            if (res.ok) {
              const d = await res.json();
              const n = Array.isArray(d.data) ? d.data.length : null;
              if (n !== null) { badgeCache.set(id, n); changed = true; }
            } else if (res.status === 429) {
              badgePauseUntil = Date.now() + 15000;
            } else if (res.status === 403 || res.status === 400) {
              badgeCache.set(id, -1); changed = true;
            }
          } catch (_) {}
        }));
      }
      if (changed) saveBadgeCache().catch(() => {});
    } finally {
      collectingBadges = false;
    }
  })().catch(() => { collectingBadges = false; });
}

async function collectBadges(list) {
  await loadBadgeCache();
  const out = {};
  for (const r of list.slice(0, 100)) {
    const id = String(r.id ?? r.friendRequest?.senderId ?? '');
    if (id && badgeCache.has(id)) out[id] = badgeCache.get(id);
  }
  collectBadgesInBackground(list);
  return out;
}

let actionPauseUntil = 0;

async function doAction(a) {
  const id = String(a.id).replace(/\D/g, '');
  if (!id || !['accept', 'decline'].includes(a.do)) return { id, do: a.do, ok: false };
  try {
    const url = `https://friends.roblox.com/v1/users/${id}/${a.do}-friend-request`;
    const r = await roblox(url, 'POST', {});

    // Direct success from Roblox
    if (r.ok) {
      return { id, do: a.do, ok: true };
    }

    // Rate limited by Roblox (accepting too fast): 30s cooldown
    if (r.status === 429) {
      actionPauseUntil = Date.now() + 30000; // Pause actions for 30 seconds
      return { id, do: a.do, ok: false, rateLimited: true, status: 429, retryUntil: actionPauseUntil, error: 'Roblox rate limited (accepting too fast) · Retrying in 30s...' };
    }

    // 400 Bad Request can happen if already friends or request was already handled
    if (r.status === 400) {
      try {
        const d = await r.json();
        const msg = (d?.errors?.[0]?.message || '').toLowerCase();
        if (msg.includes('already') || msg.includes('friend') || msg.includes('not exist') || msg.includes('invalid')) {
          return { id, do: a.do, ok: true };
        }
      } catch (_) {}
    }

    return { id, do: a.do, ok: false, status: r.status, error: `Roblox error ${r.status} · Retrying` };
  } catch (e) {
    return { id, do: a.do, ok: false, error: e.message || 'Network error' };
  }
}

// ---------- one sync with the server ----------
async function syncOnce() {
  const { key, token, device } = await getSettings();
  if (!token && !key) { await setStatus({ state: 'nokey', message: 'Press Connect to start' }); return 30000; }

  const me = await getMe();
  if (!me) { await setStatus({ state: 'nologin', message: 'Log in to roblox.com in this browser' }); return 15000; }

  const { list, complete } = await getRequests();
  const badges = await collectBadges(list);

  // Clean and trim requests to prevent oversized payloads
  const cleanRequests = list.map(r => ({
    id: r.id ?? r.friendRequest?.senderId,
    name: r.name,
    displayName: r.displayName,
    description: (r.description || '').slice(0, 300),
    created: r.created,
    isBanned: r.isBanned,
    hasVerifiedBadge: r.hasVerifiedBadge,
    friendRequest: r.friendRequest ? {
      senderId: r.friendRequest.senderId,
      sentAt: r.friendRequest.sentAt,
      sourceUniverseId: r.friendRequest.sourceUniverseId,
      originSourceType: r.friendRequest.originSourceType
    } : null,
    mutualFriendsList: Array.isArray(r.mutualFriendsList) ? r.mutualFriendsList.slice(0, 5) : []
  }));

  let reply;
  try {
    const r = await fetch(API_BASE + '/api/v1/ext/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: token || undefined, key: token ? undefined : key, device, roblox: me, requests: cleanRequests, complete, badges, done: lastDone })
    });
    reply = await r.json().catch(() => ({}));
    if (!r.ok) {
      // Signed out on the site (or connected another browser): forget the sign-in
      if (reply.reconnect) await chrome.storage.local.remove('token');
      await setStatus({ state: 'error', message: reply.error || ('Server error ' + r.status), roblox: me.name });
      return reply.nextMs || 5000;
    }

    // Broadcast approved players and filtered bot IDs to Roblox content script
    if (Array.isArray(reply.approvedIds) || Array.isArray(reply.botIds)) {
      const filterState = {
        approvedIds: reply.approvedIds || [],
        botIds: reply.botIds || [],
        totalWaiting: list.length,
        filter: reply.filter || 'mm2',
        updatedAt: Date.now()
      };
      await chrome.storage.local.set({ filterState });
      try {
        chrome.tabs.query({ url: '*://*.roblox.com/*' }, tabs => {
          if (!tabs || !Array.isArray(tabs)) return;
          for (const t of tabs) {
            if (t && t.id) {
              chrome.tabs.sendMessage(t.id, { type: 'waurks-filter-update', ...filterState }).catch(() => {});
            }
          }
        });
      } catch (_) {}
    }
  } catch (e) {
    await setStatus({ state: 'error', message: "Can't reach Waurks right now", roblox: me.name });
    return 5000;
  }

  // Do exactly what the server said (only accept / decline)
  lastDone = [];
  const now = Date.now();
  const allActions = Array.isArray(reply.actions) ? reply.actions : [];
  const acceptActions = allActions.filter(a => a.do === 'accept');
  const declineActions = allActions.filter(a => a.do === 'decline');

  // 1. Process declines (declining filtered bots): fast parallel chunks
  const DECLINE_BATCH = 5;
  const toDecline = declineActions.slice(0, 30);
  for (let i = 0; i < toDecline.length; i += DECLINE_BATCH) {
    const chunk = toDecline.slice(i, i + DECLINE_BATCH);
    const results = await Promise.all(chunk.map(a => doAction(a)));
    lastDone.push(...results);
    await new Promise(res => setTimeout(res, 100));
  }

  // 2. Process accepts (adding real players): ONE BY ONE with cooldown pacing!
  if (now >= actionPauseUntil) {
    if (acceptActions.length > 0) {
      // Pick the highest priority accept and process one by one
      const targetAccept = acceptActions[0];
      const res = await doAction(targetAccept);
      lastDone.push(res);

      if (res.rateLimited || res.status === 429) {
        actionPauseUntil = Date.now() + 30000; // 30-second cooldown
      } else {
        // Safe 1.5s cooldown before next accept to prevent tripping Roblox limits
        await new Promise(res => setTimeout(res, 1500));
      }
    }
  } else {
    // Active cooldown: report exact second-by-second countdown to server
    const secsLeft = Math.max(1, Math.ceil((actionPauseUntil - now) / 1000));
    for (const a of acceptActions.slice(0, 10)) {
      lastDone.push({ id: a.id, do: a.do, ok: false, rateLimited: true, retryUntil: actionPauseUntil, error: `Roblox rate limited (too fast) · Retrying in ${secsLeft}s...` });
    }
  }

  await setStatus({
    state: reply.paused ? 'paused' : 'ok',
    message: reply.paused ? 'Paused on the website' : (reply.checking ? `Checking ${reply.checking} more...` : 'Running'),
    roblox: me.name, waiting: list.length, lastSync: Date.now()
  });
  const hasBacklog = (reply.checking && reply.checking > 0) || (!complete && list.length >= 25);
  return reply.nextMs || (hasBacklog ? 800 : 1000);
}

// ---------- keep it running ----------
// Chrome wakes this worker at least every 30s (alarm); while awake it syncs every few seconds.
async function runFor(ms) {
  if (running) return;
  running = true;
  const end = Date.now() + ms;
  try {
    while (Date.now() < end) {
      const wait = await syncOnce().catch(async e => {
        await setStatus({ state: 'error', message: e.message || 'Something went wrong' });
        return 15000;
      });
      if (Date.now() + wait > end) break;
      await new Promise(res => setTimeout(res, wait));
    }
  } finally {
    running = false;
  }
}

chrome.alarms.create('waurks-tick', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(a => { if (a.name === 'waurks-tick') runFor(28000); });
chrome.runtime.onStartup.addListener(() => runFor(28000));
chrome.runtime.onInstalled.addListener(() => runFor(28000));
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg && msg.type === 'sync-now') { runFor(28000); reply({ ok: true }); }
  if (msg && msg.type === 'connect') { connect().then(reply); return true; }
  if (msg && msg.type === 'waurks-get-filter-state') {
    chrome.storage.local.get('filterState').then(({ filterState }) => {
      reply({ ok: true, filterState: filterState || null });
    }).catch(() => reply({ ok: false }));
    return true;
  }
});

// ---------- Connect (no key): open the site, wait for you to approve, then save the sign-in ----------
let connecting = false;
async function connect() {
  if (connecting) return { ok: false, error: 'Already connecting, check the tab that opened' };
  connecting = true;
  try {
    const { device } = await getSettings();
    const r = await fetch(API_BASE + '/api/v1/ext/connect/start', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ device })
    });
    const d = await r.json();
    if (!r.ok) return { ok: false, error: d.error || "Can't reach Waurks" };
    await chrome.tabs.create({ url: API_BASE + d.path });
    await setStatus({ state: 'nokey', message: 'Approve the connection in the tab that opened' });
    // Wait up to 10 minutes for the approval
    const end = Date.now() + 10 * 60000;
    while (Date.now() < end) {
      await new Promise(res => setTimeout(res, 2000));
      const p = await fetch(API_BASE + '/api/v1/ext/connect/poll', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: d.code, device })
      }).catch(() => null);
      if (!p) continue;
      const pd = await p.json().catch(() => ({}));
      if (!p.ok) return { ok: false, error: pd.error || 'Connect failed' };
      if (pd.token) {
        await chrome.storage.local.set({ token: pd.token, account: pd.username || '' });
        await chrome.storage.local.remove('key');
        await setStatus({ state: 'ok', message: 'Connected' });
        runFor(28000);
        return { ok: true };
      }
    }
    return { ok: false, error: 'Took too long. Press Connect again.' };
  } finally {
    connecting = false;
  }
}
