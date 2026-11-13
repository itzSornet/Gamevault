const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const L = require('../src/backend/sources/launchers.js');
const win = require('../src/backend/sources/windows.js');

// A throwaway home folder; files are written with real path separators so the
// readers run the same on Windows, Linux and macOS.
function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gv-launchers-'));
}
function put(home, parts, content) {
  const file = path.join(home, ...parts);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof content === 'string' || Buffer.isBuffer(content) ? content : JSON.stringify(content));
  return file;
}
const linux = (home, env = {}) => ({ home, platform: 'linux', env });

// ---------------------------------------------------------------- Heroic

test('heroic: found as a native install, a Flatpak, a Snap and a custom XDG folder', () => {
  const home = tempHome();
  assert.deepEqual(L.heroicRoots(linux(home)), []);
  put(home, ['.config', 'heroic', 'x'], '');
  put(home, ['.var', 'app', 'com.heroicgameslauncher.hgl', 'config', 'heroic', 'x'], '');
  put(home, ['snap', 'heroic', 'current', '.config', 'heroic', 'x'], '');
  put(home, ['xdg', 'heroic', 'x'], '');
  const roots = L.heroicRoots(linux(home, { XDG_CONFIG_HOME: path.join(home, 'xdg') }));
  assert.equal(roots.length, 4);
  // Windows keeps it in %APPDATA%
  put(home, ['Roaming', 'heroic', 'x'], '');
  assert.deepEqual(L.heroicRoots({ home, platform: 'win32', env: { APPDATA: path.join(home, 'Roaming') } }), [path.join(home, 'Roaming', 'heroic')]);
});

test('heroic: Epic, GOG, Amazon and sideloaded games with playtime and a launch link', () => {
  const home = tempHome();
  const root = ['.var', 'app', 'com.heroicgameslauncher.hgl', 'config', 'heroic'];
  const gogDir = path.join(home, 'Games', 'Heroic', 'Witcher 3');
  put(home, [...root, 'legendaryConfig', 'legendary', 'installed.json'], {
    Fortnite: { app_name: 'Fortnite', title: 'Fortnite', install_path: '/games/Fortnite', executable: 'FortniteLauncher.exe' },
    FortniteDLC: { app_name: 'FortniteDLC', title: 'Some DLC', install_path: '/games/Fortnite', executable: '', is_dlc: true },
  });
  put(home, [...root, 'gog_store', 'installed.json'], { installed: [
    { appName: '1207664663', install_path: gogDir, platform: 'windows' },
    { appName: '999', install_path: '/games/dlc', platform: 'windows', is_dlc: true },
    { appName: '1444', install_path: '/games/Stardew Valley', platform: 'linux' },
  ] });
  put(home, [...root, 'store_cache', 'gog_library.json'], { games: [{ app_name: '1207664663', title: 'The Witcher 3: Wild Hunt' }] });
  put(home, ['Games', 'Heroic', 'Witcher 3', 'goggame-1207664663.info'], { name: 'The Witcher 3', playTasks: [{ isPrimary: true, type: 'FileTask', path: 'bin\\x64\\witcher3.exe' }] });
  put(home, [...root, 'nile_config', 'nile', 'installed.json'], [{ id: 'amzn1.adg.product.abc', path: '/games/Amazon/Fallout 76', version: '1' }]);
  put(home, [...root, 'sideload_apps', 'library.json'], { games: [{ app_name: 'side1', title: 'My Own Game', install: { executable: '/opt/own/game.x86_64', platform: 'linux' }, folder_name: '/opt/own' }] });
  put(home, [...root, 'store', 'timestamp.json'], { Fortnite: { firstPlayed: 'x', lastPlayed: 'y', totalPlayed: 90 }, 1207664663: { totalPlayed: 600 } });

  const games = L.scanHeroic(linux(home));
  const by = Object.fromEntries(games.map((g) => [g.sourceId, g]));
  assert.deepEqual(Object.keys(by).sort(), ['heroic:gog:1207664663', 'heroic:gog:1444', 'heroic:legendary:Fortnite', 'heroic:nile:amzn1.adg.product.abc', 'heroic:sideload:side1']);
  assert.equal(by['heroic:legendary:Fortnite'].hours, 1.5);
  assert.equal(by['heroic:legendary:Fortnite'].launchTarget, 'heroic://launch/legendary/Fortnite');
  assert.equal(by['heroic:legendary:Fortnite'].exePath, path.join('/games/Fortnite', 'FortniteLauncher.exe'));
  assert.equal(by['heroic:gog:1207664663'].name, 'The Witcher 3: Wild Hunt');
  assert.equal(by['heroic:gog:1207664663'].hours, 10);
  assert.equal(by['heroic:gog:1207664663'].exePath, path.join(gogDir, 'bin', 'x64', 'witcher3.exe'));
  // a native Linux GOG game with no info file starts through its start.sh
  assert.equal(by['heroic:gog:1444'].exePath, path.join('/games/Stardew Valley', 'start.sh'));
  assert.equal(by['heroic:gog:1444'].name, 'Stardew Valley');
  assert.equal(by['heroic:nile:amzn1.adg.product.abc'].name, 'Fallout 76');
  assert.equal(by['heroic:sideload:side1'].exePath, '/opt/own/game.x86_64');
  assert.ok(games.every((g) => g.source === 'Heroic'));
});

