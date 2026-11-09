const fs = require('fs');
const path = require('path');
const { resolveSteamInstallDir, findMainExe } = require('./scanner.js');
const platform = require('./platform.js');

let trackerWin = null;
function setTrackerWindow(w) { trackerWin = w; win = w; }

// Process tracking
let trackedProcesses = {};
let win = null;
let overlayWin = null;
let loopTimer = null;
let isChecking = false;

// Poll fast while a game is launching or running, slowly otherwise: every
// library game is registered at boot, and a 3 s tasklist forever is waste.
const FAST_POLL_MS = 3000;
const SLOW_POLL_MS = 15000;
const LAUNCH_GRACE_MS = 5 * 60 * 1000;

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function isPending(t, now) {
  return !!(t && !t.running && t.launchedAt && (now - t.launchedAt) < LAUNCH_GRACE_MS);
}

function nextPollDelay() {
  const now = Date.now();
  return Object.values(trackedProcesses).some((t) => t.running || isPending(t, now)) ? FAST_POLL_MS : SLOW_POLL_MS;
}

function scheduleLoop(delay) {
  if (loopTimer) { clearTimeout(loopTimer); loopTimer = null; }
  if (Object.keys(trackedProcesses).length === 0) return;
  loopTimer = setTimeout(async () => {
    loopTimer = null;
    await checkAllTrackedProcesses();
    if (!loopTimer) scheduleLoop(nextPollDelay());
  }, delay);
  if (loopTimer.unref) loopTimer.unref();
}

function stopLoop() {
  if (loopTimer) { clearTimeout(loopTimer); loopTimer = null; }
}

// Executable names found in a game's install directory. Bounded so a big
// tree (node_modules, backups, a 30k-file game) can never block the main
// thread — see platform.listLaunchableNamesSync.
function collectGameExes(dirPath, opts) {
  if (!dirPath || !fs.existsSync(dirPath)) return [];
  return platform.listLaunchableNamesSync(dirPath, opts);
}

// Steam's own idea of what is running (HKCU\Software\Valve\Steam\RunningAppID).
// Only asked while a Steam game is launching or running.
async function steamRunningAppId() {
  if (process.platform !== 'win32') return 0;
  const res = await platform.runHelper('reg.exe', ['query', 'HKCU\\Software\\Valve\\Steam', '/v', 'RunningAppID'], { timeout: 3000 });
  return res.ok ? platform.parseRunningAppId(res.stdout) : null;
}

// Single centralized check that inspects running processes once for all games
async function checkAllTrackedProcesses() {
  if (isChecking) return;
  const gameIds = Object.keys(trackedProcesses);
  if (gameIds.length === 0) return;

  isChecking = true;
  try {
    let snapshot = null;
    let procList = null;
    let runningAppId = 0;
    const now = Date.now();

    if (process.platform === 'win32') {
      // Exact image names from the CSV, never a substring of the whole
      // output ("de.exe" used to match "claude.exe").
      snapshot = await platform.listWindowsProcesses();
      if (!snapshot) return;
      const wantSteam = gameIds.some((id) => {
        const t = trackedProcesses[id];
        return t && t.steamAppId && (t.running || isPending(t, now));
      });
      if (wantSteam) runningAppId = await steamRunningAppId();
    } else {
      // One /proc pass per tick, shared by every tracked game.
      procList = platform.readLinuxProcesses();
    }

    for (const gameId of gameIds) {
      const t = trackedProcesses[gameId];
      if (!t) continue;
      const names = t.allExeNames || [];
      let viaSteam = false;
      if (t.steamAppId && runningAppId === null) {
        viaSteam = !!t.steamSeen; // registry read failed: keep the last answer
      } else if (t.steamAppId && runningAppId) {
        viaSteam = String(t.steamAppId) === String(runningAppId);
      }
      t.steamSeen = viaSteam;
      if (names.length === 0 && !viaSteam && !t.running) continue;

      let pids = [];
      if (process.platform === 'win32') {
        pids = platform.pidsForNames(snapshot, names).filter((pid) => pid !== process.pid);
      } else {
        pids = (procList || []).filter((p) => platform.matchesGameProcess(p, names)).map((p) => p.pid);
      }
      t.pids = pids;
      const running = pids.length > 0 || viaSteam;

      if (running && !t.running) {
        t.running = true;
        t.sessionStart = Date.now();
        send('tracking:started', { gameId, sessionStart: t.sessionStart });
      } else if (!running && t.running) {
        const sessionEnd = Date.now();
        const sessionHours = (sessionEnd - t.sessionStart) / 3600000;
        t.running = false;
        t.launchedAt = 0;
        t.pid = 0;
        t.pgid = 0;
        t.childImage = '';
        send('tracking:session-end', { gameId, sessionHours, sessionStart: t.sessionStart, sessionEnd });
      }

      if (running) {
        const sessionMins = (Date.now() - t.sessionStart) / 60000;
        send('tracking:tick', { gameId, sessionMins });
      }
    }
  } catch (e) {
    console.warn('[tracker]', e.message);
  } finally {
    isChecking = false;
  }
}

