/* Wishlist prices for GameVault, desktop side.
 *
 * Asks GameVault Cloud's `game-prices` Edge Function (which holds the
 * IsThereAnyDeal key; see cloud/supabase/functions/game-prices/index.ts) and
 * keeps each answer on disk, so the wishlist opens with prices straight away
 * and works offline with the last ones it saw. No key ever lives in the app.
 * Self-contained: no Electron imports, unit-tested in tests/prices.test.js.
 *
 * On disk, under `file` (e.g. <userData>/prices.json):
 *   { "US:1145350": { savedAt, data: Price | null }, ... }
 *
 * get() resolves to { ok: true, data: { [steamAppId]: Price | null } } or
 * { ok: false, error: { code, message } }. Price is exactly what the server
 * sent: { current: { shop, amount, regular, cut, currency, url } | null,
 *         lowest: { shop, amount, regular, cut, currency, at } | null, page }.
 */
const fs = require('fs');
const path = require('path');

const HOUR = 3600 * 1000;
const TTL = 6 * HOUR;          // same as the server's cache
const MAX_ENTRIES = 3000;
const BATCH = 50;              // the server takes up to 50 per call

const fail = (code, message) => ({ ok: false, error: { code, message } });
const VERSION = 2;             // 2: Steam's own regional price is merged in

/**
 * IsThereAnyDeal follows Steam's price in the big regions only (it says $49.99
 * for The Witcher 3 in Iraq, where Steam itself asks $34.99). So Steam's own
 * price for the user's store region replaces ITAD's Steam row, and the
 * cheapest shop is picked again. Other shops' rows stay exactly as ITAD sent
 * them. A Steam price in another currency than ITAD's is not compared.
 */
function mergeSteam(entry, own, appId) {
  if (!own || typeof own.amount !== 'number') return entry;
  const deals = entry && Array.isArray(entry.deals) ? entry.deals : [];
  const cur = deals.length ? deals[0].currency : own.currency;
  if (cur !== own.currency) return entry;
  const steam = {
    shop: 'Steam', amount: own.amount, regular: own.regular, cut: own.cut, currency: own.currency,
    url: `https://store.steampowered.com/app/${appId}/`, drm: ['Steam'], fromSteam: true,
  };
  const list = [...deals.filter((d) => d.shop !== 'Steam'), steam].sort((a, b) => a.amount - b.amount);
  return { current: list[0], deals: list, lowest: entry ? entry.lowest : null, page: entry ? entry.page : null };
}

/**
 * @param {object} opts
 * @param {string} opts.file        where answers are kept
 * @param {string} [opts.cloudUrl]  https://<ref>.supabase.co
 * @param {string} [opts.anonKey]   publishable key (public)
 * @param {Function} opts.token     ({forceNew}) => Promise<string>: a user or anonymous access token
 * @param {Function} [opts.steam]   (appIds, country) => Promise<{ [appId]: {amount, regular, cut, currency} }>
 * @param {Function} [opts.fetch]
 * @param {Function} [opts.now]
 */
function createPrices(opts = {}) {
  const cloudUrl = String(opts.cloudUrl || '').replace(/\/+$/, '');
  const anonKey = opts.anonKey || '';
  const doFetch = opts.fetch || ((...a) => fetch(...a));
  const now = opts.now || Date.now;
  let store = null;
  let saveTimer = null;

  function load() {
    if (store) return store;
    try { store = JSON.parse(fs.readFileSync(opts.file, 'utf8')) || {}; } catch (_) { store = {}; }
    return store;
  }
  function saveSoon() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        const keys = Object.keys(store);
        if (keys.length > MAX_ENTRIES) {
          keys.sort((a, b) => (store[a].savedAt || 0) - (store[b].savedAt || 0));
          for (const k of keys.slice(0, keys.length - MAX_ENTRIES)) delete store[k];
        }
        fs.mkdirSync(path.dirname(opts.file), { recursive: true });
        fs.writeFileSync(opts.file, JSON.stringify(store));
      } catch (_) {}
    }, 1000);
    if (saveTimer.unref) saveTimer.unref();
  }

  async function call(ids, country) {
    let last = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      let access;
      try { access = await opts.token({ forceNew: attempt > 0 }); } catch (err) { return fail('NETWORK', err.message); }
      let res;
      try {
        res = await doFetch(`${cloudUrl}/functions/v1/game-prices`, {
          method: 'POST',
          headers: { apikey: anonKey, Authorization: `Bearer ${access}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ steamAppIds: ids, country }),
          signal: AbortSignal.timeout(30_000),
        });
      } catch (err) {
        return fail('NETWORK', `Price server unreachable: ${err.message}`);
      }
      const body = await res.json().catch(() => null);
      if (res.status === 401 && attempt === 0) { last = body; continue; }
      if (body && typeof body.ok === 'boolean') return body;
      return fail(res.status >= 500 ? 'NETWORK' : 'SERVER', `Price server error ${res.status}`);
    }
    return last && last.error ? last : fail('UNAUTHENTICATED', 'Price server refused the session');
  }

  /** Prices for these Steam AppIDs; fresh ones from disk, the rest from the cloud. */
  async function get({ steamAppIds, country = 'US', fresh = false } = {}) {
    if (!cloudUrl || !anonKey) return fail('NO_CLOUD', 'Cloud is not configured');
    const cc = /^[A-Za-z]{2}$/.test(String(country)) ? String(country).toUpperCase() : 'US';
    const ids = [...new Set((steamAppIds || []).map(Number).filter((n) => Number.isSafeInteger(n) && n > 0))];
    const s = load();
    const out = {};
    const need = [];
    for (const id of ids) {
      const hit = s[`${cc}:${id}`];
      // answers from before every shop was listed are asked again
      const full = hit && hit.v === VERSION;
      if (hit && full && !fresh && now() - hit.savedAt < TTL) out[id] = hit.data;
      else need.push(id);
    }
    let error = null;
    for (let i = 0; i < need.length; i += BATCH) {
      const chunk = need.slice(i, i + BATCH);
      const res = await call(chunk, cc);
      if (res.ok && res.data && res.data.prices) {
        let own = {};
        if (opts.steam) { try { own = (await opts.steam(chunk, cc)) || {}; } catch (_) { own = {}; } }
        for (const id of chunk) {
          if (!(String(id) in res.data.prices) && !own[id]) continue;
          const data = mergeSteam(res.data.prices[id] || null, own[id], id);
          s[`${cc}:${id}`] = { savedAt: now(), data, v: VERSION };
          out[id] = data;
        }
        saveSoon();
      } else {
        error = res.error || { code: 'SERVER', message: 'No prices' };
        // offline or limited: the last prices seen beat none
        for (const id of chunk) if (s[`${cc}:${id}`]) out[id] = s[`${cc}:${id}`].data;
      }
    }
    if (error && !Object.keys(out).length) return { ok: false, error };
    return { ok: true, data: out };
  }

  return { get };
}

module.exports = { createPrices, mergeSteam };
