const crypto = require('crypto');
const db = require('../database');
const { keyService, TIER_CONFIG } = require('./keyService');
const discordNotification = require('./discordNotification');

// Demo deposit wallet addresses for crypto display
const CRYPTO_WALLETS = {
  USDT: 'TYDzsYUEWv863p6p2hK14XqNmsY8vG7c1Q (TRC20)',
  USDC: '0x71C...4e8 (ERC20 / Polygon)',
  BTC: 'bc1q9w8z7y6x5w4v3u2t1s0r9q8p7o6n5m4l3k2j1',
  ETH: '0x89205A3A3b2A69De6Dbf7f01ED13B2108B2c43e7',
  SOL: '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM',
  LTC: 'LTC3w98v7u6t5s4r3q2p1o0n9m8l7k6j5h4g',
  TRX: 'TYDzsYUEWv863p6p2hK14XqNmsY8vG7c1Q',
  BNB: '0x71C...4e8 (BEP20)',
  DOGE: 'D8v9w8z7y6x5w4v3u2t1s0r9q8p7o6n5m'
};

class PaymentService {
  /**
   * Creates a new pending order
   */
  async createOrder({ userId, tier, paymentMethod, cryptoCurrency = 'USDT' }) {
    const config = TIER_CONFIG[tier];
    if (!config) throw new Error(`Invalid tier: ${tier}`);

    const orderId = `ORD-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
    const amountUsd = config.price;

    let tradeTicketId = null;
    let cryptoAddress = null;

    if (paymentMethod === 'crypto') {
      cryptoAddress = CRYPTO_WALLETS[cryptoCurrency] || CRYPTO_WALLETS.USDT;
    } else if (paymentMethod === 'items') {
      tradeTicketId = `TRADE-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
    }

    await db.run(
      `INSERT INTO orders (order_id, user_id, tier, amount_usd, payment_method, crypto_currency, crypto_address, trade_ticket_id, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
      [orderId, userId, tier, amountUsd, paymentMethod, cryptoCurrency, cryptoAddress, tradeTicketId]
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

    return {
      orderId,
      tier,
      tierName: config.name,
      amountUsd,
      paymentMethod,
      cryptoCurrency,
      cryptoAddress,
      tradeTicketId,
      status: 'pending'
    };
  }

  /**
   * Completes an order and automatically issues the active key
   */
  async completeOrder(orderId) {
    const order = await db.get(`SELECT * FROM orders WHERE order_id = ?`, [orderId]);
    if (!order) throw new Error('Order not found');
    if (order.status === 'completed') {
      // Already completed, return existing key
      const lic = await db.get(`SELECT * FROM licenses WHERE id = ?`, [order.license_id]);
      return { order, license: lic };
    }

    // Issue key
    const license = await keyService.issueKey(order.user_id, order.tier);

    // Update order status
    await db.run(
      `UPDATE orders 
       SET status = 'completed', license_id = ?, completed_at = CURRENT_TIMESTAMP 
       WHERE order_id = ?`,
      [license.licenseId, orderId]
    );

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

