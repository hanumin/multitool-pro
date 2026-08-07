# Task 3 Brief: IPC Event Communication & Auto-Hide Behavior

## Goal
Ensure seamless communication between `tray_menu` window, `main` window, and Rust backend. Auto-hide `tray_menu` on blur, and ensure menu item clicks invoke the proper actions on `main` window.

## Target Files
- Modify: `src/tray/TrayMenu.tsx`
- Modify: `src-tauri/src/lib.rs`

## Step-by-Step Requirements

1. **`src/tray/TrayMenu.tsx` IPC actions**:
   - `openDashboard(moduleId?: string)`:
     - Show & focus `main` window.
     - If `moduleId` is provided:
       - If `moduleId === 'settings'`, call `mainWindow.eval('window.__openSettings?.()')`.
       - Else call `mainWindow.eval("window.__navigateModule?.('" + moduleId + "')")`.
     - Hide `tray_menu` window.
   - `handleStartAll()`:
     - Call `mainWindow.eval('window.__startAll?.()')`
     - Hide `tray_menu` window.
   - `handleStopAll()`:
     - Call `mainWindow.eval('window.__stopAll?.()')`
     - Hide `tray_menu` window.
   - `handleToggleAudioWidget()`:
     - Call `toggleAudioWidget({ width: 200, height: 200 })`
     - Update local toggle state.
   - `handleQuit()`:
     - Invoke exit via `@tauri-apps/plugin-process` or Rust `app.exit(0)`.

2. **Auto-Hide on Blur (`src/tray/TrayMenu.tsx`)**:
   Add window event listener for blur / focus-out:
   ```tsx
   useEffect(() => {
     let unlisten: (() => void) | undefined;
     import('@tauri-apps/api/window').then(({ getCurrentWindow }) => {
       const win = getCurrentWindow();
       win.listen('tauri://blur', () => {
         win.hide();
       }).then(un => { unlisten = un; });
     });
     return () => { if (unlisten) unlisten(); };
   }, []);
   ```

3. **Status Fetching**:
   Fetch running services count from backend or Flask API dynamically if available (`http://127.0.0.1:5050/api/status` or `window.__serverStatus`).

## Report Contract
Save task report to `.superpowers/sdd/2026-08-07-tray-menu-redesign/task-3-report.md`.
Status values: DONE, DONE_WITH_CONCERNS, NEEDS_CONTEXT, BLOCKED.
