const fs = require('fs');
const path = require('path');
const { resolveSteamInstallDir, findMainExe } = require('./scanner.js');
const platform = require('./platform.js');

let trackerWin = null;
function setTrackerWindow(w) { trackerWin = w; win = w; }

// Process tracking
let trackedProcesses = {};
let win = null;
let loopTimer = null;
let isChecking = false;

// Session rules (pending → running → grace → ended) live in tracker-core.js;
// this file only gathers process snapshots, runs kills and talks IPC.
const core = require('./tracker-core.js');

// Per-game launch/track settings from the game record (trackMode, trackExe).
// Set by launchGame before tracking starts.
const trackConfig = {};
const TRACK_MODES = ['auto', 'exe', 'steam', 'none'];
function configureTracking(gameId, cfg) {
  const c = cfg || {};
  const mode = TRACK_MODES.includes(c.trackMode) ? c.trackMode : 'auto';
  trackConfig[String(gameId)] = { trackMode: mode, trackExe: c.trackExe ? String(c.trackExe) : '' };
}
function configFor(sid) { return trackConfig[sid] || { trackMode: 'auto', trackExe: '' }; }

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

// main is told when a session ends (it brings back a window it hid for the game)
let sessionEndHook = null;
function onSessionEnd(fn) { sessionEndHook = typeof fn === 'function' ? fn : null; }

// Settings → Playtime → Stop counting when I'm away: a stretch with no mouse
// or keyboard input longer than this isn't counted. 0 = off.
let afkMinutes = 0;
function setAfkMinutes(n) { afkMinutes = [15, 30, 60].includes(Number(n)) ? Number(n) : 0; }
function idleSeconds() {
  try { return require('electron').powerMonitor.getSystemIdleTime(); } catch (_) { return 0; }
}
function closeAway(t, until) {
  if (!t.awaySince) return;
  t.awayMs = (t.awayMs || 0) + Math.max(0, until - t.awaySince);
  t.awaySince = 0;
}
// once per poll for each game: open or close a stretch away from the PC
function noteAway(t, now) {
  if (!afkMinutes || !t.core || t.core.phase !== 'running') { closeAway(t, now); return; }
  const idle = idleSeconds();
  const lastInput = now - idle * 1000;
  if (idle >= afkMinutes * 60) {
    if (!t.awaySince) t.awaySince = Math.max(lastInput, t.core.sessionStart || 0);
  } else {
    closeAway(t, lastInput);
  }
}

