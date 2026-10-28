# GameVault 2.0 — Steam incremental sync + account library

**Status:** decision-ready spec · **Scope:** Electron main process + renderer, Linux & Windows · **Owner:** lead
**Baseline:** existing one-shot import (`src/backend/importers.js`, `src/backend/scanner.js`, import modal in `src/app.js`)
**Written against:** the code in `gamevault design experimental/` (games.json / config.json, `window.api` bridge, `.field` / `.modal-card` / `.import-*` CSS)

---

## 0. Decisions (read this if you read nothing else)

| # | Decision | Why |
|---|---|---|
| D1 | **Two independent switches**, not one: `Local library (installed)` and `Steam account (full library)`. | Local sync needs no network, no key, no privacy setting. Account sync needs all three. Coupling them makes the reliable half fail whenever the fragile half fails. |
| D2 | **Account link = Steam Web API key + SteamID64 auto-read from `config/loginusers.vdf`.** No OpenID in v1. | OpenID proves *who* you are but still cannot read a library without a key, and it cannot fix a private profile. It adds a redirect listener and a browser window for **zero** extra data. `loginusers.vdf` already gives us SteamID64 + persona name for every account that has ever logged in on this machine — which is exactly the set the user can pick from. |
| D3 | **Local (installed) games: auto-add, silently.** **Owned-but-not-installed games: always queued for review, never auto-added.** | An `appmanifest_*.acf` is a fact: the bytes are on disk. The owned list is a 400–3000 row payload — auto-inserting it turns a curated library into a dump. This split is also what GOG Galaxy and Playnite converge on (owned = import, installed = detected). |
| D4 | **Sync never deletes, never overwrites user edits.** Uninstall → `installed: false`. Refund/left family → `owned: false` + "Not in Steam library" badge. Fields fill only when empty. | Playnite's rule, stated verbatim in its docs: *"Playnite never automatically removes a game that has already been imported."* Same rule, plus per-field provenance so we know which field is ours to touch. |
| D5 | **Review surface = the existing import dialog in "Steam · New games" mode**, entered from a 10 s toast. No banner. | New-game counts in the hundreds; the import modal already has multi-select, search, "In library" chips and a typed confirm. A toast cannot host 300 checkboxes; a banner is permanent chrome for a transient event. |
| D6 | **Sync cadence:** local scan on launch + on focus (mtime-gated) + 5 min while focused. Account sync on launch (if stale > 24 h), on demand, and on focus only if stale > 6 h. **No fixed background timer.** | One API call fetches the whole library; a timer buys nothing but quota and battery. `GetOwnedGames` is a single request — there is no incremental endpoint to poll. |
| D7 | **API key stored with `safeStorage`, never sent to the renderer.** Renderer only ever sees `{ hasKey, last4, steamId64, personaName }`. | The key is a bearer credential for the whole account. Current SGDB handling (raw in `config.json`, typed into the DOM) is fine for a scraping key; not for this. |

---

## 1. Prior art: what each launcher actually does

### 1.1 Playnite (the closest analogue — local-first desktop library manager)

Verified from the official manual and the extension FAQ:

- **Where the setting lives:** `Main menu → Add-ons… → Extension settings → Libraries → Steam`, a left tree (Updates / Extensions settings / Installed / Browse) with the pane on the right. Save / Cancel in the footer. Screenshot: `extensionsSupport_ConfigureLibPlugin.png`.
- **Connect flow:** per-library. The Humble pane shows the shape: a checkbox **`Connect account`**, indented feature checkboxes, and a button **`Authenticate`** with the inline note **`Requires authentication`**. Steam's pane is the same pattern: a **`Private account`** checkbox that reveals **`Get API Key`** and an **`API Key`** textbox. No OAuth for Steam — credential/key paste, one per library, saved with the extension settings.
- **Sync trigger:** explicit, menu-driven: `Update Game Library → Update All (F5) → [Epic, GOG, Humble, Steam, Ubisoft Connect]`, plus a per-library entry in the same submenu. Playnite does *not* silently sync in the background; auto-update-on-start is opt-in.
- **Owned vs installed:** `LibraryPlugin.GetGames()` returns `GameMetadata` with **`IsInstalled`** as a first-class boolean and `GameId` as the per-plugin unique key. Owned-but-not-installed games exist in the library with no play action; the FAQ tells users to *"make sure especially that uninstalled games are set to import if that setting is available."*
- **Removals:** nothing is deleted on sync. Removing a game imported by a library plugin prompts to add it to the **Import Exclusion List** (`Settings → Import Exclusion List`), which makes future library updates skip it. Uninstalling the plugin leaves the games in place.
- **Duplicates:** `Library` is the plugin identity and is not user-editable; `Source` is the free-text escape hatch. Playnite warns that editing `Library` manually "would lead to technical issues."
- **Private profile:** documented, with the exact checklist — profile **and** `Game details` set to Public, and *"Always keep my total playtime private even if users can see my game details"* unchecked — otherwise playtime import silently yields zeros.
- **Known failure mode:** the Steam import silently imports nothing when the profile is private; the top-voted answer is always "check Game details privacy or set a key."

**Borrow:** the `Private account`-style progressive disclosure, per-field import toggles, and the exclusion list. **Do not borrow:** menu-only sync (our brief is auto), and the in-extension key field that renders the key back into a DOM input.

### 1.2 GOG Galaxy 2.0 (the reference for "owned + installed" as two states)

- **Where:** `Settings → Integrations`, one row per platform with **Connect** / **Disconnect**, plus per-integration settings.
- **Connect flow:** Galaxy hosts the auth. The integration API's stated feature is *"multistep authorization using a browser built into GOG Galaxy 2.0"* — the plugin's `authenticate()` returns an `Authentication(user_id, user_name)`; the client shows the account name afterwards and stores a token. Steam's integration historically collected Steam credentials + 2FA inside that host window (the community README's known issues talk about entering a 2FA code and Steam kicking the plugin out after ~a minute of inactivity), which is exactly why Galaxy moved to the host-owned auth flow. **Lesson: never put a password form in our app.**
- **Status surface:** connect → sync starts *after* the auth window closes, and the UI's assumption that "connect == done" is a documented bug source (*"GOG thinks we are immediately done syncing once we connect"*). Large libraries show a sync that outlives the dialog; the recovery affordance is **Retry**. `authenticate(stored_credentials)` means a stored token is reused until invalid, then the user gets a **reconnect** prompt — not a re-login on every launch.
- **Owned vs installed:** the API contract is literally *"importing owned and detecting installed games"*. `Game(..., LicenseInfo(LicenseType))` carries a license kind, so a game that is owned but not on disk renders as a full library tile that offers **install**, not **play**. Installed state arrives asynchronously via `update_local_game_status()` — i.e. a local watcher, not a re-fetch.
- **Duplicates/removals:** the library is a union keyed by platform id; an entry leaving the platform doesn't delete user edits, and re-adding the integration restores the link without duplicating.

