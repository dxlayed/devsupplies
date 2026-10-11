// Database: tables, first-run products, and small helpers used everywhere.
// Uses the SQLite that is built into Node, so nothing needs compiling.
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

// On Railway, attach a Volume and this folder survives redeploys.
const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || process.env.DATA_DIR || path.join(__dirname, 'data');
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
  CREATE TABLE IF NOT EXISTS inventory (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id TEXT NOT NULL REFERENCES products(id),
    content    TEXT NOT NULL,
    sold       INTEGER NOT NULL DEFAULT 0,
    order_id   INTEGER,
    added      TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS deposits (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id),
    address    TEXT NOT NULL,
    txid       TEXT NOT NULL,
    vout       INTEGER NOT NULL,
    litoshis   INTEGER NOT NULL,
    usd        REAL,
    rate       REAL,
    status     TEXT NOT NULL DEFAULT 'pending',
    created    TEXT NOT NULL DEFAULT (datetime('now')),
    credited   TEXT,
    UNIQUE(txid, vout)
  );
  CREATE TABLE IF NOT EXISTS deals (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    price       REAL NOT NULL,
    content     TEXT NOT NULL,
    image       BLOB,
    image_type  TEXT,
    status      TEXT NOT NULL DEFAULT 'active',
    order_id    INTEGER,
    updated     INTEGER NOT NULL DEFAULT 0,
    created     TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS deal_images (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    deal_id    INTEGER NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
    image      BLOB NOT NULL,
    image_type TEXT NOT NULL,
    position   INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    sid     TEXT PRIMARY KEY,
    data    TEXT NOT NULL,
    expires INTEGER NOT NULL
  );
`);

// Add columns that older versions of the store did not have
function addColumn(table, column, def) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`);
}
addColumn('users', 'ltc_index', 'INTEGER');
addColumn('users', 'ltc_address', 'TEXT');
addColumn('users', 'watch_until', 'INTEGER NOT NULL DEFAULT 0');
addColumn('orders', 'delivered', 'TEXT');
addColumn('orders', 'title', 'TEXT');   // name shown for the order (used by deals)
addColumn('orders', 'deal_id', 'INTEGER');
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS users_ltc_index ON users(ltc_index)');
db.exec('CREATE INDEX IF NOT EXISTS inventory_product ON inventory(product_id, sold)');

function transaction(fn) {
  db.exec('BEGIN');
  try { const result = fn(); db.exec('COMMIT'); return result; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}

const cents = n => Math.round(n * 100) / 100;
const getSetting = (key, fallback) => db.prepare('SELECT value FROM settings WHERE key=?').get(key)?.value ?? fallback;
const setSetting = (key, value) => db.prepare('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)').run(key, String(value));
const freshUser = id => db.prepare('SELECT id,username,role,balance FROM users WHERE id=?').get(id);

// Stock is the number of real, unsold accounts loaded for a product
const PRODUCT_SELECT = `SELECT p.*, (SELECT COUNT(*) FROM inventory i WHERE i.product_id=p.id AND i.sold=0) AS stock FROM products p`;
const productRow = r => ({ ...r, tags: JSON.parse(r.tags), coming: !!r.coming, active: !!r.active });

// First run: create the four products (stock starts empty, add accounts in the owner panel)
if (!db.prepare('SELECT 1 FROM products LIMIT 1').get()) {
  const insert = db.prepare(`INSERT INTO products (id,code,region,name,description,tags,price,coming,img_type)
                             VALUES (@id,@code,@region,@name,@description,@tags,@price,@coming,@img_type)`);
  transaction(() => [
    { id:'us-live',   code:'US', region:'United States',  name:'TikTok US — Live Access',               description:'Aged US account with live streaming fully enabled. OTP-free login, instant handoff.',   tags:JSON.stringify(['live access','us region','aged','otp-free']),   price:24.99, coming:0, img_type:'live'   },
    { id:'us-studio', code:'US', region:'United States',  name:'TikTok US — Live Studio + Live Access', description:'Full live studio access with live streaming enabled. Stream with full production tools.', tags:JSON.stringify(['live studio','live access','us region','aged']), price:39.99, coming:1, img_type:'studio' },
    { id:'uk-live',   code:'UK', region:'United Kingdom', name:'TikTok UK — Live Access',               description:'UK-registered account with live streaming activated. Clean history, clean login.',        tags:JSON.stringify(['live access','uk region','aged','clean']),      price:22.99, coming:0, img_type:'live'   },
    { id:'uk-studio', code:'UK', region:'United Kingdom', name:'TikTok UK — Live Studio + Live Access', description:'Full live studio access with live streaming enabled for UK region.',                    tags:JSON.stringify(['live studio','live access','uk region','aged']), price:37.99, coming:1, img_type:'studio' },
  ].forEach(p => insert.run(p)));
}

db.exec('CREATE INDEX IF NOT EXISTS deal_images_deal ON deal_images(deal_id, position)');
// Move single photos from the older version of deals into the photos table
for (const d of db.prepare('SELECT id, image, image_type FROM deals WHERE image IS NOT NULL').all()) {
  transaction(() => {
    db.prepare('INSERT INTO deal_images (deal_id, image, image_type, position) VALUES (?,?,?,0)').run(d.id, d.image, d.image_type);
    db.prepare('UPDATE deals SET image=NULL, image_type=NULL WHERE id=?').run(d.id);
  });
}

// Hidden placeholder product that deal orders point to (never shown anywhere)
db.prepare(`INSERT OR IGNORE INTO products (id,code,region,name,description,price,coming,active) VALUES ('deal','DEAL','Deal','Deal','One-off deal',0,0,0)`).run();

module.exports = { db, transaction, cents, getSetting, setSetting, freshUser, PRODUCT_SELECT, productRow };
