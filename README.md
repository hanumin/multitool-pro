<div align="center">

# 🖥️ MultiTool Pro

**Manage projects, printers, audio & file copying — all in one**

![Version](https://img.shields.io/badge/version-1.11.10-emerald)
![Platform](https://img.shields.io/badge/platform-Windows%2010%2F11-blue)
![UI](https://img.shields.io/badge/UI-Vietnamese-brightgreen)

</div>

---

## 📦 Key Features

### 🚀 Project Management (Servers Module)
- **Start/stop** Node.js projects (`npm run dev`, `next dev`, `vite`, ...)
- **Auto-installs** `node_modules` when missing
- **Real-time log streaming** (SSE)
- **Cache cleaning**: Quick Cache, Deep Build, Nuke Reinstall
- **Environment variables**: view/edit `.env.local` or `.env`
- **Diagnostics**: RAM, CPU, Git branch, Node/npm version
- **Auto-start** with Windows

### 🖨️ Printer Management (Printers Module)
- **Printer list**: shows all local + network printers
- **Status**: Ready, Printing, Error, Out of paper, Paper jam, Offline
- **Auto-detection**: polls the spooler every 5 seconds → automatically records completed print jobs
- **Print statistics**: total prints, last print, recent documents
- **LASER detection**: auto-detects laser printers → skips reminders + 🔲 badge
- **Smart reminders**: countdown to next print date, red warning when overdue
- **Print queue**: view and clear pending jobs
- **Test print**: sends a test page, automatically recorded to history

### 🎤 Audio & Mic Management (Audio Module)
- **Real-time mic monitoring**: detects apps using the mic via the Registry
- **Session counter**: automatically counts seconds while the mic is active
- **Session history**: saves time, app, and mic name
- **Alert sound**: beeps when the mic turns on (if enabled in settings)
- **Widget mode**: draggable 200×200 widget showing status + timer
- **Auto show/hide widget**: shows when mic active, hides when idle
- **Widget opacity**: slider from 10% → 100%
- **Color customization**: pick active/inactive colors with a color picker
- **Device control**: mute/unmute, adjust volume, set default device

### 📂 File Copier Module
- **Keyword search**: copies audio/video files based on a keyword list
- **6 source folders**: Audio Tách Ghép Âm, Video Tách Ghép Âm, Audio Đọc 1 Lần, Từ điển...
- **Conflict handling modes**: Overwrite, Skip, or Rename
- **MD5 verification**: ensures copied files are intact
- **Dry Run**: preview results without actually copying
- **Detailed log**: real-time progress

### 🎨 Interface
- **100% Vietnamese**: entire UI, modals, notifications
- **Dark/Light mode**: smooth switching
- **Responsive**: optimized for various window sizes
- **Micro-interactions**: hover, transition, active scale

---

## 🖼️ Screenshots

> *(Not available yet — you can add them later)*

---

## ⚙️ System Requirements

### 🖥 End Users (run the release build)

| Component | Requirement |
|-----------|-------------|
| 🖥 OS | Windows 10 / Windows 11 (64-bit) |
| 🐍 Python | ✅ **Not required** — the backend is bundled inside the build |
| 🖨 Printer | Optional (if using the Printer Module) |
| 🎤 Mic | Optional (if using the Audio Module) |

### 🛠 Developers (build from source)

| Component | Requirement |
|-----------|-------------|
| 🖥 OS | Windows 10 / Windows 11 (64-bit) |
| 🐍 Python | 3.10+ (runs the backend API + PyInstaller) |
| 📦 Node.js | 18+ (frontend build) |
| 🦀 Rust | stable (Tauri build) |

### Required Python libraries

```bash
pip install -r backend/requirements.txt
```

Includes: `flask`, `flask-cors`, `psutil`, `pywin32`, `requests`, `psycopg2-binary`, `mysql-connector-python`, `pycaw`

Install PyInstaller (only needed when building the portable):
```bash
pip install pyinstaller
```

---

## 🚀 Installation & Running

### Option 1: Install from the release build (Recommended)

Download the `.msi` or `.exe` from [Releases](https://github.com/hanumin/multitool-pro/releases) and run it.

> ✅ The new builds **bundle the Python backend** — end users **don't need to install Python or any libraries**. The app is self-contained: the backend self-extracts and runs in the background at `%LOCALAPPDATA%\multitool-pro\`.

The installer will automatically:
1. Create Start Menu + Desktop shortcuts
2. Configure the backend to run in the background

### Option 2: Run from source

```bash
# Clone repo
git clone https://github.com/hanumin/multitool-pro.git
cd multitool-pro

# Install frontend
npm install

# Build frontend
npm run build

# Install backend deps + run backend
pip install -r backend/requirements.txt
python backend/app.py &

# Open browser
start http://127.0.0.1:5050
```

### Option 3: Build the installer (NSIS/MSI)

```bash
# Requirements: Rust + Tauri CLI
npm install -g @tauri-apps/cli
npm run tauri build
```

Output files (`<version>` from `src-tauri/tauri.conf.json`):
- MSI: `src-tauri/target/release/bundle/msi/MultiTool Pro_<version>_x64_en-US.msi`
- EXE: `src-tauri/target/release/bundle/nsis/MultiTool Pro_<version>_x64-setup.exe`

> ⚠️ **Important note**: A bare `npm run tauri build` runs with the **empty placeholder** `backend-embed/backend.exe` if PyInstaller hasn't been run (build.rs auto-creates a placeholder so the code compiles + warns). The resulting installer will **not contain the backend** — use **Option 4** for a proper self-contained build.

### Option 4: Build the self-contained portable (Recommended for dev)

A portable build = **a single `.exe`** containing the frontend + Python backend + every dependency. It runs on any Windows machine, **no Python install** required.

```powershell
# Run from the project root (PowerShell)
./build-portable.ps1
```

The automated pipeline consists of 4 steps:
1. **`npm run build`** → build the frontend into `dist/`
2. **PyInstaller** → package `backend/app.py` + Flask + all dependencies into `backend.exe` (~38 MB, also embeds `dist/`, `auto-start.ps1`, `printer-monitor/`)
3. **Embed** → copy `backend.exe` into `src-tauri/backend-embed/` so `include_bytes!` embeds it directly into the Rust binary
4. **`npx tauri build --no-bundle`** → produce the portable exe + copy into `release/portable/`

**Output** (`<version>` from `src-tauri/tauri.conf.json`):

```
release/portable/MultiTool Pro_<version>_x64.exe   (~47 MB)
```

**Self-contained runtime:** on startup, Rust extracts the backend from the embedded bytes into `%LOCALAPPDATA%\multitool-pro\backend\backend.exe` (only writes when missing/different size) then spawns it. Debug builds prefer running `python` from source for faster dev; release builds use the embedded backend.

> 💡 User data (config, printer settings, debug.log) stays in `%APPDATA%\multitool-pro\` — installing a new version **won't lose old data**.
>
> 🔄 After building, if the old version is still running it will **lock the file** → close the app (or run `scripts/cleanup-portable-test.ps1`) before rebuilding.

---

### CI build on GitHub Actions

The `.github/workflows/build.yml` workflow builds multi-platform releases (Windows x64 + macOS universal2):

| Trigger | Result |
|---------|--------|
| Push `main` | Build portable + installer NSIS/MSI → upload **artifact** |
| Push tag `v*` | Create a **GitHub Release** with installer + `latest.json` (auto-update) |
| **Run workflow** | Manual build from the GitHub UI |

The CI pipeline is identical to `build-portable.ps1`: npm build → PyInstaller → embed → `tauri build` (Windows: NSIS/MSI + portable; macOS: .app + .dmg universal). Pushing a `v*` tag creates a GitHub Release with the installer + `latest.json` (auto-update).

> 🔑 **Auto-update needs a signing key**: generate one with `npx tauri signer generate -w ~/.tauri/multitool-pro.key`, then add it to GitHub Secrets as `TAURI_SIGNING_PRIVATE_KEY` (+ `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` if set). With a key, Tauri signs the installer and generates a `.sig` → `latest.json` is created → installed apps pick up the new version automatically. Without a key, CI still builds and releases normally, just without auto-update.

---

## 🔐 Login & Account Management (Supabase Auth)

The app uses **shared Supabase Auth** with the ecosystem (the web app english-topics — one shared account pool). Log in once, use it everywhere in the ecosystem.

### Architecture

```
┌─────────────────────────┐        ┌──────────────────────────────┐
│  App desktop (Tauri)     │        │  Web english-topics          │
│  - Supabase anon key     │──auth──▶  - Supabase anon key (client) │
│    (embedded, public)    │        │  - SERVICE ROLE key (server)  │
└────────────┬────────────┘        └──────────────┬───────────────┘
             │                                    │
             └──────────────▶  Supabase Auth (xjfttrbucggqieykjqxu)  ◀────┘
                               • 1 shared account pool
                               • RLS protects each app's data
```

- **URL + anon key** are PUBLIC keys (Supabase's official design for clients) — safe to embed in the app.
- **The service role key MUST NEVER be embedded in the app** — it lives only on the web server (Vercel) because it bypasses RLS.

### Login screen

- **Email + password** (with optional **Stay signed in** — the session persists across app launches)
- **Forgot password**: checks whether the email is registered first (calls the web endpoint `POST /api/auth/check-email` — the service role key stays server-side, never exposed to the app) → only real emails get a reset link
- Sidebar avatar: click it → popup to change avatar, sign out, or change password

### Required configuration (admin only)

**1. Supabase Dashboard** → Authentication → URL Configuration:

| Item | Value |
|-----|---------|
| Site URL | `https://english.luongphamhanhnguyen.com` |
| Redirect URLs | `https://english.luongphamhanhnguyen.com/**` (add the `/forgot-password` path too if needed) |

> ⚠️ If missing, the password reset link in the email falls back to `localhost:3000` — users won't be able to reset their password.

**2. Vercel (web project) — Environment Variables (Production):**

```
NEXT_PUBLIC_SITE_URL=https://english.luongphamhanhnguyen.com
```

> Used by the `POST /api/auth/forgot-password` route (web) to build a recovery link with the correct domain. After changing the env → **redeploy production**.

### Switching to a different Supabase project

Edit 2 places in `src/lib/supabase.ts`: `SUPABASE_URL` + `SUPABASE_ANON_KEY`, and change the `CHECK_EMAIL_API` endpoint in `src/components/LoginScreen.tsx` (if using a different web).

---

## 📖 Usage Guide

### Dashboard
- Left sidebar: choose a module
- Bottom status bar: shows system notifications
- Top-right: general settings, light/dark mode, minimize to tray

### Project management
1️⃣ **Add project**: Settings → "Add project" → enter name, path, port, command
2️⃣ **Start**: click the Play button next to the project
3️⃣ **View logs**: click the project tab to see real-time logs
4️⃣ **Stop**: click the Stop button
5️⃣ **Clean**: click "Clean" → choose a level (Quick Cache / Deep Build / Nuke Reinstall)
6️⃣ **Environment variables**: click "Environment variables" → edit `.env.local`

### Printer management
1️⃣ Open the **Printers** module → the printer list loads automatically
2️⃣ **Monitoring**: the app auto-selects the default printer; click any printer to change it
3️⃣ **Test print**: click "🖨 Test print" (only for non-laser printers)
4️⃣ **Queue**: click "📋 Print queue" → view/clear jobs
5️⃣ **Statistics**: click "📊 Statistics" → see total print counts
6️⃣ **Settings**: adjust the days between prints and the reminder interval

> 💡 Laser printers (name contains "laser") are auto-detected and skip reminders.

### Audio management
1️⃣ Open the **Audio** module → see real-time mic status
2️⃣ **Counter**: counts automatically while the mic is active
3️⃣ **History**: click "📋 History" → view previous sessions
4️⃣ **Widget**: click "🔲 Minimize" → a draggable 200×200 widget appears
5️⃣ **Settings**: click "⚙️ Settings" → customize:
   - Alert sound when the mic turns on
   - Auto show/hide widget when the mic turns on/off
   - Widget opacity (10% → 100%)
   - Active/inactive colors

> 💡 The widget auto-appears when the mic is active (if enabled in settings).

### File copier
1️⃣ Open the **Copy** module → enter keywords (manually or from a .txt file)
2️⃣ Choose source folders (up to 6)
3️⃣ Choose the destination folder
4️⃣ **Customize**: file extensions, MD5 verification, conflict mode
5️⃣ Click "🏃 Dry Run" to preview
6️⃣ Click "📋 Start copying" to run it

---

## 🏗 Folder Structure

```
multitool-pro/
├── backend/              # Python Flask API
│   ├── app.py            # Main backend server
│   └── requirements.txt  # Python dependencies
├── src/                  # React frontend (TypeScript)
│   ├── App.tsx           # Root component
│   ├── index.css         # Global styles
│   ├── types/            # TypeScript interfaces
│   └── components/       # Sidebar, modals, modules/
├── src-tauri/            # Tauri desktop wrapper
│   ├── src/lib.rs        # Rust — spawn backend (embedded / python fallback)
│   ├── build.rs          # Ensures backend-embed/backend.exe exists for embedding
│   ├── backend-embed/    # Built backend.exe (gitignored) → include_bytes!
│   ├── tauri.conf.json
│   └── Cargo.toml
├── scripts/              # Utility scripts (cleanup-portable-test.ps1, ...)
├── build-portable.ps1    # Build the self-contained 1-file portable
├── .github/workflows/    # CI: ci.yml + why-check.yml + build.yml (multi-platform build & release)
├── release/              # Output: installers + portable/ (gitignored)
├── dist/                 # Built frontend
└── package.json
```

---

## 🤖 AI-Assisted Development

MultiTool Pro was developed with the help of **Freebuff**, an AI coding agent.

I am a scientist rather than a professional software developer, so my development workflow focuses on describing the problems and workflows I want to solve. Freebuff helps translate those requirements into implementation, while I review, test, and iterate on the resulting application.

I have used Freebuff for feature implementation, investigating the existing codebase, debugging, refactoring, and integrating the different components of the project — iterating on features based on how they behave in real-world use. Before Freebuff, the project was developed with other AI coding tools, including Claude, Codex, and Antigravity, and parts of the codebase and documentation reflect that history.

The repository also makes use of AI-agent skills and workflows where they are useful, such as spec-driven development plans and specs (`docs/superpowers/`, `.superpowers/sdd/`), the GitNexus code-intelligence skills for exploring, impact analysis, and refactoring (`AGENTS.md`, `CLAUDE.md`), and the `web-design-guidelines` skill for UI review.

---

## 🔧 API Documentation

Backend runs at `http://127.0.0.1:5050`

### Projects
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/projects` | List projects |
| POST | `/api/projects/{name}/start` | Start |
| POST | `/api/projects/{name}/stop` | Stop |
| GET | `/api/projects/{name}/logs` | Get logs |
| GET | `/api/projects/{name}/logs/stream` | Real-time logs (SSE) |
| GET | `/api/projects/{name}/diagnostics` | Diagnostics (RAM, CPU, Git) |
| GET/PUT | `/api/projects/{name}/env` | Environment variables |
| POST | `/api/projects/{name}/clean` | Clean |

### Printers
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/printers` | List printers |
| GET | `/api/printers/{name}/jobs` | Print queue |
| DELETE | `/api/printers/{name}/jobs` | Clear queue |
| POST | `/api/printers/{name}/default` | Set default |
| POST | `/api/printers/{name}/test` | Test print |
| GET | `/api/printer/stats` | Print statistics |
| GET | `/api/printer/activity` | Current print activity |
| POST | `/api/printer/auto-detect` | Auto-detect print |
| GET | `/api/printer/reminder-check` | Check reminders |
| GET/POST | `/api/printer/settings` | Printer settings |
| GET/POST | `/api/printer/log` | Print log |
| GET/POST/DELETE | `/api/printer/history` | Print history |
| GET | `/api/printer/wmi-status` | WMI status |

### Audio
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/audio/devices` | List devices |
| GET | `/api/audio/mic-status` | Mic status |
| POST | `/api/audio/devices/{id}/mute` | Mute/unmute |
| PUT | `/api/audio/devices/{id}/volume` | Adjust volume |
| POST | `/api/audio/devices/{id}/default` | Set default |
| GET/POST | `/api/audio/settings` | Audio settings |
| GET | `/api/audio/session-history` | Session history |
| POST | `/api/audio/session-log` | Log session |
| GET | `/api/audio/sound-files` | List sound files |

### File copier
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/file-copier/count` | Count files in folder |
| POST | `/api/file-copier/read-keywords` | Read keyword file |
| POST | `/api/file-copier/run` | Run copy |

---

## 📝 Changelog

### v1.11.10 (15/08/2026)
- 🔐 **Forgot password**: when rate-limited, the wait message now shows "59 seconds / 5 minutes / 1 hour" instead of raw seconds (e.g. "3600 seconds")
- ✉️ **Reset emails from a dedicated domain**: now sent from `auth.luongphamhanhnguyen.com` (via Resend SMTP) instead of `noreply@supabase.co` — less likely to land in spam
- ⬆️ Reset email limit raised to **60 emails/hour** (previously 2/hour)

### v1.11.9
- 🔗 **Fixed password reset link**: it previously pointed to a dead domain (`english-topics.vercel.app`) so Supabase fell back to `localhost:3000` → broken link. Now points to the LIVE web's password reset page (`english.luongphamhanhnguyen.com/forgot-password`)
- 📧 **Forgot password**: checks whether the email is registered first — if not, shows "Email not registered" instead of a fake success message (checked via the web server, without exposing the Supabase service role key)
- 🧹 Removed the tooltip when hovering the system-account login label

### v1.11.8
- 🖼 **Compact avatar popup**: removed the "Local pets" and "Custom input" tabs — only Codex Pets + Emojis (simpler, less clutter)
- 📖 **System Configuration popup**: brighter left menu, unselected labels + icons switched to light readable colors (previously dark gray, hard to read)
- 🐛 Old avatars stored as URL/file names still render correctly (only the picker options changed, saved data is intact)

### v1.11.7
- 🖼 **Change avatar from sidebar**: click the avatar in the sidebar corner (or the "Change avatar" item) → popup: choose Codex Pets (self-hosted library on R2), emoji, or paste a custom image link
- 🎨 **Avatar background color** (12 swatches) — saved with the avatar, synced with the web english-topics (change it once, seen everywhere)
- 🐛 Fixed old Codex pet avatars displayed as raw text `codex:xxx` — now resolved to the correct animated image from the library
- 🔧 Login screen: title & description moved closer together with consistent spacing to the features block — more balanced left panel

### v1.11.6
- 🔄 **Professional auto-update popup**: one popup handles both checking and installing with clear states (checking, update available, downloading %, installing, done, error)
- 🪟 Floating popup with **no dimmed backdrop** — the app below stays visible during updates
- 🛠 **Repair feature**: re-downloads the exact current version and installs over it — restores broken/missing files without upgrading
- 📊 Shows real download progress (%, downloaded/total size) + expandable release notes right in the popup
- ⏱ Auto-checks for updates on startup — only shows the popup when an update exists (no nagging)
- 📦 Cleaner GitHub releases: only installers (.msi/.exe/.dmg/.app.tar.gz) + signature, removed extra raw binaries

### v1.11.5
- 🚀 **Completed auto-update**: installers are code-signed in CI, the app detects new versions via the "Check updates" button
- 🌍 **Multi-platform builds**: GitHub Actions builds Windows + macOS Universal (runs on both Intel and Apple Silicon Macs)
- 🍎 Mac builds auto-hide Windows-only modules (Audio, Printers, Tunnel) — cleaner UI, no crashes
- 🪟 **Window size picker**: 7 levels from 720p to 1440p + warning when larger than the screen
- 💾 Saves and restores window position + size on close/open (including maximized state)
- ✨ Smooth animations for server cards, sidebar, titlebar, Settings/Changelog modals, and status text
- 🔧 Polling fixes: longer retry delay, cancel overlapping requests, stagger initial load between modules
- 🏷 Changed the label "Reconnecting..." to "Loading data..." for the first load

### v1.11.4 (11/08/2026)
- 📦 **Self-contained portable**: Python backend (Flask + all deps) packaged with PyInstaller → embedded directly into the Tauri binary (`include_bytes!`) → runs **without installing Python**, a single `.exe` (~47 MB)
- 🖥 **Fluent UI tray menu**: custom system tray menu (glassmorphism, zero left padding) — module navigation, Start/Stop All, audio widget toggle, auto-hide on focus loss, IPC event bus (`tray-command`)
- 🖨 **LAN Printer Scan**: auto-scans the network for unconfigured printers → Windows toast with an "⚡ Assign IP" button (deep-link opens the Printers tab directly), periodic scans + retry when toast fails
- 🖨 **Supplies & Consumables**: configure a network printer IP → auto-reads toner/drum/ink % via SNMP (RFC 3805, pure Python), or manual input for USB printers; low-supply thresholds
- 🖨 **Background Print Listener**: detects completed print jobs with `FindFirstPrinterChangeNotification` (event-driven, catches even <100ms laser jobs) — no missed jobs when the UI is on another tab
- ⚙️ **CI release builds**: GitHub Actions workflow (`build.yml`) — npm build → PyInstaller → embed → tauri build (Windows NSIS/MSI + macOS universal) → artifact + GitHub Release + `latest.json` (signed auto-update) on `v*` tags
- 🔧 `build-portable.ps1`: automated self-contained portable build script covering the whole pipeline

### v1.11.3 (07/08/2026)
- 🎤 **Audio set-default v2 rewrite**: setting the default mic now works reliably (Core Audio GUID instead of device index), verifies the change with backoff retry, comtypes crash protection
- 🧩 Centralized audio widget management (`audioWidget.ts`) — syncs state between the module, tray menu & Rust

### v1.11.2 (28/07/2026)
- 🎨 **Major UI overhaul**: redesigned server cards (compact footer, removed duplicate tunnel URL), consolidated into 1 settings button
- 🇻🇳 **100% Vietnamese UI** (fully completed vs. the previous version)
- 🌐 Fixed tunnel metrics polling (metrics weren't refreshing on schedule)
- 🖥 Servers: reworked the follow flow, batch actions & improved npm scripts runner

### v1.9.10 (26/07/2026)
- 📐 Increased window size + font, responsive sidebar auto-collapse on small screens

### v1.9.3 (20/07/2026)
- 🖨 **GDI printer detection**: auto-detects GDI (host-based) printers → `driver_type` badge, skips empty EventLog, WMI fallback

### v1.9.2 (20/07/2026)
- 🖨 **Printer page count fixes**: C#/PowerShell monitor module (fast XPath query), fixed Properties[3]→[4] for printer names (tested on real Windows 11)

### v1.9.1 (20/07/2026)
- 🐛 Fixed PermissionError when starting projects, fixed audio API 501, updated dependencies

### v1.9.0 (20/07/2026)
- 🗄 **Database Export**: export data as CSV/JSON, SQL syntax highlighting
- 📋 **Logs Download**: download logs, improved accessibility

### v1.8.0 (20/07/2026)
- 🗄 **Database Manager**: connect to SQLite/PostgreSQL/MySQL, SQL editor, view tables/data
- ⚡ **Batch Actions**: Start/Stop/Restart All
- 🔍 **Port Scanner**: detect port conflicts, Quick SSL
- 📋 **Log Search**: log search + npm Scripts runner
- 📊 **Performance History** + Disk Usage cache

### v1.6.0 (14/07/2026)
- 🇻🇳 **Vietnamese main UI** (fully completed in v1.11.2)
- 🖨 Printer: auto-watching + auto-detect print + laser detection + statistics
- 🎤 Audio: auto show/hide widget, opacity slider, session timer
- 🔒 Single Instance Lock (prevents running 2 windows)
- 🐛 Fixes: `global` keyword, thread safety, Promise.all crash

### v1.5.0
- 🖨 Printer Module: WMI status, reminder, history
- 🎤 Audio Module: Widget mode, color themes, alert sound
- 🖼 Custom icon from `icon.png`

### v1.4.0
- 📂 File Copier Module: keyword copy, MD5, dry run
- ⚡ Optimized polling intervals

---

## 🤝 Contributing

Contributions are welcome! Please:

1. Fork the repo
2. Create a new branch (`git checkout -b feature/feature-name`)
3. Commit your changes (`git commit -m 'Add feature X'`)
4. Push the branch (`git push origin feature/feature-name`)
5. Create a Pull Request

---

## 📄 License

Distributed under the **MIT** license.

---

<div align="center">
  <p>Built with ❤️ by <a href="https://github.com/hanumin">hanumin</a></p>
  <p>
    <a href="https://github.com/hanumin/multitool-pro/issues">Report issues</a>
    ·
    <a href="https://github.com/hanumin/multitool-pro/issues">Request features</a>
  </p>
</div>