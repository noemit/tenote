'use strict';

function slugToday(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

module.exports = function dailyPages(tenote) {
  tenote.registerCommand('today', () => openSlug(slugToday()));
  tenote.registerCommand('yesterday', () => openSlug(slugToday(-1)));

  tenote.registerTrayItem({
    label: "Open today's note",
    click() { openSlug(slugToday()); },
  });

  function openSlug(slug) {
    try {
      const existing = tenote.notes.read(slug);
      if (!existing) {
        tenote.notes.save({ id: slug, text: `# ${slug}\n`, tags: ['daily'] });
      }
      tenote.window.show();
      tenote.emit('daily:open', { id: slug });
      return `ok ${slug}`;
    } catch (e) {
      tenote.log.error('open failed', e.message);
      return 'error';
    }
  }
};
