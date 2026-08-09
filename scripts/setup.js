#!/usr/bin/env node
'use strict';

// Tenote setup — makes ⌥. (Option+Period) open and close Tenote from anywhere.
//
// What it does, in plain English:
//   1. Checks for skhd, a tiny free hotkey helper for macOS — installs it with
//      Homebrew if it's missing.
//   2. Adds one line to ~/.skhdrc telling skhd to toggle Tenote on ⌥.
//   3. Starts skhd and reminds you about the one macOS permission it needs.
//
// Safe to run more than once: it will not duplicate the keybinding.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SKHDRC = path.join(os.homedir(), '.skhdrc');
const APP_DIR = path.join(__dirname, '..');
const TENOTECTL = path.join(__dirname, 'tenotectl.js');
// TENOTE_DEV_DIR makes the binding start the app too, so ⌥. works even when
// Tenote isn't running yet. Quote paths so spaces don't break the skhd line.
const q = (p) => (/\s/.test(p) ? `"${p}"` : p);
const BINDING = `period - alt : TENOTE_DEV_DIR=${q(APP_DIR)} ${q(TENOTECTL)} toggle`;

function say(msg) { console.log(msg); }
function step(n, msg) { console.log(`\n${n}. ${msg}`); }
function ok(msg) { console.log(`   ✓ ${msg}`); }
function warn(msg) { console.log(`   ! ${msg}`); }

function has(cmd) {
  return spawnSync('which', [cmd], { stdio: 'ignore' }).status === 0;
}

function run(cmd, args) {
  return spawnSync(cmd, args, { stdio: 'inherit' }).status === 0;
}

function main() {
  say('Tenote setup — global hotkey (⌥.)');

  if (process.platform !== 'darwin') {
    say('Tenote is macOS-only, so there is nothing to set up here.');
    return;
  }

  step(1, 'Checking for skhd (the hotkey helper)...');
  if (has('skhd')) {
    ok('skhd is already installed');
  } else if (!has('brew')) {
    warn('skhd is not installed, and Homebrew is missing too — cannot install it automatically.');
    say('');
    say('   Two options:');
    say('   • Install Homebrew from https://brew.sh (one terminal command), then run: npm run setup');
    say('   • Or skip this step — Tenote\'s built-in ⌥. shortcut works without skhd. Just: npm start');
    process.exit(1);
  } else {
    say('   Installing skhd with Homebrew...');
    if (!run('brew', ['install', 'skhd']) && !run('brew', ['install', 'koekeishiya/formulae/skhd'])) {
      warn('could not install skhd — see the brew output above');
      process.exit(1);
    }
    if (!has('skhd')) { warn('skhd still not on PATH after install'); process.exit(1); }
    ok('skhd installed');
  }

  step(2, 'Writing the keybinding to ~/.skhdrc ...');
  try { fs.chmodSync(TENOTECTL, 0o755); } catch (e) { /* ignore */ }
  let rc = '';
  try { rc = fs.readFileSync(SKHDRC, 'utf8'); } catch (e) { /* no config file yet */ }
  if (rc.includes('tenotectl')) {
    ok('keybinding already present — leaving it alone');
  } else {
    // Drop any stale binding from the pre-release name (jotctl), then append ours.
    const kept = rc.split('\n').filter((l) => !l.includes('jotctl')).join('\n').replace(/\s*$/, '');
    const block = (kept ? kept + '\n' : '') + '\n# Tenote: Option+Period toggles the note card\n' + BINDING + '\n';
    fs.writeFileSync(SKHDRC, block, 'utf8');
    ok('added: ' + BINDING);
  }

  step(3, 'Starting skhd...');
  if (run('skhd', ['--start-service']) || run('brew', ['services', 'start', 'skhd'])) {
    ok('skhd is running');
  } else {
    warn('could not start skhd automatically — try running: skhd --start-service');
  }

  say('');
  say('Almost done — one macOS permission to approve (skhd needs it to see your keys):');
  say('');
  say('   1. Open  System Settings → Privacy & Security → Accessibility');
  say('   2. Turn ON the switch for "skhd"');
  say('      (not listed? click + and add it: /opt/homebrew/bin/skhd on Apple Silicon,');
  say('       /usr/local/bin/skhd on Intel — or approve the prompt macOS just showed you)');
  say('');
  say('Then start Tenote (npm start) and press ⌥. anywhere — a note card appears.');
  say('');
  say('To remove the keybinding later: delete the Tenote lines from ~/.skhdrc,');
  say('then run: skhd --stop-service');
}

main();
