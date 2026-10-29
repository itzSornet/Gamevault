# Flutter for GameVault 2.0 — research

**Verdict:** Flutter is the best fit for a UI-first rewrite: one codebase for Windows/Linux/macOS, GPU rendering, real springs, and glass that behaves the same on every platform. It is not a free win — desktop OS integration and auto-update are weaker than Electron, and `BackdropFilter` is still expensive if you blur large moving areas.

## 1. What Flutter actually is

- **Dart** app compiled AOT to native code.
- Draws its own widget tree with **Skia** (legacy) or **Impeller** (new GPU renderer) — no DOM, no browser.
- **Embedders** per OS: Win32 (Windows), GTK (Linux), Cocoa (macOS), plus mobile.
- Animation runs on the raster/UI threads with a vsync-driven scheduler; `AnimatedBuilder`, `Tween`, physics simulations (`SpringSimulation`) are built in.

## 2. Desktop status in 2026

| Area | State |
|---|---|
| Windows | stable; Impeller rollout in progress, Skia fallback |
| Linux | stable via GTK; **Impeller Vulkan backend still landing** ([PR #189584](https://github.com/flutter/flutter/pull/189584)) |
| macOS | stable; Impeller default |
| Packaging | third-party (`flutter_distributor`, `msix`, AppImage/Flatpak recipes) |
| Auto-update | no first-party; `auto_updater`, Sparkle/WinSparkle, or custom |

## 3. Glass — what works and what costs

**Works:** `BackdropFilter(filter: ImageFilter.blur(...))` blurs the app framebuffer behind a widget, on every platform. That gives consistent in-app glass without depending on the OS compositor.

**Costs:** live blur is still raster work. A filed Flutter issue reports **Windows Impeller `BackdropFilter` has significantly higher raster cost than Skia, and bounded blur loses most grouping benefit** ([flutter#191207](https://github.com/flutter/flutter/issues/191207)). Practical rules:

- Blur **small, static** surfaces (top bar, capsules, sheets), never a full-height sidebar over scrolling art.
- Wrap the blur in `RepaintBoundary` and `ClipRRect`; keep the area bounded.
- For the “liquid” refraction edge, use a `FragmentProgram` shader — possible, but its own project.
- OS-level acrylic: `flutter_acrylic` supports **Windows and macOS only** ([pub.dev](https://pub.dev/packages/flutter_acrylic)); Linux has no equivalent, so rely on in-app blur.

## 4. What Flutter is better at than Electron (for us)

- **Frame pacing:** no Chromium layout/paint pipeline; 60/120 fps with compositor-only animations.
- **One UI, three OSes:** same pixels on Windows, Linux, macOS.
- **Real springs:** `SpringSimulation` with velocity handoff, not CSS approximations.
- **Smaller binary:** ~40 MB vs ~120 MB Electron.
- **Golden tests:** pixel tests for UI are first-class.

## 5. What gets worse

| Gap | Reality |
|---|---|
| Tray, global hotkeys, autostart | plugins exist (`tray_manager`, `hotkey_manager`, `launch_at_startup`) but less battle-tested |
| Window chrome/transparency | per-platform, inconsistent on Linux |
| Auto-update | manual work; Electron's `electron-updater` is better |
| Accessibility | improving, still behind native toolkits |
| Hiring/community | smaller desktop ecosystem than Electron |
| File dialogs, “open folder”, shell integration | plugin or platform channel |

## 6. Recommended architecture

```
Flutter UI (Dart)
   ├─ widgets, theme, motion, glass
   └─ flutter_rust_bridge
Rust core
   ├─ library scanning (Steam/Hydra/Lutris/registry/.desktop)
   ├─ process tracking (proc/Win32) + session timer
   ├─ SQLite (drift/sqflite on the Dart side or rusqlite in Rust)
   └─ image cache + thumbnails
```

- SQLite instead of `games.json` — sessions, art cache index, migrations.
- Thumbnails decoded at display size (`instantiateImageCodec(targetWidth:)`), not full-res.
- `Isolate` or Rust threads for scans so the UI never blocks.
- Packaging: AppImage + Flatpak (Linux), NSIS/MSIX (Windows), DMG (macOS).

## 7. What the mock shows

`mockups/flutter-copy.html` (rendered to PNG) is a **visual target**, built in HTML only because it is fast to iterate. Every surface maps to a Flutter primitive:

| Mock element | Flutter equivalent |
|---|---|
| Glass sidebar / top bar | `ClipRRect` + `BackdropFilter` + `Container(color: …)` |
| Moving nav pill | `AnimatedBuilder` + `SpringSimulation` (velocity-aware) |
| Hero crossfade | `AnimatedSwitcher` / `FadeTransition` + `Image` with `frameBuilder` |
| Status chips | `Container` + `Text`, shared theme |
| Command palette | `OverlayEntry` + `BackdropFilter`, `Focus`/`Shortcuts` |
| Ambient background | `CustomPaint` with radial gradients (static, no blur) |

## 8. Cost estimate (AI tokens, not time)

| Scope | Tokens | Cheap model | Premium model |
|---|---|---|---|
| Spike: shell + grid + one glass panel | 0.5–2 M | < $5 | $15–40 |
| Vertical slice: library, detail, import, tracking | 8–20 M | $10–40 | $150–400 |
| 2.0 parity | 40–100 M+ | $60–150 | $800–2 500 |

## 9. Recommendation

1. Build the **spike** in `gamevault-native-spike/`: Flutter shell, real `games.json`, sidebar + grid, pill spring, one `BackdropFilter` top bar, frame-time overlay. Nothing in the current app changes.
2. Compare side by side at 1200×760: idle, scroll, filter switch, collapse.
3. Only if the spike clearly wins, start the vertical slice with the Rust core + SQLite.
4. Freeze features on Electron during the port, or the two codebases diverge permanently.
