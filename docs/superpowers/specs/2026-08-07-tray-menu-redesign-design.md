# Design Spec: System Tray Context Menu Redesign

**Date:** 2026-08-07  
**Target Application:** MultiTool Pro (Tauri v2 + React)  
**Status:** Approved  

---

## 1. Overview
The standard native Windows system tray context menu in Tauri v2 (`tauri::menu::MenuBuilder`) enforces an awkward 24px left gutter/whitespace (reserved for checkmarks/icons in Win32 API). This design replaces the native context menu with a custom, borderless, transparent webview popup window (`tray-menu`).

The new tray menu adopts Windows 11 Fluent UI / Glassmorphism aesthetic with zero excess left padding, precise alignment, interactive status badges, quick server batch controls, audio widget toggles, and direct module navigation.

---

## 2. Architecture & Window Lifecycle

### 2.1 Rust / Tauri Backend (`src-tauri/src/lib.rs` & `tauri.conf.json`)
- **Plugin Dependency**: Add `tauri-plugin-positioner` for tray icon coordinate calculation.
- **Window Configuration (`tray-menu`)**:
  - `label`: `"tray_menu"`
  - `url`: `"/tray.html"` or `"/?window=tray"`
  - `decorations`: `false`
  - `transparent`: `true`
  - `always_on_top`: `true`
  - `resizable`: `false`
  - `skip_taskbar`: `true`
  - `visible`: `false`
  - `width`: `300`
  - `height`: `420`
- **Tray Event Handler**:
  - Right-click or Left-click on tray icon toggles `tray_menu` window visibility.
  - Position window near tray icon using `tauri_plugin_positioner::on_tray_event` or position calculation.
- **Auto-Hide on Focus Loss (`blur`)**:
  - Lacking focus (user clicks elsewhere on screen) immediately hides `tray_menu` window.

---

## 3. Frontend Implementation (`src/tray/` or `widget.html` / dedicated component)

### 3.1 Styling System (Windows 11 Mica Glassmorphism)
- **Container Styling**:
  - `backdrop-filter: blur(24px) saturate(180%)`
  - Background: `rgba(20, 20, 25, 0.85)`
  - Border: `1px solid rgba(255, 255, 255, 0.12)`
  - Border Radius: `12px`
  - Box Shadow: `0 16px 32px rgba(0, 0, 0, 0.45)`
- **Alignment**:
  - Padding: `8px` around menu items.
  - Item Padding: `8px 12px` horizontal/vertical.
  - **Zero extra left gutter margin**: Icon and text are cleanly aligned directly to the item boundary.

### 3.2 Menu Components Structure
1. **Header Bar**:
   - Application Name: **MultiTool Pro**
   - Version Badge: **v1.11.3**
   - Running Status Pill: `● X/Y Running` with pulsing glow.
2. **Quick Actions**:
   - Nút "Mở Dashboard" (Primary action)
   - Dual batch controls: "Bắt đầu tất cả" (Green accent) & "Dừng tất cả" (Red accent)
3. **Module Quick Navigation**:
   - 7 Items: Máy chủ Web, Máy in, Âm thanh Studio, Cloudflare Tunnel, Cơ sở dữ liệu, Terminal Logs, Sao chép tập tin.
   - Clean Lucide SVG icons + crisp text + hover effect (`rgba(255, 255, 255, 0.08)`).
4. **Utilities & Toggles**:
   - Switch Toggle cho "Widget Âm thanh"
   - Cài đặt, Kiểm tra cập nhật, Giới thiệu
5. **Footer**:
   - Divider line
   - "Thoát ứng dụng" (Quit with red hover state).

---

## 4. Interaction & Communication
- IPC Commands / Window Evaluations:
  - Menu actions emit events or call `window.eval()` / Tauri `emit()` to control the main window (`main`) and backend commands.
