const test = require('node:test');
const assert = require('node:assert/strict');

const Rating = require('../src/lib/rating.js');

test('parse: same rules as 1.3.1', () => {
  assert.equal(Rating.parse('8'), 8);
  assert.equal(Rating.parse('8.56'), 8.6);
  assert.equal(Rating.parse(' 7,5 '), 7.5, 'comma decimals');
  assert.equal(Rating.parse('peak'), 10);
  assert.equal(Rating.parse('GOATED'), 10);
  assert.equal(Rating.parse('42'), 10, 'capped at 10');
  assert.equal(Rating.parse(''), 0);
  assert.equal(Rating.parse('-3'), 0);
  assert.equal(Rating.parse('meh'), 0);
  assert.equal(Rating.parse(null), 0);
  assert.equal(Rating.parse(9), 9);
});

test('value: reads a 1.3.1 game as-is, junk as unrated', () => {
  assert.equal(Rating.value({ rating: 8.5 }), 8.5);
  assert.equal(Rating.value({ rating: '7' }), 7);
  assert.equal(Rating.value({ rating: 10 }), 10);
  assert.equal(Rating.value({ rating: 0 }), 0);
  assert.equal(Rating.value({ rating: 'x' }), 0);
  assert.equal(Rating.value({}), 0);
  assert.equal(Rating.value(null), 0);
});

test('label and tier', () => {
  assert.equal(Rating.label(0), '');
  assert.equal(Rating.label(8), '8');
  assert.equal(Rating.label(8.5), '8.5');
  assert.equal(Rating.label(10), 'PEAK');
  assert.deepEqual([0, 3, 6, 7.9, 8, 9.9, 10].map(Rating.tier), ['', 'low', 'mid', 'mid', 'high', 'high', 'peak']);
});
