// Plain-Node tests for library-merge.js and cloud.js: node tests/cloud.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { mergeLibrary, strip } = require('../src/backend/library-merge.js');
const { createCloud, pack, unpack, encrypt, decrypt, safeJoin, listFiles } = require('../src/backend/cloud.js');

const T = 1_800_000_000_000;

// ------------------------------------------------------------ merge
{
  // strip keeps no paths, no local art, no transient fields
  const s = strip({ id: 1, name: 'A', exePath: 'C:\\a.exe', installDir: 'C:\\a', saveDir: 'C:\\s', _cover: 'x', coverUrl: 'file:///c.jpg', heroUrl: 'https://h', hours: 2 });
  assert.deepStrictEqual(s, { id: '1', name: 'A', heroUrl: 'https://h', hours: 2 });

  // first sync: nothing remote -> upload everything
  const a = { id: 'a', name: 'Alpha', hours: 1, sessions: [], exePath: 'C:\\alpha.exe', added: T - 100 };
  let r = mergeLibrary({ local: [a], remote: null, base: {}, now: T });
  assert.strictEqual(r.upload.games.length, 1);
  assert.ok(!('exePath' in r.upload.games[0]));
  const base1 = r.base;

  // second PC: gets Alpha without paths, keeps its own Beta
  const b = { id: 'b', name: 'Beta', hours: 0, sessions: [] };
  r = mergeLibrary({ local: [b], remote: r.upload, base: {}, now: T + 1 });
  assert.deepStrictEqual(r.games.map((g) => g.id).sort(), ['a', 'b']);
  assert.strictEqual(r.stats.added, 1);
  const remote2 = r.upload;

  // back on PC 1: Beta arrives; Alpha keeps its exePath
  r = mergeLibrary({ local: [a], remote: remote2, base: base1, now: T + 2 });
  const alpha = r.games.find((g) => g.id === 'a');
  assert.strictEqual(alpha.exePath, 'C:\\alpha.exe');
  assert.ok(r.games.find((g) => g.id === 'b'));
  const base2 = r.base;
  const remote3 = r.upload;

  // playtime on both PCs: max hours, union sessions
  const localA = { ...alpha, hours: 5, sessions: [{ start: 1, end: 2 }] };
  const remoteA = { ...strip(alpha), hours: 3, sessions: [{ start: 3, end: 4 }], status: 'Finished' };
  r = mergeLibrary({ local: [localA, r.games.find((g) => g.id === 'b')], remote: { games: [remoteA, remote3.games.find((g) => g.id === 'b')], tombstones: {} }, base: base2, now: T + 3 });
  const m = r.games.find((g) => g.id === 'a');
  assert.strictEqual(m.hours, 5);
  assert.strictEqual(m.sessions.length, 2);
  assert.strictEqual(m.status, 'Finished', 'remote-only field change kept');
  assert.strictEqual(m.exePath, 'C:\\alpha.exe');

  // playtime set by hand: the newer manual edit wins even when it is lower
  {
    const lo = { id: 'h', name: 'Hand', hours: 2, hoursSetAt: T + 10, sessions: [] };
    const hi = { id: 'h', name: 'Hand', hours: 40, sessions: [] };
    let rr = mergeLibrary({ local: [lo], remote: { games: [hi], tombstones: {} }, base: {}, now: T + 11 });
    assert.strictEqual(rr.games[0].hours, 2);
    rr = mergeLibrary({ local: [hi], remote: { games: [lo], tombstones: {} }, base: {}, now: T + 11 });
    assert.strictEqual(rr.games[0].hours, 2, 'remote manual edit reaches this PC');
    assert.strictEqual(rr.games[0].hoursSetAt, T + 10);
  }

  // remote-only edit wins when local is unchanged since the last sync
  const synced = r.games;
  const baseS = r.base;
  const remoteEdited = { games: r.upload.games.map((g) => (g.id === 'b' ? { ...g, name: 'Beta (renamed)' } : g)), tombstones: {} };
  r = mergeLibrary({ local: synced, remote: remoteEdited, base: baseS, now: T + 4 });
  assert.strictEqual(r.games.find((g) => g.id === 'b').name, 'Beta (renamed)');

  // deleted here -> tombstone uploaded
  const baseD = r.base;
  r = mergeLibrary({ local: r.games.filter((g) => g.id !== 'b'), remote: r.upload, base: baseD, now: T + 5 });
  assert.ok(r.upload.tombstones.b);
  assert.ok(!r.upload.games.find((g) => g.id === 'b'));

  // other PC sees the tombstone and drops Beta
  const other = [{ id: 'a', name: 'Alpha', hours: 5, sessions: [] }, { id: 'b', name: 'Beta (renamed)', hours: 0, sessions: [] }];
  const otherBase = Object.fromEntries(other.map((g) => [g.id, 'x']));
  const r2 = mergeLibrary({ local: other, remote: r.upload, base: otherBase, now: T + 6 });
  assert.ok(!r2.games.find((g) => g.id === 'b'));
  assert.strictEqual(r2.stats.removed, 1);

  // same game added on two PCs with different ids folds into one, smaller id wins
  const pc1 = [{ id: 'z9', name: 'Hades', steamAppId: 1145360, hours: 2, sessions: [], exePath: 'C:\\h.exe' }];
  const cloudCopy = { games: [{ id: 'k1', name: 'Hades', steamAppId: 1145360, hours: 4, sessions: [] }], tombstones: {} };
  const r3 = mergeLibrary({ local: pc1, remote: cloudCopy, base: {}, now: T });
  assert.strictEqual(r3.games.length, 1);
  assert.strictEqual(r3.games[0].id, 'k1');
  assert.strictEqual(r3.games[0].hours, 4);
  assert.strictEqual(r3.games[0].exePath, 'C:\\h.exe');
  assert.ok(r3.upload.tombstones.z9);
}