function ensureTrackingLoop() {
  if (!loopTimer && !isChecking) scheduleLoop(nextPollDelay());
}

// Name of the executable a tracked path stands for, or '' for things that are
// not files (steam://..., shell:AppsFolder\..., a .lnk/.url shortcut).
function trackableExeName(p) {
  if (!p || !platform.isFilesystemPath(p)) return '';
  const base = path.basename(p).toLowerCase();
  if (/\.(lnk|url)$/.test(base)) return '';
  return base;
}

function registerTrackedGame(gameId, exePath, installDir, steamAppId, pid) {
  const sid = String(gameId);
  const fileExe = exePath && platform.isFilesystemPath(exePath) ? exePath : '';
  let resolvedInstallDir = installDir || '';
  if (!resolvedInstallDir && steamAppId) {
    resolvedInstallDir = resolveSteamInstallDir(steamAppId);
  }
  if (!resolvedInstallDir && fileExe) {
    resolvedInstallDir = path.dirname(fileExe);
  }
  // A relative dirname ('.') would make us walk the app's cwd — never do that.
  if (resolvedInstallDir && !path.isAbsolute(resolvedInstallDir)) {
    resolvedInstallDir = '';
  }

  let resolvedExePath = trackableExeName(fileExe) ? fileExe : '';
  if (!resolvedExePath && resolvedInstallDir) {
    resolvedExePath = findMainExe(resolvedInstallDir);
  }

  // Registration stays cheap: only the primary executable name. Anything more
  // is discovered in the background once the game is actually launched.
  const allExeNames = [];
  const primaryExe = trackableExeName(resolvedExePath);
  if (primaryExe && !allExeNames.includes(primaryExe)) {
    allExeNames.push(primaryExe);
  }

  if (trackedProcesses[sid]) {
    // Merge executables if already registered
    trackedProcesses[sid].allExeNames = [...new Set([...trackedProcesses[sid].allExeNames, ...allExeNames])];
    if (resolvedInstallDir) trackedProcesses[sid].installDir = resolvedInstallDir;
    if (resolvedExePath) trackedProcesses[sid].exePath = resolvedExePath;
    if (steamAppId) trackedProcesses[sid].steamAppId = steamAppId;
    // A freshly launched child becomes the process-group leader on Linux
    // (spawn is detached), which is what lets us stop its whole tree.
    if (pid) {
      trackedProcesses[sid].pid = pid;
      trackedProcesses[sid].pgid = pid;
    }
    return trackedProcesses[sid];
  }

  trackedProcesses[sid] = {
    gameId: sid,
    exePath: resolvedExePath,
    installDir: resolvedInstallDir,
    steamAppId: steamAppId || '',
    exeName: primaryExe,
    allExeNames,
    running: false,
    sessionStart: null,
    launchedAt: 0,
    pids: [],
    pid: pid || 0,
    pgid: pid || 0,
    childImage: '',
  };

  return trackedProcesses[sid];
}

function enrichTrackedGame(sid) {
  const t = trackedProcesses[sid];
  if (!t || !t.installDir) return;
  // Depth 4: CS2 keeps cs2.exe at game\bin\win64. The walk is breadth-first
  // and bounded by the same entry budget.
  platform.listLaunchableNamesAsync(t.installDir, { maxDepth: 4, limit: 2000 })
    .then((names) => {
      const cur = trackedProcesses[sid];
      if (!cur || !names || !names.length) return;
      // Runtimes bundled next to the game (python.exe, javaw.exe...) would
      // match unrelated processes; only the primary exe may be one of those.
      const extra = names.filter((n) => !platform.isGenericProcessName(n));
      cur.allExeNames = [...new Set([...cur.allExeNames, ...extra])];
    })
    .catch(() => {});
}

// opts: { childImage } — image name of the spawned child (game.exe, cmd.exe)
// so Stop can kill that exact PID as long as it is still that program.
function startTracking(gameId, exePath, installDir, steamAppId, pid, opts) {
  const sid = String(gameId);
  const t = registerTrackedGame(sid, exePath, installDir, steamAppId, pid);
  if (!t.running) t.launchedAt = Date.now();
  if (pid && opts && opts.childImage) t.childImage = String(opts.childImage).toLowerCase();
  enrichTrackedGame(sid);
  // Immediate check so we don't wait for the next (possibly slow) tick.
  scheduleLoop(300);
  return t;
}

