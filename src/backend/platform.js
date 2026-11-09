'use strict';
// GameVault - platform helpers
//
// Pure(ish) module: no Electron imports, so it can be required from tests and
// from the main process alike. Anything that touches the OS is a small,
// injectable function (readFile/listDir) so behaviour stays testable.

const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');

const PLATFORM = process.platform;
const os = require('os');

// Files that are never the game itself.
const SKIP_NAME_HINTS = [
  'unins', 'setup', 'crash', 'redist', 'dxsetup', 'vcredist', 'directx',
  'vc_redist', 'unarc', 'install', 'uninstall', '_commonredist', 'easyanticheat',
  'battleye', 'touchup', 'dotnet', 'physx', 'epicwebhelper', 'unitycrashhandler',
  'crashreport', 'support', 'prerequisites', 'launcher_helper', 'steam_api',
  'steamerrorreporter', 'crashhandler', 'nvngx', 'd3dcompiler',
];

// Pseudo filesystems that never hold games.
const PSEUDO_FS = new Set([
  'proc', 'sysfs', 'devtmpfs', 'devpts', 'tmpfs', 'cgroup', 'cgroup2', 'pstore',
  'bpf', 'debugfs', 'tracefs', 'securityfs', 'configfs', 'fusectl', 'mqueue',
  'hugetlbfs', 'autofs', 'binfmt_misc', 'efivarfs', 'squashfs', 'ramfs',
  'rpc_pipefs', 'nsfs', 'fuse.gvfsd-fuse', 'fuse.portal', 'fuse.snapfuse',
]);

// Top-level directories under "/" that are never worth walking.
const SYSTEM_TOP_DIRS = new Set([
  'usr', 'var', 'etc', 'boot', 'efi', 'proc', 'sys', 'dev', 'run', 'tmp',
  'snap', 'bin', 'sbin', 'lib', 'lib32', 'lib64', 'srv', 'lost+found',
  'nix', 'System', 'Windows',
]);

const ICON_BY_PLATFORM = {
  win32: 'icon.ico',
  darwin: 'icon.icns',
  linux: 'icon.png',
};

function isWindows() { return PLATFORM === 'win32'; }
function isLinux() { return PLATFORM === 'linux'; }

function isWayland() {
  if (PLATFORM !== 'linux') return false;
  return process.env.XDG_SESSION_TYPE === 'wayland' || !!process.env.WAYLAND_DISPLAY;
}

function iconFile() { return ICON_BY_PLATFORM[PLATFORM] || 'icon.png'; }

// ---------------------------------------------------------------------------
// Executable classification
// ---------------------------------------------------------------------------

// Returns 'pe' | 'elf' | 'script' | 'unknown'. Never throws.
function classifyExecutable(filePath, readBytes) {
  const read = readBytes || defaultReadBytes;
  try {
    const buf = read(filePath, 4);
    if (!buf || buf.length < 2) return 'unknown';
    if (buf[0] === 0x4d && buf[1] === 0x5a) return 'pe';               // MZ
    if (buf.length >= 4 && buf[0] === 0x7f && buf[1] === 0x45 &&
        buf[2] === 0x4c && buf[3] === 0x46) return 'elf';              // \x7fELF
    if (buf[0] === 0x23 && buf[1] === 0x21) return 'script';           // #!
  } catch (_) { /* unreadable -> unknown */ }
  return 'unknown';
}

function defaultReadBytes(filePath, n) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(n);
    const read = fs.readSync(fd, buf, 0, n, 0);
    return buf.subarray(0, read);
  } finally {
    fs.closeSync(fd);
  }
}

function hasExecBit(mode) { return (mode & 0o111) !== 0; }

function isSkippedName(name) {
  const lower = String(name).toLowerCase();
  if (/\.(dll|ocx|sys|cpl|drv|scr|mui|pdb)$/.test(lower)) return true;
  return SKIP_NAME_HINTS.some(h => lower.includes(h));
}