**Borrow:** owned/installed as two orthogonal states with a license label; async local install-status updates; explicit Retry. **Do not borrow:** connect-is-not-sync ambiguity — we make sync completion a separate, visible state.

### 1.3 Heroic (what *not* to copy)

Heroic has **no Steam account linking at all**. Its README lists logins for Epic, GOG and Amazon; Steam appears only as *"Import an already installed game"* and *"Add Games and Applications outside GOG, Epic Games and Amazon Games."* Steam games are sideloaded; ProtonDB/Deck compatibility data is fetched per title. So the Heroic precedent is: local detection + manual add, and per-store login otherwise. That is our `Local library` half, with the account half simply missing. Nothing to borrow for account sync; borrow the principle that a store we can't authenticate is still a first-class source via local detection.

### 1.4 Steam itself (the ground truth for the states)

- **Connection:** none. The library is server-side and the client is the account. There is no "sync" button and no "last synced" — this is the UX bar our account sync is being compared against, and it's why our sync must be invisible when it works.
- **Owned vs not installed:** one library, all owned games, with an **Installed** filter in the left sidebar; uninstalled tiles offer **Install** where installed tiles offer **Play**.
- **Tools/runtimes:** Steam keeps them out of the Games view with a **Tools** (and Software / Soundtracks / Videos) toggle in the library filter panel, off by default. This is the same problem we have — `Steam Linux Runtime 3.0 (sniper)` and `Proton Experimental` write real `appmanifest_*.acf` files and must never become library rows.
- **Family sharing:** shared titles appear in *your* library while you have access, badged as coming from another account, and disappear when access ends. Your *owned* list doesn't change.
- **Hiding:** Steam's "Hide this game" removes a title from your view without unowning it.
- **Offline:** the client shows the cached library and marks it offline; nothing is deleted.

---

## 2. Account link: Web API key vs OpenID

Both options end at the same endpoint (`GetOwnedGames`), and **both require a Web API key** — Steam's own API landing page says *"All use of the Steam Web API requires the use of an API Key."* So the honest comparison is: *what does each add on top of the key we need anyway?*

### 2.1 Option A — API key + SteamID64 from `loginusers.vdf` ✅ **RECOMMENDED**

**What it needs**
1. User opens `https://steamcommunity.com/dev/apikey`, names it (anything, e.g. `GameVault`), copies `A1B2…` (32 hex chars).
2. User's Steam profile: **My profile = Public** and **Game details = Public**; and **"Always keep my total playtime private…"** unchecked if they want hours.
3. We read SteamID64 locally — no user input:
   - Windows: `%ProgramFiles(x86)%\Steam\config\loginusers.vdf`, then any `libraryfolders.vdf` root.
   - Linux: `~/.steam/steam/config/loginusers.vdf`, `~/.local/share/Steam/config/loginusers.vdf`, `~/.var/app/com.valvesoftware.Steam/data/Steam/config/loginusers.vdf`.
   - Parse: `users → <steamid64> → { AccountName, PersonaName, MostRecent, Timestamp, AllowAutoLogin }`. Current account = the entry with `MostRecent "1"`, tie-broken by highest `Timestamp`.
4. One validation call: `GetPlayerSummaries` (identity) + `GetOwnedGames` (data).

**What breaks**
- **Private profile / private Game details:** `GetOwnedGames` returns HTTP 200 with an empty body `{"response":{}}` — no error code. Detected by combining the empty result with `communityvisibilitystate != 3` from `GetPlayerSummaries`, and surfaced as a dedicated state (§3.4, E3). A key does not bypass this.
- **"Total playtime private" checked:** games list fine, every `playtime_forever` is `0`. Detected when ≥90 % of a >10-game library reports 0 minutes; shows the hint, does not error.
- **Family sharing:** `GetOwnedGames` returns *only games you own*. Shared titles are invisible to it, period. Installed shared titles still have local `appmanifest` files, so they arrive through the local half and get labelled `Shared` (§7.3).
- **Family/account mismatch:** if `loginusers.vdf` has 3 accounts and the user picks the wrong one, the library is wrong but plausible. Mitigated by showing persona name + avatar next to the picker *before* the first sync.
- **Rate limits:** 100 000 calls/day/key (soft), undocumented per-IP burst → 429, repeat abuse → 403. One call per sync means even 24 syncs/day is 0.024 % of quota. Only a key shared across a fleet could hit it.
- **Key rotation:** Steam allows one active key per account; regenerating invalidates the old one → first API call after rotation returns **403**. Distinct state (§3.4, E2).
- **Steam not installed / never logged in:** no `loginusers.vdf` → manual SteamID64 paste field, or vanity URL resolution (`ResolveVanityURL`).

**Cost:** ~120 lines (VDF read, key storage, 2 endpoints). **Risk:** key-on-disk.

### 2.2 Option B — Steam OpenID sign-in

**What it needs**
- `https://steamcommunity.com/openid/login?openid.ns=http://specs.openid.net/auth/2.0&openid.mode=checkid_setup&openid.return_to=<RETURN>&openid.realm=<REALM>&openid.identity=http://specs.openid.net/auth/2.0/identifier_select&openid.claimed_id=http://specs.openid.net/auth/2.0/identifier_select`
- A `RETURN` that is `http(s)` **under `REALM`** (OpenID 2.0 realm matching; Steam rejects non-http schemes). With no backend, that means either a loopback listener (`http://127.0.0.1:<ephemeral>/openid/return`) held open for the duration of the sign-in, or a `BrowserWindow` with `will-redirect` interception that never actually serves the page.
- Then POST the returned params back with `openid.mode=check_authentication` and require `is_valid:true` in the `key:value` line response; the identity is `openid.claimed_id` = `https://steamcommunity.com/openid/id/<steamid64>`.
- **And still a Web API key**, for `GetOwnedGames`. OpenID grants identity, not data access.

