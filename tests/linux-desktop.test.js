'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const linux = require('../src/backend/sources/linux-desktop.js');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gamevault-linux-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

function desktopText(name, exec, extra = 'Categories=Game;') {
  return ['[Desktop Entry]', 'Type=Application', `Name=${name}`, `Exec=${exec}`, extra]
    .filter(Boolean)
    .join('\n') + '\n';
}

function elfAppImage(appImageType = 2) {
  return Buffer.concat([
    Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]), // ELF
    Buffer.from([0x41, 0x49, appImageType, 0]), // "AI" + type
  ]);
}

// ---------------------------------------------------------------------------
// Desktop entries
// ---------------------------------------------------------------------------

test('parseDesktopEntry unescapes values and strips Exec field codes', () => {
  const entry = linux.parseDesktopEntry([
    '[Desktop Entry]',
    'Type=Application',
    'Name=Space\\sGame',
    'Name[de]=Weltraumspiel',
    'Exec=env MANGOHUD=1 "/opt/My Games/game" --fancy %f %U %i %c %k',
    'Icon=space-game',
    'Categories=Game;ActionGame;',
    'TryExec=game',
    'NoDisplay=false',
    'Terminal=true',
    '[Desktop Action Play]',
    'Name=Wrong',
    'Exec=/bin/wrong',
  ].join('\n'));

  assert.equal(entry.Name, 'Space Game');
  assert.equal(entry.Exec, 'env MANGOHUD=1 "/opt/My Games/game" --fancy');
  assert.equal(entry.Icon, 'space-game');
  assert.deepEqual(entry.Categories, ['Game', 'ActionGame']);
  assert.equal(entry.TryExec, 'game');
  assert.equal(entry.NoDisplay, false);
  assert.equal(entry.Terminal, true);
  assert.equal(linux.parseDesktopEntry('[Desktop Entry]\nTerminal=1\n').Terminal, true);
  assert.equal(linux.parseDesktopEntry('[Desktop Entry]\nNoDisplay=1\n').NoDisplay, true);
  assert.equal(linux.parseDesktopEntry(null).Name, '');
});

test('parseDesktopEntry keeps literal percents and ignores localized keys', () => {
  const entry = linux.parseDesktopEntry([
    '[Desktop Entry]',
    'Name=Percent',
    'Name[fr]=Pourcentage',
    'Exec=run %%f %U',
    'Categories=Game;',
  ].join('\n'));

  assert.equal(entry.Exec, 'run %f');
  assert.equal(entry.Name, 'Percent');
});

test('parseExec resolves command/args and unwraps env assignments and options', () => {
  assert.deepEqual(
    linux.parseExec('env -u FOO BAR=baz "/opt/My Game/game" --fullscreen %U'),
    { command: '/opt/My Game/game', args: ['--fullscreen'] },
  );
  assert.deepEqual(linux.parseExec("'single quoted' %f"), { command: 'single quoted', args: [] });
  assert.deepEqual(linux.parseExec(''), { command: '', args: [] });
});

