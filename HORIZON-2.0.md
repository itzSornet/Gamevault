# GameVault 2.0 — Horizon

**One line:** the launcher that knows what you own, what you're actually playing, and never asks you for a key.

Status today: `2.0.0-experimental.1`, 77 tests green, import v4 modules landed, tracker still trusts one exe for two jobs, shipped as an experimental build only.

---

## 1. Pillars (what 2.0 is judged on)

1. **Unify** — one library from Steam, Epic, GOG, Xbox, Hydra, Lutris, Heroic, Bottles, itch, desktop entries, AppImages, Wine prefixes, Minecraft launchers, folders.
2. **Truth** — playtime follows the *game*, not the wrapper; a launcher can be a launcher without polluting hours.
3. **Quiet** — opaque surfaces, hairline rules, one accent, motion under 240 ms. No glass, no neon, no dashboard cosplay.
4. **Offline-first** — every core action works with the network off. AI, art and store data are additive, never required.

Anything that doesn't serve these four is cut from 2.0.

---

## 2. What ships in 2.0.0 (feature freeze list)

### Must ship

| # | Feature | Acceptance |
|---|---|---|
| 1 | **Local inventory** — Windows registry + Start Menu + AppX + `shortcuts.vdf`; Linux `.desktop` + Flatpak + AppImage + Wine + RetroArch + Minecraft launchers | Scan returns only launchable games; launchers/tools filtered; source + confidence on every row |
| 2 | **Launcher adapters** — Steam, Hydra, Lutris, Heroic, itch, Bottles, Epic/GOG/Xbox/Battle.net/EA/Ubisoft (Win) | Each source lists found/count before scanning; errors are per-source, never fatal |
| 3 | **Tracker split** — `launch` path vs `track` process vs launcher-only | Wrapper exits → session continues; launcher-only never counts; retry after failure works |
| 4 | **Import v4** — three options (launcher / account / scan), review step, dedupe, update-art rows | No inline game lists; nothing imported before Continue; per-source select-all |
| 5 | **Steam connect** — session-based owned library + playtime, wishlist import (best-effort) | No API key required; key remains fallback only |
| 6 | **Detail "Marquee"** — hero, poster, status, sessions, notes-free, mark-finished | No layout break 900→1600 px; one scroll surface |
| 7 | **Themes** — Midnight + Paper, both token-complete | Every surface, chart, modal and state passes contrast in both |
| 8 | **Command panel** — Ctrl K, fuzzy, actions, recents | Opens < 80 ms, keyboard-only usable |
| 9 | **Backup / restore** — games.json + media, versioned | Restore on a clean profile reproduces the library |
| 10 | **Auto-update** — GitHub releases; NSIS + AppImage self-update, pacman hand-off | Update check, skip, snooze, release notes all wired |
| 11 | **Migration** — 1.x data → 2.0 (statusModel 3, media paths, settings) | One-way, idempotent, never loses hours or sessions |
| 12 | **AI assist (optional)** — built-in provider, no BYOK in experimental | Off by default; every answer is a suggestion; offline path never blocks |

### Nice to ship (cut if the gates slip)

- Lazy achievement badge on detail (1 request per game, cached).
- "Detect" button for track exe.
- Playnite library adapter (SQLite).
- Emulator ROM libraries on Windows.
- Friends presence (read-only, no UI beyond "friends who own this").

### Explicit non-goals for 2.0

Cloud sync · social feed · store/checkout · overlay · controller-first UI · ROM management · multi-user profiles · plugin SDK.

---

## 3. Milestones and gates

> Weeks are relative to M0 start, not calendar promises. A milestone that misses its gate does not get a date extension — scope is cut.

### M0 — Foundation (W0, mostly done)
Experimental shell, design tokens, detail page, import wizard, test harness, headless screenshots.
**Gate:** `node --test` green; every screen captured headlessly.

### M1 — Truth (W1–W2)
Tracker split, launch failure recovery, session grace, process-tree adoption, `track.none`, migration of existing games.
**Gate:** three fixtures pass end-to-end — wrapper→game, launcher-only, direct exe — with correct hours and one session each. No stuck "Launching…" state within 10 s of any failure.

