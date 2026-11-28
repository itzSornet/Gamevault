// GameVault v1.3.1 - Main Process
const { app, BrowserWindow, ipcMain, dialog, shell, Tray, Menu, globalShortcut, nativeImage, safeStorage } = require('electron');
app.name = 'GameVault';
if (app.setName) app.setName('GameVault');
// Cap Chromium's disk caches: headless capture runs used to inflate them to GBs.
app.commandLine.appendSwitch('disk-cache-size', String(150 * 1024 * 1024));

const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');
const crypto = require('crypto');
const platform = require('./src/backend/platform.js');

const { DATA_PATH, loadGames, saveGames, lastLoadIssue, cacheImage, cacheGameImages, normalizeLegacyFileUrl, loadConfig, saveConfig, mergeConfig, publicConfig } = require('./src/backend/data.js');
const { resolveSteamInstallDir, findMainExe } = require('./src/backend/scanner.js');
const importers = require('./src/backend/importers.js');
const { onSessionEnd, setAfkMinutes, configureTracking, setTrackerWindow, startTracking, stopTracking, stopAllTracking, trackedProcesses, killGameProcesses, runningGameIds, runningSessions } = require('./src/backend/tracker.js');

const { initUpdater } = require('./src/backend/updater.js');
const { createSgdb } = require('./src/backend/sgdb.js');
const { createArtCache, installSgdbImageCaching } = require('./src/backend/art-cache.js');
const { createPrices } = require('./src/backend/prices.js');
const { createPeakLines } = require('./src/backend/peak-line.js');
const { cloudConfig } = require('./src/backend/cloud-config.js');
const { createAccount } = require('./src/backend/account.js');
const { createCloud } = require('./src/backend/cloud.js');
const { findSaveFolders } = require('./src/backend/save-locations.js');
const { steamAccounts } = require('./src/backend/save-roots.js');
const { httpsGet } = require('./src/backend/api.js');
const Fuzzy = require('./src/lib/fuzzy.js');
const Capture = require('./src/backend/capture.js');
const Finder = require('./src/backend/capture-finder.js');

let win = null;
let tray = null;
let forceQuit = false;
let bgPollInterval = null;

// Every games.json write goes through this queue, so an older snapshot can
// never land after a newer one (renderer saves, launch lastPlayed, backfill).
let gamesWriteTail = Promise.resolve();
function enqueueGamesWrite(task) {
  const run = gamesWriteTail.then(task);
  gamesWriteTail = run.catch((err) => { console.warn('[games] write failed:', err && err.message); });
  return run;
}

// Read-modify-write of one game, in queue order; tells the renderer what changed.
function patchGame(gameId, patch) {
  const sid = String(gameId);
  return enqueueGamesWrite(() => {
    const games = loadGames();
    const g = games.find((x) => String(x.id) === sid);
    if (!g) return null;
    const changed = { id: sid };
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined || g[k] === v) continue;
      g[k] = v;
      changed[k] = v;
    }
    if (Object.keys(changed).length === 1) return null;
    saveGames(games);
    if (win && !win.isDestroyed()) win.webContents.send('games:updated', changed);
    refreshTray();
    return changed;
  });
}

// Windows signing out, restarting or shutting down: Electron sends no
// before-quit then, and the process is ended right after the window's
// session-end event. Running sessions (and one in its wait after the game
// closed) are ended and written here, at once, so they are not lost. They are
// kept too, so a save the window still sends can't drop them.
let windowsEndingSessions = null;
function addEndedSessions(games, ended) {
  let changed = false;
  for (const e of ended || []) {
    const hours = e.discarded ? 0 : Math.max(0, Number(e.sessionHours) || 0);
    if (!(hours > 0)) continue;
    const g = games.find((x) => x && typeof x === 'object' && String(x.id) === String(e.gameId));
    if (!g) continue;
    if (!Array.isArray(g.sessions)) g.sessions = [];
    if (g.sessions.some((s) => s && s.start === e.sessionStart)) continue; // the window saved it already
    g.hours = (Number(g.hours) || 0) + hours;
    g.sessions.push({ start: e.sessionStart, end: e.sessionEnd, duration: hours });
    g.lastPlayed = e.sessionEnd || Date.now();
    changed = true;
  }
  return changed;
}
function saveSessionsOnWindowsEnd() {
  if (windowsEndingSessions) return;
  forceQuit = true;
  if (bgPollInterval) { clearInterval(bgPollInterval); bgPollInterval = null; }
  windowsEndingSessions = stopAllTracking().filter((e) => !e.discarded && e.sessionHours > 0);
  if (!windowsEndingSessions.length) return;
  try {
    const games = loadGames();
    if (addEndedSessions(games, windowsEndingSessions)) saveGames(games);
  } catch (err) {
    console.warn('[games] could not save sessions at sign-out:', err && err.message);
  }
}

// Download the remote covers of a saved library, then swap the local copies
// into games.json (only where the file still has that same web address).
let imageCacheRun = Promise.resolve();
function cacheImagesAfterSave(games) {
  const remote = /^https?:/i;
  const copies = (games || [])
    .filter((g) => g && typeof g === 'object' && (remote.test(g.coverUrl || '') || remote.test(g.heroUrl || '')))
    .map((g) => ({ id: g.id, coverUrl: g.coverUrl, heroUrl: g.heroUrl }));
  if (!copies.length) return;
  imageCacheRun = imageCacheRun.then(async () => {
    if (forceQuit) return;
    const before = copies.map((c) => ({ ...c }));
    await cacheGameImages(copies);
    if (forceQuit) return;
    const swaps = new Map();
    copies.forEach((c, i) => {
      for (const field of ['coverUrl', 'heroUrl']) {
        if (c[field] && c[field] !== before[i][field]) swaps.set(`${c.id}|${field}`, [before[i][field], c[field]]);
      }
    });
    if (!swaps.size) return;
    await enqueueGamesWrite(() => {
      const list = loadGames();
      let changed = false;
      for (const g of list) {
        if (!g || typeof g !== 'object') continue;
        for (const field of ['coverUrl', 'heroUrl']) {
          const swap = swaps.get(`${g.id}|${field}`);
          if (swap && g[field] === swap[0]) { g[field] = swap[1]; changed = true; }
        }
      }
      if (changed) saveGames(list);
    });
  }).catch((err) => console.warn('[games] image cache:', err && err.message));
}

// extra: { code: 'NOT_FOUND', path, isExe } lets the app offer a fix
function sendLaunchError(gameId, error, extra) {
  if (win && !win.isDestroyed()) win.webContents.send('game:launch-error', { ...(extra || {}), gameId, error });
}

// CLI flags (used by autostart and compositor keybinds on Wayland)
const cliArgs = platform.parseCliArgs(process.argv);

// A second launch must never create a second library window.
// It hands its flags to the running instance instead.
const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) app.quit();

// Wayland has no X11-style screen grab; Electron needs the PipeWire path.
if (process.platform === 'linux') {
  app.commandLine.appendSwitch('enable-features', 'WebRTCPipeWireCapturer');
}

app.on('second-instance', (_event, argv) => {
  const flags = platform.parseCliArgs(argv);
  // Wayland has no global shortcuts: a compositor binding runs these instead
  if (flags.screenshot) { Capture.screenshot(); return; }
  if (flags.record) { Capture.toggleRecording(); return; }
  if (win && !win.isDestroyed()) {
    win.show(); win.focus();
    // `GameVault --bigpicture` while it's already running: switch the open window
    if (flags.bigPicture) win.webContents.send('app:bigpicture', true);
  }
});

function commandExists(cmd) {
  const dirs = (process.env.PATH || '').split(path.delimiter);
  for (const dir of dirs) {
    if (!dir) continue;
    try {
      const st = fs.statSync(path.join(dir, cmd));
      if (st.isFile() && (st.mode & 0o111)) return true;
    } catch (e) {}
  }
  return false;
}

function linuxMounts() {
  try { return fs.readFileSync('/proc/mounts', 'utf-8'); } catch (e) { return ''; }
}

// XDG autostart entry (Linux equivalent of setLoginItemSettings, which
// Electron only implements on Windows and macOS).
function autostartFilePath() {
  const configHome = process.env.XDG_CONFIG_HOME || path.join(require('os').homedir(), '.config');
  return path.join(configHome, 'autostart', 'gamevault.desktop');
}

function setLinuxAutostart(enable) {
  const file = autostartFilePath();
  try {
    if (enable) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const entry = platform.autostartDesktopEntry(app.getPath('exe'), ['--hidden']);
      fs.writeFileSync(file, entry, 'utf-8');
    } else if (fs.existsSync(file)) {
      fs.unlinkSync(file);
    }
  } catch (e) {
    console.warn('Failed to update autostart entry:', e.message);
  }
}

// Settings → General → When a game starts. GameVault steps aside while a game
// it launched runs, and comes back once no game is running any more.
let steppedAside = false;
function stepAsideForGame() {
  if (!win || win.isDestroyed() || backgroundMode) return;
  const mode = loadConfig().onGameStart;
  if (mode !== 'minimize' && mode !== 'tray') return;
  steppedAside = true;
  if (mode === 'tray' && tray) win.hide();
  else win.minimize();
}
function comeBackAfterGame() {
  if (!steppedAside || !win || win.isDestroyed()) return;
  if (runningGameIds().length) return; // another game is still running
  steppedAside = false;
  if (!win.isVisible()) win.show();
  if (win.isMinimized()) win.restore();
  win.focus();
}

