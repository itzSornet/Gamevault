/*
 * Customizable UI: the layout, colour and glass choices a user makes, in one
 * small object (config.ui). Pure, no DOM: the renderer turns it into html
 * attributes and CSS variables (applyUi in app.js), so nothing re-renders.
 *
 * Every default equals the look GameVault had before this existed, so a user
 * who touches nothing sees no change.
 *
 * Synced through the account as one compact field next to the library
 * (see cloud.js). syncable() drops what must stay on this PC: the path of a
 * custom background file is local; only "a custom background is chosen" travels.
 *
 * UMD: window.UiPrefs in the renderer, module.exports in Node (tests).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.UiPrefs = factory();
}(typeof self !== 'undefined' ? self : this, () => {
  const VERSION = 1;

  const CHOICES = {
    nav: ['sidebar', 'dock', 'top', 'none'],
    navSide: ['left', 'right'],
    dockPos: ['bottom'],
    dockStyle: ['floating', 'attached'],
    search: ['top-center', 'top-left', 'in-nav', 'floating', 'hidden'],
    density: ['comfortable', 'compact'],
    background: ['fluid', 'art', 'solid', 'image', 'video'],
    cardSize: ['small', 'medium', 'large'],
    shelfSize: ['small', 'medium', 'large'],
    // full = follow Windows' own "animation effects" setting (the old behaviour)
    motion: ['full', 'reduced', 'off'],
    colorScheme: ['palette', 'system'],
  };

  // [min, max] for numbers; the default sits in DEFAULTS
  const RANGES = {
    radius: [0, 2],
    tint: [0, 100],
    fontScale: [90, 120],
    backgroundDim: [0, 100],
    'glass.blur': [0, 200],        // % of each surface's own blur
    'glass.opacity': [40, 140],    // % of each surface's own opacity; same floor as the Appearance slider
    'glass.saturation': [50, 150], // % of each surface's own saturation
  };

  const DEFAULTS = Object.freeze({
    v: VERSION,
    nav: 'sidebar',
    navSide: 'left',
    dockPos: 'bottom',
    dockStyle: 'floating',
    dockAutoHide: false,
    search: 'top-center',
    density: 'comfortable',
    radius: 1,
    accent: null,
    tint: 0,
    glass: Object.freeze({ blur: 100, opacity: 100, saturation: 100, solid: false }),
    background: 'fluid',
    backgroundFile: null,          // local path in userData; never synced
    backgroundKind: null,          // 'image' | 'video' for the file above
    backgroundColor: null,
    backgroundDim: 40,
    cardSize: 'medium',
    shelfSize: 'medium',
    showTitles: true,
    showPlaytime: true,
    showRatings: true,
    motion: 'full',
    fontScale: 100,
    colorScheme: 'palette',
  });

  // the accent swatches in Settings → Appearance (any other colour works too)
  const ACCENTS = Object.freeze([
    ['#4c7dff', 'Blue'], ['#7c4dff', 'Violet'], ['#d946ef', 'Magenta'], ['#ec4899', 'Pink'],
    ['#ef4444', 'Red'], ['#f0603a', 'Orange'], ['#f5a524', 'Amber'], ['#84cc16', 'Lime'],
    ['#1fa774', 'Green'], ['#14b8a6', 'Teal'], ['#22b8e6', 'Sky'], ['#94a3b8', 'Slate'],
  ]);

  const clone = (o) => JSON.parse(JSON.stringify(o));
  const defaults = () => clone(DEFAULTS);

  const HEX = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;
  function hex(v) {
    if (typeof v !== 'string') return null;
    const m = v.trim().match(HEX);
    if (!m) return null;
    let h = m[1].toLowerCase();
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    return `#${h}`;
  }

  function num(v, [lo, hi], dflt) {
    const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
    if (typeof n !== 'number' || !Number.isFinite(n)) return dflt;
    return Math.round(Math.min(hi, Math.max(lo, n)));
  }
  const pick = (v, list, dflt) => (list.includes(v) ? v : dflt);
  const bool = (v, dflt) => (typeof v === 'boolean' ? v : dflt);

  /** Anything (old config, an imported look, garbage) -> a complete, valid prefs object. */
  function normalize(raw) {
    const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const d = DEFAULTS;
    const out = { v: VERSION };
    for (const [k, list] of Object.entries(CHOICES)) out[k] = pick(r[k], list, d[k]);
    out.dockAutoHide = bool(r.dockAutoHide, d.dockAutoHide);
    out.radius = num(r.radius, RANGES.radius, d.radius);
    out.tint = num(r.tint, RANGES.tint, d.tint);
    out.fontScale = num(r.fontScale, RANGES.fontScale, d.fontScale);
    out.backgroundDim = num(r.backgroundDim, RANGES.backgroundDim, d.backgroundDim);
    out.accent = hex(r.accent);
    out.backgroundColor = hex(r.backgroundColor);
    const g = r.glass && typeof r.glass === 'object' ? r.glass : {};
    out.glass = {
      blur: num(g.blur, RANGES['glass.blur'], d.glass.blur),
      opacity: num(g.opacity, RANGES['glass.opacity'], d.glass.opacity),
      saturation: num(g.saturation, RANGES['glass.saturation'], d.glass.saturation),
      solid: bool(g.solid, d.glass.solid),
    };
    out.backgroundFile = typeof r.backgroundFile === 'string' && r.backgroundFile ? r.backgroundFile : null;
    out.backgroundKind = pick(r.backgroundKind, ['image', 'video'], null);
    for (const k of ['showTitles', 'showPlaytime', 'showRatings']) out[k] = bool(r[k], d[k]);
    // Top tabs already sit in the top bar, and None has no navigation: the
    // search goes back to the top bar's centre
    if (out.search === 'in-nav' && (out.nav === 'none' || out.nav === 'top')) out.search = 'top-center';
    // a custom background needs its file; without it (another PC, file gone) use fluid
    if ((out.background === 'image' || out.background === 'video') && !out.backgroundFile) out.background = 'fluid';
    // a pasted or synced look can ask for 'video' while this PC's file is a
    // picture (or the other way round): show the file there is, never black
    if ((out.background === 'image' || out.background === 'video') && out.backgroundKind && out.background !== out.backgroundKind) out.background = out.backgroundKind;
    return out;
  }

  /** The part that travels with the account: no local paths. */
  function syncable(ui) {
    const n = normalize(ui);
    const out = { ...n };
    delete out.backgroundFile;
    delete out.backgroundKind;
    // keep the wish for a custom background so a PC that has one can honour it
    if (ui && (ui.background === 'image' || ui.background === 'video')) out.background = ui.background;
    return out;
  }

  /** Take synced prefs into this PC's, keeping this PC's own file. */
  function adopt(local, remote) {
    const mine = normalize(local);
    const r = remote && typeof remote === 'object' ? remote : {};
    return normalize({ ...r, backgroundFile: mine.backgroundFile, backgroundKind: mine.backgroundKind });
  }

  const isDefault = (ui) => JSON.stringify(syncable(ui)) === JSON.stringify(syncable(DEFAULTS));

  // ------------------------------------------------------------------ colour

  function rgb(h) {
    const x = hex(h);
    if (!x) return null;
    return [1, 3, 5].map((i) => parseInt(x.slice(i, i + 2), 16));
  }
  const toHex = (c) => `#${c.map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('')}`;
  const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);

  function luminance(c) {
    const [r, g, b] = c.map((v) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }
  function contrast(a, b) {
    const la = luminance(a);
    const lb = luminance(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  }

  /** Black or white text on this colour, whichever reads better. */
  function onColor(h) {
    const c = rgb(h);
    if (!c) return '#ffffff';
    return contrast(c, [255, 255, 255]) >= contrast(c, [0, 0, 0]) ? '#ffffff' : '#000000';
  }

  /**
   * An accent that stays visible on the surface: if it is too close to the
   * surface (under 3:1), move it toward white on dark surfaces or black on
   * light ones, in small steps, until it reads.
   */
  function readableAccent(accent, surface) {
    const a = rgb(accent);
    const s = rgb(surface) || [15, 17, 23];
    if (!a) return null;
    if (contrast(a, s) >= 3) return toHex(a);
    const toward = luminance(s) < 0.4 ? [255, 255, 255] : [0, 0, 0];
    for (let t = 0.08; t <= 0.9; t += 0.08) {
      const c = mix(a, toward, t);
      if (contrast(c, s) >= 3) return toHex(c);
    }
    return toHex(mix(a, toward, 0.9));
  }

  // the palette colours that tint leans toward the accent
  const TINT_KEYS = ['--bg', '--bg-2', '--surface', '--surface-2', '--surface-3', '--line', '--line-2', '--main-glass', '--hero-base', '--art-well', '--shade-rgb'];
  const TINT_MAX = 0.2; // tint 100 = surfaces are 20% accent

  function parseColor(v) {
    if (typeof v !== 'string') return null;
    const t = v.trim();
    if (t.startsWith('#')) { const c = rgb(t); return c ? { c, triple: false } : null; }
    const parts = t.split(',').map((x) => Number(x.trim()));
    if (parts.length === 3 && parts.every((x) => Number.isFinite(x))) return { c: parts, triple: true };
    return null;
  }

  /**
   * Tinted versions of the palette's own colours. `base` maps a TINT_KEYS name
   * to its current value (#hex or an "r, g, b" triple); the result keeps each
   * value's format. Tint 0 removes the overrides (null).
   */
  function tintVars(base, accent, tint) {
    const v = {};
    const a = rgb(accent);
    const t = Math.min(100, Math.max(0, Number(tint) || 0)) / 100 * TINT_MAX;
    for (const k of TINT_KEYS) {
      const p = base && parseColor(base[k]);
      if (!a || !t || !p) { v[k] = null; continue; }
      const m = mix(p.c, a, t);
      v[k] = p.triple ? m.map((x) => Math.round(x)).join(', ') : toHex(m);
    }
    return v;
  }

  /**
   * CSS custom properties for these prefs. Only keys that differ from the
   * stylesheet's own values are returned; null means "remove the override".
   * `surface` is the palette's surface colour (for accent contrast).
   */
  const ACCENT_KEYS = ['--accent', '--accent-hi', '--accent-dim', '--accent-rgb', '--on-accent', '--wave-1'];

  function cssVars(ui, { surface } = {}) {
    const n = normalize(ui);
    const v = {};
    const acc = n.accent ? readableAccent(n.accent, surface) : null;
    if (acc) {
      const c = rgb(acc);
      v['--accent'] = acc;
      v['--accent-hi'] = toHex(mix(c, [255, 255, 255], 0.18));
      v['--accent-dim'] = `rgba(${c.join(', ')}, 0.16)`;
      v['--accent-rgb'] = c.join(', ');
      v['--on-accent'] = onColor(acc);
      v['--wave-1'] = c.join(', ');
    } else {
      for (const k of ACCENT_KEYS) v[k] = null;
    }
    const solid = n.glass.solid;
    v['--glass-blur-k'] = solid ? '0' : String(n.glass.blur / 100);
    v['--glass-sat-k'] = solid ? '1' : String(n.glass.saturation / 100);
    v['--glass-alpha-k'] = solid ? '4' : String(n.glass.opacity / 100); // alpha clamps at 1: solid = opaque
    // the big main panel starts nearly opaque (0.91), so a straight multiplier
    // hardly shows there: below 100% it thins faster
    const o = n.glass.opacity / 100;
    v['--main-alpha-k'] = solid ? '4' : String(+(o < 1 ? o ** 1.6 : o).toFixed(3));
    v['--radius-k'] = String(RADIUS_K[n.radius]);
    // round buttons and chips: square-ish when sharp, round otherwise
    v['--pill-r'] = n.radius === 0 ? '3px' : null;
    v['--tint-k'] = String(n.tint / 100);
    v['--bg-dim'] = String(n.backgroundDim / 100);
    v['--bg-solid'] = n.backgroundColor || null;
    return v;
  }

  /**
   * Page zoom for the Size setting. Every size in the stylesheet is in px, so
   * main zooms the page (webContents) instead of the root font size. Big
   * Picture sets its own zoom and ignores this.
   */
  const RADIUS_K = [0.12, 1, 1.9];
  const zoom = (ui) => normalize(ui).fontScale / 100;

  /** html data-* attributes for these prefs (CSS selects on them). */
  function attrs(ui) {
    const n = normalize(ui);
    return {
      nav: n.nav,
      navSide: n.navSide,
      dockPos: n.dockPos,
      dockStyle: n.dockStyle,
      dockAutoHide: n.dockAutoHide ? '1' : '0',
      search: n.search,
      density: n.density,
      background: n.background,
      cardSize: n.cardSize,
      shelfSize: n.shelfSize,
      motion: n.motion,
      cardTitles: n.showTitles ? '1' : '0',
      cardPlaytime: n.showPlaytime ? '1' : '0',
      cardRatings: n.showRatings ? '1' : '0',
      glassSolid: n.glass.solid ? '1' : '0',
      customAccent: n.accent ? '1' : '0',
    };
  }

  // ------------------------------------------------------------------ presets

  // A preset sets the layout, shape and glass. It keeps what is personal:
  // colours, background, size and motion (the last two are about comfort).
  const KEEP_ON_PRESET = ['accent', 'tint', 'background', 'backgroundFile', 'backgroundKind', 'backgroundColor', 'backgroundDim', 'colorScheme', 'fontScale', 'motion'];
  const PRESETS = Object.freeze([
    { id: 'default', name: 'Default', desc: 'The classic GameVault look', patch: {} },
    { id: 'minimal', name: 'Minimal', desc: 'No navigation bar, search out of the way, solid panels', patch: { nav: 'none', search: 'hidden', glass: { solid: true } } },
    { id: 'dock', name: 'Dock', desc: 'A floating dock along the bottom', patch: { nav: 'dock', dockPos: 'bottom', dockStyle: 'floating' } },
    { id: 'compact', name: 'Compact', desc: 'Tight spacing, small covers, sharp corners', patch: { nav: 'sidebar', density: 'compact', cardSize: 'small', shelfSize: 'small', radius: 0 } },
    { id: 'couch', name: 'Couch', desc: 'Big covers and round corners, easy to read from the sofa', patch: { cardSize: 'large', shelfSize: 'large', radius: 2 } },
    { id: 'glass', name: 'Glass', desc: 'Heavy blur and see-through panels', patch: { radius: 2, glass: { blur: 180, opacity: 45, saturation: 130 } } },
  ]);

  /** These prefs with a preset applied (unknown id = unchanged). */
  function applyPreset(ui, id) {
    const n = normalize(ui);
    const p = PRESETS.find((x) => x.id === id);
    if (!p) return n;
    const out = { ...defaults(), ...clone(p.patch) };
    out.glass = { ...DEFAULTS.glass, ...(p.patch.glass || {}) };
    for (const k of KEEP_ON_PRESET) out[k] = n[k];
    return normalize(out);
  }

  /** The preset these prefs match exactly, or null when they've been tweaked. */
  function presetOf(ui) {
    const n = JSON.stringify(normalize(ui));
    const hit = PRESETS.find((p) => JSON.stringify(applyPreset(ui, p.id)) === n);
    return hit ? hit.id : null;
  }

  // ------------------------------------------------------------------ share a look

  const LOOK_TAG = 'gamevault-look';
  const LOOK_MAX = 8 * 1024;

  /**
   * A look as one short line of JSON to paste anywhere: only what differs
   * from the defaults, and never a file path (a custom picture or video
   * stays on this PC).
   */
  function exportLook(ui, palette) {
    const sync = syncable(ui);
    const base = syncable(DEFAULTS);
    const diff = {};
    for (const k of Object.keys(sync)) {
      if (k === 'v') continue;
      if (JSON.stringify(sync[k]) !== JSON.stringify(base[k])) diff[k] = sync[k];
    }
    const out = { [LOOK_TAG]: VERSION };
    if (typeof palette === 'string' && palette) out.palette = palette;
    out.ui = diff;
    return JSON.stringify(out);
  }

  /**
   * Read a pasted look. Returns { ui, palette } (palette null when missing or
   * not one of `palettes`), keeping this PC's own background file; null when
   * the text isn't a GameVault look.
   */
  function importLook(text, local, palettes) {
    if (typeof text !== 'string' || !text.trim() || text.length > LOOK_MAX) return null;
    let raw;
    try {
      const t = text.trim();
      // chat apps may wrap it in quotes or code fences
      raw = JSON.parse(t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1));
    } catch (_) { return null; }
    if (!raw || typeof raw !== 'object' || !(LOOK_TAG in raw) || !raw.ui || typeof raw.ui !== 'object' || Array.isArray(raw.ui)) return null;
    const mine = normalize(local);
    const ui = normalize({ ...defaults(), ...raw.ui, backgroundFile: mine.backgroundFile, backgroundKind: mine.backgroundKind });
    const list = Array.isArray(palettes) ? palettes : [];
    const palette = typeof raw.palette === 'string' && list.includes(raw.palette) ? raw.palette : null;
    return { ui, palette };
  }

  // ------------------------------------------------------------------ sync

  /**
   * Last write wins between two {prefs, palette, at} records (ms timestamps).
   * Customizations are a handful of choices, so a field-level merge isn't worth it.
   */
  function newer(a, b) {
    const ta = a && Number(a.at) || 0;
    const tb = b && Number(b.at) || 0;
    if (!a || !a.prefs) return b && b.prefs ? b : null;
    if (!b || !b.prefs) return a;
    return tb > ta ? b : a;
  }

  return {
    VERSION, CHOICES, RANGES, DEFAULTS, ACCENTS, TINT_KEYS, ACCENT_KEYS,
    defaults, normalize, syncable, adopt, isDefault, cssVars, attrs, tintVars, zoom,
    PRESETS, applyPreset, presetOf, exportLook, importLook,
    onColor, readableAccent, contrast: (a, b) => contrast(rgb(a), rgb(b)), newer,
  };
}));