function scheduleLoop(delay) {
  if (loopTimer) { clearTimeout(loopTimer); loopTimer = null; }
  if (Object.keys(trackedProcesses).length === 0) return;
  loopTimer = setTimeout(async () => {
    loopTimer = null;
    await checkAllTrackedProcesses();
    if (!loopTimer) scheduleLoop(core.pollDelay(Object.values(trackedProcesses).map((t) => t.core), Date.now()));
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

// Translate core events into the IPC the renderer already understands.
function emit(gameId, t, events) {
  for (const e of events) {
    if (e.type === 'started') {
      t.running = true;
      send('tracking:started', { gameId, sessionStart: e.sessionStart, resumed: !!e.resumed });
    } else if (e.type === 'tick') {
      send('tracking:tick', { gameId, sessionMins: e.sessionMs / 60000 });
    } else if (e.type === 'session-end') {
      t.running = false;
      t.pid = 0; t.pgid = 0; t.childImage = '';
      closeAway(t, e.sessionEnd || Date.now());
      const sessionMs = (e.sessionHours || 0) * 3600000;
      const awayMs = Math.min(sessionMs, t.awayMs || 0);
      t.awayMs = 0;
      const ended = {
        gameId, sessionHours: Math.max(0, sessionMs - awayMs) / 3600000, sessionStart: e.sessionStart, sessionEnd: e.sessionEnd, discarded: !!e.discarded,
        awayMinutes: Math.round(awayMs / 60000),
      };
      if (endedSessions) endedSessions.push(ended);
      send('tracking:session-end', ended);
      if (sessionEndHook) setImmediate(() => { try { sessionEndHook(String(gameId)); } catch (_) {} });
    } else if (e.type === 'gave-up') {
      send('tracking:gave-up', { gameId, reason: 'not-seen' });
      if (sessionEndHook) setImmediate(() => { try { sessionEndHook(String(gameId)); } catch (_) {} });
    }
  }
}

// Names that count as "the game" for this tracked entry, per its track mode.
function trackNamesFor(t) {
  const cfg = configFor(t.gameId);
  if (cfg.trackMode === 'none' || cfg.trackMode === 'steam') return [];
  if (cfg.trackMode === 'exe') {
    const n = trackableExeName(cfg.trackExe) || trackableExeName(t.exePath);
    return n ? [n] : [];
  }
  // auto: never let a launcher or helper count as playing, and never another
  // library game's own exe (several portable games often share one folder,
  // and the folder walk would otherwise make them track each other).
  const others = otherGamesExes(t.gameId);
  const own = t.exeName || '';
  return (t.allExeNames || []).filter((n) => !platform.isLauncherProcessName(n) && (n === own || !others.has(n)));
}

function otherGamesExes(sid) {
  const out = new Set();
  for (const [id, other] of Object.entries(trackedProcesses)) {
    if (id === sid) continue;
    if (other.exeName) out.add(other.exeName);
    const te = trackableExeName(configFor(id).trackExe);
    if (te) out.add(te);
  }
  return out;
}

function wantsSteam(t) {
  const mode = configFor(t.gameId).trackMode;
  return !!t.steamAppId && (mode === 'auto' || mode === 'steam');
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
      // Exact image names from the CSV, never a substring of the whole output.
      snapshot = await platform.listWindowsProcesses();
      if (!snapshot) return;
      const askSteam = gameIds.some((id) => {
        const t = trackedProcesses[id];
        return t && wantsSteam(t) && core.isActive(t.core);
      });
      if (askSteam) runningAppId = await steamRunningAppId();
    } else {
      procList = platform.readLinuxProcesses();
    }

    for (const gameId of gameIds) {
      const t = trackedProcesses[gameId];
      if (!t) continue;
      // the launcher we spawned has exited: its PID may be given to another
      // program later, so Stop must not kill by it any more
      if (snapshot && snapshot.byPid && t.pid && !snapshot.byPid.has(t.pid)) t.pid = 0;
      if (configFor(gameId).trackMode === 'none') continue;
      const names = trackNamesFor(t);

      let viaSteam = false;
      if (wantsSteam(t)) {
        if (runningAppId === null) viaSteam = !!t.steamSeen; // registry read failed: keep the last answer
        else if (runningAppId) viaSteam = String(t.steamAppId) === String(runningAppId);
      }
      t.steamSeen = viaSteam;

      let pids = [];
      if (names.length) {
        if (process.platform === 'win32') {
          pids = platform.pidsForNames(snapshot, names).filter((pid) => pid !== process.pid);
        } else {
          pids = (procList || []).filter((p) => platform.matchesGameProcess(p, names)).map((p) => p.pid);
        }
      }
      t.pids = pids;
      emit(gameId, t, core.observe(t.core, pids.length > 0 || viaSteam, now));
      noteAway(t, now);
    }
  } catch (e) {
    console.warn('[tracker]', e.message);
  } finally {
    isChecking = false;
  }
}

// Name of the executable a tracked path stands for, or '' for things that are
// not files (steam://..., shell:AppsFolder\..., a .lnk/.url shortcut).
function trackableExeName(p) {
  if (!p || !platform.isFilesystemPath(p)) return '';
  const base = path.basename(p).toLowerCase();
  if (/\.(lnk|url)$/.test(base)) return '';
  if (platform.isProtectedProcessName(base)) return '';
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
    core: core.createState(),
    pids: [],
    pid: pid || 0,
    pgid: pid || 0,
    childImage: '',
  };

  return trackedProcesses[sid];
}

function enrichTrackedGame(sid) {
  const t = trackedProcesses[sid];
  if (!t || !t.installDir || configFor(sid).trackMode !== 'auto') return;
  // Depth 4: CS2 keeps cs2.exe at game\bin\win64. The walk is breadth-first
  // and bounded by the same entry budget.
  platform.listLaunchableNamesAsync(t.installDir, { maxDepth: 4, limit: 2000 })
    .then((names) => {
      const cur = trackedProcesses[sid];
      if (!cur || !names || !names.length) return;
      // Runtimes bundled next to the game (python.exe, javaw.exe...) would
      // match unrelated processes; only the primary exe may be one of those.
      const extra = names.filter((n) => !platform.isGenericProcessName(n) && !platform.isProtectedProcessName(n) && !platform.isLauncherProcessName(n));
      cur.allExeNames = [...new Set([...cur.allExeNames, ...extra])];
    })
    .catch(() => {});
}

