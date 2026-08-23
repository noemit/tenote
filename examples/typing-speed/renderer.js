'use strict';

const WINDOW_MS = 60000;
const IDLE_MS = 30000;

module.exports = function typingSpeed(tenote) {
  const samples = [];
  let lastLen = null;
  const chip = tenote.ui.chips.add({ label: '', tooltip: 'Words per minute, last minute of typing' });
  chip.hide();

  tenote.events.on('composer:input', () => {
    const now = Date.now();
    const len = currentLen();
    if (len == null) return;
    if (lastLen != null && len > lastLen) samples.push([now, len - lastLen]);
    lastLen = len;
  });

  function currentLen() {
    return window.__tenoteComposer ? window.__tenoteComposer.getText().length : null;
  }

  function wpm() {
    const cutoff = Date.now() - WINDOW_MS;
    while (samples.length && samples[0][0] < cutoff) samples.shift();
    const chars = samples.reduce((s, [, n]) => s + n, 0);
    return Math.round((chars / 5) / (WINDOW_MS / 60000));
  }

  setInterval(() => {
    if (!samples.length || Date.now() - samples[samples.length - 1][0] > IDLE_MS) {
      chip.update('');
      chip.hide();
      return;
    }
    const n = wpm();
    if (n > 0) { chip.update(`${n} wpm`); chip.show(); }
  }, 1500);
};
