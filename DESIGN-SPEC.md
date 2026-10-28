# GameVault 2.0 — Hero, Motion, Rail, Chrome

Target: Electron 29 (Chromium 122), 1200×760 min, Wayland + Windows, weak iGPUs.
Grounded in the current `src/` tree and `screenshots/home.png` (1200×760).

---

## 0. Diagnosis first (from the actual render)

Three facts that explain every complaint:

1. **`filter: blur(18px)` is doing the opposite of what it was added for.** The hero
   reads as a black band with one yellow smear. `blur(18) saturate(1.2) brightness(.78)`
   plus two stacked scrims (`0.3→0.85` vertical, `0.66→0` horizontal) collapses the
   cover to ~8% luminance. All that survives is the poster's yellow bloom at the right
   edge, which looks like a render bug. Cost: an 1136×316 layer re-blurred whenever the
   selection changes — 30–60 ms hitch on Intel/Wayland.
2. **The arrows are dead code.** `#strip-prev` / `#strip-next` exist in `index.html`
   (lines 76–83) but appear **nowhere** in `app.js`. No `wheel` handler, no pointer-drag
   handler either (`shelfDragMoved` is read at line 224 but never set). The rail only
   moves if the user has a horizontal trackpad gesture.
3. **`revealShelfTile()` re-centers on every click, even when the tile is already fully
   visible** (`app.js:270–276`). That is the "teleport": the whole rail lurches up to
   ~400 px for a poster the user can already see, with a fixed 300 ms `easeOutCubic`
   that ignores distance and cannot be cancelled.

Fix order: (3) is 6 lines and removes the complaint; (2) is a feature that's simply
missing; (1) is the visual redesign.

---

## 1. Hero treatment

**Principle:** premium apps do not blur the art. They *crop* it, *grade* it, and derive
**colour** from it; the sharp poster carries the image. Blur is reserved for a small
masked halo, never a 1200 px slab.

- Steam: darkened crop of the header art + left-to-right scrim, 0 blur.
- Apple Music / Apple TV+: colour wash sampled from artwork behind content, 0 blur.
- Plex: "colour bleed" from the poster into a gradient, 0 blur.
- Netflix: crop + 3-stop scrim, 0 blur.
- Spotify: no backdrop at all — flat surface, colour only in the header gradient.

### Technique A — Crop + grade + directional scrim (blur: 0)

Scaled crop (`1.06`, not `1.35`), desaturated and darkened, then a scrim that lands on
the rail colour so the hero melts into the shelf instead of ending on a hard border.

```css
.shelf-hero { position: relative; flex: 0 0 300px; height: 300px; overflow: hidden; background: var(--bg-2); }

.shelf-art {
  position: absolute; inset: 0;
  background-size: cover;
  background-position: 50% 22%;          /* keeps the “face” of the key art */
  transform: scale(1.06);
  filter: saturate(.92) brightness(.72) contrast(1.06);   /* NO blur */
  opacity: .85;
}

/* scrim: left anchor for text, bottom melt into the rail, top vignette */
.shelf-shade {
  position: absolute; inset: 0;
  background:
    linear-gradient(90deg,  var(--bg) 0%, color-mix(in oklab, var(--bg) 74%, transparent) 34%, transparent 70%),
    linear-gradient(0deg,   var(--bg-2) 0%, color-mix(in oklab, var(--bg-2) 55%, transparent) 20%, transparent 56%),
    linear-gradient(180deg, rgba(0,0,0,.38) 0%, transparent 28%);
}
```

Use when `heroUrl` exists and is ≥ 1280 px wide (SteamGridDB heroes usually are).

### Technique B — Colour mesh from the cover (blur: 0) ← **recommended default**

Sample a 10×14 downscale of the cover, drop greys/blacks, bucket by hue, take the top
three weighted colours, paint three radial gradients, add 2% grain. The room takes on
the game's colour without smearing a single pixel. This is the Apple Music / Plex move
and it is *cheaper* than blur — one 10×14 `drawImage` + `getImageData` per game, cached.

