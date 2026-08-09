#!/usr/bin/env node
'use strict';

// Pre-flight check before `npm start`.
//
// Electron 43+ has NO postinstall script — the ~100MB binary is downloaded
// lazily the first time the app runs (see node_modules/electron/index.js).
// This script makes that explicit, verifies the binary actually runs on THIS
// machine, and self-heals the two common breakages:
//   1. binary missing           -> runs electron's own installer (install.js)
//   2. binary broken/wrong-arch (ENOEXEC or exec failure, e.g. node_modules
//      copied from another OS)  -> wipes dist/ and re-downloads for this machine

const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const electronDir = path.join(__dirname, '..', 'node_modules', 'electron');
const installJs = path.join(electronDir, 'install.js');

// The executable lives at dist/<path.txt> — same logic as electron's index.js.
// path.txt is platform-specific: "Electron.app/Contents/MacOS/Electron" on
// macOS, "electron.exe" on Windows, "electron" elsewhere.
function resolveRel() {
  try {
    const rel = fs.readFileSync(path.join(electronDir, 'path.txt'), 'utf8').trim();
    if (rel) return rel;
  } catch (e) { /* ignore */ }
  if (process.platform === 'darwin') return 'Electron.app/Contents/MacOS/Electron';
  if (process.platform === 'win32') return 'electron.exe';
  return 'electron';
}

function binPath() { return path.join(electronDir, 'dist', resolveRel()); }

function say(msg) { console.log(msg); }

function runInstaller() {
  if (!fs.existsSync(installJs)) {
    return { ok: false, reason: 'electron package is missing install.js — run: rm -rf node_modules && npm install' };
  }
  say('Downloading Electron binary (first run — can take a minute)...');
  const r = spawnSync(process.execPath, [installJs], { stdio: 'inherit', timeout: 300000 });
  if (r.error) return { ok: false, reason: r.error.message };
  if (r.status === null) return { ok: false, reason: 'installer timed out after 5 minutes' };
  if (r.status !== 0) return { ok: false, reason: 'installer exited with status ' + r.status };
  return { ok: true };
}

function checkBinary() {
  const r = spawnSync(binPath(), ['--version'], { timeout: 15000, encoding: 'utf8' });
  if (r.error) return { ok: false, error: r.error, status: r.status };
  if (r.status !== 0) {
    return {
      ok: false,
      error: new Error('exit ' + r.status + ': ' + String(r.stderr || '').trim()),
      status: r.status,
    };
  }
  return { ok: true, version: String(r.stdout || '').trim(), status: 0 };
}

function isBrokenBinary(result) {
  // ENOEXEC = exec format error (wrong OS/arch, e.g. node_modules copied from
  // another machine). EACCES = binary file exists but isn't executable.
  // statuses 2/126/127 = shell tried to run it as a script and failed.
  return !!result.error && (
    result.error.code === 'ENOEXEC' ||
    result.error.code === 'EACCES' ||
    [2, 126, 127].includes(result.status)
  );
}

function isRootSandboxQuirk(result) {
  return !!result.error && String(result.error.message).includes('--no-sandbox');
}

function fail(reason) {
  console.error('✗ Electron binary is not usable on this machine.');
  console.error('  ' + reason);
  console.error('  If the download failed you may be behind a firewall/proxy — set ELECTRON_MIRROR,');
  console.error('  or run the installer manually:  node node_modules/electron/install.js');
  process.exit(1);
}

// 1. Check the binary that's there (if any), using the path from path.txt.
let result = fs.existsSync(binPath()) ? checkBinary() : { ok: false, error: null, status: null };

// 2. Broken binary? Wipe and reinstall for this machine.
if (!result.ok && isBrokenBinary(result)) {
  say('Existing Electron binary is broken or for a different OS/architecture (copied node_modules?) — re-downloading for this machine...');
  try { fs.rmSync(path.join(electronDir, 'dist'), { recursive: true, force: true }); } catch (e) { /* ignore */ }
  result = { ok: false, error: null, status: null };
}

// 3. Missing? Download. (Also fixes a stale path.txt from another platform.)
if (!result.ok && !isRootSandboxQuirk(result)) {
  const r = runInstaller();
  if (!r.ok) fail(r.reason);
  result = checkBinary();
}

// 4. Final verdict.
if (!result.ok) {
  if (isRootSandboxQuirk(result)) {
    console.error('✗ Electron downloaded, but cannot run here: this machine runs as root without --no-sandbox support (a container/CI quirk).');
    console.error('  Run as a normal user, or launch directly with:  node_modules/.bin/electron . --no-sandbox');
    process.exit(1);
  }
  fail(result.error ? result.error.message : 'binary still missing after install');
}

say('✓ Electron ' + result.version + ' ready');
