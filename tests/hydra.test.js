const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const hydra = require('../src/backend/sources/hydra.js');

const IS_WIN = process.platform === 'win32';
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gv-hydra-'));
const HOME = path.join(TMP_DIR, 'home');
const APPDATA = path.join(HOME, 'AppData', 'Roaming');
const DB_DIR = path.join(
  IS_WIN ? APPDATA : path.join(HOME, '.config'),
  'hydralauncher',
  'hydra-db',
);
const GAME_DIR = path.join(TMP_DIR, 'games', 'Alpha Quest');
const EXE = path.join(GAME_DIR, 'alpha.exe');

// Hydra on Windows resolves through %APPDATA%; point it at the fixture home.
const ORIGINAL_APPDATA = process.env.APPDATA;
if (IS_WIN) process.env.APPDATA = APPDATA;

fs.mkdirSync(GAME_DIR, { recursive: true });
fs.writeFileSync(EXE, 'fixture executable');

const rec = (obj) => Buffer.from(JSON.stringify(obj), 'utf8');

const ALPHA = {
  title: 'Alpha Quest',
  objectId: '101',
  shop: 'steam',
  executablePath: EXE,
  playTimeInMilliseconds: 5400000,
  protonPath: '/fake/GE-Proton',
  installedSizeInBytes: 1024 * 1024,
  isDeleted: false,
  coverImageUrl: 'https://example.invalid/alpha-cover.jpg',
  libraryHeroImageUrl: 'https://example.invalid/alpha-hero.jpg',
  logoImageUrl: 'https://example.invalid/alpha-logo.jpg',
  iconUrl: 'https://example.invalid/alpha-icon.jpg',
};

// Same objectId, no executable, much newer. The executable-bearing record must
// win the dedupe even though this one has the larger updatedAt.
const ALPHA_DUPLICATE = {
  title: 'Alpha Quest',
  objectId: '101',
  shop: 'steam',
  playTimeInMilliseconds: 5400000,
  updatedAt: 9999999999999,
  isDeleted: false,
};

const DELETED = {
  title: 'Removed Game',
  objectId: '999',
  shop: 'steam',
  executablePath: path.join(TMP_DIR, 'removed.exe'),
  playTimeInMilliseconds: 7200000,
  isDeleted: true,
};

const STEAM_RUNTIME = {
  title: 'Steam Linux Runtime 3.0 (sniper)',
  objectId: '888',
  shop: 'steam',
  isDeleted: false,
};

const PROTON = {
  title: 'Proton 9.0 (Beta)',
  objectId: '777',
  shop: 'steam',
  isDeleted: false,
};

// Equal executable status: largest updatedAt wins, i.e. "New Tie Name".
const TIE_OLD = {
  title: 'Old Tie Name',
  objectId: '303',
  shop: 'gog',
  playTimeInMilliseconds: 0,
  updatedAt: 1000,
};
const TIE_NEW = {
  title: 'New Tie Name',
  objectId: '303',
  shop: 'gog',
  playTimeInMilliseconds: 0,
  updatedAt: 2000,
};

const BETA = {
  title: 'Beta Blast',
  objectId: '202',
  shop: 'gog',
  playTimeInMilliseconds: 3600000,
  isDeleted: false,
  updatedAt: 50,
};

fs.mkdirSync(DB_DIR, { recursive: true });

// (a) A LevelDB log: raw UTF-8 JSON records wrapped in binary noise, plus a
// truncated record that must not hide the records that follow it.
fs.writeFileSync(
  path.join(DB_DIR, '000001.log'),
  Buffer.concat([
    Buffer.from([0x00, 0x11, 0x7b, 0x22, 0x80, 0xff, 0xfe, 0x5c, 0x00]),
    Buffer.from('{"title":"Truncated Record","objectId":"666"', 'utf8'),
    rec(ALPHA),
    rec(ALPHA_DUPLICATE),
    rec(DELETED),
    rec(STEAM_RUNTIME),
    rec(PROTON),
    rec(TIE_OLD),
    rec(TIE_NEW),
    Buffer.from('{"unrelated":"metadata"}', 'utf8'),
    Buffer.from([0x00, 0x7b, 0x7d, 0xff, 0xde, 0xad]),
  ]),
);

// (b) A table file: garbage, one game, garbage.
fs.writeFileSync(
  path.join(DB_DIR, '000002.ldb'),
  Buffer.concat([
    Buffer.from([0x00, 0xff, 0x7b, 0x22, 0x00, 0x7b]),
    rec(BETA),
    Buffer.from([0xde, 0xad, 0x7d, 0x00]),
  ]),
);