test('heroic: broken or missing files give an empty list, never a throw', () => {
  const home = tempHome();
  put(home, ['.config', 'heroic', 'legendaryConfig', 'legendary', 'installed.json'], '{ not json');
  put(home, ['.config', 'heroic', 'gog_store', 'installed.json'], '[]');
  assert.deepEqual(L.scanHeroic(linux(home)), []);
  assert.deepEqual(L.parseLegendaryInstalled(null), []);
  assert.deepEqual(L.parseHeroicGog({ installed: 'nope' }), []);
  assert.deepEqual(L.parseHeroicNile({}), []);
  assert.deepEqual(L.parseHeroicSideload(null), []);
  assert.equal(L.heroicPlaytime(null)('x'), 0);
  assert.equal(L.heroicPlaytime({ x: { totalPlayed: -5 } })('x'), 0);
});

test('legendary on its own (also what Rare uses)', () => {
  const home = tempHome();
  put(home, ['.config', 'legendary', 'installed.json'], { Rocket: { title: 'Rocket League', install_path: '/g/rl', executable: 'Binaries/Win64/RocketLeague.exe' } });
  const games = L.scanLegendary(linux(home));
  assert.equal(games.length, 1);
  assert.equal(games[0].sourceId, 'legendary:Rocket');
  assert.equal(games[0].source, 'Legendary');
  assert.equal(games[0].launchTarget, undefined);
});

// ---------------------------------------------------------------- Lutris

test('lutris: native, Flatpak and custom XDG installs are all found', () => {
  const home = tempHome();
  assert.deepEqual(L.lutrisRoots(linux(home)), []);
  put(home, ['.local', 'share', 'lutris', 'pga.db'], 'x');
  put(home, ['.config', 'lutris', 'games', 'a-1.yml'], 'game:\n  exe: /g/a.exe\n');
  put(home, ['.var', 'app', 'net.lutris.Lutris', 'data', 'lutris', 'pga.db'], 'x');
  put(home, ['.var', 'app', 'net.lutris.Lutris', 'config', 'lutris', 'games', 'b-2.yml'], 'game:\n  exe: /g/b.exe\n');
  const roots = L.lutrisRoots(linux(home));
  assert.equal(roots.length, 2);
  assert.deepEqual(roots[0].games, [path.join(home, '.config', 'lutris', 'games')]);
  assert.equal(roots[1].db, path.join(home, '.var', 'app', 'net.lutris.Lutris', 'data', 'lutris', 'pga.db'));
  // only yml files, no database (older setups)
  const home2 = tempHome();
  put(home2, ['.local', 'share', 'lutris', 'games', 'c-3.yml'], 'game:\n  exe: /g/c.exe\n');
  assert.equal(L.lutrisRoots(linux(home2)).length, 1);
});

// ---------------------------------------------------------------- Bottles

