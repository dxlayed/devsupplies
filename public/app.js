let products = [];
let user = null; // { username, balance, owner } when logged in
const state = { cat: "all", q: "", sort: "new", cart: loadCart() };

function loadCart() {
  try { return JSON.parse(localStorage.getItem("ds-cart")) || []; } catch { return []; }
}
function saveCart() {
  try { localStorage.setItem("ds-cart", JSON.stringify(state.cart)); } catch {}
}
const cartProducts = () => state.cart.map((id) => products.find((p) => p.id === id)).filter(Boolean);

/* ---------- render ---------- */

function renderCats() {
  const counts = {};
  products.forEach((p) => { counts[p.category] = (counts[p.category] || 0) + 1; });
  const cats = [["all", "All"], ...Object.keys(counts).sort().map((c) => [c, c])];
  $("cats").innerHTML = cats.length > 1
    ? cats.map(([key, label]) => `<button class="chip" data-cat="${esc(key)}" aria-pressed="${state.cat === key}">${esc(label)}</button>`).join("")
    : "";
}

function visible() {
  const q = state.q.trim().toLowerCase();
  const list = products.filter((p) =>
    (state.cat === "all" || p.category === state.cat) &&
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
      <div class="card-media">
        ${p.image ? `<img src="${esc(p.image)}" alt="" loading="lazy">` : `<span class="initial" aria-hidden="true">${esc(p.name[0].toUpperCase())}</span>`}
      </div>
      <div class="card-body">
        <div class="card-row"><h3>${esc(p.name)}</h3><span class="price">${money(p.price)}</span></div>
        <span class="meta">${esc(p.category)}</span>
        ${p.description ? `<p class="desc">${esc(p.description)}</p>` : ""}
        <button class="btn ${inCart ? "btn-ghost in" : "btn-primary"} btn-sm" data-add="${p.id}">${inCart ? "In cart" : "Add to cart"}</button>
      </div>
    </article>`;
  }).join("");
  $("empty").hidden = list.length > 0;
  $("emptyTitle").textContent = products.length ? "Nothing matches that" : "No products yet";
  $("emptyText").textContent = products.length ? "Try another search or category." : "New products are on the way. Check back soon.";
}

function renderCart() {
  const items = cartProducts();
  const total = items.reduce((sum, p) => sum + p.price, 0);
  $("cartCount").textContent = items.length;
  $("cartItems").innerHTML = items.map((p) => `<li class="cart-line">
    <span class="thumb">${p.image ? `<img src="${esc(p.image)}" alt="">` : esc(p.name[0].toUpperCase())}</span>
    <div><div class="name">${esc(p.name)}</div><div class="price">${money(p.price)}</div></div>
    <button class="btn btn-quiet btn-sm" data-add="${p.id}">Remove</button>
  </li>`).join("");
  $("cartEmpty").hidden = items.length > 0;
  $("cartTotal").textContent = money(total);
  $("balanceRow").hidden = !user;
  if (user) $("balance").textContent = money(user.balance);
  $("checkout").disabled = items.length === 0;
  $("checkout").textContent = user ? "Pay with balance" : "Log in to check out";
  $("depositLink").hidden = !user || items.length === 0 || user.balance >= total;
}

function renderAccount() {
  $("account").innerHTML = user
    ? `<span class="top-actions">
        <a class="balance-chip" href="/account#deposit">Balance <strong>${money(user.balance)}</strong></a>
        ${user.owner ? `<a class="btn btn-ghost btn-sm" href="/owner">Owner</a>` : ""}
        <a class="btn btn-ghost btn-sm" href="/account">${esc(user.username)}</a>
      </span>`
    : `<span class="top-actions"><a class="btn btn-quiet btn-sm" href="/login">Log in</a><a class="btn btn-primary btn-sm" href="/login#signup">Sign up</a></span>`;
}

function render() { renderCats(); renderGrid(); renderCart(); }

/* ---------- cart drawer ---------- */

function openCart(open) {
  document.body.classList.toggle("cart-open", open);
  $("drawer").setAttribute("aria-hidden", !open);
  if (open) $("closeCart").focus();
}
$("cartBtn").addEventListener("click", () => openCart(true));
$("closeCart").addEventListener("click", () => openCart(false));
$("scrim").addEventListener("click", () => openCart(false));
document.addEventListener("keydown", (e) => { if (e.key === "Escape") openCart(false); });

/* ---------- events ---------- */

document.addEventListener("click", (e) => {
  const t = e.target.closest("[data-add], [data-cat]");
  if (!t) return;
  if (t.dataset.cat) {
    state.cat = t.dataset.cat;
  } else {
    const id = t.dataset.add;
    const adding = !state.cart.includes(id);
    state.cart = adding ? [...state.cart, id] : state.cart.filter((x) => x !== id);
    saveCart();
    if (adding) toast("Added to cart");
  }
  showError("cartError");
  render();
});

$("search").addEventListener("input", (e) => { state.q = e.target.value; renderGrid(); });
$("sort").addEventListener("change", (e) => { state.sort = e.target.value; renderGrid(); });

$("checkout").addEventListener("click", async () => {
  if (!user) { location.href = "/login"; return; }
  showError("cartError");
  $("checkout").disabled = true;
  try {
    await api("POST", "/api/orders", { items: state.cart });
    state.cart = [];
    saveCart();
    try { sessionStorage.setItem("ds-just-ordered", "1"); } catch {}
    location.href = "/account#orders";
  } catch (err) {
    showError("cartError", err.message);
    if (err.data && err.data.needsDeposit) $("depositLink").hidden = false;
    $("checkout").disabled = false;
  }
});

$("year").textContent = new Date().getFullYear();

/* ---------- start ---------- */

renderAccount();
api("GET", "/api/me")
  .then((me) => { user = me.user && { ...me.user, owner: me.owner }; renderAccount(); renderCart(); })
  .catch(() => {});

api("GET", "/api/products")
  .then((list) => {
    products = list;
    state.cart = state.cart.filter((id) => products.some((p) => p.id === id));
    saveCart();
  })
  .catch(() => {})
  .finally(render);
