#!/usr/bin/env node
'use strict';

// tenotectl — control the Tenote app from the command line / skhd.
//
// skhd config (~/.skhdrc):
//   period - alt : /Users/you/tenote/scripts/tenotectl.js toggle
//   # dev-mode auto-launch (starts the app if it isn't running):
//   period - alt : TENOTE_DEV_DIR=/Users/you/tenote /Users/you/tenote/scripts/tenotectl.js toggle
//
// Commands: toggle | show | hide | quit | status
// If the app isn't running, tenotectl launches it and retries:
//   - packaged app: `open -a "Tenote"`
//   - dev mode: set TENOTE_DEV_DIR and it runs `npm start` there
// Override the socket with TENOTE_SOCKET, or a packaged app path with TENOTE_APP_PATH.

const net = require('net');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { execFile, spawn } = require('child_process');

const uid = typeof process.getuid === 'function' ? process.getuid() : process.pid;
const SOCKET = process.env.TENOTE_SOCKET || path.join(os.tmpdir(), `tenote-${uid}.sock`);
const cmd = process.argv[2] || 'toggle';
const RETRY_MS = 700;
const MAX_RETRIES = 8;

const DEV_DIR = process.env.TENOTE_DEV_DIR;
const LOG_DIR = process.env.TENOTE_LOG_DIR || (process.platform === 'darwin'
  ? path.join(os.homedir(), 'Library', 'Logs', 'Tenote')
  : path.join(os.homedir(), '.config', 'Tenote', 'logs'));

function send(command) {
  return new Promise((resolve) => {
    const sock = net.connect(SOCKET, () => sock.write(command + '\n'));
    let done = false;
    const finish = (err) => {
      if (done) return;
      done = true;
      try { sock.destroy(); } catch (e) { /* ignore */ }
      resolve(err);
    };
    sock.on('data', (d) => process.stdout.write(d));
    sock.on('close', () => finish(null));
    sock.on('error', (e) => finish(e));
    sock.setTimeout(1200, () => finish(new Error('timeout')));
  });
}

function launchApp() {
  return new Promise((resolve) => {
    if (DEV_DIR) {
      // Dev mode: boot the app with `npm start` (detached so it keeps running).
      const npmName = process.platform === 'win32' ? 'npm.cmd' : 'npm';
      const npmPath = path.join(path.dirname(process.execPath), npmName);
      const npmBin = fs.existsSync(npmPath) ? npmPath : 'npm';
      let out = null;
      try {
        fs.mkdirSync(LOG_DIR, { recursive: true });
        out = fs.openSync(path.join(LOG_DIR, 'dev-launch.log'), 'a');
      } catch (e) { /* ignore */ }
      console.log('TENOTE_DEV_DIR set — running npm start (see ~/Library/Logs/Tenote/dev-launch.log)');
      const child = spawn(npmBin, ['start'], { cwd: DEV_DIR, detached: true, stdio: out ? ['ignore', out, out] : 'ignore' });
      child.unref();
      child.on('error', (e) => {
        try { if (out) fs.closeSync(out); } catch (e2) { /* ignore */ }
        resolve(new Error('could not run npm start: ' + e.message));
      });
      resolve(null);
      return;
    }

    const appPath = process.env.TENOTE_APP_PATH;
    // execFile with an argv array — no shell string to break out of.
    execFile('open', appPath ? [appPath] : ['-a', 'Tenote'], (err) => {
      if (err) resolve(new Error('could not launch the app — start it manually (npm start, or open Tenote.app)'));
      else resolve(null);
    });
  });
}

(async () => {
  if (cmd === 'status') {
    const e = await send('status');
    if (e) { console.log('Tenote not running'); process.exit(1); }
    process.exit(0);
  }

  let err = await send(cmd);
  if (!err) process.exit(0);

  // Not running — launch it, then retry the command once the socket is up.
  const launchErr = await launchApp();
  if (launchErr) { console.error(launchErr.message); process.exit(1); }

  let tries = 0;
  while (tries < MAX_RETRIES) {
    await new Promise((r) => setTimeout(r, RETRY_MS));
    err = await send(cmd);
    if (!err) process.exit(0);
    tries++;
  }
  console.error('Tenote started but never came up on the socket — see ~/Library/Logs/Tenote/main.log');
  process.exit(1);
})();
