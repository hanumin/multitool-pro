import { useEffect, useState, useRef, lazy, Suspense } from 'react'
import Sidebar from './components/Sidebar'
import AboutModal from './components/AboutModal'
import { ModuleId, MODULES, type PreloadedData } from './types'

// WHY: Preload tất cả lazy-loaded components trước để tránh loading spinner khi chuyển tab.
// Các module sẽ được import đồng thời trong LoadingScreen trước khi app chính hiển thị.
const preloadModules = () => {
  // Trigger dynamic imports để cache chunks
  import('./components/modules/ServersModule')
  import('./components/modules/PrintersModule')
  import('./components/modules/AudioModule')
  import('./components/modules/FileCopierModule')
  import('./components/modules/DatabaseModule')
  import('./components/modules/TunnelsModule')
  import('./components/modules/LogModule')
  import('./components/SettingsModal')
}

const ServersModule = lazy(() => import('./components/modules/ServersModule'))
const PrintersModule = lazy(() => import('./components/modules/PrintersModule'))
const AudioModule = lazy(() => import('./components/modules/AudioModule'))
const FileCopierModule = lazy(() => import('./components/modules/FileCopierModule'))
const DatabaseModule = lazy(() => import('./components/modules/DatabaseModule'))
const TunnelsModule = lazy(() => import('./components/modules/TunnelsModule'))
const LogModule = lazy(() => import('./components/modules/LogModule'))
const SettingsModal = lazy(() => import('./components/SettingsModal'))
import LoadingScreen from './components/LoadingScreen'
import { useToast } from './components/ToastManager'
import { type LogColors, DEFAULT_LOG_COLORS } from './utils/logStyles'
import { API, fetchWithRetry } from './utils/apiFetch'
import { openAudioWidget, closeAudioWidget, toggleAudioWidget } from './utils/audioWidget'

type Theme = 'dark' | 'light'

interface ChangelogEntry {
  version: string
  title: string
  items: string[]
}

const CHANGELOGS: ChangelogEntry[] = [
  {
    version: '1.4.0',
    title: 'v1.4.0 - File Copier & Sửa lỗi',
    items: [
      'Tích hợp module File Copier - copy file audio/video theo từ khóa.',
      'Tích hợp module Printer Manager - quản lý máy in (win32print).',
      'Tích hợp module Audio Manager - theo dõi mic & thiết bị audio (pycaw).',
      'Fix bugs: settingsOpen dead code, is_default type inconsistency.',
      'Fix bugs: api_audio_set_default comtypes IPolicyConfig crash.',
      'Tối ưu: gộp OpenPrinter calls, chuẩn hóa kiểu dữ liệu API.',
    ]
  },
  {
    version: '1.3.0',
    title: 'v1.3.0 - Dashboard đa mô-đun với Sidebar',
    items: [
      'Thiết kế lại toàn bộ UI với Sidebar navigation chuyên nghiệp.',
      'Tích hợp module quản lý máy in (Printers) - Win32print API.',
      'Tích hợp module quản lý Microphone & Audio (Audio) - pycaw + Registry.',
      'Sửa lỗi Auto-start cùng Windows: tạo file auto-start.ps1 bị thiếu.',
      'Sửa lỗi nút Open không mở tab: dùng Tauri shell plugin open().',
      'Fix bugs: import psutil, MSI install path, APPDATA safety.'
    ]
  },
  {
    version: '1.2.0',
    title: 'v1.2.0 - Chẩn đoán trực tiếp, Biên tập Env & 3 mức dọn dẹp',
    items: [
      'Sửa lỗi giật lệch khung hình khi chuyển tab log.',
      'Đại tu tính năng dọn dẹp với 3 chế độ (Quick Cache, Deep Build, Nuke Reinstall).',
      'Bổ sung bảng Diagnostics đo lường phần cứng thời gian thực.',
      'Tích hợp thông tin nhánh Git và trạng thái sạch/bẩn.',
      'Xây dựng trình soạn thảo file cấu hình biến môi trường.'
    ]
  },
  {
    version: '1.1.0',
    title: 'v1.1.0 - Khay hệ thống, Màu sắc Log & Khởi động ẩn',
    items: [
      'Ẩn cửa sổ Terminal trống nhờ cờ CREATE_NO_WINDOW.',
      'Tích hợp Icon cho khay hệ thống (System Tray Icon).',
      'Tô màu cú pháp log (ANSI Color Parser) chuyên nghiệp.',
      'Hộp thoại Copy/Export log nâng cao.',
      'Cập nhật giao diện Light/Dark Theme cho Cài đặt.'
    ]
  },
  {
    version: '1.0.0',
    title: 'v1.0.0 - Phiên bản đầu tiên',
    items: [
      'Bảng điều khiển máy chủ Next.js và Node.js cục bộ.',
      'Cấu hình cổng và cổng động.',
      'Quản lý bộ nhớ đệm dự án và làm sạch tự động.'
    ]
  }
]

