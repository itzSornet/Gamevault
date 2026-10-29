// GameVault v1.3.1 - Main Process
const { app, BrowserWindow, ipcMain, dialog, shell, Tray, Menu, globalShortcut, desktopCapturer, nativeImage } = require('electron');
app.name = 'GameVault Experimental';
if (app.setName) app.setName('GameVault Experimental');
// Cap Chromium's disk caches: headless capture runs used to inflate them to GBs.
app.commandLine.appendSwitch('disk-cache-size', String(150 * 1024 * 1024));

const path = require('path');
const fs = require('fs');
const { execSync, exec } = require('child_process');
const https = require('https');
const crypto = require('crypto');
const platform = require('./src/backend/platform.js');

const { DATA_PATH, CONFIG_PATH, AI_PROFILE_PATH, loadGames, saveGames, cacheImage, cacheGameImages, loadConfig, saveConfig, aiLoadProfile, aiSaveProfile } = require('./src/backend/data.js');
const { detectSteamGames, detectEpicGames, detectLutrisGames, scanFolder, smartScan, resolveSteamInstallDir, findMainExe } = require('./src/backend/scanner.js');
const importers = require('./src/backend/importers.js');
const steamSource = require('./src/backend/sources/steam.js');
const { setTrackerWindow, startTracking, stopTracking, stopAllTracking, detectPCSpecs, trackedProcesses, collectGameExes, initLibraryTracking, killGameProcesses } = require('./src/backend/tracker.js');

const { initUpdater } = require('./src/backend/updater.js');
const { createSgdb } = require('./src/backend/sgdb.js');
const { httpsGet } = require('./src/backend/api.js');
const Fuzzy = require('./src/lib/fuzzy.js');

let win = null;
let overlayWin = null;
let tray = null;
let forceQuit = false;
let bgPollInterval = null;

// CLI flags (used by autostart and compositor keybinds on Wayland)
const cliArgs = platform.parseCliArgs(process.argv);

// Headless capture mode used while building the UI:
//   electron . --shot /tmp/shot.png [--wait 1500]
const shotIdx = process.argv.indexOf('--shot');
const shotPath = shotIdx !== -1 ? process.argv[shotIdx + 1] : '';
const waitIdx = process.argv.indexOf('--wait');
const shotWait = waitIdx !== -1 ? Number(process.argv[waitIdx + 1]) || 1500 : 1500;
const stateIdx = process.argv.indexOf('--shot-state');
const shotState = stateIdx !== -1 ? process.argv[stateIdx + 1] : '';
const delayIdx = process.argv.indexOf('--shot-delay');
const shotDelay = delayIdx !== -1 ? Number(process.argv[delayIdx + 1]) || 900 : 900;

// A second launch must never create a second library window or overlay.
// It hands its flags to the running instance instead.
const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) app.quit();

// Wayland has no X11-style screen grab; Electron needs the PipeWire path.
if (process.platform === 'linux') {
  app.commandLine.appendSwitch('enable-features', 'WebRTCPipeWireCapturer');
}

