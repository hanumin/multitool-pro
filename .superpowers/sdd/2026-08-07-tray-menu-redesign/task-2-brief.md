# Task 2 Brief: Create Frameless HTML Entry & `TrayMenu.tsx` Component

## Goal
Build the `tray.html` entry page, `src/tray/main.tsx`, `src/tray/tray.css`, and `src/tray/TrayMenu.tsx` with Windows 11 Fluent UI / Glassmorphism design system. Zero left margin, crisp Lucide SVG icons, interactive status header, quick actions, audio widget toggle, and quick module navigation.

## Target Files
- Create: `tray.html`
- Create: `src/tray/main.tsx`
- Create: `src/tray/tray.css`
- Create: `src/tray/TrayMenu.tsx`

## Step-by-Step Requirements

1. **`tray.html`**:
   Root HTML file:
   ```html
   <!DOCTYPE html>
   <html lang="vi">
     <head>
       <meta charset="UTF-8" />
       <meta name="viewport" content="width=device-width, initial-scale=1.0" />
       <title>MultiTool Pro Tray Menu</title>
       <link rel="preconnect" href="https://fonts.googleapis.com">
       <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
       <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
     </head>
     <body class="bg-transparent text-slate-100 select-none overflow-hidden font-sans">
       <div id="tray-root"></div>
       <script type="module" src="/src/tray/main.tsx"></script>
     </body>
   </html>
   ```

2. **`src/tray/main.tsx`**:
   React entry point:
   ```tsx
   import React from 'react';
   import ReactDOM from 'react-dom/client';
   import TrayMenu from './TrayMenu';
   import './tray.css';

   ReactDOM.createRoot(document.getElementById('tray-root')!).render(
     <React.StrictMode>
       <TrayMenu />
     </React.StrictMode>
   );
   ```

3. **`src/tray/tray.css`**:
   Windows 11 Fluent UI / Acrylic Glassmorphism design system:
   - Full height transparent container with rounded corners (`14px`), border `1px solid rgba(255, 255, 255, 0.12)`, `backdrop-filter: blur(24px) saturate(180%)`, shadow `0 16px 40px rgba(0,0,0,0.6)`.
   - All menu items left-aligned with **ZERO left margin/whitespace**.
   - Hover transitions, active states, status indicator glow, toggle switch styles.

4. **`src/tray/TrayMenu.tsx`**:
   Build `TrayMenu` component containing:
   - **Header Section**:
     - Logo / Icon + Title "MultiTool Pro" + Version "v1.11.3"
     - Live status badge: "● X/Y Running"
   - **Quick Action Bar**:
     - Primary button: "Mở Dashboard"
     - Compact buttons: "▶ Chạy tất cả" & "■ Dừng tất cả"
   - **Module Navigation List** (7 items with SVG icons):
     1. Máy chủ Web (Server)
     2. Máy in (Printer)
     3. Âm thanh Studio (Volume/Audio)
     4. Cloudflare Tunnel (Globe/Network)
     5. Cơ sở dữ liệu (Database)
     6. Terminal Logs (Terminal)
     7. Sao chép tập tin (Files)
   - **Utilities**:
     - Switch Toggle: "Widget Âm thanh"
     - Cài đặt (Settings)
     - Kiểm tra cập nhật (Update)
     - Giới thiệu (About)
   - **Footer**:
     - Separator
     - "Thoát ứng dụng" (Quit) with red hover style.

## Report Contract
Save task report to `.superpowers/sdd/2026-08-07-tray-menu-redesign/task-2-report.md`.
Status values: DONE, DONE_WITH_CONCERNS, NEEDS_CONTEXT, BLOCKED.
