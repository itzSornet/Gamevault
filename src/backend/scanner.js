const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { loadConfig } = require('./data.js');
const { httpsGet } = require('./api.js');
const platform = require('./platform.js');

// True when this directory entry is a game executable for the current OS.
// Windows: .exe only (unchanged). Linux: .exe (Wine/Proton) or native ELF/sh.
function isGameExecutableEntry(entry, dir) {
  if (process.platform === 'win32') return entry.name.toLowerCase().endsWith('.exe');
  return platform.isLaunchableFile(path.join(dir, entry.name));
}

function isGameExecutableName(dir, name) {
  const full = path.join(dir, name);
  if (process.platform === 'win32') return name.toLowerCase().endsWith('.exe');
  return platform.isLaunchableFile(full);
}

// Top-level directories never worth descending into during a disk scan.
const LINUX_SKIP_TOP = new Set([
  'proc', 'sys', 'dev', 'run', 'tmp', 'boot', 'efi', 'var', 'usr', 'etc',
  'snap', 'lost+found', '.snapshots', 'nix', 'System', 'Windows',
  '$RECYCLE.BIN', 'System Volume Information',
]);

// Steam library detection
//
// Memoized: a library of 200 owned-only Steam games used to run one sync
// `reg query` plus a libraryfolders.vdf read per game at boot (7.6 s freeze).
// The Steam root candidates are computed once per process, the library list
// is re-read at most every LIBRARY_TTL_MS, and appid -> installDir answers
// (negative ones included) are kept for the session.
const LIBRARY_TTL_MS = 60 * 1000;
let steamRootCache = null;
let steamLibraryCache = { at: 0, libs: null };
const steamInstallDirCache = new Map();

function steamRootCandidates() {
  if (steamRootCache) return steamRootCache;
  const home = process.env.HOME || require('os').homedir() || '';
  const roots = process.platform === 'win32' ? [
    'C:\\Program Files (x86)\\Steam',
    'C:\\Program Files\\Steam',
    'D:\\Steam',
    'E:\\Steam',
  ] : [
    path.join(home, '.local', 'share', 'Steam'),
    path.join(home, '.steam', 'steam'),
    path.join(home, '.steam', 'root'),
    path.join(home, '.var', 'app', 'com.valvesoftware.Steam', 'data', 'Steam'),
    path.join(home, '.var', 'app', 'com.valvesoftware.Steam', '.local', 'share', 'Steam'),
    path.join(home, '.var', 'app', 'com.valvesoftware.Steam', '.steam', 'steam'),
    // Snap (Ubuntu): the home inside the snap, current revision and "common"
    path.join(home, 'snap', 'steam', 'common', '.local', 'share', 'Steam'),
    path.join(home, 'snap', 'steam', 'common', '.steam', 'steam'),
    path.join(home, 'snap', 'steam', 'current', '.local', 'share', 'Steam'),
    // Debian's old layout
    path.join(home, '.steam', 'debian-installation'),
  ];

  if (process.platform === 'win32') {
    const reg = platform.runHelperSync('reg.exe', ['query', 'HKCU\\Software\\Valve\\Steam', '/v', 'SteamPath'], { timeout: 2000 });
    const match = reg.match(/SteamPath\s+REG_SZ\s+(.+)/i);
    if (match && match[1]) {
      const regPath = path.normalize(match[1].trim());
      const known = roots.some((r) => r.toLowerCase() === regPath.toLowerCase());
      if (!known && fs.existsSync(regPath)) roots.unshift(regPath);
    }
  }
  steamRootCache = roots;
  return roots;
}

// Existing Steam roots (folders that hold steamapps/).
function getSteamRoots() {
  return steamRootCandidates().filter((root) => {
    try { return fs.existsSync(path.join(root, 'steamapps')); } catch (_) { return false; }
  });
}

