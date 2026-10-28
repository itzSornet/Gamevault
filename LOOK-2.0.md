# GameVault 2.0 — The Look

**Thesis:** a piece of hardware on a dark desk, not a website. Quiet, dense, deliberate. The library is the hero; chrome disappears until you reach for it.

---

## 1. Tokens

| Token | Midnight | Paper |
|---|---|---|
| `--bg` | `#08090C` | `#F4F2ED` |
| `--surface` | `#0F1117` | `#FFFFFF` |
| `--surface-2` | `#161923` | `#EDEAE3` |
| `--surface-3` | `#1D2130` | `#E3DFD5` |
| `--line` | `#222633` | `#DDD8CD` |
| `--line-2` | `#2E3444` | `#C9C2B4` |
| `--text` | `#F2F4F8` | `#14161A` |
| `--text-dim` | `#A6AEC0` | `#5A5F6A` |
| `--text-mute` | `#6E7789` | `#8A8578` |
| `--accent` | `#4C7DFF` | `#B0431F` (vermilion) |

- **Type:** Space Grotesk for display (titles, hours, numbers), system UI for body. Display sizes: 34 / 22 / 16; body 13; micro 10.5 with 0.08–0.2 em tracking.
- **Radii:** 10 (cards/posters), 8 (buttons/inputs), 6 (chips), 999 (pills).
- **Spacing:** 4 / 8 / 12 / 16 / 24 / 40. Section rhythm 40 px, row rhythm 44 px.
- **Motion:** 140 ms enter, 200 ms modal, 240 ms stage crossfade, ease `cubic-bezier(.2,.7,.3,1)`. Opacity + transform only.

## 2. Surface rules

1. **Opaque, always.** No `backdrop-filter`, no blur glass. Depth comes from value steps, not transparency.
2. **One accent.** Blue (or vermilion) marks the primary action and live state. Everything else is grey.
3. **Hairlines, not boxes.** Dividers are 1 px `--line`; avoid double borders.
4. **Art bleeds.** Covers and heroes go edge-to-edge in their frame; no inner padding, no rounded thumbnail inside a rounded card.
5. **Text never floats on busy art** without a scrim (`linear-gradient` from `--bg` at 85 %).

## 3. Screens (what 2.0 looks like at release)

### 3.1 Home — shelf
A full-bleed hero on the left (game art, kicker `PLAYING · 20.9H`, title 34 px, meta line, Play / Details / refresh), poster on the right (176×264, floating, 10 px radius, soft shadow), horizontal cover rail beneath. Top bar: logo glyph, filter tabs (All / Playing / Finished with counts), Wishlist pill, sort, add. Bottom: search field with `Ctrl K`.

### 3.2 Grid
Dense 3:4 cards, cover edge-to-edge, status chip top-left (`PLAYING`, `FINISHED`), hours bottom-left in micro type, name below in 12.5 px. Hover: 1.02 lift, 240 ms. No shadows in the grid — separation by 12 px gutters.

### 3.3 Detail — Marquee
Full-bleed hero at 42 % height with a bottom scrim, poster floating left, title + meta + actions, then a single rail: Play / Details / Mark finished · sessions list · Steam cards. One scroll surface, no tabs, no notes. Status is a chip, not a section. Layout pinned to a 1120 px content column that never breaks from 900→1600 px.

### 3.4 Import — options
Modal 760 px. `IMPORT FROM [Select launcher ⌄] launcher` as an inline chip that opens an animated menu (steam, Lutris, Heroic, Bottles, itch, Hydra, This PC). `CONNECT [Steam account] SteamID …` with a one-line hint. `SCAN [Scan a folder…] Whole PC`. Footer: `Nothing selected` · Cancel · Continue (disabled until valid). No numbers, no dividers, no inline game lists.

### 3.5 Import — review
Header `‹ Back  Steam account`, list rows with checkbox, 44 px cover thumb, name, source + hours, `Update art` where the game already exists. Footer: `18 new · 18 selected` · Cancel · `Import 18 games`. Scroll inside the list only.

### 3.6 Command panel (Ctrl K)
Centered 640 px panel, 12 px radius, 1 px `--line-2`, single input, grouped results (Games / Actions), footer hints `↑↓ navigate · ↵ open · esc close`. Opens in < 80 ms, no spinner.

### 3.7 Settings
Sections as rows, not cards: Palette (midnight/paper), Visual quality (cinematic/standard/lite), SteamGridDB key, Refresh artwork, Steam account, On login, Updates. Labels 10.5 px uppercase, values right-aligned.

### 3.8 Empty / first run
Centered `Your vault is empty`, one paragraph, two actions (Import games / Add manually), one hint (`Ctrl K`). Same background as the shelf — no illustration, no mascot.

### 3.9 Error states
Inline, not modal: one line of text + one action (`Retry`, `Change executable`). Launch failure never leaves a dead "Launching…" button.

## 4. Motion spec

| Moment | What moves | Duration | Easing |
|---|---|---|---|
| Shelf → game change | crossfade hero + poster, title swaps | 240 ms | ease-out |
| Card hover | translateY(-2px) + shade | 180 ms | ease-out |
| Modal in/out | opacity + translateY(8→0) | 200 ms | standard |
| Picker menu | opacity + 4 px rise, anchored to chip | 160 ms | standard |
| Status change | chip color + 120 ms flash of accent | 120 ms | linear |
| Toast | slide 8 px + fade | 160 ms | standard |
| Command panel | scale .98→1 + fade | 140 ms | standard |

Reduced motion: all of the above collapse to opacity-only, 0 ms transform.

## 5. Copy voice

- Lowercase labels, sentence case titles. No exclamation marks.
- Verbs for actions: `Import games`, `Scan a folder…`, `Mark finished`.
- Numbers are honest: `18 new · 18 selected`, `0 sessions`, `—` when unknown.
- Never explain the obvious in the UI; put guidance in hints, one line max.

## 6. Release assets

### Screenshots (1600×1000, Midnight + one Paper)
1. Home shelf with a real library (43 titles).
2. Grid with mixed statuses.
3. Detail — Marquee (a game with sessions).
4. Import options (inline picker open).
5. Import review with 18 selected.
6. Command panel open.

### Trailer beats (30 s)
1. 0–4 s: empty vault, cursor hovers Import.
2. 4–10 s: three options; pick Steam; review list fills.
3. 10–16 s: Import → shelf fills, covers cascade (stagger 40 ms).
4. 16–22 s: Play → session timer ticks; wrapper quits, timer keeps going (caption: *it follows the game, not the launcher*).
5. 22–27 s: detail marquee scroll; mark finished; chip flips.
6. 27–30 s: logo + `No key. No cloud. No noise.` + download line.

### Store copy
**Short:** Your games, from every launcher, in one quiet library — with playtime that actually follows the game.
**Bullets:** imports Steam/Epic/GOG/Xbox/Hydra/Lutris/Heroic/itch and local installs · wrapper-aware tracking · works offline · two themes · Windows + Linux.

## 7. Visual do / don't

| Do | Don't |
|---|---|
| Opaque surfaces, hairline dividers | Glassmorphism, blurred panels |
| One accent, grey everything else | Rainbow status colors |
| Art edge-to-edge | Art inside padded cards |
| 10 px radii, 1 px borders | 20 px pill cards everywhere |
| Micro labels with tracking | ALL CAPS body text |
| Empty states with one action | Mascots, illustrations, confetti |
