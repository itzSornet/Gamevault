'use strict';
// GameVault 2.0 - cross-platform launcher readers
//
// Heroic, Legendary/Rare, Lutris, Bottles, itch and GOG's Linux installers,
// read from the launcher's own files. Every launcher is looked for in each
// place its different installs keep data: a native package, Flatpak, Snap,
// a custom XDG directory, and %APPDATA% on Windows.
//
// The parse* functions take text or parsed JSON and never touch the disk, so
// they are tested on any OS. scan*() take the home folder as an argument (and
// read only inside it), so tests point them at a temp folder.
//
// Candidate shape is the one the import dialog already uses, plus
// `launchTarget` when a game has to be started through its launcher.

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const has = (target) => { try { return fs.existsSync(target); } catch (_) { return false; } };
const isDir = (target) => { try { return fs.statSync(target).isDirectory(); } catch (_) { return false; } };
const readText = (file) => { try { return fs.readFileSync(file, 'utf8'); } catch (_) { return ''; } };
const readJson = (file) => { try { return JSON.parse(readText(file).replace(/^\uFEFF/, '')); } catch (_) { return null; } };
const listDir = (dir) => { try { return fs.readdirSync(dir); } catch (_) { return []; } };
const text = (v) => (v == null ? '' : String(v).trim());
const uniq = (list) => Array.from(new Set(list.filter(Boolean)));

function candidate(fields) {
  const out = {
    name: text(fields.name),
    source: fields.source,
    sourceId: fields.sourceId || null,
    exePath: fields.exePath || '',
    installDir: fields.installDir || '',
    hours: Number.isFinite(fields.hours) && fields.hours > 0 ? Math.round(fields.hours * 100) / 100 : 0,
    steamAppId: null,
    iconPath: '',
  };
  if (fields.launchTarget) out.launchTarget = fields.launchTarget;
  return out;
}

// ---------------------------------------------------------------------------
// Where each launcher keeps its data, across the ways it can be installed
// ---------------------------------------------------------------------------

function env(opts) { return (opts && opts.env) || process.env; }
function plat(opts) { return (opts && opts.platform) || process.platform; }
function homeOf(opts) { return (opts && opts.home) || os.homedir(); }

// ~/.config and ~/.local/share, honouring XDG overrides.
function xdgConfig(opts) { return text(env(opts).XDG_CONFIG_HOME) || path.join(homeOf(opts), '.config'); }
function xdgData(opts) { return text(env(opts).XDG_DATA_HOME) || path.join(homeOf(opts), '.local', 'share'); }
// A Flatpak app's private config/data folders.
function flatpak(opts, appId, kind) { return path.join(homeOf(opts), '.var', 'app', appId, kind); }
// A Snap's home (current revision and the shared "common" folder).
function snap(opts, name, ...rest) {
  return [path.join(homeOf(opts), 'snap', name, 'current', ...rest), path.join(homeOf(opts), 'snap', name, 'common', ...rest)];
}
function appData(opts) { return text(env(opts).APPDATA) || path.join(homeOf(opts), 'AppData', 'Roaming'); }

function heroicRoots(opts) {
  if (plat(opts) === 'win32') return uniq([path.join(appData(opts), 'heroic')]).filter(has);
  if (plat(opts) === 'darwin') return [path.join(homeOf(opts), 'Library', 'Application Support', 'heroic')].filter(has);
  return uniq([
    path.join(xdgConfig(opts), 'heroic'),
    path.join(homeOf(opts), '.config', 'heroic'),
    path.join(flatpak(opts, 'com.heroicgameslauncher.hgl', 'config'), 'heroic'),
    ...snap(opts, 'heroic', '.config', 'heroic'),
  ]).filter(has);
}

function legendaryRoots(opts) {
  // Legendary (and Rare, which drives it) uses ~/.config/legendary on every OS.
  return uniq([
    path.join(xdgConfig(opts), 'legendary'),
    path.join(homeOf(opts), '.config', 'legendary'),
    path.join(flatpak(opts, 'io.github.dummerle.rare', 'config'), 'legendary'),
  ]).filter(has);
}

