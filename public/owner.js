const TABS = ["analytics", "products", "orders", "deposits", "wallets"];
const MAX_IMAGE = 5 * 1024 * 1024;
const STATUS_CLASS = { Paid: "good", Approved: "good", Pending: "wait", "Awaiting payment": "wait", Rejected: "bad", Refunded: "bad", Cancelled: "bad" };
const statusPill = (s) => `<span class="status ${STATUS_CLASS[s] || ""}">${esc(s)}</span>`;

let products = [];
let orders = [];
let deposits = [];
let stats = null;
let range = "day";
let editing = null;     // product being edited, or null for a new one
let imageData = null;   // newly chosen picture as a data URL
let removeImage = false;

async function ownerApi(method, url, body) {
  try { return await api(method, url, body); } catch (err) {
    if (err.status === 401) showGate();
    throw err;
  }
}

function show(view) {
  ["gateView", "dashView"].forEach((v) => { $(v).hidden = v !== view; });
  $("logout").hidden = view !== "dashView";
}

// Everyone except the owner sees this screen.
function showGate(me) {
  const wrongAccount = me && me.user;
  $("gateText").textContent = wrongAccount
    ? `You're logged in as ${me.user.username}, which isn't the owner account.`
    : "Log in as devsupplies to manage the shop.";
  $("gateLogin").hidden = !!wrongAccount;
  show("gateView");
}

$("logout").addEventListener("click", async () => {
  await fetch("/api/user/logout", { method: "POST" }).catch(() => {});
  location.href = "/";
});

/* ---------- tabs ---------- */

function openTab(name) {
  if (!TABS.includes(name)) name = "analytics";
  document.querySelectorAll(".side-tab").forEach((b) => b.setAttribute("aria-selected", b.dataset.tab === name));
  TABS.forEach((t) => { $("tab-" + t).hidden = t !== name; });
  if (location.hash !== "#" + name) history.replaceState(null, "", "#" + name);
  if (name === "analytics") renderChart();
}
document.querySelector(".side-nav").addEventListener("click", (e) => {
  const b = e.target.closest("[data-tab]");
  if (b) openTab(b.dataset.tab);
});
window.addEventListener("hashchange", () => openTab(location.hash.slice(1)));

function renderCounts() {
  const pending = deposits.filter((d) => d.status === "Pending").length;
  $("productCount").textContent = products.length || "";
  $("orderCount").textContent = orders.length || "";
  $("depositCount").textContent = pending || "";
  $("depositCount").classList.toggle("alert", pending > 0);
}

/* ---------- analytics ---------- */

const pad = (n) => String(n).padStart(2, "0");
const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const startOfWeek = (d) => { const s = startOfDay(d); s.setDate(s.getDate() - ((s.getDay() + 6) % 7)); return s; }; // Monday
const short = (d, opts) => d.toLocaleDateString(undefined, opts);
const paid = () => orders.filter((o) => o.status === "Paid");

function sumSince(ms) {
  const list = paid().filter((o) => o.createdAt >= ms);
  return { total: list.reduce((s, o) => s + o.total, 0), count: list.length };
}
const ordersLabel = (n) => `${n} order${n === 1 ? "" : "s"}`;

// Buckets for the chart: last 30 days, 12 weeks or 12 months, oldest first.
function buckets() {
  const now = new Date();
  const list = [];
  if (range === "day") {
    for (let i = 29; i >= 0; i--) {
      const s = startOfDay(now); s.setDate(s.getDate() - i);
      const e = new Date(s); e.setDate(e.getDate() + 1);
      list.push({ start: s, end: e, label: short(s, { month: "short", day: "numeric" }) });
    }
  } else if (range === "week") {
    for (let i = 11; i >= 0; i--) {
      const s = startOfWeek(now); s.setDate(s.getDate() - i * 7);
      const e = new Date(s); e.setDate(e.getDate() + 7);
      list.push({ start: s, end: e, label: short(s, { month: "short", day: "numeric" }), long: "Week of " + short(s, { month: "short", day: "numeric" }) });
    }
  } else {
    for (let i = 11; i >= 0; i--) {
      const s = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const e = new Date(s.getFullYear(), s.getMonth() + 1, 1);
      list.push({ start: s, end: e, label: short(s, { month: "short" }), long: short(s, { month: "long", year: "numeric" }) });
    }
  }
  const p = paid();
  for (const b of list) {
    const inside = p.filter((o) => o.createdAt >= +b.start && o.createdAt < +b.end);
    b.total = inside.reduce((s, o) => s + o.total, 0);
    b.count = inside.length;
  }
  return list;
}