```js
function coverPalette(url) {           // cache by url in a Map
  return new Promise((res) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas'); c.width = 10; c.height = 14;
      const g = c.getContext('2d', { willReadFrequently: true });
      g.drawImage(img, 0, 0, 10, 14);
      const d = g.getImageData(0, 0, 10, 14).data;
      const bins = Array.from({ length: 12 }, () => ({ w: 0, r: 0, g: 0, b: 0 }));
      for (let i = 0; i < d.length; i += 4) {
        const r = d[i], gg = d[i + 1], b = d[i + 2];
        const mx = Math.max(r, gg, b), mn = Math.min(r, gg, b);
        const l = (mx + mn) / 510, s = mx === mn ? 0 : (mx - mn) / mx;
        if (l < .10 || l > .92 || s < .10) continue;        // drop black/white/grey
        let h = 0;
        if (mx !== mn) {
          if (mx === r) h = ((gg - b) / (mx - mn) + 6) % 6;
          else if (mx === gg) h = (b - r) / (mx - mn) + 2;
          else h = (r - gg) / (mx - mn) + 4;
          h *= 60;
        }
        const bin = bins[Math.floor(h / 30) % 12];
        const w = s * (1 - Math.abs(l - .45));              // favour mid-lightness
        bin.w += w; bin.r += r * w; bin.g += gg * w; bin.b += b * w;
      }
      bins.sort((a, b) => b.w - a.w);
      res(bins.slice(0, 3).filter(b => b.w > 0.01)
        .map(b => `rgb(${(b.r / b.w) | 0} ${(b.g / b.w) | 0} ${(b.b / b.w) | 0})`));
    };
    img.onerror = () => res([]);
    img.src = url;
  });
}
```

```css
.shelf-mesh {
  position: absolute; inset: 0;
  background:
    radial-gradient(120% 85% at 22% 6%,  color-mix(in oklab, var(--c1) 70%, transparent), transparent 62%),
    radial-gradient(90%  75% at 80% 0%,  color-mix(in oklab, var(--c2) 46%, transparent), transparent 58%),
    radial-gradient(120% 130% at 50% 130%, color-mix(in oklab, var(--c3) 34%, transparent), transparent 74%),
    var(--bg-2);
}
```

Set `--c1/--c2/--c3` inline on `.shelf-hero`. Fall back to
`color-mix(in oklab, var(--accent) 40%, var(--bg-2))` when extraction returns nothing.
Clamping lightness happens in CSS via the mix ratios (70/46/34) — no JS colour maths.

### Technique C — Masked low-res bloom behind the poster (real blur 7 px, visual ≈ 28 px)

Only on `[data-tier="cinematic"]`. Render the bloom from a 46×62 `<img>` scaled 4×:
the GPU blurs a 46×62 bitmap, not a 1200 px layer. Visual result is a 28 px halo at ~1/600
the fill cost.

```html
<img class="shelf-bloom" src="cover.jpg" width="46" height="62" alt="" aria-hidden="true">
```
```css
.shelf-bloom {
  position: absolute; right: 24px; top: 50%;
  width: 46px; height: 62px; object-fit: cover;
  border-radius: 8px;
  transform: translateY(-50%) scale(4);
  filter: blur(7px) saturate(1.35);
  opacity: .5;
  -webkit-mask-image: radial-gradient(closest-side, #000 25%, transparent 75%);
  pointer-events: none;
}
```

### Technique D — Duotone lock (blur: 0) — the "art director" option

Grayscale structure under the colour mesh. Every cover, including ugly ones, ends up in
the same tonal world. Best for the light `paper` palette.

```css
.shelf-art.duotone {
  filter: grayscale(1) contrast(1.12) brightness(.9);
  mix-blend-mode: luminosity;   /* hue comes from .shelf-mesh underneath */
  opacity: .62;
}
```

### Composition (independent of technique)

| Element | Now | Change |
|---|---|---|
| Hero height | `flex: 0 0 42%` (~316) | `300px` fixed (min 264, max 340) |
| Poster | 132×184, right 36 | **176×240**, right 40, `radius 12`, `shadow 0 24px 48px -12px rgba(0,0,0,.7)` + `inset 0 0 0 1px rgba(255,255,255,.08)` |
| Content | left 32 / bottom 20 / gap 7 | left 32 / **bottom 28** / right 248 / max-width 560 / gap 8 |
| Kicker | 9.5 px, `.2em` | **10 px**, `.14em`, `--text-dim` |
| Title | clamp(24, 2.6vw, 36) | **34 px / 38 / -.022em / 600** (clamp 28–34 below 1200) |
| Meta | source · sessions | source · hours · last played · status pill; **drop zero values** (`0h`, `0 sessions` is noise) |
| Bottom edge | 1 px hard border at 370 | scrim to `--bg-2`; no border |