function lutrisRoots(opts) {
  // { data: pga.db lives here, games: folders that hold the per-game yml }
  const sets = [
    { data: path.join(xdgData(opts), 'lutris'), games: [path.join(xdgConfig(opts), 'lutris', 'games'), path.join(xdgData(opts), 'lutris', 'games')] },
    { data: path.join(homeOf(opts), '.local', 'share', 'lutris'), games: [path.join(homeOf(opts), '.config', 'lutris', 'games'), path.join(homeOf(opts), '.local', 'share', 'lutris', 'games')] },
    { data: path.join(flatpak(opts, 'net.lutris.Lutris', 'data'), 'lutris'), games: [path.join(flatpak(opts, 'net.lutris.Lutris', 'config'), 'lutris', 'games'), path.join(flatpak(opts, 'net.lutris.Lutris', 'data'), 'lutris', 'games')] },
  ];
  const seen = new Set();
  const out = [];
  for (const s of sets) {
    if (seen.has(s.data)) continue;
    seen.add(s.data);
    const games = uniq(s.games).filter(isDir);
    if (has(path.join(s.data, 'pga.db')) || games.length) out.push({ data: s.data, db: path.join(s.data, 'pga.db'), games });
  }
  return out;
}

function bottlesRoots(opts) {
  return uniq([
    path.join(xdgData(opts), 'bottles', 'bottles'),
    path.join(homeOf(opts), '.local', 'share', 'bottles', 'bottles'),
    path.join(flatpak(opts, 'com.usebottles.bottles', 'data'), 'bottles', 'bottles'),
  ]).filter(isDir);
}

function itchRoots(opts) {
  if (plat(opts) === 'win32') return [path.join(appData(opts), 'itch')].filter(has);
  if (plat(opts) === 'darwin') return [path.join(homeOf(opts), 'Library', 'Application Support', 'itch')].filter(has);
  return uniq([
    path.join(xdgConfig(opts), 'itch'),
    path.join(homeOf(opts), '.config', 'itch'),
    path.join(flatpak(opts, 'io.itch.itch', 'config'), 'itch'),
  ]).filter(has);
}

function gogLinuxDirs(opts) {
  const dirs = [path.join(homeOf(opts), 'GOG Games')];
  // Minigalaxy lets you pick the install folder; it is saved in its config.
  for (const cfgFile of [path.join(xdgConfig(opts), 'minigalaxy', 'config.json'), path.join(flatpak(opts, 'io.github.sharkwouter.Minigalaxy', 'config'), 'minigalaxy', 'config.json')]) {
    const cfg = readJson(cfgFile);
    if (cfg && text(cfg.install_dir)) dirs.push(text(cfg.install_dir));
  }
  return uniq(dirs).filter(isDir);
}

// ---------------------------------------------------------------------------
// Heroic (Epic through Legendary, GOG, Amazon, and games added by hand)
// ---------------------------------------------------------------------------

// Legendary's installed.json: { AppName: { title, install_path, executable, is_dlc } }
function parseLegendaryInstalled(json, { source = 'Legendary', idPrefix = 'legendary', heroic = false, playtime = null } = {}) {
  const out = [];
  if (!json || typeof json !== 'object' || Array.isArray(json)) return out;
  for (const [key, g] of Object.entries(json)) {
    if (!g || typeof g !== 'object' || g.is_dlc) continue;
    const app = text(g.app_name) || key;
    const dir = text(g.install_path);
    const name = text(g.title) || (dir ? path.basename(dir) : app);
    if (!app || !name) continue;
    const exe = text(g.executable);
    out.push(candidate({
      name,
      source,
      sourceId: `${idPrefix}:${app}`,
      exePath: dir && exe ? path.join(dir, exe) : '',
      installDir: dir,
      hours: playtime ? playtime(app) : 0,
      launchTarget: heroic ? `heroic://launch/legendary/${encodeURIComponent(app)}` : '',
    }));
  }
  return out;
}

