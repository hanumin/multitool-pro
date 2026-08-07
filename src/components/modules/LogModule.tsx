import { useState, useEffect, useCallback, useRef } from 'react'
import { getLineStyle, type LogColors } from '../../utils/logStyles'
import { API, fetchWithRetry } from '../../utils/apiFetch'
import { useToast } from '../../components/ToastManager'
import type { PreloadedData } from '../../types'

interface LogModuleProps {
  theme: 'dark' | 'light'
  setStatusText: (t: string) => void
  inactive?: boolean
  backgroundPolling?: boolean
  logColors?: LogColors
  onBackgroundPollingChange?: (enabled: boolean) => void
  preloadedData?: PreloadedData
}

// WHY: Log viewer component — xem log hệ thống real-time từ backend debug.log.
// Tự động refresh mỗi 2s, hỗ trợ search/filter, clear log, pause auto-refresh.
// Giống Output Panel trong VS Code — dễ dàng copy log gửi cho dev.
export default function LogModule({ theme, setStatusText, inactive, backgroundPolling, logColors, onBackgroundPollingChange, preloadedData }: LogModuleProps) {
  const { addToast } = useToast()

  // WHY: Dùng preloaded debugLog từ LoadingScreen để skip loading flash.
  // preloadedData.debugLog.lines chính là log từ lần fetch cuối cùng trước khi app mount.
  const preloadedLines = preloadedData?.debugLog?.lines
  const preloadedLogStr = preloadedLines?.join('\n') || ''
  const [lines, setLines] = useState<string[]>(preloadedLines || [])
  const [filteredLines, setFilteredLines] = useState<string[]>([])
  const [searchQuery, setSearchQuery] = useState('')
  const [autoRefresh, setAutoRefresh] = useState(true)
  const [lineWrap, setLineWrap] = useState(false)
  const [filterLevel, setFilterLevel] = useState<string>('all')
  const [lineLimit, setLineLimit] = useState<number | null>(null)
  const [fontSize, setFontSize] = useState(11)
  const scrollRef = useRef<HTMLDivElement>(null)
  const [autoScroll, setAutoScroll] = useState(true)
  const [clearing, setClearing] = useState(false)
  const [connectionError, setConnectionError] = useState(false)
  const connectionErrorRef = useRef(false)

  // WHY: Dùng useRef thay vì state để so sánh log thay đổi — tránh reset interval mỗi lần re-render.
  // Khởi tạo với preloaded log content để fetchLog đầu tiên so sánh đúng, tránh re-render trùng lặp.
  // fetchLog ổn định (không phụ thuộc state), interval không bị clear/recreate liên tục.
  const lastLogRef = useRef(preloadedLogStr)
  const fetchLog = useCallback(async () => {
    try {
      const res = await fetchWithRetry(`${API}/api/debug-log`)
      if (res.ok) {
        const data = await res.json()
        const newLog = data.log || ''
        // WHY: Khi fetch thành công, xóa error badge (auto-dismiss)
        if (connectionErrorRef.current) {
          connectionErrorRef.current = false
          setConnectionError(false)
        }
        if (newLog !== lastLogRef.current) {
          lastLogRef.current = newLog
          setLines(newLog.split('\n').filter((l: string) => l.trim()))
        }
      } else {
        // WHY: Backend trả lỗi (5xx, ...) — HIỆN LỖI thay vì trắng im lặng.
        // Trước đây res không ok thì bỏ qua → tab Log trắng không 1 dòng, không
        // thông báo gì → user tưởng app hỏng. Giờ báo rõ để debug nhanh.
        const errData = await res.json().catch(() => null)
        connectionErrorRef.current = true
        setConnectionError(true)
        addToast({ type: 'error', title: '📄 Lỗi tải log', message: (errData as any)?.error || `Backend trả lỗi ${res.status}` })
      }
    } catch (e) {
      // WHY: Chỉ set internal error state — KHÔNG ảnh hưởng global statusText.
      // Backend có thể tạm thời restart (auto-restart wrapper) gây lỗi gián đoạn ngắn.
      connectionErrorRef.current = true
      setConnectionError(true)
    }
  }, []) // WHY: Empty deps — fetchLog ổn định, không recreate interval mỗi lần connectionError thay đổi.
  // connectionError dùng ref để auto-dismiss mà không cần dependency.

  // WHY: Auto-refresh interval — chỉ chạy khi module active + autoRefresh bật.
  // Khi inactive: clear interval (tiết kiệm 1 API call mỗi 2.5s).
  useEffect(() => {
    if ((inactive && !backgroundPolling) || !autoRefresh) return
    fetchLog()
    const interval = setInterval(fetchLog, 2500)
    return () => clearInterval(interval)
  }, [autoRefresh, fetchLog, inactive, backgroundPolling])

  // WHY: Filter lines dựa trên search query và level filter
  useEffect(() => {
    let result = lines

    // WHY: Filter theo level keyword ([alert], [tunnel], [watchdog], [sleep-detector], error, ...)
    if (filterLevel !== 'all') {
      const kw = filterLevel.toLowerCase()
      result = result.filter((l: string) => l.toLowerCase().includes(kw))
    }

    // WHY: Filter theo search query
    if (searchQuery) {
      const q = searchQuery.toLowerCase()
      result = result.filter((l: string) => l.toLowerCase().includes(q))
    }

    // WHY: Apply line limit (null = tất cả)
    if (lineLimit !== null && result.length > lineLimit) {
      result = result.slice(-lineLimit)
    }

    setFilteredLines(result)
  }, [lines, searchQuery, filterLevel, lineLimit])

  // WHY: Auto-scroll khi có log mới (nếu user đang ở cuối)
  useEffect(() => {
    if (autoScroll && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [filteredLines, autoScroll])

  // WHY: Detect khi user scroll lên → tắt auto-scroll
  const handleScroll = () => {
    if (!scrollRef.current) return
    const el = scrollRef.current
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40
    setAutoScroll(atBottom)
  }

  // WHY: Clear log — POST /api/debug-log/clear
  const clearLog = async () => {
    setClearing(true)
    try {
      const res = await fetchWithRetry(`${API}/api/debug-log/clear`, { method: 'POST' })
      if (res.ok) {
        setLines([])
        setFilteredLines([])
        setStatusText('🧹 Đã xóa log')
        addToast({ type: 'success', title: '🧹 Xóa log', message: 'Đã xóa toàn bộ log thành công' })
      } else {
        const errData = await res.json().catch(() => ({ error: 'Lỗi không xác định' }))
        addToast({ type: 'error', title: '🧹 Xóa log thất bại', message: errData.error })
      }
    } catch {
      setStatusText('❌ Không thể xóa log')
      addToast({ type: 'error', title: '🔌 Mất kết nối', message: 'Không thể kết nối tới backend' })
    }
    finally { setClearing(false) }
  }

  // WHY: Copy log ra clipboard — format gọn gàng, kèm toast xác nhận + số dòng
  // để user biết copy thành công (trước đây chỉ setStatusText dễ bị bỏ sót).
  const copyLog = () => {
    const count = filteredLines.length
    const text = filteredLines.join('\n')
    navigator.clipboard.writeText(text).then(() => {
      setStatusText(`📋 Đã copy ${count} dòng log`)
      addToast({ type: 'success', title: '📋 Đã copy log', message: `Đã copy ${count} dòng log vào clipboard` })
    }).catch(() => {
      setStatusText('❌ Copy log thất bại')
      addToast({ type: 'error', title: '📋 Copy log thất bại', message: 'Không thể copy log vào clipboard' })
    })
  }

  // WHY: Export log thành file .txt.
  // Trong Tauri: anchor download (a.click() + blob URL) BỊ CHẶN bởi WebView2 →
  // dùng native save dialog (@tauri-apps/plugin-dialog) lấy đường dẫn, rồi nhờ
  // backend ghi file (có BOM để Notepad đọc UTF-8 đúng). Browser dev: fallback anchor.
  const exportLog = async () => {
    const count = filteredLines.length
    const text = filteredLines.join('\n')
    const defaultName = `debug-log-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.txt`
    let targetPath: string | null = null
    try {
      const { save } = await import('@tauri-apps/plugin-dialog')
      targetPath = await save({
        defaultPath: defaultName,
        title: 'Export log',
        filters: [{ name: 'Text', extensions: ['txt', 'log'] }],
      })
    } catch {
      // WHY: Không chạy trong Tauri (browser dev mode) → giữ anchor download cũ.
      const blob = new Blob([text], { type: 'text/plain;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = defaultName
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
      setStatusText(`📥 Exported ${count} dòng log`)
      return
    }
    if (!targetPath) return // user huỷ save dialog — không toast

    try {
      const res = await fetchWithRetry(`${API}/api/debug-log/export`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: targetPath, content: text }),
      })
      if (res.ok) {
        setStatusText(`📥 Exported ${count} dòng log`)
        addToast({ type: 'success', title: '📥 Export log', message: `Đã lưu ${count} dòng log: ${targetPath}` })
      } else {
        const errData = await res.json().catch(() => ({ error: 'Lỗi không xác định' }))
        setStatusText('❌ Export log thất bại')
        addToast({ type: 'error', title: '📥 Export log thất bại', message: errData.error })
      }
    } catch {
      setStatusText('❌ Export log thất bại')
      addToast({ type: 'error', title: '🔌 Mất kết nối', message: 'Không thể kết nối tới backend để ghi file' })
    }
  }

  // WHY: Dùng getLineStyle chung từ utils/logStyles thay vì local copy

  // WHY: Lấy timestamp từ đầu dòng log [YYYY-MM-DD HH:MM:SS]
  const getTimestamp = (line: string): string => {
    const match = line.match(/^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\]/)
    return match ? match[0] : ''
  }

  // WHY: Lấy nội dung log sau timestamp
  const getContent = (line: string): string => {
    return line.replace(/^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\]\s*/, '')
  }

  // WHY: Quick filter presets
  const levelPresets = [
    { id: 'all', label: 'Tất cả' },
    { id: 'error', label: 'Lỗi' },
    { id: '[tunnel', label: 'Tunnel' },
    { id: '[watchdog', label: 'Watchdog' },
    { id: '[alert', label: 'Alert' },
    { id: '[sleep', label: 'Sleep' },
    { id: '[request', label: 'Metrics' },
  ]

  return (
    <div className="flex flex-col h-full p-4 gap-3" style={{ display: inactive ? 'none' : 'flex' }}>
      {/* Controls bar */}
      <div className="flex items-center justify-between shrink-0 gap-2">
        <div className="flex items-center gap-2">
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
          {/* Stats */}
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg border text-xs"
            style={{
              backgroundColor: 'var(--input-bg)',
              borderColor: connectionError ? 'rgba(239,68,68,0.3)' : 'var(--border)'
            }}>
            <span style={{ color: 'var(--fg-dim)' }}>📋</span>
            <span style={{ color: 'var(--fg-secondary)' }}>
              <span className="font-mono">{filteredLines.length}</span>
              <span className="text-[10px]" style={{ color: 'var(--fg-dim)' }}>
                {lineLimit !== null ? ` / ${lineLimit}` : ''} / {lines.length} dòng
              </span>
            </span>
            {connectionError && (
              <span className="flex items-center gap-1 px-1.5 py-0.5 text-[8px] font-semibold rounded bg-red-500/10 text-red-400 border border-red-500/20 animate-fade-in">
                <span className="w-1 h-1 rounded-full bg-red-400 animate-pulse" />
                Mất kết nối
              </span>
            )}
            {filterLevel !== 'all' || searchQuery ? (
              <button onClick={() => { setFilterLevel('all'); setSearchQuery('') }}
                className="ml-1 px-1.5 py-0.5 text-[8px] font-semibold rounded border-0 cursor-pointer transition-all hover:bg-white/10"
                style={{ color: '#60a5fa', backgroundColor: 'rgba(96,165,250,0.1)' }}>
                Xoá bộ lọc
              </button>
            ) : null}
          </div>

          {/* Search */}
          <div className="relative flex items-center">
            <svg className="absolute left-2 w-3 h-3" style={{ color: 'var(--fg-muted)' }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
            <input type="text" value={searchQuery} onChange={e => setSearchQuery(e.target.value)}
              placeholder="Tìm trong log..."
              className="w-28 pl-6 pr-2 py-1 text-xs rounded-lg border transition-all focus:outline-none focus:w-40"
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

          {/* Level filter pills */}
          <div className="flex items-center gap-1">
            {levelPresets.map(p => (
              <button key={p.id} onClick={() => setFilterLevel(filterLevel === p.id ? 'all' : p.id)}
                className={`px-1.5 py-0.5 text-[8px] font-semibold rounded transition-all cursor-pointer border-0 ${
                  filterLevel === p.id ? 'ring-1' : 'hover:bg-white/5'
                }`}
                style={{
                  color: filterLevel === p.id ? 'var(--fg)' : 'var(--fg-dim)',
                  backgroundColor: filterLevel === p.id ? 'var(--input-bg)' : 'transparent',
                  borderColor: filterLevel === p.id ? 'var(--border)' : 'transparent',
                }}>
                {p.label}
              </button>
            ))}
          </div>
        </div>

        {/* Right controls */}
        <div className="flex items-center gap-1.5">
          {/* Font size */}
          <div className="flex items-center gap-0.5 px-1 py-0.5 rounded" style={{ backgroundColor: 'var(--input-bg)' }}>
            <button onClick={() => setFontSize(s => Math.max(9, s - 1))}
              className="p-0.5 text-[10px] font-bold bg-transparent border-0 cursor-pointer" style={{ color: 'var(--fg-dim)' }}>A−</button>
            <span className="text-[8px] font-mono min-w-[16px] text-center" style={{ color: 'var(--fg-muted)' }}>{fontSize}</span>
            <button onClick={() => setFontSize(s => Math.min(16, s + 1))}
              className="p-0.5 text-[10px] font-bold bg-transparent border-0 cursor-pointer" style={{ color: 'var(--fg-dim)' }}>A+</button>
          </div>

          {/* Line wrap toggle */}
          <button onClick={() => setLineWrap(w => !w)}
            className={`px-1.5 py-0.5 text-[8px] font-semibold rounded border transition-all cursor-pointer ${
              lineWrap ? 'ring-1' : ''
            }`}
            style={{
              color: lineWrap ? 'var(--fg)' : 'var(--fg-dim)',
              backgroundColor: lineWrap ? 'var(--input-bg)' : 'transparent',
              borderColor: lineWrap ? 'var(--border)' : 'var(--border)',
            }}
            title={lineWrap ? 'Xuống dòng: Bật' : 'Xuống dòng: Tắt'}>
            {lineWrap ? '⟳ Wrap' : '↔ No wrap'}
          </button>

          {/* Line limit selector */}
          <div className="flex items-center gap-0.5 px-1 py-0.5 rounded border" style={{ backgroundColor: 'var(--input-bg)', borderColor: 'var(--border)' }}>
            {[
              { id: null, label: 'Tất cả' },
              { id: 500, label: '500' },
              { id: 1000, label: '1000' },
            ].map(opt => (
              <button key={String(opt.id)} onClick={() => setLineLimit(opt.id)}
                className={`px-1.5 py-0.5 text-[8px] font-semibold rounded transition-all cursor-pointer border-0 ${
                  lineLimit === opt.id ? 'ring-1' : 'hover:bg-white/5'
                }`}
                style={{
                  color: lineLimit === opt.id ? 'var(--fg)' : 'var(--fg-dim)',
                  backgroundColor: lineLimit === opt.id ? 'rgba(34,197,94,0.15)' : 'transparent',
                }}>
                {opt.label}
              </button>
            ))}
          </div>

          {/* Auto refresh toggle */}
          <label className="flex items-center gap-1 cursor-pointer" title={autoRefresh ? 'Tự động refresh: Bật' : 'Tự động refresh: Tắt'}>
            <input type="checkbox" checked={autoRefresh} onChange={e => setAutoRefresh(e.target.checked)}
              className="sr-only peer" />
            <div className="w-5 h-3 rounded-full peer peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-[1px] after:left-[1px] after:bg-white after:rounded-full after:h-2.5 after:w-2.5 after:transition-all peer-checked:bg-emerald-500/60 bg-gray-600/40 relative" />
            <span className="text-[8px]" style={{ color: autoRefresh ? '#22c55e' : 'var(--fg-dim)' }}>
              {autoRefresh ? 'Tự động' : 'Thủ công'}
            </span>
          </label>

          {/* Manual refresh */}
          <button onClick={fetchLog}
            className="p-1 rounded border transition-all active:scale-95 cursor-pointer hover:bg-white/5"
            style={{ backgroundColor: 'var(--input-bg)', borderColor: 'var(--border)', color: 'var(--fg-dim)' }}
            title="Làm mới">
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
          </button>

          {/* Copy */}
          <button onClick={copyLog}
            className="p-1 rounded border transition-all active:scale-95 cursor-pointer hover:bg-white/5"
            style={{ backgroundColor: 'var(--input-bg)', borderColor: 'var(--border)', color: 'var(--fg-dim)' }}
            title="Copy log">
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
            </svg>
          </button>

          {/* Export */}
          <button onClick={exportLog}
            className="p-1 rounded border transition-all active:scale-95 cursor-pointer hover:bg-white/5"
            style={{ backgroundColor: 'var(--input-bg)', borderColor: 'var(--border)', color: 'var(--fg-dim)' }}
            title="Export log">
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
          </button>

          {/* Clear */}
          <button onClick={clearLog} disabled={clearing}
            className="px-2 py-1 text-[8px] font-semibold rounded border transition-all active:scale-95 cursor-pointer disabled:opacity-30 hover:bg-red-500/10"
            style={{ backgroundColor: 'var(--input-bg)', borderColor: 'rgba(239,68,68,0.3)', color: '#ef4444' }}>
            {clearing ? '...' : '🗑 Xóa'}
          </button>
        </div>
      </div>

      {/* Log content area */}
      <div className="flex-1 min-h-0 overflow-hidden rounded-xl border backdrop-blur"
        style={{ background: 'var(--bg-card)', borderColor: 'var(--border)' }}>
        {filteredLines.length === 0 ? (
          <div className="flex items-center justify-center h-full">
            <div className="text-center space-y-2">
              <div className="text-2xl" style={{ color: 'var(--fg-dim)' }}>📋</div>
              {lines.length === 0 ? (
                <>
                  <p className="text-[12px] font-medium" style={{ color: 'var(--fg-dim)' }}>Chưa có log nào</p>
                  <p className="text-[10px]" style={{ color: 'var(--fg-muted)' }}>
                    Log được ghi khi backend xử lý các tác vụ
                  </p>
                  {!autoRefresh && (
                    <button onClick={() => setAutoRefresh(true)}
                      className="mt-2 px-3 py-1 text-xs font-medium rounded-lg bg-emerald-500/15 text-emerald-400 hover:bg-emerald-500/25 border-0 cursor-pointer transition-all">
                      Bật tự động refresh
                    </button>
                  )}
                </>
              ) : (
                <p className="text-[12px]" style={{ color: 'var(--fg-dim)' }}>
                  Không có dòng nào khớp với bộ lọc "{searchQuery || filterLevel}"
                </p>
              )}
            </div>
          </div>
        ) : (
          <div ref={scrollRef} onScroll={handleScroll}
            className="h-full overflow-auto font-mono p-3"
            style={{ fontSize: `${fontSize}px`, lineHeight: '1.5' }}>
            {/* Auto-scroll indicator */}
            {!autoScroll && filteredLines.length > 0 && (
              <button onClick={() => {
                setAutoScroll(true)
                scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
              }}
                className="sticky top-0 z-10 mb-2 px-3 py-1 text-[8px] font-semibold rounded-full border transition-all cursor-pointer hover:bg-white/10"
                style={{
                  backgroundColor: 'var(--bg-card)',
                  borderColor: 'var(--border)',
                  color: 'var(--fg-dim)',
                  boxShadow: '0 2px 8px rgba(0,0,0,0.2)'
                }}>
                ↓ Auto-scroll
              </button>
            )}
            {filteredLines.map((line, i) => {
              const style = getLineStyle(line, i, logColors)
              return (
                <div key={i} className="flex items-start gap-2 px-2 py-0.5 rounded transition-colors hover:bg-white/[0.04] group animate-log-enter"
                  style={{ animationDelay: `${Math.min(i * 0.015, 0.5)}s`, backgroundColor: style.backgroundColor }}>
                  {/* Line number */}
                  <span className="text-right select-none shrink-0 font-mono"
                    style={{ color: 'var(--fg-muted)', width: `${String(filteredLines.length).length}ch`, fontSize: `${fontSize - 2}px`, lineHeight: '1.5rem' }}>
                    {i + 1}
                  </span>
                  {/* Timestamp */}
                  {getTimestamp(line) && (
                    <span className="shrink-0 select-none font-mono"
                      style={{ color: 'var(--fg-muted)', fontSize: `${fontSize - 1}px`, lineHeight: '1.5rem' }}>
                      {getTimestamp(line)}
                    </span>
                  )}
                  {/* Content */}
                  <span className={`${lineWrap ? 'whitespace-pre-wrap' : 'whitespace-nowrap'} flex-1`}
                    style={{ color: style.color, borderLeft: style.borderLeft, paddingLeft: style.paddingLeft, lineHeight: '1.5rem' }}>
                    {searchQuery ? (
                      highlightText(getContent(line) || line, searchQuery)
                    ) : (
                      getContent(line) || line
                    )}
                  </span>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

// WHY: Highlight search query trong text — case insensitive, dùng substring match.
function highlightText(text: string, query: string): React.ReactNode {
  if (!query) return text
  const lower = text.toLowerCase()
  const q = query.toLowerCase()
  const idx = lower.indexOf(q)
  if (idx === -1) return text
  return (
    <>
      {text.slice(0, idx)}
      <mark style={{ backgroundColor: 'rgba(251,191,36,0.3)', color: '#fbbf24', borderRadius: '2px', padding: '0 1px' }}>
        {text.slice(idx, idx + q.length)}
      </mark>
      {text.slice(idx + q.length)}
    </>
  )
}
