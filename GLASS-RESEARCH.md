# Glass — three research rounds

Goal: keep the “wow” material without the frame cost that made 2.0 feel laggy. Three rounds, then one synthesis.

## Round 1 — Apple HIG / Liquid Glass

Sources: [Apple HIG Materials](https://developer.apple.com/design/human-interface-guidelines/materials), WWDC25 “Meet Liquid Glass”, HIG motion notes.

- Glass belongs to the **control layer** only: bars, sidebars, sheets, capsules. Never cards/lists/media.
- Two variants: **regular** (adaptive, legible) and **clear** (rich media behind, add a 35 % dimming layer).
- **Concentric radii** and capsule controls; tint only the primary action.
- Bars may shrink/hide on scroll; content scrolls **under** them with an edge blur.
- Accessibility: reduce-transparency → solid; reduce-motion → cross-fade.

Takeaway: our current layout is structurally correct. The failure was *live* blur over large moving areas.

## Round 2 — Motion & cost (Emil Kowalski, Apple fluid interfaces)

- Under 300 ms; 180 ms reads faster than 400 ms.
- Springs for interactive elements; no overshoot without momentum.
- Animate transform/opacity only; never box-shadow, never layout.
- Blur is the most expensive visual effect on the compositor; keep areas small and static.

Takeaway: glass surfaces should be **few, small, static**; the art grid stays opaque.

## Round 3 — Web techniques (the interesting one)

Source: [Liquid Glass in the browser: refraction with CSS and SVG](https://kube.io/blog/liquid-glass-css-svg/).

- Real refraction is possible with an **SVG displacement map** used as `backdrop-filter: url(#filter)`.
- Pipeline: compute a displacement vector field for a rounded-rect bezel (Snell’s law), encode it into R/G channels, feed `feImage` → `feDisplacementMap`, composite a **specular rim** on top.
- **Chromium-only** — which means it works in Electron, not in Firefox/Safari/Flutter.
- Cost: the map depends on element size; resizing rebuilds it. Only `scale` is cheap to animate.
- `feTurbulence`-based noise is a cheap way to add frost texture without another blur layer.

Takeaway: refraction is a *feature surface*, not a global material — use it on one hero card or the command palette, not every panel.

## Synthesis — three materials

| Material | Recipe | Use |
|---|---|---|
| **Frost** | `blur(26px) saturate(160%)` + 50 % tint + 1 px inner highlight | default bars, sidebar |
| **Smoke** | `blur(10px)` + 74 % tint + stronger border | modals, dense text panels |
| **Specular** | Frost + conic rim light (gradient border via mask-composite) | floating cards, palette |
| **Lens** | SVG displacement + specular rim | one showcase surface (hero card, palette) only |

## Lab

`glass-lab/` is a standalone app (nothing shared with 2.0) to judge all of this:

```bash
./node_modules/.bin/electron glass-lab
```

- Switch Frost / Smoke / Specular live.
- The “Lens” card is real SVG-displacement refraction over a photo.
- FPS/ms HUD + **Stress ×300** button (300 tiles) to prove scrolling/layout stays cheap.
- Glass is limited to sidebar, top bar, cue card, palette — content is opaque.

## Verdict

- Keep **Frost** for the shell, **Specular** for floating surfaces.
- Offer **Lens** as an accent (Chrome-only; skip on Flutter unless we write a fragment shader).
- Never blur a full-height sidebar over scrolling content; bake or use tint.

## Round 3.5 — aura + interactive glass

- **Aura**: three large radial light fields, drifting on `transform` only (44 s / 58 s / 70 s, alternate), no blur filter, low opacity. They sit behind the glass so the material picks up their color slowly; `prefers-reduced-motion` freezes them.
- **Interactive glass** (Apple’s `.interactive()` idea):
  - a **specular sheen** tracks the pointer via `--mx/--my` inside the glass surface (screen blend, 180 px falloff);
  - small panels **tilt** ±3° toward the cursor (`perspective(900px)`), transform-only;
  - press compresses to `scale(.994)`;
  - a `?hover=1` flag lets screenshots capture the state deterministically.
- All of it is pointer-driven, so it works with mouse and pen; touch skips the tilt.

## Glass colour rules (search spotlight)

1. **Three layers, never a flat rgba**: ambient colour bleed (accent blue / violet radial), a dark blue-graphite base (`linear-gradient(150deg, …)`), then a top rim highlight.
2. **Saturation 160–180 %**, blur 26–30 px. Lower saturation reads grey/cheap; higher starts to glow.
3. **Tint from the app palette, not random**: blue `#4C7DFF`, violet `#6B3BFF`, both at 10–16 % over the base.
4. **One bright edge**: `inset 0 1px 0 rgba(255,255,255,.20)` plus a 1 px white-16 border. No full outlines.
5. **Coloured outer glow** at ~10 % (`0 0 60px rgba(76,125,255,.10)`) so it sits in the ambient light.
6. Text contrast comes from the dark base, not from more blur — rows stay opaque, shell stays glass.
