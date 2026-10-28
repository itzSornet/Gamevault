// GameVault 2.0 — Hydra Launcher (v4) source
//
// Hydra stores its library in a LevelDB directory. We deliberately avoid a
// native LevelDB binding (the app ships without native modules): instead we
// read the raw files and scrape the UTF-8 JSON values LevelDB keeps in them.
// LevelDB log files are mostly plaintext JSON records; some blocks are
// Snappy-compressed, so anything that is not valid JSON is simply ignored.
//
// Public contract:
//   id, label, os, detect(homeDir), scan({ homeDir }), extractGames(dbDir)

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const IS_WIN = process.platform === 'win32';

// LevelDB bookkeeping files. Log/data files (*.log, *.ldb, *.sst) are read.
const IGNORED_FILES = new Set(['lock', 'log', 'log.old', 'current']);

// Titles that are compatibility runtimes rather than actual games. Kept
// deliberately specific so a game like "Proton Bus" is not filtered out.
const RUNTIME_TITLE_RE = /^(?:steam linux runtime\b|steamworks common redistributables|steamvr\b|proton(?:$|\s+(?:experimental|hotfix|easyanticheat|battleye|runtime|\d))|ge-proton)/i;

// ---------------------------------------------------------------------------
// Locations
// ---------------------------------------------------------------------------

function dbCandidates(homeDir) {
  const home = homeDir || os.homedir();
  const dirs = [];

  if (IS_WIN) {
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    dirs.push(path.join(appData, 'hydralauncher', 'hydra-db'));
    dirs.push(path.join(home, 'AppData', 'Roaming', 'hydralauncher', 'hydra-db'));
  } else {
    // Native Linux install and the Flatpak sandbox path.
    dirs.push(path.join(home, '.config', 'hydralauncher', 'hydra-db'));
    dirs.push(path.join(home, '.var', 'app', 'gg.hydralauncher.Hydra', 'config', 'hydralauncher', 'hydra-db'));
  }

  return [...new Set(dirs)];
}

function isDirectory(target) {
  try {
    return fs.existsSync(target) && fs.statSync(target).isDirectory();
  } catch (_) {
    return false;
  }
}

function resolveDbDir(homeDir) {
  return dbCandidates(homeDir).find(isDirectory) || '';
}

function detect(homeDir) {
  return resolveDbDir(homeDir) !== '';
}

// ---------------------------------------------------------------------------
// Raw JSON extraction
// ---------------------------------------------------------------------------

function isIgnoredFile(name) {
  const lower = String(name).toLowerCase();
  return IGNORED_FILES.has(lower) || lower.startsWith('manifest-');
}

// Finds the end (exclusive) of the JSON object starting at `start`, respecting
// quoted strings and backslash escapes. Returns -1 when unterminated.
function matchObject(text, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

function readRecords(file) {
  let text;
  try {
    text = fs.readFileSync(file).toString('utf8');
  } catch (_) {
    return [];
  }

  const out = [];
  let cursor = 0;

  while (cursor < text.length) {
    const start = text.indexOf('{', cursor);
    if (start === -1) break;

    const end = matchObject(text, start);
    if (end === -1) {
      // An unbalanced byte brace in LevelDB noise must not hide later records.
      cursor = start + 1;
      continue;
    }

    const raw = text.slice(start, end);
    if (!raw.includes('"title"')) {
      cursor = end;
      continue;
    }

    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        out.push(parsed);
      }
      cursor = end;
    } catch (_) {
      // Not a JSON record (or a malformed slice): look inside for a record.
      cursor = start + 1;
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// Filtering and dedupe
// ---------------------------------------------------------------------------

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function isGameRecord(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
  if (typeof obj.title !== 'string' || !obj.title.trim()) return false;
  return hasOwn(obj, 'executablePath') || hasOwn(obj, 'objectId');
}

function isImportable(obj) {
  if (obj.isDeleted === true) return false;
  const title = typeof obj.title === 'string' ? obj.title.trim() : '';
  if (!title) return false;
  return !RUNTIME_TITLE_RE.test(title);
}

function hasExecutable(obj) {
  return typeof obj.executablePath === 'string' && obj.executablePath.trim() !== '';
}

function updatedAt(obj) {
  const value = Number(obj.updatedAt);
  return Number.isFinite(value) ? value : 0;
}

function dedupeKey(obj) {
  const id = obj.objectId;
  if (typeof id === 'number' && Number.isFinite(id)) return `id:${id}`;
  if (typeof id === 'string' && id.trim()) return `id:${id.trim()}`;
  return `title:${String(obj.title).trim().toLowerCase()}`;
}

function dedupeGames(games) {
  const byKey = new Map();

  for (const game of games) {
    const key = dedupeKey(game);
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, game);
      continue;
    }

    // Prefer a record that actually points at an executable; only then use
    // the most recently updated record as a tie-breaker.
    if (hasExecutable(game) !== hasExecutable(prev)) {
      if (hasExecutable(game)) byKey.set(key, game);
    } else if (updatedAt(game) > updatedAt(prev)) {
      byKey.set(key, game);
    }
  }

  return [...byKey.values()];
}

function extractGames(dbDir) {
  if (typeof dbDir !== 'string' || !dbDir) return [];

  let entries;
  try {
    entries = fs.readdirSync(dbDir, { withFileTypes: true });
  } catch (_) {
    return [];
  }

  const games = [];
  for (const entry of entries) {
    if (entry.isDirectory() || isIgnoredFile(entry.name)) continue;
    const records = readRecords(path.join(dbDir, entry.name));
    for (const record of records) {
      if (isGameRecord(record) && isImportable(record)) games.push(record);
    }
  }

  return dedupeGames(games);
}

// ---------------------------------------------------------------------------
// Candidate mapping
// ---------------------------------------------------------------------------

function slugify(title) {
  const slug = String(title)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'game';
}

function isNumericId(id) {
  if (typeof id === 'number') return Number.isFinite(id) && Number.isInteger(id);
  if (typeof id !== 'string') return false;
  return /^\d+$/.test(id.trim());
}

function toCandidate(game) {
  const name = String(game.title).trim();
  const exePath = typeof game.executablePath === 'string' ? game.executablePath.trim() : '';

  let installDir = '';
  if (exePath) {
    try {
      if (fs.existsSync(exePath)) installDir = path.dirname(exePath);
    } catch (_) {
      installDir = '';
    }
  }

  const rawId = game.objectId;
  const idText = rawId === null || rawId === undefined ? '' : String(rawId).trim();
  const steamAppId = game.shop === 'steam' && isNumericId(rawId)
    ? (typeof rawId === 'number' ? rawId : idText)
    : null;

  const ms = Number(game.playTimeInMilliseconds);
  const hours = Number.isFinite(ms) && ms > 0
    ? Math.round((ms / 3600000) * 100) / 100
    : 0;

  return {
    name,
    source: 'Hydra',
    sourceId: `hydra:${idText || slugify(name)}`,
    exePath,
    installDir,
    hours,
    steamAppId,
    iconPath: '',
  };
}

function scan(options) {
  try {
    const opts = options || {};
    const dbDir = resolveDbDir(opts.homeDir);
    if (!dbDir) return [];
    return extractGames(dbDir).map(toCandidate);
  } catch (_) {
    return [];
  }
}

module.exports = {
  id: 'hydra',
  label: 'Hydra',
  os: ['linux', 'win32'],
  detect,
  scan,
  extractGames,
};
