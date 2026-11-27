// Captures other apps made: Steam's screenshot key, NVIDIA, AMD, Ubisoft
// Connect, the Xbox Game Bar, and games' own photo modes. Nothing is copied:
// the files stay where those apps saved them and GameVault lists them there.
//
// Two ways in:
//   - a scan of the folders those apps use, matched to a game by its Steam ID
//     (Steam) or by the game's name in the folder or file name (the others)
//   - while a game is running, a watch on the usual places a photo mode saves
//     to (Pictures, Videos, Documents, the game's own folder, Unreal's
//     Saved/Screenshots). A new picture or video there is tagged to that game.
// Tags and "not this game" choices live in captures-linked.json.
const { app, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');
const Fuzzy = require('../lib/fuzzy.js');
// loaded when first needed: data.js only loads inside Electron (keeps tests plain Node)
const writeJsonAtomicSync = (...a) => require('./data.js').writeJsonAtomicSync(...a);

const IMAGE = /\.(png|jpe?g|webp|bmp)$/i;
const VIDEO = /\.(mp4|webm|mkv|mov)$/i;
const MAX_ITEMS = 5000;
const SCAN_TTL_MS = 20 * 1000;
// folders full of small pictures that are never a capture
const SKIP_DIR = /^(cache|caches|cache2|temp|tmp|thumbnails?|thumbs|logs?|shadercache|gpucache|crashes|crashdumps|crashreports?|webcache|htmlcache|node_modules|\.git|icons?|avatars?|ui|textures?|mods?)$/i;

let opts = null; // { userDir, mediaDir, games, sessions, enabled, onChange }
let scanCache = { at: 0, items: null };
let known = new Map(); // lower-cased path -> path: what list() last handed out

const isWin = process.platform === 'win32';
const key = (p) => (isWin ? path.resolve(p).toLowerCase() : path.resolve(p));
const under = (dir, p) => {
  if (!dir) return false;
  const rel = path.relative(dir, p);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
};

function userPath(name) {
  try { return app.getPath(name); } catch (_) { return ''; }
}

// ---- tags --------------------------------------------------------------

function indexPath() { return path.join(opts.userDir(), 'captures-linked.json'); }

function readIndex() {
  try {
    const v = JSON.parse(fs.readFileSync(indexPath(), 'utf8'));
    return {
      files: v && v.files && typeof v.files === 'object' && !Array.isArray(v.files) ? v.files : {},
      hidden: v && Array.isArray(v.hidden) ? v.hidden.filter((x) => typeof x === 'string') : [],
    };
  } catch (_) { return { files: {}, hidden: [] }; }
}

function writeIndex(idx) {
  try { writeJsonAtomicSync(indexPath(), idx); } catch (e) { console.warn('[captures] index:', e.message); }
}

// ---- matching a name to a game ------------------------------------------

function nameMatcher(games) {
  const list = [];
  for (const g of games) {
    if (!g || !g.name) continue;
    const n = Fuzzy.normalize(g.name);
    if (n.length < 2) continue;
    list.push({ n, c: n.replace(/ /g, ''), id: String(g.id) });
  }
  // longest first: "Dark Souls III" before "Dark Souls"
  list.sort((a, b) => b.n.length - a.n.length);
  return (text) => {
    const t = Fuzzy.normalize(text);
    if (!t) return null;
    const tc = t.replace(/ /g, '');
    const words = t.split(' ');
    for (const e of list) {
      if (t === e.n || tc === e.c) return e.id;
      if (e.n.length >= 4 && t.startsWith(e.n + ' ')) return e.id;
      // HollowKnight 2024-01-05: the first words, run together, are the name
      if (e.c.length >= 6 && tc.startsWith(e.c)) {
        let run = '';
        for (const w of words) { run += w; if (run.length >= e.c.length) break; }
        if (run === e.c) return e.id;
      }
    }
    return null;
  };
}

// ---- where other apps keep captures ------------------------------------

function steamRoots() {
  try { return require('./scanner.js').getSteamRoots(); } catch (_) { return []; }
}

// Videos\NVIDIA\<Game>, Videos\Radeon ReLive\<Game>, Pictures\Ubisoft Connect\<Game>
function perGameFolders() {
  const videos = userPath('videos');
  const pictures = userPath('pictures');
  const out = [];
  if (videos) {
    out.push({ dir: path.join(videos, 'NVIDIA'), source: 'NVIDIA' });
    out.push({ dir: path.join(videos, 'Radeon ReLive'), source: 'AMD' });
  }
  if (pictures) {
    out.push({ dir: path.join(pictures, 'Ubisoft Connect'), source: 'Ubisoft Connect' });
    out.push({ dir: path.join(pictures, 'UbisoftConnect'), source: 'Ubisoft Connect' });
  }
  return out;
}

// Game Bar: Videos\Captures\<Game title> <date>.png
function gameBarFolder() {
  const videos = userPath('videos');
  return videos ? path.join(videos, 'Captures') : '';
}

// a readable name for where a file came from
function sourceFor(p) {
  for (const f of perGameFolders()) if (under(f.dir, p)) return f.source;
  if (under(gameBarFolder(), p)) return 'Xbox Game Bar';
  for (const r of steamRoots()) if (under(r, p)) return 'Steam';
  const pics = userPath('pictures');
  if (pics && under(path.join(pics, 'Screenshots'), p)) return 'Windows';
  return 'Photo mode';
}

function fileItem(full, gameId, source, thumb) {
  try {
    const st = fs.statSync(full);
    if (!st.isFile() || st.size === 0) return null;
    const url = require('url');
    return {
      name: path.basename(full),
      path: full,
      url: url.pathToFileURL(full).href,
      thumb: thumb ? url.pathToFileURL(thumb).href : null,
      time: st.mtimeMs,
      size: st.size,
      video: VIDEO.test(full),
      gameId: gameId ? String(gameId) : null,
      source,
      external: true,
    };
  } catch (_) { return null; }
}

function readDirSafe(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return []; }
}