// Title lookups Heroic keeps beside the install lists: { games|library: [{ app_name, title }] }
function titleMap(json) {
  const map = new Map();
  const list = json && (Array.isArray(json.games) ? json.games : Array.isArray(json.library) ? json.library : Array.isArray(json) ? json : null);
  for (const g of list || []) {
    const app = text(g && (g.app_name || g.appName || g.id));
    const title = text(g && g.title);
    if (app && title) map.set(app, title);
  }
  return map;
}

// The primary play task of a GOG "goggame-<id>.info" file, joined to its folder.
function gogPrimaryExe(info, dir) {
  const tasks = info && Array.isArray(info.playTasks) ? info.playTasks : [];
  const task = tasks.find((t) => t && t.isPrimary && t.path) || tasks.find((t) => t && t.path && (!t.type || t.type === 'FileTask'));
  return task ? path.join(dir, ...String(task.path).split(/[\\/]+/)) : '';
}

// Heroic's gog_store/installed.json: { installed: [{ appName, install_path, platform, is_dlc }] }
function parseHeroicGog(json, { titles = new Map(), playtime = null, readInfo = null } = {}) {
  const out = [];
  for (const g of (json && Array.isArray(json.installed) ? json.installed : [])) {
    if (!g || g.is_dlc) continue;
    const app = text(g.appName || g.app_name);
    const dir = text(g.install_path);
    if (!app || !dir) continue;
    const info = readInfo ? readInfo(dir, app) : null;
    let exe = gogPrimaryExe(info, dir);
    if (!exe && text(g.platform).toLowerCase() === 'linux') exe = path.join(dir, 'start.sh');
    out.push(candidate({
      name: titles.get(app) || text(info && info.name) || path.basename(dir),
      source: 'Heroic',
      sourceId: `heroic:gog:${app}`,
      exePath: exe,
      installDir: dir,
      hours: playtime ? playtime(app) : 0,
      launchTarget: `heroic://launch/gog/${encodeURIComponent(app)}`,
    }));
  }
  return out;
}

// Heroic's nile_config/nile/installed.json (Amazon): [{ id, path }]
function parseHeroicNile(json, { titles = new Map(), playtime = null } = {}) {
  const out = [];
  for (const g of (Array.isArray(json) ? json : [])) {
    const app = text(g && g.id);
    const dir = text(g && g.path);
    if (!app || !dir) continue;
    out.push(candidate({
      name: titles.get(app) || path.basename(dir),
      source: 'Heroic',
      sourceId: `heroic:nile:${app}`,
      installDir: dir,
      hours: playtime ? playtime(app) : 0,
      launchTarget: `heroic://launch/nile/${encodeURIComponent(app)}`,
    }));
  }
  return out;
}

// Heroic's sideload_apps/library.json: { games: [{ app_name, title, install: { executable }, folder_name }] }
function parseHeroicSideload(json, { playtime = null } = {}) {
  const out = [];
  for (const g of (json && Array.isArray(json.games) ? json.games : [])) {
    const app = text(g && g.app_name);
    const name = text(g && g.title);
    if (!app || !name) continue;
    const exe = text(g.install && g.install.executable);
    out.push(candidate({
      name,
      source: 'Heroic',
      sourceId: `heroic:sideload:${app}`,
      exePath: exe,
      installDir: text(g.folder_name) || (exe ? path.dirname(exe) : ''),
      hours: playtime ? playtime(app) : 0,
      launchTarget: `heroic://launch/sideload/${encodeURIComponent(app)}`,
    }));
  }
  return out;
}

