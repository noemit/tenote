'use strict';

module.exports = function wordGoal(tenote) {
  let goal = Number(tenote.settings.get('goal', 750)) || 750;
  let savedWordsToday = -1;
  let lastCompute = 0;

  const chip = tenote.ui.chips.add({ label: '', onHover });
  chip.hide();

  tenote.ui.settings.declare([
    { key: 'goal', type: 'number', label: 'Daily word goal', default: 750,
      onChange(v) { goal = Number(v) || 750; refresh(true); } },
  ]);

  function count(text) {
    return String(text).split(/\s+/).filter(Boolean).length;
  }

  let activeId = null;

  async function savedWords() {
    try {
      const today = new Date().toLocaleDateString('sv');
      const notes = await tenote.notes.list();
      const todays = notes.filter((n) => n.updated && new Date(n.updated).toLocaleDateString('sv') === today);
      let words = 0;
      for (const meta of todays.slice(0, 50)) {
        if (activeId && meta.id === activeId) continue;
        const full = await tenote.notes.read(meta.id).catch(() => null);
        words += full && full.body ? count(full.body) : count((meta.title || '') + ' ' + (meta.snippet || ''));
      }
      return words;
    } catch (e) { return 0; }
  }

  async function refresh(force) {
    const now = Date.now();
    if (!force && now - lastCompute < 2000) return;
    lastCompute = now;
    if (savedWordsToday < 0) savedWordsToday = await savedWords();
    const current = window.__tenoteComposer ? count(window.__tenoteComposer.getText()) : 0;
    const total = savedWordsToday + current;
    if (!total) { chip.hide(); return; }
    if (total >= goal) chip.update(`${total}/${goal} 🎉`, 'accent');
    else chip.update(`${total}/${goal}`, 'default');
    chip.show();
  }

  function onHover() {
    return `Daily goal: ${goal} words — counts everything saved today plus this note`;
  }

  tenote.events.on('composer:input', () => refresh(false));
  tenote.events.on('note:saved', (p) => { activeId = p && p.id; savedWordsToday = -1; refresh(true); });
  tenote.events.on('note:opened', (p) => { activeId = p && p.id; savedWordsToday = -1; refresh(true); });
  tenote.events.on('window:shown', () => { activeId = null; savedWordsToday = -1; refresh(true); });
  refresh(true);
};