Poster + content share one optical baseline: poster centre at hero centre, content block
bottom-aligned to `poster.bottom - 4`.

**Do not** put the backdrop inside the scrolling page (no parallax). It must stay
`position: absolute` in a non-scrolling stage or the compositor re-blurs on every frame.

---

## 2. Selection transition — kill the teleport

### What is wrong now

- `revealShelfTile` always centres, even when the tile is on screen in full.
- `smoothScrollBy` uses a **fixed 300 ms** `easeOutCubic`: a 40 px nudge and a 900 px
  jump take the same time, so small moves feel laggy and big moves feel violent.
- The title text is swapped **synchronously** in `renderShelfStage` while the art
  crossfades over 420 ms — words arrive before the picture, which is the perceptual
  "jump cut".
- No cancellation: a wheel tick or a second click fights the running rAF.

### Manual `scrollLeft` vs `scroll-behavior: smooth`

**Manual, always.** `scroll-behavior: smooth`:
- has a UA-defined duration (~300–500 ms) that ignores distance;
- ignores your easing curve; you cannot use expo-out or a spring;
- retargeting mid-flight (second click) restarts the curve from the current position
  with a visible velocity discontinuity;
- behaves differently between Chromium-on-Wayland and Windows;
- cannot be cancelled when the user grabs the wheel.

Set `html, body { scroll-behavior: auto; }` and drive the rail yourself.

### The rule that actually fixes "it teleports"

If the clicked tile is already inside the comfort band, **do not scroll at all.**

```js
function revealTile(strip, tile) {
  const viewL = strip.scrollLeft;
  const viewR = viewL + strip.clientWidth;
  const pad = 32;                                   // rail side padding
  const left = tile.offsetLeft;
  const right = left + tile.offsetWidth;

  if (left >= viewL + pad && right <= viewR - pad) return;   // visible → no movement

  const target = left < viewL + pad
    ? left - pad - 8
    : right - strip.clientWidth + pad + 8;

  scroller.to(target);
}
```

Consequence: clicking a visible poster moves **only the hero**, never the rail. That
single change reads as "smooth" even before any easing is tuned.

### Spring, not duration

Critically damped. Interruptible, retargetable, no duration to get wrong.

```js
function makeScroller(el) {
  let raf = 0, x = el.scrollLeft, v = 0, target = x, last = 0;
  const max = () => Math.max(0, el.scrollWidth - el.clientWidth);

  function tick(t) {
    const dt = Math.min(32, t - last) / 1000; last = t;   // clamp after tab-away
    const k = 220, c = 30;                                 // ωn=14.8, ζ≈1.01, settle ≈290ms
    const a = -k * (x - target) - c * v;
    v += a * dt;
    x += v * dt;
    if (Math.abs(v) < 0.5 && Math.abs(x - target) < 0.5) {
      x = target; v = 0; el.scrollLeft = x; raf = 0; return;
    }
    el.scrollLeft = x;
    raf = requestAnimationFrame(tick);
  }
  return {
    to(px) {
      target = Math.max(0, Math.min(max(), px));
      if (Math.abs(target - x) < 1) return;
      if (!raf) { last = performance.now(); raf = requestAnimationFrame(tick); }
    },
    stop() { if (raf) cancelAnimationFrame(raf); raf = 0; v = 0; x = el.scrollLeft; },
  };
}
```

`k=220, c=30` → reaches 63% in 68 ms, 95% in ~200 ms, settles ~290 ms. Snappy, no bounce.

If you must keep a time-based tween, use
`dur = clamp(180, 240 + |Δpx| * 0.30, 560) ms` with `cubic-bezier(.22,1,.36,1)` (expo-out)
— but the spring is better because a second click retargets instead of restarting.

### Choreography (one clock, five tracks)

