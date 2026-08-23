'use strict';

const PROMPTS = require('./prompts.json');

module.exports = function promptOfTheDay(tenote) {
  let asHeading = tenote.settings.get('insertAsHeading', true);
  const doy = dayOfYear();
  const prompt = PROMPTS[doy % PROMPTS.length];

  tenote.ui.chips.add({
    label: '✎ prompt',
    variant: 'accent',
    tooltip: prompt,
    onClick() {
      if (tenote.composer.isEmpty() && asHeading) tenote.composer.insertText('# ' + prompt + '\n\n');
      else if (tenote.composer.isEmpty()) tenote.composer.insertText(prompt + '\n\n');
      else tenote.composer.insertText(prompt);
    },
  });

  tenote.ui.settings.declare([
    { key: 'insertAsHeading', type: 'toggle', label: 'Insert as heading into a fresh note', default: true,
      onChange(v) { asHeading = !!v; } },
  ]);

  function dayOfYear() {
    const start = new Date(new Date().getFullYear(), 0, 0);
    return Math.floor((Date.now() - start.getTime()) / 86400000);
  }
};