function launchGame(gameId, exePath, installDir, steamAppId, launcherPath) {
  const sid = String(gameId);
  // already running, or launched a moment ago (a double click, the tray while
  // it starts): a second copy is never what was meant
  const already = trackedProcesses[sid];
  if (already && already.core) {
    const ph = already.core.phase;
    if (ph === 'running' || ph === 'grace') return;
    if (ph === 'pending' && Date.now() - (already.core.launchedAt || 0) < 5000) return;
  }
  // "Copy as path" quotes
  const unquote = (v) => (typeof v === 'string' ? v.trim().replace(/^"(.*)"$/s, '$1').trim() : v);
  exePath = unquote(exePath);
  launcherPath = unquote(launcherPath);
  const games = loadGames();
  const gameRecord = games.find(x => String(x.id) === sid);
  const launchOpts = gameRecord || {};

  const requestedRunner = launchOpts.runner || 'auto';
  const launchArgs = Array.isArray(launchOpts.launchArgs) ? launchOpts.launchArgs : [];
  const protonPath = launchOpts.protonPath || '';

  // Runs once the launch really happened: lastPlayed + backfill, via the queue.
  const afterLaunch = () => {
    stepAsideForGame();
    if (!gameRecord) return;
    const tp = trackedProcesses[sid];
    const patch = { lastPlayed: Date.now() };
    if (tp) {
      if (!gameRecord.installDir && tp.installDir) patch.installDir = tp.installDir;
      if (!gameRecord.exePath && tp.exePath) patch.exePath = tp.exePath;
    }
    patchGame(sid, patch).catch(() => {});
  };
  const fail = (msg, extra) => sendLaunchError(gameId, msg, extra);

  // What to open and what counts as playing are separate (tracker split):
  // launchTarget/launcherPath is opened, trackMode/trackExe decide tracking.
  configureTracking(sid, launchOpts);
  if (!launcherPath && launchOpts.launchTarget) launcherPath = unquote(String(launchOpts.launchTarget));

  // Launch: launcherPath if provided, otherwise exePath or steam
  const pathToLaunch = launcherPath || exePath;
  if (steamAppId && !launcherPath) {
    startTracking(sid, exePath, installDir, steamAppId);
    shell.openExternal(`steam://rungameid/${steamAppId}`).catch((err) => fail(`Failed to open Steam:\n${err.message}`));
    afterLaunch();
  } else if (pathToLaunch && platform.isLaunchUri(pathToLaunch)) {
    // steam://, com.epicgames.launcher://, uplay://, origin2://, battlenet://...
    const uriAppId = platform.steamAppIdFromUri(pathToLaunch) || steamAppId;
    shell.openExternal(pathToLaunch).then(() => {
      startTracking(sid, platform.isLaunchUri(exePath) ? '' : exePath, installDir, uriAppId);
      afterLaunch();
    }).catch((err) => fail(`Failed to launch game:\n${err.message}`));
  } else if (pathToLaunch && process.platform === 'win32' && platform.isShellAppsFolder(pathToLaunch)) {
    // Xbox / AppX: shell:AppsFolder\<PackageFamily>!App never exists on disk.
    try {
      const { spawn } = require('child_process');
      const child = spawn('explorer.exe', [pathToLaunch], { detached: true, stdio: 'ignore' });
      child.once('spawn', () => { startTracking(sid, '', installDir, steamAppId); afterLaunch(); });
      child.once('error', (err) => fail(`Failed to launch game:\n${err.message}`));
      child.unref();
    } catch (err) {
      fail(`Failed to launch game:\n${err.message}`);
    }
  } else if (pathToLaunch) {
    if (!fs.existsSync(pathToLaunch)) {
      fail(`Executable not found:\n${pathToLaunch}\n\nThe file may have been moved, deleted, or the drive is disconnected.`,
        { code: 'NOT_FOUND', path: pathToLaunch, isExe: pathToLaunch === exePath });
      return;
    }

    if (process.platform === 'win32') {
      launchWindowsFile(sid, gameId, pathToLaunch, exePath, installDir, steamAppId, launchArgs, afterLaunch);
      return;
    }

    const kind = platform.classifyExecutable(pathToLaunch);
    const detectedProton = (protonPath && fs.existsSync(protonPath)) ? protonPath : platform.findProton();
    const runner = platform.pickRunner(requestedRunner, {
      kind,
      hasWine: commandExists('wine'),
      hasProton: !!detectedProton,
    });

    const effectiveProton = runner === 'proton' ? detectedProton : '';
    if (runner === 'proton' && !effectiveProton) {
      win && win.webContents.send('game:launch-error', {
        gameId,
        error: 'No Proton build found.\n\nInstall Proton through Steam, or set a Proton path for this game in its settings.',
      });
      return;
    }

    if (runner === 'unavailable') {
      win && win.webContents.send('game:launch-error', {
        gameId,
        error: `${path.basename(pathToLaunch)} is a Windows executable and no runner is available.\n\nInstall Wine, or set a Proton path for this game in its settings.`,
      });
      return;
    }

    if (runner === 'native' && kind === 'elf' && platform.isNoExecMount(pathToLaunch, linuxMounts())) {
      win && win.webContents.send('game:launch-error', {
        gameId,
        error: `${pathToLaunch}\nis on a filesystem mounted "noexec".\n\nRemount it with the exec option (or launch it from a copy on another drive).`,
      });
      return;
    }

    try {
      const { spawn } = require('child_process');
      const gameDir = installDir || path.dirname(pathToLaunch);

      let cmd = pathToLaunch;
      let argv = launchArgs.slice();
      let env = process.env;

      if (runner === 'wine') {
        cmd = 'wine';
        argv = [pathToLaunch, ...argv];
      } else if (runner === 'proton') {
        const steamRoot = path.resolve(effectiveProton, '..', '..', '..', '..');
        const prefix = path.join(steamRoot, 'steamapps', 'compatdata', String(steamAppId || sid));
        try { fs.mkdirSync(prefix, { recursive: true }); } catch (e) {}
        env = { ...process.env, STEAM_COMPAT_DATA_PATH: prefix, STEAM_COMPAT_CLIENT_INSTALL_PATH: steamRoot };
        cmd = effectiveProton;
        argv = ['run', pathToLaunch, ...argv];
      } else if (kind === 'script' && process.platform !== 'win32') {
        cmd = '/bin/sh';
        argv = [pathToLaunch, ...argv];
      }

      const child = spawn(cmd, argv, { cwd: gameDir, detached: true, stdio: 'ignore', env });
      // Track only once the child really exists: a failed spawn must not
      // leave a tracking entry behind.
      child.once('spawn', () => {
        startTracking(sid, exePath, installDir, steamAppId, child.pid || 0, { childImage: path.basename(cmd) });
        afterLaunch();
      });
      child.once('error', (err) => fail(`Failed to launch game:\n${err.message}`));
      child.unref();
    } catch (err) {
      fail(`Failed to launch game:\n${err.message}`);
      return;
    }
  } else {
    startTracking(sid, exePath, installDir, steamAppId);
    afterLaunch();
  }
}

// Windows: .exe/.com spawn directly; .bat/.cmd through cmd.exe; anything else
// (.lnk, .url, .jar, ...) through the shell association.
function launchWindowsFile(sid, gameId, pathToLaunch, exePath, installDir, steamAppId, launchArgs, afterLaunch) {
  const fail = (msg) => sendLaunchError(gameId, msg);
  const ext = path.extname(pathToLaunch).toLowerCase();
  const gameDir = installDir || path.dirname(pathToLaunch);
  const { spawn } = require('child_process');

  // Tracking target when the launched file is not the game exe itself.
  let trackExe = exePath;
  let trackAppId = steamAppId;
  if (ext === '.lnk' && exePath === pathToLaunch) {
    try { const link = shell.readShortcutLink(pathToLaunch); trackExe = link && link.target && /\.exe$/i.test(link.target) ? link.target : ''; } catch (_) { trackExe = ''; }
  } else if (ext === '.url' && exePath === pathToLaunch) {
    try { trackAppId = platform.steamAppIdFromUri(platform.parseInternetShortcut(fs.readFileSync(pathToLaunch, 'utf-8'))) || steamAppId; } catch (_) {}
    trackExe = '';
  }

  const spawnTracked = (cmd, args, opts, childImage) => {
    try {
      const child = spawn(cmd, args, { cwd: gameDir, detached: true, stdio: 'ignore', ...opts });
      child.once('spawn', () => {
        startTracking(sid, trackExe, installDir, trackAppId, child.pid || 0, { childImage });
        afterLaunch();
      });
      child.once('error', (err) => fail(`Failed to launch game:\n${err.message}`));
      child.unref();
    } catch (err) {
      fail(`Failed to launch game:\n${err.message}`);
    }
  };

  if (ext === '.exe' || ext === '.com') {
    spawnTracked(pathToLaunch, launchArgs.slice(), {}, path.basename(pathToLaunch));
  } else if (ext === '.bat' || ext === '.cmd') {
    // the path and arguments go in through variables: cmd expands %…% once,
    // so a folder named "100% done" or an argument like %OS% stays as typed
    const env = { ...process.env, GV_BAT: pathToLaunch };
    const parts = ['"%GV_BAT%"'];
    launchArgs.forEach((a, i) => {
      const v = String(a);
      if (!v) { parts.push('""'); return; }
      env[`GV_A${i}`] = v;
      parts.push(`"%GV_A${i}%"`);
    });
    spawnTracked('cmd.exe', ['/d', '/s', '/c', `"${parts.join(' ')}"`], { windowsHide: false, windowsVerbatimArguments: true, env }, 'cmd.exe');
  } else {
    shell.openPath(pathToLaunch).then((err) => {
      if (err) { fail(`Failed to launch game:\n${err}`); return; }
      startTracking(sid, trackExe, installDir, trackAppId);
      afterLaunch();
    }).catch((err) => fail(`Failed to launch game:\n${err.message}`));
  }
}

function buildTrayMenu() {
  const games = loadGames();
  // a hand-edited or damaged file can hold nulls or non-text names
  const recent = (Array.isArray(games) ? games : [])
    .filter(g => g && typeof g === 'object' && (g.exePath || g.steamAppId || g.launchTarget || g.launcherPath) && g.lastPlayed)
    .sort((a, b) => (b.lastPlayed || 0) - (a.lastPlayed || 0))
    .slice(0, 3);

  const recentItems = recent.length
    ? recent.map(g => ({
      // whole characters (an emoji is two code units), and '&' is a menu
      // shortcut marker on Windows unless doubled
      label: (() => { const n = Array.from(String(g.name || 'Untitled')); return (n.length > 28 ? n.slice(0, 28).join('') + '…' : n.join('')).replace(/&/g, '&&'); })(),
      click: () => launchGame(g.id, g.exePath, g.installDir, g.steamAppId, g.launcherPath),
    }))
    : [{ label: 'No recent games', enabled: false }];

  return Menu.buildFromTemplate([
    { label: 'GameVault', enabled: false },
    { type: 'separator' },
    { label: 'Show', click: () => { win && (win.show(), win.focus()); } },
    { type: 'separator' },
    { label: 'Quick Launch', enabled: false },
    ...recentItems,
    { type: 'separator' },
    { label: 'Take screenshot', click: () => Capture.screenshot() },
    { label: Capture.isRecording() ? 'Stop recording' : 'Record a clip', click: () => Capture.toggleRecording() },
    { type: 'separator' },
    { label: 'Quit', click: () => { forceQuit = true; app.quit(); } },
  ]);
}

function createTray() {
  const iconPath = path.join(__dirname, 'src', platform.iconFile());
  let icon;
  try {
    icon = nativeImage.createFromPath(iconPath);
    if (icon.isEmpty()) throw new Error('empty');
  } catch (e) {
    icon = nativeImage.createEmpty();
  }
  tray = new Tray(icon);
  tray.setToolTip('GameVault');
  tray.setContextMenu(buildTrayMenu());
  tray.on('double-click', () => { win && (win.show(), win.focus()); });
}

function refreshTray() {
  if (tray) tray.setContextMenu(buildTrayMenu());
}

// Background polling — detect games launched outside app every 30s
function startBgPoll() {
  if (bgPollInterval) return;
  bgPollInterval = setInterval(async () => {
    try {
      // Settings → Tracking: "Notice games I start outside GameVault"
      if (loadConfig().bgDetect === false) return;
      // Only games the tracker does not already watch; skip the process
      // listing entirely when there are none.
      // The process that means "playing" is trackExe when set, else exePath;
      // games set to "don't track" and launcher executables never qualify.
      const watchExe = (g) => (g.trackExe || g.exePath || '');
      const candidates = loadGames().filter(g => g.status === 'Playing' && g.trackMode !== 'none' && g.trackMode !== 'steam'
        && !trackedProcesses[String(g.id)] && platform.isFilesystemPath(watchExe(g))
        && !/\.(lnk|url)$/i.test(watchExe(g))
        && !platform.isLauncherProcessName(path.basename(watchExe(g))));
      if (!candidates.length) return;
      let isRunningName;
      if (process.platform === 'win32') {
        const snapshot = await platform.listWindowsProcesses();
        if (!snapshot) return;
        isRunningName = (name) => platform.pidsForNames(snapshot, [name]).length > 0;
      } else {
        const procs = platform.readLinuxProcesses();
        isRunningName = (name) => procs.some((p) => platform.matchesGameProcess(p, [name]));
      }
      candidates.forEach(g => {
        const gameId = String(g.id);
        if (trackedProcesses[gameId]) return; // already tracked
        // Exact executable name; never walk the install dir here.
        const isRunning = isRunningName(path.basename(watchExe(g)).toLowerCase());
        if (isRunning) {
          configureTracking(gameId, g);
          startTracking(gameId, g.exePath || watchExe(g), g.installDir, g.steamAppId);
          win && win.webContents.send('tracking:detected', { gameId: g.id, gameName: g.name });
        }
      });
    } catch (e) { }
  }, 30000);
}

