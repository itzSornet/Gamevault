const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { resolveSteamInstallDir, findMainExe } = require('./scanner.js');

let trackerWin = null;
function setTrackerWindow(w) { trackerWin = w; win = w; }

// Process tracking
let trackedProcesses = {};
let win = null;
let overlayWin = null;
let trackingInterval = null;
let isChecking = false;

// Collect all exe names from a game's install directory (for launcher & child process detection)
function collectGameExes(dirPath) {
  if (!dirPath || !fs.existsSync(dirPath)) return [];
  const exes = [];
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

  function scan(dir, depth) {
    if (depth > 4) return;
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const e of entries) {
        if (e.isFile() && e.name.toLowerCase().endsWith('.exe')) {
          const fl = e.name.toLowerCase();
          if (!SKIP_FILES.some(s => fl.includes(s))) exes.push(fl);
        } else if (e.isDirectory() && depth < 4) {
          const dl = e.name.toLowerCase();
          if (!SKIP_DIRS.some(d => dl.includes(d))) {
            scan(path.join(dir, e.name), depth + 1);
          }
        }
      }
    } catch (e) {}
  }
  scan(dirPath, 0);
  return [...new Set(exes)];
}

// Single centralized check that inspects running processes once for all games
async function checkAllTrackedProcesses() {
  if (isChecking) return;
  const gameIds = Object.keys(trackedProcesses);
  if (gameIds.length === 0) return;

  isChecking = true;
  try {
    const stdout = await new Promise(resolve => {
      exec('tasklist /NH /FO CSV', { encoding: 'utf-8', timeout: 5000 }, (err, out) => {
        resolve(err ? '' : (out || '').toLowerCase());
      });
    });

    if (stdout) {
      for (const gameId of gameIds) {
        const t = trackedProcesses[gameId];
        if (!t || !t.allExeNames || t.allExeNames.length === 0) continue;

        // Check if ANY executable belonging to this game is present in tasklist
        const running = t.allExeNames.some(name => stdout.includes(name));

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
    }
  } catch (e) {}
  isChecking = false;
}

function ensureTrackingLoop() {
  if (!trackingInterval) {
    trackingInterval = setInterval(checkAllTrackedProcesses, 3000);
  }
}

function registerTrackedGame(gameId, exePath, installDir, steamAppId) {
  const sid = String(gameId);
  let resolvedInstallDir = installDir || '';
  if (!resolvedInstallDir && steamAppId) {
    resolvedInstallDir = resolveSteamInstallDir(steamAppId);
  }
  if (!resolvedInstallDir && exePath) {
    resolvedInstallDir = path.dirname(exePath);
  }

  let resolvedExePath = exePath || '';
  if (!resolvedExePath && resolvedInstallDir) {
    resolvedExePath = findMainExe(resolvedInstallDir);
  }

  const allExeNames = resolvedInstallDir ? collectGameExes(resolvedInstallDir) : [];
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
  };

  return trackedProcesses[sid];
}

function startTracking(gameId, exePath, installDir, steamAppId) {
  const sid = String(gameId);
  registerTrackedGame(sid, exePath, installDir, steamAppId);
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

  for (const exeName of exesToKill) {
    try {
      await new Promise(resolve => {
        exec(`taskkill /F /IM "${exeName}" /T`, { timeout: 5000 }, () => resolve());
      });
    } catch (e) {}
  }

  stopTracking(sid);
  return true;
}

// Hardware detection
let cachedSpecs = null;
async function detectPCSpecs() {
  if (cachedSpecs) return cachedSpecs;
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
    const gpus = gpuArr.filter(Boolean).map(g => ({
      name: g.Name || 'Unknown',
      vram: g.AdapterRAM ? (parseInt(g.AdapterRAM) / (1024 ** 3)).toFixed(1) + ' GB' : 'Unknown',
    }));

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