// Pre-registers games from library and returns IDs of any games already running
async function initLibraryTracking(gamesList) {
  if (!Array.isArray(gamesList)) return [];
  for (const g of gamesList) {
    if (!g) continue;
    if (g.exePath || g.steamAppId || g.installDir) {
      registerTrackedGame(String(g.id), g.exePath, g.installDir, g.steamAppId);
    }
  }
  await checkAllTrackedProcesses();
  ensureTrackingLoop();
  return Object.values(trackedProcesses).filter(t => t.running).map(t => t.gameId);
}

function stopTracking(gameId) {
  const sid = String(gameId);
  const t = trackedProcesses[sid];
  if (!t) return;
  if (t.running) {
    const sessionEnd = Date.now();
    const sessionHours = (sessionEnd - t.sessionStart) / 3600000;
    send('tracking:session-end', { gameId: sid, sessionHours, sessionStart: t.sessionStart, sessionEnd });
  }
  delete trackedProcesses[sid];
  if (Object.keys(trackedProcesses).length === 0) stopLoop();
}

function stopAllTracking() {
  stopLoop();
  Object.keys(trackedProcesses).forEach(id => {
    stopTracking(id);
  });
}

// PIDs to stop on Windows: processes whose exact image name belongs to this
// game, plus the child we spawned if that PID still runs the same program
// (a PID is reused once its process exits).
function windowsKillPids(snapshot, t, names) {
  const pids = new Set(platform.pidsForNames(snapshot, names));
  if (t && t.pid && snapshot && snapshot.byPid) {
    const image = snapshot.byPid.get(t.pid);
    const expected = t.childImage || t.exeName;
    if (image && expected && image === expected) pids.add(t.pid);
  }
  pids.delete(process.pid);
  return [...pids];
}

// Kill game process tree forcefully
async function killGameProcesses(gameId, exePath, installDir, steamAppId, launcherPath) {
  const sid = String(gameId);
  const t = trackedProcesses[sid];
  let exesToKill = t && t.allExeNames?.length ? [...t.allExeNames] : [];

  if (exesToKill.length === 0) {
    let dir = installDir || '';
    if (!dir && steamAppId) dir = resolveSteamInstallDir(steamAppId);
    if (!dir && exePath && platform.isFilesystemPath(exePath)) dir = path.dirname(exePath);
    if (dir) exesToKill = collectGameExes(dir).filter((n) => !platform.isGenericProcessName(n));
    const bn = trackableExeName(exePath);
    if (bn && !exesToKill.includes(bn)) exesToKill.push(bn);
  }

  const lbn = trackableExeName(launcherPath);
  if (lbn && !exesToKill.includes(lbn)) exesToKill.push(lbn);

  const cleanExes = [...new Set(exesToKill.map(e => path.basename(e).trim().toLowerCase()).filter(Boolean))];

  if (process.platform === 'win32') {
    const snapshot = await platform.listWindowsProcesses();
    const pids = snapshot ? windowsKillPids(snapshot, t, cleanExes) : [];
    for (const pid of pids) {
      await platform.runHelper('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { timeout: 5000 });
    }
  } else {
    await killLinuxGameTree(t, cleanExes);
  }

  stopTracking(sid);
  return true;
}

// Stop a game on Linux: SIGTERM the process group we spawned, then anything
// whose executable basename matches, then SIGKILL whatever survived.
async function killLinuxGameTree(t, exeNames) {
  const ownPid = process.pid;

  const signalAll = (sig) => {
    if (t && t.pgid) {
      try { process.kill(-t.pgid, sig); } catch (e) { /* group already gone */ }
    }
    for (const p of platform.readLinuxProcesses()) {
      if (p.pid === ownPid) continue;
      if (!platform.matchesGameProcess(p, exeNames)) continue;
      try { process.kill(p.pid, sig); } catch (e) {}
    }
  };

  signalAll('SIGTERM');
  await new Promise(resolve => setTimeout(resolve, 2000));

  const survivors = platform.readLinuxProcesses().filter(
    p => p.pid !== ownPid && platform.matchesGameProcess(p, exeNames)
  );
  if (survivors.length) {
    for (const p of survivors) {
      try { process.kill(p.pid, 'SIGKILL'); } catch (e) {}
    }
    if (t && t.pgid) {
      try { process.kill(-t.pgid, 'SIGKILL'); } catch (e) {}
    }
  }
}

function detectLinuxSpecs() {
  let cpu = 'Unknown';
  try {
    const cpuInfo = fs.readFileSync('/proc/cpuinfo', 'utf-8');
    const m = cpuInfo.match(/model name\s*:\s*(.+)/i);
    if (m) cpu = m[1].trim();
  } catch (e) {}

  let ram = 'Unknown';
  try {
    const memInfo = fs.readFileSync('/proc/meminfo', 'utf-8');
    const m = memInfo.match(/MemTotal:\s*(\d+)/i);
    if (m) ram = Math.round(parseInt(m[1], 10) / (1024 * 1024)) + ' GB';
  } catch (e) {}

  let os = 'Linux';
  try {
    const osRel = fs.readFileSync('/etc/os-release', 'utf-8');
    const m = osRel.match(/PRETTY_NAME="?([^"\n]+)"?/i);
    if (m) os = m[1].trim();
  } catch (e) {}

  let gpus = [];
  try {
    const pci = platform.runHelperSync('lspci', [], { timeout: 3000 });
    const lines = pci.split('\n').map(l => l.trim()).filter(l => l && /vga|3d|display/i.test(l));
    gpus = lines.map(line => {
      const colonIdx = line.indexOf(': ');
      const name = colonIdx !== -1 ? line.slice(colonIdx + 2).trim() : line;
      return { name, vram: 'Unknown' };
    });
  } catch (e) {}

  const iGpuKeywords = ['intel', 'uhd', 'iris', 'integrated'];
  const discrete = gpus.find(g => !iGpuKeywords.some(k => g.name.toLowerCase().includes(k)));
  const primary = discrete || gpus[0] || { name: 'Unknown', vram: 'Unknown' };

  return {
    cpu,
    gpu: primary.name,
    vram: primary.vram,
    ram,
    os,
    allGpus: gpus,
  };
}