function getSteamLibraries() {
  const now = Date.now();
  if (steamLibraryCache.libs && now - steamLibraryCache.at < LIBRARY_TTL_MS) return steamLibraryCache.libs.slice();
  const libs = [];
  for (const root of steamRootCandidates()) {
    if (!fs.existsSync(root)) continue;
    const vdf = path.join(root, 'steamapps', 'libraryfolders.vdf');
    if (!fs.existsSync(vdf)) continue;
    try {
      const content = fs.readFileSync(vdf, 'utf-8');
      const matches = [...content.matchAll(/"path"\s+"([^"]+)"/gi)];
      for (const m of matches) libs.push(m[1].replace(/\\\\/g, '\\'));
      if (!libs.includes(root)) libs.push(root);
    } catch (e) {}
  }
  // Symlinked roots (~/.steam/steam -> ~/.local/share/Steam) list the same
  // libraries; resolve before de-duplicating so each is visited once.
  const seen = new Set();
  const out = [];
  for (const lib of libs) {
    let key = lib;
    try { key = fs.realpathSync(lib); } catch (_) {}
    if (process.platform === 'win32') key = key.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(lib);
  }
  steamLibraryCache = { at: now, libs: out };
  return out.slice();
}

// Forget cached Steam answers (after an import scan, Steam may have changed).
function clearSteamCache() {
  steamLibraryCache = { at: 0, libs: null };
  steamInstallDirCache.clear();
}

// Resolve install directory for a specific Steam App ID
function resolveSteamInstallDir(steamAppId) {
  if (!steamAppId) return '';
  const key = String(steamAppId);
  if (steamInstallDirCache.has(key)) {
    const cached = steamInstallDirCache.get(key);
    if (!cached) return '';
    if (fs.existsSync(cached)) return cached;
    steamInstallDirCache.delete(key); // uninstalled or moved: look again
  }
  const libs = getSteamLibraries();
  let found = '';
  for (const lib of libs) {
    const manifestPath = path.join(lib, 'steamapps', `appmanifest_${key}.acf`);
    if (!fs.existsSync(manifestPath)) continue;
    try {
      const content = fs.readFileSync(manifestPath, 'utf-8');
      const installDirMatch = content.match(/"installdir"\s+"([^"]+)"/i);
      if (installDirMatch) {
        const fullDir = path.join(lib, 'steamapps', 'common', installDirMatch[1]);
        if (fs.existsSync(fullDir)) { found = fullDir; break; }
      }
    } catch (e) {}
  }
  steamInstallDirCache.set(key, found);
  return found;
}

function findMainExe(dirPath) {
  if (!dirPath || !fs.existsSync(dirPath)) return '';

  const SKIP_FILES = [
    'unins', 'setup', 'crash', 'redist', 'dxsetup', 'vcredist', 'directx', 'vc_redist',
    'unarc', 'install', 'uninstall', '_commonredist', 'easyanticheat', 'battleye', 'touchup',
    'dotnet', 'physx', 'epicwebhelper', 'unitycrashhandler', 'crashreport', 'support',
    'prerequisites', 'launcher_helper'
  ];

  const SKIP_DIRS = [
    '__pycache__', 'node_modules', '.git', '_commonredist', 'redist', 'directx',
    'support', 'installer', 'install', 'prerequisites', 'crashpad', 'easyanticheat',
    'battleye', 'touchup'
  ];

  const folderName = path.basename(dirPath).toLowerCase();
  const candidates = [];
  // Bound the walk: this runs while the library is loading and must not
  // freeze the UI on a large game directory.
  const budget = { left: 3000 };

  function scanDir(dir, depth) {
    if (depth > 4 || budget.left <= 0) return;
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      budget.left -= entries.length;
      for (const e of entries) {
        if (e.isFile()) {
          const fl = e.name.toLowerCase();
          if (SKIP_FILES.some(s => fl.includes(s))) continue;
          if (!isGameExecutableEntry(e, dir)) continue;
          try {
            const stat = fs.statSync(path.join(dir, e.name));
            if (stat.size >= 10 * 1024) { // at least 10KB
              candidates.push({
                path: path.join(dir, e.name),
                name: fl,
                size: stat.size,
                depth,
              });
            }
          } catch (e2) {}
        } else if (e.isDirectory() && depth < 4) {
          const dl = e.name.toLowerCase();
          if (!SKIP_DIRS.some(d => dl.includes(d))) {
            scanDir(path.join(dir, e.name), depth + 1);
          }
        }
      }
    } catch (e) {}
  }

  scanDir(dirPath, 0);
  if (!candidates.length) return '';

  // Score candidate executables:
  // 1. Matches folder name (e.g. Brawlhalla.exe in Brawlhalla folder)
  // 2. Shipping or 64-bit binaries (e.g. -Win64-Shipping.exe)
  // 3. Lower directory depth preferred
  // 4. Larger size
  candidates.sort((a, b) => {
    const aMatch = a.name.replace('.exe', '') === folderName;
    const bMatch = b.name.replace('.exe', '') === folderName;
    if (aMatch && !bMatch) return -1;
    if (!aMatch && bMatch) return 1;

    const aShip = a.name.includes('shipping') || a.name.includes('win64');
    const bShip = b.name.includes('shipping') || b.name.includes('win64');
    if (aShip && !bShip) return -1;
    if (!aShip && bShip) return 1;

    if (a.depth !== b.depth) return a.depth - b.depth;
    return b.size - a.size;
  });

  return candidates[0].path;
}

