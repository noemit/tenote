'use strict';

// ---------------------------------------------------------------------------
// Tenote — a tiny, free, open-source notes app.
// macOS / Electron. Press ⌥. (or your skhd binding) anywhere to open/close.
// Notes auto-save as Markdown files in ~/Documents/Tenote Notes.
// Everything is logged to ~/Library/Logs/Tenote/main.log (see logger.js).
// ---------------------------------------------------------------------------

const path = require('path');
const fs = require('fs');
const os = require('os');
const net = require('net');
const { execFile } = require('child_process');

const {
  app, BrowserWindow, globalShortcut, Tray, Menu, ipcMain, screen, shell, nativeImage, clipboard, protocol, dialog,
} = require('electron');


const logger = require('./logger');

const startedAt = Date.now();

// ---- config ----------------------------------------------------------------
const isMac = process.platform === 'darwin';
const APP_NAME = 'Tenote';
const WINDOW_WIDTH = 480;
const WINDOW_HEIGHT = 340;
const SHADOW_PAD = 48; // room around the card so the CSS shadow can fade out
const MIN_WINDOW_WIDTH = 320 + SHADOW_PAD * 2;
const MIN_WINDOW_HEIGHT = 220 + SHADOW_PAD * 2;
const BLUR_HIDE_DELAY = 160;          // ms after losing focus before hiding
const TOGGLE_COALESCE_MS = 250;       // swallow double-fire (skhd + built-in shortcut)
const MAX_NOTE_CHARS = 4 * 1024 * 1024; // absurd for a note; guards IPC + disk + parse loops

// Built-in global shortcut is registered by the core-shortcuts builtin plugin.
// Set TENOTE_SHORTCUT=0 to disable (use skhd instead), or TENOTE_SHORTCUT='Ctrl+Shift+Space' etc.

const NOTES_DIR = path.join(app.getPath('documents'), 'Tenote Notes');
const SETTINGS_PATH = path.join(app.getPath('userData'), 'settings.json');
const PLUGINS_USER_DIR = path.join(app.getPath('userData'), 'plugins');
const PLUGIN_DATA_ROOT = path.join(app.getPath('userData'), 'plugin-data');
// TENOTE_SOCKET must match scripts/tenotectl.js (and any skhd binding that uses it).
const SOCKET_PATH = process.env.TENOTE_SOCKET
  || path.join(os.tmpdir(), `tenote-${typeof process.getuid === 'function' ? process.getuid() : process.pid}.sock`);
const TRAY_ICON = path.join(__dirname, 'assets', 'trayTemplate.png');
const BUILTIN_SHORTCUT = process.env.TENOTE_SHORTCUT === '0' ? null : process.env.TENOTE_SHORTCUT || 'Alt+.';

app.setName(APP_NAME);

