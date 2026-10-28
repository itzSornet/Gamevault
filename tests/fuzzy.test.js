const test = require('node:test');
const assert = require('node:assert');
const Fuzzy = require('../src/lib/fuzzy.js');

const LIBRARY = [
  'Red Dead Redemption 2',
  'Riders Republic',
  'The Witcher 3: Wild Hunt',
  'Hades',
  'Grand Theft Auto V',
  'Pokémon Legends: Arceus',
];

const best = (query) => Fuzzy.bestMatch(query, LIBRARY).item;

test('abbreviations resolve to the right game', () => {
  assert.equal(best('rdr2'), 'Red Dead Redemption 2');
  assert.equal(best('gta v'), 'Grand Theft Auto V');
  assert.equal(best('witcher3'), 'The Witcher 3: Wild Hunt');
});

test('prefix beats typo and subsequence', () => {
  assert.equal(best('hade'), 'Hades');
  assert.ok(Fuzzy.score('hade', 'Hades').score > Fuzzy.score('hade', 'Hollow Knight').score);
});

test('single-character typos still match', () => {
  assert.equal(best('hads'), 'Hades');
  assert.equal(best('witcher'), 'The Witcher 3: Wild Hunt');
});

test('diacritics are folded', () => {
  assert.equal(best('pokemon'), 'Pokémon Legends: Arceus');
});

test('no false positives on unrelated queries', () => {
  assert.equal(best('rdr2'), 'Red Dead Redemption 2');
  assert.equal(Fuzzy.bestMatch('rdr2', ['Riders Republic']).item, null);
  assert.equal(Fuzzy.bestMatch('zzzz', LIBRARY).item, null);
});

test('exact match scores highest', () => {
  const exact = Fuzzy.score('Hades', 'Hades').score;
  const prefix = Fuzzy.score('Had', 'Hades').score;
  const sub = Fuzzy.score('ades', 'Hades').score;
  assert.ok(exact > prefix && prefix > sub);
});

test('multi-token queries require every token', () => {
  assert.equal(best('red dead'), 'Red Dead Redemption 2');
  assert.equal(Fuzzy.bestMatch('red hades', LIBRARY).item, null);
});
