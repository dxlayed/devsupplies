// Shared by every page: talking to the server, the top bar, footer, toasts, and helpers.
const DISCORD_URL = 'https://discord.gg/devsupplies';

let me = null;

// ── Helpers ───────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = n => '$' + (parseFloat(n) || 0).toFixed(2);
const ltcAmount = lit => (lit / 1e8).toFixed(8).replace(/0+$/, '').replace(/\.$/, '') + ' LTC';
const shortDate = s => {
  const d = new Date(String(s || '').replace(' ', 'T') + 'Z');
  return isNaN(d) ? (s || '') : d.toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
};

// The split wordmark used across the site
const splitMark = text => `<span class="split" aria-hidden="true"><span class="s-top">${esc(text)}</span><span class="s-bot">${esc(text)}</span></span>`;

const ICONS = {
  discord: '<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M20.317 4.3698a19.7913 19.7913 0 00-4.8851-1.5152.0741.0741 0 00-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 00-.0785-.037 19.7363 19.7363 0 00-4.8852 1.515.0699.0699 0 00-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 00.0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 00.0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 00-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 01-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 01.0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 01.0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 01-.0066.1276 12.2986 12.2986 0 01-1.873.8914.0766.0766 0 00-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 00.0842.0286c1.961-.6067 3.9495-1.5219 6.0023-3.0294a.077.077 0 00.0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 00-.0312-.0286zM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.9555 2.4189-2.1569 2.4189zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9554-2.4189 2.1569-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.946 2.4189-2.1568 2.4189Z"/></svg>',
  left: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M10 3.5 5.5 8l4.5 4.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  right: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M6 3.5 10.5 8 6 12.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  close: '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true"><path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
};

async function api(method, path, body) {
  const r = await fetch('/api' + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = {};
  try { data = await r.json(); } catch {}
  if (r.status === 401 && method !== 'GET' && path !== '/login') { location.href = '/login?next=' + encodeURIComponent(location.pathname); throw new Error('Log in to continue.'); }
  if (!r.ok) throw new Error(data.error || 'Something went wrong. Try again.');
  return data;
}

function toast(msg, ms = 3200) {
  let t = $('toast');
  if (!t) { t = document.createElement('div'); t.id = 'toast'; t.className = 'toast'; t.setAttribute('role', 'status'); document.body.appendChild(t); }
  t.textContent = msg; t.classList.add('show');
  clearTimeout(t._t); t._t = setTimeout(() => t.classList.remove('show'), ms);
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); toast('Copied.'); }
  catch {
    const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); toast('Copied.'); } catch { toast('Select the text and copy it manually.'); }
    ta.remove();
  }
}

function openDlg(id) { $(id).classList.add('open'); }
function closeDlg(id) { $(id).classList.remove('open'); }
document.addEventListener('keydown', e => { if (e.key === 'Escape') document.querySelectorAll('.dialog.open').forEach(d => d.classList.remove('open')); });
document.addEventListener('click', e => { if (e.target.classList?.contains('dialog')) e.target.classList.remove('open'); });

// ── Top bar + footer ──────────────────────────────────────────
async function loadMe() {
  try { me = (await api('GET', '/me')).user; } catch { me = null; }
  renderNav();
  return me;
}

function renderNav() {
  const nav = $('nav');
  if (!nav) return;
  const here = location.pathname;
  const right = me ? `
    <a class="balance" href="/deposit" title="Add funds">
      <span class="balance-amt">${money(me.balance)}</span><span class="balance-add">Add funds</span>
    </a>
    <div class="menu">
      <button class="avatar-btn" onclick="toggleMenu()" aria-label="Account menu" aria-haspopup="true">${esc(me.username[0].toUpperCase())}</button>
      <div class="dropdown" id="dropdown">
        <div class="dropdown-who"><strong>${esc(me.username)}</strong>Balance ${money(me.balance)}</div>
        <div class="dd-sep"></div>
        <a class="dd-item" href="/deposit">Add funds</a>
        <a class="dd-item" href="/orders">My orders</a>
        ${me.role === 'owner' ? '<a class="dd-item" href="/owner">Owner panel</a>' : ''}
        <div class="dd-sep"></div>
        <button class="dd-item" onclick="logout()">Log out</button>
      </div>
    </div>` : `
    <a class="btn btn-ghost btn-sm" href="/login">Log in</a>
    <a class="btn btn-white btn-sm" href="/signup">Sign up</a>`;
  nav.className = 'topbar';
  nav.innerHTML = `
    <div class="topbar-in">
      <a class="brand" href="/" aria-label="DevSupplies home">${splitMark('Dev')}<span class="brand-name">DevSupplies</span></a>
      <ul class="nav-links">
        <li><a href="/#deals">Deals</a></li>
        <li><a href="/#accounts">Accounts</a></li>
        ${me ? `<li><a href="/orders" class="${here === '/orders' ? 'on' : ''}">My orders</a></li>` : ''}
        <li><a href="${DISCORD_URL}" target="_blank" rel="noopener">Discord</a></li>
      </ul>
      <div class="nav-right">${right}</div>
    </div>`;
}

