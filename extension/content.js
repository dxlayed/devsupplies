/*
 * Waurks browser extension - content script.
 * In-browser bot filtering for roblox.com.
 * Invisible, native filtering: hides bot requests with zero layout distortion ("looks like no effect").
 * ZERO emojis, zero intrusive banners, zero foreign empty state blocks.
 */

(() => {
  let botIds = new Set();
  let approvedIds = new Set();
  let filterMode = 'mm2';

  // 1. Inject minimal hiding style
  const style = document.createElement('style');
  style.id = 'waurks-filter-styles';
  style.textContent = `
    .waurks-bot-hidden {
      display: none !important;
    }
  `;
  if (document.head) document.head.appendChild(style);
  else document.addEventListener('DOMContentLoaded', () => document.head.appendChild(style));

  // Remove any legacy injected banners or empty state boxes
  function cleanupLegacyElements() {
    const banner = document.getElementById('waurks-roblox-banner');
    if (banner) banner.remove();
    const emptyNotice = document.getElementById('waurks-empty-state');
    if (emptyNotice) emptyNotice.remove();
    const badges = document.querySelectorAll('.waurks-bot-badge, .waurks-verified-badge');
    for (const b of badges) b.remove();
  }

  // 2. Locate friend request cards on Roblox
  function getCards() {
    const cards = [];
    const seen = new Set();
    const links = document.querySelectorAll('a[href*="/users/"]');

    for (const a of links) {
      const m = a.href.match(/\/users\/(\d+)/);
      if (!m) continue;
      const uid = m[1];

      let el = a.parentElement;
      let cardContainer = null;
      for (let i = 0; i < 8 && el && el !== document.body; i++) {
        if (el.tagName === 'LI' || el.classList.contains('avatar-card') || el.classList.contains('list-item')) {
          cardContainer = el;
          break;
        }
        const text = el.innerText || '';
        if ((text.includes('Accept') || text.includes('Ignore')) && el.querySelector('button')) {
          cardContainer = el;
        }
        el = el.parentElement;
      }

      if (cardContainer && !seen.has(cardContainer)) {
        seen.add(cardContainer);
        cards.push({ card: cardContainer, id: uid });
      }
    }
    return cards;
  }

  // 3. Update Roblox's native counters (Requests header & sidebar badge)
  function updateRobloxCounters(approvedCount) {
    const isRequestsPage = location.href.includes('/friends') || location.hash.includes('friend-requests');
    if (!isRequestsPage) return;

    // Update Roblox's native heading: e.g. "Requests (500+)" -> "Requests (0)" or "Requests (1)"
    const headings = document.querySelectorAll('h1, h2, h3, a, span');
    for (const h of headings) {
      if (h.childNodes.length === 1 && typeof h.textContent === 'string') {
        const text = h.textContent.trim();
        if (/^Requests\s*\(\d+\+?\)$/i.test(text)) {
          h.textContent = `Requests (${approvedCount})`;
        }
      }
    }

    // Update left sidebar badge on Roblox
    const navBadge = document.querySelector('#nav-friends .badge, [data-link-id="friends"] .badge');
    if (navBadge) {
      if (approvedCount > 0) {
        navBadge.textContent = String(approvedCount);
        navBadge.style.display = '';
      } else {
        navBadge.textContent = '0';
        navBadge.style.display = 'none';
      }
    }
  }

  // 4. Clean card filtering: hides bots silently with display: none !important
  function applyFilter() {
    cleanupLegacyElements();

    const isRequestsPage = location.href.includes('/friends') || location.hash.includes('friend-requests');
    if (!isRequestsPage) return;

    const cards = getCards();
    let visibleApproved = 0;

    for (const item of cards) {
      const isBot = botIds.has(item.id);
      const isApproved = approvedIds.has(item.id);

      // In verified-only mode: only confirmed approved players are visible
      const shouldFilter = isBot || !isApproved;

      if (shouldFilter) {
        item.card.classList.add('waurks-bot-hidden');
      } else {
        visibleApproved++;
        item.card.classList.remove('waurks-bot-hidden');
      }
    }

    // Reflect the verified count cleanly on native Roblox UI
    const totalApproved = approvedIds.size > 0 ? approvedIds.size : visibleApproved;
    updateRobloxCounters(totalApproved);
  }

  // 5. Real-time updates from background worker
  chrome.runtime.onMessage.addListener(msg => {
    if (msg && msg.type === 'waurks-filter-update') {
      if (Array.isArray(msg.approvedIds)) approvedIds = new Set(msg.approvedIds.map(String));
      if (Array.isArray(msg.botIds)) botIds = new Set(msg.botIds.map(String));
      if (msg.filter) filterMode = msg.filter;
      applyFilter();
    }
  });

  // 6. Request initial filter state & trigger sync
  try {
    chrome.runtime.sendMessage({ type: 'waurks-get-filter-state' }, res => {
      if (res && res.filterState) {
        const s = res.filterState;
        if (Array.isArray(s.approvedIds)) approvedIds = new Set(s.approvedIds.map(String));
        if (Array.isArray(s.botIds)) botIds = new Set(s.botIds.map(String));
        if (s.filter) filterMode = s.filter;
      }
      applyFilter();
    });
    // Trigger immediate sync on page load so all incoming bots are transmitted instantly
    chrome.runtime.sendMessage({ type: 'sync-now' });
  } catch (_) {}

  // 7. Observe DOM mutations (Roblox pagination & infinite scrolling)
  let filterTimer = null;
  const observer = new MutationObserver(() => {
    if (filterTimer) return;
    filterTimer = setTimeout(() => {
      filterTimer = null;
      applyFilter();
    }, 40);
  });

  observer.observe(document.body || document.documentElement, {
    childList: true,
    subtree: true
  });

  setInterval(applyFilter, 800);
  applyFilter();
})();
