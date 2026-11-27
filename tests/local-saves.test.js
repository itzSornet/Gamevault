// Plain-Node tests for local-saves.js (save copies kept on this PC): node tests/local-saves.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createLocalSaves } = require('../src/backend/local-saves.js');

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gv-lsaves-'));
  try {
    const saveDir = path.join(root, 'My Game', 'Saves');
    fs.mkdirSync(path.join(saveDir, 'slot 1'), { recursive: true });
    fs.writeFileSync(path.join(saveDir, 'slot 1', 'save.dat'), 'level 3');
    fs.writeFileSync(path.join(saveDir, 'settings.ini'), 'volume=5');
    let t = 1_800_000_000_000;
    const ls = createLocalSaves({ dir: path.join(root, 'copies'), device: 'Test PC', now: () => (t += 1000) });

    // nothing yet
    assert.deepStrictEqual(ls.listBackups('g1'), []);
    assert.deepStrictEqual(ls.overview(), { games: [], problems: {} });

    // first copy
    const a = await ls.backupSaves({ gameId: 'g1', gameName: 'My Game', saveDir });
    assert.ok(a.backup && a.backup.files === 2 && a.backup.size > 0);
    assert.strictEqual(ls.listBackups('g1').length, 1);

    // unchanged saves: skipped; forced: a second copy
    assert.deepStrictEqual(await ls.backupSaves({ gameId: 'g1', gameName: 'My Game', saveDir }), { skipped: true });
    await ls.backupSaves({ gameId: 'g1', gameName: 'My Game', saveDir, force: true });
    assert.strictEqual(ls.listBackups('g1').length, 2);

    // only the newest 5 are kept
    for (let i = 0; i < 6; i++) await ls.backupSaves({ gameId: 'g1', saveDir, force: true });
    const list = ls.listBackups('g1');
    assert.strictEqual(list.length, 5);
    assert.ok(list[0].created_at > list[4].created_at, 'newest first');
    assert.strictEqual(list[0].device, 'Test PC');

    // restore: the current saves are copied aside first, then the copy is put back
    const first = list[list.length - 1];
    fs.writeFileSync(path.join(saveDir, 'slot 1', 'save.dat'), 'level 9 (broken)');
    const r = await ls.restoreBackup({ gameId: 'g1', backupId: first.id, saveDir });
    assert.strictEqual(r.files, 2);
    assert.strictEqual(fs.readFileSync(path.join(saveDir, 'slot 1', 'save.dat'), 'utf8'), 'level 3');
    assert.ok(ls.safetyFolder('g1'));
    const aside = fs.readdirSync(ls.safetyFolder('g1'));
    assert.strictEqual(fs.readFileSync(path.join(ls.safetyFolder('g1'), aside[0], 'slot 1', 'save.dat'), 'utf8'), 'level 9 (broken)');

    // overview: one game, five copies, its name
    const ov = ls.overview();
    assert.strictEqual(ov.games.length, 1);
    assert.strictEqual(ov.games[0].copies, 5);
    assert.strictEqual(ov.games[0].gameName, 'My Game');

    // a bad id can't reach outside the copies folder
    await assert.rejects(ls.restoreBackup({ gameId: 'g1', backupId: '../../etc/1800000000000', saveDir }), /gone/);
    ls.deleteBackup('../../x/1800000000000');

    // delete them all: the next backup isn't skipped as "unchanged"
    for (const b of ls.listBackups('g1')) ls.deleteBackup(b.id);
    assert.strictEqual(ls.listBackups('g1').length, 0);
    const again = await ls.backupSaves({ gameId: 'g1', saveDir });
    assert.ok(again.backup, 'backs up again after every copy was deleted');

    // a missing folder is reported, and shows as a problem
    await assert.rejects(ls.backupSaves({ gameId: 'g2', gameName: 'Gone', saveDir: path.join(root, 'nope') }), (e) => e.code === 'NO_FOLDER');
    assert.strictEqual(ls.overview().problems.g2.code, 'NO_FOLDER');

    console.log('local-saves: ok');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch((e) => { console.error(e); process.exit(1); });
