'use strict';

module.exports = function wordGoal(tenote) {
  let goal = Number(tenote.settings.get('goal', 750)) || 750;
  let savedWordsToday = -1; // -1 = never computed
  let dirty = false;        // another note changed since the last compute
  let lastCompute = 0;      // typing-refresh throttle
  let lastSavedAt = 0;      // savedWords() recompute throttle (IPC storm guard)
  let running = false;      // coalesce overlapping refreshes
  let queued = false;
  let activeId = null;

  // The expensive part (list + up to 50 full note reads over IPC) runs at most
  // once per 15s no matter how many invalidating events arrive.
  const SAVED_TTL_MS = 15000;

  const chip = tenote.ui.chips.add({ label: '', onHover });
  chip.hide();

  tenote.ui.settings.declare([
    { key: 'goal', type: 'number', label: 'Daily word goal', default: 750,
      onChange(v) { goal = Number(v) || 750; refresh(true); } },
  ]);

  function count(text) {
    return String(text).split(/\s+/).filter(Boolean).length;
  }

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
    if (running) { queued = true; return; } // one queued rerun, never a pile-up
    running = true;
    try {
      if (savedWordsToday < 0 || (dirty && now - lastSavedAt > SAVED_TTL_MS)) {
        savedWordsToday = await savedWords();
        lastSavedAt = Date.now();
        dirty = false;
      }
      const current = window.__tenoteComposer ? count(window.__tenoteComposer.getText()) : 0;
      const total = savedWordsToday + current;
      if (!total) { chip.hide(); return; }
      if (total >= goal) chip.update(`${total}/${goal} 🎉`, 'accent');
      else chip.update(`${total}/${goal}`, 'default');
      chip.show();
    } finally {
      running = false;
      if (queued) { queued = false; refresh(true); }
    }
  }

  function onHover() {
    return `Daily goal: ${goal} words — counts everything saved today plus this note`;
  }

  tenote.events.on('composer:input', () => refresh(false));
  tenote.events.on('note:saved', (p) => {
    const id = p && p.id;
    if (!id || id === activeId) return; // the open note autosaving — counted live already
    const composing = window.__tenoteComposer && window.__tenoteComposer.getText().trim();
    if (!activeId && composing) { activeId = id; return; } // first save gave the open note its id
    dirty = true; // a different note changed (tenotectl, another plugin)
    refresh(true);
  });
  tenote.events.on('note:opened', (p) => { activeId = p && p.id; dirty = true; refresh(true); });
  // Keep activeId across window:shown — the open note is counted live, so it
  // must stay excluded from savedWords (nulling it here double-counted it).
  tenote.events.on('window:shown', () => { dirty = true; refresh(true); });
  refresh(true);
};
