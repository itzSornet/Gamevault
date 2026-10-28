# GameVault Experimental — Bug Audit

Read-only audit of `src/app.js`, `src/style.css`, `main.js`, `preload.js`, `src/backend/importers.js`, and `src/backend/sources/*.js`. No application code was changed. Findings are ordered by severity and impact.

## 1. [high] Shelf stays broken after a zero-result filter or search

**File:** `src/app.js:400-423`, `src/app.js:435-437`, `src/app.js:559-561`

**What breaks:** The empty branch of `renderShelf()` overwrites `#shelf-stage` with “Nothing matches this filter.”, clears `#shelf-strip`, and returns without invalidating two pieces of cached DOM state. `shelfDom.built` is still `true`, so `ensureShelfDom()` returns early and `renderShelfStage()` writes into nodes detached by `stage.innerHTML`. `state._shelfKey` is also unchanged, so when games are visible again the strip is not rebuilt because the key matches, even though the strip DOM is empty. Reproduction: in shelf view click **Finished** when no game is finished, then click **All**. The stage keeps the empty message and the rail is blank/empty. The same happens with a search that returns no results and is then cleared. Only a state change that forces a new key (or reload) recovers it.

**Fix:** In the empty branch set `shelfDom.built = false` and `state._shelfKey = ''` before returning; rebuild the persistent stage on the next non-empty render. Better, keep the stage DOM mounted and show the filter-empty message as a separate overlay so the cached layer refs never become stale. Add a regression test that switches from a populated shelf to an empty filter and back.

## 2. [high] Tracking ticks rebuild the entire detail page every 3 seconds

**File:** `src/app.js:853`, `src/app.js:3051-3056`

**What breaks:** `onTrackingTick` calls `updateCard()`. When a detail page is open, `updateCard()` calls `renderDetail()`, which replaces `#game-view.innerHTML` and calls `startDetailTick()` again. This happens every 3 seconds while any game runs. It resets the session-list/rail scroll position, drops keyboard focus, closes the More menu, reloads the hero image, recreates the 1 Hz timer, and compounds the listener leak in finding 6. It also contradicts the documented performance rule that tracking ticks perform text-only updates.

**Fix:** In `updateCard()` call the existing `updateDetailLive(g)` (or update the hours/status/timer nodes directly) instead of `renderDetail()`. Reserve `renderDetail()` for structural changes (open, edit, wishlist/finish, artwork changed).

## 3. [high] Any launch error leaves the game stuck at “Launching…”

**File:** `src/app.js:2798-2802`, `src/app.js:3074`; `main.js:114-116`, `main.js:129-134`, `main.js:176-180`

**What breaks:** `togglePlay()` sets `state.live[id] = 'launching'` before a fire-and-forget `api.launchGame()`. The main process reports missing executables, missing Proton, unavailable runners, and spawn errors via `game:launch-error`. The renderer’s handler only shows a toast; it never clears `state.live`. The card stays “Launching…”, `togglePlay()` returns immediately for `live === 'launching'`, and the user cannot retry without restarting the app. A failed `spawn` can also leave a tracking entry behind because `startTracking()` is called immediately after `spawn()`.

**Fix:** In the `onLaunchError` handler use `gameId` from the payload to delete `state.live[gameId]`, call `updateCard()`/`updateDetailLive()`, and optionally open the edit dialog for an executable-not-found error. Add a launch watchdog that clears the launching state after a short timeout, and only start tracking after the child emits `spawn`.

## 4. [high] Media IPC allows arbitrary file write and delete via path traversal

**File:** `main.js:614-625`, `main.js:661-673`

**What breaks:** `capture:save-media` passes renderer-controlled `filename` straight to `path.join(mediaDir, filename)`, so `filename: "../../games.json"` overwrites files outside `data_media`. `capture:delete-media` only checks `filePath.startsWith(mediaDir)`, so `mediaDir + "/../../games.json"` passes the prefix test and `fs.unlinkSync()` deletes the file. `capture:show-folder` has the same prefix check. The `capture:*` API is exposed to the renderer in `preload.js` even though the current UI does not call it; any future DOM injection or renderer bug becomes file corruption/deletion.

