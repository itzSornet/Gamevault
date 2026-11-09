'use strict';

// A game whose folder is C:\Windows\System32 once made Stop kill lsass.exe,
// which restarts Windows. These guards must never let that happen again.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');

const platform = require('../src/backend/platform.js');

test('system processes are protected', () => {
  for (const n of ['lsass.exe', 'LSASS.EXE', 'csrss.exe', 'wininit.exe', 'winlogon.exe', 'svchost.exe', 'explorer.exe', 'dwm.exe', 'systemd']) {
    assert.equal(platform.isProtectedProcessName(n), true, n);
  }
  for (const n of ['cs2.exe', 'game.exe', 'eldenring.exe']) {
    assert.equal(platform.isProtectedProcessName(n), false, n);
  }
});

test('pidsForNames never returns protected processes', () => {
  const byName = new Map([['lsass.exe', [700]], ['csrss.exe', [500]], ['game.exe', [4242]]]);
  const pids = platform.pidsForNames({ byName }, ['lsass.exe', 'csrss.exe', 'game.exe']);
  assert.deepEqual(pids, [4242]);
});

test('shared system folders are never walked for game executables', { skip: process.platform !== 'win32' && 'Windows paths' }, () => {
  const winDir = process.env.SystemRoot || 'C:\\Windows';
  assert.equal(platform.isSharedSystemDir(winDir), true);
  assert.equal(platform.isSharedSystemDir(path.join(winDir, 'System32')), true);
  assert.equal(platform.isSharedSystemDir('C:\\'), true);
  if (process.env.ProgramFiles) assert.equal(platform.isSharedSystemDir(process.env.ProgramFiles), true);
  assert.equal(platform.isSharedSystemDir(os.homedir()), true);
  assert.equal(platform.isSharedSystemDir('D:\\SteamLibrary\\steamapps\\common\\Counter-Strike Global Offensive'), false);
  assert.deepEqual(platform.listLaunchableNamesSync(path.join(winDir, 'System32')), []);
});

test('shared system folders on Linux', { skip: process.platform === 'win32' && 'POSIX paths' }, () => {
  assert.equal(platform.isSharedSystemDir('/usr/bin'), true);
  assert.equal(platform.isSharedSystemDir('/'), true);
  assert.equal(platform.isSharedSystemDir(os.homedir()), true);
  assert.equal(platform.isSharedSystemDir(path.join(os.homedir(), 'Games', 'SomeGame')), false);
});
