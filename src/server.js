require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const db = require('./database');
const { keyService, TIER_CONFIG } = require('./services/keyService');
const detectionEngine = require('./services/detectionEngine');
const paymentService = require('./services/paymentService');
const discordAuth = require('./auth/discord');
const robloxCloudService = require('./services/robloxCloudService');
const ltcPayments = require('./services/ltcPayments');
const zipExtension = require('./services/zipExtension');

// Ensure latest extension zip is bundled and ready for download
zipExtension.ensureExtensionZip();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
// Clean URLs: /checkout instead of /checkout.html (old .html links redirect)
app.use((req, res, next) => {
  if ((req.method === 'GET' || req.method === 'HEAD') && req.path.endsWith('.html')) {
    const clean = req.path === '/index.html' ? '/' : req.path.slice(0, -5);
    const qs = req.originalUrl.slice(req.path.length);
    return res.redirect(301, clean + qs);
  }
  next();
});

// -------------------------------------------------------------
// MAINTENANCE MODE (switched on/off from the admin panel)
// -------------------------------------------------------------
const siteSettings = { maintenance: false, maintenanceMessage: '' };
db.run(`CREATE TABLE IF NOT EXISTS site_settings (key TEXT PRIMARY KEY, value TEXT)`)
  .then(() => db.all(`SELECT key, value FROM site_settings`))
  .then(rows => {
    for (const r of rows) {
      if (r.key === 'maintenance') siteSettings.maintenance = r.value === '1';
      if (r.key === 'maintenanceMessage') siteSettings.maintenanceMessage = r.value || '';
    }
  })
  .catch(err => console.error('[settings]', err.message));

async function saveSetting(key, value) {
  await db.run(
    `INSERT INTO site_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [key, value]
  );
}

function maintenancePage(message) {
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Waurks — Maintenance</title>
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@700&family=Inter:wght@400;600&display=swap" rel="stylesheet">
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#09080c;color:#f3f1f7;font-family:Inter,sans-serif;padding:20px;text-align:center}
.card{max-width:460px;background:#121017;border:1px solid #272233;border-radius:18px;padding:36px 28px}
.ic{width:44px;height:44px;border-radius:12px;background:#9b5cff;color:#fff;display:flex;align-items:center;justify-content:center;margin:0 auto 18px;font:700 22px 'Space Grotesk',sans-serif}
h1{font-family:'Space Grotesk',sans-serif;font-size:28px;margin:0 0 10px}p{color:#9b94a8;font-size:15px;line-height:1.6;margin:0}
a{display:inline-block;margin-top:24px;color:#9b5cff;font-size:12px;text-decoration:none}</style></head>
<body><div class="card"><div class="ic">W</div><h1>Be right back</h1>
<p>${esc(message || "We're fixing a few things. Check back soon.")}</p>
<a href="/api/v1/auth/discord/login">Staff sign in</a></div></body></html>`;
}

app.use(async (req, res, next) => {
  if (!siteSettings.maintenance) return next();
  // Always reachable: login, the admin panel and its API, health checks
  const p = req.path;
  if (p.startsWith('/api/v1/auth/') || p === '/admin' || p.startsWith('/api/v1/admin/') || p === '/health') return next();
  try {
    if (isAdminUser(await getSessionUser(req))) return next();
  } catch (e) { /* fall through to the maintenance page */ }
  if (p.startsWith('/api/')) {
    return res.status(503).json({ error: 'maintenance', message: siteSettings.maintenanceMessage || 'Down for maintenance' });
  }
  res.status(503).set('Retry-After', '600').type('html').send(maintenancePage(siteSettings.maintenanceMessage));
});

app.use(express.static(path.join(__dirname, '..', 'public'), { extensions: ['html'] }));

// -------------------------------------------------------------
// SESSIONS (signed, HttpOnly cookie — the browser can't forge or read it)
// -------------------------------------------------------------
const DEV_MODE = process.env.ALLOW_DEV_LOGIN === 'true';
const SESSION_COOKIE = 'waurks_session';
const SESSION_DAYS = 7;
const IS_HTTPS = (process.env.DISCORD_REDIRECT_URI || '').startsWith('https://');
let SESSION_SECRET = process.env.SESSION_SECRET;
if (!SESSION_SECRET || SESSION_SECRET.length < 32) {
  SESSION_SECRET = crypto.randomBytes(32).toString('hex');
  console.warn('[auth] SESSION_SECRET missing or shorter than 32 chars: using a random one. Everyone is logged out on restart.');
}
if (DEV_MODE) console.warn('[auth] ALLOW_DEV_LOGIN=true: fake logins and simulated payments are ON. Never use this on the live site.');

function sign(value) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(value).digest('base64url');
}

