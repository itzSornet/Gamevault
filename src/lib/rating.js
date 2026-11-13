/*
 * Game ratings, on the same scale 1.3.x used so old libraries carry over:
 * g.rating is 0 (unrated) or 0.1–10 in tenths, and 10 is "PEAK".
 * UMD: window.Rating in the renderer, module.exports in Node (tests).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Rating = factory();
}(typeof self !== 'undefined' ? self : this, () => {
  const PEAK = 10;
  const PEAK_WORDS = ['peak', 'goated', 'goat'];

  /** Typed text or a number -> a stored rating (0 = none). Same rules as 1.3.1. */
  function parse(val) {
    if (val === undefined || val === null) return 0;
    const s = String(val).trim().toLowerCase();
    if (!s) return 0;
    if (PEAK_WORDS.includes(s)) return PEAK;
    const num = parseFloat(s.replace(',', '.'));
    if (!Number.isFinite(num) || num <= 0) return 0;
    return Math.round(Math.min(PEAK, num) * 10) / 10;
  }

  /** A stored value, cleaned: anything odd reads as unrated. */
  function value(g) {
    const n = Number(g && g.rating);
    return Number.isFinite(n) && n > 0 ? Math.min(PEAK, Math.round(n * 10) / 10) : 0;
  }

  /** '' | 'PEAK' | '8' | '8.5' */
  function label(r) {
    const n = Number(r) || 0;
    if (n <= 0) return '';
    if (n >= PEAK) return 'PEAK';
    return n % 1 === 0 ? String(n) : n.toFixed(1);
  }

  /** colour band, the 1.3.1 cut-offs: under 6 low, under 8 mid, then high */
  function tier(r) {
    const n = Number(r) || 0;
    if (n <= 0) return '';
    if (n >= PEAK) return 'peak';
    if (n < 6) return 'low';
    if (n < 8) return 'mid';
    return 'high';
  }

  return { PEAK, parse, value, label, tier };
}));