**Fix:** Treat `filename` as a basename only; resolve the target with `path.resolve(mediaDir, filename)`, compute `path.relative(mediaDir, target)`, and reject absolute paths, empty paths, and values starting with `..`. Apply the same resolution to delete/show-folder. Also restrict media extensions and verify the target is a regular file before unlinking.

## 5. [med] Add/Edit Save is async and unguarded, so double-click duplicates games and Cancel still saves

**File:** `src/app.js:1791-1858`

**What breaks:** The `data-save` handler is async and never disables the button or records that the modal closed. If any artwork URL is remote, it awaits up to four `sgdb:cache` IPC calls at lines 1812-1817. A second click during that window starts a second handler; both see `isNew === true` and both `state.games.unshift(...)`, producing duplicate entries (possibly with colliding `Date.now()` ids). Closing the modal while localization is in flight does not cancel it: the handler still adds the game, calls `closeModal()`, refreshes art, and toasts “Game added”.

**Fix:** Disable Save and Cancel while saving, and capture a modal sequence/closed token before the first `await`; after each await abort if the token is stale or `card.isConnected` is false. Use a temporary unique id and guard the insert against an existing id. Re-enable the controls in `finally`.

## 6. [med] Detail view accumulates a `pointerdown` listener with every render

**File:** `src/app.js:1276` (inside `wireDetail()`)

**What breaks:** `#game-view` is a persistent element, but `renderDetail()` recreates its children and calls `wireDetail()` each time. Each call adds another anonymous `pointerdown` listener to `#game-view`, and each listener closes over the now-detached `menu`, `menuBtn`, and current game object. Combined with finding 2, a running game adds one listener plus a detached detail subtree every 3 seconds, so memory grows without bound. The handlers also all run on every pointerdown in the detail page.

**Fix:** Use a single assigned handler (`view.onpointerdown = ...`) or install one delegated listener outside `renderDetail()` that looks up the current menu via `view.querySelector('[data-menu]')`. Alternatively register once with an `AbortController` and abort it in `closeDetail()`.

## 7. [med] Artwork/title requests are applied out of order

**File:** `src/app.js:1550-1573`, `src/app.js:1615-1638`, `src/app.js:1671-1688`

**What breaks:** `searchCombo()` awaits `api.sgdbGames(q)` and then renders the result without checking whether the input still equals `q` or the modal is still open. `autofill()` applies returned assets and `chosen` regardless of whether the user has since selected another game. `loadArtTab()` awaits `api.sgdbAssets()` and then calls `renderArtGrid()`, which uses the current `art.tab` rather than the tab that requested the response. Fast typing or tab switching can therefore show results for an older query/tab and can save the wrong game’s artwork.

**Fix:** Keep a request sequence per surface (`comboSeq`, `autofillSeq`, `artSeq[slot]`) and increment it before each await; after the await return unless the sequence still matches, the input value is the same, and the modal is connected. For art, render using the requested `slot` and verify it is still `art.tab`.

## 8. [med] Import scans can overlap and stale results overwrite the review list

**File:** `src/app.js:2146-2177`

**What breaks:** `runScan()` sets the shared `busy`, `candidates`, and `scanError` flags but does not reject a second scan. The “Scan a folder…” button remains enabled while a network-backed scan (for example `steam-owned` via `import:scan`) is pending. Choosing a folder starts a second scan that resets `candidates`; whichever promise resolves last overwrites the review list, title, counts, and error state. The Steam login completion (`loadOwned`, line 1974) can similarly replace a scan that started later.

**Fix:** Disable all scan entry points while `busy`, return early from `runScan()` when busy, or use a monotonically increasing scan token and ignore any response whose token is no longer current. Treat `loadOwned()` as another tokenized operation.

## 9. [med] Main and renderer write game state independently; `games:updated` has no listener

**File:** `main.js:191-201`, `main.js:718-723`; `preload.js:14-18`; `src/app.js:141-145`

