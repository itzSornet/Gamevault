const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const importers = require('../src/backend/importers.js');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gv-import-'));

function tmpFile(name, bytes) {
  const file = path.join(TMP_DIR, name);
  fs.writeFileSync(file, bytes);
  return file;
}

test('listSources exposes file and folder actions', () => {
  const sources = importers.listSources();
  assert.ok(Array.isArray(sources) && sources.length >= 3);
  const ids = sources.map((s) => s.id);
  assert.ok(ids.includes('folder'));
  assert.ok(ids.includes('file'));
  for (const s of sources) {
    assert.equal(typeof s.label, 'string');
    assert.equal(typeof s.found, 'boolean');
  }
});

test('sniffs an ELF header', () => {
  const buf = Buffer.alloc(64);
  buf[0] = 0x7f; buf[1] = 0x45; buf[2] = 0x4c; buf[3] = 0x46;
  const file = tmpFile('elf.bin', buf);
  const info = importers.sniffBinary(file);
  assert.ok(info);
  assert.equal(info.isElf, true);
  fs.rmSync(file, { force: true });
});

test('sniffs an AppImage header', () => {
  const buf = Buffer.alloc(64);
  buf[0] = 0x7f; buf[1] = 0x45; buf[2] = 0x4c; buf[3] = 0x46;
  buf[8] = 0x41; buf[9] = 0x49; buf[10] = 0x02;
  const file = tmpFile('app.AppImage', buf);
  const info = importers.sniffBinary(file);
  assert.ok(info);
  assert.equal(info.isAppImage, true);
  fs.rmSync(file, { force: true });
});

test('rejects a plain text file', () => {
  const file = tmpFile('notes.txt', 'hello world, not a game');
  assert.equal(importers.sniffBinary(file), null);
  fs.rmSync(file, { force: true });
});

test('accepts a .sh launcher', () => {
  const file = tmpFile('run.sh', '#!/bin/sh\nexec ./game\n');
  const info = importers.sniffBinary(file);
  assert.ok(info);
  assert.equal(info.ext, '.sh');
  fs.rmSync(file, { force: true });
});

test('ingestFile names a shell launcher after its file', () => {
  const file = tmpFile('my-game.sh', '#!/bin/sh\n');
  const candidate = importers.ingestFile(file);
  assert.equal(candidate.name, 'my game');
  assert.equal(candidate.source, 'File');
  assert.equal(candidate.exePath, file);
  assert.match(candidate.sourceId, /^file:/);
  fs.rmSync(file, { force: true });
});

test('ingestFile makes an ELF executable', () => {
  const buf = Buffer.alloc(64);
  buf[0] = 0x7f; buf[1] = 0x45; buf[2] = 0x4c; buf[3] = 0x46;
  const file = tmpFile('binary', buf);
  fs.chmodSync(file, 0o644);
  const candidate = importers.ingestFile(file);
  assert.ok(candidate);
  assert.equal(candidate.kind, 'ELF');
  assert.ok(fs.statSync(file).mode & 0o111);
  fs.rmSync(file, { force: true });
});
