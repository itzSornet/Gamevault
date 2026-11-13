// GameVault 2.0 — launcher importers
// One contract per source: detect (cheap) + scan (returns candidates).
// Candidates are plain objects; the renderer decides what to keep.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const HOME = os.homedir();
const IS_WIN = process.platform === 'win32';
const IS_LINUX = process.platform === 'linux';

const p = (...parts) => path.join(...parts);
const has = (target) => { try { return fs.existsSync(target); } catch (_) { return false; } };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const launchers = require('./sources/launchers.js');

// Lutris installs: native, a custom XDG folder, Flatpak. Each has its own
// database and per-game yml folders.
function lutrisInstalls() { return launchers.lutrisRoots(); }

function sqliteJson(db, sql) {
  try {
    const out = execFileSync('sqlite3', ['-json', db, sql], { encoding: 'utf8', timeout: 5000 });
    return out.trim() ? JSON.parse(out) : [];
  } catch (_) {
    return null;
  }
}

function readYmlFields(file) {
  const text = fs.readFileSync(file, 'utf-8');
  const get = (key) => {
    const m = text.match(new RegExp('^\\s*' + key + ':\\s*(.+)$', 'm'));
    return m ? m[1].trim().replace(/^["']|["']$/g, '') : '';
  };
  return { exe: get('exe'), working_dir: get('working_dir'), args: get('args'), prefix: get('prefix') };
}

function countLutris() {
  let n = 0;
  for (const inst of lutrisInstalls()) {
    const rows = has(inst.db) ? sqliteJson(inst.db, 'select count(*) as n from games where installed = 1') : null;
    if (rows && rows[0]) n += Number(rows[0].n) || 0;
    else for (const dir of inst.games) n += fs.readdirSync(dir).filter((f) => f.endsWith('.yml')).length;
  }
  return n;
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

// Launchers whose game list is a clean file we can re-read on our own.
// The rest need a person to pick what is a game, so they can't auto sync.
const SYNC_NOTES = {
  xbox: 'Reading Xbox games is slow, so they are imported when you ask.',
  battlenet: 'Battle.net keeps no game list GameVault can read safely.',
  ea: 'The EA app keeps no game list GameVault can read safely.',
  ubisoft: 'Ubisoft Connect keeps no game list GameVault can read safely.',
  rockstar: 'Rockstar keeps no game list GameVault can read safely.',
  riot: 'Riot keeps no game list GameVault can read safely.',
  playnite: 'Playnite import is not available yet.',
  'steam-owned': 'Your Steam account is imported on request.',
  pc: 'A whole-PC scan needs you to pick what is a game.',
  folder: 'Folders are scanned when you ask.',
  file: 'Files are added one at a time.',
};
const SYNCABLE = new Set(['steam', 'epic', 'gog', 'heroic', 'legendary', 'lutris', 'bottles', 'itch', 'hydra']);

function listSources() {
  const sources = [];
  let cfg = {};
  try { cfg = require('./data.js').loadConfig() || {}; } catch (_) {}
  const add = (src) => {
    const sync = SYNCABLE.has(src.id);
    sources.push({ ...src, sync, syncNote: sync ? '' : (SYNC_NOTES[src.id] || 'This source can only be imported by hand.') });
  };
  const some = (list) => Array.isArray(list) && list.length > 0;

  // Same detection the Steam scanner uses (registry path on Windows; native,
  // Flatpak and Snap on Linux).
  let steamFound = false;
  try { steamFound = require('./sources/steam.js').detect(); } catch (_) {}
  add({ id: 'steam', label: 'Steam', found: steamFound, hint: 'Installed Steam games' });

  if (IS_WIN) {
    const win = require('./sources/windows.js');
    const winSources = [
      ['epic', 'Epic Games', 'Installed Epic games'],
      ['gog', 'GOG', 'Installed GOG games'],
      ['xbox', 'Xbox', 'Xbox and Game Pass games'],
      ['battlenet', 'Battle.net', 'Installed Blizzard games'],
      ['ea', 'EA app', 'Installed EA games'],
      ['ubisoft', 'Ubisoft Connect', 'Installed Ubisoft games'],
      ['rockstar', 'Rockstar', 'Installed Rockstar games'],
      ['riot', 'Riot', 'Installed Riot games'],
    ];
    for (const [id, label, hint] of winSources) {
      let found = true;
      try { found = win.detectWindowsSource(id); } catch (_) {}
      add({ id, label, found, hint });
    }
  }

  // On every OS: Heroic, Legendary/Rare and itch keep the same files.
  add({ id: 'heroic', label: 'Heroic', found: some(launchers.heroicRoots()), hint: 'Epic, GOG and Amazon games' });
  add({ id: 'legendary', label: 'Legendary / Rare', found: some(launchers.legendaryRoots()), hint: 'Epic games' });
  add({ id: 'itch', label: 'itch.io', found: some(launchers.itchRoots()), hint: 'itch app library' });

  if (IS_LINUX) {
    const lutrisFound = some(lutrisInstalls());
    add({ id: 'lutris', label: 'Lutris', found: lutrisFound, count: lutrisFound ? countLutris() : 0, hint: 'Your Lutris library' });
    add({ id: 'bottles', label: 'Bottles', found: some(launchers.bottlesRoots()), hint: 'Programs in your bottles' });
    add({ id: 'gog', label: 'GOG', found: some(launchers.gogLinuxDirs()), hint: 'GOG installers and Minigalaxy' });
  }

  if (IS_WIN) {
    try {
      const playnite = has(p(HOME, 'AppData', 'Roaming', 'Playnite', 'games.db'));
      if (playnite) add({ id: 'playnite', label: 'Playnite', found: false, hint: 'Not supported yet' });
    } catch (_) {}
  }

  try {
    const hydra = require('./sources/hydra.js');
    add({ id: 'hydra', label: 'Hydra', found: !!(hydra.detect && hydra.detect(HOME)), hint: 'Hydra library' });
  } catch (_) {}

  add({
    id: 'steam-owned',
    label: 'Steam account',
    found: !!cfg.steamKey,
    hint: cfg.steamKey ? 'Owned library' : 'Add a Steam API key in Settings',
  });

  add({
    id: 'pc',
    label: 'This PC',
    found: true,
    hint: IS_WIN ? 'Registry, Start Menu, Xbox, Steam shortcuts' : 'Apps, AppImage, Wine, launchers',
  });

  add({ id: 'folder', label: 'Folder', action: true, found: true, hint: 'Scan a directory for games' });
  add({ id: 'file', label: 'File', action: true, found: true, hint: 'AppImage, ELF, .sh or .exe' });
  return sources;
}

// ---------------------------------------------------------------------------
// Scanners
// ---------------------------------------------------------------------------

function findLutrisYml(inst, configpath) {
  for (const dir of inst.games) {
    const file = p(dir, `${configpath}.yml`);
    if (has(file)) return file;
  }
  return '';
}

function scanLutris() {
  const out = [];
  const seen = new Set();
  const add = (c) => { if (c.sourceId && seen.has(c.sourceId)) return; seen.add(c.sourceId); out.push(c); };

  for (const inst of lutrisInstalls()) {
    // The database needs the sqlite3 command; without it the yml files below
    // still give every game Lutris has a config for.
    const rows = has(inst.db)
      ? sqliteJson(inst.db, 'select id,name,slug,runner,directory,configpath,playtime,installed from games order by name')
      : null;

    if (rows && rows.length) {
      for (const row of rows) {
        if (row.installed != null && Number(row.installed) === 0) continue;
        // Steam games inside Lutris come in through the Steam import
        if (String(row.runner || '').toLowerCase() === 'steam') continue;
        const ymlPath = row.configpath ? findLutrisYml(inst, row.configpath) : '';
        const yml = ymlPath ? readYmlFields(ymlPath) : {};
        let exe = yml.exe || '';
        if (exe && !path.isAbsolute(exe) && yml.prefix) exe = p(yml.prefix, exe);
        add({
          name: row.name,
          source: 'Lutris',
          sourceId: `lutris:${row.slug || row.id}`,
          exePath: exe,
          installDir: yml.working_dir || (exe ? path.dirname(exe) : row.directory || ''),
          hours: Number(row.playtime) || 0,
          runner: row.runner || '',
          args: yml.args || '',
          // Lutris knows the runner, prefix and environment: let it start the game
          launchTarget: row.id != null ? `lutris:rungameid/${row.id}` : '',
        });
      }
      continue;
    }

    // No database (or no sqlite3 command): one yml per configured game.
    for (const dir of inst.games) {
      for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.yml'))) {
        const yml = readYmlFields(p(dir, file));
        if (!yml.exe) continue;
        const slug = path.basename(file, '.yml').replace(/-\d+$/, '');
        const name = slug.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
        let exe = yml.exe;
        if (!path.isAbsolute(exe) && yml.prefix) exe = p(yml.prefix, exe);
        add({
          name,
          source: 'Lutris',
          sourceId: `lutris:${slug}`,
          exePath: exe,
          installDir: yml.working_dir || path.dirname(exe),
          hours: 0,
          launchTarget: `lutris:rungame/${slug}`,
        });
      }
    }
  }
  return out;
}

function scanner() { return require('./scanner.js'); }

const STEAM_TOOL_RE = /^(steam linux runtime|steamworks common redistributables|steamvr|proton |steam controller configs|steam play|steam audio)/i;

function scanSteam() {
  const seen = new Map();
  for (const g of (scanner().detectSteamGames() || [])) {
    if (!g || !g.name || STEAM_TOOL_RE.test(g.name)) continue;
    const key = g.steamAppId ? `app:${g.steamAppId}` : `name:${g.name.toLowerCase()}`;
    const prev = seen.get(key);
    if (!prev || (!prev.exePath && g.exePath)) seen.set(key, g);
  }
  return [...seen.values()].map((g) => ({
    name: g.name,
    source: 'Steam',
    sourceId: g.steamAppId ? `steam:${g.steamAppId}` : null,
    exePath: g.exePath || '',
    installDir: g.installDir || '',
    steamAppId: g.steamAppId || null,
    hours: Number(g.hours) || 0,
  }));
}

async function scanSource(id, arg) {
  try {
    if (id === 'steam') return scanSteam();
    if (id === 'hydra') {
      const hydra = require('./sources/hydra.js');
      // Only installed builds: an entry without a real executable can't be played.
      return hydra.scan({ homeDir: HOME }).filter((c) => c.exePath && has(c.exePath));
    }
    if (id === 'steam-owned') {
      const steam = require('./sources/steam.js');
      let cfg = {};
      try { cfg = require('./data.js').loadConfig() || {}; } catch (_) {}
      const res = await steam.scanOwned({ key: cfg.steamKey, steamId: cfg.steamId || steam.activeSteamId() });
      if (res && res.ok) return res.data;
      return { error: (res && res.error && res.error.message) || 'Steam account not connected' };
    }
    if (id === 'lutris') return scanLutris();
    if (id === 'heroic') return launchers.scanHeroic();
    if (id === 'legendary') return launchers.scanLegendary();
    if (id === 'bottles') return launchers.scanBottles();
    if (id === 'itch') return launchers.scanItch({ findExe: (dir) => scanner().findMainExe(dir) }).filter((c) => c.exePath);
    if (id === 'gog' && !IS_WIN) return launchers.scanGogLinux();
    if (id === 'epic' && IS_WIN) return require('./sources/windows.js').scanWindowsSource('epic');
    if (IS_WIN && ['gog', 'xbox', 'battlenet', 'ea', 'ubisoft', 'rockstar', 'riot'].includes(id)) return require('./sources/windows.js').scanWindowsSource(id);
    if (id === 'pc') {
      const mod = IS_WIN ? './sources/windows-inventory.js' : './sources/linux-desktop.js';
      const found = await require(mod)[IS_WIN ? 'scanWindowsInventory' : 'scanLinuxInventory']();
      if (found && !Array.isArray(found) && found.error) return found;
      // Launchers/tools are sources, not games; Wine ships its own toy apps.
      const NAME_NOISE = /(^|\b)(steam|lutris|heroic|bottles|hydra|prism launcher|multimc|itch|playnite|gamevault|horizon launcher|atlauncher|gdlauncher|modrinth|retroarch|emulationstation|vice|lm-?studio|filmcraft|freebuff)(\b|$)/i;
      const PATH_NOISE = /slssteam|internet explorer|windows media player|windows nt[\\/]accessories|common files/i;
      const TOOL_NOISE = /\b(studio|editor|ide|code|browser|chat|manager|launcher)\b/i;
      return (found || [])
        .filter((g) => g.exePath && g.exePath !== '/usr/bin/flatpak' && !NAME_NOISE.test(g.name) && !PATH_NOISE.test(g.exePath))
        .filter((g) => !/\.appimage$/i.test(g.exePath) || !TOOL_NOISE.test(g.name))
        .map((g) => ({
          ...g,
          sourceId: g.sourceId || (g.exePath ? `pc:${g.exePath}` : null),
        }));
    }
    if (id === 'folder' && arg) return (scanner().scanFolder(arg) || []).map((g) => ({ ...g, sourceId: g.exePath ? `folder:${g.exePath}` : null }));
    return [];
  } catch (err) {
    return { error: err.message };
  }
}

// ---------------------------------------------------------------------------
// File import (AppImage / ELF / .sh)
// ---------------------------------------------------------------------------

function sniffBinary(file) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return null;
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(64);
    const read = fs.readSync(fd, buf, 0, 64, 0);
    fs.closeSync(fd);
    if (read < 4) return null;
    const isElf = buf[0] === 0x7f && buf[1] === 0x45 && buf[2] === 0x4c && buf[3] === 0x46;
    const isAppImage = read >= 11 && buf[8] === 0x41 && buf[9] === 0x49 && buf[10] === 0x02;
    const ext = path.extname(file).toLowerCase();
    if (!isElf && !isAppImage && ext !== '.sh') return null;
    return { isElf, isAppImage, ext, stat };
  } catch (_) {
    return null;
  }
}

