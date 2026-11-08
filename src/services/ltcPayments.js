/**
 * Automatic Litecoin payments, paid straight into your own Electrum-LTC wallet.
 *
 * How it works:
 *  1. Each order gets its OWN fresh receiving address from your wallet's master
 *     PUBLIC key (zpub). The public key can only make addresses: it can't spend.
 *  2. The price in LTC is locked for 30 minutes.
 *  3. Every 30 seconds the server checks those addresses on a public block explorer
 *     (litecoinspace.org). When the payment has enough confirmations, the key is
 *     issued automatically.
 *
 * Settings (Railway variables / .env):
 *  LTC_XPUB               Electrum-LTC master public key (zpub..., Wallet > Information)
 *  LTC_CONFIRMATIONS      confirmations before the key is issued (default 1, ~2.5 min)
 *  LTC_QUOTE_MINUTES      how long the locked price lasts (default 30)
 */
const db = require('../database');
const { HDKey } = require('@scure/bip32');
const { bech32 } = require('@scure/base');
const { sha256 } = require('@noble/hashes/sha256');
const { ripemd160 } = require('@noble/hashes/ripemd160');

const XPUB = (process.env.LTC_XPUB || '').trim();
const REQUIRED_CONFS = Math.max(0, parseInt(process.env.LTC_CONFIRMATIONS || '1', 10) || 1);
const QUOTE_MINUTES = Math.max(5, parseInt(process.env.LTC_QUOTE_MINUTES || '30', 10) || 30);
const EXPLORER = 'https://litecoinspace.org/api';
const SATS = 100000000;
// Accept payments that arrive up to 1% short (some wallets/exchanges shave a little off)
const UNDERPAY_TOLERANCE = 0.99;

// Add the payment columns to the orders table (ignored if they already exist)
db.run(`ALTER TABLE orders ADD COLUMN ltc_amount_sats INTEGER`).catch(() => {});
db.run(`ALTER TABLE orders ADD COLUMN ltc_rate REAL`).catch(() => {});
db.run(`ALTER TABLE orders ADD COLUMN ltc_expires_at TEXT`).catch(() => {});
db.run(`ALTER TABLE orders ADD COLUMN ltc_txid TEXT`).catch(() => {});
db.run(`ALTER TABLE orders ADD COLUMN ltc_index INTEGER`).catch(() => {});
db.run(`ALTER TABLE orders ADD COLUMN ltc_received_sats INTEGER DEFAULT 0`).catch(() => {});
db.run(`ALTER TABLE orders ADD COLUMN ltc_confirmations INTEGER DEFAULT 0`).catch(() => {});

const state = { lastCheck: null, lastError: null, lastRate: null, lastRateAt: 0 };

// ---------- Address generation from the zpub ----------
let receiveChain = null;
try {
  if (XPUB) {
    // zpub = native SegWit (ltc1...) keys, the Electrum-LTC default
    const versions = XPUB.startsWith('zpub') ? { private: 0x04b2430c, public: 0x04b24746 }
      : XPUB.startsWith('Ltub') ? { private: 0x019d9cfe, public: 0x019da462 }
      : { private: 0x0488ade4, public: 0x0488b21e };
    receiveChain = HDKey.fromExtendedKey(XPUB, versions).deriveChild(0); // Electrum receiving chain
  }
} catch (e) {
  console.error('[ltc] LTC_XPUB is not a valid master public key:', e.message);
  receiveChain = null;
}

function isConfigured() {
  return !!receiveChain;
}

function addressAt(index) {
  const pub = receiveChain.deriveChild(index).publicKey;
  return bech32.encode('ltc', [0, ...bech32.toWords(ripemd160(sha256(pub)))]);
}