// (c) Bookkeeping files carry game-shaped JSON but must never be read.
for (const name of ['LOCK', 'CURRENT', 'LOG', 'LOG.old', 'MANIFEST-000003']) {
  fs.writeFileSync(
    path.join(DB_DIR, name),
    rec({ title: `Should Not Appear ${name}`, objectId: '000', shop: 'steam' }),
  );
}

after(() => {
  if (IS_WIN) {
    if (ORIGINAL_APPDATA === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = ORIGINAL_APPDATA;
  }
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
});

test('extractGames reads raw JSON, dedupes and filters', () => {
  const games = hydra.extractGames(DB_DIR);
  const titles = games.map((g) => g.title).sort();

  assert.deepEqual(titles, ['Alpha Quest', 'Beta Blast', 'New Tie Name']);

  const alpha = games.find((g) => g.objectId === '101');
  assert.ok(alpha);
  assert.equal(alpha.executablePath, EXE);

  assert.ok(!games.some((g) => g.isDeleted === true));
  assert.ok(!games.some((g) => /Steam Linux Runtime|Proton/i.test(g.title)));
  assert.ok(!games.some((g) => g.title.startsWith('Should Not Appear')));
});

test('scan maps records to the exact candidate shape', () => {
  const candidates = hydra.scan({ homeDir: HOME });
  assert.equal(candidates.length, 3);

  const alpha = candidates.find((c) => c.name === 'Alpha Quest');
  assert.ok(alpha);
  assert.deepEqual(
    Object.keys(alpha).sort(),
    ['exePath', 'hours', 'iconPath', 'installDir', 'name', 'source', 'sourceId', 'steamAppId'].sort(),
  );
  assert.equal(alpha.source, 'Hydra');
  assert.equal(alpha.sourceId, 'hydra:101');
  assert.equal(alpha.exePath, EXE);
  assert.equal(alpha.installDir, GAME_DIR);
  assert.equal(alpha.hours, 1.5);
  assert.equal(alpha.steamAppId, '101');
  assert.equal(alpha.iconPath, '');

  const beta = candidates.find((c) => c.name === 'Beta Blast');
  assert.ok(beta);
  assert.equal(beta.sourceId, 'hydra:202');
  assert.equal(beta.exePath, '');
  assert.equal(beta.installDir, '');
  assert.equal(beta.hours, 1);
  assert.equal(beta.steamAppId, null);

  const tie = candidates.find((c) => c.name === 'New Tie Name');
  assert.ok(tie);
  assert.equal(tie.sourceId, 'hydra:303');
  assert.equal(tie.hours, 0);
});

test('detect finds native, Flatpak and missing databases', () => {
  assert.equal(hydra.detect(HOME), true);
  assert.equal(hydra.detect(path.join(TMP_DIR, 'missing-home')), false);

  if (!IS_WIN) {
    const flatpakHome = path.join(TMP_DIR, 'flatpak-home');
    fs.mkdirSync(
      path.join(flatpakHome, '.var', 'app', 'gg.hydralauncher.Hydra', 'config', 'hydralauncher', 'hydra-db'),
      { recursive: true },
    );
    assert.equal(hydra.detect(flatpakHome), true);
  }
});

test('missing directory returns an empty array', () => {
  assert.deepEqual(hydra.extractGames(path.join(TMP_DIR, 'does-not-exist')), []);
  assert.deepEqual(hydra.scan({ homeDir: path.join(TMP_DIR, 'does-not-exist') }), []);
});

test('garbage and Snappy-like blocks never throw', () => {
  const garbageDir = path.join(TMP_DIR, 'garbage-db');
  fs.mkdirSync(garbageDir, { recursive: true });
  fs.writeFileSync(
    path.join(garbageDir, '000003.ldb'),
    Buffer.concat([
      Buffer.from([0xff, 0xfe, 0x00, 0x7b, 0x22, 0x5c, 0x7d]),
      Buffer.from([0x01, 0x02, 0x03, 0x80, 0x81, 0x82]),
    ]),
  );

  let games;
  assert.doesNotThrow(() => {
    games = hydra.extractGames(garbageDir);
  });
  assert.deepEqual(games, []);
});

test('real Hydra database smoke test', (t) => {
  const realDir = path.join(os.homedir(), '.config', 'hydralauncher', 'hydra-db');
  if (!fs.existsSync(realDir)) {
    t.skip('Hydra database not present');
    return;
  }

  let games;
  assert.doesNotThrow(() => {
    games = hydra.extractGames(realDir);
  });
  assert.ok(Array.isArray(games));
  assert.ok(games.every((g) => typeof g.title === 'string' && g.title.length > 0));
});
