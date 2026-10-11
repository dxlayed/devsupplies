// Shared helpers for every page. Loaded before the page's own script.
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const money = (n) => "$" + Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const day = (t) => new Date(t).toLocaleDateString(undefined, { dateStyle: "medium" });
const when = (t) => new Date(t).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
const NO_SERVER = "Can't reach the server. The site has to be running server.js (node server.js).";

// JSON request to the server. Throws an Error with the server's message on failure.
async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  }).catch(() => { throw new Error(NO_SERVER); });
  if (!/application\/json/.test(res.headers.get("content-type") || "")) throw new Error(NO_SERVER);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || "Something went wrong");
    Object.assign(err, { status: res.status, data });
    throw err;
  }
  return data;
}

let toastTimer;
function toast(msg) {
  const el = $("toast");
  if (!el) return;
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2600);
}

function showError(id, msg) {
  $(id).textContent = msg || "";
  $(id).hidden = !msg;
}

// Tells the server this tab is open, so the owner can see how many people are online.
(function heartbeat() {
  let id;
  try { id = sessionStorage.getItem("ds-visitor"); } catch {}
  if (!id) {
    id = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
    try { sessionStorage.setItem("ds-visitor", id); } catch {}
  }
  const page = location.pathname.replace(/^\/|\.html$/g, "") || "shop";
  const ping = () => {
    if (document.visibilityState === "hidden") return;
    fetch("/api/ping", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, page }),
      keepalive: true,
    }).catch(() => {});
  };
  ping();
  setInterval(ping, 30000);
  document.addEventListener("visibilitychange", ping);
})();
