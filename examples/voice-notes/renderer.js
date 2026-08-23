'use strict';

const jot = () => window.tenote;

module.exports = function voiceNotesRenderer(tenote) {
  let cmd = tenote.settings.get('transcribeCmd', '');
  let recording = false;
  let busy = false;
  let ctx = null;
  let stream = null;
  let node = null;
  let chunks = [];

  const chip = tenote.ui.chips.add({
    label: chipLabel(),
    variant: 'default',
    onHover() { return hoverText(); },
    onClick() { toggle(); },
  });
  render();

  tenote.ui.settings.declare([
    {
      key: 'transcribeCmd', type: 'text', label: 'Transcribe command (use {wav})',
      default: '',
      onChange(v) { cmd = String(v || '').trim(); render(); },
    },
  ]);

  function chipLabel() {
    if (!cmd) return '🎙 setup';
    if (recording) return '● rec';
    if (busy) return '⏳ …';
    return '🎙';
  }

  function hoverText() {
    if (!cmd) {
      return 'Not configured. In ⚙ → Plugins → voice-notes, set a command that reads a wav file and prints text, e.g.\nparakeet-run {wav}';
    }
    if (recording) return 'Recording — click to stop and transcribe';
    if (busy) return 'Transcribing…';
    return `Ready (${Math.round(limitSec())}s max) — click to record`;
  }

  function limitSec() { return 120; }

  function render() {
    chip.update(chipLabel(), recording ? 'accent' : 'default');
    void hoverText;
  }

  async function toggle() {
    if (busy) return;
    if (recording) await stopAndTranscribe();
    else startRecording();
  }

  async function startRecording() {
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      tenote.ui.toast('Microphone access denied');
      return;
    }
    ctx = new AudioContext();
    const source = ctx.createMediaStreamSource(stream);
    node = ctx.createScriptProcessor(4096, 1, 1);
    chunks = [];
    node.onaudioprocess = (e) => {
      if (!recording) return;
      chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
      if ((chunks.length * 4096) / ctx.sampleRate > limitSec()) stopAndTranscribe();
    };
    source.connect(node);
    const sink = ctx.createGain();
    sink.gain.value = 0;
    node.connect(sink);
    sink.connect(ctx.destination);
    recording = true;
    render();
  }

  async function stopAndTranscribe() {
    recording = false;
    busy = true;
    try { if (node) node.disconnect(); } catch (e) { /* ignore */ }
    try { if (stream) stream.getTracks().forEach((t) => t.stop()); } catch (e) { /* ignore */ }
    render();
    try {
      const rate = ctx ? ctx.sampleRate : 48000;
      const wavB64 = b64(encodeWav(mergeChunks(chunks, rate), rate));
      const res = await jot().invokePlugin('voice-notes', 'transcribe', { cmd, wavBase64: wavB64 });
      if (res && res.ok && res.result && res.result.ok) {
        const text = res.result.text;
        if (text) tenote.composer.insertText(text + ' ');
        else tenote.ui.toast('Heard nothing');
      } else {
        tenote.ui.toast((res && res.result && res.result.error) || 'Transcription failed', 4000);
      }
    } catch (e) {
      tenote.log.warn(e.message);
      tenote.ui.toast('Transcription failed', 3000);
    } finally {
      busy = false;
      try { if (ctx) ctx.close(); } catch (e) { /* ignore */ }
      ctx = null; node = null; stream = null; chunks = [];
      render();
    }
  }

  function mergeChunks(list, rate) {
    const total = list.reduce((s, c) => s + c.length, 0);
    const out = new Float32Array(total);
    let off = 0;
    for (const c of list) { out.set(c, off); off += c.length; }
    return downsample(out, rate, 16000);
  }

  function downsample(buf, from, to) {
    if (from <= to) return buf;
    const ratio = Math.floor(from / to);
    if (ratio < 2) return buf;
    const out = new Float32Array(Math.floor(buf.length / ratio));
    for (let i = 0; i < out.length; i++) out[i] = buf[i * ratio];
    return out;
  }

  function encodeWav(samples, sampleRate) {
    const buffer = new ArrayBuffer(44 + samples.length * 2);
    const view = new DataView(buffer);
    writeStr(view, 0, 'RIFF');
    view.setUint32(4, 36 + samples.length * 2, true);
    writeStr(view, 8, 'WAVE');
    writeStr(view, 12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeStr(view, 36, 'data');
    view.setUint32(40, samples.length * 2, true);
    for (let i = 0; i < samples.length; i++) {
      const s = Math.max(-1, Math.min(1, samples[i]));
      view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
    return buffer;
  }

  function writeStr(view, offset, str) {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  }

  function b64(buffer) {
    const bytes = new Uint8Array(buffer);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return bin;
  }
};