function scanSteam(games, out) {
  const byApp = new Map();
  for (const g of games) if (g && g.steamAppId) byApp.set(String(g.steamAppId), String(g.id));
  if (!byApp.size) return;
  for (const root of steamRoots()) {
    for (const user of readDirSafe(path.join(root, 'userdata'))) {
      if (!user.isDirectory()) continue;
      const remote = path.join(root, 'userdata', user.name, '760', 'remote');
      for (const appDir of readDirSafe(remote)) {
        const gameId = appDir.isDirectory() && byApp.get(appDir.name);
        if (!gameId) continue;
        const shots = path.join(remote, appDir.name, 'screenshots');
        for (const f of readDirSafe(shots)) {
          if (!f.isFile() || !IMAGE.test(f.name)) continue;
          const thumb = path.join(shots, 'thumbnails', f.name);
          const it = fileItem(path.join(shots, f.name), gameId, 'Steam', fs.existsSync(thumb) ? thumb : null);
          if (it) out.push(it);
          if (out.length >= MAX_ITEMS) return;
        }
      }
    }
  }
}

function scanNamed(match, out) {
  for (const { dir, source } of perGameFolders()) {
    for (const e of readDirSafe(dir)) {
      if (out.length >= MAX_ITEMS) return;
      const full = path.join(dir, e.name);
      if (e.isFile()) {
        const id = (IMAGE.test(e.name) || VIDEO.test(e.name)) && match(e.name.replace(/\.[^.]+$/, ''));
        const it = id && fileItem(full, id, source);
        if (it) out.push(it);
        continue;
      }
      if (!e.isDirectory()) continue;
      const id = match(e.name);
      if (!id) continue;
      for (const f of readDirSafe(full)) {
        if (!f.isFile() || !(IMAGE.test(f.name) || VIDEO.test(f.name))) continue;
        const it = fileItem(path.join(full, f.name), id, source);
        if (it) out.push(it);
        if (out.length >= MAX_ITEMS) return;
      }
    }
  }
  const bar = gameBarFolder();
  for (const f of readDirSafe(bar)) {
    if (!f.isFile() || !(IMAGE.test(f.name) || VIDEO.test(f.name))) continue;
    const id = match(f.name.replace(/\.[^.]+$/, ''));
    const it = id && fileItem(path.join(bar, f.name), id, 'Xbox Game Bar');
    if (it) out.push(it);
    if (out.length >= MAX_ITEMS) return;
  }
}

