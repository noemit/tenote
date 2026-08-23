'use strict';

module.exports = function search(tenote) {
  let cache = null;
  let cacheKey = '';
  let debounce = null;
  let hits = [];
  let sel = 0;

  tenote.ui.keys.add({
    combo: 'mod+f',
    handler() { open(); return true; },
  });

  async function corpus() {
    const notes = await tenote.notes.list();
    const key = notes.map((n) => n.id + ':' + (n.updated || '')).join('|');
    if (cache && key === cacheKey) return cache;
    const out = [];
    for (const meta of notes.slice(0, 500)) {
      const full = await tenote.notes.read(meta.id).catch(() => null);
      out.push({
        id: meta.id,
        title: meta.title || meta.id,
        body: full ? full.body : '',
        snippet: meta.snippet || '',
      });
    }
    cache = out;
    cacheKey = key;
    return out;
  }

  function open() {
    tenote.ui.views.register({
      id: 'search',
      title: 'Search',
      render(el) {
        el.innerHTML =
          '<input class="pv-search" type="text" placeholder="Search all notes…" />' +
          '<ul class="pv-hits"></ul>';
        const input = el.querySelector('input');
        const list = el.querySelector('ul');
        input.focus();

        const run = async () => {
          const q = input.value.trim().toLowerCase();
          if (!q) { list.innerHTML = ''; return; }
          const docs = await corpus();
          hits = docs
            .map((d) => ({ d, at: (d.title + '\n' + d.body).toLowerCase().indexOf(q) }))
            .filter((r) => r.at >= 0)
            .slice(0, 50);
          sel = 0;
          renderHits(list, q);
        };

        input.addEventListener('input', () => { clearTimeout(debounce); debounce = setTimeout(run, 250); });
        input.addEventListener('keydown', (e) => {
          if (e.key === 'ArrowDown') { sel = Math.min(sel + 1, hits.length - 1); renderHits(list, input.value.trim().toLowerCase()); e.preventDefault(); }
          else if (e.key === 'ArrowUp') { sel = Math.max(sel - 1, 0); renderHits(list, input.value.trim().toLowerCase()); e.preventDefault(); }
          else if (e.key === 'Enter' && hits[sel]) { tenote.ui.views.openNote(hits[sel].d.id); }
        });
        list.addEventListener('click', (e) => {
          const hit = e.target.closest('.pv-hit');
          if (hit && hit.dataset.idx != null) tenote.ui.views.openNote(hits[Number(hit.dataset.idx)].d.id);
        });
      },
    });
    tenote.ui.views.open('search');
  }

  function renderHits(list, q) {
    if (!hits.length) { list.innerHTML = '<li class="pv-empty">No matches</li>'; return; }
    list.innerHTML = hits.map((r, i) => {
      const s = snippet(r.d.body, q);
      return `<li class="pv-hit${i === sel ? ' sel' : ''}" data-idx="${i}">
        <div class="t">${esc(r.d.title)}</div><div class="s">${esc(s)}</div></li>`;
    }).join('');
  }

  function snippet(body, q) {
    const i = body.toLowerCase().indexOf(q);
    if (i < 0) return body.slice(0, 90);
    const start = Math.max(0, i - 30);
    return (start > 0 ? '…' : '') + body.slice(start, i + q.length + 50) + '…';
  }

  function esc(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }
};