const BOTTLE_YML = `Arch: win64
External_Programs:
  0a1b2c3d-1111-2222-3333-444455556666:
    arguments: ''
    executable: Game.exe
    id: 0a1b2c3d-1111-2222-3333-444455556666
    name: My Game
    path: C:\\\\Games\\\\My Game\\\\Game.exe
    removed: false
  ffffffff-1111-2222-3333-444455556666:
    executable: tool.exe
    name: 'Host: Tool'
    path: /home/me/tools/tool.exe
Installed_Dependencies:
- dxvk
Name: Gaming Bottle
Path: Gaming-Bottle
Parameters:
  name: not a program
`;

test('bottles: programs listed in bottle.yml, launched through Bottles', () => {
  const parsed = L.parseBottleYml(BOTTLE_YML);
  assert.equal(parsed.name, 'Gaming Bottle');
  assert.deepEqual(parsed.programs.map((p) => p.name), ['My Game', 'Host: Tool']);
  assert.deepEqual(L.parseBottleYml('Name: Empty\nExternal_Programs: {}\nPath: x\n').programs, []);
  assert.deepEqual(L.parseBottleYml('').programs, []);

  const home = tempHome();
  put(home, ['.local', 'share', 'bottles', 'bottles', 'Gaming-Bottle', 'bottle.yml'], BOTTLE_YML);
  put(home, ['.var', 'app', 'com.usebottles.bottles', 'data', 'bottles', 'bottles', 'Other', 'bottle.yml'], 'Name: Other\nExternal_Programs:\n  id1:\n    name: Flat Game\n    executable: f.exe\n');
  put(home, ['.local', 'share', 'bottles', 'bottles', 'NoYml', 'readme.txt'], 'x');
  const games = L.scanBottles(linux(home));
  assert.deepEqual(games.map((g) => g.name).sort(), ['Flat Game', 'Host: Tool', 'My Game']);
  const mine = games.find((g) => g.name === 'My Game');
  assert.equal(mine.launchTarget, 'bottles:run/Gaming%20Bottle/My%20Game');
  assert.equal(mine.exePath, '', 'a C:\\ path inside the bottle is not a file on the host');
  assert.equal(games.find((g) => g.name === 'Host: Tool').exePath, '/home/me/tools/tool.exe');
});

// ---------------------------------------------------------------- itch

test('itch: installed games are read from their gzipped receipts', () => {
  const home = tempHome();
  const receipt = (game) => zlib.gzipSync(Buffer.from(JSON.stringify({ game })));
  put(home, ['.config', 'itch', 'apps', 'celeste', '.itch', 'receipt.json.gz'], receipt({ id: 20, title: 'Celeste Classic', classification: 'game' }));
  put(home, ['.config', 'itch', 'apps', 'celeste', 'celeste.x86_64'], 'bin');
  put(home, ['.config', 'itch', 'apps', 'tiled', '.itch', 'receipt.json.gz'], receipt({ id: 21, title: 'Tiled Map Editor', classification: 'tool' }));
  put(home, ['.config', 'itch', 'apps', 'broken', '.itch', 'receipt.json.gz'], 'not gzip');
  put(home, ['.config', 'itch', 'apps', 'plain', '.itch', 'receipt.json'], { game: { id: 22, title: 'Plain Receipt' } });
  put(home, ['.config', 'itch', 'apps', 'noreceipt', 'game.bin'], 'x');
  const games = L.scanItch({ ...linux(home), findExe: (dir) => (dir.endsWith('celeste') ? path.join(dir, 'celeste.x86_64') : '') });
  assert.deepEqual(games.map((g) => [g.name, g.sourceId]), [['Celeste Classic', 'itch:20'], ['Plain Receipt', 'itch:22']]);
  assert.equal(games[0].exePath, path.join(home, '.config', 'itch', 'apps', 'celeste', 'celeste.x86_64'));
  // the Windows app keeps the same layout under %APPDATA%
  put(home, ['Roaming', 'itch', 'apps', 'w', '.itch', 'receipt.json.gz'], receipt({ id: 30, title: 'Win Game' }));
  assert.equal(L.scanItch({ home, platform: 'win32', env: { APPDATA: path.join(home, 'Roaming') } })[0].name, 'Win Game');
  assert.equal(L.parseItchReceipt(null), null);
  assert.equal(L.parseItchReceipt({ game: { title: '' } }), null);
});

