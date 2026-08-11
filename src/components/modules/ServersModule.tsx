import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import Convert from 'ansi-to-html'
import { getLineStyle, detectLevel, hexToRgba, type LogColors, DEFAULT_LOG_COLORS } from '../../utils/logStyles'
import { API, fetchWithRetry } from '../../utils/apiFetch'
import { useToast } from '../../components/ToastManager'
import type { PreloadedData } from '../../types'

const ansiConverter = new Convert({
  newline: false,
  escapeXML: true,
  colors: {
    0: '#000000', 1: '#ef4444', 2: '#22c55e', 3: '#eab308',
    4: '#3b82f6', 5: '#a855f7', 6: '#06b6d4', 7: '#f3f4f6',
  }
})

interface Project {
  name: string; port: number; path: string; command?: string; running: boolean
  type?: 'node' | 'custom'; process_name?: string
}

interface TunnelState {
  status: string
  url: string | null
  error: string | null
  port: number
  cloudflared_installed: boolean
  watchdog_enabled?: boolean
  watchdog_restart_count?: number
}

interface ServersModuleProps {
  theme: 'dark' | 'light'
  setStatusText: (t: string) => void
  inactive?: boolean
  backgroundPolling?: boolean
  logColors?: LogColors
  onBackgroundPollingChange?: (enabled: boolean) => void
  onLogColorsChange?: (colors: LogColors) => void
  onOpenSettings?: () => void
  preloadedData?: PreloadedData
}

