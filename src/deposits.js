// Deposits: gives each customer their own LTC address and adds confirmed payments to their balance.
const express = require('express');
const { db, transaction, cents, getSetting, setSetting, freshUser } = require('./database');
const { needsLogin } = require('./auth');
const litecoin = require('./litecoin');

const router = express.Router();

// Give a customer their own address. Skips any address your wallet already used.
let queue = Promise.resolve();
function assignAddress(userId) {
  const job = queue.then(async () => {
    const existing = db.prepare('SELECT ltc_address FROM users WHERE id=?').get(userId);
    if (existing?.ltc_address) return existing.ltc_address;
    let index = parseInt(getSetting('ltc_next_index', '0'), 10);
    for (let tries = 0; tries < 25; tries++, index++) {
      if (db.prepare('SELECT 1 FROM users WHERE ltc_index=?').get(index)) continue;
      const addr = litecoin.address(index);
      if ((await litecoin.payments(addr)).length) continue;
      db.prepare('UPDATE users SET ltc_index=?, ltc_address=? WHERE id=?').run(index, addr, userId);
      setSetting('ltc_next_index', index + 1);
      return addr;
    }
    throw new Error('Could not find a free address.');
  });
  queue = job.catch(() => {});
  return job;
}

// Save new payments, and credit the ones with enough confirmations
const lastCheck = new Map();
async function checkUser(userId) {
  const user = db.prepare('SELECT id, ltc_address FROM users WHERE id=?').get(userId);
  if (!user?.ltc_address) return;
  if (Date.now() - (lastCheck.get(userId) || 0) < 15000) return; // at most every 15 seconds per customer
  lastCheck.set(userId, Date.now());

  const found = await litecoin.payments(user.ltc_address);
  const save = db.prepare('INSERT OR IGNORE INTO deposits (user_id,address,txid,vout,litoshis) VALUES (?,?,?,?,?)');
  for (const p of found) save.run(user.id, user.ltc_address, p.txid, p.vout, p.litoshis);

  const isPending = db.prepare("SELECT 1 FROM deposits WHERE txid=? AND vout=? AND status='pending'");
  const ready = found.filter(p => p.confirmations >= litecoin.CONFIRMATIONS && isPending.get(p.txid, p.vout));
  if (!ready.length) return;

  const rate = await litecoin.price();
  for (const p of ready) {
    transaction(() => {
      const usd = cents((p.litoshis / 1e8) * rate);
      const r = db.prepare("UPDATE deposits SET status='credited', usd=?, rate=?, credited=datetime('now') WHERE txid=? AND vout=? AND status='pending'")
        .run(usd, rate, p.txid, p.vout);
      if (r.changes === 1) db.prepare('UPDATE users SET balance=round(balance+?,2) WHERE id=?').run(usd, user.id);
    });
  }
}

// Every minute, check customers who opened the deposit page recently or have a payment confirming
function startWatcher() {
  setInterval(async () => {
    if (!litecoin.enabled()) return;
    const ids = db.prepare(`SELECT id FROM users WHERE ltc_address IS NOT NULL
      AND (watch_until > ? OR id IN (SELECT user_id FROM deposits WHERE status='pending'))`).all(Date.now()).map(r => r.id);
    for (const id of ids) {
      try { await checkUser(id); } catch (e) { console.error('Deposit check failed:', e.message); }
      await new Promise(r => setTimeout(r, 1500));
    }
  }, 60000).unref();
}

function summary(userId) {
  const u = db.prepare('SELECT ltc_address FROM users WHERE id=?').get(userId);
  return {
    address: u?.ltc_address || null,
    confirmations: litecoin.CONFIRMATIONS,
    rate: litecoin.lastPrice(),
    deposits: db.prepare('SELECT txid, litoshis, usd, status, created FROM deposits WHERE user_id=? ORDER BY id DESC LIMIT 20').all(userId),
    user: freshUser(userId),
  };
}

router.post('/deposit/open', needsLogin, async (req, res) => {
  if (!litecoin.enabled()) return res.status(503).json({ error: 'Deposits are not set up yet. Check back soon.' });
  try {
    const id = req.session.user.id;
    await assignAddress(id);
    db.prepare('UPDATE users SET watch_until=? WHERE id=?').run(Date.now() + 3 * 36e5, id);
    await litecoin.price().catch(() => {});
    checkUser(id).catch(() => {});
    res.json(summary(id));
  } catch (e) { console.error(e); res.status(503).json({ error: 'Deposits are busy right now. Try again in a minute.' }); }
});

router.post('/deposit/check', needsLogin, async (req, res) => {
  if (!litecoin.enabled()) return res.status(503).json({ error: 'Deposits are not set up yet.' });
  try { await checkUser(req.session.user.id); } catch (e) { console.error('Deposit check failed:', e.message); }
  res.json(summary(req.session.user.id));
});

module.exports = { router, startWatcher };