async function getJson(url) {
  const r = await fetch(url, { headers: { 'User-Agent': 'waurks-payments' }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`${new URL(url).host} answered ${r.status}`);
  return r.json();
}

// LTC price in USD, cached for 60 seconds. Two sources in case one is down.
async function getLtcUsd() {
  if (state.lastRate && Date.now() - state.lastRateAt < 60000) return state.lastRate;
  let rate = null;
  try {
    const d = await getJson('https://api.coingecko.com/api/v3/simple/price?ids=litecoin&vs_currencies=usd');
    rate = Number(d?.litecoin?.usd);
  } catch (e) { /* try the next source */ }
  if (!(rate > 0)) {
    const d = await getJson('https://api.kraken.com/0/public/Ticker?pair=LTCUSD');
    const first = d?.result && Object.values(d.result)[0];
    rate = Number(first?.c?.[0]);
  }
  if (!(rate > 0)) throw new Error('Could not get the LTC price right now. Try again in a minute.');
  state.lastRate = rate;
  state.lastRateAt = Date.now();
  return rate;
}

function satsToLtc(sats) {
  return (sats / SATS).toFixed(8);
}

/**
 * Picks the address for a new order. Reuses addresses from orders that expired
 * without any payment (keeps Electrum's 20-address "gap limit" happy), and never
 * hands out an address that has already received anything.
 */
let allocating = Promise.resolve();
function nextAddress() {
  const job = allocating.then(async () => {
    const busy = new Set((await db.all(
      `SELECT ltc_index FROM orders WHERE ltc_index IS NOT NULL AND (
         status = 'completed' OR ltc_txid IS NOT NULL OR COALESCE(ltc_received_sats, 0) > 0
         OR (status = 'pending' AND ltc_expires_at > datetime('now', '-2 hours')))`
    )).map(r => r.ltc_index));
    const maxRow = await db.get(`SELECT MAX(ltc_index) AS m FROM orders WHERE ltc_index IS NOT NULL`);
    const limit = (maxRow?.m ?? -1) + 50;
    for (let i = 0; i <= limit; i++) {
      if (busy.has(i)) continue;
      const address = addressAt(i);
      const info = await getJson(`${EXPLORER}/address/${address}`);
      const used = info.chain_stats.tx_count + info.mempool_stats.tx_count > 0;
      if (!used) return { index: i, address };
      busy.add(i);
    }
    throw new Error('No free payment address. Please try again later.');
  });
  allocating = job.catch(() => {});
  return job;
}

/**
 * Price + address for a new order.
 */
async function quote(usd) {
  if (!isConfigured()) throw new Error('Crypto payments are not set up yet. Please try again later.');
  const rate = await getLtcUsd();
  const sats = Math.ceil((usd / rate) * SATS / 1000) * 1000; // round up to 0.00001 LTC
  const { index, address } = await nextAddress();
  const expiresAt = new Date(Date.now() + QUOTE_MINUTES * 60000);
  return {
    sats, ltc: satsToLtc(sats), rate, address, index,
    expiresAt: expiresAt.toISOString(),
    // SQLite-style UTC time so it compares correctly with datetime('now')
    expiresAtDb: expiresAt.toISOString().slice(0, 19).replace('T', ' ')
  };
}

let running = false;
async function checkPayments(completeOrder) {
  if (!isConfigured() || running) return;
  running = true;
  try {
    // Unpaid orders are given up an hour after their price expired
    await db.run(
      `UPDATE orders SET status = 'cancelled'
       WHERE status = 'pending' AND payment_method = 'crypto' AND ltc_txid IS NULL AND COALESCE(ltc_received_sats, 0) = 0
         AND ltc_expires_at IS NOT NULL AND ltc_expires_at < datetime('now', '-1 hour')`
    );
    const open = await db.all(
      `SELECT * FROM orders
       WHERE status = 'pending' AND payment_method = 'crypto' AND ltc_index IS NOT NULL
         AND (ltc_txid IS NOT NULL OR COALESCE(ltc_received_sats, 0) > 0 OR ltc_expires_at > datetime('now', '-1 hour'))`
    );
    if (open.length === 0) { state.lastCheck = new Date().toISOString(); state.lastError = null; return; }

    const tip = await getJson(`${EXPLORER}/blocks/tip/height`);
    for (const order of open) {
      const txs = await getJson(`${EXPLORER}/address/${order.crypto_address}/txs`);
      const created = new Date(order.created_at.replace(' ', 'T') + 'Z').getTime();
      const deadline = new Date(order.ltc_expires_at.replace(' ', 'T') + 'Z').getTime();
      let received = 0, minConfs = Infinity, firstTx = null;
      for (const tx of txs) {
        const paid = (tx.vout || []).reduce((s, o) => s + (o.scriptpubkey_address === order.crypto_address ? o.value : 0), 0);
        if (paid <= 0) continue;
        if (tx.status?.confirmed && tx.status.block_time * 1000 < created - 60000) continue; // older than the order
        received += paid;
        minConfs = Math.min(minConfs, tx.status?.confirmed ? tip - tx.status.block_height + 1 : 0);
        firstTx = firstTx || tx.txid;
      }
      if (received === 0) continue;

      const confs = minConfs === Infinity ? 0 : minConfs;
      await db.run(
        `UPDATE orders SET ltc_received_sats = ?, ltc_confirmations = ?, ltc_txid = COALESCE(ltc_txid, ?) WHERE id = ?`,
        [received, confs, firstTx, order.id]
      );
      const enough = received >= Math.floor(order.ltc_amount_sats * UNDERPAY_TOLERANCE);
      if (enough && confs >= REQUIRED_CONFS) {
        await completeOrder(order.order_id);
        console.log(`[ltc] ${order.order_id} paid ${satsToLtc(received)} LTC, key issued`);
      } else if (!enough && Date.now() > deadline) {
        console.warn(`[ltc] ${order.order_id} underpaid: got ${satsToLtc(received)} of ${satsToLtc(order.ltc_amount_sats)} LTC. Approve or refund it in the admin panel.`);
      }
    }
    state.lastCheck = new Date().toISOString();
    state.lastError = null;
  } catch (err) {
    state.lastError = err.message;
    console.error('[ltc] check failed:', err.message);
  } finally {
    running = false;
  }
}

function start(completeOrder, seconds = 30) {
  if (!isConfigured()) {
    console.warn('[ltc] LTC_XPUB is not set: crypto checkout is turned off.');
    return;
  }
  console.log(`[ltc] payments on, first address ${addressAt(0)}, ${REQUIRED_CONFS} confirmation(s) needed`);
  setInterval(() => checkPayments(completeOrder), seconds * 1000);
  setTimeout(() => checkPayments(completeOrder), 3000);
}

function status() {
  return {
    configured: isConfigured(),
    firstAddress: isConfigured() ? addressAt(0) : null,
    confirmationsRequired: REQUIRED_CONFS,
    quoteMinutes: QUOTE_MINUTES,
    lastCheck: state.lastCheck,
    lastError: state.lastError,
    lastRateUsd: state.lastRate
  };
}

module.exports = { quote, start, status, checkPayments, satsToLtc, isConfigured, addressAt, REQUIRED_CONFS };
