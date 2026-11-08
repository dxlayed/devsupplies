const crypto = require('crypto');
const db = require('../database');
const { keyService, TIER_CONFIG } = require('./keyService');
const discordNotification = require('./discordNotification');

const ltcPayments = require('./ltcPayments');

// Orders being completed right now, so a key is never issued twice for one order
const completing = new Set();

class PaymentService {
  /**
   * Creates a new pending order
   */
  async createOrder({ userId, tier, paymentMethod }) {
    const config = TIER_CONFIG[tier];
    if (!config) throw new Error(`Invalid tier: ${tier}`);

    const orderId = `ORD-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
    const amountUsd = config.price;

    let tradeTicketId = null;
    let cryptoAddress = null;
    let cryptoCurrency = null;
    let ltc = null;

    if (paymentMethod === 'crypto') {
      // Litecoin only. Reuse the customer's still-valid quote for the same plan instead of making a new one.
      const existing = await db.get(
        `SELECT * FROM orders WHERE user_id = ? AND tier = ? AND status = 'pending' AND payment_method = 'crypto'
           AND ltc_txid IS NULL AND ltc_expires_at > datetime('now', '+5 minutes') ORDER BY id DESC LIMIT 1`,
        [userId, tier]
      );
      if (existing) return this.describe(existing);
      const open = await db.get(
        `SELECT COUNT(*) AS n FROM orders WHERE user_id = ? AND status = 'pending' AND payment_method = 'crypto' AND ltc_expires_at > datetime('now')`,
        [userId]
      );
      if (open.n >= 3) throw new Error('You already have 3 open payments. Finish or wait for one to expire.');
      ltc = await ltcPayments.quote(amountUsd);
      cryptoAddress = ltc.address;
      cryptoCurrency = 'LTC';
    } else if (paymentMethod === 'items') {
      tradeTicketId = `TRADE-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
    }

    await db.run(
      `INSERT INTO orders (order_id, user_id, tier, amount_usd, payment_method, crypto_currency, crypto_address, trade_ticket_id, status,
         ltc_amount_sats, ltc_rate, ltc_expires_at, ltc_index)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
      [orderId, userId, tier, amountUsd, paymentMethod, cryptoCurrency, cryptoAddress, tradeTicketId,
       ltc ? ltc.sats : null, ltc ? ltc.rate : null, ltc ? ltc.expiresAtDb : null, ltc ? ltc.index : null]
    );

    if (paymentMethod === 'items') {
      const user = await db.get(`SELECT username FROM users WHERE id = ?`, [userId]);
      discordNotification.notifyItemTradeRequested({
        orderId,
        tradeTicketId,
        username: user ? user.username : `User #${userId}`,
        tier,
        amountUsd
      }).catch(() => {});
    }

    return this.describe(await db.get(`SELECT * FROM orders WHERE order_id = ?`, [orderId]));
  }

  /**
   * What the customer's checkout page needs to know about an order
   */
  describe(order, keyCode = null) {
    const cfg = TIER_CONFIG[order.tier] || {};
    const out = {
      orderId: order.order_id,
      tier: order.tier,
      tierName: cfg.name,
      amountUsd: order.amount_usd,
      paymentMethod: order.payment_method,
      tradeTicketId: order.trade_ticket_id,
      status: order.status,
      keyCode: order.status === 'completed' ? keyCode : null
    };
    if (order.payment_method === 'crypto' && order.ltc_amount_sats) {
      const expired = !order.ltc_txid && new Date(order.ltc_expires_at.replace(' ', 'T') + 'Z') < new Date();
      Object.assign(out, {
        cryptoCurrency: 'LTC',
        cryptoAddress: order.crypto_address,
        ltcAmount: ltcPayments.satsToLtc(order.ltc_amount_sats),
        ltcRate: order.ltc_rate,
        expiresAt: new Date(order.ltc_expires_at.replace(' ', 'T') + 'Z').toISOString(),
        txid: order.ltc_txid,
        ltcReceived: ltcPayments.satsToLtc(order.ltc_received_sats || 0),
        confirmations: order.ltc_confirmations || 0,
        confirmationsRequired: ltcPayments.REQUIRED_CONFS,
        paymentState: order.status === 'completed' ? 'paid'
          : order.status === 'cancelled' ? 'cancelled'
          : order.ltc_txid ? 'confirming'
          : expired ? 'expired' : 'waiting'
      });
    }
    return out;
  }

  /**
   * Completes an order and automatically issues the active key
   */
  async completeOrder(orderId) {
    const order = await db.get(`SELECT * FROM orders WHERE order_id = ?`, [orderId]);
    if (!order) throw new Error('Order not found');
    if (completing.has(orderId)) throw new Error('Order is already being completed');
    if (order.status === 'completed') {
      // Already completed, return existing key
      const lic = await db.get(`SELECT * FROM licenses WHERE id = ?`, [order.license_id]);
      return { order, license: lic };
    }

    completing.add(orderId);
    let license;
    try {
      // Re-check inside the lock so two callers can't both issue a key
      const fresh = await db.get(`SELECT status FROM orders WHERE order_id = ?`, [orderId]);
      if (fresh.status === 'completed') {
        const done = await db.get(`SELECT * FROM orders WHERE order_id = ?`, [orderId]);
        return { order: done, license: await db.get(`SELECT * FROM licenses WHERE id = ?`, [done.license_id]) };
      }
      license = await keyService.issueKey(order.user_id, order.tier);

    // Update order status
    await db.run(
      `UPDATE orders 
       SET status = 'completed', license_id = ?, completed_at = CURRENT_TIMESTAMP 
       WHERE order_id = ?`,
      [license.licenseId, orderId]
    );
    } finally {
      completing.delete(orderId);
    }

    // Dispatch Discord Webhook sale alert
    const user = await db.get(`SELECT username FROM users WHERE id = ?`, [order.user_id]);
    discordNotification.notifySale({
      orderId: order.order_id,
      username: user ? user.username : `User #${order.user_id}`,
      tier: order.tier,
      amountUsd: order.amount_usd,
      paymentMethod: order.payment_method,
      keyCode: license.keyCode,
      expiresAt: license.expiresAt
    }).catch(() => {});

    return {
      orderId: order.order_id,
      status: 'completed',
      license
    };
  }

  /**
   * Retrieves order status by ID
   */
  async getOrder(orderId) {
    const order = await db.get(
      `SELECT o.*, l.key_code, l.expires_at as key_expires_at, u.username as buyer_username 
       FROM orders o 
       LEFT JOIN licenses l ON o.license_id = l.id
       JOIN users u ON o.user_id = u.id
       WHERE o.order_id = ?`,
      [orderId]
    );
    return order;
  }
}

module.exports = new PaymentService();

