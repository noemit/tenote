'use strict';

const SHORTCUT = process.env.TENOTE_SHORTCUT === '0' ? null : process.env.TENOTE_SHORTCUT || 'Alt+.';
const FALLBACK = 'Alt+Shift+.';

module.exports = function coreShortcuts(tenote) {
  if (!SHORTCUT) {
    tenote.log.info('built-in shortcut disabled (TENOTE_SHORTCUT=0) — use skhd');
    return;
  }
  if (tenote.registerGlobalShortcut(SHORTCUT, () => tenote.window.toggle())) {
    tenote.log.info('registered', { shortcut: SHORTCUT });
    return;
  }
  tenote.log.warn('primary registration failed — trying fallback', { shortcut: SHORTCUT });
  if (tenote.registerGlobalShortcut(FALLBACK, () => tenote.window.toggle())) {
    tenote.log.info('registered fallback', { shortcut: FALLBACK });
  } else {
    tenote.log.error('all built-in shortcuts failed — use the skhd binding instead');
  }
};
