const fs = require('fs');
const path = require('path');
const { exec, execSync } = require('child_process');
const { resolveSteamInstallDir, findMainExe } = require('./scanner.js');
const platform = require('./platform.js');

let trackerWin = null;
function setTrackerWindow(w) { trackerWin = w; win = w; }

// Process tracking
let trackedProcesses = {};
let win = null;
let overlayWin = null;
let trackingInterval = null;
let isChecking = false;

// Executable names found in a game's install directory. Bounded so a big
// tree (node_modules, backups, a 30k-file game) can never block the main
// thread — see platform.listLaunchableNamesSync.
function collectGameExes(dirPath, opts) {
  if (!dirPath || !fs.existsSync(dirPath)) return [];
  return platform.listLaunchableNamesSync(dirPath, opts);
}

// Single centralized check that inspects running processes once for all games
async function checkAllTrackedProcesses() {
  if (isChecking) return;
  const gameIds = Object.keys(trackedProcesses);
  if (gameIds.length === 0) return;

  isChecking = true;
  try {
    let stdout = '';
    let procList = null;

    if (process.platform === 'win32') {
      stdout = await new Promise(resolve => {
        exec('tasklist /NH /FO CSV', { encoding: 'utf-8', timeout: 5000 }, (err, out) => {
          resolve(err ? '' : (out || '').toLowerCase());
        });
      });
      if (!stdout) { isChecking = false; return; }
    } else {
      // One /proc pass per tick, shared by every tracked game.
      procList = platform.readLinuxProcesses();
    }

    for (const gameId of gameIds) {
      const t = trackedProcesses[gameId];
      if (!t || !t.allExeNames || t.allExeNames.length === 0) continue;

      // Windows keeps substring matching against tasklist; Linux matches
      // exact process/executable basenames (no false positives).
      const running = process.platform === 'win32'
        ? t.allExeNames.some(name => stdout.includes(name))
        : processMatchesAny(procList, t.allExeNames);

      if (running && !t.running) {
        t.running = true;
        t.sessionStart = Date.now();
        win && win.webContents.send('tracking:started', { gameId, sessionStart: t.sessionStart });
      } else if (!running && t.running) {
        const sessionEnd = Date.now();
        const sessionHours = (sessionEnd - t.sessionStart) / 3600000;
        t.running = false;
        win && win.webContents.send('tracking:session-end', { gameId, sessionHours, sessionStart: t.sessionStart, sessionEnd });
      }

      if (running) {
        const sessionMins = (Date.now() - t.sessionStart) / 60000;
        win && win.webContents.send('tracking:tick', { gameId, sessionMins });
      }
    }
  } catch (e) {}
  isChecking = false;
}

function ensureTrackingLoop() {
  if (!trackingInterval) {
    trackingInterval = setInterval(checkAllTrackedProcesses, 3000);
  }
}

function registerTrackedGame(gameId, exePath, installDir, steamAppId, pid) {
  const sid = String(gameId);
  let resolvedInstallDir = installDir || '';
  if (!resolvedInstallDir && steamAppId) {
    resolvedInstallDir = resolveSteamInstallDir(steamAppId);
  }
  if (!resolvedInstallDir && exePath) {
    resolvedInstallDir = path.dirname(exePath);
  }
  // A relative dirname ('.') would make us walk the app's cwd — never do that.
  if (resolvedInstallDir && !path.isAbsolute(resolvedInstallDir)) {
    resolvedInstallDir = '';
  }

  let resolvedExePath = exePath || '';
  if (!resolvedExePath && resolvedInstallDir) {
    resolvedExePath = findMainExe(resolvedInstallDir);
  }

  // Registration stays cheap: only the primary executable name. Anything more
  // is discovered in the background once the game is actually launched.
  const allExeNames = [];
  const primaryExe = resolvedExePath ? path.basename(resolvedExePath).toLowerCase() : '';
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
    if (pid && !trackedProcesses[sid].pid) {
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
    pid: pid || 0,
    pgid: pid || 0,
  };

  return trackedProcesses[sid];
}

