const { app, ipcMain } = require('electron');
const { autoUpdater } = require('electron-updater');
const https = require('https');
const { loadConfig, saveConfig } = require('./data.js');

let mainWindow = null;
let updateAvailableInfo = null;
let isDownloading = false;

function initUpdater(win) {
  mainWindow = win;

  // Configure autoUpdater
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowPrerelease = false;

  // Wire autoUpdater events
  autoUpdater.on('checking-for-update', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('updater:checking');
    }
  });

  autoUpdater.on('update-available', (info) => {
    updateAvailableInfo = info;
    const config = loadConfig();

    // Check if this version is skipped
    if (config.skippedVersion && config.skippedVersion === info.version) {
      return;
    }

    // Check if update reminder is snoozed
    if (config.snoozeUntil && Date.now() < config.snoozeUntil && config.snoozedVersion === info.version) {
      return;
    }

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('updater:available', {
        version: info.version,
        currentVersion: app.getVersion(),
        releaseDate: info.releaseDate,
        releaseNotes: info.releaseNotes || '',
        releaseName: info.releaseName || `GameVault v${info.version}`
      });
    }
  });

  autoUpdater.on('update-not-available', (info) => {
    updateAvailableInfo = null;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('updater:not-available', {
        version: app.getVersion(),
        latestVersion: info ? info.version : app.getVersion()
      });
    }
  });

  autoUpdater.on('download-progress', (progressObj) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('updater:progress', {
        percent: Math.round(progressObj.percent || 0),
        bytesPerSecond: progressObj.bytesPerSecond || 0,
        transferred: progressObj.transferred || 0,
        total: progressObj.total || 0
      });
    }
  });

  autoUpdater.on('update-downloaded', (info) => {
    isDownloading = false;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('updater:downloaded', {
        version: info.version
      });
    }
  });

  autoUpdater.on('error', (err) => {
    isDownloading = false;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('updater:error', {
        message: (err && err.message) ? err.message : 'Unable to check for updates.'
      });
    }
  });

  // IPC Handlers
  ipcMain.handle('updater:get-version', () => {
    return app.getVersion();
  });

  ipcMain.handle('updater:check', async (_, isManual = false) => {
    try {
      if (!app.isPackaged) {
        // Fallback check against GitHub API during local development
        return await checkGitHubReleasesDev(isManual);
      }
      return await autoUpdater.checkForUpdates();
    } catch (e) {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('updater:error', { message: e.message || 'Check failed' });
      }
      return null;
    }
  });

  ipcMain.handle('updater:download', async () => {
    if (isDownloading) return;
    isDownloading = true;
    try {
      if (!app.isPackaged) {
        // Simulate download progression in dev mode for UI testing
        simulateDevDownload();
        return;
      }
      await autoUpdater.downloadUpdate();
    } catch (e) {
      isDownloading = false;
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('updater:error', { message: e.message || 'Download failed' });
      }
    }
  });

  ipcMain.handle('updater:install', () => {
    if (app.isPackaged) {
      autoUpdater.quitAndInstall(false, true);
    } else {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('updater:dev-installed');
      }
    }
  });

  ipcMain.handle('updater:snooze', (_, { version, hours = 24 }) => {
    const config = loadConfig();
    config.snoozedVersion = version;
    config.snoozeUntil = Date.now() + (hours * 60 * 60 * 1000);
    saveConfig(config);
    return true;
  });

  ipcMain.handle('updater:skip', (_, version) => {
    const config = loadConfig();
    config.skippedVersion = version;
    saveConfig(config);
    return true;
  });
}

// Development mode GitHub Releases API query
async function checkGitHubReleasesDev(isManual) {
  return new Promise((resolve) => {
    const options = {
      hostname: 'api.github.com',
      path: '/repos/itzSornet/Gamevault/releases/latest',
      headers: {
        'User-Agent': 'GameVault-App'
      }
    };

    https.get(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          if (res.statusCode === 200) {
            const release = JSON.parse(data);
            const latestVer = release.tag_name ? release.tag_name.replace(/^v/, '') : '1.0.0';
            const currentVer = app.getVersion();

            if (latestVer !== currentVer && isVersionNewer(latestVer, currentVer)) {
              if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('updater:available', {
                  version: latestVer,
                  currentVersion: currentVer,
                  releaseDate: release.published_at,
                  releaseNotes: release.body || '',
                  releaseName: release.name || `GameVault v${latestVer}`
                });
              }
            } else {
              if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('updater:not-available', {
                  version: currentVer,
                  latestVersion: latestVer
                });
              }
            }
          } else {
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('updater:not-available', {
                version: app.getVersion(),
                latestVersion: app.getVersion()
              });
            }
          }
          resolve(true);
        } catch (err) {
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('updater:not-available', {
              version: app.getVersion(),
              latestVersion: app.getVersion()
            });
          }
          resolve(false);
        }
      });
    }).on('error', () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('updater:not-available', {
          version: app.getVersion(),
          latestVersion: app.getVersion()
        });
      }
      resolve(false);
    });
  });
}

function isVersionNewer(latest, current) {
  const lParts = latest.split('.').map(n => parseInt(n, 10) || 0);
  const cParts = current.split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(lParts.length, cParts.length); i++) {
    const l = lParts[i] || 0;
    const c = cParts[i] || 0;
    if (l > c) return true;
    if (l < c) return false;
  }
  return false;
}

function simulateDevDownload() {
  let percent = 0;
  const total = 78000000;
  const interval = setInterval(() => {
    percent += 15;
    if (percent >= 100) {
      percent = 100;
      clearInterval(interval);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('updater:progress', {
          percent: 100,
          bytesPerSecond: 4500000,
          transferred: total,
          total: total
        });
        setTimeout(() => {
          isDownloading = false;
          mainWindow.webContents.send('updater:downloaded', { version: '1.1.0' });
        }, 500);
      }
    } else {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('updater:progress', {
          percent,
          bytesPerSecond: 4200000,
          transferred: Math.round((percent / 100) * total),
          total
        });
      }
    }
  }, 400);
}

module.exports = {
  initUpdater
};
