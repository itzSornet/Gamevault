const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { pathToFileURL } = require('url');

const DATA_PATH = path.join(app.getPath('userData'), 'games.json');
const CONFIG_PATH = path.join(app.getPath('userData'), 'config.json');
const AI_PROFILE_PATH = path.join(app.getPath('userData'), 'ai-profile.json');

// ---------------------------------------------------------------------------
// Durable JSON files
// ---------------------------------------------------------------------------
//
// Writes go to a temp file, are fsync'd, then renamed over the target, so a
// crash or power cut leaves either the old or the new file, never half of one.
// On Windows the rename is retried for ~1 s: antivirus scanners and OneDrive
// briefly hold new files open and the rename fails with EPERM/EBUSY/EACCES.

const RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
const RENAME_RETRY_MS = 1000;

function sleepSync(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch (_) {}
}

function renameWithRetrySync(from, to) {
  const deadline = Date.now() + RENAME_RETRY_MS;
  let delay = 15;
  for (;;) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (err) {
      if (process.platform !== 'win32' || !RETRY_CODES.has(err.code) || Date.now() >= deadline) throw err;
      sleepSync(delay);
      delay = Math.min(delay * 2, 200);
    }
  }
}

function writeFileAtomicSync(file, text) {
  const tmp = `${file}.tmp`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, text, null, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    renameWithRetrySync(tmp, file);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch (_) {}
    throw err;
  }
}

function writeJsonAtomicSync(file, value) {
  writeFileAtomicSync(file, JSON.stringify(value, null, 2));
}

// { state: 'missing' | 'ok' | 'corrupt' | 'unreadable', value?, error? }
// Reads are retried briefly on Windows for the same lock reasons as renames.
function readJsonFile(file) {
  const deadline = Date.now() + RENAME_RETRY_MS;
  let text;
  for (;;) {
    try {
      text = fs.readFileSync(file, 'utf-8');
      break;
    } catch (err) {
      if (err.code === 'ENOENT') return { state: 'missing' };
      if (process.platform === 'win32' && RETRY_CODES.has(err.code) && Date.now() < deadline) { sleepSync(50); continue; }
      return { state: 'unreadable', error: err };
    }
  }
  try {
    return { state: 'ok', value: JSON.parse(text.replace(/^\uFEFF/, '')) };
  } catch (err) {
    return { state: 'corrupt', error: err };
  }
}

function timestamp() { return new Date().toISOString().replace(/[:.]/g, '-'); }