// ------------------------------------------------------------ archive + crypto
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gv-saves-'));
  fs.mkdirSync(path.join(dir, 'slot1'));
  fs.writeFileSync(path.join(dir, 'slot1', 'save.dat'), crypto.randomBytes(5000));
  fs.writeFileSync(path.join(dir, 'settings.ini'), 'volume=7');
  const { files } = listFiles(dir);
  assert.deepStrictEqual(files.map((f) => f.p), ['settings.ini', 'slot1/save.dat']);
  const key = crypto.randomBytes(32);
  const blob = encrypt(zlib.gzipSync(pack(files)), key);
  const back = unpack(zlib.gunzipSync(decrypt(blob, key)));
  assert.strictEqual(back[0].data.toString(), 'volume=7');
  assert.ok(back[1].data.equals(fs.readFileSync(path.join(dir, 'slot1', 'save.dat'))));
  assert.throws(() => decrypt(blob, crypto.randomBytes(32)), /can’t be opened/);
  const tampered = Buffer.from(blob); tampered[tampered.length - 1] ^= 1;
  assert.throws(() => decrypt(tampered, key));

  assert.ok(safeJoin(dir, 'slot1/save.dat'));
  for (const bad of ['../x', 'a/../../x', '/abs', 'C:/x', 'a//b', '', 'a/.']) assert.strictEqual(safeJoin(dir, bad), null, bad);
  fs.rmSync(dir, { recursive: true, force: true });
}

