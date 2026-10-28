# Import dialog — decision spec

**Scope:** the "Import games" dialog in `gamevault design experimental`. Replaces the 3×2 card grid. Linux sources now; Windows sources and the Steam-account link later. Constraints: no glass/backdrop-filter, no giant cards, ≤3 category groups, no nested modals, fully keyboard usable.

**Decision:** one fixed **720×560** sheet, split **208 px source rail | 512 px review pane**. The rail is grouped into at most three categories (`Launchers`, later `Accounts`, `Files & folders`); the pane scans, filters and imports the selected source without the dialog ever resizing or navigating away.

> A first-pass split sheet landed in `src/app.js` at 18:39 while this was researched (780 px wide, 32 px rail rows, footer inside the pane). This spec keeps that direction and fixes its size, rhythm, footer, selection model and error handling; §12 lists exactly what to delete.

---

## 1. What the references actually do (and what we take)

| # | Reference | What is on screen | Take / reject |
|---|---|---|---|
| 1 | **Playnite — first-run library picker** ([docs](https://github.com/Playnite/Docs/blob/main/docs/manual/gettingStarted/firstStart.md), [screenshot](https://raw.githubusercontent.com/Playnite/Docs/main/docs/manual/gettingStarted/images/firstStart_Wizard2.png)) | 650×540 window. A 3-column grid of **bare checkbox + label** (Amazon, Battle.net, Epic…), no icons, no cards, 10 items. One 2-line paragraph above, `Next` bottom-right, then per-plugin config, then setup finishes and the import runs by itself. | **Take:** a source picker can be plain text; cards add nothing. **Reject:** multi-select checkboxes + wizard — we scan one source at a time and must review. |
| 2 | **Playnite — Add-ons** ([docs](https://github.com/Playnite/Docs/blob/main/docs/manual/features/extensionsSupport/installingExtensions.md), same repo screenshot `extensionsSupport_InstallLibPlugin.png`) | 900×600, three panes: ≈240 px category tree · ≈380 px list (search field + `Search` button on top, **53 px rows, 32 px icons**, name + one-line description) · ≈280 px detail with `Install`. Selected row = filled accent. Footer `Save` / `Cancel`. | **Take:** category → list → action, accent-filled current row, search directly above the list. **Reject:** third pane at 720 px; we have no per-source detail to show. |
| 3 | **Playnite — import runs as a job** ([docs](https://github.com/Playnite/Docs/blob/main/docs/manual/features/extensionsSupport/installingExtensions.md)) | After libraries are configured, `Update Game Library` imports in the background. **No review screen, no per-game selection**; games just appear, metadata fills later. | **Take:** close the dialog and toast; fetch artwork in the background — never block the dialog on enrichment. **Reject:** no dedupe review at all. |
| 4 | **Steam — Games ▸ "Add a Non-Steam Game…"** ([support](https://help.steampowered.com/en/faqs/view/4B8B-9697-2338-40EC)) | One flat dialog: a checkbox list of detected programs, a `Browse…` button, and a footer verb with the count — `Add Selected Programs`. No categories, no search, no status per row. | **Take:** the footer action names the outcome and the number (`Import 39 games`). `Browse…` lives *inside* the flow, it is not a peer source. **Reject:** no status/count and no filter once you have 40+ rows. |
| 5 | **Lutris — "Import a game"** ([source](https://github.com/lutris/lutris/blob/master/lutris/gui/dialogs/game_import.py)) | 500×560 modeless. One row per file with **inline states**: `Calculating checksum…`, `Looking up checksum on Lutris.net…`, red inline error, `Game already installed in Lutris`, per-row `Launch`; footer `Stop` → `Close`. It imports everything it identifies; **no checkboxes at all**. | **Take:** per-row duplication copy and inline progress; 500–560 px is a proven import-dialog size. **Reject:** auto-import without review. |
| 6 | **Heroic — import path dialog + issue #3902** ([source](https://github.com/Heroic-Games-Launcher/HeroicGamesLauncher/blob/main/src/frontend/screens/Library/components/InstallModal/ImportDialog/index.tsx), [issue](https://github.com/Heroic-Games-Launcher/HeroicGamesLauncher/issues/3902)) | Import is a path picker **inside the install modal** of one game (header = game title + platform icon, footer `Import` + spinner). The issue: users keep using `Add Game` (sideload) instead, and end up with broken DRM because they never found `Import Game`. | **Take:** import must be top-level and distinctly named; spinner in the button, not a blocking screen. **Reject:** nesting import inside another task; per-game only. |
| 7 | **GOG Galaxy — integrations** ([support](https://support.gog.com/hc/en-us/articles/360003905618-How-do-I-connect-my-accounts-from-other-platforms-in-GOG-GALAXY?product=galaxy)) | Platform management lives in Settings → Integrations, not in the library. Connect an account once and the **whole owned library syncs automatically**; there is no per-game review, and connection status lives next to the platform. | **Take (later):** an account source is connect + sync, not a checkbox list. Put its status in the rail row. |

Also looked at: **Backloggd** (CSV file → job → results, no per-row picking) and **Hydra** (Steam integration + `library-sync` jobs in its main process — import as a sync, not a wizard). Both agree with #3 and #7: when the payload is huge, change the shape of the task.

**What the references agree on**
1. **Nobody uses cards for sources.** The best pickers are text lists; icons are optional decoration, counts are not.
2. **Categories are labels, not tabs.** Tabs hide `Not found` sources and stop scaling at ~6.
3. **Bulk review exists only where dedupe matters**, and it is a flat list with the verb + count in the footer. Huge payloads become jobs.

---

## 2. The layout decision

**Split, not push and not replace.** A 208 px source rail stays visible while the 512 px pane does the one job (scan → review → import); the dialog never changes size, never navigates, and never hides which other sources exist.

Three-line justification:
1. Importing the whole machine is one continuous session (Steam → Lutris → Heroic) with a **single** `Import 41 games` at the end, instead of five round trips through Back and five separate imports; source switching is 1 click, not 3.
2. The rail is where categories and detection live, so `Not found`, counts and later `Accounts` are visible at all times — a segmented tab row would hide exactly the information the owner asked to surface.
3. 208 px costs the game rows 208 px and they still keep 368 px for name + meta at 720 total; the earlier single-list push would have bought nothing but a second full-screen state and a back affordance.

Rejected:

| Option | Why not |
|---|---|
| Single vertical list grouped by category, push to review | Every source switch is Back → pick → click; selection is lost or per-source imports multiply; the dialog changes height (the exact flaw of today's flow). |
| Segmented tabs (Launchers / Files / Accounts) | Hides `Not found` sources behind a tab; at 20 sources the tab set lies; no room for statuses. |
| Keep cards, restyle them | Equal weight for Steam and "File…"; no category; 8 cards at 148 px min already overflow the 520 px modal; that is the owner's complaint. |
| Left rail + third detail pane (Playnite Add-ons) | 720 px cannot hold three columns; there is no detail to show for a source. |

---

## 3. Frame and geometry

Dialog is **exactly 720×560**, centred in the 1200×760 window at `x=240, y=100`. Scrim `rgba(0,0,0,.62)`. Surface `#0F1117`, border `1px #2E3444`, radius `16px`, shadow `0 20px 50px rgba(0,0,0,.5)`. No `backdrop-filter` anywhere.

**Vertical bands**

| Band | y | height | Content |
|---|---:|---:|---|
| Header | 0 | 56 | `Import games` 17 px/600 Space Grotesk, −0.01em, `#F2F4F8`, left 20; close `32×32` at `x=668, y=12` |
| Body | 56 | 448 | `display:grid; grid-template-columns: 208px 1fr` |
| — rail | 56 | 448 | own scroll, bg `#161923` |
| — pane head | 56 | 40 | source title + count left, search right |
| — bulk bar | 96 | 30 | select all / new only / invert |
| — list viewport | 126 | 378 | 9 rows × 40 px + 18 px slack |
| Footer | 504 | 56 | summary left, `Cancel` + `Import N games` right |

**Horizontal**

| Element | x | width |
|---|---:|---:|
| Rail | 0 | 208 |
| Rail row | 0 | 208 (full-bleed, no radius) |
| Pane | 208 | 512 |
| Pane padding | 208+16 | 480 usable |
| Search field | 720−16−148 = 556 | 148 × 28 |
| Close button | 668 | 32 |
| Import button | 720−20−118 = 582 | 118 (min) |
| Cancel button | 582−8−78 = 496 | 78 |

The dialog **must not change width or height in any state** (idle, scanning, results, empty, error, importing). Only the pane's contents swap. This is the single biggest visual fix over the current card grid and the 780 px sheet.

---

## 4. Wireframes (720×560)

Vertical is schematic (each text line ≈ 24 px); the numbers on the right are the real band heights. Horizontally the box is 94 columns ≈ 720 px (≈7.7 px per column); the rail divider marks the 208 px edge.

### 4.1 Pick state — nothing selected yet

```
┌────────────────────────────────────────────────────────────────────────────────────────────┐
│ Import games                                                                        [ ✕ ]  │  56
├─────────────────────────────┬──────────────────────────────────────────────────────────────┤
│ LAUNCHERS                   │                                                              │
│                             │                                                              │
│ ◈ Steam                42   │                Pick a source                                 │
│ ◈ Lutris                2   │                                                              │
│ ◈ Heroic       Not found    │     Launchers on this computer are listed                    │
│ ◈ Bottles      Not found    │     on the left. Choose one to see its                       │
│ ◈ itch.io      Not found    │     games before importing.                                  │
│                             │                                                              │
│ FILES & FOLDERS             │     Nothing is imported until you choose Import.             │
│ ◈ Folder…         Choose    │                                                              │
│ ◈ File…           Choose    │                                                              │
│                             │                                                              │
├─────────────────────────────┴──────────────────────────────────────────────────────────────┤
│ 2 of 5 launchers found                                                        [ Close ]    │  56
└────────────────────────────────────────────────────────────────────────────────────────────┘
 0                          208                                                          720
```

### 4.2 Review state — Steam picked (the same frame; only the pane changed)

```
┌────────────────────────────────────────────────────────────────────────────────────────────┐
│ Import games                                                                        [ ✕ ]  │  56
├─────────────────────────────┬──────────────────────────────────────────────────────────────┤
│ LAUNCHERS                   │ Steam · 42 games                    [ ⌕ Filter games      ]  │  40
│ ▌◈ Steam               42   │ ☑ Select all                     New only    Invert          │  30
│ ◈ Lutris                2   │ ☑ Road 96                                        NEW         │  40
│ ◈ Heroic       Not found    │   Lutris · 10.3h · ~/Games/Road 96                           │
│ ◈ Bottles      Not found    │ ☑ It Takes a War                                 NEW         │  40
│ ◈ itch.io      Not found    │   Lutris · 0.2h · ~/Games/It Takes a War                     │
│                             │ ☐ Half-Life 2                              IN LIBRARY        │  40
│ FILES & FOLDERS             │   Steam · 12.4h · ~/.steam/…/common/Half-Life 2              │
│ ◈ Folder…         Choose    │ ☐ Portal 2                                 IN LIBRARY        │  40
│ ◈ File…           Choose    │   Steam · 4.2h · ~/.steam/…/common/Portal 2                  │
│                             │                                                              │
├─────────────────────────────┴──────────────────────────────────────────────────────────────┤
│ 39 selected                                            [ Cancel ]  [ Import 39 games ]     │  56
└────────────────────────────────────────────────────────────────────────────────────────────┘
 0                          208                                                          720
```

`▌` = 2 px `#4C7DFF` active bar on the rail. The rail does **not** scroll under 8 sources; the list scrolls independently.

### 4.3 Game row zoom (480 × 40)

```
┌───────────────────────────────── 480 px ─────────────────────────────────┐
│ 8   ☑16  10   Road 96                                       NEW (60) 8   │ 40
│               Lutris · 10.3h · ~/Games/Road 96                           │
└──────────────────────────────────────────────────────────────────────────┘
   pad  check  text x=34        name 13/17 · meta 11/14           chip right
```

Row height 40, radius 8, padding 0 8, gap 10. No separators — 40 px rows with a two-line (17 + 14) content block read as a table on their own; hover and the checked tint do the row delineation. Checked row background `rgba(76,125,255,.06)`.

---

## 5. Rail anatomy (sources)

**Group labels** — height 22, padding `0 14`, `10 px/600` uppercase, `letter-spacing .12em`, `#8A93A6`, sticky when the rail scrolls. Group order: `LAUNCHERS` → `ACCOUNTS` (when it ships) → `FILES & FOLDERS`. Max 3.

**Row order** is fixed inside each group: detected first, then `Not found`, each in product order (Steam → Lutris → Heroic → Bottles → itch.io). Detection resolves before first paint, so nothing ever reshuffles.

**Source row** — `208×40`, full-bleed, border-left 2 px transparent, padding `0 12 0 14`, gap 10.

| Part | Spec |
|---|---|
| Icon | 18×18 brand glyph, no tile, `object-fit: contain`; `opacity .45` when disabled |
| Name | 12.5 px/500, `#F2F4F8`, one line, ellipsis; disabled `#8A93A6` |
| Meta (right) | 11.5 px/600, `font-variant-numeric: tabular-nums`, `#A6AEC0`, right edge 196; active `#A9BEFF`; disabled `#8A93A6` |
| Hover | bg `#1D2130`, meta `#F2F4F8` |
| Active | bg `#1D2130`, 2 px left bar `#4C7DFF`, meta accent |
| Focus-visible | `outline: 2px solid #4C7DFF; outline-offset: -2px` |
| Disabled | native `disabled`, no hover, cursor default, `aria-label="Heroic, not found"` |
| Hit target | 208×40 (whole row); no 32 px dots or icon-only buttons |

**Status per row (this is the "detected / not found" contract):**

| State | Meta text | Row |
|---|---|---|
| Detected, not scanned yet | `›` | enabled |
| Detected, count cached this session | `42` (tabular) | enabled |
| Has ticks | `3/42`, accent | enabled |
| Scanning (only the active row) | 12 px spinner, no text | enabled, `aria-busy` |
| Scanned, 0 games | `0` | enabled, opens empty state |
| Scan failed | `Error` in `#FF5C7A` | enabled, click retries |
| Not installed | `Not found` | disabled |
| Action row (`Folder…`, `File…`) | `Choose` | enabled |
| Account, later | `Not linked` / `Linked` | enabled |

**Groups and sources**

- **Launchers:** Steam, Lutris, Heroic, Bottles, itch.io. *No Flatpak row* — Flatpak is a packaging channel, not a library; detection falls back to `~/.var/app/<id>/…` for Bottles/Heroic/itch, so a "Flatpak" source would only duplicate rows. Windows later appends Epic, GOG, Xbox, EA, Ubisoft, Battle.net to this same group (the group scrolls; no new groups).
- **Files & folders:** `Folder…` (scan a directory) and `File…` (AppImage / ELF / .sh / .exe). These open the OS picker *first* and only enter review after a path is chosen; cancelling leaves the rail untouched.
- **Accounts (v2):** `Steam account` — connect once, sync the owned library; no checkbox list (see §11).

Rail fit check: today's 7 rows (5 launchers + 2 actions) = `8 + 22 + 5×40 + 10 + 22 + 2×40 = 342 px` of 448. Keeping Flatpak as an 8th row = 382 px — still fits. Three groups at 20 sources scrolls; labels stick.

---

## 6. Pane anatomy

**Pane head — 40 px.** Title `Steam` 13 px/600 `#F2F4F8`; separator `·`; meta `42 games` 11.5 px `#A6AEC0`. While scanning: `Steam · scanning…`. With a filter: `Steam · 12 of 42`. Search `148×28`, radius 8, bg `#0B0D12`, border `#222633`, icon 13 px `#8A93A6`, placeholder `Filter games` 12 px; focus border `#4C7DFF`; disabled while scanning.

**Bulk bar — 30 px.** Left: master checkbox 14 px + `Select all` 11.5 px/500 `#A6AEC0`; label becomes `Select all 12` when a filter is active. Right: `New only` and `Invert` text buttons, 11.5 px/500, padding 0 6, height 24, hover `#F2F4F8`. `New only` renders only when the source contains at least one `Update` candidate; today it is hidden (the backend has no update flag yet). Bar has a 1 px bottom border `#222633`.

**List — 378 px, own scroll, 8 px scrollbar.**

**Game row — 40 px** (see 4.3):

| Part | Spec |
|---|---|
| Checkbox | 16×16, radius 4, border 1 px `#3A4152`; checked = `#4C7DFF` fill + 10 px white check; indeterminate = `#4C7DFF` fill + 8×2 white bar; disabled = border `#2E3444`, 45% opacity |
| Name | 13 px/500, line 17, `#F2F4F8`, one line ellipsis |
| Meta | 11 px/400, line 14, `#8A93A6`, one line ellipsis: `source · hours · ~/short/path` (path shortened with `~/`; AppImage/ELF kind appended when known) |
| Chip | 18 px tall, radius 4, padding 0 6, 10 px/600 uppercase, `letter-spacing .06em` |
| Hover | row bg `#161923`, checkbox border `#4A5266` |
| Checked | row bg `rgba(76,125,255,.06)` |
| Focus | inset ring `0 0 0 2px #4C7DFF`, radius 8 |
| Click | anywhere on the row toggles (it is a `<label>`); clicks on the chip still toggle |

**Chips:**

| Chip | When | Style |
|---|---|---|
| `NEW` | not in library | bg `rgba(76,125,255,.14)`, text `#A9BEFF` |
| `IN LIBRARY` | dedupe hit | bg `#1D2130`, text `#8A93A6`; checkbox disabled, row name `#A6AEC0`, no hover, cursor default |
| `UPDATE` | later, `candidate.update` | bg `rgba(255,176,32,.14)`, text `#FFC65C` |
| `NOT ADDED` | per-game import failure | bg `rgba(255,92,122,.14)`, text `#FF98AC` |

`IN LIBRARY` rows stay visible (they explain the dedupe) but are never selectable and never counted.

**Footer — 56 px.** Left summary 12 px/500 `#A6AEC0`, tabular: `39 selected`, `39 selected · 2 sources` when the selection spans sources, `Scanning…` while scanning, `0 selected` when empty. Right: `Cancel` (ghost, 34 px, 78 wide) and `Import 39 games` (primary, 34 px, min-width 118, `font-variant-numeric: tabular-nums` so it does not jitter). Disabled primary = bg `#1D2130`, text `#6E7789`. Footer top border `#222633`, bg `#050608`.

---

## 7. Selection, bulk, and scale

**Selection model:** `Map<sourceId, Set<key>>` for the dialog session. Switching sources **never** clears ticks. `Import` imports the union across every visited source, so five launchers = five clicks + one Import. Dedupe key stays as today: `sourceId` → `exePath` (lowercased) → name (lowercased).

**Defaults on first scan of a source:** every `NEW` row is checked; `IN LIBRARY` rows are never checked; `UPDATE` rows are checked. So Steam's 42 with 3 in library yields `39 selected` and `Import 39 games` immediately — the "one click in, see games, import" requirement.

**Bulk affordances:**
- Master checkbox: toggles **all visible selectable rows**; indeterminate when some are checked. Applies to the filtered set when a query is active.
- `New only`: checks every `NEW` row and unchecks every `UPDATE` row; hidden when there are no `UPDATE` rows. It exists so a patch run can be narrowed, not as a filter.
- `Invert`: flips every visible selectable row (in-library rows are skipped, not inverted).
- `Ctrl/Cmd+A` = select all visible; `Ctrl/Cmd+Shift+A` = deselect all; both are also reachable without a mouse.
- Selection count is stored, not derived from the DOM; it is O(1) and survives filtering.

**Search:** client-side, instant for <2,000 rows, 60 ms debounce above. Matches `name` and `installDir`, case- and diacritic-insensitive (`normalize('NFKD')`). Scope is the current source only. Query resets when the source changes; scroll resets on query or source change, not on toggle. Empty filter result is an in-list state, not the source empty state.

**300 results:** **virtualize, never paginate.** Fixed row height 40 makes it exact: total height `n × 40`; render `first = max(0, floor(scrollTop/40) − 3)` to `last = min(n, ceil((scrollTop+378)/40) + 3)` → ≤ 16 DOM rows at 9.4 visible. `scrollIntoView({block:'nearest'})` when keyboard focus leaves the window. No cap below 10,000 candidates; above that, show `Showing 10,000 of N — use a smaller source` in the bulk bar (never hit by disk sources). Account libraries never use this list (§11).

---

## 8. States and exact copy

All states live inside the pane; the rail and the footer never move. Errors are **persistent, in place** — no toast for a failed scan.

| State | Pane content | Footer |
|---|---|---|
| Initialising (first ~120 ms only) | 3 skeleton rail rows + `Checking for launchers…` 12 px `#8A93A6` | `Checking launchers…` |
| Idle | 24 px line icon `#3A4152`, `Pick a source` 14 px/600, body `Launchers on this computer are listed on the left. Choose one to see its games before importing.` 12 px/18 `#A6AEC0`, hint `Nothing is imported until you choose Import.` 11 px `#8A93A6` | `2 of 5 launchers found` · `Close` |
| Scanning | 6 skeleton rows 40 px, bg `#161923` at 55%, 1.6 s opacity pulse; search disabled | `Scanning Steam…` · `Cancel` |
| Results | list | `39 selected` · `Cancel` `Import 39 games` |
| Empty — Steam/Lutris/Heroic/Bottles/itch | `No games found in Steam` 14 px/600 · `Steam is installed but its library folders are empty. Install a game through Steam, then scan again.` · `Scan again` (secondary, 34 px) | `0 selected` · `Cancel` |
| Empty — Folder… | `Nothing to import in that folder` · `We look for AppImage, ELF, .sh and .exe files up to four folders deep. Try the game's install folder.` · `Choose another folder` · `Scan again` | `Cancel` |
| Empty — File… | `That file can't be launched` · `Only AppImage, ELF, .sh and .exe files can be added.` · `Choose another file` | `Cancel` |
| Error — Steam | `Couldn't read Steam's library` 14 px/600 · `Steam's library index is locked or unreadable. Close Steam, then try again.` · `Try again` · `Choose folder…` | `Couldn't scan` · `Cancel` |
| Error — Lutris | `Couldn't read Lutris's library` · `Lutris's database is locked. Close Lutris, then try again.` · `Try again` | same |
| Error — other launchers | `Couldn't read Heroic's library` · `Heroic's data folder couldn't be read. Check that it's installed for this user.` · `Try again` | same |
| Filter returns nothing | row of text: `No games match “witcher”.` + `Clear filter` text button | unchanged |
| Nothing selectable (all duplicates) | list still shows rows; master checkbox disabled | `All 42 already in your library` · `Import` disabled |
| Importing | unchanged list; controls disabled; if the write exceeds one frame, footer becomes `Importing 39 games…` + 12 px spinner | `Cancel` disabled |
| Partial import failure | failed rows get `NOT ADDED` chip + 2 px `#FF5C7A` left bar | `3 couldn't be imported` · `Retry 3` |
| Success | dialog closes before artwork; toast `Imported 39 games · fetching artwork` | — |

Windows-specific variants: same copy with `Xbox`, `Epic`, `GOG` names; no platform-specific chrome.

---

## 9. Keyboard, focus, accessibility

| Context | Keys | Action |
|---|---|---|
| Dialog | `Tab` / `Shift+Tab` | Trap inside the card (rail → search → bulk → list → footer → close) |
| Dialog | `Esc` | Query non-empty → clear it; otherwise close and return focus to the topbar `Import games` button |
| Rail | `↑` `↓` `Home` `End` | Move focus only — **do not scan on arrow** (avoid heavy scans while arrowing) |
| Rail | `Enter` / `Space` | Scan & show source; on keyboard activation move focus to the first list row when results arrive |
| Rail | letter | Type-ahead jump to the first source starting with it |
| Pane | `/` | Focus search (not `Ctrl+F` — that is the global command palette) |
| Search | `↓` | Move focus into the list |
| List | `↑` `↓` `Home` `End` `PgUp/PgDn` | Roving focus (page = 9 rows) |
| List | `Space` / `Enter` | Toggle the focused row |
| List | `Shift+↑` / `Shift+↓` | Extend range selection |
| List | `Ctrl/Cmd+A`, `Ctrl/Cmd+Shift+A` | Select all visible / deselect all |
| Footer | `Ctrl/Cmd+Enter` | Import (when enabled) |

- `role="dialog" aria-modal="true" aria-labelledby` the header; focus trap implemented locally (the global `openModal` does not trap today).
- Rail: `<nav aria-label="Sources">`, rows are `<button aria-current="true">` when active, `disabled` when not found; `aria-label="Steam, 42 games, 3 selected"`.
- List: `role="list"` / `listitem`; each checkbox has an accessible name `Road 96, new`; the pane has `aria-live="polite"` announcing `Steam, 42 games found` and `39 selected` (debounced 300 ms); `aria-busy="true"` while scanning.
- Never colour-only: `IN LIBRARY` rows carry the chip **and** a disabled checkbox.
- Contrast targets (on the surfaces named): `#F2F4F8` ≈ 17:1, `#A6AEC0` ≈ 8.5:1, `#8A93A6` ≈ 6.1:1, `#A9BEFF` ≈ 10.3:1, `#FFC65C` ≈ 12.1:1. `#6E7789` (4.2:1) is **not used for text in this dialog**, only for the disabled primary button and decorative chevrons.
- Hit targets: rail 208×40, game row 480×40, footer buttons 34 high, close 32×32.

---

## 10. Motion and performance

- Dialog enter: existing 180 ms `translateY(8px)` + opacity; scrim static.
- Source switch: pane contents crossfade **opacity 120 ms only** — no slide, which would imply the rail moved too. Rail active bar is instant (no transition) so clicks feel immediate.
- Skeletons pulse 1.6 s opacity `.4 → .7`; disabled under `prefers-reduced-motion`.
- No `width`/`height`/`margin` animation anywhere; the frame is constant, so nothing can reflow.
- Import: write games synchronously, close the dialog in the same tick, toast, then run the existing `enrichArt()` in the background. Never block the dialog on SteamGridDB (today it waits for artwork before closing).
- Scan concurrency: one visible scan at a time, but **never block switching**. Keep a `scanSeq` token; a stale result is cached silently and not painted. No `if (busy) return`.

---

## 11. Later: Windows, 20 sources, Steam account

- **20 sources:** the rail scrolls with sticky group labels; rows stay 40 px; no new groups. Order is fixed per group (Steam → Lutris → …), with detected rows before `Not found` rows, so a rescan never reshuffles the rail.
- **Steam account (Accounts group):** row meta `Not linked`; clicking opens a pane state, not a nested modal: `Link Steam account` title, one line `We open steamcommunity.com in your browser; your password never touches GameVault.`, a `Open steamcommunity.com` primary button, and a 6-character code in 13 px mono (`#F2F4F8`, letter-spacing .08em). After auth, the pane shows `5,214 games · syncing…` with a 2 px determinate bar; when done, a summary with `Import all 5,214` — no 5,000-row checkbox list (GOG pattern). Progress and failures live in the pane.
- **Updates:** when the backend can report `update: true`, `New only` appears and `UPDATE` chips render; no layout change.

---

## 12. Delete list (from the card grid and the 780 px first pass)

1. `.import-grid` — the 3×2 equal-card grid (`repeat(auto-fill, minmax(148px,1fr))`). Gone.
2. `.import-src` / `.import-sources` card styles and the `is-missing` / `is-busy` opacity treatments. Replaced by rail rows + row meta.
3. `.source-btn` (dead CSS, 0 references) and `.import-item` (dead). Delete.
4. The two-step `.import-step` swap (`sources` hidden → `review` hidden) and the `‹ Sources` back chip. The split frame replaces both; there is no back affordance.
5. The disabled `Import` button on step 1. The pick-state footer shows only `Close`.
6. `Where from?` label. Group labels in the rail carry the taxonomy.
7. `.import-review-head`, `.import-summary`, and the `Select all` link floating above the list. Replaced by the pane head + bulk bar + footer count.
8. `max-height: 320px` on the list and the fixed `520px` modal width for this dialog. The list fills 378 px; the frame is 720×560.
9. Scan-error toasts (`No games found there`, `No runnable file picked`). Errors are now in-pane and persistent.
10. The single `candidates` array and `if (busy) return` (selection is wiped when you switch sources today). Replace with per-source cache + `Map<sourceId, Set<key>>`, and a stale-result token.
11. The `2 new · 3 in library · 9 selected` summary line. Footer says `9 selected`; per-row chips and rail counts carry the rest.
12. The 42 px `.import-row` (in the 18:39 sheet) with 10.5 px meta. Standardise on 40 px rows, 13/11 px text.
13. The 32 px `.import-nav-row` and its `off` / `↗` meta strings. 40 px rows, real icons, `Not found` / `Choose` / counts.
14. The dead `Import` inside the pane footer of the 18:39 sheet, and the missing `Cancel`. One global footer.

---

## 13. Build notes

**State**

```js
scans    = new Map(); // id -> { state:'idle'|'scanning'|'ready'|'error', candidates:[], error:'' }
selected = new Map(); // id -> Set(key)
activeId = null;
scanSeq  = 0;
```

- `selectSource(id)`: `activeId = id`; paint from cache if `ready`; else `token = ++scanSeq`, set `scanning`, await scan, cache, paint only if `token === scanSeq`. Never disable the rail.
- On first `ready` for a source: `selected.set(id, new Set(candidates.filter(isNew).map(key)))`.
- `paint()` derives: visible rows (filter), master state, per-source tick counts (`3/42`), global count (`size` union), footer label.
- Import: union all `selected`, re-run `existingFor` at import time, unshift, `saveGamesSoon()`, `closeModal()`, toast, `enrichArt()` unawaited.

**Reference CSS skeleton**

```css
.import-modal { width: min(720px, calc(100vw - 48px)); height: min(560px, calc(100vh - 48px)); max-height: none; }
.import-modal .imp-head { height: 56px; padding: 0 20px; display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid var(--line); }
.import-modal .imp-head h2 { font: 600 17px/24px var(--font-display); letter-spacing: -0.01em; }
.imp-body { flex: 1; min-height: 0; display: grid; grid-template-columns: 208px 1fr; }
.imp-rail { background: var(--surface-2); border-right: 1px solid var(--line); overflow-y: auto; padding: 8px 0; }
.imp-rail-label { position: sticky; top: 0; z-index: 1; height: 22px; padding: 0 14px; background: var(--surface-2);
  font: 600 10px/22px var(--font-body); letter-spacing: .12em; text-transform: uppercase; color: #8a93a6; }
.imp-src { display: flex; align-items: center; gap: 10px; width: 100%; height: 40px; padding: 0 12px 0 14px;
  border: 0; border-left: 2px solid transparent; background: none; color: var(--text); font: inherit; text-align: left; cursor: pointer; }
.imp-src:hover:not(:disabled) { background: var(--surface-3); }
.imp-src[aria-current='true'] { background: var(--surface-3); border-left-color: var(--accent); }
.imp-src-icon { width: 18px; height: 18px; flex: none; }
.imp-src-name { font-size: 12.5px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.imp-src-meta { margin-left: auto; font-size: 11.5px; font-weight: 600; font-variant-numeric: tabular-nums; color: var(--text-dim); }
.imp-pane { display: flex; flex-direction: column; min-width: 0; }
.imp-pane-head { height: 40px; display: flex; align-items: center; gap: 12px; padding: 0 16px; }
.imp-bulk { height: 30px; display: flex; align-items: center; gap: 10px; padding: 0 16px; border-bottom: 1px solid var(--line); }
.imp-list { flex: 1; min-height: 0; overflow-y: auto; padding: 0 16px; }
.imp-row { height: 40px; display: flex; align-items: center; gap: 10px; padding: 0 8px; border-radius: 8px; cursor: pointer; }
.imp-row:hover { background: var(--surface-2); }
.imp-row.is-on { background: rgba(76,125,255,.06); }
.imp-name { font-size: 13px; font-weight: 500; line-height: 17px; }
.imp-meta { font-size: 11px; line-height: 14px; color: #8a93a6; }
.imp-chip { height: 18px; padding: 0 6px; border-radius: 4px; font: 600 10px/18px var(--font-body); letter-spacing: .06em; text-transform: uppercase; }
.import-modal .imp-foot { justify-content: space-between; height: 56px; padding: 11px 20px; }
```

**Acceptance tests**

1. At 1200×760 the dialog measures 720×560 ±1, centred (240, 100); header 56, footer 56, rail 208.
2. Clicking a source changes neither the dialog's width nor its height (measure before/after; the card grid failed this).
3. Today's seven rows (5 launchers + 2 actions) fit the rail without scrolling; adding Flatpak or Windows sources scrolls it; three groups maximum.
4. Steam with 42 games / 3 duplicates: one click yields `39 selected`, button `Import 39 games`; importing is the second click.
5. Tick 5 rows in Steam → switch to Lutris → back: still 5 ticked; footer sums across sources.
6. 300 results: ≤16 row nodes in the DOM, last row reachable by scroll, master checkbox selects all 300, filter is instant.
7. Keyboard-only: Tab to rail → Enter → focus lands in list → Space toggles → Ctrl+Enter imports → Esc closes → focus returns to the topbar Import button.
8. A thrown scan leaves the rail interactive, shows the error copy in-pane, and puts `Error` in that row; no toast.
9. `grep -r backdrop-filter src/` returns nothing for the dialog; no state animates width/height.
10. Every text run ≥11 px in the dialog is ≥4.5:1 against its own background.
