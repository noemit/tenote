'use strict';

// Tiny structured file logger used by the main process.
// Log file: ~/Library/Logs/Tenote/main.log on macOS (override with TENOTE_LOG_DIR).
// Level: TENOTE_LOG_LEVEL=debug|info|warn|error (default info).

const fs = require('fs');
const path = require('path');
const os = require('os');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const MAX_SIZE = 5 * 1024 * 1024; // rotate when main.log exceeds this

let LOG_DIR = process.env.TENOTE_LOG_DIR || (process.platform === 'darwin'
  ? path.join(os.homedir(), 'Library', 'Logs', 'Tenote')
  : path.join(os.homedir(), '.config', 'Tenote', 'logs'));
let LOG_FILE = path.join(LOG_DIR, 'main.log');
let minLevel = LEVELS[process.env.TENOTE_LOG_LEVEL || 'info'] || LEVELS.info;
let stream = null;

function init(dir) {
  if (dir) { LOG_DIR = dir; LOG_FILE = path.join(LOG_DIR, 'main.log'); }
  try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch (e) { /* ignore */ }
  rotateIfNeeded();
}

function rotateIfNeeded() {
  try {
    const st = fs.statSync(LOG_FILE);
    if (st.size > MAX_SIZE) fs.renameSync(LOG_FILE, LOG_FILE + '.1');
  } catch (e) { /* no file yet */ }
}

function ensureStream() {
  if (!stream) {
    init();
    stream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
    stream.on('error', () => { stream = null; });
  }
}

function log(level, tag, msg, data) {
  if ((LEVELS[level] || 0) < minLevel) return;
  let extra = '';
  if (data !== undefined) {
    try { extra = ' ' + JSON.stringify(data); } catch (e) { extra = ' [unserializable]'; }
  }
  const line = `${new Date().toISOString()} [${String(level).toUpperCase()}] [${tag}] ${msg}${extra}`;
  try { ensureStream(); stream.write(line + '\n'); } catch (e) { /* last resort */ }
  if (level === 'error') console.error(`[${tag}] ${msg}`, data !== undefined ? data : '');
  else if (level === 'warn') console.warn(`[${tag}] ${msg}`, data !== undefined ? data : '');
}

function flush(cb) {
  if (stream) stream.end(cb);
  else if (cb) cb();
}

module.exports = {
  init,
  log,
  flush,
  debug: (t, m, d) => log('debug', t, m, d),
  info: (t, m, d) => log('info', t, m, d),
  warn: (t, m, d) => log('warn', t, m, d),
  error: (t, m, d) => log('error', t, m, d),
  setLevel: (l) => { if (LEVELS[l]) minLevel = LEVELS[l]; },
  getLogFile: () => LOG_FILE,
  getLogDir: () => LOG_DIR,
};
