'use strict';

// Generates the designed Dock/app icon (assets/icon.png, 1024x1024):
// three stacked cream note cards with a pencil on top, on a white rounded
// tile. Corners are transparent (macOS convention). CLI only — the running
// app never regenerates this file.
// Usage: node scripts/gen-app-icon.js   (writes to assets/)

const fs = require('fs');
const path = require('path');
const { encodePng, roundedRectSdf, cov } = require('./gen-icons');

// --- small color helpers (straight alpha, rgb 0-255, alpha 0-1) -----------

const mix = (a, b, t) => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];
const shade = (c, f) => [c[0] * f, c[1] * f, c[2] * f];
const clamp01 = (v) => Math.min(1, Math.max(0, v));

function over(dst, rgb, a) {
  if (a <= 0) return;
  const oa = a + dst.a * (1 - a);
  if (oa <= 0) return;
  dst.r = (rgb[0] * a + dst.r * dst.a * (1 - a)) / oa;
  dst.g = (rgb[1] * a + dst.g * dst.a * (1 - a)) / oa;
  dst.b = (rgb[2] * a + dst.b * dst.a * (1 - a)) / oa;
  dst.a = oa;
}

// Soft shadow coverage from an sdf: 1 inside, fades to 0 over `blur` px.
const soft = (d, blur) => clamp01(0.5 - d / blur);

// --- design ----------------------------------------------------------------

