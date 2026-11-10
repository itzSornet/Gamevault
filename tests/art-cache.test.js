const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createArtCache, installSgdbImageCaching, normalizeTerm } = require('../src/backend/art-cache.js');

const URL_BASE = 'https://example.supabase.co';
const json = (status, body, headers) => new Response(JSON.stringify(body), { status, headers });

function lookupData(id = 7) {
  const item = (n) => ({ id: n, url: `https://cdn2.steamgriddb.com/grid/${n}.png`, thumb: `https://cdn2.steamgriddb.com/thumb/${n}.jpg` });
  return {
    game: { id, name: 'Counter-Strike 2', steamAppId: 730 },
    top: { cover: item(1), hero: null, logo: null, icon: null },
    assets: {
      grids: { items: [item(1), item(2)], total: 2, hasMore: false },
      heroes: { items: [item(3)], total: 1, hasMore: false },
      logos: { items: [], total: 0, hasMore: false },
      icons: { items: [], total: 0, hasMore: false },
    },
    candidates: [],
    source: 'sgdb',
    stale: false,
  };
}

/** Fake Supabase + CDN. `routes.art(body, req)` answers art-lookup calls. */
function setup(routes = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gv-art-'));
  let clock = 1_000_000_000_000;
  const calls = [];
  const state = { offline: false, signups: 0, refreshes: 0 };
  const fetch = async (url, init = {}) => {
    calls.push({ url, method: init.method || 'GET', headers: init.headers || {}, body: init.body });
    if (state.offline) throw new TypeError('fetch failed');
    if (url === `${URL_BASE}/auth/v1/signup`) {
      state.signups += 1;
      return json(200, { access_token: `tok${state.signups}`, refresh_token: `ref${state.signups}`, expires_in: 3600, user: { id: 'u1' } });
    }
    if (url.startsWith(`${URL_BASE}/auth/v1/token`)) {
      state.refreshes += 1;
      if (routes.refresh) return routes.refresh();
      return json(200, { access_token: `rtok${state.refreshes}`, refresh_token: `rref${state.refreshes}`, expires_in: 3600 });
    }
    if (url === `${URL_BASE}/functions/v1/art-lookup`) {
      const body = JSON.parse(init.body);
      return routes.art ? routes.art(body, init) : json(200, { ok: true, data: lookupData() });
    }
    if (url.includes('steamstatic.com')) {
      return new Response(null, { status: url.endsWith('logo.png') ? 404 : 200 });
    }
    if (url.includes('steamgriddb.com')) return new Response(Buffer.from(`img:${url}`), { status: 200 });
    return new Response(null, { status: 404 });
  };
  const cache = createArtCache({ dir, cloudUrl: URL_BASE, anonKey: 'pub', fetch, now: () => clock });
  const artCalls = () => calls.filter((c) => c.url.endsWith('/art-lookup'));
  return { dir, cache, calls, artCalls, state, tick: (ms) => { clock += ms; } };
}

const DAY = 24 * 60 * 60 * 1000;

test('not configured -> NO_CLOUD, no network', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gv-art-'));
  let called = false;
  const cache = createArtCache({ dir, fetch: async () => { called = true; } });
  const r = await cache.lookup({ steamAppId: 730 });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error.code, 'NO_CLOUD');
  assert.strictEqual(called, false);
});

test('lookup: signs in anonymously once, then serves from disk', async () => {
  const { cache, artCalls, state } = setup();
  const a = await cache.lookup({ steamAppId: 730 });
  assert.strictEqual(a.ok, true);
  assert.strictEqual(a.data.source, 'sgdb');
  assert.strictEqual(state.signups, 1);
  const call = artCalls()[0];
  assert.strictEqual(call.headers.Authorization, 'Bearer tok1');
  assert.strictEqual(call.headers.apikey, 'pub');
  assert.deepStrictEqual(JSON.parse(call.body), { steamAppId: 730 });

  const b = await cache.lookup({ steamAppId: 730 });
  assert.strictEqual(b.data.source, 'local');
  assert.strictEqual(artCalls().length, 1);

  // Saved under the sgdb id too, so the picker's { sgdbId } lookup is local.
  const c = await cache.lookup({ sgdbId: 7 });
  assert.strictEqual(c.data.source, 'local');
  assert.strictEqual(artCalls().length, 1);
});

