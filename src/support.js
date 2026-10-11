// Support tickets. Customers describe the problem first (topic, order, transaction), then chat with the owner.
const express = require('express');
const { db, transaction } = require('./database');
const { needsLogin, needsOwner } = require('./auth');

const router = express.Router();

const TOPICS = {
  order: 'Problem with an order',
  login: "Account login isn't working",
  deposit: "Deposit hasn't shown up",
  question: 'Question before buying',
  other: 'Something else',
};
const MAX_OPEN = 5;
const MAX_LEN = 2000;

const clean = (s, max) => String(s || '').trim().slice(0, max);

// Full ticket with the context the owner needs
function ticketView(id, forOwner) {
  const t = db.prepare(`SELECT t.*, u.username, u.balance FROM tickets t JOIN users u ON u.id=t.user_id WHERE t.id=?`).get(id);
  if (!t) return null;
  const order = t.order_id ? db.prepare(`
    SELECT o.id, COALESCE(o.title, p.name) AS product, o.price, o.status, o.created ${forOwner ? ', o.delivered AS content' : ''}
    FROM orders o JOIN products p ON p.id=o.product_id WHERE o.id=?`).get(t.order_id) : null;
  return {
    id: t.id, topic: t.topic, topicLabel: TOPICS[t.topic] || t.topic, subject: t.subject, status: t.status,
    txid: t.txid, created: t.created, updated: t.updated, order,
    ...(forOwner ? { username: t.username, balance: t.balance, userId: t.user_id } : {}),
    messages: db.prepare('SELECT id, sender, body, created FROM ticket_messages WHERE ticket_id=? ORDER BY id').all(t.id),
  };
}

function addMessage(ticketId, sender, body) {
  transaction(() => {
    db.prepare('INSERT INTO ticket_messages (ticket_id, sender, body) VALUES (?,?,?)').run(ticketId, sender, body);
    db.prepare(`UPDATE tickets SET updated=datetime('now'), status='open',
      user_unread = CASE WHEN ? = 'owner' THEN user_unread + 1 ELSE user_unread END,
      owner_unread = CASE WHEN ? = 'user' THEN owner_unread + 1 ELSE owner_unread END
      WHERE id=?`).run(sender, sender, ticketId);
  });
}

// ── Customer ──────────────────────────────────────────────────
router.get('/support/topics', (req, res) => res.json(TOPICS));

router.get('/support', needsLogin, (req, res) => {
  res.json(db.prepare(`SELECT id, topic, subject, status, user_unread AS unread, updated FROM tickets WHERE user_id=? ORDER BY updated DESC`)
    .all(req.session.user.id).map(t => ({ ...t, topicLabel: TOPICS[t.topic] || t.topic })));
});

router.get('/support/unread', needsLogin, (req, res) => {
  const me = req.session.user;
  const mine = db.prepare('SELECT COALESCE(SUM(user_unread),0) AS n FROM tickets WHERE user_id=?').get(me.id).n;
  const owner = me.role === 'owner' ? db.prepare("SELECT COALESCE(SUM(owner_unread),0) AS n FROM tickets WHERE status='open'").get().n : 0;
  res.json({ unread: mine, owner });
});

router.post('/support', needsLogin, (req, res) => {
  const userId = req.session.user.id;
  const topic = String(req.body.topic || '');
  const subject = clean(req.body.subject, 120);
  const message = clean(req.body.message, MAX_LEN);
  const txid = clean(req.body.txid, 100) || null;
  const orderId = req.body.orderId ? parseInt(req.body.orderId, 10) : null;

  if (!TOPICS[topic]) return res.status(400).json({ error: 'Choose what your ticket is about.' });
  if (subject.length < 4) return res.status(400).json({ error: 'Add a short title, at least 4 characters.' });
  if (message.length < 10) return res.status(400).json({ error: 'Describe the problem in a bit more detail, at least 10 characters.' });
  if ((topic === 'order' || topic === 'login') && !orderId) return res.status(400).json({ error: 'Pick the order this is about.' });
  if (orderId && !db.prepare('SELECT 1 FROM orders WHERE id=? AND user_id=?').get(orderId, userId)) return res.status(400).json({ error: 'That order is not on your account.' });
  if (db.prepare("SELECT COUNT(*) AS n FROM tickets WHERE user_id=? AND status='open'").get(userId).n >= MAX_OPEN)
    return res.status(400).json({ error: `You have ${MAX_OPEN} open tickets. Reply in one of those, or close one first.` });

  const id = transaction(() => {
    const { lastInsertRowid } = db.prepare('INSERT INTO tickets (user_id, topic, subject, order_id, txid, owner_unread) VALUES (?,?,?,?,?,0)')
      .run(userId, topic, subject, orderId, txid);
    return Number(lastInsertRowid);
  });
  addMessage(id, 'user', message);
  res.json({ ok: true, id });
});

