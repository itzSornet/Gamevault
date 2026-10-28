# Game detail page — v2 implementation spec

**Status:** decision complete. No open questions. If the implementation disagrees with this document, the implementation changes.
**Target:** Electron 29 / Chromium 122, dark UI, keyboard + mouse, 1200×760 minimum window, 100 % zoom / 100 % OS scale.
**Scope:** the game detail page reached from the library (the current “two rooms” page). Library filtering, the edit modal, the tracker daemon and the overlay are referenced only where this page depends on them.
**Design tokens:** existing `src/style.css` (`--bg`, `--surface`, `--surface-2`, `--surface-3`, `--line`, `--line-2`, `--text`, `--text-dim`, `--text-mute`, `--accent`, `--ok`, `--bad`, radii 8/12). No new colours, no blur, no `backdrop-filter`, no text below 11 px except a 10 px uppercase eyebrow if strictly needed (this page does not need one).

---

## 0. The page’s job

The page answers three questions in this order:

1. **What is this?** — artwork, name, source/added.
2. **Where do I stand?** — status, playtime, sessions, last played, Play.
3. **What happened?** — notes and session history.

One primary action: **Play** (or **Stop** while live). Everything else is secondary. The page is not a dashboard: one game, one action, one record.

The information architecture is therefore:

- **Left column = the game’s record.** Wide 16:9 artwork, then session history. History needs the width for month groups and the summary strip.
- **Right rail = your relationship with it.** Name, provenance, status, stats, Play, notes, install facts. Notes are a property of your relationship with the game, so they sit beside status and the action, not under the artwork.

This swaps notes and sessions relative to the current layout on purpose; see §1.3.

---

## 1. Audit of the current information set

### 1.1 Current page inventory

Marks are KEEP / MERGE / MOVE / DELETE. `ADD` and `DEFER` are used only for things that are missing from the current page; they are outside the four owner marks.

| # | Element / field | Current behaviour | Verdict | Reason / action |
|---|---|---|---|---|
| 1 | Global app topbar, 54 px | Brand, search, layout/import/settings/Add | KEEP | App chrome, not page content. It is part of the 108 px chrome budget. |
| 2 | Detail toolbar, 54 px, sticky | Breadcrumb, Open folder, Edit | KEEP | Persistent route + actions. Keep sticky; add Wishlist and Help. |
| 3 | Breadcrumb `‹ Library / Name` | Button back to library | KEEP | The only route back. Becomes the page’s back affordance (Esc/Backspace also work). |
| 4 | Open folder | Shown only when `exePath` exists | KEEP | One-click access to mods/saves; one location only. Extend visibility to `exePath` / `installDir` / `steamAppId`. |
| 5 | Edit | Opens game edit modal | KEEP | Management action. Must not be the only path to install facts. |
| 6 | Body grid, fluid + 360 px | 1152 px wide at 1200 | KEEP | Correct two-room split. Cap content at 1120 px so 16:9 art does not eat the fold. |
| 7 | 16:9 artwork panel | 768×432 at 1200; hero-or-cover fallback, background-image | KEEP | Identity/emotional anchor. Becomes 736×414 and uses a real fallback chain. |
| 8 | `NOTES` block under the art | Static label + form | MOVE | Move to the right rail under Play; notes are a state/form control, not the game’s record. |
| 9 | “saved locally” | Static, always claims success | MERGE | Merge into the save status (`Saved`, `Saving…`, `Not saved · Retry`). Delete the static claim. |
| 10 | Bare textarea, 190 px, saves on blur | `onchange` only; no autosave | DELETE | Replace with autosaving field (800 ms debounce + draft). Blur-only loses work. |
| 11 | Title | 27 px, wraps freely | KEEP | Primary identity. Clamp to 2 lines so the fold is predictable. |
| 12 | `source • added date` | Two loose spans | MERGE | One meta line: `Steam · Added Jul 18, 2026`; hide missing parts, never print “undefined”. |
| 13 | 4 status pills: Playing / Finished / Dropped / Want | One `status` string for both status and scope | DELETE | Replace with 3-state `Playing / Finished / Unplayed`; Wishlist becomes a separate boolean. See §3. |
| 14 | 3 stat cells: playtime / sessions / last played | 3 equal cells | KEEP | Correct primary facts. Rebuild as a `<dl>`; make playtime live while running. |
| 15 | Full-width Play button | Toggles Play/Stop, no timer | KEEP | Keep as the only filled accent action. Add live state. See §6. |
| 16 | `SESSIONS` header in the right rail | Uppercase label + `22 total` | MOVE | Move to the left column under the art at 736 px; rename “Session history”; replace “22 total” with “22 sessions”. |
| 17 | Last-8 flat session rows | `sessions.slice(-8).reverse()`; date + duration | MOVE | Move to the left, delete the 8-row cap, group by month, page-scroll, 30 before “Show all”. See §4. |
| 18 | “No sessions logged yet —” inline row | A grey row with an em dash | DELETE | Replace with a real empty state. A dash is not an empty state. |
| 19 | No rating | `rating` exists in data, ambiguous scale | DELETE (from page) | Do not guess 1–5 vs 1–10. Keep the field untouched; revisit only with a canonical scale. |
| 20 | No install info | `exePath`/`installDir`/`steamAppId` unused | ADD | One compact install row with disclosure. See §2.5 and §9. |
| 21 | No launch options | No `launchArgs` field exists | DEFER | Do not invent dead UI. Add only when the data contract gains launch arguments. |
| 22 | No running timer | Button says Stop, stats go stale | ADD | Live strip with timer, live playtime, provisional session row. See §6. |
| 23 | No keyboard shortcuts | Only global Esc/Ctrl+N | ADD | Full page map. See §7. |
| 24 | No empty states | Blank/`—` | ADD | Exact copy for sessions, notes, install, art. See §4.7, §5.6, §9. |
| 25 | 16:9 art fallback | Crops a 2:3 cover into 16:9 | DELETE | Replace with poster-on-flat-surface composition; never crop the cover to a banner. |
| 26 | Whole-page scroll | Single scroll container | KEEP | Keep one page scroll. Session history scrolls with the page; no nested list scroller. |
| 27 | 360 px right rail | Fixed | KEEP | Correct for a form/status column. |
| 28 | `logoUrl`, `iconUrl` | Unused on this page | DELETE (from page) | Library/overlay assets; they do not earn detail-page space. |
| 29 | `aiSummary`, `perfAnalysis` | Unused on this page | DELETE (from page) | AI prose and PC analysis are not identity/status. If ever surfaced, a separate collapsed section, not this page. |
| 30 | No missing-file state | Launch fails with a toast elsewhere | ADD | Missing-file state is part of the install row; see §9. |

### 1.2 Data-field audit

| Field | Verdict | Where it goes / why |
|---|---|---|
| `name` | KEEP | H1, 2-line clamp; full name in `title` and breadcrumb tooltip. |
| `status` | MERGE | 3-state control: `Playing`, `Finished`, `null` (= Unplayed). |
| `hours` | KEEP | Playtime stat; live-add while running. |
| `sessions[]` | KEEP | Grouped session history; computed totals. |
| `added` | MERGE | Meta line with `source`. |
| `lastPlayed` | KEEP | Stat; fall back to newest session start. |
| `source` | MERGE | Meta line with `added`. |
| `exePath` | MOVE | Install row (display + copy) and Open folder target. |
| `installDir` | MOVE | Install row; Open folder fallback. |
| `steamAppId` | MOVE | Install row, tertiary; Steam launch/Open folder fallback. |
| `notes` | KEEP | Autosaving notes field; no limit. |
| `rating` | DELETE (page) | Ambiguous scale (existing data may be 1–10). Never display a guessed score. |
| `aiSummary` | DELETE (page) | Not a library fact; defer to a future insights surface. |
| `perfAnalysis` | DELETE (page) | Same; PC analysis belongs in a separate diagnostic surface, not a game record. |
| `coverUrl` | KEEP | Primary artwork fallback (2:3 poster), never banner-cropped. |
| `heroUrl` | KEEP | Primary 16:9 artwork. |
| `logoUrl` | DELETE (page) | Library/overlay use. |
| `iconUrl` | DELETE (page) | Library/overlay use. |

### 1.3 What the audit establishes

