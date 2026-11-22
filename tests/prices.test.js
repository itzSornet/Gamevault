const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createPrices } = require('../src/backend/prices.js');

const DEAL = { shop: 'Fanatical', amount: 19.79, regular: 29.99, cut: 34, currency: 'USD', url: 'https://itad.link/x/', drm: ['Steam'] };
const PRICE = { current: DEAL, deals: [DEAL], lowest: null, page: 'https://isthereanydeal.com/game/x/' };

function setup(reply) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gvp-')), 'prices.json');
  const calls = [];
  let t = 1000;
  const prices = createPrices({
    file, cloudUrl: 'https://x.supabase.co', anonKey: 'pk', token: async () => 'tok', now: () => t,
    fetch: async (url, init) => {
      const body = JSON.parse(init.body);
      calls.push({ url, body, auth: init.headers.Authorization });
      return reply(body);
    },
  });
  return { prices, calls, tick: (ms) => { t += ms; } };
}
const ok = (prices) => ({ status: 200, json: async () => ({ ok: true, data: { country: 'US', prices } }) });

test('asks the cloud function, never ITAD, and sends the token', async () => {
  const { prices, calls } = setup((b) => ok(Object.fromEntries(b.steamAppIds.map((id) => [id, id === 1 ? PRICE : null]))));
  const res = await prices.get({ steamAppIds: [1, 2], country: 'us' });
  assert.deepStrictEqual(res, { ok: true, data: { 1: PRICE, 2: null } });
  assert.strictEqual(calls.length, 1);
  assert.match(calls[0].url, /\/functions\/v1\/game-prices$/);
  assert.deepStrictEqual(calls[0].body, { steamAppIds: [1, 2], country: 'US' });
  assert.strictEqual(calls[0].auth, 'Bearer tok');
});

test('fresh answers come from disk; old ones are asked again', async () => {
  const { prices, calls, tick } = setup((b) => ok(Object.fromEntries(b.steamAppIds.map((id) => [id, PRICE]))));
  await prices.get({ steamAppIds: [1] });
  await prices.get({ steamAppIds: [1] });
  assert.strictEqual(calls.length, 1);
  tick(7 * 3600 * 1000);
  await prices.get({ steamAppIds: [1] });
  assert.strictEqual(calls.length, 2);
});

test('offline: the last prices seen are kept', async () => {
  let down = false;
  const { prices, tick } = setup((b) => {
    if (down) throw new Error('offline');
    return ok(Object.fromEntries(b.steamAppIds.map((id) => [id, PRICE])));
  });
  await prices.get({ steamAppIds: [1] });
  down = true;
  tick(7 * 3600 * 1000);
  assert.deepStrictEqual(await prices.get({ steamAppIds: [1] }), { ok: true, data: { 1: PRICE } });
  const none = await prices.get({ steamAppIds: [5] });
  assert.strictEqual(none.ok, false);
  assert.strictEqual(none.error.code, 'NETWORK');
});

test('more than 50 games go in batches', async () => {
  const { prices, calls } = setup((b) => ok(Object.fromEntries(b.steamAppIds.map((id) => [id, null]))));
  const ids = Array.from({ length: 120 }, (_, i) => i + 1);
  const res = await prices.get({ steamAppIds: ids });
  assert.strictEqual(Object.keys(res.data).length, 120);
  assert.deepStrictEqual(calls.map((c) => c.body.steamAppIds.length), [50, 50, 20]);
});

test('no cloud configured: a clear error, no request', async () => {
  const p = createPrices({ file: path.join(os.tmpdir(), 'none.json'), token: async () => 't', fetch: async () => { throw new Error('no'); } });
  const res = await p.get({ steamAppIds: [1] });
  assert.strictEqual(res.error.code, 'NO_CLOUD');
});

test("Steam's own regional price replaces ITAD's Steam row and can become the cheapest", async () => {
  const itadSteam = { ...DEAL, shop: 'Steam', amount: 49.99, regular: 49.99, cut: 0 };
  const entry = { current: DEAL, deals: [DEAL, itadSteam], lowest: null, page: 'p' };
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gvp-')), 'prices.json');
  const prices = createPrices({
    file, cloudUrl: 'https://x.supabase.co', anonKey: 'pk', token: async () => 't',
    fetch: async () => ok({ 7: entry }),
    steam: async () => ({ 7: { amount: 14.99, regular: 14.99, cut: 0, currency: 'USD' } }),
  });
  const res = await prices.get({ steamAppIds: [7], country: 'IQ' });
  const p = res.data[7];
  assert.strictEqual(p.current.shop, 'Steam');
  assert.strictEqual(p.current.amount, 14.99);
  assert.strictEqual(p.deals.filter((d) => d.shop === 'Steam').length, 1);
  assert.deepStrictEqual(p.deals[1], DEAL);
});

test('a Steam price in another currency is not mixed in', () => {
  const { mergeSteam } = require('../src/backend/prices.js');
  const entry = { current: DEAL, deals: [DEAL], lowest: null, page: 'p' };
  assert.strictEqual(mergeSteam(entry, { amount: 5, regular: 5, cut: 0, currency: 'TRY' }, 1), entry);
});