// WHY: Custom hook — persist theme to localStorage + set data-theme attr on <html>.
// Dark mặc định (không phải system preference) vì app chủ yếu dùng trong terminal tối.
// Toggle inline function (không cần useCallback vì chỉ dùng trong header button).
function useTheme() {
  const [theme, setTheme] = useState<Theme>(() => {
    const stored = localStorage.getItem('sd-theme')
    if (stored === 'light' || stored === 'dark') return stored
    return 'dark'
  })

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    localStorage.setItem('sd-theme', theme)
  }, [theme])

  // WHY: Inline toggle function — không cần useCallback vì chỉ dùng trong header button click.
  const toggle = () => setTheme(t => t === 'dark' ? 'light' : 'dark')
  return { theme, toggle }
}

// WHY: Responsive sidebar — auto-collapse khi window width < SIDEBAR_BREAKPOINT.
// Chỉ collapse (không auto-expand) để tôn trọng lựa chọn của user trên màn hình lớn.
const SIDEBAR_BREAKPOINT = 1100

// WHY: Component chính — quản lý theme, sidebar, module routing, settings modal, bottom bar.
// Sử dụng React.lazy + Suspense cho code-splitting theo module.
// State tập trung ở đây, pass props xuống children (sidebar, modules).
function App() {
  const [appReady, setAppReady] = useState(false)
  const [preloadedData, setPreloadedData] = useState<PreloadedData>({})
  const { theme, toggle: toggleTheme } = useTheme()
  const [activeModule, setActiveModule] = useState<ModuleId>('servers')
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [statusText, setStatusText] = useState('Sẵn sàng')
  const [autostart, setAutostart] = useState(false)
  const [appVersion, setAppVersion] = useState('1.9.10')
  const [changelogOpen, setChangelogOpen] = useState(false)
  const [changelogAnim, setChangelogAnim] = useState<'enter' | 'exit'>('enter')
  const [aboutOpen, setAboutOpen] = useState(false)
  const [aboutAnim, setAboutAnim] = useState<'enter' | 'exit'>('enter')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsAnim, setSettingsAnim] = useState<'enter' | 'exit'>('enter')
  const [settingsRefresh, setSettingsRefresh] = useState(0)
  const [isMaximized, setIsMaximized] = useState(false)
  const [systemIps, setSystemIps] = useState<string[]>(['localhost', '127.0.0.1'])
  // WHY: Lưu tùy chọn màu sắc log. Merge với defaults để tránh thiếu key.
  const [logColors, setLogColors] = useState<LogColors>(() => {
    try {
      const stored = localStorage.getItem('sd-log-colors')
      if (stored) return JSON.parse(stored) as LogColors
    } catch {}
    return {} // Dùng DEFAULT_LOG_COLORS khi chưa có setting
  })

  // WHY: Persist logColors vào localStorage mỗi khi thay đổi.
  // Luôn save (kể cả object rỗng) để reset có hiệu lực vĩnh viễn.
  useEffect(() => {
    localStorage.setItem('sd-log-colors', JSON.stringify(logColors))
  }, [logColors])

  // WHY: Lưu tùy chọn polling nền cho từng module. localStorage để persist giữa các lần mở app.
  // Mặc định: tất cả đều false (không polling khi tab inactive).
  const BG_POLLING_DEFAULTS: Record<ModuleId, boolean> = { servers: false, printers: false, audio: false, 'file-copier': false, database: false, tunnels: false, logs: false }
  // WHY: Merge parsed data với defaults để tránh undefined khi localStorage có key thiếu.
  const [backgroundPolling, setBackgroundPolling] = useState<Record<ModuleId, boolean>>(() => {
    try {
      const stored = localStorage.getItem('sd-bg-polling')
      if (stored) return { ...BG_POLLING_DEFAULTS, ...JSON.parse(stored) }
    } catch {}
    return BG_POLLING_DEFAULTS
  })

  // WHY: Dynamic import để không crash trong browser (Tauri API không available ngoài desktop runtime).
  // .catch(() => {}) — fail silently, fallback về version hardcoded.
  useEffect(() => {
    import('@tauri-apps/api/app')
      .then(m => m.getVersion())
      .then(setAppVersion)
      .catch(() => {})
  }, [])

  // WHY: Kiểm tra trạng thái maximized khi mount để hiển thị icon maximize/restore phù hợp.
  useEffect(() => {
    import('@tauri-apps/api/window').then(async ({ getCurrentWindow }) => {
      try {
        const max = await getCurrentWindow().isMaximized()
        setIsMaximized(max)
      } catch {}
    })
  }, [])

  // WHY: Kiểm tra bản cập nhật qua Tauri updater — nếu có, hỏi user rồi tải +
  // cài + relaunch app (dynamic import để không bundle nặng khi chạy dev).
  const checkUpdate = async () => {
    try {
      const { check } = await import('@tauri-apps/plugin-updater')
      const { relaunch } = await import('@tauri-apps/plugin-process')
      const update = await check()
      if (update) {
        const ok = window.confirm(`Có bản cập nhật ${update.version}. Tải về và cài đặt?`)
        if (ok) {
          setStatusText('Đang tải bản cập nhật...')
          await update.downloadAndInstall()
          await relaunch()
        }
      } else setStatusText('Bạn đang dùng phiên bản mới nhất')
    } catch (e: any) { setStatusText(e?.message || 'Kiểm tra cập nhật thất bại') }
  }

  // WHY: Đăng ký các hàm toàn cục window để System Tray Context Menu gọi từ Rust/Tauri
  useEffect(() => {
    ;(window as any).__navigateModule = (modId: ModuleId) => {
      setActiveModule(modId)
    }
    ;(window as any).__openSettings = () => {
      setSettingsAnim('enter')
      setSettingsOpen(true)
    }
    ;(window as any).__checkUpdates = () => {
      checkUpdate()
    }
    ;(window as any).__openAbout = () => {
      setAboutAnim('enter')
      setAboutOpen(true)
    }
    // WHY: Delegate sang shared manager src/utils/audioWidget.ts — single source of truth.
    // Trước đây mỗi nơi tự getByLabel + show() → window đang chết (destroy async) được
    // show() lại âm thầm fail → widget không hiện. Manager xử lý stale handle + event bridge.
    ;(window as any).__openAudioWidget = () => {
      // WHY: catch() tránh unhandled rejection khi Rust eval gọi (không có try/catch ở caller)
      openAudioWidget({ width: 200, height: 200 }).catch(() => {})
    }
    ;(window as any).__closeAudioWidget = () => {
      closeAudioWidget().catch(() => {})
    }
    ;(window as any).__toggleAudioWidget = () => {
      toggleAudioWidget({ width: 200, height: 200 }).catch(() => {})
    }
    return () => {
      delete (window as any).__navigateModule
      delete (window as any).__openSettings
      delete (window as any).__checkUpdates
      delete (window as any).__openAbout
      delete (window as any).__openAudioWidget
      delete (window as any).__closeAudioWidget
      delete (window as any).__toggleAudioWidget
    }
  }, [])

  // WHY: Fetch autostart + system IPs khi mount — song song (không cần await).
  // IPs dùng để hiển thị URLs trong bottom bar (localhost + LAN IPs).
  useEffect(() => {
    fetchWithRetry(`${API}/api/settings`).then(r => r.json()).then(d => setAutostart(d.autostart)).catch(() => {})
    fetchWithRetry(`${API}/api/system/ips`).then(r => r.json()).then(d => {
      if (d && Array.isArray(d.ips)) setSystemIps(d.ips)
    }).catch(() => {})
  }, [])

  // WHY: Persist backgroundPolling settings vào localStorage mỗi khi thay đổi.
  // CHỈ lưu các module có polls === true để tiết kiệm dung lượng.
  useEffect(() => {
    const pollingOnly: Record<string, boolean> = {}
    for (const mod of MODULES) {
      if (mod.polls) pollingOnly[mod.id] = backgroundPolling[mod.id]
    }
    localStorage.setItem('sd-bg-polling', JSON.stringify(pollingOnly))
  }, [backgroundPolling])

  // WHY: Auto-collapse sidebar khi window < breakpoint (ví dụ: màn hình laptop nhỏ 1366px).
  // Check ngay khi mount + mỗi lần resize. Cleanup listener khi unmount.
  useEffect(() => {
    const handleResize = () => {
      if (window.innerWidth < SIDEBAR_BREAKPOINT) {
        setSidebarCollapsed(true)
      }
    }
    handleResize()
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [])

  // WHY: Toggle autostart shortcut trong Windows Startup folder.
  // Backend tạo/xóa .lnk file — không cần admin.
  // Response trả về trạng thái thực tế (có thể khác với next).
  const toggleAutostart = async () => {
    const next = !autostart
    try {
      const res = await fetchWithRetry(`${API}/api/settings/autostart`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: next }),
      })
      const d = await res.json()
      if (d.autostart !== undefined) setAutostart(d.autostart)
    } catch { setStatusText('Lỗi chuyển auto-start') }
  }

  // WHY: 3-layer fallback — Tauri shell.open > backend open browser > window.open.
  // Dynamic import để không crash khi chạy trong browser (npm run dev outside Tauri).
  const openBrowser = async (url: string) => {
    try {
      const { open } = await import('@tauri-apps/plugin-shell')
      await open(url); return
    } catch {}
    try {
      await fetchWithRetry(`${API}/api/system/open-browser`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url })
      })
    } catch { window.open(url, '_blank') }
  }

  // WHY: Hide window to system tray (không close).
  // Dynamic import để không crash trong browser — chỉ hoạt động trong Tauri runtime.
  const minimizeToTray = async () => {
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window')
      await getCurrentWindow().hide()
    } catch {}
  }

  // WHY: Window controls cho custom title bar (decorations: false).
  const minimizeWindow = async () => {
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window')
      await getCurrentWindow().minimize()
    } catch {}
  }

  // WHY: Toggle maximize/minimize window (custom title bar decorations: false)
  // — cập nhật icon trạng thái sau khi toggle.
  const toggleMaximize = async () => {
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window')
      await getCurrentWindow().toggleMaximize()
      setIsMaximized(prev => !prev)
    } catch {}
  }

  // WHY: Nút X đóng window — app vẫn chạy ngầm ở system tray nếu enabled.
  const closeWindow = async () => {
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window')
      await getCurrentWindow().close()
    } catch {}
  }

  // WHY: POST /api/shutdown → backend kill all processes + tự tắt.
  // innerHTML fallback hiển thị thông báo khi backend đã tắt (không còn React).
  const shutdown = async () => {
    if (!window.confirm('Dừng dashboard và tất cả dự án?')) return
    try { await fetchWithRetry(`${API}/api/shutdown`, { method: 'POST' }) } catch {}
    document.body.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100vh;background:#030712;color:#9ca3af;font-family:sans-serif;font-size:14px">Dashboard đã dừng.</div>'
  }

  const activePort = 5050
  const detectedUrls = systemIps.map(ip => {
    if (ip === 'localhost') return `http://localhost:${activePort}`
    return `http://${ip}:${activePort}`
  })

  // WHY: Page transition — exit → enter sequence khi chuyển module.
  // Dùng useRef để tránh animation khi lần đầu mount (initial render).
  const prevModuleRef = useRef<ModuleId | null>(null)
  const [pageAnim, setPageAnim] = useState('')

  // WHY: Khi activeModule thay đổi (trừ lần đầu mount):
  //   Phase 1 (0-200ms) — animate-page-exit: content fade-out + scale-down (forwards fill)
  //   Phase 2-3 (200ms) — swap trực tiếp từ exit sang enter trong 1 state update (không clear intermediate)
  //     Exit forwards giữ opacity:0 → Enter backwards áp dụng opacity:0.4 ngay → animate 0.4→1
  //   Phase 4 (500ms) — cleanup, xóa class khỏi DOM
  // CSS: page-exit 0.2s ease-out forwards, page-enter 0.25s cubic-bezier both
  useEffect(() => {
    if (prevModuleRef.current !== null && prevModuleRef.current !== activeModule) {
      // Phase 1: Exit — fade out old module content
      setPageAnim('animate-page-exit')
      
      const exitTimer = setTimeout(() => {
        // Phase 2+3: Chuyển trực tiếp từ exit sang enter trong 1 state update.
        // KHÔNG clear intermediate — tránh flicker.
        // Exit animation có forwards fill (giữ opacity:0), enter có both fill (bắt đầu từ opacity:0.4).
        setPageAnim('animate-page-enter')
      }, 200) // match page-exit duration (0.2s)
      
      // Phase 4: Cleanup — remove class after enter completes
      const cleanupTimer = setTimeout(() => setPageAnim(''), 500)
      
      prevModuleRef.current = activeModule
      return () => {
        clearTimeout(exitTimer)
        clearTimeout(cleanupTimer)
      }
    }
    prevModuleRef.current = activeModule
  }, [activeModule])

  const moduleName = MODULES.find(m => m.id === activeModule)?.label || ''

  // WHY: Thông báo welcome khi app khởi động xong.
  const { addToast } = useToast()  // WHY: Gửi Windows toast + in-app toast khi app sẵn sàng.
  // KHÔNG auto-restore widget ở đây — widget chỉ hiện khi mic bật + checkbox được chọn.
  useEffect(() => {
    if (appReady) {
      addToast({ type: 'success', title: 'MultiTool Pro đã sẵn sàng', message: 'Tất cả module đã được khởi tạo' })
      fetchWithRetry(`${API}/api/notify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'MultiTool Pro', message: 'Dashboard đã sẵn sàng!' }),
      }).catch(() => {})
    }
  }, [appReady])

  // WHY: Preload tất cả lazy-loaded components ngay khi mount để cache chunks.
  useEffect(() => { preloadModules() }, [])

  if (!appReady) {
    return <LoadingScreen onComplete={(data) => { setPreloadedData(data); setAppReady(true) }} />
  }

  return (
    <>
    <div className="h-screen flex select-none bg-[var(--bg)] text-[var(--fg)] overflow-hidden">
      {/* Sidebar */}
      <Sidebar
        activeModule={activeModule}
        onModuleChange={setActiveModule}
        collapsed={sidebarCollapsed}
        onToggleCollapse={() => setSidebarCollapsed(!sidebarCollapsed)}
        statusText={statusText}
        appVersion={appVersion}
      />

      {/* Main content area */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Custom Title Bar (decorations: false) */}
        <div className="titlebar" onDoubleClick={toggleMaximize}>
          <div className="titlebar-drag" data-tauri-drag-region>
            <div className="titlebar-title flex items-center gap-2">
              <span className="font-bold">MultiTool Pro</span>
              <span className="text-[11px] font-normal text-slate-400 hidden sm:inline">
                — Hệ thống Quản trị & Dịch vụ Multi-App Nội bộ
              </span>
            </div>
          </div>
          <div className="titlebar-controls">
            <button onClick={minimizeToTray} className="titlebar-btn titlebar-btn-tray" title="Thu gọn xuống khay">
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                <rect className="tray-bar" x="1" y="9.5" width="10" height="1.5" rx="0.75" fill="currentColor" />
                <path className="tray-arrow" d="M6 2v5m0 0L3.5 4.5M6 7l2.5-2.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
            <div className="titlebar-separator" />
            <button onClick={minimizeWindow} className="titlebar-btn titlebar-btn-minimize" title="Thu nhỏ">
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                <rect className="minimize-line" x="1" y="5.5" width="10" height="1.5" rx="0.75" fill="currentColor" />
              </svg>
            </button>
            <button onClick={toggleMaximize} className="titlebar-btn" title={isMaximized ? 'Thu nhỏ' : 'Phóng to'}>
              <div className="titlebar-icon-group">
                {/* Maximize icon (single square) */}
                <svg className={`titlebar-icon ${isMaximized ? 'icon-hidden' : 'icon-visible'}`} width="12" height="12" viewBox="0 0 12 12" fill="none">
                  <rect x="1.5" y="1.5" width="9" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
                </svg>
                {/* Restore icon (overlapping squares) */}
                <svg className={`titlebar-icon ${isMaximized ? 'icon-visible' : 'icon-hidden'}`} width="12" height="12" viewBox="0 0 12 12" fill="none">
                  <rect x="3.5" y="1" width="7.5" height="7.5" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
                  <rect x="1" y="3.5" width="7.5" height="7.5" rx="1.5" fill="var(--bg-header)" stroke="currentColor" strokeWidth="1.3" />
                </svg>
              </div>
            </button>
            <button onClick={closeWindow} className="titlebar-btn titlebar-close" title="Đóng">
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                <path className="close-x" d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
              </svg>
            </button>
          </div>
        </div>

        {/* Module Header */}
        <header className="shrink-0 backdrop-blur-md border-b px-5 py-2 flex items-center justify-between"
          style={{ background: 'var(--bg-header)', borderColor: 'var(--border)' }}>
          <div className="flex items-center gap-2">
            <h1 className="text-sm font-semibold tracking-tight" style={{ color: 'var(--fg)' }}>
              {moduleName}
            </h1>
            <span className="text-xs px-2 py-0.5 rounded font-medium border"
              style={{ backgroundColor: 'var(--input-bg)', borderColor: 'var(--border)', color: 'var(--fg-muted)' }}>
              {MODULES.find(m => m.id === activeModule)?.description || activeModule}
            </span>
          </div>
        </header>

        {/* Module content - overflow-y-auto để nội dung scroll riêng, sidebar cố định */}
        <div className={`flex-1 min-h-0 overflow-y-auto ${pageAnim}`}>
          <Suspense fallback={
            <div className="flex items-center justify-center h-full">
              <div className="text-center space-y-3">
                <div className="relative mx-auto w-8 h-8">
                  <div className="absolute inset-0 rounded-full border-2 border-dashed border-emerald-500/30 animate-spin" />
                  <div className="absolute inset-2 rounded-full border-2 border-emerald-500/50 animate-spin" style={{ animationDirection: 'reverse', animationDuration: '1.5s' }} />
                </div>
                <p className="text-xs font-medium" style={{ color: 'var(--fg-dim)' }}>Đang tải...</p>
              </div>
            </div>
          }>
            <ServersModule theme={theme} setStatusText={setStatusText} inactive={activeModule !== 'servers'} backgroundPolling={backgroundPolling.servers} logColors={logColors}
              onBackgroundPollingChange={(enabled) => setBackgroundPolling(prev => ({ ...prev, servers: enabled }))}
              onLogColorsChange={setLogColors} onOpenSettings={() => { setSettingsAnim('enter'); setSettingsOpen(true) }} preloadedData={preloadedData} />
            <PrintersModule theme={theme} setStatusText={setStatusText} inactive={activeModule !== 'printers'} backgroundPolling={backgroundPolling.printers}
              onBackgroundPollingChange={(enabled) => setBackgroundPolling(prev => ({ ...prev, printers: enabled }))} preloadedData={preloadedData} />
            <AudioModule theme={theme} setStatusText={setStatusText} inactive={activeModule !== 'audio'} backgroundPolling={backgroundPolling.audio}
              onBackgroundPollingChange={(enabled) => setBackgroundPolling(prev => ({ ...prev, audio: enabled }))} preloadedData={preloadedData} />
            <FileCopierModule theme={theme} setStatusText={setStatusText} inactive={activeModule !== 'file-copier'} />
            <DatabaseModule theme={theme} setStatusText={setStatusText} inactive={activeModule !== 'database'} preloadedData={preloadedData} />
            <TunnelsModule theme={theme} setStatusText={setStatusText} inactive={activeModule !== 'tunnels'} backgroundPolling={backgroundPolling.tunnels}
              onBackgroundPollingChange={(enabled) => setBackgroundPolling(prev => ({ ...prev, tunnels: enabled }))} preloadedData={preloadedData} />
            <LogModule theme={theme} setStatusText={setStatusText} inactive={activeModule !== 'logs'} backgroundPolling={backgroundPolling.logs} logColors={logColors}
              onBackgroundPollingChange={(enabled) => setBackgroundPolling(prev => ({ ...prev, logs: enabled }))} preloadedData={preloadedData} />
          </Suspense>
        </div>

        {/* Bottom Bar */}
        <footer className="shrink-0 backdrop-blur-md border-t px-5 py-1.5 flex items-center justify-between text-xs"
          style={{ background: 'var(--bg-header)', borderColor: 'var(--border)', color: 'var(--fg-dim)' }}>
          <div className="flex items-center gap-3 flex-wrap">
            <button onClick={checkUpdate}
              className="hover:underline cursor-pointer bg-transparent border-0"
              style={{ color: 'var(--fg-muted)' }}>Kiểm tra cập nhật</button>
            <span style={{ color: 'var(--fg-dim)' }}>|</span>
            
            {/* URL dropdown — gộp cả desktop & mobile vào 1 select */}
            <select id="url-select" name="urlSelect" onChange={e => { if (e.target.value) { openBrowser(e.target.value); e.target.value = '' } }}
              className="px-1.5 py-0.5 text-[11px] rounded border font-mono cursor-pointer"
              style={{ backgroundColor: 'var(--input-bg)', borderColor: 'var(--border)', color: 'var(--fg-secondary)' }}>
              <option value="">🔗 URL...</option>
              {detectedUrls.map(url => (
                <option key={url} value={url}>{url.replace('http://', '')}</option>
              ))}
            </select>
          </div>

          <div className="flex items-center gap-3">
            <label htmlFor="autostart-checkbox" className="flex items-center gap-1.5 cursor-pointer select-none" style={{ color: 'var(--fg-dim)' }}>
              <input id="autostart-checkbox" name="autostart" type="checkbox" checked={autostart} onChange={toggleAutostart}
                className="w-3 h-3 rounded cursor-pointer accent-emerald-500" />
              Tự động khởi động
            </label>
            <span style={{ color: 'var(--fg-dim)' }}>|</span>
            <button onClick={() => { setChangelogAnim('enter'); setChangelogOpen(true) }}
              className="hover:underline cursor-pointer font-semibold text-emerald-500 hover:text-emerald-400 transition-colors bg-transparent border-0 group relative">
              v{appVersion}
              <span className="tooltip-text">Xem nhật ký thay đổi</span>
            </button>
            <span style={{ color: 'var(--fg-dim)' }}>|</span>
            <button onClick={() => { setAboutAnim('enter'); setAboutOpen(true) }}
              className="hover:underline cursor-pointer font-semibold text-sky-400 hover:text-sky-300 transition-colors bg-transparent border-0 group relative">
              Giới thiệu
              <span className="tooltip-text">Thông tin tác giả & các chức năng</span>
            </button>
          </div>
        </footer>
      </div>

    </div>

      {/* WHY: Render modals OUTSIDE root div để position: fixed hoạt động đúng */}
      <Suspense fallback={null}>
        <SettingsModal open={settingsOpen} animState={settingsAnim}
          onClose={() => {
            setSettingsAnim('exit')
            setTimeout(() => setSettingsOpen(false), 250)
          }}
          onChanged={() => { setSettingsRefresh(prev => prev + 1) }}
          backgroundPolling={backgroundPolling}
          onBackgroundPollingChange={setBackgroundPolling}
          logColors={logColors}
          onLogColorsChange={setLogColors}
          theme={theme}
          onToggleTheme={toggleTheme} />
      </Suspense>

      {/* About Modal */}
      <AboutModal
        open={aboutOpen}
        animState={aboutAnim}
        version={appVersion}
        onClose={() => {
          setAboutAnim('exit')
          setTimeout(() => { setAboutOpen(false); setAboutAnim('enter') }, 250)
        }}
      />

      {/* Changelog Modal */}
      {(changelogOpen || changelogAnim === 'exit') && (
        <div className={`fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm ${changelogAnim === 'enter' ? 'animate-modal-in' : 'animate-modal-out'}`}
          onClick={e => {
            if (e.target === e.currentTarget) {
              setChangelogAnim('exit')
              setTimeout(() => { setChangelogOpen(false); setChangelogAnim('enter') }, 250)
            }
          }}>
          <div className={`w-full max-w-md rounded-2xl border shadow-2xl p-6 transition-colors flex flex-col ${changelogAnim === 'enter' ? 'animate-modal-content-in' : 'animate-modal-content-out'}`}
            style={{ backgroundColor: 'var(--bg)', borderColor: 'var(--border)', color: 'var(--fg)' }}>
            <div className="flex items-center justify-between pb-4 border-b" style={{ borderColor: 'var(--border)' }}>
              <h3 className="text-sm font-semibold">Nhật ký thay đổi</h3>
              <button onClick={() => {
                setChangelogAnim('exit')
                setTimeout(() => { setChangelogOpen(false); setChangelogAnim('enter') }, 250)
              }}
                className="p-1 rounded-lg hover:bg-black/10 dark:hover:bg-white/10 transition-colors cursor-pointer border-0"
                style={{ color: 'var(--fg-muted)' }}>&times;</button>
            </div>
            <div className="mt-4 space-y-4 max-h-[50vh] overflow-y-auto pr-1">
              {CHANGELOGS.map((ch, idx) => (
                <div key={ch.version} className={idx > 0 ? "pt-4 border-t" : ""} style={{ borderColor: 'var(--border)' }}>
                  <span className="text-xs font-bold text-emerald-500">Version {ch.version}</span>
                  <h4 className="text-xs font-semibold mb-2 mt-1" style={{ color: 'var(--fg-secondary)' }}>{ch.title}</h4>
                  <ul className="list-disc list-inside space-y-1 text-[12px]" style={{ color: 'var(--fg-muted)' }}>
                    {ch.items.map((item, i) => (
                      <li key={i} className="pl-1 -indent-4 ml-4">{item}</li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
            <div className="mt-6 flex justify-end">
              <button onClick={() => {
                setChangelogAnim('exit')
                setTimeout(() => { setChangelogOpen(false); setChangelogAnim('enter') }, 250)
              }}
                className="px-4 py-1.5 text-[12px] font-medium bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg transition-colors cursor-pointer border-0">Đóng</button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

export default App
