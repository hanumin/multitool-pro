<div align="center">

# 🖥️ Server Dashboard

**Công cụ quản lý dự án, máy in, âm thanh & sao chép tập tin — tất cả trong một**

![Version](https://img.shields.io/badge/phi%C3%AAn%20b%E1%BA%A3n-1.11.4-emerald)
![Platform](https://img.shields.io/badge/n%E1%BB%81n%20t%E1%BA%A3ng-Windows%2010%2F11-blue)
![UI](https://img.shields.io/badge/giao%20di%E1%BB%87n-Ti%E1%BA%BFng%20Vi%E1%BB%87t-brightgreen)

</div>

---

## 📦 Tính năng chính

### 🚀 Quản lý Dự án (Servers Module)
- **Khởi động/dừng** dự án Node.js (npm run dev, next dev, vite...)
- **Tự động** cài đặt `node_modules` nếu chưa có
- **Xem log** trực tiếp theo thời gian thực (SSE stream)
- **Clean cache**: Quick Cache, Deep Build, Nuke Reinstall
- **Biến môi trường**: Xem/sửa `.env.local` hoặc `.env`
- **Chẩn đoán**: RAM, CPU, Git branch, Node/npm version
- **Tự động khởi động** cùng Windows

### 🖨️ Quản lý Máy in (Printers Module)
- **Danh sách máy in**: Hiển thị tất cả máy in local + network
- **Trạng thái**: Sẵn sàng, Đang in, Lỗi, Hết giấy, Kẹt giấy, Ngoại tuyến
- **Phát hiện tự động**: Poll spooler mỗi 5 giây → tự động ghi nhận lệnh in hoàn thành
- **Thống kê in ấn**: Tổng số lần in, lần in gần nhất, tài liệu gần đây
- **LASER detection**: Tự động phát hiện máy in laser → bỏ qua nhắc nhở + badge 🔲
- **Nhắc nhở thông minh**: Đếm ngược đến ngày in tiếp theo, cảnh báo đỏ khi quá hạn
- **Hàng đợi in**: Xem và xóa lệnh in đang chờ
- **In thử**: Gửi trang thử, tự động ghi nhận vào lịch sử

### 🎤 Quản lý Âm thanh & Mic (Audio Module)
- **Giám sát mic real-time**: Phát hiện ứng dụng đang dùng mic qua Registry
- **Bộ đếm phiên**: Tự động đếm giây khi mic hoạt động
- **Lịch sử phiên**: Lưu thời gian, ứng dụng, tên mic
- **Âm thanh báo**: Beep khi mic bật (nếu bật trong cài đặt)
- **Chế độ Widget**: Widget 200×200 kéo thả, hiển thị trạng thái + timer
- **Tự động hiện/ẩn widget**: Bật widget khi mic hoạt động, ẩn khi dừng
- **Độ mờ widget**: Thanh trượt từ 10% → 100%
- **Tùy chỉnh màu sắc**: Chọn màu active/inactive bằng color picker
- **Điều khiển thiết bị**: Mute/unmute, chỉnh âm lượng, đặt mặc định

### 📂 Sao chép tập tin (File Copier Module)
- **Tìm kiếm theo từ khóa**: Sao chép file âm thanh/video theo danh sách từ khóa
- **6 thư mục nguồn**: Audio Tách Ghép Âm, Video Tách Ghép Âm, Audio Đọc 1 Lần, Từ điển...
- **Chế độ xử lý xung đột**: Ghi đè, Bỏ qua, hoặc Đổi tên
- **Xác minh MD5**: Đảm bảo file sao chép không bị lỗi
- **Chạy thử (Dry Run)**: Xem trước kết quả mà không sao chép thật
- **Nhật ký chi tiết**: Hiển thị tiến trình real-time

### 🎨 Giao diện
- **100% tiếng Việt**: Toàn bộ UI, modal, thông báo
- **Hỗ trợ Dark/Light mode**: Chuyển đổi mượt mà
- **Responsive**: Tối ưu cho nhiều kích thước cửa sổ
- **Micro-interactions**: Hover, transition, active scale

---

## 🖼️ Ảnh chụp màn hình

> *(Chưa có ảnh — bạn có thể thêm sau)*

---

## ⚙️ Yêu cầu hệ thống

### 🖥 Người dùng cuối (chạy bản release)

| Thành phần | Yêu cầu |
|-----------|---------|
| 🖥 Hệ điều hành | Windows 10 / Windows 11 (64-bit) |
| 🐍 Python | ✅ **Không cần** — backend đã đóng gói sẵn trong file build |
| 🖨 Máy in | Tùy chọn (nếu dùng Printer Module) |
| 🎤 Mic | Tùy chọn (nếu dùng Audio Module) |

### 🛠 Nhà phát triển (build từ mã nguồn)

| Thành phần | Yêu cầu |
|-----------|---------|
| 🖥 Hệ điều hành | Windows 10 / Windows 11 (64-bit) |
| 🐍 Python | 3.10+ (chạy backend API + PyInstaller) |
| 📦 Node.js | 18+ (cho frontend build) |
| 🦀 Rust | stable (cho Tauri build) |

### Thư viện Python bắt buộc

```bash
pip install -r backend/requirements.txt
```

Bao gồm: `flask`, `flask-cors`, `psutil`, `pywin32`, `requests`, `psycopg2-binary`, `mysql-connector-python`, `pycaw`

Cài PyInstaller (chỉ cần khi build portable):
```bash
pip install pyinstaller
```

---

## 🚀 Cài đặt & Chạy

### Cách 1: Cài đặt từ file build (Khuyên dùng)

Tải file `.msi` hoặc `.exe` từ [Releases](https://github.com/hanumin/multitool-pro/releases) và chạy.

> ✅ Bản build mới **đóng gói cả backend Python** — người dùng cuối **không cần cài Python hay thư viện**. App chạy khép kín, backend tự giải nén và chạy ngầm ở `%LOCALAPPDATA%\multitool-pro\`.

File cài đặt sẽ tự động:
1. Tạo shortcut Start Menu + Desktop
2. Cấu hình backend chạy ngầm

### Cách 2: Chạy từ mã nguồn

```bash
# Clone repo
git clone https://github.com/hanumin/multitool-pro.git
cd multitool-pro

# Cài đặt frontend
npm install

# Build frontend
npm run build

# Cài backend deps + chạy backend
pip install -r backend/requirements.txt
python backend/app.py &

# Mở trình duyệt
start http://127.0.0.1:5050
```

### Cách 3: Build installer (NSIS/MSI)

```bash
# Yêu cầu: Rust + Tauri CLI
npm install -g @tauri-apps/cli
npm run tauri build
```

File output tại (`<version>` lấy từ `src-tauri/tauri.conf.json`):
- MSI: `src-tauri/target/release/bundle/msi/MultiTool Pro_<version>_x64_en-US.msi`
- EXE: `src-tauri/target/release/bundle/nsis/MultiTool Pro_<version>_x64-setup.exe`

> ⚠️ **Lưu ý quan trọng**: `npm run tauri build` trần sẽ chạy với `backend-embed/backend.exe` **placeholder rỗng** nếu chưa chạy PyInstaller (build.rs tự tạo placeholder để code compile được + cảnh báo). Installer tạo ra sẽ **không có backend bên trong** — dùng **Cách 4** để build đúng chuẩn khép kín.

### Cách 4: Build portable khép kín 1 file (Khuyên dùng cho dev)

Bản portable = **1 file `.exe` duy nhất** chứa cả frontend + backend Python + mọi dependency. Chạy được ngay trên máy Windows bất kỳ, **không cần cài Python**, không cần cài đặt.

```powershell
# Chạy từ thư mục gốc project (PowerShell)
./build-portable.ps1
```

Pipeline tự động gồm 4 bước:
1. **`npm run build`** → build frontend ra `dist/`
2. **PyInstaller** → đóng gói `backend/app.py` + Flask + toàn bộ dependency thành `backend.exe` (~38 MB, nhúng cả `dist/`, `auto-start.ps1`, `printer-monitor/`)
3. **Embed** → copy `backend.exe` vào `src-tauri/backend-embed/` để `include_bytes!` nhúng thẳng vào binary Rust
4. **`npx tauri build --no-bundle`** → sinh portable exe + copy vào `release/portable/`

**Output** (`<version>` lấy từ `src-tauri/tauri.conf.json`):

```
release/portable/MultiTool Pro_<version>_x64.exe   (~47 MB)
```

**Cơ chế chạy khép kín:** khi app khởi động, Rust giải nén backend từ bytes nhúng ra `%LOCALAPPDATA%\multitool-pro\backend\backend.exe` (chỉ ghi khi thiếu/đổi kích thước) rồi spawn. Debug build ưu tiên chạy `python` từ source để dev nhanh; release build dùng backend nhúng.

> 💡 Dữ liệu người dùng (config, printer settings, debug.log) vẫn nằm ở `%APPDATA%\multitool-pro\` — cài bản mới **không mất dữ liệu cũ**.
>
> 🔄 Sau khi build, nếu bản cũ đang chạy sẽ **lock file** → đóng app (hoặc chạy `scripts/cleanup-portable-test.ps1`) trước khi build lại.

---

### Build tự động trên GitHub Actions (CI)

Workflow `.github/workflows/build.yml` build release đa nền tảng (Windows x64 + macOS universal2):

| Trigger | Kết quả |
|---------|---------|
| Push `main` | Build portable + installer NSIS/MSI → upload **artifact** |
| Push tag `v*` | Tạo **GitHub Release** kèm installer + `latest.json` (auto-update) |
| Bấm **Run workflow** | Build thủ công từ GitHub UI |

Pipeline CI giống hệt `build-portable.ps1`: npm build → PyInstaller → embed → `tauri build` (Windows: NSIS/MSI + portable; macOS: .app + .dmg universal). Khi push tag `v*`, workflow tạo GitHub Release kèm installer + `latest.json` (auto-update).

> 🔑 **Auto-update cần signing key**: tạo key bằng `npx tauri signer generate -w ~/.tauri/multitool-pro.key`, thêm vào GitHub Secrets với tên `TAURI_SIGNING_PRIVATE_KEY` (+ `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` nếu có). Có key → Tauri tự ký installer và sinh `.sig` → `latest.json` được tạo → app đã cài tự nhận bản mới. Không có key → CI vẫn build + release bình thường, chỉ thiếu auto-update.

---

## 🔐 Đăng nhập & Quản lý tài khoản (Supabase Auth)

App dùng **Supabase Auth dùng chung** với hệ sinh thái (web english-topics — cùng 1 pool tài khoản). Đăng nhập 1 nơi, dùng được ở mọi nơi trong hệ sinh thái.

### Kiến trúc

```
┌─────────────────────────┐        ┌──────────────────────────────┐
│  App desktop (Tauri)     │        │  Web english-topics          │
│  - Supabase anon key     │──auth──▶  - Supabase anon key (client) │
│    (nhúng, public)       │        │  - SERVICE ROLE key (server)  │
└────────────┬────────────┘        └──────────────┬───────────────┘
             │                                    │
             └──────────────▶  Supabase Auth (xjfttrbucggqieykjqxu)  ◀────┘
                               • 1 pool tài khoản dùng chung
                               • RLS bảo vệ dữ liệu từng app
```

- **URL + anon key** là PUBLIC keys (thiết kế chính thức của Supabase cho client) — an toàn khi nhúng trong app.
- **Service role key TUYỆT ĐỐI không được nhúng vào app** — chỉ nằm trên server web (Vercel) vì nó vô hiệu hóa RLS.

### Màn hình đăng nhập

- **Email + mật khẩu** (có tùy chọn **Duy trì đăng nhập** — session giữ qua các lần mở app)
- **Quên mật khẩu**: kiểm tra email đã đăng ký chưa (gọi endpoint web `POST /api/auth/check-email` — service role key nằm server-side, không lộ ra app) → email thật mới gửi link đặt lại mật khẩu
- Avatar sidebar: nhấn vào → popup đổi avatar + đăng xuất + đổi mật khẩu

### Cấu hình bắt buộc (chỉ quản trị viên làm)

**1. Supabase Dashboard** → Authentication → URL Configuration:

| Mục | Giá trị |
|-----|---------|
| Site URL | `https://english.luongphamhanhnguyen.com` |
| Redirect URLs | `https://english.luongphamhanhnguyen.com/**` (thêm cả path `/forgot-password` nếu cần) |

> ⚠️ Nếu thiếu, link đặt lại mật khẩu trong email sẽ fallback về `localhost:3000` — user không đặt lại được mật khẩu.

**2. Vercel (web project) — Environment Variables (Production):**

```
NEXT_PUBLIC_SITE_URL=https://english.luongphamhanhnguyen.com
```

> Dùng cho route `POST /api/auth/forgot-password` (web) tạo link khôi phục đúng domain. Sau khi đổi env → **redeploy production**.

### Thay đổi project Supabase (dùng project khác)

Sửa 2 chỗ trong `src/lib/supabase.ts`: `SUPABASE_URL` + `SUPABASE_ANON_KEY`, và đổi endpoint `CHECK_EMAIL_API` trong `src/components/LoginScreen.tsx` (nếu dùng web khác).

---

## 📖 Hướng dẫn sử dụng

### Bảng điều khiển (Dashboard)
- Thanh bên trái: chọn module
- Thanh trạng thái dưới cùng: hiển thị thông báo hệ thống
- Góc phải: cài đặt chung, chế độ sáng/tối, thu gọn xuống tray

### Quản lý dự án
1️⃣ **Thêm dự án**: Cài đặt → "Thêm dự án" → nhập tên, đường dẫn, cổng, lệnh
2️⃣ **Khởi động**: Click nút Play bên cạnh dự án
3️⃣ **Xem log**: Click vào tab dự án để xem log real-time
4️⃣ **Dừng**: Click nút Stop
5️⃣ **Clean**: Click "Dọn dẹp" → chọn mức độ (Quick Cache / Deep Build / Nuke Reinstall)
6️⃣ **Biến môi trường**: Click "Biến môi trường" → sửa `.env.local`

### Quản lý máy in
1️⃣ Mở module **Máy in** → danh sách máy in tự động tải
2️⃣ **Theo dõi**: App tự động chọn máy in mặc định, click vào máy in bất kỳ để đổi
3️⃣ **In thử**: Click "🖨 In thử" (chỉ với máy in không phải laser)
4️⃣ **Hàng đợi**: Click "📋 Hàng đợi in" → xem/xóa lệnh
5️⃣ **Thống kê**: Click "📊 Thống kê" → xem tổng số lần in
6️⃣ **Cài đặt**: Điều chỉnh số ngày giữa 2 lần in, thời gian nhắc lại

> 💡 Máy in laser (tên chứa "laser") được tự động phát hiện và bỏ qua nhắc nhở.

### Quản lý âm thanh
1️⃣ Mở module **Âm thanh** → xem trạng thái mic real-time
2️⃣ **Bộ đếm**: Tự động đếm khi mic hoạt động
3️⃣ **Lịch sử**: Click "📋 Lịch sử" → xem các phiên trước
4️⃣ **Widget**: Click "🔲 Thu nhỏ" → widget 200×200 xuất hiện, có thể kéo thả
5️⃣ **Cài đặt**: Click "⚙️ Cài đặt" → tùy chỉnh:
   - Âm thanh báo khi mic bật
   - Hiện/ẩn widget tự động khi mic bật/tắt
   - Độ mờ widget (10% → 100%)
   - Màu active/inactive

> 💡 Widget tự động hiện khi mic hoạt động (nếu bật trong cài đặt).

### Sao chép tập tin
1️⃣ Mở module **Sao chép** → nhập từ khóa (thủ công hoặc từ file .txt)
2️⃣ Chọn thư mục nguồn (tối đa 6 thư mục)
3️⃣ Chọn thư mục đích
4️⃣ **Tùy chỉnh**: Đuôi file, xác minh MD5, chế độ xung đột
5️⃣ Click "🏃 Chạy thử" để xem trước
6️⃣ Click "📋 Bắt đầu sao chép" để thực hiện

---

## 🏗 Cấu trúc thư mục

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
│   ├── src/lib.rs        # Rust — spawn backend (nhúng / fallback python)
│   ├── build.rs          # Đảm bảo backend-embed/backend.exe tồn tại để nhúng
│   ├── backend-embed/    # backend.exe đã build (gitignored) → include_bytes!
│   ├── tauri.conf.json
│   └── Cargo.toml
├── scripts/              # Utility scripts (cleanup-portable-test.ps1, ...)
├── build-portable.ps1    # Build portable khép kín 1 file
├── .github/workflows/    # CI: ci.yml + why-check.yml + build.yml (build & release đa nền tảng)
├── release/              # Output: installers + portable/ (gitignored)
├── dist/                 # Built frontend
└── package.json
```

---

## 🔧 API Documentation

Backend chạy tại `http://127.0.0.1:5050`

### Dự án
| Method | Endpoint | Mô tả |
|--------|----------|-------|
| GET | `/api/projects` | Danh sách dự án |
| POST | `/api/projects/{name}/start` | Khởi động |
| POST | `/api/projects/{name}/stop` | Dừng |
| GET | `/api/projects/{name}/logs` | Lấy log |
| GET | `/api/projects/{name}/logs/stream` | Log real-time (SSE) |
| GET | `/api/projects/{name}/diagnostics` | Chẩn đoán (RAM, CPU, Git) |
| GET/PUT | `/api/projects/{name}/env` | Biến môi trường |
| POST | `/api/projects/{name}/clean` | Dọn dẹp |

### Máy in
| Method | Endpoint | Mô tả |
|--------|----------|-------|
| GET | `/api/printers` | Danh sách máy in |
| GET | `/api/printers/{name}/jobs` | Hàng đợi in |
| DELETE | `/api/printers/{name}/jobs` | Xóa hàng đợi |
| POST | `/api/printers/{name}/default` | Đặt mặc định |
| POST | `/api/printers/{name}/test` | In thử |
| GET | `/api/printer/stats` | Thống kê in ấn |
| GET | `/api/printer/activity` | Hoạt động in hiện tại |
| POST | `/api/printer/auto-detect` | Phát hiện in tự động |
| GET | `/api/printer/reminder-check` | Kiểm tra nhắc nhở |
| GET/POST | `/api/printer/settings` | Cài đặt máy in |
| GET/POST | `/api/printer/log` | Log in |
| GET/POST/DELETE | `/api/printer/history` | Lịch sử in |
| GET | `/api/printer/wmi-status` | Trạng thái WMI |

### Âm thanh
| Method | Endpoint | Mô tả |
|--------|----------|-------|
| GET | `/api/audio/devices` | Danh sách thiết bị |
| GET | `/api/audio/mic-status` | Trạng thái mic |
| POST | `/api/audio/devices/{id}/mute` | Bật/tắt mute |
| PUT | `/api/audio/devices/{id}/volume` | Chỉnh âm lượng |
| POST | `/api/audio/devices/{id}/default` | Đặt mặc định |
| GET/POST | `/api/audio/settings` | Cài đặt âm thanh |
| GET | `/api/audio/session-history` | Lịch sử phiên |
| POST | `/api/audio/session-log` | Ghi nhận phiên |
| GET | `/api/audio/sound-files` | Danh sách file âm thanh |

### Sao chép tập tin
| Method | Endpoint | Mô tả |
|--------|----------|-------|
| POST | `/api/file-copier/count` | Đếm file trong thư mục |
| POST | `/api/file-copier/read-keywords` | Đọc file từ khóa |
| POST | `/api/file-copier/run` | Thực hiện sao chép |

---

## 📝 Changelog

### v1.11.4 (11/08/2026)
- 📦 **Portable khép kín 1 file**: backend Python (Flask + mọi dependency) đóng gói bằng PyInstaller → nhúng trực tiếp vào binary Tauri (`include_bytes!`) → chạy **không cần cài Python**, 1 file `.exe` duy nhất (~47 MB)
- 🖥 **Tray menu Fluent UI**: menu khay hệ thống custom (glassmorphism, zero padding trái) — điều hướng module, Start/Stop All, toggle audio widget, auto-hide khi mất focus, IPC event bus (`tray-command`)
- 🖨 **LAN Printer Scan**: tự động quét mạng phát hiện máy in mới chưa cấu hình IP → Windows toast kèm nút "⚡ Gán IP" (deep-link mở thẳng tab Máy in), quét theo chu kỳ + retry khi gửi toast thất bại
- 🖨 **Vật tư & Supplies**: cấu hình IP máy in mạng → đọc tự động % toner/drum/ink qua SNMP (RFC 3805, thuần Python), hoặc nhập tay cho máy USB; ngưỡng cảnh báo vật tư thấp
- 🖨 **Background Print Listener**: phát hiện lệnh in hoàn thành bằng `FindFirstPrinterChangeNotification` (event-driven, bắt cả job laser <100ms) — không bỏ sót job khi UI ở tab khác
- ⚙️ **CI build release**: workflow GitHub Actions (`build.yml`) — npm build → PyInstaller → embed → tauri build (Windows NSIS/MSI + macOS universal) → artifact + GitHub Release + `latest.json` (auto-update có chữ ký) khi tag `v*`
- 🔧 `build-portable.ps1`: script build portable khép kín tự động toàn pipeline

> ⏳ Các mục LAN scan, supplies, listener, portable & CI workflow là tính năng **đang phát triển cho v1.11.4** (chưa phát hành chính thức).

### v1.11.3 (07/08/2026)
- 🎤 **Audio set-default v2 rewrite**: đặt mic mặc định hoạt động tin cậy (GUID Core Audio thay index thiết bị), verify đổi thành công với backoff retry, chống crash comtypes
- 🧩 Widget audio quản lý tập trung (`audioWidget.ts`) — đồng bộ trạng thái giữa module, tray menu & Rust

### v1.11.2 (28/07/2026)
- 🎨 **Major UI overhaul**: redesign server cards (compact footer, bỏ URL tunnel trùng), gom về 1 nút settings
- 🇻🇳 **Việt hoá 100%** toàn bộ UI (hoàn thiện triệt để so với bản trước)
- 🌐 Fix tunnel metrics polling (metrics không refresh đúng chu kỳ)
- 🖥 Servers: làm lại luồng theo dõi, batch actions & npm scripts runner cải tiến

### v1.9.10 (26/07/2026)
- 📐 Tăng window size + font chữ, sidebar responsive auto-collapse trên màn hình nhỏ

### v1.9.3 (20/07/2026)
- 🖨 **GDI printer detection**: tự nhận diện máy in GDI (host-based) → badge `driver_type`, bỏ qua EventLog không có dữ liệu, WMI fallback

### v1.9.2 (20/07/2026)
- 🖨 **Printer page count fixes**: module giám sát C#/PowerShell (XPath query nhanh), fix Properties[3]→[4] cho tên máy in (test thật Windows 11)

### v1.9.1 (20/07/2026)
- 🐛 Fix PermissionError khi start project, fix audio API 501, update dependencies

### v1.9.0 (20/07/2026)
- 🗄 **Database Export**: xuất dữ liệu CSV/JSON, SQL syntax highlighting
- 📋 **Logs Download**: tải log về máy, cải thiện accessibility

### v1.8.0 (20/07/2026)
- 🗄 **Database Manager**: kết nối SQLite/PostgreSQL/MySQL, SQL editor, xem bảng/dữ liệu
- ⚡ **Batch Actions**: Start/Stop/Restart All hàng loạt
- 🔍 **Port Scanner**: phát hiện xung đột cổng, Quick SSL
- 📋 **Log Search**: tìm kiếm log + npm Scripts runner
- 📊 **Performance History** + Disk Usage cache

### v1.6.0 (14/07/2026)
- 🇻🇳 **Việt hoá giao diện chính** (hoàn thiện toàn diện ở v1.11.2)
- 🖨 Printer: Watching tự động + auto-detect print + laser detection + thống kê
- 🎤 Audio: Auto show/hide widget, opacity slider, session timer
- 🔒 Single Instance Lock (chống chạy 2 cửa sổ)
- 🐛 Fix: `global` keyword, thread safety, Promise.all crash

### v1.5.0
- 🖨 Printer Module: WMI status, reminder, history
- 🎤 Audio Module: Widget mode, color themes, alert sound
- 🖼 Icon tùy chỉnh từ `icon.png`

### v1.4.0
- 📂 File Copier Module: Sao chép theo từ khóa, MD5, dry run
- ⚡ Optimize polling intervals

---

## 🤝 Đóng góp

Mọi đóng góp đều được hoan nghênh! Vui lòng:

1. Fork repo
2. Tạo branch mới (`git checkout -b feature/ten-tinh-nang`)
3. Commit thay đổi (`git commit -m 'Thêm tính năng X'`)
4. Push lên branch (`git push origin feature/ten-tinh-nang`)
5. Tạo Pull Request

---

## 📄 Giấy phép

Dự án được phân phối dưới giấy phép **MIT**.

---

<div align="center">
  <p>Built with ❤️ by <a href="https://github.com/hanumin">hanumin</a></p>
  <p>
    <a href="https://github.com/hanumin/multitool-pro/issues">Báo cáo lỗi</a>
    ·
    <a href="https://github.com/hanumin/multitool-pro/issues">Đề xuất tính năng</a>
  </p>
</div>
