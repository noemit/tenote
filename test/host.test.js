'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { createHost } = require('../lib/host');

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tenote-host-test-'));
}

function makeLogger() {
  const lines = [];
  const push = (lvl) => (...args) => lines.push({ lvl, msg: args.join(' ') });
  return { lines, debug: push('debug'), info: push('info'), warn: push('warn'), error: push('error') };
}

function writePlugin(dir, name, body, manifest) {
  const pdir = path.join(dir, name);
  fs.mkdirSync(pdir, { recursive: true });
  if (manifest) fs.writeFileSync(path.join(pdir, 'plugin.json'), JSON.stringify(manifest));
  if (body) fs.writeFileSync(path.join(pdir, 'index.js'), `module.exports = function (t) { ${body} };`);
  return pdir;
}

function baseOpts(dir, extra) {
  const logger = makeLogger();
  const settings = { plugins: {} };
  return {
    logger,
    settings,
    pluginDataRoot: path.join(dir, 'data'),
    persistSettings() {},
    layers: [{ name: 'builtin', dir }],
    ...extra,
    _logger: logger,
  };
}

test('discovers and activates plugins in order', () => {
  const dir = tmp();
  writePlugin(dir, 'a-one', "this.ran='a';");
  writePlugin(dir, 'b-two', "this.ran='b';");
  const host = createHost(baseOpts(dir));
  host.discover();
  host.activateAll();
  assert.equal(host.status().plugins.length, 2);
  assert.deepEqual(host.status().plugins.map((p) => [p.name, p.state]), [['a-one', 'ok'], ['b-two', 'ok']]);
});

test('disabled plugins stay dormant', () => {
  const dir = tmp();
  writePlugin(dir, 'off', "global.__x=(global.__x||0)+1;");
  const opts = baseOpts(dir);
  opts.settings.plugins.disabled = ['off'];
  const host = createHost(opts);
  host.discover();
  host.activateAll();
  assert.equal(host.status().plugins[0].state, 'disabled');
  assert.equal(global.__x, undefined);
});

test('later layer loses on name collision', () => {
  const builtin = tmp();
  const user = tmp();
  writePlugin(builtin, 'dupe', '');
  fs.writeFileSync(path.join(builtin, 'dupe', 'index.js'), 'module.exports = function () {};');
  fs.mkdirSync(path.join(user, 'dupe'), { recursive: true });
  fs.writeFileSync(path.join(user, 'dupe', 'index.js'), 'module.exports = function () {};');
  const host = createHost(baseOpts(builtin, { layers: [{ name: 'builtin', dir: builtin }, { name: 'user', dir: user }] }));
  host.discover();
  host.activateAll();
  const dupe = host.status().plugins.filter((p) => p.name === 'dupe');
  assert.equal(dupe.length, 1);
  assert.equal(dupe[0].layer, 'builtin');
});

test('failed activation isolates and unregisters contributions', () => {
  const dir = tmp();
  writePlugin(dir, 'boom', 'throw new Error("nope");', null);
  const good = path.join(dir, 'gooder');
  fs.mkdirSync(good);
  fs.writeFileSync(path.join(good, 'plugin.json'), JSON.stringify({ name: 'gooder' }));
  fs.writeFileSync(path.join(good, 'index.js'), "module.exports = function (t) { t.registerCommand('hello', () => 'hi'); };");
  const host = createHost(baseOpts(dir));
  host.discover();
  host.activateAll();
  const states = Object.fromEntries(host.status().plugins.map((p) => [p.name, p.state]));
  assert.equal(states.boom, 'failed');
  assert.equal(states.gooder, 'ok');
  assert.equal(host.runCommand('hello'), 'hi');
});

test('hook failures suspend after three strikes', () => {
  const dir = tmp();
  writePlugin(dir, 'flaky', "t.on('note:saved', () => { throw new Error('boom'); });");
  const opts = baseOpts(dir);
  const host = createHost(opts);
  host.discover();
  host.activateAll();
  for (let i = 0; i < 5; i++) host.emit('note:saved', {});
  const flakyLogs = opts._logger.lines.filter((l) => l.msg.includes('flaky')).length;
  assert.ok(flakyLogs >= 3, `expected >=3 flaky logs, got ${flakyLogs}`);
});