**What breaks**
- **Adds nothing for library access.** Same key, same privacy wall.
- **It cannot resolve a private profile** either — the privacy check is on the data call.
- **Loopback port + realm churn:** ephemeral ports make `realm` unstable; a fixed port can collide. Firewall prompts on Windows for a listening socket are a support burden for a desktop app.
- **Embedded-browser sign-in is fragile:** Steam Guard, captcha, and Steam's own "this browser is not secure" interstitial can appear in a `BrowserWindow`; the user has no address bar to recover.
- **It solves a problem we don't have:** choosing among `loginusers.vdf` accounts is a dropdown. OpenID would let a user link an account that never logged in on this machine — the only real benefit, and it's a v2 concern (see §7.1).
- **Terms:** Steam's API terms forbid collecting Steam credentials on your site; OpenID is the compliant path — but so is "don't collect credentials at all," which is what Option A does.

**Cost:** ~250 lines + a socket + a window + redirect edge cases. **Risk:** sign-in dead-ends, no data benefit.

### 2.3 Verdict

**Ship Option A.** Option B is strictly dominated: same key requirement, same privacy wall, more failure modes, zero extra games. The one capability it adds — authenticating an account that hasn't logged in locally — is better served by a "Paste SteamID64 / profile URL" field that already exists in our error states, and `ResolveVanityURL` handles vanity URLs.

---

## 3. Settings UI

### 3.1 Placement

Inside the existing Settings modal (`openSettingsModal`, `#btn-settings`), **new `.field` block directly after `SteamGridDB` and before `On login`**. Not a new page: Settings is already a single scroll, and Steam is a data source like SGDB. A `section-label` ("STEAM") separates the two blocks; both live under it.

```
┌ Settings ─────────────────────────────────────────────── ✕ ┐
│ Palette            [midnight] [paper]                      │
│ Visual quality     [cinematic] [standard] [lite]           │
│ SteamGridDB        [••••••••••]  [Save] [Test]             │
│                                                            │
│ STEAM                                                      │
│ ┌ Local library ─────────────────────────────────────────┐ │
│ │ Installed games on this PC            [●────────] ON   │ │
│ │ Detected: 47 games · Last checked 4 min ago            │ │
│ │ [ Scan now ]                                           │ │
│ └────────────────────────────────────────────────────────┘ │
│ ┌ Steam account ────────────────────────────────────────┐  │
│ │ Full owned library (includes uninstalled games)        │ │
│ │                                        [○────────] OFF  │ │
│ │ Not connected                                          │ │
│ │ [ Connect Steam ]  Get an API key ↗                    │ │
│ └────────────────────────────────────────────────────────┘ │
│                                                            │
│ On login           ☑ Start GameVault when I log in         │
└────────────────────────────────────────────────────────────┘
```

### 3.2 Local library block — exact copy

| Element | Text |
|---|---|
| Block title | `Local library` |
| Toggle label | `Installed games on this PC` |
| Helper (under toggle, always) | `Read from Steam's own files. No account or key needed.` |
| Status line, never synced | `Not scanned yet` |
| Status line, ok | `Detected: {n} games · Last checked {relTime}` |
| Status line, Steam missing | `Steam folder not found` |
| Status line, scanning | `Scanning…` |
| Action button | `Scan now` (disabled while scanning → label `Scanning…`) |
| Sub-note when `n` changed since last scan | `{+k} new since last scan` |
| Toggle off state | status line becomes `Off — installed games won't be added`, `Scan now` disabled |
| Footer link | `Change Steam folder…` → folder picker, writes `steamRootOverride` |

### 3.3 Steam account block — states

**A. No key (default)**
```
Full owned library (includes uninstalled games)   [off]
Not connected
[ Connect Steam ]   Get an API key ↗
```
- Toggle disabled (grey) with `title="Connect a Steam account first"`.
- `Connect Steam` = primary button. `Get an API key ↗` = link to `https://steamcommunity.com/dev/apikey` via `api.openExternal`.

**B. Connect panel (expands inline; no second modal — Settings is already a modal)**
```
Steam account
┌────────────────────────────────────────────────────────┐
│ 1  Get your API key                                     │
│    steamcommunity.com/dev/apikey — any name works.      │
│    Keep this window open; you'll paste it back here.    │
│    [ Open Steam ↗ ]                                     │
│                                                         │
│ 2  Paste it                                             │
│    [ •••••••••••••••••••••• ]  [ Paste ]                │
│                                                         │
│ 3  Account                                              │
│    ◉ Foo (MostRecent)        76561198…1234              │
│    ○ Bar                     76561198…9911              │
│    ○ Enter SteamID64 manually  [                ]       │
│                                                         │
│    This is the account Steam was last logged into on    │
│    this PC. Pick another if you sync a different one.   │
│                                                         │
│    [ Cancel ]                      [ Connect and sync ]  │
└────────────────────────────────────────────────────────┘
```
- Account list is populated from `loginusers.vdf`. If exactly one account exists, step 3 collapses to a read-only line with `Change` link. If none, step 3 opens directly in manual mode.
- `Connect and sync` disabled until key length is 32 hex **and** an account is selected. Label switches to `Checking…` while validating.
- Inline error slot under the button, red `--bad`, never a toast for validation failures (toasts are for actions, not forms).

**C. Connected**
```
Steam account                              [on]
◉ Foo  ·  412 owned  ·  47 installed
Last synced 2 h ago
[ Sync now ]  [ Details ]  [ Disconnect ]
☑ Include free-to-play games
☑ Add newly installed games automatically
```
- Avatar 20 px next to the name.
- `Last synced {relTime}` → `Last synced just now` under 60 s, then `{n} min ago`, `{n} h ago`, `Yesterday`, `{date}` after 7 d.
- `Details` opens a read-only popover: SteamID64, key `…{last4}`, `game_count` returned, last error, next eligible auto-sync, "Privacy settings ↗" link, and a `Forget key` action.
- `Disconnect` → confirm: title `Disconnect Steam?`, body `Your {n} Steam games stay in the library. Automatic account sync stops until you connect again.`, actions `Cancel` / `Disconnect`. Confirmed → toast `Steam disconnected`.

**D. Connected, account sync toggle off**
Status line: `Connected as {persona} — automatic sync off`. `Sync now` stays enabled (manual always allowed).

### 3.4 Error and empty states (exhaustive)

