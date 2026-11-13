const test = require('node:test');
const assert = require('node:assert');
const BP = require('../src/lib/bigpicture.js');
const { parseCliArgs } = require('../src/backend/platform.js');

test('zoom gives the layout about 1280 x 720 of room', () => {
  assert.strictEqual(BP.zoomFor(1920, 1080), 1.5);
  assert.strictEqual(BP.zoomFor(2560, 1440), 2);
  assert.strictEqual(BP.zoomFor(1280, 720), 1);
  // the tighter side wins: an ultrawide is limited by its height
  assert.strictEqual(BP.zoomFor(3440, 1440), 2);
  // 16:10 is limited by its width
  assert.strictEqual(BP.zoomFor(1920, 1200), 1.5);
});

test('zoom is clamped and rounded', () => {
  assert.strictEqual(BP.zoomFor(1024, 600), 1, 'small screens never shrink the UI');
  assert.strictEqual(BP.zoomFor(7680, 4320), 2.5, '8K stops at 2.5');
  assert.strictEqual(BP.zoomFor(1366, 768), 1.05);
  assert.strictEqual(BP.zoomFor(1600, 900), 1.25);
  assert.strictEqual(BP.zoomFor(0, 0), 1);
  assert.strictEqual(BP.zoomFor(NaN, 1080), 1);
  assert.strictEqual(BP.zoomFor('1920', '1080'), 1.5);
});

test('sections map to a layout, a list and a sort', () => {
  const ids = BP.SECTIONS.map((s) => s.id);
  assert.deepStrictEqual(ids, ['home', 'library', 'active', 'finished', 'wishlist', 'activity', 'settings']);
  assert.deepStrictEqual(
    (({ view, filter, sort }) => ({ view, filter, sort }))(BP.section('home')),
    { view: 'shelf', filter: 'All', sort: 'lastPlayed' });
  assert.strictEqual(BP.section('library').view, 'poster');
  assert.strictEqual(BP.section('active').filter, 'Active');
  assert.strictEqual(BP.section('finished').filter, 'Finished');
  assert.strictEqual(BP.section('wishlist').filter, 'Want');
  assert.strictEqual(BP.section('activity').filter, 'Activity');
  assert.strictEqual(BP.section('settings').settings, true);
  assert.strictEqual(BP.section('nope').id, 'home', 'unknown ids fall back to Home');
});

test('LB / RB step through the sections and wrap, skipping Settings', () => {
  assert.strictEqual(BP.stepSection('home', 1), 'library');
  assert.strictEqual(BP.stepSection('library', 1), 'active');
  assert.strictEqual(BP.stepSection('wishlist', 1), 'activity');
  assert.strictEqual(BP.stepSection('activity', 1), 'home');
  assert.strictEqual(BP.stepSection('home', -1), 'activity');
  assert.strictEqual(BP.stepSection('active', -1), 'library');
  // from Settings (not in the cycle) it starts over from Home
  assert.strictEqual(BP.stepSection('settings', 1), 'library');
  assert.strictEqual(BP.stepSection(undefined, 1), 'library');
});

test('Back: closes the menu, lets the page handle it, goes Home, then exits', () => {
  assert.strictEqual(BP.backAction({ menuOpen: true, detail: true }), 'close-menu');
  assert.strictEqual(BP.backAction({ modalOpen: true }), 'pass');
  assert.strictEqual(BP.backAction({ spotOpen: true }), 'pass');
  assert.strictEqual(BP.backAction({ detail: true, section: 'home' }), 'pass');
  assert.strictEqual(BP.backAction({ settings: true }), 'pass');
  assert.strictEqual(BP.backAction({ section: 'library' }), 'home');
  assert.strictEqual(BP.backAction({ section: 'wishlist' }), 'home');
  assert.strictEqual(BP.backAction({ section: 'activity' }), 'home');
  assert.strictEqual(BP.backAction({ section: 'home' }), 'exit');
  assert.strictEqual(BP.backAction({}), 'exit');
});

test('starts in Big Picture with the flag or the setting', () => {
  assert.strictEqual(BP.startsIn({ flag: true, config: {} }), true);
  assert.strictEqual(BP.startsIn({ flag: false, config: { startBigPicture: true } }), true);
  assert.strictEqual(BP.startsIn({ flag: false, config: { startBigPicture: false } }), false);
  assert.strictEqual(BP.startsIn({ flag: false, config: { startBigPicture: 'yes' } }), false);
  assert.strictEqual(BP.startsIn({ flag: false, config: null }), false);
  assert.strictEqual(BP.startsIn(), false);
});

test('--bigpicture is parsed from the command line', () => {
  assert.strictEqual(parseCliArgs(['electron', '.', '--bigpicture']).bigPicture, true);
  assert.strictEqual(parseCliArgs(['GameVault.exe', '--hidden']).bigPicture, false);
  // argv[0] is the executable, never a flag
  assert.strictEqual(parseCliArgs(['--bigpicture']).bigPicture, false);
  assert.strictEqual(parseCliArgs(null).bigPicture, false);
});
