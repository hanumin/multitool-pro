import { useState, useEffect, useCallback, useRef } from 'react'
import { Printer } from '../../types'

import { API, fetchWithRetry } from '../../utils/apiFetch'

interface PrintHistoryEntry {
  datetime: string
  action: string
  printer: string
}

interface ReminderInfo {
  should_remind: boolean
  last_print: string | null
  days_left: number
  hours_left?: number
  minutes_left?: number
  message: string
  is_laser?: boolean
}

interface PrinterSettings {
  days_between_prints: number
  selected_printer: string
  remind_minutes: number
  reminder_enabled: boolean
  last_print_date: string | null
  excluded_printers?: string[]
  page_count?: Record<string, number>
}

interface PrinterStats {
  total_prints: number
  printers: Record<string, {
    total: number
    last_print: string | null
    first_print: string | null
    is_laser: boolean
    recent_docs?: string[]
  }>
}

interface PrintActivity {
  printer: string
  document: string
  job_id: number
  is_printing: boolean
  pages: number
}

interface WmiDetails {
  online: boolean
  status: string
  printer: string
  extended_status?: number
  error_state?: string
  error_code?: number
  job_count_since_reset?: number
  average_pages_per_minute?: number
  horizontal_resolution?: number
  vertical_resolution?: number
  supports_color?: boolean
  capabilities?: string[]
  print_processor?: string
  driver_name?: string
  port_name?: string
  page_resolution?: string
  paper_sizes?: string[]
}

interface PrintersModuleProps {
  theme: 'dark' | 'light'
  setStatusText: (t: string) => void
}

// ═══════════════════════════════════════════════════════════════
// PRINTER MODULE — Giao diện quản lý máy in
// ═══════════════════════════════════════════════════════════════
//
// Kiến trúc frontend:
//   - Polling API mỗi 5 giây (fetchAll)
//   - Settings dùng file JSON backend (lưu trong %APPDATA%)
//   - WMI status: hybrid win32print + WMI + PowerShell
//
// Flow dữ liệu:
//   1. fetchAll() gọi song song: printers + settings + history + reminder
//   2. Settings xử lý TRƯỚC → lấy excluded_printers
//   3. Printers xử lý SAU → áp dụng filter, tính visibleCount
//   4. WMI status + page count fetch riêng sau đó
//
// State quan trọng:
//   - printers: Danh sách gốc từ backend (chưa filter)
//   - printerSettings: Settings từ backend (gồm excluded_printers)
//   - wmiStatus: Kết quả từ /api/printer/wmi-status
//   - printerStats: Thống kê số lần in
//
// ⚠️ Lưu ý cho AI agents:
//   - excluded_printers filter danh sách HIỂN THỊ, không ảnh hưởng lưu
//   - page_count: KHÔNG THỂ đọc tự động từ USB printer (đã kiểm chứng)
//     * ESC/P-R (EPSON) là write-only, không có lệnh đọc
//     * EventLogs chỉ ghi job qua driver chuẩn, RAW jobs bị bỏ qua
//     * WMI JobCountSinceLastReset luôn = 0 cho USB
//     * Manual entry là GIẢI PHÁP DUY NHẤT (Settings → 📄 Tổng trang)
//   - Modal animations dùng inline style + CSS keyframes
//   - Grid metrics: 3 cột, 5 items (WMI data + page count)
// ═══════════════════════════════════════════════════════════════

// ── Helpers: UI utilities ──────────────────────────
// getStatusColor, getStatusBg, getStatusRing, getStatusIcon
// → Chuyển trạng thái máy in thành màu sắc/giao diện

// WHY: Helper — map trạng thái máy in (string) sang màu sắc UI.
// Dùng includes() để match Vietnamese + English status text.
// Thứ tự ưu tiên: ready > printing > offline/error > paper jam > no paper.
const getStatusColor = (status: string) => {
  const s = status?.toLowerCase()
  if (s?.includes('sẵn sàng') || s?.includes('ready') || s?.includes('rảnh')) return '#22c55e'
  if (s?.includes('đang in') || s?.includes('printing')) return '#3b82f6'
  if (s?.includes('ngoại tuyến') || s?.includes('offline') || s?.includes('lỗi') || s?.includes('error')) return '#ef4444'
  if (s?.includes('kẹt giấy')) return '#f59e0b'
  if (s?.includes('hết giấy')) return '#f97316'
  return '#f59e0b'
}

// WHY: Helper — tạo background color từ getStatusColor với độ mờ 15%.
// Dùng inline hex + alpha (VD: #22c55e15) thay vì rgba() để đồng bộ với design system.
const getStatusBg = (status: string) => {
  const c = getStatusColor(status)
  return `${c}15`
}

// WHY: Helper — map trạng thái sang CSS ring classes (Tailwind border utilities).
// Dùng CSS class (không phải inline style) để hover transitions hoạt động.
// animate-pulse cho trạng thái 'printing' để tạo hiệu ứng sống động.
const getStatusRing = (status: string) => {
  const s = status?.toLowerCase()
  if (s?.includes('sẵn sàng') || s?.includes('ready') || s?.includes('rảnh')) return 'border-emerald-500/30'
  if (s?.includes('đang in') || s?.includes('printing')) return 'border-blue-500/30 animate-pulse'
  if (s?.includes('ngoại tuyến') || s?.includes('offline')) return 'border-red-500/30'
  if (s?.includes('lỗi') || s?.includes('error')) return 'border-red-500/30'
  return 'border-amber-500/30'
}

// WHY: Helper — chọn icon ký tự (unicode) cho từng trạng thái máy in.
// Dùng ký tự đơn giản (✓ ⟳ ✕ ⚠) thay vì SVG để giảm code + render nhanh hơn.
const getStatusIcon = (status: string) => {
  const s = status?.toLowerCase()
  if (s?.includes('sẵn sàng') || s?.includes('ready') || s?.includes('rảnh')) return '✓'
  if (s?.includes('đang in') || s?.includes('printing')) return '⟳'
  if (s?.includes('ngoại tuyến') || s?.includes('offline')) return '✕'
  if (s?.includes('lỗi') || s?.includes('error')) return '⚠'
  if (s?.includes('kẹt giấy')) return '📄'
  if (s?.includes('hết giấy')) return '📋'
  return '…'
}

const statusGradients: Record<string, string> = {
  'Sẵn sàng': 'from-emerald-600/20 via-emerald-500/5 to-transparent',
  'Đang in': 'from-blue-600/20 via-blue-500/5 to-transparent',
  'Ngoại tuyến': 'from-red-600/20 via-red-500/5 to-transparent',
  'Lỗi': 'from-red-600/20 via-red-500/5 to-transparent',
  'Hết giấy': 'from-orange-600/20 via-orange-500/5 to-transparent',
  'Kẹt giấy': 'from-amber-600/20 via-amber-500/5 to-transparent',
}

