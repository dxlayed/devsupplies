// Shared by every page: talking to the server, the top bar, footer, toasts, and helpers.
const DISCORD_URL = 'https://discord.gg/devsupplies';

let me = null;

// ── Helpers ───────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = n => '$' + (parseFloat(n) || 0).toFixed(2);
const ltcAmount = lit => (lit / 1e8).toFixed(8).replace(/0+$/, '').replace(/\.$/, '') + ' LTC';
const shortDate = s => (s || '').replace('T', ' ').slice(0, 16);

async function api(method, path, body) {
  const r = await fetch('/api' + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = {};
  try { data = await r.json(); } catch {}
  if (r.status === 401 && method !== 'GET' && path !== '/login') { location.href = '/login?next=' + encodeURIComponent(location.pathname); throw new Error('Login required.'); }
  if (!r.ok) throw new Error(data.error || 'Something went wrong.');
  return data;
}

function toast(msg, ms = 3000) {
  let t = $('toast');
  if (!t) { t = document.createElement('div'); t.id = 'toast'; t.className = 'toast'; document.body.appendChild(t); }
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
    <a class="bal" href="/deposit" title="Add funds"><span class="bal-amt">${money(me.balance)}</span><span class="bal-add">Deposit</span></a>
    <div class="chip-wrap">
      <div class="chip" onclick="toggleMenu()">
        <div class="avatar">${esc(me.username[0].toUpperCase())}</div>
        <span>${esc(me.username)}</span>
        <svg width="9" height="9" viewBox="0 0 9 9" fill="none"><path d="M1.5 3.5l3 3 3-3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </div>
      <div class="dropdown" id="dropdown">
        <a class="dd-item" href="/deposit" style="text-decoration:none">Deposit</a>
        <a class="dd-item" href="/orders" style="text-decoration:none">My Orders</a>
        ${me.role === 'owner' ? '<div class="dd-sep"></div><a class="dd-item" href="/owner" style="text-decoration:none">Owner Panel</a>' : ''}
        <div class="dd-sep"></div>
        <button class="dd-item" onclick="logout()">Log Out</button>
      </div>
    </div>` : `
    <a class="btn btn-ghost" href="/login">Log In</a>
    <a class="btn btn-white" href="/signup">Sign Up</a>`;
  nav.innerHTML = `
    <a class="logo" href="/"><span class="dot"></span>DevSupplies</a>
    <ul class="nav-links">
      <li><a href="/#prod" class="${here === '/' ? 'on' : ''}">Products</a></li>
      <li><a href="${DISCORD_URL}" target="_blank" rel="noopener">Discord</a></li>
    </ul>
    <div class="nav-right">${right}</div>`;
}

function toggleMenu() { $('dropdown')?.classList.toggle('open'); }
document.addEventListener('click', e => { if (!e.target.closest('.chip-wrap')) $('dropdown')?.classList.remove('open'); });

async function logout() {
  try { await api('POST', '/logout'); } catch {}
  location.href = '/';
}

function renderFooter() {
  const f = $('footer');
  if (!f) return;
  f.innerHTML = `
    <div class="foot-l">DevSupplies.cc</div>
    <a class="foot-r" href="${DISCORD_URL}" target="_blank" rel="noopener" style="text-decoration:none">discord.gg/devsupplies</a>`;
}

// Every page calls this first
async function startPage() {
  renderFooter();
  return loadMe();
}

// ── Product card image ────────────────────────────────────────
const _canvas = document.createElement('canvas');
function makeImg(p) {
  const W=640,H=360,el=_canvas;
  el.width=W;el.height=H;
  const c=el.getContext('2d');
  c.fillStyle='#000';c.fillRect(0,0,W,H);
  c.strokeStyle='rgba(255,255,255,.045)';c.lineWidth=1;
  for(let i=0;i<W;i+=48){c.beginPath();c.moveTo(i,0);c.lineTo(i,H);c.stroke()}
  for(let i=0;i<H;i+=48){c.beginPath();c.moveTo(0,i);c.lineTo(W,i);c.stroke()}
  c.save();c.font='900 220px "Space Grotesk",system-ui';c.fillStyle='rgba(255,255,255,.025)';c.textAlign='center';c.textBaseline='middle';c.fillText(p.code,W/2,H/2+8);c.restore();
  const vg=c.createRadialGradient(W/2,H/2,60,W/2,H/2,W*.72);vg.addColorStop(0,'rgba(255,255,255,.03)');vg.addColorStop(1,'rgba(0,0,0,0)');c.fillStyle=vg;c.fillRect(0,0,W,H);
  const pw=118,ph=198,px=W/2-pw/2,py=H/2-ph/2+4;
  c.save();
  c.strokeStyle='rgba(255,255,255,.55)';c.lineWidth=1.5;c.beginPath();c.roundRect(px,py,pw,ph,8);c.stroke();
  c.strokeStyle='rgba(255,255,255,.1)';c.lineWidth=1;c.beginPath();c.roundRect(px+5,py+12,pw-10,ph-24,4);c.stroke();
  c.strokeStyle='rgba(255,255,255,.18)';c.beginPath();c.moveTo(px+pw/2-14,py+7);c.lineTo(px+pw/2+14,py+7);c.stroke();
  c.restore();
  if(p.img_type==='studio'){
    c.save();c.strokeStyle='rgba(255,255,255,.22)';c.lineWidth=1;
    const cx=px+pw/2,cy=py+ph/2+10;
    c.beginPath();c.roundRect(cx-18,cy-12,36,26,3);c.stroke();
    c.beginPath();c.arc(cx,cy,8,0,Math.PI*2);c.stroke();
    c.beginPath();c.moveTo(cx-6,cy-18);c.lineTo(cx-3,cy-12);c.lineTo(cx+3,cy-12);c.lineTo(cx+6,cy-18);c.stroke();
    c.restore();
  }
  const bw=p.img_type==='studio'?80:46,bh=18,bx=px+pw/2-bw/2,by=py+18;
  c.save();c.fillStyle='#fff';c.beginPath();c.roundRect(bx,by,bw,bh,2);c.fill();
  c.font='800 9px "DM Mono",monospace';c.fillStyle='#000';c.textAlign='center';c.textBaseline='middle';
  c.fillText(p.img_type==='studio'?'LIVE STUDIO':'LIVE',bx+bw/2,by+bh/2+.5);c.restore();
  c.save();c.strokeStyle='rgba(255,255,255,.08)';c.lineWidth=1;c.beginPath();c.moveTo(24,H-54);c.lineTo(W-24,H-54);c.stroke();c.restore();
  c.save();c.font='500 9px "DM Mono",monospace';c.fillStyle='rgba(255,255,255,.3)';c.textAlign='left';c.textBaseline='alphabetic';c.fillText(p.region.toUpperCase(),24,H-34);c.restore();
  c.save();c.font='700 26px "Space Grotesk",system-ui';c.fillStyle='#fff';c.textAlign='right';c.textBaseline='alphabetic';c.fillText('$'+parseFloat(p.price).toFixed(2),W-24,H-28);c.restore();
  c.save();c.font='400 9px "DM Mono",monospace';c.fillStyle='rgba(255,255,255,.18)';c.textAlign='right';c.textBaseline='top';c.fillText('DEVSUPPLIES.CC',W-16,14);c.restore();
  const cm=14,co=12;c.save();c.strokeStyle='rgba(255,255,255,.12)';c.lineWidth=1;
  [[co,co+cm,co,co,co+cm,co],[W-co-cm,co,W-co,co,W-co,co+cm],[co,H-co-cm,co,H-co,co+cm,H-co],[W-co-cm,H-co,W-co,H-co,W-co,H-co-cm]].forEach(([x1,y1,x2,y2,x3,y3])=>{c.beginPath();c.moveTo(x1,y1);c.lineTo(x2,y2);c.lineTo(x3,y3);c.stroke()});
  c.restore();
  return el.toDataURL('image/png');
}
