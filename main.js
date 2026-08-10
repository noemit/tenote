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

const {
  app, BrowserWindow, globalShortcut, Tray, Menu, ipcMain, screen, shell, nativeImage, clipboard, protocol,
} = require('electron');


const logger = require('./logger');

const startedAt = Date.now();

// ---- config ----------------------------------------------------------------
const isMac = process.platform === 'darwin';
const APP_NAME = 'Tenote';
const WINDOW_WIDTH = 480;
const WINDOW_HEIGHT = 340;
const BLUR_HIDE_DELAY = 160;          // ms after losing focus before hiding
const TOGGLE_COALESCE_MS = 250;       // swallow double-fire (skhd + built-in shortcut)

// Built-in global shortcut. Set TENOTE_SHORTCUT=0 to disable (use skhd instead),
// or TENOTE_SHORTCUT='Ctrl+Shift+Space' etc. to override.
const SHORTCUT = process.env.TENOTE_SHORTCUT === '0' ? null : (process.env.TENOTE_SHORTCUT || 'Alt+.');
const FALLBACK_SHORTCUT = 'Alt+Shift+.';

const NOTES_DIR = path.join(app.getPath('documents'), 'Tenote Notes');
const SETTINGS_PATH = path.join(app.getPath('userData'), 'settings.json');
// TENOTE_SOCKET must match scripts/tenotectl.js (and any skhd binding that uses it).
const SOCKET_PATH = process.env.TENOTE_SOCKET
  || path.join(os.tmpdir(), `tenote-${typeof process.getuid === 'function' ? process.getuid() : process.pid}.sock`);
const TRAY_ICON = path.join(__dirname, 'assets', 'trayTemplate.png');

app.setName(APP_NAME);

// Serve pasted images (stored under NOTES_DIR/images) to the renderer.
protocol.registerSchemesAsPrivileged([
  { scheme: 'timg', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
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

function defaultSettings() { return { hideOnBlur: false, launchAtLogin: false, firstRunDone: false, previewOnPaste: true, theme: 'latte' }; }

function loadSettings() {
  let raw = null;
  try { raw = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8')); }
  catch (e) { /* first run — no settings file yet */ }
  return Object.assign(defaultSettings(), raw || {});
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
    shortcut: SHORTCUT, notesDir: NOTES_DIR, socket: SOCKET_PATH, logFile: logger.getLogFile(),
    hideOnBlur: settings.hideOnBlur, launchAtLogin: settings.launchAtLogin,
    startedAt,
  });

  if (isMac) {
    try { app.setActivationPolicy('accessory'); } catch (e) { logger.warn('app', 'setActivationPolicy failed', { error: e.message }); }
  }
  try { ensureTrayIcon(); } catch (e) { logger.warn('icons', 'icon generation failed', { error: e.message }); }

  startSocketServer();
  createWindow();
  setupTray();
  setupIpc();
  setupImageProtocol();
  registerShortcuts();
  if (isMac) applyLoginItem();

  if (!settings.firstRunDone) {
    isFirstSession = true;
    settings.firstRunDone = true;
    saveSettings();
    logger.info('app', 'first run — showing window to greet');
    setTimeout(showWindow, 300);
  }
}

// ---- window ----------------------------------------------------------------
function createWindow() {
  win = new BrowserWindow({
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    fullscreenable: false,
    maximizable: false,
    minimizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: true,
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

  win.webContents.on('did-finish-load', () => logger.debug('window', 'renderer did-finish-load', { ms: Date.now() - startedAt }));
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

  // Links in the markdown preview open in the default browser — never inside
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
          win.hide();
        }
      }, BLUR_HIDE_DELAY);
    }
  });
  win.on('close', (e) => {
    if (!isQuitting) { e.preventDefault(); logger.debug('window', 'close prevented -> hide'); win.hide(); }
  });
  win.on('closed', () => { win = null; });
}

function showWindow() {
  if (!win) return;
  try {
    const cp = screen.getCursorScreenPoint();
    const d = screen.getDisplayNearestPoint(cp);
    const wa = d.workArea;
    const [w, h] = win.getSize();
    win.setPosition(
      Math.round(wa.x + (wa.width - w) / 2),
      Math.round(wa.y + Math.max(24, wa.height * 0.32 - h / 2)),
      false
    );
  } catch (e) { logger.warn('window', 'positioning failed', { error: e.message }); }

  win.show();
  win.moveTop();
  win.focus();
  if (isMac) { try { app.focus({ steal: true }); } catch (e) { /* ignore */ } }
  setTimeout(() => { if (win && win.isVisible() && !win.isFocused()) win.focus(); }, 80);
  try { win.webContents.send('window:shown'); } catch (e) { /* renderer may not be ready yet */ }
}

