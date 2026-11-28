// Plain-Node tests for save-roots.js and restores that land in another account's
// save folder (local-saves.js uses the same restore path as the cloud):
// node tests/save-roots.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { describeSaveDir, idKind, resolveRestoreTarget, steamAccounts, localize } = require('../src/backend/save-roots.js');
const { createLocalSaves } = require('../src/backend/local-saves.js');
const { pack, unpack } = require('../src/backend/cloud.js');

const A = '76561199642931604'; // the ID the saves were made under
const B = '76561199761766476'; // another Steam account on the new PC
const old = (ms) => new Date(Date.now() - ms);

function write(file, text, ageMs = 0) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  if (ageMs) fs.utimesSync(file, old(ageMs), old(ageMs));
}

function ageAll(dir, ageMs) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) ageAll(full, ageMs); else fs.utimesSync(full, old(ageMs), old(ageMs));
  }
}

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gv-roots-'));
  try {
    // ---- names
    assert.strictEqual(idKind(A), 'steam64');
    assert.strictEqual(idKind('1801500748'), null, 'a plain number is not an ID by itself');
    assert.strictEqual(idKind('1801500748', { accounts: ['1801500748'] }), 'account');
    assert.strictEqual(idKind('1801500749', { kind: 'account' }), 'account', 'any account number once the kind is known');
    assert.strictEqual(idKind('3f2504e0-4f89-11d3-9a0c-0305e82c3301'), 'uuid');
    assert.strictEqual(idKind('2024'), null);
    assert.strictEqual(idKind('slot1'), null);

    const steam = path.join(root, 'Steam');
    fs.mkdirSync(path.join(steam, 'userdata', '1801500748'), { recursive: true });
    fs.mkdirSync(path.join(steam, 'userdata', '0'), { recursive: true });
    assert.deepStrictEqual(steamAccounts(steam), ['1801500748']);
    assert.deepStrictEqual(steamAccounts(null), []);

    const d = describeSaveDir('C:\\Games\\PBZ\\Saved\\SaveGames\\Steam\\' + A, { installDir: 'C:\\Games\\PBZ', home: 'C:\\Users\\a' });
    assert.strictEqual(d.id, A);
    assert.strictEqual(d.kind, 'steam64');
    assert.deepStrictEqual(d.head, ['C:', 'Games', 'PBZ', 'Saved', 'SaveGames', 'Steam']);
    assert.deepStrictEqual(d.tail, []);
    const deep = describeSaveDir('C:\\U\\savegames\\3f2504e0-4f89-11d3-9a0c-0305e82c3301\\1234');
    assert.strictEqual(deep.kind, 'uuid');
    assert.deepStrictEqual(deep.tail, ['1234']);
    assert.strictEqual(describeSaveDir('C:\\Users\\a\\Saved Games\\Game').id, undefined, 'no ID in the path');

    // a path from the other PC, moved to this game's install folder / this profile
    assert.deepStrictEqual(
      localize('C:\\Games\\PBZ\\Saved', { installDir: 'C:\\Games\\PBZ', home: 'C:\\Users\\a' }, { installDir: 'D:\\Lib\\PBZ', home: 'C:\\Users\\b' }),
      [path.join('D:\\', 'Lib', 'PBZ', 'Saved'), 'C:\\Games\\PBZ\\Saved']);
    assert.deepStrictEqual(
      localize('C:\\Users\\a\\AppData\\Local\\G', { home: 'C:\\Users\\a' }, { home: 'E:\\Home\\b' })[0], path.join('E:\\', 'Home', 'b', 'AppData', 'Local', 'G'));

    // ---- the archive keeps where the saves were; older archives have none
    {
      const f = path.join(root, 'one.sav');
      write(f, 'x');
      const files = [{ p: 'one.sav', size: 1, mtime: 1, full: f }];
      assert.deepStrictEqual(unpack(pack(files, d)).source, d);
      assert.strictEqual(unpack(pack(files)).source, null);
      assert.strictEqual(unpack(pack(files))[0].data.toString(), 'x');
    }

    // ---- restores, on disk: the backup was made on PC 1 under ID A
    const pc1 = path.join(root, 'pc1', 'PBZ');
    const src1 = path.join(pc1, 'Saved', 'SaveGames', 'Steam', A);
    write(path.join(src1, 'slot0.sav'), 'chapter 7');
    write(path.join(src1, 'Profile', 'settings.sav'), 'fov=90');
    const ls = createLocalSaves({ dir: path.join(root, 'copies'), device: 'PC 1' });
    await ls.backupSaves({ gameId: 'pbz', gameName: 'PBZ', saveDir: src1, installDir: pc1 });
    const [backup] = ls.listBackups('pbz');
    assert.ok(backup);

    // PC 2: the game is installed elsewhere and saves under ID B
    const pc2 = path.join(root, 'pc2', 'Lib', 'PBZ');
    const steamDir2 = path.join(pc2, 'Saved', 'SaveGames', 'Steam');
    const b = path.join(steamDir2, B);
    write(path.join(b, 'slot0.sav'), 'new game', 3_600_000);
    const read = (dir) => fs.readFileSync(path.join(dir, 'slot0.sav'), 'utf8');

    // 1) backup under ID A, restored by picking ID B's folder: written into B, as it is
    let r = await ls.restoreBackup({ gameId: 'pbz', backupId: backup.id, saveDir: b });
    assert.strictEqual(r.target, b);
    assert.strictEqual(read(b), 'chapter 7');
    assert.strictEqual(fs.readFileSync(path.join(b, 'Profile', 'settings.sav'), 'utf8'), 'fov=90');
    assert.ok(r.safety && fs.readFileSync(path.join(r.safety, 'slot0.sav'), 'utf8') === 'new game', 'the saves it replaced are kept');
    assert.ok(!fs.existsSync(path.join(steamDir2, A)), 'no folder for the old ID is made');

    // 2) the parent folder picked by mistake ("Steam", or "SaveGames" above it): into B, not one level up
    write(path.join(b, 'slot0.sav'), 'new game', 3_600_000);
    r = await ls.restoreBackup({ gameId: 'pbz', backupId: backup.id, saveDir: steamDir2 });
    assert.strictEqual(r.target, b);
    assert.strictEqual(read(b), 'chapter 7');
    assert.ok(!fs.existsSync(path.join(steamDir2, 'slot0.sav')), 'nothing lands in the parent');
    write(path.join(b, 'slot0.sav'), 'new game', 3_600_000);
    r = await ls.restoreBackup({ gameId: 'pbz', backupId: backup.id, saveDir: path.dirname(steamDir2) });
    assert.strictEqual(r.target, b);
    assert.ok(!fs.existsSync(path.join(path.dirname(steamDir2), 'slot0.sav')));

    // 3) several ID folders: the clearly newest is used; when none is, it asks and writes nothing
    const c = path.join(steamDir2, '76561198000000001');
    write(path.join(c, 'slot0.sav'), 'family member', 3 * 86_400_000);
    write(path.join(b, 'slot0.sav'), 'new game', 3_600_000);
    r = await ls.restoreBackup({ gameId: 'pbz', backupId: backup.id, saveDir: steamDir2 });
    assert.strictEqual(r.target, b, 'the folder in use (newest by far)');
    write(path.join(b, 'slot0.sav'), 'new game');
    ageAll(b, 3 * 86_400_000);
    r = await ls.restoreBackup({ gameId: 'pbz', backupId: backup.id, saveDir: steamDir2 });
    assert.strictEqual(r.pending, 'choose');
    assert.deepStrictEqual(r.choices.map((x) => x.path).sort(), [b, c].sort());
    assert.strictEqual(read(b), 'new game', 'nothing written while asking');
    assert.strictEqual(read(c), 'family member');
    r = await ls.restoreBackup({ gameId: 'pbz', backupId: backup.id, saveDir: c, exact: true });
    assert.strictEqual(r.target, c);
    assert.strictEqual(read(c), 'chapter 7');
    fs.rmSync(c, { recursive: true, force: true });

    // no save folder set on PC 2: found from where the backup came from (moved install folder)
    write(path.join(b, 'slot0.sav'), 'new game', 3_600_000);
    r = await ls.restoreBackup({ gameId: 'pbz', backupId: backup.id, saveDir: null, installDir: pc2 });
    assert.strictEqual(r.target, b);
    assert.strictEqual(read(b), 'chapter 7');
    // …and the game hasn't made its folder yet: it asks, saying where the backup came from
    fs.renameSync(pc1, pc1 + '-elsewhere'); // PC 1's own folders aren't on PC 2
    r = await ls.restoreBackup({ gameId: 'pbz', backupId: backup.id, saveDir: null, installDir: path.join(root, 'nowhere') });
    assert.strictEqual(r.pending, 'folder');
    assert.strictEqual(r.source, src1);
    // the game folder is there but no ID folder yet: the same ID as before
    fs.rmSync(b, { recursive: true, force: true });
    r = await ls.restoreBackup({ gameId: 'pbz', backupId: backup.id, saveDir: null, installDir: pc2 });
    assert.strictEqual(r.target, path.join(steamDir2, A));
    assert.strictEqual(read(path.join(steamDir2, A)), 'chapter 7');

    // 4) no ID in the path: unchanged, written where it's pointed
    const plain = path.join(root, 'pc1', 'Plain', 'Saves');
    write(path.join(plain, 'save.dat'), 'level 3');
    await ls.backupSaves({ gameId: 'plain', saveDir: plain });
    const [pb] = ls.listBackups('plain');
    const plain2 = path.join(root, 'pc2', 'Plain', 'Saves');
    fs.mkdirSync(plain2, { recursive: true });
    r = await ls.restoreBackup({ gameId: 'plain', backupId: pb.id, saveDir: plain2 });
    assert.strictEqual(r.target, plain2);
    assert.strictEqual(fs.readFileSync(path.join(plain2, 'save.dat'), 'utf8'), 'level 3');
    r = await ls.restoreBackup({ gameId: 'plain', backupId: pb.id, saveDir: null });
    assert.strictEqual(r.target, plain, 'no folder set: the same path, when it is on this PC');

    // 5) the short account-ID form (Steam\userdata number)
    const acc1 = path.join(root, 'pc1', 'Acct', 'saves', '1801500748');
    write(path.join(acc1, 'game.sav'), 'boss 4');
    await ls.backupSaves({ gameId: 'acct', saveDir: acc1, accounts: ['1801500748'] });
    const [ab] = ls.listBackups('acct');
    const accParent = path.join(root, 'pc2', 'Acct', 'saves');
    const acc2 = path.join(accParent, '22202');
    write(path.join(acc2, 'game.sav'), 'start', 3_600_000);
    r = await ls.restoreBackup({ gameId: 'acct', backupId: ab.id, saveDir: accParent });
    assert.strictEqual(r.target, acc2);
    assert.strictEqual(fs.readFileSync(path.join(acc2, 'game.sav'), 'utf8'), 'boss 4');

    // an older backup (no record of where it came from), parent folder picked: into the one ID folder
    const legacy = path.join(root, 'pc2', 'Legacy', 'Steam');
    write(path.join(legacy, B, 'x.sav'), 'old', 3_600_000);
    assert.deepStrictEqual(resolveRestoreTarget({ chosen: legacy, source: null, topNames: ['x.sav'] }), { target: path.join(legacy, B) });
    assert.deepStrictEqual(resolveRestoreTarget({ chosen: legacy, source: null, topNames: [B] }), { target: legacy }, 'the backup itself holds the ID folder');
    assert.deepStrictEqual(resolveRestoreTarget({ chosen: null, source: null }), { pending: 'folder' });

    // a folder inside the ID folder (Ubisoft: savegames\<uuid>\<game>)
    const u = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
    const usrc = describeSaveDir(`C:\\Ubi\\savegames\\${u}\\1234`);
    const uroot = path.join(root, 'ubi', 'savegames', '9a2504e0-4f89-11d3-9a0c-0305e82c3302');
    assert.deepStrictEqual(resolveRestoreTarget({ chosen: uroot, source: usrc }), { target: path.join(uroot, '1234') });
    assert.deepStrictEqual(resolveRestoreTarget({ chosen: path.join(uroot, '1234'), source: usrc }), { target: path.join(uroot, '1234') });

    console.log('save-roots: ok');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch((e) => { console.error(e); process.exit(1); });
