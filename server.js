// devsupplies.cc — storefront + owner panel. No dependencies: `node server.js`.
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 4173;
const PUBLIC = path.join(__dirname, "public");
const DATA = process.env.DATA_DIR || path.join(__dirname, "data");
const UPLOADS = path.join(DATA, "uploads");
// The owner account. Only this username can open the owner panel.
const OWNER_USERNAME = "devsupplies";
const PRODUCTS_FILE = path.join(DATA, "products.json");
const SETUP_FILE = path.join(DATA, "setup-code.txt");
const USERS_FILE = path.join(DATA, "users.json");
const SESSIONS_FILE = path.join(DATA, "sessions.json");
const ORDERS_FILE = path.join(DATA, "orders.json");
const DEPOSITS_FILE = path.join(DATA, "deposits.json");
const SETTINGS_FILE = path.join(DATA, "settings.json");
const VISITS_FILE = path.join(DATA, "visits.json");

// Coins customers can deposit. The owner fills in wallet addresses in the owner panel.
const COINS = {
  BTC: "Bitcoin",
  ETH: "Ethereum (ERC-20)",
  USDT_TRC20: "USDT (TRC-20)",
  USDT_ERC20: "USDT (ERC-20)",
  LTC: "Litecoin",
  SOL: "Solana",
};
const ONLINE_WINDOW = 60 * 1000; // a visitor counts as online if their page pinged in the last minute

const USER_SESSION_DAYS = 30;
const MAX_SIGNUPS_PER_HOUR = 10;
const MAX_BODY = 8 * 1024 * 1024;
const MAX_IMAGE = 5 * 1024 * 1024;
const MAX_FAILS = 5;
const LOCK_MS = 15 * 60 * 1000;

fs.mkdirSync(UPLOADS, { recursive: true });

const readJson = (file, fallback) => {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
};
const writeJson = (file, value) => {
  fs.writeFileSync(file + ".tmp", JSON.stringify(value, null, 2));
  fs.renameSync(file + ".tmp", file);
};

let products = readJson(PRODUCTS_FILE, []);
// Only username accounts are kept (older email-based test accounts are dropped).
let users = readJson(USERS_FILE, []).filter((u) => u.username && u.hash);
let orders = readJson(ORDERS_FILE, []);
let deposits = readJson(DEPOSITS_FILE, []);
const settings = { wallets: {}, ...readJson(SETTINGS_FILE, {}) };
const visits = readJson(VISITS_FILE, {}); // "YYYY-MM-DD" -> unique visitors that day
const online = new Map();   // visitor id -> { last, page }
let visitorsToday = { day: "", ids: new Set() };
// sha256(token) -> { userId, expiry }. Saved to disk so a restart doesn't log everyone out.
const userSessions = new Map(Object.entries(readJson(SESSIONS_FILE, {})));
const fails = new Map();    // key -> { count, until }
const signups = new Map();  // ip -> { count, reset }

// Creating the owner account requires this one-time code, otherwise anyone
// could grab the owner username first.
let setupCode = null;
if (!users.some((u) => u.username.toLowerCase() === OWNER_USERNAME)) {
  setupCode = crypto.randomBytes(4).toString("hex");
  fs.writeFileSync(SETUP_FILE, setupCode + "\n");
  console.log(`No owner account yet. Setup code: ${setupCode} (also saved to ${SETUP_FILE})`);
}

/* ---------- helpers ---------- */

const hashPassword = (password, salt) => crypto.scryptSync(password, salt, 64).toString("hex");
const safeEqual = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

function send(res, status, body, headers = {}) {
  const json = typeof body === "object" && !Buffer.isBuffer(body);
  res.writeHead(status, {
    "Content-Type": json ? "application/json" : "text/plain; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
    ...headers,
  });
  res.end(json ? JSON.stringify(body) : body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    if (!/^application\/json/.test(req.headers["content-type"] || "")) return reject(new Error("Expected JSON"));
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error("Request too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); }
      catch { reject(new Error("Invalid JSON")); }
    });
    req.on("error", reject);
  });
}

