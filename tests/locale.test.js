const test = require('node:test');
const assert = require('node:assert');
const { pick } = require('../src/lib/locale.js');

test('English regions keep their own format', () => {
  assert.strictEqual(pick('en-US'), 'en-US');
  assert.strictEqual(pick('en-GB'), 'en-GB');
  assert.strictEqual(pick('en_AU'), 'en-AU');
});

test('other languages get English in their region', () => {
  assert.strictEqual(pick('de-DE'), 'en-DE');
  assert.strictEqual(pick('nl-NL'), 'en-NL');
  assert.strictEqual(pick('sv-SE'), 'en-SE');
});

test('a region English has no data for falls back by date order', () => {
  // whether "en-XX" exists depends on the ICU build; either way the answer is English
  const iq = pick('ar-IQ');
  assert.ok(iq === 'en-IQ' || iq === 'en-150', iq);
  assert.strictEqual(pick('es-PR').startsWith('en-'), true);
});

test('missing or odd input is US English', () => {
  assert.strictEqual(pick(''), 'en-US');
  assert.strictEqual(pick(undefined), 'en-US');
  assert.strictEqual(pick('fr'), 'en-US');
  assert.strictEqual(pick('???'), 'en-US');
});

test('day-first fallback writes the day before the month', () => {
  const s = new Date(2026, 10, 21).toLocaleDateString(pick('ar-IQ'), { month: 'short', day: 'numeric' });
  assert.match(s, /^21/);
});

const { initials } = require('../src/lib/locale.js');

test('initials: first letters of two words, any Latin-like script', () => {
  assert.strictEqual(initials('Ørkenvandrer — Ångström'), 'ØÅ');
  assert.strictEqual(initials('stardew valley'), 'SV');
  assert.strictEqual(initials('Ölçü Spiel'), 'ÖS');
  assert.strictEqual(initials('Пикник на обочине'), 'ПН');
  assert.strictEqual(initials('2077: ★ Night'), 'N');
  assert.strictEqual(initials(''), '?');
  assert.strictEqual(initials('— 42 —'), '?');
});

test('initials: Chinese, Japanese and Korean take the first two characters', () => {
  assert.strictEqual(initials('黑神话：悟空 豪华版'), '黑神');
  assert.strictEqual(initials('ゼルダの伝説 ブレス オブ ザ ワイルド'), 'ゼル');
  assert.strictEqual(initials('디아블로 IV'), '디아');
  assert.strictEqual(initials('鬼'), '鬼');
});

test('initials: right-to-left scripts take one letter, so it cannot join into a word', () => {
  assert.strictEqual(initials('لعبة الصحراء: أسطورة الرمال'), 'ل');
  assert.strictEqual(initials('משחק טוב'), 'מ');
});