// Screenshot and clip shortcuts. Defaults no other capture tool uses: Steam
// (F12), NVIDIA (Alt+F1, Alt+F9, Alt+Z), AMD (Ctrl+Shift+S/E/R) and the Xbox
// Game Bar (Win+Alt+...). Ctrl+Alt is avoided: it is AltGr on many keyboards.
const CAPTURE_DEFAULTS = { captureShotHotkey: 'Alt+Shift+S', captureClipHotkey: 'Alt+Shift+R' };
// per shortcut: true, or false when another app already owns it
let captureHotkeyOk = { shot: true, clip: true };
// Settings: list captures other apps and photo modes made
let findOthersOn = true;

function registerCaptureShortcuts(cfg) {
  globalShortcut.unregisterAll();
  captureHotkeyOk = { shot: true, clip: true };
  if (platform.isWayland()) return captureHotkeyOk;
  const bind = (key, accel, fn) => {
    if (!accel) return;
    try { captureHotkeyOk[key] = !!globalShortcut.register(accel, fn); } catch (e) {
      captureHotkeyOk[key] = false;
      console.warn('[capture] shortcut', accel, e.message);
    }
  };
  bind('shot', cfg.captureShotHotkey || CAPTURE_DEFAULTS.captureShotHotkey, () => Capture.screenshot());
  bind('clip', cfg.captureClipHotkey || CAPTURE_DEFAULTS.captureClipHotkey, () => Capture.toggleRecording());
  return captureHotkeyOk;
}

// the game a capture belongs to: the one playing now (the latest started)
function currentCaptureGame() {
  try {
    const ids = runningGameIds();
    if (!ids.length) return null;
    const games = loadGames();
    const g = (Array.isArray(games) ? games : []).find((x) => x && String(x.id) === String(ids[0]));
    return g ? { id: g.id, name: g.name || 'Untitled' } : null;
  } catch (_) { return null; }
}

// Dev/QA only: GV_BACKGROUND=1 renders the real window off-screen, without
// focus or a taskbar button, so it can be driven and screenshotted over the
// DevTools protocol while someone keeps using the PC. (A hidden window does
// not paint, so screenshots of it hang.)
const backgroundMode = process.env.GV_BACKGROUND === '1';

// Big Picture: fullscreen plus a page zoom sized to the screen (see
// src/lib/bigpicture.js). The renderer owns the mode; main only does the window.
const BigPicture = require('./src/lib/bigpicture.js');
const UiPrefs = require('./src/lib/uiprefs.js');
const Palette = require('./src/lib/palette.js');
let bigPictureOn = false;
// Settings → Appearance → Size: the normal window's page zoom (Big Picture
// uses its own). Read at start so the first paint already has it.
let uiZoom = 1;
try { uiZoom = UiPrefs.zoom((loadConfig() || {}).ui); } catch (_) { uiZoom = 1; }

function bigPictureZoom() {
  const { screen } = require('electron');
  const d = win && !win.isDestroyed() ? screen.getDisplayMatching(win.getBounds()) : screen.getPrimaryDisplay();
  return BigPicture.zoomFor(d.size.width, d.size.height);
}

function setBigPicture(on) {
  if (!win || win.isDestroyed()) return { on: false, zoom: 1 };
  bigPictureOn = !!on;
  if (backgroundMode) {
    // QA: never go fullscreen (that would put the window on the user's
    // screen); stay off-screen at a TV-like 1080p size instead
    if (bigPictureOn) { win.__preBp = win.getSize(); win.setSize(1920, 1080); }
    else if (win.__preBp) win.setSize(win.__preBp[0], win.__preBp[1]);
    win.setPosition(-12000, -12000);
  } else {
    if (bigPictureOn && win.isMinimized()) win.restore();
    win.setFullScreen(bigPictureOn);
  }
  const zoom = bigPictureOn ? (backgroundMode ? BigPicture.zoomFor(1920, 1080) : bigPictureZoom()) : uiZoom;
  win.webContents.setZoomFactor(zoom);
  return { on: bigPictureOn, zoom };
}

// A game session ended while Big Picture was up: bring GameVault back in
// front of whatever is left on screen. Windows only lets a background app
// take the foreground in a few cases, so pin it on top for a moment.
function bringToFront() {
  if (!win || win.isDestroyed() || backgroundMode) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.setAlwaysOnTop(true);
  win.moveTop();
  win.focus();
  setTimeout(() => { if (win && !win.isDestroyed()) win.setAlwaysOnTop(false); }, 300);
}