// ------------------------------------------------------------ cloud against a fake backend
(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gv-cloud-'));
  const saveDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gv-sd-'));
  fs.writeFileSync(path.join(saveDir, 'a.sav'), 'one');
  const db = { library: null, keys: null, backups: [], objects: new Map() };
  let clock = T;
  const resp = (status, body) => ({ ok: status < 400, status, json: async () => body, text: async () => (body == null ? '' : JSON.stringify(body)), arrayBuffer: async () => body });
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    const p = u.pathname;
    const body = init.body && !Buffer.isBuffer(init.body) ? JSON.parse(init.body) : init.body;
    if (p === '/rest/v1/library_sync') {
      if (init.method === 'GET') return resp(200, db.library ? [db.library] : []);
      if (init.method === 'POST') { if (db.library) return resp(409, { message: 'dup' }); db.library = { data: body.data, version: 1 }; return resp(201, null); }
      if (init.method === 'PATCH') {
        const v = Number(u.searchParams.get('version').slice(3));
        if (!db.library || db.library.version !== v) return resp(200, []);
        db.library = { data: body.data, version: body.version };
        return resp(200, [db.library]);
      }
    }
    if (p === '/rest/v1/cloud_keys') {
      if (init.method === 'GET') return resp(200, db.keys ? [{ save_key: db.keys }] : []);
      db.keys = body.save_key; return resp(201, null);
    }
    if (p === '/rest/v1/save_backups') {
      if (init.method === 'POST') { const row = { ...body, id: crypto.randomUUID(), created_at: new Date(clock).toISOString() }; db.backups.push(row); return resp(201, [row]); }
      if (init.method === 'GET') {
        const id = u.searchParams.get('id');
        let rows = db.backups;
        if (id) rows = rows.filter((r) => `eq.${r.id}` === id);
        return resp(200, [...rows].sort((x, y) => (x.created_at < y.created_at ? 1 : -1)));
      }
      if (init.method === 'DELETE') { const id = u.searchParams.get('id').slice(3); db.backups = db.backups.filter((r) => r.id !== id); return resp(204, null); }
    }
    if (p.startsWith('/storage/v1/object/saves/') && init.method === 'POST') { db.objects.set(p.slice('/storage/v1/object/saves/'.length), init.body); return resp(200, {}); }
    if (p === '/storage/v1/object/saves' && init.method === 'DELETE') { for (const k of body.prefixes) db.objects.delete(k); return resp(200, []); }
    if (p.startsWith('/storage/v1/object/authenticated/saves/')) {
      const b = db.objects.get(p.slice('/storage/v1/object/authenticated/saves/'.length));
      return b ? resp(200, b.buffer.slice(b.byteOffset, b.byteOffset + b.length)) : resp(404, { message: 'nf' });
    }
    return resp(404, { message: `no route ${init.method} ${p}` });
  };
  const account = { token: async () => 'tok', status: () => ({ signedIn: true, user: { id: 'user-1' } }) };
  const cloud = createCloud({ dir, cloudUrl: 'https://x', anonKey: 'pk', account, fetch, now: () => clock });

  const s1 = await cloud.syncLibrary([{ id: 'a', name: 'Alpha', hours: 1, sessions: [], exePath: 'C:\\a.exe' }]);
  assert.strictEqual(s1.uploaded, true);
  assert.strictEqual(db.library.data.games[0].exePath, undefined);
  const s2 = await cloud.syncLibrary(s1.games);
  assert.strictEqual(s2.uploaded, false, 'no-op sync uploads nothing');
  assert.ok(cloud.lastSync());

  // backups: upload, skip unchanged, keep 3, restore with safety copy
  const b1 = await cloud.backupSaves({ gameId: 'a', gameName: 'Alpha', saveDir });
  assert.ok(b1.backup && db.objects.size === 1);
  assert.ok(!db.objects.values().next().value.includes(Buffer.from('one')), 'uploaded bytes are encrypted');
  assert.deepStrictEqual(await cloud.backupSaves({ gameId: 'a', gameName: 'Alpha', saveDir }), { skipped: true });
  for (let i = 0; i < 4; i++) { clock += 1000; fs.writeFileSync(path.join(saveDir, 'a.sav'), `v${i}`); await cloud.backupSaves({ gameId: 'a', gameName: 'Alpha', saveDir }); }
  assert.strictEqual(db.backups.length, 3);
  assert.strictEqual(db.objects.size, 3);
  const list = await cloud.listBackups('a');
  const oldest = list[list.length - 1];
  clock += 1000;
  const res = await cloud.restoreBackup({ gameId: 'a', backupId: oldest.id, saveDir });
  assert.strictEqual(fs.readFileSync(path.join(saveDir, 'a.sav'), 'utf8'), 'v1');
  assert.strictEqual(fs.readFileSync(path.join(res.safety, 'a.sav'), 'utf8'), 'v3', 'old files copied aside');
  await cloud.deleteBackup(oldest.id);
  assert.strictEqual(db.backups.length, 2);

  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(saveDir, { recursive: true, force: true });
  console.log('cloud tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
