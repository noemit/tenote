'use strict';

module.exports = function checklistsPlus(tenote) {
  tenote.ui.styles.add(`
    li.tk { list-style: none; display: flex; align-items: baseline; }
    .tk-b {
      width: 13px; height: 13px; border: 1.5px solid var(--muted); border-radius: 4px;
      display: inline-block; margin-right: 6px; flex: 0 0 auto; vertical-align: -2px;
      cursor: pointer; background: transparent; padding: 0;
    }
    .tk-b[data-c="1"] { background: var(--accent); border-color: var(--accent); }
    body:not(.tk-no-strike) li.tk.done { text-decoration: line-through; }
    body:not(.tk-no-dim) li.tk.done { color: var(--muted); }
  `);

  function applyToggles(strike, dim) {
    document.body.classList.toggle('tk-no-strike', strike === false);
    document.body.classList.toggle('tk-no-dim', dim === false);
  }

  applyToggles(tenote.settings.get('strikeThrough', true), tenote.settings.get('dimCompleted', true));

  tenote.ui.settings.declare([
    {
      key: 'strikeThrough', type: 'toggle', label: 'Strike through completed items', default: true,
      onChange(v) { document.body.classList.toggle('tk-no-strike', !v); },
    },
    {
      key: 'dimCompleted', type: 'toggle', label: 'Dim completed items', default: true,
      onChange(v) { document.body.classList.toggle('tk-no-dim', !v); },
    },
  ]);

  tenote.ui.markdown.addRule({
    name: 'checklists',
    toHtml(html) {
      html = html.replace(/<li>\[x\]\s*/g, '<li class="tk done"><button class="tk-b" data-c="1" tabindex="-1"></button>');
      html = html.replace(/<li>\[ \]\s*/g, '<li class="tk"><button class="tk-b" data-c="0" tabindex="-1"></button>');
      return html;
    },
    beforeSerialize(root) {
      root.querySelectorAll('li.tk').forEach((li) => {
        const box = li.querySelector('.tk-b');
        const checked = !!box && box.dataset.c === '1';
        if (box) box.remove();
        const text = li.textContent.replace(/^\[[ x]\]\s*/, '');
        li.textContent = (checked ? '[x] ' : '[ ] ') + text;
        li.classList.remove('tk', 'done');
      });
    },
  });

  let wired = false;
  if (!wired) {
    wired = true;
    document.addEventListener('click', (e) => {
      const b = e.target.closest('.tk-b');
      if (!b) return;
      e.preventDefault();
      const li = b.closest('li');
      const on = b.dataset.c !== '1';
      b.dataset.c = on ? '1' : '0';
      if (li) li.classList.toggle('done', on);
      const note = document.getElementById('note');
      if (note) note.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }
};