const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
function cookie(req, name) {
  const m = new RegExp("(?:^|;\\s*)" + name + "=([a-f0-9]{64})").exec(req.headers.cookie || "");
  return m && m[1];
}
const cookieAttrs = (req) => `HttpOnly; SameSite=Lax; Path=/${req.headers["x-forwarded-proto"] === "https" ? "; Secure" : ""}`;

const isLocked = (key) => (fails.get(key) || {}).until > Date.now();
function recordFail(key) {
  const count = ((fails.get(key) || {}).count || 0) + 1;
  fails.set(key, { count: count >= MAX_FAILS ? 0 : count, until: count >= MAX_FAILS ? Date.now() + LOCK_MS : 0 });
}

function saveUserSessions() {
  for (const [key, s] of userSessions) if (s.expiry < Date.now()) userSessions.delete(key);
  writeJson(SESSIONS_FILE, Object.fromEntries(userSessions));
}
function currentUser(req) {
  const token = cookie(req, "ds_user");
  const session = token && userSessions.get(sha(token));
  if (!session || session.expiry < Date.now()) return null;
  return users.find((u) => u.id === session.userId) || null;
}
function startUserSession(req, res, user) {
  const token = crypto.randomBytes(32).toString("hex");
  userSessions.set(sha(token), { userId: user.id, expiry: Date.now() + USER_SESSION_DAYS * 864e5 });
  saveUserSessions();
  addCookie(res, `ds_user=${token}; ${cookieAttrs(req)}; Max-Age=${USER_SESSION_DAYS * 86400}`);
}
function addCookie(res, value) {
  const prev = res.getHeader("Set-Cookie");
  res.setHeader("Set-Cookie", [].concat(prev || [], value));
}
const isOwner = (req) => ((currentUser(req) || {}).username || "").toLowerCase() === OWNER_USERNAME;
const cents = (dollars) => Math.round(Number(dollars) * 100);
const dayKey = (t = Date.now()) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
function onlineNow() {
  const cutoff = Date.now() - ONLINE_WINDOW;
  for (const [id, v] of online) if (v.last < cutoff) online.delete(id);
  return online.size;
}
const findUser = (name) => users.find((u) => u.username.toLowerCase() === String(name).toLowerCase());
const USERNAME_RE = /^[A-Za-z0-9_]{3,20}$/;
function checkNewPassword(password, confirm) {
  if (password.length < 8 || password.length > 200) return "Password must be at least 8 characters";
  if (password !== confirm) return "Passwords don't match";
  return null;
}
function setPassword(user, password) {
  user.salt = crypto.randomBytes(16).toString("hex");
  user.hash = hashPassword(password, user.salt);
}
function passwordMatches(user, password) {
  return safeEqual(hashPassword(String(password || "").slice(0, 200), user.salt), user.hash);
}
function endSessionsFor(userId, exceptToken) {
  const keep = exceptToken && sha(exceptToken);
  for (const [key, s] of userSessions) if (s.userId === userId && key !== keep) userSessions.delete(key);
  saveUserSessions();
}

function saveImage(dataUrl) {
  const m = /^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl || "");
  if (!m) throw new Error("Image must be a PNG, JPG, WEBP or GIF");
  const buf = Buffer.from(m[2], "base64");
  if (buf.length > MAX_IMAGE) throw new Error("Image must be under 5 MB");
  const name = crypto.randomBytes(8).toString("hex") + "." + (m[1] === "jpeg" ? "jpg" : m[1]);
  fs.writeFileSync(path.join(UPLOADS, name), buf);
  return "/uploads/" + name;
}
function deleteImage(url) {
  if (url) fs.rm(path.join(UPLOADS, path.basename(url)), { force: true }, () => {});
}

function productFields(body) {
  const name = String(body.name || "").trim();
  const price = Math.round(Number(body.price) * 100) / 100;
  if (!name || name.length > 80) throw new Error("Name is required (80 characters max)");
  if (!Number.isFinite(price) || price < 0 || price > 100000) throw new Error("Enter a valid price");
  return {
    name,
    price,
    category: String(body.category || "").trim().slice(0, 30) || "General",
    description: String(body.description || "").trim().slice(0, 600),
    published: body.published !== false,
  };
}

