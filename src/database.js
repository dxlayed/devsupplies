const sqlite3 = require('sqlite3').verbose();
const path = require('path');

// On Railway, DB_PATH points at the Volume (e.g. /data/waurks.db) so data survives redeploys
const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'waurks.db');
try { require('fs').mkdirSync(path.dirname(dbPath), { recursive: true }); } catch (e) {}
console.log('[db] using', dbPath);
const db = new sqlite3.Database(dbPath);

db.serialize(() => {
  // Users table (tied to Discord)
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      discord_id TEXT UNIQUE NOT NULL,
      username TEXT NOT NULL,
      discriminator TEXT DEFAULT '0',
      avatar TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Licenses / Keys table
  db.run(`
    CREATE TABLE IF NOT EXISTS licenses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key_code TEXT UNIQUE NOT NULL,
      user_id INTEGER NOT NULL,
      tier TEXT NOT NULL CHECK(tier IN ('weekly', 'monthly', 'yearly')),
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'expired', 'revoked')),
      hwid_binding TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      expires_at DATETIME NOT NULL,
      last_used_at DATETIME,
      total_streams_recorded INTEGER DEFAULT 0,
      FOREIGN KEY(user_id) REFERENCES users(id)
    )
  `);

  // Orders / Transactions table
  db.run(`
    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id TEXT UNIQUE NOT NULL,
      user_id INTEGER NOT NULL,
      tier TEXT NOT NULL CHECK(tier IN ('weekly', 'monthly', 'yearly')),
      amount_usd REAL NOT NULL,
      payment_method TEXT NOT NULL CHECK(payment_method IN ('crypto', 'items')),
      crypto_currency TEXT,
      crypto_address TEXT,
      trade_ticket_id TEXT,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'completed', 'cancelled')),
      license_id INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      completed_at DATETIME,
      FOREIGN KEY(user_id) REFERENCES users(id),
      FOREIGN KEY(license_id) REFERENCES licenses(id)
    )
  `);

  // TikTok Live Stream Recordings
  db.run(`
    CREATE TABLE IF NOT EXISTS recordings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      username TEXT NOT NULL,
      title TEXT,
      filename TEXT NOT NULL,
      file_path TEXT NOT NULL,
      file_size_bytes INTEGER DEFAULT 0,
      duration_seconds INTEGER DEFAULT 0,
      thumbnail_url TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(user_id) REFERENCES users(id)
    )
  `);

  // Site settings table
  db.run(`
    CREATE TABLE IF NOT EXISTS site_settings (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Audit logs
  db.run(`
    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      license_id INTEGER,
      action TEXT NOT NULL,
      details TEXT,
      ip_address TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
});

// Helper promises for clean async/await
const dbAsync = {
  get: (sql, params = []) => new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
  }),
  all: (sql, params = []) => new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
  }),
  run: (sql, params = []) => new Promise((resolve, reject) => {
    db.run(sql, params, function(err) {
      if (err) return reject(err);
      resolve({ lastID: this.lastID, changes: this.changes });
    });
  }),
  db
};

module.exports = dbAsync;
