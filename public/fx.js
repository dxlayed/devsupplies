// Waurks site effects: things slide in as you scroll, and cards tilt in 3D toward your mouse.
(function () {
  const reduce = false; // always animate
  const touch = matchMedia('(hover: none)').matches;

  const css = document.createElement('style');
  css.textContent = `
    .fx-rv{opacity:0;translate:0 34px;transition:opacity .8s cubic-bezier(.2,.8,.2,1),translate .8s cubic-bezier(.2,.8,.2,1)}
    .fx-rv.in{opacity:1;translate:0 0}
    .fx-tilt{transform:perspective(1000px) rotateX(var(--rx,0deg)) rotateY(var(--ry,0deg)) translateZ(0);transition:transform .25s ease-out;transform-style:preserve-3d;position:relative}
    .fx-tilt.fx-moving{transition:transform .08s linear}
    .fx-glare{position:absolute;inset:0;border-radius:inherit;pointer-events:none;opacity:0;transition:opacity .3s;
      background:radial-gradient(420px circle at var(--mx,50%) var(--my,50%),rgba(196,181,253,.16),transparent 60%);z-index:1}
    .fx-tilt:hover .fx-glare{opacity:1}
    .btn{will-change:transform}
    .btn:hover:not(:disabled){translate:0 -2px}
  `;
  document.head.appendChild(css);

  // Slide in on scroll
  const rv = document.querySelectorAll('[data-rv], .box, .plan, .stat, .game, .faq details, section.part h2, section.part p.lead, .pill, .card');
  if (!reduce && 'IntersectionObserver' in window) {
    const io = new IntersectionObserver(es => es.forEach(e => {
      if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
    }), { threshold: .12, rootMargin: '0px 0px -40px 0px' });
    let i = 0;
    rv.forEach(el => {
      if (el.closest('.fx-no')) return;
      el.classList.add('fx-rv');
      el.style.transitionDelay = (i++ % 4) * 70 + 'ms';
      io.observe(el);
    });
    // Anything already on screen shows right away
    requestAnimationFrame(() => rv.forEach(el => { const r = el.getBoundingClientRect(); if (r.top < innerHeight) el.classList.add('in'); }));
  }

  // 3D tilt toward the mouse
  if (reduce || touch) return;
  const tilts = document.querySelectorAll('[data-tilt], .plan, .game, .stat, .how .box, .card');
  tilts.forEach(el => {
    if (el.getBoundingClientRect().width > 760) return; // big panels stay flat
    const max = +(el.dataset.tilt || 9);
    el.classList.add('fx-tilt');
    if (getComputedStyle(el).overflow !== 'visible' || el.classList.contains('plan')) {
      const g = document.createElement('i'); g.className = 'fx-glare'; el.appendChild(g);
    }
    el.addEventListener('mousemove', e => {
      const r = el.getBoundingClientRect(), x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
      el.classList.add('fx-moving');
      el.style.setProperty('--ry', ((x - .5) * max * 2).toFixed(2) + 'deg');
      el.style.setProperty('--rx', ((.5 - y) * max * 2).toFixed(2) + 'deg');
      el.style.setProperty('--mx', x * 100 + '%'); el.style.setProperty('--my', y * 100 + '%');
    });
    el.addEventListener('mouseleave', () => { el.classList.remove('fx-moving'); el.style.setProperty('--rx', '0deg'); el.style.setProperty('--ry', '0deg'); });
  });
})();
