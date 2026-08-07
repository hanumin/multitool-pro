# Tray Menu Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign system tray context menu into a modern Windows 11 Fluent UI frameless popup window, eliminating left margin whitespace and adding interactive features.

**Architecture:** Create a transparent frameless webview window (`tray_menu`), position it near the tray icon using `tauri-plugin-positioner` (or position math), handle `blur` event for auto-hiding, and render a dedicated HTML page (`tray.html` + `TrayMenu.tsx`) styled with glassmorphism CSS.

**Tech Stack:** Tauri v2 (Rust), React 18, Vite, TypeScript, TailwindCSS / Custom CSS.

## Global Constraints

- **Window Label:** `tray_menu`
- **Entry File:** `tray.html`
- **Zero Whitespace Gutter:** No left margin/gutter before labels or icons.
- **Glassmorphism Backdrop:** `backdrop-filter: blur(24px) saturate(180%)`

---

### Task 1: Rust Backend & Positioner Plugin Configuration

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/capabilities/default.json`
- Modify: `src-tauri/src/lib.rs`
- Modify: `vite.config.ts`

**Interfaces:**
- Consumes: Tauri Tray Events
- Produces: `tray_menu` window setup, `tauri-plugin-positioner` init, window event handlers.

- [ ] **Step 1: Add positioner plugin to `src-tauri/Cargo.toml`**

Add `tauri-plugin-positioner = { version = "2.0", features = ["tray-icon"] }` to `[dependencies]`.

- [ ] **Step 2: Add permission to `src-tauri/capabilities/default.json`**

Add `"positioner:default"` to `permissions`.

- [ ] **Step 3: Update `vite.config.ts` multi-page input**

Add `tray: resolve(__dirname, 'tray.html')` to `build.rollupOptions.input`.

- [ ] **Step 4: Update Rust tray logic in `src-tauri/src/lib.rs`**

Replace native `MenuBuilder` with frameless window `tray_menu` toggle on tray icon click. Add `on_tray_event` and `blur` event listener to auto-hide `tray_menu`.

---

### Task 2: Create Frameless HTML Entry & `TrayMenu.tsx` Component

**Files:**
- Create: `tray.html`
- Create: `src/tray/main.tsx`
- Create: `src/tray/TrayMenu.tsx`
- Create: `src/tray/tray.css`

**Interfaces:**
- Consumes: Tauri Webview Window API, Flask Backend status
- Produces: Glassmorphism Tray Menu UI

- [ ] **Step 1: Create `tray.html`**

HTML boilerplate referencing `src/tray/main.tsx`.

- [ ] **Step 2: Create `src/tray/tray.css`**

Add Mica/Glassmorphism styling, zero left-margin layout, custom scrollbar, animations.

- [ ] **Step 3: Create `src/tray/TrayMenu.tsx`**

Build Windows 11 Fluent UI menu layout with:
- Header: App name, version, active status pill
- Quick action buttons (Start All, Stop All, Open Dashboard)
- 7 Module list items with SVG icons
- Audio Widget toggle switch
- Settings, Update, About, Quit actions.

- [ ] **Step 4: Create `src/tray/main.tsx`**

React root render for `TrayMenu.tsx`.

---

### Task 3: IPC Event Communication & Auto-Hide Behavior

**Files:**
- Modify: `src/tray/TrayMenu.tsx`
- Modify: `src-tauri/src/lib.rs`

**Interfaces:**
- Consumes: Tauri IPC (`invoke`, `WebviewWindow`)
- Produces: Seamless cross-window navigation and backend control

- [ ] **Step 1: Wire window focus & blur hide events**

Listen to `tauri://blur` event in `TrayMenu.tsx` / `lib.rs` to call `getCurrentWindow().hide()`.

- [ ] **Step 2: Wire action handlers**

Implement `openDashboard`, `navigateModule(module)`, `startAll`, `stopAll`, `toggleAudioWidget`, `openSettings`, `checkUpdates`, `openAbout`, `quitApp`.

---

### Task 4: Build Verification & Testing

- [ ] **Step 1: Test Vite build**

Run `npm run build` to verify multi-page bundle (`index.html`, `widget.html`, `tray.html`).

- [ ] **Step 2: Test Rust compilation**

Run `npm run tauri build -- --no-bundle` or cargo check to ensure clean compilation.
