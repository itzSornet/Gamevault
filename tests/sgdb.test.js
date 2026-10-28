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

test('official artwork outranks alternate at equal fit', () => {
  const ranked = client.rank('grids', [
    asset({ id: 1, style: 'alternate' }),
    asset({ id: 2, style: 'official' }),
  ]);
  assert.equal(ranked[0].id, 2);
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

test('icons prefer square assets at least 256px', () => {
  const ranked = client.rank('icons', [
    asset({ id: 1, width: 128, height: 128 }),
    asset({ id: 2, width: 256, height: 256 }),
  ]);
  assert.equal(ranked[0].id, 2);
});

test('higher score wins inside the same style and fit', () => {
  const ranked = client.rank('grids', [
    asset({ id: 1, score: 1 }),
    asset({ id: 2, score: 99 }),
  ]);
  assert.equal(ranked[0].id, 2);
});
