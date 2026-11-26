// GameVault v1.3.1 - Preload Bridge
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Window
  minimize: () => ipcRenderer.send('win-minimize'),
  maximize: () => ipcRenderer.send('win-maximize'),
  close:    () => ipcRenderer.send('win-close'),
  isMaximized: () => ipcRenderer.invoke('win:is-maximized'),
  getPlatformInfo: () => ipcRenderer.invoke('app:platform-info'),
  locale: (() => { try { return ipcRenderer.sendSync('app:locale') || ''; } catch (_) { return ''; } })(),
  thumb: (src, width, kind) => ipcRenderer.invoke('img:thumb', { src, width, kind }),
  palette: (src) => ipcRenderer.invoke('img:palette', src),
  onMaximizedChange: (cb) => ipcRenderer.on('win:maximized', (_, isMax) => cb(isMax)),
  // Big Picture: fullscreen + page zoom (main), and requests to enter it
  // from a second launch with --bigpicture
  setBigPicture: (on) => ipcRenderer.invoke('win:bigpicture', !!on),
  bringToFront: () => ipcRenderer.send('win:bring-front'),
  onBigPicture: (cb) => ipcRenderer.on('app:bigpicture', (_, on) => cb(on)),

  // Games data
  loadGames:   () => ipcRenderer.invoke('games:load'),
  loadIssue:   () => ipcRenderer.invoke('games:load-issue'),
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
  cloudSync: (games, look) => ipcRenderer.invoke('cloud:sync', games, look),
  cloudLastSync: () => ipcRenderer.invoke('cloud:last-sync'),
  savesFind: (game) => ipcRenderer.invoke('saves:find', game),
  savesPick: (current) => ipcRenderer.invoke('saves:pick', current),
  savesBackup: (p) => ipcRenderer.invoke('saves:backup', p),
  savesList: (gameId) => ipcRenderer.invoke('saves:list', gameId),
  savesRestore: (p) => ipcRenderer.invoke('saves:restore', p),
  savesDelete: (id) => ipcRenderer.invoke('saves:delete', id),
  savesOverview: () => ipcRenderer.invoke('saves:overview'),
  savesHasPrevious: (gameId) => ipcRenderer.invoke('saves:has-previous', gameId),
  savesOpenPrevious: (gameId) => ipcRenderer.invoke('saves:open-previous', gameId),
  localSavesBackup: (p) => ipcRenderer.invoke('lsaves:backup', p),
  localSavesList: (gameId) => ipcRenderer.invoke('lsaves:list', gameId),
  localSavesRestore: (p) => ipcRenderer.invoke('lsaves:restore', p),
  localSavesDelete: (id) => ipcRenderer.invoke('lsaves:delete', id),
  localSavesOverview: () => ipcRenderer.invoke('lsaves:overview'),
  localSavesHasPrevious: (gameId) => ipcRenderer.invoke('lsaves:has-previous', gameId),
  localSavesOpenPrevious: (gameId) => ipcRenderer.invoke('lsaves:open-previous', gameId),
  localSavesOpenFolder: () => ipcRenderer.invoke('lsaves:open-folder'),
  configReset: (keys) => ipcRenderer.invoke('config:reset', keys),
  artCacheInfo: () => ipcRenderer.invoke('art:cache-info'),
  artCacheClean: () => ipcRenderer.invoke('art:cache-clean'),
  libraryBackupInfo: () => ipcRenderer.invoke('library:backup-info'),
  libraryExport: () => ipcRenderer.invoke('library:export'),
  libraryReadCopy: () => ipcRenderer.invoke('library:read-copy'),
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
  gpuStatus: () => ipcRenderer.invoke('app:gpu'),
  windowSnapshot: () => ipcRenderer.invoke('win:snapshot'),
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
  uiClipboardWrite: (text) => ipcRenderer.invoke('ui:clipboard-write', text),
  uiClipboardText: () => ipcRenderer.invoke('ui:clipboard-text'),
  uiZoom: (k) => ipcRenderer.invoke('ui:zoom', k),
  uiBackgroundPick: (kind) => ipcRenderer.invoke('ui:bg-pick', kind),
  uiBackgroundClear: () => ipcRenderer.invoke('ui:bg-clear'),

  launchGame: (exePath, steamAppId, gameId, installDir, launcherPath) => ipcRenderer.send('game:launch', { exePath, steamAppId, gameId, installDir, launcherPath }),
  killGame: (gameId, exePath, installDir, steamAppId, launcherPath) => ipcRenderer.invoke('game:kill', { gameId, exePath, installDir, steamAppId, launcherPath }),

  // Tracking detected (game launched outside app)
  onTrackingDetected: (cb) => ipcRenderer.on('tracking:detected', (_, d) => cb(d)),
  onLaunchError: (cb) => ipcRenderer.on('game:launch-error', (_, d) => cb(d)),

  // Pick exe file
  pickExe: (startAt, kind) => ipcRenderer.invoke('pick:exe', typeof startAt === 'string' ? startAt : '', kind === 'target' ? 'target' : 'exe'),
  showInFolder: (path) => ipcRenderer.send('game:show-in-folder', path),

  // SteamGridDB search
  sgdbGames: (term) => ipcRenderer.invoke('sgdb:games', term),
  steamDetails: (appId) => ipcRenderer.invoke('steam:details', appId),
  prices: (steamAppIds, fresh, itadIds) => ipcRenderer.invoke('prices:get', { steamAppIds, fresh, itadIds }),
  priceMatch: (titles) => ipcRenderer.invoke('prices:match', titles),
  peakLine: (games) => ipcRenderer.invoke('peak:line', games),
  steamSearch: (term) => ipcRenderer.invoke('steam:search', term),
  sgdbResolve: (payload) => ipcRenderer.invoke('sgdb:resolve', payload),
  sgdbAssets: (payload) => ipcRenderer.invoke('sgdb:assets', payload),
  sgdbAutofill: (payload) => ipcRenderer.invoke('sgdb:autofill', payload),
  logError: (entry) => ipcRenderer.send('log:renderer-error', entry),
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
  updateCaptureHotkeys: () => ipcRenderer.invoke('capture:update-hotkeys'),

  // Media Capture
  takeScreenshot: () => ipcRenderer.send('capture:screenshot'),
  toggleRecording: () => ipcRenderer.send('capture:toggle-record'),
  isRecording: () => ipcRenderer.invoke('capture:is-recording'),
  onCaptureChanged: (cb) => ipcRenderer.on('capture:changed', () => cb()),
  onRecordingChanged: (cb) => ipcRenderer.on('capture:recording', (_, on) => cb(!!on)),
  openCapturesFolder: () => ipcRenderer.send('capture:open-folder'),
  openMedia: (path) => ipcRenderer.send('capture:open', path),
  getRecentMedia: (limit) => ipcRenderer.invoke('capture:get-recent', limit),
  getAllMedia: () => ipcRenderer.invoke('capture:get-all'),
  deleteMedia: (path) => ipcRenderer.invoke('capture:delete-media', path),
  showMediaInFolder: (path) => ipcRenderer.send('capture:show-folder', path),
  hideMedia: (path) => ipcRenderer.invoke('capture:hide-media', path),

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