function parseDesktop(text) {
  const get = (key) => {
    const m = text.match(new RegExp('^' + key + '=(.*)$', 'm'));
    return m ? m[1].trim() : '';
  };
  return { name: get('Name'), icon: get('Icon'), exec: get('Exec') };
}

function findDesktopFor(file) {
  const dirs = [
    p(HOME, '.local', 'share', 'applications'),
    '/usr/share/applications',
    '/var/lib/flatpak/exports/share/applications',
    '/var/lib/snapd/desktop/applications',
  ];
  const base = path.basename(file);
  for (const dir of dirs) {
    if (!has(dir)) continue;
    let entries = [];
    try { entries = fs.readdirSync(dir).filter((f) => f.endsWith('.desktop')); } catch (_) { continue; }
    for (const entry of entries) {
      let text = '';
      try { text = fs.readFileSync(p(dir, entry), 'utf-8'); } catch (_) { continue; }
      const meta = parseDesktop(text);
      if (!meta.exec) continue;
      if (meta.exec.includes(base) || meta.exec.includes(file)) return meta;
    }
  }
  return null;
}

function resolveIcon(icon) {
  if (!icon) return null;
  if (path.isAbsolute(icon) && has(icon)) return icon;
  const bases = [p(HOME, '.local', 'share', 'icons'), '/usr/share/icons', '/usr/share/pixmaps'];
  const sizes = ['256x256', '128x128', '64x64', '48x48', 'scalable'];
  const exts = ['.png', '.svg', '.xpm'];
  for (const base of bases) {
    for (const size of sizes) {
      for (const ext of exts) {
        for (const candidate of [p(base, 'hicolor', size, 'apps', icon + ext), p(base, size, 'apps', icon + ext)]) {
          if (has(candidate)) return candidate;
        }
      }
    }
    for (const ext of exts) {
      const direct = p(base, icon + ext);
      if (has(direct)) return direct;
    }
  }
  return null;
}

function ingestFile(file) {
  const info = sniffBinary(file);
  if (!info) return null;

  if ((info.isElf || info.isAppImage) && !(info.stat.mode & 0o111)) {
    try { fs.chmodSync(file, info.stat.mode | 0o755); } catch (_) {}
  }

  const desktop = findDesktopFor(file);
  const base = path.basename(file).replace(/\.(appimage|sh|elf|exe)$/i, '').replace(/[-_]/g, ' ').trim();
  const name = (desktop && desktop.name) || base || path.basename(file);
  const icon = resolveIcon(desktop && desktop.icon);

  return {
    name,
    source: 'File',
    sourceId: `file:${file}`,
    exePath: file,
    installDir: path.dirname(file),
    hours: 0,
    iconPath: icon || '',
    kind: info.isAppImage ? 'AppImage' : info.isElf ? 'ELF' : 'Script',
  };
}

module.exports = { listSources, scanSource, scanLutris, scanSteam, ingestFile, sniffBinary, resolveIcon, SYNCABLE };
