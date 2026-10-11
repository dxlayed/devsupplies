// devsupplies.cc — storefront + owner panel. No dependencies: `node server.js`.
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 4173;
const PUBLIC = path.join(__dirname, "public");
const DATA = process.env.DATA_DIR || path.join(__dirname, "data");
const UPLOADS = path.join(DATA, "uploads");
// The account with this email is the owner and can open the owner panel.
const OWNER_EMAIL = (process.env.OWNER_EMAIL || "thebeast52521212@gmail.com").toLowerCase();
const PRODUCTS_FILE = path.join(DATA, "products.json");
const SETUP_FILE = path.join(DATA, "setup-code.txt");
const USERS_FILE = path.join(DATA, "users.json");
const SESSIONS_FILE = path.join(DATA, "sessions.json");

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
let users = readJson(USERS_FILE, []);
// sha256(token) -> { userId, expiry }. Saved to disk so a restart doesn't log everyone out.
const userSessions = new Map(Object.entries(readJson(SESSIONS_FILE, {})));
const fails = new Map();    // key -> { count, until }
const signups = new Map();  // ip -> { count, reset }

// Sign-ups don't verify email ownership, so creating the owner's account also
// requires this one-time code. Otherwise anyone could register the owner email first.
let setupCode = null;
if (!users.some((u) => u.email === OWNER_EMAIL)) {
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
  res.setHeader("Set-Cookie", `ds_user=${token}; ${cookieAttrs(req)}; Max-Age=${USER_SESSION_DAYS * 86400}`);
}
const isOwner = (req) => (currentUser(req) || {}).email === OWNER_EMAIL;

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
    return send(res, 200, { owner: isOwner(req), user: user && { email: user.email } });
  }

  /* accounts */

  if (route === "POST /api/register") {
    const quota = signups.get(ip);
    const active = quota && quota.reset > Date.now();
    if (active && quota.count >= MAX_SIGNUPS_PER_HOUR) return send(res, 429, { error: "Too many sign-ups. Try again later." });
    const body = await readBody(req);
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return send(res, 400, { error: "Enter a valid email address" });
    if (password.length < 8 || password.length > 200) return send(res, 400, { error: "Password must be at least 8 characters" });
    if (users.some((u) => u.email === email)) return send(res, 409, { error: "That email already has an account. Log in instead." });
    if (email === OWNER_EMAIL) {
      if (isLocked("c:" + ip)) return send(res, 429, { error: "Too many attempts. Try again in 15 minutes." });
      if (!body.code) return send(res, 403, { needsCode: true, error: "This is the owner email. Enter the setup code from data/setup-code.txt." });
      if (!safeEqual(String(body.code).trim(), setupCode)) {
        recordFail("c:" + ip);
        return send(res, 403, { needsCode: true, error: "Wrong setup code" });
      }
      setupCode = null;
      fs.rmSync(SETUP_FILE, { force: true });
    }
    const salt = crypto.randomBytes(16).toString("hex");
    const user = { id: crypto.randomBytes(8).toString("hex"), email, salt, hash: hashPassword(password, salt), createdAt: Date.now() };
    users.push(user);
    writeJson(USERS_FILE, users);
    signups.set(ip, active ? { ...quota, count: quota.count + 1 } : { count: 1, reset: Date.now() + 36e5 });
    startUserSession(req, res, user);
    return send(res, 201, { email });
  }

  if (route === "POST /api/user/login") {
    if (isLocked("u:" + ip)) return send(res, 429, { error: "Too many attempts. Try again in 15 minutes." });
    const body = await readBody(req);
    const email = String(body.email || "").trim().toLowerCase();
    const user = users.find((u) => u.email === email);
    // Hash even when the email is unknown so the response time doesn't reveal which emails have accounts.
    const hash = hashPassword(String(body.password || "").slice(0, 200), user ? user.salt : "0000000000000000");
    if (!user || !safeEqual(hash, user.hash)) {
      recordFail("u:" + ip);
      return send(res, 401, { error: "Wrong email or password" });
    }
    fails.delete("u:" + ip);
    startUserSession(req, res, user);
    return send(res, 200, { email });
  }

  if (route === "POST /api/user/logout") {
    const token = cookie(req, "ds_user");
    if (token && userSessions.delete(sha(token))) saveUserSessions();
    return send(res, 200, { ok: true }, { "Set-Cookie": `ds_user=; ${cookieAttrs(req)}; Max-Age=0` });
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