| id | Trigger | Where it renders | Copy | Actions |
|---|---|---|---|---|
| E1 | `Connect` pressed with empty/invalid-shaped key | inline, under input | `That doesn't look like a Steam API key — it's 32 letters and numbers.` | — |
| E2 | API returns 401/403 **or** `GetPlayerSummaries` returns `players: []` for our steamid | inline error + §3.3-C status line | `Steam rejected this key. It may have been regenerated.` helper: `Steam allows one key per account — creating a new one replaces the old.` | `Get a new key ↗` · `Paste a different key` |
| E3 | HTTP 200, `game_count` missing/0, and `communityvisibilitystate != 3` | replaces the account block body with a warning card (`--warn` left border) | `Your Steam profile is private, so Steam won't share your library.` helper: `Set My profile and Game details to Public in Steam → Privacy Settings, then sync again.` | `Open Privacy Settings ↗` · `Try again` |
| E3b | HTTP 200, `game_count` 0, profile state unknown (no summaries) | same card | `Steam returned no games. Either the profile is private, or this account owns nothing.` | `Check privacy settings ↗` · `Try again` |
| E4 | Network error / DNS / timeout > 15 s | status line, `--bad` dot | `Can't reach Steam. Check your connection.` helper (if cache exists): `Showing the library from {date}.` | `Retry` |
| E5 | HTTP 429 | status line | `Steam is rate-limiting us. We'll retry in {n} min.` | `Retry now` (disabled for 60 s) |
| E6 | HTTP 5xx | status line | `Steam is having trouble. We'll try again later.` | `Retry` |
| E7 | Success, 0 new | toast, `ok` | `Steam is up to date — nothing new.` | — |
| E8 | Success, n new | toast, default | `{n} new Steam game{s} — Review` (toast has a `Review` button, 10 s) | opens review modal |
| E9 | Success, n new but all ignored/excluded | toast | `{n} new games, all in your ignore list.` | `Manage ignore list` |
| E10 | Steam not installed | local block | `Steam folder not found` helper `Install Steam, or point us at the folder.` | `Change Steam folder…` |
| E11 | No `loginusers.vdf` but key valid | connect panel step 3 | `Couldn't find a Steam login on this PC. Paste your SteamID64 or profile URL.` | input + `Look up` (calls `ResolveVanityURL`) |
| E12 | `ResolveVanityURL` no match | inline | `No Steam account matches that name.` | — |
| E13 | Sync already running | `Sync now` | button disabled → `Syncing…` | — |
| E14 | Playtime all zero, games > 10 | status line, `--text-mute` | `Games synced, but playtime is hidden by your privacy settings.` | `Privacy Settings ↗` |

Rules: one error slot per block; success clears it; toasts confirm, inline errors explain; **never** a modal for a sync error (the user is mid-settings).

---

## 4. Sync behaviour matrix

### 4.1 Triggers

| Trigger | Local scan | Account sync | UI consequence |
|---|---|---|---|
| App launch (`app.whenReady` + 3 s idle) | Always, if `localEnabled` | If `accountEnabled` **and** `now − lastAccountSyncAt > intervalHours` (default 24) | Silent. Counts in toast only if > 0 new. |
| Window `focus` | If `now − lastLocalScanAt > 30 s` **and** (`libraryfolders.vdf` mtime changed **or** last scan > 5 min) | Only if stale > 6 h **and** window has been focused > 60 s | Silent. |
| 5 min tick while focused | Yes (mtime-gated) | No | Silent. |
| Manual `Scan now` | Yes, forced | No | Toast on completion. |
| Manual `Sync now` | No | Yes, forced (300 ms min gap, 60 s after a 429) | Button state + toast + review. |
| `Connect and sync` | No | Yes, forced | Runs immediately, opens review if new. |
| Steam process exits (`steam`/`steamwebhelper` disappears) | Optional v2 hook | No | — |
| Machine sleep/resume (`powerMonitor` resume) | Yes | Only if stale > interval | Silent. |

Never: a `setInterval` that calls the API. Guard every trigger with an in-process `syncing` flag and a persisted `lastAttemptAt` (survives restart, prevents launch-loop hammering).

### 4.2 What is added automatically vs queued

