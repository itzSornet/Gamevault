const { app, BrowserWindow, ipcMain, dialog, shell, Tray, Menu, globalShortcut, desktopCapturer, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const { execSync, exec } = require('child_process');
const https = require('https');
const crypto = require('crypto');

const { DATA_PATH, CONFIG_PATH, AI_PROFILE_PATH, loadGames, saveGames, cacheImage, cacheGameImages, loadConfig, saveConfig, aiLoadProfile, aiSaveProfile } = require('./src/backend/data.js');
const { detectSteamGames, detectEpicGames, scanFolder, smartScan } = require('./src/backend/scanner.js');
const { setTrackerWindow, startTracking, stopTracking, stopAllTracking, detectPCSpecs, trackedProcesses, collectGameExes } = require('./src/backend/tracker.js');
const { searchSteamGridDB, httpsGet } = require('./src/backend/api.js');
const { initUpdater } = require('./src/backend/updater.js');

let tray = null;
let forceQuit = false;
let bgPollInterval = null;

function buildTrayMenu() {
  const games = loadGames();
  const recent = games
    .filter(g => g.exePath && g.lastPlayed)
    .sort((a, b) => (b.lastPlayed || 0) - (a.lastPlayed || 0))
    .slice(0, 3);

  const recentItems = recent.length
    ? recent.map(g => ({
      label: g.name.length > 28 ? g.name.slice(0, 28) + '…' : g.name,
      click: () => exec(`"${g.exePath}"`, () => { }),
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
  const iconPath = path.join(__dirname, 'src', 'icon.ico');
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
      const result = await new Promise(resolve => {
        exec('tasklist /NH /FO CSV', { encoding: 'utf-8', timeout: 5000 }, (err, stdout) => {
          resolve(err ? '' : stdout.toLowerCase());
        });
      });
      if (!result) return;
      const games = loadGames();
      games.filter(g => g.exePath && g.status === 'Playing').forEach(g => {
        const gameId = String(g.id);
        if (trackedProcesses[gameId]) return; // already tracked
        // Check primary exe OR any exe in the game's install dir
        const installDir = path.dirname(g.exePath);
        const gameExes = collectGameExes(installDir);
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

  overlayWin.setIgnoreMouseEvents(false);
  overlayWin.loadFile(path.join(__dirname, 'src', 'overlay.html'));

  // Guard: don't hide immediately after showing (blur fires on show sometimes)
  let showTime = 0;
  overlayWin.on('blur', () => {
    if (overlayWin && overlayWin.isVisible() && (Date.now() - showTime > 500)) {
      overlayWin.hide();
    }
  });

  overlayWin.showOverlay = () => {
    if (!overlayWin.hasBeenPositioned) {
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
    overlayWin.webContents.send('overlay:opened');
  };
}

function toggleOverlay() {
  if (!overlayWin) { console.log('[Overlay] No overlayWin'); return; }
  if (overlayWin.isVisible()) {
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
    width: 1200,
    height: 760,
    minWidth: 900,
    minHeight: 580,
    frame: false,
    backgroundColor: '#0f1014',
    icon: path.join(__dirname, 'src', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  setTrackerWindow(win);
  initUpdater(win);

  win.loadFile(path.join(__dirname, 'src', 'index.html'));

  // Close to tray instead of quitting
  win.on('close', (e) => {
    if (!forceQuit) {
      e.preventDefault();
      win.hide();
      refreshTray();
    }
  });

  ipcMain.on('win-minimize', () => win.minimize());
  ipcMain.on('win-maximize', () => win.isMaximized() ? win.unmaximize() : win.maximize());
  ipcMain.on('win-close', () => win.hide());
  ipcMain.on('overlay:update-hotkey', (_, hotkey) => registerOverlayShortcut(hotkey));
  ipcMain.on('overlay:hide', () => { if (overlayWin) overlayWin.hide(); });
  ipcMain.on('overlay:toggle', () => toggleOverlay());

  ipcMain.handle('capture:get-screen', async () => {
    const sources = await desktopCapturer.getSources({ types: ['screen'] });
    return sources[0] ? sources[0].id : null;
  });

  ipcMain.handle('capture:save-media', (_, { type, buffer, filename }) => {
    try {
      const mediaDir = path.join(path.dirname(DATA_PATH), 'data_media');
      if (!fs.existsSync(mediaDir)) fs.mkdirSync(mediaDir);
      const filePath = path.join(mediaDir, filename);
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
      const mediaDir = path.join(path.dirname(DATA_PATH), 'data_media');
      if (!filePath.startsWith(mediaDir)) return false;
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        return true;
      }
    } catch (e) {
      console.warn('Failed to delete media', e);
    }
    return false;
  });

  ipcMain.on('capture:show-folder', (_, filePath) => {
    const mediaDir = path.join(path.dirname(DATA_PATH), 'data_media');
    if (!filePath.startsWith(mediaDir)) return;
    shell.showItemInFolder(filePath);
  });

  ipcMain.handle('games:load', () => loadGames());
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
  ipcMain.handle('detect:folder', async () => {
    const result = await dialog.showOpenDialog(win, {
      properties: ['openDirectory'],
      title: 'Select games folder to scan',
    });
    if (result.canceled || !result.filePaths[0]) return [];
    return scanFolder(result.filePaths[0]);
  });

  ipcMain.on('tracking:start', (_, { gameId, exePath }) => startTracking(String(gameId), exePath));
  ipcMain.on('tracking:stop', (_, { gameId }) => stopTracking(String(gameId)));
  ipcMain.handle('tracking:active', () => Object.keys(trackedProcesses));

  ipcMain.handle('pick:exe', async () => {
    const result = await dialog.showOpenDialog(win, {
      properties: ['openFile'],
      filters: [{ name: 'Executables', extensions: ['exe'] }],
      title: 'Select game .exe',
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

  ipcMain.on('game:launch', (_, { exePath, steamAppId, gameId }) => {
    if (steamAppId) {
      shell.openExternal(`steam://rungameid/${steamAppId}`);
    } else if (exePath) {
      if (!fs.existsSync(exePath)) {
        win && win.webContents.send('game:launch-error', { gameId, error: `Game executable not found:\n${exePath}\n\nThe file may have been moved, deleted, or the drive is disconnected.` });
        return;
      }
      try {
        const { spawn } = require('child_process');
        const gameDir = path.dirname(exePath);
        const child = spawn(exePath, [], { cwd: gameDir, detached: true, stdio: 'ignore' });
        child.on('error', (err) => {
          win && win.webContents.send('game:launch-error', { gameId, error: `Failed to launch game:\n${err.message}` });
        });
        child.unref();
      } catch (err) {
        win && win.webContents.send('game:launch-error', { gameId, error: `Failed to launch game:\n${err.message}` });
        return;
      }
    }
    // Update lastPlayed
    const games = loadGames();
    const g = games.find(x => String(x.id) === String(gameId));
    if (g) { g.lastPlayed = Date.now(); saveGames(games); refreshTray(); }
  });

  // Kill a running game
  ipcMain.handle('game:kill', async (_, { gameId, exePath, installDir }) => {
    const dir = installDir || path.dirname(exePath || '');
    const gameExes = collectGameExes(dir);
    // Kill each game exe that's running
    for (const exeName of gameExes) {
      try {
        await new Promise(resolve => {
          exec(`taskkill /IM "${exeName}" /F`, { timeout: 5000 }, () => resolve());
        });
      } catch (e) { }
    }
    // Stop tracking
    stopTracking(String(gameId));
    return true;
  });

  ipcMain.handle('detect:disk', () => scanAllDisks());
  ipcMain.handle('detect:smart', () => smartScan(win));

  ipcMain.handle('sgdb:search', async (_, query) => {
    const cfg = loadConfig();
    if (!cfg.sgdbKey) return null;
    try { return await searchSteamGridDB(query, cfg.sgdbKey); }
    catch (e) { console.error('SGDB error:', e.message); return []; }
  });

  // Fetch hero (wide banner) image from SteamGridDB
  ipcMain.handle('sgdb:hero', async (_, gameName) => {
    const cfg = loadConfig();
    if (!cfg.sgdbKey) return null;
    const headers = { Authorization: `Bearer ${cfg.sgdbKey}` };
    try {
      const searchData = await httpsGet(
        `https://www.steamgriddb.com/api/v2/search/autocomplete/${encodeURIComponent(gameName)}`,
        headers
      );
      if (!searchData.success || !searchData.data?.length) return null;
      const heroData = await httpsGet(
        `https://www.steamgriddb.com/api/v2/heroes/game/${searchData.data[0].id}?limit=1`,
        headers
      );
      if (heroData.success && heroData.data?.length) {
        return heroData.data[0].url;
      }
      return null;
    } catch (e) { return null; }
  });

  ipcMain.handle('startup:get', () => {
    // Check both OS setting and our config (config is more reliable in dev mode)
    const cfg = loadConfig();
    const osState = app.getLoginItemSettings().openAtLogin;
    return osState || cfg.startupEnabled || false;
  });
  ipcMain.handle('startup:set', (_, enable) => {
    app.setLoginItemSettings({ openAtLogin: enable, name: 'GameVault' });
    // Also persist in config for reliable state tracking
    const cfg = loadConfig();
    cfg.startupEnabled = enable;
    saveConfig(cfg);
    return true;
  });

  ipcMain.handle('games:scan-running', async (_, gamesList) => {
    try {
      const result = await new Promise((resolve) => {
        exec('tasklist /NH /FO CSV', { encoding: 'utf-8', timeout: 5000 }, (error, stdout) => resolve(stdout || ''));
      });
      const running = result.toLowerCase();
      return gamesList
        .filter(g => g.exePath && g.status === 'Playing')
        .filter(g => running.includes(path.basename(g.exePath).toLowerCase()))
        .map(g => g.id);
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

app.whenReady().then(() => {
  createWindow();
  createOverlayWindow();
  createTray();
  const cfg = loadConfig();
  registerOverlayShortcut(cfg.overlayHotkey);

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
