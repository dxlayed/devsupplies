// Popup: shows status and the Connect button.
const $ = id => document.getElementById(id);
const API_URL = 'https://devsupplies.cc';

async function render() {
  const s = await chrome.storage.local.get(['key', 'token', 'account', 'status', 'device']);
  const connected = !!(s.token || s.key);
  $('connect').style.display = connected ? 'none' : 'block';
  $('disconnect').style.display = connected ? 'block' : 'none';
  $('connectedAs').textContent = connected ? ('Connected' + (s.account ? ' as ' + s.account : '')) : 'Not connected yet';
  $('openSite').href = API_URL + '/requests';

  const st = s.status || {};
  const el = $('state');
  el.textContent = st.message || 'Starting...';
  el.className = 'state ' + (st.state === 'ok' ? 'ok' : st.state === 'paused' || st.state === 'nokey' ? 'wait' : st.state ? 'bad' : '');
  $('rbx').textContent = st.roblox || '-';
  $('waiting').textContent = st.waiting ?? '-';
  $('last').textContent = st.lastSync ? new Date(st.lastSync).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' }) : '-';
}

$('connect').onclick = async () => {
  $('connectMsg').textContent = 'Opening the Waurks site... approve it there.';
  $('connectMsg').style.color = '';
  const r = await chrome.runtime.sendMessage({ type: 'connect' });
  if (r && !r.ok) { $('connectMsg').textContent = r.error; $('connectMsg').style.color = '#ff5470'; }
  else if (r && r.ok) { $('connectMsg').textContent = 'Connected!'; $('connectMsg').style.color = '#3ddc84'; }
  render();
};

$('disconnect').onclick = async () => {
  await chrome.storage.local.remove(['token', 'key', 'account']);
  $('connectMsg').textContent = 'Disconnected';
  render();
};

chrome.storage.onChanged.addListener(render);
render();
setInterval(render, 2000);
