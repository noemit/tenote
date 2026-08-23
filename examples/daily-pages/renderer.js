'use strict';

module.exports = function dailyPagesRenderer(tenote) {
  tenote.events.on('daily:open', ({ id }) => {
    if (!id) return;
    setTimeout(() => tenote.ui.views.openNote(id), 120);
  });
};
