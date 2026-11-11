/*
 * Waurks browser extension - content script.
 * In-browser bot filtering for roblox.com.
 * Matches Waurks website design: clean typography, dark surface, zero emojis.
 */

(() => {
  let botIds = new Set();
  let approvedIds = new Set();
  let serverTotalWaiting = 0;
  let filterMode = 'mm2';
  let showBots = false;

  // 1. Inject Waurks styles (no emojis, matches website design)
  const style = document.createElement('style');
  style.id = 'waurks-filter-styles';
  style.textContent = `
    .waurks-bot-hidden {
      display: none !important;
    }
    .waurks-verified-badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      background: rgba(61, 220, 132, 0.1);
      color: #3ddc84;
      border: 1px solid rgba(61, 220, 132, 0.3);
      border-radius: 999px;
      font-size: 11px;
      font-weight: 600;
      padding: 3px 10px;
      margin: 6px 0;
      width: fit-content;
      font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    }
    .waurks-bot-badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      background: rgba(255, 84, 112, 0.1);
      color: #ff5470;
      border: 1px solid rgba(255, 84, 112, 0.3);
      border-radius: 999px;
      font-size: 11px;
      font-weight: 600;
      padding: 3px 10px;
      margin: 6px 0;
      width: fit-content;
      font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    }
    #waurks-roblox-banner {
      background: rgba(18, 22, 41, 0.95);
      border: 1px solid #232948;
      border-radius: 12px;
      padding: 12px 18px;
      margin: 12px 0 18px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      flex-wrap: wrap;
      color: #f0f3fa;
      font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
      width: 100%;
      box-sizing: border-box;
    }
    #waurks-empty-state {
      background: rgba(18, 22, 41, 0.7);
      border: 1px solid #232948;
      border-radius: 12px;
      padding: 44px 20px;
      text-align: center;
      margin: 16px 0;
      font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    }
  `;
  if (document.head) document.head.appendChild(style);
  else document.addEventListener('DOMContentLoaded', () => document.head.appendChild(style));

  // 2. Read Roblox's page-level counter (e.g. from "Requests (290)" or sidebar badge)
  function getRobloxPageCount() {
    const headings = document.querySelectorAll('h1, h2, h3, a[href*="friend-requests"], .friends-title');
    for (const h of headings) {
      const text = h.textContent || '';
      const m = text.match(/Requests?\s*\(([0-9,]+)\+?\)/i);
      if (m) return parseInt(m[1].replace(/,/g, ''), 10);
    }
    const badge = document.querySelector('#nav-friends .badge, [data-link-id="friends"] .badge');
    if (badge) {
      const n = parseInt(badge.textContent.trim().replace(/,/g, ''), 10);
      if (n > 0) return n;
    }
    return 0;
  }

  // 3. Locate request cards on Roblox
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

  // 4. Update Roblox UI (Heading, Badges, Banner, and Empty State)
  function updateRobloxUi(totalBots, approvedCount) {
    const isRequestsPage = location.href.includes('/friends') || location.hash.includes('friend-requests');
    if (!isRequestsPage) return;

    // Update Roblox's heading: "Requests (290)" -> "Requests (0)" or "Requests (X)"
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

    // Inject or update the Waurks Banner
    let banner = document.getElementById('waurks-roblox-banner');
    if (!banner) {
      const targetArea = document.querySelector('.friends-content, #friends-container, .tab-content, [ng-controller="friendsController"], main') || document.body;
      banner = document.createElement('div');
      banner.id = 'waurks-roblox-banner';
      if (targetArea.firstChild) {
        targetArea.insertBefore(banner, targetArea.firstChild);
      } else {
        targetArea.appendChild(banner);
      }
    }

    banner.innerHTML = `
      <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
        <div style="display:inline-flex;align-items:center;gap:7px;font-size:11.5px;font-weight:700;color:#3ddc84;background:rgba(61,220,132,0.1);border:1px solid rgba(61,220,132,0.25);padding:4px 10px;border-radius:999px;letter-spacing:0.5px">
          <span style="width:7px;height:7px;border-radius:50%;background:#3ddc84;box-shadow:0 0 8px #3ddc84;display:inline-block"></span>
          LIVE
        </div>
        <div style="font-size:13.5px;color:#f0f3fa;font-weight:600">
          Filtered out <span style="color:#ff5470;font-weight:700">${totalBots}</span> bots <span style="color:#8b97ad;margin:0 4px">·</span> Showing <span style="color:#3ddc84;font-weight:700">${approvedCount}</span> real ${approvedCount === 1 ? 'person' : 'people'}
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:10px">
        <button id="waurks-toggle-bots-btn" style="background:rgba(255,255,255,0.05);border:1px solid #232948;color:#8b97ad;padding:6px 14px;border-radius:8px;font-size:12px;font-weight:600;cursor:pointer;transition:all 0.15s">
          ${showBots ? 'Hide filtered bots' : 'Show filtered bots'}
        </button>
        <a href="https://devsupplies.cc/requests" target="_blank" style="background:#7b5cfa;color:#fff;padding:6px 14px;border-radius:8px;font-size:12px;font-weight:600;text-decoration:none;display:inline-block">
          Waurks
        </a>
      </div>
    `;

    const btn = banner.querySelector('#waurks-toggle-bots-btn');
    if (btn) {
      btn.onclick = e => {
        e.preventDefault();
        showBots = !showBots;
        applyFilter();
      };
    }

    // Clean Empty State when all requests on Roblox are filtered bots
    let emptyNotice = document.getElementById('waurks-empty-state');
    if (approvedCount === 0 && totalBots > 0 && !showBots) {
      if (!emptyNotice) {
        emptyNotice = document.createElement('div');
        emptyNotice.id = 'waurks-empty-state';
        banner.insertAdjacentElement('afterend', emptyNotice);
      }
      emptyNotice.innerHTML = `
        <div style="font-size:15px;font-weight:700;color:#f0f3fa;margin-bottom:6px">No friend requests from real people right now</div>
        <div style="font-size:12.5px;color:#8b97ad">All ${totalBots} incoming bot requests have been filtered out automatically.</div>
      `;
      emptyNotice.style.display = 'block';
    } else if (emptyNotice) {
      emptyNotice.style.display = 'none';
    }
  }

  // 5. Card filtering logic
  function applyFilter() {
    const isRequestsPage = location.href.includes('/friends') || location.hash.includes('friend-requests');
    if (!isRequestsPage) return;

    const cards = getCards();
    let visibleApproved = 0;
    const pageCount = getRobloxPageCount();

    for (const item of cards) {
      const isBot = botIds.has(item.id);
      const isApproved = approvedIds.has(item.id);

      // In approved-only mode: only confirmed approved players are visible
      const shouldFilter = isBot || !isApproved;

      if (shouldFilter) {
        if (!showBots) {
          item.card.classList.add('waurks-bot-hidden');
          const b = item.card.querySelector('.waurks-bot-badge');
          if (b) b.remove();
        } else {
          item.card.classList.remove('waurks-bot-hidden');
          if (!item.card.querySelector('.waurks-bot-badge')) {
            const badge = document.createElement('div');
            badge.className = 'waurks-bot-badge';
            badge.textContent = '● Filtered Bot';
            item.card.prepend(badge);
          }
        }
      } else {
        visibleApproved++;
        item.card.classList.remove('waurks-bot-hidden');
        const botB = item.card.querySelector('.waurks-bot-badge');
        if (botB) botB.remove();

        if (isApproved && !item.card.querySelector('.waurks-verified-badge')) {
          const badge = document.createElement('div');
          badge.className = 'waurks-verified-badge';
          badge.textContent = `● Verified ${filterMode.toUpperCase()} Player`;
          item.card.prepend(badge);
        }
      }
    }

    // Accurate instantaneous total bot count:
    // Merges Roblox's page total (e.g. 290) with background worker total and known bot IDs
    const totalRequests = Math.max(serverTotalWaiting, pageCount, botIds.size, cards.length);
    const totalApproved = approvedIds.size > 0 ? approvedIds.size : visibleApproved;
    const totalBots = Math.max(0, totalRequests - totalApproved);

    updateRobloxUi(totalBots, totalApproved);
  }

  // 6. Listen for real-time filter updates from background worker
  chrome.runtime.onMessage.addListener(msg => {
    if (msg && msg.type === 'waurks-filter-update') {
      if (Array.isArray(msg.approvedIds)) approvedIds = new Set(msg.approvedIds.map(String));
      if (Array.isArray(msg.botIds)) botIds = new Set(msg.botIds.map(String));
      if (typeof msg.totalWaiting === 'number' && msg.totalWaiting > 0) serverTotalWaiting = msg.totalWaiting;
      if (msg.filter) filterMode = msg.filter;
      applyFilter();
    }
  });

  // 7. Request initial filter state and trigger an immediate sync
  try {
    chrome.runtime.sendMessage({ type: 'waurks-get-filter-state' }, res => {
      if (res && res.filterState) {
        const s = res.filterState;
        if (Array.isArray(s.approvedIds)) approvedIds = new Set(s.approvedIds.map(String));
        if (Array.isArray(s.botIds)) botIds = new Set(s.botIds.map(String));
        if (typeof s.totalWaiting === 'number' && s.totalWaiting > 0) serverTotalWaiting = s.totalWaiting;
        if (s.filter) filterMode = s.filter;
      }
      applyFilter();
    });
    // Trigger immediate sync on page load so all incoming bots are transmitted instantly
    chrome.runtime.sendMessage({ type: 'sync-now' });
  } catch (_) {}

  // 8. Observe DOM mutations (Roblox infinite scroll / dynamic navigation)
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

  // Re-run periodically to ensure zero delay
  setInterval(applyFilter, 800);
  applyFilter();
})();
