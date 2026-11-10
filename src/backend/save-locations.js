/* Where does a game keep its saves? Asks PCGamingWiki (the source the Ludusavi
 * manifest is built from) for the game's "Save game data location" entries,
 * turns the {{p|...}} path templates into real Windows paths, and returns the
 * folders that exist on this PC. No Electron imports.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const API = 'https://www.pcgamingwiki.com/w/api.php';
const UA = 'GameVault/2.0 (save backups; https://github.com/itzSornet/Gamevault)';

async function wiki(params, doFetch) {
  const q = new URLSearchParams({ format: 'json', formatversion: '2', ...params });
  const res = await doFetch(`${API}?${q}`, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`PCGamingWiki answered ${res.status}`);
  return res.json();
}

async function findPage({ name, steamAppId }, doFetch) {
  if (steamAppId && /^\d+$/.test(String(steamAppId))) {
    const j = await wiki({ action: 'cargoquery', tables: 'Infobox_game', fields: 'Infobox_game._pageName=page', where: `Infobox_game.Steam_AppID HOLDS "${steamAppId}"`, limit: '1' }, doFetch);
    const hit = j.cargoquery && j.cargoquery[0] && j.cargoquery[0].title && j.cargoquery[0].title.page;
    if (hit) return hit;
  }
  if (!name) return null;
  const j = await wiki({ action: 'opensearch', search: String(name).slice(0, 120), limit: '1', namespace: '0', redirects: 'resolve' }, doFetch);
  return Array.isArray(j) && j[1] && j[1][0] ? j[1][0] : null;
}

/** Split "a|{{p|b|c}}|d" on top-level pipes. */
function splitTop(s) {
  const parts = [];
  let depth = 0, cur = '';
  for (let i = 0; i < s.length; i++) {
    if (s.startsWith('{{', i)) { depth++; cur += '{{'; i++; continue; }
    if (s.startsWith('}}', i)) { depth--; cur += '}}'; i++; continue; }
    if (s[i] === '|' && depth === 0) { parts.push(cur); cur = ''; continue; }
    cur += s[i];
  }
  parts.push(cur);
  return parts;
}

/** The raw Windows save paths from a page's wikitext. */
function parseSavePaths(wikitext) {
  const out = [];
  const re = /\{\{\s*Game data\/saves\s*\|\s*Windows\s*\|/gi;
  let m;
  while ((m = re.exec(wikitext))) {
    // read to the matching }} of this template
    let depth = 1, i = re.lastIndex, body = '';
    while (i < wikitext.length && depth > 0) {
      if (wikitext.startsWith('{{', i)) { depth++; body += '{{'; i += 2; continue; }
      if (wikitext.startsWith('}}', i)) { depth--; if (depth) body += '}}'; i += 2; continue; }
      body += wikitext[i++];
    }
    for (const raw of splitTop(body)) {
      const p = raw.replace(/<!--[\s\S]*?-->/g, '').replace(/<\/?code>/gi, '').replace(/\{\{\s*note\s*\|[\s\S]*?\}\}/gi, '').trim();
      if (p) out.push(p);
    }
  }
  return out;
}

function tokenMap({ installDir, home, documents, steamDir }) {
  const env = process.env;
  const appdata = env.APPDATA || path.join(home, 'AppData', 'Roaming');
  const local = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  return {
    game: installDir || null,
    steam: steamDir || 'C:\\Program Files (x86)\\Steam',
    uid: '*',
    steamid: '*',
    username: os.userInfo().username,
    userprofile: home,
    'userprofile\\documents': documents || path.join(home, 'Documents'),
    'userprofile\\appdata\\locallow': path.join(home, 'AppData', 'LocalLow'),
    appdata,
    localappdata: local,
    programdata: env.PROGRAMDATA || 'C:\\ProgramData',
    public: env.PUBLIC || 'C:\\Users\\Public',
    windir: env.WINDIR || 'C:\\Windows',
  };
}

/** Replace {{p|...}} with real folders. Returns null for registry/unknown paths. */
function expand(raw, tokens) {
  let unknown = false;
  const s = raw.replace(/\{\{\s*p\s*\|\s*([^}]+?)\s*\}\}/gi, (_, key) => {
    const k = key.toLowerCase().replace(/\//g, '\\');
    if (k.startsWith('hk')) { unknown = true; return ''; }
    const v = tokens[k];
    if (v == null) { unknown = true; return ''; }
    return v;
  });
  if (unknown || /\{\{|\}\}/.test(s)) return null;
  const clean = s.replace(/\//g, '\\').replace(/\\+$/, '').trim();
  return /^[a-z]:\\/i.test(clean) ? clean : null;
}

const hasGlob = (seg) => /[*?<>]/.test(seg);
function globRe(seg) {
  return new RegExp('^' + seg.replace(/<[^>]*>/g, '*').replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i');
}

/** Expand "*" segments against the disk; returns existing folders. */
function resolveOnDisk(p) {
  const segs = p.split('\\');
  let paths = [segs[0] + '\\'];
  for (let i = 1; i < segs.length; i++) {
    const seg = segs[i];
    if (!seg) continue;
    const next = [];
    for (const base of paths) {
      if (hasGlob(seg)) {
        let entries = [];
        try { entries = fs.readdirSync(base, { withFileTypes: true }); } catch (_) { continue; }
        const re = globRe(seg);
        for (const e of entries) if (re.test(e.name)) next.push(path.join(base, e.name));
      } else {
        next.push(path.join(base, seg));
      }
      if (next.length > 50) break;
    }
    paths = next.filter((x) => fs.existsSync(x));
    if (!paths.length) return [];
  }
  // a file pattern at the end means its folder
  return [...new Set(paths.map((x) => {
    try { return fs.statSync(x).isDirectory() ? x : path.dirname(x); } catch (_) { return null; }
  }).filter(Boolean))];
}

function folderStats(dir, limit = 4000) {
  let files = 0, bytes = 0, newest = 0;
  const walk = (d, depth) => {
    if (files > limit || depth > 12) return;
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) walk(full, depth + 1);
      else if (e.isFile()) {
        try { const st = fs.statSync(full); files++; bytes += st.size; newest = Math.max(newest, st.mtimeMs); } catch (_) {}
      }
    }
  };
  walk(dir, 0);
  return { files, bytes, newest };
}

/**
 * @returns {Promise<{page: string|null, candidates: {path, files, bytes, newest}[]}>}
 */
async function findSaveFolders(game, opts = {}) {
  const doFetch = opts.fetch || globalThis.fetch;
  const page = await findPage(game, doFetch);
  if (!page) return { page: null, candidates: [] };
  const j = await wiki({ action: 'parse', page, prop: 'wikitext', redirects: '1' }, doFetch);
  const text = j && j.parse && j.parse.wikitext;
  const raws = typeof text === 'string' ? parseSavePaths(text) : [];
  const tokens = tokenMap({ installDir: game.installDir, home: opts.home || os.homedir(), documents: opts.documents, steamDir: opts.steamDir });
  const seen = new Set();
  const candidates = [];
  for (const raw of raws) {
    const p = expand(raw, tokens);
    if (!p) continue;
    for (const dir of resolveOnDisk(p)) {
      const key = dir.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const st = folderStats(dir);
      if (st.files) candidates.push({ path: dir, ...st });
    }
  }
  candidates.sort((a, b) => b.newest - a.newest);
  return { page, candidates };
}

module.exports = { findSaveFolders, parseSavePaths, expand, tokenMap, folderStats };