| Case | Behaviour |
|---|---|
| Installed Steam game not in library | **Auto-add** (name, appid, installDir, exePath, cover, `installed: true`, `acquiredVia: owned\|shared`). Toast only if ≥ 1. |
| Installed game already in library (by `steamAppId`) | Update `installed: true`, `installDir`/`exePath` if empty or stale, `lastSeenInstalledAt`. No toast. |
| Owned, not installed, not in library | **Queue for review.** |
| Owned, in library, `installed: false` | Update hours/icon only. No toast. |
| Owned game previously removed by the user | **Skip** if its appid is in `ignoredAppIds` (set automatically when the user deletes a synced entry, à la Playnite's exclusion list). Offer the prompt at delete time: `Don't import this from Steam again` ☑. |
| Runtime/tool/redistributable appid | **Never imported, never queued** (§6.6). Counted in a `filtered` debug counter only. |
| First run, library empty | Do **not** auto-add 47 rows silently — open the import review prefilled with everything found. Protects the "empty state → intentional curation" path. |

### 4.3 Field ownership

| Field | Fill when | Overwrite? | Source of truth |
|---|---|---|---|
| `steamAppId` | always | **Never** (identity) | `appmanifest_appid` / API `appid` |
| `source` | create only | Never | `"Steam"` |
| `sourceId` | create only | Never | `steam:{appid}` |
| `name` | empty | Only if `nameSource !== 'user'` | local `.acf` name on create; API `name` for owned sync (fixes renames) |
| `nameSource` | create | — | `steam` \| `user` |
| `hours` | `hours > 0` and `hoursSource !== 'user'` | Only upward (`max`), only if `hoursSource !== 'user'` | API `playtime_forever / 60`, 1 decimal |
| `hoursSource` | — | — | `steam` \| `user` \| `session` (our tracker writes `session`) |
| `coverUrl` | empty | **Never** | `library_600x900.jpg`, fallback `header.jpg` |
| `heroUrl`/`iconUrl` | empty | Never | `library_hero.jpg` / `media.steampowered.com/…/apps/{appid}/{img_icon_url}.jpg` |
| `installDir`, `exePath` | empty, or `installed` transitioned false→true | Yes, but only when currently empty or pointing at a missing path | `appmanifest` `installdir` + `findMainExe` |
| `installed` | every scan | Yes (derived) | presence of `appmanifest_{appid}.acf` with `StateFlags & 4` |
| `status` | create | **Never** | user-owned (`Playing`/`Finished`/…) |
| `notes`, `tags`, `collections` | never | Never | user-owned |
| `wishlisted`, `added`, `id` | never | Never | app-owned |
| `acquiredVia` | create | Only when it changes owned→shared | `owned` \| `shared` \| `free` |

Implementation guard: a single `applySteamUpdate(game, incoming, { mode })` in `src/backend/steam-sync.js`; the renderer never writes these fields. Every write bumps `steam.lastSyncedAt` per game.

### 4.4 Removals, uninstalls, refunds

| Event | Detection | Action | UI |
|---|---|---|---|
| Uninstalled | `appmanifest` gone on a scan where the game previously had `installed: true` | `installed: false`; keep every field; `lastInstalledAt = now` | Tile keeps art; Play becomes `Not installed` → `Install` (launches `steam://install/{appid}`); detail rail gets a `Last installed {date}` line |
| Deleted from disk manually | same as above | same | same |
| Left family / access ended | installed appid absent from owned set **and** `acquiredVia === 'shared'` | `owned: false`, `acquiredVia: null` | Badge `Not in Steam library` (`--text-mute`); `Missing since {date}`; actions `Keep` / `Remove` / `Ignore` |
| Refunded / revoked | owned set no longer contains appid, `acquiredVia === 'owned'`, and game is not installed | `owned: false`, `missingSince` | Same badge, non-destructive |
| Delisted | still owned, no store page | Stay in library, art falls back to cached file, no badge | Nothing |
| **Never** | — | Delete a user-created or user-edited entry | — |

Explicit rule, stated in the code comment and the confirm dialog: **sync may only ever set booleans and fill empty fields.**

---

## 5. Review surface for new games

### 5.1 Recommendation: **the import dialog in "Steam · New games" mode**, opened from a toast.

Why this and not the alternatives:

1. **Volume.** An owned library is 200–3000 rows; a 3–20 row delta is typical but a first connect is the whole library. A toast can show a number and one action; a banner can show a number and two. Neither can host a 300-row multi-select with search. The import modal already does exactly this job, with `import-list`, `import-row`, `import-chip`, `Select all`, filter input, and a typed footer action.
2. **Consistency.** The user has already met "Review games" once at onboarding; a second, differently shaped review surface for the same operation (finding games and adding them) is a second thing to learn.
3. **It ends in a decision, not a notification.** The modal's footer is `Import {n} games` — a commit. A banner's `Review` button just moves you somewhere else; the banner then needs a dismiss state, a re-show rule, and a place to live in a layout that has three rows of chrome already.
4. **The alternative — auto-add + "undo" toast** — is the pattern that turns a curated vault into a Steam mirror, and it makes "not installed" rows appear without consent.

Banner is rejected as the primary: it is persistent chrome for a transient event, and our top bar is already dense (filter row, counts, sort). Toast alone is rejected: no multi-select, no search, 8 s lifetime, and mobile-style toasts are the wrong weight for a 300-item decision.

**The toast is the notification; the modal is the decision.** Both, with the toast as a pointer only.

### 5.2 Mechanics

- Toast: `{n} new Steam games — Review`, 10 s, one action. Clicking the toast body ≠ clicking `Review` (body dismisses).
- Opening the import modal directly in `steam-new` mode: source nav pre-selected on `Steam`, `step="review"` (skips the sources list), `filter` empty, all rows checked **except** those already in library, footer `Import {n} games`.
- Header sub-line: `{n} new · {m} already in library · {k} ignored`.
- Row layout reuses `import-row`:
  - `<b>{name}</b>` + `<small>Owned · {h} h</small>` (or `Installed · {h} h` when the same appid is also installed but not yet in the library — rare, but correct).
  - Right chip: `NEW` for new, `IN LIBRARY` for matched (checkbox disabled, row `is-existing`), `SHARED` for `acquiredVia === 'shared'`.
  - Rows whose name matches a manual entry by fuzzy title get chip `POSSIBLE DUPLICATE` and a `Link to “{existing}”` inline action instead of a checkbox.
- If the modal is dismissed: nothing is imported, and the same toast does not reappear for the same appid set. Persist `pendingReview: {appIds, firstSeenAt}`; the Steam settings block shows `{n} new games waiting — Review` until resolved. This is the only "banner-like" element, and it lives in Settings, not in chrome.
- Second entry point: library filter chip `New from Steam {n}` (only while `pendingReview` non-empty).

---

## 5.3 Where this lands in the codebase

| File | Change |
|---|---|
| `src/backend/steam-sync.js` *(new)* | `readLoginUsers()`, `listInstalled()` (wraps `scanner.detectSteamGames`), `fetchOwned(steamid)`, `diff()`, `applySteamUpdate()`, `syncLocal()`, `syncAccount()`, `filterAppIds()` |
| `src/backend/steam-store.js` *(new)* | `steam-owned.json` cache (read/write/namespace by steamid), `secrets.json` via `safeStorage` |
| `src/backend/data.js` | `loadConfig` defaults gain `steamSync` block; add `secrets` helpers; add `pendingReview` to config |
| `main.js` | IPC: `steam:sync-local`, `steam:sync-account`, `steam:key:set`, `steam:key:clear`, `steam:key:test`, `steam:accounts`, `steam:status`, `steam:disconnect`, plus `steam:sync-result` push event |
| `preload.js` | mirror them 1:1 under `api.steam*` (naming matches existing `sgdbKeyGet/Set/Test`) |
| `src/app.js` | Settings: new `.field` block after SGDB; `openImportModal()` gains `{ mode: 'steam-new', candidates }`; toast helper reused |
| `src/style.css` | `.steam-block`, `.steam-status`, `.steam-error`, `.toast .toast-action`, `.badge-shared`, `.badge-missing` — all built from existing tokens (`--ok`, `--warn`, `--bad`, `--surface-2`, `--line`) |

---

## 6. Data & API details

### 6.1 Endpoints

**GetOwnedGames** — one call, whole library.
```
GET https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/
  ?key={STEAM_API_KEY}
  &steamid={STEAMID64}
  &include_appinfo=1
  &include_played_free_games=1
  &include_free_sub=0
  &skip_unvetted_apps=0
  &l=english
  &format=json
```
Params (all documented on `IPlayerService`):
| Param | Value | Note |
|---|---|---|
| `include_appinfo` | `1` | Without it you get bare appids — no names, no icon hashes. Non-negotiable. |
| `include_played_free_games` | `1` | Played F2P titles (CS2, Dota, Warframe) are real library entries. |
| `include_free_sub` | `0` | Free-license subs and demos — noise. |
| `skip_unvetted_apps` | `0` | We filter by policy, not by region vetting. |
| `l` | `english` | Name language. Re-sync when the app language changes if you ever localize. |
| `appids_filter` | *(omit)* | Present in the API; usable in v2 for "re-check these 3 appids" without a full fetch. |

Response:
```json
{ "response": {
    "game_count": 412,
    "games": [
      { "appid": 620, "name": "Portal 2", "playtime_forever": 1234,
        "playtime_2weeks": 0, "img_icon_url": "cfa5…", "has_community_visible_stats": true,
        "rtime_last_played": 1699999999, "playtime_windows_forever": 1234,
        "playtime_mac_forever": 0, "playtime_linux_forever": 0,
        "content_descriptorids": [2,5] }
    ] } }
```
- `playtime_forever` is **minutes**; `hours = round(min/60 * 10)/10`.
- `img_icon_url` is a bare hash: `https://media.steampowered.com/steamcommunity/public/images/apps/{appid}/{img_icon_url}.jpg`.
- Private profile → `{"response":{}}` (HTTP 200). Treat as E3, never as "0 games owned".
- `game_count` can disagree with `games.length` for huge libraries (paging was removed, but trust `games.length`).

**GetPlayerSummaries** — identity + privacy signal (one call per connect, and on each account sync if `≤1/day`).
```
GET https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/?key={KEY}&steamids={STEAMID64}&format=json
```
Fields used: `steamid`, `personaname`, `avatarfull`, `communityvisibilitystate` (1 private, 2 friend-only, 3 public), `profilestate`, `timecreated`, `lastlogoff`. Batch max 100 steamids.

**ResolveVanityURL** — only for the manual "profile URL" path (E11/E12).
```
GET https://api.steampowered.com/ISteamUser/ResolveVanityURL/v1/?key={KEY}&vanityurl={name}&url_type=1&format=json
```
`{"response":{"steamid":"7656…","success":1}}` on hit, `{"response":{"success":42,"message":"No match"}}` on miss. `url_type=1` = individual profile (2 = group, 3 = official game group — never use those).

### 6.2 Rate limits & caching

| Concern | Rule |
|---|---|
| Daily quota | 100 000 calls/key (soft). We spend **2 calls per sync**. |
| Per-second | Undocumented per-IP burst; 429 then 403 on abuse. Enforce **≤ 1 request/second** globally (a single serial queue) and **no concurrent syncs**. |
| Backoff | 429 → wait `min(2^n × 30 s, 15 min)` with jitter, max 3 attempts; 403 → do not retry, surface E2; 5xx → 3 attempts, 2/4/8 s. |
| Timeout | 15 s connect + 30 s total; abort via `AbortController`. `User-Agent: GameVault/{version} (+local library sync)`. |
| Cache TTL | Owned list: **24 h** default (`intervalHours`, choices 6/12/24/72). Installed state: never cached — derived from disk each scan. |
| Manual override | Always allowed, min 300 ms after the last attempt; 60 s lockout after a 429. |
| Conditional requests | Steam sends no `ETag`/`Last-Modified` on these endpoints — **do not** pretend to do conditional GET. Cache by timestamp only. |
| Failure caching | Keep the last good `steam-owned.json` indefinitely and mark it `stale: true`. Offline users keep a full library. |

### 6.3 What we store

`%APPDATA%/GameVault/` on Windows, `~/.config/GameVault/` on Linux (Electron `app.getPath('userData')`).

**`config.json` → `steamSync`** (no secrets):
```json
{ "localEnabled": true, "accountEnabled": false,
  "steamId64": null, "personaName": null, "avatarUrl": null,
  "intervalHours": 24, "onLaunch": true, "onFocus": true,
  "includeFree": true, "autoAddInstalled": true,
  "lastLocalScanAt": null, "lastAccountSyncAt": null, "lastAttemptAt": null,
  "lastError": null, "lastResult": { "added": 0, "updated": 0, "owned": 0 },
  "ignoredAppIds": [], "blockedAppIds": [], "steamRootOverride": null,
  "pendingReview": { "appIds": [], "firstSeenAt": null } }
```

**`secrets.json`** (mode 0600):
```json
{ "steamApiKey": "<base64 of safeStorage.encryptString(key)>" }
```
`safeStorage.isEncryptionAvailable()` false (Linux without a keyring) → still write, but prefix `plain:` and show one-time hint in `Details`: `Key stored unencrypted — no system keyring detected.` Never log the value; redact any URL containing `key=` before it reaches `console` or an error string.

**`steam-owned.json`** — the cache that makes offline work:
```json
{ "steamId64": "76561198…", "fetchedAt": 1761000000000, "gameCount": 412,
  "source": "api",
  "games": { "620": { "name": "Portal 2", "minutes": 1234, "icon": "cfa5…",
                      "lastPlayed": 1699999999, "type": "game" } } }
```
Keep **one file per steamid** (`steam-owned-{steamid}.json`) so switching accounts never mixes libraries — this is the multiple-account fix at the storage layer (§7.1).

**`games.json`** per-game additions (existing shape kept):
```json
{ "steamAppId": "620", "installed": true,
  "acquiredVia": "owned",
  "nameSource": "steam", "hoursSource": "steam",
  "steam": { "owned": true, "lastSyncedAt": 1761000000000,
             "iconUrl": "https://media.steampowered.com/…/620/cfa5….jpg",
             "minutes": 1234, "missingSince": null } }
```
`owned`/`installed` are *derived* every sync; `missingSince` is the only sticky bit.

---

## 7. Edge cases

### 7.1 Multiple Steam accounts on one machine
`loginusers.vdf` lists every account that has authenticated here, each with `MostRecent` and `Timestamp`. We show them all in connect step 3 with persona names (from `PersonaName` in the same file — no API call needed). Consequences:
- Owned cache is namespaced per steamid, so `A` and `B` never overwrite each other.
- Changing the connected account does **not** re-key existing library rows. Rows keep `steamAppId`; a game owned by A and not by B simply goes `owned: false` on the next sync and gets the `Not in Steam library` badge — **no deletion**. This is the correct behaviour for a shared PC.
- If two different accounts both own appid 620 → still one row (appid is the identity). `acquiredVia`, hours = max across accounts we've seen? **No** — hours come from the currently connected account only; store `hoursByAccount` is out of scope. Show a `Details` line: `Hours from {persona}`.
- Switching accounts mid-session is guarded: sync request captures the steamid at start; if the setting changed while in flight, discard the result.

### 7.2 Shared library / Steam Families
- `GetOwnedGames` returns **only what the account owns**. Family-shared titles are absent — this is a documented, long-standing gap (the community maintains a separate Playnite plugin that fans out `GetOwnedGames` across each family member's SteamID64 precisely because the API won't do it).
- Installed shared games still have local `appmanifest` files, so they land through the local half. Ownership unknown at scan time → `acquiredVia: 'shared'` **only after** an owned sync proves the appid is absent from the owned set; before the first owned sync, use `acquiredVia: 'unknown'` and no badge.
- Badge copy: `Shared` (`--text-mute`, small). Never call a shared game "owned".
- No family endpoint is used in v1. Family aggregation (multiple SteamID64s → union) is a v2 feature, and it is the same code path as multi-account, so the data model above already supports it.
- If the user leaves the family: next sync sees appid still installed but not owned → stays `installed: true`, `acquiredVia: 'shared'`, badge stays. If Steam later removes the appmanifest → `installed: false` + `Not in Steam library`.

### 7.3 Free games and free weekends
- `include_played_free_games=1` brings in played F2P titles. They are `acquiredVia: 'free'` when the appid has `is_free`-style evidence — we don't have a public per-app flag in this response, so classify as `owned` and expose the `Include free-to-play games` toggle (default **on**) so the user can exclude them at import time via the review chips (`FREE` chip when the title is in Steam's free list — resolved lazily through the existing `steam:details` IPC, which already calls `appdetails`).
- Free weekend / temporary licenses: they appear while active and **disappear** afterwards. Because removals are non-destructive, the row stays with `Not in Steam library` — acceptable, and better than deleting a game the user may have earned progress in. Copy on the badge tooltip: `Steam no longer lists this game on your account.`
- Demos/playtests: `include_free_sub=0` keeps most out; the review modal's `Import` list is the final gate.

