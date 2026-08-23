'use strict';

const FORMATS = ['words', 'words+time', 'chars'];

module.exports = function wordCount(tenote) {
  let fmt = tenote.settings.get('format', 'words');

  const chip = tenote.ui.chips.add({
    label: '',
    onHover,
    onClick() {
      fmt = FORMATS[(FORMATS.indexOf(fmt) + 1) % FORMATS.length];
      tenote.settings.set('format', fmt);
      refresh();
    },
  });
  chip.hide();

  function count(text) {
    const clean = text.replace(/!\[[^\]]*\]\([^)]*\)/g, ' x ').replace(/[#*`>\[\]()]/g, ' ');
    const words = clean.split(/\s+/).filter(Boolean);
    return { w: words.length, c: text.length };
  }

  function label() {
    if (!tenote.composer.isEmpty()) {
      const el = document.getElementById('note');
      const { w } = count(el ? el.textContent : '');
      if (w) {
        if (fmt === 'chars') return count(el.textContent).c + ' chars';
        if (fmt === 'words+time') return `${w} words · ~${Math.max(1, Math.round(w / 200))} min read`;
        return `${w} word${w === 1 ? '' : 's'}`;
      }
    }
    return '';
  }

  function hover() {
    const el = document.getElementById('note');
    const { w, c } = count(el ? el.textContent : '');
    return `${w} words · ${c} characters · ~${Math.max(1, Math.round(w / 200))} min read`;
  }

  function refresh() {
    const l = label();
    if (!l) chip.hide();
    else { chip.update(l); chip.show(); }
  }

  tenote.ui.settings.declare([
    {
      key: 'format',
      type: 'select',
      label: 'Chip shows',
      options: FORMATS,
      default: 'words',
      onChange(v) { fmt = v; refresh(); },
    },
  ]);

  tenote.events.on('composer:input', refresh);
  tenote.events.on('note:opened', refresh);
};
