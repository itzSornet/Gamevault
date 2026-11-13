const test = require('node:test');
const assert = require('node:assert');
const { createSgdb } = require('../src/backend/sgdb.js');

// The client is only used for its pure ranking helpers here; no network calls.
const client = createSgdb('test-key');

const asset = (overrides = {}) => ({
  id: 1,
  url: 'https://cdn/1.png',
  width: 600,
  height: 900,
  style: 'official',
  nsfw: false,
  humor: false,
  epilepsy: false,
  score: 10,
  upvotes: 5,
  mime: 'image/png',
  ...overrides,
});

test('unsafe artwork is filtered out', () => {
  const ranked = client.rank('grids', [
    asset({ id: 1, nsfw: true }),
    asset({ id: 2, humor: true }),
    asset({ id: 3, epilepsy: true }),
    asset({ id: 4 }),
  ]);
  assert.deepEqual(ranked.map((a) => a.id), [4]);
});

test('SteamGridDB order is kept at equal fit (style does not reorder)', () => {
  const ranked = client.rank('logos', [
    asset({ id: 1, style: 'custom', width: 300, height: 100 }),
    asset({ id: 2, style: 'official', width: 800, height: 300 }),
  ]);
  assert.deepEqual(ranked.map((a) => a.id), [1, 2]);
});

test('portrait grids rank above square ones for covers', () => {
  const ranked = client.rank('grids', [
    asset({ id: 1, width: 512, height: 512 }),
    asset({ id: 2, width: 600, height: 900 }),
  ]);
  assert.equal(ranked[0].id, 2);
});

test('banners require a wide aspect ratio', () => {
  const ranked = client.rank('heroes', [
    asset({ id: 1, width: 600, height: 900 }),
    asset({ id: 2, width: 1920, height: 620 }),
  ]);
  assert.equal(ranked[0].id, 2);
});

test('icons must be square', () => {
  const ranked = client.rank('icons', [
    asset({ id: 1, width: 256, height: 128 }),
    asset({ id: 2, width: 128, height: 128 }),
  ]);
  assert.equal(ranked[0].id, 2);
});

test('342x482 covers count as portrait', () => {
  const ranked = client.rank('grids', [
    asset({ id: 1, width: 342, height: 482 }),
    asset({ id: 2, width: 600, height: 900 }),
  ]);
  assert.deepEqual(ranked.map((a) => a.id), [1, 2]);
});