// every capture other apps made, for games in the library
function list() {
  if (!opts || !opts.enabled()) { known = new Map(); return []; }
  const now = Date.now();
  if (scanCache.items && now - scanCache.at < SCAN_TTL_MS) return scanCache.items.slice();
  let games = [];
  try { games = opts.games() || []; } catch (_) {}
  const idx = readIndex();
  const hidden = new Set(idx.hidden.map(key));
  const own = opts.mediaDir();
  const byPath = new Map();
  const add = (it) => {
    if (!it || under(own, it.path)) return;
    const k = key(it.path);
    if (hidden.has(k)) return;
    byPath.set(k, it);
  };

  const scanned = [];
  try { scanSteam(games, scanned); } catch (e) { console.warn('[captures] steam:', e.message); }
  try { scanNamed(nameMatcher(games), scanned); } catch (e) { console.warn('[captures] folders:', e.message); }
  scanned.forEach(add);

  // picked up while playing: these know their game for sure, so they win
  let pruned = false;
  for (const [p, v] of Object.entries(idx.files)) {
    const it = fileItem(p, v && v.gameId, (v && v.source) || sourceFor(p));
    if (!it) { delete idx.files[p]; pruned = true; continue; }
    const prev = byPath.get(key(p));
    if (prev && prev.thumb) it.thumb = prev.thumb;
    add(it);
  }
  if (pruned) writeIndex(idx);

  const items = [...byPath.values()].sort((a, b) => b.time - a.time).slice(0, MAX_ITEMS);
  known = new Map(items.map((it) => [key(it.path), it.path]));
  scanCache = { at: now, items };
  return items.slice();
}

// a path list() handed out: the only outside files open/show/delete accept
function knownPath(p) {
  if (typeof p !== 'string' || !p) return null;
  return known.get(key(p)) || null;
}

function invalidate() { scanCache = { at: 0, items: null }; }

// "Not from this game": GameVault stops showing it; the file stays
function hide(p) {
  const real = knownPath(p);
  if (!real) return false;
  const idx = readIndex();
  delete idx.files[real];
  if (!idx.hidden.some((h) => key(h) === key(real))) idx.hidden.push(real);
  if (idx.hidden.length > 5000) idx.hidden = idx.hidden.slice(-5000);
  writeIndex(idx);
  invalidate();
  return true;
}

// the file was deleted
function forget(p) {
  const idx = readIndex();
  let changed = false;
  for (const f of Object.keys(idx.files)) if (key(f) === key(p)) { delete idx.files[f]; changed = true; }
  if (changed) writeIndex(idx);
  known.delete(key(p));
  invalidate();
}

// ---- watching while a game runs ------------------------------------------

let watchers = [];
let watchingFor = '';
let poll = null;
let idleSince = 0;
let lastSessions = [];
const pending = new Map(); // path -> timer

function watchDirs(sessions) {
  const dirs = [];
  const pics = userPath('pictures');
  const vids = userPath('videos');
  const docs = userPath('documents');
  if (pics) dirs.push(pics);
  if (vids) dirs.push(vids);
  if (docs) dirs.push(docs);
  for (const s of sessions) if (s.installDir) dirs.push(s.installDir);
  // Unreal games save to %LOCALAPPDATA%\<Game>\Saved\Screenshots
  const local = process.env.LOCALAPPDATA;
  if (local) {
    for (const e of readDirSafe(local)) {
      if (!e.isDirectory()) continue;
      const shots = path.join(local, e.name, 'Saved', 'Screenshots');
      try { if (fs.statSync(shots).isDirectory()) dirs.push(shots); } catch (_) {}
    }
  }
  // drop missing folders and ones inside another watched folder
  const real = dirs.filter((d) => { try { return fs.statSync(d).isDirectory(); } catch (_) { return false; } });
  return real.filter((d, i) => !real.some((o, j) => j !== i && (under(o, d) || (key(o) === key(d) && j < i))));
}

function skipPath(dir, full) {
  if (!(IMAGE.test(full) || VIDEO.test(full))) return true;
  if (/\.(part|tmp|crdownload)$/i.test(full)) return true;
  const own = opts.mediaDir();
  if (under(own, full)) return true;
  // Steam's own screenshots are scanned (its game folders are not skipped)
  for (const r of steamRoots()) if (under(path.join(r, 'userdata'), full)) return true;
  // only the folders below the watched one: C:\Temp\Games is fine
  return path.relative(dir, path.dirname(full)).split(path.sep).some((seg) => SKIP_DIR.test(seg));
}