app.on('second-instance', (_event, argv) => {
  const flags = platform.parseCliArgs(argv);
  if (flags.toggleOverlay) { toggleOverlay(); return; }
  if (win && !win.isDestroyed()) { win.show(); win.focus(); }
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

function launchGame(gameId, exePath, installDir, steamAppId, launcherPath) {
  const sid = String(gameId);
  const games = loadGames();
  const gameRecord = games.find(x => String(x.id) === sid);
  const launchOpts = gameRecord || {};

  const requestedRunner = launchOpts.runner || 'auto';
  const launchArgs = Array.isArray(launchOpts.launchArgs) ? launchOpts.launchArgs : [];
  const protonPath = launchOpts.protonPath || '';

  // Launch: launcherPath if provided, otherwise exePath or steam
  const pathToLaunch = launcherPath || exePath;
  if (steamAppId && !launcherPath) {
    startTracking(sid, exePath, installDir, steamAppId);
    shell.openExternal(`steam://rungameid/${steamAppId}`);
  } else if (pathToLaunch) {
    if (!fs.existsSync(pathToLaunch)) {
      win && win.webContents.send('game:launch-error', { gameId, error: `Executable not found:\n${pathToLaunch}\n\nThe file may have been moved, deleted, or the drive is disconnected.` });
      return;
    }

    const kind = platform.classifyExecutable(pathToLaunch);
    const runner = platform.pickRunner(requestedRunner, {
      kind,
      hasWine: commandExists('wine'),
      hasProton: !!protonPath && fs.existsSync(protonPath),
    });

    const effectiveProton = runner === 'proton'
      ? (protonPath || platform.findProton())
      : '';
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
      const childPid = child.pid || 0;
      child.on('error', (err) => {
        win && win.webContents.send('game:launch-error', { gameId, error: `Failed to launch game:\n${err.message}` });
      });
      child.unref();
      startTracking(sid, exePath, installDir, steamAppId, childPid);
    } catch (err) {
      win && win.webContents.send('game:launch-error', { gameId, error: `Failed to launch game:\n${err.message}` });
      return;
    }
  } else {
    startTracking(sid, exePath, installDir, steamAppId);
  }

  // Update lastPlayed and backfill any missing exePath / installDir
  if (gameRecord) {
    gameRecord.lastPlayed = Date.now();
    const tp = trackedProcesses[sid];
    if (tp) {
      if (!gameRecord.installDir && tp.installDir) gameRecord.installDir = tp.installDir;
      if (!gameRecord.exePath && tp.exePath) gameRecord.exePath = tp.exePath;
    }
    saveGames(games);
    refreshTray();
    win && win.webContents.send('games:updated');
  }
}

function buildTrayMenu() {
  const games = loadGames();
  const recent = games
    .filter(g => (g.exePath || g.steamAppId) && g.lastPlayed)
    .sort((a, b) => (b.lastPlayed || 0) - (a.lastPlayed || 0))
    .slice(0, 3);

  const recentItems = recent.length
    ? recent.map(g => ({
      label: g.name.length > 28 ? g.name.slice(0, 28) + '…' : g.name,
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
  const pollCmd = process.platform === 'win32' ? 'tasklist /NH /FO CSV' : 'ps -eo comm=,args=';
  bgPollInterval = setInterval(async () => {
    try {
      const result = await new Promise(resolve => {
        exec(pollCmd, { encoding: 'utf-8', timeout: 5000 }, (err, stdout) => {
          resolve(err ? '' : stdout.toLowerCase());
        });
      });
      if (!result) return;
      const games = loadGames();
      games.filter(g => g.exePath && g.status === 'Playing').forEach(g => {
        const gameId = String(g.id);
        if (trackedProcesses[gameId]) return; // already tracked
        // Use the names we already know; never walk the install dir here —
        // this runs every 30s and must stay O(1).
        const tracked = trackedProcesses[String(g.id)];
        const gameExes = (tracked && tracked.allExeNames && tracked.allExeNames.length)
          ? tracked.allExeNames
          : [path.basename(g.exePath).toLowerCase()];
        const isRunning = gameExes.some(name => result.includes(name));
        if (isRunning) {
          startTracking(gameId, g.exePath);
          win && win.webContents.send('tracking:detected', { gameId: g.id, gameName: g.name });
        }
      });
    } catch (e) { }
  }, 30000);
}

function createOverlayWindow() {
  overlayWin = new BrowserWindow({
    width: 400,
    height: 600,
    x: 0, // Will be updated on show to align right
    y: 0,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    resizable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  overlayWin.setIgnoreMouseEvents(true);
  overlayWin.loadFile(path.join(__dirname, 'src', 'overlay.html'));

  overlayWin.on('hide', () => {
    if (overlayWin && !overlayWin.isDestroyed()) {
      overlayWin.setIgnoreMouseEvents(true);
    }
  });

  overlayWin.on('show', () => {
    if (overlayWin && !overlayWin.isDestroyed()) {
      overlayWin.setIgnoreMouseEvents(false);
    }
  });

  // Guard: don't hide immediately after showing (blur fires on show sometimes)
  let showTime = 0;
  overlayWin.on('blur', () => {
    if (overlayWin && overlayWin.isVisible() && (Date.now() - showTime > 500)) {
      overlayWin.hide();
    }
  });

  overlayWin.showOverlay = () => {
    // Wayland compositors ignore client positioning, so don't pretend.
    if (!overlayWin.hasBeenPositioned && !platform.isWayland()) {
      const { screen } = require('electron');
      const primaryDisplay = screen.getPrimaryDisplay();
      const { width, height } = primaryDisplay.workAreaSize;
      overlayWin.setBounds({
        x: width - 420,
        y: Math.floor((height - 600) / 2),
        width: 400,
        height: 600
      });
      overlayWin.hasBeenPositioned = true;
    }
    showTime = Date.now();
    overlayWin.show();
    overlayWin.focus();
    overlayWin.setIgnoreMouseEvents(false);
    overlayWin.webContents.send('overlay:opened');
  };
}

function toggleOverlay() {
  if (!overlayWin) { console.log('[Overlay] No overlayWin'); return; }
  if (overlayWin.isVisible()) {
    overlayWin.setIgnoreMouseEvents(true);
    overlayWin.hide();
  } else {
    overlayWin.showOverlay();
  }
}

function registerOverlayShortcut(hotkey) {
  globalShortcut.unregisterAll();
  if (!hotkey) return;
  const debugLog = (msg) => {
    const line = `[${new Date().toISOString()}] ${msg}\n`;
    console.log(line.trim());
    fs.appendFileSync(path.join(path.dirname(DATA_PATH), 'overlay_debug.log'), line);
  };
  if (platform.isWayland()) {
    debugLog('Wayland session: global shortcuts unavailable; bind a compositor shortcut to `gamevault --toggle-overlay`');
    return;
  }
  try {
    debugLog('Registering hotkey: ' + hotkey);
    const success = globalShortcut.register(hotkey, () => {
      debugLog('CALLBACK FIRED for ' + hotkey);
      toggleOverlay();
    });
    debugLog('Registration result: ' + success);
    debugLog('isRegistered check: ' + globalShortcut.isRegistered(hotkey));
  } catch (e) {
    debugLog('ERROR: ' + e.message);
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: Number(process.env.GV_W || 1200),
    height: Number(process.env.GV_H || 760),
    minWidth: 900,
    minHeight: 580,
    frame: false,
    show: !shotPath,
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
  setTrackerWindow(win);
  initUpdater(win, () => { forceQuit = true; });

  win.loadFile(path.join(__dirname, 'src', 'index.html'), shotState ? { hash: shotState } : undefined);

  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) console.log('[renderer]', message);
  });

  if (shotPath) {
    win.webContents.once('did-finish-load', () => {
      if (process.argv.includes('--gpu-log')) {
        setTimeout(async () => {
          try {
            console.log('[gpu-live]', JSON.stringify(app.getGPUFeatureStatus()));
            const i = await app.getGPUInfo('complete');
            console.log('[gpu-live-info]', JSON.stringify(i).slice(0, 500));
          } catch (e) { console.log('[gpu-live] err', e.message); }
        }, 1500);
      }
    });
    // Never leave a headless instance behind if the page fails to load.
    const shotTimer = setTimeout(() => {
      console.error('[shot] timed out waiting for the page');
      app.exit(1);
    }, shotWait + 20000);

    win.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        try {
          await win.webContents.executeJavaScript("document.documentElement.classList.add('shot-mode'); document.body.classList.add('shot-mode');");
          if (shotState) {
            const info = await win.webContents.executeJavaScript(`(() => {
              let err = '';
              try {
                window.__gvForceAnim = true;
                if (typeof window.__gvDevOpen === 'function') window.__gvDevOpen(${JSON.stringify(shotState)});
                else err = 'no dev hook';
              } catch (e) { err = String(e); }
              const strip = document.getElementById('shelf-strip');
              const t0 = strip && strip.querySelector('.shelf-tile');
              const gv = document.getElementById('game-view');
              return {
                err,
                cards: document.querySelectorAll('.card').length,
                gameViewVisible: gv ? !gv.hidden : false,
                gameViewHeight: gv ? Math.round(gv.getBoundingClientRect().height) : 0,
                stripRect: strip ? (r => [Math.round(r.x), Math.round(r.width)])(strip.getBoundingClientRect()) : null,
                stripPad: strip ? getComputedStyle(strip).paddingLeft : null,
                stripScroll: strip ? strip.scrollLeft : null,
                tileRect: t0 ? (r => [Math.round(r.x), Math.round(r.width)])(t0.getBoundingClientRect()) : null,
                tileTop: t0 ? Math.round(t0.getBoundingClientRect().top) : null,
                tileH: t0 ? Math.round(t0.getBoundingClientRect().height) : null,
                stripTop: strip ? Math.round(strip.getBoundingClientRect().top) : null,
                stripH: strip ? Math.round(strip.getBoundingClientRect().height) : null,
                stageTitle: (document.querySelector('[data-title]') || {}).textContent || null,
                firstTile: (document.querySelector('.shelf-tile-label') || {}).textContent || null,
                detailTitle: (document.querySelector('.gv-title') || {}).textContent || null,
                saveProbe: window.__saveProbe || null,
                addProbe: window.__addProbe || null,
                flow: window.__flow || null,
                detailArt: (() => {
                  const el = document.querySelector('.gv-art');
                  if (!el || !el.style.backgroundImage) return null;
                  return el.style.backgroundImage.slice(-42);
                })(),
                vis: (() => {
                  const g = (id) => { const el = document.getElementById(id); return el ? !el.hidden : null; };
                  return { shelf: g('shelf'), library: g('library'), detail: g('game-view'), modal: g('modal'), filterbar: g('filterbar'), topbar: g('topbar') };
                })(),
                artPanel: (() => {
                  const p = document.getElementById('art-panel');
                  if (!p) return null;
                  return {
                    hidden: p.hidden,
                    items: p.querySelectorAll('.sg-thumb').length,
                    text: (p.querySelector('.art-match') || {}).textContent || '',
                    empty: (p.querySelector('.art-empty') || {}).textContent || '',
                    button: (document.querySelector('[data-art-expand]') || {}).textContent || '',
                    tab: (p.querySelector('.art-tab.is-active') || {}).textContent || '',
                    modalHidden: (document.getElementById('modal') || {}).hidden,
                    firstNotes: (window.__gvNotesProbe ? 'probe' : ''),
                    thumbs: p.querySelectorAll('.art-grid .sg-thumb').length,
                    cols: (() => { const g = p.querySelector('.art-grid'); return g ? getComputedStyle(g).gridTemplateColumns : ''; })(),
                    firstThumb: (() => {
                      const t = p.querySelector('.sg-thumb');
                      if (!t) return null;
                      const r = t.getBoundingClientRect();
                      const cs = getComputedStyle(t);
                      return [Math.round(r.width), Math.round(r.height), cs.aspectRatio, cs.height, cs.alignSelf];
                    })(),
                  };
                })(),
                tileCount: document.querySelectorAll('.shelf-tile').length,
                sortOpened: window.__sortOpened,
                sortErr: window.__sortErr || null,
                handlerSrc: window.__handlerSrc,
                ariaAfter: window.__ariaAfter,
                openCalls: window.__openCalls || 0,
                closeCalls: window.__closeCalls || 0,
                sortHasHandler: window.__hasHandler,
              };
            })()`);
            console.log('[shot] state:', JSON.stringify(info));
            await new Promise((r) => setTimeout(r, shotDelay));
          }

          try {
            const scrollAfter = await win.webContents.executeJavaScript("document.getElementById('shelf-strip') ? document.getElementById('shelf-strip').scrollLeft : -1");
            console.log('[shot] railScroll=' + scrollAfter);
            const bg = await win.webContents.executeJavaScript(`(() => {
              const a = document.querySelector('.shelf-art.is-on');
              const st = window.__gvState;
              const g = st && st.games.find((x) => String(x.id) === String(st.shelfId));
              const gvEl = document.getElementById('game-view');
              return {
                fold: gvEl ? [gvEl.scrollHeight, gvEl.clientHeight, gvEl.scrollWidth, gvEl.clientWidth] : null,
                stage: a ? a.style.backgroundImage : null,
                heroUrl: g ? g.heroUrl : null,
                heroThumb: g ? g._hero : null,
                baseHero: window.__baseHero || null,
                targetHero: window.__targetHero || null,
                thumbs: document.querySelectorAll('#art-results .sg-thumb').length || 0,
              };
            })()`);
            console.log('[shot] artProbe=' + JSON.stringify(bg));
          } catch (_) {}

          const image = await win.webContents.capturePage();
          clearTimeout(shotTimer);
          fs.writeFileSync(shotPath, image.toPNG());
          console.log('[shot] wrote ' + shotPath);
        } catch (e) {
          console.error('[shot] failed:', e.message);
        }
        app.exit(0);
      }, shotWait);
    });
  }

  // Close to tray instead of quitting
  win.on('close', (e) => {
    if (!forceQuit) {
      e.preventDefault();
      win.hide();
      refreshTray();
    }
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
  ipcMain.on('win-close', () => win && win.hide());
  ipcMain.handle('img:thumb', async (_e, { src, width, kind }) => {
    try {
      if (!src) return null;
      let file = String(src);
      if (file.startsWith('file://')) {
        try { file = decodeURIComponent(new URL(file).pathname); } catch (_) { file = file.replace('file://', ''); }
      }
      if (!fs.existsSync(file)) return null;
      const crypto = require('crypto');
      const stat = fs.statSync(file);
      const key = crypto.createHash('md5').update(`${file}:${stat.mtimeMs}:${width}`).digest('hex');
      const dir = path.join(app.getPath('userData'), 'thumbs');
      fs.mkdirSync(dir, { recursive: true });
      const out = path.join(dir, `${key}.jpg`);
      if (fs.existsSync(out)) return require('url').pathToFileURL(out).href;

      const img = nativeImage.createFromPath(file);
      if (img.isEmpty()) return null;
      const size = img.getSize();
      // A portrait cover blown up to a banner looks like a smeared render bug.
      if (kind === 'hero' && size.width / size.height < 1.45) return '__reject__';
      const resized = size.width > width ? img.resize({ width, quality: 'good' }) : img;
      fs.writeFileSync(out, resized.toJPEG(88));
      return require('url').pathToFileURL(out).href;
    } catch (_) {
      return null;
    }
  });

  ipcMain.handle('win:is-maximized', () => win ? win.isMaximized() : false);
  ipcMain.handle('app:platform-info', () => ({
    platform: process.platform,
    wayland: platform.isWayland(),
    globalHotkeysSupported: !platform.isWayland(),
    protonPath: process.platform === 'linux' ? platform.findProton() : '',
  }));
  ipcMain.on('overlay:update-hotkey', (_, hotkey) => registerOverlayShortcut(hotkey));
  ipcMain.on('overlay:hide', () => { if (overlayWin) overlayWin.hide(); });
  ipcMain.on('overlay:toggle', () => toggleOverlay());

  ipcMain.handle('capture:get-screen', async () => {
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen'] });
      if (!sources.length) {
        console.warn('No screen capture source (Wayland needs xdg-desktop-portal + PipeWire)');
        return null;
      }
      return sources[0].id;
    } catch (e) {
      console.warn('desktopCapturer failed:', e.message);
      return null;
    }
  });

  function mediaDirPath() { return path.join(path.dirname(DATA_PATH), 'data_media'); }
  function safeMediaJoin(filename) {
    if (typeof filename !== 'string' || !filename.trim()) return null;
    const base = path.basename(filename);
    if (base !== filename) return null;
    if (!/^[A-Za-z0-9._-]{1,120}$/.test(base)) return null;
    if (!/\.(png|jpe?g|webp|gif|mp4|webm)$/i.test(base)) return null;
    const dir = mediaDirPath();
    const target = path.resolve(dir, base);
    const rel = path.relative(dir, target);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
    return target;
  }
  function safeMediaExisting(filePath) {
    if (typeof filePath !== 'string') return null;
    const dir = mediaDirPath();
    const target = path.resolve(filePath);
    const rel = path.relative(dir, target);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
    if (!/\.(png|jpe?g|webp|gif|mp4|webm)$/i.test(target)) return null;
    return target;
  }

  ipcMain.handle('capture:save-media', (_, { type, buffer, filename } = {}) => {
    try {
      const mediaDir = mediaDirPath();
      if (!fs.existsSync(mediaDir)) fs.mkdirSync(mediaDir);
      const filePath = safeMediaJoin(filename);
      if (!filePath) return { success: false, error: 'Invalid filename' };
      fs.writeFileSync(filePath, Buffer.from(buffer));
      return { success: true, path: filePath };
    } catch (err) {
      console.error('Failed to save media:', err);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('capture:get-recent', (_, limit = 3) => {
    try {
      const mediaDir = path.join(path.dirname(DATA_PATH), 'data_media');
      if (!fs.existsSync(mediaDir)) return [];
      const files = fs.readdirSync(mediaDir);
      const mapped = files.map(f => ({
        name: f,
        path: path.join(mediaDir, f),
        time: fs.statSync(path.join(mediaDir, f)).mtimeMs
      }));
      mapped.sort((a, b) => b.time - a.time);
      return limit ? mapped.slice(0, limit) : mapped;
    } catch (e) {
      return [];
    }
  });

  ipcMain.handle('capture:get-all', () => {
    try {
      const mediaDir = path.join(path.dirname(DATA_PATH), 'data_media');
      if (!fs.existsSync(mediaDir)) return [];
      const files = fs.readdirSync(mediaDir);
      const mapped = files.map(f => ({
        name: f,
        path: path.join(mediaDir, f),
        time: fs.statSync(path.join(mediaDir, f)).mtimeMs
      }));
      mapped.sort((a, b) => b.time - a.time);
      return mapped;
    } catch (e) {
      return [];
    }
  });

  ipcMain.handle('capture:delete-media', (_, filePath) => {
    try {
      const target = safeMediaExisting(filePath);
      if (!target) return false;
      if (fs.existsSync(target) && fs.statSync(target).isFile()) {
        fs.unlinkSync(target);
        return true;
      }
    } catch (e) {
      console.warn('Failed to delete media', e);
    }
    return false;
  });

  ipcMain.on('capture:show-folder', (_, filePath) => {
    const target = safeMediaExisting(filePath);
    if (target) shell.showItemInFolder(target);
  });

  ipcMain.on('game:show-in-folder', (_, targetPath) => {
    if (!targetPath || typeof targetPath !== 'string') return;
    try {
      if (fs.existsSync(targetPath)) {
        shell.showItemInFolder(targetPath);
      }
    } catch (_) {}
  });

  ipcMain.handle('games:load', () => {
    const games = loadGames();
    let updated = false;
    for (const g of games) {
      if (g.steamAppId) {
        if (!g.installDir) {
          const resolved = resolveSteamInstallDir(g.steamAppId);
          if (resolved) { g.installDir = resolved; updated = true; }
        }
        if (!g.exePath && g.installDir) {
          const exe = findMainExe(g.installDir);
          if (exe) { g.exePath = exe; updated = true; }
        }
      }
    }
    if (updated) saveGames(games);
    return games;
  });
  ipcMain.handle('games:backup', () => {
    try {
      if (!fs.existsSync(DATA_PATH)) return null;
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const dest = `${DATA_PATH}.bak-${stamp}`;
      fs.copyFileSync(DATA_PATH, dest);
      return dest;
    } catch (_) { return null; }
  });

  ipcMain.handle('games:save', async (_, games) => {
    await cacheGameImages(games);
    saveGames(games);
    refreshTray();
    return true;
  });
  ipcMain.handle('games:data-path', () => DATA_PATH);

  ipcMain.handle('config:load', () => loadConfig());
  ipcMain.handle('config:save', (_, cfg) => { saveConfig(cfg); return true; });

  ipcMain.handle('detect:steam', () => detectSteamGames());
  ipcMain.handle('detect:epic', () => detectEpicGames());
  ipcMain.handle('detect:lutris', () => detectLutrisGames());
  ipcMain.handle('import:sources', () => importers.listSources());
  ipcMain.handle('steam:account', () => {
    const { users } = steamSource.loginUsers();
    return { users, active: steamSource.activeSteamId() };
  });
  function mapSteamWebGames(games) {
    const out = [];
    for (const g of games) {
      const name = g && g.name;
      if (!name) continue;
      const raw = String(g.hours_forever || g.hours || '0').replace(/,/g, '');
      const hours = Math.round((Number(raw) || 0) * 100) / 100;
      out.push({
        name,
        source: 'Steam account',
        sourceId: `steam:${g.appid}`,
        exePath: '', installDir: '', hours,
        steamAppId: Number(g.appid) || null,
        iconPath: '', ownedOnly: true,
      });
    }
    return out;
  }

  function mapSteamWebGames(games) {
    const out = [];
    for (const g of games || []) {
      const name = g && g.name;
      if (!name) continue;
      const raw = String(g.hours_forever || g.hours || '0').replace(/,/g, '');
      out.push({
        name,
        source: 'Steam account',
        sourceId: `steam:${g.appid}`,
        exePath: '', installDir: '',
        hours: Math.round((Number(raw) || 0) * 100) / 100,
        steamAppId: Number(g.appid) || null,
        iconPath: '', ownedOnly: true,
      });
    }
    return out;
  }

  async function sessionJson(authWin, url) {
    const ses = authWin.webContents.session;
    const cookies = await ses.cookies.get({ url });
    const cookie = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
    const res = await fetch(url, {
      headers: { Cookie: cookie, 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) GameVault/2.0' },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    try { return JSON.parse(text); } catch (_) { return { raw: text }; }
  }

  ipcMain.handle('steam:login', async () => {
    const steamId = steamSource.activeSteamId();
    if (!steamId) return { ok: false, error: { code: 'NO_ID', message: 'No Steam login found on this machine' } };
    return new Promise((resolve) => {
      const authWin = new BrowserWindow({
        width: 1000, height: 760, parent: win, modal: true, show: true,
        title: 'Sign in to Steam',
        webPreferences: { partition: 'persist:steam-login', contextIsolation: true, nodeIntegration: false },
      });
      let done = false;
      let poll = null;
      const stopPoll = () => { if (poll) { clearInterval(poll); poll = null; } };
      const finish = (result) => {
        if (done) return;
        done = true;
        stopPoll();
        resolve(result);
        if (!authWin.isDestroyed()) authWin.destroy();
      };

      const readGames = () => authWin.webContents.executeJavaScript(`(() => {
        try {
          if (typeof rgGames !== 'undefined' && Array.isArray(rgGames)) return rgGames;
          if (Array.isArray(window.rgGames)) return window.rgGames;
        } catch (e) {}
        const anchors = [...document.querySelectorAll('a[href*="/app/"]')];
        const out = new Map();
        for (const a of anchors) {
          const m = (a.getAttribute('href') || '').match(/\\/app\\/(\\d+)/);
          if (!m) continue;
          const appid = Number(m[1]);
          if (out.has(appid)) continue;
          let node = a;
          for (let depth = 0; depth < 7 && node; depth++, node = node.parentElement) {
            const text = node.innerText || '';
            if (!/TOTAL PLAYED/i.test(text) || text.length > 500) continue;
            const img = a.querySelector('img') || node.querySelector('img');
            const name = (a.innerText || '').trim() || (img && img.alt ? img.alt.trim() : '');
            if (!name) break;
            const hm = text.match(/TOTAL PLAYED\\s*([\\d.,]+)\\s*(minutes?|hours?|hrs?)/i);
            let hours = 0;
            if (hm) {
              const n = parseFloat(hm[1].replace(/,/g, ''));
              hours = /hour|hr/i.test(hm[2]) ? n : n / 60;
            }
            out.set(appid, { appid, name, hours: Math.round(hours * 100) / 100 });
            break;
          }
        }
        return out.size ? [...out.values()] : null;
      })()`).catch(() => null);

      const complete = async (games) => {
        stopPoll();
        try {
          const owned = mapSteamWebGames(games);
          const wish = await sessionJson(authWin, `https://store.steampowered.com/wishlist/profiles/${steamId}/wishlistdata/?p=0`).catch(() => null);
          const wishlist = wish && typeof wish === 'object' && !wish.raw ? Object.keys(wish).filter((k) => /^\d+$/.test(k)).map((id) => ({ appid: Number(id), name: wish[id] && wish[id].name })) : [];
          const friendsRaw = await sessionJson(authWin, 'https://steamcommunity.com/actions/ajaxgetfriendslist').catch(() => null);
          const friends = (friendsRaw && friendsRaw.friendslist && friendsRaw.friendslist.friends) || [];
          console.log('[steam] login ok', { owned: owned.length, wishlist: wishlist.length, friends: friends.length });
          finish({ ok: true, data: { owned, wishlist, friends, profile: null } });
        } catch (e) {
          finish({ ok: false, error: { code: 'PARSE', message: e.message } });
        }
      };

      const startPolling = () => {
        if (poll || done) return;
        let tries = 0;
        const tick = async () => {
          if (done || authWin.isDestroyed()) { stopPoll(); return; }
          tries += 1;
          const games = await readGames();
          if (tries === 1 || tries % 10 === 0) console.log('[steam] poll', tries, 'games=', Array.isArray(games) ? games.length : 0);
          if (Array.isArray(games) && games.length) { complete(games); return; }
          if (tries > 100) { stopPoll(); finish({ ok: false, error: { code: 'NO_GAMES', message: 'Signed in, but Steam never loaded your games page' } }); }
        };
        poll = setInterval(tick, 1200);
        tick();
      };

      authWin.webContents.on('did-finish-load', startPolling);
      authWin.webContents.on('did-navigate-in-page', startPolling);
      authWin.on('closed', () => finish({ ok: false, error: { code: 'CANCELLED', message: 'Sign-in window closed' } }));
      authWin.loadURL(`https://steamcommunity.com/profiles/${steamId}/games/?tab=all`);
    });
  });

  const PERF_LOG = path.join(app.getPath('userData'), 'perf.log');
  ipcMain.on('perf:log', (_, sample) => {
    try {
      fs.appendFileSync(PERF_LOG, JSON.stringify(sample) + '\n');
      const st = fs.statSync(PERF_LOG);
      if (st.size > 3 * 1024 * 1024) fs.renameSync(PERF_LOG, PERF_LOG + '.old');
    } catch (_) {}
  });
  ipcMain.handle('perf:path', () => PERF_LOG);
  ipcMain.on('perf:reveal', () => { try { shell.showItemInFolder(PERF_LOG); } catch (_) {} });

  ipcMain.handle('app:gpu', () => {
    try { return app.getGPUFeatureStatus(); } catch (e) { return {}; }
  });

  ipcMain.handle('steam:owned', async (_, payload = {}) => {
    const cfg = loadConfig() || {};
    return steamSource.scanOwned({ key: payload.key || cfg.steamKey, steamId: payload.steamId || cfg.steamId || steamSource.activeSteamId() });
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

  ipcMain.handle('detect:folder', async () => {
    const result = await dialog.showOpenDialog(win, {
      properties: ['openDirectory'],
      title: 'Select games folder to scan',
    });
    if (result.canceled || !result.filePaths[0]) return [];
    return scanFolder(result.filePaths[0]);
  });

  ipcMain.on('tracking:start', (_, { gameId, exePath, installDir, steamAppId }) => startTracking(String(gameId), exePath, installDir, steamAppId));
  ipcMain.on('tracking:stop', (_, { gameId }) => stopTracking(String(gameId)));
  ipcMain.handle('tracking:active', () => Object.keys(trackedProcesses));

  ipcMain.handle('pick:exe', async () => {
    const result = await dialog.showOpenDialog(win, {
      properties: ['openFile'],
      filters: process.platform === 'win32'
        ? [{ name: 'Executables', extensions: ['exe'] }]
        : [{ name: 'All files', extensions: ['*'] }],
      title: process.platform === 'win32' ? 'Select game .exe' : 'Select game executable',
    });
    return result.canceled ? null : result.filePaths[0];
  });

  ipcMain.handle('pick:image', async () => {
    const result = await dialog.showOpenDialog(win, {
      properties: ['openFile'],
      filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif'] }],
      title: 'Select cover image',
    });
    if (result.canceled || !result.filePaths[0]) return null;
    // Convert to base64 data URL so it works without file:// CSP issues
    const imgPath = result.filePaths[0];
    const ext = path.extname(imgPath).slice(1).toLowerCase();
    const mime = ext === 'jpg' ? 'jpeg' : ext;
    const data = fs.readFileSync(imgPath).toString('base64');
    return `data:image/${mime};base64,${data}`;
  });

  ipcMain.on('game:launch', (_, { exePath, steamAppId, gameId, installDir, launcherPath }) => {
    launchGame(gameId, exePath, installDir, steamAppId, launcherPath);
  });

  // Kill a running game
  ipcMain.handle('game:kill', async (_, { gameId, exePath, installDir, steamAppId, launcherPath }) => {
    return await killGameProcesses(gameId, exePath, installDir, steamAppId, launcherPath);
  });

  ipcMain.handle('detect:disk', () => scanAllDisks());
  ipcMain.handle('detect:smart', () => smartScan(win));

  function sgdbOrThrow() {
    const cfg = loadConfig();
    if (!cfg.sgdbKey) {
      const err = new Error('Add a SteamGridDB API key in Settings');
      err.code = 'NO_KEY';
      throw err;
    }
    return createSgdb(cfg.sgdbKey);
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
      return {
        ok: true,
        data: {
          metacritic: data.metacritic ? { score: data.metacritic.score, url: data.metacritic.url } : null,
          minimum: parseSteamRequirements(data.pc_requirements && data.pc_requirements.minimum),
          recommended: parseSteamRequirements(data.pc_requirements && data.pc_requirements.recommended),
        },
      };
    } catch (err) {
      return { ok: false, error: { code: 'NETWORK', message: err.message } };
    }
  });

  ipcMain.handle('sgdb:games', sgdbWrap(async (term) => {
    if (!term || !String(term).trim()) return [];
    return sgdbOrThrow().searchGames(String(term).trim());
  }));

  ipcMain.handle('sgdb:resolve', sgdbWrap(async ({ name, steamAppId } = {}) => {
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
  }));

  ipcMain.handle('sgdb:assets', sgdbWrap(async ({ kind, id, page, styles, pageSize } = {}) => {
    if (!id) throw new Error('Missing SteamGridDB game id');
    return sgdbOrThrow().assets(kind, id, { page, styles, pageSize: pageSize || 50 });
  }));

  ipcMain.handle('sgdb:autofill', sgdbWrap(async ({ id, name } = {}) => {
    const client = sgdbOrThrow();
    let gameId = id;
    let match = null;
    if (!gameId) {
      const hits = await client.searchGames(name || '');
      const best = Fuzzy.bestMatch(name || '', hits, (h) => h.name, { threshold: 0, limit: 3 });
      if (!best.item) return { match: null, assets: {} };
      match = { ...best.item, score: best.score };
      gameId = best.item.id;
    } else {
      match = await client.gameById(gameId).catch(() => ({ id: gameId, name: name || '' }));
    }

    const kinds = [['cover', 'grids'], ['hero', 'heroes'], ['logo', 'logos'], ['icon', 'icons']];
    const picked = await Promise.all(kinds.map(async ([slot, kind]) => {
      try {
        const top = await client.topOf(kind, gameId);
        return [slot, top];
      } catch (_) {
        return [slot, null];
      }
    }));

    const assets = {};
    await Promise.all(picked.map(async ([slot, asset]) => {
      if (!asset || !asset.url) return;
      let local = asset.url;
      try { local = await cacheImage(asset.url, slot); } catch (_) {}
      assets[slot] = {
        url: local,
        remote: asset.url,
        width: asset.width,
        height: asset.height,
        style: asset.style,
        score: asset.score,
      };
    }));

    return { match, assets };
  }));

  ipcMain.handle('sgdb:cache', sgdbWrap(async ({ url, kind } = {}) => {
    if (!url) throw new Error('Missing image url');
    return cacheImage(url, kind || 'art');
  }));

  ipcMain.handle('sgdb:key:get', () => {
    const cfg = loadConfig();
    return { hasKey: !!cfg.sgdbKey };
  });

  ipcMain.handle('sgdb:key:set', (_e, key) => {
    const cfg = loadConfig();
    cfg.sgdbKey = String(key || '').trim();
    saveConfig(cfg);
    return { ok: true, hasKey: !!cfg.sgdbKey };
  });

  ipcMain.handle('sgdb:key:test', sgdbWrap(async () => {
    const games = await sgdbOrThrow().searchGames('hades');
    return { count: games.length };
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

  ipcMain.handle('games:scan-running', async (_, gamesList) => {
    try {
      return await initLibraryTracking(gamesList);
    } catch (e) {
      console.warn('Scan running failed', e);
      return [];
    }
  });

  ipcMain.on('open-external', (_, url) => shell.openExternal(url));

  // AI Advisor handlers
  ipcMain.handle('pick:gcpkey', async () => {
    const result = await dialog.showOpenDialog(win, {
      properties: ['openFile'],
      filters: [{ name: 'JSON Key', extensions: ['json'] }],
      title: 'Select Google Cloud service account key file',
    });
    return result.canceled ? null : result.filePaths[0];
  });

  ipcMain.handle('ai:detect-specs', async () => detectPCSpecs());

  ipcMain.handle('ai:validate-key', async (_, { provider, key, endpoint, modelName }) => {
    try {
      let url = '';
      let headers = { 'Content-Type': 'application/json' };
      let body = null;
      let method = 'GET';

      if (provider === 'openai') {
        url = 'https://api.openai.com/v1/models';
        headers['Authorization'] = `Bearer ${key}`;
      } else if (provider === 'anthropic') {
        url = 'https://api.anthropic.com/v1/messages';
        method = 'POST';
        headers['x-api-key'] = key;
        headers['anthropic-version'] = '2023-06-01';
        body = JSON.stringify({ model: 'claude-3-haiku-20240307', max_tokens: 1, messages: [{ role: 'user', content: 'test' }] });
      } else if (provider === 'deepseek') {
        url = 'https://api.deepseek.com/models';
        headers['Authorization'] = `Bearer ${key}`;
      } else if (provider === 'google') {
        url = `https://generativelanguage.googleapis.com/v1beta/models?key=${key}`;
      } else if (provider === 'custom') {
        let base = (endpoint || '').replace(/\/+$/, '');
        if (!base.endsWith('/chat/completions')) base += '/chat/completions';
        url = base;
        method = 'POST';
        if (key) headers['Authorization'] = `Bearer ${key}`;
        body = JSON.stringify({ model: modelName || 'gpt-3.5-turbo', max_tokens: 1, messages: [{ role: 'user', content: 'test' }] });
      } else {
        return { valid: false, error: 'Unknown provider' };
      }

      let parsedUrl;
      try { parsedUrl = new URL(url); } catch (e) { return { valid: false, error: 'Invalid Endpoint URL' }; }
      const reqPath = parsedUrl.pathname + parsedUrl.search;

      const resData = await new Promise((resolve, reject) => {
        const req = https.request({
          hostname: parsedUrl.hostname,
          path: reqPath,
          method,
          headers,
          timeout: 5000
        }, res => {
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => resolve({ status: res.statusCode, data }));
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
        if (body) req.write(body);
        req.end();
      });

      if (resData.status >= 200 && resData.status < 300) {
        return { valid: true };
      } else {
        let msg = `HTTP Error ${resData.status}`;
        try { const errObj = JSON.parse(resData.data); msg = errObj.error?.message || msg; } catch (e) { }
        return { valid: false, error: msg };
      }
    } catch (e) {
      return { valid: false, error: e.message };
    }
  });

  ipcMain.handle('ai:load-profile', () => {
    try { if (fs.existsSync(AI_PROFILE_PATH)) return JSON.parse(fs.readFileSync(AI_PROFILE_PATH, 'utf-8')); }
    catch (e) { }
    return { preferences: { likedGenres: [], dislikedGenres: [], dislikedGames: [], recommendedBefore: [] }, chatHistory: [], pcSpecs: null };
  });

  ipcMain.handle('ai:save-profile', (_, profile) => {
    fs.writeFileSync(AI_PROFILE_PATH, JSON.stringify(profile, null, 2), 'utf-8');
    if (win) win.webContents.send('ai:profile-updated', profile);
    if (overlayWin) overlayWin.webContents.send('ai:profile-updated', profile);
    return true;
  });

  ipcMain.handle('ai:chat', async (_, { message, history, specs, games: userGames, profile }) => {
    const cfg = loadConfig();
    if (!cfg.aiEnabled || !cfg.aiKey) return { error: 'AI Assistant is not configured. Add an API key in Settings.' };
    try {
      // Build library summary
      const libSummary = (userGames || []).filter(g => g.status !== 'Want').map(g => {
        const hrs = g.hours ? ` (${g.hours}h)` : '';
        return `- ${g.name} [${g.status}]${hrs}`;
      }).join('\n') || 'Empty library';

      const wishlist = (userGames || []).filter(g => g.status === 'Want').map(g => `- ${g.name}`).join('\n') || 'None';

      // Build preference context
      const prefs = profile?.preferences || {};
      const liked = prefs.likedGenres?.length ? prefs.likedGenres.join(', ') : 'Not yet known';
      const disliked = prefs.dislikedGenres?.length ? prefs.dislikedGenres.join(', ') : 'None specified';
      const alreadyRecommended = prefs.recommendedBefore?.length ? prefs.recommendedBefore.join(', ') : 'None yet';

      // Build specs string — include ALL GPUs
      const gpuLines = specs?.allGpus?.length
        ? specs.allGpus.map((g, i) => `GPU ${i + 1}: ${g.name} (${g.vram} VRAM)`).join('\n')
        : `GPU: ${specs?.gpu || 'Unknown'}`;
      const specsStr = specs
        ? `CPU: ${specs.cpu}\n${gpuLines}\nRAM: ${specs.ram}\nOS: ${specs.os}`
        : 'Unknown (not yet detected)';

      const systemPrompt = `You are GameVault AI — an enthusiastic, knowledgeable gaming advisor built into a PC game library app. You're like a best friend who LOVES games and knows hardware.

== USER'S PC SPECS ==
${specsStr}

== USER'S GAME LIBRARY ==
${libSummary}

== USER'S WISHLIST ==
${wishlist}

== USER PREFERENCES ==
Liked genres/styles: ${liked}
Disliked genres/styles: ${disliked}
Already recommended (DO NOT suggest these again): ${alreadyRecommended}

== YOUR RULES ==
1. **BE CONCISE.** Keep replies SHORT — 2-4 sentences for casual chat. Only go longer when giving a detailed game recommendation.
2. When recommending, include a quick FPS estimate like: "⚡ ~60 FPS (High) | ~45 FPS (Ultra)" — don't over-explain.
3. NEVER recommend games the user already owns or already recommended before.
4. If the user dislikes a genre, respect it completely.
5. Be enthusiastic but not wordy. Sell the vibe, not a paragraph.
6. If the user asks a simple question, give a simple answer. Don't pad responses.
7. Consider play patterns: most hours = favorites, dropped = disliked styles.
8. End with a short question only when recommending, not every message.
9. Default to 1 focused recommendation unless asked for more.
10. If their PC can't run something well, be honest and suggest alternatives.`;

      // Build messages array (OpenAI chat format)
      const messages = [
        { role: 'system', content: systemPrompt },
        ...(history || []).map(msg => {
          let c = msg.content || msg.text;
          if (typeof c === 'object') c = c.reply || JSON.stringify(c);
          return {
            role: msg.role === 'assistant' || msg.role === 'ai' ? 'assistant' : 'user',
            content: c || '',
          };
        }),
        { role: 'user', content: message },
      ];
      let url = '';
      let headers = { 'Content-Type': 'application/json' };
      let bodyData = null;
      const openaiFormat = { model: cfg.aiCustomModel || 'gpt-4o-mini', messages, temperature: 0.85, max_tokens: 600 };

      if (cfg.aiProvider === 'openai') {
        url = 'https://api.openai.com/v1/chat/completions';
        headers['Authorization'] = `Bearer ${cfg.aiKey}`;
        bodyData = openaiFormat;
      } else if (cfg.aiProvider === 'anthropic') {
        url = 'https://api.anthropic.com/v1/messages';
        headers['x-api-key'] = cfg.aiKey;
        headers['anthropic-version'] = '2023-06-01';
        bodyData = { model: 'claude-3-haiku-20240307', system: messages[0].content, messages: messages.slice(1), max_tokens: 600, temperature: 0.85 };
      } else if (cfg.aiProvider === 'deepseek') {
        url = 'https://api.deepseek.com/chat/completions';
        headers['Authorization'] = `Bearer ${cfg.aiKey}`;
        openaiFormat.model = 'deepseek-chat';
        bodyData = openaiFormat;
      } else if (cfg.aiProvider === 'google') {
        url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${cfg.aiKey}`;
        bodyData = { systemInstruction: { parts: [{ text: messages[0].content }] }, contents: messages.slice(1).map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })), generationConfig: { temperature: 0.85, maxOutputTokens: 600 } };
      } else if (cfg.aiProvider === 'custom') {
        url = (cfg.aiCustomEndpoint || '').replace(/\/+$/, '');
        if (!url.endsWith('/chat/completions')) url += '/chat/completions';
        if (cfg.aiKey) headers['Authorization'] = `Bearer ${cfg.aiKey}`;
        bodyData = openaiFormat;
      }

      let parsedUrl;
      try { parsedUrl = new URL(url); } catch (e) { return { error: 'Invalid AI Endpoint URL' }; }

      const body = JSON.stringify(bodyData);
      const reqPath = parsedUrl.pathname + parsedUrl.search;

      const text = await new Promise((resolve, reject) => {
        const req = https.request({
          hostname: parsedUrl.hostname,
          path: reqPath,
          method: 'POST',
          headers,
        }, res => {
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => {
            try {
              const json = JSON.parse(data);
              if (json.error) reject(new Error(json.error.message || JSON.stringify(json.error)));

              let contentStr = '';
              if (cfg.aiProvider === 'google') {
                contentStr = json.candidates?.[0]?.content?.parts?.[0]?.text || '';
              } else if (cfg.aiProvider === 'anthropic') {
                contentStr = json.content?.[0]?.text || '';
              } else {
                contentStr = json.choices?.[0]?.message?.content || '';
              }

              resolve(contentStr || '(No response from AI)');
            } catch (e) { reject(new Error('Failed to parse AI response')); }
          });
        });
        req.on('error', reject);
        req.setTimeout(45000, () => { req.destroy(); reject(new Error('AI request timed out')); });
        req.write(body);
        req.end();
      });

      return { reply: text };
    } catch (e) {
      console.error('AI chat error:', e.message);
      if (e.message?.includes('429') || e.message?.includes('rate')) {
        return { error: 'Rate limited \u2014 wait a moment and try again.' };
      }
      return { error: `AI error: ${e.message}` };
    }
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
  cleanOwnCachesWhenTight();
  if (process.argv.includes('--gpu-info')) {
    console.log('[gpu-probe] start');
    // Query AFTER a window exists: before that the GPU process has not started.
    const probe = new BrowserWindow({ show: false, width: 1200, height: 760, webPreferences: { contextIsolation: true } });
    probe.loadFile(path.join(__dirname, 'src', 'index.html'));
    probe.webContents.once('did-finish-load', () => {
      console.log('[gpu-probe] loaded');
      setTimeout(async () => {
        try {
          console.log('[gpu-live]', JSON.stringify(app.getGPUFeatureStatus()));
          const info = await app.getGPUInfo('complete');
          console.log('[gpu-live-info]', JSON.stringify(info).slice(0, 600));
        } catch (e) { console.log('[gpu-live] error', e.message); }
        app.exit(0);
      }, 3000);
    });
    return;
  }
  if (!hasSingleInstanceLock) return;
  createWindow();
  createOverlayWindow();
  createTray();
  const cfg = loadConfig();
  registerOverlayShortcut(cfg.overlayHotkey);

  // Autostart launches hidden; a compositor binding can open the overlay.
  if (cliArgs.hidden && win) win.hide();
  if (cliArgs.toggleOverlay) setTimeout(() => toggleOverlay(), 500);

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
});

app.on('window-all-closed', () => {
  // Don't quit — stay in tray
});

app.on('before-quit', () => {
  forceQuit = true;
  stopAllTracking();
  if (bgPollInterval) clearInterval(bgPollInterval);
});

app.on('activate', () => {
  if (win) win.show();
  else createWindow();
});
