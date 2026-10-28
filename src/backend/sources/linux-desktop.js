'use strict';
// GameVault 2.0 - Linux desktop inventory (pure parsers + guarded scanners).
// Candidate: { name, source, sourceId, exePath, installDir, confidence, iconPath, launcher, args }.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const GAME_COMMANDS = new Set([
  'steam', 'lutris', 'heroic', 'heroic-games-launcher', 'bottles', 'minecraft',
  'prismlauncher', 'multimc', 'atlauncher', 'gdlauncher', 'modrinth', 'retroarch',
  'itch', 'itch.io', 'playonlinux', 'gamehub', 'ryujinx', 'yuzu', 'dolphin-emu',
  'pcsx2', 'rpcs3',
]);
// %% is a literal percent; every other standard field code is dropped.
const FIELD_CODE_RE = /%%|%[fFuUiIcdDnNvmkK]/g;
const SKIP_WINE_PART_RE = /^(?:windows|common files|uninstall.*|unins.*|vc_redist.*|directx.*|dxsetup.*|redist.*)$/i;
const ESCAPE_MAP = { s: ' ', n: '\n', t: '\t', r: '\r', '\\': '\\' };
const INSTANCE_LAUNCHERS = [
  { id: 'prism', marker: 'instance.cfg', roots: ['.local/share/PrismLauncher/instances', '.var/app/org.prismlauncher.PrismLauncher/data/PrismLauncher/instances'] },
  { id: 'multimc', marker: 'instance.cfg', roots: ['.local/share/multimc/instances', '.local/share/MultiMC/instances'] },
  { id: 'atlauncher', marker: 'instance.json', roots: ['.local/share/ATLauncher/instances', '.local/share/ATLauncher/Instances'] },
  { id: 'gdlauncher', marker: 'instance.json', roots: ['.local/share/gdlauncher/instances', '.config/gdlauncher_next/instances'] },
  { id: 'modrinth', marker: 'profile.json', roots: ['.local/share/ModrinthApp/profiles', '.config/ModrinthApp/profiles', '.var/app/com.modrinth.ModrinthApp/data/ModrinthApp/profiles'] },
];

