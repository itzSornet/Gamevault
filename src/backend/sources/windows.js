'use strict';
// GameVault 2.0 - Windows launcher sources
//
// The parsers in this file take already-read data (an Epic .item manifest, a
// GOG .info object, one registry key's values, a Get-AppxPackage JSON dump), so
// every branch is testable on any OS without touching Windows. No native
// modules and no dependencies.
//
// scanWindowsSource() is the only OS-aware entry point. It returns [] on every
// non-Windows platform and, on Windows, is a thin guarded orchestrator around
// the parsers. It deliberately uses execFileSync so the import-scan contract
// stays synchronous (the existing importers return arrays, not promises).

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const EPIC_MANIFEST_DIR = 'Epic\\EpicGamesLauncher\\Data\\Manifests';
const GOG_REG_KEY = 'HKLM\\SOFTWARE\\WOW6432Node\\GOG.com\\Games';
const UNINSTALL_ROOTS = [
  'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
];

// Built-in packages that appear in Get-AppxPackage but are never games.
const XBOX_SYSTEM_APPS = new Set([
  'microsoft.windowsstore',
  'microsoft.desktopappinstaller',
  'microsoft.xboxapp',
  'microsoft.gamingapp',
]);

const XBOX_LIST_COMMAND =
  'Get-AppxPackage | Select-Object Name,PackageFamilyName,InstallLocation | ConvertTo-Json';

// Battle.net, EA and Ubisoft do not expose a clean library file we can read,
// so they are matched against the regular Uninstall registry keys.
const REGISTRY_SOURCES = {
  battlenet: { source: 'Battle.net', pattern: /battle\.?net|blizzard/i },
  'battle.net': { source: 'Battle.net', pattern: /battle\.?net|blizzard/i },
  blizzard: { source: 'Battle.net', pattern: /battle\.?net|blizzard/i },
  ea: { source: 'EA', pattern: /electronic arts|\bEA\b|\bOrigin\b/i },
  eaapp: { source: 'EA', pattern: /electronic arts|\bEA\b|\bOrigin\b/i },
  eagames: { source: 'EA', pattern: /electronic arts|\bEA\b|\bOrigin\b/i },
  origin: { source: 'EA', pattern: /electronic arts|\bEA\b|\bOrigin\b/i },
  ubisoft: { source: 'Ubisoft', pattern: /ubisoft|uplay/i },
  uplay: { source: 'Ubisoft', pattern: /ubisoft|uplay/i },
};

// ---------------------------------------------------------------------------
// Candidates and small value helpers
// ---------------------------------------------------------------------------

// Every parser returns this exact shape. Keeping construction in one place
// stops launcher-specific fields from leaking into the stored game object.
function candidate(fields) {
  return {
    name: fields.name,
    source: fields.source,
    sourceId: fields.sourceId || null,
    exePath: fields.exePath || '',
    installDir: fields.installDir || '',
    hours: 0,
    steamAppId: null,
    iconPath: '',
  };
}

function text(value) {
  return value == null ? '' : String(value).trim();
}

function firstText(...values) {
  for (const value of values) {
    const out = text(value);
    if (out) return out;
  }
  return '';
}

