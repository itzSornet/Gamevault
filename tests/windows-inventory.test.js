'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const inv = require('../src/backend/sources/windows-inventory.js');

const dw = (value) => ['REG_DWORD', value];
const regBlock = (id, values) => [
  `HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${id}`,
  ...Object.entries(values).map(([n, v]) => `    ${n}    ${Array.isArray(v) ? v[0] : 'REG_SZ'}    ${Array.isArray(v) ? v[1] : v}`),
].join('\n');
const REG = [
  regBlock('Forza', { DisplayName: 'Forza Horizon 5', DisplayIcon: '"C:\\Games\\Forza\\Forza.exe",0', InstallLocation: 'C:\\Games\\Forza', UninstallString: '"C:\\Games\\Forza\\Forza.exe" /uninstall', Publisher: 'Microsoft Corporation', EstimatedSize: dw('0x4000000') }),
  regBlock('Hollow', { DisplayName: 'Hollow Knight', DisplayIcon: 'D:\\Games\\Hollow Knight\\hollow_knight.exe,0', InstallLocation: '"D:\\Games\\Hollow Knight"', Publisher: 'Team Cherry', ReleaseType: 'Game', SystemComponent: dw('0x0') }),
  regBlock('vc', { DisplayName: 'Microsoft Visual C++ 2015-2022 Redistributable (x64)', Publisher: 'Microsoft Corporation' }),
  regBlock('driver', { DisplayName: 'NVIDIA Graphics Driver 551.23', Publisher: 'NVIDIA Corporation' }),
  regBlock('runtime', { DisplayName: '.NET Runtime 8.0.1', Publisher: 'Microsoft Corporation' }),
  regBlock('launcher', { DisplayName: 'Rockstar Games Launcher', Publisher: 'Rockstar Games' }),
  regBlock('updater', { DisplayName: 'Hollow Knight', DisplayIcon: 'D:\\Games\\Hollow Knight\\hollow_knight.exe', UninstallString: 'D:\\Games\\Hollow Knight\\Updater.exe' }),
  regBlock('system', { DisplayName: 'Forza Horizon 5 Add-on', DisplayIcon: 'C:\\Games\\Forza\\Forza.exe', SystemComponent: dw('0x1') }),
  regBlock('release', { DisplayName: 'Forza Horizon 5', DisplayIcon: 'C:\\Games\\Forza\\Forza.exe', ReleaseType: 'Update' }),
].join('\n\n');

test('parseUninstallRegistry keeps games and rejects tooling/updaters/system parts', () => {
  const games = inv.parseUninstallRegistry(REG);
  assert.deepEqual(games.map((g) => g.name), ['Forza Horizon 5', 'Hollow Knight']);
  assert.deepEqual([games[0].exePath, games[0].installDir, games[0].source], ['C:\\Games\\Forza\\Forza.exe', 'C:\\Games\\Forza', 'This PC']);
  assert.deepEqual([games[1].exePath, games[1].installDir, games[1].publisher], ['D:\\Games\\Hollow Knight\\hollow_knight.exe', 'D:\\Games\\Hollow Knight', 'Team Cherry']);
  assert.deepEqual(inv.parseUninstallRegistry('not a registry dump'), []);
});

const appxBlock = (name, family, publisher) => [
  `Name              : ${name}`, `PackageFullName   : ${name}_1.0_x64__x`,
  `PackageFamilyName : ${family}`, `Publisher         : ${publisher}`,
].join('\n');
const APPX = [
  appxBlock('BethesdaSoftworks.Starfield', 'BethesdaSoftworks.Starfield_x', 'CN=Bethesda Softworks'),
  appxBlock('Microsoft.ForzaHorizon5', 'Microsoft.ForzaHorizon5_x', 'CN=Microsoft Corporation'),
  appxBlock('Microsoft.WindowsStore', 'Microsoft.WindowsStore_x', 'CN=Microsoft Corporation'),
  appxBlock('Microsoft.VCLibs.140.00', 'Microsoft.VCLibs.140.00_x', 'CN=Microsoft Corporation'),
  appxBlock('SpotifyAB.SpotifyMusic', 'SpotifyAB.SpotifyMusic_x', 'CN=Spotify AB'),
].join('\n\n');