function detectSteamGames() {
  const games = [];
  // A user-initiated scan: re-read Steam instead of trusting session caches.
  clearSteamCache();
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
            // Skip Steamworks Common Redistributables
            if (appId === '228980') continue;
            const installDir = installDirMatch ? path.join(appsDir, 'common', installDirMatch[1]) : '';
            if (installDir && !steamInstallDirCache.get(appId) && fs.existsSync(installDir)) steamInstallDirCache.set(appId, installDir);
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
  const programData = process.env.ProgramData || 'C:\\ProgramData';
  const dir = path.join(programData, 'Epic', 'EpicGamesLauncher', 'Data', 'Manifests');
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

// Lutris (Linux) game detection. Lutris writes one YAML per game under
// ~/.local/share/lutris/games; we only need exe / working_dir / name.
function detectLutrisGames() {
  const games = [];
  if (process.platform !== 'linux') return games;
  const dir = path.join(process.env.HOME || '', '.local', 'share', 'lutris', 'games');
  if (!fs.existsSync(dir)) return games;

  let files = [];
  try { files = fs.readdirSync(dir).filter(f => f.endsWith('.yml')); } catch (e) { return games; }

  const readKey = (text, key) => {
    const m = text.match(new RegExp('^\\s*' + key + ':\\s*(.+)$', 'm'));
    return m ? m[1].trim().replace(/^["']|["']$/g, '') : '';
  };

  for (const file of files) {
    try {
      const text = fs.readFileSync(path.join(dir, file), 'utf-8');
      const exe = readKey(text, 'exe');
      if (!exe) continue;
      const workingDir = readKey(text, 'working_dir') || path.dirname(exe);
      const name = readKey(text, 'name') ||
        file.replace(/-\d+\.yml$/, '').replace(/[-_]/g, ' ')
            .replace(/\b\w/g, c => c.toUpperCase()).trim();
      games.push({
        name,
        source: 'Lutris',
        exePath: exe,
        installDir: workingDir,
        status: 'Playing',
        hours: 0,
        notes: '',
        added: Date.now(),
        id: crypto.randomUUID(),
      });
    } catch (e) {}
  }
  return games;
}

// Custom folder scan
function scanFolder(folderPath) {
  const games = [];
  const entryFor = (dir, exe) => ({
    name: path.basename(dir).replace(/[_\-.]/g, ' ').replace(/\s+/g, ' ').trim(),
    source: 'Custom',
    exePath: exe,
    installDir: dir,
    status: 'Playing',
    hours: 0,
    notes: '',
    added: Date.now(),
    id: crypto.randomUUID(),
  });
  try {
    // each folder inside is a game; its exe may sit deeper (bind, Binaries\Win64)
    const entries = fs.readdirSync(folderPath, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const subDir = path.join(folderPath, entry.name);
      const exe = findMainExe(subDir);
      if (exe) games.push(entryFor(subDir, exe));
    }
    // nothing inside, but the picked folder runs a game itself: it is the game
    if (!games.length) {
      const exe = findMainExe(folderPath);
      if (exe) games.push(entryFor(folderPath, exe));
    }
  } catch (e) {}
  return games;
}


// Drive filesystem scan
function getAllDrives() {
  const drives = [];
  if (process.platform === 'win32') {
    const stdout = platform.runHelperSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      "[System.IO.DriveInfo]::GetDrives() | Where-Object { $_.DriveType -eq 'Fixed' -or $_.DriveType -eq 'Removable' } | Select-Object -ExpandProperty Name",
    ], { timeout: 5000 });
    const lines = stdout.split(/\r?\n/).map(l => l.trim().replace(/\\$/, '')).filter(l => /^[A-Z]:$/i.test(l));
    if (lines.length > 0) {
      return [...new Set(lines.map(l => l.toUpperCase()))];
    }

    // Fallback: probe drive letters with fs.existsSync
    const letters = 'CDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
    for (const letter of letters) {
      try {
        if (fs.existsSync(`${letter}:\\`)) {
          drives.push(`${letter}:`);
        }
      } catch (e) {}
    }
    return drives.length > 0 ? drives : ['C:'];
  } else {
    // Linux: walk real mount points that can actually hold games, never the
    // distro root filesystem (minute-long crawl for nothing).
    let mounts = '';
    try { mounts = fs.readFileSync('/proc/mounts', 'utf-8'); } catch (e) {}
    return platform.linuxScanRoots(process.env, mounts, fs.existsSync);
  }
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
          if (SKIP_EXE.some(s => fl.includes(s))) return false;
          return isGameExecutableName(subDir, f);
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
      // On Windows "C:" means "current directory on C:", so the separator is
      // required to address the drive root. Preserved from the original code.
      const root = drive.endsWith(path.sep) ? drive : drive + path.sep;
      const entries = fs.readdirSync(root, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const nameLower = entry.name.toLowerCase();
        if (process.platform === 'win32') {
          if (['windows', 'system32', '$recycle.bin', 'recovery', 'programdata', 'msocache', 'perflogs', 'config.msi', '$windows.~bt'].includes(nameLower)) continue;
        } else if (LINUX_SKIP_TOP.has(entry.name) || platform.SYSTEM_TOP_DIRS.has(entry.name)) {
          continue;
        }
        const fullPath = path.join(root, entry.name);
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
// `targetWindow` is the BrowserWindow used for progress events. It is
// optional so the scan can run headless (tests, CLI).
async function smartScan(targetWindow) {
  const cfg = loadConfig();
  const emitWin = targetWindow || null;
  const report = (msg) => { emitWin && !emitWin.isDestroyed() && emitWin.webContents.send('detect:progress', msg); };

  // Phase 1: Raw scan all drives
  report('Scanning all drives...');
  const rawCandidates = await scanAllDisks();
  if (!rawCandidates.length) return [];

  // Phase 2: Pre-filter with blacklist to remove 90% of non-game trash
  report('Filtering generic apps...');
  let filtered = basicFilterCandidates(rawCandidates);
  if (!filtered.length) return [];

  if (!filtered.length) return [];

  // Phase 3: Auto-fetch covers from SteamGridDB
  if (cfg.sgdbKey) {
    report(`Fetching covers for ${filtered.length} games...`);
    await autoFetchCovers(filtered, cfg.sgdbKey);
  }

  report('');
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



module.exports = { detectSteamGames, detectEpicGames, detectLutrisGames, scanFolder, smartScan, scanAllDisks, findMainExe, resolveSteamInstallDir, getSteamLibraries, getSteamRoots, clearSteamCache };
