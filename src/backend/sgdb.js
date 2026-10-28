/* SteamGridDB client.
 *
 * One place for auth, retries, caching and asset ranking. Everything returns
 * normalised plain objects so callers never see the raw API shape.
 */
const https = require('https');

const BASE = 'https://www.steamgriddb.com/api/v2';
const TTL = 5 * 60 * 1000;

const memory = new Map(); // url -> { expires, data }
const inflight = new Map(); // url -> Promise

function buildQuery(params) {
  const out = new URLSearchParams();
  for (const [key, value] of Object.entries(params || {})) {
    if (value == null || value === '') continue;
    out.set(key, Array.isArray(value) ? value.join(',') : String(value));
  }
  const qs = out.toString();
  return qs ? `?${qs}` : '';
}

function httpJson(url, apiKey) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { Authorization: `Bearer ${apiKey}`, 'User-Agent': 'GameVault/2.0' },
    }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(body); } catch (_) { /* handled below */ }
        resolve({ status: res.statusCode || 0, json, raw: body });
      });
    });
    req.setTimeout(10000, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

function classify(status, json, raw) {
  if (status === 401 || status === 403) return { code: 'AUTH', message: 'SteamGridDB rejected the API key' };
  if (status === 429) return { code: 'RATE_LIMIT', message: 'SteamGridDB rate limit reached' };
  if (status === 404) return { code: 'NOT_FOUND', message: 'Nothing found on SteamGridDB' };
  if (status >= 500) return { code: 'NETWORK', message: `SteamGridDB error ${status}` };
  if (!json) return { code: 'NETWORK', message: 'SteamGridDB returned an invalid response' };
  if (json.success === false) {
    const message = Array.isArray(json.errors) ? json.errors.join(', ') : 'SteamGridDB request failed';
    return { code: 'NETWORK', message };
  }
  return null;
}

function createSgdb(apiKey) {
  if (!apiKey) {
    const err = new Error('SteamGridDB API key missing');
    err.code = 'NO_KEY';
    throw err;
  }

  async function request(path, params, { ttl = TTL, retry = 2 } = {}) {
    const url = `${BASE}${path}${buildQuery(params)}`;
    const hit = memory.get(url);
    if (hit && hit.expires > Date.now()) return hit.data;
    if (inflight.has(url)) return inflight.get(url);

    const run = (async () => {
      let lastError = null;
      for (let attempt = 0; attempt <= retry; attempt++) {
        try {
          const { status, json, raw } = await httpJson(url, apiKey);
          const failure = classify(status, json, raw);
          if (!failure) {
            const data = json.data;
            memory.set(url, { expires: Date.now() + ttl, data });
            return data;
          }
          if (failure.code !== 'RATE_LIMIT' && failure.code !== 'NETWORK') throw Object.assign(new Error(failure.message), failure);
          lastError = Object.assign(new Error(failure.message), failure);
        } catch (err) {
          lastError = Object.assign(err, err.code ? {} : { code: 'NETWORK' });
        }
        if (attempt < retry) await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
      }
      throw lastError;
    })();

    inflight.set(url, run);
    try {
      return await run;
    } finally {
      inflight.delete(url);
    }
  }

  function normalizeGame(game) {
    return {
      id: game.id,
      name: game.name,
      releaseDate: game.release_date || null,
      types: game.types || [],
      verified: !!game.verified,
    };
  }

  function normalizeAsset(asset) {
    return {
      id: asset.id,
      url: asset.url,
      thumb: asset.thumb || asset.url,
      width: asset.width || 0,
      height: asset.height || 0,
      style: Array.isArray(asset.style) ? asset.style[0] : (asset.style || ''),
      nsfw: !!asset.nsfw,
      humor: !!asset.humor,
      epilepsy: !!asset.epilepsy,
      score: asset.score || 0,
      upvotes: asset.upvotes || 0,
      mime: asset.mime || '',
    };
  }

  const STYLE_RANK = {
    official: 0,
    alternate: 1,
    no_logo: 1,
    nologo: 1,
    white_logo: 2,
    material: 2,
    blurred: 3,
  };

  function rank(kind, list) {
    const safe = (list || [])
      .filter((item) => !item.nsfw && !item.humor && !item.epilepsy)
      .map(normalizeAsset);

    const fit = (a) => {
      const ratio = a.height ? a.width / a.height : 1;
      if (kind === 'grids') {
        const close = Math.abs(ratio - 2 / 3) < 0.04;
        return (close ? 0 : 40) + (a.width >= 600 ? 0 : 20);
      }
      if (kind === 'heroes') return ratio >= 1.45 ? 0 : 100;
      if (kind === 'icons') return Math.abs(ratio - 1) < 0.05 ? (a.width >= 256 ? 0 : 10) : 100;
      if (kind === 'logos') return a.width >= 400 ? 0 : 20;
      return 0;
    };

    return safe.slice().sort((a, b) => {
      const fitA = fit(a);
      const fitB = fit(b);
      if (fitA !== fitB) return fitA - fitB;
      const styleA = STYLE_RANK[a.style] ?? 2;
      const styleB = STYLE_RANK[b.style] ?? 2;
      if (styleA !== styleB) return styleA - styleB;
      if (b.score !== a.score) return b.score - a.score;
      return b.upvotes - a.upvotes;
    });
  }

  return {
    async searchGames(term) {
      const data = await request(`/search/autocomplete/${encodeURIComponent(term)}`);
      return (data || []).map(normalizeGame);
    },

    async gameById(id) {
      const data = await request(`/games/id/${id}`);
      return data ? normalizeGame(data) : null;
    },

    async gameBySteamAppId(appId) {
      const data = await request(`/games/steam/${appId}`);
      return data ? normalizeGame(data) : null;
    },

    async assets(kind, id, opts = {}) {
      const allowed = ['grids', 'heroes', 'logos', 'icons'];
      if (!allowed.includes(kind)) throw new Error(`Unsupported asset kind: ${kind}`);
      const params = {
        styles: opts.styles,
        dimensions: opts.dimensions,
        types: opts.types,
        mimes: opts.mimes,
        oneoftag: opts.oneoftag,
        page: opts.page || 0,
      };
      const data = await request(`/${kind}/game/${id}`, params);
      const ranked = rank(kind, data || []);
      // SteamGridDB returns up to 50 assets per page; keep them all.
      const pageSize = opts.pageSize || 50;
      return {
        items: ranked.slice(0, pageSize),
        total: ranked.length,
        hasMore: (data || []).length >= 50,
      };
    },

    async topOf(kind, id) {
      const data = await request(`/${kind}/game/${id}`, {});
      const ranked = rank(kind, data || []);
      return ranked[0] || null;
    },

    rank,
  };
}

module.exports = { createSgdb, BASE };