// ── Component ──────────────────────────────────────
// WHY: Module quản lý máy in — dashboard, WMI status, print history, settings, PJL diagnostics.
// Polling 5s: printers + reminder + settings + history + stats + activity + WMI.
// Kiến trúc: fetchAll() gọi song song 4 API chính → xử lý settings trước → printers sau.
export default function PrintersModule({ theme, setStatusText }: PrintersModuleProps) {
  const [printers, setPrinters] = useState<Printer[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedPrinter, setSelectedPrinter] = useState<string | null>(null)
  const [printerJobs, setPrinterJobs] = useState<string[]>([])
  const [jobsLoading, setJobsLoading] = useState(false)

  const [reminderInfo, setReminderInfo] = useState<ReminderInfo | null>(null)
  const [printerSettings, setPrinterSettings] = useState<PrinterSettings>({
    days_between_prints: 5, selected_printer: '', remind_minutes: 15,
    reminder_enabled: true, last_print_date: null,
    excluded_printers: [], page_count: {}
  })
  const [printHistory, setPrintHistory] = useState<PrintHistoryEntry[]>([])
  const [historyOpen, setHistoryOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [wmiStatus, setWmiStatus] = useState<WmiDetails | null>(null)
  const [countdownText, setCountdownText] = useState('')
  const [printerStats, setPrinterStats] = useState<PrinterStats | null>(null)
  const [printActivity, setPrintActivity] = useState<PrintActivity[]>([])
  const [statsOpen, setStatsOpen] = useState(false)
  const [pjlData, setPjlData] = useState<any>(null)
  const [pjlLoading, setPjlLoading] = useState(false)
  const [pjlIpInput, setPjlIpInput] = useState('')
  const [showPjlIpInput, setShowPjlIpInput] = useState(false)

  // ── History modal state ──
  const [historySearch, setHistorySearch] = useState('')
  const [historyFilterDays, setHistoryFilterDays] = useState(0)
  const [historyTab, setHistoryTab] = useState<string>('all')

  // ── Import/Export state ──
  const importFileInputRef = useRef<HTMLInputElement>(null)
  const [importResult, setImportResult] = useState<string | null>(null)

  // WHY: Import từ file JSON — parse text → gửi lên backend → fetchAll refresh.
  // Dùng hidden <input> ref thay vì Tauri dialog để đơn giản (file text, không cần path).
  // Reset input.value = '' sau import để cho phép import lại cùng file.
  const handleImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    try {
      const text = await file.text()
      const data = JSON.parse(text)
      const res = await fetchWithRetry(`${API}/api/printer/import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data, mode: 'overwrite' })
      })
      const result = await res.json()
      if (res.ok) {
        const imported = result.imported || {}
        const items = Object.entries(imported).filter(([,v]) => v).map(([k]) => k).join(', ')
        setImportResult(`✅ Đã nhập: ${items || 'không có gì'}`)
        if (result.warnings?.length) setImportResult(prev => prev + ` | ⚠️ ${result.warnings.join(', ')}`)
        setStatusText('✅ Import thành công!')
        fetchAll()
      } else {
        setImportResult(`❌ Import thất bại: ${result.error || 'lỗi không xác định'}`)
      }
    } catch (err: any) {
      setImportResult(`❌ Lỗi đọc file: ${err.message}`)
    }
    // Reset input để chọn lại file khác
    if (importFileInputRef.current) importFileInputRef.current.value = ''
  }

  // WHY: Backup gọi riêng (không trong fetchAll) vì chỉ cần khi user click.
  // Backend trả về size KB để hiển thị — không cần UI progress.
  const triggerBackup = async () => {
    try {
      const res = await fetchWithRetry(`${API}/api/printer/backup`, { method: 'POST' })
      if (res.ok) {
        const data = await res.json()
        setStatusText(`✅ Đã sao lưu: ${(data.size / 1024).toFixed(1)} KB`)
      } else {
        setStatusText('❌ Sao lưu thất bại')
      }
    } catch {
      setStatusText('❌ Lỗi kết nối')
    }
  }

  // ── History computed values ──
  const historyPrinters = [...new Set(printHistory
    .filter(e => e.printer && !(printerSettings.excluded_printers || []).includes(e.printer))
    .map(e => e.printer)
  )]

  const filteredHistory = printHistory.filter(entry => {
    if (historyTab !== 'all' && entry.printer !== historyTab) return false
    if (historySearch) {
      const q = historySearch.toLowerCase()
      if (!entry.action.toLowerCase().includes(q) &&
          !(entry.printer || '').toLowerCase().includes(q)) return false
    }
    if (historyFilterDays > 0) {
      try {
        const parts = entry.datetime?.split(' ')[0]?.split('/')
        if (parts && parts.length === 3) {
          const entryDate = new Date(`${parts[2]}-${parts[1]}-${parts[0]}`)
          const diff = Math.floor((Date.now() - entryDate.getTime()) / (1000 * 60 * 60 * 24))
          if (diff > historyFilterDays) return false
        }
      } catch { return false }
    }
    return true
  })

  const historyPrinterCount = [...new Set(filteredHistory.map(e => e.printer).filter(Boolean))].length

  const todayCount = filteredHistory.filter(e => {
    try {
      const parts = e.datetime?.split(' ')[0]?.split('/')
      if (parts && parts.length === 3) {
        const entryDate = new Date(`${parts[2]}-${parts[1]}-${parts[0]}`)
        return entryDate.toDateString() === new Date().toDateString()
      }
    } catch {}
    return false
  }).length

  // WHY: Export qua Blob download (fallback khi clipboard API không khả dụng).
  // JSON chứa history + printers + settings + stats — đủ để import lại sau.
  const exportHistory = async () => {
    try {
      const dataStr = JSON.stringify({
        exportDate: new Date().toISOString(),
        version: '1.0',
        printers: printers.map(p => p.name),
        history: printHistory,
        totalPrints: totalPrints,
        printerStats: printerStats,
        excluded_printers: printerSettings.excluded_printers || [],
        page_count: printerSettings.page_count || {},
      }, null, 2)

      // Fallback: download via Blob
      const blob = new Blob([dataStr], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `printer-history-${new Date().toISOString().split('T')[0]}.json`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
      setStatusText('✅ Đã xuất lịch sử in')
    } catch (e) {
      setStatusText('❌ Xuất thất bại')
    }
  }

  // ──────────────────────────────────────────────────────────────
  // fetchAll — Vòng lặp polling chính, gọi mỗi 5 giây
  //
  // Thứ tự:
  //   1. Fetch song song: printers + reminder + settings + history
  //   2. Xử lý settings TRƯỚC → lấy excluded_printers
  //   3. Xử lý printers SAU → áp dụng filter, set statusText
  //   4. Fetch thêm: stats, activity, auto-detect, WMI status
  //   5. Auto-fetch page-count cho printer đang chọn
  //
  // Lưu ý: settingsRes được xử lý TRƯỚC printersRes để
  //   có excluded_printers list khi tính visibleCount.
  //   settingsData là biến local (không phải state) để tránh
  //   async timing issues với setPrinterSettings.
  // ──────────────────────────────────────────────────────────────
  // WHY: autoSelectDefault ref: chạy 1 lần duy nhất khi lần đầu fetchAll có printers,
  // chọn máy in mặc định và lưu vào settings. Không chạy lại mỗi 5s poll.
  const autoSelectDefault = useRef(false)
  const fetchAll = useCallback(async () => {
    try {
      const [printersRes, reminderRes, settingsRes, historyRes] = await Promise.all([
        fetchWithRetry(`${API}/api/printers`),
        fetchWithRetry(`${API}/api/printer/reminder-check`),
        fetchWithRetry(`${API}/api/printer/settings`),
        fetchWithRetry(`${API}/api/printer/history`),
      ])

      let settingsData: any = null
      if (settingsRes.ok) {
        settingsData = await settingsRes.json()
        setPrinterSettings(settingsData.settings)
      }

      if (printersRes.ok) {
        const data = await printersRes.json()
        setPrinters(data.printers || [])
        const excluded = settingsData?.settings?.excluded_printers || []
        const visibleCount = (data.printers || []).filter((p: any) => !excluded.includes(p.name)).length
        setStatusText(`${visibleCount}/${data.printers?.length || 0} máy in`)

        if (!autoSelectDefault.current) {
          if (!settingsData?.settings?.selected_printer) {
            const defaultPrinter = data.printers?.find((p: any) => p.is_default)
            if (defaultPrinter) {
              const name = defaultPrinter.name
              setPrinterSettings(prev => ({ ...prev, selected_printer: name }))
              fetchWithRetry(`${API}/api/printer/settings`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ selected_printer: name })
              }).then(() => setStatusText(`Đang theo dõi: ${name}`)).catch(() => {})
            }
          }
          autoSelectDefault.current = true
        }
      }
      if (reminderRes.ok) setReminderInfo(await reminderRes.json())
      if (historyRes.ok) {
        const data = await historyRes.json()
        setPrintHistory(data.history || [])
      }

      try {
        const statsRes = await fetchWithRetry(`${API}/api/printer/stats`)
        if (statsRes.ok) {
          const data = await statsRes.json()
          setPrinterStats(data.stats)
        }
      } catch {}
      try {
        const activityRes = await fetchWithRetry(`${API}/api/printer/activity`)
        if (activityRes.ok) {
          const data = await activityRes.json()
          setPrintActivity(data.active_jobs || [])
        }
      } catch {}

      try { await fetchWithRetry(`${API}/api/printer/auto-detect`, { method: 'POST' }) } catch {}

      try {
        const wmiRes = await fetchWithRetry(`${API}/api/printer/wmi-status`)
        if (wmiRes.ok) setWmiStatus(await wmiRes.json())
      } catch {}

      // Auto-fetch page count cho printer đã chọn
      const selPrinter = settingsData?.settings?.selected_printer || ''
      if (selPrinter) {
        const foundPrinter = printers.find(p => p.name === selPrinter)
        try {
          const pcRes = await fetchWithRetry(`${API}/api/printer/page-count?printer=${encodeURIComponent(selPrinter)}&port=${encodeURIComponent(foundPrinter?.port || '')}`)
          if (pcRes.ok) {
            const pcData = await pcRes.json()
            if (pcData?.page_count !== null && pcData?.page_count !== undefined) {
              setPrinterSettings(prev => ({
                ...prev,
                page_count: { ...(prev.page_count || {}), [selPrinter]: pcData.page_count }
              }))
            }
          }
        } catch {}
      }
    } catch { setStatusText('Đang kết nối lại...') }
    finally { setLoading(false) }
  }, [setStatusText])

  useEffect(() => {
    fetchAll()
    const interval = setInterval(fetchAll, 5000)
    return () => clearInterval(interval)
  }, [fetchAll])

  // WHY: Countdown timer — tính từ reminderInfo.days_left + hours_left + minutes_left.
  // Laser printer bypass: is_laser = true → không hiển thị countdown.
  useEffect(() => {
    if (!reminderInfo) return
    if (reminderInfo.is_laser) {
      setCountdownText('🔲 Laser - không cần nhắc')
      return
    }
    if (reminderInfo.should_remind) {
      setCountdownText('⚠️ Cần in ngay!')
      return
    }
    const totalHours = (reminderInfo.days_left || 0) * 24 + (reminderInfo.hours_left || 0)
    const mins = reminderInfo.minutes_left || 0
    setCountdownText(`${totalHours}h ${mins}m`)
  }, [reminderInfo])

  // WHY: fetchJobs chỉ gọi khi user click expand printer — không poll tự động.
  // [] deps: reference ổn định, tránh re-create khi component re-render.
  const fetchJobs = useCallback(async (name: string) => {
    setJobsLoading(true)
    try {
      const res = await fetchWithRetry(`${API}/api/printers/${encodeURIComponent(name)}/jobs`)
      if (res.ok) {
        const data = await res.json()
        setPrinterJobs(data.jobs || [])
      }
    } catch {} finally { setJobsLoading(false) }
  }, [])

  // WHY: Xóa tất cả lệnh in — cần confirm vì không undo được.
  // DELETE API endpoint, fetchJobs(name) refresh queue sau khi xóa.
  const clearJobs = async (name: string) => {
    if (!window.confirm(`Xóa tất cả lệnh in của "${name}"?`)) return
    try {
      const res = await fetchWithRetry(`${API}/api/printers/${encodeURIComponent(name)}/jobs`, { method: 'DELETE' })
      if (res.ok) { setPrinterJobs([]); setStatusText(`Đã xóa lệnh in của ${name}`); fetchJobs(name) }
    } catch { setStatusText('Xóa lệnh in thất bại') }
  }

  // WHY: POST /default API + fetchAll refresh toàn bộ (không chỉ fetchJobs).
  // Vì thay đổi default ảnh hưởng đến danh sách hiển thị.
  const setDefaultPrinter = async (name: string) => {
    try {
      const res = await fetchWithRetry(`${API}/api/printers/${encodeURIComponent(name)}/default`, { method: 'POST' })
      if (res.ok) { setStatusText(`Đã đặt ${name} làm mặc định`); fetchAll() }
    } catch { setStatusText('Thất bại') }
  }

  // WHY: Gửi trang thử qua backend — backend dùng win32print.StartDocPrinter.
  // Nếu lỗi, backend trả về error message trong JSON response.
  const testPrint = async (name: string) => {
    try {
      const res = await fetchWithRetry(`${API}/api/printers/${encodeURIComponent(name)}/test`, { method: 'POST' })
      if (res.ok) { setStatusText(`Đã gửi trang thử đến ${name}`); fetchAll() }
      else { const e = await res.json(); setStatusText(e.error || 'Thất bại') }
    } catch { setStatusText('In thử thất bại') }
  }

  // WHY: Ghi nhận in thủ công — user tự bấm khi in xong.
  // Quan trọng cho GDI printers (không có EventLog → không auto-detect).
  const recordManualPrint = async () => {
    if (!printerSettings.selected_printer) {
      setStatusText('⚠️ Chọn máy in trong Cài đặt trước')
      return
    }
    try {
      const res = await fetchWithRetry(`${API}/api/printer/log`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'In thủ công', printer_name: printerSettings.selected_printer })
      })
      if (res.ok) { setStatusText('Đã ghi nhận in!'); fetchAll() }
    } catch { setStatusText('Thất bại') }
  }

  // WHY: Save settings gửi TOÀN BỘ printerSettings object (không chỉ field thay đổi).
  // Backend merge vào file JSON. Đóng modal + fetchAll refresh sau khi save.
  const saveSettings = async () => {
    try {
      const res = await fetchWithRetry(`${API}/api/printer/settings`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(printerSettings)
      })
      if (res.ok) { setStatusText('Đã lưu cài đặt'); setSettingsOpen(false); fetchAll() }
    } catch { setStatusText('Thất bại') }
  }

  // WHY: PJL query — dùng network socket (cổng 9100) hoặc RAW spooler.
  // USB printer gửi được lệnh nhưng KHÔNG đọc được response.
  // Network printer mới đọc được page_count, toner_level, drum_life.
  const queryPjlStatus = async (printerName: string, printerIp?: string) => {
    setPjlLoading(true)
    setPjlData(null)
    try {
      let url = `${API}/api/printer/pjl-status?printer=${encodeURIComponent(printerName)}`
      if (printerIp) {
        url += `&ip=${encodeURIComponent(printerIp)}`
      }
      const res = await fetch(url)
      if (res.ok) {
        setPjlData(await res.json())
      } else {
        setPjlData({ error: 'Failed to query PJL' })
      }
    } catch {
      setPjlData({ error: 'Connection failed' })
    } finally {
      setPjlLoading(false)
    }
  }

  // WHY: Delete history entry theo index — backend shift array.
  // fetchAll refresh sau khi xóa để đồng bộ UI.
  const deleteHistoryEntry = async (index: number) => {
    try {
      const res = await fetchWithRetry(`${API}/api/printer/history?index=${index}`, { method: 'DELETE' })
      if (res.ok) { fetchAll() }
    } catch {}
  }

  const totalPrints = printerStats?.total_prints || 0
  const activePrintCount = printActivity.length
  const statsPrinters = printerStats?.printers || {}
  const isLaser = reminderInfo?.is_laser || false

  if (loading && printers.length === 0) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center space-y-4">
          <div className="relative mx-auto w-10 h-10">
            <div className="absolute inset-0 rounded-full border-2 border-dashed border-emerald-500/30 animate-spin" />
            <div className="absolute inset-2 rounded-full border-2 border-emerald-500/50 animate-spin" style={{ animationDirection: 'reverse', animationDuration: '1.5s' }} />
          </div>
          <div className="space-y-1">
            <p className="text-sm font-medium" style={{ color: 'var(--fg)' }}>Đang quét máy in</p>
            <p className="text-xs" style={{ color: 'var(--fg-dim)' }}>Kiểm tra kết nối USB...</p>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      {/* ═══════ DASHBOARD HEADER ═══════ */}
      <div className="shrink-0 grid grid-cols-1 lg:grid-cols-3 gap-3 p-4">
        {/* ── Card 1: Status Dashboard ── */}
        <div className="lg:col-span-2 rounded-xl border backdrop-blur-sm relative overflow-hidden transition-all duration-300 hover:shadow-lg"
          style={{ backgroundColor: 'var(--bg-card)', borderColor: 'var(--border)' }}>
          {/* Gradient background */}
          <div className={`absolute inset-0 bg-gradient-to-br ${!wmiStatus ? 'from-gray-600/10' : statusGradients[wmiStatus?.status || ''] || 'from-gray-600/10'} opacity-60`} />

          <div className="relative p-4">
            {/* Header */}
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-xs font-bold uppercase tracking-[0.15em]" style={{ color: 'var(--fg-muted)' }}>
                <span className="mr-1.5">📊</span>Bảng điều khiển
              </h3>
              <div className="flex items-center gap-1.5">
                {/* Status ring */}
                {wmiStatus && (
                  <div className="flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-semibold"
                    style={{ backgroundColor: getStatusBg(wmiStatus.status || ''), color: getStatusColor(wmiStatus.status || '') }}>
                    <span className={`w-1.5 h-1.5 rounded-full ${wmiStatus.online ? 'bg-emerald-400 animate-pulse' : ''}`}
                      style={{ backgroundColor: !wmiStatus.online ? '#ef4444' : undefined }} />
                    {wmiStatus.status || 'Đang kiểm tra...'}
                  </div>
                )}
              </div>
            </div>

            {/* Main content */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {/* Left column: WMI info */}
              <div>
                {/* Error banner */}
                {wmiStatus?.error_state && wmiStatus.error_code && wmiStatus.error_code > 2 && (
                  <div className="mb-2 px-2.5 py-1.5 rounded-lg text-xs font-medium flex items-center gap-2"
                    style={{ backgroundColor: '#ef444415', color: '#f87171', border: '1px solid #ef444430' }}>
                    <span>⚠️</span>
                    <span>{wmiStatus.error_state}</span>
                  </div>
                )}

                {/* Selected printer + connectivity */}
                <div className="space-y-2 text-xs">
                  <div className="flex items-center justify-between group">
                    <span className="text-[10px] uppercase tracking-wider" style={{ color: 'var(--fg-dim)' }}>Máy in</span>
                    <span className="font-semibold truncate max-w-[200px] text-right text-[12px]" style={{ color: 'var(--fg)' }}>
                      {printerSettings.selected_printer || (
                        <span className="italic text-xs" style={{ color: 'var(--fg-dim)' }}>Chưa chọn</span>
                      )}
                    </span>
                  </div>

                  <div className="flex items-center justify-between">
                    <span className="text-[10px] uppercase tracking-wider" style={{ color: 'var(--fg-dim)' }}>Cổng</span>
                    <span className="font-mono text-xs" style={{ color: 'var(--fg-secondary)' }}>
                      {wmiStatus?.port_name || '...'}
                    </span>
                  </div>

                  <div className="flex items-center justify-between">
                    <span className="text-[10px] uppercase tracking-wider" style={{ color: 'var(--fg-dim)' }}>Driver</span>
                    <span className="font-mono text-xs truncate max-w-[180px] text-right" style={{ color: 'var(--fg-secondary)' }}>
                      {wmiStatus?.driver_name || (printers.find(p => p.name === printerSettings.selected_printer)?.driver) || '...'}
                    </span>
                  </div>

                  <div className="flex items-center justify-between">
                    <span className="text-[10px] uppercase tracking-wider" style={{ color: 'var(--fg-dim)' }}>Đang in</span>
                    <span className="font-mono text-xs" style={{ color: activePrintCount > 0 ? '#22c55e' : 'var(--fg-dim)' }}>
                      {activePrintCount > 0 ? (
                        <span className="flex items-center gap-1">
                          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                          {activePrintCount} job
                        </span>
                      ) : 'Không có'}
                    </span>
                  </div>

                  <div className="flex items-center justify-between">
                    <span className="text-[10px] uppercase tracking-wider" style={{ color: 'var(--fg-dim)' }}>Lần in cuối</span>
                    <span className="font-mono text-xs" style={{ color: 'var(--fg-secondary)' }}>
                      {printerSettings.last_print_date || (
                        <span className="italic" style={{ color: 'var(--fg-dim)' }}>Chưa từng</span>
                      )}
                    </span>
                  </div>

                  <div className="flex items-center justify-between">
                    <span className="text-[10px] uppercase tracking-wider" style={{ color: 'var(--fg-dim)' }}>
                      {isLaser ? '🔲 Laser' : '📅 Hạn in'}
                    </span>
                    <span className={`font-semibold text-xs ${reminderInfo?.should_remind && !isLaser ? 'text-red-400' : ''}`}
                      style={{ color: !reminderInfo?.should_remind || isLaser ? 'var(--fg-secondary)' : undefined }}>
                      {countdownText || 'Đang tính...'}
                    </span>
                  </div>
                </div>
              </div>

              {/* Right column: WMI metrics grid */}
              {wmiStatus && (
                <div className="grid grid-cols-3 gap-1.5">
                  {[
                    { label: 'Số job', value: wmiStatus.job_count_since_reset, unit: 'job', icon: '📋', color: '#22c55e' },
                    { label: 'Tốc độ in', value: wmiStatus.average_pages_per_minute, unit: 'tr/ph', icon: '⚡', color: '#3b82f6' },
                    { label: 'Độ phân giải', value: wmiStatus.page_resolution || (wmiStatus.horizontal_resolution ? `${wmiStatus.horizontal_resolution}x${wmiStatus.vertical_resolution || 0}` : null), icon: '🎯', color: '#8b5cf6' },
                    { label: 'Tổng trang', value: printerSettings.page_count?.[printerSettings.selected_printer], icon: '📄', color: '#f59e0b' },
                    { label: 'In màu', value: wmiStatus.supports_color ? 'Có 🎨' : 'Đen trắng ⚫', icon: '🌈', color: '#ec4899' },
                  ].map((metric, i) => (
                    <div key={i}
                      className="rounded-lg p-2 transition-all duration-200 hover:scale-[1.02]"
                      style={{ backgroundColor: `${metric.color}08`, border: `1px solid ${metric.color}15` }}>
                      <div className="flex items-center gap-1 mb-1">
                        <span className="text-[10px]">{metric.icon}</span>
                        <span className="text-[8px] uppercase tracking-wider" style={{ color: 'var(--fg-dim)' }}>{metric.label}</span>
                      </div>
                      <div className="text-xs font-bold font-mono" style={{ color: metric.color }}>
                        {metric.value !== undefined && metric.value !== null && metric.value !== ''
                          ? `${metric.value}${metric.unit ? ` ${metric.unit}` : ''}`
                          : (<span style={{ color: 'var(--fg-dim)' }}>...</span>)
                        }
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Capabilities badges */}
            {wmiStatus?.capabilities && wmiStatus.capabilities.length > 0 && (
              <div className="mt-3 pt-3 border-t border-dashed flex flex-wrap gap-1.5"
                style={{ borderColor: 'var(--border)' }}>
                {wmiStatus.capabilities.map((cap, i) => {
                  const capColors: Record<string, string> = {
                    'Copies': '#22c55e', 'Color': '#ec4899', 'Duplex': '#3b82f6', 'Collate': '#8b5cf6',
                  }
                  const color = capColors[cap] || '#f59e0b'
                  return (
                    <span key={i}
                      className="text-[8px] font-semibold px-2 py-0.5 rounded-full transition-all duration-200 hover:scale-105"
                      style={{ backgroundColor: `${color}15`, color, border: `1px solid ${color}25` }}>
                      {cap}
                    </span>
                  )
                })}
              </div>
            )}

            {/* Paper sizes */}
            {wmiStatus?.paper_sizes && wmiStatus.paper_sizes.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1">
                {wmiStatus.paper_sizes.slice(0, 5).map((size, i) => (
                  <span key={i}
                    className="text-[7px] px-1.5 py-0.5 rounded"
                    style={{ backgroundColor: 'var(--input-bg)', color: 'var(--fg-muted)' }}>
                    {size}
                  </span>
                ))}
                {wmiStatus.paper_sizes.length > 5 && (
                  <span className="text-[7px] italic" style={{ color: 'var(--fg-dim)' }}>
                    +{wmiStatus.paper_sizes.length - 5}
                  </span>
                )}
              </div>
            )}

            {/* Stats footer */}
            <div className="mt-3 pt-3 border-t border-dashed flex items-center justify-between"
              style={{ borderColor: 'var(--border)' }}>
              <span className="text-[10px] uppercase tracking-wider" style={{ color: 'var(--fg-dim)' }}>
                Tổng số lần in
              </span>
              <button onClick={() => setStatsOpen(true)}
                className="flex items-center gap-1.5 px-3 py-1 rounded-lg text-xs font-bold transition-all duration-200 hover:scale-105 active:scale-95 border-0 cursor-pointer"
                style={{ backgroundColor: '#22c55e15', color: '#22c55e', border: '1px solid #22c55e25' }}>
                <span className="text-base">{totalPrints}</span>
                <span className="text-[10px] font-normal opacity-70">lần</span>
                <span className="text-xs ml-0.5">📊</span>
              </button>
            </div>
          </div>
        </div>

        {/* ── Card 2: Quick Actions ── */}
        <div className="rounded-xl border backdrop-blur-sm p-4 transition-all duration-300 hover:shadow-lg flex flex-col"
          style={{ backgroundColor: 'var(--bg-card)', borderColor: 'var(--border)' }}>
          <h3 className="text-xs font-bold uppercase tracking-[0.15em] mb-3" style={{ color: 'var(--fg-muted)' }}>
            <span className="mr-1.5">⚡</span>Thao tác nhanh
          </h3>

          <div className="grid grid-cols-2 gap-2 mb-3">
            {[
              { label: 'In thử', icon: '🖨', color: '#22c55e', action: () => {
                if (!printerSettings.selected_printer) { setStatusText('Chưa chọn máy in'); return }
                testPrint(printerSettings.selected_printer)
              }},
              { label: 'Đã in', icon: '✅', color: '#3b82f6', action: recordManualPrint },
              { label: 'Lịch sử', icon: '📋', color: '#8b5cf6', action: () => setHistoryOpen(true) },
              { label: 'Cài đặt', icon: '⚙️', color: '#f59e0b', action: () => { setImportResult(null); setSettingsOpen(true) } },
            ].map((btn, i) => (
              <button key={i} onClick={btn.action}
                className="flex flex-col items-center justify-center gap-1 px-2 py-3 rounded-xl text-xs font-semibold transition-all duration-200 hover:scale-[1.03] active:scale-95 border-0 cursor-pointer"
                style={{ backgroundColor: `${btn.color}10`, color: btn.color, border: `1px solid ${btn.color}18` }}>
                <span className="text-lg">{btn.icon}</span>
                <span>{btn.label}</span>
              </button>
            ))}
          </div>

          {/* Alert area */}
          {!isLaser && reminderInfo?.should_remind && printerSettings.reminder_enabled && (
            <div className="mt-auto p-2.5 rounded-xl border text-xs flex items-center gap-2.5 animate-pulse"
              style={{ backgroundColor: '#ef444410', borderColor: '#ef444430', color: '#f87171' }}>
              <span className="text-base">🔴</span>
              <div>
                <div className="font-semibold">Đã đến lúc in!</div>
                <div className="text-[10px] mt-0.5 opacity-80">Lần cuối: {printerSettings.last_print_date || 'chưa từng'}</div>
              </div>
            </div>
          )}
          {isLaser && (
            <div className="mt-auto p-2.5 rounded-xl border text-xs flex items-center gap-2.5"
              style={{ backgroundColor: '#eab30810', borderColor: '#eab30830', color: '#eab308' }}>
              <span className="text-base">🔲</span>
              <div>
                <div className="font-semibold">Máy in laser</div>
                <div className="text-[10px] mt-0.5 opacity-80">Không cần nhắc chống khô mực</div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ═══════ PRINTER LIST ═══════ */}
      <div className="flex-1 overflow-y-auto px-4 pb-4 space-y-2">
        {(() => {
          const excluded = printerSettings.excluded_printers || []
          const visiblePrinters = printers.filter(p => !excluded.includes(p.name))
          if (visiblePrinters.length === 0) {
            return (
              <div className="flex flex-col items-center justify-center h-40 gap-3">
                <span className="text-3xl opacity-30">🖨</span>
                <p className="text-xs italic" style={{ color: 'var(--fg-dim)' }}>Không tìm thấy máy in nào.</p>
                {excluded.length > 0 && printers.length > 0 && (
                  <button onClick={() => { setImportResult(null); setSettingsOpen(true); }}
                    className="text-[10px] px-3 py-1.5 rounded-lg transition-all border-0 cursor-pointer"
                    style={{ backgroundColor: '#3b82f615', color: '#60a5fa' }}>
                    ⚙️ Tất cả {printers.length} máy in đang bị ẩn
                  </button>
                )}
              </div>
            )
          }
          return (
            <>
              {printers.length > visiblePrinters.length && (
                <div className="text-[10px] px-1 py-1 flex items-center gap-1.5" style={{ color: 'var(--fg-dim)' }}>
                  <span>🙈 Đã ẩn {printers.length - visiblePrinters.length} máy in ảo</span>                  <button onClick={() => { setImportResult(null); setSettingsOpen(true); }}
                            className="underline hover:no-underline cursor-pointer bg-transparent border-0"
                            style={{ color: '#60a5fa' }}>Cài đặt</button>
                </div>
              )}
              {visiblePrinters.map(pr => {
            const stats = statsPrinters[pr.name]
            const isSelected = selectedPrinter === pr.name
            const isTracking = printerSettings.selected_printer === pr.name

            return (
              <div key={pr.name}
                className="rounded-xl border backdrop-blur-sm transition-all duration-200 overflow-hidden"
                style={{
                  backgroundColor: 'var(--bg-card)',
                  borderColor: isTracking ? '#22c55e40' : 'var(--border)',
                  boxShadow: isTracking ? '0 0 20px rgba(34,197,94,0.05)' : undefined,
                }}>
                {/* Header bar */}
                <div
                  className="flex items-center justify-between p-3 cursor-pointer transition-colors duration-150 hover:brightness-110"
                  onClick={() => {
                    const newSel = isSelected ? null : pr.name
                    setSelectedPrinter(newSel)
                    if (newSel) {
                      setPjlData(null)
                      fetchJobs(pr.name)
                      setPrinterSettings(prev => ({ ...prev, selected_printer: pr.name }))
                      fetchWithRetry(`${API}/api/printer/settings`, {
                        method: 'POST', headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ selected_printer: pr.name })
                      }).catch(() => {})
                      fetchWithRetry(`${API}/api/printer/wmi-status?printer=${encodeURIComponent(pr.name)}`)
                        .then(r => r.json()).then(d => setWmiStatus(d)).catch(() => {})
                      // Auto-fetch page count
                      fetchWithRetry(`${API}/api/printer/page-count?printer=${encodeURIComponent(pr.name)}&port=${encodeURIComponent(pr.port || '')}`)
                        .then(r => r.json()).then(pc => {
                          if (pc?.page_count !== null) {
                            setPrinterSettings(prev => ({
                              ...prev,
                              page_count: { ...(prev.page_count || {}), [pr.name]: pc.page_count }
                            }))
                          }
                        }).catch(() => {})
                    }
                  }}>
                  <div className="flex items-center gap-3 min-w-0 flex-1">
                    {/* Printer icon */}
                    <div className="relative shrink-0 w-9 h-9 flex items-center justify-center rounded-lg"
                      style={{ backgroundColor: getStatusBg(pr.status) }}>
                      <span className="text-base">{pr.is_laser ? '🔲' : '🖨'}</span>
                      <span className="absolute -top-0.5 -right-0.5 w-2.5 h-2.5 rounded-full border-2"
                        style={{
                          backgroundColor: getStatusColor(pr.status),
                          borderColor: 'var(--bg-card)',
                        }} />
                    </div>

                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-semibold truncate" style={{ color: 'var(--fg)' }}>{pr.name}</span>
                        {pr.is_default && (
                          <span className="text-[8px] font-bold px-1.5 py-0.5 rounded"
                            style={{ backgroundColor: '#3b82f615', color: '#60a5fa', border: '1px solid #3b82f625' }}>
                            MẶC ĐỊNH
                          </span>
                        )}
                        {pr.is_laser && (
                          <span className="text-[8px] font-bold px-1.5 py-0.5 rounded"
                            style={{ backgroundColor: '#eab30815', color: '#fbbf24', border: '1px solid #eab30825' }}>
                            LASER
                          </span>
                        )}
                        {pr.driver_type === 'gdi' && (
                          <span title="GDI (host-based): EventLog không hoạt động, dùng manual count"
                            className="text-[8px] font-bold px-1.5 py-0.5 rounded"
                            style={{ backgroundColor: '#ef444415', color: '#f87171', border: '1px solid #ef444425' }}>
                            GDI
                          </span>
                        )}
                        {isTracking && (
                          <span className="text-[8px] font-bold px-1.5 py-0.5 rounded"
                            style={{ backgroundColor: '#22c55e15', color: '#4ade80', border: '1px solid #22c55e25' }}>
                            THEO DÕI
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                        <span className="flex items-center gap-1 text-xs font-mono">
                          <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: getStatusColor(pr.status) }} />
                          <span style={{ color: 'var(--fg-muted)' }}>{pr.status || 'Không rõ'}</span>
                        </span>
                        <span className="text-[10px]" style={{ color: 'var(--fg-dim)' }}>
                          <span className="opacity-60">Việc:</span> {pr.jobs}
                        </span>
                        {pr.driver && (
                          <span className="text-[10px] hidden sm:inline" style={{ color: 'var(--fg-dim)' }}>
                            <span className="opacity-60">Driver:</span> {pr.driver}
                          </span>
                        )}
                        {stats && stats.total > 0 && (
                          <span className="text-[10px] font-medium" style={{ color: '#4ade80' }}>
                            Đã in: {stats.total}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-1.5 shrink-0 ml-2">
                    {!isTracking && !pr.is_laser && (
                      <button onClick={e => { e.stopPropagation(); testPrint(pr.name) }}
                        className="px-2.5 py-1.5 text-[10px] font-semibold rounded-lg transition-all duration-200 hover:scale-105 active:scale-95 border-0 cursor-pointer"
                        style={{ backgroundColor: '#22c55e12', color: '#4ade80', border: '1px solid #22c55e20' }}>
                        In thử
                      </button>
                    )}
                    <span className={`text-sm transition-transform duration-200 ${isSelected ? 'rotate-180' : ''}`}
                      style={{ color: 'var(--fg-dim)' }}>
                      ▼
                    </span>
                  </div>
                </div>

                {/* Expanded detail */}
                {isSelected && (
                  <div className="border-t px-4 py-3 space-y-3 animate-[fadeIn_0.2s_ease]"
                    style={{ borderColor: 'var(--border)' }}>
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
                      {pr.driver && (
                        <div className="p-2 rounded-lg" style={{ backgroundColor: 'var(--input-bg)' }}>
                          <div className="text-[8px] uppercase tracking-wider mb-0.5" style={{ color: 'var(--fg-dim)' }}>Driver</div>
                          <div className="font-mono truncate" style={{ color: 'var(--fg-secondary)' }}>{pr.driver}</div>
                        </div>
                      )}
                      {pr.port && (
                        <div className="p-2 rounded-lg" style={{ backgroundColor: 'var(--input-bg)' }}>
                          <div className="text-[8px] uppercase tracking-wider mb-0.5" style={{ color: 'var(--fg-dim)' }}>Cổng</div>
                          <div className="font-mono" style={{ color: 'var(--fg-secondary)' }}>{pr.port}</div>
                        </div>
                      )}
                      {pr.location && (
                        <div className="p-2 rounded-lg" style={{ backgroundColor: 'var(--input-bg)' }}>
                          <div className="text-[8px] uppercase tracking-wider mb-0.5" style={{ color: 'var(--fg-dim)' }}>Vị trí</div>
                          <div className="truncate" style={{ color: 'var(--fg-secondary)' }}>{pr.location}</div>
                        </div>
                      )}
                      {pr.comment && (
                        <div className="p-2 rounded-lg col-span-2" style={{ backgroundColor: 'var(--input-bg)' }}>
                          <div className="text-[8px] uppercase tracking-wider mb-0.5" style={{ color: 'var(--fg-dim)' }}>Ghi chú</div>
                          <div className="truncate" style={{ color: 'var(--fg-secondary)' }}>{pr.comment}</div>
                        </div>
                      )}
                      {/* WMI details inline */}
                      {wmiStatus?.printer === pr.name && (
                        <>
                          {wmiStatus.page_resolution && (
                            <div className="p-2 rounded-lg" style={{ backgroundColor: 'var(--input-bg)' }}>
                              <div className="text-[8px] uppercase tracking-wider mb-0.5" style={{ color: 'var(--fg-dim)' }}>Độ phân giải</div>
                              <div className="font-mono font-semibold" style={{ color: '#8b5cf6' }}>{wmiStatus.page_resolution}</div>
                            </div>
                          )}
                          {wmiStatus.supports_color !== undefined && (
                            <div className="p-2 rounded-lg" style={{ backgroundColor: 'var(--input-bg)' }}>
                              <div className="text-[8px] uppercase tracking-wider mb-0.5" style={{ color: 'var(--fg-dim)' }}>In màu</div>
                              <div className="font-semibold" style={{ color: wmiStatus.supports_color ? '#ec4899' : 'var(--fg-secondary)' }}>
                                {wmiStatus.supports_color ? 'Có 🎨' : 'Đen trắng'}
                              </div>
                            </div>
                          )}
                        </>
                      )}
                      {/* Driver type info */}
                      {pr.driver_type && pr.driver_type !== 'standard' && (
                        <div className="p-2 rounded-lg" style={{ backgroundColor: 'var(--input-bg)' }}>
                          <div className="text-[8px] uppercase tracking-wider mb-0.5" style={{ color: 'var(--fg-dim)' }}>Loại driver</div>
                          <div className="font-semibold flex items-center gap-1.5" style={{ color: pr.driver_type === 'gdi' ? '#f87171' : '#fbbf24' }}>
                            {pr.driver_type === 'gdi' ? (
                              <><span>🔴</span> GDI (Host-based)</>
                            ) : (
                              <><span>🟡</span> {pr.driver_type.toUpperCase()}</>
                            )}
                          </div>
                          {pr.driver_type === 'gdi' && (
                            <div className="text-[8px] mt-1" style={{ color: 'var(--fg-dim)' }}>
                              EventLog không hoạt động. Sử dụng manual count + auto-increment.
                            </div>
                          )}
                        </div>
                      )}
                    </div>

                    {/* Actions */}
                    <div className="flex gap-1.5 flex-wrap">
                      {!pr.is_default && (
                        <button onClick={() => setDefaultPrinter(pr.name)}
                          className="px-2.5 py-1.5 text-[10px] font-semibold rounded-lg transition-all duration-200 hover:scale-105 active:scale-95 border-0 cursor-pointer"
                          style={{ backgroundColor: '#3b82f612', color: '#60a5fa', border: '1px solid #3b82f620' }}>
                          📌 Đặt mặc định
                        </button>
                      )}
                      <button onClick={() => queryPjlStatus(pr.name)}
                        className="px-2.5 py-1.5 text-[10px] font-semibold rounded-lg transition-all duration-200 hover:scale-105 active:scale-95 border-0 cursor-pointer"
                        style={{ backgroundColor: '#8b5cf612', color: '#a78bfa', border: '1px solid #8b5cf620' }}>
                        🔍 Tra cứu PJL
                      </button>
                    </div>

                    {/* PJL Controls — IP input + Tra cứu button */}
                    <div className="rounded-lg p-3 text-xs"
                      style={{ backgroundColor: 'var(--input-bg)', border: '1px solid var(--border)' }}>
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-[8px] uppercase tracking-wider font-semibold" style={{ color: 'var(--fg-dim)' }}>
                          🔍 PJL Diagnostics
                        </span>
                        <span className="text-[8px] px-1.5 py-0.5 rounded-full font-medium"
                          style={{ backgroundColor: '#8b5cf615', color: '#a78bfa', border: '1px solid #8b5cf625' }}>
                          Network Only
                        </span>
                      </div>
                      <p className="text-[10px] mb-2" style={{ color: 'var(--fg-muted)' }}>
                        PJL chỉ hoạt động với máy in có kết nối mạng (cổng 9100).
                        Máy in USB chỉ gửi lệnh, không đọc được kết quả.
                      </p>
                      {/* IP Input */}
                      {!showPjlIpInput ? (
                        <div className="flex gap-1.5">
                          <button onClick={() => queryPjlStatus(pr.name)}
                            className="flex-1 px-2.5 py-1.5 text-[10px] font-semibold rounded-lg transition-all duration-200 hover:scale-[1.02] active:scale-95 border-0 cursor-pointer"
                            style={{ backgroundColor: '#8b5cf612', color: '#a78bfa', border: '1px solid #8b5cf620' }}>
                            📤 Gửi lệnh (USB)
                          </button>
                          <button onClick={() => setShowPjlIpInput(true)}
                            className="flex-1 px-2.5 py-1.5 text-[10px] font-semibold rounded-lg transition-all duration-200 hover:scale-[1.02] active:scale-95 border-0 cursor-pointer"
                            style={{ backgroundColor: '#22c55e12', color: '#4ade80', border: '1px solid #22c55e20' }}>
                            🌐 Tra cứu (Network)
                          </button>
                        </div>
                      ) : (
                        <div className="space-y-1.5">
                          <div className="flex items-center gap-1.5">
                            <span className="text-[10px] shrink-0" style={{ color: 'var(--fg-muted)' }}>IP:</span>
                            <input id="pjl-ip-input" name="pjlIp" type="text" value={pjlIpInput}
                              onChange={e => setPjlIpInput(e.target.value)}
                              placeholder="VD: 192.168.1.100"
                              className="flex-1 px-2 py-1 text-xs font-mono rounded border focus:outline-none focus:ring-1 focus:ring-emerald-500/30"
                              style={{ backgroundColor: 'var(--bg)', borderColor: 'var(--border)', color: 'var(--fg)' }} />
                            <button onClick={() => { setShowPjlIpInput(false); setPjlIpInput('') }}
                              className="px-2 py-1 text-[10px] rounded border-0 cursor-pointer hover:bg-black/10 dark:hover:bg-white/10 transition-colors"
                              style={{ color: 'var(--fg-muted)' }}>✕</button>
                          </div>
                          <button onClick={() => { queryPjlStatus(pr.name, pjlIpInput || undefined); setShowPjlIpInput(false) }}
                            disabled={!pjlIpInput.trim() || pjlLoading}
                            className="w-full px-2.5 py-1.5 text-[10px] font-semibold rounded-lg transition-all duration-200 hover:scale-[1.02] active:scale-95 disabled:opacity-40 border-0 cursor-pointer"
                            style={{ backgroundColor: '#22c55e12', color: '#4ade80', border: '1px solid #22c55e20' }}>
                            {pjlLoading ? '⏳ Đang truy vấn...' : '🔍 Tra cứu với IP'}
                          </button>
                        </div>
                      )}
                    </div>

                    {/* PJL Results */}
                    {pjlData && (
                      <div className="rounded-lg p-3 text-xs"
                        style={{ backgroundColor: 'var(--input-bg)', border: '1px solid var(--border)' }}>
                        <div className="flex items-center justify-between mb-2">
                          <span className="text-[8px] uppercase tracking-wider font-semibold" style={{ color: 'var(--fg-dim)' }}>
                            🔍 PJL Diagnostics
                          </span>
                          <button onClick={() => setPjlData(null)}
                            className="text-[10px] px-1 rounded hover:bg-black/10 dark:hover:bg-white/10 border-0 cursor-pointer"
                            style={{ color: 'var(--fg-muted)' }}>✕</button>
                        </div>
                        {pjlLoading ? (
                          <div className="flex items-center gap-2 py-2">
                            <div className="animate-spin rounded-full h-3 w-3 border-b border-emerald-500" />
                            <span style={{ color: 'var(--fg-dim)' }}>Đang truy vấn PJL...</span>
                          </div>
                        ) : pjlData.error ? (
                          <div className="p-2 rounded text-[10px]"
                            style={{ backgroundColor: '#ef444410', color: '#f87171' }}>
                            ❌ {pjlData.error}
                          </div>
                        ) : (
                          <div className="space-y-1">
                            {pjlData.page_count !== undefined && (
                              <div className="flex items-center justify-between py-1 px-2 rounded"
                                style={{ backgroundColor: 'var(--bg-card)' }}>
                                <span style={{ color: 'var(--fg-muted)' }}>Số trang</span>
                                <span className="font-bold font-mono" style={{ color: '#22c55e' }}>{pjlData.page_count}</span>
                              </div>
                            )}
                            {pjlData.toner_level !== undefined && (
                              <div className="flex items-center justify-between py-1 px-2 rounded"
                                style={{ backgroundColor: 'var(--bg-card)' }}>
                                <span style={{ color: 'var(--fg-muted)' }}>Mực in</span>
                                <span className="font-bold font-mono" style={{ color: pjlData.toner_level < 20 ? '#ef4444' : '#fbbf24' }}>{pjlData.toner_level}%</span>
                              </div>
                            )}
                            {pjlData.drum_life !== undefined && (
                              <div className="flex items-center justify-between py-1 px-2 rounded"
                                style={{ backgroundColor: 'var(--bg-card)' }}>
                                <span style={{ color: 'var(--fg-muted)' }}>Drum</span>
                                <span className="font-bold font-mono" style={{ color: pjlData.drum_life < 20 ? '#ef4444' : '#fbbf24' }}>{pjlData.drum_life}%</span>
                              </div>
                            )}
                            {pjlData.source && (
                              <div className="flex items-center justify-between py-1 px-2 rounded"
                                style={{ backgroundColor: 'var(--bg-card)' }}>
                                <span style={{ color: 'var(--fg-muted)' }}>Nguồn</span>
                                <span className="font-mono text-[10px]" style={{ color: 'var(--fg-secondary)' }}>{pjlData.source}</span>
                              </div>
                            )}
                            {pjlData.note && (
                              <div className="mt-1 p-2 rounded text-[10px]"
                                style={{ backgroundColor: '#8b5cf610', color: '#a78bfa' }}>
                                {pjlData.note}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    )}

                    {/* Print Queue */}
                    <div>
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--fg-secondary)' }}>
                          📄 Hàng đợi in
                        </span>
                        {printerJobs.length > 0 && (
                          <button onClick={() => clearJobs(pr.name)}
                            className="text-[10px] font-medium px-2 py-0.5 rounded transition-colors border-0 cursor-pointer"
                            style={{ color: '#f87171', backgroundColor: '#ef444410' }}>
                            Xóa tất cả
                          </button>
                        )}
                      </div>
                      {jobsLoading ? (
                        <div className="flex items-center gap-2 py-3">
                          <div className="animate-spin rounded-full h-3 w-3 border-b border-emerald-500" />
                          <span className="text-xs" style={{ color: 'var(--fg-dim)' }}>Đang tải...</span>
                        </div>
                      ) : printerJobs.length === 0 ? (
                        <div className="py-3 text-center">
                          <p className="text-xs italic" style={{ color: 'var(--fg-dim)' }}>Hàng đợi trống</p>
                        </div>
                      ) : (
                        <div className="space-y-1 text-xs font-mono max-h-36 overflow-y-auto">
                          {printerJobs.map((job, i) => (
                            <div key={i} className="flex items-center justify-between px-2.5 py-1.5 rounded-lg transition-colors hover:brightness-110"
                              style={{ backgroundColor: 'var(--input-bg)' }}>
                              <span className="truncate" style={{ color: 'var(--fg-secondary)' }}>{job}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )
          })}
            </>
          )
        })()}
      </div>

      {/* ═══════ STATISTICS MODAL ═══════ */}
      {statsOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-2 sm:p-4 animate-[fadeIn_0.2s_ease-out]"
          onClick={e => { if (e.target === e.currentTarget) setStatsOpen(false) }}>
          <div className="w-full max-w-md rounded-2xl border shadow-2xl animate-[modalIn_0.25s_ease-out] flex flex-col max-h-[85vh] sm:max-h-[75vh]"
            style={{ backgroundColor: 'var(--bg)', borderColor: 'var(--border)', color: 'var(--fg)' }}>
            <div className="flex items-center justify-between px-4 sm:px-6 pt-4 sm:pt-6 pb-3 sm:pb-4 border-b" style={{ borderColor: 'var(--border)' }}>
              <h3 className="text-sm sm:text-base font-bold flex items-center gap-2">
                <span>📊</span> Thống kê in ấn
              </h3>
              <button onClick={() => setStatsOpen(false)}
                className="p-1.5 sm:p-2 rounded-xl hover:bg-black/10 dark:hover:bg-white/10 transition-all duration-200 hover:scale-110 active:scale-90 border-0 cursor-pointer text-sm"
                style={{ color: 'var(--fg-muted)' }}>✕</button>
            </div>
            <div className="px-4 sm:px-6 py-3 sm:py-4 flex-1 overflow-y-auto space-y-3">
              {/* Total prints hero */}
              <div className="text-center py-2 sm:py-4">
                <div className="text-3xl sm:text-4xl font-black font-mono" style={{ color: '#22c55e' }}>{totalPrints}</div>
                <div className="text-[10px] sm:text-xs mt-1 uppercase tracking-wider" style={{ color: 'var(--fg-muted)' }}>Tổng số lần in</div>
              </div>

              {Object.keys(statsPrinters).length === 0 ? (
                <div className="flex flex-col items-center gap-2 py-6 sm:py-8">
                  <span className="text-2xl opacity-20">🖨</span>
                  <p className="text-xs italic" style={{ color: 'var(--fg-dim)' }}>Chưa có thống kê</p>
                </div>
              ) : (
                Object.entries(statsPrinters)
                  .sort(([,a], [,b]) => b.total - a.total)
                  .map(([name, data], idx) => {
                    const maxTotal = Math.max(1, ...Object.values(statsPrinters).map(s => s.total))
                    const barWidth = Math.min(100, (data.total / maxTotal) * 100)
                    return (
                    <div key={name} className="p-3 rounded-xl transition-all duration-300 hover:brightness-110"
                      style={{
                        backgroundColor: 'var(--input-bg)',
                        animation: `fadeIn 0.3s ease-out ${idx * 0.05}s both`,
                      }}>
                      <div className="flex items-center justify-between mb-1.5">
                        <span className="font-semibold text-xs flex items-center gap-1.5 truncate min-w-0" style={{ color: 'var(--fg)' }}>
                          {data.is_laser ? '🔲' : '🖨'} {name}
                        </span>
                        <span className="font-bold text-emerald-400 text-xs shrink-0 ml-2">{data.total}</span>
                      </div>
                      {/* Progress bar */}
                      <div className="w-full h-1.5 sm:h-2 rounded-full overflow-hidden" style={{ backgroundColor: 'var(--bg)' }}>
                        <div className="h-full rounded-full transition-all duration-1000 ease-out"
                          style={{
                            width: `${barWidth}%`,
                            background: 'linear-gradient(90deg, #22c55e, #4ade80)',
                          }} />
                      </div>
                                      <div className="flex items-center gap-3 text-[10px] mt-1.5">
                        <span style={{ color: 'var(--fg-dim)' }}>
                          <span className="opacity-60">Lần cuối:</span> {data.last_print || 'Chưa từng'}
                        </span>
                      </div>
                      {data.recent_docs && data.recent_docs.length > 0 && (
                        <div className="mt-1 text-[8px] flex gap-1 flex-wrap" style={{ color: 'var(--fg-dim)' }}>
                          {data.recent_docs.slice(0, 3).map((doc, i) => (
                            <span key={i} className="px-1.5 py-0.5 rounded" style={{ backgroundColor: 'var(--bg)' }}>{doc}</span>
                          ))}
                        </div>
                      )}
                    </div>
                    )
                  })
              )}
            </div>
            <div className="px-4 sm:px-6 py-3 sm:py-4 border-t flex justify-end" style={{ borderColor: 'var(--border)' }}>
              <button onClick={() => setStatsOpen(false)}
                className="px-5 sm:px-6 py-2 sm:py-2.5 text-xs sm:text-xs font-bold rounded-xl transition-all duration-200 hover:scale-105 active:scale-95 border-0 cursor-pointer"
                style={{ backgroundColor: '#22c55e', color: 'white' }}>
                Đóng
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ═══════════════════════════════════════════════════════════
          HISTORY MODAL — Thiết kế lại với:
          - Tab theo từng máy in (chỉ hiện máy in visible, không bị ẩn)
          - Search + filter thời gian
          - Thống kê nhanh đầu mỗi tab
          - Nút Export JSON ngay trong popup
          ═══════════════════════════════════════════════════════════ */}
      {historyOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-2 sm:p-4 animate-[fadeIn_0.2s_ease-out]"
          onClick={e => { if (e.target === e.currentTarget) setHistoryOpen(false) }}>
          <div className="w-full max-w-xl rounded-2xl border shadow-2xl animate-[modalIn_0.25s_ease-out] flex flex-col max-h-[90vh] sm:max-h-[80vh]"
            style={{ backgroundColor: 'var(--bg)', borderColor: 'var(--border)', color: 'var(--fg)' }}>
            {/* ── Header ── */}
            <div className="flex items-center justify-between px-4 sm:px-6 pt-4 sm:pt-6 pb-3 sm:pb-4 border-b shrink-0" style={{ borderColor: 'var(--border)' }}>
              <h3 className="text-sm sm:text-base font-bold flex items-center gap-2">
                <span>📋</span> Lịch sử in
              </h3>
              <button onClick={() => setHistoryOpen(false)}
                className="p-1.5 sm:p-2 rounded-xl hover:bg-black/10 dark:hover:bg-white/10 transition-all duration-200 hover:scale-110 active:scale-90 border-0 cursor-pointer text-sm"
                style={{ color: 'var(--fg-muted)' }}>✕</button>
            </div>

            {/* ── Tabs + Search + Stats ── */}
            <div className="px-4 sm:px-6 pt-3 pb-2 shrink-0 space-y-2">
              {/* Filter/search bar */}
              <div className="flex items-center gap-2">
                <div className="relative flex-1">
                  <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-xs" style={{ color: 'var(--fg-dim)' }}>🔍</span>
                  <input id="history-search" name="historySearch" type="text" value={historySearch}
                    onChange={e => setHistorySearch(e.target.value)}
                    placeholder="Tìm kiếm lịch sử..."
                    className="w-full pl-7 pr-3 py-1.5 text-xs rounded-lg border focus:outline-none focus:ring-2 focus:ring-emerald-500/30 transition-all"
                    style={{ backgroundColor: 'var(--input-bg)', borderColor: 'var(--border)', color: 'var(--fg)' }} />
                </div>
                <select id="history-filter-days" name="historyFilterDays" value={historyFilterDays}
                  onChange={e => setHistoryFilterDays(Number(e.target.value))}
                  className="px-2 py-1.5 text-xs rounded-lg border focus:outline-none"
                  style={{ backgroundColor: 'var(--input-bg)', borderColor: 'var(--border)', color: 'var(--fg)' }}>
                  <option value={0}>Tất cả</option>
                  <option value={1}>Hôm nay</option>
                  <option value={7}>7 ngày</option>
                  <option value={30}>30 ngày</option>
                  <option value={90}>90 ngày</option>
                </select>
              </div>

              {/* Tab buttons */}
              <div className="flex gap-1 flex-wrap">
                <button onClick={() => setHistoryTab('all')}
                  className={`px-2.5 py-1 text-[10px] font-semibold rounded-lg transition-all duration-200 border-0 cursor-pointer ${historyTab === 'all' ? 'ring-2 ring-emerald-500/40' : ''}`}
                  style={{
                    backgroundColor: historyTab === 'all' ? '#22c55e20' : 'var(--input-bg)',
                    color: historyTab === 'all' ? '#22c55e' : 'var(--fg-secondary)',
                  }}>
                  📋 Tất cả ({printHistory.length})
                </button>
                {historyPrinters.map(p => (
                  <button key={p} onClick={() => setHistoryTab(p)}
                    className={`px-2.5 py-1 text-[10px] font-semibold rounded-lg transition-all duration-200 border-0 cursor-pointer ${historyTab === p ? 'ring-2 ring-emerald-500/40' : ''}`}
                    style={{
                      backgroundColor: historyTab === p ? '#22c55e20' : 'var(--input-bg)',
                      color: historyTab === p ? '#22c55e' : 'var(--fg-secondary)',
                    }}>
                    {p.includes('EPSON') ? '🖨' : p.includes('Brother') ? '🔲' : '🖨'} {p.split(' ').slice(0, 2).join(' ')}
                  </button>
                ))}
              </div>

              {/* Quick stats */}
              <div className="grid grid-cols-3 gap-2 py-1">
                <div className="text-center p-1.5 rounded-lg" style={{ backgroundColor: 'var(--input-bg)' }}>
                  <div className="text-[16px] font-black font-mono" style={{ color: '#22c55e' }}>{filteredHistory.length}</div>
                  <div className="text-[8px] uppercase tracking-wider" style={{ color: 'var(--fg-dim)' }}>Kết quả</div>
                </div>
                <div className="text-center p-1.5 rounded-lg" style={{ backgroundColor: 'var(--input-bg)' }}>
                  <div className="text-[16px] font-black font-mono" style={{ color: '#3b82f6' }}>{historyPrinterCount}</div>
                  <div className="text-[8px] uppercase tracking-wider" style={{ color: 'var(--fg-dim)' }}>Máy in</div>
                </div>
                <div className="text-center p-1.5 rounded-lg" style={{ backgroundColor: 'var(--input-bg)' }}>
                  <div className="text-[16px] font-black font-mono" style={{ color: '#8b5cf6' }}>{todayCount}</div>
                  <div className="text-[8px] uppercase tracking-wider" style={{ color: 'var(--fg-dim)' }}>Hôm nay</div>
                </div>
              </div>
            </div>

            {/* ── History list ── */}
            <div className="px-4 sm:px-6 py-2 flex-1 overflow-y-auto space-y-1">
              {filteredHistory.length === 0 ? (
                <div className="flex flex-col items-center gap-2 py-8 sm:py-10">
                  <span className="text-2xl opacity-20">📄</span>
                  <p className="text-xs italic" style={{ color: 'var(--fg-dim)' }}>
                    {historySearch ? 'Không tìm thấy kết quả phù hợp' : 'Chưa có lịch sử in'}
                  </p>
                  {historySearch && (
                    <button onClick={() => setHistorySearch('')}
                      className="text-[10px] underline cursor-pointer bg-transparent border-0" style={{ color: '#60a5fa' }}>
                      Xóa bộ lọc
                    </button>
                  )}
                </div>
              ) : (
                filteredHistory.map((entry, idx) => {
                  const today = new Date()
                  const entryDate = new Date(entry.datetime?.split(' ')[0]?.split('/').reverse().join('-') || '')
                  const diffDays = Math.floor((today.getTime() - entryDate.getTime()) / (1000 * 60 * 60 * 24))
                  const isRecent = diffDays <= 1
                  return (
                    <div key={idx}
                      className="flex items-center justify-between p-2 rounded-xl text-xs transition-all duration-200 hover:brightness-110"
                      style={{
                        backgroundColor: 'var(--input-bg)',
                        borderLeft: isRecent ? '2px solid #22c55e' : '2px solid transparent',
                        animation: `fadeIn 0.2s ease-out ${idx * 0.02}s both`,
                      }}>
                      <div className="flex items-center gap-2 min-w-0 flex-1">
                        {/* Date badge */}
                        <div className="flex flex-col items-center shrink-0 w-10 py-1 rounded" style={{ backgroundColor: 'var(--bg)' }}>
                          <span className="text-[7px] font-bold uppercase" style={{ color: 'var(--fg-muted)' }}>
                            {entry.datetime?.split(' ')[0]?.split('/')[1] || ''}
                          </span>
                          <span className="text-xs font-black" style={{ color: 'var(--fg)' }}>
                            {entry.datetime?.split(' ')[0]?.split('/')[0] || ''}
                          </span>
                        </div>
                        {/* Content */}
                        <div className="min-w-0 flex-1">
                          <div className="truncate font-medium text-xs" style={{ color: 'var(--fg)' }}>{entry.action}</div>
                          <div className="flex items-center gap-2 mt-0.5">
                            <span className="text-[8px] font-mono" style={{ color: 'var(--fg-dim)' }}>
                              {entry.datetime?.split(' ')?.[1] || entry.datetime}
                            </span>
                            {entry.printer && (
                              <span className="text-[8px] px-1 py-0.5 rounded truncate max-w-[120px]"
                                style={{ backgroundColor: 'var(--bg)', color: 'var(--fg-muted)' }}>
                                {entry.printer}
                              </span>
                            )}
                            {isRecent && (
                              <span className="text-[7px] font-bold px-1 py-0.5 rounded"
                                style={{ backgroundColor: '#22c55e15', color: '#22c55e' }}>MỚI</span>
                            )}
                          </div>
                        </div>
                      </div>
                      <button onClick={() => deleteHistoryEntry(printHistory.indexOf(entry))}
                        className="text-xs opacity-30 hover:opacity-100 transition-all duration-200 hover:scale-110 active:scale-90 bg-transparent border-0 cursor-pointer p-1"
                        style={{ color: '#ef4444' }}>✕</button>
                    </div>
                  )
                })
              )}
            </div>

            {/* ── Footer ── */}
            <div className="px-4 sm:px-6 py-3 sm:py-4 border-t shrink-0 flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-2 sm:gap-0" style={{ borderColor: 'var(--border)' }}>
              <div className="flex items-center gap-2">
                <button onClick={recordManualPrint}
                  className="px-3 py-2 sm:py-2 text-xs font-bold rounded-xl transition-all duration-200 hover:scale-[1.02] sm:hover:scale-105 active:scale-95 border-0 cursor-pointer flex items-center justify-center gap-1.5"
                  style={{ backgroundColor: '#3b82f6', color: 'white' }}>
                  <span>+</span> Ghi nhận in
                </button>
                {/* Export button — tải xuống file JSON */}
                <button onClick={exportHistory}
                  className="px-3 py-2 sm:py-2 text-xs font-bold rounded-xl transition-all duration-200 hover:scale-[1.02] sm:hover:scale-105 active:scale-95 border-0 cursor-pointer flex items-center justify-center gap-1.5"
                  style={{ backgroundColor: '#8b5cf615', color: '#a78bfa', border: '1px solid #8b5cf625' }}>
                  <span>📤</span> Xuất
                </button>
                {/* Import button — chọn file JSON backup */}
                <input id="printer-import-file" name="importFile" ref={importFileInputRef}
                  type="file" accept=".json"
                  onChange={handleImportFile}
                  className="hidden" />
                <button onClick={() => importFileInputRef.current?.click()}
                  className="px-3 py-2 sm:py-2 text-xs font-bold rounded-xl transition-all duration-200 hover:scale-[1.02] sm:hover:scale-105 active:scale-95 border-0 cursor-pointer flex items-center justify-center gap-1.5"
                  style={{ backgroundColor: '#f59e0b15', color: '#fbbf24', border: '1px solid #f59e0b25' }}>
                  <span>📥</span> Nhập
                </button>
              </div>
              <button onClick={() => setHistoryOpen(false)}
                className="px-4 py-2.5 sm:py-2 text-xs font-medium rounded-xl border transition-colors duration-200 hover:bg-black/5 dark:hover:bg-white/5 cursor-pointer"
                style={{ borderColor: 'var(--border)', color: 'var(--fg-secondary)' }}>
                Đóng
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ═══════ SETTINGS MODAL ═══════ */}
      {settingsOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-2 sm:p-4 animate-[fadeIn_0.2s_ease-out]"
          onClick={e => { if (e.target === e.currentTarget) setSettingsOpen(false) }}>
          <div className="w-full max-w-sm rounded-2xl border shadow-2xl animate-[modalIn_0.25s_ease-out]"
            style={{ backgroundColor: 'var(--bg)', borderColor: 'var(--border)', color: 'var(--fg)' }}>
            <div className="flex items-center justify-between px-4 sm:px-6 pt-4 sm:pt-6 pb-3 sm:pb-4 border-b" style={{ borderColor: 'var(--border)' }}>
              <h3 className="text-sm sm:text-base font-bold flex items-center gap-2">
                <span>⚙️</span> Cài đặt máy in
              </h3>
              <button onClick={() => setSettingsOpen(false)}
                className="p-1.5 sm:p-2 rounded-xl hover:bg-black/10 dark:hover:bg-white/10 transition-all duration-200 hover:scale-110 active:scale-90 border-0 cursor-pointer text-sm"
                style={{ color: 'var(--fg-muted)' }}>✕</button>
            </div>
            <div className="px-4 sm:px-6 py-3 sm:py-4 space-y-3 sm:space-y-4">
              <div className="animate-[fadeIn_0.3s_ease-out_0.05s_both]">
                <label className="text-[10px] sm:text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--fg-muted)' }}>
                  Số ngày giữa các lần in
                </label>
                <input id="printer-days-between" name="daysBetweenPrints" type="number" min={1} max={365} value={printerSettings.days_between_prints}
                  onChange={e => setPrinterSettings(prev => ({ ...prev, days_between_prints: parseInt(e.target.value) || 5 }))}
                  className="w-full px-3 py-2 text-xs rounded-xl border mt-1 focus:outline-none focus:ring-2 focus:ring-emerald-500/30 transition-all"
                  style={{ backgroundColor: 'var(--input-bg)', borderColor: 'var(--border)', color: 'var(--fg)' }} />
              </div>
              <div className="animate-[fadeIn_0.3s_ease-out_0.1s_both]">
                <label className="text-[10px] sm:text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--fg-muted)' }}>
                  Nhắc nhở mỗi (phút)
                </label>
                <input id="printer-remind-minutes" name="remindMinutes" type="number" min={1} max={1440} value={printerSettings.remind_minutes}
                  onChange={e => setPrinterSettings(prev => ({ ...prev, remind_minutes: parseInt(e.target.value) || 15 }))}
                  className="w-full px-3 py-2 text-xs rounded-xl border mt-1 focus:outline-none focus:ring-2 focus:ring-emerald-500/30 transition-all"
                  style={{ backgroundColor: 'var(--input-bg)', borderColor: 'var(--border)', color: 'var(--fg)' }} />
              </div>
              <div className="animate-[fadeIn_0.3s_ease-out_0.15s_both]">
                <label className="text-[10px] sm:text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--fg-muted)' }}>
                  Máy in đã chọn
                </label>
                <select id="printer-select-target" name="selectedPrinter" value={printerSettings.selected_printer}
                  onChange={e => setPrinterSettings(prev => ({ ...prev, selected_printer: e.target.value }))}
                  className="w-full px-3 py-2 text-xs rounded-xl border mt-1 focus:outline-none focus:ring-2 focus:ring-emerald-500/30 transition-all"
                  style={{ backgroundColor: 'var(--input-bg)', borderColor: 'var(--border)', color: 'var(--fg)' }}>
                  <option value="">Tự động phát hiện</option>
                  {printers.map(p => (
                    <option key={p.name} value={p.name}>{p.name} {p.is_laser ? '🔲' : ''}</option>
                  ))}
                </select>
              </div>
              <label className="animate-[fadeIn_0.3s_ease-out_0.2s_both] flex items-center gap-2.5 text-xs cursor-pointer pt-1">
                <input id="printer-reminder-enabled" name="reminderEnabled" type="checkbox" checked={printerSettings.reminder_enabled}
                  onChange={e => setPrinterSettings(prev => ({ ...prev, reminder_enabled: e.target.checked }))}
                  className="accent-emerald-500 w-4 h-4 rounded" />
                <span style={{ color: 'var(--fg-secondary)' }}>Bật nhắc nhở in</span>
              </label>
              {/* ── Excluded Printers ── */}
              <div className="animate-[fadeIn_0.3s_ease-out_0.25s_both]">
                <label className="text-[10px] sm:text-xs font-semibold uppercase tracking-wider flex items-center gap-1.5" style={{ color: 'var(--fg-muted)' }}>
                  <span>🙈</span> Ẩn máy in khỏi tổng số
                </label>
                <p className="text-[8px] mb-2 mt-0.5" style={{ color: 'var(--fg-dim)' }}>
                  Chọn máy in ảo (PDF, Fax, OneNote...) để không tính vào tổng số
                </p>
                <div className="space-y-1 max-h-32 overflow-y-auto">
                  {printers.map(p => {
                    const isExcluded = (printerSettings.excluded_printers || []).includes(p.name)
                    return (
                      <label key={p.name}
                        className="flex items-center gap-2 py-1 px-2 rounded-lg text-xs cursor-pointer transition-colors hover:brightness-110"
                        style={{ backgroundColor: isExcluded ? '#ef444408' : 'transparent' }}>
                        <input name="excludePrinter" type="checkbox" checked={isExcluded}
                          onChange={e => {
                            const excluded = printerSettings.excluded_printers || []
                            if (e.target.checked) {
                              setPrinterSettings(prev => ({ ...prev, excluded_printers: [...excluded, p.name] }))
                            } else {
                              setPrinterSettings(prev => ({ ...prev, excluded_printers: excluded.filter(n => n !== p.name) }))
                            }
                          }}
                          className="accent-red-500 w-3.5 h-3.5 rounded" />
                        <span className={`truncate ${isExcluded ? 'line-through opacity-50' : ''}`}
                          style={{ color: isExcluded ? 'var(--fg-dim)' : 'var(--fg-secondary)' }}>
                          {p.is_laser ? '🔲' : '🖨'} {p.name}
                        </span>
                      </label>
                    )
                  })}
                </div>
              </div>

              {/* ── Page Count ── */}
              <div className="animate-[fadeIn_0.3s_ease-out_0.3s_both]">
                <label className="text-[10px] sm:text-xs font-semibold uppercase tracking-wider flex items-center gap-1.5" style={{ color: 'var(--fg-muted)' }}>
                  <span>📄</span> Tổng trang đã in
                </label>
                <p className="text-[8px] mb-2 mt-0.5" style={{ color: 'var(--fg-dim)' }}>
                  Nhập số trang đã in (không đọc được tự động từ USB printer)
                </p>
                {printerSettings.selected_printer && (
                  <div className="flex items-center gap-2">
                    <input id="printer-page-count" name="pageCount" type="number" min={0}
                      value={(printerSettings.page_count?.[printerSettings.selected_printer] ?? 0).toString()}
                      onChange={e => {
                        const pc = { ...(printerSettings.page_count || {}) }
                        pc[printerSettings.selected_printer] = parseInt(e.target.value) || 0
                        setPrinterSettings(prev => ({ ...prev, page_count: pc }))
                      }}
                      className="w-full px-3 py-2 text-xs rounded-xl border mt-1 focus:outline-none focus:ring-2 focus:ring-emerald-500/30 transition-all"
                      style={{ backgroundColor: 'var(--input-bg)', borderColor: 'var(--border)', color: 'var(--fg)' }}
                      placeholder="Nhập số trang..." />
                  </div>
                )}
                {!printerSettings.selected_printer && (
                  <p className="text-[10px] italic" style={{ color: 'var(--fg-dim)' }}>Chọn máy in trước</p>
                )}
              </div>

              {printers.some(p => p.is_laser) && (
                <p className="animate-[fadeIn_0.3s_ease-out_0.35s_both] text-[10px] italic flex items-center gap-1" style={{ color: 'var(--fg-dim)' }}>
                  <span>🔲</span> Máy in laser tự động bỏ qua nhắc nhở
                </p>
              )}

              {/* ── Backup & Restore ── */}
              <div className="animate-[fadeIn_0.3s_ease-out_0.4s_both] pt-2 border-t border-dashed" style={{ borderColor: 'var(--border)' }}>
                <label className="text-[10px] sm:text-xs font-semibold uppercase tracking-wider flex items-center gap-1.5" style={{ color: 'var(--fg-muted)' }}>
                  <span>💾</span> Sao lưu & Khôi phục
                </label>
                <p className="text-[8px] mb-2 mt-0.5" style={{ color: 'var(--fg-dim)' }}>
                  Sao lưu tất cả dữ liệu (lịch sử, cài đặt, thống kê)
                </p>
                <div className="flex items-center gap-2">
                  <button onClick={triggerBackup}
                    className="flex-1 px-3 py-1.5 text-[10px] font-semibold rounded-lg transition-all duration-200 hover:scale-[1.02] active:scale-95 border-0 cursor-pointer"
                    style={{ backgroundColor: '#22c55e15', color: '#4ade80', border: '1px solid #22c55e25' }}>
                    📤 Sao lưu ngay
                  </button>
                  <button onClick={() => importFileInputRef.current?.click()}
                    className="flex-1 px-3 py-1.5 text-[10px] font-semibold rounded-lg transition-all duration-200 hover:scale-[1.02] active:scale-95 border-0 cursor-pointer"
                    style={{ backgroundColor: '#f59e0b15', color: '#fbbf24', border: '1px solid #f59e0b25' }}>
                    📥 Khôi phục
                  </button>
                </div>
                {importResult && (
                  <div className={`mt-2 text-[10px] px-2 py-1 rounded-lg ${importResult.startsWith('✅') ? 'text-emerald-400' : 'text-red-400'}`}
                    style={{ backgroundColor: importResult.startsWith('✅') ? '#22c55e10' : '#ef444410' }}>
                    {importResult}
                  </div>
                )}
              </div>
            </div>
            <div className="px-4 sm:px-6 py-3 sm:py-4 border-t flex justify-end gap-2" style={{ borderColor: 'var(--border)' }}>
              <button onClick={() => setSettingsOpen(false)}
                className="px-4 py-2 text-xs font-medium rounded-xl border transition-colors duration-200 hover:bg-black/5 dark:hover:bg-white/5 cursor-pointer"
                style={{ borderColor: 'var(--border)', color: 'var(--fg-secondary)' }}>
                Hủy
              </button>
              <button onClick={saveSettings}
                className="px-5 sm:px-6 py-2 text-xs font-bold rounded-xl transition-all duration-200 hover:scale-105 active:scale-95 border-0 cursor-pointer"
                style={{ backgroundColor: '#22c55e', color: 'white' }}>
                Lưu
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Global styles for animations */}
      <style>{`
        @keyframes fadeIn {
          from { opacity: 0; }
          to { opacity: 1; }
        }
        @keyframes modalIn {
          from { opacity: 0; transform: scale(0.95) translateY(8px); }
          to { opacity: 1; transform: scale(1) translateY(0); }
        }
        @keyframes slideUp {
          from { opacity: 0; transform: translateY(8px); }
          to { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </div>
  )
}