// WHY: Module chính — quản lý dev servers (start/stop/clean/diagnostics).
// Polling 3s cho projects, 2s cho logs, 15s cho port scan.
// Tích hợp Cloudflare Tunnel (quick actions trên card).
export default function ServersModule({ theme, setStatusText, inactive, backgroundPolling, logColors, onBackgroundPollingChange, onLogColorsChange, onOpenSettings, preloadedData }: ServersModuleProps) {
  const { addToast } = useToast()
  const pollAbortRef = useRef<AbortController | null>(null)
  // WHY: Nếu có preloadedData.projects từ LoadingScreen, dùng làm initial state
  // để projects list hiển thị ngay mà không cần chờ fetchProjects() đầu tiên.
  const preloadedProjects = preloadedData?.projects
  const [projects, setProjects] = useState<Project[]>(preloadedProjects || [])
  const [activeTab, setActiveTab] = useState<string>(() => {
    try {
      const stored = localStorage.getItem('sd-active-tab')
      return stored || 'All'
    } catch { return 'All' }
  })
  const [logs, setLogs] = useState<Record<string, string[]>>({ All: [] })
  const [fullLogs, setFullLogs] = useState<Record<string, string[]>>({ All: [] })
  const [exportLimit, setExportLimit] = useState<number>(0)
  const [exportFormat, setExportFormat] = useState<'txt' | 'md' | 'json'>('md')
  const [loading, setLoading] = useState<Record<string, boolean>>({})
  const [clearing, setClearing] = useState<Record<string, boolean>>({})
  const [diagnostics, setDiagnostics] = useState<Record<string, any>>({})
  const [expandedProjects, setExpandedProjects] = useState<string[]>(() => {
    try {
      const stored = localStorage.getItem('sd-expanded-project')
      return stored ? JSON.parse(stored) : []
    } catch { return [] }
  })
  const [envEditingProject, setEnvEditingProject] = useState<string | null>(null)
  const [envFileName, setEnvFileName] = useState('.env.local')
  const [envContent, setEnvContent] = useState('')
  const [envSaving, setEnvSaving] = useState(false)
  const [envAnimState, setEnvAnimState] = useState<'enter' | 'exit'>('enter')
  const envCloseTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  // WHY: Cleanup Env Editor close timer khi component unmount (phòng khi có refactor thành conditional mount).
  useEffect(() => () => { if (envCloseTimerRef.current) clearTimeout(envCloseTimerRef.current) }, [])
  const [batchLoading, setBatchLoading] = useState(false)
  const [portConflicts, setPortConflicts] = useState<Record<number, string[]>>({})
  const [logSearch, setLogSearch] = useState('')
  const [logFilter, setLogFilter] = useState<string[]>(() => {
    try {
      const stored = localStorage.getItem('sd-log-filter')
      return stored ? JSON.parse(stored) : []
    } catch { return [] }
  })
  const [searchHistory, setSearchHistory] = useState<string[]>(() => {
    try {
      const stored = localStorage.getItem('sd-log-search-history')
      return stored ? JSON.parse(stored) : []
    } catch { return [] }
  })
  const [showSearchHistory, setShowSearchHistory] = useState(false)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const [projectScripts, setProjectScripts] = useState<Record<string, string[]>>({})
  const [diskSizes, setDiskSizes] = useState<Record<string, Record<string, number>>>({})
  const [tunnelStates, setTunnelStates] = useState<Record<string, TunnelState>>({})
  const [tunnelLoading, setTunnelLoading] = useState<Record<string, boolean>>({})
  const [installingCloudflared, setInstallingCloudflared] = useState(false)
  const [watchdogToggling, setWatchdogToggling] = useState<Record<string, boolean>>({})
  const [batchTunnelLoading, setBatchTunnelLoading] = useState(false)
  const [activeInfoTooltip, setActiveInfoTooltip] = useState<string | null>(null)
  const infoTooltipRef = useRef<HTMLDivElement | null>(null)
  // WHY: Server tự phát hiện (chạy ngoài config) — GET /api/projects/detected.
  // Banner hỗ trợ thêm 1 click vào cấu hình.
  const [detectedServers, setDetectedServers] = useState<any[]>([])
  const [addingDetected, setAddingDetected] = useState<Record<number, boolean>>({})

  // WHY: Đóng tooltip info khi click bên ngoài — listener global theo dõi mousedown
  // (nhanh hơn click, bắt cả mousedown trên row khác).
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (activeInfoTooltip && infoTooltipRef.current && !infoTooltipRef.current.contains(e.target as Node)) {
        setActiveInfoTooltip(null)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [activeInfoTooltip])

  const [logZebraTemplate, setLogZebraTemplate] = useState<string>(() => {
    try {
      return localStorage.getItem('sd-log-zebra-template') || 'blue-white'
    } catch { return 'blue-white' }
  })

  // WHY: Đổi template zebra log — persist vào localStorage để giữ giữa các lần mở app.
  const handleZebraChange = (template: string) => {
    setLogZebraTemplate(template)
    try { localStorage.setItem('sd-log-zebra-template', template) } catch {}
  }

  // WHY: Tính màu nền zebra cho dòng log theo template (blue-white/emerald-dark/
  // purple-neon/amber-warm) + theme — màu even/odd khác nhau dễ đọc dòng.
  const getZebraBackground = (index: number, template: string, currentTheme: 'light' | 'dark', defaultBg?: string) => {
    const isEven = index % 2 === 0
    if (template === 'blue-white') {
      return isEven
        ? (currentTheme === 'dark' ? 'rgba(59, 130, 246, 0.12)' : 'rgba(219, 234, 254, 0.55)')
        : (currentTheme === 'dark' ? 'rgba(255, 255, 255, 0.02)' : 'rgba(255, 255, 255, 1)')
    }
    if (template === 'emerald-dark') {
      return isEven
        ? (currentTheme === 'dark' ? 'rgba(16, 185, 129, 0.12)' : 'rgba(209, 250, 229, 0.55)')
        : (currentTheme === 'dark' ? 'rgba(0, 0, 0, 0.2)' : 'rgba(255, 255, 255, 1)')
    }
    if (template === 'purple-neon') {
      return isEven
        ? (currentTheme === 'dark' ? 'rgba(168, 85, 247, 0.14)' : 'rgba(243, 232, 255, 0.55)')
        : (currentTheme === 'dark' ? 'rgba(255, 255, 255, 0.02)' : 'rgba(255, 255, 255, 1)')
    }
    if (template === 'amber-warm') {
      return isEven
        ? (currentTheme === 'dark' ? 'rgba(245, 158, 11, 0.12)' : 'rgba(254, 243, 199, 0.55)')
        : (currentTheme === 'dark' ? 'rgba(0, 0, 0, 0.2)' : 'rgba(255, 255, 255, 1)')
    }
    if (template === 'contrast-mono') {
      return isEven
        ? (currentTheme === 'dark' ? 'rgba(255, 255, 255, 0.06)' : 'rgba(241, 245, 249, 1)')
        : (currentTheme === 'dark' ? 'rgba(0, 0, 0, 0.3)' : 'rgba(255, 255, 255, 1)')
    }
    return defaultBg || 'transparent'
  }

  const [logTheme, setLogTheme] = useState<'light' | 'dark'>(() => {
    try {
      const stored = localStorage.getItem('sd-log-theme')
      return stored === 'dark' ? 'dark' : 'light'
    } catch { return 'light' }
  })
  const logEndRef = useRef<HTMLDivElement>(null)
  const logScrollRef = useRef<HTMLDivElement>(null)
  const prevTabRef = useRef(activeTab)
  // WHY: Track segment vừa được click để chạy glow animation pulse ngắn.
  // Dùng useState thay vì useRef vì cần trigger re-render khi clear timeout để gỡ class animation.
  const [clickedSegment, setClickedSegment] = useState<string | null>(null)

  // WHY: Dùng useRef để luôn có logFilter mới nhất trong callback filter,
  // tránh stale closure khi fetchLogs cập nhật logs state (mỗi 2s) nhưng filter vẫn được giữ nguyên.
  // Sync đồng bộ (không dùng useEffect) để ref luôn có giá trị mới nhất NGAY trong render.
  // WHY: Persist search history to localStorage mỗi khi thay đổi.
  useEffect(() => {
    localStorage.setItem('sd-log-search-history', JSON.stringify(searchHistory.slice(0, 10)))
  }, [searchHistory])
  // WHY: Persist logFilter để giữ filter giữa các lần mở app.
  useEffect(() => {
    localStorage.setItem('sd-log-filter', JSON.stringify(logFilter))
  }, [logFilter])
  // WHY: Persist expanded/collapsed project card state để giữ lại khi mở lại app.
  useEffect(() => {
    if (expandedProjects.length > 0) {
      localStorage.setItem('sd-expanded-project', JSON.stringify(expandedProjects))
    } else {
      localStorage.removeItem('sd-expanded-project')
    }
  }, [expandedProjects])
  // WHY: Persist activeTab để giữ lại log tab đang xem khi refresh/ mở lại app.
  useEffect(() => {
    localStorage.setItem('sd-active-tab', activeTab)
  }, [activeTab])
  // WHY: Persist logTheme để giữ chế độ sáng/tối giữa các lần mở app.
  useEffect(() => {
    localStorage.setItem('sd-log-theme', logTheme)
  }, [logTheme])

  const [showFilterDropdown, setShowFilterDropdown] = useState(false)
  const filterDropdownRef = useRef<HTMLDivElement>(null)
  const [logContextMenu, setLogContextMenu] = useState<{ x: number; y: number } | null>(null)

  // WHY: Click outside or press ESC to close context menu & dropdowns
  useEffect(() => {
    const handleCloseContextMenu = () => setLogContextMenu(null)
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setLogContextMenu(null)
        setShowFilterDropdown(false)
      }
    }
    window.addEventListener('click', handleCloseContextMenu)
    window.addEventListener('keydown', handleEsc)
    return () => {
      window.removeEventListener('click', handleCloseContextMenu)
      window.removeEventListener('keydown', handleEsc)
    }
  }, [])

  // WHY: Ref cho inactive để tránh stale closure trong keyHandler (Ctrl+F check).
  const inactiveRef = useRef(inactive)
  inactiveRef.current = inactive

  // WHY: Click outside filter dropdown to close.
  useEffect(() => {
    const clickHandler = (e: MouseEvent) => {
      if (filterDropdownRef.current && !filterDropdownRef.current.contains(e.target as Node)) {
        setShowFilterDropdown(false)
      }
    }
    // WHY: Keyboard shortcuts cho terminal — Escape đóng dropdown/history,
    // Ctrl+F/Cmd+F focus ô search (ngăn browser find dialog mặc định).
    const keyHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (showFilterDropdown) setShowFilterDropdown(false)
        if (showSearchHistory) setShowSearchHistory(false)
        // Focus về search input để tiếp tục gõ
        if (showSearchHistory) searchInputRef.current?.focus()
      }
      // WHY: Ctrl+F / Cmd+F → focus vào ô search, ngăn browser find dialog.
      // Dùng inactiveRef (không phải inactive) để tránh stale closure.
      if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
        if (inactiveRef.current) return
        e.preventDefault()
        searchInputRef.current?.focus()
        // onFocus handler trên input sẽ tự setShowSearchHistory(true)
      }
    }
    if (showFilterDropdown) document.addEventListener('mousedown', clickHandler)
    document.addEventListener('keydown', keyHandler)
    return () => {
      document.removeEventListener('mousedown', clickHandler)
      document.removeEventListener('keydown', keyHandler)
    }
  }, [showFilterDropdown, showSearchHistory])

  // WHY: Track first render để skip staggered animation trên progress bar segments.
  // Capture giá trị trước khi mutate ref để dùng trong JSX (render body chạy trước JSX).
  const isFirstRender = useRef(true)
  const initialRender = isFirstRender.current
  if (isFirstRender.current) isFirstRender.current = false

  // WHY: Dùng ref để luôn có tunnelStates mới nhất trong batch callbacks,
  // tránh stale closure khi state chưa kịp update.
  const tunnelStatesRef = useRef(tunnelStates)
  tunnelStatesRef.current = tunnelStates
  // WHY: Dùng ref để theo dõi URL tunnel trước đó, tránh auto-copy lại mỗi 5s.
  const prevTunnelUrlsRef = useRef<Record<string, string>>({})

  // WHY: Fetch port conflicts for all project ports
  const scanPortConflicts = useCallback(async () => {
    const ports = projects.map(p => p.port).filter(Boolean)
    if (ports.length === 0) return
    try {
      const res = await fetchWithRetry(`${API}/api/system/port-scan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ports })
      })
      if (res.ok) {
        const data = await res.json()
        // WHY: Set fresh data, các port không còn conflict sẽ tự động bị xóa
        setPortConflicts(data.ports || {})
      } else {
        setPortConflicts({})
      }
    } catch {
      setPortConflicts({})
    }
  }, [projects])

  // WHY: Fetch disk usage and npm scripts for each running project
  const fetchProjectExtras = useCallback(async () => {
    for (const p of projects) {
      // WHY: Lệnh tùy chỉnh (type=custom) không phải project Node — bỏ qua npm scripts + disk usage.
      if (p.running && p.type !== 'custom') {
        // Fetch scripts
        try {
          const res = await fetchWithRetry(`${API}/api/projects/${encodeURIComponent(p.name)}/scripts`)
          if (res.ok) {
            const data = await res.json()
            setProjectScripts(prev => ({ ...prev, [p.name]: Object.keys(data.scripts || {}) }))
          }
        } catch {}
        // Fetch disk usage
        try {
          const res = await fetchWithRetry(`${API}/api/projects/${encodeURIComponent(p.name)}/disk-usage`)
          if (res.ok) {
            const data = await res.json()
            setDiskSizes(prev => ({ ...prev, [p.name]: data.sizes || {} }))
          }
        } catch {}
      }
    }
  }, [projects])

  // WHY: Scan ports and fetch extras periodically
  // WHY: Chỉ chạy port scan + extras khi module active. Khi inactive => clear interval.
  useEffect(() => {
    if ((inactive && !backgroundPolling) || projects.length === 0) return
    scanPortConflicts()
    fetchProjectExtras()
    const interval = setInterval(() => {
      scanPortConflicts()
      fetchProjectExtras()
    }, 30000)
    return () => clearInterval(interval)
  }, [scanPortConflicts, fetchProjectExtras, inactive, backgroundPolling])

  // WHY: Fetch diagnostics (memory, CPU, uptime, git, env version) cho 1 project.
  // Goi moi 2s khi project dang duoc expand.
  const fetchDiagnostics = useCallback(async (name: string) => {
    try {
      const res = await fetchWithRetry(`${API}/api/projects/${encodeURIComponent(name)}/diagnostics`)
      if (res.ok) {
        const data = await res.json()
        setDiagnostics(prev => ({ ...prev, [name]: data }))
      }
    } catch {}
  }, [])

  // WHY: Fetch tunnel status (URL, error, watchdog, restart count) từ backend.
  // Dùng useCallback với [] deps để reference ổn định, tránh re-create interval.
  const fetchTunnelStatus = useCallback(async (name: string) => {
    try {
      const res = await fetchWithRetry(`${API}/api/projects/${encodeURIComponent(name)}/tunnel`)
      if (res.ok) {
        const data = await res.json()
        setTunnelStates(prev => ({ ...prev, [name]: data }))
      }
    } catch {}
  }, [])

  // WHY: Gọi API start tunnel. Backend auto-download cloudflared nếu chưa có.
  // Tự fetch status mới từ response (không cần đợi polling 4s).
  const startTunnel = useCallback(async (name: string) => {
    setTunnelLoading(l => ({ ...l, [name]: true }))
    try {
      const res = await fetchWithRetry(`${API}/api/projects/${encodeURIComponent(name)}/tunnel/start`, { method: 'POST' })
      const data = await res.json()
      if (res.ok) {
        setTunnelStates(prev => ({ ...prev, [name]: data }))
        setStatusText(`🌐 Tunnel started for ${name}`)
        addToast({ type: 'success', title: `🌐 ${name}`, message: 'Tunnel đã được mở thành công' })
      } else {
        setStatusText(`❌ Lỗi tunnel: ${data.error || 'Không xác định'}`)
        addToast({ type: 'error', title: `🌐 ${name}`, message: data.error || 'Mở tunnel thất bại' })
        if (data.instructions) setStatusText(data.instructions)
      }
    } catch {
      setStatusText('Mở tunnel thất bại')
      addToast({ type: 'error', title: '🔌 Mất kết nối', message: 'Không thể kết nối tới backend' })
    }
    finally { setTunnelLoading(l => ({ ...l, [name]: false })) }
  }, [setStatusText, addToast])

  // WHY: Stop tunnel + fetch fresh status ngay lập tức (không đợi polling 4s).
  // Gọi GET /tunnel sau POST /tunnel/stop để đồng bộ state UI ngay.
  const stopTunnel = useCallback(async (name: string) => {
    setTunnelLoading(l => ({ ...l, [name]: true }))
    try {
      const res = await fetchWithRetry(`${API}/api/projects/${encodeURIComponent(name)}/tunnel/stop`, { method: 'POST' })
      if (res.ok) {
        // Fetch fresh status from backend
        const statusRes = await fetchWithRetry(`${API}/api/projects/${encodeURIComponent(name)}/tunnel`)
        if (statusRes.ok) {
          const data = await statusRes.json()
          setTunnelStates(prev => ({ ...prev, [name]: data }))
        }
        setStatusText(`Tunnel stopped for ${name}`)
        addToast({ type: 'info', title: `🌐 ${name}`, message: 'Tunnel đã đóng' })
      }
    } catch {
      setStatusText('Dừng tunnel thất bại')
      addToast({ type: 'error', title: `🌐 ${name}`, message: 'Dừng tunnel thất bại' })
    }
    finally { setTunnelLoading(l => ({ ...l, [name]: false })) }
  }, [setStatusText, addToast])

  // WHY: Tải cloudflared.exe từ GitHub releases. Độc lập với tunnel start.
  // User có thể cài trước, sau đó bật tunnel mà không cần download lại.
  const installCloudflared = useCallback(async () => {
    setInstallingCloudflared(true)
    try {
      const res = await fetchWithRetry(`${API}/api/cloudflared/install`, { method: 'POST' })
      if (res.ok) {
        setStatusText('✅ Đã cài cloudflared thành công!')
        addToast({ type: 'success', title: '🌐 cloudflared', message: 'Đã cài cloudflared thành công' })
        return true
      } else {
        const data = await res.json()
        setStatusText(`❌ Cài đặt thất bại: ${data.error}`)
        addToast({ type: 'error', title: '🌐 cloudflared', message: data.error || 'Cài đặt thất bại' })
        return false
      }
    } catch {
      setStatusText('❌ Lỗi kết nối khi cài cloudflared')
      addToast({ type: 'error', title: '🌐 cloudflared', message: 'Lỗi kết nối khi cài cloudflared' })
      return false
    } finally {
      setInstallingCloudflared(false)
    }
  }, [setStatusText, addToast])

  // WHY: 1-click setup: tải cloudflared → start tunnel → bật watchdog.
  // Gọi backend API duy nhất (install-and-start) để tránh race condition
  // giữa các bước. UI hiển thị spinner xuyên suốt.
  const installAndStartTunnel = useCallback(async (name: string) => {
    setTunnelLoading(l => ({ ...l, [name]: true }))
    setStatusText('📥 Đang tải cloudflared...')
    try {
      const res = await fetchWithRetry(`${API}/api/projects/${encodeURIComponent(name)}/tunnel/install-and-start`, { method: 'POST' })
      const data = await res.json()
      if (res.ok) {
        setTunnelStates(prev => ({ ...prev, [name]: data }))
        setStatusText('🌐 Tunnel started!')
        addToast({ type: 'success', title: `🌐 ${name}`, message: 'Tunnel đã được cài và mở thành công' })
      } else {
        setStatusText(`❌ ${data.error || 'Thất bại'}`)
        addToast({ type: 'error', title: `🌐 ${name}`, message: data.error || 'Cài & mở tunnel thất bại' })
      }
    } catch {
      setStatusText('❌ Connection failed')
      addToast({ type: 'error', title: `🌐 ${name}`, message: 'Mất kết nối khi cài tunnel' })
    }
    finally { setTunnelLoading(l => ({ ...l, [name]: false })) }
  }, [setStatusText, addToast])

  // WHY: Bật/tắt watchdog backend rồi cập nhật state local ngay (không đợi polling).
  // Kiểm tra prev[name] tồn tại trước khi merge để tránh ghi đè state undefined.
  const toggleWatchdog = useCallback(async (name: string, enabled: boolean) => {
    setWatchdogToggling(w => ({ ...w, [name]: true }))
    try {
      const res = await fetchWithRetry(`${API}/api/projects/${encodeURIComponent(name)}/tunnel/watchdog`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled })
      })
      if (res.ok) {
        const data = await res.json()
        setTunnelStates(prev => prev[name] ? {
          ...prev,
          [name]: { ...prev[name], watchdog_enabled: data.watchdog_enabled }
        } : prev)
        setStatusText(enabled ? '🛡️ Watchdog bật - tunnel sẽ tự động phục hồi' : 'Watchdog tắt')
        addToast({ type: 'info', title: `🛡️ ${name}`, message: enabled ? 'Watchdog đã được bật' : 'Watchdog đã tắt' })
      }
    } catch {
      setStatusText('Lỗi khi thay đổi watchdog')
      addToast({ type: 'error', title: `🛡️ ${name}`, message: 'Thay đổi watchdog thất bại' })
    }
    finally { setWatchdogToggling(w => ({ ...w, [name]: false })) }
  }, [setStatusText, addToast])

  // WHY: Dùng ref để theo dõi project list hiện tại, tránh re-create interval mỗi 3 giây
  const projectsRef = useRef(projects)
  projectsRef.current = projects

  // WHY: Diagnostics + tunnel status polling — chạy cho tất cả expanded projects.
  // Khi inactive => clear intervals, nhưng giữ expandedProjects state để khi active lại vẫn mở.
  useEffect(() => {
    if ((inactive && !backgroundPolling) || expandedProjects.length === 0) return
    const valid = expandedProjects.filter(name => projectsRef.current.some(p => p.name === name))
    if (valid.length !== expandedProjects.length) {
      setExpandedProjects(valid)
      if (valid.length === 0) return
    }
    valid.forEach(name => {
      fetchDiagnostics(name)
      if (projectsRef.current.find(p => p.name === name)?.type !== 'custom') fetchTunnelStatus(name)
    })
    const interval = setInterval(() => {
      const stillValid = expandedProjects.filter(name => projectsRef.current.some(p => p.name === name))
      if (stillValid.length !== expandedProjects.length) {
        setExpandedProjects(stillValid)
        if (stillValid.length === 0) return
      }
      stillValid.forEach(name => fetchDiagnostics(name))
    }, 4000)
    const tunnelInterval = setInterval(() => {
      const stillValid = expandedProjects.filter(name => projectsRef.current.some(p => p.name === name))
      if (stillValid.length !== expandedProjects.length) {
        setExpandedProjects(stillValid)
        if (stillValid.length === 0) return
      }
      stillValid
        .filter(name => projectsRef.current.find(p => p.name === name)?.type !== 'custom')
        .forEach(name => fetchTunnelStatus(name))
    }, 6000)
    return () => { clearInterval(interval); clearInterval(tunnelInterval) }
  }, [expandedProjects, fetchDiagnostics, fetchTunnelStatus, inactive, backgroundPolling])

  // WHY: Track lần đầu auto-expand để tránh re-trigger mỗi 3s khi poll.
  const hasAutoExpanded = useRef(false)
  // WHY: Mặc định mở rộng tất cả projects khi lần đầu load danh sách.
  // Chỉ chạy 1 lần duy nhất, không re-trigger khi fetchProjects poll lại.
  useEffect(() => {
    if (expandedProjects.length === 0 && projects.length > 0 && !hasAutoExpanded.current) {
      hasAutoExpanded.current = true
      setExpandedProjects(projects.map(p => p.name))
    }
  }, [projects, expandedProjects])

  // WHY: Fetch danh sach projects + cap nhat tray icon.
  // Dung invoke('update_tray_status') de dong bo voi system tray.
  const fetchProjects = useCallback(async () => {
    try {
      const res = await fetchWithRetry(`${API}/api/projects`, { signal: pollAbortRef.current?.signal })
      const data: Project[] = await res.json()
      setProjects(data)
      const running = data.filter(p => p.running).length
      setStatusText(`${running}/${data.length} servers running`)
      try {
        const { invoke } = await import('@tauri-apps/api/core')
        await invoke('update_tray_status', { running, total: data.length })
      } catch {}      } catch { setStatusText('Đang tải dữ liệu...') }
  }, [setStatusText])

  // WHY: Expose global functions for tray menu (Start All / Stop All)
  // Phải đặt SAU fetchProjects để tránh used-before-declaration error
  useEffect(() => {
    const startAll = async () => {
      try { await fetchWithRetry(`${API}/api/projects/start-all`, { method: 'POST' }); await fetchProjects() } catch {}
    }
    // WHY: Stop All — POST /api/projects/stop-all rồi refresh projects list.
    // Dùng cho tray menu, không có UI loading indicator.
    const stopAll = async () => {
      try { await fetchWithRetry(`${API}/api/projects/stop-all`, { method: 'POST' }); await fetchProjects() } catch {}
    }
    ;(window as any).__startAll = startAll
    ;(window as any).__stopAll = stopAll
    return () => {
      delete (window as any).__startAll
      delete (window as any).__stopAll
    }
  }, [fetchProjects])

  // WHY: Quét dev-server đang chạy NHƯNG chưa có trong config → banner "Phát hiện".
  // Backend scan 1 lần psutil <100ms; gọi kèm poll projects (10s).
  const fetchDetected = useCallback(async () => {
    try {
      const res = await fetchWithRetry(`${API}/api/projects/detected`, { signal: pollAbortRef.current?.signal })
      if (!res.ok) return
      const data = await res.json()
      setDetectedServers(data?.detected || [])
    } catch {}
  }, [])

  // WHY: Thêm server phát hiện vào config 1 click → POST /api/config/projects
  // (name/path/port/command), refresh projects + re-scan detected.
  const addDetectedServer = useCallback(async (d: any) => {
    setAddingDetected(prev => ({ ...prev, [d.port]: true }))
    try {
      const res = await fetchWithRetry(`${API}/api/config/projects`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: d.name, path: d.path || '', command: d.command, port: d.port
        })
      })
      if (res.ok) {
        addToast({ type: 'success', title: '⚡ Đã thêm project', message: `${d.name} (:${d.port})` })
        await fetchProjects()
        await fetchDetected()
      } else {
        const data = await res.json().catch(() => ({}))
        setStatusText(`❌ ${data.error || 'Thêm thất bại'}`)
        addToast({ type: 'error', title: '⚡ Thêm project', message: data.error || 'Thêm thất bại' })
      }
    } catch {}
    setAddingDetected(prev => ({ ...prev, [d.port]: false }))
  }, [fetchProjects, fetchDetected, setStatusText, addToast])

  // WHY: Fetch tat ca logs (merge vao All tab).
  // Gioi han 300 dong/project + 300 dong All de tranh render qua nhieu.
  const fetchLogs = useCallback(async () => {
    try {
      const res = await fetchWithRetry(`${API}/api/logs/all`, { signal: pollAbortRef.current?.signal })
      const data: Record<string, string[]> = await res.json()
      const merged: Record<string, string[]> = { All: [] }
      const fullMerged: Record<string, string[]> = { All: [] }
      Object.entries(data).forEach(([name, lines]) => {
        merged[name] = lines.slice(-300)
        lines.slice(-300).forEach(l => merged.All.push(l))
        fullMerged[name] = lines
        lines.forEach(l => fullMerged.All.push(l))
      })
      setLogs(merged)
      setFullLogs(fullMerged)
    } catch {}
  }, [])

  // WHY: Fetch tất cả tunnel statuses để quick button trên card biết trạng thái,
  // không chỉ project đang expanded. Dùng projectsRef để tránh stale closure.
  const fetchAllTunnelStatuses = useCallback(async () => {
    for (const p of projectsRef.current) {
      if (p.type === 'custom') continue
      try {
        const signal = pollAbortRef.current?.signal
        const res = await fetchWithRetry(`${API}/api/projects/${encodeURIComponent(p.name)}/tunnel`, { signal })
        if (res.ok) {
          const data = await res.json()
          setTunnelStates(prev => ({ ...prev, [p.name]: data }))
        }
      } catch {}
    }
  }, [])

  // WHY: Dùng tunnelStatesRef thay vì tunnelStates (state) để tránh stale closure
  // khi batch function được gọi sau đó (interval đã chạy từ trước).
  const startAllTunnels = useCallback(async () => {
    setBatchTunnelLoading(true)
    let count = 0
    for (const p of projectsRef.current) {
      if (p.running && p.type !== 'custom') {
        const ts = tunnelStatesRef.current[p.name]
        if (ts?.status !== 'active' && ts?.status !== 'connecting') {
          try {
            if (ts?.cloudflared_installed === false) {
              await fetchWithRetry(`${API}/api/projects/${encodeURIComponent(p.name)}/tunnel/install-and-start`, { method: 'POST' })
            } else {
              await fetchWithRetry(`${API}/api/projects/${encodeURIComponent(p.name)}/tunnel/start`, { method: 'POST' })
            }
            count++
          } catch {}
        }
      }
    }
    await fetchAllTunnelStatuses()
    setStatusText(`🌐 Đã bật ${count} tunnels`)
    addToast({ type: 'success', title: '🌐 Tunnel hàng loạt', message: `Đã bật ${count} tunnel` })
    setBatchTunnelLoading(false)
  }, [setStatusText, addToast, fetchAllTunnelStatuses])

  // WHY: Tương tự startAllTunnels, dùng ref để đọc trạng thái mới nhất.
  const stopAllTunnels = useCallback(async () => {
    setBatchTunnelLoading(true)
    let count = 0
    for (const p of projectsRef.current) {
      if (p.type === 'custom') continue
      const ts = tunnelStatesRef.current[p.name]
      if (ts?.status === 'active' || ts?.status === 'connecting') {
        try {
          await fetchWithRetry(`${API}/api/projects/${encodeURIComponent(p.name)}/tunnel/stop`, { method: 'POST' })
          count++
        } catch {}
      }
    }
    await fetchAllTunnelStatuses()
    setStatusText(`Đã dừng ${count} tunnels`)
    addToast({ type: 'info', title: '🌐 Tunnel hàng loạt', message: `Đã dừng ${count} tunnel` })
    setBatchTunnelLoading(false)
  }, [setStatusText, addToast, fetchAllTunnelStatuses])

  // WHY: Polling chính — chỉ chạy khi module active. Khi inactive: clear intervals.
  // Khi active trở lại: fetch ngay lập tức + restart intervals, không cần đợi chu kỳ.
  useEffect(() => {
    if (inactive && !backgroundPolling) return
    // WHY: Abort any in-flight fetch from previous poll cycle
    if (pollAbortRef.current) pollAbortRef.current.abort()
    pollAbortRef.current = new AbortController()
    fetchProjects()
    fetchLogs()
    fetchAllTunnelStatuses()
    fetchDetected()
    const i1 = setInterval(fetchProjects, 5000)
    const i2 = setInterval(fetchLogs, 5000)
    const i3 = setInterval(fetchAllTunnelStatuses, 10000)
    const i4 = setInterval(fetchDetected, 10000)
    return () => {
      pollAbortRef.current?.abort()
      clearInterval(i1); clearInterval(i2); clearInterval(i3); clearInterval(i4)
    }
  }, [fetchProjects, fetchLogs, fetchAllTunnelStatuses, fetchDetected, inactive, backgroundPolling])

  // WHY: Auto-copy URL khi tunnel chuyển từ 'connecting' sang 'active'.
  // Dùng prevTunnelUrlsRef để chỉ copy KHI URL thay đổi, tránh copy lại mỗi 5 giây.
  useEffect(() => {
    for (const [name, state] of Object.entries(tunnelStates)) {
      if (state?.status === 'active' && state?.url && prevTunnelUrlsRef.current[name] !== state.url) {
        prevTunnelUrlsRef.current[name] = state.url
        // WHY: Fallback nếu clipboard API không hoạt động (HTTP/HTTPS restriction, permission).
        // Nếu thất bại, URL vẫn hiển thị trên UI để user tự copy.
        navigator.clipboard.writeText(state.url).then(() => {
          setStatusText(`📋 Đã tự động copy URL: ${state.url}`)
        }).catch(() => {
          // Silent fail — URL vẫn hiển thị trên UI, user có thể click nút Copy thủ công
        })
      }
    }
  }, [tunnelStates, setStatusText])

  useEffect(() => {
    const current = logEndRef.current
    if (!current) return
    const container = current.parentElement
    if (!container) return
    const tabChanged = prevTabRef.current !== activeTab
    prevTabRef.current = activeTab
    if (tabChanged) current.scrollIntoView({ behavior: 'smooth' })
    else {
      const isAtBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 50
      if (isAtBottom) {
        // WHY: Instant scroll cho log realtime để user không bị giật khi đọc
        current.scrollIntoView({ behavior: 'instant' })
      }
    }
  }, [logs, activeTab])

  // WHY: Start/stop 1 project. POST /api/projects/<name>/start hoac stop.
  // Refresh projects list sau khi action. Stop cũng refresh tunnel status —
  // backend tự dừng tunnel khi dừng project (chống flood lỗi origin-down).
  const act = async (name: string, action: 'start' | 'stop') => {
    setLoading(p => ({ ...p, [name]: true }))
    try {
      const res = await fetchWithRetry(`${API}/api/projects/${encodeURIComponent(name)}/${action}`, { method: 'POST' })
      if (res.ok) {
        setStatusText(`${action === 'start' ? 'Đã chạy' : 'Đã dừng'} ${name}`)
        if (action === 'start') {
          addToast({ type: 'success', title: `🚀 ${name}`, message: 'Máy chủ đã khởi động' })
        } else {
          addToast({ type: 'info', title: `⏹ ${name}`, message: 'Máy chủ đã dừng' })
        }
      } else {
        const e = await res.json();
        setStatusText(e.error || 'Thất bại')
        addToast({ type: 'error', title: `❌ ${name}`, message: e.error || 'Thao tác thất bại' })
      }
      await fetchProjects()
      if (action === 'stop') fetchAllTunnelStatuses()
    } catch {
      setStatusText('Mất kết nối')
      addToast({ type: 'error', title: '🔌 Mất kết nối', message: `Không thể ${action === 'start' ? 'khởi động' : 'dừng'} ${name}` })
    }
    finally { setLoading(p => ({ ...p, [name]: false })) }
  }

  // WHY: 3 muc do clean — basic (cache), deep (build folders), nuke (node_modules + reinstall).
  // Confirm truoc khi clean vi khong undo duoc.
  const cleanProject = async (name: string, type: 'basic' | 'deep' | 'nuke') => {
    let msg = `Run clean (${type}) for ${name}?`
    if (type === 'deep') msg = 'Dọn sâu sẽ dừng máy chủ và xóa thư mục build. Tiếp tục?'
    else if (type === 'nuke') msg = `⚠️ XÓA SẠCH sẽ xóa node_modules và cài lại. Tiếp tục?`
    if (!window.confirm(msg)) return
    setClearing(c => ({ ...c, [name]: true }))
    try {
      const res = await fetchWithRetry(`${API}/api/projects/${encodeURIComponent(name)}/clean`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type })
      })
      const data = await res.json()
      if (res.ok) {
        if (data.status === 'nuked_reinstalling') {
          setStatusText(`Đã xóa sạch ${name}! Đang cài lại...`)
          addToast({ type: 'info', title: `🧹 ${name}`, message: 'Đã nuke và đang chạy npm install' })
          setActiveTab(name)
        } else {
          setStatusText(`Đã dọn ${data.removed?.join(', ') || 'không có gì'} cho ${name}`)
          addToast({ type: 'success', title: `🧹 ${name}`, message: `Đã dọn ${data.removed?.length || 0} mục` })
        }
      } else {
        setStatusText(data.error || 'Dọn dẹp thất bại')
        addToast({ type: 'error', title: `🧹 ${name}`, message: data.error || 'Dọn dẹp thất bại' })
      }
      await fetchProjects()
    } catch {
      setStatusText('Mất kết nối')
      addToast({ type: 'error', title: '🔌 Mất kết nối', message: 'Không thể kết nối tới backend' })
    }
    finally { setClearing(c => ({ ...c, [name]: false })) }
  }

  // WHY: 3-layer fallback — Tauri shell.open > backend open browser > window.open.
  // Dynamic import de khong crash trong browser dev mode.
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

  // WHY: Mo modal editor cho .env file. GET /api/projects/<name>/env.
  // Tu dong phat hien .env.local vs .env (u tien local).
  // Clear stale close timeout để tránh race condition khi đóng/mở nhanh.
  const openEnvEditor = async (name: string) => {
    if (envCloseTimerRef.current) clearTimeout(envCloseTimerRef.current)
    setEnvAnimState('enter')
    setEnvEditingProject(name)
    setEnvContent('')
    try {
      const res = await fetchWithRetry(`${API}/api/projects/${encodeURIComponent(name)}/env`)
      if (res.ok) { const d = await res.json(); setEnvFileName(d.fileName); setEnvContent(d.content) }
    } catch { setStatusText('Lỗi tải file .env') }
  }

  // WHY: PUT /api/projects/<name>/env de save noi dung .env.
  // Co the chon fileName (.env.local, .env, .env.production).
  const saveEnvFile = async () => {
    if (!envEditingProject) return
    setEnvSaving(true)
    try {
      const res = await fetchWithRetry(`${API}/api/projects/${encodeURIComponent(envEditingProject)}/env`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileName: envFileName, content: envContent })
      })
      if (res.ok) { setStatusText(`Saved ${envFileName}`); setEnvEditingProject(null); addToast({ type: 'success', title: '💾 Lưu .env', message: `Đã lưu ${envFileName}` }) }
      else { const e = await res.json(); setStatusText(e.error || 'Thất bại'); addToast({ type: 'error', title: '💾 Lưu .env thất bại', message: e.error || 'Lỗi không xác định' }) }
    } catch { setStatusText('Mất kết nối'); addToast({ type: 'error', title: '🔌 Mất kết nối', message: 'Không thể kết nối tới backend' }) }
    finally { setEnvSaving(false) }
  }

  // WHY: Close Env Editor với exit animation giống SettingsModal.
  // Set animState='exit' → đợi animation 250ms → unmount.
  // Dùng ref để clear timeout nếu user mở lại trước khi animation kết thúc.
  const handleCloseEnvEditor = useCallback(() => {
    setEnvAnimState('exit')
    envCloseTimerRef.current = setTimeout(() => {
      setEnvEditingProject(null)
      setEnvAnimState('enter')
    }, 250)
  }, [])

  // WHY: Lay lines de export — limit=0 = tat ca, limit>0 = N dong cuoi cung.
  // Dung fullLogs (khong phai logs) de khong mat data do gioi han 300 dong.
  const getExportLines = (limit: number) => {
    const lines = fullLogs[activeTab] || []
    return limit === 0 || limit >= lines.length ? lines : lines.slice(-limit)
  }

  // WHY: 3 format — txt (plain), md (code block + metadata), json (structured).
  // Markdown format co header voi project name + date + limit.
  const formatLogs = (lines: string[], format: 'txt' | 'md' | 'json') => {
    if (format === 'json') return JSON.stringify(lines, null, 2)
    if (format === 'md') {
      return `# MultiTool Pro Logs - ${activeTab}\nDate: ${new Date().toLocaleString()}\nLimit: ${exportLimit === 0 ? 'All' : exportLimit} lines\n\n\`\`\`text\n${lines.join('\n')}\n\`\`\`\n`
    }
    return lines.join('\n')
  }

  // WHY: Copy log ra clipboard — dung exportFormat + exportLimit.
  // Fallback: neu clipboard API fail, log van hien thi tren UI.
  const handleCopyLog = () => {
    const targetLines = getExportLines(exportLimit)
    if (!targetLines.length) { setStatusText('Không có log để sao chép'); return }
    const content = formatLogs(targetLines, exportFormat)
    navigator.clipboard.writeText(content)
    setStatusText(`Copied ${targetLines.length} lines as ${exportFormat.toUpperCase()}`)
  }

  // WHY: Download log qua backend API (/api/logs/export) — xu ly file name tu Content-Disposition header.
  // Blob download fallback cho browser mode (khong co Tauri save dialog).
  const handleDownloadLog = async () => {
    const lines = fullLogs[activeTab] || []
    if (!lines.length) { setStatusText('Không có log để tải'); return }
    try {
      const params = new URLSearchParams({
        project: activeTab,
        format: exportFormat,
        limit: String(exportLimit),
        search: logSearch
      })
      const res = await fetchWithRetry(`${API}/api/logs/export?${params}`)
      if (!res.ok) { setStatusText('Tải thất bại'); return }
      const blob = await res.blob()
      const contentDisposition = res.headers.get('Content-Disposition')
      let filename = `logs_${activeTab.toLowerCase().replace(/\s+/g, '_')}.${exportFormat === 'txt' ? 'log' : exportFormat}`
      if (contentDisposition) {
        const match = contentDisposition.match(/filename="?([^"]+)"?/)
        if (match) filename = match[1]
      }
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url; a.download = filename
      document.body.appendChild(a); a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
      setStatusText(`Downloaded ${filename}`)
    } catch (e: any) { setStatusText(`❌ ${e.message}`) }
  }

  // WHY: Export log qua Tauri save dialog (cho phep chon noi luu file).
  // Fallback ve handleDownloadLog neu khong co Tauri runtime.
  const handleExportLog = async () => {
    const targetLines = getExportLines(exportLimit)
    if (!targetLines.length) { setStatusText('Không có log để xuất'); return }
    const content = formatLogs(targetLines, exportFormat)
    const fileExt = exportFormat === 'txt' ? 'log' : exportFormat
    const defaultName = `logs_${activeTab.toLowerCase().replace(/\s+/g, '_')}_${exportLimit === 0 ? 'all' : exportLimit}.${fileExt}`
    try {
      const { save } = await import('@tauri-apps/plugin-dialog')
      const selectedPath = await save({ title: 'Export Server Logs', defaultPath: defaultName, filters: [{ name: exportFormat.toUpperCase(), extensions: [fileExt] }] })
      if (!selectedPath) { setStatusText('Đã hủy xuất'); return }
      setStatusText('Đang lưu...')
      const res = await fetchWithRetry(`${API}/api/logs/save-to-file`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: selectedPath, content }) })
      setStatusText(res.ok ? `Đã xuất ra ${selectedPath.split(/[\\/]/).pop()}` : (await res.json()).error || 'Thất bại')
    } catch (err: any) { setStatusText(err?.message || 'Export error') }
  }

  const displayLines = logs[activeTab] || []
  // WHY: LevelFiltered lines rút lên đây — hooks useVirtualizer KHÔNG thể gọi
  // trong IIFE JSX. Virtualize 300-2000+ dòng, chỉ render row nhìn thấy.
  const levelFilteredLines = useMemo(() => {
    const filtered = logSearch
      ? displayLines.filter(l => l.toLowerCase().includes(logSearch.toLowerCase()))
      : displayLines
    if (logFilter.length === 0) return filtered
    return filtered.filter(l => {
      const level = detectLevel(l) || 'info'
      return logFilter.includes(level)
    })
  }, [displayLines, logSearch, logFilter])
  // WHY: Virtual list — estimate 18px + measureElement cho dòng wrap nhiều hàng
  // (break-all). overscan 8 render bù bên ngoài viewport.
  const terminalVirtual = useVirtualizer({
    count: levelFilteredLines.length,
    getScrollElement: () => logScrollRef.current,
    estimateSize: () => 18,
    overscan: 8,
    getItemKey: (i) => `${i}:${levelFilteredLines[i]?.length || 0}`,
  })
  // WHY: useMemo tránh tính toán level counts 2 lần (cho dropdown filter + progress bar)
  // mỗi khi displayLines thay đổi (logs refresh mỗi 2s).
  const logLevelCounts = useMemo(() => {
    const counts: Record<string, number> = {}
    let total = 0
    for (const line of displayLines) {
      const level = detectLevel(line)
      const key = level || 'info'
      counts[key] = (counts[key] || 0) + 1
      total++
    }
    return { counts, total }
  }, [displayLines])
  const tabs = ['All', ...projects.map(p => p.name)]

  return (
    <div className="flex flex-col h-full" style={{ display: inactive ? 'none' : 'flex' }}>
      {/* Batch Actions Toolbar */}
      <div className="shrink-0 flex items-center justify-between px-4 pt-3 pb-1 overflow-visible relative z-20">
        <div className="flex items-center gap-2">
          <button onClick={async () => {
            setBatchLoading(true)
            try {
              await fetchWithRetry(`${API}/api/projects/start-all`, { method: 'POST' })
              setStatusText('Đã khởi động tất cả')
              addToast({ type: 'success', title: '🚀 Khởi động hàng loạt', message: 'Tất cả dự án đã được khởi động' })
              await fetchProjects()
            } catch {
              setStatusText('Failed to start all')
              addToast({ type: 'error', title: '🚀 Khởi động hàng loạt thất bại', message: 'Không thể kết nối tới backend' })
            }
            finally { setBatchLoading(false) }
          }} disabled={batchLoading}
            className="px-3 py-1.5 text-xs font-semibold rounded-lg transition-all cursor-pointer disabled:opacity-30 active:scale-95 bg-emerald-500/15 text-emerald-500 hover:bg-emerald-500/25 ring-1 ring-emerald-500/20 border-0 flex items-center gap-1.5">
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5.636 18.364a9 9 0 010-12.728m12.728 0a9 9 0 010 12.728m-9.9-2.829a5 5 0 010-7.07m7.072 0a5 5 0 010 7.07M13 12a1 1 0 11-2 0 1 1 0 012 0z" />
            </svg>
            Bật tất cả
          </button>
          <button onClick={async () => {
            setBatchLoading(true)
            try {
              await fetchWithRetry(`${API}/api/projects/stop-all`, { method: 'POST' })
              setStatusText('Đã dừng tất cả')
              addToast({ type: 'info', title: '⏹ Dừng hàng loạt', message: 'Tất cả dự án đã được dừng' })
              await fetchProjects()
            } catch {
              setStatusText('Dừng tất cả thất bại')
              addToast({ type: 'error', title: '⏹ Dừng hàng loạt thất bại', message: 'Không thể kết nối tới backend' })
            }
            finally { setBatchLoading(false) }
          }} disabled={batchLoading}
            className="px-3 py-1.5 text-xs font-semibold rounded-lg transition-all cursor-pointer disabled:opacity-30 active:scale-95 bg-red-500/10 text-red-400 hover:bg-red-500/20 ring-1 ring-red-500/15 border-0 flex items-center gap-1.5">
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 10a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1h-4a1 1 0 01-1-1v-4z" />
            </svg>
            Tắt tất cả
          </button>
          {/* Batch Tunnel Actions */}
          <div className="w-px h-5 bg-white/10 mx-1" />
          <button onClick={startAllTunnels} disabled={batchTunnelLoading}
            className="px-2.5 py-1.5 text-xs font-semibold rounded-lg transition-all cursor-pointer disabled:opacity-30 active:scale-95 bg-sky-500/15 text-sky-400 hover:bg-sky-500/25 ring-1 ring-sky-500/20 border-0 flex items-center gap-1">
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
            </svg>
            Tunnel tất cả
          </button>
          <button onClick={stopAllTunnels} disabled={batchTunnelLoading}
            className="px-2.5 py-1.5 text-xs font-semibold rounded-lg transition-all cursor-pointer disabled:opacity-30 active:scale-95 bg-red-500/10 text-red-400 hover:bg-red-500/20 ring-1 ring-red-500/15 border-0 flex items-center gap-1">
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
            Tắt tunnel
          </button>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs" style={{ color: 'var(--fg-dim)' }}>{projects.filter(p => p.running).length}/{projects.length} đang chạy</span>
          {(() => {
            const activeTunnels = Object.values(tunnelStates).filter(s => s?.status === 'active').length
            const totalTunnels = Object.keys(tunnelStates).length
            const totalRestarts = Object.values(tunnelStates).reduce((sum, s) => sum + (s?.watchdog_restart_count || 0), 0)
            if (totalTunnels > 0) {
              return (
                <>
                  <span className="w-px h-3 bg-white/10" />
                  <span className="text-xs" style={{ color: activeTunnels > 0 ? '#34d399' : 'var(--fg-dim)' }}>
                    🌐 {activeTunnels}/{totalTunnels} tunnel
                  </span>
                  {totalRestarts > 0 && (
                    <span className="text-[10px] font-mono" style={{ color: '#fbbf24' }}>
                      🔄 {totalRestarts}
                    </span>
                  )}
                </>
              )
            }
            return null
          })()}
          {/* Settings button — mở SettingsModal (cấu hình projects) */}
          {onOpenSettings && (
            <button onClick={onOpenSettings}
              className="flex items-center gap-1 px-2 py-1 text-xs rounded-lg transition-all active:scale-95 cursor-pointer border-0 group relative shrink-0 hover:bg-emerald-500/10"
              style={{ color: 'var(--fg-muted)', background: 'transparent' }}>
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
              <span>Cài đặt</span>
              <span className="tooltip-text tooltip-below z-[999999]">Cài đặt máy chủ</span>
            </button>
          )}
          {batchLoading && (
            <div className="animate-spin rounded-full h-3 w-3 border-b border-emerald-500" />
          )}
          {batchTunnelLoading && (
            <div className="animate-spin rounded-full h-3 w-3 border-b border-sky-500" />
          )}
        </div>
      </div>
      {/* Detected servers banner — dev-server đang chạy nhưng chưa được cấu hình */}
      {detectedServers.length > 0 && (
        <div className="mx-4 mt-2 rounded-xl border px-3 py-2"
          style={{ borderColor: 'var(--card-border)', background: 'var(--card-bg)', boxShadow: '0 0 12px rgba(245,158,11,0.06)' }}>
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-xs font-semibold" style={{ color: '#fbbf24' }}>
              📡 Phát hiện {detectedServers.length} server đang chạy chưa được cấu hình
            </span>
            <button onClick={() => setDetectedServers([])}
              className="text-[10px] border-0 bg-transparent cursor-pointer hover:text-white"
              style={{ color: 'var(--fg-dim)' }}>ẩn</button>
          </div>
          <div className="flex flex-col gap-1">
            {detectedServers.map(d => (
              <div key={d.port} className="flex items-center justify-between gap-2 text-xs">
                <div className="min-w-0 flex-1 flex items-center">
                  <span className="font-mono text-emerald-400 shrink-0">:{d.port}</span>
                  <span className="ml-1.5 truncate" style={{ color: 'var(--fg)' }}>{d.name}</span>
                  {d.framework && (
                    <span className="ml-1.5 text-[10px] shrink-0" style={{ color: '#fbbf24' }}>⚡{d.framework}</span>
                  )}
                </div>
                <button onClick={() => addDetectedServer(d)} disabled={addingDetected[d.port]}
                  className="shrink-0 px-2 py-1 rounded-lg text-[10px] font-semibold border cursor-pointer disabled:opacity-50"
                  style={{ color: '#34d399', borderColor: 'rgba(52,211,153,0.3)', background: 'rgba(52,211,153,0.1)' }}>
                  {addingDetected[d.port] ? 'Đang thêm...' : '+ Thêm'}
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
      {/* Server Cards */}
      <div className="shrink-0 grid grid-cols-2 gap-3.5 px-4 pb-2 mt-2">
        {projects.map((p, idx) => {
          const isCardActive = activeInfoTooltip?.startsWith(p.name)
          return (
            <div key={p.name} className={`relative rounded-2xl border ${'animate-card-enter'} flex flex-col justify-between card-container ${p.running ? 'card-running' : ''} ${expandedProjects.includes(p.name) ? 'card-expanded' : ''}`}
              style={{
                background: 'var(--card-bg)',
                borderColor: 'var(--card-border)',
                animationDelay: `${idx * 0.05}s`,
                zIndex: isCardActive ? 99999 : 1,
                position: 'relative'
              }}>
              {p.running && <div className="card-accent-bar" />}
              <div className="p-3.5">
                {/* Card Header: Icon, Name, Status Badge, Port Badge, Info Button (i), Action Icons */}
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0 flex-1 flex items-center gap-2 flex-wrap">
                    <div className="w-6 h-6 rounded-md bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center shrink-0">
                      <span className="text-xs">⚡</span>
                    </div>
                    <h2 className="text-sm font-bold tracking-tight truncate" style={{ color: 'var(--fg)' }}>{p.name}</h2>
                    {p.type === 'custom' && (
                      <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-bold" style={{ color: '#38bdf8', backgroundColor: 'rgba(56,189,248,0.1)', border: '1px solid rgba(56,189,248,0.25)' }}>
                        🔧 Lệnh tùy chỉnh
                      </span>
                    )}
                    {!!p.port && (
                      <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-mono font-bold bg-slate-800/80 text-emerald-400 border border-slate-700">
                        :{p.port}
                      </span>
                    )}
                    <span className={`status-badge ${p.running ? 'status-badge-running animate-badge-pop' : 'status-badge-stopped'}`}>
                      <span className={`status-dot ${p.running ? 'status-dot-running' : 'status-dot-stopped'}`} />
                      {p.running ? 'ĐANG CHẠY' : 'ĐÃ DỪNG'}
                    </span>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    {/* Nút (i) xem thông tin máy chủ — Yêu cầu 1: Đặt popover hiển thị sát nút (i) */}
                    <div className="relative">
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          setActiveInfoTooltip(prev => prev === `${p.name}-server` ? null : `${p.name}-server`)
                        }}
                        className={`p-1.5 rounded-lg transition-all border-0 cursor-pointer flex items-center justify-center ${
                          activeInfoTooltip === `${p.name}-server`
                            ? 'bg-sky-500/25 text-sky-400 ring-1 ring-sky-500/50 scale-105'
                            : 'hover:bg-sky-500/10 text-sky-400/80 hover:text-sky-400'
                        }`}
                        title="Nhấn để xem thông tin máy chủ"
                      >
                        <svg className="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor">
                          <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clipRule="evenodd" />
                        </svg>
                      </button>

                      {/* Popover thông tin máy chủ hiển thị sát nút (i) */}
                      {activeInfoTooltip === `${p.name}-server` && (
                        <div ref={infoTooltipRef} className="server-info-popover right-0 top-full mt-1.5 font-normal">
                          <div className="flex items-center justify-between border-b pb-2 mb-2" style={{ borderColor: 'var(--border)' }}>
                            <div className="flex items-center gap-1.5 font-bold text-sky-400">
                              <svg className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor">
                                <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clipRule="evenodd" />
                              </svg>
                              <span>Thông tin máy chủ {p.name}</span>
                            </div>
                            <button onClick={() => setActiveInfoTooltip(null)} className="text-slate-400 hover:text-white border-0 bg-transparent cursor-pointer p-0.5">✕</button>
                          </div>
                          <div className="space-y-1.5 text-xs">
                            <div className="flex items-start justify-between gap-2">
                              <span style={{ color: 'var(--fg-dim)' }}>📁 Đường dẫn:</span>
                              <span className="font-mono text-[10px] text-slate-300 break-all text-right select-all">{p.path}</span>
                            </div>
                            <div className="flex items-center justify-between">
                              <span style={{ color: 'var(--fg-dim)' }}>🔌 Cổng (Port):</span>
                              <span className="font-mono font-bold text-emerald-400">{p.port}</span>
                            </div>
                            <div className="flex items-center justify-between">
                              <span style={{ color: 'var(--fg-dim)' }}>⚡ Lệnh chạy:</span>
                              <span className="font-mono text-[10px] text-amber-400">{p.command || 'npm run dev'}</span>
                            </div>
                            <div className="flex items-center justify-between">
                              <span style={{ color: 'var(--fg-dim)' }}>🟢 Trạng thái:</span>
                              <span className={`font-semibold ${p.running ? 'text-emerald-400' : 'text-slate-400'}`}>
                                {p.running ? 'Đang hoạt động' : 'Đã dừng'}
                              </span>
                            </div>
                            <div className="flex items-center justify-between">
                              <span style={{ color: 'var(--fg-dim)' }}>💾 Bộ nhớ (RAM):</span>
                              <span className="font-mono">{diagnostics[p.name]?.memory ? `${(diagnostics[p.name].memory / 1024 / 1024).toFixed(1)} MB` : p.running ? '...' : 'N/A'}</span>
                            </div>
                            <div className="flex items-center justify-between">
                              <span style={{ color: 'var(--fg-dim)' }}>💻 CPU Usage:</span>
                              <span className="font-mono">{diagnostics[p.name]?.cpu !== undefined ? `${diagnostics[p.name].cpu}%` : p.running ? '...' : '-'}</span>
                            </div>
                            <div className="flex items-center justify-between">
                              <span style={{ color: 'var(--fg-dim)' }}>⏱️ Thời gian chạy:</span>
                              <span className="font-mono text-emerald-400">{diagnostics[p.name]?.uptime || (p.running ? '...' : '-')}</span>
                            </div>
                            {p.type !== 'custom' && (
                              <div className="flex items-center justify-between">
                                <span style={{ color: 'var(--fg-dim)' }}>🟢 Node & npm:</span>
                                <span className="font-mono text-[11px] text-slate-300">{diagnostics[p.name]?.env?.node || '...'} {diagnostics[p.name]?.env?.npm ? `(npm ${diagnostics[p.name].env.npm})` : ''}</span>
                              </div>
                            )}
                            {p.type !== 'custom' && diagnostics[p.name]?.git && (
                              <div className="flex items-center justify-between border-t pt-1.5 mt-1.5" style={{ borderColor: 'var(--border)' }}>
                                <span style={{ color: 'var(--fg-dim)' }}>🌿 Git Branch:</span>
                                <span className="font-mono text-emerald-400 text-[11px]">
                                  {diagnostics[p.name].git.branch} ({diagnostics[p.name].git.is_dirty ? `${diagnostics[p.name].git.dirty_count} đã sửa` : 'sạch'})
                                </span>
                              </div>
                            )}
                          </div>
                        </div>
                      )}
                    </div>

                    {/* Quick Browser Open */}
                    {p.running && !!p.port && (
                      <button onClick={() => openBrowser(`http://localhost:${p.port}`)}
                        className="p-1 rounded-lg hover:bg-blue-500/15 text-blue-400 transition-colors border-0 cursor-pointer"
                        title="Mở trình duyệt">
                        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                        </svg>
                      </button>
                    )}

                    {/* Quick Explorer Open */}
                    <button onClick={async () => {
                      try {
                        await fetchWithRetry(`${API}/api/system/open-explorer`, {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ path: p.path })
                        })
                        setStatusText(`Opened ${p.path}`)
                      } catch {
                        try {
                          const { open } = await import('@tauri-apps/plugin-shell')
                          await open(p.path)
                        } catch { setStatusText('Failed to open explorer') }
                      }
                    }}
                      className="p-1 rounded-lg hover:bg-black/10 dark:hover:bg-white/10 text-slate-400 hover:text-slate-200 transition-colors border-0 cursor-pointer"
                      title="Mở trong File Explorer">
                      📁
                    </button>

                    {/* Quick npm Scripts — chỉ cho project Node.js */}
                    {p.type !== 'custom' && projectScripts[p.name] && projectScripts[p.name].length > 0 && (
                      <select id={`script-select-${p.name}`} name="runScript" onChange={async e => {
                        const script = e.target.value
                        if (!script) return
                        try {
                          await fetchWithRetry(`${API}/api/projects/${encodeURIComponent(p.name)}/run-script`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ script })
                          })
                          setStatusText(`Running ${script} for ${p.name}`)
                          setActiveTab(p.name)
                          await fetchProjects()
                        } catch { setStatusText('Failed to run script') }
                        e.target.value = ''
                      }}
                        className="px-1 py-0.5 text-[9px] rounded border cursor-pointer bg-slate-800 text-slate-300 border-slate-700">
                        <option value="">⚡ Script</option>
                        {projectScripts[p.name].filter(s => ['build','lint','test','typecheck','format','preview'].includes(s)).map(s => (
                          <option key={s} value={s}>{s}</option>
                        ))}
                      </select>
                    )}

                    {/* Nút Chevron thu gọn / mở rộng */}
                    <button onClick={() => setExpandedProjects(prev => prev.includes(p.name) ? prev.filter(n => n !== p.name) : [...prev, p.name])}
                      className="p-1 rounded-lg hover:bg-black/10 dark:hover:bg-white/10 transition-colors shrink-0 border-0 group/chevron cursor-pointer"
                      style={{ color: 'var(--fg-muted)' }} title="Mở rộng chi tiết">
                      <svg className={`w-3.5 h-3.5 chevron-icon ${expandedProjects.includes(p.name) ? 'rotated' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
                      </svg>
                    </button>
                  </div>
                </div>

                {/* Sub-header: Path info */}
                <p className="text-[10.5px] mt-1 truncate font-mono text-slate-400/90">{p.path}</p>

                {/* Expand Section */}
                <div className={`expand-section ${expandedProjects.includes(p.name) ? 'expand-open' : ''}`}>
                  <div className="expand-inner">
                    <div className="mt-2.5 pt-2.5 border-t border-dashed" style={{ borderColor: 'var(--border)' }}>
                      <div className="diag-grid">
                        <div className="diag-item expand-stagger-item"><span className="diag-label">Bộ nhớ:</span> <span className="diag-value">{diagnostics[p.name]?.memory ? `${(diagnostics[p.name].memory / 1024 / 1024).toFixed(1)} MB` : p.running ? '...' : 'Không hoạt động'}</span></div>
                        <div className="diag-item expand-stagger-item"><span className="diag-label">CPU:</span> <span className="diag-value">{diagnostics[p.name]?.cpu !== undefined ? `${diagnostics[p.name].cpu}%` : p.running ? '...' : '-'}</span></div>
                        <div className="diag-item expand-stagger-item"><span className="diag-label">Uptime:</span> <span className="diag-value" style={{ color: diagnostics[p.name]?.uptime_seconds > 3600 ? '#22c55e' : undefined }}>{diagnostics[p.name]?.uptime || (p.running ? '...' : '-')}</span></div>
                        {p.type !== 'custom' && (
                          <div className="diag-item expand-stagger-item"><span className="diag-label">Node:</span> <span className="diag-value">{diagnostics[p.name]?.env?.node || '...'} {diagnostics[p.name]?.env?.npm ? `(npm ${diagnostics[p.name].env.npm})` : ''}</span></div>
                        )}
                      </div>
                    {p.type !== 'custom' && diagnostics[p.name]?.git && (
                      <div className="flex items-center gap-2 flex-wrap mt-2">
                        <span style={{ color: 'var(--fg-muted)' }}>Git:</span>
                        <span className="font-mono text-emerald-500 text-xs">{diagnostics[p.name].git.branch}</span>
                        <span className={`px-1.5 py-0.5 rounded text-[10px] font-mono ${diagnostics[p.name].git.is_dirty ? 'bg-amber-500/10 text-amber-500 border border-amber-500/15' : 'bg-emerald-500/10 text-emerald-500 border border-emerald-500/15'}`}>
                          {diagnostics[p.name].git.is_dirty ? `${diagnostics[p.name].git.dirty_count} đã sửa` : 'sạch'}
                        </span>
                      </div>
                    )}
                    {/* Quick Actions Row — chỉ cho project Node.js */}
                    {p.type !== 'custom' && (
                      <div className="flex items-center gap-1.5 pt-1 flex-wrap">
                      <button onClick={() => openEnvEditor(p.name)} className="px-2 py-1 text-[10px] font-semibold rounded border transition-colors active:scale-95 cursor-pointer"
                        style={{ backgroundColor: 'var(--input-bg)', borderColor: 'var(--border)', color: 'var(--fg-secondary)' }}>📝 Sửa .env</button>
                      {/* Quick SSL */}
                      <button onClick={async () => {
                        try {
                          const res = await fetchWithRetry(`${API}/api/projects/${encodeURIComponent(p.name)}/ssl`, { method: 'POST' })
                          const data = await res.json()
                          if (res.ok) setStatusText(`✅ SSL cert created: ${data.cert}`)
                          else if (data.instructions) setStatusText(`❌ ${data.error}. ${data.instructions}`)
                          else setStatusText(`❌ ${data.error}`)
                        } catch { setStatusText('Lỗi tạo chứng chỉ SSL') }
                      }}
                        className="px-2 py-1 text-[10px] font-semibold rounded border transition-colors active:scale-95 cursor-pointer"
                        style={{ backgroundColor: 'var(--input-bg)', borderColor: 'var(--border)', color: 'var(--fg-secondary)' }}>🔒 SSL</button>
                      </div>
                    )}
                    {/* Cloudflare Tunnel — chỉ cho project Node.js */}
                    {p.type !== 'custom' && (
                    <div className="pt-2 border-t border-dashed" style={{ borderColor: 'var(--border)' }}>
                      <div className="flex items-center gap-1.5 mb-1.5 relative">
                        <span className="text-xs font-semibold" style={{ color: 'var(--fg-muted)' }}>🌐 Cloudflare Tunnel</span>
                        {/* Icon (i) nhấn để hiện tooltip thay vì hover — hiển thị sát icon */}
                        <div className="relative">
                          <button
                            onClick={(e) => {
                              e.stopPropagation()
                              setActiveInfoTooltip(prev => prev === `${p.name}-tunnel` ? null : `${p.name}-tunnel`)
                            }}
                            className="p-0.5 rounded hover:bg-white/10 transition-colors border-0 cursor-pointer inline-flex items-center justify-center text-slate-400 hover:text-sky-400"
                          >
                            <svg className="w-3 h-3" viewBox="0 0 16 16" fill="currentColor">
                              <path d="M8 1a7 7 0 110 14A7 7 0 018 1zm0 1.5a5.5 5.5 0 100 11 5.5 5.5 0 000-11zM8.75 11v-4.5h-1.5V11h1.5zM8 5.25a.75.75 0 100-1.5.75.75 0 000 1.5z"/>
                            </svg>
                          </button>

                          {activeInfoTooltip === `${p.name}-tunnel` && (
                            <div ref={infoTooltipRef} className="server-info-popover left-0 top-full mt-1.5 w-64">
                              <div className="flex items-center justify-between font-bold text-sky-400 mb-1 border-b pb-1">
                                <span>🌐 Cloudflare Tunnel</span>
                                <button onClick={() => setActiveInfoTooltip(null)} className="text-slate-400 hover:text-white border-0 bg-transparent cursor-pointer p-0.5">✕</button>
                              </div>
                              <p className="text-[10px] text-slate-300 leading-relaxed font-normal">
                                Cloudflare Tunnel tạo đường hầm an toàn từ localhost ra internet qua Cloudflare, cho phép chia sẻ server đang chạy với bên ngoài mà không cần mở port trên firewall.
                              </p>
                            </div>
                          )}
                        </div>

                        {tunnelStates[p.name]?.status === 'active' && (
                          <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 flex items-center gap-1">
                            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" /> ĐANG HOẠT ĐỘNG
                          </span>
                        )}
                        {tunnelStates[p.name]?.status === 'connecting' && (
                          <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-amber-500/10 text-amber-400 border border-amber-500/20 flex items-center gap-1">
                            <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" /> ĐANG KẾT NỐI
                          </span>
                        )}
                        {tunnelStates[p.name]?.status === 'error' && (
                          <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-red-500/15 text-red-400 border border-red-500/30 flex items-center gap-1">
                            <span className="w-1.5 h-1.5 rounded-full bg-red-400" /> LỖI
                          </span>
                        )}
                      </div>
                      {(() => {
                        const ts = tunnelStates[p.name]
                        if (ts?.status === 'active' && ts?.url) {
                          return (
                            <div className="flex items-center gap-1.5 flex-wrap">
                              <a href={ts.url} target="_blank" rel="noopener noreferrer" className="tunnel-url-link truncate max-w-[180px]">
                                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse shrink-0" />
                                {ts.url.replace('https://', '')}
                              </a>
                              <button onClick={() => {
                                navigator.clipboard.writeText(ts.url!)
                                setStatusText('📋 Đã copy URL')
                              }}
                                className="tunnel-pill tunnel-pill-active">
                                📋 Copy
                              </button>
                              <button onClick={() => openBrowser(ts.url!)}
                                className="tunnel-pill" style={{ background: 'var(--button-tunnel-bg)', color: 'var(--button-tunnel-text)', border: '1px solid var(--button-tunnel-border)' }}>
                                🔗 Mở
                              </button>
                              <button onClick={() => stopTunnel(p.name)} disabled={tunnelLoading[p.name]}
                                className="tunnel-pill" style={{ color: '#ef4444', border: '1px solid rgba(239,68,68,0.3)' }}>
                                {tunnelLoading[p.name] ? '⏳' : '⏹ Dừng'}
                              </button>
                            </div>
                          )
                        }
                        return null
                      })()}
                      {!tunnelStates[p.name]?.url && (
                        <div className="flex items-center gap-1.5 flex-wrap">
                          {tunnelStates[p.name]?.cloudflared_installed === false ? (
                            <button onClick={() => installAndStartTunnel(p.name)}
                              disabled={!p.running || tunnelLoading[p.name] || installingCloudflared}
                              className="px-2 py-1 text-[10px] font-semibold rounded border transition-all active:scale-95 cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed flex items-center gap-1"
                              style={{
                                backgroundColor: p.running ? 'rgba(16,185,129,0.15)' : 'var(--input-bg)',
                                borderColor: p.running ? 'rgba(16,185,129,0.3)' : 'var(--border)',
                                color: p.running ? '#34d399' : 'var(--fg-dim)'
                              }}>
                              {installingCloudflared || tunnelLoading[p.name] ? (
                                <><div className="animate-spin rounded-full h-2 w-2 border-b border-current" /> Đang tải & kết nối...</>
                              ) : (
                                <><svg className="w-2.5 h-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                  <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                                </svg>
                                📥 Cài & Mở tunnel</>
                              )}
                            </button>
                          ) : tunnelStates[p.name]?.status === 'connecting' ? (
                            <div className="flex items-center gap-1.5">
                              <div className="animate-spin rounded-full h-2.5 w-2.5 border-b border-amber-400" />
                              <span className="text-[10px]" style={{ color: 'var(--fg-dim)' }}>Đang kết nối Cloudflare...</span>
                            </div>
                          ) : tunnelStates[p.name]?.status === 'error' ? (
                            <div className="flex items-center gap-1.5 flex-wrap">
                              <span className="text-[10px]" style={{ color: '#ef4444' }}>{tunnelStates[p.name]?.error || 'Lỗi không xác định'}</span>
                              <button onClick={() => startTunnel(p.name)} disabled={tunnelLoading[p.name]}
                                className="px-1.5 py-0.5 text-[10px] font-semibold rounded border transition-colors active:scale-95 cursor-pointer disabled:opacity-30"
                                style={{ backgroundColor: 'var(--input-bg)', borderColor: 'var(--border)', color: 'var(--fg-secondary)' }}>
                                {tunnelLoading[p.name] ? '...' : '🔄 Thử lại'}
                              </button>
                            </div>
                          ) : (
                            <button onClick={() => startTunnel(p.name)}
                              disabled={!p.running || tunnelLoading[p.name]}
                              className="px-2 py-1 text-[10px] font-semibold rounded border transition-colors active:scale-95 cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed flex items-center gap-1"
                              style={{
                                backgroundColor: p.running ? 'rgba(59,130,246,0.1)' : 'var(--input-bg)',
                                borderColor: p.running ? 'rgba(59,130,246,0.25)' : 'var(--border)',
                                color: p.running ? '#60a5fa' : 'var(--fg-dim)'
                              }}>
                              {tunnelLoading[p.name] ? (
                                <><div className="animate-spin rounded-full h-2 w-2 border-b border-current" /> Đang kết nối...</>
                              ) : (
                                <><svg className="w-2.5 h-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                  <path strokeLinecap="round" strokeLinejoin="round" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
                                </svg>
                                Tunnel công khai</>
                              )}
                            </button>
                          )}
                        </div>
                      )}
                      {/* Watchdog Toggle */}
                      {(tunnelStates[p.name]?.url || tunnelStates[p.name]?.cloudflared_installed) && (
                        <div className="flex items-center gap-2 pt-1.5 border-t border-dashed mt-1.5 relative" style={{ borderColor: 'var(--border)' }}>
                          {/* Icon (i) nhấn để hiện tooltip thay vì hover — hiển thị sát icon */}
                          <div className="relative">
                            <button
                              onClick={(e) => {
                                e.stopPropagation()
                                setActiveInfoTooltip(prev => prev === `${p.name}-watchdog` ? null : `${p.name}-watchdog`)
                              }}
                              className="p-0.5 rounded hover:bg-white/10 transition-colors border-0 cursor-pointer inline-flex items-center justify-center text-slate-400 hover:text-sky-400"
                            >
                              <svg className="w-3 h-3" viewBox="0 0 16 16" fill="currentColor">
                                <path d="M8 1a7 7 0 110 14A7 7 0 018 1zm0 1.5a5.5 5.5 0 100 11 5.5 5.5 0 000-11zM8.75 11v-4.5h-1.5V11h1.5zM8 5.25a.75.75 0 100-1.5.75.75 0 000 1.5z"/>
                              </svg>
                            </button>

                            {activeInfoTooltip === `${p.name}-watchdog` && (
                              <div ref={infoTooltipRef} className="server-info-popover left-0 top-full mt-1.5 w-64">
                                <div className="flex items-center justify-between font-bold text-sky-400 mb-1 border-b pb-1">
                                  <span>🛡️ Watchdog Autorestart</span>
                                  <button onClick={() => setActiveInfoTooltip(null)} className="text-slate-400 hover:text-white border-0 bg-transparent cursor-pointer p-0.5">✕</button>
                                </div>
                                <p className="text-[10px] text-slate-300 leading-relaxed font-normal">
                                  Watchdog tự động giám sát tunnel và khởi động lại nếu tunnel bị ngắt kết nối (do mất mạng, sleep, reboot, hoặc lỗi Cloudflare).
                                </p>
                              </div>
                            )}
                          </div>

                          <label className="relative inline-flex items-center cursor-pointer">
                            <input id={`watchdog-${p.name}`} name="watchdog" type="checkbox"
                              checked={tunnelStates[p.name]?.watchdog_enabled || false}
                              onChange={e => toggleWatchdog(p.name, e.target.checked)}
                              disabled={watchdogToggling[p.name]}
                              className="sr-only peer" />
                            <div className="w-7 h-3.5 rounded-full peer peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-2.5 after:w-2.5 after:transition-all peer-checked:bg-emerald-500/60 bg-gray-600/40" />
                          </label>
                          <span className="text-[8px]" style={{ color: tunnelStates[p.name]?.watchdog_enabled ? '#34d399' : 'var(--fg-dim)' }}>
                            {tunnelStates[p.name]?.watchdog_enabled ? '🛡️ Watchdog: BẬT' : 'Watchdog: TẮT'}
                          </span>
                          {tunnelStates[p.name]?.watchdog_enabled && (
                            <span className="text-[7px]" style={{ color: 'var(--fg-muted)' }}>
                              (tự động phục hồi sau sleep/reboot/lỗi)
                            </span>
                          )}
                          {(() => {
                            const rc = tunnelStates[p.name]?.watchdog_restart_count
                            if (rc !== undefined && rc > 0) {
                              return (
                                <span className="flex items-center gap-0.5 text-[8px] font-mono px-1.5 py-0.5 rounded" style={{ backgroundColor: 'rgba(251,191,36,0.1)', color: '#fbbf24' }}>
                                  <svg className="w-2 h-2" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                    <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                                  </svg>
                                  Đã phục hồi {rc} lần
                                </span>
                              )
                            }
                            return null
                          })()}
                          {watchdogToggling[p.name] && (
                            <div className="animate-spin rounded-full h-2 w-2 border-b border-emerald-400" />
                          )}
                        </div>
                      )}
                    </div>
                    )}
                  </div>
                  </div>
                </div>
              </div>

              {/* Bottom Toolbar & Action buttons — Yêu cầu 2: rounded-b-2xl để bo tròn 2 góc dưới sạch sẽ */}
              <div className="flex items-center justify-between gap-2 px-3.5 py-2 border-t rounded-b-2xl" style={{ borderColor: 'var(--border)', backgroundColor: 'rgba(0,0,0,0.08)' }}>
                <div className="flex items-center gap-1.5 flex-wrap min-w-0">
                  {/* Port Conflict Badge */}
                  {portConflicts[p.port] && portConflicts[p.port].length > 0 && (
                    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[8px] font-semibold bg-red-500/15 text-red-400 ring-1 ring-red-500/20">
                      ⚔️ Conflict
                    </span>
                  )}
                  {/* Disk Usage Badge */}
                  {p.type !== 'custom' && diskSizes[p.name]?.node_modules && (
                    <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[8px] font-mono ${
                      diskSizes[p.name].node_modules > 500
                        ? 'bg-amber-500/15 text-amber-400 ring-1 ring-amber-500/20'
                        : 'bg-emerald-500/10 text-emerald-500 ring-1 ring-emerald-500/15'
                    }`}>
                      📦 {diskSizes[p.name].node_modules}MB
                    </span>
                  )}
                  {/* Compact Tunnel URL Badge */}
                  {(() => {
                    const ts = tunnelStates[p.name]
                    if (!ts) return null
                    if (ts.status === 'active' && ts.url) {
                      return (
                        <span className="tunnel-url-link inline-flex items-center gap-1 px-1.5 py-0.5 text-[9px] max-w-[180px]">
                          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse shrink-0" />
                          {ts.url.replace('https://', '').replace('/','')}
                        </span>
                      )
                    }
                    if (ts.status === 'connecting') {
                      return (
                        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-medium" style={{ color: '#fbbf24', background: 'rgba(251,191,36,0.08)', border: '1px solid rgba(251,191,36,0.2)' }}>
                          <div className="animate-spin rounded-full h-2 w-2 border-b border-amber-400" />
                          Đang kết nối
                        </span>
                      )
                    }
                    if (ts.status === 'error') {
                      return (
                        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-medium" style={{ color: '#ef4444', background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)' }}>
                          <span className="w-1.5 h-1.5 rounded-full bg-red-400" />
                          Lỗi tunnel
                        </span>
                      )
                    }
                    return null
                  })()}
                </div>

                {/* Start / Stop / Clean Action Controls */}
                <div className="flex gap-1.5 items-center shrink-0">
                  <button onClick={() => act(p.name, 'start')} disabled={p.running || loading[p.name]}
                    className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-semibold transition-all disabled:opacity-20 disabled:cursor-not-allowed active:scale-95 cursor-pointer border-0 shadow-sm"
                    style={{ backgroundColor: 'var(--button-start-bg)', color: 'var(--button-start-text)', border: '1px solid var(--button-start-border)' }}>
                    {loading[p.name] ? (
                      <div className="animate-spin rounded-full h-3 w-3 border-b border-current" />
                    ) : (
                      <>
                        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M5.25 5.653c0-.856.917-1.398 1.667-.986l11.54 6.347a1.125 1.125 0 010 1.972l-11.54 6.347a1.125 1.125 0 01-1.667-.986V5.653z" />
                        </svg>
                        <span>Bắt đầu</span>
                      </>
                    )}
                  </button>
                  <button onClick={() => act(p.name, 'stop')} disabled={!p.running || loading[p.name]}
                    className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-semibold transition-all disabled:opacity-20 disabled:cursor-not-allowed active:scale-95 cursor-pointer border-0 shadow-sm"
                    style={{ backgroundColor: 'var(--button-stop-bg)', color: 'var(--button-stop-text)', border: '1px solid var(--button-stop-border)' }}>
                    {loading[p.name] ? (
                      <div className="animate-spin rounded-full h-3 w-3 border-b border-current" />
                    ) : (
                      <>
                        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                        </svg>
                        <span>Dừng</span>
                      </>
                    )}
                  </button>
                  {p.type !== 'custom' && (
                    <div className="relative">
                      <select id={`clean-select-${p.name}`} name="cleanType" onChange={e => { const v = e.target.value as 'basic' | 'deep' | 'nuke'; if (v) { cleanProject(p.name, v); e.target.value = '' } }}
                        disabled={clearing[p.name]}
                        className="px-2 py-1 rounded-lg cursor-pointer border transition-all disabled:opacity-30 text-[11px] appearance-none"
                        style={{ backgroundColor: 'var(--input-bg)', borderColor: 'var(--border)', color: 'var(--fg-secondary)' }}>
                        <option value="">🧹 Dọn dẹp</option>
                        <option value="basic">Cache</option>
                        <option value="deep">Build sâu</option>
                        <option value="nuke">Xóa sạch</option>
                      </select>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )
        })}
      </div>

      {/* ─── Log Viewer — Terminal Style ─── */}
      <div className="flex-1 min-h-0 px-4 pb-4">
        <div className={`h-full rounded-xl border flex flex-col overflow-hidden ${logTheme === 'dark' ? 'terminal-dark' : ''}`} style={{ borderColor: 'var(--terminal-border)' }}>
          {/* Terminal Title Bar with Server Tabs (Vấn đề 2) */}
          <div className="terminal-header shrink-0 py-1 px-3 flex items-center justify-between min-h-[34px] border-b" style={{ height: '34px', borderColor: 'var(--terminal-border)' }}>
            <div className="flex items-center gap-2 max-w-[65%] min-w-0">
              <span className="text-[11px] font-bold tracking-wide flex items-center gap-1.5 shrink-0" style={{ color: '#34d399' }}>
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                </svg>
                <span>Logs:</span>
              </span>

              {/* Log Tabs chia theo Server (Vấn đề 2) */}
              <div className="flex items-center gap-1 overflow-x-auto no-scrollbar py-0.5">
                <button
                  type="button"
                  onClick={() => setActiveTab('All')}
                  className={`px-2 py-0.5 text-[10px] font-semibold rounded transition-all cursor-pointer shrink-0 border-0 ${
                    activeTab === 'All'
                      ? 'bg-emerald-500/25 text-emerald-400 font-bold shadow-sm'
                      : 'text-slate-400 hover:text-slate-200 hover:bg-white/5'
                  }`}
                  title="Xem log tổng hợp của tất cả máy chủ"
                >
                  🌐 Tất cả ({logs['All']?.length || 0})
                </button>
                {projects.map(p => {
                  const isAct = activeTab === p.name
                  const count = logs[p.name]?.length || 0
                  return (
                    <button
                      key={p.name}
                      type="button"
                      onClick={() => setActiveTab(p.name)}
                      className={`px-2 py-0.5 text-[10px] font-semibold rounded transition-all cursor-pointer flex items-center gap-1 shrink-0 border-0 ${
                        isAct
                          ? 'bg-emerald-500/25 text-emerald-400 font-bold shadow-sm'
                          : 'text-slate-400 hover:text-slate-200 hover:bg-white/5'
                      }`}
                      title={`Xem log riêng của ${p.name}`}
                    >
                      <span className={`w-1.5 h-1.5 rounded-full ${p.running ? 'bg-emerald-400 animate-pulse' : 'bg-slate-500'}`} />
                      <span>{p.name}</span>
                      <span className="text-[9px] opacity-60 font-mono">({count})</span>
                    </button>
                  )
                })}
              </div>
            </div>

            <div className="flex items-center gap-1.5 shrink-0">
              {/* Dropdown chọn mẫu màu sọc dòng log */}
              <select
                id="log-zebra-select"
                name="logZebraTemplate"
                value={logZebraTemplate}
                onChange={e => handleZebraChange(e.target.value)}
                className="px-2 py-0.5 text-[9px] font-semibold rounded cursor-pointer border-0 transition-all"
                style={{ backgroundColor: 'var(--terminal-border)', color: 'var(--terminal-text-muted)' }}
                title="Mẫu màu sọc xen kẽ giữa các dòng log"
              >
                <option value="blue-white">🎨 Sọc Xanh Dương & Trắng</option>
                <option value="emerald-dark">🎨 Sọc Xanh Lá Cyber</option>
                <option value="purple-neon">🎨 Sọc Tím Neon</option>
                <option value="amber-warm">🎨 Sọc Hổ Phách Warm</option>
                <option value="contrast-mono">🎨 Sọc Monochrome</option>
                <option value="none">🎨 Mặc định (Không sọc)</option>
              </select>

              {/* Log theme toggle — sun/moon icon */}
              <button onClick={() => setLogTheme(prev => prev === 'light' ? 'dark' : 'light')}
                className="px-1.5 py-0.5 text-[8px] font-medium rounded transition-all cursor-pointer hover:scale-110 active:scale-95"
                style={{ color: 'var(--terminal-text-muted)', background: 'var(--terminal-border)' }}
                title={logTheme === 'light' ? 'Chuyển sang nền tối' : 'Chuyển sang nền sáng'}>
                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  {logTheme === 'light' ? (
                    <path strokeLinecap="round" strokeLinejoin="round" d="M21.752 15.002A9.718 9.718 0 0118 15.75c-5.385 0-9.75-4.365-9.75-9.75 0-1.33.266-2.597.748-3.752A9.753 9.753 0 003 11.25C3 16.635 7.365 21 12.75 21a9.753 9.753 0 009.002-5.998z" />
                  ) : (
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v2.25m6.364.386l-1.591 1.591M21 12h-2.25m-.386 6.364l-1.591-1.591M12 18.75V21m-4.773-4.227l-1.591 1.591M5.25 12H3m4.227-4.773L5.636 5.636M15.75 12a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0z" />
                  )}
                </svg>
              </button>
            </div>
          </div>

          {/* Terminal Body với drag selection & right-click context menu (Vấn đề 1 & 2) */}
          <div
            onContextMenu={e => {
              e.preventDefault()
              setLogContextMenu({ x: e.clientX, y: e.clientY })
            }}
            className="flex-1 overflow-y-auto terminal-body p-1 select-text font-terminal"
            style={{ fontSize: '10.5px', lineHeight: '1.3' }}
            ref={logScrollRef}
          >
            {displayLines.length === 0 ? (
              <div className="flex items-center justify-center h-full select-none">
                <div className="text-center">
                  <div className="text-lg" style={{ color: 'var(--terminal-text-dim)' }}>
                    <svg className="w-8 h-8 mx-auto" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M14.25 9.75L16.5 12l-2.25 2.25m-4.5 0L7.5 12l2.25-2.25M6 20.25h12A2.25 2.25 0 0020.25 18V6A2.25 2.25 0 0018 3.75H6A2.25 2.25 0 003.75 6v12A2.25 2.25 0 006 20.25z" />
                    </svg>
                  </div>
                  <p className="mt-2 text-xs" style={{ color: 'var(--terminal-text-muted)' }}>
                    <span className="animate-terminal-blink">_</span> Chưa có log cho {activeTab}. Hãy khởi động máy chủ.
                  </p>
                </div>
              </div>
            ) : (
              <>
                {levelFilteredLines.length === 0 ? (
                  <div className="flex items-center justify-center h-full select-none">
                    <p className="text-xs italic" style={{ color: 'var(--fg-dim)' }}>Không có log phù hợp với bộ lọc</p>
                  </div>
                ) : (
                  <>
                    <div className="sticky top-0 z-10 flex items-center gap-2 px-1.5 py-0.5 text-[8px] font-medium border-b select-none font-terminal"
                      style={{ backgroundColor: 'var(--terminal-bg-body)', borderColor: 'var(--terminal-border)', color: 'var(--terminal-text-dim)' }}>
                      <span className="w-6 text-right shrink-0">#</span>
                      <span className="w-10 shrink-0">Thời gian</span>
                      <span className="w-12 shrink-0">Cấp độ</span>
                      <span className="flex-1">Nội dung</span>
                    </div>
                    <div className="relative w-full" style={{ height: terminalVirtual.getTotalSize() }}>
                      {terminalVirtual.getVirtualItems().map(vi => {
                        const i = vi.index
                        const line = levelFilteredLines[i]
                        const tsMatch = line.match(/^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\]\s*/)
                        const timestamp = tsMatch ? tsMatch[1] : ''
                        const contentLine = tsMatch ? line.slice(tsMatch[0].length) : line
                        let html = ansiConverter.toHtml(contentLine)
                        if (logSearch) {
                          const escapedSearch = logSearch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
                          try {
                            html = html.replace(
                              new RegExp(`(${escapedSearch})`, 'gi'),
                              '<mark style="background-color:rgba(251,191,36,0.3);color:#fbbf24;border-radius:2px">$1</mark>'
                            )
                          } catch {}
                        }
                        const style = getLineStyle(line, i, logColors, logTheme)
                        const mergedColors = { ...DEFAULT_LOG_COLORS, ...logColors }
                        const level = detectLevel(line)
                        const levelLabel = level && level !== 'defaultText' ? (() => {
                          const labels: Record<string, string> = { error: '❌ LỖI', warn: '⚠️ CẢNH BÁO', success: '✅ OK', build: '🔧 BUILD', tunnel: '🌐 TUNNEL', metrics: '📊 SỐ LIỆU', cleanup: '🧹 DỌN', debug: '🔍 DEBUG' }
                          return { text: labels[level] || level.toUpperCase(), color: mergedColors[level] || '#94a3b8' }
                        })() : null

                        const zebraBg = getZebraBackground(i, logZebraTemplate, logTheme, style.backgroundColor)

                        return (
                          <div key={vi.key}
                            ref={terminalVirtual.measureElement}
                            data-index={i}
                            className="absolute top-0 left-0 w-full flex items-center gap-1.5 px-1.5 py-[0.5px] hover:bg-white/[0.06] transition-colors group font-terminal"
                            style={{ backgroundColor: zebraBg, transform: `translateY(${vi.start}px)` }}>
                            <span className="select-none shrink-0 text-right font-terminal"
                              style={{ color: 'var(--terminal-text-dim)', width: '1.5rem', fontSize: '9px', lineHeight: '1.3' }}>
                              {i + 1}
                            </span>
                            {timestamp && (
                              <span className="select-none shrink-0 font-terminal text-[9px]"
                                style={{ color: 'var(--terminal-text-dim)', lineHeight: '1.3' }}>
                                {timestamp.slice(11)}
                              </span>
                            )}
                            {levelLabel && (
                              <span
                                onClick={() => setLogFilter(prev => {
                                  const levelKey = level || 'info'
                                  return prev.includes(levelKey) ? prev.filter(v => v !== levelKey) : [...prev, levelKey]
                                })}
                                className="shrink-0 text-[7.5px] font-bold px-1 py-[0px] my-0 rounded cursor-pointer transition-all duration-150 hover:scale-105 active:scale-95 leading-none select-none font-terminal"
                                style={{
                                  color: levelLabel.color,
                                  backgroundColor: logFilter.includes(level || 'info') ? hexToRgba(levelLabel.color, 0.25) : hexToRgba(levelLabel.color, 0.1),
                                  outline: logFilter.includes(level || 'info') ? `1px solid ${hexToRgba(levelLabel.color, 0.3)}` : 'none',
                                }}
                                title={`Lọc: ${levelLabel.text}`}>
                                {levelLabel.text}
                              </span>
                            )}
                            <span className="whitespace-pre-wrap break-all flex-1 font-terminal text-[10px] select-text"
                              style={{
                                color: style.color || '#e6edf3',
                                borderLeft: style.borderLeft,
                                paddingLeft: style.paddingLeft || '2px',
                                lineHeight: '1.3'
                              }}
                              dangerouslySetInnerHTML={{ __html: html }} />
                          </div>
                        )
                      })}
                    </div>
                  </>
                )}
              </>
            )}
            <div ref={logEndRef} />
          </div>
        </div>
      </div>

      {/* Env Editor Modal — với enter/exit animation giống Settings */}
      {(envEditingProject || envAnimState === 'exit') && (
        <div className={`fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm ${envAnimState === 'enter' ? 'animate-modal-in' : 'animate-modal-out'}`}
          onClick={e => { if (e.target === e.currentTarget) handleCloseEnvEditor() }}>
          <div className={`w-full max-w-lg rounded-2xl border shadow-2xl p-6 flex flex-col ${envAnimState === 'enter' ? 'animate-modal-content-in' : 'animate-modal-content-out'}`}
            style={{ backgroundColor: 'var(--bg)', borderColor: 'var(--border)', color: 'var(--fg)' }}>
            <div className="flex items-center justify-between pb-4 border-b" style={{ borderColor: 'var(--border)' }}>
              <div>
                <label htmlFor="env-editor" className="text-sm font-semibold cursor-pointer">Biến môi trường</label>
                <p className="text-xs font-mono text-gray-500">{envEditingProject} › {envFileName}</p>
              </div>
              <button onClick={handleCloseEnvEditor}
                className="p-1 rounded-lg hover:bg-black/10 dark:hover:bg-white/10 transition-colors cursor-pointer border-0"
                style={{ color: 'var(--fg-muted)' }}>
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <textarea id="env-editor" name="envContent" value={envContent} onChange={e => setEnvContent(e.target.value)} rows={12}
              className="w-full border rounded-lg px-3 py-2 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-emerald-500 mt-4"
              style={{ backgroundColor: 'var(--input-bg)', borderColor: 'var(--input-border)', color: 'var(--fg)' }}
              placeholder="# PORT=4000\n# DATABASE_URL=..." />
            <div className="mt-6 flex justify-end gap-2">
              <button onClick={handleCloseEnvEditor}
                className="px-3 py-1.5 text-xs font-medium border rounded-lg transition-colors active:scale-95 cursor-pointer"
                style={{ backgroundColor: 'var(--input-bg)', borderColor: 'var(--border)', color: 'var(--fg-secondary)' }}>Hủy</button>
              <button onClick={saveEnvFile} disabled={envSaving}
                className="px-4 py-1.5 text-xs font-medium bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg transition-colors active:scale-95 cursor-pointer disabled:opacity-50 border-0">
                {envSaving ? 'Saving...' : 'Lưu tập tin'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Log Right-Click Context Menu (Vấn đề 1) */}
      {logContextMenu && (
        <div
          className="fixed z-50 py-1.5 rounded-xl shadow-2xl border text-xs font-medium backdrop-blur-md transition-all animate-scale-in"
          style={{
            top: logContextMenu.y,
            left: logContextMenu.x,
            backgroundColor: 'var(--bg-card)',
            borderColor: 'var(--border)',
            color: 'var(--fg)',
            minWidth: '200px'
          }}
          onClick={e => e.stopPropagation()}
        >
          <div className="px-3 py-1 text-[10px] font-bold text-slate-400 border-b border-white/10 mb-1 flex items-center justify-between">
            <span>VÙNG LOG ({activeTab})</span>
            <span className="font-mono text-[9px] text-emerald-400">{logs[activeTab]?.length || 0} dòng</span>
          </div>

          <button
            type="button"
            onClick={() => {
              const selectedText = window.getSelection()?.toString()
              if (selectedText && selectedText.trim().length > 0) {
                navigator.clipboard.writeText(selectedText)
                setStatusText('Đã sao chép đoạn log được chọn')
              } else {
                const lines = logs[activeTab] || []
                if (lines.length > 0) {
                  navigator.clipboard.writeText(lines.join('\n'))
                  setStatusText(`Đã sao chép toàn bộ ${lines.length} dòng log (${activeTab})`)
                } else {
                  setStatusText('Không có log để sao chép')
                }
              }
              setLogContextMenu(null)
            }}
            className="w-full px-3 py-1.5 text-left flex items-center gap-2 hover:bg-emerald-500/20 hover:text-emerald-400 transition-colors border-0 cursor-pointer text-xs"
          >
            <svg className="w-4 h-4 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 17.25v3.375c0 .621-.504 1.125-1.125 1.125h-9.75a1.125 1.125 0 01-1.125-1.125V7.875c0-.621.504-1.125 1.125-1.125H6.75a9.06 9.06 0 011.5.124m7.5 10.376h3.375c.621 0 1.125-.504 1.125-1.125V11.25c0-4.46-3.243-8.161-7.5-8.876a9.06 9.06 0 00-1.5-.124H9.375c-.621 0-1.125.504-1.125 1.125v3.5m7.5 10.375H9.375a1.125 1.125 0 01-1.125-1.125v-9.25m12 6.625v-1.875a3.375 3.375 0 00-3.375-3.375h-1.5" />
            </svg>
            <span>📋 Copy đoạn đã bôi đen</span>
          </button>

          <button
            type="button"
            onClick={() => {
              const lines = logs[activeTab] || []
              if (lines.length === 0) {
                setStatusText('Không có log để sao chép')
              } else {
                navigator.clipboard.writeText(lines.join('\n'))
                setStatusText(`Đã sao chép toàn bộ ${lines.length} dòng log (${activeTab})`)
              }
              setLogContextMenu(null)
            }}
            className="w-full px-3 py-1.5 text-left flex items-center gap-2 hover:bg-emerald-500/20 hover:text-emerald-400 transition-colors border-0 cursor-pointer text-xs"
          >
            <svg className="w-4 h-4 text-sky-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 7.5V6.108c0-1.135.845-2.098 1.976-2.192.373-.03.748-.057 1.224-.08M15.75 18H18a2.25 2.25 0 002.25-2.25V6.108c0-1.135-.845-2.098-1.976-2.192a48.424 48.424 0 00-1.224-.08M15.75 18.75v-1.875a3.375 3.375 0 00-3.375-3.375h-1.5" />
            </svg>
            <span>📄 Copy toàn bộ log ({activeTab})</span>
          </button>

          <div className="my-1 border-t opacity-20" style={{ borderColor: 'var(--border)' }} />

          <button
            type="button"
            onClick={() => {
              setLogs(prev => ({ ...prev, [activeTab]: [] }))
              setStatusText(`Đã xóa sạch màn hình log ${activeTab}`)
              setLogContextMenu(null)
            }}
            className="w-full px-3 py-1.5 text-left flex items-center gap-2 hover:bg-red-500/15 hover:text-red-400 transition-colors border-0 cursor-pointer text-slate-400 text-xs"
          >
            <svg className="w-4 h-4 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
            </svg>
            <span>🧹 Xóa sạch màn hình log</span>
          </button>
        </div>
      )}

    </div>
  )
}