// Round the top of the y-axis up to a tidy number (1, 2, 2.5 or 5 × 10ⁿ).
function niceMax(v) {
  if (v <= 0) return 100;
  const step = v / 4;
  const mag = 10 ** Math.floor(Math.log10(step));
  const nice = [1, 2, 2.5, 5, 10].find((m) => m * mag >= step) * mag;
  return nice * 4;
}
const axisMoney = (v) => (v >= 1000 ? "$" + (v / 1000).toLocaleString("en-US", { maximumFractionDigits: 1 }) + "k" : "$" + Math.round(v));

function renderChart() {
  if ($("tab-analytics").hidden) return;
  const data = buckets();
  const svg = $("chart");
  const W = svg.clientWidth || 600, H = 260;
  const m = { top: 10, right: 4, bottom: 26, left: 46 };
  const pw = W - m.left - m.right, ph = H - m.top - m.bottom;
  const max = niceMax(Math.max(...data.map((d) => d.total)));
  const band = pw / data.length;
  const barW = Math.max(3, Math.min(36, band - Math.max(2, band * 0.28)));
  const y = (v) => m.top + ph - (v / max) * ph;
  const every = Math.ceil(data.length / 8);

  let out = "";
  for (let i = 0; i <= 4; i++) {
    const v = (max / 4) * i, yy = y(v);
    out += `<line class="grid-line" x1="${m.left}" x2="${W - m.right}" y1="${yy}" y2="${yy}"/>`;
    out += `<text class="axis-label" x="${m.left - 8}" y="${yy + 4}" text-anchor="end">${axisMoney(v)}</text>`;
  }
  data.forEach((d, i) => {
    const x = m.left + band * i + (band - barW) / 2;
    const top = y(d.total), h = m.top + ph - top;
    const r = Math.min(4, barW / 2, h);
    const bar = h > 0
      ? `<path class="bar" d="M${x},${m.top + ph} V${top + r} Q${x},${top} ${x + r},${top} H${x + barW - r} Q${x + barW},${top} ${x + barW},${top + r} V${m.top + ph} Z"/>`
      : `<rect class="bar zero" x="${x}" y="${m.top + ph - 1}" width="${barW}" height="1"/>`;
    out += `<g data-i="${i}"><rect class="hit" x="${m.left + band * i}" y="${m.top}" width="${band}" height="${ph}"/>${bar}</g>`;
    if ((data.length - 1 - i) % every === 0) {
      out += `<text class="axis-label" x="${x + barW / 2}" y="${H - 6}" text-anchor="middle">${esc(d.label)}</text>`;
    }
  });
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.innerHTML = out;
  svg._data = data;
  svg._geo = { m, band, barW, y };

  $("chartTitle").textContent = { day: "Sales per day, last 30 days", week: "Sales per week, last 12 weeks", month: "Sales per month, last 12 months" }[range];
  $("chartTable").innerHTML = `<tr><th>${range === "day" ? "Day" : range === "week" ? "Week of" : "Month"}</th><th>Orders</th><th>Sales</th></tr>` +
    data.slice().reverse().map((d) => `<tr><td>${esc(d.long || d.label)}</td><td>${d.count}</td><td>${money(d.total)}</td></tr>`).join("");
}

$("chart").addEventListener("mousemove", (e) => {
  const g = e.target.closest("g[data-i]");
  const svg = $("chart");
  svg.querySelectorAll("g.on").forEach((x) => x.classList.remove("on"));
  if (!g) { $("tip").hidden = true; return; }
  g.classList.add("on");
  const d = svg._data[+g.dataset.i];
  const { m, band, y } = svg._geo;
  const x = m.left + band * g.dataset.i + band / 2;
  const scale = svg.getBoundingClientRect().width / svg.viewBox.baseVal.width;
  const box = $("chartWrap").getBoundingClientRect();
  const svgBox = svg.getBoundingClientRect();
  $("tip").innerHTML = `<strong>${money(d.total)}</strong>${esc(d.long || d.label)}<br>${ordersLabel(d.count)}`;
  $("tip").style.left = svgBox.left - box.left + x * scale + "px";
  $("tip").style.top = svgBox.top - box.top + Math.min(y(d.total), m.top + 200) * scale + "px";
  $("tip").hidden = false;
});
$("chart").addEventListener("mouseleave", () => {
  $("tip").hidden = true;
  $("chart").querySelectorAll("g.on").forEach((x) => x.classList.remove("on"));
});

