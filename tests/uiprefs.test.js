const test = require('node:test');
const assert = require('node:assert/strict');
const U = require('../src/lib/uiprefs.js');

test('normalize: nothing in, today\'s look out', () => {
  assert.deepEqual(U.normalize(undefined), U.defaults());
  assert.deepEqual(U.normalize(null), U.defaults());
  assert.deepEqual(U.normalize([1, 2]), U.defaults());
  assert.deepEqual(U.normalize('dock'), U.defaults());
  assert.ok(U.isDefault({}));
});

test('normalize: round-trips a valid object', () => {
  const ui = { ...U.defaults(), nav: 'dock', dockPos: 'top', search: 'hidden', accent: '#ff8800', tint: 30, glass: { blur: 150, opacity: 80, saturation: 120, solid: false } };
  assert.deepEqual(U.normalize(U.normalize(ui)), U.normalize(ui));
  assert.equal(U.normalize(ui).nav, 'dock');
  assert.equal(U.normalize(ui).accent, '#ff8800');
});

test('normalize: clamps numbers and drops unknown values', () => {
  const n = U.normalize({ nav: 'hologram', tint: 900, fontScale: -4, radius: '2', glass: { blur: 'lots', opacity: 1000 }, extra: 1 });
  assert.equal(n.nav, 'sidebar');
  assert.equal(n.tint, 100);
  assert.equal(n.fontScale, 90);
  assert.equal(n.radius, 2);
  assert.equal(n.glass.blur, 100);
  assert.equal(n.glass.opacity, 140);
  assert.equal(n.extra, undefined);
});

test('normalize: accent hex forms', () => {
  assert.equal(U.normalize({ accent: 'F80' }).accent, '#ff8800');
  assert.equal(U.normalize({ accent: '#ABCDEF' }).accent, '#abcdef');
  assert.equal(U.normalize({ accent: 'red' }).accent, null);
  assert.equal(U.normalize({ accent: 'url(javascript:x)' }).accent, null);
});

test('custom background without a file falls back to fluid', () => {
  assert.equal(U.normalize({ background: 'video' }).background, 'fluid');
  assert.equal(U.normalize({ background: 'video', backgroundFile: 'C:/x/bg.mp4', backgroundKind: 'video' }).background, 'video');
});

test('syncable drops local paths but keeps the choice; adopt keeps this PC\'s file', () => {
  const local = { background: 'video', backgroundFile: 'C:/u/bg.mp4', backgroundKind: 'video', nav: 'dock' };
  const s = U.syncable(local);
  assert.equal(s.backgroundFile, undefined);
  assert.equal(s.backgroundKind, undefined);
  assert.equal(s.background, 'video');
  assert.ok(JSON.stringify(s).length < 700, 'synced prefs stay tiny');

  // another PC without the file: falls back to fluid, everything else applies
  const other = U.adopt({}, s);
  assert.equal(other.nav, 'dock');
  assert.equal(other.background, 'fluid');
  // the PC that has the file keeps it
  assert.equal(U.adopt(local, { ...s, nav: 'top' }).backgroundFile, 'C:/u/bg.mp4');
  assert.equal(U.adopt(local, { ...s, nav: 'top' }).background, 'video');
});

test('text on accent picks the readable colour', () => {
  assert.equal(U.onColor('#ffe066'), '#000000');
  assert.equal(U.onColor('#1a237e'), '#ffffff');
});

test('an accent that vanishes on the surface is nudged until it reads', () => {
  const dark = '#0f1117';
  const fixed = U.readableAccent('#14161c', dark);
  assert.ok(U.contrast(fixed, dark) >= 3);
  // a good accent is left alone
  assert.equal(U.readableAccent('#4c7dff', dark), '#4c7dff');
  const light = '#ffffff';
  assert.ok(U.contrast(U.readableAccent('#fff8e0', light), light) >= 3);
});

test('cssVars: default prefs override nothing visible', () => {
  const v = U.cssVars(U.defaults(), { surface: '#0f1117' });
  assert.equal(v['--accent'], null);
  assert.equal(v['--glass-blur-k'], '1');
  assert.equal(v['--glass-alpha-k'], '1');
  assert.equal(v['--radius-k'], '1');
  assert.equal(v['--font-k'], '1');
});

test('cssVars: accent and solid glass', () => {
  const v = U.cssVars({ accent: '#ff8800', glass: { solid: true } }, { surface: '#0f1117' });
  assert.equal(v['--accent'], '#ff8800');
  assert.equal(v['--accent-rgb'], '255, 136, 0');
  assert.equal(v['--glass-blur-k'], '0');
  assert.equal(Number(v['--glass-alpha-k']) >= 1, true);
});

test('newer: last write wins, empty sides lose', () => {
  const a = { prefs: { nav: 'dock' }, at: 10 };
  const b = { prefs: { nav: 'top' }, at: 20 };
  assert.equal(U.newer(a, b), b);
  assert.equal(U.newer(b, a), b);
  assert.equal(U.newer(null, a), a);
  assert.equal(U.newer(a, { at: 99 }), a);
  assert.equal(U.newer(null, null), null);
});
