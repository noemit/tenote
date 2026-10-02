#!/usr/bin/env node
'use strict';

// View Tenote's log file. Usage:
//   npm run logs       → tail -f the log
//   npm run log-path   → print the log file path

const os = require('os');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const isMac = process.platform === 'darwin';
const dir = process.env.TENOTE_LOG_DIR || (isMac
  ? path.join(os.homedir(), 'Library', 'Logs', 'Tenote')
  : path.join(os.homedir(), '.config', 'Tenote', 'logs'));
const file = path.join(dir, 'main.log');

if (process.argv[2] === 'path') {
  console.log(file);
  process.exit(0);
}

if (!fs.existsSync(file)) {
  console.log('No log file yet at: ' + file);
  console.log('Start the app first: npm start');
  process.exit(1);
}

console.log('Tailing ' + file + ' (Ctrl-C to stop)\n');
const tail = spawn('tail', ['-n', '300', '-f', file], { stdio: 'inherit' });
tail.on('error', (e) => { console.error('tail failed:', e.message); process.exit(1); });