| Track | Property | Duration | Delay | Curve |
|---|---|---|---|---|
| Rail scroll | `scrollLeft` (rAF) | spring ≈ 290 ms | 0 | spring 220/30 |
| Backdrop mesh | `opacity` (2 layers) | **320 ms** | 0 | `cubic-bezier(.4,0,.2,1)` |
| Poster | `opacity` + `transform: scale(.985→1)` | **220 ms** | 0 | `cubic-bezier(.22,1,.36,1)` |
| Old text out | `opacity 1→0`, `translateY(0→-4px)` | **110 ms** | 0 | `ease-in` |
| New text in | `opacity 0→1`, `translateY(6px→0)` | **220 ms** | 120 ms | `cubic-bezier(.22,1,.36,1)` |
| Active ring | `opacity` of inset ring | **160 ms** | 0 | `ease-out` |

Total perceived: **~360 ms**. Backdrop is the slowest because it is the largest area and
the "mood"; text is the fastest because it is read.

```css
.shelf-art.layer, .shelf-poster.layer, .shelf-mesh.layer {
  opacity: 0;
  transition: opacity 320ms cubic-bezier(.4,0,.2,1);
}
.shelf-poster.layer { transition-duration: 220ms; transition-timing-function: cubic-bezier(.22,1,.36,1); }
.shelf-art.layer.is-on, .shelf-poster.layer.is-on, .shelf-mesh.layer.is-on { opacity: 1; }

.shelf-content[data-anim] { transition: opacity 110ms ease-in, transform 110ms ease-in; }
.shelf-content.is-out[data-anim] { opacity: 0; transform: translateY(-4px); }
.shelf-content.is-in[data-anim]  { transition: opacity 220ms cubic-bezier(.22,1,.36,1) 120ms,
                                               transform 220ms cubic-bezier(.22,1,.36,1) 120ms; }
```

```js
function selectShelfGame(id) {
  if (String(id) === state.shelfId) return;
  state.shelfId = String(id);
  const g = state.games.find(x => String(x.id) === id);

  // 1. ring + rail on the same frame
  syncActiveTile();
  revealTile(strip, tileFor(id));            // no-ops when already visible

  // 2. text: out, then in
  const c = stage.querySelector('.shelf-content');
  c.classList.add('is-out');
  setTimeout(() => {
    fillText(c, g);                          // textContent only, no innerHTML
    c.classList.remove('is-out');
    c.classList.add('is-in');
  }, 110);

  // 3. picture layers (two, crossfaded)
  renderShelfStage(g);
}
```

Rules that keep it from ever "animating layout": only `opacity`, `transform`, and
`scrollLeft` are touched. Nothing animates `width`, `height`, `top`, `left`, `margin`,
`padding`, or `filter`. Add `overflow-anchor: none` to `.shelf-strip` so Chromium's
scroll anchoring cannot fight the rAF writes.

`prefers-reduced-motion: reduce` → skip the spring (`el.scrollLeft = target`), keep a
single 120 ms opacity fade, no translate.

Optional (cinematic tier only): FLIP the poster from the clicked tile's rect into the
hero poster over 380 ms `cubic-bezier(.22,1,.36,1)`. Only do this when the tile is
within 600 px of the poster, otherwise the travel looks absurd.

---

## 3. Rail scrolling

### The physics of "feels good"

- **No snap.** `scroll-snap-type` fights trackpad inertia and classic-wheel paging.
  Spotify, Steam, Netflix, Playnite, GOG all use free scroll. Snap only in the sense of
  settling to a tile when the movement was *programmatic* (arrow / keyboard), via the
  spring — never via CSS.
- **Native momentum is already good** in Chromium. Do not re-implement wheel inertia;
  you will make it worse. Re-implement only *drag* inertia.
- **Wheel mapping:** vertical wheel over a horizontal rail must scroll horizontally, 1:1,
  with no smoothing layer.

```js
strip.addEventListener('wheel', (e) => {
  const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;   // lines → px
  const d  = Math.abs(dy) > Math.abs(e.deltaX) ? dy : e.deltaX;
  if (!d) return;
  e.preventDefault();
  scroller.stop();                     // user input always wins
  strip.scrollLeft += d * 1.0;
}, { passive: false });
```

For a classic notched wheel (`e.deltaMode === 0 && Math.abs(e.deltaY) >= 100 &&
Math.abs(e.deltaX) < 1 && e.deltaY % 100 === 0`) feel free to `scroller.to(scrollLeft + d * 2)`
with the spring — one notch = one tile-ish.

