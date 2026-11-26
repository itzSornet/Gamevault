// Steam: installed libraries (local manifests) + owned library (Web API key).
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = os.homedir();
const IS_WIN = process.platform === 'win32';

function has(target) { try { return fs.existsSync(target); } catch (_) { return false; } }
function p(...parts) { return path.join(...parts); }

function steamRoots() {
  const roots = [];
  if (IS_WIN) {
    // Registry SteamPath first (Steam is often on another drive), then the defaults.
    try { for (const r of require('../scanner.js').getSteamRoots()) if (has(r) && !roots.includes(r)) roots.push(r); } catch (_) {}
    for (const c of ['C:\\Program Files (x86)\\Steam', 'C:\\Program Files\\Steam']) if (has(c) && !roots.includes(c)) roots.push(c);
  } else {
    // every Linux install method: native, Flatpak (two layouts), Snap, Debian
    try { for (const r of require('../scanner.js').getSteamRoots()) if (has(r) && !roots.includes(r)) roots.push(r); } catch (_) {}
    for (const c of [p(HOME, '.steam', 'steam'), p(HOME, '.local', 'share', 'Steam'), p(HOME, '.var', 'app', 'com.valvesoftware.Steam', '.steam', 'steam')]) {
      if (has(c) && !roots.includes(c)) roots.push(c);
    }
  }
  return roots;
}

function parseLoginUsers(text) {
  const users = [];
  const re = /"(\d{17})"\s*\{([^}]*)\}/g;
  let m;
  while ((m = re.exec(text))) {
    const body = m[2];
    const get = (key) => {
      const mm = body.match(new RegExp(`"${key}"\\s*"([^"]*)"`));
      return mm ? mm[1] : '';
    };
    users.push({
      steamId: m[1],
      accountName: get('AccountName'),
      personaName: get('PersonaName'),
      mostRecent: get('MostRecent') === '1',
      timestamp: Number(get('Timestamp')) || 0,
    });
  }
  users.sort((a, b) => (Number(b.mostRecent) - Number(a.mostRecent)) || (b.timestamp - a.timestamp));
  return users;
}

function loginUsers() {
  for (const root of steamRoots()) {
    const file = p(root, 'config', 'loginusers.vdf');
    if (!has(file)) continue;
    try { return { file, users: parseLoginUsers(fs.readFileSync(file, 'utf-8')) }; } catch (_) {}
  }
  return { file: null, users: [] };
}

function activeSteamId() {
  const { users } = loginUsers();
  return users.length ? users[0].steamId : null;
}

const TOOL_RE = /^(steam linux runtime|steamworks common redistributables|steamvr|proton |steam controller configs|steam play)/i;

function scanInstalled() {
  try {
    const { detectSteamGames } = require('../scanner.js');
    const seen = new Map();
    for (const g of detectSteamGames() || []) {
      if (!g || !g.name || TOOL_RE.test(g.name)) continue;
      const key = g.steamAppId ? `app:${g.steamAppId}` : `name:${g.name.toLowerCase()}`;
      const prev = seen.get(key);
      if (!prev || (!prev.exePath && g.exePath)) seen.set(key, g);
    }
    return [...seen.values()].map((g) => ({
      name: g.name,
      source: 'Steam',
      sourceId: g.steamAppId ? `steam:${g.steamAppId}` : null,
      exePath: g.exePath || '',
      installDir: g.installDir || '',
      hours: Number(g.hours) || 0,
      steamAppId: g.steamAppId || null,
      iconPath: '',
    }));
  } catch (_) { return []; }
}

module.exports = {
  id: 'steam',
  label: 'Steam',
  os: ['linux', 'win32'],
  steamRoots,
  detect: () => steamRoots().length > 0,
  scanInstalled,
  parseLoginUsers,
  loginUsers,
  activeSteamId,
};