function enrichTrackedGame(sid) {
  const t = trackedProcesses[sid];
  if (!t || !t.installDir) return;
  platform.listLaunchableNamesAsync(t.installDir, { maxDepth: 2, limit: 2000 })
    .then((names) => {
      const cur = trackedProcesses[sid];
      if (!cur || !names || !names.length) return;
      cur.allExeNames = [...new Set([...cur.allExeNames, ...names])];
    })
    .catch(() => {});
}

function startTracking(gameId, exePath, installDir, steamAppId, pid) {
  const sid = String(gameId);
  registerTrackedGame(sid, exePath, installDir, steamAppId, pid);
  if (pid) enrichTrackedGame(sid);
  ensureTrackingLoop();
  // Immediate check so we don't wait up to 3s
  setTimeout(checkAllTrackedProcesses, 300);
}

// Pre-registers games from library and returns IDs of any games already running
async function initLibraryTracking(gamesList) {
  if (!Array.isArray(gamesList)) return [];
  for (const g of gamesList) {
    if (g.exePath || g.steamAppId || g.installDir) {
      registerTrackedGame(String(g.id), g.exePath, g.installDir, g.steamAppId);
    }
  }
  ensureTrackingLoop();
  await checkAllTrackedProcesses();
  return Object.values(trackedProcesses).filter(t => t.running).map(t => t.gameId);
}

function stopTracking(gameId) {
  const sid = String(gameId);
  const t = trackedProcesses[sid];
  if (!t) return;
  if (t.running) {
    const sessionEnd = Date.now();
    const sessionHours = (sessionEnd - t.sessionStart) / 3600000;
    win && win.webContents.send('tracking:session-end', { gameId: sid, sessionHours, sessionStart: t.sessionStart, sessionEnd });
  }
  delete trackedProcesses[sid];
  if (Object.keys(trackedProcesses).length === 0 && trackingInterval) {
    clearInterval(trackingInterval);
    trackingInterval = null;
  }
}

function stopAllTracking() {
  if (trackingInterval) {
    clearInterval(trackingInterval);
    trackingInterval = null;
  }
  Object.keys(trackedProcesses).forEach(id => {
    stopTracking(id);
  });
}

// Kill game process tree forcefully
async function killGameProcesses(gameId, exePath, installDir, steamAppId, launcherPath) {
  const sid = String(gameId);
  const t = trackedProcesses[sid];
  let exesToKill = t && t.allExeNames?.length ? [...t.allExeNames] : [];

  if (exesToKill.length === 0) {
    let dir = installDir || '';
    if (!dir && steamAppId) dir = resolveSteamInstallDir(steamAppId);
    if (!dir && exePath) dir = path.dirname(exePath);
    if (dir) exesToKill = collectGameExes(dir);
    if (exePath) {
      const bn = path.basename(exePath).toLowerCase();
      if (!exesToKill.includes(bn)) exesToKill.push(bn);
    }
  }

  if (launcherPath) {
    const lbn = path.basename(launcherPath).toLowerCase();
    if (!exesToKill.includes(lbn)) exesToKill.push(lbn);
  }

  const cleanExes = [...new Set(exesToKill.map(e => path.basename(e).trim()).filter(Boolean))];

  if (process.platform === 'win32') {
    for (const exeName of cleanExes) {
      try {
        await new Promise(resolve => {
          exec(`taskkill /F /IM "${exeName}" /T`, { timeout: 5000 }, () => resolve());
        });
      } catch (e) {}
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
    const pci = execSync("lspci | grep -i -E 'vga|3d|display'", { encoding: 'utf-8', timeout: 3000 });
    const lines = pci.split('\n').map(l => l.trim()).filter(Boolean);
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

    const raw = await new Promise((resolve, reject) => {
      exec(`powershell -NoProfile -Command "${psScript}"`, { encoding: 'utf-8', timeout: 12000 }, (err, stdout) => {
        if (err) reject(err); else resolve(stdout.trim());
      });
    });

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