test('lookup: session survives a restart (new cache instance, same dir)', async () => {
  const s = setup();
  await s.cache.lookup({ steamAppId: 730 });
  const again = createArtCache({ dir: s.dir, cloudUrl: URL_BASE, anonKey: 'pub', now: () => 1_000_000_000_000, fetch: async (url, init) => {
    s.calls.push({ url, headers: init.headers });
    return json(200, { ok: true, data: lookupData(8) });
  } });
  await again.lookup({ steamAppId: 999 });
  assert.strictEqual(s.state.signups, 1, 'no second sign-up');
  assert.strictEqual(s.calls.at(-1).headers.Authorization, 'Bearer tok1');
});

test('lookup: concurrent identical calls share one request', async () => {
  const { cache, artCalls } = setup();
  const [a, b] = await Promise.all([cache.lookup({ term: 'Half Life' }), cache.lookup({ term: '  half   LIFE ' })]);
  assert.ok(a.ok && b.ok);
  assert.strictEqual(artCalls().length, 1);
});

test('lookup: expired copy is refreshed; offline falls back to it as stale', async () => {
  const { cache, artCalls, state, tick } = setup();
  await cache.lookup({ steamAppId: 730 });
  tick(8 * DAY);
  state.offline = true;
  const r = await cache.lookup({ steamAppId: 730 });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.data.stale, true);
  assert.strictEqual(r.data.source, 'local');
  state.offline = false;
  const fresh = await cache.lookup({ steamAppId: 730 });
  assert.strictEqual(fresh.data.source, 'sgdb');
  assert.strictEqual(artCalls().length, 2);
});

test('lookup: NOT_FOUND is remembered for a day', async () => {
  const { cache, artCalls, tick } = setup({ art: () => json(404, { ok: false, error: { code: 'NOT_FOUND', message: 'none' } }) });
  assert.strictEqual((await cache.lookup({ term: 'zzzz' })).error.code, 'NOT_FOUND');
  assert.strictEqual((await cache.lookup({ term: 'zzzz' })).error.code, 'NOT_FOUND');
  assert.strictEqual(artCalls().length, 1);
  tick(DAY + 1);
  await cache.lookup({ term: 'zzzz' });
  assert.strictEqual(artCalls().length, 2);
});

test('lookup: rate limit with no local copy passes the error through', async () => {
  const { cache } = setup({ art: () => json(429, { ok: false, error: { code: 'RATE_LIMIT', message: 'slow down' } }) });
  const r = await cache.lookup({ steamAppId: 1 });
  assert.strictEqual(r.error.code, 'RATE_LIMIT');
});

test('lookup: 401 -> signs in again and retries once', async () => {
  let n = 0;
  const { cache, state } = setup({
    art: () => (++n === 1 ? json(401, { ok: false, error: { code: 'UNAUTHENTICATED', message: 'x' } }) : json(200, { ok: true, data: lookupData() })),
    refresh: () => json(400, { error_description: 'Invalid Refresh Token' }),
  });
  const r = await cache.lookup({ steamAppId: 730 });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(state.signups, 2, 'bad refresh token -> fresh anonymous user');
});

test('token: expired access token is refreshed, not re-signed-up', async () => {
  const { cache, state, tick } = setup();
  await cache.token();
  tick(2 * 60 * 60 * 1000);
  assert.strictEqual(await cache.token(), 'rtok1');
  assert.strictEqual(state.signups, 1);
});

test('bad input', async () => {
  const { cache } = setup();
  assert.strictEqual((await cache.lookup({})).error.code, 'BAD_REQUEST');
  assert.strictEqual((await cache.page(7, 'posters', 0)).error.code, 'BAD_REQUEST');
  assert.strictEqual((await cache.steamArt('abc')).error.code, 'BAD_REQUEST');
});

test('page: cached per (game, kind, page)', async () => {
  const { cache, artCalls } = setup({
    art: (body) => json(200, { ok: true, data: { game: { id: 7, name: 'x' }, kind: body.kind, page: body.page, items: [{ id: body.page }], total: 1, hasMore: false } }),
  });
  const p0 = await cache.page(7, 'grids', 0);
  assert.deepStrictEqual(JSON.parse(artCalls()[0].body), { sgdbId: 7, kind: 'grids', page: 0 });
  assert.strictEqual(p0.data.items[0].id, 0);
  assert.strictEqual((await cache.page(7, 'grids', 0)).data.source, 'local');
  await cache.page(7, 'grids', 1);
  await cache.page(7, 'heroes', 0);
  assert.strictEqual(artCalls().length, 3);
});

