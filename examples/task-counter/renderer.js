'use strict';

const TASK_RE = /^\s*[-*] \[( |x)\]/;

module.exports = function taskCounter(tenote) {
  const chip = tenote.ui.chips.add({
    label: '',
    tooltip: 'Tasks in this note — click for the next open one',
    variant: 'accent',
    onClick() {
      const box = document.querySelector('#note .tk-b[data-c="0"]');
      if (box) { box.click(); return; }
      tenote.ui.toast('No rendered checkboxes — install checklists-plus to click tasks');
    },
  });
  chip.hide();

  function counts(text) {
    let total = 0;
    let done = 0;
    for (const line of text.split('\n')) {
      const m = TASK_RE.exec(line);
      if (m) { total++; if (m[1] === 'x') done++; }
    }
    return { total, done };
  }

  function refresh() {
    if (!window.__tenoteComposer) return;
    const { total, done } = counts(window.__tenoteComposer.getText());
    if (!total) { chip.hide(); return; }
    chip.update(`${done}/${total} ✓`);
    chip.show();
  }

  tenote.events.on('composer:input', refresh);
  tenote.events.on('note:opened', refresh);
};
