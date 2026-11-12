const test = require('node:test');
const assert = require('node:assert');
const Sfx = require('../src/lib/sfx.js');

test('sfx: every sound has a priority and launch outranks the rest', () => {
  assert.ok(Sfx.names.length >= 10);
  for (const n of Sfx.names) assert.strictEqual(typeof Sfx.PRIORITY[n], 'number', n);
  const top = Math.max(...Object.values(Sfx.PRIORITY));
  assert.strictEqual(Sfx.PRIORITY.launch, top);
});

test('sfx: play, preview and settings are safe without Web Audio', () => {
  assert.doesNotThrow(() => {
    Sfx.setEnabled(false);
    Sfx.setVolume(2);
    Sfx.setVolume(-1);
    Sfx.setEnabled(true);
    Sfx.play('click');
    Sfx.play('nope');
    Sfx.preview('select');
  });
});

test('sfx: both styles exist and every sound plays without Web Audio', () => {
  assert.deepStrictEqual(Sfx.THEMES, ['airy', 'crisp']);
  assert.doesNotThrow(() => {
    for (const t of [...Sfx.THEMES, 'bogus']) {
      Sfx.setTheme(t);
      for (const n of Sfx.names) { Sfx.play(n, null, { pan: -2, pitch: 9 }); Sfx.preview(n, { pan: 0.4 }); }
    }
    Sfx.setNav(false);
    Sfx.play('move');
    Sfx.setNav(true);
  });
});