/* ---------- api ---------- */

async function api(req, res, url) {
  const route = req.method + " " + url.pathname;
  const ip = req.socket.remoteAddress;

  if (route === "GET /api/me") {
    const user = currentUser(req);
    return send(res, 200, {
      owner: isOwner(req),
      user: user && { username: user.username, createdAt: user.createdAt, balance: (user.balance || 0) / 100 },
    });
  }

  /* live visitors: every page pings every 30 seconds */

  if (route === "POST /api/ping") {
    const body = await readBody(req);
    const id = String(body.id || "");
    if (!/^[a-f0-9]{32}$/.test(id)) return send(res, 400, { error: "Bad id" });
    if (online.size < 20000 || online.has(id)) online.set(id, { last: Date.now(), page: String(body.page || "").slice(0, 40) });
    const today = dayKey();
    if (visitorsToday.day !== today) visitorsToday = { day: today, ids: new Set() };
    if (!visitorsToday.ids.has(id) && visitorsToday.ids.size < 100000) {
      visitorsToday.ids.add(id);
      visits[today] = (visits[today] || 0) + 1;
      writeJson(VISITS_FILE, visits);
    }
    return send(res, 200, { ok: true });
  }

  /* crypto wallets (addresses customers send to) */

  if (route === "GET /api/wallets") {
    const list = Object.entries(COINS)
      .filter(([code]) => settings.wallets[code])
      .map(([code, name]) => ({ code, name, address: settings.wallets[code] }));
    return send(res, 200, list);
  }

  /* accounts */

  if (route === "POST /api/register") {
    const quota = signups.get(ip);
    const active = quota && quota.reset > Date.now();
    if (active && quota.count >= MAX_SIGNUPS_PER_HOUR) return send(res, 429, { error: "Too many sign-ups. Try again later." });
    const body = await readBody(req);
    const username = String(body.username || "").trim();
    const password = String(body.password || "");
    if (!USERNAME_RE.test(username)) return send(res, 400, { error: "Username must be 3-20 letters, numbers or _" });
    const problem = checkNewPassword(password, String(body.confirm || ""));
    if (problem) return send(res, 400, { error: problem });
    if (findUser(username)) return send(res, 409, { error: "That username is taken" });
    if (username.toLowerCase() === OWNER_USERNAME) {
      if (isLocked("c:" + ip)) return send(res, 429, { error: "Too many attempts. Try again in 15 minutes." });
      if (!body.code) return send(res, 403, { needsCode: true, error: "This is the owner username. Enter the setup code from data/setup-code.txt." });
      if (!setupCode || !safeEqual(String(body.code).trim(), setupCode)) {
        recordFail("c:" + ip);
        return send(res, 403, { needsCode: true, error: "Wrong setup code" });
      }
      setupCode = null;
      fs.rmSync(SETUP_FILE, { force: true });
    }
    const user = { id: crypto.randomBytes(8).toString("hex"), username, createdAt: Date.now() };
    setPassword(user, password);
    users.push(user);
    writeJson(USERS_FILE, users);
    signups.set(ip, active ? { ...quota, count: quota.count + 1 } : { count: 1, reset: Date.now() + 36e5 });
    startUserSession(req, res, user);
    return send(res, 201, { username });
  }

  if (route === "POST /api/user/login") {
    if (isLocked("u:" + ip)) return send(res, 429, { error: "Too many attempts. Try again in 15 minutes." });
    const body = await readBody(req);
    const user = findUser(String(body.username || "").trim());
    // Hash even when the username is unknown so the response time doesn't reveal which usernames exist.
    const ok = user ? passwordMatches(user, body.password) : (hashPassword("x", "0000000000000000"), false);
    if (!ok) {
      recordFail("u:" + ip);
      return send(res, 401, { error: "Wrong username or password" });
    }
    fails.delete("u:" + ip);
    startUserSession(req, res, user);
    return send(res, 200, { username: user.username });
  }

  if (route === "POST /api/user/logout") {
    const token = cookie(req, "ds_user");
    if (token && userSessions.delete(sha(token))) saveUserSessions();
    return send(res, 200, { ok: true }, { "Set-Cookie": `ds_user=; ${cookieAttrs(req)}; Max-Age=0` });
  }

  /* signed-in customer */

  if (route === "POST /api/user/password") {
    const user = currentUser(req);
    if (!user) return send(res, 401, { error: "Log in first" });
    if (isLocked("p:" + ip)) return send(res, 429, { error: "Too many attempts. Try again in 15 minutes." });
    const body = await readBody(req);
    if (!passwordMatches(user, body.current)) {
      recordFail("p:" + ip);
      return send(res, 403, { error: "Current password is wrong" });
    }
    const password = String(body.password || "");
    const problem = checkNewPassword(password, String(body.confirm || ""));
    if (problem) return send(res, 400, { error: problem });
    setPassword(user, password);
    writeJson(USERS_FILE, users);
    endSessionsFor(user.id, cookie(req, "ds_user")); // log out other devices
    return send(res, 200, { ok: true });
  }

  if (route === "POST /api/user/delete") {
    const user = currentUser(req);
    if (!user) return send(res, 401, { error: "Log in first" });
    if (isLocked("p:" + ip)) return send(res, 429, { error: "Too many attempts. Try again in 15 minutes." });
    const body = await readBody(req);
    if (!passwordMatches(user, body.password)) {
      recordFail("p:" + ip);
      return send(res, 403, { error: "Password is wrong" });
    }
    if (isOwner(req)) return send(res, 400, { error: "The owner account can't be deleted" });
    users = users.filter((u) => u !== user);
    writeJson(USERS_FILE, users);
    endSessionsFor(user.id);
    return send(res, 200, { ok: true }, { "Set-Cookie": `ds_user=; ${cookieAttrs(req)}; Max-Age=0` });
  }

  if (route === "GET /api/orders") {
    const user = currentUser(req);
    if (!user) return send(res, 401, { error: "Log in first" });
    if (url.searchParams.has("all") && isOwner(req)) {
      const names = Object.fromEntries(users.map((u) => [u.id, u.username]));
      return send(res, 200, orders.map((o) => ({ ...o, username: names[o.userId] || "(deleted)" })));
    }
    return send(res, 200, orders.filter((o) => o.userId === user.id));
  }

  // Checkout: records the order. Payment isn't connected yet, so it starts as "Awaiting payment".
  if (route === "POST /api/orders") {
    const user = currentUser(req);
    if (!user) return send(res, 401, { error: "Log in first" });
    const body = await readBody(req);
    const ids = [...new Set(Array.isArray(body.items) ? body.items.map(String) : [])].slice(0, 100);
    const items = ids.map((id) => products.find((p) => p.id === id && p.published)).filter(Boolean)
      .map((p) => ({ id: p.id, name: p.name, price: p.price }));
    if (!items.length) return send(res, 400, { error: "Your cart is empty" });
    const totalCents = items.reduce((sum, i) => sum + cents(i.price), 0);
    const balance = user.balance || 0;
    if (balance < totalCents) {
      const short = ((totalCents - balance) / 100).toFixed(2);
      return send(res, 402, { needsDeposit: true, error: `Not enough balance. Deposit at least $${short} more to check out.` });
    }
    user.balance = balance - totalCents;
    writeJson(USERS_FILE, users);
    const order = {
      id: crypto.randomBytes(5).toString("hex").toUpperCase(),
      userId: user.id,
      items,
      total: totalCents / 100,
      status: "Paid",
      createdAt: Date.now(),
    };
    orders.unshift(order);
    writeJson(ORDERS_FILE, orders);
    return send(res, 201, { order, balance: user.balance / 100 });
  }

  /* crypto deposits */

  if (route === "GET /api/deposits") {
    const user = currentUser(req);
    if (!user) return send(res, 401, { error: "Log in first" });
    if (url.searchParams.has("all") && isOwner(req)) {
      const names = Object.fromEntries(users.map((u) => [u.id, u.username]));
      return send(res, 200, deposits.map((d) => ({ ...d, username: names[d.userId] || "(deleted)" })));
    }
    return send(res, 200, deposits.filter((d) => d.userId === user.id));
  }

  if (route === "POST /api/deposits") {
    const user = currentUser(req);
    if (!user) return send(res, 401, { error: "Log in first" });
    const body = await readBody(req);
    const coin = String(body.coin || "");
    const amount = Math.round(Number(body.amount) * 100) / 100;
    const txid = String(body.txid || "").trim();
    if (!settings.wallets[coin]) return send(res, 400, { error: "Pick a coin" });
    if (!Number.isFinite(amount) || amount < 1 || amount > 10000) return send(res, 400, { error: "Enter an amount between $1 and $10,000" });
    if (!/^[A-Za-z0-9]{16,128}$/.test(txid.replace(/^0x/, ""))) return send(res, 400, { error: "Paste the transaction ID (hash) from your wallet" });
    if (deposits.some((d) => d.txid.toLowerCase() === txid.toLowerCase())) return send(res, 409, { error: "That transaction ID was already submitted" });
    if (deposits.filter((d) => d.userId === user.id && d.status === "Pending").length >= 5) {
      return send(res, 429, { error: "You have 5 deposits waiting for review. Wait for those first." });
    }
    const deposit = {
      id: crypto.randomBytes(5).toString("hex").toUpperCase(),
      userId: user.id,
      coin,
      address: settings.wallets[coin],
      amount,
      txid,
      status: "Pending",
      createdAt: Date.now(),
    };
    deposits.unshift(deposit);
    writeJson(DEPOSITS_FILE, deposits);
    return send(res, 201, deposit);
  }

  /* products */

  if (route === "GET /api/products") {
    const all = url.searchParams.has("all") && isOwner(req);
    return send(res, 200, all ? products : products.filter((p) => p.published));
  }

  // Everything below is owner-only.
  if (!isOwner(req)) return send(res, 401, { error: "Owner access only" });

  if (route === "POST /api/products") {
    const body = await readBody(req);
    const product = { id: crypto.randomBytes(6).toString("hex"), ...productFields(body), image: null, createdAt: Date.now() };
    if (body.imageData) product.image = saveImage(body.imageData);
    products.unshift(product);
    writeJson(PRODUCTS_FILE, products);
    return send(res, 201, product);
  }

  const m = /^\/api\/products\/([a-f0-9]{12})$/.exec(url.pathname);
  const product = m && products.find((p) => p.id === m[1]);
  if (m && !product) return send(res, 404, { error: "Product not found" });

  if (product && req.method === "PUT") {
    const body = await readBody(req);
    Object.assign(product, productFields(body));
    if (body.imageData) {
      const image = saveImage(body.imageData);
      deleteImage(product.image);
      product.image = image;
    } else if (body.removeImage) {
      deleteImage(product.image);
      product.image = null;
    }
    writeJson(PRODUCTS_FILE, products);
    return send(res, 200, product);
  }

  if (route === "GET /api/owner/stats") {
    const pages = {};
    onlineNow();
    for (const v of online.values()) pages[v.page || "other"] = (pages[v.page || "other"] || 0) + 1;
    return send(res, 200, {
      online: online.size,
      pages,
      visits,
      customers: users.length - 1,
      balances: users.reduce((sum, u) => sum + (u.balance || 0), 0) / 100,
      pendingDeposits: deposits.filter((d) => d.status === "Pending").length,
    });
  }

  if (route === "GET /api/owner/settings") return send(res, 200, { wallets: settings.wallets, coins: COINS });

  if (route === "PUT /api/owner/settings") {
    const body = await readBody(req);
    const wallets = {};
    for (const code of Object.keys(COINS)) {
      const address = String((body.wallets || {})[code] || "").trim();
      if (address && !/^[A-Za-z0-9:]{20,120}$/.test(address)) return send(res, 400, { error: `${COINS[code]} address doesn't look right` });
      if (address) wallets[code] = address;
    }
    settings.wallets = wallets;
    writeJson(SETTINGS_FILE, settings);
    return send(res, 200, { wallets });
  }

  // Approve (adds to the customer's balance) or reject a deposit.
  const dm = /^\/api\/deposits\/([A-F0-9]{10})$/.exec(url.pathname);
  if (dm && req.method === "PUT") {
    const deposit = deposits.find((d) => d.id === dm[1]);
    if (!deposit) return send(res, 404, { error: "Deposit not found" });
    if (deposit.status !== "Pending") return send(res, 400, { error: "This deposit was already reviewed" });
    const body = await readBody(req);
    if (body.status === "Approved") {
      const credited = body.amount == null ? deposit.amount : Math.round(Number(body.amount) * 100) / 100;
      if (!Number.isFinite(credited) || credited <= 0 || credited > 100000) return send(res, 400, { error: "Enter a valid amount" });
      const user = users.find((u) => u.id === deposit.userId);
      if (!user) return send(res, 400, { error: "That customer deleted their account" });
      user.balance = (user.balance || 0) + cents(credited);
      writeJson(USERS_FILE, users);
      deposit.credited = credited;
    } else if (body.status !== "Rejected") {
      return send(res, 400, { error: "Unknown status" });
    }
    deposit.status = body.status;
    deposit.reviewedAt = Date.now();
    writeJson(DEPOSITS_FILE, deposits);
    return send(res, 200, deposit);
  }

  // Refund a paid order back to the customer's balance.
  const om = /^\/api\/orders\/([A-F0-9]{10})$/.exec(url.pathname);
  if (om && req.method === "PUT") {
    const order = orders.find((o) => o.id === om[1]);
    if (!order) return send(res, 404, { error: "Order not found" });
    const body = await readBody(req);
    if (body.status !== "Refunded" || order.status !== "Paid") return send(res, 400, { error: "Only paid orders can be refunded" });
    const user = users.find((u) => u.id === order.userId);
    if (!user) return send(res, 400, { error: "That customer deleted their account" });
    user.balance = (user.balance || 0) + cents(order.total);
    writeJson(USERS_FILE, users);
    order.status = "Refunded";
    order.refundedAt = Date.now();
    writeJson(ORDERS_FILE, orders);
    return send(res, 200, order);
  }

  if (product && req.method === "DELETE") {
    deleteImage(product.image);
    products = products.filter((p) => p !== product);
    writeJson(PRODUCTS_FILE, products);
    return send(res, 200, { ok: true });
  }

  send(res, 404, { error: "Not found" });
}