router.get('/support/:id', needsLogin, (req, res) => {
  const t = db.prepare('SELECT user_id FROM tickets WHERE id=?').get(req.params.id);
  if (!t || t.user_id !== req.session.user.id) return res.status(404).json({ error: 'Ticket not found.' });
  db.prepare('UPDATE tickets SET user_unread=0 WHERE id=?').run(req.params.id);
  res.json(ticketView(req.params.id, false));
});

router.post('/support/:id/messages', needsLogin, (req, res) => {
  const t = db.prepare('SELECT user_id FROM tickets WHERE id=?').get(req.params.id);
  if (!t || t.user_id !== req.session.user.id) return res.status(404).json({ error: 'Ticket not found.' });
  const body = clean(req.body.body, MAX_LEN);
  if (!body) return res.status(400).json({ error: 'Type a message first.' });
  addMessage(req.params.id, 'user', body);
  res.json(ticketView(req.params.id, false));
});

router.post('/support/:id/close', needsLogin, (req, res) => {
  const r = db.prepare("UPDATE tickets SET status='closed', updated=datetime('now') WHERE id=? AND user_id=?").run(req.params.id, req.session.user.id);
  if (!r.changes) return res.status(404).json({ error: 'Ticket not found.' });
  res.json(ticketView(req.params.id, false));
});

// ── Owner ─────────────────────────────────────────────────────
router.get('/owner/support', needsOwner, (req, res) => {
  res.json(db.prepare(`
    SELECT t.id, t.topic, t.subject, t.status, t.owner_unread AS unread, t.updated, u.username,
      (SELECT body FROM ticket_messages m WHERE m.ticket_id=t.id ORDER BY m.id DESC LIMIT 1) AS last,
      (SELECT sender FROM ticket_messages m WHERE m.ticket_id=t.id ORDER BY m.id DESC LIMIT 1) AS lastSender
    FROM tickets t JOIN users u ON u.id=t.user_id
    ORDER BY CASE t.status WHEN 'open' THEN 0 ELSE 1 END, t.updated DESC LIMIT 300
  `).all().map(t => ({ ...t, topicLabel: TOPICS[t.topic] || t.topic })));
});

router.get('/owner/support/:id', needsOwner, (req, res) => {
  if (!db.prepare('SELECT 1 FROM tickets WHERE id=?').get(req.params.id)) return res.status(404).json({ error: 'Ticket not found.' });
  db.prepare('UPDATE tickets SET owner_unread=0 WHERE id=?').run(req.params.id);
  res.json(ticketView(req.params.id, true));
});

router.post('/owner/support/:id/messages', needsOwner, (req, res) => {
  if (!db.prepare('SELECT 1 FROM tickets WHERE id=?').get(req.params.id)) return res.status(404).json({ error: 'Ticket not found.' });
  const body = clean(req.body.body, MAX_LEN);
  if (!body) return res.status(400).json({ error: 'Type a reply first.' });
  addMessage(req.params.id, 'owner', body);
  db.prepare('UPDATE tickets SET owner_unread=0 WHERE id=?').run(req.params.id);
  res.json(ticketView(req.params.id, true));
});

router.patch('/owner/support/:id', needsOwner, (req, res) => {
  const status = req.body.status === 'closed' ? 'closed' : 'open';
  const r = db.prepare("UPDATE tickets SET status=?, updated=datetime('now') WHERE id=?").run(status, req.params.id);
  if (!r.changes) return res.status(404).json({ error: 'Ticket not found.' });
  res.json(ticketView(req.params.id, true));
});

module.exports = { router };