test('note:before-save pipeline replaces payload in order', () => {
  const dir = tmp();
  writePlugin(dir, 'p1', "t.on('note:before-save', (n) => ({ ...n, text: n.text + '-one' }));");
  writePlugin(dir, 'p2', "t.on('note:before-save', (n) => ({ ...n, text: n.text + '-two' }));");
  const host = createHost(baseOpts(dir));
  host.discover();
  host.activateAll();
  const out = host.applyBeforeSave({ id: null, text: 'x', tags: [] });
  assert.match(out.text, /-one-two$/);
});

test('throwing pipeline handler passes payload through', () => {
  const dir = tmp();
  writePlugin(dir, 'bad', "t.on('note:before-save', () => { throw new Error('x'); });");
  const host = createHost(baseOpts(dir));
  host.discover();
  host.activateAll();
  const out = host.applyBeforeSave({ id: null, text: 'keep', tags: [] });
  assert.equal(out.text, 'keep');
});

test('first command registration wins', () => {
  const dir = tmp();
  writePlugin(dir, 'c1', "t.registerCommand('dup', () => 'first');");
  writePlugin(dir, 'c2', "t.registerCommand('dup', () => 'second');");
  const host = createHost(baseOpts(dir));
  host.discover();
  host.activateAll();
  assert.equal(host.runCommand('dup'), 'first');
});

test('theme-only plugin contributes themes without JS', () => {
  const dir = tmp();
  const pdir = path.join(dir, 'pack');
  fs.mkdirSync(pdir);
  fs.writeFileSync(path.join(pdir, 'forest.css'), 'body{}');
  fs.writeFileSync(
    path.join(pdir, 'plugin.json'),
    JSON.stringify({ name: 'pack', themes: [{ id: 'forest', name: 'Forest', css: 'forest.css', swatch: ['#111', '#222'] }] })
  );
  const host = createHost(baseOpts(dir));
  host.discover();
  host.activateAll();
  assert.ok(host.hasTheme('forest'));
  assert.equal(host.themeCss('forest'), 'body{}');
  assert.deepEqual(host.themeList()[0], { id: 'forest', name: 'Forest', swatch: ['#111', '#222'] });
});

test('renderer entries listed only when ok', () => {
  const dir = tmp();
  writePlugin(dir, 'ui', '', { name: 'ui', renderer: 'renderer.js' });
  fs.writeFileSync(path.join(dir, 'ui', 'renderer.js'), 'module.exports=function(){};');
  writePlugin(dir, 'dead', '', { name: 'dead' });
  const host = createHost(baseOpts(dir));
  host.discover();
  host.activateAll();
  const entries = host.rendererEntries();
  assert.deepEqual(entries.map((e) => e.id), ['ui']);
});

test('invoke routes to registered services; unknown throws', async () => {
  const dir = tmp();
  writePlugin(dir, 'svc', "t.registerService({ ping: () => 'pong' });");
  const host = createHost(baseOpts(dir));
  host.discover();
  host.activateAll();
  assert.equal(await host.invoke('svc', 'ping'), 'pong');
  await assert.rejects(() => host.invoke('svc', 'nope'));
  await assert.rejects(() => host.invoke('ghost', 'x'));
});

test('settings namespace persists through callback', () => {
  const dir = tmp();
  writePlugin(dir, 'setter', "t.settings.set('k', t.settings.get('k', 0) + 41);");
  let saved = 0;
  const opts = baseOpts(dir);
  opts.persistSettings = () => saved++;
  opts.settings.plugins.values = { setter: { k: 1 } };
  const host = createHost(opts);
  host.discover();
  host.activateAll();
  assert.equal(opts.settings.plugins.values.setter.k, 42);
  assert.equal(saved, 1);
});

test('setEnabled updates settings and persists', () => {
  const dir = tmp();
  writePlugin(dir, 'toggle-me', '');
  let saved = 0;
  const opts = baseOpts(dir);
  opts.persistSettings = () => saved++;
  const host = createHost(opts);
  host.discover();
  host.setEnabled('toggle-me', false);
  assert.deepEqual(opts.settings.plugins.disabled, ['toggle-me']);
  host.setEnabled('toggle-me', true);
  assert.deepEqual(opts.settings.plugins.disabled, []);
  assert.ok(saved >= 2);
});

test('onEmit pipes every event to the host callback', () => {
  const dir = tmp();
  writePlugin(dir, 'emitter', "t.on('note:saved', () => {});");
  const seen = [];
  const opts = baseOpts(dir);
  opts.onEmit = (event, payload) => seen.push([event, payload]);
  const host = createHost(opts);
  host.discover();
  host.activateAll();
  host.emit('note:saved', { id: 'a' });
  assert.ok(seen.some(([e, p]) => e === 'ready'));
  assert.ok(seen.some(([e, p]) => e === 'note:saved' && p.id === 'a'));
});

