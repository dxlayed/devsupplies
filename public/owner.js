const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const money = (n) => "$" + Number(n).toFixed(2);
const MAX_IMAGE = 5 * 1024 * 1024;

let products = [];
let editing = null;     // product being edited, or null for a new one
let imageData = null;   // newly chosen image as a data URL
let removeImage = false;

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) showGate();
  if (!res.ok) throw new Error(data.error || "Something went wrong");
  return data;
}

function show(view) {
  ["gateView", "dashView"].forEach((v) => { $(v).hidden = v !== view; });
  $("logout").hidden = view !== "dashView";
}

function showError(id, msg) {
  $(id).textContent = msg || "";
  $(id).hidden = !msg;
}

let toastTimer;
function toast(msg) {
  $("toast").textContent = msg;
  $("toast").classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $("toast").classList.remove("show"), 2200);
}

/* ---------- auth ---------- */

// The owner signs in through the normal /login page; this screen is shown to everyone else.
function showGate(me) {
  const wrongAccount = me && me.user;
  $("gateText").textContent = wrongAccount
    ? `You're logged in as ${me.user.email}, which isn't the owner account.`
    : "Log in with the owner email to manage products.";
  $("gateLogin").hidden = !!wrongAccount;
  show("gateView");
}

$("logout").addEventListener("click", async () => {
  await api("POST", "/api/user/logout").catch(() => {});
  showGate();
});

/* ---------- dashboard ---------- */

async function openDash() {
  products = await api("GET", "/api/products?all");
  show("dashView");
  renderRows();
  resetEditor();
}

function renderRows() {
  $("productCount").textContent = products.length;
  $("rowsEmpty").hidden = products.length > 0;
  $("rows").innerHTML = products.map((p) => `<li>
    <div class="thumb">${p.image ? `<img src="${esc(p.image)}" alt="">` : esc(p.name[0].toUpperCase())}</div>
    <div>
      <div class="name">${esc(p.name)}</div>
      <div class="meta">
        <span>${money(p.price)}</span><span>${esc(p.category)}</span>
        <span class="status ${p.published ? "live" : ""}">${p.published ? "Live" : "Hidden"}</span>
      </div>
    </div>
    <div class="actions">
      <button class="btn btn-outline btn-xs" data-edit="${p.id}">Edit</button>
      <button class="btn btn-outline btn-xs" data-delete="${p.id}">Delete</button>
    </div>
  </li>`).join("");
  $("catOptions").innerHTML = [...new Set(products.map((p) => p.category))].map((c) => `<option value="${esc(c)}">`).join("");
}

function renderPreview() {
  const src = imageData || (!removeImage && editing && editing.image);
  $("preview").innerHTML = src ? `<img src="${esc(src)}" alt="">` : "No image";
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

$("rows").addEventListener("click", async (e) => {
  const t = e.target.closest("[data-edit], [data-delete]");
  if (!t) return;
  if (t.dataset.edit) {
    resetEditor(products.find((p) => p.id === t.dataset.edit));
    $("editor").scrollIntoView({ block: "nearest" });
    $("editor").name.focus();
    return;
  }
  // Delete asks for a second click instead of a browser dialog.
  if (!t.classList.contains("btn-danger")) {
    t.classList.add("btn-danger");
    t.textContent = "Sure?";
    setTimeout(() => { t.classList.remove("btn-danger"); t.textContent = "Delete"; }, 3000);
    return;
  }
  try {
    await api("DELETE", "/api/products/" + t.dataset.delete);
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
  if (file.size > MAX_IMAGE) { e.target.value = ""; return showError("editorError", "Image must be under 5 MB"); }
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
      const saved = await api("PUT", "/api/products/" + editing.id, body);
      products = products.map((p) => (p.id === saved.id ? saved : p));
      toast("Changes saved");
    } else {
      products.unshift(await api("POST", "/api/products", body));
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

/* ---------- init ---------- */

api("GET", "/api/me")
  .then((me) => (me.owner ? openDash() : showGate(me)))
  .catch(() => showGate());