// A file that could plausibly be launched as a game.
// `stat` is optional; when supplied it is reused instead of calling fs.statSync.
function isLaunchableFile(filePath, stat) {
  let st = stat;
  try {
    if (!st) st = fs.statSync(filePath);
    if (!st.isFile()) return false;
  } catch (_) {
    return false;
  }
  if (isSkippedName(path.basename(filePath))) return false;

  const kind = classifyExecutable(filePath);

  if (kind === 'pe') {
    // Windows binaries are launchable through Wine even without the exec bit
    // (fuse/NTFS mounts ignore chmod), so only the size guard applies.
    return st.size >= 10 * 1024;
  }
  if (kind === 'elf') {
    if (PLATFORM !== 'linux') return false;
    return hasExecBit(st.mode) && st.size >= 10 * 1024;
  }
  if (kind === 'script') {
    if (PLATFORM !== 'linux') return false;
    const base = path.basename(filePath).toLowerCase();
    const looksLikeLauncher = /^(start|run|launch|play|game|gamevault).*\.sh$/.test(base);
    return hasExecBit(st.mode) && (looksLikeLauncher || st.size >= 1024);
  }
  return false;
}


// ---------------------------------------------------------------------------
// Bounded executable discovery
// ---------------------------------------------------------------------------
//
// Enumerating a game folder must never block the UI. These walkers cap the
// number of entries they visit and skip backup/audio/live-service directories,
// which is what made a boot-time full walk take minutes on a spinning disk.

const ENUM_SKIP_DIRS = [
  'node_modules', '.git', '__pycache__', '_commonredist', 'redist', 'directx',
  'support', 'installer', 'install', 'prerequisites', 'crashpad',
  'easyanticheat', 'battleye', 'touchup', '_backups', 'backup', '_ost',
  'soundtrack', 'movies', 'video', 'screenshots', 'logs', 'logs_backup',
];

function looksLikeExecutableName(name) {
  const lower = String(name).toLowerCase();
  if (isSkippedName(lower)) return false;
  if (lower.endsWith('.exe')) return true;
  if (PLATFORM === 'win32') return false;
  if (lower.endsWith('.sh') || lower.endsWith('.appimage')) return true;
  if (lower.includes('.')) return false;  // png, dll, dylib, json, ...
  return true;                            // extensionless native binary
}

function shouldDescend(name) {
  const lower = String(name).toLowerCase();
  return !ENUM_SKIP_DIRS.some(d => lower.includes(d));
}

// Synchronous, bounded. Used only for user-initiated actions (Stop fallback).
function listLaunchableNamesSync(dirPath, opts) {
  const o = opts || {};
  const maxDepth = o.maxDepth == null ? 4 : o.maxDepth;
  const budget = { left: o.limit || 3000 };
  const found = new Set();
  if (!dirPath || isSharedSystemDir(dirPath)) return [];

  const scan = (dir, depth) => {
    if (depth > maxDepth || budget.left <= 0) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    budget.left -= entries.length;
    for (const e of entries) {
      if (budget.left <= 0) return;
      if (e.isDirectory()) {
        if (depth < maxDepth && shouldDescend(e.name)) scan(path.join(dir, e.name), depth + 1);
      } else if (e.isFile() && looksLikeExecutableName(e.name)) {
        if (isLaunchableFile(path.join(dir, e.name))) found.add(e.name.toLowerCase());
      }
    }
  };
  scan(dirPath, 0);
  return [...found];
}

// Asynchronous, bounded: background enrichment only. Breadth-first, so the
// entry budget is spent on shallow folders before a deep content tree can
// eat it (CS2 keeps its exe at game\bin\win64\cs2.exe).
async function listLaunchableNamesAsync(dirPath, opts) {
  const o = opts || {};
  const maxDepth = o.maxDepth == null ? 2 : o.maxDepth;
  const budget = { left: o.limit || 2000 };
  const found = new Set();
  if (!dirPath || isSharedSystemDir(dirPath)) return [];

  let level = [dirPath];
  for (let depth = 0; depth <= maxDepth && level.length && budget.left > 0; depth++) {
    const next = [];
    for (const dir of level) {
      if (budget.left <= 0) break;
      let entries;
      try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch (e) { continue; }
      budget.left -= entries.length;
      for (const e of entries) {
        if (e.isDirectory()) {
          if (depth < maxDepth && shouldDescend(e.name)) next.push(path.join(dir, e.name));
        } else if (e.isFile() && looksLikeExecutableName(e.name)) {
          if (isLaunchableFile(path.join(dir, e.name))) found.add(e.name.toLowerCase());
        }
      }
    }
    level = next;
  }
  return [...found];
}

