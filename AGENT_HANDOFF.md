# Server Dashboard — Handoff cho Agent tiếp theo

## Tổng quan
App Tauri v2 (Rust) + React (Vite, TypeScript, Tailwind v4) + Flask backend.
Quản lý nhiều dev server (Next.js, Node.js) từ system tray Windows.

## Cấu trúc thư mục
```
TauriDashboard/
├── src/                          # Frontend React
│   ├── App.tsx                   # Layout chính: header, server cards, log viewer, bottom bar
│   └── components/
│       └── SettingsModal.tsx     # Modal settings (CRUD project)
├── backend/
│   └── app.py                    # Flask API: start/stop/logs/config/cache/autostart
├── src-tauri/
│   ├── src/lib.rs                # Rust entry: system tray, Flask sidecar, updater
│   ├── tauri.conf.json           # Tauri config (window, bundle, updater plugin)
│   └── capabilities/default.json # Permissions (core, tray, updater)
├── dist/                         # Frontend build output
├── config.json                   # Config cũ (đã migrate, có thể xoá)
└── package.json
```

## Backend API (Flask, port 5050)

| Method | Endpoint | Chức năng |
|--------|----------|-----------|
| GET | /api/projects | Danh sách project + trạng thái running |
| POST | /api/projects/&lt;name&gt;/start | Start project |
| POST | /api/projects/&lt;name&gt;/stop | Stop + kill port |
| POST | /api/projects/&lt;name&gt;/clear-cache | Xoá .next, tsconfig.tsbuildinfo, .cache |
| GET | /api/logs/all | Log tất cả project |
| GET | /api/config | Config hiện tại |
| POST | /api/config/projects | Thêm project |
| PUT | /api/config/projects/&lt;name&gt; | Sửa project |
| DELETE | /api/config/projects/&lt;name&gt; | Xoá project |
| POST | /api/config/reload | Tải lại config từ disk |
| GET | /api/settings | Lấy trạng thái autostart |
| POST | /api/settings/autostart | Bật/tắt autostart |
| POST | /api/shutdown | Dừng tất cả + tắt backend |

## Config storage
- **Windows:** `%APPDATA%\server-dashboard\config.json` (chuẩn Windows, không phụ thuộc vị trí exe)
- **Auto-migrate:** Nếu chưa có config ở AppData, Flask tự tìm `config.json` ở project root và copy dữ liệu sang.

## Các vấn đề cần fix

### 1. SettingsModal "Cannot load config" (PRIORITY CAO)
Khi mở Settings, fetch `/api/config` thất bại.
- **Nguyên nhân có thể:** 
  - Backend chưa kịp start trước khi React fetch
  - Hoặc do CORS / network error (frontend gọi tới port 5050 nhưng backend chưa ready)
  - Hoặc error message do chính fetch `/api/projects` ở App.tsx catch và set "Backend unavailable"
- **Cần làm:**
  - Retry logic khi fetch config thất bại (3 lần, cách nhau 1s)
  - Hiển thị trạng thái loading rõ ràng
  - Kiểm tra CORS: Flask đã có `CORS(app)` nhưng verify vẫn chạy đúng

### 2. SettingsModal còn thiếu tính năng
- **Chưa có "Select Folder" button** — người dùng phải gõ tay đường dẫn project. Cần nút "Browse…" dùng Tauri dialog API (`@tauri-apps/plugin-dialog`):
  ```ts
  import { open } from '@tauri-apps/plugin-dialog'
  const selected = await open({ directory: true, multiple: false })
  ```
  → Cần thêm `tauri-plugin-dialog` trong Cargo.toml và capabilities.
- **Thiếu trường portMin/portMax** — config có `portMin: 4000, portMax: 4999` nhưng không có UI để chỉnh.
- **Thiếu "command" presets** — dropdown gợi ý: `npm run dev`, `npm run dev -- -p {port}`, `npm start`, `yarn dev`.
- **Không có "Start after add" checkbox** — sau khi thêm project xong, nên hỏi user có muốn start luôn không.
- **Button "Delete" không có confirm khi project đang chạy** — đã có `confirm()` nhưng chưa auto-stop.

