const TABS = ["orders", "downloads", "deposit", "settings"];
let me = null;
let orders = [];
let deposits = [];
let wallets = [];
let coin = null;

const STATUS_CLASS = { Paid: "good", Approved: "good", Pending: "wait", "Awaiting payment": "wait", Rejected: "bad", Refunded: "bad", Cancelled: "bad" };
const statusPill = (s) => `<span class="status ${STATUS_CLASS[s] || ""}">${esc(s)}</span>`;

async function authed(method, url, body) {
  try { return await api(method, url, body); } catch (err) {
    if (err.status === 401) location.href = "/login";
    throw err;
  }
}

/* ---------- tabs ---------- */

function openTab(name) {
  if (!TABS.includes(name)) name = "orders";
  document.querySelectorAll(".side-tab").forEach((b) => b.setAttribute("aria-selected", b.dataset.tab === name));
  TABS.forEach((t) => { $("tab-" + t).hidden = t !== name; });
  if (location.hash !== "#" + name) history.replaceState(null, "", "#" + name);
}
document.querySelector(".side-nav").addEventListener("click", (e) => {
  const b = e.target.closest("[data-tab]");
  if (b) openTab(b.dataset.tab);
});
window.addEventListener("hashchange", () => openTab(location.hash.slice(1)));

/* ---------- orders & downloads ---------- */

function renderBalance() {
  $("balance").textContent = money(me.balance);
  $("topBalance").textContent = money(me.balance);
}

function renderOrders() {
  $("ordersCount").textContent = orders.length || "";
  $("ordersEmpty").hidden = orders.length > 0;
  $("orders").innerHTML = orders.map((o) => `<li class="row">
    <div class="row-main">
      <span class="row-title">Order #${esc(o.id)}</span>
      <span class="row-items">${o.items.map((i) => esc(i.name)).join(", ")}</span>
      <span class="row-meta"><span>${when(o.createdAt)}</span><span>${o.items.length} item${o.items.length === 1 ? "" : "s"}</span></span>
    </div>
    <div class="row-end"><span class="row-amount">${money(o.total)}</span>${statusPill(o.status)}</div>
  </li>`).join("");

  const items = orders.filter((o) => o.status === "Paid").flatMap((o) => o.items.map((i) => ({ ...i, order: o.id, at: o.createdAt })));
  $("downloadsCount").textContent = items.length || "";
  $("downloadsEmpty").hidden = items.length > 0;
  $("downloads").innerHTML = items.map((i) => `<li class="row">
    <div class="row-main">
      <span class="row-title">${esc(i.name)}</span>
      <span class="row-meta"><span>Order #${esc(i.order)}</span><span>${day(i.at)}</span></span>
    </div>
    <button class="btn btn-ghost btn-sm" disabled title="File delivery isn't set up yet">Download</button>
  </li>`).join("");
}

/* ---------- deposit ---------- */

function renderWallets() {
  $("depositForm").hidden = wallets.length === 0;
  $("noWallets").hidden = wallets.length > 0;
  if (!wallets.length) return;
  if (!coin || !wallets.some((w) => w.code === coin)) coin = wallets[0].code;
  const w = wallets.find((x) => x.code === coin);
  $("coins").innerHTML = wallets.map((x) => `<button type="button" class="chip" data-coin="${esc(x.code)}" aria-pressed="${x.code === coin}">${esc(x.name)}</button>`).join("");
  $("address").textContent = w.address;
  $("network").textContent = w.name;
}

function renderDeposits() {
  $("depositsEmpty").hidden = deposits.length > 0;
  $("deposits").innerHTML = deposits.map((d) => {
    const name = (wallets.find((w) => w.code === d.coin) || {}).name || d.coin.replace("_", " ");
    const credited = d.status === "Approved" && d.credited !== d.amount ? ` (credited ${money(d.credited)})` : "";
    return `<li class="row">
      <div class="row-main">
        <span class="row-title">${money(d.amount)} in ${esc(name)}${credited}</span>
        <span class="row-meta"><span>${when(d.createdAt)}</span><span class="mono">${esc(d.txid.slice(0, 18))}…</span></span>
      </div>
      ${statusPill(d.status)}
    </li>`;
  }).join("");
}

$("coins").addEventListener("click", (e) => {
  const b = e.target.closest("[data-coin]");
  if (b) { coin = b.dataset.coin; renderWallets(); }
});

$("copy").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText($("address").textContent);
    toast("Address copied");
  } catch {
    getSelection().selectAllChildren($("address"));
    toast("Press Ctrl+C to copy");
  }
});

$("depForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  showError("depError");
  try {
    const d = await authed("POST", "/api/deposits", { coin, amount: f.amount.value, txid: f.txid.value });
    deposits.unshift(d);
    renderDeposits();
    f.reset();
    toast("Deposit submitted. It'll be added once confirmed.");
  } catch (err) {
    showError("depError", err.message);
  }
});

/* ---------- settings ---------- */

$("pwForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  showError("pwError");
  if (f.password.value !== f.confirm.value) return showError("pwError", "New passwords don't match");
  try {
    await authed("POST", "/api/user/password", { current: f.current.value, password: f.password.value, confirm: f.confirm.value });
    f.reset();
    toast("Password updated. Other devices were logged out.");
  } catch (err) {
    showError("pwError", err.message);
  }
});

$("delForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  showError("delError");
  try {
    await authed("POST", "/api/user/delete", { password: e.target.password.value });
    location.href = "/";
  } catch (err) {
    showError("delError", err.message);
  }
});

$("logout").addEventListener("click", async () => {
  await fetch("/api/user/logout", { method: "POST" }).catch(() => {});
  location.href = "/";
});

/* ---------- start ---------- */

(async () => {
  try {
    const res = await api("GET", "/api/me");
    if (!res.user) { location.href = "/login"; return; }
    me = res.user;
    $("username").textContent = me.username;
    $("avatar").textContent = me.username[0].toUpperCase();
    $("since").textContent = "Member since " + day(me.createdAt);
    $("ownerLink").hidden = !res.owner;
    $("delSection").hidden = res.owner; // the owner account can't be deleted
    [orders, deposits, wallets] = await Promise.all([
      authed("GET", "/api/orders"),
      authed("GET", "/api/deposits"),
      api("GET", "/api/wallets"),
    ]);
    renderBalance();
    renderOrders();
    renderWallets();
    renderDeposits();
    $("app").hidden = false;
    openTab(location.hash.slice(1));
    try {
      if (sessionStorage.getItem("ds-just-ordered")) {
        sessionStorage.removeItem("ds-just-ordered");
        toast("Order placed");
      }
    } catch {}
  } catch (err) {
    document.body.insertAdjacentHTML("beforeend", `<main class="auth"><div class="auth-card"><p class="error">${esc(err.message)}</p><a class="btn btn-ghost btn-block" href="/">Back to shop</a></div></main>`);
  }
})();