function createWindow() {
  const startBigPicture = BigPicture.startsIn({ flag: cliArgs.bigPicture, config: loadConfig() });
  win = new BrowserWindow({
    ...(startBigPicture && !backgroundMode ? { fullscreen: true } : {}),
    ...(backgroundMode ? { x: -12000, y: -12000, focusable: false, skipTaskbar: true } : {}),
    width: Number(process.env.GV_W || 1200),
    height: Number(process.env.GV_H || 760),
    minWidth: 900,
    minHeight: 580,
    // Frameless: the renderer draws its own minimize / maximize / close buttons
    // (see .win-controls in index.html) and the top bar is the drag handle.
    frame: false,
    show: !backgroundMode,
    backgroundColor: '#07080c',
    icon: path.join(__dirname, 'src', platform.iconFile()),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      paintWhenInitiallyHidden: true,
      backgroundThrottling: false,
    },
  });
  if (backgroundMode) {
    // showInactive never steals focus; re-pin the position in case Windows
    // pulled the window back onto a monitor.
    win.showInactive();
    win.setPosition(-12000, -12000);
  }
  setTrackerWindow(win);
  initUpdater(win, () => { forceQuit = true; });

  const query = {};
  if (startBigPicture) query.bp = '1';   // the renderer opens straight into Big Picture
  win.loadFile(path.join(__dirname, 'src', 'index.html'), { query: Object.keys(query).length ? query : undefined });
  // Chromium remembers page zoom per origin: a reload must not stay zoomed
  // unless Big Picture is (still) on
  win.webContents.on('did-finish-load', () => {
    if (!win || win.isDestroyed()) return;
    if (bigPictureOn) win.webContents.send('app:bigpicture', true);   // a reload: pick it back up
    else win.webContents.setZoomFactor(uiZoom);
  });

  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) console.log('[renderer]', message);
  });

  // Close to tray instead of quitting
  win.on('close', (e) => {
    if (!forceQuit) {
      e.preventDefault();
      win.hide();
      refreshTray();
    }
  });

  // Windows is signing out, restarting or shutting down (see saveSessionsOnWindowsEnd)
  win.on('session-end', () => {
    saveSessionsOnWindowsEnd();
    try { if (!win.isDestroyed()) win.webContents.send('app:flush'); } catch (_) {}
  });

  // Window maximize state sync
  win.on('maximize', () => {
    if (win && !win.isDestroyed()) {
      win.webContents.send('win:maximized', true);
    }
  });

  win.on('unmaximize', () => {
    if (win && !win.isDestroyed()) {
      win.webContents.send('win:maximized', false);
    }
  });

  ipcMain.on('win-minimize', () => win && win.minimize());
  ipcMain.on('win-maximize', () => {
    if (!win) return;
    if (win.isMaximized()) {
      win.unmaximize();
    } else {
      win.maximize();
    }
  });
  // Settings → General: the close button hides to the tray (default) or quits.
  ipcMain.on('win-close', () => {
    if (!win) return;
    if (loadConfig().closeToTray === false) { forceQuit = true; app.quit(); return; }
    win.hide();
  });
  // Crop an image to the box of its visible (alpha > 12) pixels, with a hair
  // of padding so glows are not cut. Returns the image unchanged when there
  // is nothing worth trimming.
  function trimTransparent(img) {
    try {
      const { width: w, height: h } = img.getSize();
      const px = img.toBitmap(); // BGRA
      if (px.length < w * h * 4) return img;
      let x0 = w, y0 = h, x1 = -1, y1 = -1;
      for (let y = 0; y < h; y++) {
        const row = y * w * 4;
        for (let x = 0; x < w; x++) {
          if (px[row + x * 4 + 3] > 12) {
            if (x < x0) x0 = x;
            if (x > x1) x1 = x;
            if (y < y0) y0 = y;
            if (y > y1) y1 = y;
          }
        }
      }
      if (x1 < 0) return img;
      const pad = 2;
      x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad);
      x1 = Math.min(w - 1, x1 + pad); y1 = Math.min(h - 1, y1 + pad);
      const cw = x1 - x0 + 1, ch = y1 - y0 + 1;
      if (cw >= w - 2 && ch >= h - 2) return img;
      return img.crop({ x: x0, y: y0, width: cw, height: ch });
    } catch (_) {
      return img;
    }
  }

  // Renderer errors, kept next to the library (local only, capped at ~200 KB)
  ipcMain.on('log:renderer-error', (_e, entry) => {
    try {
      const file = path.join(app.getPath('userData'), 'renderer-errors.log');
      const where = String((entry && entry.where) || '').slice(0, 80);
      const text = String((entry && entry.text) || '').slice(0, 4000);
      try { if (fs.statSync(file).size > 200 * 1024) fs.renameSync(file, `${file}.old`); } catch (_) {}
      fs.appendFileSync(file, `${new Date().toISOString()} [${where}] ${text}\n`);
    } catch (_) {}
  });

  ipcMain.handle('img:thumb', async (_e, { src, width, kind }) => {
    try {
      if (!src) return null;
      let file = String(src);
      if (file.startsWith('file://')) {
        try { file = require('url').fileURLToPath(file); } catch (_) { file = file.replace('file://', ''); }
      }
      if (!fs.existsSync(file)) return null;
      const crypto = require('crypto');
      const stat = fs.statSync(file);
      const isLogo = kind === 'logo';
      const key = crypto.createHash('md5').update(`${file}:${stat.mtimeMs}:${width}${isLogo ? ':logo-trim' : ''}`).digest('hex');
      const dir = path.join(app.getPath('userData'), 'thumbs');
      fs.mkdirSync(dir, { recursive: true });
      // logos keep their transparency
      const out = path.join(dir, `${key}.${isLogo ? 'png' : 'jpg'}`);
      if (fs.existsSync(out)) return require('url').pathToFileURL(out).href;

      let img = nativeImage.createFromPath(file);
      if (img.isEmpty()) return null;
      // Logos often sit in a wide transparent canvas (Steam's logo.png puts
      // the art at the right): crop to what is actually drawn so the logo
      // lines up with the text around it.
      if (isLogo) img = trimTransparent(img);
      const size = img.getSize();
      // A portrait cover blown up to a banner looks like a smeared render bug.
      if (kind === 'hero' && size.width / size.height < 1.45) return '__reject__';
      const resized = size.width > width ? img.resize({ width, quality: 'good' }) : img;
      fs.writeFileSync(out, isLogo ? resized.toPNG() : resized.toJPEG(88));
      return require('url').pathToFileURL(out).href;
    } catch (_) {
      return null;
    }
  });

  // The main colours of a cover (for the PEAK strap). Local files and web
  // art both work; answers are kept in userData/palettes.json.
  const palettes = { map: null, file: () => path.join(app.getPath('userData'), 'palettes.json'), saveT: null };
  ipcMain.handle('img:palette', async (_e, src) => {
    try {
      if (!src || typeof src !== 'string') return null;
      if (!palettes.map) {
        try { palettes.map = JSON.parse(fs.readFileSync(palettes.file(), 'utf8')) || {}; } catch (_) { palettes.map = {}; }
      }
      let img = null, key = src;
      if (/^https?:/i.test(src)) {
        if (palettes.map[key]) return palettes.map[key];
        const res = await require('electron').net.fetch(src);
        if (!res.ok) return null;
        img = nativeImage.createFromBuffer(Buffer.from(await res.arrayBuffer()));
      } else {
        let file = src;
        if (file.startsWith('file://')) {
          try { file = require('url').fileURLToPath(file); } catch (_) { file = file.replace('file://', ''); }
        }
        if (!fs.existsSync(file)) return null;
        key = `${file}:${fs.statSync(file).mtimeMs}`;
        if (palettes.map[key]) return palettes.map[key];
        img = nativeImage.createFromPath(file);
      }
      if (!img || img.isEmpty()) return null;
      const small = img.resize({ width: 48, quality: 'good' });
      const colors = Palette.extract(small.toBitmap(), { count: 4 });
      if (!colors.length) return null;
      const out = { colors, ink: Palette.ink(colors) };
      palettes.map[key] = out;
      const keys = Object.keys(palettes.map);
      if (keys.length > 2000) for (const k of keys.slice(0, keys.length - 2000)) delete palettes.map[k];
      clearTimeout(palettes.saveT);
      palettes.saveT = setTimeout(() => { try { fs.writeFileSync(palettes.file(), JSON.stringify(palettes.map)); } catch (_) {} }, 1500);
      return out;
    } catch (_) {
      return null;
    }
  });

  ipcMain.handle('win:is-maximized', () => win ? win.isMaximized() : false);
  ipcMain.handle('win:bigpicture', (_e, on) => setBigPicture(on));
  ipcMain.on('win:bring-front', () => bringToFront());
  // a still of the window, so the renderer can crossfade a palette change
  // instead of re-colouring every element on every frame
  ipcMain.handle('win:snapshot', async () => {
    if (!win || win.isDestroyed()) return null;
    try {
      const img = await win.webContents.capturePage();
      return img.isEmpty() ? null : 'data:image/jpeg;base64,' + img.toJPEG(92).toString('base64');
    } catch (_) { return null; }
  });
  // Windows' regional format (not its display language), read once by the
  // preload so the first paint already writes dates the user's way
  ipcMain.on('app:locale', (e) => {
    try { e.returnValue = (app.getSystemLocale && app.getSystemLocale()) || app.getLocale() || ''; } catch (_) { e.returnValue = ''; }
  });
  ipcMain.handle('app:platform-info', () => ({
    platform: process.platform,
    wayland: platform.isWayland(),
    globalHotkeysSupported: !platform.isWayland(),
    captureHotkeyOk,
    protonPath: process.platform === 'linux' ? platform.findProton() : '',
  }));
  ipcMain.handle('capture:update-hotkeys', () => registerCaptureShortcuts(loadConfig()));
  ipcMain.on('capture:open-folder', () => {
    const d = mediaDirPath();
    try { fs.mkdirSync(d, { recursive: true }); } catch (_) {}
    shell.openPath(d);
  });
  ipcMain.on('capture:open', (_, filePath) => {
    const target = safeMediaExisting(filePath);
    if (target) shell.openPath(target);
  });

  function mediaDirPath() { return path.join(path.dirname(DATA_PATH), 'data_media'); }
  function safeMediaExisting(filePath) {
    if (typeof filePath !== 'string') return null;
    const dir = mediaDirPath();
    const target = path.resolve(filePath);
    if (!/\.(png|jpe?g|webp|gif|bmp|webm|mp4|mkv|mov)$/i.test(target)) return null;
    const rel = path.relative(dir, target);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return target;
    // Steam, NVIDIA, Game Bar and photo-mode shots: only ones the finder listed
    return Finder.knownPath(target);
  }

  // Screenshots and clips only (no desktop.ini, Thumbs.db or folders), newest
  // first, each with a proper file URL (a '#' or '%' in a name breaks a raw one)
  const listMedia = () => {
    const mediaDir = path.join(path.dirname(DATA_PATH), 'data_media');
    const MEDIA = /\.(png|jpe?g|webp|gif|bmp|webm|mp4|mkv|mov)$/i;
    const index = Capture.readIndex();
    const out = [];
    let others = [];
    try { others = Finder.list(); } catch (e) { console.warn('[captures] list:', e.message); }
    const own = fs.existsSync(mediaDir) ? fs.readdirSync(mediaDir) : [];
    for (const f of own) {
      if (!MEDIA.test(f)) continue;
      const full = path.join(mediaDir, f);
      try {
        const st = fs.statSync(full);
        if (!st.isFile()) continue;
        out.push({ name: f, path: full, url: require('url').pathToFileURL(full).href, time: st.mtimeMs, size: st.size, video: /\.(webm|mp4|mkv|mov)$/i.test(f), gameId: index[f] && index[f].gameId ? String(index[f].gameId) : null, source: 'GameVault', external: false });
      } catch (_) { /* gone meanwhile */ }
    }
    out.push(...others);
    out.sort((a, b) => b.time - a.time);
    return out;
  };

  ipcMain.handle('capture:get-all', () => {
    try { return listMedia(); } catch (e) { return []; }
  });

  ipcMain.handle('capture:delete-media', async (_, filePath) => {
    try {
      const target = safeMediaExisting(filePath);
      if (!target) return false;
      // to the Recycle Bin, not gone for good: a misclick can be undone
      if (fs.existsSync(target) && fs.statSync(target).isFile()) {
        await shell.trashItem(target);
        Capture.untag(target);
        Finder.forget(target);
        return true;
      }
    } catch (e) {
      console.warn('Failed to delete media', e);
    }
    return false;
  });

  // a picked-up shot that isn't from that game: stop showing it, keep the file
  ipcMain.handle('capture:hide-media', (_, filePath) => {
    try { return Finder.hide(filePath); } catch (_) { return false; }
  });

  ipcMain.on('capture:show-folder', (_, filePath) => {
    const target = safeMediaExisting(filePath);
    if (target) shell.showItemInFolder(target);
  });

  ipcMain.on('game:show-in-folder', (_, targetPath) => {
    if (!targetPath || typeof targetPath !== 'string' || targetPath.length > 4096 || targetPath.includes('\0')) return;
    if (!platform.isFilesystemPath(targetPath)) return;
    try {
      const target = path.resolve(targetPath);
      if (fs.existsSync(target)) {
        shell.showItemInFolder(target);
      }
    } catch (_) {}
  });

  const noMainExeDirs = new Set(); // install dirs where findMainExe found nothing (session)
  ipcMain.handle('games:load-issue', () => lastLoadIssue());
  ipcMain.handle('games:load', () => enqueueGamesWrite(() => {
    const games = loadGames();
    let updated = false;
    for (const g of games) {
      if (!g) continue;
      if (g.steamAppId) {
        if (!g.installDir) {
          const resolved = resolveSteamInstallDir(g.steamAppId);
          if (resolved) { g.installDir = resolved; updated = true; }
        }
        if (!g.exePath && g.installDir && !noMainExeDirs.has(g.installDir)) {
          const exe = findMainExe(g.installDir);
          if (exe) { g.exePath = exe; updated = true; } else noMainExeDirs.add(g.installDir);
        }
      }
      for (const field of ['coverUrl', 'heroUrl', 'logoUrl', 'iconUrl']) {
        const fixed = normalizeLegacyFileUrl(g[field]);
        if (fixed) { g[field] = fixed; updated = true; }
      }
    }
    if (updated) saveGames(games);
    return games;
  }));
  ipcMain.handle('games:backup', () => {
    try {
      if (!fs.existsSync(DATA_PATH)) return null;
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const dest = `${DATA_PATH}.bak-${stamp}`;
      fs.copyFileSync(DATA_PATH, dest);
      return dest;
    } catch (_) { return null; }
  });

  ipcMain.handle('games:save', (_, games) => {
    if (!Array.isArray(games)) return false;
    // the library is written first; covers still on the web are downloaded
    // afterwards (a slow image host must never hold up, or lose, a save made
    // just before quitting)
    return enqueueGamesWrite(() => {
      if (windowsEndingSessions) addEndedSessions(games, windowsEndingSessions);
      saveGames(games);
      refreshTray();
      cacheImagesAfterSave(games);
      return true;
    });
  });
  ipcMain.handle('games:data-path', () => DATA_PATH);

  // The renderer never receives API keys, only has*Key flags (see data.js).
  ipcMain.handle('config:load', () => publicConfig(loadConfig()));
  // Merge-patch: resolves to the merged config.
  ipcMain.handle('config:save', (_, patch) => {
    const merged = mergeConfig(patch);
    if (patch && 'captureFindOthers' in patch) { findOthersOn = merged.captureFindOthers !== false; Finder.invalidate(); }
    if (patch && 'afkMinutes' in patch) setAfkMinutes(merged.afkMinutes);
    return publicConfig(merged);
  });
  // Settings → General → Reset all settings: the listed preferences are removed,
  // so their defaults apply again. Data (games, account, imports) is never listed.
  const RESETTABLE = new Set(['ui', 'palette', 'uiAt', 'tier', 'padEnabled', 'padGlyphs', 'view', 'sfx', 'sfxVolume', 'sfxTheme', 'sfxNav',
    'startBigPicture', 'closeToTray', 'onGameStart', 'afkMinutes', 'bgDetect', 'updateCheck', 'perfLog',
    'captureShotHotkey', 'captureClipHotkey', 'captureGameAudio', 'captureMic', 'captureFindOthers']);
  ipcMain.handle('config:reset', (_, keys) => {
    try {
      const cfg = loadConfig();
      for (const k of Array.isArray(keys) ? keys : []) if (RESETTABLE.has(k)) delete cfg[k];
      saveConfig(cfg);
      setAfkMinutes(0);
      findOthersOn = true;
      Finder.invalidate();
      uiZoom = 1;
      return true;
    } catch (e) {
      console.warn('config reset:', e.message);
      return false;
    }
  });

  // Settings → Library → Artwork on this PC: its size, and removing files no
  // game (or any setting) points to any more
  const artDir = () => path.join(path.dirname(DATA_PATH), 'artworks_cache');
  function artCacheScan() {
    const dir = artDir();
    let names = [];
    try { names = fs.readdirSync(dir); } catch (_) { return { files: 0, bytes: 0, unused: [], unusedBytes: 0 }; }
    // every JSON file next to the library can point at artwork (games, config, wishlist)
    let refs = '';
    try {
      for (const n of fs.readdirSync(path.dirname(DATA_PATH))) {
        if (/\.json$/i.test(n)) { try { refs += fs.readFileSync(path.join(path.dirname(DATA_PATH), n), 'utf8'); } catch (_) {} }
      }
    } catch (_) {}
    const decoded = (() => { try { return decodeURIComponent(refs); } catch (_) { return refs; } })();
    let files = 0, bytes = 0, unusedBytes = 0;
    const unused = [];
    const freshCutoff = Date.now() - 60 * 60 * 1000; // never touch anything from the last hour
    for (const n of names) {
      let st;
      try { st = fs.statSync(path.join(dir, n)); } catch (_) { continue; }
      if (!st.isFile()) continue;
      files += 1;
      bytes += st.size;
      if (n.endsWith('.part') || st.mtimeMs > freshCutoff) continue;
      if (!refs.includes(n) && !decoded.includes(n)) { unused.push(n); unusedBytes += st.size; }
    }
    return { files, bytes, unused, unusedBytes };
  }
  ipcMain.handle('art:cache-info', () => {
    const r = artCacheScan();
    return { files: r.files, bytes: r.bytes, unusedFiles: r.unused.length, unusedBytes: r.unusedBytes };
  });
  ipcMain.handle('art:cache-clean', () => {
    try {
      const r = artCacheScan();
      let freed = 0;
      for (const n of r.unused) {
        try { const p = path.join(artDir(), n); const size = fs.statSync(p).size; fs.rmSync(p, { force: true }); freed += size; } catch (_) {}
      }
      return { ok: true, files: r.unused.length, bytes: freed };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('import:sources', () => importers.listSources());
  const PERF_LOG = path.join(app.getPath('userData'), 'perf.log');
  ipcMain.on('perf:log', (_, sample) => {
    try {
      fs.appendFileSync(PERF_LOG, JSON.stringify(sample) + '\n');
      const st = fs.statSync(PERF_LOG);
      if (st.size > 3 * 1024 * 1024) fs.renameSync(PERF_LOG, PERF_LOG + '.old');
    } catch (_) {}
  });

  ipcMain.handle('app:gpu', () => {
    try { return app.getGPUFeatureStatus(); } catch (e) { return {}; }
  });

  ipcMain.handle('import:scan', (_, id) => importers.scanSource(id));
  ipcMain.handle('import:folder', async () => {
    const result = await dialog.showOpenDialog(win, {
      properties: ['openDirectory'],
      title: 'Choose a games folder',
    });
    if (result.canceled || !result.filePaths[0]) return null;
    return importers.scanSource('folder', result.filePaths[0]);
  });
  ipcMain.handle('import:file', async () => {
    const result = await dialog.showOpenDialog(win, {
      properties: ['openFile', 'multiSelections'],
      title: 'Import executables',
      filters: [
        { name: 'Games and launchers', extensions: ['AppImage', 'appimage', 'elf', 'sh', 'exe', 'bin'] },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    if (result.canceled) return null;
    return result.filePaths.map((f) => importers.ingestFile(f)).filter(Boolean);
  });

  ipcMain.on('tracking:stop', (_, { gameId }) => stopTracking(String(gameId)));

  // "Detect" in the edit dialog: names of running programs a user could pick
  // as a game's track exe. System processes, runtimes and GameVault itself
  // are left out; executables found in the game's folder come first.
  ipcMain.handle('tracking:running-processes', async (_, { installDir } = {}) => {
    try {
      let names = [];
      if (process.platform === 'win32') {
        const snap = await platform.listWindowsProcesses();
        names = snap && snap.byName ? [...snap.byName.keys()] : [];
      } else {
        names = platform.readLinuxProcesses().map((p) => p.exeBase || p.comm).filter(Boolean);
      }
      const inFolder = new Set(installDir && path.isAbsolute(String(installDir))
        ? await platform.listLaunchableNamesAsync(String(installDir), { maxDepth: 4, limit: 3000 }).catch(() => [])
        : []);
      return [...new Set(names.map((n) => String(n).toLowerCase()))]
        .filter((n) => n && !platform.isProtectedProcessName(n) && !platform.isGenericProcessName(n))
        .map((n) => ({ name: n, inGameFolder: inFolder.has(n), launcher: platform.isLauncherProcessName(n) }))
        .filter((p) => p.inGameFolder || !p.launcher)
        .sort((a, b) => (b.inGameFolder - a.inGameFolder) || a.name.localeCompare(b.name))
        .slice(0, 60);
    } catch (_) {
      return [];
    }
  });

  // startAt: where the file was, or the game's folder; the picker opens in
  // the nearest folder of it that still exists
  ipcMain.handle('pick:exe', async (_, startAt, kind) => {
    let defaultPath;
    try {
      // a link or a relative name is not a folder (it would open in the app's own)
      let dir = typeof startAt === 'string' && startAt && path.isAbsolute(startAt) ? path.resolve(startAt) : '';
      for (let i = 0; dir && i < 6; i++) {
        if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) { defaultPath = dir; break; }
        const up = path.dirname(dir);
        if (up === dir) break;
        dir = up;
      }
    } catch (_) { defaultPath = undefined; }
    const result = await dialog.showOpenDialog(win, {
      ...(defaultPath ? { defaultPath } : {}),
      properties: ['openFile'],
      filters: process.platform !== 'win32'
        ? [{ name: 'All files', extensions: ['*'] }]
        : kind === 'target'
          ? [{ name: 'Programs, scripts and shortcuts', extensions: ['exe', 'bat', 'cmd', 'lnk', 'url'] }, { name: 'All files', extensions: ['*'] }]
          : [{ name: 'Executables', extensions: ['exe'] }],
      title: kind === 'target' ? 'Choose what to open' : process.platform === 'win32' ? 'Select game .exe' : 'Select game executable',
    });
    return result.canceled ? null : result.filePaths[0];
  });

  // Custom background (Settings → Appearance → Background): the picked file is
  // copied into userData/backgrounds so moving or deleting the original never
  // breaks it. Only one is kept; it never leaves this PC.
  const BG_DIR = path.join(app.getPath('userData'), 'backgrounds');
  const BG_TYPES = {
    image: { exts: ['jpg', 'jpeg', 'png', 'webp', 'gif', 'avif', 'bmp'], max: 64 * 1024 * 1024, title: 'Choose a background picture' },
    video: { exts: ['mp4', 'webm', 'm4v', 'mov', 'ogv'], max: 2 * 1024 * 1024 * 1024, title: 'Choose a background video' },
  };
  const clearBackgrounds = async (keep) => {
    const names = await fs.promises.readdir(BG_DIR).catch(() => []);
    await Promise.all(names.map((n) => (path.join(BG_DIR, n) === keep ? null : fs.promises.rm(path.join(BG_DIR, n), { force: true }).catch(() => {}))));
  };
  ipcMain.handle('ui:zoom', (_e, k) => {
    const n = Number(k);
    uiZoom = Number.isFinite(n) ? Math.min(1.2, Math.max(0.9, n)) : 1;
    if (win && !win.isDestroyed() && !bigPictureOn) win.webContents.setZoomFactor(uiZoom);
    return uiZoom;
  });

  // Copy and paste a shared look: the page may not read the clipboard, and
  // its own writes fail while the window isn't focused
  ipcMain.handle('ui:clipboard-write', (_e, text) => {
    if (typeof text !== 'string' || text.length > 16384) return false;
    require('electron').clipboard.writeText(text);
    return true;
  });
  ipcMain.handle('ui:clipboard-text', () => {
    const { clipboard } = require('electron');
    const t = clipboard.readText() || '';
    return t.length > 16384 ? '' : t;
  });

  ipcMain.handle('ui:bg-pick', async (_, kind) => {
    const type = BG_TYPES[kind];
    if (!type) return { error: 'bad kind' };
    const result = await dialog.showOpenDialog(win, {
      properties: ['openFile'],
      title: type.title,
      filters: [{ name: kind === 'video' ? 'Videos' : 'Pictures', extensions: type.exts }],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    const src = result.filePaths[0];
    const ext = path.extname(src).slice(1).toLowerCase();
    if (!type.exts.includes(ext)) return { error: 'That file type isn’t supported.' };
    const st = await fs.promises.stat(src).catch(() => null);
    if (!st || !st.isFile()) return { error: 'Couldn’t read that file.' };
    if (st.size > type.max) return { error: kind === 'video' ? 'That video is over 2 GB.' : 'That picture is over 64 MB.' };
    try {
      await fs.promises.mkdir(BG_DIR, { recursive: true });
      const dest = path.join(BG_DIR, `background-${Date.now()}.${ext}`);
      await fs.promises.copyFile(src, dest);
      await clearBackgrounds(dest);
      return { file: dest, kind };
    } catch (e) {
      return { error: 'Couldn’t copy that file.' };
    }
  });
  ipcMain.handle('ui:bg-clear', async () => { await clearBackgrounds(null); return true; });

  ipcMain.on('game:launch', (_, { exePath, steamAppId, gameId, installDir, launcherPath }) => {
    launchGame(gameId, exePath, installDir, steamAppId, launcherPath);
  });

  // Kill a running game
  ipcMain.handle('game:kill', async (_, { gameId, exePath, installDir, steamAppId, launcherPath }) => {
    return await killGameProcesses(gameId, exePath, installDir, steamAppId, launcherPath);
  });

  function sgdbOrThrow() {
    const cfg = loadConfig();
    if (!cfg.sgdbKey) {
      const err = new Error('Add a SteamGridDB API key in Settings');
      err.code = 'NO_KEY';
      throw err;
    }
    return createSgdb(cfg.sgdbKey);
  }

  // Shared artwork cache (Gamevault Cloud) first, the user's own SteamGridDB
  // key as fallback. The cloud needs no key, so artwork works out of the box.
  let artCacheInstance = null;
  function artCache() {
    if (!artCacheInstance) {
      const { url, anonKey } = cloudConfig();
      artCacheInstance = createArtCache({
        dir: path.join(app.getPath('userData'), 'art-cache'), cloudUrl: url, anonKey,
        // Signed in: art lookups count against the user's account, not an anonymous one.
        userToken: (o) => account().token(o).catch(() => null),
        // Steam's own art cache, which knows the hashed paths of newer apps' art
        steamLibraryCaches: () => {
          try { return require('./src/backend/sources/steam.js').steamRoots().map((r) => path.join(r, 'appcache', 'librarycache')); } catch (_) { return []; }
        },
      });
    }
    return artCacheInstance;
  }
  // GameVault account (src/backend/account.js). Session encrypted with the OS keychain.
  let accountInstance = null;
  function account() {
    if (!accountInstance) {
      const { url, anonKey } = cloudConfig();
      const canEnc = () => { try { return safeStorage.isEncryptionAvailable(); } catch (_) { return false; } };
      accountInstance = createAccount({
        dir: path.join(app.getPath('userData'), 'account'), cloudUrl: url, anonKey,
        encrypt: (text) => (canEnc() ? 'v1:' + safeStorage.encryptString(text).toString('base64') : 'p1:' + Buffer.from(text, 'utf8').toString('base64')),
        decrypt: (raw) => (raw.startsWith('v1:') ? (canEnc() ? safeStorage.decryptString(Buffer.from(raw.slice(3), 'base64')) : '') : raw.startsWith('p1:') ? Buffer.from(raw.slice(3), 'base64').toString('utf8') : ''),
        openExternal: (u) => shell.openExternal(u).catch(() => {}),
        onChange: (st) => {
          if (!win || win.isDestroyed()) return;
          win.webContents.send('account:changed', st);
          if (st.signedIn) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); }
        },
      });
    }
    return accountInstance;
  }
  const accountReply = async (fn) => {
    try { return { ok: true, data: await fn() }; } catch (e) { return { ok: false, error: { code: e.code || 'ERROR', message: e.message } }; }
  };
  ipcMain.handle('account:status', () => account().status());
  ipcMain.handle('account:providers', () => account().providers());
  ipcMain.handle('account:email', (_, email) => accountReply(() => account().startEmail(email)));
  ipcMain.handle('account:password', (_, p) => accountReply(() => account().signInPassword(p && p.email, p && p.password)));
  ipcMain.handle('account:signup', (_, p) => accountReply(() => account().signUp(p && p.email, p && p.password)));
  ipcMain.handle('account:reset', (_, email) => accountReply(() => account().resetPassword(email)));
  ipcMain.handle('account:set-password', (_, pw) => accountReply(() => account().setPassword(pw)));
  ipcMain.handle('account:code', (_, code) => accountReply(() => account().verifyCode(code)));
  ipcMain.handle('account:delete', (_, confirm) => accountReply(async () => {
    if (confirm !== 'DELETE') throw Object.assign(new Error('Not confirmed'), { code: 'BAD_INPUT' });
    const r = await account().deleteAccount();
    // This PC's cloud bookkeeping for that user goes too (games stay).
    if (r.userId) {
      const cdir = path.join(app.getPath('userData'), 'cloud');
      for (const f of [`sync-${r.userId}.json`, `key-${r.userId}.bin`]) { try { fs.rmSync(path.join(cdir, f), { force: true }); } catch (_) {} }
    }
    return r.status;
  }));
  ipcMain.handle('account:oauth', (_, provider) => accountReply(() => account().startOAuth(provider)));
  ipcMain.handle('account:cancel', () => { account().cancel(); account().clearError(); return account().status(); });
  ipcMain.handle('account:signout', () => accountReply(() => account().signOut()));

  // Library sync + encrypted save backups (src/backend/cloud.js).
  let cloudInstance = null;
  function cloud() {
    if (!cloudInstance) {
      const { url, anonKey } = cloudConfig();
      const canEnc = () => { try { return safeStorage.isEncryptionAvailable(); } catch (_) { return false; } };
      cloudInstance = createCloud({
        dir: path.join(app.getPath('userData'), 'cloud'), cloudUrl: url, anonKey, account: account(),
        device: require('os').hostname(),
        protect: (t) => (canEnc() ? 'v1:' + safeStorage.encryptString(t).toString('base64') : 'p1:' + Buffer.from(t, 'utf8').toString('base64')),
        unprotect: (raw) => (raw.startsWith('v1:') ? (canEnc() ? safeStorage.decryptString(Buffer.from(raw.slice(3), 'base64')) : '') : raw.startsWith('p1:') ? Buffer.from(raw.slice(3), 'base64').toString('utf8') : ''),
      });
    }
    return cloudInstance;
  }
  ipcMain.handle('cloud:sync', (_, games, look) => accountReply(() => {
    if (!Array.isArray(games)) throw Object.assign(new Error('Nothing to sync'), { code: 'BAD_INPUT' });
    return cloud().syncLibrary(games, { look });
  }));
  ipcMain.handle('cloud:last-sync', () => cloud().lastSync());
  // PCGamingWiki writes save paths with placeholders ({{p|steam}}, {{p|uplay}},
  // {{p|game}}): fill them with this PC's real folders.
  let launcherDirs = null;
  function saveLauncherDirs() {
    if (launcherDirs) return launcherDirs;
    let steamDir = null;
    try {
      const roots = require('./src/backend/sources/steam.js').steamRoots();
      steamDir = roots.find((r) => fs.existsSync(path.join(r, 'userdata'))) || roots[0] || null;
    } catch (_) {}
    let ubisoftDir = null;
    if (process.platform === 'win32') {
      const reg = platform.runHelperSync('reg.exe', ['query', 'HKLM\\SOFTWARE\\WOW6432Node\\Ubisoft\\Launcher', '/v', 'InstallDir'], { timeout: 2000 }) || '';
      const m = reg.match(/InstallDir\s+REG_SZ\s+(.+)/i);
      if (m && fs.existsSync(m[1].trim())) ubisoftDir = path.normalize(m[1].trim());
    }
    launcherDirs = { steamDir, ubisoftDir };
    return launcherDirs;
  }
  ipcMain.handle('saves:find', (_, g) => accountReply(() => {
    let installDir = g && g.installDir;
    // a Steam game added by hand may have no folder: ask Steam where it is
    if ((!installDir || !fs.existsSync(installDir)) && g && g.steamAppId) installDir = resolveSteamInstallDir(g.steamAppId) || installDir;
    return findSaveFolders({ name: g && g.name, steamAppId: g && g.steamAppId, installDir }, { documents: app.getPath('documents'), ...saveLauncherDirs() });
  }));
  ipcMain.handle('saves:pick', async (_, current) => {
    const r = await dialog.showOpenDialog(win, { title: 'Choose the game’s save folder', defaultPath: current || app.getPath('documents'), properties: ['openDirectory'] });
    return r.canceled || !r.filePaths[0] ? null : r.filePaths[0];
  });
  // backups note where the saves were, restores find this PC's folder for
  // them (save-roots.js): both need this PC's Steam accounts and profile folder
  const saveWhere = (p) => {
    const q = p && typeof p === 'object' ? p : {};
    const out = { ...q, accounts: steamAccounts(saveLauncherDirs().steamDir), home: app.getPath('home') };
    if ((!out.installDir || !fs.existsSync(out.installDir)) && q.steamAppId) out.installDir = resolveSteamInstallDir(q.steamAppId) || out.installDir || null;
    return out;
  };
  ipcMain.handle('saves:backup', (_, p) => accountReply(() => cloud().backupSaves(saveWhere(p))));
  ipcMain.handle('saves:list', (_, gameId) => accountReply(() => cloud().listBackups(gameId)));
  ipcMain.handle('saves:restore', (_, p) => accountReply(() => cloud().restoreBackup(saveWhere(p))));
  ipcMain.handle('saves:delete', (_, id) => accountReply(() => cloud().deleteBackup(id)));
  // Settings → Backups: every game with copies in the cloud, and failed tries
  ipcMain.handle('saves:overview', () => accountReply(() => cloud().overview()));
  // the saves a restore replaced (kept in userData/cloud/before-restore)
  ipcMain.handle('saves:has-previous', (_, gameId) => !!cloud().safetyFolder(String(gameId || '')));
  ipcMain.handle('saves:open-previous', (_, gameId) => {
    const d = cloud().safetyFolder(String(gameId || ''));
    if (d) shell.openPath(d);
    return !!d;
  });

  // The same, kept on this PC with no account (Settings → Backups)
  let localSavesInstance = null;
  const localSaves = () => {
    if (!localSavesInstance) {
      const { createLocalSaves } = require('./src/backend/local-saves.js');
      localSavesInstance = createLocalSaves({ dir: path.join(path.dirname(DATA_PATH), 'save-copies'), device: require('os').hostname() || 'This PC' });
    }
    return localSavesInstance;
  };
  ipcMain.handle('lsaves:backup', (_, p) => accountReply(() => localSaves().backupSaves(saveWhere(p))));
  ipcMain.handle('lsaves:list', (_, gameId) => accountReply(() => localSaves().listBackups(gameId)));
  ipcMain.handle('lsaves:restore', (_, p) => accountReply(() => localSaves().restoreBackup(saveWhere(p))));
  ipcMain.handle('lsaves:delete', (_, id) => accountReply(() => localSaves().deleteBackup(id)));
  ipcMain.handle('lsaves:overview', () => accountReply(() => localSaves().overview()));
  ipcMain.handle('lsaves:has-previous', (_, gameId) => !!localSaves().safetyFolder(String(gameId || '')));
  ipcMain.handle('lsaves:open-previous', (_, gameId) => {
    const d = localSaves().safetyFolder(String(gameId || ''));
    if (d) shell.openPath(d);
    return !!d;
  });
  ipcMain.handle('lsaves:open-folder', () => {
    const d = localSaves().folder();
    try { fs.mkdirSync(d, { recursive: true }); } catch (_) {}
    shell.openPath(d);
    return true;
  });

  // A copy of the library the user keeps (export) and puts back (restore)
  ipcMain.handle('library:backup-info', () => {
    try { return { at: fs.statSync(`${DATA_PATH}.bak`).mtimeMs }; } catch (_) { return { at: null }; }
  });
  ipcMain.handle('library:export', async () => {
    if (!fs.existsSync(DATA_PATH)) return { ok: false, error: 'There’s no library to save yet.' };
    const day = new Date().toISOString().slice(0, 10);
    const r = await dialog.showSaveDialog(win, {
      title: 'Save a copy of your library',
      defaultPath: path.join(app.getPath('documents'), `GameVault library ${day}.json`),
      filters: [{ name: 'GameVault library', extensions: ['json'] }],
    });
    if (r.canceled || !r.filePath) return { ok: false, canceled: true };
    try {
      fs.copyFileSync(DATA_PATH, r.filePath);
      return { ok: true, path: r.filePath };
    } catch (e) { return { ok: false, error: e.message }; }
  });
  ipcMain.handle('library:read-copy', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Restore your library from a copy',
      defaultPath: app.getPath('documents'),
      properties: ['openFile'],
      filters: [{ name: 'GameVault library', extensions: ['json'] }],
    });
    if (r.canceled || !r.filePaths[0]) return { ok: false, canceled: true };
    try {
      const st = fs.statSync(r.filePaths[0]);
      if (st.size > 200 * 1024 * 1024) return { ok: false, error: 'That file is too big to be a GameVault library.' };
      const v = JSON.parse(fs.readFileSync(r.filePaths[0], 'utf8'));
      const games = Array.isArray(v) ? v : v && Array.isArray(v.games) ? v.games : null;
      if (!games) return { ok: false, error: 'That file isn’t a GameVault library.' };
      return { ok: true, games, name: path.basename(r.filePaths[0]), at: st.mtimeMs };
    } catch (e) { return { ok: false, error: 'That file couldn’t be read as a GameVault library.' }; }
  });

  // Cloud answers worth retrying with the user's key (NOT_FOUND is final).
  const CLOUD_SOFT_FAIL = new Set(['NO_CLOUD', 'NETWORK', 'RATE_LIMIT', 'BUSY', 'SERVER', 'UNAUTHENTICATED', 'AUTH']);
  const hasUserKey = () => !!loadConfig().sgdbKey;
  function cloudError(res) {
    return Object.assign(new Error(res.error.message || 'Artwork unavailable'), { code: res.error.code });
  }
  /** Run the cloud call; on a soft failure use fallback() if the user has a key. */
  async function cloudFirst(cloudCall, fallback) {
    const res = await cloudCall();
    if (res.ok) return res;
    if (CLOUD_SOFT_FAIL.has(res.error.code) && hasUserKey()) return { ok: true, data: await fallback(), viaKey: true };
    return res;
  }
  /** Cloud lookup for a game: by SGDB id, Steam app id, or name (fuzzy-checked). */
  async function cloudLookup({ id, name, steamAppId, fresh }) {
    if (id) return artCache().lookup({ sgdbId: id, fresh });
    if (steamAppId) {
      const r = await artCache().lookup({ steamAppId, fresh });
      if (!r.ok) { if (!name) return r; }
      else {
        // SteamGridDB sometimes links a Steam id to a thin duplicate entry (a
        // new app id, a localized name) while the entry everyone uploads to
        // has no Steam link. When the Steam one is thin, a confident name
        // match with more art wins.
        if (!name || !artThin(r.data)) return r;
        const n = await byName(name, fresh).catch(() => null);
        const same = n && n.ok && n.data.game && r.data.game && n.data.game.id === r.data.game.id;
        const sameName = n && n.ok && n.data.game && plainName(n.data.game.name) === plainName(name);
        const confident = sameName || (n && n.ok && (n.data.matchScore || 0) >= 650);
        if (n && n.ok && !same && confident && artCount(n.data) > artCount(r.data)) return n;
        return r;
      }
    }
    if (!name || !String(name).trim()) return { ok: false, error: { code: 'NOT_FOUND', message: 'No name' } };
    return byName(name, fresh);
  }

  const plainName = (v) => String(v || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const artTotal = (d, k) => (d && d.assets && d.assets[k] && Number(d.assets[k].total)) || 0;
  const artCount = (d) => artTotal(d, 'grids') + artTotal(d, 'heroes') + artTotal(d, 'logos');
  const artThin = (d) => artTotal(d, 'grids') < 10 || artTotal(d, 'logos') < 3 || artTotal(d, 'heroes') < 3;

  async function byName(name, fresh) {
    const r = await artCache().lookup({ term: String(name), fresh });
    if (!r.ok) return r;
    // The server picked the top search hit; re-ask by id if fuzzy matching disagrees.
    const cands = r.data.candidates || [];
    const best = cands.length ? Fuzzy.bestMatch(name, cands, (h) => h.name, { threshold: 0, limit: 3 }) : null;
    r.data.matchScore = best && best.item ? best.score : null;
    r.data.alternatives = best ? best.alternatives : [];
    if (best && best.item && r.data.game && best.item.id !== r.data.game.id) {
      const again = await artCache().lookup({ sgdbId: best.item.id, fresh });
      if (again.ok) return { ok: true, data: { ...again.data, candidates: cands, matchScore: best.score, alternatives: best.alternatives } };
    }
    return r;
  }

  function sgdbWrap(fn) {
    return async (_event, payload) => {
      try {
        return { ok: true, data: await fn(payload) };
      } catch (err) {
        return { ok: false, error: { code: err.code || 'NETWORK', message: err.message } };
      }
    };
  }

  function parseSteamRequirements(html) {
    if (!html) return [];
    const text = String(html)
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(li|ul)>/gi, '\n')
      .replace(/<[^>]+>/g, '');
    const rows = [];
    for (const raw of text.split('\n')) {
      const line = raw.trim();
      const m = line.match(/^(OS|Processor|Memory|Graphics|Storage|DirectX|Network|Sound Card|Additional Notes)\s*:\s*(.+)$/i);
      if (m) rows.push([m[1], m[2].trim()]);
    }
    return rows;
  }

  ipcMain.handle('steam:details', async (_e, appId) => {
    if (!appId) return { ok: false, error: { code: 'NO_ID', message: 'No Steam AppID' } };
    try {
      const json = await httpsGet(
        `https://store.steampowered.com/api/appdetails?appids=${encodeURIComponent(appId)}&cc=us&l=en`
      );
      const entry = json && json[String(appId)];
      if (!entry || !entry.success || !entry.data) {
        return { ok: false, error: { code: 'NOT_FOUND', message: 'Steam has no data for this AppID' } };
      }
      const data = entry.data;
      const rel = data.release_date || null;
      return {
        ok: true,
        data: {
          // wishlist cards: is it out yet (prices come from IsThereAnyDeal)
          release: rel ? { soon: !!rel.coming_soon, date: String(rel.date || '') } : null,
          free: !!data.is_free,
          metacritic: data.metacritic ? { score: data.metacritic.score, url: data.metacritic.url } : null,
          // the PEAK letter: who made it and what it is
          developer: Array.isArray(data.developers) && data.developers.length ? String(data.developers[0]).slice(0, 80) : '',
          genres: Array.isArray(data.genres) ? data.genres.map((x) => String((x && x.description) || '')).filter(Boolean).slice(0, 3) : [],
          // the game's own one-line description, as plain text
          about: String(data.short_description || '').replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim().slice(0, 300),
          minimum: parseSteamRequirements(data.pc_requirements && data.pc_requirements.minimum),
          recommended: parseSteamRequirements(data.pc_requirements && data.pc_requirements.recommended),
        },
      };
    } catch (err) {
      return { ok: false, error: { code: 'NETWORK', message: err.message } };
    }
  });

  // Wishlist "add a game" search: Steam's public store search (no key).
  ipcMain.handle('steam:search', async (_e, term) => {
    const q = String(term || '').trim().slice(0, 80);
    if (q.length < 2) return { ok: true, data: [] };
    try {
      const json = await httpsGet(`https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(q)}&l=english&cc=US`);
      const items = (json && Array.isArray(json.items) ? json.items : [])
        .filter((it) => it && it.type === 'app' && it.id && typeof it.name === 'string')
        .slice(0, 8)
        .map((it) => ({
          appId: Number(it.id),
          name: it.name,
          image: typeof it.tiny_image === 'string' ? it.tiny_image : '',
        }));
      return { ok: true, data: items };
    } catch (err) {
      return { ok: false, error: { code: 'NETWORK', message: err.message } };
    }
  });

  const unwrap = (res) => { if (!res.ok) throw cloudError(res); return res.data; };

  // Wishlist prices: IsThereAnyDeal through GameVault Cloud (the key stays
  // on the server), cached on disk for 6 hours, in the user's own country.
  let pricesInstance = null;
  // Prices for the region the user actually shops in: Steam's own store
  // country (its steamCountry cookie, e.g. IQ), which is what their Steam
  // store shows. Windows' region is only the fallback: an en-US PC in Iraq
  // would otherwise get US prices, higher than their Steam store.
  let countryCache = null;
  function storeCountry() {
    if (countryCache && Date.now() - countryCache.at < 12 * 3600000) return Promise.resolve(countryCache.cc);
    let fallback = 'US';
    try { fallback = (app.getLocaleCountryCode && app.getLocaleCountryCode()) || 'US'; } catch (_) {}
    return new Promise((resolve) => {
      const done = (cc) => { countryCache = { cc, at: Date.now() }; resolve(cc); };
      const req = require('https').get('https://store.steampowered.com/', { timeout: 8000 }, (res) => {
        const cookies = [].concat(res.headers['set-cookie'] || []);
        const m = cookies.map((c) => /steamCountry=([A-Za-z]{2})/.exec(c)).find(Boolean);
        res.resume();
        if (m) done(m[1].toUpperCase()); else { countryCache = null; resolve(fallback); }
      });
      req.on('timeout', () => req.destroy());
      req.on('error', () => resolve(fallback));
    });
  }
  // Steam's own price in the user's store region (no key; one call for many
  // games). IsThereAnyDeal misses regional prices such as Iraq's.
  async function steamRegionPrices(ids, cc) {
    const url = `https://store.steampowered.com/api/appdetails?appids=${ids.join(',')}&cc=${encodeURIComponent(cc)}&filters=price_overview`;
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return {};
    const body = await res.json().catch(() => null);
    const out = {};
    for (const id of ids) {
      const p = body && body[id] && body[id].success && body[id].data && body[id].data.price_overview;
      if (!p || typeof p.final !== 'number') continue;
      out[id] = { amount: p.final / 100, regular: p.initial / 100, cut: Number(p.discount_percent) || 0, currency: String(p.currency || '') };
    }
    return out;
  }

  function pricesApi() {
    if (!pricesInstance) {
      const { url, anonKey } = cloudConfig();
      pricesInstance = createPrices({
        file: path.join(app.getPath('userData'), 'prices.json'), cloudUrl: url, anonKey,
        token: async (o) => (await account().token(o).catch(() => null)) || artCache().token(o),
        steam: steamRegionPrices,
      });
    }
    return pricesInstance;
  }
  ipcMain.handle('prices:get', async (_e, { steamAppIds, itadIds, fresh } = {}) => {
    const country = await storeCountry();
    try {
      return await pricesApi().get({ steamAppIds, itadIds, country, fresh });
    } catch (err) {
      return { ok: false, error: { code: 'SERVER', message: err.message } };
    }
  });
  // the Peak scroll's line about a game (written once in the cloud)
  let peakLinesInstance = null;
  ipcMain.handle('peak:line', async (_e, games) => {
    if (!peakLinesInstance) {
      const { url, anonKey } = cloudConfig();
      peakLinesInstance = createPeakLines({
        file: path.join(app.getPath('userData'), 'peak-lines.json'), cloudUrl: url, anonKey,
        token: async (o) => (await account().token(o).catch(() => null)) || artCache().token(o),
      });
    }
    try {
      return await peakLinesInstance.get(Array.isArray(games) ? games.slice(0, 50) : []);
    } catch (err) {
      return { ok: false, error: { code: 'SERVER', message: err.message } };
    }
  });
  // which game a title is (IsThereAnyDeal), for games with no Steam AppID
  ipcMain.handle('prices:match', async (_e, titles) => {
    try {
      return await pricesApi().match({ titles: Array.isArray(titles) ? titles.slice(0, 100) : [] });
    } catch (err) {
      return { ok: false, error: { code: 'SERVER', message: err.message } };
    }
  });

  ipcMain.handle('sgdb:games', sgdbWrap(async (term) => {
    if (!term || !String(term).trim()) return [];
    // The user's own key goes first; without one, the cloud's title search
    // (cached per term, its own rate bucket apart from game lookups).
    if (hasUserKey()) return sgdbOrThrow().searchGames(String(term).trim());
    if (String(term).trim().length < 3) return [];
    const r = await artCache().search(String(term));
    if (!r.ok && r.error.code === 'NOT_FOUND') return [];
    return unwrap(r).candidates || [];
  }));

  ipcMain.handle('sgdb:resolve', sgdbWrap(async ({ name, steamAppId } = {}) => {
    const cloud = await cloudFirst(() => cloudLookup({ name, steamAppId }), () => resolveWithKey({ name, steamAppId }));
    if (cloud.viaKey) return cloud.data;
    if (!cloud.ok && cloud.error.code === 'NOT_FOUND') return { match: null, alternatives: [] };
    const data = unwrap(cloud);
    const score = data.matchScore != null ? data.matchScore : 1000;
    return { match: data.game ? { ...data.game, score } : null, alternatives: data.alternatives || [] };
  }));

  async function resolveWithKey({ name, steamAppId } = {}) {
    const client = sgdbOrThrow();
    if (steamAppId) {
      const byId = await client.gameBySteamAppId(steamAppId).catch(() => null);
      if (byId) return { match: { ...byId, score: 1000 }, alternatives: [] };
    }
    if (!name) return { match: null, alternatives: [] };
    const hits = await client.searchGames(name);
    if (!hits.length) return { match: null, alternatives: [] };
    const best = Fuzzy.bestMatch(name, hits, (h) => h.name, { threshold: 0, limit: 3 });
    return {
      match: best.item ? { ...best.item, score: best.score } : null,
      alternatives: best.alternatives,
    };
  }

  ipcMain.handle('sgdb:assets', sgdbWrap(async ({ kind, id, page, styles, pageSize } = {}) => {
    if (!id) throw new Error('Missing SteamGridDB game id');
    const withKey = () => sgdbOrThrow().assets(kind, id, { page, styles, pageSize: pageSize || 50 });
    // Cloud pages are 50 items in SteamGridDB order; a style filter is applied here.
    const cloud = await cloudFirst(() => artCache().page(id, kind, page || 0), withKey);
    if (cloud.viaKey) return cloud.data;
    const data = unwrap(cloud);
    if (!styles || !styles.length) return data;
    const items = data.items.filter((a) => styles.includes(a.style));
    return { ...data, items, total: items.length };
  }));

  // Download the picked art into the local cache: { slot: { url, remote, … } }
  async function cacheAssets(picks) {
    const assets = {};
    await Promise.all(Object.entries(picks).map(async ([slot, asset]) => {
      if (!asset || !asset.url) return;
      let local = asset.url;
      try { local = await cacheImage(asset.url, slot); } catch (_) {}
      assets[slot] = { url: local, remote: asset.url, width: asset.width, height: asset.height, style: asset.style, score: asset.score };
    }));
    return assets;
  }

  // Steam's own library art for the slots it has (it wins over SteamGridDB).
  async function steamPicks(appId, keep) {
    const out = {};
    if (!appId) return out;
    const steam = await artCache().steamArt(appId).catch(() => null);
    if (!steam || !steam.ok) return out;
    for (const slot of ['cover', 'hero', 'logo']) {
      if (keep(slot) && steam.data[slot]) out[slot] = { url: steam.data[slot], width: null, height: null, style: 'official', score: null };
    }
    return out;
  }

  // slots: only fetch these (bulk enrichment skips what a game already has).
  // bulk: no picker-thumbnail warmup (that's 100+ downloads per game).
  // a name match this good or better (every word of the name found) is
  // trusted by the automatic art fill; anything less is left for the picker
  const BULK_NAME_SCORE = 300;
  ipcMain.handle('sgdb:autofill', sgdbWrap(async ({ id, name, steamAppId, slots, bulk, fresh } = {}) => {
    const want = Array.isArray(slots) && slots.length ? new Set(slots) : null;
    const keep = (slot) => !want || want.has(slot);
    // A Steam game whose own art covers every slot asked for never touches
    // SteamGridDB: no lookup, no rate limit, just Steam's CDN.
    let steam = null;
    if (steamAppId && want) {
      steam = await steamPicks(steamAppId, keep);
      if ([...want].every((s) => steam[s])) return { match: null, assets: await cacheAssets(steam) };
    }
    const cloud = await cloudFirst(() => cloudLookup({ id, name, steamAppId, fresh }), () => autofillWithKey({ id, name, steamAppId, keep, bulk }));
    if (cloud.viaKey) return cloud.data;
    // SteamGridDB doesn't know it, or can't answer right now (busy, hourly
    // limit): keep whatever Steam's own art had instead of nothing
    if (!cloud.ok && steamAppId) {
      const own = steam || await steamPicks(steamAppId, keep);
      if (Object.keys(own).length || cloud.error.code === 'NOT_FOUND') return { match: null, assets: await cacheAssets(own) };
    }
    if (!cloud.ok && cloud.error.code === 'NOT_FOUND') return { match: null, assets: {} };
    const data = unwrap(cloud);
    const game = data.game || {};
    const match = { ...game };
    if (data.matchScore != null) match.score = data.matchScore;
    else if (!id && steamAppId) match.score = 1000; // matched by Steam app id
    else if (!id) match.score = Fuzzy.score(name || '', game.name || '').score; // by name: SteamGridDB's first hit
    // The automatic fill only takes a name match that really is that name:
    // a game SteamGridDB doesn't know must not get another game's art
    if (bulk && !id && !steamAppId && !(match.score >= BULK_NAME_SCORE)) return { match: null, assets: {} };

    // Steam games: Steam's own library art wins; SteamGridDB fills the gaps.
    const picks = {};
    for (const slot of ['cover', 'hero', 'logo', 'icon']) if (keep(slot) && data.top && data.top[slot]) picks[slot] = data.top[slot];
    Object.assign(picks, await steamPicks(steamAppId || game.steamAppId, keep));

    const assets = await cacheAssets(picks);
    // Warm the picker's thumbnails in the background (not for bulk runs).
    if (!bulk) artCache().prefetchThumbs(data).catch(() => {});
    return { match, assets };
  }));

  async function autofillWithKey({ id, name, steamAppId, keep = () => true, bulk = false } = {}) {
    const client = sgdbOrThrow();
    let gameId = id;
    let match = null;
    if (!gameId && steamAppId) {
      const byId = await client.gameBySteamAppId(steamAppId).catch(() => null);
      if (byId) { match = { ...byId, score: 1000 }; gameId = byId.id; }
    }
    if (!gameId) {
      const hits = await client.searchGames(name || '');
      const best = Fuzzy.bestMatch(name || '', hits, (h) => h.name, { threshold: bulk ? BULK_NAME_SCORE : 0, limit: 3 });
      if (!best.item) return { match: null, assets: {} };
      match = { ...best.item, score: best.score };
      gameId = best.item.id;
    } else {
      match = await client.gameById(gameId).catch(() => ({ id: gameId, name: name || '' }));
    }

    const kinds = [['cover', 'grids'], ['hero', 'heroes'], ['logo', 'logos'], ['icon', 'icons']].filter(([slot]) => keep(slot));
    const picked = await Promise.all(kinds.map(async ([slot, kind]) => {
      try {
        const top = await client.topOf(kind, gameId);
        return [slot, top];
      } catch (_) {
        return [slot, null];
      }
    }));

    const picks = {};
    for (const [slot, asset] of picked) if (asset) picks[slot] = asset;
    Object.assign(picks, await steamPicks(steamAppId, keep));
    return { match, assets: await cacheAssets(picks) };
  }

  ipcMain.handle('sgdb:cache', sgdbWrap(async ({ url, kind } = {}) => {
    if (!url) throw new Error('Missing image url');
    return cacheImage(url, kind || 'art');
  }));

  ipcMain.handle('startup:get', () => {
    if (process.platform === 'linux') {
      return fs.existsSync(autostartFilePath());
    }
    // Check both OS setting and our config (config is more reliable in dev mode)
    const cfg = loadConfig();
    const osState = app.getLoginItemSettings().openAtLogin;
    return osState || cfg.startupEnabled || false;
  });
  ipcMain.handle('startup:set', (_, enable) => {
    if (process.platform === 'linux') {
      setLinuxAutostart(enable);
    } else {
      app.setLoginItemSettings({ openAtLogin: enable, name: 'GameVault' });
    }
    // Also persist in config for reliable state tracking
    const cfg = loadConfig();
    cfg.startupEnabled = enable;
    saveConfig(cfg);
    return true;
  });

  ipcMain.on('open-external', (_, url) => {
    if (typeof url !== 'string' || url.length > 8192) return;
    let parsed;
    try { parsed = new URL(url); } catch (_) { return; }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return;
    shell.openExternal(parsed.href).catch(() => {});
  });

  startBgPoll();
}

function cleanOwnCachesWhenTight() {
  try {
    const st = fs.statfsSync ? fs.statfsSync(app.getPath('userData')) : null;
    const free = st ? st.bavail * st.bsize : Infinity;
    if (free > 2.5 * 1024 ** 3) return;
    for (const dir of ['Cache', 'Code Cache', 'GPUCache', 'DawnCache', 'ShaderCache']) {
      try { fs.rmSync(path.join(app.getPath('userData'), dir), { recursive: true, force: true }); } catch (_) {}
    }
    console.log('[disk] freed app caches, low space');
  } catch (_) {}
}

app.whenReady().then(() => {
  // Windows shows notifications (screenshot saved, clip saved) only for an app
  // with an id; the installer gives its shortcut the same one
  if (process.platform === 'win32') {
    try { app.setAppUserModelId(require('./package.json').build.appId); } catch (_) {}
  }
  cleanOwnCachesWhenTight();
  if (!hasSingleInstanceLock) return;
  createWindow();
  // a tray failure must not stop the rest of start-up (hotkeys, image cache)
  try { createTray(); } catch (err) { console.warn('tray:', err && err.message); }
  try { setAfkMinutes(loadConfig().afkMinutes); } catch (_) {}
  onSessionEnd(() => comeBackAfterGame());
  const cfg = loadConfig();
  Capture.setup({
    mediaDir: () => path.join(path.dirname(DATA_PATH), 'data_media'),
    currentGame: currentCaptureGame,
    config: () => loadConfig(),
    onChange: () => { if (win && !win.isDestroyed()) win.webContents.send('capture:changed'); },
    onRecording: (on, gameName) => {
      if (tray) tray.setToolTip(on ? 'GameVault · recording' + (gameName ? ' ' + gameName : '') : 'GameVault');
      refreshTray();
      if (win && !win.isDestroyed()) win.webContents.send('capture:recording', on);
    },
  });
  registerCaptureShortcuts(cfg);
  findOthersOn = cfg.captureFindOthers !== false;
  Finder.setup({
    userDir: () => path.dirname(DATA_PATH),
    mediaDir: () => path.join(path.dirname(DATA_PATH), 'data_media'),
    games: () => { const g = loadGames(); return Array.isArray(g) ? g : []; },
    sessions: runningSessions,
    enabled: () => findOthersOn,
    onChange: () => { if (win && !win.isDestroyed()) win.webContents.send('capture:changed'); },
  });

  // Autostart launches hidden
  if (cliArgs.hidden && win) win.hide();

  const { session } = require('electron');
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    if (permission === 'media') {
      callback(true);
    } else {
      callback(false);
    }
  });
  session.defaultSession.setPermissionCheckHandler((webContents, permission) => {
    return permission === 'media';
  });
  // Keep SteamGridDB picker images in Chromium's cache for 3 days.
  installSgdbImageCaching(session.defaultSession);
});