// Heroic's store/timestamp.json: { appName: { totalPlayed: minutes } } -> hours lookup
function heroicPlaytime(json) {
  return (app) => {
    const row = json && json[app];
    const minutes = row && Number(row.totalPlayed);
    return Number.isFinite(minutes) && minutes > 0 && minutes < 60 * 24 * 365 * 20 ? minutes / 60 : 0;
  };
}

function scanHeroic(opts) {
  const out = [];
  for (const root of heroicRoots(opts)) {
    const playtime = heroicPlaytime(readJson(path.join(root, 'store', 'timestamp.json')));
    out.push(...parseLegendaryInstalled(readJson(path.join(root, 'legendaryConfig', 'legendary', 'installed.json')),
      { source: 'Heroic', idPrefix: 'heroic:legendary', heroic: true, playtime }));
    const gogTitles = titleMap(readJson(path.join(root, 'store_cache', 'gog_library.json')) || readJson(path.join(root, 'gog_store', 'library.json')));
    out.push(...parseHeroicGog(readJson(path.join(root, 'gog_store', 'installed.json')), {
      titles: gogTitles,
      playtime,
      readInfo: (dir, app) => readJson(path.join(dir, `goggame-${app}.info`)),
    }));
    const nileTitles = titleMap(readJson(path.join(root, 'store_cache', 'nile_library.json')) || readJson(path.join(root, 'nile_config', 'nile', 'library.json')));
    out.push(...parseHeroicNile(readJson(path.join(root, 'nile_config', 'nile', 'installed.json')), { titles: nileTitles, playtime }));
    out.push(...parseHeroicSideload(readJson(path.join(root, 'sideload_apps', 'library.json')), { playtime }));
  }
  return dedupe(out);
}

function scanLegendary(opts) {
  const out = [];
  for (const root of legendaryRoots(opts)) out.push(...parseLegendaryInstalled(readJson(path.join(root, 'installed.json'))));
  return dedupe(out);
}

// ---------------------------------------------------------------------------
// Bottles: each bottle's bottle.yml lists the programs added to it
// ---------------------------------------------------------------------------

function unquoteYaml(value) {
  const v = text(value);
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) return v.slice(1, -1).replace(/\\\\/g, '\\');
  return v === 'null' || v === '~' ? '' : v;
}

// bottle.yml -> { name, programs: [{ id, name, path, executable }] }
// Only the two-level block under "External_Programs:" is read; the rest of
// the file is ignored, so this needs no YAML library.
function parseBottleYml(raw) {
  const lines = String(raw || '').split(/\r?\n/);
  let name = '';
  const programs = [];
  let inBlock = false;
  let current = null;
  for (const line of lines) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const indent = line.length - line.trimStart().length;
    const m = line.trim().match(/^([^:]+):\s*(.*)$/);
    if (!m) continue;
    const key = unquoteYaml(m[1]);
    const value = m[2];
    if (indent === 0) {
      inBlock = key === 'External_Programs' && !/^\{\s*\}$/.test(value.trim());
      current = null;
      if (key === 'Name') name = unquoteYaml(value);
      continue;
    }
    if (!inBlock) continue;
    if (indent <= 2 && value.trim() === '') {
      current = { id: key, name: '', path: '', executable: '' };
      programs.push(current);
    } else if (current && indent > 2) {
      if (key === 'name') current.name = unquoteYaml(value);
      else if (key === 'path') current.path = unquoteYaml(value);
      else if (key === 'executable') current.executable = unquoteYaml(value);
    }
  }
  return { name, programs: programs.filter((p) => p.name || p.executable) };
}

