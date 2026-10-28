# GameVault 2.0 — experimental

A ground-up **renderer** for GameVault, living beside the shipping app. Nothing here
touches the 1.x codebase: this folder has its own shell, its own app id and its own
data directory.

```
~/Projects-Windows/gamevault design experimental   ← this app
~/Projects-Windows/game vault                      ← shipping 1.3.x (untouched)
```

## Run

```bash
npm start
```

The experimental app uses its own data directory, seeded from the 1.x library, so
you see your real games without sharing state with the shipping build.

## What is different

**Import, three ways.** ① *From a launcher* — choose Steam, Hydra, Lutris,
Heroic, Bottles, itch (plus Epic/GOG/Xbox/Battle.net/EA/Ubisoft on Windows) and
read that launcher's installed games. ② *Connect an account* — Steam Web API
key with the SteamID auto-detected from `loginusers.vdf`, for the owned library.
③ *Scan the disk* — a folder now, whole-PC once the deep scanner lands. Lutris is read straight from `pga.db`, so names,
slugs and playtime come through. A review step marks anything already in your
library, and imported games get SGDB cover, hero and logo before they land.

**Two-row header.** Top row: brand, search, layout, import, settings, Add.
Second row: status filters with live counts + sort. No sidebar.

**Motion.** One spring drives the rail (`k=220 c=30`, settles ~290 ms); the stage
crossfades 420 ms; a tile already inside the comfort band does not move the rail
at all. No `scroll-behavior: smooth`, no snap, no animated layout properties. The rail scrolls with the
wheel, click-drag, `← →`, or the ‹ › buttons, all through one rAF loop.

**No sidebar.** Navigation is a tab row in the top bar —
`All · Playing · Finished · Wishlist` with live counts — plus search, sort,
layout, import, settings and Add.

**Hero + game rail.** A fixed 300 px stage: the cover cropped and graded (zero
blur), a sharp 176×240 poster, 34/38 title, Play — melting into the rail below. Below it, a
large horizontal rail of posters with wheel scrolling, click-drag panning,
`‹ ›` buttons and arrow-key selection. The rail is the main surface; there is
no scrollbar to drag.

**New design language.** Opaque warm-graphite surfaces, hairline borders, one
accent colour, Space Grotesk for display type and Inter for text. No
glassmorphism, no blur, no gradient chrome — the poster art carries the colour.

**Three palettes**, switchable live in Settings:

| Palette | Canvas | Accent | Character |
|---|---|---|---|
| **Midnight** (default) | near-black `#08090C` | electric blue `#4C7DFF` | crisp, modern |
| **Paper** | warm white `#F3F0E9` | vermilion `#E4572E` | light, editorial |

**Shelf layout (default).** The library is a console-style stage: the selected
game's artwork fills the frame with its title, playtime and Play button, and a
horizontal filmstrip of covers runs underneath. Arrow keys move the selection,
clicks load the stage instantly, and `View` switches between shelf, poster grid
and compact grid.

**Game detail — "Marquee".** Full-bleed stage with the logo, a live Play/Stop
with a session timer, a single **Mark as finished** action (Playing is set automatically when a session starts),
a month-grouped session ledger a plain month-grouped session list, and a right rail with play stats, Metacritic/Steam requirements and your rating (time-to-beat is a manual field). Wishlist is its own
scope (`wishlisted`), not a status. There is no "Unplayed" state: a game is
Playing until you mark it Finished. `Dropped` and legacy unplayed entries are
migrated to Playing on first launch.

**Two rooms, no drawer.** The library is one page; a game is another. Clicking a
poster replaces the page: breadcrumb toolbar, 16:9 artwork with notes beneath,
and a right column with title, status, playtime, Play and sessions. `Back`,
`Esc` and `Backspace` return to the exact poster with focus restored. Nothing
slides over content and no scrim steals context.

**Command palette.** `Ctrl/Cmd + K` jumps to any game or runs an action.
`/` focuses search, `Esc` closes whatever is open.

**Three layouts.** Poster / compact / list, persisted between sessions.

**Performance is a feature, not a cleanup task.** See below.

## Performance model

| Rule | Why |
|---|---|
| Cards are built **once** and reused | Filtering and searching only toggles `hidden` and re-appends nodes — no `innerHTML` rebuild, no image re-decode |
| Text updates touch a handful of nodes | Tracking ticks every 3 s must not re-render the grid |
| Search is debounced 120 ms | Previously one full rebuild per keystroke |
| No animated layout properties | Nothing animates `width`/`height`/`margin`; only `transform` and `opacity` |
| One ambient layer | A single WebGL quad replaces many `backdrop-filter` rules and an animated 100 px blur |
| `contain: layout paint` on cards | Isolates each card from grid layout |
| Tiers + governor | See below |

