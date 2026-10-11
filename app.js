const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// ── Database (built into Node, nothing to compile) ────────────
// On Railway, attach a Volume and the data survives redeploys.
const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'store.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL COLLATE NOCASE,
    password TEXT NOT NULL,
    role     TEXT NOT NULL DEFAULT 'user',
    balance  REAL NOT NULL DEFAULT 0,
    joined   TEXT NOT NULL DEFAULT (date('now'))
  );
  CREATE TABLE IF NOT EXISTS products (
    id          TEXT PRIMARY KEY,
    code        TEXT NOT NULL,
    region      TEXT NOT NULL,
    name        TEXT NOT NULL,
    description TEXT NOT NULL,
    tags        TEXT NOT NULL DEFAULT '[]',
    price       REAL NOT NULL,
    stock       INTEGER NOT NULL DEFAULT 0,
    coming      INTEGER NOT NULL DEFAULT 0,
    img_type    TEXT NOT NULL DEFAULT 'live',
    active      INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS orders (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id),
    product_id TEXT NOT NULL REFERENCES products(id),
    price      REAL NOT NULL,
    status     TEXT NOT NULL DEFAULT 'pending',
    created    TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS sessions (
    sid     TEXT PRIMARY KEY,
    data    TEXT NOT NULL,
    expires INTEGER NOT NULL
  );
`);

function transaction(fn) {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}

// Seed products on first run
if (!db.prepare('SELECT 1 FROM products LIMIT 1').get()) {
  const ins = db.prepare(`INSERT INTO products (id,code,region,name,description,tags,price,stock,coming,img_type)
                          VALUES (@id,@code,@region,@name,@description,@tags,@price,@stock,@coming,@img_type)`);
  transaction(() => [
    { id:'us-live',   code:'US', region:'United States',  name:'TikTok US — Live Access',               description:'Aged US account with live streaming fully enabled. OTP-free login, instant handoff.',   tags:JSON.stringify(['live access','us region','aged','otp-free']),   price:24.99, stock:7, coming:0, img_type:'live'   },
    { id:'us-studio', code:'US', region:'United States',  name:'TikTok US — Live Studio + Live Access', description:'Full live studio access with live streaming enabled. Stream with full production tools.', tags:JSON.stringify(['live studio','live access','us region','aged']), price:39.99, stock:5, coming:1, img_type:'studio' },
    { id:'uk-live',   code:'UK', region:'United Kingdom', name:'TikTok UK — Live Access',               description:'UK-registered account with live streaming activated. Clean history, clean login.',        tags:JSON.stringify(['live access','uk region','aged','clean']),      price:22.99, stock:5, coming:0, img_type:'live'   },
    { id:'uk-studio', code:'UK', region:'United Kingdom', name:'TikTok UK — Live Studio + Live Access', description:'Full live studio access with live streaming enabled for UK region.',                    tags:JSON.stringify(['live studio','live access','uk region','aged']), price:37.99, stock:3, coming:1, img_type:'studio' },
  ].forEach(r => ins.run(r)));
}

// ── Session store (saved in the same database) ────────────────
class DbStore extends session.Store {
  get(sid, cb) {
    try {
      const row = db.prepare('SELECT data, expires FROM sessions WHERE sid=?').get(sid);
      if (!row || row.expires < Date.now()) return cb(null, null);
      cb(null, JSON.parse(row.data));
    } catch (e) { cb(e); }
  }
  set(sid, sess, cb) {
    try {
      const expires = sess.cookie?.expires ? new Date(sess.cookie.expires).getTime() : Date.now() + 864e5;
      db.prepare('INSERT OR REPLACE INTO sessions (sid,data,expires) VALUES (?,?,?)').run(sid, JSON.stringify(sess), expires);
      cb && cb(null);
    } catch (e) { cb && cb(e); }
  }
  destroy(sid, cb) {
    try { db.prepare('DELETE FROM sessions WHERE sid=?').run(sid); cb && cb(null); }
    catch (e) { cb && cb(e); }
  }
  touch(sid, sess, cb) { this.set(sid, sess, cb); }
}
setInterval(() => db.prepare('DELETE FROM sessions WHERE expires < ?').run(Date.now()), 36e5).unref();

// ── Middleware ────────────────────────────────────────────────
app.set('trust proxy', 1); // Railway sits behind a proxy; needed for secure cookies
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  store: new DbStore(),
  secret: process.env.SESSION_SECRET || 'change-this-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 7 * 24 * 60 * 60 * 1000 }
}));

const needsLogin = (req, res, next) => req.session.user ? next() : res.status(401).json({ error: 'Login required.' });
const needsOwner = (req, res, next) => req.session.user?.role === 'owner' ? next() : res.status(403).json({ error: 'Owner only.' });

// ── Auth ──────────────────────────────────────────────────────
app.post('/api/signup', async (req, res) => {
  try {
    const { username, password } = req.body;
    const u = (username || '').trim().toLowerCase();
    if (u.length < 3)                return res.status(400).json({ error: 'Username too short.' });
    if (!/^[a-z0-9_]+$/.test(u))     return res.status(400).json({ error: 'Letters, numbers and underscores only.' });
    if ((password || '').length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
    if (db.prepare('SELECT id FROM users WHERE username=?').get(u)) return res.status(400).json({ error: 'Username taken.' });
    const hash = await bcrypt.hash(password, 10);
    const role = u === 'devsupplies' ? 'owner' : 'user';
    const { lastInsertRowid } = db.prepare('INSERT INTO users (username,password,role) VALUES (?,?,?)').run(u, hash, role);
    req.session.user = { id: Number(lastInsertRowid), username: u, role, balance: 0 };
    res.json({ user: req.session.user });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error.' }); }
});

app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const u = (username || '').trim().toLowerCase();
    const row = db.prepare('SELECT * FROM users WHERE username=?').get(u);
    if (!row || !(await bcrypt.compare(password || '', row.password))) return res.status(401).json({ error: 'Wrong username or password.' });
    req.session.user = { id: row.id, username: row.username, role: row.role, balance: row.balance };
    res.json({ user: req.session.user });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error.' }); }
});

app.post('/api/logout', (req, res) => req.session.destroy(() => res.json({ ok: true })));

app.get('/api/me', (req, res) => {
  if (!req.session.user) return res.json({ user: null });
  const row = db.prepare('SELECT id,username,role,balance FROM users WHERE id=?').get(req.session.user.id);
  req.session.user = row ? { ...row } : null;
  res.json({ user: req.session.user });
});

// ── Products & buying ─────────────────────────────────────────
app.get('/api/products', (req, res) => {
  const rows = db.prepare('SELECT * FROM products WHERE active=1 ORDER BY rowid').all();
  res.json(rows.map(r => ({ ...r, tags: JSON.parse(r.tags), coming: !!r.coming })));
});

app.post('/api/buy', needsLogin, (req, res) => {
  try {
    const result = transaction(() => {
      const p = db.prepare('SELECT * FROM products WHERE id=? AND active=1').get(req.body.productId);
      if (!p)           return { code: 404, error: 'Product not found.' };
      if (p.coming)     return { code: 400, error: 'Not available yet.' };
      if (p.stock <= 0) return { code: 400, error: 'Out of stock.' };
      const user = db.prepare('SELECT balance FROM users WHERE id=?').get(req.session.user.id);
      if (!user)        return { code: 401, error: 'Login required.' };
      if (user.balance < p.price) return { code: 400, error: `Not enough balance. You have $${user.balance.toFixed(2)}.` };
      db.prepare('UPDATE products SET stock=stock-1 WHERE id=?').run(p.id);
      db.prepare('UPDATE users SET balance=balance-? WHERE id=?').run(p.price, req.session.user.id);
      db.prepare('INSERT INTO orders (user_id,product_id,price) VALUES (?,?,?)').run(req.session.user.id, p.id, p.price);
      return { ok: true };
    });
    if (result.error) return res.status(result.code).json({ error: result.error });
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error.' }); }
});

// ── Owner ─────────────────────────────────────────────────────
app.get('/api/owner/stats', needsOwner, (req, res) => {
  res.json({
    revenue:  db.prepare("SELECT COALESCE(SUM(price),0) AS v FROM orders WHERE status!='cancelled'").get().v,
    orders:   db.prepare('SELECT COUNT(*) AS v FROM orders').get().v,
    users:    db.prepare('SELECT COUNT(*) AS v FROM users').get().v,
    products: db.prepare('SELECT COUNT(*) AS v FROM products WHERE active=1').get().v,
  });
});

app.get('/api/owner/products', needsOwner, (req, res) => {
  const rows = db.prepare('SELECT * FROM products ORDER BY rowid').all();
  res.json(rows.map(r => ({ ...r, tags: JSON.parse(r.tags), coming: !!r.coming, active: !!r.active })));
});

app.patch('/api/owner/products/:id', needsOwner, (req, res) => {
  const p = db.prepare('SELECT * FROM products WHERE id=?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Not found.' });
  const { price, stock, coming, active, name, description } = req.body;
  const num = (v, fallback, parse) => { const n = parse(v); return Number.isFinite(n) && n >= 0 ? n : fallback; };
  db.prepare(`UPDATE products SET price=@price, stock=@stock, coming=@coming, active=@active, name=@name, description=@description WHERE id=@id`).run({
    price:       price       !== undefined ? num(price, p.price, parseFloat) : p.price,
    stock:       stock       !== undefined ? num(stock, p.stock, v => parseInt(v, 10)) : p.stock,
    coming:      coming      !== undefined ? (coming ? 1 : 0) : p.coming,
    active:      active      !== undefined ? (active ? 1 : 0) : p.active,
    name:        name        !== undefined ? String(name) : p.name,
    description: description !== undefined ? String(description) : p.description,
    id: p.id,
  });
  res.json({ ok: true });
});

app.get('/api/owner/users', needsOwner, (req, res) => {
  res.json(db.prepare('SELECT id,username,role,balance,joined FROM users ORDER BY id').all());
});

app.patch('/api/owner/users/:id', needsOwner, (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id);
  if (!u) return res.status(404).json({ error: 'Not found.' });
  if (u.username === 'devsupplies' && req.body.role && req.body.role !== 'owner')
    return res.status(400).json({ error: 'Cannot demote owner account.' });
  const bal = parseFloat(req.body.balance);
  db.prepare('UPDATE users SET balance=?, role=? WHERE id=?').run(
    req.body.balance !== undefined && Number.isFinite(bal) ? bal : u.balance,
    ['user', 'owner'].includes(req.body.role) ? req.body.role : u.role,
    u.id
  );
  res.json({ ok: true });
});

app.get('/api/owner/orders', needsOwner, (req, res) => {
  res.json(db.prepare(`
    SELECT o.id, u.username, p.name AS product, o.price, o.status, o.created
    FROM orders o
    JOIN users u ON u.id = o.user_id
    JOIN products p ON p.id = o.product_id
    ORDER BY o.id DESC
  `).all());
});

app.patch('/api/owner/orders/:id', needsOwner, (req, res) => {
  const { status } = req.body;
  if (!['pending', 'delivered', 'cancelled'].includes(status)) return res.status(400).json({ error: 'Invalid status.' });
  db.prepare('UPDATE orders SET status=? WHERE id=?').run(status, req.params.id);
  res.json({ ok: true });
});

// ── Everything else → the store page ──────────────────────────
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => console.log(`DevSupplies running on port ${PORT}`));
