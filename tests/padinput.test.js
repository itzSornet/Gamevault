const test = require('node:test');
const assert = require('node:assert');
const { createReader, pickNext, glyphsFor, BUTTONS: B } = require('../src/lib/padinput.js');

function pad({ down = [], axes = [0, 0, 0, 0], id = 'Xbox Wireless Controller (STANDARD GAMEPAD)' } = {}) {
  const buttons = Array.from({ length: 17 }, (_, i) => ({ pressed: down.includes(i), value: down.includes(i) ? 1 : 0 }));
  return { id, connected: true, buttons, axes };
}

test('buttons fire once per press, not while held', () => {
  const r = createReader();
  assert.deepStrictEqual(r.poll([pad({ down: [B.A] })], 0).actions, ['confirm']);
  assert.deepStrictEqual(r.poll([pad({ down: [B.A] })], 16).actions, []);
  assert.deepStrictEqual(r.poll([pad()], 32).actions, []);
  assert.deepStrictEqual(r.poll([pad({ down: [B.A, B.B] })], 48).actions, ['confirm', 'back']);
  assert.deepStrictEqual(r.poll([pad({ down: [B.LB] })], 64).actions, ['prev']);
});

test('d-pad repeats after a delay, then faster', () => {
  const r = createReader({ repeatDelay: 300, repeatRate: 100 });
  const hold = pad({ down: [B.DOWN] });
  assert.deepStrictEqual(r.poll([hold], 0).actions, ['down']);
  assert.deepStrictEqual(r.poll([hold], 200).actions, []);
  assert.deepStrictEqual(r.poll([hold], 300).actions, ['down']);
  assert.deepStrictEqual(r.poll([hold], 350).actions, []);
  assert.deepStrictEqual(r.poll([hold], 400).actions, ['down']);
  r.poll([pad()], 420);
  assert.deepStrictEqual(r.poll([pad({ down: [B.RIGHT] })], 430).actions, ['right']);
});

test('left stick: dominant axis, with hysteresis', () => {
  const r = createReader();
  assert.deepStrictEqual(r.poll([pad({ axes: [0.3, 0, 0, 0] })], 0).actions, []);
  assert.deepStrictEqual(r.poll([pad({ axes: [0.8, 0.3, 0, 0] })], 16).actions, ['right']);
  // dips a bit but stays latched: no second "right"
  assert.deepStrictEqual(r.poll([pad({ axes: [0.45, 0, 0, 0] })], 32).actions, []);
  r.poll([pad({ axes: [0.1, 0, 0, 0] })], 48);
  assert.deepStrictEqual(r.poll([pad({ axes: [0, -0.9, 0, 0] })], 64).actions, ['up']);
});

test('View + Menu together = guide, never also view or menu', () => {
  const r = createReader();
  assert.deepStrictEqual(r.poll([pad({ down: [B.VIEW] })], 0).actions, []);
  assert.deepStrictEqual(r.poll([pad({ down: [B.VIEW, B.MENU] })], 16).actions, ['guide']);
  assert.deepStrictEqual(r.poll([pad({ down: [B.MENU] })], 32).actions, []);
  assert.deepStrictEqual(r.poll([pad()], 48).actions, []);
  // alone: fires on release
  r.poll([pad({ down: [B.MENU] })], 64);
  assert.deepStrictEqual(r.poll([pad()], 80).actions, ['menu']);
  r.poll([pad({ down: [B.VIEW] })], 96);
  assert.deepStrictEqual(r.poll([pad()], 112).actions, ['view']);
});

test('right stick scrolls; no pads means nothing', () => {
  const r = createReader();
  const out = r.poll([pad({ axes: [0, 0, 0, 1] })], 0);
  assert.strictEqual(out.scroll.y, 1);
  assert.strictEqual(r.poll([pad({ axes: [0, 0, 0, 0.1] })], 16).scroll.y, 0);
  const none = r.poll([null, null], 32);
  assert.deepStrictEqual(none.actions, []);
  assert.strictEqual(none.active, false);
});

test('glyphs and name come from the pad id', () => {
  assert.strictEqual(glyphsFor('DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)'), 'ps');
  assert.strictEqual(glyphsFor('Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 09cc)'), 'ps');
  assert.strictEqual(glyphsFor('Xbox 360 Controller (XInput STANDARD GAMEPAD)'), 'xbox');
  assert.strictEqual(glyphsFor('Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)'), 'xbox');
  const r = createReader();
  const out = r.poll([pad({ down: [B.A], id: 'DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)' })], 0);
  assert.strictEqual(out.glyphs, 'ps');
  assert.strictEqual(out.name, 'DualSense Wireless Controller');
});

// --------------------------------------------------------- spatial picking

const R = (left, top, width = 100, height = 100) => ({ left, top, width, height });

test('pickNext: same row beats a closer item on another row', () => {
  const from = R(0, 0);
  const sameRow = { id: 'same', rect: R(300, 10) };
  const nearDiag = { id: 'diag', rect: R(120, 140) };
  assert.strictEqual(pickNext(from, [nearDiag, sameRow], 'right').id, 'same');
});

test('pickNext: grid moves go to the neighbour, not past it', () => {
  // 3x2 grid
  const cells = [];
  for (let row = 0; row < 2; row++) for (let col = 0; col < 3; col++) cells.push({ id: `${row}${col}`, rect: R(col * 120, row * 120) });
  const at = (id) => cells.find((c) => c.id === id).rect;
  assert.strictEqual(pickNext(at('00'), cells, 'right').id, '01');
  assert.strictEqual(pickNext(at('01'), cells, 'down').id, '11');
  assert.strictEqual(pickNext(at('12'), cells, 'left').id, '11');
  assert.strictEqual(pickNext(at('11'), cells, 'up').id, '01');
  assert.strictEqual(pickNext(at('02'), cells, 'right'), null);
  assert.strictEqual(pickNext(at('00'), cells, 'up'), null);
});

test('pickNext: a wide bar above is reachable from any column', () => {
  const bar = { id: 'bar', rect: R(0, 0, 600, 40) };
  const tile = R(450, 200);
  const other = { id: 'other', rect: R(0, 200) };
  assert.strictEqual(pickNext(tile, [bar, other], 'up').id, 'bar');
});

test('pickNext: sidebar to the left is found from content', () => {
  const side = [{ id: 's1', rect: R(0, 0, 200, 40) }, { id: 's2', rect: R(0, 60, 200, 40) }, { id: 's3', rect: R(0, 500, 200, 40) }];
  assert.strictEqual(pickNext(R(400, 70, 100, 30), side, 'left').id, 's2');
});

test('stick clicks: left folds the sidebar, right jumps to the top', () => {
  const r = createReader();
  assert.deepStrictEqual(r.poll([pad({ down: [B.LS] })], 0).actions, ['sidebar']);
  assert.deepStrictEqual(r.poll([pad({ down: [B.LS] })], 16).actions, []);
  assert.deepStrictEqual(r.poll([pad({ down: [B.RS] })], 32).actions, ['top']);
});
