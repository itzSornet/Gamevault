'use strict';
// GameVault - platform helpers
//
// Pure(ish) module: no Electron imports, so it can be required from tests and
// from the main process alike. Anything that touches the OS is a small,
// injectable function (readFile/listDir) so behaviour stays testable.

const fs = require('fs');
const path = require('path');

const PLATFORM = process.platform;

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
  if (!dirPath) return [];

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

// Asynchronous, bounded, shallow: background enrichment only.
async function listLaunchableNamesAsync(dirPath, opts) {
  const o = opts || {};
  const maxDepth = o.maxDepth == null ? 2 : o.maxDepth;
  const budget = { left: o.limit || 2000 };
  const found = new Set();
  if (!dirPath) return [];

  const walk = async (dir, depth) => {
    if (depth > maxDepth || budget.left <= 0) return;
    let entries;
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch (e) { return; }
    budget.left -= entries.length;
    const subdirs = [];
    for (const e of entries) {
      if (budget.left <= 0) return;
      if (e.isDirectory()) {
        if (depth < maxDepth && shouldDescend(e.name)) subdirs.push(path.join(dir, e.name));
      } else if (e.isFile() && looksLikeExecutableName(e.name)) {
        if (isLaunchableFile(path.join(dir, e.name))) found.add(e.name.toLowerCase());
      }
    }
    for (const sub of subdirs) await walk(sub, depth + 1);
  };
  await walk(dirPath, 0);
  return [...found];
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
  findProton,
  autostartDesktopEntry,
  parseCliArgs,
  SKIP_NAME_HINTS,
  SYSTEM_TOP_DIRS,
};