1. The right rail has the correct primary cluster (name → meta → status → stats → Play). It is the only part of the page that is already doing its job.
2. The left column is wasted on a 432 px art panel plus a 190 px form field; the fold is spent on a text box instead of the game’s history. Swapping notes to the rail and sessions to the left buys 736 px of width for history at no cost to the primary cluster.
3. `Dropped` and `Want` are two different concepts sharing one enum. The owner has already decided the model: remove Dropped; filter Playing / Finished / Unplayed; Wishlist is a scope. The data model must follow, not be faked in CSS.
4. The page has no state for the three moments that matter most: **empty** (nothing yet), **running** (something is happening now), and **broken** (the file is gone). Those are first-class UI, not toasts.
5. The current last-8 cap is an arbitrary truncation that hides the only long-term record the app keeps. Replace it with grouped history and progressive disclosure, not a bigger cap.

---

## 2. Final layout and content priority

### 2.1 Geometry at 1200×760

All y coordinates are viewport px at 1200×760, 100 % zoom, normal data, 2-line maximum title.

```
y=0     global app topbar                                          54 px
y=54    detail toolbar (sticky)                                    54 px
y=108   ───────────────────────────────────────────────────────────────
y=132   ┌──────── 16:9 art 736×414 ────────┐   ┌──── 360 px rail ─────────┐
        │                                  │   │ H1 (≤ 2 lines)            │
        │                                  │   │ source · Added …          │
        │                                  │   │ [Playing|Finished|Unplayed]│
        │                                  │   │ helper                    │
        │                                  │   │ 20.9h | 22 | Jul 24       │
        │                                  │   │ [ ▶ Play ]                │
        │                                  │   │ Notes          Saved      │
        │                                  │   │ [ textarea 160 ]          │
y=546   └──────────────────────────────────┘   │                           │
y=558   SESSION HISTORY            22 sessions  │                           │
y=582   This week 4h 12m · This month 12h 30m · All time 20h 54m  [spark]  │
y=610   AUGUST 2026 · 6 sessions · 8h 12m       │                           │
y=634   Wed 26      21:40 – 23:59      2h 19m    │                           │
y=653                                             └───────────────────────────┘
y=670   Tue 25      22:10 – 22:56        46m
y=706   Tue 25      19:02 – 20:29      1h 27m
y=742   … page continues with the rest of the history, page scroll …
y=760   viewport bottom
```

The rail box is schematic; the exact rail coordinates (including the Install row at 629–653) are in §2.5. The rail ends at y=653, while the left-hand session list continues below and drives page scroll.

Measurements:

| Property | Value |
|---|---|
| Content max-width | **1120 px**, centred in the page area |
| Page horizontal padding | 24 px, plus centring; at 1200 the content edge is x=40 |
| Grid | `minmax(0, 1fr) 360px`, gap **24 px** |
| Left column | **736 px** at max width |
| Art | **736×414** (exact 16:9), radius 12, 1 px `--line` |
| Right rail | **360 px** |
| Body top padding | 24 px (content begins y=132 with 108 px chrome) |
| Toolbar | 54 px; inner content aligned to the 1120 px grid |
| Page scroll | one scroll container; only the page scrolls; no nested session scroller |

At widths above 1200 the 1120 px cap holds and the extra space becomes gutters; the art does not keep growing (growth would push history further down and eventually break the 16:9 budget). At CSS widths below 1100 (zoom, not the supported minimum window) the grid stacks: rail first, then art, then sessions. The 1200×760 contract applies only at 1200×760 / 100 %.

DOM order is **toolbar → right rail (H1, meta, status, helper, stats, Play, live strip, Notes, Install) → decorative artwork → session history**; CSS grid areas place the artwork and history in the left column. This puts the page title and controls before the decorative image for screen readers, and explains why focus goes H1 → status rather than through the art. The focus order in §8.1 follows this DOM.

### 2.2 Priority tiers

**P0 — must be usable before anything else (first screen, no scroll):**

- Sticky toolbar: back, current name, Open folder (when available), Wishlist, Edit, Help.
- Artwork (with fallback).
- H1 name (≤ 2 lines) and meta (`source · Added date`).
- Status control + one-line helper.
- Playtime / Sessions / Last played.
- Play button (or Stop when live).
- Notes label + the 160 px field.
- Session history header and summary.
- First three session rows (or the empty state / provisional live row).

**P1 — secondary, but guaranteed to fit on the first screen in the normal state:**

- Install row (`Installed · path` or `Not installed`), collapsed.
- The 12-week sparkline inside the summary row.
- The first month header and the three rows above.

**P2 — below the fold / on demand:**

- Remaining session history (page scroll; 30 rows before “Show all”).
- Install disclosure (full paths, Steam App ID, Copy path).
- Expanded notes (beyond 160 px).
- “Show all sessions”, “Show fewer”, “Jump to newest”.
- Per-row full timestamp tooltip.

**P3 — deliberately absent from this release:**

- Rating.
- `aiSummary`.
- `perfAnalysis` / PC specs.
- Launch options (no data field).
- Artwork lightbox / cover picker (Edit owns artwork).

### 2.3 Formatting rules

One formatter per value, used by both the visible text and the accessible label. These are decisions, not implementation taste.

| Value | Visible | Accessible / `title` |
|---|---|---|
| Added date | `Added Jul 18, 2026` | `Added July 18, 2026` |
| Last played, same day | `Today` | `Today at 21:40` |
| Last played, previous day | `Yesterday` | `Yesterday at 21:40` |
| Last played, current year | `Jul 24` | `July 24, 2026 at 21:40` |
| Last played, other year | `Jul 24, 2025` (15 px value; see below) | `July 24, 2025 at 21:40` |
| Never played | `Never` | `Never played` |
| Playtime, `<100h` | `20.9h` | `20 hours 54 minutes` |
| Playtime, `≥100h` | `1,234h` | `1,234 hours 12 minutes` |
| Session count | `22` | `22 sessions` |
| Session duration | `2h 19m` / `46m` / `1h 08m` | `2 hours 19 minutes` / `46 minutes` |
| Time range | locale format, e.g. `21:40 – 23:59` | `21:40 to 23:59` + full dates |
| Session count in header | `22 sessions` / `1 session` | same |
| Month header | `AUGUST 2026` | `August 2026` |

- Dates use the user’s locale; the reference build uses `MMM D, YYYY` and 24-hour time. Do not hard-code English month names in the accessible label; `Intl.DateTimeFormat` supplies them.
- The last-played stat cell is 120 px wide. `Today`, `Yesterday`, `Never` and current-year dates render at 18 px; a date containing a year renders at 15 px so `Jul 24, 2025` fits without wrapping. The height of the cell does not change.
- All numbers, dates and durations use `font-variant-numeric: tabular-nums`.
- Never print `undefined`, `null`, `NaN`, `Invalid Date` or `0h 0m`. Missing values hide or use the explicit copy above.

### 2.4 Typography

Existing type system; no new faces, nothing below 11 px. Numerals tabular everywhere a value can change.

| Element | Size / line | Weight | Face | Colour |
|---|---|---|---|---|
| H1 | 30 / 34, `-0.022em` | 600 | Space Grotesk | `--text` |
| Meta | 12 / 16 | 400 | Inter | `--text-dim` |
| Toolbar / breadcrumb | 12.5 / 16 | 500 / 400 | Inter | `--text` / `--text-dim` |
| Status segment | 11.5 / 16 | 500 | Inter | `--text` active, `--text-dim` inactive |
| Status helper | 11.5 / 16 | 400 | Inter | `--text-dim`; error `--bad` |
| Stat value | 18 / 22 | 500 | Space Grotesk | `--text`; 15 px if the last-played date contains a year |
| Stat label | 11 / 13, uppercase `0.12em` | 600 | Inter | `--text-dim` |
| Play label | 13.5 / 18 | 500 | Inter | accent-on-dark / `--bad` live |
| Section title | 11 / 14, uppercase `0.14em` | 600 | Inter | `--text-dim` |
| Summary | 11.5 / 16 | 400 | Inter | `--text-dim`; values `--text` 500 |
| Month header | 11 / 14, uppercase `0.12em` | 600 | Inter | `--text-dim` |
| Session row | 12.5 / 16 | 400 | Inter | `--text-dim`; duration `--text` 500 |
| Notes | 13 / 20.8 | 400 | Inter | `--text` |
| Notes label | 11 / 14, uppercase `0.14em` | 600 | Inter | `--text-dim` |
| Install row | 11.5 / 16 | 400 | Inter | `--text-dim` |
| Empty-state title / body | 15 / 20 and 12.5 / 19 | 600 / 400 | Inter | `--text` / `--text-dim` |

### 2.5 Above-the-fold contract

The following must be fully visible at 1200×760, 100 % zoom, with a 2-line title and no error banner. These are acceptance-blocking.

