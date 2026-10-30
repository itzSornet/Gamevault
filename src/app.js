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
    counts: { All: 0, Playing: 0, Finished: 0, Want: 0 },
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
    if (!n) return '0h';
    return n >= 100 ? `${Math.round(n)}h` : `${n.toFixed(1).replace(/\.0$/, '')}h`;
  };

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

  function toast(message, kind) {
    const wrap = $('#toasts');
    const el = document.createElement('div');
    el.className = 'toast' + (kind === 'error' ? ' is-error' : kind === 'ok' ? ' is-ok' : '');
    el.textContent = message;
    wrap.appendChild(el);
    void el.offsetWidth;
    el.classList.add('is-on');
    setTimeout(() => {
      el.classList.remove('is-on');
      el.style.opacity = '0';
      el.style.transform = 'translateY(6px)';
      setTimeout(() => el.remove(), 250);
    }, 3800);
  }

  function transition(fn) {
    // No document.startViewTransition here: it snapshots the whole window and
    // reads as a flash/freeze in Electron. Page switches are instant.
    fn();
  }

  // ---------------------------------------------------------------------------
  // Performance tiers + governor
  // ---------------------------------------------------------------------------

  function applyTier(tier, { announce = false } = {}) {
    const t = ['cinematic', 'standard', 'lite'].includes(tier) ? tier : 'standard';
    state.tier = t;
    document.documentElement.dataset.tier = t;
    state.config.tier = t;
    localStorage.setItem('gv.tier', t);
    if (announce) toast(`Visual quality: ${t}`, 'ok');
  }

  const PALETTES = ['midnight', 'paper'];

  function applyPalette(name, { announce = false } = {}) {
    const p = PALETTES.includes(name) ? name : 'midnight';
    state.palette = p;
    document.documentElement.dataset.palette = p;
    state.config.palette = p;
    localStorage.setItem('gv.palette', p);
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

  function saveGamesSoon() {
    clearTimeout(saveGamesSoon._t);
    saveGamesSoon._t = setTimeout(async () => {
      try { await api.saveGames(cleanGames()); } catch (e) { console.warn('save failed', e); }
    }, 400);
  }

  function filteredGames() {
    const q = state.query.trim();
    let list = state.games.filter((g) => {
      const wanted = gvIsWishlisted(g);
      if (state.filter === 'All') return !wanted;
      if (state.filter === 'Want') return wanted;
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
      if (sort === 'hours') return (b.hours || 0) - (a.hours || 0);
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
    const c = { All: 0, Playing: 0, Finished: 0, Want: 0 };
    for (const g of state.games) {
      if (gvIsWishlisted(g)) { c.Want += 1; continue; }
      c.All += 1;
      if (g.status === 'Playing') c.Playing += 1;
      if (g.status === 'Finished') c.Finished += 1;
    }
    state.counts = c;
    for (const el of $$('[data-count]')) el.textContent = String(c[el.dataset.count] ?? 0);
    const libSub = $('#lib-sub');
    if (libSub) {
      const hrs = Math.round(state.games.filter((g) => !gvIsWishlisted(g)).reduce((sum, g) => sum + (Number(g.hours) || 0), 0));
      libSub.textContent = `${c.All} game${c.All === 1 ? '' : 's'} · ${hrs.toLocaleString()} h`;
    }
    const totalEl = $('#side-total');
    const hoursEl = $('#side-hours');
    if (totalEl) totalEl.textContent = `${c.All} game${c.All === 1 ? '' : 's'}`;
    if (hoursEl) {
      const hours = Math.round(state.games.filter((g) => !gvIsWishlisted(g)).reduce((sum, g) => sum + (Number(g.hours) || 0), 0));
      hoursEl.textContent = `${hours.toLocaleString()} h`;
    }
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
    }
    if (!queue.length) return;

    let i = 0;
    let changed = false;
    const worker = async () => {
      while (i < queue.length) {
        const [g, kind] = queue[i++];
        const url = kind === 'cover'
          ? await api.thumb(g.coverUrl, 344, 'cover')
          : (g.heroUrl ? await api.thumb(g.heroUrl, 1400, 'hero') : null);
        if (url === '__reject__') { g._noHero = true; continue; }
        if (!url) continue;
        if (kind === 'cover') g._cover = url; else g._hero = url;
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
      img.src = url;
    });
  }

  // Cards are 2:3 like SteamGridDB's 600x900 grids, so anything that is not
  // 2:3 gets replaced with the real grid asset instead of being cropped.
  async function enrichArt({ force = false } = {}) {
    if (!api.sgdbAssets) return;
    const targets = state.games.filter((g) => g.name
      && (force || g.artVersion !== 3 || (!g.heroUrl && !g.heroTried)));
    if (!targets.length) return;

    const cachedUrl = async (kind, id) => {
      const res = await api.sgdbAssets({ kind, id }).catch(() => null);
      const best = res && res.ok ? res.data.items[0] : null;
      if (!best || !best.url) return null;
      const kindMap = { grids: 'cover', heroes: 'hero', logos: 'logo', icons: 'icon' };
      const cached = await api.sgdbCache({ url: best.url, kind: kindMap[kind] || 'art' }).catch(() => null);
      return cached && cached.ok ? cached.data : best.url;
    };

    let i = 0;
    let changed = false;
    const worker = async () => {
      while (i < targets.length) {
        const g = targets[i++];
        try {
          let id = g.sgdbId;
          if (!id) {
            const resolved = await api.sgdbResolve({ name: String(g.name), steamAppId: g.steamAppId }).catch(() => null);
            if (resolved && resolved.ok && resolved.data.match) id = resolved.data.match.id;
          }
          if (!id) { g.artVersion = 3; g.heroTried = true; saveGamesSoon(); continue; }

          const aspect = await imageAspect(g.coverUrl);
          const isWide = Math.abs(aspect - 2 / 3) <= 0.02;
          if (!isWide || !g.coverUrl) {
            const cover = await cachedUrl('grids', id);
            if (cover) { g.coverUrl = cover; changed = true; }
          }
          if (!g.heroUrl) {
            const hero = await cachedUrl('heroes', id);
            if (hero) { g.heroUrl = hero; changed = true; }
            g.heroTried = true;
          }
          if (!g.logoUrl) {
            const logo = await cachedUrl('logos', id);
            if (logo) { g.logoUrl = logo; changed = true; }
          }
          g.sgdbId = id;
          g.artVersion = 3;
          saveGamesSoon();
        } catch (_) {}
        await new Promise((r) => setTimeout(r, 150));
      }
    };
    await Promise.all([worker(), worker()]);
    persistGames();

    if (changed) {
      state._shelfKey = '';
      prepareThumbs();
      if (!state.selectedId) renderLibrary();
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
    api.saveGames(cleanGames()).catch(() => {});
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
    state._shelfKey = '';
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
    fadeIn(state.view === 'shelf' ? $('#shelf') : $('#library'));
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
        [{ opacity: 0, transform: 'translateY(10px)' }, { opacity: 1, transform: 'none' }],
        { duration: 320, delay: Math.min(i, 11) * 26, easing: 'cubic-bezier(.32,.72,0,1)', fill: 'backwards' }
      );
    });
  }

  function renderLibrary() {
    // While a game page is open the library must stay hidden; otherwise it
    // reappears stacked above the detail view.
    if (state.selectedId) {
      $('#shelf').hidden = true;
      $('#library').hidden = true;
      return;
    }
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

  function renderShelf() {
    const list = filteredGames();
    const stage = $('#shelf-stage');
    const strip = $('#shelf-strip');

    if (!list.length) {
      const firstRun = state.games.length === 0;
      stage.innerHTML = firstRun
        ? `<div class="onboard">
             <span class="onboard-kicker">GameVault</span>
             <h2>Your vault is empty</h2>
             <p>Bring your library in from Steam, scan a folder, or add one game by hand.</p>
             <div class="onboard-actions">
               <button class="btn btn-primary" data-onboard-import>Import games</button>
               <button class="btn" data-onboard-add>Add manually</button>
             </div>
             <p class="onboard-hint">Press <kbd>Ctrl K</kbd> any time to search or run a command.</p>
           </div>`
        : '<div class="shelf-empty">Nothing matches this filter.</div>';
      strip.innerHTML = '';
      shelfDom.built = false;
      state._shelfKey = '';
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
    if (key !== state._shelfKey) {
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
          tile.title = g.name;
          tile.innerHTML = `${(g._cover || g.coverUrl) ? `<img src="${esc(g._cover || g.coverUrl)}" loading="lazy" decoding="async" width="172" height="236" alt="" />` : coverFallbackMarkup()}<span class="shelf-tile-label">${esc(g.name)}</span>`;
          tile.onclick = () => { if (shelfDragMoved) return; selectShelfGame(tile.dataset.id); };
          tile.ondblclick = () => openDetail(tile.dataset.id);
        }
        tile.classList.toggle('is-active', id === state.shelfId);
        frag.appendChild(tile);
      }
      for (const leftover of existing.values()) leftover.remove();
      strip.appendChild(frag);
    } else {
      for (const tile of strip.querySelectorAll('.shelf-tile')) {
        tile.classList.toggle('is-active', tile.dataset.id === state.shelfId);
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
    state.shelfId = String(id);
    for (const tile of $('#shelf-strip').querySelectorAll('.shelf-tile')) {
      tile.classList.toggle('is-active', tile.dataset.id === state.shelfId);
    }
    const g = state.games.find((x) => String(x.id) === state.shelfId);
    if (g) { await preloadHero(heroUrlOf(g)); renderShelfStage(g); }
    revealShelfTile(state.shelfId);
  }

  // Critically-damped spring on scrollLeft. Retargetable, no fixed duration,
  // and it never fights the wheel because the wheel calls stopSpring first.
  function springTo(el, target) {
    const max = Math.max(0, el.scrollWidth - el.clientWidth);
    target = Math.max(0, Math.min(max, target));
    const st = el._spring || (el._spring = { x: el.scrollLeft, v: 0, raf: null, target });
    st.target = target;
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
        <div class="shelf-meta" data-meta></div>
        <div class="shelf-actions">
          <button class="btn btn-primary" data-play>
            <svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
            <span data-play-label>Play</span>
          </button>
          <button class="btn" data-open>Details</button>
          <button class="icon-btn banner-btn" data-banner title="Change banner">
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 3v6h-6"/></svg>
          </button>
        </div>
      </div>`;

    shelfDom.arts = stage.querySelectorAll('.shelf-art');
    shelfDom.posters = stage.querySelectorAll('.shelf-poster');
    shelfDom.title = stage.querySelector('[data-title]');
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
    stage.querySelector('[data-banner]').onclick = () => {
      const g = state.games.find((x) => String(x.id) === state.shelfId);
      if (g) cycleBanner(g);
    };
  }

  async function cycleBanner(g) {
    if (!api.sgdbAssets) return;
    if (!g._banners) {
      toast('Finding banners…', 'ok');
      let id = g.sgdbId;
      if (!id) {
        const resolved = await api.sgdbResolve({ name: String(g.name), steamAppId: g.steamAppId }).catch(() => null);
        if (resolved && resolved.ok && resolved.data.match) id = resolved.data.match.id;
      }
      if (!id) { toast('No SteamGridDB match', 'error'); return; }
      g._sgdbId = id;
      const res = await api.sgdbAssets({ kind: 'heroes', id }).catch(() => null);
      g._banners = res && res.ok ? res.data.items.map((item) => item.url) : [];
      g._bannerIdx = -1;
    }
    if (!g._banners.length) { toast('No other banners found', 'error'); return; }

    g._bannerIdx = ((g._bannerIdx || 0) + 1) % g._banners.length;
    const remote = g._banners[g._bannerIdx];
    const cached = await api.sgdbCache({ url: remote, kind: 'hero' }).catch(() => null);
    g.heroUrl = cached && cached.ok ? cached.data : remote;
    g._noHero = false;
    const thumb = await api.thumb(g.heroUrl, 1400, 'hero');
    if (thumb && thumb !== '__reject__') g._hero = thumb;
    else { g._hero = null; g._noHero = true; }
    persistGames();
    renderShelfStage(g);
    toast('Banner changed', 'ok');
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
      artBack.style.backgroundImage = art ? `url('${art}')` : '';
      artBack.classList.toggle('is-fallback', !heroArt && !!art);
      posterBack.style.backgroundImage = posterSrc ? `url('${posterSrc}')` : '';
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
          [{ opacity: 0, transform: 'translateY(10px)' }, { opacity: 1, transform: 'none' }],
          { duration: 360, easing: 'cubic-bezier(.32,.72,0,1)' }
        );
      }
    }

    shelfDom.kicker.textContent = `${running ? 'Now playing' : statusLabel(g)} · ${fmtHours(running ? (g.hours || 0) + live / 60 : g.hours)}`;
    shelfDom.title.textContent = g.name || '';
    shelfDom.meta.innerHTML = [
      g.source ? `<span>${esc(g.source)}</span>` : '',
      `<span>${(g.sessions || []).length} sessions</span>`,
      g.lastPlayed ? `<span>played ${fmtDate(g.lastPlayed)}</span>` : '',
    ].filter(Boolean).join('<span class="card-dot">•</span>');

    shelfDom.playLabel.textContent = running ? 'Stop' : 'Play';
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

  function buildCard(g, index = 0) {
    const el = document.createElement('article');
    el.className = 'card';
    el.dataset.id = String(g.id);
    el.tabIndex = 0;

    const media = document.createElement('div');
    media.className = 'card-media';

    if (g.coverUrl) {
      const img = document.createElement('img');
      img.className = 'card-img';
      img.loading = index < 12 ? 'eager' : 'lazy';
      img.decoding = 'async';
      img.alt = '';
      img.src = g.coverUrl;
      img.addEventListener('load', () => img.classList.add('is-loaded'), { once: true });
      img.addEventListener('error', () => {
        img.remove();
        media.insertAdjacentHTML('afterbegin', coverFallbackMarkup());
      }, { once: true });
      media.appendChild(img);
    } else {
      media.insertAdjacentHTML('afterbegin', coverFallbackMarkup());
    }

    const shade = document.createElement('div');
    shade.className = 'card-shade';
    media.appendChild(shade);

    const status = document.createElement('span');
    status.className = 'card-status';
    status.dataset.status = statusLabel(g);
    status.textContent = statusLabel(g);
    media.appendChild(status);

    if (g.rating > 0) {
      const rating = document.createElement('span');
      rating.className = 'card-rating';
      rating.textContent = Number(g.rating).toFixed(1).replace(/\.0$/, '');
      media.appendChild(rating);
    }

    const play = document.createElement('button');
    play.className = 'card-play';
    play.title = 'Launch';
    play.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
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
    if (g.source) {
      const dot = document.createElement('span');
      dot.className = 'card-dot';
      dot.textContent = '•';
      const src = document.createElement('span');
      src.className = 'card-source';
      src.textContent = g.source;
      meta.appendChild(dot);
      meta.appendChild(src);
    }
    body.appendChild(meta);

    el.append(media, body);

    const refs = { el, img: media.querySelector('.card-img'), hours, status, play, title };

    play.addEventListener('click', (e) => { e.stopPropagation(); togglePlay(g.id); });
    el.addEventListener('click', () => openDetail(g.id));
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(g.id); }
    });
    el.addEventListener('dblclick', () => togglePlay(g.id));

    return refs;
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

    for (const g of state.games) {
      const id = String(g.id);
      const ref = cards.get(id);
      if (!ref) continue;
      const show = visible.has(id);
      ref.el.hidden = !show;
      if (show) updateCard(g);
    }

    const order = list.map((g) => String(g.id)).join(',');
    if (rebuild || state._lastOrder !== order) {
      for (const g of list) grid.appendChild(cards.get(String(g.id)).el);
      state._lastOrder = order;
    }

    const empty = $('#empty');
    const hasAny = state.games.length > 0;
    empty.hidden = list.length > 0;
    if (!list.length) {
      $('#empty-title').textContent = hasAny ? 'No matches' : 'Your vault is empty';
      $('#empty-sub').textContent = hasAny
        ? 'Try a different filter or search term.'
        : 'Import a Steam library, scan Lutris, or add a game by hand.';
      $('#empty-cta').style.display = hasAny ? 'none' : '';
    }

    refreshCounts();
  }

  function updateCard(g) {
    const id = String(g.id);
    const ref = cards.get(id);
    if (!ref) return;
    const live = state.live[id];
    const running = typeof live === 'number';
    const launching = live === 'launching';

    ref.title.textContent = g.name || 'Untitled';
    ref.el.classList.toggle('is-running', running || launching);

    const base = Number(g.hours) || 0;
    const total = running ? base + live / 60 : base;
    ref.hours.textContent = fmtHours(total);

    ref.status.textContent = running ? 'Running' : statusLabel(g);
    ref.status.dataset.status = running ? 'Playing' : statusLabel(g);

    ref.play.title = running ? 'Stop' : launching ? 'Launching…' : 'Launch';
    ref.play.innerHTML = running
      ? '<svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>'
      : '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';

    if (state.selectedId === id) updateDetailLive(g);
  }

  // ---------------------------------------------------------------------------
  // Hero
  // ---------------------------------------------------------------------------

  // ---------------------------------------------------------------------------
  // Detail panel
  // ---------------------------------------------------------------------------

  function openDetail(id) {
    window.__gvPerfMark && window.__gvPerfMark('detail');
    const active = document.activeElement;
    state._focusReturn = (active && active.id === 'cmd-input') ? null : active;
    state.selectedId = String(id);
    renderDetail();
    $('#topbar').hidden = false;
    const fb = $('#filterbar'); if (fb) fb.hidden = true;
    $('#library').hidden = true;
    $('#shelf').hidden = true;
    const dock = document.querySelector('.bottombar');
    if (dock) dock.hidden = true;
    const view = $('#game-view');
    view.hidden = false;
    view.scrollTop = 0;
    view.querySelector('.gvx-hero-body')?.focus({ preventScroll: true });
    fadeIn(view);
    document.title = `${state.games.find((g) => String(g.id) === String(id))?.name || 'GameVault'} — GameVault`;
  }

  function closeDetail() {
    stopDetailTick();
    state.selectedId = null;
    const view = $('#game-view');
    view.hidden = true;
    view.innerHTML = '';
    $('#topbar').hidden = false;
    const fb = $('#filterbar'); if (fb) fb.hidden = false;
    const dock = document.querySelector('.bottombar');
    if (dock) dock.hidden = false;
    renderLibrary();
    fadeIn(state.view === 'shelf' ? $('#shelf') : $('#library'));
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
    const total = (g.hours || 0) + (running ? live / 60 : 0);
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
    if (Number(g.rating) > 0) parts.push(`<span class="gvx-rating">★ ${Number(g.rating).toFixed(1).replace(/\.0$/, '')}</span>`);
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

  function railHasData(g) {
    const meta = g.steamMeta || {};
    return true;
    return !!((meta.metacritic && meta.metacritic.score) || Number(g.timeToBeat) > 0
      || (meta.recommended && meta.recommended.length) || (meta.minimum && meta.minimum.length));
  }

  function railHtml(g) {
    const meta = g.steamMeta || {};
    const pulse = [];
    if (meta.metacritic && meta.metacritic.score) pulse.push([String(meta.metacritic.score), 'Metacritic']);
    if (Number(g.timeToBeat) > 0) pulse.push([`~${Math.round(Number(g.timeToBeat))}h`, 'To beat']);
    if (Number(g.rating) > 0) pulse.push([Number(g.rating).toFixed(1).replace(/\.0$/, ''), 'Your rating']);

    const KEEP = ['OS', 'Processor', 'Memory', 'Graphics', 'Storage'];
    const specs = ((meta.recommended && meta.recommended.length)
      ? meta.recommended
      : (meta.minimum && meta.minimum.length ? meta.minimum : []))
      .filter(([key]) => KEEP.includes(key));

    const facts = [];
    const liveMins = state.live[String(g.id)];
    const liveHours = typeof liveMins === 'number' ? liveMins / 60 : 0;
    const totalHours = (g.hours || 0) + liveHours;
    facts.push(['Playtime', totalHours > 0 ? fmtHours(totalHours) : '—']);
    facts.push(['Sessions', String(gvSessions(g).length)]);
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
    if (rail) rail.innerHTML = railHtml(g);
  }

  async function loadSteamMeta(g) {
    if (!g.steamAppId || !api.steamDetails) return;
    const fresh = g.steamMeta && g.steamMeta.version === 2 && g.steamMeta.at && (Date.now() - g.steamMeta.at < 14 * 86400000);
    if (fresh) return;
    const res = await api.steamDetails(g.steamAppId).catch(() => null);
    if (!res || !res.ok || !res.data) return;
    const hadRail = railHasData(g);
    g.steamMeta = { ...res.data, version: 2, at: Date.now() };
    saveGamesSoon();
    if (state.selectedId !== String(g.id)) return;
    if (!hadRail && railHasData(g)) renderDetail();
    else paintRail(g);
  }

  const heroDecodes = new Map();
  function preloadHero(url) {
    if (!url) return Promise.resolve();
    if (heroDecodes.has(url)) return heroDecodes.get(url);
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
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
        [{ opacity: 0, transform: 'translateY(14px)' }, { opacity: 1, transform: 'none' }],
        { duration: 420, easing: 'cubic-bezier(.32,.72,0,1)' }
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
    const logo = g.logoUrl || '';

    view.innerHTML = `
      <div class="gvx-hero">
        ${hero ? `<img class="gvx-hero-art" src="${esc(hero)}" alt="" />` : '<div class="gvx-hero-art is-empty"></div>'}
        <div class="gvx-scrim"></div>
        <div class="gvx-hero-inner">
        <div class="gvx-top">
          <button class="gvx-chip" data-back>
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg>
            Library
          </button>
          <div class="gvx-top-right">
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
              </div>
            </div>
          </div>
        </div>

        <div class="gvx-hero-body" tabindex="-1" aria-label="${esc(g.name)}">
          ${logo
            ? `<img class="gvx-logo" src="${esc(logo)}" alt="${esc(g.name)}" />`
            : `<h1 class="gvx-title">${esc(g.name)}</h1>`}
          <div class="gvx-meta">${detailMeta(g)}</div>
          <div class="gvx-play-row">
            ${wish
              ? `<button class="gvx-play" data-move><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg> Move to library</button>`
              : `<button class="gvx-play${typeof state.live[String(g.id)] === 'number' ? ' is-live' : ''}" data-play>
                   <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">${typeof state.live[String(g.id)] === 'number' ? '<rect x="6" y="6" width="12" height="12" rx="2"/>' : '<path d="M8 5v14l11-7z"/>'}</svg>
                   <span data-play-label>${typeof state.live[String(g.id)] === 'number' ? 'Stop' : 'Play'}</span>
                 </button>
                 <div class="gvx-timer" data-timer role="timer" aria-live="off">${detailTimerHtml(g)}</div>
                 <button class="gvx-finish${status === 'Finished' ? ' is-done' : ''}" data-finish aria-pressed="${status === 'Finished'}" title="${status === 'Finished' ? 'Finished — click to unmark' : 'Mark this game as finished'}">
                   <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12.5 4.5 4.5L19 7"/></svg>
                   <span>${status === 'Finished' ? 'Finished' : 'Mark as finished'}</span>
                 </button>`}
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
              <span>SESSIONS</span>
              <span class="gvx-ledger-count">${stats.count} session${stats.count === 1 ? '' : 's'}</span>
            </div>
            <div class="gvx-list" data-ledger role="list" aria-label="Session history"></div>
          </div>
          <aside class="gvx-rail" data-rail>${railHtml(g)}</aside>
        `}
      </div>
    `;
    animateDetailIn(view, g);

    const heroImg = view.querySelector('.gvx-hero-art');
    if (heroImg && heroImg.tagName === 'IMG') heroImg.addEventListener('error', () => heroImg.classList.add('is-empty'));
    const logoImg = view.querySelector('.gvx-logo');
    if (logoImg) logoImg.addEventListener('error', () => { logoImg.remove(); view.querySelector('.gvx-hero-body').insertAdjacentHTML('afterbegin', `<h1 class="gvx-title">${esc(g.name)}</h1>`); });

    if (!wish) paintLedger(g);
    wireDetail(g, wish);
    startDetailTick(g);
    if (!wish) loadSteamMeta(g);
  }

  function paintLedger(g) {
    const listEl = document.querySelector('[data-ledger]');
    if (!listEl) return;
    const sessions = gvSessions(g);
    const live = state.live[String(g.id)];
    const running = typeof live === 'number';
    const groups = Sessions.groupSessions(sessions);
    const MAX_ROWS = 100;

    const rows = [];
    if (running) {
      const started = state.liveStart && state.liveStart[String(g.id)];
      rows.push(`<div class="gvx-row is-live" role="listitem">
        <span class="gvx-row-when"><b>Now</b>${started ? ` · started ${hhmm(started)}` : ''}</span>
        <span class="gvx-row-dur" data-live-dur>${Sessions.formatClock(live * 60000)}</span>
      </div>`);
    }

    let rendered = 0;
    for (const group of groups) {
      if (rendered >= MAX_ROWS) break;
      rows.push(`<div class="gvx-month">${group.label}</div>`);
      for (const s of group.items) {
        if (rendered >= MAX_ROWS) break;
        rows.push(`<div class="gvx-row" role="listitem">
          <span class="gvx-row-when"><b>${s.dayLabel}</b> · ${s.startLabel}${s.end ? ` – ${hhmm(s.end)}` : ''}${s.crossesMidnight ? ' +1' : ''}</span>
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
      listEl.innerHTML = `<div class="gvx-empty"><b>No sessions yet</b><span>Press Play. Your first session is saved when you stop.</span></div>`;
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
      if (!valueEl) { stopDetailTick(); return; }
      const elapsed = Math.max(0, Date.now() - state.liveStart[String(g.id)]);
      valueEl.textContent = Sessions.formatClock(elapsed);
      if (liveDur) liveDur.textContent = Sessions.formatClock(elapsed);
    };
    paint();
    if (state.tier === 'lite') return;
    detailTick = setInterval(paint, 1000);
  }

  function updateDetailLive(g) {
    const view = $('#game-view');
    if (!view || view.hidden) return;
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
      playBtn.disabled = busy;
      const label = playBtn.querySelector('[data-play-label]');
      if (label) label.textContent = busy ? (live === 'launching' ? 'Launching…' : 'Stopping…') : running ? 'Stop' : 'Play';
      const icon = playBtn.querySelector('svg');
      if (icon && !busy) icon.innerHTML = running ? '<rect x="6" y="6" width="12" height="12" rx="2"/>' : '<path d="M8 5v14l11-7z"/>';
    }
    const liveValue = view.querySelector('[data-timer-value]');
    if (liveValue && typeof state.live[String(g.id)] === 'number') {
      liveValue.textContent = Sessions.formatClock(state.live[String(g.id)] * 60000);
    }
  }

  function setFinished(g, value) {
    g.status = value ? 'Finished' : 'Playing';
    if (value) g.wishlisted = false;
    saveGamesSoon();
    state._shelfKey = '';
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
    g.wishlisted = !gvIsWishlisted(g);
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
        else if (item.hasAttribute('data-refresh')) { refreshArt(g, { focus: false }); toast('Artwork refreshed', 'ok'); }
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
  }

  // ---------------------------------------------------------------------------
  // Modals
  // ---------------------------------------------------------------------------

  let modalSeq = 0;

  function openModal(html, { className = '' } = {}) {
    const wrap = $('#modal');
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
      const target = card.querySelector('[autofocus], input, select, textarea, button, [href]');
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

  const pillSpring = { y: 0, v: 0, target: 0, raf: null, init: false };

  // Distance- and velocity-driven spring: longer jumps bounce harder.
  function syncSidePill() {
    const pill = document.querySelector('.side-pill');
    const side = document.querySelector('.sidebar');
    const active = side && side.querySelector('.side-item.is-active');
    if (!pill || !side || !active) return;
    const s = side.getBoundingClientRect();
    const r = active.getBoundingClientRect();
    const target = r.top - s.top;
    pill.style.height = `${Math.round(r.height)}px`;

    if (!pillSpring.init || prefersReducedMotion()) {
      pillSpring.init = true;
      pillSpring.y = target; pillSpring.v = 0; pillSpring.target = target;
      pill.style.transform = `translateY(${target}px)`;
      return;
    }

    pillSpring.target = target;
    if (pillSpring.raf) return;

    let last = performance.now();
    const step = (now) => {
      const dt = Math.min(32, now - last) / 1000;
      last = now;
      const k = 360;   // stiffness
      const c = 19;    // damping (ζ ≈ 0.50 → one clean bounce)
      const a = -k * (pillSpring.y - pillSpring.target) - c * pillSpring.v;
      pillSpring.v += a * dt;
      pillSpring.y += pillSpring.v * dt;
      pill.style.transform = `translateY(${pillSpring.y.toFixed(2)}px)`;
      if (Math.abs(pillSpring.v) < 0.4 && Math.abs(pillSpring.y - pillSpring.target) < 0.35) {
        pill.style.transform = `translateY(${pillSpring.target}px)`;
        pillSpring.y = pillSpring.target;
        pillSpring.v = 0;
        pillSpring.raf = null;
      } else {
        pillSpring.raf = requestAnimationFrame(step);
      }
    };
    pillSpring.raf = requestAnimationFrame(step);
  }

  function openGameModal(game) {
    const isNew = !game;
    const g = game || { name: '', exePath: '', coverUrl: '', notes: '', status: 'Playing' };

    const card = openModal(`
      <div class="modal-head">
        <h2>${isNew ? 'Add a game' : 'Edit game'}</h2>
        <button class="close-x" data-close aria-label="Close">✕</button>
      </div>
      <div class="modal-body">
        <div class="field">
          <label for="f-name">Title</label>
          <div class="combo">
            <input class="input" id="f-name" value="${esc(g.name)}" placeholder="Start typing a game name"
                   autocomplete="off" spellcheck="false" role="combobox" aria-expanded="false" aria-controls="f-name-list" />
            <div id="f-name-list" class="combo-menu" role="listbox" hidden></div>
          </div>
          <div class="hint">Pick a SteamGridDB match and artwork fills itself.</div>
        </div>
        <div class="field">
          <label for="f-exe">Executable</label>
          <div class="field-row">
            <input class="input" id="f-exe" value="${esc(g.exePath || '')}" placeholder="/games/.../game.exe" />
            <button class="btn btn-ghost" data-browse style="flex:0 0 auto">Browse</button>
          </div>
          <div class="hint">Linux: any ELF binary or Windows .exe (runs through Wine/Proton).</div>
        </div>
        <div class="field">
          <label for="f-steam">Steam AppID</label>
          <input class="input" id="f-steam" value="${esc(g.steamAppId || '')}" placeholder="1245620 — unlocks critic score and specs" />
        </div>
        <div class="field">
          <label for="f-ttb">Time to beat (hours)</label>
          <input class="input" id="f-ttb" type="number" min="0" step="0.5" value="${g.timeToBeat || ''}" placeholder="How long a full playthrough takes" />
        </div>

        <div class="field">
          <div class="art-summary-head">
            <label>Artwork</label>
            <span id="art-status" class="art-status">Not set</span>
          </div>
          <div class="art-summary" id="art-summary">
            <button type="button" class="art-mini cover" data-slot="cover" title="Cover"></button>
            <button type="button" class="art-mini hero" data-slot="hero" title="Banner"></button>
            <button type="button" class="art-mini logo" data-slot="logo" title="Logo"></button>
            <button type="button" class="art-mini icon" data-slot="icon" title="Icon"></button>
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
        </div>
        <div class="field">
          <label>Progress</label>
          <label class="gv-check">
            <input type="checkbox" data-finished-edit ${gvStatusOf(g) === 'Finished' ? 'checked' : ''} />
            <span>Finished</span>
          </label>
        </div>
        <div class="field">
          <label>Wishlist</label>
          <div class="field-row" style="align-items:center">
            <span class="hint" style="flex:1">Not in your library yet — no play tracking</span>
            <input type="checkbox" data-wish-edit ${gvIsWishlisted(g) ? 'checked' : ''} />
          </div>
        </div>
        <div class="field">
          <label for="f-notes">Notes</label>
          <textarea class="input" id="f-notes" style="height:70px;padding-top:9px" placeholder="Optional">${esc(g.notes || '')}</textarea>
        </div>
      </div>
      <div class="modal-foot">
        <button class="btn btn-ghost" data-close>Cancel</button>
        <button class="btn btn-primary" data-save>${isNew ? 'Add game' : 'Save'}</button>
      </div>
    `, { className: 'game-modal' });

    let chosen = g.sgdbId ? { id: g.sgdbId, name: g.name } : null;

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

    function slotInput(slot) {
      return card.querySelector({ cover: '#f-cover', hero: '#f-hero', logo: '#f-logo', icon: '#f-icon' }[slot]);
    }

    function renderStrip() {
      for (const el of card.querySelectorAll('[data-slot]')) {
        const slot = el.dataset.slot;
        el.style.backgroundImage = art[slot] ? `url('${art[slot]}')` : '';
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

    function closeCombo() {
      comboMenu.hidden = true;
      nameInput.setAttribute('aria-expanded', 'false');
      comboIndex = -1;
    }

    function renderCombo(groups) {
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
        comboMenu.innerHTML = '<div class="combo-empty">No match</div>';
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
      const q = query.trim();
      if (q.length < 2) { closeCombo(); return; }

      const localHits = window.Fuzzy.bestMatch(q, state.games.filter((x) => x.id !== g.id), (x) => x.name, { limit: 4 })
        .all.map((entry) => ({
          kind: 'local', name: entry.item.name, meta: 'In your library', game: entry.item,
        }));

      let sgdbHits = [];
      if (api.sgdbGames) {
        const res = await api.sgdbGames(q).catch(() => null);
        if (res && res.ok) {
          sgdbHits = res.data.slice(0, 6).map((hit) => ({
            kind: 'sgdb', id: hit.id, name: hit.name,
            meta: hit.releaseDate ? String(hit.releaseDate).slice(0, 4) : 'SteamGridDB',
          }));
        }
      }

      renderCombo([
        { title: 'In your library', items: localHits },
        { title: 'SteamGridDB', items: sgdbHits },
      ]);
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

    nameInput.addEventListener('blur', () => setTimeout(closeCombo, 150));

    // ---- artwork autofill ---------------------------------------------
    async function autofill(id, name) {
      if (!api.sgdbAutofill) return;
      if (artStatus) artStatus.textContent = 'Fetching artwork…';
      const res = await api.sgdbAutofill({ id, name }).catch(() => null);
      if (!res || !res.ok) {
        if (artStatus) {
          artStatus.textContent = res && res.error && res.error.code === 'NO_KEY'
            ? 'Add a SteamGridDB key in Settings'
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
    function renderArtGrid(append) {
      const tab = art.tab;
      const items = art.items[tab];
      if (!items.length) {
        artResults.innerHTML = '<div class="art-empty">No artwork found.</div>';
        artMore.hidden = true;
        return;
      }
      const html = items.map((asset) => `
        <button type="button" class="sg-thumb ${tab}" data-url="${esc(asset.url)}">
          <img src="${esc(asset.thumb || asset.url)}" alt="" loading="lazy" decoding="async" />
        </button>`).join('');

      let container = artResults.querySelector('.art-grid');
      if (append && container) {
        container.insertAdjacentHTML('beforeend', html);
      } else {
        artResults.innerHTML = `<div class="art-grid ${tab}">${html}</div>`;
        container = artResults.querySelector('.art-grid');
      }
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
      if (!chosen || !chosen.id) {
        artResults.innerHTML = '<div class="art-empty">Search for the game above first.</div>';
        return;
      }
      artResults.innerHTML = '<div class="art-empty">Loading…</div>';
      const res = await api.sgdbAssets({ kind: KIND[slot], id: chosen.id, page, styles: art.style ? [art.style] : undefined }).catch(() => null);
      if (!res || !res.ok) {
        artResults.innerHTML = `<div class="art-empty">${res && res.error ? esc(res.error.message) : 'Could not load artwork'}</div>`;
        return;
      }
      const list = (res.data.items || []).map((item) => ({ url: item.url, thumb: item.thumb, id: item.id }));
      art.hasMore = !!res.data.hasMore;
      art.items[slot] = append ? art.items[slot].concat(list.filter((n) => !art.items[slot].some((o) => o.url === n.url))) : list;
      art.page[slot] = page;
      renderArtGrid(append);
      if (!append) artPanel.scrollIntoView({ block: 'start' });
    }

    function setTab(slot) {
      art.tab = slot;
      for (const t of card.querySelectorAll('[data-arttab]')) t.classList.toggle('is-active', t.dataset.arttab === slot);
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
      for (const t of card.querySelectorAll('[data-arttab]')) {
        t.classList.toggle('is-active', t.dataset.arttab === art.tab);
      }
      art.expanded = true;
      artPanel.hidden = false;
      if (expand) expand.textContent = 'Hide artwork';
      if (artMatch && !artMatch.textContent) {
        artMatch.textContent = `Matched: ${(chosen && chosen.name) || g.name || nameInput.value}`;
      }
      artPanel.scrollIntoView({ block: 'start' });

      // Editing a game that never matched: resolve it on demand.
      if (!chosen || !chosen.id) {
        const name = (nameInput.value || g.name || '').trim();
        if (name) {
          await autofill(null, name);
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

    let finished = gvStatusOf(g) === 'Finished';
    let wishlisted = gvIsWishlisted(g);
    const finishedToggle = card.querySelector('[data-finished-edit]');
    if (finishedToggle) finishedToggle.onchange = () => { finished = finishedToggle.checked; };

    const wishToggle = card.querySelector('[data-wish-edit]');
    if (wishToggle) wishToggle.onchange = () => { wishlisted = wishToggle.checked; };

    card.querySelector('[data-browse]').onclick = async () => {
      const file = await api.pickExe();
      if (file) card.querySelector('#f-exe').value = file;
    };

    for (const btn of card.querySelectorAll('[data-close]')) btn.onclick = closeModal;

    let saving = false;
    const saveBtnEl = card.querySelector('[data-save]');
    saveBtnEl.onclick = async () => {
      if (saving) return;
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
      const timeToBeat = Number(card.querySelector('#f-ttb').value) || null;

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

      if (!card.isConnected) return;

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
          timeToBeat,
          artVersion: 2,
          notes,
          status: finished ? 'Finished' : 'Playing',
          wishlisted,
          hours: 0,
          sessions: [],
          added: Date.now(),
          source: 'Manual',
        });
      } else {
        Object.assign(g, {
          name, exePath, coverUrl: coverLocal, heroUrl: heroLocal, logoUrl: logoLocal, iconUrl: iconLocal, notes, status: finished ? 'Finished' : (g.status === 'Finished' ? 'Playing' : (g.status || 'Playing')), wishlisted,
          sgdbId: chosen ? chosen.id : (g.sgdbId || null),
          steamAppId,
          timeToBeat,
          artVersion: 2,
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

    const keyOf = (c) => c.sourceId || (c.exePath ? 'exe:' + c.exePath.toLowerCase() : 'name:' + String(c.name || '').toLowerCase());
    const existingFor = (c) => state.games.find((g) => keyOf(g) === keyOf(c))
      || (c.exePath && state.games.find((g) => g.exePath && g.exePath.toLowerCase() === c.exePath.toLowerCase()));
    const isNew = (c) => !existingFor(c);
    const picked = () => candidates.filter((c) => c._checked && isNew(c));
    const labelOf = (id) => (sources.find((s) => s.id === id) || {}).label || id;

    let steamUser = null;

    const loadOwned = (games) => {
      scanSeq += 1;
      busy = false;
      scanError = null;
      pickedNothing = false;
      candidates = (games || []).map((g) => ({ ...g, _checked: true }));
      activeId = 'steam-owned';
      inReview = true;
      optionsStep.hidden = true;
      reviewStep.hidden = false;
      reviewTitle.textContent = 'Steam account';
      paintReview();
      paintSummary();
    };

    const paintAccount = async () => {
      const hasKey = !!state.config.steamKey;
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
          loadOwned(d.owned);
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
        state.config.steamKey = key;
        state.config.steamId = steamUser ? steamUser.steamId : state.config.steamId;
        await api.saveConfig(state.config).catch(() => null);
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
      if (c.source) bits.push(c.source);
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
      listEl.innerHTML = candidates.map((c, idx) => {
        const exists = !isNew(c);
        if (exists) {
          return `<div class="imp3-item is-owned" role="listitem" aria-label="${esc(c.name)} — already in your library">
            <span class="import-row-check" aria-hidden="true">✓</span>
            <span class="import-row-main"><span class="import-row-name">${esc(c.name)}</span><span class="import-row-meta">${esc(metaFor(c))}</span></span>
            <button class="import-update" data-update="${idx}" aria-label="Update art for ${esc(c.name)}">Update art</button>
          </div>`;
        }
        return `<label class="imp3-item" role="listitem">
          <input type="checkbox" data-idx="${idx}" aria-label="${esc(c.name)}, new" ${c._checked ? 'checked' : ''} />
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
            [{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'none' }],
            { duration: 300, delay: i * 18, easing: 'cubic-bezier(.32,.72,0,1)', fill: 'backwards' }
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
        candidates = (found || []).filter((c) => c && c.name).map((c) => ({ ...c, _checked: true }));
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
          wishlisted: false,
          notes: '',
          added: Date.now(),
          iconUrl: c.iconPath ? fileUrl(c.iconPath) : null,
        });
      }
      saveGamesSoon();
      closeModal();
      state._shelfKey = '';
      renderLibrary();
      toast(`Imported ${total} game${total === 1 ? '' : 's'} · fetching artwork`, 'ok');
      enrichArt().catch(() => {});
    };

    (async () => {
      sources = await (api.importSources ? api.importSources().catch(() => []) : Promise.resolve([]));
      syncPick();
      paintSummary();
      paintAccount();
    })();
  }

  async function openSettingsModal() {
    const version = await api.getAppVersion().catch(() => '2.0.0-experimental');
    const info = await (api.getPlatformInfo ? api.getPlatformInfo().catch(() => ({})) : Promise.resolve({}));
    const startupOn = await api.getStartup().catch(() => false);

    const card = openModal(`
      <div class="modal-head">
        <h2>Settings</h2>
        <button class="close-x" data-close aria-label="Close">✕</button>
      </div>
      <div class="modal-body">
        <div class="field">
          <label>Palette</label>
          <div class="pills" data-palette-group>
            ${PALETTES.map((p) => `
              <button class="pill ${state.palette === p ? 'is-active' : ''}" data-palette-opt="${p}">${p}</button>`).join('')}
          </div>
          <div class="hint">Midnight: near-black &amp; electric blue. Paper: light canvas &amp; vermilion.</div>
        </div>

        <div class="field">
          <label>Visual quality</label>
          <div class="pills" data-tier-group>
            ${['cinematic', 'standard', 'lite'].map((t) => `
              <button class="pill ${state.tier === t ? 'is-active' : ''}" data-tier="${t}">${t}</button>`).join('')}
          </div>
          <div class="hint">Cinematic enables the animated background. Lite disables blur and motion — best on low-end machines.</div>
        </div>

        <div class="field">
          <label>SteamGridDB</label>
          <div class="field-row">
            <input class="input" id="s-sgdb" type="password" placeholder="API key" autocomplete="off" />
            <button class="btn btn-ghost" type="button" data-sgdb-save style="flex:0 0 auto">Save</button>
            <button class="btn btn-ghost" type="button" data-sgdb-test style="flex:0 0 auto">Test</button>
          </div>
          <div class="hint" id="s-sgdb-hint">Covers, banners, logos and icons. Get a key from steamgriddb.com → Preferences → API.</div>
          <button class="btn btn-ghost" type="button" data-art-refresh style="margin-top:8px">Refresh all artwork</button>
        </div>

        <div class="field">
          <label>Steam account</label>
          <div class="field-row">
            <input class="input" id="s-steam-key" type="password" placeholder="Steam Web API key" autocomplete="off" />
            <button class="btn btn-ghost" type="button" data-steam-save style="flex:0 0 auto">Save</button>
            <button class="btn btn-ghost" type="button" data-steam-test style="flex:0 0 auto">Test</button>
          </div>
          <div class="hint" id="s-steam-hint">Checking your Steam login…</div>
          <div class="hint">Owned games, not just installed. Key: steamcommunity.com/dev/apikey · requires “Game details” set to public.</div>
        </div>

        <div class="field">
          <label>On login</label>
          <div class="field-row" style="align-items:center">
            <span class="hint" style="flex:1">Start GameVault when I log in</span>
            <input type="checkbox" data-autostart ${startupOn ? 'checked' : ''} />
          </div>
        </div>

        ${info.wayland ? `
          <div class="field">
            <label>Overlay shortcut</label>
            <div class="hint">Wayland blocks global hotkeys. Bind it in your compositor:<br />
              <code style="color:var(--accent-2)">bind = SUPER, G, exec, gamevault --toggle-overlay</code>
            </div>
          </div>` : ''}

        <div class="section-label">Performance</div>
        <div class="field">
          <label>Frame rate</label>
          <div class="field-row" style="align-items:center">
            <span class="hint" id="s-perf" style="flex:1">measuring…</span>
            <button class="btn btn-ghost" type="button" data-perf-copy>Copy report</button>
            <button class="btn btn-ghost" type="button" data-perf-reveal>Reveal log</button>
          </div>
          <div class="hint" id="s-perf-gpu">GPU: checking…</div>
          <div class="field-row" style="align-items:center;margin-top:6px">
            <button class="btn" type="button" data-perf-bench>Run 20s benchmark</button>
            <span class="hint" style="flex:1">Don't touch the window until it says done</span>
          </div>
          <div class="hint" id="s-perf-path">Stats are written every second to perf.log</div>
        </div>

        <div class="section-label">About</div>
        <div class="hint">
          GameVault <b>${esc(version)}</b> — experimental build<br />
          ${esc(info.protonPath ? `Proton: ${info.protonPath}` : 'Proton: not found')}
        </div>
      </div>
      <div class="modal-foot">
        <button class="btn btn-ghost" data-close>Done</button>
      </div>
    `);

    for (const btn of card.querySelectorAll('[data-close]')) btn.onclick = closeModal;

    for (const pill of card.querySelectorAll('[data-palette-opt]')) {
      pill.onclick = () => {
        applyPalette(pill.dataset.paletteOpt, { announce: true });
        for (const p of card.querySelectorAll('[data-palette-opt]')) p.classList.toggle('is-active', p === pill);
      };
    }

    const perfEl = card.querySelector('#s-perf');
    const perfGpuEl = card.querySelector('#s-perf-gpu');
    let gpuInfo = {};
    if (api.gpuStatus) gpuInfo = await api.gpuStatus().catch(() => ({}));
    if (perfGpuEl) perfGpuEl.textContent = `GPU compositing: ${(gpuInfo && gpuInfo.gpu_compositing) || 'unknown'}`;
    if (perfEl) {
      let frames = 0;
      const t0 = performance.now();
      const beat = (now) => {
        frames += 1;
        if (now - t0 < 1000) { requestAnimationFrame(beat); return; }
        const fps = Math.max(1, Math.round((frames * 1000) / (now - t0)));
        perfEl.textContent = `${fps} fps · ${(1000 / fps).toFixed(1)} ms/frame · tier ${state.tier}`;
      };
      requestAnimationFrame(beat);
    }
    const perfPathEl = card.querySelector('#s-perf-path');
    if (perfPathEl && api.perfPath) api.perfPath().then((p) => { perfPathEl.textContent = `Log: ${p}`; }).catch(() => {});
    const benchBtn = card.querySelector('[data-perf-bench]');
    if (benchBtn) benchBtn.onclick = async () => {
      closeModal();
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const mark = (m) => { if (window.__gvPerfMark) window.__gvPerfMark(m); };
      await wait(600);
      for (const f of ['Playing', 'Finished', 'Want', 'All']) { mark('bench:filter:' + f); setFilter(f); await wait(900); }
      mark('bench:sidebar'); $('#side-toggle').click(); await wait(700);
      mark('bench:sidebar'); $('#side-toggle').click(); await wait(700);
      mark('bench:grid'); $('#btn-view').click(); await wait(800);
      mark('bench:scroll');
      const lib = $('#library');
      for (let i = 0; i < 12; i++) { lib.scrollTop += 140; await wait(60); }
      mark('bench:detail'); if (state.games[0]) openDetail(state.games[0].id); await wait(1000);
      mark('bench:back'); if (state.selectedId) closeDetail(); await wait(500);
      if (api.perfLog) api.perfLog({ t: Date.now(), benchmark: 'done', tier: state.tier });
      toast('Benchmark finished — perf.log updated', 'ok');
    };

    const perfReveal = card.querySelector('[data-perf-reveal]');
    if (perfReveal && api.perfReveal) perfReveal.onclick = () => api.perfReveal();

    const perfCopy = card.querySelector('[data-perf-copy]');
    if (perfCopy) perfCopy.onclick = async () => {
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
      try { await navigator.clipboard.writeText(text); toast('Performance report copied — paste it to me', 'ok'); }
      catch (_) { toast(text, 'ok'); }
    };

    for (const pill of card.querySelectorAll('[data-tier]')) {
      pill.onclick = () => {
        applyTier(pill.dataset.tier, { announce: true });
        for (const p of card.querySelectorAll('[data-tier]')) p.classList.toggle('is-active', p === pill);
      };
    }

    const sgdbHint = card.querySelector('#s-sgdb-hint');
    const sgdbState = await api.sgdbKeyGet().catch(() => ({ hasKey: false }));
    if (sgdbHint) {
      sgdbHint.textContent = sgdbState.hasKey
        ? 'Key saved. Artwork auto-fills when you pick a game.'
        : 'No key yet — add one to enable artwork. Get it from steamgriddb.com → Preferences → API.';
    }

    const sgdbSave = card.querySelector('[data-sgdb-save]');
    if (sgdbSave) sgdbSave.onclick = async () => {
      const key = card.querySelector('#s-sgdb').value.trim();
      if (!key) { toast('Paste a SteamGridDB key first', 'error'); return; }
      await api.sgdbKeySet(key).catch(() => null);
      card.querySelector('#s-sgdb').value = '';
      if (sgdbHint) sgdbHint.textContent = 'Key saved. Artwork auto-fills when you pick a game.';
      toast('SteamGridDB key saved', 'ok');
    };

    const sgdbTest = card.querySelector('[data-sgdb-test]');
    if (sgdbTest) sgdbTest.onclick = async () => {
      const res = await api.sgdbKeyTest().catch(() => null);
      if (res && res.ok) toast(`SteamGridDB OK · ${res.data.count} results`, 'ok');
      else toast(res && res.error ? res.error.message : 'SteamGridDB unreachable', 'error');
    };

    const steamHint = card.querySelector('#s-steam-hint');
    const steamState = await (api.steamAccount ? api.steamAccount().catch(() => ({ users: [], active: null })) : Promise.resolve({ users: [], active: null }));
    const steamUser = (steamState.users || [])[0];
    if (steamHint) {
      steamHint.textContent = steamUser
        ? `Detected SteamID ${steamUser.steamId}${steamUser.personaName ? ` (${steamUser.personaName})` : ''}${state.config.steamKey ? ' · key saved' : ' · no key yet'}`
        : 'No Steam login found on this machine — paste a key and your SteamID will need to be set.';
    }

    const steamSave = card.querySelector('[data-steam-save]');
    if (steamSave) steamSave.onclick = async () => {
      const key = card.querySelector('#s-steam-key').value.trim();
      if (!key) { toast('Paste a Steam Web API key first', 'error'); return; }
      state.config.steamKey = key;
      state.config.steamId = steamUser ? steamUser.steamId : state.config.steamId;
      await api.saveConfig(state.config).catch(() => null);
      card.querySelector('#s-steam-key').value = '';
      if (steamHint) steamHint.textContent = `SteamID ${state.config.steamId || 'not set'} · key saved`;
      toast('Steam key saved', 'ok');
    };

    const steamTest = card.querySelector('[data-steam-test]');
    if (steamTest) steamTest.onclick = async () => {
      const typed = card.querySelector('#s-steam-key').value.trim();
      const res = await api.steamOwned({ key: typed || state.config.steamKey, steamId: state.config.steamId || (steamUser && steamUser.steamId) }).catch(() => null);
      if (res && res.ok) toast(`Steam connected · ${res.count} games`, 'ok');
      else toast((res && res.error && res.error.message) || 'Steam unreachable', 'error');
    };

    const artRefresh = card.querySelector('[data-art-refresh]');
    if (artRefresh) artRefresh.onclick = async () => {
      closeModal();
      toast('Refreshing artwork for the whole library…', 'ok');
      await enrichArt({ force: true });
      toast('Artwork refreshed', 'ok');
    };

    card.querySelector('[data-autostart]').onchange = async (e) => {
      await api.setStartup(e.target.checked).catch(() => {});
      toast(e.target.checked ? 'Will start on login' : 'Autostart disabled', 'ok');
    };
  }

  // ---------------------------------------------------------------------------
  // Command panel — the surface morphs, then the content fades in at rest
  // ---------------------------------------------------------------------------

  const cmd = { open: false, index: 0, items: [], anim: null, openedAt: 0 };

  function cmdEls() {
    return {
      root: $('#cmd'),
      input: $('#cmd-input'),
      list: $('#cmd-list'),
      count: $('#cmd-count'),
      dock: $('#search-dock'),
    };
  }

  function cmdGeometry() {
    const { root, dock } = cmdEls();
    const d = dock.getBoundingClientRect();
    const t = root.getBoundingClientRect();
    return {
      dx: d.left + d.width / 2 - (t.left + t.width / 2),
      dy: d.top + d.height / 2 - (t.top + t.height / 2),
      sx: Math.max(0.05, d.width / t.width),
      sy: Math.max(0.05, d.height / t.height),
    };
  }

  const IS_SHOT = new URLSearchParams(location.search).has('shot');

  const reducedMotion = () => !window.__gvForceAnim && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Shrink to a bubble, fly, pop, wobble, settle. Only the surface moves.
  function positionCmd() {
    const root = $('#cmd');
    const dock = $('#search-dock');
    if (!root || !dock) return;
    const d = dock.getBoundingClientRect();
    const m = ($('#main') || document.querySelector('.main')).getBoundingClientRect();
    // the spotlight sits in the middle of the library section, not under the bar
    root.style.setProperty('--cmd-x', `${Math.round(m.left + m.width / 2)}px`);
    root.style.setProperty('--cmd-y', `${Math.round(m.top + m.height / 2)}px`);
  }

  function openCmd() {
    if (cmd.open) { const { input } = cmdEls(); input.focus(); input.select(); return; }
    const modal = $('#modal');
    if (modal && !modal.hidden) return;

    const { root, input } = cmdEls();
    cmd.open = true;
    cmd.navigating = false;
    cmd.openedAt = performance.now();
    const seq = (cmd.seq = (cmd.seq || 0) + 1);

    const reveal = () => {
      if (!cmd.open) return;
      root.classList.add('is-bar', 'is-full');
    };

    const run = () => {
      root.hidden = false;
      root.classList.remove('is-bar', 'is-full', 'is-closing');
      const dockEl = $('#search-dock');
      dockEl.classList.add('is-morphing');
      dockEl.setAttribute('aria-expanded', 'true');
      renderCmd(input.value || '');
      positionCmd();
      // layout exists even at opacity 0: focus now, so typing is never dropped
      input.focus({ preventScroll: true });
      input.setSelectionRange(input.value.length, input.value.length);
      setTimeout(() => document.addEventListener('pointerdown', onCmdOutside, true), 0);
    };

    const canVT = document.startViewTransition && !reducedMotion() && !IS_SHOT;
    if (canVT) {
      const rs = document.documentElement.style;
      rs.setProperty('--morph-dur', '420ms');
      rs.setProperty('--morph-old', '160ms');
      rs.setProperty('--morph-new', '420ms');
      cmd.vt = document.startViewTransition(run);
      setTimeout(reveal, 140);
      cmd.vt.finished.finally(() => { if (cmd.open) reveal(); });
    } else {
      run();
      reveal();
      if (reducedMotion()) root.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 140 });
    }
  }

  function closeCmd() {
    if (!cmd.open) return;
    const { root, input } = cmdEls();
    const dockInput = $('#dock-input');
    const early = performance.now() - (cmd.openedAt || 0) < 380;
    cmd.open = false;
    const seq = (cmd.seq = (cmd.seq || 0) + 1);
    document.removeEventListener('pointerdown', onCmdOutside, true);

    const finish = () => {
      root.hidden = true;
      root.classList.remove('is-closing');
      input.value = '';
      cmd.items = [];
      cmd.index = 0;
      const dock = $('#search-dock');
      dock.classList.remove('is-expanded');
      dock.classList.remove('is-morphing');
      if (dockInput) dockInput.blur();
      cmd.navigating = false;
    };

    const run = () => {
      root.hidden = true;
      root.classList.remove('is-bar', 'is-full');
      const dockEl = $('#search-dock');
      dockEl.classList.remove('is-morphing');
      dockEl.setAttribute('aria-expanded', 'false');
      finish();
    };

    const focusPill = () => {
      if (!cmd.navigating && dockInput) dockInput.focus({ preventScroll: true });
    };

    const canVT = document.startViewTransition && !reducedMotion() && !IS_SHOT && !early;
    if (canVT) {
      const rs = document.documentElement.style;
      rs.setProperty('--morph-dur', '260ms');
      rs.setProperty('--morph-old', '260ms');
      rs.setProperty('--morph-new', '120ms');
      cmd.vt = document.startViewTransition(run);
      cmd.vt.finished.finally(() => { if (cmd.seq === seq && !cmd.open) focusPill(); });
    } else {
      if (cmd.vt && cmd.vt.skipTransition) { try { cmd.vt.skipTransition(); } catch (_) {} }
      run();
      focusPill();
    }
  }

  function onCmdOutside(e) {
    if (!cmd.open) return;
    const { root, dock } = cmdEls();
    if (root.contains(e.target) || (dock && dock.contains(e.target))) return;
    closeCmd();
    // swallow the click that dismissed the panel so it doesn't hit the library
    document.addEventListener('click', (ev) => { ev.preventDefault(); ev.stopPropagation(); },
      { capture: true, once: true });
  }

  function hlMatch(label, query) {
    const q = query.trim();
    if (!q) return esc(label);
    const i = label.toLowerCase().indexOf(q.toLowerCase());
    if (i < 0) return esc(label);
    return `${esc(label.slice(0, i))}<mark>${esc(label.slice(i, i + q.length))}</mark>${esc(label.slice(i + q.length))}`;
  }

  function searchModel(query) {
    const q = query.trim();
    if (!q) {
      const recent = state.games
        .slice()
        .sort((a, b) => (b.lastPlayed || 0) - (a.lastPlayed || 0))
        .slice(0, 6);
      return [
        {
          title: 'Recently played',
          items: recent.map((g) => ({
            kind: 'game', label: String(g.name || ''), game: g,
            meta: [statusLabel(g), g.hours ? fmtHours(g.hours) : ''].filter(Boolean).join(' · '),
          })),
        },
        { title: 'Actions', items: paletteActions(q) },
      ];
    }

    const match = window.Fuzzy.bestMatch(q, state.games, (g) => `${g.name || ''} ${g.source || ''}`, {
      threshold: 250,
      limit: 20,
    });

    const groups = [];
    if (match.all.length) {
      groups.push({
        title: `Games · ${match.all.length}`,
        items: match.all.slice(0, 12).map(({ item: g, score }) => ({
          kind: 'game',
          label: String(g.name || ''),
          game: g,
          meta: [statusLabel(g), g.hours ? fmtHours(g.hours) : ''].filter(Boolean).join(' · '),
          score,
        })),
      });
    }

    const actions = paletteActions(q);
    if (actions.length) groups.push({ title: 'Actions', items: actions });
    return groups;
  }

  function paletteActions(query) {
    const actions = [
      { kind: 'action', label: 'Add game', meta: 'A', run: () => openGameModal(null) },
      { kind: 'action', label: 'Import games', meta: 'I', run: openImportModal },
      { kind: 'action', label: 'Settings', meta: ',', run: openSettingsModal },
      { kind: 'action', label: 'Toggle layout', meta: 'L', run: cycleView },
    ];
    if (!query.trim()) return actions;
    return window.Fuzzy.bestMatch(query, actions, (a) => a.label, { threshold: 250 }).all.map((x) => x.item);
  }

  function renderCmd(query) {
    const { list, count } = cmdEls();
    const groups = searchModel(query);
    cmd.items = [];
    cmd.index = 0;

    if (!groups.length) {
      list.innerHTML = `<div class="cmd-empty">No games match “${esc(query)}”</div>`;
      count.textContent = '0 results';
      return;
    }

    let html = '';
    for (const group of groups) {
      html += `<div class="cmd-group">${esc(group.title)}</div>`;
      for (const item of group.items) {
        const i = cmd.items.length;
        cmd.items.push(item);
        html += `
          <button class="cmd-item" id="cmd-opt-${i}" role="option" data-i="${i}" aria-selected="${i === 0}">
            ${item.game && (item.game._cover || item.game.coverUrl) ? `<span class="ci-cover" style="background-image:url('${esc(item.game._cover || item.game.coverUrl)}')"></span>` : ''}
            <span class="ci-label">${hlMatch(item.label, query)}</span>
            <span class="ci-meta">${esc(item.meta || '')}</span>
          </button>`;
      }
    }
    list.innerHTML = html;
    count.textContent = `${cmd.items.length} result${cmd.items.length === 1 ? '' : 's'}`;
    cmdEls().input.setAttribute('aria-activedescendant', cmd.items.length ? 'cmd-opt-0' : '');

    for (const el of list.querySelectorAll('.cmd-item')) {
      el.addEventListener('mouseenter', () => setCmdActive(Number(el.dataset.i)));
      el.addEventListener('click', () => runCmdItem(Number(el.dataset.i)));
    }
  }

  function setCmdActive(i) {
    const { list } = cmdEls();
    cmd.index = Math.max(0, Math.min(i, cmd.items.length - 1));
    for (const el of list.querySelectorAll('.cmd-item')) {
      el.setAttribute('aria-selected', String(Number(el.dataset.i) === cmd.index));
    }
    const active = list.querySelector('.cmd-item[aria-selected="true"]');
    if (active) active.scrollIntoView({ block: 'nearest' });
    cmdEls().input.setAttribute('aria-activedescendant', `cmd-opt-${cmd.index}`);
  }

  function runCmdItem(i) {
    const item = cmd.items[i];
    if (!item) return;
    cmd.navigating = true;
    const dock = $('#search-dock');
    cmdEls().input.blur();
    closeCmd();
    if (item.kind === 'game') {
      setTimeout(() => {
        openDetail(item.game.id);
        state._focusReturn = dock || null;
      }, 140);
    } else if (item.run) {
      setTimeout(item.run, 140);
    }
  }

  function wireCmd() {
    const { root, input, dock } = cmdEls();

    const dockInput = $('#dock-input');
    const expandDock = () => {
      dock.classList.add('is-expanded');
      dockInput.focus();
    };
    const collapseDock = () => {
      dock.classList.remove('is-expanded');
      if (dockInput.value) { dockInput.value = ''; state.query = ''; renderLibrary(); }
    };

    dock.addEventListener('click', (e) => {
      if (e.target === dockInput) return;
      expandDock();
    });
    dockInput.addEventListener('focus', expandDock);
    dockInput.addEventListener('blur', () => { if (!dockInput.value) dock.classList.remove('is-expanded'); });

    dockInput.addEventListener('input', () => {
      state.query = dockInput.value;
      debouncedSearch();
    });

    dockInput.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        collapseDock();
        dockInput.blur();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const first = filteredGames()[0];
        if (first) { dockInput.blur(); openDetail(first.id); }
      }
    });

    input.addEventListener('input', () => {
      renderCmd(input.value);
    });

    input.addEventListener('compositionstart', () => { cmd.composing = true; });
    input.addEventListener('compositionend', () => { cmd.composing = false; renderCmd(input.value); });

    input.addEventListener('keydown', (e) => {
      if (e.isComposing || e.keyCode === 229 || cmd.composing) return;
      if (e.key === 'ArrowDown') { e.preventDefault(); setCmdActive(cmd.index + 1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); setCmdActive(cmd.index - 1); }
      else if (e.key === 'Home') { e.preventDefault(); setCmdActive(0); }
      else if (e.key === 'End') { e.preventDefault(); setCmdActive(cmd.items.length - 1); }
      else if (e.key === 'Enter') { e.preventDefault(); runCmdItem(cmd.index); }
      else if (e.key === 'Tab') { e.preventDefault(); closeCmd(); }
      else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        if (input.value) { input.value = ''; renderCmd(''); }
        else closeCmd();
      }
    });

    input.addEventListener('focus', () => { if (!cmd.open && root.hidden) openCmd(); });
  }

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------

  const VIEWS = ['shelf', 'poster', 'compact'];

  function cycleView() {
    const next = VIEWS[(VIEWS.indexOf(state.view) + 1) % VIEWS.length];
    state.view = next;
    localStorage.setItem('gv.view', next);
    if (next === 'shelf') state.sort = 'lastPlayed';
    applyView();
    renderLibrary();
    fadeIn(state.view === 'shelf' ? $('#shelf') : $('#library'));
    toast(`Layout: ${next}`, 'ok');
  }

  const SORT_LABELS = {
    lastPlayed: 'Last played',
    added: 'Recently added',
    name: 'Name',
    hours: 'Hours played',
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
    if (state.view === 'compact') grid.classList.add('view-compact');
    $('#btn-view').classList.toggle('is-active', state.view !== 'shelf');
  }

  const POP_EASE = 'cubic-bezier(0.34, 1.56, 0.64, 1)';

  function popIn(el, delay, baseTransform) {
    if (!el) return;
    const b = baseTransform ? baseTransform + ' ' : '';
    el.animate(
      [
        { opacity: 0, transform: `${b}scale(0.92) translateY(8px)` },
        { opacity: 1, transform: `${b}scale(1.025) translateY(0)`, offset: 0.68 },
        { opacity: 1, transform: `${b}scale(1)` }
      ],
      { duration: 340, delay: delay || 0, easing: POP_EASE, fill: 'backwards' }
    );
  }

  function animateSwitchPop() {
    if (prefersReducedMotion()) return;
    const active = document.querySelector('.side-item.is-active');
    if (active) {
      const icon = active.querySelector('.side-ico');
      const count = active.querySelector('b');
      if (icon) icon.animate(
        [{ transform: 'scale(0.65)' }, { transform: 'scale(1.18)', offset: 0.6 }, { transform: 'scale(1)' }],
        { duration: 300, easing: POP_EASE }
      );
      if (count) count.animate(
        [{ transform: 'scale(0.8)' }, { transform: 'scale(1.12)', offset: 0.6 }, { transform: 'scale(1)' }],
        { duration: 280, easing: POP_EASE }
      );
    }

    if (state.view === 'shelf') {
      const stage = $('#shelf-stage');
      if (stage) {
        Array.from(stage.querySelectorAll('.shelf-content > *')).forEach((el, i) => popIn(el, i * 34));
        const poster = stage.querySelector('.shelf-poster.is-on');
        if (poster) popIn(poster, 40, 'translateY(-50%)');
      }
      const inView = (el) => {
        const r = el.getBoundingClientRect();
        return r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth;
      };
      const tiles = Array.from(document.querySelectorAll('#shelf-strip .shelf-tile')).filter(inView);
      tiles.forEach((tile, i) => popIn(tile, 60 + Math.min(i, 10) * 18));
    } else {
      const inView = (el) => {
        const r = el.getBoundingClientRect();
        return r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth;
      };
      const cards = Array.from($('#grid').children).filter(inView);
      cards.forEach((card, i) => popIn(card, Math.min(i, 12) * 14));
    }
  }

  async function setFilter(filter) {
    window.__gvPerfMark && window.__gvPerfMark('filter:' + filter);
    if (state.selectedId) closeDetail();
    state.filter = filter;
    for (const btn of $$('.tab[data-filter]')) btn.classList.toggle('is-active', btn.dataset.filter === filter);
    const title = $('#filter-title');
    if (title) title.textContent = filter === 'Want' ? 'Wishlist' : filter;
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
    };
    apply();
  }

  function togglePlay(id) {
    const g = state.games.find((x) => String(x.id) === String(id));
    if (!g) return;
    const live = state.live[String(id)];

    if (typeof live === 'number' || live === 'stopping') {
      state.live[String(id)] = 'stopping';
      updateCard(g);
      if (state.selectedId === String(id)) updateDetailLive(g);
      api.killGame(g.id, g.exePath, g.installDir, g.steamAppId, g.launcherPath)
        .then(() => { delete state.live[String(id)]; updateCard(g); if (state.view === 'shelf') renderShelfStage(g); if (state.selectedId === String(id)) updateDetailLive(g); })
        .catch(() => { delete state.live[String(id)]; updateCard(g); if (state.selectedId === String(id)) updateDetailLive(g); toast('Could not stop the game', 'error'); });
      return;
    }

    if (live === 'launching') return;

    if (!g.exePath && !g.steamAppId) {
      toast('No executable set for this game', 'error');
      openGameModal(g);
      return;
    }

    state.live[String(id)] = 'launching';
    updateCard(g);
    if (state.view === 'shelf') renderShelfStage(g);
    if (state.selectedId === String(id)) updateDetailLive(g);
    api.launchGame(g.exePath, g.steamAppId, g.id, g.installDir, g.launcherPath);
  }

  // ---------------------------------------------------------------------------
  // Wiring
  // ---------------------------------------------------------------------------

  const debouncedSearch = debounce(() => { transition(() => renderLibrary()); }, 120);

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
    wireCmd();
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
        state.sort = item.dataset.sort;
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
    $('#btn-settings').onclick = openSettingsModal;
    $('#empty-cta').onclick = openImportModal;

    for (const btn of $$('.tab[data-filter]')) {
      btn.onclick = () => setFilter(btn.dataset.filter);
    }


    window.addEventListener('mouseup', (e) => {
      // X11/Wayland map the mouse "back" button to 3.
      if (e.button === 3 && state.selectedId) { e.preventDefault(); closeDetail(); }
    });

    document.addEventListener('keydown', (e) => {
      const meta = e.ctrlKey || e.metaKey;
      const modalOpen = !$('#modal').hidden;
      if (meta && (e.key.toLowerCase() === 'k' || e.key.toLowerCase() === 'f') && !modalOpen) {
        e.preventDefault();
        openCmd();
        return;
      }
      if (e.key === 'Escape') {
        if (e.defaultPrevented) return;
        if (cmd.open) closeCmd();
        else if (!$('#modal').hidden) closeModal();
        else if (state.selectedId) closeDetail();
      }
      const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName);

      if (!typing && state.view === 'shelf' && !state.selectedId && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
        const list = filteredGames();
        if (list.length) {
          e.preventDefault();
          const idx = Math.max(0, list.findIndex((g) => String(g.id) === state.shelfId));
          const next = Math.max(0, Math.min(list.length - 1, idx + (e.key === 'ArrowRight' ? 1 : -1)));
          if (next !== idx) selectShelfGame(list[next].id);
        }
      }
      if (e.key === 'Backspace' && state.selectedId && !typing) {
        e.preventDefault();
        closeDetail();
      }
      if (e.key === '/' && !typing && modalOpen === false) {
        e.preventDefault();
        openCmd();
      }

      // ---- game page shortcuts ------------------------------------------
      if (state.selectedId && !typing && !cmd.open && $('#modal').hidden
          && !e.ctrlKey && !e.metaKey && !e.altKey && !e.repeat && !e.isComposing) {
        const g = state.games.find((x) => String(x.id) === state.selectedId);
        if (g) {
          const onControl = ['BUTTON', 'A', 'INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName);
          const key = e.key.toLowerCase();
          if (e.key === ' ' && !onControl) { e.preventDefault(); togglePlay(g.id); return; }
          if (key === 'e') { e.preventDefault(); openGameModal(g); return; }
          if (key === 'w') { e.preventDefault(); toggleDetailWish(g); return; }
          if (key === 'o' && g.exePath) { e.preventDefault(); api.showInFolder(g.exePath); return; }
          if (key === 'f') { e.preventDefault(); setFinished(g, !(g.status === 'Finished')); return; }
          if (e.key === '?') {
            e.preventDefault();
            toast('Space play · E edit · W wishlist · F mark finished · Esc back', 'ok');
            return;
          }
        }
      }
    });

    if (api.onTrackingStarted) api.onTrackingStarted(({ gameId }) => {
      state.live[String(gameId)] = 0;
      const started = state.games.find((x) => String(x.id) === String(gameId));
      if (started && started.status !== 'Finished' && started.status !== 'Playing') {
        started.status = 'Playing';
        saveGamesSoon();
      }
      if (!state.liveStart) state.liveStart = {};
      state.liveStart[String(gameId)] = Date.now();
      const g = state.games.find((x) => String(x.id) === String(gameId));
      if (g) {
        updateCard(g);
        if (state.view === 'shelf' && state.shelfId === String(gameId)) renderShelfStage(g);
        if (state.selectedId === String(gameId)) updateDetailLive(g);
      }
      toast(`Launched ${g ? g.name : 'game'}`, 'ok');
    });

    if (api.onTrackingTick) api.onTrackingTick(({ gameId, sessionMins }) => {
      state.live[String(gameId)] = sessionMins;
      if (!state.liveStart) state.liveStart = {};
      state.liveStart[String(gameId)] = Date.now() - sessionMins * 60000;
      const g = state.games.find((x) => String(x.id) === String(gameId));
      if (g) updateCard(g);
    });

    if (api.onTrackingSessionEnd) api.onTrackingSessionEnd(({ gameId, sessionHours, sessionStart, sessionEnd }) => {
      delete state.live[String(gameId)];
      const g = state.games.find((x) => String(x.id) === String(gameId));
      if (g) {
        g.hours = (g.hours || 0) + (sessionHours || 0);
        if (!g.sessions) g.sessions = [];
        g.sessions.push({ start: sessionStart, end: sessionEnd, duration: sessionHours });
        g.lastPlayed = sessionEnd || Date.now();
        saveGamesSoon();
        updateCard(g);
        if (state.view === 'shelf' && state.shelfId === String(g.id)) renderShelfStage(g);
        if (state.selectedId === String(gameId)) updateDetailLive(g);
      }
    });

    if (api.onLaunchError) api.onLaunchError(({ gameId, error }) => {
      const id = String(gameId || '');
      if (id && Object.prototype.hasOwnProperty.call(state.live, id)) delete state.live[id];
      if (id && state.liveStart) delete state.liveStart[id];
      toast(String(error).split('\n')[0], 'error');
      const g = state.games.find((x) => String(x.id) === id);
      if (g) {
        updateCard(g);
        if (state.selectedId === id) updateDetailLive(g);
        if (state.view === 'shelf' && state.shelfId === id) renderShelfStage(g);
      }
    });
    if (api.onTrackingDetected) api.onTrackingDetected(({ gameId, gameName }) => {
      toast(`Detected ${gameName || 'a game'} running`, 'ok');
      state.live[String(gameId)] = 0;
      if (!state.liveStart) state.liveStart = {};
      state.liveStart[String(gameId)] = Date.now();
      const g = state.games.find((x) => String(x.id) === String(gameId));
      if (g) { updateCard(g); if (state.selectedId === String(gameId)) updateDetailLive(g); }
    });
  }

  // ---------------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------------

  async function boot() {
    state.tier = localStorage.getItem('gv.tier') || 'standard';
    state.palette = localStorage.getItem('gv.palette') || 'midnight';
    state.view = localStorage.getItem('gv.view') || 'shelf';

    try {
      const [games, config] = await Promise.all([api.loadGames(), api.loadConfig()]);
      state.games = Array.isArray(games) ? games : [];
      state.config = config || {};
      if (config && config.tier) state.tier = config.tier;
      if (config && config.palette) state.palette = config.palette;
      if (config && config.view) state.view = config.view;
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
          await api.saveGames(cleanGames());
          const bits = [];
          if (changed.dropped) bits.push(`${changed.dropped} Dropped → Playing`);
          if (changed.want) bits.push(`${changed.want} Want → Wishlist`);
          toast(`Statuses updated: ${bits.join('; ')}.`, 'ok');
        }
        state.config.statusModel = 2;
        api.saveConfig(state.config).catch(() => {});
      }

      if (Number(state.config.statusModel || 0) < 3) {
        let moved = 0;
        for (const g of state.games) {
          if (gvIsWishlisted(g)) continue;
          if (g.status !== 'Finished' && g.status !== 'Playing') { g.status = 'Playing'; moved += 1; }
        }
        if (moved) {
          await api.saveGames(cleanGames());
          toast(`Moved ${moved} unplayed game${moved === 1 ? '' : 's'} to Playing.`, 'ok');
        }
        state.config.statusModel = 3;
        api.saveConfig(state.config).catch(() => {});
      }
    } catch (e) {
      console.warn('status migration failed', e);
    }

    applyPalette(state.palette);
    applyTier(state.tier);
    applyView();
    wire();

    if (state.view === 'shelf') state.sort = 'lastPlayed';
    updateSortUi();
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
    if (name === 'palette') openCmd();
    if (name === 'detailfilter') {
      setTimeout(() => {
        const g = state.games.find((x) => x.status === 'Finished') || state.games[0];
        openDetail(g.id);
        setTimeout(() => setFilter('Finished'), 700);
      }, 300);
    }
    if (name === 'docked') { $('#search-dock').classList.add('is-expanded'); }
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
      setTimeout(() => { const t = document.querySelector('.tab[data-filter="Playing"]'); if (t) t.click(); }, 700);
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
    if (name === 'settings') openSettingsModal();
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
      setTimeout(() => { setFilter('Playing'); }, 400);
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
  let fpsOn = false;
  let fpsEl = null;
  let fpsFrames = 0;
  let fpsStart = 0;
  window.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'f')) return;
    e.preventDefault();
    fpsOn = !fpsOn;
    if (!fpsEl) { fpsEl = document.createElement('div'); fpsEl.className = 'fps-hud'; document.body.appendChild(fpsEl); }
    fpsEl.hidden = !fpsOn;
  });
  const fpsLoop = (now) => {
    if (fpsOn && fpsEl) {
      fpsFrames += 1;
      if (!fpsStart) fpsStart = now;
      if (now - fpsStart > 500) {
        fpsEl.textContent = `${Math.round((fpsFrames * 1000) / (now - fpsStart))} fps`;
        fpsFrames = 0; fpsStart = now;
      }
    }
    requestAnimationFrame(fpsLoop);
  };
  requestAnimationFrame(fpsLoop);

  const sideEl = document.querySelector('.sidebar');
  const sideToggle = $('#side-toggle');
  const applySidebar = (open) => {
    if (!sideEl) return;
    sideEl.classList.toggle('is-collapsed', !open);
    try { localStorage.setItem('gv.sidebar', open ? 'open' : 'closed'); } catch (_) {}
    if (sideToggle) sideToggle.setAttribute('aria-label', open ? 'Collapse sidebar' : 'Expand sidebar');
    setTimeout(() => { syncSidePill(); if (cmd.open) positionCmd(); }, 340);
  };
  applySidebar((() => { try { return localStorage.getItem('gv.sidebar') !== 'closed'; } catch (_) { return true; } })());
  if (sideToggle) sideToggle.onclick = () => {
    window.__gvPerfMark && window.__gvPerfMark('sidebar');
    applySidebar(sideEl.classList.contains('is-collapsed'));
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

  // ---- continuous performance recorder (1 s samples, 500 ms-ish frame stats)
  const perf = { frames: 0, sum: 0, n: 0, worst: 0, jank: 0, longTasks: 0, events: [], last: performance.now() };
  try {
    new PerformanceObserver((list) => { perf.longTasks += list.getEntries().length; }).observe({ entryTypes: ['longtask'] });
  } catch (_) {}
  const perfFrame = (now) => {
    const dt = now - perf.last;
    perf.last = now;
    if (dt > 0 && dt < 5000) {
      perf.frames += 1;
      perf.sum += dt;
      perf.n += 1;
      if (dt > perf.worst) perf.worst = dt;
      if (dt > 50) perf.jank += 1;
    }
    requestAnimationFrame(perfFrame);
  };
  requestAnimationFrame(perfFrame);
  window.__gvPerfMark = (label) => {
    perf.events.push(label);
    if (perf.events.length > 8) perf.events.shift();
  };
  setInterval(() => {
    if (!api.perfLog) return;
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
  }, 1000);

  syncSidePill();
  window.addEventListener('resize', () => {
    syncSidePill();
    if (cmd.open) positionCmd();
  });
  const libScroll = $('#library');
  if (libScroll) {
    libScroll.addEventListener('scroll', () => {
      const tb = $('#topbar');
      if (tb) tb.classList.toggle('is-scrolled', libScroll.scrollTop > 4);
    }, { passive: true });
  }

  for (const b of $$('[data-rail-action]')) {
    b.onclick = () => { const target = document.getElementById(b.dataset.railAction); if (target) target.click(); };
  }

  boot();
})();
