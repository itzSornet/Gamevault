const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Window
  minimize: () => ipcRenderer.send('win-minimize'),
  maximize: () => ipcRenderer.send('win-maximize'),
  close:    () => ipcRenderer.send('win-close'),

  // Games data
  loadGames:   () => ipcRenderer.invoke('games:load'),
  saveGames:   (g) => ipcRenderer.invoke('games:save', g),
  getDataPath: () => ipcRenderer.invoke('games:data-path'),

  // Config (RAWG key etc)
  loadConfig: () => ipcRenderer.invoke('config:load'),
  saveConfig: (c) => ipcRenderer.invoke('config:save', c),

  // Auto-detect
  detectSteam:  () => ipcRenderer.invoke('detect:steam'),
  detectEpic:   () => ipcRenderer.invoke('detect:epic'),
  detectFolder: () => ipcRenderer.invoke('detect:folder'),

  // Exe tracking
  trackingStart: (gameId, exePath) => ipcRenderer.send('tracking:start', { gameId, exePath }),
  trackingStop:  (gameId)          => ipcRenderer.send('tracking:stop',  { gameId }),
  trackingActive: ()               => ipcRenderer.invoke('tracking:active'),
  onTrackingTick:       (cb) => ipcRenderer.on('tracking:tick',        (_, d) => cb(d)),
  onTrackingSessionEnd: (cb) => ipcRenderer.on('tracking:session-end', (_, d) => cb(d)),
  onTrackingStarted:    (cb) => ipcRenderer.on('tracking:started',     (_, d) => cb(d)),

  // Pick image file for custom cover
  pickImage: () => ipcRenderer.invoke('pick:image'),

  launchGame: (exePath, steamAppId, gameId) => ipcRenderer.send('game:launch', { exePath, steamAppId, gameId }),
  killGame: (gameId, exePath, installDir) => ipcRenderer.invoke('game:kill', { gameId, exePath, installDir }),

  // Tracking detected (game launched outside app)
  onTrackingDetected: (cb) => ipcRenderer.on('tracking:detected', (_, d) => cb(d)),
  onLaunchError: (cb) => ipcRenderer.on('game:launch-error', (_, d) => cb(d)),

  // Pick exe file
  pickExe: () => ipcRenderer.invoke('pick:exe'),

  // SteamGridDB search
  sgdbSearch: (q) => ipcRenderer.invoke('sgdb:search', q),
  sgdbHero: (name) => ipcRenderer.invoke('sgdb:hero', name),

  // Disk scan
  detectDisk: () => ipcRenderer.invoke('detect:disk'),
  smartScan: () => ipcRenderer.invoke('detect:smart'),
  onDetectProgress: (cb) => ipcRenderer.on('detect:progress', (_, msg) => cb(msg)),

  // Startup with Windows
  getStartup: () => ipcRenderer.invoke('startup:get'),
  setStartup: (v) => ipcRenderer.invoke('startup:set', v),

  // Scan running processes
  scanRunning: (games) => ipcRenderer.invoke('games:scan-running', games),

  // External links
  openExternal: (url) => ipcRenderer.send('open-external', url),

  // Overlay
  updateOverlayHotkey: (hotkey) => ipcRenderer.send('overlay:update-hotkey', hotkey),
  hideOverlay: () => ipcRenderer.send('overlay:hide'),
  toggleOverlay: () => ipcRenderer.send('overlay:toggle'),
  onOverlayOpened: (cb) => ipcRenderer.on('overlay:opened', () => cb()),

  // Media Capture
  getScreenSourceId: () => ipcRenderer.invoke('capture:get-screen'),
  saveMedia: (data) => ipcRenderer.invoke('capture:save-media', data),
  getRecentMedia: (limit) => ipcRenderer.invoke('capture:get-recent', limit),
  getAllMedia: () => ipcRenderer.invoke('capture:get-all'),
  deleteMedia: (path) => ipcRenderer.invoke('capture:delete-media', path),
  showMediaInFolder: (path) => ipcRenderer.send('capture:show-folder', path),

  // AI Chat
  aiChat: (data) => ipcRenderer.invoke('ai:chat', data),
  aiDetectSpecs: () => ipcRenderer.invoke('ai:detect-specs'),
  aiLoadProfile: () => ipcRenderer.invoke('ai:load-profile'),
  aiSaveProfile: (profile) => ipcRenderer.invoke('ai:save-profile', profile),
  onProfileUpdated: (cb) => ipcRenderer.on('ai:profile-updated', (_, p) => cb(p)),
  aiValidateKey: (data) => ipcRenderer.invoke('ai:validate-key', data),
  pickGcpKey: () => ipcRenderer.invoke('pick:gcpkey'),

  // In-App Updater
  getAppVersion: () => ipcRenderer.invoke('updater:get-version'),
  checkForUpdates: (isManual) => ipcRenderer.invoke('updater:check', isManual),
  downloadUpdate: () => ipcRenderer.invoke('updater:download'),
  installUpdate: () => ipcRenderer.invoke('updater:install'),
  snoozeUpdate: (version, hours) => ipcRenderer.invoke('updater:snooze', { version, hours }),
  skipUpdate: (version) => ipcRenderer.invoke('updater:skip', version),
  onUpdateChecking: (cb) => ipcRenderer.on('updater:checking', () => cb()),
  onUpdateAvailable: (cb) => ipcRenderer.on('updater:available', (_, d) => cb(d)),
  onUpdateNotAvailable: (cb) => ipcRenderer.on('updater:not-available', (_, d) => cb(d)),
  onUpdateProgress: (cb) => ipcRenderer.on('updater:progress', (_, d) => cb(d)),
  onUpdateDownloaded: (cb) => ipcRenderer.on('updater:downloaded', (_, d) => cb(d)),
  onUpdateError: (cb) => ipcRenderer.on('updater:error', (_, d) => cb(d)),
});
