# Headless Screenshot Audit — GameVault Experimental

Audit date: 2026-10-28 (Asia/Baghdad)
Harness: [`scripts/shots-headless.sh`](scripts/shots-headless.sh)
Output: [`screenshots/audit/`](screenshots/audit/)

## Result

**10/10 states captured. All rendered OK. No unknown states.**

Disk free before capture: **7.2 GB** (≥ 2 GB requirement). Every capture ran in its own
Xvfb display via `xvfb-run -a`; nothing rendered on the real display. Each PNG is
1200×760, exists, is a valid PNG, and is larger than 20 KB (smallest: `detail.png`,
149,128 B). No run hit the 70-second timeout (runs took 12–15 s each).

## Method

Per state:

```bash
timeout 70 xvfb-run -a ./node_modules/.bin/electron . \
  --shot screenshots/audit/<state>.png \
  --wait 7000 --shot-delay 4000 [--shot-state <state>]
```

`home` was captured without `--shot-state`; every other state passed
`--shot-state <state>`. Stale PNGs were deleted before each run, then the file was
required to exist, be a valid PNG, and exceed 20 KB. Logs were kept outside the repo
in `/tmp/gamevault-shot-audit-logs/`. No application source was modified.

## Per-state results

| State | Rendered OK | Size | Visible layout problems |
|---|---|---|---|
| [home](screenshots/audit/home.png) | Yes | 697,292 B | No breakage. The rightmost shelf tile is clipped by the viewport and the next-arrow overlays it (expected horizontal-rail behavior). Hero area is very dark but populated. |
| [gridview](screenshots/audit/gridview.png) | Yes | 704,454 B | **Cover artwork is clipped at the top of every poster.** The 3:4 card media (`object-fit: cover`) crops 2:3 covers, cutting the game logos ("BUCKSHOT", "Prism Launcher"). The first row also sits flush under the filter bar with zero top padding. The top-right rating badges remain visible. Bottom row runs under the search dock (normal for a scrollable grid). |
| [import](screenshots/audit/import.png) | Yes | 417,924 B | None observed. Modal is centered, rows are aligned, actions and summary fit inside the footer. |
| [importmenu](screenshots/audit/importmenu.png) | Yes | 406,108 B | Minor overflow: the launcher dropdown extends past the modal's bottom edge (to y≈560 vs modal bottom y≈479) and overlaps the footer. All six options remain readable; no option is clipped. |
| [importdemo](screenshots/audit/importdemo.png) | Yes | 417,924 B | **Effectively no-op.** Pixel-identical to `import.png` (same SHA-256). The demo flag is set but never used to seed demo content, so no demo UI is visible. |
| [fallshelf](screenshots/audit/fallshelf.png) | Yes | 515,983 B | Edge tiles are clipped by the horizontal rail (Prism Launcher at left, PICO PARK at right), consistent with the centered-scroll state. The selected Hex Bots placeholder leaves a large, empty dark hero band; no overflow or misalignment. |
| [connectclick](screenshots/audit/connectclick.png) | Yes | 357,654 B | None observed. Steam review list scrolls internally; the last visible row clears the fixed footer. Toast sits at bottom-right without overlapping modal controls. |
| [detail](screenshots/audit/detail.png) | Yes | 149,128 B | Large empty areas: the reserved hero band is blank because Hex Bots has no hero image, and the lower-left sessions column is mostly empty. Content fits the 706 px view without overflow. The dev hook opens `games[0]` (Hex Bots), not the currently highlighted Buckshot Roulette. |
| [settings](screenshots/audit/settings.png) | Yes | 401,401 B | Modal needs internal scrolling; its content is taller than the visible body. Nothing overflows the window, and the Done footer stays fixed. The "ON LOGIN" checkbox is far right-aligned within its row, leaving a wide gap after the label. |
| [editmodal](screenshots/audit/editmodal.png) | Yes | 311,230 B | **Bottom section is cut at the fixed footer:** only the "WISHLIST" heading is visible; its control sits below the fold until the modal body is scrolled. Artwork previews are blank swatches ("Not set") because Hex Bots has no cached artwork. |

## State support notes

- All ten requested names are understood by the current app: `home` is the no-state
  initial window, and the other nine have corresponding branches in
  `window.__gvDevOpen` (`src/app.js`). No state was unknown.
- `importdemo` is the exception in behavior, not in name: it sets
  `window.__GV_IMPORT_DEMO = true` and opens the normal import modal, but that flag is
  not read anywhere else, so `importdemo.png` is byte-for-byte identical to
  `import.png`.
- `detail` and `settings` both opened successfully. `detail` always uses
  `state.games[0]`, so this audit captured Hex Bots (no hero artwork) rather than the
  shelf-selected game.

## Harness usage

```bash
./scripts/shots-headless.sh --list        # print available states
./scripts/shots-headless.sh               # capture all states
./scripts/shots-headless.sh home detail   # capture selected states
```

The script refuses to run when free space is below 2 GB. It is the only new code in
the repository; the app, preload, and renderer files were not edited.

## Verification

- `scripts/shots-headless.sh --list` prints: `home`, `gridview`, `import`,
  `importmenu`, `importdemo`, `fallshelf`, `connectclick`, `detail`, `settings`,
  `editmodal`.
- All ten files exist, are valid PNGs, and exceed the 20 KB threshold.
- `import.png` and `importdemo.png` are identical (`sha256
  0a450173ed821ec1507df873f52ebf59d0a364de0b113fc4d7fed9578255a8ec`).
