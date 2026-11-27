'use strict';
// GameVault 2.0 — Windows This PC inventory.
// Parsers are pure (fixture-testable on any OS). scanWindowsInventory() is the
// only OS-aware entry point: [] off Windows, with per-command guards on Windows
// so one denied key or broken PowerShell can only cost that source.
const { execFileSync } = require('child_process');

const UNINSTALL_ROOTS = [
  'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
];
const EXEC_OPTIONS = { encoding: 'utf8', timeout: 20000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 };
// Installing tooling, not games. "uninstall" is absent because every game has
// it in UninstallString; that field is checked separately for updater exes.
const TOOL_RE = /(updater|\bupdate\b|hotfix|redistributable|\bredist\b|run\s?time|vulkan|openal|vcredist|visual c\+\+|\.net\b|directx|physx|\bdriver\b|launcher|rockstar games social club|gog galaxy|ubisoft connect|\bea app\b|battle\.?net|\bsteam\b|sdk|service|helper|crash reporter|diagnostic|installer|setup|anti-?cheat|battleye|dedicated server|benchmark|mod manager|nvidia|\bamd\b|advanced micro devices|intel corporation|realtek|chrome|firefox|adobe|\boffice\b|visual studio|spotify|discord)/i;
const UPDATE_RELEASE_RE = /update|hotfix|security|service pack|patch/i;
const UPDATER_EXE_RE = /(updater|update|patch|setup)\.exe\b/i;
// Microsoft Appx packages must opt in by game name; other Microsoft packages
// are shell/store/runtime pieces. Third-party apps are caught by APPX_APP_RE.
const APPX_SYSTEM_RE = /(?:^|\.)(windows|windowsstore|storepurchaseapp|desktopappinstaller|store|vclibs|net|ui|xaml|shell|codec|webmedia|winget|office|edge|teams|skype|onedrive|photos|calculator|weather|maps|news|people|mail|calendar|camera|alarms|soundrecorder|sticky|paint|notepad|snipping|terminal|powershell|remote|phone|mixedreality|microsoft3d|print3d|gethelp|tips|feedback|xbox|gamebar|gamingservices|gamingapp|cortana|bing|visualstudio|azure|devhome|whiteboard|journal|todo|lens|powerautomate|clipchamp)(?:\.|_|$)/i;
const APPX_APP_RE = /(spotify|netflix|hulu|plex|whatsapp|facebook|instagram|tiktok|twitter|slack|discord|zoom|dropbox|evernote|kindle|audible|itunes|\bvlc\b|adobe|canon|hewlett|dell|lenovo|realtek|\bnvidia\b|amazonvideo|disney|primevideo|youtube|twitch|reddit|linkedin|outlook|microsoft365|office|teams|onenote|skype|launcher|\bsteam\b|battle\.?net|gog galaxy|ubisoft connect)/i;
const APPX_GAME_RE = /(forza|minecraft|halo|seaofthieves|gearsofwar|\bgears\b|ageofempires|flightsimulator|stateofdecay|oriand|sunsetoverdrive|quantumbreak|recore|ryse|crackdown|killerinstinct|zootycoon|disneyland|solitaire|mahjong|jigsaw|wordament|bubblewitch|minesweeper|sudoku|asphalt|roblox|amongus|callofduty|doom|wolfenstein|starfield|grounded|pentiment|psychonauts|bleedingedge|hi-?fi|overwatch|diablo)/i;
const APPX_COMMAND = '[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-AppxPackage -PackageTypeFilter Main | ForEach-Object { "$($_.Name)|$($_.PackageFullName)|$($_.PackageFamilyName)|$($_.Publisher)" }';
const text = (value) => (value == null ? '' : String(value).trim());
const unquote = (value) => { const out = text(value); return out.length >= 2 && out.startsWith('"') && out.endsWith('"') ? out.slice(1, -1).trim() : out; };
const regInt = (value) => { const raw = text(value); const out = /^0x/i.test(raw) ? parseInt(raw.slice(2), 16) : parseInt(raw, 10); return Number.isFinite(out) ? out : 0; };
// "C:\Game\game.exe",0 / @C:\Game\game.exe,-1 / C:\Game\icon.ico -> plain path.
function iconTarget(value) {
  const out = text(value).replace(/^@/, '');
  if (!out.startsWith('"')) return out.replace(/,\s*-?\d+\s*$/, '').trim();
  const end = out.indexOf('"', 1);
  return (end > 0 ? out.slice(1, end) : out.slice(1)).trim();
}
function appxDisplayName(packageName) {
  return text(packageName).split('.').pop().replace(/[._-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/([A-Za-z])(\d)/g, '$1 $2').replace(/(\d)([A-Za-z])/g, '$1 $2').replace(/\s+/g, ' ').trim();
}
const candidate = (fields) => ({
  name: fields.name, source: fields.source, sourceId: fields.sourceId, exePath: fields.exePath || '', installDir: fields.installDir || '', iconPath: fields.iconPath || '', publisher: fields.publisher || '', confidence: fields.confidence, launcher: fields.launcher || null,
});
function uninstallCandidate(key, values) {
  const name = text(values.displayname);
  if (!name) return null;
  const publisher = text(values.publisher);
  const releaseType = text(values.releasetype);
  const icon = iconTarget(values.displayicon);
  const installDir = unquote(values.installlocation);
  const exePath = /\.exe$/i.test(icon) ? icon : '';
  const sizeKb = regInt(values.estimatedsize);
  if (regInt(values.systemcomponent) === 1) return null;
  if (UPDATE_RELEASE_RE.test(releaseType)) return null;
  if (text(values.parentkeyname) || text(values.parentdisplayname)) return null;
  if (UPDATER_EXE_RE.test(text(values.uninstallstring))) return null;
  if (TOOL_RE.test(`${name} ${publisher} ${releaseType}`)) return null;
  if (!exePath && !installDir) return null;
  if (!exePath && sizeKb > 0 && sizeKb < 512) return null; // leftover helper key
  return candidate({ name, source: 'This PC', sourceId: `winreg:${key.toLowerCase()}`, exePath, installDir, iconPath: /\.(ico|png|jpe?g)$/i.test(icon) ? icon : '', publisher, confidence: exePath ? 0.85 : 0.7, launcher: null });
}
// Each HKEY_ line starts a key; indented "Name  REG_TYPE  Data" lines are its
// values, and /s output nests many keys below the queried root.
function parseUninstallRegistry(regQueryText) {
  const out = [];
  let key = '';
  let values = {};
  const flush = () => { const found = key && uninstallCandidate(key, values); if (found) out.push(found); };
  for (const line of String(regQueryText || '').replace(/^\uFEFF/, '').split(/\r?\n/)) {
    if (/^\s*HKEY_/i.test(line)) {
      flush();
      key = line.trim();
      values = {};
      continue;
    }
    const match = line.match(/^\s+(.+?)\s{2,}(REG_[A-Z0-9_]+)(?:\s{2,}(.*))?$/);
    if (!key || !match) continue;
    values[match[1].trim().toLowerCase()] = match[3] == null ? '' : match[3].trim();
  }
  flush();
  return out;
}
function appxIsGame(record) {
  const name = text(record.name);
  const family = text(record.family);
  if (!name || !family || !name.includes('.')) return false;
  if (APPX_SYSTEM_RE.test(name) || APPX_APP_RE.test(name)) return false;
  if (/microsoft corporation/i.test(text(record.publisher))) return APPX_GAME_RE.test(name);
  return true;
}
function appxCandidate(record) {
  if (!appxIsGame(record)) return null;
  const family = text(record.family);
  return candidate({ name: appxDisplayName(record.name), source: 'Xbox', sourceId: `xbox:${family}`, exePath: `shell:AppsFolder\\${family}!App`, publisher: text(record.publisher), confidence: 0.9, launcher: 'Xbox' });
}
// Accepts "Name : value" blocks (Format-List) and the pipe rows emitted by
// scanWindowsInventory's ForEach-Object command.
function parseAppxList(raw) {
  const out = [];
  let record = null;
  const flush = () => { const found = record && appxCandidate(record); if (found) out.push(found); record = null; };
  for (const line of String(raw || '').replace(/^\uFEFF/, '').split(/\r?\n/)) {
    if (!line.trim()) {
      flush();
      continue;
    }
    const labeled = line.match(/^\s*(Name|PackageFullName|PackageFamilyName|Publisher)\s*:\s*(.*)$/i);
    if (labeled) {
      const field = labeled[1].toLowerCase();
      if (field === 'name' && record && record.name) flush();
      record = record || {};
      const alias = field === 'packagefullname' ? 'full' : field === 'packagefamilyname' ? 'family' : field;
      record[alias] = labeled[2].trim();
      continue;
    }
    const cells = line.split('|');
    if (cells.length < 4) continue;
    flush();
    record = { name: cells[0].trim(), full: cells[1].trim(), family: cells[2].trim(), publisher: cells.slice(3).join('|').trim() };
  }
  flush();
  return out;
}
function readCString(buffer, state) {
  const end = buffer.indexOf(0, state.pos);
  if (end === -1) throw new Error('unterminated VDF string');
  const value = buffer.toString('utf8', state.pos, end);
  state.pos = end + 1;
  return value;
}
// Map body: entries until 0x08. Each entry is type + key; maps (0x00) recurse,
// strings (0x01) and int32s (0x02) carry their value after the key.
function readVdfMap(buffer, state) {
  const map = {};
  while (state.pos < buffer.length) {
    const type = buffer[state.pos++];
    if (type === 0x08) return map;
    const key = readCString(buffer, state);
    if (type === 0x00) map[key] = readVdfMap(buffer, state);
    else if (type === 0x01) map[key] = readCString(buffer, state);
    else if (type === 0x02) {
      if (state.pos + 4 > buffer.length) throw new Error('truncated VDF int32');
      map[key] = buffer.readInt32LE(state.pos);
      state.pos += 4;
    } else throw new Error(`unsupported VDF type ${type}`);
  }
  throw new Error('unterminated VDF map');
}
function parseShortcutsVdf(buffer) {
  try {
    if (!buffer) return [];
    const data = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
    const state = { pos: 1 };
    if (data.length < 2 || data[0] !== 0x00 || readCString(data, state) !== 'shortcuts') return [];
    const shortcuts = readVdfMap(data, state);
    if (!shortcuts || typeof shortcuts !== 'object' || Array.isArray(shortcuts)) return [];
    const out = [];
    for (const [key, entry] of Object.entries(shortcuts)) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
      const name = text(entry.AppName || entry.appname);
      const exePath = unquote(entry.Exe || entry.exe);
      if (!name || !exePath) continue;
      const appid = Number(entry.appid || entry.AppId);
      out.push(candidate({ name, source: 'Steam', sourceId: `steam-shortcut:${Number.isInteger(appid) && appid !== 0 ? appid : key}`, exePath, installDir: unquote(entry.StartDir || entry.startdir), iconPath: text(entry.icon || entry.Icon), confidence: 0.8, launcher: 'Steam' }));
    }
    return out;
  } catch (_) {
    return [];
  }
}
function normalizePath(value) {
  return text(value).replace(/^"+|"+$/g, '').replace(/\//g, '\\')
    .replace(/\\+/g, '\\').replace(/\\+$/, '').toLowerCase();
}
// Stable identity for scan de-duplication: exe first, then install dir, then id.
function dedupeKey(app) {
  if (!app || typeof app !== 'object') return '';
  const exe = normalizePath(app.exePath);
  if (exe) return `exe:${exe}`;
  const dir = normalizePath(app.installDir);
  if (dir) return `dir:${dir}`;
  const id = text(app.sourceId || app.name).toLowerCase();
  return id ? `id:${id}` : '';
}
function dedupe(list) {
  const seen = new Set();
  const out = [];
  for (const app of list) {
    const key = dedupeKey(app);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(app);
  }
  return out;
}
function execText(exec, command, args) { try { return String(exec(command, args, EXEC_OPTIONS) || ''); } catch (_) { return ''; } }
// Off Windows this is [] without touching the environment. On Windows every
// command is isolated, so partial inventory is still returned.
function scanWindowsInventory(io) {
  if (process.platform !== 'win32') return [];
  const options = io && typeof io === 'object' ? io : {};
  const exec = typeof options.execFileSync === 'function' ? options.execFileSync : execFileSync;
  const found = [];
  for (const root of UNINSTALL_ROOTS) {
    try {
      found.push(...parseUninstallRegistry(execText(exec, 'reg.exe', ['query', root, '/s'])));
    } catch (_) {
      // Keep scanning the other hives.
    }
  }
  try {
    const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', APPX_COMMAND];
    found.push(...parseAppxList(execText(exec, 'powershell.exe', args)));
  } catch (_) {
    // PowerShell denied/locked down: registry results still count.
  }
  return dedupe(found);
}
module.exports = { parseUninstallRegistry, parseAppxList, parseShortcutsVdf, scanWindowsInventory, dedupeKey };
