# Task 1 Brief: Rust Backend & Positioner Plugin Configuration

## Goal
Configure `tauri-plugin-positioner` in Tauri v2 Rust backend, configure the `tray_menu` frameless window, and update Vite multi-page config for `tray.html`.

## Target Files
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/capabilities/default.json`
- Modify: `src-tauri/src/lib.rs`
- Modify: `vite.config.ts`

## Step-by-Step Requirements

1. **`src-tauri/Cargo.toml`**:
   Add `tauri-plugin-positioner` under `[dependencies]`:
   ```toml
   tauri-plugin-positioner = { version = "2.0", features = ["tray-icon"] }
   ```

2. **`src-tauri/capabilities/default.json`**:
   In `"permissions"`, add `"positioner:default"`.

3. **`vite.config.ts`**:
   In `build.rollupOptions.input`, add:
   ```ts
   tray: resolve(__dirname, 'tray.html')
   ```

4. **`src-tauri/src/lib.rs`**:
   - Register plugin: `.plugin(tauri_plugin_positioner::init())`
   - In `.setup()`:
     - Create `tray_menu` window:
       ```rust
       let _tray_window = tauri::WebviewWindowBuilder::new(
           app,
           "tray_menu",
           tauri::WebviewUrl::App("tray.html".into())
       )
       .title("MultiTool Pro Menu")
       .inner_size(300.0, 420.0)
       .decorations(false)
       .transparent(true)
       .always_on_top(true)
       .resizable(false)
       .skip_taskbar(true)
       .visible(false)
       .build()?;
       ```
     - Remove native `MenuBuilder` from `TrayIconBuilder` (we no longer use native Win32 `HMENU`).
     - In `.on_tray_icon_event`:
       ```rust
       tauri_plugin_positioner::on_tray_event(tray.app_handle(), &event);
       if let TrayIconEvent::Click { button: MouseButton::Right | MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
           if let Some(window) = tray.app_handle().get_webview_window("tray_menu") {
               use tauri_plugin_positioner::{Position, WindowExt};
               let _ = window.move_window(Position::TrayCenter);
               if window.is_visible().unwrap_or(false) {
                   let _ = window.hide();
               } else {
                   let _ = window.show();
                   let _ = window.set_focus();
               }
           }
       }
       ```
     - In `.on_window_event()`:
       When `window.label() == "tray_menu"` receives `tauri::WindowEvent::Focused(false)`, hide the window: `let _ = window.hide();`.

## Report Contract
Save task report to `.superpowers/sdd/2026-08-07-tray-menu-redesign/task-1-report.md`.
Status values: DONE, DONE_WITH_CONCERNS, NEEDS_CONTEXT, BLOCKED.