document.querySelector(".chart-head .seg").addEventListener("click", (e) => {
  const b = e.target.closest("[data-range]");
  if (!b) return;
  range = b.dataset.range;
  document.querySelectorAll("[data-range]").forEach((x) => x.setAttribute("aria-selected", x === b));
  renderChart();
});
let resizeTimer;
window.addEventListener("resize", () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(renderChart, 120); });

function renderAnalytics() {
  const now = new Date();
  const today = sumSince(+startOfDay(now));
  const week = sumSince(+startOfDay(now) - 6 * 864e5);
  const month = sumSince(+startOfDay(now) - 29 * 864e5);
  const all = sumSince(0);
  $("kToday").textContent = money(today.total); $("kTodayN").textContent = ordersLabel(today.count);
  $("kWeek").textContent = money(week.total); $("kWeekN").textContent = ordersLabel(week.count);
  $("kMonth").textContent = money(month.total); $("kMonthN").textContent = ordersLabel(month.count);
  $("kAll").textContent = money(all.total); $("kAllN").textContent = ordersLabel(all.count);

  // Top products by sales
  const byProduct = {};
  for (const o of paid()) for (const i of o.items) {
    const p = byProduct[i.name] || (byProduct[i.name] = { name: i.name, n: 0, total: 0 });
    p.n++; p.total += i.price;
  }
  const top = Object.values(byProduct).sort((a, b) => b.total - a.total).slice(0, 6);
  $("topProducts").innerHTML = top.length
    ? `<tr><th>Product</th><th>Sold</th><th>Sales</th></tr>` + top.map((p) => `<tr><td>${esc(p.name)}</td><td>${p.n}</td><td>${money(p.total)}</td></tr>`).join("")
    : `<tr><td class="muted">No sales yet</td></tr>`;
  renderChart();
}

function renderStats() {
  if (!stats) return;
  $("kOnline").textContent = stats.online;
  const v = stats.visits || {};
  const now = new Date();
  $("kVisitors").textContent = v[dayKey(now)] || 0;
  let seven = 0;
  for (let i = 0; i < 7; i++) { const d = new Date(now); d.setDate(d.getDate() - i); seven += v[dayKey(d)] || 0; }
  $("kVisitors7").textContent = `${seven} in the last 7 days`;
  $("kCustomers").textContent = stats.customers;
  $("kBalances").textContent = money(stats.balances);
  $("kPending").textContent = stats.pendingDeposits ? `${stats.pendingDeposits} deposit${stats.pendingDeposits === 1 ? "" : "s"} to review` : "Unspent customer funds";
  const names = { shop: "Shop", account: "Account page", login: "Log in page", owner: "Owner panel" };
  const pages = Object.entries(stats.pages).sort((a, b) => b[1] - a[1]);
  $("livePages").innerHTML = pages.length
    ? `<tr><th>Page</th><th>People</th></tr>` + pages.map(([p, n]) => `<tr><td>${esc(names[p] || p)}</td><td>${n}</td></tr>`).join("")
    : `<tr><td class="muted">Nobody right now</td></tr>`;
}

async function refreshStats() {
  try { stats = await ownerApi("GET", "/api/owner/stats"); renderStats(); } catch {}
}

/* ---------- products ---------- */

function renderRows() {
  $("rowsEmpty").hidden = products.length > 0;
  $("rows").innerHTML = products.map((p) => `<li class="row product">
    <div class="thumb">${p.image ? `<img src="${esc(p.image)}" alt="">` : esc(p.name[0].toUpperCase())}</div>
    <div class="row-main">
      <span class="row-title">${esc(p.name)}</span>
      <span class="row-meta"><span>${money(p.price)}</span><span>${esc(p.category)}</span><span>${p.published ? "In the shop" : "Hidden"}</span></span>
    </div>
    <div class="row-end">
      <button class="btn btn-ghost btn-sm" data-edit="${p.id}">Edit</button>
      <button class="btn btn-quiet btn-sm" data-delete="${p.id}">Delete</button>
    </div>
  </li>`).join("");
  $("catOptions").innerHTML = [...new Set(products.map((p) => p.category))].map((c) => `<option value="${esc(c)}">`).join("");
  renderCounts();
}

