'use strict';
/* ============================================================================
   GameVault: the app window (renderer).
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
  // Names compared for "same game": letters and digits of any script, case
  // and width folded ('ゼルダの伝説' stays itself, not '')
  // letters and digits of any script; a name made only of symbols or emoji
  // keeps those, so two names made of the same emoji are still one game
  const nameKey = (x) => {
    const s = String(x || '').normalize('NFKC').toLowerCase();
    return s.replace(/[^\p{L}\p{N}]+/gu, '') || s.replace(/[\s\u200B-\u200F\u2060-\u2064\uFEFF\uFE0E\uFE0F]+/g, '');
  };

  // Dates and numbers: English words, in the order and separators of the
  // user's regional format (lib/locale.js)
  const LOC = (window.GVLocale && GVLocale.pick(window.api && window.api.locale)) || 'en-US';
  // Formatters are built once per option set: making one per call was the
  // top cost of redrawing a big library (every card's hours and dates).
  const numFmts = new Map();
  const fmtNum = (n, digits = 0) => {
    let f = numFmts.get(digits);
    if (!f) numFmts.set(digits, (f = new Intl.NumberFormat(LOC, { maximumFractionDigits: digits })));
    return f.format(Number(n) || 0);
  };
  const dayFmts = new Map();
  const fmtDay = (ts, opts) => {
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return d.toLocaleDateString(LOC, opts); // "Invalid Date", as before
    const key = opts ? JSON.stringify(opts) : '';
    let f = dayFmts.get(key);
    if (!f) dayFmts.set(key, (f = new Intl.DateTimeFormat(LOC, opts)));
    return f.format(d);
  };
  const fmtDayRange = (a, b) => {
    try { return new Intl.DateTimeFormat(LOC, { month: 'short', day: 'numeric' }).formatRange(new Date(a), new Date(b)); } catch (_) { return `${fmtDay(a, { month: 'short', day: 'numeric' })} – ${fmtDay(b, { month: 'short', day: 'numeric' })}`; }
  };

  const TIME_FMT = new Intl.DateTimeFormat(LOC, { hour: 'numeric', minute: '2-digit' });

  // A–Z by name: "Portal 2" before "Portal 10", case and accents ignored;
  // other scripts (日本語, 한국어, العربية) follow the Latin ones
  const NAME_ORDER = new Intl.Collator(LOC, { numeric: true, sensitivity: 'base' });
  if (window.Sessions && Sessions.setLocale) Sessions.setLocale(LOC);

  const fmtHours = (h) => {
    const n = Number(h) || 0;
    if (n <= 0) return '0h';
    if (n < 1) {
      const mins = Math.round(n * 60);
      if (mins < 1) return '<1m';
      if (mins < 60) return `${mins}m`;
    }
    return `${fmtNum(n, n >= 100 ? 0 : 1)}h`;
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
      return fmtDay(ts, { month: 'short', day: 'numeric', year: 'numeric' });
    } catch (_) { return '—'; }
  };

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
    // keep the stack inside the main panel: with the sidebar on the right it
    // would otherwise sit on top of the sidebar
    const main = $('#main');
    if (main && !document.documentElement.classList.contains('is-bigpicture')) {
      wrap.style.setProperty('--toast-right', `${Math.max(0, Math.round(innerWidth - main.getBoundingClientRect().right))}px`);
    } else wrap.style.removeProperty('--toast-right');
    // and above the round search button in the corner, whatever the nav
    // layout puts under it
    const spot = $('#spot');
    const sr = spot && spot.classList.contains('is-round') && !spot.classList.contains('open') ? spot.getBoundingClientRect() : null;
    const round = !!sr && sr.width > 0 && getComputedStyle(spot).visibility !== 'hidden';
    wrap.classList.toggle('is-above-spot', round);
    if (round) wrap.style.setProperty('--toast-bottom', `${Math.max(0, Math.round(innerHeight - sr.top + 10))}px`);
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
  let unsavedConfig = {}; // changes whose save failed, sent with the next one
  function saveConfigPatch(patch) {
    if (!patch || typeof patch !== 'object') return Promise.resolve(state.config);
    Object.assign(state.config, patch);
    const run = configChain.then(async () => {
      // a change that failed to save before (settings file locked) goes along
      const send = { ...unsavedConfig, ...patch };
      try {
        const merged = await api.saveConfig(send);
        unsavedConfig = {};
        if (merged && typeof merged === 'object' && !Array.isArray(merged)) state.config = merged;
      } catch (e) {
        unsavedConfig = send;
        throw e;
      }
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

  function applyPalette(name, { announce = false, persist = false, fade = true } = {}) {
    const p = PALETTES.includes(name) ? name : 'midnight';
    const html = document.documentElement;
    // 29: a picked palette crossfades: a still of the old colours fades out over
    // the new ones (one layer's opacity, instead of every element repainting)
    if (persist && fade && html.dataset.palette && html.dataset.palette !== p && !prefersReducedMotion() && api.windowSnapshot) {
      const seq = (applyPalette._seq = (applyPalette._seq || 0) + 1);
      api.windowSnapshot().catch(() => null).then((url) => {
        if (seq !== applyPalette._seq) return;
        const finish = () => { state.palette = p; html.dataset.palette = p; if (state.ui) applyUi(state.ui); commitLook(); };
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
      if (state.config.palette !== p) saveConfigPatch({ palette: p, uiAt: Date.now() });
      if (announce) toast(`Palette: ${p}`, 'ok');
      return;
    }
    state.palette = p;
    html.dataset.palette = p;
    lsSet('gv.palette', p);
    if (persist && state.config.palette !== p) saveConfigPatch({ palette: p, uiAt: Date.now() });
    if (announce) toast(`Palette: ${p}`, 'ok');
    if (state.ui) applyUi(state.ui); // a custom accent is checked against the new surface
    if (persist) commitLook();
  }

  // ---------------------------------------------------------------------------
  // Customizable UI (lib/uiprefs.js): layout, colours, glass. Applied as
  // html[data-ui-*] attributes and CSS variables, so CSS does the work and
  // nothing re-renders. Defaults equal the classic look.
  // ---------------------------------------------------------------------------

  const UI_ATTR = (k) => `ui${k[0].toUpperCase()}${k.slice(1)}`;
  // set by the sidebar code further down: re-fits the nav after a layout change
  const navHooks = { apply: () => {} };

  function applyUi(ui) {
    const n = UiPrefs.normalize(ui);
    const prevNav = applyUi.navKey || '';
    state.ui = n;
    const html = document.documentElement;
    for (const [k, v] of Object.entries(UiPrefs.attrs(n))) html.dataset[UI_ATTR(k)] = v;
    const nextNav = `${n.nav}|${n.navSide}|${n.dockPos}|${n.dockStyle}|${n.dockAutoHide}`;
    applyUi.navKey = nextNav;
    if (n.search !== applyUi.search) {
      applyUi.search = n.search;
      requestAnimationFrame(() => spotHooks.resync());
    }
    if (nextNav !== prevNav) { try { navHooks.apply(n); } catch (e) { reportError('nav layout', e); } }
    // Size zooms the page (main does it; Big Picture keeps its own zoom)
    if (n.fontScale !== applyUi.fontScale) {
      const first = applyUi.fontScale == null;
      applyUi.fontScale = n.fontScale;
      if (api.uiZoom && !(first && n.fontScale === 100)) {
        api.uiZoom(UiPrefs.zoom(n)).then(() => requestAnimationFrame(() => { spotHooks.resync(); syncSidePill(); })).catch(() => {});
      }
    }
    const motionChanged = applyUi.motion != null && n.motion !== applyUi.motion;
    applyUi.motion = n.motion;
    // Accent and tint are worked out from the palette's own colours, so read
    // those with our overrides off (only when one of the three changed: the
    // glass sliders call this on every move).
    const colourKey = `${html.dataset.palette}|${n.accent}|${n.tint}`;
    const vars = { ...UiPrefs.cssVars(n, { surface: '' }) };
    if (colourKey !== applyUi.colourKey) {
      applyUi.colourKey = colourKey;
      for (const k of [...UiPrefs.TINT_KEYS, ...UiPrefs.ACCENT_KEYS]) html.style.removeProperty(k);
      const cs = getComputedStyle(html);
      Object.assign(vars, UiPrefs.cssVars(n, { surface: cs.getPropertyValue('--surface').trim() }));
      const base = {};
      for (const k of UiPrefs.TINT_KEYS) base[k] = cs.getPropertyValue(k).trim();
      Object.assign(vars, UiPrefs.tintVars(base, vars['--accent'] || cs.getPropertyValue('--accent').trim(), n.tint));
    } else {
      // colours unchanged: leave the accent and tint overrides as they are
      for (const k of UiPrefs.ACCENT_KEYS) delete vars[k];
    }
    for (const [k, v] of Object.entries(vars)) {
      if (v == null) html.style.removeProperty(k);
      else html.style.setProperty(k, v);
    }
    if (window.GvAmbient) window.GvAmbient.refresh();
    backdrop.sync();
    if (motionChanged) backdrop.play();
    return n;
  }

  /** Change some prefs, apply them now, save them (and stamp the change for sync). */
  function setUi(patch, { persist = true } = {}) {
    // the background file failed to load and fluid is only shown for now: other
    // changes keep the saved choice, so a missing file is never written over it
    let base = state.ui || state.config.ui;
    const wanted = state._uiWanted;
    state._uiWanted = null;
    if (wanted && !('background' in patch) && !('backgroundFile' in patch) && !('backgroundKind' in patch)) {
      base = { ...base, background: wanted.background, backgroundFile: wanted.backgroundFile, backgroundKind: wanted.backgroundKind };
    }
    const next = UiPrefs.normalize({ ...base, ...patch });
    applyUi(next);
    if (persist) {
      saveConfigPatch({ ui: next, uiAt: Date.now() });
      scheduleCloudSync(4000);
      commitLook();
    }
    return next;
  }

  // ---- look history (Undo), presets, reset and share a look. A "look" is the
  // prefs plus the palette. Every saved change pushes the look before it;
  // slider drags only count once, when let go. Kept in memory, last 10.
  const lookHist = { past: [], committed: null, hold: false };
  const lookSnap = () => ({ ui: UiPrefs.normalize(state.ui || state.config.ui), palette: state.palette });
  const sameLook = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  function commitLook() {
    if (lookHist.hold) return;
    const now = lookSnap();
    const before = lookHist.committed;
    if (before && !sameLook(before, now)) {
      lookHist.past.push(before);
      if (lookHist.past.length > 10) lookHist.past.shift();
    }
    lookHist.committed = now;
    syncLookTools();
  }

  /** Apply a whole look at once: one Undo step, no palette crossfade. */
  function setLook(look, { undoable = true } = {}) {
    const ui = { ...look.ui, backgroundFile: state.ui.backgroundFile, backgroundKind: state.ui.backgroundKind };
    lookHist.hold = true;
    try {
      setUi(UiPrefs.normalize(ui));
      if (look.palette && look.palette !== state.palette) applyPalette(look.palette, { persist: true, fade: false });
    } finally { lookHist.hold = false; }
    if (undoable) commitLook();
    else { lookHist.committed = lookSnap(); syncLookTools(); }
    refreshLookViews();
  }

  function undoLook() {
    const prev = lookHist.past.pop();
    if (!prev) { toast('Nothing to undo', 'ok'); return; }
    setLook(prev, { undoable: false });
    toast('Look change undone', 'ok');
  }

  function resetLook() {
    if (UiPrefs.isDefault(state.ui) && state.palette === 'midnight') { toast('Already the default look', 'ok'); return; }
    setLook({ ui: UiPrefs.defaults(), palette: 'midnight' });
    toast('Back to the default look. Undo brings yours back.', 'ok');
  }

  function applyLookPreset(id) {
    const p = UiPrefs.PRESETS.find((x) => x.id === id);
    if (!p) return;
    setLook({ ui: UiPrefs.applyPreset(state.ui, id), palette: state.palette });
    if (!state.config.uiHintSeen) saveConfigPatch({ uiHintSeen: true });
  }

  async function copyLook() {
    const text = UiPrefs.exportLook(state.ui, state.palette);
    let ok = false;
    try { ok = api.uiClipboardWrite ? await api.uiClipboardWrite(text) : (await navigator.clipboard.writeText(text), true); } catch (_) { ok = false; }
    toast(ok ? 'Look copied. Paste it anywhere to share it.' : 'Couldn’t copy the look', ok ? 'ok' : 'error');
  }

  async function pasteLook() {
    const text = api.uiClipboardText ? await api.uiClipboardText().catch(() => '') : '';
    const look = UiPrefs.importLook(text, state.ui, PALETTES);
    if (!look) { toast('No look on the clipboard. Copy a GameVault look first.', 'error'); return; }
    setLook({ ui: look.ui, palette: look.palette || state.palette });
    toast('Look applied. Undo brings yours back.', 'ok');
  }

  // keeps the preset highlight and the Undo button in step with the prefs
  function syncLookTools() {
    const preset = UiPrefs.presetOf(state.ui);
    for (const b of document.querySelectorAll('[data-look-preset]')) {
      const on = b.dataset.lookPreset === preset;
      b.classList.toggle('is-active', on);
      b.setAttribute('aria-pressed', String(on));
    }
    for (const b of document.querySelectorAll('[data-look-undo]')) b.disabled = !lookHist.past.length;
  }

  // a whole look changed at once: redraw the open controls so they show it
  function refreshLookViews() {
    if (customize.isOpen()) customize.render();
    if (state.settingsOpen && state.settingsSection === 'appearance') {
      const panel = document.querySelector('#st-panel');
      const top = panel ? panel.scrollTop : 0;
      renderSettings().then(() => { const p2 = document.querySelector('#st-panel'); if (p2) p2.scrollTop = top; });
    }
  }

  // What sits behind the glass (Settings → Appearance → Background): the moving
  // colours (lib/ambient.js), the selected game's art, a solid colour, or the
  // user's own picture or video. The file is a copy in userData that never
  // syncs; a video plays muted and loops, and holds still while the window is
  // hidden, a game runs, on Lite, or with reduced motion.
  const backdrop = (() => {
    let host = null;
    let layers = [];
    let front = 0;
    let video = null;
    let shown = '';           // what the layers show now ('image:…', 'art:…', 'video:…')
    let artGame = null;
    let artTimer = 0;
    let warned = '';
    const html = document.documentElement;

    const ensure = () => {
      if (host) return host;
      const amb = document.getElementById('ambient');
      if (!amb) return null;
      host = document.createElement('div');
      host.className = 'ambient-media';
      amb.appendChild(host);
      document.addEventListener('visibilitychange', play);
      new MutationObserver(play).observe(html, { attributes: true, attributeFilter: ['data-tier'] });
      return host;
    };
    const clear = () => {
      if (!host) return;
      if (video) { video.pause(); video.removeAttribute('src'); video.load(); }
      host.textContent = '';
      layers = []; video = null; shown = '';
    };
    const artOf = (g) => (g && ((g._noHero ? '' : (g._hero || g.heroUrl)) || g._cover || g.coverUrl)) || '';
    const firstArtGame = () => {
      const withArt = state.games.filter((g) => artOf(g));
      return withArt.sort((a, b) => (b.lastPlayed || 0) - (a.lastPlayed || 0))[0] || null;
    };
    const broken = new Set();
    const missing = (what) => {
      // the copy is gone (cleaned up, another PC's settings): back to the moving colours here only
      if (warned !== what) { warned = what; toast(`Couldn’t load your background ${what}`, 'error'); }
      if (!state.ui || state.ui.background === 'fluid') return;
      if (state.ui.backgroundFile) broken.add(state.ui.backgroundFile);
      const wanted = state.ui;
      applyUi({ ...state.ui, background: 'fluid' });
      state._uiWanted = wanted; // setUi keeps this as the saved choice
    };

    function showImage(url, key, kind) {
      if (shown === key) return;
      if (video || !layers.length) clear();
      shown = key;
      if (!layers.length) {
        for (let i = 0; i < 2; i++) { const l = document.createElement('div'); l.className = 'amb-layer'; host.appendChild(l); layers.push(l); }
      }
      const img = new Image();
      img.decoding = 'async';
      img.onload = () => {
        if (shown !== key) return;
        const back = layers[front ^ 1];
        back.style.backgroundImage = cssUrl(url);
        layers[front].classList.remove('is-on');
        back.classList.add('is-on');
        front ^= 1;
      };
      img.onerror = () => { if (shown === key && kind === 'image') missing('picture'); };
      img.src = toFileUrl(url);
    }

    function showVideo(file) {
      const key = `video:${file}`;
      if (shown === key && video) return;
      clear();
      shown = key;
      video = document.createElement('video');
      video.className = 'amb-video';
      video.muted = true; video.defaultMuted = true;
      video.loop = true; video.playsInline = true;
      video.preload = 'auto';
      video.disablePictureInPicture = true;
      video.setAttribute('aria-hidden', 'true');
      video.onerror = () => { if (shown === key) missing('video'); };
      video.src = toFileUrl(file);
      host.appendChild(video);
    }

    function play() {
      if (!video) return;
      const hold = document.hidden || html.dataset.tier === 'lite' || prefersReducedMotion()
        || Object.values(state.live || {}).some((v) => typeof v === 'number');
      if (hold) video.pause();
      else { const p = video.play(); if (p && p.catch) p.catch(() => {}); }
    }

    function sync() {
      const ui = state.ui;
      const amb = document.getElementById('ambient');
      if (!ui || !amb) return;
      const mode = ui.background;
      amb.classList.toggle('has-backdrop', mode !== 'fluid');
      if (!ensure()) return;
      host.dataset.kind = mode;
      const fileOk = ui.backgroundFile && ui.backgroundKind === mode;
      if (mode === 'image' && fileOk) showImage(ui.backgroundFile, `image:${ui.backgroundFile}`, 'image');
      else if (mode === 'video' && fileOk) showVideo(ui.backgroundFile);
      else if (mode === 'art') {
        const g = artGame || firstArtGame();
        const url = artOf(g);
        if (url) showImage(url, `art:${url}`, 'art');
        else clear();
      } else clear();
      play();
    }

    /** The art background follows the game in front: the shelf's stage, the open details. */
    function art(g) {
      if (!g) return;
      artGame = g;
      if (!state.ui || state.ui.background !== 'art') return;
      clearTimeout(artTimer);
      artTimer = setTimeout(() => {
        const url = artOf(artGame);
        if (url && host) showImage(url, `art:${url}`, 'art');
      }, 220);
    }

    return { sync, art, play, isBroken: (file) => !!file && broken.has(file) };
  })();

  // The places the sidebar leads to, in order (Ctrl+1..6 and the Go-to menu).
  const NAV_PLACES = [
    { sel: '.side-item[data-filter="All"]', key: '1' },
    { sel: '.side-item[data-filter="Active"]', key: '2' },
    { sel: '.side-item[data-filter="Finished"]', key: '3' },
    { sel: '.side-item[data-filter="Want"]', key: '4' },
    { sel: '.side-item[data-filter="Activity"]', key: '5' },
    { sel: '.side-item[data-rail-action="btn-import"]', key: '' },
    { sel: '.side-item[data-rail-action="btn-settings"]', key: '6' },
  ];

  function goNavPlace(key) {
    const place = NAV_PLACES.find((p) => p.key === key);
    const btn = place && document.querySelector(`.sidebar ${place.sel}`);
    if (!btn) return false;
    btn.click();
    return true;
  }

  // No-nav layout: the menu button in the top bar opens a list built from the
  // (hidden) sidebar's own buttons, so it always matches what they do.
  function closeNavMenu({ refocus = false } = {}) {
    const menu = $('#nav-menu');
    if (!menu || menu.hidden) return;
    menu.hidden = true;
    const btn = $('#nav-menu-btn');
    if (btn) { btn.setAttribute('aria-expanded', 'false'); if (refocus) btn.focus({ preventScroll: true }); }
  }

  function openNavMenu() {
    const btn = $('#nav-menu-btn');
    if (!btn) return;
    let menu = $('#nav-menu');
    if (!menu) {
      menu = document.createElement('div');
      menu.id = 'nav-menu';
      menu.className = 'nav-menu';
      menu.setAttribute('role', 'menu');
      menu.setAttribute('aria-label', 'Go to');
      menu.hidden = true;
      document.body.appendChild(menu);
      menu.addEventListener('keydown', (e) => {
        const items = Array.from(menu.querySelectorAll('.nav-menu-item'));
        const i = items.indexOf(document.activeElement);
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeNavMenu({ refocus: true }); return; }
        if (e.key === 'Tab') { e.preventDefault(); closeNavMenu({ refocus: true }); return; }
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
        e.preventDefault();
        e.stopPropagation();
        let n = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : i + (e.key === 'ArrowDown' ? 1 : -1);
        n = Math.max(0, Math.min(items.length - 1, n));
        if (n === i) { sfx('bump'); return; }
        items[n].focus();
      });
      document.addEventListener('pointerdown', (e) => {
        if (!menu.hidden && !menu.contains(e.target) && !btn.contains(e.target)) closeNavMenu();
      }, true);
    }
    const rows = [`<button type="button" class="nav-menu-item" role="menuitem" data-nav-search><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/></svg><span>Search</span><kbd>Ctrl F</kbd></button>`, 'sep'];
    for (const place of NAV_PLACES) {
      const src = document.querySelector(`.sidebar ${place.sel}`);
      if (!src) continue;
      if (place.sel.includes('data-rail-action') && rows.filter((r) => r === 'sep').length < 2) rows.push('sep');
      const ico = src.querySelector('svg');
      const label = (src.querySelector('span') || src).textContent.trim();
      const count = src.querySelector('b');
      rows.push(`<button type="button" class="nav-menu-item${src.classList.contains('is-active') ? ' is-active' : ''}" role="menuitem" data-nav-sel="${esc(place.sel)}">${ico ? ico.outerHTML : ''}<span>${esc(label)}</span>${count && count.textContent ? `<b>${esc(count.textContent)}</b>` : ''}${place.key ? `<kbd>Ctrl ${place.key}</kbd>` : ''}</button>`);
    }
    const acct = $('#side-account');
    if (acct && !acct.hidden) rows.push('sep', `<button type="button" class="nav-menu-item" role="menuitem" data-nav-account>${esc(acct.getAttribute('aria-label') || 'Account')}</button>`);
    menu.innerHTML = rows.map((r) => (r === 'sep' ? '<div class="nav-menu-sep" role="separator"></div>' : r)).join('');
    for (const item of menu.querySelectorAll('[data-nav-sel]')) {
      item.onclick = () => {
        closeNavMenu();
        const src = document.querySelector(`.sidebar ${item.dataset.navSel}`);
        if (src) src.click();
      };
    }
    const searchItem = menu.querySelector('[data-nav-search]');
    if (searchItem) searchItem.onclick = () => { closeNavMenu(); requestAnimationFrame(() => spotHooks.open()); };
    const acctItem = menu.querySelector('[data-nav-account]');
    if (acctItem) acctItem.onclick = () => { closeNavMenu(); acct.click(); };
    const r = btn.getBoundingClientRect();
    menu.style.left = `${Math.round(r.left)}px`;
    menu.style.top = `${Math.round(r.bottom + 8)}px`;
    menu.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
    sfx('open');
    (menu.querySelector('.nav-menu-item.is-active') || menu.querySelector('.nav-menu-item')).focus({ preventScroll: true });
  }

  function initNavLayouts() {
    const btn = $('#nav-menu-btn');
    if (btn) btn.onclick = () => ($('#nav-menu') && !$('#nav-menu').hidden ? closeNavMenu() : openNavMenu());

    // Ctrl+1..6: Library, Active, Finished, Wishlist, Activity, Settings, in every layout
    addEventListener('keydown', (e) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || e.repeat) return;
      // the key's place, not its letter: AZERTY's 1 is '&' without Shift
      const digit = (/^(?:Digit|Numpad)([1-6])$/.exec(e.code || '') || [])[1] || (/^[1-6]$/.test(e.key) ? e.key : '');
      if (!digit || document.documentElement.classList.contains('is-bigpicture')) return;
      if (!$('#modal').hidden) return;
      if (spotHooks.isOpen()) spotHooks.close();
      if (goNavPlace(digit)) e.preventDefault();
    });

    // auto-hide dock: shows while the pointer is at its edge of the window
    addEventListener('pointermove', (e) => {
      const ui = state.ui;
      if (!ui || ui.nav !== 'dock' || !ui.dockAutoHide) return;
      const near = e.clientY >= innerHeight - 6;
      if (near) dockPeek(true);
      else if (document.documentElement.classList.contains('dock-peek')) {
        const side = document.querySelector('.sidebar');
        const r = side && side.getBoundingClientRect();
        const away = !r || e.clientY < r.top - 40;
        if (away) dockPeek(false);
      }
    }, { passive: true });
  }

  function dockPeek(on) {
    document.documentElement.classList.toggle('dock-peek', !!on);
  }

  /** What this PC sends with a library sync: layout and colours, no file paths. */
  function lookForSync() {
    const at = Number(state.config.uiAt) || 0;
    if (!at) return null; // never customized here: take the account's look, don't push defaults
    return { prefs: UiPrefs.syncable(state.ui || state.config.ui), palette: state.palette, at };
  }

  /** A newer look came back from the account: take it. */
  function adoptSyncedLook(look) {
    if (!look || !look.prefs || !(Number(look.at) > (Number(state.config.uiAt) || 0))) return;
    const next = UiPrefs.adopt(state.ui || state.config.ui, look.prefs);
    applyUi(next);
    const patch = { ui: next, uiAt: Number(look.at) };
    if (PALETTES.includes(look.palette) && look.palette !== state.palette) {
      applyPalette(look.palette);
      patch.palette = look.palette;
    }
    saveConfigPatch(patch);
    lookHist.committed = lookSnap();
    if (customize.isOpen() || (state.settingsOpen && state.settingsSection === 'appearance')) refreshLookViews();
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
      .then(() => {
        if (saveFail.count) { saveFail.count = 0; clearTimeout(saveFail.timer); toast('Your library is saved again', 'ok'); }
      })
      .catch((e) => {
        console.warn('save failed', e);
        // never silent: say so, and keep trying (a file held by OneDrive or
        // an antivirus usually frees up)
        saveFail.count += 1;
        clearTimeout(saveFail.timer);
        saveFail.timer = setTimeout(() => queueGamesSave(), Math.min(60000, 5000 * saveFail.count));
        if (saveFail.count === 1 || saveFail.count % 6 === 0) {
          const why = String((e && e.message) || '').replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
          toast(`Couldn’t save your library${why ? ` (${why})` : ''}. GameVault keeps trying.`, 'error',
            [{ label: 'Try now', run: () => queueGamesSave() }]);
        }
      });
    saveChain = run;
    return run;
  }
  const saveFail = { count: 0, timer: 0 };

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
    const byName = (a, b) => NAME_ORDER.compare(String(a.name || ''), String(b.name || ''));
    const compare = (a, b) => {
      if (sort === 'lastPlayed') {
        return (b.lastPlayed || 0) - (a.lastPlayed || 0) || (b.added || 0) - (a.added || 0);
      }
      if (sort === 'name') return byName(a, b);
      if (sort === 'hours') return ((Number(b.hours) || 0) - (Number(a.hours) || 0)) || byName(a, b);
      if (sort === 'rating') return (Rating.value(b) - Rating.value(a)) || byName(a, b);
      if (sort === 'status') {
        const d = (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9);
        return d !== 0 ? d : byName(a, b);
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
    const gamesWord = (n) => `${fmtNum(n)} game${n === 1 ? '' : 's'}`;

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
        : `${gamesWord(n)} · ${fmtNum(hoursOf(inFilter))} h`;
    }

    const totalEl = $('#side-total');
    const hoursEl = $('#side-hours');
    if (totalEl) totalEl.textContent = gamesWord(c.All);
    if (hoursEl) hoursEl.textContent = `${fmtNum(hoursOf((g) => !gvIsWishlisted(g)))} h`;
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
    // iconTried: libraries from before icons were filled get them once too.
    // No cover and not marked artNone: a game that came by library sync (its
    // art files stayed on the other PC, its 'looked up' marks came along).
    const queue = (only || state.games).filter((g) => g.name
      && (force || g.artVersion !== 3 || (!g.heroUrl && !g.heroTried) || (!g.iconUrl && !g.iconTried) || (!g.coverUrl && !g.artNone)));
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
          if (!g.iconUrl && !g.iconTried) slots.push('icon');
          if (!slots.length) { g.artVersion = 3; g.heroTried = true; continue; }

          const res = await api.sgdbAutofill({
            id: g.sgdbId || undefined, name: String(g.name), steamAppId: g.steamAppId || undefined, slots, bulk: true,
          }).catch(() => null);
          if (!res || !res.ok) {
            const code = res && res.error && res.error.code;
            if (code === 'NOT_FOUND') { g.artVersion = 3; g.heroTried = true; g.iconTried = true; g.artNone = true; saveGamesSoon(); continue; }
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
          if (slots.includes('cover') && a.cover && a.cover.url) { g.coverUrl = a.cover.url; delete g._cover; delete g.artNone; changed = true; }
          else if (slots.includes('cover') && !g.coverUrl) g.artNone = true; // nothing to show: don't ask again
          if (slots.includes('hero') && a.hero && a.hero.url) { g.heroUrl = a.hero.url; delete g._hero; g._noHero = false; changed = true; }
          if (slots.includes('logo') && a.logo && a.logo.url) { g.logoUrl = a.logo.url; delete g._logo; changed = true; }
          if (slots.includes('icon') && a.icon && a.icon.url) { g.iconUrl = a.icon.url; delete g._icon; changed = true; }
          if (slots.includes('icon')) g.iconTried = true;
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
      refreshCounts(); // a game added from here still counts in the nav
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

  const actHours = (h) => (h > 0 ? Sessions.formatDuration(h) : '0h');
  const actDay = (ts) => fmtDay(ts, { month: 'short', day: 'numeric' });

  // round the top of the scale up to a number a person would draw
  function actNiceMax(max) {
    const steps = [1, 2, 3, 4, 6, 8, 10, 12, 16, 20, 24, 30, 40, 50, 60, 80, 100, 120, 160, 200];
    return steps.find((v) => v >= max) || Math.ceil(max / 50) * 50;
  }

  // "Today", "Yesterday", or "Tue, Nov 10" / "Tue 10 Nov"
  function actRelDay(ts, now) {
    const d = new Date(ts);
    const a = new Date(now);
    const days = Math.round((new Date(a.getFullYear(), a.getMonth(), a.getDate()) - new Date(d.getFullYear(), d.getMonth(), d.getDate())) / 864e5);
    if (days === 0) return 'Today';
    if (days === 1) return 'Yesterday';
    return fmtDay(ts, { weekday: 'short', month: 'short', day: 'numeric' });
  }

  // A run of several days gets a tiny bar per day (the last 14).
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

  // ---- Captures: screenshots and clips from the shortcuts -------------------
  // main keeps the files in data_media and tags each with the game that was
  // running, and adds the ones other apps made (Steam, NVIDIA, Game Bar,
  // photo modes) where they lie; here they show on Activity and each game's page
  state.media = null; // newest first; null until loaded
  let mediaLoading = null;
  function loadMedia(force) {
    if (!api.getAllMedia) return Promise.resolve([]);
    if (mediaLoading && !force) return mediaLoading;
    const p = api.getAllMedia().catch(() => []).then((list) => {
      if (mediaLoading === p) mediaLoading = null;
      state.media = Array.isArray(list) ? list : [];
      return state.media;
    });
    mediaLoading = p;
    return p;
  }
  const mediaFor = (gameId) => (state.media || []).filter((m) => m.gameId === String(gameId));
  const keyLabel = (a) => String(a || '').replace(/\+/g, ' + ');
  const captureKeys = () => ({ shot: state.config.captureShotHotkey || 'Alt+Shift+S', clip: state.config.captureClipHotkey || 'Alt+Shift+R' });
  const CAP_PLAY = '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>';

  function capWhen(ts) {
    try { return fmtDay(ts, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }); } catch (_) { return fmtDate(ts); }
  }

  // "From Steam" for captures another app made
  const capFrom = (m) => (m.external && m.source ? (m.source === 'Photo mode' ? 'From the game' : `From ${m.source}`) : '');

  function capTileHtml(m, i, showGame) {
    const g = showGame && m.gameId ? gameById(m.gameId) : null;
    const label = `${m.video ? 'Clip' : 'Screenshot'}${g ? ' · ' + (g.name || 'Untitled') : ''} · ${capWhen(m.time)}${capFrom(m) ? ' · ' + capFrom(m) : ''}`;
    return `<button type="button" class="cap-tile${m.video ? ' is-clip' : ''}" data-cap="${i}" aria-label="${esc(label)}" title="${esc(label)}">
      ${m.video
        ? `<video src="${esc(m.url)}" preload="metadata" muted playsinline tabindex="-1" aria-hidden="true"></video><span class="cap-badge" aria-hidden="true">${CAP_PLAY}</span>`
        : `<img src="${esc(m.thumb || m.url)}" alt="" loading="lazy" decoding="async" />`}
      ${g ? `<span class="cap-game">${esc(g.name || 'Untitled')}</span>` : ''}
    </button>`;
  }

  function capCountText(list) {
    const clips = list.filter((m) => m.video).length;
    const shots = list.length - clips;
    const bits = [];
    if (shots) bits.push(`${fmtNum(shots)} screenshot${shots === 1 ? '' : 's'}`);
    if (clips) bits.push(`${fmtNum(clips)} clip${clips === 1 ? '' : 's'}`);
    return bits.join(' · ');
  }

  // a grid of captures with "Show all" past the first few
  function capGridHtml(list, { showGame, limit, all }) {
    const shown = all ? list : list.slice(0, limit);
    return `<div class="cap-grid">${shown.map((m, i) => capTileHtml(m, i, showGame)).join('')}</div>`
      + (list.length > limit && !all ? `<button type="button" class="btn btn-ghost cap-more" data-cap-more>Show all ${fmtNum(list.length)}</button>` : '');
  }

  function wireCapGrid(el, list, repaint) {
    for (const t of el.querySelectorAll('[data-cap]')) t.onclick = () => openCaptureViewer(list, Number(t.dataset.cap));
    const more = el.querySelector('[data-cap-more]');
    // the first tile that was hidden gets the focus
    if (more) more.onclick = () => { const n = el.querySelectorAll('[data-cap]').length; repaint(true); el.querySelectorAll('[data-cap]')[n]?.focus(); };
    const folder = el.querySelector('[data-cap-folder]');
    if (folder) folder.onclick = () => api.openCapturesFolder && api.openCapturesFolder();
  }

  function paintActivityCaptures(all) {
    const el = $('#activity-view [data-act-captures]');
    if (!el) return;
    if (all) state._capAllAct = true;
    const list = state.media || [];
    const keys = captureKeys();
    el.innerHTML = `
      <div class="act-card-head">
        <h2>Captures <span>${list.length ? capCountText(list) : 'screenshots and clips you take in games'}</span></h2>
        <button type="button" class="btn btn-ghost" data-cap-folder>Open folder</button>
      </div>
      ${list.length
        ? capGridHtml(list, { showGame: true, limit: 12, all: !!state._capAllAct })
        : `<p class="act-empty">Press <kbd class="st-kbd">${esc(keyLabel(keys.shot))}</kbd> for a screenshot, or <kbd class="st-kbd">${esc(keyLabel(keys.clip))}</kbd> to start and stop a clip, while you play. They show up here and on the game's page, with the ones you take in Steam, NVIDIA, the Xbox Game Bar or a game's photo mode.</p>`}`;
    wireCapGrid(el, list, paintActivityCaptures);
  }

  function paintGameCaptures(g, all) {
    const el = $('#game-view [data-captures]');
    if (!el || !g) return;
    if (all) el.dataset.all = '1';
    const list = mediaFor(g.id);
    el.hidden = !list.length;
    if (!list.length) { el.innerHTML = ''; return; }
    el.innerHTML = `
      <div class="gvx-ledger-head cap-head">
        <h2>Captures</h2>
        <span class="gvx-ledger-count">${capCountText(list)}</span>
      </div>
      ${capGridHtml(list, { showGame: false, limit: 8, all: el.dataset.all === '1' })}`;
    wireCapGrid(el, list, (a) => paintGameCaptures(g, a));
  }

  function repaintCaptures() {
    if (state.filter === 'Activity' && !state.selectedId && !state.settingsOpen) paintActivityCaptures();
    if (state.selectedId) paintGameCaptures(gameById(state.selectedId));
  }

  function openCaptureViewer(list, idx) {
    if (!list.length) return;
    let i = Math.max(0, Math.min(idx, list.length - 1));
    const card = openModal(`
      <div class="modal-head">
        <h2 data-cap-title>Capture</h2>
        <button class="close-x" data-close aria-label="Close">✕</button>
      </div>
      <div class="modal-body cap-view">
        <button type="button" class="cap-nav is-prev" data-cap-prev aria-label="Previous"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m14.5 6-6 6 6 6"/></svg></button>
        <div class="cap-stage" data-cap-stage></div>
        <button type="button" class="cap-nav is-next" data-cap-next aria-label="Next"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9.5 6 6 6-6 6"/></svg></button>
      </div>
      <div class="modal-foot">
        <span class="cap-when" data-cap-when></span>
        <button class="btn btn-ghost" data-cap-show>Show in folder</button>
        <button class="btn btn-ghost" data-cap-hide hidden title="Stop showing it in GameVault. The file stays where it is.">Hide</button>
        <button class="btn btn-ghost" data-cap-del>Delete</button>
        <button class="btn btn-primary" data-cap-open data-autofocus>Open</button>
      </div>`, { className: 'cap-modal' });
    if (!card) return;
    const stage = card.querySelector('[data-cap-stage]');
    const prev = card.querySelector('[data-cap-prev]');
    const next = card.querySelector('[data-cap-next]');
    const show = () => {
      const m = list[i];
      const g = m.gameId ? gameById(m.gameId) : null;
      card.querySelector('[data-cap-title]').textContent = `${m.video ? 'Clip' : 'Screenshot'}${g ? ' · ' + (g.name || 'Untitled') : ''}`;
      card.querySelector('[data-cap-when]').textContent = capWhen(m.time) + (capFrom(m) ? ' · ' + capFrom(m) : '');
      card.querySelector('[data-cap-hide]').hidden = !m.external;
      stage.innerHTML = m.video
        ? `<video src="${esc(m.url)}" controls autoplay playsinline></video>`
        : `<img src="${esc(m.url)}" alt="" />`;
      prev.disabled = i <= 0;
      next.disabled = i >= list.length - 1;
    };
    const go = (d) => { const n = i + d; if (n < 0 || n >= list.length) return; i = n; show(); };
    prev.onclick = () => go(-1);
    next.onclick = () => go(1);
    card.addEventListener('keydown', (e) => {
      if (e.target && e.target.tagName === 'VIDEO') return; // its own arrow keys seek
      if (e.key === 'ArrowLeft') { e.preventDefault(); go(-1); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); go(1); }
    });
    for (const b of card.querySelectorAll('[data-close]')) b.onclick = closeModal;
    card.querySelector('[data-cap-open]').onclick = () => api.openMedia && api.openMedia(list[i].path);
    card.querySelector('[data-cap-show]').onclick = () => api.showMediaInFolder && api.showMediaInFolder(list[i].path);
    // after Hide or Delete: drop it here and move to the next one
    const dropCurrent = async () => {
      list.splice(i, 1);
      await loadMedia(true);
      repaintCaptures();
      if (!list.length) { closeModal(); return; }
      i = Math.min(i, list.length - 1);
      show();
    };
    card.querySelector('[data-cap-hide]').onclick = async () => {
      const m = list[i];
      const ok = api.hideMedia ? await api.hideMedia(m.path).catch(() => false) : false;
      if (!ok) { toast('Couldn’t hide that one. Try again.', 'error'); return; }
      toast('Hidden. The file is still in its folder.', 'ok');
      await dropCurrent();
    };
    card.querySelector('[data-cap-del]').onclick = async () => {
      const m = list[i];
      const ok = api.deleteMedia ? await api.deleteMedia(m.path).catch(() => false) : false;
      if (!ok) { toast('Couldn’t delete that file. It may be open in another program.', 'error'); return; }
      toast('Moved to the Recycle Bin', 'ok');
      list.splice(i, 1);
      await loadMedia(true);
      repaintCaptures();
      if (!list.length) { closeModal(); return; }
      i = Math.min(i, list.length - 1);
      show();
    };
    show();
  }

  function renderActivity() {
    const view = $('#activity-view');
    if (!view) return;
    const now = Date.now();
    const games = state.games.filter((g) => !gvIsWishlisted(g));
    const byId = new Map(games.map((g) => [String(g.id), g]));
    const sessions = Sessions.allSessions(games);
    const stats = Sessions.sessionStats(sessions, now);
    const streak = Sessions.playStreak(sessions, now);
    const allHours = games.reduce((t, g) => t + (Number(g.hours) || 0), 0);
    const range = ACT_RANGES[state.actRange] ? state.actRange : '30d';
    const unit = ACT_RANGES[range].unit;
    const buckets = unit === 'day' ? Sessions.dayBuckets(sessions, 30, now) : Sessions.weekBuckets(sessions, 12, now);
    const rangeHours = buckets.reduce((t, b) => t + b.hours, 0);
    // what each bar was made of (for its hover card)
    // each bar ends where the next one starts (calendar days, so a
    // daylight-saving day of 23 or 25 hours still lines up with its bar)
    buckets.forEach((b, i) => {
      b.games = new Map();
      if (buckets[i + 1]) { b.end = buckets[i + 1].start; return; }
      const d = new Date(b.start);
      d.setDate(d.getDate() + (unit === 'day' ? 1 : 7));
      b.end = d.getTime();
    });
    for (const x of sessions) {
      if (x.start < buckets[0].start) break;
      const b = buckets.find((k) => x.start >= k.start && x.start < k.end);
      if (b) b.games.set(String(x.gameId), (b.games.get(String(x.gameId)) || 0) + x.duration);
    }
    for (const b of buckets) {
      b.games = [...b.games].sort((x, y) => y[1] - x[1]).map(([gid, h]) => [(byId.get(gid) || {}).name || 'A game', h]);
    }
    let top = Sessions.topGames(games, buckets[0].start, 6);
    let topAllTime = false;
    if (!top.length) { top = Sessions.topGames(games, null, 6); topAllTime = true; }
    const topMax = top.length ? top[0].hours : 1;

    // the last 7 days against the 7 before them: on a Monday "this week" is
    // always 0h, which says nothing
    const fortnight = Sessions.dayBuckets(sessions, 14, now);
    const week = fortnight.slice(7).reduce((t, b) => t + b.hours, 0);
    const before = fortnight.slice(0, 7).reduce((t, b) => t + b.hours, 0);
    const diff = week - before;
    const weekNote = !week && !before
      ? 'Nothing in the last two weeks'
      : (Math.abs(diff) < 1 / 60 ? 'Same as the week before' : `${Sessions.formatDuration(Math.abs(diff))} ${diff > 0 ? 'more' : 'less'} than the week before`);
    const weekStart = fortnight[7].start;
    const weekGames = new Map();
    for (const x of sessions) {
      if (x.start < weekStart) break;
      weekGames.set(String(x.gameId), (weekGames.get(String(x.gameId)) || 0) + x.duration);
    }
    const mostThisWeek = [...weekGames].sort((x, y) => y[1] - x[1])[0];
    const mostName = mostThisWeek && byId.get(mostThisWeek[0]) ? byId.get(mostThisWeek[0]).name : '';

    // days, newest first, each with the games played that day
    const days = Sessions.daysByGame(sessions, 14);
    // the newest day starts open; a day the user folded (day: null) stays folded
    if (!state._actDay || (state._actDay.day !== null && !days.some((d) => d.day === state._actDay.day))) state._actDay = { day: days.length ? days[0].day : null };

    // games you started and left: not finished, a few hours in, untouched
    // for three weeks or more; the most recently left first
    const backlog = games
      .filter((g) => g.status !== 'Finished' && (Number(g.hours) || 0) >= 2 && g.lastPlayed && now - g.lastPlayed > 21 * 864e5)
      .sort((x, y) => y.lastPlayed - x.lastPlayed)
      .slice(0, 5);

    const tile = (label, value, note) => `
      <div class="act-tile">
        <span class="act-tile-label">${label}</span>
        <b class="act-tile-value">${value}</b>
        <span class="act-tile-note">${note}</span>
      </div>`;

    const gameRow = (g, right, sub, extra = '', cls = '') => `
      <button type="button" class="act-game${cls}" data-act-game data-id="${esc(String(g.id))}">
        ${actThumb(g)}
        <span class="act-game-text"><span class="act-game-name">${esc(g.name || 'Untitled')}</span><span class="act-game-sub">${sub}</span></span>
        ${extra}
        <span class="act-game-right">${right}</span>
      </button>`;

    const CHEV = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>';
    const times = (items) => (items.length > 2
      ? `${items.length} sessions, from ${hhmm(items[0].start)}`
      : items.map((i) => hhmmRange(i.start, i.end)).join(', '));
    const dayHtml = (d) => {
      const open = state._actDay.day === d.day;
      const n = d.games.length;
      const head = `<button type="button" class="act-day-head" data-act-day="${d.day}" aria-expanded="${open}">
          <span class="act-day-name">${CHEV}${esc(actRelDay(d.day, now))}</span>
          <span class="act-day-sum">${n} game${n === 1 ? '' : 's'} · <b>${Sessions.formatDuration(d.hours)}</b></span>
        </button>`;
      const body = open ? `<div class="act-day-body">${d.games.map((x) => {
        const g = byId.get(String(x.gameId));
        return g ? gameRow(g, Sessions.formatDuration(x.hours), esc(times(x.items))) : '';
      }).join('')}</div>` : '';
      return `<div class="act-day${open ? ' is-open' : ''}">${head}${body}</div>`;
    };

    view.innerHTML = `
      <div class="act">
        <header class="act-head">
          <div>
            <h1 class="act-title">Activity</h1>
            <p class="act-sub">What you've been playing, across every game</p>
          </div>
        </header>
        <div class="act-tiles">
          ${tile('Last 7 days', actHours(week), esc(weekNote))}
          ${tile('Games played', `${weekGames.size}`, weekGames.size ? `in the last 7 days${mostName ? `, most of all ${esc(mostName)}` : ''}` : 'in the last 7 days')}
          ${tile('Days in a row', `${streak.current}`, streak.current ? `Your best: ${streak.best}` : (streak.best ? `Play today to start again. Your best: ${streak.best}` : 'Play today to start'))}
          ${tile('All time', actHours(allHours), `${fmtNum(stats.count)} session${stats.count === 1 ? '' : 's'} saved`)}
        </div>
        <section class="act-card act-playtime">
          <div class="act-card-head">
            <h2>Playtime <span>${actHours(rangeHours)} in the last ${ACT_RANGES[range].label}. Point at a bar to see what you played.</span></h2>
            <div class="act-seg" role="group" aria-label="Range">
              ${Object.entries(ACT_RANGES).map(([key, r]) => `<button type="button" class="act-seg-btn${key === range ? ' is-on' : ''}" data-act-range="${key}" aria-pressed="${key === range}">${r.label}</button>`).join('')}
            </div>
          </div>
          ${actChartHtml(buckets, unit)}
        </section>
        <section class="act-card act-captures" data-act-captures></section>
        <div class="act-cols">
          <section class="act-card">
            <div class="act-card-head"><h2>Day by day <span>the last ${days.length || 14} days you played</span></h2></div>
            <div class="act-days" data-act-days>
              ${days.length ? days.map(dayHtml).join('') : '<p class="act-empty">No sessions yet. Press Play on any game and each session is saved here when you stop.</p>'}
            </div>
          </section>
          <div class="act-side">
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
            ${backlog.length ? `<section class="act-card">
              <div class="act-card-head"><h2>Pick back up <span>started, not finished, not played lately</span></h2></div>
              <div class="act-list">
                ${backlog.map((g) => `<div class="act-back">
                  <button type="button" class="act-game" data-act-game data-id="${esc(String(g.id))}">
                    ${actThumb(g)}
                    <span class="act-game-text"><span class="act-game-name">${esc(g.name || 'Untitled')}</span><span class="act-game-sub">${fmtHours(g.hours)} in · last played ${wishAgo(g.lastPlayed)}</span></span>
                  </button>
                  <button type="button" class="act-play" data-act-play data-id="${esc(String(g.id))}" aria-label="Play ${esc(g.name || 'this game')}"><svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>Play</button>
                </div>`).join('')}
              </div>
            </section>` : ''}
          </div>
        </div>
      </div>`;

    wireActivity(view, buckets, unit);
    paintActivityCaptures();
    if (state.media == null) loadMedia().then(() => paintActivityCaptures());
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
    for (const btn of view.querySelectorAll('[data-act-play]')) {
      btn.onclick = () => togglePlay(btn.dataset.id);
    }
    // Day by day: one day open at a time; opening another folds the last
    const daysEl = view.querySelector('[data-act-days]');
    if (daysEl) daysEl.onclick = async (e) => {
      const head = e.target.closest && e.target.closest('[data-act-day]');
      if (!head || daysEl._folding) return;
      const day = Number(head.dataset.actDay);
      const calm = prefersReducedMotion();
      const shut = daysEl.querySelector('.act-day.is-open .act-day-body');
      state._actDay = { day: state._actDay && state._actDay.day === day ? null : day };
      daysEl._folding = true;
      try {
        if (shut && !calm) {
          const arrow = shut.parentElement.querySelector('.act-day-name svg');
          if (arrow) arrow.style.transform = 'none';
          await foldTo(shut, 0, 170);
        }
        renderActivity();
        const fresh = $('#activity-view [data-act-days]');
        const again = fresh && fresh.querySelector(`[data-act-day="${day}"]`);
        if (again) { again.focus({ preventScroll: true }); again.scrollIntoView({ block: 'nearest', behavior: calm ? 'auto' : 'smooth' }); }
        const body = state._actDay.day === day && fresh && fresh.querySelector('.act-day.is-open .act-day-body');
        if (body && !calm) {
          const arrow = body.parentElement.querySelector('.act-day-name svg');
          if (arrow) arrow.animate([{ transform: 'none' }, { transform: 'rotate(90deg)' }], { duration: 200, easing: 'cubic-bezier(0.22, 0.8, 0.3, 1)' });
          await foldTo(body, null, 240);
        }
      } finally {
        daysEl._folding = false;
      }
    };
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
      const when = unit === 'day' ? fmtDay(b.start, { weekday: 'short', month: 'short', day: 'numeric' }) : `Week of ${actDay(b.start)}`;
      const list = (b.games || []).slice(0, 4).map(([name, h]) => `<span class="act-tip-game"><em>${esc(name)}</em>${esc(Sessions.formatDuration(h))}</span>`).join('');
      const more = (b.games || []).length > 4 ? `<span>and ${b.games.length - 4} more</span>` : '';
      tip.innerHTML = `<b>${esc(when)} · ${b.hours > 0 ? esc(Sessions.formatDuration(b.hours)) : 'no play'}</b>${list}${more}`;
      tip.hidden = false;
      const cr = chart.getBoundingClientRect();
      const sr = slot.getBoundingClientRect();
      const bar = slot.querySelector('i');
      const topY = bar ? bar.getBoundingClientRect().top : sr.bottom;
      const w = tip.offsetWidth;
      const h = tip.offsetHeight;
      // above the bar while it fits inside the chart and under the top bar;
      // a tall bar gets it beside the bar instead, so it never covers the
      // range switch above the chart or slides under the top bar
      const pane = view.getBoundingClientRect();
      const minTop = Math.max(cr.top, pane.top + 8);
      if (topY - 8 - h >= minTop) {
        const half = w / 2;
        tip.style.transform = '';
        tip.style.left = `${Math.min(cr.width - half, Math.max(half, sr.left + sr.width / 2 - cr.left))}px`;
        tip.style.top = `${topY - cr.top - 8}px`;
      } else {
        const right = sr.right + 10 + w <= cr.right;
        const y = Math.min(cr.bottom - h, Math.max(minTop, topY));
        tip.style.transform = 'none';
        tip.style.left = `${(right ? sr.right + 10 : sr.left - 10 - w) - cr.left}px`;
        tip.style.top = `${y - cr.top}px`;
      }
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
    if (name === 'cart') return `<svg ${s} fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 4.5h2.2l2.1 10.2a1.5 1.5 0 0 0 1.5 1.2h7.6a1.5 1.5 0 0 0 1.5-1.1l1.6-6.3H7"/><circle cx="10" cy="19.5" r="1.2"/><circle cx="17" cy="19.5" r="1.2"/></svg>`;
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

  // Whole calendar days between then and today, in local time: last night
  // at 23:00 is "yesterday" at 09:00 (rounding absorbs 23/25-hour DST days)
  function calendarDaysAgo(ts) {
    const a = new Date(Number(ts)); a.setHours(0, 0, 0, 0);
    const b = new Date(); b.setHours(0, 0, 0, 0);
    return Math.round((b - a) / 86400000);
  }

  function wishAgo(ts) {
    const t = Number(ts);
    if (!t) return '';
    const days = calendarDaysAgo(t);
    if (days < 1) return 'today';
    if (days < 2) return 'yesterday';
    if (days < 14) return `${days} days ago`;
    if (days < 60) return `${Math.round(days / 7)} weeks ago`;
    if (days < 365) return `${Math.max(2, Math.round(days / 30))} months ago`;
    const y = Math.round(days / 365);
    return y <= 1 ? 'a year ago' : `${y} years ago`;
  }

  // ---- wishlist prices: IsThereAnyDeal, through GameVault Cloud (no key in
  // the app). Kept in memory only (never synced); main caches them on disk.
  // Amounts, shops and links are shown exactly as IsThereAnyDeal sends them.
  // A game's store AppID for prices and store facts: its own, else the one
  // found by title (kept apart from steamAppId, which launches and tracks the
  // game through Steam).
  function storeAppId(g) {
    const n = Number(g.steamAppId) || Number(g.steamMeta && g.steamMeta.lookupAppId);
    return n > 0 ? n : 0;
  }
  // where a game's price is kept: its AppID, else "itad:<IsThereAnyDeal id>"
  function priceKey(g) {
    const n = storeAppId(g);
    if (n) return n;
    return g.itadId ? `itad:${g.itadId}` : null;
  }
  function wishPrice(g) {
    const k = priceKey(g);
    const p = k && state.prices ? state.prices[k] : null;
    return p || null;
  }

  // Games with no AppID (added from SteamGridDB or by name): ask once which
  // game each title is. Saves the IsThereAnyDeal id, and the Steam AppID when
  // the game is on Steam; a miss is asked again after a day. Resolves to true
  // when anything was found.
  async function matchByTitle(list) {
    if (!api.priceMatch) return false;
    const DAY = 24 * 3600 * 1000;
    const todo = list.filter((g) => g.name && !priceKey(g) && !(g.itadTried && Date.now() - g.itadTried < DAY));
    if (!todo.length) return false;
    const res = await api.priceMatch([...new Set(todo.map((g) => g.name))]).catch(() => null);
    if (!res || !res.ok || !res.data) return false;
    let found = false;
    for (const g of todo) {
      if (!(g.name in res.data)) continue;
      const m = res.data[g.name];
      if (m && m.itadId) {
        g.itadId = m.itadId;
        if (m.appid > 0) g.steamMeta = { ...(g.steamMeta || {}), lookupAppId: m.appid };
        delete g.itadTried;
        found = true;
      } else g.itadTried = Date.now();
    }
    saveGamesSoon();
    return found;
  }
  function wishMoney(d) {
    if (!d || typeof d.amount !== 'number' || !Number.isFinite(d.amount)) return '';
    if (d.amount === 0) return 'Free';
    // no currency in the answer: the number alone, never a guessed dollar sign
    const fmt = d.currency ? { style: 'currency', currency: d.currency } : { minimumFractionDigits: 2, maximumFractionDigits: 2 };
    try { return new Intl.NumberFormat(LOC, fmt).format(d.amount); } catch (_) { return String(d.amount); }
  }
  function wishOnSale(g) { const p = wishPrice(g); return !!(p && p.current && p.current.cut > 0); }
  function loadWishPrices(list) {
    if (!api.prices) return;
    const asked = state._priceAsked || (state._priceAsked = new Set());
    if (list.some((g) => !priceKey(g)) && !state._matching) {
      state._matching = true;
      matchByTitle(list).then((found) => { state._matching = false; if (found) loadWishPrices(list); })
        .catch(() => { state._matching = false; });
    }
    const keys = [...new Set(list.map(priceKey).filter((k) => k && !asked.has(k)))];
    if (!keys.length) return;
    for (const k of keys) asked.add(k);
    const ids = keys.filter((k) => typeof k === 'number');
    const gids = keys.filter((k) => typeof k === 'string').map((k) => k.slice(5));
    api.prices(ids, false, gids).then((res) => {
      if (!res || !res.ok || !res.data) {
        // let a later visit try again
        setTimeout(() => { for (const k of keys) asked.delete(k); }, 5 * 60000);
        return;
      }
      state.prices = { ...(state.prices || {}), ...res.data };
      if (state.filter === 'Want' && !state.selectedId && !state.settingsOpen) renderWishlist();
    }).catch(() => { for (const k of keys) asked.delete(k); });
  }

  // "Buy": every shop selling the game, cheapest first, each opening its deal
  // (IsThereAnyDeal's own link, unchanged). The Steam store page stays one
  // click away at the bottom.
  function openWishBuy(g) {
    // older saved answers only have the best price, not every shop
    const dealsOf = (p) => (p && Array.isArray(p.deals) && p.deals.length ? p.deals : p && p.current ? [p.current] : []);
    const rows = (p) => dealsOf(p).map((d, i) => `
      <button type="button" class="wb-row${i === 0 ? ' is-best' : ''}" data-wb-url="${esc(d.url || '')}">
        <span class="wb-shop"><b>${esc(d.shop || 'Store')}</b>${i === 0 ? '<span class="wb-best">Cheapest</span>' : ''}${d.drm && d.drm.length && d.drm.join(', ') !== d.shop ? `<small>${esc(d.drm.join(', '))}</small>` : ''}</span>
        ${d.cut > 0 ? `<span class="wl-chip is-sale">−${Number(d.cut)}%</span>` : '<span></span>'}
        <span class="wb-price">${d.cut > 0 && d.regular > d.amount ? `<s>${esc(wishMoney({ amount: d.regular, currency: d.currency }))}</s>` : ''}${esc(wishMoney(d))}</span>
        <span class="wb-go">${wlIcon('ext', 13)}</span>
      </button>`).join('');
    // 'loading' until the price server answers; then 'done' or 'failed'.
    // Never left on "Loading": a missing answer, an empty one or no answer
    // in 20 seconds each says so.
    let status = 'loading';
    const body = () => {
      const p = wishPrice(g);
      if (dealsOf(p).length) return `<div class="wb-list">${rows(p)}</div>`;
      if (!priceKey(g) && status !== 'loading') return '<p class="wb-empty">No prices: no store lists a game by this name.</p>';
      if (status === 'done') return '<p class="wb-empty">No store is selling this game right now.</p>';
      if (status === 'failed') return '<p class="wb-empty">Couldn’t load prices right now. Try again in a bit.</p>';
      return '<p class="wb-empty">Loading prices…</p>';
    };
    const foot = () => {
      return `<span class="wb-links">${storeAppId(g) ? '<button type="button" data-wb-steam>Steam store page</button> · ' : ''}Prices from <button type="button" data-wb-itad>IsThereAnyDeal</button></span>`;
    };
    const card = openModal(`
      <div class="wb">
        <div class="wb-head"><div class="wb-kicker">Where to buy</div><div class="wb-game">${esc(g.name || 'Untitled')}</div></div>
        <div data-wb-body>${body()}</div>
        <div class="wb-foot" data-wb-foot>${foot()}</div>
      </div>`, { className: 'wb-modal' });
    if (!card) return;
    const paint = () => {
      if (!card.isConnected) return;
      card.querySelector('[data-wb-body]').innerHTML = body();
      card.querySelector('[data-wb-foot]').innerHTML = foot();
    };
    card.addEventListener('click', (e) => {
      const t = e.target.closest('button');
      if (!t || !api.openExternal) return;
      if (t.dataset.wbUrl && /^https:\/\//.test(t.dataset.wbUrl)) api.openExternal(t.dataset.wbUrl);
      else if (t.hasAttribute('data-wb-steam')) api.openExternal(`https://store.steampowered.com/app/${encodeURIComponent(storeAppId(g))}/`);
      else if (t.hasAttribute('data-wb-itad')) {
        const p = wishPrice(g);
        api.openExternal(p && /^https:\/\//.test(p.page || '') ? p.page : 'https://isthereanydeal.com/');
      }
    });
    const p = wishPrice(g);
    if (p && Array.isArray(p.deals)) status = 'done';
    else if (!api.prices) { status = 'failed'; paint(); }
    else {
      const timer = setTimeout(() => { if (status === 'loading') { status = 'failed'; paint(); } }, 20000);
      // no AppID or store id yet: find the game by its title first
      const ready = priceKey(g) ? Promise.resolve() : matchByTitle([g]);
      ready.then(() => {
        const k = priceKey(g);
        if (!k) return { ok: true, data: {} };
        return typeof k === 'number' ? api.prices([k]) : api.prices([], false, [k.slice(5)]);
      }).then((res) => {
        clearTimeout(timer);
        if (res && res.ok && res.data) {
          state.prices = { ...(state.prices || {}), ...res.data };
          status = 'done';
        } else status = 'failed';
        paint();
        if (state.filter === 'Want' && !state.selectedId && !state.settingsOpen) renderWishlist();
      }).catch(() => { clearTimeout(timer); status = 'failed'; paint(); });
    }
  }

  function wishFactsHtml(g) {
    const m = wishMeta(g);
    const out = [];
    const pr = wishPrice(g);
    const cur = pr && pr.current;
    if (cur) {
      const shop = cur.shop ? `<span class="wl-shop">at ${esc(cur.shop)}</span>` : '';
      const now = `<span class="wl-price">${cur.cut > 0 && cur.regular > cur.amount ? `<s>${esc(wishMoney({ amount: cur.regular, currency: cur.currency }))}</s>` : ''}${esc(wishMoney(cur))}</span>`;
      out.push(`<button type="button" class="wl-deal" data-deal title="${esc(cur.shop ? `Best price right now, at ${cur.shop}. Open the deal` : 'Open the deal')}">${cur.cut > 0 ? `<span class="wl-chip is-sale">−${Number(cur.cut)}%</span>` : ''}${now}${shop}</button>`);
    } else if (m && m.free) out.push('<span class="wl-chip">Free to play</span>');
    if (m && m.release && m.release.soon) {
      const d = String(m.release.date || '').trim();
      out.push(`<span class="wl-chip is-soon">${esc(/\d/.test(d) ? `Coming ${d}` : (d || 'Coming soon'))}</span>`);
    }
    const ago = wishAgo(g.added);
    if (ago) out.push(`<span class="wl-since">Added ${esc(ago)}</span>`);
    return out.join('');
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
            <button type="button" class="wl-btn" data-buy>${wlIcon('cart', 15)} Buy</button>
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
            <button type="button" class="wl-icon is-buy" data-buy title="Where to buy, and prices" aria-label="Where to buy ${esc(g.name)}">${wlIcon('cart', 15)}</button>
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
          <p class="wl-credit" data-wl-credit hidden>Prices from <button type="button" class="wl-credit-link" data-itad>IsThereAnyDeal</button></p>
          <div class="wl-empty" data-wl-empty hidden>
            <div class="wl-empty-star">${wlIcon('star', 38)}</div>
            <h2>Nothing on your wishlist yet</h2>
            <p>Search above for a game you want. Its best price, sales and release date show up here.</p>
            <button type="button" class="btn" data-wl-import>Import your Steam wishlist</button>
          </div>
        </div>`;
      wireWishlist(view);
    }
    const list = wishOrder();
    const sale = list.filter(wishOnSale).length;
    const soon = list.filter((g) => { const m = wishMeta(g); return m && m.release && m.release.soon; }).length;
    const bits = [`${fmtNum(list.length)} game${list.length === 1 ? '' : 's'} you want`];
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
      topEl.draggable = true;
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
        el.draggable = true;
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
    loadWishPrices(list);
    // IsThereAnyDeal's terms: credit them wherever their prices show
    const credit = view.querySelector('[data-wl-credit]');
    if (credit) credit.hidden = !list.some((g) => wishPrice(g) && wishPrice(g).current);
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

  // Put a wishlisted game at place `to` (0 = top pick); the rest keep their order.
  async function wishMoveTo(g, to) {
    const list = wishOrder();
    const from = list.indexOf(g);
    if (from < 0) return;
    const next = list.filter((x) => x !== g);
    to = Math.max(0, Math.min(next.length, to));
    if (to === from) return;
    next.splice(to, 0, g);
    if (next[0] !== list[0]) await primeWishTop(next[0]);
    wishTransition(() => { next.forEach((x, i) => { x.wishRank = i; }); });
    saveGamesSoon();
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

  // a second click while the first is still animating is ignored
  const wishBusy = new WeakSet();

  // Leaving the wishlist: a game that was Finished before it was moved to
  // the wishlist (game page → Move to wishlist) is Finished again
  function statusOutOfWishlist(g) {
    const back = g._prevStatus === 'Finished' || g.status === 'Finished' ? 'Finished' : 'Playing';
    delete g._prevStatus;
    return back;
  }

  async function wishGot(g) {
    if (wishBusy.has(g)) return;
    wishBusy.add(g);
    const prev = { status: g.status, wishRank: g.wishRank, prevStatus: g._prevStatus };
    const before = wishOrder();
    try { if (before[0] === g) await primeWishTop(before[1]); } finally { wishBusy.delete(g); }
    if (!state.games.includes(g) || !gvIsWishlisted(g)) return;
    wishTransition(() => {
      g.wishlisted = false;
      g.status = statusOutOfWishlist(g);
      delete g.wishRank;
    });
    saveGamesSoon();
    state._shelfKey = '';
    const acts = [{ label: 'Undo', run: () => {
      if (!state.games.includes(g)) return;
      wishTransition(() => {
        g.wishlisted = true; g.status = prev.status;
        if (prev.prevStatus) g._prevStatus = prev.prevStatus;
        if (Number.isFinite(prev.wishRank)) g.wishRank = prev.wishRank;
      });
      saveGamesSoon();
      state._shelfKey = '';
    } }];
    if (!g.exePath) acts.unshift({ label: 'Set it up', run: () => openGameModal(g) });
    toast(`${g.name} moved to your library`, 'ok', acts);
  }

  async function wishRemove(g) {
    if (wishBusy.has(g)) return;
    wishBusy.add(g);
    const before = wishOrder();
    try { if (before[0] === g) await primeWishTop(before[1]); } finally { wishBusy.delete(g); }
    const idx = state.games.indexOf(g);
    if (idx < 0) return;
    // removed from its own game page: that page closes with it
    if (state.selectedId === String(g.id)) closeDetail();
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

  // Steam store data (release date, free to play) for wishlisted Steam games, one
  // request at a time and at most every 12 h per game.
  function queueWishMeta(g) {
    if (!storeAppId(g) || !api.steamDetails) return;
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
      if (t.hasAttribute('data-itad')) { if (api.openExternal) api.openExternal('https://isthereanydeal.com/'); return; }
      const item = t.closest('[data-wl-item]');
      const g = item && !item.classList.contains('is-ghost') && state.games.find((x) => String(x.id) === item.dataset.id);
      if (!g) return;
      if (t.hasAttribute('data-open')) openDetail(g.id);
      else if (t.hasAttribute('data-got')) wishGot(g);
      else if (t.hasAttribute('data-remove')) wishRemove(g);
      else if (t.hasAttribute('data-top')) wishMakeTop(g);
      else if (t.hasAttribute('data-buy')) openWishBuy(g);
      else if (t.hasAttribute('data-deal')) {
        const cur = wishPrice(g) && wishPrice(g).current;
        const url = cur && /^https:\/\//.test(cur.url || '') ? cur.url : (wishPrice(g) && wishPrice(g).page);
        if (url && api.openExternal) api.openExternal(url);
      }
      else if (t.hasAttribute('data-store') && api.openExternal) api.openExternal(`https://store.steampowered.com/app/${encodeURIComponent(g.steamAppId)}/`);
    });

    // Drag a card (or the top pick) onto another one to put it in that place:
    // dropping on the left half lands before it, the right half after it, and
    // dropping on the top pick makes it the new top pick.
    let dragId = null, dropEl = null;
    const clearDrop = () => {
      if (dropEl) dropEl.classList.remove('is-drop-before', 'is-drop-after', 'is-drop-top');
      dropEl = null;
    };
    const itemOf = (t) => t && t.closest && t.closest('[data-wl-item]');
    const placeOf = (el, e) => {
      if (el.dataset.wlItem === 'top') return { cls: 'is-drop-top', after: false };
      const r = el.getBoundingClientRect();
      const after = e.clientX > r.left + r.width / 2;
      return { cls: after ? 'is-drop-after' : 'is-drop-before', after };
    };
    view.addEventListener('dragstart', (e) => {
      const el = itemOf(e.target);
      if (!el || !view.contains(el) || el.classList.contains('is-ghost')) return;
      dragId = el.dataset.id;
      el.classList.add('is-dragging');
      view.classList.add('is-sorting');
      e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData('text/plain', dragId); } catch (_) {}
    });
    view.addEventListener('dragover', (e) => {
      if (!dragId) return;
      const el = itemOf(e.target);
      if (!el || el.dataset.id === dragId) { clearDrop(); return; }
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const { cls } = placeOf(el, e);
      if (dropEl !== el || !el.classList.contains(cls)) { clearDrop(); dropEl = el; el.classList.add(cls); }
    });
    view.addEventListener('drop', (e) => {
      if (!dragId) return;
      const el = itemOf(e.target);
      const g = state.games.find((x) => String(x.id) === dragId);
      if (!el || !g || el.dataset.id === dragId) return;
      e.preventDefault();
      const list = wishOrder();
      const target = state.games.find((x) => String(x.id) === el.dataset.id);
      const { after } = placeOf(el, e);
      let to = list.indexOf(target) + (after ? 1 : 0);
      if (list.indexOf(g) < to) to -= 1;   // it leaves its old place first
      clearDrop();
      wishMoveTo(g, to);
    });
    view.addEventListener('dragend', () => {
      clearDrop();
      dragId = null;
      view.classList.remove('is-sorting');
      for (const el of view.querySelectorAll('.is-dragging')) el.classList.remove('is-dragging');
    });

    // "Add a game you want…": Steam store and SteamGridDB, searched side by
    // side (Steam first: it has prices), plus "add it by name"
    const input = view.querySelector('[data-wl-q]');
    const menu = view.querySelector('[data-wl-menu]');
    let results = [], active = -1, seq = 0, timer = 0, note = '', pending = null, searching = false;
    const term = () => input.value.trim();
    const close = () => { menu.hidden = true; input.setAttribute('aria-expanded', 'false'); };
    const norm = nameKey;
    const have = (r) => state.games.find((g) => (r.appId && String(g.steamAppId || '') === String(r.appId))
      || (r.sgdbId && String(g.sgdbId || '') === String(r.sgdbId))
      || (norm(r.name) !== '' && norm(g.name) === norm(r.name)));
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
          : r.sgdbId ? [r.year, 'SteamGridDB'].filter(Boolean).join(' · ') : 'Steam';
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
        // no soundtracks, artbooks, upgrades or other add-ons: you wish for games
        const extra = /\b(soundtrack|ost|artbook|art ?book|upgrade|season pass|dlc|expansion pass|wallpapers?)\b/i;
        const fromSteam = (steam && steam.ok ? steam.data : []).filter((r) => !extra.test(r.name));
        const seen = new Set(fromSteam.map((r) => norm(r.name)));
        // a SteamGridDB game with the same name is only the same game when
        // SteamGridDB knows it on Steam (God of War 2005 is not the 2018 one)
        const fromGrid = (grid && grid.ok && Array.isArray(grid.data) ? grid.data : [])
          .filter((x) => x && x.id && x.name && !(seen.has(norm(x.name)) && (x.types || []).includes('steam')))
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
      const steamP = (api.steamSearch ? api.steamSearch(t) : Promise.resolve(null)).catch(() => null).then((r) => { steam = r; merge(false); });
      // both at once: Steam for its store games, SteamGridDB for everything
      // else (older, console-first and non-Steam games)
      pending = Promise.all([steamP, askGrid()]).then(() => merge(true));
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
    const initials = GVLocale.initials(name);
    tile.style.setProperty('--card-hue', String(cardHue(name)));
    tile.innerHTML = `${src ? `<img src="${esc(toFileUrl(src))}" loading="lazy" decoding="async" width="172" height="236" alt="" />` : coverFallbackMarkup(initials)}<span class="shelf-tile-label">${esc(name)}</span>${!r ? '' : r >= Rating.PEAK ? `<span class="tile-rating is-peak peak-strap" data-id="${esc(String(g.id))}" data-peak-open title="Your best game ever">${PEAK_BAND}</span>` : `<span class="tile-rating">${ratingChipHtml(r, String(g.id))}</span>`}`;
    const img = tile.querySelector('img');
    fadeInOnLoad(img);
    if (img) {
      img.addEventListener('error', () => {
        if (!img.isConnected) return;
        img.insertAdjacentHTML('afterend', coverFallbackMarkup(initials));
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
      // the picked game left this view (finished, wishlisted…): pick the one
      // next to where it stood, not the first game far off-screen
      const before = (state._shelfShown || '').split(',');
      const at = before.indexOf(state.shelfId);
      const inList = new Set(list.map((g) => String(g.id)));
      let near = null;
      if (at >= 0) {
        for (let i = at + 1; i < before.length && !near; i++) if (inList.has(before[i])) near = before[i];
        for (let i = at - 1; i >= 0 && !near; i--) if (inList.has(before[i])) near = before[i];
      }
      state.shelfId = near || String(list[0].id);
    }
    const current = list.find((g) => String(g.id) === state.shelfId) || list[0];

    const railEl2 = document.querySelector('.shelf-rail');
    if (railEl2) railEl2.hidden = false;
    renderShelfStage(current);

    const key = list.map((g) => String(g.id)).join(',');
    // _shelfKey is cleared to force a repaint; _shelfShown is what was really on screen
    const prevKey = state._shelfShown || '';
    const sameFilter = state._shelfFilter === state.filter;
    const inPlace = sameFilter && isRemovalOnly(prevKey ? prevKey.split(',') : [], key.split(','));
    // a forced repaint (rating, edit, layout switch) with the same order on
    // screen is only a repaint: the rail keeps its place
    if (key !== state._shelfKey && key === prevKey && strip.querySelector('.shelf-tile')) state._shelfKey = key;
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
        tile.tabIndex = tile.dataset.id === state.shelfId ? 0 : -1; // one tab stop: the picked cover
      }
    } else if (key !== state._shelfKey) {
      state._shelfKey = key;
      stopSpring(strip);
      if (strip._stopMomentum) strip._stopMomentum();
      strip.scrollLeft = 0;
      if (strip._spring) strip._spring.x = 0;
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
          tile.onclick = (e) => {
            if (shelfDragMoved) return;
            // Enter or Space on the picked cover opens it (a mouse double-clicks)
            if (e.detail === 0 && tile.dataset.id === state.shelfId) { openDetail(tile.dataset.id); return; }
            selectShelfGame(tile.dataset.id);
          };
          tile.ondblclick = () => openDetail(tile.dataset.id);
        }
        paintShelfTile(tile, g);
        tile.classList.toggle('is-active', id === state.shelfId);
        tile.setAttribute('aria-selected', String(id === state.shelfId));
        tile.tabIndex = id === state.shelfId ? 0 : -1;
        frag.appendChild(tile);
      }
      for (const leftover of existing.values()) leftover.remove();
      strip.appendChild(frag);
      // same view, new order (sort): stay with the picked game
      if (sameFilter) {
        const tile = strip.querySelector(`[data-id="${CSS.escape(state.shelfId)}"]`);
        if (tile) {
          const x = Math.max(0, tile.offsetLeft - (strip.clientWidth - tile.offsetWidth) / 2);
          strip.scrollLeft = x;
          if (strip._spring) strip._spring.x = strip.scrollLeft;
        }
      }
    } else {
      const byId = new Map(list.map((g) => [String(g.id), g]));
      for (const tile of strip.querySelectorAll('.shelf-tile')) {
        const g = byId.get(tile.dataset.id);
        if (g) paintShelfTile(tile, g);
        tile.classList.toggle('is-active', tile.dataset.id === state.shelfId);
        tile.setAttribute('aria-selected', String(tile.dataset.id === state.shelfId));
        tile.tabIndex = tile.dataset.id === state.shelfId ? 0 : -1; // one tab stop: the picked cover
      }
    }

    refreshCounts();
    // focus was on a tile that is gone (it left the view, or was rebuilt):
    // the picked tile takes it, so the keyboard and pad keep their place
    if (!strip._focusWired) {
      strip._focusWired = true;
      strip.addEventListener('focusin', () => { strip._hadFocus = true; });
      // a tile removed under focus reports no new target: that still counts as here
      strip.addEventListener('focusout', (e) => { if (e.relatedTarget && !strip.contains(e.relatedTarget)) strip._hadFocus = false; });
    }
    if (strip._hadFocus && (document.activeElement === document.body || !document.activeElement) && $('#modal').hidden && !$('#shelf').hidden) {
      strip.querySelector('.shelf-tile.is-active')?.focus({ preventScroll: true });
    }
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
      tile.tabIndex = tile.dataset.id === state.shelfId ? 0 : -1;
    }
    // the keyboard follows the pick, so Delete and Enter act on the game shown
    const strip = $('#shelf-strip');
    if (strip.contains(document.activeElement)) strip.querySelector(`.shelf-tile[data-id="${CSS.escape(state.shelfId)}"]`)?.focus({ preventScroll: true });
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
    const maxOf = () => Math.max(0, el.scrollWidth - el.clientWidth);
    target = Math.max(0, Math.min(maxOf(), target));
    const st = el._spring || (el._spring = { x: el.scrollLeft, v: 0, raf: null, target });
    st.target = target;
    // An idle spring starts from where the rail really is. Its old position is
    // stale after a filter switch reset the rail, and starting from it rolled
    // the rail across every game.
    if (!st.raf) { st.x = el.scrollLeft; st.v = 0; }
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
      const max = maxOf();
      if (st.target > max) st.target = max;
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
    const stage = $('#shelf-stage');
    // built, and its buttons really are the ones on screen: nothing to do.
    // Anything else (the stage emptied or swapped under it) builds it again,
    // so the banner can't be left without its title and buttons.
    if (shelfDom.built && shelfDom.playBtn && stage.contains(shelfDom.playBtn) && stage.querySelector('.shelf-content')) return;
    shelfDom.front = 0;
    state._stageVisual = '';
    state._heroShown = '';
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
    backdrop.art(g);
    const id = String(g.id);
    const live = state.live[id];
    const running = typeof live === 'number';
    const heroArt = g._noHero ? '' : (g._hero || g.heroUrl || '');
    const art = heroArt || g._cover || g.coverUrl || '';

    const back = shelfDom.front === 0 ? 1 : 0;
    const artBack = shelfDom.arts[back];
    const posterBack = shelfDom.posters[back];

    const posterSrc = g._cover || g.coverUrl;
    // games with no cover differ by their initials and tint
    const visualKey = `${art}|${posterSrc}|${posterSrc ? '' : g.name}`;
    if (state._stageVisual !== visualKey) {
      const oldArt = shelfDom.arts[shelfDom.front];
      state._stageVisual = visualKey;
      artBack.style.backgroundImage = art ? cssUrl(art) : '';
      artBack.classList.toggle('is-fallback', !heroArt && !!art);
      posterBack.style.backgroundImage = posterSrc ? cssUrl(posterSrc) : '';
      posterBack.innerHTML = posterSrc ? '' : coverFallbackMarkup(GVLocale.initials(g.name));
      posterBack.style.setProperty('--card-hue', String(cardHue(g.name)));
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
    shelfDom.title.title = g.name || ''; // the whole title when two lines cut it
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

  function coverFallbackMarkup(initials) {
    return `<span class="cover-fallback" aria-hidden="true"${initials ? ` data-initials="${esc(initials)}"` : ''}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">
        <path d="M17.32 5H6.68a4 4 0 0 0-3.978 3.59c-.006.052-.01.101-.017.152C2.604 9.416 2 14.456 2 16a3 3 0 0 0 3 3c1 0 1.5-.5 2-1l1.414-1.414A2 2 0 0 1 9.828 16h4.344a2 2 0 0 1 1.414.586L17 18c.5.5 1 1 2 1a3 3 0 0 0 3-3c0-1.545-.604-6.584-.685-7.258-.007-.05-.011-.1-.017-.151A4 4 0 0 0 17.32 5z"/>
        <path d="M6 11h4M8 9v4"/>
        <path d="M15 12h.01M18 10h.01"/>
      </svg>
    </span>`;
  }

  // Cards without artwork get a tint and initials derived from the title, so
  // a library of fallbacks still reads as distinct games (any script: see
  // GVLocale.initials).
  const cardInitials = (name) => GVLocale.initials(name);
  function cardHue(name) {
    let h = 0;
    for (const ch of String(name || '')) h = (h * 31 + ch.codePointAt(0)) % 360;
    return h;
  }
  function relativeDay(ts) {
    if (!ts) return '';
    const days = calendarDaysAgo(ts);
    if (days <= 0) return 'today';
    if (days === 1) return 'yesterday';
    if (days < 7) return `${days} days ago`;
    if (days < 30) { const w = Math.floor(days / 7); return w === 1 ? 'a week ago' : `${w} weeks ago`; }
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
      if (e.target !== el) return; // Enter on the Play button plays
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(g.id); }
    });
    el.addEventListener('dblclick', (e) => {
      if (e.target.closest && e.target.closest('.card-play')) return; // its two clicks already did it
      togglePlay(g.id);
    });

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
    if (g.source) ref.el.title = `${g.name || 'Untitled'} · ${g.source}`;
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
          const peak = tier === 'peak';
          ref.rating.classList.toggle('peak-strap', peak);
          if (peak) ref.rating.dataset.id = String(g.id);
          else { delete ref.rating.dataset.id; delete ref.rating.dataset.ps; ref.rating.removeAttribute('style'); }
          ref.rating.dataset.r = String(r);
          ref.rating.innerHTML = peak ? PEAK_BAND : `${STAR_ICON}<span>${Rating.label(r)}</span>`;
          ref.rating.toggleAttribute('data-peak-open', tier === 'peak');
          ref.rating.title = r >= Rating.PEAK ? 'Your rating: PEAK' : `Your rating: ${Rating.label(r)} / 10`;
        }
      }
    }

    ref.play.hidden = wish && !running;
    ref.play.title = running ? 'Stop' : launching ? 'Launching… (click to cancel)' : live === 'stopping' ? 'Stopping…' : 'Launch';
    // the button says what is happening, like the shelf and the game page
    const playKind = running ? 'stop' : launching ? 'launching' : live === 'stopping' ? 'stopping' : 'play';
    if (ref.play.dataset.kind !== playKind) {
      ref.play.dataset.kind = playKind;
      ref.play.innerHTML = playKind === 'stop'
        ? '<svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2.5"/></svg><span>Stop</span>'
        : playKind === 'launching' || playKind === 'stopping'
          ? `<svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg><span>${playKind === 'launching' ? 'Launching…' : 'Stopping…'}</span>`
        : '<svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor"><path d="M8 5.5v13l10.5-6.5z"/></svg><span>Play</span>';
    }
  }

  // One place to repaint everything that shows a game's live state.
  function refreshGameUi(g) {
    if (!g) return;
    updateCard(g);
    refreshStage(g);
    refreshCounts(); // Active counts a game while it runs
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
    state._focusReturnKey = state._focusReturn ? focusKey(state._focusReturn) : null;
    state.selectedId = String(id);
    backdrop.art(state.games.find((x) => String(x.id) === String(id)));
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
    // the page under it may have been re-rendered (Activity rebuilds its
    // rows): find the same control again
    refocus(state._focusReturn, state._focusReturnKey);
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
    if (running) parts.push('Playing now');
    if (total > 0) parts.push(`${fmtHours(total)} played`);
    else parts.push('Not played yet');
    if (g.lastPlayed && !running) parts.push(`<span title="${esc(fmtDate(g.lastPlayed))}">last played ${wishAgo(g.lastPlayed)}</span>`);
    // critics: OpenCritic's average over every platform; Steam's Metacritic
    // score (its PC version only) until OpenCritic has answered
    const oc = criticsOf(g);
    const mc = g.steamMeta && g.steamMeta.metacritic && g.steamMeta.metacritic.score;
    const critic = oc && oc.score ? oc.score : mc;
    if (critic) {
      const from = oc && oc.score ? ['OpenCritic', 'Top critics on OpenCritic, every platform'] : ['Metacritic', "Critics' score on Metacritic (PC)"];
      parts.push(`<span class="gvx-mc${critic >= 75 ? '' : critic >= 50 ? ' is-mid' : ' is-low'}" title="${from[1]}"><b>${esc(String(critic))}</b> ${from[0]}</span>`);
    }
    return parts.join('<span class="gvx-dot">·</span>');
  }

  function detailTimerHtml(g) {
    const live = state.live[String(g.id)];
    if (typeof live === 'number') {
      return `<span class="gvx-timer-label">This session</span><span class="gvx-timer-value is-live" data-timer-value>00:00</span>`;
    }
    const last = gvSessions(g).slice().sort((a, b) => b.start - a.start)[0];
    const label = last ? 'Last session' : 'Playtime';
    const value = last ? Sessions.formatDuration(last.duration) : fmtHours(g.hours);
    return `<span class="gvx-timer-label">${label}</span><span class="gvx-timer-value" data-timer-value>${value}</span>`;
  }

  // Clock times in the region's 12- or 24-hour style: '4:46 PM' / '16:46';
  // a range on one day shares its AM/PM: '4:46 – 6:02 PM'
  function hhmm(ts) { return TIME_FMT.format(new Date(ts)); }
  function hhmmRange(a, b) {
    const x = new Date(a), y = new Date(b);
    if (x.toDateString() === y.toDateString()) {
      try { return TIME_FMT.formatRange(x, y); } catch (_) { /* below */ }
    }
    return `${hhmm(a)} – ${hhmm(b)}`;
  }

  // Whether the rail has anything beyond the always-present "At a glance"
  // card (pulse or specs). The rail itself is always rendered for owned games.
  function railHasData(g) {
    const meta = g.steamMeta || {};
    return !!((meta.metacritic && meta.metacritic.score) || Number(g.timeToBeat) > 0 || meta.about || meta.developer
      || (meta.genres && meta.genres.length)
      || (meta.recommended && meta.recommended.length) || (meta.minimum && meta.minimum.length));
  }

  // Store text that shouts a whole sentence in capitals, in sentence case
  // ("THE CRITICALLY ACCLAIMED FANTASY ACTION RPG." -> "The critically
  // acclaimed fantasy action RPG."); short all-caps words like RPG stay.
  function unshout(text) {
    return String(text || '').replace(/[^.!?]+[.!?]*/g, (part) => {
      const letters = part.replace(/[^A-Za-z]/g, '');
      if (letters.length < 12 || letters !== letters.toUpperCase()) return part;
      const lead = part.match(/^\s*/)[0];
      return lead + part.slice(lead.length).toLowerCase()
        .replace(/\b(rpg|fps|mmo|pvp|pve|ai|vr|ui|dlc|3d|2d)\b/gi, (w) => w.toUpperCase())
        .replace(/^./, (c) => c.toUpperCase());
    });
  }

  // The side column: what the game is (About), then what it needs to run.
  // Your own numbers (playtime, last played) live in the hero and Sessions,
  // so nothing here repeats them.
  function railHtml(g) {
    const meta = g.steamMeta || {};
    const facts = [];
    if (meta.developer) facts.push(['Made by', meta.developer]);
    if (meta.genres && meta.genres.length) facts.push(['Genre', meta.genres.join(', ')]);
    if (Number(g.timeToBeat) > 0) facts.push(['To finish', `about ${Math.round(Number(g.timeToBeat))} hours`]);
    if (g.source) facts.push(['From', g.source]);
    if (g.added) facts.push(['Added', fmtDate(g.added)]);

    const NAMES = { OS: 'System', Processor: 'Processor', Memory: 'Memory', Graphics: 'Graphics', Storage: 'Storage' };
    // what it needs at least (Steam's recommended when it lists no minimum)
    const min = !!(meta.minimum && meta.minimum.length);
    const specs = (min ? meta.minimum : (meta.recommended && meta.recommended.length ? meta.recommended : []))
      .filter(([key]) => NAMES[key]);


    return `
      <div class="gvx-card">
        <h3 class="gvx-card-head">About this game</h3>
        ${meta.about ? `<p class="gvx-about">${esc(unshout(meta.about))}</p>` : ''}
        ${(() => { const c = criticsOf(g); return c && c.by && c.line ? `<blockquote class="gvx-quote">“${esc(c.line)}”<cite>— ${esc(c.by)}</cite></blockquote>` : ''; })()}
        ${facts.length ? `<dl class="gvx-specs">${facts.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>` : ''}
      </div>
      ${specs.length ? `<div class="gvx-card">
        <h3 class="gvx-card-head">What your PC needs <span>${min ? 'at least' : 'recommended'}</span></h3>
        <dl class="gvx-specs is-specs">${specs.map(([key, value]) => `<div><dt>${NAMES[key]}</dt><dd>${esc(value)}</dd></div>`).join('')}</dl>
      </div>` : ''}
    `;
  }

  // signed in, save backups lead the rail; signed out, a small invite at the end
  function railInner(g) {
    const sv = '<div class="gvx-card sv-card" data-saves-card></div>';
    return signedIn() ? sv + railHtml(g) : railHtml(g) + sv;
  }

  function paintRail(g) {
    const rail = document.querySelector('#game-view [data-rail]');
    if (rail) { rail.innerHTML = railInner(g); paintSavesCard(g); }
  }

  async function loadSteamMeta(g) {
    const appId = storeAppId(g);
    if (!appId || !api.steamDetails) return;
    const ttl = gvIsWishlisted(g) ? 12 * 3600000 : 14 * 86400000;
    const fresh = g.steamMeta && g.steamMeta.version === 3 && g.steamMeta.at && (Date.now() - g.steamMeta.at < ttl);
    if (fresh) return;
    const res = await api.steamDetails(appId).catch(() => null);
    if (!res || !res.ok || !res.data) return;
    const hadData = railHasData(g);
    const lookupAppId = g.steamMeta && g.steamMeta.lookupAppId;
    g.steamMeta = { ...res.data, ...(lookupAppId ? { lookupAppId } : {}), version: 3, at: Date.now() };
    saveGamesSoon();
    if (gvIsWishlisted(g) && state.filter === 'Want' && !state.selectedId && !state.settingsOpen) renderWishlist();
    if (state.selectedId !== String(g.id) || gvIsWishlisted(g)) return;
    // the rail element always exists on an owned game's page: repaint it in
    // place (no full re-render) when there is something new to show
    const rail = document.querySelector('#game-view [data-rail]');
    if (!rail) renderDetail();
    else if (hadData || railHasData(g)) paintRail(g);
    const metaEl = document.querySelector('#game-view .gvx-meta');
    if (metaEl) metaEl.innerHTML = detailMeta(g);
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
            ${wish ? '' : `${Rating.value(g) > 0 ? '<span class="gvx-top-label" aria-hidden="true">Your rating</span>' : ''}${rateButtonHtml(g)}
            ${finishButtonHtml(status === 'Finished')}`}
            <div class="gvx-more-wrap">
              <button class="gvx-chip gvx-icon" data-more aria-haspopup="menu" aria-expanded="false" title="More">
                <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/></svg>
              </button>
              <div class="gvx-menu" data-menu hidden role="menu">
                <button role="menuitem" data-folder ${g.exePath ? '' : 'disabled'}>Open folder</button>
                <button role="menuitem" data-copy ${g.exePath ? '' : 'disabled'}>Copy path</button>
                <button role="menuitem" data-edit>Edit…</button>
                <button role="menuitem" data-refresh>Refresh artwork</button>
                ${wish ? '' : '<button role="menuitem" data-to-wish>Move to wishlist</button>'}
                <button role="menuitem" class="is-danger" data-remove-game>${wish ? 'Remove from wishlist' : 'Remove from library…'}</button>
              </div>
            </div>
          </div>
        </div>

        <div class="gvx-hero-body" tabindex="-1" aria-label="${esc(g.name)}">
          ${logo
            ? `<span class="gv-logo3d" data-logo3d><img class="gvx-logo" src="${esc(toFileUrl(logo))}" alt="${esc(g.name)}" /><i class="gv-logo-sheen" style="--logo:${esc(cssUrl(logo))}" aria-hidden="true"><b></b></i></span>`
            : `<h1 class="gvx-title" title="${esc(g.name)}">${esc(g.name)}</h1>`}
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
              <span class="gvx-ledger-count">${ledgerCountText(gvSessions(g))}</span>
            </div>
            <div class="gvx-ses-top" data-ses-top></div>
            <div class="gvx-list" data-ledger role="list" aria-label="Session history"></div>
            <section class="gvx-caps" data-captures hidden aria-label="Captures"></section>
          </div>
          <aside class="gvx-rail" data-rail>${railInner(g)}</aside>
        `}
      </div>
    `;
    animateDetailIn(view, g);

    const heroImg = view.querySelector('.gvx-hero-art');
    if (heroImg && heroImg.tagName === 'IMG') heroImg.addEventListener('error', () => heroImg.classList.add('is-empty'));
    const logoImg = view.querySelector('.gvx-logo');
    logoTilt(view.querySelector('[data-logo3d]'));
    if (logoImg) logoImg.addEventListener('error', () => { (logoImg.closest('[data-logo3d]') || logoImg).remove(); view.querySelector('.gvx-hero-body').insertAdjacentHTML('afterbegin', `<h1 class="gvx-title" title="${esc(g.name)}">${esc(g.name)}</h1>`); });

    if (!wish) paintLedger(g);
    wireDetail(g, wish);
    if (!wish) paintSavesCard(g);
    if (!wish) { paintGameCaptures(g); if (state.media == null) loadMedia().then(() => { if (String(state.selectedId) === String(g.id)) paintGameCaptures(g); }); }
    startDetailTick(g);
    state._detailRunning = { id: String(g.id), running: typeof state.live[String(g.id)] === 'number' };
    if (!wish) loadSteamMeta(g);
    if (!wish && Rating.value(g) > 0) loadCritics(g);
  }

  const SES_WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  // Three plain numbers, each with a line saying what it means, and one
  // sentence about when you play. No charts.
  function sessionsTopHtml(g, sessions) {
    const days = Sessions.dayGroups(sessions);
    const stat = (label, value, note) => `<div class="gvx-ses-stat"><span>${label}</span><b>${value}</b>${note ? `<small>${note}</small>` : ''}</div>`;
    // a usual day of real play: quick launches would drag an average to "1m"
    const realDays = days.filter((d) => !d.brief);
    const typical = realDays.length ? realDays.reduce((t, d) => t + d.hours, 0) / realDays.length : 0;
    const best = days.reduce((a, d) => (!a || d.hours > a.hours ? d : a), null);
    const first = days.length ? days[days.length - 1].day : 0;
    const since = first ? fmtDay(first, { month: 'long', year: 'numeric' }) : '';
    const habit = sessionHabitText(Sessions.habits(sessions));
    return `
      <div class="gvx-ses-stats">
        ${stat('Days you played', String(days.length), since ? `since ${esc(since)}` : '')}
        ${stat('A usual day', typical > 0 ? Sessions.formatDuration(typical) : '—', typical > 0 ? 'of play, when you play' : 'only quick launches so far')}
        ${stat('Your longest day', best ? Sessions.formatDuration(best.hours) : '—', best ? esc(fmtDate(best.day)) : '')}
      </div>
      ${habit ? `<p class="gvx-ses-habit">${esc(habit)}</p>` : ''}`;
  }

  function ledgerCountText(sessions) {
    const n = Sessions.sessionStats(sessions).count;
    return n ? `${n} session${n === 1 ? '' : 's'}, newest first` : '';
  }

  const SES_DAY_NAMES = ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays'];
  function sessionHabitText(h) {
    if (!h) return '';
    const part = { morning: 'Mostly a morning game', afternoon: 'Mostly an afternoon game', evening: 'Mostly an evening game', night: 'Mostly a late-night game' }[h.part] || '';
    const day = h.weekday == null ? '' : `${SES_DAY_NAMES[h.weekday]} get the most time`;
    if (part && day) return `${part}, and ${day}.`;
    return part ? `${part}.` : (day ? `${day}.` : '');
  }

  // "June 2026", in the user's own language
  function monthTitle(key) {
    const [y, m] = String(key).split('-').map(Number);
    return esc(fmtDay(new Date(y, m - 1, 1), { month: 'long', year: 'numeric' }));
  }

  function paintLedger(g) {
    const listEl = document.querySelector('[data-ledger]');
    if (!listEl) return;
    const sessions = gvSessions(g);
    const live = state.live[String(g.id)];
    const running = typeof live === 'number';
    const book = Sessions.ledger(sessions);
    const MAX_ROWS = 120;
    // One month open at a time (the newest, to begin with), and inside it one
    // day's sessions at a time: opening another closes the last, so the list
    // never piles up. Remembered while you stay on the game.
    if (!state._ledgerOpen || state._ledgerOpen.id !== String(g.id)) {
      state._ledgerOpen = { id: String(g.id), month: book.months.length ? book.months[0].key : null, day: null };
    }
    const openState = state._ledgerOpen;

    const topEl = document.querySelector('[data-ses-top]');
    if (topEl) {
      const show = sessions.length > 0 || running;
      topEl.hidden = !show;
      topEl.innerHTML = show ? sessionsTopHtml(g, sessions) : '';
    }

    // (the running session is the timer beside Play/Stop; no extra row here)
    const rows = [];
    const CHEV = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>';
    const bar = (h, max) => `<span class="gvx-row-bar" aria-hidden="true"><i style="width:${Math.max(1.5, (h / (max || 1)) * 100).toFixed(1)}%"></i></span>`;

    // One row per day played: when in the day it happened, and for how long.
    let rendered = 0;
    let longestDay = 0;
    for (const m of book.months) for (const r of m.rows) if (r.kind === 'day' && r.hours > longestDay) longestDay = r.hours;
    for (const month of book.months) {
      if (rendered >= MAX_ROWS) break;
      const open = openState.month === month.key;
      const head = `<button type="button" class="gvx-month${open ? ' is-open' : ''}" data-month="${month.key}" aria-expanded="${open}">
        <span class="gvx-month-name">${CHEV}${monthTitle(month.key)}</span>
        <span class="gvx-month-sum">${Sessions.formatDuration(month.hours)} over ${month.days} day${month.days === 1 ? '' : 's'}</span>
      </button>`;
      if (!open) { rows.push(`<div class="gvx-mgroup">${head}</div>`); continue; }
      const inner = [];
      for (const row of month.rows) {
        if (rendered >= MAX_ROWS) break;
        if (row.kind === 'brief') {
          const range = row.days > 1 ? fmtDayRange(row.from, row.to) : actDay(row.to);
          inner.push(`<div class="gvx-row is-brief" role="listitem">
            <span class="gvx-row-date"><b>·</b></span>
            <span class="gvx-row-note">${row.count} quick launch${row.count === 1 ? '' : 'es'} · ${range}</span>
            <span class="gvx-row-dur">${Sessions.formatDuration(row.hours)}</span>
          </div>`);
        } else {
          const d = new Date(row.day);
          const many = row.count > 1 && Array.isArray(row.items) && row.items.length > 1;
          const date = `<span class="gvx-row-date"><i>${SES_WD[d.getDay()]}</i><b>${d.getDate()}</b></span>`;
          const dur = `<span class="gvx-row-dur">${Sessions.formatDuration(row.hours)}</span>`;
          if (!many) {
            const when = hhmmRange(row.first, row.last);
            inner.push(`<div class="gvx-row" role="listitem" aria-label="${esc(`${fmtDate(row.day)}: ${Sessions.formatDuration(row.hours)}, ${when}`)}">
              ${date}${bar(row.hours, longestDay)}<span class="gvx-row-when" aria-hidden="true">${when}</span>${dur}
            </div>`);
          } else {
            // more than one session that day: a button that opens them
            const dayOpen = openState.day === row.day;
            const subs = dayOpen ? row.items.map((it) => `<div class="gvx-row is-sub" role="listitem" aria-label="${esc(`${hhmmRange(it.start, it.end)}: ${Sessions.formatDuration(it.duration)}`)}">
                <span class="gvx-row-date" aria-hidden="true"></span>${bar(it.duration, longestDay)}
                <span class="gvx-row-when" aria-hidden="true">${hhmmRange(it.start, it.end)}</span>
                <span class="gvx-row-dur" aria-hidden="true">${Sessions.formatDuration(it.duration)}</span>
              </div>`).join('') : '';
            inner.push(`<div class="gvx-dgroup${dayOpen ? ' is-open' : ''}">
              <button type="button" class="gvx-row is-many" data-day="${row.day}" aria-expanded="${dayOpen}" aria-label="${esc(`${fmtDate(row.day)}: ${Sessions.formatDuration(row.hours)} in ${row.count} sessions. ${dayOpen ? 'Hide' : 'Show'} them`)}">
                ${date}${bar(row.hours, longestDay)}<span class="gvx-row-when" aria-hidden="true">${row.count} sessions ${CHEV}</span>${dur}
              </button>${subs ? `<div class="gvx-dsubs">${subs}</div>` : ''}
            </div>`);
          }
        }
        rendered += 1;
      }
      rows.push(`<div class="gvx-mgroup is-open">${head}<div class="gvx-mdays">${inner.join('')}</div></div>`);
    }
    const totalRows = book.months.reduce((n, m) => n + (openState.month === m.key ? m.rows.length : 0), 0);
    listEl.onclick = async (e) => {
      const btn = e.target.closest && e.target.closest('[data-month], [data-day]');
      if (!btn || listEl._folding) return;
      const isMonth = !!btn.dataset.month;
      const shut = listEl.querySelector(isMonth ? '.gvx-mgroup.is-open .gvx-mdays' : '.gvx-dgroup.is-open .gvx-dsubs');
      let sel;
      if (isMonth) {
        const key = btn.dataset.month;
        openState.month = openState.month === key ? null : key;
        openState.day = null;
        sel = `[data-month="${key}"]`;
      } else {
        const day = Number(btn.dataset.day);
        openState.day = openState.day === day ? null : day;
        sel = `[data-day="${day}"]`;
      }
      const opening = isMonth ? !!openState.month : openState.day != null;
      const calm = prefersReducedMotion();
      listEl._folding = true;
      try {
        // the open one folds shut first (its arrow turning back with it)
        if (shut && !calm) {
          const arrow = shut.parentElement.querySelector(isMonth ? '.gvx-month svg' : '.gvx-row.is-many svg');
          if (arrow) arrow.style.transform = 'none';
          await foldTo(shut, 0, 170);
        }
        paintLedger(g);
        const again = listEl.querySelector(sel);
        if (again) {
          again.focus({ preventScroll: true });
          // a month that opened above the fold stays where the click was
          again.scrollIntoView({ block: 'nearest', behavior: calm ? 'auto' : 'smooth' });
        }
        // then the new one unfolds
        const body = opening && listEl.querySelector(isMonth ? '.gvx-mgroup.is-open .gvx-mdays' : '.gvx-dgroup.is-open .gvx-dsubs');
        if (body && !calm) {
          const arrow = body.parentElement.querySelector(isMonth ? '.gvx-month svg' : '.gvx-row.is-many svg');
          if (arrow) arrow.animate([{ transform: 'none' }, { transform: 'rotate(90deg)' }], { duration: 200, easing: 'cubic-bezier(0.22, 0.8, 0.3, 1)' });
          await foldTo(body, null, 240);
        }
      } finally {
        listEl._folding = false;
      }
    };

    if (rows.length) {
      listEl.innerHTML = rows.join('');
      if (totalRows > MAX_ROWS) {
        listEl.insertAdjacentHTML('beforeend', `<div class="gvx-more">Showing the latest ${MAX_ROWS} days. Older play is in the totals above.</div>`);
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

  // Fold a box open (to its own height, `to` null) or shut (0), smoothly.
  function foldTo(el, to, ms) {
    const full = el.scrollHeight;
    const from = to === 0 ? full : 0;
    const end = to === 0 ? 0 : full;
    el.style.overflow = 'hidden';
    const anim = el.animate([
      { height: `${from}px`, opacity: from ? 1 : 0 },
      { height: `${end}px`, opacity: end ? 1 : 0 },
    ], { duration: ms, easing: 'cubic-bezier(0.22, 0.8, 0.3, 1)', fill: to === 0 ? 'forwards' : 'none' });
    return anim.finished.catch(() => {}).then(() => { if (to !== 0) el.style.overflow = ''; });
  }

  const LIVE_STALE_MS = 6000;
  function startDetailTick(g) {
    stopDetailTick();
    const live = state.live[String(g.id)];
    if (typeof live !== 'number') return;
    if (state.liveStart == null) state.liveStart = {};
    state.liveStart[String(g.id)] = Date.now() - live * 60000;

    const paint = () => {
      const valueEl = document.querySelector('[data-timer-value]');
      if (!valueEl || typeof state.live[String(g.id)] !== 'number') { stopDetailTick(); return; }
      // The tracker reports every few seconds while it sees the game. When the
      // reports stop (the game closed; the session is saved after a short wait
      // in case it comes back), the clock stops too instead of running on.
      const seen = state.liveSeen && state.liveSeen[String(g.id)];
      const now = seen ? Math.min(Date.now(), seen + LIVE_STALE_MS) : Date.now();
      const elapsed = Math.max(0, now - state.liveStart[String(g.id)]);
      valueEl.textContent = Sessions.formatClock(elapsed);
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
    if (countEl) countEl.textContent = ledgerCountText(gvSessions(g));
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

  // A switch, not a label: it says what it is now, and on hover what a click
  // does.
  function finishButtonHtml(done) {
    return `<button class="gvx-chip gvx-fin${done ? ' is-done' : ''}" data-finish aria-pressed="${done}" title="${done ? 'You finished this game. Click if you haven\'t' : 'Mark this game as finished'}">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12.5 4.5 4.5L19 7"/></svg>
              <span class="gvx-fin-now">${done ? 'Finished' : 'Mark as finished'}</span>${done ? '<span class="gvx-fin-undo">Mark not finished</span>' : ''}
            </button>`;
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
      btn.outerHTML = finishButtonHtml(!!value);
      const fresh = view.querySelector('[data-finish]');
      fresh.onclick = () => setFinished(g, !(g.status === 'Finished'));
      fresh.focus({ preventScroll: true });
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
    g.status = statusOutOfWishlist(g);
    delete g.wishRank;
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
    const liveNow = state.live[String(g.id)];
    if (liveNow != null && typeof liveNow !== 'number') {
      toast(`Wait until ${g.name || 'the game'} has ${liveNow === 'stopping' ? 'stopped' : 'started'}, then remove it`, 'error');
      return;
    }
    // running (or always running, like a wallpaper app): timing stops, the
    // program itself stays open
    const running = typeof liveNow === 'number';
    const card = openModal(`
      <div class="modal-head">
        <h2>Remove from library?</h2>
        <button class="close-x" data-close aria-label="Close">✕</button>
      </div>
      <div class="modal-body rm-body">
        <p class="rm-text"><b>${esc(g.name || 'Untitled')}</b> leaves your library, with its playtime and sessions. The game's files stay on your PC.${running ? ' It’s running now: GameVault stops timing it, and leaves it open.' : ''}</p>
      </div>
      <div class="modal-foot">
        <button class="btn btn-ghost" data-close data-autofocus>Cancel</button>
        <button class="btn btn-danger" data-rm>Remove</button>
      </div>`, { className: 'rm-modal' });
    if (!card) return;
    for (const btn of card.querySelectorAll('[data-close]')) btn.onclick = closeModal;
    card.querySelector('[data-rm]').onclick = () => {
      closeModal();
      const id = String(g.id);
      // it may have started while the dialog was open (tray, outside GameVault):
      // end its session first so the hours are in the game Undo brings back
      if (state.live[id] == null) { removeGame(g); return; }
      if (api.trackingStop) api.trackingStop(g.id);
      const t0 = Date.now();
      const wait = () => {
        if (state.live[id] == null || Date.now() - t0 > 3000) {
          delete state.live[id];
          if (state.liveStart) delete state.liveStart[id];
          removeGame(g);
        } else setTimeout(wait, 100);
      };
      wait();
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
    // remembered so auto sync doesn't bring it back: by its import id, and
    // by its Steam id too (games added by hand or synced from another PC
    // have no import id)
    const ignoredKeys = [...new Set([g.sourceId, g.steamAppId ? `steam:${g.steamAppId}` : ''].filter(Boolean))];
    importIgnoreMany(ignoredKeys, true, g.name);
    if (state.shelfId === id) state.shelfId = near ? String(near.id) : null;
    state._shelfKey = '';
    renderLibrary();
    saveGamesSoon();
    // focus lands on the neighbour once the dialog has closed
    setTimeout(() => focusGameIfLost(near), 360);
    toast(`${g.name || 'Game'} removed from your library`, 'ok', [{ label: 'Undo', run: () => {
      if (state.games.includes(g)) return;
      importIgnoreMany(ignoredKeys, false);
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

  // The game page's ⋯ menu sits in the header, which clips (the artwork must
  // stay inside it). In a short window the menu runs past the header's bottom
  // and got cut off: then it's pinned to the window under its button instead.
  function placeDetailMenu(menu, btn) {
    const reset = () => { menu.style.position = ''; menu.style.top = ''; menu.style.right = ''; menu.style.zIndex = ''; };
    reset();
    const hero = menu.closest('.gvx-hero');
    if (!hero) return;
    if (menu.getBoundingClientRect().bottom <= hero.getBoundingClientRect().bottom - 4) return;
    const b = btn.getBoundingClientRect();
    const top = Math.round(b.bottom + 6);
    menu.style.position = 'fixed';
    menu.style.top = `${top}px`;
    menu.style.right = `${Math.round(window.innerWidth - b.right)}px`;
    menu.style.zIndex = '60';
    // a transformed parent would make "fixed" relative to it: then keep it as it was
    if (Math.abs(menu.getBoundingClientRect().top - top) > 2) reset();
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
        if (open) placeDetailMenu(menu, menuBtn);
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
        else if (item.hasAttribute('data-to-wish')) toggleDetailWish(g);
        else if (item.hasAttribute('data-remove-game')) askRemoveGame(g);
      });
      view.onpointerdown = (e) => { if (!e.target.closest('.gvx-more-wrap')) closeMenu(); };
      // a menu pinned to the window would float away from its button on scroll
      if (view.__gvMenuScroll) view.removeEventListener('scroll', view.__gvMenuScroll, true);
      view.__gvMenuScroll = () => { if (!menu.hidden) closeMenu(); };
      view.addEventListener('scroll', view.__gvMenuScroll, true);
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
  // ---- PEAK: a scrap of old paper ripped across the top of the cover, PEAK
  // typed on it, and rough patches of the cover's own colours on it (top
  // right, bottom left). Drawn as SVG; its tear, patches and typing come from
  // the game's id, so each Peak game has its own scrap and it never changes.
  const PEAK_BAND = '<span class="ps-slot"></span>';
  const strapHtml = (g, extra = '', open = true) => `<span class="peak-strap is-chip${extra}" data-id="${esc(String(g.id))}"${open ? ' data-peak-open title="Your best game ever"' : ''}>${PEAK_BAND}</span>`;
  function ratingChipHtml(r, id = '') {
    if (!r) return '';
    return r >= Rating.PEAK ? strapHtml({ id }, ' is-sm') : `<span class="rate-chip tier-${Rating.tier(r)}">${STAR_ICON}<span>${Rating.label(r)}</span></span>`;
  }
  function seedOf(s) {
    let h = 2166136261;
    for (const ch of String(s)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  function seededRand(seed) {
    let a = seed || 1;
    return () => {
      a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  let peakSvgN = 0;
  function peakSvg(id, chip) {
    const rand = seededRand(seedOf(`${id}${chip ? ':chip' : ''}`));
    const r = (lo, hi) => lo + rand() * (hi - lo);
    const f = (v) => v.toFixed(1);
    const W = chip ? 132 : 240, H = chip ? 46 : 48;
    const p = `ps${++peakSvgN}`;
    // a torn edge: many short steps that wander, with the odd deep bite
    const tear = (x0, y0, x1, y1, amp) => {
      const out = [];
      const len = Math.hypot(x1 - x0, y1 - y0) || 1;
      const nx = -(y1 - y0) / len, ny = (x1 - x0) / len;
      const steps = Math.max(3, Math.round(len / r(2.8, 4.2)));
      let off = 0;
      for (let i = 0; i < steps; i++) {
        off = off * 0.6 + (rand() - 0.5) * amp + (rand() < 0.03 ? (rand() - 0.5) * amp * 2 : 0);
        const t = i / steps;
        out.push([x0 + (x1 - x0) * t + nx * off, y0 + (y1 - y0) * t + ny * off]);
      }
      return out;
    };
    const path = (pts) => `M${pts.map(([x, y]) => `${f(x)} ${f(y)}`).join('L')}Z`;
    // the scrap's outline: uneven height, one end thicker than the other
    const tl = chip ? [r(0, 6), r(1, 7)] : [-3, r(0, 8)];
    const tm1 = [W * r(0.25, 0.42), r(0, 9)], tm2 = [W * r(0.58, 0.75), r(0, 9)];
    const tr = chip ? [W - r(0, 6), r(1, 7)] : [W + 3, r(0, 8)];
    const br = chip ? [W - r(0, 6), H - r(1, 7)] : [W + 3, H - r(0, 8)];
    const bm2 = [W * r(0.58, 0.75), H - r(0, 9)], bm1 = [W * r(0.25, 0.42), H - r(0, 9)];
    const bl = chip ? [r(0, 6), H - r(1, 7)] : [-3, H - r(0, 8)];
    const corners = [tl, tm1, tm2, tr, br, bm2, bm1, bl];
    const outline = (amp, inset) => {
      const c = corners.map(([x, y], i) => {
        const top = i < 4;
        const side = chip && (i === 0 || i === 7) ? inset : chip && (i === 3 || i === 4) ? -inset : 0;
        return [x + side, y + (top ? inset : -inset)];
      });
      let pts = [];
      for (let i = 0; i < c.length; i++) {
        const [x0, y0] = c[i], [x1, y1] = c[(i + 1) % c.length];
        const straight = !chip && (i === 3 || i === 7);
        pts = pts.concat(straight ? [[x0, y0]] : tear(x0, y0, x1, y1, amp));
      }
      return path(pts);
    };
    const outer = outline(1.4, 0);
    const inner = outline(1.1, 1.5);
    // a faint age stain (the only soft shape on the scrap)
    const blob = (cx, cy, rx, ry) => {
      const k = 8 + Math.floor(rand() * 5), a0 = rand() * 6.283, pts = [];
      for (let i = 0; i < k; i++) {
        const a = a0 + (i / k) * 6.283, m = r(0.6, 1.18);
        pts.push([cx + Math.cos(a) * rx * m, cy + Math.sin(a) * ry * m]);
      }
      const mid = (u, v) => [(u[0] + v[0]) / 2, (u[1] + v[1]) / 2];
      const s0 = mid(pts[0], pts[1]);
      let d = `M${f(s0[0])} ${f(s0[1])}`;
      for (let i = 1; i <= k; i++) {
        const c = pts[i % k], m = mid(pts[i % k], pts[(i + 1) % k]);
        d += `Q${f(c[0])} ${f(c[1])} ${f(m[0])} ${f(m[1])}`;
      }
      return `${d}Z`;
    };
    // colour: torn pieces of the cover's colours running top to bottom, one at
    // each end, each with a thin torn strip of another colour peeking out
    // from under it. Straight-ish torn edges, no round shapes; the typed word
    // keeps the middle.
    const strip = (xTop, xBot, right) => {
      const far = right ? W + 6 : -6;
      return path([...tear(xTop, -4, xBot, H + 4, chip ? 2.8 : 3.6), [xBot, H + 4], [far, H + 4], [far, -4]]);
    };
    // every piece leans: its top and bottom land well apart, either way
    // round, so sometimes the top reaches further and sometimes the bottom
    const lean = ([lo, hi], [min, max]) => {
      const base = W * r(lo, hi);
      const off = W * (chip ? r(0.05, 0.1) : r(0.07, 0.15)) * (rand() < 0.5 ? -1 : 1);
      const clamp = (v) => Math.min(W * max, Math.max(W * min, v));
      return [clamp(base + off / 2), clamp(base - off / 2)];
    };
    const [rT, rB] = lean(chip ? [0.82, 0.9] : [0.73, 0.82], chip ? [0.78, 0.97] : [0.69, 0.9]);
    const [lT, lB] = lean(chip ? [0.1, 0.17] : [0.18, 0.27], chip ? [0.03, 0.22] : [0.1, 0.31]);
    const sl = chip ? [2, 7] : [2, 12];
    const pieceR = strip(rT, rB, true);
    const pieceL = strip(lT, lB, false);
    const sliverR = strip(rT - r(...sl), rB - r(...sl), true);
    const sliverL = strip(lT + r(...sl), lB + r(...sl), false);
    const stain = blob(W * r(0.3, 0.7), H * r(0.3, 0.7), W * r(0.15, 0.3), H * r(0.4, 0.7));
    // typed: a typewriter face, each letter a little off its line and inked unevenly
    const fs = chip ? 19 : 21, step = fs * 0.8;
    const x0 = W / 2 - step * 1.5, y0 = H / 2 + fs * 0.34;
    const letters = 'PEAK'.split('').map((ch, i) => {
      const x = x0 + i * step + r(-0.6, 0.6), y = y0 + r(-0.9, 0.9), rot = r(-4, 4), o = r(0.74, 0.95);
      return `<text x="${f(x)}" y="${f(y)}" transform="rotate(${f(rot)} ${f(x)} ${f(y)})" fill-opacity="${o.toFixed(2)}" text-anchor="middle">${ch}</text>`;
    }).join('');
    return `<svg class="ps-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="Peak">`
      + '<defs>'
      + `<clipPath id="${p}o"><path d="${outer}"/></clipPath>`
      + `<clipPath id="${p}p"><path d="${inner}"/></clipPath>`
      + `<filter id="${p}g" x="0" y="0" width="100%" height="100%"><feTurbulence type="fractalNoise" baseFrequency="0.8" numOctaves="3" seed="4" stitchTiles="stitch"/><feColorMatrix values="0 0 0 0 0.36 0 0 0 0 0.27 0 0 0 0 0.16 0 0 0 0.5 -0.06"/></filter>`
      + `<filter id="${p}f" x="0" y="0" width="100%" height="100%"><feTurbulence type="fractalNoise" baseFrequency="0.018 0.42" numOctaves="2" seed="9"/><feColorMatrix values="0 0 0 0 0.45 0 0 0 0 0.34 0 0 0 0 0.2 0 0 0 0.55 -0.12"/></filter>`
      + `<filter id="${p}i" x="-10%" y="-20%" width="120%" height="140%"><feTurbulence type="fractalNoise" baseFrequency="0.95" numOctaves="1" seed="${seedOf(id) % 89}"/><feDisplacementMap in="SourceGraphic" scale="1.2"/></filter>`
      + '</defs>'
      + `<path d="${outer}" fill="#f7f1e3"/>`
      + `<g clip-path="url(#${p}o)">`
      + `<path d="${inner}" fill="#e8dcc2"/>`
      + `<g clip-path="url(#${p}p)">`
      + `<path d="${stain}" fill="#b8904f" opacity="0.13"/>`
      + `<path class="ps-b ps-b3" d="${sliverR}" fill="var(--s3)"/>`
      + `<path class="ps-b ps-b4" d="${sliverL}" fill="var(--s4)"/>`
      + `<path class="ps-b ps-b1" d="${pieceR}" fill="var(--s1)"/>`
      + `<path class="ps-b ps-b2" d="${pieceL}" fill="var(--s2)"/>`
      + '</g>'
      + `<rect width="${W}" height="${H}" filter="url(#${p}g)" style="mix-blend-mode:multiply"/>`
      + `<rect width="${W}" height="${H}" filter="url(#${p}f)" style="mix-blend-mode:multiply"/>`
      + `<path d="${inner}" fill="none" stroke="#8a6230" stroke-opacity="0.35" stroke-width="0.9"/>`
      + '</g>'
      + `<g class="ps-type" filter="url(#${p}i)" fill="#16110d" font-family="'Courier New', Courier, monospace" font-weight="700" font-size="${fs}">${letters}</g>`
      + '</svg>';
  }
  // colours: asked of main once per cover, then kept
  const peakPalettes = new Map();
  function paintPeak(el) {
    const id = el.dataset.id;
    const g = state.games.find((x) => String(x.id) === String(id));
    const cover = g ? (g._cover || g.coverUrl || '') : '';
    const src = cover ? toFileUrl(cover) : '';
    const key = `${id}|${src}`;
    if (el.dataset.ps === key && el.querySelector('svg')) return;
    el.dataset.ps = key;
    el.innerHTML = peakSvg(id, el.classList.contains('is-chip'));
    const apply = (pal) => {
      if (!pal || !pal.colors || !pal.colors.length || el.dataset.ps !== key) return;
      // a colour close to the paper itself would vanish on it: those go last
      const far = (hex) => {
        const n = parseInt(String(hex).slice(1), 16);
        return Math.hypot(((n >> 16) & 255) - 232, ((n >> 8) & 255) - 220, (n & 255) - 194) > 70;
      };
      const cols = [...pal.colors.filter(far), ...pal.colors.filter((c) => !far(c))];
      for (let i = 0; i < 4; i++) el.style.setProperty(`--s${i + 1}`, cols[i % cols.length]);
    };
    if (!src || !api.palette) return;
    const hit = peakPalettes.get(src);
    if (hit === null) return;
    if (hit && !(hit instanceof Promise)) { apply(hit); return; }
    const job = hit || api.palette(src).catch(() => null).then((res) => { peakPalettes.set(src, res || null); return res; });
    peakPalettes.set(src, job);
    job.then(apply);
  }
  let peakPaintQ = 0;
  function paintPeaksSoon() {
    if (peakPaintQ) return;
    peakPaintQ = requestAnimationFrame(() => {
      peakPaintQ = 0;
      for (const el of document.querySelectorAll('.peak-strap[data-id]')) paintPeak(el);
    });
  }
  new MutationObserver(paintPeaksSoon).observe(document.body, { childList: true, subtree: true });

  function rateButtonHtml(g) {
    const r = Rating.value(g);
    const tier = Rating.tier(r);
    if (r >= Rating.PEAK) return `<button class="gvx-rate peak-strap is-chip is-btn" data-rate data-id="${esc(String(g.id))}" title="Your rating: PEAK. Click to change">${PEAK_BAND}</button>`;
    const inner = !r
      ? `${STAR_ICON}<span>Rate</span>`
      : `${STAR_ICON}<span>${Rating.label(r)}</span><small>/10</small>`;
    return `<button class="gvx-chip gvx-rate${tier ? ` tier-${tier}` : ''}" data-rate title="${r ? 'Your rating: click to change' : 'Rate this game'}">${inner}</button>`;
  }

  // ---- PEAK scroll: clicking a Peak scrap brings out an old paper, torn
  // like the scrap and rolled up, that flies out of the scrap and unrolls
  // down the page. Typed on it: PEAK; the
  // game as a museum label (its own one-line description, who made it, the
  // year); and where it stands on your shelf (how many Peak games there are,
  // and the games it sits above). Nothing from GameVault's own hours,
  // sessions or dates: those start when it was installed, so they say
  // nothing true about an old favourite. "Roll it up" rolls it back.
  function peakLabel(g) {
    const m = g.steamMeta || {};
    // SteamGridDB's year is the game's first release on any platform; Steam's
    // is only its PC release (RDR2: 2018 vs 2019), so Steam is the fallback
    const steamYear = m.release && !m.release.soon && (String(m.release.date || '').match(/\b(19|20)\d{2}\b/) || [])[0];
    const year = Number(g.firstYear) > 1970 ? String(g.firstYear) : steamYear;
    const line = [m.developer || g.developer || '', year || '', Array.isArray(m.genres) && m.genres[0] ? m.genres[0] : '']
      .filter(Boolean).join(' · ');
    // a critic's line (or, when none fits, one written for someone who
    // already loves the game), never the store's pitch
    const c = criticsOf(g);
    return { line, about: (c && c.line) || '', by: (c && c.by) || '' };
  }
  // What critics said about a game: OpenCritic's score and one line, from
  // the cloud (peak-line), once per game. Asked for when a game first
  // becomes PEAK and when a rated game's page opens.
  function criticsOf(g) {
    const v = (state._peakLines || {})[peakLineKey(g)];
    return v && typeof v === 'object' ? v : null;
  }
  const criticsAsked = new Map();
  function loadCritics(g) {
    if (!api.peakLine || !g) return Promise.resolve(null);
    const id = String(g.id);
    if (criticsAsked.has(id)) return criticsAsked.get(id);
    const p = (peakLineKey(g) ? Promise.resolve() : peakAppId(g).catch(() => null)).then(() => {
      const key = peakLineKey(g);
      if (!key) return null;
      return api.peakLine([{ steamAppId: storeAppId(g) || undefined, itadId: g.itadId || undefined }]).then((res) => {
        const v = res && res.ok && res.data ? res.data[key] : null;
        if (!v) return null;
        state._peakLines = { ...(state._peakLines || {}), [key]: v };
        // the game's page, if it is open: score in the hero line, quote in About
        if (state.selectedId === id && !gvIsWishlisted(g)) {
          const metaEl = document.querySelector('#game-view .gvx-meta');
          if (metaEl) metaEl.innerHTML = detailMeta(g);
          paintRail(g);
        }
        return v;
      });
    }).catch(() => null);
    criticsAsked.set(id, p);
    // asked again on the next visit after a while (a stand-in may be replaced)
    p.then(() => setTimeout(() => criticsAsked.delete(id), 10 * 60 * 1000));
    return p;
  }
  function peakLineKey(g) {
    const n = storeAppId(g);
    if (n) return `steam:${n}`;
    return g.itadId ? `itad:${String(g.itadId).toLowerCase()}` : '';
  }
  function peakStanding(g) {
    const owned = state.games.filter((x) => !gvIsWishlisted(x));
    const peaks = owned.filter((x) => Rating.value(x) >= Rating.PEAK).length;
    const head = peaks <= 1
      ? `Your only Peak game, in a vault of ${owned.length}.`
      : `One of ${peaks} Peak games in a vault of ${owned.length}.`;
    const below = owned
      .filter((x) => x !== g && Rating.value(x) > 0 && Rating.value(x) < Rating.PEAK)
      .sort((a, b2) => Rating.value(b2) - Rating.value(a))
      .slice(0, 3)
      .map((x) => [x.name || 'Untitled', Rating.label(Rating.value(x))]);
    return { head, below };
  }
  // the cover's colours for the letter, the same order the scrap uses
  function peakColors(g) {
    const cover = g._cover || g.coverUrl || '';
    const src = cover ? toFileUrl(cover) : '';
    if (!src || !api.palette) return Promise.resolve(null);
    const hit = peakPalettes.get(src);
    const job = hit && !(hit instanceof Promise) ? Promise.resolve(hit) : hit === null ? Promise.resolve(null)
      : (hit || api.palette(src).catch(() => null));
    return job.then((pal) => {
      if (!pal || !pal.colors || !pal.colors.length) return null;
      const far = (hex) => {
        const n = parseInt(String(hex).slice(1), 16);
        return Math.hypot(((n >> 16) & 255) - 232, ((n >> 8) & 255) - 220, (n & 255) - 194) > 70;
      };
      return [...pal.colors.filter(far), ...pal.colors.filter((c) => !far(c))];
    });
  }
  // torn corner pieces for the letter, drawn over the whole sheet
  function peakLetterArt(id, W, H) {
    const rand = seededRand(seedOf(`${id}:letter`));
    const r = (lo, hi) => lo + rand() * (hi - lo);
    const f = (v) => v.toFixed(1);
    const tear = (x0, y0, x1, y1, amp) => {
      const out = [];
      const len = Math.hypot(x1 - x0, y1 - y0) || 1;
      const nx = -(y1 - y0) / len, ny = (x1 - x0) / len;
      const steps = Math.max(3, Math.round(len / r(3, 4.6)));
      let off = 0;
      for (let i = 0; i < steps; i++) {
        off = off * 0.6 + (rand() - 0.5) * amp + (rand() < 0.04 ? (rand() - 0.5) * amp * 2 : 0);
        const t = i / steps;
        out.push([x0 + (x1 - x0) * t + nx * off, y0 + (y1 - y0) * t + ny * off]);
      }
      return out;
    };
    const piece = (a, b, rest) => `M${[...tear(a[0], a[1], b[0], b[1], 4), ...rest].map(([x, y]) => `${f(x)} ${f(y)}`).join('L')}Z`;
    // top right: a torn edge leaning across the corner
    const tr0 = [W * r(0.64, 0.76), -6], tr1 = [W + 6, H * r(0.1, 0.17)];
    const trS = [tr0[0] - r(6, 16), -6], trS1 = [W + 6, tr1[1] + r(6, 16)];
    // bottom left
    const bl0 = [W * r(0.2, 0.3), H + 6], bl1 = [-6, H * r(0.86, 0.92)];
    const blS = [bl0[0] + r(6, 16), H + 6], blS1 = [-6, bl1[1] - r(6, 16)];
    return `<svg class="pkl-art" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" aria-hidden="true">`
      + `<path d="${piece(trS, trS1, [[W + 6, -6]])}" fill="var(--s3)"/>`
      + `<path d="${piece(tr0, tr1, [[W + 6, -6]])}" fill="var(--s1)"/>`
      + `<path d="${piece(blS, blS1, [[-6, H + 6]])}" fill="var(--s4)"/>`
      + `<path d="${piece(bl0, bl1, [[-6, H + 6]])}" fill="var(--s2)"/>`
      + '</svg>';
  }

  function peakLetterOutline(id, W, H) {
    const rand = seededRand(seedOf(`${id}:sheet`));
    const r = (lo, hi) => lo + rand() * (hi - lo);
    const tear = (x0, y0, x1, y1, amp) => {
      const out = [];
      const len = Math.hypot(x1 - x0, y1 - y0) || 1;
      const nx = -(y1 - y0) / len, ny = (x1 - x0) / len;
      const steps = Math.max(3, Math.round(len / r(2.8, 4.4)));
      let off = 0;
      for (let i = 0; i < steps; i++) {
        off = off * 0.6 + (rand() - 0.5) * amp + (rand() < 0.04 ? (rand() - 0.5) * amp * 2.2 : 0);
        const t = i / steps;
        out.push([x0 + (x1 - x0) * t + nx * off, y0 + (y1 - y0) * t + ny * off]);
      }
      return out;
    };
    // the corners, the edges wandering in between; one corner torn right off
    const torn = Math.floor(rand() * 4);
    const corner = (i, x, y, sx, sy) => (i === torn
      ? [[x + sx * r(22, 40), y + sy * r(1, 5)], [x + sx * r(1, 5), y + sy * r(22, 40)]]
      : [[x + sx * r(2, 9), y + sy * r(2, 9)]]);
    const ring = [
      ...corner(0, 0, 0, 1, 1).reverse(),
      [W * r(0.3, 0.4), r(0, 9)], [W * r(0.6, 0.7), r(0, 9)],
      ...corner(1, W, 0, -1, 1),
      [W - r(0, 9), H * r(0.2, 0.3)], [W - r(0, 9), H * r(0.45, 0.55)], [W - r(0, 9), H * r(0.7, 0.8)],
      ...corner(2, W, H, -1, -1).reverse(),
      [W * r(0.6, 0.7), H - r(0, 9)], [W * r(0.3, 0.4), H - r(0, 9)],
      ...corner(3, 0, H, 1, -1),
      [r(0, 9), H * r(0.7, 0.8)], [r(0, 9), H * r(0.45, 0.55)], [r(0, 9), H * r(0.2, 0.3)],
    ];
    const outline = (amp, inset) => {
      const cx = W / 2, cy = H / 2;
      const c = ring.map(([x, y]) => [x + Math.sign(cx - x) * inset, y + Math.sign(cy - y) * inset]);
      let pts = [];
      for (let i = 0; i < c.length; i++) {
        const [x0, y0] = c[i], [x1, y1] = c[(i + 1) % c.length];
        pts = pts.concat(tear(x0, y0, x1, y1, amp));
      }
      return pts;
    };
    return { outer: outline(2.6, 0), inner: outline(2, 2.6) };
  }

  // the Steam AppID to read a game's description from: its own, or for a
  // game added another way, a Steam store match on the exact title (an
  // edition suffix like GOTY or Definitive is allowed, nothing else)
  async function peakAppId(g) {
    if (g.steamAppId) return g.steamAppId;
    if (g.steamMeta && g.steamMeta.lookupAppId) return g.steamMeta.lookupAppId;
    if (!g.name) return null;
    if (!api.steamSearch) { await matchByTitle([g]).catch(() => false); return storeAppId(g) || null; }
    const key = (x) => String(x || '').toLowerCase().replace(/[\u2122\u00ae\u00a9]/g, '').replace(/[^\p{L}\p{N}]+/gu, '');
    const want = key(g.name);
    const extra = /^(goty|gameoftheyear|definitive|complete|deluxe|ultimate|remastered|enhanced|directorscut|edition)+$/;
    const res = await api.steamSearch(g.name).catch(() => null);
    if (!res || !res.ok || !Array.isArray(res.data)) return null;
    const hit = res.data.slice(0, 8).find((h) => {
      const k = key(h.name);
      return k === want || (k.startsWith(want) && extra.test(k.slice(want.length)));
    });
    if (!hit) {
      // a different name on Steam ("— Remastered", an old SteamGridDB title):
      // IsThereAnyDeal's title match knows the game's AppID
      await matchByTitle([g]).catch(() => false);
      return storeAppId(g) || null;
    }
    g.steamMeta = { ...(g.steamMeta || {}), lookupAppId: hit.appId };
    return hit.appId;
  }

  // the year a game first came out, from SteamGridDB: by its Steam AppID, else
  // only an exact title match (never a guess)
  async function peakFirstYear(g) {
    const res = await api.sgdbResolve({ name: g.name, steamAppId: g.steamAppId || null }).catch(() => null);
    const m = res && res.ok && res.data && res.data.match;
    if (!m || (!g.steamAppId && Number(m.score) < 1000)) return 0;
    const t = Number(m.releaseDate || m.release_date);
    const y = t > 0 ? new Date(t * 1000).getFullYear() : 0;
    return y > 1970 ? y : 0;
  }

  function openPeakShowcase(g, fromEl) {
    if (!g) return;
    const W = 420, P = 156, H = P * 3, ROLL = 58;
    const shape = peakLetterOutline(g.id, W, H);
    const f = (v) => v.toFixed(1);
    const d = (pts) => `M${pts.map(([x, y]) => `${f(x)} ${f(y)}`).join('L')}Z`;
    const stand = peakStanding(g);
    let label = peakLabel(g);
    const writing = () => `
      <div class="pkl-writing" style="width:${W}px;height:${H}px">
        <svg class="pkl-paper" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" aria-hidden="true">
          <path d="${d(shape.outer)}" fill="#f6efdf"/>
          <path d="${d(shape.inner)}" fill="#e9dec4"/>
          <path d="${d(shape.inner)}" fill="none" stroke="#8a6230" stroke-opacity="0.3" stroke-width="1"/>
        </svg>
        ${peakLetterArt(g.id, W, H)}
        <div class="pkl-text">
          <div class="pkl-row"><div class="pkl-word">PEAK</div><div class="pkl-rule"></div></div>
          <div class="pkl-row"><div class="pkl-game">${esc(g.name || 'Untitled')}</div>${label.line ? `<div class="pkl-made">${esc(label.line)}</div>` : ''}${label.about ? `<p class="pkl-about">${label.by ? `“${esc(label.about)}”<span class="pkl-by">— ${esc(label.by)}</span>` : esc(label.about)}</p>` : ''}</div>
          <div class="pkl-row"><p class="pkl-stand">${esc(stand.head)}</p>${stand.below.length
            ? `<div class="pkl-above">It sits above</div><div class="pkl-facts">${stand.below.map(([n, v]) => `<div class="pkl-fact"><span>${esc(n)}</span><i></i><b>${esc(v)}</b></div>`).join('')}</div>`
            : '<p class="pkl-stand is-quiet">Nothing else is rated yet.</p>'}</div>
        </div>
      </div>`;
    // An old scroll: it comes out of the scrap rolled up, then the roll runs
    // down the page and the paper opens behind it. Motion off: just the page.
    const still = prefersReducedMotion();
    const card = openModal(`
      <div class="pkl" style="--pkl-w:${W}px;--pkl-p:${P}px;--pkl-roll:${ROLL}px">
        <div class="pkl-stage">
          <div class="pkl-sheet" data-pkl-sheet${still ? '' : ' style="opacity:0"'}>
            <div class="pkl-reveal" data-pkl-reveal${still ? '' : ' style="clip-path:inset(0 0 100% 0)"'}>
              <div class="pkl-face" style="clip-path:path('${d(shape.outer)}')"><div class="pkl-window">${writing()}</div></div>
            </div>
            ${still ? '' : '<div class="pkl-roll" data-pkl-roll aria-hidden="true"><i class="pkl-roll-lip"></i></div>'}
          </div>
        </div>
        <button type="button" class="pkl-close" data-autofocus data-pkl-close>Roll it up</button>
      </div>`, { className: 'peak-modal' });
    if (!card) return;
    const root = card.querySelector('.pkl');
    // the line gets whatever room the title leaves on the paper: a little
    // smaller when a long title leaves less
    const fitAbout = () => {
      const els = [...root.querySelectorAll('.pkl-about')];
      for (const size of ['', '11.5px']) {
        for (const el of els) el.style.fontSize = size;
        if (!els.length || els[0].scrollHeight <= els[0].clientHeight + 1) return;
      }
    };
    const repaint = () => {
      if (!root.isConnected) return;
      label = peakLabel(g);
      for (const w of root.querySelectorAll('.pkl-window')) w.innerHTML = writing();
      fitAbout();
    };
    fitAbout();
    // the line: from disk when seen before, else fetched once in the cloud
    loadCritics(g).then((v) => { if (v) repaint(); });
    if (api.steamDetails && !(g.steamMeta && g.steamMeta.about)) {
      peakAppId(g).then((appId) => (appId ? api.steamDetails(appId) : null)).then((res) => {
        if (!res || !res.ok || !res.data) return;
        g.steamMeta = { ...(g.steamMeta || {}), ...res.data, version: 3, at: Date.now() };
        saveGamesSoon();
        repaint();
      }).catch(() => {});
    }
    if (!(Number(g.firstYear) > 0) && !g._yearTried && api.sgdbResolve && (g.steamAppId || g.name)) {
      g._yearTried = true;
      peakFirstYear(g).then((y) => {
        if (!y) return;
        g.firstYear = y;
        saveGamesSoon();
        repaint();
      }).catch(() => {});
    }
    peakColors(g).then((cols) => {
      if (!cols || !root.isConnected) return;
      for (let i = 0; i < 4; i++) root.style.setProperty(`--s${i + 1}`, cols[i % cols.length]);
    });
    const sheet = card.querySelector('[data-pkl-sheet]');
    const reveal = card.querySelector('[data-pkl-reveal]');
    const roll = card.querySelector('[data-pkl-roll]');
    const ease = 'cubic-bezier(0.32, 0.72, 0.18, 1)';
    let busy = false;
    // One clock drives both the roll and the paper's edge, so the edge is
    // always under the roll. p is how much is unrolled (0 to 1).
    const paint = (p) => {
      const y = p * H;
      reveal.style.clipPath = p >= 1 ? '' : `inset(-12px -12px ${f(H - y)}px -12px)`;
      // the roll thins as paper comes off it, and is gone at the bottom
      roll.style.transform = `translateY(${f(y)}px) scaleY(${(1 - 0.7 * p).toFixed(3)})`;
      roll.style.opacity = p < 0.94 ? '1' : String(Math.max(0, (1 - p) / 0.06).toFixed(3));
    };
    let rafId = 0;
    let at = 0;          // how far the scroll is unrolled right now (0..1)
    let closing = false; // Roll it up / Esc pressed: the unroll stops where it is
    const run = (from, to, ms, curve) => new Promise((done) => {
      cancelAnimationFrame(rafId);
      const t0 = performance.now();
      const step = (now) => {
        if (closing && to > from) { done(); return; }
        const t = Math.min(1, (now - t0) / Math.max(1, ms));
        at = from + (to - from) * curve(t);
        paint(at);
        if (t < 1 && root.isConnected) rafId = requestAnimationFrame(step); else done();
      };
      rafId = requestAnimationFrame(step);
    });
    // out: quick start, long gentle stop; back: slow start, quick finish
    const easeOut = (t) => 1 - Math.pow(1 - t, 3);
    const easeIn = (t) => t * t * (0.4 + 0.6 * t);
    // where the scrap is, seen from the roll (the sheet turns about the roll)
    const fromScrap = () => {
      const to = roll.getBoundingClientRect();
      const from = fromEl && fromEl.isConnected ? fromEl.getBoundingClientRect() : null;
      if (!from || !from.width) return { dx: 0, dy: 40, sc: 0.5 };
      return {
        dx: (from.left + from.width / 2) - (to.left + to.width / 2),
        dy: (from.top + from.height / 2) - (to.top + to.height / 2),
        sc: Math.max(0.12, Math.min(0.6, from.width / to.width)),
      };
    };

    const unroll = async () => {
      if (still) { sfx('success'); return; }
      busy = true;
      paint(0);
      const { dx, dy, sc } = fromScrap();
      await sheet.animate([
        { transform: `translate(${dx}px, ${dy}px) scale(${sc}) rotate(-9deg)`, opacity: 0.3 },
        { transform: 'translate(0, -8px) scale(1.03) rotate(1.5deg)', opacity: 1, offset: 0.75 },
        { transform: 'rotate(-1.2deg)', opacity: 1 },
      ], { duration: 560, easing: ease, fill: 'both' }).finished.catch(() => {});
      sheet.style.opacity = '';
      if (!root.isConnected || closing) return;
      await run(0, 1, 1250, easeOut);
      busy = false;
      if (root.isConnected && !closing) sfx('success');
    };

    // also while it is still unrolling: it rolls back up from where it is
    const rollUp = async () => {
      if (closing) return;
      if (still) { closeModal(); return; }
      closing = true;
      busy = true;
      await run(at, 0, 760 * Math.max(0.2, at), easeIn);
      if (!root.isConnected) return;
      const { dx, dy, sc } = fromScrap();
      sheet.animate([
        { transform: 'rotate(-1.2deg)', opacity: 1 },
        { transform: `translate(${dx}px, ${dy}px) scale(${sc}) rotate(-9deg)`, opacity: 0 },
      ], { duration: 420, easing: 'cubic-bezier(0.5, 0, 0.75, 0)', fill: 'forwards' })
        .finished.then(() => closeModal()).catch(() => closeModal());
    };

    card.querySelector('[data-pkl-close]').onclick = rollUp;
    requestAnimationFrame(unroll);
  }
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

  function setRating(g, r) {
    const next = Rating.parse(r);
    const prevRating = Rating.value(g);
    if (next === prevRating) return;
    g.rating = next;
    saveGamesSoon();
    state._shelfKey = '';
    const peakChanged = (next >= Rating.PEAK) !== (prevRating >= Rating.PEAK);
    if (next > 0 && !criticsOf(g)) loadCritics(g);
    // PEAK, or rated at all, changes the top row (the "Your rating" label)
    if (state.selectedId === String(g.id) && (peakChanged || !prevRating !== !next)) {
      renderDetail();
    } else if (state.selectedId === String(g.id)) {
      const btn = $('#game-view [data-rate]');
      if (btn) {
        btn.outerHTML = rateButtonHtml(g);
        const fresh = $('#game-view [data-rate]');
        if (fresh) fresh.onclick = () => openRater(g);
      }
      if (!gvIsWishlisted(g)) paintRail(g);
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
          ${steps.map((n) => `<button type="button" class="rt-step${n === 10 ? ' is-peak' : ''}" role="radio" data-rt="${n}" aria-checked="${cur === n}" aria-label="${n === 10 ? 'PEAK (10)' : n}">${n}</button>`).join('')}
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
        : r >= Rating.PEAK ? strapHtml(g, ' is-lg', false)
          : `<b>${Rating.label(r)}</b><small>/ 10</small>`;
      for (const b of stepBtns) b.classList.toggle('is-lit', Number(b.dataset.rt) <= Math.round(r) && r > 0);
    };
    show(cur);
    const done = (r) => { closeModal(); setRating(g, r); };
    // typed text: a number (7, 7.5, 7,5), a PEAK word, or nothing (clears).
    // Anything else keeps the dialog open instead of wiping the rating.
    const typed = () => {
      const t = input.value.trim();
      if (!t) return 0;
      if (/^\d{1,2}([.,]\d)?$/.test(t) || ['peak', 'goated', 'goat'].includes(t.toLowerCase())) return Rating.parse(t);
      return null;
    };
    const saveTyped = () => {
      const r = typed();
      if (r === null) {
        input.classList.add('is-bad');
        input.setAttribute('aria-invalid', 'true');
        input.focus();
        input.select();
        return;
      }
      done(r);
    };
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
    input.oninput = () => {
      input.classList.remove('is-bad');
      input.removeAttribute('aria-invalid');
      const r = typed();
      show(r === null ? cur : r);
    };
    input.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); saveTyped(); } };
    card.querySelector('[data-rt-save]').onclick = saveTyped;
    const clear = card.querySelector('[data-rt-clear]');
    if (clear) clear.onclick = () => done(0);
    // focus never changes what is shown: a whole-number rating starts on its
    // step, anything else (8.5, unrated) on the text box, so Enter alone
    // never rates the game something it wasn't
    const start = Number.isInteger(cur) && cur >= 1 ? stepBtns[cur - 1] : input;
    // the dialog's own first focus must land here too (on step 1 it would show 1 / 10)
    start.setAttribute('data-autofocus', '');
    requestAnimationFrame(() => { start.focus({ preventScroll: true }); if (start === input) input.select(); show(cur); });
  }

  // ---------------------------------------------------------------------------
  // Modals
  // ---------------------------------------------------------------------------

  let modalSeq = 0;

  // A way to find "the same control" again after the page re-rendered it
  // (the rate button, a wishlist card, an Activity row): its id, or its
  // data-* hook inside the game it belongs to.
  function focusKey(el) {
    if (!el || el === document.body || !el.isConnected) return null;
    if (el.id) return `#${CSS.escape(el.id)}`;
    const attr = [...el.attributes].find((a) => a.name.startsWith('data-') && a.name !== 'data-i');
    if (!attr) return null;
    const own = `${el.tagName.toLowerCase()}[${attr.name}${attr.value ? `="${CSS.escape(attr.value)}"` : ''}]${el.dataset.id && attr.name !== 'data-id' ? `[data-id="${CSS.escape(el.dataset.id)}"]` : ''}`;
    const host = el.dataset.id ? null : el.closest('[data-id]');
    return host ? `[data-id="${CSS.escape(host.dataset.id)}"] ${own}` : own;
  }
  function refocus(el, key) {
    const target = el && el.isConnected ? el : (key ? document.querySelector(key) : null);
    if (target && typeof target.focus === 'function' && target.getClientRects().length) {
      target.focus({ preventScroll: true });
      return true;
    }
    return false;
  }

  function openModal(html, { className = '' } = {}) {
    const wrap = $('#modal');
    sfx('open');
    modalSeq += 1;
    // the Big Picture menu gives way to the dialog (the pad must reach it);
    // focus later goes back to what had it before the menu opened
    let menuBack = null;
    if (bp.on && bp.menuOpen) { menuBack = bp.menuReturn; bpCloseMenu({ refocus: false }); }
    // a dialog opened from a dialog that is closing (a menu's Rate or Edit,
    // Try again): keep the first opener, the button it came from is going away
    const a = document.activeElement;
    const fromDialog = !!(a && wrap.contains(a) && state._modalOpener);
    if (!fromDialog) {
      const opener = menuBack && menuBack.isConnected ? menuBack : a;
      state._modalOpener = opener;
      state._modalOpenerKey = focusKey(opener);
    }
    const app = $('#app');
    if (app) app.inert = true;
    wrap.hidden = false;
    wrap.classList.remove('is-closing');
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
    const app = $('#app');
    // nothing open, or already fading out: never restart the timer
    if (wrap.hidden || wrap.classList.contains('is-closing')) {
      if (app && wrap.hidden && !bp.menuOpen && !welcome.isOpen()) app.inert = false;
      return;
    }
    sfx('close');
    const card = wrap.firstElementChild;
    modalSeq += 1;
    const seq = modalSeq;
    const opener = state._modalOpener;
    const openerKey = state._modalOpenerKey;
    if (app && !welcome.isOpen()) app.inert = false;
    if (card) card.classList.remove('is-open');
    // while it fades the dialog lets clicks through to the app underneath
    wrap.classList.add('is-closing');
    setTimeout(() => {
      // a new modal opened in the meantime — this close is stale
      if (seq !== modalSeq) return;
      wrap.hidden = true;
      wrap.classList.remove('is-closing');
      wrap.innerHTML = '';
      if (app && !welcome.isOpen()) app.inert = false;
      refocus(opener, openerKey);
    }, 320);
  }

  // Windows' own setting, or Settings → Appearance → Motion set to Reduced or Off
  const systemReducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  function prefersReducedMotion() {
    const m = document.documentElement.dataset.uiMotion;
    return m === 'reduced' || m === 'off' || systemReducedMotion();
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

  // the dock and top tabs lay their buttons out in a row: the pill runs
  // sideways there (same springs, measured on x)
  const pillAcross = () => !!state.ui && (state.ui.nav === 'dock' || state.ui.nav === 'top');

  function drawSidePill(pill) {
    const t = pillSpring.top.x;
    const h = Math.max(10, pillSpring.bot.x - t);
    if (pillSpring.across) {
      pill.style.transform = `translate(${t.toFixed(2)}px, ${pillSpring.crossAt}px)`;
      pill.style.width = `${h.toFixed(2)}px`;
      pill.style.height = `${pillSpring.crossSize}px`;
    } else {
      pill.style.transform = `translateY(${t.toFixed(2)}px)`;
      pill.style.height = `${h.toFixed(2)}px`;
      pill.style.width = '';
    }
  }

  function syncSidePill() {
    const pill = document.querySelector('.side-pill');
    const side = document.querySelector('.sidebar');
    const active = side && side.querySelector('.side-item.is-active:not(.side-wish):not(.side-act):not([data-rail-action])');
    if (!pill || !side) return;
    pill.classList.toggle('is-away', !active);
    // when it comes back it appears in place instead of flying in
    if (!active) { if (pillSpring.raf) { cancelAnimationFrame(pillSpring.raf); pillSpring.raf = null; } pillSpring.init = false; return; }
    // Pill is absolutely positioned inside the sidebar's padding box. Measured
    // from rects, not offsetTop: while the rail folds its rows are layers
    // (will-change), which would make them the items' offsetParent.
    const sr = side.getBoundingClientRect(), ar = active.getBoundingClientRect();
    const S = pillSpring;
    const across = pillAcross();
    if (across !== !!S.across) { S.across = across; S.init = false; }
    let top, bot;
    if (across) {
      top = Math.round(ar.left - sr.left - side.clientLeft + side.scrollLeft);
      bot = top + active.offsetWidth;
      S.crossAt = Math.round(ar.top - sr.top - side.clientTop);
      S.crossSize = active.offsetHeight;
    } else {
      top = Math.round(ar.top - sr.top - side.clientTop + side.scrollTop);
      bot = top + active.offsetHeight;
    }

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
    const rows = Math.abs(top - S.top.x) / Math.max(1, across ? active.offsetWidth : active.offsetHeight);
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

  // the game already in the vault that a new entry would duplicate: the same
  // Steam AppID, or the same title ignoring case, symbols and spacing
  function findSameGame({ name, steamAppId }) {
    const key = (x) => String(x || '').toLowerCase().replace(/[\u2122\u00ae\u00a9]/g, '').replace(/[^\p{L}\p{N}]+/gu, '');
    const app = Number(steamAppId) || 0;
    if (app) {
      const hit = state.games.find((x) => Number(x.steamAppId) === app);
      if (hit) return hit;
    }
    const k = key(name);
    if (!k) return null;
    // a different AppID on both sides means two different games
    return state.games.find((x) => key(x.name) === k && !(app && x.steamAppId && Number(x.steamAppId) !== app)) || null;
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
      const norm = nameKey;

      // Steam's store search first: free, fast, and a pick brings Steam's own art
      let steamHits = [];
      if (api.steamSearch) {
        const res = await api.steamSearch(q).catch(() => null);
        if (stale()) return;
        if (res && res.ok) {
          steamHits = res.data.slice(0, 6).map((hit) => ({
            kind: 'steam', appId: hit.appId, name: hit.name, meta: 'Steam',
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
          note = 'Artwork search isn’t available right now';
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
        const appEl = card.querySelector('#f-steam');
        if (appEl && src.steamAppId) appEl.value = String(src.steamAppId);
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
        // all four: Steam's own art wins where it has it, SteamGridDB fills
        // the rest (Steam has no icon, and often no logo)
        ? { name, steamAppId, slots: ['cover', 'hero', 'logo', 'icon'] }
        : { id, name }).catch(() => null);
      // stale: a newer pick, a closed dialog, or the title was edited since
      if (seq !== autofillSeq || !alive() || nameInput.value.trim() !== wantName) {
        if (alive() && seq === autofillSeq) renderStrip();   // clear "Fetching…"
        return;
      }
      if (!res || !res.ok) {
        if (artStatus) {
          artStatus.textContent = res && res.error && res.error.code === 'NO_KEY'
            ? 'Artwork search isn’t available right now'
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
      if (artMatch && !artMatch.textContent && chosen && chosen.id) {
        artMatch.textContent = `Matched: ${(chosen && chosen.name) || g.name || nameInput.value}`;
      }
      // keep the row of current picks in view above the picker
      (card.querySelector('#art-summary') || artPanel).scrollIntoView({ block: 'start', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });

      // A game with no SteamGridDB match yet: find which game it is, but never
      // change any art here (opening the picker is not a pick). With a Steam
      // AppID the match is exact; by name alone, ask which game is meant
      // ("God of War" is two games).
      if (!chosen || !chosen.id) {
        const name = (nameInput.value || g.name || '').trim();
        if (!name) {
          artResults.innerHTML = '<div class="art-empty">Search for the game above first.</div>';
          return;
        }
        artResults.innerHTML = '<div class="art-empty">Finding the game…</div>';
        const steamId = ((card.querySelector('#f-steam') || {}).value || g.steamAppId || '').toString().trim();
        if (/^\d+$/.test(steamId) && api.sgdbResolve) {
          const res = await api.sgdbResolve({ name, steamAppId: steamId }).catch(() => null);
          if (!alive() || !art.expanded) return;
          const m = res && res.ok && res.data && res.data.match;
          if (m && m.id && (m.score == null || m.score >= 1000)) {
            chosen = { id: m.id, name: m.name || name };
            if (artMatch) artMatch.textContent = `Matched: ${chosen.name}`;
            loadArtTab(art.tab, 0, false);
            return;
          }
        }
        const hits = api.sgdbGames ? await api.sgdbGames(name).catch(() => null) : null;
        if (!alive() || !art.expanded) return;
        const list = hits && hits.ok && Array.isArray(hits.data) ? hits.data.filter((h) => h && h.id).slice(0, 8) : [];
        if (!list.length) {
          artResults.innerHTML = '<div class="art-empty">No SteamGridDB match. Pick the game from the title dropdown.</div>';
          return;
        }
        const year = (h) => {
          const t = Number(h.releaseDate || h.release_date);
          return t > 0 ? ` (${new Date(t * 1000).getFullYear()})` : '';
        };
        artResults.innerHTML = `<div class="art-which"><div class="art-empty">Which game is it?</div>${list.map((h, i) => `<button type="button" class="btn art-which-btn" data-which="${i}">${esc(h.name)}${year(h)}</button>`).join('')}</div>`;
        for (const b of artResults.querySelectorAll('[data-which]')) {
          b.onclick = () => {
            const h = list[Number(b.dataset.which)];
            chosen = { id: h.id, name: h.name };
            if (artMatch) artMatch.textContent = `Matched: ${h.name}${year(h)}`;
            loadArtTab(art.tab, 0, false);
          };
        }
        return;
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
      const file = await api.pickExe(card.querySelector('#f-exe').value.trim().replace(/^"|"$/g, '') || g.installDir || '');
      if (file) card.querySelector('#f-exe').value = file;
    };

    // Launch & tracking (tracker split): what to open vs what counts as playing.
    const trackModeEl = card.querySelector('#f-track-mode');
    const trackExeEl = card.querySelector('#f-track-exe');
    const trackRow = card.querySelector('[data-track-exe-row]');
    const detectList = card.querySelector('[data-detect-list]');
    trackModeEl.value = ['auto', 'exe', 'steam', 'none'].includes(g.trackMode) ? g.trackMode : (g.trackExe ? 'exe' : 'auto');
    const trackModeAtOpen = trackModeEl.value;
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
      const start = card.querySelector('#f-launch').value.trim().replace(/^"|"$/g, '') || card.querySelector('#f-exe').value.trim().replace(/^"|"$/g, '') || g.installDir || '';
      const file = await api.pickExe(start, 'target');
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
      // zero-width and other invisible characters alone are not a title
      const name = card.querySelector('#f-name').value.trim();
      const nameVisible = name.replace(/[\u200B-\u200F\u2060-\u2064\uFEFF\u00AD\s]+/g, '') !== '';
      // Explorer's "Copy as path" wraps the path in quotes
      const unquote = (v) => v.trim().replace(/^"(.*)"$/s, '$1').trim();
      const exePath = unquote(card.querySelector('#f-exe').value);
      const coverUrl = card.querySelector('#f-cover').value.trim();
      const heroUrl = card.querySelector('#f-hero').value.trim();
      const logoUrl = card.querySelector('#f-logo') ? card.querySelector('#f-logo').value.trim() : '';
      const iconUrl = card.querySelector('#f-icon') ? card.querySelector('#f-icon').value.trim() : '';
      const notes = card.querySelector('#f-notes').value;
      // a store or steam:// link gives its id; other text is refused below
      const steamRaw = card.querySelector('#f-steam').value.trim();
      const steamMatch = /^\d+$/.test(steamRaw) ? [steamRaw, steamRaw]
        : steamRaw.match(/(?:store\.steampowered\.com\/app|steamcommunity\.com\/app|steamdb\.info\/app|steam:\/\/(?:rungameid|run|launch|install|nav\/games\/details))\/(\d+)/i);
      const steamAppId = steamMatch ? Number(steamMatch[1]) || null : null;
      const steamBad = !!steamRaw && !steamMatch;
      // Playtime only changes when the field was edited (against what it
      // showed when the dialog opened, so a session that ended meanwhile
      // keeps its hours); the field shows a rounded value, so an untouched
      // save must not round the real one.
      const hoursEl = card.querySelector('#f-hours');
      const typedHours = Math.max(0, Number(String(hoursEl.value).replace(',', '.')) || 0);
      const hoursEdited = hoursEl.value !== hoursEl.defaultValue && Number.isFinite(typedHours);
      const artTouched = ['#f-cover', '#f-hero', '#f-logo', '#f-icon'].some((sel) => {
        const el = card.querySelector(sel);
        return el && el.value.trim() !== el.defaultValue.trim();
      });
      const launchTarget = unquote(card.querySelector('#f-launch').value);
      const trackExe = trackModeEl.value === 'exe' ? trackExeEl.value.trim() : '';
      // "This program…" with nothing picked falls back to automatic
      const trackMode = trackModeEl.value === 'exe' && !trackExe ? 'auto' : trackModeEl.value;

      const refuse = (msg, sel) => {
        toast(msg, 'error');
        const el = sel && card.querySelector(sel);
        if (el) el.focus();
        saving = false; saveBtnEl.disabled = false;
      };
      if (!name || !nameVisible) { refuse('A title is required', '#f-name'); return; }
      if (steamBad) { refuse('Steam AppID needs the number from the store link, like 1245620', '#f-steam'); return; }
      const looksAbsolute = (v) => /^[a-zA-Z]:[\\/]|^\\\\|^\//.test(v) || /^[a-z][a-z0-9+.-]+:/i.test(v);
      if (exePath && !looksAbsolute(exePath)) { refuse('The .exe needs its full path, like C:\\Games\\Game\\game.exe', '#f-exe'); return; }
      if (launchTarget && !looksAbsolute(launchTarget)) { refuse('“Launch with” needs a full path or a link like steam://…', '#f-launch'); return; }
      // text the number field can't read ('214e', '-') must not save as 0 h
      const hoursBad = card.querySelector('#f-hours');
      if (hoursBad && hoursBad.validity && hoursBad.validity.badInput) {
        toast('Playtime needs a number of hours, like 12.5', 'error');
        hoursBad.focus();
        saving = false; saveBtnEl.disabled = false; return;
      }

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

      // Already have it? The same Steam AppID, or the same title once case
      // and punctuation are ignored. A wishlist entry moves to the library
      // (keeping its art); anything else is not added a second time.
      const dupe = isNew ? findSameGame({ name, steamAppId }) : null;
      if (dupe) {
        const dupeWish = gvIsWishlisted(dupe);
        if (isWish || !dupeWish) {
          closeModal();
          saving = false;
          toast(`${dupe.name} is already ${dupeWish ? 'on your wishlist' : 'in your library'}`, 'error');
          if (!dupeWish) openDetail(dupe.id);
          return;
        }
        const fresh = { cover: coverLocal, hero: heroLocal, logo: logoLocal, icon: iconLocal };
        for (const [slot, field] of [['cover', 'coverUrl'], ['hero', 'heroUrl'], ['logo', 'logoUrl'], ['icon', 'iconUrl']]) {
          if (!dupe[field] && fresh[slot]) { dupe[field] = fresh[slot]; delete dupe['_' + slot]; }
        }
        dupe.wishlisted = false;
        dupe.status = nextStatus;
        delete dupe.wishRank;
        if (!dupe.steamAppId && steamAppId) dupe.steamAppId = steamAppId;
        if (!dupe.sgdbId && chosen) dupe.sgdbId = chosen.id;
        if (exePath) dupe.exePath = exePath;
        if (launchTarget) dupe.launchTarget = launchTarget;
        if (trackMode) { dupe.trackMode = trackMode; dupe.trackExe = trackExe; }
        if (notes && !dupe.notes) dupe.notes = notes;
        if (typedHours > 0) { dupe.hours = typedHours; dupe.hoursSetAt = Date.now(); }
        closeModal();
        saveGamesSoon();
        state._shelfKey = '';
        refreshArt(dupe, { focus: true });
        toast(`${dupe.name} moved from your wishlist to your library`, 'ok');
        saving = false;
        return;
      }

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
        // only what was changed here: art that filled in, a session that
        // ended, a sync from another PC while the dialog was open all stay
        const edited = (sel) => { const el = card.querySelector(sel); return !!el && el.value.trim() !== el.defaultValue.trim(); };
        const patch = {};
        if (edited('#f-name')) patch.name = name;
        if (edited('#f-exe')) patch.exePath = exePath;
        if (edited('#f-cover')) patch.coverUrl = coverLocal;
        if (edited('#f-hero')) patch.heroUrl = heroLocal;
        if (edited('#f-logo')) patch.logoUrl = logoLocal;
        if (edited('#f-icon')) patch.iconUrl = iconLocal;
        if (edited('#f-notes')) patch.notes = notes;
        if (edited('#f-steam')) patch.steamAppId = steamAppId;
        if (edited('#f-launch')) patch.launchTarget = launchTarget;
        if (trackModeEl.value !== trackModeAtOpen || edited('#f-track-exe')) { patch.trackMode = trackMode; patch.trackExe = trackExe; }
        if (finished !== editFinished || wishlisted !== editWish) { patch.status = nextStatus; patch.wishlisted = isWish; }
        if (chosen && chosen.id !== g.sgdbId) patch.sgdbId = chosen.id;
        // art the user set or cleared here is their choice: the automatic
        // fill must not put something back (or swap a wide cover) later
        if (artTouched) Object.assign(patch, { artVersion: 3, heroTried: true, iconTried: true });
        if (hoursEdited) Object.assign(patch, { hours: typedHours, hoursSetAt: Date.now() });
        Object.assign(g, patch);
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

  // ---- import: one set of rules for "is this game already here?" and for
  // turning a found game into a library entry. The import dialog and auto
  // sync both use them.
  const IMPORT_IS_WIN = /Windows/i.test(navigator.userAgent);
  const importNormPath = (p) => {
    let s = String(p || '').trim().replace(/[\\/]+/g, '/').replace(/\/$/, '');
    if (IMPORT_IS_WIN) s = s.toLowerCase();
    return s;
  };
  const importAppId = (x) => {
    const n = Number(x && x.steamAppId);
    if (Number.isFinite(n) && n > 0) return n;
    const m = /^steam(?:-owned|-wishlist)?:(\d+)$/.exec(String((x && x.sourceId) || ''));
    return m ? Number(m[1]) : 0;
  };
  const importNameKey = (x) => String((x && x.name) || '').trim().toLowerCase();
  // real files only: launcher links and shell: entries are not paths
  const importFilePath = (x) => {
    const v = String((x && x.exePath) || '');
    return /^[a-z][a-z0-9+.-]+:(?![\\/])/i.test(v) && !/^[a-z]:[\\/]/i.test(v) ? '' : importNormPath(v);
  };

  function importIndex() {
    const bySource = new Map(), byPath = new Map(), byApp = new Map(), byName = new Map();
    for (const g of state.games) {
      if (g.sourceId) bySource.set(String(g.sourceId), g);
      const p = importFilePath(g);
      if (p && !byPath.has(p)) byPath.set(p, g);
      const app = importAppId(g);
      if (app && !byApp.has(app)) byApp.set(app, g);
      // name only identifies entries that have neither a sourceId nor a path
      if (!g.sourceId && !p && importNameKey(g) && !byName.has(importNameKey(g))) byName.set(importNameKey(g), g);
    }
    return { bySource, byPath, byApp, byName, size: state.games.length };
  }

  function importFind(ix, c) {
    if (c.sourceId && ix.bySource.has(String(c.sourceId))) return ix.bySource.get(String(c.sourceId));
    const p = importFilePath(c);
    if (p && ix.byPath.has(p)) return ix.byPath.get(p);
    const app = importAppId(c);
    if (app && ix.byApp.has(app)) return ix.byApp.get(app);
    if (!c.sourceId && !p) return ix.byName.get(importNameKey(c)) || null;
    return null;
  }

  // A wishlisted game turned up installed (Import or auto sync): it moves to
  // the library, keeping its art and place, with what the scan knows added.
  function wishToLibraryFrom(g, c) {
    if (!g.exePath && c.exePath) g.exePath = c.exePath;
    if (!g.installDir && c.installDir) g.installDir = c.installDir;
    if (!g.steamAppId && c.steamAppId) g.steamAppId = Number(c.steamAppId) || c.steamAppId;
    if (!g.sourceId && c.sourceId) g.sourceId = c.sourceId;
    if (!g.launchTarget && c.launchTarget) g.launchTarget = c.launchTarget;
    if (!(Number(g.hours) > 0) && Number(c.hours) > 0) g.hours = Number(c.hours);
    g.wishlisted = false;
    g.status = statusOutOfWishlist(g);
    delete g.wishRank;
  }

  function gameFromCandidate(c, sourceLabel) {
    const g = {
      id: crypto.randomUUID(),
      name: c.name,
      source: c.source || sourceLabel || 'Import',
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
    };
    // Heroic, Lutris and Bottles games start through their launcher
    if (c.launchTarget) g.launchTarget = String(c.launchTarget);
    return g;
  }

  // ---- auto sync: launchers you switched on are re-read on their own, and
  // games you installed since show up without opening Import.
  const AUTO_SYNC_EVERY = 30 * 60 * 1000;
  let autoSyncBusy = false;
  let autoSyncAt = 0;

  // On for every launcher that can do it, unless you turned it off (stored as false).
  function autoSyncOn(id) { return !(state.config.autoSync && state.config.autoSync[id] === false); }

  async function setAutoSync(id, on) {
    const next = { ...(state.config.autoSync || {}) };
    next[id] = !!on;
    await saveConfigPatch({ autoSync: next });
  }

  // What auto sync has already seen in each launcher. Only games that show up
  // after that are added, so a game you left unticked in Import, or one that was
  // there before auto sync first looked at a launcher you already imported from,
  // is not added behind your back.
  const syncKey = (c) => (c && c.sourceId ? String(c.sourceId) : `name:${importNameKey(c) || ''}`);
  function autoSyncSeen(id) {
    const all = state.config.autoSyncSeen;
    return all && Array.isArray(all[id]) ? all[id] : null;
  }
  function noteAutoSyncSeen(id, found, { merge = false } = {}) {
    const before = autoSyncSeen(id);
    const keys = new Set(merge ? before || [] : []);
    for (const c of found || []) if (c && c.name) keys.add(syncKey(c));
    // unchanged: don't rewrite the settings file every half hour
    if (before && before.length === keys.size && before.every((k) => keys.has(k))) return Promise.resolve();
    return saveConfigPatch({ autoSyncSeen: { ...(state.config.autoSyncSeen || {}), [id]: [...keys] } });
  }

  // Games you removed are remembered so auto sync does not bring them back.
  // Their names are kept too, for Settings → Library → Removed games.
  function importIgnore(sourceId, on, name) {
    importIgnoreMany([sourceId], on, name);
  }
  // one write for all of a game's keys (two writes in a row could race and
  // drop one, which is how an undone removal kept its Steam id ignored)
  function importIgnoreMany(keys, on, name) {
    const ids = (keys || []).filter(Boolean).map(String);
    if (!ids.length) return;
    let list = (Array.isArray(state.config.importIgnored) ? state.config.importIgnored : []).filter((x) => !ids.includes(x));
    const names = { ...(state.config.importIgnoredNames || {}) };
    for (const id of ids) {
      if (on) { list.push(id); if (name) names[id] = String(name).slice(0, 200); } else delete names[id];
    }
    list = list.slice(-3000);
    for (const k of Object.keys(names)) if (!list.includes(k)) delete names[k];
    saveConfigPatch({ importIgnored: list, importIgnoredNames: names });
  }

  /** The removed games as one entry each (a game can have two keys). */
  function removedGames() {
    const list = Array.isArray(state.config.importIgnored) ? state.config.importIgnored : [];
    const names = state.config.importIgnoredNames || {};
    const byName = new Map();
    for (const key of list) {
      const steam = /^steam:(\d+)$/.exec(key);
      const label = names[key] || (steam ? `Steam game ${steam[1]}` : key.replace(/^[a-z-]+:/i, ''));
      const k = (names[key] || key).toLowerCase();
      if (!byName.has(k)) byName.set(k, { name: label, keys: [] });
      byName.get(k).keys.push(key);
    }
    return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  function removedGamesText() {
    const n = removedGames().length;
    return n
      ? `${fmtNum(n)} game${n === 1 ? '' : 's'} you removed won’t come back when GameVault syncs your launchers.`
      : 'Games you remove from your library stay out when GameVault syncs your launchers. None so far.';
  }

  function openRemovedGames() {
    const paint = () => {
      const items = removedGames();
      return items.length
        ? '<div class="rg-list">' + items.map((it, i) => `<div class="rg-row"><span class="rg-name">${esc(it.name)}</span><button type="button" class="btn btn-ghost" data-rg-allow="${i}">Allow again</button></div>`).join('') + '</div>'
        : '<p class="rm-text">No removed games. Anything you remove from your library shows up here.</p>';
    };
    const card = openModal(`
      <div class="modal-head">
        <h2>Removed games</h2>
        <button class="close-x" data-close aria-label="Close">✕</button>
      </div>
      <div class="modal-body rm-body">
        <p class="rm-text">These stay out of your library when GameVault syncs your launchers. Allow one again and the next sync, or an import, can add it back.</p>
        <div data-rg-body>${paint()}</div>
      </div>
      <div class="modal-foot">
        <button class="btn btn-primary" data-close data-autofocus>Done</button>
      </div>`, { className: 'rm-modal rg-modal' });
    if (!card) return;
    for (const b of card.querySelectorAll('[data-close]')) b.onclick = () => { closeModal(); if (state.settingsOpen && state.settingsSection === 'library') { const d = document.querySelector('#st-removed-desc'); if (d) d.textContent = removedGamesText(); } };
    const body = card.querySelector('[data-rg-body]');
    body.addEventListener('click', (e) => {
      const b = e.target.closest('[data-rg-allow]');
      if (!b) return;
      const it = removedGames()[Number(b.dataset.rgAllow)];
      if (!it) return;
      importIgnoreMany(it.keys, false);
      toast(`${it.name} can come back with the next sync`, 'ok');
      body.innerHTML = paint();
      const next = body.querySelector('[data-rg-allow]') || card.querySelector('[data-close].btn');
      if (next) next.focus();
    });
  }

  // Settings → Library: how much artwork is on this PC, and clearing what no game uses
  function wireArtCache(panel) {
    const desc = panel.querySelector('[data-art-size]');
    const btn = panel.querySelector('[data-art-clean]');
    if (!desc || !btn || !api.artCacheInfo) return;
    const show = (info) => {
      if (!desc.isConnected) return;
      if (!info) { desc.textContent = 'Covers and banners saved for your games.'; return; }
      desc.textContent = `${mb(info.bytes)} in ${fmtNum(info.files)} file${info.files === 1 ? '' : 's'}.` +
        (info.unusedFiles ? ` ${mb(info.unusedBytes)} of it belongs to no game any more: Clean up removes that.` : ' All of it is in use.');
      btn.disabled = !info.unusedFiles;
    };
    api.artCacheInfo().then(show).catch(() => show(null));
    btn.onclick = async () => {
      btn.disabled = true;
      await persistGames();
      const res = await api.artCacheClean().catch(() => null);
      if (res && res.ok) toast(`Cleaned up ${mb(res.bytes)} of unused artwork`, 'ok');
      else toast('Couldn’t clean up the artwork', 'error');
      api.artCacheInfo().then(show).catch(() => show(null));
    };
  }

  // Settings → General → Reset all settings
  const RESET_KEYS = ['ui', 'palette', 'uiAt', 'tier', 'padEnabled', 'padGlyphs', 'view', 'sfx', 'sfxVolume', 'sfxTheme', 'sfxNav',
    'startBigPicture', 'closeToTray', 'onGameStart', 'afkMinutes', 'bgDetect', 'updateCheck', 'perfLog',
    'captureShotHotkey', 'captureClipHotkey', 'captureGameAudio', 'captureMic', 'captureFindOthers'];
  function resetAllSettings() {
    const card = openModal(`
      <div class="modal-head">
        <h2>Reset all settings?</h2>
        <button class="close-x" data-close aria-label="Close">✕</button>
      </div>
      <div class="modal-body rm-body">
        <p class="rm-text">The look, sounds, shortcuts, controller, playtime and window settings go back to how they were on a fresh install. Your games, playtime, notes, backups, account and imports stay as they are. GameVault reloads to apply it.</p>
      </div>
      <div class="modal-foot">
        <button class="btn btn-ghost" data-close data-autofocus>Cancel</button>
        <button class="btn btn-danger" data-reset-go>Reset settings</button>
      </div>`, { className: 'rm-modal' });
    if (!card) return;
    for (const b of card.querySelectorAll('[data-close]')) b.onclick = closeModal;
    card.querySelector('[data-reset-go]').onclick = async () => {
      card.querySelector('[data-reset-go]').disabled = true;
      await persistGames();
      const ok = api.configReset ? await api.configReset(RESET_KEYS).catch(() => false) : false;
      if (!ok) { closeModal(); toast('Couldn’t reset the settings', 'error'); return; }
      for (const k of ['gv.palette', 'gv.tier', 'gv.view', 'gv.sort', 'gv.filter']) { try { localStorage.removeItem(k); } catch (_) {} }
      if (api.updateCaptureHotkeys) await api.updateCaptureHotkeys().catch(() => {});
      location.reload();
    };
  }

  // Settings → About → Report a problem
  async function copyProblemReport(version, osName) {
    const gpu = api.gpuStatus ? await api.gpuStatus().catch(() => ({})) : {};
    const fps = await new Promise((resolve) => {
      let n = 0; const t0 = performance.now();
      const beat = (t) => { n += 1; if (t - t0 < 700) requestAnimationFrame(beat); else resolve(Math.round((n * 1000) / (t - t0))); };
      requestAnimationFrame(beat);
    });
    const lines = [
      `GameVault ${version} · ${osName}`,
      `Window ${innerWidth}×${innerHeight} at ${devicePixelRatio}x · ${fps} fps · GPU compositing ${(gpu && gpu.gpu_compositing) || 'unknown'}`,
      `Quality ${state.tier} · palette ${state.palette} · layout ${(state.ui && state.ui.nav) || 'sidebar'} · Big Picture ${bp.on ? 'on' : 'off'}`,
      `${fmtNum(state.games.length)} games · controller ${livePads().length ? 'connected' : 'none'} · signed in ${state.account && state.account.signedIn ? 'yes' : 'no'}`,
    ];
    const text = lines.join('\n');
    let ok = false;
    try { ok = api.uiClipboardWrite ? await api.uiClipboardWrite(text) : (await navigator.clipboard.writeText(text), true); } catch (_) { ok = false; }
    toast(ok ? 'Details copied. Paste them into your bug report.' : 'Couldn’t copy the details', ok ? 'ok' : 'error');
  }

  async function runAutoSync({ only = null, quiet = true } = {}) {
    if (autoSyncBusy || !api.importScan || !api.importSources) return 0;
    // never while a game is running, and not under an open import dialog
    if (Object.values(state.live).some((v) => typeof v === 'number')) {
      if (!quiet) toast('Auto sync waits until your game is closed', 'ok', null, { quiet: true });
      return 0;
    }
    if (document.querySelector('.imp3-modal')) return 0;
    autoSyncBusy = true;
    autoSyncAt = Date.now();
    const added = [];
    try {
      const sources = await api.importSources().catch(() => []);
      const ignored = new Set(Array.isArray(state.config.importIgnored) ? state.config.importIgnored : []);
      const ids = (sources || []).filter((x) => x.sync && x.found && autoSyncOn(x.id) && (!only || x.id === only)).map((x) => x.id);
      for (const id of ids) {
        const src = sources.find((x) => x.id === id);
        const found = await api.importScan(id).catch(() => null);
        if (!Array.isArray(found)) continue;
        let ix = importIndex();
        let seen = autoSyncSeen(id);
        // first look at a launcher you already imported from: what's there now
        // is what you chose, so only later installs are added
        // (a game you added by hand doesn't count, only ones imported from it)
        const fromHere = (c) => {
          const h = c && c.name && importFind(ix, c);
          return !!h && ((c.sourceId && String(h.sourceId || '') === String(c.sourceId)) || h.source === src.label);
        };
        if (!seen && found.some(fromHere)) seen = found.map(syncKey);
        const known = new Set(seen || []);
        for (const c of found) {
          if (!c || !c.name || c.wishlisted) continue;
          if (c.sourceId && ignored.has(String(c.sourceId))) continue;
          // only what can actually be started
          if (!c.exePath && !c.launchTarget && !c.steamAppId) continue;
          const have = importFind(ix, c);
          if (have) {
            // on the wishlist and now installed: it's yours
            if (gvIsWishlisted(have)) { wishToLibraryFrom(have, c); added.push(have); ix = importIndex(); }
            continue;
          }
          if (known.has(syncKey(c))) continue;
          const g = gameFromCandidate(c, src.label);
          state.games.unshift(g);
          added.push(g);
          ix = importIndex();
        }
        // what's installed now is seen; an uninstalled game drops off the list,
        // so installing it again adds it again
        await noteAutoSyncSeen(id, found);
      }
    } catch (e) {
      reportError('autosync', e);
    } finally {
      autoSyncBusy = false;
    }
    if (added.length) {
      saveGamesSoon();
      state._shelfKey = '';
      if (!state.selectedId && !state.settingsOpen) renderLibrary();
      refreshCounts();
      const names = added.slice(0, 2).map((g) => g.name).join(', ');
      toast(`Auto sync added ${added.length === 1 ? names : `${added.length} games: ${names}${added.length > 2 ? '…' : ''}`}`, 'ok', null, { quiet: true });
      enrichArt().catch(() => {});
    } else if (!quiet) {
      toast('Auto sync: nothing new', 'ok', null, { quiet: true });
    }
    return added.length;
  }

  function initAutoSync() {
    setTimeout(() => runAutoSync(), 12000);
    setInterval(() => runAutoSync(), AUTO_SYNC_EVERY);
    // coming back to the window after a while (you were installing something?)
    window.addEventListener('focus', () => { if (Date.now() - autoSyncAt > 5 * 60 * 1000) runAutoSync(); });
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
              <span class="imp3-caret"><svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></span>
            </button>
            <div class="imp3-menu" data-menu hidden role="listbox" aria-label="Launchers"></div>
          </span>
          <span class="imp3-word">launcher</span>
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
        <div class="imp3-sync" data-sync-row hidden></div>
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
    const summaryEl = card.querySelector('[data-summary]');
    const primaryBtn = card.querySelector('[data-primary]');
    const folderBtn = card.querySelector('[data-scan-folder]');
    const syncRow = card.querySelector('[data-sync-row]');

    // Auto sync is chosen here, per launcher. Launchers that can't do it show
    // the switch off and locked, with the reason.
    const paintSyncRow = () => {
      const src = sources.find((x) => x.id === activeId);
      if (!src || src.action || src.id === 'folder' || src.id === 'file') { syncRow.hidden = true; syncRow.innerHTML = ''; return; }
      const can = !!src.sync;
      const on = can && autoSyncOn(src.id);
      syncRow.hidden = false;
      syncRow.classList.toggle('is-off', !can);
      syncRow.innerHTML = `
        <span class="imp3-sync-text">
          <b>Keep ${esc(src.label)} in sync</b>
          <span>${esc(can ? 'New games you install there are added on their own.' : src.syncNote || 'This source can only be imported by hand.')}</span>
        </span>
        ${stSwitch('data-sync-toggle', on, { disabled: !can, label: `Keep ${src.label} in sync` })}`;
      const box = syncRow.querySelector('[data-sync-toggle]');
      if (box && can) box.onchange = async () => {
        await setAutoSync(src.id, box.checked);
        toast(box.checked ? `${src.label} will stay in sync` : `${src.label} auto sync is off`, 'ok', null, { quiet: true });
      };
    };

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
    const appIdOf = importAppId;
    // Lookup maps over the library, built once per review paint instead of
    // scanning state.games for every candidate on every checkbox change.
    let libIndex = null;
    const buildLibIndex = () => { libIndex = importIndex(); return libIndex; };
    const existingFor = (c) => importFind(libIndex && libIndex.size === state.games.length ? libIndex : buildLibIndex(), c);
    // a wishlisted game found installed is offered too: it moves to the library
    const onWish = (c) => { const e = !c.wishlisted && existingFor(c); return !!(e && gvIsWishlisted(e)); };
    const isNew = (c) => !existingFor(c) || onWish(c);
    const picked = () => candidates.filter((c) => c._checked && isNew(c));
    const labelOf = (id) => (sources.find((s) => s.id === id) || {}).label || id;

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
      const launchers = sources.filter((s) => !s.action && s.id !== 'folder' && s.id !== 'file');
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
      else if (onWish(c)) bits.push('On your wishlist · moves to your library');
      else if (c.source) bits.push(c.source);
      if (c.hours > 0) bits.push(`${fmtNum(c.hours, 1)}h`);
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
          // look the artwork up again (refreshArt only repaints what is there)
          Promise.resolve(refetchArtwork(existing))
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
      paintSyncRow();
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
        const wishEntry = onWish(c) ? existingFor(c) : null;
        if (wishEntry) wishToLibraryFrom(wishEntry, c);
        else state.games.unshift(gameFromCandidate(c, labelOf(activeId)));
        // importing it by hand means you want it: auto sync may add it again later
        if (c.sourceId && Array.isArray(state.config.importIgnored) && state.config.importIgnored.includes(String(c.sourceId))) importIgnore(c.sourceId, false);
      }
      // games left unticked here stay out: auto sync only adds later installs
      const src = sources.find((x) => x.id === activeId);
      if (src && src.sync) noteAutoSyncSeen(activeId, candidates, { merge: true }).catch(() => {});
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
    })();
  }

  // ---------------------------------------------------------------------------
  // Settings page — a full view next to the game page (was a long modal).
  // Left: section list. Right: cards of rows (title + description + control).
  // ---------------------------------------------------------------------------

  const SETTINGS_SECTIONS = [
    { id: 'general', label: 'General', desc: 'Startup, the window, sounds, screenshots and clips.',
      icon: '<circle cx="12" cy="12" r="3.2"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1"/>' },
    { id: 'appearance', label: 'Appearance', desc: 'Layout, colours, size and motion.',
      icon: '<circle cx="12" cy="12" r="8.5"/><path d="M12 3.5a8.5 8.5 0 0 0 0 17z" fill="currentColor" stroke="none"/>' },
    { id: 'library', label: 'Library & import', desc: 'Artwork, importing games and keeping launchers in sync.',
      icon: '<rect x="3.5" y="4" width="7" height="16" rx="1.5"/><rect x="13.5" y="4" width="7" height="9" rx="1.5"/><path d="M13.5 17h7M13.5 20h4"/>' },
    { id: 'tracking', label: 'Playtime tracking', desc: 'How GameVault counts the time you play.',
      icon: '<circle cx="12" cy="13" r="7.5"/><path d="M12 9v4l2.5 2.5M9.5 2.5h5"/>' },
    { id: 'controller', label: 'Controller & Big Picture', desc: 'Play from the couch with a gamepad.',
      icon: '<path d="M7 9h10a4 4 0 0 1 3.9 4.9l-.9 3.6a2 2 0 0 1-3.4.9L14.8 16H9.2l-1.8 2.4a2 2 0 0 1-3.4-.9l-.9-3.6A4 4 0 0 1 7 9z"/><path d="M8 12v3M6.5 13.5h3M15.5 13h.01M17.5 14.5h.01"/>' },
    { id: 'account', label: 'Account & cloud', desc: 'Sign in, and sync your library across your PCs. Off until you turn it on.',
      icon: '<path d="M7 18.5h10.5a4 4 0 0 0 .6-7.95A6 6 0 0 0 6.6 9.1 4.75 4.75 0 0 0 7 18.5z"/>' },
    { id: 'backups', label: 'Backups', desc: 'Your game saves in the cloud, and copies of your library you can keep.',
      icon: '<path d="M4 7.5h16v11a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18.5z"/><path d="M3 4.5h18v3H3zM10 11.5h4"/>' },
    { id: 'about', label: 'About', desc: 'Version, updates, problem reports and credits.',
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
    return fmtDay(t, { day: 'numeric', month: 'short', year: s > 300 * 86400 ? 'numeric' : undefined });
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
      stRow('Back up my game saves', `${saves && on ? 'On.' : 'Off.'} Your saves, encrypted on this PC before upload. Every game and its copies are under Backups.`,
        `<button type="button" class="btn btn-ghost" data-cloud="backups">Open Backups</button>`, { disabled: !on }) +
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
    const bk = card.querySelector('[data-cloud="backups"]');
    if (bk) bk.addEventListener('click', () => openSettings('backups'));
  }

  // ---- Settings → Backups: every game's cloud saves, and library copies
  function backupsSavesHtml() {
    const on = signedIn();
    const saves = !!state.config.cloudSaves;
    const local = localSavesOn();
    let body = stRow('Back up to the cloud',
      'Each game’s save folder is packed and encrypted on this PC with a key tied to your account, then uploaded. It runs by itself after you play. Up to 50 MB per backup; the newest 3 copies of each game are kept.',
      stSwitch('data-bk-switch', on && saves, { disabled: !on, label: 'Back up my game saves to the cloud' }), { disabled: !on });
    if (!on) {
      body += stRow('Sign in first', 'Cloud backups are tied to your GameVault account, so you can restore them on any PC.',
        '<button type="button" class="btn btn-ghost" data-bk="account">Sign in</button>');
    }
    body += stRow('Keep copies on this PC',
      on && saves
        ? 'Cloud backups are on, so they’re used instead. Turn them off to keep copies here.'
        : 'No account needed. After you play, GameVault keeps the newest 5 copies of each game’s saves in its own folder.',
      `<div class="st-inline"><button type="button" class="btn btn-ghost" data-bk="local-folder">Open folder</button>${stSwitch('data-bk-local', local, { label: 'Keep copies of my saves on this PC' })}</div>`);
    if (!savesMode()) return `<h2 class="st-card-title">Game saves</h2>${body}`;
    const ov = state._bkOverview || { games: [], problems: {} };
    const byId = new Map();
    // games set up on this PC, then games with copies from another PC
    for (const g of state.games) {
      if (g && g.saveDir && !gvIsWishlisted(g)) byId.set(String(g.id), { id: String(g.id), name: g.name || 'Untitled', game: g, cloud: null });
    }
    for (const c of ov.games || []) {
      const row = byId.get(c.gameId) || { id: c.gameId, name: (gameById(c.gameId) || {}).name || c.gameName || 'A removed game', game: gameById(c.gameId) || null, cloud: null };
      row.cloud = c;
      byId.set(c.gameId, row);
    }
    const rows = [...byId.values()].sort((a, b) => {
      const ta = a.cloud ? new Date(a.cloud.latest).getTime() : 0;
      const tb = b.cloud ? new Date(b.cloud.latest).getTime() : 0;
      return tb - ta || String(a.name).localeCompare(String(b.name));
    });
    const list = rows.length
      ? '<div class="bk-list">' + rows.map((r) => {
        const prob = ov.problems && ov.problems[r.id];
        const where = r.game && r.game.saveDir ? lastDirs(r.game.saveDir, 3) : 'No save folder on this PC';
        const status = prob
          ? `<span class="bk-bad">Last backup failed: ${esc(prob.message)}</span>`
          : r.cloud
            ? `Backed up ${esc(agoLabel(r.cloud.latest))} · ${copiesText(r.cloud.copies)} · ${mb(r.cloud.bytes)}`
            : 'Not backed up yet';
        return `<div class="bk-row${prob ? ' is-bad' : ''}">
          <div class="bk-main"><b>${esc(r.name)}</b><span class="bk-status">${status}</span><span class="bk-where" title="${esc((r.game && r.game.saveDir) || '')}">${esc(where)}</span></div>
          <div class="bk-acts">
            ${r.game && r.game.saveDir ? `<button type="button" class="btn btn-ghost" data-bk="now" data-id="${esc(r.id)}">Back up now</button>` : ''}
            ${r.game ? `<button type="button" class="btn btn-ghost" data-bk="open" data-id="${esc(r.id)}">Open game</button>` : ''}
          </div>
        </div>`;
      }).join('') + '</div>'
      : '<p class="st-note">No games are set up yet. Open a game’s page: its Save backups card finds where it saves.</p>';
    const err = state._bkError ? `<p class="st-note cloud-bad">${esc(state._bkError)}</p>` : '';
    const missing = state.games.filter((g) => g && !g.saveDir && !gvIsWishlisted(g) && (Number(g.hours) || 0) > 0).length;
    const hint = rows.length && missing
      ? `<p class="st-note">${fmtNum(missing)} played game${missing === 1 ? ' has' : 's have'} no save folder yet. Set one up from the game’s page.</p>`
      : '';
    return `<h2 class="st-card-title">Game saves</h2>${body}${err}${list}${hint}`;
  }

  function backupsLibraryHtml() {
    const lib = state._bkLib || {};
    return '<h2 class="st-card-title">Your library</h2>' +
      stRow('Automatic safety copy',
        'Every time your library is saved, GameVault keeps the version before it. If the file is ever damaged, it switches to that copy by itself.',
        `<span class="bk-meta">${lib.at ? 'Updated ' + esc(agoLabel(lib.at)) : 'Made on the next change'}</span>`) +
      stRow('Save a copy',
        'One file with every game, its playtime, sessions, ratings and notes. Keep it on a USB stick or a cloud drive.',
        '<button type="button" class="btn btn-ghost" data-bk="export">Save a copy…</button>') +
      stRow('Restore from a copy',
        'Replaces your library with a copy you saved. Your current library is copied aside first.',
        '<button type="button" class="btn btn-ghost" data-bk="import">Restore…</button>');
  }

  function wireBackups(panel) {
    const repaint = async () => { if (state.settingsOpen && state.settingsSection === 'backups') await renderSettings(); };
    const sw = panel.querySelector('[data-bk-switch]');
    if (sw) sw.addEventListener('change', async () => {
      await saveConfigPatch({ cloudSaves: sw.checked });
      if (state.selectedId) paintSavesCard(gameById(state.selectedId));
      toast(sw.checked ? 'Save backups are on' : 'Save backups are off. Your copies stay in the cloud.', 'ok');
      repaint();
    });
    const loc = panel.querySelector('[data-bk-local]');
    if (loc) loc.addEventListener('change', async () => {
      await saveConfigPatch({ localSaves: loc.checked });
      state._sv = null;
      if (state.selectedId) paintSavesCard(gameById(state.selectedId));
      toast(loc.checked ? 'GameVault keeps copies of your saves on this PC' : 'No new copies on this PC. The ones there stay.', 'ok');
      repaint();
    });
    for (const btn of panel.querySelectorAll('[data-bk]')) {
      btn.addEventListener('click', async () => {
        const act = btn.dataset.bk;
        const g = btn.dataset.id ? gameById(btn.dataset.id) : null;
        if (act === 'local-folder') { if (api.localSavesOpenFolder) api.localSavesOpenFolder(); return; }
        if (act === 'account') openSettings('account');
        else if (act === 'open' && g) { closeSettings({ restoreFocus: false }); openDetail(g.id); }
        else if (act === 'now' && g) {
          btn.disabled = true;
          btn.textContent = 'Backing up…';
          await backupNow(g, { quiet: false, force: true });
          repaint();
        } else if (act === 'export') {
          await persistGames();
          const r = await api.libraryExport().catch((e) => ({ ok: false, error: e.message }));
          if (r && r.ok) toast(`Saved a copy of your library to ${lastDirs(r.path, 2)}`, 'ok');
          else if (r && !r.canceled) toast(r.error || 'Couldn’t save the copy', 'error');
        } else if (act === 'import') restoreLibraryFromCopy();
      });
    }
  }

  async function restoreLibraryFromCopy() {
    if (Object.values(state.live || {}).some((v) => v != null)) { toast('Close your running games first, then restore', 'error'); return; }
    const r = await api.libraryReadCopy().catch((e) => ({ ok: false, error: e.message }));
    if (!r || r.canceled) return;
    if (!r.ok) { toast(r.error || 'That file couldn’t be read', 'error'); return; }
    const { games } = normalizeGames(r.games);
    if (!games.length) { toast('That copy has no games in it', 'error'); return; }
    const syncing = cloudOn('cloudSync');
    const card = openModal(`
      <div class="modal-head">
        <h2>Restore your library?</h2>
        <button class="close-x" data-close aria-label="Close">✕</button>
      </div>
      <div class="modal-body rm-body">
        <p class="rm-text"><b>${esc(r.name)}</b> has ${fmtNum(games.length)} game${games.length === 1 ? '' : 's'} (saved ${esc(agoLabel(r.at))}). It replaces the ${fmtNum(state.games.length)} in your library now. Your current library is copied aside first.${syncing ? ' Library sync is on, so your other PCs get this library too.' : ''}</p>
      </div>
      <div class="modal-foot">
        <button class="btn btn-ghost" data-close data-autofocus>Cancel</button>
        <button class="btn btn-danger" data-restore>Replace my library</button>
      </div>`, { className: 'rm-modal' });
    if (!card) return;
    for (const b of card.querySelectorAll('[data-close]')) b.onclick = closeModal;
    card.querySelector('[data-restore]').onclick = async () => {
      closeModal();
      await persistGames();
      const kept = api.backupGames ? await api.backupGames().catch(() => null) : null;
      if (!kept && state.games.length) { toast('Couldn’t copy your current library aside, so nothing was changed', 'error'); return; }
      const before = state.games;
      const show = async (list) => {
        state.games = list;
        await persistGames();
        if (state.selectedId) closeDetail();
        state._shelfKey = '';
        renderLibrary();
        if (syncing) scheduleCloudSync(1500);
        if (state.settingsOpen && state.settingsSection === 'backups') renderSettings();
      };
      await show(games);
      enrichArt({ only: games }).catch(() => {});
      toast(`Library restored: ${fmtNum(games.length)} game${games.length === 1 ? '' : 's'}`, 'ok', [{ label: 'Undo', run: async () => {
        await show(before);
        toast('Your library is back the way it was', 'ok');
      } }]);
      if (state.settingsOpen && state.settingsSection === 'backups') renderSettings();
    };
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
      const res = await api.cloudSync(cleanGames(), lookForSync()).catch((e) => ({ ok: false, error: { message: e.message } }));
      state._syncing = false;
      if (!res || !res.ok) {
        state._syncError = (res && res.error && res.error.message) || 'Sync failed';
        if (announce) toast(state._syncError, 'error');
        renderCloudCard();
        return null;
      }
      state._syncError = null;
      state._lastSync = res.data.at;
      try { adoptSyncedLook(res.data.look); } catch (e) { reportError('look sync', e); }
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
        // games new to this PC: thumbnails for the art that came with them,
        // and a lookup for the art that stayed on the other PC
        const fresh = next.filter((g) => !old.has(String(g.id)));
        if (fresh.length) {
          Promise.all(fresh.map((g) => thumbsFor(g))).then(() => {
            state._shelfKey = '';
            if (!state.selectedId && !state.settingsOpen) renderLibrary();
          });
          enrichArt({ only: fresh }).catch(() => {});
        }
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
  const SV_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 18.5h10.5a4 4 0 0 0 .6-7.95A6 6 0 0 0 6.6 9.1 4.75 4.75 0 0 0 7 18.5z"/><path d="M12 15.5v-5M9.8 12.6 12 10.4l2.2 2.2"/></svg>';
  const copiesText = (n) => `${n} ${n === 1 ? 'copy' : 'copies'}`;
  const lastDirs = (p, n = 2) => String(p || '').split(/[\\/]/).filter(Boolean).slice(-n).join(' › ');

  // Save backups go to the cloud when you're signed in with them on, or stay
  // on this PC when "Keep copies on this PC" is on (the default: only
  // switching it off stops it). null = neither.
  function localSavesOn() { return state.config.localSaves !== false; }
  function savesMode() { return cloudOn('cloudSaves') ? 'cloud' : localSavesOn() ? 'local' : null; }
  function svApi() {
    return savesMode() === 'local'
      ? { backup: api.localSavesBackup, list: api.localSavesList, restore: api.localSavesRestore, del: api.localSavesDelete, hasPrev: api.localSavesHasPrevious, openPrev: api.localSavesOpenPrevious }
      : { backup: api.savesBackup, list: api.savesList, restore: api.savesRestore, del: api.savesDelete, hasPrev: api.savesHasPrevious, openPrev: api.savesOpenPrevious };
  }

  function savesCardHtml(g) {
    const head = (state2) => `<div class="sv-head${state2 ? ' is-' + state2 : ''}"><span class="sv-ico">${SV_ICON}</span><h3 class="gvx-card-head">Save backups</h3></div>`;
    if (!savesMode()) {
      const pitch = '<p class="sv-text">Keep copies of this game’s saves, so a broken save or a new PC never costs you your progress.</p>';
      return head() + pitch + (signedIn()
        ? '<div class="sv-row"><button type="button" class="btn btn-primary sv-btn" data-sv="turn-on">Back up to the cloud</button><button type="button" class="sv-link" data-sv="turn-on-local">Keep them on this PC</button></div>'
        : '<div class="sv-row"><button type="button" class="btn btn-primary sv-btn" data-sv="turn-on-local">Keep copies on this PC</button><button type="button" class="sv-link" data-sv="settings">Sign in for the cloud</button></div>');
    }
    const ui = state._sv && state._sv.id === String(g.id) ? state._sv : (state._sv = { id: String(g.id) });
    if (ui.finding) return head() + '<p class="sv-text">Looking up where it saves…</p>';
    if (ui.found) {
      const list = ui.found.length
        ? ui.found.map((c, i) => `<button type="button" class="sv-pick" data-sv="use" data-i="${i}" title="${esc(c.path)}"><b>${esc(lastDirs(c.path))}</b><span>${c.files} file${c.files === 1 ? '' : 's'} · ${mb(c.bytes)} · changed ${agoLabel(c.newest)}</span></button>`).join('')
        : '<p class="sv-text">No save folder found on this PC. Play once so the game makes one, or choose it yourself.</p>';
      return head() + '<p class="sv-text">Pick the folder this game saves to:</p>' + list + '<div class="sv-row"><button type="button" class="sv-link" data-sv="pick">Choose folder…</button><button type="button" class="sv-link" data-sv="cancel">Cancel</button></div>';
    }
    // copies on this PC and signed in: the cloud is one (asked) step away
    const toCloud = savesMode() === 'local' && signedIn() ? '<button type="button" class="sv-link sv-prev" data-sv="turn-on">Back up to the cloud instead…</button>' : '';
    // a restore that needs an answer first: which account folder, or where
    if (ui.choices) {
      return head() + '<p class="sv-text">This game has saves for more than one account here. Restore into which?</p>' +
        ui.choices.map((c, i) => `<button type="button" class="sv-pick" data-sv="use-choice" data-i="${i}" title="${esc(c.path)}"><b>${esc(lastDirs(c.path, 2))}</b><span>${c.files ? `${c.files} file${c.files === 1 ? '' : 's'} · changed ${agoLabel(c.newest)}` : 'empty'}</span></button>`).join('') +
        '<div class="sv-row"><button type="button" class="sv-link" data-sv="cancel">Cancel</button></div>';
    }
    if (ui.needFolder) {
      return head() + (ui.needFolder.source
        ? `<p class="sv-text">This backup came from <b title="${esc(ui.needFolder.source)}">${esc(lastDirs(ui.needFolder.source, 3))}</b>, and that folder isn’t on this PC yet. Open the game once so it makes its save folder, then restore again. Or show GameVault the folder:</p>`
        : '<p class="sv-text">Where does this game keep its saves on this PC? GameVault restores the backup there.</p>') +
        '<div class="sv-row"><button type="button" class="btn btn-primary sv-btn" data-sv="find">Find automatically</button><button type="button" class="sv-link" data-sv="pick">Choose folder…</button><button type="button" class="sv-link" data-sv="cancel">Cancel</button></div>';
    }
    if (!g.saveDir) {
      const have = ui.backups && ui.backups[0];
      const asking = have && ui.confirm === have.id;
      const restore = have
        ? `<p class="sv-status"><b>Backed up ${esc(agoLabel(have.created_at))}</b><span>${copiesText(ui.backups.length)}${have.device ? ' · ' + esc(have.device) : ''}</span></p>` +
          `<div class="sv-row"><button type="button" class="btn btn-primary sv-btn" data-sv="restore" data-id="${esc(have.id)}" ${ui.busy ? 'disabled' : ''}>${ui.busy || (asking ? 'Restore it here?' : 'Restore the latest')}</button></div>` +
          '<p class="sv-text">Or set where it saves, to back it up from this PC:</p>'
        : '<p class="sv-text">Backups are on. Where does this game keep its saves?</p>';
      return head(have ? 'ok' : '') + restore +
        `<div class="sv-row"><button type="button" class="${have ? 'sv-link' : 'btn btn-primary sv-btn'}" data-sv="find">Find automatically</button><button type="button" class="sv-link" data-sv="pick">Choose folder…</button></div>` + toCloud;
    }
    const backups = ui.backups;
    const latest = backups && backups[0];
    const bad = !!ui.error;
    const status = !backups ? '<p class="sv-status">Checking backups…</p>'
      : latest
        ? `<p class="sv-status"><b>Backed up ${esc(agoLabel(latest.created_at))}</b><span>${copiesText(backups.length)} · ${mb(latest.size)}${latest.device ? ' · ' + esc(latest.device) : ''}</span></p>`
        : '<p class="sv-status"><b>Not backed up yet</b><span>It backs up by itself after you play, or now.</span></p>';
    const list = ui.open && backups && backups.length
      ? '<div class="sv-list">' + backups.map((b) => {
        const asking = ui.confirm === b.id;
        const delAsk = ui.confirmDel === b.id;
        return `<div class="sv-backup"><span><b>${esc(agoLabel(b.created_at))}</b>${esc(b.device || '')} · ${mb(b.size)}</span>` +
          `<span class="sv-acts"><button type="button" class="sv-link${asking ? ' is-danger' : ''}" data-sv="restore" data-id="${esc(b.id)}">${asking ? 'Replace current saves?' : 'Restore'}</button>` +
          (asking ? '' : `<button type="button" class="sv-link${delAsk ? ' is-danger' : ' is-quiet'}" data-sv="delete" data-id="${esc(b.id)}">${delAsk ? 'Delete it?' : 'Delete'}</button>`) +
          '</span></div>';
      }).join('') + '</div>'
      : '';
    return head(bad ? 'bad' : latest ? 'ok' : '') +
      status +
      (ui.error ? `<p class="sv-text cloud-bad">${esc(ui.error)}</p>` : '') +
      `<div class="sv-row"><button type="button" class="btn btn-ghost sv-btn" data-sv="backup" ${ui.busy ? 'disabled' : ''}>${ui.busy || 'Back up now'}</button>` +
      (backups && backups.length ? `<button type="button" class="sv-link" data-sv="toggle" aria-expanded="${ui.open ? 'true' : 'false'}">${ui.open ? 'Hide copies' : 'Restore a copy…'}</button>` : '') +
      '</div>' +
      list +
      `<div class="sv-foot"><span class="sv-folder" title="${esc(g.saveDir)}">${esc(lastDirs(g.saveDir, 3))}</span><button type="button" class="sv-link" data-sv="pick">Change</button></div>` +
      (ui.hasPrev ? '<button type="button" class="sv-link sv-prev" data-sv="previous">Open the saves a restore replaced</button>' : '') +
      toCloud;
  }

  function paintSavesCard(g) {
    const el = document.querySelector('#game-view [data-saves-card]');
    if (!el || !g) return;
    el.innerHTML = savesCardHtml(g);
    const ui = state._sv;
    if (g.saveDir && savesMode() && ui && ui.id === String(g.id) && ui.hasPrev === undefined && svApi().hasPrev) {
      ui.hasPrev = false;
      svApi().hasPrev(String(g.id)).then((v) => { ui.hasPrev = !!v; if (v && state.selectedId === String(g.id)) paintSavesCard(g); }).catch(() => {});
    }
    if (savesMode() && ui && ui.id === String(g.id) && !ui.backups && !ui.loading) {
      ui.loading = true;
      svApi().list(String(g.id)).then((res) => {
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
    if (!g || !g.saveDir || !savesMode()) return;
    const ui = state._sv && state._sv.id === String(g.id) ? state._sv : null;
    if (ui) { ui.busy = 'Backing up…'; ui.error = null; paintSavesCard(g); }
    const res = await svApi().backup({ gameId: String(g.id), gameName: g.name, saveDir: g.saveDir, installDir: g.installDir || null, steamAppId: g.steamAppId || null, force });
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

  // Cloud backups are one switch for every game, so the card asks before
  // flipping it rather than turning it on from one game's page.
  function askCloudSaves(g) {
    const card = openModal(`
      <div class="modal-head">
        <h2>Back up your saves to the cloud?</h2>
        <button class="close-x" data-close aria-label="Close">✕</button>
      </div>
      <div class="modal-body rm-body">
        <p class="rm-text">This turns on cloud backups for every game you set up, not just this one. Saves are encrypted on this PC before they’re uploaded, up to 50 MB per backup, and the newest 3 copies of each game are kept.</p>
        <p class="rm-text">While it’s on, cloud backups are used instead of copies on this PC. You can turn it off any time in Settings → Backups.</p>
      </div>
      <div class="modal-foot">
        <button class="btn btn-ghost" data-close data-autofocus>Not now</button>
        <button class="btn btn-primary" data-yes>Back up to the cloud</button>
      </div>`, { className: 'rm-modal' });
    if (!card) return;
    for (const b of card.querySelectorAll('[data-close]')) b.onclick = closeModal;
    card.querySelector('[data-yes]').onclick = async () => {
      closeModal();
      await saveConfigPatch({ cloudSaves: true });
      state._sv = { id: String(g.id) };
      toast('Cloud save backups are on', 'ok');
      if (state.selectedId === String(g.id)) paintSavesCard(g);
    };
  }

  async function savesAction(g, btn) {
    const act = btn.dataset.sv;
    const ui = state._sv;
    if (act === 'settings') { openSettings('account'); return; }
    if (act === 'turn-on') { askCloudSaves(g); return; }
    if (act === 'turn-on-local') {
      await saveConfigPatch({ localSaves: true });
      state._sv = { id: String(g.id) };
      toast('GameVault keeps copies of your saves on this PC', 'ok');
      paintSavesCard(g);
      return;
    }
    if (act === 'toggle') { ui.open = !ui.open; ui.confirm = null; ui.confirmDel = null; paintSavesCard(g); return; }
    if (act === 'previous') { if (svApi().openPrev) svApi().openPrev(String(g.id)); return; }
    if (act === 'delete') {
      const id = btn.dataset.id;
      if (ui.confirmDel !== id) { ui.confirmDel = id; ui.confirm = null; paintSavesCard(g); return; }
      ui.confirmDel = null;
      const res = await svApi().del(id).catch((e) => ({ ok: false, error: { message: e.message } }));
      if (res && res.ok) { toast('Backup deleted', 'ok'); ui.backups = null; }
      else toast((res && res.error && res.error.message) || 'Couldn’t delete that backup', 'error');
      paintSavesCard(g);
      return;
    }
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
      if (c && ui.needFolder) restoreSaves(g, ui.needFolder.backupId, { saveDir: c.path });
      else if (c) setSaveDir(g, c.path);
    } else if (act === 'pick') {
      const dir = await api.savesPick(g.saveDir || null);
      ui.found = null;
      if (dir && ui.needFolder) restoreSaves(g, ui.needFolder.backupId, { saveDir: dir });
      else if (dir) setSaveDir(g, dir); else paintSavesCard(g);
    } else if (act === 'use-choice') {
      const c = ui.choices && ui.choices[Number(btn.dataset.i)];
      const pending = ui.choicesFor;
      ui.choices = null;
      if (c && pending) restoreSaves(g, pending, { saveDir: c.path, exact: true }); else paintSavesCard(g);
    } else if (act === 'cancel') {
      ui.found = null; ui.needFolder = null; ui.choices = null; ui.confirm = null; paintSavesCard(g);
    } else if (act === 'backup') {
      backupNow(g, { quiet: false, force: true });
    } else if (act === 'restore') {
      const id = btn.dataset.id;
      if (ui.confirm !== id) { ui.confirm = id; ui.confirmDel = null; paintSavesCard(g); return; }
      ui.confirm = null;
      restoreSaves(g, id, { saveDir: g.saveDir || null });
    }
  }

  // Restore a backup on this PC. The backup knows where it came from, so the
  // main process works out the folder here (another Steam account's number,
  // a parent folder picked by mistake, no folder set yet); when it can't, it
  // asks back: which account folder, or where the game saves.
  async function restoreSaves(g, backupId, { saveDir = null, exact = false } = {}) {
    const ui = state._sv && state._sv.id === String(g.id) ? state._sv : (state._sv = { id: String(g.id) });
    if (typeof state.live[String(g.id)] === 'number') { toast('Close the game before restoring its saves', 'error'); paintSavesCard(g); return; }
    ui.needFolder = null; ui.choices = null;
    ui.busy = 'Restoring…'; paintSavesCard(g);
    const res = await svApi().restore({ gameId: String(g.id), backupId, saveDir, exact, installDir: g.installDir || null, steamAppId: g.steamAppId || null });
    ui.busy = null;
    const d = res && res.ok ? res.data : null;
    if (d && d.pending === 'choose') {
      ui.choices = d.choices || []; ui.choicesFor = backupId;
    } else if (d && d.pending) {
      ui.needFolder = { backupId, source: d.source || null };
    } else if (d) {
      if (d.target && d.target !== g.saveDir) { g.saveDir = d.target; saveGamesSoon(); }
      ui.hasPrev = !!d.safety || ui.hasPrev;
      ui.backups = null;
      toast(`Restored ${d.files} file${d.files === 1 ? '' : 's'} to ${lastDirs(d.target, 2)}.${d.safety ? ' The saves it replaced are kept: open them from this card.' : ''}`, 'ok');
    } else {
      problemDialog({
        title: 'Saves weren’t restored',
        body: `The backup of <b>${esc(g.name || 'this game')}</b> couldn’t be put back. Check that the game is closed and its save folder is still there, then try again.`,
        detail: (res && res.error && res.error.message) || '',
        fallback: (res && res.error && res.error.message) || 'Restore failed',
      });
    }
    if (state.selectedId === String(g.id)) paintSavesCard(g);
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
      if (state.selectedId) { const sel = gameById(state.selectedId); if (sel && was !== !!st.signedIn) paintRail(sel); else paintSavesCard(sel); }
      if (state.settingsOpen && state.settingsSection === 'backups' && was !== !!st.signedIn) renderSettings();
      welcome.onAccount(st);
    });
  }

  function settingsView() { return $('#settings-view'); }

  // While Settings is open the nav says so: its own item lit (no pill, like
  // Activity), the library tabs off, and the library-only sort and layout
  // buttons out of the top bar
  function markSettingsNav(on) {
    $('#main')?.classList.toggle('is-settings', on);
    for (const btn of $$('.tab[data-filter]')) btn.classList.toggle('is-active', !on && btn.dataset.filter === state.filter);
    for (const b of $$('.side-item[data-rail-action="btn-settings"]')) {
      b.classList.toggle('is-active', on);
      if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    }
    syncSidePill();
  }

  async function openSettings(section) {
    if (state.selectedId) closeDetail();
    // one place to change the look at a time (Appearance shows the same controls)
    if (customize.isOpen()) customize.close();
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
    markSettingsNav(true);
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
    markSettingsNav(false);
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
            <button type="button" class="st-back" data-st-close title="Back to the library">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 6l-6 6 6 6"/></svg>
              Library
            </button>
            <div class="st-nav-title">Settings</div>
            <div class="st-tabs" role="tablist" aria-orientation="vertical" data-pad-enter>
              ${SETTINGS_SECTIONS.map((s) => `
                <button type="button" class="st-tab" role="tab" id="st-tab-${s.id}" data-st-section="${s.id}" aria-controls="st-panel" title="${esc(s.label)}">
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
    // Tab (or the pad) moving focus out of the list closes it
    wrap.addEventListener('focusout', (e) => {
      if (!menu.hidden && e.relatedTarget && !wrap.contains(e.relatedTarget)) close(false);
    });
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

  // A slider with its value beside it (Settings → Appearance).
  const stRange = (attr, value, min, max, label) => `
    <div class="st-range-wrap"><input type="range" class="st-range" ${attr} min="${min}" max="${max}" step="1" value="${value}" aria-label="${esc(label)}" /><output class="st-range-val">${value}%</output></div>`;
  // Tint is a 0–100 amount, not a percentage of something
  const rangeText = (attr, v) => (attr === 'data-ui-tint' ? String(v) : `${v}%`);

  const stAccentPicker = (ui) => {
    const known = UiPrefs.ACCENTS.some(([h]) => h === ui.accent);
    const custom = ui.accent && !known ? ui.accent : null;
    return `<div class="acc-row" data-ui-accent-group role="radiogroup" aria-label="Accent colour">
      <button type="button" class="acc-sw is-auto${!ui.accent ? ' is-active' : ''}" data-value="" role="radio" aria-checked="${!ui.accent}" aria-label="The palette’s own" title="The palette’s own"><i class="pal-sw" data-value="${esc(state.palette)}"></i></button>
      ${UiPrefs.ACCENTS.map(([h, name]) => `<button type="button" class="acc-sw${ui.accent === h ? ' is-active' : ''}" data-value="${h}" style="--sw:${h}" role="radio" aria-checked="${ui.accent === h}" aria-label="${esc(name)}" title="${esc(name)}"></button>`).join('')}
      <label class="acc-sw is-custom${custom ? ' is-active' : ''}" title="Any colour"${custom ? ` style="--sw:${custom}"` : ''}>
        <input type="color" data-ui-accent-custom value="${esc(custom || ui.accent || '#4c7dff')}" aria-label="Pick any accent colour" />
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>
      </label>
    </div>`;
  };

  function wireLookControls(panel) {
    // accent swatches
    const group = panel.querySelector('[data-ui-accent-group]');
    const markAccent = (value) => {
      if (!group) return;
      const known = UiPrefs.ACCENTS.some(([h]) => h === value);
      for (const b of group.querySelectorAll('button.acc-sw')) {
        const on = (b.dataset.value || null) === (value || null);
        b.classList.toggle('is-active', on);
        b.setAttribute('aria-checked', String(on));
      }
      const custom = group.querySelector('.is-custom');
      custom.classList.toggle('is-active', !!value && !known);
      if (value && !known) custom.style.setProperty('--sw', value); else custom.style.removeProperty('--sw');
    };
    if (group) {
      for (const b of group.querySelectorAll('button.acc-sw')) {
        b.onclick = () => { const v = b.dataset.value || null; markAccent(v); setUi({ accent: v }); };
      }
      const pickAny = group.querySelector('[data-ui-accent-custom]');
      pickAny.oninput = () => { markAccent(pickAny.value); setUi({ accent: pickAny.value }, { persist: false }); };
      pickAny.onchange = () => { markAccent(pickAny.value); setUi({ accent: pickAny.value }); };
    }

    // sliders: live while dragging, saved when let go
    const slider = (attr, patchOf) => {
      const el = panel.querySelector(`[${attr}]`);
      if (!el) return;
      const out = el.parentElement.querySelector('output');
      const val = () => Math.round(Number(el.value));
      el.oninput = () => { if (out) out.textContent = rangeText(attr, val()); setUi(patchOf(val()), { persist: false }); };
      el.onchange = () => setUi(patchOf(val()));
      if (out) out.textContent = rangeText(attr, val());
    };
    const glass = (k) => (v) => ({ glass: { ...state.ui.glass, [k]: v } });
    slider('data-ui-tint', (v) => ({ tint: v }));
    slider('data-ui-glass-blur', glass('blur'));
    slider('data-ui-glass-opacity', glass('opacity'));
    slider('data-ui-glass-sat', glass('saturation'));
    slider('data-ui-bg-dim', (v) => ({ backgroundDim: v }));

    const rows = panel.querySelector('[data-ui-glass-rows]');
    const solid = panel.querySelector('[data-ui-solid-switch]');
    const showGlass = () => {
      if (!rows) return;
      rows.classList.toggle('is-disabled', state.ui.glass.solid);
      for (const r of rows.querySelectorAll('input')) r.disabled = state.ui.glass.solid;
      // Lite turns every blur off, so the Blur slider would do nothing there
      const lite = document.documentElement.dataset.tier === 'lite';
      const blur = panel.querySelector('[data-ui-glass-blur]');
      if (blur) {
        if (lite) blur.disabled = true;
        blur.closest('.st-row')?.classList.toggle('is-disabled', lite || state.ui.glass.solid);
      }
      const note = panel.querySelector('[data-ui-lite-note]');
      if (note) note.hidden = !lite || state.ui.glass.solid;
    };
    panel._showGlass = showGlass;
    showGlass();
    if (solid) solid.onchange = () => { setUi({ glass: { ...state.ui.glass, solid: solid.checked } }); showGlass(); };
    const reset = panel.querySelector('[data-ui-glass-reset]');
    if (reset) reset.onclick = () => {
      const d = UiPrefs.defaults().glass;
      setUi({ glass: d });
      if (solid) solid.checked = false;
      for (const [attr, v] of [['data-ui-glass-blur', d.blur], ['data-ui-glass-opacity', d.opacity], ['data-ui-glass-sat', d.saturation]]) {
        const el = panel.querySelector(`[${attr}]`);
        if (el) { el.value = v; const out = el.parentElement.querySelector('output'); if (out) out.textContent = `${v}%`; }
      }
      showGlass();
    };

    // background
    const bgGroup = panel.querySelector('[data-ui-bg-group]');
    const markBg = () => {
      if (!bgGroup) return;
      for (const p of bgGroup.querySelectorAll('.pill')) p.classList.toggle('is-active', p.dataset.value === state.ui.background);
      for (const el of panel.querySelectorAll('[data-ui-bg-only]')) el.hidden = !el.dataset.uiBgOnly.split(' ').includes(state.ui.background);
      const desc = panel.querySelector('#st-bg-file');
      if (desc) desc.textContent = state.ui.backgroundKind === 'video' ? 'Your video, kept on this PC.' : 'Your picture, kept on this PC.';
    };
    const pickFile = async (kind) => {
      if (!api.uiBackgroundPick) return;
      const res = await api.uiBackgroundPick(kind).catch(() => ({ error: 'Couldn’t open that file.' }));
      if (res && res.file) setUi({ background: kind, backgroundFile: res.file, backgroundKind: res.kind });
      else if (res && res.error) toast(res.error, 'error');
      markBg();
    };
    if (bgGroup) {
      for (const pill of bgGroup.querySelectorAll('.pill')) {
        pill.onclick = () => {
          const v = pill.dataset.value;
          const ui = state.ui;
          if ((v === 'image' || v === 'video') && !(ui.backgroundFile && ui.backgroundKind === v && !backdrop.isBroken(ui.backgroundFile))) { pickFile(v); return; }
          setUi({ background: v });
          markBg();
        };
      }
    }
    const change = panel.querySelector('[data-ui-bg-change]');
    if (change) change.onclick = () => pickFile(state.ui.background === 'video' ? 'video' : 'image');
    const remove = panel.querySelector('[data-ui-bg-remove]');
    if (remove) remove.onclick = async () => {
      setUi({ background: 'fluid', backgroundFile: null, backgroundKind: null });
      markBg();
      if (api.uiBackgroundClear) await api.uiBackgroundClear().catch(() => {});
    };
    const color = panel.querySelector('[data-ui-bg-color]');
    if (color) {
      if (!state.ui.backgroundColor) color.value = (getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() || '#08090c').slice(0, 7);
      color.oninput = () => setUi({ backgroundColor: color.value }, { persist: false });
      color.onchange = () => setUi({ backgroundColor: color.value });
    }
    markBg();
  }

  // ---- presets, share, undo and reset (top of Appearance and the Customize panel)
  // A tiny made-up GameVault for each preset: sidebar, top bar, featured game
  // and a shelf of invented covers (no real games). The CSS lays it out per preset.
  function presetArt(id) {
    const count = { compact: 7, couch: 3, minimal: 6, dock: 6 }[id] || 5;
    const cover = (n) => `<i class="pa-cv pa-cv${n}"><b></b></i>`;
    const shelf = Array.from({ length: count }, (_, i) => `<i class="pa-card${i === 0 ? ' is-on' : ''}">${cover(((i + 1) % 7) + 1)}<b></b></i>`).join('');
    return `<span class="pa-win">` +
      `<span class="pa-side"><i class="pa-logo"></i><i class="pa-item is-on"></i><i class="pa-item"></i><i class="pa-item"></i><i class="pa-gap"></i><i class="pa-item"></i><i class="pa-item"></i></span>` +
      `<span class="pa-main"><span class="pa-top"><i class="pa-title"></i><i class="pa-search"></i><i class="pa-btn"></i></span>` +
      `<span class="pa-hero"><span class="pa-hero-text"><i class="pa-kick"></i><i class="pa-name"></i><i class="pa-meta"></i><span class="pa-acts"><i class="pa-play"></i><i class="pa-more"></i></span></span>${cover(1).replace('pa-cv pa-cv1', 'pa-cv pa-cv1 pa-hero-cv')}</span>` +
      `<span class="pa-shelf">${shelf}</span></span>` +
      `<span class="pa-dock"><i></i><i class="is-on"></i><i></i><i></i><i></i></span></span>`;
  }
  function stLookTools(ui, opts = {}) {
    const preset = UiPrefs.presetOf(ui);
    const isNew = !state.config.uiHintSeen && !opts.drawer;
    const presets = `<div class="cz-presets" role="group" aria-label="Presets">${UiPrefs.PRESETS.map((p) => `
      <button type="button" class="cz-preset${p.id === preset ? ' is-active' : ''}" data-look-preset="${p.id}" aria-pressed="${p.id === preset}" title="${esc(p.desc)}">
        <span class="cz-art" data-art="${p.id}" aria-hidden="true">${presetArt(p.id)}</span>
        <span class="cz-preset-name">${esc(p.name)}</span>
      </button>`).join('')}</div>`;
    return stCard(`Customize${isNew ? '<span class="st-soon">New</span>' : ''}`,
      // Big Picture keeps its own layout: the live panel only opens outside it
      (opts.drawer || bp.on ? '' : stRow('Customize live', 'A panel beside your library, so you see each change as you make it. Right-click any empty spot to open it too.', '<button type="button" class="btn btn-primary" data-cz-open>Customize…</button>')) +
      stRow('Presets', 'A starting point to tweak. Your colours, background, size and motion stay as they are.', presets, { wide: true }) +
      stRow('Share a look', 'Copy your look as a short code to send to a friend, or paste one you got. Pictures and videos stay on this PC.',
        '<div class="st-inline"><button type="button" class="btn btn-ghost" data-look-copy>Copy look</button><button type="button" class="btn btn-ghost" data-look-paste>Paste look</button></div>') +
      stRow('Undo and reset', 'Undo steps back through your last 10 changes.',
        `<div class="st-inline"><button type="button" class="btn btn-ghost" data-look-undo ${lookHist.past.length ? '' : 'disabled'}>Undo</button><button type="button" class="btn btn-ghost" data-look-reset>Reset to default</button></div>`));
  }

  function wireLookTools(panel) {
    for (const b of panel.querySelectorAll('[data-look-preset]')) b.onclick = () => applyLookPreset(b.dataset.lookPreset);
    const on = (sel, fn) => { const b = panel.querySelector(sel); if (b) b.onclick = fn; };
    on('[data-cz-open]', () => customize.open());
    on('[data-look-copy]', copyLook);
    on('[data-look-paste]', pasteLook);
    on('[data-look-undo]', undoLook);
    on('[data-look-reset]', resetLook);
  }

  // ---- the Customize panel: Appearance beside the library, every change live
  const customize = {
    el: null,
    isOpen() { return !!(this.el && !this.el.hidden); },
    async render() {
      if (!this.el) return;
      const body = this.el.querySelector('.cz-body');
      const top = body.scrollTop;
      const built = await SETTINGS_RENDERERS.appearance({ drawer: true });
      body.innerHTML = built.html;
      built.wire(body);
      body.scrollTop = top;
    },
    async open({ back } = {}) {
      if (document.documentElement.classList.contains('is-bigpicture')) return;
      // from Settings: focus goes back to what opened Settings, not a button that is gone
      if (state.settingsOpen) { back = back || state._settingsFocusReturn; closeSettings({ restoreFocus: false }); }
      if (!this.el) {
        const el = document.createElement('aside');
        el.id = 'cz';
        el.className = 'cz';
        el.setAttribute('role', 'dialog');
        el.setAttribute('aria-label', 'Customize');
        el.dataset.padRegion = 'cz';
        el.hidden = true;
        el.innerHTML = `
          <header class="cz-head">
            <h2 class="cz-title">Customize</h2>
            <button type="button" class="cz-x" data-cz-close aria-label="Close" title="Close (Esc)">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>
            </button>
          </header>
          <div class="cz-body st-body"></div>`;
        el.querySelector('[data-cz-close]').onclick = () => this.close();
        el.addEventListener('keydown', (e) => {
          if (e.key !== 'Escape' || e.defaultPrevented) return;
          if (e.target.closest && e.target.closest('.pal-wrap, .sort-wrap') && document.querySelector('.cz .sort-menu:not([hidden])')) return;
          e.preventDefault();
          e.stopPropagation();
          this.close();
        });
        document.body.appendChild(el);
        this.el = el;
      }
      if (!state.config.uiHintSeen) saveConfigPatch({ uiHintSeen: true });
      const was = this.isOpen();
      if (!was) {
        this._back = back || document.activeElement;
        this._backKey = focusKey(this._back);
      }
      await this.render();
      this.el.hidden = false;
      if (!was) {
        sfx('open');
        if (!prefersReducedMotion()) this.el.animate([{ opacity: 0, transform: 'translateX(24px)' }, { opacity: 1, transform: 'none' }], { duration: 260, easing: 'cubic-bezier(0.22, 0.8, 0.3, 1)' });
      }
      this.el.querySelector('.cz-preset.is-active, .cz-preset')?.focus({ preventScroll: true });
    },
    close() {
      if (!this.isOpen()) return;
      sfx('close');
      this.el.hidden = true;
      this.el.querySelector('.cz-body').innerHTML = '';
      const back = this._back;
      const key = this._backKey;
      this._back = null;
      this._backKey = null;
      refocus(back, key);
    },
  };

  // right-click an empty spot (not a game, not a text field): a small menu
  function initCustomize() {
    let menu = null;
    const closeMenu = () => { if (menu) { menu.remove(); menu = null; } };
    let menuBack = null;
    document.addEventListener('contextmenu', (e) => {
      closeMenu();
      if (e.defaultPrevented) return;
      if (gameFromEl(e.target) || (e.target.closest && e.target.closest('#game-view'))) return; // a game's own menu
      if (document.documentElement.classList.contains('is-bigpicture')) return;
      if (!$('#modal').hidden || spotHooks.isOpen()) return;
      if (e.target.closest && e.target.closest('input, textarea, select, [contenteditable="true"], #cz')) return;
      e.preventDefault();
      menuBack = document.activeElement;
      menu = document.createElement('div');
      menu.className = 'sort-menu cz-menu';
      menu.setAttribute('role', 'menu');
      menu.innerHTML = `
        <button type="button" class="sort-item" role="menuitem" data-m="open"><span>Customize look…</span></button>
        <button type="button" class="sort-item" role="menuitem" data-m="undo" ${lookHist.past.length ? '' : 'disabled'}><span>Undo look change</span></button>`;
      document.body.appendChild(menu);
      const r = menu.getBoundingClientRect();
      menu.style.left = `${Math.max(6, Math.min(e.clientX, innerWidth - r.width - 6))}px`;
      menu.style.top = `${Math.max(6, Math.min(e.clientY, innerHeight - r.height - 6))}px`;
      menu.addEventListener('click', (ev) => {
        const b = ev.target.closest('[data-m]');
        if (!b || b.disabled) return;
        closeMenu();
        if (b.dataset.m === 'open') customize.open({ back: menuBack }); else undoLook();
      });
      menu.addEventListener('keydown', (ev) => {
        if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); closeMenu(); }
        if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
          ev.preventDefault();
          const items = [...menu.querySelectorAll('button:not([disabled])')];
          const i = items.indexOf(document.activeElement);
          items[(i + (ev.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
        }
      });
      menu.querySelector('button')?.focus({ preventScroll: true });
    });
    document.addEventListener('pointerdown', (e) => { if (menu && !menu.contains(e.target)) closeMenu(); }, true);
    window.addEventListener('blur', closeMenu);
    window.addEventListener('resize', closeMenu);
    // Ctrl+Z undoes a look change while the Customize panel or Appearance is open
    document.addEventListener('keydown', (e) => {
      if (!(e.ctrlKey && !e.shiftKey && !e.altKey && (e.key === 'z' || e.key === 'Z'))) return;
      // typing anywhere (an input with no type is a text box too) keeps its own undo
      const t = e.target;
      if (t && t.closest && (t.closest('textarea, [contenteditable=""], [contenteditable="true"]')
        || (t.matches('input') && !/^(range|color|checkbox|radio|button|submit|reset)$/i.test(t.type)))) return;
      if (!$('#modal').hidden || ($('#spot') && $('#spot').classList.contains('open'))) return;
      if (!customize.isOpen() && !(state.settingsOpen && state.settingsSection === 'appearance')) return;
      e.preventDefault();
      undoLook();
    });
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

  // "Change" listens for the next key press with a modifier (or an F key) and
  // saves it as an Electron accelerator; main re-registers and says if it took
  function wireCaptureSettings(panel) {
    const audio = panel.querySelector('[data-cap-audio]');
    if (audio) audio.onchange = () => saveConfigPatch({ captureGameAudio: audio.checked });
    const mic = panel.querySelector('[data-cap-mic]');
    if (mic) mic.onchange = () => saveConfigPatch({ captureMic: mic.checked });
    const others = panel.querySelector('[data-cap-others]');
    if (others) others.onchange = async () => {
      await saveConfigPatch({ captureFindOthers: others.checked });
      await loadMedia(true);
    };
    const folder = panel.querySelector('[data-cap-folder]');
    if (folder) folder.onclick = () => api.openCapturesFolder && api.openCapturesFolder();
    for (const btn of panel.querySelectorAll('[data-key-set]')) {
      btn.onclick = () => {
        const field = btn.dataset.keySet;
        const show = panel.querySelector(`[data-key-show="${field}"]`);
        const before = show.textContent;
        show.textContent = 'Press keys…';
        btn.textContent = 'Cancel';
        const done = (label) => {
          document.removeEventListener('keydown', onKey, true);
          show.textContent = label;
          btn.textContent = 'Change';
          btn.onclick = null;
          wireCaptureSettings(panel);
        };
        const onKey = async (e) => {
          e.preventDefault(); e.stopPropagation();
          if (e.key === 'Escape') { done(before); return; }
          const k = /^Key([A-Z])$/.exec(e.code) ? e.code.slice(3) : /^Digit(\d)$/.exec(e.code) ? e.code.slice(5) : /^F([1-9]|1\d|2[0-4])$/.test(e.code) ? e.code : null;
          if (!k) return; // a modifier on its own: keep listening
          const mods = [e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Super'].filter(Boolean);
          if (!mods.length && !/^F\d/.test(k)) { show.textContent = 'Add Ctrl, Alt or Shift'; return; }
          if (e.ctrlKey && e.altKey) { show.textContent = 'Ctrl + Alt is AltGr on many keyboards'; return; }
          const accel = [...mods, k].join('+');
          const other = field === 'captureShotHotkey' ? captureKeys().clip : captureKeys().shot;
          if (accel === other) { show.textContent = 'That’s the other shortcut'; return; }
          done(keyLabel(accel));
          await saveConfigPatch({ [field]: accel });
          const res = api.updateCaptureHotkeys ? await api.updateCaptureHotkeys().catch(() => null) : null;
          const ok = !res || res[field === 'captureShotHotkey' ? 'shot' : 'clip'] !== false;
          const d = panel.querySelector(field === 'captureShotHotkey' ? '#st-key-shot' : '#st-key-clip');
          if (d && !ok) d.textContent = 'Another app already uses this shortcut. Pick a different one.';
          toast(ok ? `Shortcut set to ${keyLabel(accel)}` : 'Another app already uses that shortcut', ok ? 'ok' : 'error');
        };
        document.addEventListener('keydown', onKey, true);
        btn.onclick = () => done(before);
      };
    }
  }

  const SETTINGS_RENDERERS = {
    async general() {
      const info = await (api.getPlatformInfo ? api.getPlatformInfo().catch(() => ({})) : Promise.resolve({}));
      const startupOn = await api.getStartup().catch(() => false);
      const toTray = state.config.closeToTray !== false;
      const keys = captureKeys();
      const hk = info.captureHotkeyOk || {};
      return {
        html:
          stCard('Startup',
            stRow('Start GameVault when I log in', 'Opens quietly in the tray. Big Picture at startup is under Controller & Big Picture.', stSwitch('data-autostart', startupOn, { label: 'Start on login' }))) +
          stCard('Window',
            stRow('Closing the window', toTray ? 'GameVault keeps tracking playtime from the tray.' : 'GameVault quits — games started outside it won’t be noticed.',
              stPills('data-close-mode', [['tray', 'Hide to tray'], ['quit', 'Quit']], toTray ? 'tray' : 'quit'), { descId: 'st-close-desc' }) +
            stRow('When a game starts', 'What GameVault does when you play a game from it. It comes back when the game closes.',
              stPills('data-game-start', [['keep', 'Stay open'], ['minimize', 'Minimize'], ['tray', 'Hide to tray']], ['minimize', 'tray'].includes(state.config.onGameStart) ? state.config.onGameStart : 'keep'))) +
          stCard('Sound',
            stRow('Sound effects', 'Small sounds when you click, move around, open things and launch games. Never plays over a game.',
              stSwitch('data-sfx-on', state.config.sfx !== false, { label: 'Sound effects' })) +
            stRow('Volume', '', `<input type="range" class="st-range" data-sfx-vol min="0" max="100" step="5" value="${Math.round((typeof state.config.sfxVolume === 'number' ? state.config.sfxVolume : 0.6) * 100)}" aria-label="Sound volume" />`) +
            stRow('Style', 'Crisp is short and clicky, like a real button. Airy is soft and glassy with a little room around it. Pick one to hear it.',
              stPills('data-sfx-theme', [['crisp', 'Crisp'], ['airy', 'Airy']], state.config.sfxTheme || 'crisp', { disabled: state.config.sfx === false })) +
            stRow('Navigation sounds', 'A tiny sound each time you move to another item with a controller or the arrow keys.',
              stSwitch('data-sfx-nav', state.config.sfxNav !== false, { label: 'Navigation sounds', disabled: state.config.sfx === false }))) +
          stCard('Screenshots & clips',
            (info.wayland
              ? stRow('Shortcuts', 'Wayland blocks global shortcuts. Bind these in your compositor:<br><code class="st-code">gamevault --screenshot</code><br><code class="st-code">gamevault --record</code>', '')
              : stRow('Screenshot', hk.shot === false ? 'Another app already uses this shortcut. Pick a different one.' : 'Saves the screen you’re on, tagged with the game you’re playing.',
                  `<div class="st-inline"><kbd class="st-kbd" data-key-show="captureShotHotkey">${esc(keyLabel(keys.shot))}</kbd><button type="button" class="btn btn-ghost" data-key-set="captureShotHotkey">Change</button></div>`, { descId: 'st-key-shot' }) +
                stRow('Record a clip', hk.clip === false ? 'Another app already uses this shortcut. Pick a different one.' : 'Press once to start and again to stop. You get a notification for each.',
                  `<div class="st-inline"><kbd class="st-kbd" data-key-show="captureClipHotkey">${esc(keyLabel(keys.clip))}</kbd><button type="button" class="btn btn-ghost" data-key-set="captureClipHotkey">Change</button></div>`, { descId: 'st-key-clip' })) +
            stRow('Game sound in clips', 'Records what you hear from the PC.', stSwitch('data-cap-audio', state.config.captureGameAudio !== false, { label: 'Game sound in clips' })) +
            stRow('Microphone in clips', 'Adds your voice on top.', stSwitch('data-cap-mic', state.config.captureMic === true, { label: 'Microphone in clips' })) +
            stRow('Captures from other apps', 'Also shows screenshots and clips from Steam, NVIDIA, AMD, Ubisoft Connect and the Xbox Game Bar, plus photo-mode shots a game saves while you play. They stay in their own folders.',
              stSwitch('data-cap-others', state.config.captureFindOthers !== false, { label: 'Captures from other apps' })) +
            stRow('Where they go', 'Shown under Activity and on each game’s page. Works with borderless and windowed games; exclusive fullscreen can come out black.',
              '<button type="button" class="btn btn-ghost" data-cap-folder>Open folder</button>')) +
          stCard('Reset',
            stRow('Reset all settings', 'Puts every setting back to how it was on a fresh install: the look, sounds, shortcuts, controller and the rest. Your games, playtime, backups and account stay as they are.',
              '<button type="button" class="btn btn-ghost" data-reset-all>Reset…</button>')),
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
          wirePills(panel, '[data-game-start]', (v) => saveConfigPatch({ onGameStart: v }));
          panel.querySelector('[data-reset-all]').onclick = () => resetAllSettings();
          wireCaptureSettings(panel);
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

    async appearance(opts = {}) {
      const sysReduced = systemReducedMotion();
      const ui = state.ui || UiPrefs.defaults();
      return {
        html: stLookTools(ui, opts) +
          stCard('Layout',
          (opts.drawer ? '' : stRow('Library view', 'How the library opens: a shelf with one big game, or a grid of cards. The button in the top bar switches it too.',
            stPills('data-layout', [['shelf', 'Shelf'], ['poster', 'Cards']], bp.on ? bp.saved.view : state.view))) +
          stRow('Navigation', 'Where the Library, Wishlist, Activity and Settings buttons live. With None, use the menu button in the top bar or Ctrl 1–6.',
            stPills('data-ui-nav-group', [['sidebar', 'Sidebar'], ['dock', 'Dock'], ['top', 'Top tabs'], ['none', 'None']], ui.nav), { wide: true }) +
          `<div data-ui-only="sidebar">${stRow('Side', 'Which edge of the window it sits on.', stPills('data-ui-side-group', [['left', 'Left'], ['right', 'Right']], ui.navSide))}</div>` +
          `<div data-ui-only="dock">${
            stRow('Dock style', 'Floating is a small pill; attached runs along the edge.', stPills('data-ui-dockstyle-group', [['floating', 'Floating'], ['attached', 'Attached']], ui.dockStyle)) +
            stRow('Hide the dock', 'It slides away and comes back when the pointer touches the edge.', stSwitch('data-ui-dock-hide', ui.dockAutoHide, { label: 'Hide the dock' }))
          }</div>` +
          stRow('Search', 'Where the search box sits. It always opens with Ctrl F or /, and Y on a controller.',
            stPills('data-ui-search-group', [['top-center', 'Top centre'], ['top-left', 'Top left'], ['in-nav', 'In the nav'], ['floating', 'Corner button'], ['hidden', 'Hidden']], ui.search), { wide: true })) +
          stCard('Size and shape',
            stRow('Size', 'Makes everything bigger or smaller: text, buttons and covers. Big Picture keeps its own size.',
              stPills('data-ui-size-group', [['90', '90%'], ['100', '100%'], ['110', '110%'], ['120', '120%']], String(ui.fontScale))) +
            stRow('Spacing', 'Compact fits more on screen with tighter rows and gaps.', stPills('data-ui-density-group', [['comfortable', 'Comfortable'], ['compact', 'Compact']], ui.density)) +
            stRow('Corners', 'How rounded cards, buttons and panels are.', stPills('data-ui-radius-group', [['0', 'Sharp'], ['1', 'Default'], ['2', 'Round']], String(ui.radius)))) +
          stCard('Game cards',
            stRow('Card size', 'How big the covers are in the card view.', stPills('data-ui-cardsize-group', [['small', 'Small'], ['medium', 'Medium'], ['large', 'Large']], ui.cardSize)) +
            stRow('Titles', 'The game’s name under its cover.', stSwitch('data-ui-titles-switch', ui.showTitles, { label: 'Titles' })) +
            stRow('Playtime', 'Hours played and when you last played.', stSwitch('data-ui-playtime-switch', ui.showPlaytime, { label: 'Playtime' })) +
            stRow('Ratings', 'Your rating in the corner of the cover.', stSwitch('data-ui-ratings-switch', ui.showRatings, { label: 'Ratings' })) +
            stRow('Shelf covers', 'How big the covers are along the bottom of the shelf view.', stPills('data-ui-shelfsize-group', [['small', 'Small'], ['medium', 'Medium'], ['large', 'Large']], ui.shelfSize))) +
          stCard('Colour',
            stRow('Palette', 'Sets the surfaces, the accent and the colours of the moving background. Paper is the light one.', stPalettePicker(state.palette)) +
            stRow('Accent', 'Buttons, highlights and the moving background’s main colour. The first one is the palette’s own.', stAccentPicker(ui), { wide: true }) +
            stRow('Tint', 'How much the panels lean toward the accent. 0 keeps them neutral.', stRange('data-ui-tint', ui.tint, 0, 100, 'Tint'))) +
          stCard('Glass',
            stRow('Solid panels', 'No see-through glass: the panels are opaque. Also lighter on older PCs.', stSwitch('data-ui-solid-switch', ui.glass.solid, { label: 'Solid panels' })) +
            `<div data-ui-glass-rows>${
              stRow('Blur', 'How soft the background looks through the panels.', stRange('data-ui-glass-blur', ui.glass.blur, 0, 200, 'Blur')) +
              `<div data-ui-lite-note hidden>${stRow('', 'Visual quality is on Lite, which turns blur off. Pick Standard or Cinematic under Quality to use it.', '')}</div>` +
              stRow('Opacity', 'Lower lets more of the background show through.', stRange('data-ui-glass-opacity', ui.glass.opacity, 40, 140, 'Opacity')) +
              stRow('Colour boost', 'How vivid the background is behind the glass.', stRange('data-ui-glass-sat', ui.glass.saturation, 50, 150, 'Colour boost'))
            }</div>` +
            stRow('', '', '<button type="button" class="btn btn-ghost" data-ui-glass-reset>Reset glass</button>')) +
          stCard('Background',
            stRow('Background', 'What sits behind the glass. Your picture or video stays on this PC and isn’t synced.',
              stPills('data-ui-bg-group', [['fluid', 'Animated'], ['art', 'Game art'], ['solid', 'Solid colour'], ['image', 'Picture'], ['video', 'Video']], ui.background), { wide: true }) +
            `<div data-ui-bg-only="solid">${stRow('Colour', '', `<input type="color" class="st-color" data-ui-bg-color value="${esc(ui.backgroundColor || '#08090c')}" aria-label="Background colour" />`)}</div>` +
            `<div data-ui-bg-only="image video">${stRow('File', '', '<div class="st-inline"><button type="button" class="btn btn-ghost" data-ui-bg-change>Choose another…</button><button type="button" class="btn btn-ghost" data-ui-bg-remove>Remove</button></div>', { descId: 'st-bg-file' })}</div>` +
            `<div data-ui-bg-only="art image video">${stRow('Dim', 'Darkens the background so the library stays easy to read.', stRange('data-ui-bg-dim', ui.backgroundDim, 0, 100, 'Dim'))}</div>`) +
          stCard('Quality',
            stRow('Visual quality', 'Cinematic adds the animated background. Lite turns off blur and motion — best on older PCs.', stPills('data-tier-group', [['cinematic', 'Cinematic'], ['standard', 'Standard'], ['lite', 'Lite']], state.tier)) +
            stRow('Motion', `Reduced stops things sliding, tilting and moving. Off also makes every change instant. Windows follows its own “Animation effects” setting, now <b>${sysReduced ? 'off' : 'on'}</b>.`,
              stPills('data-ui-motion-group', [['full', 'Windows'], ['reduced', 'Reduced'], ['off', 'Off']], ui.motion), { wide: true })),
        wire(panel) {
          wirePalettePicker(panel, (v) => {
            applyPalette(v, { announce: true, persist: true });
            // the "palette's own" accent swatch shows the palette now chosen
            const own = panel.querySelector('.acc-sw.is-auto .pal-sw');
            if (own) own.dataset.value = v;
          });
          wirePills(panel, '[data-tier-group]', (v) => { applyTier(v, { announce: true, persist: true }); if (panel._showGlass) panel._showGlass(); });
          const showFor = () => {
            for (const el of panel.querySelectorAll('[data-ui-only]')) el.hidden = !el.dataset.uiOnly.split(' ').includes(state.ui.nav);
            // Top tabs are already in the top bar, and None has no navigation
            const inNav = panel.querySelector('[data-ui-search-group] .pill[data-value="in-nav"]');
            if (inNav) inNav.hidden = state.ui.nav === 'none' || state.ui.nav === 'top';
            for (const p of panel.querySelectorAll('[data-ui-search-group] .pill')) p.classList.toggle('is-active', p.dataset.value === state.ui.search);
          };
          showFor();
          wirePills(panel, '[data-ui-nav-group]', (v) => { setUi({ nav: v }); showFor(); });
          wirePills(panel, '[data-ui-side-group]', (v) => setUi({ navSide: v }));
          wirePills(panel, '[data-ui-search-group]', (v) => setUi({ search: v }));
          wirePills(panel, '[data-ui-dockstyle-group]', (v) => setUi({ dockStyle: v }));
          const hide = panel.querySelector('[data-ui-dock-hide]');
          if (hide) hide.addEventListener('change', () => setUi({ dockAutoHide: hide.checked }));
          wirePills(panel, '[data-ui-size-group]', (v) => setUi({ fontScale: Number(v) }));
          wirePills(panel, '[data-ui-density-group]', (v) => { setUi({ density: v }); requestAnimationFrame(() => { syncSidePill(); spotHooks.resync(); }); });
          wirePills(panel, '[data-ui-radius-group]', (v) => setUi({ radius: Number(v) }));
          wirePills(panel, '[data-ui-cardsize-group]', (v) => setUi({ cardSize: v }));
          wirePills(panel, '[data-ui-shelfsize-group]', (v) => setUi({ shelfSize: v }));
          wirePills(panel, '[data-ui-motion-group]', (v) => setUi({ motion: v }));
          for (const [attr, key] of [['data-ui-titles-switch', 'showTitles'], ['data-ui-playtime-switch', 'showPlaytime'], ['data-ui-ratings-switch', 'showRatings']]) {
            const sw = panel.querySelector(`[${attr}]`);
            if (sw) sw.addEventListener('change', () => setUi({ [key]: sw.checked }));
          }
          wireLookControls(panel);
          wireLookTools(panel);
          wirePills(panel, '[data-layout]', (v) => {
            // Big Picture has its own layouts: save the choice for when it closes
            if (bp.on) { bp.saved.view = v; lsSet('gv.view', v); return; }
            if (v !== state.view) cycleView();
          });
        },
      };
    },

    async library() {
      return {
        html:
          stCard('Artwork',
            stRow('Refresh all artwork', 'Looks up covers, banners, logos and icons again for every game. Artwork comes from SteamGridDB through GameVault, with no key needed.', '<button type="button" class="btn btn-ghost" data-art-refresh>Refresh</button>') +
            stRow('Artwork on this PC', '<span data-art-size>Measuring…</span>',
              '<button type="button" class="btn btn-ghost" data-art-clean disabled>Clean up</button>', { descId: 'st-art-size' })) +
          stCard('Import',
            stRow('Import games', 'Steam, Epic, GOG, Xbox, Heroic, Lutris, itch and more, a folder, or your whole PC.', '<button type="button" class="btn btn-ghost" data-open-import>Open import</button>') +
            stRow('Sync now', 'Checks the launchers below for games you installed since the last look.', '<button type="button" class="btn btn-ghost" data-sync-now>Sync now</button>') +
            stRow('Removed games', removedGamesText(), '<button type="button" class="btn btn-ghost" data-removed-open>Show</button>', { descId: 'st-removed-desc' })) +
          stCard('Auto sync', '<div class="st-sync-list" data-autosync-list><div class="st-row"><div class="st-row-text"><span class="st-row-desc">Looking for launchers…</span></div></div></div>'),
        wire(panel) {
          wireArtCache(panel);
          panel.querySelector('[data-removed-open]').onclick = () => openRemovedGames();
          panel.querySelector('[data-art-refresh]').onclick = async () => {
            toast('Refreshing artwork for the whole library…', 'ok');
            await enrichArt({ force: true });
            toast('Artwork refreshed', 'ok');
          };
          panel.querySelector('[data-open-import]').onclick = () => { closeSettings({ restoreFocus: false }); $('#btn-import')?.click(); };
          const syncNow = panel.querySelector('[data-sync-now]');
          if (syncNow) syncNow.onclick = async () => {
            syncNow.disabled = true;
            await runAutoSync({ quiet: false });
            syncNow.disabled = false;
          };
          const syncList = panel.querySelector('[data-autosync-list]');
          if (syncList && api.importSources) api.importSources().catch(() => []).then((sources) => {
            if (!syncList.isConnected) return;
            const rows = (sources || []).filter((x) => !x.action && x.id !== 'folder' && x.id !== 'file' && x.id !== 'pc' && (x.found || autoSyncOn(x.id)));
            syncList.innerHTML = rows.length
              ? rows.map((x) => stRow(x.label, x.sync ? 'New games you install there are added on their own.' : x.syncNote,
                  x.sync ? stSwitch(`data-autosync="${esc(x.id)}"`, autoSyncOn(x.id), { label: `Keep ${x.label} in sync` }) : '<span class="bk-meta">Import by hand</span>')).join('')
              : stRow('No launchers found', 'Install Steam, Epic, GOG, Heroic, Lutris or another launcher and it shows up here.', '');
            for (const box of syncList.querySelectorAll('[data-autosync]')) {
              box.onchange = async () => {
                await setAutoSync(box.dataset.autosync, box.checked);
                if (box.checked) runAutoSync({ only: box.dataset.autosync });
              };
            }
          });
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
            stRow('Stop counting when I’m away', 'If there’s no mouse or keyboard input for this long, that stretch isn’t counted. Windows doesn’t see controllers as input, so leave this off if you play with a pad.',
              stPills('data-afk', [['0', 'Off'], ['15', '15 min'], ['30', '30 min'], ['60', '1 hour']], String([15, 30, 60].includes(Number(state.config.afkMinutes)) ? Number(state.config.afkMinutes) : 0))) +
            stRow('How a session is counted', 'It starts when the game’s own program is running and ends 60 seconds after it closes, so a quick restart stays one session. Store launchers like Steam or Epic never count, and anything under 30 seconds is ignored.', '') +
            stRow('Per-game settings', 'If a game launches through a launcher or wrapper, open the game → Edit → <b>Launch &amp; tracking</b> and use <b>Detect</b> to pick the real game.', '')) +
          (info.platform === 'linux'
            ? stCard('Windows games on Linux',
              stRow('Proton', info.protonPath ? `Using <code class="st-code">${esc(info.protonPath)}</code>` : 'No Proton build found. Install Proton through Steam, or Wine for non-Steam games.', ''))
            : ''),
        wire(panel) {
          wirePills(panel, '[data-afk]', (v) => {
            saveConfigPatch({ afkMinutes: Number(v) || 0 });
            toast(Number(v) ? `Time away longer than ${v === '60' ? 'an hour' : v + ' minutes'} won’t count` : 'All the time a game is open counts', 'ok');
          });
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

    async backups() {
      const st = await window.api.accountStatus().catch(() => ({ needsRestart: true }));
      state.account = st;
      const mode = savesMode();
      const [ov, lib] = await Promise.all([
        mode === 'cloud' && api.savesOverview ? api.savesOverview().catch(() => null)
          : mode === 'local' && api.localSavesOverview ? api.localSavesOverview().catch(() => null) : null,
        api.libraryBackupInfo ? api.libraryBackupInfo().catch(() => null) : null,
      ]);
      state._bkOverview = ov && ov.ok ? ov.data : null;
      state._bkError = ov && !ov.ok ? (ov.error && ov.error.message) || 'Couldn’t load your backups' : null;
      state._bkLib = lib;
      return {
        html: `<section class="st-card" data-bk-saves>${backupsSavesHtml()}</section>` +
          `<section class="st-card" data-bk-library>${backupsLibraryHtml()}</section>`,
        wire(panel) { wireBackups(panel); },
      };
    },

    async about() {
      const version = await api.getAppVersion().catch(() => '2.0.0');
      const info = await (api.getPlatformInfo ? api.getPlatformInfo().catch(() => ({})) : Promise.resolve({}));
      const osName = info.platform === 'win32' ? 'Windows' : info.platform === 'linux' ? `Linux${info.wayland ? ' (Wayland)' : ''}` : (info.platform || 'unknown');
      const link = (url, label) => `<button type="button" class="st-link" data-ext="${esc(url)}">${esc(label)}</button>`;
      return {
        html:
          stCard('GameVault',
            stRow('Version', `${esc(version)} · ${esc(osName)}`, '') +
            stRow('Updates', `<span data-upd-status>${esc(updateStatusText(version))}</span>`,
              '<button type="button" class="btn btn-ghost" data-upd-check>Check now</button>', { descId: 'st-upd-desc' }) +
            stRow('Check automatically', 'Looks for a new version each time GameVault starts. You choose when to install it.',
              stSwitch('data-upd-auto', state.config.updateCheck !== false, { label: 'Check for updates automatically' })) +
            stRow('Your data', 'Library, settings and cached artwork live in one folder on this PC.', '<button type="button" class="btn btn-ghost" data-open-data>Open folder</button>') +
            stRow('Welcome', 'The first-run setup: colours, layout, games and sign-in.', '<button type="button" class="btn btn-ghost" data-welcome-again>Show it again</button>') +
            stRow('Report a problem', 'Copies details about GameVault and your PC (version, screen, GPU, settings, no game names) to paste into a bug report. Nothing is sent.',
              '<button type="button" class="btn btn-ghost" data-copy-report>Copy details</button>')) +
          stCard('Credits',
            stRow('SteamGridDB', 'Covers, banners, logos and icons come from the SteamGridDB community.', link('https://www.steamgriddb.com', 'steamgriddb.com')) +
            stRow('PCGamingWiki', 'Save-game locations (for cloud saves) come from PCGamingWiki via the Ludusavi manifest.', link('https://www.pcgamingwiki.com', 'pcgamingwiki.com')) +
            stRow('Source code', 'GameVault is open source under the MIT license.', link('https://github.com/itzSornet/Gamevault', 'GitHub'))),
        wire(panel) {
          for (const b of panel.querySelectorAll('[data-ext]')) b.onclick = () => api.openExternal && api.openExternal(b.dataset.ext);
          panel.querySelector('[data-welcome-again]').onclick = () => welcome.open({ again: true });
          panel.querySelector('[data-copy-report]').onclick = () => copyProblemReport(version, osName);
          panel.querySelector('[data-upd-auto]').onchange = (e) => saveConfigPatch({ updateCheck: e.target.checked });
          panel.querySelector('[data-upd-check]').onclick = () => updates.check({ manual: true });
          panel.querySelector('[data-open-data]').onclick = async () => {
            const p = await api.getDataPath().catch(() => '');
            if (p) api.showInFolder(p);
          };
        },
      };
    },
  };

  // ---------------------------------------------------------------------------
  // Welcome: a full-screen first run, shown once to everyone (people coming
  // from 1.3 too). Every step can be skipped. The games step only shows to
  // people with an empty library, the sign-in step only to people signed out.
  // ---------------------------------------------------------------------------

  // [id, name, background, surface, accent] for the palette swatches
  const WELCOME_PALETTES = [
    ['midnight', 'Midnight', '#08090c', '#161923', '#4c7dff'],
    ['nebula', 'Nebula', '#0b0a12', '#191629', '#7c4dff'],
    ['emerald', 'Emerald', '#080c0b', '#14201c', '#1fa774'],
    ['ocean', 'Ocean', '#070b12', '#131c2b', '#2f7bff'],
    ['sunset', 'Sunset', '#0d0908', '#231713', '#f0603a'],
    ['paper', 'Paper', '#f3f0e9', '#ffffff', '#e4572e'],
  ];
  const WELCOME_HEX = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path pathLength="1" d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/></svg>';
  const WELCOME_CHECK = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>';

  const welcome = (() => {
    let el = null;
    let steps = [];
    let at = 0;
    let watch = null;

    const isOpen = () => !!(el && !el.hidden);
    const signedIn = () => !!(state.account && state.account.signedIn);
    const hoursText = (h) => `${fmtNum(Math.round(h))} hour${Math.round(h) === 1 ? '' : 's'}`;

    function plan() {
      const s = ['hello', 'colours', 'layout'];
      if (!state.games.length) s.push('games');
      if (!signedIn() && api.accountOAuth) s.push('account');
      s.push('done');
      return s;
    }

    function helloHtml() {
      const games = state.games.filter((g) => !gvIsWishlisted(g));
      if (games.length && !state.config.welcomeDone) {
        const hours = games.reduce((t, g) => t + (Number(g.hours) || 0), 0);
        return `<div class="wel-hex">${WELCOME_HEX}</div>
          <span class="wel-kicker">Welcome to</span>
          <h1 class="wel-title">GameVault 2.0</h1>
          <p class="wel-lead">Your library came with you: ${fmtNum(games.length)} game${games.length === 1 ? '' : 's'} and ${hoursText(hours)} of play.</p>
          <p class="wel-sub">A few quick choices to make it yours. You can skip any of them.</p>`;
      }
      return `<div class="wel-hex">${WELCOME_HEX}</div>
        <span class="wel-kicker">Welcome to</span>
        <h1 class="wel-title">GameVault</h1>
        <p class="wel-lead">Every game you own in one place, from every launcher, with your playtime tracked for you.</p>
        <p class="wel-sub">A few quick choices to make it yours. You can skip any of them.</p>`;
    }

    function coloursHtml() {
      const ui = state.ui || UiPrefs.defaults();
      const pal = WELCOME_PALETTES.map(([id, name, bg, surf, acc]) => `
        <button type="button" class="wel-pal${state.palette === id ? ' is-active' : ''}" data-wel-pal="${id}" role="radio" aria-checked="${state.palette === id}">
          <span class="wel-pal-art" style="--p-bg:${bg};--p-surf:${surf};--p-acc:${acc}" aria-hidden="true"><i></i><i></i><i></i></span>
          <span class="wel-pal-name">${name}</span>
        </button>`).join('');
      const own = !ui.accent;
      const acc = [`<button type="button" class="wel-acc is-own${own ? ' is-active' : ''}" data-wel-acc="" role="radio" aria-checked="${own}" title="The palette’s own colour"><span>Auto</span></button>`]
        .concat(UiPrefs.ACCENTS.map(([hex, name]) => `<button type="button" class="wel-acc${ui.accent === hex ? ' is-active' : ''}" data-wel-acc="${hex}" role="radio" aria-checked="${ui.accent === hex}" title="${name}" aria-label="${name}" style="--a:${hex}"></button>`)).join('');
      return `<h2 class="wel-h">Pick your colours</h2>
        <p class="wel-sub">The whole app changes as you pick. Settings → Appearance has more.</p>
        <div class="wel-pals" role="radiogroup" aria-label="Palette">${pal}</div>
        <div class="wel-label">Accent</div>
        <div class="wel-accs" role="radiogroup" aria-label="Accent colour">${acc}</div>`;
    }

    function layoutHtml() {
      const cur = UiPrefs.presetOf(state.ui);
      const tiles = UiPrefs.PRESETS.map((p) => `
        <button type="button" class="cz-preset wel-preset${p.id === cur ? ' is-active' : ''}" data-wel-preset="${p.id}" role="radio" aria-checked="${p.id === cur}">
          <span class="cz-art" data-art="${p.id}" aria-hidden="true">${presetArt(p.id)}</span>
          <span class="cz-preset-name">${esc(p.name)}</span>
          <span class="wel-preset-desc">${esc(p.desc)}</span>
        </button>`).join('');
      return `<h2 class="wel-h">Choose a layout</h2>
        <p class="wel-sub">Where the menu sits and how big things are. Right-click any empty spot later to fine-tune it live.</p>
        <div class="wel-presets" role="radiogroup" aria-label="Layout">${tiles}</div>`;
    }

    function gamesLine() {
      const n = state.games.filter((g) => !gvIsWishlisted(g)).length;
      return n ? `${WELCOME_CHECK}<span>${fmtNum(n)} game${n === 1 ? '' : 's'} in your library</span>` : '';
    }
    function gamesHtml() {
      return `<h2 class="wel-h">Bring in your games</h2>
        <p class="wel-sub">GameVault finds what’s installed from Steam, Epic, GOG, Xbox, EA, Ubisoft and more, or you can add any game by hand.</p>
        <div class="wel-actions">
          <button type="button" class="btn btn-primary wel-big" data-wel="import">Find my games</button>
          <button type="button" class="btn wel-big" data-wel="add">Add one by hand</button>
        </div>
        <p class="wel-done-line" data-wel-games aria-live="polite">${gamesLine()}</p>`;
    }

    function accountHtml() {
      if (signedIn()) {
        const u = state.account.user || {};
        return `<h2 class="wel-h">You’re signed in</h2>
          <p class="wel-done-line">${WELCOME_CHECK}<span>${esc(u.email || u.name || 'Signed in')}</span></p>
          <p class="wel-sub">Turn on library sync and save backups any time in Settings → Account and Backups.</p>`;
      }
      const prov = state.accountProviders || {};
      const social = SOCIAL.filter(([id]) => prov[id]);
      const pending = state.account && state.account.pending && state.account.pending.kind === 'oauth';
      const buttons = social.map(([id, name, icon]) => `<button type="button" class="btn acct-social wel-big" data-wel-oauth="${id}">${icon}<span>Continue with ${name}</span></button>`).join('');
      return `<h2 class="wel-h">Sync and back up <span class="wel-opt">optional</span></h2>
        <p class="wel-sub">A free account keeps your library in step across your PCs and backs up your game saves, encrypted. You can do this later in Settings.</p>
        <div class="wel-actions is-col">${buttons}
          <button type="button" class="acct-link" data-wel="email">Use email instead</button>
        </div>
        <p class="wel-wait" data-wel-wait aria-live="polite">${pending ? 'Finish signing in in your browser, then come back here.' : ''}</p>`;
    }

    function doneHtml() {
      const tip = (k, t) => `<li><kbd>${k}</kbd><span>${t}</span></li>`;
      return `<div class="wel-hex is-done">${WELCOME_HEX}</div>
        <h2 class="wel-h">You’re all set</h2>
        <p class="wel-sub">A few things worth knowing:</p>
        <ul class="wel-tips">
          ${tip('Ctrl F', 'Search your games or run a command')}
          ${tip('Right-click', 'On an empty spot to change the look live')}
          ${tip('Controller', 'Works everywhere. Big Picture is made for the couch')}
        </ul>`;
    }

    const BODY = { hello: helloHtml, colours: coloursHtml, layout: layoutHtml, games: gamesHtml, account: accountHtml, done: doneHtml };

    function build() {
      el = document.createElement('div');
      el.id = 'welcome';
      el.className = 'welcome';
      el.hidden = true;
      el.setAttribute('role', 'dialog');
      el.setAttribute('aria-modal', 'true');
      el.setAttribute('aria-label', 'Welcome to GameVault');
      el.innerHTML = `
        <div class="wel-top"><button type="button" class="btn btn-ghost wel-skip" data-wel="skip">Skip setup</button></div>
        <div class="wel-stage"><div class="wel-body" data-wel-body></div></div>
        <div class="wel-foot">
          <button type="button" class="btn btn-ghost wel-back" data-wel="back">Back</button>
          <div class="wel-dots" data-wel-dots aria-hidden="true"></div>
          <button type="button" class="btn btn-primary wel-next" data-wel="next">Next</button>
        </div>`;
      // the window is frameless and its own buttons hide with the app: a copy
      const ctl = document.querySelector('.win-controls');
      if (ctl) {
        const copy = ctl.cloneNode(true);
        for (const b of copy.querySelectorAll('[id]')) { b.dataset.win = b.id.replace('win-', ''); b.removeAttribute('id'); }
        copy.addEventListener('click', (e) => { const b = e.target.closest('[data-win]'); if (b) api[{ min: 'minimize', max: 'maximize', close: 'close' }[b.dataset.win]](); });
        el.querySelector('.wel-top').appendChild(copy);
      }
      document.body.appendChild(el);
      el.addEventListener('click', onClick);
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && $('#modal').hidden) { e.preventDefault(); if (at > 0) go(at - 1); }
      });
    }

    function paint(dir) {
      const id = steps[at];
      const body = el.querySelector('[data-wel-body]');
      body.innerHTML = BODY[id]();
      body.dataset.step = id;
      // a new step slides in; a repaint of the same step (sign-in options
      // arriving, the account changing) swaps in place without replaying it
      body.classList.remove('is-in', 'is-back');
      if (dir !== 0) {
        void body.offsetWidth;
        body.classList.add('is-in');
        if (dir < 0) body.classList.add('is-back');
      }
      el.dataset.step = id;
      el.querySelector('[data-wel-dots]').innerHTML = steps.map((s, i) => `<i class="${i === at ? 'is-on' : i < at ? 'is-past' : ''}"></i>`).join('');
      el.querySelector('.wel-back').style.visibility = at > 0 && id !== 'done' ? '' : 'hidden';
      el.querySelector('.wel-skip').style.visibility = id === 'done' ? 'hidden' : '';
      const next = el.querySelector('.wel-next');
      next.textContent = id === 'hello' ? 'Get started' : id === 'done' ? 'Start playing' : id === 'account' && !signedIn() ? 'Not now' : 'Next';
      clearInterval(watch);
      watch = null;
      if (id === 'games') {
        // the import and add dialogs open over the welcome: show what they added
        let last = state.games.length;
        watch = setInterval(() => {
          if (state.games.length === last) return;
          last = state.games.length;
          const line = el.querySelector('[data-wel-games]');
          if (line) line.innerHTML = gamesLine();
          if (state.games.length) next.textContent = 'Next';
        }, 600);
      }
      if (id === 'account' && !state.accountProviders && api.accountProviders) {
        api.accountProviders().then((p) => { state.accountProviders = p; if (isOpen() && steps[at] === 'account') paint(0); }).catch(() => {});
      }
      requestAnimationFrame(() => {
        const first = body.querySelector('.is-active') || (id === 'hello' || id === 'done' ? next : body.querySelector('button')) || next;
        if (el.contains(document.activeElement) && document.activeElement !== document.body && dir === 0) return;
        first.focus({ preventScroll: true });
      });
    }

    function go(i) {
      if (i < 0 || i >= steps.length) return;
      const dir = i > at ? 1 : -1;
      at = i;
      sfx('move');
      paint(dir);
    }

    function open({ again = false } = {}) {
      if (!el) build();
      if (state.settingsOpen) closeSettings();
      steps = plan();
      at = 0;
      // fetch the sign-in options now, so the account step is complete when it shows
      if (!state.accountProviders && api.accountProviders) api.accountProviders().then((p) => { state.accountProviders = p; }).catch(() => {});
      el.classList.toggle('is-again', again);
      el.hidden = false;
      document.documentElement.classList.add('is-welcome');
      const app = $('#app');
      if (app) app.inert = true;
      void el.offsetWidth;
      el.classList.add('is-open');
      paint(1);
    }

    function finish({ skipped = false } = {}) {
      clearInterval(watch);
      watch = null;
      saveConfigPatch({ welcomeDone: Date.now() });
      el.classList.remove('is-open');
      document.documentElement.classList.remove('is-welcome');
      const app = $('#app');
      if (app) app.inert = false;
      const done = () => { el.hidden = true; };
      if (prefersReducedMotion()) done(); else setTimeout(done, 260);
      // a full repaint, like coming back from a game page: what was drawn
      // behind the welcome (imports, sign-in, sync) is drawn again
      state._shelfKey = '';
      state._stageVisual = '';
      state._heroShown = '';
      renderLibrary();
      fadeIn(currentPane());
      refreshCounts();
      requestAnimationFrame(() => {
        if (pad.on) padEnsureFocus(true);
        else {
          const to = [document.querySelector('.side-item.is-active'), document.querySelector('.tab.is-active'), $('#btn-bigpicture')].find((x) => x && x.offsetParent !== null);
          if (to) to.focus({ preventScroll: true });
        }
      });
      if (skipped) toast('Setup skipped. Settings has everything, and About can show it again.', 'ok');
    }

    // LB / RB on a controller: the same as Back and Next
    function stepBy(d) {
      if (!isOpen()) return;
      if (d > 0) { if (at === steps.length - 1) finish(); else go(at + 1); }
      else if (at > 0 && steps[at] !== 'done') go(at - 1);
      else sfx('bump');
    }

    function mark(sel, btn) {
      for (const b of el.querySelectorAll(sel)) { const on = b === btn; b.classList.toggle('is-active', on); b.setAttribute('aria-checked', String(on)); }
    }

    function onClick(e) {
      const pal = e.target.closest('[data-wel-pal]');
      if (pal) { mark('[data-wel-pal]', pal); applyPalette(pal.dataset.welPal, { persist: true, fade: false }); return; }
      const acc = e.target.closest('[data-wel-acc]');
      if (acc) { mark('[data-wel-acc]', acc); setUi({ accent: acc.dataset.welAcc || null }); return; }
      const pre = e.target.closest('[data-wel-preset]');
      if (pre) { mark('[data-wel-preset]', pre); applyLookPreset(pre.dataset.welPreset); return; }
      const oauth = e.target.closest('[data-wel-oauth]');
      if (oauth) {
        oauth.disabled = true;
        const wait = el.querySelector('[data-wel-wait]');
        if (wait) wait.textContent = 'Opening your browser…';
        window.api.accountOAuth(oauth.dataset.welOauth)
          .then(() => { if (wait && !signedIn()) wait.textContent = 'Finish signing in in your browser, then come back here.'; })
          .catch((err) => { if (wait) wait.textContent = (err && err.message) || 'Couldn’t open the browser. Try again.'; })
          .finally(() => { oauth.disabled = false; });
        return;
      }
      const b = e.target.closest('[data-wel]');
      if (!b) return;
      const act = b.dataset.wel;
      if (act === 'next') { if (at === steps.length - 1) finish(); else go(at + 1); }
      else if (act === 'back') go(at - 1);
      else if (act === 'skip') finish({ skipped: true });
      else if (act === 'import') openImportModal();
      else if (act === 'add') openGameModal(null);
      else if (act === 'email') { finish(); openSettings('account'); }
    }

    function onAccount(st) {
      if (!isOpen() || steps[at] !== 'account') return;
      paint(0);
      if (st && st.signedIn) {
        const next = el.querySelector('.wel-next');
        next.textContent = 'Next';
        next.focus({ preventScroll: true });
      }
    }

    function maybeOpen() {
      if (state.config.welcomeDone || bp.on) return;
      open();
    }

    return { open, maybeOpen, isOpen, onAccount, stepBy, el: () => el };
  })();

  // ---------------------------------------------------------------------------
  // Updates: looked for at startup (unless turned off in Settings → About) and
  // with Check now. A new version opens a dialog with what's new; it downloads
  // when you say so and installs on restart.
  // ---------------------------------------------------------------------------
  const updateState = { status: 'idle', info: null, percent: 0, error: '', checkedAt: 0, manual: false };

  function updateStatusText(version) {
    const u = updateState;
    if (/experimental/i.test(String(version || ''))) return 'This is a test build, so it doesn’t look for updates.';
    if (u.status === 'checking') return 'Checking for a new version…';
    if (u.status === 'latest') return `You have the latest version${u.checkedAt ? ` · checked ${agoLabel(u.checkedAt)}` : ''}.`;
    if (u.status === 'available') return `Version ${u.info.version} is available.`;
    if (u.status === 'held') return `Version ${u.held} is available. Check now to see it.`;
    if (u.status === 'downloading') return `Downloading version ${u.info.version}… ${u.percent}%`;
    if (u.status === 'ready') return `Version ${u.info.version} is ready. It installs when GameVault restarts.`;
    if (u.status === 'error') return `Couldn’t check for updates: ${u.error}`;
    return state.config.updateCheck === false ? 'Not checked: automatic checks are off.' : 'Not checked yet.';
  }

  /** Release notes (markdown, HTML or a list) as plain, safe lines. */
  function releaseNotesHtml(raw) {
    let text = Array.isArray(raw) ? raw.map((x) => (typeof x === 'string' ? x : (x && x.note) || '')).join('\n') : String(raw || '');
    text = text.replace(/<\/(p|li|h\d)>/gi, '\n').replace(/<li[^>]*>/gi, '- ').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, '\'');
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !/^\*\*full changelog/i.test(l) && !/^https?:\/\/\S+$/.test(l)).slice(0, 40);
    if (!lines.length) return '<p class="rm-text">Fixes and improvements.</p>';
    let html = '';
    let inList = false;
    for (const l of lines) {
      const item = /^[-*•]\s+(.*)$/.exec(l);
      const clean = (t) => esc(t.replace(/\*\*(.+?)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1'));
      if (item) { if (!inList) { html += '<ul>'; inList = true; } html += `<li>${clean(item[1])}</li>`; continue; }
      if (inList) { html += '</ul>'; inList = false; }
      const head = /^#{1,6}\s+(.*)$/.exec(l);
      html += head ? `<h4>${clean(head[1])}</h4>` : `<p>${clean(l)}</p>`;
    }
    if (inList) html += '</ul>';
    return html;
  }

  const updates = (() => {
    let card = null;

    function refreshRow() {
      const el = document.querySelector('#st-panel [data-upd-status]');
      if (el) api.getAppVersion().then((v) => { if (el.isConnected) el.textContent = updateStatusText(v); }).catch(() => {});
    }

    function paintCard() {
      if (!card || !card.isConnected) { card = null; return; }
      const u = updateState;
      const prog = card.querySelector('[data-upd-progress]');
      const foot = card.querySelector('[data-upd-foot]');
      if (prog) {
        prog.hidden = u.status !== 'downloading';
        const bar = prog.querySelector('i');
        if (bar) bar.style.width = `${u.percent}%`;
        const pct = prog.querySelector('[data-upd-pct]');
        if (pct) pct.textContent = `${u.percent}%`;
      }
      if (!foot) return;
      const manual = u.info && u.info.manual;
      const want = u.status === 'ready' ? 'ready' : u.status === 'downloading' ? 'downloading' : 'offer';
      if (foot.dataset.mode === want) return;
      foot.dataset.mode = want;
      foot.innerHTML = want === 'ready'
        ? '<button type="button" class="btn btn-ghost" data-upd="close">When I close GameVault</button><button type="button" class="btn btn-primary" data-upd="restart">Restart now</button>'
        : want === 'downloading'
          ? '<button type="button" class="btn btn-ghost" data-upd="close">Hide</button><button type="button" class="btn btn-primary" disabled>Downloading…</button>'
          : `<button type="button" class="btn btn-ghost" data-upd="skip">Skip this version</button><button type="button" class="btn btn-ghost" data-upd="later">Later</button><button type="button" class="btn btn-primary" data-upd="go">${manual ? 'Copy the update command' : 'Update now'}</button>`;
      const first = foot.querySelector('.btn-primary:not([disabled])') || foot.querySelector('button');
      if (first && card.contains(document.activeElement)) first.focus();
    }

    function show() {
      const u = updateState;
      if (!u.info) return;
      const cur = u.info.currentVersion ? String(u.info.currentVersion).replace(/^v/, '') : '';
      const date = u.info.releaseDate ? fmtDate(u.info.releaseDate) : '';
      card = openModal(`
        <div class="modal-head">
          <h2>GameVault ${esc(String(u.info.version).replace(/^v/, ''))} is out</h2>
          <button class="close-x" data-close aria-label="Close">✕</button>
        </div>
        <div class="modal-body rm-body upd-body">
          <p class="rm-text">${cur ? `You have ${esc(cur)}.` : ''}${date ? ` Released ${esc(date)}.` : ''} Your library, settings and saves stay as they are.</p>
          <div class="upd-notes">${releaseNotesHtml(u.info.releaseNotes)}</div>
          <div class="upd-progress" data-upd-progress hidden><div class="upd-bar"><i></i></div><span data-upd-pct>0%</span></div>
        </div>
        <div class="modal-foot" data-upd-foot></div>`, { className: 'rm-modal upd-modal' });
      if (!card) return;
      card.querySelector('[data-close]').onclick = closeModal;
      card.querySelector('[data-upd-foot]').addEventListener('click', onFoot);
      paintCard();
      const first = card.querySelector('[data-upd-foot] .btn-primary:not([disabled])');
      if (first) first.focus();
    }

    async function onFoot(e) {
      const b = e.target.closest('[data-upd]');
      if (!b) return;
      const u = updateState;
      const act = b.dataset.upd;
      if (act === 'close') { closeModal(); if (u.status === 'ready') toast('The update installs when you close GameVault', 'ok'); return; }
      if (act === 'later') { closeModal(); if (api.snoozeUpdate) await api.snoozeUpdate(u.info.version, 24).catch(() => {}); toast('GameVault will remind you tomorrow', 'ok'); return; }
      if (act === 'skip') { closeModal(); if (api.skipUpdate) await api.skipUpdate(u.info.version).catch(() => {}); toast(`Version ${u.info.version} skipped. Check now in Settings → About still finds it.`, 'ok'); return; }
      if (act === 'restart') { if (api.installUpdate) api.installUpdate(); return; }
      if (act === 'go') {
        if (u.info.manual) {
          const cmd = u.info.installCommand || 'sudo pacman -Syu';
          let ok = false;
          try { ok = api.uiClipboardWrite ? await api.uiClipboardWrite(cmd) : (await navigator.clipboard.writeText(cmd), true); } catch (_) { ok = false; }
          toast(ok ? `Copied. Run it in a terminal: ${cmd}` : cmd, 'ok');
          return;
        }
        updateState.status = 'downloading';
        updateState.percent = 0;
        paintCard();
        refreshRow();
        if (api.downloadUpdate) api.downloadUpdate();
      }
    }

    // a dialog never pops up over a game, the welcome or another dialog: a toast says so instead
    function offer() {
      const busy = Object.values(state.live || {}).some((v) => typeof v === 'number') || welcome.isOpen() || !$('#modal').hidden || bp.on;
      if (busy && !updateState.manual) {
        toast(`GameVault ${updateState.info.version} is available`, 'ok', [{ label: 'See what’s new', run: show }]);
        return;
      }
      show();
    }

    function check({ manual = false } = {}) {
      if (!api.checkForUpdates) return;
      updateState.manual = manual;
      updateState.status = 'checking';
      refreshRow();
      api.checkForUpdates(manual).catch(() => {});
    }

    let wired = false;
    function init() {
      if (wired || !api.onUpdateAvailable) return;
      wired = true;
      api.onUpdateChecking(() => { if (updateState.status !== 'downloading') { updateState.status = 'checking'; refreshRow(); } });
      api.onUpdateAvailable((info) => {
        updateState.info = info || null;
        if (!info) return;
        if (updateState.status !== 'downloading' && updateState.status !== 'ready') updateState.status = 'available';
        updateState.checkedAt = Date.now();
        refreshRow();
        offer();
        updateState.manual = false;
      });
      api.onUpdateNotAvailable((d) => {
        // held: a newer version that was skipped or snoozed (automatic check)
        updateState.held = d && d.held ? String(d.held) : null;
        updateState.status = updateState.held ? 'held' : 'latest';
        updateState.checkedAt = Date.now();
        refreshRow();
        if (updateState.manual) toast('You have the latest version of GameVault', 'ok');
        updateState.manual = false;
      });
      api.onUpdateError((d) => {
        const msg = (d && d.message) || 'Unable to check for updates.';
        const wasDownloading = updateState.status === 'downloading';
        updateState.status = 'error';
        updateState.error = /net::|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET/i.test(msg) ? 'you seem to be offline' : msg.split('\n')[0].slice(0, 160);
        refreshRow();
        if (updateState.manual || wasDownloading) toast(wasDownloading ? `The download stopped: ${updateState.error}` : `Couldn’t check for updates: ${updateState.error}`, 'error');
        if (wasDownloading && updateState.info) { updateState.status = 'available'; paintCard(); }
        updateState.manual = false;
      });
      if (api.onUpdateProgress) api.onUpdateProgress((p) => { updateState.status = 'downloading'; updateState.percent = Math.max(0, Math.min(100, Number(p && p.percent) || 0)); paintCard(); refreshRow(); });
      if (api.onUpdateDownloaded) api.onUpdateDownloaded(() => {
        updateState.status = 'ready';
        refreshRow();
        if (card && card.isConnected) paintCard();
        else toast('The update is ready', 'ok', [{ label: 'Restart now', run: () => api.installUpdate && api.installUpdate() }]);
      });
      if (state.config.updateCheck !== false) setTimeout(() => check({ manual: false }), 8000);
    }

    return { init, check, show };
  })();

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
      showNotTracked(state.games.includes(g) ? g : null);
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

  // ---------------------------------------------------------------------------
  // Problem dialogs: a failure the user has to act on gets a dialog that says
  // what happened and offers the fix (a toast is gone before it is read).
  // With another dialog open it falls back to a toast, so it never replaces
  // what the user is doing.
  // ---------------------------------------------------------------------------

  // actions: [{ label, primary, side, keepOpen, run(card) }]
  function problemDialog({ title, body, detail = '', actions = [], fallback = '' }) {
    const wrap = $('#modal');
    if (wrap && !wrap.hidden && !wrap.classList.contains('is-closing')) {
      toast(fallback || title, 'error');
      return null;
    }
    const list = actions.length ? actions : [{ label: 'OK', primary: true }];
    const card = openModal(`
      <div class="modal-head">
        <h2>${esc(title)}</h2>
        <button class="close-x" data-close aria-label="Close">✕</button>
      </div>
      <div class="modal-body rm-body">
        <p class="rm-text">${body}</p>
        ${detail ? `<p class="err-detail">${esc(detail)}</p>` : ''}
      </div>
      <div class="modal-foot">
        ${list.map((a, i) => `<button class="btn ${a.primary ? 'btn-primary' : 'btn-ghost'}${a.side ? ' is-side' : ''}" data-act="${i}"${a.primary ? ' data-autofocus' : ''}>${esc(a.label)}</button>`).join('')}
      </div>`, { className: 'rm-modal err-modal' });
    if (!card) return null;
    card.querySelector('[data-close]').onclick = closeModal;
    for (const btn of card.querySelectorAll('[data-act]')) {
      const a = list[Number(btn.dataset.act)];
      btn.onclick = async () => {
        if (a.keepOpen) {
          btn.disabled = true;
          try { await (a.run && a.run(card)); } finally { btn.disabled = false; }
          return;
        }
        closeModal();
        if (a.run) a.run(card);
      };
    }
    return card;
  }

  // Play on a game with no program, or one whose .exe has gone: choose it
  // here, then it starts. missingPath is where the old one was.
  function askForExe(g, { missingPath = '' } = {}) {
    if (!g) return;
    const name = g.name || 'this game';
    const what = IS_WINDOWS ? '.exe' : 'program';
    problemDialog({
      title: missingPath ? `Can’t find the game’s ${what}` : `Choose the game’s ${what}`,
      body: missingPath
        ? `The ${what} GameVault starts for <b>${esc(name)}</b> isn’t there any more. It may have been moved or deleted, or its drive is disconnected. Choose it again to keep playing.`
        : `GameVault doesn’t know which ${what} starts <b>${esc(name)}</b> yet. Choose it once and Play works from then on.`,
      detail: missingPath,
      fallback: missingPath ? `Can’t find ${baseName(missingPath)}` : `Choose the ${what} for ${name} first`,
      actions: [
        { label: 'More settings', side: true, run: () => { if (state.games.includes(g)) openGameModal(g); } },
        { label: 'Cancel' },
        {
          label: `Choose the ${what}…`, primary: true, keepOpen: true,
          run: async () => {
            const file = await api.pickExe(missingPath || g.installDir || '');
            if (!file) return;
            closeModal();
            if (!state.games.includes(g)) return;
            g.exePath = file;
            saveGamesSoon();
            refreshGameUi(g);
            togglePlay(g.id);
          },
        },
      ],
    });
  }

  const openedBefore = new Map();
  // a launch that never ran must not count as "last played" either
  const playedBefore = new Map();
  function undoPlayed(g) {
    const key = g && String(g.id);
    if (!key || !playedBefore.has(key)) return;
    const was = playedBefore.get(key);
    playedBefore.delete(key);
    if (was == null) delete g.lastPlayed; else g.lastPlayed = was;
    undoOpened(g);
  }

  function undoOpened(g) {
    const key = g && String(g.id);
    if (!key || !openedBefore.has(key)) return;
    const was = openedBefore.get(key);
    openedBefore.delete(key);
    if (was == null) delete g.lastOpened; else g.lastOpened = was;
    saveGamesSoon();
    refreshCounts();
  }

  // The launch failed: say why, and offer what can fix it
  function showLaunchProblem(g, { error, code, path: where, isExe } = {}) {
    if (g && code === 'NOT_FOUND' && isExe) { askForExe(g, { missingPath: where || g.exePath || '' }); return; }
    const name = (g && g.name) || 'The game';
    const lines = String(error == null ? '' : error).split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    // the generic first line adds nothing; the reason and path follow it
    const detail = lines.filter((l) => !/^failed to launch game:?$/i.test(l)).join('\n');
    // Node's spawn codes, in plain words
    const hint = /\b(UNKNOWN|ENOEXEC)\b/.test(detail) ? 'Windows couldn’t run the file. It may not be a working program, it may need to run as administrator, or antivirus may have blocked it.'
      : /\b(EACCES|EPERM)\b/.test(detail) ? 'Windows didn’t allow it to run. It may need to run as administrator, or antivirus may have blocked it.'
        : /\bENOENT\b/.test(detail) ? 'The file or its folder wasn’t found.'
          : detail ? 'This is what went wrong:' : '';
    problemDialog({
      title: 'Couldn’t start the game',
      body: `<b>${esc(name)}</b> didn’t start.${hint ? ` ${hint}` : ''}`,
      detail,
      fallback: launchErrorText(error),
      actions: g ? [
        { label: 'Edit game', side: true, run: () => { if (state.games.includes(g)) openGameModal(g); } },
        { label: 'Close' },
        { label: 'Try again', primary: true, run: () => togglePlay(g.id) },
      ] : [],
    });
  }

  // Launched, but GameVault never saw it running, so the session isn't
  // timed. Asked once per game per run of the app; after that a toast.
  const untrackedAsked = new Set();
  function showNotTracked(g) {
    const name = (g && g.name) || 'The game';
    const msg = `${name} launched, but GameVault never saw it running. Edit → Launch & tracking to pick what to track`;
    if (!g || untrackedAsked.has(String(g.id))) { toast(msg, 'error'); return; }
    // asked once per run, but only once it was really shown (not a toast)
    const shown = problemDialog({
      title: 'This session isn’t being timed',
      body: `<b>${esc(name)}</b> was started, but GameVault never saw it running, so this session isn’t counted. This usually means the ${IS_WINDOWS ? '.exe' : 'program'} is only a launcher. Pick the program that really runs the game, while it’s running.`,
      fallback: msg,
      actions: [
        { label: 'Not now' },
        {
          label: 'Pick what to track', primary: true,
          run: () => {
            if (!state.games.includes(g)) return;
            openGameModal(g);
            const adv = $('#modal .adv-launch');
            if (adv) { adv.open = true; adv.scrollIntoView({ block: 'nearest' }); }
          },
        },
      ],
    });
    if (shown) untrackedAsked.add(String(g.id));
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
        .then((res) => {
          if (res && res.ok === false) {
            // still running (Steam-tracked, nothing found to close): keep timing it
            if (state.live[key] === 'stopping') state.live[key] = 0;
            refreshGameUi(g);
            toast(`Couldn’t close ${g.name || 'the game'}. Close it from the game itself; its time is still counted.`, 'error');
            return;
          }
          done();
        })
        .catch(() => { done(); toast('Could not stop the game', 'error'); });
      return;
    }

    // a second click while launching cancels the wait (not the click of a
    // double click: that would cancel and then launch a second copy)
    if (live === 'launching') {
      if (Date.now() - (launchClickAt.get(key) || 0) < 1500) return;
      clearLaunchWatchdog(key);
      delete state.live[key];
      refreshGameUi(g);
      return;
    }

    if (gvIsWishlisted(g)) {
      toast('Move it to your library to play it', 'error');
      return;
    }

    // Heroic, Lutris, Bottles and hand-set games only have "What to open"
    if (!g.exePath && !g.steamAppId && !g.launchTarget && !g.launcherPath) {
      askForExe(g);
      return;
    }

    sfx('launch');
    launchClickAt.set(key, Date.now());
    // a launch that fails puts this back (it must not count as playing)
    openedBefore.set(key, g.lastOpened);
    playedBefore.set(key, g.lastPlayed);
    g.lastOpened = Date.now();
    saveGamesSoon();
    state.live[key] = 'launching';
    armLaunchWatchdog(g);
    refreshGameUi(g);
    // main reads what to open and how to track it from games.json: write a
    // just-saved edit (or a just-added game) first
    flushGames().then(() => {
      if (state.live[key] === 'launching') api.launchGame(g.exePath, g.steamAppId, g.id, g.installDir, g.launcherPath);
    });
  }
  const launchClickAt = new Map();

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
    strip._stopMomentum = stopMomentum;

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
      // the button went up outside the rail before the drag began: over
      if (e.buttons === 0) { endDrag(); return; }
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
      // the click that ends this drag is ignored (it fires before any timer);
      // anything after it is a real press again
      setTimeout(() => { shelfDragMoved = false; }, 0);
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
    window.addEventListener('pointerup', endDrag);
    window.addEventListener('pointercancel', endDrag);
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
      // Tab out of the list closes it
      $('#sort-wrap')?.addEventListener('focusout', (e) => {
        if (!sortMenu.hidden && e.relatedTarget && !e.relatedTarget.closest('#sort-wrap')) closeSort();
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

      // not while a menu or the Customize panel has the keyboard
      const inMenu = !!(document.activeElement && document.activeElement.closest && document.activeElement.closest('#sort-wrap, #nav-menu, #cz, .sort-menu, .cz-menu'));
      if (!typing && !inMenu && !customize.isOpen() && (!e.gvPad || padInShelfStrip()) && state.view === 'shelf' && !onPageFilter() && !state.settingsOpen && !state.selectedId && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
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

    const seenNow = (id) => { if (!state.liveSeen) state.liveSeen = {}; state.liveSeen[id] = Date.now(); };
    const forgetSeen = (id) => { if (state.liveSeen) delete state.liveSeen[id]; };

    const markRunning = (gameId) => {
      const id = String(gameId);
      clearLaunchWatchdog(id);
      state.live[id] = 0;
      if (!state.liveStart) state.liveStart = {};
      state.liveStart[id] = Date.now();
      seenNow(id);
      return findGame(id);
    };

    if (api.onCaptureChanged) api.onCaptureChanged(() => { loadMedia(true).then(repaintCaptures); });
    if (api.onTrackingStarted) api.onTrackingStarted(({ gameId, resumed }) => {
      // already shown as running (noticed outside GameVault, or back from sleep)
      const quiet = resumed || typeof state.live[String(gameId)] === 'number';
      const g = markRunning(gameId);
      if (g) g.lastPlayed = Date.now();
      if (g && g.status !== 'Finished' && g.status !== 'Playing' && !gvIsWishlisted(g)) {
        g.status = 'Playing';
        saveGamesSoon();
      }
      refreshGameUi(g);
      backdrop.play();
      if (!quiet) toast(`Launched ${g ? g.name : 'game'}`, 'ok');
    });

    if (api.onTrackingTick) api.onTrackingTick(({ gameId, sessionMins }) => {
      const id = String(gameId);
      const mins = Number(sessionMins) || 0;
      clearLaunchWatchdog(id);
      const wasRunning = typeof state.live[id] === 'number';
      state.live[id] = mins;
      if (!state.liveStart) state.liveStart = {};
      state.liveStart[id] = Date.now() - mins * 60000;
      seenNow(id);
      if (!wasRunning) backdrop.play();
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
      forgetSeen(id);
      backdrop.play();
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
        if (g.saveDir && savesMode()) setTimeout(() => backupNow(g, { quiet: true }), 5000);
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
      const was = state.live[id];
      if (was == null || was === 'stopping') return;
      delete state.live[id];
      if (state.liveStart) delete state.liveStart[id];
      forgetSeen(id);
      const g = findGame(id);
      refreshGameUi(g);
      // noticed outside GameVault and gone before tracking began: just clear it
      if (was !== 'launching' && reason !== 'untracked') return;
      // it never ran: it was not played
      if (g && reason !== 'untracked') undoPlayed(g);
      const name = (g && g.name) || 'The game';
      if (reason === 'untracked') toast(`${name} launched — playtime tracking is off for this game`, 'ok');
      else showNotTracked(g);
    });

    if (api.onLaunchError) api.onLaunchError((info) => {
      const id = String((info && info.gameId) || '');
      if (id) clearLaunchWatchdog(id);
      if (id && Object.prototype.hasOwnProperty.call(state.live, id)) delete state.live[id];
      if (id && state.liveStart) delete state.liveStart[id];
      if (id) forgetSeen(id);
      const g = id ? findGame(id) : null;
      undoOpened(g);
      refreshGameUi(g);
      showLaunchProblem(g, info || {});
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

  // Errors go to the console and to renderer-errors.log next to the library,
  // so a "nothing works" report comes with the reason.
  function reportError(where, err) {
    const text = err && (err.stack || err.message) ? String(err.stack || err.message) : String(err);
    console.error(where, err);
    try { if (api.logError) api.logError({ where, text: text.slice(0, 4000) }); } catch (_) {}
  }
  window.addEventListener('error', (e) => reportError('error', e.error || e.message));
  window.addEventListener('unhandledrejection', (e) => reportError('promise', e.reason));

  // The window can only be "dead" in a few ways: the app left inert, an empty
  // dialog or the search backdrop still on top, or the Big Picture menu's
  // lock left behind. Every press checks for those and clears them, so a
  // missed clean-up heals on the next click instead of needing a restart.
  function initUnstick() {
    const heal = () => {
      const app = $('#app');
      const modal = $('#modal');
      const fixed = [];
      const modalOpen = modal && !modal.hidden && !modal.classList.contains('is-closing') && modal.firstElementChild;
      if (modal && !modal.hidden && !modal.firstElementChild) { modal.hidden = true; modal.classList.remove('is-closing'); fixed.push('empty dialog'); }
      const menu = $('#bp-menu');
      const menuOpen = bp.menuOpen && menu && !menu.hidden;
      if (bp.menuOpen && !menuOpen) { bp.menuOpen = false; fixed.push('menu flag'); }
      if (!menuOpen && document.documentElement.classList.contains('bp-menu-open')) { document.documentElement.classList.remove('bp-menu-open'); fixed.push('menu lock'); }
      // the welcome keeps the app inert behind it on purpose
      if (app && app.inert && !modalOpen && !menuOpen && !welcome.isOpen()) { app.inert = false; fixed.push('inert app'); }
      const scrim = $('#scrim');
      if (scrim && scrim.classList.contains('open') && !spotHooks.isOpen()) { scrim.classList.remove('open'); fixed.push('search backdrop'); }
      if (fixed.length) reportError('unstick', new Error(`cleared: ${fixed.join(', ')}`));
    };
    window.addEventListener('pointerdown', heal, true);
    window.addEventListener('keydown', heal, true);
  }

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
      // the library file was damaged: say so, and where the copy is
      if (api.loadIssue) api.loadIssue().then((issue) => {
        if (!issue) return;
        const kept = issue.kept ? String(issue.kept) : '';
        problemDialog({
          title: issue.restored ? 'Your library was restored from a backup' : 'GameVault couldn’t read your library',
          body: issue.restored
            ? 'Your library file was damaged, so GameVault opened the last backup of it. Your most recent changes may be missing.'
            : `Your library file was damaged and there was no backup to open, so the library looks empty.${kept ? ' A copy of the damaged file was kept, so nothing is lost for good.' : ''}`,
          detail: kept,
          fallback: issue.restored ? 'Library restored from a backup' : 'Couldn’t read your library',
          actions: kept
            ? [{ label: 'Show the copy', side: true, run: () => api.showInFolder(kept) }, { label: 'OK', primary: true }]
            : [{ label: 'OK', primary: true }],
        });
      }).catch(() => {});
      const norm = normalizeGames(games);
      state.games = norm.games;
      state.config = (config && typeof config === 'object') ? config : {};
      // palette/tier are saved to config on change, so config wins; the view
      // is only kept in localStorage, so localStorage wins for the view
      if (TIERS.includes(state.config.tier)) state.tier = state.config.tier;
      if (PALETTES.includes(state.config.palette)) state.palette = state.config.palette;
      state.ui = UiPrefs.normalize(state.config.ui);
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
      problemDialog({
        title: 'Couldn’t load your library',
        body: 'GameVault couldn’t read your games. Nothing has been changed or deleted. Reload to try again.',
        detail: String((e && e.message) || e || ''),
        fallback: 'Could not load the library',
        actions: [{ label: 'Close' }, { label: 'Reload', primary: true, run: () => location.reload() }],
      });
    }

    // one time, coming from 1.3: its colour theme becomes a palette and accent
    try {
      if (state.config.theme && !state.config.ui && !state.config.lookFrom131) {
        const old = UiPrefs.fromOldTheme(state.config.theme, state.config.customTheme);
        if (old) {
          state.palette = old.palette;
          state.ui = UiPrefs.normalize({ ...state.ui, accent: old.accent });
          saveConfigPatch({ palette: old.palette, ui: state.ui, lookFrom131: true });
        } else saveConfigPatch({ lookFrom131: true });
      }
    } catch (e) {
      console.warn('1.3 theme carry-over failed', e);
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

    // Each step runs on its own: one that throws is logged and the rest
    // still wire up, so a single bug can't leave every button dead.
    const step = (name, fn) => { try { fn(); } catch (e) { reportError(`boot:${name}`, e); } };
    step('palette', () => applyPalette(state.palette));
    step('ui', () => applyUi(state.ui || state.config.ui));
    step('look', () => { lookHist.committed = lookSnap(); initCustomize(); });
    step('nav', () => initNavLayouts());
    step('tier', () => applyTier(state.tier));
    step('view', () => applyView());
    step('wire', () => wire());
    step('sfx', () => applySfxConfig());
    step('actions', () => initGameActions());
    step('sounds', () => initUiSounds());
    step('controller', () => initController());
    step('bigpicture', () => initBigPicture());
    step('unstick', () => initUnstick());
    step('autosync', () => initAutoSync());

    step('sort', () => updateSortUi());
    step('perf', () => syncPerfRecorder());
    step('filter', () => {
      const storedFilter = lsGet('gv.filter');
      if (storedFilter && storedFilter !== 'All' && FILTER_LABELS[storedFilter]) {
        state.filter = storedFilter;
        for (const btn of $$('.tab[data-filter]')) btn.classList.toggle('is-active', btn.dataset.filter === storedFilter);
        const ft = $('#filter-title');
        if (ft) ft.textContent = filterLabel(storedFilter);
        syncSidePill();
      }
    });
    step('library', () => renderLibrary());
    step('counts', () => refreshCounts());
    step('thumbs', () => prepareThumbs());
    step('art', () => enrichArt());

    initGovernor();
    step('welcome', () => welcome.maybeOpen());
    step('updates', () => updates.init());

  }

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
  const applySidebar = (open, animate, remember = true) => {
    if (!sideEl) return;
    finishSideAnim();
    const label = open ? 'Collapse sidebar' : 'Expand sidebar';
    if (remember) { try { localStorage.setItem('gv.sidebar', open ? 'open' : 'closed'); } catch (_) {} }
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
  const storedSideOpen = () => { try { return localStorage.getItem('gv.sidebar') !== 'closed'; } catch (_) { return true; } };
  applySidebar(storedSideOpen(), false);

  // Every nav layout is this one sidebar restyled (style.css "Navigation
  // layouts"). Only the classic sidebar folds on request; the dock and top
  // tabs lay their rows out flat.
  if (sideEl) {
    for (const b of sideEl.querySelectorAll('.side-item')) {
      const label = b.querySelector('span');
      if (!b.title && label) b.title = label.textContent.trim();
    }
  }
  const appEl = $('#app');
  const topbarEl = $('#topbar');
  const winCtl = document.querySelector('.win-controls');
  const winHome = winCtl && winCtl.parentElement;
  const placeNav = (ui) => {
    if (!sideEl || !appEl || !topbarEl) return;
    const intoTop = ui.nav === 'top';
    if (intoTop && sideEl.parentElement !== topbarEl) topbarEl.insertBefore(sideEl, topbarEl.querySelector('.filter-title'));
    else if (!intoTop && sideEl.parentElement !== appEl) appEl.insertBefore(sideEl, appEl.firstChild);
    if (!winCtl || !winHome) return;
    const corner = ui.navSide === 'right' && ui.nav === 'sidebar';
    const brand = sideEl.querySelector('.side-brand');
    if (corner && brand && winCtl.parentElement !== brand) brand.appendChild(winCtl);
    else if (!corner && winCtl.parentElement !== winHome) winHome.appendChild(winCtl);
  };
  // the dock shows each button's name in its own label above it; elsewhere
  // the system tooltip stays
  const dockLabels = (on) => {
    if (!sideEl) return;
    for (const b of sideEl.querySelectorAll('.side-item, .side-account')) {
      if (on && b.title) { b.dataset.tip = b.title; b.removeAttribute('title'); }
      else if (!on && b.dataset.tip) { b.title = b.dataset.tip; delete b.dataset.tip; }
    }
  };
  // a new layout arrives: the navigation slides in from where it now lives
  let lastNav = null;
  const playNavIn = (ui) => {
    const from = lastNav;
    lastNav = `${ui.nav}|${ui.navSide}|${ui.dockStyle}`;
    if (!from || from === lastNav || prefersReducedMotion() || !sideEl || !sideEl.offsetParent) return;
    const ease = 'cubic-bezier(0.2, 0.9, 0.25, 1)';
    const off = ui.nav === 'dock' ? 'translateY(26px)' : ui.nav === 'top' ? 'translateY(-10px)'
      : ui.navSide === 'right' ? 'translateX(22px)' : 'translateX(-22px)';
    const anim = sideEl.animate([{ opacity: 0, transform: off }, { opacity: 1, transform: 'none' }], { duration: 340, easing: ease });
    if (mainEl) mainEl.animate([{ opacity: 0.55 }, { opacity: 1 }], { duration: 260, easing: 'ease-out' });
    // things placed by measuring the nav (the in-nav search, the pill) were
    // measured mid-slide: measure again once it has landed
    anim.finished.then(() => { syncSidePill(); spotHooks.resync(); }).catch(() => {});
  };
  navHooks.apply = (ui) => {
    const nav = ui.nav;
    placeNav(ui);
    dockLabels(nav === 'dock');
    playNavIn(ui);
    if (nav === 'sidebar') applySidebar(storedSideOpen(), false, false);
    else applySidebar(true, false, false);
    if (sideToggle) {
      const folds = nav === 'sidebar';
      sideToggle.tabIndex = folds ? 0 : -1;
      if (!folds) { sideToggle.removeAttribute('aria-expanded'); sideToggle.setAttribute('aria-label', 'GameVault'); sideToggle.title = 'GameVault'; }
    }
    closeNavMenu();
    dockPeek(false);
    requestAnimationFrame(() => { syncSidePill(); spotHooks.resync(); });
  };

  if (sideToggle) sideToggle.onclick = () => {
    if (state.ui && state.ui.nav !== 'sidebar') return;
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
  // the game page's hero runs under the top row at rest; once scrolled,
  // Big Picture fades the page out under that row (style.css)
  const gameScroll = $('#game-view');
  if (gameScroll) {
    gameScroll.addEventListener('scroll', () => {
      gameScroll.classList.toggle('is-scrolled', gameScroll.scrollTop > 40);
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
    const initials = (t) => GVLocale.initials(t);
    const mark = (t, q) => {
      if (!q) return esc(t);
      const i = String(t).toLowerCase().indexOf(String(q).toLowerCase());
      return i < 0 ? esc(t) : esc(String(t).slice(0, i)) + '<b>' + esc(String(t).slice(i, i + q.length)) + '</b>' + esc(String(t).slice(i + q.length));
    };
    const score = (t, q) => {
      t = String(t).toLowerCase(); q = String(q).toLowerCase();
      // a match deep in a long title still beats a loose letter match
      const i = t.indexOf(q); if (i >= 0) return Math.max(41, 100 - i);
      let j = 0; for (const c of t) if (c === q[j]) j++;
      return j === q.length ? 40 : 0;
    };

    const actions = () => [
      { icon: 'plus', title: 'Add game', run: () => $('#btn-add')?.click() },
      { icon: 'down', title: 'Import games', run: () => $('#btn-import')?.click() },
      { icon: 'star', title: 'Open wishlist', run: () => (bp.on ? bpGo('wishlist') : setFilter('Want')) },
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
      // the icon slot is made for small square spots like this one; the
      // cover is only the fallback for games without an icon
      gicon: g.iconUrl || '',
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
        : it.gicon
          ? `<span class="thumb is-icon"><img src="${esc(toFileUrl(it.gicon))}" data-alt="${esc(it.cover ? toFileUrl(it.cover) : '')}" alt="" loading="lazy"></span>`
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
      // an icon file that's gone falls back to the cover, then to initials
      for (const img of rowsEl.querySelectorAll('.thumb.is-icon img')) {
        img.addEventListener('error', () => {
          const t = img.parentElement;
          const alt = img.dataset.alt;
          if (alt) { t.classList.remove('is-icon'); img.removeAttribute('data-alt'); img.src = alt; return; }
          const it = flat[Number(t.closest('.item')?.dataset.i)];
          t.classList.remove('is-icon');
          t.textContent = initials(it ? it.title : '');
        });
      }
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
    // Where the closed search rests (Settings → Appearance → Search):
    // the top bar's slot (centre or left), a slot inside the navigation, a
    // round button in the corner, or nowhere (it still opens with Ctrl F, /, Y).
    // Big Picture always uses the top bar.
    const sideSlot = $s('#side-search-slot');
    const placement = () => {
      const ui = state.ui;
      if (!ui || document.documentElement.classList.contains('is-bigpicture')) return 'top';
      // no nav, or a dock that slides away: the top bar keeps it
      if (ui.search === 'in-nav') return ui.nav === 'none' || (ui.nav === 'dock' && ui.dockAutoHide) ? 'top' : 'nav';
      if (ui.search === 'floating') return 'float';
      if (ui.search === 'hidden') return 'ghost';
      return 'top';
    };
    const rectOf = (el) => { const r = el.getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height }; };
    const restRect = () => {
      const where = placement();
      if (where === 'nav' && sideSlot && sideSlot.offsetParent) return rectOf(sideSlot);
      if (where === 'float') {
        // the bottom-right corner of the main panel (not the window: a
        // right-hand sidebar or a bottom dock sits there)
        const size = 48;
        const m = ($('#main') || document.querySelector('.main')).getBoundingClientRect();
        return { left: m.right - 16 - size, top: m.bottom - 16 - size, width: size, height: size };
      }
      if (where === 'ghost') {
        const o = openRect();
        return { left: o.left + o.width / 2 - 60, top: o.top, width: 120, height: 34 };
      }
      return rectOf(slot);
    };
    const geom = (r) => {
      spot.style.left = r.left + 'px'; spot.style.top = r.top + 'px'; spot.style.width = r.width + 'px'; spot.style.height = r.height + 'px';
      // closed and small (a nav slot, the corner button): just the magnifier
      spot.classList.toggle('is-compact', !isOpen && r.width < 120 && placement() !== 'ghost');
      const slim = !isOpen && r.width < 260;
      spot.classList.toggle('is-slim', slim);
      // a narrow box says less, so the word isn't cut
      if (!input.dataset.fullPh) input.dataset.fullPh = input.placeholder;
      input.placeholder = slim && r.width < 200 ? 'Search' : input.dataset.fullPh;
      spot.classList.toggle('is-round', !isOpen && placement() === 'float');
      spot.classList.toggle('is-ghost', !isOpen && placement() === 'ghost');
    };

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
      spot.classList.remove('is-compact', 'is-round', 'is-ghost');
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
    for (const el of [slot, sideSlot, $s('#topbar'), $s('#filter-title'), $s('#topbar .top-actions')]) if (el) slotRO.observe(el);

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
  // Face buttons and symbols are drawn, not typed: a font's ✕ □ △ (and even
  // its A B X Y) never sit in the optical centre of a round button.
  const PAD_GLYPH_SVG = {
    xbox: {
      a: '<path d="M6.6 18.8 12 5.2l5.4 13.6M8.7 13.9h6.6"/>',
      b: '<path d="M8.2 5.2v13.6M8.2 5.2h4.3a3.3 3.3 0 0 1 0 6.6H8.2M8.2 11.8h5a3.5 3.5 0 0 1 0 7h-5"/>',
      x: '<path d="m6.8 5.4 10.4 13.2M17.2 5.4 6.8 18.6"/>',
      y: '<path d="m6.6 5.2 5.4 7.4 5.4-7.4M12 12.6v6.2"/>',
    },
    ps: {
      a: '<path d="m6.4 6.4 11.2 11.2M17.6 6.4 6.4 17.6"/>',
      b: '<circle cx="12" cy="12" r="6.9"/>',
      x: '<rect x="5.6" y="5.6" width="12.8" height="12.8" rx="1.2"/>',
      y: '<path d="M12 5.6 19 17.9H5z"/>',
    },
    any: {
      menu: '<path d="M6 7.6h12M6 12h12M6 16.4h12"/>',
      view: '<rect x="4.6" y="9" width="10" height="10" rx="1.6"/><path d="M9.6 9V6.4a1.4 1.4 0 0 1 1.4-1.4h7a1.4 1.4 0 0 1 1.4 1.4v7a1.4 1.4 0 0 1-1.4 1.4h-3.4"/>',
      guide: '<path d="m4.8 11.6 7.2-6.4 7.2 6.4"/><path d="M7.2 10.4V19h9.6v-8.6"/>',
    },
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
          if (out.actions.length || out.scroll.y || out.scroll.x) window.GvAmbient?.wake?.(); // the background idles without input
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
    if (welcome.isOpen()) return welcome.el();
    if (spotHooks.isOpen()) return $('#spot');
    const sort = $('#sort-menu');
    const menuOpen = Array.from(document.querySelectorAll('[role="menu"]')).some((m) => !m.hidden && m.getClientRects().length && !m.closest('#cz'));
    // the Customize panel holds the controller while it's open (B closes it)
    if (customize.isOpen() && !menuOpen && !(sort && !sort.hidden)) return customize.el;
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
    // up out of a scrolled page into the top row: the page goes back to its
    // top too, so its title and stats are not left hidden
    const from = document.activeElement;
    const pane = from && from.closest && from.closest('#library, #wishlist-view, #activity-view, #game-view, .st-panel');
    if (pane && !pane.contains(el) && el.closest && el.closest('.topbar') && pane.scrollTop > 0) {
      pane.scrollTo({ top: 0, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
    }
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
      // Big Picture always keeps something focused (a keyboard needs it too)
      if (!pad.on && !bp.on) return;
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
    // the welcome holds the controller: move, pick, back, scroll; LB / RB step
    // through it. Nothing reaches the library behind it.
    if (welcome.isOpen() && $('#modal').hidden) {
      if (a === 'prev' || a === 'next') { welcome.stepBy(a === 'next' ? 1 : -1); return padEnsureFocus(); }
      if (!(a in PAD_KEYS) && !['confirm', 'back', 'pageUp', 'pageDown'].includes(a)) return;
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
      if (!$('#modal').hidden || spotHooks.isOpen() || customize.isOpen()) return;
      // on a game: its options (edit, finished, folder…); anywhere else: Settings
      const g = padMenuGame();
      if (g) { openGameActions(g); return padEnsureFocus(); }
      if (bp.on) return bpOpenMenu();
      if (state.settingsOpen) closeSettings(); else openSettings();
      return padEnsureFocus(true);
    }
    if (a === 'view') {
      if (!$('#modal').hidden || spotHooks.isOpen() || state.settingsOpen || customize.isOpen()) return;
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
    let cands = all.filter((c) => !vertical || region(c.el) === here || (fromTop && dir === 'down'));
    // dock and top tabs lie flat: move along them sideways, step on and off
    // them up and down
    const flatNav = state.ui && (state.ui.nav === 'dock' || state.ui.nav === 'top');
    if (flatNav) {
      const inSide = (c) => region(c.el) === 'side';
      if (here === 'side') cands = vertical ? all.filter((c) => !inSide(c)) : all.filter(inSide);
      else if (vertical) cands = all.filter((c) => region(c.el) === here || inSide(c) || (fromTop && dir === 'down'));
      else cands = cands.filter((c) => !inSide(c));
    }
    const sameRow = (r) => Math.min(from.bottom, r.bottom) - Math.max(from.top, r.top) > 0;
    let next;
    if (flatNav && here === 'side') {
      next = window.PadInput.pickNext(from, cands, dir);
    } else if (!vertical && !fromTop) {
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
    // in the welcome, down into the footer goes to Next (Back is B, or one step left)
    if (next && dir === 'down' && next.el.matches('.wel-back') && !$('#welcome .wel-foot').contains(active)) {
      const fwd = $('#welcome .wel-next');
      if (padFocusable(fwd)) next = { el: fwd, rect: fwd.getBoundingClientRect() };
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
    if (welcome.isOpen() && $('#modal').hidden) return;
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
    if (!$('#modal').hidden || spotHooks.isOpen() || customize.isOpen()) return;
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
    const draw = (PAD_GLYPH_SVG[set] || PAD_GLYPH_SVG.xbox)[btn] || PAD_GLYPH_SVG.any[btn];
    const t = draw
      ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${draw}</svg>`
      : `<b>${(PAD_GLYPH_TEXT[set] || PAD_GLYPH_TEXT.xbox)[btn] || btn.toUpperCase()}</b>`;
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
    else if (modalOpen || customize.isOpen()) { add(['a'], 'Select'); add(['b'], 'Close'); }
    else if (welcome.isOpen()) { add(['a'], 'Select'); add(['b'], 'Back'); add(['lb', 'rb'], 'Step'); }
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
    // Big Picture with a keyboard: the arrows move between covers and rows
    // like the pad does (the normal layout keeps Tab and the shelf arrows)
    document.addEventListener('keydown', (e) => {
      if (!bp.on || e.gvPad || e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      const dir = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' }[e.key];
      if (!dir) return;
      const a = document.activeElement;
      if (a && a.matches && a.matches('input, textarea, select, [contenteditable="true"]')) return;
      if (a && a !== document.body && !(a.closest && a.closest('#grid, #shelf, #wishlist-view, #activity-view, #game-view, .topbar, #bp-menu'))) return;
      e.preventDefault();
      padMove(dir);
    });
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
    customize.close(); // Big Picture keeps its own look
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
    // without a pad, padEnsureFocus does nothing: hand focus to the button that
    // opens Big Picture (or the active section), never <body>
    if (!pad.on) {
      requestAnimationFrame(() => {
        const a = document.activeElement;
        if (a && a !== document.body && a.isConnected && a.offsetParent !== null) return;
        const to = [$('#btn-bigpicture'), document.querySelector('.side-item.is-active'), document.querySelector('.tab.is-active')]
          .find((el) => el && el.offsetParent !== null);
        if (to) to.focus({ preventScroll: true });
      });
    }
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
      if (el) el.textContent = new Date().toLocaleTimeString(LOC, { hour: 'numeric', minute: '2-digit' });
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
