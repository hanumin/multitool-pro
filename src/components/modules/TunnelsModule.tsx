import { useState, useEffect, useRef, useCallback, useMemo, memo } from 'react'

import { API, fetchWithRetry } from '../../utils/apiFetch'
import { useToast } from '../../components/ToastManager'
import type { PreloadedData } from '../../types'

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
  uptime_seconds?: number | null
  request_count?: number
  request_rate?: number | null
  request_history?: { t: number; c: number }[]
  endpoint_counts?: Record<string, number>
  alert_threshold?: number
}

interface HistoryEntry {
  timestamp: number
  request_count: number
  request_rate: number
  status: string
}

// WHY: History chart component — vẽ biểu đồ request rate từ lịch sử (giờ/ngày/tuần).
// Format timestamp thành giờ:phút hoặc ngày/tháng tùy theo range.
const HistoryChart = memo(function HistoryChart({ history, range }: { history: HistoryEntry[]; range: string }) {
  if (history.length < 2) return (
    <div className="flex items-center justify-center h-32 text-xs" style={{ color: 'var(--fg-dim)' }}>
      Chưa có đủ dữ liệu lịch sử.
    </div>
  )
  
  const w = 600, h = 160, pad = { top: 16, right: 16, bottom: 24, left: 40 }
  const cw = w - pad.left - pad.right
  const ch = h - pad.top - pad.bottom
  
  // WHY: Tính rate từ entry (dùng request_rate có sẵn hoặc tính từ count diff)
  const values = history.map(e => e.request_rate)
  const maxVal = Math.max(...values, 0.01)
  const minVal = 0
  const rangeVal = Math.max(maxVal - minVal, 0.01)
  
  // WHY: Tính points cho polyline
  const stepX = cw / Math.max(history.length - 1, 1)
  const points = history.map((e, i) => {
    const x = pad.left + i * stepX
    const y = pad.top + ch - ((e.request_rate - minVal) / rangeVal) * ch
    return `${x},${y}`
  }).join(' ')
  
  // WHY: Format timestamp dựa trên range
  const fmtTime = (ts: number) => {
    const d = new Date(ts * 1000)
    if (range === '24h') {
      return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
    }
    return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`
  }
  
  // WHY: Tạo labels cho trục X (lấy sample theo độ dài)
  const labelCount = Math.min(history.length, 8)
  const labelStep = Math.max(1, Math.floor(history.length / labelCount))
  const labels: { x: number; label: string }[] = []
  for (let i = 0; i < history.length; i += labelStep) {
    labels.push({ x: pad.left + i * stepX, label: fmtTime(history[i].timestamp) })
  }
  // WHY: Luôn thêm label cuối cùng
  if (labels.length === 0 || labels[labels.length - 1].x < pad.left + (history.length - 1) * stepX) {
    labels.push({ x: pad.left + (history.length - 1) * stepX, label: fmtTime(history[history.length - 1].timestamp) })
  }
  
  // WHY: Y-axis labels (5 mức)
  const yLabels = [0, 1, 2, 3, 4].map(i => (maxVal / 4) * i)
  
  // WHY: Area points dưới line
  const firstX = pad.left
  const lastX = pad.left + (history.length - 1) * stepX
  const bottomY = pad.top + ch
  const areaPoints = `${firstX},${bottomY} ${points} ${lastX},${bottomY}`

  // ─── Tooltip state & handlers ───────────────────────────────
  const svgRef = useRef<SVGSVGElement>(null)
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null)

  const handleMouseMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const svg = svgRef.current
    if (!svg) return
    const rect = svg.getBoundingClientRect()
    const scaleX = w / rect.width
    const svgX = (e.clientX - rect.left) * scaleX

    let closest = 0
    let minDist = Infinity
    for (let i = 0; i < history.length; i++) {
      const dx = Math.abs(pad.left + i * stepX - svgX)
      if (dx < minDist) { minDist = dx; closest = i }
    }
    setHoveredIdx(closest)
  }
  const handleMouseLeave = () => setHoveredIdx(null)

  return (
    <svg
      ref={svgRef}
      width="100%" height={h} viewBox={`0 0 ${w} ${h}`}
      className="w-full cursor-crosshair select-none"
      style={{ overflow: 'visible' }}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
    >
      {/* WHY: Transparent hit-area rect to eliminate dead zones */}
      <rect width="100%" height="100%" fill="transparent" />
      {/* Y-axis grid lines + labels */}
      {yLabels.map((v, i) => {
        const y = pad.top + ch - ((v - minVal) / rangeVal) * ch
        return (
          <g key={i}>
            <line x1={pad.left} y1={y} x2={w - pad.right} y2={y} stroke="currentColor" strokeOpacity={0.06} strokeWidth={0.5} />
            <text x={pad.left - 4} y={y + 3} textAnchor="end" className="text-[8px]" fill="currentColor" fillOpacity={0.3}>
              {v.toFixed(2)}
            </text>
          </g>
        )
      })}
      {/* Area fill */}
      <polygon points={areaPoints} fill="#22c55e" fillOpacity={0.06} />
      {/* Line */}
      <polyline points={points} fill="none" stroke="#22c55e" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
      {/* X-axis labels */}
      {labels.map((l, i) => (
        <text key={i} x={l.x} y={h - 4} textAnchor="middle" className="text-[8px]" fill="currentColor" fillOpacity={0.3}>
          {l.label}
        </text>
      ))}

      {/* ─── Interactive Tooltip ──────────────────────────── */}
      {hoveredIdx !== null && (() => {
        const entry = history[hoveredIdx]
        const x = pad.left + hoveredIdx * stepX
        const y = pad.top + ch - ((entry.request_rate - minVal) / rangeVal) * ch

        // WHY: Tooltip box position — ưu tiên bên phải, nếu tràn thì sang trái
        const tooltipW = 140
        const tooltipH = 70
        let tx = x + 12
        let ty = y - tooltipH - 8
        if (tx + tooltipW > w - pad.right) tx = x - tooltipW - 12
        if (ty < 0) ty = y + 12

        return (
          <g className="chart-tooltip-group" style={{ pointerEvents: 'none' }}>
            {/* Vertical crosshair line */}
            <line x1={x} y1={pad.top} x2={x} y2={pad.top + ch} stroke="#22c55e" strokeWidth={1} strokeDasharray="3,3" strokeOpacity={0.5} />
            {/* Horizontal crosshair line */}
            <line x1={pad.left} y1={y} x2={w - pad.right} y2={y} stroke="#22c55e" strokeWidth={0.5} strokeDasharray="2,2" strokeOpacity={0.3} />
            {/* Dot on the line */}
            <circle cx={x} cy={y} r={4} fill="#22c55e" stroke="#0a0a0a" strokeWidth={2} />
            <circle cx={x} cy={y} r={7} fill="transparent" stroke="#22c55e" strokeWidth={2} strokeOpacity={0.35} />
            {/* Tooltip box via foreignObject */}
            <foreignObject x={tx} y={ty} width={tooltipW} height={tooltipH}>
              <div style={{
                background: 'rgba(10, 10, 10, 0.92)',
                border: '1px solid rgba(34, 197, 94, 0.3)',
                borderRadius: '6px',
                padding: '6px 10px',
                fontFamily: '"JetBrains Mono", "Fira Code", monospace',
                fontSize: '11px',
                lineHeight: '1.5',
                color: '#e0e0e0',
                backdropFilter: 'blur(8px)',
                boxShadow: '0 4px 16px rgba(0,0,0,0.4), 0 0 0 1px rgba(34,197,94,0.08)',
              }}>
                <div style={{ fontSize: '10px', color: '#22c55e', fontWeight: 600, marginBottom: 2 }}>
                  {fmtTime(entry.timestamp)}
                </div>
                <div style={{ color: '#ccc' }}>
                  Rate: <span style={{ color: '#22c55e' }}>{entry.request_rate.toFixed(2)}</span> req/s
                </div>
                <div style={{ color: '#ccc' }}>
                  Count: <span style={{ color: '#fff' }}>{entry.request_count.toLocaleString()}</span>
                </div>
                <div style={{ color: '#888', fontSize: '9px', marginTop: 1 }}>
                  {entry.status}
                </div>
              </div>
            </foreignObject>
          </g>
        )
      })()}
    </svg>
  )
})

// WHY: Sparkline chart — vẽ biểu đồ request rate mini bằng SVG.
// Tính rate từ diff giữa các snapshot, vẽ dạng đường polyline.
const SparklineChart = memo(function SparklineChart({ history, color = '#22c55e' }: { history: { t: number; c: number }[]; color?: string }) {
  if (history.length < 2) return null
  
  // WHY: Tính request rate (requests/giây) giữa các snapshot
  const rates: number[] = []
  for (let i = 1; i < history.length; i++) {
    const dt = history[i].t - history[i - 1].t
    const dc = history[i].c - history[i - 1].c
    rates.push(dt > 0 ? dc / dt : 0)
  }
  
  if (rates.length < 2) return null
  
  const w = 60, h = 24
  const maxRate = Math.max(...rates, 0.1)
  const minRate = Math.min(...rates, 0)
  const range = Math.max(maxRate - minRate, 0.1)
  
  // WHY: Tính points cho SVG polyline
  const stepX = w / (rates.length - 1)
  const points = rates.map((r, i) => {
    const x = i * stepX
    const y = h - ((r - minRate) / range) * (h - 2) - 1
    return `${x},${y}`
  }).join(' ')
  
  // WHY: Vẽ area fill dưới đường line
  const areaPoints = `0,${h} ${points} ${w},${h}`
  
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="shrink-0">
      {/* Grid lines */}
      <line x1={0} y1={h/2} x2={w} y2={h/2} stroke="currentColor" strokeOpacity={0.05} strokeWidth={0.5} />
      {/* Area fill */}
      <polygon points={areaPoints} fill={color} fillOpacity={0.08} />
      {/* Line */}
      <polyline points={points} fill="none" stroke={color} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
})

// WHY: Format seconds thành human-readable: 45s, 2m 34s, 1h 23m, 3d 5h
function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  if (m < 60) return s > 0 ? `${m}m ${s}s` : `${m}m`
  const h = Math.floor(m / 60)
  const rm = m % 60
  if (h < 24) return rm > 0 ? `${h}h ${rm}m` : `${h}h`
  const d = Math.floor(h / 24)
  const rh = h % 24
  return rh > 0 ? `${d}d ${rh}h` : `${d}d`
}

interface CloudflaredInfo {
  installed: boolean
  version: string | null
  path: string | null
}

interface TunnelsModuleProps {
  theme: 'dark' | 'light'
  setStatusText: (t: string) => void
  inactive?: boolean
  backgroundPolling?: boolean
  onBackgroundPollingChange?: (enabled: boolean) => void
  preloadedData?: PreloadedData
}

// WHY: Tunnel Dashboard tab — bang quan ly tat ca tunnels.
// Hien thi cloudflared status, tunnel status, URL, watchdog.
// Batch actions: Start all / Stop all.
export default function TunnelsModule({ theme, setStatusText, inactive, backgroundPolling, onBackgroundPollingChange, preloadedData }: TunnelsModuleProps) {
  const { addToast } = useToast()
  // WHY: Dùng preloadedData từ LoadingScreen để skip initial loading
  const preloadedProjs = preloadedData?.projects
  const preloadedCf = preloadedData?.cloudflared
  const hasPreload = !!(preloadedProjs || preloadedCf)
  const [projects, setProjects] = useState<Project[]>(preloadedProjs || [])
  const [tunnelStates, setTunnelStates] = useState<Record<string, TunnelState>>({})
  const [tunnelLoading, setTunnelLoading] = useState<Record<string, boolean>>({})
  const [watchdogToggling, setWatchdogToggling] = useState<Record<string, boolean>>({})
  const [batchTunnelLoading, setBatchTunnelLoading] = useState(false)
  const [cloudflaredInfo, setCloudflaredInfo] = useState<CloudflaredInfo | null>(preloadedCf || null)
  const [installingCloudflared, setInstallingCloudflared] = useState(false)
  const [initialLoading, setInitialLoading] = useState(!hasPreload)
  const [searchQuery, setSearchQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<string>('all')
  const [showStopped, setShowStopped] = useState(true)
  const prevTunnelUrlsRef = useRef<Record<string, string>>({})
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [importing, setImporting] = useState(false)
  const [exportMetricsOpen, setExportMetricsOpen] = useState(false)
  // WHY: Endpoint stats popover — project đang xem endpoint counts, null = đóng
  const [endpointOpen, setEndpointOpen] = useState<string | null>(null)
  // WHY: History modal state — project đang xem history, null = đóng
  const [historyProject, setHistoryProject] = useState<string | null>(null)
  const [historyRange, setHistoryRange] = useState<string>('24h')
  const [historyData, setHistoryData] = useState<HistoryEntry[]>([])
  const [historyLoading, setHistoryLoading] = useState(false)
  // WHY: Local alert thresholds — controlled input để không bị reset khi polling
  const [alertThresholds, setAlertThresholds] = useState<Record<string, number>>({})
  // WHY: Sort config cho cột Yêu cầu— key + direction, null = không sort
  const [sortConfig, setSortConfig] = useState<{ key: 'request_count' | 'request_rate'; direction: 'asc' | 'desc' } | null>(null)
  // WHY: Theme override — null = follow global, 'dark' | 'light' = force specific theme
  const [themeOverride, setThemeOverride] = useState<string | null>(null)
  // WHY: Compute effective theme từ override hoặc global theme prop
  const effectiveTheme = themeOverride || theme

  // WHY: Light/dark CSS variable values cho container override
  const themeVars = useMemo(() => effectiveTheme === 'light' ? {
    '--bg': '#ffffff',
    '--fg': '#0f172a',
    '--fg-secondary': '#1e293b',
    '--fg-dim': '#64748b',
    '--fg-muted': '#94a3b8',
    '--bg-card': '#f8fafc',
    '--bg-log': '#ffffff',
    '--input-bg': '#f1f5f9',
    '--border': 'rgba(0,0,0,0.08)',
  } : {
    '--bg': '#0f172a',
    '--fg': '#e2e8f0',
    '--fg-secondary': '#cbd5e1',
    '--fg-dim': '#94a3b8',
    '--fg-muted': '#64748b',
    '--bg-card': '#1e293b',
    '--bg-log': '#0f172a',
    '--input-bg': '#1e293b',
    '--border': 'rgba(255,255,255,0.08)',
  }, [effectiveTheme])
  // WHY: Dùng Record<string,string> thay vì React.CSSProperties để hỗ trợ custom CSS vars
  const themeVarsStyle = themeOverride ? themeVars as Record<string, string> : {}

  // WHY: Dùng refs để tránh stale closure trong batch functions (startAll/stopAll)
  // và fetchAll cần biết projects + tunnelStates mới nhất.
  const projectsRef = useRef(projects)
  projectsRef.current = projects
  const tunnelStatesRef = useRef(tunnelStates)
  tunnelStatesRef.current = tunnelStates

  // WHY: Fetch cloudflared status + tất cả projects + tunnel statuses (parallel).
  // Dùng Promise.all để fetch tunnel của tất cả projects cùng lúc (không tuần tự).
  const fetchAll = useCallback(async () => {
    try {
      const [cfRes, projRes] = await Promise.all([
        fetchWithRetry(`${API}/api/cloudflared/check`),
        fetchWithRetry(`${API}/api/projects`)
      ])
      if (cfRes.ok) setCloudflaredInfo(await cfRes.json())
      if (projRes.ok) {
        const projData: Project[] = await projRes.json()
        setProjects(projData)
        setInitialLoading(false)
        // WHY: Fetch tất cả tunnel statuses song song bằng Promise.all
        const results = await Promise.all(
          projData.map(p =>
            fetchWithRetry(`${API}/api/projects/${encodeURIComponent(p.name)}/tunnel`)
              .then(r => r.ok ? r.json() : null)
              .catch(() => null)
          )
        )
        // WHY: Merge tất cả tunnel states một lần, tránh re-render từng cái
        const merged: Record<string, TunnelState> = {}
        projData.forEach((p, i) => {
          if (results[i]) merged[p.name] = results[i]
        })
        setTunnelStates(prev => ({ ...prev, ...merged }))
      }
    } catch {}
  }, [])

  // WHY: Polling tunnel — chỉ chạy khi module active. Khi inactive: clear interval.
  useEffect(() => {
    if (inactive && !backgroundPolling) return
    fetchAll()
    const interval = setInterval(fetchAll, 4000)
    return () => clearInterval(interval)
  }, [fetchAll, inactive, backgroundPolling])

  // WHY: Lightweight polling — phát hiện thay đổi project config.
  // Chỉ chạy khi module active. Khi inactive: clear interval.
  useEffect(() => {
    if (inactive && !backgroundPolling) return
    let prevVersion = -1
    const interval = setInterval(async () => {
      try {
        const res = await fetchWithRetry(`${API}/api/tunnels/changes`)
        if (res.ok) {
          const data = await res.json()
          if (prevVersion !== -1 && data.version !== prevVersion) {
            fetchAll()
          }
          prevVersion = data.version
        }
      } catch {}
    }, 2000)
    return () => clearInterval(interval)
  }, [fetchAll, inactive, backgroundPolling])

  // WHY: Refetch history data khi range thay đổi hoặc modal mở với project mới
  useEffect(() => {
    if (!historyProject) return
    const fetchHistory = async () => {
      setHistoryLoading(true)
      try {
        const res = await fetchWithRetry(`${API}/api/tunnels/history?project=${encodeURIComponent(historyProject)}&range=${historyRange}`)
        if (res.ok) {
          const data = await res.json()
          setHistoryData(data.history || [])
        }
      } catch {}
      finally { setHistoryLoading(false) }
    }
    fetchHistory()
  }, [historyProject, historyRange])

  // WHY: Auto-copy URL khi tunnel mới active (giống ServersModule pattern)
  useEffect(() => {
    for (const [name, state] of Object.entries(tunnelStates)) {
      if (state?.status === 'active' && state?.url && prevTunnelUrlsRef.current[name] !== state.url) {
        prevTunnelUrlsRef.current[name] = state.url
        navigator.clipboard.writeText(state.url).then(() => {
          setStatusText(`📋 Đã tự động copy URL: ${state.url}`)
        }).catch(() => {})
      }
    }
  }, [tunnelStates, setStatusText])

  // WHY: Goi API start tunnel + cap nhat state tu response.
  // Hien thi status text (thanh cong / that bai).
  const startTunnel = useCallback(async (name: string) => {
    setTunnelLoading(l => ({ ...l, [name]: true }))
    try {
      const res = await fetchWithRetry(`${API}/api/projects/${encodeURIComponent(name)}/tunnel/start`, { method: 'POST' })
      const data = await res.json()
      if (res.ok) {
        setTunnelStates(prev => ({ ...prev, [name]: data }))
        setStatusText(`🌐 Đã mở tunnel cho ${name}`)
        addToast({ type: 'success', title: `🌐 ${name}`, message: 'Tunnel đã được mở thành công' })
      } else {
        setStatusText(`❌ ${data.error || 'Thất bại'}`)
        addToast({ type: 'error', title: `🌐 ${name}`, message: data.error || 'Mở tunnel thất bại' })
      }
    } catch {
      setStatusText('Mở tunnel thất bại')
      addToast({ type: 'error', title: '🔌 Mất kết nối', message: 'Không thể kết nối tới backend' })
    }
    finally { setTunnelLoading(l => ({ ...l, [name]: false })) }
  }, [setStatusText, addToast])

  // WHY: Goi API stop tunnel + fetch status ngay de dong bo UI.
  // Tuong tu ServersModule stopTunnel pattern.
  const stopTunnel = useCallback(async (name: string) => {
    setTunnelLoading(l => ({ ...l, [name]: true }))
    try {
      const res = await fetchWithRetry(`${API}/api/projects/${encodeURIComponent(name)}/tunnel/stop`, { method: 'POST' })
      if (res.ok) {
        const statusRes = await fetchWithRetry(`${API}/api/projects/${encodeURIComponent(name)}/tunnel`)
        if (statusRes.ok) {
          const data = await statusRes.json()
          setTunnelStates(prev => ({ ...prev, [name]: data }))
        }
        setStatusText(`Đã dừng tunnel cho ${name}`)
        addToast({ type: 'info', title: `🌐 ${name}`, message: 'Tunnel đã đóng' })
      }
    } catch {
      setStatusText('Dừng tunnel thất bại')
      addToast({ type: 'error', title: `🌐 ${name}`, message: 'Dừng tunnel thất bại' })
    }
    finally { setTunnelLoading(l => ({ ...l, [name]: false })) }
  }, [setStatusText, addToast])

  // WHY: Toggle watchdog — POST API + update local state ngay.
  // Kiem tra prev[name] ton tai truoc khi merge de tranh undefined.
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
          ...prev, [name]: { ...prev[name], watchdog_enabled: data.watchdog_enabled }
        } : prev)
        setStatusText(enabled ? '🛡️ Watchdog bật' : 'Watchdog tắt')
        addToast({ type: 'info', title: `🛡️ ${name}`, message: enabled ? 'Watchdog đã được bật' : 'Watchdog đã tắt' })
      }
    } catch { setStatusText('Lỗi khi thay đổi watchdog'); addToast({ type: 'error', title: `🛡️ ${name}`, message: 'Thay đổi watchdog thất bại' }) }
    finally { setWatchdogToggling(w => ({ ...w, [name]: false })) }
  }, [setStatusText, addToast])

  // WHY: Install cloudflared — POST install API + refresh cloudflaredInfo.
  // Hien thi progress text (dang tai / thanh cong / that bai).
  const installCloudflared = useCallback(async () => {
    setInstallingCloudflared(true)
    try {
      const res = await fetchWithRetry(`${API}/api/cloudflared/install`, { method: 'POST' })
      if (res.ok) {
        setStatusText('✅ Đã cài cloudflared!')
        addToast({ type: 'success', title: '🌐 cloudflared', message: 'Đã cài cloudflared thành công' })
        const cfRes = await fetchWithRetry(`${API}/api/cloudflared/check`)
        if (cfRes.ok) setCloudflaredInfo(await cfRes.json())
      } else {
        const data = await res.json()
        setStatusText(`❌ ${data.error}`)
        addToast({ type: 'error', title: '🌐 cloudflared', message: data.error || 'Cài đặt thất bại' })
      }
    } catch { setStatusText('❌ Lỗi kết nối'); addToast({ type: 'error', title: '🌐 cloudflared', message: 'Lỗi kết nối khi cài cloudflared' }) }
    finally { setInstallingCloudflared(false) }
  }, [setStatusText, addToast])

  // WHY: 1-click: cai cloudflared + start tunnel + bat watchdog.
  // Refresh cloudflaredInfo trong finally de cap nhat UI.
  const installAndStart = useCallback(async (name: string) => {
    setTunnelLoading(l => ({ ...l, [name]: true }))
    setStatusText('📥 Đang tải cloudflared...')
    try {
      const res = await fetchWithRetry(`${API}/api/projects/${encodeURIComponent(name)}/tunnel/install-and-start`, { method: 'POST' })
      const data = await res.json()
      if (res.ok) {
        setTunnelStates(prev => ({ ...prev, [name]: data }))
        setStatusText('🌐 Đã mở tunnel!')
        addToast({ type: 'success', title: `🌐 ${name}`, message: 'Tunnel đã được cài và mở thành công' })
      } else {
        setStatusText(`❌ ${data.error || 'Thất bại'}`)
        addToast({ type: 'error', title: `🌐 ${name}`, message: data.error || 'Cài & mở tunnel thất bại' })
      }
    } catch { setStatusText('❌ Connection failed'); addToast({ type: 'error', title: `🌐 ${name}`, message: 'Mất kết nối khi cài tunnel' }) }
    finally {
      setTunnelLoading(l => ({ ...l, [name]: false }))
      // WHY: Refresh cloudflaredInfo sau khi install thành công
      fetchWithRetry(`${API}/api/cloudflared/check`).then(r => r.ok && r.json()).then(d => d && setCloudflaredInfo(d)).catch(() => {})
    }
  }, [setStatusText, addToast])

  // WHY: Dùng refs (projectsRef, tunnelStatesRef) để tránh stale closure
  // khi batch functions đọc state không kịp update.
  const startAll = useCallback(async () => {
    setBatchTunnelLoading(true)
    let count = 0
    for (const p of projectsRef.current) {
      const ts = tunnelStatesRef.current[p.name]
      if (p.running && ts?.status !== 'active' && ts?.status !== 'connecting') {
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
    await fetchAll()
    setStatusText(`🌐 Đã bật ${count} tunnels`)
    setBatchTunnelLoading(false)
  }, [fetchAll, setStatusText])

  // WHY: Tương tự startAll, dùng refs để đọc trạng thái mới nhất.
  const stopAll = useCallback(async () => {
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
    await fetchAll()
    setStatusText(`Đã dừng ${count} tunnels`)
    setBatchTunnelLoading(false)
  }, [fetchAll, setStatusText])

  // WHY: Mo URL tunnel trong browser.
  // 2-layer fallback: Tauri shell.open > window.open.
  const openBrowser = useCallback(async (url: string) => {
    try {
      const { open } = await import('@tauri-apps/plugin-shell')
      await open(url); return
    } catch {}
    window.open(url, '_blank')
  }, [])

  const { activeTunnels, totalTunnels, totalRestarts } = useMemo(() => ({
    activeTunnels: Object.values(tunnelStates).filter(s => s?.status === 'active').length,
    totalTunnels: Object.keys(tunnelStates).length,
    totalRestarts: Object.values(tunnelStates).reduce((sum, s) => sum + (s?.watchdog_restart_count || 0), 0),
  }), [tunnelStates])

  // WHY: Filter projects dựa trên search query + status filter + showStopped
  const filteredProjects = useMemo(() => projects.filter(p => {
    // WHY: Search theo tên project và port
    if (searchQuery) {
      const q = searchQuery.toLowerCase()
      const matchesName = p.name.toLowerCase().includes(q)
      const matchesPort = String(p.port).includes(q)
      if (!matchesName && !matchesPort) return false
    }
    // WHY: Filter theo trạng thái tunnel
    if (statusFilter !== 'all') {
      const ts = tunnelStates[p.name]
      const status = ts?.status || 'stopped'
      if (status !== statusFilter) return false
    }
    // WHY: Toggle hiển thị project đã dừng
    if (!showStopped && !p.running) return false
    return true
  }), [projects, searchQuery, statusFilter, showStopped, tunnelStates])

  // WHY: Sort filtered projects dựa trên sortConfig
  // Cycle: request_count desc → request_count asc → request_rate desc → request_rate asc → null
  const cycleSort = useCallback(() => {
    setSortConfig(prev => {
      if (!prev) return { key: 'request_count', direction: 'desc' }
      if (prev.key === 'request_count' && prev.direction === 'desc') return { key: 'request_count', direction: 'asc' }
      if (prev.key === 'request_count' && prev.direction === 'asc') return { key: 'request_rate', direction: 'desc' }
      if (prev.key === 'request_rate' && prev.direction === 'desc') return { key: 'request_rate', direction: 'asc' }
      return null
    })
  }, [])
  
  // WHY: Sort helper — lấy value sort từ tunnel state, xử lý undefined/null về -1
  const getSortValue = useCallback((p: Project, key: 'request_count' | 'request_rate'): number => {
    const ts = tunnelStates[p.name]
    if (!ts) return -1
    const val = key === 'request_count' ? ts.request_count : ts.request_rate
    return val ?? -1
  }, [tunnelStates])
  
  // WHY: Sort mảng filteredProjects theo sortConfig (không đột biến mảng gốc)
  const sortedProjects = useMemo(() => sortConfig
    ? [...filteredProjects].sort((a, b) => {
        const va = getSortValue(a, sortConfig.key)
        const vb = getSortValue(b, sortConfig.key)
        return sortConfig.direction === 'desc' ? vb - va : va - vb
      })
    : filteredProjects, [filteredProjects, sortConfig, getSortValue])

  return (
    <div className="flex flex-col h-full p-4 gap-3 animate-header-in"
      style={inactive ? { ...themeVarsStyle, display: 'none' } : themeVarsStyle}>
      {/* Cloudflared Status + Stats Bar */}
      <div className="flex items-center justify-between shrink-0 animate-header-in" style={{ animationDelay: '0.05s' }}>
        <div className="flex items-center gap-3">
          {/* Background Polling Toggle */}
          {onBackgroundPollingChange && (
            <button onClick={() => onBackgroundPollingChange(!backgroundPolling)}
              className="flex items-center gap-1 px-2 py-1.5 text-[10px] font-medium rounded-lg border transition-all active:scale-95 cursor-pointer"
              style={{ backgroundColor: backgroundPolling ? 'rgba(52,211,153,0.1)' : 'var(--input-bg)', borderColor: 'var(--border)', color: backgroundPolling ? '#34d399' : 'var(--fg-muted)' }}>
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" />
              </svg>
              Nền: {backgroundPolling ? 'BẬT' : 'TẮT'}
            </button>
          )}
          {/* Cloudflared install status */}
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg border text-xs"
            style={{ backgroundColor: 'var(--input-bg)', borderColor: 'var(--border)' }}>
            <span>🌐 cloudflared</span>
            {cloudflaredInfo === null ? (
              <span className="text-xs" style={{ color: 'var(--fg-dim)' }}>Đang kiểm tra...</span>
            ) : cloudflaredInfo.installed ? (
              <>
                <span className="text-emerald-400 text-xs">✅ {cloudflaredInfo.version?.split(' ')[1] || 'Đã cài'}</span>
                <button onClick={installCloudflared} disabled={installingCloudflared}
                  className="text-xs underline underline-offset-2 bg-transparent border-0 cursor-pointer"
                  style={{ color: 'var(--fg-muted)' }}>
                  {installingCloudflared ? '...' : 'Cài lại'}
                </button>
              </>
            ) : (
              <>
                <span className="text-red-400 text-xs">❌ Chưa cài</span>
                <button onClick={installCloudflared} disabled={installingCloudflared}
                  className="px-2 py-0.5 text-xs font-semibold rounded bg-emerald-500/15 text-emerald-400 hover:bg-emerald-500/25 border-0 cursor-pointer transition-all">
                  {installingCloudflared ? 'Đang tải...' : '📥 Cài ngay'}
                </button>
              </>
            )}
          </div>
          {/* Stats */}
          <div className="flex items-center gap-2 text-xs" style={{ color: 'var(--fg-dim)' }}>
            <span style={{ color: activeTunnels > 0 ? '#34d399' : 'inherit' }}>
              🌐 {activeTunnels}/{totalTunnels} active
            </span>
            {totalRestarts > 0 && (
              <span className="font-mono text-xs" style={{ color: '#fbbf24' }}>
                🔄 {totalRestarts} restarts
              </span>
            )}
          </div>
        </div>
        {/* Filter bar */}
        <div className="flex items-center gap-2">
          {/* Search input */}
          <div className="relative flex items-center">
            <svg className="absolute left-2 w-3 h-3" style={{ color: 'var(--fg-muted)' }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
            <input type="text" value={searchQuery} onChange={e => setSearchQuery(e.target.value)}
              placeholder="Tìm tunnel..."
              className="w-32 pl-6 pr-2 py-1 text-xs rounded-lg border transition-all focus:outline-none focus:w-44"
              style={{
                backgroundColor: 'var(--input-bg)', borderColor: searchQuery ? 'rgba(59,130,246,0.4)' : 'var(--border)',
                color: 'var(--fg)'
              }} />
            {searchQuery && (
              <button onClick={() => setSearchQuery('')}
                className="absolute right-1 p-0.5 rounded hover:bg-black/10 dark:hover:bg-white/10 border-0 cursor-pointer"
                style={{ color: 'var(--fg-muted)' }}>
                <svg className="w-2.5 h-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            )}
          </div>
          {/* Status filter pills */}
          {[
            { id: 'all', label: 'Tất cả' },
            { id: 'active', label: '🟢 Hoạt động' },
            { id: 'connecting', label: '🟡 Đang kết nối' },
            { id: 'error', label: '🔴 Lỗi' },
          ].map(f => (
            <button key={f.id} onClick={() => setStatusFilter(f.id)}
              className={`px-2 py-1 text-[10px] font-semibold rounded-lg transition-all cursor-pointer border-0 ${
                statusFilter === f.id
                  ? 'bg-white/10 text-white ring-1 ring-white/20'
                  : 'hover:bg-white/5'
              }`}
              style={{
                color: statusFilter === f.id ? 'var(--fg)' : 'var(--fg-dim)',
                backgroundColor: statusFilter === f.id ? 'var(--input-bg)' : 'transparent'
              }}>
              {f.label}
            </button>
          ))}
          {/* Divider */}
          <div className="w-px h-4" style={{ backgroundColor: 'var(--border)' }} />
          {/* Show stopped toggle */}
          <label className="flex items-center gap-1.5 cursor-pointer" title={showStopped ? 'Hiện tất cả project' : 'Ẩn project đã dừng'}>
            <input type="checkbox" checked={showStopped} onChange={e => setShowStopped(e.target.checked)}
              className="sr-only peer" />
            <div className="w-5 h-3 rounded-full peer peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-[1px] after:left-[1px] after:bg-white after:rounded-full after:h-2.5 after:w-2.5 after:transition-all peer-checked:bg-blue-500/60 bg-gray-600/40 relative" />
            <span className="text-[10px]" style={{ color: showStopped ? 'var(--fg-secondary)' : 'var(--fg-dim)' }}>
              {showStopped ? 'Tất cả' : 'Đang chạy'}
            </span>
          </label>
        </div>
        {/* Batch actions */}
        <div className="flex items-center gap-2">
          <button onClick={startAll} disabled={batchTunnelLoading}
            className="px-2.5 py-1.5 text-xs font-semibold rounded-lg transition-all cursor-pointer disabled:opacity-30 active:scale-95 bg-sky-500/15 text-sky-400 hover:bg-sky-500/25 ring-1 ring-sky-500/20 border-0 flex items-center gap-1">
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
            </svg>
            Bật tất cả
          </button>
          <button onClick={stopAll} disabled={batchTunnelLoading}
            className="px-2.5 py-1.5 text-xs font-semibold rounded-lg transition-all cursor-pointer disabled:opacity-30 active:scale-95 bg-red-500/10 text-red-400 hover:bg-red-500/20 ring-1 ring-red-500/15 border-0 flex items-center gap-1">
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
            Tắt tất cả
          </button>
          {batchTunnelLoading && (
            <div className="animate-spin rounded-full h-3 w-3 border-b border-sky-500" />
          )}
          {/* Theme toggle */}
          <button onClick={() => {
            // WHY: Cycle: null → 'dark' → 'light' → null (follow global)
            setThemeOverride(prev => prev === null ? 'dark' : prev === 'dark' ? 'light' : null)
          }}
            className="px-2 py-1 text-[10px] font-semibold rounded border transition-all active:scale-95 cursor-pointer hover:bg-white/5 flex items-center gap-1"
            style={{ backgroundColor: 'var(--input-bg)', borderColor: 'var(--border)', color: 'var(--fg-secondary)' }}
            title={themeOverride === null ? 'Theme theo hệ thống' : `Theme: ${themeOverride === 'dark' ? 'Tối' : 'Sáng'}`}>
            {themeOverride === null ? (
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
              </svg>
            ) : themeOverride === 'dark' ? (
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" />
              </svg>
            ) : (
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z" />
              </svg>
            )}
            {themeOverride !== null && (
              <span className="text-[8px] font-mono" style={{ color: 'var(--fg-dim)' }}>
                {themeOverride === 'dark' ? 'TỐI' : 'SÁNG'}
              </span>
            )}
          </button>
          {/* Export / Import */}
          <div className="w-px h-4" style={{ backgroundColor: 'var(--border)' }} />
          {/* Export Config button */}
          <button onClick={async () => {
            try {
              const res = await fetchWithRetry(`${API}/api/tunnels/export`)
              if (!res.ok) { setStatusText('❌ Export failed'); return }
              const data = await res.json()
              const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
              const url = URL.createObjectURL(blob)
              const a = document.createElement('a')
              a.href = url
              a.download = `tunnels-export-${new Date().toISOString().slice(0, 10)}.json`
              document.body.appendChild(a); a.click()
              document.body.removeChild(a)
              URL.revokeObjectURL(url)
              setStatusText(`📤 Exported ${Object.keys(data.tunnels || {}).length} tunnels`)
            } catch { setStatusText('❌ Export failed') }
          }}
            className="px-2 py-1 text-[10px] font-semibold rounded border transition-all active:scale-95 cursor-pointer hover:bg-white/5 flex items-center gap-1"
            style={{ backgroundColor: 'var(--input-bg)', borderColor: 'var(--border)', color: 'var(--fg-secondary)' }}>
            <svg className="w-2.5 h-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
            Export
          </button>
          {/* Export Metrics dropdown */}
          <div className="relative">
            <button onClick={() => setExportMetricsOpen(o => !o)}
              className="px-2 py-1 text-[10px] font-semibold rounded border transition-all active:scale-95 cursor-pointer hover:bg-white/5 flex items-center gap-1"
              style={{ backgroundColor: 'var(--input-bg)', borderColor: 'var(--border)', color: 'var(--fg-secondary)' }}>
              <svg className="w-2.5 h-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
              </svg>
              Metrics
              <svg className="w-2 h-2" style={{ color: 'var(--fg-dim)' }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
              </svg>
            </button>
            {exportMetricsOpen && (
              <>
                {/* Backdrop to close on outside click */}
                <div className="fixed inset-0 z-10" onClick={() => setExportMetricsOpen(false)} />
                <div className="absolute right-0 top-full mt-1 z-20 min-w-[130px] rounded-lg border shadow-lg overflow-hidden"
                  style={{ backgroundColor: 'var(--bg-card)', borderColor: 'var(--border)' }}>
                  <button onClick={async () => {
                    setExportMetricsOpen(false)
                    setStatusText('📊 Đang xuất metrics JSON...')
                    try {
                      const res = await fetchWithRetry(`${API}/api/tunnels/metrics/export?format=json`)
                      if (!res.ok) { setStatusText('❌ Export failed'); return }
                      const blob = await res.blob()
                      const url = URL.createObjectURL(blob)
                      const a = document.createElement('a')
                      a.href = url
                      a.download = `tunnel-metrics-${new Date().toISOString().slice(0, 10)}.json`
                      document.body.appendChild(a); a.click()
                      document.body.removeChild(a)
                      URL.revokeObjectURL(url)
                      setStatusText('📊 Exported metrics as JSON')
                    } catch { setStatusText('❌ Export failed') }
                  }}
                    className="w-full px-3 py-2 text-xs text-left flex items-center gap-2 transition-colors border-0 cursor-pointer hover:bg-black/5 dark:hover:bg-white/5"
                    style={{ color: 'var(--fg)' }}>
                    <span className="text-xs">📋</span>
                    <div>
                      <div className="font-medium">JSON</div>
                      <div className="text-[8px]" style={{ color: 'var(--fg-dim)' }}>Raw data, dễ parse</div>
                    </div>
                  </button>
                  <button onClick={async () => {
                    setExportMetricsOpen(false)
                    setStatusText('📊 Đang xuất metrics CSV...')
                    try {
                      const res = await fetchWithRetry(`${API}/api/tunnels/metrics/export?format=csv`)
                      if (!res.ok) { setStatusText('❌ Export failed'); return }
                      const blob = await res.blob()
                      const url = URL.createObjectURL(blob)
                      const a = document.createElement('a')
                      a.href = url
                      a.download = `tunnel-metrics-${new Date().toISOString().slice(0, 10)}.csv`
                      document.body.appendChild(a); a.click()
                      document.body.removeChild(a)
                      URL.revokeObjectURL(url)
                      setStatusText('📊 Exported metrics as CSV')
                    } catch { setStatusText('❌ Export failed') }
                  }}
                    className="w-full px-3 py-2 text-xs text-left flex items-center gap-2 transition-colors border-0 cursor-pointer hover:bg-black/5 dark:hover:bg-white/5"
                    style={{ color: 'var(--fg)' }}>
                    <span className="text-xs">📊</span>
                    <div>
                      <div className="font-medium">CSV</div>
                      <div className="text-[8px]" style={{ color: 'var(--fg-dim)' }}>Mở bằng Excel/Sheets</div>
                    </div>
                  </button>
                </div>
              </>
            )}
          </div>
          <input ref={fileInputRef} type="file" accept=".json" className="hidden"
            onChange={async e => {
              const file = e.target.files?.[0]
              if (!file) return
              setImporting(true)
              try {
                const text = await file.text()
                const res = await fetchWithRetry(`${API}/api/tunnels/import`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: text
                })
                if (res.ok) {
                  const data = await res.json()
                  setStatusText(`📥 Imported ${data.applied} tunnels (${data.skipped} skipped)`)
                  // WHY: Refresh tất cả để UI cập nhật watchdog states từ backend
                  fetchAll()
                } else {
                  const err = await res.json()
                  setStatusText(`❌ Nhập thất bại: ${err.error || 'Không xác định'}`)
                }
              } catch { setStatusText('❌ Nhập thất bại: file không hợp lệ') }
              finally {
                setImporting(false)
                // WHY: Reset file input để cho phép import cùng file lại (nếu user muốn)
                if (fileInputRef.current) fileInputRef.current.value = ''
              }
            }} />
          <button onClick={() => fileInputRef.current?.click()} disabled={importing}
            className="px-2 py-1 text-[10px] font-semibold rounded border transition-all active:scale-95 cursor-pointer disabled:opacity-30 hover:bg-white/5 flex items-center gap-1"
            style={{ backgroundColor: 'var(--input-bg)', borderColor: 'var(--border)', color: 'var(--fg-secondary)' }}>
            {importing ? (
              <><div className="animate-spin rounded-full h-2 w-2 border-b border-current" /> Importing...</>
            ) : (
              <><svg className="w-2.5 h-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L7 8m4-4v12" />
              </svg>
              Import</>
            )}
          </button>
        </div>
      </div>

      {/* Tunnel Table */}
      <div className="flex-1 min-h-0 overflow-auto rounded-xl border backdrop-blur" style={{ background: 'var(--bg-card)', borderColor: 'var(--border)' }}>
        {projects.length === 0 ? (
          <div className="flex items-center justify-center h-full text-[12px]" style={{ color: 'var(--fg-dim)' }}>
            Không có dự án nào. Thêm dự án trong tab Máy chủ.
          </div>
        ) : (
          <>
            {/* Filter result count */}
            {searchQuery && (
              <div className="px-4 py-2 text-xs border-b" style={{ borderColor: 'var(--border)', color: 'var(--fg-dim)' }}>
                {filteredProjects.length} / {projects.length} tunnels
              </div>
            )}
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b text-xs font-semibold uppercase tracking-wider" style={{ borderColor: 'var(--border)', color: 'var(--fg-muted)' }}>
                  <th className="text-left px-4 py-2.5 font-medium">Dự án</th>
                  <th className="text-center px-2 py-2.5 font-medium">Cổng</th>
                  <th className="text-left px-3 py-2.5 font-medium">Trạng thái</th>
                  <th className="text-left px-3 py-2.5 font-medium">Thời gian</th>
                  <th className="text-left px-3 py-2.5 font-medium">URL</th>
                  <th className="text-right px-3 py-2.5 font-medium cursor-pointer select-none hover:text-white/80 transition-colors"
                    onClick={cycleSort}
                    title={
                      sortConfig?.key === 'request_count'
                        ? `Số yêu cầu (${sortConfig.direction === 'desc' ? '↓' : '↑'})`
                        : sortConfig?.key === 'request_rate'
                        ? `Tốc độ yêu cầu (${sortConfig.direction === 'desc' ? '↓' : '↑'})`
                        : 'Nhấp để sắp xếp'
                    }>
                    Yêu cầu
                    {sortConfig?.key === 'request_count' && (
                      <span className="ml-1 text-[10px]" style={{ color: sortConfig.direction === 'desc' ? '#22c55e' : '#60a5fa' }}>
                        {sortConfig.direction === 'desc' ? '↓' : '↑'}
                      </span>
                    )}
                    {sortConfig?.key === 'request_rate' && (
                      <span className="ml-1 text-[10px]" style={{ color: sortConfig.direction === 'desc' ? '#22c55e' : '#60a5fa' }}>
                        📊{sortConfig.direction === 'desc' ? '↓' : '↑'}
                      </span>
                    )}
                    {!sortConfig && (
                      <span className="ml-1 text-[8px] opacity-30">↕</span>
                    )}
                  </th>
                  <th className="text-center px-3 py-2.5 font-medium">Watchdog</th>
                  <th className="text-center px-2 py-2.5 font-medium">Alert</th>
                  <th className="text-right px-4 py-2.5 font-medium">Thao tác</th>
                </tr>
              </thead>
              <tbody>
                {filteredProjects.length === 0 ? (
                  <tr>
                    <td colSpan={10} className="px-4 py-8 text-center">
                      <span className="text-xs" style={{ color: 'var(--fg-dim)' }}>
                        {searchQuery ? 'Không tìm thấy tunnel nào phù hợp' : 'Không có tunnel nào'}
                      </span>
                    </td>
                  </tr>
                ) : sortedProjects.map((p, idx) => {
                const ts = tunnelStates[p.name]
                const loading = tunnelLoading[p.name]
                return (
                  <tr key={p.name} className="border-b tunnel-row-hover animate-tunnel-row"
                    style={{ borderColor: 'var(--border)', opacity: p.running ? 1 : 0.5, animationDelay: `${idx * 0.03}s` }}>
                    {/* Project name + port */}
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <span className={`w-1.5 h-1.5 rounded-full ${p.running ? 'bg-emerald-400 animate-pulse' : 'bg-gray-500'}`} />
                        <span className="font-medium truncate max-w-[130px]" style={{ color: 'var(--fg)' }}>{p.name}</span>
                      </div>
                    </td>
                    {/* Port */}
                    <td className="px-2 py-3 text-center">
                      <span className="font-mono text-xs" style={{ color: 'var(--fg-secondary)' }}>{p.port}</span>
                    </td>
                    {/* Status badge */}
                    <td className="px-3 py-3">
                      {ts?.status === 'active' ? (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 animate-tunnel-glow">
                          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" /> HOẠT ĐỘNG
                        </span>
                      ) : ts?.status === 'connecting' ? (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold bg-amber-500/10 text-amber-400 border border-amber-500/20 animate-pulse">
                          <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" /> ĐANG KẾT NỐI
                        </span>
                      ) : ts?.status === 'error' ? (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold bg-red-500/15 text-red-400 border border-red-500/30">
                          LỖI
                        </span>
                      ) : !p.running ? (
                        <span className="text-[10px]" style={{ color: 'var(--fg-dim)' }}>Máy chủ đã dừng</span>
                      ) : (
                        <span className="text-[10px]" style={{ color: 'var(--fg-dim)' }}>Chưa kích hoạt</span>
                      )}
                      {ts?.status === 'error' && ts?.error && (
                        <div className="text-[10px] mt-0.5 truncate max-w-[120px]" style={{ color: '#ef4444' }}>{ts.error}</div>
                      )}
                    </td>
                    {/* Uptime */}
                    <td className="px-3 py-3">
                      {ts?.status === 'active' && ts?.uptime_seconds ? (
                        <span className="font-mono text-xs" style={{ color: '#22c55e' }}>
                          {formatUptime(ts.uptime_seconds)}
                        </span>
                      ) : (
                        <span className="text-xs" style={{ color: 'var(--fg-dim)' }}>—</span>
                      )}
                    </td>
                    {/* URL */}
                    <td className="px-3 py-3">
                      {ts?.status === 'active' && ts?.url ? (
                        <div className="flex items-center gap-1.5">
                          <a href={ts.url} target="_blank" rel="noopener noreferrer"
                            className="text-xs font-mono truncate max-w-[160px] underline underline-offset-2 hover:text-blue-400 bg-transparent border-0 cursor-pointer"
                            style={{ color: '#3b82f6', textDecorationColor: '#3b82f680' }}>
                            {ts.url.replace('https://', '')}
                          </a>
                          <button onClick={() => {
                            navigator.clipboard.writeText(ts.url!)
                            setStatusText('📋 Copied URL')
                          }}
                            className="px-1 py-0.5 text-[8px] rounded border transition-colors active:scale-95 cursor-pointer"
                            style={{ backgroundColor: 'var(--input-bg)', borderColor: 'var(--border)', color: 'var(--fg-dim)' }}>
                            📋
                          </button>
                          <button onClick={() => openBrowser(ts.url!)}
                            className="px-1 py-0.5 text-[8px] rounded border transition-colors active:scale-95 cursor-pointer"
                            style={{ backgroundColor: 'var(--input-bg)', borderColor: 'var(--border)', color: 'var(--fg-dim)' }}>
                            🔗
                          </button>
                          {ts?.watchdog_restart_count !== undefined && ts.watchdog_restart_count > 0 && (
                            <span className="text-[8px] font-mono" style={{ color: '#fbbf24' }}>🔄{ts.watchdog_restart_count}</span>
                          )}
                        </div>
                      ) : (
                        <span className="text-xs" style={{ color: 'var(--fg-dim)' }}>—</span>
                      )}
                    </td>
                    {/* Request count + sparkline */}
                    <td className="px-3 py-3 text-right">
                      {ts?.status === 'active' ? (
                        <div className="flex flex-col items-end gap-0.5">
                          <div className="flex items-center gap-1.5">
                            <span className="font-mono text-xs" style={{ color: 'var(--fg)' }}>
                              {ts.request_count?.toLocaleString() || '0'}
                            </span>
                            {ts.request_history && ts.request_history.length >= 2 && (
                              <SparklineChart history={ts.request_history} color={ts.request_rate ? '#22c55e' : '#64748b'} />
                            )}
                          </div>
                          {ts.request_rate !== undefined && ts.request_rate !== null && (
                            <span className="font-mono text-[8px]" style={{ color: ts.request_rate > 0 ? '#22c55e' : 'var(--fg-dim)' }}>
                              {ts.request_rate < 0.01 ? '<0.01' : ts.request_rate.toFixed(2)}/giây
                            </span>
                          )}
                        </div>
                      ) : (
                        <span className="text-xs" style={{ color: 'var(--fg-dim)' }}>—</span>
                      )}
                    </td>
                    {/* Watchdog toggle */}
                    <td className="px-3 py-3 text-center">
                      {ts?.cloudflared_installed !== undefined && (
                        <label className="relative inline-flex items-center cursor-pointer"
                          title={ts?.watchdog_enabled ? 'Bật' : 'Tắt'}>
                          <input type="checkbox"
                            checked={ts?.watchdog_enabled || false}
                            onChange={e => toggleWatchdog(p.name, e.target.checked)}
                            disabled={watchdogToggling[p.name] || !p.running}
                            className="sr-only peer" />
                          <div className="w-6 h-3 rounded-full peer peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-[1px] after:left-[1px] after:bg-white after:rounded-full after:h-2.5 after:w-2.5 after:transition-all peer-checked:bg-emerald-500/60 bg-gray-600/40" />
                        </label>
                      )}
                    </td>
                    {/* Alert threshold */}
                    <td className="px-2 py-3 text-center">
                      {ts?.status === 'active' ? (
                        <div className="flex items-center justify-center gap-1">
                          <input type="number" min={0} max={100} step={0.05}
                            value={alertThresholds[p.name] ?? ts?.alert_threshold ?? 0}
                            onChange={e => {
                              const val = parseFloat(e.target.value) || 0
                              if (val < 0) return
                              setAlertThresholds(prev => ({ ...prev, [p.name]: val }))
                            }}
                            onBlur={async () => {
                              const val = alertThresholds[p.name] ?? ts?.alert_threshold ?? 0
                              try {
                                await fetchWithRetry(`${API}/api/projects/${encodeURIComponent(p.name)}/tunnel/alert`, {
                                  method: 'POST',
                                  headers: { 'Content-Type': 'application/json' },
                                  body: JSON.stringify({ threshold: val })
                                })
                                setStatusText(val > 0 ? `🔔 Alert set: >${val}/giây` : '🔕 Alert tắt')
                              } catch {}
                            }}
                            className="w-12 px-1 py-0.5 text-[8px] font-mono text-center rounded border transition-all focus:outline-none focus:ring-1"
                            style={{
                              backgroundColor: 'var(--input-bg)',
                              borderColor: 'var(--border)',
                              color: 'var(--fg)'
                            }}
                            title="Ngưỡng alert (0 = tắt)" />
                          <span className="text-[7px]" style={{ color: 'var(--fg-muted)' }}>/giây</span>
                        </div>
                      ) : (
                        <span className="text-[10px]" style={{ color: 'var(--fg-dim)' }}>—</span>
                      )}
                    </td>
                    {/* Endpoint stats + History sparkline button */}
                    <td className="px-2 py-3 text-center">
                      <div className="flex items-center justify-center gap-1">
                        {ts?.endpoint_counts && Object.keys(ts.endpoint_counts).length > 0 ? (
                          <div className="relative">
                            <button onClick={() => setEndpointOpen(endpointOpen === p.name ? null : p.name)}
                              className="px-1.5 py-1 text-[8px] font-semibold rounded border transition-all active:scale-95 cursor-pointer hover:bg-white/5"
                              style={{
                                backgroundColor: endpointOpen === p.name ? 'rgba(59,130,246,0.15)' : 'var(--input-bg)',
                                borderColor: 'var(--border)',
                                color: endpointOpen === p.name ? '#60a5fa' : 'var(--fg-dim)'
                              }}
                              title="Endpoint statistics">
                              📊
                            </button>
                            {endpointOpen === p.name && (
                              <>
                                <div className="fixed inset-0 z-10" onClick={() => setEndpointOpen(null)} />
                                <div className="absolute left-1/2 -translate-x-1/2 bottom-full mb-1 z-20 min-w-[180px] max-w-[220px] rounded-lg border shadow-lg overflow-hidden"
                                  style={{
                                    backgroundColor: 'var(--bg-card)',
                                    borderColor: 'var(--border)',
                                    color: 'var(--fg)'
                                  }}>
                                  <div className="px-3 py-2 text-[10px] font-semibold border-b"
                                    style={{ borderColor: 'var(--border)', color: 'var(--fg-secondary)' }}>
                                    📊 Top Endpoints
                                  </div>
                                  <div className="max-h-[150px] overflow-y-auto">
                                    {Object.entries(ts.endpoint_counts)
                                      .sort(([, a], [, b]) => b - a)
                                      .slice(0, 10)
                                      .map(([ep, count]) => (
                                        <div key={ep} className="flex items-center justify-between px-3 py-1.5 text-[9px] hover:bg-black/5 dark:hover:bg-white/5">
                                          <span className="font-mono truncate max-w-[120px]" style={{ color: 'var(--fg)' }}>{ep}</span>
                                          <span className="font-mono ml-2 shrink-0" style={{ color: '#22c55e' }}>{count}</span>
                                        </div>
                                      ))}
                                  </div>
                                </div>
                              </>
                            )}
                          </div>
                        ) : null}
                        {ts?.status === 'active' || ts?.status === 'error' ? (
                          <button onClick={() => {
                            setHistoryProject(p.name)
                            setHistoryRange('24h')
                            setHistoryData([])
                          }}
                            className="px-1.5 py-1 text-[8px] font-semibold rounded border transition-all active:scale-95 cursor-pointer hover:bg-white/5"
                            style={{ backgroundColor: 'var(--input-bg)', borderColor: 'var(--border)', color: 'var(--fg-dim)' }}
                            title="Lịch sử request rate">
                            📈
                          </button>
                        ) : (
                          <span className="text-[10px]" style={{ color: 'var(--fg-dim)' }}>—</span>
                        )}
                      </div>
                    </td>
                    {/* Actions */}
                    <td className="px-4 py-3 text-right">
                      {p.running && !ts?.url ? (
                        // WHY: Nếu cloudflared chưa cài → nút 1-click install+start
                        ts?.cloudflared_installed === false ? (
                          <button onClick={() => installAndStart(p.name)} disabled={loading}
                            className="px-2 py-1 text-[10px] font-semibold rounded border transition-all active:scale-95 cursor-pointer disabled:opacity-30"
                            style={{ backgroundColor: 'rgba(16,185,129,0.15)', borderColor: 'rgba(16,185,129,0.3)', color: '#34d399' }}>
                            {loading ? '...' : '📥 Cài & Mở'}
                          </button>
                        ) : ts?.status === 'connecting' ? (
                          <div className="animate-spin rounded-full h-3 w-3 border-b border-amber-400 inline-block" />
                        ) : ts?.status === 'error' ? (
                          <button onClick={() => startTunnel(p.name)} disabled={loading}
                            className="px-2 py-1 text-[10px] font-semibold rounded border transition-all active:scale-95 cursor-pointer disabled:opacity-30"
                            style={{ backgroundColor: 'var(--input-bg)', borderColor: 'var(--border)', color: 'var(--fg-secondary)' }}>
                            {loading ? '...' : '🔄 Thử lại'}
                          </button>
                        ) : (
                          <button onClick={() => startTunnel(p.name)} disabled={loading}
                            className="px-2 py-1 text-[10px] font-semibold rounded border transition-all active:scale-95 cursor-pointer disabled:opacity-30"
                            style={{ backgroundColor: 'rgba(59,130,246,0.1)', borderColor: 'rgba(59,130,246,0.25)', color: '#60a5fa' }}>
                            {loading ? '...' : 'Mở tunnel'}
                          </button>
                        )
                      ) : ts?.status === 'active' ? (
                        <button onClick={() => stopTunnel(p.name)} disabled={loading}
                          className="px-2 py-1 text-[10px] font-semibold rounded border transition-all active:scale-95 cursor-pointer disabled:opacity-30"
                          style={{ backgroundColor: 'var(--input-bg)', borderColor: 'var(--border)', color: '#ef4444' }}>
                          {loading ? '...' : '⏹ Dừng'}
                        </button>
                      ) : null}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          </>
        )}
      </div>
      {/* History Modal */}
      {historyProject && (
        <>
          <div className="fixed inset-0 z-30 bg-black/40 backdrop-blur-sm" onClick={() => setHistoryProject(null)} />
          <div className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-40 w-[700px] max-w-[90vw] rounded-xl border shadow-2xl"
            style={{ backgroundColor: 'var(--bg-card)', borderColor: 'var(--border)' }}>
            <div className="px-5 py-4 border-b flex items-center justify-between" style={{ borderColor: 'var(--border)' }}>
              <div>
                <h3 className="text-[13px] font-semibold" style={{ color: 'var(--fg)' }}>
                  📈 Lịch sử Request Rate: <span className="font-mono">{historyProject}</span>
                </h3>
                <p className="text-xs mt-0.5" style={{ color: 'var(--fg-dim)' }}>
                  {historyData.length} snapshots &middot; Cập nhật mỗi giờ
                </p>
              </div>
              <div className="flex items-center gap-2">
                {/* Range selector */}
                {['24h', '7d', '30d'].map(r => (
                  <button key={r} onClick={() => setHistoryRange(r)}
                    className={`px-2.5 py-1 text-xs font-semibold rounded-lg transition-all cursor-pointer border-0 ${
                      historyRange === r ? 'ring-1' : 'opacity-60 hover:opacity-100'
                    }`}
                    style={{
                      backgroundColor: historyRange === r ? 'var(--input-bg)' : 'transparent',
                      color: historyRange === r ? 'var(--fg)' : 'var(--fg-dim)',
                      borderColor: historyRange === r ? 'var(--border)' : 'transparent',
                    }}>
                    {r === '24h' ? '24 giờ' : r === '7d' ? '7 ngày' : '30 ngày'}
                  </button>
                ))}
                <button onClick={() => setHistoryProject(null)}
                  className="p-1.5 rounded-lg transition-colors hover:bg-black/10 dark:hover:bg-white/10 border-0 cursor-pointer"
                  style={{ color: 'var(--fg-dim)' }}>
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            </div>
            <div className="p-5">
              {historyLoading ? (
                <div className="flex items-center justify-center h-32 gap-2">
                  <div className="animate-spin rounded-full h-4 w-4 border-b border-emerald-500" />
                  <span className="text-xs" style={{ color: 'var(--fg-dim)' }}>Đang tải...</span>
                </div>
              ) : (
                <>
                  <HistoryChart history={historyData} range={historyRange} />
                  {/* Stats summary */}
                  {historyData.length > 0 && (
                    <div className="mt-4 grid grid-cols-3 gap-3">
                      <div className="p-3 rounded-lg" style={{ backgroundColor: 'var(--input-bg)' }}>
                        <div className="text-[8px] uppercase tracking-wider" style={{ color: 'var(--fg-muted)' }}>Trung bình</div>
                        <div className="text-[15px] font-mono font-bold mt-1" style={{ color: 'var(--fg)' }}>
                          {(historyData.reduce((s, e) => s + e.request_rate, 0) / historyData.length).toFixed(3)}
                          <span className="text-[10px] font-normal" style={{ color: 'var(--fg-dim)' }}>/giây</span>
                        </div>
                      </div>
                      <div className="p-3 rounded-lg" style={{ backgroundColor: 'var(--input-bg)' }}>
                        <div className="text-[8px] uppercase tracking-wider" style={{ color: 'var(--fg-muted)' }}>Cao nhất</div>
                        <div className="text-[15px] font-mono font-bold mt-1" style={{ color: '#22c55e' }}>
                          {Math.max(...historyData.map(e => e.request_rate)).toFixed(3)}
                          <span className="text-[10px] font-normal" style={{ color: 'var(--fg-dim)' }}>/giây</span>
                        </div>
                      </div>
                      <div className="p-3 rounded-lg" style={{ backgroundColor: 'var(--input-bg)' }}>
                        <div className="text-[8px] uppercase tracking-wider" style={{ color: 'var(--fg-muted)' }}>Tổng request</div>
                        <div className="text-[15px] font-mono font-bold mt-1" style={{ color: '#60a5fa' }}>
                          {historyData[historyData.length - 1].request_count.toLocaleString()}
                        </div>
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