// Keep a copy of a file we could not parse, once per distinct file version,
// so repeated loads (tray, background poll) do not pile up copies.
const quarantined = new Map(); // file -> "mtime:size"
function quarantineCorrupt(file) {
  try {
    const st = fs.statSync(file);
    const sig = `${st.mtimeMs}:${st.size}`;
    if (quarantined.get(file) === sig) return null;
    const dest = `${file}.corrupt-${timestamp()}`;
    fs.copyFileSync(file, dest);
    quarantined.set(file, sig);
    return dest;
  } catch (err) {
    console.warn('[data] could not preserve unreadable file', file, err.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Games
// ---------------------------------------------------------------------------

const BAK_PATH = `${DATA_PATH}.bak`;
// True once games.json is known to hold a valid library (we parsed it or wrote
// it). Only a known-good file is ever rotated into games.json.bak.
let dataFileVerified = false;

function loadGames() {
  const res = readJsonFile(DATA_PATH);
  if (res.state === 'missing') return [];
  if (res.state === 'ok' && Array.isArray(res.value)) {
    dataFileVerified = true;
    return res.value;
  }

  // Never answer [] for a library we simply failed to read: the next save
  // would wipe it. Preserve the bad file and fall back to the last good one.
  dataFileVerified = false;
  const why = res.error ? res.error.message : 'not a list of games';
  if (res.state !== 'unreadable') {
    const kept = quarantineCorrupt(DATA_PATH);
    if (kept) console.warn(`[data] games.json is unreadable (${why}); kept a copy at ${kept}`);
  } else {
    console.warn(`[data] games.json could not be read (${why})`);
  }

  const bak = readJsonFile(BAK_PATH);
  if (bak.state === 'ok' && Array.isArray(bak.value)) {
    console.warn('[data] restored the library from games.json.bak');
    if (res.state !== 'unreadable') {
      try {
        writeJsonAtomicSync(DATA_PATH, bak.value);
        dataFileVerified = true;
      } catch (err) {
        console.warn('[data] could not restore games.json:', err.message);
      }
    }
    return bak.value;
  }
  return [];
}

function rotateBackup() {
  if (!fs.existsSync(DATA_PATH)) return;
  if (!dataFileVerified) {
    const cur = readJsonFile(DATA_PATH);
    if (cur.state !== 'ok' || !Array.isArray(cur.value)) return; // never rotate a bad file over a good .bak
  }
  const tmp = `${BAK_PATH}.tmp`;
  fs.copyFileSync(DATA_PATH, tmp);
  renameWithRetrySync(tmp, BAK_PATH);
}

function saveGames(games) {
  if (!Array.isArray(games)) throw new TypeError('saveGames expects an array');
  try {
    rotateBackup();
  } catch (err) {
    console.warn('[data] could not rotate games.json.bak:', err.message);
  }
  writeJsonAtomicSync(DATA_PATH, games);
  dataFileVerified = true;
}

// ---------------------------------------------------------------------------
// Image cache
// ---------------------------------------------------------------------------

const IMAGE_TIMEOUT_MS = 10000;
const IMAGE_MAX_REDIRECTS = 3;
const IMAGE_FAIL_COOLDOWN_MS = 10 * 60 * 1000;
const IMAGE_CONCURRENCY = 6;
const failedImages = new Map(); // url -> failedAt
const inflightImages = new Map(); // filePath -> Promise<url>

function isRemoteUrl(url) {
  return typeof url === 'string' && (url.startsWith('http://') || url.startsWith('https://'));
}

function downloadBuffer(url, redirectsLeft) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? require('https') : require('http');
    let settled = false;
    const done = (fn, v) => { if (!settled) { settled = true; clearTimeout(timer); fn(v); } };
    let req;
    const timer = setTimeout(() => {
      if (req) req.destroy(new Error('Timed out'));
      done(reject, new Error('Timed out'));
    }, IMAGE_TIMEOUT_MS);
    try {
      req = proto.get(url, { headers: { 'User-Agent': 'GameVault/1.0' }, timeout: IMAGE_TIMEOUT_MS }, (res) => {
        const status = res.statusCode || 0;
        if (status >= 300 && status < 400 && res.headers.location && redirectsLeft > 0) {
          res.resume();
          let next;
          try { next = new URL(res.headers.location, url).href; } catch (e) { done(reject, e); return; }
          if (!isRemoteUrl(next)) { done(reject, new Error('Bad redirect')); return; }
          clearTimeout(timer);
          settled = true;
          downloadBuffer(next, redirectsLeft - 1).then(resolve, reject);
          return;
        }
        if (status !== 200) { res.resume(); done(reject, new Error(`Status: ${status}`)); return; }
        const data = [];
        res.on('data', (chunk) => data.push(chunk));
        res.on('aborted', () => done(reject, new Error('Download aborted')));
        res.on('error', (e) => done(reject, e));
        res.on('end', () => {
          if (res.complete === false) { done(reject, new Error('Download incomplete')); return; }
          done(resolve, Buffer.concat(data));
        });
      });
      req.on('timeout', () => req.destroy(new Error('Timed out')));
      req.on('error', (e) => done(reject, e));
    } catch (e) {
      done(reject, e);
    }
  });
}

async function cacheImage(url, prefix) {
  if (!isRemoteUrl(url)) return url;

  const cacheDir = path.join(path.dirname(DATA_PATH), 'artworks_cache');
  if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });

  let ext = '.jpg';
  try { ext = path.extname(new URL(url).pathname) || '.jpg'; } catch (e) {}
  if (!/^\.[a-z0-9]{1,5}$/i.test(ext)) ext = '.jpg';
  const safePrefix = String(prefix || 'art').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80);
  const filename = `${safePrefix}_${crypto.createHash('md5').update(url).digest('hex')}${ext}`;
  const filePath = path.join(cacheDir, filename);

  if (fs.existsSync(filePath)) return pathToFileURL(filePath).href;

  const failedAt = failedImages.get(url);
  if (failedAt && Date.now() - failedAt < IMAGE_FAIL_COOLDOWN_MS) return url;

  if (inflightImages.has(filePath)) return inflightImages.get(filePath);
  const job = (async () => {
    try {
      const buffer = await downloadBuffer(url, IMAGE_MAX_REDIRECTS);
      const tmp = `${filePath}.part`;
      fs.writeFileSync(tmp, buffer);
      renameWithRetrySync(tmp, filePath);
      failedImages.delete(url);
      return pathToFileURL(filePath).href;
    } catch (e) {
      failedImages.set(url, Date.now());
      console.warn('Failed to cache image:', url, e.message);
      return url;
    } finally {
      inflightImages.delete(filePath);
    }
  })();
  inflightImages.set(filePath, job);
  return job;
}