const text = (value) => (value == null ? '' : String(value).trim());
const roots = (value) => (Array.isArray(value) ? value : [value]).map(text).filter(Boolean);
function candidate(f) {
  const confidence = typeof f.confidence === 'number' ? f.confidence : 0.7;
  return { name: text(f.name), source: text(f.source), sourceId: f.sourceId || null, exePath: f.exePath || '',
    installDir: f.installDir || '', confidence, iconPath: f.iconPath || '', launcher: f.launcher || null,
    args: Array.isArray(f.args) ? f.args : [] };
}
function dedupe(items) {
  const seen = new Set();
  return items.filter((item) => {
    const key = [item.source, item.exePath || item.sourceId, item.name].join('|').toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
function readEntries(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return []; }
}
function readText(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch (_) { return ''; }
}
function isFile(file) {
  try { return fs.statSync(file).isFile(); } catch (_) { return false; }
}
// Depth 0 is the passed directory; recursion stops once depth reaches maxDepth.
function walk(dir, depth, maxDepth, visit) {
  for (const entry of readEntries(dir)) {
    const full = path.join(dir, entry.name);
    let stat = entry;
    if (entry.isSymbolicLink()) {
      try { stat = fs.statSync(full); } catch (_) { continue; }
    }
    if (stat.isDirectory()) {
      if (depth < maxDepth) walk(full, depth + 1, maxDepth, visit);
    } else if (stat.isFile()) visit(full);
  }
}

// ---- Desktop entries -------------------------------------------------------
const unescapeValue = (value) => String(value).replace(/\\([sntr\\])/g, (_, char) => ESCAPE_MAP[char]);
const boolValue = (value) => /^(?:true|1)$/i.test(text(value));
function stripFieldCodes(value) {
  return text(value).replace(FIELD_CODE_RE, (match) => (match === '%%' ? '%' : '')).replace(/\s+/g, ' ').trim();
}
// Parses only [Desktop Entry]; localized keys and action groups are ignored.
// Categories is an array, NoDisplay/Terminal are booleans.
function parseDesktopEntry(raw) {
  const entry = { Name: '', Exec: '', Icon: '', Categories: [], TryExec: '', NoDisplay: false, Terminal: false };
  if (typeof raw !== 'string') return entry;
  let inside = false;
  for (const line of raw.split(/\r?\n/)) {
    const section = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (section) { inside = section[1].trim().toLowerCase() === 'desktop entry'; continue; }
    if (!inside || /^\s*#/.test(line)) continue;
    const match = line.match(/^\s*([A-Za-z0-9-]+(?:\[[^\]]+\])?)\s*=\s*(.*)$/);
    if (!match || match[1].includes('[')) continue;
    const key = match[1];
    const value = match[2];
    if (key === 'Name') entry.Name = unescapeValue(value).trim();
    else if (key === 'Exec') entry.Exec = stripFieldCodes(unescapeValue(value));
    else if (key === 'Icon') entry.Icon = unescapeValue(value).trim();
    else if (key === 'TryExec') entry.TryExec = unescapeValue(value).trim();
    else if (key === 'NoDisplay') entry.NoDisplay = boolValue(value);
    else if (key === 'Terminal') entry.Terminal = boolValue(value);
    else if (key === 'Categories') {
      entry.Categories = value.split(';').map((part) => unescapeValue(part).trim()).filter(Boolean);
    }
  }
  return entry;
}
// Exec -> argv, honoring quotes/escapes and unwrapping `env VAR=value ...`.
function splitExec(line) {
  const tokens = [];
  let current = '';
  let quote = '';
  let escaped = false;
  let started = false;
  for (const char of line) {
    if (escaped) { current += char; escaped = false; started = true; }
    else if (char === '\\') { escaped = true; started = true; }
    else if (quote) { if (char === quote) quote = ''; else current += char; started = true; }
    else if (char === '"' || char === "'") { quote = char; started = true; }
    else if (/\s/.test(char)) { if (started) { tokens.push(current); current = ''; started = false; } }
    else { current += char; started = true; }
  }
  if (escaped) current += '\\';
  if (started) tokens.push(current);
  return tokens;
}
function parseExec(line) {
  const tokens = splitExec(stripFieldCodes(line));
  if (path.basename(tokens[0] || '').toLowerCase() === 'env') {
    tokens.shift();
    while (tokens.length) {
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) { tokens.shift(); continue; }
      if (!tokens[0].startsWith('-')) break;
      const flag = tokens.shift();
      if (flag === '-u' || flag === '--unset') tokens.shift();
    }
  }
  return { command: tokens[0] || '', args: tokens.slice(1) };
}
function resolveCommand(command) {
  if (!command || path.isAbsolute(command)) return command;
  if (command.includes('/')) return path.resolve(command);
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (dir && isFile(path.join(dir, command))) return path.join(dir, command);
  }
  return command;
}
// Recurse to depth 3. Keep Categories mentioning Game or a well-known game
// command; NoDisplay entries are helpers rather than library rows.
function scanDesktopFiles(dirs) {
  const out = [];
  for (const root of roots(dirs)) {
    walk(root, 0, 3, (file) => {
      if (!/\.desktop$/i.test(file)) return;
      const entry = parseDesktopEntry(readText(file));
      if (!entry.Name || entry.NoDisplay) return;
      const { command, args } = parseExec(entry.Exec || entry.TryExec);
      const game = entry.Categories.some((category) => /game/i.test(category));
      if (!command || (!game && !GAME_COMMANDS.has(path.basename(command).toLowerCase()))) return;
      const exePath = resolveCommand(command);
      out.push(candidate({
        name: entry.Name, source: 'desktop', sourceId: `desktop:${file}`, exePath,
        installDir: path.isAbsolute(exePath) ? path.dirname(exePath) : '',
        confidence: game ? 0.9 : 0.7, iconPath: entry.Icon, launcher: 'desktop', args,
      }));
    });
  }
  return dedupe(out);
}

