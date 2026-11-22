const test = require('node:test');
const assert = require('node:assert');
const Palette = require('../src/lib/palette.js');

// a BGRA buffer made of [r,g,b,share] blocks
function img(blocks, size = 400) {
  const px = [];
  for (const [r, g, b, share] of blocks) {
    for (let i = 0; i < Math.round(size * share); i++) px.push(b, g, r, 255);
  }
  return Buffer.from(px);
}

test('picks the big colours first and keeps them apart', () => {
  const c = Palette.extract(img([[200, 30, 30, 0.5], [30, 60, 200, 0.3], [205, 32, 28, 0.1], [240, 200, 40, 0.1]]));
  assert.strictEqual(c.length, 3);
  assert.match(c[0], /^#c[0-9a-f]1[0-9a-f]1[0-9a-f]$/); // the red
  assert.ok(c.includes('#1e3cc8'));
  assert.ok(c.includes('#f0c828'));
});

test('a vivid accent beats a bigger near-black background', () => {
  const c = Palette.extract(img([[4, 4, 6, 0.6], [230, 120, 20, 0.4]]));
  assert.strictEqual(c[0], '#e67814');
});

test('skips transparent pixels, empty input gives no colours', () => {
  assert.deepStrictEqual(Palette.extract(Buffer.from([10, 10, 10, 0, 20, 20, 20, 0])), []);
  assert.deepStrictEqual(Palette.extract(Buffer.alloc(0)), []);
});

test('rgba order reads channels the other way round', () => {
  const px = Buffer.from([250, 10, 10, 255, 250, 10, 10, 255]);
  assert.strictEqual(Palette.extract(px, { order: 'rgba' })[0], '#fa0a0a');
  assert.strictEqual(Palette.extract(px)[0], '#0a0afa');
});

test('ink is dark on light colours and light on dark ones', () => {
  assert.strictEqual(Palette.ink(['#f2e6c8', '#d9c9a0']), '#1b1410');
  assert.strictEqual(Palette.ink(['#101830', '#2a1a40']), '#faf4e8');
  assert.strictEqual(Palette.ink([]), '#1b1410');
});