### 3. Rust project_root detection (đã fix nhưng cần verify)
File `src-tauri/src/lib.rs` hàm `run()`:
- Dùng `current_exe()` để tìm thư mục exe, sau đó `.ancestors().find(|d| d.join("backend").join("app.py").is_file())`
- Fallback về `current_dir()` nếu không tìm thấy
- **Edge case:** Khi chạy từ `npm run tauri dev`, `current_exe()` trả về đường dẫn trong `target/debug/`, cần verify vẫn tìm đúng project root.
- **Test thủ công:** Chạy exe từ `release/`, check console output có `[backend] Flask started from ...` không.

### 4. Auto-update infrastructure (ĐÃ TRIỂN KHAI ĐẦY ĐỦ)
- `tauri-plugin-updater` đã đăng ký trong Rust, config trong `tauri.conf.json` trỏ tới GitHub Releases
- Frontend có nút "Check updates" → gọi `check()` → `downloadAndInstall()` (có progress %) → `relaunch()`
- Signing keypair ở `~/.tauri/server-dashboard.key` (password: **rỗng**), pubkey khớp `tauri.conf.json`
- Workflow `.github/workflows/build.yml` (đa nền tảng Windows + macOS universal):
  - Có secrets `TAURI_SIGNING_PRIVATE_KEY` (+ password nếu có) → bật `createUpdaterArtifacts` → Tauri tự ký installer + sinh `.sig`
  - Push tag `v*` → tạo GitHub Release (draft) kèm installer + `latest.json` (Windows: `*-setup.exe`; macOS: `*.app.tar.gz` — không dùng .dmg cho updater)
- **Đã xóa** workflow cũ `build-release.yml` (Windows-only, xung đột với build.yml khi cùng trigger tag `v*`)

**Cách release bản mới:**
  1. Bump version ở `package.json` + `src-tauri/tauri.conf.json` + `src-tauri/Cargo.toml` (khớp nhau)
  2. Push commit → push tag `v<version>` (vd `v1.11.5`)
  3. GitHub Actions build + tạo Release draft → kiểm tra rồi bấm Publish
  4. App cài sẵn tự nhận bản mới qua endpoint `releases/latest/download/latest.json`

### 5. UX improvements
- **Thiếu "Select Folder" button** (đã nói ở mục 2)
- **Animation ping indicator không dừng** — server card có `animate-ping-slow` nhưng vẫn chạy kể cả khi component unmount (không critical)
- **Log viewer không auto-scroll** khi đang ở tab khác — `useEffect` chỉ scroll `logEndRef` nhưng nếu user đã scroll lên trên thì không nên auto-scroll xuống. Cần logic: chỉ scroll nếu user đang ở bottom (threshold < 50px).
- **Status bar "Backend unavailable" → nên có retry** — nếu fetch `/api/projects` thất bại, tự động retry mỗi 3s (đã có interval), nhưng nên hiển thị "Reconnecting..." thay vì "Backend unavailable".
- **Thêm tray icon tooltip động** — hiển thị số lượng server đang chạy (ví dụ: "Server Dashboard (2/2 running)"). Hiện tại chỉ "Server Dashboard".

### 6. Security
- **Path Traversal trong clear-cache** — đã fix bằng `str(target).startswith(str(proj_path.resolve()))`. Verify lại.
- **Không có rate limiting** — API không có giới hạn, ai cũng gọi được nếu biết port 5050. Nên thêm middleware IP whitelist (127.0.0.1 only).

## Hướng dẫn build
```powershell
# Build frontend
cd TauriDashboard
npm run build

# Build Tauri app (cần signing key)
$env:TAURI_SIGNING_PRIVATE_KEY = Get-Content "$env:USERPROFILE\.tauri\server-dashboard.key" -Raw
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = ""
npm run tauri build

# Output:
#   src-tauri/target/release/server-dashboard.exe
#   src-tauri/target/release/bundle/msi/Server Dashboard_1.0.0_x64_en-US.msi
#   src-tauri/target/release/bundle/nsis/Server Dashboard_1.0.0_x64-setup.exe
```

## Test backend độc lập (không cần Tauri)
```powershell
cd TauriDashboard
python backend/app.py 5050
# Mở http://127.0.0.1:5050/api/projects
```

## Comment trong code
Đã có comment tiếng Việt ở:
- `src-tauri/Cargo.toml` — giải thích `tauri-plugin-updater`, cách tạo keypair
- `src-tauri/src/lib.rs` — updater plugin, project root detection
- `backend/app.py` — config storage, migration
- `src/App.tsx` — checkUpdate function
