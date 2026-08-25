const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

let trackerWin = null;
function setTrackerWindow(w) { trackerWin = w; win = w; } // Map 'win' to trackerWin internally

// Process tracking
let trackedProcesses = {};
let win = null;
let overlayWin = null;

// Collect all exe names from a game's install directory (for launcher detection)
function collectGameExes(dirPath) {
  const exes = [];
  const SKIP = ['unins', 'setup', 'crash', 'redist', 'dxsetup', 'vcredist', 'directx', 'vc_redist', 'unarc', 'install', '_commonredist', 'dotnet'];
  function scan(dir, depth) {
    if (depth > 2) return;
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const e of entries) {
        if (e.isFile() && e.name.toLowerCase().endsWith('.exe')) {
          const fl = e.name.toLowerCase();
          if (!SKIP.some(s => fl.includes(s))) exes.push(fl);
        } else if (e.isDirectory() && depth < 2) {
          const dl = e.name.toLowerCase();
          if (!['__pycache__', 'node_modules', '.git', '_commonredist', 'redist'].includes(dl)) {
            scan(path.join(dir, e.name), depth + 1);
          }
        }
      }
    } catch (e) {}
  }
  scan(dirPath, 0);
  return [...new Set(exes)];
}

function startTracking(gameId, exePath) {
  if (trackedProcesses[gameId]) return;
  const exeName = path.basename(exePath).toLowerCase();

  // Scan game directory for ALL exes (handles cracked launchers that spawn different exe)
  const installDir = path.dirname(exePath);
  const allExeNames = collectGameExes(installDir);
  if (!allExeNames.includes(exeName)) allExeNames.push(exeName);

  trackedProcesses[gameId] = { exeName, allExeNames, running: false, sessionStart: null, interval: null, checking: false };

  const interval = setInterval(async () => {
    const t = trackedProcesses[gameId];
    if (!t || t.checking) return;
    t.checking = true;
    try {
      // Async exec — never blocks the main thread
      const result = await new Promise(resolve => {
        exec('tasklist /NH /FO CSV', { encoding: 'utf-8', timeout: 5000 }, (err, stdout) => {
          resolve(err ? '' : stdout.toLowerCase());
        });
      });

      // Check if ANY exe from the game directory is running
      const running = t.allExeNames.some(name => result.includes(name));

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
    } catch (e) {}
    t.checking = false;
  }, 5000);

  trackedProcesses[gameId].interval = interval;
}

function stopTracking(gameId) {
  const t = trackedProcesses[gameId];
  if (!t) return;
  clearInterval(t.interval);
  if (t.running) {
    const sessionEnd = Date.now();
    const sessionHours = (sessionEnd - t.sessionStart) / 3600000;
    win && win.webContents.send('tracking:session-end', { gameId, sessionHours, sessionStart: t.sessionStart, sessionEnd });
  }
  delete trackedProcesses[gameId];
}

function stopAllTracking() {
  Object.keys(trackedProcesses).forEach(id => {
    clearInterval(trackedProcesses[id].interval);
    delete trackedProcesses[id];
  });
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


module.exports = { setTrackerWindow, startTracking, stopTracking, stopAllTracking, detectPCSpecs, trackedProcesses, collectGameExes };
