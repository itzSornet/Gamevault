// Save backups kept on this PC: no account needed. Same archive format as the
// cloud ones (cloud.js pack/unpack), gzipped but not encrypted, since they
// never leave the machine. One folder per game under userData/save-copies.
//
//   backupSaves({ gameId, gameName, saveDir, force })  -> { skipped } | { backup }
//   listBackups(gameId)                                -> [{ id, created_at, size, files, device }]
//   restoreBackup({ gameId, backupId, saveDir })       -> { files, safety, from }
//   deleteBackup(backupId)                             -> true
//   overview()                                         -> { games: [...], problems: {} }
//   safetyFolder(gameId)                               -> folder with the saves a restore replaced, or null
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { promisify } = require('util');
const { pack, unpack, safeJoin, listFiles } = require('./cloud.js');

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);
const KEEP = 5;
const KEEP_SAFETY = 3;
const MAX_PACKED = 500 * 1024 * 1024;

const err = (code, message) => Object.assign(new Error(message), { code });
const safeId = (id) => String(id || '').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80) || 'game';
const hash = (v) => crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');
const manifestHash = (files) => hash(files.map(({ p, size, mtime }) => [p, size, mtime]));

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
}
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value));
  fs.renameSync(tmp, file);
}

/**
 * @param {object} opts
 * @param {string} opts.dir     where copies live (userData/save-copies)
 * @param {string} [opts.device] this PC's name, shown next to each copy
 * @param {Function} [opts.now]
 */
