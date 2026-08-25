const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const { execSync } = require('child_process');
const { loadConfig } = require('./data.js');
const { httpsGet } = require('./api.js');

// Steam library detection
function getSteamLibraries() {
  const libs = [];
  const roots = [
    'C:\\Program Files (x86)\\Steam',
    'C:\\Program Files\\Steam',
  ].filter(Boolean);

  for (const root of roots) {
    const vdf = path.join(root, 'steamapps', 'libraryfolders.vdf');
    if (!fs.existsSync(vdf)) continue;
    try {
      const content = fs.readFileSync(vdf, 'utf-8');
      const matches = [...content.matchAll(/"path"\s+"([^"]+)"/gi)];
      for (const m of matches) libs.push(m[1].replace(/\\\\/g, '\\'));
      if (!libs.includes(root)) libs.push(root);
    } catch (e) {}
  }
  return [...new Set(libs)];
}


function findMainExe(dirPath) {
  const SKIP = ['unins', 'setup', 'crash', 'redist', 'dxsetup', 'vcredist', 'directx', 'vc_redist', 'unarc', 'install', '_commonredist', 'easyanticheat', 'battleye', 'touchup', 'dotnet', 'physx'];

  function scanDir(dir, depth) {
    let best = '', bestSize = 0;
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      // Check exes in this dir
      for (const e of entries) {
        if (!e.isFile()) continue;
        const fl = e.name.toLowerCase();
        if (!fl.endsWith('.exe') || SKIP.some(s => fl.includes(s))) continue;
        try {
          const stat = fs.statSync(path.join(dir, e.name));
          if (stat.size > bestSize) { bestSize = stat.size; best = path.join(dir, e.name); }
        } catch (e2) {}
      }
      // Recurse into subdirs up to depth 2
      if (depth < 2) {
        for (const e of entries) {
          if (!e.isDirectory()) continue;
          const sub = scanDir(path.join(dir, e.name), depth + 1);
          if (sub.size > bestSize) { bestSize = sub.size; best = sub.path; }
        }
      }
    } catch (e) {}
    return { path: best, size: bestSize };
  }

  const result = scanDir(dirPath, 0);
  return result.size > 1024 * 1024 ? result.path : '';
}

function detectSteamGames() {
  const games = [];
  const libs = getSteamLibraries();
  for (const lib of libs) {
    const appsDir = path.join(lib, 'steamapps');
    if (!fs.existsSync(appsDir)) continue;
    try {
      const files = fs.readdirSync(appsDir).filter(f => f.startsWith('appmanifest_') && f.endsWith('.acf'));
      for (const file of files) {
        try {
          const content = fs.readFileSync(path.join(appsDir, file), 'utf-8');
          const nameMatch = content.match(/"name"\s+"([^"]+)"/i);
          const appIdMatch = content.match(/"appid"\s+"(\d+)"/i);
          const installDirMatch = content.match(/"installdir"\s+"([^"]+)"/i);
          if (nameMatch && appIdMatch) {
            const appId = appIdMatch[1];
            const installDir = installDirMatch ? path.join(appsDir, 'common', installDirMatch[1]) : '';
            const exePath = installDir ? findMainExe(installDir) : '';
            games.push({
              name: nameMatch[1],
              source: 'Steam',
              exePath,
              installDir,
              steamAppId: appId,
              coverUrl: `https://cdn.cloudflare.steamstatic.com/steam/apps/${appId}/library_600x900.jpg`,
              status: 'Playing',
              hours: 0,
              notes: '',
              added: Date.now(),
              id: crypto.randomUUID(),
            });
          }
        } catch (e) {}
      }
    } catch (e) {}
  }
  return games;
}

