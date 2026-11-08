/*
 * Waurks extension - background worker.
 *
 * This file has NO filtering logic on purpose. It only:
 *   1. reads your waiting friend requests from roblox.com (with your own browser login),
 *   2. sends them to the Waurks server with your key,
 *   3. does what the server says (accept / decline).
 * Every rule and decision is on the server, so there's nothing here worth cracking.
 */

const DEFAULT_API = 'https://devsupplies.cc';
const MAX_PAGES = 50;           // up to 1,250 requests per sync (handles 500+ backlogs instantly)
const BADGE_LOOKUPS_PER_SYNC = 40;

let running = false;
let csrfToken = null;
let lastDone = [];
const badgeCache = new Map(); // userId -> badge count (data only, the server decides what it means)

// ---------- storage helpers ----------
async function getSettings() {
  const s = await chrome.storage.local.get(['key', 'device', 'apiBase']);
  if (!s.device) {
    s.device = 'ext-' + crypto.randomUUID();
    await chrome.storage.local.set({ device: s.device });
  }
  return { key: s.key || '', device: s.device, apiBase: (s.apiBase || DEFAULT_API).replace(/\/+$/, '') };
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
    all.push(...(d.data || []));
    cursor = d.nextPageCursor;
    if (!cursor) { complete = true; break; }
  }
  return { list: all, complete };
}

// Badge counts need a login, so the extension looks them up in parallel batches.
async function collectBadges(list) {
  const out = {};
  const toFetch = [];
  for (const r of list) {
    const id = String(r.id ?? r.friendRequest?.senderId ?? '');
    if (!id) continue;
    if (badgeCache.has(id)) { out[id] = badgeCache.get(id); continue; }
    if (toFetch.length < BADGE_LOOKUPS_PER_SYNC) toFetch.push(id);
  }

  // Fetch concurrently in small batches of 6 for rapid speed
  const BATCH = 6;
  for (let i = 0; i < toFetch.length; i += BATCH) {
    const slice = toFetch.slice(i, i + BATCH);
    await Promise.all(slice.map(async id => {
      try {
        const res = await roblox(`https://badges.roblox.com/v1/users/${id}/badges?limit=25&sortOrder=Desc`);
        if (res.ok) {
          const d = await res.json();
          const n = Array.isArray(d.data) ? d.data.length : null;
          if (n !== null) { badgeCache.set(id, n); out[id] = n; }
        }
      } catch (e) { /* skip */ }
    }));
  }
  return out;
}

async function doAction(a) {
  const id = String(a.id).replace(/\D/g, '');
  if (!id || (a.do !== 'accept' && a.do !== 'decline')) return { id, do: a.do, ok: false };
  try {
    const r = await roblox(`https://friends.roblox.com/v1/users/${id}/${a.do}-friend-request`, 'POST', {});
    return { id, do: a.do, ok: r.ok || r.status === 400 };
  } catch (e) {
    return { id, do: a.do, ok: false };
  }
}

// ---------- one sync with the server ----------
async function syncOnce() {
  const { key, device, apiBase } = await getSettings();
  if (!key) { await setStatus({ state: 'nokey', message: 'Enter your key to start' }); return 30000; }

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
    const r = await fetch(apiBase + '/api/v1/ext/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, device, roblox: me, requests: cleanRequests, complete, badges, done: lastDone })
    });
    reply = await r.json().catch(() => ({}));
    if (!r.ok) {
      await setStatus({ state: 'error', message: reply.error || ('Server error ' + r.status), roblox: me.name });
      return reply.nextMs || 5000;
    }
  } catch (e) {
    await setStatus({ state: 'error', message: "Can't reach Waurks right now", roblox: me.name });
    return 5000;
  }

  // Do exactly what the server said
  lastDone = [];
  for (const a of (reply.actions || []).slice(0, 50)) {
    lastDone.push(await doAction(a));
    await new Promise(res => setTimeout(res, 150));
  }

  await setStatus({
    state: reply.paused ? 'paused' : 'ok',
    message: reply.paused ? 'Paused on the website' : (reply.checking ? `Checking ${reply.checking} more...` : 'Running'),
    roblox: me.name, waiting: list.length, lastSync: Date.now()
  });
  const hasBacklog = (reply.checking && reply.checking > 0) || (!complete && list.length >= 25);
  return reply.nextMs || (hasBacklog ? 1200 : 7000);
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
});
