'use strict';

const fs = require('fs');
const path = require('path');

const HOOK_EVENTS = new Set([
  'ready',
  'window:shown',
  'window:hidden',
  'note:before-save',
  'note:saved',
  'note:opened',
  'app:before-quit',
]);

const STRIKE_LIMIT = 3;
const EVENT_NAME_RE = /^[\w][\w.:-]{0,63}$/;

function slug(s) {
  return typeof s === 'string' && /^[\w][\w.-]{0,63}$/.test(s) ? s : null;
}

function readManifest(dir) {
  try {
    const raw = fs.readFileSync(path.join(dir, 'plugin.json'), 'utf8');
    const m = JSON.parse(raw);
    return m && typeof m === 'object' ? m : null;
  } catch (e) {
    return null;
  }
}

function createHost(options) {
  const opts = options || {};
  const logger = opts.logger || { debug() {}, info() {}, warn() {}, error() {} };
  const settings = opts.settings || { plugins: {} };
  if (!settings.plugins || typeof settings.plugins !== 'object') settings.plugins = {};
  const plugCfg = settings.plugins;
  if (!Array.isArray(plugCfg.disabled)) plugCfg.disabled = [];
  if (!Array.isArray(plugCfg.paths)) plugCfg.paths = [];
  if (!plugCfg.values || typeof plugCfg.values !== 'object') plugCfg.values = {};
  const kernel = opts.kernel || {};
  const persist = typeof opts.persistSettings === 'function' ? opts.persistSettings : () => {};

  const plugins = new Map();
  const commands = new Map();
  const services = new Map();
  const trayItems = [];
  const shortcuts = [];
  const themes = new Map();
  const hooks = new Map();
  const cssCache = new Map();

  let ready = false;

  function layerDirs(layer) {
    try {
      return fs
        .readdirSync(layer.dir, { withFileTypes: true })
        .filter((d) => !d.name.startsWith('.') && !d.name.startsWith('_'))
        .map((d) => ({ name: d.name, dir: path.join(layer.dir, d.name), isDir: d.isDirectory() }))
        .sort((a, b) => a.name.localeCompare(b.name));
    } catch (e) {
      return [];
    }
  }

  function discoverExplicit(layer) {
    return (layer.files || [])
      .filter((f) => f)
      .map((f) => {
        const abs = path.resolve(f);
        let isDir = false;
        try { isDir = fs.statSync(abs).isDirectory(); } catch (e) { return null; }
        return { name: path.basename(abs, isDir ? '' : '.js'), dir: abs, isDir };
      })
      .filter(Boolean)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  function addRecord(rec) {
    if (!rec.mainPath && !rec.rendererPath && !rec.themes.length) {
      logger.warn('plugins', `skipping "${rec.dirName}" — nothing to load`);
      return;
    }
    if (plugins.has(rec.name)) {
      logger.warn('plugins', `name collision: "${rec.name}" from layer "${rec.layer}" skipped (${plugins.get(rec.name).layer} wins)`);
      return;
    }
    plugins.set(rec.name, rec);
  }

  function scanEntry(layer, entry) {
    const manifest = entry.isDir ? readManifest(entry.dir) : null;
    if (entry.isDir && !manifest && !fs.existsSync(path.join(entry.dir, 'index.js'))) return;
    const rec = {
      layer: layer.name,
      dirName: entry.name,
      dir: entry.dir,
      mainPath: null,
      rendererPath: null,
      themes: [],
      name: null,
      version: null,
      state: 'disabled',
      error: null,
    };
    if (manifest) {
      rec.name = slug(manifest.name);
      rec.version = typeof manifest.version === 'string' ? manifest.version : null;
      if (typeof manifest.main === 'string' && /\.m?js$/.test(manifest.main)) {
        const p = path.join(entry.dir, manifest.main);
        if (fs.existsSync(p)) rec.mainPath = p;
      }
      if (typeof manifest.renderer === 'string' && /\.m?js$/.test(manifest.renderer)) {
        const p = path.join(entry.dir, manifest.renderer);
        if (fs.existsSync(p)) rec.rendererPath = p;
      }
      if (Array.isArray(manifest.themes)) {
        for (const t of manifest.themes) {
          if (!t || typeof t !== 'object') continue;
          const id = slug(t.id);
          if (!id || themes.has(id) || typeof t.css !== 'string') continue;
          const cssPath = path.join(entry.dir, t.css);
          if (!fs.existsSync(cssPath)) continue;
          const swatch = Array.isArray(t.swatch) ? t.swatch.slice(0, 2).map(String) : null;
          const def = { id, name: String(t.name || id), cssPath, swatch, owner: null };
          rec.themes.push(def);
          themes.set(id, def);
        }
      }
    }
    const idx = path.join(entry.dir, 'index.js');
    if (!rec.mainPath && fs.existsSync(idx)) rec.mainPath = idx;
    if (!rec.mainPath && !entry.isDir) rec.mainPath = entry.dir.endsWith('.js') ? entry.dir : null;
    rec.name = rec.name || entry.name;
    addRecord(rec);
  }

  function discover() {
    const layers = [
      ...(opts.layers || []),
      ...(plugCfg.paths.length ? [{ name: 'paths', files: plugCfg.paths }] : []),
      ...(opts.envFiles && opts.envFiles.length ? [{ name: 'env', files: opts.envFiles }] : []),
    ];
    for (const layer of layers) {
      const entries = layer.dir ? layerDirs(layer) : discoverExplicit(layer);
      for (const entry of entries) scanEntry(layer, entry);
    }
    const disabled = new Set(plugCfg.disabled);
    for (const rec of plugins.values()) {
      if (disabled.has(rec.name)) { rec.state = 'disabled'; continue; }
      rec.state = 'loaded';
    }
    for (const def of themes.values()) {
      const owner = pluginForDir(def.cssPath);
      def.owner = owner ? owner.name : null;
      if (owner && owner.state === 'disabled') themes.delete(def.id);
    }
  }

  function pluginForDir(file) {
    for (const rec of plugins.values()) {
      if (file.startsWith(rec.dir + path.sep)) return rec;
    }
    return null;
  }

  function makeApi(rec) {
    const prefix = `[${rec.name}]`;
    const log = {
      debug: (...a) => logger.debug(prefix, ...a),
      info: (...a) => logger.info(prefix, ...a),
      warn: (...a) => logger.warn(prefix, ...a),
      error: (...a) => logger.error(prefix, ...a),
    };
    const api = {
      name: rec.name,
      version: rec.version,
      log,
      dataDir() {
        const base = opts.pluginDataRoot || '.';
        const dir = path.join(base, rec.name);
        try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { /* ignore */ }
        return dir;
      },
      on(event, fn) {
        if (!EVENT_NAME_RE.test(String(event || '')) || typeof fn !== 'function') {
          log.warn('rejected on()', event);
          return;
        }
        if (!hooks.has(event)) hooks.set(event, []);
        hooks.get(event).push({ fn, owner: rec.name, fails: 0 });
      },
      emit(event, payload) {
        if (!EVENT_NAME_RE.test(String(event || ''))) { log.warn('rejected emit', event); return; }
        emit(event, payload === undefined ? {} : payload);
      },
      registerCommand(name, fn) {
        const key = slug(name);
        if (!key || typeof fn !== 'function') { log.warn('rejected command', name); return; }
        if (commands.has(key)) { log.warn('command exists:', key); return; }
        commands.set(key, { fn, owner: rec.name });
      },
      registerService(methods) {
        if (!methods || typeof methods !== 'object') { log.warn('rejected service'); return; }
        if (services.has(rec.name)) { log.warn('service already registered'); return; }
        services.set(rec.name, methods);
      },
      registerTrayItem(item) {
        if (!item || typeof item.label !== 'string' || typeof item.click !== 'function') {
          log.warn('rejected tray item');
          return;
        }
        trayItems.push({ label: item.label, type: item.type === 'checkbox' ? 'checkbox' : 'normal', checked: !!item.checked, click: item.click, owner: rec.name });
        if (typeof opts.onTrayDirty === 'function') opts.onTrayDirty();
      },
      registerGlobalShortcut(accelerator, fn) {
        if (typeof accelerator !== 'string' || typeof fn !== 'function') {
          log.warn('rejected shortcut');
          return false;
        }
        let ok = true;
        if (typeof opts.onShortcut === 'function') {
          ok = opts.onShortcut({ accelerator, fn, owner: rec.name }) !== false;
        }
        if (!ok) log.warn('shortcut registration failed', accelerator);
        return ok;
      },
      settings: {
        get(key, fallback) {
          const store = plugCfg.values[rec.name];
          return store && Object.prototype.hasOwnProperty.call(store, key) ? store[key] : fallback;
        },
        set(key, value) {
          if (!plugCfg.values[rec.name]) plugCfg.values[rec.name] = {};
          plugCfg.values[rec.name][key] = value;
          persist();
        },
      },
      notesDir: kernel.notesDir || '',
      notes: kernel.notes || {},
      window: kernel.window || {},
      app: kernel.app || {},
      system: kernel.system || {},
    };
    return api;
  }

  function activateAll() {
    for (const rec of plugins.values()) {
      if (rec.state === 'disabled') continue;
      activate(rec);
    }
    ready = true;
    emit('ready', {});
  }

  function activate(rec) {
    if (!rec.mainPath) { rec.state = 'ok'; return; }
    try {
      delete require.cache[require.resolve(rec.mainPath)];
      const mod = require(rec.mainPath);
      const fn = typeof mod === 'function' ? mod : mod && typeof mod.activate === 'function' ? mod.activate : null;
      if (!fn) throw new Error('no exported function');
      if (!rec.version && typeof mod.version === 'string') rec.version = mod.version;
      const api = makeApi(rec);
      fn(api);
      rec.state = 'ok';
      logger.info('plugins', `activated "${rec.name}" (${rec.layer})`);
    } catch (e) {
      rec.state = 'failed';
      rec.error = String(e && e.message || e);
      logger.error('plugins', `activation failed for "${rec.dirName}"`, { error: e && e.stack || String(e) });
      for (const [key, cmd] of commands.entries()) {
        if (cmd.owner === rec.name) commands.delete(key);
      }
      services.delete(rec.name);
      for (let i = trayItems.length - 1; i >= 0; i--) {
        if (trayItems[i].owner === rec.name) trayItems.splice(i, 1);
      }
    }
  }

  function guard(fn, label, owner) {
    try {
      return { ok: true, value: fn() };
    } catch (e) {
      logger.error('plugins', `${label} threw (${owner})`, { error: e && e.stack || String(e) });
      return { ok: false };
    }
  }

  function emit(event, payload) {
    const subs = hooks.get(event);
    if (subs && subs.length) {
      const suspended = [];
      for (let i = 0; i < subs.length; i++) {
        const sub = subs[i];
        const r = guard(() => sub.fn(payload), `hook ${event}`, sub.owner);
        if (!r.ok) {
          sub.fails++;
          if (sub.fails >= STRIKE_LIMIT) {
            suspended.push(i);
            logger.warn('plugins', `subscription suspended after ${STRIKE_LIMIT} failures: ${sub.owner} on ${event}`);
          }
        }
      }
      for (let i = suspended.length - 1; i >= 0; i--) subs.splice(suspended[i], 1);
    }
    if (typeof opts.onEmit === 'function') {
      try { opts.onEmit(event, payload); } catch (e) { logger.error('plugins', `onEmit ${event}`, { error: e.message }); }
    }
    return payload;
  }

  function applyBeforeSave(payload) {
    const subs = hooks.get('note:before-save');
    if (!subs || !subs.length) return payload;
    let current = payload;
    const suspended = [];
    for (let i = 0; i < subs.length; i++) {
      const sub = subs[i];
      const r = guard(() => sub.fn(current), 'note:before-save', sub.owner);
      if (!r.ok) {
        sub.fails++;
        if (sub.fails >= STRIKE_LIMIT) {
          suspended.push(i);
          logger.warn('plugins', `subscription suspended after ${STRIKE_LIMIT} failures: ${sub.owner} on note:before-save`);
        }
        continue;
      }
      if (r.value && typeof r.value === 'object' && typeof r.value.text === 'string') current = r.value;
    }
    for (let i = suspended.length - 1; i >= 0; i--) subs.splice(suspended[i], 1);
    return current;
  }

  async function invoke(name, method, args) {
    if (name === '__host') {
      if (typeof opts.hostService === 'function') return opts.hostService(method, args);
      throw new Error('host service unavailable');
    }
    const svc = services.get(name);
    if (!svc || typeof svc[method] !== 'function') throw new Error(`no service method: ${name}.${method}`);
    return svc[method](args);
  }

  function runCommand(cmd) {
    const entry = commands.get(cmd);
    if (!entry) return null;
    const r = guard(() => entry.fn(), `command ${cmd}`, entry.owner);
    return r.ok ? r.value : `error: ${cmd} failed`;
  }

  function themeCss(id) {
    const def = themes.get(id);
    if (!def) return null;
    if (cssCache.has(id)) return cssCache.get(id);
    try {
      const css = fs.readFileSync(def.cssPath, 'utf8');
      cssCache.set(id, css);
      return css;
    } catch (e) {
      logger.warn('plugins', `theme css unreadable: ${id}`);
      return null;
    }
  }

  function status() {
    return {
      plugins: [...plugins.values()].map((r) => ({ name: r.name || r.dirName, version: r.version, layer: r.layer, state: r.state })),
      commands: [...commands.keys()],
      themes: [...themes.keys()],
    };
  }

  function publicList() {
    return [...plugins.values()].map((r) => ({
      name: r.name || r.dirName,
      version: r.version,
      layer: r.layer,
      state: r.state,
      hasRenderer: !!r.rendererPath,
      themes: r.themes.map((t) => t.id),
    }));
  }

  function rendererEntries() {
    return [...plugins.values()]
      .filter((r) => r.state === 'ok' && r.rendererPath)
      .map((r) => ({ id: r.name, path: r.rendererPath }));
  }

  function fileAllowlist() {
    const map = new Map();
    for (const rec of plugins.values()) {
      if (rec.state === 'disabled') continue;
      const files = new Set();
      if (rec.mainPath) files.add(path.basename(rec.mainPath));
      if (rec.rendererPath) files.add(path.basename(rec.rendererPath));
      for (const t of rec.themes) files.add(path.basename(t.cssPath));
      try {
        for (const f of fs.readdirSync(rec.dir)) {
          if (f.endsWith('.json') && f !== 'plugin.json') files.add(f);
        }
      } catch (e) { /* ignore */ }
      map.set(rec.name || rec.dirName, { dir: rec.dir, files });
    }
    return map;
  }

  function setEnabled(name, enabled) {
    const set = new Set(plugCfg.disabled);
    if (enabled) set.delete(name);
    else set.add(name);
    plugCfg.disabled = [...set].sort();
    persist();
  }

  // Live enable: activate now, fire 'ready' only to this plugin's hooks.
  function enable(name) {
    const rec = plugins.get(name);
    if (!rec) return false;
    setEnabled(name, true);
    if (rec.state !== 'disabled') return rec.state === 'ok';
    rec.state = 'loaded';
    for (const t of rec.themes) if (!themes.has(t.id)) themes.set(t.id, t);
    activate(rec);
    if (ready) {
      const subs = hooks.get('ready');
      if (subs) {
        for (const sub of [...subs]) {
          if (sub.owner === name) guard(() => sub.fn({}), 'hook ready', sub.owner);
        }
      }
    }
    if (typeof opts.onTrayDirty === 'function') opts.onTrayDirty();
    return rec.state === 'ok';
  }

  // Live disable: drop everything the plugin registered. Timers a plugin
  // started keep running (best-effort teardown) until relaunch.
  function disable(name) {
    const rec = plugins.get(name);
    if (!rec) return false;
    setEnabled(name, false);
    for (const [key, cmd] of commands.entries()) if (cmd.owner === name) commands.delete(key);
    services.delete(name);
    for (let i = trayItems.length - 1; i >= 0; i--) if (trayItems[i].owner === name) trayItems.splice(i, 1);
    for (const [event, subs] of [...hooks.entries()]) {
      const kept = subs.filter((s) => s.owner !== name);
      if (kept.length) hooks.set(event, kept);
      else hooks.delete(event);
    }
    for (const t of rec.themes) if (themes.get(t.id) === t) themes.delete(t.id);
    rec.state = 'disabled';
    if (typeof opts.onTrayDirty === 'function') opts.onTrayDirty();
    return true;
  }

  function shutdown() {
    if (!ready) return;
    emit('app:before-quit', {});
  }

  return {
    discover,
    activateAll,
    activate,
    emit,
    applyBeforeSave,
    invoke,
    runCommand,
    hasCommand: (c) => commands.has(c),
    themeCss,
    hasTheme: (id) => themes.has(id),
    themeList: () => [...themes.values()].map(({ id, name, swatch }) => ({ id, name, swatch })),
    status,
    publicList,
    rendererEntries,
    fileAllowlist,
    setEnabled,
    enable,
    disable,
    getRecord: (name) => plugins.get(name) || null,
    shutdown,
    _internal: { plugins, commands, services, hooks, trayItems, shortcuts, themes },
  };
}

module.exports = { createHost, HOOK_EVENTS };
