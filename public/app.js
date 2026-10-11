const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const money = (n) => "$" + Number(n).toFixed(2);

let products = [];
let user = null; // { email, owner } when logged in
const state = { cat: "all", q: "", sort: "new", min: "", max: "", cart: loadCart() };

function loadCart() {
  try { return JSON.parse(localStorage.getItem("ds-cart")) || []; } catch { return []; }
}
function saveCart() {
  try { localStorage.setItem("ds-cart", JSON.stringify(state.cart)); } catch {}
}

/* ---------- render ---------- */

function renderCats() {
  const counts = {};
  products.forEach((p) => { counts[p.category] = (counts[p.category] || 0) + 1; });
  const cats = [["all", "All products", products.length], ...Object.keys(counts).sort().map((c) => [c, c, counts[c]])];
  $("cats").innerHTML = cats.map(([key, label, n]) =>
    `<button class="cat" data-cat="${esc(key)}" aria-pressed="${state.cat === key}"><span>${esc(label)}</span><small>${n}</small></button>`).join("");
}

function visible() {
  const q = state.q.trim().toLowerCase();
  const min = state.min === "" ? -Infinity : Number(state.min);
  const max = state.max === "" ? Infinity : Number(state.max);
  const list = products.filter((p) =>
    (state.cat === "all" || p.category === state.cat) &&
    p.price >= min && p.price <= max &&
    (!q || (p.name + " " + p.description + " " + p.category).toLowerCase().includes(q)));
  if (state.sort === "low") list.sort((a, b) => a.price - b.price);
  if (state.sort === "high") list.sort((a, b) => b.price - a.price);
  if (state.sort === "name") list.sort((a, b) => a.name.localeCompare(b.name));
  return list;
}

function renderGrid() {
  const list = visible();
  $("grid").innerHTML = list.map((p) => {
    const inCart = state.cart.includes(p.id);
    return `<article class="card">
      <div class="card-img">
        ${p.image ? `<img src="${esc(p.image)}" alt="" loading="lazy">` : `<span class="initial">${esc(p.name[0].toUpperCase())}</span>`}
        <span class="tag">${esc(p.category)}</span>
      </div>
      <div class="card-body">
        <h3>${esc(p.name)}</h3>
        <p class="card-desc">${esc(p.description)}</p>
        <div class="card-price">${money(p.price)}</div>
        <button class="btn btn-solid btn-sm btn-block ${inCart ? "in" : ""}" data-add="${p.id}">${inCart ? "In cart ✓" : "Add to cart"}</button>
      </div>
    </article>`;
  }).join("");

  $("count").textContent = products.length ? `${list.length} product${list.length === 1 ? "" : "s"}` : "";
  $("empty").hidden = list.length > 0;
  $("emptyTitle").textContent = products.length ? "Nothing matches those filters" : "No products yet";
  $("emptyText").textContent = products.length ? "Try a different search or reset the filters." : "Check back soon.";
}

function renderCart() {
  const items = state.cart.map((id) => products.find((p) => p.id === id)).filter(Boolean);
  $("cartCount").textContent = items.length;
  $("cartItems").innerHTML = items.map((p) => `<li>
    <span class="name">${esc(p.name)}</span><span class="price">${money(p.price)}</span>
    <button class="link" data-add="${p.id}">Remove</button>
  </li>`).join("");
  $("cartEmpty").hidden = items.length > 0;
  $("cartTotal").textContent = money(items.reduce((sum, p) => sum + p.price, 0));
  $("checkout").disabled = items.length === 0;
  $("cartNote").hidden = !!user || items.length === 0;
}

function renderAccount() {
  $("account").innerHTML = user
    ? `<span class="account-email" title="${esc(user.email)}">${esc(user.email)}</span>${user.owner ? `<a class="btn btn-solid btn-sm" href="/owner">Owner panel</a>` : ""}<button class="btn btn-outline btn-sm" id="logout">Log out</button>`
    : `<a class="btn btn-outline btn-sm" href="/login">Log in</a><a class="btn btn-solid btn-sm" href="/login#signup">Sign up</a>`;
}

function render() { renderCats(); renderGrid(); renderCart(); }

/* ---------- events ---------- */

let toastTimer;
function toast(msg) {
  $("toast").textContent = msg;
  $("toast").classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $("toast").classList.remove("show"), 2200);
}

document.addEventListener("click", (e) => {
  const t = e.target.closest("[data-add], [data-cat]");
  if (!t) return;
  if (t.dataset.cat) {
    state.cat = t.dataset.cat;
  } else {
    const id = t.dataset.add;
    state.cart = state.cart.includes(id) ? state.cart.filter((x) => x !== id) : [...state.cart, id];
    saveCart();
  }
  render();
});

$("search").addEventListener("input", (e) => { state.q = e.target.value; renderGrid(); });
$("sort").addEventListener("change", (e) => { state.sort = e.target.value; renderGrid(); });
$("min").addEventListener("input", (e) => { state.min = e.target.value; renderGrid(); });
$("max").addEventListener("input", (e) => { state.max = e.target.value; renderGrid(); });
$("reset").addEventListener("click", () => {
  Object.assign(state, { cat: "all", q: "", min: "", max: "" });
  $("search").value = $("min").value = $("max").value = "";
  render();
});
// Hook this up to your payment provider (Stripe, Lemon Squeezy, Paddle, …).
$("checkout").addEventListener("click", () => {
  if (!user) { location.href = "/login"; return; }
  toast("Checkout isn't connected yet");
});

$("account").addEventListener("click", async (e) => {
  if (e.target.id !== "logout") return;
  await fetch("/api/user/logout", { method: "POST" }).catch(() => {});
  user = null;
  renderAccount();
  renderCart();
});

$("year").textContent = new Date().getFullYear();

renderAccount();
fetch("/api/me")
  .then((r) => r.json())
  .then((me) => { user = me.user && { ...me.user, owner: me.owner }; renderAccount(); renderCart(); })
  .catch(() => {});

fetch("/api/products")
  .then((r) => r.json())
  .then((list) => {
    products = list;
    state.cart = state.cart.filter((id) => products.some((p) => p.id === id));
    saveCart();
  })
  .catch(() => {})
  .finally(render);
