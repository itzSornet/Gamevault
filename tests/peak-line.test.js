const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createPeakLines, keyOf } = require('../src/backend/peak-line.js');

function setup(reply) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gvpl-')), 'peak-lines.json');
  const calls = [];
  let t = 1000;
  const lines = createPeakLines({
    file, cloudUrl: 'https://x.supabase.co', anonKey: 'pk', token: async () => 'tok', now: () => t,
    fetch: async (url, init) => {
      const body = JSON.parse(init.body);
      calls.push({ url, body });
      return reply(body);
    },
  });
  return { lines, calls, tick: (ms) => { t += ms; } };
}
const ok = (lines) => ({ status: 200, json: async () => ({ ok: true, data: { lines } }) });
const GID = '018d937f-1212-7232-b23f-a046f6fd4a57';

test('keys: Steam AppID first, else the IsThereAnyDeal id', () => {
  assert.strictEqual(keyOf({ steamAppId: 730, itadId: GID }), 'steam:730');
  assert.strictEqual(keyOf({ itadId: GID.toUpperCase() }), `itad:${GID}`);
  assert.strictEqual(keyOf({ itadId: 'nope' }), '');
});

const L = (line, extra = {}) => ({ line, by: null, score: null, final: true, ...extra });

test('asks the cloud once, then answers from disk', async () => {
  const { lines, calls } = setup(() => ok({ 'steam:730': L('A line.', { by: 'IGN', score: 97 }), [`itad:${GID}`]: L(null) }));
  const a = await lines.get([{ steamAppId: 730 }, { itadId: GID }, {}]);
  assert.deepStrictEqual(a, { ok: true, data: { 'steam:730': { line: 'A line.', by: 'IGN', score: 97 }, [`itad:${GID}`]: null } });
  assert.match(calls[0].url, /\/functions\/v1\/peak-line$/);
  assert.deepStrictEqual(calls[0].body, { games: [{ steamAppId: 730 }, { itadId: GID }] });
  await lines.get([{ steamAppId: 730 }]);
  assert.strictEqual(calls.length, 1);
});

test('a game with no line is asked again after a day, a final line is kept', async () => {
  const { lines, calls, tick } = setup(() => ok({ 'steam:730': L('A line.'), 'steam:1': L(null) }));
  await lines.get([{ steamAppId: 730 }, { steamAppId: 1 }]);
  tick(25 * 3600 * 1000);
  await lines.get([{ steamAppId: 730 }, { steamAppId: 1 }]);
  assert.deepStrictEqual(calls[1].body, { games: [{ steamAppId: 1 }] });
});

test('a stand-in line shows now and is replaced the next day', async () => {
  let reply = { 'steam:730': L('Our own line.', { final: false }) };
  const { lines, calls, tick } = setup(() => ok(reply));
  const a = await lines.get([{ steamAppId: 730 }]);
  assert.strictEqual(a.data['steam:730'].line, 'Our own line.');
  await lines.get([{ steamAppId: 730 }]);
  assert.strictEqual(calls.length, 1);
  tick(25 * 3600 * 1000);
  reply = { 'steam:730': L('A critic said this.', { by: 'IGN', score: 97 }) };
  const b = await lines.get([{ steamAppId: 730 }]);
  assert.strictEqual(calls.length, 2);
  assert.deepStrictEqual(b.data['steam:730'], { line: 'A critic said this.', by: 'IGN', score: 97 });
});

test('offline: a clear error, nothing saved', async () => {
  const { lines } = setup(() => { throw new Error('offline'); });
  const res = await lines.get([{ steamAppId: 730 }]);
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.error.code, 'NETWORK');
});