- **Drag:** pointer events + `setPointerCapture`; `scrollLeft = start - dx`; velocity from
  the last 5 samples; on release decay `v *= 0.94` per frame until `|v| < 0.2 px/ms`;
  cap at `2.4 px/ms`. Suppress the click when `|dx| > 6`. `cursor: grab/grabbing`.

### Arrows that work

- 40×40 circle, `radius: 999px`, `background: color-mix(in oklab, var(--surface-2) 92%, transparent)`,
  `1px solid var(--line-2)`, icon 16 px `stroke-width: 1.8`.
- inset `12px` from each rail edge, `top: calc(50% - 12px)` (poster centre, not rail centre),
  `transform: translateY(-50%)`.
- Hidden at rest (`opacity: 0`, `scale(.96)`, `pointer-events: none`), shown on
  `.shelf-rail:hover` and `:focus-within`, **160 ms** ease.
- At the ends fade to 0 (160 ms) and disable pointer events — do not just set `disabled`.
- Page step: `clientWidth - 172 - 24` so exactly one tile of context carries over.

```css
.strip-nav {
  position: absolute; top: calc(50% - 12px); width: 40px; height: 40px;
  transform: translateY(-50%) scale(.96);
  display: grid; place-items: center;
  border-radius: 999px; border: 1px solid var(--line-2);
  background: color-mix(in oklab, var(--surface-2) 92%, transparent);
  box-shadow: 0 8px 20px rgba(0,0,0,.45);
  color: var(--text-dim); opacity: 0; pointer-events: none;
  transition: opacity 160ms ease, transform 160ms cubic-bezier(.2,0,0,1), color 120ms;
}
.shelf-rail:hover .strip-nav, .strip-nav:focus-visible { opacity: 1; transform: translateY(-50%); pointer-events: auto; }
.strip-nav.is-off { opacity: 0 !important; pointer-events: none; }
.strip-nav.prev { left: 12px; }  .strip-nav.next { right: 12px; }
```

### Edge fades (cheaper than `mask-image` on the strip)

```css
.shelf-rail::before, .shelf-rail::after {
  content: ''; position: absolute; top: 0; bottom: 0; width: 56px; z-index: 3;
  pointer-events: none; opacity: 0; transition: opacity 160ms;
}
.shelf-rail::before { left: 0;  background: linear-gradient(90deg,  var(--bg-2), transparent); }
.shelf-rail::after  { right: 0; background: linear-gradient(270deg, var(--bg-2), transparent); }
.shelf-rail.can-left::before, .shelf-rail.can-right::after { opacity: 1; }
```
Toggle `can-left`/`can-right` from the scroll handler (rAF-throttled) and on resize.

### 1000 items

- `content-visibility: auto; contain-intrinsic-size: 172px 262px;` on `.shelf-tile` —
  off-screen tiles skip style/layout/paint entirely.
- `contain: layout paint style` on the tile; no `box-shadow` on tiles at rest (1000
  shadows = paint cost); active ring is an **inset** box-shadow on the `<img>`.
- Images: `loading="lazy" decoding="async" fetchpriority="low"`; hero cover
  `fetchpriority="high"`. Never `will-change` on 1000 nodes.
- Kill per-tile transitions while scrolling:
  `.shelf-strip.is-scrolling .shelf-tile img { transition: none; }` (add on `scroll`,
  remove on `scrollend`, which Chromium 122 supports).
- Build tiles once, then toggle `.is-active`; never `innerHTML` the strip on filter
  unless the list actually changed (the current `_shelfKey` guard is right — keep it).
- `overscroll-behavior-x: contain` so a horizontal fling can't trigger window gestures.

### Keyboard

`←/→` = ±1 selection (no wrap — a wrap on 1000 items *is* a teleport), `Home/End`,
`PageUp/PageDown`, `Enter` = details, `Space` = play. Roving `tabindex` on the strip.
Autoscroll only when the target leaves the band `[25%, 75%]` of the rail, then spring it
to `left - 32`.

### Geometry at 1200

`1200 - 2×32 = 1136` usable; pitch `172 + 20 = 192` → **5 full tiles + 0.9 peek**. That
peek is the affordance; keep it. Do not pad the rail so wide that 6 tiles fit exactly.