// ---------------------------------------------------------------------------
// Helper processes (tasklist, taskkill, reg, powershell, ...)
// ---------------------------------------------------------------------------
//
// Always execFile (no cmd.exe in between) with windowsHide, so a packaged GUI
// build never flashes a console window over a fullscreen game. Never use these
// for launching games: those must stay visible.

function helperOptions(o) {
  return {
    windowsHide: true,
    timeout: o.timeout || 5000,
    encoding: o.encoding || 'utf8',
    maxBuffer: o.maxBuffer || 16 * 1024 * 1024,
    ...(o.cwd ? { cwd: o.cwd } : {}),
    ...(o.env ? { env: o.env } : {}),
  };
}

// Resolves { ok, stdout, stderr, code }. Never rejects.
function runHelper(cmd, args, opts) {
  const o = opts || {};
  const run = o.execFile || childProcess.execFile;
  return new Promise((resolve) => {
    try {
      run(cmd, args || [], helperOptions(o), (err, stdout, stderr) => {
        resolve({
          ok: !err,
          stdout: stdout == null ? '' : String(stdout),
          stderr: stderr == null ? '' : String(stderr),
          code: err ? (typeof err.code === 'number' ? err.code : -1) : 0,
        });
      });
    } catch (e) {
      resolve({ ok: false, stdout: '', stderr: e.message, code: -1 });
    }
  });
}

// Synchronous variant for the few callers that cannot await. Returns stdout,
// or '' on any failure.
function runHelperSync(cmd, args, opts) {
  const o = opts || {};
  const run = o.execFileSync || childProcess.execFileSync;
  try {
    const out = run(cmd, args || [], helperOptions(o));
    return out == null ? '' : String(out);
  } catch (_) {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Process matching (Windows)
// ---------------------------------------------------------------------------

// One CSV record -> fields. Handles quoted fields with embedded commas
// ("12,345 K") and doubled quotes.
function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else quoted = false;
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

// `tasklist /NH /FO CSV` output -> { byName: Map<lowerImage, pid[]>, byPid: Map<pid, lowerImage> }
function parseTasklistCsv(text) {
  const byName = new Map();
  const byPid = new Map();
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line[0] !== '"') continue; // "INFO: No tasks are running..." etc.
    const fields = parseCsvLine(line);
    if (fields.length < 2) continue;
    const name = fields[0].trim().toLowerCase();
    const pid = Number(fields[1]);
    if (!name || !Number.isInteger(pid) || pid <= 0) continue;
    if (!byName.has(name)) byName.set(name, []);
    byName.get(name).push(pid);
    byPid.set(pid, name);
  }
  return { byName, byPid };
}

// Exact, case-insensitive image-name matching. Returns the matching PIDs.
function pidsForNames(snapshot, names) {
  const pids = [];
  if (!snapshot || !snapshot.byName || !names) return pids;
  for (const n of new Set(names.map((x) => String(x).toLowerCase()))) {
    if (isProtectedProcessName(n)) continue;
    const hit = snapshot.byName.get(n);
    if (hit) pids.push(...hit);
  }
  return pids;
}

// Snapshot of running Windows processes, or null when tasklist failed.
async function listWindowsProcesses(opts) {
  const res = await runHelper('tasklist.exe', ['/NH', '/FO', 'CSV'], { timeout: 5000, ...(opts || {}) });
  if (!res.ok || !res.stdout) return null;
  return parseTasklistCsv(res.stdout);
}