// Hardware detection
let cachedSpecs = null;
async function detectPCSpecs() {
  if (cachedSpecs) return cachedSpecs;
  if (process.platform !== 'win32') {
    try {
      cachedSpecs = detectLinuxSpecs();
      return cachedSpecs;
    } catch (e) {
      console.error('Linux specs detection error:', e.message);
      return { cpu: 'Unknown', gpu: 'Unknown', vram: 'Unknown', ram: 'Unknown', os: 'Linux', allGpus: [] };
    }
  }
  try {
    // Single async PowerShell call to get ALL specs at once (no UI freeze)
    const psScript = '$cpu = (Get-CimInstance Win32_Processor | Select -First 1).Name; $ram = (Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory; $os = (Get-CimInstance Win32_OperatingSystem).Caption; $gpus = Get-CimInstance Win32_VideoController | Select-Object Name, AdapterRAM; @{ cpu=$cpu; ram=$ram; os=$os; gpus=@($gpus) } | ConvertTo-Json -Depth 3';

    const res = await platform.runHelper('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psScript], { timeout: 12000 });
    if (!res.ok) throw new Error(res.stderr.trim() || 'PowerShell failed');
    const raw = res.stdout.replace(/^﻿/, '').trim();

    const data = JSON.parse(raw);

    // Parse GPUs
    const gpuArr = Array.isArray(data.gpus) ? data.gpus : [data.gpus];
    const gpus = gpuArr.filter(Boolean).map(g => {
      const adapterBytes = parseInt(g.AdapterRAM);
      const vram = (adapterBytes && adapterBytes > 0)
        ? (adapterBytes / (1024 ** 3)).toFixed(1) + ' GB'
        : 'Unknown';
      return {
        name: g.Name || 'Unknown',
        vram,
      };
    });

    // Pick discrete GPU over integrated
    const iGpuKeywords = ['intel', 'uhd', 'iris', 'integrated'];
    const discrete = gpus.find(g => !iGpuKeywords.some(k => g.name.toLowerCase().includes(k)));
    const primary = discrete || gpus[0] || { name: 'Unknown', vram: 'Unknown' };

    const ramGB = data.ram ? Math.round(parseInt(data.ram) / (1024 ** 3)) + ' GB' : 'Unknown';

    cachedSpecs = {
      cpu: data.cpu || 'Unknown',
      gpu: primary.name,
      vram: primary.vram,
      ram: ramGB,
      os: data.os || 'Windows',
      allGpus: gpus,
    };
    return cachedSpecs;
  } catch (e) {
    console.error('Specs detection error:', e.message);
    return { cpu: 'Unknown', gpu: 'Unknown', vram: 'Unknown', ram: 'Unknown', os: 'Windows', allGpus: [] };
  }
}


module.exports = { setTrackerWindow, startTracking, stopTracking, stopAllTracking, detectPCSpecs, trackedProcesses, collectGameExes, initLibraryTracking, killGameProcesses };
