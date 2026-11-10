/* Library sync merge (pure, no I/O). Used by cloud.js.
 *
 * The cloud keeps one snapshot per user: { games: [...], tombstones: {id: ms} }.
 * Games in the cloud never carry anything machine-specific: file paths, local
 * art files and transient "_" fields are stripped (see strip()).
 *
 * Three-way merge per game against `base` (the hash of each game as of this
 * PC's last sync): whichever side changed wins; if both changed, this PC wins
 * field by field. Playtime and last-played always take the larger value and
 * sessions are unioned, so play on two PCs never gets lost.
 * Deletions travel as tombstones; a game deleted on one PC disappears on the
 * others unless it was edited there since.
 */
const crypto = require('crypto');

// Never leave this PC.
const LOCAL_FIELDS = new Set(['exePath', 'installDir', 'launchTarget', 'launcherPath', 'trackExe', 'trackMode', 'perfLog', 'saveDir']);
const ART_FIELDS = ['coverUrl', 'heroUrl', 'logoUrl', 'iconUrl'];
const TOMBSTONE_TTL = 180 * 24 * 60 * 60 * 1000;

const isWebUrl = (v) => typeof v === 'string' && /^https?:\/\//i.test(v);

function strip(g) {
  const out = {};
  for (const [k, v] of Object.entries(g || {})) {
    if (k.startsWith('_') || LOCAL_FIELDS.has(k) || v === undefined) continue;
    if (ART_FIELDS.includes(k) && !isWebUrl(v)) continue;
    out[k] = v;
  }
  out.id = String(g.id);
  return out;
}

function localOnly(g) {
  const out = {};
  for (const [k, v] of Object.entries(g || {})) {
    if (k.startsWith('_') || LOCAL_FIELDS.has(k)) out[k] = v;
  }
  return out;
}

function stable(v) {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;
  return JSON.stringify(v === undefined ? null : v);
}
const hash = (g) => crypto.createHash('sha1').update(stable(g)).digest('hex');

const time = (v) => {
  if (typeof v === 'number') return v;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : 0;
};

function identity(g) {
  if (g.steamAppId) return `steam:${String(g.steamAppId).trim()}`;
  const name = String(g.name || '').normalize('NFKC').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return name ? `name:${name}` : `id:${g.id}`;
}

function sessionsUnion(a, b) {
  const out = [];
  const seen = new Set();
  for (const s of [...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])]) {
    if (!s || typeof s !== 'object') continue;
    const key = `${s.start}|${s.end}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out.sort((x, y) => time(x.start) - time(y.start));
}

/** Merge one game present on both sides. Returns the full local object. */
function mergeGame(local, remote, baseHash) {
  const mine = strip(local);
  const localChanged = baseHash === undefined || hash(mine) !== baseHash;
  const remoteChanged = baseHash === undefined || hash(remote) !== baseHash;
  let synced;
  if (!localChanged) synced = { ...remote };
  else if (!remoteChanged) synced = mine;
  else synced = { ...remote, ...mine };
  synced.hours = Math.max(Number(local.hours) || 0, Number(remote.hours) || 0);
  const lp = [local.lastPlayed, remote.lastPlayed].filter(Boolean).sort((x, y) => time(y) - time(x))[0];
  if (lp) synced.lastPlayed = lp;
  synced.sessions = sessionsUnion(local.sessions, remote.sessions);
  const out = { ...synced, ...localOnly(local), id: String(local.id) };
  // Keep this PC's cached art when the cloud copy has none it can use.
  for (const k of ART_FIELDS) if (!isWebUrl(out[k]) && local[k]) out[k] = local[k];
  return out;
}

/**
 * @param {object} p
 * @param {object[]} p.local        this PC's games (full objects)
 * @param {object}   [p.remote]     cloud snapshot {games, tombstones} or null
 * @param {object}   [p.base]       {id: hash} from this PC's last sync
 * @param {number}   p.now
 * @returns {{games: object[], upload: {games: object[], tombstones: object}, base: object, stats: object}}
 */
function mergeLibrary({ local, remote, base, now }) {
  base = base || {};
  const tomb = { ...((remote && remote.tombstones) || {}) };
  const stats = { added: 0, removed: 0, updated: 0 };
  const localGames = (local || []).filter((g) => g && g.id != null);
  const localById = new Map(localGames.map((g) => [String(g.id), g]));

  // Deleted here since the last sync.
  for (const id of Object.keys(base)) if (!localById.has(id) && !tomb[id]) tomb[id] = now;

  const remoteById = new Map();
  for (const r of (remote && Array.isArray(remote.games) ? remote.games : [])) {
    if (!r || r.id == null) continue;
    const id = String(r.id);
    if (!tomb[id]) remoteById.set(id, { ...r, id });
  }

  const out = [];
  const stash = new Map(); // identity -> local fields of a game removed below
  for (const g of localGames) {
    const id = String(g.id);
    if (tomb[id]) {
      if (base[id] !== undefined && tomb[id] >= time(g.added)) { // deleted on another PC
        stash.set(identity(g), localOnly(g));
        stats.removed++;
        continue;
      }
      delete tomb[id]; // new here, or re-added after the delete: it lives
    }
    const r = remoteById.get(id);
    if (r) {
      const merged = mergeGame(g, r, base[id]);
      if (hash(strip(merged)) !== hash(strip(g))) stats.updated++;
      out.push(merged);
      remoteById.delete(id);
    } else {
      out.push(g);
    }
  }

  // Games only in the cloud: the same game added separately on two PCs is
  // folded into one (the smaller id wins on every PC, so they converge).
  const byIdent = new Map(out.map((g, i) => [identity(g), i]));
  for (const r of remoteById.values()) {
    const i = byIdent.get(identity(r));
    if (i !== undefined) {
      const g = out[i];
      const winner = String(g.id) < r.id ? String(g.id) : r.id;
      const loser = winner === r.id ? String(g.id) : r.id;
      out[i] = { ...mergeGame(g, r, undefined), id: winner };
      tomb[loser] = now;
      stats.updated++;
      continue;
    }
    const kept = stash.get(identity(r));
    out.push(kept ? { ...r, ...kept } : r);
    byIdent.set(identity(r), out.length - 1);
    stats.added++;
  }

  for (const [id, ts] of Object.entries(tomb)) if (now - ts > TOMBSTONE_TTL) delete tomb[id];
  const upload = { games: out.map(strip), tombstones: tomb };
  const nextBase = {};
  for (const g of upload.games) nextBase[g.id] = hash(g);
  return { games: out, upload, base: nextBase, stats };
}

module.exports = { mergeLibrary, strip, hash, stable, LOCAL_FIELDS };