// ---- AppImage: ELF magic plus type-2 magic at offset 8 ---------------------
function isAppImage(file) {
  let fd = null;
  try {
    fd = fs.openSync(file, 'r');
    const header = Buffer.alloc(12);
    const read = fs.readSync(fd, header, 0, 12, 0);
    return read === 12 &&
      header[0] === 0x7f && header[1] === 0x45 && header[2] === 0x4c && header[3] === 0x46 &&
      header[8] === 0x41 && header[9] === 0x49 && header[10] === 0x02;
  } catch (_) {
    return false;
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch (_) {} }
  }
}
function scanAppImages(dirs) {
  const out = [];
  for (const root of roots(dirs)) {
    for (const entry of readEntries(root)) {
      const file = path.join(root, entry.name);
      const usable = entry.isFile() || (entry.isSymbolicLink() && isFile(file));
      if (!usable || !isAppImage(file)) continue;
      out.push(candidate({
        name: path.basename(file).replace(/\.appimage$/i, ''), source: 'AppImage',
        sourceId: `appimage:${file}`, exePath: file, installDir: root,
        confidence: 0.9, launcher: 'appimage',
      }));
    }
  }
  return dedupe(out);
}

// ---- RetroArch .lpl playlist (JSON) ---------------------------------------
function parseRetroArchPlaylist(raw) {
  let data;
  try { data = JSON.parse(String(raw).replace(/^\uFEFF/, '')); } catch (_) { return []; }
  const items = Array.isArray(data) ? data : (data && Array.isArray(data.items) ? data.items : []);
  const out = [];
  const seen = new Set();
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const rom = text(item.path);
    if (!rom || seen.has(rom)) continue;
    seen.add(rom);
    const found = candidate({
      name: text(item.label) || path.basename(rom).replace(/\.[^.]+$/, ''),
      source: 'RetroArch', sourceId: `retroarch:${rom}`, exePath: rom,
      installDir: path.dirname(rom), confidence: 0.8, launcher: 'retroarch',
    });
    found.core = text(item.core_name);
    out.push(found);
  }
  return dedupe(out);
}

// ---- Wine prefixes: drive_c depth <= 4 ------------------------------------
function scanWinePrefixes(prefixes) {
  const out = [];
  for (const prefix of roots(prefixes)) {
    const driveC = path.join(prefix, 'drive_c');
    walk(driveC, 0, 4, (file) => {
      if (!/\.exe$/i.test(file)) return;
      const parts = path.relative(driveC, file).split(path.sep);
      if (parts.some((part) => SKIP_WINE_PART_RE.test(part))) return;
      const name = path.basename(file).replace(/\.exe$/i, '');
      if (name) out.push(candidate({
        name, source: 'Wine', sourceId: `wine:${file}`, exePath: file,
        installDir: path.dirname(file), confidence: 0.7, launcher: prefix,
      }));
    });
  }
  return dedupe(out);
}