function renderPreview() {
  const src = imageData || (!removeImage && editing && editing.image);
  $("preview").innerHTML = src ? `<img src="${esc(src)}" alt="">` : "No picture";
  $("removeImage").hidden = !src;
}

function resetEditor(product = null) {
  const f = $("editor");
  editing = product;
  imageData = null;
  removeImage = false;
  f.reset();
  $("image").value = "";
  if (product) {
    f.name.value = product.name;
    f.price.value = product.price;
    f.category.value = product.category;
    f.description.value = product.description;
    f.published.checked = product.published;
  }
  $("editorTitle").textContent = product ? "Edit product" : "New product";
  $("saveBtn").textContent = product ? "Save changes" : "Create product";
  $("cancelBtn").hidden = !product;
  showError("editorError");
  renderPreview();
}

// Destructive buttons ask for a second click instead of a browser dialog.
function confirmClick(btn, label) {
  if (btn.dataset.armed) return true;
  const original = btn.textContent;
  btn.dataset.armed = "1";
  btn.textContent = label;
  btn.classList.add("btn-danger");
  setTimeout(() => { delete btn.dataset.armed; btn.textContent = original; btn.classList.remove("btn-danger"); }, 3000);
  return false;
}

$("rows").addEventListener("click", async (e) => {
  const t = e.target.closest("[data-edit], [data-delete]");
  if (!t) return;
  if (t.dataset.edit) {
    resetEditor(products.find((p) => p.id === t.dataset.edit));
    $("editor").scrollIntoView({ block: "nearest", behavior: "smooth" });
    $("editor").name.focus();
    return;
  }
  if (!confirmClick(t, "Click again to delete")) return;
  try {
    await ownerApi("DELETE", "/api/products/" + t.dataset.delete);
    products = products.filter((p) => p.id !== t.dataset.delete);
    if (editing && editing.id === t.dataset.delete) resetEditor();
    renderRows();
    toast("Product deleted");
  } catch (err) {
    toast(err.message);
  }
});

$("image").addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (!file) return;
  if (file.size > MAX_IMAGE) { e.target.value = ""; return showError("editorError", "Picture must be under 5 MB"); }
  const reader = new FileReader();
  reader.onload = () => { imageData = reader.result; removeImage = false; showError("editorError"); renderPreview(); };
  reader.readAsDataURL(file);
});

$("removeImage").addEventListener("click", () => {
  imageData = null;
  removeImage = true;
  $("image").value = "";
  renderPreview();
});

$("newBtn").addEventListener("click", () => { resetEditor(); $("editor").name.focus(); });
$("cancelBtn").addEventListener("click", () => resetEditor());

$("editor").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  const body = {
    name: f.name.value,
    price: f.price.value,
    category: f.category.value,
    description: f.description.value,
    published: f.published.checked,
    imageData,
    removeImage,
  };
  showError("editorError");
  $("saveBtn").disabled = true;
  try {
    if (editing) {
      const saved = await ownerApi("PUT", "/api/products/" + editing.id, body);
      products = products.map((p) => (p.id === saved.id ? saved : p));
      toast("Changes saved");
    } else {
      products.unshift(await ownerApi("POST", "/api/products", body));
      toast("Product created");
    }
    renderRows();
    resetEditor();
  } catch (err) {
    showError("editorError", err.message);
  } finally {
    $("saveBtn").disabled = false;
  }
});

/* ---------- orders ---------- */

function renderOrders() {
  $("ordersEmpty").hidden = orders.length > 0;
  $("orderRows").innerHTML = orders.map((o) => `<li class="row">
    <div class="row-main">
      <span class="row-title">#${esc(o.id)}, ${esc(o.username)}</span>
      <span class="row-items">${o.items.map((i) => esc(i.name)).join(", ")}</span>
      <span class="row-meta"><span>${when(o.createdAt)}</span><span>${o.items.length} item${o.items.length === 1 ? "" : "s"}</span></span>
    </div>
    <div class="row-end">
      <span class="row-amount">${money(o.total)}</span>${statusPill(o.status)}
      ${o.status === "Paid" ? `<button class="btn btn-quiet btn-sm" data-refund="${esc(o.id)}">Refund</button>` : ""}
    </div>
  </li>`).join("");
  renderCounts();
}

