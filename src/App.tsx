import { useEffect, useState, useRef, lazy, Suspense } from 'react'
import Sidebar from './components/Sidebar'
import AboutModal from './components/AboutModal'
import { ModuleId, MODULES, PLATFORM_MODULES, type PreloadedData } from './types'

// WHY: Preload các lazy-loaded components trước để tránh loading spinner khi chuyển tab.
// Chỉ preload module KHẢ DỤNG trên nền tảng hiện tại (PLATFORM_MODULES) — bản Mac
// không tải chunk Máy in/Âm thanh/Tunnel (Windows-only).
const preloadModules = () => {
  import('./components/modules/ServersModule')
  if (PLATFORM_MODULES.some(m => m.id === 'printers')) import('./components/modules/PrintersModule')
  if (PLATFORM_MODULES.some(m => m.id === 'audio')) import('./components/modules/AudioModule')
  import('./components/modules/FileCopierModule')
  import('./components/modules/DatabaseModule')
  if (PLATFORM_MODULES.some(m => m.id === 'tunnels')) import('./components/modules/TunnelsModule')
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
import LoginScreen from './components/LoginScreen'
import { getSupabase } from './lib/supabase'
import { useToast } from './components/ToastManager'
import { type LogColors, DEFAULT_LOG_COLORS } from './utils/logStyles'
import { API, fetchWithRetry } from './utils/apiFetch'
import { openAudioWidget, closeAudioWidget, toggleAudioWidget, subscribeAudioWidget } from './utils/audioWidget'
import { invoke } from '@tauri-apps/api/core'
import UpdateModal, { type UpdatePhase, type UpdateInfo } from './components/UpdateModal'
import type { Session } from '@supabase/supabase-js'

type Theme = 'dark' | 'light'

interface ChangelogEntry {
  version: string
  title: string
  items: string[]
}

// WHY: Các kích thước màn hình phổ biến cho popup Settings (titlebar) — dùng chung
// cho menu chọn kích thước cửa sổ app. name = tên hiển thị, tag = nhãn phân loại
// (dùng chuẩn "p" dễ hiểu: 720p/1080p/1440p — thay cho HD/WXGA khó nhớ), ratio = tỷ
// lệ màn hình, w/h là logical size. 2K (2048×1080) nằm giữa Full HD và QHD.
const SIZE_PRESETS: { name: string; tag: string; w: number; h: number; ratio: string }[] = [
  { name: 'Nhỏ',        tag: '720p',  w: 1280, h: 720,  ratio: '16:9' },
  { name: 'Phổ biến',   tag: '768p',  w: 1366, h: 768,  ratio: '16:9' },
  { name: 'Trung bình', tag: '864p',  w: 1536, h: 864,  ratio: '16:9' },
  { name: 'Lớn',        tag: '900p',  w: 1600, h: 900,  ratio: '16:9' },
  { name: 'Full HD',    tag: '1080p', w: 1920, h: 1080, ratio: '16:9' },
  { name: '2K',         tag: '2K',    w: 2048, h: 1080, ratio: '16:9' },
  { name: 'QHD',        tag: '1440p', w: 2560, h: 1440, ratio: '16:9' },
]

interface PendingSize {
  w: number
  h: number
  suggestW: number
  suggestH: number
  screenW: number
  screenH: number
}

const CHANGELOGS: ChangelogEntry[] = [
  {
    version: '1.11.6',
    title: 'v1.11.6 - Popup cập nhật chuyên nghiệp & Sửa chữa',
    items: [
      'Popup auto-update mới: 1 popup xử lý cả kiểm tra lẫn cài đặt với trạng thái rõ ràng (đang kiểm tra, có bản mới, đang tải %, đang cài đặt, hoàn tất, lỗi).',
      'Popup nổi không nền mờ — nhìn rõ app bên dưới khi cập nhật.',
      'Tính năng Sửa chữa (Repair): tải lại đúng phiên bản hiện tại rồi cài đè — khôi phục file hỏng/mất mà không cần nâng cấp.',
      'Hiện progress tải thực tế (%, dung lượng đã tải/tổng) + release notes mở rộng ngay trong popup.',
      'Tự động kiểm tra cập nhật khi khởi động — chỉ hiện popup khi có bản mới (không làm phiền).',
      'Release GitHub gọn hơn: chỉ giữ installer (.msi/.exe/.dmg/.app.tar.gz) + signature, bỏ raw binaries thừa.',
    ]
  },
  {
    version: '1.11.5',
    title: 'v1.11.5 - Auto-update, đa nền tảng & cải thiện UI',
    items: [
      'Hoàn thiện auto-update: installer được ký số trong CI, app tự nhận bản mới qua nút Kiểm tra cập nhật.',
      'GitHub Actions build đa nền tảng: Windows + macOS Universal (chạy cả Mac Intel lẫn Silicon).',
      'Bản Mac tự ẩn các module Windows-only (Âm thanh, Máy in, Tunnel) - giao diện gọn gàng, không crash.',
      'Popup chọn kích thước cửa sổ: 7 mức từ 720p đến 1440p + cảnh báo khi lớn hơn màn hình.',
      'Lưu và khôi phục vị trí + kích thước cửa sổ khi đóng/mở (kể cả trạng thái maximize).',
      'Animation mượt cho card server, sidebar, titlebar, modal Settings/Changelog và statusText.',
      'Sửa polling: tăng retry delay, hủy request chồng lấn, giãn thời gian tải ban đầu giữa các module.',
      'Đổi label "Đang kết nối lại..." thành "Đang tải dữ liệu..." cho lần tải đầu tiên.'
    ]
  },
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
  // WHY: Trạng thái đăng nhập Supabase Auth — null = chưa đăng nhập → hiện màn hình
  // login. Khởi tạo bất đồng bộ (getSession) vì Supabase đọc localStorage.
  const [authSession, setAuthSession] = useState<Session | null>(null)
  const [authChecking, setAuthChecking] = useState(true)
  const { theme, toggle: toggleTheme } = useTheme()
  const [activeModule, setActiveModule] = useState<ModuleId>('servers')
  // WHY: Nếu module đang chọn không khả dụng trên nền tảng này (vd mở app từ tray với
  // tab Máy in trên Mac) → tự quay về tab Máy chủ, tránh render module trống/bị ẩn.
  useEffect(() => {
    if (!PLATFORM_MODULES.some(m => m.id === activeModule)) {
      setActiveModule('servers')
    }
  }, [activeModule])
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  // WHY: Deep-link từ Windows toast (nút '⚡ Gán IP') — toast mở http://127.0.0.1:5050/?printer=NAME
  // → App chuyển ngay sang tab Máy in + PrintersModule tự mở card máy đó khi load xong.
  const [openPrinter, setOpenPrinter] = useState<string | null>(null)
  const [statusText, setStatusText] = useState('Sẵn sàng')
  const [autostart, setAutostart] = useState(false)
  const [appVersion, setAppVersion] = useState('1.11.6')
  const [changelogOpen, setChangelogOpen] = useState(false)
  const [changelogAnim, setChangelogAnim] = useState<'enter' | 'exit'>('enter')
  // WHY: Popup auto-update chuyên nghiệp — thay cho window.confirm cũ. Một popup duy
  // nhất xử lý cả kiểm tra lẫn cài đặt (chuẩn update dialog quốc tế). phase = trạng
  // thái hiện tại, update = thông tin bản mới từ Tauri updater, progress = tiến trình
  // tải thực tế, error = message khi lỗi.
  const [updateOpen, setUpdateOpen] = useState(false)
  const [updateAnim, setUpdateAnim] = useState<'enter' | 'exit'>('enter')
  const [updatePhase, setUpdatePhase] = useState<UpdatePhase>('checking')
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null)
  const [updateProgress, setUpdateProgress] = useState({ percent: 0, downloaded: 0, total: 0 })
  const [updateError, setUpdateError] = useState<string | undefined>(undefined)
  const updateBusyRef = useRef(false)
  // WHY: Lưu update object (từ plugin-updater) để installUpdate dùng lại — tránh gọi
  // check() lần 2 (tốn request + có thể lệch version nếu release đổi giữa chừng).
  // Không đưa vào state vì Update là class Resource của plugin, không phải plain data.
  const updateObjRef = useRef<any>(null)
  const [aboutOpen, setAboutOpen] = useState(false)
  const [aboutAnim, setAboutAnim] = useState<'enter' | 'exit'>('enter')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsAnim, setSettingsAnim] = useState<'enter' | 'exit'>('enter')
  // WHY: Popup chọn kích thước cửa sổ (titlebar) + cảnh báo khi chọn size lớn hơn màn hình.
  const [sizeMenuOpen, setSizeMenuOpen] = useState(false)
  const [pendingSize, setPendingSize] = useState<PendingSize | null>(null)
  const sizeMenuRef = useRef<HTMLDivElement>(null)
  // WHY: Kích thước cửa sổ hiện tại (theo logical size đã lưu/đã chọn) — để popup
  // đánh dấu preset đang active. Khởi tạo từ sd-window-state để đúng ngay lần mở đầu;
  // null = chưa từng đổi (đang dùng mặc định 1680×1000).
  const [currentSize, setCurrentSize] = useState<{ w: number; h: number } | null>(() => {
    try {
      const raw = localStorage.getItem('sd-window-state')
      if (raw) {
        const p = JSON.parse(raw)
        if (typeof p?.w === 'number' && typeof p?.h === 'number') return { w: p.w, h: p.h }
      }
    } catch {}
    return null
  })

  // WHY: Đóng popup kích thước khi click bên ngoài.
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (sizeMenuRef.current && !sizeMenuRef.current.contains(e.target as Node)) {
        setSizeMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])
  const [settingsRefresh, setSettingsRefresh] = useState(0)
  const [isMaximized, setIsMaximized] = useState(false)
  const [shuttingDown, setShuttingDown] = useState(false)
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

  // WHY: Kiểm tra session Supabase khi mở app — nếu đã đăng nhập từ lần trước
  // (persistSession localStorage) thì vào thẳng app, không cần nhập lại. Đồng thời
  // đăng ký onAuthStateChange để đồng bộ đăng nhập/đăng xuất (vd token refresh,
  // session hết hạn → tự đăng xuất). getSession + subscribe chạy trong Tauri webview
  // bình thường (supabase-js hỗ trợ cả browser lẫn webview).
  useEffect(() => {
    let unsub: (() => void) | undefined
    let disposed = false
    ;(async () => {
      try {
        const supabase = getSupabase()
        const { data } = await supabase.auth.getSession()
        // WHY: Duy trì đăng nhập — nếu lần trước KHÔNG tick "Duy trì đăng nhập" thì
        // session chỉ sống trong 1 phiên: khi mở lại app, session trong localStorage bị
        // xóa ngay (tự đăng xuất). Tick rồi thì giữ nguyên qua các lần mở app.
        if (data.session && localStorage.getItem('sd-remember-me') !== 'true') {
          await supabase.auth.signOut().catch(() => {})
          if (!disposed) setAuthSession(null)
        } else if (!disposed) {
          setAuthSession(data.session)
        }
        unsub = supabase.auth.onAuthStateChange((_event, session) => {
          if (!disposed) setAuthSession(session)
        }).data.subscription.unsubscribe
      } catch {}
      if (!disposed) setAuthChecking(false)
    })()
    return () => { disposed = true; unsub?.() }
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

  // WHY: Đánh dấu đã restore vị trí/kích thước xong — move listener dựa vào flag này
  // để chỉ bắt đầu lưu vị trí SAU khi restore xong (tránh lưu nhầm vị trí mặc định).
  // Đặt TRƯỚC 2 effect dưới vì cả 2 đều dùng nó.
  const windowRestoredRef = useRef(false)

  // WHY: Khôi phục trạng thái cửa sổ đã lưu khi mở app — ưu tiên (1) maximize nếu
  // lần trước đóng maximize, (2) vị trí + kích thước (sd-window-state) nếu không.
  // Validate số hợp lệ (tránh corrupt data crash setSize/setPosition/maximize).
  useEffect(() => {
    let saved: { w: number; h: number; x?: number; y?: number } | null = null
    let savedMax = false
    try {
      // WHY: Migrate key cũ (sd-window-size, chỉ có w/h) từ build trước — người dùng
      // đã chọn kích thước sẽ giữ được kích thước đó khi nâng cấp lên bản lưu vị trí.
      let raw = localStorage.getItem('sd-window-state')
      if (!raw) {
        const old = localStorage.getItem('sd-window-size')
        if (old) {
          raw = old
          localStorage.removeItem('sd-window-size')
        }
      }
      if (raw) {
        const p = JSON.parse(raw)
        if (typeof p?.w === 'number' && typeof p?.h === 'number' && p.w >= 800 && p.h >= 500) {
          saved = { w: p.w, h: p.h }
          // WHY: Vị trí là optional — chỉ khôi phục nếu cả x lẫn y đều là số hợp lệ
          // (có thể là window chưa từng bị kéo → chưa có position được lưu).
          if (typeof p?.x === 'number' && typeof p?.y === 'number') {
            saved.x = p.x
            saved.y = p.y
          }
        }
      }
      // WHY: Trạng thái maximize lưu riêng (sd-window-maximized) — chạy trước size/vị
      // trí: nếu user đóng khi đang maximize thì lần mở sau cũng maximize (không cần
      // khôi phục vị trí lúc maximize vì đó là bounds màn hình, không phải ý user).
      const maxRaw = localStorage.getItem('sd-window-maximized')
      savedMax = maxRaw === 'true'
    } catch {}
    let cancelled = false
    import('@tauri-apps/api/window').then(async ({ getCurrentWindow, LogicalSize, LogicalPosition }) => {
      try {
        const win = getCurrentWindow()
        if (cancelled) return
        if (await win.isMaximized()) {
          // WHY: Window đã maximize sẵn (vd tauri.conf hoặc OS restore) → chỉ đồng bộ state.
          setIsMaximized(true)
          windowRestoredRef.current = true
          return
        }
        if (savedMax) {
          // WHY: maximize() sau đó setMaximized state để icon titlebar khớp.
          await win.maximize()
          setIsMaximized(true)
          windowRestoredRef.current = true
          return
        }
        if (saved) {
          // WHY: setSize trước rồi setPosition sau — setPosition khi size đang nhỏ hơn
          // thực tế có thể bị clamp bởi monitor bounds, nên resize đúng rồi mới đặt vị trí.
          await win.setSize(new LogicalSize(saved.w, saved.h))
          if (saved.x !== undefined && saved.y !== undefined) {
            await win.setPosition(new LogicalPosition(saved.x, saved.y))
          }
        }
        // WHY: Luôn set true dù có hay không có dữ liệu lưu — move listener chỉ lắng
        // nghe khi flag true. Nếu không set ở nhánh không có saved, lần đầu dùng app
        // user kéo cửa sổ sẽ KHÔNG bao giờ được lưu vị trí.
        windowRestoredRef.current = true
      } catch {}
    })
    return () => { cancelled = true }
  }, [])

  // WHY: Lưu vị trí cửa sổ mỗi khi user kéo — listener 'tauri://move' trả physical
  // position, chia scaleFactor để lưu logical (đồng bộ với setPosition/LogicalPosition).
  // Chỉ lưu sau khi effect khôi phục set windowRestoredRef = true (restore xong) —
  // nếu không sẽ lưu nhầm vị trí mặc định vừa mở, ghi đè vị trí user đã lưu trước đó.
  useEffect(() => {
    let unlisten: (() => void) | null = null
    let disposed = false
    import('@tauri-apps/api/window').then(async ({ getCurrentWindow }) => {
      try {
        const win = getCurrentWindow()
        unlisten = await win.onMoved(async ({ payload }) => {
          if (disposed || !windowRestoredRef.current) return
          try {
            const sf = await win.scaleFactor()
            const x = Math.round(payload.x / sf)
            const y = Math.round(payload.y / sf)
            const size = await win.outerSize()
            const w = Math.round(size.width / sf)
            const h = Math.round(size.height / sf)
            localStorage.setItem('sd-window-state', JSON.stringify({ w, h, x, y }))
          } catch {}
        })
      } catch {}
    })
    return () => { disposed = true; unlisten?.() }
  }, [])

  // WHY: Lưu trạng thái maximize mỗi khi window đổi kích thước (tauri://resize) — bắt
  // được MỌI cách maximize: nút phóng to, double-click titlebar, Win+↑, snap. Ngược lại
  // nếu chỉ lưu trong toggleMaximize thì các cách trên sẽ không được lưu → mở lại app
  // không restore maximize dù user vừa maximize bằng Win+↑.
  useEffect(() => {
    let unlisten: (() => void) | null = null
    let disposed = false
    import('@tauri-apps/api/window').then(async ({ getCurrentWindow }) => {
      try {
        const win = getCurrentWindow()
        unlisten = await win.onResized(async () => {
          if (disposed || !windowRestoredRef.current) return
          try {
            const max = await win.isMaximized()
            setIsMaximized(max)
            localStorage.setItem('sd-window-maximized', max ? 'true' : 'false')
            // WHY: Khi unmaximize (max=false), onResized cũng kích hoạt — không cần
            // xử lý gì thêm vì size/position sau unmaximize sẽ được onMoved cập nhật
            // nếu user kéo; còn nếu không kéo thì lần mở sau dùng size đã lưu.
          } catch {}
        })
      } catch {}
    })
    return () => { disposed = true; unlisten?.() }
  }, [])

  // WHY: Deep-link từ Windows toast — đọc ?printer=NAME trong URL khi mở (nút 'Gán IP'
  // trên toast mở http://127.0.0.1:5050/?printer=NAME) → chuyển tab Máy in + lưu tên máy
  // để PrintersModule mở đúng card. history.replaceState xóa param → refresh/back không
  // mở lại lần nữa. Chạy sớm (trước khi appReady) nên state vẫn còn khi module mount.
  useEffect(() => {
    try {
      const params = new URLSearchParams(window.location.search)
      const printer = params.get('printer')
      if (printer) {
        setOpenPrinter(printer)
        setActiveModule('printers')
        history.replaceState(null, '', window.location.pathname)
      }
    } catch {}
  }, [])

  // WHY: Tự động kiểm tra cập nhật khi khởi động (chuẩn app desktop: VS Code, Discord
  // tự check sau khi mở) — nếu có bản mới, mở popup để user quyết định (không tự cài
  // đè — luôn để user chọn "Cập nhật ngay" / "Để sau"). Trì hoãn 2.5s để app load
  // xong giao diện trước, tránh popup đè lúc khởi động. Chỉ chạy trong Tauri runtime.
  useEffect(() => {
    const t = setTimeout(() => {
      // WHY: silent=true — chỉ mở popup khi CÓ bản mới; không làm phiền với popup
      // "đã mới nhất" mỗi lần khởi động.
      checkUpdate(true)
    }, 2500)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // WHY: Đăng xuất Supabase — gọi signOut() xóa session trên server + localStorage,
  // state authSession về null → AuthGate tự render LoginScreen. Status text cập nhật
  // để user biết đã thoát.
  const signOut = async () => {
    try {
      await getSupabase().auth.signOut()
    } catch {}
    setAuthSession(null)
    setStatusText('Đã đăng xuất')
  }

  // WHY: Idle timeout — áp dụng khi user KHÔNG tick "Duy trì đăng nhập" (chuẩn bảo
  // mật của Google/Outlook web: logout sau 30 phút không hoạt động). Bất kỳ tương tác
  // nào (chuột/bàn phím/scroll) đều reset timer; hết hạn thì tự đăng xuất.
  useEffect(() => {
    if (!authSession) return
    const remember = localStorage.getItem('sd-remember-me') === 'true'
    if (remember) return
    let timer: ReturnType<typeof setTimeout>
    // WHY: Reset timer đếm ngược idle — gọi lại mỗi khi user có tương tác; hết 30 phút
    // không hoạt động thì tự đăng xuất (đã kiểm tra remember-me ở đầu effect).
    const reset = () => {
      clearTimeout(timer)
      timer = setTimeout(async () => {
        await signOut()
        setStatusText('Tự động đăng xuất sau 30 phút không hoạt động')
      }, 30 * 60 * 1000)
    }
    const events: (keyof WindowEventMap)[] = ['mousemove', 'mousedown', 'keydown', 'wheel', 'touchstart']
    events.forEach(ev => window.addEventListener(ev, reset))
    reset()
    return () => {
      clearTimeout(timer)
      events.forEach(ev => window.removeEventListener(ev, reset))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authSession])

  // WHY: Đóng popup update với animation fade-out rồi reset phase về checking cho
  // lần mở sau (tránh giữ trạng thái cũ khi mở lại popup mới). Cũng đánh dấu ref
  // để checkUpdate bỏ qua kết quả nếu user đóng giữa lúc đang kiểm tra.
  const closeUpdateModal = () => {
    setUpdateAnim('exit')
    setTimeout(() => {
      setUpdateOpen(false)
      setUpdateAnim('enter')
      setUpdatePhase('checking')
      setUpdateInfo(null)
      setUpdateError(undefined)
    }, 250)
  }

  // WHY: Mở popup + kiểm tra bản cập nhật qua Tauri updater. Đây là điểm vào duy
  // nhất (nút footer, tray menu, auto-check). Chuẩn thiết kế update dialog: hiện
  // trạng thái checking ngay, nếu có bản mới → available (hiện version + nút Cập
  // nhật ngay/Để sau), không có → latest, lỗi → error (nút Thử lại). Dynamic import
  // WHY: Mở popup + kiểm tra bản cập nhật qua Tauri updater. Đây là điểm vào duy
  // nhất (nút footer, tray menu, auto-check). Chuẩn thiết kế update dialog: hiện
  // trạng thái checking ngay, nếu có bản mới → available (hiện version + nút Cập
  // nhật ngay/Để sau), không có → latest, lỗi → error (nút Thử lại). Dynamic import
  // để không bundle nặng khi chạy dev.
  //
  // silent = true (auto-check khi khởi động): không mở popup khi KHÔNG có bản mới
  // (tránh làm phiền user mỗi lần mở app với popup "đã mới nhất"); chỉ mở khi có
  // bản cập nhật thật sự. silent = false (bấm nút thủ công): luôn mở popup để hiện
  // kết quả dù là latest hay error.
  // WHY: Kiểm tra bản cập nhật từ plugin-updater — lưu update object vào ref cho
  // installUpdate dùng lại (không gọi check() lần 2), mở popup theo kết quả.
  const checkUpdate = async (silent = false) => {
    if (updateBusyRef.current) return
    updateBusyRef.current = true
    setUpdateError(undefined)
    setUpdateInfo(null)
    setUpdatePhase('checking')
    setStatusText('Đang kiểm tra cập nhật...')
    try {
      const { check } = await import('@tauri-apps/plugin-updater')
      const update = await check()
      if (!update) {
        if (silent) return
        setUpdateOpen(true)
        setUpdateAnim('enter')
        setUpdatePhase('latest')
        setStatusText(`Bạn đang dùng phiên bản mới nhất (v${appVersion})`)
        return
      }
      updateObjRef.current = update
      setUpdateInfo({ version: update.version, date: update.date, body: update.body })
      setUpdateOpen(true)
      setUpdateAnim('enter')
      setUpdatePhase('available')
      setStatusText(`Có bản cập nhật mới v${update.version}`)
    } catch (e: any) {
      if (silent) return
      setUpdateOpen(true)
      setUpdateAnim('enter')
      setUpdateError(e?.message || 'Không thể kết nối tới máy chủ cập nhật')
      setUpdatePhase('error')
      setStatusText('Kiểm tra cập nhật thất bại')
    } finally {
      updateBusyRef.current = false
    }
  }

  // WHY: Tải + cài bản cập nhật. Hiển thị progress thực tế (%, dung lượng đã tải /
  // tổng) trên popup, chuyển sang installing (user thấy rõ app sắp khởi động lại)
  // rồi relaunch. downloadAndInstall trên Windows NSIS tải xong → installer chạy
  // khi app thoát → relaunch() tự đóng app + mở bản mới.
  const installUpdate = async () => {
    if (updateBusyRef.current || !updateInfo || !updateObjRef.current) return
    updateBusyRef.current = true
    setUpdatePhase('downloading')
    setUpdateProgress({ percent: 0, downloaded: 0, total: 0 })
    setStatusText('Đang tải bản cập nhật...')
    try {
      const { relaunch } = await import('@tauri-apps/plugin-process')
      const update = updateObjRef.current
      let downloaded = 0
      let contentLength = 0
      await update.downloadAndInstall((event: any) => {
        switch (event.event) {
          case 'Started':
            contentLength = event.data.contentLength ?? 0
            setUpdateProgress(p => ({ ...p, total: contentLength }))
            break
          case 'Progress':
            downloaded += event.data.chunkLength
            if (contentLength > 0) {
              const pct = Math.min(99, Math.round((downloaded / contentLength) * 100))
              setUpdateProgress({ percent: pct, downloaded, total: contentLength })
              setStatusText(`Đang tải bản cập nhật... ${pct}%`)
            }
            break
          case 'Finished':
            setUpdateProgress(p => ({ ...p, percent: 100 }))
            break
        }
      })
      // WHY: Hiện trạng thái "Đang cài đặt..." ngắn (~1.2s) để user thấy rõ app sắp
      // đóng + khởi động lại, thay vì app tắt đột ngột (chuẩn UX update của VS Code/
      // Discord).
      setUpdatePhase('installing')
      setStatusText('Đang cài đặt bản cập nhật...')
      await new Promise(r => setTimeout(r, 1200))
      await relaunch()
    } catch (e: any) {
      setUpdateError(e?.message || 'Tải bản cập nhật thất bại')
      setUpdatePhase('error')
      setStatusText('Cập nhật thất bại')
    } finally {
      updateBusyRef.current = false
    }
  }

  // WHY: Sửa chữa (repair) bản cài đặt — tải lại ĐÚNG phiên bản hiện tại rồi cài
  // đè (khôi phục file hỏng/mất). Gọi command Rust repair_update vì plugin JS check()
  // không trả về bản có version BẰNG hiện tại (mặc định chỉ nhận bản cao hơn, kể cả
  // allowDowngrades cũng loại version bằng). Rust dùng version_comparator == để lấy
  // đúng bản đang chạy từ latest.json, emit repair-progress/repair-done.
  const repairUpdate = async () => {
    if (updateBusyRef.current) return
    updateBusyRef.current = true
    setUpdatePhase('repairing')
    setUpdateProgress({ percent: 0, downloaded: 0, total: 0 })
    setStatusText('Đang sửa chữa bản cài đặt...')
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const { listen } = await import('@tauri-apps/api/event')
      // WHY: Listen progress trước khi invoke để không bỏ lỡ event đầu tiên (Rust emit
      // ngay khi chunk đầu tải xong). unlisten ngay sau khi xong để tránh leak listener.
      const unlistenProgress = await listen<{ downloaded: number; total: number }>('repair-progress', (e) => {
        const { downloaded, total } = e.payload
        if (total > 0) {
          const pct = Math.min(99, Math.round((downloaded / total) * 100))
          setUpdateProgress({ percent: pct, downloaded, total })
          setStatusText(`Đang sửa chữa... ${pct}%`)
        }
      })
      await invoke('repair_update')
      await new Promise(r => setTimeout(r, 300))
      await unlistenProgress()
      // WHY: Hiện trạng thái "Đang cài đặt..." ngắn (~1.2s) để user thấy rõ app sắp
      // đóng + khởi động lại (chuẩn UX update của VS Code/Discord).
      setUpdatePhase('installing')
      setStatusText('Đang cài đặt bản sửa chữa...')
      await new Promise(r => setTimeout(r, 1200))
      const { relaunch } = await import('@tauri-apps/plugin-process')
      await relaunch()
    } catch (e: any) {
      setUpdateError(e?.message || 'Sửa chữa thất bại')
      setUpdatePhase('error')
      setStatusText('Sửa chữa thất bại')
    } finally {
      updateBusyRef.current = false
    }
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

  // WHY: Lắng nghe lệnh từ tray_menu window qua event bus 'tray-command'.
  // Thay cho eval() (không tồn tại trong Tauri v2) — tray emitTo('main','tray-command',...)
  // rồi dispatch sang các global function đã đăng ký bên trên.
  useEffect(() => {
    let unlisten: (() => void) | undefined
    import('@tauri-apps/api/event').then(async ({ listen, emitTo }) => {
      unlisten = await listen('tray-command', (event) => {
        const { type, moduleId } = event.payload as { type: string; moduleId?: string }
        switch (type) {
          case 'navigate':
            ;(window as any).__navigateModule?.(moduleId)
            break
          case 'settings':
            ;(window as any).__openSettings?.()
            break
          case 'start-all':
            ;(window as any).__startAll?.()
            break
          case 'stop-all':
            ;(window as any).__stopAll?.()
            break
          case 'toggle-audio':
            ;(window as any).__toggleAudioWidget?.()
            break
          case 'get-audio-state':
            import('./utils/audioWidget').then(({ isAudioWidgetOpen }) => {
              emitTo('tray_menu', 'audio-widget-state', { open: isAudioWidgetOpen() }).catch(() => {})
            })
            break
        }
      })
    })
    return () => { if (unlisten) unlisten() }
  }, [])

  // WHY: Đồng bộ trạng thái audio widget từ main window (nguồn sự thật duy nhất)
  // về tray_menu — tray switch phải phản ánh đúng trạng thái thực của widget.
  useEffect(() => {
    const unsubscribe = subscribeAudioWidget((open) => {
      import('@tauri-apps/api/event').then(({ emitTo }) => {
        emitTo('tray_menu', 'audio-widget-state', { open }).catch(() => {})
      })
    })
    return unsubscribe
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
  // — cập nhật icon trạng thái sau khi toggle. onResized listener (effect trên) sẽ
  // bắt sự kiện resize và lưu sd-window-maximized — nên không cần lưu ở đây.
  const toggleMaximize = async () => {
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window')
      await getCurrentWindow().toggleMaximize()
      setIsMaximized(prev => !prev)
    } catch {}
  }

  // WHY: Nút X đóng window — app vẫn chạy ngầm ở system tray nếu enabled.
  // Lưu trạng thái maximize hiện tại trước khi close (tray restore cũng cần đúng).
  const closeWindow = async () => {
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window')
      const win = getCurrentWindow()
      try {
        const max = await win.isMaximized()
        localStorage.setItem('sd-window-maximized', max ? 'true' : 'false')
      } catch {}
      await win.close()
    } catch {}
  }

  // WHY: Lấy kích thước logical của màn hình hiện tại (monitor.size / scaleFactor)
  // để so sánh với preset — Tauri v2 trả physical size + scaleFactor riêng.
  const getScreenLogicalSize = async (): Promise<{ width: number; height: number } | null> => {
    try {
      const { currentMonitor } = await import('@tauri-apps/api/window')
      const monitor = await currentMonitor()
      if (!monitor) return null
      return {
        width: Math.round(monitor.size.width / monitor.scaleFactor),
        height: Math.round(monitor.size.height / monitor.scaleFactor),
      }
    } catch {
      return null
    }
  }

  // WHY: Áp dụng kích thước cửa sổ — nếu đang maximize thì unmaximize trước rồi
  // mới setSize (setSize trên window maximized có thể không có hiệu lực).
  // Lưu size + vị trí hiện tại vào localStorage (sd-window-state) để lần mở sau
  // khôi phục đúng kích thước đã chọn này.
  const applyWindowSize = async (w: number, h: number) => {
    try {
      const { getCurrentWindow, LogicalSize } = await import('@tauri-apps/api/window')
      const win = getCurrentWindow()
      if (await win.isMaximized()) await win.unmaximize()
      await win.setSize(new LogicalSize(w, h))
      setCurrentSize({ w, h })
      try {
        const pos = await win.outerPosition()
        const sf = await win.scaleFactor()
        localStorage.setItem('sd-window-state', JSON.stringify({
          w,
          h,
          x: Math.round(pos.x / sf),
          y: Math.round(pos.y / sf),
        }))
      } catch {}
      setSizeMenuOpen(false)
      setStatusText(`Kích thước cửa sổ: ${w} × ${h}`)
    } catch {}
  }

  // WHY: Khôi phục kích thước + vị trí MẶC ĐỊNH (1680×1000, căn giữa như tauri.conf.json)
  // — unmaximize trước, setSize, center() rồi XÓA sd-window-state để lần mở sau không
  // bị restore lại vị trí cũ (nếu chỉ setSize mà không xóa, effect khôi phục sẽ tự
  // set về vị trí user đã lưu trước đó → user tưởng "reset" nhưng không thay đổi).
  const resetWindowSize = async () => {
    try {
      const { getCurrentWindow, LogicalSize } = await import('@tauri-apps/api/window')
      const win = getCurrentWindow()
      if (await win.isMaximized()) await win.unmaximize()
      await win.setSize(new LogicalSize(1680, 1000))
      await win.center()
      setCurrentSize({ w: 1680, h: 1000 })
      try {
        localStorage.removeItem('sd-window-state')
      } catch {}
      setSizeMenuOpen(false)
      setStatusText('Kích thước cửa sổ: mặc định 1680 × 1000')
    } catch {}
  }

  // WHY: Xử lý chọn kích thước — nếu preset lớn hơn màn hình hiện tại thì hiện
  // popup cảnh báo kèm gợi ý kích thước phù hợp nhất, nhưng vẫn cho user áp dụng.
  const selectSize = async (w: number, h: number) => {
    const screen = await getScreenLogicalSize()
    if (screen && (w > screen.width || h > screen.height)) {
      // WHY: Gợi ý = preset lớn nhất vừa màn hình (hoặc preset nhỏ nhất nếu màn hình quá bé).
      const fitting = SIZE_PRESETS.filter(s => s.w <= screen.width && s.h <= screen.height)
      const suggest = fitting.length > 0 ? fitting[fitting.length - 1] : SIZE_PRESETS[0]
      // WHY: Đóng menu kích thước ngay khi hiện cảnh báo — tránh 2 popup chồng nhau
      // (overlay cảnh báo phủ toàn màn hình nên menu sau lưng vẫn mở, gây khó hiểu).
      setSizeMenuOpen(false)
      setPendingSize({ w, h, suggestW: suggest.w, suggestH: suggest.h, screenW: screen.width, screenH: screen.height })
    } else {
      await applyWindowSize(w, h)
    }
  }

  // WHY: Dừng toàn bộ — nút "Dừng tất cả" ở titlebar gọi hàm này.
  // Flow: confirm → set_backend_watchdog(false) (chặn watchdog tự bật backend lại)
  // → POST /api/shutdown (backend kill all processes + tự tắt) → hiển thị màn hình
  // "Đã dừng" (innerHTML fallback vì backend đã tắt, không còn React hoạt động).
  const shutdown = async () => {
    if (shuttingDown) return
    if (!window.confirm('Dừng dashboard và tất cả dự án? Các dự án đang chạy sẽ bị đóng.')) return
    setShuttingDown(true)
    // WHY: Tắt watchdog backend TRƯỚC khi gọi /api/shutdown — nếu không, watchdog
    // thấy backend chết → tự restart lại → user "dừng hẳn" nhưng backend tự bật lên
    // (mâu thuẫn ý định). set_backend_watchdog(false) là Tauri command (không phụ
    // thuộc backend), nên vẫn gọi được kể cả khi backend sắp tắt.
    try { await invoke('set_backend_watchdog', { enabled: false }) } catch {}
    try {
      const res = await fetchWithRetry(`${API}/api/shutdown`, { method: 'POST' })
      // WHY: Chỉ hiện màn hình "Đã dừng" khi backend xác nhận shutdown thành công.
      // Nếu backend trả lỗi (4xx/5xx) mà vẫn sống → hiện toast lỗi + reset nút, tránh
      // gây hiểu lầm "đã dừng" trong khi backend vẫn chạy (và watchdog đã bị tắt).
      if (!res.ok) {
        const errData = await res.json().catch(() => null)
        setShuttingDown(false)
        addToast({ type: 'error', title: '⏻ Dừng thất bại', message: (errData as any)?.error || `Backend trả lỗi ${res.status}` })
        return
      }
    } catch {
      // WHY: Backend đã tắt/không phản hồi → coi như shutdown thành công (backend
      // chết là điều ta muốn). Vẫn hiện màn hình dừng.
    }
    document.body.innerHTML = '<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;background:#030712;font-family:system-ui,sans-serif;gap:16px">' +
      '<div style="width:56px;height:56px;border-radius:50%;background:rgba(239,68,68,0.12);display:flex;align-items:center;justify-content:center;font-size:28px">⏻</div>' +
      '<div style="font-size:18px;font-weight:600;color:#e2e8f0">Đã dừng tất cả</div>' +
      '<div style="font-size:13px;color:#64748b;max-width:420px;text-align:center;line-height:1.6">Backend và mọi dự án đã được đóng. Đóng cửa sổ này và chạy lại MultiTool Pro để khởi động lại.</div>' +
      '<div style="margin-top:8px;font-size:11px;color:#475569">— MultiTool Pro đã dừng —</div>' +
      '</div>'
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

  // WHY: Lắng nghe event 'backend-watchdog-restarted' từ Rust — watchdog tự restart
  // backend sau khi phát hiện chết/treo. Hiện toast thông báo real-time (kèm giờ địa
  // phương + số lần tự phục hồi) để user biết backend từng chết mà không cần mở log.
  // Event emit từ thread watchdog (không phụ thuộc backend HTTP) nên vẫn nhận được
  // kể cả khi backend vừa tắt.
  useEffect(() => {
    let unlisten: (() => void) | undefined
    import('@tauri-apps/api/event').then(async ({ listen }) => {
      unlisten = await listen<{ unix_ms?: number; count?: number }>('backend-watchdog-restarted', (event) => {
        const { unix_ms, count } = event.payload || {}
        const time = unix_ms ? new Date(unix_ms).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' }) : ''
        addToast({
          type: 'warning',
          title: '🔄 Backend đã được tự khởi động lại',
          message: `Phát hiện backend không phản hồi, đã tự khởi động lại lúc ${time || '--:--'}${count ? ` (lần thứ ${count})` : ''}.`,
          duration: 7000,
        })
      })
    })
    return () => { if (unlisten) unlisten() }
  }, [addToast])
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

  // WHY: Cổng đăng nhập (AuthGate) — chạy TRƯỚC mọi thứ: (1) đang kiểm tra session →
  // hiện LoadingScreen tạm (tránh nháy màn hình login khi đã đăng nhập sẵn), (2)
  // chưa đăng nhập → chỉ hiện LoginScreen, không mount app chính (bảo vệ module
  // backend bằng auth), (3) có session → vào app bình thường.
  if (authChecking) {
    return <LoadingScreen onComplete={(data) => { setPreloadedData(data); setAppReady(true) }} />
  }

  if (!authSession) {
    return <LoginScreen onAuthenticated={(session, rememberMe) => {
      // WHY: Lưu lựa chọn "Duy trì đăng nhập" vào localStorage — App đọc lại lần mở
      // sau để quyết định giữ/xóa session và cài idle timeout (xem 2 effect trên).
      localStorage.setItem('sd-remember-me', rememberMe ? 'true' : 'false')
      setAuthSession(session)
    }} />
  }

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
        user={authSession.user}
        onSignOut={signOut}
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
            <button onClick={shutdown} disabled={shuttingDown} className="titlebar-btn titlebar-btn-shutdown" title={shuttingDown ? 'Đang dừng...' : 'Dừng tất cả dự án & backend'}>
              {shuttingDown ? (
                <span className="titlebar-shutdown-spinner" />
              ) : (
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                  <path className="shutdown-power" d="M6 1.5v4M3.2 2.8a4 4 0 105.6 0" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
                </svg>
              )}
            </button>
            <div className="titlebar-separator" />
            {/* WHY: Nút Settings kích thước cửa sổ — popup 7 kích thước phổ biến.
                Nằm kế nút Thu gọn xuống khay; cảnh báo khi chọn size lớn hơn màn hình. */}
            <div className="relative" ref={sizeMenuRef}>
              <button onClick={() => setSizeMenuOpen(o => !o)}
                className="titlebar-btn"
                title="Kích thước cửa sổ"
                aria-label="Chọn kích thước cửa sổ"
                aria-expanded={sizeMenuOpen}>
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                  <rect x="1" y="1" width="10" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.2" />
                  <path d="M4.5 1v10M1 4.5h10" stroke="currentColor" strokeWidth="0.7" opacity="0.45" />
                </svg>
              </button>
              {sizeMenuOpen && (
                <div className="absolute right-0 top-full mt-1 w-64 rounded-xl border shadow-2xl p-1.5 backdrop-blur-xl animate-scale-in"
                  style={{ backgroundColor: 'var(--bg-card)', borderColor: 'var(--border)', zIndex: 99999 }}>
                  {/* WHY: Header 2 cột khớp với các option bên dưới — trái "Kích thước",
                      phải "Thông tin" để người dùng biết cột nào hiển thị gì. */}
                  <div className="grid grid-cols-[1fr_auto] gap-3 px-3 py-1.5 text-[8px] font-bold uppercase tracking-wider" style={{ color: 'var(--fg-dim)' }}>
                    <span>Kích thước</span>
                    <span className="pr-0.5">Thông tin</span>
                  </div>
                  {SIZE_PRESETS.map(s => {
                    // WHY: Preset active = size đã lưu/chọn khớp chính xác — nhấn preset
                    // cùng size với size hiện tại thì vẫn coi là active (check hiển thị).
                    const active = !!currentSize && currentSize.w === s.w && currentSize.h === s.h
                    return (
                      <button key={s.name} onClick={() => selectSize(s.w, s.h)}
                        className={`size-menu-item ${active ? 'size-menu-item-active' : ''}`}
                        style={{ color: active ? '#34d399' : 'var(--fg-secondary)' }}>
                        {/* Cột trái: check active + nhãn phân loại (HD/FHD/QHD) + tên kích thước */}
                        <span className="flex items-center gap-1.5 min-w-0">
                          {/* WHY: Check đánh dấu preset đang active — giữ chỗ trống
                              (invisible) khi không active để các label không bị xê dịch. */}
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}
                            className={`shrink-0 ${active ? 'opacity-100' : 'opacity-0'}`}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                          </svg>
                          <span className="text-[9px] font-bold px-1 py-px rounded shrink-0" style={{ color: '#34d399', backgroundColor: 'rgba(52,211,153,0.1)', border: '1px solid rgba(52,211,153,0.25)' }}>{s.tag}</span>
                          <span className="truncate text-xs font-medium">{s.name}</span>
                        </span>
                        {/* Cột phải: kích thước px + tỷ lệ màn hình */}
                        <span className="flex flex-col items-end shrink-0">
                          <span className="font-mono text-[10px] font-semibold" style={{ color: active ? '#34d399' : 'var(--fg-secondary)' }}>{s.w} × {s.h}</span>
                          <span className="text-[8px]" style={{ color: 'var(--fg-dim)' }}>{s.ratio}</span>
                        </span>
                      </button>
                    )
                  })}
                  <div className="my-1 h-px" style={{ backgroundColor: 'var(--border)' }} />
                  {/* WHY: Reset về 1680×1000 + căn giữa + xóa sd-window-state — khác màu
                      (amber) để dễ phân biệt với các preset thường. */}
                  <button onClick={resetWindowSize}
                    className="w-full flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs transition-colors cursor-pointer border-0 hover:bg-amber-500/10"
                    style={{ color: '#f59e0b' }}>
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h5M20 20v-5h-5M4 9a8 8 0 0114.9-2M20 15a8 8 0 01-14.9 2" />
                    </svg>
                    Khôi phục kích thước mặc định
                  </button>
                </div>
              )}
            </div>
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
            {/* WHY: 3 module Windows-only (Máy in/Âm thanh/Tunnel) chỉ render trên nền tảng
                hỗ trợ — trên Mac không mount để tránh gọi API backend Windows-only. */}
            {PLATFORM_MODULES.some(m => m.id === 'printers') && (
              <PrintersModule theme={theme} setStatusText={setStatusText} inactive={activeModule !== 'printers'} backgroundPolling={backgroundPolling.printers}
                onBackgroundPollingChange={(enabled) => setBackgroundPolling(prev => ({ ...prev, printers: enabled }))} preloadedData={preloadedData}
                openPrinter={openPrinter} onOpenPrinterHandled={() => setOpenPrinter(null)} />
            )}
            {PLATFORM_MODULES.some(m => m.id === 'audio') && (
              <AudioModule theme={theme} setStatusText={setStatusText} inactive={activeModule !== 'audio'} backgroundPolling={backgroundPolling.audio}
                onBackgroundPollingChange={(enabled) => setBackgroundPolling(prev => ({ ...prev, audio: enabled }))} preloadedData={preloadedData} />
            )}
            <FileCopierModule theme={theme} setStatusText={setStatusText} inactive={activeModule !== 'file-copier'} />
            <DatabaseModule theme={theme} setStatusText={setStatusText} inactive={activeModule !== 'database'} preloadedData={preloadedData} />
            {PLATFORM_MODULES.some(m => m.id === 'tunnels') && (
              <TunnelsModule theme={theme} setStatusText={setStatusText} inactive={activeModule !== 'tunnels'} backgroundPolling={backgroundPolling.tunnels}
                onBackgroundPollingChange={(enabled) => setBackgroundPolling(prev => ({ ...prev, tunnels: enabled }))} preloadedData={preloadedData} />
            )}
            <LogModule theme={theme} setStatusText={setStatusText} inactive={activeModule !== 'logs'} backgroundPolling={backgroundPolling.logs} logColors={logColors}
              onBackgroundPollingChange={(enabled) => setBackgroundPolling(prev => ({ ...prev, logs: enabled }))} preloadedData={preloadedData} />
          </Suspense>
        </div>

        {/* Bottom Bar */}
        <footer className="shrink-0 backdrop-blur-md border-t px-5 py-1.5 flex items-center justify-between text-xs"
          style={{ background: 'var(--bg-header)', borderColor: 'var(--border)', color: 'var(--fg-dim)' }}>
          <div className="flex items-center gap-3 flex-wrap">
            <button onClick={() => checkUpdate()}
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

      {/* Update Modal — popup auto-update (kiểm tra + cài đặt) */}
      <UpdateModal
        open={updateOpen}
        animState={updateAnim}
        phase={updatePhase}
        currentVersion={appVersion}
        update={updateInfo}
        progress={updateProgress}
        error={updateError}
        onClose={closeUpdateModal}
        onInstall={installUpdate}
        onRepair={repairUpdate}
        onRetry={checkUpdate}
        onViewChangelog={() => {
          closeUpdateModal()
          setChangelogOpen(true)
          setChangelogAnim('enter')
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

      {/* WHY: Cảnh báo khi chọn kích thước cửa sổ lớn hơn màn hình hiện tại —
          gợi ý kích thước phù hợp nhất nhưng vẫn cho phép user áp dụng size đã chọn. */}
      {pendingSize && (
        <div className="fixed inset-0 z-[100000] flex items-center justify-center bg-black/60 backdrop-blur-sm animate-modal-in"
          onClick={e => { if (e.target === e.currentTarget) setPendingSize(null) }}>
          <div className="w-full max-w-sm rounded-2xl border shadow-2xl p-5 animate-modal-content-in"
            style={{ backgroundColor: 'var(--bg-card)', borderColor: 'var(--border)', color: 'var(--fg)' }}>
            <div className="flex items-center gap-2.5 pb-3 border-b" style={{ borderColor: 'var(--border)' }}>
              <div className="w-8 h-8 rounded-lg bg-amber-500/15 border border-amber-500/30 flex items-center justify-center text-amber-400 shrink-0">⚠️</div>
              <div>
                <h3 className="text-sm font-bold leading-tight">Kích thước lớn hơn màn hình</h3>
                <p className="text-[10px] mt-0.5" style={{ color: 'var(--fg-muted)' }}>Một phần cửa sổ có thể bị cắt khỏi màn hình</p>
              </div>
            </div>
            <div className="py-4 text-xs space-y-1.5" style={{ color: 'var(--fg-secondary)' }}>
              <p>
                Kích thước đã chọn: <b className="font-mono text-amber-400">{pendingSize.w} × {pendingSize.h}</b>
              </p>
              <p>
                Màn hình hiện tại: <b className="font-mono">{pendingSize.screenW} × {pendingSize.screenH}</b>
              </p>
              <p className="pt-1 text-[11px]" style={{ color: 'var(--fg-dim)' }}>
                💡 Gợi ý kích thước phù hợp: <b className="font-mono text-emerald-400">{pendingSize.suggestW} × {pendingSize.suggestH}</b>
              </p>
            </div>
            <div className="flex gap-2 pt-3 border-t" style={{ borderColor: 'var(--border)' }}>
              <button onClick={() => setPendingSize(null)}
                className="px-3 py-1.5 text-xs font-semibold border rounded-xl transition-all active:scale-95 cursor-pointer hover:bg-white/10"
                style={{ backgroundColor: 'var(--input-bg)', borderColor: 'var(--border)', color: 'var(--fg-secondary)' }}>
                Hủy
              </button>
              <button onClick={() => { const s = pendingSize; setPendingSize(null); applyWindowSize(s.suggestW, s.suggestH) }}
                className="flex-1 px-3 py-1.5 text-xs font-semibold bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl transition-all active:scale-95 cursor-pointer border-0 shadow-sm">
                Dùng gợi ý {pendingSize.suggestW} × {pendingSize.suggestH}
              </button>
              <button onClick={() => { const s = pendingSize; setPendingSize(null); applyWindowSize(s.w, s.h) }}
                className="flex-1 px-3 py-1.5 text-xs font-semibold bg-amber-500/15 text-amber-400 border border-amber-500/30 rounded-xl transition-all active:scale-95 cursor-pointer hover:bg-amber-500/25">
                Vẫn áp dụng {pendingSize.w} × {pendingSize.h}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

export default App