// Runtimes and system tools that games often ship next to their own exe.
// Discovered in an install folder, they would match unrelated processes.
const GENERIC_PROCESS_NAMES = new Set([
  'java.exe', 'javaw.exe', 'python.exe', 'pythonw.exe', 'node.exe', 'cmd.exe',
  'powershell.exe', 'pwsh.exe', 'conhost.exe', 'explorer.exe', 'rundll32.exe',
  'msiexec.exe', 'steam.exe', 'steamwebhelper.exe', 'steamservice.exe',
  'crashpad_handler.exe', 'cefsharp.browsersubprocess.exe', 'qtwebengineprocess.exe',
  'notepad.exe', 'wscript.exe', 'cscript.exe',
]);

function isGenericProcessName(name) {
  return GENERIC_PROCESS_NAMES.has(String(name || '').toLowerCase());
}

// Processes GameVault must never treat as a game, and never kill. Killing
// lsass/csrss/wininit makes Windows restart on the spot.
const PROTECTED_PROCESS_NAMES = new Set([
  // Windows core
  'system', 'registry', 'smss.exe', 'csrss.exe', 'wininit.exe', 'winlogon.exe',
  'services.exe', 'lsass.exe', 'lsaiso.exe', 'svchost.exe', 'fontdrvhost.exe',
  'dwm.exe', 'memory compression', 'secure system', 'lsm.exe', 'spoolsv.exe',
  'audiodg.exe', 'wudfhost.exe', 'dllhost.exe', 'sihost.exe', 'taskhostw.exe',
  'ctfmon.exe', 'runtimebroker.exe', 'searchhost.exe', 'searchindexer.exe',
  'startmenuexperiencehost.exe', 'shellexperiencehost.exe', 'textinputhost.exe',
  'explorer.exe', 'conhost.exe', 'msmpeng.exe', 'nissrv.exe',
  'securityhealthservice.exe', 'securityhealthsystray.exe', 'smartscreen.exe',
  'wmiprvse.exe', 'taskmgr.exe', 'userinit.exe', 'logonui.exe', 'consent.exe',
  // ourselves
  'electron.exe', 'gamevault.exe', 'gamevault experimental.exe',
  // Linux core
  'systemd', 'init', 'xorg', 'xwayland', 'gnome-shell', 'kwin_wayland', 'kwin_x11',
  'plasmashell', 'pipewire', 'pulseaudio', 'dbus-daemon', 'sddm', 'gdm', 'electron', 'gamevault',
]);

// Store launchers and their helpers. Opening Steam or Epic is not playing a
// game, so in "auto" tracking these never count (a user can still pick one
// explicitly as a game's track exe). Also the generic "launcher.exe" wrappers
// many games ship: they start the real game and exit.
const LAUNCHER_PROCESS_NAMES = new Set([
  'steam.exe', 'steamwebhelper.exe', 'steamservice.exe', 'steamerrorreporter.exe',
  'epicgameslauncher.exe', 'epicwebhelper.exe', 'epiconlineservices.exe', 'eosoverlayrenderer-win64-shipping.exe',
  'galaxyclient.exe', 'galaxyclient helper.exe', 'galaxycommunication.exe',
  'battle.net.exe', 'battle.net helper.exe',
  'eadesktop.exe', 'eabackgroundservice.exe', 'origin.exe', 'originwebhelperservice.exe',
  'ubisoftconnect.exe', 'upc.exe', 'uplaywebcore.exe', 'ubisoftgamelauncher.exe', 'ubisoftgamelauncher64.exe',
  'rockstarlauncher.exe', 'socialclubhelper.exe', 'xboxpcapp.exe', 'gamingservices.exe',
  'heroic.exe', 'playnite.desktopapp.exe', 'playnite.fullscreenapp.exe', 'itch.exe',
  'launcher.exe', 'gamelauncher.exe', 'unitycrashhandler64.exe', 'unitycrashhandler32.exe', 'crashreportclient.exe',
  // Linux
  'steam', 'steamwebhelper', 'lutris', 'heroic', 'bottles', 'itch',
]);

function isLauncherProcessName(name) {
  return LAUNCHER_PROCESS_NAMES.has(String(name || '').trim().toLowerCase());
}

function isProtectedProcessName(name) {
  return PROTECTED_PROCESS_NAMES.has(String(name || '').trim().toLowerCase());
}

