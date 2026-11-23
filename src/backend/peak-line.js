/* What critics said about a game (its score and one line), desktop side.
 *
 * Asks GameVault Cloud's `peak-line` Edge Function (which holds the
 * OpenCritic and DeepSeek keys; see cloud/supabase/functions/peak-line) and
 * keeps each answer on disk, so a scroll or game page opens with it straight
 * away and offline. A final answer with a line is kept for good; a stand-in
 * (written while OpenCritic couldn't be asked) or no line is asked again
 * after a day, so OpenCritic's answer replaces it.
 * Self-contained: no Electron imports, unit-tested in tests/peak-line.test.js.
 *
 * On disk, under `file` (e.g. <userData>/peak-lines.json):
 *   { "steam:1245620": { savedAt, line, by, score, final }, ... }
 *
 * get() resolves to { ok: true, data: { [key]: { line, by, score } | null } }
 * or { ok: false, error: { code, message } }; key is "steam:<appid>" or
 * "itad:<id>"; by = the outlet a quoted line is from, score = OpenCritic's.
 */
const fs = require('fs');
const path = require('path');

const DAY = 24 * 3600 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const fail = (code, message) => ({ ok: false, error: { code, message } });
// what the app sees of a stored answer; null = nothing to show
const view = (hit) => (hit && (hit.line || hit.score) ? { line: hit.line || null, by: hit.by || null, score: Number.isFinite(hit.score) ? hit.score : null } : null);

/** "steam:<appid>" or "itad:<id>" for a { steamAppId, itadId }; "" for neither. */
function keyOf(g) {
  const n = Number(g && g.steamAppId);
  if (Number.isSafeInteger(n) && n > 0) return `steam:${n}`;
  const id = String((g && g.itadId) || '').toLowerCase();
  return UUID.test(id) ? `itad:${id}` : '';
}

function createPeakLines(opts = {}) {
  const cloudUrl = String(opts.cloudUrl || '').replace(/\/+$/, '');
  const anonKey = opts.anonKey || '';
  const doFetch = opts.fetch || ((...a) => fetch(...a));
  const now = opts.now || Date.now;
  let store = null;

  const load = () => {
    if (store) return store;
    try { store = JSON.parse(fs.readFileSync(opts.file, 'utf8')) || {}; } catch (_) { store = {}; }
    return store;
  };
  const save = () => {
    try {
      fs.mkdirSync(path.dirname(opts.file), { recursive: true });
      fs.writeFileSync(opts.file, JSON.stringify(store));
    } catch (_) {}
  };

  async function call(games) {
    for (let attempt = 0; attempt < 2; attempt++) {
      let access;
      try { access = await opts.token({ forceNew: attempt > 0 }); } catch (err) { return fail('NETWORK', err.message); }
      let res;
      try {
        res = await doFetch(`${cloudUrl}/functions/v1/peak-line`, {
          method: 'POST',
          headers: { apikey: anonKey, Authorization: `Bearer ${access}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ games }),
          signal: AbortSignal.timeout(60_000),
        });
      } catch (err) {
        return fail('NETWORK', `Cloud unreachable: ${err.message}`);
      }
      const body = await res.json().catch(() => null);
      if (res.status === 401 && attempt === 0) continue;
      if (body && typeof body.ok === 'boolean') return body;
      return fail(res.status >= 500 ? 'NETWORK' : 'SERVER', `Cloud error ${res.status}`);
    }
    return fail('UNAUTHENTICATED', 'Cloud refused the session');
  }

  /** Lines for these games ({ steamAppId?, itadId? }), from disk first. */
  async function get(games = []) {
    if (!cloudUrl || !anonKey) return fail('NO_CLOUD', 'Cloud is not configured');
    const s = load();
    const out = {};
    const need = [];
    for (const g of games) {
      const k = keyOf(g);
      if (!k || k in out) continue;
      const hit = s[k];
      if (hit && ((hit.final === true && hit.line) || now() - hit.savedAt < DAY)) out[k] = view(hit);
      else { out[k] = hit ? view(hit) : null; need.push(k); }
    }
    let error = null;
    for (let i = 0; i < need.length; i += 10) {
      const chunk = need.slice(i, i + 10);
      const res = await call(chunk.map((k) => (k.startsWith('steam:') ? { steamAppId: Number(k.slice(6)) } : { itadId: k.slice(5) })));
      if (res.ok && res.data && res.data.lines) {
        for (const k of chunk) {
          if (!(k in res.data.lines)) continue;
          const v = res.data.lines[k] || {};
          s[k] = {
            savedAt: now(),
            line: typeof v.line === 'string' ? v.line : null,
            by: typeof v.by === 'string' ? v.by : null,
            score: Number.isFinite(v.score) ? v.score : null,
            final: v.final !== false,
          };
          out[k] = view(s[k]);
        }
        save();
      } else error = res.error || { code: 'SERVER', message: 'No lines' };
    }
    if (error && need.length === Object.keys(out).length) return { ok: false, error };
    return { ok: true, data: out };
  }

  return { get };
}

module.exports = { createPeakLines, keyOf };