// big enough to be a capture, not an icon or a texture
function looksLikeCapture(full, size) {
  if (VIDEO.test(full)) return size >= 256 * 1024;
  if (/\.(png|jpe?g)$/i.test(full)) {
    try {
      const s = nativeImage.createFromPath(full).getSize();
      return s.width >= 640 && s.height >= 360;
    } catch (_) { return false; }
  }
  return size >= 50 * 1024;
}

function sessionFor(full, sessions) {
  return sessions.find((s) => s.installDir && under(s.installDir, full)) || sessions[0] || null;
}

// wait for the file to stop growing (a clip being written), then tag it
function check(full, lastSize, tries) {
  pending.delete(full);
  let st;
  try { st = fs.statSync(full); } catch (_) { return; }
  if (!st.isFile()) return;
  if (st.size === 0 || st.size !== lastSize) {
    // up to ~30 minutes for a long recording
    if (tries < 600) pending.set(full, setTimeout(() => check(full, st.size, tries + 1), 3000));
    return;
  }
  let sessions = [];
  try { sessions = opts.sessions() || []; } catch (_) {}
  if (!sessions.length && idleSince) sessions = lastSessions; // just closed
  const s = sessionFor(full, sessions);
  if (!s) return;
  const born = Math.min(st.birthtimeMs || st.mtimeMs, st.mtimeMs);
  if (s.sessionStart && born < s.sessionStart - 5000) return; // was there before
  if (!looksLikeCapture(full, st.size)) return;
  const idx = readIndex();
  if (idx.hidden.some((h) => key(h) === key(full))) return;
  if (Object.keys(idx.files).some((f) => key(f) === key(full))) return;
  idx.files[full] = { gameId: String(s.gameId), source: sourceFor(full), at: Date.now() };
  writeIndex(idx);
  invalidate();
  opts.onChange();
}

function onEvent(dir, filename) {
  if (!filename) return;
  const full = path.join(dir, String(filename));
  if (skipPath(dir, full)) return;
  if (pending.has(full)) clearTimeout(pending.get(full));
  pending.set(full, setTimeout(() => check(full, -1, 0), 1500));
}

function startWatching(sessions) {
  stopWatching();
  for (const d of watchDirs(sessions)) {
    let w = null;
    try {
      w = fs.watch(d, { recursive: true, persistent: false }, (_, f) => onEvent(d, f));
    } catch (_) {
      // no recursive watch here (older Linux): the folder itself still helps
      try { w = fs.watch(d, { persistent: false }, (_, f) => onEvent(d, f)); } catch (__) { w = null; }
    }
    if (w) {
      w.on('error', () => { try { w.close(); } catch (_) {} });
      watchers.push(w);
    }
  }
  watchingFor = sessions.map((s) => `${s.gameId}:${s.installDir}`).join('|');
}

function stopWatching() {
  for (const w of watchers) { try { w.close(); } catch (_) {} }
  watchers = [];
  watchingFor = '';
  for (const t of pending.values()) clearTimeout(t);
  pending.clear();
}

function tick() {
  let sessions = [];
  try { sessions = opts.enabled() ? (opts.sessions() || []) : []; } catch (_) {}
  if (sessions.length) {
    idleSince = 0;
    lastSessions = sessions;
    const sig = sessions.map((s) => `${s.gameId}:${s.installDir}`).join('|');
    if (sig !== watchingFor) startWatching(sessions);
    return;
  }
  if (!watchers.length) return;
  // a photo can land just as the game closes: keep looking a little longer
  if (!idleSince) idleSince = Date.now();
  else if (Date.now() - idleSince > 30 * 1000) { stopWatching(); idleSince = 0; }
}

function setup(o) {
  opts = o;
  if (poll) clearInterval(poll);
  poll = setInterval(tick, 4000);
  if (poll.unref) poll.unref();
}

function shutdown() {
  if (poll) clearInterval(poll);
  poll = null;
  stopWatching();
}

module.exports = { setup, list, knownPath, hide, forget, invalidate, shutdown, _test: { nameMatcher } };
