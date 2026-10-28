/* Fuzzy matching shared by the renderer and the main process.
 *
 * UMD-ish: in Node it exports, in the renderer it lands on window.Fuzzy.
 * Scoring scale is intentionally human-readable (0-1000) so thresholds are
 * easy to reason about: exact > prefix > word > substring > subsequence > typo.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Fuzzy = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function normalize(value) {
    return String(value == null ? '' : value)
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  }

  // Bounded Damerau-Levenshtein; returns max + 1 when the distance is hopeless.
  function distance(a, b, max) {
    if (Math.abs(a.length - b.length) > max) return max + 1;
    const rows = a.length + 1;
    const cols = b.length + 1;
    const dp = Array.from({ length: rows }, () => new Array(cols).fill(0));
    for (let i = 0; i < rows; i++) dp[i][0] = i;
    for (let j = 0; j < cols; j++) dp[0][j] = j;

    for (let i = 1; i < rows; i++) {
      for (let j = 1; j < cols; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        dp[i][j] = Math.min(
          dp[i - 1][j] + 1,
          dp[i][j - 1] + 1,
          dp[i - 1][j - 1] + cost
        );
        if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
          dp[i][j] = Math.min(dp[i][j], dp[i - 2][j - 2] + 1);
        }
      }
    }
    return dp[a.length][b.length];
  }

  function subsequence(query, text) {
    let qi = 0;
    let first = -1;
    let last = -1;
    for (let i = 0; i < text.length && qi < query.length; i++) {
      if (text[i] === query[qi]) {
        if (first < 0) first = i;
        last = i;
        qi += 1;
      }
    }
    if (qi < query.length) return 0;
    const gaps = last - first + 1 - query.length;
    const base = 350 - gaps * 6 + (first === 0 ? 40 : 0);
    return Math.max(60, base);
  }

  function scoreToken(q, name) {
    if (name === q) return { score: 1000, ranges: [[0, name.length]] };

    const idx = name.indexOf(q);
    if (idx === 0) return { score: 800, ranges: [[0, q.length]] };
    if (idx > 0) {
      const boundary = name[idx - 1] === ' ';
      return {
        score: (boundary ? 650 : 500) - Math.min(60, idx),
        ranges: [[idx, idx + q.length]],
      };
    }

    let best = 0;
    for (const word of name.split(' ')) {
      if (!word) continue;
      if (word.startsWith(q)) {
        best = Math.max(best, 650 - Math.min(40, word.length - q.length));
        continue;
      }
      if (q.length >= 4 && Math.abs(word.length - q.length) <= 2) {
        const d = distance(q, word, 2);
        const limit = q.length >= 7 ? 2 : 1;
        if (d <= limit) {
          best = Math.max(best, Math.round(340 * (1 - d / Math.max(q.length, word.length))));
        }
      }
    }
    if (best > 0) return { score: best, ranges: [] };

    return { score: subsequence(q, name), ranges: [] };
  }

  function score(query, text) {
    const q = normalize(query);
    const t = normalize(text);
    if (!q) return { score: 1, ranges: [] };
    if (!t) return { score: 0, ranges: [] };

    const tokens = q.split(' ').filter(Boolean);
    if (tokens.length > 1) {
      let total = 0;
      let ranges = [];
      for (const token of tokens) {
        const part = scoreToken(token, t);
        if (part.score <= 0) return { score: 0, ranges: [] };
        total += part.score;
        ranges = ranges.concat(part.ranges || []);
      }
      return { score: Math.round(total / tokens.length), ranges };
    }
    return scoreToken(q, t);
  }

  function bestMatch(query, items, keyFn, options) {
    const list = Array.isArray(items) ? items : [];
    const threshold = options && options.threshold != null ? options.threshold : 250;
    const limit = options && options.limit != null ? options.limit : 3;

    const scored = [];
    for (const item of list) {
      const text = keyFn ? keyFn(item) : item;
      const result = score(query, text);
      if (result.score >= threshold) {
        scored.push({ item, score: result.score, ranges: result.ranges });
      }
    }
    scored.sort((a, b) => b.score - a.score);

    return {
      item: scored.length ? scored[0].item : null,
      score: scored.length ? scored[0].score : 0,
      ranges: scored.length ? scored[0].ranges : [],
      alternatives: scored.slice(1, 1 + limit).map((entry) => entry.item),
      all: scored,
    };
  }

  return { normalize, score, bestMatch, distance };
});
