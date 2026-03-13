# Memore

> Memos More — A Better Memos

Memore is a **local-first personal note-taking app** built on [Memos](https://github.com/usememos/memos), designed for Windows and Android. It retains the core capabilities of Memos while significantly improving the editing experience, UI immersion, and local data management, with full bidirectional sync support for remote Memos instances.

Current version: **v0.2.1**

---

## v0.2.1 Changelog

### Fixes & Improvements

- **Fixed Android default theme showing Dark**: When the phone system was in dark mode, the app automatically followed and switched to Dark theme, overriding the preset Paper default. The "Sync with system" theme option has been removed — themes are now fixed to user selection (Light / Dark / Paper), unaffected by system dark mode.

- **Fixed Windows first-launch missing window controls**: On first launch, WebView2 initialization could be slow, preventing the custom title bar's minimize/maximize/close buttons from appearing. Now uses persistent polling (up to 30 seconds) and shows a friendly loading page instead of a 502 error when the backend isn't ready yet.

- **Android download/save attachments**: Android WebView doesn't support the `<a download>` attribute, so previously there was no way to save images or documents within the app. New features:
  - Download button added to image preview dialog
  - Individual download buttons for each file/image in attachment lists
  - Android uses Capacitor Filesystem + Share plugins — triggers the system share dialog to save to file manager or forward to other apps
  - Desktop uses standard browser downloads (dragging images to desktop also saves the original)

### Project Cleanup

- Removed Docker-related files (Dockerfile, compose.yaml, entrypoint, etc.) — Memore focuses on desktop/mobile
- Fixed icon source filename (`memoreicon.png` → `memore.png`) to match the generation script
- Fixed Android build script JDK 21 detection (forces Android Studio JBR)

---

## v0.2.0 Changelog

### New Features

- **Bidirectional sync for pinned and archived states**: Two new optional sync toggles ("Sync pinned status" and "Sync archived status") in Settings > Preferences > Memore Sync, defaulting to off. When enabled, pin and archive operations sync bidirectionally between local and remote, including metadata-only change detection even when `updateTime` hasn't changed.

- **Bidirectional sync for memo visibility**: Fixed an issue where changing a memo's visibility (private/public/workspace) did not sync bidirectionally. Visibility changes now always participate in sync without a separate toggle.

- **Sync trigger queue**: When a sync is already running, new sync requests are now queued instead of being silently dropped, and execute automatically after the current sync completes.

### Default Settings

- **Default theme**: New installations default to the Paper theme for a softer reading experience
- **Default week start day**: New installations default to Monday as the start of the week
- **Content length limit**: Default raised from 8KB to 256KB to accommodate longer articles and code notes

### Other

- **Project icon update**: New icon across all platforms (Windows, Android, Web)

## v0.1.9 Changelog

### Bug Fixes

- **Deep fix for Windows tray icon becoming unresponsive**: The v0.1.8 fix did not fully resolve the issue. Root cause: `getlantern/systray`'s `init()` locks the main goroutine's OS thread on import, but `systray.Run()` ran in a separate goroutine without thread pinning. The Windows message pump must run on the same OS thread that created the hidden window; Go's scheduler could migrate the goroutine to a different thread, causing tray messages to stop being delivered. Fix: release the main thread lock in `main()` and re-lock with `runtime.LockOSThread()` in the systray goroutine.

- **Fixed sync not syncing pinned state**: Pinning a memo did not update `updated_ts` in the database, so the sync engine's skip check saw no change and skipped the memo. Fix: `UpdateMemo` now auto-bumps the timestamp on any field change, no longer requiring `update_time` to be explicitly in the update mask.

- **Fixed sync not syncing archived state**: Previously, sync only listed NORMAL-state memos — archived memos were completely excluded from synchronization. Fixes include:
  - Push path now lists all local memos regardless of state; backend `ListMemos` supports `STATE_UNSPECIFIED` to return all states
  - Pull path fetches both NORMAL and ARCHIVED remote memos in two passes
  - Push/Pull payloads and update masks now include the `state` field
  - After creating a remote/local memo, archived state is synced automatically (CreateMemo defaults to NORMAL, followed by a PATCH to set ARCHIVED)

> About archiving: Archiving moves a memo from the main list to the "Archived" area. Archived memos are hidden from the homepage but remain in the database and can be restored at any time. Useful for notes that are no longer active but shouldn't be deleted.

## v0.1.8 Changelog

### Bug Fixes

- **Fixed multi-attachment sync overwrite**: When syncing a memo with multiple attachments, previously only the last attachment would be correctly synced to the other end — the rest were lost. The root cause was that the backend `CreateAttachment` returned an `Internal` error instead of `AlreadyExists` when encountering a duplicate UID, preventing the frontend from recognizing already-existing attachments. Fixes include:
  - Backend: `CreateAttachment` now detects UID unique-constraint violations and returns `AlreadyExists`
  - Frontend Push (local → remote): on remote attachment creation failure, attempts GET to confirm whether the attachment already exists
  - Frontend Pull (remote → local): checks for existing local attachment before downloading, skipping unnecessary downloads and duplicate creation

- **Fixed Windows tray icon becoming unresponsive** (initial fix; deep fix in v0.1.9)

---

## Key Features

### Local-First

- All notes and attachments are stored on the local filesystem — no cloud dependency
- Default storage mode: SQLite + Local (attachments saved as individual files)
- Windows data directory: `C:\ProgramData\memore`
- Android data directory: `${filesDir}/memore/` (app internal storage)

### Enhanced Editor

- Integrated [Vditor](https://github.com/Vanessa219/vditor) Markdown editor with WYSIWYG, instant-render, and split-preview modes
- Double-click a note to enter Vditor advanced editing (configurable in Settings)
- Click the backdrop overlay to auto-cancel edits and restore display state
- Supports code highlighting, math formulas (KaTeX), Mermaid diagrams, map embeds, and more
- Custom fonts: enter any installed font name in Settings > Preferences > Basic to override the default globally
- Editor mode adapts to platform: Android defaults to WYSIWYG, Windows/Web defaults to instant render

### Cloud Sync

- Bidirectional sync with remote Memos server instances
- **Push**: Upload locally created/modified/deleted notes to remote
- **Pull**: Download remotely created/modified/deleted notes to local
- **Pin/Archive sync**: Optional toggles for bidirectional pin and archive state sync
- **Visibility sync**: Memo visibility (private/public/workspace) changes always sync bidirectionally
- Attachment sync via backend proxy (bypasses browser CORS restrictions)
- Conflict resolution: Last-Writer-Wins (LWW) by `updateTime` timestamp
- Content fingerprint deduplication prevents accidental duplicates
- Resumable transfers: sync progress is saved incrementally
- Dry Run preview: preview change counts before committing
- Safe deletion: confirmation dialog when sync would delete more than 2 notes
- Copy remote link: the "Copy Link" action in the memo menu copies the remote Memos URL for sharing; unsynced memos copy empty

### Immersive Desktop Experience (Windows)

- Frameless window with custom title bar, seamlessly integrated with the app theme
- System tray support — closing the window hides to tray instead of quitting
- Single-instance protection: launching again brings up the existing window
- Globally hidden scrollbars for a cleaner interface
- Single-file EXE distribution — just double-click to launch
- Smooth animation transitions for editor focus mode

### Android Native App

- Uses Capacitor + gomobile AAR to run the local Go backend on device for full offline support
- Android foreground service boots local API at `127.0.0.1:8081`
- Reuses the same frontend and sync engine as desktop
- Auto-adapts to system status bar height with theme-matched fill
- Header bar fixed at the top, does not scroll with page content
- Vditor toolbar reformatted for mobile: 3 rows × 6 buttons, no dividers
- System back key dismisses sidebars, dialogs, and editor overlays
- Save images and attachments locally (via system share dialog for saving or forwarding)

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Backend | Go 1.25 + Echo HTTP + gRPC + Connect RPC |
| Frontend | React 18.3 + TypeScript + Vite 7 + Tailwind CSS v4 |
| Database | SQLite (default) / MySQL / PostgreSQL |
| Protocol | Protocol Buffers v2 + buf codegen |
| Editor | Vditor (optional enhanced mode) |
| Desktop Framework | Wails v2 + WebView2 |
| Android Framework | Capacitor + Foreground Service + gomobile AAR |
| System Tray | getlantern/systray |
| Resource Embedding | go-winres (icons + version info) |

---

## Project Structure

```
cmd/
  memos/                    # Web server entry (Cobra CLI)
  memore-desktop/           # Windows desktop entry (Wails v2)
    main.go                 # Wails app config, backend startup, system tray
    proxy.go                # HTTP reverse proxy (WebView → internal backend)
    generate_icons.py       # Icon generator (PNG → multi-size ICO + platform icons)
    icon.png / icon.ico     # Application icons

mobile/
  server.go                 # gomobile binding entry (Android AAR)

server/                     # HTTP server
  server.go                 # Echo server init, background runners
  auth/                     # Authentication (JWT v2, PAT, sessions)
  router/
    api/v1/                 # gRPC + Connect RPC service implementations
    frontend/               # Static frontend assets (go:embed)
    fileserver/             # File serving + attachment proxy
    rss/                    # RSS feed generation

store/                      # Data layer
  driver.go                 # Database driver interface
  store.go                  # Store wrapper + in-memory cache
  db/sqlite/                # SQLite implementation
  db/mysql/                 # MySQL implementation
  db/postgres/              # PostgreSQL implementation
  migration/                # Database migration files (organized by version)

proto/                      # Protocol Buffer definitions + generated code
plugin/                     # Plugins (markdown, S3, scheduler, email, webhook, etc.)

web/                        # React frontend
  src/
    components/             # UI components
      MemoEditor/           # Editor (with Vditor focus mode)
      MemoView/             # Memo display (with double-click edit)
      MobileHeader.tsx      # Mobile header bar (fixed on Android)
      DesktopTitleBar.tsx   # Desktop custom title bar
    contexts/               # React Context (Auth, View, MemoFilter)
    hooks/                  # React Query hooks
      useMemoreSyncPreferences.ts  # Sync preferences (pin/archive toggles)
      useMemoreTriggeredSync.ts    # Event-triggered sync + retry queue
      useMemoreStartupSync.ts      # Auto-sync on startup
    lib/
      memore-sync.ts        # Core sync engine
      memore-auto-auth.ts   # Auto-login credential management
    pages/                  # Page components
    locales/                # i18n resources
  android/                  # Capacitor Android project
    app/src/main/java/      # Kotlin native code (foreground service, back key, etc.)

scripts/
  build-desktop.ps1         # Windows desktop build script
  build-android.ps1         # Android build script (with embed verification)
  build.sh                  # Cross-platform web server build script

packaging/
  windows/README.md         # Windows desktop packaging docs
  android/README.md         # Android packaging docs
```

---

## Quick Start

### Using the Built Desktop App

Double-click `build/Memore.exe` to launch. Register a local account (username + password) on first run.

- Close window → hides to system tray (keeps running)
- Right-click tray icon → "Open Memore" or "Quit"
- Launching again → brings up the existing window
- Data stored at `C:\ProgramData\memore\`
- After first login, credentials are saved for auto-login on subsequent launches

### Using the Android App

Install `Memore.apk` and register an account on first launch. Registration automatically logs you in.

### Development Mode

```bash
# Start backend (port 8081)
go run ./cmd/memos --port 8081

# Start frontend dev server (new terminal, auto-proxies to backend)
cd web && pnpm install && pnpm dev
```

Open `http://localhost:5173` in your browser.

### Build Desktop App

```powershell
# Full build (frontend + resource embedding + Go compile)
.\scripts\build-desktop.ps1

# Skip frontend build (only if frontend unchanged)
.\scripts\build-desktop.ps1 -SkipWebBuild
```

Output: `build/Memore.exe` (~46 MB single executable)

### Build Android APK

```powershell
.\scripts\build-android.ps1
```

Output: `web/android/app/build/outputs/apk/debug/app-debug.apk`

The build script includes a "strong verification" mechanism: writes a unique marker to the frontend directory → builds AAR → verifies the AAR contains the marker → clears cache and retries if not.

---

## Configuration

### Environment Variables (Web Server Mode)

| Variable | Default | Description |
|----------|---------|-------------|
| `MEMOS_PORT` | `8081` | HTTP port |
| `MEMOS_ADDR` | `""` | Bind address (empty = all interfaces) |
| `MEMOS_DATA` | platform-specific | Data directory |
| `MEMOS_DRIVER` | `sqlite` | Database driver (sqlite / mysql / postgres) |
| `MEMOS_DSN` | `""` | Database connection string |

### Desktop App

No manual configuration needed:

- **Port**: Automatically assigned
- **Bind address**: `127.0.0.1` (localhost only)
- **Data directory**: `C:\ProgramData\memore`
- **Storage mode**: Local (attachments as files)

### Android App

- **Port**: Fixed at 8081
- **Data directory**: `${filesDir}/memore/` (app internal storage)
- **Storage mode**: Database (attachments stored in SQLite)

### Defaults

| Setting | Default | Description |
|---------|---------|-------------|
| Theme | Paper | Soft paper-style theme |
| Week start day | Monday | Calendar and statistics start on Monday |
| Content length limit | 256 KB | Maximum bytes per memo |
| Default visibility | PRIVATE | New memos default to private |

---

## Memore Sync

Configure in **Settings > Preferences > Memore Sync**:

1. Enable "Enable Remote Sync"
2. Enter remote Memos server URL (e.g., `https://memos.example.com`)
3. Enter access token (generate in remote Memos Settings > Access Tokens)
4. Click "Test Connection" to verify
5. Enable "Auto-sync on startup" (optional)
6. Enable "Sync pinned status" and/or "Sync archived status" as needed (optional)

### Sync Operations

- **Manual sync**: Click the sync button next to the editor
- **Auto sync**: Runs on startup (if enabled)
- **Dry Run preview**: Click "Dry Run Preview" in settings to view change statistics

### Sync Scope

| Data | Sync Behavior | Toggle |
|------|--------------|--------|
| Memo content | Always synced | — |
| Attachments | Always synced | — |
| Visibility (private/public/workspace) | Always synced | — |
| Pinned status | Optional | "Sync pinned status" toggle |
| Archived status | Optional | "Sync archived status" toggle |

### Conflict Handling

When both local and remote modify the same note:

- Compares `updateTime` timestamps
- The later modification wins (Last-Writer-Wins)
- Conflict logs viewable in the sync status panel

### Safety Protections

- Confirmation dialog when a sync operation would delete more than 2 notes
- Sync lock prevents multiple tabs/instances from syncing simultaneously

---

## Data Storage

### Windows Desktop

| Content | Path |
|---------|------|
| Database + attachments | `C:\ProgramData\memore\` |
| Browser cache (localStorage, sync metadata) | `%APPDATA%\Memore.exe\EBWebView\` |

> Deleting `ProgramData\memore\` removes notes and attachments, but login credentials and sync config live in WebView cache and will persist.

### Android

| Content | Path |
|---------|------|
| Database + attachments | `${filesDir}/memore/` |
| WebView cache | App internal storage |

> Uninstalling the app removes all data.

---

## Differences from Memos

| Aspect | Memos | Memore |
|--------|-------|--------|
| Purpose | Web-deployed note service | Local desktop/mobile note app |
| Editor | Native textarea | Vditor enhanced editor |
| Window | Browser tab | Frameless window + system tray |
| Default Theme | Default (follows system) | Paper (fixed, ignores system) |
| Default Visibility | PUBLIC | PRIVATE |
| User Model | Multi-user | Single local account |
| Data Storage | Server-side | Local filesystem |
| Sync | None | Bidirectional with remote Memos |
| Fonts | Fixed | Customizable global font |
| Copy Link | Copies local URL | Copies remote Memos URL (for sharing) |
| Scrollbars | Default visible | Globally hidden |
| Android | No native app | Capacitor + gomobile native app |
| Login | Manual each time | Auto-login after first registration |

---

## Icon Replacement

1. Prepare a PNG source image at least 512×512 (transparent background) and place it at the project root
2. Run the icon generation script:
   ```bash
   python cmd/memore-desktop/generate_icons.py
   ```
3. The script generates and replaces all platform icons: Windows ICO/PNG, Web favicons, Android mipmaps
4. Re-run the build scripts

---

## Credits

Built on [Memos](https://github.com/usememos/memos) (MIT License). Thanks to the Memos team for their excellent work.

Editor enhancement powered by [Vditor](https://github.com/Vanessa219/vditor).
