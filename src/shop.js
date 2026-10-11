// The store: product list, buying, and a customer's own orders.
const express = require('express');
const { db, transaction, freshUser, PRODUCT_SELECT, productRow } = require('./database');
const { needsLogin } = require('./auth');

const router = express.Router();

router.get('/products', (req, res) => {
  res.json(db.prepare(`${PRODUCT_SELECT} WHERE p.active=1 ORDER BY p.rowid`).all().map(productRow));
});

// Buying takes the price from the balance and hands over the next account in stock
router.post('/buy', needsLogin, (req, res) => {
  try {
    const userId = req.session.user.id;
    const result = transaction(() => {
      const product = db.prepare('SELECT * FROM products WHERE id=? AND active=1').get(req.body.productId);
      if (!product)       return { code: 404, error: 'Product not found.' };
      if (product.coming) return { code: 400, error: 'Not available yet.' };

      const item = db.prepare('SELECT * FROM inventory WHERE product_id=? AND sold=0 ORDER BY id LIMIT 1').get(product.id);
      if (!item) return { code: 400, error: 'Out of stock.' };

      const user = db.prepare('SELECT balance FROM users WHERE id=?').get(userId);
      if (!user) return { code: 401, error: 'Login required.' };
      if (user.balance + 1e-9 < product.price) return { code: 400, error: `Not enough balance. You have $${user.balance.toFixed(2)}.` };

      const { lastInsertRowid } = db.prepare("INSERT INTO orders (user_id,product_id,price,status,delivered) VALUES (?,?,?,'delivered',?)")
        .run(userId, product.id, product.price, item.content);
      const orderId = Number(lastInsertRowid);
      db.prepare('UPDATE inventory SET sold=1, order_id=? WHERE id=?').run(orderId, item.id);
      db.prepare('UPDATE users SET balance=round(balance-?,2) WHERE id=?').run(product.price, userId);
      return { order: { id: orderId, product: product.name, price: product.price, content: item.content } };
    });
    if (result.error) return res.status(result.code).json({ error: result.error });
    res.json({ ok: true, order: result.order, user: freshUser(userId) });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error.' }); }
});

router.get('/orders', needsLogin, (req, res) => {
  res.json(db.prepare(`
    SELECT o.id, COALESCE(o.title, p.name) AS product, o.price, o.status, o.created, o.delivered AS content
    FROM orders o JOIN products p ON p.id=o.product_id
    WHERE o.user_id=? ORDER BY o.id DESC
  `).all(req.session.user.id));
});

module.exports = { router };
