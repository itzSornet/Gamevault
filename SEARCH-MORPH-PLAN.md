# Search morph + pop — animation plan

**Invariant: one search surface exists at any moment.** Opening the spotlight hides the pill; closing lands the spotlight on the pill and only then reveals it. Never two.

## States
| state | pill | panel |
|---|---|---|
| closed | visible | hidden |
| pressing | scale .985 | hidden |
| opening | opacity → 0 (110 ms) | grows from pill rect |
| open | opacity 0, pointer-events none | full |
| closing | hidden | shrinks to pill rect |
| landed | fades in 120 ms | hidden |

`.is-morphing` on `#search-dock` is added in `openCmd()` and removed only in `closeCmd()`'s finish.

## Geometry
- Panel centred on the library section (x and y), width `min(640, 100vw - 48)`.
- Morph = `translate(dx,dy) scale(sx,sy)` on `.cmd-bg`, `transform-origin: top center`.
- Radius 999 → 18 px, completing at ~65 % of the expand.

## Open (460 ms)
| ms | event |
|---|---|
| 0 | press scale .985; pill fades 110 ms; surface starts at pill rect |
| 120 | input focused (panel), caret end |
| 200 | bar fades/rises 6 px |
| 250 | rows stagger 18 ms |
| 330 | footer fades |
| 380 | overshoot 1.018 |
| 460 | settle 1.0, radius 18 |

Easing `cubic-bezier(.32,.72,0,1)`; spring equivalent k=300, c=26.

## Close (260 ms)
| ms | event |
|---|---|
| 0 | content fades 90 ms; surface shrinks |
| 200 | surface lands on pill rect; root hidden |
| 200 | `is-morphing` removed; pill fades in .985→1 |
| 320 | focus returns to pill input |

Esc during opening reverses from current transform.

## Pop
Single overshoot: .985 → 1.018 → 1. Content rises 6 px, opacity 0→1. No wobble, no rotation, no blur pulse.
Tune: damping 22 for more life, 30 for less.

## Keyboard
Ctrl K and Ctrl F open (`preventDefault`). Esc closes to pill. ↑/↓/Home/End/Enter drive the list. Typing goes to the panel input only. Outside click closes and is swallowed.

## Edge cases
Reopen mid-close cancels and grows from current transform. Resize/sidebar collapse re-anchor without restarting. Modal open blocks. Empty query keeps min-height 320. Long lists scroll at 60 vh, footer pinned.

## Perf
Only transform/opacity/border-radius; will-change while morphing; no layout animation.

## Acceptance
- [ ] Open: exactly one surface; pill not visible beside panel.
- [ ] Close: lands on pill, then pill appears.
- [ ] Esc mid-open reverses.
- [ ] Centered at 900/1200/1600/1900.
- [ ] Focus/typing contract holds.
- [ ] Reduced motion + lite tiers.

## Critic rounds (3)

| round | score /9.9 | verdict | applied |
|---|---|---|---|
| timing | 6.2 | nothing responds until the animation ends | focus at t=0, content at 140 ms, open 420 / close 260, old snapshot 160, Esc <380 ms skips VT |
| morph truth | 6.4 | 13:1 box = vertical smear, then UI reveal | pill↔bar share `gv-search`; shell grows via `gv-search-body` clip-path from bar bottom |
| correctness | 7.6 | focus ownership + ARIA | `aria-expanded`/`aria-controls`, dialog role, seq token gates the focus restore |
