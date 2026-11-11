// GameVault v1.3.1 - Preload Bridge
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Window
  minimize: () => ipcRenderer.send('win-minimize'),
  maximize: () => ipcRenderer.send('win-maximize'),
  close:    () => ipcRenderer.send('win-close'),
  isMaximized: () => ipcRenderer.invoke('win:is-maximized'),
  getPlatformInfo: () => ipcRenderer.invoke('app:platform-info'),
  thumb: (src, width, kind) => ipcRenderer.invoke('img:thumb', { src, width, kind }),
  onMaximizedChange: (cb) => ipcRenderer.on('win:maximized', (_, isMax) => cb(isMax)),

  // Games data
  loadGames:   () => ipcRenderer.invoke('games:load'),
  saveGames:   (g) => ipcRenderer.invoke('games:save', g),
  backupGames: () => ipcRenderer.invoke('games:backup'),
  getDataPath: () => ipcRenderer.invoke('games:data-path'),
  // Main changed a game on its own: { id, lastPlayed?, installDir?, exePath? }
  onGamesUpdated: (cb) => ipcRenderer.on('games:updated', (_, patch) => cb(patch)),
  // Quitting: save now; main waits for 'app:flushed' (max 2.5 s).
  onAppFlush: (cb) => ipcRenderer.on('app:flush', async () => { try { await cb(); } catch (_) {} finally { ipcRenderer.send('app:flushed'); } }),

  // GameVault account (Gamevault Cloud)
  accountStatus: () => ipcRenderer.invoke('account:status'),
  accountProviders: () => ipcRenderer.invoke('account:providers'),
  accountEmail: (email) => ipcRenderer.invoke('account:email', email),
  accountPassword: (email, password) => ipcRenderer.invoke('account:password', { email, password }),
  accountSignUp: (email, password) => ipcRenderer.invoke('account:signup', { email, password }),
  accountReset: (email) => ipcRenderer.invoke('account:reset', email),
  accountSetPassword: (password) => ipcRenderer.invoke('account:set-password', password),
  accountCode: (code) => ipcRenderer.invoke('account:code', code),
  accountDelete: () => ipcRenderer.invoke('account:delete', 'DELETE'),
  accountOAuth: (provider) => ipcRenderer.invoke('account:oauth', provider),
  accountCancel: () => ipcRenderer.invoke('account:cancel'),
  accountSignOut: () => ipcRenderer.invoke('account:signout'),
  cloudSync: (games) => ipcRenderer.invoke('cloud:sync', games),
  cloudLastSync: () => ipcRenderer.invoke('cloud:last-sync'),
  savesFind: (game) => ipcRenderer.invoke('saves:find', game),
  savesPick: (current) => ipcRenderer.invoke('saves:pick', current),
  savesBackup: (p) => ipcRenderer.invoke('saves:backup', p),
  savesList: (gameId) => ipcRenderer.invoke('saves:list', gameId),
  savesRestore: (p) => ipcRenderer.invoke('saves:restore', p),
  savesDelete: (id) => ipcRenderer.invoke('saves:delete', id),
  onAccountChanged: (cb) => ipcRenderer.on('account:changed', (_, st) => cb(st)),

  // Config (RAWG key etc)
  loadConfig: () => ipcRenderer.invoke('config:load'),
  saveConfig: (c) => ipcRenderer.invoke('config:save', c),

  // Auto-detect
  detectSteam:  () => ipcRenderer.invoke('detect:steam'),
  detectEpic:   () => ipcRenderer.invoke('detect:epic'),
  detectLutris: () => ipcRenderer.invoke('detect:lutris'),
  detectFolder: () => ipcRenderer.invoke('detect:folder'),
  importSources: () => ipcRenderer.invoke('import:sources'),
  importScan: (id) => ipcRenderer.invoke('import:scan', id),
  importFolder: () => ipcRenderer.invoke('import:folder'),
  importFile: () => ipcRenderer.invoke('import:file'),
  steamAccount: () => ipcRenderer.invoke('steam:account'),
  steamOwned: (payload) => ipcRenderer.invoke('steam:owned', payload),
  steamLogin: () => ipcRenderer.invoke('steam:login'),
  gpuStatus: () => ipcRenderer.invoke('app:gpu'),
  perfLog: (sample) => ipcRenderer.send('perf:log', sample),
  perfPath: () => ipcRenderer.invoke('perf:path'),
  perfReveal: () => ipcRenderer.send('perf:reveal'),

  // Exe tracking
  trackingStart: (gameId, exePath, installDir, steamAppId) => ipcRenderer.send('tracking:start', { gameId, exePath, installDir, steamAppId }),
  trackingStop:  (gameId)                                  => ipcRenderer.send('tracking:stop',  { gameId }),
  trackingActive: ()                                       => ipcRenderer.invoke('tracking:active'),
  onTrackingTick:       (cb) => ipcRenderer.on('tracking:tick',        (_, d) => cb(d)),
  onTrackingSessionEnd: (cb) => ipcRenderer.on('tracking:session-end', (_, d) => cb(d)),
  onTrackingStarted:    (cb) => ipcRenderer.on('tracking:started',     (_, d) => cb(d)),
  // { gameId, reason: 'not-seen' | 'untracked' } — launched but no session will be recorded
  onTrackingGaveUp:     (cb) => ipcRenderer.on('tracking:gave-up',     (_, d) => cb(d)),
  // Edit dialog "Detect": running programs, the game folder's exes first
  runningProcesses: (opts) => ipcRenderer.invoke('tracking:running-processes', opts || {}),

  // Pick image file for custom cover
  pickImage: () => ipcRenderer.invoke('pick:image'),

  launchGame: (exePath, steamAppId, gameId, installDir, launcherPath) => ipcRenderer.send('game:launch', { exePath, steamAppId, gameId, installDir, launcherPath }),
  killGame: (gameId, exePath, installDir, steamAppId, launcherPath) => ipcRenderer.invoke('game:kill', { gameId, exePath, installDir, steamAppId, launcherPath }),

  // Tracking detected (game launched outside app)
  onTrackingDetected: (cb) => ipcRenderer.on('tracking:detected', (_, d) => cb(d)),
  onLaunchError: (cb) => ipcRenderer.on('game:launch-error', (_, d) => cb(d)),

  // Pick exe file
  pickExe: () => ipcRenderer.invoke('pick:exe'),
  showInFolder: (path) => ipcRenderer.send('game:show-in-folder', path),

  // SteamGridDB search
  sgdbGames: (term) => ipcRenderer.invoke('sgdb:games', term),
  steamDetails: (appId) => ipcRenderer.invoke('steam:details', appId),
  sgdbResolve: (payload) => ipcRenderer.invoke('sgdb:resolve', payload),
  sgdbAssets: (payload) => ipcRenderer.invoke('sgdb:assets', payload),
  sgdbAutofill: (payload) => ipcRenderer.invoke('sgdb:autofill', payload),
  sgdbCache: (payload) => ipcRenderer.invoke('sgdb:cache', payload),
  sgdbKeyGet: () => ipcRenderer.invoke('sgdb:key:get'),
  sgdbKeySet: (key) => ipcRenderer.invoke('sgdb:key:set', key),
  sgdbKeyTest: () => ipcRenderer.invoke('sgdb:key:test'),

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