test('scanDesktopFiles keeps games, known launchers and depth-3 entries only', (t) => {
  const root = fixture(t);
  const apps = path.join(root, 'apps');
  const exe = write(path.join(root, 'games', 'My Game', 'my-game'), '#!/bin/sh\n');

  write(path.join(apps, 'my-game.desktop'), desktopText(
    'My Game',
    `"${exe}" --fullscreen %U`,
    'Categories=ActionGame;',
  ));
  write(path.join(apps, 'utility.desktop'), desktopText('Utility', '/bin/true', 'Categories=Utility;'));
  write(path.join(apps, 'steam.desktop'), desktopText('Steam', '/usr/bin/steam %U', 'Categories=Utility;'));
  write(path.join(apps, 'hidden.desktop'), desktopText(
    'Hidden',
    '/usr/bin/hidden',
    'Categories=Game;\nNoDisplay=true',
  ));
  write(path.join(apps, 'one', 'two', 'three', 'deep.desktop'), desktopText(
    'Deep Game',
    '/usr/bin/deep-game',
  ));
  write(path.join(apps, 'one', 'two', 'three', 'four', 'too-deep.desktop'), desktopText(
    'Too Deep',
    '/usr/bin/too-deep',
  ));

  const found = linux.scanDesktopFiles([apps, path.join(root, 'missing')]);
  const names = found.map((game) => game.name).sort();
  assert.deepEqual(names, ['Deep Game', 'My Game', 'Steam']);

  const game = found.find((item) => item.name === 'My Game');
  assert.equal(game.source, 'desktop');
  assert.equal(game.sourceId, `desktop:${path.join(apps, 'my-game.desktop')}`);
  assert.equal(game.exePath, exe);
  assert.equal(game.installDir, path.dirname(exe));
  assert.deepEqual(game.args, ['--fullscreen']);
  assert.equal(game.launcher, 'desktop');
  assert.equal(game.confidence, 0.9);

  const steam = found.find((item) => item.name === 'Steam');
  assert.equal(steam.confidence, 0.7);
  assert.ok(!found.some((item) => item.source !== 'desktop'));

  assert.deepEqual(linux.scanDesktopFiles([null, 42, path.join(root, 'nope')]), []);
});

// ---------------------------------------------------------------------------
// AppImage
// ---------------------------------------------------------------------------

test('scanAppImages requires ELF magic and AppImage type-2 magic at offset 8', (t) => {
  const root = fixture(t);
  const images = path.join(root, 'images');
  const appImage = write(path.join(images, 'Super Game.AppImage'), elfAppImage(2));

  write(path.join(images, 'Plain.AppImage'), Buffer.concat([elfAppImage(0).subarray(0, 8), Buffer.alloc(4)]));
  write(path.join(images, 'TypeOne.AppImage'), elfAppImage(1));
  write(path.join(images, 'notes.txt'), 'not a binary');
  fs.mkdirSync(path.join(images, 'Directory.AppImage'));

  const found = linux.scanAppImages([images, path.join(root, 'missing')]);
  assert.equal(found.length, 1);
  assert.deepEqual(found[0], {
    name: 'Super Game',
    source: 'AppImage',
    sourceId: `appimage:${appImage}`,
    exePath: appImage,
    installDir: images,
    confidence: 0.9,
    iconPath: '',
    launcher: 'appimage',
    args: [],
  });

  assert.deepEqual(linux.scanAppImages([null, path.join(root, 'nope')]), []);
});

// ---------------------------------------------------------------------------
// RetroArch playlists
// ---------------------------------------------------------------------------

test('parseRetroArchPlaylist emits one labelled candidate per ROM', () => {
  const raw = JSON.stringify({
    version: '1.7.6',
    items: [
      { path: '/roms/snes/Super Mario World.sfc', label: 'Super Mario World', core_name: 'snes9x_libretro.so' },
      { path: '/roms/nes/Contra.nes', label: '', core_name: 'nestopia_libretro.so' },
      { label: 'Missing path', core_name: 'ignored_libretro.so' },
      { path: '/roms/snes/Super Mario World.sfc', label: 'Duplicate', core_name: 'snes9x_libretro.so' },
    ],
  });

  const found = linux.parseRetroArchPlaylist(raw);
  assert.equal(found.length, 2);
  assert.equal(found[0].name, 'Super Mario World');
  assert.equal(found[0].source, 'RetroArch');
  assert.equal(found[0].sourceId, 'retroarch:/roms/snes/Super Mario World.sfc');
  assert.equal(found[0].exePath, '/roms/snes/Super Mario World.sfc');
  assert.equal(found[0].installDir, '/roms/snes');
  assert.equal(found[0].core, 'snes9x_libretro.so');
  assert.equal(found[0].launcher, 'retroarch');
  assert.equal(found[1].name, 'Contra');
  assert.equal(found[1].core, 'nestopia_libretro.so');

  assert.deepEqual(linux.parseRetroArchPlaylist('not json'), []);
  assert.deepEqual(linux.parseRetroArchPlaylist('{"items":null}'), []);
  assert.deepEqual(linux.parseRetroArchPlaylist(null), []);
});