| Element | Top | Height | Bottom |
|---|---:|---:|---:|
| Detail toolbar | 54 | 54 | 108 |
| Artwork panel | 132 | 414 | 546 |
| H1 (2 lines at 30/34) | 132 | 68 | 200 |
| Meta line | 208 | 17 | 225 |
| Status control | 237 | 32 | 269 |
| Status helper | 273 | 16 | 289 |
| Stats row | 305 | 56 | 361 |
| Play/Stop button | 377 | 48 | 425 |
| Notes header | 435 | 18 | 453 |
| Notes field (initial 160) | 459 | 160 | 619 |
| Install row (collapsed) | 629 | 24 | 653 |
| Session section header | 558 | 24 | 582 |
| Session summary | 582 | 28 | 610 |
| First month header | 610 | 24 | 634 |
| First three session rows | 634 | 108 | 742 |

**Live state:** the 36 px live strip appears between Play and Notes. It pushes Notes and Install down but still fits:

| Element | Top | Bottom |
|---|---:|---:|
| Live strip | 435 | 471 |
| Notes header | 481 | 499 |
| Notes field | 505 | 665 |
| Install row | 675 | 699 |

The Play button itself does not move between idle and live (both 48 px at y=377). That is deliberate: the click target that started the game is the same click target that stops it.

Rules that protect the contract:

- H1 is `-webkit-line-clamp: 2` at 30/34 with `overflow-wrap: anywhere`; full name remains in the DOM and in `title`.
- Meta is one line with `text-overflow: ellipsis`; full value in `title`.
- Helper is exactly one line; English copy below is short enough at 360 px.
- Notes starts at 160 px. It may auto-grow to 360 px **after the user focuses or types**, which is a user-initiated change and allowed to push Install below the fold.
- Error states (save failure, missing file) may add one line; the contract applies to the normal state, not to an active error.
- If the global 54 px topbar is absent in some build, subtract 54 from every y value; the contract still holds with more slack.

---

## 3. Status: 3-state model, control, Wishlist, migration

### 3.1 Data model

```ts
type Status = 'Playing' | 'Finished' | null;

interface Game {
  status: Status;        // null means Unplayed (no status)
  wishlisted: boolean;   // default false; separate scope, not a status
  statusUpdatedAt?: number;
}
```

Hard rules:

- `Unplayed` is **not** stored. It is the state `status == null`.
- `Unplayed` is **not derived from hours**. A game can be Unplayed with 20 hours recorded; the helper explains it.
- `Want` is no longer a status value. It becomes `wishlisted: true` with `status: null`.
- `Dropped` no longer exists anywhere in the model, UI, filters, counts, CSS, copy, tests or import normalisers.
- New games default to `status: null`, `wishlisted: false`.
- A game may be wishlisted and have any status. The two fields are independent and never write each other. This invariant is testable and prevents hidden data loss.

Library semantics:

- Status scopes: `Playing` (`status === 'Playing'`), `Finished` (`status === 'Finished'`), `Unplayed` (`!status`). Wishlisted games are excluded from those three scopes and counts, so the three counts plus Wishlist partition the library.
- `Wishlist` is a separate scope, not a status chip, not a fourth segment. Its count is `games.filter(g => g.wishlisted).length`.
- The library’s `Dropped` filter is removed; any persisted `Dropped` filter maps to `Unplayed`. Any persisted `Want` filter maps to `Wishlist`.

### 3.2 Copy for “Unplayed”

The control and filter both say **Unplayed**. Do not use “Not played” (it implies zero hours) or “No status” in the segment (it reads like an error). The definition is carried by the one-line helper under the control:

| Current state | Helper copy (always exactly one line) |
|---|---|
| Playing | `Currently playing.` |
| Finished | `Marked finished.` |
| Unplayed, `hours === 0` | `No status set.` |
| Unplayed, `hours > 0` | `No status set — 20.9h recorded.` |

Tooltip on the Unplayed segment: `No status. Playtime and sessions are kept.`
Screen-reader group label: `Status`.
Live announcement on change: `Status: Unplayed` / `Status: Playing` / `Status: Finished`.

The helper is not a live region; the change announcement comes from the global polite region so it does not double-speak.

### 3.3 Control anatomy

- Full rail width 360, height 32, 3 equal segments of 120, radius 8, 1 px `--line`, background `--surface`.
- Segments: `Playing` · `Finished` · `Unplayed`, left to right in that order, matching the library order.
- Active segment: background `--surface-3`, inset 1 px `--line-2`, text `--text`, plus a 5 px leading dot (`Playing` = `--ok`, `Finished` = `--accent`, `Unplayed` = `--text-mute`). State is never conveyed by colour alone; the fill + text + `aria-checked` do the work.
- Inactive: `--text-dim`; hover `--surface-2`.
- Focus ring: 2 px `--accent-hi`, offset 2 px (the one allowed 2 px outline in the app: it is a focus indicator, not decoration).
- The helper sits 4 px below the control, 11.5 px `--text-dim`, reserved height 16 so changing states never shifts the stats row.
- No “clear” button: `Unplayed` is the clear action.

### 3.4 Click and keyboard behaviour

- Click a segment: set that status immediately, optimistic; focus stays on the clicked segment. Clicking the already-active segment is a no-op (no toggle-off).
- Save: patch only `{ status, statusUpdatedAt }` through the serialized main-process queue (§11.2). Do not re-render the page; update the control, helper, and library count only.
- Failure: revert to the previous status, show `Couldn't update status · Retry` under the control (red, `role="alert"`), keep focus.
- The control is a `radiogroup`; each segment is a `radio` button with a roving tabindex. The checked segment has `tabindex="0"`; the others `-1`.
- **Tab** enters at the checked segment. **Left/Up** selects the previous segment and saves immediately; **Right/Down** selects the next; wrap at the ends. **Home/End** first/last. **Space/Enter** selects the focused segment if it is not already selected.
- `S` focuses the checked segment (global shortcut; disabled while typing).
- `1` / `2` / `3` set Playing / Finished / Unplayed directly (global; disabled while typing). These are convenience keys, not the only path.
- While a session is live, changing status is allowed. Setting Finished during a live session does not stop the game and does not get overwritten on stop. The next launch auto-sets Playing (§6.3).

### 3.5 Wishlist

**Where it lives:** a bookmark toggle in the detail toolbar, labelled `Wishlist` (unset) / `Wishlisted` (set), with `aria-pressed`. In the library it is a separate top-level scope, visually separated from the three status filters; it never appears inside the status control.

- Click or `W` toggles `wishlisted` immediately, optimistic, with no status change.
- Copy: toolbar `Wishlist` / `Wishlisted`; toast `Added to Wishlist` / `Removed from Wishlist` (5 s, with Undo).
- Failure: revert the toggle, `role="alert"` `Couldn't update Wishlist · Retry`, keep focus.
- A wishlisted game is excluded from the three status scopes but keeps its status internally. If it is Playing and wishlisted, the Wishlist scope shows it with a `Playing` badge; removing it from Wishlist returns it to the Playing scope. This is the only behaviour consistent with “separate scope” without destroying data.
- Play on a wishlisted game sets status Playing (via §6.3) but leaves `wishlisted` true. That is intentional: a wishlist can contain a demo or a game you are trying before buying. The toolbar still says `Wishlisted`; the user can remove it in one click.
- Migration: every `status === 'Want'` becomes `wishlisted: true`, `status: null`.

### 3.6 Migration from Dropped / Want

Runs once at startup, before the first render, inside the main process, on the loaded `games.json`:

1. Copy `games.json` to `games.pre-status-v2.<ISO timestamp>.json` in the same directory. Keep the three most recent backups.
2. Transform each game:
   - `status === 'Dropped'` → `status: null`. Keep `hours`, `sessions`, `lastPlayed`, `notes`, `added`, `source`, artwork, paths, `rating`. Do **not** map to Finished; dropping is not completing.
   - `status === 'Want'` → `wishlisted: true`, `status: null`.
   - `status === 'Playing'` / `'Finished'` → keep.
   - `null` / `undefined` / `''` / any unknown string → `null`.
   - `wishlisted` not a boolean → `false`.
3. Write atomically (`.tmp` + rename). Only on success set `config.migrations.statusModelV2 = true`. The migration is idempotent; a second run changes nothing.
4. If the write fails: do not mark the migration complete, show a non-blocking banner `Couldn't update game statuses. Retry`, and retry on next launch. Do not mutate the file in memory-only and pretend it saved.
5. One-time toast after success, only if at least one game changed:
   `Statuses updated: 3 Dropped → Unplayed; 2 Want → Wishlist.`
   Omit zero clauses. No modal, no undo; the backup is the safety net (path surfaced in Settings > Data).
