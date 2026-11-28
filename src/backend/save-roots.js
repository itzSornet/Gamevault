/* Save folders named after an account: a SteamID64 (7656119…), a Steam
 * account ID (the number in Steam\userdata), or a launcher's UUID. The same
 * game saves under another number on another PC or Steam account (and some
 * loaders always use their own), and it only reads the folder of the number
 * it uses there. So a backup remembers where it came from, and a restore
 * writes into this PC's folder of that kind, whichever folder was picked.
 * No Electron imports.
 */
const fs = require('fs');
const path = require('path');

const STEAM64 = /^7656119\d{10}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACCOUNT = /^[1-9]\d{0,9}$/;
const CLEAR_LEAD_MS = 10 * 60 * 1000; // a folder this much newer than the rest is the one in use

const split = (p) => String(p || '').split(/[\\/]+/).filter(Boolean);
const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
function joinSegs(first, segs) {
  // keep the drive root ("C:" -> "C:\")
  const root = /^[a-z]:$/i.test(first) ? first + path.sep : first;
  return segs.length ? path.join(root, ...segs) : root;
}
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch (_) { return false; } };

/** Steam account IDs with a folder in <steamDir>\userdata. */
function steamAccounts(steamDir) {
  if (!steamDir) return [];
  try {
    return fs.readdirSync(path.join(steamDir, 'userdata'), { withFileTypes: true })
      .filter((e) => e.isDirectory() && ACCOUNT.test(e.name)).map((e) => e.name);
  } catch (_) { return []; }
}

/**
 * The kind of ID a folder name is, or null. A plain number only counts when
 * it is a Steam account on this PC, or when the kind is already known (a
 * backup said so), since lots of folders are just numbers.
 */
function idKind(name, { accounts = [], kind = null } = {}) {
  const n = String(name || '');
  if (kind) {
    if (kind === 'steam64') return STEAM64.test(n) ? kind : null;
    if (kind === 'uuid') return UUID.test(n) ? kind : null;
    if (kind === 'account') return ACCOUNT.test(n) && !STEAM64.test(n) ? kind : null;
    return null;
  }
  if (STEAM64.test(n)) return 'steam64';
  if (UUID.test(n)) return 'uuid';
  if (ACCOUNT.test(n) && accounts.includes(n)) return 'account';
  return null;
}

/**
 * Where a save folder sits: its ID segment (the last one), the folders above
 * it and the ones below. Stored with each backup.
 * @returns {{dir, id?, kind?, head?: string[], tail?: string[], installDir?, home?}}
 */
function describeSaveDir(dir, { accounts = [], installDir = null, home = null } = {}) {
  const out = { dir: String(dir || '') };
  if (installDir) out.installDir = String(installDir);
  if (home) out.home = String(home);
  const segs = split(dir);
  for (let i = segs.length - 1; i >= 1; i--) {
    const kind = idKind(segs[i], { accounts });
    if (kind) return { ...out, id: segs[i], kind, head: segs.slice(0, i), tail: segs.slice(i + 1) };
  }
  return out;
}

function newestIn(dir, limit = 2000) {
  let newest = 0, files = 0, bytes = 0;
  const walk = (d, depth) => {
    if (files > limit || depth > 8) return;
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) walk(full, depth + 1);
      else if (e.isFile()) { try { const st = fs.statSync(full); files++; bytes += st.size; newest = Math.max(newest, st.mtimeMs); } catch (_) {} }
    }
  };
  walk(dir, 0);
  if (!newest) { try { newest = fs.statSync(dir).mtimeMs; } catch (_) {} }
  return { newest, files, bytes };
}

/** ID-named folders right inside dir, newest first. */
function idChildren(dir, opts) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return []; }
  return entries
    .filter((e) => e.isDirectory() && idKind(e.name, opts))
    .map((e) => ({ path: path.join(dir, e.name), name: e.name, ...newestIn(path.join(dir, e.name)) }))
    .sort((a, b) => b.newest - a.newest);
}

/** One folder, or several to ask about when none is clearly the one in use. */
function pickChild(children, tail) {
  const withTail = (c) => ({ ...c, path: tail && tail.length ? path.join(c.path, ...tail) : c.path });
  if (children.length === 1) return { target: withTail(children[0]).path };
  if (children.length > 1 && children[0].newest - children[1].newest > CLEAR_LEAD_MS) return { target: withTail(children[0]).path };
  return { pending: 'choose', choices: children.map(withTail) };
}