---

## 4. Top bar → filter row

### What is wrong now

One 54 px row holds: brand square, 4 tab pills, a 270 px bordered search field, an 80 px
bordered `<select>`, 3 bordered 32 px icon buttons, a saturated 80 px Add button. Nine
outlined boxes, three saturated fills, one row. No entry point for the eye; it reads as a
toolbar.

### Two rows, two jobs

**Row 1 — app bar, 56 px.** Global, never scrolls away: identity + search + actions.
**Row 2 — filter bar, 48 px.** View state: status, facets, sort, layout.

| | Row 1 (56) | Row 2 (48) |
|---|---|---|
| Left | brand 26×26 + wordmark 13/600 | segmented status: All 20 · Playing 6 · Finished 14 · Wishlist 9 |
| Middle | — | facet chips: Genre · Platform · Source · Playtime (`+` overflow) |
| Right | search 300×32 · divider · 3 icon buttons 30×30 · **Add game** (filled) | ghost `Filters 2` · ghost `Recent ⌄` · layout toggle |

Heights: `56 + 48 = 104`; at 760 that leaves 656 for hero (300) + rail (356).

**Search belongs in row 1, right-aligned, immediately left of the global actions.**
Reasons: the query is global state — it persists across every filter and every status; it
is not a facet of the current view. This is exactly Spotify (search in the top bar, filter
pills above the grid), Steam (search in the library header, filters in a sub-row), Linear
(⌘K in the top bar, filters in the view toolbar), Vercel (search top-right, project tabs
below). Centring search is a marketing-site pattern; at 1200 it also pushes the actions
into the right edge and creates two dead zones.

```html
<header class="appbar">
  <a class="brand">…</a><span class="wordmark">GameVault</span>
  <div class="appbar-right">
    <label class="search"><svg/><input placeholder="Search 1,024 games"><kbd>/</kbd></label>
    <span class="vrule"></span>
    <button class="icon-btn">import</button><button class="icon-btn">layout</button><button class="icon-btn">settings</button>
    <button class="btn btn-primary">+ Add game</button>
  </div>
</header>

<div class="filterbar">
  <div class="seg" role="tablist">…counts…</div>
  <span class="vrule"></span>
  <div class="chips" role="group">…facets…</div>
  <div class="filterbar-right">
    <button class="ghost">Filters <b>2</b></button>
    <button class="ghost">Recent <svg/></button>
    <button class="icon-btn sm">grid</button>
  </div>
</div>
```

```css
.appbar   { height:56px; padding:0 20px; display:flex; align-items:center; gap:16px; border-bottom:1px solid var(--line); }
.filterbar{ height:48px; padding:0 20px; display:flex; align-items:center; gap:10px; border-bottom:1px solid var(--line); background:var(--bg-2); }
.appbar-right, .filterbar-right { margin-left:auto; display:flex; align-items:center; gap:6px; }
.vrule    { width:1px; height:20px; background:var(--line); margin:0 8px; flex:none; }

.search   { display:flex; align-items:center; gap:8px; width:300px; height:32px; padding:0 10px;
            border-radius:8px; background:var(--surface); border:1px solid var(--line); }
.search:focus-within { border-color:var(--line-2); box-shadow:0 0 0 3px var(--accent-dim); }
.search input { flex:1; min-width:0; font-size:12.5px; background:none; border:0; outline:0; color:var(--text); }
.search kbd { font-size:10px; padding:1px 5px; border-radius:4px; border:1px solid var(--line); color:var(--text-mute); }

.icon-btn { width:30px; height:30px; border-radius:7px; border:0; background:transparent; color:var(--text-dim); }
.icon-btn:hover { background:var(--surface-2); color:var(--text); }
.btn-primary { height:32px; padding:0 12px; border-radius:8px; font-size:12.5px; font-weight:500; }

.seg      { display:flex; align-items:center; gap:2px; height:28px; padding:2px; border-radius:8px; background:var(--surface); }
.seg button{ height:24px; padding:0 10px; border-radius:6px; font-size:12.5px; font-weight:500; color:var(--text-dim); background:none; border:0; }
.seg button.is-active { background:var(--surface-2); color:var(--text); box-shadow:inset 0 0 0 1px var(--line); }
.seg b    { font-size:10px; font-weight:600; font-variant-numeric:tabular-nums; color:var(--text-mute); margin-left:5px; }

.chips    { display:flex; gap:6px; overflow-x:auto; scrollbar-width:none; }
.chips::-webkit-scrollbar { display:none; }
.chip     { height:26px; padding:0 10px; border-radius:999px; font-size:11.5px; font-weight:500;
            color:var(--text-dim); background:transparent; border:1px solid var(--line); white-space:nowrap; }
.chip.is-active { color:var(--accent); background:var(--accent-dim); border-color:transparent; }

.ghost    { height:28px; padding:0 8px; border-radius:6px; border:0; background:none;
            font-size:12px; font-weight:500; color:var(--text-dim); display:flex; align-items:center; gap:6px; }
.ghost:hover, .ghost.is-open { background:var(--surface-2); color:var(--text); }
```

