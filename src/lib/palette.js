/*
 * The main colours of a picture, for the PEAK strap on a cover.
 * Input is raw pixels (BGRA, as Electron's nativeImage.toBitmap gives them);
 * output is up to `count` distinct colours, most important first, plus an ink
 * colour that reads on them.
 * UMD: window.Palette in the renderer, module.exports in Node (main + tests).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Palette = factory();
}(typeof self !== 'undefined' ? self : this, () => {
  const hex = (r, g, b) => '#' + [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');

  function parseHex(h) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(h || ''));
    if (!m) return null;
    const n = parseInt(m[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  // relative luminance (WCAG)
  function luminance([r, g, b]) {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  }

  function saturation([r, g, b]) {
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    return mx === 0 ? 0 : (mx - mn) / mx;
  }

  /**
   * pixels: Uint8Array/Buffer, 4 bytes a pixel. order: 'bgra' (default) or 'rgba'.
   * Colours are bucketed (4 bits a channel); a bucket's weight is how much of
   * the picture it covers, nudged up for vivid colours so a cover's accent
   * isn't lost under its dark background. Picks are kept apart from each other.
   */
  function extract(pixels, { order = 'bgra', count = 4 } = {}) {
    const ri = order === 'rgba' ? 0 : 2, bi = order === 'rgba' ? 2 : 0;
    const buckets = new Map();
    let total = 0;
    for (let i = 0; i + 3 < pixels.length; i += 4) {
      if (pixels[i + 3] < 128) continue;
      const r = pixels[i + ri], g = pixels[i + 1], b = pixels[i + bi];
      const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
      let k = buckets.get(key);
      if (!k) { k = { n: 0, r: 0, g: 0, b: 0 }; buckets.set(key, k); }
      k.n++; k.r += r; k.g += g; k.b += b;
      total++;
    }
    if (!total) return [];
    const list = [...buckets.values()].map((k) => {
      const rgb = [k.r / k.n, k.g / k.n, k.b / k.n];
      const s = saturation(rgb);
      const l = luminance(rgb);
      // near-black and near-white matter less than a real colour of the same size
      const tone = l < 0.012 || l > 0.85 ? 0.45 : 1;
      return { rgb, score: (k.n / total) * (0.5 + s * 1.5) * tone };
    }).sort((a, b) => b.score - a.score);

    const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    const picks = [];
    for (const minGap of [64, 40, 22]) {
      for (const c of list) {
        if (picks.length >= count) break;
        if (picks.some((p) => dist(p, c.rgb) < minGap)) continue;
        picks.push(c.rgb);
      }
      if (picks.length >= count) break;
    }
    return picks.map((p) => hex(...p));
  }

  /** dark or light ink for text sitting on these colours (weighted to the first) */
  function ink(colors) {
    const rgb = (colors || []).map(parseHex).filter(Boolean);
    if (!rgb.length) return '#1b1410';
    const w = rgb.map((_, i) => (i === 0 ? 2 : 1));
    const L = rgb.reduce((a, c, i) => a + luminance(c) * w[i], 0) / w.reduce((a, b) => a + b, 0);
    // contrast against near-black vs near-white ink
    const dark = (L + 0.05) / (luminance([27, 20, 16]) + 0.05);
    const light = (luminance([250, 244, 232]) + 0.05) / (L + 0.05);
    return dark >= light ? '#1b1410' : '#faf4e8';
  }

  return { extract, ink, parseHex, luminance };
}));
