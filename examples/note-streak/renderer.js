'use strict';

module.exports = function noteStreak(tenote) {
  let streak = 0;
  const chip = tenote.ui.chips.add({
    label: '',
    tooltip: 'Days in a row with a saved note — click to refresh',
    onClick: refresh,
  });
  chip.hide();

  async function refresh() {
    try {
      const notes = await tenote.notes.list();
      const days = new Set(notes.map((n) => localDate(n.updated)).filter(Boolean));
      streak = countStreak(days);
      if (streak >= 1) { chip.update(`🔥 ${streak}`); chip.show(); }
      else chip.hide();
    } catch (e) { tenote.log.warn(e.message); }
  }

  function countStreak(days) {
    const d = new Date();
    if (!days.has(localDate(d.toISOString()))) d.setDate(d.getDate() - 1);
    let n = 0;
    while (days.has(localDate(d.toISOString()))) { n++; d.setDate(d.getDate() - 1); }
    return n;
  }

  function localDate(iso) {
    if (!iso) return null;
    try { return new Date(iso).toLocaleDateString('sv'); } catch (e) { return null; }
  }

  tenote.events.on('note:saved', refresh);
  refresh();
};
