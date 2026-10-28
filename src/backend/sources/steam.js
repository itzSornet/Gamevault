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
    for (const c of ['C:\\Program Files (x86)\\Steam', 'C:\\Program Files\\Steam']) if (has(c)) roots.push(c);
  } else {
    for (const c of [p(HOME, '.steam', 'steam'), p(HOME, '.local', 'share', 'Steam'), p(HOME, '.var', 'app', 'com.valvesoftware.Steam', '.steam', 'steam')]) {
      if (has(c)) roots.push(c);
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

const TOOL_IDS = new Set([228980, 1070560, 1391110, 1628350, 1493710, 2348590, 250820]);
const TOOL_RE = /^(steam linux runtime|steamworks common redistributables|steamvr|proton |steam controller configs|steam play)/i;

function parseOwned(payload) {
  const games = (payload && payload.response && payload.response.games) || [];
  const out = [];
  for (const g of games) {
    if (!g || !g.name) continue;
    if (TOOL_IDS.has(Number(g.appid)) || TOOL_RE.test(g.name)) continue;
    out.push({
      name: g.name,
      source: 'Steam account',
      sourceId: `steam:${g.appid}`,
      exePath: '',
      installDir: '',
      hours: Math.round(((Number(g.playtime_forever) || 0) / 60) * 100) / 100,
      steamAppId: Number(g.appid) || null,
      iconPath: '',
      ownedOnly: true,
    });
  }
  return out;
}

async function fetchOwned({ key, steamId }) {
  if (!key || !steamId) return { ok: false, error: { code: 'NOT_CONFIGURED', message: 'Steam API key or SteamID missing' } };
  const url = `https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/?key=${encodeURIComponent(key)}&steamid=${encodeURIComponent(steamId)}&include_appinfo=1&include_played_free_games=1&format=json`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) return { ok: false, error: { code: res.status === 403 ? 'AUTH' : 'HTTP', message: `Steam returned ${res.status}` } };
    const json = await res.json();
    if (!json.response || json.response.game_count === undefined) {
      return { ok: false, error: { code: 'PRIVATE', message: 'Steam returned no games — profile may be private' } };
    }
    return { ok: true, data: parseOwned(json), count: json.response.game_count };
  } catch (err) {
    return { ok: false, error: { code: err.name === 'AbortError' ? 'TIMEOUT' : 'NETWORK', message: err.message } };
  } finally {
    clearTimeout(timer);
  }
}

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
  detect: () => steamRoots().length > 0,
  scanInstalled,
  scanOwned: fetchOwned,
  parseOwned,
  parseLoginUsers,
  loginUsers,
  activeSteamId,
};