// Windows only ever show GameVault's own pages. A link or file dropped on the
// window, or a stray redirect, would otherwise load a page that gets the
// app's API through the preload script. Web links open in the browser.
const APP_PAGES_DIR = path.join(__dirname, 'src') + path.sep;
function isAppPage(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'file:') return false;
    const p = require('url').fileURLToPath(u);
    return process.platform === 'win32'
      ? p.toLowerCase().startsWith(APP_PAGES_DIR.toLowerCase())
      : p.startsWith(APP_PAGES_DIR);
  } catch (_) { return false; }
}
app.on('web-contents-created', (_e, contents) => {
  contents.on('will-navigate', (e, url) => {
    if (!isAppPage(url)) e.preventDefault();
  });
  contents.setWindowOpenHandler(({ url }) => {
    try {
      const u = new URL(url);
      if (u.protocol === 'http:' || u.protocol === 'https:') shell.openExternal(u.href).catch(() => {});
    } catch (_) {}
    return { action: 'deny' };
  });
  contents.on('will-attach-webview', (e) => e.preventDefault());
});

app.on('window-all-closed', () => {
  // Don't quit — stay in tray
});

// Quit sequence: end running sessions (tracking:session-end), let the renderer
// save ('app:flush' -> 'app:flushed', 2.5 s cap), drain the write queue, then
// quit for real. Closing the window only hides it, so before-quit is always a
// real quit (tray Quit, updater install, OS).
let quitFlushState = 'idle'; // idle | flushing | done
app.on('before-quit', (e) => {
  forceQuit = true;
  if (bgPollInterval) { clearInterval(bgPollInterval); bgPollInterval = null; }
  if (quitFlushState === 'done') return;
  if (quitFlushState === 'flushing') { e.preventDefault(); return; }

  const canFlush = win && !win.isDestroyed() && !win.webContents.isDestroyed();
  stopAllTracking();
  if (!canFlush) { quitFlushState = 'done'; return; }

  e.preventDefault();
  quitFlushState = 'flushing';
  const finish = () => {
    if (quitFlushState === 'done') return;
    quitFlushState = 'done';
    ipcMain.removeListener('app:flushed', onFlushed);
    clearTimeout(timer);
    try { Finder.shutdown(); } catch (_) {}
    Promise.race([Promise.all([gamesWriteTail, Capture.shutdown()]), new Promise((r) => setTimeout(r, 3500))]).then(() => app.quit());
  };
  const onFlushed = (event) => { if (!win || win.isDestroyed() || event.sender === win.webContents) finish(); };
  const timer = setTimeout(finish, 2500);
  ipcMain.on('app:flushed', onFlushed);
  try { win.webContents.send('app:flush'); } catch (_) { finish(); }
});

app.on('activate', () => {
  if (win) win.show();
  else createWindow();
});
