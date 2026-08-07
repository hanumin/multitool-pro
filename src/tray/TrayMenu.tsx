import React, { useEffect, useState } from 'react';
import { isAudioWidgetOpen, toggleAudioWidget, subscribeAudioWidget } from '../utils/audioWidget';

interface ModuleItem {
  id: string;
  label: string;
  subtext: string;
  icon: React.ReactNode;
}

// WHY: Component hiển thị menu thanh công cụ hệ thống (tray menu) với danh sách chức năng và thao tác nhanh.
export default function TrayMenu() {
  const [audioWidgetActive, setAudioWidgetActive] = useState<boolean>(false);
  const [runningServices, setRunningServices] = useState<number>(3);
  const [totalServices, setTotalServices] = useState<number>(7);

  useEffect(() => {
    setAudioWidgetActive(isAudioWidgetOpen());
    const unsubscribe = subscribeAudioWidget((isOpen) => {
      setAudioWidgetActive(isOpen);
    });
    return () => unsubscribe();
  }, []);

  // WHY: Lắng nghe sự kiện blur để tự động ẩn window tray_menu khi người dùng click ra ngoài.
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

  // WHY: Cập nhật động số lượng service đang chạy từ Flask API hoặc window.__serverStatus.
  useEffect(() => {
    const fetchStatus = async () => {
      try {
        if (typeof window !== 'undefined' && (window as any).__serverStatus) {
          const s = (window as any).__serverStatus;
          if (typeof s.running === 'number') setRunningServices(s.running);
          if (typeof s.total === 'number') setTotalServices(s.total);
          return;
        }
        const res = await fetch('http://127.0.0.1:5050/api/status').catch(() => null);
        if (res && res.ok) {
          const data = await res.json();
          if (typeof data.running === 'number') setRunningServices(data.running);
          if (typeof data.total === 'number') setTotalServices(data.total);
        } else {
          const projRes = await fetch('http://127.0.0.1:5050/api/projects').catch(() => null);
          if (projRes && projRes.ok) {
            const projects = await projRes.json();
            if (Array.isArray(projects)) {
              setTotalServices(projects.length);
              setRunningServices(projects.filter((p: any) => p.running).length);
            }
          }
        }
      } catch {}
    };

    fetchStatus();
    const interval = setInterval(fetchStatus, 3000);
    return () => clearInterval(interval);
  }, []);

  // WHY: Mở & focus main window, thực thi IPC action (openSettings hoặc navigateModule) trên main window qua eval, sau đó ẩn tray_menu.
  const openDashboard = async (moduleId?: string) => {
    try {
      const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
      const mainWindow = await WebviewWindow.getByLabel('main');
      if (mainWindow) {
        await mainWindow.show();
        await mainWindow.setFocus();
        if (moduleId) {
          if (moduleId === 'settings') {
            await (mainWindow as any).eval('window.__openSettings?.()');
          } else {
            await (mainWindow as any).eval(`window.__navigateModule?.('${moduleId}')`);
          }
        }
      }
      const trayWindow = await WebviewWindow.getByLabel('tray_menu');
      if (trayWindow) {
        await trayWindow.hide();
      }
    } catch (err) {
      console.warn('[TrayMenu] Opening main window fallback:', err);
    }
  };

  // WHY: Gửi lệnh start all tới main window qua eval và ẩn tray_menu window.
  const handleStartAll = async () => {
    setRunningServices(totalServices);
    try {
      const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
      const mainWindow = await WebviewWindow.getByLabel('main');
      if (mainWindow) {
        await (mainWindow as any).eval('window.__startAll?.()');
      }
      const trayWindow = await WebviewWindow.getByLabel('tray_menu');
      if (trayWindow) {
        await trayWindow.hide();
      }
    } catch (err) {
      console.warn('[TrayMenu] handleStartAll error:', err);
    }
  };

  // WHY: Gửi lệnh stop all tới main window qua eval và ẩn tray_menu window.
  const handleStopAll = async () => {
    setRunningServices(0);
    try {
      const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
      const mainWindow = await WebviewWindow.getByLabel('main');
      if (mainWindow) {
        await (mainWindow as any).eval('window.__stopAll?.()');
      }
      const trayWindow = await WebviewWindow.getByLabel('tray_menu');
      if (trayWindow) {
        await trayWindow.hide();
      }
    } catch (err) {
      console.warn('[TrayMenu] handleStopAll error:', err);
    }
  };

  // WHY: Bật/tắt Widget Âm thanh và tự động cập nhật state local.
  const handleToggleAudioWidget = () => {
    toggleAudioWidget({ width: 200, height: 200 }).catch(() => {});
    setAudioWidgetActive((prev) => !prev);
  };

  // WHY: Gửi lệnh thoát ứng dụng hoàn toàn thông qua plugin-process exit(0).
  const handleQuit = async () => {
    try {
      const { exit } = await import('@tauri-apps/plugin-process');
      await exit(0);
    } catch {
      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        await getCurrentWindow().close();
      } catch {
        window.close();
      }
    }
  };

  const modules: ModuleItem[] = [
    {
      id: 'servers',
      label: 'Máy chủ Web',
      subtext: '3/5 Online',
      icon: (
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <rect x="2" y="2" width="20" height="8" rx="2" ry="2"/>
          <rect x="2" y="14" width="20" height="8" rx="2" ry="2"/>
          <line x1="6" y1="6" x2="6.01" y2="6"/>
          <line x1="6" y1="18" x2="6.01" y2="18"/>
        </svg>
      ),
    },
    {
      id: 'printers',
      label: 'Máy in',
      subtext: 'Sẵn sàng',
      icon: (
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <polyline points="6 9 6 2 18 2 18 9"/>
          <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/>
          <rect x="6" y="14" width="12" height="8"/>
        </svg>
      ),
    },
    {
      id: 'audio',
      label: 'Âm thanh Studio',
      subtext: 'Mic / Studio',
      icon: (
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/>
          <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
          <line x1="12" y1="19" x2="12" y2="22"/>
        </svg>
      ),
    },
    {
      id: 'tunnels',
      label: 'Cloudflare Tunnel',
      subtext: 'Active',
      icon: (
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <circle cx="12" cy="12" r="10"/>
          <line x1="2" y1="12" x2="22" y2="12"/>
          <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>
        </svg>
      ),
    },
    {
      id: 'database',
      label: 'Cơ sở dữ liệu',
      subtext: 'PostgreSQL / MySQL',
      icon: (
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <ellipse cx="12" cy="5" rx="9" ry="3"/>
          <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/>
          <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/>
        </svg>
      ),
    },
    {
      id: 'logs',
      label: 'Terminal Logs',
      subtext: 'Log hệ thống',
      icon: (
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <polyline points="4 17 10 11 4 5"/>
          <line x1="12" y1="19" x2="20" y2="19"/>
        </svg>
      ),
    },
    {
      id: 'file-copier',
      label: 'Sao chép tập tin',
      subtext: 'Audio / Video',
      icon: (
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
        </svg>
      ),
    },
  ];

  return (
    <div className="tray-card">
      {/* Header Section */}
      <div className="flex items-center justify-between pb-2 mb-2 border-b border-white/10 shrink-0">
        <div className="flex items-center gap-2">
          <div className="w-6 h-6 rounded-lg bg-gradient-to-br from-emerald-400 to-emerald-600 flex items-center justify-center shadow-sm shadow-emerald-500/20 text-white font-bold text-xs">
            M
          </div>
          <div>
            <div className="flex items-center gap-1.5 leading-none">
              <span className="text-xs font-bold tracking-tight text-white">MultiTool Pro</span>
              <span className="text-[10px] font-medium px-1 py-0.5 rounded bg-emerald-500/20 text-emerald-300">v1.11.3</span>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-1.5 bg-slate-800/80 px-2 py-1 rounded-full border border-white/5">
          <span className="pulse-dot-green shrink-0" />
          <span className="text-[11px] font-semibold text-emerald-400">{runningServices}/{totalServices} Running</span>
        </div>
      </div>

      {/* Quick Action Bar */}
      <div className="flex items-center gap-1.5 mb-2 shrink-0">
        <button
          onClick={() => openDashboard()}
          className="flex-1 flex items-center justify-center gap-1.5 py-1.5 px-2.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 active:bg-emerald-700 text-white font-semibold text-xs transition-all shadow-md shadow-emerald-900/30 cursor-pointer border-0"
        >
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6A2.25 2.25 0 0 1 6 3.75h2.25A2.25 2.25 0 0 1 10.5 6v2.25a2.25 2.25 0 0 1-2.25 2.25H6a2.25 2.25 0 0 1-2.25-2.25V6zM3.75 15.75A2.25 2.25 0 0 1 6 13.5h2.25a2.25 2.25 0 0 1 2.25 2.25V18a2.25 2.25 0 0 1-2.25 2.25H6A2.25 2.25 0 0 1 3.75 18v-2.25zM13.5 6a2.25 2.25 0 0 1 2.25-2.25H18A2.25 2.25 0 0 1 20.25 6v2.25A2.25 2.25 0 0 1 18 10.5h-2.25a2.25 2.25 0 0 1-2.25-2.25V6zM13.5 15.75a2.25 2.25 0 0 1 2.25-2.25H18a2.25 2.25 0 0 1 2.25 2.25V18A2.25 2.25 0 0 1 18 20.25h-2.25A2.25 2.25 0 0 1 13.5 18v-2.25z" />
          </svg>
          <span>Mở Dashboard</span>
        </button>
        <button
          onClick={handleStartAll}
          title="Chạy tất cả dịch vụ"
          className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 active:bg-slate-900 text-emerald-400 font-medium text-xs transition-all border border-white/10 cursor-pointer flex items-center justify-center shrink-0"
        >
          <svg className="w-3.5 h-3.5 fill-current" viewBox="0 0 24 24">
            <polygon points="5 3 19 12 5 21 5 3"/>
          </svg>
        </button>
        <button
          onClick={handleStopAll}
          title="Dừng tất cả dịch vụ"
          className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 active:bg-slate-900 text-rose-400 font-medium text-xs transition-all border border-white/10 cursor-pointer flex items-center justify-center shrink-0"
        >
          <svg className="w-3.5 h-3.5 fill-current" viewBox="0 0 24 24">
            <rect x="4" y="4" width="16" height="16" rx="2"/>
          </svg>
        </button>
      </div>

      {/* Module Navigation List */}
      <div className="flex-1 overflow-y-auto space-y-0.5 my-1 pr-0.5 tray-scroll-container">
        <div className="text-[10px] font-bold tracking-wider text-slate-400 uppercase px-1 mb-1">
          Chức năng chính
        </div>
        {modules.map((mod) => (
          <button
            key={mod.id}
            onClick={() => openDashboard(mod.id)}
            className="tray-menu-item"
          >
            <div className="flex items-center gap-2.5 min-w-0">
              <span className="text-emerald-400 shrink-0">{mod.icon}</span>
              <span className="truncate text-slate-200">{mod.label}</span>
            </div>
            <span className="text-[10.5px] text-slate-400 font-normal shrink-0 ml-2">{mod.subtext}</span>
          </button>
        ))}
      </div>

      {/* Utilities Section */}
      <div className="pt-2 border-t border-white/10 shrink-0 space-y-1">
        {/* Toggle Widget Audio */}
        <div
          onClick={handleToggleAudioWidget}
          className="tray-menu-item justify-between select-none"
        >
          <div className="flex items-center gap-2.5 min-w-0">
            <span className="text-amber-400 shrink-0">
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 18.75a6 6 0 0 0 6-6v-1.5m-6 7.5a6 6 0 0 1-6-6v-1.5m6 7.5v3.75m-3.75 0h7.5M12 15.75a3 3 0 0 0 3-3V4.5a3 3 0 0 0-6 0v8.25a3 3 0 0 0 3 3z" />
              </svg>
            </span>
            <span className="truncate text-slate-200">Widget Âm thanh</span>
          </div>
          <div className={`tray-toggle-switch ${audioWidgetActive ? 'active' : ''}`}>
            <div className="tray-toggle-thumb" />
          </div>
        </div>

        {/* Cài đặt */}
        <button
          onClick={() => openDashboard('settings')}
          className="tray-menu-item"
        >
          <div className="flex items-center gap-2.5 min-w-0">
            <span className="text-slate-400 shrink-0">
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <circle cx="12" cy="12" r="3"/>
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>
              </svg>
            </span>
            <span className="truncate text-slate-200">Cài đặt hệ thống</span>
          </div>
        </button>

        {/* Footer: Quit Button */}
        <div className="pt-1 border-t border-white/5">
          <button
            onClick={handleQuit}
            className="tray-menu-item tray-menu-item-danger text-rose-400 hover:text-rose-300"
          >
            <div className="flex items-center gap-2.5 min-w-0">
              <span className="shrink-0">
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5.636 5.636a9 9 0 1012.728 0M12 3v9" />
                </svg>
              </span>
              <span className="truncate font-semibold">Thoát ứng dụng</span>
            </div>
          </button>
        </div>
      </div>
    </div>
  );
}