/* ---------- static files ---------- */

const MIME = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".ico": "image/x-icon",
};
const CSP = "default-src 'self'; img-src 'self' data: blob:; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; frame-ancestors 'none'";

function serveFile(res, file, cache) {
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, "Not found");
    send(res, 200, data, {
      "Content-Type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream",
      "Content-Security-Policy": CSP,
      "Cache-Control": cache,
    });
  });
}

function serveStatic(req, res, url) {
  if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "Method not allowed");
  let pathname;
  try { pathname = decodeURIComponent(url.pathname); } catch { return send(res, 400, "Bad request"); }

  if (pathname.startsWith("/uploads/")) return serveFile(res, path.join(UPLOADS, path.basename(pathname)), "public, max-age=31536000, immutable");
  if (pathname === "/") pathname = "/index.html";
  if (pathname === "/owner") pathname = "/owner.html";
  if (pathname === "/login") pathname = "/login.html";
  if (pathname === "/account") pathname = "/account.html";

  const file = path.join(PUBLIC, pathname);
  if (!file.startsWith(PUBLIC + path.sep)) return send(res, 403, "Forbidden");
  serveFile(res, file, "no-cache");
}

http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname.startsWith("/api/")) {
    api(req, res, url).catch((err) => { if (!res.headersSent) send(res, 400, { error: err.message }); });
  } else {
    serveStatic(req, res, url);
  }
}).listen(PORT, () => console.log(`devsupplies running at http://localhost:${PORT}`));
