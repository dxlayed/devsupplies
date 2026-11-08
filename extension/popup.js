// Popup: shows status and lets you enter your key. No filtering logic here either.
const $ = id => document.getElementById(id);
const DEFAULT_API = 'https://devsupplies.cc';

async function render() {
  const s = await chrome.storage.local.get(['key', 'apiBase', 'status', 'device']);
  const api = (s.apiBase || DEFAULT_API).replace(/\/+$/, '');
  $('key').value = s.key || '';
  $('api').value = s.apiBase || '';
  $('openSite').href = api + '/requests';

  const st = s.status || {};
  const el = $('state');
  el.textContent = st.message || 'Starting...';
  el.className = 'state ' + (st.state === 'ok' ? 'ok' : st.state === 'paused' || st.state === 'nokey' ? 'wait' : st.state ? 'bad' : '');
  $('rbx').textContent = st.roblox || '-';
  $('waiting').textContent = st.waiting ?? '-';
  $('last').textContent = st.lastSync ? new Date(st.lastSync).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' }) : '-';
}

$('save').onclick = async () => {
  const key = $('key').value.trim();
  const { apiBase, device } = await chrome.storage.local.get(['apiBase', 'device']);
  $('keyMsg').textContent = 'Checking...';
  try {
    const r = await fetch((apiBase || DEFAULT_API).replace(/\/+$/, '') + '/api/v1/ext/check', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key, device })
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'That key did not work');
    await chrome.storage.local.set({ key });
    $('keyMsg').textContent = 'Saved. Plan: ' + d.plan + (d.daysLeft ? ` (${d.daysLeft} days left)` : '');
    $('keyMsg').style.color = '#3ddc84';
    chrome.runtime.sendMessage({ type: 'sync-now' });
  } catch (e) {
    $('keyMsg').textContent = e.message;
    $('keyMsg').style.color = '#ff5470';
  }
};

$('saveApi').onclick = async () => {
  const v = $('api').value.trim();
  await chrome.storage.local.set({ apiBase: v || '' });
  chrome.runtime.sendMessage({ type: 'sync-now' });
  render();
};

chrome.storage.onChanged.addListener(render);
render();
setInterval(render, 2000);