// Folders that hold far more than one game. Walking them for "the game's
// executables" would sweep up system and unrelated programs (System32 contains
// lsass.exe), so tracking/killing never enumerates them.
function isSharedSystemDir(dir) {
  if (!dir) return true;
  let d;
  try { d = path.resolve(String(dir)); } catch (_) { return true; }
  const norm = (x) => path.resolve(x).replace(/[\\/]+$/, '').toLowerCase();
  const nd = norm(d);
  if (PLATFORM === 'win32') {
    if (/^[a-z]:$/.test(nd) || /^\\\\[^\\]+\\[^\\]+$/.test(nd)) return true; // drive or share root
    const winDir = norm(process.env.SystemRoot || process.env.windir || 'C:\\Windows');
    if (nd === winDir || nd.startsWith(winDir + '\\')) return true;
    const home = process.env.USERPROFILE || os.homedir();
    const exact = [
      process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.ProgramW6432,
      process.env.ProgramData, process.env.APPDATA, process.env.LOCALAPPDATA,
      home, home && path.join(home, 'Desktop'), home && path.join(home, 'Downloads'),
      home && path.join(home, 'Documents'), home && path.join(home, 'AppData'),
    ].filter(Boolean).map(norm);
    return exact.includes(nd);
  }
  if (nd === '/') return true;
  if (['/usr', '/bin', '/sbin', '/lib', '/lib64', '/etc', '/boot', '/proc', '/sys', '/dev', '/run'].some((s) => nd === s || nd.startsWith(s + '/'))) return true;
  const home = os.homedir();
  return [home, '/opt', '/usr/local', '/home', home && path.join(home, 'Desktop'), home && path.join(home, 'Downloads')]
    .filter(Boolean).map(norm).includes(nd);
}

// ---------------------------------------------------------------------------
// Launch targets
// ---------------------------------------------------------------------------

// Launcher URIs (steam://, com.epicgames.launcher://, uplay://, origin2://,
// battlenet://, heroic://, lutris:rungameid/...). Never file:, javascript:,
// data: or a Windows drive letter.
function isLaunchUri(value) {
  const s = String(value || '').trim();
  const m = s.match(/^([a-z][a-z0-9+.-]+):/i);
  if (!m) return false;
  const scheme = m[1].toLowerCase();
  if (scheme === 'file' || scheme === 'javascript' || scheme === 'data' || scheme === 'vbscript' || scheme === 'shell') return false;
  if (s.slice(m[0].length).startsWith('//')) return true;
  return scheme === 'lutris' || scheme === 'steam';
}

// Xbox / AppX entries: shell:AppsFolder\<PackageFamily>!App. Never on disk.
function isShellAppsFolder(value) {
  return /^shell:appsfolder\\/i.test(String(value || '').trim());
}

// A real filesystem path (not a URI or shell: moniker).
function isFilesystemPath(value) {
  const s = String(value || '');
  return !!s && !isLaunchUri(s) && !/^shell:/i.test(s) && path.isAbsolute(s);
}

// "steam://rungameid/730" / "steam://run/730" -> "730"
function steamAppIdFromUri(value) {
  const m = String(value || '').match(/^steam:\/\/(?:rungameid|run|launch)\/(\d+)/i);
  return m ? m[1] : '';
}

// Body of a .url InternetShortcut -> the URL= value.
function parseInternetShortcut(text) {
  const m = String(text || '').match(/^\s*URL\s*=\s*(.+?)\s*$/im);
  return m ? m[1] : '';
}

// `reg query HKCU\Software\Valve\Steam /v RunningAppID` -> number (0 = none)
function parseRunningAppId(regText) {
  const m = String(regText || '').match(/RunningAppID\s+REG_DWORD\s+(0x[0-9a-f]+|\d+)/i);
  if (!m) return 0;
  return Number(m[1]) || 0;
}

// ---------------------------------------------------------------------------
// Mounts
// ---------------------------------------------------------------------------

