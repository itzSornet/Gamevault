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
    nav: ['sidebar', 'rail', 'dock', 'top', 'none'],
    navSide: ['left', 'right'],
    dockPos: ['bottom', 'top'],
    dockStyle: ['floating', 'attached'],
    search: ['top-center', 'top-left', 'in-nav', 'floating', 'hidden'],
    density: ['comfortable', 'compact'],
    background: ['fluid', 'art', 'solid', 'image', 'video'],
    cardSize: ['small', 'medium', 'large'],
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
    'glass.opacity': [40, 140],    // % of each surface's own opacity
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
    showTitles: true,
    showPlaytime: true,
    showRatings: true,
    motion: 'full',
    fontScale: 100,
    colorScheme: 'palette',
  });

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
    // a custom background needs its file; without it (another PC, file gone) use fluid
    if ((out.background === 'image' || out.background === 'video') && !out.backgroundFile) out.background = 'fluid';
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

  /**
   * CSS custom properties for these prefs. Only keys that differ from the
   * stylesheet's own values are returned; null means "remove the override".
   * `surface` is the palette's surface colour (for accent contrast).
   */
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
    } else {
      for (const k of ['--accent', '--accent-hi', '--accent-dim', '--accent-rgb', '--on-accent']) v[k] = null;
    }
    const solid = n.glass.solid;
    v['--glass-blur-k'] = solid ? '0' : String(n.glass.blur / 100);
    v['--glass-sat-k'] = solid ? '1' : String(n.glass.saturation / 100);
    v['--glass-alpha-k'] = solid ? '4' : String(n.glass.opacity / 100); // alpha clamps at 1: solid = opaque
    v['--radius-k'] = String([0.35, 1, 1.6][n.radius]);
    v['--font-k'] = String(n.fontScale / 100);
    v['--tint-k'] = String(n.tint / 100);
    v['--bg-dim'] = String(n.backgroundDim / 100);
    v['--bg-solid'] = n.backgroundColor || null;
    return v;
  }

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
      motion: n.motion,
      cardTitles: n.showTitles ? '1' : '0',
      cardPlaytime: n.showPlaytime ? '1' : '0',
      cardRatings: n.showRatings ? '1' : '0',
      glassSolid: n.glass.solid ? '1' : '0',
    };
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

  return { VERSION, CHOICES, RANGES, DEFAULTS, defaults, normalize, syncable, adopt, isDefault, cssVars, attrs, onColor, readableAccent, contrast: (a, b) => contrast(rgb(a), rgb(b)), newer };
}));
