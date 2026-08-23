'use strict';

module.exports = function coreCommands(tenote) {
  tenote.registerCommand('toggle', () => {
    tenote.window.toggle();
    return 'ok';
  });
  tenote.registerCommand('show', () => {
    tenote.window.show();
    return 'ok';
  });
  tenote.registerCommand('hide', () => {
    tenote.window.hide();
    return 'ok';
  });
  tenote.registerCommand('quit', () => {
    tenote.app.quit();
    return 'ok';
  });
  tenote.registerCommand('status', () => tenote.system.status());
};