// Serve pasted images (stored under NOTES_DIR/images) and plugin renderer/theme
// assets to the renderer.
protocol.registerSchemesAsPrivileged([
  { scheme: 'timg', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
  { scheme: 'tnplug', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);
logger.init();
logger.setLevel(process.env.TENOTE_LOG_LEVEL === 'debug' ? 'debug' : 'info');

// ---- state -----------------------------------------------------------------
let win = null;
let tray = null;
let isQuitting = false;
let trayMenuOpen = false;
let lastToggleAt = 0;
let activeShortcut = null;
// True only for this process's first launch ever (persisted firstRunDone is set
// immediately so we don't re-greet next time; renderer still needs a one-shot flag).
let isFirstSession = false;

const settings = loadSettings();
const host = require('./lib/host').createHost({
  logger,
  settings,
  pluginDataRoot: PLUGIN_DATA_ROOT,
  persistSettings: saveSettings,
  envFiles: (process.env.TENOTE_PLUGINS || '').split(path.delimiter).filter(Boolean),
  layers: [
    { name: 'builtin', dir: path.join(__dirname, 'plugins', 'builtin') },
    { name: 'user', dir: PLUGINS_USER_DIR },
  ],
  onTrayDirty: () => rebuildTrayMenu(),
  onShortcut: registerPluginShortcut,
  hostService: handleHostService,
  onEmit: (event, payload) => {
    try { if (win && !win.isDestroyed()) win.webContents.send('plugin:event', { event, payload }); } catch (e) { /* ignore */ }
  },
  kernel: {
    notesDir: NOTES_DIR,
    notes: { list: listNotes, read: readNote, save: saveNote, recent: recentNotes },
    window: { toggle: toggleWindow, show: showWindow, hide: hideWindow },
    app: { quit: quitApp },
    system: { status: systemStatus },
  },
});

function defaultSettings() {
  return {
    hideOnBlur: false, launchAtLogin: false, hideBrand: false, hideRecents: false,
    showDockIcon: false, firstRunDone: false, theme: 'latte', lastImageSweep: 0,
    plugins: { disabled: [], paths: [], values: {} },
  };
}

function loadSettings() {
  let raw = null;
  try { raw = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8')); }
  catch (e) { /* first run — no settings file yet */ }
  const merged = Object.assign(defaultSettings(), raw || {});
  merged.plugins = Object.assign(defaultSettings().plugins, (raw && raw.plugins) || {});
  if (!Array.isArray(merged.plugins.disabled)) merged.plugins.disabled = [];
  if (!Array.isArray(merged.plugins.paths)) merged.plugins.paths = [];
  if (!merged.plugins.values || typeof merged.plugins.values !== 'object') merged.plugins.values = {};
  return merged;
}

// Write then rename so a crash mid-write can't leave a truncated file.
function atomicWriteFileSync(file, data, encoding) {
  const dir = path.dirname(file);
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.tmp`);
  try {
    fs.writeFileSync(tmp, data, encoding);
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (e2) { /* ignore */ }
    throw e;
  }
}

function saveSettings() {
  try {
    fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
    atomicWriteFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2), 'utf8');
  } catch (e) { logger.warn('settings', 'save failed', { error: e.message }); }
}

function applyDockIcon() {
  if (!isMac) return;
  const show = !!settings.showDockIcon;
  try {
    if (app.dock) {
      const icon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'icon.png'));
      if (!icon.isEmpty()) app.dock.setIcon(icon);
    }
    if (show) {
      app.setActivationPolicy('regular');
      if (app.dock) app.dock.show();
    } else {
      if (app.dock) app.dock.hide();
      app.setActivationPolicy('accessory');
    }
  } catch (e) { logger.warn('app', 'dock icon failed', { error: e.message, show }); }
  if (win) {
    try { win.setSkipTaskbar(!show); } catch (e) { /* ignore */ }
  }
}

// ---- single instance -------------------------------------------------------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  logger.info('app', 'another instance is running; quitting');
  app.quit();
} else {
  app.on('second-instance', () => { logger.info('app', 'second-instance -> show window'); showWindow(); });
  app.whenReady().then(bootstrap);
}

// ---- bootstrap -------------------------------------------------------------
function bootstrap() {
  logger.info('app', 'bootstrap', {
    version: app.getVersion(), electron: process.versions.electron, chrome: process.versions.chrome,
    node: process.versions.node, platform: process.platform, arch: process.arch,
    shortcut: BUILTIN_SHORTCUT, notesDir: NOTES_DIR, socket: SOCKET_PATH, logFile: logger.getLogFile(),
    hideOnBlur: settings.hideOnBlur, launchAtLogin: settings.launchAtLogin,
    startedAt,
  });

  applyDockIcon();
  try { ensureTrayIcon(); } catch (e) { logger.warn('icons', 'icon generation failed', { error: e.message }); }

  seedExamplePlugins();
  host.discover();
  // TENOTE_NO_PLUGINS=1 leaves every plugin listed-but-inactive for the
  // session — a support escape hatch for bisecting a misbehaving plugin
  // (they can still be turned on live, one at a time, from Settings).
  if (process.env.TENOTE_NO_PLUGINS) logger.warn('plugins', 'TENOTE_NO_PLUGINS=1 — skipping activation');
  else host.activateAll();

  startSocketServer();
  createWindow();
  setupTray();
  setupIpc();
  setupImageProtocol();
  setupPluginProtocol();
  if (isMac) applyLoginItem();

  if (!settings.firstRunDone) {
    isFirstSession = true;
    settings.firstRunDone = true;
    saveSettings();
    logger.info('app', 'first run — showing window to greet');
    setTimeout(showWindow, 300);
  }
  // Delay the daily image sweep well past first paint — it reads every note,
  // which can trigger downloads in an iCloud-synced folder and must not stall
  // startup (it runs async, off the event loop, once it does run).
  setTimeout(maybeSweepImages, 30000);
}

// ---- window ----------------------------------------------------------------
function createWindow() {
  win = new BrowserWindow({
    width: WINDOW_WIDTH + SHADOW_PAD * 2,
    height: WINDOW_HEIGHT + SHADOW_PAD * 2,
    minWidth: MIN_WINDOW_WIDTH,
    minHeight: MIN_WINDOW_HEIGHT,
    show: false,
    frame: false,
    transparent: true,
    resizable: true,
    movable: true,
    fullscreenable: false,
    maximizable: false,
    minimizable: false,
    alwaysOnTop: true,
    skipTaskbar: !settings.showDockIcon,
    hasShadow: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.setAlwaysOnTop(true, 'floating');
  if (isMac) {
    try { win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true }); }
    catch (e) { logger.warn('window', 'setVisibleOnAllWorkspaces failed', { error: e.message }); }
  }

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  win.webContents.on('did-finish-load', () => {
    logger.debug('window', 'renderer did-finish-load', { ms: Date.now() - startedAt });
    injectRendererPlugins();
  });
  win.webContents.on('did-fail-load', (e, code, desc, url) => logger.error('window', 'did-fail-load', { code, desc, url }));
  win.webContents.on('render-process-gone', (e, details) => logger.error('window', 'render-process-gone', details));
  win.webContents.on('console-message', (details, level, message, line, sourceId) => {
    // Electron 43: first arg is an Event with .params; legacy positional args are deprecated.
    const p = (details && details.params) || {};
    const lvlMap = { info: 'debug', warning: 'warn', error: 'error', debug: 'debug' };
    const lvl = lvlMap[p.level || 'info'] || 'debug';
    const msg = p.message !== undefined ? p.message : message;
    if (lvl === 'debug' && !msg) return;
    logger.log(lvl, 'renderer', String(msg).slice(0, 2000), p.sourceId ? { source: p.sourceId, line: p.lineNumber } : undefined);
  });

  // Links in rendered notes open in the default browser — never inside
  // this frameless window (there would be no way back to the notes UI).
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) { try { shell.openExternal(url); } catch (e) { /* ignore */ } }
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!/^https?:\/\//.test(url)) return; // allow the app's own file:// load
    e.preventDefault();
    try { shell.openExternal(url); } catch (err) { /* ignore */ }
  });

  win.on('show', () => logger.debug('window', 'shown'));
  win.on('hide', () => logger.debug('window', 'hidden'));
  win.on('blur', () => {
    if (settings.hideOnBlur && !trayMenuOpen && win.isVisible()) {
      setTimeout(() => {
        if (win && win.isVisible() && !win.isFocused() && !trayMenuOpen) {
          logger.debug('window', 'blur -> hide');
          hideWindow();
        }
      }, BLUR_HIDE_DELAY);
    }
  });
  win.on('close', (e) => {
    if (!isQuitting) { e.preventDefault(); logger.debug('window', 'close prevented -> hide'); win.hide(); }
  });
  win.on('closed', () => { win = null; stopResize(); });
  // Chromium's drag-region double-click can zoom/fullscreen the window on macOS
  // even with maximizable:false / fullscreenable:false. A screen-sized transparent
  // window swallows clicks and has crashed the renderer. Refuse both states.
  win.on('maximize', () => { try { win.unmaximize(); } catch (e) { /* ignore */ } });
  win.on('enter-full-screen', () => { try { win.setFullScreen(false); } catch (e) { /* ignore */ } });
}

const RESIZE_EDGES = new Set(['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']);
let resizeTick = null;
let resizeState = null;

function stopResize() {
  if (resizeTick) { clearInterval(resizeTick); resizeTick = null; }
  resizeState = null;
}

let menuGrowFrom = null;

function ensureMenuSize(opts) {
  if (!win || win.isDestroyed()) return false;
  const o = opts || {};
  if (o.restore) {
    if (!menuGrowFrom) return true;
    const b = win.getBounds();
    const w = menuGrowFrom.width;
    const h = menuGrowFrom.height;
    const x = b.x + (b.width - w);
    win.setBounds({ x: Math.round(x), y: b.y, width: w, height: h });
    menuGrowFrom = null;
    return true;
  }
  const wantW = Math.round(Number(o.width) || 0);
  const wantH = Math.round(Number(o.height) || 0);
  if (wantW < 1 && wantH < 1) return false;
  const b = win.getBounds();
  const w = Math.max(b.width, wantW);
  const h = Math.max(b.height, wantH);
  if (w === b.width && h === b.height) return true;
  const wa = screen.getDisplayMatching(b).workArea;
  if (!menuGrowFrom) menuGrowFrom = { x: b.x, y: b.y, width: b.width, height: b.height };
  const dw = w - b.width;
  let x = b.x - dw;
  let nw = w;
  let nh = h;
  if (x < wa.x) { nw -= (wa.x - x); x = wa.x; }
  if (b.y + nh > wa.y + wa.height) nh = Math.max(b.height, wa.y + wa.height - b.y);
  if (x + nw > wa.x + wa.width) nw = wa.x + wa.width - x;
  if (nw < MIN_WINDOW_WIDTH) {
    nw = MIN_WINDOW_WIDTH;
    if (x + nw > wa.x + wa.width) x = wa.x + wa.width - nw;
  }
  if (nh < MIN_WINDOW_HEIGHT) nh = MIN_WINDOW_HEIGHT;
  win.setBounds({ x: Math.round(x), y: b.y, width: Math.round(nw), height: Math.round(nh) });
  return true;
}

function startResize(edge) {
  if (!win || !RESIZE_EDGES.has(String(edge || ''))) return;
  menuGrowFrom = null;
  stopResize();
  resizeState = { edge: String(edge), start: screen.getCursorScreenPoint(), bounds: { ...win.getBounds() } };
  resizeTick = setInterval(() => {
    if (!win || !resizeState) { stopResize(); return; }
    const p = screen.getCursorScreenPoint();
    const dx = p.x - resizeState.start.x;
    const dy = p.y - resizeState.start.y;
    const b = resizeState.bounds;
    const e = resizeState.edge;
    let { x, y, width, height } = b;
    if (e.includes('e')) width = b.width + dx;
    if (e.includes('w')) { width = b.width - dx; x = b.x + dx; }
    if (e.includes('s')) height = b.height + dy;
    if (e.includes('n')) { height = b.height - dy; y = b.y + dy; }
    if (width < MIN_WINDOW_WIDTH) {
      if (e.includes('w')) x = b.x + b.width - MIN_WINDOW_WIDTH;
      width = MIN_WINDOW_WIDTH;
    }
    if (height < MIN_WINDOW_HEIGHT) {
      if (e.includes('n')) y = b.y + b.height - MIN_WINDOW_HEIGHT;
      height = MIN_WINDOW_HEIGHT;
    }
    win.setBounds({ x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) });
  }, 16);
}

function showWindow() {
  if (!win) return;
  try {
    const cp = screen.getCursorScreenPoint();
    const d = screen.getDisplayNearestPoint(cp);
    const wa = d.workArea;
    const [w, h] = win.getSize();
    // Card is inset by SHADOW_PAD; sit it just below-right of the cursor.
    let x = cp.x - SHADOW_PAD + 12;
    let y = cp.y - SHADOW_PAD + 12;
    x = Math.round(Math.max(wa.x, Math.min(x, wa.x + wa.width - w)));
    y = Math.round(Math.max(wa.y, Math.min(y, wa.y + wa.height - h)));
    win.setPosition(x, y, false);
  } catch (e) { logger.warn('window', 'positioning failed', { error: e.message }); }

  win.show();
  win.moveTop();
  win.focus();
  if (isMac) { try { app.focus({ steal: true }); } catch (e) { /* ignore */ } }
  setTimeout(() => { if (win && win.isVisible() && !win.isFocused()) win.focus(); }, 80);
  try { win.webContents.send('window:shown'); } catch (e) { /* renderer may not be ready yet */ }
  firePluginEvent('window:shown', {});
}

function hideWindow() {
  stopResize();
  // Note: menuGrowFrom intentionally survives hide — the renderer closes any
  // open popovers on next show and restores the pre-grow window size then.
  if (win) win.hide();
  firePluginEvent('window:hidden', {});
}

function firePluginEvent(event, payload) {
  try { host.emit(event, payload); } catch (e) { logger.error('plugins', `emit ${event}`, { error: e.message }); }
}

// Ship the bundled examples into the user plugins dir (disabled) once, so the
// Plugins menu shows everything there is to try.
function seedExamplePlugins() {
  if (settings.plugins.examplesSeeded) return;
  const src = path.join(__dirname, 'examples');
  let entries;
  try { entries = fs.readdirSync(src, { withFileTypes: true }); } catch (e) { entries = []; }
  const disabled = new Set(settings.plugins.disabled);
  let copied = 0;
  for (const ent of entries) {
    if (!ent.isDirectory() || ent.name.startsWith('.') || ent.name.startsWith('_')) continue;
    const from = path.join(src, ent.name);
    const to = path.join(PLUGINS_USER_DIR, ent.name);
    let name = ent.name;
    try {
      const m = JSON.parse(fs.readFileSync(path.join(from, 'plugin.json'), 'utf8'));
      if (m && typeof m.name === 'string' && PLUGIN_NAME_RE.test(m.name)) name = m.name;
    } catch (e) { /* no manifest — dir name wins */ }
    try {
      if (!fs.existsSync(to)) { fs.cpSync(from, to, { recursive: true }); copied++; }
      disabled.add(name);
    } catch (e) {
      logger.warn('plugins', `seed failed for example "${ent.name}"`, { error: e.message });
    }
  }
  settings.plugins.disabled = [...disabled].sort();
  settings.plugins.examplesSeeded = true;
  saveSettings();
  logger.info('plugins', `seeded ${copied} example plugins (disabled)`);
}

function toggleWindow() {
  const now = Date.now();
  if (now - lastToggleAt < TOGGLE_COALESCE_MS) {
    logger.debug('window', 'toggle coalesced (skhd + built-in shortcut double fire)');
    return;
  }
  lastToggleAt = now;
  if (!win) return;
  if (win.isVisible()) { hideWindow(); }
  else showWindow();
}

// ---- shortcuts (registered by plugins via the host) ------------------------
const pluginShortcuts = new Map(); // owner -> Set of accelerators

function registerPluginShortcut({ accelerator, fn, owner }) {
  try {
    if (!globalShortcut.register(accelerator, () => {
      const r = hostSafeCall('shortcut', accelerator, fn);
      void r;
    })) return false;
    // activeShortcut drives the tray/menu shortcut label — that's the toggle
    // shortcut, owned by core-shortcuts. Later plugins registering shortcuts
    // must not clobber the label.
    if (owner === 'core-shortcuts' || !activeShortcut) activeShortcut = accelerator;
    if (owner) {
      if (!pluginShortcuts.has(owner)) pluginShortcuts.set(owner, new Set());
      pluginShortcuts.get(owner).add(accelerator);
    }
    logger.info('shortcut', 'registered', { shortcut: accelerator });
    return true;
  } catch (e) {
    logger.warn('shortcut', 'register threw', { shortcut: accelerator, error: e.message });
    return false;
  }
}

function unregisterPluginShortcuts(owner) {
  const accs = pluginShortcuts.get(owner);
  if (!accs) return;
  for (const acc of accs) {
    try { globalShortcut.unregister(acc); } catch (e) { /* ignore */ }
  }
  pluginShortcuts.delete(owner);
  if (accs.has(activeShortcut)) activeShortcut = null; // label falls back to BUILTIN_SHORTCUT
}

function hostSafeCall(label, owner, fn) {
  try { return fn(); }
  catch (e) { logger.error('plugins', `${label} threw (${owner})`, { error: e && e.stack || String(e) }); }
}

// ---- socket server (used by skhd -> scripts/tenotectl.js) ------------------
function startSocketServer() {
  try { if (fs.existsSync(SOCKET_PATH)) fs.unlinkSync(SOCKET_PATH); } catch (e) { /* ignore */ }
  const server = net.createServer((sock) => {
    sock.setEncoding('utf8');
    let buf = '';
    sock.on('data', (d) => {
      buf += d;
      let i = buf.indexOf('\n');
      while (i >= 0) {
        const cmd = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        handleSocketCommand(cmd, sock);
        i = buf.indexOf('\n');
      }
    });
    sock.on('error', (e) => logger.warn('socket', 'client error', { error: e.message }));
  });
  server.on('error', (e) => logger.error('socket', 'listen error', { error: e.message, path: SOCKET_PATH }));
  server.listen(SOCKET_PATH, () => {
    // Only this user may send commands (the socket lives in the shared tmpdir).
    try { fs.chmodSync(SOCKET_PATH, 0o600); } catch (e) { /* ignore */ }
    logger.info('socket', 'listening', { path: SOCKET_PATH });
  });
}

function handleSocketCommand(cmd, sock) {
  logger.info('socket', 'command', { cmd });
  const reply = (s) => { try { sock.end(s); } catch (e) { /* ignore */ } };
  if (host.hasCommand(cmd)) {
    const result = host.runCommand(cmd);
    Promise.resolve(result)
      .then((r) => reply(formatReply(r)))
      .catch((e) => { logger.error('socket', `command ${cmd} failed`, { error: e && e.message || e }); reply('error\n'); });
    return;
  }
  reply('unknown command: ' + cmd + '\n');
}

function formatReply(r) {
  if (r === undefined || r === null) return 'ok\n';
  if (typeof r === 'string') return r.endsWith('\n') ? r : r + '\n';
  try { return JSON.stringify(r) + '\n'; } catch (e) { return 'ok\n'; }
}

function systemStatus() {
  return {
    running: true,
    visible: !!(win && win.isVisible()),
    shortcut: shortcutLabel(),
    version: app.getVersion(),
    plugins: host.publicList(),
  };
}

// ---- plugin installation (settings → Plugins → Install from file…) ---------
const PLUGIN_NAME_RE = /^[\w][\w.-]{0,63}$/;

async function installPluginInteractive() {
  let picked;
  try {
    picked = await dialog.showOpenDialog(win, {
      title: 'Choose a Tenote plugin',
      buttonLabel: 'Install',
      properties: ['openFile', 'openDirectory'],
      filters: [
        { name: 'Tenote plugin (.zip, .js, folder)', extensions: ['zip', 'js'] },
        { name: 'All Files', extensions: ['*'] },
      ],
    });
  } catch (e) {
    return { ok: false, error: e.message };
  }
  if (picked.canceled || !picked.filePaths.length) return { ok: false, canceled: true };
  try {
    const name = await installPluginFrom(picked.filePaths[0]);
    logger.info('plugins', `installed "${name}" from ${picked.filePaths[0]}`);
    return { ok: true, name };
  } catch (e) {
    logger.warn('plugins', `install failed (${picked.filePaths[0]})`, { error: e.message });
    return { ok: false, error: e.message };
  }
}

function installPluginFrom(src) {
  if (/\.zip$/i.test(src)) return installZippedPlugin(src);
  return Promise.resolve().then(() => placePlugin(src));
}

function installZippedPlugin(zipPath) {
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'tenote-plugin-'));
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/ditto', ['-x', '-k', zipPath, staging], (err) => {
      if (err) { try { fs.rmSync(staging, { recursive: true, force: true }); } catch (e2) { /* ignore */ } return reject(new Error('could not unpack the zip')); }
      try {
        const root = findPluginRoot(staging);
        const name = placePlugin(root);
        resolve(name);
      } catch (e) {
        reject(e);
      } finally {
        try { fs.rmSync(staging, { recursive: true, force: true }); } catch (e2) { /* ignore */ }
      }
    });
  });
}

function findPluginRoot(dir) {
  if (fs.existsSync(path.join(dir, 'plugin.json')) || fs.existsSync(path.join(dir, 'index.js'))) return dir;
  try {
    const subs = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => path.join(dir, d.name)).sort();
    for (const sub of subs) {
      if (fs.existsSync(path.join(sub, 'plugin.json')) || fs.existsSync(path.join(sub, 'index.js'))) return sub;
    }
  } catch (e) { /* fallthrough */ }
  throw new Error('no plugin found in the zip (looking for plugin.json or index.js)');
}

function placePlugin(src) {
  let st;
  try { st = fs.statSync(src); } catch (e) { throw new Error('file not found'); }
  const isDir = st.isDirectory();
  const base = path.basename(src, isDir ? '' : '.js');
  let manifestName = null;
  if (isDir) {
    try {
      const m = JSON.parse(fs.readFileSync(path.join(src, 'plugin.json'), 'utf8'));
      if (m && typeof m.name === 'string') manifestName = m.name;
    } catch (e) { /* manifest optional */ }
  }
  const name = manifestName || base;
  if (!PLUGIN_NAME_RE.test(name)) throw new Error(`invalid plugin name: ${name}`);
  const looksLikePlugin = !isDir
    || fs.existsSync(path.join(src, 'plugin.json'))
    || fs.existsSync(path.join(src, 'index.js'))
    || fs.readdirSync(src).some((f) => f.endsWith('.js'));
  if (!looksLikePlugin) throw new Error('that folder does not look like a Tenote plugin');
  const dest = path.join(PLUGINS_USER_DIR, name);
  if (!path.resolve(dest).startsWith(path.resolve(PLUGINS_USER_DIR) + path.sep)) throw new Error('bad destination');
  if (fs.existsSync(dest)) throw new Error(`"${name}" is already installed — remove it first (Open plugins folder)`);
  fs.mkdirSync(PLUGINS_USER_DIR, { recursive: true });
  // Always copy — installing must not move the user's picked folder/file away
  // from where they keep it. Bare .js files become <name>/index.js so the
  // directory scanner discovers them (an extensionless file would be skipped).
  if (isDir) fs.cpSync(src, dest, { recursive: true });
  else { fs.mkdirSync(dest, { recursive: true }); fs.copyFileSync(src, path.join(dest, 'index.js')); }
  return name;
}

// ---- tray ------------------------------------------------------------------
function setupTray() {
  try {
    const image = nativeImage.createFromPath(TRAY_ICON);
    if (image.isEmpty()) { logger.warn('tray', 'tray icon missing/empty', { path: TRAY_ICON }); return; }
    if (isMac) image.setTemplateImage(true);
    tray = new Tray(image);
    tray.setToolTip('Tenote — ⌥. (or skhd) to toggle');
    tray.on('click', () => toggleWindow());
    tray.on('right-click', () => tray.popUpContextMenu());
    tray.on('menu-will-show', () => { trayMenuOpen = true; });
    tray.on('menu-will-close', () => { setTimeout(() => { trayMenuOpen = false; }, 250); });
    rebuildTrayMenu();
    logger.info('tray', 'ready');
  } catch (e) { logger.error('tray', 'setup failed', { error: e.message }); }
}

function rebuildTrayMenu() {
  if (!tray) return;
  const template = [
    { label: 'Open Tenote', click: () => showWindow() },
    {
      label: 'All notes',
      click: () => {
        showWindow();
        setTimeout(() => { try { win.webContents.send('ui:goto', 'history'); } catch (e) { /* ignore */ } }, 120);
      },
    },
    {
      label: 'Open Notes Folder',
      click: () => {
        try { fs.mkdirSync(NOTES_DIR, { recursive: true }); shell.openPath(NOTES_DIR); }
        catch (e) { logger.warn('tray', 'open folder failed', { error: e.message }); }
      },
    },
  ];
  const pluginItems = trayPluginItems();
  if (pluginItems.length) {
    template.push({ type: 'separator' });
    template.push(...pluginItems);
  }
  template.push(
    { type: 'separator' },
    {
      label: 'Hide when focus lost', type: 'checkbox', checked: settings.hideOnBlur,
      click: (item) => { settings.hideOnBlur = item.checked; saveSettings(); rebuildTrayMenu(); logger.info('settings', 'hideOnBlur', { value: settings.hideOnBlur }); },
    },
    {
      label: 'Launch at login', type: 'checkbox', checked: settings.launchAtLogin,
      click: (item) => { settings.launchAtLogin = item.checked; saveSettings(); applyLoginItem(); rebuildTrayMenu(); logger.info('settings', 'launchAtLogin', { value: settings.launchAtLogin }); },
    },
    {
      label: 'Show in Dock', type: 'checkbox', checked: settings.showDockIcon,
      click: (item) => { settings.showDockIcon = item.checked; saveSettings(); applyDockIcon(); logger.info('settings', 'showDockIcon', { value: settings.showDockIcon }); },
    },
    { type: 'separator' },
    { label: 'Open Logs Folder', click: () => { try { shell.openPath(logger.getLogDir()); } catch (e) { /* ignore */ } } },
    { label: 'Copy Log Path', click: () => { clipboard.writeText(logger.getLogFile()); } },
    { type: 'separator' },
    { label: shortcutHintLabel(), enabled: false },
    { label: 'Quit Tenote', click: () => quitApp() },
  );
  const menu = Menu.buildFromTemplate(template);
  tray.setContextMenu(menu);
}

function trayPluginItems() {
  const items = host._internal.trayItems;
  if (!items.length) return [];
  const out = items.map((it) => ({
    label: it.label,
    type: it.type,
    checked: it.checked || undefined,
    click: () => hostSafeCall('tray item', it.owner, it.click),
  }));
  return [{ label: 'Plugins', enabled: false }, ...out];
}

function shortcutLabel() {
  const s = activeShortcut || BUILTIN_SHORTCUT;
  if (!s) return 'via skhd';
  return s.split('+').map((p) => ({ Alt: '⌥', Shift: '⇧', CommandOrControl: '⌘', CmdOrCtrl: '⌘', Command: '⌘', Control: '⌃' }[p] || p)).join('');
}

function shortcutHintLabel() {
  const s = activeShortcut || BUILTIN_SHORTCUT;
  if (!s) return 'Toggle with your skhd binding';
  return `Press ${shortcutLabel()} anywhere to show/hide Tenote`;
}

// ---- login item ------------------------------------------------------------
function applyLoginItem() {
  try {
    app.setLoginItemSettings({ openAtLogin: settings.launchAtLogin, openAsHidden: true });
    logger.info('settings', 'login item applied', { openAtLogin: settings.launchAtLogin });
  } catch (e) { logger.warn('settings', 'setLoginItemSettings failed', { error: e.message }); }
}

// ---- IPC -------------------------------------------------------------------
function setupIpc() {
  ipcMain.on('log', (e, entry) => {
    const lvl = entry && entry.level;
    logger.log(['debug', 'info', 'warn', 'error'].includes(lvl) ? lvl : 'info', 'renderer', (entry && entry.message) || '');
  });

  ipcMain.handle('window:toggle', () => { toggleWindow(); return { visible: !!(win && win.isVisible()) }; });
  ipcMain.handle('window:hide', () => { hideWindow(); return true; });
  ipcMain.handle('window:resizeStart', (e, edge) => { startResize(edge); return true; });
  ipcMain.handle('window:resizeEnd', () => { stopResize(); return true; });
  ipcMain.handle('window:ensureSize', (e, opts) => ensureMenuSize(opts));
  ipcMain.handle('state:get', () => ({
    notesDir: NOTES_DIR,
    shortcut: shortcutLabel(),
    windowVisible: !!(win && win.isVisible()),
    firstRun: isFirstSession,
  }));
  ipcMain.handle('settings:get', () => ({ ...settings }));
  ipcMain.handle('settings:setHideOnBlur', (e, value) => {
    settings.hideOnBlur = !!value; saveSettings(); rebuildTrayMenu();
    logger.info('settings', 'hideOnBlur (from ui)', { value: settings.hideOnBlur });
    return { ...settings };
  });
  ipcMain.handle('settings:setLaunchAtLogin', (e, value) => {
    settings.launchAtLogin = !!value; saveSettings(); applyLoginItem(); rebuildTrayMenu();
    logger.info('settings', 'launchAtLogin (from ui)', { value: settings.launchAtLogin });
    return { ...settings };
  });
  ipcMain.handle('settings:setTheme', (e, value) => {
    const t = String(value || 'latte');
    settings.theme = host.hasTheme(t) ? t : 'latte';
    saveSettings();
    logger.info('settings', 'theme (from ui)', { value: settings.theme });
    firePluginEvent('theme:changed', { theme: settings.theme });
    return { ...settings };
  });
  ipcMain.handle('settings:setHideBrand', (e, value) => {
    settings.hideBrand = !!value; saveSettings();
    logger.info('settings', 'hideBrand (from ui)', { value: settings.hideBrand });
    return { ...settings };
  });
  ipcMain.handle('settings:setHideRecents', (e, value) => {
    settings.hideRecents = !!value; saveSettings();
    logger.info('settings', 'hideRecents (from ui)', { value: settings.hideRecents });
    return { ...settings };
  });

  ipcMain.handle('logs:openFolder', () => {
    try { return shell.openPath(logger.getLogDir()); }
    catch (err) { return String(err && err.message || err); }
  });
  ipcMain.handle('app:quit', () => { quitApp(); return true; });
  ipcMain.handle('notes:openFolder', () => {
    try { fs.mkdirSync(NOTES_DIR, { recursive: true }); return shell.openPath(NOTES_DIR); }
    catch (err) { return String(err && err.message || err); }
  });

  ipcMain.handle('note:save', (e, payload) => wrapIpc('note:save', payload, saveNote));
  ipcMain.handle('note:list', (e) => wrapIpc('note:list', null, listNotes));
  ipcMain.handle('note:read', (e, id) => wrapIpc('note:read', id, (cleanId) => {
    const note = readNote(cleanId);
    if (note) firePluginEvent('note:opened', { id: note.id });
    return note;
  }));
  ipcMain.handle('note:recent', (e, limit) => wrapIpc('note:recent', limit, recentNotes));
  ipcMain.handle('note:attach', (e, payload) => wrapIpc('note:attach', payload, attachImage));

  ipcMain.handle('plugin:invoke', async (e, payload) => {
    try {
      const p = payload || {};
      const result = await host.invoke(String(p.plugin || ''), String(p.method || ''), p.args);
      return { ok: true, result };
    } catch (err) {
      logger.warn('plugins', 'invoke failed', { error: err && err.message || err });
      return { ok: false, error: String(err && err.message || err) };
    }
  });
}

function handleHostService(method, args) {
  const a = args || {};
  switch (method) {
    case 'state':
      return { plugins: host.publicList(), themes: host.themeList(), themeId: settings.theme || 'latte' };
    case 'themeCss': {
      if (!host.hasTheme(String(a.id))) throw new Error('unknown theme');
      return host.themeCss(String(a.id));
    }
    case 'setEnabled': {
      const name = String(a.name);
      const turningOn = !!a.enabled;
      if (!turningOn) unregisterPluginShortcuts(name);
      const ok = turningOn ? host.enable(name) : host.disable(name);
      logger.info('plugins', `setEnabled ${name} -> ${turningOn} (${ok ? 'live' : 'failed'})`);
      const rec = host.getRecord(name);
      if (turningOn && ok && rec && rec.rendererPath) {
        injectRendererEntry({ id: name, path: rec.rendererPath });
      } else if (!turningOn) {
        try { if (win && !win.isDestroyed()) win.webContents.send('plugin:event', { event: '__tenote:deactivate', payload: { id: name } }); } catch (e) { /* ignore */ }
      }
      rebuildTrayMenu();
      return { ok, active: !!(rec && rec.state === 'ok') };
    }
    case 'pluginInfo': {
      const name = String(a.name);
      const rec = host.getRecord(name);
      if (!rec) throw new Error('unknown plugin: ' + name);
      // Async so a slow/synced plugin dir never blocks the loop. The README is
      // optional bonus content — the plugin.json description is the baseline.
      return (async () => {
        let readme = null;
        try {
          if (rec.dir && fs.statSync(rec.dir).isDirectory()) {
            for (const fn of ['README.md', 'readme.md', 'README.txt', 'README']) {
              try {
                readme = (await fs.promises.readFile(path.join(rec.dir, fn), 'utf8')).slice(0, 32768);
                break;
              } catch (e) { /* try the next filename */ }
            }
          }
        } catch (e) { /* no readable dir (bare-file plugin) */ }
        return {
          name: rec.name,
          version: rec.version,
          layer: rec.layer,
          state: rec.state,
          error: rec.error || null,
          description: rec.description || null,
          readme,
        };
      })();
    }
    case 'openPluginsFolder': {
      try { fs.mkdirSync(PLUGINS_USER_DIR, { recursive: true }); } catch (e) { /* ignore */ }
      shell.openPath(PLUGINS_USER_DIR);
      return true;
    }
    case 'installPlugin':
      return installPluginInteractive();
    case 'copyPng': {
      try {
        const buf = Buffer.from(String(a.base64 || ''), 'base64');
        clipboard.writeImage(nativeImage.createFromBuffer(buf));
        return { ok: true };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    }
    case 'getPluginSettings': {
      const name = String(a.name || '');
      return (settings.plugins.values[name] && typeof settings.plugins.values[name] === 'object')
        ? { ...settings.plugins.values[name] } : {};
    }
    case 'setPluginSetting': {
      const name = String(a.name || '');
      if (!host.publicList().some((p) => p.name === name)) throw new Error('unknown plugin');
      if (!settings.plugins.values[name] || typeof settings.plugins.values[name] !== 'object') settings.plugins.values[name] = {};
      settings.plugins.values[name][String(a.key)] = a.value;
      saveSettings();
      return { ok: true };
    }
    default:
      throw new Error('unknown host method: ' + method);
  }
}

function wrapIpc(name, payload, fn) {
  // Handlers may be sync or async — normalize to a promise so async file I/O
  // never has to block the event loop to fit this wrapper.
  try {
    return Promise.resolve()
      .then(() => fn(payload))
      .catch((err) => {
        logger.error('ipc', name + ' failed', { error: err && err.stack || String(err) });
        return { ok: false, error: String(err && err.message || err) };
      });
  } catch (err) {
    logger.error('ipc', name + ' failed', { error: err && err.stack || String(err) });
    return { ok: false, error: String(err && err.message || err) };
  }
}

// ---- notes -----------------------------------------------------------------
function serializeNote(meta, body) {
  const tags = (meta.tags || []).join(', ');
  return `---\nid: ${meta.id}\ncreated: ${meta.created}\nupdated: ${meta.updated}\ntags: [${tags}]\n---\n\n${body.replace(/\s+$/, '')}\n`;
}

function parseNote(raw) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  const meta = { id: null, created: null, updated: null, tags: [] };
  let body = raw;
  if (m) {
    body = raw.slice(m[0].length);
    for (const line of m[1].split(/\r?\n/)) {
      const kv = /^([A-Za-z]+):\s*(.*)$/.exec(line);
      if (!kv) continue;
      const k = kv[1];
      const v = kv[2].trim();
      if (k === 'tags') meta.tags = v.replace(/^\[|\]$/g, '').split(',').map((s) => s.trim()).filter(Boolean);
      else meta[k] = v.replace(/^['"]|['"]$/g, '');
    }
  }
  return { meta, body: body.replace(/^\s*\n/, '') };
}

const ID_RE = /^[\w\-.:]+$/;
function safeId(id) { return typeof id === 'string' && ID_RE.test(id) && id.length <= 80 ? id : null; }
function noteFile(id) { return path.join(NOTES_DIR, id + '.md'); }

function readNoteMeta(id) {
  try { return parseNote(fs.readFileSync(noteFile(id), 'utf8')).meta; }
  catch (e) { return null; }
}

function saveNote(payload) {
  const p = payload || {};
  const piped = host.applyBeforeSave({ id: safeId(p.id), text: String(p.text || ''), tags: Array.isArray(p.tags) ? p.tags : [] });
  const text = String(piped.text || '');
  if (text.length > MAX_NOTE_CHARS) return { ok: false, error: 'note is too large (max 4 MB) — split it up' };
  let id = safeId(piped.id);
  let created = null;

  if (id) {
    const existing = readNoteMeta(id);
    created = existing ? existing.created : null;
  } else {
    // New note: two notes started in the same second must not share a file.
    const base = formatTimestamp(now());
    id = base;
    let n = 2;
    while (fs.existsSync(noteFile(id))) id = `${base}-${n++}`;
  }

  const file = noteFile(id);

  if (!text.trim()) {
    if (fs.existsSync(file)) {
      fs.unlinkSync(file);
      logger.info('note', 'deleted empty note', { id });
      firePluginEvent('note:saved', { id, deleted: true });
    }
    return { ok: true, id, deleted: true };
  }

  fs.mkdirSync(NOTES_DIR, { recursive: true });
  const meta = { id, created: created || now().toISOString(), updated: now().toISOString(), tags: sanitizeTags(piped.tags) };
  atomicWriteFileSync(file, serializeNote(meta, text), 'utf8');
  logger.debug('note', 'saved', { id, length: text.length, tags: meta.tags });
  firePluginEvent('note:saved', { id, deleted: false, updated: meta.updated });
  return { ok: true, id, created: meta.created, updated: meta.updated, path: file, deleted: false };
}

function now() { return new Date(); }

function sanitizeTags(tags) {
  if (!Array.isArray(tags)) return [];
  const seen = new Set();
  const out = [];
  for (const t of tags) {
    const s = String(t).replace(/^#/, '').replace(/[^\w\u00C0-\uFFFF\-+]/g, '').slice(0, 24);
    if (s && !seen.has(s)) { seen.add(s); out.push(s); }
    if (out.length >= 8) break;
  }
  return out;
}

function formatTimestamp(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

// Reads only the first `bytes` of a file — enough for frontmatter + title +
// 140-char snippet, and dramatically cheaper than full reads for large folders.
// Async on purpose: in an iCloud-synced folder, reading an evicted (cloud-only)
// file blocks until it downloads — that must stall a worker thread, never the
// main event loop (a blocked loop freezes EVERY IPC: settings, chips, toggles).
async function readFileHead(file, bytes) {
  let fh;
  try {
    fh = await fs.promises.open(file, 'r');
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await fh.read(buf, 0, bytes, 0);
    return buf.toString('utf8', 0, bytesRead);
  } catch (e) { return ''; }
  finally { try { if (fh) await fh.close(); } catch (e) { /* ignore */ } }
}

async function listNotes() {
  try {
    if (!fs.existsSync(NOTES_DIR)) return [];
    const files = (await fs.promises.readdir(NOTES_DIR)).filter((f) => f.endsWith('.md'));
    const notes = (await Promise.all(files.map(async (f) => {
      try {
        const raw = await readFileHead(path.join(NOTES_DIR, f), 2048);
        const { meta, body } = parseNote(raw);
        return {
          id: meta.id || f.replace(/\.md$/, ''),
          created: meta.created || null,
          updated: meta.updated || null,
          tags: meta.tags || [],
          title: titleOf(body),
          snippet: snippetOf(body),
        };
      } catch (e) { return null; }
    })))
      .filter(Boolean)
      .sort((a, b) => String(b.updated || '').localeCompare(String(a.updated || '')));
    logger.debug('note', 'listed', { count: notes.length });
    return notes;
  } catch (e) {
    logger.error('note', 'list failed', { error: e.message });
    return [];
  }
}

async function readNote(id) {
  const clean = safeId(id);
  if (!clean) return null;
  try {
    const raw = await fs.promises.readFile(noteFile(clean), 'utf8');
    const { meta, body } = parseNote(raw);
    return { id: clean, created: meta.created, updated: meta.updated, tags: meta.tags || [], body };
  } catch (e) {
    logger.warn('note', 'read failed', { id: clean, error: e.message });
    return null;
  }
}

// The 3 most recent notes, cheap: sorts by file mtime (no full scan needed).
// Returns { notes, total } — total drives the "+N more" overflow card.
async function recentNotes(limit) {
  const n = Math.max(1, Math.min(parseInt(limit, 10) || 3, 8));
  try {
    if (!fs.existsSync(NOTES_DIR)) return { notes: [], total: 0 };
    const files = (await fs.promises.readdir(NOTES_DIR)).filter((f) => f.endsWith('.md'));
    const stats = await Promise.all(files.map(async (f) => {
      try { return { f, m: (await fs.promises.stat(path.join(NOTES_DIR, f))).mtimeMs }; }
      catch (e) { return null; }
    }));
    const top = stats.filter(Boolean).sort((a, b) => b.m - a.m).slice(0, n);
    const notes = (await Promise.all(top.map(async ({ f }) => {
      try {
        const raw = await fs.promises.readFile(path.join(NOTES_DIR, f), 'utf8');
        const { meta, body } = parseNote(raw);
        return {
          id: meta.id || f.replace(/\.md$/, ''),
          updated: meta.updated || null,
          title: titleOf(body),
          snippet: snippetOf(body),
          tags: meta.tags || [],
        };
      } catch (e) { return null; }
    }))).filter(Boolean);
    return { notes, total: files.length };
  } catch (e) {
    logger.error('note', 'recent failed', { error: e.message });
    return { notes: [], total: 0 };
  }
}

// Paste-image support: saves to ~/Documents/Tenote Notes/images/ and returns
// the relative path for a markdown reference (e.g. ![image](images/img-x.png)).
const OWN_IMAGE_RE = /^img-[a-z0-9]+-[a-z0-9]{4}\.(png|jpe?g|gif|webp)$/i;

// Deletes Tenote-created images no note references anymore. Only files matching
// our own naming pattern are candidates — anything the user put in images/
// themselves is left alone. Runs at most once a day from bootstrap.
// Deletes Tenote-created images no note references anymore. Only files matching
// our own naming pattern are candidates — anything the user put in images/
// themselves is left alone. Runs at most once a day from bootstrap. Files younger
// than a week are never touched: in a synced notes folder (iCloud/Dropbox) the
// note that references an image may simply not have arrived on this machine yet.
const SWEEP_MIN_AGE_MS = 7 * 24 * 60 * 60 * 1000;

async function sweepOrphanImages() {
  const imgDir = path.join(NOTES_DIR, 'images');
  if (!fs.existsSync(imgDir)) return;
  const refs = new Set();
  const noteFiles = (await fs.promises.readdir(NOTES_DIR)).filter((f) => f.endsWith('.md'));
  await Promise.all(noteFiles.map(async (f) => {
    try {
      const raw = await fs.promises.readFile(path.join(NOTES_DIR, f), 'utf8');
      for (const m of raw.matchAll(/!\[[^\]]*\]\((images\/[^)\s]+)\)/g)) refs.add(m[1]);
    } catch (e) { /* ignore unreadable notes */ }
  }));
  let removed = 0;
  for (const f of await fs.promises.readdir(imgDir)) {
    if (!OWN_IMAGE_RE.test(f)) continue;
    if (refs.has('images/' + f)) continue;
    try {
      const p = path.join(imgDir, f);
      if (Date.now() - (await fs.promises.stat(p)).mtimeMs < SWEEP_MIN_AGE_MS) continue;
      await fs.promises.unlink(p);
      removed++;
    } catch (e) { /* ignore */ }
  }
  if (removed) logger.info('note', `swept ${removed} orphaned image(s)`);
}

function maybeSweepImages() {
  const DAY_MS = 24 * 60 * 60 * 1000;
  if (Date.now() - (settings.lastImageSweep || 0) < DAY_MS) return;
  settings.lastImageSweep = Date.now();
  saveSettings();
  sweepOrphanImages()
    .catch((e) => logger.warn('note', 'image sweep failed', { error: e.message }));
}

function attachImage(payload) {
  const p = payload || {};
  const mime = String(p.mime || '').toLowerCase();
  const extMap = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
  const ext = extMap[mime];
  if (!ext) return { ok: false, error: 'unsupported image type: ' + mime };
  const b64 = String(p.base64 || '');
  if (!b64) return { ok: false, error: 'no image data' };
  let buf;
  try { buf = Buffer.from(b64, 'base64'); } catch (e) { return { ok: false, error: 'bad image data' }; }
  if (!buf.length || buf.length > 15 * 1024 * 1024) return { ok: false, error: 'image too large (max 15MB)' };
  const imgDir = path.join(NOTES_DIR, 'images');
  try {
    fs.mkdirSync(imgDir, { recursive: true });
    const name = 'img-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6) + '.' + ext;
    fs.writeFileSync(path.join(imgDir, name), buf);
    logger.info('note', 'image attached', { name, bytes: buf.length, mime });
    return { ok: true, path: path.join('images', name) };
  } catch (e) {
    logger.error('note', 'attach failed', { error: e.message });
    return { ok: false, error: String(e && e.message || e) };
  }
}

// Serve images/ files to the renderer via timg://file/<base64url relative path>.
function setupImageProtocol() {
  try {
    protocol.handle('timg', async (request) => {
      try {
        const u = new URL(request.url);
        // URL is timg://file/<base64url relative path> — the payload is in the
        // pathname only (hostname is just a fixed token, e.g. "file").
        const b64 = u.pathname.replace(/^\//, '');
        const rel = Buffer.from(b64.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
        if (!rel.startsWith('images/')) return new Response('forbidden', { status: 403 });
        const abs = path.resolve(NOTES_DIR, rel);
        if (!abs.startsWith(NOTES_DIR + path.sep)) return new Response('forbidden', { status: 403 });
        if (!fs.existsSync(abs)) return new Response('not found', { status: 404 });
        const mime = {
          '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
          '.gif': 'image/gif', '.webp': 'image/webp',
        }[path.extname(abs).toLowerCase()] || 'application/octet-stream';
        const body = fs.readFileSync(abs);
        return new Response(body, { headers: { 'Content-Type': mime } });
      } catch (e) {
        logger.warn('protocol', 'timg failed', { error: e.message });
        return new Response('error', { status: 500 });
      }
    });
    logger.info('protocol', 'timg ready');
  } catch (e) {
    logger.error('protocol', 'setup failed', { error: e.message });
  }
}

// Serve plugin renderer/theme assets to the renderer via tnplug://p/<name>/<file>.
// Only files the host discovered are served; anything else 403s.
function setupPluginProtocol() {
  try {
    protocol.handle('tnplug', (request) => {
      try {
        const u = new URL(request.url);
        const parts = decodeURIComponent(u.pathname.replace(/^\//, '')).split('/').filter(Boolean);
        if (u.hostname !== 'p' || parts.length !== 2) return new Response('forbidden', { status: 403 });
        const [name, file] = parts;
        const entry = host.fileAllowlist().get(name);
        if (!entry || !entry.files.has(file)) return new Response('forbidden', { status: 403 });
        if (/[/\\]|\.\./.test(file)) return new Response('forbidden', { status: 403 });
        const abs = path.join(entry.dir, file);
        if (!abs.startsWith(entry.dir + path.sep)) return new Response('forbidden', { status: 403 });
        const mime = { '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' }[path.extname(file)] || null;
        if (!mime) return new Response('forbidden', { status: 403 });
        return new Response(fs.readFileSync(abs), { headers: { 'Content-Type': mime } });
      } catch (e) {
        logger.warn('protocol', 'tnplug failed', { error: e.message });
        return new Response('error', { status: 500 });
      }
    });
    logger.info('protocol', 'tnplug ready');
  } catch (e) {
    logger.error('protocol', 'setup failed', { error: e.message });
  }
}

function titleOf(body) {
  for (const line of body.split(/\r?\n/)) {
    const t = line.trim().replace(/^#+\s*/, '');
    if (t) return t.length > 70 ? t.slice(0, 70) + '…' : t;
  }
  return 'Untitled';
}

function snippetOf(body) {
  const lines = body.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const s = (lines.slice(1).join(' ') || lines[0] || '');
  return s.length > 140 ? s.slice(0, 140) + '…' : s;
}

// ---- misc ------------------------------------------------------------------
function ensureTrayIcon() {
  if (fs.existsSync(TRAY_ICON)) return;
  require('./scripts/gen-icons')(path.join(__dirname, 'assets'));
}

function localJsonRequires(src, pluginDir) {
  const map = {};
  const re = /require\(\s*['"]\.\/([^'"]+\.json)['"]\s*\)/g;
  let m;
  while ((m = re.exec(src))) {
    const rel = m[1];
    if (!rel || /[/\\]|\.\./.test(rel)) continue;
    const abs = path.join(pluginDir, rel);
    if (!abs.startsWith(pluginDir + path.sep)) continue;
    try { map[rel] = JSON.parse(fs.readFileSync(abs, 'utf8')); }
    catch (e) { logger.warn('plugins', `json require failed: ${rel}`, { error: e.message }); }
  }
  return map;
}

function injectRendererEntry(entry) {
  return (async () => {
    try {
      const src = fs.readFileSync(entry.path, 'utf8');
      const jsonMap = localJsonRequires(src, path.dirname(entry.path));
      const requireShim = `var require=function(p){p=String(p).replace(/^\\.\\//,'');`
        + `var m=${JSON.stringify(jsonMap)};`
        + `if(!Object.prototype.hasOwnProperty.call(m,p))throw new Error('cannot require '+p);return m[p];};`;
      const wrapped = `(function(){var module={exports:{}};var exports=module.exports;${requireShim}(function(){\n${src}\n})();`
        + `var e=module.exports;if(typeof e!=="function"&&e&&typeof e.activate==="function")e=e.activate;`
        + `if(typeof e!=="function")throw new Error("renderer export must be a function");`
        + `window.__tenoteReady(${JSON.stringify(entry.id)},e);})()`;
      await win.webContents.executeJavaScript(wrapped, true);
      logger.info('plugins', `renderer part activated: ${entry.id}`);
    } catch (e) {
      logger.error('plugins', `renderer injection failed: ${entry.id}`, { error: e && e.message || e });
    }
  })();
}

function injectRendererPlugins() {
  const entries = host.rendererEntries();
  if (!entries.length) return;
  for (const entry of entries) injectRendererEntry(entry);
}

function quitApp() { isQuitting = true; app.quit(); }

// ---- app events ------------------------------------------------------------
app.on('before-quit', () => { isQuitting = true; logger.info('app', 'before-quit'); });
app.on('will-quit', () => {
  logger.info('app', 'will-quit');
  try { host.shutdown(); } catch (e) { logger.error('plugins', 'shutdown hook failed', { error: e.message }); }
  try { globalShortcut.unregisterAll(); } catch (e) { /* ignore */ }
  try { if (fs.existsSync(SOCKET_PATH)) fs.unlinkSync(SOCKET_PATH); } catch (e) { /* ignore */ }
  logger.flush();
});
app.on('window-all-closed', () => { if (!isMac) app.quit(); });
app.on('activate', () => showWindow());

process.on('uncaughtException', (err) => {
  logger.error('app', 'uncaughtException', { error: err && err.stack || String(err) });
});
process.on('unhandledRejection', (reason) => {
  logger.error('app', 'unhandledRejection', { error: String(reason && reason.stack || reason) });
});