/** A path from the backup's PC, here: same place under this game's install folder or this user's profile. */
function localize(dir, source, { installDir = null, home = null } = {}) {
  if (!dir) return [];
  const out = [];
  const under = (base, root) => {
    if (!base || !root) return null;
    const b = split(base), r = split(root), d = split(dir);
    if (b.length > d.length || !b.every((s, i) => same(s, d[i]))) return null;
    return joinSegs(r[0], [...r.slice(1), ...d.slice(b.length)]);
  };
  for (const p of [under(source.installDir, installDir), under(source.home, home), dir]) {
    if (p && !out.some((x) => same(x, p))) out.push(p);
  }
  return out;
}

/** Re-root a localized backup path at its ID container on this PC. */
function fromContainer(container, source) {
  if (!isDir(container)) return null;
  const kids = idChildren(container, { kind: source.kind });
  if (!kids.length) return { target: path.join(container, source.id, ...source.tail) }; // the game hasn't made one: same ID as before
  return pickChild(kids, source.tail);
}

/**
 * Where a restore writes.
 * @param {object} p
 * @param {string|null} p.chosen     the game's save folder here, if set
 * @param {object|null} p.source     describeSaveDir() of the backup (null for older backups)
 * @param {boolean} [p.exact]        write into chosen as it is (picked from the choices)
 * @param {string[]} [p.accounts]    Steam account IDs on this PC
 * @param {string[]} [p.topNames]    first path segment of each file in the backup
 * @param {string} [p.installDir]    this game's install folder here
 * @param {string} [p.home]          this user's profile folder
 * @returns {{target: string} | {pending: 'folder'} | {pending: 'choose', choices: object[]}}
 */
function resolveRestoreTarget({ chosen = null, source = null, exact = false, accounts = [], topNames = [], installDir = null, home = null }) {
  const src = source && source.kind && source.id && Array.isArray(source.head) && Array.isArray(source.tail) ? source : null;
  if (chosen && exact) return { target: chosen };

  if (chosen) {
    const segs = split(chosen);
    if (src) {
      // the ID folder itself (any number of that kind), or a folder inside it
      for (let i = segs.length - 1; i >= 1; i--) {
        if (!idKind(segs[i], { kind: src.kind })) continue;
        const below = segs.slice(i + 1);
        const prefix = below.length <= src.tail.length && below.every((s, k) => same(s, src.tail[k]));
        return { target: prefix ? path.join(chosen, ...src.tail.slice(below.length)) : chosen };
      }
      // a folder above it: find where the chosen folder sits in the backup's path
      const last = segs[segs.length - 1];
      for (let j = src.head.length - 1; j >= 0; j--) {
        if (!same(src.head[j], last)) continue;
        const r = fromContainer(path.join(chosen, ...src.head.slice(j + 1)), src);
        if (r) return r;
        break;
      }
      if (idChildren(chosen, { kind: src.kind }).length) return fromContainer(chosen, src);
      return { target: chosen };
    }
    // an older backup, or one with no ID in its path: only a picked folder
    // that holds ID folders (and a backup that doesn't start with one) moves down
    const anyId = (n) => idKind(n, { accounts });
    if (!anyId(segs[segs.length - 1]) && !topNames.some(anyId)) {
      const kids = idChildren(chosen, { accounts });
      if (kids.length) return pickChild(kids, []);
    }
    return { target: chosen };
  }

  // no save folder set on this PC: work it out from where the backup came from
  if (!source || !source.dir) return { pending: 'folder' };
  if (!src) {
    const dir = localize(source.dir, source, { installDir, home }).find(isDir);
    return dir ? { target: dir } : { pending: 'folder' };
  }
  const container = joinSegs(src.head[0], src.head.slice(1));
  for (const c of localize(container, source, { installDir, home })) {
    const r = fromContainer(c, src);
    if (r) return r;
  }
  return { pending: 'folder' };
}

module.exports = { steamAccounts, idKind, describeSaveDir, idChildren, resolveRestoreTarget, localize };
