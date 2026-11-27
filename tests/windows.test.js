'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const windows = require('../src/backend/sources/windows.js');

// ---------------------------------------------------------------------------
// Epic
// ---------------------------------------------------------------------------

test('parseEpicManifest joins a path containing spaces with LaunchExecutable', () => {
  const manifest = {
    DisplayName: 'My Game',
    InstallLocation: 'C:\\Program Files\\Epic Games\\My Game',
    LaunchExecutable: 'Binaries\\Win64\\MyGame.exe',
    CatalogItemId: 'catalog-123',
    AppName: 'MyGame',
  };

  assert.deepEqual(windows.parseEpicManifest(manifest), {
    name: 'My Game',
    source: 'Epic',
    sourceId: 'epic:catalog-123',
    exePath: 'C:\\Program Files\\Epic Games\\My Game\\Binaries\\Win64\\MyGame.exe',
    installDir: 'C:\\Program Files\\Epic Games\\My Game',
    hours: 0,
    steamAppId: null,
    iconPath: '',
  });
});

test('parseEpicManifest falls back to AppName when CatalogItemId is absent', () => {
  const manifest = {
    DisplayName: 'Fallback Game',
    InstallLocation: 'D:\\Games\\Fallback',
    LaunchExecutable: 'FallbackGame.exe',
    AppName: 'FallbackApp',
  };

  const found = windows.parseEpicManifest(manifest);
  assert.equal(found.sourceId, 'epic:FallbackApp');
  assert.equal(found.exePath, 'D:\\Games\\Fallback\\FallbackGame.exe');
});

test('parseEpicManifest returns null when required fields are missing', () => {
  assert.equal(windows.parseEpicManifest(null), null);
  assert.equal(windows.parseEpicManifest({}), null);
  assert.equal(windows.parseEpicManifest({
    DisplayName: 'No executable',
    InstallLocation: 'C:\\Games\\NoExe',
    AppName: 'NoExe',
  }), null);
  assert.equal(windows.parseEpicManifest({
    DisplayName: 'No install dir',
    LaunchExecutable: 'Game.exe',
    AppName: 'NoDir',
  }), null);
  assert.equal(windows.parseEpicManifest({
    InstallLocation: 'C:\\Games\\NoName',
    LaunchExecutable: 'Game.exe',
    AppName: 'NoName',
  }), null);
});

// ---------------------------------------------------------------------------
// GOG
// ---------------------------------------------------------------------------

test('parseGogInfo picks the primary play task, not the secondary one', () => {
  const info = {
    gameId: '1207658924',
    name: 'Beyond Good & Evil',
    playTasks: [
      { isPrimary: false, path: 'support\\GalaxyHelper.exe' },
      { isPrimary: true, path: 'game.exe' },
    ],
  };

  assert.deepEqual(windows.parseGogInfo(info, 'C:\\GOG Games\\Beyond Good & Evil'), {
    name: 'Beyond Good & Evil',
    source: 'GOG',
    sourceId: 'gog:1207658924',
    exePath: 'C:\\GOG Games\\Beyond Good & Evil\\game.exe',
    installDir: 'C:\\GOG Games\\Beyond Good & Evil',
    hours: 0,
    steamAppId: null,
    iconPath: '',
  });
});

test('parseGogInfo falls back to gameName', () => {
  const found = windows.parseGogInfo({
    gameId: '42',
    gameName: 'Fallback GOG Game',
    playTasks: [{ isPrimary: true, path: 'fallback.exe' }],
  }, 'D:\\Games\\Fallback GOG Game');

  assert.equal(found.name, 'Fallback GOG Game');
  assert.equal(found.exePath, 'D:\\Games\\Fallback GOG Game\\fallback.exe');
  assert.equal(found.sourceId, 'gog:42');
});

test('parseGogInfo returns null without a primary play task', () => {
  assert.equal(windows.parseGogInfo({ gameId: '1', name: 'No Tasks' }, 'C:\\Games\\No Tasks'), null);
  assert.equal(windows.parseGogInfo({
    gameId: '2',
    name: 'No Primary',
    playTasks: [{ isPrimary: false, path: 'helper.exe' }],
  }, 'C:\\Games\\NoPrimary'), null);
  assert.equal(windows.parseGogInfo({
    gameId: '3',
    name: 'Primary Without Path',
    playTasks: [{ isPrimary: true }],
  }, 'C:\\Games\\NoPath'), null);
});

// ---------------------------------------------------------------------------
// Registry uninstall keys
// ---------------------------------------------------------------------------