test('parseAppxList keeps Store games and drops system/media packages', () => {
  const games = inv.parseAppxList(APPX);
  assert.deepEqual(games.map((g) => g.name), ['Starfield', 'Forza Horizon 5']);
  assert.equal(games[0].exePath, 'shell:AppsFolder\\BethesdaSoftworks.Starfield_x!App');
  assert.match(games[1].publisher, /Microsoft/);
  const piped = inv.parseAppxList('Microsoft.MinecraftUWP|Microsoft.MinecraftUWP_1_x64__8we|Microsoft.MinecraftUWP_8we|CN=Microsoft Corporation');
  assert.deepEqual(piped.map((g) => g.name), ['Minecraft UWP']);
});

const cstr = (value) => Buffer.from(`${value}\0`);
const vstr = (k, v) => Buffer.concat([Buffer.from([1]), cstr(k), cstr(v)]);
const vint = (k, v) => { const b = Buffer.alloc(4); b.writeInt32LE(v); return Buffer.concat([Buffer.from([2]), cstr(k), b]); };
const vmap = (k, entries) => Buffer.concat([Buffer.from([0]), cstr(k), ...entries, Buffer.from([8])]);
const VDF = Buffer.concat([
  vmap('shortcuts', [
    vmap('0', [vstr('appname', 'Hollow Knight'), vstr('exe', '"D:\\Games\\HK\\hk.exe"'), vstr('StartDir', '"D:\\Games\\HK"'), vstr('icon', 'D:\\Art\\hk.ico'), vint('appid', 4242), vmap('tags', [vstr('0', 'metroidvania')])]),
    vmap('1', [vstr('AppName', 'Celeste'), vstr('Exe', 'C:\\Games\\Celeste\\Celeste.exe'), vstr('StartDir', 'C:\\Games\\Celeste'), vstr('icon', ''), vint('appid', 7)]),
  ]),
  Buffer.from([8]),
]);

test('parseShortcutsVdf decodes 0x01 strings, 0x02 int32s and nested maps', () => {
  const games = inv.parseShortcutsVdf(VDF);
  assert.deepEqual(games.map((g) => g.name), ['Hollow Knight', 'Celeste']);
  assert.deepEqual([games[0].exePath, games[0].installDir, games[0].iconPath, games[0].sourceId], ['D:\\Games\\HK\\hk.exe', 'D:\\Games\\HK', 'D:\\Art\\hk.ico', 'steam-shortcut:4242']);
  assert.deepEqual([games[1].exePath, games[1].sourceId], ['C:\\Games\\Celeste\\Celeste.exe', 'steam-shortcut:7']);
  assert.deepEqual(inv.parseShortcutsVdf(VDF.subarray(0, VDF.length - 3)), []);
  assert.deepEqual(inv.parseShortcutsVdf(Buffer.from([0, 8])), []);
});

test('dedupeKey normalizes exe case/slashes and falls back to dir or id', () => {
  assert.equal(inv.dedupeKey({ exePath: 'C:/Games/Foo/Foo.EXE' }), 'exe:c:\\games\\foo\\foo.exe');
  assert.equal(inv.dedupeKey({ installDir: 'D:\\Games\\Bar\\' }), 'dir:d:\\games\\bar');
  assert.equal(inv.dedupeKey({ name: 'No Path' }), 'id:no path');
  assert.equal(inv.dedupeKey(null), '');
});

test('scanWindowsInventory is inert off Windows', { skip: process.platform === 'win32' }, () => {
  let called = false;
  const found = inv.scanWindowsInventory({ execFileSync: () => { called = true; return REG; } });
  assert.deepEqual(found, []);
  assert.equal(called, false);
});

test('scanWindowsInventory returns partial results when Appx fails', () => {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'win32' });
  try {
    const found = inv.scanWindowsInventory({
      execFileSync(command, args) {
        if (command === 'powershell.exe' || args[1].includes('WOW6432Node')) throw new Error('blocked');
        return REG;
      },
    });
    assert.deepEqual(found.map((g) => g.name), ['Forza Horizon 5', 'Hollow Knight']);
  } finally {
    Object.defineProperty(process, 'platform', descriptor);
  }
});
