# Search spotlight — plan

**Goal:** the search field is one object that *becomes* the command palette, anchored under itself. No floating panel that appears “somewhere near the middle”. The animation should feel like a spotlight opening from the pill, with glass materializing under it.

Research base: [Apple HIG materials](https://developer.apple.com/design/human-interface-guidelines/materials), [Motion command-palette example](https://motion.dev/examples/react-command-palette), [Raycast design notes](https://designbycurio.com/learn/raycast-2024), plus the earlier Liquid Glass / Emil notes already in `GLASS-RESEARCH.md`.

---

## 1. Current state (what's wrong)

- Palette is `position: fixed; left: 50%` → centered on the **viewport**, while the search pill is centered on the **main column** (offset by the sidebar). At 1900 px they were ~140 px apart; at 1200 px ~70 px.
- Palette top was `clamp(96px, 17vh, 190px)` — unrelated to the pill's bottom.
- The opening animation is a generic “bubble” (translate + rotate + wobble) with no relationship to the trigger besides the starting rect.

**Fixed already in `169497a`/current tree:** palette gets `--cmd-x` = pill center and `--cmd-y` = pill bottom + 10 px from `openCmd()`. Palette width 640, responsive `min(640px, 100vw - 48px)`. Verified: palette center == search center, top sits directly under the bar.

---

## 2. Geometry contract

```
searchPill = dock.getBoundingClientRect()
palette.left  = searchPill.left + searchPill.width/2   (center)
palette.top   = searchPill.bottom + 10
palette.width = min(640, viewportWidth - 48)
```

- Recompute on `resize` **while open** (and after sidebar collapse, which changes main width).
- The palette is horizontally centered on the pill, not the viewport, at every width.
- At `< 900px` the pill becomes a flex item; anchor to its rect the same way, palette width `min(640, 100vw - 32)`.

---

## 3. Motion timeline

| Phase | Time | What moves | Easing |
|---|---|---|---|
| 0. Press | 0–80 ms | pill scales to 0.985, border brightens | `ease-out` |
| 1. Lift | 80–160 ms | palette scrim fades in; pill shadow appears | `cubic-bezier(.32,.72,0,1)` |
| 2. Expand | 80–420 ms | **surface** grows from pill rect → palette rect; radius 999 → 22 px | spring, ~0.55 ζ |
| 3. Beam | 140–520 ms | spotlight cone `scaleY(.2→1)`, opacity `.0→.55` | `cubic-bezier(.22,1,.36,1)` |
| 4. Content | 300–520 ms | bar/list/footer fade + rise 8 px; rows stagger 18 ms | spring |
| 5. Settle | 420–500 ms | surface scale 1.008 → 1 | `ease-out` |
| Close | 0–240 ms | reverse 2–4, content first (0–100 ms) | mirror easing |
| Focus return | at close end | input gets focus, caret at end | — |

Reduced motion: scrim 120 ms opacity, surface appears at final size, no beam, no stagger.
Tier `lite` / `data-software`: no beam, no backdrop blur on the surface; opacity-only.

**Interruptible:** if reopened mid-close, reverse from the current transform (CSS/WAAPI transitions, not keyframes).

---

## 4. Surface construction

The surface must be **one opaque-ish glass layer**, not rows of glass:

```html
<div id="cmd" class="cmd">
  <div class="cmd-beam" aria-hidden="true"></div>   <!-- spotlight cone -->
  <div class="cmd-bg"></div>                        <!-- the material -->
  <div class="cmd-bar">…input…</div>
  <div class="cmd-list">…</div>
  <div class="cmd-foot">…</div>
</div>
```

- `.cmd-bg`: `background: var(--glass-bg-strong)`, `backdrop-filter: blur(24px) saturate(160%)`, `border: 1px solid rgba(255,255,255,.12)`, inner highlight, `border-radius: 22px`.
- `.cmd-beam`: `position:absolute; left:50%; top:-80px; width:140%; height:220px; transform:translateX(-50%) scaleY(.2); transform-origin: top center; background: radial-gradient(50% 60% at 50% 0%, rgba(120,160,255,.28), transparent 70%); filter: blur(18px); mix-blend-mode: screen; pointer-events:none;`
- Scrim: separate `#cmd-scrim` fixed inset 0, `rgba(4,5,9,.45)`, fades 200 ms.
- **Never** put glass on `.cmd-list` rows or covers; rows are opaque-ish hover fills.

---

## 5. Animation implementation

`openCmd()`:

1. Measure `d = dock.getBoundingClientRect()`, compute `--cmd-x/--cmd-y`, unhide root, set final layout, measure `t = root.getBoundingClientRect()`.
2. Animate **only `.cmd-bg`** from the pill rect to `t` using `transform: translate(x,y) scale(sx,sy)` + `borderRadius` (WAAPI, 420 ms, spring). Content starts invisible.
3. At 300 ms: add `.is-full` (content visible), focus input, start row stagger.
4. Beam animates scaleY/opacity in parallel.
5. Cancel any running `cmd.anim`; on reopen mid-close, start from `getComputedStyle(bg).transform`.

`closeCmd()`: content out 100 ms → surface shrink to pill 240 ms → hide, restore focus to `#dock-input` (not the wrapper), clear `is-closing`.

The old bubble keyframes (rotate/wobble) are removed.

---

## 6. Centering & resize

- `--cmd-x/--cmd-y` set on open.
- `window.addEventListener('resize', () => { if (cmd.open) positionCmd(); })` where `positionCmd()` recomputes both vars from the dock.
- Sidebar toggle calls `positionCmd()` after the class swap.
- Acceptance: `|cmdCenter - dockCenter| ≤ 1px` at 900, 1200, 1600, 1900; `cmdTop == dockBottom + 10 ± 1`.

---

## 7. Keyboard / a11y

- `Ctrl K` focuses the pill; `Enter`/click opens; input autofocus after expand.
- `Esc` closes palette, returns focus to `#dock-input`, not the wrapper.
- `↑/↓ Home End Enter` as today; `aria-activedescendant` preserved.
- Scrim click closes; outside pointerdown closes (also under reduced motion).
- `role=dialog aria-modal=true` + `aria-labelledby` on the search input label.

---

## 8. Performance budget

- Only `transform`, `opacity`, `backdrop-filter` (surface only), `border-radius`.
- No `width/height/top/left` animation; no box-shadow animation.
- Rows use `content-visibility: auto` if >30 results.
- Beam is one gradient layer; hidden in lite/software and reduced motion.
- Target: open ≤ 500 ms, no frame > 24 ms during expansion at 1200×760 on the iGPU.

---

## 9. Test plan

1. Screenshot at 900/1200/1900: palette center vs pill center, top gap.
2. Open from keyboard and from click; close with Esc, scrim, outside click.
3. Rapid open/close ×5: no ghosting, no `pointer-events:none` state, focus correct.
4. Reduced motion: no beam, content cross-fade.
5. `data-tier=lite`: no blur/beam, still expands.
6. Resize while open; collapse sidebar while open.
7. Regression: open palette while a modal is open must be blocked.

---

## 10. Rollout

1. Land geometry + centering (done in tree).
2. Replace bubble with surface expand + beam behind a `?spotlight=1` dev flag for one round of screenshots.
3. Compare against current; keep whichever reads better.
4. Remove flag, delete old keyframes, update `MOTION.md`.

## Implementation update

Implemented: palette is left-aligned to the search pill (`x = pill.left`, `y = pill.bottom + 10`), the glass surface expands from that rect with `transform-origin: 0 0`, a spotlight cone fades in behind it, and the search pill itself is now a glass capsule (blur 18px, saturate 160%, inner highlight). Rows and footer stay opaque.
