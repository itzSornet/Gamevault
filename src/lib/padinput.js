/* Controller input for GameVault: turns Gamepad API snapshots into app
 * actions, and picks the next element to focus in a direction.
 *
 * UMD-ish like sessions.js: in Node it exports (for tests), in the renderer
 * it lands on window.PadInput. No DOM access in here: the renderer passes
 * plain rectangles in, so all of this runs under `node --test`.
 *
 * Actions: up, down, left, right (d-pad or left stick, with key-repeat),
 * confirm (A / Cross), back (B / Circle), play (X / Square), search (Y /
 * Triangle), prev / next (LB / RB), pageUp / pageDown (LT / RT), view
 * (View / Share), menu (Menu / Options), guide (Xbox / PS button, or View +
 * Menu held together: Windows usually keeps the Xbox button for itself),
 * sidebar (left stick click), top (right stick click).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PadInput = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  // W3C "standard" gamepad layout
  const B = {
    A: 0, B: 1, X: 2, Y: 3, LB: 4, RB: 5, LT: 6, RT: 7,
    VIEW: 8, MENU: 9, LS: 10, RS: 11, UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15, GUIDE: 16,
  };
  const PRESS_BUTTONS = [
    [B.A, 'confirm'], [B.B, 'back'], [B.X, 'play'], [B.Y, 'search'],
    [B.LB, 'prev'], [B.RB, 'next'], [B.LT, 'pageUp'], [B.RT, 'pageDown'], [B.GUIDE, 'guide'],
    [B.LS, 'sidebar'], [B.RS, 'top'],
  ];
  const DIRS = ['up', 'down', 'left', 'right'];

  const STICK_ON = 0.55;   // left stick counts as a direction past this…
  const STICK_OFF = 0.35;  // …and lets go below this (no flicker at the edge)
  const SCROLL_DEAD = 0.22;

  function pressed(pad, i) {
    const b = pad && pad.buttons && pad.buttons[i];
    if (!b) return false;
    return typeof b === 'object' ? (b.pressed || b.value > 0.5) : b > 0.5;
  }
  function axis(pad, i) {
    const v = pad && pad.axes ? Number(pad.axes[i]) : 0;
    return Number.isFinite(v) ? v : 0;
  }

  /** Button icon family from a gamepad id string. */
  function glyphsFor(id) {
    const s = String(id || '').toLowerCase();
    if (/xbox|xinput|045e/.test(s)) return 'xbox';
    // Sony's vendor id, names, or a DS4's bare "Wireless Controller"
    if (/054c|playstation|dualsense|dualshock|ps[345]\b|^wireless controller/.test(s)) return 'ps';
    return 'xbox';
  }

  /** "Xbox Wireless Controller (STANDARD GAMEPAD …)" -> "Xbox Wireless Controller". */
  function padName(id) {
    return String(id || '').replace(/\s*\([^()]*(?:STANDARD GAMEPAD|Vendor:)[^()]*\)\s*$/i, '').trim() || 'Controller';
  }

  /**
   * createReader({ repeatDelay, repeatRate }) -> { poll(pads, now), reset() }
   * poll() returns { actions: string[], scroll: { x, y }, active, glyphs, name }.
   * `active` is true when anything at all was touched this frame.
   */
  function createReader(opts = {}) {
    const repeatDelay = opts.repeatDelay ?? 380;
    const repeatRate = opts.repeatRate ?? 90;
    let held = new Set();        // buttons down last frame
    let stickDir = null;         // direction the left stick is latched in
    let dir = null;              // direction being held (d-pad or stick)
    let dirSince = 0;
    let dirNext = 0;
    let chord = false;           // View + Menu went down together
    let glyphs = 'xbox';
    let name = '';

    function reset() {
      held = new Set();
      stickDir = null;
      dir = null;
      chord = false;
    }

    function poll(pads, now) {
      const out = { actions: [], scroll: { x: 0, y: 0 }, active: false, glyphs, name };
      const list = Array.from(pads || []).filter((p) => p && p.connected !== false);
      if (!list.length) { reset(); return out; }

      // every connected pad counts (two pads, or a pad that reports twice)
      const down = new Set();
      let lx = 0, ly = 0, rx = 0, ry = 0;
      for (const p of list) {
        const n = (p.buttons && p.buttons.length) || 0;
        for (let i = 0; i < n; i++) if (pressed(p, i)) down.add(i);
        const ax = [axis(p, 0), axis(p, 1), axis(p, 2), axis(p, 3)];
        if (Math.abs(ax[0]) > Math.abs(lx)) lx = ax[0];
        if (Math.abs(ax[1]) > Math.abs(ly)) ly = ax[1];
        if (Math.abs(ax[2]) > Math.abs(rx)) rx = ax[2];
        if (Math.abs(ax[3]) > Math.abs(ry)) ry = ax[3];
      }
      const touched = down.size > 0 || Math.max(Math.abs(lx), Math.abs(ly), Math.abs(rx), Math.abs(ry)) > SCROLL_DEAD;
      if (touched) {
        const p = list.find((x) => x.buttons && [...x.buttons].some((b, i) => pressed(x, i))) || list[0];
        glyphs = glyphsFor(p.id);
        name = padName(p.id);
        out.glyphs = glyphs;
        out.name = name;
      }
      out.active = touched;

      const edge = (i) => down.has(i) && !held.has(i);

      for (const [i, action] of PRESS_BUTTONS) if (edge(i)) out.actions.push(action);

      // View + Menu together = guide. Alone, each fires when it's let go, so
      // the chord never also fires "view" or "menu".
      const viewDown = down.has(B.VIEW), menuDown = down.has(B.MENU);
      if (viewDown && menuDown && !chord) { chord = true; out.actions.push('guide'); }
      if (!viewDown && !menuDown) {
        if (!chord) {
          if (held.has(B.VIEW)) out.actions.push('view');
          if (held.has(B.MENU)) out.actions.push('menu');
        }
        chord = false;
      }

      // left stick: latch the dominant axis with hysteresis
      const mag = Math.max(Math.abs(lx), Math.abs(ly));
      if (stickDir && mag < STICK_OFF) stickDir = null;
      if (!stickDir && mag > STICK_ON) {
        stickDir = Math.abs(lx) > Math.abs(ly) ? (lx > 0 ? 'right' : 'left') : (ly > 0 ? 'down' : 'up');
      }
      const pad = down.has(B.UP) ? 'up' : down.has(B.DOWN) ? 'down' : down.has(B.LEFT) ? 'left' : down.has(B.RIGHT) ? 'right' : null;
      const want = pad || stickDir;
      if (want !== dir) {
        dir = want;
        if (dir) { out.actions.push(dir); dirSince = now; dirNext = now + repeatDelay; }
      } else if (dir && now >= dirNext) {
        out.actions.push(dir);
        // speed up a little the longer it's held
        const held2 = now - dirSince;
        dirNext = now + (held2 > 1500 ? Math.round(repeatRate * 0.6) : repeatRate);
      }

      // right stick scrolls (squared for fine control near the centre)
      const curve = (v) => (Math.abs(v) < SCROLL_DEAD ? 0 : Math.sign(v) * ((Math.abs(v) - SCROLL_DEAD) / (1 - SCROLL_DEAD)) ** 2);
      out.scroll = { x: curve(rx), y: curve(ry) };

      held = down;
      return out;
    }

    return { poll, reset };
  }

  /**
   * Spatial navigation: from rect `from`, the best of `cands` ({ rect, ... })
   * in direction `dir`. Rects are { left, top, width, height }. Returns the
   * winning candidate or null.
   *
   * Only candidates whose centre lies beyond `from`'s centre in that
   * direction count. Score = distance along the direction (edge to edge)
   * plus, weighted, how far off to the side it is; anything that overlaps
   * `from` sideways (same row / same column) wins over things that don't.
   */
  function pickNext(from, cands, dir) {
    if (!from || !DIRS.includes(dir)) return null;
    const f = box(from);
    let best = null;
    let bestScore = Infinity;
    for (const c of cands || []) {
      const r = box(c.rect);
      if (!r.w && !r.h) continue;
      let along, side, overlap;
      if (dir === 'right' || dir === 'left') {
        const ahead = dir === 'right' ? r.cx > f.cx + 1 && r.right > f.right - 1 : r.cx < f.cx - 1 && r.left < f.left + 1;
        if (!ahead) continue;
        along = dir === 'right' ? Math.max(0, r.left - f.right) : Math.max(0, f.left - r.right);
        overlap = Math.min(f.bottom, r.bottom) - Math.max(f.top, r.top);
        side = overlap > 0 ? 0 : Math.abs(r.cy - f.cy);
      } else {
        const ahead = dir === 'down' ? r.cy > f.cy + 1 && r.bottom > f.bottom - 1 : r.cy < f.cy - 1 && r.top < f.top + 1;
        if (!ahead) continue;
        along = dir === 'down' ? Math.max(0, r.top - f.bottom) : Math.max(0, f.top - r.bottom);
        overlap = Math.min(f.right, r.right) - Math.max(f.left, r.left);
        side = overlap > 0 ? 0 : Math.abs(r.cx - f.cx);
      }
      // same row/column: prefer the one whose centre lines up best
      const align = overlap > 0 ? Math.abs((dir === 'left' || dir === 'right') ? r.cy - f.cy : r.cx - f.cx) * 0.25 : 0;
      const score = along + side * 2.5 + align + (overlap > 0 ? 0 : 400);
      if (score < bestScore) { bestScore = score; best = c; }
    }
    return best;
  }

  function box(r) {
    const left = Number(r.left) || 0, top = Number(r.top) || 0;
    const w = Number(r.width) || 0, h = Number(r.height) || 0;
    return { left, top, w, h, right: left + w, bottom: top + h, cx: left + w / 2, cy: top + h / 2 };
  }

  return { createReader, pickNext, glyphsFor, padName, BUTTONS: B };
});