6. Migrate persisted UI state: filter `Dropped` → `Unplayed`; filter `Want` → `Wishlist`; unknown status filter → `Unplayed`. Sort order that referenced Dropped/Want falls back to Last played.
7. Import normalisers (Steam/Lutris/manual/JSON) apply the same mapping to any incoming `Dropped`/`Want` strings. A `Dropped` game currently running: status becomes null, the live session is untouched; on stop it stays null (Unplayed) with the session recorded.

There is no undo button. The backup is the undo. This is intentional: restoring `Dropped` would require restoring a status the product no longer has.

---

## 4. Session history

### 4.1 Placement and geometry

- Left column, under the artwork, 736 px wide.
- Section header at y=558: `h2` **Session history** (11 px uppercase, 0.14em, 600, `--text-dim`) and right-aligned count `22 sessions` (11.5 px, `--text-dim`).
- Summary strip at y=582, height 28.
- First month header at y=610, height 24.
- Rows start y=634; 36 px each.
- The list is **page-scrolled**. There is no inner scroll container, so the mouse wheel and keyboard PageDown always behave like a normal page. Month headers stick under the toolbar while the page scrolls.
- `Show all` appears after the first 30 rows when the total exceeds 30.
- Page height grows with the list: 22 sessions ≈ 1,450–1,500 px; 30 initial + “Show all” for 300. That is expected for a record page.

### 4.2 Grouping and sort

- Group by **calendar month** in the user’s local time, using the session’s **start** timestamp. Do not group by week: weeks duplicate month boundaries, make “this week” ambiguous at the top of the list, and produce more headers than rows for short histories. Weeks are used only in the 12-week sparkline.
- Newest first. Inside a month, newest start first; equal starts sort by end, then by a stable id.
- Month header: `AUGUST 2026` + `6 sessions · 8h 12m`. Always include the year; never make the user infer it. Singular: `1 session · 42m`. Month headers aggregate **saved** sessions only; a live provisional row is not counted until it is saved. If a month has zero saved sessions and one live row, the header reads `AUGUST 2026 · 0 sessions` and omits the duration.
- A session that starts on Jan 31 at 23:40 and ends Feb 1 belongs to **January** (start-based). Its tooltip/accessible label shows the end date; the month header does not move.
- Sessions from a previous year are ordinary rows under a header with that year; the row never repeats the year.

### 4.3 Row anatomy

| Column | Width | Content | Example |
|---|---:|---|---|
| Date | 88 px | Short weekday + day; month/year in the header | `Wed 26` |
| Time range | 132 px | Local start–end, en dash; `+1` if end is next day | `21:40 – 23:59` |
| Duration | 76 px, right | Tabular; `Xh MMm` or `MMm` | `2h 19m` |
| Fill | rest | 1 px bottom border; hover `--surface` | — |

- Row height **36 px**, `box-sizing: border-box`, 12.5 px text, `--text-dim`; duration `--text` 500 with `font-variant-numeric: tabular-nums`.
- Hover is a background only. The row is **not clickable** and the cursor stays default; there is nowhere to go. `title` and a full accessible label carry the full timestamp.
- Cross-midnight: `23:10 – 01:25` plus a small `+1` after the end time. Accessible label spells out both dates.
- Duration formatting: `46m`, `2h 19m`, `1h 08m` (minutes zero-padded when hours exist), `26h 05m` for extreme sessions, `1,234h 05m` if grouping is needed. Never `0m`; sessions under 1 minute are not stored.
- Locale: use `Intl.DateTimeFormat` for weekday/time. In 12-hour locales show `9:40 – 11:59 PM` (AM/PM once at the end). The reference build uses 24-hour.
- Accessible name per row: `Wednesday, August 26, 2026, 21:40 to 23:59, 2 hours 19 minutes.` Visible abbreviations remain for sighted users.
- `<time datetime="2026-08-26T21:40">` on the date; duration uses a visually hidden long form.

### 4.4 Summary: this week / this month / all time

One line at y=582, 11.5 px, separated by `·`:

`This week 4h 12m · This month 12h 30m · All time 20h 54m`

Definitions (all local time):

- **This week:** sessions with `start >= Monday 00:00` of the current week. Weeks start **Monday** (ISO), regardless of locale; tooltip on `This week`: `Weeks start Monday.`
- **This month:** sessions with `start >= the 1st 00:00` of the current calendar month.
- **All time:** stored total playtime (`hours`, or the sum of valid sessions when `hours` is missing), plus live elapsed. This is the same value as the Playtime stat. For imported libraries with historical hours and no session records it can legitimately exceed the sum of listed rows; that is expected. Week/month remain session-derived.
- Period assignment uses the session **start**, never the end. A session that starts Sunday 23:50 and ends Monday 01:00 belongs to the previous week. Documented in the tooltip.
- Live: live elapsed is added to This week / This month / All time when the live session’s start falls in that period. The session **count** is not incremented until the session is saved.
- Zero values render `0m`, not `—`, not `0h 0m`. If there are no saved sessions and no live session, the summary strip is hidden (the empty state replaces it); with a live session it shows the live-derived values.
- Format totals: `4h 12m`, `12h 30m`, `20h 54m`; hours not zero-padded; minutes zero-padded when hours exist; grouping for 1,000h+.
- Week and month totals are computed over **all** sessions, not only the 30 currently rendered. All time uses the total above.

Header count:

- Idle: `22 sessions` (singular `1 session`).
- Live: `22 sessions · 1 in progress` (or `0 sessions · 1 in progress`). The saved count stays saved; the live one is explicitly in progress.
- On stop: count increments and the `· 1 in progress` disappears in the same patch.

### 4.5 Does a chart earn its space?

**Yes — a 28 px sparkline, sharing the summary row. No full chart.**

- 12 weekly bars (Monday–Sunday), 96×24 px, 5 px bars, 3 px gaps, baseline 1 px. Current week `--accent`; past weeks `--text-mute` at 55 %; zero weeks get a 1 px stub so the axis reads as twelve weeks.
- It sits at the right edge of the existing 28 px summary row. **It adds zero vertical pixels.** It answers “am I ramping up or trailing off?” at a glance, which the list cannot do without mental summation. The current week includes live elapsed; earlier weeks are saved sessions only.
- It is not interactive: no hover tooltips, no focus stops. `<svg aria-hidden="true">` plus a visually hidden text summary: `Weekly playtime, last 12 weeks. Highest week: 5h 20m. Current week: 4h 12m.`
- Hide it when fewer than 3 of the last 12 weeks contain a session (sparse data looks like noise), or when there are no sessions at all.
- A 60–80 px bar chart would duplicate the list, push two rows below the fold, and require axes/labels. Rejected. The sparkline is the whole chart investment.

### 4.6 How many rows are visible, and how it scrolls

- **First screen:** 3 session rows (y=634–742), plus the month header. That is the P0/P1 contract.
- **Once the list fills the viewport:** month header pinned at y=108; 17 rows visible (760 − 108 − 24 = 628 px of rows; 17 × 36 = 612, 16 px slack).
- Scroll: the page. `PageDown`/`PageUp`, `Home`/`End`, mouse wheel, trackpad. No inner scroll, no scroll trap. Month headers are `position: sticky; top: 54px` inside the page scroll container (viewport y=108 under the detail toolbar), opaque background, 1 px bottom border.
- **300 sessions:** render the most recent **30** rows by default. After row 30 show a full-width text button `Show all 300 sessions` (`aria-expanded="false"`, `aria-controls` the list). Clicking renders the remaining rows (all 300; no virtualisation needed at this size) and changes the button to `Show fewer`. Focus stays on the button; live region announces `Showing all 300 sessions`. This keeps the default page under ~2.4 screens while making the full record one click away.
- If a future library exceeds 1,000 sessions for one game, virtualise or batch by 100; out of scope for 300.
- New session while the page is not at the top: do not move the scroll position. Show a small `New session saved · Jump to newest` button at the bottom-right of the viewport; clicking scrolls the page to the session section. If the user is at the top, prepend the row under the current month (or a new month header) and let the page grow below.
- “Show fewer” restores 30 rows and leaves the button in place; focus stays on it.

### 4.7 Empty state (exact)

When `sessions.length === 0` and no live session:

```
No sessions yet
Press Play. Your first session is saved when you stop.
```