// ---------------------------------------------------------------- GOG on Linux

test('gog on linux: the installers and Minigalaxy leave a gameinfo file', () => {
  const home = tempHome();
  put(home, ['GOG Games', 'Stardew Valley', 'gameinfo'], 'Stardew Valley\n1.6.8\n');
  put(home, ['GOG Games', 'Stardew Valley', 'start.sh'], '#!/bin/sh\n');
  put(home, ['GOG Games', 'Not A Game', 'readme.txt'], 'x');
  put(home, ['Elsewhere', 'FTL', 'gameinfo'], 'FTL: Faster Than Light\n1.6.13\n');
  put(home, ['.config', 'minigalaxy', 'config.json'], { install_dir: path.join(home, 'Elsewhere') });
  const games = L.scanGogLinux(linux(home));
  assert.deepEqual(games.map((g) => g.name).sort(), ['FTL: Faster Than Light', 'Stardew Valley']);
  const sv = games.find((g) => g.name === 'Stardew Valley');
  assert.equal(sv.exePath, path.join(home, 'GOG Games', 'Stardew Valley', 'start.sh'));
  assert.equal(sv.source, 'GOG');
  assert.equal(games.find((g) => g.name.startsWith('FTL')).exePath, '', 'no start.sh means nothing to run directly');
  assert.equal(L.parseGogGameinfo(''), null);
});

// ---------------------------------------------------------------- Xbox (Windows)

const GAME_CONFIG = `<?xml version="1.0" encoding="utf-8"?>
<Game configVersion="1">
  <Identity Name="BethesdaSoftworks.Starfield" Publisher="CN=x" Version="1.0.0.0" />
  <ExecutableList>
    <Executable Name="Starfield.exe" Id="Game" TargetDeviceFamily="PC" />
  </ExecutableList>
  <ShellVisuals DefaultDisplayName="Tom &amp; Jerry&apos;s Starfield" PublisherDisplayName="Bethesda" />
</Game>`;

test('xbox: only packages that ship a game config count, from any publisher', () => {
  assert.deepEqual(win.parseMicrosoftGameConfig(GAME_CONFIG), { name: "Tom & Jerry's Starfield", appId: 'Game' });
  assert.equal(win.parseMicrosoftGameConfig('<Package></Package>'), null);
  assert.equal(win.parseMicrosoftGameConfig(''), null);
  assert.equal(win.parseMicrosoftGameConfig('<Game><ShellVisuals DefaultDisplayName="ms-resource:AppName"/></Game>').name, '');

  const packages = [
    { Name: 'BethesdaSoftworks.Starfield', PackageFamilyName: 'BethesdaSoftworks.Starfield_3275kfvn8vcwc', InstallLocation: 'X:\\Starfield' },
    { Name: 'Microsoft.WindowsCalculator', PackageFamilyName: 'Microsoft.WindowsCalculator_8wekyb3d8bbwe', InstallLocation: 'C:\\Calc' },
    { Name: 'Microsoft.624F8B84B80', PackageFamilyName: 'Microsoft.624F8B84B80_8wekyb3d8bbwe', InstallLocation: 'X:\\Forza' },
  ];
  const readConfig = (dir) => (dir === 'X:\\Starfield' ? GAME_CONFIG
    : dir === 'X:\\Forza' ? '<Game><ExecutableList><Executable Name="f.exe" Id="App"/></ExecutableList><ShellVisuals DefaultDisplayName="ms-resource:Name"/></Game>' : '');
  const games = win.parseXboxApps(packages, { readConfig });
  assert.deepEqual(games.map((g) => g.name), ["Tom & Jerry's Starfield", '624 F 8 B 84 B 80']);
  assert.equal(games[0].exePath, 'shell:AppsFolder\\BethesdaSoftworks.Starfield_3275kfvn8vcwc!Game');
  assert.equal(games[1].exePath, 'shell:AppsFolder\\Microsoft.624F8B84B80_8wekyb3d8bbwe!App');
});