function createLocalSaves({ dir, device = 'This PC', now = () => Date.now() }) {
  const gameDir = (gameId) => path.join(dir, safeId(gameId));
  const stateFile = path.join(dir, 'state.json');
  const safetyDir = (gameId) => path.join(dir, 'before-restore', safeId(gameId));
  // a backup id is "<game folder>/<timestamp>": the file is <timestamp>.gvs
  const fileFor = (id) => {
    const m = /^([A-Za-z0-9_-]{1,80})\/(\d{10,16})$/.exec(String(id || ''));
    return m ? path.join(dir, m[1], `${m[2]}.gvs`) : null;
  };

  function note(gameId, patch) {
    try {
      const st = readJson(stateFile) || {};
      st[String(gameId)] = { ...(st[String(gameId)] || {}), ...patch };
      writeJson(stateFile, st);
    } catch (_) {}
  }

  function listBackups(gameId) {
    const d = gameDir(gameId);
    let names = [];
    try { names = fs.readdirSync(d).filter((n) => /^\d{10,16}\.gvs$/.test(n)); } catch (_) { return []; }
    const meta = (readJson(stateFile) || {})[String(gameId)] || {};
    const counts = meta.counts || {};
    return names
      .map((n) => {
        const t = Number(n.slice(0, -4));
        let size = 0;
        try { size = fs.statSync(path.join(d, n)).size; } catch (_) {}
        return { id: `${safeId(gameId)}/${t}`, created_at: new Date(t).toISOString(), size, files: counts[t] || null, device };
      })
      .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  }

  async function backupSaves({ gameId, gameName, saveDir, force = false }) {
    try {
      if (!gameId) throw err('BAD_INPUT', 'No game given.');
      if (!saveDir || !fs.existsSync(saveDir) || !fs.statSync(saveDir).isDirectory()) throw err('NO_FOLDER', 'The save folder isn’t there anymore. Pick it again.');
      const { files } = listFiles(saveDir);
      if (!files.length) throw err('EMPTY', 'That save folder is empty.');
      const mh = manifestHash(files);
      const st = (readJson(stateFile) || {})[String(gameId)] || {};
      if (!force && st.hash === mh && listBackups(gameId).length) return { skipped: true };
      const blob = await gzip(pack(files), { level: 6 });
      if (blob.length > MAX_PACKED) throw err('TOO_BIG', 'Those saves are too big to keep copies of (over 500 MB packed).');
      const t = now();
      const d = gameDir(gameId);
      fs.mkdirSync(d, { recursive: true });
      const file = path.join(d, `${t}.gvs`);
      const tmp = `${file}.part`;
      fs.writeFileSync(tmp, blob);
      fs.renameSync(tmp, file);
      const counts = { ...(st.counts || {}), [t]: files.length };
      // keep the newest KEEP
      const all = listBackups(gameId);
      for (const old of all.slice(KEEP)) {
        const f = fileFor(old.id);
        if (f) try { fs.rmSync(f, { force: true }); } catch (_) {}
        delete counts[Number(old.id.split('/')[1])];
      }
      note(gameId, { hash: mh, at: t, error: null, errorCode: null, counts, ...(gameName ? { name: String(gameName).slice(0, 300) } : {}) });
      return { backup: { id: `${safeId(gameId)}/${t}`, created_at: new Date(t).toISOString(), size: blob.length, files: files.length, device } };
    } catch (e) {
      if (gameId) note(gameId, { error: e.message, errorCode: e.code || 'ERROR', tried: now() });
      throw e;
    }
  }

  function pruneSafety(gameId) {
    try {
      const d = safetyDir(gameId);
      const all = fs.readdirSync(d).filter((n) => /^\d+$/.test(n)).sort((a, b) => Number(b) - Number(a));
      for (const old of all.slice(KEEP_SAFETY)) fs.rmSync(path.join(d, old), { recursive: true, force: true });
    } catch (_) {}
  }

  async function restoreBackup({ gameId, backupId, saveDir }) {
    if (!saveDir) throw err('NO_FOLDER', 'Pick the game’s save folder first.');
    const file = fileFor(backupId);
    if (!file || !fs.existsSync(file)) throw err('NOT_FOUND', 'That copy is gone.');
    const files = unpack(await gunzip(fs.readFileSync(file)));
    const targets = files.map((f) => ({ f, to: safeJoin(saveDir, f.p) }));
    if (targets.some((t) => !t.to)) throw err('CORRUPT', 'This copy has a file path GameVault won’t write. Nothing was changed.');
    let safety = null;
    if (fs.existsSync(saveDir)) {
      safety = path.join(safetyDir(gameId), String(now()));
      fs.mkdirSync(path.dirname(safety), { recursive: true });
      try {
        fs.cpSync(saveDir, safety, { recursive: true });
      } catch (e) {
        try { fs.rmSync(safety, { recursive: true, force: true }); } catch (_) {}
        throw err('READ', 'Couldn’t copy your current saves aside first, so nothing was changed. Close the game and try again.');
      }
      pruneSafety(gameId);
    }
    for (const { f, to } of targets) {
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.writeFileSync(to, f.data);
      try { fs.utimesSync(to, new Date(f.mtime), new Date(f.mtime)); } catch (_) {}
    }
    try { note(gameId, { hash: manifestHash(listFiles(saveDir).files), at: now() }); } catch (_) {}
    const t = Number(String(backupId).split('/')[1]);
    return { files: files.length, safety, from: new Date(t).toISOString() };
  }

  function deleteBackup(backupId) {
    const file = fileFor(backupId);
    if (file) try { fs.rmSync(file, { force: true }); } catch (_) {}
    // with no copy left, the next backup must not be skipped as "unchanged"
    const folder = String(backupId || '').split('/')[0];
    const st = readJson(stateFile) || {};
    for (const [gameId, v] of Object.entries(st)) {
      if (safeId(gameId) === folder && v && !listBackups(gameId).length) note(gameId, { hash: null });
    }
    return true;
  }

  function overview() {
    const st = readJson(stateFile) || {};
    const games = [];
    const problems = {};
    for (const [gameId, v] of Object.entries(st)) {
      if (!v || typeof v !== 'object') continue;
      const list = listBackups(gameId);
      if (list.length) {
        games.push({ gameId, gameName: v.name || '', copies: list.length, bytes: list.reduce((t, b) => t + (b.size || 0), 0), latest: list[0].created_at, device });
      }
      if (v.error) problems[gameId] = { message: v.error, code: v.errorCode || 'ERROR', at: v.tried || null };
    }
    return { games, problems };
  }

  function safetyFolder(gameId) {
    const d = safetyDir(gameId);
    try { return fs.readdirSync(d).length ? d : null; } catch (_) { return null; }
  }

  return { backupSaves, listBackups, restoreBackup, deleteBackup, overview, safetyFolder, folder: () => dir };
}

module.exports = { createLocalSaves };
