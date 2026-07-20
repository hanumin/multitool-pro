# 🎯 MultiTool Pro - Server Tab Cải tiến Plan

> Plan tổng thể bao gồm fix bug + thêm tính năng mới cho Server Tab
> Tạo ngày: 20/07/2026

---

## Phase 1: 🐛 Fix Bugs (Critical)

### BUG 1: npm install blocking API response
- **File:** `backend/app.py` → `api_start()`
- **Vấn đề:** `subprocess.run(["npm", "install"])` đồng bộ, block API response 30s+
- **Fix:** Chạy npm install bất đồng bộ bằng thread, trả về response ngay

### BUG 2: Log scroll auto-scroll không đúng
- **File:** `src/components/modules/ServersModule.tsx`
- **Vấn đề:** `scrollIntoView({ behavior: 'smooth' })` làm user không đọc kịp log realtime
- **Fix:** Đổi sang `behavior: 'instant'`, chỉ smooth khi chuyển tab

### BUG 3: Stop project kill port có thể kill nhầm PID
- **File:** `backend/app.py` → `api_stop()`
- **Vấn đề:** Parse netstat output bằng split() thiếu chính xác, dễ kill nhầm system process
- **Fix:** Dùng `psutil` để tìm đúng PID theo port, kiểm tra process name

### BUG 4: Diagnostics polling không cleanup khi project bị xóa
- **File:** `src/components/modules/ServersModule.tsx`
- **Vấn đề:** Interval vẫn chạy API call đến project không tồn tại
- **Fix:** Thêm cleanup check, xóa interval khi unmount hoặc project list thay đổi

---

## Phase 2: ⚡ Batch Actions & Quick Operations

### FEATURE 1: Batch Actions UI (Start/Stop/Restart All)
- **File:** `src/components/modules/ServersModule.tsx`
- **Mô tả:** Thêm toolbar buttons để Start All / Stop All / Restart All
- **Backend:** Thêm API `/api/projects/start-all`, `/api/projects/stop-all`, `/api/projects/restart-all`
- **Giao diện:** Buttons ở header area, có progress indicator

### FEATURE 2: Port Scanner - Phát hiện conflict
- **File:** `backend/app.py` + `ServersModule.tsx`
- **Mô tả:** Quét port nào đang được dùng bởi process nào
- **Backend:** API `/api/system/port-scan?ports=4000,4001,...`
- **Giao diện:** Badge cảnh báo conflict trên card, tooltip chi tiết

### FEATURE 3: Log Search/Filter
- **File:** `src/components/modules/ServersModule.tsx`
- **Mô tả:** Thanh search + filter trong Log Viewer
- **Giao diện:** Input search + highlight matches + filter level (info/warn/error)

### FEATURE 4: Quick Open File Explorer
- **File:** `src/components/modules/ServersModule.tsx`
- **Mô tả:** Button mở thư mục project trong Windows Explorer
- **Cách:** Dùng `@tauri-apps/plugin-shell` open() hoặc `explorer.exe` backend

---

## Phase 3: 🛠 Developer Tools

### FEATURE 5: Quick SSL với mkcert
- **File:** `backend/app.py` + `ServersModule.tsx`
- **Mô tả:** Tạo self-signed SSL cert 1 click cho project
- **Cách:** Dùng `mkcert` CLI (kiểm tra nếu chưa cài → hướng dẫn)
- **Kết quả:** Tạo `localhost.pem` + `localhost-key.pem` trong thư mục project

### FEATURE 6: Uptime Tracker + Notification on Crash
- **File:** `backend/app.py` + `ServersModule.tsx`
- **Mô tả:** 
  - Uptime: Hiển thị thời gian server đã chạy
  - Crash detection: Phát hiện khi process crash → toast notification + auto-restart option

### FEATURE 7: Performance History Chart
- **File:** `ServersModule.tsx` (thêm chart component)
- **Mô tả:** Lưu memory/cpu usage history, vẽ mini line chart
- **Cách:** Dùng canvas hoặc SVG đơn giản (không cần thư viện)

---

## Phase 4: 🎯 Tiện ích bổ sung

### FEATURE 8: Quick npm Scripts UI
- **File:** `ServersModule.tsx` + `backend/app.py`
- **Mô tả:** Đọc `package.json` scripts → dropdown chạy nhanh (build, lint, test)
- **Backend:** API `/api/projects/<name>/scripts` đọc scripts từ package.json

### FEATURE 9: Clean Node Modules với Size Display
- **File:** `ServersModule.tsx` + `backend/app.py`
- **Mô tả:** Hiển thị dung lượng node_modules trước khi clean
- **Backend:** API `/api/projects/<name>/disk-usage` trả về size các folder
- **Giao diện:** Tooltip size + warning nếu > 500MB

---

## 📋 Tiến độ

| Phase | Task | Status |
|---|---|---|
| P1 | BUG 1: npm install async | ✅ |
| P1 | BUG 2: Log scroll behavior | ✅ |
| P1 | BUG 3: Kill port chính xác | ✅ |
| P1 | BUG 4: Diagnostics cleanup | ✅ |
| P2 | FEATURE 1: Batch Actions | ✅ |
| P2 | FEATURE 2: Port Scanner | ✅ |
| P2 | FEATURE 3: Log Search | ✅ |
| P2 | FEATURE 4: File Explorer | ✅ |
| P3 | FEATURE 5: Quick SSL | ✅ |
| P3 | FEATURE 6: Uptime + Notifications | ✅ |
| P3 | FEATURE 7: Performance Chart | ✅ |
| P4 | FEATURE 8: Quick npm Scripts | ✅ |
| P4 | FEATURE 9: Size Display | ✅ |
| 🔧 | FIX 1: npm install race - chờ install xong mới start | ✅ |
| 🔧 | FIX 2: run-script không kill dev server | ✅ |
| 🔧 | FIX 3: Disk usage cache 60s TTL | ✅ |

---

## ✅ Hoàn thành

Tất cả tasks đã hoàn thành vào: 20/07/2026
