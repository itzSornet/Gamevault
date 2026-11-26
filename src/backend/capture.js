// Screenshots and clips from a global shortcut, with no window on top of the
// game. A screenshot is grabbed here in main; a clip is recorded by a hidden
// window (MediaRecorder lives in a page) that streams it to disk as it goes,
// so a long clip never sits in memory. Each capture is tagged with the game
// that was running, in captures.json next to the files.
const { BrowserWindow, desktopCapturer, screen, ipcMain, Notification } = require('electron');
const fs = require('fs');
const path = require('path');
const { writeJsonAtomicSync } = require('./data.js');

let opts = null;
let recWin = null;
let rec = null; // { part, file, game, stopping }

const INDEX = 'captures.json';

function slug(name) {
  const s = String(name || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  return s || 'Desktop';
}

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

function dir() {
  const d = opts.mediaDir();
  fs.mkdirSync(d, { recursive: true });
  return d;
}

// two captures in the same second get "-2", "-3"
function freshPath(base, ext) {
  const d = dir();
  let p = path.join(d, `${base}.${ext}`);
  for (let i = 2; fs.existsSync(p) || fs.existsSync(p + '.part'); i++) p = path.join(d, `${base}-${i}.${ext}`);
  return p;
}

function readIndex() {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(opts.mediaDir(), INDEX), 'utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch (_) { return {}; }
}

function tag(file, game) {
  if (!game) return;
  try {
    const idx = readIndex();
    idx[path.basename(file)] = { gameId: String(game.id) };
    writeJsonAtomicSync(path.join(dir(), INDEX), idx);
  } catch (e) { console.warn('[capture] tag:', e.message); }
}

function untag(file) {
  try {
    const idx = readIndex();
    const name = path.basename(file);
    if (!(name in idx)) return;
    delete idx[name];
    writeJsonAtomicSync(path.join(dir(), INDEX), idx);
  } catch (_) { /* the index is only a hint */ }
}

function notify(title, body) {
  try {
    if (!Notification.isSupported()) return;
    new Notification({ title, body: body || '', silent: true }).show();
  } catch (_) { /* no notification is fine */ }
}

// the screen the player is on: where the pointer is
function currentDisplay() {
  return screen.getDisplayNearestPoint(screen.getCursorScreenPoint()) || screen.getPrimaryDisplay();
}

async function screenSource(withThumb) {
  const d = currentDisplay();
  const thumbnailSize = withThumb
    ? { width: Math.round(d.size.width * d.scaleFactor), height: Math.round(d.size.height * d.scaleFactor) }
    : { width: 0, height: 0 };
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize });
  return sources.find((s) => String(s.display_id) === String(d.id)) || sources[0] || null;
}

let shooting = false;
async function screenshot() {
  if (shooting) return;
  shooting = true;
  try {
    const src = await screenSource(true);
    if (!src || src.thumbnail.isEmpty()) throw new Error('No screen to capture');
    const game = opts.currentGame();
    const file = freshPath(`${slug(game && game.name)}_${stamp()}`, 'png');
    fs.writeFileSync(file, src.thumbnail.toPNG());
    tag(file, game);
    opts.onChange();
    notify('Screenshot saved', game ? game.name : 'Find it in GameVault under Captures');
  } catch (e) {
    console.warn('[capture] screenshot:', e.message);
    notify('Screenshot failed', e.message);
  } finally {
    shooting = false;
  }
}

function ensureRecWin() {
  if (recWin && !recWin.isDestroyed()) return Promise.resolve(recWin);
  recWin = new BrowserWindow({
    show: false,
    width: 320,
    height: 200,
    skipTaskbar: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'capture-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false, // it records while hidden
    },
  });
  recWin.on('closed', () => { recWin = null; });
  return recWin.loadFile(path.join(__dirname, '..', 'capture.html')).then(() => recWin);
}

function setRecording(on) {
  opts.onRecording(on, rec && rec.game ? rec.game.name : '');
}

async function toggleRecording() {
  if (rec) { stopRecording(); return; }
  try {
    const src = await screenSource(false);
    if (!src) throw new Error('No screen to record');
    // full size: left alone, desktop capture records at 1280 x 720
    const d = currentDisplay();
    const width = Math.round(d.size.width * d.scaleFactor);
    const height = Math.round(d.size.height * d.scaleFactor);
    const game = opts.currentGame();
    const file = freshPath(`${slug(game && game.name)}_${stamp()}`, 'webm');
    const part = file + '.part';
    fs.writeFileSync(part, Buffer.alloc(0));
    rec = { part, file, game, stopping: false };
    const w = await ensureRecWin();
    const cfg = opts.config();
    w.webContents.send('cap:start', { sourceId: src.id, width, height, audio: cfg.captureGameAudio !== false, mic: cfg.captureMic === true });
  } catch (e) {
    console.warn('[capture] record:', e.message);
    if (rec) { try { fs.rmSync(rec.part, { force: true }); } catch (_) {} }
    rec = null;
    notify('Recording failed', e.message);
  }
}

function stopRecording() {
  if (!rec || rec.stopping) return;
  rec.stopping = true;
  if (recWin && !recWin.isDestroyed()) recWin.webContents.send('cap:stop');
  else finish({ ok: false, error: 'The recorder closed' });
}

function finish(result) {
  const r = rec;
  rec = null;
  setRecording(false);
  if (!r) return;
  let size = 0;
  try { size = fs.statSync(r.part).size; } catch (_) {}
  if (!result || !result.ok || size === 0) {
    try { fs.rmSync(r.part, { force: true }); } catch (_) {}
    notify('Recording failed', (result && result.error) || 'Nothing was recorded');
    return;
  }
  try {
    fs.renameSync(r.part, r.file);
    tag(r.file, r.game);
    opts.onChange();
    notify('Clip saved', r.game ? r.game.name : 'Find it in GameVault under Captures');
  } catch (e) {
    notify('Recording failed', e.message);
  }
}

function setup(o) {
  opts = o;
  ipcMain.on('cap:started', (e) => {
    if (!rec || !recWin || e.sender !== recWin.webContents) return;
    setRecording(true);
    notify('Recording', `${rec.game ? rec.game.name + ' · ' : ''}press the record shortcut again to stop`);
  });
  ipcMain.on('cap:chunk', (e, buf) => {
    if (!rec || !recWin || e.sender !== recWin.webContents) return;
    try { fs.appendFileSync(rec.part, Buffer.from(buf)); } catch (err) {
      console.warn('[capture] write:', err.message);
      stopRecording();
    }
  });
  ipcMain.on('cap:done', (e, result) => {
    if (!recWin || e.sender !== recWin.webContents) return;
    finish(result);
  });
}

// quitting mid-clip: stop and give the recorder a moment to write the end
function shutdown() {
  if (!rec) return Promise.resolve();
  stopRecording();
  return new Promise((resolve) => {
    const t0 = Date.now();
    const tick = () => (!rec || Date.now() - t0 > 3000 ? resolve() : setTimeout(tick, 100));
    tick();
  });
}

module.exports = { setup, screenshot, toggleRecording, stopRecording, shutdown, readIndex, untag, isRecording: () => !!rec };
