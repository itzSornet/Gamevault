# Import v4 — plan

## Principles

- **Add the launcher, not its runtime.** Adapters are pure JS in `src/backend/sources/`. No JRE, no Rust toolchain, no bundling of Minecraft/Java. Horizon/Prism etc. are just sources + optional instance scan.
- Every candidate: `{ name, source, sourceId, exePath, installDir, confidence, iconPath, launcher }`.
- Coverage target: **99% of launcher-managed games on Windows**, **95–99% on Linux**. Portable/emulated is best-effort by design.
- No silent noise: filter runtimes, redistributables, updaters, drivers, SDKs, anti-cheat.

## Windows inventory (new source: `windows-inventory`)

1. **Uninstall registry** — `HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall`, `WOW6432Node`, `HKCU`. Fields: DisplayName, DisplayIcon, InstallLocation, UninstallString, Publisher, EstimatedSize, ReleaseType, SystemComponent. Parse `reg query` output. Filters: SystemComponent=1, KB updates, `vcredist|\.NET|DirectX|PhysX|Launcher|Redistributable|SDK|Driver`.
2. **Start Menu** — `%ProgramData%` and `%AppData%` Start Menu `Programs/**/*.lnk`; resolve targets via PowerShell `WScript.Shell`; keep `.exe` only, drop uninstall/update/crash handlers.
3. **Xbox / Microsoft Store** — `Get-AppxPackage -PackageTypeFilter Main` → `shell:AppsFolder\<PackageFamilyName>!App`; filter known game publishers/names.
4. **Steam shortcuts.vdf** — binary VDF parser (`\x00shortcuts\x00`), read `AppName`, `Exe`, `StartDir`, `icon`. Also useful on Linux.
5. **Known dirs + engine fingerprints** — `C:\Games`, `D:\Games`, `Program Files*`; marker files `UnityPlayer.dll`, `*_Data/`, `*-Win64-Shipping.exe`, `Godot*.exe`, `game.ini`. Version-info ProductName via PowerShell `[Diagnostics.FileVersionInfo]`.
6. **Playnite DB** (phase 2) — `%AppData%\Playnite\library\*.db` SQLite; needs one sqlite dependency. Biggest single win.

Dedupe: normalized exe path + fuzzy name (Jaro-Winkler ≥ 0.88).

## Linux inventory (new source: `linux-desktop`)

1. **`.desktop` scan** — `/usr/share/applications`, `/usr/local/share/applications`, `~/.local/share/applications`, Flatpak exports (`~/.local/share/flatpak/exports/share/applications`, `/var/lib/flatpak/exports/...`). Require `Categories` containing `Game`; parse `Exec` (strip `%f %U`, `env VAR=`, `flatpak run <id>`), `Name`, `Icon`, `TryExec`.
2. **Flatpak** — exports cover it; launch id via `flatpak run`.
3. **AppImage scan** — `~/Applications`, `~/Games`, `~/Downloads`, `/opt`; ELF magic + AppImage type-2 magic (`0x41 0x49 0x02` at offset 8); name from filename.
4. **Wine prefixes** — `~/.wine`, `~/.local/share/wineprefixes`, `~/.var/app/*/data/wine`, Bottles; scan `drive_c` depth ≤ 4 for `.exe`, skip `windows/`, `Program Files/Common Files`, uninstallers; name from exe, launcher = prefix path.
5. **Emulator libraries** — RetroArch `~/.config/retroarch/playlists/*.lpl`, EmulationStation `gamelist.xml`; each ROM as a candidate (source = system name).
6. **Steam shortcuts.vdf** — shared parser.
7. **Minecraft launchers family** — Prism (`instances/*/instance.cfg`), Horizon (`settings` → `minecraft_dir`, `versions/`), MultiMC, ATLauncher, GDLauncher, Modrinth App. One candidate per instance; `launcher` = launcher id + launch command hint.

## UI

- Picker gains groups: **This PC** (windows-inventory / linux-desktop), **Launchers**, **Minecraft**.
- Review: source label + confidence chip; select-all per source; count per source; existing games marked.
- Nothing imports until confirmed (already true).

## Verification

- Unit tests for every parser with inline fixtures (`node --test`).
- **Headless screenshots**: `xvfb-run -a electron . --shot …` — never renders on the user's display.
- Critic pass on this plan before/after implementation.

## Non-goals for v4.0

- Deep full-disk scan (phase 5).
- Playnite DB before a sqlite strategy is chosen.
- Emulator ROMs on Windows (phase 3).