function slug(value) {
  return text(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function unquote(value) {
  const out = text(value);
  if (out.length >= 2 && out.startsWith('"') && out.endsWith('"')) {
    return out.slice(1, -1).trim();
  }
  return out;
}

// Registry lookups are case-insensitive in spirit; make plain objects the same.
function pick(obj, key) {
  if (Object.prototype.hasOwnProperty.call(obj, key)) return obj[key];
  const wanted = key.toLowerCase();
  for (const name of Object.keys(obj)) {
    if (name.toLowerCase() === wanted) return obj[name];
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------
//
// Fixtures (and the real manifests) use Windows paths even when the tests run
// on Linux, so a plain path.join() would produce mixed separators there. Pick
// the flavour from the data: Windows-looking bases use win32 joining,
// POSIX-looking bases keep the host path semantics.

function isWindowsAbsolute(value) {
  return /^[A-Za-z]:[\\/]/.test(value) || /^\\\\[^\\]/.test(value);
}

function looksWindows(value) {
  return isWindowsAbsolute(value) || value.includes('\\');
}

function joinGamePath(dir, rel) {
  const base = text(dir);
  const leaf = text(rel);
  if (!leaf) return base;
  if (!base) return leaf;

  if (isWindowsAbsolute(leaf)) return leaf;
  if (!looksWindows(base) && path.isAbsolute(leaf)) return leaf;

  return looksWindows(base) ? path.win32.join(base, leaf) : path.join(base, leaf);
}

// ---------------------------------------------------------------------------
// Epic
// ---------------------------------------------------------------------------

// .item manifest object -> Candidate | null.
// Required: DisplayName, InstallLocation, LaunchExecutable and an id
// (CatalogItemId, falling back to AppName).
function parseEpicManifest(json) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return null;

  const name = text(json.DisplayName);
  const installDir = text(json.InstallLocation);
  const launch = text(json.LaunchExecutable);
  const id = firstText(json.CatalogItemId, json.AppName);

  if (!name || !installDir || !launch || !id) return null;

  return candidate({
    name,
    source: 'Epic',
    sourceId: `epic:${id}`,
    exePath: joinGamePath(installDir, launch),
    installDir,
  });
}

// ---------------------------------------------------------------------------
// GOG
// ---------------------------------------------------------------------------

// goggame-<id>.info object + the directory it was found in -> Candidate | null.
// The executable is the primary play task; secondary tasks are launchers or
// helpers (Galaxy, support tools) and are ignored.
function parseGogInfo(json, dir) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return null;

  const name = firstText(json.name, json.gameName);
  const tasks = Array.isArray(json.playTasks) ? json.playTasks : [];
  const primary = tasks.find((task) => task && (task.isPrimary === true || task.isPrimary === 'true'));
  const taskPath = text(primary && primary.path);

  if (!name || !taskPath) return null;

  const installDir = firstText(dir, json.installDirectory);
  const gameId = firstText(json.gameId, json.gameID, json.GameID);

  return candidate({
    name,
    source: 'GOG',
    sourceId: `gog:${gameId || slug(name)}`,
    exePath: joinGamePath(installDir, taskPath),
    installDir,
  });
}

// ---------------------------------------------------------------------------
// Registry uninstall keys (Battle.net / EA / Ubisoft fallback)
// ---------------------------------------------------------------------------

// DisplayIcon can be "C:\Game\game.exe",0, C:\Game\game.exe,0 or an icon path;
// the executable path is everything before the optional quoted-closing/index.
function cleanDisplayIcon(value) {
  let out = text(value);
  if (!out) return '';

  // "@path,-1" is the indirect-string form some installers use.
  if (out.startsWith('@')) out = out.slice(1).trim();

  if (out.startsWith('"')) {
    const end = out.indexOf('"', 1);
    out = end > 0 ? out.slice(1, end) : out.slice(1);
  } else {
    out = out.replace(/,\s*-?\d+\s*$/, '');
  }

  return out.trim();
}

// One parsed registry key's values -> Candidate | null.
// Returns null when there is no DisplayName or neither DisplayIcon nor
// InstallLocation to point at a path.
function parseUninstallKey(obj, sourceName = 'Windows') {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;

  const name = text(pick(obj, 'DisplayName'));
  const displayIcon = unquote(pick(obj, 'DisplayIcon'));
  const installDir = unquote(pick(obj, 'InstallLocation'));

  if (!name || (!displayIcon && !installDir)) return null;

  const source = text(sourceName) || 'Windows';

  return candidate({
    name,
    source,
    sourceId: `${source.toLowerCase()}:${name}`,
    exePath: cleanDisplayIcon(displayIcon),
    installDir,
  });
}

// ---------------------------------------------------------------------------
// Xbox / Microsoft Store
// ---------------------------------------------------------------------------

// "Microsoft.ForzaHorizon5" -> "Forza Horizon 5"
function xboxDisplayName(packageName) {
  return text(packageName)
    .replace(/^Microsoft\./i, '')
    .replace(/[._-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/([A-Za-z])(\d)/g, '$1 $2')
    .replace(/(\d)([A-Za-z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim();
}

// Get-AppxPackage JSON -> Candidate[]. A single package is emitted as an
// object by ConvertTo-Json, so accept both shapes.
function parseXboxApps(json) {
  const list = Array.isArray(json) ? json : (json && typeof json === 'object' ? [json] : []);
  const out = [];

  for (const app of list) {
    if (!app || typeof app !== 'object') continue;

    const packageName = text(app.Name);
    if (!/^Microsoft\./.test(packageName)) continue;
    if (XBOX_SYSTEM_APPS.has(packageName.toLowerCase())) continue;

    const family = text(app.PackageFamilyName);
    if (!family) continue;

    out.push(candidate({
      name: xboxDisplayName(packageName),
      source: 'Xbox',
      sourceId: `xbox:${family}`,
      exePath: `shell:AppsFolder\\${family}!App`,
      installDir: text(app.InstallLocation),
    }));
  }

  return out;
}

// ---------------------------------------------------------------------------
// Windows orchestration
// ---------------------------------------------------------------------------

function parseJsonText(raw) {
  try {
    return JSON.parse(String(raw).replace(/^\uFEFF/, '').trim());
  } catch (_) {
    return null;
  }
}

function execText(command, args, options) {
  try {
    return execFileSync(command, args, {
      encoding: 'utf8',
      timeout: 20000,
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
      ...options,
    }) || '';
  } catch (_) {
    return '';
  }
}

function queryRegistry(key) {
  return execText('reg.exe', ['query', key, '/s']);
}

// reg query output -> [{ key, values }]. Each key header starts a new block;
// values are the indented "Name    REG_TYPE    Data" lines under it.
function parseRegQuery(raw) {
  const blocks = [];
  let current = null;

  for (const line of String(raw || '').split(/\r?\n/)) {
    if (!line.trim()) continue;

    if (/^\s*HKEY_/i.test(line)) {
      current = { key: line.trim(), values: {} };
      blocks.push(current);
      continue;
    }
    if (!current) continue;

    const match = line.match(/^\s+(.+?)\s{2,}(REG_[A-Z0-9_]+)(?:\s{2,}(.*))?$/);
    if (!match) continue;

    const name = match[1].trim();
    const value = match[3] == null ? '' : match[3];
    current.values[name] = value;
  }

  return blocks;
}

function scanEpic() {
  const programData = firstText(process.env.ProgramData, process.env.ProgramDATA, process.env.ALLUSERSPROFILE) ||
    'C:\\ProgramData';
  const manifests = path.win32.join(programData, EPIC_MANIFEST_DIR);

  let entries;
  try {
    entries = fs.readdirSync(manifests);
  } catch (_) {
    return [];
  }

  const out = [];
  for (const entry of entries) {
    if (!/\.item$/i.test(entry)) continue;
    try {
      const raw = fs.readFileSync(path.win32.join(manifests, entry), 'utf8');
      const found = parseEpicManifest(parseJsonText(raw));
      if (found) out.push(found);
    } catch (_) {
      // Unreadable or invalid manifest: skip it, keep scanning the rest.
    }
  }
  return out;
}

function scanGog() {
  const out = [];

  for (const block of parseRegQuery(queryRegistry(GOG_REG_KEY))) {
    const values = block.values;
    const gameId = firstText(values.gameID, values.gameId, values.GameID) ||
      text(block.key.split('\\').pop());
    const gameName = firstText(values.gameName, values.name);
    const installDir = unquote(firstText(values.path, values.installDirectory, values.workingDir));
    const exe = unquote(values.exe);

    if (!gameName || !installDir || !exe) continue;

    const found = parseGogInfo({
      gameId,
      gameName,
      installDirectory: installDir,
      playTasks: [{ isPrimary: true, path: exe }],
    }, installDir);

    if (found) out.push(found);
  }

  return out;
}

function scanUninstall(sourceName, pattern) {
  const out = [];

  for (const root of UNINSTALL_ROOTS) {
    for (const block of parseRegQuery(queryRegistry(root))) {
      const values = block.values;
      const haystack = `${text(values.DisplayName)} ${text(values.Publisher)}`;
      if (!pattern.test(haystack)) continue;

      const found = parseUninstallKey(values, sourceName);
      if (found) out.push(found);
    }
  }

  return out;
}

function scanXbox() {
  const raw = execText('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    XBOX_LIST_COMMAND,
  ], { timeout: 30000 });
  return parseXboxApps(parseJsonText(raw));
}

function dedupe(list) {
  const seen = new Set();
  const out = [];

  for (const item of list) {
    const key = text(item.sourceId || item.exePath || item.name).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }

  return out;
}

// id: 'epic' | 'gog' | 'xbox' | 'battlenet' | 'ea' | 'ubisoft' (aliases ok).
// Off Windows this is always []; on Windows every source is individually
// guarded so one broken launcher/registry read cannot fail the whole scan.
function scanWindowsSource(id) {
  if (process.platform !== 'win32') return [];

  const key = text(id).toLowerCase().replace(/[\s_-]+/g, '');

  try {
    if (key === 'epic' || key === 'epicgames') return dedupe(scanEpic());
    if (key === 'gog' || key === 'gogcom' || key === 'goggalaxy') return dedupe(scanGog());
    if (key === 'xbox' || key === 'gamepass' || key === 'microsoft') return dedupe(scanXbox());

    const registry = REGISTRY_SOURCES[key];
    if (registry) return dedupe(scanUninstall(registry.source, registry.pattern));

    return [];
  } catch (_) {
    return [];
  }
}

module.exports = {
  parseEpicManifest,
  parseGogInfo,
  parseUninstallKey,
  parseXboxApps,
  scanWindowsSource,
};