function decodeMountPath(p) {
  return p
    .replace(/\\040/g, ' ')
    .replace(/\\011/g, '\t')
    .replace(/\\012/g, '\n')
    .replace(/\\134/g, '\\');
}

function parseMounts(text) {
  const out = [];
  if (!text) return out;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 4) continue;
    const [device, mountpoint, fstype, opts] = parts;
    if (PSEUDO_FS.has(fstype)) continue;
    const mp = decodeMountPath(mountpoint);
    if (mp === '/proc' || mp === '/sys' || mp === '/dev' ||
        mp.startsWith('/proc/') || mp.startsWith('/sys/') || mp.startsWith('/dev/')) continue;
    out.push({ device, mountpoint: mp, fstype, options: opts.split(',') });
  }
  return out;
}

function isUnder(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

// Directories worth walking for games. Deliberately excludes "/": the root
// filesystem is a distro partition, and walking it costs minutes for nothing.
function linuxScanRoots(env, mountsText, exists) {
  const existsFn = exists || fs.existsSync;
  const roots = [];
  const add = (p) => {
    if (!p) return;
    if (roots.some(r => isUnder(p, r))) return;
    roots.push(p);
  };

  const home = (env && env.HOME) || '';
  if (home && existsFn(home)) add(home);
  for (const cand of ['/mnt', '/media', '/run/media', '/opt', '/games', '/data', '/storage']) {
    if (existsFn(cand)) add(cand);
  }
  for (const m of parseMounts(mountsText)) {
    if (m.mountpoint === '/') continue;
    if (roots.some(r => isUnder(m.mountpoint, r))) continue;
    if (SYSTEM_TOP_DIRS.has(m.mountpoint.replace(/^\//, '').split('/')[0])) continue;
    add(m.mountpoint);
  }
  return roots;
}

function isNoExecMount(filePath, mountsText) {
  const mounts = parseMounts(mountsText);
  let best = null;
  for (const m of mounts) {
    if (isUnder(filePath, m.mountpoint)) {
      if (!best || m.mountpoint.length > best.mountpoint.length) best = m;
    }
  }
  return !!best && best.options.includes('noexec');
}

// ---------------------------------------------------------------------------
// Runner selection
// ---------------------------------------------------------------------------

// requested: 'auto' | 'native' | 'wine' | 'proton' | 'steam'
// ctx: { kind, hasWine, hasProton, platform }
function pickRunner(requested, ctx) {
  const req = requested || 'auto';
  const kind = (ctx && ctx.kind) || 'unknown';
  const os = (ctx && ctx.platform) || PLATFORM;
  if (req !== 'auto') return req;
  // Windows runs its own binaries directly; never route them through Wine.
  if (os === 'win32') return 'native';
  if (kind === 'pe') {
    if (ctx && ctx.hasProton) return 'proton';
    if (ctx && ctx.hasWine) return 'wine';
    return 'unavailable';
  }
  return 'native';
}

// Snapshot of running processes on Linux, read straight from /proc.
// Each entry: { pid, comm, exeBase, cmdTokens } — enough to identify a game
// whether it runs natively, under Wine, or under Proton.
function readLinuxProcesses() {
  const out = [];
  let entries;
  try { entries = fs.readdirSync('/proc'); } catch (e) { return out; }

  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    if (pid === process.pid) continue;

    const base = '/proc/' + entry;
    const proc = { pid, comm: '', exeBase: '', cmdTokens: [] };

    try { proc.comm = fs.readFileSync(base + '/comm', 'utf-8').trim(); } catch (e) {}
    try { proc.exeBase = path.basename(fs.readlinkSync(base + '/exe')); } catch (e) {}
    try {
      const raw = fs.readFileSync(base + '/cmdline', 'utf-8');
      proc.cmdTokens = raw.split('\0').filter(Boolean);
    } catch (e) {}

    if (proc.comm || proc.exeBase || proc.cmdTokens.length) out.push(proc);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Process matching (Linux)
// ---------------------------------------------------------------------------

// proc: { comm, exeBase, cmdTokens: string[] }
// names: lower-case executable basenames that belong to the game
function matchesGameProcess(proc, names) {
  if (!proc || !names || !names.length) return false;
  const wanted = new Set(names.map(n => String(n).toLowerCase()));
  if (proc.comm && wanted.has(String(proc.comm).toLowerCase())) return true;
  if (proc.exeBase && wanted.has(String(proc.exeBase).toLowerCase())) return true;
  for (const tok of proc.cmdTokens || []) {
    const base = String(tok).split(/[\\/]/).pop().toLowerCase();
    if (wanted.has(base)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Proton discovery (Linux)
// ---------------------------------------------------------------------------

// Looks for a Proton build in the usual Steam locations and
// compatibilitytools.d (GE-Proton). Returns the path to the `proton` script,
// or '' when nothing is installed. `fsLike` lets tests inject a fake fs.
function findProton(home, fsLike) {
  const f = fsLike || fs;
  const homeDir = home || process.env.HOME || '';
  if (!homeDir) return '';
  const steamRoots = [
    path.join(homeDir, '.steam', 'steam'),
    path.join(homeDir, '.local', 'share', 'Steam'),
    path.join(homeDir, '.steam', 'root'),
  ];

  const candidates = [];
  for (const root of steamRoots) {
    const common = path.join(root, 'steamapps', 'common');
    try {
      for (const name of f.readdirSync(common)) {
        if (!/^Proton/i.test(name)) continue;
        candidates.push(path.join(common, name, 'proton'));
      }
    } catch (_) { /* no such library */ }

    const tools = path.join(root, 'compatibilitytools.d');
    try {
      for (const name of f.readdirSync(tools)) {
        candidates.push(path.join(tools, name, 'proton'));
      }
    } catch (_) { /* no compatibility tools */ }
  }

  // Prefer a named build over "Proton - Experimental"? Keep it deterministic:
  // Experimental first (it is the safest default), then GE builds.
  candidates.sort((a, b) => {
    const weight = (p) => (/experimental/i.test(p) ? 0 : /^.*compatibilitytools/.test(p) ? 1 : 2);
    return weight(a) - weight(b) || a.localeCompare(b);
  });

  for (const cand of candidates) {
    try { if (f.existsSync(cand)) return cand; } catch (_) {}
  }
  return '';
}

// ---------------------------------------------------------------------------
// Autostart (XDG)
// ---------------------------------------------------------------------------

function autostartDesktopEntry(execPathOrCommand, args) {
  const argsList = Array.isArray(args) ? args : ['--hidden'];
  const exec = [execPathOrCommand, ...argsList]
    .map(a => (/\s/.test(a) ? `"${a}"` : a))
    .join(' ');
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Name=GameVault',
    'Comment=Game library manager, launcher and playtime tracker',
    `Exec=${exec}`,
    'Terminal=false',
    'X-GNOME-Autostart-enabled=true',
    'Hidden=false',
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseCliArgs(argv) {
  const args = Array.isArray(argv) ? argv.slice(1) : [];
  return {
    toggleOverlay: args.includes('--toggle-overlay'),
    show: args.includes('--show'),
    hidden: args.includes('--hidden'),
  };
}

module.exports = {
  PLATFORM,
  isWindows,
  isLinux,
  isWayland,
  iconFile,
  classifyExecutable,
  hasExecBit,
  isSkippedName,
  isLaunchableFile,
  listLaunchableNamesSync,
  listLaunchableNamesAsync,
  parseMounts,
  linuxScanRoots,
  isNoExecMount,
  isUnder,
  pickRunner,
  matchesGameProcess,
  readLinuxProcesses,
  runHelper,
  runHelperSync,
  parseCsvLine,
  parseTasklistCsv,
  pidsForNames,
  listWindowsProcesses,
  isGenericProcessName,
  isProtectedProcessName,
  isLauncherProcessName,
  isSharedSystemDir,
  isLaunchUri,
  isShellAppsFolder,
  isFilesystemPath,
  steamAppIdFromUri,
  parseInternetShortcut,
  parseRunningAppId,
  findProton,
  autostartDesktopEntry,
  parseCliArgs,
  SKIP_NAME_HINTS,
  SYSTEM_TOP_DIRS,
};
