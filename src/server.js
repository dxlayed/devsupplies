require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const db = require('./database');
const { keyService, TIER_CONFIG } = require('./services/keyService');
const detectionEngine = require('./services/detectionEngine');
const paymentService = require('./services/paymentService');
const discordAuth = require('./auth/discord');
const robloxCloudService = require('./services/robloxCloudService');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, '..', 'public')));

// Simple session helper: parses 'x-user-id' header or query for authenticated requests
async function authMiddleware(req, res, next) {
  const userId = req.headers['x-user-id'] || req.query.user_id;
  if (!userId) {
    return res.status(401).json({ error: 'Unauthorized: Discord login required' });
  }
  const user = await db.get(`SELECT * FROM users WHERE id = ?`, [userId]);
  if (!user) {
    return res.status(401).json({ error: 'User not found' });
  }
  req.user = user;
  next();
}

// -------------------------------------------------------------
// AUTH ROUTES
// -------------------------------------------------------------
app.get('/api/v1/auth/status', async (req, res) => {
  const userId = req.headers['x-user-id'] || req.query.user_id;
  if (!userId) return res.json({ loggedIn: false });

  const user = await db.get(`SELECT * FROM users WHERE id = ?`, [userId]);
  if (!user) return res.json({ loggedIn: false });

  res.json({ loggedIn: true, user });
});

// One-click instant login for testing/demo
app.post('/api/v1/auth/dev-login', async (req, res) => {
  try {
    const username = req.body.username || 'RobloxPlayer';
    const user = await discordAuth.devLogin(username);
    res.json({ success: true, user });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Real Discord OAuth2 entrypoint
app.get('/api/v1/auth/discord/login', (req, res) => {
  const url = discordAuth.getOAuthUrl();
  if (!url) {
    return res.redirect('/checkout.html?error=discord_not_configured');
  }
  res.redirect(url);
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
    const { tier, paymentMethod, cryptoCurrency } = req.body;
    if (!['weekly', 'monthly', 'yearly'].includes(tier)) {
      return res.status(400).json({ error: 'Invalid tier' });
    }
    if (!['crypto', 'items'].includes(paymentMethod)) {
      return res.status(400).json({ error: 'Invalid payment method' });
    }

    const order = await paymentService.createOrder({
      userId: req.user.id,
      tier,
      paymentMethod,
      cryptoCurrency
    });

    res.json({ success: true, order });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/v1/orders/:orderId', async (req, res) => {
  try {
    const order = await paymentService.getOrder(req.params.orderId);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    res.json({ order });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Simulate instant payment for testing & demo
app.post('/api/v1/orders/:orderId/simulate-pay', async (req, res) => {
  try {
    const result = await paymentService.completeOrder(req.params.orderId);
    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Live webhook for crypto processors (NowPayments, Coinbase Commerce, Cryptomus, etc.)
app.post('/api/v1/payments/crypto-webhook', async (req, res) => {
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

app.post('/api/v1/roblox/scan-now', authMiddleware, async (req, res) => {
  try {
    const result = await robloxCloudService.runCloudScan(req.user.id);
    res.json({ success: true, ...result });
  } catch (err) {
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
const ADMIN_SECRET = process.env.ADMIN_KEY || 'waurks-admin-2026';

function adminAuthMiddleware(req, res, next) {
  const adminKey = req.headers['x-admin-key'] || req.query.admin_key;
  if (!adminKey || adminKey !== ADMIN_SECRET) {
    return res.status(403).json({ error: 'Forbidden: Invalid Admin Secret' });
  }
  next();
}

app.get('/api/v1/admin/stats', adminAuthMiddleware, async (req, res) => {
  try {
    const revenue = await db.get(`SELECT SUM(amount_usd) as total_usd, COUNT(*) as total_orders FROM orders WHERE status = 'completed'`);
    const activeKeys = await db.get(`SELECT COUNT(*) as active_count FROM licenses WHERE status = 'active' AND expires_at > datetime('now')`);
    const pendingTrades = await db.get(`SELECT COUNT(*) as pending_count FROM orders WHERE payment_method = 'items' AND status = 'pending'`);
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
       ORDER BY o.id DESC LIMIT 50`
    );
    res.json({ orders });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/v1/admin/orders/:orderId/approve', adminAuthMiddleware, async (req, res) => {
  try {
    const result = await paymentService.completeOrder(req.params.orderId);
    res.json({ success: true, result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/v1/admin/orders/:orderId/cancel', adminAuthMiddleware, async (req, res) => {
  try {
    await db.run(`UPDATE orders SET status = 'cancelled' WHERE order_id = ?`, [req.params.orderId]);
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
       ORDER BY l.id DESC LIMIT 50`
    );
    res.json({ licenses });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/v1/admin/licenses/:licenseId/revoke', adminAuthMiddleware, async (req, res) => {
  try {
    await db.run(`UPDATE licenses SET status = 'revoked' WHERE id = ?`, [req.params.licenseId]);
    res.json({ success: true, message: 'License revoked' });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/v1/admin/licenses/:licenseId/extend', adminAuthMiddleware, async (req, res) => {
  try {
    const { days = 7 } = req.body;
    const license = await db.get(`SELECT * FROM licenses WHERE id = ?`, [req.params.licenseId]);
    if (!license) return res.status(404).json({ error: 'License not found' });

    const currentExp = new Date(license.expires_at).getTime();
    const newExp = new Date(Math.max(Date.now(), currentExp) + days * 86400000).toISOString();

    await db.run(`UPDATE licenses SET expires_at = ?, status = 'active' WHERE id = ?`, [newExp, req.params.licenseId]);
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
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/v1/admin/blacklist/:id/delete', adminAuthMiddleware, async (req, res) => {
  try {
    await db.run(`DELETE FROM global_bot_blacklist WHERE id = ?`, [req.params.id]);
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
    robloxCloudService.startDaemon(60);
  });
}

module.exports = app;

