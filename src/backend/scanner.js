const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const platform = require('./platform.js');

// True when this directory entry is a game executable for the current OS.
// Windows: .exe only (unchanged). Linux: .exe (Wine/Proton) or native ELF/sh.
function isGameExecutableEntry(entry, dir) {
  if (process.platform === 'win32') return entry.name.toLowerCase().endsWith('.exe');
  return platform.isLaunchableFile(path.join(dir, entry.name));
}

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


module.exports = { detectSteamGames, scanFolder, findMainExe, resolveSteamInstallDir, getSteamLibraries, getSteamRoots, clearSteamCache };
