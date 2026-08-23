'use strict';

const WORDS = require('./words.json');

module.exports = function wordOfTheDay(tenote) {
  let withDefinition = tenote.settings.get('insertWithDefinition', false);
  const entry = WORDS[dayOfYear() % WORDS.length];
  const [word, pos, def] = entry;

  tenote.ui.chips.add({
    label: word,
    variant: 'accent',
    onHover() { return `${word} (${pos}) — ${def}`; },
    onClick() {
      tenote.composer.insertText(withDefinition ? `${word} — ${def} ` : `${word} `);
    },
  });

  tenote.ui.settings.declare([
    { key: 'insertWithDefinition', type: 'toggle', label: 'Click inserts the word with its definition', default: false,
      onChange(v) { withDefinition = !!v; } },
  ]);

  function dayOfYear() {
    const start = new Date(new Date().getFullYear(), 0, 0);
    return Math.floor((Date.now() - start.getTime()) / 86400000);
  }
};
