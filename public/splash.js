// waurk smooth startup animation
(function () {
  function initSplash() {
    if (document.getElementById('waurkSplash')) return;
    
    // Check if user already saw splash in current browser tab session
    // (We also allow clicking anywhere or pressing any key to dismiss early)
    const splash = document.createElement('div');
    splash.className = 'waurk-splash';
    splash.id = 'waurkSplash';
    splash.title = 'Click or press any key to skip';
    splash.innerHTML = `
      <div class="splash-content">
        <div class="splash-brand">
          <span class="splash-brand-dot"></span>
          <span class="splash-brand-text">waurk</span>
        </div>
        <div class="splash-madeby">made by</div>
        <div class="splash-profile">
          <div class="splash-avatar-box">
            <img src="/waurk_pfp.png" alt="waurk." class="splash-avatar">
            <span class="splash-status-dot"></span>
          </div>
          <div class="splash-profile-text">
            <div class="splash-name">waurk</div>
            <div class="splash-handle">waurk.</div>
          </div>
        </div>
      </div>
    `;

    function dismiss() {
      if (splash.classList.contains('done')) return;
      splash.classList.add('done');
      setTimeout(() => {
        try { splash.remove(); } catch (e) {}
      }, 550);
    }

    splash.addEventListener('click', dismiss);
    window.addEventListener('keydown', dismiss, { once: true });

    // Auto-dismiss after full animation plays (~2.6s)
    setTimeout(dismiss, 2600);

    // Dynamically load profile from creator user in database
    fetch('/api/v1/creator-profile').then(r => r.json()).then(data => {
      if (data) {
        const avEl = splash.querySelector('.splash-avatar');
        const nameEl = splash.querySelector('.splash-name');
        const handleEl = splash.querySelector('.splash-handle');
        if (avEl && data.avatar) avEl.src = data.avatar;
        if (nameEl && data.username) nameEl.textContent = data.username;
        if (handleEl && data.tag) handleEl.textContent = data.tag;
      }
    }).catch(() => {});

    if (document.body) {
      document.body.prepend(splash);
    } else {
      document.addEventListener('DOMContentLoaded', () => document.body.prepend(splash));
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initSplash);
  } else {
    initSplash();
  }
})();