function toggleWindow() {
  const now = Date.now();
  if (now - lastToggleAt < TOGGLE_COALESCE_MS) {
    logger.debug('window', 'toggle coalesced (skhd + built-in shortcut double fire)');
    return;
  }
  lastToggleAt = now;
  if (!win) return;
  if (win.isVisible()) win.hide();
  else showWindow();
}

// ---- shortcuts -------------------------------------------------------------
function registerShortcuts() {
  if (!SHORTCUT) { logger.info('shortcut', 'built-in shortcut disabled (TENOTE_SHORTCUT=0) — use skhd'); return; }
  try {
    if (globalShortcut.register(SHORTCUT, toggleWindow)) {
      activeShortcut = SHORTCUT;
      logger.info('shortcut', 'registered', { shortcut: SHORTCUT });
    } else {
      logger.warn('shortcut', 'primary registration failed — trying fallback', { shortcut: SHORTCUT });
      if (globalShortcut.register(FALLBACK_SHORTCUT, toggleWindow)) {
        activeShortcut = FALLBACK_SHORTCUT;
        logger.info('shortcut', 'registered fallback', { shortcut: FALLBACK_SHORTCUT });
      } else {
        logger.error('shortcut', 'all built-in shortcuts failed — use the skhd binding instead (scripts/tenotectl.js)');
      }
    }
  } catch (e) { logger.error('shortcut', 'register threw', { error: e.message }); }
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
  switch (cmd) {
    case 'toggle': toggleWindow(); reply('ok\n'); break;
    case 'show': showWindow(); reply('ok\n'); break;
    case 'hide': if (win) win.hide(); reply('ok\n'); break;
    case 'quit': reply('ok\n'); setTimeout(quitApp, 50); break;
    case 'status': reply(JSON.stringify({ running: true, visible: !!(win && win.isVisible()), shortcut: activeShortcut }) + '\n'); break;
    default: reply('unknown command: ' + cmd + '\n');
  }
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
  const menu = Menu.buildFromTemplate([
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
    { type: 'separator' },
    {
      label: 'Hide when focus lost', type: 'checkbox', checked: settings.hideOnBlur,
      click: (item) => { settings.hideOnBlur = item.checked; saveSettings(); logger.info('settings', 'hideOnBlur', { value: settings.hideOnBlur }); },
    },
    {
      label: 'Launch at login', type: 'checkbox', checked: settings.launchAtLogin,
      click: (item) => { settings.launchAtLogin = item.checked; saveSettings(); applyLoginItem(); logger.info('settings', 'launchAtLogin', { value: settings.launchAtLogin }); },
    },
    { type: 'separator' },
    { label: 'Open Logs Folder', click: () => { try { shell.openPath(logger.getLogDir()); } catch (e) { /* ignore */ } } },
    { label: 'Copy Log Path', click: () => { clipboard.writeText(logger.getLogFile()); } },
    { type: 'separator' },
    { label: shortcutHintLabel(), enabled: false },
    { label: 'Quit Tenote', click: () => quitApp() },
  ]);
  tray.setContextMenu(menu);
}

function shortcutLabel() {
  const s = activeShortcut || SHORTCUT;
  if (!s) return 'via skhd';
  return s.split('+').map((p) => ({ Alt: '⌥', Shift: '⇧', CommandOrControl: '⌘', CmdOrCtrl: '⌘', Command: '⌘', Control: '⌃' }[p] || p)).join('');
}