function toggleMenu() { $('dropdown')?.classList.toggle('open'); }
document.addEventListener('click', e => { if (!e.target.closest('.menu')) $('dropdown')?.classList.remove('open'); });

async function logout() {
  try { await api('POST', '/logout'); } catch {}
  location.href = '/';
}

function renderFooter() {
  const f = $('footer');
  if (!f) return;
  f.className = 'footer';
  f.innerHTML = `
    <div class="wrap footer-in">
      <a class="brand" href="/" aria-label="DevSupplies home">${splitMark('Dev')}<span class="brand-name">DevSupplies</span></a>
      <ul class="footer-links">
        <li><a href="/#deals">Deals</a></li>
        <li><a href="/#accounts">Accounts</a></li>
        <li><a href="/orders">My orders</a></li>
        <li><a href="/deposit">Add funds</a></li>
        <li><a href="${DISCORD_URL}" target="_blank" rel="noopener">discord.gg/devsupplies</a></li>
      </ul>
      <p class="footer-copy">&copy; ${new Date().getFullYear()} devsupplies.cc</p>
    </div>`;
}

// Every page calls this first
async function startPage() {
  renderFooter();
  return loadMe();
}

// Wait for the display font so canvas artwork uses it
function fontsReady() {
  if (!document.fonts) return Promise.resolve();
  return Promise.all([document.fonts.load('900 200px Outfit'), document.fonts.load('600 20px Inter')]).catch(() => {}).then(() => document.fonts.ready);
}

// ── Product artwork: region code in the split style, laser line, label ──
const _canvas = document.createElement('canvas');
function makeImg(p) {
  const W = 960, H = 600, c = (_canvas.width = W, _canvas.height = H, _canvas.getContext('2d'));
  c.fillStyle = '#000'; c.fillRect(0, 0, W, H);
  const g = c.createRadialGradient(W / 2, H / 2, 20, W / 2, H / 2, W * .6);
  g.addColorStop(0, 'rgba(255,255,255,.11)'); g.addColorStop(.5, 'rgba(255,255,255,.03)'); g.addColorStop(1, 'rgba(0,0,0,0)');
  c.fillStyle = g; c.fillRect(0, 0, W, H);

  // laser
  const lx1 = W * .6, lx2 = W * .4;
  c.save(); c.strokeStyle = '#fff';
  [[40, .05], [14, .14], [5, .35], [1.6, .95]].forEach(([w, a]) => { c.globalAlpha = a; c.lineWidth = w; c.beginPath(); c.moveTo(lx1, -10); c.lineTo(lx2, H + 10); c.stroke(); });
  c.restore();

  // split region code
  const size = 330, cx = W / 2, base = H / 2 + size * .36;
  const cutAt = x => H / 2 + 34 - (x - cx) * .1;
  c.font = `900 ${size}px Outfit, "Arial Black", sans-serif`; c.textAlign = 'center'; c.textBaseline = 'alphabetic';
  const clip = (below, fn) => { c.save(); c.beginPath(); if (below) { c.moveTo(0, cutAt(0)); c.lineTo(W, cutAt(W)); c.lineTo(W, H); c.lineTo(0, H); } else { c.moveTo(0, 0); c.lineTo(W, 0); c.lineTo(W, cutAt(W)); c.lineTo(0, cutAt(0)); } c.closePath(); c.clip(); fn(); c.restore(); };
  clip(true, () => { c.translate(-14, 11); c.fillStyle = '#8e8e8e'; c.fillText(p.code, cx, base); });
  clip(false, () => { c.fillStyle = '#f4f4f4'; c.fillText(p.code, cx, base); });

  // label pill
  const label = p.img_type === 'studio' ? 'Live studio + live access' : 'Live access';
  c.font = '600 22px Inter, system-ui, sans-serif';
  const tw = c.measureText(label).width, px = 36, py = H - 36 - 44;
  c.fillStyle = 'rgba(0,0,0,.6)'; c.strokeStyle = 'rgba(255,255,255,.85)'; c.lineWidth = 1.5;
  c.beginPath(); c.roundRect(px, py, tw + 44, 44, 22); c.fill(); c.stroke();
  c.fillStyle = '#f4f4f4'; c.textAlign = 'left'; c.textBaseline = 'middle'; c.fillText(label, px + 22, py + 23);

  // watermark
  c.font = '500 20px Inter, system-ui, sans-serif'; c.fillStyle = 'rgba(255,255,255,.4)'; c.textAlign = 'right'; c.textBaseline = 'top';
  c.fillText('devsupplies.cc', W - 36, 34);
  return _canvas.toDataURL('image/png');
}
