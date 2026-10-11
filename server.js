// devsupplies.cc — storefront + owner panel. No dependencies: `node server.js`.
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 4173;
const PUBLIC = path.join(__dirname, "public");
const DATA = process.env.DATA_DIR || path.join(__dirname, "data");
const UPLOADS = path.join(DATA, "uploads");
const OWNER_FILE = path.join(DATA, "owner.json");
const PRODUCTS_FILE = path.join(DATA, "products.json");
const SETUP_FILE = path.join(DATA, "setup-code.txt");

const SESSION_DAYS = 7;
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

let owner = readJson(OWNER_FILE, null);
let products = readJson(PRODUCTS_FILE, []);
const sessions = new Map(); // token -> expiry timestamp
const fails = new Map();    // ip -> { count, until }

// Until an owner account exists, creating one requires this one-time code,
// so a stranger who finds the site first can't claim it.
let setupCode = null;
if (!owner) {
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

function sessionToken(req) {
  const m = /(?:^|;\s*)ds_session=([a-f0-9]{64})/.exec(req.headers.cookie || "");
  return m && m[1];
}
function isOwner(req) {
  const token = sessionToken(req);
  const expiry = token && sessions.get(token);
  if (!expiry) return false;
  if (expiry < Date.now()) { sessions.delete(token); return false; }
  return true;
}
function startSession(req, res) {
  const token = crypto.randomBytes(32).toString("hex");
  sessions.set(token, Date.now() + SESSION_DAYS * 864e5);
  const secure = req.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
  res.setHeader("Set-Cookie", `ds_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_DAYS * 86400}${secure}`);
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

  if (route === "GET /api/me") return send(res, 200, { owner: isOwner(req), needsSetup: !owner });

  if (route === "GET /api/products") {
    const all = url.searchParams.has("all") && isOwner(req);
    return send(res, 200, all ? products : products.filter((p) => p.published));
  }

  if (route === "POST /api/setup") {
    if (owner) return send(res, 403, { error: "An owner account already exists" });
    const body = await readBody(req);
    const username = String(body.username || "").trim();
    const password = String(body.password || "");
    if (!safeEqual(String(body.code || "").trim(), setupCode)) return send(res, 403, { error: "Wrong setup code" });
    if (username.length < 3 || username.length > 32) return send(res, 400, { error: "Username must be 3–32 characters" });
    if (password.length < 8) return send(res, 400, { error: "Password must be at least 8 characters" });
    const salt = crypto.randomBytes(16).toString("hex");
    owner = { username, salt, hash: hashPassword(password, salt) };
    writeJson(OWNER_FILE, owner);
    setupCode = null;
    fs.rmSync(SETUP_FILE, { force: true });
    startSession(req, res);
    return send(res, 200, { ok: true });
  }

  if (route === "POST /api/login") {
    if (!owner) return send(res, 403, { error: "No owner account yet" });
    const lock = fails.get(ip);
    if (lock && lock.until > Date.now()) return send(res, 429, { error: "Too many attempts. Try again in 15 minutes." });
    const body = await readBody(req);
    const ok = safeEqual(String(body.username || "").trim().toLowerCase(), owner.username.toLowerCase())
      & safeEqual(hashPassword(String(body.password || ""), owner.salt), owner.hash);
    if (!ok) {
      const count = (lock && lock.count || 0) + 1;
      fails.set(ip, { count: count >= MAX_FAILS ? 0 : count, until: count >= MAX_FAILS ? Date.now() + LOCK_MS : 0 });
      return send(res, 401, { error: "Wrong username or password" });
    }
    fails.delete(ip);
    startSession(req, res);
    return send(res, 200, { ok: true });
  }

  if (route === "POST /api/logout") {
    sessions.delete(sessionToken(req));
    return send(res, 200, { ok: true }, { "Set-Cookie": "ds_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0" });
  }

  // Everything below is owner-only.
  if (!isOwner(req)) return send(res, 401, { error: "Not logged in" });

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