// opts: { childImage } — image name of the spawned child (game.exe, cmd.exe)
// so Stop can kill that exact PID as long as it is still that program.
function startTracking(gameId, exePath, installDir, steamAppId, pid, opts) {
  const sid = String(gameId);
  const t = registerTrackedGame(sid, exePath, installDir, steamAppId, pid);
  if (pid && opts && opts.childImage) t.childImage = String(opts.childImage).toLowerCase();
  if (configFor(sid).trackMode === 'none') {
    // launched on purpose without playtime tracking
    send('tracking:gave-up', { gameId: sid, reason: 'untracked' });
    return t;
  }
  core.launch(t.core, Date.now(), { viaSteam: wantsSteam(t) && !trackNamesFor(t).length });
  enrichTrackedGame(sid);
  // Immediate check so we don't wait for the next (possibly slow) tick.
  scheduleLoop(300);
  return t;
}

function stopTracking(gameId) {
  const sid = String(gameId);
  const t = trackedProcesses[sid];
  if (!t) return;
  emit(sid, t, core.stop(t.core, Date.now()));
  delete trackedProcesses[sid];
  if (Object.keys(trackedProcesses).length === 0) stopLoop();
}

// Ends every running session. Returns what was sent as tracking:session-end,
// for a caller that has to save it itself (Windows is shutting down and the
// window may not get to).
let endedSessions = null;
function stopAllTracking() {
  stopLoop();
  endedSessions = [];
  try {
    Object.keys(trackedProcesses).forEach(id => {
      stopTracking(id);
    });
    return endedSessions;
  } finally {
    endedSessions = null;
  }
}

// PIDs to stop on Windows: processes whose exact image name belongs to this
// game, plus the child we spawned if that PID still runs the same program
// (a PID is reused once its process exits).
function windowsKillPids(snapshot, t, names) {
  const pids = new Set(platform.pidsForNames(snapshot, names));
  if (t && t.pid && snapshot && snapshot.byPid) {
    const image = snapshot.byPid.get(t.pid);
    const expected = t.childImage || t.exeName;
    if (image && expected && image === expected && !platform.isProtectedProcessName(image)) pids.add(t.pid);
  }
  pids.delete(process.pid);
  pids.delete(process.ppid);
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
    if (dir) exesToKill = collectGameExes(dir).filter((n) => !platform.isGenericProcessName(n) && !platform.isProtectedProcessName(n));
    const bn = trackableExeName(exePath);
    if (bn && !exesToKill.includes(bn)) exesToKill.push(bn);
  }

  const lbn = trackableExeName(launcherPath);
  if (lbn && !exesToKill.includes(lbn)) exesToKill.push(lbn);
  // the process chosen as "the game" is always part of what Stop closes
  const tbn = trackableExeName(configFor(sid).trackExe);
  if (tbn && !exesToKill.includes(tbn)) exesToKill.push(tbn);

  // Never kill system processes, whatever ended up in the list.
  const cleanExes = [...new Set(exesToKill.map(e => path.basename(e).trim().toLowerCase()).filter(Boolean))]
    .filter((n) => !platform.isProtectedProcessName(n));

  if (process.platform === 'win32') {
    const snapshot = await platform.listWindowsProcesses();
    const pids = snapshot ? windowsKillPids(snapshot, t, cleanExes) : [];
    for (const pid of pids) {
      await platform.runHelper('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { timeout: 5000 });
    }
    // Seen only through Steam and nothing here to close: the game is still
    // running, so its session goes on (ending it would lose the rest)
    if (!pids.length && t && t.steamSeen && (t.core.phase === 'running' || t.core.phase === 'grace')) {
      return { ok: false, reason: 'not-found' };
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

// games being played right now, the one started last first
function runningGameIds() {
  return Object.values(trackedProcesses)
    .filter((t) => t && t.core && (t.core.phase === 'running' || t.core.phase === 'grace'))
    .sort((a, b) => (b.core.sessionStart || 0) - (a.core.sessionStart || 0))
    .map((t) => String(t.gameId));
}

// the same, with each game's folder and when its session began
function runningSessions() {
  return Object.values(trackedProcesses)
    .filter((t) => t && t.core && (t.core.phase === 'running' || t.core.phase === 'grace'))
    .sort((a, b) => (b.core.sessionStart || 0) - (a.core.sessionStart || 0))
    .map((t) => ({ gameId: String(t.gameId), installDir: t.installDir || '', sessionStart: t.core.sessionStart || 0 }));
}

module.exports = { onSessionEnd, setAfkMinutes, configureTracking, setTrackerWindow, startTracking, stopTracking, stopAllTracking, trackedProcesses, killGameProcesses, runningGameIds, runningSessions };