test('parseUninstallKey strips quotes and an icon index from DisplayIcon', () => {
  const found = windows.parseUninstallKey({
    DisplayName: 'World of Warcraft',
    DisplayIcon: '"C:\\Program Files (x86)\\World of Warcraft\\_retail_\\Wow.exe",0',
    InstallLocation: 'C:\\Program Files (x86)\\World of Warcraft',
    Publisher: 'Blizzard Entertainment',
  }, 'Battle.net');

  assert.deepEqual(found, {
    name: 'World of Warcraft',
    source: 'Battle.net',
    sourceId: 'battle.net:World of Warcraft',
    exePath: 'C:\\Program Files (x86)\\World of Warcraft\\_retail_\\Wow.exe',
    installDir: 'C:\\Program Files (x86)\\World of Warcraft',
    hours: 0,
    steamAppId: null,
    iconPath: '',
  });
});

test('parseUninstallKey handles unquoted icon indexes and defaults the source', () => {
  const found = windows.parseUninstallKey({
    DisplayName: 'Plain Game',
    DisplayIcon: 'C:\\Games\\Plain\\plain.exe,0',
  });

  assert.equal(found.source, 'Windows');
  assert.equal(found.sourceId, 'windows:Plain Game');
  assert.equal(found.exePath, 'C:\\Games\\Plain\\plain.exe');
});

test('parseUninstallKey returns null without a DisplayName or path', () => {
  assert.equal(windows.parseUninstallKey({ DisplayName: 'Name Only' }), null);
  assert.equal(windows.parseUninstallKey({ DisplayIcon: 'C:\\Games\\Nameless\\game.exe' }), null);
  assert.equal(windows.parseUninstallKey(null), null);
});

// ---------------------------------------------------------------------------
// Xbox / Microsoft Store
// ---------------------------------------------------------------------------

test('parseXboxApps keeps games and drops built-in system packages', () => {
  const installLocation = 'C:\\Program Files\\WindowsApps\\Microsoft.ForzaHorizon5_1.0.0.0_x64__8wekyb3d8bbwe';
  const apps = [
    {
      Name: 'Microsoft.ForzaHorizon5',
      PackageFamilyName: 'Microsoft.ForzaHorizon5_8wekyb3d8bbwe',
      InstallLocation: installLocation,
    },
    {
      Name: 'Microsoft.WindowsStore',
      PackageFamilyName: 'Microsoft.WindowsStore_8wekyb3d8bbwe',
      InstallLocation: 'C:\\Program Files\\WindowsApps\\Microsoft.WindowsStore_8wekyb3d8bbwe',
    },
    {
      Name: 'Microsoft.DesktopAppInstaller',
      PackageFamilyName: 'Microsoft.DesktopAppInstaller_8wekyb3d8bbwe',
      InstallLocation: 'C:\\Program Files\\WindowsApps\\Microsoft.DesktopAppInstaller_8wekyb3d8bbwe',
    },
  ];

  const found = windows.parseXboxApps(apps);

  assert.equal(found.length, 1);
  assert.deepEqual(found[0], {
    name: 'Forza Horizon 5',
    source: 'Xbox',
    sourceId: 'xbox:Microsoft.ForzaHorizon5_8wekyb3d8bbwe',
    exePath: 'shell:AppsFolder\\Microsoft.ForzaHorizon5_8wekyb3d8bbwe!App',
    installDir: installLocation,
    hours: 0,
    steamAppId: null,
    iconPath: '',
  });
});

test('parseXboxApps accepts a single package object and ignores non-Microsoft packages', () => {
  const single = {
    Name: 'Microsoft.MinecraftUWP',
    PackageFamilyName: 'Microsoft.MinecraftUWP_8wekyb3d8bbwe',
    InstallLocation: 'C:\\Games\\Minecraft',
  };

  const found = windows.parseXboxApps(single);
  assert.equal(found.length, 1);
  assert.equal(found[0].name, 'Minecraft UWP');

  assert.deepEqual(windows.parseXboxApps([
    {
      Name: 'BethesdaSoftworks.Starfield',
      PackageFamilyName: 'BethesdaSoftworks.Starfield_8wekyb3d8bbwe',
      InstallLocation: 'C:\\Games\\Starfield',
    },
  ]), []);
  assert.deepEqual(windows.parseXboxApps(null), []);
});

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

test('scanWindowsSource is inert off Windows', {
  skip: process.platform === 'win32' ? 'Windows host' : false,
}, () => {
  for (const id of ['epic', 'gog', 'xbox', 'battlenet', 'ea', 'ubisoft', 'unknown']) {
    assert.deepEqual(windows.scanWindowsSource(id), []);
  }
  assert.deepEqual(windows.scanWindowsSource(), []);
});
