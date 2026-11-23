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
  const ui = { ...U.defaults(), nav: 'dock', dockPos: 'bottom', search: 'hidden', accent: '#ff8800', tint: 30, glass: { blur: 150, opacity: 80, saturation: 120, solid: false } };
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
  assert.equal(U.zoom(U.defaults()), 1);
});

test('size, shelf size and motion', () => {
  assert.equal(U.zoom({ fontScale: 110 }), 1.1);
  assert.equal(U.zoom({ fontScale: 400 }), 1.2);
  assert.equal(U.normalize({ shelfSize: 'huge' }).shelfSize, 'medium');
  const a = U.attrs({ shelfSize: 'large', motion: 'off', density: 'compact', showRatings: false });
  assert.equal(a.shelfSize, 'large');
  assert.equal(a.motion, 'off');
  assert.equal(a.density, 'compact');
  assert.equal(a.cardRatings, '0');
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

test('tintVars leans the palette toward the accent and keeps each format', () => {
  const base = { '--surface': '#0f1117', '--main-glass': '6, 7, 10', '--bg': 'nonsense' };
  const off = U.tintVars(base, '#ff0000', 0);
  assert.equal(off['--surface'], null);
  const on = U.tintVars(base, '#ff0000', 100);
  assert.match(on['--surface'], /^#[0-9a-f]{6}$/);
  assert.notEqual(on['--surface'], '#0f1117');
  assert.match(on['--main-glass'], /^\d+, \d+, \d+$/);
  const [r, g] = on['--main-glass'].split(', ').map(Number);
  assert.ok(r > 6 && g <= 7, 'red goes up, green does not');
  assert.equal(on['--bg'], null, 'unreadable values are left alone');
  assert.equal(U.tintVars(base, null, 100)['--surface'], null);
});

test('a custom accent recolours the fluid and is flagged for CSS', () => {
  const v = U.cssVars({ accent: '#22b8e6' }, { surface: '#0f1117' });
  assert.equal(v['--wave-1'], v['--accent-rgb']);
  assert.equal(U.attrs({ accent: '#22b8e6' }).customAccent, '1');
  assert.equal(U.attrs({}).customAccent, '0');
  assert.equal(U.cssVars({}, {})['--wave-1'], null);
  assert.ok(U.ACCENTS.length >= 8 && U.ACCENTS.every(([h]) => /^#[0-9a-f]{6}$/.test(h)));
});

test('presets: keep colours, size and motion; presetOf finds them', () => {
  const mine = { accent: '#ff0000', tint: 30, fontScale: 110, motion: 'reduced', nav: 'top', backgroundFile: 'C:/bg.png', backgroundKind: 'image', background: 'image' };
  const d = U.applyPreset(mine, 'dock');
  assert.equal(d.nav, 'dock');
  assert.equal(d.accent, '#ff0000');
  assert.equal(d.tint, 30);
  assert.equal(d.fontScale, 110);
  assert.equal(d.motion, 'reduced');
  assert.equal(d.background, 'image');
  assert.equal(U.presetOf(d), 'dock');
  assert.equal(U.presetOf(U.defaults()), 'default');
  assert.equal(U.presetOf({ ...d, density: 'compact' }), null);
  const g = U.applyPreset(U.defaults(), 'glass');
  assert.equal(g.glass.blur, 180);
  assert.equal(g.glass.solid, false);
  assert.equal(U.applyPreset(mine, 'nope').nav, 'top');
  for (const p of U.PRESETS) assert.equal(U.presetOf(U.applyPreset(U.defaults(), p.id)), p.id);
});

test('share a look: round trip, no paths, bad input', () => {
  const ui = { nav: 'dock', accent: '#14b8a6', radius: 2, background: 'image', backgroundFile: 'C:/secret/me.png', backgroundKind: 'image' };
  const text = U.exportLook(ui, 'ocean');
  assert.ok(!text.includes('secret'));
  assert.ok(!text.includes('backgroundFile'));
  const back = U.importLook(text, {}, ['midnight', 'ocean']);
  assert.equal(back.palette, 'ocean');
  assert.equal(back.ui.nav, 'dock');
  assert.equal(back.ui.accent, '#14b8a6');
  assert.equal(back.ui.background, 'fluid'); // no file on this PC
  const withFile = U.importLook(text, { backgroundFile: 'D:/mine.mp4', backgroundKind: 'video' }, ['ocean']);
  assert.equal(withFile.ui.backgroundFile, 'D:/mine.mp4');
  assert.equal(withFile.ui.background, 'image');
  assert.equal(U.importLook('```' + text + '```', {}, []).palette, null);
  assert.equal(U.importLook('{"nav":"dock"}', {}, []), null);
  assert.equal(U.importLook('hello', {}, []), null);
  assert.equal(U.importLook('x'.repeat(9000), {}, []), null);
  assert.equal(U.importLook('{"gamevault-look":1,"ui":{"nav":"hologram","tint":900}}', {}, []).ui.nav, 'sidebar');
  assert.equal(U.exportLook(U.defaults(), 'midnight'), '{"gamevault-look":1,"palette":"midnight","ui":{}}');
});

test('the dock runs along the bottom only (an old top dock comes back as bottom)', () => {
  assert.equal(U.normalize({ nav: 'dock', dockPos: 'top' }).dockPos, 'bottom');
});

test('search in the navigation needs a navigation with room for it', () => {
  assert.equal(U.normalize({ nav: 'sidebar', search: 'in-nav' }).search, 'in-nav');
  assert.equal(U.normalize({ nav: 'dock', search: 'in-nav' }).search, 'in-nav');
  assert.equal(U.normalize({ nav: 'top', search: 'in-nav' }).search, 'top-center');
  assert.equal(U.normalize({ nav: 'none', search: 'in-nav' }).search, 'top-center');
});

test('corners: sharp squares the pills too, round is clearly round', () => {
  const sharp = U.cssVars({ radius: 0 });
  const round = U.cssVars({ radius: 2 });
  assert.ok(Number(sharp['--radius-k']) <= 0.15);
  assert.equal(sharp['--pill-r'], '3px');
  assert.equal(U.cssVars({ radius: 1 })['--pill-r'], null);
  assert.ok(Number(round['--radius-k']) >= 1.8);
});

test('the main panel thins faster than the small glass as opacity drops', () => {
  const v = U.cssVars({ glass: { opacity: 50 } });
  assert.ok(Number(v['--main-alpha-k']) < Number(v['--glass-alpha-k']));
  assert.equal(U.cssVars({})['--main-alpha-k'], '1');
  assert.equal(U.cssVars({ glass: { solid: true } })['--main-alpha-k'], '4');
});