### 7.4 Tools, runtimes, redistributables — the never-import list
Two independent filters, both required.

**(a) Appid blocklist** (hard-coded, user-extendable via `blockedAppIds`; names resolved at runtime — never hard-code display names):
```
228980  Steamworks Common Redistributables      (already skipped in scanner.js:190)
1070560 Steam Linux Runtime 1.0 (scout)
1391110 Steam Linux Runtime 2.0 (soldier)
1628350 Steam Linux Runtime 3.0 (sniper)
1493710 Proton Experimental
2348590 Proton Hotfix
```
> The five runtime ids above are stable and appear in Valve's own runtime naming. Valve also ships Proton/runtime companions whose ids have been renumbered between releases (historically 1161040, 1826330, 2180100, 961940 territory). Do **not** trust an id you cannot name: resolve the id's name from the local `.acf` or `appdetails`, and if that name matches the pattern list in (b), skip it. Add the resolved `appid → name` pair to a checked-in fixture so the test suite pins the mapping.


**(b) Name patterns** (case-insensitive, applied to `.acf` `name` and API `name`):
`/^steam linux runtime/i`, `/\bproton( experimental| hotfix| \d)/i`, `/steamworks common redistributables/i`, `/steamvr$/i` *(configurable — SteamVR is typed as a game by the store API, but nobody wants it in a library)*, `/dedicated server$/i`, `/^steam ?(client|audio|link)/i`, `/\bsdk\b/i`, `/\b(redistributable|runtime|driver|benchmark)\b/i` → the last one is **advisory only** (route to review with a `TOOL?` chip) because "Runtime" appears in real game names.

