// Litecoin: turns your Electrum master public key (LTC_ZPUB) into receive addresses,
// reads payments from the blockchain, and gets the live LTC price.
// A zpub is watch-only. It can make addresses but can never spend your coins.
const { HDKey } = require('@scure/bip32');
const { bech32 } = require('@scure/base');
const { sha256 } = require('@noble/hashes/sha256');
const { ripemd160 } = require('@noble/hashes/ripemd160');

const ZPUB = (process.env.LTC_ZPUB || '').trim();
const CONFIRMATIONS = Math.max(1, parseInt(process.env.LTC_CONFIRMATIONS || '1', 10) || 1);

let receiveKey = null;
if (!ZPUB) {
  console.warn('WARNING: LTC_ZPUB is not set. Deposits are off until you add it in your Railway variables.');
} else {
  try {
    receiveKey = HDKey.fromExtendedKey(ZPUB, { private: 0x04b2430c, public: 0x04b24746 }).deriveChild(0);
    console.log('Litecoin deposits on. First address:', address(0));
  } catch (e) {
    console.error('ERROR: LTC_ZPUB is not a valid zpub. Deposits are off.', e.message);
  }
}
const enabled = () => !!receiveKey;

// Native SegWit (ltc1...) address number `index`, same as Electrum's receiving addresses
function address(index) {
  const pub = receiveKey.deriveChild(index).publicKey;
  return bech32.encode('ltc', [0, ...bech32.toWords(ripemd160(sha256(pub)))]);
}

async function getJSON(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(10000), headers: { 'User-Agent': 'devsupplies' } });
  if (!r.ok) throw new Error(`${url} answered ${r.status}`);
  return r.json();
}

// Every payment an address has received: [{ txid, vout, litoshis, confirmations }]
async function payments(addr) {
  try {
    const txs = await getJSON(`https://litecoinspace.org/api/address/${addr}/txs`);
    let tip = 0;
    if (CONFIRMATIONS > 1 && txs.some(t => t.status?.confirmed)) {
      const r = await fetch('https://litecoinspace.org/api/blocks/tip/height', { signal: AbortSignal.timeout(10000) });
      tip = Number(await r.text());
    }
    const found = [];
    for (const t of txs) {
      const confirmations = !t.status?.confirmed ? 0 : tip ? tip - t.status.block_height + 1 : 1;
      t.vout.forEach((out, i) => {
        if (out.scriptpubkey_address === addr) found.push({ txid: t.txid, vout: i, litoshis: out.value, confirmations });
      });
    }
    return found;
  } catch (e) {
    // Backup source if litecoinspace is down
    const d = await getJSON(`https://api.blockcypher.com/v1/ltc/main/addrs/${addr}?limit=50`);
    return [...(d.txrefs || []), ...(d.unconfirmed_txrefs || [])]
      .filter(r => r.tx_input_n === -1)
      .map(r => ({ txid: r.tx_hash, vout: r.tx_output_n, litoshis: r.value, confirmations: r.confirmations || 0 }));
  }
}

// Live LTC price in USD, cached for a minute
let cache = { usd: 0, at: 0 };
async function price() {
  if (cache.usd && Date.now() - cache.at < 60000) return cache.usd;
  let usd = 0;
  try { usd = parseFloat((await getJSON('https://api.coinbase.com/v2/prices/LTC-USD/spot')).data.amount); } catch {}
  if (!usd) try { usd = (await getJSON('https://api.coingecko.com/api/v3/simple/price?ids=litecoin&vs_currencies=usd')).litecoin.usd; } catch {}
  if (!usd) { if (cache.usd) return cache.usd; throw new Error('Could not get the LTC price.'); }
  cache = { usd, at: Date.now() };
  return usd;
}
const lastPrice = () => cache.usd || null;

module.exports = { enabled, address, payments, price, lastPrice, CONFIRMATIONS };
