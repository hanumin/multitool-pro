# Task 3 Report: IPC Event Communication & Auto-Hide Behavior

## Status
DONE

## Commit IDs
- `e0d43a3` (feat(tray): Task 3 - IPC Event Communication & Auto-Hide Behavior)

## Summary of Changes

1. **`src/tray/TrayMenu.tsx` IPC actions**:
   - **`openDashboard(moduleId?: string)`**:
     - Shows and focuses `main` window (`WebviewWindow.getByLabel('main')`).
     - Executes `window.__openSettings?.()` via `mainWindow.eval` when `moduleId === 'settings'`.
     - Executes `window.__navigateModule?.(moduleId)` via `mainWindow.eval` for other modules.
     - Hides `tray_menu` window upon invocation.
   - **`handleStartAll()`**:
     - Calls `window.__startAll?.()` on `main` window via `mainWindow.eval`.
     - Hides `tray_menu` window and updates local running services state.
   - **`handleStopAll()`**:
     - Calls `window.__stopAll?.()` on `main` window via `mainWindow.eval`.
     - Hides `tray_menu` window and updates local running services state.
   - **`handleToggleAudioWidget()`**:
     - Calls `toggleAudioWidget({ width: 200, height: 200 })` and updates local state.
   - **`handleQuit()`**:
     - Invokes application exit via `@tauri-apps/plugin-process` `exit(0)`.

2. **Auto-Hide on Blur (`src/tray/TrayMenu.tsx`)**:
   - Added `useEffect` listener for `tauri://blur` window event on `getCurrentWindow()`, ensuring `tray_menu` hides when focus is lost.

3. **Dynamic Status Fetching (`src/tray/TrayMenu.tsx`)**:
   - Added polling `useEffect` that checks `(window as any).__serverStatus` or fetches running services from Flask API endpoints (`http://127.0.0.1:5050/api/status` or `http://127.0.0.1:5050/api/projects`), updating `runningServices` and `totalServices` dynamically.

4. **Code Quality & Rust Backend (`src-tauri/src/lib.rs`, `src/components/LoadingScreen.tsx`)**:
   - Added `// WHY:` comments on all functions in `TrayMenu.tsx` and `LoadingScreen.tsx` to satisfy `scripts/check-why-comments.py`.
   - Added `// WHY:` comment in `src-tauri/src/lib.rs` for `Focused(false)` window event handling.

## Verification
- Executed `npm run check:all` (`check:install`, `check:tsc`, `check:py`, `check:why`): **Passed cleanly with 0 errors**.
- Executed `npm run build`: Vite build completed in 7.94s with **0 errors**.
- Executed `cargo check` in `src-tauri/`: **Passed cleanly in 18.83s with 0 errors**.