Notes that matter:
- **Only one filled accent in the chrome** (Add game). Play in the hero is the only other.
  Right now brand, Add, active tab badge and the active tile ring are all accent — four
  focal points.
- Sort is a **ghost** control with a chevron, not a bordered `<select>`. Keep the native
  `<select>` for a11y but render it with `appearance: none`, no border, 28 px.
- Counts are 10 px tabular, not 9.5 px boxed badges at every tab.
- `⌘/Ctrl K` already opens the palette — so the search hint should be `/`, not `Ctrl K`.
  `/` focuses the inline field; `Esc` clears and blurs.
- Both rows are `position: sticky; top: 0` **only if** the page scrolls; the stage is
  fixed at 760 so skip sticky — sticky + `backdrop-filter` is the Wayland trap. No
  translucency anywhere in the chrome.

---

## 5. Typography + spacing, 1200×760

Inter for everything; Space Grotesk 600 **only** for the hero title. Base 13 px, not 14 —
a desktop app at 1200 reads denser and more native at 13.

| Role | px / line | Tracking | Weight | Color |
|---|---|---|---|---|
| Hero title | **34 / 38** (clamp 28–34) | −0.022em | 600 | `--text` |
| Empty-state title | 22 / 28 | −0.015em | 600 | `--text` |
| Section title | 15 / 20 | −0.01em | 600 | `--text` |
| Body | 13 / 19 | 0 | 400 | `--text-dim` |
| Meta / secondary | 12.5 / 17 | 0 | 400 | `--text-dim` |
| Tile label | **12 / 16** | 0 | 500 | `--text-dim` (active → `--text`) |
| Button label | 12.5 / 16 | 0 | 500 | — |
| Tab label | 12.5 / 16 | 0 | 500 | `--text-dim` |
| Eyebrow / kicker | **10 / 13** | 0.14em, uppercase | 600 | `--text-dim` |
| Count badge | 10 / 12 | 0.01em, tabular | 600 | `--text-mute` |
| Chip | 11.5 / 15 | 0 | 500 | `--text-dim` |

**Nothing readable below 11 px.** The current 9.5 px kicker and 9.5 px counts are
illegible on a 96 dpi laptop at 1200 wide. 10 px only for uppercase eyebrows with
expanded tracking (where cap-height carries it).

**Spacing** — 4 px base; allowed values `2 4 6 8 12 16 20 24 32 40 48 56 64`.

| Context | Value |
|---|---|
| App bar / filter bar horizontal | 20 |
| Content gutter (hero, rail) | 32 |
| Rail gap | 20 |
| Grid gap | 16 |
| Button group gap | 8 |
| Chip gap | 6 |
| Kicker → title | 6 |
| Title → meta | 8 |
| Meta → actions | 16 |
| Hero content bottom | 28 |
| Rail vertical padding | `(356 − 260) / 2 = 48` |

**Radii** — 5 steps, no more:

| Radius | Use |
|---|---|
| 4 | kbd, count badge |
| 6 | sort/filter buttons, small chips |
| 8 | buttons, search, segmented control |
| 12 | poster, tile, card, popover |
| 16 | modal, command palette |
| 999 | icon buttons, filter chips |

**Borders / rings:** 1 px `--line`; hover `--line-2`; active tile =
`box-shadow: inset 0 0 0 1.5px var(--accent), 0 0 0 1px rgba(0,0,0,.4)`. No 2 px outer
ring — it thickens the silhouette and looks like a focus outline.