**(c) Type check for unknowns:** before importing an appid we've never seen and whose name doesn't classify, call `https://store.steampowered.com/api/appdetails?appids={id}&filters=basic` (no key, ~1 req/s, cache forever) and require `data.type === "game"`. `tool`, `software`, `video`, `dlc`, `demo`, `advertising` → skip. This runs at most a handful of times per sync and is cached in `steam-owned.json` as `type`.

Stats: count filtered entries in `lastResult.filtered` and show them only in `Details` (`{k} tools and runtimes skipped`). Never surface a "we skipped 9 items" toast.

### 7.5 Delisted games
Owned, no store page. `GetOwnedGames` still returns the name, so the row is correct. Artwork may 404 — the existing `cacheImage` failure path returns the URL unchanged, so add: on `library_600x900.jpg` failure, try `header.jpg`, then `capsule_231x87.jpg`, then the icon URL, then leave `coverUrl` empty and let the placeholder render. Do not delete or hide the row. Badge: none (delisting is not the user's problem).

### 7.6 Renamed games
Steam renames apps (e.g. "Company of Heroes 2" → "Company of Heroes 2 (2013)"; F2P rebrands). Rule: if `nameSource !== 'user'` and API `name` differs, update `name` and store `formerNames: [...]` (cap 3). If the user renamed it (`nameSource === 'user'`), never touch it; show the current Steam name in `Details` as `Steam calls this “{name}”`. Local `.acf` names can lag the store by months — prefer the API name on account sync, prefer the `.acf` name on local-only (never trigger a network call just to rename).

### 7.7 Offline
- Every sync path checks cache first and renders immediately: installed from disk, owned from `steam-owned-{steamid}.json`.
- Status line while offline: `Offline — library from {date}` (`--text-mute`), no red, no error toast at launch.
- A failed auto-sync at launch must not produce a toast. Only manual actions toast.
- Queued intent: set `pendingSync: true`; on next successful launch or focus, run it once and clear.
- Never let an offline state write `owned: false` — **only a successful API response may demote ownership.** This single rule prevents the worst bug in this feature (someone opens the app on a plane and their library is marked missing).

### 7.8 Other traps, pre-answered
- **Clock skew / `rtime_last_played` in the future** → clamp to now.
- **`playtime_forever` decreases** (family sharing played time, or Steam support reset) → `hours` takes `max(existing, incoming)` unless `hoursSource === 'user'`; never let hours drop on sync.
- **`games.json` hand-edited / corrupt** → `loadGames()` already returns `[]` on parse failure; add a `.bak` write before every save that touches sync (the import path already rewrites the whole file).
- **Case-insensitive duplicate names** (e.g. "DOOM" vs "Doom") → never dedupe on name alone for Steam entries; appid only.
- **Lutris-wrapped Steam games** → a Lutris entry with the same exe/installDir as a Steam entry is a duplicate. Match on `steamAppId` first, then `exePath` (case-insensitive), then exact normalized name; only then offer `Link to…` in review.
- **Flatpak Steam path differs** (`~/.var/app/com.valvesoftware.Steam/...`) — already partially handled; `loginusers.vdf` lookup must include it.
- **Windows library on another drive** — `libraryfolders.vdf` already parsed; ensure `config/loginusers.vdf` is read from the *root* Steam install (where `steam.exe` lives), not from a library folder.
- **Two Steam installs (stable + beta)** — prefer the root whose `config/loginusers.vdf` has the newest `Timestamp`.

---

## 8. Implementation order

1. **`readLoginUsers()` + account picker** (no network). Ship value: users see which Steam account is on this machine.
2. **`steam-store.js` + key storage** (`safeStorage`, `secrets.json`, `hasKey`/`last4` IPC). Test: never expose the raw key in a renderer-visible payload.
3. **`syncLocal()`** — wrap `detectSteamGames`, diff by `steamAppId`, `applySteamUpdate`, uninstall demotion, blocklist. No UI yet beyond status line.
4. **Settings block** (local + account, all states in §3, all error copy in §3.4).
5. **`fetchOwned()` + `diff()` + cache** — owned queue only; no auto-add.
6. **Import modal `steam-new` mode** + toast + `pendingReview` persistence.
7. **Scheduling** (§4.1) behind two flags, with `lastAttemptAt` guard.
8. **Edge passes**: filters (§7.4), offline (§7.7), multi-account (§7.1).

Tests (node, alongside `tests/importers.test.js`):
- VDF parser: 0, 1, 3 accounts; `MostRecent` on the middle entry; missing `Timestamp`.
- Diff: new/installed/owned/ignored/blocked × added/updated counts.
- `applySteamUpdate`: user-renamed + user-hours entry is never overwritten; empty fields are filled.
- Offline: failed fetch never demotes `owned`.
- Filter: each blocklisted appid and each name pattern; a real game containing "Runtime".
- Cache: 24 h TTL, forced sync bypass, 429 lockout.

## 9. Acceptance criteria

- [ ] With no key and no Steam installed, Settings shows both blocks in their off/disabled states and no console errors.
- [ ] Installing a Steam game, then focusing the window, adds exactly one row within 30 s and no toast appears if the game already existed.
- [ ] Connecting with a public profile pulls `game_count` games; zero are auto-added; the review modal lists them with `NEW` chips and `Import {n} games` imports exactly the checked set.
- [ ] With `Game details` private, the app shows E3 copy and a working link to privacy settings — never "0 games".
- [ ] Disconnecting, reconnecting, and syncing twice produces no duplicate rows and no lost notes/status/tags.
- [ ] Uninstalling a game flips it to `installed: false`, keeps art and hours, and offers `Install`.
- [ ] Airplane mode at launch: library renders from cache, status says `Offline — library from {date}`, no ownership flags change, no error toast.
- [ ] `Steam Linux Runtime 3.0 (sniper)`, `Proton Experimental`, and `Steamworks Common Redistributables` never appear as library rows even when fully installed.
- [ ] The raw API key never appears in `config.json`, in any IPC payload observed from the renderer, or in any log line.

## 10. Out of scope (v2)

OpenID sign-in (see §2.3), family-library union across SteamID64s, per-app `appids_filter` incremental refresh, wishlist import, achievement import, `steam://` deep-link install button beyond the existing launch path, and any write-back to Steam.

---

## Sources

- Steam Web API: key requirement, bearer-key model, OpenID provider and `claimed_id` format — https://steamcommunity.com/dev
- `IPlayerService/GetOwnedGames` parameters (`include_appinfo`, `include_played_free_games`, `include_free_sub`, `skip_unvetted_apps`, `language`, `appids_filter`) — https://partner.steamgames.com/doc/webapi/IPlayerService and the generated request type at https://docs.rs/steamroom/latest/steamroom/generated/struct.CPlayerGetOwnedGamesRequest.html
- `ISteamUser/GetPlayerSummaries` request/response fields (`communityvisibilitystate`, `personaname`, `avatarfull`) — https://steamwebapi.azurewebsites.net/
- Rate limits: 100 000 calls/day per key, per-IP burst returning 429/403, 100 steamids per `GetPlayerSummaries`, one active key per account — https://steamcommunity.com/dev/apiterms (via https://raw.githubusercontent.com/api-evangelist/steam/refs/heads/main/rate-limits/steam-rate-limits.yml)
- Playnite: extension settings path, `Authenticate` / `Requires authentication` pattern, `Update Game Library → Update All` — https://api.playnite.link/docs/manual/features/extensionsSupport/installingExtensions.html · Steam privacy checklist + `Private account` / `Get API Key` / `API Key` fields — https://raw.githubusercontent.com/Jeshibu/PlayniteExtensionsFeatures/refs/heads/main/faq.md
- Playnite: never auto-remove imported games; `Import exclusion list` — https://codeberg.org/Playnite/Docs/raw/branch/main/docs/manual/library/games/faq.md · https://codeberg.org/Playnite/Docs/raw/branch/main/docs/manual/library/games/removingGames.md
- Playnite: `IsInstalled` and per-plugin `GameId` as the owned/installed contract — https://codeberg.org/Playnite/Docs/raw/branch/main/docs/tutorials/extensions/libraryPlugins.md
- GOG Galaxy Integrations API: built-in-browser multistep auth, "importing owned and detecting installed games", `authenticate(stored_credentials)`, `update_local_game_status()` — https://galaxy-integrations-python-api.readthedocs.io/en/latest/overview.html
- GOG Galaxy Steam integration: 2FA inside the auth window, "connect ≠ sync finished", Retry — https://github.com/GOG-Orion/galaxy-integration-steam
- Heroic: logins limited to Epic/GOG/Amazon; Steam only via installed-game import — https://raw.githubusercontent.com/Heroic-Games-Launcher/HeroicGamesLauncher/main/README.md
- Steam family libraries are not in `GetOwnedGames` (community plugin that fans out per SteamID64 exists specifically because of this) — https://github.com/Antaneyes/SteamFamilyLibrary