// Epic Games detection
function detectEpicGames() {
  const games = [];
  const dir = 'C:\\ProgramData\\Epic\\EpicGamesLauncher\\Data\\Manifests';
  if (!fs.existsSync(dir)) return games;
  try {
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.item'));
    for (const file of files) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf-8'));
        if (data.DisplayName && data.InstallLocation) {
          games.push({
            name: data.DisplayName,
            source: 'Epic Games',
            exePath: data.LaunchExecutable ? path.join(data.InstallLocation, data.LaunchExecutable) : '',
            installDir: data.InstallLocation,
            status: 'Playing',
            hours: 0,
            notes: '',
            added: Date.now(),
            id: crypto.randomUUID(),
          });
        }
      } catch (e) {}
    }
  } catch (e) {}
  return games;
}

// Custom folder scan
function scanFolder(folderPath) {
  const games = [];
  const SKIP = ['unins', 'setup', 'crash', 'redist', 'dxsetup', 'vcredist', 'directx', 'vc_redist', 'unarc'];
  try {
    const entries = fs.readdirSync(folderPath, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const subDir = path.join(folderPath, entry.name);
      try {
        const files = fs.readdirSync(subDir);
        const exes = files.filter(f => {
          const fl = f.toLowerCase();
          return fl.endsWith('.exe') && !SKIP.some(s => fl.includes(s));
        });
        if (exes.length === 0) continue;
        let bestExe = exes[0];
        let bestSize = 0;
        for (const exe of exes) {
          try {
            const stat = fs.statSync(path.join(subDir, exe));
            if (stat.size > bestSize) { bestSize = stat.size; bestExe = exe; }
          } catch (e) {}
        }
        games.push({
          name: entry.name.replace(/[_\-.]/g, ' ').replace(/\s+/g, ' ').trim(),
          source: 'Custom',
          exePath: path.join(subDir, bestExe),
          installDir: subDir,
          status: 'Playing',
          hours: 0,
          notes: '',
          added: Date.now(),
          id: crypto.randomUUID(),
        });
      } catch (e) {}
    }
  } catch (e) {}
  return games;
}


// Drive filesystem scan
function getAllDrives() {
  const drives = [];
  try {
    const result = execSync('wmic logicaldisk get caption', { encoding: 'utf-8', timeout: 5000 });
    const lines = result.split('\n').map(l => l.trim()).filter(l => /^[A-Z]:$/.test(l));
    drives.push(...lines);
  } catch (e) {
    drives.push('C:', 'D:', 'E:');
  }
  return drives;
}

const GAME_FOLDER_HINTS = ['games', 'game', 'steam', 'steamapps', 'common', 'epic games', 'ubisoft', 'origin games', 'gog games', 'program files'];
const SKIP_EXE = ['unins', 'setup', 'crash', 'redist', 'dxsetup', 'vcredist', 'directx', 'vc_redist', 'unarc', 'install', 'uninstall', '_commonredist'];

function scanDirForGames(dirPath, depth = 0) {
  const games = [];
  if (depth > 3) return games;
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const subDir = path.join(dirPath, entry.name);
      try {
        const files = fs.readdirSync(subDir);
        const exes = files.filter(f => {
          const fl = f.toLowerCase();
          return fl.endsWith('.exe') && !SKIP_EXE.some(s => fl.includes(s));
        });
        if (exes.length > 0) {
          let bestExe = exes[0], bestSize = 0;
          for (const exe of exes) {
            try {
              const stat = fs.statSync(path.join(subDir, exe));
              if (stat.size > bestSize) { bestSize = stat.size; bestExe = exe; }
            } catch (e) {}
          }
          if (bestSize > 1024 * 1024) { // at least 1MB
            games.push({
              name: entry.name.replace(/[_\-.]/g, ' ').replace(/\s+/g, ' ').trim(),
              source: 'Custom',
              exePath: path.join(subDir, bestExe),
              installDir: subDir,
              status: 'Playing',
              hours: 0,
              notes: '',
              added: Date.now(),
              id: Date.now() + Math.floor(Math.random() * 100000),
            });
          }
        } else {
          // recurse into subfolders that look game-related
          const nameLower = entry.name.toLowerCase();
          if (depth < 2 || GAME_FOLDER_HINTS.some(h => nameLower.includes(h))) {
            games.push(...scanDirForGames(subDir, depth + 1));
          }
        }
      } catch (e) {}
    }
  } catch (e) {}
  return games;
}