function scanBottles(opts) {
  const out = [];
  for (const root of bottlesRoots(opts)) {
    for (const folder of listDir(root)) {
      const dir = path.join(root, folder);
      const yml = readText(path.join(dir, 'bottle.yml'));
      if (!yml) continue;
      const bottle = parseBottleYml(yml);
      const bottleName = bottle.name || folder;
      for (const prog of bottle.programs) {
        const name = prog.name || prog.executable.replace(/\.[a-z0-9]+$/i, '');
        // a host path is something we can watch; a C:\ path inside the bottle is not
        const hostPath = prog.path && prog.path.startsWith('/') ? prog.path : '';
        out.push(candidate({
          name,
          source: 'Bottles',
          sourceId: `bottles:${bottleName}:${prog.id}`,
          exePath: hostPath,
          installDir: hostPath ? path.dirname(hostPath) : dir,
          launchTarget: `bottles:run/${encodeURIComponent(bottleName)}/${encodeURIComponent(prog.name || name)}`,
        }));
      }
    }
  }
  return dedupe(out);
}

// ---------------------------------------------------------------------------
// itch: every installed game folder carries a gzipped receipt with its title
// ---------------------------------------------------------------------------

// receipt.json (already unzipped) -> { id, title } | null. Tools, soundtracks
// and asset packs are not games.
function parseItchReceipt(json) {
  const game = json && json.game;
  if (!game || typeof game !== 'object') return null;
  const title = text(game.title);
  const kind = text(game.classification).toLowerCase();
  if (!title || (kind && kind !== 'game')) return null;
  return { id: text(game.id) || title, title };
}

function readItchReceipt(dir) {
  for (const name of ['receipt.json.gz', 'receipt.json']) {
    const file = path.join(dir, '.itch', name);
    if (!has(file)) continue;
    try {
      const buf = fs.readFileSync(file);
      return JSON.parse((name.endsWith('.gz') ? zlib.gunzipSync(buf) : buf).toString('utf8'));
    } catch (_) { /* unreadable receipt: try the next form */ }
  }
  return null;
}

// findExe(dir) -> path of the game's executable inside its folder, or ''.
function scanItch(opts) {
  const findExe = (opts && opts.findExe) || (() => '');
  const out = [];
  for (const root of itchRoots(opts)) {
    const apps = path.join(root, 'apps');
    for (const folder of listDir(apps)) {
      const dir = path.join(apps, folder);
      if (!isDir(dir)) continue;
      const receipt = parseItchReceipt(readItchReceipt(dir));
      if (!receipt) continue;
      out.push(candidate({
        name: receipt.title,
        source: 'itch.io',
        sourceId: `itch:${receipt.id}`,
        exePath: findExe(dir) || '',
        installDir: dir,
      }));
    }
  }
  return dedupe(out);
}

// ---------------------------------------------------------------------------
// GOG on Linux: the .sh installers and Minigalaxy both leave a "gameinfo" file
// ---------------------------------------------------------------------------

// gameinfo: line 1 is the game's name, line 2 its version.
function parseGogGameinfo(raw) {
  const lines = String(raw || '').split(/\r?\n/).map((l) => l.trim());
  return lines[0] ? { name: lines[0], version: lines[1] || '' } : null;
}

function scanGogLinux(opts) {
  const out = [];
  for (const base of gogLinuxDirs(opts)) {
    for (const folder of listDir(base)) {
      const dir = path.join(base, folder);
      const info = parseGogGameinfo(readText(path.join(dir, 'gameinfo')));
      if (!info) continue;
      const start = path.join(dir, 'start.sh');
      out.push(candidate({
        name: info.name,
        source: 'GOG',
        sourceId: `gog-linux:${info.name.toLowerCase()}`,
        exePath: has(start) ? start : '',
        installDir: dir,
      }));
    }
  }
  return dedupe(out);
}

function dedupe(list) {
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const key = text(item.sourceId || item.exePath || item.name).toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

module.exports = {
  heroicRoots, legendaryRoots, lutrisRoots, bottlesRoots, itchRoots, gogLinuxDirs,
  parseLegendaryInstalled, parseHeroicGog, parseHeroicNile, parseHeroicSideload, heroicPlaytime, titleMap,
  parseBottleYml, parseItchReceipt, parseGogGameinfo,
  scanHeroic, scanLegendary, scanBottles, scanItch, scanGogLinux,
};