**What breaks:** `launchGame()` loads `games.json`, writes `lastPlayed`, and sends `games:updated`, but preload exposes no `onGamesUpdated` subscription and the renderer has no handler. The renderer keeps its stale `lastPlayed` and sort order. Worse, the renderer’s 400 ms debounced save, main’s launch-time save, and the async `games:save` handler (which awaits image caching before writing) can finish in any order. A renderer save can overwrite the launch timestamp, or a slow `games:save` can write a snapshot older than a subsequent launch. Imports/edits can be lost the same way.

**Fix:** Make one process the writer. Either add `onGamesUpdated` to preload and merge events by game id/revision, or keep main as the only writer and stop the renderer from writing periodic snapshots. Serialize `games:save` through a queue/mutex in main so writes are applied in call order.

## 10. [med] Steam wishlist is fetched and advertised, then discarded

**File:** `src/app.js:2016-2023`

**What breaks:** A successful Steam sign-in puts the wishlist count into the toast and stores the list in `state.steamWishlist`, but no code ever reads that state. `loadOwned(d.owned)` only imports owned games, so the user sees “12 wishlist” yet no wishlist entries appear in the Wishlist tab. The page and modal both support wishlisted games, so this is a lost feature/data path.

**Fix:** Map `d.wishlist` into candidates with `wishlisted: true` (and a sourceId such as `steam-wishlist:<appid>`), merge them into the review list, and let the existing `_checked`/import flow add them. Either remove the count from the toast or persist/display the wishlist; do not keep an unused `state.steamWishlist`.

## 11. [med] Duplicate detection falls back to case-insensitive title, blocking same-named games

**File:** `src/app.js:1964-1968`

**What breaks:** `existingFor()` first matches `sourceId`/executable path, but its last fallback matches any library game with the same lowercased `name`. Two different games that share a title (remasters, regional releases, sequels with the same name) are treated as already owned, so the new one cannot be imported. The “Update art” button then calls `refreshArt()` on the wrong existing game. The same fallback also hides legitimate imports from different launchers.

**Fix:** Prefer stable ids and normalized executable paths. Only consider a name match when the source is the same and preferably require explicit confirmation; show a “possible duplicate” row instead of silently marking it owned.

## 12. [med] Flatpak Steam is not listed as an import source

**File:** `src/backend/importers.js:57-60`

**What breaks:** `listSources()` checks only `~/.steam/steam` and `~/.local/share/Steam` on Linux. `steamRoots()` in `src/backend/sources/steam.js:17` also supports `~/.var/app/com.valvesoftware.Steam/.steam/steam`, and the scanner can read it, but the import menu marks Steam as “not found” and disables the row. Flatpak Steam users cannot start the installed-Steam import through the normal source list even though the scanner would work.

**Fix:** Reuse the source module’s detection (`require('./sources/steam.js').detect()`) or include the Flatpak path in `listSources()`. Keep source detection centralized so it cannot drift from `steamRoots()`.

## 13. [med] Imported Xbox games can never launch

**File:** `src/backend/sources/windows.js:270-276`; `main.js:114-116`

**What breaks:** `parseXboxApps()` stores `exePath` as a pseudo-URI, `shell:AppsFolder\<PackageFamily>!App`. `launchGame()` validates every path with `fs.existsSync(pathToLaunch)` before launching, and a `shell:` URI never exists on disk. Every Xbox import therefore gets “Executable not found” on Play/Launch. Tracking also cannot use this pseudo-path as a process name, so sessions would not be tracked even if it launched.

**Fix:** Mark Xbox candidates with a launch kind/URI and special-case it in `launchGame()`: launch via `explorer.exe shell:AppsFolder\...` (or `shell.openExternal` with a platform-appropriate handler) before the `existsSync` check. Store the real AUMID/executable separately for tracking, or disable tracking for these entries.

## 14. [low] `img:thumb` drops the `kind` argument, so hero aspect rejection never runs

**File:** `preload.js:11`; `main.js:580`; callers in `src/app.js:222-223`, `343`, `628`

**What breaks:** The renderer calls `api.thumb(g.heroUrl, 1400, 'hero')`, but preload’s wrapper only forwards `{ src, width }`; the third argument is ignored. `img:thumb` therefore always receives `kind === undefined`, so the portrait-cover guard (`kind === 'hero' && aspect < 1.45 → '__reject__'`) is dead. Portrait art is resized into a banner and smeared; `_noHero` is never set through this path, and the banner fallback logic never sees the rejection.

