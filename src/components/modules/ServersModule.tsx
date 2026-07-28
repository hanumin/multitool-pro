import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
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
  preloadedData?: PreloadedData
}

// WHY: Module chính — quản lý dev servers (start/stop/clean/diagnostics).
// Polling 3s cho projects, 2s cho logs, 15s cho port scan.
// Tích hợp Cloudflare Tunnel (quick actions trên card).
export default function ServersModule({ theme, setStatusText, inactive, backgroundPolling, logColors, onBackgroundPollingChange, onLogColorsChange, preloadedData }: ServersModuleProps) {
  const { addToast } = useToast()
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
  const [expandedProject, setExpandedProject] = useState<string | null>(() => {
    try {
      const stored = localStorage.getItem('sd-expanded-project')
      return stored || null
    } catch { return null }
  })
  const [envEditingProject, setEnvEditingProject] = useState<string | null>(null)
  const [envFileName, setEnvFileName] = useState('.env.local')
  const [envContent, setEnvContent] = useState('')
  const [envSaving, setEnvSaving] = useState(false)
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
  const [showServerSettings, setShowServerSettings] = useState(false)
  const logEndRef = useRef<HTMLDivElement>(null)
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
    if (expandedProject) {
      localStorage.setItem('sd-expanded-project', expandedProject)
    } else {
      localStorage.removeItem('sd-expanded-project')
    }
  }, [expandedProject])
  // WHY: Persist activeTab để giữ lại log tab đang xem khi refresh/ mở lại app.
  useEffect(() => {
    localStorage.setItem('sd-active-tab', activeTab)
  }, [activeTab])

  const [showFilterDropdown, setShowFilterDropdown] = useState(false)
  const filterDropdownRef = useRef<HTMLDivElement>(null)
  // WHY: Ref cho inactive để tránh stale closure trong keyHandler (Ctrl+F check).
  const inactiveRef = useRef(inactive)
  inactiveRef.current = inactive

  // WHY: Click outside filter dropdown to close. Escape key closes both dropdowns.
  useEffect(() => {
    const clickHandler = (e: MouseEvent) => {
      if (filterDropdownRef.current && !filterDropdownRef.current.contains(e.target as Node)) {
        setShowFilterDropdown(false)
      }
    }
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

  const logFilterRef = useRef(logFilter)
  logFilterRef.current = logFilter
  // WHY: Dùng ref để luôn có tunnelStates mới nhất trong batch callbacks,
  // tránh stale closure khi state chưa kịp update.
  const tunnelStatesRef = useRef(tunnelStates)
  tunnelStatesRef.current = tunnelStates
  // WHY: Dùng ref để theo dõi URL tunnel trước đó, tránh auto-copy lại mỗi 5s.
  const prevTunnelUrlsRef = useRef<Record<string, string>>({})

  // WHY: Fetch port conflicts for all project ports
  const scanPortConflicts = useCallback(async () => {
    const ports = projects.map(p => p.port)
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
      if (p.running) {
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
    }, 15000)
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
        setStatusText(`❌ Tunnel error: ${data.error || 'Unknown'}`)
        addToast({ type: 'error', title: `🌐 ${name}`, message: data.error || 'Mở tunnel thất bại' })
        if (data.instructions) setStatusText(data.instructions)
      }
    } catch {
      setStatusText('Failed to start tunnel')
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
      setStatusText('Failed to stop tunnel')
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
        setStatusText(`❌ ${data.error || 'Failed'}`)
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

  // WHY: Diagnostics + tunnel status polling — chỉ chạy khi expandedProject != null && module active.
  // Khi inactive => clear intervals, nhưng giữ expandedProject state để khi active lại vẫn mở.
  useEffect(() => {
    if ((inactive && !backgroundPolling) || !expandedProject) return
    if (!projectsRef.current.some(p => p.name === expandedProject)) {
      setExpandedProject(null)
      return
    }
    fetchDiagnostics(expandedProject)
    fetchTunnelStatus(expandedProject)
    const interval = setInterval(() => {
      if (!projectsRef.current.some(p => p.name === expandedProject)) {
        setExpandedProject(null)
        return
      }
      fetchDiagnostics(expandedProject)
    }, 2000)
    const tunnelInterval = setInterval(() => {
      if (!projectsRef.current.some(p => p.name === expandedProject)) {
        setExpandedProject(null)
        return
      }
      fetchTunnelStatus(expandedProject)
    }, 4000)
    return () => { clearInterval(interval); clearInterval(tunnelInterval) }
  }, [expandedProject, fetchDiagnostics, fetchTunnelStatus, inactive, backgroundPolling])

  // WHY: Fetch danh sach projects + cap nhat tray icon.
  // Dung invoke('update_tray_status') de dong bo voi system tray.
  const fetchProjects = useCallback(async () => {
    try {
      const res = await fetchWithRetry(`${API}/api/projects`)
      const data: Project[] = await res.json()
      setProjects(data)
      const running = data.filter(p => p.running).length
      setStatusText(`${running}/${data.length} servers running`)
      try {
        const { invoke } = await import('@tauri-apps/api/core')
        await invoke('update_tray_status', { running, total: data.length })
      } catch {}
    } catch { setStatusText('Reconnecting...') }
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

  // WHY: Fetch tat ca logs (merge vao All tab).
  // Gioi han 300 dong/project + 300 dong All de tranh render qua nhieu.
  const fetchLogs = useCallback(async () => {
    try {
      const res = await fetchWithRetry(`${API}/api/logs/all`)
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
      try {
        const res = await fetchWithRetry(`${API}/api/projects/${encodeURIComponent(p.name)}/tunnel`)
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
      if (p.running) {
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
    fetchProjects()
    fetchLogs()
    fetchAllTunnelStatuses()
    const i1 = setInterval(fetchProjects, 3000)
    const i2 = setInterval(fetchLogs, 2000)
    const i3 = setInterval(fetchAllTunnelStatuses, 5000)
    return () => { clearInterval(i1); clearInterval(i2); clearInterval(i3) }
  }, [fetchProjects, fetchLogs, fetchAllTunnelStatuses, inactive, backgroundPolling])

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
  // Refresh projects list sau khi action.
  const act = async (name: string, action: 'start' | 'stop') => {
    setLoading(p => ({ ...p, [name]: true }))
    try {
      const res = await fetchWithRetry(`${API}/api/projects/${encodeURIComponent(name)}/${action}`, { method: 'POST' })
      if (res.ok) {
        setStatusText(`${action === 'start' ? 'Started' : 'Stopped'} ${name}`)
        if (action === 'start') {
          addToast({ type: 'success', title: `🚀 ${name}`, message: 'Máy chủ đã khởi động' })
        } else {
          addToast({ type: 'info', title: `⏹ ${name}`, message: 'Máy chủ đã dừng' })
        }
      } else {
        const e = await res.json();
        setStatusText(e.error || 'Failed')
        addToast({ type: 'error', title: `❌ ${name}`, message: e.error || 'Thao tác thất bại' })
      }
      await fetchProjects()
    } catch {
      setStatusText('Connection failed')
      addToast({ type: 'error', title: '🔌 Mất kết nối', message: `Không thể ${action === 'start' ? 'khởi động' : 'dừng'} ${name}` })
    }
    finally { setLoading(p => ({ ...p, [name]: false })) }
  }

  // WHY: 3 muc do clean — basic (cache), deep (build folders), nuke (node_modules + reinstall).
  // Confirm truoc khi clean vi khong undo duoc.
  const cleanProject = async (name: string, type: 'basic' | 'deep' | 'nuke') => {
    let msg = `Run clean (${type}) for ${name}?`
    if (type === 'deep') msg = 'Deep clean will stop the server and delete build folders. Continue?'
    else if (type === 'nuke') msg = `⚠️ NUKE CLEAN will delete node_modules and reinstall. Continue?`
    if (!window.confirm(msg)) return
    setClearing(c => ({ ...c, [name]: true }))
    try {
      const res = await fetchWithRetry(`${API}/api/projects/${encodeURIComponent(name)}/clean`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type })
      })
      const data = await res.json()
      if (res.ok) {
        if (data.status === 'nuked_reinstalling') {
          setStatusText(`Nuked ${name}! Running npm install...`)
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
      setStatusText('Connection failed')
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
  const openEnvEditor = async (name: string) => {
    setEnvEditingProject(name)
    setEnvContent('')
    try {
      const res = await fetchWithRetry(`${API}/api/projects/${encodeURIComponent(name)}/env`)
      if (res.ok) { const d = await res.json(); setEnvFileName(d.fileName); setEnvContent(d.content) }
    } catch { setStatusText('Failed to load env file') }
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
      else { const e = await res.json(); setStatusText(e.error || 'Failed'); addToast({ type: 'error', title: '💾 Lưu .env thất bại', message: e.error || 'Lỗi không xác định' }) }
    } catch { setStatusText('Connection failed'); addToast({ type: 'error', title: '🔌 Mất kết nối', message: 'Không thể kết nối tới backend' }) }
    finally { setEnvSaving(false) }
  }

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
    if (!targetLines.length) { setStatusText('No logs to copy'); return }
    const content = formatLogs(targetLines, exportFormat)
    navigator.clipboard.writeText(content)
    setStatusText(`Copied ${targetLines.length} lines as ${exportFormat.toUpperCase()}`)
  }

  // WHY: Download log qua backend API (/api/logs/export) — xu ly file name tu Content-Disposition header.
  // Blob download fallback cho browser mode (khong co Tauri save dialog).
  const handleDownloadLog = async () => {
    const lines = fullLogs[activeTab] || []
    if (!lines.length) { setStatusText('No logs to download'); return }
    try {
      const params = new URLSearchParams({
        project: activeTab,
        format: exportFormat,
        limit: String(exportLimit),
        search: logSearch
      })
      const res = await fetchWithRetry(`${API}/api/logs/export?${params}`)
      if (!res.ok) { setStatusText('Download failed'); return }
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
    if (!targetLines.length) { setStatusText('No logs to export'); return }
    const content = formatLogs(targetLines, exportFormat)
    const fileExt = exportFormat === 'txt' ? 'log' : exportFormat
    const defaultName = `logs_${activeTab.toLowerCase().replace(/\s+/g, '_')}_${exportLimit === 0 ? 'all' : exportLimit}.${fileExt}`
    try {
      const { save } = await import('@tauri-apps/plugin-dialog')
      const selectedPath = await save({ title: 'Export Server Logs', defaultPath: defaultName, filters: [{ name: exportFormat.toUpperCase(), extensions: [fileExt] }] })
      if (!selectedPath) { setStatusText('Export cancelled'); return }
      setStatusText('Saving...')
      const res = await fetchWithRetry(`${API}/api/logs/save-to-file`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: selectedPath, content }) })
      setStatusText(res.ok ? `Exported to ${selectedPath.split(/[\\/]/).pop()}` : (await res.json()).error || 'Failed')
    } catch (err: any) { setStatusText(err?.message || 'Export error') }
  }

  const displayLines = logs[activeTab] || []
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
      <div className="shrink-0 flex items-center justify-between px-4 pt-3 pb-1">
        <div className="flex items-center gap-2">
          <button onClick={async () => {
            setBatchLoading(true)
            try {
              await fetchWithRetry(`${API}/api/projects/start-all`, { method: 'POST' })
              setStatusText('Started all projects')
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
              setStatusText('Stopped all projects')
              addToast({ type: 'info', title: '⏹ Dừng hàng loạt', message: 'Tất cả dự án đã được dừng' })
              await fetchProjects()
            } catch {
              setStatusText('Failed to stop all')
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
          {/* Background Polling Toggle */}
          {onBackgroundPollingChange && (
            <button onClick={() => onBackgroundPollingChange(!backgroundPolling)}
              className="flex items-center gap-1 px-2 py-1 text-[10px] rounded-lg transition-all active:scale-95 cursor-pointer border-0"
              style={{ color: backgroundPolling ? '#34d399' : 'var(--fg-muted)', backgroundColor: backgroundPolling ? 'rgba(52,211,153,0.1)' : 'transparent' }}>
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" />
              </svg>
              Nền: {backgroundPolling ? 'BẬT' : 'TẮT'}
            </button>
          )}
          {/* Settings button — merged, placed next to tunnel info */}
          {(onBackgroundPollingChange || onLogColorsChange) && (
            <button onClick={() => setShowServerSettings(!showServerSettings)}
              className="flex items-center gap-1 px-2 py-1 text-xs rounded-lg transition-all active:scale-95 cursor-pointer border-0 group relative shrink-0"
              style={{ color: showServerSettings ? '#34d399' : 'var(--fg-muted)', background: showServerSettings ? 'rgba(52,211,153,0.1)' : 'transparent' }}>
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
              <span>Cài đặt</span>
              <span className="tooltip-text">{showServerSettings ? 'Ẩn cài đặt' : 'Cài đặt nhanh'}</span>
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

      {/* ⚙️ Settings Dropdown — gọn, không chiếm không gian */}
      {showServerSettings && (onBackgroundPollingChange || onLogColorsChange) && (
        <div className="shrink-0 mx-4 mb-2">
          <div className="relative">
            {/* Backdrop to close on outside click */}
            <div className="fixed inset-0 z-10" onClick={() => setShowServerSettings(false)} />
            <div className="absolute right-0 top-0 z-20 min-w-[240px] rounded-xl border shadow-2xl overflow-hidden backdrop-blur-xl"
              style={{ backgroundColor: 'var(--bg-card)', borderColor: 'var(--border)' }}>
              <div className="px-3 py-2 border-b flex items-center justify-between" style={{ borderColor: 'var(--border)' }}>
                <h4 className="text-[10px] font-semibold uppercase tracking-wider flex items-center gap-1.5" style={{ color: 'var(--fg-muted)' }}>
                  <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                  </svg>
                  Cài đặt nhanh
                </h4>
                <button onClick={() => setShowServerSettings(false)}
                  className="p-0.5 rounded hover:bg-white/10 transition-colors cursor-pointer border-0"
                  style={{ color: 'var(--fg-muted)' }}>
                  <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
              <div className="p-3 space-y-3">
                {/* Background Polling */}
                {onBackgroundPollingChange && (
                  <label className="flex items-center justify-between gap-3 text-xs cursor-pointer select-none" style={{ color: 'var(--fg-secondary)' }}>
                    <div className="flex items-center gap-2">
                      <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" />
                      </svg>
                      <span>Polling nền</span>
                    </div>
                    <label className="relative inline-flex items-center cursor-pointer">
                      <input type="checkbox" checked={!!backgroundPolling}
                        onChange={e => onBackgroundPollingChange(e.target.checked)}
                        className="sr-only peer" />
                      <div className="w-7 h-3.5 rounded-full peer peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-2.5 after:w-2.5 after:transition-all peer-checked:bg-emerald-500/60 bg-gray-600/40" />
                    </label>
                  </label>
                )}
                {/* Log Color Presets */}
                {onLogColorsChange && (
                  <div>
                    <div className="flex items-center gap-2 text-xs mb-2" style={{ color: 'var(--fg-secondary)' }}>
                      <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zM14 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zM14 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z" />
                      </svg>
                      <span>Màu sắc log</span>
                    </div>
                    <div className="flex items-center gap-1.5 flex-wrap">
                      {(['error', 'warn', 'success', 'defaultText'] as const).map(level => {
                        const color = (logColors && logColors[level]) || DEFAULT_LOG_COLORS[level] || (
                          level === 'error' ? '#f87171' :
                          level === 'warn' ? '#fbbf24' :
                          level === 'success' ? '#4ade80' :
                          '#9ca3af'
                        )
                        return (
                          <div key={level} className="relative group/color">
                            <input type="color" value={color as string}
                              onChange={e => onLogColorsChange({ ...(logColors || {}), [level]: e.target.value })}
                              className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                              title={level === 'error' ? 'Màu lỗi' : level === 'warn' ? 'Màu cảnh báo' : level === 'success' ? 'Màu thành công' : 'Màu mặc định'} />
                            <div className="w-6 h-6 rounded-md border shadow-sm transition-transform active:scale-95 ring-1 ring-white/10"
                              style={{ backgroundColor: color, borderColor: 'transparent' }} />
                            <span className="absolute -top-5 left-1/2 -translate-x-1/2 text-[8px] whitespace-nowrap px-1 py-0.5 rounded opacity-0 group-hover/color:opacity-100 transition-opacity pointer-events-none"
                              style={{ backgroundColor: 'var(--bg)', color: 'var(--fg)' }}>
                              {level === 'error' ? 'Lỗi' : level === 'warn' ? 'Cảnh báo' : level === 'success' ? 'OK' : 'Mặc định'}
                            </span>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Server Cards */}
      <div className="shrink-0 grid grid-cols-2 gap-3 px-4 pb-2">
        {projects.map((p, idx) => (
          <div key={p.name} className={`relative group rounded-xl border backdrop-blur p-4 ${'card-hover animate-card-enter'} flex flex-col justify-between`}
            style={{ background: 'var(--bg-card)', borderColor: 'var(--border)', animationDelay: `${idx * 0.05}s` }}>
            <div className={`absolute left-0 top-2 bottom-2 w-0.5 rounded-full transition-all duration-300 ${p.running ? 'bg-emerald-400 animate-running-bar' : ''}`}
              style={{ background: p.running ? undefined : 'var(--fg-dim)' }} />
            <div>
              <div className="flex items-start justify-between pl-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <h2 className="text-sm font-medium truncate" style={{ color: 'var(--fg)' }}>{p.name}</h2>
                    <span className={`relative inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold ${p.running ? 'bg-emerald-500/15 text-emerald-500 ring-1 ring-emerald-500/20 animate-badge-pop' : 'bg-red-500/10 text-red-400 ring-1 ring-red-500/15'}`}>
                      <span className={`w-1 h-1 rounded-full ${p.running ? 'bg-emerald-400 animate-pulse' : 'bg-red-400'}`} />
                      {p.running && <span className="absolute inset-0 rounded-full animate-status-ring" />}
                      {p.running ? 'ĐANG CHẠY' : 'ĐÃ DỪNG'}
                    </span>
                  </div>
                  <p className="text-xs mt-1 truncate font-mono" style={{ color: 'var(--fg-dim)' }} title={p.path}>{p.path}</p>
                </div>
                <button onClick={() => setExpandedProject(expandedProject === p.name ? null : p.name)}
                  className="p-1 rounded-lg hover:bg-black/10 dark:hover:bg-white/10 transition-colors ml-2 shrink-0 border-0"
                  style={{ color: 'var(--fg-muted)' }} title="Chẩn đoán & Biến môi trường">
                  <svg className="w-3.5 h-3.5 transition-transform duration-200" style={{ transform: expandedProject === p.name ? 'rotate(180deg)' : 'none' }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
                  </svg>
                </button>
              </div>
              {expandedProject === p.name && (
                <div className="mt-3 pt-3 border-t border-dashed space-y-2 text-xs pl-3 expand-enter" style={{ borderColor: 'var(--border)' }}>
                  <div className="grid grid-cols-2 gap-2">
                    <div><span style={{ color: 'var(--fg-muted)' }}>Bộ nhớ:</span> <span className="font-mono" style={{ color: 'var(--fg-secondary)' }}>{diagnostics[p.name]?.memory ? `${(diagnostics[p.name].memory / 1024 / 1024).toFixed(1)} MB` : p.running ? '...' : 'Không hoạt động'}</span></div>
                    <div><span style={{ color: 'var(--fg-muted)' }}>CPU:</span> <span className="font-mono" style={{ color: 'var(--fg-secondary)' }}>{diagnostics[p.name]?.cpu !== undefined ? `${diagnostics[p.name].cpu}%` : p.running ? '...' : 'Inactive'}</span></div>
                    {/* Uptime */}
                    <div><span style={{ color: 'var(--fg-muted)' }}>Uptime:</span> <span className="font-mono" style={{ color: diagnostics[p.name]?.uptime_seconds > 3600 ? '#22c55e' : 'var(--fg-secondary)' }}>{diagnostics[p.name]?.uptime || (p.running ? '...' : '-')}</span></div>
                    <div><span style={{ color: 'var(--fg-muted)' }}>Node:</span> <span className="font-mono" style={{ color: 'var(--fg-secondary)' }}>{diagnostics[p.name]?.env?.node || '...'} {diagnostics[p.name]?.env?.npm ? `(npm ${diagnostics[p.name].env.npm})` : ''}</span></div>
                  </div>
                  {diagnostics[p.name]?.git && (
                    <div className="flex items-center gap-2 flex-wrap">
                      <span style={{ color: 'var(--fg-muted)' }}>Git:</span>
                      <span className="font-mono text-emerald-500">{diagnostics[p.name].git.branch}</span>
                      <span className={`px-1 rounded text-[8px] font-mono ${diagnostics[p.name].git.is_dirty ? 'bg-amber-500/10 text-amber-500 border border-amber-500/15' : 'bg-emerald-500/10 text-emerald-500 border border-emerald-500/15'}`}>
                        {diagnostics[p.name].git.is_dirty ? `${diagnostics[p.name].git.dirty_count} đã sửa` : 'sạch'}
                      </span>
                    </div>
                  )}
                  {/* Quick Actions Row */}
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
                      } catch { setStatusText('Failed to create SSL cert') }
                    }}
                      className="px-2 py-1 text-[10px] font-semibold rounded border transition-colors active:scale-95 cursor-pointer"
                      style={{ backgroundColor: 'var(--input-bg)', borderColor: 'var(--border)', color: 'var(--fg-secondary)' }}>🔒 SSL</button>
                  </div>
                  {/* Cloudflare Tunnel */}
                  <div className="pt-2 border-t border-dashed" style={{ borderColor: 'var(--border)' }}>
                    <div className="flex items-center gap-1.5 mb-1.5">
                      <span className="text-xs font-semibold" style={{ color: 'var(--fg-muted)' }}>🌐 Cloudflare Tunnel</span>
                      {tunnelStates[p.name]?.status === 'active' && (
                        <span className="px-1.5 py-0.5 rounded text-[8px] font-bold bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 flex items-center gap-1">
                          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" /> ĐANG HOẠT ĐỘNG
                        </span>
                      )}
                      {tunnelStates[p.name]?.status === 'connecting' && (
                        <span className="px-1.5 py-0.5 rounded text-[8px] font-bold bg-amber-500/10 text-amber-400 border border-amber-500/20 flex items-center gap-1">
                          <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" /> ĐANG KẾT NỐI
                        </span>
                      )}
                      {tunnelStates[p.name]?.status === 'error' && (
                        <span className="px-1.5 py-0.5 rounded text-[8px] font-bold bg-red-500/15 text-red-400 border border-red-500/30 flex items-center gap-1">
                          <span className="w-1.5 h-1.5 rounded-full bg-red-400" /> LỖI
                        </span>
                      )}
                    </div>
                    {(() => {
                      const ts = tunnelStates[p.name]
                      if (ts?.status === 'active' && ts?.url) {
                        return (
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <a href={ts.url} target="_blank" rel="noopener noreferrer"
                              className="text-xs font-mono truncate max-w-[180px] underline underline-offset-2 hover:text-blue-400 bg-transparent border-0 cursor-pointer"
                              style={{ color: '#3b82f6', textDecorationColor: '#3b82f680' }}>
                              {ts.url}
                            </a>
                            <button onClick={() => {
                              navigator.clipboard.writeText(ts.url!)
                              setStatusText('Đã copy URL tunnel')
                            }}
                              className="px-1.5 py-0.5 text-[8px] font-semibold rounded border transition-colors active:scale-95 cursor-pointer"
                              style={{ backgroundColor: 'var(--input-bg)', borderColor: 'var(--border)', color: 'var(--fg-dim)' }}>
                              📋 Copy
                            </button>
                            <button onClick={() => openBrowser(ts.url!)}
                              className="px-1.5 py-0.5 text-[8px] font-semibold rounded bg-blue-500/15 text-blue-400 hover:bg-blue-500/25 border-0 cursor-pointer active:scale-95 transition-all">
                              🔗 Mở trình duyệt
                            </button>
                            <button onClick={() => stopTunnel(p.name)} disabled={tunnelLoading[p.name]}
                              className="px-1.5 py-0.5 text-[8px] font-semibold rounded border transition-colors active:scale-95 cursor-pointer disabled:opacity-30"
                              style={{ backgroundColor: 'var(--input-bg)', borderColor: 'var(--border)', color: '#ef4444' }}>
                              {tunnelLoading[p.name] ? '...' : '⏹ Dừng'}
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
                              className="px-1.5 py-0.5 text-[8px] font-semibold rounded border transition-colors active:scale-95 cursor-pointer disabled:opacity-30"
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
                      <div className="flex items-center gap-2 pt-1.5 border-t border-dashed mt-1.5" style={{ borderColor: 'var(--border)' }}>
                        <label className="relative inline-flex items-center cursor-pointer" title={tunnelStates[p.name]?.watchdog_enabled ? 'Tự động restart tunnel khi chết' : 'Bật để tunnel tự động phục hồi' }>
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
                </div>
              )}
              {/* ─── Tunnel URL — hiển thị trên card, không cần expand ─── */}
              <div className="mt-2 pt-2 pl-3 border-t border-dashed" style={{ borderColor: 'var(--border)' }}>
                {(() => {
                  const ts = tunnelStates[p.name]
                  if (!ts) return null
                  if (ts.status === 'active' && ts.url) {
                    return (
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className="flex items-center gap-1 text-[10px] font-semibold" style={{ color: '#34d399' }}>
                          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" /> Tunnel
                        </span>
                        <a href={ts.url} target="_blank" rel="noopener noreferrer"
                          className="text-xs font-mono truncate max-w-[170px] underline underline-offset-2 hover:text-blue-400 bg-transparent border-0 cursor-pointer"
                          style={{ color: '#3b82f6', textDecorationColor: '#3b82f680' }}>
                          {ts.url.replace('https://', '')}
                        </a>
                        <button onClick={() => { navigator.clipboard.writeText(ts.url!); setStatusText('📋 Đã copy URL') }}
                          className="px-1 py-0.5 text-[8px] font-semibold rounded border transition-colors active:scale-95 cursor-pointer hover:bg-white/5 flex items-center gap-0.5"
                          style={{ backgroundColor: 'var(--input-bg)', borderColor: 'var(--border)', color: 'var(--fg-dim)' }}>
                          <svg className="w-2.5 h-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                          </svg>
                          Copy
                        </button>
                        <button onClick={() => openBrowser(ts.url!)}
                          className="px-1 py-0.5 text-[8px] font-semibold rounded bg-blue-500/15 text-blue-400 hover:bg-blue-500/25 border-0 cursor-pointer active:scale-95 transition-all flex items-center gap-0.5">
                          <svg className="w-2.5 h-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                          </svg>
                          Mở
                        </button>
                        <button onClick={() => stopTunnel(p.name)} disabled={tunnelLoading[p.name]}
                          className="px-1 py-0.5 text-[8px] font-semibold rounded border transition-colors active:scale-95 cursor-pointer disabled:opacity-30 hover:bg-red-500/10"
                          style={{ borderColor: 'rgba(239,68,68,0.3)', color: '#ef4444' }}>
                          Dừng
                        </button>
                        {ts.watchdog_restart_count !== undefined && ts.watchdog_restart_count > 0 && (
                          <span className="flex items-center gap-0.5 text-[8px] font-mono" style={{ color: '#fbbf24' }}>
                            <svg className="w-2 h-2" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                            </svg>
                            {ts.watchdog_restart_count}
                          </span>
                        )}
                      </div>
                    )
                  }
                  if (ts.status === 'connecting') {
                    return (
                      <div className="flex items-center gap-1.5">
                        <span className="flex items-center gap-1 text-[10px] font-semibold" style={{ color: '#fbbf24' }}>
                          <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" /> Tunnel
                        </span>
                        <div className="flex items-center gap-1">
                          <div className="animate-spin rounded-full h-2 w-2 border-b border-amber-400" />
                          <span className="text-[10px]" style={{ color: 'var(--fg-dim)' }}>Đang kết nối...</span>
                        </div>
                        <button onClick={() => stopTunnel(p.name)} disabled={tunnelLoading[p.name]}
                          className="px-1.5 py-0.5 text-[8px] font-semibold rounded border transition-colors active:scale-95 cursor-pointer disabled:opacity-30"
                          style={{ backgroundColor: 'var(--input-bg)', borderColor: 'var(--border)', color: '#ef4444' }}>
                          Hủy
                        </button>
                      </div>
                    )
                  }
                  if (ts.status === 'error') {
                    return (
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className="flex items-center gap-1 text-[10px] font-semibold" style={{ color: '#ef4444' }}>
                          <span className="w-1.5 h-1.5 rounded-full bg-red-400" /> Tunnel
                        </span>
                        <span className="text-[10px] truncate max-w-[150px]" style={{ color: '#ef4444' }}>{ts.error || 'Lỗi'}</span>
                        <button onClick={() => startTunnel(p.name)} disabled={!p.running || tunnelLoading[p.name]}
                          className="flex items-center gap-0.5 px-1.5 py-0.5 text-[8px] font-semibold rounded border transition-colors active:scale-95 cursor-pointer disabled:opacity-30"
                          style={{ backgroundColor: 'rgba(59,130,246,0.1)', borderColor: 'rgba(59,130,246,0.25)', color: '#60a5fa' }}>
                          <svg className="w-2 h-2" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                          </svg>
                          Thử lại
                        </button>
                      </div>
                    )
                  }
                  if (p.running && ts.cloudflared_installed !== undefined) {
                    return (
                      <div className="flex items-center gap-1.5">
                        <span className="text-[10px]" style={{ color: 'var(--fg-dim)' }}>🌐 Tunnel</span>
                        {ts.cloudflared_installed === false ? (
                          <button onClick={() => installAndStartTunnel(p.name)}
                            disabled={tunnelLoading[p.name]}
                            className="flex items-center gap-1 px-2 py-0.5 text-[9px] font-semibold rounded-lg transition-all active:scale-95 cursor-pointer disabled:opacity-30"
                            style={{ backgroundColor: 'rgba(16,185,129,0.15)', color: '#34d399', border: '1px solid rgba(16,185,129,0.3)' }}>
                            {tunnelLoading[p.name] ? (
                              <><div className="animate-spin rounded-full h-2 w-2 border-b border-current" /> Đang cài...</>
                            ) : '📥 Cài & Mở'}
                          </button>
                        ) : (
                          <button onClick={() => startTunnel(p.name)}
                            disabled={tunnelLoading[p.name]}
                            className="flex items-center gap-1 px-2 py-0.5 text-[9px] font-semibold rounded-lg transition-all active:scale-95 cursor-pointer disabled:opacity-30"
                            style={{ backgroundColor: 'rgba(59,130,246,0.1)', color: '#60a5fa', border: '1px solid rgba(59,130,246,0.25)' }}>
                            {tunnelLoading[p.name] ? (
                              <><div className="animate-spin rounded-full h-2 w-2 border-b border-current" /> Đang kết nối...</>
                            ) : '🔗 Mở tunnel'}
                          </button>
                        )}
                      </div>
                    )
                  }
                  return null
                })()}
              </div>
            </div>
            <div className="flex items-center justify-between mt-2 pl-3">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-xs font-mono" style={{ color: 'var(--fg-muted)' }}><span style={{ color: 'var(--fg-dim)' }}>Cổng</span> {p.port}</span>
                {p.running && (
                  <button onClick={() => openBrowser(`http://localhost:${p.port}`)}
                    className="text-xs underline underline-offset-2 hover:text-blue-400 bg-transparent border-0 cursor-pointer p-0" style={{ color: '#3b82f6', textDecorationColor: '#3b82f680' }}>Mở</button>
                )}
                {/* Port Conflict Badge */}
                {portConflicts[p.port] && portConflicts[p.port].length > 0 && (
                  <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[8px] font-semibold bg-red-500/15 text-red-400 ring-1 ring-red-500/20"
                    title={`Conflict on port ${p.port}: ${portConflicts[p.port].map((c: any) => `${c.name} (PID:${c.pid})`).join(', ')}`}>
                    ⚔️ Conflict
                  </span>
                )}
                {/* Disk Usage Badge */}
                {diskSizes[p.name]?.node_modules && (
                  <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[8px] font-mono ${
                    diskSizes[p.name].node_modules > 500
                      ? 'bg-amber-500/15 text-amber-400 ring-1 ring-amber-500/20'
                      : 'bg-emerald-500/10 text-emerald-500 ring-1 ring-emerald-500/15'
                  }`} title={`node_modules: ${diskSizes[p.name].node_modules}MB | .next: ${diskSizes[p.name]['.next'] || 0}MB`}>
                    📦 {diskSizes[p.name].node_modules}MB
                  </span>
                )}
                {/* Quick File Explorer */}
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
                  className="text-xs px-1.5 py-0.5 rounded hover:bg-black/10 dark:hover:bg-white/10 transition-colors border-0 cursor-pointer"
                  style={{ color: 'var(--fg-muted)' }} title="Mở trong File Explorer">
                  📁
                </button>
                {/* Quick npm Scripts */}
                {projectScripts[p.name] && projectScripts[p.name].length > 0 && (
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
                    className="px-1.5 py-0.5 text-[8px] rounded border cursor-pointer"
                    style={{ backgroundColor: 'var(--input-bg)', borderColor: 'var(--border)', color: 'var(--fg-secondary)' }}>
                    <option value="">⚡ Script</option>
                    {projectScripts[p.name].filter(s => ['build','lint','test','typecheck','format','preview'].includes(s)).map(s => (
                      <option key={s} value={s}>{s}</option>
                    ))}
                  </select>
                )}
              </div>
              <div className="flex gap-1.5 items-center">
                <button onClick={() => act(p.name, 'start')} disabled={p.running || loading[p.name]}
                  className="px-3 py-1.5 text-xs font-semibold rounded-lg transition-all cursor-pointer disabled:opacity-30 active:scale-95 bg-emerald-500/15 text-emerald-500 hover:bg-emerald-500/25 ring-1 ring-emerald-500/20 border-0">
                  {loading[p.name] ? '...' : 'Bắt đầu'}
                </button>
                <button onClick={() => act(p.name, 'stop')} disabled={!p.running || loading[p.name]}
                  className="px-3 py-1.5 text-xs font-semibold rounded-lg transition-all cursor-pointer disabled:opacity-30 active:scale-95 bg-red-500/10 text-red-400 hover:bg-red-500/20 ring-1 ring-red-500/15 border-0">
                  {loading[p.name] ? '...' : 'Dừng'}
                </button>
                <select id={`clean-select-${p.name}`} name="cleanType" onChange={e => { const v = e.target.value as 'basic' | 'deep' | 'nuke'; if (v) { cleanProject(p.name, v); e.target.value = '' } }}
                  disabled={clearing[p.name]} className="px-2 py-1.5 text-xs font-semibold rounded-lg cursor-pointer border transition-colors"
                  style={{ backgroundColor: 'var(--input-bg)', borderColor: 'var(--border)', color: 'var(--fg-secondary)' }}>
                  <option value="">Dọn...</option>
                  <option value="basic">Cache nhanh</option>
                  <option value="deep">Build sâu</option>
                  <option value="nuke">Xóa sạch & Cài lại</option>
                </select>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* ─── Log Viewer — Terminal Style ─── */}
      <div className="flex-1 min-h-0 px-4 pb-4">
        <div className="h-full rounded-xl border flex flex-col overflow-hidden" style={{ borderColor: 'rgba(255,255,255,0.06)' }}>
          {/* Terminal Title Bar — macOS style traffic-light dots */}
          <div className="terminal-header shrink-0">
            <div className="flex items-center gap-1.5">
              <div className="terminal-dot red" title="Đóng" />
              <div className="terminal-dot yellow" title="Thu nhỏ" />
              <div className="terminal-dot green" title="Phóng to" />
            </div>
            <div className="flex-1 text-center">
              <span className="text-[10px] font-medium tracking-wide" style={{ color: 'rgba(255,255,255,0.4)' }}>
                {activeTab === 'All' ? '📋 Terminal — Tất cả log' : `📋 Terminal — ${activeTab}`}
              </span>
            </div>
            <div className="flex items-center gap-1">
              <button onClick={handleCopyLog}
                className="px-1.5 py-0.5 text-[8px] font-medium rounded transition-colors cursor-pointer"
                style={{ color: 'rgba(255,255,255,0.4)', background: 'rgba(255,255,255,0.06)' }}
                title="Copy log">
                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2m0 0h2a2 2 0 012 2v3m2 4H10m0 0l3-3m-3 3l3 3" />
                </svg>
              </button>
              <button onClick={handleDownloadLog}
                className="px-1.5 py-0.5 text-[8px] font-medium rounded transition-colors cursor-pointer"
                style={{ color: 'rgba(255,255,255,0.4)', background: 'rgba(255,255,255,0.06)' }}
                title="Tải log">
                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                </svg>
              </button>
            </div>
          </div>
          <div className="shrink-0" style={{ backgroundColor: '#161822' }}>
            <div className="flex items-center justify-between px-3 py-1" style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
              <div className="flex gap-0.5 overflow-x-auto">
                {tabs.map(tab => {
                  const isActive = activeTab === tab
                  return (
                    <button key={tab} onClick={() => setActiveTab(tab)}
                      className={`terminal-tab px-2 py-1 text-[10px] font-medium rounded-t transition-all cursor-pointer border-0 ${
                        isActive ? 'active' : ''
                      }`}
                      style={isActive
                        ? { color: '#34d399', background: '#0d1117', borderBottom: '2px solid #34d399' }
                        : { color: 'rgba(255,255,255,0.3)', background: 'transparent' }}>
                      <span className="flex items-center gap-1.5">
                        <span className={`w-1.5 h-1.5 rounded-full ${tab === 'All' || projects.find(p => p.name === tab)?.running ? 'bg-emerald-400' : 'bg-gray-500'}`} />
                        {tab}
                      </span>
                    </button>
                  )
                })}
              </div>
              <div className="flex items-center gap-1.5 shrink-0 ml-2">
                <select id="log-export-limit" name="exportLimit" value={exportLimit} onChange={e => setExportLimit(Number(e.target.value))}
                  className="px-1.5 py-0.5 text-[9px] font-medium rounded cursor-pointer border-0 transition-all"
                  style={{ backgroundColor: 'rgba(255,255,255,0.06)', color: 'rgba(255,255,255,0.5)' }}>
                  <option value={100}>100 dòng</option>
                  <option value={500}>500</option>
                  <option value={1000}>1000</option>
                  <option value={0}>Tất cả</option>
                </select>
                <select id="log-export-format" name="exportFormat" value={exportFormat} onChange={e => setExportFormat(e.target.value as any)}
                  className="px-1.5 py-0.5 text-[9px] font-medium rounded cursor-pointer border-0 transition-all"
                  style={{ backgroundColor: 'rgba(255,255,255,0.06)', color: 'rgba(255,255,255,0.5)' }}>
                  <option value="txt">TXT</option>
                  <option value="md">MD</option>
                  <option value="json">JSON</option>
                </select>
                <button onClick={handleExportLog}
                  className="px-1.5 py-0.5 text-[8px] font-medium rounded transition-all cursor-pointer flex items-center gap-1"
                  style={{ color: 'rgba(255,255,255,0.5)', background: 'rgba(255,255,255,0.06)' }}>
                  💾 Lưu
                </button>
              </div>
            </div>
            {/* Log Search & Filter Bar */}
            <div className="flex items-center gap-2 px-3 py-1" style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
              <div className="relative flex-1 max-w-[200px]">
                <svg className="absolute left-2 top-1/2 -translate-y-1/2 w-2.5 h-2.5" style={{ color: 'rgba(255,255,255,0.2)' }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
                <input ref={searchInputRef} id="log-search" name="logSearch" type="text" value={logSearch}
                  onChange={e => setLogSearch(e.target.value)}
                  onFocus={() => setShowSearchHistory(true)}
                  onBlur={() => setTimeout(() => setShowSearchHistory(false), 200)}
                  onKeyDown={e => {
                    if (e.key === 'Enter' && logSearch.trim()) {
                      setSearchHistory(prev => {
                        const filtered = prev.filter(s => s !== logSearch.trim())
                        return [logSearch.trim(), ...filtered].slice(0, 10)
                      })
                    }
                  }}
                  placeholder="Tìm kiếm..."
                  className="w-full pl-5 pr-2 py-0.5 text-[10px] rounded border-0 transition-all focus:outline-none"
                  style={{ backgroundColor: 'rgba(255,255,255,0.04)', color: '#e6edf3', fontFamily: 'inherit' }} />
                {/* Search History Dropdown */}
                {showSearchHistory && searchHistory.length > 0 && (
                  <div className="absolute top-full left-0 right-0 mt-0.5 rounded-lg border shadow-lg z-50 overflow-hidden"
                    style={{ backgroundColor: '#1a1b26', borderColor: 'rgba(255,255,255,0.08)' }}>
                    <div className="flex items-center justify-between px-2 py-1 text-[8px]" style={{ color: 'rgba(255,255,255,0.3)', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
                      <span>Tìm gần đây</span>
                      <button onClick={() => { setSearchHistory([]); setShowSearchHistory(false) }}
                        className="hover:underline bg-transparent border-0 cursor-pointer" style={{ color: 'rgba(255,255,255,0.3)' }}>🗑️ Xoá hết</button>
                    </div>
                    {searchHistory.map((q, i) => (
                      <div key={i} className="flex items-center px-2 py-1 hover:bg-white/[0.04] transition-colors cursor-default">
                        <button onMouseDown={() => { setLogSearch(q); setShowSearchHistory(false) }}
                          className="flex-1 text-left text-[9px] flex items-center gap-2 bg-transparent border-0 cursor-pointer"
                          style={{ color: 'rgba(255,255,255,0.6)' }}>
                          <span style={{ color: 'rgba(255,255,255,0.2)' }}>🕐</span>
                          <span className="truncate">{q}</span>
                        </button>
                        <button onMouseDown={(e) => { e.stopPropagation(); setSearchHistory(prev => prev.filter((_, idx) => idx !== i)) }}
                          className="opacity-0 group-hover:opacity-100 bg-transparent border-0 cursor-pointer px-1 py-0.5 text-[8px] rounded hover:bg-red-500/15 transition-all shrink-0"
                          style={{ color: '#ef4444' }}>✕</button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              {(() => {
                const { counts, total } = logLevelCounts
                const filterOpts: { value: string; icon: string; label: string }[] = [
                  { value: 'info', icon: 'ℹ️', label: 'Info' },
                  { value: 'error', icon: '❌', label: 'Lỗi' },
                  { value: 'warn', icon: '⚠️', label: 'C.báo' },
                  { value: 'success', icon: '✅', label: 'OK' },
                  { value: 'build', icon: '🔧', label: 'Build' },
                  { value: 'tunnel', icon: '🌐', label: 'Tunnel' },
                  { value: 'metrics', icon: '📊', label: 'S.liệu' },
                  { value: 'cleanup', icon: '🧹', label: 'Dọn' },
                  { value: 'debug', icon: '🔍', label: 'Debug' },
                ]
                const selectedCount = logFilter.length
                const allLevelCount = filterOpts.length
                return (
                  <div ref={filterDropdownRef} className="relative flex items-center gap-1">
                    <button onClick={() => setShowFilterDropdown(prev => !prev)}
                      className="flex items-center gap-1 px-1.5 py-0.5 text-[9px] rounded transition-all cursor-pointer border-0 relative"
                      style={{
                        color: selectedCount === 0 ? 'rgba(255,255,255,0.3)' : '#34d399',
                        backgroundColor: selectedCount === 0 ? 'rgba(255,255,255,0.04)' : 'rgba(52,211,153,0.1)',
                      }}>
                      <span>📋</span>
                      <span>{selectedCount === 0 ? 'Lọc' : `${selectedCount}`}</span>
                      {selectedCount > 0 && (
                        <span className="ml-1 px-1 rounded-full text-[7px] font-bold" style={{ backgroundColor: '#34d399', color: '#0f172a' }}>
                          {selectedCount}
                        </span>
                      )}
                    </button>
                    {selectedCount > 0 && (
                      <button onClick={() => { setLogFilter([]); setShowFilterDropdown(false) }}
                        className="px-1 py-0.5 text-[8px] rounded transition-all cursor-pointer border-0"
                        style={{ color: 'rgba(239,68,68,0.6)', backgroundColor: 'rgba(239,68,68,0.08)' }}>✕</button>
                    )}
                    {showFilterDropdown && (
                      <div className="absolute top-full left-0 mt-0.5 rounded-lg border shadow-lg z-50 overflow-hidden min-w-[150px]"
                        style={{ backgroundColor: '#1a1b26', borderColor: 'rgba(255,255,255,0.08)' }}>
                        <div className="flex items-center gap-1 px-2 py-1 border-b" style={{ borderColor: 'rgba(255,255,255,0.06)' }}>
                          <button onClick={() => { setLogFilter(filterOpts.map(o => o.value)); setShowFilterDropdown(false) }}
                            className="flex-1 px-1 py-0.5 text-[8px] font-semibold rounded cursor-pointer hover:bg-white/[0.04] transition-colors border-0"
                            style={{ color: 'rgba(255,255,255,0.5)' }}>
                            ✓ Tất cả
                          </button>
                          <button onClick={() => { setLogFilter([]); setShowFilterDropdown(false) }}
                            className="flex-1 px-1 py-0.5 text-[8px] font-semibold rounded cursor-pointer hover:bg-white/[0.04] transition-colors border-0"
                            style={{ color: 'rgba(255,255,255,0.3)' }}>
                            ✕ Bỏ
                          </button>
                        </div>
                        <div className="max-h-[200px] overflow-y-auto">
                          {filterOpts.map(o => {
                            const checked = logFilter.includes(o.value)
                            return (
                              <label key={o.value}
                                className="flex items-center gap-2 px-2 py-1 text-[9px] hover:bg-white/[0.04] transition-colors cursor-pointer"
                                style={{ color: 'rgba(255,255,255,0.6)' }}>
                                <input type="checkbox" checked={checked}
                                  onChange={() => {
                                    setLogFilter(prev => checked ? prev.filter(v => v !== o.value) : [...prev, o.value])
                                  }}
                                  className="w-2.5 h-2.5 rounded cursor-pointer accent-emerald-500" />
                                <span>{o.icon} {o.label}</span>
                                <span className="ml-auto text-[8px] font-mono" style={{ color: 'rgba(255,255,255,0.2)' }}>
                                  {logLevelCounts.counts[o.value] ?? 0}
                                </span>
                              </label>
                            )
                          })}
                        </div>
                      </div>
                    )}
                  </div>
                )
              })()}
              {logSearch && (
                <button onClick={() => setLogSearch('')}
                  className="px-1 py-0.5 text-[8px] rounded hover:bg-white/[0.04] transition-colors border-0 cursor-pointer"
                  style={{ color: 'rgba(255,255,255,0.3)' }}>✕</button>
              )}
              <span className="flex items-center gap-1 text-[9px] font-mono ml-auto" style={{ color: 'rgba(255,255,255,0.3)' }}>
                {(() => {
                  const total = logLevelCounts.total
                  const filtered = logSearch
                    ? displayLines.filter(l => l.toLowerCase().includes(logSearch.toLowerCase())).length
                    : logFilter.length > 0
                      ? logFilter.reduce((sum, level) => sum + (logLevelCounts.counts[level] || 0), 0)
                      : total
                  return (
                    <>
                      <span style={{ color: filtered < total ? '#fbbf24' : 'rgba(255,255,255,0.4)' }}>{filtered}</span>
                      <span style={{ color: 'rgba(255,255,255,0.15)' }}>/</span>
                      <span>{total}</span>
                    </>
                  )
                })()}
              </span>
            </div>
            {displayLines.length > 0 && (() => {
              const { counts, total } = logLevelCounts
              const order = ['error', 'warn', 'success', 'build', 'tunnel', 'metrics', 'cleanup', 'debug', 'info']
              const colors: Record<string, string> = {
                error: '#f87171', warn: '#fbbf24', success: '#4ade80', build: '#60a5fa',
                tunnel: '#60a5fa', metrics: '#a78bfa', cleanup: '#f472b6', debug: '#94a3b8', info: 'rgba(255,255,255,0.08)'
              }
              return (
                <div className="flex h-0.5">
                  {order.map(key => {
                    const c = counts[key]
                    if (!c || c === 0) return null
                    const pct = (c / total) * 100
                    return (
                      <div key={key}
                        onClick={() => {
                          setLogFilter(prev => prev.includes(key) ? prev.filter(v => v !== key) : [...prev, key])
                          setClickedSegment(key)
                          setTimeout(() => setClickedSegment(null), 400)
                        }}
                        className={`cursor-pointer transition-all duration-200 ${
                          logFilter.includes(key) ? 'opacity-100' : 'opacity-60 hover:opacity-90'
                        } ${clickedSegment === key ? 'animate-glow-pulse' : ''}`}
                        style={{
                          width: `${pct}%`,
                          backgroundColor: colors[key],
                          boxShadow: logFilter.includes(key) ? `0 0 4px ${colors[key]}60` : 'none',
                        }}
                        title={`${key}: ${c} dòng (${pct.toFixed(1)}%)`} />
                    )
                  })}
                </div>
              )
            })()}
          </div>
          <div className="flex-1 overflow-y-auto terminal-body p-1" style={{ fontSize: '12px', lineHeight: '1.6' }}>
            {displayLines.length === 0 ? (
              <div className="flex items-center justify-center h-full">
                <div className="text-center">
                  <div className="text-lg" style={{ color: 'rgba(255,255,255,0.08)' }}>
                    <svg className="w-10 h-10 mx-auto" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M14.25 9.75L16.5 12l-2.25 2.25m-4.5 0L7.5 12l2.25-2.25M6 20.25h12A2.25 2.25 0 0020.25 18V6A2.25 2.25 0 0018 3.75H6A2.25 2.25 0 003.75 6v12A2.25 2.25 0 006 20.25z" />
                    </svg>
                  </div>
                  <p className="mt-2 text-xs" style={{ color: 'rgba(255,255,255,0.2)' }}>
                    <span className="animate-terminal-blink">_</span> Chưa có log. Hãy khởi động máy chủ.
                  </p>
                </div>
              </div>
            ) : (
              (() => {
                const filtered = logSearch
                  ? displayLines.filter(l => l.toLowerCase().includes(logSearch.toLowerCase()))
                  : displayLines
                const currentFilter = logFilterRef.current
                const levelFiltered = currentFilter.length === 0
                  ? filtered
                  : filtered.filter(l => {
                      const level = detectLevel(l) || 'info'
                      return currentFilter.includes(level)
                    })
                if (levelFiltered.length === 0) {
                  return (
                    <div className="flex items-center justify-center h-full">
                      <p className="text-xs italic" style={{ color: 'var(--fg-dim)' }}>Không có log phù hợp với bộ lọc</p>
                    </div>
                  )
                }
                return (
                  <>
                    <div className="sticky top-0 z-10 flex items-center gap-3 px-2 py-1 text-[8px] font-medium border-b"
                      style={{ backgroundColor: '#0d1117', borderColor: 'rgba(255,255,255,0.04)', color: 'rgba(255,255,255,0.2)' }}>
                      <span className="w-8 text-right shrink-0">#</span>
                      <span className="w-10 shrink-0">Thời gian</span>
                      <span className="w-14 shrink-0">Cấp độ</span>
                      <span className="flex-1">Nội dung</span>
                    </div>
                    {levelFiltered.map((line, i) => {
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
                      const style = getLineStyle(line, i, logColors)
                      const mergedColors = { ...DEFAULT_LOG_COLORS, ...logColors }
                      const level = detectLevel(line)
                      const levelLabel = level && level !== 'defaultText' ? (() => {
                        const labels: Record<string, string> = { error: '❌ LỖI', warn: '⚠️ CẢNH BÁO', success: '✅ OK', build: '🔧 BUILD', tunnel: '🌐 TUNNEL', metrics: '📊 SỐ LIỆU', cleanup: '🧹 DỌN', debug: '🔍 DEBUG' }
                        return { text: labels[level] || level.toUpperCase(), color: mergedColors[level] || '#94a3b8' }
                      })() : null

                      return (
                        <div key={i}
                          className="flex items-start gap-1 px-2 py-0.5 hover:bg-white/[0.03] transition-colors group"
                          style={{ backgroundColor: style.backgroundColor }}>
                          <span className="select-none shrink-0 text-right font-mono"
                            style={{ color: 'rgba(255,255,255,0.15)', width: '2rem', fontSize: '10px', lineHeight: '1.6rem' }}>
                            {i + 1}
                          </span>
                          {timestamp && (
                            <span className="select-none shrink-0 font-mono text-[10px]"
                              style={{ color: 'rgba(255,255,255,0.15)', lineHeight: '1.6rem' }}>
                              {timestamp.slice(11)}
                            </span>
                          )}
                          {levelLabel && (
                            <span
                              onClick={() => setLogFilter(prev => {
                                const levelKey = level || 'info'
                                return prev.includes(levelKey) ? prev.filter(v => v !== levelKey) : [...prev, levelKey]
                              })}
                              className="shrink-0 text-[8px] font-bold px-1 py-0.5 rounded cursor-pointer transition-all duration-150 hover:scale-105 active:scale-95"
                              style={{
                                color: levelLabel.color,
                                backgroundColor: logFilter.includes(level || 'info') ? hexToRgba(levelLabel.color, 0.25) : hexToRgba(levelLabel.color, 0.1),
                                outline: logFilter.includes(level || 'info') ? `1px solid ${hexToRgba(levelLabel.color, 0.3)}` : 'none',
                                lineHeight: '1.3rem',
                                marginTop: '0.15rem'
                              }}
                              title={`Lọc: ${levelLabel.text}`}>
                              {levelLabel.text}
                            </span>
                          )}
                          <span className="whitespace-pre-wrap break-all flex-1 font-mono text-[12px]"
                            style={{
                              color: style.color || '#e6edf3',
                              borderLeft: style.borderLeft,
                              paddingLeft: style.paddingLeft || '2px',
                              lineHeight: '1.6rem'
                            }}
                            dangerouslySetInnerHTML={{ __html: html }} />
                        </div>
                      )
                    })}
                  </>
                )
              })()
            )}
            <div ref={logEndRef} />
          </div>
        </div>
      </div>

      {/* Env Editor Modal */}
      {envEditingProject && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
          onClick={e => { if (e.target === e.currentTarget) setEnvEditingProject(null) }}>
          <div className="w-full max-w-lg rounded-2xl border shadow-2xl p-6 transition-colors flex flex-col"
            style={{ backgroundColor: 'var(--bg)', borderColor: 'var(--border)', color: 'var(--fg)' }}>
            <div className="flex items-center justify-between pb-4 border-b" style={{ borderColor: 'var(--border)' }}>
              <div>
                <label htmlFor="env-editor" className="text-sm font-semibold cursor-pointer">Biến môi trường</label>
                <p className="text-xs font-mono text-gray-500">{envEditingProject} › {envFileName}</p>
              </div>
              <button onClick={() => setEnvEditingProject(null)}
                className="p-1 rounded-lg hover:bg-black/10 dark:hover:bg-white/10 transition-colors cursor-pointer border-0"
                style={{ color: 'var(--fg-muted)' }}>&times;</button>
            </div>
            <textarea id="env-editor" name="envContent" value={envContent} onChange={e => setEnvContent(e.target.value)} rows={12}
              className="w-full border rounded-lg px-3 py-2 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-emerald-500 mt-4"
              style={{ backgroundColor: 'var(--input-bg)', borderColor: 'var(--input-border)', color: 'var(--fg)' }}
              placeholder="# PORT=4000\n# DATABASE_URL=..." />
            <div className="mt-6 flex justify-end gap-2">
              <button onClick={() => setEnvEditingProject(null)}
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

    </div>
  )
}
