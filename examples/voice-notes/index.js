'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

module.exports = function voiceNotes(tenote) {
  tenote.registerService({
    async transcribe(args) {
      const cmd = String((args && args.cmd) || '').trim();
      if (!cmd || !cmd.includes('{wav}')) return { ok: false, error: 'No transcribe command configured — set it in ⚙ → Plugins → voice-notes' };
      let wav;
      try {
        wav = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tenote-voice-')), 'clip.wav');
        fs.writeFileSync(wav, Buffer.from(String(args.wavBase64 || ''), 'base64'));
      } catch (e) {
        return { ok: false, error: 'could not stage audio: ' + e.message };
      }
      const finalCmd = cmd.replace(/\{wav\}/g, JSON.stringify(wav));
      try {
        const text = await new Promise((resolve, reject) => {
          execFile('/bin/bash', ['-c', finalCmd], { timeout: 180000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
            if (err) reject(new Error(shortErr(err, stderr)));
            else resolve(String(stdout || ''));
          });
        });
        return { ok: true, text: text.trim() };
      } catch (e) {
        tenote.log.warn('transcribe failed', e.message);
        return { ok: false, error: e.message };
      } finally {
        try { fs.rmSync(path.dirname(wav), { recursive: true, force: true }); } catch (e) { /* ignore */ }
      }
    },
  });

  function shortErr(err, stderr) {
    const tail = String(stderr || '').trim().split('\n').filter(Boolean).slice(-2).join(' ');
    if (tail) return tail;
    return (err && err.message) || 'transcription failed';
  }
};
