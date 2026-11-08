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
      total_requests_filtered INTEGER DEFAULT 0,
      total_bots_blocked INTEGER DEFAULT 0,
      total_players_accepted INTEGER DEFAULT 0,
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

  // Global bot blacklist (Known bot networks, spam patterns, flagged accounts)
  db.run(`
    CREATE TABLE IF NOT EXISTS global_bot_blacklist (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      roblox_user_id TEXT UNIQUE,
      username_pattern TEXT,
      reason TEXT,
      added_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Connected Roblox Accounts table (Runs 24/7 in the cloud)
  db.run(`
    CREATE TABLE IF NOT EXISTS roblox_accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      license_id INTEGER,
      roblox_id TEXT NOT NULL,
      roblox_username TEXT NOT NULL,
      avatar_url TEXT,
      encrypted_cookie TEXT NOT NULL,
      cookie_iv TEXT NOT NULL,
      is_active INTEGER DEFAULT 1,
      auto_decline_bots INTEGER DEFAULT 1,
      auto_accept_players INTEGER DEFAULT 1,
      hold_review INTEGER DEFAULT 1,
      last_scan_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(user_id) REFERENCES users(id),
      FOREIGN KEY(license_id) REFERENCES licenses(id)
    )
  `);

  // Live Cloud Sorter Activity Logs
  db.run(`
    CREATE TABLE IF NOT EXISTS scan_activity_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      roblox_id TEXT NOT NULL,
      target_id TEXT NOT NULL,
      target_username TEXT NOT NULL,
      verdict TEXT NOT NULL CHECK(verdict IN ('DECLINE', 'ACCEPT', 'REVIEW')),
      threat_score INTEGER NOT NULL,
      reason TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(user_id) REFERENCES users(id)
    )
  `);

  // Pending Review Queue for Borderline Requests
  db.run(`
    CREATE TABLE IF NOT EXISTS review_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      roblox_id TEXT NOT NULL,
      target_id TEXT NOT NULL,
      target_username TEXT NOT NULL,
      target_display_name TEXT,
      target_avatar TEXT,
      threat_score INTEGER NOT NULL,
      reasons TEXT,
      account_age_days INTEGER,
      badge_count INTEGER,
      status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'accepted', 'declined')),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(user_id) REFERENCES users(id)
    )
  `);

  // Column auto-migrations for custom filters
  db.all(`PRAGMA table_info(roblox_accounts)`, (err, cols) => {
    if (!err && cols) {
      const colNames = cols.map(c => c.name);
      if (!colNames.includes('min_account_age_days')) {
        db.run(`ALTER TABLE roblox_accounts ADD COLUMN min_account_age_days INTEGER DEFAULT 7`);
      }
      if (!colNames.includes('min_badges')) {
        db.run(`ALTER TABLE roblox_accounts ADD COLUMN min_badges INTEGER DEFAULT 0`);
      }
      if (!colNames.includes('custom_blacklist')) {
        db.run(`ALTER TABLE roblox_accounts ADD COLUMN custom_blacklist TEXT DEFAULT ''`);
      }
      if (!colNames.includes('custom_whitelist')) {
        db.run(`ALTER TABLE roblox_accounts ADD COLUMN custom_whitelist TEXT DEFAULT ''`);
      }
    }
  });

  // Audit and security access logs
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

  // Seed sample known botnet patterns into blacklist if empty
  db.get(`SELECT COUNT(*) as count FROM global_bot_blacklist`, (err, row) => {
    if (!err && row && row.count === 0) {
      const stmt = db.prepare(`INSERT INTO global_bot_blacklist (username_pattern, reason) VALUES (?, ?)`);
      stmt.run('^CLAIM_NOW_.*', 'Scam claim botnet');
      stmt.run('.*giftcard\\.gg.*', 'Phishing giftcard domain spammer');
      stmt.run('^FreeRobux_.*', 'Phishing generator account');
      stmt.run('^rbx_free_.*', 'Robux generator bot');
      stmt.finalize();
    }
  });
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