**Fix:** Change the bridge to `thumb: (src, width, kind) => ipcRenderer.invoke('img:thumb', { src, width, kind })` (or pass a single options object), then test both cover and hero requests end-to-end.

## 15. [med] The edit dialog can store “Finished” and “Wishlist” simultaneously

**File:** `src/app.js:1434-1446`, `src/app.js:1842`

**What breaks:** The Finished checkbox and Wishlist checkbox are independent controls in the same modal. Checking both for a new or existing game writes `status: 'Finished'` and `wishlisted: true`. `gvIsWishlisted()` then wins everywhere: the game appears in the Wishlist tab, is excluded from Finished counts, and its detail page shows only the wishlist view. The edit modal also preserves a legacy `status: 'Want'` when the Wishlist box is unchecked (line 1842 keeps `g.status`), so “Removed from Wishlist” can still leave the game wishlisted.

**Fix:** Make the states mutually exclusive in the dialog and normalize on save: if Finished is checked, clear `wishlisted`; if Wishlist is checked, clear/rewrite a legacy `Want` status. Normalize existing records at boot as well.

## 16. [low] JS spring scrolling ignores `prefers-reduced-motion`

**File:** `src/app.js:491-521`, `src/app.js:537-553`; `src/app.js:2420`

**What breaks:** The CSS `@media (prefers-reduced-motion: reduce)` block only shortens CSS animations/transitions. `springTo()` is a requestAnimationFrame scroll animation used by the rail arrows, wheel paging, and `revealShelfTile()`, and it always runs. Users who request reduced motion still get animated horizontal gliding, including when arrow-key selection changes the rail.

**Fix:** Check `reducedMotion()` in `springTo()` and set `el.scrollLeft = target` directly (and return) when reduced motion is requested; use the same guard for the glide/momentum path. Keep the existing command-palette check.

## 17. [low] Game and Settings dialogs have no accessible name

**File:** `src/app.js:1309`, `src/app.js:1359-1363`, `src/app.js:2235-2239`

**What breaks:** `openModal()` creates a `role="dialog" aria-modal="true"` card, but only the Import dialog adds an accessible name (`aria-labelledby="import-title"` at line 1939). The Add/Edit Game and Settings dialogs contain a visible `<h2>` with no id and no `aria-labelledby`/`aria-label`, so screen readers announce an unnamed dialog. The same template also has no `aria-describedby`.

**Fix:** Give every dialog heading a unique id and set `aria-labelledby` on the card in `openModal()` (or pass a `labelledBy` option). Use the existing Import dialog as the reference implementation.

## 18. [low] `railHasData()` is unconditionally true; its real logic is unreachable

**File:** `src/app.js:959-964`

**What breaks:** The function starts with `return true;` and the following metadata check can never run. `loadSteamMeta()` therefore always sees `hadRail === true`, so the “rail had no data, now it does” rerender branch is dead. The function still executes and is used as a meaningful condition, hiding the intended behavior from future changes.

**Fix:** Remove the early `return true` and let the metadata test decide (or delete `railHasData`/the dead branch if the rail should always show). Add a test for metadata arriving after the first detail render.

## Checked, not reported as findings

- **XSS:** I did not find a game-name/path XSS. Every name/path interpolation in the inspected `innerHTML` sinks goes through `esc()` (shelf tiles/stage, detail, combobox, import rows, command palette). Two residual defense-in-depth issues: `g.timeToBeat` is interpolated without `esc()` into a value attribute at `src/app.js:1388` (today only reachable by hand-editing `games.json`), and cover URLs inside `style="background-image:url('...')"` at `src/app.js:2617` are HTML-escaped but not CSS-escaped. Under the page CSP (`script-src 'self'`) neither executes script.
- **Responsive:** I did not reproduce a responsive break at the enforced 900×580 minimum. The only width breakpoint (`style.css:1409`) targets removed classes (`.hero-inner`, `.search`, `.gv-cols`), so it is dead CSS rather than a demonstrated breakage.
- **No code was edited.** The only file written is this report.
