/*
 * Waurks browser extension - content script.
 * Runs on roblox.com to filter bot friend requests directly on the Roblox website.
 * Hides all spam bots from the screen and only displays real, approved players.
 */

(() => {
  let botIds = new Set();
  let approvedIds = new Set();
  let filterMode = 'mm2';
  let showBots = false; // Default: hide all bots so Roblox looks clean with zero effect from bot spam

  // 1. Inject styling for instant hiding
  const style = document.createElement('style');
  style.id = 'waurks-filter-styles';
  style.textContent = `
    .waurks-bot-hidden {
      display: none !important;
    }
    .waurks-verified-badge {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      background: rgba(61, 220, 132, 0.12);
      color: #3ddc84;
      border: 1px solid rgba(61, 220, 132, 0.35);
      border-radius: 4px;
      font-size: 11px;
      font-weight: 700;
      padding: 2px 7px;
      margin: 4px 0 6px 0;
      width: fit-content;
    }
    .waurks-bot-preview-badge {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      background: rgba(255, 84, 112, 0.12);
      color: #ff5470;
      border: 1px solid rgba(255, 84, 112, 0.35);
      border-radius: 4px;
      font-size: 11px;
      font-weight: 700;
      padding: 2px 7px;
      margin: 4px 0 6px 0;
      width: fit-content;
    }
    #waurks-roblox-banner {
      display: flex;
      align-items: center;
      justify-content: space-between;
      background: linear-gradient(90deg, #16192b, #1e1b4b);
      border: 1px solid rgba(123, 92, 250, 0.35);
      border-radius: 8px;
      padding: 10px 16px;
      margin: 12px 0 16px 0;
      color: #fff;
      font-family: "HCo Gotham", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      box-shadow: 0 4px 14px rgba(0, 0, 0, 0.3);
      width: 100%;
      box-sizing: border-box;
    }
  `;
  if (document.head) document.head.appendChild(style);
  else document.addEventListener('DOMContentLoaded', () => document.head.appendChild(style));

  // 2. Card locator on roblox.com friend requests
  function getCards() {
    const cards = [];
    const seen = new Set();
    const links = document.querySelectorAll('a[href*="/users/"]');

    for (const a of links) {
      const m = a.href.match(/\/users\/(\d+)/);
      if (!m) continue;
      const uid = m[1];

      // Climb up to find the card container
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

  // 3. Update Roblox Header & Filter Banner
  function updateRobloxUi(hiddenCount, approvedCount) {
    // Only update on friends / requests page
    const isRequestsPage = location.href.includes('/friends') || location.hash.includes('friend-requests');
    if (!isRequestsPage) return;

    // Update the Roblox tab / heading (e.g. "Requests (500+)" -> "Requests (1)")
    const headings = document.querySelectorAll('h1, h2, h3, a, span');
    for (const h of headings) {
      if (h.childNodes.length === 1 && typeof h.textContent === 'string') {
        const text = h.textContent.trim();
        if (/^Requests\s*\(\d+\+?\)$/i.test(text)) {
          h.textContent = `Requests (${approvedCount})`;
        }
      }
    }

    // Inject or update the Waurks Status Banner
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
      <div style="display:flex;align-items:center;gap:10px">
        <span style="font-size:16px">🛡️</span>
        <div>
          <span style="font-weight:700;font-size:13px;color:#fff">Waurks Anti-Bot Protection Active</span>
          <div style="font-size:11.5px;color:#94a3b8;margin-top:2px">
            Filtered out <b style="color:#ff5470">${hiddenCount}</b> bots · Showing <b style="color:#3ddc84">${approvedCount}</b> verified ${filterMode.toUpperCase()} player${approvedCount === 1 ? '' : 's'}
          </div>
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:8px">
        <button id="waurks-toggle-bots-btn" style="background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.2);color:#fff;border-radius:6px;padding:5px 12px;font-size:11.5px;cursor:pointer;font-weight:600;transition:all 0.2s">
          ${showBots ? 'Hide filtered bots' : 'Show hidden bots'}
        </button>
        <a href="https://devsupplies.cc/requests" target="_blank" style="background:#7b5cfa;color:#fff;border:none;border-radius:6px;padding:5px 12px;font-size:11.5px;text-decoration:none;font-weight:700">
          Waurks Dashboard
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
  }

  // 4. Main filter logic on Roblox cards
  function applyFilter() {
    const isRequestsPage = location.href.includes('/friends') || location.hash.includes('friend-requests');
    if (!isRequestsPage) return;

    const cards = getCards();
    let hiddenCount = 0;
    let approvedCount = 0;

    for (const item of cards) {
      const isBot = botIds.has(item.id);
      const isApproved = approvedIds.has(item.id);

      // In approved filter mode:
      // If confirmed bot, or NOT approved yet while we have an active filter list -> HIDE!
      const shouldFilter = isBot || (!isApproved && (approvedIds.size > 0 || botIds.size > 0));

      if (shouldFilter) {
        hiddenCount++;
        if (!showBots) {
          item.card.classList.add('waurks-bot-hidden');
          const badge = item.card.querySelector('.waurks-bot-preview-badge');
          if (badge) badge.remove();
        } else {
          item.card.classList.remove('waurks-bot-hidden');
          if (!item.card.querySelector('.waurks-bot-preview-badge')) {
            const badge = document.createElement('div');
            badge.className = 'waurks-bot-preview-badge';
            badge.textContent = '❌ Filtered Bot';
            item.card.prepend(badge);
          }
        }
      } else {
        approvedCount++;
        item.card.classList.remove('waurks-bot-hidden');
        const botBadge = item.card.querySelector('.waurks-bot-preview-badge');
        if (botBadge) botBadge.remove();

        if (isApproved && !item.card.querySelector('.waurks-verified-badge')) {
          const badge = document.createElement('div');
          badge.className = 'waurks-verified-badge';
          badge.innerHTML = `✓ ${filterMode.toUpperCase()} Verified Player`;
          item.card.prepend(badge);
        }
      }
    }

    updateRobloxUi(hiddenCount, approvedCount);
  }

  // 5. Message listener from background worker
  chrome.runtime.onMessage.addListener(msg => {
    if (msg && msg.type === 'waurks-filter-update') {
      if (Array.isArray(msg.approvedIds)) approvedIds = new Set(msg.approvedIds.map(String));
      if (Array.isArray(msg.botIds)) botIds = new Set(msg.botIds.map(String));
      if (msg.filter) filterMode = msg.filter;
      applyFilter();
    }
  });

  // 6. Request initial cached filter state
  try {
    chrome.runtime.sendMessage({ type: 'waurks-get-filter-state' }, res => {
      if (res && res.filterState) {
        const s = res.filterState;
        if (Array.isArray(s.approvedIds)) approvedIds = new Set(s.approvedIds.map(String));
        if (Array.isArray(s.botIds)) botIds = new Set(s.botIds.map(String));
        if (s.filter) filterMode = s.filter;
        applyFilter();
      }
    });
  } catch (_) {}

  // 7. Observe DOM mutations (Roblox infinite scrolling / dynamic tab changes)
  let filterTimer = null;
  const observer = new MutationObserver(() => {
    if (filterTimer) return;
    filterTimer = setTimeout(() => {
      filterTimer = null;
      applyFilter();
    }, 50);
  });

  observer.observe(document.body || document.documentElement, {
    childList: true,
    subtree: true
  });

  // Periodic safety check
  setInterval(applyFilter, 1000);
  applyFilter();
})();
