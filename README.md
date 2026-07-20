<div align="center">

# 🖥️ Server Dashboard

**Công cụ quản lý dự án, máy in, âm thanh & sao chép tập tin — tất cả trong một**

![Version](https://img.shields.io/badge/phi%C3%AAn%20b%E1%BA%A3n-1.6.0-emerald)
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

| Thành phần | Yêu cầu |
|-----------|---------|
| 🖥 Hệ điều hành | Windows 10 / Windows 11 (64-bit) |
| 🐍 Python | 3.8+ (chạy backend API) |
| 📦 Node.js | 18+ (cho frontend build) |
| 🖨 Máy in | Tùy chọn (nếu dùng Printer Module) |
| 🎤 Mic | Tùy chọn (nếu dùng Audio Module) |

### Thư viện Python bắt buộc

```bash
pip install flask flask-cors psutil
```

Cho Printer Module (tùy chọn):
```bash
pip install pywin32 pywin32-com
```

Cho Audio Module (tùy chọn):
```bash
pip install pycaw comtypes sounddevice
```

---

## 🚀 Cài đặt & Chạy

### Cách 1: Cài đặt từ file build (Khuyên dùng)

Tải file `.msi` hoặc `.exe` từ [Releases](https://github.com/NguyenThanhDat2410/server-dashboard/releases) và chạy.

File cài đặt sẽ tự động:
1. Cài đặt Python + thư viện (nếu chưa có)
2. Tạo shortcut Start Menu + Desktop
3. Cấu hình backend chạy ngầm

### Cách 2: Chạy từ mã nguồn

```bash
# Clone repo
git clone https://github.com/NguyenThanhDat2410/server-dashboard.git
cd server-dashboard

# Cài đặt frontend
npm install

# Build frontend
npm run build

# Chạy backend
cd backend
pip install flask flask-cors psutil
python app.py &

# Mở trình duyệt
start http://127.0.0.1:5050
```

### Cách 3: Build Tauri app

```bash
# Yêu cầu: Rust + Tauri CLI
npm install -g @tauri-apps/cli
npm run tauri build
```

File output tại:
- MSI: `src-tauri/target/release/bundle/msi/Server Dashboard_x64_en-US.msi`
- EXE: `src-tauri/target/release/bundle/nsis/Server Dashboard_x64-setup.exe`

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
server-dashboard/
├── backend/           # Python Flask API
│   └── app.py         # Main backend server
├── src/               # React frontend (TypeScript)
│   ├── App.tsx        # Root component
│   ├── index.css      # Global styles
│   ├── types/         # TypeScript interfaces
│   └── components/
│       ├── Sidebar.tsx
│       ├── Header.tsx
│       ├── Footer.tsx
│       ├── SettingsModal.tsx
│       ├── ChangelogModal.tsx
│       └── modules/
│           ├── ServersModule.tsx    # Quản lý dự án
│           ├── PrintersModule.tsx   # Quản lý máy in
│           ├── AudioModule.tsx      # Quản lý âm thanh
│           └── FileCopierModule.tsx # Sao chép tập tin
├── src-tauri/         # Tauri desktop wrapper
│   ├── src/lib.rs     # Rust backend
│   ├── icons/         # App icons
│   ├── tauri.conf.json
│   └── Cargo.toml
├── scripts/           # Utility scripts
├── dist/              # Built frontend
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

### v1.6.0 (14/07/2026)
- 🇻🇳 **Việt hoá 100%** toàn bộ UI
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
  <p>Built with ❤️ by <a href="https://github.com/NguyenThanhDat2410">NguyenThanhDat2410</a></p>
  <p>
    <a href="https://github.com/NguyenThanhDat2410/server-dashboard/issues">Báo cáo lỗi</a>
    ·
    <a href="https://github.com/NguyenThanhDat2410/server-dashboard/issues">Đề xuất tính năng</a>
  </p>
</div>