// ---------------------------------------------------------------------------
// Wine
// ---------------------------------------------------------------------------

test('scanWinePrefixes keeps game exes and skips system/redist/uninstall trees', (t) => {
  const root = fixture(t);
  const prefix = path.join(root, 'prefix');
  const driveC = path.join(prefix, 'drive_c');
  const game = write(path.join(driveC, 'Program Files', 'My Game', 'MyGame.exe'), 'MZ');
  const deep = write(path.join(driveC, 'a', 'b', 'c', 'd', 'Deep.exe'), 'MZ');

  write(path.join(driveC, 'windows', 'system32', 'notepad.exe'), 'MZ');
  write(path.join(driveC, 'Program Files', 'Common Files', 'shared.exe'), 'MZ');
  write(path.join(driveC, 'Program Files', 'Uninstall Helper', 'uninstall.exe'), 'MZ');
  write(path.join(driveC, 'vc_redist.x64', 'vc_redist.exe'), 'MZ');
  write(path.join(driveC, 'DirectX', 'dxsetup.exe'), 'MZ');
  write(path.join(driveC, 'a', 'b', 'c', 'd', 'e', 'TooDeep.exe'), 'MZ');

  const found = linux.scanWinePrefixes([prefix, path.join(root, 'missing')]);
  assert.deepEqual(found.map((item) => item.name).sort(), ['Deep', 'MyGame']);
  assert.ok(found.every((item) => item.source === 'Wine'));
  assert.ok(found.every((item) => item.launcher === prefix));
  assert.ok(found.some((item) => item.exePath === game));
  assert.ok(found.some((item) => item.exePath === deep));
  assert.ok(found.every((item) => item.installDir === path.dirname(item.exePath)));

  assert.deepEqual(linux.scanWinePrefixes([null, path.join(root, 'nope')]), []);
});

// ---------------------------------------------------------------------------
// Minecraft
// ---------------------------------------------------------------------------

test('scanMinecraftLaunchers finds instance files and Horizon versions', (t) => {
  const home = fixture(t);
  write(
    path.join(home, '.local', 'share', 'PrismLauncher', 'instances', 'My Instance', 'instance.cfg'),
    'InstanceType=OneSix\nname=My Prism Pack\n',
  );
  write(
    path.join(home, '.local', 'share', 'multimc', 'instances', 'Multi', 'instance.cfg'),
    'name=Multi Pack\n',
  );
  write(
    path.join(home, '.local', 'share', 'ATLauncher', 'instances', 'AT', 'instance.json'),
    JSON.stringify({ name: 'AT Pack' }),
  );
  write(
    path.join(home, '.config', 'gdlauncher_next', 'instances', 'GD', 'instance.json'),
    JSON.stringify({ name: 'GD Pack' }),
  );
  write(
    path.join(home, '.local', 'share', 'ModrinthApp', 'profiles', 'Mod', 'profile.json'),
    JSON.stringify({ name: 'Modrinth Pack' }),
  );

  const minecraftDir = path.join(home, 'horizon-data');
  fs.mkdirSync(path.join(minecraftDir, 'versions', '1.20.1'), { recursive: true });
  const binary = path.join(home, '.local', 'bin', 'horizon');
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  fs.writeFileSync(binary, `#!/bin/sh\nprintf '%s\\n' '${JSON.stringify({ minecraft_dir: minecraftDir })}'\n`);
  fs.chmodSync(binary, 0o755);

  const found = linux.scanMinecraftLaunchers({ homeDir: home });
  const namesFor = (launcher) => found.filter((item) => item.launcher === launcher).map((item) => item.name);

  assert.deepEqual(namesFor('prism'), ['My Prism Pack']);
  assert.deepEqual(namesFor('multimc'), ['Multi Pack']);
  assert.deepEqual(namesFor('atlauncher'), ['AT Pack']);
  assert.deepEqual(namesFor('gdlauncher'), ['GD Pack']);
  assert.deepEqual(namesFor('modrinth'), ['Modrinth Pack']);
  assert.deepEqual(namesFor('horizon'), ['Minecraft 1.20.1']);
  assert.ok(found.every((item) => item.source === 'Minecraft'));
  assert.ok(found.filter((item) => item.launcher !== 'horizon').every((item) => item.confidence === 0.9));
});