### M2 — Reach (W3–W4)
Windows inventory live-tested in the Win11 VM; Linux inventory on this machine; Playnite adapter if SQLite decision lands; import review polish; Steam wishlist.
**Gate:** on a VM with Steam + Epic + a portable game + a wrapper game, ≥ 95 % of installed titles found, < 5 % junk rows, zero false "playing" sessions from launchers.

### M3 — Polish (W5–W7)
Visual pass across every screen at 900/1200/1600 px, both themes; empty/error/loading states; keyboard + focus; reduced motion; performance budgets; accessibility labels.
**Gate:** screenshot review of 12 states with no overflow/clipping; cold start < 2.5 s; library scroll at 43 titles ≥ 55 fps; axe-style pass on dialogs.

### M4 — Launch (W8–W10)
Packaging, signing, updater channels, migration rehearsal, site copy, screenshots, trailer, release notes, rollback plan.
**Gate:** clean-machine install → import → play → update works on Windows and Linux; uninstall leaves no orphan processes; release artifacts reproducible from the tag.

---

## 4. Release engineering

### Artifacts

| Platform | Format | Notes |
|---|---|---|
| Windows | NSIS x64 (per-user, changeable dir) | signed; auto-update |
| Windows | portable zip | no install; update-aware only |
| Linux | AppImage x64 | self-update via electron-updater |
| Linux | Flatpak (Flathub later) | sandboxed; no self-update |
| Linux | AUR `gamevault-experimental` | pacman hand-off message (already coded) |

### Channels

- `experimental` — current line, prerelease, `allowPrerelease` true.
- `stable` — promoted only when M4 gates pass; `allowPrerelease` false.
- Versioning: `2.0.0-alpha.N` → `2.0.0-beta.N` → `2.0.0-rc.N` → `2.0.0`.

### Migration

- Read 1.x `games.json`, map `statusModel` (Dropped→Playing, Want→wishlisted, null→Playing), keep `hours` and `sessions`, rewrite media paths, back up the original file next to it as `games.v1.backup.json`.
- Idempotent: running twice changes nothing.
- Rollback: 1.x ignores unknown fields, so the old build still opens the migrated file.

### Quality budgets

- Cold start ≤ 2.5 s; import scan ≤ 6 s for 500 candidates.
- Renderer memory ≤ 220 MB with 1000 games; no listener growth per detail render.
- Every IPC that touches disk validates paths (already started with media).
- Zero unhandled rejections in a 30-minute soak.

---

## 5. Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Windows inventory false positives (registry junk) | high | name/string filters, source+confidence, review select-all |
| Process-tree adoption misses fast wrappers | medium | 700 ms fast poll for 20 s, grace period, name fallback |
| Steam scraping breaks (React pages) | high | DOM parser isolated; API-key fallback; feature flag |
| Embedded AI key abused | medium | proxy + per-install quota; AI off by default |
| Linux packaging (Flatpak sandbox) blocks scanning | medium | Flatpak build offered as "library only" mode |
| Disk pressure during builds/captures | recurring | artifacts to `dist/`, screenshots to `screenshots/`, headless harness checks free space |

---

## 6. Success metrics (first 30 days after 2.0.0)

- Import completion: ≥ 85 % of users who open import finish it.
- Tracker accuracy: < 2 % of sessions with wrong duration (self-reported + logs).
- Crash-free sessions ≥ 99 %.
- Time to first game: < 90 s from first launch.
- Support load: < 5 issues/week about "can't import / time not counting".

---

## 7. Launch kit

- 6 screenshots (1600×1000): Home shelf, Grid, Detail, Import options, Import review, Command panel.
- 30 s trailer beats: empty vault → import → 43 titles fill the shelf → play → session timer → detail marquee → "no key, no cloud, no noise".
- Store copy: one paragraph + five bullets (unify, truth, offline, quiet, portable).
- Release notes: what changed, what migrated, what broke intentionally (status model), known gaps.

---

## 8. Open decisions (need a call before M2)

1. Playnite adapter: vendor SQLite (native dep) or shell out to `sqlite3` when present?
2. AI provider: embedded free-tier proxy vs local Laya download — or both behind one interface?
3. Flatpak: ship at 2.0 or 2.1 (sandbox changes scanning)?
4. Official version: does 1.x get the tracker split backported, or is 2.0 the only path?
