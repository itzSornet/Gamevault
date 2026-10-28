# UI notes — 2.0 experimental

Scratchpad for the design pass. Current state and the numbers behind it.

## Layout

```
┌ topbar   54px ─ brand · search · layout/import/settings/Add ─────────────┐
├ filterbar 46px ─ All/Playing/Finished/Wishlist ────────────── sort ─────┤
│                                                                          │
│  hero  42%   blurred art → colour bleed, sharp poster right, title left  │
│                                                                          │
├ rail  58% ── 172x236 tiles · wheel / drag / ←→ / ‹ › ────────────────────┤
└──────────────────────────────────────────────────────────────────────────┘
```

No sidebar. Navigation is the filter row; the rail is the primary surface.

## Motion

| What | How | Value |
|---|---|---|
| Stage art/poster swap | two stacked layers, opacity crossfade | 420 ms `cubic-bezier(.22,1,.36,1)` |
| Rail scroll (arrows, selection) | rAF loop, cubic ease-out | 300 ms |
| Wheel | direct `scrollLeft += deltaY` | native feel |
| Drag | pointer capture, 4 px threshold | — |
| Card hover | translateY | 160 ms |

Nothing animates `width`, `height` or `margin`. Selection never jumps: the tile is
centred with the same rAF scroll used by the arrows.

## Backdrop

Was `blur(40px)` — mush. Now `blur(18px) saturate(1.2) brightness(0.78)` on a
`inset:-24px` layer scaled 1.04, so it reads as colour bleeding out of the poster
rather than a grey smear. No backdrop-filter anywhere in the app.

## Command panel (search)

One surface, §: `.cmd` fixed at `top: clamp(96px,17vh,190px)`, 620 px wide,
bar 56 / list 308 / foot 36. The **surface** morphs from the dock
(`transform` + radius only, 280 ms → 200 ms back); the **content** fades in at
110 ms, already at final coordinates. No layout animation, no text flight.

- Dock is a button; it fades while the panel is up.
- Rows 44 px, grouped, `<mark>` on matches, accent inset bar on selection.
- Keys: ↑↓ Home End, ↵ open, Tab/Esc close (Esc clears the query first).
- a11y: combobox + listbox + options, `aria-activedescendant` → real ids,
  live result count, focus returns to the dock, dialogs take focus.

## Known rough edges

- Hero is dark when the cover is dark; a palette sampled from the art would help.
- Rail labels truncate at 172 px; tooltip on hover would cover it.
- No filter popover yet (status only). Genres/platform would need data.


## Game detail — "Marquee"

One screen, no page scroll. The breadcrumb toolbar is gone (chips sit on the
art) and the search dock is hidden while the page is open; Ctrl+K still works.

```
topbar 54
hero clamp(240px,42vh,400px)   [‹ Library]            [☆] [⋯]
  bottom-left: logo ≤340×92 · source · added · played · ★
               [▶ Play 152×48]  [LAST SESSION / 2h 19m]
band = remaining height, pad 20/32/24, grid 1fr + 320
         SESSIONS                          22 sessions
         AUGUST 2026                              (sticky)
         Wed 26   08:54                2h 19m     (38px rows)
```

- Status: `status` is `'Playing' | 'Finished'` and
  `wishlisted` is a separate boolean. The page exposes one action —
  **Mark as finished** in the hero — everything else is Playing. A one-time
  migration turns legacy null/unplayed entries into Playing. The edit modal
  mirrors this with a single Finished checkbox. `Dropped` and `Want` are migrated once on
  boot (`Dropped → Playing`, `Want → wishlisted`), with a `games.json.bak-*` backup.
- Sessions: a plain month-grouped list (`src/lib/sessions.js`), 38 px rows of
  day · start time · duration, live row pinned, latest 100 rendered.
- Play: the only saturated fill on the page; live turns it into Stop with the
  timer to its right (fixed 120 px slot, 1 Hz, text-only updates).
- Keys: Esc/Backspace back, Space play, E edit, W wishlist, O folder,
  F mark finished, ? help.
- One container for hero content and band (`max-width: 1760px`), so the logo,
  chips, list and rail share the same left/right edge at every resolution.
- Rail data: Metacritic + PC requirements come from Steam `appdetails` via the
  `steam:details` IPC (cached 14 days on the game as `steamMeta`, versioned);
  time-to-beat is a manual field in Edit (no reliable free HLTB API). Games
  without a Steam AppID fall back to the AT A GLANCE card only.
- Verified: `game-view` scrollHeight == clientHeight at 1200×760 and 1600×1000.


## Import

Two steps: a launcher source grid, then a review list.

- The sheet is a **208 px source rail + fluid review pane** under a single
  header (`Import games from Steam`), with a full-width footer. Categories are
  only *Launchers* and *Files & folders*; detected sources show counts, the
  rest show a dash. Opening it auto-scans the first detected launcher.
- Rows are 46 px: checkbox, name + `source · hours`, and an `Update` action on
  rows already in the library. Selection is a 7% accent tint; there is no
  per-row "NEW" label.
- States are in-pane: scanning, nothing found, nothing picked, scan error,
  all-owned (footer becomes `Done`). Import closes the sheet immediately and
  fetches artwork in the background.
- `src/backend/importers.js` owns the contract: `listSources()` reports what is
  installed on this OS, `scanSource(id)` returns candidates
  `{ name, source, sourceId, exePath, installDir, hours, steamAppId }`.
- Steam reads the vdf libraries; **Lutris reads `pga.db` with `sqlite3 -json`**
  and joins `~/.local/share/lutris/games/<configpath>.yml` for `exe`,
  `working_dir`, `args`, `prefix`; playtime becomes hours. Falls back to
  scanning the yml dir when there is no database.
- File import sniffs the first 64 bytes for `\x7fELF` and the AppImage magic at
  offset 8, accepts `.sh`, chmods AppImage/ELF to +x, and pulls the name/icon
  from a matching `.desktop` when there is one.
- Dedupe key: `sourceId`, then `exePath`, then name — matches show as
  "In library" and stay unchecked.
- After import the SGDB pass fills cover, hero and logo (it now retries games
  that have a cover but no hero, and records `heroTried` so it cannot loop).