$("orderRows").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-refund]");
  if (!b || !confirmClick(b, "Click again to refund")) return;
  try {
    const updated = await ownerApi("PUT", "/api/orders/" + b.dataset.refund, { status: "Refunded" });
    Object.assign(orders.find((o) => o.id === updated.id), updated);
    renderOrders();
    renderAnalytics();
    refreshStats();
    toast(`Refunded ${money(updated.total)} to ${updated.username || "the customer"}'s balance`);
  } catch (err) {
    toast(err.message);
  }
});

/* ---------- deposits ---------- */

const COIN_NAMES = {};

function renderDeposits() {
  const sorted = deposits.slice().sort((a, b) => (a.status === "Pending") === (b.status === "Pending") ? b.createdAt - a.createdAt : a.status === "Pending" ? -1 : 1);
  $("depositsEmpty").hidden = deposits.length > 0;
  $("depositRows").innerHTML = sorted.map((d) => `<li class="row">
    <div class="row-main">
      <span class="row-title">${money(d.amount)} in ${esc(COIN_NAMES[d.coin] || d.coin)}, from ${esc(d.username)}</span>
      <span class="row-meta"><span>${when(d.createdAt)}</span>${d.status === "Approved" ? `<span>Credited ${money(d.credited)}</span>` : ""}</span>
      <span class="mono">Tx: ${esc(d.txid)}</span>
      <span class="mono muted">To: ${esc(d.address)}</span>
    </div>
    <div class="row-end">
      ${d.status === "Pending" ? `
        <label><span class="sr-only">Amount to credit</span><input type="number" step="0.01" min="0.01" value="${d.amount}" data-amount="${esc(d.id)}" class="credit-input"></label>
        <button class="btn btn-primary btn-sm" data-approve="${esc(d.id)}">Approve</button>
        <button class="btn btn-quiet btn-sm" data-reject="${esc(d.id)}">Reject</button>` : statusPill(d.status)}
    </div>
  </li>`).join("");
  renderCounts();
}

$("depositRows").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-approve], [data-reject]");
  if (!b) return;
  const id = b.dataset.approve || b.dataset.reject;
  const approve = !!b.dataset.approve;
  if (!approve && !confirmClick(b, "Click again to reject")) return;
  const amount = document.querySelector(`[data-amount="${id}"]`).value;
  b.disabled = true;
  try {
    const updated = await ownerApi("PUT", "/api/deposits/" + id, approve ? { status: "Approved", amount } : { status: "Rejected" });
    Object.assign(deposits.find((d) => d.id === id), updated);
    renderDeposits();
    refreshStats();
    toast(approve ? `Added ${money(updated.credited)} to the customer's balance` : "Deposit rejected");
  } catch (err) {
    toast(err.message);
    b.disabled = false;
  }
});

/* ---------- wallets ---------- */

async function loadWallets() {
  const { wallets, coins } = await ownerApi("GET", "/api/owner/settings");
  Object.assign(COIN_NAMES, coins);
  $("walletFields").innerHTML = Object.entries(coins).map(([code, name]) =>
    `<label class="field"><span>${esc(name)}</span><input class="mono" name="${esc(code)}" value="${esc(wallets[code] || "")}" placeholder="Wallet address" autocomplete="off" spellcheck="false"></label>`).join("");
}

$("walletForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  showError("walletError");
  const wallets = {};
  for (const input of $("walletFields").querySelectorAll("input")) wallets[input.name] = input.value.trim();
  try {
    await ownerApi("PUT", "/api/owner/settings", { wallets });
    toast("Wallets saved");
  } catch (err) {
    showError("walletError", err.message);
  }
});

/* ---------- start ---------- */

async function openDash() {
  await loadWallets();
  [products, orders, deposits, stats] = await Promise.all([
    ownerApi("GET", "/api/products?all"),
    ownerApi("GET", "/api/orders?all"),
    ownerApi("GET", "/api/deposits?all"),
    ownerApi("GET", "/api/owner/stats"),
  ]);
  show("dashView");
  renderRows();
  renderOrders();
  renderDeposits();
  resetEditor();
  openTab(location.hash.slice(1));
  renderAnalytics();
  renderStats();
  setInterval(refreshStats, 15000);
}

api("GET", "/api/me")
  .then((me) => (me.owner ? openDash() : showGate(me)))
  .catch(() => showGate());