### Quality tiers

| Tier | What runs |
|---|---|
| `cinematic` | Card lift, artwork scale, full motion |
| `standard` (default) | CSS motion only |
| `lite` | Flat colours, no shadows, no animation |

Switch in **Settings → Visual quality**. A governor samples real frame pacing for
~2 s after launch and drops a tier automatically if the median frame exceeds 21 ms.

Every surface is opaque, so the compositor never has to blend content over
content — the cheapest possible baseline on a weak GPU.


## Adding a game (one title bar)

The Title field *is* the search. Type a few characters and it lists matching
games in your library plus SteamGridDB hits with their release year. Pick one
and cover, banner, logo and icon are fetched, ranked (official first, then
score/upvotes, correct aspect per kind), downloaded and filled in — four
previews appear under "Artwork" with an "Auto-filled from SteamGridDB" note.

`Change artwork` expands the full picker: tabs for Cover / Banner / Logo / Icon,
style filters (Official, Alternate, White logo, Material), a "Wrong game?"
switcher, and paginated results. Manual URLs live under a collapsed section.

All artwork is cached locally (`artcache`/`artworks_cache`), so the shelf never
re-downloads images at render time.

## SteamGridDB

Settings → SteamGridDB: paste an API key, **Test**, and **Refresh all artwork**
(re-runs the whole library). NSFW, humor and epilepsy-flagged assets are always
filtered out; a blurred cover wash is used when a game has no banner at all.

The client (`src/backend/sgdb.js`) handles auth, 10s timeouts, 429/5xx retries,
a 5-minute response cache and request de-duplication.

## Fuzzy search

Both the library and Ctrl+K use `src/lib/fuzzy.js`: diacritic folding, token
matching, abbreviations (`rdr2` → Red Dead Redemption 2), and one- or two-
character typos. Results are ranked, not just filtered.

## Tests

```bash
npm test        # fuzzy scoring + artwork ranking (13 tests)
```

## Keyboard

| Key | Action |
|---|---|
| `Ctrl/Cmd + K` | Command palette |
| `/` | Focus search |
| `Esc` | Close palette → modal → detail |
| `Enter` / `↑` `↓` | Palette navigation |

## Dev flags

```bash
# Capture the UI to a PNG without showing a window
npm start -- --shot /tmp/shot.png --wait 4000

# Capture an inner state: detail | settings | import | add | palette
npm start -- --shot /tmp/detail.png --shot-state detail
```

`--shot` creates the window hidden, loads the page, optionally opens a state and
writes a PNG. Useful for design review and for CI screenshots later.

## Architecture

```
main.js               shell: windows, tray, IPC, overlay, single instance
preload.js            contextBridge API (same surface as 1.x)
src/index.html        shell markup
src/style.css         design system + tiers
src/app.js            renderer: state, incremental grid, panels, shader
src/backend/          ported from 1.3.x (data, scanner, tracker, platform, api, updater)
src/overlay.html      in-game overlay (unchanged from 1.x)
```

The backend is **the 1.3.x backend verbatim** — including the `/proc` tracking
rewrite, bounded directory walkers, Wine/Proton runners and the smart-scan fix.
That part took the longest to get right and is covered by tests in the main repo;
this folder inherits it rather than reimplementing it.

## Known gaps

- **Artwork is not resized.** Covers are still up to 4K; a proper pipeline
  (downscale + WebP) is the next big win, especially on low-end machines.
- **Overlay is the 1.x one.** It works, but it is not restyled for 2.0.
- **No updater UI.** The renderer never calls the updater; `electron-updater` is
  still initialised in the shell, unused.
- **No SGDB search** in the add-game modal yet — paste a cover URL instead.
- **Windows not verified.** The shell is cross-platform, but this build has only
  been exercised on Linux/Wayland.

## Data

| What | Where |
|---|---|
| Library | `~/.config/GameVault Experimental/games.json` |
| Settings | `~/.config/GameVault Experimental/config.json` |
| Art cache | shared with 1.x (`~/.config/GameVault/artworks_cache`) |

Delete that directory to start clean.

## Status

`2.0.0-experimental.1` — UI overhaul in progress. Not packaged, not released.
