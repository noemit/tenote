'use strict';

module.exports = function ageBadges(tenote) {
  let days = Number(tenote.settings.get('days', 7)) || 7;

  tenote.ui.styles.add(`
    .aged .rt, .aged .rs, .aged .t, .aged .s { opacity: 0.45; }
    .aged { position: relative; }
    .aged::after {
      content: "old";
      position: absolute; top: 6px; right: 8px;
      font-size: 9px; letter-spacing: 0.04em; text-transform: uppercase;
      color: var(--muted); opacity: 0.75;
    }
  `);

  tenote.ui.settings.declare([
    { key: 'days', type: 'number', label: 'Mark notes older than (days)', default: 7,
      onChange(v) { days = Number(v) || 7; sweep(); } },
  ]);

  function isOld(el) {
    const timeEl = el.querySelector('.rs, .when');
    if (!timeEl) return false;
    return ageDays(timeEl.textContent) > days;
  }

  function ageDays(text) {
    const t = String(text || '').trim().toLowerCase();
    let m = /^(\d+)\s*m(?!o)\s*$/.exec(t);
    if (m) return 0;
    m = /^(\d+)\s*h\s*$/.exec(t);
    if (m) return 0;
    if (t === 'just now' || t === 'yesterday') return t === 'yesterday' ? 1 : 0;
    m = /^(\d+)\s*d\s*$/.exec(t);
    if (m) return Number(m[1]);
    const parsed = Date.parse(t);
    if (!isNaN(parsed)) return Math.floor((Date.now() - parsed) / 86400000);
    return -1;
  }

  function sweep() {
    document.querySelectorAll('.recent-card, .note-item').forEach((el) => {
      el.classList.toggle('aged', isOld(el));
    });
  }

  const mo = new MutationObserver(() => sweep());
  function watch() {
    const recents = document.getElementById('recents');
    const list = document.getElementById('note-list');
    if (recents) mo.observe(recents, { childList: true });
    if (list) mo.observe(list, { childList: true });
    sweep();
  }
  setTimeout(watch, 300);

  tenote.events.on('note:saved', () => setTimeout(sweep, 400));
};