function appIcon(size) {
  const u = size; // 1 design unit = full canvas

  // White tile (macOS icon grid: ~84% of canvas, generous radius).
  const TILE = { cx: 0.5 * u, cy: 0.5 * u, hw: 0.42 * u, hh: 0.42 * u, r: 0.2 * u };

  // Cards: squares rotated 45° and squashed along world y (viewed at a tilt).
  const TH = Math.PI / 4;
  const K = 0.7; // vertical squash
  const CARD_H = 0.203 * u; // half-size of the square, local space
  const CARD_R = 0.045 * u;
  const THICK = [0.004 * u, 0.026 * u]; // side-face offset (visible thickness)
  const CARDS = [
    [0.5 * u, 0.408 * u], // top
    [0.5 * u, 0.496 * u],
    [0.5 * u, 0.584 * u], // bottom
  ];
  const CARD_TOP_HI = [248, 241, 227];
  const CARD_TOP_LO = [232, 215, 182];
  const CARD_SIDE_HI = [216, 197, 164];
  const CARD_SIDE_LO = [191, 169, 130];
  const SHADOW = [74, 64, 54];

  // Pencil: from eraser (upper-left) to graphite tip (lower-right).
  const P0 = [0.335 * u, 0.262 * u]; // eraser back-center
  const P1 = [0.7 * u, 0.502 * u]; // graphite tip
  const pdx = P1[0] - P0[0];
  const pdy = P1[1] - P0[1];
  const PLEN = Math.hypot(pdx, pdy);
  const EX = pdx / PLEN, EY = pdy / PLEN; // along axis
  const NX = -EY, NY = EX; // perpendicular
  const W_ERASER = 0.027 * u;
  const W_BODY = 0.024 * u;
  const W_GRAPH = 0.011 * u;
  // segment boundaries along the axis (px from P0)
  const S_ERASER = 0.072 * u;
  const S_FERRULE = 0.122 * u;
  const S_BODY = 0.345 * u;
  const S_CONE = 0.408 * u;
  const S_TIP = PLEN;
  const C_ERASER_HI = [240, 116, 102];
  const C_ERASER_LO = [214, 89, 81];
  const C_FERRULE_HI = [138, 138, 146];
  const C_FERRULE_LO = [76, 76, 82];
  const C_BODY_HI = [240, 211, 160];
  const C_BODY_MID = [227, 193, 148];
  const C_BODY_LO = [196, 154, 104];
  const C_CONE_HI = [239, 211, 166];
  const C_CONE_LO = [217, 185, 138];
  const C_GRAPH_HI = [74, 74, 82];
  const C_GRAPH_LO = [38, 38, 44];

  // Signed distance to a card shape (rotation then world-y squash; the
  // inverse transform applied to the sample point).
  function cardSdf(px, py, cx, cy) {
    const dx = px - cx;
    const dy = (py - cy) / K;
    const qx = Math.cos(TH) * dx + Math.sin(TH) * dy;
    const qy = -Math.sin(TH) * dx + Math.cos(TH) * dy;
    return roundedRectSdf(qx, qy, 0, 0, CARD_H, CARD_H, CARD_R) * 0.85;
  }

  // Pencil local coords: al = along axis from P0, perp = signed distance off.
  function pencilLocal(px, py) {
    const rx = px - P0[0];
    const ry = py - P0[1];
    return [rx * EX + ry * EY, rx * NX + ry * NY];
  }

  const segDist = (al, perp, a, b) =>
    Math.hypot(al - Math.min(b, Math.max(a, al)), perp);

  // Pencil silhouette sdf + owning part id (0 eraser, 1 ferrule, 2 body,
  // 3 cone, 4 graphite). Evaluated at an already-local point.
  function pencilSdf(al, perp) {
    let best = Infinity, part = -1;
    const take = (d, id) => { if (d < best) { best = d; part = id; } };
    take(segDist(al, perp, 0, S_ERASER) - W_ERASER, 0);
    take(roundedRectSdf(al, perp, (S_ERASER + S_FERRULE) / 2, 0,
      (S_FERRULE - S_ERASER) / 2, W_ERASER * 0.98, 0.004 * u), 1);
    take(roundedRectSdf(al, perp, (S_FERRULE + S_BODY) / 2, 0,
      (S_BODY - S_FERRULE) / 2, W_BODY, 0.006 * u), 2);
    take(segDist(al, perp, S_BODY, S_CONE) -
      (W_BODY * 0.95 + (W_GRAPH * 1.15 - W_BODY * 0.95) *
        clamp01((al - S_BODY) / (S_CONE - S_BODY))), 3);
    take(segDist(al, perp, S_CONE, S_TIP) -
      (W_GRAPH * 1.15 + (0.0015 * u - W_GRAPH * 1.15) *
        clamp01((al - S_CONE) / (S_TIP - S_CONE))), 4);
    return [best, part];
  }

  function pencilColor(al, perp, part) {
    // Light from upper-left: the -perp flank is lit, +perp in shade.
    const w = part === 0 ? W_ERASER : W_BODY;
    const lit = clamp01(0.5 - perp / (2 * w)); // 1 at lit edge, 0 at dark edge
    if (part === 0) return mix(C_ERASER_LO, C_ERASER_HI, lit);
    if (part === 1) {
      // metal band: bright strip on the lit side, dark on the other
      return mix(C_FERRULE_LO, C_FERRULE_HI, Math.pow(lit, 1.5));
    }
    if (part === 2) {
      // wooden body with a soft hex-facet highlight near the lit edge
      const facet = Math.exp(-Math.pow((perp + 0.45 * w) / (0.45 * w), 2));
      const base = mix(C_BODY_LO, C_BODY_MID, lit);
      return mix(base, C_BODY_HI, 0.55 * facet);
    }
    if (part === 3) return mix(C_CONE_LO, C_CONE_HI, lit);
    return mix(C_GRAPH_LO, C_GRAPH_HI, lit);
  }

  function sample(px, py) {
    const out = { r: 0, g: 0, b: 0, a: 0 };

    // White tile with a barely-there vertical gradient.
    const tileD = roundedRectSdf(px, py, TILE.cx, TILE.cy, TILE.hw, TILE.hh, TILE.r);
    const tileA = cov(tileD);
    if (tileA <= 0) return out; // transparent corners
    over(out, mix([255, 255, 255], [241, 241, 245], clamp01((py - 0.08 * u) / (0.84 * u))), tileA);

    // Soft shadow of the whole stack on the tile.
    const bs = CARDS[2];
    over(out, SHADOW,
      0.22 * soft(cardSdf(px - 0.008 * u, py - 0.035 * u, bs[0], bs[1]), 0.045 * u) * tileA);

    // Cards from bottom to top: cast shadow, side face, top face.
    for (let i = 2; i >= 0; i--) {
      const [cx, cy] = CARDS[i];
      over(out, SHADOW,
        0.2 * soft(cardSdf(px - 0.004 * u, py - 0.018 * u, cx, cy), 0.028 * u) * tileA);
      const sideD = cardSdf(px - THICK[0], py - THICK[1], cx, cy);
      over(out,
        mix(CARD_SIDE_HI, CARD_SIDE_LO, clamp01((py - cy) / (0.05 * u) + 0.5)),
        cov(sideD) * tileA);
      const topD = cardSdf(px, py, cx, cy);
      over(out,
        mix(CARD_TOP_HI, CARD_TOP_LO, clamp01((py - (cy - 0.21 * u)) / (0.42 * u))),
        cov(topD) * tileA);
    }

    // Pencil shadow, clipped to the top card.
    {
      const [al, perp] = pencilLocal(px - 0.01 * u, py - 0.022 * u);
      const [d] = pencilSdf(al, perp);
      over(out, SHADOW,
        0.3 * soft(d, 0.022 * u) * cov(cardSdf(px, py, CARDS[0][0], CARDS[0][1])) * tileA);
    }

    // Pencil.
    {
      const [al, perp] = pencilLocal(px, py);
      const [d, part] = pencilSdf(al, perp);
      if (part >= 0) over(out, pencilColor(al, perp, part), cov(d));
    }

    return out;
  }

  // 2x2 supersampling on top of the sdf edge AA.
  return (x, y) => {
    let r = 0, g = 0, b = 0, a = 0;
    for (const [ox, oy] of [[-0.25, -0.25], [0.25, -0.25], [-0.25, 0.25], [0.25, 0.25]]) {
      const s = sample(x + ox, y + oy);
      r += s.r; g += s.g; b += s.b; a += s.a;
    }
    return [r / 4, g / 4, b / 4, (a / 4) * 255];
  };
}

function generate(dir) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'icon.png'), encodePng(1024, appIcon(1024)));
}

if (require.main === module) {
  generate(path.join(__dirname, '..', 'assets'));
  console.log('wrote assets/icon.png');
}

module.exports = generate;