function shortcutHintLabel() {
  const s = activeShortcut || SHORTCUT;
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
  ipcMain.handle('window:hide', () => { if (win) win.hide(); return true; });
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
  ipcMain.handle('settings:setPreviewOnPaste', (e, value) => {
    settings.previewOnPaste = !!value; saveSettings();
    logger.info('settings', 'previewOnPaste (from ui)', { value: settings.previewOnPaste });
    return { ...settings };
  });
  ipcMain.handle('settings:setTheme', (e, value) => {
    const t = String(value || 'latte');
    settings.theme = ['latte', 'pearl', 'espresso', 'midnight', 'pastel'].includes(t) ? t : 'latte';
    saveSettings();
    logger.info('settings', 'theme (from ui)', { value: settings.theme });
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
  ipcMain.handle('note:read', (e, id) => wrapIpc('note:read', id, readNote));
  ipcMain.handle('note:recent', (e, limit) => wrapIpc('note:recent', limit, recentNotes));
  ipcMain.handle('note:attach', (e, payload) => wrapIpc('note:attach', payload, attachImage));
}

function wrapIpc(name, payload, fn) {
  try { return fn(payload); }
  catch (err) {
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
  const text = String(p.text || '');
  const now = new Date();
  let id = safeId(p.id);
  let created = null;

  if (id) {
    const existing = readNoteMeta(id);
    created = existing ? existing.created : null;
  } else {
    // New note: two notes started in the same second must not share a file.
    const base = formatTimestamp(now);
    id = base;
    let n = 2;
    while (fs.existsSync(noteFile(id))) id = `${base}-${n++}`;
  }

  const file = noteFile(id);

  if (!text.trim()) {
    if (fs.existsSync(file)) {
      fs.unlinkSync(file);
      logger.info('note', 'deleted empty note', { id });
    }
    return { ok: true, id, deleted: true };
  }

  fs.mkdirSync(NOTES_DIR, { recursive: true });
  const meta = { id, created: created || now.toISOString(), updated: now.toISOString(), tags: sanitizeTags(p.tags) };
  atomicWriteFileSync(file, serializeNote(meta, text), 'utf8');
  logger.debug('note', 'saved', { id, length: text.length, tags: meta.tags });
  return { ok: true, id, created: meta.created, updated: meta.updated, path: file, deleted: false };
}

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

function listNotes() {
  try {
    if (!fs.existsSync(NOTES_DIR)) return [];
    const notes = fs.readdirSync(NOTES_DIR)
      .filter((f) => f.endsWith('.md'))
      .map((f) => {
        try {
          const raw = fs.readFileSync(path.join(NOTES_DIR, f), 'utf8');
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
      })
      .filter(Boolean)
      .sort((a, b) => String(b.updated || '').localeCompare(String(a.updated || '')));
    logger.debug('note', 'listed', { count: notes.length });
    return notes;
  } catch (e) {
    logger.error('note', 'list failed', { error: e.message });
    return [];
  }
}

function readNote(id) {
  const clean = safeId(id);
  if (!clean) return null;
  try {
    const raw = fs.readFileSync(noteFile(clean), 'utf8');
    const { meta, body } = parseNote(raw);
    return { id: clean, created: meta.created, updated: meta.updated, tags: meta.tags || [], body };
  } catch (e) {
    logger.warn('note', 'read failed', { id: clean, error: e.message });
    return null;
  }
}

// The 3 most recent notes, cheap: sorts by file mtime (no full scan needed).
function recentNotes(limit) {
  const n = Math.max(1, Math.min(parseInt(limit, 10) || 3, 8));
  try {
    if (!fs.existsSync(NOTES_DIR)) return [];
    return fs.readdirSync(NOTES_DIR)
      .filter((f) => f.endsWith('.md'))
      .map((f) => ({ f, m: fs.statSync(path.join(NOTES_DIR, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m)
      .slice(0, n)
      .map(({ f }) => {
        try {
          const raw = fs.readFileSync(path.join(NOTES_DIR, f), 'utf8');
          const { meta, body } = parseNote(raw);
          return {
            id: meta.id || f.replace(/\.md$/, ''),
            updated: meta.updated || null,
            title: titleOf(body),
            snippet: snippetOf(body),
            tags: meta.tags || [],
          };
        } catch (e) { return null; }
      })
      .filter(Boolean);
  } catch (e) {
    logger.error('note', 'recent failed', { error: e.message });
    return [];
  }
}

// Paste-image support: saves to ~/Documents/Tenote Notes/images/ and returns
// the relative path for a markdown reference (e.g. ![image](images/img-x.png)).
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

function quitApp() { isQuitting = true; app.quit(); }

// ---- app events ------------------------------------------------------------
app.on('before-quit', () => { isQuitting = true; logger.info('app', 'before-quit'); });
app.on('will-quit', () => {
  logger.info('app', 'will-quit');
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
