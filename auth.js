// Accounts: sign up, log in, log out, and the guards that protect pages and API routes.
const express = require('express');
const bcrypt = require('bcryptjs');
const { db, freshUser } = require('./database');

const router = express.Router();

// Whoever signs up with this username becomes the owner
const OWNER_USERNAME = (process.env.OWNER_USERNAME || 'devsupplies').toLowerCase();

// Guards for API routes (answer with an error)
const needsLogin = (req, res, next) => req.session.user ? next() : res.status(401).json({ error: 'Login required.' });
const needsOwner = (req, res, next) => req.session.user?.role === 'owner' ? next() : res.status(403).json({ error: 'Owner only.' });

// Guards for pages (send the visitor somewhere sensible instead)
const pageNeedsLogin = (req, res, next) => req.session.user ? next() : res.redirect('/login?next=' + encodeURIComponent(req.path.replace(/\.html$/, '')));
const pageNeedsOwner = (req, res, next) => req.session.user?.role === 'owner' ? next() : res.redirect(req.session.user ? '/' : '/login?next=/owner');
const pageGuestsOnly = (req, res, next) => req.session.user ? res.redirect('/') : next();

router.post('/signup', async (req, res) => {
  try {
    const { username, password } = req.body;
    const name = (username || '').trim().toLowerCase();
    if (name.length < 3 || name.length > 24) return res.status(400).json({ error: 'Username must be 3 to 24 characters.' });
    if (!/^[a-z0-9_]+$/.test(name))          return res.status(400).json({ error: 'Letters, numbers and underscores only.' });
    if ((password || '').length < 6)         return res.status(400).json({ error: 'Password must be at least 6 characters.' });
    if (db.prepare('SELECT id FROM users WHERE username=?').get(name)) return res.status(400).json({ error: 'Username taken.' });

    const hash = await bcrypt.hash(password, 10);
    const role = name === OWNER_USERNAME ? 'owner' : 'user';
    const { lastInsertRowid } = db.prepare('INSERT INTO users (username,password,role) VALUES (?,?,?)').run(name, hash, role);
    req.session.user = { id: Number(lastInsertRowid), username: name, role, balance: 0 };
    res.json({ user: req.session.user });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error.' }); }
});

router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const name = (username || '').trim().toLowerCase();
    const row = db.prepare('SELECT * FROM users WHERE username=?').get(name);
    if (!row || !(await bcrypt.compare(password || '', row.password))) return res.status(401).json({ error: 'Wrong username or password.' });
    req.session.user = { id: row.id, username: row.username, role: row.role, balance: row.balance };
    res.json({ user: req.session.user });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error.' }); }
});

router.post('/logout', (req, res) => req.session.destroy(() => res.json({ ok: true })));

router.get('/me', (req, res) => {
  if (!req.session.user) return res.json({ user: null });
  const row = freshUser(req.session.user.id);
  req.session.user = row ? { ...row } : null;
  res.json({ user: req.session.user });
});

module.exports = { router, needsLogin, needsOwner, pageNeedsLogin, pageNeedsOwner, pageGuestsOnly };
