/* Local artwork cache for GameVault 2.0 (milestone M2, desktop side).
 *
 * Sits between the app and the shared art server (Supabase Edge Function
 * `art-lookup`, see cloud/supabase/functions/art-lookup/index.ts) and keeps
 * everything it learns on disk, so restarts, library re-scans and the art
 * picker don't ask the server again. Self-contained: no Electron imports,
 * so it can be unit-tested with plain Node (tests/art-cache.test.js).
 *
 * On disk, under `dir` (e.g. <userData>/art-cache):
 *   session.json            anonymous Supabase session (access + refresh token)
 *   lookups/<key>.json      art-lookup answers  (steam-730, sgdb-5363838, term-<sha1>)
 *   pages/<id>-<kind>-<n>.json  picker pages ("show more")
 *   steam/<appId>.json      which official Steam images exist for a game
 *   thumbs/<sha1>.<ext>     downloaded thumbnails of the top picks (LRU-pruned)
 *
 * Every method resolves to the same envelope main.js's sgdbWrap() uses:
 *   { ok: true, data } | { ok: false, error: { code, message } }
 * Extra codes here: NO_CLOUD (url/key not configured), NETWORK (offline).
 * data.source is 'local' when served from disk, else whatever the server said
 * ('cache' | 'sgdb'). data.stale is true when the server was unreachable and
 * an old local copy was served instead.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DAY = 24 * 60 * 60 * 1000;
const LOOKUP_TTL = 7 * DAY; // server keeps 30 days; re-check weekly
const PAGE_TTL = 7 * DAY;
const MISS_TTL = 1 * DAY; // "SteamGridDB has nothing" answers
const STEAM_TTL = 30 * DAY;
const THUMB_MAX_BYTES = 300 * 1024 * 1024;
const THUMB_MAX_FILES = 5000;
const KINDS = ['grids', 'heroes', 'logos', 'icons'];
const STEAM_CDN = 'https://shared.steamstatic.com/store_item_assets/steam/apps';
const SGDB_IMAGE_CACHE_CONTROL = 'public, max-age=259200'; // 3 days, same as Hydra

function normalizeTerm(term) {
  return String(term || '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

const sha1 = (s) => crypto.createHash('sha1').update(String(s)).digest('hex');
const fail = (code, message) => ({ ok: false, error: { code, message } });

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return null;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value));
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch (_) {}
    throw err;
  }
}

/**
 * @param {object} opts
 * @param {string} opts.dir         cache folder (created on demand)
 * @param {string} [opts.cloudUrl]  https://<ref>.supabase.co
 * @param {string} [opts.anonKey]   publishable / anon key (public)
 * @param {Function} [opts.fetch]   injectable for tests (defaults to global fetch)
 * @param {Function} [opts.now]
 * @param {number} [opts.maxThumbBytes]
 */
