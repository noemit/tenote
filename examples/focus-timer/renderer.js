'use strict';

module.exports = function focusTimer(tenote) {
  let workMin = Number(tenote.settings.get('workMinutes', 25)) || 25;
  let breakMin = Number(tenote.settings.get('breakMinutes', 5)) || 5;

  let phase = 'idle';
  let endsAt = 0;
  let tick = null;

  const chip = tenote.ui.chips.add({
    label: '▶ focus',
    variant: 'default',
    tooltip: 'Pomodoro timer — click to start',
    onClick() { toggle(); },
  });

  tenote.ui.keys.add({
    combo: 'mod+shift+f',
    handler() { toggle(); return true; },
  });

  function toggle() {
    if (phase === 'idle' || phase === 'done') start(workMin, 'work');
    else stop();
  }

  function start(minutes, p) {
    phase = p;
    endsAt = Date.now() + minutes * 60000;
    clearInterval(tick);
    tick = setInterval(render, 500);
    render();
  }

  function stop() {
    phase = 'idle';
    clearInterval(tick);
    tick = null;
    chip.update('▶ focus', 'default');
  }

  function render() {
    const left = endsAt - Date.now();
    if (left <= 0) {
      clearInterval(tick);
      tick = null;
      if (phase === 'work') {
        phase = 'done';
        chip.update('✓ done — take a break', 'accent');
        tenote.ui.toast('Focus session complete');
      } else {
        stop();
      }
      return;
    }
    const m = Math.floor(left / 60000);
    const s = Math.floor((left % 60000) / 1000);
    const label = (phase === 'break' ? '☕ ' : '') + `${m}:${String(s).padStart(2, '0')}`;
    chip.update(label, phase === 'break' ? 'accent' : 'default');
  }

  tenote.ui.settings.declare([
    { key: 'workMinutes', type: 'number', label: 'Focus length (minutes)', default: 25,
      onChange(v) { workMin = Number(v) || 25; } },
    { key: 'breakMinutes', type: 'number', label: 'Break length (minutes)', default: 5,
      onChange(v) { breakMin = Number(v) || 5; } },
  ]);
};
