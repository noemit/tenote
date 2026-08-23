'use strict';

const jot = () => window.tenote;

module.exports = function exportImage(tenote) {
  tenote.ui.keys.add({
    combo: 'mod+shift+e',
    handler() { exportCurrent(); return true; },
  });

  async function exportCurrent() {
    if (!window.__tenoteComposer || window.__tenoteComposer.isEmpty()) {
      tenote.ui.toast('Nothing to export');
      return;
    }
    const md = window.__tenoteComposer.getText();
    const cs = getComputedStyle(document.body);
    const v = (name, fallback) => {
      const raw = (cs.getPropertyValue(name) || '').trim();
      return /^#[0-9a-fA-F]{6}$/.test(raw) ? raw : fallback;
    };
    const bg = v('--bg-solid', '#f3eadb');
    let surface = v('--surface', '#fbf6ea');
    if (!/^#([0-9a-f]{6})$/i.test(surface)) surface = '#fbf6ea';
    const text = v('--text', '#3b2d1f');
    const muted = v('--muted', '#9a8461');
    const accent = v('--accent', '#a9762f');

    const W = 1600;
    const H = 1000;
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');

    const grad = ctx.createLinearGradient(0, 0, W, H);
    grad.addColorStop(0, shade(bg, -14));
    grad.addColorStop(1, shade(bg, 16));
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);

    const lines = layout(md);
    const cardW = 900;
    const lineH = 44;
    const titleSize = 42;
    let textH = 70 + titleSize + 46;
    textH += Math.min(lines.length - 1, 16) * lineH + 110;
    const cardH = Math.min(Math.max(textH, 420), H - 160);

    const x = (W - cardW) / 2;
    const y = (H - cardH) / 2;
    shadowRect(ctx, x, y, cardW, cardH, 28, surface);

    ctx.textBaseline = 'top';
    let cy = y + 52;
    const ix = x + 64;

    if (lines.length && lines[0].h === 'title') {
      ctx.fillStyle = text;
      ctx.font = `700 ${titleSize}px -apple-system, Helvetica Neue, sans-serif`;
      ctx.fillText(wrap(ctx, lines[0].text, cardW - 128), ix, cy);
      cy += titleSize + 18;
      ctx.fillStyle = accent;
      ctx.fillRect(ix, cy, 56, 4);
      cy += 30;
    } else {
      cy -= 20;
    }

    ctx.font = `400 27px -apple-system, Helvetica Neue, sans-serif`;
    for (const ln of lines.slice(lines[0] && lines[0].h === 'title' ? 1 : 0)) {
      if (cy > y + cardH - 70) { drawEllipsis(ctx, ix, cy, muted); break; }
      setFont(ctx, ln.h);
      ctx.fillStyle = ln.h === 'q' ? muted : text;
      ctx.fillText(ln.text, ix, cy);
      cy += lineH - (ln.h === 'h' ? 4 : 0);
    }

    ctx.fillStyle = muted;
    ctx.font = `600 22px -apple-system, Helvetica Neue, sans-serif`;
    ctx.fillText('✎ Tenote', ix, y + cardH - 58);

    const b64 = canvas.toDataURL('image/png').split(',')[1];
    const saved = await jot().attachImage({ mime: 'image/png', base64: b64 }).catch(() => null);
    await copyPng(b64);
    if (saved && saved.ok) tenote.ui.toast(`Share image copied to clipboard and saved to notes/${saved.path}`, 4500);
    else tenote.ui.toast('Share image copied to clipboard', 3500);
  }

  function setFont(ctx, kind) {
    if (kind === 'h') { ctx.font = `700 32px -apple-system, Helvetica Neue, sans-serif`; return; }
    if (kind === 'q') { ctx.font = `italic 27px Georgia, serif`; return; }
    ctx.font = `400 27px -apple-system, Helvetica Neue, sans-serif`;
  }

  async function copyPng(base64) {
    try {
      const res = await jot().invokePlugin('__host', 'copyPng', { base64 });
      return res && res.ok;
    } catch (e) { return false; }
  }

  function layout(md) {
    const out = [];
    for (const raw of md.split('\n')) {
      const line = raw
        .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
        .replace(/[*`]/g, '')
        .trim();
      if (!line) continue;
      if (/^#\s/.test(line)) out.push({ text: line.replace(/^#\s*/, ''), h: 'title' });
      else if (/^#{2,}\s/.test(line)) out.push({ text: line.replace(/^#+\s*/, ''), h: 'h' });
      else if (/^>\s?/.test(line)) out.push({ text: line.replace(/^>\s?/, ''), h: 'q' });
      else out.push({ text: line.replace(/^\s*[-*]\s/, '• ').replace(/-\s\[x\]\s*/i, '☑ ').replace(/-\s\[ \]\s*/, '☐ '), h: 'p' });
    }
    return out.slice(0, 40);
  }

  function wrap(ctx, text, maxW) {
    if (ctx.measureText(text).width <= maxW) return text;
    let t = text;
    while (t.length > 4 && ctx.measureText(t + '…').width > maxW) t = t.slice(0, -1);
    return t.trimEnd() + '…';
  }

  function drawEllipsis(ctx, x, y, color) {
    ctx.fillStyle = color;
    ctx.font = `400 27px -apple-system, sans-serif`;
    ctx.fillText('…', x, y);
  }

  function shadowRect(ctx, x, y, w, h, r, fill) {
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.28)';
    ctx.shadowBlur = 70;
    ctx.shadowOffsetY = 24;
    roundRect(ctx, x, y, w, h, r);
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.restore();
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function shade(hex, pct) {
    if (!/^#([0-9a-f]{6})$/i.test(hex)) return hex;
    const n = parseInt(hex.slice(1), 16);
    const amt = Math.round(2.55 * pct);
    const r = clamp((n >> 16) + amt);
    const g = clamp(((n >> 8) & 255) + amt);
    const b = clamp((n & 255) + amt);
    return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
  }
  function clamp(n) { return Math.max(0, Math.min(255, n)); }
};
