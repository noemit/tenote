extension JSRuntime {
    /// Node-compat shims, evaluated once per context. `N` is the native bridge
    /// installed by JSRuntime, `INFO` a snapshot of process facts.
    static let prelude = #"""
(function (N, INFO) {
  'use strict';
  const g = globalThis;
  g.global = g;

  // ---- encoding ------------------------------------------------------------
  const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const B64IDX = new Int16Array(128).fill(-1);
  for (let i = 0; i < B64.length; i++) B64IDX[B64.charCodeAt(i)] = i;
  B64IDX['-'.charCodeAt(0)] = 62; B64IDX['_'.charCodeAt(0)] = 63;

  function b64encode(u8) {
    let out = '';
    let i = 0;
    const parts = [];
    for (; i + 2 < u8.length; i += 3) {
      const n = (u8[i] << 16) | (u8[i + 1] << 8) | u8[i + 2];
      out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63];
      if (out.length > 65536) { parts.push(out); out = ''; }
    }
    const rest = u8.length - i;
    if (rest === 1) {
      const n = u8[i] << 16;
      out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + '==';
    } else if (rest === 2) {
      const n = (u8[i] << 16) | (u8[i + 1] << 8);
      out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + '=';
    }
    parts.push(out);
    return parts.join('');
  }

  function b64decode(str) {
    const s = String(str);
    const bytes = new Uint8Array(Math.floor(s.length * 3 / 4) + 3);
    let n = 0, bits = 0, len = 0;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      const v = c < 128 ? B64IDX[c] : -1;
      if (v < 0) continue;
      n = (n << 6) | v; bits += 6;
      if (bits >= 8) { bits -= 8; bytes[len++] = (n >> bits) & 255; }
    }
    return bytes.subarray(0, len);
  }

  function utf8Encode(str) {
    const bin = unescape(encodeURIComponent(String(str)));
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return u8;
  }

  function utf8Decode(u8) {
    let bin = '';
    for (let i = 0; i < u8.length; i += 8192) bin += String.fromCharCode.apply(null, u8.subarray(i, i + 8192));
    try { return decodeURIComponent(escape(bin)); } catch (e) { return bin; }
  }

  class Buffer extends Uint8Array {
    static from(v, enc) {
      if (typeof v === 'string') {
        const e = String(enc || 'utf8').toLowerCase();
        if (e === 'base64' || e === 'base64url') return Buffer._wrap(b64decode(v));
        if (e === 'hex') {
          const b = new Buffer(v.length >> 1);
          for (let i = 0; i < b.length; i++) b[i] = parseInt(v.substr(i * 2, 2), 16);
          return b;
        }
        if (e === 'latin1' || e === 'binary' || e === 'ascii') {
          const b = new Buffer(v.length);
          for (let i = 0; i < v.length; i++) b[i] = v.charCodeAt(i) & 255;
          return b;
        }
        return Buffer._wrap(utf8Encode(v));
      }
      if (v instanceof ArrayBuffer) return new Buffer(v, enc || 0);
      if (ArrayBuffer.isView(v) || Array.isArray(v)) { const b = new Buffer(v.length); b.set(v); return b; }
      throw new TypeError('Buffer.from: unsupported value');
    }
    static _wrap(u8) { return new Buffer(u8.buffer, u8.byteOffset, u8.length); }
    static alloc(n, fill) { const b = new Buffer(n); if (fill) b.fill(typeof fill === 'number' ? fill : 0); return b; }
    static allocUnsafe(n) { return new Buffer(n); }
    static isBuffer(b) { return b instanceof Buffer; }
    static byteLength(s, enc) { return typeof s === 'string' ? Buffer.from(s, enc).length : s.byteLength; }
    static concat(list, total) {
      const len = total === undefined ? list.reduce((a, b) => a + b.length, 0) : total;
      const out = new Buffer(len);
      let off = 0;
      for (const b of list) { if (off >= len) break; out.set(b.subarray(0, len - off), off); off += b.length; }
      return out;
    }
    toString(enc, start, end) {
      const s = this.subarray(start || 0, end === undefined ? this.length : end);
      const e = String(enc || 'utf8').toLowerCase();
      if (e === 'base64') return b64encode(s);
      if (e === 'hex') return Array.from(s, (x) => x.toString(16).padStart(2, '0')).join('');
      if (e === 'latin1' || e === 'binary' || e === 'ascii') { let r = ''; for (const x of s) r += String.fromCharCode(x); return r; }
      return utf8Decode(s);
    }
    toJSON() { return { type: 'Buffer', data: Array.from(this) }; }
    equals(o) { if (!o || o.length !== this.length) return false; for (let i = 0; i < this.length; i++) if (this[i] !== o[i]) return false; return true; }
  }
  g.Buffer = Buffer;

  // ---- console / logging -----------------------------------------------------
  function inspect(v) {
    if (typeof v === 'string') return v;
    if (v instanceof Error) return v.stack ? `${v.message}\n${v.stack}` : String(v.message || v);
    try { const s = JSON.stringify(v); return s === undefined ? String(v) : s; } catch (e) { return String(v); }
  }
  function format(...a) { return a.map(inspect).join(' '); }
  const consoleFor = (lvl) => (...a) => N.log(lvl, 'plugin-console', format(...a), null);
  g.console = { log: consoleFor('info'), info: consoleFor('info'), warn: consoleFor('warn'), error: consoleFor('error'), debug: consoleFor('debug'), trace: consoleFor('debug') };

  // ---- timers ----------------------------------------------------------------
  class Timeout {
    constructor(id) { this._id = id; }
    unref() { return this; }
    ref() { return this; }
    hasRef() { return true; }
    refresh() { return this; }
    [Symbol.toPrimitive]() { return this._id; }
  }
  const timerId = (t) => (t instanceof Timeout ? t._id : Number(t) || 0);
  const schedule = (repeat) => (fn, ms, ...args) => {
    if (typeof fn !== 'function') throw new TypeError('callback must be a function');
    return new Timeout(N.setTimer(Number(ms) || 0, repeat, () => fn(...args)));
  };
  g.setTimeout = schedule(false);
  g.setInterval = schedule(true);
  g.setImmediate = (fn, ...args) => g.setTimeout(fn, 0, ...args);
  g.clearTimeout = g.clearInterval = g.clearImmediate = (t) => { const id = timerId(t); if (id) N.clearTimer(id); };
  if (typeof g.queueMicrotask !== 'function') g.queueMicrotask = (fn) => { Promise.resolve().then(fn); };

  // ---- process ---------------------------------------------------------------
  const started = Date.now();
  g.process = {
    env: Object.assign({}, INFO.env),
    platform: 'darwin',
    arch: INFO.arch,
    pid: INFO.pid,
    argv: ['tenote'],
    version: '',
    versions: { tenote: INFO.version },
    cwd: () => INFO.cwd,
    getuid: () => INFO.uid,
    uptime: () => (Date.now() - started) / 1000,
    hrtime: Object.assign((prev) => {
      const ms = Date.now() - started;
      const t = [Math.floor(ms / 1000), (ms % 1000) * 1e6];
      return prev ? [t[0] - prev[0], t[1] - prev[1]] : t;
    }, { bigint: () => BigInt(Date.now()) * 1000000n }),
    nextTick: (fn, ...args) => { Promise.resolve().then(() => fn(...args)); },
    on() { return g.process; },
    once() { return g.process; },
    off() { return g.process; },
    emitWarning: (w) => N.log('warn', 'plugin-console', String(w), null),
    exit() { throw new Error('plugins cannot exit the app'); },
  };

  // ---- path (posix) ------------------------------------------------------------
  const path = {
    sep: '/',
    delimiter: ':',
    isAbsolute: (p) => String(p).startsWith('/'),
    normalize(p) {
      p = String(p);
      if (!p) return '.';
      const abs = p.startsWith('/');
      const trail = p.endsWith('/');
      const out = [];
      for (const s of p.split('/')) {
        if (!s || s === '.') continue;
        if (s === '..') {
          if (out.length && out[out.length - 1] !== '..') out.pop();
          else if (!abs) out.push('..');
        } else out.push(s);
      }
      let r = (abs ? '/' : '') + out.join('/');
      if (!r) r = abs ? '/' : '.';
      if (trail && r !== '/') r += '/';
      return r;
    },
    join(...parts) {
      const f = parts.map((x) => { if (typeof x !== 'string') throw new TypeError('path must be a string'); return x; }).filter(Boolean);
      return f.length ? path.normalize(f.join('/')) : '.';
    },
    resolve(...parts) {
      let r = '';
      for (let i = parts.length - 1; i >= 0 && !r.startsWith('/'); i--) {
        const s = String(parts[i]);
        if (!s) continue;
        r = r ? s + '/' + r : s;
      }
      if (!r.startsWith('/')) r = INFO.cwd + (r ? '/' + r : '');
      r = path.normalize(r);
      if (r.length > 1 && r.endsWith('/')) r = r.slice(0, -1);
      return r;
    },
    dirname(p) {
      p = String(p);
      if (!p) return '.';
      let e = p.length;
      while (e > 1 && p[e - 1] === '/') e--;
      const i = p.lastIndexOf('/', e - 1);
      if (i < 0) return '.';
      if (i === 0) return '/';
      return p.slice(0, i);
    },
    basename(p, ext) {
      p = String(p);
      while (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
      let b = p.slice(p.lastIndexOf('/') + 1);
      if (ext && b.endsWith(ext) && b !== ext) b = b.slice(0, -ext.length);
      return b;
    },
    extname(p) {
      const b = path.basename(p);
      const i = b.lastIndexOf('.');
      return i <= 0 ? '' : b.slice(i);
    },
    relative(from, to) {
      const f = path.resolve(from).split('/').filter(Boolean);
      const t = path.resolve(to).split('/').filter(Boolean);
      let i = 0;
      while (i < f.length && i < t.length && f[i] === t[i]) i++;
      return [...Array(f.length - i).fill('..'), ...t.slice(i)].join('/');
    },
    parse(p) {
      const base = path.basename(p);
      const ext = path.extname(p);
      return { root: String(p).startsWith('/') ? '/' : '', dir: path.dirname(p), base, ext, name: ext ? base.slice(0, -ext.length) : base };
    },
    format(o) { const base = o.base || ((o.name || '') + (o.ext || '')); return o.dir ? path.join(o.dir, base) : base; },
  };
  path.posix = path;

  // ---- fs ----------------------------------------------------------------------
  const str = (p) => {
    if (typeof URL !== 'undefined' && p instanceof URL) return p.pathname;
    if (typeof p !== 'string') throw new TypeError('path must be a string');
    return p;
  };
  function makeStat(s) {
    return {
      size: s.size, mtimeMs: s.mtimeMs, birthtimeMs: s.birthtimeMs, ctimeMs: s.mtimeMs, atimeMs: s.mtimeMs,
      mtime: new Date(s.mtimeMs), birthtime: new Date(s.birthtimeMs), ctime: new Date(s.mtimeMs), atime: new Date(s.mtimeMs),
      isDirectory: () => s.isDir, isFile: () => s.isFile, isSymbolicLink: () => s.isSymlink,
    };
  }
  const encOf = (o) => (typeof o === 'string' ? o : o && o.encoding) || null;
  function writeAny(p, data, append) {
    if (typeof data === 'string') N.fsWrite(str(p), data, false, append);
    else if (ArrayBuffer.isView(data)) N.fsWrite(str(p), b64encode(new Uint8Array(data.buffer, data.byteOffset, data.byteLength)), true, append);
    else if (data instanceof ArrayBuffer) N.fsWrite(str(p), b64encode(new Uint8Array(data)), true, append);
    else N.fsWrite(str(p), String(data), false, append);
  }
  const fs = {
    constants: { F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1 },
    existsSync: (p) => { try { return N.fsExists(str(p)); } catch (e) { return false; } },
    readFileSync(p, o) {
      const enc = encOf(o);
      if (enc === 'base64') return N.fsRead(str(p), true);
      if (enc) return N.fsRead(str(p), false);
      return Buffer.from(N.fsRead(str(p), true), 'base64');
    },
    writeFileSync: (p, data) => writeAny(p, data, false),
    appendFileSync: (p, data) => writeAny(p, data, true),
    mkdirSync: (p, o) => { N.fsMkdir(str(p), !!(o && o.recursive)); },
    readdirSync(p, o) {
      const list = N.fsReaddir(str(p));
      if (o && o.withFileTypes) return list.map((d) => ({ name: d.name, isDirectory: () => d.isDir, isFile: () => d.isFile, isSymbolicLink: () => false }));
      return list.map((d) => d.name);
    },
    statSync: (p) => makeStat(N.fsStat(str(p))),
    lstatSync: (p) => makeStat(N.fsStat(str(p))),
    accessSync: (p) => { if (!N.fsExists(str(p))) { const e = new Error(`ENOENT: no such file or directory, access '${p}'`); e.code = 'ENOENT'; throw e; } },
    unlinkSync: (p) => N.fsUnlink(str(p)),
    rmSync: (p, o) => N.fsRm(str(p), !!(o && o.recursive), !!(o && o.force)),
    rmdirSync: (p, o) => N.fsRm(str(p), !!(o && o.recursive), false),
    renameSync: (a, b) => N.fsRename(str(a), str(b)),
    copyFileSync: (a, b) => N.fsCopy(str(a), str(b), false),
    cpSync: (a, b, o) => N.fsCopy(str(a), str(b), !!(o && o.recursive)),
    mkdtempSync: (prefix) => N.fsMkdtemp(str(prefix)),
    realpathSync: (p) => N.fsRealpath(str(p)),
    chmodSync() {},
  };
  const asyncify = (fn) => (...a) => new Promise((resolve, reject) => {
    try { resolve(fn(...a)); } catch (e) { reject(e); }
  });
  fs.promises = {
    readFile: asyncify(fs.readFileSync), writeFile: asyncify(fs.writeFileSync), appendFile: asyncify(fs.appendFileSync),
    readdir: asyncify(fs.readdirSync), mkdir: asyncify(fs.mkdirSync), stat: asyncify(fs.statSync), lstat: asyncify(fs.lstatSync),
    unlink: asyncify(fs.unlinkSync), rm: asyncify(fs.rmSync), rmdir: asyncify(fs.rmdirSync), rename: asyncify(fs.renameSync),
    copyFile: asyncify(fs.copyFileSync), cp: asyncify(fs.cpSync), mkdtemp: asyncify(fs.mkdtempSync), realpath: asyncify(fs.realpathSync),
    access: asyncify(fs.accessSync), chmod: asyncify(fs.chmodSync),
  };
  const callbackify = (fn) => (...a) => {
    const cb = typeof a[a.length - 1] === 'function' ? a.pop() : null;
    let r, err = null;
    try { r = fn(...a); } catch (e) { err = e; }
    if (cb) g.setTimeout(() => cb(err, r), 0);
  };
  for (const k of ['readFile', 'writeFile', 'appendFile', 'readdir', 'mkdir', 'stat', 'lstat', 'unlink', 'rm', 'rmdir', 'rename', 'copyFile', 'mkdtemp', 'access']) {
    fs[k] = callbackify(fs[k + 'Sync']);
  }
  fs.exists = (p, cb) => g.setTimeout(() => cb(fs.existsSync(p)), 0);

  // ---- os ----------------------------------------------------------------------
  const os = {
    EOL: '\n',
    tmpdir: () => INFO.tmpdir,
    homedir: () => INFO.home,
    platform: () => 'darwin',
    type: () => 'Darwin',
    arch: () => INFO.arch,
    hostname: () => INFO.hostname,
    userInfo: () => ({ username: INFO.user, homedir: INFO.home, uid: INFO.uid }),
  };

  // ---- child_process -----------------------------------------------------------
  function execFile(file, args, opts, cb) {
    if (typeof args === 'function') { cb = args; args = []; opts = {}; }
    else if (typeof opts === 'function') { cb = opts; opts = {}; }
    if (!Array.isArray(args)) { opts = args || opts; args = []; }
    opts = opts || {};
    const o = { cwd: opts.cwd ? String(opts.cwd) : null, timeout: Number(opts.timeout) || 0 };
    if (opts.env) o.env = opts.env;
    N.exec(String(file), args.map(String), o, (err, code, stdout, stderr) => {
      if (typeof cb !== 'function') return;
      let e = null;
      if (err !== null) {
        e = new Error(err);
        e.code = code;
        e.stdout = stdout;
        e.stderr = stderr;
        if (/timed out/.test(err)) { e.killed = true; e.signal = 'SIGTERM'; }
      }
      cb(e, stdout, stderr);
    });
    return { kill() { return false; }, on() { return this; }, once() { return this; } };
  }
  function exec(cmd, opts, cb) {
    if (typeof opts === 'function') { cb = opts; opts = {}; }
    return execFile('/bin/sh', ['-c', String(cmd)], opts, cb);
  }
  const child_process = { execFile, exec };

  // ---- util / events -------------------------------------------------------------
  const util = {
    format,
    inspect,
    promisify: (fn) => (...a) => new Promise((resolve, reject) => fn(...a, (err, ...r) => (err ? reject(err) : resolve(r.length > 1 ? r : r[0])))),
  };
  execFile[Symbol.for('nodejs.util.promisify.custom')] = (file, args, opts) => new Promise((resolve, reject) => {
    execFile(file, args || [], opts || {}, (err, stdout, stderr) => (err ? reject(err) : resolve({ stdout, stderr })));
  });
  const basePromisify = util.promisify;
  util.promisify = (fn) => fn[Symbol.for('nodejs.util.promisify.custom')] || basePromisify(fn);

  class EventEmitter {
    constructor() { this._ev = new Map(); }
    on(e, fn) { if (!this._ev.has(e)) this._ev.set(e, []); this._ev.get(e).push(fn); return this; }
    addListener(e, fn) { return this.on(e, fn); }
    once(e, fn) { const w = (...a) => { this.off(e, w); fn(...a); }; return this.on(e, w); }
    off(e, fn) { const l = this._ev.get(e); if (l) this._ev.set(e, l.filter((x) => x !== fn)); return this; }
    removeListener(e, fn) { return this.off(e, fn); }
    removeAllListeners(e) { if (e === undefined) this._ev.clear(); else this._ev.delete(e); return this; }
    emit(e, ...a) { const l = this._ev.get(e); if (!l || !l.length) return false; for (const fn of [...l]) fn.apply(this, a); return true; }
    listenerCount(e) { return (this._ev.get(e) || []).length; }
  }
  const events = Object.assign(EventEmitter, { EventEmitter });

  // ---- require -------------------------------------------------------------------
  const builtins = { fs, 'fs/promises': fs.promises, path, os, child_process, util, events, buffer: { Buffer } };
  const cache = Object.create(null);

  function resolveFile(base) {
    for (const c of [base, base + '.js', base + '.json', path.join(base, 'index.js')]) {
      try { if (N.fsExists(c) && N.fsStat(c).isFile) return c; } catch (e) { /* keep looking */ }
    }
    return null;
  }

  function notFound(id) {
    const e = new Error(`Cannot find module '${id}' (Tenote plugins can require fs, path, os, child_process, util, events and relative files)`);
    e.code = 'MODULE_NOT_FOUND';
    return e;
  }

  function makeRequire(dir) {
    const req = (id) => {
      id = String(id);
      const bare = id.replace(/^node:/, '');
      if (Object.prototype.hasOwnProperty.call(builtins, bare)) return builtins[bare];
      if (id.startsWith('./') || id.startsWith('../') || id.startsWith('/')) {
        const f = resolveFile(path.resolve(dir, id));
        if (!f) throw notFound(id);
        return load(f, false);
      }
      throw notFound(id);
    };
    req.resolve = (id) => {
      const f = resolveFile(path.resolve(dir, String(id)));
      if (!f) throw notFound(id);
      return f;
    };
    req.cache = cache;
    return req;
  }

  function load(file, fresh) {
    if (fresh) delete cache[file];
    if (cache[file]) return cache[file].exports;
    const module = { exports: {}, filename: file, id: file, loaded: false, children: [] };
    cache[file] = module;
    try {
      const src = N.fsRead(file, false);
      if (file.endsWith('.json')) {
        module.exports = JSON.parse(src);
      } else {
        const body = src.startsWith('#!') ? '//' + src : src;
        const fn = N.evalModule('(function (exports, require, module, __filename, __dirname) {' + body + '\n})', file);
        const dir = path.dirname(file);
        fn.call(module.exports, module.exports, makeRequire(dir), module, file, dir);
      }
      module.loaded = true;
    } catch (e) {
      delete cache[file];
      throw e;
    }
    return module.exports;
  }

  g.require = makeRequire(INFO.cwd);
  g.__tenoteLoad = (file) => load(String(file), true);

  // ---- plugin API ----------------------------------------------------------------
  const safeJSON = (d) => { try { const s = JSON.stringify(d); return s === undefined ? String(d) : s; } catch (e) { return '[unserializable]'; } };

  g.__tenoteMakeApi = function (H, name, version, notesDir) {
    const prefix = `[${name}]`;
    const mk = (lvl) => (msg, data) => N.log(lvl, prefix, msg === undefined ? '' : inspect(msg), data === undefined ? null : safeJSON(data));
    const log = { debug: mk('debug'), info: mk('info'), warn: mk('warn'), error: mk('error') };
    const isFn = (f) => typeof f === 'function';
    return {
      name,
      version,
      log,
      dataDir: () => H.dataDir(name),
      on(event, fn) {
        if (!isFn(fn) || !H.on(name, String(event || ''), fn)) log.warn('rejected on()', event);
      },
      emit(event, payload) {
        if (!H.emit(name, String(event || ''), payload === undefined ? {} : payload)) log.warn('rejected emit', event);
      },
      registerCommand(cmd, fn) {
        if (!isFn(fn)) { log.warn('rejected command', cmd); return; }
        H.registerCommand(name, typeof cmd === 'string' ? cmd : '', fn);
      },
      registerService(methods) {
        if (!methods || typeof methods !== 'object') { log.warn('rejected service'); return; }
        H.registerService(name, methods);
      },
      registerTrayItem(item) {
        if (!item || typeof item.label !== 'string' || !isFn(item.click)) { log.warn('rejected tray item'); return; }
        H.registerTrayItem(name, item.label, item.type === 'checkbox' ? 'checkbox' : 'normal', !!item.checked, item.click);
      },
      registerGlobalShortcut(accelerator, fn) {
        if (typeof accelerator !== 'string' || !isFn(fn)) { log.warn('rejected shortcut'); return false; }
        const ok = H.registerGlobalShortcut(name, accelerator, fn);
        if (!ok) log.warn('shortcut registration failed', accelerator);
        return ok;
      },
      settings: {
        get(key, fallback) {
          const r = H.settingsGet(name, String(key));
          return r && r.has ? r.value : fallback;
        },
        set(key, value) { H.settingsSet(name, String(key), value === undefined ? null : value); },
      },
      notesDir,
      notes: {
        list: () => H.notesList(),
        read: (id) => H.notesRead(id === undefined ? null : id),
        save: (payload) => H.notesSave(payload || {}),
        recent: (limit) => H.notesRecent(limit === undefined ? null : limit),
      },
      window: { toggle: () => H.windowToggle(), show: () => H.windowShow(), hide: () => H.windowHide() },
      app: { quit: () => H.appQuit() },
      system: { status: () => H.systemStatus() },
    };
  };
})
"""#
}
