// Owner panel: stats, products, stock, users, orders, deposits. Every route here is owner only.
const express = require('express');
const { db, transaction, cents, PRODUCT_SELECT, productRow } = require('./database');
const { needsOwner } = require('./auth');

const router = express.Router();
router.use('/owner', needsOwner);

router.get('/owner/stats', (req, res) => {
  res.json({
    revenue:   db.prepare("SELECT COALESCE(SUM(price),0) AS v FROM orders WHERE status!='cancelled'").get().v,
    orders:    db.prepare('SELECT COUNT(*) AS v FROM orders').get().v,
    users:     db.prepare('SELECT COUNT(*) AS v FROM users').get().v,
    deposited: db.prepare("SELECT COALESCE(SUM(usd),0) AS v FROM deposits WHERE status='credited'").get().v,
  });
});

// Products
router.get('/owner/products', (req, res) => {
  res.json(db.prepare(`${PRODUCT_SELECT} ORDER BY p.rowid`).all().map(productRow));
});

router.patch('/owner/products/:id', (req, res) => {
  const p = db.prepare('SELECT * FROM products WHERE id=?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Not found.' });
  const { price, coming, active, name, description } = req.body;
  const newPrice = parseFloat(price);
  db.prepare('UPDATE products SET price=@price, coming=@coming, active=@active, name=@name, description=@description WHERE id=@id').run({
    price:       price !== undefined && Number.isFinite(newPrice) && newPrice >= 0 ? cents(newPrice) : p.price,
    coming:      coming      !== undefined ? (coming ? 1 : 0) : p.coming,
    active:      active      !== undefined ? (active ? 1 : 0) : p.active,
    name:        name        !== undefined ? String(name) : p.name,
    description: description !== undefined ? String(description) : p.description,
    id: p.id,
  });
  res.json({ ok: true });
});

// Stock: real accounts, one per line. Each line goes to one buyer.
router.get('/owner/stock/:productId', (req, res) => {
  res.json(db.prepare('SELECT id, content, added FROM inventory WHERE product_id=? AND sold=0 ORDER BY id').all(req.params.productId));
});

router.post('/owner/stock/:productId', (req, res) => {
  if (!db.prepare('SELECT 1 FROM products WHERE id=?').get(req.params.productId)) return res.status(404).json({ error: 'Not found.' });
  const lines = String(req.body.items || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (!lines.length) return res.status(400).json({ error: 'Paste at least one account, one per line.' });
  const insert = db.prepare('INSERT INTO inventory (product_id, content) VALUES (?,?)');
  transaction(() => lines.forEach(line => insert.run(req.params.productId, line)));
  res.json({ ok: true, added: lines.length });
});

router.delete('/owner/stock/item/:id', (req, res) => {
  const r = db.prepare('DELETE FROM inventory WHERE id=? AND sold=0').run(req.params.id);
  if (!r.changes) return res.status(404).json({ error: 'Not found or already sold.' });
  res.json({ ok: true });
});

// Users
router.get('/owner/users', (req, res) => {
  res.json(db.prepare('SELECT id,username,role,balance,joined FROM users ORDER BY id').all());
});

router.patch('/owner/users/:id', (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id);
  if (!u) return res.status(404).json({ error: 'Not found.' });
  if (u.role === 'owner' && req.body.role && req.body.role !== 'owner' && u.id === req.session.user.id)
    return res.status(400).json({ error: 'You cannot remove your own owner role.' });
  const balance = parseFloat(req.body.balance);
  db.prepare('UPDATE users SET balance=?, role=? WHERE id=?').run(
    req.body.balance !== undefined && Number.isFinite(balance) ? cents(balance) : u.balance,
    ['user', 'owner'].includes(req.body.role) ? req.body.role : u.role,
    u.id
  );
  res.json({ ok: true });
});

// Orders. Cancelling refunds the buyer; un-cancelling charges them again.
router.get('/owner/orders', (req, res) => {
  res.json(db.prepare(`
    SELECT o.id, u.username, p.name AS product, o.price, o.status, o.created, o.delivered AS content
    FROM orders o JOIN users u ON u.id=o.user_id JOIN products p ON p.id=o.product_id
    ORDER BY o.id DESC LIMIT 200
  `).all());
});

router.patch('/owner/orders/:id', (req, res) => {
  const { status } = req.body;
  if (!['pending', 'delivered', 'cancelled'].includes(status)) return res.status(400).json({ error: 'Invalid status.' });
  const o = db.prepare('SELECT * FROM orders WHERE id=?').get(req.params.id);
  if (!o) return res.status(404).json({ error: 'Not found.' });
  transaction(() => {
    if (o.status !== 'cancelled' && status === 'cancelled') db.prepare('UPDATE users SET balance=round(balance+?,2) WHERE id=?').run(o.price, o.user_id);
    if (o.status === 'cancelled' && status !== 'cancelled') db.prepare('UPDATE users SET balance=round(balance-?,2) WHERE id=?').run(o.price, o.user_id);
    db.prepare('UPDATE orders SET status=? WHERE id=?').run(status, o.id);
  });
  res.json({ ok: true });
});

// Deposits
router.get('/owner/deposits', (req, res) => {
  res.json(db.prepare(`
    SELECT d.id, u.username, d.txid, d.litoshis, d.usd, d.status, d.created
    FROM deposits d JOIN users u ON u.id=d.user_id
    ORDER BY d.id DESC LIMIT 200
  `).all());
});

module.exports = { router };
