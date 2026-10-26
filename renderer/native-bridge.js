// Installed as a WKUserScript at document start: recreates the `window.tenote`
// API that preload.js exposed under Electron, on top of WKWebView messaging.
(function () {
  'use strict';
  const h = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.tenote;
  if (!h) return;
  const call = (method, args) => h.postMessage({ method, args: args === undefined ? null : args });
  const fire = (method, args) => { call(method, args).catch(() => {}); };
  const listeners = { plugin: [], shown: [], goto: [] };
  const droppedPaths = new Map();

  window.__tenoteNative = {
    emit(kind, data) {
      for (const cb of listeners[kind] || []) {
        try { cb(data); } catch (e) { console.error('[tenote] listener failed', e); }
      }
    },
    setDroppedPaths(paths) {
      droppedPaths.clear();
      for (const p of paths || []) droppedPaths.set(String(p).split('/').pop(), p);
    },
  };

  for (const lvl of ['warn', 'error']) {
    const orig = console[lvl].bind(console);
    console[lvl] = (...a) => {
      orig(...a);
      try {
        const msg = a.map((x) => (x instanceof Error ? (x.stack || x.message) : typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
        fire('log', { level: lvl, message: msg.slice(0, 2000) });
      } catch (e) { /* ignore */ }
    };
  }

  window.tenote = {
    toggle: () => call('window:toggle'),
    hide: () => call('window:hide'),
    resizeStart: (edge) => call('window:resizeStart', edge),
    resizeEnd: () => call('window:resizeEnd'),
    dragStart: () => call('window:dragStart'),
    dragEnd: () => call('window:dragEnd'),
    ensureSize: (opts) => call('window:ensureSize', opts),
    saveNote: (payload) => call('note:save', payload),
    listNotes: () => call('note:list'),
    readNote: (id) => call('note:read', id),
    recentNotes: (limit) => call('note:recent', limit),
    attachImage: (payload) => call('note:attach', payload),
    pathForFile: (f) => (f && droppedPaths.get(f.name)) || '',
    openNotesFolder: () => call('notes:openFolder'),
    openLogsFolder: () => call('logs:openFolder'),
    getState: () => call('state:get'),
    getSettings: () => call('settings:get'),
    setHideOnBlur: (v) => call('settings:setHideOnBlur', !!v),
    setLaunchAtLogin: (v) => call('settings:setLaunchAtLogin', !!v),
    setTheme: (t) => call('settings:setTheme', t),
    setHideBrand: (v) => call('settings:setHideBrand', !!v),
    setHideRecents: (v) => call('settings:setHideRecents', !!v),
    quit: () => call('app:quit'),
    log: (level, message) => fire('log', { level, message: String(message) }),
    invokePlugin: (plugin, method, args) => call('plugin:invoke', { plugin, method, args }),
    onPluginEvent: (cb) => { listeners.plugin.push(cb); },
    onShown: (cb) => { listeners.shown.push(cb); },
    onGoto: (cb) => { listeners.goto.push(cb); },
  };
})();