async function scanAllDisks() {
  const drives = getAllDrives();
  const allGames = [];
  const seen = new Set();
  for (const drive of drives) {
    try {
      const entries = fs.readdirSync(drive + '\\', { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const nameLower = entry.name.toLowerCase();
        if (['windows', 'system32', '$recycle.bin', 'recovery', 'programdata', 'msocache', 'perflogs', 'config.msi', '$windows.~bt'].includes(nameLower)) continue;
        const fullPath = path.join(drive + '\\', entry.name);
        const found = scanDirForGames(fullPath, 0);
        for (const g of found) {
          if (!seen.has(g.exePath)) { seen.add(g.exePath); allGames.push(g); }
        }
      }
    } catch (e) {}
  }
  return allGames;
}

// Smart filesystem scan heuristics
async function smartScan() {
  const cfg = loadConfig();

  // Phase 1: Raw scan all drives
  win && win.webContents.send('detect:progress', 'Scanning all drives...');
  const rawCandidates = await scanAllDisks();
  if (!rawCandidates.length) return [];

  // Phase 2: Pre-filter with blacklist to remove 90% of non-game trash
  win && win.webContents.send('detect:progress', 'Filtering generic apps...');
  let filtered = basicFilterCandidates(rawCandidates);
  if (!filtered.length) return [];

  // Phase 3: AI Analysis + Name cleaning
  if (cfg.aiEnabled && cfg.aiKey) {
    win && win.webContents.send('detect:progress', `AI analyzing ${filtered.length} potential games...`);
    filtered = await aiFilterCandidates(filtered, cfg);
  }
  if (!filtered.length) return [];

  // Phase 3: Auto-fetch covers from SteamGridDB
  if (cfg.sgdbKey) {
    win && win.webContents.send('detect:progress', `Fetching covers for ${filtered.length} games...`);
    await autoFetchCovers(filtered, cfg.sgdbKey);
  }

  win && win.webContents.send('detect:progress', '');
  return filtered;
}

// Blacklist for obvious non-game apps (fallback when no AI key)
const APP_BLACKLIST = [
  'chrome', 'firefox', 'edge', 'opera', 'brave', 'vivaldi', 'tor browser',
  'discord', 'slack', 'telegram', 'whatsapp', 'zoom', 'teams', 'skype',
  'spotify', 'itunes', 'vlc', 'foobar', 'audacity', 'obs',
  'steam', 'epicgameslauncher', 'goggalaxy', 'ubisoft connect', 'origin', 'battle.net',
  'vscode', 'visual studio', 'sublime', 'notepad++', 'atom', 'cursor', 'jetbrains',
  'gimp', 'blender', 'photoshop', 'illustrator', 'premiere', 'after effects',
  'winrar', '7-zip', '7zip', 'peazip', 'bandizip',
  'nvidia', 'geforce', 'amd', 'radeon', 'intel', 'realtek', 'corsair', 'razer', 'logitech', 'steelseries',
  'python', 'node', 'java', 'php', 'ruby', 'golang', 'rust', 'dotnet', 'mingw',
  'git', 'github', 'docker', 'virtualbox', 'vmware', 'wsl',
  'adobe', 'acrobat', 'reader',
  'office', 'word', 'excel', 'powerpoint', 'outlook', 'onenote', 'onedrive',
  'avast', 'avg', 'mcafee', 'norton', 'kaspersky', 'malwarebytes', 'bitdefender',
  'ccleaner', 'iobit', 'wise', 'glary', 'revo',
  'dropbox', 'googledrive', 'mega', 'icloud',
  'anydesk', 'teamviewer', 'parsec',
  'powershell', 'terminal', 'cmd', 'windowsapps', 'windowspowershell',
  'printer', 'scanner', 'hp', 'epson', 'canon', 'brother',
  'common files', 'internet explorer', 'microsoft', 'msedge', 'msbuild',
  'dell', 'lenovo', 'asus', 'acer', 'msi afterburner',
  'qbittorrent', 'utorrent', 'bittorrent', 'idm', 'internet download',
  'wireshark', 'putty', 'filezilla', 'postman', 'insomnia',
  'libreoffice', 'openoffice', 'wps office',
  'directx', 'redistributable', 'runtime', 'framework', 'sdk',
];

function basicFilterCandidates(candidates) {
  return candidates.filter(c => {
    const name = c.name.toLowerCase();
    const exeName = path.basename(c.exePath || '').toLowerCase();
    // Skip if folder name matches blacklist
    if (APP_BLACKLIST.some(b => name.includes(b))) return false;
    if (APP_BLACKLIST.some(b => exeName.includes(b))) return false;
    // Skip very generic folder names
    if (['bin', 'app', 'data', 'src', 'lib', 'temp', 'tmp', 'tools', 'util', 'config'].includes(name)) return false;
    return true;
  });
}

async function aiFilterCandidates(candidates, cfg) {
  // Build compact descriptions for AI (batch up to 50 at a time)
  const BATCH_SIZE = 50;
  const allResults = [];

  for (let batchStart = 0; batchStart < candidates.length; batchStart += BATCH_SIZE) {
    const batch = candidates.slice(batchStart, batchStart + BATCH_SIZE);
    const lines = batch.map((c, i) => {
      const folderName = path.basename(c.installDir || '');
      const exeName = path.basename(c.exePath || '');
      // Build parent folder chain for path context (helps identify games in nested dirs)
      const exeDir = path.dirname(c.exePath || '');
      const pathParts = exeDir.split(path.sep).slice(-4).join(' > '); // last 4 folders
      // Also check for game-engine DLLs in the folder
      let hints = '';
      try {
        const files = fs.readdirSync(c.installDir || '').map(f => f.toLowerCase());
        if (files.includes('steam_api.dll') || files.includes('steam_api64.dll')) hints += ' [has steam_api]';
        if (files.includes('unityplayer.dll')) hints += ' [Unity engine]';
        if (files.some(f => f.includes('unreal') || f.includes('ue4'))) hints += ' [Unreal engine]';
      } catch (e) {}
      return `${i}: folder="${folderName}" exe="${exeName}" path="${pathParts}"${hints}`;
    });

    const prompt = `Below are ${batch.length} executable files found on a Windows PC. For each, decide if it is the MAIN executable for a PC VIDEO GAME.

STRICT RULES:
1. If it's a generic launcher (e.g. "launcher.exe", "EasyAntiCheat"), a game utility, a redistributable, or an updater -> mark game: false.
2. Do NOT guess or hallucinate a game name. If an exe is related to "War Thunder", the game is "War Thunder". Do NOT hallucinate names like "Ace Combat".
3. If it IS a game, provide the correct OFFICIAL game name (e.g. "Grand Theft Auto V" not "GTA5_v1.2-CODEX").
4. If you are not 100% sure it's a game, mark it as game: false.

RESPOND WITH ONLY A JSON ARRAY. Each element: {"i": <index>, "game": true/false, "name": "Official Game Name"}
Include ALL entries. For non-games, set name to "".

Entries:
${lines.join('\n')}`;

    const messages = [
        { role: 'system', content: 'You are a PC game identification expert. You know thousands of games and can identify them from folder names, exe names, and engine hints. Reply with ONLY a valid JSON array, no markdown, no code fences.' },
        { role: 'user', content: prompt },
    ];

    let url = '';
    let headers = { 'Content-Type': 'application/json' };
    let bodyData = null;
    const openaiFormat = { model: cfg.aiCustomModel || 'gpt-4o-mini', messages, temperature: 0.1, max_tokens: 2000 };

    if (cfg.aiProvider === 'openai') {
        url = 'https://api.openai.com/v1/chat/completions';
        headers['Authorization'] = `Bearer ${cfg.aiKey}`;
        bodyData = openaiFormat;
    } else if (cfg.aiProvider === 'anthropic') {
        url = 'https://api.anthropic.com/v1/messages';
        headers['x-api-key'] = cfg.aiKey;
        headers['anthropic-version'] = '2023-06-01';
        bodyData = { model: 'claude-3-haiku-20240307', system: messages[0].content, messages: [messages[1]], max_tokens: 2000, temperature: 0.1 };
    } else if (cfg.aiProvider === 'deepseek') {
        url = 'https://api.deepseek.com/chat/completions';
        headers['Authorization'] = `Bearer ${cfg.aiKey}`;
        openaiFormat.model = 'deepseek-chat';
        bodyData = openaiFormat;
    } else if (cfg.aiProvider === 'google') {
        url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${cfg.aiKey}`;
        bodyData = { systemInstruction: { parts: [{text: messages[0].content}] }, contents: [{ role: 'user', parts: [{text: prompt}] }], generationConfig: { temperature: 0.1, maxOutputTokens: 2000 } };
    } else if (cfg.aiProvider === 'custom') {
        url = (cfg.aiCustomEndpoint || '').replace(/\/+$/, '');
        if (!url.endsWith('/chat/completions')) url += '/chat/completions';
        if (cfg.aiKey) headers['Authorization'] = `Bearer ${cfg.aiKey}`;
        bodyData = openaiFormat;
    }

    let parsedUrl;
    try { parsedUrl = new URL(url); } catch(e) { continue; }

    const body = JSON.stringify(bodyData);
    const reqPath = parsedUrl.pathname + parsedUrl.search;

    try {
      const responseText = await new Promise((resolve, reject) => {
        const req = https.request({
          hostname: parsedUrl.hostname,
          path: reqPath,
          method: 'POST',
          headers,
          timeout: 45000
        }, res => {
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => {
            try {
              const dataObj = JSON.parse(data);
              if (dataObj.error) reject(new Error(dataObj.error.message));
              
              let contentStr = '';
              if (cfg.aiProvider === 'google') {
                contentStr = dataObj.candidates?.[0]?.content?.parts?.[0]?.text || '';
              } else if (cfg.aiProvider === 'anthropic') {
                contentStr = dataObj.content?.[0]?.text || '';
              } else {
                contentStr = dataObj.choices?.[0]?.message?.content || '';
              }
              
              const match = contentStr.match(/\[.*\]/s);
              resolve(match ? match[0] : contentStr);
            } catch (e) { reject(new Error('Failed to parse AI response')); }
          });
        });
        req.on('error', reject);
        req.write(body);
        req.end();
      });

      const aiResults = JSON.parse(responseText);

      for (const result of aiResults) {
        if (result.game && result.name) {
          const original = batch[result.i];
          if (original) {
            allResults.push({
              ...original,
              name: result.name,
              source: 'Smart Scan',
            });
          }
        }
      }
    } catch (e) {
      console.error('AI filter batch error:', e.message);
      allResults.push(...basicFilterCandidates(batch));
    }
  }

  return allResults;
}

async function autoFetchCovers(games, sgdbKey) {
  const headers = { Authorization: `Bearer ${sgdbKey}` };
  // Process in small parallel batches to avoid rate limiting
  const CONCURRENT = 5;
  for (let i = 0; i < games.length; i += CONCURRENT) {
    const batch = games.slice(i, i + CONCURRENT);
    await Promise.all(batch.map(async game => {
      if (game.coverUrl) return; // already has cover (e.g. Steam games)
      try {
        const searchData = await httpsGet(
          `https://www.steamgriddb.com/api/v2/search/autocomplete/${encodeURIComponent(game.name)}`,
          headers
        );
        if (!searchData.success || !searchData.data?.length) return;
        const gridData = await httpsGet(
          `https://www.steamgriddb.com/api/v2/grids/game/${searchData.data[0].id}?dimensions=600x900&limit=1`,
          headers
        );
        if (gridData.success && gridData.data?.length) {
          game.coverUrl = gridData.data[0].url;
        }
      } catch (e) {}
    }));
  }
}



module.exports = { detectSteamGames, detectEpicGames, scanFolder, smartScan };