test('scanMinecraftLaunchers falls back to ~/.minecraft/versions when the CLI fails', (t) => {
  const home = fixture(t);
  const binary = path.join(home, '.local', 'bin', 'horizon');
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  fs.writeFileSync(binary, '#!/bin/sh\nexit 1\n'); // present but unusable
  fs.mkdirSync(path.join(home, '.minecraft', 'versions', '1.21'), { recursive: true });

  const found = linux.scanMinecraftLaunchers({ homeDir: home }).filter((item) => item.launcher === 'horizon');
  assert.deepEqual(found.map((item) => item.name), ['Minecraft 1.21']);
  assert.equal(found[0].sourceId, `horizon:${path.join(home, '.minecraft', 'versions', '1.21')}`);
});

// ---------------------------------------------------------------------------
// Aggregate
// ---------------------------------------------------------------------------

test('scanLinuxInventory aggregates desktop, AppImage, Wine and Minecraft sources', (t) => {
  const root = fixture(t);
  const home = path.join(root, 'home');
  const apps = path.join(root, 'apps');
  const images = path.join(root, 'images');
  const prefix = path.join(root, 'prefix');

  write(path.join(apps, 'game.desktop'), desktopText('Desktop Game', '/opt/games/game %U'));
  write(path.join(images, 'Image Game.AppImage'), elfAppImage(2));
  write(path.join(prefix, 'drive_c', 'Games', 'Wine Game', 'WineGame.exe'), 'MZ');
  write(
    path.join(home, '.local', 'share', 'PrismLauncher', 'instances', 'Pack', 'instance.cfg'),
    'name=Prism Pack\n',
  );
  fs.mkdirSync(path.join(home, '.minecraft', 'versions', '1.20.6'), { recursive: true });
  // Present but unusable, so the scanner deterministically falls back to
  // ~/.minecraft instead of invoking a host Horizon binary.
  const brokenCli = path.join(home, '.local', 'bin', 'horizon');
  fs.mkdirSync(path.dirname(brokenCli), { recursive: true });
  fs.writeFileSync(brokenCli, '#!/bin/sh\nexit 1\n');

  const found = linux.scanLinuxInventory({
    homeDir: home,
    desktopDirs: [apps],
    appImageDirs: [images],
    winePrefixes: [prefix],
  });

  assert.ok(found.some((item) => item.name === 'Desktop Game' && item.source === 'desktop'));
  assert.ok(found.some((item) => item.name === 'Image Game' && item.source === 'AppImage'));
  assert.ok(found.some((item) => item.name === 'WineGame' && item.source === 'Wine'));
  assert.ok(found.some((item) => item.name === 'Prism Pack' && item.launcher === 'prism'));
  assert.ok(found.some((item) => item.name === 'Minecraft 1.20.6' && item.launcher === 'horizon'));
});

test('scanLinuxInventory tolerates missing dirs and invalid options without throwing', (t) => {
  const root = fixture(t);
  const emptyHome = path.join(root, 'empty-home');
  fs.mkdirSync(emptyHome);
  const missing = path.join(root, 'missing');

  const found = linux.scanLinuxInventory({
    homeDir: emptyHome,
    desktopDirs: [missing, null, 42],
    appImageDirs: [missing],
    winePrefixes: [missing, null],
  });
  assert.ok(Array.isArray(found));

  assert.ok(Array.isArray(linux.scanLinuxInventory(null)));
  assert.deepEqual(linux.scanDesktopFiles([]), []);
  assert.deepEqual(linux.scanAppImages([]), []);
  assert.deepEqual(linux.scanWinePrefixes([]), []);
});
