# Motion — 2.0

Derived from Apple's *Designing Fluid Interfaces* (WWDC 2018) via the distilled [apple-design motion notes](https://github.com/naplesblue/apple-design-skill/blob/main/motion.md), Material 3 [easing & duration tokens](https://m3.material.io/styles/motion/easing-and-duration/tokens-specs), and Apple HIG [Motion](https://developer.apple.com/design/human-interface-guidelines/motion) / Liquid Glass material behavior.

## Principles we committed to

1. **Response on pointer-down**, not release. Every pressable surface scales to 0.97 within 100 ms.
2. **Spring-like curves, not durations.** Enter `420 ms` `cubic-bezier(.32,.72,0,1)`; exit `280 ms` on the same path.
3. **No overshoot without momentum.** Bounce is reserved for drag release, never for a menu that merely faded in.
4. **Materialize glass** — blur, scale and opacity travel together, so a sheet reads as a material arriving, not a rectangle fading.
5. **Interruptible** — transitions (not keyframes) on transform/opacity, so re-triggering reverses from the current value.
6. **Same path in and out**, origin anchored to the trigger.
7. **Only transform / opacity / (material) blur** — no layout animation.
8. **Three accessibility dials**: reduced motion (cross-fade, no travel), reduced transparency (solid glass), more contrast (stronger borders).

## Tokens

| Token | Value |
|---|---|
| `--ease-spring` | `cubic-bezier(0.32, 0.72, 0, 1)` |
| `--ease-out-quart` | `cubic-bezier(0.25, 1, 0.5, 1)` |
| `--dur-enter` | `420ms` |
| `--dur-exit` | `280ms` |
| Press | `scale(0.97)`, `100ms` |
| Card hover | `translateY(-3px) scale(1.012)`, `340ms` |

## What animates

| Surface | Motion |
|---|---|
| Sidebar navigation | one **FLIP pill** slides between items, `340ms` spring; no per-item background flicker |
| Glass sheets (modals) | materialize: `blur(0→36px)` + `scale(.97→1)` + `translateY(18→0)`, 420 ms in / 280 ms out |
| Sheet dismiss | **drag from header**: 1:1 tracking, scale/opacity follow the finger, release commits at `>120 px` or `>0.9 px/ms`, otherwise springs back |
| Command panel | materializes from the dock, content fades at 110 ms |
| Cards | press on pointer-down, spring hover lift, shadow deepens |
| Top bar | gains tint + shadow after 4 px of scroll (`is-scrolled`) |
| Toasts | rise 10 px + scale 0.97 → 1 on arrival |
| Filter changes | content cross-fades via `fadeIn` (no whole-page View Transition — it stalls in headless/offscreen windows) |

## Deliberately not done

- No whole-window View Transitions: `document.startViewTransition` stalls when the window is offscreen (our headless captures), and a hung transition blocks the shot. Revisit only with a visibility guard.
- No entrance keyframes on async lists — re-render can freeze them at opacity 0.
- No parallax on covers: art is the content; moving it fights reading.

## Self-check (gate)

- [x] Press feedback on pointer-down
- [x] Enter/exit same path, anchored origins
- [x] Spring curves everywhere, no `linear`/default `ease`
- [x] Glass materializes (blur + scale + opacity)
- [x] Input never locked; transitions are interruptible
- [x] Reduced motion / transparency / contrast handled

## Round 2 (flicker + more surfaces)

- **Filter changes no longer fade the whole shelf.** `fadeIn()` on every filter was the hero flash. It is now only used for view switches.
- **Hero crossfade only when the artwork actually changes.** `renderShelfStage()` keys on `art|poster`; switching filters with the same current game updates text only, so nothing re-decodes or re-crossfades.
- **Search moved to a real footer bar** — no more capsule sitting on top of covers.
- **Detail page entrance**: content rises 14 px + fades over 420 ms once per game.
- **Import review**: rows stagger in at 18 ms intervals (first paint only, never on checkbox changes).