// ---- Minecraft launchers ---------------------------------------------------
function subdirs(dir) {
  return readEntries(dir).filter((entry) => entry.isDirectory()).map((entry) => path.join(dir, entry.name));
}
function instanceName(file, fallback) {
  const raw = readText(file);
  if (!raw) return fallback;
  if (/\.json$/i.test(file)) {
    try {
      const data = JSON.parse(raw);
      return text(data.name || data.displayName || (data.profile && data.profile.name)) || fallback;
    } catch (_) { return fallback; }
  }
  const match = raw.match(/^\s*name\s*=\s*(.+)$/im);
  return match ? match[1].trim() || fallback : fallback;
}
function findExecutable(home, names) {
  const dirs = [
    path.join(home, '.local', 'bin'), path.join(home, 'bin'), '/usr/local/bin', '/usr/bin',
    '/opt/HorizonLauncher', ...(process.env.PATH || '').split(path.delimiter),
  ];
  for (const dir of dirs) for (const name of names) {
    const file = dir && path.join(dir, name);
    if (file && isFile(file)) return file;
  }
  return '';
}
// Horizon's CLI exposes minecraft_dir as JSON through `settings`.
function horizonMinecraftDir(home) {
  const binary = findExecutable(home, ['horizon', 'horizon-launcher', 'HorizonLauncher', 'Horizon']);
  if (!binary) return '';
  try {
    const output = String(execFileSync(binary, ['settings'], {
      encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
    }));
    const start = output.indexOf('{');
    const end = output.lastIndexOf('}');
    if (start < 0 || end <= start) return '';
    const settings = JSON.parse(output.slice(start, end + 1));
    return text(settings.minecraft_dir || settings.minecraftDir || settings.game_dir || settings.gameDir);
  } catch (_) { return ''; }
}
function minecraftVersionCandidates(minecraftDir) {
  const out = [];
  const versions = path.join(minecraftDir, 'versions');
  for (const entry of readEntries(versions)) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(versions, entry.name);
    out.push(candidate({
      name: `Minecraft ${entry.name}`, source: 'Minecraft', sourceId: `horizon:${dir}`,
      installDir: dir, confidence: 0.8, launcher: 'horizon',
    }));
  }
  return out;
}
// One candidate per Prism/MultiMC/ATLauncher/GDLauncher/Modrinth instance plus
// Horizon. Without a usable Horizon CLI answer, read ~/.minecraft/versions.
function scanMinecraftLaunchers(opts = {}) {
  const options = opts || {};
  const home = text(options.homeDir) || os.homedir();
  const out = [];
  for (const launcher of INSTANCE_LAUNCHERS) {
    for (const root of launcher.roots) {
      for (const dir of subdirs(path.join(home, root))) {
        const marker = path.join(dir, launcher.marker);
        if (!isFile(marker)) continue;
        out.push(candidate({
          name: instanceName(marker, path.basename(dir)), source: 'Minecraft',
          sourceId: `${launcher.id}:${dir}`, installDir: dir, confidence: 0.9, launcher: launcher.id,
        }));
      }
    }
  }
  const configured = horizonMinecraftDir(home);
  out.push(...minecraftVersionCandidates(configured || path.join(home, '.minecraft')));
  return dedupe(out);
}

// ---- Aggregate -------------------------------------------------------------
function defaultWinePrefixes(home) {
  return [...new Set([
    path.join(home, '.wine'),
    ...subdirs(path.join(home, '.local', 'share', 'wineprefixes')),
    ...subdirs(path.join(home, '.var', 'app')).map((app) => path.join(app, 'data', 'wine')),
    ...subdirs(path.join(home, '.local', 'share', 'bottles', 'bottles')),
  ])];
}
// opts.homeDir plus optional desktopDirs/appImageDirs/winePrefixes overrides.
// Missing dirs are normal; each source is isolated so one failure cannot abort
// the rest.
function scanLinuxInventory(opts = {}) {
  const options = opts || {};
  const home = text(options.homeDir) || os.homedir();
  const pick = (key, fallback) => (options[key] !== undefined ? options[key] : fallback);
  const scans = [
    () => scanDesktopFiles(pick('desktopDirs', [
      '/usr/share/applications', '/usr/local/share/applications',
      path.join(home, '.local', 'share', 'applications'),
      path.join(home, '.local', 'share', 'flatpak', 'exports', 'share', 'applications'),
      '/var/lib/flatpak/exports/share/applications', '/var/lib/snapd/desktop/applications',
    ])),
    () => scanAppImages(pick('appImageDirs', [
      path.join(home, 'Applications'), path.join(home, 'Games'), path.join(home, 'Downloads'), '/opt',
    ])),
    () => scanWinePrefixes(pick('winePrefixes', defaultWinePrefixes(home))),
    () => scanMinecraftLaunchers({ homeDir: home }),
  ];
  const out = [];
  for (const scan of scans) {
    try { out.push(...scan()); } catch (_) {}
  }
  return dedupe(out);
}
module.exports = {
  parseDesktopEntry,
  parseExec,
  scanDesktopFiles,
  scanAppImages,
  parseRetroArchPlaylist,
  scanWinePrefixes,
  scanMinecraftLaunchers,
  scanLinuxInventory,
};