function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function setCookie(res, name, value, maxAgeSeconds) {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeSeconds}`];
  if (IS_HTTPS) parts.push('Secure');
  const prev = res.getHeader('Set-Cookie');
  res.setHeader('Set-Cookie', [].concat(prev || [], parts.join('; ')));
}

function startSession(res, userId) {
  const expires = Date.now() + SESSION_DAYS * 86400000;
  const payload = `${userId}.${expires}`;
  setCookie(res, SESSION_COOKIE, `${payload}.${sign(payload)}`, SESSION_DAYS * 86400);
}

async function getSessionUser(req) {
  const raw = parseCookies(req)[SESSION_COOKIE];
  if (!raw) return null;
  const [userId, expires, sig] = raw.split('.');
  if (!userId || !expires || !sig) return null;
  if (!safeEqual(sig, sign(`${userId}.${expires}`))) return null;
  if (Date.now() > Number(expires)) return null;
  const user = await db.get(`SELECT * FROM users WHERE id = ?`, [userId]);
  if (!user || user.banned) return null;

  // Real admin impersonating a user to view site as that user
  if (isAdminUser(user)) {
    const impRaw = parseCookies(req).waurks_impersonate;
    if (impRaw) {
      const [impId, impSig] = impRaw.split('.');
      if (impId && impSig && safeEqual(impSig, sign('imp_' + impId))) {
        const impUser = await db.get(`SELECT * FROM users WHERE id = ?`, [impId]);
        if (impUser) {
          impUser.realAdmin = user;
          return impUser;
        }
      }
    }
  }

  return user;
}

async function authMiddleware(req, res, next) {
  try {
    const user = await getSessionUser(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized: Discord login required' });
    req.user = user;
    next();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

function devOnly(req, res, next) {
  if (!DEV_MODE) return res.status(404).json({ error: 'Not found' });
  next();
}

// -------------------------------------------------------------
// AUTH ROUTES
// -------------------------------------------------------------
// Admin "view as member" preview: only works for real admins. 'member' = regular member with a key, 'nokey' = member without a key.
function viewAs(req, user) {
  if (!isAdminUser(user)) return null;
  const v = parseCookies(req).waurks_viewas;
  return v === 'member' || v === 'nokey' ? v : null;
}

app.get('/api/v1/auth/status', async (req, res) => {
  const user = await getSessionUser(req);
  if (!user) return res.json({ loggedIn: false, devLogin: DEV_MODE });
  const realAdmin = user.realAdmin ? user.realAdmin : (isAdminUser(user) ? user : null);
  const impersonating = user.realAdmin ? {
    id: user.id,
    username: user.username,
    discord_id: user.discord_id,
    admin: user.realAdmin.username
  } : null;
  const va = viewAs(req, realAdmin || user);
  res.json({
    loggedIn: true,
    user,
    devLogin: DEV_MODE,
    isAdmin: !!realAdmin && !va,
    realAdmin: !!realAdmin,
    impersonating,
    viewAs: va || (impersonating ? 'user' : 'admin')
  });
});

app.post('/api/v1/admin/view-as', async (req, res) => {
  const user = await getSessionUser(req);
  const adminUser = user?.realAdmin || user;
  if (!isAdminUser(adminUser)) return res.status(403).json({ error: 'Admins only' });
  const mode = String(req.body?.mode || 'admin');
  if (mode === 'admin') setCookie(res, 'waurks_viewas', '', 0);
  else if (mode === 'member' || mode === 'nokey') setCookie(res, 'waurks_viewas', mode, 7 * 86400);
  else return res.status(400).json({ error: 'Unknown view' });
  res.json({ success: true, viewAs: mode });
});

app.post('/api/v1/admin/impersonate/exit', async (req, res) => {
  setCookie(res, 'waurks_impersonate', '', 0);
  res.json({ success: true, redirect: '/admin' });
});

// While previewing "member without a key", pages see an account with no key and nothing linked
app.use(async (req, res, next) => {
  if (req.method !== 'GET' || !req.path.startsWith('/api/v1/')) return next();
  const fake = { '/api/v1/user/licenses': { licenses: [] }, '/api/v1/roblox/status': { connected: false }, '/api/v1/roblox/requests': { connected: false, noKey: true } }[req.path];
  if (!fake) return next();
  try {
    const user = await getSessionUser(req);
    if (viewAs(req, user) === 'nokey') return res.json(fake);
  } catch (e) { /* fall through */ }
  next();
});

app.post('/api/v1/auth/logout', (req, res) => {
  setCookie(res, SESSION_COOKIE, '', 0);
  res.json({ success: true });
});

// One-click fake login — only when ALLOW_DEV_LOGIN=true (local testing)
app.post('/api/v1/auth/dev-login', devOnly, async (req, res) => {
  try {
    const username = String(req.body.username || 'RobloxPlayer').slice(0, 32);
    const user = await discordAuth.devLogin(username);
    startSession(res, user.id);
    res.json({ success: true, user });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Real Discord OAuth2: step 1, send the user to Discord
app.get('/api/v1/auth/discord/login', (req, res) => {
  const state = crypto.randomBytes(16).toString('hex');
  // Only same-site paths like /connect?code=... are allowed (no other websites)
  const next = String(req.query.next || '');
  if (/^\/[a-zA-Z0-9_\-\/?=&.]*$/.test(next) && !next.startsWith('//')) setCookie(res, 'waurks_next', next, 600);
  const url = discordAuth.getOAuthUrl(state);
  if (!url) {
    return res.redirect('/checkout?error=discord_not_configured');
  }
  setCookie(res, 'waurks_oauth_state', state, 600);
  res.redirect(url);
});

// Real Discord OAuth2: step 2, Discord sends the user back here
app.get('/api/v1/auth/discord/callback', async (req, res) => {
  const { code, state } = req.query;
  const expected = parseCookies(req).waurks_oauth_state;
  setCookie(res, 'waurks_oauth_state', '', 0);
  if (!code || !state || !expected || !safeEqual(state, expected)) {
    return res.redirect('/checkout?error=discord_login_failed');
  }
  try {
    const user = await discordAuth.loginWithCode(String(code));
    startSession(res, user.id);
    const next = parseCookies(req).waurks_next;
    setCookie(res, 'waurks_next', '', 0);
    if (next && /^\/[a-zA-Z0-9_\-\/?=&.]*$/.test(next) && !next.startsWith('//')) return res.redirect(next);
    res.redirect('/checkout?login=ok');
  } catch (err) {
    console.error('[auth] Discord login failed:', err.message);
    res.redirect('/checkout?error=discord_login_failed');
  }
});

// -------------------------------------------------------------
// PRICING & TIER INFO
// -------------------------------------------------------------
app.get('/api/v1/tiers', (req, res) => {
  res.json({
    tiers: TIER_CONFIG
  });
});

// -------------------------------------------------------------
// ORDERS & PAYMENTS
// -------------------------------------------------------------
app.post('/api/v1/orders/create', authMiddleware, async (req, res) => {
  try {
    const { tier, paymentMethod } = req.body;
    if (!['weekly', 'monthly', 'yearly'].includes(tier)) {
      return res.status(400).json({ error: 'Invalid tier' });
    }
    if (!['crypto', 'items'].includes(paymentMethod)) {
      return res.status(400).json({ error: 'Invalid payment method' });
    }

    const order = await paymentService.createOrder({
      userId: req.user.id,
      tier,
      paymentMethod
    });

    res.json({ success: true, order });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Customers can only see their own orders (this used to show anyone's key to anyone with the order ID)
app.get('/api/v1/orders/:orderId', authMiddleware, async (req, res) => {
  try {
    const order = await paymentService.getOrder(req.params.orderId);
    if (!order || order.user_id !== req.user.id) return res.status(404).json({ error: 'Order not found' });
    res.json({ order: paymentService.describe(order, order.key_code) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Simulate instant payment for testing & demo
app.post('/api/v1/orders/:orderId/simulate-pay', devOnly, async (req, res) => {
  try {
    const result = await paymentService.completeOrder(req.params.orderId);
    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Live webhook for crypto processors (NowPayments, Coinbase Commerce, Cryptomus, etc.)
app.post('/api/v1/payments/crypto-webhook', async (req, res) => {
  // Without this check anyone could POST {status:"completed"} and get a free key.
  const secret = process.env.WEBHOOK_SECRET;
  const given = req.headers['x-webhook-secret'] || req.query.secret;
  if (!secret || secret.length < 16 || !given || !safeEqual(given, secret)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  try {
    const { order_id, status } = req.body;
    if (status === 'confirmed' || status === 'finished' || status === 'completed') {
      await paymentService.completeOrder(order_id);
    }
    res.json({ received: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// -------------------------------------------------------------
// DASHBOARD & LICENSES
// -------------------------------------------------------------
app.get('/api/v1/user/licenses', authMiddleware, async (req, res) => {
  try {
    const licenses = await keyService.getUserLicenses(req.user.id);
    res.json({ licenses });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/v1/keys/reset-hwid', authMiddleware, async (req, res) => {
  try {
    const { licenseId } = req.body;
    await keyService.resetHwid(req.user.id, licenseId);
    res.json({ success: true, message: 'Device binding reset successfully' });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/v1/keys/verify', async (req, res) => {
  try {
    const { key, hwid } = req.body;
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    const validation = await keyService.validateKey(key, hwid, ip);
    res.json(validation);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// -------------------------------------------------------------
// THE UNCRACKABLE HEURISTIC ORACLE API
// Evaluates friend request profiles using server-side intelligence.
// If key is missing, expired, or invalid -> REJECTS with 401.
// -------------------------------------------------------------
app.post('/api/v1/scan/evaluate', async (req, res) => {
  try {
    const authHeader = req.headers.authorization || '';
    const key = (authHeader.startsWith('Bearer ') ? authHeader.slice(7) : req.body.key || '').trim();
    const hwid = req.headers['x-hwid'] || req.body.hwid || null;
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

    // Strict Key Enforcement
    const validation = await keyService.validateKey(key, hwid, ip);
    if (!validation.valid) {
      return res.status(401).json({
        error: 'Unauthorized: ' + validation.reason,
        expired: !!validation.expired
      });
    }

    const { profiles = [] } = req.body;
    if (!Array.isArray(profiles) || profiles.length === 0) {
      return res.status(400).json({ error: 'No candidate profiles provided' });
    }

    // Process through server-side threat heuristics
    const evaluationResult = await detectionEngine.evaluateBatch(profiles, validation);

    // Record usage metrics in license record
    await keyService.recordStats(validation.licenseId, {
      filtered: evaluationResult.summary.total,
      blocked: evaluationResult.summary.botsDetected,
      accepted: evaluationResult.summary.playersApproved
    });

    res.json({
      success: true,
      license: {
        tier: validation.tier,
        daysRemaining: validation.daysRemaining
      },
      ...evaluationResult
    });
  } catch (err) {
    console.error('Scan evaluate error:', err);
    res.status(500).json({ error: 'Server error during threat analysis' });
  }
});

// Serve waurks.user.js directly with proper header
app.get('/waurks.user.js', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'waurks.user.js'));
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'Waurks Anti-Botter Engine', time: new Date().toISOString() });
});

// -------------------------------------------------------------
// ROBLOX CLOUD 24/7 AUTO-BOTTER ENDPOINTS
// No browser extension required. Runs 100% on the Waurks Cloud.
// -------------------------------------------------------------
app.post('/api/v1/roblox/connect', authMiddleware, async (req, res) => {
  try {
    const { cookie } = req.body;
    if (!cookie) return res.status(400).json({ error: 'Roblox security cookie required.' });

    const status = await robloxCloudService.connectAccount(req.user.id, cookie);
    res.json({ success: true, ...status });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/v1/roblox/status', authMiddleware, async (req, res) => {
  try {
    const status = await robloxCloudService.getAccountStatus(req.user.id);
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/v1/roblox/toggle', authMiddleware, async (req, res) => {
  try {
    const { isActive } = req.body;
    const result = await robloxCloudService.toggleProtection(req.user.id, isActive);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/v1/roblox/settings', authMiddleware, async (req, res) => {
  try {
    const { autoDeclineBots, autoAcceptPlayers, holdReview } = req.body;
    const result = await robloxCloudService.updateSettings(req.user.id, {
      autoDeclineBots,
      autoAcceptPlayers,
      holdReview
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/v1/roblox/filters', authMiddleware, async (req, res) => {
  try {
    const { minAccountAgeDays, minBadges, customBlacklist, customWhitelist } = req.body;
    const result = await robloxCloudService.updateCustomFilters(req.user.id, {
      minAccountAgeDays,
      minBadges,
      customBlacklist,
      customWhitelist
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/v1/roblox/review-queue', authMiddleware, async (req, res) => {
  try {
    const queue = await robloxCloudService.getReviewQueue(req.user.id);
    res.json({ queue });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/v1/roblox/review-action', authMiddleware, async (req, res) => {
  try {
    const { reviewId, action } = req.body;
    const result = await robloxCloudService.resolveReviewItem(req.user.id, reviewId, action);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Extension connect page: approve this browser for the signed-in account
app.post('/api/v1/ext/connect/approve', authMiddleware, async (req, res) => {
  try {
    const code = String(req.body?.code || '');
    const row = await db.get(`SELECT * FROM ext_connect WHERE code = ? AND created_at > datetime('now', '-15 minutes')`, [code]);
    if (!row) return res.status(404).json({ error: 'This connect link expired. Press Connect in the extension again.' });
    await db.run(`UPDATE ext_connect SET user_id = ? WHERE code = ?`, [req.user.id, code]);
    // Clear any restrictive device lock on licenses for this user since they authenticated on site
    await db.run(`UPDATE licenses SET hwid_binding = NULL WHERE user_id = ?`, [req.user.id]);
    const lic = await db.get(`SELECT id FROM licenses WHERE user_id = ? AND status = 'active' AND expires_at > datetime('now') LIMIT 1`, [req.user.id]);
    res.json({ success: true, hasKey: !!lic });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Browser extension API (the extension only fetches + clicks; all logic is here) ----
require('./extApi').mount(app);

// Extension ZIP download endpoints
app.get(['/api/v1/extension/download', '/download/extension', '/downloads/waurks-extension.zip'], (req, res) => {
  try {
    const buf = zipExtension.getExtensionZipBuffer();
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="waurks-extension.zip"');
    res.setHeader('Content-Length', buf.length);
    res.setHeader('Cache-Control', 'no-cache');
    res.end(buf);
  } catch (err) {
    res.status(500).json({ error: 'Could not generate extension zip: ' + err.message });
  }
});

// Extension source inspection endpoint (users can audit code directly on-site without third-party links)
app.get('/api/v1/extension/source', (req, res) => {
  try {
    const extDir = path.join(__dirname, '..', 'extension');
    const files = {
      'manifest.json': fs.readFileSync(path.join(extDir, 'manifest.json'), 'utf8'),
      'background.js': fs.readFileSync(path.join(extDir, 'background.js'), 'utf8'),
      'popup.js': fs.readFileSync(path.join(extDir, 'popup.js'), 'utf8'),
      'popup.html': fs.readFileSync(path.join(extDir, 'popup.html'), 'utf8')
    };
    res.json({ files });
  } catch (err) {
    res.status(500).json({ error: 'Could not load extension source: ' + err.message });
  }
});

app.get(['/extension-source', '/extension-code'], (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'extension-source.html'));
});

app.get(['/privacy', '/privacy-policy'], (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'privacy.html'));
});

// ---- Friend requests page ----
app.get('/api/v1/roblox/requests', authMiddleware, async (req, res) => {
  try {
    res.json(await robloxCloudService.getRequests(req.user.id));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/v1/roblox/requests/clear-filtered', authMiddleware, async (req, res) => {
  try {
    res.json(await robloxCloudService.clearFilteredBots(req.user.id));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/v1/roblox/requests/:targetId/:action', authMiddleware, async (req, res) => {
  try {
    const { targetId, action } = req.params;
    if (action === 'accept') return res.json(await robloxCloudService.answerRequest(req.user.id, targetId, true));
    if (action === 'decline') return res.json(await robloxCloudService.answerRequest(req.user.id, targetId, false));
    if (action === 'bot') {
      if (!isAdminUser(req.user)) return res.status(403).json({ error: 'Only admins can mark bots' });
      return res.json(await robloxCloudService.adminMarkBot(req.user, targetId));
    }
    res.status(400).json({ error: 'Unknown action' });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/v1/roblox/auto-accept', authMiddleware, async (req, res) => {
  try {
    res.json(await robloxCloudService.setAutoAccept(req.user.id, !!req.body.enabled));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/v1/roblox/accept-filter', authMiddleware, async (req, res) => {
  try {
    res.json(await robloxCloudService.setAcceptFilter(req.user.id, String(req.body.filter || '')));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/v1/roblox/filter', authMiddleware, async (req, res) => {
  try {
    res.json(await robloxCloudService.setFilterLevel(req.user.id, String(req.body.level || '')));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/v1/roblox/scan-now', authMiddleware, async (req, res) => {
  try {
    // Extension mode: there's no saved cookie here, so ask the browser extension to re-check everything
    const acc = await db.get(`SELECT id, mode FROM roblox_accounts WHERE user_id = ?`, [req.user.id]);
    if (acc && acc.mode === 'extension') {
      await db.run(`UPDATE friend_requests SET checked_at = NULL WHERE user_id = ? AND status = 'pending'`, [req.user.id]);
      await db.run(`UPDATE roblox_accounts SET scan_requested = 1, last_error = NULL WHERE id = ?`, [acc.id]);
      return res.json({ success: true, ext: true });
    }
    const result = await robloxCloudService.runCloudScan(req.user.id, { force: true });
    await db.run(`UPDATE roblox_accounts SET last_check_at = CURRENT_TIMESTAMP WHERE user_id = ?`, [req.user.id]).catch(() => {});
    await robloxCloudService.setScanError(req.user.id, null);
    res.json({ success: true, ...result });
  } catch (err) {
    if (err.busy) return res.status(409).json({ error: err.message, busy: true });
    await robloxCloudService.setScanError(req.user.id, err.message).catch(() => {});
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/v1/roblox/disconnect', authMiddleware, async (req, res) => {
  try {
    const result = await robloxCloudService.disconnectAccount(req.user.id);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// -------------------------------------------------------------
// ADMIN BACKOFFICE API
// Protected management endpoints for seller/staff
// -------------------------------------------------------------

// Discord accounts that get the admin panel just by signing in.
// Add more in Railway with ADMIN_DISCORD_IDS=id1,id2
const ADMIN_DISCORD_IDS = new Set(
  ['1094670363071361147', ...(process.env.ADMIN_DISCORD_IDS || '').split(',')]
    .map(s => s.trim()).filter(Boolean)
);
function isAdminUser(user) {
  return !!user && ADMIN_DISCORD_IDS.has(String(user.discord_id));
}

// Add the "banned" column to older databases (ignored if it already exists)
db.run(`ALTER TABLE users ADD COLUMN banned INTEGER DEFAULT 0`).catch(() => {});

async function adminAuthMiddleware(req, res, next) {
  try {
    const user = await getSessionUser(req);
    const adminUser = user?.realAdmin || user;
    if (isAdminUser(adminUser)) {
      req.admin = adminUser.username;
      req.adminUser = adminUser;
      return next();
    }
    return res.status(403).json({ error: 'Forbidden: admins only' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

async function logAdmin(req, action, details, licenseId = null) {
  try {
    await db.run(
      `INSERT INTO audit_logs (license_id, action, details, ip_address) VALUES (?, ?, ?, ?)`,
      [licenseId, `ADMIN_${action}`, `${req.admin}: ${details}`, req.ip]
    );
  } catch (e) { /* never block an admin action on logging */ }
}

app.get('/api/v1/admin/me', adminAuthMiddleware, (req, res) => {
  res.json({ admin: req.admin });
});

// ---- Site settings: maintenance mode + payment status ----
app.get('/api/v1/admin/settings', adminAuthMiddleware, (req, res) => {
  res.json({
    maintenance: siteSettings.maintenance,
    maintenanceMessage: siteSettings.maintenanceMessage,
    ltc: ltcPayments.status()
  });
});

app.post('/api/v1/admin/maintenance', adminAuthMiddleware, async (req, res) => {
  try {
    const enabled = !!req.body.enabled;
    const message = String(req.body.message || '').slice(0, 300);
    siteSettings.maintenance = enabled;
    siteSettings.maintenanceMessage = message;
    await saveSetting('maintenance', enabled ? '1' : '0');
    await saveSetting('maintenanceMessage', message);
    await logAdmin(req, enabled ? 'MAINTENANCE_ON' : 'MAINTENANCE_OFF', enabled ? `site closed: ${message || '(default message)'}` : 'site reopened');
    res.json({ success: true, maintenance: enabled, maintenanceMessage: message });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Users ----
app.get('/api/v1/admin/users', adminAuthMiddleware, async (req, res) => {
  try {
    const q = `%${String(req.query.q || '').trim()}%`;
    const users = await db.all(
      `SELECT u.id, u.discord_id, u.username, u.avatar, u.created_at, COALESCE(u.banned,0) AS banned,
        (SELECT COUNT(*) FROM licenses l WHERE l.user_id = u.id AND l.status = 'active' AND l.expires_at > datetime('now')) AS active_keys,
        (SELECT COALESCE(SUM(amount_usd),0) FROM orders o WHERE o.user_id = u.id AND o.status = 'completed') AS spent_usd,
        (SELECT roblox_username FROM roblox_accounts r WHERE r.user_id = u.id LIMIT 1) AS roblox_username,
        (SELECT roblox_id FROM roblox_accounts r WHERE r.user_id = u.id LIMIT 1) AS roblox_id,
        (SELECT avatar_url FROM roblox_accounts r WHERE r.user_id = u.id LIMIT 1) AS roblox_avatar,
        (SELECT is_active FROM roblox_accounts r WHERE r.user_id = u.id LIMIT 1) AS is_active,
        (SELECT mode FROM roblox_accounts r WHERE r.user_id = u.id LIMIT 1) AS botter_mode,
        (SELECT (CASE WHEN r.last_check_at > datetime('now', '-45 seconds') THEN 1 ELSE 0 END) FROM roblox_accounts r WHERE r.user_id = u.id LIMIT 1) AS is_online
       FROM users u
       WHERE u.username LIKE ? OR u.discord_id LIKE ?
       ORDER BY u.id DESC LIMIT 100`,
      [q, q]
    );
    res.json({ users });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Live Anti-Botter Screen Viewer: returns exactly what is currently happening on this user's screen
app.get('/api/v1/admin/users/:id/screen', adminAuthMiddleware, async (req, res) => {
  try {
    const userId = req.params.id;
    const user = await db.get(`SELECT id, username, discord_id, avatar, created_at, COALESCE(banned, 0) AS banned FROM users WHERE id = ?`, [userId]);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const account = await db.get(`SELECT * FROM roblox_accounts WHERE user_id = ?`, [userId]);
    const license = await db.get(
      `SELECT * FROM licenses WHERE user_id = ? AND status = 'active' AND expires_at > datetime('now') ORDER BY expires_at DESC LIMIT 1`,
      [userId]
    );
    const extToken = await db.get(`SELECT device, last_used_at FROM ext_tokens WHERE user_id = ? ORDER BY id DESC LIMIT 1`, [userId]);

    // Live requests payload (what user sees on their /requests screen right now)
    const screenData = await robloxCloudService.getRequests(userId);

    // Recent activity log for this user
    const recentLogs = await db.all(
      `SELECT action, details, created_at FROM audit_logs WHERE license_id = ? OR details LIKE ? ORDER BY id DESC LIMIT 20`,
      [license?.id || 0, `%${user.username}%`]
    );

    const lastCheckTime = account?.last_check_at ? new Date(String(account.last_check_at).replace(' ', 'T') + 'Z').getTime() : 0;
    const isOnlineNow = (Date.now() - lastCheckTime) < 45000;

    res.json({
      user,
      account: account ? {
        id: account.id,
        robloxId: account.roblox_id,
        robloxUsername: account.roblox_username,
        avatarUrl: account.avatar_url,
        mode: account.mode,
        isActive: !!account.is_active,
        autoAccept: !!account.auto_accept_players,
        acceptFilter: account.accept_filter,
        filterLevel: account.filter_level,
        lastCheckAt: account.last_check_at,
        lastScanAt: account.last_scan_at,
        isOnline: isOnlineNow
      } : null,
      license: license ? {
        id: license.id,
        key: license.license_key,
        tier: license.tier,
        expiresAt: license.expires_at,
        deviceHwid: license.device_hwid
      } : null,
      extToken: extToken ? {
        device: extToken.device,
        lastUsedAt: extToken.last_used_at
      } : null,
      screen: screenData,
      recentLogs
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Impersonate a user to see the entire site as them
app.post('/api/v1/admin/users/:id/impersonate', adminAuthMiddleware, async (req, res) => {
  try {
    const targetId = req.params.id;
    const targetUser = await db.get(`SELECT * FROM users WHERE id = ?`, [targetId]);
    if (!targetUser) return res.status(404).json({ error: 'User not found' });
    setCookie(res, 'waurks_impersonate', `${targetId}.${sign('imp_' + targetId)}`, 86400);
    await logAdmin(req, 'IMPERSONATE', `started viewing site as ${targetUser.username} (${targetUser.discord_id})`);
    res.json({ success: true, redirect: '/requests' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin action: clear filtered bots for a user
app.post('/api/v1/admin/users/:id/clear-bots', adminAuthMiddleware, async (req, res) => {
  try {
    const result = await robloxCloudService.clearFilteredBots(req.params.id);
    await logAdmin(req, 'CLEAR_BOTS', `cleared ${result.cleared} filtered bots for user #${req.params.id}`);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/v1/admin/users/:id/grant', adminAuthMiddleware, async (req, res) => {
  try {
    const tier = req.body.tier;
    if (!TIER_CONFIG[tier]) return res.status(400).json({ error: 'Invalid tier' });
    const user = await db.get(`SELECT * FROM users WHERE id = ?`, [req.params.id]);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const license = await keyService.issueKey(user.id, tier);
    await logAdmin(req, 'GRANT_KEY', `gave ${tier} key to ${user.username} (${user.discord_id})`, license.licenseId);
    res.json({ success: true, license });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/v1/admin/users/:id/ban', adminAuthMiddleware, async (req, res) => {
  try {
    const user = await db.get(`SELECT * FROM users WHERE id = ?`, [req.params.id]);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (isAdminUser(user)) return res.status(400).json({ error: 'You cannot ban an admin' });
    await db.run(`UPDATE users SET banned = 1 WHERE id = ?`, [user.id]);
    await db.run(`UPDATE licenses SET status = 'revoked' WHERE user_id = ? AND status = 'active'`, [user.id]);
    await db.run(`UPDATE roblox_accounts SET is_active = 0 WHERE user_id = ?`, [user.id]);
    await logAdmin(req, 'BAN', `banned ${user.username} (${user.discord_id}), revoked their keys`);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/v1/admin/users/:id/unban', adminAuthMiddleware, async (req, res) => {
  try {
    const user = await db.get(`SELECT * FROM users WHERE id = ?`, [req.params.id]);
    if (!user) return res.status(404).json({ error: 'User not found' });
    await db.run(`UPDATE users SET banned = 0 WHERE id = ?`, [user.id]);
    await logAdmin(req, 'UNBAN', `unbanned ${user.username} (${user.discord_id})`);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---- Friend request logs: auto-accepted people and filtered bots, across all customers ----
app.get('/api/v1/admin/requests', adminAuthMiddleware, async (req, res) => {
  try {
    const type = req.query.type === 'filtered' ? 'filtered' : 'accepted';
    const q = `%${String(req.query.q || '').trim()}%`;
    const where = type === 'accepted'
      ? `fr.status = 'accepted' AND fr.auto = 1`
      : `fr.verdict = 'DECLINE'`;
    const rows = await db.all(
      `SELECT fr.target_id, fr.name, fr.display_name, fr.avatar_url, fr.verdict, fr.score, fr.reasons, fr.facts, fr.status,
              fr.updated_at, u.username AS customer, u.discord_id AS customer_discord
       FROM friend_requests fr JOIN users u ON u.id = fr.user_id
       WHERE ${where} AND (fr.name LIKE ? OR fr.display_name LIKE ? OR fr.target_id LIKE ? OR u.username LIKE ?)
       ORDER BY fr.updated_at DESC LIMIT 200`,
      [q, q, q, q]
    );
    const counts = await db.get(
      `SELECT SUM(status = 'accepted' AND auto = 1) AS accepted, SUM(verdict = 'DECLINE') AS filtered,
              SUM(status = 'accepted' AND auto = 1 AND updated_at > datetime('now', '-1 day')) AS accepted24,
              SUM(verdict = 'DECLINE' AND updated_at > datetime('now', '-1 day')) AS filtered24
       FROM friend_requests`
    );
    const parse = v => { try { return JSON.parse(v); } catch (e) { return null; } };
    res.json({
      type,
      counts: { accepted: counts?.accepted || 0, filtered: counts?.filtered || 0, accepted24: counts?.accepted24 || 0, filtered24: counts?.filtered24 || 0 },
      rows: rows.map(r => ({
        id: r.target_id, name: r.name, displayName: r.display_name, avatar: r.avatar_url,
        score: r.score, reasons: parse(r.reasons) || [], facts: parse(r.facts) || {}, status: r.status,
        at: r.updated_at, customer: r.customer, customerDiscord: r.customer_discord
      }))
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Admin activity log ----
app.get('/api/v1/admin/audit', adminAuthMiddleware, async (req, res) => {
  try {
    const logs = await db.all(`SELECT * FROM audit_logs ORDER BY id DESC LIMIT 100`);
    res.json({ logs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/v1/admin/licenses/:licenseId/reset-hwid', adminAuthMiddleware, async (req, res) => {
  try {
    await db.run(`UPDATE licenses SET hwid_binding = NULL WHERE id = ?`, [req.params.licenseId]);
    await logAdmin(req, 'RESET_HWID', `reset device lock on license #${req.params.licenseId}`, req.params.licenseId);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/v1/admin/stats', adminAuthMiddleware, async (req, res) => {
  try {
    const revenue = await db.get(`SELECT SUM(amount_usd) as total_usd, COUNT(*) as total_orders FROM orders WHERE status = 'completed'`);
    const activeKeys = await db.get(`SELECT COUNT(*) as active_count FROM licenses WHERE status = 'active' AND expires_at > datetime('now')`);
    const pendingTrades = await db.get(`SELECT COUNT(*) as pending_count FROM orders WHERE payment_method = 'items' AND status = 'pending'`);
    const users = await db.get(`SELECT COUNT(*) as n FROM users`);
    const week = await db.get(`SELECT COALESCE(SUM(amount_usd),0) as usd FROM orders WHERE status = 'completed' AND created_at > datetime('now','-7 days')`);
    const connectedAccounts = await db.get(`SELECT COUNT(*) as accounts_count FROM roblox_accounts`);
    const botStats = await db.get(
      `SELECT 
        COUNT(*) as total_filtered,
        SUM(CASE WHEN verdict = 'DECLINE' THEN 1 ELSE 0 END) as bots_blocked,
        SUM(CASE WHEN verdict = 'ACCEPT' THEN 1 ELSE 0 END) as players_accepted
       FROM scan_activity_logs`
    );

    res.json({
      revenueUsd: revenue?.total_usd || 0,
      revenue7dUsd: week?.usd || 0,
      totalUsers: users?.n || 0,
      totalOrders: revenue?.total_orders || 0,
      activeSubscriptions: activeKeys?.active_count || 0,
      pendingTradeTickets: pendingTrades?.pending_count || 0,
      connectedRobloxAccounts: connectedAccounts?.accounts_count || 0,
      totalBotsBlocked: botStats?.bots_blocked || 0,
      totalPlayersAccepted: botStats?.players_accepted || 0
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/v1/admin/orders', adminAuthMiddleware, async (req, res) => {
  try {
    const orders = await db.all(
      `SELECT o.*, u.username as discord_username, l.key_code 
       FROM orders o 
       JOIN users u ON o.user_id = u.id 
       LEFT JOIN licenses l ON o.license_id = l.id 
       ORDER BY (o.status = 'pending') DESC, o.id DESC LIMIT 100`
    );
    res.json({ orders });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/v1/admin/orders/:orderId/approve', adminAuthMiddleware, async (req, res) => {
  try {
    const result = await paymentService.completeOrder(req.params.orderId);
    await logAdmin(req, 'APPROVE_ORDER', `approved order ${req.params.orderId}`);
    res.json({ success: true, result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/v1/admin/orders/:orderId/cancel', adminAuthMiddleware, async (req, res) => {
  try {
    await db.run(`UPDATE orders SET status = 'cancelled' WHERE order_id = ?`, [req.params.orderId]);
    await logAdmin(req, 'CANCEL_ORDER', `cancelled order ${req.params.orderId}`);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/v1/admin/licenses', adminAuthMiddleware, async (req, res) => {
  try {
    const licenses = await db.all(
      `SELECT l.*, u.username as owner_username, u.discord_id 
       FROM licenses l 
       JOIN users u ON l.user_id = u.id 
       WHERE l.key_code LIKE ? OR u.username LIKE ? OR u.discord_id LIKE ?
       ORDER BY l.id DESC LIMIT 100`,
      Array(3).fill(`%${String(req.query.q || '').trim()}%`)
    );
    res.json({ licenses });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/v1/admin/licenses/:licenseId/revoke', adminAuthMiddleware, async (req, res) => {
  try {
    await db.run(`UPDATE licenses SET status = 'revoked' WHERE id = ?`, [req.params.licenseId]);
    await logAdmin(req, 'REVOKE', `revoked license #${req.params.licenseId}`, req.params.licenseId);
    res.json({ success: true, message: 'License revoked' });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/v1/admin/licenses/:licenseId/extend', adminAuthMiddleware, async (req, res) => {
  try {
    const days = Number(req.body.days);
    if (!Number.isInteger(days) || days < 1 || days > 3650) return res.status(400).json({ error: 'Days must be 1-3650' });
    const license = await db.get(`SELECT * FROM licenses WHERE id = ?`, [req.params.licenseId]);
    if (!license) return res.status(404).json({ error: 'License not found' });

    const currentExp = new Date(license.expires_at).getTime();
    const newExp = new Date(Math.max(Date.now(), currentExp) + days * 86400000).toISOString();

    await db.run(`UPDATE licenses SET expires_at = ?, status = 'active' WHERE id = ?`, [newExp, req.params.licenseId]);
    await logAdmin(req, 'EXTEND', `added ${days} days to license #${req.params.licenseId}`, req.params.licenseId);
    res.json({ success: true, newExpiresAt: newExp });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/v1/admin/blacklist', adminAuthMiddleware, async (req, res) => {
  try {
    const blacklist = await db.all(`SELECT * FROM global_bot_blacklist ORDER BY id DESC`);
    res.json({ blacklist });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/v1/admin/blacklist/add', adminAuthMiddleware, async (req, res) => {
  try {
    const { robloxUserId, usernamePattern, reason } = req.body;
    await db.run(
      `INSERT INTO global_bot_blacklist (roblox_user_id, username_pattern, reason) VALUES (?, ?, ?)`,
      [robloxUserId || null, usernamePattern || null, reason || 'Flagged botnet']
    );
    await logAdmin(req, 'BLACKLIST_ADD', `added ${robloxUserId || usernamePattern}`);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/v1/admin/blacklist/:id/delete', adminAuthMiddleware, async (req, res) => {
  try {
    await db.run(`DELETE FROM global_bot_blacklist WHERE id = ?`, [req.params.id]);
    await logAdmin(req, 'BLACKLIST_DELETE', `removed blacklist rule #${req.params.id}`);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Start Server
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`[Waurks] Cloud Anti-Bot Server running on http://localhost:${PORT}`);
    // Start background cloud daemon
    robloxCloudService.startDaemon(10);
    // Watch the LTC wallet and issue keys automatically when payments confirm
    ltcPayments.start(orderId => paymentService.completeOrder(orderId), 30);
    // One time: turn auto-accept off for existing accounts, so real players show on the Friend requests page
    db.get(`SELECT value FROM site_settings WHERE key = 'migr_autoaccept_off'`).then(row => {
      if (row) return;
      return db.run(`UPDATE roblox_accounts SET auto_accept_players = 0`)
        .then(() => saveSetting('migr_autoaccept_off', '1'));
    }).catch(() => {});
    // Requests left waiting by the old MM2 rule get re-checked (now: no badge = filtered as a bot)
    db.run(`UPDATE friend_requests SET checked_at = NULL WHERE status = 'pending' AND reasons LIKE '%No MM2 Level 10 badge%'`).catch(() => {});
    db.run(`UPDATE friend_requests SET checked_at = NULL, status = 'pending' WHERE reasons LIKE '%Offline (failed step 2)%' AND reasons LIKE '%MM2%'`).catch(() => {});
    // Clean up any stale friend requests where MM2 was incorrectly accepted without Level 10 badge
    db.run(`UPDATE friend_requests SET verdict = 'DECLINE', score = 100, reasons = '["No MM2 Level 10 badge"]' WHERE status = 'pending' AND (facts NOT LIKE '%"mm2":true%' OR facts IS NULL OR reasons LIKE '%No MM2%')`).catch(() => {});
    // After an update, re-check everything still waiting with the newest rules
    db.run(`UPDATE friend_requests SET checked_at = NULL WHERE status = 'pending'`).catch(() => {});
    // Lifetime keys: make older "yearly" keys never expire too
    db.run(`UPDATE licenses SET expires_at = '2126-01-01T00:00:00.000Z' WHERE tier = 'yearly' AND status != 'revoked' AND expires_at < '2100'`).catch(() => {});
  });
}

module.exports = app;

