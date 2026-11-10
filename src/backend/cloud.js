/* GameVault cloud features for a signed-in user (see account.js for sign-in):
 *
 *   syncLibrary(games)  merge this PC's library with the cloud copy
 *                       (library-merge.js) and upload the result
 *   backupSaves(...)    pack a save folder, gzip, encrypt with the user's key
 *                       (AES-256-GCM, on this PC), upload to storage bucket
 *                       "saves", keep the newest KEEP copies per game
 *   listBackups / restoreBackup / deleteBackup
 *
 * Backend: tables library_sync, cloud_keys, save_backups and the private
 * "saves" bucket (cloud/supabase/migrations/20261110170000_cloud_features.sql).
 * No Electron imports.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { mergeLibrary, hash } = require('./library-merge.js');

const KEEP = 3;
const MAX_UPLOAD = 50 * 1024 * 1024; // bucket limit
const MAX_RAW = 400 * 1024 * 1024;
const MAX_FILES = 20000;
const PACK_MAGIC = Buffer.from('GVS1');
const ENC_MAGIC = Buffer.from('GVE1');

const err = (code, message) => Object.assign(new Error(message), { code });

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
}
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value));
  fs.renameSync(tmp, file);
}

// ------------------------------------------------------------ archive format
// GVS1 | u32 manifest length | manifest JSON {files:[{p, size, mtime}]} | file bytes...

function listFiles(root) {
  const files = [];
  let total = 0;
  const walk = (dir, rel, depth) => {
    if (depth > 16) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { throw err('READ', `Can’t read ${dir}: ${e.message}`); }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) walk(full, r, depth + 1);
      else if (e.isFile()) {
        const st = fs.statSync(full);
        total += st.size;
        files.push({ p: r, size: st.size, mtime: Math.round(st.mtimeMs), full });
        if (files.length > MAX_FILES) throw err('TOO_BIG', 'That save folder has too many files to back up.');
        if (total > MAX_RAW) throw err('TOO_BIG', 'That save folder is too big to back up (over 400 MB).');
      }
    }
  };
  walk(root, '', 0);
  files.sort((a, b) => (a.p < b.p ? -1 : 1));
  return { files, total };
}

const manifestHash = (files) => hash(files.map(({ p, size, mtime }) => [p, size, mtime]));

function pack(files) {
  const manifest = Buffer.from(JSON.stringify({ files: files.map(({ p, size, mtime }) => ({ p, size, mtime })) }));
  const len = Buffer.alloc(4);
  len.writeUInt32BE(manifest.length);
  return Buffer.concat([PACK_MAGIC, len, manifest, ...files.map((f) => {
    const b = fs.readFileSync(f.full);
    if (b.length !== f.size) throw err('READ', `${f.p} changed while backing up. Close the game and try again.`);
    return b;
  })]);
}

function unpack(buf) {
  if (!buf.subarray(0, 4).equals(PACK_MAGIC)) throw err('CORRUPT', 'This backup is damaged.');
  const n = buf.readUInt32BE(4);
  const manifest = JSON.parse(buf.subarray(8, 8 + n).toString('utf8'));
  let off = 8 + n;
  return manifest.files.map((f) => {
    const data = buf.subarray(off, off + f.size);
    off += f.size;
    return { ...f, data };
  });
}

function encrypt(plain, key) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([ENC_MAGIC, iv, c.getAuthTag(), body]);
}

function decrypt(blob, key) {
  if (!blob.subarray(0, 4).equals(ENC_MAGIC)) throw err('CORRUPT', 'This backup is damaged.');
  const d = crypto.createDecipheriv('aes-256-gcm', key, blob.subarray(4, 16));
  d.setAuthTag(blob.subarray(16, 32));
  try { return Buffer.concat([d.update(blob.subarray(32)), d.final()]); } catch (_) {
    throw err('CORRUPT', 'This backup can’t be opened with your account’s key.');
  }
}

/** Relative archive path -> absolute path inside root, or null if it escapes. */
function safeJoin(root, rel) {
  if (typeof rel !== 'string' || !rel || rel.includes('\0')) return null;
  const parts = rel.split('/');
  if (parts.some((s) => !s || s === '.' || s === '..' || /[<>:"|?*]/.test(s))) return null;
  const full = path.resolve(root, ...parts);
  const base = path.resolve(root) + path.sep;
  return full.startsWith(base) ? full : null;
}

/**
 * @param {object} opts
 * @param {string} opts.dir            local state folder (<userData>/cloud)
 * @param {string} opts.cloudUrl
 * @param {string} opts.anonKey
 * @param {object} opts.account        from createAccount()
 * @param {string} [opts.device]       shown next to backups ("Isaac's PC")
 * @param {Function} [opts.protect]    (string) => string, encrypt local secrets
 * @param {Function} [opts.unprotect]
 * @param {Function} [opts.fetch]
 * @param {Function} [opts.now]
 */
function createCloud(opts) {
  const { dir, account } = opts;
  const cloudUrl = String(opts.cloudUrl || '').replace(/\/+$/, '');
  const anonKey = String(opts.anonKey || '');
  const doFetch = opts.fetch || globalThis.fetch;
  const now = opts.now || Date.now;
  const device = String(opts.device || 'PC').slice(0, 120);
  const protect = opts.protect || ((s) => s);
  const unprotect = opts.unprotect || ((s) => s);

  async function who() {
    const access = await account.token();
    const st = account.status();
    if (!access || !st.signedIn || !st.user || !st.user.id) throw err('SIGNED_OUT', 'Sign in to use cloud features.');
    return { access, uid: st.user.id };
  }

  async function call(method, url, { body, headers = {}, raw = false, access } = {}) {
    let res;
    try {
      res = await doFetch(`${cloudUrl}${url}`, {
        method,
        headers: {
          apikey: anonKey,
          Authorization: `Bearer ${access}`,
          ...(body !== undefined && !Buffer.isBuffer(body) ? { 'Content-Type': 'application/json' } : {}),
          ...headers,
        },
        body: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body),
        signal: AbortSignal.timeout(120_000),
      });
    } catch (e) {
      throw err('NETWORK', 'Can’t reach Gamevault Cloud. Check your connection.');
    }
    if (!res.ok) {
      const j = await res.json().catch(() => null);
      const msg = (j && (j.message || j.msg || j.error)) || `Cloud error ${res.status}`;
      throw Object.assign(err(res.status === 409 ? 'CONFLICT' : res.status === 401 || res.status === 403 ? 'DENIED' : res.status === 413 ? 'TOO_BIG' : 'SERVER', msg), { status: res.status });
    }
    if (raw) return Buffer.from(await res.arrayBuffer());
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }

  // ------------------------------------------------------------- library

  const syncFile = (uid) => path.join(dir, `sync-${uid}.json`);

  async function syncLibrary(localGames) {
    const { access, uid } = await who();
    const state = readJson(syncFile(uid)) || {};
    for (let attempt = 0; attempt < 3; attempt++) {
      const rows = await call('GET', `/rest/v1/library_sync?select=data,version&user_id=eq.${uid}`, { access });
      const row = rows && rows[0];
      const merged = mergeLibrary({ local: localGames, remote: row ? row.data : null, base: state.base, now: now() });
      const unchanged = row && hash(row.data) === hash(merged.upload);
      if (!unchanged) {
        const payload = { data: merged.upload, device, updated_at: new Date(now()).toISOString() };
        let ok;
        if (row) {
          ok = await call('PATCH', `/rest/v1/library_sync?user_id=eq.${uid}&version=eq.${row.version}`, {
            access, body: { ...payload, version: row.version + 1 }, headers: { Prefer: 'return=representation' },
          });
          if (!ok || !ok.length) continue; // another PC wrote in between: merge again
        } else {
          try {
            await call('POST', '/rest/v1/library_sync', { access, body: { ...payload, user_id: uid }, headers: { Prefer: 'return=minimal' } });
          } catch (e) {
            if (e.code === 'CONFLICT') continue;
            throw e;
          }
        }
      }
      const at = now();
      writeJson(syncFile(uid), { base: merged.base, at });
      return { games: merged.games, stats: merged.stats, at, uploaded: !unchanged };
    }
    throw err('BUSY', 'Another PC is syncing right now. Try again in a moment.');
  }

  function lastSync() {
    const st = account.status();
    if (!st.signedIn || !st.user) return null;
    const s = readJson(syncFile(st.user.id));
    return s ? s.at : null;
  }

  // ------------------------------------------------------------- key

  let keyCache = null; // { uid, key }

  async function saveKey(access, uid) {
    if (keyCache && keyCache.uid === uid) return keyCache.key;
    const file = path.join(dir, `key-${uid}.bin`);
    try {
      const local = unprotect(fs.readFileSync(file, 'utf8').trim());
      if (local) { keyCache = { uid, key: Buffer.from(local, 'base64') }; return keyCache.key; }
    } catch (_) {}
    let rows = await call('GET', `/rest/v1/cloud_keys?select=save_key&user_id=eq.${uid}`, { access });
    let b64 = rows && rows[0] && rows[0].save_key;
    if (!b64) {
      const fresh = crypto.randomBytes(32).toString('base64');
      try {
        await call('POST', '/rest/v1/cloud_keys', { access, body: { user_id: uid, save_key: fresh }, headers: { Prefer: 'return=minimal' } });
        b64 = fresh;
      } catch (e) {
        if (e.code !== 'CONFLICT') throw e; // another PC made one first
        rows = await call('GET', `/rest/v1/cloud_keys?select=save_key&user_id=eq.${uid}`, { access });
        b64 = rows && rows[0] && rows[0].save_key;
      }
    }
    if (!b64) throw err('SERVER', 'Couldn’t set up your save encryption key.');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, protect(b64));
    keyCache = { uid, key: Buffer.from(b64, 'base64') };
    return keyCache.key;
  }

  // ------------------------------------------------------------- saves

  const savesFile = path.join(dir, 'saves-state.json');
  const safeId = (id) => String(id).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80);

  async function listBackups(gameId) {
    const { access, uid } = await who();
    return call('GET', `/rest/v1/save_backups?select=id,object_path,size,files,device,created_at&user_id=eq.${uid}&game_id=eq.${encodeURIComponent(String(gameId))}&order=created_at.desc`, { access });
  }

  async function removeBackup(access, row) {
    await call('DELETE', '/storage/v1/object/saves', { access, body: { prefixes: [row.object_path] } }).catch(() => {});
    await call('DELETE', `/rest/v1/save_backups?id=eq.${row.id}`, { access });
  }

  /** @returns {{skipped?: true, backup?: object}} */
  async function backupSaves({ gameId, gameName, saveDir, force = false }) {
    if (!saveDir || !fs.existsSync(saveDir) || !fs.statSync(saveDir).isDirectory()) throw err('NO_FOLDER', 'The save folder isn’t there anymore. Pick it again.');
    const { access, uid } = await who();
    const { files, total } = listFiles(saveDir);
    if (!files.length) throw err('EMPTY', 'That save folder is empty.');
    const mh = manifestHash(files);
    const state = readJson(savesFile) || {};
    const key = `${uid}:${gameId}`;
    if (!force && state[key] && state[key].hash === mh) return { skipped: true };
    const blob = encrypt(zlib.gzipSync(pack(files), { level: 6 }), await saveKey(access, uid));
    if (blob.length > MAX_UPLOAD) throw err('TOO_BIG', `Those saves are ${Math.round(blob.length / 1048576)} MB packed; the limit is 50 MB.`);
    const objectPath = `${uid}/${safeId(gameId)}/${now()}.gvs`;
    await call('POST', `/storage/v1/object/saves/${objectPath}`, { access, body: blob, headers: { 'Content-Type': 'application/octet-stream', 'x-upsert': 'false' } });
    let row;
    try {
      [row] = await call('POST', '/rest/v1/save_backups', {
        access,
        body: { user_id: uid, game_id: String(gameId), game_name: String(gameName || '').slice(0, 300), object_path: objectPath, size: blob.length, files: files.length, device },
        headers: { Prefer: 'return=representation' },
      });
    } catch (e) {
      await call('DELETE', '/storage/v1/object/saves', { access, body: { prefixes: [objectPath] } }).catch(() => {});
      throw e;
    }
    state[key] = { hash: mh, at: now() };
    writeJson(savesFile, state);
    // keep the newest KEEP
    const all = await listBackups(gameId).catch(() => []);
    for (const old of (all || []).slice(KEEP)) await removeBackup(access, old).catch(() => {});
    return { backup: row, rawBytes: total };
  }

  /** Restore into saveDir. The current files are copied aside first. */
  async function restoreBackup({ gameId, backupId, saveDir }) {
    if (!saveDir) throw err('NO_FOLDER', 'Pick the game’s save folder first.');
    const { access, uid } = await who();
    const rows = await call('GET', `/rest/v1/save_backups?select=id,object_path,created_at&id=eq.${encodeURIComponent(backupId)}&user_id=eq.${uid}`, { access });
    const row = rows && rows[0];
    if (!row) throw err('NOT_FOUND', 'That backup is gone.');
    const blob = await call('GET', `/storage/v1/object/authenticated/saves/${row.object_path}`, { access, raw: true });
    const files = unpack(zlib.gunzipSync(decrypt(blob, await saveKey(access, uid))));
    const targets = files.map((f) => ({ f, to: safeJoin(saveDir, f.p) }));
    if (targets.some((t) => !t.to)) throw err('CORRUPT', 'This backup has a file path GameVault won’t write. Nothing was changed.');
    let safety = null;
    if (fs.existsSync(saveDir)) {
      safety = path.join(dir, 'before-restore', safeId(gameId), String(now()));
      fs.mkdirSync(path.dirname(safety), { recursive: true });
      fs.cpSync(saveDir, safety, { recursive: true });
    }
    for (const { f, to } of targets) {
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.writeFileSync(to, f.data);
      try { fs.utimesSync(to, new Date(f.mtime), new Date(f.mtime)); } catch (_) {}
    }
    const state = readJson(savesFile) || {};
    try { state[`${uid}:${gameId}`] = { hash: manifestHash(listFiles(saveDir).files), at: now() }; writeJson(savesFile, state); } catch (_) {}
    return { files: files.length, safety, from: row.created_at };
  }

  async function deleteBackup(backupId) {
    const { access, uid } = await who();
    const rows = await call('GET', `/rest/v1/save_backups?select=id,object_path&id=eq.${encodeURIComponent(backupId)}&user_id=eq.${uid}`, { access });
    if (rows && rows[0]) await removeBackup(access, rows[0]);
    return true;
  }

  return { syncLibrary, lastSync, backupSaves, listBackups, restoreBackup, deleteBackup };
}

module.exports = { createCloud, pack, unpack, encrypt, decrypt, safeJoin, listFiles };