test('steamArt: checks which official images exist, caches the answer', async () => {
  const { cache, calls } = setup();
  const r = await cache.steamArt(730);
  assert.strictEqual(r.ok, true);
  assert.match(r.data.cover, /\/730\/library_600x900_2x\.jpg$/);
  assert.match(r.data.hero, /\/730\/library_hero\.jpg$/);
  assert.strictEqual(r.data.logo, null, 'logo 404 -> null');
  const heads = calls.filter((c) => c.method === 'HEAD').length;
  await cache.steamArt(730);
  assert.strictEqual(calls.filter((c) => c.method === 'HEAD').length, heads);
});

test('steamArt: offline with nothing cached -> NETWORK, and nothing saved', async () => {
  const { cache, state, dir } = setup();
  state.offline = true;
  assert.strictEqual((await cache.steamArt(730)).error.code, 'NETWORK');
  assert.strictEqual(fs.existsSync(path.join(dir, 'steam', '730.json')), false);
});

test('prefetchThumbs: downloads each thumb once, localThumb finds them', async () => {
  const { cache, calls } = setup();
  const data = lookupData();
  const r = await cache.prefetchThumbs(data);
  assert.deepStrictEqual(r, { downloaded: 3, failed: 0 });
  const file = cache.localThumb(data.assets.grids.items[0].thumb);
  assert.ok(file && fs.existsSync(file));
  assert.strictEqual(fs.readFileSync(file, 'utf8'), `img:${data.assets.grids.items[0].thumb}`);
  const before = calls.length;
  assert.deepStrictEqual(await cache.prefetchThumbs(data), { downloaded: 0, failed: 0 });
  assert.strictEqual(calls.length, before);
  assert.strictEqual(cache.localThumb('https://cdn2.steamgriddb.com/thumb/none.jpg'), null);
});

test('pruneThumbs: removes least recently used first', async () => {
  const s = setup();
  const cache = createArtCache({ dir: s.dir, cloudUrl: URL_BASE, anonKey: 'pub', maxThumbFiles: 2, fetch: async (url) => new Response(Buffer.from(url)) });
  const thumbs = path.join(s.dir, 'thumbs');
  const urls = [1, 2, 3].map((n) => `https://cdn2.steamgriddb.com/thumb/${n}.jpg`);
  await cache.prefetchThumbs({ assets: { grids: { items: urls.slice(0, 2).map((thumb) => ({ thumb })) } } });
  const files = fs.readdirSync(thumbs).map((f) => path.join(thumbs, f));
  // Make thumb 1 the oldest.
  const f1 = cache.localThumb(urls[0]);
  fs.utimesSync(f1, new Date(1000), new Date(1000));
  assert.strictEqual(files.length, 2);
  await cache.prefetchThumbs({ assets: { grids: { items: [{ thumb: urls[2] }] } } });
  assert.strictEqual(fs.readdirSync(thumbs).length, 2);
  assert.strictEqual(fs.existsSync(f1), false, 'oldest removed');
});

test('normalizeTerm matches the server', () => {
  assert.strictEqual(normalizeTerm('  Ｈalf   LIFE\t2 '), 'half life 2');
});

test('installSgdbImageCaching: 3-day Cache-Control on SGDB image GETs only', () => {
  let filter;
  let handler;
  installSgdbImageCaching({ webRequest: { onHeadersReceived: (f, h) => { filter = f; handler = h; } } });
  assert.deepStrictEqual(filter.urls, ['https://*.steamgriddb.com/*']);
  let out;
  handler({ method: 'GET', resourceType: 'image', responseHeaders: { 'cache-control': ['no-cache'], 'Content-Type': ['image/png'] } }, (r) => { out = r; });
  assert.deepStrictEqual(out.responseHeaders, { 'Content-Type': ['image/png'], 'Cache-Control': ['public, max-age=259200'] });
  handler({ method: 'GET', resourceType: 'xhr', responseHeaders: {} }, (r) => { out = r; });
  assert.deepStrictEqual(out, {});
});
