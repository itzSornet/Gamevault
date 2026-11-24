/*
 * Dates and numbers in English, laid out the way the user's region writes
 * them: Windows' regional format "de-DE" -> "en-DE" (21 Nov 2026, 1.234,5),
 * "en-GB" stays itself, "en-US" stays "Nov 21, 2026". A region English has no
 * data for falls back to day-first "en-150", or "en-US" where people write
 * the month first. The app's words stay English either way.
 * UMD: window.GVLocale in the renderer, module.exports in Node (tests).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.GVLocale = factory();
}(typeof self !== 'undefined' ? self : this, () => {
  // regions that write the month before the day
  const MONTH_FIRST = new Set(['US', 'PH', 'PR', 'AS', 'GU', 'MP', 'UM', 'VI', 'FM', 'MH', 'PW', 'BZ']);

  const resolves = (tag) => {
    try { return new Intl.DateTimeFormat(tag).resolvedOptions().locale === tag; } catch (_) { return false; }
  };

  /** A system locale tag ("de-DE", "en_GB", "ar-IQ") -> the English locale to format with. */
  function pick(system) {
    const m = /^([a-z]{2,3})(?:[-_][A-Za-z]{4})?(?:[-_]([A-Za-z]{2}|\d{3}))?/i.exec(String(system || '').trim());
    if (!m) return 'en-US';
    const region = m[2] ? m[2].toUpperCase() : '';
    if (!region) return 'en-US';
    const tag = `en-${region}`;
    if (resolves(tag)) return tag;
    return MONTH_FIRST.has(region) ? 'en-US' : 'en-150';
  }

  // Initials for a cover with no art, in any script: the first letter of the
  // first two words ("Ørkenvandrer — Ångström" -> "ØÅ"; combining marks stay
  // with their letter; punctuation, digits and emoji are skipped). Chinese,
  // Japanese and Korean titles have no spaces between words, so they take
  // the first two characters of the title ("黑神话：悟空" -> "黑神"). Arabic,
  // Hebrew and other right-to-left scripts take one letter: two would join
  // into a different word.
  const LETTER = /\p{L}\p{M}*/u;
  const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
  const RTL = /[\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}]/u;
  function initials(name) {
    const text = String(name || '');
    const first = LETTER.exec(text);
    if (!first) return '?';
    const up = (s) => s.normalize('NFC').toLocaleUpperCase();
    if (CJK.test(first[0])) {
      const run = /[\p{L}\p{M}]+/u.exec(text.slice(first.index))[0];
      return Array.from(run.normalize('NFC')).filter((c) => CJK.test(c)).slice(0, 2).join('') || up(first[0]);
    }
    if (RTL.test(first[0])) return up(first[0]);
    const out = [];
    for (const word of text.split(/\s+/)) {
      const m = LETTER.exec(word);
      if (m && !RTL.test(m[0]) && !CJK.test(m[0])) out.push(up(m[0]));
      if (out.length === 2) break;
    }
    return out.join('') || up(first[0]);
  }

  return { pick, initials };
}));