**Shadows:** two levels only.
`--shadow-1: 0 2px 8px rgba(0,0,0,.35)` (popovers, dropdowns)
`--shadow-2: 0 24px 48px -12px rgba(0,0,0,.65)` (poster, modal).
Tiles get **no** shadow at rest.

**Numerals:** `font-variant-numeric: tabular-nums` on every count, hour, and date so the
rail labels don't shimmer as values update.

---

## 6. Three things most likely to look amateur

### 1. The hero is a black band with a colour leak

`blur(18) + brightness(.78) + two scrims` destroys the artwork, and the only surviving
colour is a yellow smear escaping from behind the poster at x≈900–1120 — it reads as a
z-fighting bug, not a design. There is also ~140 px of dead space above a 9.5 px kicker,
so the top third of the app is empty black.

**Fix:** Technique B (mesh) + optional A (crop). Hero fixed at 300 px, content
bottom-aligned to the poster's baseline, kicker 10 px, title 34 px, real metadata
(source, hours, last played) instead of `Custom · 0 sessions`. Scrim ends on `--bg-2` so
hero and rail merge with no border.

### 2. Nine boxes at the same visual weight in a 54 px row

Tab pills, search, select, three icon buttons, Add, brand square — every control has a
1 px border or a fill, so nothing is primary. The accent is used four times (brand, Add,
active tab count, active tile ring), which flattens the hierarchy further.

**Fix:** the two-row split above; ghost controls for sort/filters/icon buttons (border
only on hover/focus); one filled accent in the chrome; counts as text, not badges. The
eye should land on: hero title → poster → rail → Add. Nothing else.

### 3. Three different motion languages, and one of them is broken

- Arrows are **not wired at all** (`#strip-prev`/`#strip-next` never referenced in
  `app.js`) — the one affordance that says "this scrolls" does nothing.
- Clicking a visible tile still re-centers the rail, so the entire shelf lurches for no
  reason; the 300 ms `easeOutCubic` is identical for 40 px and 900 px.
- The hero text hard-swaps instantly while the art crossfades at 420 ms.
- Tiles lift 4 px on a 150 ms ease, the active ring pops with a 2 px accent outline, the
  sort `<select>` opens with the OS-native menu. Four unrelated timings.

**Fix:** one spring (220/30), one crossfade clock (320/220/110+120), one ring (1.5 px
inset, 160 ms), no scroll when the tile is visible, arrows + wheel + drag wired. Native
`<select>` popups should be replaced by a custom menu using `--shadow-1`, 6 px radius,
8 px item height padding — the OS dropdown is the single most "Electron demo" artefact
in a premium app.

**Honourable mentions:** the rail's first tile starts at x=36 while the hero text starts
at x=32 (4 px misalignment); the last tile is clipped with a 20 px sliver but no fade;
the arrow glyph sits at x=14 *outside* the rail padding, overlapping the tile edge; the
active tile's blue 2 px ring is the same blue as the Play button, so "selected" and
"action" share a colour.

---

## 7. Order of work

1. **Wire the arrows** (`#strip-prev/#strip-next` → `scroller.to(±page)`), add wheel +
   drag, add `can-left/can-right` classes. ~40 min, kills complaint 2.
2. **`revealTile` early-return when visible** + spring. ~20 min, kills complaint 3.
3. **Hero:** delete `blur(18px)`; add mesh layer + `coverPalette()`; 300 px height;
   176×240 poster; type bump. Kills complaint 1.
4. **Two-row chrome.** Kills complaints 4 and 5.
5. **Type/radius/shadow pass** — the 9.5 px text, the 2 px rings, the four accent uses.
6. **Optional:** poster FLIP (cinematic tier), duotone mode, bloom.

## 8. Do-not list

- No `filter: blur()` on any element larger than 300×300.
- No `backdrop-filter` anywhere (Wayland compositor cost, and it invites translucency).
- No `scroll-behavior: smooth`.
- No `scroll-snap-type` on the 1000-item rail.
- No animating `width/height/top/left/margin/padding/filter`.
- No parallax on the hero.
- No `will-change` on lists.
- No 2 px outlines; no drop shadows on 1000 tiles.
- No text below 11 px (10 px uppercase eyebrow only).
- No more than one saturated accent fill per row.
