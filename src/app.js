'use strict';
/* ============================================================================
   GameVault 2.0 — experimental renderer
   Vanilla ES2020, no build step, no framework.

   Performance contract:
     - cards are built once and reused (hidden/shown, reordered) — never
       rebuilt on filter or search
     - text-only updates (hours, status) touch a few nodes, not the tree
     - heavy visuals live behind [data-tier] and a runtime governor
   ========================================================================= */

(() => {
  const api = window.api;
  // started with --bigpicture or "Start in Big Picture": main already made the
  // window fullscreen; take the TV layout before the first paint
  try { if (new URLSearchParams(location.search).get('bp') === '1') document.documentElement.classList.add('is-bigpicture'); } catch (_) {}
  // Frameless window: custom caption buttons + a drag handle (see .win-controls in index.html).
  document.getElementById('win-min').onclick = () => api.minimize();
  document.getElementById('win-max').onclick = () => api.maximize();
  document.getElementById('win-close').onclick = () => api.close();
  const applyMaximized = (isMax) => {
    const max = !!isMax;
    const b = document.getElementById('win-max');
    const label = max ? 'Restore' : 'Maximize';
    if (b) {
      b.title = label;
      b.setAttribute('aria-label', label);
      b.classList.toggle('is-max', max);
    }
    document.documentElement.classList.toggle('is-maximized', max);
  };
  if (api.onMaximizedChange) api.onMaximizedChange(applyMaximized);
  if (api.isMaximized) Promise.resolve().then(() => api.isMaximized()).then(applyMaximized).catch(() => {});

  const state = {
    games: [],
    config: {},
    filter: 'All',
    query: '',
    sort: 'added',
    view: 'shelf',
    shelfId: null,
    tier: 'standard',
    palette: 'ash',
    live: {},          // gameId -> minutes (number) | 'launching' | 'stopping'
    selectedId: null,
    counts: { All: 0, Active: 0, Finished: 0, Want: 0 },
  };

  const cards = new Map();     // id -> { el, refs }
  let shelfDragMoved = false;
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  // ---------------------------------------------------------------------------
  // Utilities
  // ---------------------------------------------------------------------------

  const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ESC_MAP[c]);

  const fmtHours = (h) => {
    const n = Number(h) || 0;
    if (n <= 0) return '0h';
    if (n < 1) {
      const mins = Math.round(n * 60);
      if (mins < 1) return '<1m';
      if (mins < 60) return `${mins}m`;
    }
    return n >= 100 ? `${Math.round(n)}h` : `${n.toFixed(1).replace(/\.0$/, '')}h`;
  };

  const IS_WINDOWS = /Windows/i.test(navigator.userAgent);

  const newGameId = () => ((window.crypto && typeof crypto.randomUUID === 'function')
    ? crypto.randomUUID()
    : `g${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`);

  // Local path (C:\…, \\server\share\…, /home/…) -> proper file:/// URL with
  // encoded segments. Anything that already has a scheme (http, https, file,
  // data, blob, custom protocols) is returned untouched.
  function toFileUrl(value) {
    if (value == null) return '';
    const s = String(value).trim();
    if (!s) return '';
    if (/^[a-z][a-z0-9+.-]+:/i.test(s) && !/^[a-z]:[\\/]/i.test(s)) return s;
    let p = s.replace(/\\/g, '/');
    let prefix;
    let keepFirst = false;
    if (/^\/\/[^/]/.test(p)) { prefix = 'file://'; p = p.slice(2); }          // UNC: file://server/share/…
    else if (/^[a-z]:(\/|$)/i.test(p)) { prefix = 'file:///'; keepFirst = true; } // drive letter
    else if (p.startsWith('/')) { prefix = 'file://'; }                       // POSIX
    else return s;                                                            // relative / unknown
    const encoded = p.split('/').map((seg, i) => ((i === 0 && keepFirst) ? seg : encodeURIComponent(seg))).join('/');
    return prefix + encoded;
  }

  // CSS url("…") with the value escaped for a double-quoted CSS string.
  function cssUrl(value) {
    const u = toFileUrl(value);
    if (!u) return '';
    return `url("${u.replace(/[\\"]/g, '\\$&').replace(/[\n\r\f]/g, '')}")`;
  }

  const baseName = (p) => String(p || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || String(p || '');

  const fmtDate = (ts) => {
    if (!ts) return '—';
    try {
      return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    } catch (_) { return '—'; }
  };

  function debounce(fn, ms) {
    let t = null;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), ms);
    };
  }

  // At most 4 toasts on screen: a repeat of a visible message replaces it
  // (moves to the newest slot and restarts its timer), and a 5th pushes out
  // the oldest.
  const TOAST_MAX = 4;
  function dismissToast(el) {
    if (!el || el.classList.contains('is-leaving')) return;
    clearTimeout(el._gvTimer);
    el.classList.add('is-leaving');
    el.classList.remove('is-on');
    el.style.opacity = '0';
    el.style.transform = 'translateY(6px)';
    setTimeout(() => el.remove(), 250);
  }
  /** Play a UI sound. Pass the element it came from and the sound sits
   *  where that is on screen: a little left or right, a touch higher near
   *  the top. */
  function sfx(name, prio, el) {
    if (!window.Sfx) return;
    let opts;
    if (el && el.getBoundingClientRect) {
      const r = el.getBoundingClientRect();
      if (r.width || r.height) {
        const cx = (r.left + r.width / 2) / Math.max(1, innerWidth);
        const cy = (r.top + r.height / 2) / Math.max(1, innerHeight);
        opts = { pan: (cx * 2 - 1) * 0.45, pitch: (0.5 - cy) * 2 };
      }
    }
    window.Sfx.play(name, prio, opts);
  }
  function applySfxConfig() {
    if (!window.Sfx) return;
    const c = state.config || {};
    window.Sfx.setEnabled(c.sfx !== false);
    window.Sfx.setVolume(typeof c.sfxVolume === 'number' ? c.sfxVolume : 0.6);
    window.Sfx.setTheme(c.sfxTheme || 'crisp');
    window.Sfx.setNav(c.sfxNav !== false);
  }

  function toast(message, kind, actions, { quiet = false } = {}) {
    if (!quiet) sfx(kind === 'error' ? 'error' : 'notify');
    const wrap = $('#toasts');
    const cls = 'toast' + (kind === 'error' ? ' is-error' : kind === 'ok' ? ' is-ok' : '');
    const live = () => [...wrap.children].filter((t) => !t.classList.contains('is-leaving'));
    for (const t of live()) {
      if (t.textContent === String(message) && t.className.replace(' is-on', '') === cls) {
        clearTimeout(t._gvTimer);
        t.classList.add('is-leaving');   // removed instantly: the fresh copy takes its place
        t.remove();
      }
    }
    const el = document.createElement('div');
    el.className = cls;
    el.textContent = message;
    const acts = Array.isArray(actions) ? actions.filter((a) => a && a.label && typeof a.run === 'function') : [];
    if (acts.length) {
      el.classList.add('has-act');
      const row = document.createElement('span');
      row.className = 'toast-acts';
      for (const a of acts) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'toast-act';
        b.textContent = a.label;
        b.onclick = () => { dismissToast(el); try { a.run(); } catch (_) {} };
        row.appendChild(b);
      }
      el.appendChild(row);
    }
    wrap.appendChild(el);
    const shown = live();
    for (let i = 0; i < shown.length - TOAST_MAX; i++) dismissToast(shown[i]);
    void el.offsetWidth;
    el.classList.add('is-on');
    el._gvTimer = setTimeout(() => dismissToast(el), acts.length ? 6500 : 3800);
  }

  function transition(fn) {
    // No document.startViewTransition here: it snapshots the whole window and
    // reads as a flash/freeze in Electron. Page switches are instant.
    fn();
  }

  // ---------------------------------------------------------------------------
  // Performance tiers + governor
  // ---------------------------------------------------------------------------

  // config.json is owned by main; saveConfig is a merge-patch. Send only the
  // keys that change and adopt the merged config main sends back. Patches go
  // out one at a time so a stale reply can never overwrite a newer one.
  let configChain = Promise.resolve();
  function saveConfigPatch(patch) {
    if (!patch || typeof patch !== 'object') return Promise.resolve(state.config);
    Object.assign(state.config, patch);
    const run = configChain.then(async () => {
      const merged = await api.saveConfig(patch);
      if (merged && typeof merged === 'object' && !Array.isArray(merged)) state.config = merged;
      return state.config;
    }).catch((e) => { console.warn('config save failed', e); return state.config; });
    configChain = run;
    return run;
  }

  const lsSet = (key, value) => { try { localStorage.setItem(key, value); } catch (_) {} };
  const lsGet = (key) => { try { return localStorage.getItem(key); } catch (_) { return null; } };

  const TIERS = ['cinematic', 'standard', 'lite'];

  function applyTier(tier, { announce = false, persist = false } = {}) {
    const t = TIERS.includes(tier) ? tier : 'standard';
    state.tier = t;
    document.documentElement.dataset.tier = t;
    lsSet('gv.tier', t);
    if (persist && state.config.tier !== t) saveConfigPatch({ tier: t });
    if (announce) toast(`Visual quality: ${t}`, 'ok');
  }

  const PALETTES = ['midnight', 'nebula', 'emerald', 'ocean', 'sunset', 'paper'];

  function applyPalette(name, { announce = false, persist = false } = {}) {
    const p = PALETTES.includes(name) ? name : 'midnight';
    const html = document.documentElement;
    // 29: a picked palette crossfades: a still of the old colours fades out over
    // the new ones (one layer's opacity, instead of every element repainting)
    if (persist && html.dataset.palette && html.dataset.palette !== p && !prefersReducedMotion() && api.windowSnapshot) {
      const seq = (applyPalette._seq = (applyPalette._seq || 0) + 1);
      api.windowSnapshot().catch(() => null).then((url) => {
        if (seq !== applyPalette._seq) return;
        const finish = () => { state.palette = p; html.dataset.palette = p; };
        if (!url) { finish(); return; }
        const still = new Image();
        still.className = 'palette-still';
        still.alt = '';
        still.onload = () => {
          document.querySelectorAll('.palette-still').forEach((el) => el.remove());
          document.body.appendChild(still);
          finish();
          still.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 380, easing: 'ease-in-out', fill: 'forwards' })
            .onfinish = () => still.remove();
        };
        still.onerror = finish;
        still.src = url;
      });
      lsSet('gv.palette', p);
      if (state.config.palette !== p) saveConfigPatch({ palette: p });
      if (announce) toast(`Palette: ${p}`, 'ok');
      return;
    }
    state.palette = p;
    html.dataset.palette = p;
    lsSet('gv.palette', p);
    if (persist && state.config.palette !== p) saveConfigPatch({ palette: p });
    if (announce) toast(`Palette: ${p}`, 'ok');
  }

  // Measures real frame pacing for ~2s and steps down once if we're too slow.
  function initGovernor() {
    if (state.tier === 'lite') return;
    const deltas = [];
    let last = performance.now();
    let frames = 0;

    const tick = (now) => {
      deltas.push(now - last);
      last = now;
      frames += 1;
      if (frames < 90) { requestAnimationFrame(tick); return; }

      const sorted = deltas.slice(10).sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)] || 16;
      if (median > 21) {
        applyTier(state.tier === 'cinematic' ? 'standard' : 'lite');
        toast('Lowered visual quality to keep things smooth', 'ok');
      }
    };
    requestAnimationFrame(tick);
  }

  // ---------------------------------------------------------------------------
  // Data
  // ---------------------------------------------------------------------------

  const STATUS_ORDER = { Playing: 0, Finished: 1 };

  function statusLabel(g) {
    if (gvIsWishlisted(g)) return 'Wishlist';
    return g.status === 'Finished' ? 'Finished' : 'Playing';
  }

  // Every games.json write goes through one promise chain: the snapshot is
  // taken when the write is queued, and writes leave in queue order, so an
  // older snapshot can never land after a newer one.
  let saveChain = Promise.resolve();
  let saveTimer = null;

  function queueGamesSave() {
    const snapshot = cleanGames();
    state._gamesRev = (state._gamesRev || 0) + 1;
    if (!state._applyingSync) scheduleCloudSync();
    const run = saveChain
      .then(() => api.saveGames(snapshot))
      .catch((e) => { console.warn('save failed', e); });
    saveChain = run;
    return run;
  }

  function saveGamesSoon() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { saveTimer = null; queueGamesSave(); }, 400);
  }

  // Main calls this right before quitting: write anything still pending.
  function flushGames() {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
      queueGamesSave();
    }
    return saveChain.then(() => true, () => true);
  }

  // Active: opened in the last 7 days, or running right now
  function isActiveGame(g) {
    if (state.live[String(g.id)] != null) return true;
    return Sessions.isActive(g, Date.now());
  }

  function filteredGames() {
    const q = state.query.trim();
    let list = state.games.filter((g) => {
      const wanted = gvIsWishlisted(g);
      if (state.filter === 'All' || state.filter === 'Activity') return !wanted;
      if (state.filter === 'Want') return wanted;
      if (state.filter === 'Active') return !wanted && isActiveGame(g);
      return !wanted && g.status === state.filter;
    });

    let scores = null;
    if (q) {
      const scored = [];
      for (const g of list) {
        const hay = [g.name, g.source, g.notes, g.developer, g.publisher].filter(Boolean).join(' ');
        const result = window.Fuzzy.score(q, hay);
        if (result.score >= 250) scored.push({ g, score: result.score });
      }
      scores = new Map(scored.map((entry) => [entry.g, entry.score]));
      list = scored.map((entry) => entry.g);
    }

    const sort = state.sort;
    const compare = (a, b) => {
      if (sort === 'lastPlayed') {
        return (b.lastPlayed || 0) - (a.lastPlayed || 0) || (b.added || 0) - (a.added || 0);
      }
      if (sort === 'name') return String(a.name || '').localeCompare(String(b.name || ''));
      if (sort === 'hours') return (Number(b.hours) || 0) - (Number(a.hours) || 0);
      if (sort === 'rating') return (Rating.value(b) - Rating.value(a)) || String(a.name || '').localeCompare(String(b.name || ''));
      if (sort === 'status') {
        const d = (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9);
        return d !== 0 ? d : String(a.name || '').localeCompare(String(b.name || ''));
      }
      return (b.added || 0) - (a.added || 0);
    };

    if (scores) {
      return list.slice().sort((a, b) => (scores.get(b) - scores.get(a)) || compare(a, b));
    }
    return list.slice().sort(compare);
  }

  function refreshCounts() {
    const c = { All: 0, Active: 0, Finished: 0, Want: 0 };
    for (const g of state.games) {
      if (gvIsWishlisted(g)) { c.Want += 1; continue; }
      c.All += 1;
      if (isActiveGame(g)) c.Active += 1;
      if (g.status === 'Finished') c.Finished += 1;
    }
    state.counts = c;
    for (const el of $$('[data-count]')) el.textContent = String(c[el.dataset.count] ?? 0);

    const hoursOf = (pred) => Math.round(state.games.reduce((sum, g) => sum + (pred(g) ? (Number(g.hours) || 0) : 0), 0));
    const inFilter = (g) => {
      const wanted = gvIsWishlisted(g);
      if (state.filter === 'Want') return wanted;
      if (state.filter === 'All') return !wanted;
      if (state.filter === 'Active') return !wanted && isActiveGame(g);
      return !wanted && g.status === state.filter;
    };
    const gamesWord = (n) => `${n.toLocaleString()} game${n === 1 ? '' : 's'}`;

    // Header title + subtitle follow the active filter.
    const label = filterLabel(state.filter);
    const libTitle = $('#library .lib-title');
    if (libTitle) libTitle.textContent = label;
    const topTitle = $('#filter-title');
    if (topTitle) topTitle.textContent = label;
    const libSub = $('#lib-sub');
    if (libSub) {
      const n = c[state.filter] ?? 0;
      libSub.textContent = state.filter === 'Want'
        ? gamesWord(n)
        : `${gamesWord(n)} · ${hoursOf(inFilter).toLocaleString()} h`;
    }

    const totalEl = $('#side-total');
    const hoursEl = $('#side-hours');
    if (totalEl) totalEl.textContent = gamesWord(c.All);
    if (hoursEl) hoursEl.textContent = `${hoursOf((g) => !gvIsWishlisted(g)).toLocaleString()} h`;
  }

  const FILTER_LABELS = { All: 'Library', Active: 'Active', Finished: 'Finished', Want: 'Wishlist', Activity: 'Activity' };
  // Wishlist and Activity are pages of their own, not a filtered shelf/grid
  const onPageFilter = () => state.filter === 'Want' || state.filter === 'Activity';
  function filterLabel(filter) {
    // Big Picture names its sections itself (Home and Library are both "All")
    if (bp.on && window.BigPicture && BigPicture.section(bp.section).filter === filter) return BigPicture.section(bp.section).label;
    return FILTER_LABELS[filter] || 'Library';
  }

  // ---------------------------------------------------------------------------
  // Library rendering: shelf (default) or grid
  // ---------------------------------------------------------------------------

  // One-time downscale of covers/heroes into a disk cache, so the renderer
  // never decodes a multi-megapixel PNG just to paint a 172 px tile.
  async function prepareThumbs() {
    if (!api.thumb) return;
    const queue = [];
    for (const g of state.games) {
      if (g.coverUrl && !g._cover) queue.push([g, 'cover']);
      if (g.heroUrl && !g._hero) queue.push([g, 'hero']);
      // logos arrive at up to 8000 px wide; decoding those (twice, for the
      // sheen mask) is what made logo pages hitch
      if (g.logoUrl && !g._logo) queue.push([g, 'logo']);
    }
    if (!queue.length) return;

    let i = 0;
    let changed = false;
    const worker = async () => {
      while (i < queue.length) {
        const [g, kind] = queue[i++];
        const url = kind === 'cover'
          ? await api.thumb(g.coverUrl, 344, 'cover')
          : kind === 'logo'
            ? (g.logoUrl ? await api.thumb(g.logoUrl, 900, 'logo') : null)
            : (g.heroUrl ? await api.thumb(g.heroUrl, 1400, 'hero') : null);
        if (url === '__reject__') { g._noHero = true; continue; }
        if (!url) continue;
        if (kind === 'cover') g._cover = url; else if (kind === 'logo') g._logo = url; else g._hero = url;
        changed = true;
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    if (changed && !state.selectedId) {
      state._shelfKey = '';
      renderLibrary();
    }
  }

  // Games without a banner get one fetched once, then it's persisted.
  function imageAspect(url) {
    return new Promise((resolve) => {
      if (!url || document.hidden) { resolve(0); return; }
      let settled = false;
      const done = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      // a hidden/headless window may never fire load, so never block on it
      const timer = setTimeout(() => done(0), 1200);
      const img = new Image();
      img.onload = () => done(img.naturalHeight ? img.naturalWidth / img.naturalHeight : 0);
      img.onerror = () => done(0);
      img.src = toFileUrl(url);
    });
  }

  // Cards are 2:3 like SteamGridDB's 600x900 grids, so anything that is not
  // 2:3 gets replaced with the real grid asset instead of being cropped.
  // Thumbnails for one game's art (what the shelf, grid and pages show).
  async function thumbsFor(g) {
    if (!api.thumb) return;
    const jobs = [];
    if (g.coverUrl && !g._cover) jobs.push(api.thumb(g.coverUrl, 344, 'cover').then((u) => { if (u && u !== '__reject__') g._cover = u; }));
    if (g.heroUrl && !g._hero) jobs.push(api.thumb(g.heroUrl, 1400, 'hero').then((u) => { if (u === '__reject__') g._noHero = true; else if (u) { g._hero = u; g._noHero = false; } }));
    if (g.logoUrl && !g._logo) jobs.push(api.thumb(g.logoUrl, 900, 'logo').then((u) => { if (u && u !== '__reject__') g._logo = u; }));
    await Promise.all(jobs.map((p) => p.catch(() => {})));
  }

  // Artwork for games that don't have it yet. Six games at a time, one
  // lookup per game (Steam games use Steam's own art first and usually never
  // ask SteamGridDB), and each game shows up as soon as its art is in.
  async function enrichArt({ force = false, only = null } = {}) {
    if (!api.sgdbAutofill) return;
    const queue = (only || state.games).filter((g) => g.name
      && (force || g.artVersion !== 3 || (!g.heroUrl && !g.heroTried)));
    if (!queue.length) return;
    queue.sort((a, b) => (b.steamAppId ? 1 : 0) - (a.steamAppId ? 1 : 0));

    let changed = false;
    let paintTimer = 0;
    let limited = false;   // the shared cache said "hourly limit": leave the rest for later
    const tries = new Map();
    const paint = () => {
      paintTimer = 0;
      if (state.selectedId || state.settingsOpen) return;
      renderLibrary();
    };
    const paintSoon = () => { if (!paintTimer) paintTimer = setTimeout(paint, 250); };
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));

    const worker = async () => {
      while (queue.length) {
        const g = queue.shift();
        // once limited, only Steam games (Steam's CDN, no lookup) are worth asking
        if (limited && !g.steamAppId) continue;
        try {
          const slots = [];
          if (!g.coverUrl || Math.abs((await imageAspect(g.coverUrl)) - 2 / 3) > 0.02) slots.push('cover');
          if (!g.heroUrl) slots.push('hero');
          if (!g.logoUrl) slots.push('logo');
          if (!slots.length) { g.artVersion = 3; g.heroTried = true; continue; }

          const res = await api.sgdbAutofill({
            id: g.sgdbId || undefined, name: String(g.name), steamAppId: g.steamAppId || undefined, slots, bulk: true,
          }).catch(() => null);
          if (!res || !res.ok) {
            const code = res && res.error && res.error.code;
            if (code === 'NOT_FOUND') { g.artVersion = 3; g.heroTried = true; continue; }
            // hourly limit: stop asking (Steam games still get Steam's own
            // art); the rest are left unmarked and filled on a later launch
            if (code === 'RATE_LIMIT') { limited = true; continue; }
            // busy / offline: try again later in this run, a couple of times
            const n = (tries.get(g) || 0) + 1;
            tries.set(g, n);
            if (n < 3) { queue.push(g); await wait(code === 'BUSY' ? 2500 : 800); }
            continue;
          }
          const data = res.data || {};
          const a = data.assets || {};
          if (data.match && data.match.id && !g.sgdbId) g.sgdbId = data.match.id;
          if (slots.includes('cover') && a.cover && a.cover.url) { g.coverUrl = a.cover.url; delete g._cover; changed = true; }
          if (slots.includes('hero') && a.hero && a.hero.url) { g.heroUrl = a.hero.url; delete g._hero; g._noHero = false; changed = true; }
          if (slots.includes('logo') && a.logo && a.logo.url) { g.logoUrl = a.logo.url; delete g._logo; changed = true; }
          g.heroTried = true;
          g.artVersion = 3;
          saveGamesSoon();
          await thumbsFor(g);
          paintSoon();
        } catch (_) {}
      }
    };
    await Promise.all(Array.from({ length: Math.min(6, queue.length) }, worker));
    clearTimeout(paintTimer);
    persistGames();

    if (changed) {
      if (!state.selectedId) { if (!state.settingsOpen) renderLibrary(); }
      else {
        const g = state.games.find((x) => String(x.id) === state.selectedId);
        if (g) renderDetail();
      }
    }
  }

  // Never persist the transient thumbnail fields.
  function cleanGames() {
    return state.games.map((g) => {
      const out = {};
      for (const k of Object.keys(g)) if (!k.startsWith('_')) out[k] = g[k];
      return out;
    });
  }

  function persistGames() {
    clearTimeout(saveTimer);
    saveTimer = null;
    return queueGamesSave();
  }

  // Boot-time repair: drop junk entries, give every game a unique id, and
  // coerce the fields the UI does arithmetic on. `changed` says whether the
  // caller has to write the repaired list back.
  function normalizeGames(list) {
    const out = [];
    const seen = new Set();
    let changed = !Array.isArray(list);
    for (const g of Array.isArray(list) ? list : []) {
      if (!g || typeof g !== 'object' || Array.isArray(g)) { changed = true; continue; }
      const validId = (typeof g.id === 'string' && g.id.trim() !== '') || (typeof g.id === 'number' && Number.isFinite(g.id));
      if (!validId || seen.has(String(g.id))) {
        let id = newGameId();
        while (seen.has(id)) id = newGameId();
        g.id = id;
        changed = true;
      }
      seen.add(String(g.id));
      if (typeof g.name !== 'string') { g.name = g.name == null ? '' : String(g.name); changed = true; }
      const hours = Number(g.hours);
      const fixedHours = Number.isFinite(hours) && hours > 0 ? hours : 0;
      if (g.hours !== fixedHours) { g.hours = fixedHours; changed = true; }
      if (!Array.isArray(g.sessions)) { g.sessions = []; changed = true; }
      out.push(g);
    }
    return { games: out, changed };
  }

  async function refreshArt(g, { focus = false } = {}) {
    if (!g) return;
    if (g.coverUrl && api.thumb) {
      const thumb = await api.thumb(g.coverUrl, 344, 'cover').catch(() => null);
      if (thumb && thumb !== '__reject__') g._cover = thumb;
    }
    if (g.heroUrl && api.thumb) {
      const thumb = await api.thumb(g.heroUrl, 1400, 'hero').catch(() => null);
      if (thumb === '__reject__') g._noHero = true;
      else if (thumb) { g._hero = thumb; g._noHero = false; }
    }
    if (g.logoUrl && api.thumb) {
      const thumb = await api.thumb(g.logoUrl, 900, 'logo').catch(() => null);
      if (thumb && thumb !== '__reject__') g._logo = thumb;
    }
    state._shelfKey = '';
    updateCard(g);
    if (state.view === 'shelf') {
      // rebuild the stage/poster even if the shelf is currently hidden behind
      // the detail page, otherwise it comes back with stale artwork
      renderShelf();
    }
    if (state.selectedId && String(state.selectedId) === String(g.id)) {
      renderDetail();
      fadeIn($('#game-view'));
      return;
    }

    // Make the saved game the one you are looking at, so a new entry can never
    // land off-screen at the end of the rail.
    if (focus && state.view === 'shelf') state.shelfId = String(g.id);
    renderLibrary();
    if (focus && state.view === 'shelf') revealShelfTile(String(g.id));
    fadeIn(currentPane());
  }

  // Refresh artwork: throw away this game's picks and fetch the top ones
  // again, exactly like a fresh import (Steam's own art first, then
  // SteamGridDB's top picks), skipping this PC's lookup cache.
  const refetching = new Set();
  async function refetchArtwork(g) {
    if (!g || !api.sgdbAutofill) return;
    const id = String(g.id);
    if (refetching.has(id)) return;
    refetching.add(id);
    toast('Finding the best artwork…', 'ok', null, { quiet: true });
    try {
      // no saved SteamGridDB id: match again from the name / Steam id, like a new import
      const res = await api.sgdbAutofill({
        name: String(g.name || ''),
        steamAppId: g.steamAppId || undefined,
        // all four: the icon needs a SteamGridDB lookup, which also re-matches
        // the game (Steam's own art still wins for cover, banner and logo)
        slots: ['cover', 'hero', 'logo', 'icon'],
        fresh: true,
      }).catch(() => null);
      if (!res || !res.ok) {
        const code = res && res.error && res.error.code;
        toast(code === 'NOT_FOUND' ? 'No artwork found for this game'
          : code === 'RATE_LIMIT' ? 'Artwork limit reached, try again later'
            : 'Couldn’t reach the artwork server', 'error');
        return;
      }
      const data = res.data || {};
      const a = data.assets || {};
      if (data.match && data.match.id) g.sgdbId = data.match.id;
      let n = 0;
      const put = (slot, field, local) => {
        if (!a[slot] || !a[slot].url) return;
        g[field] = a[slot].url;
        delete g[local];
        n++;
      };
      put('cover', 'coverUrl', '_cover');
      put('hero', 'heroUrl', '_hero');
      put('logo', 'logoUrl', '_logo');
      put('icon', 'iconUrl', '_icon');
      if (!n) { toast('No artwork found for this game', 'error'); return; }
      g._noHero = false;
      g.heroTried = true;
      g.artVersion = 3;
      persistGames();
      state._stageVisual = '';
      await refreshArt(g, { focus: false });
      toast('Artwork refreshed', 'ok');
    } finally {
      refetching.delete(id);
    }
  }

  // 25: covers that arrive after their tile is on screen fade in instead of
  // popping. Images already decoded (cache) are shown as they are.
  function fadeInOnLoad(img) {
    if (!img || img.complete || prefersReducedMotion()) return;
    img.style.opacity = '0';
    img.addEventListener('load', () => {
      img.style.opacity = '';
      img.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 320, easing: 'ease-out' });
    }, { once: true });
    img.addEventListener('error', () => { img.style.opacity = ''; }, { once: true });
  }

  // 28: a button's label changing state (Play -> Stop) crossfades.
  function swapLabel(el, text) {
    if (!el || el.textContent === text) return;
    el.textContent = text;
    if (prefersReducedMotion()) return;
    el.animate(
      [{ opacity: 0.2, transform: 'translateY(3px)' }, { opacity: 1, transform: 'none' }],
      { duration: 260, easing: 'cubic-bezier(0.22, 0.8, 0.3, 1)' }
    );
  }

  // True when `next` is `prev` with some ids taken out (same order, nothing new).
  function isRemovalOnly(prev, next) {
    if (!prev.length || next.length >= prev.length) return false;
    let j = 0;
    for (const id of prev) if (id === next[j]) j++;
    return j === next.length;
  }

  // 26: items leaving a list in place. The leaver fades out where it stood
  // (as a ghost copy, clipped to the list), then the rest slide into the gap.
  function flipLeave(clipEl, staying, leaving, mutate) {
    if (prefersReducedMotion() || !leaving.length) { mutate(); return; }
    const clip = clipEl.getBoundingClientRect();
    const first = new Map();
    for (const el of staying) {
      const r = el.getBoundingClientRect();
      if (r.width) first.set(el, r);
    }
    const ghosts = [];
    for (const el of leaving) {
      const r = el.getBoundingClientRect();
      if (!r.width || r.right < clip.left || r.left > clip.right || r.bottom < clip.top || r.top > clip.bottom) continue;
      // the ghost lives in the same list (so list-scoped styles still apply),
      // placed over the original whatever its containing block is
      const g = el.cloneNode(true);
      g.removeAttribute('id');
      delete g.dataset.id;
      g.classList.add('is-ghost');
      g.inert = true;
      g.setAttribute('aria-hidden', 'true');
      Object.assign(g.style, { position: 'absolute', left: '0px', top: '0px', width: r.width + 'px', height: r.height + 'px' });
      el.parentNode.appendChild(g);
      const o = g.getBoundingClientRect();
      Object.assign(g.style, {
        left: (r.left - o.left) + 'px', top: (r.top - o.top) + 'px',
        margin: '0', pointerEvents: 'none', zIndex: '5',
        clipPath: `inset(${Math.max(0, clip.top - r.top)}px ${Math.max(0, r.right - clip.right)}px ${Math.max(0, r.bottom - clip.bottom)}px ${Math.max(0, clip.left - r.left)}px)`,
      });
      ghosts.push(g);
    }
    mutate();
    for (const g of ghosts) {
      g.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'scale(0.94)' }],
        { duration: 220, easing: 'ease-out', fill: 'forwards' }).onfinish = () => g.remove();
    }
    for (const [el, a] of first) {
      if (!el.isConnected || el.hidden) continue;
      const b = el.getBoundingClientRect();
      const dx = a.left - b.left, dy = a.top - b.top;
      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;
      el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }],
        { duration: 380, delay: 90, easing: 'cubic-bezier(0.22, 0.8, 0.3, 1)', fill: 'backwards' });
    }
  }

  // A game logo you can almost pick up: on hover it lifts toward you, tilts
  // after the cursor on springs, and a light sheen slides across the logo's
  // own shape (masked by the image). Springs back when the pointer leaves.
  function logoTilt(wrap) {
    if (!wrap || wrap._tilt || prefersReducedMotion()) return;
    const axes = { rx: { x: 0, v: 0, to: 0 }, ry: { x: 0, v: 0, to: 0 }, s: { x: 1, v: 0, to: 1 } };
    const K = 190, C = 21;   // ζ ≈ 0.76: a little settle, no wobble
    let raf = 0, last = 0;
    const draw = () => {
      wrap.style.transform = `perspective(800px) rotateX(${axes.rx.x.toFixed(2)}deg) rotateY(${axes.ry.x.toFixed(2)}deg) scale(${axes.s.x.toFixed(4)})`;
    };
    const step = (now) => {
      const dt = Math.min(32, now - last) / 1000; last = now;
      let moving = false;
      for (const a of Object.values(axes)) {
        const k = a === axes.s ? K * 1.2 : K;
        a.v += (-k * (a.x - a.to) - C * a.v) * dt;
        a.x += a.v * dt;
        if (Math.abs(a.v) > 0.002 || Math.abs(a.x - a.to) > 0.002) moving = true;
      }
      draw();
      if (moving) raf = requestAnimationFrame(step);
      else { raf = 0; if (axes.s.to === 1) { wrap.style.transform = ''; wrap.classList.remove('is-lifting'); } }
    };
    const kick = () => { if (!raf) { last = performance.now(); raf = requestAnimationFrame(step); } };
    const light = wrap.querySelector('.gv-logo-sheen > b');
    wrap._tilt = true;
    wrap.addEventListener('pointerenter', () => {
      wrap.classList.add('is-hover', 'is-lifting');
      axes.s.to = 1.07; kick();
    });
    wrap.addEventListener('pointermove', (e) => {
      const r = wrap.getBoundingClientRect();
      const px = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
      const py = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
      axes.ry.to = (px - 0.5) * 18;
      axes.rx.to = (0.5 - py) * 14;
      // the light is a pre-drawn layer twice the logo's size, slid so its
      // bright centre sits under the cursor: moved by the compositor, never repainted
      if (light) light.style.transform = `translate3d(${((px - 1) * r.width / 1.07).toFixed(1)}px, ${((py - 1) * r.height / 1.07).toFixed(1)}px, 0)`;
      kick();
    });
    wrap.addEventListener('pointerleave', () => {
      wrap.classList.remove('is-hover');
      axes.rx.to = 0; axes.ry.to = 0; axes.s.to = 1; kick();
    });
  }

  function fadeIn(el) {
    if (!el) return;
    el.classList.remove('gv-fade-in');
    void el.offsetWidth;
    el.classList.add('gv-fade-in');
  }

  window.__gvState = state;

  function animateGridIn() {
    if (prefersReducedMotion()) return;
    const cards = Array.from($('#grid').children).slice(0, 14);
    cards.forEach((card, i) => {
      card.animate(
        [{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }],
        { duration: 480, delay: Math.min(i, 11) * 26, easing: 'cubic-bezier(0.22, 0.8, 0.3, 1)', fill: 'backwards' }
      );
    });
  }

  function renderLibrary() {
    // While a game page is open the library must stay hidden; otherwise it
    // reappears stacked above the detail view.
    const wishView = $('#wishlist-view');
    const actView = $('#activity-view');
    const wishMode = state.filter === 'Want';
    const actMode = state.filter === 'Activity';
    $('#main')?.classList.toggle('is-wish', wishMode);
    $('#main')?.classList.toggle('is-activity', actMode);
    if (actView && !actMode) { actView.hidden = true; actView.innerHTML = ''; }
    if (state.selectedId || state.settingsOpen) {
      $('#shelf').hidden = true;
      $('#library').hidden = true;
      if (wishView) wishView.hidden = true;
      if (actView) actView.hidden = true;
      // sidebar counts still have to follow status/wishlist edits made on
      // the game page
      refreshCounts();
      return;
    }
    if (actMode && actView) {
      $('#shelf').hidden = true;
      $('#library').hidden = true;
      if (wishView) wishView.hidden = true;
      actView.hidden = false;
      renderActivity();
      return;
    }
    if (wishMode && wishView) {
      $('#shelf').hidden = true;
      $('#library').hidden = true;
      wishView.hidden = false;
      renderWishlist();
      return;
    }
    if (wishView) wishView.hidden = true;
    if (state.view === 'shelf') {
      $('#shelf').hidden = false;
      $('#library').hidden = true;
      renderShelf();
    } else {
      $('#shelf').hidden = true;
      $('#library').hidden = false;
      renderGrid();
    }
  }

  // Without the user's own SteamGridDB key every SteamGridDB search goes
  // through the shared cloud cache, where each new term counts toward an
  // hourly limit (60). Steam's store search is free, so it goes first and
  // SteamGridDB is only asked when Steam has little to offer.
  function hasOwnSgdbKey() { return !!(state.config && state.config.hasSgdbKey); }
  function sgdbLimitText(res) {
    return res && res.error && res.error.code === 'RATE_LIMIT'
      ? 'SteamGridDB lookups are paused for a bit (hourly limit). Steam results still work.'
      : '';
  }

  function currentPane() {
    if (state.filter === 'Want' && $('#wishlist-view')) return $('#wishlist-view');
    if (state.filter === 'Activity' && $('#activity-view')) return $('#activity-view');
    return state.view === 'shelf' ? $('#shelf') : $('#library');
  }

  // ---------------------------------------------------------------------------
  // Activity — playtime across every game, its own page in the sidebar
  // ---------------------------------------------------------------------------
  const ACT_RANGES = {
    '30d': { label: '30 days', unit: 'day' },
    '12w': { label: '12 weeks', unit: 'week' },
  };
  const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  const actHours = (h) => (h > 0 ? Sessions.formatDuration(h) : '0h');
  const actDay = (ts) => { const d = new Date(ts); return `${MONTH_SHORT[d.getMonth()]} ${d.getDate()}`; };

  // round the top of the scale up to a number a person would draw
  function actNiceMax(max) {
    const steps = [1, 2, 3, 4, 6, 8, 10, 12, 16, 20, 24, 30, 40, 50, 60, 80, 100, 120, 160, 200];
    return steps.find((v) => v >= max) || Math.ceil(max / 50) * 50;
  }

  function actThumb(g) {
    const src = g && (g._cover || g.coverUrl);
    return src
      ? `<span class="act-thumb" style="background-image:${esc(cssUrl(src))}" aria-hidden="true"></span>`
      : `<span class="act-thumb is-empty" aria-hidden="true">${esc(String((g && g.name) || '?').trim().charAt(0).toUpperCase())}</span>`;
  }

  function actChartHtml(buckets, unit) {
    const max = buckets.reduce((m, b) => Math.max(m, b.hours), 0);
    const top = actNiceMax(Math.max(max, 0.5));
    const n = buckets.length;
    const last = n - 1;
    const label = (i) => {
      if (unit === 'day') {
        if (i === last) return 'Today';
        return (last - i) % 7 === 0 ? actDay(buckets[i].start) : '';
      }
      if (i === last) return 'This week';
      return (last - i) % 3 === 0 ? actDay(buckets[i].start) : '';
    };
    const best = buckets.reduce((b, x) => (x.hours > b.hours ? x : b), buckets[0]);
    const total = buckets.reduce((t, b) => t + b.hours, 0);
    const summary = total > 0
      ? `${actHours(total)} in the last ${n} ${unit}s. Most on ${unit === 'day' ? actDay(best.start) : `the week of ${actDay(best.start)}`}: ${actHours(best.hours)}.`
      : `No play in the last ${n} ${unit}s.`;
    return `
      <div class="act-chart" style="--n:${n}" role="img" aria-label="${esc(summary)}">
        <div class="act-plot">
          <div class="act-gridline" style="bottom:100%"><span>${top}h</span></div>
          <div class="act-gridline" style="bottom:50%"><span>${top / 2}h</span></div>
          <div class="act-bars">
            ${buckets.map((b, i) => `<div class="act-slot${i === last ? ' is-now' : ''}" data-i="${i}">${b.hours > 0 ? `<i style="height:${Math.max(2, (b.hours / top) * 100).toFixed(2)}%"></i>` : ''}</div>`).join('')}
          </div>
        </div>
        <div class="act-x" aria-hidden="true">${buckets.map((_, i) => `<span>${label(i)}</span>`).join('')}</div>
        <div class="act-tip" hidden></div>
      </div>
      ${total > 0 ? '' : '<p class="act-chart-empty">Nothing played in this stretch yet.</p>'}`;
  }

  function renderActivity() {
    const view = $('#activity-view');
    if (!view) return;
    const now = Date.now();
    const games = state.games.filter((g) => !gvIsWishlisted(g));
    const byId = new Map(games.map((g) => [String(g.id), g]));
    const sessions = Sessions.allSessions(games);
    const stats = Sessions.sessionStats(sessions, now);
    const lastWeek = Sessions.weekBuckets(sessions, 2, now)[0].hours;
    const streak = Sessions.playStreak(sessions, now);
    const allHours = games.reduce((t, g) => t + (Number(g.hours) || 0), 0);
    const range = ACT_RANGES[state.actRange] ? state.actRange : '30d';
    const unit = ACT_RANGES[range].unit;
    const buckets = unit === 'day' ? Sessions.dayBuckets(sessions, 30, now) : Sessions.weekBuckets(sessions, 12, now);
    const rangeHours = buckets.reduce((t, b) => t + b.hours, 0);
    let top = Sessions.topGames(games, buckets[0].start, 6);
    let topAllTime = false;
    if (!top.length) { top = Sessions.topGames(games, null, 6); topAllTime = true; }
    const topMax = top.length ? top[0].hours : 1;
    const recent = sessions.slice(0, 10);

    const diff = stats.weekHours - lastWeek;
    const weekNote = !stats.weekHours && !lastWeek
      ? 'Nothing yet this week'
      : (Math.abs(diff) < 1 / 60 ? 'Same as last week' : `${diff > 0 ? '+' : '−'}${Sessions.formatDuration(Math.abs(diff))} vs last week`);

    const tile = (label, value, note) => `
      <div class="act-tile">
        <span class="act-tile-label">${label}</span>
        <b class="act-tile-value">${value}</b>
        <span class="act-tile-note">${note}</span>
      </div>`;

    const gameRow = (g, right, sub, extra = '') => `
      <button type="button" class="act-game" data-act-game data-id="${esc(String(g.id))}">
        ${actThumb(g)}
        <span class="act-game-text"><span class="act-game-name">${esc(g.name || 'Untitled')}</span><span class="act-game-sub">${sub}</span></span>
        ${extra}
        <span class="act-game-right">${right}</span>
      </button>`;

    view.innerHTML = `
      <div class="act">
        <header class="act-head">
          <div>
            <h1 class="act-title">Activity</h1>
            <p class="act-sub">Your playtime across every game</p>
          </div>
        </header>
        <div class="act-tiles">
          ${tile('This week', actHours(stats.weekHours), esc(weekNote))}
          ${tile('This month', actHours(stats.monthHours), `${MONTHS[new Date(now).getMonth()]}`)}
          ${tile('Day streak', `${streak.current} day${streak.current === 1 ? '' : 's'}`, streak.best ? `Best: ${streak.best} day${streak.best === 1 ? '' : 's'}` : 'Play today to start one')}
          ${tile('All time', actHours(allHours), `${stats.count.toLocaleString()} session${stats.count === 1 ? '' : 's'} tracked`)}
        </div>
        <section class="act-card act-playtime">
          <div class="act-card-head">
            <h2>Playtime <span>${actHours(rangeHours)} in the last ${ACT_RANGES[range].label}</span></h2>
            <div class="act-seg" role="group" aria-label="Range">
              ${Object.entries(ACT_RANGES).map(([key, r]) => `<button type="button" class="act-seg-btn${key === range ? ' is-on' : ''}" data-act-range="${key}" aria-pressed="${key === range}">${r.label}</button>`).join('')}
            </div>
          </div>
          ${actChartHtml(buckets, unit)}
        </section>
        <div class="act-cols">
          <section class="act-card">
            <div class="act-card-head"><h2>Most played <span>${topAllTime ? 'all time' : `last ${ACT_RANGES[range].label}`}</span></h2></div>
            <div class="act-list">
              ${top.length
                ? top.map((row) => {
                    const g = byId.get(String(row.id));
                    if (!g) return '';
                    const meter = `<span class="act-meter" aria-hidden="true"><i style="width:${Math.max(3, (row.hours / topMax) * 100).toFixed(1)}%"></i></span>`;
                    return gameRow(g, actHours(row.hours), row.count ? `${row.count} session${row.count === 1 ? '' : 's'}` : 'Playtime imported', meter);
                  }).join('')
                : '<p class="act-empty">Play a game and it shows up here.</p>'}
            </div>
          </section>
          <section class="act-card">
            <div class="act-card-head"><h2>Recent sessions</h2></div>
            <div class="act-list">
              ${recent.length
                ? recent.map((x) => {
                    const g = byId.get(String(x.gameId));
                    if (!g) return '';
                    const d = new Date(x.start);
                    return gameRow(g, Sessions.formatDuration(x.duration), `${WEEKDAY_SHORT[d.getDay()]}, ${actDay(x.start)} · ${hhmm(x.start)}`);
                  }).join('')
                : '<p class="act-empty">No sessions yet. Press Play on any game and each session is saved here when you stop.</p>'}
            </div>
          </section>
        </div>
      </div>`;

    wireActivity(view, buckets, unit);
  }

  function wireActivity(view, buckets, unit) {
    for (const btn of view.querySelectorAll('[data-act-range]')) {
      btn.onclick = () => {
        if (state.actRange === btn.dataset.actRange) return;
        state.actRange = btn.dataset.actRange;
        renderActivity();
        $('#activity-view').querySelector(`[data-act-range="${state.actRange}"]`)?.focus({ preventScroll: true });
      };
    }
    for (const row of view.querySelectorAll('[data-act-game]')) {
      row.onclick = () => openDetail(row.dataset.id);
    }
    // hover a bar: its day (or week), time and session count
    const chart = view.querySelector('.act-chart');
    const tip = chart && chart.querySelector('.act-tip');
    if (!chart || !tip) return;
    let on = null;
    const hide = () => { tip.hidden = true; if (on) on.classList.remove('is-hover'); on = null; };
    chart.addEventListener('pointermove', (e) => {
      const slot = e.target.closest && e.target.closest('.act-slot');
      if (!slot) { hide(); return; }
      if (slot === on) return;
      if (on) on.classList.remove('is-hover');
      on = slot;
      slot.classList.add('is-hover');
      const b = buckets[Number(slot.dataset.i)];
      const d = new Date(b.start);
      const when = unit === 'day' ? `${WEEKDAY_SHORT[d.getDay()]}, ${actDay(b.start)}` : `Week of ${actDay(b.start)}`;
      tip.innerHTML = `<b>${esc(when)}</b><span>${b.hours > 0 ? `${esc(Sessions.formatDuration(b.hours))} · ${b.count} session${b.count === 1 ? '' : 's'}` : 'No play'}</span>`;
      tip.hidden = false;
      const cr = chart.getBoundingClientRect();
      const sr = slot.getBoundingClientRect();
      const bar = slot.querySelector('i');
      const topY = bar ? bar.getBoundingClientRect().top : sr.bottom;
      const half = tip.offsetWidth / 2;
      const x = Math.min(cr.width - half, Math.max(half, sr.left + sr.width / 2 - cr.left));
      tip.style.left = `${x}px`;
      tip.style.top = `${topY - cr.top - 8}px`;
    });
    chart.addEventListener('pointerleave', hide);
  }

  // ---------------------------------------------------------------------------
  // Wishlist — its own page, not a filtered library
  // ---------------------------------------------------------------------------
  function wlIcon(name, size) {
    const s = `width="${size || 14}" height="${size || 14}" viewBox="0 0 24 24" aria-hidden="true"`;
    if (name === 'star') return `<svg ${s} fill="currentColor"><path d="m12 3.5 2.6 5.4 5.9.8-4.3 4.1 1 5.9-5.2-2.8-5.2 2.8 1-5.9-4.3-4.1 5.9-.8z"/></svg>`;
    if (name === 'check') return `<svg ${s} fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12.5 4.5 4.5L19 7"/></svg>`;
    if (name === 'x') return `<svg ${s} fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/></svg>`;
    if (name === 'up') return `<svg ${s} fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5.5 11.5 12 5l6.5 6.5"/></svg>`;
    if (name === 'search') return `<svg ${s} fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/></svg>`;
    if (name === 'plus') return `<svg ${s} fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>`;
    if (name === 'ext') return `<svg ${s} fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 5h5v5M19 5l-8 8M18 14v4a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h4"/></svg>`;
    return '';
  }

  // Order: the user's ranking (Top pick first), then oldest wish first.
  function wishRankOf(g) { return Number.isFinite(g.wishRank) ? g.wishRank : 1e9; }
  function wishOrder() {
    return state.games.filter(gvIsWishlisted)
      .sort((a, b) => wishRankOf(a) - wishRankOf(b) || (Number(a.added) || 0) - (Number(b.added) || 0));
  }
  function wishMeta(g) { return g.steamMeta && g.steamMeta.version === 3 ? g.steamMeta : null; }

  function wishAgo(ts) {
    const t = Number(ts);
    if (!t) return '';
    const days = Math.floor((Date.now() - t) / 86400000);
    if (days < 1) return 'today';
    if (days < 2) return 'yesterday';
    if (days < 14) return `${days} days ago`;
    if (days < 60) return `${Math.round(days / 7)} weeks ago`;
    if (days < 365) return `${Math.max(2, Math.round(days / 30))} months ago`;
    const y = Math.round(days / 365);
    return y <= 1 ? 'a year ago' : `${y} years ago`;
  }

  function wishFactsHtml(g) {
    const m = wishMeta(g);
    const out = [];
    const p = m && m.price;
    if (p && p.discount > 0) out.push(`<span class="wl-chip is-sale">−${p.discount}%</span><span class="wl-price">${p.initial ? `<s>${esc(p.initial)}</s>` : ''}${esc(p.final)}</span>`);
    else if (m && m.free) out.push('<span class="wl-chip">Free to play</span>');
    else if (p && p.final) out.push(`<span class="wl-price">${esc(p.final)}</span>`);
    if (m && m.release && m.release.soon) {
      const d = String(m.release.date || '').trim();
      out.push(`<span class="wl-chip is-soon">${esc(/\d/.test(d) ? `Coming ${d}` : (d || 'Coming soon'))}</span>`);
    }
    const ago = wishAgo(g.added);
    if (ago) out.push(`<span class="wl-since">Added ${esc(ago)}</span>`);
    return out.join('');
  }

  function wishPriceText(p) {
    if (!p || typeof p.final !== 'number') return '';
    if (p.final === 0) return 'Free';
    let s = '';
    try { s = new Intl.NumberFormat('en-US', { style: 'currency', currency: p.currency || 'USD' }).format(p.final / 100); } catch (_) { return ''; }
    return p.initial > p.final ? `−${Math.round((1 - p.final / p.initial) * 100)}%  ${s}` : s;
  }

  // Wide art for the card: the game's hero, else Steam's own library art,
  // else the cover blurred out to fill.
  function wishArt(g) {
    const steam = /^\d+$/.test(String(g.steamAppId || ''))
      ? `https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/${g.steamAppId}/` : '';
    const hero = g._noHero ? '' : (g._hero || g.heroUrl || '');
    const cover = g._cover || g.coverUrl || '';
    return {
      hero: hero ? toFileUrl(hero) : (steam ? steam + 'library_hero.jpg' : ''),
      cover: cover ? toFileUrl(cover) : '',
      logo: (g._logo || g.logoUrl) ? toFileUrl(g._logo || g.logoUrl) : (steam ? steam + 'logo.png' : ''),
    };
  }

  function wishArtHtml(g, art, nameFallback) {
    const bg = art.hero
      ? `<img class="wl-bg" src="${esc(art.hero)}" alt="" decoding="async" data-wl-bg />`
      : art.cover ? `<img class="wl-bg is-cover" src="${esc(art.cover)}" alt="" decoding="async" />` : '';
    const name = nameFallback ? `<span class="wl-name-text">${esc(g.name)}</span>` : '';
    const logo = art.logo
      ? `<span class="gv-logo3d wl-logo" data-logo3d><img src="${esc(art.logo)}" alt="${esc(g.name)}" decoding="async" data-wl-logo /><i class="gv-logo-sheen" style="--logo:${esc(cssUrl(art.logo))}" aria-hidden="true"><b></b></i></span>`
      : name;
    return { bg, logo, name };
  }

  function wireWishImages(el, g, nameFallback) {
    const bg = el.querySelector('[data-wl-bg]');
    if (bg) {
      let triedCover = false;
      bg.addEventListener('error', () => {
        const cover = wishArt(g).cover;
        if (!triedCover && cover) { triedCover = true; bg.classList.add('is-cover'); bg.src = cover; }
        else bg.remove();
      });
    }
    const logo = el.querySelector('[data-wl-logo]');
    if (logo) logo.addEventListener('error', () => {
      const wrap = logo.closest('[data-logo3d]');
      if (wrap) wrap.outerHTML = nameFallback ? `<span class="wl-name-text">${esc(g.name)}</span>` : '';
    }, { once: true });
    for (const im of el.querySelectorAll('img')) fadeInOnLoad(im);
    const tilt = el.querySelector('[data-logo3d]');
    if (tilt) logoTilt(tilt);
  }

  function wishArtKey(g, art) {
    return [art.hero, art.cover, art.logo, g.name, g.steamAppId || ''].join('|');
  }

  function paintWishTop(el, g) {
    const art = wishArt(g);
    const key = wishArtKey(g, art);
    if (el._key !== key) {
      el._key = key;
      const a = wishArtHtml(g, art, true);
      el.innerHTML = `
        <div class="wl-top-art">${a.bg}</div>
        <div class="wl-top-scrim"></div>
        <div class="wl-top-body">
          <span class="wl-badge">${wlIcon('star', 12)} Top pick</span>
          <button type="button" class="wl-name" data-open aria-label="Open ${esc(g.name)}">${a.logo}</button>
          <div class="wl-facts" data-wl-facts></div>
          <div class="wl-actions">
            <button type="button" class="wl-btn is-got" data-got>${wlIcon('check', 15)} I got it</button>
            ${g.steamAppId ? `<button type="button" class="wl-btn" data-store>${wlIcon('ext', 14)} Steam store</button>` : ''}
            <button type="button" class="wl-btn" data-open>Details</button>
            <button type="button" class="wl-btn is-icon" data-remove title="Remove from wishlist" aria-label="Remove ${esc(g.name)} from your wishlist">${wlIcon('x', 15)}</button>
          </div>
        </div>`;
      wireWishImages(el, g, true);
    }
    el.querySelector('[data-wl-facts]').innerHTML = wishFactsHtml(g);
  }

  function paintWishCard(el, g, rank) {
    const art = wishArt(g);
    const key = wishArtKey(g, art);
    if (el._key !== key) {
      el._key = key;
      const a = wishArtHtml(g, art, false);
      el.innerHTML = `
        <button type="button" class="wl-card-art" data-open aria-label="Open ${esc(g.name)}">
          ${a.bg}
          <span class="wl-card-logo">${a.logo}</span>
          <span class="wl-num" data-wl-num></span>
        </button>
        <div class="wl-card-foot">
          <div class="wl-card-info">
            <div class="wl-card-name" title="${esc(g.name)}">${esc(g.name)}</div>
            <div class="wl-facts" data-wl-facts></div>
          </div>
          <div class="wl-card-acts">
            <button type="button" class="wl-icon is-top" data-top title="Make it your top pick" aria-label="Make ${esc(g.name)} your top pick">${wlIcon('up', 15)}</button>
            <button type="button" class="wl-icon is-got" data-got title="I got it: move to library" aria-label="Move ${esc(g.name)} to your library">${wlIcon('check', 15)}</button>
            <button type="button" class="wl-icon is-remove" data-remove title="Remove from wishlist" aria-label="Remove ${esc(g.name)} from your wishlist">${wlIcon('x', 15)}</button>
          </div>
        </div>`;
      wireWishImages(el, g, false);
    }
    el.querySelector('[data-wl-num]').textContent = String(rank);
    el.querySelector('[data-wl-facts]').innerHTML = wishFactsHtml(g);
  }

  function renderWishlist() {
    const view = $('#wishlist-view');
    if (!view) return;
    refreshCounts();
    if (!view.querySelector('.wl')) {
      view.innerHTML = `
        <div class="wl">
          <header class="wl-head">
            <div class="wl-head-text">
              <h1 class="wl-title"><span class="wl-title-star">${wlIcon('star', 24)}</span>Wishlist</h1>
              <p class="wl-sub" data-wl-sub></p>
            </div>
            <div class="wl-add">
              ${wlIcon('search', 15)}
              <input type="text" data-wl-q placeholder="Add a game you want…" aria-label="Add a game to your wishlist" autocomplete="off" spellcheck="false" role="combobox" aria-expanded="false" aria-autocomplete="list" />
              <div class="wl-add-menu" data-wl-menu role="listbox" hidden></div>
            </div>
          </header>
          <div class="wl-top-slot" data-wl-top></div>
          <div class="wl-next" data-wl-next hidden>Up next</div>
          <div class="wl-grid" data-wl-grid></div>
          <div class="wl-empty" data-wl-empty hidden>
            <div class="wl-empty-star">${wlIcon('star', 38)}</div>
            <h2>Nothing on your wishlist yet</h2>
            <p>Search above for a game you want. Steam games show their price, sales and release date here.</p>
            <button type="button" class="btn" data-wl-import>Import your Steam wishlist</button>
          </div>
        </div>`;
      wireWishlist(view);
    }
    const list = wishOrder();
    const sale = list.filter((g) => { const m = wishMeta(g); return m && m.price && m.price.discount > 0; }).length;
    const soon = list.filter((g) => { const m = wishMeta(g); return m && m.release && m.release.soon; }).length;
    const bits = [`${list.length.toLocaleString()} game${list.length === 1 ? '' : 's'} you want`];
    if (sale) bits.push(`<b>${sale} on sale</b>`);
    if (soon) bits.push(`${soon} coming soon`);
    view.querySelector('[data-wl-sub]').innerHTML = list.length ? bits.join(' · ') : 'The games you want next, in one place.';

    const topSlot = view.querySelector('[data-wl-top]');
    const top = list[0];
    let topEl = topSlot.firstElementChild;
    if (!top) topSlot.textContent = '';
    else if (!topEl || topEl.dataset.id !== String(top.id)) {
      topSlot.textContent = '';
      topEl = document.createElement('section');
      topEl.className = 'wl-top';
      topEl.dataset.id = String(top.id);
      topEl.dataset.wlItem = 'top';
      paintWishTop(topEl, top);
      topSlot.appendChild(topEl);
    } else paintWishTop(topEl, top);

    const grid = view.querySelector('[data-wl-grid]');
    const have = new Map(Array.from(grid.children).map((el) => [el.dataset.id, el]));
    const rest = list.slice(1);
    const keep = new Set();
    rest.forEach((g, i) => {
      const id = String(g.id);
      let el = have.get(id);
      if (!el) {
        el = document.createElement('article');
        el.className = 'wl-card';
        el.dataset.id = id;
        el.dataset.wlItem = 'card';
      }
      paintWishCard(el, g, i + 2);
      keep.add(id);
      if (grid.children[i] !== el) grid.insertBefore(el, grid.children[i] || null);
    });
    for (const [id, el] of have) if (!keep.has(id)) el.remove();
    view.querySelector('[data-wl-next]').hidden = rest.length === 0;
    view.querySelector('[data-wl-empty]').hidden = list.length > 0;
    for (const g of list) queueWishMeta(g);
  }

  // A change to the list: what stays slides to its new place, what leaves
  // fades out where it stood, what's new rises in.
  function wishTransition(mutate) {
    const view = $('#wishlist-view');
    const wl = view && view.querySelector('.wl');
    if (!wl || view.hidden || prefersReducedMotion()) { mutate(); renderLibrary(); return; }
    const items = () => Array.from(view.querySelectorAll('[data-wl-item]:not(.is-ghost)'));
    const wr = wl.getBoundingClientRect();
    const first = new Map(items().map((el) => [el, el.getBoundingClientRect()]));
    mutate();
    renderLibrary();
    const now = new Set(items());
    for (const [el, r] of first) {
      if (now.has(el)) continue;
      el.classList.add('is-ghost');
      el.inert = true;
      Object.assign(el.style, {
        position: 'absolute', margin: '0', zIndex: '3', pointerEvents: 'none',
        left: (r.left - wr.left) + 'px', top: (r.top - wr.top) + 'px', width: r.width + 'px', height: r.height + 'px',
      });
      wl.appendChild(el);
      el.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'scale(0.95)' }],
        { duration: 240, easing: 'ease-out', fill: 'forwards' }).onfinish = () => el.remove();
    }
    for (const el of now) {
      const a = first.get(el);
      if (!a) {
        el.animate([{ opacity: 0, transform: 'translateY(8px) scale(0.985)' }, { opacity: 1, transform: 'none' }],
          { duration: 480, delay: 90, easing: 'cubic-bezier(0.22, 0.8, 0.3, 1)', fill: 'backwards' });
        continue;
      }
      const b = el.getBoundingClientRect();
      const dx = a.left - b.left, dy = a.top - b.top;
      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;
      el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }],
        { duration: 420, delay: 60, easing: 'cubic-bezier(0.22, 0.8, 0.3, 1)', fill: 'backwards' });
    }
  }

  function wishItemEl(g) {
    return document.querySelector(`#wishlist-view [data-wl-item][data-id="${CSS.escape(String(g.id))}"]:not(.is-ghost)`);
  }
  function flashWishItem(g) {
    const el = wishItemEl(g);
    if (!el) return;
    el.scrollIntoView({ block: 'nearest', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
    el.classList.remove('is-flash');
    void el.offsetWidth;
    el.classList.add('is-flash');
    setTimeout(() => el.classList.remove('is-flash'), 1300);
  }

  // The next top pick's art is decoded before it takes the stage, so the
  // swap doesn't stall on a big image (capped: never waits long).
  function primeWishTop(g) {
    if (!g) return Promise.resolve();
    const a = wishArt(g);
    const urls = [a.hero || a.cover, a.logo].filter(Boolean);
    const decode = (u) => { const im = new Image(); im.decoding = 'async'; im.src = u; return im.decode ? im.decode().catch(() => {}) : Promise.resolve(); };
    return Promise.race([Promise.all(urls.map(decode)), new Promise((r) => setTimeout(r, 220))]);
  }

  async function wishMakeTop(g) {
    await primeWishTop(g);
    wishTransition(() => {
      const list = wishOrder().filter((x) => x !== g);
      list.unshift(g);
      list.forEach((x, i) => { x.wishRank = i; });
    });
    saveGamesSoon();
    toast(`${g.name} is your top pick`, 'ok');
  }

  async function wishGot(g) {
    const before = wishOrder();
    if (before[0] === g) await primeWishTop(before[1]);
    const prev = { status: g.status, wishRank: g.wishRank };
    wishTransition(() => {
      g.wishlisted = false;
      if (g.status !== 'Finished') g.status = 'Playing';
      delete g.wishRank;
    });
    saveGamesSoon();
    state._shelfKey = '';
    const acts = [{ label: 'Undo', run: () => {
      if (!state.games.includes(g)) return;
      wishTransition(() => { g.wishlisted = true; g.status = prev.status; if (Number.isFinite(prev.wishRank)) g.wishRank = prev.wishRank; });
      saveGamesSoon();
      state._shelfKey = '';
    } }];
    if (!g.exePath) acts.unshift({ label: 'Set it up', run: () => openGameModal(g) });
    toast(`${g.name} moved to your library`, 'ok', acts);
  }

  async function wishRemove(g) {
    const before = wishOrder();
    if (before[0] === g) await primeWishTop(before[1]);
    const idx = state.games.indexOf(g);
    if (idx < 0) return;
    wishTransition(() => { state.games.splice(idx, 1); });
    saveGamesSoon();
    toast(`${g.name} removed from your wishlist`, 'ok', [{ label: 'Undo', run: () => {
      if (state.games.includes(g)) return;
      wishTransition(() => { state.games.splice(Math.min(idx, state.games.length), 0, g); });
      saveGamesSoon();
    } }]);
  }

  function addToWishlist(r) {
    const appId = r.appId ? Number(r.appId) : null;
    const ranked = state.games.filter((x) => gvIsWishlisted(x) && Number.isFinite(x.wishRank));
    const g = {
      id: newGameId(),
      name: String(r.name).trim(),
      steamAppId: appId,
      sgdbId: r.sgdbId || null,
      sourceId: appId ? `steam-wishlist:${appId}` : undefined,
      source: 'Wishlist',
      exePath: '',
      status: null,
      wishlisted: true,
      hours: 0,
      sessions: [],
      added: Date.now(),
    };
    if (!g.sourceId) delete g.sourceId;
    if (ranked.length) g.wishRank = Math.max(...ranked.map((x) => x.wishRank)) + 1;
    wishTransition(() => { state.games.push(g); });
    saveGamesSoon();
    flashWishItem(g);
    toast(`${g.name} added to your wishlist`, 'ok');
    enrichArt({ only: [g] }).catch(() => {});
  }

  // Steam store data (price, sale, release) for wishlisted Steam games, one
  // request at a time and at most every 12 h per game.
  function queueWishMeta(g) {
    if (!g.steamAppId || !api.steamDetails) return;
    const m = g.steamMeta;
    if (m && m.version === 3 && m.at && Date.now() - m.at < 12 * 3600000) return;
    if (g._metaTried && Date.now() - g._metaTried < 10 * 60000) return;
    g._metaTried = Date.now();
    const q = state._wishMetaQ || (state._wishMetaQ = []);
    q.push(g);
    if (!state._wishMetaBusy) pumpWishMeta();
  }
  async function pumpWishMeta() {
    state._wishMetaBusy = true;
    const q = state._wishMetaQ;
    while (q.length) {
      const g = q.shift();
      await loadSteamMeta(g).catch(() => {});
      await new Promise((r) => setTimeout(r, 300));
    }
    state._wishMetaBusy = false;
  }

  function wireWishlist(view) {
    view.addEventListener('click', (e) => {
      const t = e.target.closest('button');
      if (!t || !view.contains(t)) return;
      if (t.hasAttribute('data-wl-import')) { $('#btn-import')?.click(); return; }
      const item = t.closest('[data-wl-item]');
      const g = item && !item.classList.contains('is-ghost') && state.games.find((x) => String(x.id) === item.dataset.id);
      if (!g) return;
      if (t.hasAttribute('data-open')) openDetail(g.id);
      else if (t.hasAttribute('data-got')) wishGot(g);
      else if (t.hasAttribute('data-remove')) wishRemove(g);
      else if (t.hasAttribute('data-top')) wishMakeTop(g);
      else if (t.hasAttribute('data-store') && api.openExternal) api.openExternal(`https://store.steampowered.com/app/${encodeURIComponent(g.steamAppId)}/`);
    });

    // "Add a game you want…": Steam store and SteamGridDB, searched side by
    // side (Steam first: it has prices), plus "add it by name"
    const input = view.querySelector('[data-wl-q]');
    const menu = view.querySelector('[data-wl-menu]');
    let results = [], active = -1, seq = 0, timer = 0, note = '', pending = null, searching = false;
    const term = () => input.value.trim();
    const close = () => { menu.hidden = true; input.setAttribute('aria-expanded', 'false'); };
    const norm = (x) => String(x || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
    const have = (r) => state.games.find((g) => (r.appId && String(g.steamAppId || '') === String(r.appId))
      || (r.sgdbId && String(g.sgdbId || '') === String(r.sgdbId))
      || norm(g.name) === norm(r.name));
    const yearOf = (d) => {
      const n = Number(d);
      if (!n) return '';
      const y = new Date(n < 1e11 ? n * 1000 : n).getFullYear();
      return y > 1970 ? String(y) : '';
    };
    const paint = () => {
      const t = term();
      if (t.length < 2) { close(); return; }
      const rows = results.map((r, i) => {
        const h = have(r);
        const tag = h ? (gvIsWishlisted(h) ? 'On your wishlist' : 'In your library')
          : r.sgdbId ? [r.year, 'SteamGridDB'].filter(Boolean).join(' · ') : wishPriceText(r.price);
        const img = /^https:\/\//.test(r.image || '') ? `<img src="${esc(r.image)}" alt="" />` : `<span class="wl-res-ph">${wlIcon('star', 12)}</span>`;
        return `<button type="button" class="wl-res${i === active ? ' is-active' : ''}${h ? ' is-have' : ''}" role="option" aria-selected="${i === active}" data-i="${i}">${img}<span class="wl-res-name">${esc(r.name)}</span><span class="wl-res-tag">${esc(tag)}</span></button>`;
      });
      const mi = results.length;
      rows.push(`<button type="button" class="wl-res is-manual${active === mi ? ' is-active' : ''}" role="option" aria-selected="${active === mi}" data-i="${mi}"><span class="wl-res-ph">${wlIcon('plus', 14)}</span><span class="wl-res-name">Add “${esc(t)}”</span><span class="wl-res-tag">${results.length ? 'by name' : ''}</span></button>`);
      menu.innerHTML = (note ? `<div class="wl-res-note">${esc(note)}</div>` : '') + rows.join('');
      menu.hidden = false;
      input.setAttribute('aria-expanded', 'true');
      menu.querySelector('.is-active')?.scrollIntoView({ block: 'nearest' });
    };
    const search = () => {
      clearTimeout(timer);
      timer = 0;
      const t = term();
      const my = ++seq;
      if (t.length < 2) { results = []; active = -1; note = ''; searching = false; close(); return Promise.resolve(); }
      searching = true;
      note = 'Searching…';
      if (!results.length) active = 0;
      paint();
      let steam = null, grid = null;
      const merge = (final) => {
        if (my !== seq) return;
        const fromSteam = steam && steam.ok ? steam.data : [];
        const seen = new Set(fromSteam.map((r) => norm(r.name)));
        const fromGrid = (grid && grid.ok && Array.isArray(grid.data) ? grid.data : [])
          .filter((x) => x && x.id && x.name && !seen.has(norm(x.name)))
          .slice(0, 6)
          .map((x) => ({ name: String(x.name), sgdbId: x.id, year: yearOf(x.releaseDate) }));
        results = [...fromSteam, ...fromGrid];
        const failed = (r) => !r || !r.ok;
        note = !final ? (results.length ? '' : 'Searching…')
          : (failed(steam) && failed(grid) && !sgdbLimitText(grid) ? 'Couldn’t reach Steam or SteamGridDB. You can still add it by name.'
            : (!fromGrid.length && sgdbLimitText(grid)) || '');
        if (final) searching = false;
        if (active < 0 || active > results.length) active = 0;
        paint();
      };
      const askGrid = () => (api.sgdbGames && t.length >= 3 ? api.sgdbGames(t) : Promise.resolve(null)).catch(() => null)
        .then((r) => { grid = r; merge(false); });
      const own = hasOwnSgdbKey();
      const steamP = (api.steamSearch ? api.steamSearch(t) : Promise.resolve(null)).catch(() => null).then((r) => { steam = r; merge(false); });
      // own key: both at once. Shared cache: SteamGridDB only if Steam came up short.
      pending = (own
        ? Promise.all([steamP, askGrid()])
        : steamP.then(() => (my === seq && (!steam || !steam.ok || steam.data.length < 3) ? askGrid() : null))
      ).then(() => merge(true));
      return pending;
    };
    const pick = (i) => {
      const t = term();
      const r = i >= 0 && i < results.length ? results[i] : (t ? { name: t, appId: null } : null);
      if (!r) return;
      const h = have(r);
      if (h) {
        if (gvIsWishlisted(h)) { toast(`${h.name} is already on your wishlist`, 'ok'); flashWishItem(h); }
        else toast(`${h.name} is already in your library`, 'ok');
        return;
      }
      input.value = '';
      results = []; active = -1; note = '';
      close();
      addToWishlist(r);
    };
    input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(search, 260); });
    input.addEventListener('keydown', async (e) => {
      if (e.key === 'Escape') {
        if (!menu.hidden || input.value) {
          e.preventDefault(); e.stopPropagation();
          if (!menu.hidden) close(); else input.value = '';
        }
        return;
      }
      const n = results.length + 1;
      if (e.key === 'ArrowDown' && !menu.hidden) { e.preventDefault(); active = (active + 1) % n; paint(); }
      else if (e.key === 'ArrowUp' && !menu.hidden) { e.preventDefault(); active = (active - 1 + n) % n; paint(); }
      else if (e.key === 'Enter') {
        e.preventDefault();
        if (term().length < 1) return;
        if (timer || searching) { await (timer ? search() : pending); }
        pick(active < 0 ? results.length : active);
      }
    });
    menu.addEventListener('pointerdown', (e) => e.preventDefault());
    menu.addEventListener('click', (e) => { const b = e.target.closest('[data-i]'); if (b) pick(Number(b.dataset.i)); });
    input.addEventListener('blur', () => setTimeout(close, 100));
    input.addEventListener('focus', () => { if (term().length >= 2 && (results.length || note)) paint(); });
  }

  function emptyFilterText() {
    if (state.query && state.query.trim()) {
      return { title: 'No matches', sub: 'Try a different search term.', line: 'Nothing matches this search.' };
    }
    if (state.filter === 'Want') {
      return { title: 'Your wishlist is empty', sub: 'Star a game to save it here.', line: 'Your wishlist is empty — star a game to save it here.' };
    }
    if (state.filter === 'Finished') {
      return { title: 'Nothing finished yet', sub: 'Mark a game as finished from its page.', line: 'Nothing finished yet — mark a game as finished from its page.' };
    }
    if (state.filter === 'Active') {
      return { title: 'Nothing active', sub: 'Games you opened in the last 7 days show up here.', line: 'Nothing opened in the last 7 days.' };
    }
    return { title: 'No matches', sub: 'Try a different filter or search term.', line: 'Nothing matches this filter.' };
  }

  // Tiles are reused by id; repaint the cover/title only when they changed.
  function paintShelfTile(tile, g) {
    const src = g._cover || g.coverUrl || '';
    const name = String(g.name || '');
    const r = gvIsWishlisted(g) ? 0 : Rating.value(g);
    if (tile._src === src && tile._name === name && tile._r === r) return;
    tile._src = src;
    tile._name = name;
    tile._r = r;
    tile.title = name;
    tile.innerHTML = `${src ? `<img src="${esc(toFileUrl(src))}" loading="lazy" decoding="async" width="172" height="236" alt="" />` : coverFallbackMarkup()}<span class="shelf-tile-label">${esc(name)}</span>${r ? `<span class="tile-rating${r >= Rating.PEAK ? ' is-peak' : ''}">${ratingChipHtml(r, String(g.id))}</span>` : ''}`;
    const img = tile.querySelector('img');
    fadeInOnLoad(img);
    if (img) {
      img.addEventListener('error', () => {
        if (!img.isConnected) return;
        img.insertAdjacentHTML('afterend', coverFallbackMarkup());
        img.remove();
      }, { once: true });
    }
  }

  function renderShelf() {
    const list = filteredGames();
    const stage = $('#shelf-stage');
    const strip = $('#shelf-strip');

    if (!list.length) {
      const firstRun = state.games.length === 0;
      const empty = emptyFilterText();
      stage.innerHTML = firstRun
        ? `<div class="onboard"><div class="onboard-inner">
             <span class="onboard-kicker">GameVault</span>
             <h2>Your vault is empty</h2>
             <p>Bring your library in from Steam, scan a folder, or add one game by hand.</p>
             <div class="onboard-actions">
               <button class="btn btn-primary" data-onboard-import>Import games</button>
               <button class="btn" data-onboard-add>Add manually</button>
             </div>
             <p class="onboard-hint">Press <kbd>Ctrl F</kbd> any time to search or run a command.</p>
           </div></div>`
        : `<div class="shelf-empty">${esc(empty.line)}</div>`;
      strip.innerHTML = '';
      shelfDom.built = false;
      state._shelfKey = '';
      state._shelfShown = '';
      state._stageVisual = '';
      const railEl = document.querySelector('.shelf-rail');
      if (railEl) railEl.hidden = true;
      const imp = stage.querySelector('[data-onboard-import]');
      const add = stage.querySelector('[data-onboard-add]');
      if (imp) imp.onclick = openImportModal;
      if (add) add.onclick = () => openGameModal(null);
      refreshCounts();
      syncShelfNav();
      return;
    }

    if (!state.shelfId || !list.some((g) => String(g.id) === state.shelfId)) {
      state.shelfId = String(list[0].id);
    }
    const current = list.find((g) => String(g.id) === state.shelfId) || list[0];

    const railEl2 = document.querySelector('.shelf-rail');
    if (railEl2) railEl2.hidden = false;
    renderShelfStage(current);

    const key = list.map((g) => String(g.id)).join(',');
    // _shelfKey is cleared to force a repaint; _shelfShown is what was really on screen
    const prevKey = state._shelfShown || '';
    const inPlace = state._shelfFilter === state.filter && isRemovalOnly(prevKey ? prevKey.split(',') : [], key.split(','));
    state._shelfFilter = state.filter;
    state._shelfShown = key;
    if (key !== state._shelfKey && inPlace) {
      // a game left this filter: keep the scroll, fade it out, close the gap
      state._shelfKey = key;
      strip._max = null;
      const keep = new Set(key.split(','));
      const tiles = Array.from(strip.querySelectorAll('.shelf-tile'));
      flipLeave(strip, tiles.filter((t) => keep.has(t.dataset.id)), tiles.filter((t) => !keep.has(t.dataset.id)), () => {
        for (const t of tiles) if (!keep.has(t.dataset.id)) t.remove();
      });
      const byId = new Map(list.map((g) => [String(g.id), g]));
      for (const tile of strip.querySelectorAll('.shelf-tile')) {
        const g = byId.get(tile.dataset.id);
        if (g) paintShelfTile(tile, g);
        tile.classList.toggle('is-active', tile.dataset.id === state.shelfId);
        tile.setAttribute('aria-selected', String(tile.dataset.id === state.shelfId));
      }
    } else if (key !== state._shelfKey) {
      state._shelfKey = key;
      strip.scrollLeft = 0;
      strip._max = null;
      // Reuse tiles by id instead of re-parsing the whole strip: switching
      // filters no longer re-decodes every cover or relayouts 43 nodes.
      const existing = new Map(Array.from(strip.querySelectorAll('.shelf-tile')).map((t) => [t.dataset.id, t]));
      const frag = document.createDocumentFragment();
      for (const g of list) {
        const id = String(g.id);
        let tile = existing.get(id);
        if (tile) {
          existing.delete(id);
        } else {
          tile = document.createElement('button');
          tile.className = 'shelf-tile';
          tile.dataset.id = id;
          tile.setAttribute('role', 'option');
          tile.onclick = () => { if (shelfDragMoved) return; selectShelfGame(tile.dataset.id); };
          tile.ondblclick = () => openDetail(tile.dataset.id);
        }
        paintShelfTile(tile, g);
        tile.classList.toggle('is-active', id === state.shelfId);
        tile.setAttribute('aria-selected', String(id === state.shelfId));
        frag.appendChild(tile);
      }
      for (const leftover of existing.values()) leftover.remove();
      strip.appendChild(frag);
    } else {
      const byId = new Map(list.map((g) => [String(g.id), g]));
      for (const tile of strip.querySelectorAll('.shelf-tile')) {
        const g = byId.get(tile.dataset.id);
        if (g) paintShelfTile(tile, g);
        tile.classList.toggle('is-active', tile.dataset.id === state.shelfId);
        tile.setAttribute('aria-selected', String(tile.dataset.id === state.shelfId));
      }
    }

    refreshCounts();
    syncShelfNav();
    requestAnimationFrame(syncShelfNav);
    setTimeout(syncShelfNav, 120);
    const idle = window.requestIdleCallback || ((fn) => setTimeout(fn, 400));
    idle(() => {
      for (const g of list.slice(0, 8)) preloadHero(heroUrlOf(g));
    });
  }

  function syncShelfNav() {
    const strip = $('#shelf-strip');
    const prev = $('#strip-prev');
    const next = $('#strip-next');
    if (!strip || !prev || !next) return;

    const max = Math.max(0, strip.scrollWidth - strip.clientWidth);
    if (max <= 2) {                 // nothing to scroll: hide both, don't lock
      prev.disabled = true;
      next.disabled = true;
      return;
    }
    prev.disabled = strip.scrollLeft <= 2;
    next.disabled = strip.scrollLeft >= max - 2;
  }

  async function selectShelfGame(id) {
    if (String(id) === state.shelfId) return;
    sfx('move', null, $('#shelf-strip').querySelector(`.shelf-tile[data-id="${CSS.escape(String(id))}"]`));
    state.shelfId = String(id);
    for (const tile of $('#shelf-strip').querySelectorAll('.shelf-tile')) {
      tile.classList.toggle('is-active', tile.dataset.id === state.shelfId);
      tile.setAttribute('aria-selected', String(tile.dataset.id === state.shelfId));
    }
    const g = state.games.find((x) => String(x.id) === state.shelfId);
    if (g) {
      await preloadHero(heroUrlOf(g));
      // another tile may have been picked while the hero decoded: the stage
      // must always show the game that Play acts on
      if (state.shelfId !== String(g.id)) return;
      renderShelfStage(g);
    }
    revealShelfTile(state.shelfId);
  }

  // Repaint the shelf stage only if it is showing this game.
  function refreshStage(g) {
    if (!g || state.view !== 'shelf' || !shelfDom.built) return;
    if (state.shelfId !== String(g.id)) return;
    renderShelfStage(g);
  }

  // Critically-damped spring on scrollLeft. Retargetable, no fixed duration,
  // and it never fights the wheel because the wheel calls stopSpring first.
  function springTo(el, target) {
    const max = Math.max(0, el.scrollWidth - el.clientWidth);
    target = Math.max(0, Math.min(max, target));
    const st = el._spring || (el._spring = { x: el.scrollLeft, v: 0, raf: null, target });
    st.target = target;
    if (prefersReducedMotion()) {
      if (st.raf) cancelAnimationFrame(st.raf);
      st.raf = null;
      st.v = 0;
      st.x = target;
      el.scrollLeft = target;
      return;
    }
    if (st.raf) return;

    let last = performance.now();
    const step = (now) => {
      const dt = Math.min(32, now - last) / 1000;
      last = now;
      const k = 220;
      const c = 30;
      const a = -k * (st.x - st.target) - c * st.v;
      st.v += a * dt;
      st.x += st.v * dt;
      if (st.x < 0) { st.x = 0; st.v = 0; }
      if (st.x > max) { st.x = max; st.v = 0; }
      el.scrollLeft = st.x;

      if (Math.abs(st.v) < 0.5 && Math.abs(st.x - st.target) < 0.5) {
        el.scrollLeft = st.target;
        st.x = st.target;
        st.v = 0;
        st.raf = null;
        return;
      }
      st.raf = requestAnimationFrame(step);
    };
    st.raf = requestAnimationFrame(step);
  }

  function stopSpring(el) {
    const st = el._spring;
    if (!st) return;
    if (st.raf) cancelAnimationFrame(st.raf);
    st.raf = null;
    st.v = 0;
    st.x = el.scrollLeft;
  }

  function smoothScrollBy(el, delta) { springTo(el, el.scrollLeft + delta); }

  // Only move the rail when the tile is actually out of the comfort band.
  // Re-centring a visible tile is what made selection feel like a teleport.
  function revealShelfTile(id) {
    const strip = $('#shelf-strip');
    const tile = strip.querySelector(`[data-id="${CSS.escape(String(id))}"]`);
    if (!tile) return;

    const left = strip.scrollLeft;
    const right = left + strip.clientWidth;
    const pad = 32;
    const tileLeft = tile.offsetLeft;
    const tileRight = tileLeft + tile.offsetWidth;

    if (tileLeft >= left + pad && tileRight <= right - pad) return;

    const target = tileLeft < left + pad
      ? tileLeft - pad - 8
      : tileRight - strip.clientWidth + pad + 8;
    springTo(strip, target);
  }

  // Persistent stage DOM: two art/poster layers crossfade, text updates in place.
  const shelfDom = { built: false, front: 0 };

  function ensureShelfDom() {
    if (shelfDom.built) return;
    const stage = $('#shelf-stage');
    stage.innerHTML = `
      <div class="shelf-art layer" data-layer="0"></div>
      <div class="shelf-art layer" data-layer="1"></div>
      <div class="shelf-shade"></div>
      <div class="shelf-poster layer" data-layer="0"></div>
      <div class="shelf-poster layer" data-layer="1"></div>
      <div class="shelf-content">
        <span class="shelf-kicker" data-kicker></span>
        <h2 class="shelf-title" data-title></h2>
        <span class="gv-logo3d shelf-logo" data-logo3d data-shelf-logo hidden><img class="gvx-logo" alt="" /><i class="gv-logo-sheen" aria-hidden="true"><b></b></i></span>
        <div class="shelf-meta" data-meta></div>
        <div class="shelf-actions">
          <button class="btn btn-primary" data-play>
            <svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
            <span data-play-label>Play</span>
          </button>
          <button class="btn" data-open>Details</button>
        </div>
      </div>`;

    shelfDom.arts = stage.querySelectorAll('.shelf-art');
    shelfDom.posters = stage.querySelectorAll('.shelf-poster');
    shelfDom.title = stage.querySelector('[data-title]');
    shelfDom.logo = stage.querySelector('[data-shelf-logo]');
    shelfDom.logoImg = shelfDom.logo.querySelector('img');
    shelfDom.logoSheen = shelfDom.logo.querySelector('.gv-logo-sheen');
    // a logo that fails to load falls back to the plain title
    shelfDom.logoImg.addEventListener('error', () => {
      shelfDom.logo.hidden = true;
      shelfDom.title.hidden = false;
      shelfDom.logoFailed = shelfDom.logoImg.getAttribute('src');
    });
    logoTilt(shelfDom.logo);
    shelfDom.kicker = stage.querySelector('[data-kicker]');
    shelfDom.meta = stage.querySelector('[data-meta]');
    shelfDom.playLabel = stage.querySelector('[data-play-label]');
    shelfDom.playBtn = stage.querySelector('[data-play]');
    shelfDom.built = true;

    stage.querySelector('[data-play]').onclick = () => {
      const g = state.games.find((x) => String(x.id) === state.shelfId);
      if (g) togglePlay(g.id);
    };
    stage.querySelector('[data-open]').onclick = () => {
      if (state.shelfId) openDetail(state.shelfId);
    };
  }

  function renderShelfStage(g) {
    ensureShelfDom();
    const id = String(g.id);
    const live = state.live[id];
    const running = typeof live === 'number';
    const heroArt = g._noHero ? '' : (g._hero || g.heroUrl || '');
    const art = heroArt || g._cover || g.coverUrl || '';

    const back = shelfDom.front === 0 ? 1 : 0;
    const artBack = shelfDom.arts[back];
    const posterBack = shelfDom.posters[back];

    const posterSrc = g._cover || g.coverUrl;
    const visualKey = `${art}|${posterSrc}`;
    if (state._stageVisual !== visualKey) {
      const oldArt = shelfDom.arts[shelfDom.front];
      state._stageVisual = visualKey;
      artBack.style.backgroundImage = art ? cssUrl(art) : '';
      artBack.classList.toggle('is-fallback', !heroArt && !!art);
      posterBack.style.backgroundImage = posterSrc ? cssUrl(posterSrc) : '';
      posterBack.innerHTML = posterSrc ? '' : coverFallbackMarkup();
      posterBack.classList.toggle('is-empty', !posterSrc);
      posterBack.style.display = '';

      // swap with a crossfade
      shelfDom.arts[shelfDom.front].classList.remove('is-on');
      shelfDom.posters[shelfDom.front].classList.remove('is-on');
      void artBack.offsetWidth;
      artBack.classList.add('is-on');
      posterBack.classList.add('is-on');
      shelfDom.front = back;
      clearTimeout(shelfDom.cleanup);
      shelfDom.cleanup = setTimeout(() => {
        if (oldArt) oldArt.style.backgroundImage = '';
      }, 700);
    }
    if (!prefersReducedMotion()) {
      const content = $('#shelf-stage .shelf-content');
      if (content && state._heroShown !== id) {
        state._heroShown = id;
        content.animate(
          [{ opacity: 0, transform: 'translateY(5px)' }, { opacity: 1, transform: 'none' }],
          { duration: 600, easing: 'cubic-bezier(0.22, 0.8, 0.3, 1)' }
        );
      }
    }

    const wish = gvIsWishlisted(g);
    const base = Number(g.hours) || 0;
    shelfDom.kicker.textContent = wish
      ? statusLabel(g)
      : `${running ? 'Now playing' : statusLabel(g)} · ${fmtHours(running ? base + live / 60 : base)}`;
    shelfDom.title.textContent = g.name || '';
    const logoSrc = g._logo || g.logoUrl || '';
    const logoUrl = logoSrc ? toFileUrl(logoSrc) : '';
    const useLogo = !!logoUrl && shelfDom.logoFailed !== logoUrl;
    if (useLogo && shelfDom.logoImg.getAttribute('src') !== logoUrl) {
      shelfDom.logoImg.src = logoUrl;
      shelfDom.logoImg.alt = g.name || '';
      shelfDom.logoSheen.style.setProperty('--logo', cssUrl(logoSrc));
    }
    shelfDom.logo.hidden = !useLogo;
    shelfDom.title.hidden = useLogo;
    const sessionCount = gvSessions(g).length;
    shelfDom.meta.innerHTML = [
      g.source ? `<span>${esc(g.source)}</span>` : '',
      wish ? '' : `<span>${sessionCount} session${sessionCount === 1 ? '' : 's'}</span>`,
      g.lastPlayed ? `<span>played ${esc(fmtDate(g.lastPlayed))}</span>` : '',
    ].filter(Boolean).join('<span class="card-dot">•</span>') + (wish ? '' : ratingChipHtml(Rating.value(g), String(g.id)));

    // wishlisted games are not in the library yet: nothing to play
    shelfDom.playBtn.hidden = wish;
    swapLabel(shelfDom.playLabel, running ? 'Stop'
      : live === 'launching' ? 'Launching…'
        : live === 'stopping' ? 'Stopping…' : 'Play');
    shelfDom.playBtn.classList.toggle('is-busy', live === 'launching' || live === 'stopping');
    shelfDom.playBtn.title = live === 'launching' ? 'Launching — click to cancel' : '';
  }

  // ---------------------------------------------------------------------------
  // Grid (built once, toggled afterwards)
  // ---------------------------------------------------------------------------

  function coverFallbackMarkup() {
    return `<span class="cover-fallback" aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">
        <path d="M17.32 5H6.68a4 4 0 0 0-3.978 3.59c-.006.052-.01.101-.017.152C2.604 9.416 2 14.456 2 16a3 3 0 0 0 3 3c1 0 1.5-.5 2-1l1.414-1.414A2 2 0 0 1 9.828 16h4.344a2 2 0 0 1 1.414.586L17 18c.5.5 1 1 2 1a3 3 0 0 0 3-3c0-1.545-.604-6.584-.685-7.258-.007-.05-.011-.1-.017-.151A4 4 0 0 0 17.32 5z"/>
        <path d="M6 11h4M8 9v4"/>
        <path d="M15 12h.01M18 10h.01"/>
      </svg>
    </span>`;
  }

  // Cards without artwork get a tint and initials derived from the title, so
  // a library of fallbacks still reads as distinct games.
  const CARD_LETTER = /\p{L}\p{M}*/u;
  function cardInitials(name) {
    const out = [];
    for (const word of String(name || '').split(/\s+/)) {
      const m = CARD_LETTER.exec(word);
      if (m) out.push(m[0].normalize('NFC').toLocaleUpperCase());
      if (out.length === 2) break;
    }
    return out.join('') || '?';
  }
  function cardHue(name) {
    let h = 0;
    for (const ch of String(name || '')) h = (h * 31 + ch.codePointAt(0)) % 360;
    return h;
  }
  function relativeDay(ts) {
    if (!ts) return '';
    const days = Math.floor((Date.now() - ts) / 86400000);
    if (days <= 0) return 'today';
    if (days === 1) return 'yesterday';
    if (days < 7) return `${days} days ago`;
    if (days < 30) return `${Math.floor(days / 7)} wk ago`;
    return fmtDate(ts);
  }

  function buildCard(g, index = 0) {
    const el = document.createElement('article');
    el.className = 'card';
    el.dataset.id = String(g.id);
    el.tabIndex = 0;

    const media = document.createElement('div');
    media.className = 'card-media';
    media.dataset.initials = cardInitials(g.name);
    media.style.setProperty('--card-hue', String(cardHue(g.name)));

    const shade = document.createElement('div');
    shade.className = 'card-shade';
    media.appendChild(shade);

    const status = document.createElement('span');
    status.className = 'card-status';
    media.appendChild(status);

    const rating = document.createElement('span');
    rating.className = 'card-rating';
    rating.hidden = true;
    media.appendChild(rating);

    const play = document.createElement('button');
    play.className = 'card-play';
    play.title = 'Launch';
    play.dataset.kind = 'play';
    play.innerHTML = '<svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor"><path d="M8 5.5v13l10.5-6.5z"/></svg><span>Play</span>';
    media.appendChild(play);

    const body = document.createElement('div');
    body.className = 'card-body';

    const title = document.createElement('h3');
    title.className = 'card-title';
    title.textContent = g.name || 'Untitled';
    body.appendChild(title);

    const meta = document.createElement('div');
    meta.className = 'card-meta';
    const hours = document.createElement('span');
    hours.className = 'card-hours';
    meta.appendChild(hours);
    const last = document.createElement('span');
    last.className = 'card-last';
    meta.appendChild(last);
    body.appendChild(meta);
    if (g.source) el.title = `${g.name || 'Untitled'} · ${g.source}`;

    el.append(media, body);

    const refs = { el, media, img: null, src: null, eager: index < 12, hours, last, status, play, title, rating };
    setCardImage(refs, g._cover || g.coverUrl || '');

    play.addEventListener('click', (e) => { e.stopPropagation(); togglePlay(g.id); });
    el.addEventListener('click', () => openDetail(g.id));
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(g.id); }
    });
    el.addEventListener('dblclick', () => togglePlay(g.id));

    return refs;
  }

  // Swap a card's cover in place when the artwork changes (refresh, edit,
  // thumbnail cache filling in) instead of keeping the first URL forever.
  function setCardImage(ref, src) {
    const want = src || '';
    if (ref.src === want) return;
    ref.src = want;
    const media = ref.media;
    if (ref.img) { ref.img.remove(); ref.img = null; }
    const oldFallback = media.querySelector('.cover-fallback');
    if (oldFallback) oldFallback.remove();
    if (!want) {
      media.insertAdjacentHTML('afterbegin', coverFallbackMarkup());
      return;
    }
    const img = document.createElement('img');
    img.className = 'card-img';
    img.loading = ref.eager ? 'eager' : 'lazy';
    img.decoding = 'async';
    img.alt = '';
    img.addEventListener('load', () => img.classList.add('is-loaded'), { once: true });
    img.addEventListener('error', () => {
      if (ref.img !== img) return;
      img.remove();
      ref.img = null;
      media.insertAdjacentHTML('afterbegin', coverFallbackMarkup());
    }, { once: true });
    img.src = toFileUrl(want);
    media.insertBefore(img, media.firstChild);
    ref.img = img;
  }

  function ensureCards() {
    state.games.forEach((g, i) => {
      const id = String(g.id);
      if (!cards.has(id)) cards.set(id, buildCard(g, i));
    });
    for (const [id, ref] of cards) {
      if (!state.games.some((g) => String(g.id) === id)) {
        ref.el.remove();
        cards.delete(id);
      }
    }
  }

  function renderGrid({ rebuild = false } = {}) {
    ensureCards();
    const grid = $('#grid');
    const list = filteredGames();
    const visible = new Set(list.map((g) => String(g.id)));
    const order = list.map((g) => String(g.id)).join(',');
    const prevIds = state._lastOrder ? state._lastOrder.split(',') : [];
    const inPlace = !rebuild && !grid.hidden && grid.offsetParent && state._gridFilter === state.filter
      && isRemovalOnly(prevIds, order ? order.split(',') : []);
    state._gridFilter = state.filter;

    const apply = () => {
      for (const g of state.games) {
        const id = String(g.id);
        const ref = cards.get(id);
        if (!ref) continue;
        const show = visible.has(id);
        ref.el.hidden = !show;
        if (show) updateCard(g);
      }
      if (rebuild || state._lastOrder !== order) {
        for (const g of list) grid.appendChild(cards.get(String(g.id)).el);
        state._lastOrder = order;
      }
    };
    if (inPlace) {
      const els = (ids) => ids.map((id) => cards.get(id)).filter(Boolean).map((r) => r.el);
      const scroller = $('#library') || grid;
      flipLeave(scroller, els(prevIds.filter((id) => visible.has(id))), els(prevIds.filter((id) => !visible.has(id))), apply);
    } else {
      apply();
    }

    const empty = $('#empty');
    const hasAny = state.games.length > 0;
    empty.hidden = list.length > 0;
    if (!list.length) {
      const text = emptyFilterText();
      $('#empty-title').textContent = hasAny ? text.title : 'Your vault is empty';
      $('#empty-sub').textContent = hasAny
        ? text.sub
        : 'Import from Steam or another launcher, scan a folder, or add a game by hand.';
      $('#empty-cta').style.display = hasAny ? 'none' : '';
    }

    refreshCounts();
  }

  // Card + open game page. The page is updated even when no grid card exists
  // (cards are only built once the grid layout has been shown).
  function updateCard(g) {
    const id = String(g.id);
    if (state.selectedId === id) updateDetailLive(g);
    const ref = cards.get(id);
    if (!ref) return;
    const live = state.live[id];
    const running = typeof live === 'number';
    const launching = live === 'launching';
    const wish = gvIsWishlisted(g);

    ref.title.textContent = g.name || 'Untitled';
    ref.media.dataset.initials = cardInitials(g.name);
    ref.media.style.setProperty('--card-hue', String(cardHue(g.name)));
    setCardImage(ref, g._cover || g.coverUrl || '');
    ref.el.classList.toggle('has-art', !!ref.src);
    ref.el.classList.toggle('is-running', running || launching);

    const base = Number(g.hours) || 0;
    const total = running ? base + live / 60 : base;
    ref.hours.textContent = wish ? 'Wishlist' : running ? `${fmtHours(total)} · playing now` : fmtHours(total);
    if (ref.last) ref.last.textContent = running || wish || !g.lastPlayed ? '' : relativeDay(g.lastPlayed);

    // the pill only says something worth saying: Running, Finished, Wishlist
    const pill = running ? 'Running' : statusLabel(g) === 'Playing' ? '' : statusLabel(g);
    ref.status.textContent = pill;
    ref.status.dataset.status = pill;
    ref.status.hidden = !pill;

    if (ref.rating) {
      const r = wish ? 0 : Rating.value(g);
      ref.rating.hidden = !r;
      if (r) {
        const tier = Rating.tier(r);
        if (ref.rating.dataset.tier !== tier || ref.rating.dataset.r !== String(r)) {
          ref.rating.dataset.tier = tier;
          ref.rating.classList.toggle('peak-foil', tier === 'peak');
          ref.rating.dataset.r = String(r);
          ref.rating.innerHTML = r >= Rating.PEAK ? `<span class="peak-word">Peak</span>` : `${STAR_ICON}<span>${Rating.label(r)}</span>`;
          ref.rating.toggleAttribute('data-peak-open', tier === 'peak');
          ref.rating.title = r >= Rating.PEAK ? 'Your rating: PEAK' : `Your rating: ${Rating.label(r)} / 10`;
        }
      }
    }

    ref.play.hidden = wish && !running;
    ref.play.title = running ? 'Stop' : launching ? 'Launching… (click to cancel)' : live === 'stopping' ? 'Stopping…' : 'Launch';
    const playKind = running ? 'stop' : 'play';
    if (ref.play.dataset.kind !== playKind) {
      ref.play.dataset.kind = playKind;
      ref.play.innerHTML = running
        ? '<svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2.5"/></svg><span>Stop</span>'
        : '<svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor"><path d="M8 5.5v13l10.5-6.5z"/></svg><span>Play</span>';
    }
  }

  // One place to repaint everything that shows a game's live state.
  function refreshGameUi(g) {
    if (!g) return;
    updateCard(g);
    refreshStage(g);
  }

  // ---------------------------------------------------------------------------
  // Hero
  // ---------------------------------------------------------------------------

  // ---------------------------------------------------------------------------
  // Detail panel
  // ---------------------------------------------------------------------------

  function openDetail(id) {
    window.__gvPerfMark && window.__gvPerfMark('detail');
    sfx('open');
    if (state.settingsOpen) closeSettings({ restoreFocus: false });
    const active = document.activeElement;
    state._focusReturn = (active && active.id === 'q') ? null : active;
    state.selectedId = String(id);
    renderDetail();
    $('#topbar').hidden = false;
    const fb = $('#filterbar'); if (fb) fb.hidden = true;
    $('#library').hidden = true;
    $('#shelf').hidden = true;
    if ($('#wishlist-view')) $('#wishlist-view').hidden = true;
    if ($('#activity-view')) $('#activity-view').hidden = true;
    const view = $('#game-view');
    view.hidden = false;
    view.scrollTop = 0;
    view.querySelector('.gvx-hero-body')?.focus({ preventScroll: true });
    fadeIn(view);
    document.title = `${state.games.find((g) => String(g.id) === String(id))?.name || 'GameVault'} — GameVault`;
  }

  function closeDetail() {
    if (state.selectedId) sfx('close');
    stopDetailTick();
    state.selectedId = null;
    const view = $('#game-view');
    view.hidden = true;
    view.innerHTML = '';
    $('#topbar').hidden = false;
    const fb = $('#filterbar'); if (fb) fb.hidden = false;
    renderLibrary();
    fadeIn(currentPane());
    document.title = 'GameVault';
    const back = state._focusReturn;
    if (back && typeof back.focus === 'function') back.focus();
  }

  // ---------------------------------------------------------------------------
  // Game detail — "Marquee"
  // ---------------------------------------------------------------------------

  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

  function gvSessions(g) {
    return (g.sessions || []).filter((x) => x && Number.isFinite(x.start) && Number.isFinite(x.duration) && x.duration > 0);
  }

  function gvStatusOf(g) {
    if (g.status === 'Playing' || g.status === 'Finished') return g.status;
    return null;
  }

  function gvIsWishlisted(g) {
    return !!g.wishlisted || g.status === 'Want';
  }

  let detailTick = null;

  function stopDetailTick() {
    if (detailTick) { clearInterval(detailTick); detailTick = null; }
  }

  function detailMeta(g) {
    const live = state.live[String(g.id)];
    const running = typeof live === 'number';
    const total = (Number(g.hours) || 0) + (running ? live / 60 : 0);
    const parts = [];
    if (gvIsWishlisted(g)) {
      parts.push('Wishlist');
      if (g.added) parts.push(`since ${fmtDate(g.added)}`);
      return parts.join('<span class="gvx-dot">·</span>');
    }
    if (g.source) parts.push(esc(g.source));
    if (g.added) parts.push(`added ${fmtDate(g.added)}`);
    if (total > 0) parts.push(`${fmtHours(total)} played`);
    if (g.lastPlayed) parts.push(`last played ${fmtDate(g.lastPlayed)}`);
    return parts.join('<span class="gvx-dot">·</span>');
  }

  function detailTimerHtml(g) {
    const live = state.live[String(g.id)];
    if (typeof live === 'number') {
      return `<span class="gvx-timer-label">SESSION</span><span class="gvx-timer-value is-live" data-timer-value>00:00</span>`;
    }
    const last = gvSessions(g).slice().sort((a, b) => b.start - a.start)[0];
    const label = last ? 'LAST SESSION' : 'PLAYTIME';
    const value = last ? Sessions.formatDuration(last.duration) : fmtHours(g.hours);
    return `<span class="gvx-timer-label">${label}</span><span class="gvx-timer-value" data-timer-value>${value}</span>`;
  }

  function hhmm(ts) {
    const d = new Date(ts);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }

  // Whether the rail has anything beyond the always-present "At a glance"
  // card (pulse or specs). The rail itself is always rendered for owned games.
  function railHasData(g) {
    const meta = g.steamMeta || {};
    return !!((meta.metacritic && meta.metacritic.score) || Number(g.timeToBeat) > 0 || Number(g.rating) > 0
      || (meta.recommended && meta.recommended.length) || (meta.minimum && meta.minimum.length));
  }

  function railHtml(g) {
    const meta = g.steamMeta || {};
    const pulse = [];
    if (meta.metacritic && meta.metacritic.score) pulse.push([String(meta.metacritic.score), 'Metacritic']);
    if (Number(g.timeToBeat) > 0) pulse.push([`~${Math.round(Number(g.timeToBeat))}h`, 'To beat']);
    if (Rating.value(g) > 0) pulse.push([Rating.label(Rating.value(g)), 'Your rating']);

    const KEEP = ['OS', 'Processor', 'Memory', 'Graphics', 'Storage'];
    const specs = ((meta.recommended && meta.recommended.length)
      ? meta.recommended
      : (meta.minimum && meta.minimum.length ? meta.minimum : []))
      .filter(([key]) => KEEP.includes(key));

    const facts = [];
    const liveMins = state.live[String(g.id)];
    const liveHours = typeof liveMins === 'number' ? liveMins / 60 : 0;
    const totalHours = (Number(g.hours) || 0) + liveHours;
    facts.push(['Playtime', totalHours > 0 ? fmtHours(totalHours) : '—']);
    facts.push(['Last played', g.lastPlayed ? fmtDate(g.lastPlayed) : 'Never']);
    if (g.added) facts.push(['Added', fmtDate(g.added)]);
    if (g.source) facts.push(['Source', g.source]);

    return `
      <div class="gvx-card">
        <div class="gvx-card-head">AT A GLANCE</div>
        <dl class="gvx-specs">${facts.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>
      </div>
      ${pulse.length ? `<div class="gvx-card">
        <div class="gvx-card-head">GAME PULSE</div>
        <div class="gvx-pulse">${pulse.map(([value, label]) => `<div class="gvx-pulse-item"><b>${esc(value)}</b><span>${esc(label)}</span></div>`).join('')}</div>
      </div>` : ''}
      ${specs.length ? `<div class="gvx-card">
        <div class="gvx-card-head">SPECS <span>${meta.recommended && meta.recommended.length ? 'recommended' : 'minimum'}</span></div>
        <dl class="gvx-specs">${specs.map(([key, value]) => `<div><dt>${esc(key)}</dt><dd title="${esc(value)}">${esc(value)}</dd></div>`).join('')}</dl>
      </div>` : ''}
    `;
  }

  function paintRail(g) {
    const rail = document.querySelector('#game-view [data-rail]');
    if (rail) { rail.innerHTML = railHtml(g) + '<div class="gvx-card sv-card" data-saves-card></div>'; paintSavesCard(g); }
  }

  async function loadSteamMeta(g) {
    if (!g.steamAppId || !api.steamDetails) return;
    const ttl = gvIsWishlisted(g) ? 12 * 3600000 : 14 * 86400000;
    const fresh = g.steamMeta && g.steamMeta.version === 3 && g.steamMeta.at && (Date.now() - g.steamMeta.at < ttl);
    if (fresh) return;
    const res = await api.steamDetails(g.steamAppId).catch(() => null);
    if (!res || !res.ok || !res.data) return;
    const hadData = railHasData(g);
    g.steamMeta = { ...res.data, version: 3, at: Date.now() };
    saveGamesSoon();
    if (gvIsWishlisted(g) && state.filter === 'Want' && !state.selectedId && !state.settingsOpen) renderWishlist();
    if (state.selectedId !== String(g.id) || gvIsWishlisted(g)) return;
    // the rail element always exists on an owned game's page: repaint it in
    // place (no full re-render) when there is something new to show
    const rail = document.querySelector('#game-view [data-rail]');
    if (!rail) renderDetail();
    else if (hadData || railHasData(g)) paintRail(g);
  }

  const heroDecodes = new Map();
  function preloadHero(url) {
    if (!url) return Promise.resolve();
    if (heroDecodes.has(url)) return heroDecodes.get(url);
    const img = new Image();
    img.decoding = 'async';
    img.src = toFileUrl(url);
    const p = (img.decode ? img.decode() : Promise.resolve()).catch(() => {});
    heroDecodes.set(url, p);
    if (heroDecodes.size > 20) heroDecodes.delete(heroDecodes.keys().next().value);
    return p;
  }
  function heroUrlOf(g) {
    if (!g) return '';
    const hero = g._noHero ? '' : (g._hero || g.heroUrl || '');
    return hero || g._cover || g.coverUrl || '';
  }

  function animateDetailIn(view, g) {
    if (prefersReducedMotion() || state._detailAnimated === String(g.id)) return;
    state._detailAnimated = String(g.id);
    const root = view.firstElementChild;
    if (root) {
      root.animate(
        [{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'none' }],
        { duration: 480, easing: 'cubic-bezier(0.22, 0.8, 0.3, 1)' }
      );
    }
  }

  function renderDetail() {
    const g = state.games.find((x) => String(x.id) === state.selectedId);
    if (!g) return;
    stopDetailTick();

    const view = $('#game-view');
    const wish = gvIsWishlisted(g);
    const status = gvStatusOf(g);
    const sessions = gvSessions(g);
    const stats = Sessions.sessionStats(sessions);
    const hero = heroUrlOf(g);
    const logo = g._logo || g.logoUrl || '';

    view.innerHTML = `
      <div class="gvx-hero">
        ${hero ? `<img class="gvx-hero-art" src="${esc(toFileUrl(hero))}" alt="" />` : '<div class="gvx-hero-art is-empty"></div>'}
        <div class="gvx-scrim"></div>
        <div class="gvx-hero-inner">
        <div class="gvx-top">
          <button class="gvx-chip" data-back>
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg>
            ${state.filter === 'Want' ? 'Wishlist' : state.filter === 'Activity' ? 'Activity' : 'Library'}
          </button>
          <div class="gvx-top-right">
            ${wish ? '' : `${rateButtonHtml(g)}
            <button class="gvx-chip gvx-fin${status === 'Finished' ? ' is-done' : ''}" data-finish aria-pressed="${status === 'Finished'}" title="${status === 'Finished' ? 'Finished — click to unmark' : 'Mark this game as finished'}">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12.5 4.5 4.5L19 7"/></svg>
              <span>${status === 'Finished' ? 'Finished' : 'Mark as finished'}</span>
            </button>`}
            <button class="gvx-chip gvx-icon${wish ? ' is-on' : ''}" data-wish aria-pressed="${wish}" title="Wishlist">
              <svg viewBox="0 0 24 24" width="15" height="15" fill="${wish ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><path d="m12 3.8 2.5 5.2 5.7.8-4.1 4 1 5.7-5.1-2.7-5.1 2.7 1-5.7-4.1-4 5.7-.8z"/></svg>
            </button>
            <div class="gvx-more-wrap">
              <button class="gvx-chip gvx-icon" data-more aria-haspopup="menu" aria-expanded="false" title="More">
                <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/></svg>
              </button>
              <div class="gvx-menu" data-menu hidden role="menu">
                <button role="menuitem" data-folder ${g.exePath ? '' : 'disabled'}>Open folder</button>
                <button role="menuitem" data-copy ${g.exePath ? '' : 'disabled'}>Copy path</button>
                <button role="menuitem" data-edit>Edit…</button>
                <button role="menuitem" data-refresh>Refresh artwork</button>
                <button role="menuitem" class="is-danger" data-remove-game>${wish ? 'Remove from wishlist' : 'Remove from library…'}</button>
              </div>
            </div>
          </div>
        </div>

        ${!wish && Rating.value(g) >= Rating.PEAK ? peakMedalHtml(g) : ''}
        <div class="gvx-hero-body" tabindex="-1" aria-label="${esc(g.name)}">
          ${logo
            ? `<span class="gv-logo3d" data-logo3d><img class="gvx-logo" src="${esc(toFileUrl(logo))}" alt="${esc(g.name)}" /><i class="gv-logo-sheen" style="--logo:${esc(cssUrl(logo))}" aria-hidden="true"><b></b></i></span>`
            : `<h1 class="gvx-title">${esc(g.name)}</h1>`}
          <div class="gvx-meta">${detailMeta(g)}</div>
          <div class="gvx-play-row">
            ${wish
              ? `<button class="gvx-play" data-move><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg> Move to library</button>`
              : `<button class="gvx-play${typeof state.live[String(g.id)] === 'number' ? ' is-live' : ''}" data-play>
                   <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">${typeof state.live[String(g.id)] === 'number' ? '<rect x="6" y="6" width="12" height="12" rx="2"/>' : '<path d="M8 5v14l11-7z"/>'}</svg>
                   <span data-play-label>${typeof state.live[String(g.id)] === 'number' ? 'Stop' : 'Play'}</span>
                 </button>
                 <div class="gvx-timer" data-timer role="timer" aria-live="off">${detailTimerHtml(g)}</div>`}
          </div>
        </div>
        </div>
      </div>

      <div class="gvx-band">
        ${wish ? `
          <div class="gvx-wish">
            <div class="gvx-wish-kicker">WISHLIST</div>
            <h2>Not in your library yet</h2>
            <p>Move it in when you own it — sessions start once you play.</p>
          </div>
          <aside class="gvx-rail">
            <div class="gvx-card">
              <div class="gvx-card-head">WISHLIST</div>
              <dl class="gvx-specs">
                <div><dt>Since</dt><dd>${fmtDate(g.added)}</dd></div>
                ${g.source ? `<div><dt>Source</dt><dd>${esc(g.source)}</dd></div>` : ''}
              </dl>
            </div>
          </aside>
        ` : `
          <div class="gvx-main">
            <div class="gvx-ledger-head">
              <h2>Sessions</h2>
              <span class="gvx-ledger-count">${stats.count} session${stats.count === 1 ? '' : 's'}</span>
            </div>
            <div class="gvx-ses-top" data-ses-top></div>
            <div class="gvx-list" data-ledger role="list" aria-label="Session history"></div>
          </div>
          <aside class="gvx-rail" data-rail>${railHtml(g)}<div class="gvx-card sv-card" data-saves-card></div></aside>
        `}
      </div>
    `;
    animateDetailIn(view, g);

    const heroImg = view.querySelector('.gvx-hero-art');
    if (heroImg && heroImg.tagName === 'IMG') heroImg.addEventListener('error', () => heroImg.classList.add('is-empty'));
    const logoImg = view.querySelector('.gvx-logo');
    logoTilt(view.querySelector('[data-logo3d]'));
    if (logoImg) logoImg.addEventListener('error', () => { (logoImg.closest('[data-logo3d]') || logoImg).remove(); view.querySelector('.gvx-hero-body').insertAdjacentHTML('afterbegin', `<h1 class="gvx-title">${esc(g.name)}</h1>`); });

    if (!wish) paintLedger(g);
    wireDetail(g, wish);
    if (!wish) paintSavesCard(g);
    startDetailTick(g);
    state._detailRunning = { id: String(g.id), running: typeof state.live[String(g.id)] === 'number' };
    if (!wish) loadSteamMeta(g);
  }

  const SES_WEEKS = 26;
  const SES_WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const SES_MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  // Stats and a day-by-day heat map over the last SES_WEEKS weeks
  // (columns are Monday-first weeks, the last one is this week).
  function sessionsTopHtml(g, sessions) {
    const stats = Sessions.sessionStats(sessions);
    const live = state.live[String(g.id)];
    const total = (Number(g.hours) || 0) + (typeof live === 'number' ? live / 60 : 0);
    const stat = (label, value) => `<div class="gvx-ses-stat"><span>${label}</span><b>${value}</b></div>`;

    const today = new Date();
    const dow = (today.getDay() + 6) % 7; // Monday = 0
    const days = Sessions.dayBuckets(sessions, (SES_WEEKS - 1) * 7 + dow + 1);
    const max = days.reduce((m, d) => Math.max(m, d.hours), 0);
    const level = (h) => (h <= 0 || !max ? 0 : Math.min(4, Math.ceil((h / max) * 4)));
    const cols = [];
    const months = [];
    for (let w = 0; w < SES_WEEKS; w++) {
      const week = days.slice(w * 7, w * 7 + 7);
      const first = new Date(week[0].start);
      const prev = w ? new Date(days[(w - 1) * 7].start) : null;
      months.push(!prev || prev.getMonth() !== first.getMonth() ? SES_MON[first.getMonth()] : '');
      cols.push(`<div class="gvx-heat-col">${week.map((d) => {
        const dt = new Date(d.start);
        const tip = `${SES_WD[dt.getDay()]}, ${SES_MON[dt.getMonth()]} ${dt.getDate()} · ${d.hours > 0 ? Sessions.formatDuration(d.hours) : 'no play'}`;
        return `<i class="lv${level(d.hours)}" title="${esc(tip)}"></i>`;
      }).join('')}</div>`);
    }
    // a month name needs two columns of room
    for (let i = 0; i < months.length; i++) if (months[i] && months[i + 1]) months[i] = '';

    return `
      <div class="gvx-ses-stats">
        ${stat('Total', total > 0 ? fmtHours(total) : '0h')}
        ${stat('This week', stats.weekHours > 0 ? Sessions.formatDuration(stats.weekHours) : '0h')}
        ${stat('Average', stats.count ? Sessions.formatDuration(stats.averageMinutes / 60) : '—')}
        ${stat('Longest', stats.count ? Sessions.formatDuration(stats.longestMinutes / 60) : '—')}
      </div>
      <div class="gvx-heat" style="--weeks:${SES_WEEKS}" role="img" aria-label="Days played over the last ${SES_WEEKS} weeks">
        <div class="gvx-heat-months" aria-hidden="true">${months.map((m) => `<span>${m}</span>`).join('')}</div>
        <div class="gvx-heat-body">
          <div class="gvx-heat-days" aria-hidden="true"><span>Mon</span><span></span><span>Wed</span><span></span><span>Fri</span><span></span><span></span></div>
          <div class="gvx-heat-grid">${cols.join('')}</div>
        </div>
        <div class="gvx-heat-key" aria-hidden="true">Less <i class="lv0"></i><i class="lv1"></i><i class="lv2"></i><i class="lv3"></i><i class="lv4"></i> More</div>
      </div>`;
  }

  function paintLedger(g) {
    const listEl = document.querySelector('[data-ledger]');
    if (!listEl) return;
    const sessions = gvSessions(g);
    const live = state.live[String(g.id)];
    const running = typeof live === 'number';
    const groups = Sessions.groupSessions(sessions);
    const MAX_ROWS = 100;
    const longest = sessions.reduce((m, x) => Math.max(m, x.duration), 0) || 1;

    const topEl = document.querySelector('[data-ses-top]');
    if (topEl) {
      const show = sessions.length > 0 || running;
      topEl.hidden = !show;
      topEl.innerHTML = show ? sessionsTopHtml(g, sessions) : '';
    }

    const rows = [];
    if (running) {
      const started = state.liveStart && state.liveStart[String(g.id)];
      rows.push(`<div class="gvx-row is-live" role="listitem">
        <span class="gvx-row-date"><b><i class="gvx-live-dot"></i></b><i>Now</i></span>
        <span class="gvx-row-when">${started ? `Started ${hhmm(started)}` : 'Playing'}</span>
        <span class="gvx-row-bar" aria-hidden="true"></span>
        <span class="gvx-row-dur" data-live-dur>${Sessions.formatClock(live * 60000)}</span>
      </div>`);
    }

    let rendered = 0;
    for (const group of groups) {
      if (rendered >= MAX_ROWS) break;
      rows.push(`<div class="gvx-month"><span>${group.label}</span><span>${Sessions.formatDuration(group.totalHours)} · ${group.count} session${group.count === 1 ? '' : 's'}</span></div>`);
      for (const s of group.items) {
        if (rendered >= MAX_ROWS) break;
        const d = new Date(s.start);
        rows.push(`<div class="gvx-row" role="listitem">
          <span class="gvx-row-date"><b>${d.getDate()}</b><i>${SES_WD[d.getDay()]}</i></span>
          <span class="gvx-row-when">${s.startLabel}${s.end ? ` – ${hhmm(s.end)}` : ''}${s.crossesMidnight ? ' <em>+1</em>' : ''}</span>
          <span class="gvx-row-bar" aria-hidden="true"><i style="width:${Math.max(2, (s.duration / longest) * 100).toFixed(1)}%"></i></span>
          <span class="gvx-row-dur">${s.durationLabel}</span>
        </div>`);
        rendered += 1;
      }
    }

    if (rows.length) {
      listEl.innerHTML = rows.join('');
      if (sessions.length > MAX_ROWS) {
        listEl.insertAdjacentHTML('beforeend', `<div class="gvx-more">Showing the latest ${MAX_ROWS} of ${sessions.length}.</div>`);
      }
    } else {
      const imported = Number(g.hours) > 0
        ? `<span class="gvx-empty-note">${fmtHours(g.hours)} of playtime came with the import. It isn't split into sessions.</span>`
        : '';
      listEl.innerHTML = `<div class="gvx-empty">
        <span class="gvx-empty-ico" aria-hidden="true"><svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="13" r="7.5"/><path d="M12 9.5V13l2.5 2M9.5 3h5"/></svg></span>
        <b>No sessions yet</b>
        <span>Press Play. Each session is timed and saved here when you stop.</span>
        ${imported}
      </div>`;
    }
    listEl.classList.toggle('is-empty', !rows.length);
  }

  function startDetailTick(g) {
    stopDetailTick();
    const live = state.live[String(g.id)];
    if (typeof live !== 'number') return;
    if (state.liveStart == null) state.liveStart = {};
    state.liveStart[String(g.id)] = Date.now() - live * 60000;

    const paint = () => {
      const valueEl = document.querySelector('[data-timer-value]');
      const liveDur = document.querySelector('[data-live-dur]');
      if (!valueEl || typeof state.live[String(g.id)] !== 'number') { stopDetailTick(); return; }
      const elapsed = Math.max(0, Date.now() - state.liveStart[String(g.id)]);
      valueEl.textContent = Sessions.formatClock(elapsed);
      if (liveDur) liveDur.textContent = Sessions.formatClock(elapsed);
    };
    paint();
    if (state.tier === 'lite') return;
    detailTick = setInterval(paint, 1000);
  }

  // Ledger, session count and at-a-glance after a session started/ended.
  function repaintDetailHistory(g) {
    const view = $('#game-view');
    if (!view || view.hidden || state.selectedId !== String(g.id) || gvIsWishlisted(g)) return;
    paintLedger(g);
    paintRail(g);
    const countEl = view.querySelector('.gvx-ledger-count');
    if (countEl) {
      const n = Sessions.sessionStats(gvSessions(g)).count;
      countEl.textContent = `${n} session${n === 1 ? '' : 's'}`;
    }
  }

  function updateDetailLive(g) {
    const view = $('#game-view');
    if (!view || view.hidden) return;
    const id = String(g.id);
    const running = typeof state.live[id] === 'number';
    if (running) {
      if (!detailTick) startDetailTick(g);
    } else {
      stopDetailTick();
      if (state.liveStart) delete state.liveStart[id];
    }
    const flipped = state._detailRunning && state._detailRunning.id === id && state._detailRunning.running !== running;
    state._detailRunning = { id, running };
    if (flipped) repaintDetailHistory(g);
    const timerEl = view.querySelector('[data-timer]');
    if (timerEl) timerEl.innerHTML = detailTimerHtml(g);
    const metaEl = view.querySelector('.gvx-meta');
    if (metaEl) metaEl.innerHTML = detailMeta(g);
    const playBtn = view.querySelector('[data-play]');
    if (playBtn) {
      const live = state.live[String(g.id)];
      const running = typeof live === 'number';
      const busy = live === 'launching' || live === 'stopping';
      playBtn.classList.toggle('is-live', running);
      playBtn.classList.toggle('is-busy', busy);
      // launching stays clickable: a second click cancels it
      playBtn.disabled = live === 'stopping';
      const label = playBtn.querySelector('[data-play-label]');
      if (label) swapLabel(label, busy ? (live === 'launching' ? 'Launching…' : 'Stopping…') : running ? 'Stop' : 'Play');
      const icon = playBtn.querySelector('svg');
      const glyph = running ? '<rect x="6" y="6" width="12" height="12" rx="2"></rect>' : '<path d="M8 5v14l11-7z"></path>';
      if (icon && !busy && icon.innerHTML !== glyph) {
        icon.innerHTML = glyph;
        if (!prefersReducedMotion()) icon.animate([{ opacity: 0, transform: 'scale(0.7)' }, { opacity: 1, transform: 'none' }], { duration: 260, easing: 'cubic-bezier(0.22, 0.8, 0.3, 1)' });
      }
    }
    const liveValue = view.querySelector('[data-timer-value]');
    if (liveValue && typeof state.live[String(g.id)] === 'number') {
      liveValue.textContent = Sessions.formatClock(state.live[String(g.id)] * 60000);
    }
  }

  function setFinished(g, value) {
    const wasWish = gvIsWishlisted(g);
    g.status = value ? 'Finished' : 'Playing';
    if (value) g.wishlisted = false;
    saveGamesSoon();
    state._shelfKey = '';
    // a wishlisted game's page has a different layout (no Play/Finish row):
    // leaving the wishlist needs a full re-render, not a button patch
    if (wasWish && !gvIsWishlisted(g) && state.selectedId === String(g.id)) {
      renderDetail();
      renderLibrary();
      return;
    }
    const view = $('#game-view');
    const btn = view.querySelector('[data-finish]');
    if (btn) {
      btn.classList.toggle('is-done', !!value);
      btn.setAttribute('aria-pressed', String(!!value));
      btn.title = value ? 'Finished — click to unmark' : 'Mark this game as finished';
      const label = btn.querySelector('span');
      if (label) label.textContent = value ? 'Finished' : 'Mark as finished';
    }
    renderLibrary();
  }

  function toggleDetailWish(g) {
    if (gvIsWishlisted(g)) {
      // Leaving the wishlist: the migration left status null (and legacy
      // data may still say 'Want'); give it a real library status so it
      // shows up in the Playing tab and counts.
      g.wishlisted = false;
      g.status = g._prevStatus === 'Finished' ? 'Finished' : 'Playing';
      delete g._prevStatus;
    } else {
      // A wishlisted game is not owned yet, so it cannot stay Finished.
      // Keep the old status for this session (not persisted: '_' keys are
      // stripped on save) so pressing W twice is a no-op.
      g._prevStatus = g.status;
      g.wishlisted = true;
      if (g.status === 'Finished') g.status = 'Playing';
    }
    saveGamesSoon();
    state._shelfKey = '';
    renderDetail();
    renderLibrary();
    toast(g.wishlisted ? 'Added to Wishlist' : 'Removed from Wishlist', 'ok');
  }

  function moveToLibrary(g) {
    g.wishlisted = false;
    g.status = 'Playing';
    saveGamesSoon();
    state._shelfKey = '';
    renderDetail();
    renderLibrary();
    toast('Moved to library', 'ok');
  }

  // ---- removing a game: the options popup, the game page's ⋯ menu, the
  // edit dialog and the Delete key all come here. Wishlist entries keep
  // their one-click remove.
  function askRemoveGame(g) {
    if (!g || !state.games.includes(g)) return;
    if (gvIsWishlisted(g)) { wishRemove(g); return; }
    if (state.live[String(g.id)] != null) {
      toast(`Stop ${g.name || 'the game'} before removing it`, 'error');
      return;
    }
    const card = openModal(`
      <div class="modal-head">
        <h2>Remove from library?</h2>
        <button class="close-x" data-close aria-label="Close">✕</button>
      </div>
      <div class="modal-body rm-body">
        <p class="rm-text"><b>${esc(g.name || 'Untitled')}</b> leaves your library, with its playtime and sessions. The game's files stay on your PC.</p>
      </div>
      <div class="modal-foot">
        <button class="btn btn-ghost" data-close data-autofocus>Cancel</button>
        <button class="btn btn-danger" data-rm>Remove</button>
      </div>`, { className: 'rm-modal' });
    if (!card) return;
    for (const btn of card.querySelectorAll('[data-close]')) btn.onclick = closeModal;
    card.querySelector('[data-rm]').onclick = () => {
      closeModal();
      removeGame(g);
    };
  }

  function removeGame(g) {
    const idx = state.games.indexOf(g);
    if (idx < 0) return;
    const id = String(g.id);
    // the selection moves to a neighbour, not back to the first game
    const shown = filteredGames();
    const at = shown.indexOf(g);
    const near = at < 0 ? null : (shown[at + 1] || shown[at - 1] || null);
    if (state.selectedId === id) closeDetail();
    state.games.splice(idx, 1);
    if (state.shelfId === id) state.shelfId = near ? String(near.id) : null;
    state._shelfKey = '';
    renderLibrary();
    saveGamesSoon();
    // focus lands on the neighbour once the dialog has closed
    setTimeout(() => focusGameIfLost(near), 360);
    toast(`${g.name || 'Game'} removed from your library`, 'ok', [{ label: 'Undo', run: () => {
      if (state.games.includes(g)) return;
      state.games.splice(Math.min(idx, state.games.length), 0, g);
      state._shelfKey = '';
      renderLibrary();
      saveGamesSoon();
      requestAnimationFrame(() => focusGameIfLost(g));
    } }]);
  }

  // On the shelf focus goes to the picked cover (focus and pick never
  // split into two rings); in the grid, to the given game's card.
  function focusGameIfLost(g) {
    const a = document.activeElement;
    if (a && a !== document.body && a.isConnected && !a.closest('#toasts')) return;
    const shelf = $('#shelf');
    let el = null;
    if (shelf && !shelf.hidden) {
      el = shelf.querySelector('.shelf-tile.is-active');
    } else if (g) {
      el = document.querySelector(`#library:not([hidden]) .card[data-id="${CSS.escape(String(g.id))}"]`);
    }
    if (el) el.focus({ preventScroll: true });
  }

  function wireDetail(g, wish) {
    const view = $('#game-view');

    view.querySelector('[data-back]').onclick = closeDetail;

    const menuBtn = view.querySelector('[data-more]');
    const menu = view.querySelector('[data-menu]');
    const closeMenu = () => { if (menu) menu.hidden = true; if (menuBtn) menuBtn.setAttribute('aria-expanded', 'false'); };
    if (menuBtn) {
      menuBtn.onclick = (e) => {
        e.stopPropagation();
        const open = menu.hidden;
        menu.hidden = !open;
        menuBtn.setAttribute('aria-expanded', String(open));
        if (open) menu.querySelector('button:not([disabled])')?.focus();
      };
      menu.addEventListener('click', (e) => {
        const item = e.target.closest('[role="menuitem"]');
        if (!item || item.disabled) return;
        closeMenu();
        if (item.hasAttribute('data-folder')) api.showInFolder(g.exePath);
        else if (item.hasAttribute('data-copy')) navigator.clipboard.writeText(g.exePath || '').then(() => toast('Path copied', 'ok')).catch(() => {});
        else if (item.hasAttribute('data-edit')) openGameModal(g);
        else if (item.hasAttribute('data-refresh')) refetchArtwork(g);
        else if (item.hasAttribute('data-remove-game')) askRemoveGame(g);
      });
      view.onpointerdown = (e) => { if (!e.target.closest('.gvx-more-wrap')) closeMenu(); };
      menu.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        e.preventDefault();
        e.stopPropagation();
        closeMenu();
        menuBtn.focus();
      });
    }

    const wishBtn = view.querySelector('[data-wish]');
    if (wishBtn) wishBtn.onclick = () => toggleDetailWish(g);

    for (const btn of view.querySelectorAll('[data-move]')) btn.onclick = () => moveToLibrary(g);

    const playBtn = view.querySelector('[data-play]');
    if (playBtn) playBtn.onclick = () => togglePlay(g.id);

    const finishBtn = view.querySelector('[data-finish]');
    if (finishBtn) finishBtn.onclick = () => setFinished(g, !(g.status === 'Finished'));

    const rateBtn = view.querySelector('[data-rate]');
    if (rateBtn) rateBtn.onclick = () => openRater(g);
  }

  // ---- ratings: 1.3.1's scale (0.1-10, 10 = PEAK), stored on g.rating
  const STAR_ICON = '<svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor" aria-hidden="true"><path d="m12 3.2 2.7 5.5 6 .9-4.35 4.25 1.03 6-5.38-2.83-5.38 2.83 1.03-6L3.3 9.6l6-.9z"/></svg>';
  // gold foil chip; the sweep is a pseudo-element so it costs nothing at rest
  const peakChip = (extra = '', id = '') => `<span class="peak-foil${extra}"${id ? ` data-peak-open data-id="${esc(id)}" title="Your best game ever"` : ''}><span class="peak-word">Peak</span></span>`;
  function ratingChipHtml(r, id = '') {
    if (!r) return '';
    return r >= Rating.PEAK ? peakChip(' is-sm', id) : `<span class="rate-chip tier-${Rating.tier(r)}">${STAR_ICON}<span>${Rating.label(r)}</span></span>`;
  }

  function rateButtonHtml(g) {
    const r = Rating.value(g);
    const tier = Rating.tier(r);
    const inner = !r
      ? `${STAR_ICON}<span>Rate</span>`
      : r >= Rating.PEAK ? `<span class="peak-word">Peak</span>` : `${STAR_ICON}<span>${Rating.label(r)}</span><small>/10</small>`;
    return `<button class="gvx-chip gvx-rate${tier ? ` tier-${tier}` : ''}${r >= Rating.PEAK ? ' peak-foil' : ''}" data-rate title="${r ? 'Your rating: click to change' : 'Rate this game'}">${inner}</button>`;
  }

  // the "best game ever" medal over the logo on a PEAK game's page
  function peakMedalHtml(g) {
    return `<div class="peak-medal" role="button" tabindex="0" data-peak-open data-id="${esc(String(g.id))}" title="Rated PEAK: your best game ever">
      <span class="peak-medal-disc"><b>10</b></span>
      <span class="peak-medal-text"><b class="peak-word">Peak</b><small>Your best game ever</small></span>
    </div>`;
  }

  // ---- PEAK showcase: the pill grows into a big 3D plaque that catches the
  // light, and the game gets the praise it has earned.
  const PEAK_HYPE = [
    'Some games are good. This one rewired your brain.',
    'Ten out of ten is not a score here. It is a fact.',
    'The bar every other game has to clear.',
    'You don’t just play this one. You come back to it.',
    'Every other game gets measured against this.',
    'Hall of fame. First ballot. No debate.',
    'If games had a summit, you are standing on it.',
    'Nothing else on the shelf comes close, and they all know it.',
  ];
  function peakHype(g) {
    let h = 0;
    for (const ch of String(g.id) + String(g.name || '')) h = (h * 31 + ch.codePointAt(0)) >>> 0;
    return PEAK_HYPE[h % PEAK_HYPE.length];
  }
  function peakStory(g) {
    const hours = Number(g.hours) || 0;
    const sessions = gvSessions(g);
    const st = Sessions.sessionStats(sessions);
    const lines = [];
    if (hours >= 1) lines.push(`${fmtHours(hours)} in, and you would still go back for more.`);
    if (st.longestMinutes >= 30) lines.push(`Your longest run went ${Sessions.formatDuration(st.longestMinutes / 60)} without stopping.`);
    if (g.status === 'Finished') lines.push('You saw it through to the credits, and it still holds the top spot.');
    if (!lines.length) lines.push('It took the top spot before the clock even started. That says enough.');
    return lines.slice(0, 2).join(' ');
  }
  function peakFacts(g) {
    const sessions = gvSessions(g);
    const st = Sessions.sessionStats(sessions);
    const out = [];
    const hours = Number(g.hours) || 0;
    if (hours > 0) out.push([fmtHours(hours), 'played']);
    if (st.count) out.push([String(st.count), st.count === 1 ? 'session' : 'sessions']);
    if (st.longestMinutes > 0) out.push([Sessions.formatDuration(st.longestMinutes / 60), 'longest run']);
    if (g.added) out.push([fmtDate(g.added), 'in your vault since']);
    return out.slice(0, 4);
  }

  function openPeakShowcase(g, fromEl) {
    if (!g) return;
    const card = openModal(`
      <div class="pk">
        <div class="pk-stage">
          <div class="pk-plaque" data-pk-plaque>
            <div class="pk-face">
            <div class="pk-glare" aria-hidden="true"></div>
            <div class="pk-body">
              <span class="pk-titles">
                <span class="pk-word peak-word">Peak</span>
                <span class="pk-game">${esc(g.name || 'Untitled')}</span>
              </span>
            </div>
            </div>
          </div>
        </div>
        <div class="pk-glaze">
          <p class="pk-hype">${esc(peakHype(g))}</p>
          <p class="pk-story">${esc(peakStory(g))}</p>
          <div class="pk-facts">${peakFacts(g).map(([v, l]) => `<div class="pk-fact"><b>${esc(v)}</b><span>${esc(l)}</span></div>`).join('')}</div>
          <button type="button" class="pk-close" data-autofocus data-pk-close>Back</button>
        </div>
      </div>`, { className: 'peak-modal' });
    if (!card) return;
    card.querySelector('[data-pk-close]').onclick = closeModal;
    const plaque = card.querySelector('[data-pk-plaque]');
    peakTilt(plaque, 16);
    sfx('success');
    if (prefersReducedMotion()) return;
    // grow out of the pill that was clicked: start at its box, flipped a bit, then land
    requestAnimationFrame(() => {
      const to = plaque.getBoundingClientRect();
      const from = fromEl && fromEl.isConnected ? fromEl.getBoundingClientRect() : null;
      const start = from && from.width
        ? `translate(${(from.left + from.width / 2) - (to.left + to.width / 2)}px, ${(from.top + from.height / 2) - (to.top + to.height / 2)}px) scale(${Math.max(0.05, from.width / to.width)}, ${Math.max(0.05, from.height / to.height)})`
        : 'translateY(30px) scale(0.6)';
      plaque.animate([
        { transform: `${start} perspective(900px) rotateY(-40deg) rotateX(12deg)`, opacity: 0.4 },
        { transform: 'perspective(900px) rotateY(8deg) rotateX(-3deg) scale(1.03)', opacity: 1, offset: 0.7 },
        { transform: 'none', opacity: 1 },
      ], { duration: 950, easing: 'cubic-bezier(0.2, 0.9, 0.25, 1)' });
      plaque.classList.add('is-landing');
      setTimeout(() => plaque.classList.remove('is-landing'), 1800);
    });
  }

  // a foil surface that tilts toward the pointer, with the light following it
  function peakTilt(el, deg = 14) {
    if (!el || el._peakTilt || prefersReducedMotion()) return;
    el._peakTilt = true;
    el.addEventListener('pointermove', (e) => {
      const r = el.getBoundingClientRect();
      const px = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
      const py = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
      el.style.setProperty('--mx', `${(px * 100).toFixed(1)}%`);
      el.style.setProperty('--my', `${(py * 100).toFixed(1)}%`);
      el.style.setProperty('--ry', `${((px - 0.5) * deg).toFixed(2)}deg`);
      el.style.setProperty('--rx', `${((0.5 - py) * deg * 0.8).toFixed(2)}deg`);
      el.classList.add('is-lit');
    });
    el.addEventListener('pointerleave', () => {
      el.classList.remove('is-lit');
      el.style.setProperty('--rx', '0deg');
      el.style.setProperty('--ry', '0deg');
    });
  }
  // every PEAK pill anywhere: shine on hover, open the showcase on click
  document.addEventListener('pointerover', (e) => {
    const pill = e.target.closest && e.target.closest('.peak-foil, .peak-medal');
    if (pill) peakTilt(pill, pill.classList.contains('peak-medal') ? 10 : 22);
  });
  document.addEventListener('click', (e) => {
    const pill = e.target.closest && e.target.closest('[data-peak-open]');
    if (!pill) return;
    const id = pill.dataset.id || (gameFromEl(pill) || {}).id;
    const g = state.games.find((x) => String(x.id) === String(id));
    if (!g) return;
    e.preventDefault();
    e.stopPropagation();
    openPeakShowcase(g, pill);
  }, true);
  document.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.matches && e.target.matches('.peak-medal[data-peak-open]')) {
      e.preventDefault();
      e.target.click();
    }
  });

  function setRating(g, r) {
    const next = Rating.parse(r);
    const prevRating = Rating.value(g);
    if (next === prevRating) return;
    g.rating = next;
    saveGamesSoon();
    state._shelfKey = '';
    const peakChanged = (next >= Rating.PEAK) !== (prevRating >= Rating.PEAK);
    if (state.selectedId === String(g.id) && peakChanged) {
      renderDetail();
    } else if (state.selectedId === String(g.id)) {
      const btn = $('#game-view [data-rate]');
      if (btn) {
        btn.outerHTML = rateButtonHtml(g);
        const fresh = $('#game-view [data-rate]');
        if (fresh) fresh.onclick = () => openRater(g);
      }
      const rail = $('#game-view .gvx-rail');
      if (rail && !gvIsWishlisted(g)) rail.innerHTML = railHtml(g);
    }
    renderLibrary();
    if (next >= Rating.PEAK) sfx('success');
    toast(next >= Rating.PEAK ? `${g.name || 'Game'} rated PEAK` : next ? `Rated ${Rating.label(next)} / 10` : 'Rating cleared', 'ok', null, { quiet: next >= Rating.PEAK });
  }

  // The rating popup: ten steps (10 is PEAK), or type any value like 8.5.
  // Clicking a step saves straight away; typing saves on Enter or Save.
  function openRater(g) {
    if (!g || gvIsWishlisted(g)) return;
    const cur = Rating.value(g);
    const steps = Array.from({ length: 10 }, (_, i) => i + 1);
    const card = openModal(`
      <div class="rt">
        <div class="rt-head">
          <div class="rt-cover"></div>
          <div class="rt-text"><div class="rt-kicker">YOUR RATING</div><div class="rt-title">${esc(g.name || 'Untitled')}</div></div>
        </div>
        <div class="rt-score" data-rt-score aria-live="polite"></div>
        <div class="rt-scale" role="radiogroup" aria-label="Rating out of 10">
          ${steps.map((n) => `<button type="button" class="rt-step${n === 10 ? ' is-peak' : ''}" role="radio" data-rt="${n}" aria-checked="${Math.round(cur) === n}" aria-label="${n === 10 ? 'PEAK (10)' : n}">${n}</button>`).join('')}
        </div>
        <div class="rt-foot">
          <input class="rt-input" data-rt-input type="text" inputmode="decimal" maxlength="6" spellcheck="false" placeholder="Type a rating, like 7.5" value="${cur ? esc(cur >= Rating.PEAK ? 'peak' : Rating.label(cur)) : ''}" aria-label="Type a rating" />
          ${cur ? '<button type="button" class="btn" data-rt-clear>Clear</button>' : ''}
          <button type="button" class="btn btn-primary" data-rt-save>Save</button>
        </div>
      </div>`, { className: 'rt-modal' });
    if (!card) return;
    const cover = card.querySelector('.rt-cover');
    const src = g._cover || g.coverUrl;
    if (cover && src) cover.style.backgroundImage = cssUrl(src);
    const score = card.querySelector('[data-rt-score]');
    const input = card.querySelector('[data-rt-input]');
    const stepBtns = [...card.querySelectorAll('[data-rt]')];
    const show = (r) => {
      const tier = Rating.tier(r);
      score.dataset.tier = tier;
      score.innerHTML = !r ? '<span class="rt-none">Not rated</span>'
        : r >= Rating.PEAK ? peakChip(' is-lg')
          : `<b>${Rating.label(r)}</b><small>/ 10</small>`;
      for (const b of stepBtns) b.classList.toggle('is-lit', Number(b.dataset.rt) <= Math.round(r) && r > 0);
    };
    show(cur);
    const done = (r) => { closeModal(); setRating(g, r); };
    for (const b of stepBtns) {
      b.onclick = () => done(Number(b.dataset.rt));
      b.onmouseenter = () => show(Number(b.dataset.rt));
      b.onfocus = () => show(Number(b.dataset.rt));
    }
    const scale = card.querySelector('.rt-scale');
    scale.onmouseleave = () => show(Rating.parse(input.value) || cur);
    scale.addEventListener('keydown', (e) => {
      const i = stepBtns.indexOf(document.activeElement);
      if (i < 0) return;
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        e.preventDefault();
        stepBtns[Math.max(0, Math.min(9, i + (e.key === 'ArrowRight' ? 1 : -1)))].focus();
      } else if (/^[0-9]$/.test(e.key)) {
        e.preventDefault();
        stepBtns[e.key === '0' ? 9 : Number(e.key) - 1].focus();
      }
    });
    input.oninput = () => show(Rating.parse(input.value));
    input.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); done(input.value); } };
    card.querySelector('[data-rt-save]').onclick = () => done(input.value);
    const clear = card.querySelector('[data-rt-clear]');
    if (clear) clear.onclick = () => done(0);
    const start = stepBtns[Math.max(0, Math.round(cur || 8) - 1)];
    requestAnimationFrame(() => start.focus({ preventScroll: true }));
  }

  // ---------------------------------------------------------------------------
  // Modals
  // ---------------------------------------------------------------------------

  let modalSeq = 0;

  function openModal(html, { className = '' } = {}) {
    const wrap = $('#modal');
    sfx('open');
    modalSeq += 1;
    state._modalOpener = document.activeElement;
    const app = $('#app');
    if (app) app.inert = true;
    wrap.hidden = false;
    wrap.innerHTML = `<div class="modal-card ${className}" role="dialog" aria-modal="true" tabindex="-1">${html}</div>`;
    const card = wrap.firstElementChild;
    const head = card.querySelector('.modal-head h2');
    if (head) {
      head.id = head.id || 'modal-title';
      card.setAttribute('aria-labelledby', head.id);
    }
    void card.offsetWidth;
    card.classList.add('is-open');
    enableSheetDrag(card);
    requestAnimationFrame(() => {
      // an explicit [data-autofocus] wins over document order (the close X
      // comes first in every header)
      if (!card.isConnected) return;
      const target = card.querySelector('[data-autofocus], [autofocus]')
        || card.querySelector('input, select, textarea, button, [href]');
      (target || card).focus({ preventScroll: true });
    });
    wrap.onclick = (e) => { if (e.target === wrap) closeModal(); };
    if (!wrap._trap) {
      wrap._trap = (e) => {
        if (e.key !== 'Tab') return;
        const cardEl = wrap.firstElementChild;
        if (!cardEl) return;
        const items = [...cardEl.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex="0"]')]
          .filter((el) => el.offsetParent !== null || el === document.activeElement);
        if (!items.length) return;
        const first = items[0];
        const last = items[items.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      };
      wrap.addEventListener('keydown', wrap._trap);
    }
    return card;
  }

  function closeModal() {
    const wrap = $('#modal');
    if (!wrap.hidden) sfx('close');
    const card = wrap.firstElementChild;
    modalSeq += 1;
    const seq = modalSeq;
    const opener = state._modalOpener;
    const app = $('#app');
    if (app) app.inert = false;
    if (card) card.classList.remove('is-open');
    setTimeout(() => {
      // a new modal opened in the meantime — this close is stale
      if (seq !== modalSeq) return;
      wrap.hidden = true;
      wrap.innerHTML = '';
      if (app) app.inert = false;
      if (opener && opener.isConnected && typeof opener.focus === 'function') opener.focus({ preventScroll: true });
    }, 320);
  }

  function prefersReducedMotion() {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  // iOS sheet: drag down from the header; velocity decides commit vs. spring back.
  function enableSheetDrag(card) {
    if (prefersReducedMotion()) return;
    const head = card.querySelector('.modal-head');
    if (!head || head.dataset.drag) return;
    head.dataset.drag = '1';
    head.style.touchAction = 'none';
    let startY = 0, dy = 0, lastY = 0, lastT = 0, vel = 0, active = false;
    head.addEventListener('pointerdown', (e) => {
      // touch/pen only: a quick mouse flick across the header must never
      // throw away a half-filled form
      if (e.pointerType !== 'touch' && e.pointerType !== 'pen') return;
      if (e.button !== 0 || e.target.closest('button, a, input, select, textarea')) return;
      active = true; startY = e.clientY; dy = 0; lastY = e.clientY; lastT = performance.now(); vel = 0;
      try { head.setPointerCapture(e.pointerId); } catch (_) {}
      card.style.transition = 'none';
    });
    head.addEventListener('pointermove', (e) => {
      if (!active) return;
      dy = Math.max(0, e.clientY - startY);
      const now = performance.now();
      if (now - lastT > 16) { vel = (e.clientY - lastY) / (now - lastT); lastY = e.clientY; lastT = now; }
      card.style.transform = `translateY(${dy}px) scale(${Math.max(0.94, 1 - dy / 4000)})`;
      card.style.opacity = String(Math.max(0.35, 1 - dy / 700));
    });
    const end = () => {
      if (!active) return;
      active = false;
      const close = dy > 120 || vel > 0.9;
      card.style.transition = '';
      card.style.transform = '';
      card.style.opacity = '';
      if (close) closeModal();
    };
    head.addEventListener('pointerup', end);
    head.addEventListener('pointercancel', end);
  }

  // Slingshot: two springs, one per edge. On a move the trailing edge first
  // pulls back the other way (wind-up), the leading edge fires and overshoots,
  // then the trailing edge snaps in after it. The accent bar rides along.
  const pillSpring = {
    top: { x: 0, v: 0, to: 0 },
    bot: { x: 0, v: 0, to: 0 },
    raf: null, init: false, down: true,
  };
  const PILL_LEAD = { k: 520, c: 33 };   // ζ ≈ 0.72: travels, small overshoot
  const PILL_TRAIL = { k: 300, c: 29 };  // ζ ≈ 0.84: lags, then settles in softly
  // The wind-up scales with how far the pill travels: a neighbour gets a
  // small tug, a jump across the list pulls back further and holds longer.
  const pillWindup = (rows) => ({
    px: Math.min(9, 1.5 + rows * 1.5),
    ms: Math.min(120, 40 + rows * 16),
  });

  function drawSidePill(pill) {
    const t = pillSpring.top.x;
    const h = Math.max(10, pillSpring.bot.x - t);
    pill.style.transform = `translateY(${t.toFixed(2)}px)`;
    pill.style.height = `${h.toFixed(2)}px`;
  }

  function syncSidePill() {
    const pill = document.querySelector('.side-pill');
    const side = document.querySelector('.sidebar');
    const active = side && side.querySelector('.side-item.is-active:not(.side-wish):not(.side-act)');
    if (!pill || !side) return;
    pill.classList.toggle('is-away', !active);
    // when it comes back it appears in place instead of flying in
    if (!active) { if (pillSpring.raf) { cancelAnimationFrame(pillSpring.raf); pillSpring.raf = null; } pillSpring.init = false; return; }
    // Pill is absolutely positioned inside the sidebar's padding box. Measured
    // from rects, not offsetTop: while the rail folds its rows are layers
    // (will-change), which would make them the items' offsetParent.
    const sr = side.getBoundingClientRect(), ar = active.getBoundingClientRect();
    const top = Math.round(ar.top - sr.top - side.clientTop + side.scrollTop);
    const bot = top + active.offsetHeight;
    const S = pillSpring;

    if (!S.init || prefersReducedMotion() || !pill.offsetParent) {
      if (S.raf) { cancelAnimationFrame(S.raf); S.raf = null; }
      S.init = true;
      S.top.x = S.top.to = top; S.bot.x = S.bot.to = bot;
      S.top.v = S.bot.v = 0;
      drawSidePill(pill);
      return;
    }
    if (top === S.top.to && bot === S.bot.to) return;

    S.down = top > S.top.x;
    S.top.to = top; S.bot.to = bot;
    // pull the slingshot back: for a moment the trailing edge is aimed a few
    // px away from the target, then released
    const trailEdge = S.down ? S.top : S.bot;
    const rows = Math.abs(top - S.top.x) / Math.max(1, active.offsetHeight);
    const w = pillWindup(rows);
    S.windupTo = trailEdge.x + (S.down ? -w.px : w.px);
    S.windupUntil = performance.now() + w.ms;
    if (S.raf) return;

    let last = performance.now();
    const step = (now) => {
      const dt = Math.min(32, now - last) / 1000;
      last = now;
      const lead = S.down ? S.bot : S.top;
      const trail = S.down ? S.top : S.bot;
      const winding = now < (S.windupUntil || 0);
      for (const [edge, p] of [[lead, PILL_LEAD], [trail, PILL_TRAIL]]) {
        const goal = (winding && edge === trail) ? S.windupTo : edge.to;
        const a = -p.k * (edge.x - goal) - p.c * edge.v;
        edge.v += a * dt;
        edge.x += edge.v * dt;
      }
      const settled = !winding && [S.top, S.bot].every((e) => Math.abs(e.v) < 0.4 && Math.abs(e.x - e.to) < 0.35);
      if (settled) {
        S.top.x = S.top.to; S.bot.x = S.bot.to; S.top.v = S.bot.v = 0;
        S.raf = null;
      } else {
        S.raf = requestAnimationFrame(step);
      }
      drawSidePill(pill);
    };
    S.raf = requestAnimationFrame(step);
  }

  function openGameModal(game) {
    const isNew = !game;
    const g = game || { name: '', exePath: '', coverUrl: '', notes: '', status: 'Playing' };
    // Finished and Wishlist are mutually exclusive (a wishlisted game isn't owned yet)
    const editWish = gvIsWishlisted(g);
    const editFinished = !editWish && gvStatusOf(g) === 'Finished';

    const card = openModal(`
      <div class="modal-head">
        <h2>${isNew ? 'Add a game' : 'Edit game'}</h2>
        <button class="close-x" data-close aria-label="Close">✕</button>
      </div>
      <div class="modal-body ge">
        <section class="ge-top">
          <button type="button" class="ge-cover" data-slot="cover" title="Change the cover">
            <span class="ge-cover-empty" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>
              Cover
            </span>
            <span class="ge-cover-edit" aria-hidden="true">Change</span>
          </button>
          <div class="ge-top-main">
            <div class="field">
              <label for="f-name">Title</label>
              <div class="combo">
                <input class="input ge-title" id="f-name" value="${esc(g.name)}" placeholder="Start typing a game name" data-autofocus
                       autocomplete="off" spellcheck="false" role="combobox" aria-expanded="false" aria-controls="f-name-list" />
                <div id="f-name-list" class="combo-menu" role="listbox" hidden></div>
              </div>
              <div class="hint">Pick a match from the list and the artwork fills itself.</div>
            </div>
            <div class="ge-status" role="group" aria-label="Status">
              <button type="button" class="ge-status-btn ge-finish${editFinished ? ' is-on' : ''}" data-finished-edit aria-pressed="${editFinished}">
                <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>
                <span data-label>${editFinished ? 'Finished' : 'Mark as finished'}</span>
              </button>
              <button type="button" class="ge-status-btn ge-wish${editWish ? ' is-on' : ''}" data-wish-edit aria-pressed="${editWish}">
                <svg viewBox="0 0 24 24" width="15" height="15" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"><path d="M12 3.6l2.6 5.3 5.8.8-4.2 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.2-4.1 5.8-.8z"/></svg>
                <span data-label>${editWish ? 'On wishlist' : 'Add to wishlist'}</span>
              </button>
            </div>
            <div class="ge-status-hint" data-status-hint aria-live="polite"></div>
          </div>
        </section>

        <section class="ge-sec">
          <h3 class="ge-sec-title">Game</h3>
          <div class="field">
            <label for="f-exe">Executable</label>
            <div class="field-row">
              <input class="input" id="f-exe" value="${esc(g.exePath || '')}" placeholder="${/Windows/i.test(navigator.userAgent) ? 'C:\\Games\\Game\\game.exe' : '/games/.../game.exe'}" />
              <button class="btn btn-ghost" data-browse style="flex:0 0 auto">Browse</button>
            </div>
            <div class="hint">${/Windows/i.test(navigator.userAgent) ? 'Any .exe, .bat or shortcut that starts the game.' : 'Linux: any ELF binary or Windows .exe (runs through Wine/Proton).'}</div>
          </div>
          <div class="ge-grid2">
            <div class="field">
              <label for="f-steam">Steam AppID</label>
              <input class="input" id="f-steam" value="${esc(g.steamAppId || '')}" placeholder="e.g. 1245620" />
              <div class="hint">Unlocks critic score and specs.</div>
            </div>
            <div class="field">
              <label for="f-hours">Playtime</label>
              <div class="ge-suffix">
                <input class="input" id="f-hours" type="number" min="0" step="0.1" value="${Number(g.hours) > 0 ? Math.round(Number(g.hours) * 10) / 10 : ''}" placeholder="0" />
                <span>hours</span>
              </div>
              <div class="hint">Fix it by hand if tracking missed some.</div>
            </div>
          </div>
        </section>

        <details class="field adv-launch" ${g.launchTarget || g.trackExe || (g.trackMode && g.trackMode !== 'auto') ? 'open' : ''}>
          <summary>Launch &amp; tracking</summary>
          <label for="f-launch">Launch with</label>
          <div class="field-row">
            <input class="input" id="f-launch" value="${esc(g.launchTarget || '')}" placeholder="Empty = the executable above. Or a launcher, shortcut or steam:// link" />
            <button class="btn btn-ghost" type="button" data-browse-launch style="flex:0 0 auto">Browse</button>
          </div>
          <label for="f-track-mode">Count playtime while</label>
          <select class="select" id="f-track-mode">
            <option value="auto">Automatic — the game's exe, or Steam says it's running</option>
            <option value="exe">This program is running…</option>
            <option value="steam">Steam reports the game running</option>
            <option value="none">Never — don't track playtime</option>
          </select>
          <div class="field-row" data-track-exe-row>
            <input class="input" id="f-track-exe" value="${esc(g.trackExe || '')}" placeholder="e.g. eldenring.exe" />
            <button class="btn btn-ghost" type="button" data-detect style="flex:0 0 auto">Detect</button>
          </div>
          <div class="hint">Use this when a launcher or wrapper starts the real game. Start the game, then press Detect and pick it.</div>
          <div class="detect-list" data-detect-list hidden></div>
        </details>

        <section class="ge-sec ge-art-sec">
          <div class="ge-sec-head">
            <h3 class="ge-sec-title">Artwork</h3>
            <span id="art-status" class="art-status">Not set</span>
          </div>
          <div class="art-summary ge-art" id="art-summary">
            <button type="button" class="ge-art-slot" data-slot="cover" title="Cover"><i class="art-mini cover"></i><span>Cover</span></button>
            <button type="button" class="ge-art-slot" data-slot="hero" title="Banner"><i class="art-mini hero"></i><span>Banner</span></button>
            <button type="button" class="ge-art-slot" data-slot="logo" title="Logo"><i class="art-mini logo"></i><span>Logo</span></button>
            <button type="button" class="ge-art-slot" data-slot="icon" title="Icon"><i class="art-mini icon"></i><span>Icon</span></button>
            <div class="art-summary-actions">
              <button type="button" class="btn btn-ghost" data-art-expand>Change artwork</button>
            </div>
          </div>
          <div id="art-panel" class="art-panel" hidden>
            <div class="art-tabs">
              <button type="button" class="art-tab is-active" data-arttab="cover">Cover</button>
              <button type="button" class="art-tab" data-arttab="hero">Banner</button>
              <button type="button" class="art-tab" data-arttab="logo">Logo</button>
              <button type="button" class="art-tab" data-arttab="icon">Icon</button>
            </div>
            <div class="art-bar">
              <span id="art-match" class="art-match"></span>
              <button type="button" class="art-chip" data-art-rematch>Wrong game?</button>
            </div>
            <div class="art-filters" id="art-filters">
              <button type="button" class="art-pill is-active" data-style="">All</button>
              <button type="button" class="art-pill" data-style="official">Official</button>
              <button type="button" class="art-pill" data-style="alternate">Alternate</button>
              <button type="button" class="art-pill" data-style="white_logo">White logo</button>
              <button type="button" class="art-pill" data-style="material">Material</button>
            </div>
            <div id="art-results" class="art-results"></div>
            <button type="button" class="btn btn-ghost art-more" id="art-more" hidden>Load more</button>
            <details class="art-manual">
              <summary>Manual URLs</summary>
              <input class="input" id="f-cover" value="${esc(g.coverUrl || '')}" placeholder="Cover URL" />
              <input class="input" id="f-hero" value="${esc(g.heroUrl || '')}" placeholder="Banner URL" />
              <input class="input" id="f-logo" value="${esc(g.logoUrl || '')}" placeholder="Logo URL" />
              <input class="input" id="f-icon" value="${esc(g.iconUrl || '')}" placeholder="Icon URL" />
            </details>
          </div>
        </section>
        <section class="ge-sec">
          <h3 class="ge-sec-title"><label for="f-notes">Notes</label></h3>
          <textarea class="input" id="f-notes" style="height:70px;padding-top:9px" placeholder="Anything you want to remember about this game">${esc(g.notes || '')}</textarea>
        </section>
      </div>
      <div class="modal-foot">
        ${isNew ? '' : `<button class="btn btn-ghost ge-remove" data-remove-game>${editWish ? 'Remove from wishlist' : 'Remove from library'}</button>`}
        <button class="btn btn-ghost" data-close>Cancel</button>
        <button class="btn btn-primary" data-save>${isNew ? 'Add game' : 'Save'}</button>
      </div>
    `, { className: 'game-modal' });

    let chosen = g.sgdbId ? { id: g.sgdbId, name: g.name } : null;

    // Every await below re-checks that this dialog is still the open one:
    // closeModal() bumps modalSeq immediately, while the card itself stays in
    // the DOM for the close animation.
    const modalToken = modalSeq;
    const alive = () => modalToken === modalSeq && card.isConnected;

    const nameInput = card.querySelector('#f-name');
    const comboMenu = card.querySelector('#f-name-list');
    const artStatus = card.querySelector('#art-status');
    const artPanel = card.querySelector('#art-panel');
    const artResults = card.querySelector('#art-results');
    const artMatch = card.querySelector('#art-match');
    const artMore = card.querySelector('#art-more');

    const SLOTS = ['cover', 'hero', 'logo', 'icon'];
    const KIND = { cover: 'grids', hero: 'heroes', logo: 'logos', icon: 'icons' };
    const art = {
      cover: g.coverUrl || '', hero: g.heroUrl || '', logo: g.logoUrl || '', icon: g.iconUrl || '',
      tab: 'cover', style: '', expanded: false,
      items: { cover: [], hero: [], logo: [], icon: [] },
      page: { cover: 0, hero: 0, logo: 0, icon: 0 },
    };

    const artOrig = { cover: art.cover, hero: art.hero, logo: art.logo, icon: art.icon };
    const artCached = { cover: g._cover || '', hero: g._hero || '', logo: g._logo || '', icon: g._icon || '' };

    function slotInput(slot) {
      return card.querySelector({ cover: '#f-cover', hero: '#f-hero', logo: '#f-logo', icon: '#f-icon' }[slot]);
    }

    function renderStrip() {
      for (const el of card.querySelectorAll('[data-slot]')) {
        const slot = el.dataset.slot;
        const paint = el.querySelector('.art-mini') || el;
        // unchanged slots show the local copy the rest of the app shows (works offline)
        const shown = art[slot] && art[slot] === artOrig[slot] && artCached[slot] ? artCached[slot] : art[slot];
        paint.style.backgroundImage = shown ? cssUrl(shown) : '';
        paint.classList.toggle('is-empty', !art[slot]);
        el.classList.toggle('is-empty', !art[slot]);
      }
      const filled = SLOTS.filter((slot) => art[slot]).length;
      if (artStatus) {
        artStatus.textContent = filled === 0
          ? 'Not set'
          : filled === 4 ? 'Auto-filled from SteamGridDB' : `${filled} of 4 set`;
      }
    }

    function setSlot(slot, url) {
      art[slot] = url || '';
      const input = slotInput(slot);
      if (input) input.value = url || '';
      renderStrip();
    }

    // ---- title combobox ------------------------------------------------
    let comboItems = [];
    let comboIndex = -1;
    let comboTimer = null;
    let comboSeq = 0;      // latest title search; older replies are dropped
    let autofillSeq = 0;   // latest artwork autofill
    let artSeq = 0;        // latest artwork grid request

    function closeCombo() {
      comboMenu.hidden = true;
      nameInput.setAttribute('aria-expanded', 'false');
      comboIndex = -1;
    }

    function renderCombo(groups, emptyText = 'No match') {
      comboItems = [];
      let html = '';
      for (const group of groups) {
        if (!group.items.length) continue;
        html += `<div class="combo-group">${esc(group.title)}</div>`;
        for (const item of group.items) {
          const i = comboItems.length;
          comboItems.push(item);
          html += `
            <button type="button" class="combo-item" role="option" data-i="${i}">
              <span class="combo-name">${esc(item.name)}</span>
              <span class="combo-meta">${esc(item.meta || '')}</span>
            </button>`;
        }
      }
      if (!html) {
        comboMenu.innerHTML = `<div class="combo-empty">${esc(emptyText)}</div>`;
      } else {
        comboMenu.innerHTML = html;
        for (const el of comboMenu.querySelectorAll('.combo-item')) {
          el.onmouseenter = () => { comboIndex = Number(el.dataset.i); paintComboActive(); };
          el.onclick = () => chooseCombo(Number(el.dataset.i));
        }
      }
      comboMenu.hidden = false;
      nameInput.setAttribute('aria-expanded', 'true');
      comboIndex = -1;
    }

    function paintComboActive() {
      const items = comboMenu.querySelectorAll('.combo-item');
      items.forEach((el) => el.classList.toggle('is-active', Number(el.dataset.i) === comboIndex));
      if (comboIndex >= 0 && items[comboIndex]) items[comboIndex].scrollIntoView({ block: 'nearest' });
    }

    async function searchCombo(query) {
      const seq = ++comboSeq;
      const q = String(query || '').trim();
      if (q.length < 2) { closeCombo(); return; }

      const localHits = window.Fuzzy.bestMatch(q, state.games.filter((x) => x.id !== g.id), (x) => x.name, { limit: 4 })
        .all.map((entry) => ({
          kind: 'local', name: entry.item.name, meta: 'In your library', game: entry.item,
        }));

      // a newer search, a closed dialog, an edited title or a blurred input
      // all make a reply stale: never reopen the menu for it
      const stale = () => seq !== comboSeq || !alive() || nameInput.value.trim() !== q || document.activeElement !== nameInput;
      const yearOf = (d) => { const n = Number(d); if (!n) return ''; const y = new Date(n < 1e11 ? n * 1000 : n).getFullYear(); return y > 1970 ? String(y) : ''; };
      const norm = (x) => String(x || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

      // Steam's store search first: free, fast, and a pick brings Steam's own art
      let steamHits = [];
      if (api.steamSearch) {
        const res = await api.steamSearch(q).catch(() => null);
        if (stale()) return;
        if (res && res.ok) {
          steamHits = res.data.slice(0, 6).map((hit) => ({
            kind: 'steam', appId: hit.appId, name: hit.name, meta: wishPriceText(hit.price) || 'Steam',
          }));
        }
      }
      const groups = () => [
        { title: 'In your library', items: localHits },
        { title: 'Steam', items: steamHits },
        { title: 'SteamGridDB', items: sgdbHits },
      ];
      let sgdbHits = [];
      let note = 'No match';
      renderCombo(groups(), 'Searching…');

      // SteamGridDB: always with the user's own key; through the shared cache
      // only when Steam came up short (each new term counts toward its limit)
      if (api.sgdbGames && q.length >= 3 && (hasOwnSgdbKey() || steamHits.length < 3)) {
        const res = await api.sgdbGames(q).catch(() => null);
        if (stale()) return;
        if (res && res.ok && Array.isArray(res.data)) {
          const seen = new Set(steamHits.map((h) => norm(h.name)));
          sgdbHits = res.data.filter((hit) => hit && !seen.has(norm(hit.name))).slice(0, 6).map((hit) => ({
            kind: 'sgdb', id: hit.id, name: hit.name, meta: yearOf(hit.releaseDate) || 'SteamGridDB',
          }));
        } else if (res && res.error && res.error.code === 'NO_KEY') {
          note = 'Add a SteamGridDB key in Settings to search artwork';
        } else if (sgdbLimitText(res)) {
          note = sgdbLimitText(res);
        }
      }
      const keepIndex = comboIndex;
      renderCombo(groups(), note);
      if (keepIndex >= 0 && keepIndex < comboItems.length) { comboIndex = keepIndex; paintComboActive(); }
    }

    async function chooseCombo(index) {
      const item = comboItems[index];
      if (!item) return;
      closeCombo();
      if (item.kind === 'local') {
        const src = item.game;
        nameInput.value = src.name;
        card.querySelector('#f-exe').value = src.exePath || '';
        if (src.coverUrl) setSlot('cover', src.coverUrl);
        if (src.heroUrl) setSlot('hero', src.heroUrl);
        if (src.logoUrl) setSlot('logo', src.logoUrl);
        if (src.iconUrl) setSlot('icon', src.iconUrl);
        return;
      }
      if (item.kind === 'steam') {
        // Steam pick: its AppID is known, and Steam's own art needs no lookup
        chosen = null;
        nameInput.value = item.name;
        const appEl = card.querySelector('#f-steam');
        if (appEl) appEl.value = String(item.appId);
        await autofill(null, item.name, item.appId);
        return;
      }
      chosen = { id: item.id, name: item.name };
      nameInput.value = item.name;
      await autofill(item.id, item.name);
    }

    nameInput.addEventListener('input', () => {
      clearTimeout(comboTimer);
      const value = nameInput.value;
      comboTimer = setTimeout(() => searchCombo(value), 220);
    });

    nameInput.addEventListener('keydown', (e) => {
      if (comboMenu.hidden) {
        if (e.key === 'ArrowDown') { e.preventDefault(); searchCombo(nameInput.value); }
        return;
      }
      if (e.key === 'ArrowDown') { e.preventDefault(); comboIndex = Math.min(comboIndex + 1, comboItems.length - 1); paintComboActive(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); comboIndex = Math.max(comboIndex - 1, 0); paintComboActive(); }
      else if (e.key === 'Enter') { e.preventDefault(); chooseCombo(comboIndex < 0 ? 0 : comboIndex); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeCombo(); }
    });

    nameInput.addEventListener('blur', () => {
      clearTimeout(comboTimer);
      setTimeout(() => {
        if (document.activeElement === nameInput) return;   // focus came back
        comboSeq += 1;                                      // drop in-flight searches
        closeCombo();
      }, 150);
    });

    // ---- artwork autofill ---------------------------------------------
    async function autofill(id, name, steamAppId) {
      if (!api.sgdbAutofill) return;
      const seq = ++autofillSeq;
      const wantName = nameInput.value.trim();
      if (artStatus) artStatus.textContent = 'Fetching artwork…';
      const res = await api.sgdbAutofill(steamAppId && !id
        ? { name, steamAppId, slots: ['cover', 'hero', 'logo'] }
        : { id, name }).catch(() => null);
      // stale: a newer pick, a closed dialog, or the title was edited since
      if (seq !== autofillSeq || !alive() || nameInput.value.trim() !== wantName) {
        if (alive() && seq === autofillSeq) renderStrip();   // clear "Fetching…"
        return;
      }
      if (!res || !res.ok) {
        if (artStatus) {
          artStatus.textContent = res && res.error && res.error.code === 'NO_KEY'
            ? 'Add a SteamGridDB key in Settings'
            : res && res.error && res.error.code === 'RATE_LIMIT'
              ? 'Artwork lookups paused for a bit (hourly limit)'
              : 'Artwork unavailable';
        }
        return;
      }
      const assets = res.data.assets || {};
      for (const slot of SLOTS) {
        if (assets[slot] && assets[slot].url) setSlot(slot, assets[slot].url);
      }
      const match = res.data.match || {};
      if (match.id) chosen = { id: match.id, name: match.name || name };
      if (artMatch) {
        const pct = match.score ? Math.round(Math.min(100, match.score / 10)) : null;
        artMatch.textContent = `Matched: ${match.name || name}${pct ? ` · ${pct}%` : ''}`;
      }
      renderStrip();
    }

    // ---- artwork grid --------------------------------------------------
    function renderArtGrid(tab, append) {
      const items = art.items[tab];
      if (!items.length) {
        artResults.innerHTML = '<div class="art-empty">No artwork found.</div>';
        artMore.hidden = true;
        return;
      }
      const thumbHtml = (list) => list.map((asset) => `
        <button type="button" class="sg-thumb ${tab}" data-url="${esc(asset.url)}">
          <img src="${esc(asset.thumb || asset.url)}" alt="" loading="lazy" decoding="async" />
        </button>`).join('');

      // append: the number of items already on screen; only the rest is added
      let container = artResults.querySelector(`.art-grid.${tab}`);
      if (typeof append === 'number' && append >= 0 && container) {
        container.insertAdjacentHTML('beforeend', thumbHtml(items.slice(append)));
      } else {
        artResults.innerHTML = `<div class="art-grid ${tab}">${thumbHtml(items)}</div>`;
        container = artResults.querySelector('.art-grid');
      }
      for (const im of container.querySelectorAll('img:not([data-faded])')) { im.dataset.faded = '1'; fadeInOnLoad(im); }
      for (const el of container.querySelectorAll('[data-url]')) {
        if (el.dataset.url === art[tab]) el.classList.add('is-picked');
        el.onclick = () => {
          setSlot(tab, el.dataset.url);
          for (const o of artResults.querySelectorAll('[data-url]')) o.classList.toggle('is-picked', o === el);
        };
      }
      artMore.hidden = !art.hasMore;
    }

    async function loadArtTab(slot, page = 0, append = false) {
      const seq = ++artSeq;
      if (!chosen || !chosen.id) {
        artResults.innerHTML = '<div class="art-empty">Search for the game above first.</div>';
        return;
      }
      const gameId = chosen.id;
      const style = art.style;
      // "Load more" keeps the current grid on screen while the page loads
      if (!append) artResults.innerHTML = '<div class="art-empty">Loading…</div>';
      else artMore.disabled = true;
      const res = await api.sgdbAssets({ kind: KIND[slot], id: gameId, page, styles: style ? [style] : undefined }).catch(() => null);
      if (append && artMore.isConnected) artMore.disabled = false;
      // stale: a newer request, a closed dialog, another tab/style/game since
      if (seq !== artSeq || !alive() || art.tab !== slot || art.style !== style || !chosen || chosen.id !== gameId) return;
      if (!res || !res.ok) {
        artResults.innerHTML = `<div class="art-empty">${res && res.error ? esc(res.error.message) : 'Could not load artwork'}</div>`;
        return;
      }
      const list = (res.data.items || []).map((item) => ({ url: item.url, thumb: item.thumb, id: item.id }));
      art.hasMore = !!res.data.hasMore;
      const shown = append ? art.items[slot].length : -1;
      if (append) {
        const have = new Set(art.items[slot].map((o) => o.url));
        art.items[slot] = art.items[slot].concat(list.filter((n) => !have.has(n.url)));
      } else {
        art.items[slot] = list;
      }
      art.page[slot] = page;
      renderArtGrid(slot, shown);
      if (!append) (card.querySelector('#art-summary') || artPanel).scrollIntoView({ block: 'start' });
    }

    function setTab(slot) {
      art.tab = slot;
      for (const t of card.querySelectorAll('[data-arttab]')) t.classList.toggle('is-active', t.dataset.arttab === slot);
      for (const el of card.querySelectorAll('.ge-art-slot')) el.classList.toggle('is-current', el.dataset.slot === slot);
      loadArtTab(slot, 0, false);
    }

    for (const t of card.querySelectorAll('[data-arttab]')) t.onclick = () => setTab(t.dataset.arttab);

    for (const p of card.querySelectorAll('[data-style]')) {
      p.onclick = () => {
        art.style = p.dataset.style;
        for (const o of card.querySelectorAll('[data-style]')) o.classList.toggle('is-active', o === p);
        loadArtTab(art.tab, 0, false);
      };
    }

    if (artMore) artMore.onclick = () => loadArtTab(art.tab, art.page[art.tab] + 1, true);

    const expand = card.querySelector('[data-art-expand]');

    async function openArtPanel(slot) {
      if (slot) art.tab = slot;
      for (const el of card.querySelectorAll('.ge-art-slot')) el.classList.toggle('is-current', el.dataset.slot === art.tab);
      for (const t of card.querySelectorAll('[data-arttab]')) {
        t.classList.toggle('is-active', t.dataset.arttab === art.tab);
      }
      art.expanded = true;
      artPanel.hidden = false;
      artPanel.closest('.ge-art-sec')?.classList.add('is-picking');   // current picks stay pinned above the grid
      if (expand) expand.textContent = 'Hide artwork';
      if (artMatch && !artMatch.textContent) {
        artMatch.textContent = `Matched: ${(chosen && chosen.name) || g.name || nameInput.value}`;
      }
      // keep the row of current picks in view above the picker
      (card.querySelector('#art-summary') || artPanel).scrollIntoView({ block: 'start', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });

      // Editing a game that never matched: resolve it on demand.
      if (!chosen || !chosen.id) {
        const name = (nameInput.value || g.name || '').trim();
        if (name) {
          await autofill(null, name);
          if (!alive() || !art.expanded) return;
          if (!chosen || !chosen.id) {
            artResults.innerHTML = '<div class="art-empty">No SteamGridDB match. Pick the game from the title dropdown.</div>';
            return;
          }
        } else {
          artResults.innerHTML = '<div class="art-empty">Search for the game above first.</div>';
          return;
        }
      }
      loadArtTab(art.tab, 0, false);
    }

    if (expand) {
      expand.onclick = () => {
        if (art.expanded) {
          art.expanded = false;
          artPanel.hidden = true;
          artPanel.closest('.ge-art-sec')?.classList.remove('is-picking');
          expand.textContent = 'Change artwork';
        } else {
          openArtPanel(art.tab);
        }
      };
    }

    // the four thumbnails are shortcuts into the matching tab
    for (const mini of card.querySelectorAll('[data-slot]')) {
      mini.onclick = () => openArtPanel(mini.dataset.slot);
    }

    const rematch = card.querySelector('[data-art-rematch]');
    if (rematch) {
      rematch.onclick = () => {
        nameInput.focus();
        nameInput.select();
        searchCombo(nameInput.value);
      };
    }

    for (const slot of SLOTS) {
      const input = slotInput(slot);
      if (input) input.addEventListener('input', () => { art[slot] = input.value.trim(); renderStrip(); });
    }

    renderStrip();
    if (g.name && !chosen && api.sgdbAutofill) {
      // Editing an existing game with art already: just fill the strip.
    }

    // Finished and Wishlist are mutually exclusive: a wishlisted game is not
    // owned yet, so it cannot be finished (legacy status 'Want' = wishlisted).
    let wishlisted = editWish;
    let finished = editFinished;
    const finishBtn = card.querySelector('[data-finished-edit]');
    const wishBtn = card.querySelector('[data-wish-edit]');
    const statusHint = card.querySelector('[data-status-hint]');
    const paintStatus = () => {
      finishBtn.classList.toggle('is-on', finished);
      finishBtn.setAttribute('aria-pressed', String(finished));
      finishBtn.title = finished ? 'Click to mark as not finished' : '';
      swapLabel(finishBtn.querySelector('[data-label]'), finished ? 'Finished' : 'Mark as finished');
      wishBtn.classList.toggle('is-on', wishlisted);
      wishBtn.setAttribute('aria-pressed', String(wishlisted));
      wishBtn.title = wishlisted ? 'Click to take it off your wishlist' : '';
      swapLabel(wishBtn.querySelector('[data-label]'), wishlisted ? 'On wishlist' : 'Add to wishlist');
      statusHint.textContent = wishlisted
        ? 'Not in your library yet, so playtime isn’t tracked.'
        : finished && !editFinished ? 'It moves to your Finished games when you save.'
          : !finished && editFinished ? 'It goes back to Playing when you save.' : '';
    };
    finishBtn.onclick = () => { finished = !finished; if (finished) wishlisted = false; paintStatus(); };
    wishBtn.onclick = () => { wishlisted = !wishlisted; if (wishlisted) finished = false; paintStatus(); };
    paintStatus();

    card.querySelector('[data-browse]').onclick = async () => {
      const file = await api.pickExe();
      if (file) card.querySelector('#f-exe').value = file;
    };

    // Launch & tracking (tracker split): what to open vs what counts as playing.
    const trackModeEl = card.querySelector('#f-track-mode');
    const trackExeEl = card.querySelector('#f-track-exe');
    const trackRow = card.querySelector('[data-track-exe-row]');
    const detectList = card.querySelector('[data-detect-list]');
    trackModeEl.value = ['auto', 'exe', 'steam', 'none'].includes(g.trackMode) ? g.trackMode : (g.trackExe ? 'exe' : 'auto');
    const adv = card.querySelector('.adv-launch');
    const advSum = adv && adv.querySelector('summary');
    if (advSum) advSum.addEventListener('click', (e) => {
      if (prefersReducedMotion()) return;
      e.preventDefault();
      if (adv._anim) adv._anim.cancel();
      const opening = !adv.open;
      const from = adv.getBoundingClientRect().height;
      if (opening) adv.open = true;
      else { adv.open = false; }
      const closedTo = opening ? null : adv.getBoundingClientRect().height;
      if (!opening) adv.open = true;   // stay open while it folds
      const to = opening ? adv.getBoundingClientRect().height : closedTo;
      adv.style.overflow = 'hidden';
      adv.style.flexShrink = '0';   // the dialog body is a flex column: don't let it squeeze the fold
      adv._anim = adv.animate([{ height: from + 'px' }, { height: to + 'px' }],
        { duration: 260, easing: 'cubic-bezier(0.22, 0.8, 0.3, 1)' });
      const done = () => { adv.style.overflow = ''; adv.style.flexShrink = ''; adv._anim = null; if (!opening) adv.open = false; };
      adv._anim.onfinish = done;
      adv._anim.oncancel = () => { adv.style.overflow = ''; adv.style.flexShrink = ''; };
    });
    const syncTrackRow = () => { trackRow.hidden = trackModeEl.value !== 'exe'; if (trackRow.hidden) detectList.hidden = true; };
    trackModeEl.onchange = syncTrackRow;
    syncTrackRow();
    card.querySelector('[data-browse-launch]').onclick = async () => {
      const file = await api.pickExe();
      if (file) card.querySelector('#f-launch').value = file;
    };
    card.querySelector('[data-detect]').onclick = async () => {
      if (!api.runningProcesses) return;
      detectList.hidden = false;
      detectList.textContent = 'Looking at running programs…';
      const installDir = g.installDir || '';
      const list = await api.runningProcesses({ installDir }).catch(() => []);
      if (!alive()) return;
      detectList.innerHTML = '';
      if (!list || !list.length) { detectList.textContent = 'Nothing found — start the game first, then press Detect.'; return; }
      for (const p of list) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'detect-item' + (p.inGameFolder ? ' is-likely' : '');
        b.textContent = p.inGameFolder ? `${p.name}  · in the game's folder` : p.name;
        b.onclick = () => { trackExeEl.value = p.name; detectList.hidden = true; };
        detectList.appendChild(b);
      }
      if (!prefersReducedMotion()) {
        [...detectList.children].slice(0, 12).forEach((row, i) => row.animate(
          [{ opacity: 0, transform: 'translateY(4px)' }, { opacity: 1, transform: 'none' }],
          { duration: 300, delay: i * 30, easing: 'cubic-bezier(0.22, 0.8, 0.3, 1)', fill: 'backwards' }
        ));
      }
    };

    for (const btn of card.querySelectorAll('[data-close]')) btn.onclick = closeModal;
    const removeBtn = card.querySelector('[data-remove-game]');
    if (removeBtn) removeBtn.onclick = () => { closeModal(); askRemoveGame(g); };

    let saving = false;
    const saveBtnEl = card.querySelector('[data-save]');
    saveBtnEl.onclick = async () => {
      if (saving || !alive()) return;
      saving = true;
      saveBtnEl.disabled = true;
      const name = card.querySelector('#f-name').value.trim();
      const exePath = card.querySelector('#f-exe').value.trim();
      const coverUrl = card.querySelector('#f-cover').value.trim();
      const heroUrl = card.querySelector('#f-hero').value.trim();
      const logoUrl = card.querySelector('#f-logo') ? card.querySelector('#f-logo').value.trim() : '';
      const iconUrl = card.querySelector('#f-icon') ? card.querySelector('#f-icon').value.trim() : '';
      const notes = card.querySelector('#f-notes').value;
      const steamAppId = Number(card.querySelector('#f-steam').value) || null;
      // Playtime only changes when the field was edited; the field shows a
      // rounded value, so an untouched save must not round the real one.
      const hoursEl = card.querySelector('#f-hours');
      const typedHours = Math.max(0, Number(String(hoursEl.value).replace(',', '.')) || 0);
      const shownHours = Number(g.hours) > 0 ? Math.round(Number(g.hours) * 10) / 10 : 0;
      const hoursEdited = Number.isFinite(typedHours) && typedHours !== shownHours;
      const launchTarget = card.querySelector('#f-launch').value.trim();
      const trackExe = trackModeEl.value === 'exe' ? trackExeEl.value.trim() : '';
      // "This program…" with nothing picked falls back to automatic
      const trackMode = trackModeEl.value === 'exe' && !trackExe ? 'auto' : trackModeEl.value;

      if (!name) { toast('A title is required', 'error'); saving = false; saveBtnEl.disabled = false; return; }

      // Artwork picked from the grid is a CDN url; download it once so the
      // banner survives restarts and works offline.
      const localize = async (url, kind) => {
        if (!url || !/^https?:/i.test(url) || !api.sgdbCache) return url;
        const res = await api.sgdbCache({ url, kind }).catch(() => null);
        return res && res.ok ? res.data : url;
      };

      const [coverLocal, heroLocal, logoLocal, iconLocal] = await Promise.all([
        localize(coverUrl, 'cover'),
        localize(heroUrl, 'hero'),
        localize(logoUrl, 'logo'),
        localize(iconUrl, 'icon'),
      ]);

      // Cancel / Esc / backdrop while the artwork downloaded: the user backed
      // out, so nothing is saved even though the card is still animating out.
      if (!alive()) return;

      const isWish = !!wishlisted && !finished;
      const nextStatus = finished ? 'Finished' : 'Playing';

      if (isNew) {
        state.games.unshift({
          id: Date.now(),
          name,
          exePath,
          coverUrl: coverLocal,
          heroUrl: heroLocal,
          logoUrl: logoLocal,
          iconUrl: iconLocal,
          sgdbId: chosen ? chosen.id : null,
          steamAppId,
          launchTarget,
          trackMode,
          trackExe,
          artVersion: 2,
          notes,
          status: nextStatus,
          wishlisted: isWish,
          hours: typedHours,
          ...(typedHours > 0 ? { hoursSetAt: Date.now() } : {}),
          sessions: [],
          added: Date.now(),
          source: 'Manual',
        });
      } else {
        Object.assign(g, {
          name, exePath, coverUrl: coverLocal, heroUrl: heroLocal, logoUrl: logoLocal, iconUrl: iconLocal, notes, status: nextStatus, wishlisted: isWish,
          sgdbId: chosen ? chosen.id : (g.sgdbId || null),
          steamAppId,
          launchTarget,
          trackMode,
          trackExe,
          artVersion: 2,
          ...(hoursEdited ? { hours: typedHours, hoursSetAt: Date.now() } : {}),
        });
      }

      const target = isNew ? state.games[0] : g;
      for (const key of ['_cover', '_hero', '_logo', '_icon', '_noHero']) delete target[key];

      closeModal();
      saveGamesSoon();
      state._shelfKey = '';
      refreshArt(target, { focus: isNew });
      toast(isNew ? 'Game added' : 'Saved', 'ok');
      saving = false;
      if (saveBtnEl.isConnected) saveBtnEl.disabled = false;
    };
  }

  function fileUrl(pathname) {
    return 'file://' + encodeURI(String(pathname)).replace(/#/g, '%23');
  }

  const SOURCE_ICON = {
    steam: ['S', 'is-steam'],
    'steam-owned': ['S', 'is-steam'],
    hydra: ['H', 'is-hydra'],
    lutris: ['L', 'is-lutris'],
    heroic: ['H', 'is-heroic'],
    bottles: ['B', 'is-bottles'],
    itch: ['i', 'is-itch'],
    epic: ['E', 'is-epic'],
    gog: ['G', 'is-gog'],
    xbox: ['X', 'is-xbox'],
    battlenet: ['B', 'is-bnet'],
    ea: ['EA', 'is-ea'],
    ubisoft: ['U', 'is-ubi'],
    playnite: ['P', 'is-pl'],
    pc: ['PC', 'is-pl'],
    desktop: ['PC', 'is-pl'],
    AppImage: ['A', 'is-pl'],
    Wine: ['W', 'is-pl'],
    Minecraft: ['M', 'is-pl'],
    folder: ['⌸', 'is-pl'],
    file: ['⌘', 'is-pl'],
  };

  function sourceIcon(id) {
    const [letter, cls] = SOURCE_ICON[id] || [String(id || '?').slice(0, 1).toUpperCase(), ''];
    return `<span class="isk-ico ${cls}">${letter}</span>`;
  }

  function openImportModal() {
    const card = openModal(`
      <div class="modal-head">
        <h2 id="import-title">Import games</h2>
        <button class="close-x" data-close aria-label="Close">✕</button>
      </div>

      <div class="imp3-step" data-step="options">
        <div class="imp3-row">
          <span class="imp3-label">Import from</span>
          <span class="imp3-pick-wrap">
            <button class="imp3-pick" data-pick aria-haspopup="listbox" aria-expanded="false">
              <span class="imp3-pick-ico" data-pick-ico></span>
              <span class="imp3-pick-name" data-pick-name>Select launcher</span>
              <span class="imp3-caret">⌄</span>
            </button>
            <div class="imp3-menu" data-menu hidden role="listbox" aria-label="Launchers"></div>
          </span>
          <span class="imp3-word">launcher</span>
        </div>

        <div class="imp3-row">
          <span class="imp3-label">Connect</span>
          <div class="imp3-account" data-account></div>
        </div>

        <div class="imp3-row">
          <span class="imp3-label">Scan</span>
          <button class="imp3-pick" data-scan-folder>Scan a folder…</button>
          <button class="imp3-pick" data-scan-pc disabled title="Needs the deep scanner">Whole PC</button>
        </div>
      </div>

      <div class="imp3-step" data-step="review" hidden>
        <div class="imp3-review-head">
          <button class="imp3-back" data-back>‹ Back</button>
          <span class="imp3-review-title" data-review-title></span>
        </div>
        <div class="imp3-list" data-list role="list"></div>
      </div>

      <footer class="imp3-foot">
        <span class="imp3-summary" data-summary role="status" aria-live="polite" aria-atomic="true">Nothing selected</span>
        <div class="imp3-foot-actions">
          <button class="btn btn-ghost" data-close>Cancel</button>
          <button class="btn btn-primary" data-primary disabled>Continue</button>
        </div>
      </footer>
    `, { className: 'imp3-modal' });

    card.setAttribute('aria-labelledby', 'import-title');

    const optionsStep = card.querySelector('[data-step="options"]');
    const reviewStep = card.querySelector('[data-step="review"]');
    const pickBtn = card.querySelector('[data-pick]');
    const pickIco = card.querySelector('[data-pick-ico]');
    const pickName = card.querySelector('[data-pick-name]');
    const menuEl = card.querySelector('[data-menu]');
    const listEl = card.querySelector('[data-list]');
    const reviewTitle = card.querySelector('[data-review-title]');
    const accountEl = card.querySelector('[data-account]');
    const summaryEl = card.querySelector('[data-summary]');
    const primaryBtn = card.querySelector('[data-primary]');
    const folderBtn = card.querySelector('[data-scan-folder]');

    let sources = [];
    let activeId = null;
    let candidates = [];
    let busy = false;
    let scanSeq = 0;
    let scanError = null;
    let pickedNothing = false;
    let inReview = false;

    for (const btn of card.querySelectorAll('[data-close]')) btn.onclick = closeModal;

    // Duplicate detection. Paths compare with normalized separators, and
    // case-insensitively on Windows; Steam entries also match by AppID (so a
    // wishlist entry for a game you already have is not offered again).
    const IS_WIN = /Windows/i.test(navigator.userAgent);
    const normPath = (p) => {
      let s = String(p || '').trim().replace(/[\\/]+/g, '/').replace(/\/$/, '');
      if (IS_WIN) s = s.toLowerCase();
      return s;
    };
    const appIdOf = (x) => {
      const n = Number(x && x.steamAppId);
      if (Number.isFinite(n) && n > 0) return n;
      const m = /^steam(?:-owned|-wishlist)?:(\d+)$/.exec(String((x && x.sourceId) || ''));
      return m ? Number(m[1]) : 0;
    };
    const nameKey = (x) => String((x && x.name) || '').trim().toLowerCase();
    // Lookup maps over the library, built once per review paint instead of
    // scanning state.games for every candidate on every checkbox change.
    let libIndex = null;
    const buildLibIndex = () => {
      const bySource = new Map(), byPath = new Map(), byApp = new Map(), byName = new Map();
      for (const g of state.games) {
        if (g.sourceId) bySource.set(String(g.sourceId), g);
        const p = normPath(g.exePath);
        if (p && !byPath.has(p)) byPath.set(p, g);
        const app = appIdOf(g);
        if (app && !byApp.has(app)) byApp.set(app, g);
        // name only identifies entries that have neither a sourceId nor a path
        if (!g.sourceId && !p && nameKey(g) && !byName.has(nameKey(g))) byName.set(nameKey(g), g);
      }
      libIndex = { bySource, byPath, byApp, byName, size: state.games.length };
      return libIndex;
    };
    const existingFor = (c) => {
      const ix = libIndex && libIndex.size === state.games.length ? libIndex : buildLibIndex();
      if (c.sourceId && ix.bySource.has(String(c.sourceId))) return ix.bySource.get(String(c.sourceId));
      const p = normPath(c.exePath);
      if (p && ix.byPath.has(p)) return ix.byPath.get(p);
      const app = appIdOf(c);
      if (app && ix.byApp.has(app)) return ix.byApp.get(app);
      if (!c.sourceId && !p) return ix.byName.get(nameKey(c)) || null;
      return null;
    };
    const isNew = (c) => !existingFor(c);
    const picked = () => candidates.filter((c) => c._checked && isNew(c));
    const labelOf = (id) => (sources.find((s) => s.id === id) || {}).label || id;

    let steamUser = null;

    const loadOwned = (games, wishlist) => {
      scanSeq += 1;
      busy = false;
      scanError = null;
      pickedNothing = false;
      candidates = (games || []).filter((g) => g && g.name).map((g) => ({ ...g, wishlisted: false, _checked: true }));
      // Wishlist entries are review candidates too, unchecked by default and
      // clearly marked; skip anything the account already owns.
      const ownedApps = new Set(candidates.map(appIdOf).filter(Boolean));
      const seenWish = new Set();
      for (const w of wishlist || []) {
        const appid = Number(w && w.appid);
        const name = w && typeof w.name === 'string' ? w.name.trim() : '';
        if (!appid || !name || ownedApps.has(appid) || seenWish.has(appid)) continue;
        seenWish.add(appid);
        candidates.push({
          name,
          source: 'Steam wishlist',
          sourceId: `steam-wishlist:${appid}`,
          steamAppId: appid,
          exePath: '', installDir: '', hours: 0, iconPath: '',
          wishlisted: true,
          _checked: false,
        });
      }
      activeId = 'steam-owned';
      inReview = true;
      optionsStep.hidden = true;
      reviewStep.hidden = false;
      reviewTitle.textContent = 'Steam account';
      paintReview();
      paintSummary();
    };

    const paintAccount = async () => {
      const hasKey = !!state.config.hasSteamKey;
      const acc = await (api.steamAccount ? api.steamAccount().catch(() => ({ users: [], active: null })) : Promise.resolve({ users: [], active: null }));
      steamUser = (acc.users || [])[0] || null;
      accountEl.innerHTML = `
        <button class="imp3-pick" data-acc>${sourceIcon('steam')}<span>${hasKey ? 'Steam · owned games' : 'Connect Steam'}</span></button>
        <span class="imp3-acc-hint" data-acc-hint>${hasKey ? 'Connected' : steamUser ? `SteamID ${esc(steamUser.steamId)}` : 'not detected'}</span>
        <button class="imp3-link" data-key-toggle>${hasKey ? 'Change key' : 'Use an API key instead'}</button>
        <div class="imp3-connect" data-connect hidden>
          <input class="input" data-steam-key type="password" placeholder="Steam Web API key" autocomplete="off" spellcheck="false" aria-label="Steam Web API key" />
          <button class="btn btn-ghost" data-steam-save>Save and load</button>
          <span class="imp3-acc-hint">steamcommunity.com/dev/apikey — needs “Game details” public</span>
        </div>`;
      const btn = accountEl.querySelector('[data-acc]');
      const panel = accountEl.querySelector('[data-connect]');
      const input = accountEl.querySelector('[data-steam-key]');
      const hint = accountEl.querySelector('[data-acc-hint]');
      const keyToggle = accountEl.querySelector('[data-key-toggle]');

      if (keyToggle) keyToggle.onclick = () => {
        panel.hidden = !panel.hidden;
        if (!panel.hidden) input.focus();
      };

      if (btn) btn.onclick = async () => {
        if (hasKey) { activeId = 'steam-owned'; syncPick(); runScan('steam-owned'); return; }
        if (!api.steamLogin) { panel.hidden = false; input.focus(); return; }
        hint.textContent = 'Waiting for Steam…';
        btn.disabled = true;
        const res = await api.steamLogin().catch(() => null);
        btn.disabled = false;
        if (res && res.ok && res.data && res.data.owned && res.data.owned.length) {
          const d = res.data;
          const bits = [`${d.owned.length} owned`];
          if (d.wishlist && d.wishlist.length) bits.push(`${d.wishlist.length} wishlist`);
          if (d.friends && d.friends.length) bits.push(`${d.friends.length} friends`);
          toast(`Steam signed in · ${bits.join(' · ')}`, 'ok');
          state.steamWishlist = d.wishlist || [];
          loadOwned(d.owned, d.wishlist);
        } else {
          const msg = (res && res.error && res.error.message) || 'Steam sign-in failed';
          hint.textContent = 'Not connected';
          toast(msg, 'error');
          panel.hidden = false;
          input.focus();
        }
      };

      const save = accountEl.querySelector('[data-steam-save]');
      if (save) save.onclick = async () => {
        const key = input.value.trim();
        if (!key) { toast('Paste a Steam Web API key first', 'error'); return; }
        await saveConfigPatch({ steamKey: key, steamId: steamUser ? steamUser.steamId : (state.config.steamId || null) });
        panel.hidden = true;
        toast('Steam connected', 'ok');
        activeId = 'steam-owned';
        syncPick();
        runScan('steam-owned');
      };
      if (input) input.onkeydown = (e) => { if (e.key === 'Enter') save.click(); };
    };

    const syncPick = () => {
      const src = sources.find((s) => s.id === activeId);
      pickName.textContent = src ? src.label : 'Select launcher';
      pickIco.innerHTML = src ? sourceIcon(src.id) : '';
      primaryBtn.textContent = inReview ? primaryLabel() : 'Continue';
      primaryBtn.disabled = inReview ? picked().length === 0 || busy : !(src && src.found);
    };

    const primaryLabel = () => {
      const n = picked().length;
      return n ? `Import ${n} game${n === 1 ? '' : 's'}` : 'Import';
    };

    const paintMenu = () => {
      const launchers = sources.filter((s) => !s.action && s.id !== 'folder' && s.id !== 'file' && s.id !== 'steam-owned');
      const row = (s) => `<button class="imp3-menu-row${s.id === activeId ? ' is-active' : ''}" data-src="${esc(s.id)}" ${s.found ? '' : 'disabled'} role="option" aria-selected="${s.id === activeId}">
        ${sourceIcon(s.id)}
        <span class="imp3-menu-name">${esc(s.label)}</span>
        <span class="imp3-menu-meta">${s.found ? (s.count ? s.count : '') : 'not found'}</span>
      </button>`;
      menuEl.innerHTML = `${launchers.map(row).join('')}`;
      for (const r of menuEl.querySelectorAll('[data-src]')) {
        r.onclick = () => {
          menuEl.hidden = true;
          pickBtn.setAttribute('aria-expanded', 'false');
          activeId = r.dataset.src;
          syncPick();
        };
      }
    };

    pickBtn.onclick = () => {
      const open = menuEl.hidden;
      if (open) paintMenu();
      menuEl.hidden = !open;
      pickBtn.setAttribute('aria-expanded', String(open));
    };

    const metaFor = (c) => {
      const bits = [];
      if (c.wishlisted) bits.push('Wishlist · not owned yet');
      else if (c.source) bits.push(c.source);
      if (c.hours > 0) bits.push(`${Number(c.hours).toFixed(1).replace(/\.0$/, '')}h`);
      if (c.kind) bits.push(c.kind);
      return bits.join(' · ') || 'Game';
    };

    let reviewAnimated = false;
    const paintReview = () => {
      const total = candidates.length;
      if (busy) { listEl.innerHTML = `<div class="imp3-empty">Reading ${esc(labelOf(activeId))}…</div>`; return; }
      if (scanError) { listEl.innerHTML = `<div class="imp3-empty" role="alert">${esc(scanError)}</div>`; return; }
      if (!total) { listEl.innerHTML = `<div class="imp3-empty">${pickedNothing ? 'Nothing was chosen.' : 'No games found.'}</div>`; return; }
      buildLibIndex();
      let wishHeader = false;
      listEl.innerHTML = candidates.map((c, idx) => {
        const exists = !isNew(c);
        let head = '';
        if (c.wishlisted && !wishHeader) {
          wishHeader = true;
          head = `<div class="imp3-group" role="listitem">Steam wishlist <span>· imported to your Wishlist, not the library</span></div>`;
        }
        if (exists) {
          return `${head}<div class="imp3-item is-owned${c.wishlisted ? ' is-wish' : ''}" role="listitem" aria-label="${esc(c.name)} — already in your library">
            <span class="import-row-check" aria-hidden="true">✓</span>
            <span class="import-row-main"><span class="import-row-name">${esc(c.name)}</span><span class="import-row-meta">${esc(metaFor(c))}</span></span>
            <button class="import-update" data-update="${idx}" aria-label="Update art for ${esc(c.name)}">Update art</button>
          </div>`;
        }
        return `${head}<label class="imp3-item${c.wishlisted ? ' is-wish' : ''}" role="listitem">
          <input type="checkbox" data-idx="${idx}" aria-label="${esc(c.name)}, ${c.wishlisted ? 'wishlist' : 'new'}" ${c._checked ? 'checked' : ''} />
          <span class="import-row-main"><span class="import-row-name">${esc(c.name)}</span><span class="import-row-meta" aria-hidden="true">${esc(metaFor(c))}</span></span>
        </label>`;
      }).join('');
      for (const box of listEl.querySelectorAll('input[data-idx]')) {
        box.onchange = () => { candidates[Number(box.dataset.idx)]._checked = box.checked; paintSummary(); };
      }
      for (const upd of listEl.querySelectorAll('[data-update]')) {
        upd.onclick = () => {
          if (upd.dataset.busy) return;
          const existing = existingFor(candidates[Number(upd.dataset.update)]);
          if (!existing) return;
          upd.dataset.busy = '1'; upd.disabled = true; upd.textContent = 'Updating…';
          Promise.resolve(refreshArt(existing, { focus: false }))
            .then(() => toast(`Updated ${existing.name}`, 'ok'))
            .finally(() => { upd.textContent = 'Update art'; upd.disabled = false; delete upd.dataset.busy; });
        };
      }
      if (!reviewAnimated && !prefersReducedMotion()) {
        reviewAnimated = true;
        Array.from(listEl.querySelectorAll('.imp3-item')).slice(0, 18).forEach((row, i) => {
          row.animate(
            [{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }],
            { duration: 480, delay: i * 26, easing: 'cubic-bezier(0.22, 0.8, 0.3, 1)', fill: 'backwards' }
          );
        });
      }
    };

    const paintSummary = () => {
      if (!inReview) {
        const src = sources.find((s) => s.id === activeId);
        summaryEl.textContent = src ? `${src.label} selected` : 'Nothing selected';
      } else if (busy) summaryEl.textContent = `Reading ${labelOf(activeId)}…`;
      else {
        const total = candidates.length;
        const fresh = candidates.filter(isNew).length;
        if (!total) summaryEl.textContent = scanError ? 'Scan failed' : 'No games found';
        else if (fresh === 0) summaryEl.textContent = `All ${total} already in your library`;
        else summaryEl.textContent = `${fresh} new · ${picked().length} selected`;
      }
      primaryBtn.textContent = inReview ? primaryLabel() : 'Continue';
      primaryBtn.disabled = inReview ? (picked().length === 0 || busy) : !(sources.find((s) => s.id === activeId) || {}).found;
    };

    async function runScan(id) {
      const seq = ++scanSeq;
      busy = true;
      scanError = null;
      pickedNothing = false;
      candidates = [];
      inReview = true;
      optionsStep.hidden = true;
      reviewStep.hidden = false;
      reviewTitle.textContent = labelOf(id);
      paintReview();
      paintSummary();
      try {
        let found = [];
        if (id === 'folder') found = await api.importFolder();
        else if (id === 'file') found = await api.importFile();
        else found = await api.importScan(id);
        if (found === null) { inReview = false; optionsStep.hidden = false; reviewStep.hidden = true; busy = false; paintSummary(); return; }
        if (seq !== scanSeq) return;
        if (found && found.error) throw new Error(found.error);
        if (seq !== scanSeq) return;
        candidates = (found || []).filter((c) => c && c.name).map((c) => ({ ...c, wishlisted: !!c.wishlisted, _checked: !c.wishlisted }));
        pickedNothing = candidates.length === 0 && (id === 'folder' || id === 'file');
        const src = sources.find((s) => s.id === id);
        if (src && !src.action) src.count = candidates.length;
      } catch (e) {
        if (seq === scanSeq) scanError = String(e.message || e);
      } finally {
        if (seq === scanSeq) {
          busy = false;
          paintReview();
          paintSummary();
        }
      }
    }

    folderBtn.onclick = () => { activeId = 'folder'; syncPick(); runScan('folder'); };

    card.querySelector('[data-back]').onclick = () => {
      scanSeq += 1;
      busy = false;
      inReview = false;
      reviewAnimated = false;
      reviewStep.hidden = true;
      optionsStep.hidden = false;
      syncPick();
      paintSummary();
    };

    primaryBtn.onclick = async () => {
      if (!inReview) { if (activeId) runScan(activeId); return; }
      const list = picked();
      if (!list.length) return;
      primaryBtn.disabled = true;
      const total = list.length;
      const wishCount = list.filter((c) => c.wishlisted).length;
      for (let i = 0; i < total; i++) {
        primaryBtn.textContent = `Importing ${i + 1}/${total}…`;
        const c = list[i];
        state.games.unshift({
          id: crypto.randomUUID(),
          name: c.name,
          source: c.source || labelOf(activeId),
          sourceId: c.sourceId || null,
          exePath: c.exePath || '',
          installDir: c.installDir || '',
          steamAppId: c.steamAppId || null,
          launcherPath: '',
          hours: Number(c.hours) || 0,
          sessions: [],
          status: 'Playing',
          wishlisted: !!c.wishlisted,
          notes: '',
          added: Date.now(),
          iconUrl: c.iconPath ? fileUrl(c.iconPath) : null,
        });
      }
      saveGamesSoon();
      closeModal();
      state._shelfKey = '';
      renderLibrary();
      const owned = total - wishCount;
      const parts = [];
      if (owned) parts.push(`Imported ${owned} game${owned === 1 ? '' : 's'}`);
      if (wishCount) parts.push(`${wishCount} added to Wishlist`);
      toast(`${parts.join(' · ')} · fetching artwork`, 'ok');
      enrichArt().catch(() => {});
    };

    (async () => {
      sources = await (api.importSources ? api.importSources().catch(() => []) : Promise.resolve([]));
      syncPick();
      paintSummary();
      paintAccount();
    })();
  }

  // ---------------------------------------------------------------------------
  // Settings page — a full view next to the game page (was a long modal).
  // Left: section list. Right: cards of rows (title + description + control).
  // ---------------------------------------------------------------------------

  const SETTINGS_SECTIONS = [
    { id: 'general', label: 'General', desc: 'Startup, the window and the in-game overlay.',
      icon: '<circle cx="12" cy="12" r="3.2"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1"/>' },
    { id: 'appearance', label: 'Appearance', desc: 'Colours, visual quality and motion.',
      icon: '<circle cx="12" cy="12" r="8.5"/><path d="M12 3.5a8.5 8.5 0 0 0 0 17z" fill="currentColor" stroke="none"/>' },
    { id: 'library', label: 'Library & import', desc: 'Artwork, your Steam account and importing games.',
      icon: '<rect x="3.5" y="4" width="7" height="16" rx="1.5"/><rect x="13.5" y="4" width="7" height="9" rx="1.5"/><path d="M13.5 17h7M13.5 20h4"/>' },
    { id: 'tracking', label: 'Playtime tracking', desc: 'How GameVault counts the time you play.',
      icon: '<circle cx="12" cy="13" r="7.5"/><path d="M12 9v4l2.5 2.5M9.5 2.5h5"/>' },
    { id: 'controller', label: 'Controller & Big Picture', desc: 'Play from the couch with a gamepad.',
      icon: '<path d="M7 9h10a4 4 0 0 1 3.9 4.9l-.9 3.6a2 2 0 0 1-3.4.9L14.8 16H9.2l-1.8 2.4a2 2 0 0 1-3.4-.9l-.9-3.6A4 4 0 0 1 7 9z"/><path d="M8 12v3M6.5 13.5h3M15.5 13h.01M17.5 14.5h.01"/>' },
    { id: 'account', label: 'Account & cloud', desc: 'Back up your saves and sync your library. Off until you turn it on.',
      icon: '<path d="M7 18.5h10.5a4 4 0 0 0 .6-7.95A6 6 0 0 0 6.6 9.1 4.75 4.75 0 0 0 7 18.5z"/>' },
    { id: 'ai', label: 'AI advisor', desc: 'Optional game suggestions in the overlay, with your own API key.',
      icon: '<path d="M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8z"/><path d="M18.5 15l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z"/>' },
    { id: 'performance', label: 'Performance', desc: 'Frame rate, GPU and diagnostics.',
      icon: '<path d="M3.5 17a8.5 8.5 0 1 1 17 0"/><path d="M12 17l4-5.5"/>' },
    { id: 'about', label: 'About', desc: 'Version, updates and credits.',
      icon: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5M12 7.6h.01"/>' },
  ];

  const stIcon = (paths) => `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;

  // One settings row: text on the left, a control on the right (or below on narrow widths).
  const stRow = (title, desc, control, opts = {}) => `
    <div class="st-row${opts.wide ? ' is-wide' : ''}${opts.disabled ? ' is-disabled' : ''}">
      <div class="st-row-text">
        <div class="st-row-title">${title}</div>
        ${desc ? `<div class="st-row-desc"${opts.descId ? ` id="${opts.descId}"` : ''}>${desc}</div>` : ''}
      </div>
      ${control ? `<div class="st-row-control">${control}</div>` : ''}
    </div>`;
  const stCard = (title, rows, opts = {}) => `
    <section class="st-card${opts.soon ? ' is-soon' : ''}">
      ${title ? `<h2 class="st-card-title">${title}${opts.soon ? '<span class="st-soon">Coming soon</span>' : ''}</h2>` : ''}
      ${rows}
    </section>`;
  const stSwitch = (attr, on, opts = {}) => `
    <label class="st-switch${opts.disabled ? ' is-disabled' : ''}">
      <input type="checkbox" ${attr} ${on ? 'checked' : ''} ${opts.disabled ? 'disabled' : ''} aria-label="${esc(opts.label || '')}" />
      <span class="st-switch-track" aria-hidden="true"></span>
    </label>`;
  const stPills = (group, options, active, opts = {}) => `
    <div class="pills" ${group}>
      ${options.map(([value, label]) => `<button type="button" class="pill ${value === active ? 'is-active' : ''}" data-value="${esc(value)}" ${opts.disabled ? 'disabled' : ''}>${esc(label)}</button>`).join('')}
    </div>`;

  // ---- GameVault account card (sign-in lives in main: src/backend/account.js)
  const SOCIAL = [
    ['google', 'Google', '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="#4285F4" d="M23.5 12.27c0-.85-.08-1.67-.22-2.45H12v4.63h6.46a5.52 5.52 0 0 1-2.4 3.62v3h3.88c2.27-2.09 3.56-5.17 3.56-8.8z"/><path fill="#34A853" d="M12 24c3.24 0 5.96-1.07 7.94-2.9l-3.88-3.02c-1.07.72-2.45 1.15-4.06 1.15-3.12 0-5.77-2.11-6.71-4.95H1.28v3.11A12 12 0 0 0 12 24z"/><path fill="#FBBC05" d="M5.29 14.28a7.2 7.2 0 0 1 0-4.56V6.61H1.28a12 12 0 0 0 0 10.78l4.01-3.11z"/><path fill="#EA4335" d="M12 4.77c1.76 0 3.34.61 4.59 1.8l3.44-3.44A11.97 11.97 0 0 0 12 0 12 12 0 0 0 1.28 6.61l4.01 3.11C6.23 6.88 8.88 4.77 12 4.77z"/></svg>'],
    ['discord', 'Discord', '<svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true"><path fill="#5865F2" d="M20.32 4.37a19.8 19.8 0 0 0-4.89-1.52.07.07 0 0 0-.08.04c-.21.38-.44.86-.6 1.25a18.27 18.27 0 0 0-5.49 0 12.6 12.6 0 0 0-.62-1.25.08.08 0 0 0-.08-.04 19.74 19.74 0 0 0-4.88 1.52.07.07 0 0 0-.03.03C.53 9.05-.32 13.58.1 18.06a.08.08 0 0 0 .03.06 19.9 19.9 0 0 0 5.99 3.03.08.08 0 0 0 .08-.03c.46-.63.87-1.29 1.23-1.99a.08.08 0 0 0-.04-.1 13.1 13.1 0 0 1-1.87-.89.08.08 0 0 1 0-.13l.37-.29a.07.07 0 0 1 .08-.01c3.93 1.79 8.18 1.79 12.06 0a.07.07 0 0 1 .08.01l.37.29a.08.08 0 0 1 0 .13c-.6.35-1.22.65-1.87.89a.08.08 0 0 0-.04.1c.36.7.77 1.36 1.23 1.99a.08.08 0 0 0 .08.03 19.84 19.84 0 0 0 6-3.03.08.08 0 0 0 .03-.05c.5-5.18-.84-9.67-3.55-13.66a.06.06 0 0 0-.03-.03zM8.02 15.33c-1.18 0-2.16-1.08-2.16-2.42 0-1.33.96-2.42 2.16-2.42 1.21 0 2.18 1.1 2.16 2.42 0 1.34-.96 2.42-2.16 2.42zm7.97 0c-1.18 0-2.15-1.08-2.15-2.42 0-1.33.95-2.42 2.15-2.42 1.21 0 2.18 1.1 2.16 2.42 0 1.34-.95 2.42-2.16 2.42z"/></svg>'],
    ['github', 'GitHub', '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M12 .3a12 12 0 0 0-3.8 23.38c.6.12.83-.26.83-.57L9 21.07c-3.34.72-4.04-1.61-4.04-1.61-.55-1.39-1.34-1.76-1.34-1.76-1.08-.74.09-.73.09-.73 1.2.09 1.84 1.24 1.84 1.24 1.07 1.83 2.8 1.3 3.49 1 .1-.78.42-1.31.76-1.61-2.67-.3-5.47-1.33-5.47-5.93 0-1.31.47-2.38 1.24-3.22-.14-.3-.54-1.52.1-3.18 0 0 1-.32 3.3 1.23a11.5 11.5 0 0 1 6 0c2.28-1.55 3.29-1.23 3.29-1.23.64 1.66.24 2.88.12 3.18a4.65 4.65 0 0 1 1.23 3.22c0 4.61-2.8 5.63-5.48 5.92.42.36.81 1.1.81 2.22l-.01 3.29c0 .31.2.69.82.57A12 12 0 0 0 12 .3"/></svg>'],
  ];
  const providerName = (p) => (SOCIAL.find(([id]) => id === p) || [p, p === 'email' ? 'email' : p])[1];
  const acctTitle = '<h2 class="st-card-title">GameVault account</h2>';
  const EMAIL_OK = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const MAIL_ICON = '<rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="m4 7 8 6 8-6"/>';

  const acctInput = (name, type, placeholder, opts = {}) =>
    `<input class="input" type="${type}" name="${name}" placeholder="${esc(placeholder)}" aria-label="${esc(opts.label || placeholder)}"` +
    ` autocomplete="${opts.autocomplete || 'off'}" spellcheck="false"${opts.inputmode ? ` inputmode="${opts.inputmode}"` : ''}${opts.value != null ? ` value="${esc(opts.value)}"` : ''} />`;

  const socialOn = () => SOCIAL.filter(([id]) => (state.accountProviders || {})[id]);

  function accountFormHtml() {
    const social = socialOn();
    const mode = state._acctMode || (social.length ? 'social' : 'signin');
    const link = (act, text) => `<button type="button" class="acct-link" data-acct="${act}">${text}</button>`;
    const socialButtons = social.map(([id, name, icon]) => `<button type="button" class="btn acct-social" data-acct="oauth" data-provider="${id}">${icon}<span>Continue with ${name}</span></button>`).join('');
    if (mode === 'social') {
      return `
        <div class="st-row is-wide acct-in">
          <div class="st-row-text">
            <div class="st-row-title">Sign in</div>
            <div class="st-row-desc">One free account for cloud features: sync your library and back up your saves. Everything else in GameVault works without it.</div>
          </div>
          <div class="st-row-control acct-form">
            <div class="acct-socials">${socialButtons}</div>
            <div class="acct-foot">${link('mode-signin', 'Use email instead')}</div>
          </div>
        </div>`;
    }
    const email = acctInput('email', 'email', 'Email', { autocomplete: 'email', value: state._acctEmail || '' });
    const back = social.length ? `<span class="acct-grow"></span>${link('mode-social', `Back to ${social.map(([, n]) => n).join(' or ')}`)}` : '';
    let title, desc, fields, submit, foot;
    if (mode === 'signup') {
      title = 'Create your account';
      desc = 'Free. We send one email to confirm it’s you.';
      fields = email + acctInput('password', 'password', 'Password (8+ characters)', { autocomplete: 'new-password', label: 'Password' });
      submit = 'Create account';
      foot = `<span>Already have one?</span> ${link('mode-signin', 'Sign in')}${back}`;
    } else if (mode === 'forgot') {
      title = 'Reset your password';
      desc = 'We email you a link (and a code). Open it on this PC, then pick a new password here.';
      fields = email;
      submit = 'Send reset link';
      foot = link('mode-signin', 'Back to sign in') + back;
    } else if (mode === 'link') {
      title = 'Sign in without a password';
      desc = 'We email you a sign-in link. Open it in a browser on this PC, or type the code from the email.';
      fields = email;
      submit = 'Email me a link';
      foot = link('mode-signin', 'Use a password instead') + back;
    } else {
      title = 'Sign in with email';
      desc = 'One free account for cloud features. Everything else in GameVault works without it.';
      fields = email + acctInput('password', 'password', 'Password', { autocomplete: 'current-password' });
      submit = 'Sign in';
      foot = `${link('mode-forgot', 'Forgot password?')}<span class="acct-dot">·</span>${link('mode-link', 'Email me a link')}<span class="acct-dot">·</span>${link('mode-signup', 'Create an account')}${back}`;
    }
    return `
      <div class="st-row is-wide acct-in">
        <div class="st-row-text">
          <div class="st-row-title">${title}</div>
          <div class="st-row-desc">${desc}</div>
        </div>
        <div class="st-row-control acct-form">
          <form class="acct-fields" data-acct-form="${mode}" novalidate>
            ${fields}
            <button type="submit" class="btn btn-primary">${submit}</button>
          </form>
          <div class="acct-foot">${foot}</div>
        </div>
      </div>`;
  }

  function accountCardHtml() {
    const st = state.account;
    const err = st && st.error ? `<p class="st-note acct-err" role="alert">${esc(st.error)}</p>` : '';
    if (st && st.needsRestart) {
      return acctTitle + stRow('Restart GameVault', 'Sign-in was added in an update that finishes loading on the next start. Quit GameVault fully (also from the tray) and open it again.', '', { disabled: true });
    }
    if (!st || !st.configured) {
      return acctTitle + stRow('Cloud is off', 'This build of GameVault isn’t connected to Gamevault Cloud, so there is nothing to sign in to. Everything else works as usual.', '', { disabled: true });
    }
    if (st.signedIn) {
      const u = st.user || {};
      const who = u.name && u.email ? `${u.name}` : (u.email || u.name || 'Signed in');
      const sub = u.name && u.email ? `${esc(u.email)} · ` : '';
      const initial = esc((u.name || u.email || '?').trim().charAt(0).toUpperCase());
      const avatar = /^https:\/\//.test(u.avatar || '')
        ? `<img class="acct-avatar" src="${esc(u.avatar)}" alt="" referrerpolicy="no-referrer" data-avatar-fallback="${initial}" />`
        : `<div class="acct-avatar" aria-hidden="true">${initial}</div>`;
      const pwForm = st.mustSetPassword || state._acctChangePw;
      const me = `
        <div class="st-row acct-me">
          ${avatar}
          <div class="st-row-text">
            <div class="st-row-title">${esc(who)}</div>
            <div class="st-row-desc">${sub}Signed in with ${esc(providerName(u.provider || 'email'))}</div>
          </div>
          <div class="st-row-control">
            ${pwForm || (u.provider && u.provider !== 'email') ? '' : '<button type="button" class="btn btn-ghost" data-acct="change-pw">Change password</button>'}
            <button type="button" class="btn btn-ghost acct-out" data-acct="signout">Sign out</button>
          </div>
        </div>`;
      const pw = pwForm ? `
        <div class="st-row is-wide acct-in">
          <div class="st-row-text">
            <div class="st-row-title">${st.mustSetPassword ? 'Choose a new password' : 'Change password'}</div>
            <div class="st-row-desc">At least 8 characters.${st.mustSetPassword ? ' You’re signed in through the reset link; this finishes the reset.' : ''}</div>
          </div>
          <div class="st-row-control acct-form">
            <form class="acct-fields" data-acct-form="setpw" novalidate>
              ${acctInput('password', 'password', 'New password', { autocomplete: 'new-password' })}
              <button type="submit" class="btn btn-primary">Save password</button>
              ${st.mustSetPassword ? '' : '<button type="button" class="btn btn-ghost" data-acct="change-pw-cancel">Cancel</button>'}
            </form>
          </div>
        </div>` : '';
      const del = state._acctDelete ? `
        <div class="st-row acct-danger">
          <div class="st-row-text">
            <div class="st-row-title">Delete your account?</div>
            <div class="st-row-desc">This deletes your account, your synced library and every save backup from Gamevault Cloud, for good. The games on this PC stay.</div>
          </div>
          <div class="st-row-control">
            <button type="button" class="btn btn-ghost" data-acct="delete-cancel">Cancel</button>
            <button type="button" class="btn acct-delete" data-acct="delete-confirm">Delete forever</button>
          </div>
        </div>` : `<div class="acct-foot acct-foot-end"><button type="button" class="acct-link acct-link-quiet" data-acct="delete">Delete account…</button></div>`;
      return acctTitle + me + pw + err + del;
    }
    if (st.pending && st.pending.kind !== 'oauth') {
      const k = st.pending.kind;
      const head = k === 'signup' ? 'Confirm your email' : 'Check your inbox';
      const what = k === 'signup' ? 'a link to confirm your account' : k === 'recovery' ? 'a password reset link' : 'a sign-in link';
      const extra = k === 'signup' ? ' No email? If you already have an account with this address, go back and sign in or reset your password.' : ' Not there after a minute? Check spam.';
      return acctTitle + `
        <div class="st-row acct-wait">
          <div class="acct-mail" aria-hidden="true">${stIcon(MAIL_ICON)}</div>
          <div class="st-row-text">
            <div class="st-row-title">${head}</div>
            <div class="st-row-desc">We sent ${what} to <b>${esc(st.pending.email)}</b>. Open it in a browser on this PC and GameVault picks it up by itself.${extra}</div>
          </div>
          <div class="st-row-control">
            ${k === 'signup' ? '' : '<button type="button" class="btn btn-ghost" data-acct="resend">Resend</button>'}
            <button type="button" class="btn btn-ghost" data-acct="cancel">Back</button>
          </div>
        </div>
        <div class="st-row acct-code">
          <div class="st-row-text">
            <div class="st-row-title">Opened it on your phone?</div>
            <div class="st-row-desc">Type the code from the email instead.</div>
          </div>
          <div class="st-row-control">
            <form class="acct-fields acct-code-form" data-acct-form="code" novalidate>
              ${acctInput('code', 'text', '123456', { autocomplete: 'one-time-code', inputmode: 'numeric', label: 'Code from the email' })}
              <button type="submit" class="btn btn-ghost">Verify</button>
            </form>
          </div>
        </div>` + err;
    }
    if (st.pending && st.pending.kind === 'oauth') {
      const name = providerName(st.pending.provider);
      return acctTitle + stRow(`Finish in your browser`, `A ${esc(name)} sign-in page opened in your default browser. Come back here when you’re done.`,
        '<button type="button" class="btn btn-ghost" data-acct="reopen">Open it again</button><button type="button" class="btn btn-ghost" data-acct="cancel">Cancel</button>') + err;
    }
    return acctTitle + accountFormHtml() + err;
  }

  function renderAccountCard(focus) {
    const card = document.querySelector('[data-account]');
    if (!card) return;
    card.innerHTML = accountCardHtml();
    wireAccountCard(card);
    renderCloudCard();
    if (focus) {
      const want = typeof focus === 'string' ? card.querySelector(`input[name=${focus}]`) : null;
      const input = want || [...card.querySelectorAll('input')].find((i) => !i.value) || card.querySelector('input');
      if (input) input.focus();
    }
  }

  function wireAccountCard(card) {
    if (!card) return;
    const img = card.querySelector('img[data-avatar-fallback]');
    if (img) img.addEventListener('error', () => { img.outerHTML = `<div class="acct-avatar" aria-hidden="true">${img.dataset.avatarFallback}</div>`; });
    const setError = (msg, focus) => {
      state.account = { ...(state.account || {}), error: msg };
      renderAccountCard(focus || true);
    };
    const run = async (call, btn, label) => {
      if (btn) { btn.disabled = true; if (label) btn.textContent = label; }
      const res = await call().catch((e) => ({ ok: false, error: { message: e.message } }));
      if (res && res.ok) state.account = res.data;
      else state.account = { ...(state.account || {}), error: (res && res.error && res.error.message) || 'Something went wrong' };
      renderAccountCard(!(res && res.ok) && 'password');
      return res;
    };
    const form = card.querySelector('[data-acct-form]');
    if (form) {
      const mode = form.dataset.acctForm;
      const emailIn = form.querySelector('input[name=email]');
      const pwIn = form.querySelector('input[name=password]');
      const codeIn = form.querySelector('input[name=code]');
      if (emailIn) emailIn.addEventListener('input', () => { state._acctEmail = emailIn.value; });
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        const btn = form.querySelector('button[type=submit]');
        const pw = pwIn ? pwIn.value : '';
        if (mode === 'code') {
          const code = codeIn.value.replace(/\s+/g, '');
          if (!/^\d{6,10}$/.test(code)) return setError('Enter the code from the email.', 'code');
          run(() => window.api.accountCode(code), btn, 'Checking…');
          return;
        }
        if (mode === 'setpw') {
          if (pw.length < 8) return setError('Pick a longer password: at least 8 characters.', 'password');
          run(() => window.api.accountSetPassword(pw), btn, 'Saving…').then((res) => {
            if (res && res.ok) { state._acctChangePw = false; renderAccountCard(); toast('Password saved', 'ok'); }
          });
          return;
        }
        const email = emailIn.value.trim();
        state._acctEmail = email;
        if (!EMAIL_OK.test(email)) return setError('Enter your email address.', 'email');
        if (mode === 'signin') {
          if (!pw) return setError('Enter your password.', 'password');
          run(() => window.api.accountPassword(email, pw), btn, 'Signing in…');
        } else if (mode === 'signup') {
          if (pw.length < 8) return setError('Pick a longer password: at least 8 characters.', 'password');
          run(() => window.api.accountSignUp(email, pw), btn, 'Creating…');
        } else if (mode === 'forgot') {
          run(() => window.api.accountReset(email), btn, 'Sending…');
        } else {
          run(() => window.api.accountEmail(email), btn, 'Sending…');
        }
      });
    }
    card.querySelectorAll('[data-acct]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const act = btn.dataset.acct;
        if (act.startsWith('mode-')) {
          state._acctMode = act.slice(5);
          if (state.account) state.account = { ...state.account, error: null };
          renderAccountCard(state._acctMode !== 'social');
        } else if (act === 'oauth') {
          run(() => window.api.accountOAuth(btn.dataset.provider), btn, 'Opening browser…');
        } else if (act === 'reopen') {
          run(() => window.api.accountOAuth(state.account.pending.provider), btn);
        } else if (act === 'resend') {
          const p = state.account.pending;
          const res = await run(() => (p.kind === 'recovery' ? window.api.accountReset(p.email) : window.api.accountEmail(p.email)), btn, 'Sending…');
          if (res && res.ok) toast('Sent a new email', 'ok');
        } else if (act === 'cancel') {
          state.account = await window.api.accountCancel();
          renderAccountCard(true);
        } else if (act === 'change-pw' || act === 'change-pw-cancel') {
          state._acctChangePw = act === 'change-pw';
          if (state.account) state.account = { ...state.account, error: null };
          renderAccountCard(state._acctChangePw && 'password');
        } else if (act === 'delete' || act === 'delete-cancel') {
          state._acctDelete = act === 'delete';
          renderAccountCard();
        } else if (act === 'delete-confirm') {
          const res = await run(() => window.api.accountDelete(), btn, 'Deleting…');
          if (res && res.ok) {
            state._acctDelete = false;
            state._acctMode = null;
            await saveConfigPatch({ cloudSync: false, cloudSaves: false, cloudSyncUser: null });
            renderAccountCard();
            toast('Your GameVault account is deleted', 'ok');
          }
        } else if (act === 'signout') {
          state._acctChangePw = false;
          state._acctDelete = false;
          state._acctMode = null;
          const res = await run(() => window.api.accountSignOut(), btn, 'Signing out…');
          if (res && res.ok) toast('Signed out of GameVault');
        }
      });
    });
  }

  // ---- Cloud features: library sync + save backups (main: src/backend/cloud.js)
  const signedIn = () => !!(state.account && state.account.signedIn);
  const cloudOn = (k) => signedIn() && !!state.config[k];
  const gameById = (id) => state.games.find((x) => String(x.id) === String(id));

  function agoLabel(t) {
    if (!t) return 'never';
    const s = Math.max(0, (Date.now() - new Date(t).getTime()) / 1000);
    if (s < 45) return 'just now';
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    if (s < 86400) return `${Math.round(s / 3600)} h ago`;
    return new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: s > 300 * 86400 ? 'numeric' : undefined });
  }
  const mb = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

  function cloudCardHtml() {
    const on = signedIn();
    const sync = !!state.config.cloudSync;
    const saves = !!state.config.cloudSaves;
    const last = state._lastSync;
    const syncDesc = `Your games, playtime, status and notes on every PC you sign in to. Never your file paths or API keys.${
      on && sync ? `<br><span class="cloud-meta">${state._syncing ? 'Syncing…' : `Last synced ${agoLabel(last)}`}${state._syncError ? ` · <span class="cloud-bad">${esc(state._syncError)}</span>` : ''}</span>` : ''}`;
    return `<h2 class="st-card-title">Cloud features</h2>` +
      stRow('Sync my library', syncDesc,
        (on && sync ? '<button type="button" class="btn btn-ghost" data-cloud="sync-now">Sync now</button>' : '') +
        stSwitch('data-cloud-sync', on && sync, { disabled: !on, label: 'Sync my library' }), { disabled: !on }) +
      stRow('Back up my game saves', 'Saves are packed and encrypted on this PC before upload, with a key tied to your account. Up to 50 MB per backup, the latest 3 copies of each game. Backs up after you play; restore from the game’s page.',
        stSwitch('data-cloud-saves', on && saves, { disabled: !on, label: 'Back up my game saves' }), { disabled: !on }) +
      `<p class="st-note">${on ? 'Both stay off until you turn them on.' : 'Sign in above to turn these on.'}</p>`;
  }

  // ---- the account row at the bottom of the sidebar (and atop the Big
  // Picture menu): picture, name and sync state; opens Account in Settings
  const PERSON_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="8.5" r="3.8"/><path d="M4.5 20a7.5 7.5 0 0 1 15 0"/></svg>';

  function sideAccountParts() {
    const st = state.account;
    if (!st || !st.configured || st.needsRestart) return null;
    if (!st.signedIn) {
      return { out: true, pic: PERSON_ICON, name: 'Sign in', sub: 'Sync your library', title: 'Sign in to GameVault' };
    }
    const u = st.user || {};
    const name = u.name || (u.email ? String(u.email).split('@')[0] : 'You');
    const initial = esc(String(u.name || u.email || '?').trim().charAt(0).toUpperCase());
    const pic = /^https:\/\//.test(u.avatar || '')
      ? `<img src="${esc(u.avatar)}" alt="" referrerpolicy="no-referrer" data-initial="${initial}" />`
      : initial;
    let sub;
    let bad = false;
    if (!state.config.cloudSync) sub = 'Sync is off';
    else if (state._syncing) sub = 'Syncing…';
    else if (state._syncError) { sub = 'Sync problem'; bad = true; }
    else sub = state._lastSync ? `Synced ${agoLabel(state._lastSync)}` : 'Not synced yet';
    return { out: false, pic, name, sub, bad, title: `${name} · ${u.email || 'Account'}` };
  }

  function sideAccountInner(a) {
    return `<span class="side-av${a.out ? ' is-out' : ''}">${a.pic}</span>`
      + `<span class="side-acc-text"><span class="side-acc-name">${esc(a.name)}</span>`
      + `<span class="side-acc-sub${a.bad ? ' is-bad' : ''}">${esc(a.sub)}</span></span>`;
  }

  function paintSideAccount() {
    const a = sideAccountParts();
    const targets = [$('#side-account'), document.querySelector('#bp-menu [data-bp-account]')].filter(Boolean);
    for (const el of targets) {
      el.hidden = !a;
      if (!a) continue;
      const html = sideAccountInner(a);
      if (el._gvAcct === html) continue;   // no flicker on the minute tick
      el._gvAcct = html;
      el.innerHTML = html;
      el.title = a.title;
      el.setAttribute('aria-label', a.out ? 'Sign in' : `Account: ${a.name}, ${a.sub}`);
      const img = el.querySelector('img[data-initial]');
      if (img) img.addEventListener('error', () => { img.replaceWith(document.createTextNode(img.dataset.initial)); });
    }
  }

  function renderCloudCard() {
    paintSideAccount();
    const card = document.querySelector('[data-cloud-card]');
    if (!card) return;
    card.innerHTML = cloudCardHtml();
    wireCloudCard(card);
  }

  function wireCloudCard(card) {
    if (!card) return;
    const syncSw = card.querySelector('[data-cloud-sync]');
    const savesSw = card.querySelector('[data-cloud-saves]');
    if (syncSw) syncSw.addEventListener('change', async () => {
      // Turning it on is consent to merge this PC's library into this account.
      await saveConfigPatch(syncSw.checked ? { cloudSync: true, cloudSyncUser: state.account.user.id } : { cloudSync: false });
      renderCloudCard();
      if (syncSw.checked) runCloudSync({ announce: true });
    });
    if (savesSw) savesSw.addEventListener('change', async () => {
      await saveConfigPatch({ cloudSaves: savesSw.checked });
      renderCloudCard();
      if (savesSw.checked) toast('Save backups on. Pick a save folder on each game’s page.', 'ok');
      if (state.selectedId) paintSavesCard(gameById(state.selectedId));
    });
    const now = card.querySelector('[data-cloud="sync-now"]');
    if (now) now.addEventListener('click', () => runCloudSync({ announce: true, force: true }));
  }

  // -- library sync engine
  let cloudSyncJob = null;
  let cloudSyncTimer = null;
  function scheduleCloudSync(ms = 20000) {
    if (!cloudOn('cloudSync')) return;
    clearTimeout(cloudSyncTimer);
    cloudSyncTimer = setTimeout(() => runCloudSync({}), ms);
  }

  function runCloudSync({ announce = false } = {}) {
    if (!cloudOn('cloudSync') || !api.cloudSync) return Promise.resolve(null);
    if (cloudSyncJob) return cloudSyncJob;
    // A different account than the one this PC synced with: don't pour this
    // library into it without asking. Sync stays off until turned on again.
    const uid = state.account.user && state.account.user.id;
    if (state.config.cloudSyncUser && uid && state.config.cloudSyncUser !== uid) {
      saveConfigPatch({ cloudSync: false });
      toast('Library sync is off for this account. Turn it on in Settings to merge this PC’s library into it.');
      renderCloudCard();
      return Promise.resolve(null);
    }
    if (!state.config.cloudSyncUser && uid) saveConfigPatch({ cloudSyncUser: uid });
    clearTimeout(cloudSyncTimer);
    state._syncing = true;
    renderCloudCard();
    cloudSyncJob = (async () => {
      const rev = state._gamesRev || 0;
      const res = await api.cloudSync(cleanGames()).catch((e) => ({ ok: false, error: { message: e.message } }));
      state._syncing = false;
      if (!res || !res.ok) {
        state._syncError = (res && res.error && res.error.message) || 'Sync failed';
        if (announce) toast(state._syncError, 'error');
        renderCloudCard();
        return null;
      }
      state._syncError = null;
      state._lastSync = res.data.at;
      if ((state._gamesRev || 0) !== rev) { scheduleCloudSync(1500); renderCloudCard(); return res.data; } // edited meanwhile: go again
      const { added, removed, updated } = res.data.stats || {};
      if (added || removed || updated) {
        const old = new Map(state.games.map((g) => [String(g.id), g]));
        const next = normalizeGames(res.data.games).games;
        for (const g of next) {
          const prev = old.get(String(g.id));
          if (prev) for (const k of Object.keys(prev)) if (k.startsWith('_')) g[k] = prev[k];
        }
        state.games = next;
        state._applyingSync = true;
        try { await persistGames(); } finally { state._applyingSync = false; }
        if (state.selectedId && !gameById(state.selectedId)) closeDetail();
        state._shelfKey = '';
        renderLibrary();
        if (state.selectedId) renderDetail();
        for (const g of next) if (!old.has(String(g.id))) refreshArt(g);
        const bits = [];
        if (added) bits.push(`${added} added`);
        if (updated) bits.push(`${updated} updated`);
        if (removed) bits.push(`${removed} removed`);
        toast(`Library synced: ${bits.join(', ')}`, 'ok');
      } else if (announce) {
        toast('Library is up to date', 'ok');
      }
      renderCloudCard();
      return res.data;
    })().finally(() => { cloudSyncJob = null; state._syncing = false; });
    return cloudSyncJob;
  }

  // -- save backups, per game (rail card on the game page)
  function savesCardHtml(g) {
    const head = '<div class="gvx-card-head">CLOUD SAVES</div>';
    if (!signedIn()) return head + '<p class="sv-text">Sign in to back up this game’s saves.</p><button type="button" class="sv-link" data-sv="settings">Open account settings</button>';
    if (!state.config.cloudSaves) return head + '<p class="sv-text">Save backups are off.</p><button type="button" class="sv-link" data-sv="settings">Turn on in settings</button>';
    const ui = state._sv && state._sv.id === String(g.id) ? state._sv : (state._sv = { id: String(g.id) });
    if (ui.finding) return head + '<p class="sv-text">Looking up where it saves…</p>';
    if (ui.found) {
      const list = ui.found.length
        ? ui.found.map((c, i) => `<button type="button" class="sv-pick" data-sv="use" data-i="${i}" title="${esc(c.path)}"><b>${esc(c.path.split('\\').slice(-2).join('\\'))}</b><span>${c.files} file${c.files === 1 ? '' : 's'} · ${mb(c.bytes)} · changed ${agoLabel(c.newest)}</span></button>`).join('')
        : '<p class="sv-text">No save folder found on this PC. Play once so the game makes one, or choose it yourself.</p>';
      return head + list + '<div class="sv-row"><button type="button" class="sv-link" data-sv="pick">Choose folder…</button><button type="button" class="sv-link" data-sv="cancel">Cancel</button></div>';
    }
    if (!g.saveDir) {
      return head + '<p class="sv-text">Where does this game keep its saves?</p>' +
        '<div class="sv-row"><button type="button" class="btn btn-ghost sv-btn" data-sv="find">Find automatically</button><button type="button" class="sv-link" data-sv="pick">Choose folder…</button></div>';
    }
    const backups = ui.backups;
    const rows = !backups ? '<p class="sv-text">Loading backups…</p>'
      : !backups.length ? '<p class="sv-text">No backups yet.</p>'
        : backups.map((b) => `<div class="sv-backup"><span><b>${agoLabel(b.created_at)}</b>${esc(b.device || '')} · ${mb(b.size)}</span>` +
          `<button type="button" class="sv-link${ui.confirm === b.id ? ' is-danger' : ''}" data-sv="restore" data-id="${esc(b.id)}">${ui.confirm === b.id ? 'Replace current saves?' : 'Restore'}</button></div>`).join('');
    return head +
      `<div class="sv-folder" title="${esc(g.saveDir)}">${esc(g.saveDir.split('\\').slice(-2).join('\\'))}</div>` +
      rows +
      (ui.error ? `<p class="sv-text cloud-bad">${esc(ui.error)}</p>` : '') +
      `<div class="sv-row"><button type="button" class="btn btn-ghost sv-btn" data-sv="backup" ${ui.busy ? 'disabled' : ''}>${ui.busy || 'Back up now'}</button><button type="button" class="sv-link" data-sv="pick">Change folder</button></div>`;
  }

  function paintSavesCard(g) {
    const el = document.querySelector('#game-view [data-saves-card]');
    if (!el || !g) return;
    el.innerHTML = savesCardHtml(g);
    const ui = state._sv;
    if (g.saveDir && cloudOn('cloudSaves') && ui && ui.id === String(g.id) && !ui.backups && !ui.loading) {
      ui.loading = true;
      api.savesList(String(g.id)).then((res) => {
        ui.loading = false;
        ui.backups = res && res.ok ? res.data : [];
        if (!(res && res.ok)) ui.error = res && res.error && res.error.message;
        if (state.selectedId === String(g.id)) paintSavesCard(g);
      });
    }
    el.querySelectorAll('[data-sv]').forEach((btn) => btn.addEventListener('click', () => savesAction(g, btn)));
  }

  async function setSaveDir(g, dir) {
    g.saveDir = dir;
    state._sv = { id: String(g.id) };
    saveGamesSoon();
    paintSavesCard(g);
    if (dir) backupNow(g, { quiet: false });
  }

  async function backupNow(g, { quiet = true, force = false } = {}) {
    if (!g || !g.saveDir || !cloudOn('cloudSaves')) return;
    const ui = state._sv && state._sv.id === String(g.id) ? state._sv : null;
    if (ui) { ui.busy = 'Backing up…'; ui.error = null; paintSavesCard(g); }
    const res = await api.savesBackup({ gameId: String(g.id), gameName: g.name, saveDir: g.saveDir, force });
    if (ui) { ui.busy = null; ui.backups = null; }
    if (res && res.ok) {
      if (!quiet) toast(res.data.skipped ? 'Saves haven’t changed since the last backup' : `Backed up ${g.name} saves`, 'ok');
    } else {
      const msg = (res && res.error && res.error.message) || 'Backup failed';
      if (ui) ui.error = msg;
      if (!quiet || (res && res.error && res.error.code === 'NO_FOLDER')) toast(`${g.name}: ${msg}`, 'error');
    }
    if (state.selectedId === String(g.id)) paintSavesCard(g);
  }

  async function savesAction(g, btn) {
    const act = btn.dataset.sv;
    const ui = state._sv;
    if (act === 'settings') { openSettings('account'); return; }
    if (act === 'find') {
      ui.finding = true; paintSavesCard(g);
      const res = await api.savesFind({ name: g.name, steamAppId: g.steamAppId, installDir: g.installDir });
      ui.finding = false;
      ui.found = res && res.ok ? res.data.candidates : [];
      if (!(res && res.ok)) toast(`Couldn’t look it up: ${(res && res.error && res.error.message) || 'PCGamingWiki is unreachable'}`, 'error');
      paintSavesCard(g);
    } else if (act === 'use') {
      const c = ui.found && ui.found[Number(btn.dataset.i)];
      ui.found = null;
      if (c) setSaveDir(g, c.path);
    } else if (act === 'pick') {
      const dir = await api.savesPick(g.saveDir || null);
      ui.found = null;
      if (dir) setSaveDir(g, dir); else paintSavesCard(g);
    } else if (act === 'cancel') {
      ui.found = null; paintSavesCard(g);
    } else if (act === 'backup') {
      backupNow(g, { quiet: false, force: true });
    } else if (act === 'restore') {
      const id = btn.dataset.id;
      if (ui.confirm !== id) { ui.confirm = id; paintSavesCard(g); return; }
      ui.confirm = null;
      if (typeof state.live[String(g.id)] === 'number') { toast('Close the game before restoring its saves', 'error'); paintSavesCard(g); return; }
      ui.busy = 'Restoring…'; paintSavesCard(g);
      const res = await api.savesRestore({ gameId: String(g.id), backupId: id, saveDir: g.saveDir });
      ui.busy = null;
      if (res && res.ok) toast(`Restored ${res.data.files} file${res.data.files === 1 ? '' : 's'}. Your previous saves were kept in GameVault’s cloud folder.`, 'ok');
      else toast((res && res.error && res.error.message) || 'Restore failed', 'error');
      paintSavesCard(g);
    }
  }

  if (window.api && window.api.onAccountChanged) {
    window.api.onAccountChanged((st) => {
      const was = !!(state.account && state.account.signedIn);
      state.account = st;
      if (st.signedIn && !was) toast(st.mustSetPassword ? 'Now choose a new password' : `Signed in as ${(st.user && (st.user.email || st.user.name)) || 'you'}`, 'ok');
      else if (!st.signedIn && was && st.error) toast(st.error);
      renderAccountCard();
      paintSideAccount();
      if (st.signedIn && !was) runCloudSync({});
      if (state.selectedId) paintSavesCard(gameById(state.selectedId));
    });
  }

  function settingsView() { return $('#settings-view'); }

  async function openSettings(section) {
    if (state.selectedId) closeDetail();
    const view = settingsView();
    if (!view) return;
    if (!state.settingsOpen) {
      const active = document.activeElement;
      state._settingsFocusReturn = (active && active.id === 'q') ? null : active;
      sfx('open');
    }
    state.settingsOpen = true;
    state.settingsSection = SETTINGS_SECTIONS.some((s) => s.id === section) ? section : (state.settingsSection || 'general');
    $('#library').hidden = true;
    $('#shelf').hidden = true;
    if ($('#wishlist-view')) $('#wishlist-view').hidden = true;
    if ($('#activity-view')) $('#activity-view').hidden = true;
    const fb = $('#filterbar'); if (fb) fb.hidden = true;
    view.hidden = false;
    const title = $('#filter-title'); if (title) title.textContent = 'Settings';
    document.title = 'Settings — GameVault';
    await renderSettings();
    fadeIn(view);
    view.querySelector('.st-tab.is-active')?.focus({ preventScroll: true });
  }

  function closeSettings({ restoreFocus = true } = {}) {
    const view = settingsView();
    if (!view || !state.settingsOpen) return;
    sfx('close');
    state.settingsOpen = false;
    view.hidden = true;
    view.innerHTML = '';
    const fb = $('#filterbar'); if (fb) fb.hidden = false;
    const title = $('#filter-title'); if (title) title.textContent = filterLabel(state.filter);
    renderLibrary();
    fadeIn(currentPane());
    document.title = 'GameVault';
    const back = state._settingsFocusReturn;
    state._settingsFocusReturn = null;
    if (restoreFocus && back && back.isConnected && typeof back.focus === 'function') back.focus();
  }

  async function renderSettings() {
    const view = settingsView();
    if (!view) return;
    const current = SETTINGS_SECTIONS.find((s) => s.id === state.settingsSection) || SETTINGS_SECTIONS[0];
    if (!view.querySelector('.st-wrap')) {
      view.innerHTML = `
        <div class="st-wrap">
          <nav class="st-nav" aria-label="Settings sections" data-pad-region="st-nav">
            <button type="button" class="st-back" data-st-close>
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 6l-6 6 6 6"/></svg>
              Library
            </button>
            <div class="st-nav-title">Settings</div>
            <div class="st-tabs" role="tablist" aria-orientation="vertical" data-pad-enter>
              ${SETTINGS_SECTIONS.map((s) => `
                <button type="button" class="st-tab" role="tab" id="st-tab-${s.id}" data-st-section="${s.id}" aria-controls="st-panel">
                  ${stIcon(s.icon)}<span>${esc(s.label)}</span>
                </button>`).join('')}
            </div>
          </nav>
          <div class="st-panel" id="st-panel" role="tabpanel" tabindex="-1" data-pad-region="st-panel"></div>
        </div>`;
      view.querySelector('[data-st-close]').onclick = () => closeSettings();
      const tabs = [...view.querySelectorAll('.st-tab')];
      for (const tab of tabs) {
        tab.onclick = () => {
          if (state.settingsSection === tab.dataset.stSection) return;
          sfx('tab');
          state.settingsSection = tab.dataset.stSection;
          renderSettings();
        };
        tab.onkeydown = (e) => {
          const i = tabs.indexOf(tab);
          let next = -1;
          if (e.key === 'ArrowDown') next = (i + 1) % tabs.length;
          else if (e.key === 'ArrowUp') next = (i - 1 + tabs.length) % tabs.length;
          else if (e.key === 'Home') next = 0;
          else if (e.key === 'End') next = tabs.length - 1;
          if (next < 0) return;
          e.preventDefault();
          tabs[next].focus();
          tabs[next].click();
        };
      }
    }
    for (const tab of view.querySelectorAll('.st-tab')) {
      const on = tab.dataset.stSection === current.id;
      tab.classList.toggle('is-active', on);
      tab.setAttribute('aria-selected', String(on));
      tab.tabIndex = on ? 0 : -1;
    }
    const panel = view.querySelector('.st-panel');
    panel.setAttribute('aria-labelledby', `st-tab-${current.id}`);
    const seq = (state._settingsSeq = (state._settingsSeq || 0) + 1);
    const built = await SETTINGS_RENDERERS[current.id]();
    if (seq !== state._settingsSeq || !state.settingsOpen) return; // switched again meanwhile
    panel.innerHTML = `
      <header class="st-head">
        <h1 class="st-h">${esc(current.label)}</h1>
        <p class="st-sub">${esc(current.desc)}</p>
      </header>
      <div class="st-body">${built.html}</div>`;
    panel.scrollTop = 0;
    if (panel.dataset.section && panel.dataset.section !== current.id && !prefersReducedMotion()) {
      panel.animate(
        [{ opacity: 0, transform: 'translateY(4px)' }, { opacity: 1, transform: 'none' }],
        { duration: 240, easing: 'cubic-bezier(0.22, 0.8, 0.3, 1)' }
      );
    }
    panel.dataset.section = current.id;
    if (built.wire) built.wire(panel);
  }

  // Pills: one active option; calls onPick(value).
  // Palette: a compact dropdown with a swatch per theme (pills got too long).
  const palName = (p) => p[0].toUpperCase() + p.slice(1);
  const stPalettePicker = (active) => `
    <div class="sort-wrap pal-wrap">
      <button type="button" class="sort-btn pal-btn" aria-haspopup="listbox" aria-expanded="false" aria-label="Palette">
        <i class="pal-sw" data-value="${esc(active)}"></i><span class="pal-label">${esc(palName(active))}</span>
        <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>
      </button>
      <div class="sort-menu pal-menu" role="listbox" hidden>
        ${PALETTES.map((p) => `<button type="button" class="sort-item pal-item" role="option" data-value="${esc(p)}" aria-selected="${p === active}"><span><i class="pal-sw" data-value="${esc(p)}"></i>${esc(palName(p))}</span></button>`).join('')}
      </div>
    </div>`;

  function wirePalettePicker(panel, onPick) {
    const wrap = panel.querySelector('.pal-wrap');
    if (!wrap) return;
    const btn = wrap.querySelector('.pal-btn');
    const menu = wrap.querySelector('.pal-menu');
    const items = () => [...menu.querySelectorAll('.pal-item')];
    const close = (focus) => {
      menu.hidden = true; btn.setAttribute('aria-expanded', 'false');
      document.removeEventListener('pointerdown', outside, true);
      if (focus) btn.focus({ preventScroll: true });
    };
    const outside = (e) => { if (!wrap.contains(e.target)) close(false); };
    const open = () => {
      menu.hidden = false; btn.setAttribute('aria-expanded', 'true');
      document.addEventListener('pointerdown', outside, true);
      (menu.querySelector('[aria-selected="true"]') || items()[0]).focus({ preventScroll: true });
    };
    btn.onclick = () => (menu.hidden ? open() : close(false));
    menu.onclick = (e) => {
      const item = e.target.closest('.pal-item');
      if (!item) return;
      const v = item.dataset.value;
      for (const it of items()) it.setAttribute('aria-selected', String(it === item));
      btn.querySelector('.pal-sw').dataset.value = v;
      btn.querySelector('.pal-label').textContent = palName(v);
      close(true);
      onPick(v);
    };
    menu.onkeydown = (e) => {
      const list = items();
      const i = list.indexOf(document.activeElement);
      if (e.key === 'ArrowDown') { e.preventDefault(); list[Math.min(i + 1, list.length - 1)].focus(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); list[Math.max(i - 1, 0)].focus(); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true); }
    };
  }

  function wirePills(panel, selector, onPick) {
    const group = panel.querySelector(selector);
    if (!group) return;
    for (const pill of group.querySelectorAll('.pill')) {
      pill.onclick = () => {
        for (const p of group.querySelectorAll('.pill')) p.classList.toggle('is-active', p === pill);
        onPick(pill.dataset.value);
      };
    }
  }

  const SETTINGS_RENDERERS = {
    async general() {
      const info = await (api.getPlatformInfo ? api.getPlatformInfo().catch(() => ({})) : Promise.resolve({}));
      const startupOn = await api.getStartup().catch(() => false);
      const toTray = state.config.closeToTray !== false;
      const hotkey = state.config.overlayHotkey || 'Shift+Alt+G';
      return {
        html:
          stCard('Startup',
            stRow('Start GameVault when I log in', 'Opens quietly in the tray.', stSwitch('data-autostart', startupOn, { label: 'Start on login' })) +
            stRow('Start in Big Picture', 'Open straight into the fullscreen, controller-friendly mode.', stSwitch('data-bp-start', state.config.startBigPicture === true, { label: 'Start in Big Picture' }))) +
          stCard('Window',
            stRow('Closing the window', toTray ? 'GameVault keeps tracking playtime from the tray.' : 'GameVault quits — games started outside it won’t be noticed.',
              stPills('data-close-mode', [['tray', 'Hide to tray'], ['quit', 'Quit']], toTray ? 'tray' : 'quit'), { descId: 'st-close-desc' }) +
            stRow('Default layout', 'How the library opens.', stPills('data-layout', [['shelf', 'Shelf'], ['poster', 'Cards']], bp.on ? bp.saved.view : state.view))) +
          stCard('Sound',
            stRow('Sound effects', 'Small sounds when you click, move around, open things and launch games. Never plays over a game.',
              stSwitch('data-sfx-on', state.config.sfx !== false, { label: 'Sound effects' })) +
            stRow('Volume', '', `<input type="range" class="st-range" data-sfx-vol min="0" max="100" step="5" value="${Math.round((typeof state.config.sfxVolume === 'number' ? state.config.sfxVolume : 0.6) * 100)}" aria-label="Sound volume" />`) +
            stRow('Style', 'Crisp is short and clicky, like a real button. Airy is soft and glassy with a little room around it. Pick one to hear it.',
              stPills('data-sfx-theme', [['crisp', 'Crisp'], ['airy', 'Airy']], state.config.sfxTheme || 'crisp', { disabled: state.config.sfx === false })) +
            stRow('Navigation sounds', 'A tiny sound each time you move to another item with a controller or the arrow keys.',
              stSwitch('data-sfx-nav', state.config.sfxNav !== false, { label: 'Navigation sounds', disabled: state.config.sfx === false }))) +
          stCard('In-game overlay',
            info.wayland
              ? stRow('Shortcut', 'Wayland blocks global hotkeys. Bind this in your compositor:<br><code class="st-code">gamevault --toggle-overlay</code>', '')
              : stRow('Shortcut', 'Screenshots, clips and the AI advisor on top of your game. Works with borderless and windowed games.', `<kbd class="st-kbd">${esc(hotkey.replace(/\+/g, ' + '))}</kbd>`)),
        wire(panel) {
          panel.querySelector('[data-autostart]').onchange = async (e) => {
            await api.setStartup(e.target.checked).catch(() => {});
            toast(e.target.checked ? 'GameVault will start when you log in' : 'Start on login turned off', 'ok');
          };
          wirePills(panel, '[data-close-mode]', async (v) => {
            await saveConfigPatch({ closeToTray: v === 'tray' });
            const d = panel.querySelector('#st-close-desc');
            if (d) d.textContent = v === 'tray' ? 'GameVault keeps tracking playtime from the tray.' : 'GameVault quits — games started outside it won’t be noticed.';
          });
          wirePills(panel, '[data-layout]', (v) => {
            // Big Picture has its own layouts: save the choice for when it closes
            if (bp.on) { bp.saved.view = v; lsSet('gv.view', v); return; }
            if (v !== state.view) cycleView();
          });
          wireBpSettings(panel);
          const sfxOn = panel.querySelector('[data-sfx-on]');
          const sfxVol = panel.querySelector('[data-sfx-vol]');
          if (sfxOn) sfxOn.onchange = () => {
            saveConfigPatch({ sfx: sfxOn.checked });
            applySfxConfig();
            if (sfxVol) sfxVol.disabled = !sfxOn.checked;
            for (const pill of panel.querySelectorAll('[data-sfx-theme] .pill')) pill.disabled = !sfxOn.checked;
            const navSw = panel.querySelector('[data-sfx-nav]');
            if (navSw) { navSw.disabled = !sfxOn.checked; navSw.closest('.st-switch')?.classList.toggle('is-disabled', !sfxOn.checked); }
          };
          if (sfxVol) {
            sfxVol.disabled = state.config.sfx === false;
            sfxVol.oninput = () => { if (window.Sfx) window.Sfx.setVolume(Number(sfxVol.value) / 100); };
            sfxVol.onchange = () => {
              saveConfigPatch({ sfxVolume: Number(sfxVol.value) / 100 });
              applySfxConfig();
              if (window.Sfx) window.Sfx.preview('select');
            };
          }
          wirePills(panel, '[data-sfx-theme]', (v) => {
            saveConfigPatch({ sfxTheme: v });
            applySfxConfig();
            if (window.Sfx) window.Sfx.previewTheme();
          });
          const sfxNav = panel.querySelector('[data-sfx-nav]');
          if (sfxNav) sfxNav.onchange = () => {
            saveConfigPatch({ sfxNav: sfxNav.checked });
            applySfxConfig();
          };
        },
      };
    },

    async appearance() {
      const reduced = prefersReducedMotion();
      return {
        html: stCard('Look',
          stRow('Palette', 'Sets the accent and the colors of the moving background. Paper is the light one.', stPalettePicker(state.palette)) +
          stRow('Visual quality', 'Cinematic adds the animated background. Lite turns off blur and motion — best on older PCs.', stPills('data-tier-group', [['cinematic', 'Cinematic'], ['standard', 'Standard'], ['lite', 'Lite']], state.tier)) +
          stRow('Motion', `Follows your system’s “reduce motion” setting — currently <b>${reduced ? 'reduced' : 'full'}</b>.`, '')),
        wire(panel) {
          wirePalettePicker(panel, (v) => applyPalette(v, { announce: true, persist: true }));
          wirePills(panel, '[data-tier-group]', (v) => applyTier(v, { announce: true, persist: true }));
        },
      };
    },

    async library() {
      const sgdb = await api.sgdbKeyGet().catch(() => ({ hasKey: false }));
      const steamState = await (api.steamAccount ? api.steamAccount().catch(() => ({ users: [] })) : Promise.resolve({ users: [] }));
      const steamUser = (steamState.users || [])[0];
      const sgdbDesc = sgdb.hasKey
        ? 'Using your SteamGridDB key. Artwork fills itself when you add a game.'
        : 'No key yet. Get one free at steamgriddb.com → Preferences → API. A shared GameVault artwork cloud that needs no key is on the way.';
      const steamDesc = steamUser
        ? `Detected SteamID ${esc(steamUser.steamId)}${steamUser.personaName ? ` (${esc(steamUser.personaName)})` : ''} · ${state.config.hasSteamKey ? 'key saved' : 'no key yet'}`
        : `No Steam login found on this PC${state.config.hasSteamKey ? ' · key saved' : ''}.`;
      return {
        html:
          stCard('Artwork',
            stRow('SteamGridDB key', sgdbDesc,
              `<div class="st-inline"><input class="input" id="st-sgdb" type="password" placeholder="${sgdb.hasKey ? 'Key saved — paste to replace' : 'API key'}" autocomplete="off" spellcheck="false" aria-label="SteamGridDB API key" />
               <button type="button" class="btn btn-ghost" data-sgdb-save>Save</button>
               <button type="button" class="btn btn-ghost" data-sgdb-test>Test</button></div>`, { wide: true, descId: 'st-sgdb-desc' }) +
            stRow('Refresh all artwork', 'Looks up covers, banners, logos and icons again for every game.', '<button type="button" class="btn btn-ghost" data-art-refresh>Refresh</button>')) +
          stCard('Steam account',
            stRow('Steam Web API key', `${steamDesc}<br>Lets GameVault see games you own, not just installed ones. Key: steamcommunity.com/dev/apikey — your “Game details” must be public.`,
              `<div class="st-inline"><input class="input" id="st-steam-key" type="password" placeholder="${state.config.hasSteamKey ? 'Key saved — paste to replace' : 'Steam Web API key'}" autocomplete="off" spellcheck="false" aria-label="Steam Web API key" />
               <button type="button" class="btn btn-ghost" data-steam-save>Save</button>
               <button type="button" class="btn btn-ghost" data-steam-test>Test</button></div>`, { wide: true, descId: 'st-steam-desc' })) +
          stCard('Import',
            stRow('Import games', 'Steam, Epic, GOG, Xbox, Hydra, a folder, or your whole PC.', '<button type="button" class="btn btn-ghost" data-open-import>Open import</button>')),
        wire(panel) {
          const sgdbDescEl = panel.querySelector('#st-sgdb-desc');
          panel.querySelector('[data-sgdb-save]').onclick = async () => {
            const input = panel.querySelector('#st-sgdb');
            const key = input.value.trim();
            if (!key) { toast('Paste a SteamGridDB key first', 'error'); return; }
            await api.sgdbKeySet(key).catch(() => null);
            input.value = '';
            input.placeholder = 'Key saved — paste to replace';
            state.config.hasSgdbKey = true;
            if (sgdbDescEl) sgdbDescEl.textContent = 'Using your SteamGridDB key. Artwork fills itself when you add a game.';
            toast('SteamGridDB key saved', 'ok');
          };
          panel.querySelector('[data-sgdb-test]').onclick = async () => {
            const res = await api.sgdbKeyTest().catch(() => null);
            if (res && res.ok) toast(`SteamGridDB works · ${res.data.count} results`, 'ok');
            else toast(res && res.error ? res.error.message : 'SteamGridDB unreachable', 'error');
          };
          panel.querySelector('[data-art-refresh]').onclick = async () => {
            toast('Refreshing artwork for the whole library…', 'ok');
            await enrichArt({ force: true });
            toast('Artwork refreshed', 'ok');
          };
          const steamDescEl = panel.querySelector('#st-steam-desc');
          panel.querySelector('[data-steam-save]').onclick = async () => {
            const input = panel.querySelector('#st-steam-key');
            const key = input.value.trim();
            if (!key) { toast('Paste a Steam Web API key first', 'error'); return; }
            await saveConfigPatch({ steamKey: key, steamId: steamUser ? steamUser.steamId : (state.config.steamId || null) });
            input.value = '';
            input.placeholder = 'Key saved — paste to replace';
            if (steamDescEl) steamDescEl.firstChild.textContent = `SteamID ${state.config.steamId || 'not set'} · key saved`;
            toast('Steam key saved', 'ok');
          };
          panel.querySelector('[data-steam-test]').onclick = async () => {
            const typed = panel.querySelector('#st-steam-key').value.trim();
            // without a typed key, main uses the saved one (the renderer never sees it)
            const res = await api.steamOwned({ key: typed || undefined, steamId: state.config.steamId || (steamUser && steamUser.steamId) }).catch(() => null);
            if (res && res.ok) toast(`Steam connected · ${res.count} games`, 'ok');
            else toast((res && res.error && res.error.message) || 'Steam unreachable', 'error');
          };
          panel.querySelector('[data-open-import]').onclick = () => { closeSettings({ restoreFocus: false }); $('#btn-import')?.click(); };
        },
      };
    },

    async tracking() {
      const info = await (api.getPlatformInfo ? api.getPlatformInfo().catch(() => ({})) : Promise.resolve({}));
      const bg = state.config.bgDetect !== false;
      return {
        html:
          stCard('Playtime',
            stRow('Notice games I start outside GameVault', 'Checks every 30 seconds for library games you launched from Steam, a shortcut or the Start menu, and starts counting.', stSwitch('data-bg-detect', bg, { label: 'Notice games started outside GameVault' })) +
            stRow('How a session is counted', 'It starts when the game’s own program is running and ends 60 seconds after it closes, so a quick restart stays one session. Store launchers like Steam or Epic never count, and anything under 30 seconds is ignored.', '') +
            stRow('Per-game settings', 'If a game launches through a launcher or wrapper, open the game → Edit → <b>Launch &amp; tracking</b> and use <b>Detect</b> to pick the real game.', '')) +
          (info.platform === 'linux'
            ? stCard('Windows games on Linux',
              stRow('Proton', info.protonPath ? `Using <code class="st-code">${esc(info.protonPath)}</code>` : 'No Proton build found. Install Proton through Steam, or Wine for non-Steam games.', ''))
            : ''),
        wire(panel) {
          panel.querySelector('[data-bg-detect]').onchange = async (e) => {
            await saveConfigPatch({ bgDetect: e.target.checked });
            toast(e.target.checked ? 'GameVault will notice games you start elsewhere' : 'Only games launched from GameVault are tracked', 'ok');
          };
        },
      };
    },

    async controller() {
      const pads = livePads();
      const on = padEnabled();
      const glyph = ['xbox', 'ps'].includes(state.config.padGlyphs) ? state.config.padGlyphs : 'auto';
      const status = pads.length
        ? `Connected: ${pads.map((p) => esc(window.PadInput ? window.PadInput.padName(p.id) : 'Controller')).join(', ')}.`
        : 'No controller found yet: connect one and press any button.';
      return {
        html:
          stCard('Controller',
            stRow('Use a controller', `Works everywhere in GameVault, next to your mouse and keyboard. ${status}`,
              stSwitch('data-pad-on', on, { label: 'Use a controller' })) +
            stRow('Button style', 'Which button icons to show.', stPills('data-glyphs', [['auto', 'Automatic'], ['xbox', 'Xbox'], ['ps', 'PlayStation']], glyph)) +
            stRow('Buttons', padLegendHtml(), '', { wide: true })) +
          stCard('Big Picture',
            stRow('Big Picture mode', 'A fullscreen, TV-sized GameVault. Open it here, with the button in the top bar, with the controller’s Xbox / PS button (or View + Menu), or with F11.',
              `<button type="button" class="btn${bp.on ? '' : ' btn-primary'}" data-bp-toggle>${bp.on ? 'Exit Big Picture' : 'Open Big Picture'}</button>`) +
            stRow('Start in Big Picture', 'Open straight into Big Picture when GameVault starts. Launching it with --bigpicture does the same once.',
              stSwitch('data-bp-start', state.config.startBigPicture === true, { label: 'Start in Big Picture' }))),
        wire(panel) {
          wireBpSettings(panel);
          const sw = panel.querySelector('[data-pad-on]');
          if (sw) sw.onchange = () => { saveConfigPatch({ padEnabled: sw.checked }); if (!sw.checked) setPadMode(false); };
          wirePills(panel, '[data-glyphs]', (v) => {
            saveConfigPatch({ padGlyphs: v });
            const legend = panel.querySelector('[data-pad-legend]');
            if (legend) legend.outerHTML = padLegendHtml();
            paintPadHints();
          });
        },
      };
    },

    async account() {
      const [st, prov] = await Promise.all([
        window.api.accountStatus().catch(() => ({ needsRestart: true })),
        window.api.accountProviders().catch(() => ({ email: true, google: false })),
      ]);
      state.account = st;
      state.accountProviders = prov;
      if (api.cloudLastSync) state._lastSync = await api.cloudLastSync().catch(() => null);
      return {
        html:
          `<section class="st-card acct-card" data-account>${accountCardHtml()}</section>` +
          `<section class="st-card" data-cloud-card>${cloudCardHtml()}</section>`,
        wire(panel) { wireAccountCard(panel.querySelector('[data-account]')); wireCloudCard(panel.querySelector('[data-cloud-card]')); },
      };
    },

    async ai() {
      const cfg = state.config;
      const provider = cfg.aiProvider || 'openai';
      const providers = [['openai', 'OpenAI'], ['anthropic', 'Anthropic (Claude)'], ['google', 'Google Gemini'], ['deepseek', 'DeepSeek'], ['custom', 'Custom (OpenAI-compatible)']];
      return {
        html: stCard('AI advisor',
          stRow('Use the AI advisor', 'Adds an AI tab to the in-game overlay for game suggestions based on your library and PC.', stSwitch('data-ai-enabled', cfg.aiEnabled === true, { label: 'Use the AI advisor' })) +
          stRow('Provider', '', `<select class="select" id="st-ai-provider" aria-label="AI provider">${providers.map(([v, l]) => `<option value="${v}" ${v === provider ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`) +
          `<div data-ai-custom ${provider === 'custom' ? '' : 'hidden'}>` +
            stRow('Endpoint', 'Base URL of an OpenAI-compatible API.', `<input class="input" id="st-ai-endpoint" value="${esc(cfg.aiCustomEndpoint || '')}" placeholder="https://…/v1" spellcheck="false" />`, { wide: true }) +
            stRow('Model', '', `<input class="input" id="st-ai-model" value="${esc(cfg.aiCustomModel || '')}" placeholder="model name" spellcheck="false" />`) +
          '</div>' +
          stRow('API key', cfg.hasAiKey ? 'A key is saved. Paste a new one to replace it.' : 'Stored encrypted on this PC and only sent to the provider you pick.',
            `<div class="st-inline"><input class="input" id="st-ai-key" type="password" placeholder="${cfg.hasAiKey ? 'Key saved — paste to replace' : 'API key'}" autocomplete="off" spellcheck="false" aria-label="AI API key" />
             <button type="button" class="btn btn-ghost" data-ai-save>Check &amp; save</button></div>`, { wide: true, descId: 'st-ai-desc' })),
        wire(panel) {
          const sel = panel.querySelector('#st-ai-provider');
          const custom = panel.querySelector('[data-ai-custom]');
          sel.onchange = async () => {
            custom.hidden = sel.value !== 'custom';
            await saveConfigPatch({ aiProvider: sel.value });
          };
          panel.querySelector('[data-ai-enabled]').onchange = async (e) => {
            await saveConfigPatch({ aiEnabled: e.target.checked });
            toast(e.target.checked ? 'AI advisor on — find it in the overlay' : 'AI advisor off', 'ok');
          };
          panel.querySelector('[data-ai-save]').onclick = async () => {
            const key = panel.querySelector('#st-ai-key').value.trim();
            const endpoint = panel.querySelector('#st-ai-endpoint')?.value.trim() || '';
            const modelName = panel.querySelector('#st-ai-model')?.value.trim() || '';
            if (!key && sel.value !== 'custom') { toast('Paste an API key first', 'error'); return; }
            const res = api.aiValidateKey ? await api.aiValidateKey({ provider: sel.value, key, endpoint, modelName }).catch(() => null) : { valid: true };
            if (!res || !res.valid) { toast((res && res.error) || 'That key did not work', 'error'); return; }
            await saveConfigPatch({ aiKey: key, aiProvider: sel.value, aiCustomEndpoint: endpoint, aiCustomModel: modelName });
            panel.querySelector('#st-ai-key').value = '';
            const d = panel.querySelector('#st-ai-desc'); if (d) d.textContent = 'A key is saved. Paste a new one to replace it.';
            toast('AI key checked and saved', 'ok');
          };
        },
      };
    },

    async performance() {
      return {
        html: stCard('Performance',
          stRow('Frame rate', '<span id="s-perf">measuring…</span><br><span id="s-perf-gpu">GPU: checking…</span>',
            '<div class="st-inline"><button type="button" class="btn btn-ghost" data-perf-copy>Copy report</button><button type="button" class="btn btn-ghost" data-perf-reveal>Reveal log</button></div>') +
          stRow('Benchmark', 'Clicks through the app for 20 seconds and writes the results to perf.log. Don’t touch the window until it says done.', '<button type="button" class="btn" data-perf-bench>Run benchmark</button>') +
          stRow('Record frame stats', '<span id="s-perf-path">When on, stats are written every second to perf.log.</span>', stSwitch('data-perf-record', state.config.perfLog === true, { label: 'Record frame stats' }))),
        async wire(panel) {
          const perfEl = panel.querySelector('#s-perf');
          let gpuInfo = {};
          if (api.gpuStatus) gpuInfo = await api.gpuStatus().catch(() => ({}));
          const gpuEl = panel.querySelector('#s-perf-gpu');
          if (gpuEl) gpuEl.textContent = `GPU compositing: ${(gpuInfo && gpuInfo.gpu_compositing) || 'unknown'}`;
          let frames = 0;
          const t0 = performance.now();
          const beat = (now) => {
            frames += 1;
            if (now - t0 < 1000) { requestAnimationFrame(beat); return; }
            const fps = Math.max(1, Math.round((frames * 1000) / (now - t0)));
            if (perfEl && perfEl.isConnected) perfEl.textContent = `${fps} fps · ${(1000 / fps).toFixed(1)} ms per frame · ${state.tier} quality`;
          };
          requestAnimationFrame(beat);
          const pathEl = panel.querySelector('#s-perf-path');
          if (pathEl && api.perfPath) api.perfPath().then((p) => { if (pathEl.isConnected) pathEl.textContent = `Log: ${p}`; }).catch(() => {});
          panel.querySelector('[data-perf-record]').onchange = async (e) => {
            await saveConfigPatch({ perfLog: e.target.checked });
            syncPerfRecorder();
            toast(e.target.checked ? 'Recording frame stats to perf.log' : 'Frame stats recording off', 'ok');
          };
          panel.querySelector('[data-perf-reveal]').onclick = () => api.perfReveal && api.perfReveal();
          panel.querySelector('[data-perf-copy]').onclick = async () => {
            const report = {
              readout: perfEl ? perfEl.textContent : '',
              window: `${innerWidth}x${innerHeight}`,
              dpr: devicePixelRatio,
              tier: state.tier,
              palette: state.palette,
              gpu: (gpuInfo && gpuInfo.gpu_compositing) || 'unknown',
              games: state.games.length,
            };
            const text = JSON.stringify(report);
            try { await navigator.clipboard.writeText(text); toast('Performance report copied', 'ok'); } catch (_) { toast(text, 'ok'); }
          };
          panel.querySelector('[data-perf-bench]').onclick = async () => {
            closeSettings({ restoreFocus: false });
            const wait = (ms) => new Promise((r) => setTimeout(r, ms));
            const mark = (m) => { if (window.__gvPerfMark) window.__gvPerfMark(m); };
            perfForced += 1; // the benchmark always records, whatever the setting says
            syncPerfRecorder();
            try {
              await wait(600);
              for (const f of ['Active', 'Finished', 'Want', 'All']) { mark('bench:filter:' + f); setFilter(f); await wait(900); }
              mark('bench:sidebar'); $('#side-toggle').click(); await wait(700);
              mark('bench:sidebar'); $('#side-toggle').click(); await wait(700);
              mark('bench:grid'); $('#btn-view').click(); await wait(800);
              mark('bench:scroll');
              const lib = $('#library');
              for (let i = 0; i < 12; i++) { lib.scrollTop += 140; await wait(60); }
              mark('bench:detail'); if (state.games[0]) openDetail(state.games[0].id); await wait(1000);
              mark('bench:back'); if (state.selectedId) closeDetail(); await wait(1100);
              if (api.perfLog) api.perfLog({ t: Date.now(), benchmark: 'done', tier: state.tier });
            } finally {
              perfForced -= 1;
              syncPerfRecorder();
            }
            toast('Benchmark finished — perf.log updated', 'ok');
          };
        },
      };
    },

    async about() {
      const version = await api.getAppVersion().catch(() => '2.0.0-experimental');
      const info = await (api.getPlatformInfo ? api.getPlatformInfo().catch(() => ({})) : Promise.resolve({}));
      const osName = info.platform === 'win32' ? 'Windows' : info.platform === 'linux' ? `Linux${info.wayland ? ' (Wayland)' : ''}` : (info.platform || 'unknown');
      const link = (url, label) => `<button type="button" class="st-link" data-ext="${esc(url)}">${esc(label)}</button>`;
      return {
        html:
          stCard('GameVault',
            stRow('Version', `${esc(version)} · ${esc(osName)}`, '') +
            stRow('Updates', /experimental/i.test(version) ? 'This is an experimental build, so automatic updates are off.' : 'GameVault checks for updates on startup.', '') +
            stRow('Your data', 'Library, settings and cached artwork live in one folder on this PC.', '<button type="button" class="btn btn-ghost" data-open-data>Open folder</button>')) +
          stCard('Credits',
            stRow('SteamGridDB', 'Covers, banners, logos and icons come from the SteamGridDB community.', link('https://www.steamgriddb.com', 'steamgriddb.com')) +
            stRow('PCGamingWiki', 'Save-game locations (for cloud saves) come from PCGamingWiki via the Ludusavi manifest.', link('https://www.pcgamingwiki.com', 'pcgamingwiki.com')) +
            stRow('Source code', 'GameVault is open source under the MIT license.', link('https://github.com/itzSornet/Gamevault', 'GitHub'))),
        wire(panel) {
          for (const b of panel.querySelectorAll('[data-ext]')) b.onclick = () => api.openExternal && api.openExternal(b.dataset.ext);
          panel.querySelector('[data-open-data]').onclick = async () => {
            const p = await api.getDataPath().catch(() => '');
            if (p) api.showInFolder(p);
          };
        },
      };
    },
  };

  // Spotlight hooks: filled in by the spotlight block at the end of the file.
  const spotHooks = { open: () => {}, close: () => {}, isOpen: () => false, resync: () => {} };

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------

  const VIEWS = ['shelf', 'poster'];
  const VIEW_NAMES = { shelf: 'Shelf', poster: 'Cards' };

  function cycleView() {
    const next = VIEWS[(VIEWS.indexOf(state.view) + 1) % VIEWS.length];
    state.view = next;
    lsSet('gv.view', next);
    // the user's sort choice survives layout changes (the shelf renders any
    // order); keep the toolbar label in step with what is actually applied
    state._shelfKey = '';
    updateSortUi();
    applyView();
    renderLibrary();
    fadeIn(currentPane());
    // the button's own click is the feedback; no chime on top of it
    toast(`Layout: ${VIEW_NAMES[next] || next}`, 'ok', null, { quiet: true });
  }

  const SORT_LABELS = {
    lastPlayed: 'Last played',
    added: 'Recently added',
    name: 'Name',
    hours: 'Hours played',
    rating: 'Your rating',
    status: 'Status',
  };

  function updateSortUi() {
    const label = $('#sort-label');
    if (label) label.textContent = SORT_LABELS[state.sort] || 'Last played';
    for (const item of $$('.sort-item')) {
      item.setAttribute('aria-selected', String(item.dataset.sort === state.sort));
    }
  }

  function applyView() {
    const lib = $('#library');
    if (lib) lib.scrollTop = 0;
    const grid = $('#grid');
    grid.classList.remove('view-compact', 'view-list');
    $('#btn-view').classList.toggle('is-active', state.view !== 'shelf');
  }

  const SETTLE_EASE = 'cubic-bezier(0.22, 0.8, 0.3, 1)';   // no overshoot

  // Category switch: content drifts up and fades in, slow and without a bounce.
  function popIn(el, delay, baseTransform) {
    if (!el) return;
    const b = baseTransform ? baseTransform + ' ' : '';
    el.animate(
      [
        { opacity: 0, transform: `${b}translateY(6px) scale(0.99)` },
        { opacity: 1, transform: `${b}translateY(0) scale(1)` }
      ],
      { duration: 620, delay: delay || 0, easing: SETTLE_EASE, fill: 'backwards' }
    );
  }

  function animateSwitchPop() {
    if (prefersReducedMotion()) return;
    const active = document.querySelector('.side-item.is-active');
    if (active) {
      const icon = active.querySelector('.side-ico');
      const count = active.querySelector('b');
      if (icon) icon.animate(
        [{ transform: 'scale(0.92)', opacity: 0.6 }, { transform: 'scale(1)', opacity: 1 }],
        { duration: 360, easing: SETTLE_EASE }
      );
      if (count) count.animate(
        [{ opacity: 0 }, { opacity: 1 }],
        { duration: 320, easing: SETTLE_EASE }
      );
    }

    if (state.filter === 'Activity') {
      const av = $('#activity-view');
      if (av) Array.from(av.querySelectorAll('.act-head, .act-tile, .act-card'))
        .slice(0, 12).forEach((el, i) => popIn(el, i * 45));
      return;
    }
    if (state.filter === 'Want') {
      const wv = $('#wishlist-view');
      if (wv) Array.from(wv.querySelectorAll('.wl-head > *, .wl-top, .wl-card, .wl-empty:not([hidden])'))
        .slice(0, 12).forEach((el, i) => popIn(el, i * 45));
      return;
    }
    if (state.view === 'shelf') {
      const stage = $('#shelf-stage');
      if (stage) {
        Array.from(stage.querySelectorAll('.shelf-content > *')).forEach((el, i) => popIn(el, i * 55));
        const poster = stage.querySelector('.shelf-poster.is-on');
        if (poster) popIn(poster, 60, 'translateY(-50%)');
      }
      const inView = (el) => {
        const r = el.getBoundingClientRect();
        return r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth;
      };
      const tiles = Array.from(document.querySelectorAll('#shelf-strip .shelf-tile')).filter(inView);
      tiles.forEach((tile, i) => popIn(tile, 90 + Math.min(i, 10) * 28));
    } else {
      const inView = (el) => {
        const r = el.getBoundingClientRect();
        return r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth;
      };
      const cards = Array.from($('#grid').children).filter(inView);
      cards.forEach((card, i) => popIn(card, Math.min(i, 12) * 24));
    }
  }

  async function setFilter(filter) {
    window.__gvPerfMark && window.__gvPerfMark('filter:' + filter);
    if (filter !== state.filter) sfx('tab');
    if (state.settingsOpen) closeSettings({ restoreFocus: false });
    if (state.selectedId) closeDetail();
    state.filter = filter;
    if (!bp.on) lsSet('gv.filter', filter);
    for (const btn of $$('.tab[data-filter]')) btn.classList.toggle('is-active', btn.dataset.filter === filter);
    const title = $('#filter-title');
    if (title) title.textContent = filterLabel(filter);
    syncSidePill();
    state._gridAnimate = true;
    const next = filteredGames()[0];
    if (next) await preloadHero(heroUrlOf(next));
    const apply = () => {
      renderLibrary();
      if (state._gridAnimate) { state._gridAnimate = false; }
      animateSwitchPop();
      const lib = $('#library');
      if (lib) lib.scrollTop = 0;
      const wv = $('#wishlist-view');
      if (wv) wv.scrollTop = 0;
      const av = $('#activity-view');
      if (av) av.scrollTop = 0;
    };
    apply();
  }

  // "Launching…" must never stick. The tracker itself gives up after 90 s
  // (180 s for Steam) and says so via tracking:gave-up; this is only the
  // backstop in case that message never arrives.
  const LAUNCH_TIMEOUT_MS = 200000;
  const launchWatchdogs = new Map();

  function clearLaunchWatchdog(id) {
    const key = String(id);
    const t = launchWatchdogs.get(key);
    if (t) { clearTimeout(t); launchWatchdogs.delete(key); }
  }

  function armLaunchWatchdog(g) {
    const id = String(g.id);
    clearLaunchWatchdog(id);
    launchWatchdogs.set(id, setTimeout(() => {
      launchWatchdogs.delete(id);
      if (state.live[id] !== 'launching') return;
      delete state.live[id];
      refreshGameUi(state.games.find((x) => String(x.id) === id));
      toast(`${g.name || 'The game'} was launched, but GameVault couldn't detect it running — playtime isn't being tracked`, 'error');
    }, LAUNCH_TIMEOUT_MS));
  }

  // One readable line: "Executable not found: game.exe" rather than just the
  // first line of a multi-line message.
  function launchErrorText(error) {
    const lines = String(error == null ? '' : error).split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    if (!lines.length) return 'Could not launch the game';
    const isPath = (s) => /^([a-z]:[\\/]|\\\\|\/)/i.test(s) && !/\s{2,}/.test(s);
    const parts = lines.slice(0, 2).map((s) => (isPath(s) ? baseName(s) : s));
    const text = parts.join(' ');
    return text.length > 200 ? `${text.slice(0, 197)}…` : text;
  }

  function togglePlay(id) {
    const g = state.games.find((x) => String(x.id) === String(id));
    if (!g) return;
    const key = String(g.id);
    const live = state.live[key];

    if (typeof live === 'number' || live === 'stopping') {
      sfx('close');
      state.live[key] = 'stopping';
      refreshGameUi(g);
      const done = () => {
        if (state.live[key] === 'stopping') delete state.live[key];
        refreshGameUi(g);
      };
      api.killGame(g.id, g.exePath, g.installDir, g.steamAppId, g.launcherPath)
        .then(done)
        .catch(() => { done(); toast('Could not stop the game', 'error'); });
      return;
    }

    // a second click while launching cancels the wait
    if (live === 'launching') {
      clearLaunchWatchdog(key);
      delete state.live[key];
      refreshGameUi(g);
      return;
    }

    if (gvIsWishlisted(g)) {
      toast('Move it to your library to play it', 'error');
      return;
    }

    if (!g.exePath && !g.steamAppId) {
      toast('No executable set for this game', 'error');
      openGameModal(g);
      return;
    }

    sfx('launch');
    g.lastOpened = Date.now();
    saveGamesSoon();
    state.live[key] = 'launching';
    armLaunchWatchdog(g);
    refreshGameUi(g);
    api.launchGame(g.exePath, g.steamAppId, g.id, g.installDir, g.launcherPath);
  }

  // ---------------------------------------------------------------------------
  // Wiring
  // ---------------------------------------------------------------------------



  function wireRail() {
    const strip = $('#shelf-strip');
    const prev = $('#strip-prev');
    const next = $('#strip-next');
    if (!strip) return;

    const page = () => Math.max(120, Math.round(strip.clientWidth * 0.8));

    if (prev) {
      prev.onclick = (e) => { e.preventDefault(); stopSpring(strip); springTo(strip, strip.scrollLeft - page()); };
    }
    if (next) {
      next.onclick = (e) => { e.preventDefault(); stopSpring(strip); springTo(strip, strip.scrollLeft + page()); };
    }

    // vertical wheel scrolls the rail horizontally, eased by the spring
    strip.addEventListener('wheel', (e) => {
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
      e.preventDefault();
      const raw = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      stopMomentum();
      const st = strip._spring;
      const base = st && st.raf ? st.target : strip.scrollLeft;
      springTo(strip, base + raw * 1.35);
    }, { passive: false });

    // click-drag to pan with touch-style momentum, suppressed on plain clicks
    let dragging = false;
    let startX = 0;
    let startScroll = 0;
    let samples = [];
    let momentum = null;

    const stopMomentum = () => { if (momentum) cancelAnimationFrame(momentum); momentum = null; };

    const glide = (velocity) => {
      // reduced motion: the rail stops where the finger/mouse let go
      if (prefersReducedMotion()) return;
      let v = velocity;
      let last = performance.now();
      const step = (now) => {
        const dt = Math.min(32, now - last);
        last = now;
        strip.scrollLeft -= v * dt;
        v *= Math.pow(0.94, dt / 16.7);
        const max = strip._max != null ? strip._max : (strip.scrollWidth - strip.clientWidth);
        if (Math.abs(v) < 0.02 || strip.scrollLeft <= 0 || strip.scrollLeft >= max) {
          momentum = null;
          return;
        }
        momentum = requestAnimationFrame(step);
      };
      momentum = requestAnimationFrame(step);
    };

    strip.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      stopSpring(strip);
      stopMomentum();
      dragging = true;
      shelfDragMoved = false;
      startX = e.clientX;
      startScroll = strip.scrollLeft;
      samples = [{ t: performance.now(), x: e.clientX }];
      // NOTE: no pointer capture here — capturing on pointerdown retargets the
      // click to the strip, so tiles would never receive it.
    });

    strip.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      if (!shelfDragMoved && Math.abs(dx) > 4) {
        shelfDragMoved = true;
        strip.classList.add('is-dragging');
        try { strip.setPointerCapture(e.pointerId); } catch (_) {}
      }
      if (shelfDragMoved) {
        strip.scrollLeft = startScroll - dx;
        samples.push({ t: performance.now(), x: e.clientX });
        if (samples.length > 6) samples.shift();
      }
    });

    const endDrag = () => {
      if (!dragging) return;
      dragging = false;
      strip.classList.remove('is-dragging');

      if (!shelfDragMoved) return;
      const now = performance.now();
      const recent = samples.filter((s) => now - s.t < 140);
      if (recent.length < 2) return;
      const dt = recent[recent.length - 1].t - recent[0].t;
      if (dt <= 0) return;
      const dx = recent[recent.length - 1].x - recent[0].x;
      let v = dx / dt;                          // px per ms
      v = Math.max(-2.4, Math.min(2.4, v));
      if (Math.abs(v) > 0.08) glide(v);
    };
    strip.addEventListener('pointerup', endDrag);
    strip.addEventListener('pointercancel', endDrag);
    strip.addEventListener('dragstart', (e) => e.preventDefault());

    strip.addEventListener('scroll', syncShelfNav, { passive: true });
    window.addEventListener('resize', () => { strip._max = null; syncShelfNav(); });
    syncShelfNav();
  }

  function wire() {
    wireRail();

    const sortBtn = $('#sort-btn');
    const sortMenu = $('#sort-menu');

    const closeSort = () => {
      if (!sortMenu) return;
      sortMenu.hidden = true;
      sortBtn.setAttribute('aria-expanded', 'false');
    };

    const openSort = () => {
      sortMenu.hidden = false;
      sortBtn.setAttribute('aria-expanded', 'true');
      updateSortUi();
      const active = sortMenu.querySelector('[aria-selected="true"]') || sortMenu.firstElementChild;
      if (active) active.focus({ preventScroll: true });
    };

    if (sortBtn) {
      sortBtn.onclick = () => (sortMenu.hidden ? openSort() : closeSort());
      sortMenu.addEventListener('click', (e) => {
        const item = e.target.closest('.sort-item');
        if (!item) return;
        if (!Object.prototype.hasOwnProperty.call(SORT_LABELS, item.dataset.sort)) return;
        state.sort = item.dataset.sort;
        lsSet('gv.sort', state.sort);
        state._shelfKey = '';
        updateSortUi();
        closeSort();
        sortBtn.focus({ preventScroll: true });
        renderLibrary();
      });
      sortMenu.addEventListener('keydown', (e) => {
        const items = [...sortMenu.querySelectorAll('.sort-item')];
        const i = items.indexOf(document.activeElement);
        if (e.key === 'ArrowDown') { e.preventDefault(); items[Math.min(i + 1, items.length - 1)].focus(); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); items[Math.max(i - 1, 0)].focus(); }
        else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeSort(); sortBtn.focus(); }
      });
      document.addEventListener('pointerdown', (e) => {
        if (!sortMenu.hidden && !e.target.closest('#sort-wrap')) closeSort();
      });
    }

    $('#btn-view').onclick = cycleView;
    $('#btn-add').onclick = () => openGameModal(null);
    $('#btn-import').onclick = openImportModal;
    $('#btn-settings').onclick = () => (state.settingsOpen ? closeSettings() : openSettings());
    $('#empty-cta').onclick = openImportModal;

    for (const btn of $$('.tab[data-filter]')) {
      btn.onclick = () => setFilter(btn.dataset.filter);
    }


    window.addEventListener('mouseup', (e) => {
      // X11/Wayland map the mouse "back" button to 3.
      if (e.button === 3 && state.selectedId) { e.preventDefault(); closeDetail(); }
    });

    document.addEventListener('keydown', (e) => {
      if (e.isComposing || e.keyCode === 229) return;
      const modalOpen = !$('#modal').hidden;
      if (e.key === 'F11' && !e.repeat) {
        e.preventDefault();
        if (bp.on) exitBigPicture(); else enterBigPicture();
        return;
      }
      if (e.key === 'Escape') {
        if (e.defaultPrevented) return;
        if (spotHooks.isOpen()) spotHooks.close();
        else if (modalOpen) closeModal();
        else if (state.selectedId) closeDetail();
        else if (state.settingsOpen) closeSettings();
        else if (bp.on) bpBack();
        return;
      }
      // a dialog owns the keyboard: nothing below may act on the page under it
      if (modalOpen || spotHooks.isOpen()) return;
      const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName);

      if (!typing && (!e.gvPad || padInShelfStrip()) && state.view === 'shelf' && !onPageFilter() && !state.settingsOpen && !state.selectedId && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
        const list = filteredGames();
        if (list.length) {
          const idx = Math.max(0, list.findIndex((g) => String(g.id) === state.shelfId));
          const next = Math.max(0, Math.min(list.length - 1, idx + (e.key === 'ArrowRight' ? 1 : -1)));
          if (next !== idx || !e.gvPad) e.preventDefault();
          if (next !== idx) {
            selectShelfGame(list[next].id);
            // focus follows the selection: a clicked cover must not keep its
            // focus ring while the arrows select the next one (two rings)
            const a = document.activeElement;
            if (!e.gvPad && a && a.classList.contains('shelf-tile')) {
              const t = $('#shelf-strip').querySelector(`.shelf-tile[data-id="${CSS.escape(String(list[next].id))}"]`);
              if (t) t.focus({ preventScroll: true });
            }
          }
        }
      }
      if (e.key === 'Backspace' && state.selectedId && !typing) {
        e.preventDefault();
        closeDetail();
      }
      // Delete removes the focused game, the open game page's game, or the
      // game picked on the shelf
      if (e.key === 'Delete' && !typing && !e.ctrlKey && !e.metaKey && !e.altKey && !e.repeat
          && $('#modal').hidden && !spotHooks.isOpen() && !state.settingsOpen) {
        const a = document.activeElement;
        const onPage = !a || a === document.body || !!a.closest('#shelf, #library, #game-view, #wishlist-view');
        const g = gameFromEl(a)
          || (onPage && state.selectedId ? state.games.find((x) => String(x.id) === state.selectedId) : null)
          || (onPage && !$('#shelf').hidden && state.shelfId ? state.games.find((x) => String(x.id) === state.shelfId) : null);
        if (g) { e.preventDefault(); askRemoveGame(g); return; }
      }
      if (e.key === '/' && !typing && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        spotHooks.open();
        return;
      }

      // ---- game page shortcuts ------------------------------------------
      if (state.selectedId && !typing && !spotHooks.isOpen() && $('#modal').hidden
          && !e.ctrlKey && !e.metaKey && !e.altKey && !e.repeat && !e.isComposing) {
        const g = state.games.find((x) => String(x.id) === state.selectedId);
        if (g) {
          const onControl = ['BUTTON', 'A', 'INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName);
          const key = e.key.toLowerCase();
          // wishlisted games have no Play button, so Space must not launch them either
          if (e.key === ' ' && !onControl) { e.preventDefault(); if (!gvIsWishlisted(g)) togglePlay(g.id); return; }
          if (key === 'e') { e.preventDefault(); openGameModal(g); return; }
          if (key === 'w') { e.preventDefault(); toggleDetailWish(g); return; }
          if (key === 'o' && g.exePath) { e.preventDefault(); api.showInFolder(g.exePath); return; }
          // on a wishlisted game F always means "finished" (it leaves the wishlist)
          if (key === 'f') { e.preventDefault(); setFinished(g, gvIsWishlisted(g) || g.status !== 'Finished'); return; }
          if (e.key === '?') {
            e.preventDefault();
            toast('Space play · E edit · W wishlist · F mark finished · Esc back', 'ok');
            return;
          }
        }
      }
    });

    const findGame = (gameId) => state.games.find((x) => String(x.id) === String(gameId));

    const markRunning = (gameId) => {
      const id = String(gameId);
      clearLaunchWatchdog(id);
      state.live[id] = 0;
      if (!state.liveStart) state.liveStart = {};
      state.liveStart[id] = Date.now();
      return findGame(id);
    };

    if (api.onTrackingStarted) api.onTrackingStarted(({ gameId }) => {
      const g = markRunning(gameId);
      if (g && g.status !== 'Finished' && g.status !== 'Playing' && !gvIsWishlisted(g)) {
        g.status = 'Playing';
        saveGamesSoon();
      }
      refreshGameUi(g);
      toast(`Launched ${g ? g.name : 'game'}`, 'ok');
    });

    if (api.onTrackingTick) api.onTrackingTick(({ gameId, sessionMins }) => {
      const id = String(gameId);
      const mins = Number(sessionMins) || 0;
      clearLaunchWatchdog(id);
      const wasRunning = typeof state.live[id] === 'number';
      state.live[id] = mins;
      if (!state.liveStart) state.liveStart = {};
      state.liveStart[id] = Date.now() - mins * 60000;
      const g = findGame(id);
      if (!g) return;
      updateCard(g);
      if (!wasRunning) refreshStage(g);
    });

    if (api.onTrackingSessionEnd) api.onTrackingSessionEnd(({ gameId, sessionHours, sessionStart, sessionEnd, discarded }) => {
      if (bp.on && api.bringToFront) api.bringToFront();
      const id = String(gameId);
      clearLaunchWatchdog(id);
      delete state.live[id];
      if (state.liveStart) delete state.liveStart[id];
      const g = findGame(id);
      if (!g) return;
      // The tracker discards blips under 30 s (launcher hand-off, crash on
      // start): they are not playtime, so nothing is added or listed.
      const hours = discarded ? 0 : Math.max(0, Number(sessionHours) || 0);
      if (hours > 0) {
        g.hours = (Number(g.hours) || 0) + hours;
        if (!Array.isArray(g.sessions)) g.sessions = [];
        g.sessions.push({ start: sessionStart, end: sessionEnd, duration: hours });
        g.lastPlayed = sessionEnd || Date.now();
        saveGamesSoon();
        if (g.saveDir && cloudOn('cloudSaves')) setTimeout(() => backupNow(g, { quiet: true }), 5000);
      }
      refreshGameUi(g);
      repaintDetailHistory(g);
      if (hours > 0 && state.filter === 'Activity' && !state.selectedId && !state.settingsOpen) renderActivity();
    });

    // Launched, but no session will be recorded: the track process never
    // appeared (wrong exe, launcher only, install prompt) or tracking is off.
    if (api.onTrackingGaveUp) api.onTrackingGaveUp(({ gameId, reason }) => {
      const id = String(gameId);
      clearLaunchWatchdog(id);
      if (state.live[id] !== 'launching' && reason !== 'untracked') return;
      delete state.live[id];
      if (state.liveStart) delete state.liveStart[id];
      const g = findGame(id);
      refreshGameUi(g);
      const name = (g && g.name) || 'The game';
      toast(reason === 'untracked'
        ? `${name} launched — playtime tracking is off for this game`
        : `${name} launched, but GameVault never saw it running. Edit → Launch & tracking to pick what to track`,
      reason === 'untracked' ? 'ok' : 'error');
    });

    if (api.onLaunchError) api.onLaunchError(({ gameId, error }) => {
      const id = String(gameId || '');
      if (id) clearLaunchWatchdog(id);
      if (id && Object.prototype.hasOwnProperty.call(state.live, id)) delete state.live[id];
      if (id && state.liveStart) delete state.liveStart[id];
      toast(launchErrorText(error), 'error');
      refreshGameUi(findGame(id));
    });

    if (api.onTrackingDetected) api.onTrackingDetected(({ gameId, gameName }) => {
      toast(`Detected ${gameName || 'a game'} running`, 'ok');
      refreshGameUi(markRunning(gameId));
    });

    // Main changed a game itself (e.g. launched from the tray): merge, repaint,
    // and do not write it back — main already saved it.
    if (api.onGamesUpdated) api.onGamesUpdated((patch) => {
      if (!patch || typeof patch !== 'object' || patch.id == null) return;
      const g = findGame(patch.id);
      if (!g) return;
      for (const key of ['lastPlayed', 'installDir', 'exePath']) {
        if (patch[key] !== undefined) g[key] = patch[key];
      }
      if (state.selectedId === String(g.id)) {
        updateDetailLive(g);
        if (!gvIsWishlisted(g)) paintRail(g);
      }
      if (!state.selectedId) renderLibrary();
      else updateCard(g);
    });

    // Main is quitting: write everything that is still pending.
    if (api.onAppFlush) api.onAppFlush(() => flushGames());
  }

  // ---------------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------------

  async function boot() {
    state.tier = lsGet('gv.tier') || 'standard';
    state.palette = lsGet('gv.palette') || 'midnight';
    const storedView = lsGet('gv.view');
    state.view = VIEWS.includes(storedView) ? storedView : (storedView ? 'poster' : 'shelf');
    if (storedView && storedView !== state.view) lsSet('gv.view', state.view); // retired "compact" -> cards
    const storedSort = lsGet('gv.sort');
    // no saved choice yet: the shelf has always opened on "Last played"
    state.sort = Object.prototype.hasOwnProperty.call(SORT_LABELS, storedSort)
      ? storedSort
      : (state.view === 'shelf' ? 'lastPlayed' : state.sort);

    try {
      const [games, config] = await Promise.all([api.loadGames(), api.loadConfig()]);
      const norm = normalizeGames(games);
      state.games = norm.games;
      state.config = (config && typeof config === 'object') ? config : {};
      // palette/tier are saved to config on change, so config wins; the view
      // is only kept in localStorage, so localStorage wins for the view
      if (TIERS.includes(state.config.tier)) state.tier = state.config.tier;
      if (PALETTES.includes(state.config.palette)) state.palette = state.config.palette;
      state.view = VIEWS.includes(storedView) ? storedView
        : storedView ? 'poster'
          : (VIEWS.includes(state.config.view) ? state.config.view : 'shelf');
      if (norm.changed && Array.isArray(games) && games.length) persistGames();
      if (api.accountStatus) {
        api.accountStatus().then((st) => {
          state.account = st;
          paintSideAccount();
          if (api.cloudLastSync) api.cloudLastSync().then((t) => { state._lastSync = t; paintSideAccount(); }).catch(() => {});
          setTimeout(() => runCloudSync({}), 3000);
        }).catch(() => {});
      }
    } catch (e) {
      console.error('boot:', e);
      toast('Could not load the library', 'error');
    }

    // one-time status model migration: Dropped → Playing, Want → Wishlist
    try {
      if (Number(state.config.statusModel || 0) < 2) {
        const { games: migrated, changed } = Sessions.migrateStatuses(state.games);
        if (changed.dropped || changed.want) {
          if (api.backupGames) await api.backupGames().catch(() => null);
          state.games = migrated;
          await persistGames();
          const bits = [];
          if (changed.dropped) bits.push(`${changed.dropped} Dropped → Playing`);
          if (changed.want) bits.push(`${changed.want} Want → Wishlist`);
          toast(`Statuses updated: ${bits.join('; ')}.`, 'ok');
        }
        saveConfigPatch({ statusModel: 2 });
      }

      if (Number(state.config.statusModel || 0) < 3) {
        let moved = 0;
        for (const g of state.games) {
          if (gvIsWishlisted(g)) continue;
          if (g.status !== 'Finished' && g.status !== 'Playing') { g.status = 'Playing'; moved += 1; }
        }
        if (moved) {
          await persistGames();
          toast(`Moved ${moved} unplayed game${moved === 1 ? '' : 's'} to Playing.`, 'ok');
        }
        saveConfigPatch({ statusModel: 3 });
      }
    } catch (e) {
      console.warn('status migration failed', e);
    }

    applyPalette(state.palette);
    applyTier(state.tier);
    applyView();
    wire();
    applySfxConfig();
    initGameActions();
    initUiSounds();
    initController();
    initBigPicture();

    updateSortUi();
    syncPerfRecorder();
    const storedFilter = lsGet('gv.filter');
    if (storedFilter && storedFilter !== 'All' && FILTER_LABELS[storedFilter]) {
      state.filter = storedFilter;
      for (const btn of $$('.tab[data-filter]')) btn.classList.toggle('is-active', btn.dataset.filter === storedFilter);
      const ft = $('#filter-title');
      if (ft) ft.textContent = filterLabel(storedFilter);
      syncSidePill();
    }
    renderLibrary();
    refreshCounts();
    prepareThumbs();
    enrichArt();

    // Deep-link dev state (used by --shot-state)
    const hashState = location.hash.replace('#', '');
    if (hashState && window.__gvDevOpen) {
      document.documentElement.classList.add('shot-mode');
      window.__gvDevOpen(hashState);
    }

    initGovernor();

  }

  // Dev hook: lets --shot-state screenshot an inner state headlessly.
  window.__gvDevOpen = (name) => {
    if (!state.games.length) return;
    if (window.__gvDevDone === name) return;   // hash + IPC both call this
    window.__gvDevDone = name;
    if (name === 'detail') openDetail(state.games[0].id);
    if (name === 'editmodal') { openGameModal(state.games[0]); }
    if (name === 'detailrated') {
      const g = state.games.find((x) => Number(x.rating) > 0) || state.games[0];
      openDetail(g.id);
    }
    if (name === 'wishfilter') {
      state.filter = 'Want';
      for (const b of $$('.tab[data-filter]')) b.classList.toggle('is-active', b.dataset.filter === 'Want');
      renderLibrary();
    }
    if (name === 'livetest') {
      const g = state.games[0];
      openDetail(g.id);
      setTimeout(() => {
        state.live[String(g.id)] = 42;
        if (!state.liveStart) state.liveStart = {};
        state.liveStart[String(g.id)] = Date.now() - 42 * 60000;
        updateDetailLive(g);
      }, 400);
    }
    if (name === 'detailbusy') {
      const g = state.games.slice().sort((a, b) => (b.sessions || []).length - (a.sessions || []).length)[0];
      openDetail(g.id);
    }
    if (name === 'detailwant') {
      const g = state.games.find((x) => x.status === 'Want' || x.wishlisted) || state.games[0];
      openDetail(g.id);
    }
    if (name === 'palette') setTimeout(() => spotHooks.open(), 150);
    if (name === 'spot') setTimeout(() => window.__spotOpen && window.__spotOpen(), 150);
    if (name === 'detailfilter') {
      setTimeout(() => {
        const g = state.games.find((x) => x.status === 'Finished') || state.games[0];
        openDetail(g.id);
        setTimeout(() => setFilter('Finished'), 700);
      }, 300);
    }
    if (name === 'sortforce') { $('#sort-menu').hidden = false; }
    if (name === 'wishlist') {
      state.filter = 'Want';
      for (const b of $$('.tab[data-filter]')) b.classList.toggle('is-active', b.dataset.filter === 'Want');
      renderLibrary();
      setTimeout(() => { const t = document.querySelector('.shelf-tile'); if (t) t.click(); }, 250);
    }
    if (name === 'artexpand') {
      openGameModal(null);
      setTimeout(() => {
        const input = document.querySelector('#f-name');
        if (!input) return;
        input.value = 'Hades';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        setTimeout(() => {
          const first = document.querySelector('#f-name-list .combo-item');
          if (first) first.click();
          setTimeout(() => {
            const exp = document.querySelector('[data-art-expand]');
            if (exp) exp.click();
          }, 2200);
        }, 1200);
      }, 150);
    }
    if (name === 'detailbanner2') {
      const g = state.games.find((x) => String(x.id) === String(state.shelfId)) || state.games[0];
      const other = state.games.find((x) => x.id !== g.id && x.heroUrl && x.heroUrl !== g.heroUrl && x.heroUrl.startsWith('file:'));
      window.__baseHero = g.heroUrl;
      window.__targetHero = other ? other.heroUrl : null;
      openDetail(g.id);
      setTimeout(() => {
        openGameModal(g);
        setTimeout(() => {
          const input = document.querySelector('#f-hero');
          if (input && other) { input.value = other.heroUrl; input.dispatchEvent(new Event('input', { bubbles: true })); }
          const save = document.querySelector('[data-save]');
          if (save) save.click();
          setTimeout(() => closeDetail(), 1500);
        }, 600);
      }, 600);
    }
    if (name === 'detailbanner') {
      const g = state.games.find((x) => String(x.id) === String(state.shelfId)) || state.games[0];
      window.__baseHero = g.heroUrl;
      openDetail(g.id);
      setTimeout(() => {
        openGameModal(g);
        setTimeout(() => {
          const mini = document.querySelector('[data-slot="hero"]');
          if (mini) mini.click();
          setTimeout(() => {
            const thumbs = document.querySelectorAll('#art-results .sg-thumb.hero');
            window.__picked = thumbs.length;
            if (thumbs[3]) thumbs[3].click();
            const save = document.querySelector('[data-save]');
            if (save) save.click();
            setTimeout(() => {
              closeDetail();
            }, 1500);
          }, 5000);
        }, 500);
      }, 700);
    }
    if (name === 'bannersave') {
      const g = state.games.find((x) => String(x.id) === String(state.shelfId)) || state.games[0];
      openGameModal(g);
      setTimeout(() => {
        const mini = document.querySelector('[data-slot="hero"]');
        if (mini) mini.click();
        setTimeout(() => {
          const thumbs = document.querySelectorAll('#art-results .sg-thumb.hero');
          if (thumbs[2]) thumbs[2].click();
          const save = document.querySelector('[data-save]');
          try { if (save) save.click(); } catch (e) { window.__bannerErr = String(e); }
        }, 2500);
      }, 500);
    }
    if (name === 'flowsave') {
      const g = state.games[0];
      const tile = () => document.querySelector(`.shelf-tile[data-id="${g.id}"] img`);
      window.__flow = { before: (tile() || {}).src || null, steps: [] };
      const step = (n) => window.__flow.steps.push(n);
      openDetail(g.id);
      setTimeout(() => {
        step('detail');
        openGameModal(g);
        setTimeout(() => {
          step('modal');
          const mini = document.querySelector('[data-slot="cover"]');
          if (mini) mini.click();
          setTimeout(() => {
            step('panel');
            const thumbs = document.querySelectorAll('#art-results .sg-thumb');
            window.__flow.thumbs = thumbs.length;
            if (thumbs[1]) thumbs[1].click();
            const save = document.querySelector('[data-save]');
            try { save.click(); } catch (e) { window.__flow.err = String(e); }
            step('saved');
            setTimeout(() => {
              step('closed');
              const back = document.querySelector('[data-back], .gv-back');
              if (back) back.click(); else closeDetail();
              setTimeout(() => {
                step('back');
                window.__flow.after = (tile() || {}).src || null;
                window.__flow.detailOpen = !document.getElementById('game-view').hidden;
              }, 800);
            }, 1200);
          }, 2200);
        }, 500);
      }, 700);
    }
    if (name === 'addnew') {
      window.__addProbe = { before: document.querySelectorAll('.shelf-tile').length };
      openGameModal(null);
      setTimeout(() => {
        const name = document.querySelector('#f-name');
        if (name) { name.value = 'ZZ Test Game'; name.dispatchEvent(new Event('input', { bubbles: true })); }
        const save = document.querySelector('[data-save]');
        if (save) save.click();
        setTimeout(() => {
          window.__addProbe.after = document.querySelectorAll('.shelf-tile').length;
          window.__addProbe.stage = (document.querySelector('[data-title]') || {}).textContent || null;
        }, 2500);
      }, 500);
    }
    if (name === 'savemenu') {
      const g = state.games[0];
      const tile = () => document.querySelector(`.shelf-tile[data-id="${g.id}"] img`);
      window.__saveProbe = { before: (tile() || {}).src || null, steps: [] };
      window.addEventListener('error', (e) => {
        window.__saveProbe.error = e.message + ' @ ' + (e.filename || '') + ':' + (e.lineno || '');
      });
      const step = (n) => window.__saveProbe.steps.push(n);
      openGameModal(g);
      step('opened');
      setTimeout(() => {
        step('t1');
        const mini = document.querySelector('[data-slot="cover"]');
        if (mini) mini.click();
        step('mini');
        setTimeout(() => {
          step('t2');
          const thumbs = document.querySelectorAll('#art-results .sg-thumb');
          window.__saveProbe.thumbs = thumbs.length;
          if (thumbs[1]) thumbs[1].click();
          step('picked');
          const save = document.querySelector('[data-save]');
          window.__saveProbe.hasSave = !!save;
          try { if (save) save.click(); } catch (err) { window.__saveProbe.thrown = String(err && err.message || err); }
          setTimeout(() => {
            step('done');
            window.__saveProbe.after = (tile() || {}).src || null;
            window.__saveProbe.stage = (document.querySelector('.shelf-art.is-on') || {}).style
              ? document.querySelector('.shelf-art.is-on').style.backgroundImage : null;
          }, 2500);
        }, 2500);
      }, 500);
    }
    if (name === 'saveart') {
      openDetail(state.games[0].id);
      setTimeout(() => {
        openGameModal(state.games[0]);
        setTimeout(() => {
          const mini = document.querySelector('[data-slot="hero"]');
          if (mini) mini.click();
          setTimeout(() => {
            const thumbs = document.querySelectorAll('#art-results .sg-thumb');
            if (thumbs[1]) thumbs[1].click();
            const save = document.querySelector('[data-save]');
            if (save) save.click();
          }, 2500);
        }, 500);
      }, 500);
    }
    if (name === 'clickdetails') {
      const btn = document.querySelector('[data-open]');
      if (btn) btn.click();
    }
    if (name === 'detailfilter') {
      openDetail(state.games[0].id);
      setTimeout(() => { const t = document.querySelector('.tab[data-filter="Active"]'); if (t) t.click(); }, 700);
    }
    if (name === 'detailsave') {
      openDetail(state.games[0].id);
      setTimeout(() => {
        openGameModal(state.games[0]);
        setTimeout(() => {
          const b = document.querySelector('[data-save]');
          if (b) b.click();
        }, 600);
      }, 600);
    }
    if (name === 'savetest') {
      openGameModal(state.games[0]);
      setTimeout(() => {
        const notes = document.querySelector('#f-notes');
        if (notes) notes.value = 'saved-by-test';
        window.__gvNotesProbe = true;
        const b = document.querySelector('[data-save]');
        if (b) b.click();
      }, 700);
    }
    if (name === 'artmore') {
      openGameModal(state.games[0]);
      setTimeout(() => {
        const mini = document.querySelector('[data-slot="cover"]');
        if (mini) mini.click();
        setTimeout(() => { const more = document.querySelector('#art-more'); if (more) more.click(); }, 3000);
      }, 400);
    }
    if (name === 'prismbanners') {
      const g = state.games.find((x) => String(x.name).startsWith('Minecraft Prism')) || state.games[0];
      openGameModal(g);
      setTimeout(() => {
        const mini = document.querySelector('[data-slot="hero"]');
        if (mini) mini.click();
      }, 500);
    }
    if (name === 'editslot') {
      openGameModal(state.games[0]);
      setTimeout(() => {
        const mini = document.querySelector('[data-slot="hero"]');
        if (mini) mini.click();
      }, 400);
    }
    if (name === 'editchange') {
      openGameModal(state.games[0]);
      setTimeout(() => {
        const btn = document.querySelector('[data-art-expand]');
        if (btn) btn.click();
      }, 400);
    }
    if (name === 'fuzzyq') {
      state.query = 'prismm';
      renderLibrary();
    }
    if (name === 'autoart') {
      openGameModal(null);
      setTimeout(() => {
        const input = document.querySelector('#f-name');
        if (!input) return;
        input.value = 'Hades';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        setTimeout(() => {
          const first = document.querySelector('#f-name-list .combo-item');
          if (first) first.click();
        }, 1200);
      }, 150);
    }
    if (name === 'addgame') { openGameModal(null); }
    if (name === 'arthits') { openGameModal(null); setTimeout(() => { const q = document.querySelector('#f-art-q'); const b = document.querySelector('[data-art-search]'); if (q) q.value = 'Hades'; if (b) b.click(); }, 120); }
    if (name === 'artsearch') { openGameModal(null); setTimeout(() => { const b = document.querySelector('[data-art-search]'); const q = document.querySelector('#f-art-q'); if (q) q.value = 'Hades'; if (b) b.click();
      let tries = 0;
      const t = setInterval(() => {
        const g = document.querySelector('[data-art-id]');
        if (g) { g.click(); clearInterval(t); }
        else if (++tries > 40) clearInterval(t);
      }, 200);
    }, 120); }
    if (name === 'sort') { const b = $('#sort-btn'); if (b) b.click(); }
    if (name === 'arrowtest') { const b = $('#strip-next'); if (b) b.click(); }
    if (name === 'clicktile') {
      const tiles = document.querySelectorAll('.shelf-tile');
      if (tiles[3]) tiles[3].click();
    }
    if (name === 'settings') openSettings();
    if (name === 'connectclick') {
      openImportModal();
      setTimeout(() => document.querySelector('[data-acc]')?.click(), 900);
    }
    if (name === 'importmenu') {
      openImportModal();
      setTimeout(() => document.querySelector('[data-pick]')?.click(), 800);
    }
    if (name === 'importhydra') {
      openImportModal();
      setTimeout(() => {
        document.querySelector('[data-pick]')?.click();
        setTimeout(() => {
          document.querySelector('.imp3-menu-row[data-src="hydra"]')?.click();
          setTimeout(() => document.querySelector('[data-primary]')?.click(), 250);
        }, 250);
      }, 700);
    }
    if (name === 'importsketch2') {
      const card = openModal(`
        <div class="modal-head">
          <h2>From a launcher</h2>
          <button class="close-x" data-close aria-label="Close">✕</button>
        </div>
        <div class="isk-menu">
          <div class="isk-menu-label">Detected on this PC</div>
          <button class="isk-row is-on"><span class="isk-ico is-steam">S</span><span class="isk-row-name">Steam</span><span class="isk-plat">Linux · Win</span><span class="isk-row-meta">7 games</span></button>
          <button class="isk-row is-on"><span class="isk-ico is-lutris">L</span><span class="isk-row-name">Lutris</span><span class="isk-plat">Linux</span><span class="isk-row-meta">2 games</span></button>
          <div class="isk-menu-label">Other launchers</div>
          <button class="isk-row"><span class="isk-ico is-epic">E</span><span class="isk-row-name">Epic Games</span><span class="isk-plat">Win · Linux</span><span class="isk-row-meta">—</span></button>
          <button class="isk-row"><span class="isk-ico is-gog">G</span><span class="isk-row-name">GOG Galaxy</span><span class="isk-plat">Win</span><span class="isk-row-meta">—</span></button>
          <button class="isk-row"><span class="isk-ico is-xbox">X</span><span class="isk-row-name">Xbox</span><span class="isk-plat">Win</span><span class="isk-row-meta">—</span></button>
          <button class="isk-row"><span class="isk-ico is-bnet">B</span><span class="isk-row-name">Battle.net</span><span class="isk-plat">Win</span><span class="isk-row-meta">—</span></button>
          <button class="isk-row"><span class="isk-ico is-ea">EA</span><span class="isk-row-name">EA app</span><span class="isk-plat">Win</span><span class="isk-row-meta">—</span></button>
          <button class="isk-row"><span class="isk-ico is-ubi">U</span><span class="isk-row-name">Ubisoft Connect</span><span class="isk-plat">Win</span><span class="isk-row-meta">—</span></button>
          <button class="isk-row"><span class="isk-ico is-amazon">A</span><span class="isk-row-name">Amazon Games</span><span class="isk-plat">Win</span><span class="isk-row-meta">—</span></button>
          <button class="isk-row"><span class="isk-ico is-rock">R</span><span class="isk-row-name">Rockstar</span><span class="isk-plat">Win</span><span class="isk-row-meta">—</span></button>
          <button class="isk-row"><span class="isk-ico is-beth">B</span><span class="isk-row-name">Bethesda</span><span class="isk-plat">Win</span><span class="isk-row-meta">—</span></button>
          <button class="isk-row"><span class="isk-ico is-itch">i</span><span class="isk-row-name">itch.io</span><span class="isk-plat">Win · Linux</span><span class="isk-row-meta">—</span></button>
          <button class="isk-row"><span class="isk-ico is-heroic">H</span><span class="isk-row-name">Heroic</span><span class="isk-plat">Linux</span><span class="isk-row-meta">—</span></button>
          <button class="isk-row"><span class="isk-ico is-bottles">B</span><span class="isk-row-name">Bottles</span><span class="isk-plat">Linux</span><span class="isk-row-meta">—</span></button>
          <button class="isk-row"><span class="isk-ico is-mc">M</span><span class="isk-row-name">Minecraft</span><span class="isk-plat">Win · Linux</span><span class="isk-row-meta">—</span></button>
          <button class="isk-row"><span class="isk-ico is-pl">P</span><span class="isk-row-name">Playnite</span><span class="isk-plat">Win</span><span class="isk-row-meta">—</span></button>
        </div>
        <div class="isk-foot"><span>Pick where the games come from.</span><button class="btn btn-ghost">Cancel</button></div>
      `, { className: 'isk-modal isk-menu-modal' });
      for (const b of card.querySelectorAll('[data-close]')) b.onclick = closeModal;
    }
    if (name === 'importsketch') {
      const card = openModal(`
        <div class="modal-head">
          <h2>Import games</h2>
          <button class="close-x" data-close aria-label="Close">✕</button>
        </div>
        <div class="isk">
          <section class="isk-step is-open">
            <div class="isk-num">1</div>
            <div class="isk-body">
              <div class="isk-head">
                <div>
                  <div class="isk-title">From a launcher</div>
                  <div class="isk-sub">Pick the launcher, then choose how deep to look.</div>
                </div>
                <div class="isk-status">2 detected</div>
              </div>
              <div class="isk-select">
                <span class="isk-ico is-steam">S</span>
                <span class="isk-sel-name">Steam</span>
                <span class="isk-badge">7 games found</span>
                <span class="isk-caret">⌄</span>
              </div>
              <div class="isk-under">Steam launcher</div>
              <div class="isk-actions">
                <button class="isk-act">
                  <b>Scan whole PC</b>
                  <span>All drives, four folders deep · about 30 s</span>
                </button>
                <button class="isk-act">
                  <b>Scan a folder</b>
                  <span>Any folder — it walks every subfolder</span>
                </button>
              </div>
            </div>
          </section>
          <section class="isk-step">
            <div class="isk-num">2</div>
            <div class="isk-body">
              <div class="isk-head">
                <div>
                  <div class="isk-title">Connect an account</div>
                  <div class="isk-sub">Pull the whole owned library, not just what is installed.</div>
                </div>
                <div class="isk-status">optional</div>
              </div>
              <div class="isk-chips">
                <button class="isk-chip"><span class="isk-ico is-steam">S</span>Steam</button>
                <button class="isk-chip"><span class="isk-ico is-epic">E</span>Epic</button>
                <button class="isk-chip"><span class="isk-ico is-gog">G</span>GOG</button>
                <button class="isk-chip"><span class="isk-ico is-xbox">X</span>Xbox</button>
                <button class="isk-chip"><span class="isk-ico is-bnet">B</span>Battle.net</button>
                <button class="isk-chip"><span class="isk-ico is-ea">EA</span>EA app</button>
                <button class="isk-chip"><span class="isk-ico is-ubi">U</span>Ubisoft</button>
                <button class="isk-chip is-more">+ 4 more</button>
              </div>
            </div>
          </section>
          <section class="isk-step">
            <div class="isk-num">3</div>
            <div class="isk-body">
              <div class="isk-head">
                <div>
                  <div class="isk-title">Add a file</div>
                  <div class="isk-sub">A binary with no launcher behind it.</div>
                </div>
              </div>
              <div class="isk-file">
                <button class="isk-act is-inline"><b>Choose file…</b><span>ELF · AppImage · .sh · .exe</span></button>
              </div>
            </div>
          </section>
        </div>
        <div class="isk-foot">
          <span>Nothing is imported until you pick a game.</span>
          <button class="btn btn-ghost">Cancel</button>
        </div>
      `, { className: 'isk-modal' });
      for (const b of card.querySelectorAll('[data-close]')) b.onclick = closeModal;
    }
    if (name === 'import') openImportModal();
    if (name === 'importdemo') { window.__GV_IMPORT_DEMO = true; openImportModal(); }
    if (name === 'fallshelf') {
      state.view = 'shelf';
      applyView();
      renderLibrary();
      setTimeout(() => {
        const t = [...document.querySelectorAll('.shelf-tile')].find((x) => /hex bots/i.test(x.title || ''));
        if (t) { t.scrollIntoView({ block: 'nearest', inline: 'center' }); t.click(); }
      }, 900);
    }
    if (name === 'perflite') {
      document.documentElement.dataset.tier = 'lite';
      setTimeout(() => {
        let frames = 0; const t0 = performance.now(); let last = t0; let worst = 0;
        const step = (now) => {
          frames += 1; worst = Math.max(worst, now - last); last = now;
          if (now - t0 < 2000) requestAnimationFrame(step);
          else console.warn('[perf]', JSON.stringify({ tier: 'lite', fps: Math.round(frames / ((now - t0) / 1000)), worstFrameMs: Math.round(worst) }));
        };
        requestAnimationFrame(step);
      }, 1800);
    }
    if (name === 'sidesmall') {
      setTimeout(() => { const t = document.getElementById('side-toggle'); if (t) t.click(); }, 500);
    }
    if (name === 'perf') {
      setTimeout(() => {
        let frames = 0; const t0 = performance.now(); let last = t0; let worst = 0;
        const step = (now) => {
          frames += 1; worst = Math.max(worst, now - last); last = now;
          if (now - t0 < 2000) requestAnimationFrame(step);
          else console.warn('[perf]', JSON.stringify({ fps: Math.round(frames / ((now - t0) / 1000)), worstFrameMs: Math.round(worst) }));
        };
        requestAnimationFrame(step);
      }, 1800);
    }
    if (name === 'playing') {
      setTimeout(() => { setFilter('Active'); }, 400);
    }
    if (name === 'gridview') {
      state.view = 'poster';
      applyView();
      renderLibrary();
      setTimeout(() => { const l = $('#library'); if (l) l.scrollTop = 0; }, 60);
    }
    if (name === 'importlutris') {
      openImportModal();
      setTimeout(() => {
        const btn = document.querySelector('.import-nav-row[data-src="lutris"]');
        if (btn) btn.click();
      }, 700);
    }
    if (name === 'add') openGameModal(null);
  };

  // Software rendering (no GPU compositing) cannot afford glass: drop to lite.
  if (api.gpuStatus) {
    setTimeout(() => api.gpuStatus().then((s) => {
      const soft = String((s && s.gpu_compositing) || '').includes('disabled');
      // Never persist a tier change from a transient/headless GPU state.
      if (soft) document.documentElement.dataset.software = '1';
      else document.documentElement.dataset.software = '0';
    }).catch(() => {}), 1400);
  }

  // Ctrl+Shift+F toggles a frame-rate HUD for reporting jank.
  // The loop only runs while the HUD is on and the window is visible: main
  // disables background throttling, so a free-running rAF would keep the
  // renderer busy in the tray and while a game is running.
  let fpsOn = false;
  let fpsEl = null;
  let fpsFrames = 0;
  let fpsStart = 0;
  let fpsRaf = 0;
  const fpsLoop = (now) => {
    fpsRaf = 0;
    if (!fpsOn || !fpsEl || document.hidden) return;
    fpsFrames += 1;
    if (!fpsStart) fpsStart = now;
    if (now - fpsStart > 500) {
      fpsEl.textContent = `${Math.round((fpsFrames * 1000) / (now - fpsStart))} fps`;
      fpsFrames = 0; fpsStart = now;
    }
    fpsRaf = requestAnimationFrame(fpsLoop);
  };
  function syncFpsHud() {
    const want = fpsOn && !!fpsEl && !document.hidden;
    if (want && !fpsRaf) {
      fpsFrames = 0; fpsStart = 0;   // don't average across the paused gap
      fpsRaf = requestAnimationFrame(fpsLoop);
    } else if (!want && fpsRaf) {
      cancelAnimationFrame(fpsRaf);
      fpsRaf = 0;
    }
  }
  window.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'f')) return;
    e.preventDefault();
    fpsOn = !fpsOn;
    if (!fpsEl) { fpsEl = document.createElement('div'); fpsEl.className = 'fps-hud'; document.body.appendChild(fpsEl); }
    fpsEl.hidden = !fpsOn;
    if (fpsOn) fpsEl.textContent = '… fps';
    syncFpsHud();
  });

  const sideEl = document.querySelector('.sidebar');
  const sideToggle = $('#side-toggle');
  const mainEl = $('#main');
  // Stagger index for the label slide (top row first).
  if (sideEl) sideEl.querySelectorAll('.side-item').forEach((el, i) => el.style.setProperty('--i', i));

  // Height-locked fold: rows never move vertically, so the only thing that
  // animates is the sidebar's width. The main column's content is pinned to
  // its *final* px width for the duration, so the grid reflows once up front
  // and each frame only re-lays the sidebar, the main box and the top bar.
  let sideAnimEnd = null;
  const finishSideAnim = () => {
    if (!sideAnimEnd) return;
    const done = sideAnimEnd; sideAnimEnd = null; done();
  };
  const applySidebar = (open, animate) => {
    if (!sideEl) return;
    finishSideAnim();
    const label = open ? 'Collapse sidebar' : 'Expand sidebar';
    try { localStorage.setItem('gv.sidebar', open ? 'open' : 'closed'); } catch (_) {}
    if (sideToggle) {
      sideToggle.setAttribute('aria-label', label);
      sideToggle.setAttribute('aria-expanded', String(open));
      sideToggle.title = label;
    }

    const fromW = sideEl.getBoundingClientRect().width;
    sideEl.classList.toggle('is-collapsed', !open);
    const toW = sideEl.getBoundingClientRect().width; // one layout at the final state
    if (!animate || !mainEl || prefersReducedMotion() || Math.abs(toW - fromW) < 1) {
      syncSidePill();
      spotHooks.resync();
      return;
    }

    // An empty library is centred text, not a grid: pinning the column to its
    // final width would make it jump half the width change, then slide back.
    // Instead the block keeps its final width and is centred by a transform,
    // so it glides from the old centre to the new one as one piece.
    const floatEl = [...mainEl.querySelectorAll('#shelf-stage > .onboard > .onboard-inner, #shelf-stage > .shelf-empty, #empty')]
      .find((el) => !el.hidden && el.offsetParent);
    const pinned = floatEl ? [] : [...mainEl.children].filter((el) => !el.hidden && !el.classList.contains('topbar'));
    pinned.forEach((el) => { el.style.width = `${el.getBoundingClientRect().width}px`; });
    if (floatEl) {
      floatEl.style.width = `${floatEl.getBoundingClientRect().width}px`;
      floatEl.classList.add('is-side-float');
    }
    mainEl.classList.add('is-side-moving');
    document.documentElement.dataset.busy = '1';   // ambient.js holds the fluid still
    // Start from the old width, then release to the class width with the transition on.
    sideEl.style.width = sideEl.style.flexBasis = `${fromW}px`;
    void sideEl.offsetWidth;
    sideEl.classList.add('side-anim');
    sideEl.style.width = sideEl.style.flexBasis = '';

    let timer = 0;
    const onEnd = (e) => { if (e.target === sideEl && e.propertyName === 'width') finishSideAnim(); };
    sideAnimEnd = () => {
      clearTimeout(timer);
      sideEl.removeEventListener('transitionend', onEnd);
      sideEl.classList.remove('side-anim');
      mainEl.classList.remove('is-side-moving');
      delete document.documentElement.dataset.busy;
      pinned.forEach((el) => { el.style.width = ''; });
      if (floatEl) { floatEl.style.width = ''; floatEl.classList.remove('is-side-float'); }
      syncSidePill();
      spotHooks.resync();
    };
    sideEl.addEventListener('transitionend', onEnd);
    timer = setTimeout(finishSideAnim, 400); // safety if transitionend never fires
  };
  applySidebar((() => { try { return localStorage.getItem('gv.sidebar') !== 'closed'; } catch (_) { return true; } })(), false);
  if (sideToggle) sideToggle.onclick = () => {
    window.__gvPerfMark && window.__gvPerfMark('sidebar');
    applySidebar(sideEl.classList.contains('is-collapsed'), true);
    const brandEl = sideEl.querySelector('.brand');
    if (brandEl) {   // replay the 1.3.1 shapeshift spin on every toggle
      brandEl.classList.remove('is-shifting');
      void brandEl.offsetWidth;
      // the hexagon spins back in, then (if the pointer is still on it) the
      // hover morph takes over and shows the new direction's arrow
      brandEl.classList.add('is-shifting', 'hover-lock');
      clearTimeout(brandEl._gvShift);
      brandEl._gvShift = setTimeout(() => brandEl.classList.remove('is-shifting', 'hover-lock'), 480);
    }
  };

  const gridEl = $('#grid');
  if (gridEl) {
    gridEl.addEventListener('pointermove', (e) => {
      if (prefersReducedMotion() || document.documentElement.dataset.software === '1') return;
      if (e.pointerType === 'touch') return;
      const card = e.target.closest('.card');
      if (!card) return;
      const r = card.getBoundingClientRect();
      const dx = (e.clientX - r.left) / r.width - 0.5;
      const dy = (e.clientY - r.top) / r.height - 0.5;
      card.style.transform = `perspective(760px) translateY(-3px) scale(1.02) rotateX(${(-dy * 4).toFixed(2)}deg) rotateY(${(dx * 4).toFixed(2)}deg)`;
    }, { passive: true });
    gridEl.addEventListener('pointerout', (e) => {
      const card = e.target.closest('.card');
      if (card && !card.contains(e.relatedTarget)) card.style.transform = '';
    }, { passive: true });
  }

  // ---- performance recorder (1 s samples, 500 ms-ish frame stats)
  // Opt-in (Settings → "Record frame stats", config.perfLog) or forced on
  // for the duration of the benchmark; always paused while the window is
  // hidden. See syncPerfRecorder().
  const perf = { frames: 0, sum: 0, n: 0, worst: 0, jank: 0, longTasks: 0, events: [], last: performance.now() };
  let perfForced = 0;
  let perfRaf = 0;
  let perfTimer = 0;
  let perfObserver = null;
  const perfFrame = (now) => {
    perfRaf = requestAnimationFrame(perfFrame);
    const dt = now - perf.last;
    perf.last = now;
    if (dt > 0 && dt < 5000) {
      perf.frames += 1;
      perf.sum += dt;
      perf.n += 1;
      if (dt > perf.worst) perf.worst = dt;
      if (dt > 50) perf.jank += 1;
    }
  };
  window.__gvPerfMark = (label) => {
    if (!perfRaf) return;
    perf.events.push(label);
    if (perf.events.length > 8) perf.events.shift();
  };
  function perfWanted() {
    return !!api.perfLog && (state.config.perfLog === true || perfForced > 0) && !document.hidden;
  }
  function syncPerfRecorder() {
    const want = perfWanted();
    if (want && !perfRaf) {
      perf.sum = 0; perf.n = 0; perf.worst = 0; perf.jank = 0; perf.longTasks = 0;
      perf.last = performance.now();
      perfRaf = requestAnimationFrame(perfFrame);
      perfTimer = setInterval(perfSample, 1000);
      if (!perfObserver) {
        try {
          perfObserver = new PerformanceObserver((list) => { perf.longTasks += list.getEntries().length; });
          perfObserver.observe({ entryTypes: ['longtask'] });
        } catch (_) { perfObserver = null; }
      }
    } else if (!want && perfRaf) {
      cancelAnimationFrame(perfRaf);
      perfRaf = 0;
      clearInterval(perfTimer);
      perfTimer = 0;
      if (perfObserver) { try { perfObserver.disconnect(); } catch (_) {} perfObserver = null; }
      perf.events.length = 0;
    }
  }
  document.addEventListener('visibilitychange', () => {
    syncFpsHud();
    syncPerfRecorder();
  });
  function perfSample() {
    if (!api.perfLog || !perfRaf) return;
    const avg = perf.n ? perf.sum / perf.n : 0;
    const sample = {
      t: Date.now(),
      fps: avg ? Math.round(1000 / avg) : 0,
      avgMs: +avg.toFixed(1),
      worstMs: Math.round(perf.worst),
      jank: perf.jank,
      longTasks: perf.longTasks,
      w: innerWidth, h: innerHeight, dpr: devicePixelRatio,
      tier: state.tier,
      vis: document.visibilityState,
      events: perf.events.splice(0),
    };
    api.perfLog(sample);
    perf.sum = 0; perf.n = 0; perf.worst = 0; perf.jank = 0;
  }
  syncPerfRecorder();   // boot() calls it again once config.perfLog is known

  syncSidePill();
  window.addEventListener('resize', () => {
    syncSidePill();
    spotHooks.resync();
  });
  const libScroll = $('#library');
  if (libScroll) {
    libScroll.addEventListener('scroll', () => {
      const tb = $('#topbar');
      if (tb) tb.classList.toggle('is-scrolled', libScroll.scrollTop > 4);
    }, { passive: true });
  }

  const sideAcct = $('#side-account');
  if (sideAcct) sideAcct.onclick = () => openSettings('account');
  setInterval(paintSideAccount, 60000);

  for (const b of $$('[data-rail-action]')) {
    b.onclick = () => { const target = document.getElementById(b.dataset.railAction); if (target) target.click(); };
  }

  // ---------------------------------------------------------------------------
  // Spotlight morph — ported from spotlight-morph.html.
  // ONE element (#spot) is both the header bar and the panel.
  // ---------------------------------------------------------------------------
  (() => {
    const $s = (q) => document.querySelector(q);
    const slot = $s('#slot'), spot = $s('#spot'), scrim = $s('#scrim'), input = $s('#q');
    const list = $s('#list'), inner = $s('#inner'), rowsEl = $s('#rows'), pill = $s('#pill'), countEl = $s('#count');
    if (!slot || !spot || !input) return;

    const ICON = {
      plus: '<path d="M12 5v14M5 12h14"/>',
      down: '<path d="M12 4v11m-5-5 5 5 5-5M5 20h14"/>',
      sliders: '<path d="M4 7h9M19 7h1M4 17h1M11 17h9"/><circle cx="16" cy="7" r="2.2"/><circle cx="8" cy="17" r="2.2"/>',
      tv: '<rect x="3" y="5" width="18" height="12" rx="2"/><path d="M8 20h8"/>',
      star: '<path d="m12 4 2.4 5 5.4.7-4 3.8 1 5.4-4.8-2.7-4.8 2.7 1-5.4-4-3.8 5.4-.7z"/>',
      chart: '<path d="M4 20h16"/><path d="M7 16v-4M12 16V6M17 16v-7"/>'
    };
    const esc = (v) => String(v == null ? '' : v).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    // First letter of the first two words that have one: letters only (any
    // script), combining marks kept with their base so "Å" written as A+ring
    // stays whole; punctuation, dashes, digits and emoji are skipped.
    // "Ørkenvandrer — Ångström" → "ØÅ".
    const LETTER = /\p{L}\p{M}*/u;
    const initials = (t) => {
      const out = [];
      for (const word of String(t || '').split(/\s+/)) {
        const m = LETTER.exec(word);
        if (m) out.push(m[0].normalize('NFC').toLocaleUpperCase());
        if (out.length === 2) break;
      }
      return out.join('') || '?';
    };
    const mark = (t, q) => {
      if (!q) return esc(t);
      const i = String(t).toLowerCase().indexOf(String(q).toLowerCase());
      return i < 0 ? esc(t) : esc(String(t).slice(0, i)) + '<b>' + esc(String(t).slice(i, i + q.length)) + '</b>' + esc(String(t).slice(i + q.length));
    };
    const score = (t, q) => {
      t = String(t).toLowerCase(); q = String(q).toLowerCase();
      const i = t.indexOf(q); if (i >= 0) return 100 - i;
      let j = 0; for (const c of t) if (c === q[j]) j++;
      return j === q.length ? 40 : 0;
    };

    const actions = () => [
      { icon: 'plus', title: 'Add game', run: () => $('#btn-add')?.click() },
      { icon: 'down', title: 'Import games', run: () => $('#btn-import')?.click() },
      { icon: 'star', title: 'Open wishlist', run: () => setFilter('Want') },
      { icon: 'chart', title: 'Open activity', run: () => (bp.on ? bpGo('activity') : setFilter('Activity')) },
      { icon: 'sliders', title: 'Open settings', run: () => (bp.on ? bpGo('settings') : $('#btn-settings')?.click()) },
      bp.on
        ? { icon: 'tv', title: 'Exit Big Picture', run: () => exitBigPicture() }
        : { icon: 'tv', title: 'Big Picture', run: () => enterBigPicture() },
    ];

    const MAX_RESULTS = 50;   // rows rendered per section; the count says how many matched
    const MAX_STAGGER = 12;   // rows past this enter together

    const games = () => (state.games || []).map((g) => ({
      kind: 'game',
      id: g.id,
      title: g.name || 'Untitled',
      status: gvIsWishlisted(g) ? 'Wishlist' : gvStatusOf(g),
      h: Number.isFinite(Number(g.hours)) ? Number(g.hours) : null,
      cover: g._cover || g.coverUrl || g.heroUrl || '',
      last: g.lastPlayed || 0,
    }));

    function sections(q) {
      const all = games();
      const acts = actions();
      if (!q) {
        // only games that were actually played; no header over an empty list
        const recent = all.filter((x) => x.last > 0).sort((a, b) => b.last - a.last).slice(0, 6);
        const out = [];
        if (recent.length) out.push({ label: 'Recently played', items: recent });
        out.push({ label: 'Actions', items: acts });
        return out;
      }
      const g = all.map((x) => [score(x.title, q), x]).filter((a) => a[0]).sort((a, b) => b[0] - a[0]).map((a) => a[1]);
      const a = acts.filter((x) => score(x.title, q));
      const out = [];
      if (g.length) out.push({ label: 'Games', items: g.slice(0, MAX_RESULTS), total: g.length });
      if (a.length) out.push({ label: 'Actions', items: a });
      return out;
    }

    function rowHTML(it, i, q) {
      const thumb = it.icon
        ? `<span class="thumb act"><svg viewBox="0 0 24 24">${ICON[it.icon]}</svg></span>`
        : it.cover
          ? `<span class="thumb"><img src="${esc(toFileUrl(it.cover))}" alt="" loading="lazy"></span>`
          : `<span class="thumb">${esc(initials(it.title))}</span>`;
      let meta = '';
      if (!it.icon) {
        meta = it.status === 'Finished' ? '<span class="done">Finished</span>' : esc(it.status || '');
        if (it.h != null && it.h > 0) meta += (meta ? ' · ' : '') + esc(fmtHours(it.h));
      }
      return `<div class="item" role="option" id="spot-opt-${i}" aria-selected="false" data-i="${i}" style="--i:${Math.min(i, MAX_STAGGER)}"><div class="in">${thumb}<span class="name">${mark(it.title, q)}</span><span class="meta">${meta}</span></div></div>`;
    }

    function render() {
      const q = input.value.trim();
      const secs = sections(q);
      flat = [];
      let html = '';
      let matched = 0;
      secs.forEach((s) => {
        html += `<div class="sec" role="presentation">${esc(s.label)}</div>`;
        s.items.forEach((it) => { html += rowHTML(it, flat.push(it) - 1, q); });
        matched += s.total != null ? s.total : s.items.length;
      });
      if (!flat.length) html = `<div class="empty" role="presentation">No results for “${esc(q)}”</div>`;
      rowsEl.innerHTML = html;
      countEl.textContent = !flat.length ? ''
        : matched > flat.length ? `${flat.length} of ${matched} results`
          : `${flat.length} result${flat.length > 1 ? 's' : ''}`;
      sel = 0;
      place(false);
      fit();
    }

    function place(animate = true) {
      const els = rowsEl.querySelectorAll('.item');
      els.forEach((e, i) => {
        const on = i === sel;
        e.classList.toggle('sel', on);
        e.setAttribute('aria-selected', String(on));
      });
      const el = els[sel];
      if (el && isOpen) input.setAttribute('aria-activedescendant', el.id);
      else input.removeAttribute('aria-activedescendant');
      if (!el) { pill.style.opacity = 0; return; }
      if (!animate) pill.style.transition = 'none';
      pill.style.opacity = 1;
      pill.style.transform = `translateY(${el.offsetTop}px)`;
      if (!animate) { void pill.offsetHeight; pill.style.transition = ''; list.scrollTop = 0; return; }
      const t = el.offsetTop, b = t + el.offsetHeight, v = list.clientHeight;
      if (t < list.scrollTop + 30) list.scrollTop = Math.max(0, t - 30);
      else if (b > list.scrollTop + v - 8) list.scrollTop = b - v + 8;
    }

    const FIELD = 58, FOOT = 42, BORDER = 2;
    const listH = () => Math.min(inner.offsetHeight, Math.min(Math.floor(innerHeight * 0.55), 400));
    function fit() { list.style.height = (isOpen ? listH() : 0) + 'px'; if (isOpen) geom(openRect()); }
    function openRect() {
      const main = ($('#main') || document.querySelector('.main')).getBoundingClientRect();
      const w = Math.min(660, main.width - 32);
      return {
        left: main.left + (main.width - w) / 2,
        top: main.top + Math.max(40, main.height * 0.13),
        width: w,
        height: BORDER + FIELD + listH() + FOOT,
      };
    }
    const restRect = () => { const r = slot.getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height }; };
    const geom = (r) => { spot.style.left = r.left + 'px'; spot.style.top = r.top + 'px'; spot.style.width = r.width + 'px'; spot.style.height = r.height + 'px'; };

    let isOpen = false, sel = 0, flat = [];

    const modalOpen = () => { const m = document.getElementById('modal'); return !!(m && !m.hidden); };

    // where focus goes back to when the spotlight closes without a choice
    let returnFocus = null;

    function openSpot({ keepValue = false, from = null } = {}) {
      if (isOpen || modalOpen()) return;
      const prev = from || document.activeElement;
      returnFocus = prev && prev !== input && prev !== document.body && !spot.contains(prev) ? prev : null;
      isOpen = true;
      sfx('open', 3);
      spot.classList.add('open'); scrim.classList.add('open');
      spot.setAttribute('aria-expanded', 'true'); input.setAttribute('aria-expanded', 'true');
      if (!keepValue) input.value = '';
      render();
      input.focus({ preventScroll: true });
    }
    function closeSpot({ restoreFocus = true } = {}) {
      if (!isOpen) return;
      isOpen = false;
      sfx('close', 3);
      spot.classList.remove('open'); scrim.classList.remove('open');
      spot.setAttribute('aria-expanded', 'false'); input.setAttribute('aria-expanded', 'false');
      input.removeAttribute('aria-activedescendant');
      const back = returnFocus;
      returnFocus = null;
      input.blur(); input.value = '';
      list.style.height = '0px'; geom(restRect());
      if (restoreFocus && back && back.isConnected && typeof back.focus === 'function' && !back.closest('[inert]')) {
        back.focus({ preventScroll: true });
      }
    }
    function choose(i) {
      const it = flat[i]; if (!it) return;
      // the chosen item moves focus itself (game page, dialog, filter)
      closeSpot({ restoreFocus: false });
      if (typeof window.onSpotlightSelect === 'function') window.onSpotlightSelect(it);
    }

    window.onSpotlightSelect = (it) => {
      if (!it) return;
      if (it.kind === 'game') openDetail(it.id);
      else if (typeof it.run === 'function') it.run();
    };

    // Focus alone (e.g. Tab) does not open the panel: a click, typing,
    // ArrowDown, "/" or Ctrl F does.
    spot.addEventListener('pointerdown', () => {
      if (isOpen) return;
      const from = document.activeElement;   // before the click moves focus
      setTimeout(() => openSpot({ from }), 0);
    });
    scrim.addEventListener('pointerdown', () => closeSpot());
    input.addEventListener('input', () => {
      if (!isOpen) { openSpot({ keepValue: true }); return; }
      render();
    });
    input.addEventListener('keydown', (e) => {
      if (isOpen || e.isComposing) return;
      if (e.key === 'ArrowDown' || e.key === 'Enter') { e.preventDefault(); openSpot({ keepValue: true }); }
    });
    rowsEl.addEventListener('mousemove', (e) => {
      const it = e.target.closest('.item'); if (!it) return;
      const i = +it.dataset.i;
      if (i !== sel) { sel = i; place(); }
    });
    rowsEl.addEventListener('click', (e) => { const it = e.target.closest('.item'); if (it) choose(+it.dataset.i); });

    window.addEventListener('keydown', (e) => {
      const meta = e.ctrlKey || e.metaKey;
      // e.code keeps Ctrl F working on non-Latin keyboard layouts (Ctrl+Shift+F stays the FPS HUD)
      if (meta && !e.shiftKey && !e.altKey && (e.code === 'KeyF' || String(e.key).toLowerCase() === 'f')) {
        if (!isOpen && modalOpen()) return;   // never open behind a dialog
        e.preventDefault(); e.stopImmediatePropagation();
        isOpen ? closeSpot() : openSpot();
        return;
      }
      if (!isOpen) return;
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); closeSpot(); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); e.stopImmediatePropagation(); if (flat.length) { sel = (sel + 1) % flat.length; place(); } }
      else if (e.key === 'ArrowUp') { e.preventDefault(); e.stopImmediatePropagation(); if (flat.length) { sel = (sel - 1 + flat.length) % flat.length; place(); } }
      else if (e.key === 'Enter') { e.preventDefault(); e.stopImmediatePropagation(); choose(sel); }
    }, true);

    function resync() {
      spot.classList.add('snap');
      geom(isOpen ? openRect() : restRect());
      requestAnimationFrame(() => requestAnimationFrame(() => spot.classList.remove('snap')));
    }
    addEventListener('resize', resync);
    // The slot can move without changing size: the title next to it or the
    // buttons after it change width (Sort hides on the Wishlist, the title
    // turns into "Settings"…) and the grid re-centres it. Watch those too.
    const slotRO = new ResizeObserver(() => { if (!isOpen) resync(); });
    for (const el of [slot, $s('#topbar'), $s('#filter-title'), $s('#topbar .top-actions')]) if (el) slotRO.observe(el);

    window.__spotToggle = () => (isOpen ? closeSpot() : openSpot());
    window.__spotOpen = () => openSpot();
    spotHooks.open = () => openSpot();
    spotHooks.close = () => closeSpot();
    spotHooks.isOpen = () => isOpen;
    spotHooks.resync = () => { if (!isOpen) resync(); };
    geom(restRect());
    requestAnimationFrame(() => requestAnimationFrame(() => spot.classList.remove('snap')));
    // The first measurement happens mid shell-in entrance animation (the
    // main column is still translated): measure again once it has settled.
    const shell = $('#main');
    if (shell) {
      shell.addEventListener('animationend', (e) => {
        if (e.target === shell && !isOpen) resync();
      });
    }
    setTimeout(() => { if (!isOpen) resync(); }, 800);
  })();

  // ---------------------------------------------------------------------------
  // Controller (M5). Works on every screen, next to mouse and keyboard: the
  // pad moves real focus, and each screen's own keyboard handling (menus,
  // combo boxes, the spotlight, settings tabs, the shelf) gets the same keys
  // a keyboard would send. src/lib/padinput.js reads the pad.
  // ---------------------------------------------------------------------------

  const PAD_FILTERS = ['All', 'Active', 'Finished', 'Activity', 'Want'];
  const PAD_NATIVE = 'button, a[href], input:not([type="hidden"]), select, textarea, summary';
  const PAD_KEYS = { up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight' };
  const PAD_GLYPH_TEXT = {
    xbox: { a: 'A', b: 'B', x: 'X', y: 'Y', lb: 'LB', rb: 'RB', lt: 'LT', rt: 'RT', menu: '≡', view: '⧉', rs: 'RS', ls: 'LS', guide: '⌂' },
    ps: { a: '✕', b: '○', x: '□', y: '△', lb: 'L1', rb: 'R1', lt: 'L2', rt: 'R2', menu: '≡', view: '⧉', rs: 'RS', ls: 'LS', guide: '⌂' },
  };
  const pad = { reader: null, raf: 0, on: false, glyphs: 'xbox', away: true, mx: -1, my: -1, lastT: 0, ensure: 0 };

  function padEnabled() { return !state.config || state.config.padEnabled !== false; }
  function padGlyphSet() {
    const g = state.config && state.config.padGlyphs;
    return g === 'xbox' || g === 'ps' ? g : pad.glyphs;
  }
  function livePads() {
    try { return Array.from(navigator.getGamepads() || []).filter(Boolean); } catch (_) { return []; }
  }

  // ---- game options: right-click a game, the Menu key, or ≡ on a controller

  const GA_ICONS = {
    play: '<path d="M8 5v14l11-7z" fill="currentColor" stroke="none"/>',
    stop: '<rect x="6.5" y="6.5" width="11" height="11" rx="2" fill="currentColor" stroke="none"/>',
    move: '<path d="M12 5v14M5 12h14"/>',
    open: '<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><path d="M3.5 9h17"/>',
    edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m13.5 6.5 4 4"/>',
    finish: '<path d="m4.5 12.5 5 5L19.5 7"/>',
    unfinish: '<path d="M7 4.5v15l12-7.5z"/>',
    wish: '<path d="m12 3.5 2.6 5.4 5.9.8-4.3 4.1 1 5.9-5.2-2.8-5.2 2.8 1-5.9-4.3-4.1 5.9-.8z"/>',
    folder: '<path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/>',
    art: '<path d="M20 12a8 8 0 1 1-2.3-5.6"/><path d="M20 4.5v4h-4"/>',
    remove: '<path d="M4.5 7h15M10 4.5h4M6.5 7l1 12.5h9l1-12.5M10 11v5M14 11v5"/>',
    rate: '<path d="m12 3.5 2.6 5.4 5.9.8-4.3 4.1 1 5.9-5.2-2.8-5.2 2.8 1-5.9-4.3-4.1 5.9-.8z"/><path d="M12 9v5" stroke-width="1.6"/>',
  };

  function openGameActions(g) {
    if (!g) return;
    const id = String(g.id);
    const wish = gvIsWishlisted(g);
    const running = typeof state.live[id] === 'number';
    const items = [];
    if (wish) items.push(['move', 'Move to library', 'move']);
    else items.push(['play', running ? 'Stop playing' : 'Play', running ? 'stop' : 'play']);
    if (state.selectedId !== id) items.push(['open', 'Open game page', 'open']);
    items.push(['edit', 'Edit game', 'edit']);
    if (!wish) {
      items.push(g.status === 'Finished' ? ['finish', 'Mark as playing', 'unfinish'] : ['finish', 'Mark as finished', 'finish']);
      const r = Rating.value(g);
      if (r >= Rating.PEAK) items.push(['peak', 'Why it’s your Peak', 'rate']);
      items.push(['rate', r ? `Change rating (${Rating.label(r)})` : 'Rate game', 'rate']);
      items.push(['wish', 'Add to wishlist', 'wish']);
    }
    if (g.exePath) items.push(['folder', 'Show in folder', 'folder']);
    items.push(['art', 'Refresh artwork', 'art']);
    items.push(['remove', wish ? 'Remove from wishlist' : 'Remove from library', 'remove']);
    const card = openModal(`
      <div class="ga">
        <div class="ga-head">
          <div class="ga-cover"></div>
          <div class="ga-text"><div class="ga-title">${esc(g.name || 'Untitled')}</div><div class="ga-sub">${esc(statusLabel(g))}</div></div>
        </div>
        <div class="ga-list" role="menu">
          ${items.map(([act, label, icon]) => `<button type="button" class="ga-item" role="menuitem" data-ga="${act}"${act === 'remove' ? ' data-danger' : ''}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${GA_ICONS[icon]}</svg><span>${esc(label)}</span></button>`).join('')}
        </div>
      </div>`, { className: 'ga-modal' });
    if (!card) return;
    const cover = card.querySelector('.ga-cover');
    const src = g._cover || g.coverUrl;
    if (cover && src) cover.style.backgroundImage = cssUrl(src);
    const first = card.querySelector('.ga-item');
    if (first) requestAnimationFrame(() => first.focus({ preventScroll: true }));
    const list = card.querySelector('.ga-list');
    list.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      const btns = Array.from(list.querySelectorAll('.ga-item'));
      const i = btns.indexOf(document.activeElement);
      if (i < 0) return;
      e.preventDefault();
      btns[(i + (e.key === 'ArrowDown' ? 1 : -1) + btns.length) % btns.length].focus();
    });
    for (const btn of card.querySelectorAll('[data-ga]')) {
      btn.onclick = () => {
        const act = btn.dataset.ga;
        closeModal();
        if (act === 'play') togglePlay(id);
        else if (act === 'move') moveToLibrary(g);
        else if (act === 'open') openDetail(id);
        else if (act === 'edit') openGameModal(g);
        else if (act === 'finish') {
          const done = g.status !== 'Finished';
          setFinished(g, done);
          toast(done ? 'Marked as finished' : 'Marked as playing', 'ok');
        }
        else if (act === 'wish') toggleDetailWish(g);
        else if (act === 'rate') setTimeout(() => openRater(g), 0);
        else if (act === 'peak') setTimeout(() => openPeakShowcase(g, null), 0);
        else if (act === 'folder') api.showInFolder(g.exePath);
        else if (act === 'art') refetchArtwork(g);
        else if (act === 'remove') askRemoveGame(g);
      };
    }
  }

  function gameFromEl(el) {
    const host = el && el.closest && el.closest('.card[data-id], .shelf-tile[data-id], [data-wl-item][data-id], [data-act-game][data-id]');
    return host ? state.games.find((g) => String(g.id) === host.dataset.id) || null : null;
  }

  function initGameActions() {
    // right-click a game anywhere (cards, shelf covers, wishlist, its page)
    document.addEventListener('contextmenu', (e) => {
      if (!$('#modal').hidden) return;
      let g = gameFromEl(e.target);
      if (!g && state.selectedId && e.target.closest && e.target.closest('#game-view')) {
        g = state.games.find((x) => String(x.id) === state.selectedId) || null;
      }
      if (!g) return;
      e.preventDefault();
      openGameActions(g);
    });
    // the keyboard's Menu key, or Shift+F10
    document.addEventListener('keydown', (e) => {
      if (e.gvPad || !(e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10'))) return;
      if (!$('#modal').hidden || spotHooks.isOpen()) return;
      const g = gameFromEl(document.activeElement)
        || (state.selectedId ? state.games.find((x) => String(x.id) === state.selectedId) : null);
      if (!g) return;
      e.preventDefault();
      openGameActions(g);
    });
  }

  // ---- interface sounds not tied to one action: clicks, switches, and
  // focus moving by keyboard or controller
  function initUiSounds() {
    let lastInput = '';
    let lastInputAt = 0;
    const mark = (kind) => { lastInput = kind; lastInputAt = performance.now(); };
    addEventListener('keydown', (e) => mark(e.gvPad ? 'pad' : 'key'), true);
    addEventListener('mousedown', () => mark('mouse'), true);
    document.addEventListener('click', (e) => {
      const el = e.target.closest && e.target.closest('button, a[href], [role="button"], [role="tab"], [role="option"], .card, summary');
      if (!el || el.disabled) return;
      sfx('click', null, el);
    }, true);
    document.addEventListener('change', (e) => {
      const t = e.target;
      if (t && t.matches && t.matches('input[type="checkbox"]')) sfx(t.checked ? 'toggleOn' : 'toggleOff', null, t.closest('.st-switch') || t);
    });
    document.addEventListener('focusin', (e) => {
      const recent = performance.now() - lastInputAt < 500;
      if ((recent && lastInput === 'key') || pad.on) sfx('move', null, e.target);
    });
  }

  function initController() {
    if (!window.PadInput || !navigator.getGamepads) return;
    pad.reader = window.PadInput.createReader();
    const hints = document.createElement('div');
    hints.id = 'pad-hints';
    hints.className = 'pad-hints';
    hints.setAttribute('aria-hidden', 'true');
    document.body.appendChild(hints);

    addEventListener('gamepadconnected', (e) => {
      pad.glyphs = window.PadInput.glyphsFor(e.gamepad && e.gamepad.id);
      if (padEnabled() && document.hasFocus()) toast(`${window.PadInput.padName(e.gamepad && e.gamepad.id)} connected`, 'ok');
      startPadLoop();
      if (state.settingsOpen && state.settingsSection === 'controller') renderSettings();
    });
    addEventListener('gamepaddisconnected', () => {
      if (!livePads().length) setPadMode(false);
      if (state.settingsOpen && state.settingsSection === 'controller') renderSettings();
    });
    // a pad connected before launch appears on its first button press
    // (that fires gamepadconnected); if one is already visible, start now
    startPadLoop();

    // the mouse or keyboard takes over as soon as it's used
    addEventListener('mousemove', (e) => {
      if (!pad.on) return;
      if (pad.mx < 0) { pad.mx = e.screenX; pad.my = e.screenY; return; }
      if (Math.abs(e.screenX - pad.mx) + Math.abs(e.screenY - pad.my) > 8) setPadMode(false);
    }, { passive: true });
    addEventListener('mousedown', () => setPadMode(false), true);
    addEventListener('wheel', () => setPadMode(false), { passive: true, capture: true });
    addEventListener('keydown', (e) => { if (!e.gvPad) setPadMode(false); }, true);
    document.addEventListener('focusin', () => { if (pad.on) paintPadHints(); });
  }

  function startPadLoop() {
    if (pad.raf || !pad.reader) return;
    const tick = (t) => {
      pad.raf = 0;
      const pads = livePads();
      if (!pads.length) { pad.reader.reset(); pad.away = true; return; } // the next connect restarts it
      const dt = pad.lastT ? Math.min(64, t - pad.lastT) : 16;
      pad.lastT = t;
      // never act on a pad while a game (or anything else) has focus
      if (!padEnabled() || !document.hasFocus() || document.hidden) {
        pad.reader.reset();
        pad.away = true;
      } else {
        const out = pad.reader.poll(pads, t);
        if (out.active) pad.glyphs = out.glyphs;
        // first frame back: whatever is already held is not a new press
        if (pad.away) pad.away = false;
        else {
          if (out.actions.length) {
            setPadMode(true);
            for (const a of out.actions) {
              try { padAction(a); } catch (err) { console.warn('pad action failed', a, err); }
            }
          }
          if (out.scroll.y || out.scroll.x) { setPadMode(true); padScroll(out.scroll.y * dt * 1.6); }
        }
      }
      pad.raf = requestAnimationFrame(tick);
    };
    pad.raf = requestAnimationFrame(tick);
  }

  function setPadMode(on) {
    if (pad.on === on) return;
    pad.on = on;
    pad.mx = -1;
    document.documentElement.classList.toggle('is-pad', on);
    if (on) paintPadHints();
  }

  // ---- where focus may go

  function padScope() {
    const modal = $('#modal');
    if (modal && !modal.hidden) return modal;
    if (spotHooks.isOpen()) return $('#spot');
    const sort = $('#sort-menu');
    if (sort && !sort.hidden) return sort;
    const menu = Array.from(document.querySelectorAll('[role="menu"]')).find((m) => !m.hidden && m.getClientRects().length);
    if (menu) return menu;
    return $('#app');
  }

  function padFocusable(el) {
    if (!el || el.disabled || !el.isConnected) return false;
    if (el.closest('[hidden], [inert], [aria-hidden="true"], [data-pad-skip]')) return false;
    const native = el.matches(PAD_NATIVE);
    if (!native && !(el.hasAttribute('tabindex') && el.tabIndex >= 0)) return false;
    // inside a focusable card the card is the stop, not the buttons in it
    const host = el.parentElement && el.parentElement.closest('[tabindex]:not([tabindex="-1"])');
    if (host && !host.matches(PAD_NATIVE)) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    // also catches the inside of a closed <details>, which still has a size
    if (el.checkVisibility && !el.checkVisibility({ visibilityProperty: true, contentVisibilityAuto: true })) return false;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none') return false;
    if (cs.opacity === '0' && !el.matches('input[type="checkbox"], input[type="radio"]')) return false;
    return true;
  }

  function padCandidates(root) {
    if (!root) return [];
    return Array.from(root.querySelectorAll(`${PAD_NATIVE}, [tabindex]`)).filter(padFocusable);
  }

  function padPane() {
    if (state.settingsOpen) return $('#settings-view');
    if (state.selectedId) return $('#game-view');
    if (state.filter === 'Want') return $('#wishlist-view');
    if (state.filter === 'Activity') return $('#activity-view');
    return state.view === 'shelf' ? $('#shelf') : $('#library');
  }

  function padInShelfStrip() {
    const strip = $('#shelf-strip');
    return !!strip && strip.contains(document.activeElement);
  }

  function padFocus(el, { select = true } = {}) {
    if (!el) return;
    el.focus({ preventScroll: true });
    el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
    if (select && el.classList.contains('shelf-tile') && el.dataset.id) selectShelfGame(el.dataset.id);
    paintPadHints();
  }

  /** Focus the obvious thing on the current screen. */
  function padFocusDefault() {
    const scope = padScope();
    let el = null;
    if (scope === $('#app')) {
      if (state.settingsOpen) el = $('#settings-view .st-tab.is-active');
      else if (state.selectedId) el = $('#game-view .gvx-play');
      else if (!onPageFilter()) el = state.view === 'shelf' ? $('#shelf-strip .shelf-tile.is-active') : $('#grid .card');
      if (!padFocusable(el)) {
        const vh = innerHeight;
        // something to press beats a text box (there's no on-screen keyboard yet)
        const list = padCandidates(padPane() || $('#main'))
          .sort((x, y) => Number(x.matches('input:not([type="checkbox"]):not([type="radio"]), textarea')) - Number(y.matches('input:not([type="checkbox"]):not([type="radio"]), textarea')));
        el = list.find((x) => { const r = x.getBoundingClientRect(); return r.top >= 0 && r.bottom <= vh; }) || list[0] || null;
      }
    } else {
      const list = padCandidates(scope);
      el = list.find((x) => x.matches('.is-active, [aria-selected="true"], [autofocus]')) || list[0] || null;
    }
    if (el) padFocus(el, { select: false });
  }

  /** After a screen change: if focus got lost (or should move), put it somewhere useful. */
  function padEnsureFocus(force = false) {
    clearTimeout(pad.ensure);
    const check = (again) => {
      if (!pad.on) return;
      const a = document.activeElement;
      const scope = padScope();
      const ok = a && a !== document.body && scope.contains(a) && padFocusable(a);
      if (force || !ok) padFocusDefault();
      else paintPadHints();
      if (again) pad.ensure = setTimeout(() => check(false), 320);
    };
    pad.ensure = setTimeout(() => check(true), 140);
  }

  // ---- actions

  function padKey(key, target) {
    const t = target || document.activeElement || document.body;
    const ev = new KeyboardEvent('keydown', {
      key, code: key === ' ' ? 'Space' : key, bubbles: true, cancelable: true,
    });
    ev.gvPad = true;
    t.dispatchEvent(ev);
    return ev.defaultPrevented;
  }

  function padCycleSelect(sel, d) {
    const n = sel.options.length;
    if (!n) return;
    sel.selectedIndex = (sel.selectedIndex + d + n) % n;
    sel.dispatchEvent(new Event('input', { bubbles: true }));
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function padAction(a) {
    // the Big Picture menu is open: move, pick, or close it; nothing else
    if (bp.menuOpen) {
      if (a === 'guide' || a === 'menu') { sfx('back'); return bpCloseMenu(); }
      if (!(a in PAD_KEYS) && a !== 'confirm' && a !== 'back') return;
    }
    if (a in PAD_KEYS) return padMove(a);
    if (a === 'confirm') { sfx('select', null, document.activeElement); padConfirm(); return padEnsureFocus(); }
    if (a === 'back') { sfx('back'); padBack(); return padEnsureFocus(); }
    if (a === 'play') return padPlay();
    if (a === 'search') {
      if (!$('#modal').hidden) return;
      if (spotHooks.isOpen()) spotHooks.close(); else spotHooks.open();
      return padEnsureFocus();
    }
    if (a === 'prev' || a === 'next') return padTab(a === 'next' ? 1 : -1);
    if (a === 'pageUp' || a === 'pageDown') {
      const s = padScroller();
      return padScroll((a === 'pageDown' ? 1 : -1) * s.clientHeight * 0.85, true);
    }
    if (a === 'menu') {
      if (!$('#modal').hidden || spotHooks.isOpen()) return;
      // on a game: its options (edit, finished, folder…); anywhere else: Settings
      const g = padMenuGame();
      if (g) { openGameActions(g); return padEnsureFocus(); }
      if (bp.on) return bpOpenMenu();
      if (state.settingsOpen) closeSettings(); else openSettings();
      return padEnsureFocus(true);
    }
    if (a === 'view') {
      if (!$('#modal').hidden || spotHooks.isOpen() || state.settingsOpen) return;
      // on a game page: edit it straight away
      if (state.selectedId) {
        const g = state.games.find((x) => String(x.id) === state.selectedId);
        if (g) openGameModal(g);
        return padEnsureFocus();
      }
      if (onPageFilter() || bp.on) return;
      cycleView();
      return padEnsureFocus(true);
    }
    if (a === 'sidebar') {
      if (!$('#modal').hidden || spotHooks.isOpen() || bp.on) return;
      const t = $('#side-toggle');
      if (t) { sfx('tab'); t.click(); }
      return;
    }
    if (a === 'top') {
      const s = padScroller();
      sfx('back', 1);
      s.scrollTo({ top: 0, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
      return;
    }
    if (a === 'guide') {
      // the Xbox / PS button (or View + Menu): opens Big Picture; inside it, the menu
      if (!$('#modal').hidden) return;
      if (spotHooks.isOpen()) spotHooks.close();
      if (bp.on) return bpOpenMenu();
      enterBigPicture();
    }
  }

  function padMove(dir) {
    const scope = padScope();
    const active = document.activeElement;
    if (!active || active === document.body || !scope.contains(active) || !padFocusable(active)) {
      padFocusDefault();
      return;
    }
    if (active.matches('select') && (dir === 'left' || dir === 'right')) { padCycleSelect(active, dir === 'right' ? 1 : -1); sfx('move', null, active); return; }
    if (active.matches('input[type="range"]') && (dir === 'left' || dir === 'right')) {
      if (dir === 'right') active.stepUp(); else active.stepDown();
      active.dispatchEvent(new Event('input', { bubbles: true }));
      active.dispatchEvent(new Event('change', { bubbles: true }));
      return;
    }
    // the focused widget's own arrow keys come first (lists, tabs, menus, the
    // shelf). A text box only gets them while its suggestion list is open:
    // otherwise the pad just moves on past it.
    const textBox = active.matches('input:not([type="checkbox"]):not([type="radio"]), textarea');
    const ownsArrows = !textBox || active.getAttribute('aria-expanded') === 'true';
    if (ownsArrows && padKey(PAD_KEYS[dir], active)) {
      const strip = $('#shelf-strip');
      if (strip && strip.contains(document.activeElement)) {
        const tile = strip.querySelector('.shelf-tile.is-active');
        if (tile && tile !== document.activeElement) padFocus(tile, { select: false });
      }
      paintPadHints();
      return;
    }
    if (spotHooks.isOpen()) return;
    // Up and down stay in their column: the sidebar and the settings menu are
    // only entered and left sideways, never by running off the end of a list.
    const region = (el) => { const r = el.closest('[data-pad-region]'); return r ? r.dataset.padRegion : 'main'; };
    const here = region(active);
    const vertical = dir === 'up' || dir === 'down';
    // The top bar is reached by going up, not sideways: from the Settings menu
    // its buttons sit nearer than the switches at the far right of the panel,
    // so Right used to land on Sort instead of the setting next to you.
    const topbar = $('#topbar');
    const inTop = (el) => !!topbar && topbar.contains(el);
    const fromTop = inTop(active);
    const from = active.getBoundingClientRect();
    const all = padCandidates(scope)
      .filter((el) => el !== active)
      .map((el) => ({ el, rect: el.getBoundingClientRect() }));
    // down out of the top bar goes into whatever is below (Settings, a game page)
    const cands = all.filter((c) => !vertical || region(c.el) === here || (fromTop && dir === 'down'));
    const sameRow = (r) => Math.min(from.bottom, r.bottom) - Math.max(from.top, r.top) > 0;
    let next;
    if (!vertical && !fromTop) {
      next = window.PadInput.pickNext(from, cands.filter((c) => !inTop(c.el)), dir);
      // the top bar only wins sideways when it's on the very same row
      if (!next || !sameRow(next.rect)) {
        const top = window.PadInput.pickNext(from, cands.filter((c) => inTop(c.el) && sameRow(c.rect)), dir);
        if (top) next = top;
      }
    } else {
      next = window.PadInput.pickNext(from, cands, dir);
      // at the top of a column (Settings menu or panel): up reaches the top bar
      if (!next && dir === 'up' && !fromTop) next = window.PadInput.pickNext(from, all.filter((c) => inTop(c.el)), dir);
    }
    if (next) {
      // coming into a list from outside (sidebar, settings menu, cover strip):
      // land on its selected item, not whichever happens to be nearest
      const box = next.el.closest('[data-pad-enter]');
      const picked = box && !box.contains(active)
        ? Array.from(box.querySelectorAll('.is-active, [aria-selected="true"]')).find(padFocusable)
        : null;
      padFocus(picked || next.el);
      return;
    }
    // nothing further that way: scroll, so text below the last button is reachable
    const s = padScroller();
    const room = dir === 'down' ? s.scrollHeight - s.clientHeight - s.scrollTop : dir === 'up' ? s.scrollTop : 0;
    if (room > 2) padScroll((dir === 'down' ? 1 : -1) * s.clientHeight * 0.4, true);
    else sfx('bump');
  }

  function padConfirm() {
    if (spotHooks.isOpen()) { padKey('Enter', $('#q')); return; }
    const scope = padScope();
    const el = document.activeElement;
    if (!el || el === document.body || !scope.contains(el)) { padFocusDefault(); return; }
    if (el.matches('select')) { padCycleSelect(el, 1); return; }
    if (el.matches('input[type="checkbox"], input[type="radio"]')) { el.click(); return; }
    if (el.classList.contains('shelf-tile') && el.dataset.id) { openDetail(el.dataset.id); return; }
    if (padKey('Enter', el)) return;
    if (el.matches('input, textarea')) return; // no on-screen keyboard yet
    el.click();
  }

  function padBack() {
    const atRoot = !state.selectedId && !state.settingsOpen && $('#modal').hidden && !spotHooks.isOpen();
    const el = document.activeElement && document.activeElement !== document.body ? document.activeElement : document.body;
    // popups (sort menu, the game page menu, combo boxes) close on their own Escape
    if (padKey('Escape', el)) return;
    // nothing was open: B takes you back to the library's current game
    if (atRoot) padFocusDefault();
  }

  /** The game the Menu button would act on, or null. */
  function padMenuGame() {
    if (!$('#modal').hidden || spotHooks.isOpen() || state.settingsOpen) return null;
    if (state.selectedId) return state.games.find((g) => String(g.id) === state.selectedId) || null;
    const el = document.activeElement;
    const host = el && el.closest && el.closest('.card[data-id], .shelf-tile[data-id], [data-wl-item][data-id], [data-act-game][data-id]');
    if (host) return state.games.find((g) => String(g.id) === host.dataset.id) || null;
    if (state.view === 'shelf' && !onPageFilter() && el && el.closest && el.closest('#shelf')) {
      return state.games.find((g) => String(g.id) === state.shelfId) || null;
    }
    return null;
  }

  function padGame() {
    if (state.selectedId) return state.games.find((g) => String(g.id) === state.selectedId) || null;
    const el = document.activeElement;
    const host = el && el.closest && el.closest('.card[data-id], .shelf-tile[data-id], [data-wl-item][data-id], [data-act-game][data-id]');
    const id = host ? host.dataset.id : (state.view === 'shelf' && !onPageFilter() ? state.shelfId : null);
    return id ? state.games.find((g) => String(g.id) === String(id)) || null : null;
  }

  function padPlay() {
    if (!$('#modal').hidden || spotHooks.isOpen() || state.settingsOpen) return;
    const g = padGame();
    if (g && !gvIsWishlisted(g)) togglePlay(g.id);
    setTimeout(paintPadHints, 60);
  }

  function padTab(d) {
    if (!$('#modal').hidden || spotHooks.isOpen()) return;
    if (state.settingsOpen) {
      const tabs = Array.from(document.querySelectorAll('#settings-view .st-tab'));
      const i = tabs.findIndex((t) => t.classList.contains('is-active'));
      const next = tabs[(i + d + tabs.length) % tabs.length];
      if (next) { next.click(); padFocus(next); }
      return;
    }
    if (bp.on) { bpGo(window.BigPicture.stepSection(bp.section, d)); return; }
    if (state.selectedId) closeDetail();
    const i = Math.max(0, PAD_FILTERS.indexOf(state.filter));
    setFilter(PAD_FILTERS[(i + d + PAD_FILTERS.length) % PAD_FILTERS.length]);
    padEnsureFocus(true);
  }

  function padScroller() {
    const scope = padScope();
    let el = document.activeElement && document.activeElement !== document.body ? document.activeElement : null;
    if (!el || !scope.contains(el)) el = scope === $('#app') ? padPane() : scope;
    for (let n = el; n && n !== document.body && n !== document.documentElement; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (/(auto|scroll)/.test(cs.overflowY) && n.scrollHeight > n.clientHeight + 2) return n;
    }
    return document.scrollingElement || document.documentElement;
  }

  function padScroll(dy, smooth = false) {
    if (!dy) return;
    const s = padScroller();
    s.scrollBy({ top: dy, behavior: smooth && !prefersReducedMotion() ? 'smooth' : 'auto' });
  }

  // ---- button hints

  function padGlyph(btn, set = padGlyphSet()) {
    const t = (PAD_GLYPH_TEXT[set] || PAD_GLYPH_TEXT.xbox)[btn] || btn.toUpperCase();
    return `<i class="pad-btn" data-glyph="${set}" data-btn="${btn}">${t}</i>`;
  }

  function paintPadHints() {
    const el = $('#pad-hints');
    if (!el) return;
    const items = [];
    const add = (btns, label) => items.push(`<span class="pad-hint">${btns.map((b) => padGlyph(b)).join('')}<span>${esc(label)}</span></span>`);
    const modalOpen = !$('#modal').hidden;
    if (bp.menuOpen) { add(['a'], 'Select'); add(['b'], 'Close'); }
    else if (spotHooks.isOpen()) { add(['a'], 'Open'); add(['b'], 'Close'); }
    else if (modalOpen) { add(['a'], 'Select'); add(['b'], 'Close'); }
    else if (state.settingsOpen) { add(['a'], 'Select'); add(['lb', 'rb'], 'Section'); add(['b'], 'Back'); }
    else {
      const a = document.activeElement;
      const onGame = a && a.matches && a.matches('.card, .shelf-tile');
      add(['a'], onGame ? 'Open' : 'Select');
      const g = padGame();
      if (g && !gvIsWishlisted(g)) add(['x'], typeof state.live[String(g.id)] === 'number' ? 'Stop' : 'Play');
      if (state.selectedId) { add(['view'], 'Edit'); add(['b'], 'Back'); }
      else add(['lb', 'rb'], bp.on ? 'Section' : 'Switch');
      add(['y'], 'Search');
      if (bp.on) {
        if (padMenuGame()) add(['menu'], 'Options');
        add(['guide'], 'Menu');
        if (!state.selectedId) add(['b'], bp.section === 'home' ? 'Exit' : 'Home');
      } else add(['menu'], padMenuGame() ? 'Options' : 'Settings');
    }
    const html = items.join('');
    if (el._html !== html) { el._html = html; el.innerHTML = html; }
  }

  /** The button list shown in Settings → Controller. */
  function padLegendHtml() {
    const rows = [
      [['a'], 'Select / open'], [['b'], 'Back'], [['x'], 'Play or stop the game'], [['y'], 'Search'],
      [['lb', 'rb'], 'Switch library list or settings section'], [['lt', 'rt'], 'Page up / down'],
      [['rs'], 'Right stick scrolls; click it to jump to the top'], [['ls'], 'Click the left stick to fold the sidebar'],
      [['menu'], 'Options for the selected game (Settings when there is none)'], [['view'], 'Switch layout; on a game page, edit the game'],
      [['guide'], 'Xbox / PS button, or View + Menu together: Big Picture (its menu once you’re in)'],
    ];
    return `<div class="pad-legend" data-pad-legend>${rows.map(([b, t]) => `<div class="pad-legend-row"><span class="pad-legend-btns">${b.map((x) => padGlyph(x)).join('')}</span><span>${esc(t)}</span></div>`).join('')}</div>`;
  }


  // ---------------------------------------------------------------------------
  // Big Picture: fullscreen, TV-sized, no sidebar. The same shelf, grid, game
  // page and Settings, zoomed by main (src/lib/bigpicture.js picks the zoom)
  // and restyled under html.is-bigpicture. A slide-out menu replaces the
  // sidebar. Works with a pad, the mouse and the keyboard.
  // ---------------------------------------------------------------------------

  const BP_ICONS = {
    home: '<path d="M4 11.5 12 5l8 6.5"/><path d="M6.5 10v9h11v-9"/>',
    library: '<rect x="3.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.5"/>',
    active: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
    finished: '<path d="m4.5 12.5 5 5L19.5 7"/>',
    wishlist: '<path d="m12 3.5 2.6 5.4 5.9.8-4.3 4.1 1 5.9-5.2-2.8-5.2 2.8 1-5.9-4.3-4.1 5.9-.8z"/>',
    activity: '<path d="M4 20h16"/><path d="M7 16v-4M12 16V6M17 16v-7"/>',
    settings: '<circle cx="12" cy="12" r="3.2"/><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z"/>',
    exit: '<path d="M9 14 4.5 9.5 9 5"/><path d="M4.5 9.5H15a4.5 4.5 0 0 1 0 9h-3"/>',
  };
  const bp = { on: false, section: 'home', menuOpen: false, saved: { view: 'shelf', sort: 'lastPlayed', filter: 'All' }, clock: 0, menuReturn: null, busy: false };

  function bpIcon(name) {
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${BP_ICONS[name] || ''}</svg>`;
  }

  function initBigPicture() {
    if (!window.BigPicture) return;
    const menu = document.createElement('div');
    menu.id = 'bp-menu';
    menu.className = 'bp-menu';
    menu.hidden = true;
    menu.innerHTML = `
      <div class="bp-menu-scrim" data-bp-close></div>
      <nav class="bp-menu-panel" role="menu" aria-label="Big Picture">
        <div class="bp-menu-brand"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/></svg><span>GameVault</span></div>
        <button type="button" class="bp-menu-item bp-menu-acct" role="menuitem" data-bp-account hidden></button>
        ${BigPicture.SECTIONS.map((s) => `<button type="button" class="bp-menu-item" role="menuitem" data-bp-go="${s.id}">${bpIcon(s.id)}<span>${esc(s.label)}</span>${s.filter && s.id !== 'home' ? `<b data-bp-count="${s.filter}"></b>` : ''}</button>`).join('')}
        <div class="bp-menu-sep" role="separator"></div>
        <button type="button" class="bp-menu-item" role="menuitem" data-bp-exit>${bpIcon('exit')}<span>Exit Big Picture</span></button>
      </nav>`;
    $('#modal').before(menu);
    menu.querySelector('[data-bp-close]').onclick = () => bpCloseMenu();
    for (const b of menu.querySelectorAll('[data-bp-go]')) b.onclick = () => bpGo(b.dataset.bpGo);
    menu.querySelector('[data-bp-exit]').onclick = () => exitBigPicture();
    menu.querySelector('[data-bp-account]').onclick = async () => {
      bpCloseMenu({ refocus: false });
      await openSettings('account');
      bpSyncMenu();
      padEnsureFocus(true);
    };
    paintSideAccount();
    const panel = menu.querySelector('.bp-menu-panel');
    panel.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); sfx('back'); bpCloseMenu(); return; }
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return;
      const items = Array.from(panel.querySelectorAll('.bp-menu-item'));
      const i = items.indexOf(document.activeElement);
      e.preventDefault();
      let n = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : i + (e.key === 'ArrowDown' ? 1 : -1);
      n = Math.max(0, Math.min(items.length - 1, n));
      if (n === i) { sfx('bump'); return; }
      items[n].focus();
      paintPadHints();
    });
    // Tab stays inside the open menu
    panel.addEventListener('focusout', (e) => {
      if (bp.menuOpen && !menu.contains(e.relatedTarget)) {
        requestAnimationFrame(() => { if (bp.menuOpen && !menu.contains(document.activeElement)) bpFocusMenu(); });
      }
    });

    const enter = $('#btn-bigpicture');
    if (enter) enter.onclick = () => enterBigPicture();
    const menuBtn = $('#bp-menu-btn');
    if (menuBtn) menuBtn.onclick = () => (bp.menuOpen ? bpCloseMenu() : bpOpenMenu());
    if (api.onBigPicture) api.onBigPicture((on) => (on ? enterBigPicture() : exitBigPicture()));

    let startBp = false;
    try { startBp = new URLSearchParams(location.search).get('bp') === '1'; } catch (_) {}
    if (startBp) requestAnimationFrame(() => enterBigPicture({ instant: true }));
  }

  async function enterBigPicture({ instant = false } = {}) {
    if (bp.on || bp.busy || !window.BigPicture) return;
    bp.busy = true;
    try {
      bp.saved = { view: state.view, sort: state.sort, filter: state.filter };
      bp.on = true;
      document.documentElement.classList.add('is-bigpicture');
      if (!instant) sfx('open');
      if (spotHooks.isOpen()) spotHooks.close();
      if (!$('#modal').hidden) closeModal();
      if (api.setBigPicture) await api.setBigPicture(true).catch(() => null);
      bpStartClock();
      await bpGo('home');
    } finally { bp.busy = false; }
    paintPadHints();
  }

  async function exitBigPicture() {
    if (!bp.on || bp.busy) return;
    bp.busy = true;
    try {
      bpCloseMenu({ refocus: false });
      sfx('close');
      if (spotHooks.isOpen()) spotHooks.close();
      if (!$('#modal').hidden) closeModal();
      if (state.selectedId) closeDetail();
      if (state.settingsOpen) closeSettings({ restoreFocus: false });
      bp.on = false;
      document.documentElement.classList.remove('is-bigpicture');
      // a started-in-Big-Picture page must not come back into it on a reload
      try { if (location.search) history.replaceState(null, '', location.pathname + location.hash); } catch (_) {}
      bpStopClock();
      if (api.setBigPicture) await api.setBigPicture(false).catch(() => null);
      // the user's own layout, sort and list come back (Big Picture never saves its own)
      const { view, sort, filter } = bp.saved;
      state.view = VIEWS.includes(view) ? view : 'shelf';
      state.sort = Object.prototype.hasOwnProperty.call(SORT_LABELS, sort) ? sort : 'lastPlayed';
      state._shelfKey = '';
      updateSortUi();
      applyView();
      await setFilter(filter || 'All');
    } finally { bp.busy = false; }
    paintPadHints();
    padEnsureFocus(true);
  }

  /** Show one Big Picture section (Home, Library, Playing, …, Settings). */
  async function bpGo(id) {
    if (!bp.on) return;
    const s = BigPicture.section(id);
    bpCloseMenu({ refocus: false });
    if (s.settings) {
      if (!state.settingsOpen) await openSettings();
      bpSyncMenu();
      padEnsureFocus(true);
      return;
    }
    bp.section = s.id;
    if (state.view !== s.view || state.sort !== s.sort) {
      state.view = s.view;
      state.sort = s.sort;
      state._shelfKey = '';
      updateSortUi();
      applyView();
    }
    await setFilter(s.filter);   // closes a game page or Settings, re-renders
    if (!bp.on) return;
    const title = $('#filter-title');
    if (title) title.textContent = s.label;
    bpSyncMenu();
    paintPadHints();
    padEnsureFocus(true);
  }

  /** B / Esc with nothing else open: back to Home, and from Home out of Big Picture. */
  function bpBack() {
    const act = BigPicture.backAction({
      menuOpen: bp.menuOpen, modalOpen: !$('#modal').hidden, spotOpen: spotHooks.isOpen(),
      detail: !!state.selectedId, settings: !!state.settingsOpen, section: bp.section,
    });
    if (act === 'close-menu') bpCloseMenu();
    else if (act === 'home') bpGo('home');
    else if (act === 'exit') exitBigPicture();
  }

  function bpSyncMenu() {
    const menu = $('#bp-menu');
    if (!menu) return;
    const current = state.settingsOpen ? 'settings' : bp.section;
    for (const b of menu.querySelectorAll('[data-bp-go]')) {
      const on = b.dataset.bpGo === current;
      b.classList.toggle('is-active', on);
      if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    }
    for (const c of menu.querySelectorAll('[data-bp-count]')) {
      const n = state.counts ? state.counts[c.dataset.bpCount] : null;
      c.textContent = Number.isFinite(n) ? String(n) : '';
    }
  }

  function bpFocusMenu() {
    const menu = $('#bp-menu');
    const el = menu && (menu.querySelector('.bp-menu-item.is-active') || menu.querySelector('.bp-menu-item'));
    if (el) el.focus({ preventScroll: true });
  }

  function bpOpenMenu() {
    if (!bp.on || bp.menuOpen) return;
    const menu = $('#bp-menu');
    if (!menu) return;
    if (spotHooks.isOpen()) spotHooks.close();
    if (!$('#modal').hidden) return;
    bp.menuOpen = true;
    const a = document.activeElement;
    bp.menuReturn = a && a !== document.body ? a : null;
    bpSyncMenu();
    menu.hidden = false;
    $('#app').inert = true;
    document.documentElement.classList.add('bp-menu-open');
    sfx('open');
    const btn = $('#bp-menu-btn');
    if (btn) btn.setAttribute('aria-expanded', 'true');
    bpFocusMenu();
    paintPadHints();
  }

  function bpCloseMenu({ refocus = true } = {}) {
    if (!bp.menuOpen) return;
    bp.menuOpen = false;
    const menu = $('#bp-menu');
    if (menu) menu.hidden = true;
    $('#app').inert = false;
    document.documentElement.classList.remove('bp-menu-open');
    const btn = $('#bp-menu-btn');
    if (btn) btn.setAttribute('aria-expanded', 'false');
    const back = bp.menuReturn;
    bp.menuReturn = null;
    if (refocus) {
      if (back && back.isConnected && padFocusable(back)) back.focus({ preventScroll: true });
      else padEnsureFocus(true);
    }
    paintPadHints();
  }

  function bpStartClock() {
    const el = $('#bp-clock');
    const tick = () => {
      if (el) el.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    };
    tick();
    clearInterval(bp.clock);
    bp.clock = setInterval(tick, 10000);
  }

  function bpStopClock() { clearInterval(bp.clock); bp.clock = 0; }

  /** The Big Picture rows in Settings (General and Controller & Big Picture). */
  function wireBpSettings(panel) {
    const sw = panel.querySelector('[data-bp-start]');
    if (sw) sw.onchange = () => saveConfigPatch({ startBigPicture: sw.checked });
    const btn = panel.querySelector('[data-bp-toggle]');
    if (btn) btn.onclick = () => (bp.on ? exitBigPicture() : enterBigPicture());
  }


  boot();
})();
