// Deposits: each customer has their own LTC address. They choose a USD amount, get an exact LTC
// amount locked at today's price for 30 minutes, and get exactly that USD once the payment confirms.
const express = require('express');
const { db, transaction, cents, getSetting, setSetting, freshUser } = require('./database');
const { needsLogin } = require('./auth');
const litecoin = require('./litecoin');

const router = express.Router();
const LOCK_MINUTES = 30;
const MIN_USD = 1, MAX_USD = 10000;

// The customer's live request (waiting for payment), after marking old ones as expired
function activeRequest(userId) {
  db.prepare("UPDATE deposit_requests SET status='expired' WHERE user_id=? AND status='waiting' AND expires < ?").run(userId, Date.now());
  return db.prepare("SELECT * FROM deposit_requests WHERE user_id=? AND status IN ('waiting','seen') ORDER BY id DESC LIMIT 1").get(userId) || null;
}
const ltcText = lit => (lit / 1e8).toFixed(8).replace(/0+$/, '').replace(/\.$/, '');

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
  for (const p of found) {
    const added = save.run(user.id, user.ltc_address, p.txid, p.vout, p.litoshis).changes === 1;
    // A new payment that arrives while a request is waiting is matched to it (and locks its price)
    if (added) {
      const req = db.prepare("SELECT id FROM deposit_requests WHERE user_id=? AND status='waiting' AND expires >= ? ORDER BY id DESC LIMIT 1").get(user.id, Date.now());
      if (req) transaction(() => {
        db.prepare('UPDATE deposits SET request_id=? WHERE txid=? AND vout=?').run(req.id, p.txid, p.vout);
        db.prepare("UPDATE deposit_requests SET status='seen' WHERE id=?").run(req.id);
      });
    }
  }

  const getPending = db.prepare("SELECT * FROM deposits WHERE txid=? AND vout=? AND status='pending'");
  const ready = found.filter(p => p.confirmations >= litecoin.CONFIRMATIONS).map(p => getPending.get(p.txid, p.vout)).filter(Boolean);
  if (!ready.length) return;

  const liveRate = ready.some(d => !d.request_id) ? await litecoin.price() : null;
  for (const d of ready) {
    transaction(() => {
      const req = d.request_id ? db.prepare('SELECT * FROM deposit_requests WHERE id=?').get(d.request_id) : null;
      let usd, rate;
      if (req) {
        // Locked price. Paying the exact amount (or more) gives exactly what they asked for, or more.
        rate = req.rate;
        usd = d.litoshis >= req.litoshis * 0.995 ? Math.max(req.usd, cents((d.litoshis / 1e8) * rate)) : cents((d.litoshis / 1e8) * rate);
      } else {
        rate = liveRate;
        usd = cents((d.litoshis / 1e8) * rate);
      }
      const r = db.prepare("UPDATE deposits SET status='credited', usd=?, rate=?, credited=datetime('now') WHERE id=? AND status='pending'").run(usd, rate, d.id);
      if (r.changes === 1) {
        db.prepare('UPDATE users SET balance=round(balance+?,2) WHERE id=?').run(usd, user.id);
        if (req) db.prepare("UPDATE deposit_requests SET status='paid' WHERE id=?").run(req.id);
      }
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
  const req = activeRequest(userId);
  return {
    address: u?.ltc_address || null,
    confirmations: litecoin.CONFIRMATIONS,
    rate: litecoin.lastPrice(),
    lockMinutes: LOCK_MINUTES,
    request: req && {
      id: req.id, usd: req.usd, ltc: ltcText(req.litoshis), rate: req.rate, status: req.status,
      expiresIn: Math.max(0, Math.round((req.expires - Date.now()) / 1000)),
      uri: `litecoin:${req.address}?amount=${ltcText(req.litoshis)}`,
    },
    deposits: db.prepare(`SELECT d.txid, d.litoshis, d.usd, d.status, d.created, r.usd AS asked
      FROM deposits d LEFT JOIN deposit_requests r ON r.id=d.request_id
      WHERE d.user_id=? ORDER BY d.id DESC LIMIT 20`).all(userId),
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

// Customer picks a USD amount; we lock an exact LTC amount for 30 minutes
router.post('/deposit/request', needsLogin, async (req, res) => {
  if (!litecoin.enabled()) return res.status(503).json({ error: 'Deposits are not set up yet.' });
  const usd = Math.round(parseFloat(req.body.usd) * 100) / 100;
  if (!Number.isFinite(usd) || usd < MIN_USD) return res.status(400).json({ error: `Enter at least $${MIN_USD}.` });
  if (usd > MAX_USD) return res.status(400).json({ error: `The most you can add at once is $${MAX_USD.toLocaleString()}.` });
  try {
    const id = req.session.user.id;
    const address = await assignAddress(id);
    const rate = await litecoin.price();
    // Round up to 0.00001 LTC so the amount is easy to type
    const litoshis = Math.ceil((usd / rate) * 1e8 / 1000) * 1000;
    transaction(() => {
      db.prepare("UPDATE deposit_requests SET status='cancelled' WHERE user_id=? AND status='waiting'").run(id);
      db.prepare('INSERT INTO deposit_requests (user_id, address, usd, litoshis, rate, expires) VALUES (?,?,?,?,?,?)')
        .run(id, address, usd, litoshis, rate, Date.now() + LOCK_MINUTES * 60000);
      db.prepare('UPDATE users SET watch_until=? WHERE id=?').run(Date.now() + 3 * 36e5, id);
    });
    res.json(summary(id));
  } catch (e) { console.error(e); res.status(503).json({ error: 'Could not get the LTC price right now. Try again in a minute.' }); }
});

router.post('/deposit/cancel', needsLogin, (req, res) => {
  db.prepare("UPDATE deposit_requests SET status='cancelled' WHERE user_id=? AND status='waiting'").run(req.session.user.id);
  res.json(summary(req.session.user.id));
});

router.post('/deposit/check', needsLogin, async (req, res) => {
  if (!litecoin.enabled()) return res.status(503).json({ error: 'Deposits are not set up yet.' });
  try { await checkUser(req.session.user.id); } catch (e) { console.error('Deposit check failed:', e.message); }
  res.json(summary(req.session.user.id));
});

module.exports = { router, startWatcher };
