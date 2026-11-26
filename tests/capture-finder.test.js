const test = require('node:test');
const assert = require('node:assert/strict');

const { _test: { nameMatcher } } = require('../src/backend/capture-finder.js');

const games = [
  { id: 1, name: 'Dark Souls' },
  { id: 2, name: 'Dark Souls III' },
  { id: 3, name: 'Cyberpunk 2077' },
  { id: 4, name: 'Hollow Knight' },
  { id: 5, name: 'Pokémon Legends: Arceus' },
  { id: 6, name: 'Inside' },
  { id: 7, name: 'Q' },
];
const match = nameMatcher(games);

test('a folder named after the game finds it', () => {
  assert.equal(match('Cyberpunk 2077'), '3');
  assert.equal(match('Hollow Knight'), '4');
  assert.equal(match('HollowKnight'), '4');
  assert.equal(match('Pokemon Legends Arceus'), '5');
});

test('the longest name wins', () => {
  assert.equal(match('Dark Souls III'), '2');
  assert.equal(match('Dark Souls'), '1');
});

test('file names with a date after the game name', () => {
  assert.equal(match('Cyberpunk 2077 Screenshot 2024.01.05 - 21.10.33.12'), '3');
  assert.equal(match('Dark Souls III 2024-01-05 21-10-33'), '2');
  assert.equal(match('HollowKnight Screenshot 2024'), '4');
});

test('no false matches on short names or words inside other words', () => {
  assert.equal(match('Desktop'), null);
  assert.equal(match('Insider build 2024'), null);
  assert.equal(match('Q 2024-01-05'), null);
  assert.equal(match('Q'), null); // one letter is too short to trust
  assert.equal(match(''), null);
});