- First line 15 px/600 `--text`; second 12.5 px/19 `--text-dim`; block 160 px tall, left-aligned at x=0 of the left column, vertically padded 24 px. No illustration, no icon, no CTA (the Play button is 157 px above and already primary).
- Header still reads `0 sessions`; summary strip and sparkline are hidden.
- Stats show stored playtime (`0h` if none), `0` sessions, and `Never` when `lastPlayed` is undefined.
- If all stored sessions are invalid (NaN/negative), treat as empty and log; never show NaN.

While a session is live and there are no saved sessions, the empty state is **not** shown. A provisional row appears under the current month header:

`Today   In progress   —` (the time column says `In progress`; the duration column stays `—`; no ticking duplicate timer, the live strip owns the clock).

Header: `0 sessions · 1 in progress`. On stop, the provisional row is replaced by the real row and the count becomes `1 session`.

### 4.8 Data rules

- Valid session: finite `start > 0`, finite `duration > 0`. If `duration` is missing but `end` exists, derive `(end − start) / 3,600,000`. A zero/negative duration is invalid and never displayed.
- Ignore invalid entries in display and totals; keep them in the file (no destructive cleanup) and log once.
- Do not merge/dedupe sessions on this page. The tracker already merges sub-5-minute gaps; this page is a read view.
- Total playtime stat uses `game.hours` when finite; if missing, sum valid sessions. Display and totals round to the nearest minute for accessible labels, but the visible hours use the stored float (one decimal under 100h).
- All sums are recomputed on data change, not per scroll.

---

## 5. Notes

### 5.1 Placement and size

- Right rail, under Play/live strip, above Install.
- Width 360, initial height **160 px** (≈ 6 lines at 13/20.8 + 12 px padding), radius 8, 1 px `--line`, background `--surface`, padding 12 × 13.
- Auto-grow from 160 to **360 px** based on `scrollHeight`. At 360 it stops growing and scrolls internally. No manual resize handle (`resize: none`); auto-grow is the affordance.
- On initial render, a stored long note is shown in the 160 px box and does **not** auto-grow; growth starts when the field is focused or edited. This preserves the first-screen contract for imported 10k notes. Focusing the field expands it to its content height (max 360).
- Label `Notes` (11 px uppercase 0.14em) at left; save state at right (11.5 px). Focus ring 2 px accent.
- Placeholder: `Add notes, tips, or where you left off…`
- The field is a plain text value. Render as text only, never as HTML. Do not trim.

### 5.2 Autosave

- **Debounce 800 ms** after the last `input`.
- Also save immediately on: blur, route close (`Esc`/back), app `beforeunload`, `Ctrl/Cmd+S`.
- On every keystroke, write a draft to `localStorage` key `gv.notes.draft.<gameId>` with `{ text, savedAt }`. This is the crash/quota safety net; it is not the source of truth.
- Main-process write: patch `{ notes, notesUpdatedAt }` for that game id through the serialized queue (§11.2). Never write the whole games array from a debounce timer.
- Do not re-render the page on save. Preserve focus, caret, selection and scroll position.
- On load: if a draft exists and `draft.savedAt > game.notesUpdatedAt`, restore the draft, focus nothing, and show `Draft restored · Discard` in the notes header; otherwise use the stored notes and ignore/delete the draft.
- On successful persist: clear the draft, set state `Saved`.
- If the text has not changed, do not write and do not claim “Saved”.

### 5.3 Feedback states (exact)

| State | Copy | Where |
|---|---|---|
| Editing, not yet saved | `Unsaved` | notes header, right |
| Write in flight | `Saving…` | notes header, right |
| Persisted | `Saved` | notes header, right; persists until next edit |
| Failure | `Not saved · Retry` | notes header, right; `Retry` is a real button; error mirrored to the global alert region |
| Draft found | `Draft restored · Discard` | notes header; `Discard` is a text button |
| Initial empty, never edited | (nothing) | notes header |

`Saved` may carry a `title` with the exact local time (`Saved at 14:32`), but the visible label stays short. Do not show a toast for a successful autosave; the header is enough.

Use one visible save-state node with `role="status"` for `Unsaved` / `Saving…` / `Saved`. Do not also put `role="alert"` on that node. On failure, keep the visible `Not saved · Retry` and mirror the error into the global assertive alert region; the `Retry` control remains a normal button after the textarea.

### 5.4 Failure handling

- Persist failure: keep the full draft in memory + localStorage; show `Not saved · Retry`; do not clear the textarea; do not steal focus. Retry calls the same patch. After 3 failures, add a `Copy` text button next to Retry so the user can get the text out; `Copy` puts the note on the clipboard and announces `Notes copied`.
- Disk full / permission error: same; log the main-process error; the draft survives restart.
- If the draft is newer than the stored note on next launch, restore it and show `Draft restored · Discard`. Discard deletes the draft and reloads the stored note.
- If the stored note is newer than the draft (e.g., another write), trust the stored note, delete the stale draft.
- No conflict UI: single window, single writer.

### 5.5 Character limit and 10k notes

- **No character limit.** A 10,000-character note is supported: it scrolls inside the 360 px max height, saves in one patch (~10 KB), and does not truncate. A local JSON file has no reason to cap human notes, and silent truncation is worse than a large write.
- Optional, non-blocking size hint at ≥20,000 characters in the header: `20,412 characters` (11 px `--text-dim`), no limit, no block.
- Pasting 10k characters must complete in one frame; use `value` assignment, not per-character rendering.
- Rendering 10k characters in a textarea is native and cheap; do not use a contenteditable.

### 5.6 No notes

There is no separate “no notes” empty state. An empty textarea with the placeholder is the empty state. The label and field remain; save status is blank until the first edit. `N` focuses it.

---

## 6. Running state

### 6.1 State machine

| State | Button | Timer | Stats | Session list | Status |
|---|---|---|---|---|---|
| Idle | `▶ Play` | hidden | saved totals | saved rows | user value |
| Launching | spinner + `Launching…`, disabled | hidden | unchanged | unchanged | unchanged |
| Live | `■ Stop` (danger tint) | 36 px strip below button, `H:MM:SS` | playtime = base + live; sessions = saved count; last played = `Now` | provisional `In progress` row at top | auto-set Playing on live start |
| Stopping | `Stopping…`, disabled | frozen at last tick | unchanged | provisional row | unchanged |
| Error | `▶ Play` | hidden | unchanged | unchanged | unchanged |

### 6.2 Live strip

- Sits between the Play button and Notes, 360×36, radius 8, `--surface`, 1 px `--line`.
- Left: 6 px pulsing dot (`--ok`; opacity pulse 2 s, disabled under `prefers-reduced-motion`) + `Playing now` (11.5 px `--ok`).
- Right: timer `0:42:13` (14 px, tabular, `--text`), `role="timer"`, `aria-live="off"`, `aria-label="Elapsed 42 minutes 13 seconds"` updated at most every 10 s.
- Updates once per second from `startedAt` (or the tracker’s `elapsedMs` anchor); recompute from the anchor to avoid drift. No layout change: tabular numerals and a fixed-width right slot.
- The strip is not focusable and not clickable. The Play button is the stop control.

### 6.3 Status on launch

- On the tracker’s **live start** event (not on click), if `status !== 'Playing'`, patch status to Playing and announce `Status set to Playing.`
- Do not auto-set Finished on stop. Stop never changes status.
- If the user explicitly sets Finished during a live session, it stays Finished after stop; the next launch sets Playing again.
- If launch fails, status is not changed (the auto-set happens only after a confirmed live start).
- A wishlisted game stays wishlisted; `wishlisted` is independent (§3.5).

### 6.4 Stats while live

- **Playtime:** `base = game.hours` (or sum of sessions) + live elapsed. Visible value re-renders every 30 s to avoid decimal flicker; the accessible label is exact to the minute.
- **Sessions:** saved count only. The header adds `· 1 in progress`; the stat cell does not increment until the session is saved.
- **Last played:** `Now` while live; `Today` after stop; full timestamp in `title`/`aria-label`.
- Do not add a fourth stat cell for the timer. The live strip is the timer.

### 6.5 Return to idle

On stop confirmation (or external process exit):

1. Hide the live strip.
2. Button label returns to `Play`, icon to play triangle; same 48 px geometry.
3. Stats settle to the saved totals returned by main; sessions count increments (if saved); last played becomes `Today`/`Now`.
4. Replace the provisional row with the real row at the top of the current month (or add a month header if needed).
5. Summary totals update (This week / This month / All time).
6. Focus stays where it was (usually the Play button). Polite announcement: `Session saved: 42 minutes. Total playtime 21 hours 36 minutes.`
7. If the user was scrolled away from the top, show `New session saved · Jump to newest`; do not move the page.