async function cacheGameImages(games) {
  const jobs = [];
  for (const g of games || []) {
    if (!g) continue;
    if (isRemoteUrl(g.coverUrl)) jobs.push([g, 'coverUrl', `cover_${g.id}`]);
    if (isRemoteUrl(g.heroUrl)) jobs.push([g, 'heroUrl', `hero_${g.id}`]);
  }
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const [g, field, prefix] = jobs[next++];
      const original = g[field];
      const local = await cacheImage(original, prefix);
      if (g[field] === original) g[field] = local;
    }
  };
  await Promise.all(Array.from({ length: Math.min(IMAGE_CONCURRENCY, jobs.length) }, worker));
}

// Older builds stored `file://` + the raw path (C:/Users/A B/x#1.jpg), which is
// not a valid URL. Returns the proper file URL, or null when nothing changes.
function normalizeLegacyFileUrl(value) {
  if (typeof value !== 'string' || !value.startsWith('file://')) return null;
  let raw = value.slice('file://'.length);
  if (/%[0-9a-f]{2}/i.test(raw)) return null; // already encoded
  if (process.platform === 'win32' && /^\/[A-Za-z]:[\\/]/.test(raw)) raw = raw.slice(1);
  if (process.platform === 'win32') raw = raw.replace(/\//g, '\\');
  if (!path.isAbsolute(raw)) return null;
  let href;
  try {
    if (!fs.existsSync(raw)) return null;
    href = pathToFileURL(raw).href;
  } catch (_) { return null; }
  return href !== value ? href : null;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const CONFIG_DEFAULTS = {
  sgdbKey: '',
  deepseekKey: '',
  overlayHotkey: 'Shift+Alt+G',
  aiEnabled: false,
  aiProvider: null,
  aiKey: '',
  aiCustomEndpoint: '',
  aiCustomModel: '',
  cornerRadius: 14
};

function loadConfig() {
  const res = readJsonFile(CONFIG_PATH);
  if (res.state === 'ok' && res.value && typeof res.value === 'object' && !Array.isArray(res.value)) {
    return { ...CONFIG_DEFAULTS, ...res.value };
  }
  if (res.state === 'corrupt' || res.state === 'ok') {
    const kept = quarantineCorrupt(CONFIG_PATH);
    if (kept) console.warn(`[data] config.json is unreadable; kept a copy at ${kept}`);
  }
  return { ...CONFIG_DEFAULTS };
}

function saveConfig(cfg) {
  writeJsonAtomicSync(CONFIG_PATH, cfg);
}

// Merge-patch: keys the caller did not send (or sent as undefined) keep the
// value on disk, so a stale renderer snapshot cannot wipe keys main wrote
// meanwhile (sgdbKey, startupEnabled, snooze state...). Returns the result.
function mergeConfig(patch) {
  const merged = { ...loadConfig() };
  if (patch && typeof patch === 'object' && !Array.isArray(patch)) {
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue;
      merged[key] = value;
    }
  }
  saveConfig(merged);
  return merged;
}

function aiLoadProfile() {
  const res = readJsonFile(AI_PROFILE_PATH);
  if (res.state === 'ok' && res.value) return res.value;
  return { preferences: { likedGenres: [], dislikedGenres: [], dislikedGames: [], recommendedBefore: [] }, chatHistory: [], pcSpecs: null };
}

function aiSaveProfile(profile, win, overlayWin) {
  writeJsonAtomicSync(AI_PROFILE_PATH, profile);
  if (win) win.webContents.send('ai:profile-updated', profile);
  if (overlayWin) overlayWin.webContents.send('ai:profile-updated', profile);
}

module.exports = {
  DATA_PATH, CONFIG_PATH, AI_PROFILE_PATH,
  loadGames, saveGames, cacheImage, cacheGameImages, normalizeLegacyFileUrl,
  loadConfig, saveConfig, mergeConfig,
  aiLoadProfile, aiSaveProfile,
  writeFileAtomicSync, writeJsonAtomicSync, readJsonFile,
};