function createArtCache(opts = {}) {
  const dir = opts.dir;
  if (!dir) throw new Error('createArtCache: dir is required');
  const cloudUrl = String(opts.cloudUrl || '').replace(/\/+$/, '');
  const anonKey = String(opts.anonKey || '');
  const doFetch = opts.fetch || globalThis.fetch;
  const now = opts.now || Date.now;
  const maxThumbBytes = opts.maxThumbBytes || THUMB_MAX_BYTES;
  const maxThumbFiles = opts.maxThumbFiles || THUMB_MAX_FILES;
  const configured = () => !!(cloudUrl && anonKey);

  const P = {
    session: path.join(dir, 'session.json'),
    lookup: (key) => path.join(dir, 'lookups', `${key}.json`),
    page: (id, kind, n) => path.join(dir, 'pages', `${id}-${kind}-${n}.json`),
    steam: (appId) => path.join(dir, 'steam', `${appId}.json`),
    thumbs: path.join(dir, 'thumbs'),
  };

  const inflight = new Map();
  function once(key, fn) {
    if (inflight.has(key)) return inflight.get(key);
    const job = fn().finally(() => inflight.delete(key));
    inflight.set(key, job);
    return job;
  }

  // ------------------------------------------------------------ session

  let session = null;
  let sessionJob = null;

  async function authCall(pathAndQuery, body) {
    const res = await doFetch(`${cloudUrl}/auth/v1/${pathAndQuery}`, {
      method: 'POST',
      headers: { apikey: anonKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
      signal: AbortSignal.timeout(10_000),
    });
    const json = await res.json().catch(() => null);
    if (!res.ok || !json || !json.access_token) {
      throw Object.assign(new Error((json && (json.msg || json.error_description || json.message)) || `Sign-in failed (${res.status})`), {
        code: res.status === 422 || res.status === 400 ? 'AUTH' : 'NETWORK',
      });
    }
    return {
      access_token: json.access_token,
      refresh_token: json.refresh_token,
      expires_at: json.expires_at ? json.expires_at * 1000 : now() + (json.expires_in || 3600) * 1000,
      user_id: json.user && json.user.id,
    };
  }

  /** A valid access token: reuse, refresh, or sign in anonymously (in that order). */
  async function token({ forceNew = false } = {}) {
    if (sessionJob) return sessionJob;
    sessionJob = (async () => {
      if (!session) session = readJson(P.session);
      if (!forceNew && session && session.access_token && session.expires_at - 60_000 > now()) {
        return session.access_token;
      }
      let next = null;
      if (session && session.refresh_token) {
        try {
          next = await authCall('token?grant_type=refresh_token', { refresh_token: session.refresh_token });
        } catch (err) {
          if (err.code === 'NETWORK') throw err; // offline: don't throw away a good refresh token
        }
      }
      if (!next) next = await authCall('signup', {}); // anonymous sign-in
      session = next;
      writeJson(P.session, session);
      return session.access_token;
    })().finally(() => { sessionJob = null; });
    return sessionJob;
  }

  // ----------------------------------------------------------- server

  async function callServer(body) {
    let lastErr = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      let access;
      try {
        access = await token({ forceNew: attempt > 0 });
      } catch (err) {
        return fail(err.code || 'NETWORK', err.message);
      }
      let res;
      try {
        res = await doFetch(`${cloudUrl}/functions/v1/art-lookup`, {
          method: 'POST',
          headers: { apikey: anonKey, Authorization: `Bearer ${access}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(30_000),
        });
      } catch (err) {
        return fail('NETWORK', `Art server unreachable: ${err.message}`);
      }
      const json = await res.json().catch(() => null);
      if (res.status === 401 && attempt === 0) { lastErr = json; continue; } // token revoked: sign in again
      if (json && typeof json.ok === 'boolean') return json;
      return fail(res.status >= 500 ? 'NETWORK' : 'SERVER', `Art server error ${res.status}`);
    }
    return lastErr && lastErr.error ? lastErr : fail('UNAUTHENTICATED', 'Art server refused the session');
  }

  /** Disk-first fetch with offline fallback; shared by lookup() and page(). */
  async function cached(file, ttl, body, onSaved) {
    if (!configured()) return fail('NO_CLOUD', 'Cloud artwork is not configured');
    const hit = readJson(file);
    const age = hit ? now() - hit.savedAt : Infinity;
    if (hit && hit.miss && age < MISS_TTL) return fail('NOT_FOUND', 'Nothing found on SteamGridDB');
    if (hit && hit.data && age < ttl) return { ok: true, data: { ...hit.data, source: 'local', stale: false } };

    const res = await callServer(body);
    if (res.ok) {
      writeJson(file, { savedAt: now(), data: res.data });
      if (onSaved) onSaved(res.data);
      return res;
    }
    if (res.error && res.error.code === 'NOT_FOUND') {
      writeJson(file, { savedAt: now(), miss: true });
      return res;
    }
    // Offline, rate limited, server trouble: an old copy beats nothing.
    if (hit && hit.data) return { ok: true, data: { ...hit.data, source: 'local', stale: true } };
    return res;
  }

  function lookupKey({ steamAppId, sgdbId, term }) {
    if (sgdbId) return `sgdb-${Number(sgdbId)}`;
    if (steamAppId) return `steam-${Number(steamAppId)}`;
    const t = normalizeTerm(term);
    return t ? `term-${sha1(t)}` : null;
  }

  /** Same input/output as the server's art-lookup (top 8 per kind + top picks). */
  function lookup(input = {}) {
    const key = lookupKey(input);
    if (!key) return Promise.resolve(fail('BAD_REQUEST', 'Give steamAppId, sgdbId or term'));
    const body = {};
    if (input.sgdbId) body.sgdbId = Number(input.sgdbId);
    if (input.steamAppId) body.steamAppId = Number(input.steamAppId);
    if (input.term) body.term = String(input.term);
    return once(`lookup:${key}`, () => cached(P.lookup(key), LOOKUP_TTL, body, (data) => {
      // Later { sgdbId } lookups (e.g. from the picker) are then local too.
      if (data && data.game && data.game.id && !key.startsWith('sgdb-')) {
        writeJson(P.lookup(`sgdb-${data.game.id}`), { savedAt: now(), data });
      }
    }));
  }

  /** One picker page: { items, total, hasMore } like sgdb.assets(kind, id, { page }). */
  function page(sgdbId, kind, n = 0) {
    if (!KINDS.includes(kind)) return Promise.resolve(fail('BAD_REQUEST', `Unknown kind ${kind}`));
    const id = Number(sgdbId);
    const num = Number(n) || 0;
    return once(`page:${id}:${kind}:${num}`, () =>
      cached(P.page(id, kind, num), PAGE_TTL, { sgdbId: id, kind, page: num }));
  }

  // ------------------------------------------------ official Steam art

  async function exists(url) {
    try {
      const res = await doFetch(url, { method: 'HEAD', signal: AbortSignal.timeout(8_000) });
      return res.ok;
    } catch (_) {
      return null; // unknown (offline): don't cache the answer
    }
  }

  /**
   * Steam's own library art for a Steam game: { cover, hero, logo } URLs, null
   * where Steam has none (use the art server's top pick there instead).
   */
  function steamArt(appId) {
    const id = Number(appId);
    if (!Number.isSafeInteger(id) || id <= 0) return Promise.resolve(fail('BAD_REQUEST', 'Bad Steam app id'));
    return once(`steam:${id}`, async () => {
      const hit = readJson(P.steam(id));
      if (hit && now() - hit.savedAt < STEAM_TTL) return { ok: true, data: hit.data };
      const urls = {
        cover: `${STEAM_CDN}/${id}/library_600x900_2x.jpg`,
        hero: `${STEAM_CDN}/${id}/library_hero.jpg`,
        logo: `${STEAM_CDN}/${id}/logo.png`,
      };
      const checks = await Promise.all(Object.values(urls).map(exists));
      if (checks.includes(null)) {
        return hit ? { ok: true, data: hit.data } : fail('NETWORK', 'Could not reach Steam');
      }
      const data = {};
      Object.keys(urls).forEach((slot, i) => { data[slot] = checks[i] ? urls[slot] : null; });
      writeJson(P.steam(id), { savedAt: now(), data });
      return { ok: true, data };
    });
  }

  // -------------------------------------------------------- thumbnails

  function thumbFile(url) {
    let ext = '.png';
    try { ext = path.extname(new URL(url).pathname) || '.png'; } catch (_) {}
    if (!/^\.[a-z0-9]{1,5}$/i.test(ext)) ext = '.png';
    return path.join(P.thumbs, `${sha1(url)}${ext}`);
  }

  /** file:// path of a downloaded thumbnail, or null. Touches it for LRU. */
  function localThumb(url) {
    const file = thumbFile(url);
    if (!fs.existsSync(file)) return null;
    try { const t = new Date(now()); fs.utimesSync(file, t, t); } catch (_) {}
    return file;
  }

  async function downloadThumb(url) {
    const file = thumbFile(url);
    if (fs.existsSync(file)) return file;
    return once(`thumb:${file}`, async () => {
      const res = await doFetch(url, { signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new Error(`Status ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      fs.mkdirSync(P.thumbs, { recursive: true });
      const tmp = `${file}.part`;
      fs.writeFileSync(tmp, buf);
      fs.renameSync(tmp, file);
      return file;
    });
  }

  /** Delete least-recently-used thumbnails until under the size/count caps. */
  function pruneThumbs() {
    let files;
    try {
      files = fs.readdirSync(P.thumbs)
        .filter((f) => !f.endsWith('.part'))
        .map((f) => {
          const full = path.join(P.thumbs, f);
          const st = fs.statSync(full);
          return { full, size: st.size, used: st.mtimeMs };
        });
    } catch (_) {
      return 0;
    }
    let total = files.reduce((n, f) => n + f.size, 0);
    let count = files.length;
    files.sort((a, b) => a.used - b.used);
    let removed = 0;
    for (const f of files) {
      if (total <= maxThumbBytes && count <= maxThumbFiles) break;
      try { fs.rmSync(f.full, { force: true }); } catch (_) { continue; }
      total -= f.size;
      count -= 1;
      removed += 1;
    }
    return removed;
  }

  /**
   * Download the thumbnails of a lookup's top picks (up to 8 per kind) so the
   * picker opens instantly and works offline. Returns { downloaded, failed }.
   */
  async function prefetchThumbs(data, { kinds = KINDS, concurrency = 4 } = {}) {
    const urls = [];
    const seen = new Set();
    for (const kind of kinds) {
      const items = (data && data.assets && data.assets[kind] && data.assets[kind].items) || [];
      for (const a of items) {
        const u = a && (a.thumb || a.url);
        if (u && /^https:\/\//i.test(u) && !seen.has(u)) { seen.add(u); urls.push(u); }
      }
    }
    let next = 0;
    let downloaded = 0;
    let failed = 0;
    const worker = async () => {
      while (next < urls.length) {
        const u = urls[next++];
        try {
          const had = fs.existsSync(thumbFile(u));
          await downloadThumb(u);
          if (!had) downloaded += 1;
        } catch (_) {
          failed += 1;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, urls.length) }, worker));
    pruneThumbs();
    return { downloaded, failed };
  }

  return { configured, lookup, page, steamArt, prefetchThumbs, localThumb, pruneThumbs, token, normalizeTerm };
}

/**
 * Hydra's trick: make Chromium's own HTTP cache keep SteamGridDB images for 3
 * days, so picker thumbnails load instantly the second time. Call once with
 * the window's session (main.js: installSgdbImageCaching(win.webContents.session)).
 */
function installSgdbImageCaching(session) {
  if (!session || !session.webRequest) return;
  session.webRequest.onHeadersReceived({ urls: ['https://*.steamgriddb.com/*'] }, (details, callback) => {
    const isImage = details.method === 'GET' && (details.resourceType === 'image' || details.resourceType === 'media');
    if (!isImage) return callback({});
    const headers = {};
    for (const [k, v] of Object.entries(details.responseHeaders || {})) {
      if (k.toLowerCase() !== 'cache-control') headers[k] = v;
    }
    headers['Cache-Control'] = [SGDB_IMAGE_CACHE_CONTROL];
    callback({ responseHeaders: headers });
  });
}

module.exports = { createArtCache, installSgdbImageCaching, normalizeTerm, KINDS };
