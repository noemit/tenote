'use strict';

module.exports = function ping(tenote) {
  tenote.registerCommand('ping', () => 'pong');
  tenote.registerService({
    hello(args) {
      return { msg: 'hello ' + ((args && args.name) || 'world'), plugins: tenote.system.status().plugins.length };
    },
  });
  tenote.on('ready', () => tenote.log.info('up — try `tenotectl ping`'));
};
