/* The Peak scroll's line about a game, desktop side.
 *
 * Asks GameVault Cloud's `peak-line` Edge Function (which holds the DeepSeek
 * key; see cloud/supabase/functions/peak-line/index.ts) and keeps each line on
 * disk for good, so a scroll opens with its line straight away and offline.
 * A game with no line yet is asked again after a day.
 * Self-contained: no Electron imports, unit-tested in tests/peak-line.test.js.
 *
 * On disk, under `file` (e.g. <userData>/peak-lines.json):
 *   { "steam:1245620": { savedAt, line: string | null }, ... }
 *
 * get() resolves to { ok: true, data: { [key]: string | null } } or
 * { ok: false, error: { code, message } }; key is "steam:<appid>" or "itad:<id>".
 */
const fs = require('fs');
const path = require('path');

const DAY = 24 * 3600 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const fail = (code, message) => ({ ok: false, error: { code, message } });

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
      if (hit && (hit.line || now() - hit.savedAt < DAY)) out[k] = hit.line;
      else { out[k] = null; need.push(k); }
    }
    let error = null;
    for (let i = 0; i < need.length; i += 10) {
      const chunk = need.slice(i, i + 10);
      const res = await call(chunk.map((k) => (k.startsWith('steam:') ? { steamAppId: Number(k.slice(6)) } : { itadId: k.slice(5) })));
      if (res.ok && res.data && res.data.lines) {
        for (const k of chunk) {
          if (!(k in res.data.lines)) continue;
          const line = typeof res.data.lines[k] === 'string' ? res.data.lines[k] : null;
          s[k] = { savedAt: now(), line };
          out[k] = line;
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
