'use strict';

// Built-in "Copy as image": a tight, theme-aware note card for the clipboard.
// Replaces examples/export-image, which used a 1600x1000 canvas with 350px of
// empty margin on each side.
(() => {
  const SANS = '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", sans-serif';
  const SERIF = 'Georgia, "Times New Roman", serif';

  function hexOr(v, fallback) {
    return /^#[0-9a-f]{6}$/i.test(String(v || '').trim()) ? String(v).trim() : fallback;
  }
  function paintOr(v, fallback) {
    const s = String(v || '').trim();
    return /^(#[0-9a-f]{3,8}|rgba?\()/i.test(s) ? s : fallback;
  }
  function roundRect(ctx, x, y, w, h, r) {
    const rr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
  }
  function shade(hex, pct) {
    if (!/^#[0-9a-f]{6}$/i.test(hex)) return hex;
    const n = parseInt(hex.slice(1), 16);
    const amt = Math.round(2.55 * pct);
    const clamp = (v) => Math.max(0, Math.min(255, v));
    const r = clamp((n >> 16) + amt);
    const g = clamp(((n >> 8) & 255) + amt);
    const b = clamp((n & 255) + amt);
    return '#' + ((r << 16) | (g << 8) | b).toString(16).padStart(6, '0');
  }
  function wrapLines(ctx, text, maxW) {
    const words = String(text).split(/\s+/).filter(Boolean);
    const lines = [];
    let cur = '';
    for (const word of words) {
      const next = cur ? cur + ' ' + word : word;
      if (!cur || ctx.measureText(next).width <= maxW) cur = next;
      else { lines.push(cur); cur = word; }
    }
    if (cur) lines.push(cur);
    return lines.length ? lines : [''];
  }

  function parse(md, tags) {
    const tagSet = new Set((tags || []).map((t) => String(t).replace(/^#/, '').toLowerCase()));
    const items = [];
    for (const rawLine of String(md).split(/\r?\n/)) {
      let line = rawLine
        .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
        .replace(/[*`_]/g, '')
        .trim();
      // Render known #tags as chips instead of inline text.
      line = line.replace(/(^|\s)#([\p{L}\w-]+)/gu, (m, pre, tag) =>
        tagSet.has(tag.toLowerCase()) ? pre : m
      ).trim();
      if (!line) continue;
      let kind = 'p';
      if (/^#{1,6}\s/.test(line)) {
        kind = items.length === 0 ? 'title' : 'h';
        line = line.replace(/^#+\s*/, '');
      } else if (/^>\s?/.test(line)) {
        kind = 'q';
        line = line.replace(/^>\s?/, '');
      } else {
        line = line.replace(/^\s*[-*]\s+/, '• ')
          .replace(/^•\s*\[x\]\s*/i, '☑ ')
          .replace(/^•\s*\[ \]\s*/, '☐ ');
      }
      items.push({ text: line, kind });
    }
    if (items.length && items[0].kind === 'p') items[0].kind = 'title';
    return items;
  }

  function drawPaper(ctx, x, y, w, h, style, dots, rule, bodyTop, lineH) {
    if (style === 'none') return;
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.clip();
    if (style === 'dots') {
      ctx.fillStyle = dots;
      for (let gy = y + 10; gy < y + h; gy += 20) {
        for (let gx = x + 10; gx < x + w; gx += 20) {
          ctx.beginPath();
          ctx.arc(gx, gy, 1.2, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    } else if (style === 'lines' || style === 'grid') {
      ctx.strokeStyle = rule;
      ctx.lineWidth = 1;
      // One rule per text row, 5px below the row's baseline, so the text sits
      // between two rules instead of having a line run through it.
      const step = lineH;
      const below = bodyTop + lineH - 5;
      for (let gy = below; gy < y + h; gy += step) {
        ctx.beginPath(); ctx.moveTo(x, gy + 0.5); ctx.lineTo(x + w, gy + 0.5); ctx.stroke();
      }
      for (let gy = below - step; gy > y; gy -= step) {
        ctx.beginPath(); ctx.moveTo(x, gy + 0.5); ctx.lineTo(x + w, gy + 0.5); ctx.stroke();
      }
      if (style === 'grid') {
        for (let gx = x + lineH; gx < x + w; gx += lineH) {
          ctx.beginPath(); ctx.moveTo(gx + 0.5, y); ctx.lineTo(gx + 0.5, y + h); ctx.stroke();
        }
      }
    }
    ctx.restore();
  }

  async function exportImage(md, opts) {
    opts = opts || {};
    const cs = getComputedStyle(document.body);
    const bg = hexOr(cs.getPropertyValue('--bg-solid'), '#f3eadb');
    const text = hexOr(cs.getPropertyValue('--text'), '#3b2d1f');
    const muted = hexOr(cs.getPropertyValue('--muted'), '#9a8461');
    const accent = hexOr(cs.getPropertyValue('--accent'), '#a9762f');
    const border = hexOr(cs.getPropertyValue('--border'), '#e2d3b8');
    const tile = hexOr(cs.getPropertyValue('--tile'), '#efe4d0');
    const dots = paintOr(cs.getPropertyValue('--dots'), 'rgba(122,92,55,0.16)');
    const rule = paintOr(cs.getPropertyValue('--rule'), dots);
    const paper = (cs.getPropertyValue('--paper-style') || 'dots').trim().toLowerCase();

    const items = parse(md, opts.tags);
    if (!items.length) return false;

    const titleItem = items[0].kind === 'title' ? items.shift() : { text: 'Note', kind: 'title' };
    const P = 34, M = 26, CARD_W = 720, contentW = CARD_W - P * 2;
    const titleSize = 34, titleLH = 40, bodySize = 21, lineH = 31;

    const meas = document.createElement('canvas').getContext('2d');
    meas.font = `700 ${titleSize}px ${SANS}`;
    const titleLines = wrapLines(meas, titleItem.text, contentW).slice(0, 3);

    const body = [];
    for (const it of items) {
      meas.font = it.kind === 'q'
        ? `italic ${bodySize}px ${SERIF}`
        : it.kind === 'h' ? `700 ${bodySize + 1}px ${SANS}` : `400 ${bodySize}px ${SANS}`;
      for (const line of wrapLines(meas, it.text, contentW)) body.push({ text: line, kind: it.kind });
    }

    const tags = (opts.tags || []).slice(0, 4).map((t) => '#' + String(t).replace(/^#/, ''));
    const chromeH = P * 2 + titleLines.length * titleLH + 18 + (tags.length ? 30 : 0) + 26;
    const MAX_H = 1000;
    const maxBody = Math.max(0, Math.floor((MAX_H - M * 2 - chromeH) / lineH));
    let bodyLines = body;
    let truncated = false;
    if (bodyLines.length > maxBody) {
      bodyLines = bodyLines.slice(0, Math.max(0, maxBody - 1));
      truncated = true;
    }
    const cardH = Math.max(200, chromeH + bodyLines.length * lineH + (truncated ? lineH : 0));
    const W = CARD_W + M * 2;
    const H = cardH + M * 2;
    const bodyTop = M + P + titleLines.length * titleLH + 24;

    const canvas = document.createElement('canvas');
    const dpr = 2;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.textBaseline = 'top';

    ctx.fillStyle = shade(bg, -5);
    ctx.fillRect(0, 0, W, H);

    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.20)';
    ctx.shadowBlur = 18;
    ctx.shadowOffsetY = 6;
    roundRect(ctx, M, M, CARD_W, cardH, 20);
    ctx.fillStyle = bg;
    ctx.fill();
    ctx.restore();

    drawPaper(ctx, M, M, CARD_W, cardH, paper, dots, rule, bodyTop, lineH);

    ctx.save();
    roundRect(ctx, M + 0.5, M + 0.5, CARD_W - 1, cardH - 1, 20);
    ctx.strokeStyle = border;
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();

    let x = M + P;
    let y = M + P;

    ctx.fillStyle = text;
    ctx.font = `700 ${titleSize}px ${SANS}`;
    for (const line of titleLines) { ctx.fillText(line, x, y); y += titleLH; }

    y += 6;
    ctx.fillStyle = accent;
    ctx.fillRect(x, y, 44, 3);
    y += 3 + 15;

    for (const line of bodyLines) {
      ctx.fillStyle = line.kind === 'q' ? muted : text;
      ctx.font = line.kind === 'q'
        ? `italic ${bodySize}px ${SERIF}`
        : line.kind === 'h' ? `700 ${bodySize + 1}px ${SANS}` : `400 ${bodySize}px ${SANS}`;
      ctx.fillText(line.text, x, y);
      y += lineH;
    }
    if (truncated) {
      ctx.fillStyle = muted;
      ctx.font = `400 ${bodySize}px ${SANS}`;
      ctx.fillText('…', x, y);
      y += lineH;
    }

    if (tags.length) {
      y += 6;
      ctx.font = `600 13px ${SANS}`;
      let tx = x;
      for (const tag of tags) {
        const tw = ctx.measureText(tag).width + 16;
        if (tx + tw > x + contentW) break;
        roundRect(ctx, tx, y, tw, 20, 10);
        ctx.fillStyle = tile;
        ctx.fill();
        ctx.fillStyle = accent;
        ctx.fillText(tag, tx + 8, y + 4);
        tx += tw + 6;
      }
    }

    ctx.fillStyle = muted;
    ctx.font = `600 12px ${SANS}`;
    ctx.textAlign = 'right';
    ctx.fillText('✎ Tenote', M + CARD_W - P, M + cardH - 22);
    ctx.textAlign = 'left';

    try {
      const base64 = canvas.toDataURL('image/png').split(',')[1];
      const res = await window.tenote.invokePlugin('__host', 'copyPng', { base64 });
      return !!(res && res.ok);
    } catch (e) {
      console.error('copy as image failed', e);
      return false;
    }
  }

  window.__tenoteExportImage = exportImage;
})();