### 6.6 Short sessions, external exits, restart

- **Under 1 minute:** do not save a session, do not increment count; announcement `Session under 1 minute wasn't saved.` The live strip hides; status is unchanged (normally Playing, unless the user changed it during the session).
- **External exit (game closes itself):** same return as Stop; toast/announcement; focus unchanged. If the page is closed, the library card updates and the session is visible on next open.
- **Stop failure:** keep the live strip and timer; button becomes `Stop` again after 10 s; `role="alert"` `Couldn't stop the game. Try again.` Do not fake a session end.
- **App restart while live:** the page reads live state from the tracker. If `startedAt`/`elapsedMs` is available, resume the timer exactly; if not, show `Playing now` with `—:—:—` rather than inventing elapsed time, and keep Stop enabled.
- **Double launch:** the button is disabled from click until launch success/failure; `Space` is ignored during Launching; no duplicate tracker sessions.

### 6.7 Launch and file errors

- If `exePath` is known and the main process reports ENOENT, show `role="alert"` `Game file not found. Locate it in Edit.`; install row becomes `File not found` (`--bad`) with a `Locate…` button; Play is disabled until the path is fixed.
- If no executable and no Steam App ID: install row `Not installed` with `Set executable`; Play is disabled with `title="No executable set"`.
- If a Steam App ID exists but the path is unknown, Play may launch via Steam; do not mark it missing.
- A launch that hangs > 8 s returns to Play with `Couldn't start the game.`; no timer.

---

## 7. Keyboard map

All shortcuts are active only while the detail page is the active surface and no modal/dialog is open. Single-key shortcuts are disabled in a typing context and during IME composition.

| Key | Action | Scope / notes |
|---|---|---|
| `Esc` | Contextual back/close | If a modal/popover/help is open: close it. Else if focus is in Notes: blur + save, stay on page. Else: close detail, return to library. `event.isComposing` → let IME handle it. |
| `Backspace` | Back to library | Only when focus is not in an input/textarea/select/contenteditable and no modifier. Prevent default. In Notes it deletes a character. |
| `Alt+Left` | Back to library | Same as Esc outside typing; prevents default. |
| `Space` | Play / Stop | Only when focus is on the page background, artwork, heading, stats or other non-interactive page area; prevents page scroll. If focus is on a button/radio/link, native activation wins. Ignore `event.repeat`. |
| `E` | Edit game | Opens the edit modal; focus first field; on close return focus to Edit. |
| `W` | Toggle Wishlist | Same as toolbar toggle; optimistic; announces. |
| `O` | Open folder | If a path exists; otherwise polite `No folder set for this game.` |
| `S` | Focus status control | Focus the checked segment; arrows then change status. |
| `1` / `2` / `3` | Set Playing / Finished / Unplayed | Direct; saves; announces. Ignore with any modifier or Shift. |
| `N` | Focus Notes | Moves caret to the end; scrolls the field into view. |
| `Ctrl/Cmd+S` | Save notes now | Prevents the browser save dialog; flushes the pending note; announces only on failure. |
| `Ctrl/Cmd+K` | Command palette | Existing global search. Works even while Notes is focused (it is a modifier shortcut, not text). While the palette is open, all page shortcuts are suspended; on close, focus returns to the prior element (or search dock). |
| `?` (`Shift+/`) | Keyboard help | Opens a small modal listing this table; focus trap; Esc closes; focus returns to the Help button. |
| `Tab` / `Shift+Tab` | Focus | Normal DOM order. |
| `PageUp` / `PageDown` / `Home` / `End` | Page scroll | Native page scroll; not hijacked by the page. Inside the status group, Home/End move to first/last segment. |
| `Enter` | Activate focused control | Native; no global binding. |

Conflict rules (implement as one `keydown` handler with a guard, not as scattered listeners):

1. **Typing context** = `target.closest('input, textarea, select, [contenteditable="true"], [role="textbox"], [role="combobox"]')`. In it, only `Esc`, `Ctrl/Cmd+S`, `Ctrl/Cmd+K`, `Tab`, and native editing keys do anything special. Letters, Space, digits, Backspace and `?` are typed.
2. **Modal/dialog open** = no page shortcuts at all. The dialog owns focus, Esc closes, Enter submits where appropriate.
3. **`event.isComposing`** = ignore every custom shortcut (IME).
4. **`event.repeat`** = ignore Space, E, W, O (no machine-gun launches/toggles).
5. **Modifiers** = single-letter/digit shortcuts require no Ctrl/Cmd/Alt; Shift is ignored for letters/digits. `?` is the explicit Shift case.
6. **`event.defaultPrevented`** = do nothing.
7. `Backspace` must never navigate while the target is editable, even if the editable is inside a shadow root.
8. Closing the page is never blocked by unsaved notes; the draft is flushed synchronously to localStorage and the path-close save is queued. No “are you sure?” dialog.
9. Space does not start a game while focus is in the scrollable session area, because that area is not focusable; if a future control lives there, it wins.
10. No global `Delete` shortcut. Destructive actions stay behind Edit/confirm.

Discoverability: a `?` icon button at the end of the toolbar with `aria-label="Keyboard shortcuts"` opens the same dialog. The `Ctrl K` hint remains in the app’s search dock.

---

## 8. Accessibility

### 8.1 Focus order on open

The page is focused on open; it does not leave focus on the library card behind the overlay.

1. Skip link (`Skip to game details`) — visually hidden until focused; targets the H1.
2. Breadcrumb/back (`Back to Library`).
3. Open folder (if rendered).
4. Wishlist.
5. Edit.
6. Help (`?`).
7. **H1** — programmatically focused on open (`tabindex="-1"`), not a tab stop afterwards. Screen reader announces the game name.
8. Status group — the checked segment is the single tab stop; arrows move within.
9. Play/Stop.
10. Install disclosure.
11. Notes textarea.
12. `Show all sessions` / `Show fewer` (when present).
13. `Retry` / `Discard` / `Copy` (only when the error/draft state exists and the corresponding control is inserted; they sit next to their field, not at the end of the page).

Session rows, month headers, the chart, stats and artwork are not tab stops. They are read in browse mode. The install disclosure’s expanded Copy path is a tab stop after the disclosure toggle.

### 8.2 Roles and names

| Region | Semantics |
|---|---|
| Toolbar | `<header>`; breadcrumb `<nav aria-label="Breadcrumb">`; current name `aria-current="page"`; back button `aria-label="Back to Library"`. |
| Main | `<main id="gv-main">`; `<h1 tabindex="-1">` with the full game name. |
| Artwork | Decorative `<img alt="">` / monogram `aria-hidden="true"`; the H1 is the identity. A cover-poster fallback is also decorative. |
| Status | `role="radiogroup" aria-labelledby="status-label" aria-describedby="status-help"`; each segment `role="radio" aria-checked`; visually hidden label `Status`. |
| Stats | `<dl>` with `<dt>`/`<dd>`; values are text, not headings. |
| Play | `<button aria-label="Play <name>">` / `aria-label="Stop <name>"`; the timer is described by the live strip via `aria-describedby` while live. |
| Live strip | `role="timer"` on the time, `aria-live="off"`, `aria-label` full elapsed. `Playing now` is plain text. |
| Install | Disclosure `<button aria-expanded aria-controls>`; expansion is a `<div>` with path text and a Copy button. |
| Notes | `<label for="gv-notes">Notes</label>`, `<textarea aria-describedby="notes-save">`; save state `role="status" aria-live="polite"` (`Saving…` / `Saved`); failures use the global `role="alert"` region and a visible `Retry` button. |
| Session history | `<section aria-labelledby="sessions-heading">`; `<h2 id="sessions-heading">Session history</h2>`; each month `<section>` with `<h3>`; each `<ol>` of `<li>` rows; row accessible name full sentence; `time` elements. |
| Sparkline | `<svg aria-hidden="true" focusable="false">` plus a visually hidden text summary. |
| Help modal | `role="dialog" aria-modal="true"`, focus trap, Esc closes, focus returns. |
| Global announcer | One visual-hidden `<div role="status" aria-live="polite" aria-atomic="true">` for status/save/session/wishlist messages. Errors use a separate `role="alert"`. |

### 8.3 Live regions and the timer

The ticking timer is **not** a live region. A timer that announces every second is unusable. Instead:

- Visible timer: updates every second; `role="timer"`, `aria-live="off"`; its `aria-label` is updated at most every 10 s and is available on demand.
- Polite announcements:
  - start: `Playing <name>. Timer started.`
  - 30 minutes: `30 minutes played.`
  - 60 minutes: `1 hour played.`
  - every subsequent 60 minutes: `2 hours played.`, etc.
  - stop: `Session saved: 42 minutes. Total playtime 21 hours 36 minutes.`
  - short session: `Session under 1 minute wasn't saved.`
- Status changes, wishlist changes, note save success/failure and “Showing all sessions” use the same polite region. Launch/stop/notes failures use the alert region.
- Do not announce playtime stat updates every 30 s.

### 8.4 Focus return on close

- Store the exact originating element when opening: library card, Wishlist row, command-palette result, or search dock. On close, restore focus to it.
- If the origin no longer exists (e.g., the game was filtered out because its status changed, or deleted), focus the search dock; if the search dock is hidden, focus the library heading.
- Restore the library scroll position; never jump to top.
- Edit modal: closing/cancelling returns to the Edit button; saving returns to the Edit button and announces `Game updated.`
- Help dialog: returns to the Help button.
- Delete/removal from Edit: return focus to the library heading or search, announce `Game removed.`
- If the page is closed while a session is live, the game keeps running; the library card shows Running; no confirmation.

### 8.5 Visual and input accessibility

- Focus ring: 2 px `--accent-hi`, offset 2 px; never `outline: none` without a replacement. On inset controls use `outline-offset: -2px` so it is not clipped.
- Contrast: body/labels ≥ 4.5:1 on `--bg`/`--surface`; use `--text-dim` for 11 px labels, not `--text-mute` for essential copy. Status uses text + fill + dot, never colour alone.
- Hit targets: all buttons ≥ 32×32; status segments 32 high; toolbar 32; text buttons have 8 px vertical padding; rows have no pointer cursor because they are not clickable.
- `prefers-reduced-motion`: disable the live-dot pulse and all fades/transforms; keep the timer text updating. No smooth scrolling anywhere.
- Zoom: at 200 % the grid stacks at <1100 CSS px, no horizontal scroll; at 400 % the toolbar may wrap, status labels remain readable, and the notes field goes full width. The 1200×760 contract is not asserted under zoom.
- Screen-reader page title: `<title>Name — GameVault</title>`; on close restore `GameVault`.
- Long names: full text in DOM (clamp is visual only); breadcrumb `title` has the full name.
- Dates/times: `<time>` with ISO `datetime` and full accessible labels; durations spelled out in accessible names.
- Error messages are associated with their controls via `aria-describedby`; focus is never stolen by an error.

---

## 9. Edge cases and failure modes

| Case | Required behaviour |
|---|---|
| **No hero, cover exists** | Show a 2:3 poster (180×270) centred on `--surface-2` inside the 736×414 frame. No crop, no blur, no stretched banner. Poster is decorative (`alt=""`); H1 names the game. |
| **No hero and no cover** | Monogram tile 736×414: initials (first letters of first two words; first two letters if one word; `?` if empty), 96 px Space Grotesk, `--text-mute`, deterministic dark gradient from `hash(name) % 360`. `aria-hidden`. No broken-image icon. |
| **Hero/cover 404 or offline** | Use a single `<img>` (not `background-image`) with `onerror`; advance hero → cover → monogram exactly once. Never loop. Prefer cached `file://` artwork. No toast, no broken icon; skeleton fades to fallback. |
| **No sessions** | Exact empty state (§4.7); `0 sessions`; stats show stored playtime (`0h` if none), `0` sessions, `Never` when `lastPlayed` is undefined; no summary/sparkline; no “Show all”. |
| **Never played** | `lastPlayed` undefined → `Never`; playtime `0h`; sessions `0`; status `Unplayed` by default; notes placeholder. Do not print `Invalid Date`. |
| **Enormous playtime** | `<100h`: one decimal (`20.9h`); `≥100h`: integer with grouping (`1,234h`); `≥1,000,000h`: grouped integer, allowed to use a 16 px value if needed. Accessible label exact: `1,234 hours 12 minutes`. `title` has the exact value. Tabular numerals; no wrap. |
| **300 sessions** | 30 initial + `Show all 300 sessions`; all 300 render after expansion; page scroll; 17 visible when pinned; sticky month headers; totals over all 300; no inner scroller. |
| **Session from a previous year** | Month header includes the year (`JULY 2025`); row shows weekday/day only; accessible label includes the full date; never infer the year from the current year. |
| **Notes with 10k chars** | No limit, no truncation; textarea scrolls at 360 px max; autosave one ~10 KB patch; draft survives reload; caret/focus stable. |
| **No notes** | Empty textarea + placeholder; no empty-state block; save status blank; `N` focuses it. |
| **Game file missing** | Async existence check on open. Install row `File not found` (`--bad`) + `Locate…`; Play disabled with an explanatory tooltip; `Open folder` disabled; no crash, no toast storm. Locate opens Edit focused on the file field. |
| **No install info** | Install row `Not installed` + `Set executable` (opens Edit); Play disabled; status/notes/sessions still work. |
| **Long name** | H1 clamps to 2 lines; full name in DOM and `title`; breadcrumb truncates with ellipsis and full `title`; no layout shift. |
| **Missing `source` / `added`** | Render only the available part; if both are missing, hide the meta line (do not leave a dot/separator). |
| **Invalid session data** | Skip non-finite/non-positive-duration rows from display and totals; derive duration from `end` when possible; log once; never render `NaN`/`Invalid Date`. |
| **Live + status Finished** | Allowed. The live strip still says Playing now; status helper says Marked finished; stop does not change status; next launch sets Playing. |
| **Live + no saved sessions** | Provisional `In progress` row + header `0 sessions · 1 in progress`; no empty state; summary includes live; stop turns it into `1 session`. |
| **App restart while live** | Resume from tracker `startedAt`/`elapsedMs`; if unavailable, show `Playing now` + `—:—:—` (no invented time), Stop enabled; do not duplicate the session. |
| **Stop failure** | Keep timer and Stop; alert `Couldn't stop the game. Try again.`; do not insert a session. |
| **Double-click / key repeat Play** | Button disabled from click until launch success/failure; `Space` ignored while Launching; one tracker session. |
| **Session under 1 minute** | Discard; do not increment count; announcement; empty state may return. |
| **Notes save failure** | Keep draft, show `Not saved · Retry`, allow Copy; never clear the field. |
| **Status/wishlist save failure** | Revert the control, inline alert + Retry; no page reload. |
| **Deleted game while detail open** | Show `This game is no longer in your library.` + Back; focus heading; no crash. |
| **Window resize / zoom** | >1120: gutters; 1100–1120: content shrinks, art keeps 16:9, contract only at 1200; <1100: stack rail → art → sessions, no horizontal scroll. |
| **Timezone / DST** | Group and summarise in local time; duration comes from the stored per-session hours; a DST wall-clock range may differ from the duration; the duration is authoritative. Weeks start Monday. |
| **Future/invalid dates** | Future session starts still display (data is data) but are excluded from This week/This month if `start > now + 5 min`; invalid dates are skipped. |
| **Corrupt `games.json`** | Do not migrate/write. Show a blocking error with the data path and “Retry”; no destructive overwrite. |
| **Concurrent writes** | Single main-process queue; last write wins per field; no whole-array clobber from two debounces (§11.2). |

---

## 10. What to delete from the current implementation

Delete these completely; do not leave dead CSS, dead branches, or compatibility shims.

**Status and scope**

1. The `Dropped` pill, its CSS (`.pill[data-status="Dropped"]`, `.card-status[data-status="Dropped"]`), its count (`counts.Dropped`, `count-dropped`), its filter, its context-menu action, its toast copy, its sort order, its tests, its docs.
2. The `Want` pill from the detail status group. `Want` as a status value; replace with `wishlisted: boolean` and the separate Wishlist scope. Remove `Want` from `STATUS_ORDER`, status switch statements and the “hide Want from grid” branch (use `wishlisted`).
3. The old `status` write path that re-renders the whole detail page on every pill click. Replace with a field patch.

**Sessions**

4. `sessions.slice(-8).reverse()` and the fixed 8-row list.
5. The `No sessions logged yet` / `—` inline row.
6. The `22 total` label (replace with `22 sessions` / `22 sessions · 1 in progress`).
7. The flat `.gv-session` row template that only prints a date and duration, and its CSS, if not reused by the new row anatomy.
8. Any hard-coded “last 8” copy in docs or screenshots.

**Notes**

9. `notes.onchange = …` (blur-only save).
10. The static `saved locally` label.
11. The fixed `min-height: 190px` + `resize: vertical` behavior (replace with 160 → 360 auto-grow, internal scroll, no resize handle).
12. Any whole-array `saveGamesSoon()` call from the notes debounce.