test('file allowlist includes sibling json next to a renderer', () => {
  const dir = tmp();
  writePlugin(dir, 'pack', '', { name: 'pack', renderer: 'renderer.js' });
  fs.writeFileSync(path.join(dir, 'pack', 'renderer.js'), 'module.exports=function(){};');
  fs.writeFileSync(path.join(dir, 'pack', 'words.json'), '[]');
  const host = createHost(baseOpts(dir));
  host.discover();
  host.activateAll();
  const entry = host.fileAllowlist().get('pack');
  assert.ok(entry.files.has('renderer.js'));
  assert.ok(entry.files.has('words.json'));
});

test('enable() activates a disabled plugin live and fires only its ready hook', () => {
  const dir = tmp();
  writePlugin(dir, 'early', "t.on('ready', () => t.settings.set('readyN', (t.settings.get('readyN', 0)) + 1));");
  writePlugin(dir, 'late', `
    t.registerCommand('late-cmd', () => 'late');
    t.on('ready', () => t.settings.set('sawReady', true));
  `);
  const opts = baseOpts(dir);
  opts.settings.plugins.disabled = ['late'];
  const host = createHost(opts);
  host.discover();
  host.activateAll();
  assert.equal(host.runCommand('late-cmd'), null);
  assert.equal(opts.settings.plugins.values.early.readyN, 1);
  assert.equal(host.enable('late'), true);
  assert.equal(host.runCommand('late-cmd'), 'late');
  assert.equal(opts.settings.plugins.values.late.sawReady, true);
  assert.equal(opts.settings.plugins.values.early.readyN, 1);
  assert.deepEqual(opts.settings.plugins.disabled, []);
});

test('disable() tears down commands, services, hooks and themes live', () => {
  const dir = tmp();
  writePlugin(dir, 'pack', `
    t.registerCommand('pack-cmd', () => 'x');
    t.registerService({ ping: () => 'pong' });
    t.on('note:saved', () => t.settings.set('saves', (t.settings.get('saves', 0)) + 1));
  `, {
    name: 'pack',
    themes: [{ id: 'pack-theme', name: 'Pack', css: 'pack.css', swatch: ['#111', '#222'] }],
  });
  fs.writeFileSync(path.join(dir, 'pack', 'pack.css'), 'body{}');
  const opts = baseOpts(dir);
  const host = createHost(opts);
  host.discover();
  host.activateAll();
  assert.ok(host.hasTheme('pack-theme'));
  host.emit('note:saved', {});
  assert.equal(opts.settings.plugins.values.pack.saves, 1);
  assert.equal(host.disable('pack'), true);
  assert.equal(host.runCommand('pack-cmd'), null);
  assert.ok(!host.hasTheme('pack-theme'));
  assert.rejects(() => host.invoke('pack', 'ping'));
  host.emit('note:saved', {});
  assert.equal(opts.settings.plugins.values.pack.saves, 1);
  assert.deepEqual(opts.settings.plugins.disabled, ['pack']);
});

test('enable() restores a disabled plugin theme to the registry', () => {
  const dir = tmp();
  writePlugin(dir, 'pack', '', {
    name: 'pack',
    themes: [{ id: 'pack-theme', name: 'Pack', css: 'pack.css' }],
  });
  fs.writeFileSync(path.join(dir, 'pack', 'pack.css'), 'body{}');
  const opts = baseOpts(dir);
  opts.settings.plugins.disabled = ['pack'];
  const host = createHost(opts);
  host.discover();
  host.activateAll();
  assert.ok(!host.hasTheme('pack-theme'));
  assert.equal(host.enable('pack'), true);
  assert.ok(host.hasTheme('pack-theme'));
});

test('plugins can define and exchange custom event names', () => {
  const dir = tmp();
  writePlugin(dir, 'source', "t.on('ready', () => t.emit('daily:open', { id: 'x' }));");
  const got = [];
  const opts = baseOpts(dir);
  const host = createHost(opts);
  host.discover();

  const sink = path.join(dir, 'sink');
  fs.mkdirSync(sink);
  global.__got = got;
  fs.writeFileSync(path.join(sink, 'index.js'),
    "module.exports = function (t) { t.on('daily:open', (p) => { global.__got.push(p); }); };");

  const h2 = createHost({ ...opts, envFiles: [sink], layers: [{ name: 'builtin', dir }] });
  h2.discover();
  h2.activateAll();
  assert.deepEqual(got, [{ id: 'x' }]);
});
