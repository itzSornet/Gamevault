/* Big Picture mode: the pure parts (no DOM, no Electron), so they run under
 * `node --test`. In Node it exports; in the renderer it lands on
 * window.BigPicture; main.js requires it for the zoom factor.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BigPicture = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  // The normal UI is laid out for a window around 1280 x 720. Big Picture
  // zooms the whole page so it always gets about that much room, which makes
  // everything (text, covers, buttons, Settings, popups) TV-sized.
  const BASE_W = 1280;
  const BASE_H = 720;
  const MIN_ZOOM = 1;
  const MAX_ZOOM = 2.5;

  /** Page zoom for a screen of w x h (in DIPs), rounded to 0.05. */
  function zoomFor(w, h) {
    const width = Number(w), height = Number(h);
    if (!(width > 0) || !(height > 0)) return MIN_ZOOM;
    const z = Math.min(width / BASE_W, height / BASE_H);
    const clamped = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
    return Math.round(clamped * 20) / 20;
  }

  // What each Big Picture section shows, in the order LB / RB step through.
  // view/sort are only applied inside Big Picture: they never overwrite the
  // user's normal layout choice.
  const SECTIONS = [
    { id: 'home', label: 'Home', view: 'shelf', filter: 'All', sort: 'lastPlayed' },
    { id: 'library', label: 'Library', view: 'poster', filter: 'All', sort: 'name' },
    { id: 'active', label: 'Active', view: 'poster', filter: 'Active', sort: 'lastPlayed' },
    { id: 'finished', label: 'Finished', view: 'poster', filter: 'Finished', sort: 'lastPlayed' },
    { id: 'wishlist', label: 'Wishlist', view: 'shelf', filter: 'Want', sort: 'lastPlayed' },
    { id: 'activity', label: 'Activity', view: 'shelf', filter: 'Activity', sort: 'lastPlayed' },
    { id: 'settings', label: 'Settings', settings: true },
  ];

  function section(id) {
    return SECTIONS.find((s) => s.id === id) || SECTIONS[0];
  }

  /** The section d steps from `id` (LB = -1, RB = +1), wrapping. Settings is
   * left out: LB / RB switch its own tabs while it's open. */
  function stepSection(id, d) {
    const list = SECTIONS.filter((s) => !s.settings);
    const i = list.findIndex((s) => s.id === id);
    const n = list.length;
    const from = i < 0 ? 0 : i;
    return list[(((from + (d < 0 ? -1 : 1)) % n) + n) % n].id;
  }

  /**
   * What Back (B / Esc) does in Big Picture once nothing else wanted it.
   * ctx: { menuOpen, modalOpen, spotOpen, detail, settings, section }
   * -> 'close-menu' | 'pass' (let the page handle it) | 'home' | 'exit'
   */
  function backAction(ctx = {}) {
    if (ctx.menuOpen) return 'close-menu';
    if (ctx.modalOpen || ctx.spotOpen || ctx.detail || ctx.settings) return 'pass';
    return (ctx.section || 'home') === 'home' ? 'exit' : 'home';
  }

  /** Should Big Picture open at startup? (--bigpicture, or the setting) */
  function startsIn({ flag, config } = {}) {
    return !!flag || !!(config && config.startBigPicture === true);
  }

  return { zoomFor, SECTIONS, section, stepSection, backAction, startsIn, BASE_W, BASE_H };
});