**Artwork and page**

13. The `gv-art` background-image fallback that does `heroArt || cover` and crops a 2:3 cover into a 16:9 banner. Replace with `<img>` + poster/monogram fallbacks.
14. `max-width: 1180px` on the detail grid; replace with 1120 px.
15. `logoUrl`/`iconUrl` usage on the detail page (if present).
16. Rating UI, `aiSummary` UI, `perfAnalysis` / “Your PC” / “Performance Analysis” blocks from the detail page if porting from the 1.x detail page. They are not part of this page.
17. Any rating input/`PEAK` logic on the detail page.

**Behaviour**

18. The global `Escape` handler that closes the detail page even while typing in Notes or while a modal is open. Replace with the contextual rule in §7.
19. Any “Open folder” duplicate inside the page (the toolbar is the single location).
20. Any `Want`/`Dropped` values in import normalisers, fixtures, seed data, README and design notes.
21. The claim that a 4-pill group is the status model; the status group is exactly three segments.

Do not delete: the artwork, H1, meta, stats, Play, notes field itself, session history section, breadcrumb, Edit, Open folder, or the page scroll. They are reworked, not removed.

---

## 11. Data contract and write rules

### 11.1 Normalised game shape used by this page

```ts
interface DetailGame {
  id: string;
  name: string;
  status: 'Playing' | 'Finished' | null;
  wishlisted: boolean;
  statusUpdatedAt?: number;        // optimistic-write ordering
  notesUpdatedAt?: number;         // draft comparison
  hours?: number;                 // stored total; fallback = sum(sessions)
  sessions?: Array<{ start: number; duration: number; end?: number }>;
  added?: number;
  lastPlayed?: number;
  source?: string;
  exePath?: string;
  installDir?: string;
  steamAppId?: string | number;
  notes?: string;
  coverUrl?: string;
  heroUrl?: string;
  // rating, aiSummary, perfAnalysis, logoUrl, iconUrl are intentionally ignored by this page
}
```

Derived values (compute once per data change, not per render tick):

- `sessionCount = sessions.length`
- `lastPlayedDisplay = max(lastPlayed ?? 0, max(session.start) ?? 0) || null`
- `totalMinutes = round(hours * 60)` if `hours` finite; else sum of valid sessions
- `thisWeek`, `thisMonth`, `allTime` as defined in §4.4
- `weekBuckets[12]` for the sparkline, Monday-based
- `isLive` and `liveStartedAt` from tracking state

### 11.2 Persistence

- All renderer-originated mutations go through one main-process IPC (`games:update`) with `{ id, patch }`. Main serialises writes in a promise queue and writes atomically (`.tmp` + rename). No renderer path writes the whole array from a debounce.
- Status, wishlist, notes and session-end writes must not clobber each other. Last write wins **per field**, not per array.
- The tracker owns session persistence; the renderer only renders the returned/updated game. Do not optimistically insert a saved row twice.
- Migration is the only whole-array write and runs before render with a backup (§3.6).
- Notes drafts are renderer-only (`localStorage`), never written into `games.json` as a separate field.

---

## 12. Acceptance tests

A build is acceptable only if all of these pass.

### Layout

1. At 1200×760 / 100 %, no horizontal scrollbar. `art` is 736×414 ±1; rail is 360; gap 24; content max 1120.
2. H1 (2-line game name) bottom ≤200; Play button 377–425; Notes field 459–619; install 629–653.
3. Session header 558–582; summary 582–610; first row 634; third row bottom ≤760. Three rows are fully visible.
4. With a live session: strip 435–471; Notes 505–665; install 675–699; Play button still 377–425.
5. No text is clipped at 2-line titles; a 60-character name clamps with ellipsis and keeps the full name in `title`.
6. At 1440 wide, content stays 1120 and the art stays 414; at 200 % zoom the layout stacks and does not scroll horizontally.

### Status

7. Clicking each segment writes `status` (`Playing`, `Finished`, `null`), updates the helper exactly as §3.2, and preserves the notes caret/selection.
8. `S` focuses the checked segment; Left/Right/Home/End/Space/Enter behave as a radio group; `1/2/3` set directly. All are inert while Notes has focus.
9. A forced save failure reverts the segment and shows `Couldn't update status · Retry` without losing focus.
10. Wishlist toggle changes only `wishlisted`; status is unchanged in both directions; Wishlist count and the three status counts partition the library.
11. Migration fixture: `Dropped` → `null`; `Want` → `wishlisted:true`/`null`; unknown → `null`; backup exists; second run is a no-op; backup retained.
12. Persisted `Dropped` filter opens `Unplayed`; persisted `Want` opens `Wishlist`.

### Sessions

13. 300-session fixture: 30 rows initially; `Show all 300 sessions` renders 300; totals (week/month/all time) are correct over all 300; the 17-rows-visible check passes after scrolling.
14. Month groups are newest first, with year-bearing headers; a cross-midnight session belongs to its start month; a previous-year session shows the correct year.
15. Empty fixture (no sessions, `hours: 0`) shows the exact copy in §4.7, `0 sessions`, hidden summary/sparkline, stats `0h`/`0`/`Never`.
16. Live with no saved sessions shows the provisional row and `0 sessions · 1 in progress`; stopping turns it into `1 session`.
17. Sparkline hides with <3 active weeks; when shown, it has 12 bars and a visually hidden summary; it adds no row height.
18. `Show fewer` returns to 30 rows and keeps focus on the button.

### Notes

19. Typing 10,000 characters is not truncated; one patch is ≤ ~10 KB; the field scrolls at 360 px; focus/caret stays.
20. Save occurs 800 ms after the last keystroke; blur and `Ctrl/Cmd+S` save immediately; header state goes `Unsaved` → `Saving…` → `Saved`; no toast.
21. A forced failure shows `Not saved · Retry`, keeps the text and draft, survives reload with `Draft restored · Discard`; Retry succeeds.
22. Empty notes show the placeholder only; no empty-state block.

### Running

23. Play → Launching → Live: button says Stop; strip appears; timer increments from `startedAt`; playtime increases; last played `Now`; sessions count unchanged; status becomes Playing (if it was not).
24. Stop: timer hides; button Play; session row appears; count +1; totals update; focus remains on the Play button; announcement says the duration.
25. Under-1-minute session: no row, no count change, exact short-session copy.
26. External exit behaves like Stop. Stop failure keeps the timer and shows the alert. Double launch produces one session.

### Keyboard and accessibility

27. Esc from Notes blurs/saves and does not close; second Esc closes. Backspace in Notes edits; Backspace on the page goes back. Space on the page toggles Play; Space in Notes types a space; Space on a status segment selects it.
28. `E`, `W`, `O`, `S`, `N`, `?`, `1/2/3` match §7 and are inert in Notes; `Ctrl+S` saves notes and `Ctrl+K` opens search from Notes; `?` opens the help dialog with a focus trap and returns focus.
29. On open, focus is on H1; Tab goes to the status group; on close, focus returns to the originating card (or search dock if the card is gone) and the library scroll position is restored.
30. The timer is `role="timer"` with `aria-live="off"`; start/stop/30-minute announcements occur; the visible timer does not live-announce every second.
31. Axe/ACR scan: no critical violations; status group has a name; rows have full accessible names; the chart is hidden from AT and described; focus rings visible; contrast ≥4.5:1.

### Edge/failure

32. Hero missing → cover poster (no crop); both missing → monogram; 404 → one fallback, no broken icon.
33. Missing file → install row `File not found`, Play disabled, Locate opens Edit; no data loss.
34. 1,234h renders without overflow; 300 sessions do not freeze the page; 10k notes do not lag typing.
35. Deleted game → error state with Back; corrupt JSON → blocking error, no write.

---

## 13. Deliberately out of scope

These are decisions, not omissions:

- **Rating:** not shown. The data’s scale is ambiguous (1–5 vs the 1–10 used in 1.x); a guessed score is worse than no score. Revisit only with a canonical, migrated scale.
- **AI summary / performance analysis:** not on the detail page. They are not stable library facts and would compete with play/status. A separate insights surface can use them later.
- **Launch options:** no field exists. Do not add a control that cannot write anywhere. Add `launchArgs` to Edit first, then surface it in the install disclosure.
- **Manual session editing/deleting:** not on this page. Read-only history in v2.
- **Artwork lightbox / cover picker:** Edit and the existing artwork flows own this.
- **Share/export:** not on this page.

No open questions remain for this page.
